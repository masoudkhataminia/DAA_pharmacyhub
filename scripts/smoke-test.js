import assert from 'assert';
import fs from 'node:fs';
import XLSX from 'xlsx';
process.env.NODE_ENV = 'test';
const { parseDate, dateDisplay, normalizeName, hasHindValue, inferRequestFlag, computePatient, scriptRowsFast, linkScriptsToMedicationBalances, buildPatientMedicationOverview, scriptLetterHtml } = await import('../server.js');

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

const linkedRepeats = linkScriptsToMedicationBalances([
  { medication: 'AMLODIPINE - AMLODIPINE (APO) 10mg TAB (AMAP2)', drugCode: 'AMAP2' },
  { medication: 'CALCITRIOL - CALITROL 0.25mcg CAP (CALI2)', drugCode: 'CALI2' },
  { medication: 'Magnesium - MAG TAB 500mg TAB (MYPA036)', drugCode: 'MYPA036' },
  { medication: 'PRAZOSIN - MINIPRESS 2mg (as HCL) TAB (MIN2)', drugCode: 'MIN2' },
  { medication: 'RAMIPRIL - RAMIPRIL (APO) 5mg TAB (APOR3)', drugCode: 'APOR3' },
  { medication: 'SEVELAMER CARBONATE - SEVELAMER (APOTEX) 800mg TAB (SEVE3)', drugCode: 'SEVE3' }
], [
  { drugDescription: 'AMLODIPINE (APO) TABLETS 10mg Bottle', repeatsLeft: 3, requestFlag: 'OK', scriptNumber: '1' },
  { drugDescription: 'CALITROL CAPSULES 0.25mcg', repeatsLeft: 1, requestFlag: 'Low repeats', scriptNumber: '2' },
  { drugDescription: 'MAG-SUP TABLETS 500mg', repeatsLeft: 2, requestFlag: 'OK', scriptNumber: '3' },
  { drugDescription: 'MINIPRESS TABLETS 2mg (as HCL)', repeatsLeft: 4, requestFlag: 'OK', scriptNumber: '4' },
  { drugDescription: 'RAMIPRIL (APO) TABLETS 5mg', repeatsLeft: 3, requestFlag: 'OK', scriptNumber: '5' },
  { drugDescription: 'SEVELAMER (ARX) TABLETS 800mg', repeatsLeft: 0, owing: true, requestFlag: 'Script owing', scriptNumber: '6' }
]);
assert.deepEqual(linkedRepeats.balances.map(row => row.repeatsLeft), [3, 1, 2, 4, 3, 0]);
assert.equal(linkedRepeats.balances.at(-1).owing, true);
assert.equal(linkedRepeats.scripts[1].matchedDrugCode, 'CALI2');

const repeatedStrengthName = linkScriptsToMedicationBalances([
  { medication: 'SPIRONOLACTONE - SPIRONOLACTONE (VIATRIS) 25 25mg TAB (SPIR9)', drugCode: 'SPIR9' }
], [
  { drugDescription: 'SPIRONOLACTONE (VIATRIS) 25 TABLETS 25mg', repeatsLeft: 5, requestFlag: 'OK', scriptNumber: '7' }
]);
assert.equal(repeatedStrengthName.balances[0].repeatsLeft, 5);

const differentStrength = linkScriptsToMedicationBalances([
  { medication: 'AMIODARONE - ARATAC 100mg TAB', drugCode: 'ARA1' }
], [
  { drugDescription: 'ARATAC TABLETS 200mg', repeatsLeft: 3, requestFlag: 'OK', scriptNumber: '8' }
]);
assert.equal(differentStrength.balances[0].repeatsLeft, undefined);

const overview = buildPatientMedicationOverview(
  [{ medication: 'RAMIPRIL - RAMIPRIL (APO) 5mg TAB', drugCode: 'APOR3', balanceQty: 20 }],
  [
    { drugDescription: 'RAMIPRIL (APO) TABLETS 5mg', repeatsLeft: 3, requestFlag: 'OK', scriptNumber: '10' },
    { drugDescription: 'UNMATCHED MEDICINE TABLETS 20mg', repeatsLeft: 1, requestFlag: 'Low repeats', scriptNumber: '11' }
  ],
  [{ medicineName: 'MANUAL MEDICINE', directions: 'Take one daily' }]
);
assert.equal(overview.length, 3);
assert.equal(overview.filter(row => /RAMIPRIL/.test(row.medication)).length, 1);
assert.ok(overview.some(row => row.overviewSource === 'Script list' && row.scriptNumber === '11'));
assert.ok(overview.some(row => row.overviewSource === 'Medication list'));

const officialLetter = scriptLetterHtml({
  patientFullName: 'TEST, PATIENT',
  items: [{ medicineName:'TEST MEDICINE', repeatsLeft:1, status:'Low repeats' }]
});
assert.match(officialLetter, /@page\{size:A4 landscape/);
assert.equal((officialLetter.match(/class="important">IMPORTANT/g) || []).length, 2);
assert.equal((officialLetter.match(/TEST MEDICINE/g) || []).length, 2);
assert.match(officialLetter, /color:#f00/);
assert.match(officialLetter, /two copies per landscape page/);

const publicApp = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
assert.doesNotMatch(publicApp, /const noScript = Number\(m\.repeatsLeft\) <= 0/);
assert.match(publicApp, /const noScript = m\.newScriptNeeded === true/);
assert.match(publicApp, /repeats !== null && repeats < 2/);
assert.match(publicApp, /item\?\.owing \|\| \/\^Script owing\$\//);
assert.match(publicApp, /items\.filter\(item=>item\.selected\)/);
assert.match(publicApp, /s\.matchedMedication \|\| s\.drugDescription/);
assert.match(publicApp, /refreshBtn'\)\.addEventListener\('click',\(\)=>syncMyPakPatients\(\)\)/);
assert.match(publicApp, /syncMyPakPatients\(\{silent:true\}\)/);
assert.match(publicApp, /Medications, pill balance & scripts/);
assert.doesNotMatch(publicApp, /<h3>Imported medication list<\/h3>/);
assert.match(publicApp, /CLIENT_BUILD_VERSION/);
assert.match(publicApp, /q\.length < 2/);
console.log('Smoke tests passed.');
