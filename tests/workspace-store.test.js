import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore, workspaceFileId, workspaceHasData } from '../services/workspace-store.js';

const defaults = { workspace:{ownerEmail:''}, settings:{cycle:14}, patients:[], medications:[], scripts:[], auditLog:[], repeatOverrides:{}, mypakPackContents:{}, mypakPackSummary:{}, dispenseWorkflow:{}, prescriptionWorkflow:{} };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daa-workspaces-'));
  const legacyFile = path.join(root, 'store.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ ...defaults, workspace:{ownerEmail:'old@example.com'}, patients:[{id:'patient-1'}] }));
  return { root, legacyFile, store:new WorkspaceStore({ legacyFile, directory:path.join(root,'workspaces'), defaultStore:defaults }) };
}

test('existing owner keeps the legacy store while a new email starts empty', t => {
  const { root, store, legacyFile } = fixture();
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  assert.equal(store.fileFor('old@example.com'), legacyFile);
  assert.equal(store.read('old@example.com').patients.length, 1);
  assert.equal(store.read('new@example.com').patients.length, 0);
  assert.notEqual(store.fileFor('new@example.com'), legacyFile);
  assert.equal(workspaceFileId('NEW@example.com'), workspaceFileId('new@example.com'));
});

test('writes are isolated between Google account workspaces', t => {
  const { root, store } = fixture();
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const second = store.read('second@example.com');
  second.patients.push({id:'second-patient'});
  store.write('second@example.com', second);
  assert.deepEqual(store.read('second@example.com').patients.map(row=>row.id), ['second-patient']);
  assert.deepEqual(store.read('old@example.com').patients.map(row=>row.id), ['patient-1']);
  assert.deepEqual(store.listEmails().sort(), ['old@example.com','second@example.com']);
});

test('workspace data detection distinguishes an empty account from a synced account', t => {
  const { root, store } = fixture();
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  assert.equal(workspaceHasData(store.read('new@example.com')), false);
  assert.equal(workspaceHasData(store.read('old@example.com')), true);
});

test('MyPak-style data added to a new account never appears in another account', t => {
  const { root, store } = fixture();
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const incoming = store.read('mypak-user@example.com');
  incoming.patients.push({ id:'mypak-patient', mypakPatientId:'123' });
  incoming.mypakMedicationBalances = [{ patientId:'mypak-patient', medication:'Example medicine' }];
  incoming.mypakSync = { status:'success', totalPatients:1 };
  store.write('mypak-user@example.com', incoming);
  assert.equal(workspaceHasData(store.read('mypak-user@example.com')), true);
  assert.equal(store.read('old@example.com').patients.some(patient => patient.id === 'mypak-patient'), false);
  assert.equal(store.read('another@example.com').patients.length, 0);
});
