
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, 'runs-groq');

const fmt = d => new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'});
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const digitless = s => norm(s).replace(/[0-9]+/g,'#');
const words = s => norm(s).split(' ').filter(Boolean);

// Split page text into sentence-ish units; keep only contentful ones (6..45 words),
// drop nav/menu lines (mostly short Title-Case tokens separated by | or lots of caps).
function sentences(text){
  return String(text||'')
    .replace(/\s+/g,' ')
    .split(/(?<=[.!?])\s+|\s\|\s/)
    .map(s=>s.trim())
    .filter(s=>{ const w=words(s); return w.length>=6 && w.length<=45; })
    .filter(s=>!/^(home|menu|skip to|search|sections?:|read more|about|news)\b/i.test(s));
}
const usable = s => s.fullText && s.fullText.replace(/\s+/g,' ').trim().length >= 200;

// Heuristic auto-verdict (deterministic, human still confirms):
//  artifact = archive encoding noise, masked tokens, or copyright-year-only bumps.
const ARTIFACT_RE = /[�]|&#\d|&copy;|oldid=|index\.php|\[email\]|\[phone\]|\[email&#160;protected\]|\bprivacy policy\b/i;
const isCopyrightYear = (a,b) => /copyright|&copy;|\ball rights\b/i.test(a+b);
function suggest(c){
  const blob = `${c.before||''} ${c.after||''}`;
  if (ARTIFACT_RE.test(blob)) return 'artifact';
  if (c.type==='number_changed' && isCopyrightYear(c.before,c.after)) return 'artifact';
  if (c.type==='number_changed' && /\b(item|book|ebook|record|image|text|video|sound|journal|article|million|\d{3,})\b/i.test(blob)) return 'real';
  return '?';   // contentful add/remove — needs human eyes
}

const out = { _instructions:'Rule each candidate: verdict "real" (a genuine author edit) or "artifact" (archive noise / not a real change). Add any real change the diff MISSED as a row with source:"manual".', runs:{} };
const files = fs.readdirSync(SRC).filter(f=>/^\d+.*\.json$/.test(f)).sort();

for (const f of files){
  const r = JSON.parse(fs.readFileSync(path.join(SRC,f),'utf8'));
  const id = f.replace(/\.json$/,'');
  const snaps = r._rescore.snapshots.filter(usable);
  const cands = [];

  for (let i=1;i<snaps.length;i++){
    const A=snaps[i-1], B=snaps[i];
    const sa=sentences(A.fullText), sb=sentences(B.fullText);
    const setA=new Map(sa.map(s=>[norm(s),s])), setB=new Map(sb.map(s=>[norm(s),s]));
    const dlA=new Map(sa.map(s=>[digitless(s),s])), dlB=new Map(sb.map(s=>[digitless(s),s]));

    // number-only changes: same skeleton, different digits
    for (const [dk,sA] of dlA){
      const sB=dlB.get(dk);
      if (sB && norm(sA)!==norm(sB) && /[0-9]/.test(sA)){
        cands.push({type:'number_changed', from:fmt(A.date), to:fmt(B.date), before:sA.slice(0,160), after:sB.slice(0,160)});
      }
    }
    // additions: in B, not in A (and not a number-variant of an A line)
    for (const [k,s] of setB){ if(!setA.has(k) && !dlA.has(digitless(s)))
      cands.push({type:'added', from:fmt(A.date), to:fmt(B.date), before:null, after:s.slice(0,160)}); }
    // removals: in A, not in B
    for (const [k,s] of setA){ if(!setB.has(k) && !dlB.has(digitless(s)))
      cands.push({type:'removed', from:fmt(A.date), to:fmt(B.date), before:s.slice(0,160), after:null}); }
  }

  // dedupe by (type+after/before text); drop auto-artifacts; cap human task.
  const seen=new Set(); const uniq=[];
  for (const c of cands){ const key=c.type+'|'+norm(c.after||c.before); if(seen.has(key))continue; seen.add(key); c.verdict=suggest(c); uniq.push(c); }
  const kept = uniq.filter(c=>c.verdict!=='artifact');     // hide obvious archive noise
  kept.sort((a,b)=> (b.after||b.before||'').length-(a.after||a.before||'').length);
  const top = kept.slice(0,8).map((c,i)=>({n:i+1, ...c, source:'diff'}));
  const droppedArtifacts = uniq.length - kept.length;

  out.runs[id]={ url:r.url, snapshotsUsed:snaps.length, autoDroppedArtifacts:droppedArtifacts, candidates:top };
  console.log(`\n${id}  (${snaps.length} usable snaps, ${droppedArtifacts} junk auto-dropped) — ${top.length} to review`);
  top.forEach(c=>{
    const tag=c.type==='number_changed'?'NUM':c.type==='added'?'ADD':'DEL';
    console.log(`  [${c.n}] (${c.verdict==='real'?'likely REAL':'?'}) ${tag} ${c.from}→${c.to}`);
    if(c.before) console.log(`      - ${c.before.slice(0,120)}`);
    if(c.after)  console.log(`      + ${c.after.slice(0,120)}`);
  });
}

fs.writeFileSync(path.join(__dirname,'gold_candidates.json'), JSON.stringify(out,null,2));
console.log(`\nWrote gold_candidates.json — rule each "verdict": real | artifact`);
