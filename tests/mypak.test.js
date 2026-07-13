import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MyPakClient } from '../services/mypak/client.js';
import { mergeMyPakPatients, normalizeMyPakMedicationBalance } from '../services/mypak/mapper.js';
import { MyPakSyncService } from '../services/mypak/sync.js';
import { buildPackImpact } from '../services/doctor-change/impact.js';
import { mergePackJobs, normalizePackDose, packMedicationCells } from '../services/mypak/packs.js';
import { analyseDoctorChange } from '../services/doctor-change/analysis.js';

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const settings = { defaultCycleDays: 14, weeklyDays: 7, fortnightlyDays: 14, monthlyDays: 28, defaultPackLeadDays: 3, defaultDispenseLeadDays: 1, defaultOrderLeadDays: 7 };
const store = patients => ({ settings, patients, importReviews: [] });
const row = overrides => ({ patientId: 10, externalPatientId: 'EXT-10', firstName: 'Jane', lastName: 'Citizen', dob: '1980-04-03', patientGroupName: 'Fortnightly', ...overrides });

test('blank MyPak repeat positions do not request a new script', () => {
  assert.deepEqual(normalizeMyPakMedicationBalance({ repeatsLeft: '', newScriptNeeded: true }), { repeatsLeft: '', hasRepeatPosition: false, newScriptNeeded: null });
  assert.equal(normalizeMyPakMedicationBalance({ repeatsLeft: 0 }).newScriptNeeded, true);
  assert.equal(normalizeMyPakMedicationBalance({ repeatsLeft: 2 }).newScriptNeeded, false);
});

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

test('username login is kept server-side and supplies the returned token', async () => {
  const requests = [];
  const client = new MyPakClient({ env: { MYPAK_USERNAME: 'user', MYPAK_PASSWORD: 'pass' }, retries: 0, fetchImpl: async (url, options) => { requests.push({ url, options }); return url.endsWith('/token') ? response(200, { token: 'fresh-token', refreshToken: 'refresh-token' }) : response(200, { isSuccess: true, data: [], total: 0 }); } });
  await client.listPatients({ pageIndex: 1 });
  assert.match(requests[0].url, /\/token$/); assert.deepEqual(JSON.parse(requests[0].options.body), { username: 'user', password: 'pass' });
  assert.equal(requests[1].options.headers.authorization, 'fresh-token');
});

test('expired token automatically logs in again when credentials are configured', async () => {
  const requests = [];
  const client = new MyPakClient({ env: { MYPAK_AUTHORIZATION: 'expired', MYPAK_USERNAME: 'user', MYPAK_PASSWORD: 'pass' }, retries: 1, fetchImpl: async (url, options) => { requests.push({ url, options }); if (url.endsWith('/token')) return response(200, { token: 'fresh', refreshToken: 'refresh' }); if (options.headers.authorization === 'expired') return response(401, {}); return response(200, { isSuccess: true, data: [], total: 0 }); } });
  await client.listPatients({ pageIndex: 1 });
  assert.equal(requests.filter(r => r.url.endsWith('/patients/list')).length, 2); assert.equal(requests.at(-1).options.headers.authorization, 'fresh');
});

test('virtual pill balance uses the allowlisted MyPak endpoint', async () => {
  let request;
  const client = new MyPakClient({ env: { MYPAK_AUTHORIZATION: 'x' }, retries: 0, fetchImpl: async (url, options) => { request = { url, options }; return response(200, { isSuccess: true, data: [], total: 0 }); } });
  await client.listVirtualPillBalances({ pageIndex: 1, pageSize: 50 });
  assert.match(request.url, /\/vpbbalances\/list$/); assert.equal(request.options.method, 'POST');
});

test('pack list and checking details use only read-only allowlisted MyPak endpoints', async () => {
  const requests = [];
  const client = new MyPakClient({ env:{MYPAK_AUTHORIZATION:'x'}, retries:0, fetchImpl:async(url,options)=>{requests.push({url,options});return response(200,{isSuccess:true,data:[]});} });
  await client.listPackJobs({pageIndex:1,status:['0','1']}); await client.packJobChecking('job-safe_1');
  assert.match(requests[0].url,/\/packjobs$/); assert.equal(requests[0].options.method,'POST');
  assert.match(requests[1].url,/\/packjobs\/job-safe_1\/checking$/); assert.equal(requests[1].options.method,'GET');
  assert.equal(Object.values((await import('../services/mypak/endpoints.js')).MYPAK_ENDPOINTS).some(endpoint=>/complete|reverse|confirm|reject/i.test(endpoint.path)),false);
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
  const existing = { id: 'local', mypakPatientId: 'old-id', externalId: 'EXT-10', fullName: 'Different Person', active: true }; const s = store([existing]);
  const result = mergeMyPakPatients(s, [row()]); assert.equal(result.recordsUpdated, 1); assert.equal(s.patients.length, 1); assert.equal(existing.mypakPatientId, '10');
});

test('adds a normal local patient with defaults', () => {
  const s = store([]); const result = mergeMyPakPatients(s, [row()]);
  assert.equal(result.recordsAdded, 1); assert.ok(s.patients[0].id); assert.equal(s.patients[0].cycleDays, 14); assert.equal(s.patients[0].notes, ''); assert.equal(s.patients[0].packStatus, 'Not started'); assert.equal(s.patients[0].packingStream, 'WP'); assert.equal(s.patients[0].packType, 'Webster Pack');
});

test('name-only and duplicate matches go to review without merging', () => {
  const s = store([{ id: 'a', mypakPatientId: 'old-a', fullName: 'Jane Citizen' }, { id: 'b', mypakPatientId: 'old-b', fullName: 'Jane Citizen' }]); const result = mergeMyPakPatients(s, [row({ externalPatientId: '' })]);
  assert.equal(result.recordsSkipped, 1); assert.equal(s.patients.length, 2); assert.match(s.importReviews[0].action, /Not merged/);
});

test('MyPak patients never merge into MPS Sachet residents', () => {
  const sachetPatient = { id: 'sachet-only', mpsPatientId: '101', externalId: 'EXT-10', fullName: 'Jane Citizen', dob: '1980-04-03', packingStream: 'Sachet', active: true };
  const s = store([sachetPatient]);
  const result = mergeMyPakPatients(s, [row()]);
  assert.equal(result.recordsAdded, 1);
  assert.equal(result.recordsUpdated, 0);
  assert.equal(s.patients.length, 2);
  assert.equal(sachetPatient.mypakPatientId, undefined);
  assert.equal(s.patients[1].packingStream, 'WP');
});

test('pagination is sequential across patient and pill balance pages', async () => {
  let active = 0; let maxActive = 0; const pages = [];
  const client = { listPatients: async body => { active++; maxActive = Math.max(maxActive, active); pages.push(body.pageIndex); const data = body.pageIndex === 1 ? [row({ patientId: 1 })] : [row({ patientId: 2, externalPatientId: 'EXT-2', firstName: 'John', lastName: 'Second' })]; active--; return { data, total: 2 }; }, listVirtualPillBalances: async () => ({ data: [{ vpBalanceId:'b1', patientId: '1', medication: 'Example', balanceQty: 10 }], total: 1 }), listQuickDispense: async () => ({ data:[{ prescriptionId:'rx1',patientId:'1',medication:'Example',balanceQty:-2 }],total:1 }), listInsufficientPillBalances:async()=>({data:[{prescriptionId:'rx1',isInsufficientPillBalance:true}]}), listDoctors:async()=>({data:[{doctorId:'d1'}]}), listDispenseTracking:async()=>({data:[{scriptTrackingId:'t1',patientId:'1',drugName:'Example'}],total:1}), listPackJobs:async()=>({data:[{jobId:'j1',patientId:'1',status:'3',packStartDate:'2026-07-14'}],total:1}) };
  let saved; const service = new MyPakSyncService({ client, readStore: () => store([]), writeStore: value => { saved = value; }, pageSize: 1 });
  const result = await service.syncPatients(); assert.deepEqual(pages, [1, 2]); assert.equal(maxActive, 1); assert.equal(result.status.recordsProcessed, 2); assert.equal(saved.patients.length, 2); assert.equal(saved.mypakMedicationBalances.length, 1); assert.equal(saved.mypakPrescriptions.length,1); assert.equal(saved.mypakDoctors.length,1);
});

test('sync cannot start twice', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const service = new MyPakSyncService({ client: { listPatients: async () => { await gate; return { data: [], total: 0 }; }, listVirtualPillBalances: async () => ({ data: [], total: 0 }), listQuickDispense:async()=>({data:[],total:0}),listInsufficientPillBalances:async()=>({data:[]}),listDoctors:async()=>({data:[]}),listDispenseTracking:async()=>({data:[],total:0}),listPackJobs:async()=>({data:[],total:0}) }, readStore: () => store([]), writeStore: () => {} });
  const first = service.syncPatients(); const second = await service.syncPatients(); assert.equal(second.started, false); release(); await first;
});

test('pack jobs merge by job id instead of duplicating each sync', () => {
  const merged = mergePackJobs([{ jobId:'j1', status:'1', barcode:'old' }], [{ jobId:'j1', status:'3', barcode:'new' }, { jobId:'j2', status:'6' }]);
  assert.equal(merged.length, 2); assert.equal(merged.find(job=>job.jobId==='j1').statusLabel, 'Checking'); assert.equal(merged.find(job=>job.jobId==='j1').barcode, 'new');
});

test('checking dose allocation becomes exact week day and compartment cells', () => {
  const dose = normalizePackDose({ data:{ packStartDate:'2026-07-13', numberOfWeek:1, rowHeadings:['Monday'], pageHeadings:[['Breakfast','Lunch','Dinner','Bedtime']], prescriptions:[{id:'rx1',drug:{drugName:'Example 5mg'}}], doseAllocated:{rx1:[[[1,0,0.5,0]]]}} });
  const cells = packMedicationCells(dose, 'rx1');
  assert.deepEqual(cells.map(cell=>[cell.day,cell.doseTime,cell.quantity]), [['Monday','Breakfast',1],['Monday','Dinner',0.5]]);
});

test('pack impact explains exact removal dates and completed-pack action', () => {
  const detail = normalizePackDose({ data:{ packStartDate:'2026-07-13', numberOfWeek:1, rowHeadings:['Monday'], pageHeadings:[['Breakfast','Lunch','Dinner','Bedtime']], prescriptions:[{id:'rx1',drug:{drugName:'Example 5mg'},direction:'one daily'}], doseAllocated:{rx1:[[[1,0,0,0]]]}} });
  const jobs = [{jobId:'j1',status:'6',statusLabel:'Completed',packStartDate:'2026-07-13'}];
  const impact = buildPackImpact({jobs,detailsByJob:{j1:detail},changes:[{changeType:'stop',medication:'Example 5mg',effectiveDate:'2026-07-13'}]});
  assert.match(impact[0].workflowInstruction,/Completed pack/); assert.equal(impact[0].instructions[0].action,'REMOVE'); assert.equal(impact[0].instructions[0].cells[0].date,'2026-07-13');
});

test('doctor AI request disables storage and requires structured pharmacist-review output', async () => {
  let request;
  const fetchImpl=async(url,options)=>{request={url,options};return response(200,{output_text:JSON.stringify({documentSummary:'One change',changes:[],warnings:[]})});};
  const result=await analyseDoctorChange({patient:{fullName:'Test Patient'},medications:[],sourceText:'Stop example medicine',env:{OPENAI_API_KEY:'test-key',OPENAI_DOCTOR_CHANGE_MODEL:'test-model'},fetchImpl});
  const body=JSON.parse(request.options.body);
  assert.equal(body.store,false); assert.equal(body.text.format.type,'json_schema'); assert.equal(body.text.format.strict,true); assert.equal(result.documentSummary,'One change');
});
