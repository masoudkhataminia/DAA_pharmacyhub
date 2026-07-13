import assert from 'assert';
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
assert.equal(parsedScripts.scripts[0].repeatsIssued, 0);
assert.equal(parsedScripts.scripts[0].requestFlag, 'OK');
console.log('Smoke tests passed.');
