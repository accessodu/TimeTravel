#!/usr/bin/env node
'use strict';
/* TimeTravel-A11y benchmark scorer.
 *
 *   node score.js init     → (re)generate ground_truth.json scaffold from the runs
 *   node score.js          → compute metrics (objective always; detection P/R once
 *                            ground_truth.json labels are filled in)
 *
 * OBJECTIVE metrics (need no human labels): quote-grounding / hallucination rate,
 * archival-state distribution, confidence distribution + calibration, a11y audit.
 * These are recomputed straight from each run's _rescore bundle (raw model changes
 * + archived snapshot texts) so they are reproducible from the saved JSON alone.
 *
 * DETECTION metrics (precision / recall / F1, per genre) need the human-confirmed
 * labels in ground_truth.json: each detected change marked TP or FP, plus any
 * missed real changes (FN) added per page.
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, process.argv[2] || 'runs');
const GT  = path.join(__dirname, 'ground_truth.json');

/* ── genre map (edit freely; drives the per-genre detection table) ──────── */
const GENRE = {
  '01-jcdl':'Conference sites', '07-sigir':'Conference sites',
  '02-dlib':'Digital libraries & archives', '03-gutenberg':'Digital libraries & archives',
  '04-archive':'Digital libraries & archives', '05-dp':'Digital libraries & archives',
  '06-europeana':'Digital libraries & archives', '10-loc':'Digital libraries & archives',
  '12-ndltd':'Digital libraries & archives', '15-hathitrust':'Digital libraries & archives',
  '08-w3':'Standards & policy', '09-openai':'Standards & policy', '13-ada':'Standards & policy',
  '11-crossref':'Scholarly infrastructure', '14-plos':'Scholarly infrastructure',
  '16-doaj':'Scholarly infrastructure',
};

/* ── quote grounding (mirrors background.js verifyQuote, deterministic) ──── */
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const bigrams = t => { const b=[]; for(let i=0;i<t.length-1;i++) b.push(t[i]+' '+t[i+1]); return b; };
function containment(q, t){
  const nq=norm(q), nt=norm(t); if(!nq) return 1; if(!nt) return 0;
  if(nt.includes(nq)) return 1;
  const qb=bigrams(nq.split(' ')); if(!qb.length){ const ts=new Set(nt.split(' ')); const u=nq.split(' '); return u.filter(x=>ts.has(x)).length/u.length; }
  const tb=new Set(bigrams(nt.split(' '))); return qb.filter(x=>tb.has(x)).length/qb.length;
}
// MUST match background.js fmtDate (UTC) or change dates won't line up with
// snapshot dates and grounding silently falls back to "any capture".
const fmtDate = d => new Date(d).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});
const NULLISH = v => v==null || /^(null|none|nil|undefined|n\/?a|na|—|-{1,2})$/i.test(String(v).trim());
/* No-op = before == after; the corrected pipeline drops these, so re-scoring the
   saved bundles applies the same filter (FP #1 / 14-plos). */
const isNoOp = c => !NULLISH(c.beforeText) && !NULLISH(c.afterText) && norm(c.beforeText)===norm(c.afterText);

function loadRuns(){
  return fs.readdirSync(DIR).filter(f=>/^\d+.*\.json$/.test(f)).sort().map(f=>{
    const r = JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8'));
    return { id:f.replace(/\.json$/,''), file:f, r };
  });
}

/* Recompute, from the snapshot texts, whether each non-null quote is grounded. */
function groundRun(r){
  const snaps = r._rescore?.snapshots || [];
  const byDate = {}; snaps.forEach(s=>{ byDate[fmtDate(s.date)] = s.fullText||''; });
  return (r.changes||[]).map(c=>{
    if (isNoOp(c)) return { c, noop:true };
    const sides = [];
    for (const [q,date] of [[c.beforeText,c.beforeDate],[c.afterText,c.afterDate]]){
      if (NULLISH(q)) { sides.push({absent:true}); continue; }
      const txt = byDate[date] ?? Object.values(byDate).join('\n'); // fall back to any capture
      sides.push({absent:false, score: containment(q,txt)});
    }
    const present = sides.filter(s=>!s.absent);
    const grounded = present.every(s=>s.score>=0.7);
    const hallucinated = present.some(s=>s.score<0.7);
    return { c, grounded, hallucinated, sides };
  });
}

function objective(runs){
  let nChanges=0, nQuotes=0, nHall=0;
  const states={}, conf={}, calib={high:[],medium:[],low:[]};
  let a11yPages=0, a11yImproved=0, a11yDecreased=0, a11yFlat=0;
  for(const {r} of runs){
    const g = groundRun(r);
    for(const x of g){
      if(x.noop) continue;   // dropped by the corrected pipeline
      nChanges++;
      x.sides.forEach(s=>{ if(!s.absent){ nQuotes++; if(s.score<0.7) nHall++; } });
      states[x.c.archivalState]=(states[x.c.archivalState]||0)+1;
      conf[x.c.confidence]=(conf[x.c.confidence]||0)+1;
      if(calib[x.c.confidence]) calib[x.c.confidence].push(x.grounded?1:0);
    }
    if(r.a11yAudit){ a11yPages++;
      const v=(r.a11yAudit.verdict||r.a11yAudit.summary||'').toLowerCase();
      const worse=(r.a11yAudit.deltas||[]).filter(d=>d.direction==='worse').length;
      const better=(r.a11yAudit.deltas||[]).filter(d=>d.direction==='better').length;
      if(better>worse) a11yImproved++; else if(worse>better) a11yDecreased++; else a11yFlat++;
    }
  }
  return {nChanges,nQuotes,nHall,states,conf,calib,a11yPages,a11yImproved,a11yDecreased,a11yFlat};
}

function detection(runs, gt){
  // gt[id] = { changes:[{label:'TP'|'FP'}], missed:N }
  const perGenre={};
  let TP=0,FP=0,FN=0, labeled=0, totalDetected=0;
  for(const {id,r} of runs){
    const g = gt[id];
    const noop = (r.changes||[]).map(isNoOp);
    totalDetected += noop.filter(x=>!x).length;        // exclude dropped no-ops
    if(!g || !Array.isArray(g.changes)) continue;
    const genre = GENRE[id]||'Other';
    perGenre[genre] = perGenre[genre]||{TP:0,FP:0,FN:0};
    g.changes.forEach((c,idx)=>{
      if(noop[idx]) return;                            // change no longer reported
      const L=(c.label||'').toUpperCase();
      if(L==='TP'){TP++;perGenre[genre].TP++;labeled++;}
      else if(L==='FP'){FP++;perGenre[genre].FP++;labeled++;}
    });
    const fn = Number(g.missed||0); FN+=fn; perGenre[genre].FN+=fn;
  }
  const P = TP+FP? TP/(TP+FP):null, R = TP+FN? TP/(TP+FN):null;
  const F1 = (P&&R)? 2*P*R/(P+R):null;
  return {TP,FP,FN,P,R,F1,perGenre,labeled,totalDetected};
}

function pct(x){ return x==null?'—':(100*x).toFixed(1)+'%'; }

function report(){
  const runs = loadRuns();
  const o = objective(runs);
  console.log('═══ OBJECTIVE METRICS (no labels needed) ═══');
  console.log(`runs: ${runs.length}   changes: ${o.nChanges}   quotes checked: ${o.nQuotes}`);
  console.log(`hallucinated-quote rate: ${o.nHall}/${o.nQuotes} = ${pct(o.nHall/o.nQuotes)}   → quote-grounding ${pct(1-o.nHall/o.nQuotes)}`);
  console.log('archival states:', JSON.stringify(o.states));
  console.log('confidence    :', JSON.stringify(o.conf));
  console.log('calibration (mean quote-grounding by label):');
  for(const k of ['high','medium','low']) if(o.calib[k]?.length)
    console.log(`   ${k.padEnd(6)}: ${pct(o.calib[k].reduce((a,b)=>a+b,0)/o.calib[k].length)} grounded  (n=${o.calib[k].length})`);
  console.log(`a11y audits: ${o.a11yPages} pages  →  improved ${o.a11yImproved} · decreased ${o.a11yDecreased} · flat ${o.a11yFlat}`);

  let gt=null; try{ gt=JSON.parse(fs.readFileSync(GT,'utf8')); }catch{}
  console.log('\n═══ DETECTION METRICS (need ground_truth.json labels) ═══');
  if(!gt){ console.log('No ground_truth.json yet. Run:  node score.js init'); return; }
  const d = detection(runs, gt.runs||gt);
  if(!d.labeled){ console.log(`ground_truth.json present but 0 labels filled (TP/FP). ${d.totalDetected} changes await labeling.`); return; }
  console.log(`labeled ${d.labeled}/${d.totalDetected} detected changes`);
  console.log(`TP=${d.TP}  FP=${d.FP}  FN=${d.FN}`);
  console.log(`Precision=${pct(d.P)}  Recall=${pct(d.R)}  F1=${pct(d.F1)}`);
  console.log('per genre:');
  for(const [genre,v] of Object.entries(d.perGenre)){
    const p=v.TP+v.FP?v.TP/(v.TP+v.FP):null, r=v.TP+v.FN?v.TP/(v.TP+v.FN):null;
    console.log(`   ${genre.padEnd(30)} TP=${v.TP} FP=${v.FP} FN=${v.FN}  P=${pct(p)} R=${pct(r)}`);
  }
}

function init(){
  const runs = loadRuns();
  const out = { _instructions:'For each change set label to "TP" (real, focus-relevant change) or "FP" (artifact / not real / off-focus), using the quotes + grounded flag as evidence. Set missed = number of real focus-area changes the system did NOT report (FN) for that page.', runs:{} };
  for(const {id,r} of runs){
    const g = groundRun(r);
    out.runs[id] = {
      url:r.url, genre:GENRE[id]||'Other', focus:r.focus||'',
      missed:0,
      changes: g.map((x,i)=>({
        n:i+1, label:'?', // ← fill TP or FP
        archivalState:x.c.archivalState, confidence:`${x.c.confidence}(${x.c.confidenceScore})`,
        grounded:x.grounded, hallucinated:x.hallucinated,
        description:x.c.description,
        before:(x.c.beforeText??null), after:(x.c.afterText??null),
      })),
    };
  }
  fs.writeFileSync(GT, JSON.stringify(out,null,2));
  console.log(`wrote ${GT} — ${Object.keys(out.runs).length} runs scaffolded. Fill label:"TP"/"FP" and missed:N, then run: node score.js`);
}

if(process.argv[2]==='init') init(); else report();
