# TimeTravel-A11y

A screen-reader-first browser extension that narrates **what changed** across a web page's
Wayback Machine history to blind users — and refuses to speak any quotation that is not
present verbatim in the archived capture it cites. This repository accompanies the paper
*"Trustworthy Non-Visual Narration of Web-Archive Change for Blind Screen Reader Users"* and
contains both the system and the evaluation benchmark.

> Anonymized for double-blind review. Author/affiliation/license-holder fields are
> intentionally left blank.

## Repository layout

```
extension/        The system — a Manifest V3 browser extension
  manifest.json
  background/      service worker: CDX queries, capture replay, classifyWithAI,
                   verbatim gate, archival-state classifier, reliability label
    secret.local.example.js   ← copy to secret.local.js and add your own key
  content/        the screen-reader overlay (Shadow DOM, ARIA live regions, keyboard nav)
  popup/  icons/

benchmark/        The evaluation resource (everything needed to reproduce the numbers)
  score.js            gold-free metrics: hallucinated-quote rate, label faithfulness
  verify_all.js       detection precision/recall/F1 + Wilson CIs + per-genre
  ablate.js           stage ablation harness (toggle chain-of-verification / self-consistency)
  rerun-groq.js       re-run the pipeline headless over saved snapshots
  regate.js, score-dir.js, diff-candidates.js, groq_eval.js, make-worksheets.js
  gold_truth.json     the human-adjudicated reference set of substantive changes
  worksheets/         the 16 per-site adjudication worksheets (snapshots + decisions)
  runs-groq/          full-pipeline model outputs (16 histories)
  runs-groq-gated/    shipped configuration (verbatim gate on)
  runs-abl-noCoVe/    ablation: chain-of-verification removed
  runs-abl-noSC/      ablation: self-consistency removed (K=1)
  ARCHIVE_LINKS.md    the Wayback capture URLs, axe-audit.md, RESULTS-groq.md
```

## Running the extension

1. `cp extension/background/secret.local.example.js extension/background/secret.local.js`
   and paste a free [Groq](https://console.groq.com) key (or set the provider to `ollama`
   for a fully local model).
2. Load `extension/` as an unpacked extension (Chrome: `chrome://extensions` → *Developer
   mode* → *Load unpacked*).
3. Open the toolbar popup, enter a URL and a provider, and run.

No API key is bundled; `secret.local.js` is `.gitignored`.

## Reproducing the evaluation

The model-free layer (change-point selection, TF–IDF cosine, bigram quote verification,
archival-state classification, scoring) is deterministic and reproduces exactly from the
released runs — **no API key needed** to re-score:

```bash
cd benchmark

# Gold-free metrics (no reference set required):
node score.js runs-groq-gated      # shipped: hallucinated-quote rate 0/27 = 0.0%
node score.js runs-groq            # ungated:                       5/35 = 14.3%

# Detection vs the reference set (precision/recall/F1, Wilson CIs, per-genre):
node verify_all.js
```

Re-running the model itself (optional, **requires `GROQ_KEY`**) reuses each run's saved
captures — no Wayback re-fetch:

```bash
GROQ_KEY=gsk_... node rerun-groq.js            # full pipeline → runs-groq/
GROQ_KEY=gsk_... NO_COVE=1 OUT=runs-abl-noCoVe node ablate.js   # ablate CoVe
GROQ_KEY=gsk_... SC_K=1   OUT=runs-abl-noSC   node ablate.js   # ablate self-consistency
```

## On the reference set

`gold_truth.json` is a **human-adjudicated, convention-dependent** list of substantive
changes: a deterministic sentence-level diff surfaces candidates, which a human annotator
keeps or rejects by reading the captures (excluding archival artifacts and routine churn).
It is used **only** for the secondary detection result. The central claim — the
hallucinated-quote rate — needs no reference set: a spoken quote is either present in the
public capture or it is not, and every capture URL is in `ARCHIVE_LINKS.md`.

## Requirements

Node.js ≥ 18 (for the scoring scripts; they use only the standard library). A Chromium-based
browser for the extension.
