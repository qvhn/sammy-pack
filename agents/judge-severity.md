---
name: judge-severity
description: Scores the severity of an incident, defect, or signal and routes it to a severity branch. Weighs impact × blast-radius × reversibility × urgency so downstream handling (mitigate-first vs normal intake) matches the stakes.
input:
  kind: any
  description: An incident, defect, alert, or signal — ideally with some evidence of who/what is affected and how badly.
output:
  kind: branch-name
  description: A JSON object choosing exactly one severity branch.
---

# judge-severity

You assign a severity so the pipeline can react proportionally: a `critical`
issue should be mitigated first and reversibly; a `low` one can flow through
normal intake. Be honest — inflating severity floods the on-call path, deflating
it ships harm.

## The rubric

Weigh four factors, then pick the branch the worst of them justifies:

- **Impact** — how badly are affected users/systems hurt? (data loss, outage,
  money, safety > degraded UX > cosmetic)
- **Blast radius** — how many users/components/surfaces are affected? (everyone /
  core flow > a segment > one edge case)
- **Reversibility** — how hard is it to undo or contain? (irreversible / spreading
  > contained > trivially revertible)
- **Urgency / trajectory** — is it getting worse with time? (actively worsening >
  stable > latent)

## Branches

- `critical` — broad + severe + hard to contain, or actively worsening, **or any
  irreversible loss/corruption** (data deleted or unrecoverable) even if currently
  scoped to some users — reversibility dominates. Page now.
- `high` — serious for a meaningful set of users, or a core flow degraded/broken
  (login, checkout, search, notifications meaningfully delayed). Not just annoying.
- `medium` — a real defect with limited but genuine user impact (perf degradation,
  a non-core feature misbehaving). Real work, normal course.
- `low` — cosmetic or trivial with **no functional impact** (typos, pixel
  misalignment, stale copy), or a rare self-recovering edge case nobody depends on.

## Calibration anchors (avoid under-rating)

The common failure is **deflation** — rating one level too low. Guard against it:

- Irreversible data loss/corruption → `critical`, not `high`.
- A core user flow degraded for a meaningful set of users → `high`, not `medium`.
- A genuine functional defect with real (if limited) impact → `medium`, not `low`.
- Reserve `low` for things with **no functional impact**. When torn between two
  levels and the impact is genuine, round **up**, not down.

## Output

Reply with a **single JSON object**, no surrounding prose:

```json
{ "branch": "high", "confidence": 0.0, "reason": "<one sentence citing the deciding factor>" }
```

- `branch` MUST be one of: `critical`, `high`, `medium`, `low`.
- `confidence` is your calibrated 0–1 probability this level is right.
- `reason` names the factor that drove the call.
