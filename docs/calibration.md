# Calibrating judges (and the flywheel that improves them)

A judge agent that emits `{"branch": "high", "confidence": 0.9}` is only as
trustworthy as that `0.9` is *true*. Calibration is what turns those numbers from
decoration into something you can route, gate, and act on. Two parts: a harness
that **measures** a judge, and a flywheel that makes the judge **improve from being
used.**

## 1. The harness — measure routing accuracy

A judge's decision is its routed branch, so make the orchestration's output *be*
that branch, then score it exactly against a labeled corpus:

- **`examples/severity-classify.json`** routes an incident through
  `judge-severity` and each branch is a `code` node returning its own name — so
  the run's output is the chosen severity.
- **`datasets/severity-calibration.json`** is labeled incidents
  (`input` = the signal, `expectedOutput` = the human-assigned branch).
- **`evals/severity-calibration.json`** runs the orchestration against the dataset
  with an `exact` scorer. **Pass rate = routing accuracy.**

Run it from the Evals page, or replay the dataset through `/api/runs/start` and
read the `route-decision` branch. The per-row drilldown shows exactly *which*
signals misroute and *in which direction* (inflating vs. deflating) — which is
what you tune the rubric against.

> Measured baseline: `judge-severity` scored **7/12 (58%)** with a *systematic
> deflation bias* (every miss one level low). A principled rubric fix lifted it to
> **9/12 (75%)**; the residual misses were genuinely fuzzy medium/low boundaries.
> Without the harness that bias was invisible.

The pattern generalizes to any router/judge: wrap it so the output is the
decision, label a corpus, score exactly.

### Calibration coverage

Every judge with a closed decision vocabulary has a classify wrapper
(`examples/<judge>-classify.json`), a labeled corpus, and an exact-scored eval.
`judge-completeness` replies with a coverage fraction, so its harness calibrates
against the three anchor scores its rubric documents (`1.0`/`0.5`/`0.0`).

| Judge | Dataset (rows) | Eval | Measured accuracy |
| --- | --- | --- | --- |
| `judge-severity` | `severity-calibration` (12) | `evals/severity-calibration.json` | 58% baseline → **75%** after rubric tuning (re-measured 2026-06-12: 9/12 — all three misses deflate `medium`→`low`) |
| `judge-correctness` | `correctness-calibration` (26) | `evals/correctness-calibration.json` | not yet measured — run the eval |
| `judge-completeness` | `completeness-calibration` (24) | `evals/completeness-calibration.json` | not yet measured — run the eval |
| `judge-convergence` | `convergence-calibration` (24) | `evals/convergence-calibration.json` | not yet measured — run the eval |
| `judge-flake` | `flake-calibration` (24) | `evals/flake-calibration.json` | **100%** (24/24, 2026-06-12) — first pass; add harder borderline rows before trusting the ceiling |
| `judge-release-readiness` | `release-readiness-calibration` (24) | `evals/release-readiness-calibration.json` | **100%** (24/24, 2026-06-12) — first pass; a perfect first score means the corpus isn't discriminating yet |
| `judge-blast-radius` | `blast-radius-calibration` (24) | `evals/blast-radius-calibration.json` | not yet measured — run the eval |

## 2. The flywheel — corrections grow the corpus

A frozen 12-row dataset isn't real calibration. The loop that makes calibration
*compound* is: a human overrides a judge, that override becomes a labeled row, and
the next eval measures against it.

```
  judge routes a signal            (predicted branch)
        │
   human overrides at a gate       (the correct branch)
        │  POST /api/corrections   (or: sammy-cli record-correction)
        ▼
   labeled row appended to the calibration dataset   (corpus grows, deduped)
        │
        ▼
   re-run the eval → accuracy re-measured against real misroutes → tune
```

- **`POST /api/corrections`** `{ datasetName, corrected, runId? | input?, predicted? }`
  appends (or updates, deduped by input) a row tagged `correction` in the named
  calibration dataset. Pass a `runId` and the `input` + `predicted` are derived
  from that run (`deriveDecision` reads the run's initial input + last
  `route-decision`), so the human only supplies the corrected label.
- **CLI:** `sammy-cli record-correction --dataset severity-calibration --corrected critical --run <id>`
- **Capture point:** the reactive flows already route ambiguous/low-confidence
  cases to a human (`lock` gates, `default` branches). Whoever handles that
  escalation is the labeler — their correction is the training signal.
- Implementation: `src/server/corrections-store.ts` (unit-tested); persistence
  reuses the file-backed dataset format, no new store.

The result: the system gets **more calibrated the more it runs**, because every
human disagreement becomes ground truth. That is the difference between a judge
that's good today and one that's better every week — and it's the durable
counterpart to the run-time recall in [`context-engineering.md`](./context-engineering.md)
(`memory-reader`/`memory-writer`).
