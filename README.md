# Webster Pack Pro v2.3.4 Persistent Tested

Run in Replit with **Run** or `node server.js`. Do not run npm install; dependencies are bundled.

Workflow:
1. Upload `List of Patients.xlsx`. HIND/Webster patients are saved in `data/store.json`.
2. Upload `List of Scripts.xlsx`. Medicines/scripts are saved in `data/store.json`.
3. Refresh or restart Replit: saved patients and medicines remain.
4. Upload newer files later: patients/scripts are updated, not silently deleted.
5. Script Requests page: search patient, medicines appear, OK/sufficient-repeat medicines are hidden from the GP letter. Use Show OK medicines only for checking.

Letter template follows the Hibiscus Pharmacy “New Prescription Required” wording supplied in `Last Repeat and Owing.docx`.


## v2.3.5 Special Orders / S8 patch
- Added Dashboard quick Pack Management Record import for text/CSV/XLSX reports.
- Added Import Centre Pack Management Record upload.
- Added Special Orders / S8 menu with editable RDH / Hibiscus One / CP / NT / patient-supplied order records.
- Special order due date is calculated as next pickup date minus order lead days.
- Added Special Order PDF/HTML request output.
- Preserved existing Dashboard, Import Centre, Patients, Script Requests and Doctor Updates workflow.

Tested locally with the user supplied List of Patients, List of Scripts and Pack Management Record pasted text.

## MPS MediSphere / Sachet integration

- Adds read-only MPS patient, facility, medication, packed-day and order synchronisation.
- Labels MPS residents as `Sachet` and existing Webster Pack residents as `WP`.
- Keeps locally cached Sachet residents searchable when MPS is offline.
- Supports CSV/XLSX MPS patient exports as an offline fallback.
- Holds live MPS bearer tokens in server memory only; tokens are not stored or returned to the browser.

See `docs/MPS_CONNECTOR.md` for setup, supported endpoints and safety constraints.
