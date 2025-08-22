Pass #1 Quarantine Approval Checklist

- [ ] Verify backend starts in mock mode (USE_FAKE_FIRESTORE=1) and /health responds
- [ ] Verify /feed responds (mock data acceptable)
- [ ] Verify frontend dev/build still starts (optional)
- [ ] Review quarantined files under `_quarantine/2025-08-22/**`
- [ ] Cross-check each moved item in `housekeeping/DELETION_CANDIDATES.csv`
- [ ] Confirm no CI workflows reference moved files
- [ ] Approve proceeding to Pass #2 after 7 days retention

Notes
- To restore any item, move it back from `_quarantine/2025-08-22/**` to its original path (see undo_path column in `DELETION_CANDIDATES.csv`).

