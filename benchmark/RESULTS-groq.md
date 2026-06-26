# Benchmark results — Groq `llama-3.1-8b-instant` (deployed model)

Evaluated on the deployed back-end (Groq 8B), scored against a **model-independent,
human-signed-off gold standard** (`gold_truth.json`, 33 real changes across 16
archived page-histories, 143 captures). Candidates surfaced by deterministic diff
(`diff-candidates.js`), adjudicated by a human. Addresses Reviewer R2's W2 (deployed
model), W4 (confidence intervals), W5 (model-independent ground truth).

OpenAI gpt-4o-mini has been dropped entirely; archived in `_archive_openai/`.

Gold standard: **34** human-confirmed changes (`gold_truth.json`). Scoring convention B
(substantive-truth): a report is TP if it states a real substantive edit; recall counts
gold changes with >=1 matching report; news items are FP. Strict one-match-per-gold
convention gives precision 0.56 (recall unchanged) — reported as a robustness note.

## Detection (vs gold standard) — with the hard verbatim gate (shipped)
| Metric | Value | Wilson 95% CI |
|--------|-------|---------------|
| Precision | **68.8%** (11/16) | 44.4% – 85.8% |
| Recall    | **26.5%** (9/34)  | 14.6% – 43.1% |
| F1        | **38.2%**         | — |
| Hallucinated quotes | **0.0%** (0/27) | — |

Per genre (gated): Conf P=0.80 (4/5) R=0.29 (2/7) · DL P=0.60 (3/5) R=0.20 (3/15) ·
Std P=0.33 (1/3) R=0.17 (1/6) · Schol P=1.00 (3/3) R=0.50 (3/6).

### Ablation — hard verbatim gate ON vs OFF (answers W3)
| Config | Precision | Recall | F1 | Hallucination |
|--------|-----------|--------|-----|---------------|
| Gate OFF | 57.1% (12/21) | 29.4% (10/34) | 38.8% | 14.3% |
| **Gate ON (shipped)** | **68.8%** (11/16) | **26.5%** (9/34) | **38.2%** | **0.0%** |

The gate (drop any change whose presented quote scores <0.7 verbatim containment) removes
all 5 hallucinated quotes and 4 junk reports, raising precision +12pts, at the cost of one
real change (`11-crossref`, 64%-grounded quote) → recall −3pts. F1 ~flat. Demonstrates the
verification component's contribution and the "omission over false claim" trade directly.
Runs: `runs-groq/` (gate off) and `runs-groq-gated/` (gate on); `regate.js` re-applies the
gate to saved model outputs with no LLM calls. Per-history audit: `verify_all.js`.

Per genre:
| Genre | Precision | Recall |
|-------|-----------|--------|
| Conference sites   | 100% (5/5) | 16.7% (1/6) |
| DL & archives      | 42.9% (3/7) | 20.0% (3/15) |
| Standards & policy | 20.0% (1/5) | 16.7% (1/6) |
| Scholarly infra    | 100% (4/4) | 66.7% (4/6) |

## Objective metrics (label-free, gated/shipped, from `score-dir.js runs-groq-gated`)
- Quote-grounding: **100%** — hallucinated-quote rate **0.0%** (0/27).
- Confidence distribution: high 4 · medium 11 · low 1.
- **Calibration:** 100% grounded across high/medium/low (every surviving quote is verbatim).
- 3 pages return 0 changes (gutenberg, ndltd, hathitrust) → drives the low recall.
- (Gate OFF for reference: grounding 85.7%, hallucination 14.3%, calibration high/med 100% / low 16.7%.)

## Reading
The deployed 8B model is **conservative**: moderate precision, low recall, ~4× the
hallucination rate of a frontier model — BUT the parameter-free reliability layer keeps
every high/medium change verbatim-grounded and sorts the model's extra errors into
"low". This is the paper's invariant ("a false claim is worse than an omission") working
on the model users actually run: it speaks rarely, but what it asserts with confidence is
trustworthy. Detection performance is therefore not the contribution — the verification/
calibration design and the released gold-standard benchmark are.

Reproduce: `node rerun-groq.js` → `node score-dir.js runs-groq` (objective) + `node groq_eval.js` (detection).
