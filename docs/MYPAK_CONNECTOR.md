# MyPak live connector

This repo now has a safe plan for a live MyPak connection.

Important: do not commit the MyPak access token or any patient data to GitHub. Put the token only in runtime environment variables on the server.

Confirmed MyPak endpoint from testing:

```txt
POST https://api.mypak.app/api/patients/list
```

Working request body:

```json
{
  "pageIndex": 1,
  "pageSize": 50,
  "packingStatus": [0, 1, 3],
  "sortField": "LastName",
  "sortOrder": 1
}
```

The response includes `data`, `total`, and patient rows with fields such as patient id, patient group, name, DOB, address, dispense code, packing status, patient status, and notes.

## Server environment

Set this on the server, not in GitHub:

```bash
MYPAK_AUTHORIZATION="paste-current-token-here"
```

Recommended later: create a read-only integration user/session for the pharmacy instead of using a personal session.
