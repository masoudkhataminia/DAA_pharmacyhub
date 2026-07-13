import crypto from 'crypto';

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const normalName = value => text(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const isoDate = value => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : ''; };
const fullName = row => text(row.fullName || row.fullnameRev || `${row.firstName || ''} ${row.lastName || ''}`);

export function normalizeMyPakMedicationBalance(row) {
  const repeatText = text(row?.repeatsLeft);
  const repeatPosition = repeatText === '' ? null : Number(repeatText);
  const hasRepeatPosition = Number.isFinite(repeatPosition);
  return {
    ...row,
    hasRepeatPosition,
    newScriptNeeded: hasRepeatPosition ? repeatPosition <= 0 : null
  };
}

function cycleDays(group, settings) {
  const value = text(group).toLowerCase();
  if (/fortnight|2\s*week|14\s*day/.test(value)) return settings.fortnightlyDays || 14;
  if (/weekly|7\s*day/.test(value)) return settings.weeklyDays || 7;
  if (/month|28\s*day|30\s*day/.test(value)) return settings.monthlyDays || 28;
  return settings.defaultCycleDays || 14;
}

function matches(row, patients) {
  const mypakId = text(row.patientId);
  let found = patients.filter(p => text(p.mypakPatientId) === mypakId && mypakId);
  if (found.length) return { found, method: 'mypakPatientId', certain: found.length === 1 };
  const external = text(row.externalPatientId);
  found = patients.filter(p => external && [p.mypakExternalPatientId, p.externalId].some(v => text(v) === external));
  if (found.length) return { found, method: 'externalPatientId', certain: found.length === 1 };
  const name = normalName(fullName(row)); const dob = isoDate(row.dob);
  found = patients.filter(p => normalName(p.fullName || `${p.firstName || ''} ${p.lastName || ''}`) === name && dob && isoDate(p.dob) === dob);
  if (found.length) return { found, method: 'nameDob', certain: found.length === 1 };
  found = patients.filter(p => normalName(p.fullName || `${p.firstName || ''} ${p.lastName || ''}`) === name);
  return { found, method: 'nameOnly', certain: false };
}

function demographics(row, at) {
  return {
    mypakPatientId: text(row.patientId), mypakPatientGroupId: text(row.patientGroupId), mypakExternalPatientId: text(row.externalPatientId),
    externalId: text(row.externalPatientId), firstName: text(row.firstName), lastName: text(row.lastName), fullName: fullName(row),
    dob: isoDate(row.dob), gender: text(row.gender), address: text(row.address), phone: text(row.phone), patientGroup: text(row.patientGroupName),
    mypakPackingStatus: row.packingStatus ?? null, mypakPatientStatus: row.patientStatus ?? null, dispenseCode: text(row.dispenseCode), room: text(row.room),
    facilityWard: text(row.facilityWard), distribution: row.distribution ?? null, daaFunding: row.daaFunding ?? null, lastMyPakSyncAt: at,
    myPakRawVersion: 1, mypakMetadata: { visionImpaired: Boolean(row.visionImpaired), days30Dispensing: Boolean(row.days30Dispensing), lastCheckedDate: row.lastCheckedDate || null, photoId: row.photoId || null }
  };
}

export function mergeMyPakPatients(store, rows, at = new Date().toISOString()) {
  const stats = { recordsProcessed: 0, recordsAdded: 0, recordsUpdated: 0, recordsSkipped: 0 };
  const reviews = []; const seen = new Set();
  for (const row of rows) {
    stats.recordsProcessed++;
    const match = matches(row, store.patients);
    if (match.certain) {
      const patient = match.found[0]; Object.assign(patient, demographics(row, at), { updatedAt: at, active: patient.active !== false });
      seen.add(patient.id); stats.recordsUpdated++;
    } else if (match.found.length) {
      stats.recordsSkipped++;
      reviews.push({ id: crypto.randomUUID(), type: 'mypak', fullName: fullName(row), result: 'MyPak match needs review', severity: 'warning', action: `Not merged: ${match.found.length} possible ${match.method} match(es)`, source: 'MyPak', at });
    } else {
      const mapped = demographics(row, at);
      const patient = { id: crypto.randomUUID(), ...mapped, packType: 'Webster/Sachet', cycleDays: cycleDays(row.patientGroupName, store.settings), lastPickupDate: '', packLeadDays: store.settings.defaultPackLeadDays, dispenseLeadDays: store.settings.defaultDispenseLeadDays, orderLeadDays: store.settings.defaultOrderLeadDays, packStatus: 'Not started', dispenseStatus: 'Not dispensed', medicineOrderStatus: 'Not checked', scriptRequestStatus: 'Not checked', patientSuppliedMeds: false, s8Priority: false, urgent: false, notes: '', active: true, createdAt: at, updatedAt: at };
      store.patients.push(patient); seen.add(patient.id); stats.recordsAdded++;
    }
  }
  for (const patient of store.patients) if (patient.mypakPatientId && !seen.has(patient.id)) reviews.push({ id: crypto.randomUUID(), type: 'mypak', patientId: patient.id, fullName: patient.fullName, result: 'Missing from latest MyPak sync', severity: 'warning', action: 'Not deleted or deactivated; review manually', source: 'MyPak', at });
  store.importReviews = [...reviews, ...(store.importReviews || [])].slice(0, 1000);
  return { ...stats, reviews };
}
