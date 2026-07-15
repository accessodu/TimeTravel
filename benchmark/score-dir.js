
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, process.argv[2] || 'runs');

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const bigrams = t => { const b=[]; for(let i=0;i<t.length-1;i++) b.push(t[i]+' '+t[i+1]); return b; };
function containment(q, t){
  const nq=norm(q), nt=norm(t); if(!nq) return 1; if(!nt) return 0;
  if(nt.includes(nq)) return 1;
  const qb=bigrams(nq.split(' ')); if(!qb.length){ const ts=new Set(nt.split(' ')); const u=nq.split(' '); return u.filter(x=>ts.has(x)).length/u.length; }
  const tb=new Set(bigrams(nt.split(' '))); return qb.filter(x=>tb.has(x)).length/qb.length;
}
const fmtDate = d => new Date(d).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});
const NULLISH = v => v==null || /^(null|none|nil|undefined|n\/?a|na|—|-{1,2})$/i.test(String(v).trim());
const isNoOp = c => !NULLISH(c.beforeText) && !NULLISH(c.afterText) && norm(c.beforeText)===norm(c.afterText);

function loadRuns(){
  return fs.readdirSync(DIR).filter(f=>/^\d+.*\.json$/.test(f)).sort().map(f=>{
    return { id:f.replace(/\.json$/,''), r:JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8')) };
  });
}
function groundRun(r){
  const snaps = r._rescore?.snapshots || [];
  const byDate = {}; snaps.forEach(s=>{ byDate[fmtDate(s.date)] = s.fullText||''; });
  return (r.changes||[]).map(c=>{
    if (isNoOp(c)) return { c, noop:true };
    const sides = [];
    for (const [q,date] of [[c.beforeText,c.beforeDate],[c.afterText,c.afterDate]]){
      if (NULLISH(q)) { sides.push({absent:true}); continue; }
      const txt = byDate[date] ?? Object.values(byDate).join('\n');
      sides.push({absent:false, score: containment(q,txt)});
    }
    const present = sides.filter(s=>!s.absent);
    return { c, grounded: present.every(s=>s.score>=0.7), sides };
  });
}
const pct = x => x==null?'—':(100*x).toFixed(1)+'%';

const runs = loadRuns();
let nChanges=0,nQuotes=0,nHall=0; const states={},conf={},calib={high:[],medium:[],low:[]};
for(const {r} of runs){
  for(const x of groundRun(r)){
    if(x.noop) continue;
    nChanges++;
    x.sides.forEach(s=>{ if(!s.absent){ nQuotes++; if(s.score<0.7) nHall++; } });
    states[x.c.archivalState]=(states[x.c.archivalState]||0)+1;
    conf[x.c.confidence]=(conf[x.c.confidence]||0)+1;
    if(calib[x.c.confidence]) calib[x.c.confidence].push(x.grounded?1:0);
  }
}
console.log(`═══ OBJECTIVE METRICS — ${path.basename(DIR)} (${runs.length} runs) ═══`);
console.log(`changes: ${nChanges}   quotes checked: ${nQuotes}`);
console.log(`hallucinated-quote rate: ${nHall}/${nQuotes} = ${pct(nQuotes?nHall/nQuotes:null)}   → quote-grounding ${pct(nQuotes?1-nHall/nQuotes:null)}`);
console.log('archival states:', JSON.stringify(states));
console.log('confidence    :', JSON.stringify(conf));
console.log('calibration (mean quote-grounding by label):');
for(const k of ['high','medium','low']) if(calib[k]?.length)
  console.log(`   ${k.padEnd(6)}: ${pct(calib[k].reduce((a,b)=>a+b,0)/calib[k].length)} grounded  (n=${calib[k].length})`);
