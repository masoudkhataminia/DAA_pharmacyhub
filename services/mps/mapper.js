import crypto from 'crypto';

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const normalMpsName = value => text(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const isoDate = value => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : ''; };
const mpsId = row => text(row.hsId ?? row.patientId ?? row.id);
const externalId = row => text(row.urn ?? row.mrn ?? row.clinicalSystemId ?? row.externalId);
const fullName = row => text(row.fullName || `${row.givenName || row.firstName || ''} ${row.familyName || row.lastName || row.surname || ''}`);
const address = row => {
  if (typeof row.address === 'string') return text(row.address);
  const source = row.address || row.residentialAddress || {};
  return text(source.fullAddress || [source.address1, source.address2, source.street, source.suburb, source.state, source.postcode || source.postalCode].filter(Boolean).join(', '));
};

function matches(row, patients) {
  const sourcePatients = patients.filter(patient => text(patient.mpsPatientId));
  const id = mpsId(row);
  let found = sourcePatients.filter(patient => id && text(patient.mpsPatientId) === id);
  if (found.length) return { found, method: 'mpsPatientId', certain: found.length === 1 };
  const external = externalId(row);
  found = sourcePatients.filter(patient => external && [patient.mpsExternalPatientId, patient.externalId].some(value => text(value) === external));
  if (found.length) return { found, method: 'externalPatientId', certain: found.length === 1 };
  const name = normalMpsName(fullName(row));
  const dob = isoDate(row.dateOfBirth ?? row.dob);
  found = sourcePatients.filter(patient => normalMpsName(patient.fullName || `${patient.firstName || ''} ${patient.lastName || ''}`) === name && dob && isoDate(patient.dob) === dob);
  if (found.length) return { found, method: 'nameDob', certain: found.length === 1 };
  found = sourcePatients.filter(patient => normalMpsName(patient.fullName || `${patient.firstName || ''} ${patient.lastName || ''}`) === name);
  return { found, method: 'nameOnly', certain: false };
}

function demographics(row, facilities, at) {
  const facilityId = text(row.facility ?? row.facilityId);
  const facility = facilities.find(item => text(item.hsId ?? item.id) === facilityId);
  const givenName = text(row.givenName ?? row.firstName);
  const familyName = text(row.familyName ?? row.lastName ?? row.surname);
  const id = mpsId(row);
  return {
    mpsPatientId: id,
    mpsExternalPatientId: externalId(row),
    externalId: externalId(row),
    firstName: givenName,
    lastName: familyName,
    fullName: fullName(row),
    preferredName: text(row.preferredName),
    dob: isoDate(row.dateOfBirth ?? row.dob),
    gender: text(row.gender),
    address: address(row),
    phone: text(row.phone ?? row.phoneNumber ?? row.mobile),
    room: text(row.roomNumber ?? row.room),
    facilityWard: text(facility?.msWardName ?? facility?.name ?? row.facilityName),
    mpsFacilityId: facilityId,
    mpsFacilityGroupId: text(facility?.facilityGroupId ?? row.facilityGroupId),
    mpsActive: row.active !== false && !row.dischargedDate,
    mpsDischargedDate: row.dischargedDate || null,
    packingStream: 'Sachet',
    packType: 'Sachet',
    lastMpsSyncAt: at,
    mpsRawVersion: 1,
    mpsMetadata: {
      hsId: id,
      urn: text(row.urn),
      imageUrl: text(row.imageUrl),
      informedConsent: row.informedConsent ?? null,
      pharmacyName: text(row.pharmacy?.name)
    }
  };
}

function newPatient(mapped, settings, at) {
  return {
    id: crypto.randomUUID(),
    ...mapped,
    packType: 'Sachet',
    cycleDays: settings.defaultCycleDays || 14,
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
    active: mapped.mpsActive,
    createdAt: at,
    updatedAt: at
  };
}

export function mergeMpsPatients(store, rows, facilities = [], at = new Date().toISOString()) {
  const stats = { recordsProcessed: 0, recordsAdded: 0, recordsUpdated: 0, recordsSkipped: 0 };
  const reviews = [];
  const seen = new Set();
  for (const row of rows) {
    stats.recordsProcessed++;
    const match = matches(row, store.patients);
    if (match.certain) {
      const patient = match.found[0];
      Object.assign(patient, demographics(row, facilities, at), { updatedAt: at });
      seen.add(patient.id);
      stats.recordsUpdated++;
    } else if (match.found.length) {
      stats.recordsSkipped++;
      reviews.push({ id: crypto.randomUUID(), type: 'mps', fullName: fullName(row), result: 'MPS match needs review', severity: 'warning', action: `Not merged: ${match.found.length} possible ${match.method} match(es)`, source: 'MPS MediSphere', at });
    } else if (fullName(row) && mpsId(row)) {
      const patient = newPatient(demographics(row, facilities, at), store.settings, at);
      store.patients.push(patient);
      seen.add(patient.id);
      stats.recordsAdded++;
    } else {
      stats.recordsSkipped++;
      reviews.push({ id: crypto.randomUUID(), type: 'mps', fullName: fullName(row) || 'Unknown resident', result: 'Invalid MPS patient row', severity: 'warning', action: 'Missing MPS patient ID or name; row was not imported', source: 'MPS MediSphere', at });
    }
  }
  for (const patient of store.patients) {
    if (patient.mpsPatientId && !seen.has(patient.id)) reviews.push({ id: crypto.randomUUID(), type: 'mps', patientId: patient.id, fullName: patient.fullName, result: 'Missing from latest MPS sync', severity: 'warning', action: 'Not deleted or deactivated; review manually', source: 'MPS MediSphere', at });
  }
  store.importReviews = [...reviews, ...(store.importReviews || [])].slice(0, 1000);
  return { ...stats, reviews };
}
