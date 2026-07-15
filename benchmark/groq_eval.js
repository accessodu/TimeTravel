
const gold = require('./gold_truth.json').runs;

const GENRE = {
  '01-jcdl':'Conference sites','07-sigir':'Conference sites',
  '02-dlib':'DL & archives','03-gutenberg':'DL & archives','04-archive':'DL & archives',
  '05-dp':'DL & archives','06-europeana':'DL & archives','10-loc':'DL & archives',
  '12-ndltd':'DL & archives','15-hathitrust':'DL & archives',
  '08-w3':'Standards & policy','09-openai':'Standards & policy','13-ada':'Standards & policy',
  '11-crossref':'Scholarly infra','14-plos':'Scholarly infra','16-doaj':'Scholarly infra',
};

// Groq predictions: verdict 'TP' (real) | 'FP' (junk); gold = index of covered gold change (0-based) or null.
const PRED = {
  '01-jcdl':      [{v:'TP',gold:0},{v:'TP',gold:0},{v:'TP',gold:0}],         // all 3 cover conf-rollover (G1)
  '02-dlib':      [{v:'TP',gold:0},{v:'FP',gold:null}],                      // suspension TP; email = artifact
  '03-gutenberg': [],                                                         // Groq found nothing
  '04-archive':   [{v:'FP',gold:null},{v:'FP',gold:null}],                   // garbled nav + low artifact
  '05-dp':        [{v:'TP',gold:0}],                                         // item count grew (G1)
  '06-europeana': [{v:'TP',gold:0}],                                         // tagline (G1)
  '07-sigir':     [{v:'FP',gold:null},{v:'TP',gold:3}],                       // Forum2020=news(FP); Early-Career=TP (gold 3, added on re-verify)
  '08-w3':        [{v:'FP',gold:null}],                                      // before≈after, no real edit
  '09-openai':    [{v:'FP',gold:null},{v:'FP',gold:null}],                   // ungrounded
  '10-loc':       [{v:'FP',gold:null}],                                      // nav noise
  '11-crossref':  [{v:'TP',gold:0}],                                         // documentation rename (G1)
  '12-ndltd':     [],                                                         // Groq found nothing
  '13-ada':       [{v:'TP',gold:1},{v:'FP',gold:null}],                      // New-on-ADA = redesign (G2); dup = junk
  '14-plos':      [{v:'TP',gold:1}],                                         // COVID updates (G2)
  '15-hathitrust':[],                                                         // Groq found nothing
  '16-doaj':      [{v:'TP',gold:0},{v:'TP',gold:1}],                         // funding model (G1) + cookie (G2)
};

function wilson(k,n){
  if(!n) return [null,null];
  const z=1.96, p=k/n, z2=z*z;
  const c=(p+z2/(2*n))/(1+z2/n);
  const m=z/(1+z2/n)*Math.sqrt(p*(1-p)/n + z2/(4*n*n));
  return [Math.max(0,c-m), Math.min(1,c+m)];
}
const pct=x=>x==null?'—':(100*x).toFixed(1)+'%';

let TP=0,FP=0,goldTotal=0,goldHit=0;
const G={};
for(const id of Object.keys(gold)){
  const g=GENRE[id]; G[g]=G[g]||{TP:0,FP:0,gold:0,hit:0};
  const preds=PRED[id]||[];
  const nGold=gold[id].realChanges.length;
  goldTotal+=nGold; G[g].gold+=nGold;
  const covered=new Set();
  for(const p of preds){
    if(p.v==='TP'){TP++;G[g].TP++;} else {FP++;G[g].FP++;}
    if(p.v==='TP'&&p.gold!=null) covered.add(p.gold);
  }
  goldHit+=covered.size; G[g].hit+=covered.size;
}
const P=TP/(TP+FP), R=goldHit/goldTotal, F1=2*P*R/(P+R);
const [pl,ph]=wilson(TP,TP+FP), [rl,rh]=wilson(goldHit,goldTotal);

console.log('═══ GROQ llama-3.1-8b-instant — detection vs gold standard ═══');
console.log(`predictions: ${TP+FP}   real(TP): ${TP}   junk(FP): ${FP}`);
console.log(`gold changes: ${goldTotal}   covered: ${goldHit}   missed(FN): ${goldTotal-goldHit}`);
console.log('');
console.log(`Precision = ${TP}/${TP+FP} = ${pct(P)}   (Wilson 95% CI ${pct(pl)}–${pct(ph)})`);
console.log(`Recall    = ${goldHit}/${goldTotal} = ${pct(R)}   (Wilson 95% CI ${pct(rl)}–${pct(rh)})`);
console.log(`F1        = ${pct(F1)}`);
console.log('\nper genre:');
for(const [g,v] of Object.entries(G)){
  const p=v.TP+v.FP?v.TP/(v.TP+v.FP):null, r=v.gold?v.hit/v.gold:null;
  console.log(`  ${g.padEnd(20)} P=${pct(p).padEnd(7)} (${v.TP}/${v.TP+v.FP})   R=${pct(r).padEnd(7)} (${v.hit}/${v.gold})`);
}
