# Session Closeout — Mandatory

Run this checklist before ending any Claude Code session on BDRclaw.
This is non-negotiable. Skipping it means the next session starts blind.

## 1. Diff Summary
Write a one-paragraph summary of what changed in this session and why.
List every file modified with a one-line explanation.

## 2. Doc Updates
Check each documentation file and update if anything changed:
- [ ] `docs/claude/TECH_STACK.md` — new dependencies, changed architecture, new key files, new channel/CRM/integration adapter?
- [ ] `docs/claude/PARITY_CHECKLIST.md` — new surface (channel/dashboard page/CRM adapter), changed file paths, new drop point?
- [ ] `docs/claude/DOWNLOAD_FLOWS.md` — pipeline changes, new external service, new sync point between pipelines?
- [ ] `docs/claude/TESTING_PROTOCOL.md` — new test pattern, changed naming, new trigger criteria?
- [ ] `ISA.md` — did any ISC pass, get added, or get tombstoned? (BDRclaw's build system-of-record.)
- [ ] `docs/HANDOFF.md` — update the "where did I leave off" file if the next session needs it.

## 3. Backlog Update
- Mark completed ISCs / issues as done in `ISA.md`.
- Add any new issues discovered during the session (as new ISCs or HANDOFF "Known bugs").

## 4. Test Update
If a visual or functional feature was added/changed:
- Add parity tests per `docs/claude/TESTING_PROTOCOL.md` (one test per surface per feature).
- Run `npm test` (expect the full suite green) and `npm run typecheck` (expect 0 errors) to confirm no regressions.

## 5. Investigation Log
If any non-trivial finding was made during this session:
- Append to `docs/claude/INVESTIGATIONS.md` (see that file's format).
- Include: date, symptom, root cause, fix (with file paths), lesson.

## 6. Commit Message
Include a session closeout summary in the commit message:
`Session closeout: [one-line summary of what was done and documented]`

> Note: the pre-commit hook runs `prettier --write` but does NOT re-stage. Run `npm run format:fix` before committing (see `docs/HANDOFF.md` gotchas).
