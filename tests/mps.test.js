import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MpsClient } from '../services/mps/client.js';
import { mergeMpsPatients } from '../services/mps/mapper.js';
import { fetchAllByChangeNumber, MpsSyncService } from '../services/mps/sync.js';
import { mapOfflineMpsPatient, mapOfflineMpsPatients } from '../services/mps/offline.js';

const response = (status, body, raw = false) => ({ ok: status >= 200 && status < 300, status, text: async () => raw ? String(body) : JSON.stringify(body) });
const settings = { defaultCycleDays: 14, defaultPackLeadDays: 3, defaultDispenseLeadDays: 1, defaultOrderLeadDays: 7 };
const store = patients => ({ settings, patients, importReviews: [], mpsSync: {} });
const patient = overrides => ({ hsId: 101, givenName: 'Jane', familyName: 'Citizen', preferredName: 'Janey', dateOfBirth: '1980-04-03', gender: 'Female', facility: 7, roomNumber: '12', active: true, urn: 'MRN-101', changeNumber: 10, ...overrides });

test('public MPS health check works without a bearer token', async () => {
  let request;
  const client = new MpsClient({ env: {}, retries: 0, fetchImpl: async (url, options) => { request = { url, options }; return response(200, 'Healthy', true); } });
  assert.equal(await client.health(), 'Healthy');
  assert.equal(request.options.headers.authorization, undefined);
});

test('missing MPS token is rejected before a protected request', async () => {
  let called = false;
  const client = new MpsClient({ env: {}, fetchImpl: async () => { called = true; } });
  await assert.rejects(client.currentUser(), error => error.status === 401 && /not configured/.test(error.message));
  assert.equal(called, false);
});

test('MPS patient list uses bearer auth and confirmed query names', async () => {
  let request;
  const client = new MpsClient({ env: { MPS_BEARER_TOKEN: 'secret.jwt' }, retries: 0, fetchImpl: async (url, options) => { request = { url, options }; return response(200, [patient()]); } });
  const result = await client.listPatients({ facilityGroupId: 4, changeNumber: 9, pageSize: 200 });
  assert.equal(result.length, 1);
  assert.equal(request.options.headers.authorization, 'Bearer secret.jwt');
  assert.match(request.url, /\/patients\/list\?facilityGroupId=4&changeNumber=9&pageSize=200$/);
  assert.equal(JSON.stringify(result).includes('secret.jwt'), false);
  assert.doesNotMatch(fs.readFileSync(new URL('../services/mps/client.js', import.meta.url), 'utf8'), /console\.(log|error|warn)/);
});

test('MPS authorization header is not double-prefixed', async () => {
  let header;
  const client = new MpsClient({ env: { MPS_AUTHORIZATION: 'Bearer token-value' }, retries: 0, fetchImpl: async (_url, options) => { header = options.headers.authorization; return response(200, {}); } });
  await client.currentUser();
  assert.equal(header, 'Bearer token-value');
});

test('unsupported query parameters are blocked by the endpoint allowlist', async () => {
  const client = new MpsClient({ env: { MPS_BEARER_TOKEN: 'x' }, retries: 0, fetchImpl: async () => response(200, []) });
  await assert.rejects(client.listPatients({ facilityGroupId: 1, arbitraryProxyPath: '/users' }), /Unsupported MPS query parameter/);
});

test('MPS 401 is not retried and temporary 500 is retried', async () => {
  let unauthorizedCalls = 0;
  const unauthorized = new MpsClient({ env: { MPS_BEARER_TOKEN: 'x' }, fetchImpl: async () => { unauthorizedCalls++; return response(401, {}); } });
  await assert.rejects(unauthorized.currentUser(), error => error.status === 401);
  assert.equal(unauthorizedCalls, 1);

  let retryCalls = 0;
  const retry = new MpsClient({ env: { MPS_BEARER_TOKEN: 'x' }, fetchImpl: async () => ++retryCalls === 1 ? response(500, {}) : response(200, { subject: 'ok' }) });
  await retry.currentUser();
  assert.equal(retryCalls, 2);
});

test('MPS patient mapper uses native field names and preserves workflow state', () => {
  const existing = { id: 'local', mpsPatientId: '101', fullName: 'Old Name', notes: 'keep me', urgent: true, cycleDays: 28, packStatus: 'Packed', active: true };
  const data = store([existing]);
  const result = mergeMpsPatients(data, [patient()], [{ hsId: 7, facilityGroupId: 3, name: 'Wing A' }], '2026-07-14T00:00:00.000Z');
  assert.equal(result.recordsUpdated, 1);
  assert.equal(existing.fullName, 'Jane Citizen');
  assert.equal(existing.dob, '1980-04-03');
  assert.equal(existing.facilityWard, 'Wing A');
  assert.equal(existing.room, '12');
  assert.equal(existing.notes, 'keep me');
  assert.equal(existing.urgent, true);
  assert.equal(existing.cycleDays, 28);
  assert.equal(existing.packStatus, 'Packed');
  assert.equal(existing.packingStream, 'Sachet');
  assert.equal(existing.packType, 'Sachet');
});

test('MPS mapper adds a new resident with safe workflow defaults', () => {
  const data = store([]);
  const result = mergeMpsPatients(data, [patient()], [{ hsId: 7, facilityGroupId: 3, msWardName: 'MPS Wing' }]);
  assert.equal(result.recordsAdded, 1);
  assert.equal(data.patients[0].mpsPatientId, '101');
  assert.equal(data.patients[0].mpsFacilityGroupId, '3');
  assert.equal(data.patients[0].facilityWard, 'MPS Wing');
  assert.equal(data.patients[0].packStatus, 'Not started');
  assert.equal(data.patients[0].packingStream, 'Sachet');
});

test('MPS residents never merge into MyPak WP patients', () => {
  const wpPatient = { id: 'wp-only', mypakPatientId: '10', externalId: 'MRN-101', fullName: 'Jane Citizen', dob: '1980-04-03', packingStream: 'WP', active: true };
  const data = store([wpPatient]);
  const result = mergeMpsPatients(data, [patient()], [{ hsId: 7, facilityGroupId: 3, name: 'Wing A' }]);
  assert.equal(result.recordsAdded, 1);
  assert.equal(result.recordsUpdated, 0);
  assert.equal(data.patients.length, 2);
  assert.equal(wpPatient.mpsPatientId, undefined);
  assert.equal(data.patients[1].packingStream, 'Sachet');
});

test('offline MPS CSV rows map common export headings', () => {
  const mapped = mapOfflineMpsPatient({ 'MPS ID': '5001', 'Given Name': 'Mary', 'Family Name': 'Example', DOB: '1940-02-01', Ward: 'Sachet Wing', Room: '8B', MRN: 'MRN-5001', Status: 'Active' });
  assert.equal(mapped.hsId, '5001');
  assert.equal(mapped.fullName, 'Mary Example');
  assert.equal(mapped.facilityName, 'Sachet Wing');
  assert.equal(mapped.roomNumber, '8B');
  assert.equal(mapped.active, true);
});

test('offline MPS import skips rows without both an ID and name', () => {
  const mapped = mapOfflineMpsPatients([{ 'MPS ID': '1', 'Patient Name': 'Valid Resident' }, { 'Patient Name': 'Missing ID' }, { 'MPS ID': '3' }]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].fullName, 'Valid Resident');
});

test('change-number pagination advances sequentially', async () => {
  const cursors = [];
  const rows = await fetchAllByChangeNumber(async (cursor, pageSize) => {
    cursors.push(cursor);
    return cursor === 0 ? [patient({ hsId: 1, changeNumber: 5 }), patient({ hsId: 2, changeNumber: 8 })] : [patient({ hsId: 3, changeNumber: 9 })];
  }, { pageSize: 2, maxPages: 5 });
  assert.deepEqual(cursors, [0, 8]);
  assert.equal(rows.length, 3);
});

test('change-number pagination rejects a non-advancing full page', async () => {
  await assert.rejects(fetchAllByChangeNumber(async () => [patient({ changeNumber: 0 })], { pageSize: 1, maxPages: 2 }), /did not advance/);
});

test('patient sync discovers facility groups, paginates, and stores mapped residents', async () => {
  const calls = [];
  const client = {
    listFacilityGroups: async () => [{ hsId: 3, name: 'Group' }],
    listFacilities: async () => [{ hsId: 7, facilityGroupId: 3, name: 'Wing A' }],
    listPatients: async query => { calls.push(query); return query.changeNumber === 0 ? [patient({ hsId: 101, changeNumber: 4 }), patient({ hsId: 102, givenName: 'John', familyName: 'Second', urn: 'MRN-102', changeNumber: 8 })] : [patient({ hsId: 103, givenName: 'Ana', familyName: 'Third', urn: 'MRN-103', changeNumber: 9 })]; }
  };
  let saved;
  const service = new MpsSyncService({ client, readStore: () => store([]), writeStore: value => { saved = value; }, pageSize: 2, maxPages: 5 });
  const result = await service.syncPatients();
  assert.equal(result.total, 3);
  assert.deepEqual(calls.map(call => call.changeNumber), [0, 8]);
  assert.equal(saved.patients.length, 3);
  assert.equal(saved.mpsSync.totalPatients, 3);
  assert.equal(saved.mpsFacilities[0].name, 'Wing A');
});

test('MPS sync cannot start twice', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = { listFacilityGroups: async () => { await gate; return [{ hsId: 3 }]; }, listFacilities: async () => [], listPatients: async () => [] };
  const service = new MpsSyncService({ client, readStore: () => store([]), writeStore: () => {} });
  const first = service.syncPatients();
  const second = await service.syncPatients();
  assert.equal(second.started, false);
  release();
  await first;
});
