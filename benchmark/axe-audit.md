# axe-core accessibility audit of the live overlay

Run this on the **real, loaded extension** — it's the most accurate way to get the
WCAG numbers for §6.

## Steps
1. Open a **simple page with no strict CSP** so the console can load axe from a CDN —
   `http://example.com/` works well (avoid Google/GitHub/news sites, which block it).
2. Open the overlay (`Alt+Shift+T`) and run one analysis (e.g. `https://www.jcdl.org/`,
   2015–2024) so the full results UI (Levels 1–5, evidence, uncertainty) is rendered.
3. Open DevTools → Console, paste this, press Enter:

```js
(function () {
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js';
  s.onload = async () => {
    const host = document.getElementById('tt-a11y-host');
    if (!host) { console.warn('Open the overlay (Alt+Shift+T) and run an analysis first.'); return; }
    const res = await axe.run(host, { resultTypes: ['violations'] });
    const byImpact = {};
    res.violations.forEach(v => byImpact[v.impact] = (byImpact[v.impact] || 0) + 1);
    console.log('=== axe-core on TimeTravel-A11y overlay ===');
    console.log('total violations:', res.violations.length, byImpact);
    console.table(res.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })));
  };
  document.head.appendChild(s);
})();
```

4. **Report back:** the `total violations` line + the impact breakdown (critical /
   serious / moderate / minor). Paste the console output and I'll fill §6's a11y
   subsection with the real numbers.

If example.com still blocks the CDN, install the free **axe DevTools** browser
extension, open the overlay, and click *Scan* — same result, no CDN needed.
