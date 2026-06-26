#!/usr/bin/env node
'use strict';
/* W2 re-run: replay the saved benchmark snapshots through the DEPLOYED Groq 8B
 * back-end (llama-3.1-8b-instant), instead of the OpenAI gpt-4o-mini used in the
 * paper. Addresses Reviewer R2's W2 ("headline numbers from a model users will
 * never run"). No Wayback re-fetch — it reuses each run's saved _rescore.snapshots
 * (identical text the cloud model saw), so this is a true model-for-model swap.
 *
 *   node rerun-groq.js            → re-run all runs/NN-*.json into runs-groq/
 *   node rerun-groq.js 02 09      → re-run only the matching ids (smoke subset)
 *
 * Then score with:  node score-dir.js runs-groq
 */
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC_DIR = path.join(__dirname, 'runs');
const OUT_DIR = path.join(__dirname, 'runs-groq');
const BG      = path.join(__dirname, '..', 'background', 'background.js');

// Groq key from the gitignored secret file's commented fallback. Local only.
const GROQ_KEY = process.env.GROQ_KEY;

/* ── Load background.js into a sandbox and expose the pure functions ─────── */
function loadBackground() {
  // Deep self-returning proxy: chrome.a.b.c(...) resolves at any depth to a no-op.
  const deep = new Proxy(function(){}, { get: () => deep, apply: () => deep });
  const chromeStub = deep;
  const self = {};
  const sandbox = {
    self, chrome: chromeStub, importScripts: () => {},
    fetch: globalThis.fetch, console,
    setTimeout, clearTimeout, URL, Math, Date, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let src = fs.readFileSync(BG, 'utf8').replace(/^'use strict';\s*/, '');
  // Export the functions we need out of the script's top-level scope.
  src += '\nglobalThis.__bg = { classifyWithAI, buildReport, focusExtract, fmtDate, contentUsable };';
  vm.runInContext(src, sandbox, { filename: 'background.js' });
  // Authoritative provider override (wins inside classifyWithAI).
  self.__AI_PROVIDER__ = 'groq';
  self.__AI_KEY__      = GROQ_KEY;
  return sandbox.__bg;
}

async function rerunOne(bg, file) {
  const src = JSON.parse(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'));
  const rb  = src._rescore;
  if (!rb || !Array.isArray(rb.snapshots)) throw new Error(`${file}: no _rescore.snapshots`);
  const { url, fromYear, toYear, focus = '' } = rb.params;

  // Reconstruct the snapshot objects the pipeline expects: dates back to Date,
  // and the AI-prompt `text` re-derived from fullText exactly as analyze() did.
  const snaps = rb.snapshots.map(s => ({
    ...s,
    date: new Date(s.date),
    text: bg.focusExtract(s.fullText || '', focus),
  }));

  const ai = await bg.classifyWithAI(snaps, url, focus, 'groq', GROQ_KEY, null, null);
  const params = { url, fromYear, toYear, focus };
  // all / unique / selected only feed counts + gaps; snaps stands in for each.
  const report = bg.buildReport(snaps, snaps, snaps, snaps, ai, params);
  report.backend = 'groq:llama-3.1-8b-instant';

  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(report, null, 2));
  const n = (report.changes || []).length;
  const samples = report.selfConsistencySamples;
  console.log(`  ${file.padEnd(18)} → ${n} changes  (K=${samples}, cove=${report.coveApplied})`);
  return report;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const bg = loadBackground();
  const filter = process.argv.slice(2);
  const files = fs.readdirSync(SRC_DIR)
    .filter(f => /^\d+.*\.json$/.test(f))
    .filter(f => !filter.length || filter.some(p => f.startsWith(p)))
    .sort();

  console.log(`Re-running ${files.length} run(s) on Groq llama-3.1-8b-instant …\n`);
  for (const f of files) {
    try { await rerunOne(bg, f); }
    catch (e) { console.log(`  ${f.padEnd(18)} ✗ ${e.message}`); }
  }
  console.log(`\nDone → ${OUT_DIR}\nScore with:  node score-dir.js runs-groq`);
})();
