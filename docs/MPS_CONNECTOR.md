# MPS MediSphere connector

The connector runs only in the Express backend and mirrors the safety model used by the MyPak connector. It has an explicit endpoint allowlist, no arbitrary upstream proxy, sequential cursor pagination, bounded retries, and no credential or token logging.

## Which MPS system this connects to

MPS currently exposes two different web applications:

- Legacy HealthStream at `https://www.mps-aust.com.au/hsor/login`. It is a server-rendered application using a CSRF-protected form, the `hs_session_id` cookie, and the `HSCookie` authentication scheme. A few legacy browser services exist, including `/api/quick_patient_search_service/search`, `/api/login`, `/hsor/patient_medication/list_patients/:wardId`, and `/hsdn/patients/:patientId/medication/profile`.
- Current MediSphere at `https://www.medisphere.mpsconnect.com.au`. Its generated OpenAPI client identifies the backend as **Med Manager Resource Service v1**. This is the complete API used by this connector. It uses Azure B2C and `Authorization: Bearer <token>`.

Legacy HealthStream usernames/passwords and MediSphere bearer tokens are not interchangeable. The legacy login does not provide the bearer token required by the current Resource Service.

## Configuration

For a server-managed session, set:

```dotenv
MPS_BASE_URL=https://www.medisphere.mpsconnect.com.au
MPS_BEARER_TOKEN=
```

`MPS_BEARER_TOKEN` must be an authorised, current MediSphere ID/bearer token. The `Bearer` prefix is optional. The Import Centre also accepts the token for the current server process only. Runtime tokens are kept in memory and are never written to `.env`, `store.json`, the audit log, or an API response.

The public health check is `GET /health`. Protected calls advertise the Bearer authentication scheme and return `401` for a missing or expired token.

## Confirmed read endpoints

The deployed MPS-generated client confirms these read operations:

- `GET /facility-groups`
- `GET /facilities`
- `GET /facility-groups/configuration/{facilityGroupId}`
- `GET /patients/list?facilityGroupId=&changeNumber=&pageSize=`
- `GET /patients/{facilityGroupId}/{patientId}/mhr`
- `GET /patient-movements/list?facilityGroupId=&changeNumber=&pageSize=`
- `GET /medication-chart?patientId=`
- `GET /drugs?changeNumber=&pageSize=`
- `GET /drug-forms?changeNumber=&pageSize=`
- `GET /drug-categories?etag=`
- `GET /orders?facilityGroupId=&changeNumber=&pageSize=`
- `GET /packed-day/list?sinceChangeNumber=&facilityGroupId=&pageSize=&maxChangeNumber=&startDate=&endDate=`
- `GET /packed-prn/list?sinceChangeNumber=&facilityGroupId=&pageSize=`
- `GET /facility-medication-changes-report?facilityGroupId=&startDateMonth=`
- `GET /users/hs-user/current`

The wider generated API also includes rounds, administered doses/drugs, patient progress notes, patches, syringe drivers, test results, user/role administration, facility configuration, warning details, second-check settings, NIM consumers/drugs, reports, images and attachment upload. Those write-capable operations are deliberately not exposed through this app until each workflow has validation, permission checks, tests and an audit design.

The allowlist is in `services/mps/endpoints.js`. Add a route only after confirming its exact method, path, query names and response shape. Do not add a generic proxy.

## Local app routes

- `GET /api/mps/status` — connection and last-sync summary, without exposing the token.
- `POST /api/mps/session` with `{ "token": "..." }` — configure and validate a token for this server process.
- `POST /api/mps/test` — validate the current token with the current-user endpoint.
- `GET /api/mps/patients?facilityGroupId=...&changeNumber=0&pageSize=50` — one allowlisted patient page.
- `GET /api/mps/patients/:facilityGroupId/:patientId/mhr` — authorised MHR page data.
- `GET /api/mps/patients/:patientId/medication-chart` — medication-chart response.
- `POST /api/mps/sync/patients` — discover accessible facility groups and synchronise residents.
- `POST /api/mps/sync/medications` with `{ "days": 7 }` — synchronise drugs, forms, orders, packed days and PRN records. The range is bounded to 1–31 days.
- `GET /api/mps/sync/status` — current operation and progress.
- `POST /api/mps/import/patients` as multipart form data with a CSV/XLSX/XLS file — offline fallback when live MediSphere authentication is unavailable. Rows need an MPS/Patient ID and resident name.

## Sync and matching rules

MPS list responses are arrays ordered by `changeNumber`. The connector starts at zero, uses the final row's `changeNumber` as the next cursor, stops when a page is shorter than the requested size, and aborts if the cursor does not advance or the 100-page safety limit is reached. Patients use a 200-record page size.

Residents are matched in this order: MPS `hsId`, external/MRN/URN identifier, exact normalized name plus DOB, then name-only as a manual review candidate. Existing pickup cycles, workflow flags, notes and statuses are preserved. Ambiguous matches and residents missing from a later sync are added to Import Review; they are never silently merged, deleted or deactivated.

Residents imported or refreshed from MPS are assigned the visible packing stream `Sachet`. Existing non-MPS Webster Pack residents display `WP`, which keeps the two operational queues easy to distinguish without deleting or duplicating existing residents.

The Patients screen displays an explicit MPS Online/Offline banner. Search continues against the complete local cache while offline, includes MPS ID, resident name, room and facility, and provides Sachet, WP and inactive/cached filters. Offline imports are labelled Sachet and become searchable immediately; they do not pretend that a live MPS connection exists.

The native MPS patient fields used by the mapper include `hsId`, `givenName`, `familyName`, `preferredName`, `dateOfBirth`, `gender`, `facility`, `roomNumber`, `active`, `dischargedDate`, `urn`, `imageUrl`, `pharmacy` and `changeNumber`. Facility records use `hsId`, `facilityGroupId`, `name` and `msWardName`.

## Troubleshooting

- `401`: token is missing or expired. Supply a fresh authorised MediSphere token.
- `403`: the signed-in account does not have access to the facility group. Do not bypass the permission boundary.
- Legacy login failure: the old HealthStream account may be invalid, locked, or restricted by source IP. This does not change the MediSphere token requirement.
- `429`: wait and retry later; the connector already performs limited backoff.
- `500`/timeout: MPS may be temporarily unavailable. The app keeps the last successful local data.

Tests use mocked MPS responses and never contact production. Run `npm test` and `npm run check`.
