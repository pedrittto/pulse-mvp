Quarantine Candidate References (Pass #1)

Use this file to record code-line quarantine markers and high-risk references requiring approval.

Template entry:

- id: QC-YYYYMMDD-###
- file: <relative/path/to/file>
- lines: <start>-<end>
- reason: <why this region appears unused>
- evidence:
  - import_graph: housekeeping/USAGE_GRAPH.md#<anchor>
  - grep: <short excerpt or pattern>
  - tests: <absence/presence in backend/frontend tests>
  - runtime: <loaded/not_loaded> (if available)
- risk: <low|medium|high> — <short note>
- owner: <team/person or unknown>

No entries yet. Add entries here as you annotate.


