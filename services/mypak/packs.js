export const PACK_STATUS_LABELS = Object.freeze({
  '-1': 'Failed', '0': 'Pending', '1': 'Printing', '2': 'Packing', '3': 'Checking',
  '4': 'Distribution', '5': 'Correction', '6': 'Completed', '7': 'Created', '8': 'Undo'
});

const text = value => String(value ?? '').trim();
const value = (row, ...keys) => keys.map(key => row?.[key]).find(item => item !== undefined && item !== null && item !== '');
const array = value => Array.isArray(value) ? value : [];
const unwrap = response => response?.data?.data ?? response?.data ?? response ?? {};

export function packJobId(row) {
  return text(value(row, 'jobId', 'id', 'packJobId'));
}

export function normalizePackJob(row = {}) {
  const status = text(value(row, 'status', 'jobStatus'));
  const patient = row.patient && typeof row.patient === 'object' ? row.patient : {};
  const group = row.patientGroup && typeof row.patientGroup === 'object' ? row.patientGroup : {};
  return {
    ...row,
    jobId: packJobId(row),
    patientId: text(value(row, 'patientId', 'patientID', 'clientId')),
    patientName: text(value(row, 'patientName', 'fullName', 'clientName') || value(patient, 'fullName', 'patientName', 'name') || `${value(patient,'firstName') || ''} ${value(patient,'lastName') || ''}`),
    patientGroupName: text(value(row, 'patientGroupName', 'groupName') || (typeof row.patientGroup === 'string' ? row.patientGroup : '') || value(group, 'name', 'patientGroupName')),
    barcode: text(value(row, 'barcode', 'jobNumber', 'jobNo')),
    status,
    statusLabel: PACK_STATUS_LABELS[status] || text(value(row, 'statusName')) || status || 'Unknown',
    packStartDate: text(value(row, 'packStartDate', 'startDate')),
    createdDate: text(value(row, 'createdDate', 'dateCreated', 'createdAt')),
    completedDate: text(value(row, 'completedDate', 'dateCompleted', 'completedAt')),
    createdBy: text(value(row, 'createdUsername', 'createdBy', 'createdUser')),
    packedBy: text(value(row, 'packedBy', 'packedUsername')),
    checkedBy: text(value(row, 'checkedBy', 'checkedUsername')),
    completedBy: text(value(row, 'completedBy', 'completedUsername')),
    numberOfWeek: Number(value(row, 'numberOfWeek', 'numberOfWeeks', 'weeks') || 1),
    packType: text(value(row, 'packTypeName', 'blisterTypeName', 'packType')),
    distribution: text(value(row, 'distributionName', 'distribution'))
  };
}

export function packRows(response) {
  const data = unwrap(response);
  const rows = Array.isArray(data) ? data : array(data.packJobs).length ? data.packJobs : array(data.items).length ? data.items : array(data.data);
  return rows.map(normalizePackJob).filter(row => row.jobId);
}

export function normalizePackDose(response) {
  const raw = unwrap(response);
  const dose = raw?.dose && typeof raw.dose === 'object' ? raw.dose : raw;
  return {
    jobNumber: text(value(dose, 'jobNumber', 'barcode')),
    patientId: text(value(dose, 'patientId', 'clientId')),
    patientName: text(value(dose, 'patientName', 'clientName')),
    packStartDate: text(value(dose, 'packStartDate', 'startDate')),
    numberOfWeek: Number(value(dose, 'numberOfWeek', 'numberOfWeeks') || 1),
    rowHeadings: array(dose.rowHeadings),
    pageHeadings: array(dose.pageHeadings),
    prescriptions: array(dose.prescriptions),
    doseAllocated: dose.doseAllocated && typeof dose.doseAllocated === 'object' ? dose.doseAllocated : {},
    checkChangePrescriptions: array(dose.checkChangePrescriptions),
    syncedAt: new Date().toISOString()
  };
}

export function prescriptionName(prescription = {}) {
  return text(value(prescription?.drug || {}, 'drugName', 'name') || value(prescription, 'drugName', 'medicationName', 'name'));
}

export function prescriptionDirection(prescription = {}) {
  return text(value(prescription, 'direction', 'directions', 'sig', 'doseInstruction'));
}

export function packMedicationCells(packDose, prescriptionId) {
  const allocation = packDose?.doseAllocated?.[prescriptionId] ?? packDose?.doseAllocated?.[String(prescriptionId)] ?? [];
  const rows = [];
  array(allocation).forEach((week, weekIndex) => {
    array(week).forEach((day, dayIndex) => {
      array(day).forEach((quantity, doseIndex) => {
        const qty = Number(quantity || 0);
        if (!qty) return;
        const page = Array.isArray(packDose.pageHeadings?.[0]) ? packDose.pageHeadings[0] : packDose.pageHeadings;
        rows.push({
          week: weekIndex + 1,
          dayIndex,
          day: text(packDose.rowHeadings?.[dayIndex]) || `Day ${dayIndex + 1}`,
          doseIndex,
          doseTime: text(page?.[doseIndex]) || ['Breakfast', 'Lunch', 'Dinner', 'Bedtime'][doseIndex] || `Dose ${doseIndex + 1}`,
          quantity: qty
        });
      });
    });
  });
  return rows;
}

export function patientPackJobs(store, patient) {
  const patientId = text(patient?.mypakPatientId);
  const patientName = text(patient?.fullName).toLowerCase();
  return array(store?.mypakPackJobs).filter(job =>
    (patientId && text(job.patientId) === patientId) || (!job.patientId && patientName && text(job.patientName).toLowerCase() === patientName)
  ).sort((a, b) => String(a.packStartDate).localeCompare(String(b.packStartDate)));
}

export function mergePackJobs(existing, incoming) {
  const byId = new Map(array(existing).map(job => [packJobId(job), normalizePackJob(job)]).filter(([id]) => id));
  for (const job of array(incoming)) {
    const normalized = normalizePackJob(job);
    if (normalized.jobId) byId.set(normalized.jobId, { ...(byId.get(normalized.jobId) || {}), ...normalized });
  }
  return [...byId.values()].sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)));
}
