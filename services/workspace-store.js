import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { normalizeAccountEmail } from './workspace-auth.js';

const clone = value => JSON.parse(JSON.stringify(value));
const DATA_ARRAYS = [
  'patients', 'medications', 'scripts', 'scriptRequests', 'specialOrders', 'specialOrderRequests',
  'specialEmailLog', 'packRecords', 'doctorUpdates', 'doctorChangeAnalyses', 'mypakGroups',
  'mypakMedicationBalances', 'mypakPrescriptions', 'mypakDoctors', 'mypakDispenseHistory',
  'mypakPackJobs', 'mpsFacilityGroups', 'mpsFacilities', 'mpsDrugs', 'mpsDrugForms', 'mpsOrders',
  'mpsPackedDays', 'mpsPackedPrn'
];
const DATA_OBJECTS = ['repeatOverrides', 'mypakPackContents', 'mypakPackSummary', 'dispenseWorkflow', 'prescriptionWorkflow'];

export function workspaceFileId(email) {
  const accountEmail = normalizeAccountEmail(email);
  if (!accountEmail) throw new Error('A valid workspace email is required');
  return crypto.createHash('sha256').update(accountEmail).digest('hex');
}

export function workspaceHasData(store = {}) {
  return DATA_ARRAYS.some(key => Array.isArray(store[key]) && store[key].length > 0)
    || DATA_OBJECTS.some(key => store[key] && typeof store[key] === 'object' && Object.keys(store[key]).length > 0);
}

export class WorkspaceStore {
  constructor({ legacyFile, directory, defaultStore, initialOwnerEmail = '' } = {}) {
    this.legacyFile = legacyFile;
    this.directory = directory;
    this.defaultStore = clone(defaultStore || {});
    this.initialOwnerEmail = normalizeAccountEmail(initialOwnerEmail);
  }

  normalize(raw = {}, ownerEmail = '') {
    const email = normalizeAccountEmail(ownerEmail || raw.workspace?.ownerEmail || this.initialOwnerEmail);
    return {
      ...clone(this.defaultStore),
      ...raw,
      workspace: { ...(this.defaultStore.workspace || {}), ...(raw.workspace || {}), ownerEmail: email },
      settings: { ...(this.defaultStore.settings || {}), ...(raw.settings || {}) }
    };
  }

  readFile(file, ownerEmail = '') {
    if (!file || !fs.existsSync(file)) return this.normalize({}, ownerEmail);
    return this.normalize(JSON.parse(fs.readFileSync(file, 'utf8')), ownerEmail);
  }

  legacyOwnerEmail() {
    if (!this.legacyFile || !fs.existsSync(this.legacyFile)) return this.initialOwnerEmail;
    try { return normalizeAccountEmail(JSON.parse(fs.readFileSync(this.legacyFile, 'utf8')).workspace?.ownerEmail || this.initialOwnerEmail); }
    catch { return this.initialOwnerEmail; }
  }

  fileFor(email) {
    const accountEmail = normalizeAccountEmail(email);
    if (!accountEmail) throw new Error('A valid workspace email is required');
    if (accountEmail === this.legacyOwnerEmail()) return this.legacyFile;
    return path.join(this.directory, `${workspaceFileId(accountEmail)}.json`);
  }

  read(email) {
    const accountEmail = normalizeAccountEmail(email);
    return this.readFile(this.fileFor(accountEmail), accountEmail);
  }

  writeFile(file, store) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  write(email, store) {
    const accountEmail = normalizeAccountEmail(email);
    const normalized = this.normalize(store, accountEmail);
    normalized.workspace = { ...(normalized.workspace || {}), ownerEmail: accountEmail };
    this.writeFile(this.fileFor(accountEmail), normalized);
    return normalized;
  }

  ensure(email) {
    const accountEmail = normalizeAccountEmail(email);
    const file = this.fileFor(accountEmail);
    if (!fs.existsSync(file)) this.write(accountEmail, this.normalize({}, accountEmail));
    return this.read(accountEmail);
  }

  allStoreFiles() {
    const files = this.legacyFile && fs.existsSync(this.legacyFile) ? [this.legacyFile] : [];
    if (this.directory && fs.existsSync(this.directory)) {
      for (const name of fs.readdirSync(this.directory)) if (/^[a-f0-9]{64}\.json$/.test(name)) files.push(path.join(this.directory, name));
    }
    return [...new Set(files)];
  }

  listEmails() {
    const emails = new Set();
    for (const file of this.allStoreFiles()) {
      try {
        const email = normalizeAccountEmail(JSON.parse(fs.readFileSync(file, 'utf8')).workspace?.ownerEmail);
        if (email) emails.add(email);
      } catch {}
    }
    if (this.legacyOwnerEmail()) emails.add(this.legacyOwnerEmail());
    return [...emails];
  }

}
