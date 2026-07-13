import assert from 'assert';
import fs from 'node:fs';
import XLSX from 'xlsx';
process.env.NODE_ENV = 'test';
const { parseDate, dateDisplay, normalizeName, hasHindValue, inferRequestFlag, computePatient, scriptRowsFast } = await import('../server.js');

assert.equal(dateDisplay('08/06/2026'), '08/06/2026');
assert.equal(dateDisplay('2026-06-08'), '08/06/2026');
assert.equal(normalizeName('John (HIND) Smith'), 'john smith');
assert.equal(hasHindValue('Mary HIND Brown'), true);
assert.equal(hasHindValue('Mary Brown'), false);
assert.equal(inferRequestFlag(0, false, {scriptLowRepeatThreshold:1}), 'New script required');
assert.equal(inferRequestFlag(1, false, {scriptLowRepeatThreshold:1}), 'Low repeats');
assert.equal(inferRequestFlag(4, true, {scriptLowRepeatThreshold:1}), 'Script owing');
assert.equal(inferRequestFlag(null, false, {scriptLowRepeatThreshold:1}), 'Manual request');
const p = computePatient({fullName:'Test Patient', cycleDays:14, lastPickupDate:'01/06/2026', packLeadDays:3, dispenseLeadDays:1, orderLeadDays:7, packStatus:'Not started', dispenseStatus:'Not dispensed'}, {defaultCycleDays:14, defaultPackLeadDays:3, defaultDispenseLeadDays:1, defaultOrderLeadDays:7, urgentWindowDays:2, dueSoonWindowDays:7});
assert.equal(p.nextPickupDisplay, '15/06/2026');

const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.aoa_to_sheet([
  ['First Name', 'Last Name', 'Drug Description', 'Repeats'],
  ['Mary HIND', 'Brown', 'Example Drug', 3]
]);
XLSX.utils.book_append_sheet(workbook, worksheet, 'Scripts');
const parsedScripts = scriptRowsFast(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { scriptLowRepeatThreshold: 1 }, { patients: [] });
assert.equal(parsedScripts.scripts.length, 1);
assert.equal(parsedScripts.scripts[0].repeatsLeft, 3);
assert.equal(parsedScripts.scripts[0].repeatsIssued, null);
assert.equal(parsedScripts.scripts[0].requestFlag, 'OK');

const matchingWorkbook = XLSX.utils.book_new();
const matchingWorksheet = XLSX.utils.aoa_to_sheet([
  ['Patient First Name', 'Patient Last Name', 'Drug Description', 'Supply Number', 'Repeats Issued'],
  ['Priscilla', 'Alum (KDH)', 'Example Drug', 1, 4]
]);
XLSX.utils.book_append_sheet(matchingWorkbook, matchingWorksheet, 'Scripts');
const matchedScripts = scriptRowsFast(
  XLSX.write(matchingWorkbook, { type: 'buffer', bookType: 'xlsx' }),
  { scriptLowRepeatThreshold: 1 },
  { patients: [{ id: 'patient-1', fullName: 'ALUM(KDH), PRISCILLA', firstName: 'PRISCILLA', lastName: 'ALUM(KDH)' }] }
);
assert.equal(matchedScripts.scripts.length, 1);
assert.equal(matchedScripts.scripts[0].patientNameKey, normalizeName('ALUM(KDH), PRISCILLA'));
assert.equal(matchedScripts.scripts[0].repeatsLeft, 4);

const publicApp = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
assert.doesNotMatch(publicApp, /const noScript = Number\(m\.repeatsLeft\) <= 0/);
assert.match(publicApp, /const noScript = m\.newScriptNeeded === true/);
assert.match(publicApp, /repeats !== null && repeats < 2/);
assert.match(publicApp, /item\?\.owing \|\| \/\^Script owing\$\//);
assert.match(publicApp, /items\.filter\(item=>item\.selected\)/);
console.log('Smoke tests passed.');
