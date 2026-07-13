const compact = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function rowValue(row, aliases) {
  const keys = new Map(Object.keys(row || {}).map(key => [compact(key), key]));
  for (const alias of aliases) {
    const key = keys.get(compact(alias));
    if (key !== undefined) return row[key];
  }
  return undefined;
}

const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const boolean = (value, fallback = true) => {
  const normalized = text(value).toLowerCase();
  if (!normalized) return fallback;
  if (['false', 'no', 'n', '0', 'inactive', 'discharged'].includes(normalized)) return false;
  if (['true', 'yes', 'y', '1', 'active'].includes(normalized)) return true;
  return fallback;
};

export function mapOfflineMpsPatient(row) {
  const hsId = text(rowValue(row, ['hsId', 'MPS ID', 'MPS Patient ID', 'Patient ID', 'Resident ID']));
  const givenName = text(rowValue(row, ['givenName', 'Given Name', 'First Name', 'Firstname']));
  const familyName = text(rowValue(row, ['familyName', 'Family Name', 'Last Name', 'Lastname', 'Surname']));
  const suppliedFullName = text(rowValue(row, ['fullName', 'Full Name', 'Patient Name', 'Resident Name', 'Name']));
  const fullName = suppliedFullName || text(`${givenName} ${familyName}`);
  if (!hsId || !fullName) return null;
  return {
    hsId,
    givenName,
    familyName,
    fullName,
    preferredName: text(rowValue(row, ['preferredName', 'Preferred Name'])),
    dateOfBirth: rowValue(row, ['dateOfBirth', 'Date of Birth', 'DOB', 'Birth Date']) || null,
    gender: text(rowValue(row, ['gender', 'Gender', 'Sex'])),
    facility: text(rowValue(row, ['facility', 'Facility ID', 'Ward ID'])),
    facilityGroupId: text(rowValue(row, ['facilityGroupId', 'Facility Group ID', 'Group ID'])),
    facilityName: text(rowValue(row, ['facilityName', 'Facility Name', 'Ward', 'Wing', 'Facility'])),
    roomNumber: text(rowValue(row, ['roomNumber', 'Room Number', 'Room'])),
    urn: text(rowValue(row, ['urn', 'URN', 'MRN', 'Medical Record Number', 'External ID'])),
    phone: text(rowValue(row, ['phone', 'Phone', 'Mobile', 'Contact Number'])),
    active: boolean(rowValue(row, ['active', 'Active', 'Status']), true),
    dischargedDate: rowValue(row, ['dischargedDate', 'Discharged Date']) || null,
    changeNumber: Number(rowValue(row, ['changeNumber', 'Change Number'])) || 0
  };
}

export function mapOfflineMpsPatients(rows) {
  return (rows || []).map(mapOfflineMpsPatient).filter(Boolean);
}
