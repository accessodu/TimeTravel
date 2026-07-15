
const fs=require('fs'), path=require('path');
const gold=require('./gold_truth.json').runs;
const GENRE={'01-jcdl':'Conf','07-sigir':'Conf','02-dlib':'DL','03-gutenberg':'DL','04-archive':'DL','05-dp':'DL','06-europeana':'DL','10-loc':'DL','12-ndltd':'DL','15-hathitrust':'DL','08-w3':'Std','09-openai':'Std','13-ada':'Std','11-crossref':'Schol','14-plos':'Schol','16-doaj':'Schol'};

// Ungated predictions (verdict + covered gold index or null).
const UNGATED={
 '01-jcdl':[['TP',0],['TP',0],['TP',0]],'02-dlib':[['TP',0],['FP',null]],'03-gutenberg':[],
 '04-archive':[['FP',null],['FP',null]],'05-dp':[['TP',0]],'06-europeana':[['TP',0]],
 '07-sigir':[['FP',null],['TP',3]],'08-w3':[['FP',null]],'09-openai':[['FP',null],['FP',null]],
 '10-loc':[['FP',null]],'11-crossref':[['TP',0]],'12-ndltd':[],'13-ada':[['TP',1],['FP',null]],
 '14-plos':[['TP',1]],'15-hathitrust':[],'16-doaj':[['TP',0],['TP',1]],
};
// Which ungated predictions survive the gate, in file order. Derived from regate diff:
// dropped: 04-archive[idx1], 09-openai[both], 10-loc[0], 11-crossref[0].
const GATE_DROP={'04-archive':[1],'09-openai':[0,1],'10-loc':[0],'11-crossref':[0]};

function count(dir,id){const f=path.join(__dirname,dir,id+'.json');return JSON.parse(fs.readFileSync(f,'utf8')).changes.length;}
function wilson(k,n){if(!n)return[null,null];const z=1.96,p=k/n,z2=z*z;const c=(p+z2/(2*n))/(1+z2/n);const m=z/(1+z2/n)*Math.sqrt(p*(1-p)/n+z2/(4*n*n));return[Math.max(0,c-m),Math.min(1,c+m)];}
const pct=x=>x==null?'—':(100*x).toFixed(1)+'%';

console.log('=== INTEGRITY: predictions vs actual change counts ===');
let ok=true;
for(const id of Object.keys(gold)){
  const pred=(UNGATED[id]||[]).length, ung=count('runs-groq',id), gat=count('runs-groq-gated',id);
  const drop=(GATE_DROP[id]||[]).length, gatedPred=pred-drop;
  const m1=pred===ung, m2=gatedPred===gat;
  if(!m1||!m2){ok=false; console.log(`  MISMATCH ${id}: pred=${pred} file_ungated=${ung} ${m1?'':'<-X'} | gatedPred=${gatedPred} file_gated=${gat} ${m2?'':'<-X'}`);}
}
console.log(ok?'  ALL MATCH ✓':'  *** MISMATCHES ABOVE ***');

function score(useGate){
  const G={}, all={TP:0,FP:0,gt:0,hit:0};
  for(const id of Object.keys(gold)){
    const g=GENRE[id]; G[g]=G[g]||{TP:0,FP:0,gt:0,hit:0};
    const nGold=gold[id].realChanges.length; G[g].gt+=nGold; all.gt+=nGold;
    const drop=new Set(useGate?(GATE_DROP[id]||[]):[]);
    const cov=new Set();
    (UNGATED[id]||[]).forEach(([v,gi],i)=>{
      if(drop.has(i))return;
      if(v==='TP'){G[g].TP++;all.TP++; if(gi!=null)cov.add(gi);} else {G[g].FP++;all.FP++;}
    });
    G[g].hit+=cov.size; all.hit+=cov.size;
  }
  return {G,all};
}
function show(label,useGate){
  const {G,all}=score(useGate);
  const P=all.TP/(all.TP+all.FP),R=all.hit/all.gt,F1=2*P*R/(P+R);
  const[pl,ph]=wilson(all.TP,all.TP+all.FP),[rl,rh]=wilson(all.hit,all.gt);
  console.log(`\n=== ${label} ===`);
  console.log(`TP=${all.TP} FP=${all.FP} predictions=${all.TP+all.FP} | gold=${all.gt} covered=${all.hit} FN=${all.gt-all.hit}`);
  console.log(`Precision=${all.TP}/${all.TP+all.FP}=${pct(P)} [${pct(pl)}-${pct(ph)}]  Recall=${all.hit}/${all.gt}=${pct(R)} [${pct(rl)}-${pct(rh)}]  F1=${pct(F1)}`);
  for(const[g,v]of Object.entries(G)){const p=v.TP+v.FP?v.TP/(v.TP+v.FP):null,r=v.gt?v.hit/v.gt:null;
    console.log(`  ${g.padEnd(6)} P=${pct(p).padEnd(7)}(${v.TP}/${v.TP+v.FP}) R=${pct(r).padEnd(7)}(${v.hit}/${v.gt})`);}
}
show('UNGATED detection',false);
show('GATED detection (shipped)',true);
