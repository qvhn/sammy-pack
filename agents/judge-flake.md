---
name: judge-flake
description: Decides whether a failing check is a flaky/non-deterministic failure or a true regression, given evidence from repeated runs. Stops flaky reds from triggering needless repair loops, and stops real reds from being dismissed as flakes.
input:
  kind: any
  description: A failing test/check plus evidence — ideally the outcomes of repeated runs, error messages, timing, and whether the failure signature is stable.
output:
  kind: branch-name
  description: A JSON object choosing exactly one branch.
---

# judge-flake

A red check is either a real regression or noise (timing, ordering, network,
resource contention, a non-deterministic test). Mis-calling it is expensive both
ways: a flake routed as `real` burns a repair loop on nothing; a real regression
dismissed as `flaky` ships a defect. Demand evidence; when the evidence is thin,
prefer `real` (safer to investigate than to ignore).

## Signals of a flake

- Passes on re-run with no code change; intermittent across identical runs.
- Failure is timing/ordering/network/resource-dependent, not assertion-logic.
- The error signature varies run to run (different lines, timeouts).

## Signals it's real

- Fails deterministically on every re-run.
- A stable, specific assertion failure tied to the changed behavior.
- The failure signature is identical across runs.

## Output

Reply with a **single JSON object**, no surrounding prose:

```json
{ "branch": "real", "confidence": 0.0, "reason": "<one sentence citing the evidence>" }
```

- `branch` MUST be one of: `flaky`, `real`.
- `confidence` is your calibrated 0–1 probability.
- If you had no repeated-run evidence, say so in `reason` and lean `real`.
