import { packMedicationCells, prescriptionDirection, prescriptionName } from '../mypak/packs.js';

const list = value => Array.isArray(value) ? value : [];
const clean = value => String(value ?? '').trim();
const key = value => clean(value).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const words = value => new Set(key(value).split(' ').filter(word => word.length > 2));
const parseDate = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : new Date(date.getFullYear(), date.getMonth(), date.getDate()); };
const iso = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const addDays = (date, days) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };

function medicineMatch(changeName, prescription) {
  const a = key(changeName), b = key(prescriptionName(prescription));
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const aw = words(a), bw = words(b); let shared = 0;
  aw.forEach(word => { if (bw.has(word)) shared++; });
  return shared >= Math.min(2, aw.size, bw.size);
}

function statusInstruction(status) {
  const value = String(status ?? '');
  if (['0','1','7'].includes(value)) return 'Update before printing / packing';
  if (value === '2') return 'Stop packing and correct before checking';
  if (value === '3') return 'Return to packing and correct before check approval';
  if (value === '4') return 'Recall from distribution and correct';
  if (value === '5') return 'Include in the active correction';
  if (value === '6') return 'Completed pack: pharmacist must locate, open and correct before supply';
  return 'Pharmacist review required before supply';
}

function doseHeading(packDose, doseIndex) {
  const headings = Array.isArray(packDose?.pageHeadings?.[0]) ? packDose.pageHeadings[0] : packDose?.pageHeadings;
  return clean(headings?.[doseIndex]) || ['Breakfast','Lunch','Dinner','Bedtime'][doseIndex] || `Dose ${doseIndex + 1}`;
}

function inferredAdditionCells(packDose, change, effectiveDate) {
  const start = parseDate(packDose.packStartDate); if (!start) return [];
  const wantedDays = list(change.days).map(key); const wantedTimes = list(change.doseTimes).map(key);
  const weeks = Math.max(1, Number(packDose.numberOfWeek || 1)); const rows = [];
  for (let offset = 0; offset < weeks * 7; offset++) {
    const date = addDays(start, offset); if (effectiveDate && date < effectiveDate) continue;
    const dayName = clean(packDose.rowHeadings?.[offset % 7]) || date.toLocaleDateString('en-AU', { weekday: 'long' });
    if (wantedDays.length && !wantedDays.some(day => key(dayName).includes(day) || day.includes(key(dayName)))) continue;
    for (let doseIndex = 0; doseIndex < 4; doseIndex++) {
      const heading = doseHeading(packDose, doseIndex);
      if (wantedTimes.length && !wantedTimes.some(time => key(heading).includes(time) || time.includes(key(heading)))) continue;
      rows.push({ week: Math.floor(offset / 7) + 1, dayIndex: offset % 7, day: dayName, doseIndex, doseTime: heading, quantity: Number(change.quantityPerDose || 0) || null, date: iso(date) });
    }
  }
  return rows;
}

export function buildPackImpact({ jobs = [], detailsByJob = {}, changes = [] } = {}) {
  return list(jobs).map(job => {
    const detail = detailsByJob[job.jobId]; if (!detail) return { ...job, workflowInstruction: statusInstruction(job.status), detailAvailable: false, instructions: [] };
    const start = parseDate(detail.packStartDate || job.packStartDate); const weeks = Math.max(1, Number(detail.numberOfWeek || job.numberOfWeek || 1));
    const end = start ? addDays(start, weeks * 7 - 1) : null;
    const instructions = [];
    list(changes).forEach((change, changeIndex) => {
      const effective = parseDate(change.effectiveDate);
      if (start && effective && effective > end) return;
      const matches = list(detail.prescriptions).filter(rx => medicineMatch(change.medication, rx));
      if (change.changeType === 'add' && !matches.length) {
        const cells = inferredAdditionCells(detail, change, effective);
        instructions.push({ changeIndex, action: 'ADD', medication: change.medication, previousDirection: '', newDirection: change.newDirection, matchedMedication: '', cells, exact: Boolean(cells.length && list(change.doseTimes).length), warning: cells.length ? '' : 'Exact day/time was not stated. Pharmacist must specify compartments before packing.' });
        return;
      }
      if (!matches.length) {
        instructions.push({ changeIndex, action: change.changeType === 'stop' ? 'REMOVE' : 'CHANGE', medication: change.medication, previousDirection: change.oldDirection, newDirection: change.newDirection, matchedMedication: '', cells: [], exact: false, warning: 'Medication was not matched in this pack. Pharmacist must confirm the medicine/brand.' });
        return;
      }
      matches.forEach(rx => {
        const prescriptionId = rx.id ?? rx.prescriptionId;
        const cells = packMedicationCells(detail, prescriptionId).map(cell => {
          const date = start ? addDays(start, (cell.week - 1) * 7 + cell.dayIndex) : null;
          return { ...cell, date: date ? iso(date) : '' };
        }).filter(cell => !effective || !cell.date || parseDate(cell.date) >= effective);
        instructions.push({ changeIndex, action: change.changeType === 'stop' ? 'REMOVE' : change.changeType === 'add' ? 'ADD' : 'CHANGE', medication: change.medication, previousDirection: change.oldDirection || prescriptionDirection(rx), newDirection: change.newDirection, matchedMedication: prescriptionName(rx), prescriptionId: clean(prescriptionId), cells, exact: Boolean(cells.length), warning: cells.length ? '' : 'No allocated compartments were found in this pack; verify against the printed foil.' });
      });
    });
    return { ...job, packEndDate: end ? iso(end) : '', workflowInstruction: statusInstruction(job.status), detailAvailable: true, instructions };
  });
}
