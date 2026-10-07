# Full E2E and simplification plan

> Execution: implement directly in this session using test-first fixes and regression checks.

**Goal:** Verify every v2 user operation and error/recovery path through the desktop boundary, then simplify production code without removing guarantees.

**Architecture:** Keep one local Python process, four feature modules, six tables, and the existing IPC/API contract. Test models at the external HTTP boundary; keep test controls out of production.

**Spec:** docs/technical/QuoteCompare-technical-design-v2.html and QuoteCompare-openapi-v2.json.

## Constraints
- No model keys in code or logs; real account tests remain unverified without explicit credentials.
- Preserve complete field union, typed alignment, immutable source/snapshots, revisions, cancellation, billing records, and Keychain.
- Use clear names and direct calls, not new generic layers. Count production lines and bytes; do not compress readable statements to game line counts.
- Keep declarations and assignments separate from conditions.

## Work
- [x] Add tests/e2e/coverage.cjs: project status/delete/switch, all file import entrances and limits, manual typed fact editing/add/remove, re-extraction confirmation, split/merge mapping, all comparison states/filters/history/evidence, draft question/language/contractor selection and persistence, report options/save/cancel, single model configuration, usage/date/generation/balance/billing, cancellation/errors/restart.
- [x] Extend tests/e2e/server.py with external provider delay/failure/malformed/missing-usage scenarios. No production test methods.
- [x] Run desktop and backend baseline. Reproduce failures before minimal fixes.
- [x] Simplify main.jsx repeated pagination/file loading/state names, main.cjs request names, jobs.py repeated completion updates, analysis/projects repeated hashes and response construction only where simpler. Run regression after each coherent change.
- [x] Rebuild bundled app and execute packaged tests, preserving the distinction between UI tests and packaged smoke tests.
- [x] Publish per-operation evidence and exceptions; push verified code and a refreshed download.

## Review focus
1. Unsaved state must not leak between quotes/projects; late polling must not update the wrong draft/snapshot.
2. Saved manual changes need an explicit re-extraction confirmation, including pending facts.
3. Cancel/restart never submits another billable request automatically; unknown usage stays unknown.
4. Deleted quotes retain historical source evidence; deleted projects retain usage.
5. CSV/PDF/privacy/source toggles and dialog cancellation must affect actual exported files.
