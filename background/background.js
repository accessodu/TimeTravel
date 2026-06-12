'use strict';

const CDX = 'https://web.archive.org/cdx/search/cdx';
const WB  = 'https://web.archive.org/web/';

chrome.runtime.onInstalled.addListener(() => console.log('TimeTravel-A11y ready'));

/* ── Keyboard shortcut ───────────────────────────────────────────────── */
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-overlay') return;
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if (!tab?.id || /^(chrome|edge|about|data|blob):/.test(tab.url||'')) return;
  await injectAndToggle(tab.id);
});

/* ── Messages ────────────────────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  if (req.type === 'LAUNCH_AND_ANALYZE') {
    chrome.tabs.query({active:true, currentWindow:true}, async ([tab]) => {
      if (!tab?.id) return sendResponse({ok:false, error:'No active tab found.'});
      if (/^(chrome|edge|about|data|blob):/.test(tab.url||''))
        return sendResponse({ok:false, error:'Navigate to a regular webpage first (not a browser page).'});
      try {
        await injectAndToggle(tab.id);
        await new Promise(r => setTimeout(r, 350));
        await chrome.tabs.sendMessage(tab.id, {
          type:'AUTO_ANALYZE', url:req.url,
          provider:req.provider, groqKey:req.groqKey, ollamaModel:req.ollamaModel,
        });
        sendResponse({ok:true});
      } catch(e) { sendResponse({ok:false, error:e.message}); }
    });
    return true;
  }

  if (req.type === 'LAUNCH_OVERLAY') {
    chrome.tabs.query({active:true, currentWindow:true}, async ([tab]) => {
      if (!tab?.id) return sendResponse({ok:false, error:'No active tab'});
      if (/^(chrome|edge|about|data|blob):/.test(tab.url||''))
        return sendResponse({ok:false, error:'Cannot run on this page. Go to a normal website first.'});
      try   { await injectAndToggle(tab.id); sendResponse({ok:true}); }
      catch (e) { sendResponse({ok:false, error:e.message}); }
    });
    return true;
  }

  if (req.type === 'ANALYZE_ARCHIVE') {
    const tabId = sender.tab?.id;
    analyze(req, tabId).catch(err => {
      tabId && chrome.tabs.sendMessage(tabId, {type:'ANALYSIS_ERROR', error:err.message});
    });
    sendResponse({ok:true});
    return true;
  }

  if (req.type === 'AI') {
    callAI(req).then(text => sendResponse({ok:true,text}))
               .catch(e  => sendResponse({ok:false,error:e.message}));
    return true;
  }
});

async function injectAndToggle(tabId) {
  await chrome.scripting.executeScript({target:{tabId}, files:['content/overlay.js']});
  await new Promise(r => setTimeout(r, 100));
  await chrome.tabs.sendMessage(tabId, {type:'TOGGLE_OVERLAY'});
}

/* ═══════════════════════════════════════════════════════════════════
   PIPELINE ENTRY — single URL or collection (POINT 5)
═══════════════════════════════════════════════════════════════════ */
async function analyze(params, tabId) {
  const urls = parseUrlList(params.url);
  if (urls.length > 1) return analyzeCollection({...params, urls}, tabId);
  return analyzeSingle({...params, url: urls[0] || params.url}, tabId);
}

function parseUrlList(raw) {
  return String(raw||'')
    .split(/[\n,]+|\s+(?=https?:\/\/)/)
    .map(u => stripWayback(u.trim()))
    .filter(u => /^https?:\/\//i.test(u));
}

/* ═══════════════════════════════════════════════════════════════════
   SINGLE-URL ANALYSIS  (6 steps)
═══════════════════════════════════════════════════════════════════ */
async function analyzeSingle(params, tabId) {
  const {url, fromYear, toYear, focus, provider, apiKey, ollamaModel, maskPii=true} = params;
  const push = (d) => tabId && chrome.tabs.sendMessage(tabId, {type:'ANALYSIS_PROGRESS',...d});

  /* Step 1 — captures */
  push({step:1, status:'running', text:`Querying Wayback Machine for ${url}`});
  const snaps = await getCaptures(url, fromYear, toYear);
  if (!snaps.length) throw new Error(
    `No captures found for "${url}" between ${fromYear}–${toYear}.\nTry a wider year range or verify at web.archive.org`
  );
  push({step:1, status:'done', text:`Found ${snaps.length} captures (${snaps[0].date.getUTCFullYear()}–${snaps[snaps.length-1].date.getUTCFullYear()})`});

  /* Step 2 — dedupe */
  push({step:2, status:'running', text:'Removing duplicate captures…'});
  const unique = dedupe(snaps);
  push({step:2, status:'done', text:`${snaps.length-unique.length} duplicates removed — ${unique.length} remain`});

  /* Step 3 — select */
  push({step:3, status:'running', text:'Selecting snapshots with significant changes…'});
  const selected = pickSnapshots(unique);
  push({step:3, status:'done', text:`Selected ${selected.length} snapshots for content analysis`});

  /* Step 4 — fetch + compute (sections, a11y, replay, masking) */
  push({step:4, status:'running', text:'Fetching content; computing sections, accessibility & replay signals…'});
  const withContent = await fetchContents(selected, url, focus, maskPii);
  const okCount = withContent.filter(s=>s.text).length;
  push({step:4, status:'done', text:`Content + structural analysis for ${okCount}/${selected.length} snapshots`});

  /* Step 5 — AI classify (chain-of-verification: draft → verify) */
  push({step:5, status:'running', text:'Classifying changes with AI (chain-of-verification: drafting, then verifying each claim)…'});
  const ai = await classifyWithAI(withContent, url, focus, provider, apiKey, ollamaModel);
  const coveTxt = ai.coveApplied === false ? ' (draft only — verification pass unavailable)' : '';
  push({step:5, status:'done', text:`AI verified ${ai.changes?.length||0} change(s)${coveTxt}`});

  /* Step 6 — VERIFY + classify archival state + build report */
  push({step:6, status:'running', text:'Verifying quotes & computing archival evidence…'});
  const report = buildReport(snaps, unique, selected, withContent, ai, params);
  const v = report.changes.filter(c=>c.verified).length;
  push({step:6, status:'done', text:`Report ready — ${v}/${report.changes.length} changes verified against captures`});

  tabId && chrome.tabs.sendMessage(tabId, {type:'ANALYSIS_COMPLETE', report});
}

/* ═══════════════════════════════════════════════════════════════════
   COLLECTION ANALYSIS (POINT 5) — multi-URL, first-appearance detection
═══════════════════════════════════════════════════════════════════ */
async function analyzeCollection(params, tabId) {
  const {urls, fromYear, toYear, focus, maskPii=true} = params;
  const push = (d) => tabId && chrome.tabs.sendMessage(tabId, {type:'ANALYSIS_PROGRESS',...d});
  const capped = urls.slice(0, 8);

  push({step:1, status:'running', text:`Collection mode — ${capped.length} URLs`});
  const focusTerms = (focus||'').toLowerCase().split(/[\s,;]+/).filter(t=>t.length>2);

  const sites = [];
  for (let i=0; i<capped.length; i++) {
    const u = capped[i];
    push({step:Math.min(6, i+1), status:'running', text:`(${i+1}/${capped.length}) ${u}`});
    try {
      const snaps = dedupe(await getCaptures(u, fromYear, toYear));
      if (!snaps.length) { sites.push({url:u, found:false, captures:0}); continue; }
      // Sample up to 5 snapshots spread across time for first-appearance detection
      const sample = evenlySample(snaps, 5);
      const contents = await fetchContents(sample, u, focus, maskPii);
      // First appearance of focus terms
      let firstAppear = null, lastAbsent = null;
      for (const c of contents) {
        if (!c.text) continue;
        const hit = focusTerms.length && focusTerms.some(t => c.text.toLowerCase().includes(t));
        if (hit && !firstAppear) firstAppear = fmtDate(c.date);
        if (!hit) lastAbsent = fmtDate(c.date);
      }
      sites.push({
        url:u, found:true, captures:snaps.length,
        first:fmtDate(snaps[0].date), last:fmtDate(snaps[snaps.length-1].date),
        firstAppearance: firstAppear,
        focusPresent: !!firstAppear,
        a11y: contents.find(c=>c.a11y)?.a11y || null,
      });
    } catch(e) { sites.push({url:u, found:false, error:e.message}); }
  }

  // Aggregate first-appearance histogram by year
  const appearByYear = {};
  sites.forEach(s => {
    if (s.firstAppearance) {
      const y = s.firstAppearance.match(/\d{4}/)?.[0];
      if (y) appearByYear[y] = (appearByYear[y]||0)+1;
    }
  });

  push({step:6, status:'done', text:'Collection analysis complete'});

  tabId && chrome.tabs.sendMessage(tabId, {type:'ANALYSIS_COMPLETE', report:{
    mode:'collection', focus, fromYear, toYear,
    siteCount: capped.length,
    detected: sites.filter(s=>s.focusPresent).length,
    appearByYear, sites,
  }});
}

/* ═══════════════════════════════════════════════════════════════════
   CDX
═══════════════════════════════════════════════════════════════════ */
async function getCaptures(rawUrl, fromYear, toYear) {
  const url = stripWayback(rawUrl);
  // NOTE: no server-side `collapse` — it is an expensive operation on Wayback's
  // side and frequently times out on large sites. We dedupe by digest ourselves
  // in Step 2, so the raw (cheaper) query is all we need.
  const base = {url, output:'json', fl:'timestamp,statuscode,digest,length',
                from:`${fromYear}0101000000`, to:`${toYear}1231235959`, limit:'1500'};
  let rows = await cdxFetch({...base, filter:'statuscode:200'});
  if (!rows.length) rows = await cdxFetch({...base});                         // any status
  if (!rows.length) rows = await cdxFetch({url, output:'json', fl:'timestamp,statuscode,digest,length', limit:'500'}); // ignore year range
  return rows;
}

async function cdxFetch(params, attempt=1, maxAttempts=2) {
  const qs = new URLSearchParams(params);
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), 25000);   // CDX can legitimately take 15-20s for big sites
    res = await fetch(`${CDX}?${qs}`, {signal:ctrl.signal});
    clearTimeout(timer);
  } catch {
    if (attempt < maxAttempts) { await sleep(1500); return cdxFetch(params, attempt+1, maxAttempts); }
    throw new Error('Wayback Machine is not responding (timeout). It may be under heavy load — try again in a minute, or narrow the year range.');
  }
  if (!res.ok) {
    if (res.status>=500 && attempt<maxAttempts) { await sleep(1000); return cdxFetch(params, attempt+1, maxAttempts); }
    if (res.status>=500) throw new Error(`Wayback Machine is busy (HTTP ${res.status}). Try again shortly.`);
    return [];
  }
  let json; try { json = await res.json(); } catch { return []; }
  if (!Array.isArray(json) || json.length<2) return [];
  const [hdrs, ...rows] = json;
  return rows.map(r => {
    const o={}; hdrs.forEach((h,i)=>o[h]=r[i]);
    const ts=o.timestamp||'', d=parseTs(ts);
    return d ? {timestamp:ts, digest:o.digest||'', length:parseInt(o.length)||0, date:d, url:`${WB}${ts}/${params.url||''}`} : null;
  }).filter(Boolean);
}

function dedupe(snaps) {
  const seen=new Set();
  return snaps.filter(s=>{ if(seen.has(s.digest)) return false; seen.add(s.digest); return true; });
}

function pickSnapshots(snaps) {
  if (snaps.length<=7) return snaps;
  const first=snaps[0], last=snaps[snaps.length-1], jumps=[];
  for (let i=1;i<snaps.length-1;i++){
    const p=snaps[i-1].length||1, c=snaps[i].length;
    if (Math.abs(c-p)/p>0.25 && Math.abs(c-p)>3000) jumps.push(snaps[i]);
  }
  const mid=snaps.slice(1,-1).filter(s=>!jumps.includes(s));
  return dedupe([first, ...jumps.slice(0,3), ...evenlySample(mid,3), last]);
}

function evenlySample(arr,n){
  if(!arr.length||n<=0) return [];
  if(arr.length<=n) return arr;
  return Array.from({length:n},(_,i)=>arr[Math.round(i*(arr.length-1)/(n-1))]);
}

/* ═══════════════════════════════════════════════════════════════════
   CONTENT FETCH + structural computation
═══════════════════════════════════════════════════════════════════ */
async function fetchContents(snaps, pageUrl, focus, maskPii) {
  const out = [];
  for (const s of snaps) {
    const rawUrl = `${WB}${s.timestamp}id_/${pageUrl}`;
    let html=null, text=null, fullText=null, sections=[], a11y=null, issues=[], privacy=null;
    try {
      const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),10000);
      const res=await fetch(rawUrl,{signal:ctrl.signal}); clearTimeout(t);
      if (res.ok) {
        html = await res.text();
        issues   = replayIssues(html);                 // POINT 2 signals
        a11y     = a11yMetrics(html);                   // POINT 4
        sections = extractSections(html);               // POINT 3
        fullText = plainText(html);                     // for verification (POINT 1)
        text     = focusExtract(fullText, focus);       // for AI prompt
        if (maskPii) {                                   // POINT 6
          const mt = maskPII(text);   text = mt.text;
          const mf = maskPII(fullText); fullText = mf.text;
          if (mt.count || mf.count) privacy = {count: mt.count + mf.count, types:[...new Set([...mt.types, ...mf.types])]};
        }
      }
    } catch(e) { issues=[{kind:'fetch_failed', detail:e.message}]; }
    out.push({...s, text, fullText, sections, a11y, issues, privacy});
    await sleep(350);
  }
  return out;
}

/* ── Plain text (full, for quote verification) ─────────────────────── */
function plainText(html) {
  return html
    .replace(/<!-- BEGIN WAYBACK[\s\S]*?END WAYBACK[^>]*>/gi,'')
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<svg[\s\S]*?<\/svg>/gi,'')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/\s+/g,' ').trim().slice(0,20000);
}

function focusExtract(plain, focus) {
  if (!focus) return plain.slice(0,3000);
  const terms = focus.toLowerCase().split(/[\s,;]+/).filter(t=>t.length>2);
  const sents = plain.split(/(?<=[.!?])\s+/);
  const rel  = sents.filter(s=>terms.some(t=>s.toLowerCase().includes(t)));
  const rest = sents.filter(s=>!terms.some(t=>s.toLowerCase().includes(t)));
  return [...rel.slice(0,25), ...(rel.length?['[general content]']:[]), ...rest.slice(0,5)].join(' ').slice(0,3500);
}

/* ── POINT 3: Section extraction by headings ───────────────────────── */
function extractSections(html) {
  // Strip toolbar/scripts/styles first
  let h = html
    .replace(/<!-- BEGIN WAYBACK[\s\S]*?END WAYBACK[^>]*>/gi,'')
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'');
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const heads = [];
  let m;
  while ((m = re.exec(h)) !== null) {
    heads.push({level:parseInt(m[1]), heading: clean(m[2]), index:m.index});
  }
  const sections = [];
  for (let i=0;i<heads.length;i++){
    const start = heads[i].index;
    const end   = i+1<heads.length ? heads[i+1].index : h.length;
    const body  = clean(h.slice(start, end).replace(/<[^>]+>/g,' ')).slice(0,600);
    if (heads[i].heading) sections.push({level:heads[i].level, heading:heads[i].heading, text:body});
  }
  return sections.slice(0,40);
}

/* ── POINT 4: Accessibility metrics (regex heuristics) ─────────────── */
function a11yMetrics(html) {
  let h = html.replace(/<!-- BEGIN WAYBACK[\s\S]*?END WAYBACK[^>]*>/gi,'');
  const lower = h.toLowerCase();

  // First main landmark / first h1 position
  const mainIdx = (() => {
    const i1 = lower.search(/<main\b/);
    const i2 = lower.search(/<h1\b/);
    const cands = [i1,i2].filter(i=>i>=0);
    return cands.length ? Math.min(...cands) : lower.length;
  })();
  const beforeMain = h.slice(0, mainIdx);

  const focusableBeforeMain = (beforeMain.match(/<(a\b[^>]*href|button\b|input\b|select\b|textarea\b)/gi)||[]).length;
  const linksBeforeMain     = (beforeMain.match(/<a\b[^>]*href/gi)||[]).length;

  // Headings
  const headingCount = (h.match(/<h[1-6]\b/gi)||[]).length;
  const h1Count      = (h.match(/<h1\b/gi)||[]).length;

  // Images without alt
  const imgs = h.match(/<img\b[^>]*>/gi)||[];
  const imgsNoAlt = imgs.filter(t=>!/\balt\s*=/.test(t)).length;

  // Inputs without label/aria-label (rough)
  const inputs = h.match(/<input\b[^>]*>/gi)||[];
  const inputsNoLabel = inputs.filter(t=>!/aria-label|aria-labelledby|title=/.test(t)).length;

  // Search input + label
  const searchInput = /<input\b[^>]*(type\s*=\s*["']?search|name\s*=\s*["'][^"']*search|id\s*=\s*["'][^"']*search)/i.test(h);
  const searchLabeled = searchInput && /<input\b[^>]*(aria-label|aria-labelledby|title=)[^>]*(search|find)/i.test(h);

  // Duplicate accessible names on links/buttons (e.g. "Learn more" ×7)
  const names = [...h.matchAll(/<(?:a|button)\b[^>]*>([\s\S]*?)<\/(?:a|button)>/gi)]
    .map(x=>clean(x[1]).toLowerCase()).filter(t=>t && t.length<40);
  const freq = {}; names.forEach(n=>freq[n]=(freq[n]||0)+1);
  const dupNames = Object.entries(freq).filter(([,c])=>c>=3).map(([t,c])=>({label:t, count:c}))
                    .sort((a,b)=>b.count-a.count).slice(0,5);

  // Footer links
  const footer = (lower.match(/<footer\b[\s\S]*?<\/footer>/)||[''])[0];
  const footerLinks = (footer.match(/<a\b[^>]*href/gi)||[]).length;

  return {
    focusableBeforeMain, linksBeforeMain, headingCount, h1Count,
    imgsNoAlt, totalImgs: imgs.length,
    inputsNoLabel, totalInputs: inputs.length,
    searchInput, searchLabeled,
    dupNames, footerLinks,
  };
}

/* ── POINT 2: Replay / archival signals (structured) ───────────────── */
function replayIssues(html) {
  const issues = [];
  const lower = html.toLowerCase();
  if (/wayback machine has not archived/i.test(html)) issues.push({kind:'not_archived', detail:'Wayback notes this page was not fully archived'});
  if (/this page (was|has been) removed/i.test(html))  issues.push({kind:'archive_removed', detail:'Archive notes the page was removed'});
  // Missing resources — Wayback rewrites failed assets; look for error markers
  const failedAssets = (html.match(/\/web\/\d+(im_|cs_|js_)\/[^"']+/gi)||[]).length;
  // Count script/link refs that are NOT rewritten to web.archive.org (i.e. not preserved)
  const externalScripts = (html.match(/<script\b[^>]*src=["'](?!https?:\/\/web\.archive\.org)[^"']+["']/gi)||[]).length;
  if (externalScripts > 0) issues.push({kind:'missing_resource', detail:`${externalScripts} script resource(s) not preserved in this capture`});
  const textLen = html.replace(/<[^>]+>/g,'').trim().length;
  if (textLen < 400) issues.push({kind:'short_capture', detail:'Page text is unusually short — likely incomplete replay'});
  return issues;
}

/* ── POINT 6: PII masking ──────────────────────────────────────────── */
function maskPII(text) {
  if (!text) return {text, count:0, types:[]};
  let count=0; const types=new Set();
  let out = text
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => { count++; types.add('SSN'); return '[redacted-id]'; })
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, () => { count++; types.add('email'); return '[email]'; })
    .replace(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3,4}[\s.-]?\d{0,4}/g, (m) => {
      // only treat as phone if it has ≥7 digits
      const digits = (m.match(/\d/g)||[]).length;
      if (digits >= 7 && digits <= 15) { count++; types.add('phone'); return '[phone]'; }
      return m;
    });
  return {text: out, count, types:[...types]};
}

/* ═══════════════════════════════════════════════════════════════════
   AI CLASSIFICATION — Chain-of-Verification (CoVe)

   The earlier version used a single "compare these snapshots and list the
   differences" prompt. That is the shallow approach: the model tends to
   paraphrase, hallucinate quotes, or report archival artifacts as real
   edits — dangerous when the result is read aloud to a blind user as fact.

   This now runs a two-pass chain of verification:
     PASS 1 (DRAFT)  — propose candidate temporal changes, each with quotes
                       copied verbatim from the snapshot text.
     PASS 2 (VERIFY) — independently interrogate every candidate against the
                       source snapshots by answering explicit verification
                       questions (is the quote verbatim? right date? real
                       edit vs replay artifact? on-focus?), then emit ONLY the
                       claims that survive, with quotes corrected and
                       confidence set from the verification outcome.

   The mechanical quote-check in buildReport (verifyQuote) remains as a
   second, deterministic guard on top of this model-side verification.
═══════════════════════════════════════════════════════════════════ */
async function classifyWithAI(snaps, url, focus, provider, apiKey, ollamaModel) {
  const empty = (overview) => ({changes:[], overview, stableContent:[], replayWarnings:[], captureGaps:[]});
  const withText = snaps.filter(s=>s.text);
  if (withText.length<2) return empty('Not enough content retrieved to compare across time.');

  const model = provider==='groq' ? 'llama-3.1-8b-instant' : (ollamaModel||'llama3.2');

  const block = withText.map((s,i)=>{
    const heads = s.sections?.length ? `Sections: ${s.sections.slice(0,12).map(x=>x.heading).join(' | ')}` : '';
    return `--- Snapshot ${i+1}: ${fmtDate(s.date)} ---\n${heads}\n${s.text}`;
  }).join('\n\n');
  const period = `${fmtDate(withText[0].date)} to ${fmtDate(withText[withText.length-1].date)}`;

  /* ───────────────────────── PASS 1 — DRAFT ───────────────────────── */
  const draftPrompt =
`You are a meticulous web-archive forensic analyst. A BLIND user is investigating: "${focus||'general changes over time'}".

URL: ${url}
Period: ${period}
Below is the plain text of ${withText.length} archived snapshots of this page, oldest first.

${block}

TASK (DRAFT pass): Propose up to 6 candidate temporal changes you believe happened between snapshots.
For every candidate you MUST copy the supporting text VERBATIM from the snapshot blocks above — never paraphrase, never invent, never summarise inside a quote. If you cannot find exact supporting text, do not propose that change.

Reply ONLY with JSON (no markdown, no commentary):
{"overview":"2-3 plain sentences summarising how the page changed over the period, written to be read aloud.","changes":[{"id":1,"description":"under 10 words","type":"policy_change|content_added|content_removed|wording_change|navigation_change","section":"heading where it changed, or null","beforeDate":"a snapshot date copied exactly from a header above","afterDate":"a snapshot date copied exactly from a header above","beforeText":"verbatim quote from the BEFORE snapshot, max 40 words, or null if absent","afterText":"verbatim quote from the AFTER snapshot, max 40 words, or null if absent"}],"stableContent":["topics unchanged across all snapshots"],"captureGaps":["gaps over 60 days visible from the dates"]}`;

  let draft;
  try {
    draft = extractJson(await callAI({provider, model, apiKey, prompt: draftPrompt}));
  } catch(e) {
    return empty(`AI unavailable: ${e.message}`);
  }
  if (!draft) return empty('Could not parse the AI draft response.');
  if (!Array.isArray(draft.changes) || !draft.changes.length) {
    return {changes:[], overview:draft.overview||'No clear changes proposed.',
            stableContent:draft.stableContent||[], replayWarnings:[], captureGaps:draft.captureGaps||[], coveApplied:false};
  }

  /* ──────────────── PASS 2 — CHAIN OF VERIFICATION ────────────────── */
  const candidates = draft.changes.slice(0,6).map((c,i)=>({
    id:i+1, description:c.description, type:c.type, section:c.section||null,
    beforeDate:c.beforeDate, afterDate:c.afterDate,
    beforeText:c.beforeText??null, afterText:c.afterText??null,
  }));

  const verifyPrompt =
`You are the VERIFICATION stage of a forensic pipeline serving a BLIND user. Be skeptical and rigorous: a wrong claim read aloud as fact is far worse than omitting a true one.

URL: ${url}
SOURCE SNAPSHOTS — the ONLY ground truth. Ignore any outside knowledge:

${block}

CANDIDATE CHANGES proposed by an earlier draft (these MAY contain mistakes, paraphrases, hallucinated quotes, or replay artifacts):
${JSON.stringify(candidates)}

For EACH candidate, work through these verification questions using ONLY the snapshot text above:
  Q1. Does "beforeText" appear VERBATIM (word for word) in the snapshot dated beforeDate? Find it.
  Q2. Does "afterText" appear VERBATIM in the snapshot dated afterDate? Find it.
  Q3. Are beforeDate and afterDate each an actual snapshot header listed above? If a quote is actually found in a different snapshot, correct the date to that snapshot.
  Q4. Is this a REAL editorial change, or could it merely be an archival/replay artifact (e.g. text missing only because that capture is truncated or failed to load)?
  Q5. Is the change genuinely relevant to the user's focus: "${focus||'any substantive change'}"?

Then REVISE the list:
  - DROP any candidate whose quote is not verbatim-present and cannot be repaired by substituting the correct verbatim text.
  - FIX any paraphrased quote to the exact verbatim text from the snapshot.
  - CORRECT any mis-attributed before/after date.
  - For a genuine addition, beforeText may be null; for a genuine removal, afterText may be null — but the side that exists MUST be verbatim.
  - Set confidence honestly: "high" ONLY if the relevant quote(s) are verbatim-verified AND it is clearly an editorial change; "medium" if verified but it could be an artifact; "low" if uncertain.

Reply ONLY with JSON (no markdown):
{"overview":"corrected 2-3 sentence spoken summary","changes":[{"id":1,"description":"under 10 words","type":"policy_change|content_added|content_removed|wording_change|navigation_change","section":"heading or null","period":"Between Month YYYY and Month YYYY","beforeDate":"Month DD, YYYY","afterDate":"Month DD, YYYY","beforeText":"verbatim or null","afterText":"verbatim or null","confidence":"high|medium|low","confidenceReason":"one sentence citing the verification outcome","uncertainty":"one sentence on what the archive cannot confirm","verificationNotes":"brief: which checks passed or failed"}],"stableContent":["unchanged topics"],"captureGaps":["gaps over 60 days"]}
Keep at most 5 changes, strongest evidence first.`;

  let verified;
  try {
    verified = extractJson(await callAI({provider, model, apiKey, prompt: verifyPrompt}));
  } catch { verified = null; }   // network failed on pass 2 — fall back to draft below

  if (!verified || !Array.isArray(verified.changes)) {
    // Verification pass unavailable — return the draft, flagged as un-cross-checked.
    return {
      overview: draft.overview||'',
      changes: draft.changes,
      stableContent: draft.stableContent||[],
      replayWarnings: [],
      captureGaps: draft.captureGaps||[],
      coveApplied: false,
    };
  }

  verified.coveApplied   = true;
  verified.stableContent = verified.stableContent || draft.stableContent || [];
  verified.captureGaps   = verified.captureGaps   || draft.captureGaps   || [];
  verified.replayWarnings = [];
  return verified;
}

/* Pull the first JSON object out of a model reply (handles ```json fences, prose). */
function extractJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/* ═══════════════════════════════════════════════════════════════════
   REPORT BUILD — POINT 1 (verify) + POINT 2 (archival state) + POINT 3 (section)
═══════════════════════════════════════════════════════════════════ */
function buildReport(all, unique, selected, withContent, ai, params) {
  const {url, fromYear, toYear, focus} = params;
  const byYear={};
  all.forEach(s=>{ const y=s.date.getUTCFullYear(); byYear[y]=(byYear[y]||0)+1; });

  const findSnap = (label) => withContent.find(s=>fmtDate(s.date)===label);

  const changes = (ai.changes||[]).map((c,i)=>{
    const beforeSnap = findSnap(c.beforeDate) || withContent[0];
    const afterSnap  = findSnap(c.afterDate)  || withContent[withContent.length-1];

    /* POINT 1 — verify quotes against actual capture text */
    const vb = verifyQuote(c.beforeText, beforeSnap?.fullText);
    const va = verifyQuote(c.afterText,  afterSnap?.fullText);
    const verified = vb.ok && va.ok;
    const verifyScore = Math.round(((vb.score + va.score)/2)*100);

    /* POINT 2 — mechanically classify archival state */
    const arch = classifyArchivalState(c, beforeSnap, afterSnap, vb, va);

    /* POINT 3 — localize section (prefer AI's, else infer from sections) */
    const section = c.section || inferSection(c, beforeSnap, afterSnap);

    /* Confidence: start from AI, then downgrade on evidence */
    let confidence = c.confidence || 'medium';
    const reasons = [c.confidenceReason].filter(Boolean);
    if (!verified) { confidence = 'low'; reasons.push('Quote could not be located in the archived capture.'); }
    else if (arch.state === 'broken_replay' || arch.state === 'missing_resource') {
      confidence = downgrade(confidence); reasons.push('Relevant capture has replay degradation.');
    }

    return {
      ...c, id:i+1,
      section,
      beforeUrl: beforeSnap?.url||null,
      afterUrl:  afterSnap?.url||null,
      verified, verifyScore,
      beforeVerified: vb.ok, afterVerified: va.ok,
      archivalState: arch.state, archivalReason: arch.reason,
      confidence,
      confidenceReason: reasons.join(' '),
    };
  });

  /* POINT 4 — accessibility decay audit (earliest vs latest with content) */
  const withA11y = withContent.filter(s=>s.a11y);
  const a11yAudit = withA11y.length>=2 ? auditA11y(withA11y[0], withA11y[withA11y.length-1]) : null;

  /* Privacy summary */
  const privacyHits = withContent.reduce((n,s)=>n+(s.privacy?.count||0),0);
  const privacyTypes = [...new Set(withContent.flatMap(s=>s.privacy?.types||[]))];

  const replayWarnings = dedupeStr([
    ...withContent.flatMap(s=>(s.issues||[]).map(i=>i.detail||i)),
  ]);

  return {
    mode:'single', url, fromYear, toYear, focus,
    coveApplied: ai.coveApplied !== false,   // chain-of-verification ran on the AI changes
    totalCaptures: all.length, uniqueCaptures: unique.length, selectedCaptures: selected.length,
    firstCapture: fmtDate(all[0]?.date), lastCapture: fmtDate(all[all.length-1]?.date),
    yearBreakdown: byYear,
    overview: ai.overview||'',
    changes,
    stableContent: ai.stableContent||[],
    replayWarnings,
    captureGaps: (ai.captureGaps||[]).concat(detectGaps(unique)),
    a11yAudit,
    privacy: privacyHits ? {count:privacyHits, types:privacyTypes} : null,
    keySnapshots: withContent.filter(s=>s.text).map(s=>({
      timestamp:s.timestamp, date:fmtDate(s.date), url:s.url,
      issues:(s.issues||[]).map(i=>i.detail||i),
      sectionCount: s.sections?.length||0,
    })),
  };
}

/* ── POINT 1: quote verification ───────────────────────────────────── */
function verifyQuote(quote, text) {
  if (quote == null || quote === '') return {ok:true, score:1};   // intentionally absent
  if (!text) return {ok:false, score:0};
  const nq = norm(quote), nt = norm(text);
  if (!nq) return {ok:true, score:1};
  if (nt.includes(nq)) return {ok:true, score:1};
  // token-overlap fallback for minor OCR/whitespace differences
  const qt = nq.split(' ').filter(Boolean);
  const present = qt.filter(t=>nt.includes(t)).length;
  const score = qt.length ? present/qt.length : 0;
  return {ok: score >= 0.8, score};
}
function norm(s){ return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }

/* ── POINT 2: archival-state classifier ────────────────────────────── */
function classifyArchivalState(c, beforeSnap, afterSnap, vb, va) {
  const afterIssues  = (afterSnap?.issues||[]).map(i=>i.kind);
  const beforeIssues = (beforeSnap?.issues||[]).map(i=>i.kind);
  const afterDegraded = afterIssues.some(k=>['not_archived','archive_removed','short_capture','missing_resource'].includes(k));

  const hadBefore = !!(c.beforeText && c.beforeText.trim());
  const hasAfter  = !!(c.afterText && c.afterText.trim());

  // Appearance
  if (!hadBefore && hasAfter) return {state:'added', reason:'Content present in the later capture but absent earlier.'};

  // Content gone in "after"
  if (hadBefore && !hasAfter) {
    if (afterIssues.includes('missing_resource'))
      return {state:'missing_resource', reason:'Content absent, but the later capture has unpreserved resources — absence may be a replay artifact.'};
    if (afterDegraded)
      return {state:'broken_replay', reason:'Content absent, but the later capture failed to replay fully — not confirmed as a real deletion.'};
    if (c.type === 'navigation_change' || c.type === 'moved_content')
      return {state:'moved', reason:'Content no longer on this page; navigation/structure changed — it may have moved elsewhere.'};
    if (!vb.ok)
      return {state:'unclear', reason:'Before-text could not be verified, so the disappearance is uncertain.'};
    return {state:'real_deletion', reason:'Content verified present earlier and cleanly absent later — likely a real removal from this page.'};
  }

  // Both present
  if (hadBefore && hasAfter) {
    if (!vb.ok || !va.ok) return {state:'unclear', reason:'One or both quoted spans could not be located in the captures.'};
    return {state:'wording_change', reason:'Both versions verified in their captures — a genuine wording/policy change.'};
  }

  return {state:'unclear', reason:'Insufficient evidence to classify.'};
}

/* ── POINT 3: infer section from heading match ─────────────────────── */
function inferSection(c, beforeSnap, afterSnap) {
  const terms = norm(`${c.description} ${c.beforeText||''} ${c.afterText||''}`).split(' ').filter(t=>t.length>3);
  const pool = [...(beforeSnap?.sections||[]), ...(afterSnap?.sections||[])];
  let best=null, bestScore=0;
  for (const sec of pool) {
    const blob = norm(`${sec.heading} ${sec.text}`);
    const score = terms.filter(t=>blob.includes(t)).length;
    if (score > bestScore) { bestScore=score; best=sec.heading; }
  }
  return bestScore>=2 ? best : null;
}

/* ── POINT 4: accessibility decay audit ────────────────────────────── */
function auditA11y(before, after) {
  const b=before.a11y, a=after.a11y;
  const deltas=[];
  const note=(metric,bv,av,worseIf)=>{
    const worse = worseIf(bv,av);
    if (worse!==null) deltas.push({metric, before:bv, after:av, direction: worse});
  };
  note('Focusable elements before main content', b.focusableBeforeMain, a.focusableBeforeMain, (x,y)=> y>x*1.3 ? 'worse' : y<x*0.7 ? 'better' : null);
  note('Links before main content',              b.linksBeforeMain,     a.linksBeforeMain,     (x,y)=> y>x*1.3 ? 'worse' : y<x*0.7 ? 'better' : null);
  note('Footer links',                            b.footerLinks,         a.footerLinks,         (x,y)=> y>x*1.5 ? 'worse' : null);
  note('Images missing alt text',                 b.imgsNoAlt,           a.imgsNoAlt,           (x,y)=> y>x ? 'worse' : y<x ? 'better' : null);
  note('Form inputs without labels',              b.inputsNoLabel,       a.inputsNoLabel,       (x,y)=> y>x ? 'worse' : y<x ? 'better' : null);
  note('Heading count',                           b.headingCount,        a.headingCount,        (x,y)=> y<x*0.5 ? 'worse' : null);

  const findings=[];
  if (b.searchLabeled && !a.searchLabeled) findings.push('Search input lost its accessible label after redesign.');
  if (!b.searchLabeled && a.searchLabeled) findings.push('Search input gained an accessible label.');
  if (a.dupNames.length) findings.push(`Ambiguous links: ${a.dupNames.map(d=>`"${d.label}" ×${d.count}`).join(', ')}.`);

  const worse = deltas.filter(d=>d.direction==='worse').length;
  const better= deltas.filter(d=>d.direction==='better').length;
  const verdict = worse>better ? 'Accessibility appears to have DECREASED over time.'
                : better>worse ? 'Accessibility appears to have IMPROVED over time.'
                : 'No clear accessibility trend detected.';
  return {before:fmtDate(before.date), after:fmtDate(after.date), deltas, findings, verdict};
}

function detectGaps(snaps) {
  const gaps=[]; const DAY=86400000;
  for (let i=1;i<snaps.length;i++){
    const d=(snaps[i].date-snaps[i-1].date)/DAY;
    if (d>60) gaps.push(`${Math.round(d)}-day gap: ${fmtDate(snaps[i-1].date)} → ${fmtDate(snaps[i].date)}`);
  }
  return gaps.slice(0,6);
}

/* ── AI providers ───────────────────────────────────────────────────── */
async function callAI({provider, model, apiKey, prompt}) {
  if (provider === 'groq') {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
      body:JSON.stringify({model, messages:[{role:'user',content:prompt}], max_tokens:1400, temperature:0.2}),
    });
    if (!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e?.error?.message||`Groq ${res.status}`);}
    return (await res.json()).choices?.[0]?.message?.content||'';
  }
  const res = await fetch('http://localhost:11434/api/chat',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:model||'llama3.2', stream:false, messages:[{role:'user',content:prompt}]}),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const d=await res.json(); return d.message?.content||d.response||'';
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
function stripWayback(url){
  try{ const u=new URL(url.trim());
    if(u.hostname==='web.archive.org'){ const m=u.pathname.match(/^\/web\/[^/]+\/(.+)$/); if(m) return m[1]; }
  }catch{} return url.trim();
}
function clean(s){ return String(s).replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim(); }
function dedupeStr(a){ return a.filter((v,i)=>a.indexOf(v)===i); }
function downgrade(c){ return c==='high'?'medium':c==='medium'?'low':'low'; }
function parseTs(ts){ if(!ts||ts.length<8) return null; const d=new Date(`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T00:00:00Z`); return isNaN(d)?null:d; }
function fmtDate(d){ if(!d||isNaN(d)) return 'Unknown'; return d.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
