# QuoteCompare Implementation Plan

> For agentic workers: use superpowers:executing-plans. Execute the user-authorized implementation inline; independent agent reviews simplicity after code is ready.

**Goal:** Implement all seven screens and 25 v2 operations, build a self-contained Mac app, run backend and desktop end-to-end acceptance, simplify after independent review, and push doinglaundry/quotecompare.

**Architecture:** One React/Electron desktop and one bundled Python/FastAPI service. Six SQLite tables, four business modules, one job executor; no repository/service abstractions or speculative extensions.

**Tech Stack:** JavaScript, React, Electron, Python/FastAPI, SQLite, JSON Schema validation, HTTP model clients, pypdf/pypdfium2, macOS Vision, ReportLab, PyInstaller.

**Spec:** docs/technical/QuoteCompare-technical-design-v2.html; QuoteCompare-openapi-v2.json; database-schema-v2.sql.

## Global Constraints
- Max five quotes/project, 50MB/file, 30 PDF pages. Supported PDF/image/text.
- Preserve union of facts; merge only identical semantic kind/work item/unit/currency/tax basis/coverage. Missing is null, never zero.
- Raw source/latest extraction/current edits separate; immutable historical snapshots preserve source copies.
- Single current OpenAI/Claude/DeepSeek config; keys only in Keychain. No key persistence in logs, tasks, SQLite, files.
- User installs no Python. Controlled IPC only, localhost session authentication, manifest-based file reads.
- Assignments/declarations separate from if conditions. Direct readable code; no unnecessary generic layers.

## Review Focus
- Late/cancelled/interrupted AI results and configuration changes must not overwrite new user edits or silently repeat billable requests.
- Idempotency check before stale-revision check; conflicting input for same request ID fails.
- Cross-project resources and forged source references must fail; matching field names alone does not prove comparability.
- Deleting current quotes keeps historical source copies; deleting projects keeps billed usage.
- Hide-property export redacts report body and appendices; CSV formulas and document prompt injection do not execute.

## Execution ledger
- [x] 1. API and persistence: backend/tests/test_projects.py checks real FastAPI requests, six-table creation, auth, revision/idempotency, ownership, deletes. Implement backend/app.py, database.py, schemas.py, files.py, modules/projects.py. Verify pytest tests.
- [x] 2. Sources and AI: backend/tests/test_analysis.py checks text/PDF/image reading, original block refs, malformed provider outputs, manual edits retained, union/group coverage and typed comparison. Implement providers.py and modules/analysis.py.
- [x] 3. Jobs/settings/ledger: backend/tests/test_jobs.py checks task transitions, restart/cancel/stale results, config busy guard, key redaction, protocol clients for all three providers, usage/null cost/balance. Implement jobs.py and modules/settings.py.
- [x] 4. Snapshots/drafts/reports: backend/tests/test_workflow.py checks comparison truth, immutability, snapshot file survival, question selection, saved draft edits, PDF/CSV/HTML privacy and download. Implement modules/reports.py.
- [x] 5. Seven UI screens: Electron main/preload manages service/files/clipboard; React pages perform actual API actions with all required editing/history/settings/usage interactions. Browser/Electron tests use test-only external model protocol server; production contains no demo fallback.
- [x] 6. Packaging: Python executable bundled by PyInstaller; Electron arm64 app/package produced. Launch with system-only PATH and fresh app-data directory; no installed Python assumption. Provide CI x64/arm64 packaging and signing support.
- [x] 7. Full end-to-end: real app import text/PDF/image -> extraction -> manual edit -> field mapping -> snapshot -> draft -> export -> reload history; settings/provider/cost controls and error cases. Record exact limits of external-provider/signing verification.
- [x] 8. Independent simplification review: send reviewer source and checks; apply warranted simplification with regression tests; commit, integrate main and push, verify remote SHA.

## Rulings
- Existing dedicated repository is clean and contains only docs; implement on a feature branch in that checkout. No need for a second repository or checkout.
- The user's explicit instruction to start and finish implementation is the execution authorization; no repeated plan/merge/push approval prompts.
- Reuse the OpenAPI schemas for validation rather than manually duplicating 47 DTOs. Direct sqlite3 transactions reduce ORM boilerplate while retaining SQLite schema/constraints; update technical rationale to match implementation.
- Automated E2E uses a test-only HTTP protocol server for deterministic model responses, exercising real application clients. Production always calls configured providers. Live account/billing and notarization require credentials unavailable in the repository and will be reported separately.
