#!/usr/bin/env node
'use strict';
/* TEMP ablation harness — re-runs saved snapshots through Groq with stages toggled.
 * Reads runs-groq/ (_rescore.snapshots), writes to $OUT (separate dir; never clobbers
 * runs-groq / runs-groq-gated). Env: SC_K (self-consistency K), NO_COVE=1 (skip verify),
 * OUT (output dir). Args: id prefixes (subset). */
const fs=require('fs'), path=require('path'), vm=require('vm');
const SRC_DIR=path.join(__dirname,'runs-groq');
const OUT_DIR=path.join(__dirname, process.env.OUT||'runs-ablate-tmp');
const BG=path.join(__dirname,'..','background','background.js');
const GROQ_KEY=process.env.GROQ_KEY||'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';

function loadBackground(){
  const deep=new Proxy(function(){},{get:()=>deep,apply:()=>deep});
  const self={};
  const sandbox={self,chrome:deep,importScripts:()=>{},fetch:globalThis.fetch,console,
    setTimeout,clearTimeout,URL,Math,Date,JSON};
  sandbox.globalThis=sandbox; vm.createContext(sandbox);
  let src=fs.readFileSync(BG,'utf8').replace(/^'use strict';\s*/,'');
  if(process.env.SC_K) src=src.replace(/const SELF_CONSISTENCY_K\s*=\s*\d+;/,`const SELF_CONSISTENCY_K = ${parseInt(process.env.SC_K)};`);
  if(process.env.NO_COVE) src=src.replace('verified = extractJson(await callAI({provider, model, apiKey, prompt: verifyPrompt, temperature: 0.2}))','verified = null /* CoVe ablation: skip verify pass */');
  src+='\nglobalThis.__bg={classifyWithAI,buildReport,focusExtract,fmtDate,contentUsable};';
  vm.runInContext(src,sandbox,{filename:'background.js'});
  self.__AI_PROVIDER__='groq'; self.__AI_KEY__=GROQ_KEY;
  return sandbox.__bg;
}
async function rerunOne(bg,file){
  const src=JSON.parse(fs.readFileSync(path.join(SRC_DIR,file),'utf8'));
  const rb=src._rescore;
  if(!rb||!Array.isArray(rb.snapshots)) throw new Error('no _rescore.snapshots');
  const {url,fromYear,toYear,focus=''}=rb.params;
  const snaps=rb.snapshots.map(s=>({...s,date:new Date(s.date),text:bg.focusExtract(s.fullText||'',focus)}));
  const ai=await bg.classifyWithAI(snaps,url,focus,'groq',GROQ_KEY,null,null);
  const report=bg.buildReport(snaps,snaps,snaps,snaps,ai,{url,fromYear,toYear,focus});
  fs.writeFileSync(path.join(OUT_DIR,file),JSON.stringify(report,null,2));
  console.log(`  ${file.padEnd(18)} → ${(report.changes||[]).length} changes  (K=${report.selfConsistencySamples}, cove=${report.coveApplied})`);
}
(async()=>{
  fs.mkdirSync(OUT_DIR,{recursive:true});
  const bg=loadBackground();
  const filter=process.argv.slice(2);
  const files=fs.readdirSync(SRC_DIR).filter(f=>/^\d+.*\.json$/.test(f)).filter(f=>!filter.length||filter.some(p=>f.startsWith(p))).sort();
  console.log(`config: SC_K=${process.env.SC_K||'default'} NO_COVE=${process.env.NO_COVE||'0'} OUT=${OUT_DIR}`);
  for(const f of files){ try{await rerunOne(bg,f);}catch(e){console.log(`  ${f.padEnd(18)} ✗ ${e.message}`);} }
  console.log('done');
})();
