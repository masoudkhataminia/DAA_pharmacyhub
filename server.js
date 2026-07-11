import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import PDFDocument from 'pdfkit';
import crypto from 'crypto';
import { MyPakClient } from './services/mypak/client.js';
import { MyPakSyncService } from './services/mypak/sync.js';
import { publicMyPakError } from './services/mypak/errors.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
const PORT = process.env.PORT || 3000;
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_STORE = {
  version: 234,
  settings: {
    defaultCycleDays: 14,
    weeklyDays: 7,
    fortnightlyDays: 14,
    monthlyDays: 28,
    defaultPackLeadDays: 3,
    defaultDispenseLeadDays: 1,
    defaultOrderLeadDays: 7,
    defaultSpecialOrderLeadDays: 14,
    urgentWindowDays: 2,
    dueSoonWindowDays: 7,
    scriptLowRepeatThreshold: 1
  },
  patients: [],
  medications: [],
  scripts: [],
  scriptRequests: [],
  specialOrders: [],
  specialOrderRequests: [],
  packRecords: [],
  doctorUpdates: [],
  importReviews: [],
  auditLog: [],
  mypakGroups: [],
  mypakReportOptions: null,
  mypakSync: { lastSyncAt: null, lastSuccessAt: null, lastError: null, totalPatients: 0, status: 'never' }
};

function id() { return crypto.randomUUID(); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function nowISO() { return new Date().toISOString(); }
function cleanText(v) { return String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); }
function lower(v) { return cleanText(v).toLowerCase(); }
function digits(v) { return cleanText(v).replace(/\D/g, ''); }
function stripHind(v) {
  return cleanText(v)
    .replace(/\(?\s*HIND\s*\)?/ig, '')
    .replace(/\(\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function hasHindValue(v) { return /\(?\s*HIND\s*\)?/i.test(cleanText(v)); }
function normalizeName(v) {
  return stripHind(v)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function num(v, fallback = 0) { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : fallback; }
function todayDate() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function pad(n) { return String(n).padStart(2, '0'); }
function toISODate(d) { return d instanceof Date && !Number.isNaN(d) ? `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` : ''; }
function formatAU(d) { return d instanceof Date && !Number.isNaN(d) ? `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}` : ''; }
function parseExcelSerial(n) {
  if (!Number.isFinite(n)) return null;
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v)) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'number') return parseExcelSerial(v);
  const s = cleanText(v);
  if (!s) return null;
  const serial = Number(s);
  if (/^\d{5}(\.\d+)?$/.test(s) && Number.isFinite(serial)) return parseExcelSerial(serial);
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const au = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\s|$)/);
  if (au) {
    let a = Number(au[1]), b = Number(au[2]), y = Number(au[3]);
    if (y < 100) y += y > 50 ? 1900 : 2000;
    // AU-first. If first part >12, definitely dd/mm. If second part >12, likely mm/dd; still normalize safely.
    const day = a > 12 ? a : (b > 12 ? b : a);
    const month = a > 12 ? b : (b > 12 ? a : b);
    return new Date(y, month - 1, day);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, days) { const x = new Date(d); x.setDate(x.getDate() + Number(days || 0)); return x; }
function diffDays(a, b) { return Math.round((a - b) / 86400000); }
function dateOrBlank(v) { const d = parseDate(v); return d ? toISODate(d) : ''; }
function dateDisplay(v) { const d = parseDate(v); return d ? formatAU(d) : ''; }

function readStore() {
  if (!fs.existsSync(DATA_FILE)) writeStore(clone(DEFAULT_STORE));
  const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return { ...clone(DEFAULT_STORE), ...s, settings: { ...DEFAULT_STORE.settings, ...(s.settings || {}) } };
}
function writeStore(store) { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }
function audit(store, action, details = {}) {
  store.auditLog.unshift({ id: id(), at: nowISO(), action, details });
  store.auditLog = store.auditLog.slice(0, 1500);
}

const mypakClient = new MyPakClient();
const mypakSyncService = new MyPakSyncService({ client: mypakClient, readStore, writeStore, pageSize: 200, maxPages: 100 });

function sendMyPakError(res, error) {
  const safe = publicMyPakError(error);
  res.status(safe.status).json({ error: safe.error });
}

const FIELD_ALIASES = {
  firstName: ['First Name','Firstname','First','Given Name','Patient First Name','GivenName'],
  middleName: ['Middle Name','Middle'],
  lastName: ['Last Name','Lastname','Last','Surname','Family Name','Patient Last Name'],
  fullName: ['Full Name','Patient Name','Name','Client Name','Customer Name','Consumer Name'],
  dob: ['DOB','Date of Birth','Birth Date','Patient DOB'],
  gender: ['Gender','Sex'],
  phone: ['Phone','Mobile','Contact Number','Contact','Telephone'],
  address: ['Address','Residential Address','Street Address'],
  externalId: ['Patient ID','Patient No','Patient Number','ID','Number','Code','Customer ID'],
  group: ['Patient Group','Group','Category','Packing Group','Service Type'],
  medicine: ['Medication Name','Drug Name','Drug Description','Medicine','Description','Item','Product','Generic Name'],
  directions: ['Directions','Direction','SIG','Dose','Dosage','Instruction','Instructions'],
  timing: ['Dose and Timing','Timing','Administration Time','Time'],
  repeatsLeft: ['Repeats Left','Repeat Left','Repeats Remaining','Repeats Remaining Approx','Repeats Left (approx)'],
  repeatsIssued: ['Repeats Issued','Repeats','Total Repeats','Repeats Authorised'],
  supplyNumber: ['Supply Number','Supply No','No. Supplied','Supply'],
  scriptNumber: ['Script Number','Rx Number','Rx','Prescription Number'],
  owing: ['Owing','Owing Script','Script Owing','Owing Status'],
  dispenseDate: ['Dispense Date','Date Dispensed','Date','Last Dispensed'],
  schedule: ['Schedule','Drug Schedule','S8','S4D']
};
function compactKey(s) { return cleanText(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function rowVal(row, aliases) {
  const map = new Map(Object.keys(row).map(k => [compactKey(k), k]));
  for (const a of aliases) {
    const real = map.get(compactKey(a));
    if (real !== undefined) return row[real];
  }
  return undefined;
}
function aliasScore(headerRow) {
  const allAliases = Object.values(FIELD_ALIASES).flat().map(compactKey);
  return (headerRow || []).reduce((score, cell) => score + (allAliases.includes(compactKey(cell)) ? 1 : 0), 0);
}
function workbookRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false });
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
    if (!matrix.length) continue;
    let headerIndex = 0;
    let bestScore = -1;
    const scanLimit = Math.min(matrix.length, 20);
    for (let i = 0; i < scanLimit; i++) {
      const score = aliasScore(matrix[i]);
      if (score > bestScore) { bestScore = score; headerIndex = i; }
    }
    // Require at least two known headers so report title rows are not used as headers.
    if (bestScore < 2) headerIndex = 0;
    const header = matrix[headerIndex].map((h, i) => cleanText(h) || `Column ${i + 1}`);
    for (let r = headerIndex + 1; r < matrix.length; r++) {
      const arr = matrix[r];
      if (!arr || arr.every(v => cleanText(v) === '')) continue;
      const obj = {};
      header.forEach((h, i) => { obj[h] = arr[i] ?? ''; });
      rows.push({ sheetName, rowNumber: r + 1, row: obj, headerIndex: headerIndex + 1 });
    }
  }
  return rows;
}
function makePatientName(row) {
  const first = stripHind(rowVal(row, FIELD_ALIASES.firstName));
  const middle = stripHind(rowVal(row, FIELD_ALIASES.middleName));
  const last = stripHind(rowVal(row, FIELD_ALIASES.lastName));
  let full = stripHind(rowVal(row, FIELD_ALIASES.fullName));
  if (!full) full = [first, middle, last].filter(Boolean).join(' ');
  return { first, middle, last, full };
}
function inferCycleDays(group, settings) {
  const g = lower(group);
  if (/weekly|\bweek\b|7\s*day/.test(g) && !/fortnight|two|2/.test(g)) return settings.weeklyDays;
  if (/fortnight|2\s*week|two\s*week|14\s*day/.test(g)) return settings.fortnightlyDays;
  if (/month|monthly|28\s*day|30\s*day/.test(g)) return settings.monthlyDays;
  return settings.defaultCycleDays;
}
function matchKeyFor(p) {
  const pid = lower(p.externalId);
  if (pid) return `id:${pid}`;
  const name = normalizeName(p.fullName || `${p.firstName || ''} ${p.lastName || ''}`);
  if (p.dob) return `name-dob:${name}|${p.dob}`;
  return `name:${name}`;
}
function buildPatient(wrap, settings) {
  const r = wrap.row;
  const name = makePatientName(r);
  const externalId = cleanText(rowVal(r, FIELD_ALIASES.externalId));
  const group = cleanText(rowVal(r, FIELD_ALIASES.group));
  const p = {
    id: id(),
    externalId,
    firstName: name.first,
    middleName: name.middle,
    lastName: name.last,
    fullName: name.full,
    dob: dateOrBlank(rowVal(r, FIELD_ALIASES.dob)),
    gender: cleanText(rowVal(r, FIELD_ALIASES.gender)),
    phone: cleanText(rowVal(r, FIELD_ALIASES.phone)),
    address: cleanText(rowVal(r, FIELD_ALIASES.address)),
    patientGroup: group,
    packType: 'Webster/Sachet',
    cycleDays: inferCycleDays(group, settings),
    lastPickupDate: '',
    packLeadDays: settings.defaultPackLeadDays,
    dispenseLeadDays: settings.defaultDispenseLeadDays,
    orderLeadDays: settings.defaultOrderLeadDays,
    packStatus: 'Not started',
    dispenseStatus: 'Not dispensed',
    medicineOrderStatus: 'Not checked',
    scriptRequestStatus: 'Not checked',
    patientSuppliedMeds: false,
    s8Priority: false,
    urgent: false,
    notes: '',
    active: true,
    sourceSheet: wrap.sheetName,
    sourceRow: wrap.rowNumber,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  p.matchKey = matchKeyFor(p);
  return p;
}
function computePatient(p, settings) {
  const last = parseDate(p.lastPickupDate);
  const cycleDays = Math.max(1, num(p.cycleDays, settings.defaultCycleDays));
  const next = last ? addDays(last, cycleDays) : null;
  const packDue = next ? addDays(next, -Math.max(0, num(p.packLeadDays, settings.defaultPackLeadDays))) : null;
  const dispenseDue = next ? addDays(next, -Math.max(0, num(p.dispenseLeadDays, settings.defaultDispenseLeadDays))) : null;
  const orderDue = next ? addDays(next, -Math.max(0, num(p.orderLeadDays, settings.defaultOrderLeadDays))) : null;
  const today = todayDate();
  const daysToPickup = next ? diffDays(next, today) : null;
  const daysToPack = packDue ? diffDays(packDue, today) : null;
  const daysToDispense = dispenseDue ? diffDays(dispenseDue, today) : null;
  const daysToOrder = orderDue ? diffDays(orderDue, today) : null;
  let risk = 0;
  if (p.urgent) risk += 60;
  if (p.s8Priority) risk += 20;
  if (daysToPickup !== null) risk += Math.max(0, 30 - daysToPickup);
  if (p.scriptRequestStatus && !/complete|not checked/i.test(p.scriptRequestStatus)) risk += 15;
  if (p.patientSuppliedMeds) risk += 10;
  const status = !next ? 'Needs pickup date' : daysToPickup < 0 ? 'Overdue' : daysToPickup === 0 ? 'Due today' : daysToPickup <= settings.urgentWindowDays ? 'Due soon' : daysToPickup <= settings.dueSoonWindowDays ? 'Due this week' : 'Scheduled';
  return {
    ...p,
    cycleDays,
    lastPickupDisplay: dateDisplay(p.lastPickupDate),
    nextPickupDate: next ? toISODate(next) : '',
    nextPickupDisplay: next ? formatAU(next) : '',
    packDueDate: packDue ? toISODate(packDue) : '',
    packDueDisplay: packDue ? formatAU(packDue) : '',
    dispenseDueDate: dispenseDue ? toISODate(dispenseDue) : '',
    dispenseDueDisplay: dispenseDue ? formatAU(dispenseDue) : '',
    orderDueDate: orderDue ? toISODate(orderDue) : '',
    orderDueDisplay: orderDue ? formatAU(orderDue) : '',
    daysToPickup, daysToPack, daysToDispense, daysToOrder,
    calculatedStatus: status,
    riskScore: risk
  };
}
function activeComputed(store) {
  return store.patients.filter(p => p.active !== false).map(p => computePatient(p, store.settings));
}
function sortQueue(items, keyDays, statusField, doneRegex) {
  return items
    .filter(p => p[keyDays] === null || p[keyDays] <= 7 || !doneRegex.test(p[statusField] || ''))
    .sort((a,b) => (a[keyDays] ?? 9999) - (b[keyDays] ?? 9999) || b.riskScore - a.riskScore || a.fullName.localeCompare(b.fullName));
}
function dashboard(store) {
  const pts = activeComputed(store);
  const openDoctor = store.doctorUpdates.filter(x => !/applied|closed|rejected/i.test(x.status || ''));
  const pendingScripts = store.scripts.filter(s => /owing|required|low/i.test(s.requestFlag || ''));
  const specialDue = specialDashboard(store);
  return {
    kpis: {
      activePatients: pts.length,
      overdue: pts.filter(p => p.daysToPickup !== null && p.daysToPickup < 0).length,
      dueThisWeek: pts.filter(p => p.daysToPickup !== null && p.daysToPickup <= store.settings.dueSoonWindowDays).length,
      patientSupplied: pts.filter(p => p.patientSuppliedMeds).length,
      s8Priority: pts.filter(p => p.s8Priority).length,
      openDoctorUpdates: openDoctor.length,
      scriptIssues: pendingScripts.length,
      specialOrdersDue: specialDue.length
    },
    packingDue: sortQueue(pts, 'daysToPack', 'packStatus', /packed|ready|complete/i).slice(0, 80),
    dispenseDue: sortQueue(pts, 'daysToDispense', 'dispenseStatus', /dispensed|complete/i).slice(0, 80),
    orderingDue: sortQueue(pts.filter(p => p.patientSuppliedMeds || !/received|not needed|complete/i.test(p.medicineOrderStatus || '')), 'daysToOrder', 'medicineOrderStatus', /received|not needed|complete/i).slice(0, 80),
    urgent: pts.filter(p => p.urgent || p.calculatedStatus === 'Overdue' || p.calculatedStatus === 'Due today' || p.s8Priority).sort((a,b)=>b.riskScore-a.riskScore).slice(0,80),
    doctorUpdates: openDoctor.slice(0, 80),
    scriptIssues: pendingScripts.slice(0, 80),
    specialOrdersDue: specialDue.slice(0, 80)
  };
}
function buildMedication(wrap) {
  const r = wrap.row; const name = makePatientName(r);
  const medicineName = cleanText(rowVal(r, FIELD_ALIASES.medicine));
  if (!name.full || !medicineName) return null;
  return {
    id: id(), patientFullName: name.full, patientNameKey: normalizeName(name.full), medicineName,
    medicineKey: normalizeName(medicineName), directions: cleanText(rowVal(r, FIELD_ALIASES.directions)), timing: cleanText(rowVal(r, FIELD_ALIASES.timing)),
    patientSupplied: /patient supplied|own med|brought/i.test(JSON.stringify(r)),
    s8Priority: /\b(schedule\s*8|s8|methylphenidate|ritalin|dexamfetamine|dexamphetamine|vyvanse|lisdexamfetamine|oxycodone|morphine|fentanyl|tapentadol|buprenorphine)\b/i.test(medicineName + ' ' + JSON.stringify(r)),
    status: 'Active', source: `${wrap.sheetName}:${wrap.rowNumber}`, importedAt: nowISO()
  };
}
function inferRequestFlag(repeatsLeft, owing, settings) {
  if (owing) return 'Script owing';
  if (repeatsLeft <= 0) return 'New script required';
  if (repeatsLeft <= settings.scriptLowRepeatThreshold) return 'Low repeats';
  return 'OK';
}

function headerMapFromRow(headerRow) {
  const map = new Map();
  (headerRow || []).forEach((h, i) => {
    const k = compactKey(h);
    if (k && !map.has(k)) map.set(k, i);
  });
  return map;
}
function indexFor(map, aliases) {
  for (const a of aliases) {
    const i = map.get(compactKey(a));
    if (i !== undefined) return i;
  }
  return -1;
}
function arrVal(arr, idx) { return idx >= 0 ? arr[idx] : ''; }
function scriptRowsFast(buffer, settings, store) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false, cellDates: false });
  const patientKeys = new Set((store.patients || []).map(p => normalizeName(p.fullName)).filter(Boolean));
  const byPatientMedicine = new Map();
  let totalRows = 0, parsed = 0, matched = 0, skippedNoNameOrDrug = 0, skippedNonMedicine = 0;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
    if (!matrix.length) continue;

    let headerIndex = 0;
    let bestScore = -1;
    for (let i = 0; i < Math.min(matrix.length, 25); i++) {
      const score = aliasScore(matrix[i]);
      if (score > bestScore) { bestScore = score; headerIndex = i; }
    }
    const headerMap = headerMapFromRow(matrix[headerIndex]);
    const idx = {
      first: indexFor(headerMap, FIELD_ALIASES.firstName),
      middle: indexFor(headerMap, FIELD_ALIASES.middleName),
      last: indexFor(headerMap, FIELD_ALIASES.lastName),
      full: indexFor(headerMap, FIELD_ALIASES.fullName),
      drug: indexFor(headerMap, FIELD_ALIASES.medicine),
      directions: indexFor(headerMap, FIELD_ALIASES.directions),
      dispenseDate: indexFor(headerMap, FIELD_ALIASES.dispenseDate),
      repeatsLeft: indexFor(headerMap, FIELD_ALIASES.repeatsLeft),
      repeatsIssued: indexFor(headerMap, FIELD_ALIASES.repeatsIssued),
      supplyNumber: indexFor(headerMap, FIELD_ALIASES.supplyNumber),
      owing: indexFor(headerMap, FIELD_ALIASES.owing),
      schedule: indexFor(headerMap, FIELD_ALIASES.schedule),
      scriptNumber: indexFor(headerMap, FIELD_ALIASES.scriptNumber)
    };

    for (let r = headerIndex + 1; r < matrix.length; r++) {
      const arr = matrix[r];
      if (!arr || arr.every(v => cleanText(v) === '')) continue;
      totalRows++;
      const first = stripHind(arrVal(arr, idx.first));
      const middle = stripHind(arrVal(arr, idx.middle));
      const last = stripHind(arrVal(arr, idx.last));
      let full = stripHind(arrVal(arr, idx.full));
      if (!full) full = [first, middle, last].filter(Boolean).join(' ');
      const drug = cleanText(arrVal(arr, idx.drug));
      if (!full || !drug) { skippedNoNameOrDrug++; continue; }
      if (/\b(packing\s*fee|webster\s*fee|pack\s*fee|hibiscus\s*packing\s*fee)\b/i.test(drug)) { skippedNonMedicine++; continue; }
      const patientNameKey = normalizeName(full);
      // If patients have been imported, keep only matched Webster/HIND patients. If not, keep HIND rows so the user still gets useful data.
      if (patientKeys.size && !patientKeys.has(patientNameKey)) continue;
      if (!patientKeys.size && !hasHindValue([arrVal(arr, idx.first), arrVal(arr, idx.middle), arrVal(arr, idx.last), arrVal(arr, idx.full)].join(' '))) continue;
      parsed++;
      matched++;
      const explicitRepeatsLeft = arrVal(arr, idx.repeatsLeft);
      const repeatsIssued = num(arrVal(arr, idx.repeatsIssued), 0);
      const supplyNo = Math.max(1, num(arrVal(arr, idx.supplyNumber), 1));
      const repeatsLeft = explicitRepeatsLeft !== undefined && cleanText(explicitRepeatsLeft) !== ''
        ? Math.max(0, num(explicitRepeatsLeft, 0))
        : Math.max(0, repeatsIssued - (supplyNo - 1));
      const owingText = lower(arrVal(arr, idx.owing));
      const owing = ['yes','y','true','1','owing','script owing'].includes(owingText) || /owing/i.test(owingText);
      const script = {
        id: id(), patientFullName: full, patientNameKey, drugDescription: drug, medicineKey: normalizeName(drug),
        directions: cleanText(arrVal(arr, idx.directions)), dispenseDate: dateOrBlank(arrVal(arr, idx.dispenseDate)),
        dispenseDateDisplay: dateDisplay(arrVal(arr, idx.dispenseDate)), repeatsIssued, supplyNumber: supplyNo, repeatsLeft, owing,
        schedule: cleanText(arrVal(arr, idx.schedule)), scriptNumber: cleanText(arrVal(arr, idx.scriptNumber)),
        requestFlag: inferRequestFlag(repeatsLeft, owing, settings), source: `${sheetName}:${r + 1}`, importedAt: nowISO()
      };
      const key = `${script.patientNameKey}||${script.medicineKey}`;
      const old = byPatientMedicine.get(key);
      if (!old || scriptFreshnessScore(script) >= scriptFreshnessScore(old)) byPatientMedicine.set(key, script);
    }
  }
  return { totalRows, parsed, matched, skippedNoNameOrDrug, skippedNonMedicine, scripts: [...byPatientMedicine.values()].sort((a,b) => a.patientFullName.localeCompare(b.patientFullName) || a.drugDescription.localeCompare(b.drugDescription)) };
}

function buildScript(wrap, settings) {
  const r = wrap.row; const name = makePatientName(r); const drug = cleanText(rowVal(r, FIELD_ALIASES.medicine));
  if (!name.full || !drug) return null;
  if (/\b(packing\s*fee|webster\s*fee|pack\s*fee)\b/i.test(drug)) return null;
  const explicitRepeatsLeft = rowVal(r, FIELD_ALIASES.repeatsLeft);
  const repeatsIssued = num(rowVal(r, FIELD_ALIASES.repeatsIssued), 0);
  const supplyNo = Math.max(1, num(rowVal(r, FIELD_ALIASES.supplyNumber), 1));
  const repeatsLeft = explicitRepeatsLeft !== undefined && cleanText(explicitRepeatsLeft) !== '' ? Math.max(0, num(explicitRepeatsLeft, 0)) : Math.max(0, repeatsIssued - (supplyNo - 1));
  const owingText = lower(rowVal(r, FIELD_ALIASES.owing));
  const owing = ['yes','y','true','1','owing','script owing'].includes(owingText) || /owing/i.test(owingText);
  return {
    id: id(), patientFullName: name.full, patientNameKey: normalizeName(name.full), drugDescription: drug, medicineKey: normalizeName(drug),
    directions: cleanText(rowVal(r, FIELD_ALIASES.directions)), dispenseDate: dateOrBlank(rowVal(r, FIELD_ALIASES.dispenseDate)),
    dispenseDateDisplay: dateDisplay(rowVal(r, FIELD_ALIASES.dispenseDate)), repeatsIssued, supplyNumber: supplyNo, repeatsLeft, owing,
    schedule: cleanText(rowVal(r, FIELD_ALIASES.schedule)), scriptNumber: cleanText(rowVal(r, FIELD_ALIASES.scriptNumber)),
    requestFlag: inferRequestFlag(repeatsLeft, owing, settings), source: `${wrap.sheetName}:${wrap.rowNumber}`, importedAt: nowISO()
  };
}
function scriptFreshnessScore(s) {
  const d = parseDate(s.dispenseDate);
  return (d ? d.getTime() : 0) + Math.max(0, num(s.supplyNumber, 0)) * 1000;
}
function dedupeAndFilterScripts(store, scripts) {
  const patientKeys = new Set((store.patients || []).map(p => normalizeName(p.fullName)).filter(Boolean));
  const relevant = patientKeys.size ? scripts.filter(s => patientKeys.has(s.patientNameKey)) : scripts;
  const byPatientMedicine = new Map();
  for (const s of relevant) {
    const key = `${s.patientNameKey}||${s.medicineKey}`;
    const old = byPatientMedicine.get(key);
    if (!old || scriptFreshnessScore(s) >= scriptFreshnessScore(old)) byPatientMedicine.set(key, s);
  }
  return [...byPatientMedicine.values()].sort((a,b) => a.patientFullName.localeCompare(b.patientFullName) || a.drugDescription.localeCompare(b.drugDescription));
}
function linkPatientFlags(store) {
  const medsByPatient = new Map();
  for (const m of store.medications) {
    if (!medsByPatient.has(m.patientNameKey)) medsByPatient.set(m.patientNameKey, []);
    medsByPatient.get(m.patientNameKey).push(m);
  }
  for (const p of store.patients) {
    const key = normalizeName(p.fullName);
    const meds = medsByPatient.get(key) || [];
    if (meds.some(m => m.s8Priority)) p.s8Priority = true;
    if (meds.some(m => m.patientSupplied)) p.patientSuppliedMeds = true;
  }
}
function htmlEsc(v) { return cleanText(v).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])); }

function cleanPackNamePart(v) {
  return stripHind(cleanText(v).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' '));
}
function orderStatusClass(days, status) {
  if (/received|complete|cancelled/i.test(status || '')) return 'Complete';
  if (days === null || days === undefined) return 'Needs pickup date';
  if (days < 0) return 'Overdue';
  if (days === 0) return 'Due today';
  if (days <= 3) return 'Due soon';
  if (days <= 7) return 'Due this week';
  return 'Scheduled';
}
function computeSpecialOrder(order, store) {
  const patient = (store.patients || []).find(p => p.id === order.patientId) || null;
  const settings = store.settings || DEFAULT_STORE.settings;
  const followPatientCycle = order.followPatientCycle !== false;
  const lastPickup = parseDate(followPatientCycle ? (patient?.lastPickupDate || order.lastPickupDate) : (order.lastPickupDate || patient?.lastPickupDate));
  const cycleDays = Math.max(1, num(followPatientCycle ? (patient?.cycleDays || order.cycleDays) : (order.cycleDays || patient?.cycleDays), settings.defaultCycleDays));
  const leadDays = Math.max(0, num(order.orderLeadDays, settings.defaultSpecialOrderLeadDays));
  const nextPickup = lastPickup ? addDays(lastPickup, cycleDays) : null;
  const due = nextPickup ? addDays(nextPickup, -leadDays) : null;
  const today = todayDate();
  const daysToOrder = due ? diffDays(due, today) : null;
  const daysToPickup = nextPickup ? diffDays(nextPickup, today) : null;
  const computedStatus = orderStatusClass(daysToOrder, order.status);
  return {
    ...order,
    patientFullName: order.patientFullName || patient?.fullName || '',
    lastPickupDate: lastPickup ? toISODate(lastPickup) : '',
    lastPickupDisplay: lastPickup ? formatAU(lastPickup) : '',
    cycleDays,
    orderLeadDays: leadDays,
    nextPickupDate: nextPickup ? toISODate(nextPickup) : '',
    nextPickupDisplay: nextPickup ? formatAU(nextPickup) : '',
    orderDueDate: due ? toISODate(due) : '',
    orderDueDisplay: due ? formatAU(due) : '',
    daysToOrder,
    daysToPickup,
    computedStatus
  };
}
function specialOrdersComputed(store) {
  return (store.specialOrders || [])
    .filter(o => o.active !== false)
    .map(o => computeSpecialOrder(o, store))
    .sort((a,b)=>(a.daysToOrder ?? 9999)-(b.daysToOrder ?? 9999) || a.patientFullName.localeCompare(b.patientFullName) || a.medicine.localeCompare(b.medicine));
}
function specialDashboard(store) {
  const list = specialOrdersComputed(store);
  return list.filter(o => !/received|complete|cancelled/i.test(o.status || '') && (o.daysToOrder === null || o.daysToOrder <= 14));
}
function findPatientByNames(store, first, last, fullName='') {
  const f = cleanPackNamePart(first);
  const l = cleanPackNamePart(last);
  const candidates = [fullName, [f,l].filter(Boolean).join(' '), [l,f].filter(Boolean).join(' ')].map(normalizeName).filter(Boolean);
  return (store.patients || []).find(p => candidates.includes(normalizeName(p.fullName))) || null;
}
function parseCsvText(text) {
  const lines = String(text || '').replace(/^\ufeff/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  function split(line){
    const out=[]; let cur=''; let q=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch === '"') { if(q && line[i+1] === '"'){cur+='"'; i++;} else q=!q; }
      else if(ch === ',' && !q){ out.push(cur); cur=''; }
      else cur += ch;
    }
    out.push(cur); return out.map(cleanText);
  }
  const header = split(lines[0]);
  return lines.slice(1).map((line, idx)=>{
    const vals = split(line); const row={}; header.forEach((h,i)=>row[h]=vals[i]||''); return { sheetName:'text/csv', rowNumber:idx+2, row };
  });
}
function rowsFromUploadedReport(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (['.xlsx','.xls'].includes(ext)) return workbookRows(buffer);
  const text = buffer.toString('utf8');
  if (ext === '.pdf') {
    // This bundled Replit build avoids heavy PDF parsers. It can read text-based exports/pasted text; scanned/compressed PDFs should be exported/pasted as text or CSV.
    const rows = parseCsvText(text);
    if (!rows.length || !Object.keys(rows[0].row || {}).some(k => /last name|patient name/i.test(k))) throw new Error('PDF report could not be parsed in this bundled build. Please paste/export the Pack Management Record as text/CSV, then import it here.');
    return rows;
  }
  return parseCsvText(text);
}
function importPackRecord(buffer, filename) {
  const store = readStore();
  const rows = rowsFromUploadedReport(buffer, filename);
  const updates = new Map();
  const records = [];
  let matched = 0, unmatched = 0;
  for (const w of rows) {
    const r = w.row;
    const last = r['Last Name'] ?? rowVal(r, FIELD_ALIASES.lastName) ?? '';
    const first = r['First Name'] ?? rowVal(r, FIELD_ALIASES.firstName) ?? '';
    const patientName = r['Patient Name'] ?? rowVal(r, FIELD_ALIASES.fullName) ?? '';
    const group = r['Patient Group'] || r['Group'] || '';
    const packStart = dateOrBlank(r['Pack Start Date'] || r['Start Date'] || r['Pack Date']);
    const collection = dateOrBlank(r['Collection Date'] || r['Collected Date'] || r['Pickup Date']);
    if (!first && !last && !patientName) continue;
    const patient = findPatientByNames(store, first, last, patientName);
    const rec = { id:id(), patientId: patient?.id || '', patientFullName: patient?.fullName || cleanText(`${first} ${last}`) || patientName, patientGroup: group, pack: cleanText(r['Pack']), packStartDate: packStart, collectionType: cleanText(r['Collection Type']), collectionDate: collection, packedBy: cleanText(r['Packed by']), checkedBy: cleanText(r['Checked by']), source: filename, importedAt: nowISO() };
    records.push(rec);
    if (!patient) { unmatched++; continue; }
    matched++;
    const useDate = collection || packStart;
    if (useDate) {
      const old = updates.get(patient.id);
      if (!old || (parseDate(useDate) > parseDate(old.date))) updates.set(patient.id, { date: useDate, group });
    }
  }
  for (const [pid, u] of updates.entries()) {
    const p = store.patients.find(x=>x.id===pid);
    if (!p) continue;
    p.lastPickupDate = u.date;
    if (u.group) { p.patientGroup = u.group; p.cycleDays = inferCycleDays(u.group, store.settings); }
    p.updatedAt = nowISO();
  }
  store.packRecords = [...records, ...(store.packRecords || [])].slice(0, 5000);
  const reviews = records.filter(r=>!r.patientId).slice(0,200).map(r=>({ id:id(), type:'pack-record', fullName:r.patientFullName, result:'Pack record not matched', severity:'warning', action:'Check name spelling or add patient manually', source:filename, at:nowISO() }));
  store.importReviews = [...reviews, ...(store.importReviews || [])].slice(0,1000);
  audit(store, 'Imported Pack Management Record', { filename, rows: rows.length, matched, unmatched, patientsUpdated: updates.size });
  writeStore(store);
  return { rows: rows.length, matched, unmatched, patientsUpdated: updates.size };
}
const SEEDED_SPECIAL_ORDERS = [
  ['Davis Morley','Biktarvy / bictegravir 50 mg/200 mg/25 mg','RDH','Special Order','Monthly ART order; confirm exact drug name/strength'],
  ['Ken Herbert','Thyroid extract 50 mg and 175 mg','CP','Special Order','Confirm formulation and strength'],
  ['Kosta Kariotis','Myfortic 360 mg','Hibiscus One','Special Order','External supply'],
  ['Bonnie G Chambers','Fluoxetine 30 mg','CP','Special Order','Confirm strength/directions'],
  ['Zane Dolbel','Myfortic 360 mg','Hibiscus One','Special Order','External supply'],
  ['Manmay Limbu','Myfortic + tacrolimus','Hibiscus One','Special Order','Confirm medicines/strengths'],
  ['Harry Lay','Entecavir 0.5 mg','RDH','Special Order','RDH order'],
  ['Theofilos Magriplis','Clozapine','Hibiscus One','Special Order','First dispense then order; confirm workflow'],
  ['Bonnie Brown','Invega','Hibiscus One','Special Order','Confirm formulation'],
  ['Naomi Page','Lurasidone','Hibiscus One','Special Order','First order/confirm'],
  ['Patrice Rowland','Fampyra + magnesium','Hibiscus One / CP','Special Order','Confirm magnesium item'],
  ['Jirapan Chiangpruek','Mycophenolate + tacrolimus','Hibiscus One','Special Order','Confirm strength/dose'],
  ['Adam Turley','Vyvanse','Hibiscus One','S8','S8 special order'],
  ['Ricardo Fisher','Targin','Hibiscus One','S8','S8 special order'],
  ['Sandra Jeffrey','Targin + diazepam','Hibiscus One','S8','Monthly S8/benzodiazepine order; check dates'],
  ['Jari Rouvali','Panadeine Forte','NT','S8/Special','NT order; confirm indication/source']
];
function seedSpecialOrders(store) {
  let added = 0;
  for (const [name, med, source, category, notes] of SEEDED_SPECIAL_ORDERS) {
    const p = (store.patients || []).find(x => normalizeName(x.fullName) === normalizeName(name));
    if (!p) continue;
    const exists = (store.specialOrders || []).some(o => o.patientId === p.id && normalizeName(o.medicine) === normalizeName(med));
    if (exists) continue;
    store.specialOrders.push({ id:id(), patientId:p.id, patientFullName:p.fullName, medicine:med, strength:'', directions:'', source, category, lastPickupDate:'', cycleDays:'', followPatientCycle:true, orderLeadDays:store.settings.defaultSpecialOrderLeadDays, status:'Needs confirmation', notes, active:true, createdAt:nowISO(), updatedAt:nowISO() });
    if (/s8|vyvanse|targin|diazepam|panadeine/i.test(`${category} ${med}`)) p.s8Priority = true;
    added++;
  }
  return added;
}
function specialOrderPayload(body, store, existing={}) {
  const p = store.patients.find(x => x.id === (body.patientId || existing.patientId));
  if (!p) throw new Error('Patient not found for special order');
  return {
    ...existing,
    patientId: p.id,
    patientFullName: p.fullName,
    medicine: cleanText(body.medicine ?? existing.medicine),
    strength: cleanText(body.strength ?? existing.strength),
    directions: cleanText(body.directions ?? existing.directions),
    source: cleanText(body.source ?? existing.source ?? 'Other'),
    category: cleanText(body.category ?? existing.category ?? 'Special Order'),
    lastPickupDate: dateOrBlank(body.lastPickupDate ?? existing.lastPickupDate ?? p.lastPickupDate),
    cycleDays: num(body.cycleDays ?? existing.cycleDays ?? p.cycleDays, store.settings.defaultCycleDays),
    orderLeadDays: num(body.orderLeadDays ?? existing.orderLeadDays ?? store.settings.defaultSpecialOrderLeadDays, store.settings.defaultSpecialOrderLeadDays),
    status: cleanText(body.status ?? existing.status ?? 'Not ordered'),
    notes: cleanText(body.notes ?? existing.notes),
    followPatientCycle: body.followPatientCycle === undefined ? (existing.followPatientCycle !== false && !body.lastPickupDate) : !!body.followPatientCycle,
    active: body.active === undefined ? (existing.active !== false) : !!body.active,
    updatedAt: nowISO()
  };
}
function specialOrderLetterHtml(r) {
  const rows = (r.items || []).map(i => `<tr><td>${htmlEsc(i.patientFullName)}</td><td>${htmlEsc(i.medicine)}</td><td>${htmlEsc(i.strength || '')}</td><td>${htmlEsc(i.directions || '')}</td><td>${htmlEsc(i.source || '')}</td><td>${htmlEsc(i.nextPickupDisplay || '')}</td><td>${htmlEsc(i.orderDueDisplay || '')}</td></tr>`).join('');
  const title = r.mode === 'internal' ? 'Special Order Checklist' : 'Special Medication / Prescription Request';
  return `<!doctype html><html><head><title>${htmlEsc(title)}</title><style>@page{size:A4;margin:18mm}body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#111}.printbar{position:sticky;top:0;background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin-bottom:16px}.printbar button{padding:8px 12px;background:#0f172a;color:white;border:0;border-radius:8px}.pharmacy{line-height:1.25;margin-bottom:18px}.title{font-weight:700;font-size:15pt;margin:16px 0}.tbl{width:100%;border-collapse:collapse;margin:14px 0}.tbl th,.tbl td{border:1px solid #bbb;padding:6px;vertical-align:top}.tbl th{background:#f1f5f9}@media print{.printbar{display:none}}</style></head><body><div class="printbar"><button onclick="window.print()">Print / Save as PDF</button><span>Editable request generated from Special Orders.</span></div><div class="pharmacy"><b>Hibiscus Day and Night Pharmacy</b><br>Hibiscus Shopping Centre,<br>4/8 Leanyer Dr,<br>Leanyer NT 0812<br>(08) 8945 5955</div><div class="title">${htmlEsc(title)}</div><p>Date: ${htmlEsc(dateDisplay(r.date))}</p><p>Recipient: ${htmlEsc(r.recipient || 'External supplier / prescriber')}</p><p>Please review/provide the following medicines required for upcoming Webster/sachet packs where appropriate.</p><table class="tbl"><thead><tr><th>Patient</th><th>Medicine</th><th>Strength</th><th>Directions</th><th>Source</th><th>Next pickup</th><th>Order due</th></tr></thead><tbody>${rows}</tbody></table>${r.note ? `<p><b>Note:</b> ${htmlEsc(r.note)}</p>` : ''}<p>Kind Regards,<br>Hibiscus Pharmacy</p></body></html>`;
}

function buildState(store) {
  return { ...store, patientsComputed: activeComputed(store).sort((a,b)=>(a.daysToPickup ?? 9999)-(b.daysToPickup ?? 9999)||a.fullName.localeCompare(b.fullName)), specialOrdersComputed: specialOrdersComputed(store), dashboard: dashboard(store) };
}
function importPatients(buffer, filename) {
  const store = readStore(); const rows = workbookRows(buffer);
  const hindRows = rows.filter(w => {
    const r = w.row;
    const vals = [...FIELD_ALIASES.firstName, ...FIELD_ALIASES.middleName, ...FIELD_ALIASES.lastName, ...FIELD_ALIASES.fullName].map(a => rowVal(r,[a]));
    return vals.some(hasHindValue);
  });
  const incoming = hindRows.map(w => buildPatient(w, store.settings)).filter(p => p.fullName);
  const byKey = new Map(store.patients.map(p => [p.matchKey || matchKeyFor(p), p]));
  const incomingKeys = new Set(incoming.map(p => p.matchKey));
  const reviews = [];
  let added = 0, updated = 0, missing = 0;
  for (const p of incoming) {
    const old = byKey.get(p.matchKey);
    if (old) {
      const preserve = ['id','createdAt','lastPickupDate','cycleDays','packLeadDays','dispenseLeadDays','orderLeadDays','packStatus','dispenseStatus','medicineOrderStatus','scriptRequestStatus','patientSuppliedMeds','s8Priority','urgent','notes'];
      const keep = Object.fromEntries(preserve.map(k => [k, old[k]]));
      Object.assign(old, p, keep, { updatedAt: nowISO(), active: true });
      updated++;
      reviews.push({ id: id(), type: 'patient', fullName: old.fullName, result: 'Updated existing', severity: 'ok', action: 'Preserved workflow settings; refreshed demographic/source data', source: `${p.sourceSheet}:${p.sourceRow}`, at: nowISO() });
    } else {
      store.patients.push(p); byKey.set(p.matchKey, p); added++;
      reviews.push({ id: id(), type: 'patient', patientId: p.id, fullName: p.fullName, result: 'New HIND patient detected', severity: 'review', action: 'Set pickup cycle, last pickup date and workflow flags', source: `${p.sourceSheet}:${p.sourceRow}`, at: nowISO() });
    }
  }
  for (const p of store.patients) {
    const key = p.matchKey || matchKeyFor(p);
    if (p.active !== false && !incomingKeys.has(key) && store.patients.length > 0) {
      missing++;
      reviews.push({ id: id(), type: 'patient', patientId: p.id, fullName: p.fullName, result: 'Previously listed but not HIND in latest upload', severity: 'warning', action: 'Do not delete automatically. Review if inactive/discharged/tag removed.', source: filename, at: nowISO() });
    }
  }
  store.importReviews = [...reviews, ...store.importReviews].slice(0, 1000);
  const seededSpecialOrders = seedSpecialOrders(store);
  audit(store, 'Imported patient list', { filename, totalRows: rows.length, hindRows: incoming.length, added, updated, missing, seededSpecialOrders });
  writeStore(store);
  return { totalRows: rows.length, hindRows: incoming.length, added, updated, missing, seededSpecialOrders, reviews };
}

app.get('/api/state', (_, res) => res.json(buildState(readStore())));
app.get('/api/mypak/status', (_, res) => {
  const sync = readStore().mypakSync || {};
  res.json({ configured: mypakClient.isConfigured(), authenticated: Boolean(mypakClient.lastSuccessfulRequestAt || sync.lastSuccessAt), baseUrl: mypakClient.baseUrl, lastSuccessfulRequestAt: mypakClient.lastSuccessfulRequestAt || sync.lastSuccessAt || null, lastSyncAt: sync.lastSyncAt || null, lastError: sync.lastError || null, patientCount: sync.totalPatients || 0 });
});
app.post('/api/mypak/test', async (_, res) => { try { await mypakClient.reportOptions(); res.json({ ok: true, authenticated: true }); } catch (error) { sendMyPakError(res, error); } });
app.get('/api/mypak/patients', async (req, res) => {
  try {
    const integers = (value, fallback) => { const n = Number(value); return Number.isInteger(n) ? n : fallback; };
    const list = value => String(value || '').split(',').map(v => Number(v.trim())).filter(Number.isFinite);
    const body = { pageIndex: Math.max(1, integers(req.query.pageIndex, 1)), pageSize: Math.min(200, Math.max(1, integers(req.query.pageSize, 50))), packingStatus: req.query.packingStatus ? list(req.query.packingStatus) : [0, 1, 3], sortField: String(req.query.sortField || 'LastName'), sortOrder: integers(req.query.sortOrder, 1) };
    for (const key of ['textSearch']) if (req.query[key] !== undefined) body[key] = String(req.query[key]).slice(0, 200);
    for (const key of ['patientGroupIds', 'patientIds']) if (req.query[key] !== undefined) body[key] = list(req.query[key]);
    const result = await mypakClient.listPatients(body);
    res.json({ data: Array.isArray(result.data) ? result.data : [], total: Number(result.total) || 0, pageIndex: body.pageIndex, pageSize: body.pageSize });
  } catch (error) { sendMyPakError(res, error); }
});
app.get('/api/mypak/patients/:mypakPatientId', (req, res) => { const patient = readStore().patients.find(p => String(p.mypakPatientId) === String(req.params.mypakPatientId)); if (!patient) return res.status(404).json({ error: 'MyPak patient not found in local cache' }); res.json(patient); });
app.get('/api/mypak/groups/:groupId', async (req, res) => { try { res.json(await mypakClient.patientGroup(req.params.groupId)); } catch (error) { sendMyPakError(res, error); } });
app.get('/api/mypak/report-options', async (_, res) => { try { res.json(await mypakClient.reportOptions()); } catch (error) { sendMyPakError(res, error); } });
app.post('/api/mypak/sync/patients', async (_, res) => { try { const result = await mypakSyncService.syncPatients(); res.status(result.started ? 200 : 409).json(result); } catch (error) { sendMyPakError(res, error); } });
app.post('/api/mypak/sync/all', async (_, res) => { try { const result = await mypakSyncService.syncAll(); res.status(result.started ? 200 : 409).json(result); } catch (error) { sendMyPakError(res, error); } });
app.get('/api/mypak/sync/status', (_, res) => res.json(mypakSyncService.getStatus()));
app.get('/api/export/store', (_, res) => res.download(DATA_FILE, `webster-pack-backup-${toISODate(todayDate())}.json`));
app.post('/api/reset', (req, res) => { const store = clone(DEFAULT_STORE); audit(store, 'Reset store', { reason: req.body?.reason || 'manual reset' }); writeStore(store); res.json({ ok: true }); });
app.post('/api/settings', (req, res) => { const store = readStore(); store.settings = { ...store.settings, ...req.body }; audit(store, 'Updated settings', req.body); writeStore(store); res.json(buildState(store)); });
app.post('/api/import/patients', upload.single('file'), (req, res) => { try { if (!req.file) throw new Error('No file uploaded'); res.json(importPatients(req.file.buffer, req.file.originalname)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/import/medications', upload.single('file'), (req, res) => { try { if (!req.file) throw new Error('No file uploaded'); const store = readStore(); const rows = workbookRows(req.file.buffer); const meds = rows.map(buildMedication).filter(Boolean); store.medications = meds; linkPatientFlags(store); audit(store, 'Imported medication list', { filename: req.file.originalname, rows: rows.length, medications: meds.length }); writeStore(store); res.json({ rows: rows.length, medications: meds.length }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.post('/api/import/scripts', upload.single('file'), (req, res) => { try { if (!req.file) throw new Error('No file uploaded'); const store = readStore(); const result = scriptRowsFast(req.file.buffer, store.settings, store); store.scripts = result.scripts; linkPatientFlags(store); const issues = store.scripts.filter(s=>s.requestFlag!=='OK').length; audit(store, 'Imported scripts list', { filename: req.file.originalname, rows: result.totalRows, parsed: result.parsed, matched: result.matched, scripts: store.scripts.length, issues, skippedNoNameOrDrug: result.skippedNoNameOrDrug, skippedNonMedicine: result.skippedNonMedicine }); writeStore(store); res.json({ rows: result.totalRows, parsed: result.parsed, matched: result.matched, scripts: store.scripts.length, issues, skippedNonMedicine: result.skippedNonMedicine }); } catch(e) { console.error(e); res.status(400).json({ error: e.message }); } });

app.post('/api/import/pack-record', upload.single('file'), (req, res) => { try { if (!req.file) throw new Error('No file uploaded'); res.json(importPackRecord(req.file.buffer, req.file.originalname)); } catch(e) { console.error(e); res.status(400).json({ error: e.message }); } });
app.post('/api/special-orders', (req, res) => { try { const store = readStore(); const order = { id:id(), createdAt:nowISO(), ...specialOrderPayload(req.body, store) }; store.specialOrders.unshift(order); const p = store.patients.find(x=>x.id===order.patientId); if (/s8|vyvanse|targin|diazepam|panadeine|methylphenidate|ritalin/i.test(`${order.category} ${order.medicine}`)) p.s8Priority = true; audit(store, 'Added special order', { patient: order.patientFullName, medicine: order.medicine, source: order.source }); writeStore(store); res.json(computeSpecialOrder(order, store)); } catch(e) { res.status(400).json({ error: e.message }); } });
app.patch('/api/special-orders/:id', (req, res) => { try { const store = readStore(); const old = store.specialOrders.find(x=>x.id===req.params.id); if (!old) return res.status(404).json({ error:'Special order not found' }); const updated = specialOrderPayload(req.body, store, old); Object.assign(old, updated); audit(store, 'Updated special order', { patient: old.patientFullName, medicine: old.medicine, status: old.status }); writeStore(store); res.json(computeSpecialOrder(old, store)); } catch(e) { res.status(400).json({ error:e.message }); } });
app.post('/api/special-order-request', (req, res) => { const store = readStore(); const ids = Array.isArray(req.body.orderIds) ? req.body.orderIds : []; const selected = specialOrdersComputed(store).filter(o => ids.includes(o.id)); if (!selected.length) return res.status(400).json({ error:'No special orders selected' }); const request = { id:id(), date:toISODate(todayDate()), recipient:cleanText(req.body.recipient || 'External supplier / prescriber'), mode:cleanText(req.body.mode || 'external'), note:cleanText(req.body.note), status:'Draft', items:selected, createdAt:nowISO() }; store.specialOrderRequests.unshift(request); for (const o of store.specialOrders) if (ids.includes(o.id) && !/received|complete/i.test(o.status || '')) o.status = 'Request generated'; audit(store, 'Created special order request', { itemCount:selected.length, recipient:request.recipient }); writeStore(store); res.json(request); });
app.get('/api/special-order-letter/:requestId', (req, res) => { const store = readStore(); const r = store.specialOrderRequests.find(x=>x.id===req.params.requestId); if (!r) return res.status(404).send('Request not found'); res.type('html').send(specialOrderLetterHtml(r)); });
app.get('/api/special-order-letter/:requestId/pdf', (req, res) => { const store = readStore(); const r = store.specialOrderRequests.find(x=>x.id===req.params.requestId); if (!r) return res.status(404).send('Request not found'); res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Disposition', `inline; filename="special-order-request-${r.date}.pdf"`); const doc = new PDFDocument({ margin: 36, size: 'A4' }); doc.pipe(res); doc.font('Helvetica-Bold').fontSize(14).text('Hibiscus Day and Night Pharmacy'); doc.font('Helvetica').fontSize(10).text('Hibiscus Shopping Centre, 4/8 Leanyer Dr, Leanyer NT 0812'); doc.text('(08) 8945 5955'); doc.moveDown(); doc.font('Helvetica-Bold').fontSize(16).text(r.mode === 'internal' ? 'Special Order Checklist' : 'Special Medication / Prescription Request'); doc.font('Helvetica').fontSize(10).text(`Date: ${dateDisplay(r.date)}`); doc.text(`Recipient: ${r.recipient || 'External supplier / prescriber'}`); doc.moveDown(); doc.text('Please review/provide the following medicines required for upcoming Webster/sachet packs where appropriate.'); doc.moveDown(); const startX=doc.x, widths=[95,130,70,85,65,65]; function row(cols, header=false){ const y=doc.y; const h=38; doc.font(header?'Helvetica-Bold':'Helvetica').fontSize(8); let x=startX; cols.forEach((c,i)=>{ doc.rect(x,y,widths[i],h).stroke(); doc.text(String(c??''),x+3,y+4,{width:widths[i]-6,height:h-8}); x+=widths[i]; }); doc.y=y+h; if(doc.y>735) doc.addPage(); } row(['Patient','Medicine','Strength','Source','Next pickup','Order due'], true); (r.items||[]).forEach(i=>row([i.patientFullName, i.medicine, i.strength||'', i.source||'', i.nextPickupDisplay||'', i.orderDueDisplay||''])); if(r.note){ doc.moveDown(); doc.font('Helvetica-Bold').text('Note:'); doc.font('Helvetica').text(r.note); } doc.moveDown(); doc.text('Kind Regards,'); doc.text('Hibiscus Pharmacy'); doc.end(); });

app.patch('/api/patients/:id', (req, res) => { const store = readStore(); const p = store.patients.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Patient not found' }); const before = clone(p); const allowed = ['fullName','firstName','lastName','dob','phone','address','cycleDays','lastPickupDate','packLeadDays','dispenseLeadDays','orderLeadDays','packStatus','dispenseStatus','medicineOrderStatus','scriptRequestStatus','patientSuppliedMeds','s8Priority','urgent','notes','active','packType']; for (const k of allowed) if (k in req.body) p[k] = req.body[k]; p.lastPickupDate = dateOrBlank(p.lastPickupDate); p.matchKey = matchKeyFor(p); p.updatedAt = nowISO(); audit(store, 'Updated patient', { patient: p.fullName, before, after: p }); writeStore(store); res.json(computePatient(p, store.settings)); });
app.get('/api/patients/:id/details', (req, res) => { const store = readStore(); const p = store.patients.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Patient not found' }); const key = normalizeName(p.fullName); res.json({ patient: computePatient(p, store.settings), medications: store.medications.filter(m => m.patientNameKey === key), scripts: store.scripts.filter(s => s.patientNameKey === key), doctorUpdates: store.doctorUpdates.filter(u => u.patientId === p.id), scriptRequests: store.scriptRequests.filter(r => r.patientId === p.id) }); });
app.post('/api/script-request', (req, res) => {
  const store = readStore();
  const p = store.patients.find(x => x.id === req.body.patientId);
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  const selectedRaw = Array.isArray(req.body.items) ? req.body.items : [];
  // Safety rule requested by pharmacy: items with sufficient repeats / status OK must never appear on the GP letter.
  // Staff can still see OK medicines in the builder when they turn on "show all", but the generated letter only keeps actionable items.
  const selected = selectedRaw
    .map(i => ({ ...i, status: cleanText(i.status || i.requestFlag || '') }))
    .filter(i => i.medicineName || i.drugDescription)
    .filter(i => !/^ok$/i.test(i.status));
  if (!selected.length) return res.status(400).json({ error: 'No actionable medicines selected. OK / sufficient-repeat items are excluded from GP letters.' });
  const request = { id: id(), patientId: p.id, patientFullName: p.fullName, date: toISODate(todayDate()), status: 'Draft', recipient: req.body.recipient || 'GP / Prescriber', items: selected, note: cleanText(req.body.note), createdAt: nowISO() };
  store.scriptRequests.unshift(request);
  p.scriptRequestStatus = 'Draft request created';
  audit(store, 'Created script request', { patient: p.fullName, itemCount: selected.length, excludedOK: selectedRaw.length - selected.length });
  writeStore(store);
  res.json(request);
});
app.patch('/api/script-request/:id', (req, res) => { const store = readStore(); const r = store.scriptRequests.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'Request not found' }); Object.assign(r, req.body, { updatedAt: nowISO() }); audit(store, 'Updated script request', { patient: r.patientFullName, status: r.status }); writeStore(store); res.json(r); });
app.post('/api/doctor-updates', (req, res) => { const store = readStore(); const p = store.patients.find(x => x.id === req.body.patientId); if (!p) return res.status(404).json({ error: 'Patient not found' }); const update = { id: id(), patientId: p.id, patientFullName: p.fullName, receivedDate: dateOrBlank(req.body.receivedDate) || toISODate(todayDate()), source: cleanText(req.body.source || 'Doctor letter'), changeType: cleanText(req.body.changeType || 'Medication change'), medicine: cleanText(req.body.medicine), oldDirection: cleanText(req.body.oldDirection), newDirection: cleanText(req.body.newDirection), effectiveFrom: cleanText(req.body.effectiveFrom || 'Needs review'), status: 'Pending pharmacist review', risk: cleanText(req.body.risk || 'Routine'), notes: cleanText(req.body.notes), createdAt: nowISO() }; store.doctorUpdates.unshift(update); p.urgent = p.urgent || /urgent|current|immediate/i.test(update.risk + ' ' + update.effectiveFrom); audit(store, 'Added doctor medication update', { patient: p.fullName, medicine: update.medicine, changeType: update.changeType }); writeStore(store); res.json(update); });
app.patch('/api/doctor-updates/:id', (req, res) => { const store = readStore(); const u = store.doctorUpdates.find(x => x.id === req.params.id); if (!u) return res.status(404).json({ error: 'Doctor update not found' }); Object.assign(u, req.body, { updatedAt: nowISO() }); audit(store, 'Updated doctor update', { patient: u.patientFullName, status: u.status }); writeStore(store); res.json(u); });
function scriptLetterHtml(r) {
  const rows = r.items.map(i => {
    const reason = cleanText(i.status || i.requestFlag || 'New prescription required');
    const repeats = cleanText(i.repeatsLeft ?? '');
    const detail = reason === 'Script owing' ? 'Script owing' : (repeats !== '' ? `${repeats} repeat${repeats === '1' ? '' : 's'} left` : reason);
    return `<tr><td>${htmlEsc(i.medicineName || i.drugDescription)}</td><td>${htmlEsc(detail)}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><title>New Prescription Required - ${htmlEsc(r.patientFullName)}</title><style>
    @page{size:A4;margin:22mm 20mm}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;font-size:12pt;line-height:1.35}.page{max-width:760px;margin:0 auto;padding:8px 0}.important{font-weight:700;letter-spacing:.3px;margin-bottom:10px}.pharmacy{line-height:1.25;margin-bottom:22px}.title{text-align:left;font-size:15pt;font-weight:700;margin:10px 0 24px}.date{text-align:right;margin-bottom:18px}.body p{margin:0 0 14px}.patient-name{font-weight:700}.script-table{width:100%;border-collapse:collapse;margin:18px 0 26px}.script-table td{border:0;padding:7px 0;vertical-align:top}.script-table td:first-child{width:68%;padding-right:20px}.script-table tr{border-bottom:1px solid #d5d5d5}.footer{margin-top:30px}.printbar{position:sticky;top:0;background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:10px;margin-bottom:20px;display:flex;gap:10px;align-items:center}.printbar button{padding:9px 14px;border:0;border-radius:8px;background:#0f172a;color:white;cursor:pointer}@media print{.printbar{display:none}.page{max-width:none}}
  </style></head><body><div class="printbar"><button onclick="window.print()">Print / Save as PDF</button><span>Only selected non-OK medicines are included.</span></div><div class="page">
  <div class="important">IMPORTANT</div>
  <div class="pharmacy"><b>Hibiscus Day and Night Pharmacy</b><br>Hibiscus Shopping Centre,<br>4/8 Leanyer Dr,<br>Leanyer NT 0812<br>(08) 8945 5955</div>
  <div class="title">New Prescription Required</div>
  <div class="date">${htmlEsc(dateDisplay(r.date))}</div>
  <div class="body"><p>Dear Dr,</p>
  <p>Our client, <span class="patient-name">${htmlEsc(r.patientFullName)}</span> is picking up monthly medication from us. The following prescriptions are due in the next two months:</p>
  <table class="script-table"><tbody>${rows}</tbody></table>
  ${r.note ? `<p><b>Note:</b> ${htmlEsc(r.note)}</p>` : ''}
  <p>Kindly review and provide the prescription if it is appropriate. Thanks a lot.</p>
  <p class="footer">Kind Regards,<br>Hibiscus Pharmacy</p></div></div></body></html>`;
}
app.get('/api/letter/:requestId', (req, res) => { const store = readStore(); const r = store.scriptRequests.find(x => x.id === req.params.requestId); if (!r) return res.status(404).send('Request not found'); res.type('html').send(scriptLetterHtml(r)); });
app.get('/api/letter/:requestId/pdf', (req, res) => {
  const store = readStore();
  const r = store.scriptRequests.find(x => x.id === req.params.requestId);
  if (!r) return res.status(404).send('Request not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="script-request-${String(r.patientFullName).replace(/[^a-z0-9]+/ig,'-')}.pdf"`);
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  doc.pipe(res);
  doc.font('Helvetica-Bold').fontSize(18).text('Prescription / Repeat Request');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(11).text(`Patient: ${r.patientFullName}`);
  doc.text(`Date: ${dateDisplay(r.date)}`);
  doc.moveDown(1.2);
  doc.text('Dear Doctor,');
  doc.moveDown(0.7);
  doc.text('Could you please provide updated prescriptions for the following regular packed medicines for this patient.');
  doc.moveDown(1);
  const startX = doc.x, widths = [205, 145, 70, 110];
  function row(cols, header=false) {
    const y = doc.y; const h = 34;
    doc.font(header?'Helvetica-Bold':'Helvetica').fontSize(9);
    let x = startX;
    cols.forEach((c,i)=>{ doc.rect(x,y,widths[i],h).stroke(); doc.text(String(c ?? ''), x+4, y+5, { width: widths[i]-8, height: h-8 }); x += widths[i]; });
    doc.y = y + h;
    if (doc.y > 740) { doc.addPage(); }
  }
  row(['Medicine','Directions','Repeats','Request reason'], true);
  (r.items || []).forEach(i => row([i.medicineName || i.drugDescription || '', i.directions || '', i.repeatsLeft ?? '', i.status || i.requestFlag || '']));
  doc.moveDown(1);
  if (r.note) { doc.font('Helvetica-Bold').text('Note:'); doc.font('Helvetica').text(r.note); doc.moveDown(1); }
  doc.text('Kind regards,');
  doc.text('Pharmacy team');
  doc.end();
});
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Webster Pack Pro v2.3.5 running on http://localhost:${PORT}`));
  const syncMinutes = Number(process.env.MYPAK_SYNC_INTERVAL_MINUTES || 0);
  if (Number.isFinite(syncMinutes) && syncMinutes > 0) setInterval(() => { mypakSyncService.syncPatients().catch(() => {}); }, syncMinutes * 60 * 1000).unref();
}

export { parseDate, dateDisplay, normalizeName, hasHindValue, inferRequestFlag, computePatient };
