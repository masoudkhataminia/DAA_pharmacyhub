# Webster Pack Pro v2.3.4 Test Report

Base preserved: v2.3.x professional app. This patch only fixes persistence/script-request behaviour and the GP letter filter/template.

## What was tested in container

Commands/checks:
- `node --check server.js` passed.
- `node --check public/app.js` passed.
- Server started with `PORT=3014 node server.js`.
- API opened at `/api/state`.
- Imported `/mnt/data/List of Patients.xlsx`.
- Imported `/mnt/data/List of Scripts.xlsx`.
- Opened patient details for Adam Turley.
- Created a script request containing both OK and non-OK medicines.
- Confirmed the stored request excluded OK medicine items.
- Opened generated letter HTML.
- Confirmed Hibiscus Pharmacy letter template is used.
- Confirmed saved patients/scripts/request were still present after server restart/readback.

## Real import counts from supplied files

- Patient rows scanned: 8,277
- HIND rows detected: 225
- Webster/Sachet patients saved: 188
- Script rows scanned: 82,864
- Matched script rows: 6,759
- Final deduped script/medicine records saved: 2,339
- Script issues detected: 1,245

## Patient spot test

Adam Turley:
- Scripts shown in patient details: 14
- Status split: 7 OK, 5 New script required, 2 Low repeats
- Request generated with first 5 records: the OK item was excluded from the saved request and from the GP letter.

## Persistence test

After import, data is written to `data/store.json`. After a server restart/readback the saved data remained:
- 188 patients
- 2,339 scripts
- 1 created test script request during QA

The delivered zip intentionally does **not** include `data/store.json`, so it will not overwrite the pharmacy's saved data when updating the app files.


## v2.3.5 Special Orders / S8 patch
- Added Dashboard quick Pack Management Record import for text/CSV/XLSX reports.
- Added Import Centre Pack Management Record upload.
- Added Special Orders / S8 menu with editable RDH / Hibiscus One / CP / NT / patient-supplied order records.
- Special order due date is calculated as next pickup date minus order lead days.
- Added Special Order PDF/HTML request output.
- Preserved existing Dashboard, Import Centre, Patients, Script Requests and Doctor Updates workflow.

Tested locally with the user supplied List of Patients, List of Scripts and Pack Management Record pasted text.
