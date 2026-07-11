# Private MyPak connector

The connector runs only in the Express backend. MyPak credentials are read from the server environment and are never returned to the browser, stored in `store.json`, or written to the audit log.

## Configuration

Set `MYPAK_AUTHORIZATION` to the current authorised account token. `MYPAK_BASE_URL` defaults to `https://api.mypak.app/api`. Set `MYPAK_SYNC_INTERVAL_MINUTES` to a positive number to enable periodic patient sync; empty or `0` disables it.

`MYPAK_USERNAME`, `MYPAK_PASSWORD`, `MYPAK_LOGIN_URL`, `MYPAK_LOGIN_METHOD`, and `MYPAK_LOGIN_BODY_TEMPLATE` are reserved for a future verified login flow. Username/password login intentionally remains disabled until the real login request is confirmed. Rotate a token by replacing `MYPAK_AUTHORIZATION` in the server environment and restarting the process.

Never commit credentials, cookies, patient exports, `data/store.json`, or captured live responses.

## Confirmed endpoints

- `POST /patients/list`
- `GET /patientreportoption`
- `GET /patientGroups/:groupId`

The allowlisted registry is in `services/mypak/endpoints.js`; `config/mypak-endpoints.example.json` documents its safe format. Add a newly captured endpoint only after confirming its method and path in the authorised MyPak frontend, then add a typed client wrapper, mapper/sync handler, and local route only if needed. Do not add a generic proxy.

## Operation

Test the connection with `POST /api/mypak/test`. Start a full patient sync with `POST /api/mypak/sync/patients`; `POST /api/mypak/sync/all` additionally caches confirmed report options and each group referenced by the synced patients. Monitor with `GET /api/mypak/sync/status`. The Import Centre provides the patient sync control and reloads `/api/state` after success.

Patient pages are requested sequentially, with a 200-record page size and 100-page safety limit. Temporary 429, 5xx, timeout, and network failures receive limited backoff retries. Existing patients are matched by MyPak ID, external ID, name plus DOB, then name-only for review. Uncertain matches and locally cached MyPak patients missing from a later sync are reviewed, never silently merged or deleted.

## Troubleshooting

- `401`: replace an expired/invalid token and restart.
- `403`: confirm that the authorised MyPak account can view the requested data; do not bypass its permissions.
- `429`: wait before retrying or increase the periodic interval.
- `500`/timeout: MyPak may be temporarily unavailable. The existing app continues using its last local data.

Tests mock every MyPak response and never contact production. Run `npm test` and `npm run check`.
