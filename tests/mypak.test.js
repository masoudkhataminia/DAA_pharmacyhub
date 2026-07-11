import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MyPakClient } from '../services/mypak/client.js';
import { mergeMyPakPatients } from '../services/mypak/mapper.js';
import { MyPakSyncService } from '../services/mypak/sync.js';

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const settings = { defaultCycleDays: 14, weeklyDays: 7, fortnightlyDays: 14, monthlyDays: 28, defaultPackLeadDays: 3, defaultDispenseLeadDays: 1, defaultOrderLeadDays: 7 };
const store = patients => ({ settings, patients, importReviews: [] });
const row = overrides => ({ patientId: 10, externalPatientId: 'EXT-10', firstName: 'Jane', lastName: 'Citizen', dob: '1980-04-03', patientGroupName: 'Fortnightly', ...overrides });

test('missing token is rejected without making a request', async () => {
  let called = false; const client = new MyPakClient({ env: {}, fetchImpl: async () => { called = true; } });
  await assert.rejects(client.reportOptions(), /not configured/); assert.equal(called, false);
});

test('successful patient list uses authorization but never returns or logs token', async () => {
  const token = 'secret.jwt.value'; let request;
  const client = new MyPakClient({ env: { MYPAK_AUTHORIZATION: token }, retries: 0, fetchImpl: async (url, options) => { request = { url, options }; return response(200, { isSuccess: true, data: [row()] , total: 1 }); } });
  const result = await client.listPatients({ pageIndex: 1 }); assert.equal(result.data.length, 1); assert.equal(request.options.headers.authorization, token);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.doesNotMatch(fs.readFileSync(new URL('../services/mypak/client.js', import.meta.url), 'utf8'), /console\.(log|error|warn)/);
});

test('401 authentication failure is not retried', async () => {
  let calls = 0; const client = new MyPakClient({ env: { MYPAK_AUTHORIZATION: 'x' }, fetchImpl: async () => { calls++; return response(401, {}); } });
  await assert.rejects(client.reportOptions(), error => error.status === 401); assert.equal(calls, 1);
});

test('temporary 500 is retried and can recover', async () => {
  let calls = 0; const client = new MyPakClient({ env: { MYPAK_AUTHORIZATION: 'x' }, fetchImpl: async () => ++calls === 1 ? response(500, {}) : response(200, { isSuccess: true }) });
  await client.reportOptions(); assert.equal(calls, 2);
});

test('isSuccess false is rejected', async () => {
  const client = new MyPakClient({ env: { MYPAK_AUTHORIZATION: 'x' }, retries: 0, fetchImpl: async () => response(200, { isSuccess: false, message: 'No access' }) });
  await assert.rejects(client.reportOptions(), /No access/);
});

test('matches by MyPak ID and preserves workflow fields', () => {
  const existing = { id: 'local', mypakPatientId: '10', fullName: 'Old Name', notes: 'local note', urgent: true, cycleDays: 28, packStatus: 'Packed', active: true };
  const s = store([existing]); const result = mergeMyPakPatients(s, [row({ firstName: 'New', lastName: 'Name' })]);
  assert.equal(result.recordsUpdated, 1); assert.equal(existing.fullName, 'New Name'); assert.equal(existing.notes, 'local note'); assert.equal(existing.urgent, true); assert.equal(existing.cycleDays, 28); assert.equal(existing.packStatus, 'Packed');
});

test('matches by external ID', () => {
  const existing = { id: 'local', externalId: 'EXT-10', fullName: 'Different Person', active: true }; const s = store([existing]);
  const result = mergeMyPakPatients(s, [row()]); assert.equal(result.recordsUpdated, 1); assert.equal(s.patients.length, 1); assert.equal(existing.mypakPatientId, '10');
});

test('adds a normal local patient with defaults', () => {
  const s = store([]); const result = mergeMyPakPatients(s, [row()]);
  assert.equal(result.recordsAdded, 1); assert.ok(s.patients[0].id); assert.equal(s.patients[0].cycleDays, 14); assert.equal(s.patients[0].notes, ''); assert.equal(s.patients[0].packStatus, 'Not started');
});

test('name-only and duplicate matches go to review without merging', () => {
  const s = store([{ id: 'a', fullName: 'Jane Citizen' }, { id: 'b', fullName: 'Jane Citizen' }]); const result = mergeMyPakPatients(s, [row({ externalPatientId: '' })]);
  assert.equal(result.recordsSkipped, 1); assert.equal(s.patients.length, 2); assert.match(s.importReviews[0].action, /Not merged/);
});

test('pagination is sequential across pages', async () => {
  let active = 0; let maxActive = 0; const pages = [];
  const client = { listPatients: async body => { active++; maxActive = Math.max(maxActive, active); pages.push(body.pageIndex); const data = body.pageIndex === 1 ? [row({ patientId: 1 })] : [row({ patientId: 2, externalPatientId: 'EXT-2', firstName: 'John', lastName: 'Second' })]; active--; return { data, total: 2 }; } };
  let saved; const service = new MyPakSyncService({ client, readStore: () => store([]), writeStore: value => { saved = value; }, pageSize: 1 });
  const result = await service.syncPatients(); assert.deepEqual(pages, [1, 2]); assert.equal(maxActive, 1); assert.equal(result.status.recordsProcessed, 2); assert.equal(saved.patients.length, 2);
});

test('sync cannot start twice', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const service = new MyPakSyncService({ client: { listPatients: async () => { await gate; return { data: [], total: 0 }; } }, readStore: () => store([]), writeStore: () => {} });
  const first = service.syncPatients(); const second = await service.syncPatients(); assert.equal(second.started, false); release(); await first;
});
