Pulse Housekeeping - Safe Delete Process (Pass #1)

Scope
- This branch is Pass #1 of a two-pass cleanup. Only moves to `/_quarantine/2025-08-22/**` are allowed; no permanent deletions.
- Any code-line removals are prohibited in Pass #1. If a line appears dead, annotate it using the quarantine comment protocol and defer actual removal to Pass #2 after approval.

Quarantine Policy
- Quarantine roots (created on-demand):
  - `/_quarantine/2025-08-22/backend/`
  - `/_quarantine/2025-08-22/frontend/`
  - `/_quarantine/2025-08-22/misc/`
- Files are moved, not deleted. Paths are preserved under the corresponding quarantine root.
- Quarantine lifetime SLA: retain at least 7 days before permanent deletion (Pass #2).

Undo / Restore Plan
- To restore any item moved to quarantine:
  1) Identify the original relative path from `housekeeping/DELETION_CANDIDATES.csv` (column: `undo_path`).
  2) Move the file back to its original location using the commands below.

Examples (PowerShell):
```powershell
# Restore a backend file
New-Item -ItemType Directory -Force -Path .\backend\src\some\dir | Out-Null
Move-Item -Force .\_quarantine\2025-08-22\backend\src\some\dir\file.ts .\backend\src\some\dir\file.ts

# Restore a frontend file
New-Item -ItemType Directory -Force -Path .\frontend\src\app\foo | Out-Null
Move-Item -Force .\_quarantine\2025-08-22\frontend\src\app\foo\page.tsx .\frontend\src\app\foo\page.tsx

# Restore a misc file
Move-Item -Force .\_quarantine\2025-08-22\misc\docs\old.md .\docs\old.md
```

Annotation Protocol for Code-Line Candidates
- Do NOT remove code lines in Pass #1. Instead wrap the region with a unique marker and record it:
  - Start marker: `/* QUARANTINE_CANDIDATE <id> */`
  - End marker: `/* END_QUARANTINE_CANDIDATE <id> */`
- Add an entry to `housekeeping/REFS.md` with: exact file path, line range, marker id, and evidence (static import graph + grep excerpts + tests/reference absence).

Evidence Requirements
- Every deletion/move candidate must include:
  - Reason: why it appears unused or obsolete
  - Evidence: import/usage graph links, grep excerpts, or runtime verification
  - Risk assessment: potential side-effects
  - Owner/contact (if known)
  - Undo path: original path to restore

Runtime Verification
- Prefer mock/local mode:
  - Backend is designed to use in-memory Firestore when `NODE_ENV !== 'production'` or `USE_FAKE_FIRESTORE=1`.
  - Use `FORCE_SSE=1` selectively to test SSE without external dependencies.
  - Set `DISABLE_INGEST=1` to avoid starting background schedulers during health checks.
- If mock is unavailable or unsafe, skip runtime checks and proceed with static analysis only; document the gap in audit files.

After Approval (Pass #2)
- Remove quarantined items permanently.
- Replace annotated code-line regions by actually removing the code.
- Update documentation and any references.

Notes
- `.gitignore` is configured to ignore generated junk while explicitly allowing `/_quarantine/**` to be committed.
- Do not modify behavior in this pass; if moving a file would break a script reference, update paths in the same PR and note it in the PR description.


