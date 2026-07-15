
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'runs-groq');
const OUT = path.join(__dirname, 'runs-groq-gated');
const BG  = path.join(__dirname, '..', 'background', 'background.js');

function loadBackground(){
  const deep = new Proxy(function(){}, { get:()=>deep, apply:()=>deep });
  const self = {};
  const sandbox = { self, chrome:deep, importScripts:()=>{}, fetch:globalThis.fetch, console,
    setTimeout, clearTimeout, URL, Math, Date, JSON };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let src = fs.readFileSync(BG,'utf8').replace(/^'use strict';\s*/,'');
  src += '\nglobalThis.__bg = { buildReport, focusExtract };';
  vm.runInContext(src, sandbox, { filename:'background.js' });
  return sandbox.__bg;
}

fs.mkdirSync(OUT,{recursive:true});
const bg = loadBackground();
let before=0, after=0;
for (const f of fs.readdirSync(SRC).filter(f=>/^\d+.*\.json$/.test(f)).sort()){
  const r = JSON.parse(fs.readFileSync(path.join(SRC,f),'utf8'));
  const rb = r._rescore;
  const { url, fromYear, toYear, focus='' } = rb.params;
  const snaps = rb.snapshots.map(s=>({ ...s, date:new Date(s.date), text:bg.focusExtract(s.fullText||'',focus) }));
  const ai = rb.ai;                                  // saved Groq output — no re-call
  const rep = bg.buildReport(snaps, snaps, snaps, snaps, ai, { url, fromYear, toYear, focus });
  rep.backend = 'groq:llama-3.1-8b-instant+verbatim-gate';
  fs.writeFileSync(path.join(OUT,f), JSON.stringify(rep,null,2));
  const b=(r.changes||[]).length, a=(rep.changes||[]).length; before+=b; after+=a;
  console.log(`  ${f.padEnd(18)} ${b} -> ${a} changes${a<b?`  (dropped ${b-a})`:''}`);
}
console.log(`\nTotal changes: ${before} -> ${after}  (gate dropped ${before-after})`);
console.log('Score: node score-dir.js runs-groq-gated');
