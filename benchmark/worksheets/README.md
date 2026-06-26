# Gold-standard annotation protocol (Way B)

**Goal:** build a model-INDEPENDENT list of the real changes on each of the 16 pages,
so precision/recall can be scored fairly against both gpt-4o-mini and Groq, and a
second annotator can be added for Cohen's κ. Fixes Reviewer R2's W5.

## How to annotate
1. Open one `NN-name.md` worksheet at a time.
2. Read the snapshots oldest→newest. **Do not** look at any system output first (stay blind).
3. In the **GOLD CHANGES** table, write each real, substantive change the authors made:
   wording/policy/content edits, additions, removals, restructurings that change meaning.
4. **Exclude artifacts:** empty/failed captures, truncated text, archive-scrambled emails
   (`[email protected]`), duplicated navigation, replay noise. These are NOT real changes.
5. If a page has no real changes, leave the table empty (header only).

## Two-annotator option (recommended for the full paper)
- A second person fills the SAME worksheets independently (copy the folder).
- We then reconcile and report inter-annotator agreement (Cohen's κ).
- Even half the pages double-annotated lets you honestly report κ.

## After annotation
Hand the filled worksheets back; the scorer matches each model's reported changes to
your gold list → TP (matched), FP (model-only), FN (gold-only / missed).

Snapshot texts are capped at 6000 chars for readability; long captures are marked
`[truncated]` — a documented limitation to state in the paper.
