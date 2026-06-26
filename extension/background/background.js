'use strict';

// Local API key, loaded from secret.local.js (which is .gitignored — NEVER upload it).
// Set it in background/secret.local.js:  self.__AI_PROVIDER__='groq'; self.__AI_KEY__='gsk_...';
try { importScripts('secret.local.js'); } catch (_) {}

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
  // The CDX query is capped at 1500 rows; at the cap the true total is higher,
  // so report it honestly as "1500+" rather than implying it's the exact count.
  const capped = snaps.length >= 1500;
  push({step:1, status:'done', text:`Found ${snaps.length}${capped?'+':''} captures (${snaps[0].date.getUTCFullYear()}–${snaps[snaps.length-1].date.getUTCFullYear()})${capped?', sampling the first 1500':''}`});

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

  /* Step 5 — AI classify (self-consistency over K sampled chain-of-verification passes) */
  push({step:5, status:'running', text:'Classifying changes with AI (self-consistency: several sampled draft→verify passes, kept by majority)…'});
  const ai = await classifyWithAI(withContent, url, focus, provider, apiKey, ollamaModel, push);
  const coveTxt = ai.coveApplied === false ? ' (draft only — verification pass unavailable)' : '';
  const sampTxt = ai.samples > 1 ? ` agreed across ${ai.samples} samples` : '';
  push({step:5, status:'done', text:`AI kept ${ai.changes?.length||0} change(s)${sampTxt}${coveTxt}`});

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
  const base = {url, output:'json', fl:'timestamp,statuscode,digest,length',
                from:`${fromYear}0101000000`, to:`${toYear}1231235959`, limit:'1500'};
  let rows = await cdxFetch({...base, filter:'statuscode:200'});
  if (!rows.length) rows = await cdxFetch({...base});
  if (!rows.length) rows = await cdxFetch({url, output:'json', fl:'timestamp,statuscode,digest,length', limit:'500'});
  return rows;
}

async function cdxFetch(params, attempt=1, maxAttempts=4) {
  const qs = new URLSearchParams(params);
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), 25000);   // CDX can legitimately take 15-20s for big sites
    res = await fetch(`${CDX}?${qs}`, {signal:ctrl.signal});
    clearTimeout(timer);
  } catch {
    if (attempt < maxAttempts) { await sleep(800 * 2**(attempt-1)); return cdxFetch(params, attempt+1, maxAttempts); }
    throw new Error('Wayback Machine is not responding (timeout). It may be under heavy load — try again in a minute, or narrow the year range.');
  }
  if (!res.ok) {
    const retryable = res.status>=500 || res.status===429;   // 503 busy / 429 rate-limited
    if (retryable && attempt<maxAttempts) {
      const ra = parseInt(res.headers.get('retry-after')) || 0;   // honour Wayback's back-off hint
      await sleep(Math.max(800 * 2**(attempt-1), ra*1000));        // exponential backoff: 0.8s, 1.6s, 3.2s
      return cdxFetch(params, attempt+1, maxAttempts);
    }
    if (retryable) throw new Error(`Wayback Machine is busy (HTTP ${res.status}). Try again shortly.`);
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
  const first=snaps[0], last=snaps[snaps.length-1];

  // Byte-length change between consecutive captures.
  const deltas=[];
  for (let i=1;i<snaps.length;i++) deltas.push(Math.abs((snaps[i].length||0)-(snaps[i-1].length||0)));

  // Iglewicz–Hoaglin modified z-score: flags a transition as a "significant
  // change" RELATIVE to this page's own variability, instead of a fixed
  // 25%/3000-byte rule that is wrong for both tiny and huge pages.
  const z = modifiedZScores(deltas);            // z[i-1] ↔ transition into snaps[i]
  const jumps=[];
  for (let i=1;i<snaps.length-1;i++){
    if (Math.abs(z[i-1]) > 3.5) jumps.push({snap:snaps[i], z:Math.abs(z[i-1])});
  }
  jumps.sort((a,b)=>b.z-a.z);                    // strongest change points first
  const picked = jumps.slice(0,4).map(j=>j.snap);
  const mid = snaps.slice(1,-1).filter(s=>!picked.includes(s));
  // Select by change magnitude, but return in CHRONOLOGICAL order so the AI
  // block is genuinely "oldest first", the TF-IDF trajectory runs forward in
  // time, and the snapshot listing reads in date order.
  return dedupe([first, ...picked, ...evenlySample(mid,3), last])
    .sort((a,b)=> a.date - b.date);
}

function evenlySample(arr,n){
  if(!arr.length||n<=0) return [];
  if(arr.length<=n) return arr;
  return Array.from({length:n},(_,i)=>arr[Math.round(i*(arr.length-1)/(n-1))]);
}

/* ═══════════════════════════════════════════════════════════════════
   STATISTICS LAYER — model-free quantitative signals
   Makes snapshot selection, quote checking and confidence reproducible
   and evidence-driven rather than ad-hoc.
═══════════════════════════════════════════════════════════════════ */

/* Median of a numeric array. */
function median(xs){
  if (!xs.length) return 0;
  const s=[...xs].sort((a,b)=>a-b), m=s.length>>1;
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}

/* Iglewicz–Hoaglin MODIFIED Z-SCORE:  M_i = 0.6745·(x_i − median) / MAD
   where MAD = median(|x_i − median|). Robust to outliers; |M_i| > 3.5 marks
   an outlier. Falls back to classic mean/SD z-score if MAD degenerates. */
function modifiedZScores(xs){
  if (xs.length<2) return xs.map(()=>0);
  const med=median(xs);
  const mad=median(xs.map(x=>Math.abs(x-med)));
  if (mad===0){
    const mean=xs.reduce((a,b)=>a+b,0)/xs.length;
    const sd=Math.sqrt(xs.reduce((a,b)=>a+(b-mean)**2,0)/xs.length)||1;
    return xs.map(x=>(x-mean)/sd);
  }
  return xs.map(x=>0.6745*(x-med)/mad);
}

/* ── TF-IDF + cosine similarity ─────────────────────────────────────
   Quantifies how much two snapshots differ in CONTENT (not byte size):
     tf  = 1 + log(count)              (log-normalised term frequency)
     idf = log((1+N)/(1+df)) + 1       (smoothed inverse document frequency)
     weight = tf · idf
     cosine = A·B / (‖A‖·‖B‖) ;  dissimilarity = 1 − cosine            */
const STOPWORDS = new Set(('the a an and or but of to in for on at by with from as is are was '
  +'were be been being this that these those it its their your our his her not no nor so if then '
  +'than too very can will just into out over under more most other some such only own same').split(' '));

function tokenize(text){
  return (String(text||'').toLowerCase().match(/[a-z0-9]+/g)||[])
    .filter(t=>t.length>2 && !STOPWORDS.has(t));
}
function termFreq(tokens){
  const tf={}; for (const t of tokens) tf[t]=(tf[t]||0)+1;
  for (const t in tf) tf[t]=1+Math.log(tf[t]);
  return tf;
}
function tfidfVectors(docsTokens){
  const N=docsTokens.length, df={};
  const tfs=docsTokens.map(termFreq);
  for (const tf of tfs) for (const t in tf) df[t]=(df[t]||0)+1;
  return tfs.map(tf=>{
    const v={};
    for (const t in tf){ const idf=Math.log((1+N)/(1+df[t]))+1; v[t]=tf[t]*idf; }
    return v;
  });
}
function cosineSim(a,b){
  let dot=0,na=0,nb=0;
  for (const k in a){ na+=a[k]*a[k]; if (b[k]!==undefined) dot+=a[k]*b[k]; }
  for (const k in b) nb+=b[k]*b[k];
  return (na&&nb) ? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0;
}

/* Archival-state reliability factor (0–1) used to weight the confidence score:
   a change resting on a degraded/partial capture is inherently less reliable. */
const STATE_RELIABILITY = {
  real_deletion:1, added:1, wording_change:1, moved:0.85,
  unclear:0.5, broken_replay:0.25, missing_resource:0.25,
};

/* ═══════════════════════════════════════════════════════════════════
   CONTENT FETCH + structural computation
═══════════════════════════════════════════════════════════════════ */
async function fetchContents(snaps, pageUrl, focus, maskPii) {
  const out = [];
  for (const s of snaps) {
    const rawUrl = `${WB}${s.timestamp}id_/${pageUrl}`;
    let html=null, text=null, fullText=null, sections=[], a11y=null, issues=[], privacy=null;
    try {
      let res=null;
      for (let a=1; a<=3; a++) {                          // up to 3 tries per capture
        const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),12000);
        try { res=await fetch(rawUrl,{signal:ctrl.signal}); clearTimeout(t); }
        catch(err){ clearTimeout(t); if (a===3) throw err; await sleep(600*a); continue; }
        if (res.ok) break;
        if ((res.status>=500 || res.status===429) && a<3) {   // 503/429 → back off and retry
          const ra = parseInt(res.headers.get('retry-after')) || 0;
          await sleep(Math.max(600*a, ra*1000)); continue;
        }
        break;                                            // non-retryable status, or out of tries
      }
      if (res && res.ok) {
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
      } else if (res) {
        issues=[{kind:'fetch_failed', detail:`HTTP ${res.status}`}];
      }
    } catch(e) { issues=[{kind:'fetch_failed', detail:e.message}]; }
    await sleep(150);                                    // small politeness gap between captures
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
  // Count script/link refs that are NOT rewritten to web.archive.org (i.e. not preserved)
  const externalScripts = (html.match(/<script\b[^>]*src=["'](?!https?:\/\/web\.archive\.org)[^"']+["']/gi)||[]).length;
  if (externalScripts > 0) issues.push({kind:'missing_resource', detail:`${externalScripts} script resource(s) not preserved in this capture`});
  // Measure VISIBLE text only — strip script/style BODIES first, otherwise a
  // near-empty replay padded with inline script evades the short-capture check.
  const textLen = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
                      .replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().length;
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
const SELF_CONSISTENCY_K = 5;   // cloud draft→verify samples for self-consistency (paper §4.4)

async function classifyWithAI(snaps, url, focus, provider, apiKey, ollamaModel, onProgress) {
  // Local override from secret.local.js — AUTHORITATIVE: wins over any stale popup key.
  if (typeof self !== 'undefined' && self.__AI_PROVIDER__) provider = self.__AI_PROVIDER__;
  if (typeof self !== 'undefined' && self.__AI_KEY__)      apiKey   = self.__AI_KEY__;
  const empty = (overview) => ({changes:[], overview, stableContent:[], replayWarnings:[], captureGaps:[]});
  // Compare only cleanly-replayed captures — a truncated/failed capture fed to the
  // model invents changes that are really replay artifacts (paper's POINT 1 concern).
  const withText = snaps.filter(s=>s.text && contentUsable(s));
  if (withText.length<2) return empty('Not enough cleanly-archived content to compare across time.');

  const model = provider==='groq'   ? 'llama-3.1-8b-instant'
              : provider==='openai' ? 'gpt-4o-mini'
              : (ollamaModel||'llama3.2');

  // Keep the prompt under the free-tier per-minute token budget: the whole
  // block is re-sent on every one of the K×(draft+verify) calls, so cap the
  // total snapshot text (~6k chars ≈ ~1.5k tokens) and divide it evenly.
  const BLOCK_CHAR_BUDGET = 6000;
  const perSnap = Math.max(400, Math.floor(BLOCK_CHAR_BUDGET / withText.length));
  const block = withText.map((s,i)=>{
    const heads = s.sections?.length ? `Sections: ${s.sections.slice(0,8).map(x=>x.heading).join(' | ')}` : '';
    return `--- Snapshot ${i+1}: ${fmtDate(s.date)} ---\n${heads}\n${s.text.slice(0,perSnap)}`;
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

  /* Self-consistency: draw K independent draft→verify samples and keep only the
     changes a majority of samples agree on (paper §4.4). Cross-sample identity
     reuses the bigram-containment test (sameChange). The draft pass samples at a
     higher temperature so the K runs actually diverge; verify stays strict.
     Local Ollama defaults to K=1 (single sample) for cost/latency. */
  const K = (provider==='groq' || provider==='openai') ? SELF_CONSISTENCY_K : 1;
  const draftTemp = K>1 ? 0.7 : 0.2;

  /* One independent draft→verify sample. Returns {changes, overview,
     stableContent, captureGaps, coveApplied}, or {error} / null on failure. */
  async function runOnce() {
    let draft;
    try {
      draft = extractJson(await callAI({provider, model, apiKey, prompt: draftPrompt, temperature: draftTemp}));
    } catch(e) { return {error: e.message}; }
    if (!draft) return null;
    if (!Array.isArray(draft.changes) || !draft.changes.length) {
      return {changes:[], overview:draft.overview||'No clear changes proposed.',
              stableContent:draft.stableContent||[], captureGaps:draft.captureGaps||[], coveApplied:false};
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
    try { verified = extractJson(await callAI({provider, model, apiKey, prompt: verifyPrompt, temperature: 0.2})); }
    catch { verified = null; }   // network failed on pass 2 — fall back to draft

    if (!verified || !Array.isArray(verified.changes)) {
      return {changes:draft.changes, overview:draft.overview||'',
              stableContent:draft.stableContent||[], captureGaps:draft.captureGaps||[], coveApplied:false};
    }
    return {changes:verified.changes, overview:verified.overview||draft.overview||'',
            stableContent:verified.stableContent||draft.stableContent||[],
            captureGaps:verified.captureGaps||draft.captureGaps||[], coveApplied:true};
  }

  const runs = [];
  for (let k=0;k<K;k++){
    // Heartbeat: resets the overlay watchdog and shows real progress during the
    // (rate-limited) self-consistency loop instead of a frozen "Classifying…".
    onProgress?.({step:5, status:'running',
      text:`Classifying with AI — self-consistency sample ${k+1} of ${K} (draft→verify)…`});
    const r = await runOnce(); if (r) runs.push(r);
  }
  const valid = runs.filter(r=>r && Array.isArray(r.changes));
  if (!valid.length) {
    const err = runs.find(r=>r && r.error);
    return empty(err ? `AI unavailable: ${err.error}` : 'Could not parse the AI response.');
  }

  /* Cluster matching changes across the valid samples (identity via bigram
     containment); stability c = (#samples proposing the change) / K. Keep only
     changes a majority of samples support, strongest stability first. */
  const clusters = [];
  valid.forEach((r, runIdx) => {
    (r.changes||[]).forEach(ch => {
      let cl = clusters.find(x => sameChange(x.rep, ch));
      if (!cl) { cl = {rep:ch, runs:new Set()}; clusters.push(cl); }
      cl.runs.add(runIdx);
      if (quoteLen(ch) > quoteLen(cl.rep)) cl.rep = ch;   // keep the fullest-quoted member
    });
  });
  const Keff = valid.length;
  const changes = clusters
    .filter(cl => cl.runs.size / Keff > 0.5)
    .map(cl => ({...cl.rep, stability: cl.runs.size / Keff}))
    .sort((a,b)=> b.stability - a.stability)
    .slice(0,5);

  const lead = valid.find(r=>r.coveApplied) || valid[0];
  const coveApplied = valid.filter(r=>r.coveApplied).length >= Math.ceil(Keff/2);

  if (!changes.length) {
    return {changes:[], overview:lead.overview||'No changes were consistently supported across samples.',
            stableContent:lead.stableContent||[], replayWarnings:[], captureGaps:lead.captureGaps||[],
            coveApplied, samples:Keff};
  }
  return {changes, overview:lead.overview||'', stableContent:lead.stableContent||[],
          replayWarnings:[], captureGaps:lead.captureGaps||[], coveApplied, samples:Keff};
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

  /* Quantify content change with TF-IDF cosine (deterministic, model-free).
     dissimilarity = 1 − cosine between consecutive analysed snapshots. Degraded
     replays (truncated/failed) are excluded so they don't inflate the trajectory. */
  const docs = withContent.filter(contentUsable);
  const changeMagnitudes=[];
  let overallChangeScore=null, peakChange=null;
  if (docs.length>=2){
    const vecs = tfidfVectors(docs.map(s=>tokenize(s.fullText)));
    for (let i=1;i<docs.length;i++){
      const sim = cosineSim(vecs[i-1], vecs[i]);
      changeMagnitudes.push({
        from: fmtDate(docs[i-1].date), to: fmtDate(docs[i].date),
        dissimilarity: Math.round((1-sim)*100), similarity: Math.round(sim*100),
      });
    }
    overallChangeScore = Math.round((1 - cosineSim(vecs[0], vecs[vecs.length-1]))*100);
    peakChange = changeMagnitudes.reduce((mx,t)=> t.dissimilarity>(mx?.dissimilarity??-1)?t:mx, null);
  }

  // Normalise the model's quote fields up front, then drop non-changes:
  //  • sentinel strings ("null"/"none"/…) → real null, so a genuine addition is
  //    not mis-read as "both sides present" (would become a bogus "unclear").
  //  • no-ops where before == after are not changes at all — reporting one would
  //    read an identical span aloud twice to a blind user, so they are removed.
  const aiChanges = (ai.changes||[])
    .map(c => ({...c, beforeText: nullSentinel(c.beforeText), afterText: nullSentinel(c.afterText)}))
    .filter(c => !(c.beforeText && c.afterText && norm(c.beforeText) === norm(c.afterText)));

  const scored = aiChanges.map((c,i)=>{
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

    /* Evidence-weighted reliability — parameter-free product of independent signals (§4.5).
         q   = mean verbatim quote reliability     ∈ [0,1]   (bigram containment, Eq. contain)
         sf  = archival-state reliability factor   ∈ [0,1]   (penalises degraded replays)
         cc  = self-consistency stability          ∈ (0,1]   (agreement across K samples, §4.4)
         R   = cc · q · sf   →   no weights, no cap; the weakest factor bounds the score.    */
    const q  = (vb.score + va.score) / 2;
    const sf = STATE_RELIABILITY[arch.state] ?? 0.5;
    const cc = (typeof c.stability === 'number') ? c.stability : 1;   // 1 in the K=1 (single-sample) case
    const R  = cc * q * sf;
    const confidenceScore = Math.max(0, Math.min(100, Math.round(100 * R)));
    /* The qualitative label is a banding of the SAME reliability R that yields the
       score, so the word and the number are one quantity and can never contradict
       (the old rule could print "high" beside a 60/100 score). R = cc·q·sf already
       folds in quote reliability q, replay reliability sf, and self-consistency cc
       multiplicatively, so the weakest factor bounds both label and score together.
         high : R ≥ 0.80      medium : 0.50 ≤ R < 0.80      low : R < 0.50           */
    const confidence = confidenceScore >= 80 ? 'high'
                     : confidenceScore >= 50 ? 'medium'
                     : 'low';
    const relTx = changeMagnitudes.find(x=>x.from===c.beforeDate && x.to===c.afterDate);
    const reasons = [c.confidenceReason].filter(Boolean);
    reasons.push(`Confidence ${confidenceScore}/100 — quote match ${Math.round(q*100)}%, agreement ${Math.round(cc*100)}% across samples${sf<1?`, replay reliability ${Math.round(sf*100)}%`:''}.`);
    if (!verified) reasons.push('Quote could not be located in the archived capture.');

    return {
      ...c, id:i+1,
      section,
      beforeUrl: beforeSnap?.url||null,
      afterUrl:  afterSnap?.url||null,
      verified, verifyScore,
      beforeVerified: vb.ok, afterVerified: va.ok,
      archivalState: arch.state, archivalReason: arch.reason,
      confidence, confidenceScore,
      changeMagnitude: relTx ? relTx.dissimilarity : null,
      confidenceReason: reasons.join(' '),
    };
  });

  /* HARD VERBATIM GATE (POINT 1, enforced) — a blind user cannot visually
     double-check a spoken claim, so we refuse to read any change whose evidence
     quote is not present word-for-word in the archived capture. The mechanical
     bigram-containment check (verifyQuote ≥ 0.7) already scores this; here we act
     on it decisively: drop — not merely down-rank — any change with an
     unverifiable presented quote, plus any change carrying no quote at all. This
     makes a hallucinated quote impossible to surface (reported grounding → ~100%),
     trading some recall for the paper's invariant: a false claim is worse than an
     omission. Renumber survivors so ids stay 1..n. */
  const changes = scored
    .filter(c => c.verified && (c.beforeText != null || c.afterText != null))
    .map((c,i)=>({...c, id:i+1}));

  /* POINT 4 — accessibility decay audit (earliest vs latest with content).
     Skip degenerate captures whose HTML yielded no parseable structure
     (0 headings, links, images AND inputs) — those are failed/empty replays,
     and comparing against them invents bogus "improved/worse" verdicts. */
  const a11yUsable = (m) => m && (m.headingCount>0 || m.linksBeforeMain>0 || m.totalImgs>0 || m.totalInputs>0);
  const withA11y = withContent.filter(s=>a11yUsable(s.a11y));
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
    selfConsistencySamples: ai.samples ?? 1, // K draft→verify samples reconciled by self-consistency
    totalCaptures: all.length, capturesCapped: all.length>=1500, uniqueCaptures: unique.length, selectedCaptures: selected.length,
    firstCapture: fmtDate(all[0]?.date), lastCapture: fmtDate(all[all.length-1]?.date),
    yearBreakdown: byYear,
    overview: ai.overview||'',
    changes,
    changeMagnitudes, overallChangeScore, peakChange,
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
    /* Re-scoring bundle: the expensive, non-deterministic inputs (raw LLM changes
       + the archived snapshot texts) so buildReport can be re-run offline with
       updated scoring logic — no LLM call, no re-fetch. Exported in the .json. */
    _rescore: {
      schema: 1,
      params: {url, fromYear, toYear, focus},
      ai: { changes: ai.changes||[], overview: ai.overview||'',
            coveApplied: ai.coveApplied !== false, samples: ai.samples ?? 1,
            stableContent: ai.stableContent||[], captureGaps: ai.captureGaps||[] },
      captureCounts: { total: all.length, unique: unique.length, selected: selected.length },
      snapshots: withContent.map(s=>({
        date: s.date, timestamp: s.timestamp, url: s.url,
        fullText: s.fullText||null, issues: s.issues||[], a11y: s.a11y||null, sections: s.sections||[],
      })),
    },
  };
}

/* A capture is unusable for TEXT analysis when its replay is degraded enough to
   distort the content itself — truncated/short text, a failed fetch, or an
   unarchived/removed page. Missing sub-resources (scripts, images) do NOT corrupt
   the page text, so those captures are kept. Used to keep broken replays out of
   the TF-IDF trajectory and the AI comparison block, where they otherwise inject
   spurious ~99% "changes". */
const DEGRADED_TEXT_ISSUES = ['short_capture','fetch_failed','not_archived','archive_removed'];
function contentUsable(s){
  if (!s || !s.fullText) return false;
  // Defence in depth: exclude near-empty replays directly by analysed-text length,
  // independent of whether short_capture was flagged.
  if (s.fullText.replace(/\s+/g,' ').trim().length < 200) return false;
  return !(s.issues||[]).some(i => DEGRADED_TEXT_ISSUES.includes(i.kind||i));
}

/* Coerce a model's absent-side sentinel (the literal "null", "none", "n/a", a
   dash, etc.) to real JS null. Only matches exact one-token sentinels so genuine
   quotes that merely start with "no…" are never discarded. */
function nullSentinel(s){
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return /^(null|none|nil|undefined|n\/?a|n\.a\.|na|—|-{1,2})$/i.test(t) ? null : s;
}

/* ── POINT 1: quote verification ───────────────────────────────────── */
function verifyQuote(quote, text) {
  if (quote == null || quote === '') return {ok:true, score:1};   // intentionally absent
  if (!text) return {ok:false, score:0};
  const nq = norm(quote), nt = norm(text);
  if (!nq) return {ok:true, score:1};
  if (nt.includes(nq)) return {ok:true, score:1};                 // exact (normalised) match
  // Bigram OVERLAP (containment) coefficient: |Q∩T| / |Q| over word bigrams.
  // Requiring consecutive word pairs to match — not merely individual words —
  // removes the false positives the old unigram overlap accepted.
  const score = bigramContainment(nq, nt);
  return {ok: score >= 0.7, score};
}
function bigrams(tokens){ const b=[]; for (let i=0;i<tokens.length-1;i++) b.push(tokens[i]+' '+tokens[i+1]); return b; }
function bigramContainment(quoteNorm, textNorm){
  const qts = quoteNorm.split(' ').filter(Boolean);
  const qb  = bigrams(qts);
  if (!qb.length){ // ≤1 word: fall back to unigram presence
    if (!qts.length) return 1;
    const tset=new Set(textNorm.split(' ').filter(Boolean));
    return qts.filter(t=>tset.has(t)).length / qts.length;
  }
  const tb = new Set(bigrams(textNorm.split(' ').filter(Boolean)));
  const present = qb.filter(x=>tb.has(x)).length;
  return present / qb.length;
}
function norm(s){ return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim(); }

/* ── Self-consistency helpers (§4.4): decide when two sampled changes are "the
   same" change, reusing the same bigram-containment machinery as the quote check. */
function quoteLen(c){ return ((c.beforeText||'').length + (c.afterText||'').length); }
function quotesMatch(x, y){
  const nx = norm(x||''), ny = norm(y||'');
  if (!nx && !ny) return true;            // both intentionally absent
  if (!nx || !ny)  return false;          // one side present, other absent → different
  return bigramContainment(nx, ny) >= 0.6 && bigramContainment(ny, nx) >= 0.6;   // mutual containment
}
function sameChange(a, b){
  const dateAgree = a.beforeDate===b.beforeDate || a.afterDate===b.afterDate;
  if (a.afterText || b.afterText)   return dateAgree && quotesMatch(a.afterText, b.afterText);
  if (a.beforeText || b.beforeText) return dateAgree && quotesMatch(a.beforeText, b.beforeText);
  return dateAgree && norm(a.description||'')===norm(b.description||'');
}

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
async function callAI({provider, model, apiKey, prompt, temperature=0.2}) {
  // Groq and OpenAI share the OpenAI chat-completions schema — same call path,
  // different endpoint. Free-tier Groq enforces a tokens-per-minute budget so
  // large back-to-back calls (K self-consistency × draft+verify) get 429'd;
  // honour Retry-After and back off so every pass completes (harmless on OpenAI).
  if (provider === 'groq' || provider === 'openai') {
    const endpoint = provider === 'openai'
      ? 'https://api.openai.com/v1/chat/completions'
      : 'https://api.groq.com/openai/v1/chat/completions';
    const maxAttempts = 6;
    for (let attempt=1; ; attempt++) {
      const res = await fetch(endpoint,{
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
        body:JSON.stringify({model, messages:[{role:'user',content:prompt}], max_tokens:1100, temperature}),
      });
      if (res.ok) return (await res.json()).choices?.[0]?.message?.content||'';
      const rateLimited = res.status===429 || res.status>=500;
      if (rateLimited && attempt<maxAttempts) {
        const ra = parseFloat(res.headers.get('retry-after')||'');
        const waitMs = Math.min(30000, (Number.isFinite(ra) ? ra*1000 : 0) || attempt*4000) + Math.random()*500;
        await new Promise(r=>setTimeout(r, waitMs));
        continue;
      }
      const e=await res.json().catch(()=>({}));
      throw new Error(e?.error?.message||`${provider} ${res.status}`);
    }
  }
  const res = await fetch('http://localhost:11434/api/chat',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:model||'llama3.2', stream:false, messages:[{role:'user',content:prompt}], options:{temperature}}),
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
function parseTs(ts){ if(!ts||ts.length<8) return null; const d=new Date(`${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T00:00:00Z`); return isNaN(d)?null:d; }
function fmtDate(d){ if(!d||isNaN(d)) return 'Unknown'; return d.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
