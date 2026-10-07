# Frontend simplification plan

> Execution: implement directly in this session, as requested by the user. Baseline: 5974099.

**Goal:** Remove repeated React option markup, event bodies and fragmented filter/confirmation state while preserving all seven screens and desktop operations.
**Architecture:** Existing React/Electron and 25-operation IPC contract. One small Select component for static label dictionaries; existing native selectors remain for dynamic data. No new state library, dependency or backend change.
**Spec:** AGENTS.md and docs/technical/QuoteCompare-technical-design-v2.html.

## Constraints
- Preserve labels, option order, values, disabled controls, limits and local file behavior.
- Keep revisions, explicit overwrite approval, pending comparison approval, immutable edits, billing guards and task recovery.
- Measure readable source bytes and avoid compressing statements to manufacture a lower line count.
- Keep assignment out of conditions; no new behavior except equivalent frontend organization.

## Work
- [x] Run baseline desktop acceptance and existing duplicate-read regression.
- [x] Share static Select rendering; keep all existing labels/values and DOM attributes.
- [x] Share quote selection and comparison saving; use one re-extraction modal carrying quote IDs.
- [x] Group usage filters into one object while preserving date conversion, provider and generation filtering.
- [x] Run build, complete desktop coverage, reads, recovery and backend regression; independent review the diff.
- [x] Rebuild and verify actual Mac package, record evidence and refresh download.

## Review focus
- Entering the pending comparison dialog does not save a snapshot; closing it does not approve it.
- Re-extraction of one quote cannot replace the other quotes; all-quote confirmation keeps its original ID list.
- Select defaults/values and disabled fieldsets remain unchanged, including blank provider filter.
- Quote selection resets source highlighting and preserves the selected contractor/source data.
- Blank date/provider/generation filters are omitted; date timezone and inclusive end date match the baseline.
- Existing task polling, cancellation, restart and file URL cleanup remain intact.
