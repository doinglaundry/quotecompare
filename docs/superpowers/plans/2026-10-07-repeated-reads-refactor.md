# Repeated reads refactoring plan

> Execution: implement inline in this session, as requested by the user.

**Goal:** Remove verified duplicate reads and simplify modal/key handling without changing the 25-operation API contract.
**Architecture:** Keep one local Python service, four business modules and six tables. Reuse response data directly; do not introduce generic stores, repositories or dispatch registries.
**Tech Stack:** JavaScript/React/Electron, Python/FastAPI/sqlite3.
**Spec:** docs/technical/QuoteCompare-openapi-v2.json; AGENTS.md; the six accepted review findings in this conversation.

## Constraints
- Preserve full field union, immutable evidence/snapshots, project ownership, revisions, idempotency, cancellation, usage accounting and Keychain.
- Separate assignments from conditions. Avoid compressed statements solely to reduce line counts.
- No real model calls or account charges in tests; provider fixtures remain external HTTP test services.

## Review focus
- History pages must retain the exact Comparison payload, ordering, cursors, missing-project errors and current is_stale flags.
- Draft submission must reject other contractors' questions before queuing; execution still reads and validates its snapshot.
- Report redaction must never mutate saved snapshots, including appendix strings.
- Frontend must keep editable mappings separate from saved project data; quote save must retain source evidence and selected quote.
- Omitted API Key, explicit null and provider change remain distinct; modal conversion must preserve confirmation/cancel paths.

## Work
- [x] Add backend/tests/test_reads.py: real API/SQLite trace verifies bounded history reads and one draft snapshot read before queueing; exercise stale pages and invalid questions. Run and observe expected failures.
- [x] Add tests/e2e/reads.cjs: actual desktop reload/save/reload with request logs verifies no redundant mapping/quote read and persisted manual facts. Run and observe expected failures.
- [x] Change analysis.list_comparisons to fetch project and snapshot rows once under the database lock; reuse project revision when assembling pages.
- [x] Remove the extra draft submission snapshot read; remove report deepcopy; express settings Key selection as explicit branches.
- [x] Use project response to populate editable mappings, use updateQuote response in saveFacts, standardize all modals to objects with type.
- [x] Run backend, desktop coverage, recovery, new read tests and build. Ask the authorized reviewer to check the diff.
- [x] Rebuild app, run packaged acceptance, refresh download/evidence, commit and push; verify remote SHA.

## Execution evidence
- RED: backend history page had6 SELECTs for2 items; draft had2 snapshot SELECTs. Desktop first failed on redundant field-mappings read, then on redundant quote read.
- GREEN: both backend read regressions passed; desktop read regression passed with persisted1350/original1200 and no duplicate GETs.
- Full verification:21 backend tests, original seven-page E2E,25 coverage scenarios, recovery and reads all passed; build and packaged core acceptance passed.
- Independent review: no blocker; report input unchanged and field editing uses new arrays/objects. Existing save-success/project-refresh-failure boundary retained as documented.
- Measured5 snapshots:12→2 SELECTs. No schema/API changes.
