## What and why

<!-- What changes, and what problem it solves. If it fixes a defect, say what
     was broken and how it showed up — the commit history here leans on that. -->

## Checks

- [ ] `cd app && npm run ci` passes (typecheck + tests + web build)
- [ ] New tests **fail without the change** (reverted it and confirmed)
- [ ] Nothing app-, company- or deployment-specific added — see `AGENTS.md`
- [ ] Files staged by explicit path (no `git add -A`)
- [ ] If a queue-source adapter or the store layer changed:
      `npm run test:integration` / `npm run test:postgres` with the compose
      stack up

## Notes

<!-- Trade-offs, anything deliberately left out, follow-ups. -->
