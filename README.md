# Webster Pack Pro v2.3.4 Persistent Tested

Run with `npm start` on the configured DAA server.

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

## Doctor Change → Pack Amendment

- Reads MyPak pack-job status, pack month/week, creator/completer and exact checking dose allocations without modifying MyPak.
- Compares a pasted doctor email or uploaded medication summary with the patient's current MyPak medication list when the private OpenAI API key is configured.
- Requires a pharmacist to approve or reject every proposed change.
- Produces a printable amendment worksheet listing the exact pack, date, day, dose compartment and quantity to add/remove/change, with packer and checker sign-off.

## Gmail automatic S8 / Special Order reminders

- The Special Orders page only uses medicines identified as S8 and medicines explicitly added to the Special Orders queue.
- Each order can send on its own interval (for example every 10 or 20 days) to the patient, doctor and/or pharmacy. Each recipient is sent a separate message.
- The server checks due schedules every minute, even when no browser is open. Completed, received and cancelled orders do not send.
- Patient email can be imported or edited in Patient master. Doctor email can be selected/entered on the Special Order. The pharmacy recipient is configured under Settings.
- Gmail uses the narrow `gmail.send` OAuth scope and offline access. The refresh token is AES-256-GCM encrypted in `data/gmail-token.enc`, which is ignored by Git.

Create a Google OAuth Web application, enable the Gmail API, and register this exact authorised redirect URI:

`https://daa.mypharmacyhub.net/api/gmail/callback`

Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` and a long random `GMAIL_TOKEN_KEY` in the server `.env`, restart the process, then use **Settings → Connect Gmail**.
