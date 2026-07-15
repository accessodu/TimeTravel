
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, 'runs-groq');     // same captures as runs/
const OUT = path.join(__dirname, 'worksheets');
const CAP = 6000;                                  // chars shown per snapshot

const GENRE = {
  '01-jcdl':'Conference sites','07-sigir':'Conference sites',
  '02-dlib':'Digital libraries & archives','03-gutenberg':'Digital libraries & archives',
  '04-archive':'Digital libraries & archives','05-dp':'Digital libraries & archives',
  '06-europeana':'Digital libraries & archives','10-loc':'Digital libraries & archives',
  '12-ndltd':'Digital libraries & archives','15-hathitrust':'Digital libraries & archives',
  '08-w3':'Standards & policy','09-openai':'Standards & policy','13-ada':'Standards & policy',
  '11-crossref':'Scholarly infrastructure','14-plos':'Scholarly infrastructure','16-doaj':'Scholarly infrastructure',
};
const fmt = d => new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'});
const squash = t => String(t||'').replace(/\s+/g,' ').trim();

fs.mkdirSync(OUT, { recursive: true });
const files = fs.readdirSync(SRC).filter(f=>/^\d+.*\.json$/.test(f)).sort();

for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
  const id = f.replace(/\.json$/, '');
  const snaps = r._rescore.snapshots;
  const period = `${fmt(snaps[0].date)} → ${fmt(snaps[snaps.length-1].date)}`;

  let md = `# Gold-standard worksheet — ${id}\n\n`;
  md += `- **URL:** ${r.url}\n- **Genre:** ${GENRE[id]||'Other'}\n- **Period:** ${period}\n`;
  md += `- **Snapshots:** ${snaps.length}\n\n`;
  md += `> Read the snapshots below oldest→newest and list the REAL, substantive changes a\n`;
  md += `> reader would notice. Do NOT look at any system output. A change is substantive if\n`;
  md += `> the page's authors actually edited meaning/content — NOT archive artifacts\n`;
  md += `> (truncated/empty captures, scrambled emails, duplicated nav, replay noise).\n\n`;
  md += `---\n\n## Snapshots\n\n`;

  snaps.forEach((s, i) => {
    const txt = squash(s.fullText);
    md += `### Snapshot ${i+1} — ${fmt(s.date)}\n`;
    md += `<sub>${s.url}</sub>\n\n`;
    if (!txt || txt.length < 100) {
      md += `_[empty / failed capture — do not diff this snapshot]_\n\n`;
    } else {
      const shown = txt.slice(0, CAP);
      md += '```\n' + shown + (txt.length > CAP ? `\n…[truncated, ${txt.length-CAP} more chars]` : '') + '\n```\n\n';
    }
  });

  md += `---\n\n## GOLD CHANGES — fill this in (blind to any model)\n\n`;
  md += `One row per real change. Leave the table with only the header if there are NO real changes.\n\n`;
  md += `| # | From date | To date | Section (or —) | Description of the real change |\n`;
  md += `|---|-----------|---------|----------------|--------------------------------|\n`;
  md += `| 1 |           |         |                |                                |\n`;
  md += `| 2 |           |         |                |                                |\n\n`;
  md += `**Annotator:** ____________   **Date:** ____________\n`;

  fs.writeFileSync(path.join(OUT, `${id}.md`), md);
  console.log(`  worksheets/${id}.md   (${snaps.length} snapshots, ${period})`);
}

// Protocol README
const readme =
`# Gold-standard annotation protocol (Way B)

**Goal:** build a model-INDEPENDENT list of the real changes on each of the 16 pages,
so precision/recall can be scored fairly against both gpt-4o-mini and Groq, and a
second annotator can be added for Cohen's κ. Fixes Reviewer R2's W5.

## How to annotate
1. Open one \`NN-name.md\` worksheet at a time.
2. Read the snapshots oldest→newest. **Do not** look at any system output first (stay blind).
3. In the **GOLD CHANGES** table, write each real, substantive change the authors made:
   wording/policy/content edits, additions, removals, restructurings that change meaning.
4. **Exclude artifacts:** empty/failed captures, truncated text, archive-scrambled emails
   (\`[email protected]\`), duplicated navigation, replay noise. These are NOT real changes.
5. If a page has no real changes, leave the table empty (header only).

## Two-annotator option (recommended for the full paper)
- A second person fills the SAME worksheets independently (copy the folder).
- We then reconcile and report inter-annotator agreement (Cohen's κ).
- Even half the pages double-annotated lets you honestly report κ.

## After annotation
Hand the filled worksheets back; the scorer matches each model's reported changes to
your gold list → TP (matched), FP (model-only), FN (gold-only / missed).

Snapshot texts are capped at ${CAP} chars for readability; long captures are marked
\`[truncated]\` — a documented limitation to state in the paper.
`;
fs.writeFileSync(path.join(OUT, 'README.md'), readme);
console.log(`\nWrote ${files.length} worksheets + README → ${OUT}`);
