(function () {
  'use strict';
  // If already loaded, just toggle — don't re-run setup
  if (window.__ttA11yLoaded) {
    window.__ttA11yToggle && window.__ttA11yToggle();
    return;
  }
  window.__ttA11yLoaded = true;

  const IS_MAC = /mac/i.test(navigator.platform);
  const TOGGLE_LABEL = IS_MAC ? '⌥⇧T' : 'Alt+Shift+T';

  /* ── State ─────────────────────────────────────────────────────── */
  const S = {
    open: false,
    report: null,
    activeChange: null,   // currently focused change object
    changeIdx: -1,
    lastSpoken: '',
    analyzing: false,
    ttsEnabled: false,    // OFF by default — a screen reader is the primary voice
  };

  let host, shadow;
  let previousFocus = null;  // element to restore focus to when overlay closes

  /* ── Shortcuts registry ─────────────────────────────────────────── */
  const SHORTCUTS = [
    {key:'1',group:'Listen',   label:'Overview (Level 1)',            fn:()=>speakLevel(1)},
    {key:'2',group:'Listen',   label:'Change list (Level 2)',         fn:()=>speakLevel(2)},
    {key:'3',group:'Listen',   label:'Evidence for active change',    fn:()=>speakLevel(3)},
    {key:'4',group:'Listen',   label:'Uncertainty report (Level 4)',  fn:()=>speakLevel(4)},
    {key:'5',group:'Listen',   label:'Replay warnings (Level 5)',     fn:()=>speakLevel(5)},
    {key:'n',group:'Navigate', label:'Next change',                   fn:()=>stepChange(1)},
    {key:'p',group:'Navigate', label:'Previous change',               fn:()=>stepChange(-1)},
    {key:'y',group:'Navigate', label:'Jump to year',                  fn:()=>jumpToYear()},
    {key:'b',group:'Evidence', label:'Before capture text',           fn:()=>hearBefore()},
    {key:'a',group:'Evidence', label:'After capture text',            fn:()=>hearAfter()},
    {key:'e',group:'Evidence', label:'Full evidence for this change', fn:()=>hearEvidence()},
    {key:'o',group:'Open',     label:'Open before capture in tab',    fn:()=>openBefore()},
    {key:'k',group:'Open',     label:'Open after capture in tab',     fn:()=>openAfter()},
    {key:'m',group:'Open',     label:'Open all key snapshots',        fn:()=>openKeySnaps()},
    {key:'s',group:'Speech',   label:'Speak full report aloud',       fn:()=>speakFullReport()},
    {key:'x',group:'Speech',   label:'Stop speaking',                 fn:()=>stopSpeaking()},
    {key:'0',group:'Speech',   label:'Repeat last speech',            fn:()=>speak(S.lastSpoken)},
    {key:'c',group:'Export',   label:'Copy report to clipboard',      fn:()=>copyReport()},
    {key:'d',group:'Export',   label:'Download report as .txt',       fn:()=>downloadReport()},
    {key:'j',group:'Export',   label:'Download data as .json (re-scorable)', fn:()=>downloadReportJson()},
    {key:'r',group:'Control',  label:'Re-run analysis',               fn:()=>triggerAnalyze()},
    {key:'h',group:'Control',  label:'Keyboard help',                 fn:()=>showHelp()},
  ];

  // All app shortcuts use Alt (⌥ on Mac) so they survive the screen
  // reader's single-key browse-mode quick-nav (H=heading, B=button, etc.)
  const ALT = IS_MAC ? '⌥' : 'Alt+';
  const combo = (k) => ALT + k.toUpperCase();
  function codeToKey(code) {
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Key'))   return code.slice(3).toLowerCase();
    return '';
  }

  /* ── Shadow DOM bootstrap ───────────────────────────────────────── */
  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'tt-a11y-host';
    host.style.cssText = 'all:unset;position:fixed;top:0;left:0;z-index:2147483647;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({mode:'open'});
    shadow.innerHTML = `<style>${CSS}</style><div id="root"></div>`;
  }

  function toggleOverlay() {
    mount();
    S.open = !S.open;
    if (S.open) {
      previousFocus = document.activeElement;  // remember where to return focus
      renderShell();
      setTimeout(()=> { (shadow.getElementById('urlInput')||shadow.getElementById('analyzeBtn'))?.focus(); }, 60);
    } else {
      shadow.getElementById('root').innerHTML = '';
      stopSpeaking();
      // Return focus to the page element that had it before we opened
      try { previousFocus?.focus?.(); } catch {}
    }
  }

  // Expose for re-injection calls
  window.__ttA11yToggle = toggleOverlay;

  /* ── Shell (persistent structure) ───────────────────────────────── */
  function renderShell() {
    const NOW_YEAR = new Date().getFullYear();
    shadow.getElementById('root').innerHTML = `
      <div id="backdrop" aria-hidden="true"></div>
      <div id="panel" role="dialog" aria-modal="true"
           aria-label="TimeTravel-A11y — Temporal Forensics for Web Archives">

        <!-- Header -->
        <header id="hdr">
          <div id="hdr-left">
            <span aria-hidden="true" class="logo-clock">⏱</span>
            <span class="logo">TimeTravel<span class="logo-hi">-A11y</span></span>
            <span class="logo-sub">Temporal Forensics</span>
          </div>
          <div id="hdr-right">
            <button class="icon-btn" id="helpBtn" aria-label="Keyboard shortcuts. Press Alt H." title="${combo('h')}">?</button>
            <button class="icon-btn" id="closeBtn" aria-label="Close overlay. Press Escape." title="Esc">✕</button>
          </div>
        </header>

        <!-- Hint -->
        <div id="hint" aria-hidden="true">
          <kbd>${TOGGLE_LABEL}</kbd> or <kbd>Esc</kbd> to close ·
          <kbd>${combo('h')}</kbd> help · <kbd>${combo('n')}</kbd>/<kbd>${combo('p')}</kbd> navigate changes
        </div>

        <!-- Input form -->
        <form id="queryForm" aria-label="Archive query">
          <div id="form-row1">
            <div class="fg" id="fg-url">
              <label for="urlInput">URL <span class="opt">(or several, one per line)</span></label>
              <textarea id="urlInput" rows="1" placeholder="https://example.com"
                     spellcheck="false" autocomplete="url"></textarea>
            </div>
            <div class="fg" id="fg-from">
              <label for="fromYear">From <span class="opt">(year)</span></label>
              <input id="fromYear" type="number" min="1996" max="${NOW_YEAR}"
                     placeholder="1996" inputmode="numeric"
                     aria-describedby="yearHelp"/>
            </div>
            <div class="fg" id="fg-to">
              <label for="toYear">To <span class="opt">(year)</span></label>
              <input id="toYear" type="number" min="1996" max="${NOW_YEAR}"
                     placeholder="${NOW_YEAR}" inputmode="numeric"
                     aria-describedby="yearHelp"/>
            </div>
          </div>
          <div id="form-row2">
            <div class="fg" id="fg-focus">
              <label for="focusInput">Focus <span class="opt">(optional)</span></label>
              <input id="focusInput" type="text"
                     placeholder="e.g. GRE requirement, admission deadline, mask policy…"
                     autocomplete="off"/>
            </div>
            <button id="analyzeBtn" type="button">Analyze Archive</button>
          </div>
          <div id="form-row3">
            <label class="check-label">
              <input type="checkbox" id="maskPii" checked/>
              <span>Mask personal data (phones, emails, IDs)</span>
            </label>
            <label class="check-label">
              <input type="checkbox" id="ttsToggle"/>
              <span>🔊 Read changes aloud with built-in voice (turn off if a screen reader is already speaking)</span>
            </label>
          </div>
          <p id="yearHelp" class="collection-hint">Years are your choice: enter any range from 1996 to ${NOW_YEAR}. Leave a field blank to use the full archive (from 1996, to ${NOW_YEAR}).</p>
          <p id="form-hint" class="collection-hint">Tip: paste multiple URLs (one per line) for collection mode. Shortcuts use ${ALT}key so they don't clash with your screen reader.</p>
        </form>

        <!-- Live regions -->
        <div id="sr-status" role="status"  aria-live="polite"    aria-atomic="true" class="sr-only"></div>
        <div id="sr-alert"  role="alert"   aria-live="assertive" aria-atomic="true" class="sr-only"></div>

        <!-- Main content area -->
        <div id="main">
          <!-- Progress panel -->
          <div id="progress-panel" hidden aria-label="Analysis progress">
            ${[1,2,3,4,5,6].map(i=>`
            <div class="step" id="step${i}" data-step="${i}">
              <span class="step-icon" aria-hidden="true">○</span>
              <span class="step-label" id="step${i}-label">Step ${i}</span>
            </div>`).join('')}
          </div>

          <!-- Results: a navigable region (NOT a live region — too much content
               for aria-live; the screen reader navigates it by heading/arrow). -->
          <div id="results" role="region" aria-label="Analysis results" tabindex="-1"></div>
        </div>

        <!-- Bottom shortcut bar -->
        <div id="sc-bar" aria-hidden="true">
          <span class="sc-chip sc-toggle"><kbd>${TOGGLE_LABEL}</kbd>Toggle</span>
          ${['1','2','3','n','p','e','b','a','c','d','j','h'].map(k=>{
            const sc=SHORTCUTS.find(x=>x.key===k);
            return sc?`<span class="sc-chip"><kbd>${combo(k)}</kbd>${sc.label.split(' ').slice(0,3).join(' ')}</span>`:'';
          }).join('')}
        </div>
      </div>
    `;

    /* Wire static events */
    shadow.getElementById('backdrop').addEventListener('click', toggleOverlay);
    shadow.getElementById('closeBtn').addEventListener('click', toggleOverlay);
    shadow.getElementById('helpBtn').addEventListener('click', showHelp);
    shadow.getElementById('analyzeBtn').addEventListener('click', triggerAnalyze);
    // Enter submits from single-line fields; in the URL textarea, Enter adds a line (Shift+Enter or the button submits)
    shadow.getElementById('queryForm').addEventListener('keydown', e=>{
      if (e.key==='Enter' && e.target.id!=='urlInput' && e.target.tagName!=='TEXTAREA') { e.preventDefault(); triggerAnalyze(); }
    });
    shadow.getElementById('panel').addEventListener('keydown', e=>{ if(e.key==='Tab') trapFocus(e); });

    const tts = shadow.getElementById('ttsToggle');
    tts.checked = S.ttsEnabled;
    tts.addEventListener('change', e=>{
      S.ttsEnabled = e.target.checked;
      if (!S.ttsEnabled) { stopSpeaking(); announce('Spoken playback off. Your screen reader will read updates.'); return; }
      announce('Spoken playback on. Changes will be read aloud.');
      // If results are already on screen, read them out now.
      if (S.report) narrateChanges(S.report);
    });

    /* Pre-fill URL */
    const urlIn = shadow.getElementById('urlInput');
    urlIn.value = unwrap(window.location.href);

    /* Restore if we already have results */
    if (S.report) renderResults(S.report);

    announce('TimeTravel-A11y overlay open. A form with URL, year range, and focus fields. Fill them in and activate Analyze Archive. Press Alt H for keyboard shortcuts.');
  }

  /* ── Analysis trigger ───────────────────────────────────────────── */
  async function triggerAnalyze() {
    const rawField = shadow.getElementById('urlInput').value.trim();
    // Detect collection mode: multiple URLs separated by newline/comma
    const urls = rawField.split(/[\n,]+/).map(u=>unwrap(u.trim())).filter(u=>/^https?:\/\//i.test(u));
    const url      = urls.length>1 ? urls.join('\n') : (urls[0] || unwrap(rawField));
    // Years are user-driven. A blank field means "no bound on that side" —
    // i.e. the full archive (1996 → current year), NOT an arbitrary default.
    const NOW_YEAR = new Date().getFullYear();
    const fromRaw  = shadow.getElementById('fromYear').value.trim();
    const toRaw    = shadow.getElementById('toYear').value.trim();
    let   fromYear = parseInt(fromRaw, 10);
    let   toYear   = parseInt(toRaw, 10);
    if (!Number.isFinite(fromYear)) fromYear = 1996;
    if (!Number.isFinite(toYear))   toYear   = NOW_YEAR;
    // Clamp to the archive's valid bounds
    fromYear = Math.min(Math.max(fromYear, 1996), NOW_YEAR);
    toYear   = Math.min(Math.max(toYear,   1996), NOW_YEAR);
    const focus    = shadow.getElementById('focusInput').value.trim();
    const maskPii  = shadow.getElementById('maskPii')?.checked ?? true;

    if (!urls.length) { speak('Please enter a valid URL starting with https or http.'); return; }
    if (fromYear > toYear) {
      speak(`The "From" year (${fromYear}) is after the "To" year (${toYear}). Please correct the range.`);
      shadow.getElementById('fromYear').focus();
      return;
    }
    shadow.getElementById('urlInput').value = url;

    S.analyzing = true;
    S.report = null;
    S.activeChange = null;
    S.changeIdx = -1;

    shadow.getElementById('analyzeBtn').disabled = true;
    shadow.getElementById('analyzeBtn').textContent = 'Analyzing…';
    const resEl = shadow.getElementById('results');
    resEl.innerHTML = '';
    resEl.setAttribute('aria-busy', 'true');
    showProgress(true);

    const stored = await getStorage(['aiProvider','ollamaModel','groqKey']);

    speak(urls.length>1
      ? `Starting collection analysis of ${urls.length} URLs from ${fromYear} to ${toYear}.`
      : `Starting analysis of ${url} from ${fromYear} to ${toYear}. ${focus ? 'Focus: '+focus+'.' : ''} Six steps will run.`);

    armWatchdog();

    chrome.runtime.sendMessage({
      type: 'ANALYZE_ARCHIVE',
      maskPii,
      url, fromYear, toYear, focus,
      provider:    stored.aiProvider  || 'groq',
      apiKey:      stored.groqKey     || '',
      ollamaModel: stored.ollamaModel || 'llama3.2',
    });
  }

  /* Watchdog — if no progress for 60s, warn the user instead of spinning forever */
  let watchdogTimer = null;
  function armWatchdog() {
    clearTimeout(watchdogTimer);
    if (!S.analyzing) return;
    watchdogTimer = setTimeout(() => {
      if (!S.analyzing) return;
      const res = shadow.getElementById('results');
      if (res) res.innerHTML =
        `<div class="err-card" role="alert"><strong>Still working…</strong>
         The Wayback Machine is responding slowly. If this persists, it may be under heavy load —
         press <kbd>${combo('r')}</kbd> to retry, or try a narrower year range.</div>`;
      announce('The Wayback Machine is responding slowly. You can press Alt R to retry, or narrow the year range.');
    }, 60000);
  }
  function disarmWatchdog() { clearTimeout(watchdogTimer); }

  /* ── Progress display ───────────────────────────────────────────── */
  const STEP_NAMES = [
    'Find captures',
    'Filter duplicates',
    'Select key snapshots',
    'Fetch and compare content',
    'Classify & verify changes (AI chain-of-verification)',
    'Build evidence report',
  ];

  function showProgress(show) {
    shadow.getElementById('progress-panel').hidden = !show;
    if (show) STEP_NAMES.forEach((_,i)=>setStep(i+1,'pending', STEP_NAMES[i]));
  }

  function setStep(n, status, text) {
    const el   = shadow.getElementById(`step${n}`);
    const icon = shadow.getElementById(`step${n}`)?.querySelector('.step-icon');
    const lbl  = shadow.getElementById(`step${n}-label`);
    if (!el) return;
    el.dataset.status = status;
    if (icon) icon.textContent = {running:'⟳', done:'✓', error:'✗', pending:'○'}[status]||'○';
    if (lbl && text) lbl.textContent = text;
  }

  /* ── Message listener (from background) ────────────────────────── */
  chrome.runtime.onMessage.addListener((req) => {
    if (req.type === 'TOGGLE_OVERLAY') { toggleOverlay(); return; }

    if (req.type === 'ANALYSIS_PROGRESS') {
      setStep(req.step, req.status, req.text);
      speak(req.text);
      armWatchdog(); // reset the timeout — we got a heartbeat
      return;
    }

    if (req.type === 'ANALYSIS_COMPLETE') {
      disarmWatchdog();
      const r = req.report || req.result; // handle both key names defensively
      S.report = r;
      S.analyzing = false;
      showProgress(false);
      shadow.getElementById('analyzeBtn').disabled = false;
      shadow.getElementById('analyzeBtn').textContent = 'Analyze Archive';
      shadow.getElementById('results').setAttribute('aria-busy', 'false');
      if (r) renderResults(r);
      else shadow.getElementById('results').innerHTML =
        `<div class="err-card" role="alert"><strong>Analysis returned empty data.</strong> Try again.</div>`;
      return;
    }

    if (req.type === 'ANALYSIS_ERROR') {
      disarmWatchdog();
      S.analyzing = false;
      showProgress(false);
      shadow.getElementById('analyzeBtn').disabled = false;
      shadow.getElementById('analyzeBtn').textContent = 'Analyze Archive';
      const resEl = shadow.getElementById('results');
      resEl.setAttribute('aria-busy', 'false');
      resEl.innerHTML =
        `<div class="err-card" role="alert"><strong>Analysis failed</strong>${esc(req.error)}</div>`;
      speak('Error: ' + req.error);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════
     RENDER RESULTS (5-level model)
  ═══════════════════════════════════════════════════════════════════ */
  /* ── Collection-mode rendering (POINT 5) ──────────────────────────── */
  function renderCollection(r) {
    const years = Object.keys(r.appearByYear||{}).sort();
    const hist = years.length
      ? `<div class="appear-hist">${years.map(y=>`<div class="appear-row"><span class="ay-year">${y}</span><span class="ay-bar" style="width:${r.appearByYear[y]*28}px"></span><span class="ay-count">${r.appearByYear[y]} site${r.appearByYear[y]>1?'s':''}</span></div>`).join('')}</div>`
      : '<p class="dim">No first-appearance dates detected for the focus terms.</p>';

    shadow.getElementById('results').innerHTML = `
      <section class="level-section">
        <div class="level-badge l1">Collection</div>
        <h2 class="level-title">Collection Analysis — ${r.siteCount} URLs</h2>
        <p class="overview-text">
          ${r.focus ? `Focus "<em>${esc(r.focus)}</em>" detected on ${r.detected} of ${r.siteCount} sites.` : `Analyzed ${r.siteCount} sites.`}
          Period ${r.fromYear}–${r.toYear}.
        </p>
      </section>

      ${r.focus ? `
      <section class="level-section">
        <h2 class="level-title">First Appearance of "${esc(r.focus)}" by Year</h2>
        ${hist}
      </section>` : ''}

      <section class="level-section">
        <h2 class="level-title">Per-Site Results</h2>
        <table class="coll-table">
          <thead><tr><th>Site</th><th>Captures</th><th>Focus first seen</th><th>Span</th></tr></thead>
          <tbody>${r.sites.map(s=>`
            <tr>
              <td class="coll-url">${esc(shortUrl(s.url))}</td>
              <td>${s.found?s.captures:'<span class="v-no">none</span>'}</td>
              <td>${s.firstAppearance?`<span class="v-ok">${esc(s.firstAppearance)}</span>`:(s.found?'<span class="dim">not detected</span>':'—')}</td>
              <td class="dim">${s.found?`${esc(s.first)}–${esc(s.last)}`:(s.error?esc(s.error.slice(0,30)):'—')}</td>
            </tr>`).join('')}</tbody>
        </table>
      </section>
    `;

    speak(`Collection analysis complete. ${r.siteCount} sites analyzed. ${r.focus?`Focus detected on ${r.detected} sites.`:''} ${years.map(y=>`${r.appearByYear[y]} site${r.appearByYear[y]>1?'s':''} in ${y}`).join(', ')}.`);
  }
  function shortUrl(u){ try{ return new URL(u).hostname + (new URL(u).pathname==='/'?'':new URL(u).pathname); }catch{ return u; } }

  function renderResults(r) {
    if (!r) { shadow.getElementById('results').innerHTML = '<p class="dim">No data returned.</p>'; return; }
    if (r.mode === 'collection') return renderCollection(r);
    const years = Object.keys(r.yearBreakdown||{}).sort();
    const maxCt = Math.max(...Object.values(r.yearBreakdown||{1:1}));

    /* Timeline mini-chart */
    const timeline = years.length>1 ? `
      <div class="tl-wrap">
        <div class="tl-chart" aria-hidden="true">
          ${years.map(y=>{
            const h=Math.max(3,Math.round((r.yearBreakdown[y]/maxCt)*32));
            return `<div class="tl-bar" style="height:${h}px" title="${y}: ${r.yearBreakdown[y]}"></div>`;
          }).join('')}
        </div>
        <div class="tl-labels" aria-hidden="true">
          <span>${years[0]}</span><span>${years[years.length-1]}</span>
        </div>
      </div>` : '';

    /* Change list — with verification + archival-state badges */
    const changeRows = (r.changes||[]).map((c,i)=>`
      <div role="listitem">
      <button class="change-row" data-idx="${i}"
              aria-label="Change ${i+1} of ${r.changes.length}: ${c.description}. ${c.confidence} confidence. ${c.verified?'Verified against capture.':'Not verified.'} State: ${fmtState(c.archivalState)}."
              aria-pressed="${S.changeIdx===i}" aria-current="${S.changeIdx===i?'true':'false'}">
        <span class="ch-idx">${i+1}</span>
        <div class="ch-body">
          <div class="ch-desc">${esc(c.description)}</div>
          <div class="ch-meta">
            <span class="ch-period">${esc(c.period||'')}</span>
            ${c.section ? `<span class="ch-section">§ ${esc(c.section)}</span>` : ''}
            <span class="ch-badge ${confCls(c.confidence)}">${esc(c.confidence||'?')}</span>
            <span class="ch-state-badge ${stateCls(c.archivalState)}">${esc(fmtState(c.archivalState))}</span>
            <span class="ch-verify ${c.verified?'v-ok':'v-no'}" title="${c.verified?'Quotes located in capture':'Quotes not found in capture'}">${c.verified?'✓ verified':'⚠ unverified'}</span>
          </div>
        </div>
      </button>
      </div>`).join('');

    /* Stable content */
    const stableHTML = r.stableContent?.length
      ? `<ul class="stable-list">${r.stableContent.map(s=>`<li>${esc(s)}</li>`).join('')}</ul>`
      : '<p class="dim">No stable elements identified.</p>';

    /* Replay warnings */
    const warnHTML = r.replayWarnings?.length
      ? `<ul class="warn-list">${r.replayWarnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`
      : '<p class="dim">No replay issues detected.</p>';

    /* Gaps */
    const gapHTML = r.captureGaps?.length
      ? `<ul class="gap-list">${r.captureGaps.map(g=>`<li>${esc(g)}</li>`).join('')}</ul>`
      : '<p class="dim">No significant gaps detected.</p>';

    /* Shortcut reference grid */
    const groups=[...new Set(SHORTCUTS.map(x=>x.group))];
    const scGrid=groups.map(g=>`
      <div class="sc-col">
        <div class="sc-g-label">${esc(g)}</div>
        ${SHORTCUTS.filter(x=>x.group===g).map(x=>
          `<div class="sc-row"><kbd>${x.key.toUpperCase()}</kbd><span>${esc(x.label)}</span></div>`
        ).join('')}
      </div>`).join('');

    shadow.getElementById('results').innerHTML = `

      <!-- ══ LEVEL 1: Quick temporal overview ══ -->
      <section class="level-section" id="level1" aria-label="Level 1: Quick overview">
        <div class="level-badge l1">Level 1</div>
        <h2 class="level-title">Quick Temporal Overview</h2>
        <p class="overview-text">${esc(r.overview)}</p>
        ${r.coveApplied!==false
          ? `<p class="cove-note">✓ Each change was cross-checked by an AI chain-of-verification pass and its quotes matched against the archived captures.</p>`
          : `<p class="cove-note cove-warn">⚠ The AI verification pass was unavailable — changes below are draft-level and were not cross-checked.</p>`}
        <div class="stat-row">
          <div class="stat-box"><div class="sl">Total captures</div><div class="sv">${r.totalCaptures}${r.capturesCapped?'+':''}</div></div>
          <div class="stat-box"><div class="sl">Analyzed</div><div class="sv">${r.selectedCaptures}</div></div>
          <div class="stat-box"><div class="sl">Changes found</div><div class="sv">${r.changes?.length||0}</div></div>
          ${r.overallChangeScore!=null?`<div class="stat-box"><div class="sl">Content change</div><div class="sv">${r.overallChangeScore}%</div></div>`:''}
          <div class="stat-box"><div class="sl">Period</div><div class="sv sm">${r.fromYear}–${r.toYear}</div></div>
        </div>
        ${r.peakChange?`<p class="dim" style="margin-top:2px">Largest content shift: ${esc(r.peakChange.from)} → ${esc(r.peakChange.to)} (${r.peakChange.dissimilarity}% different, TF-IDF cosine).</p>`:''}
        ${timeline}
        ${r.focus ? `<div class="focus-tag">Focus: <em>${esc(r.focus)}</em></div>` : ''}
      </section>

      <!-- ══ LEVEL 2: Change list ══ -->
      <section class="level-section" id="level2" aria-label="Level 2: Change list">
        <div class="level-badge l2">Level 2</div>
        <h2 class="level-title">Temporal Change Events <span class="dim">(press Alt N or Alt P to navigate)</span></h2>
        ${r.changes?.length
          ? `<div class="change-list" role="list" aria-label="Change events">${changeRows}</div>`
          : '<p class="dim">No meaningful changes detected in the specified focus area.</p>'}
      </section>

      <!-- ══ LEVEL 3+4+5: Change detail panel (populated by selectChange) ══ -->
      <section class="level-section" id="change-detail" aria-label="Change details" tabindex="-1">
        <div class="detail-placeholder dim">
          Select a change above (click, or press Alt N) to see evidence, uncertainty, and replay status.
        </div>
      </section>

      <!-- ══ Accessibility decay audit (POINT 4) ══ -->
      ${r.a11yAudit ? `
      <section class="level-section" aria-label="Accessibility decay audit">
        <div class="level-badge la">A11y Audit</div>
        <h2 class="level-title">Accessibility Over Time
          <span class="dim">(${esc(r.a11yAudit.before)} → ${esc(r.a11yAudit.after)})</span></h2>
        <p class="a11y-verdict ${/DECREASED/.test(r.a11yAudit.verdict)?'verdict-bad':/IMPROVED/.test(r.a11yAudit.verdict)?'verdict-good':''}">
          ${esc(r.a11yAudit.verdict)}
        </p>
        ${r.a11yAudit.deltas.length ? `<table class="a11y-table">
          <thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Trend</th></tr></thead>
          <tbody>${r.a11yAudit.deltas.map(d=>`
            <tr class="dir-${d.direction}">
              <td>${esc(d.metric)}</td><td>${d.before}</td><td>${d.after}</td>
              <td>${d.direction==='worse'?'▲ worse':d.direction==='better'?'▼ better':''}</td>
            </tr>`).join('')}</tbody></table>` : ''}
        ${r.a11yAudit.findings.length ? `<ul class="warn-list">${r.a11yAudit.findings.map(f=>`<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      </section>` : ''}

      <!-- ══ Privacy note (POINT 6) ══ -->
      ${r.privacy ? `
      <section class="level-section" aria-label="Privacy">
        <div class="level-badge lp">Privacy</div>
        <p class="privacy-note">🔒 ${r.privacy.count} personal data item(s) detected and masked
          (${esc(r.privacy.types.join(', '))}). Evidence shown above has these redacted.</p>
      </section>` : ''}

      <!-- ══ Stable content ══ -->
      <section class="level-section" aria-label="Stable content">
        <h2 class="level-title">What Did NOT Change</h2>
        ${stableHTML}
      </section>

      <!-- ══ Key snapshots ══ -->
      <section class="level-section" aria-label="Key snapshots analyzed">
        <h2 class="level-title">Snapshots Analyzed</h2>
        <ul class="snap-list">
          ${(r.keySnapshots||[]).map(s=>`
          <li class="snap-item">
            <a href="${esc(s.url)}" target="_blank" class="snap-link">${esc(s.date)}</a>
            ${s.issues?.length ? `<span class="snap-warn">⚠ ${esc(s.issues[0])}</span>`:''}
          </li>`).join('')}
        </ul>
      </section>

      <!-- ══ Keyboard shortcuts ══ -->
      <section class="level-section" id="sc-section" aria-label="Keyboard shortcuts">
        <button class="sc-toggle" aria-expanded="true" aria-controls="sc-grid-inner">
          Keyboard Shortcuts <span class="sc-hint">▲ collapse</span>
        </button>
        <div id="sc-grid-inner" class="sc-grid">${scGrid}</div>
      </section>
    `;

    /* Wire change-row clicks */
    shadow.querySelectorAll('.change-row').forEach(btn => {
      btn.addEventListener('click', () => selectChange(parseInt(btn.dataset.idx)));
    });

    /* Wire shortcuts toggle */
    shadow.querySelector('.sc-toggle')?.addEventListener('click', function(){
      const grid=shadow.getElementById('sc-grid-inner'), open=this.getAttribute('aria-expanded')==='true';
      this.setAttribute('aria-expanded',String(!open));
      this.querySelector('.sc-hint').textContent = open?'▼ expand':'▲ collapse';
      grid.hidden = open;
    });

    /* Auto-select first change (without auto-speaking — we announce the overview below) */
    if (r.changes?.length) selectChange(0, {silent:true});

    /* Move focus into the results region so the screen-reader user lands
       on the content and can navigate it by heading. */
    const resEl = shadow.getElementById('results');
    setTimeout(()=> resEl?.focus(), 60);

    /* Announce a CONCISE Level-1 summary (full content is navigable by heading). */
    const nc=r.changes?.length||0;
    const v = r.changes?.filter(c=>c.verified).length||0;
    announce(`Analysis complete. ${r.totalCaptures} captures, ${r.selectedCaptures} analyzed. ${nc} change${nc!==1?'s':''} found, ${v} verified against captures. ${r.overview} Use ${combo('n')} and ${combo('p')} to step through changes, ${combo('h')} for all shortcuts.`);
    // Read the changes out loud with the built-in voice (no-op unless the user enabled audio).
    narrateChanges(r);
  }

  /* ── Change detail (Levels 3–5) ─────────────────────────────────── */
  function selectChange(idx, opts={}) {
    const r = S.report;
    if (!r?.changes?.length) return;
    idx = Math.max(0, Math.min(r.changes.length-1, idx));
    S.changeIdx = idx;
    S.activeChange = r.changes[idx];
    const c = S.activeChange;

    /* Highlight active row */
    shadow.querySelectorAll('.change-row').forEach((btn,i) => {
      btn.setAttribute('aria-pressed', i===idx ? 'true' : 'false');
      btn.setAttribute('aria-current', i===idx ? 'true' : 'false');
      btn.style.borderColor = i===idx ? 'var(--focus)' : '';
    });

    const confLabel = {high:'High confidence',medium:'Medium confidence',low:'Low confidence'}[c.confidence]||c.confidence;

    shadow.getElementById('change-detail').innerHTML = `
      <!-- ══ LEVEL 3: Evidence ══ -->
      <div class="level-badge l3">Level 3</div>
      <h2 class="level-title">Evidence — Change ${idx+1}: ${esc(c.description)}</h2>

      <div class="evidence-meta">
        <span class="ch-state-badge ${stateCls(c.archivalState)}">${esc(fmtState(c.archivalState))}</span>
        ${c.section ? `<span class="ch-section">§ ${esc(c.section)}</span>` : ''}
        <span class="ch-verify ${c.verified?'v-ok':'v-no'}">${c.verified?`✓ verified (${c.verifyScore}%)`:'⚠ unverified'}</span>
      </div>
      <p class="state-reason">${esc(c.archivalReason||'')}</p>

      <div class="evidence-grid">
        <div class="ev-col">
          <div class="ev-header before-hdr">Before ${c.beforeText ? (c.beforeVerified?'<span class="v-ok">✓</span>':'<span class="v-no">⚠</span>') : ''}</div>
          <div class="ev-date">${esc(c.beforeDate||'')}</div>
          <div class="ev-text ${c.beforeText?'':'dim'}">
            ${c.beforeText ? `"${esc(c.beforeText)}"` : 'No relevant text in this snapshot.'}
          </div>
          ${!c.beforeVerified && c.beforeText ? '<div class="verify-warn">⚠ This quote could not be located in the archived capture.</div>' : ''}
          ${c.beforeUrl ? `<a href="${esc(c.beforeUrl)}" target="_blank" class="ev-open-btn">Open capture ↗</a>` : ''}
        </div>
        <div class="ev-arrow" aria-hidden="true">→</div>
        <div class="ev-col">
          <div class="ev-header after-hdr">After ${c.afterText ? (c.afterVerified?'<span class="v-ok">✓</span>':'<span class="v-no">⚠</span>') : ''}</div>
          <div class="ev-date">${esc(c.afterDate||'')}</div>
          <div class="ev-text ${c.afterText?'':'removed-text'}">
            ${c.afterText ? `"${esc(c.afterText)}"` : '[Content not present in this capture]'}
          </div>
          ${!c.afterVerified && c.afterText ? '<div class="verify-warn">⚠ This quote could not be located in the archived capture.</div>' : ''}
          ${c.afterUrl ? `<a href="${esc(c.afterUrl)}" target="_blank" class="ev-open-btn">Open capture ↗</a>` : ''}
        </div>
      </div>

      <div class="conf-row">
        <span class="ch-badge ${confCls(c.confidence)}">${confLabel}</span>
        ${c.confidenceScore!=null?`<span class="ch-badge ${confCls(c.confidence)}">${c.confidenceScore}/100</span>`:''}
        ${c.changeMagnitude!=null?`<span class="ch-section">Δ ${c.changeMagnitude}% content shift</span>`:''}
        <span class="conf-reason">${esc(c.confidenceReason||'')}</span>
      </div>
      ${c.verificationNotes ? `<p class="verify-notes"><span class="vn-label">Chain-of-verification:</span> ${esc(c.verificationNotes)}</p>` : ''}

      <!-- ══ LEVEL 4: Archive uncertainty ══ -->
      <div class="level-badge l4" style="margin-top:14px">Level 4</div>
      <h3 class="level-title sm">Archive Uncertainty</h3>
      <div class="uncertainty-box">
        <div class="unc-label">What the archive cannot tell us:</div>
        <p class="unc-text">${esc(c.uncertainty||'No additional uncertainty noted.')}</p>
        ${r.captureGaps?.length ? `
        <div class="unc-label" style="margin-top:8px">Capture gaps in this period:</div>
        <ul class="gap-list">${r.captureGaps.map(g=>`<li>${esc(g)}</li>`).join('')}</ul>` : ''}
      </div>

      <!-- ══ LEVEL 5: Replay status ══ -->
      <div class="level-badge l5" style="margin-top:14px">Level 5</div>
      <h3 class="level-title sm">Replay Status</h3>
      <div class="replay-box ${['broken_replay','missing_resource'].includes(c.archivalState) ? 'replay-warn' : 'replay-ok'}">
        ${['broken_replay','missing_resource'].includes(c.archivalState)
          ? `<div class="replay-icon" aria-hidden="true">⚠</div>
             <p>${esc(c.archivalReason)} The system did NOT treat this as a confirmed change.</p>`
          : `<div class="replay-icon ok" aria-hidden="true">✓</div>
             <p>No replay degradation affecting this change. Evidence is from cleanly archived captures.</p>`}
      </div>

      <!-- Nav hint -->
      <p class="nav-hint dim">Change ${idx+1} of ${r.changes.length} · ${combo('n')} next · ${combo('p')} previous · ${combo('e')} read evidence</p>
    `;

    if (opts.silent) return;   // initial auto-select shouldn't double-announce

    /* Announce a concise Level-3 summary for the screen reader */
    const beforeSay = c.beforeText ? `Before: "${c.beforeText.slice(0,80)}"` : 'Before: not found.';
    const afterSay  = c.afterText  ? `After: "${c.afterText.slice(0,80)}"`  : 'After: content not present.';
    const verifySay = c.verified ? 'Quotes verified against the captures.' : 'Warning: quotes could not be verified against the captures.';
    speak(`Change ${idx+1} of ${r.changes.length}: ${c.description}. ${c.section?'Section: '+c.section+'.':''} State: ${fmtState(c.archivalState)}. ${c.archivalReason} ${confLabel}. ${verifySay} ${beforeSay} ${afterSay}. Uncertainty: ${c.uncertainty||'none noted.'}`);
  }

  /* ═══════════════════════════════════════════════════════════════════
     5-LEVEL SPOKEN SUMMARIES
  ═══════════════════════════════════════════════════════════════════ */
  function speakLevel(lvl) {
    const r=S.report, c=S.activeChange;
    if (!r) { speak('No analysis yet. Press Analyze Archive first.'); return; }

    if (lvl===1) {
      speak(`Level 1 — Overview. ${r.overview} Total captures: ${r.capturesCapped?'over ':''}${r.totalCaptures}. Analyzed: ${r.selectedCaptures}. Changes detected: ${r.changes?.length||0}.${r.overallChangeScore!=null?` Overall content change ${r.overallChangeScore} percent by TF-IDF cosine.`:''} Period: ${r.fromYear} to ${r.toYear}.`);
    } else if (lvl===2) {
      if (!r.changes?.length) { speak('Level 2 — No changes detected.'); return; }
      const list=r.changes.map((x,i)=>`${i+1}. ${x.description}. ${x.period}. ${x.confidence} confidence.`).join(' ');
      speak(`Level 2 — Change list. ${r.changes.length} changes. ${list}`);
    } else if (lvl===3) {
      if (!c) { speak('Press Alt N to select a change first, then Alt 3 for its evidence.'); return; }
      speak(`Level 3 — Evidence for change ${S.changeIdx+1}: ${c.description}. Before (${c.beforeDate}): ${c.beforeText||'not found'}. After (${c.afterDate}): ${c.afterText||'content removed'}. ${c.confidenceReason||''}`);
    } else if (lvl===4) {
      if (!c) { speak('Press Alt N to select a change first.'); return; }
      const gaps=r.captureGaps?.length ? 'Capture gaps: ' + r.captureGaps.join('. ') : 'No significant gaps noted.';
      speak(`Level 4 — Uncertainty. ${c.uncertainty||'None noted.'} ${gaps}`);
    } else if (lvl===5) {
      const warns=r.replayWarnings?.length ? r.replayWarnings.join('. ') : 'No replay issues detected.';
      speak(`Level 5 — Replay status. ${warns}. ${c?.replayIssue ? 'This change specifically: '+c.replayIssue : 'This change has clean archival evidence.'}`);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     KEYBOARD ACTIONS
  ═══════════════════════════════════════════════════════════════════ */
  function stepChange(dir) {
    const r=S.report;
    if (!r?.changes?.length) { speak('No changes to navigate. Run analysis first.'); return; }
    const next = S.changeIdx + dir;
    if (next < 0) { speak('Already at the first change.'); return; }
    if (next >= r.changes.length) { speak('Already at the last change.'); return; }
    selectChange(next);
  }

  function hearEvidence() {
    if (!S.activeChange) { speak('No change selected. Press Alt N to select one.'); return; }
    speakLevel(3);
  }

  function hearBefore() {
    const c=S.activeChange;
    if (!c) { speak('No change selected.'); return; }
    speak(`Before capture (${c.beforeDate}): ${c.beforeText||'No relevant text found.'}`);
  }

  function hearAfter() {
    const c=S.activeChange;
    if (!c) { speak('No change selected.'); return; }
    speak(`After capture (${c.afterDate}): ${c.afterText||'Content not found — possibly removed.'}`);
  }

  function openBefore() {
    const c=S.activeChange;
    if (!c?.beforeUrl) { speak('No before capture URL available.'); return; }
    window.open(c.beforeUrl,'_blank'); speak(`Opening before capture: ${c.beforeDate}.`);
  }

  function openAfter() {
    const c=S.activeChange;
    if (!c?.afterUrl) { speak('No after capture URL available.'); return; }
    window.open(c.afterUrl,'_blank'); speak(`Opening after capture: ${c.afterDate}.`);
  }

  function openKeySnaps() {
    const snaps=S.report?.keySnapshots;
    if (!snaps?.length) { speak('No key snapshots available.'); return; }
    snaps.forEach(s=>window.open(s.url,'_blank'));
    speak(`Opening ${snaps.length} key snapshots in new tabs.`);
  }

  function jumpToYear() {
    const r=S.report;
    if (!r) { speak('No analysis available.'); return; }
    const years=Object.keys(r.yearBreakdown||{}).sort();
    const modal=buildModal('Jump to Snapshot by Year');
    modal.querySelector('.modal-body').innerHTML=`
      <label class="ml">Year:</label>
      <select id="yrSel" class="msel">
        ${years.map(y=>`<option value="${y}">${y} — ${r.yearBreakdown[y]} version${r.yearBreakdown[y]>1?'s':''}</option>`).join('')}
      </select>`;
    modal.querySelector('.modal-ok').textContent='Open Snapshot';
    modal.querySelector('.modal-ok').addEventListener('click',()=>{
      const yr=modal.querySelector('#yrSel').value; modal.remove();
      const snap=r.keySnapshots?.find(s=>s.date.includes(yr));
      if (snap) { window.open(snap.url,'_blank'); speak(`Opening snapshot from ${yr}.`); }
      else speak(`No fetched snapshot for ${yr}. Try opening the Wayback Machine directly.`);
    });
    shadow.getElementById('panel').appendChild(modal);
    modal.querySelector('#yrSel').focus();
    speak(`Jump to year. Available: ${years.join(', ')}.`);
  }

  /* Read the temporal changes out loud with the built-in voice.
     Used on completion (when audio is enabled) and when the user turns
     audio on with results already present — so the changes are announced
     by audio, not only shown on screen. */
  function narrateChanges(r) {
    if (!r) return;
    if (r.mode === 'collection') {
      tts(`Collection analysis complete. ${r.focus ? `Focus "${r.focus}" detected on ${r.detected} of ${r.siteCount} sites.` : `${r.siteCount} sites analysed.`}`);
      return;
    }
    const parts = [`Analysis complete for ${shortUrl(r.url)}.`, r.overview || ''];
    const cs = r.changes || [];
    if (!cs.length) {
      parts.push('No clear changes were detected in this period.');
    } else {
      const v = cs.filter(c=>c.verified).length;
      parts.push(`${cs.length} change${cs.length!==1?'s':''} found, ${v} verified against the captures.`);
      cs.forEach((c,i)=>{
        parts.push(
          `Change ${i+1}: ${c.description}. ${c.period||''}. ${fmtState(c.archivalState)}. ` +
          (c.verified ? 'Verified against the captures.' : 'Not verified — treat with caution.') +
          (c.beforeText ? ` Before: "${c.beforeText.slice(0,90)}".` : '') +
          (c.afterText  ? ` After: "${c.afterText.slice(0,90)}".`  : ' After: content not present.')
        );
      });
      parts.push(`Use ${combo('n')} and ${combo('p')} to step through changes, or ${combo('s')} to hear this again.`);
    }
    tts(parts.filter(Boolean).join(' '));
  }

  function speakFullReport() {
    const r=S.report;
    if (!r) { speak('No report available.'); return; }
    if (r.mode === 'collection') {
      speak(`Collection report. ${r.siteCount} sites. Focus detected on ${r.detected}. ${r.sites.filter(s=>s.firstAppearance).map(s=>`${shortUrl(s.url)} first showed it ${s.firstAppearance}`).join('. ')}.`);
      return;
    }
    const lines=[
      `Archive report for ${r.url}.`,
      `Period: ${r.fromYear} to ${r.toYear}. ${r.focus?'Focus: '+r.focus:''}.`,
      `Total captures: ${r.totalCaptures}. Analyzed: ${r.selectedCaptures}.`,
      r.overview,
      r.changes?.length
        ? `Changes: ${r.changes.map((c,i)=>`${i+1}. ${c.description}. ${fmtState(c.archivalState)}. ${c.verified?'Verified.':'Unverified.'} ${c.confidence} confidence.`).join(' ')}`
        : 'No changes detected.',
      r.a11yAudit ? r.a11yAudit.verdict : '',
      r.privacy ? `${r.privacy.count} personal data items masked.` : '',
    ].filter(Boolean).join(' ');
    speak(lines);
  }

  function copyReport() {
    const t=buildPlainText();
    if (!t) { speak('No report to copy.'); return; }
    navigator.clipboard.writeText(t).then(()=>speak('Report copied to clipboard.')).catch(()=>speak('Clipboard unavailable.'));
  }

  function downloadReport() {
    const t=buildPlainText();
    if (!t) { speak('No report to download.'); return; }
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([t],{type:'text/plain'}));
    a.download=`timetravel-forensics-${Date.now()}.txt`; a.click();
    speak('Report downloaded.');
  }

  /* Full structured report incl. the _rescore bundle (raw LLM changes + snapshot
     texts), so scoring logic can be re-applied later without a re-run. */
  function downloadReportJson() {
    const r=S.report; if (!r) { speak('No report to download.'); return; }
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(r,null,2)],{type:'application/json'}));
    a.download=`timetravel-forensics-${Date.now()}.json`; a.click();
    speak('Data JSON downloaded.');
  }

  function buildPlainText() {
    const r=S.report; if (!r) return '';
    const sep='─'.repeat(52);
    if (r.mode === 'collection') {
      return [
        'TimeTravel-A11y — Collection Report', sep,
        `Focus: ${r.focus||'(none)'}`, `Period: ${r.fromYear}–${r.toYear}`,
        `Sites: ${r.siteCount} · Focus detected on ${r.detected}`,
        `Generated: ${new Date().toLocaleString()}`, sep,
        'FIRST APPEARANCE BY YEAR', sep,
        ...Object.keys(r.appearByYear||{}).sort().map(y=>`  ${y}: ${r.appearByYear[y]} site(s)`),
        '', 'PER-SITE', sep,
        ...r.sites.map(s=>`  ${shortUrl(s.url)} — ${s.found?`${s.captures} captures, focus ${s.firstAppearance||'not detected'}`:'no captures'}`),
      ].join('\n');
    }
    return [
      'TimeTravel-A11y — Temporal Forensics Report',
      sep,
      `URL: ${r.url}`,
      `Period: ${r.fromYear} – ${r.toYear}`,
      r.focus ? `Focus: ${r.focus}` : '',
      `Generated: ${new Date().toLocaleString()}`,
      sep,
      'LEVEL 1 — OVERVIEW',sep,
      r.overview,'',
      r.coveApplied!==false
        ? 'Verification: changes cross-checked by AI chain-of-verification and matched against captures.'
        : 'Verification: AI verification pass unavailable — changes are draft-level only.',
      '',
      `Total captures : ${r.totalCaptures}${r.capturesCapped?'+ (first 1500 sampled)':''}`,
      `Analyzed       : ${r.selectedCaptures}`,
      `Changes found  : ${r.changes?.length||0}`,
      r.overallChangeScore!=null ? `Content change : ${r.overallChangeScore}% (TF-IDF cosine, first vs last capture)` : '',
      '',
      r.privacy ? `Privacy: ${r.privacy.count} item(s) masked (${r.privacy.types.join(', ')})` : '',
      '',
      'LEVEL 2 — CHANGE LIST',sep,
      ...(r.changes?.length
        ? r.changes.map((c,i)=>[
            `${i+1}. [${fmtState(c.archivalState)}] ${c.description}`,
            `   Section   : ${c.section||'(not localized)'}`,
            `   Period    : ${c.period}`,
            `   Confidence: ${c.confidence}${c.confidenceScore!=null?` (${c.confidenceScore}/100)`:''}${c.confidenceReason?' — '+c.confidenceReason:''}`,
            `   Verified  : ${c.verified?`YES (${c.verifyScore}%)`:'NO — quotes not located in capture'}`,
          ].join('\n'))
        : ['  No changes detected.']),
      '',
      'LEVEL 3 — EVIDENCE (verified against captures)',sep,
      ...(r.changes?.map((c,i)=>[
        `Change ${i+1}: ${c.description}  [${fmtState(c.archivalState)}]`,
        `  ${c.archivalReason||''}`,
        `  Before (${c.beforeDate}) ${c.beforeVerified?'✓':'⚠ unverified'}: ${c.beforeText||'[not found]'}`,
        `  After  (${c.afterDate}) ${c.afterVerified?'✓':'⚠ unverified'}: ${c.afterText||'[removed or absent]'}`,
      ].join('\n'))||[]),
      '',
      'LEVEL 4 — UNCERTAINTY',sep,
      ...(r.changes?.map((c,i)=>`Change ${i+1}: ${c.uncertainty||'None noted.'}`)||[]),
      '',
      'Capture gaps:',
      ...(r.captureGaps?.map(g=>`  • ${g}`)||['  None detected.']),
      '',
      'LEVEL 5 — REPLAY STATUS',sep,
      ...(r.replayWarnings?.map(w=>`⚠ ${w}`)||['✓ No replay issues detected.']),
      '',
      ...(r.a11yAudit ? [
        'ACCESSIBILITY AUDIT', sep,
        `${r.a11yAudit.before} → ${r.a11yAudit.after}`,
        r.a11yAudit.verdict,
        ...r.a11yAudit.deltas.map(d=>`  ${d.metric}: ${d.before} → ${d.after} (${d.direction})`),
        ...r.a11yAudit.findings.map(f=>`  • ${f}`),
        '',
      ] : []),
      ...(r.changeMagnitudes?.length ? [
        'CONTENT CHANGE TRAJECTORY (TF-IDF cosine dissimilarity)', sep,
        ...r.changeMagnitudes.map(t=>`  ${t.from} → ${t.to}: ${t.dissimilarity}% changed (${t.similarity}% similar)`),
        '',
      ] : []),
      'STABLE CONTENT',sep,
      ...(r.stableContent?.map(s=>`  • ${s}`)||['  None identified.']),
      '',
      'KEY SNAPSHOTS',sep,
      ...(r.keySnapshots?.map(s=>`  ${s.date} — ${s.url}${s.issues?.length?' ⚠'+s.issues[0]:''}`) || []),
    ].filter(s=>s!==null&&s!==undefined).join('\n');
  }

  function showHelp() {
    const groups=[...new Set(SHORTCUTS.map(x=>x.group))];
    const intro = `All shortcuts use the ${ALT} modifier so they do not clash with your screen reader.\nPress ${TOGGLE_LABEL} to open or close. Press Escape to close.\n`;
    const body=intro + '\n' + groups.map(g=>
      `${g.toUpperCase()}\n${SHORTCUTS.filter(x=>x.group===g).map(x=>`  ${combo(x.key).padEnd(7)} ${x.label}`).join('\n')}`
    ).join('\n\n');
    openModal('Keyboard Shortcuts', body);
    speak(`Keyboard shortcuts. All use the ${IS_MAC?'Option':'Alt'} key. ` + SHORTCUTS.map(x=>`${combo(x.key)}: ${x.label}`).join('. '));
  }

  /* ── Modal builder ─────────────────────────────────────────────── */
  function buildModal(title) {
    const el=document.createElement('div');
    el.className='inner-modal'; el.setAttribute('role','dialog');
    el.setAttribute('aria-modal','true'); el.setAttribute('aria-label',title);
    el.innerHTML=`
      <div class="mbox">
        <h3 class="mtitle">${esc(title)}</h3>
        <div class="modal-body"></div>
        <div class="mactions">
          <button class="modal-ok mprimary">OK</button>
          <button class="mcancel msec">Cancel</button>
        </div>
      </div>`;
    el.querySelector('.mcancel').addEventListener('click',()=>el.remove());
    el.querySelector('.modal-ok').addEventListener('click',()=>el.remove());
    el.addEventListener('keydown',e=>{ if(e.key==='Escape') el.remove(); });
    return el;
  }

  function openModal(title, content) {
    const el=buildModal(title);
    el.querySelector('.modal-body').innerHTML=`<pre class="mpre">${esc(content)}</pre>`;
    el.querySelector('.mcancel').remove();
    shadow.getElementById('panel').appendChild(el);
    el.querySelector('.modal-ok').focus();
  }

  /* ── Speech ────────────────────────────────────────────────────── */
  /* announce(): the ONLY voice for a screen-reader user. Writes to the
     polite live region, which the SR reads in the user's own voice. */
  function announce(text) {
    if (!text) return;
    S.lastSpoken = text;
    const el = shadow?.getElementById('sr-status');
    if (el) { el.textContent=''; setTimeout(()=>el.textContent=text, 90); }
  }
  /* tts(): synthetic voice — ONLY when the user opted in (no screen reader).
     Kept separate so we never talk over a screen reader by default. */
  function tts(text) {
    if (!S.ttsEnabled || !text || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);
    u.rate=1.05; u.lang='en-US'; window.speechSynthesis.speak(u);
  }
  /* speak(): convenience used throughout — announce to SR, and also TTS if enabled. */
  function speak(text) { announce(text); tts(text); }
  function stopSpeaking() { try { window.speechSynthesis?.cancel(); } catch {} }

  /* ── Helpers ───────────────────────────────────────────────────── */
  function trapFocus(e) {
    const panel=shadow.getElementById('panel');
    const els=[...panel.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(x=>!x.hidden&&!x.disabled);
    const first=els[0],last=els[els.length-1];
    if (e.shiftKey&&shadow.activeElement===first){e.preventDefault();last.focus();}
    else if (!e.shiftKey&&shadow.activeElement===last){e.preventDefault();first.focus();}
  }

  function confCls(c) { return {high:'badge-hi',medium:'badge-med',low:'badge-lo'}[c]||'badge-med'; }

  function fmtState(s) {
    return {
      added:'Added', real_deletion:'Real deletion', moved:'Moved',
      broken_replay:'Broken replay', missing_resource:'Missing resource',
      wording_change:'Wording change', unclear:'Unclear',
    }[s]||'Unclear';
  }
  function stateCls(s) {
    return {
      added:'st-add', real_deletion:'st-del', moved:'st-move',
      broken_replay:'st-replay', missing_resource:'st-replay',
      wording_change:'st-word', unclear:'st-unclear',
    }[s]||'st-unclear';
  }

  function esc(x) {
    return String(x??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function unwrap(url) {
    try {
      const u = new URL(url.trim());
      if (u.hostname === 'web.archive.org') {
        const m = u.pathname.match(/^\/web\/[^/]+\/(.+)$/);
        if (m) return m[1];
      }
    } catch {}
    return url.trim();
  }

  function getStorage(keys) { return new Promise(r=>chrome.storage.local.get(keys,d=>r(d||{}))); }

  /* ── Global keyboard dispatcher ────────────────────────────────────
     ALL app shortcuts require the Alt (⌥) modifier. This is deliberate:
     screen readers in browse mode capture bare single keys (h, b, 1, n…)
     for their own quick-navigation, so a bare-key shortcut would never
     reach us. Alt+<key> passes through. We use e.code (not e.key) because
     on macOS Option+key produces special characters. */
  document.addEventListener('keydown', e => {
    // Alt+Shift+T toggles the overlay from anywhere
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code==='KeyT') {
      e.preventDefault(); e.stopPropagation(); toggleOverlay(); return;
    }
    if (!S.open) return;
    if (e.key==='Escape') { e.preventDefault(); toggleOverlay(); return; }
    if (shadow.querySelector('.inner-modal')) return;        // modal handles its own keys

    // App shortcuts: Alt only (no Shift/Ctrl/Meta)
    if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const key = codeToKey(e.code);
    if (!key) return;
    const sc = SHORTCUTS.find(x=>x.key===key);
    if (sc) { e.preventDefault(); e.stopPropagation(); sc.fn(); }
  }, true);

  chrome.runtime.onMessage.addListener((req) => {
    if (req.type === 'TOGGLE_OVERLAY') { toggleOverlay(); return; }

    if (req.type === 'AUTO_ANALYZE') {
      // Ensure overlay is open
      if (!S.open) toggleOverlay();
      // Pre-fill URL and settings then kick off analysis
      setTimeout(() => {
        const urlIn = shadow.getElementById('urlInput');
        if (urlIn) urlIn.value = unwrap(req.url || window.location.href);
        // Store settings for this session
        if (req.provider || req.groqKey) {
          chrome.storage.local.set({
            aiProvider:  req.provider    || 'groq',
            groqKey:     req.groqKey     || '',
            ollamaModel: req.ollamaModel || 'llama3.2',
          });
        }
        triggerAnalyze();
      }, 200);
    }
  });

  /* ═══════════════════════════════════════════════════════════════════
     SHADOW DOM CSS
  ═══════════════════════════════════════════════════════════════════ */
  const CSS = `
    :host{all:initial;}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
    :focus-visible{outline:3px solid #ffeb3b;outline-offset:2px;}
    :focus:not(:focus-visible){outline:none;}

    #backdrop{position:fixed;inset:0;background:rgba(0,0,8,.85);backdrop-filter:blur(4px);animation:fi .2s ease;}
    @keyframes fi{from{opacity:0}to{opacity:1}}

    #panel{
      position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
      width:min(940px,97vw);max-height:94vh;
      display:flex;flex-direction:column;
      background:#080814;border:1.5px solid #2e3880;border-radius:12px;
      box-shadow:0 40px 100px rgba(0,0,0,.9);
      font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#e8eaf6;
      animation:si .22s cubic-bezier(.22,1,.36,1);overflow:hidden;
    }
    @keyframes si{from{opacity:0;transform:translate(-50%,-47%)}to{opacity:1;transform:translate(-50%,-50%)}}

    /* Header */
    #hdr{display:flex;align-items:center;justify-content:space-between;
      padding:12px 18px;background:#0f0f28;border-bottom:2px solid #2e3880;flex-shrink:0;}
    #hdr-left{display:flex;align-items:center;gap:8px;}
    .logo-clock{font-size:20px;}
    .logo{font-size:17px;font-weight:800;color:#4fc3f7;letter-spacing:.02em;}
    .logo-hi{color:#81d4fa;}
    .logo-sub{font-size:10px;color:#5c6bc0;text-transform:uppercase;letter-spacing:.08em;margin-left:4px;}
    #hdr-right{display:flex;gap:6px;}
    .icon-btn{width:30px;height:30px;border:none;border-radius:6px;
      background:#1a1a3a;color:#9fa8da;font-size:14px;cursor:pointer;
      display:grid;place-items:center;transition:background .15s,color .15s;}
    .icon-btn:hover{background:#2e3880;color:#fff;}

    /* Hint bar */
    #hint{background:#04040e;padding:4px 18px;font-size:11px;color:#5c6bc0;
      border-bottom:1px solid #13133a;flex-shrink:0;}
    #hint kbd{background:#0f0f28;border:1px solid #2e3880;border-bottom-width:2px;
      border-radius:3px;padding:0 4px;font-family:monospace;color:#4fc3f7;font-size:10px;}

    /* Query form */
    #queryForm{padding:12px 18px;border-bottom:1px solid #13133a;
      background:#0b0b1e;flex-shrink:0;}
    #form-row1{display:grid;grid-template-columns:1fr 90px 90px;gap:8px;margin-bottom:8px;}
    #form-row2{display:grid;grid-template-columns:1fr auto;gap:8px;}
    .fg{display:flex;flex-direction:column;gap:3px;}
    label{font-size:10px;font-weight:700;color:#4fc3f7;text-transform:uppercase;letter-spacing:.05em;}
    .opt{font-weight:400;color:#5c6bc0;text-transform:none;}
    input[type="url"],input[type="text"],input[type="number"]{
      padding:8px 10px;background:#14143a;border:2px solid #2e3880;
      border-radius:5px;color:#e8eaf6;font-size:13px;font-family:inherit;}
    input:focus{border-color:#ffeb3b;}
    input::placeholder{color:#5c6bc0;}
    #analyzeBtn{padding:8px 20px;background:#4fc3f7;color:#000;border:none;
      border-radius:5px;font-size:14px;font-weight:700;cursor:pointer;
      white-space:nowrap;align-self:flex-end;transition:background .15s;}
    #analyzeBtn:hover:not(:disabled){background:#81d4fa;}
    #analyzeBtn:disabled{background:#2e3880;color:#9fa8da;cursor:not-allowed;}

    /* Progress panel */
    #progress-panel{display:flex;flex-direction:column;gap:4px;
      padding:12px 18px;background:#0b0b1e;border-bottom:1px solid #13133a;flex-shrink:0;}
    .step{display:flex;align-items:center;gap:8px;font-size:12px;color:#9fa8da;transition:color .2s;}
    .step[data-status="running"]{color:#4fc3f7;}
    .step[data-status="done"]{color:#81c784;}
    .step[data-status="error"]{color:#ef5350;}
    .step-icon{width:16px;text-align:center;font-size:12px;}
    .step[data-status="running"] .step-icon{animation:spin .8s linear infinite;display:inline-block;}
    @keyframes spin{to{transform:rotate(360deg)}}

    /* Main scroll area */
    #main{flex:1;overflow-y:auto;display:flex;flex-direction:column;
      scrollbar-width:thin;scrollbar-color:#2e3880 transparent;}
    #results{padding:14px 18px;flex:1;}

    /* Shortcut bar */
    #sc-bar{display:flex;gap:6px;flex-wrap:wrap;padding:6px 18px;
      border-top:1px solid #13133a;background:#04040e;flex-shrink:0;}
    .sc-chip{display:flex;align-items:center;gap:4px;font-size:11px;color:#9fa8da;}
    .sc-chip kbd{background:#0f0f28;border:1px solid #2e3880;border-bottom-width:2px;
      border-radius:3px;padding:1px 4px;font-family:monospace;color:#4fc3f7;font-size:10px;}
    .sc-toggle{font-weight:700;color:#4fc3f7;}

    /* Level sections */
    .level-section{margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #13133a;}
    .level-section:last-child{border-bottom:none;}
    .level-badge{display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;
      letter-spacing:.06em;padding:2px 7px;border-radius:8px;margin-bottom:6px;}
    .l1{background:#0d1e35;color:#4fc3f7;border:1px solid #4fc3f7;}
    .l2{background:#1e1500;color:#ffb74d;border:1px solid #ffb74d;}
    .l3{background:#0d2e10;color:#81c784;border:1px solid #81c784;}
    .l4{background:#1e0d25;color:#ce93d8;border:1px solid #ce93d8;}
    .l5{background:#2e0d0d;color:#ef9a9a;border:1px solid #ef9a9a;}
    .level-title{font-size:13px;font-weight:700;color:#e8eaf6;margin-bottom:8px;}
    .level-title.sm{font-size:12px;margin-top:6px;}

    /* Level 1 */
    .overview-text{font-size:13px;line-height:1.6;color:#e8eaf6;
      font-style:italic;margin-bottom:10px;}
    .stat-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}
    .stat-box{background:#0f0f28;border-radius:5px;padding:6px 10px;flex:1;min-width:80px;}
    .sl{font-size:9px;color:#9fa8da;text-transform:uppercase;letter-spacing:.04em;}
    .sv{font-size:14px;font-weight:700;color:#e8eaf6;margin-top:1px;}
    .sv.sm{font-size:11px;}
    .focus-tag{font-size:11px;color:#4fc3f7;background:#0d1e35;
      border:1px solid #2e3880;border-radius:4px;padding:3px 8px;
      display:inline-block;margin-top:4px;}

    /* Timeline */
    .tl-wrap{margin:6px 0;}
    .tl-chart{display:flex;align-items:flex-end;gap:2px;height:40px;}
    .tl-bar{flex:1;background:#2e3880;border-radius:2px 2px 0 0;min-height:3px;transition:background .2s;}
    .tl-bar:hover{background:#4fc3f7;}
    .tl-labels{display:flex;justify-content:space-between;font-size:9px;color:#5c6bc0;margin-top:2px;}

    /* Level 2: Change list */
    .change-list{display:flex;flex-direction:column;gap:5px;}
    .change-row{
      display:grid;grid-template-columns:26px 1fr;gap:8px;align-items:start;
      background:#0f0f28;border:1.5px solid #1e1e48;border-radius:6px;
      padding:9px 12px;cursor:pointer;text-align:left;color:#e8eaf6;
      transition:border-color .15s,background .15s;width:100%;font-family:inherit;
    }
    .change-row:hover{background:#14143a;border-color:#4fc3f7;}
    .change-row[aria-pressed="true"]{border-color:#ffeb3b;background:#14143a;}
    .ch-idx{font-size:13px;font-weight:700;color:#4fc3f7;padding-top:2px;}
    .ch-desc{font-size:13px;font-weight:600;margin-bottom:4px;}
    .ch-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
    .ch-period{font-size:11px;color:#9fa8da;}
    .ch-badge{font-size:9px;padding:2px 6px;border-radius:8px;font-weight:700;}
    .badge-hi {background:#0d2e10;color:#81c784;border:1px solid #81c784;}
    .badge-med{background:#2e1f0d;color:#ffb74d;border:1px solid #ffb74d;}
    .badge-lo {background:#2e0d0d;color:#ef9a9a;border:1px solid #ef9a9a;}
    .ch-type-badge{font-size:9px;padding:2px 6px;border-radius:8px;
      background:#1a1a3a;color:#9fa8da;border:1px solid #2e3880;}

    /* Forensic badges (POINT 1 & 2) */
    .ch-section{font-size:10px;color:#80cbc4;background:#0a2622;border:1px solid #2a5a52;
      border-radius:8px;padding:2px 6px;}
    .ch-state-badge{font-size:9px;padding:2px 6px;border-radius:8px;font-weight:700;}
    .st-add{background:#0d2e10;color:#81c784;border:1px solid #81c784;}
    .st-del{background:#2e0d0d;color:#ef9a9a;border:1px solid #ef9a9a;}
    .st-move{background:#0d1e35;color:#4fc3f7;border:1px solid #4fc3f7;}
    .st-replay{background:#2e1f0d;color:#ffb74d;border:1px solid #ffb74d;}
    .st-word{background:#1e0d25;color:#ce93d8;border:1px solid #ce93d8;}
    .st-unclear{background:#1a1a3a;color:#9fa8da;border:1px solid #2e3880;}
    .ch-verify{font-size:9px;padding:2px 6px;border-radius:8px;font-weight:700;}
    .v-ok{color:#81c784;} .v-no{color:#ef9a9a;}
    .ch-verify.v-ok{background:#0d2e10;border:1px solid #81c784;}
    .ch-verify.v-no{background:#2e0d0d;border:1px solid #ef9a9a;}

    .evidence-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;}
    .state-reason{font-size:12px;color:#cfd8e8;margin-bottom:10px;line-height:1.5;}
    .verify-warn{font-size:11px;color:#ef9a9a;margin-top:5px;background:#2e0d0d;
      border-radius:4px;padding:4px 6px;}

    /* A11y audit table (POINT 4) */
    .la{background:#0a2622;color:#80cbc4;border:1px solid #2a5a52;}
    .a11y-verdict{font-size:13px;font-weight:600;margin-bottom:8px;padding:6px 10px;border-radius:5px;
      background:#0f0f28;}
    .verdict-bad{color:#ef9a9a;border-left:3px solid #ef5350;}
    .verdict-good{color:#81c784;border-left:3px solid #81c784;}
    .a11y-table,.coll-table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:8px;}
    .a11y-table th,.coll-table th{text-align:left;color:#9fa8da;font-size:9px;text-transform:uppercase;
      letter-spacing:.04em;padding:4px 6px;border-bottom:1px solid #2e3880;}
    .a11y-table td,.coll-table td{padding:4px 6px;border-bottom:1px solid #13133a;color:#e8eaf6;}
    .a11y-table tr.dir-worse td{color:#ef9a9a;}
    .a11y-table tr.dir-better td{color:#81c784;}

    /* Privacy (POINT 6) */
    .lp{background:#1e0d25;color:#ce93d8;border:1px solid #ce93d8;}
    .privacy-note{font-size:12px;color:#e8eaf6;background:#100a1a;border:1px solid #4a2060;
      border-radius:6px;padding:8px 10px;line-height:1.5;}

    /* Collection (POINT 5) */
    .coll-url{color:#4fc3f7;word-break:break-all;}
    .appear-hist{display:flex;flex-direction:column;gap:3px;}
    .appear-row{display:flex;align-items:center;gap:8px;font-size:11px;}
    .ay-year{color:#9fa8da;width:36px;font-weight:600;}
    .ay-bar{height:12px;background:#4fc3f7;border-radius:3px;min-width:6px;}
    .ay-count{color:#e8eaf6;}

    /* Form additions */
    #form-row3{display:flex;align-items:center;justify-content:space-between;margin-top:8px;gap:10px;flex-wrap:wrap;}
    .check-label{display:flex;align-items:center;gap:6px;font-size:11px;color:#cfd8e8;
      text-transform:none;letter-spacing:0;font-weight:400;cursor:pointer;}
    .check-label input{width:auto;}
    .collection-hint{font-size:10px;color:#5c6bc0;}
    #urlInput{resize:vertical;min-height:38px;font-family:inherit;}

    /* Level 3: Evidence */
    .evidence-grid{display:grid;grid-template-columns:1fr 24px 1fr;
      gap:8px;align-items:start;margin-bottom:10px;}
    .ev-col{background:#0b0b1e;border-radius:6px;padding:10px;}
    .ev-arrow{font-size:18px;color:#5c6bc0;padding-top:20px;text-align:center;}
    .ev-header{font-size:10px;font-weight:700;text-transform:uppercase;
      letter-spacing:.05em;margin-bottom:4px;padding:3px 6px;
      border-radius:3px;display:inline-block;margin-bottom:6px;}
    .before-hdr{background:#0d1e35;color:#4fc3f7;}
    .after-hdr {background:#0d2e10;color:#81c784;}
    .ev-date{font-size:10px;color:#9fa8da;margin-bottom:4px;}
    .ev-text{font-size:12px;line-height:1.5;color:#e8eaf6;font-style:italic;}
    .removed-text{color:#ef9a9a;font-style:italic;}
    .ev-open-btn{display:inline-block;margin-top:6px;font-size:11px;color:#4fc3f7;
      text-decoration:underline;cursor:pointer;}
    .conf-row{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;}
    .conf-reason{color:#9fa8da;font-size:11px;}
    .verify-notes{font-size:11px;color:#cfd8e8;background:#0a2622;border:1px solid #2a5a52;
      border-radius:5px;padding:6px 8px;margin-top:6px;line-height:1.5;}
    .vn-label{color:#80cbc4;font-weight:700;}

    /* Chain-of-verification note (Level 1) */
    .cove-note{font-size:11px;color:#80cbc4;background:#0a2622;border:1px solid #2a5a52;
      border-radius:5px;padding:6px 9px;margin-bottom:10px;line-height:1.5;}
    .cove-note.cove-warn{color:#ffb74d;background:#2e1f0d;border-color:#ffb74d;}

    /* Level 4: Uncertainty */
    .uncertainty-box{background:#100a1a;border:1px solid #4a2060;
      border-radius:6px;padding:10px;}
    .unc-label{font-size:10px;color:#ce93d8;text-transform:uppercase;
      letter-spacing:.04em;font-weight:700;margin-bottom:4px;}
    .unc-text{font-size:12px;color:#e8eaf6;line-height:1.5;}
    .gap-list{list-style:none;margin-top:4px;}
    .gap-list li{font-size:11px;color:#9fa8da;padding:2px 0;}
    .gap-list li::before{content:'⊘ ';color:#ce93d8;}

    /* Level 5: Replay */
    .replay-box{display:flex;align-items:flex-start;gap:8px;
      border-radius:6px;padding:10px;font-size:12px;line-height:1.5;}
    .replay-ok  {background:#0d2e10;border:1px solid #81c784;color:#e8eaf6;}
    .replay-warn{background:#2e0d0d;border:1px solid #ef9a9a;color:#e8eaf6;}
    .replay-icon{font-size:14px;flex-shrink:0;margin-top:1px;}
    .replay-icon.ok{color:#81c784;}

    .nav-hint{font-size:11px;color:#5c6bc0;margin-top:10px;text-align:right;}
    .nav-hint kbd{background:#0f0f28;border:1px solid #2e3880;border-radius:3px;
      padding:1px 4px;font-family:monospace;color:#4fc3f7;font-size:10px;}

    /* Stable / snapshots */
    .stable-list{list-style:none;}
    .stable-list li{font-size:12px;color:#e8eaf6;padding:2px 0;}
    .stable-list li::before{content:'✓ ';color:#81c784;}
    .warn-list{list-style:none;}
    .warn-list li{font-size:12px;color:#ef9a9a;padding:2px 0;}
    .warn-list li::before{content:'⚠ ';}
    .snap-list{list-style:none;display:flex;flex-wrap:wrap;gap:6px;}
    .snap-item{background:#0f0f28;border:1px solid #1e1e48;border-radius:4px;padding:4px 8px;}
    .snap-link{color:#4fc3f7;font-size:11px;text-decoration:underline;}
    .snap-warn{font-size:10px;color:#ffb74d;display:block;margin-top:1px;}

    /* Shortcuts panel */
    .sc-toggle{background:none;border:none;color:#9fa8da;font-size:11px;font-weight:700;
      text-transform:uppercase;letter-spacing:.05em;cursor:pointer;
      width:100%;text-align:left;display:flex;justify-content:space-between;padding:0;}
    .sc-toggle:hover{color:#e8eaf6;}
    .sc-hint{font-weight:400;font-size:10px;opacity:.6;}
    .sc-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px 12px;margin-top:8px;}
    .sc-col{}
    .sc-g-label{font-size:9px;text-transform:uppercase;letter-spacing:.06em;
      color:#4fc3f7;font-weight:700;margin-bottom:3px;opacity:.8;}
    .sc-row{display:flex;align-items:center;gap:5px;margin-bottom:3px;font-size:11px;color:#e8eaf6;}
    .sc-row kbd{background:#0f0f28;border:1px solid #2e3880;border-bottom-width:2px;
      border-radius:3px;padding:1px 5px;font-family:monospace;color:#4fc3f7;
      font-size:10px;min-width:18px;text-align:center;}

    /* Detail placeholder */
    .detail-placeholder{font-size:12px;padding:14px;text-align:center;}

    /* Error */
    .err-card{background:#1f0808;border:1px solid #ef5350;border-radius:6px;
      padding:12px;color:#ef5350;font-size:13px;}
    .err-card strong{display:block;margin-bottom:4px;}

    /* Inner modal */
    .inner-modal{position:absolute;inset:0;background:rgba(0,0,8,.9);z-index:10;
      display:flex;align-items:center;justify-content:center;padding:16px;border-radius:12px;}
    .mbox{background:#12122a;border:2px solid #2e3880;border-radius:8px;
      padding:16px;width:100%;max-width:560px;}
    .mtitle{color:#4fc3f7;font-size:15px;margin-bottom:12px;}
    .ml{display:block;font-size:11px;color:#4fc3f7;font-weight:700;
      text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;}
    .msel{width:100%;padding:7px 9px;background:#0a0a14;border:1px solid #2e3880;
      border-radius:4px;color:#e8eaf6;font-size:12px;margin-bottom:8px;}
    .mpre{color:#e8eaf6;font-size:11px;white-space:pre-wrap;line-height:1.6;
      background:#0a0a14;border-radius:4px;padding:10px;max-height:260px;
      overflow-y:auto;margin-bottom:12px;}
    .mactions{display:flex;gap:8px;}
    .mprimary{flex:1;padding:9px;background:#4fc3f7;color:#000;border:none;
      border-radius:4px;font-weight:700;cursor:pointer;font-size:13px;}
    .mprimary:hover{background:#81d4fa;}
    .msec{flex:1;padding:9px;background:#1a1a3a;color:#e8eaf6;
      border:1px solid #2e3880;border-radius:4px;cursor:pointer;font-size:13px;}

    .dim{color:#9fa8da;font-size:12px;}

    /* Scrollbar */
    #main::-webkit-scrollbar{width:5px;}
    #main::-webkit-scrollbar-track{background:transparent;}
    #main::-webkit-scrollbar-thumb{background:#2e3880;border-radius:3px;}

    @media (prefers-reduced-motion:reduce){
      *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;}
    }
    @media (prefers-contrast:more){
      #panel{border-width:3px;border-color:#66ccff;}
      .change-row{border-width:2px;}
      :focus-visible{outline-width:4px;}
    }
  `;

})();
