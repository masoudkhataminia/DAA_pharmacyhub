import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.MYPAK_BASE_URL || 'https://api.mypak.app/api';
const ACCESS_VALUE = process.env.MYPAK_AUTHORIZATION || '';
const ACCESS_HEADER = process.env.MYPAK_ACCESS_HEADER || 'authorization';

if (!ACCESS_VALUE) {
  console.error('Missing MYPAK_AUTHORIZATION. Set it on the server only.');
  process.exit(1);
}

async function postJson(endpoint, body) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json;charset=UTF-8'
  };
  headers[ACCESS_HEADER] = ACCESS_VALUE;

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  const json = raw ? JSON.parse(raw) : {};
  if (!response.ok || json.isSuccess === false) {
    throw new Error(`${response.status} ${json.message || response.statusText}`);
  }
  return json;
}

async function main() {
  const pageSize = Number(process.env.MYPAK_PAGE_SIZE || 200);
  const all = [];
  let total = null;

  for (let pageIndex = 1; pageIndex <= 100; pageIndex++) {
    const page = await postJson('/patients/list', {
      pageIndex,
      pageSize,
      packingStatus: [0, 1, 3],
      sortField: 'LastName',
      sortOrder: 1
    });
    const rows = Array.isArray(page.data) ? page.data : [];
    total = Number.isFinite(Number(page.total)) ? Number(page.total) : total;
    all.push(...rows);
    console.log(`Fetched page ${pageIndex}: ${rows.length} rows (${all.length}/${total || '?'})`);
    if (!rows.length || (total !== null && all.length >= total)) break;
  }

  const outDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'mypak-patients.json');
  fs.writeFileSync(outPath, JSON.stringify({ fetchedAt: new Date().toISOString(), total: total ?? all.length, data: all }, null, 2));
  console.log(`Saved ${all.length} patients to ${outPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
