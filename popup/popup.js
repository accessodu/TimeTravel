'use strict';

/* ── Init ─────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {

  // Pre-fill URL from active tab (strip Wayback wrapper)
  try {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (tab?.url && !/^(chrome|edge|about|data|blob):/.test(tab.url)) {
      document.getElementById('urlInput').value = stripWayback(tab.url);
    }
  } catch (_) {}

  // Show platform shortcut
  const isMac = /mac/i.test(navigator.platform);
  document.getElementById('shortcutHint').textContent = isMac ? '⌥⇧T' : 'Alt+Shift+T';

  // Restore saved settings
  try {
    const s = await chrome.storage.local.get(['aiProvider','groqKey','ollamaModel']);
    if (s.aiProvider)  document.getElementById('providerSelect').value = s.aiProvider;
    if (s.groqKey)     document.getElementById('groqKey').value = s.groqKey;
    if (s.ollamaModel) document.getElementById('ollamaModel').value = s.ollamaModel;
    toggleProvider(s.aiProvider || 'groq');
  } catch (_) {}

  document.getElementById('providerSelect').addEventListener('change', e => toggleProvider(e.target.value));
  document.getElementById('analyzeBtn').addEventListener('click', launch);
  document.getElementById('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') launch(); });
});

/* ── Launch overlay with URL ──────────────────────────────────────── */
async function launch() {
  const rawUrl = stripWayback(document.getElementById('urlInput').value.trim());
  if (!rawUrl) { showFeedback('Please enter a URL.', 'error'); return; }
  if (!/^https?:\/\//i.test(rawUrl)) {
    showFeedback('URL must start with https:// or http://', 'error'); return;
  }

  // Save settings
  const provider    = document.getElementById('providerSelect').value;
  const groqKey     = document.getElementById('groqKey').value.trim();
  const ollamaModel = document.getElementById('ollamaModel').value.trim() || 'llama3.2';
  try { await chrome.storage.local.set({aiProvider:provider, groqKey, ollamaModel}); } catch (_) {}

  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true;
  btn.textContent = '⟳ Opening overlay…';

  // Ask background to inject overlay into active tab, then start analysis
  chrome.runtime.sendMessage(
    {type:'LAUNCH_AND_ANALYZE', url:rawUrl, provider, groqKey, ollamaModel},
    res => {
      btn.disabled = false;
      btn.textContent = '⧉ Open Full Analysis Overlay';
      if (res?.ok) {
        window.close(); // close popup — overlay is now showing
      } else {
        showFeedback(res?.error || 'Could not open overlay. Make sure you are on a regular webpage.', 'error');
      }
    }
  );
}

/* ── Helpers ──────────────────────────────────────────────────────── */
function stripWayback(url) {
  try {
    const u = new URL(url.trim());
    if (u.hostname === 'web.archive.org') {
      const m = u.pathname.match(/^\/web\/[^/]+\/(.+)$/);
      if (m) return m[1];
    }
  } catch {}
  return url.trim();
}

function toggleProvider(p) {
  document.getElementById('groqSettings').hidden   = p !== 'groq';
  document.getElementById('ollamaSettings').hidden = p !== 'ollama';
}

function showFeedback(msg, type='info') {
  const el = document.getElementById('feedback');
  el.textContent = msg;
  el.className = type;
  el.hidden = false;
  // Also announce to screen reader
  const sr = document.getElementById('sr-alert');
  sr.textContent = '';
  setTimeout(() => sr.textContent = msg, 80);
}
