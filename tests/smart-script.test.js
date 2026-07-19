import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { applyRepeatOverrides, smartScriptForecast, smartScriptQueue } = await import('../server.js');
const { analyseSmartScriptReview, smartScriptAiStatus } = await import('../services/smart-script/analysis.js');

test('forecast combines current balance with one 4-week supply per repeat', () => {
  const forecast = smartScriptForecast(
    { medication:'Example 10mg', balanceQty:28, weeklyQty:7, repeatsLeft:1, repeatSource:'Imported script list' },
    { packWeeks:4, horizonMonths:2, safetyDays:0 },
    new Date(2026, 6, 14)
  );
  assert.equal(forecast.currentPackRequired, 28);
  assert.equal(forecast.onHandDays, 28);
  assert.equal(forecast.repeatCoverageDays, 28);
  assert.equal(forecast.totalCoverageDays, 56);
  assert.equal(forecast.needsRequest, false);
  assert.equal(forecast.projectedUnitsAvailable, 56);
});

test('forecast queues a medicine that cannot cover the selected horizon and buffer', () => {
  const forecast = smartScriptForecast(
    { medication:'Example 10mg', balanceQty:28, weeklyQty:7, repeatsLeft:0, repeatSource:'Manual profile override' },
    { packWeeks:4, horizonMonths:2, safetyDays:7 },
    new Date(2026, 6, 14)
  );
  assert.equal(forecast.needsRequest, true);
  assert.equal(forecast.shortfallQty, 35);
  assert.equal(forecast.neededByDate, '2026-08-11');
  assert.equal(forecast.verifiedRepeat, true);
});

test('missing consumption is sent to data review instead of being guessed', () => {
  const forecast = smartScriptForecast({ medication:'Unknown', balanceQty:20, weeklyQty:null, repeatsLeft:1 }, { packWeeks:4 });
  assert.equal(forecast.eligible, false);
  assert.equal(forecast.dataIssue, 'Weekly consumption missing');
});

test('an owing script is due now regardless of calculated medicine coverage', () => {
  const forecast = smartScriptForecast(
    { medication:'Owing medicine', balanceQty:84, weeklyQty:7, repeatsLeft:3, owing:true, repeatSource:'Imported script list' },
    { packWeeks:4, horizonMonths:2, safetyDays:0 },
    new Date(2026, 6, 14)
  );
  assert.equal(forecast.needsRequest, true);
  assert.equal(forecast.requestUrgency, 'Owing — request now');
  assert.equal(forecast.neededByDate, '2026-07-14');
});

test('manual repeat override replaces a synced zero without modifying the source row', () => {
  const source = [{ medication:'Amlodipine 10mg', repeatsLeft:0, repeatSource:'MyPak' }];
  const store = { settings:{ scriptLowRepeatThreshold:1 }, repeatOverrides:{ 'p1::amlodipine 10mg':{ repeatsLeft:3, updatedAt:'2026-07-14T00:00:00.000Z' } } };
  const [result] = applyRepeatOverrides(source, 'p1', store);
  assert.equal(source[0].repeatsLeft, 0);
  assert.equal(result.repeatsLeft, 3);
  assert.equal(result.repeatSource, 'Manual profile override');
  assert.equal(result.requestFlag, 'OK');
});

test('verified-only queue excludes suspicious MyPak zero and exposes it for review', () => {
  const store = {
    settings:{ scriptLowRepeatThreshold:1 }, repeatOverrides:{},
    patients:[{ id:'p1', mypakPatientId:'mp1', fullName:'Test Patient', active:true }],
    mypakMedicationBalances:[{ patientId:'mp1', medication:'Amlodipine 10mg', balanceQty:14, weeklyQty:7, repeatsLeft:0, repeatSource:'MyPak' }],
    scripts:[], medications:[]
  };
  const result = smartScriptQueue(store, { packWeeks:4, horizonMonths:2, safetyDays:7, requireVerified:'1', includeIncomplete:'1' });
  assert.equal(result.summary.patientCount, 0);
  assert.equal(result.summary.reviewCount, 1);
  assert.equal(result.reviewItems[0].repeatZeroNeedsCheck, true);
});

test('manual correction promotes the medicine into the verified smart queue', () => {
  const store = {
    settings:{ scriptLowRepeatThreshold:1 },
    repeatOverrides:{ 'p1::amlodipine 10mg':{ repeatsLeft:0, updatedAt:'2026-07-14T00:00:00.000Z' } },
    patients:[{ id:'p1', mypakPatientId:'mp1', fullName:'Test Patient', active:true }],
    mypakMedicationBalances:[{ patientId:'mp1', medication:'Amlodipine 10mg', balanceQty:14, weeklyQty:7, repeatsLeft:7, repeatSource:'MyPak' }],
    scripts:[], medications:[]
  };
  const result = smartScriptQueue(store, { packWeeks:4, horizonMonths:2, safetyDays:7, requireVerified:'1', includeIncomplete:'1' });
  assert.equal(result.summary.patientCount, 1);
  assert.equal(result.patients[0].medicines[0].repeatConfidence, 'Verified manually');
});

test('patient-scoped queue never includes another patient', () => {
  const store = {
    settings:{ scriptLowRepeatThreshold:1 }, repeatOverrides:{},
    patients:[
      { id:'p1', mypakPatientId:'mp1', fullName:'First Patient', active:true },
      { id:'p2', mypakPatientId:'mp2', fullName:'Second Patient', active:true }
    ],
    mypakMedicationBalances:[
      { patientId:'mp1', medication:'Medicine One', balanceQty:7, weeklyQty:7, repeatsLeft:0, repeatSource:'Imported script list' },
      { patientId:'mp2', medication:'Medicine Two', balanceQty:7, weeklyQty:7, repeatsLeft:0, repeatSource:'Imported script list' }
    ],
    scripts:[], medications:[]
  };
  const result = smartScriptQueue(store, { patientId:'p2', packWeeks:4, horizonMonths:2, safetyDays:7, includeIncomplete:'1' });
  assert.deepEqual(result.patients.map(patient => patient.patientId), ['p2']);
  assert.equal(result.assumptions.selectedPatientId, 'p2');
  assert.ok(result.reviewItems.every(item => item.patientId === 'p2'));
});

test('Smart Script AI status is disabled without a key', () => {
  assert.deepEqual(smartScriptAiStatus({}), { configured:false, model:'gpt-5-mini' });
});

test('Smart Script AI receives only the deterministic forecast and does not store it', async () => {
  let requestBody;
  const expected = {
    summary:'One medicine needs pharmacist review.',
    priorityExplanation:'The supplied forecast marks it as due now.',
    dataQualityIssues:[],
    pharmacistChecks:['Verify the repeat source.'],
    warnings:['Advisory summary only.']
  };
  const result = await analyseSmartScriptReview({
    forecast:{
      assumptions:{ packWeeks:4, horizonMonths:2, safetyDays:7 },
      summary:{ patientCount:1, medicineCount:1, reviewCount:0 },
      patients:[{ patientFullName:'Private Patient Name', medicines:[{ medication:'Example medicine', requestUrgency:'Request now', balanceQty:7, weeklyQty:7, repeatsLeft:0, totalCoverageDays:7, shortfallQty:56, neededByDate:'2026-07-26', repeatConfidence:'Imported script', source:'Imported script list' }] }],
      reviewItems:[]
    },
    env:{ OPENAI_API_KEY:'test-key', OPENAI_SMART_SCRIPT_MODEL:'test-model' },
    fetchImpl:async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok:true, status:200, text:async()=>JSON.stringify({ output_text:JSON.stringify(expected) }) };
    }
  });
  assert.deepEqual(result, expected);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.model, 'test-model');
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(JSON.stringify(requestBody).includes('Private Patient Name'), false);
});
