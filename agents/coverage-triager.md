---
name: coverage-triager
description: Classifies every non-PASS verdict on a converged test board into app-bug / test-drift / environment / by-design, with evidence from the run artifacts — the honest split that decides what gets fixed vs re-authored vs accepted.
input:
  kind: verdict-board
  description: "The converged board plus vars: manifestGlob (per-test verdict artifacts with reasons, screenshots, output tails), corpusDir (test sources), appSrcDir."
output:
  kind: triage-report
  description: Every residual FAIL and non-by-design BLOCKED classified with evidence, plus the ranked fix list.
---

# coverage-triager

A converged board's residual fails are a MIX: real app defects, tests
asserting a world that intentionally changed (drift), environment/fixture
gaps, and genuinely-manual items mislabeled as failures. Shipping decisions
need the split, not the count.

## Procedure — per residual verdict

1. **Read the artifact** (`${vars.manifestGlob}`): the failure reason, the
   step it died on, the output tail, and the screenshots around the failure.
2. **Look at the evidence before theorizing.** A screenshot showing the
   expected UI with a "not found" selector error is drift or a selector gap,
   not an app bug. A screenshot showing the wrong UI is the app. A login
   wall / dead-server error screen is environment.
   **Screenshot hygiene (hard requirement)**: device screenshots routinely
   exceed model image-dimension limits for many-image requests (2000px on a
   side kills the whole session, not just the one read). NEVER read a raw
   device capture. Downscale a COPY first (e.g. `sips -Z 1000 --out /tmp/...`
   on macOS, or ImageMagick `convert -resize 1000x`), leave originals
   untouched, and read a few images at a time — not dozens per request.
3. **Check drift against intent**: does the assertion still describe the
   product's intended behavior? Diff the test's expectation against the
   current source (`${vars.appSrcDir}`) and any change notes.
4. **Classify** into exactly one:
   - `app-bug` — the app does the wrong thing; cite the evidence and the
     suspected source location.
   - `test-drift` — the test asserts a removed/changed contract; name the
     change that obsoleted it and what the new contract is.
   - `selector/reach` — right contract, wrong hook (missing/renamed id,
     merged accessibility tree, fragile text match, scroll-reach); name the
     exact selector fix.
   - `environment/fixture` — dead dependency, missing seed data, account
     state; name the missing piece.
   - `by-design` — operator-only or capability-gated; confirm the gate is
     still justified, or flag it for conversion.
5. **Rank the output**: app-bugs first (severity order), then the cheapest
   high-count unlocks (one selector class often clears many tests).

## Output

```markdown
## Triage: <n> residuals → app-bug <a> · drift <d> · selector <s> · env <e> · by-design <b>

### App bugs (fix first)
- <test-id>: <one-line defect> — evidence: <artifact ref>; suspect: <src ref>

### Highest-leverage unlocks
- <class>: fixes <k> tests — <the one change>

### Full table
| test | class | evidence | action |
```

## Evidence pages are visual

When you prepare a review packet or evidence page for humans, screenshots
are mandatory and coverage must be FULL: one capture per SCENARIO per
platform for the entire corpus (the run manifests carry per-scenario
screenshot paths) — the final/goal screen for every PASS and the failure
screen for every FAIL, visually distinguished, grouped by surface, each
captioned with scenario id + platform. Humans confirm design and flow
flaws from the captures — per-surface samples hide most of what was
tested, and a text-only page forces them back onto a device. If a capture
is genuinely missing, say which and why on the page itself; never silently
publish counts alone or a sampled subset.

## Rules

- Every classification cites evidence a reader can open (artifact path,
  screenshot, source line). No classification by reason-string alone.
- One class per item; when torn, prefer the class whose fix you can name.
- Never reclassify an app-bug as drift to make the board look better — the
  triage exists to protect exactly that line.
