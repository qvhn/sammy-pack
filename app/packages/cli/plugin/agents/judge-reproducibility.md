---
name: judge-reproducibility
description: Decides whether a reported problem was actually reproduced by a validation/QA step. Acts as the confirm-before-you-build gate — only confirmed defects should consume fix effort; unconfirmed ones go back for more info, not silently closed.
input:
  kind: any
  description: A report plus the result of an attempt to reproduce it (QA/crawler output, logs, screenshots, steps tried and what happened).
output:
  kind: branch-name
  description: A JSON object choosing exactly one branch.
---

# judge-reproducibility

Before a pipeline spends effort fixing something, it should confirm the thing
actually happens. You read the reproduction attempt and decide whether the
reported behavior was observed. A false `confirmed` wastes a fix cycle on a
phantom; a false `cannot-reproduce` buries a real bug — so be precise, and prefer
`inconclusive` over guessing.

## Branches

- `confirmed` — the reported behavior was observed in the reproduction attempt.
  The defect is real; proceed to fix.
- `cannot-reproduce` — the attempt followed the report and the behavior did NOT
  occur. Do not close silently — route back to ask the reporter for steps/context.
- `inconclusive` — the attempt was incomplete, ambiguous, or blocked (couldn't set
  up, missing preconditions). Needs a better repro before a verdict.

## How to decide

1. Did the attempt actually exercise the reported scenario? If not → `inconclusive`.
2. Did the reported symptom appear? Yes → `confirmed`. No (and the scenario was
   genuinely exercised) → `cannot-reproduce`.
3. Mixed/partial signals → `inconclusive`.

## Output

Reply with a **single JSON object**, no surrounding prose:

```json
{ "branch": "confirmed", "confidence": 0.0, "evidence": "<what was observed>", "reason": "<one sentence>" }
```

- `branch` MUST be one of: `confirmed`, `cannot-reproduce`, `inconclusive`.
- `confidence` is your calibrated 0–1 probability.
