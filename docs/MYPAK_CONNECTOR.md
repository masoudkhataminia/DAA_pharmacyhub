# Private MyPak connector

The connector runs only in the Express backend. MyPak credentials are read from the server environment and are never returned to the browser, stored in `store.json`, or written to the audit log.

## Configuration

Set `MYPAK_USERNAME` and `MYPAK_PASSWORD` in the private server environment for automatic login and token refresh. A temporary `MYPAK_AUTHORIZATION` token is also supported; when both are present, an expired token falls back to the configured credentials. `MYPAK_BASE_URL` defaults to `https://api.mypak.app/api`. Set `MYPAK_SYNC_INTERVAL_MINUTES` to a positive number to enable periodic patient and medication-balance sync; empty or `0` disables it. The automatic window defaults to 08:00–18:00 in `Australia/Darwin` and can be configured with `MYPAK_SYNC_START_HOUR`, `MYPAK_SYNC_END_HOUR`, and `MYPAK_SYNC_TIME_ZONE`.

Credentials remain only in the server environment. The connector uses the confirmed MyPak `/token` login and `/token/refreshtoken` renewal endpoints and never returns credentials or tokens to the browser.
The production `npm start` command loads the private `.env` file with Node's built-in `--env-file` support; `.env` remains excluded from Git.

Never commit credentials, cookies, patient exports, `data/store.json`, or captured live responses.

## Confirmed endpoints

- `POST /patients/list`
- `GET /patientreportoption`
- `GET /patientGroups/:groupId`
- `POST /packjobs` (read-only job listing)
- `POST /packjobs/summary`
- `GET /packjobs/:jobId/checking`
- `GET /packjobs/:jobId/distribution`
- `GET /packjobs/:jobId/correction`
- `POST /packjobs/pdf` (on-demand preview generation only)

The allowlisted registry is in `services/mypak/endpoints.js`; `config/mypak-endpoints.example.json` documents its safe format. Add a newly captured endpoint only after confirming its method and path in the authorised MyPak frontend, then add a typed client wrapper, mapper/sync handler, and local route only if needed. Do not add a generic proxy.

## Operation

Test the connection with `POST /api/mypak/test`. Start a full patient sync with `POST /api/mypak/sync/patients`; `POST /api/mypak/sync/all` additionally caches confirmed report options and each group referenced by the synced patients. Monitor with `GET /api/mypak/sync/status`. The Import Centre provides the patient sync control and reloads `/api/state` after success.

Patient pages are requested sequentially. Large balance and dispense datasets use bounded four-request batches, a 200-record page size, and explicit page limits. The main refresh reads the lightweight 120-day pack summary; the selected patient's one-year pack history is then fetched live on demand and merged by immutable `jobId`, so status/ownership is updated instead of duplicated. Exact dose allocations are fetched only for that patient's relevant packs and cached locally. No MyPak complete, confirm, reject, reverse, delete, or edit endpoint is allowlisted.

Temporary 429, 5xx, timeout, and network failures receive limited backoff retries. Existing patients are matched by MyPak ID, external ID, name plus DOB, then name-only for review. Uncertain matches and locally cached MyPak patients missing from a later sync are reviewed, never silently merged or deleted.

## Doctor Change AI

Set `OPENAI_API_KEY` in the private server environment to enable email/PDF/image medication-change analysis. `OPENAI_DOCTOR_CHANGE_MODEL` is optional and defaults to `gpt-5-mini`. Requests use the Responses API with structured JSON output and `store: false`. The browser never receives the API key. AI output is saved only as a pending proposal; staff must approve each change before DAA unlocks the printable pack-amendment worksheet. DAA never writes the proposal back to MyPak or MPS.

## Troubleshooting

- `401`: replace an expired/invalid token and restart.
- `403`: confirm that the authorised MyPak account can view the requested data; do not bypass its permissions.
- `429`: wait before retrying or increase the periodic interval.
- `500`/timeout: MyPak may be temporarily unavailable. The existing app continues using its last local data.

Tests mock every MyPak response and never contact production. Run `npm test` and `npm run check`.
