let STATE = null;
let selectedPatientId = null;
let editPatientId = null;
let MPS_CONNECTION = null;
let activeDoctorAnalysisId = null;
let SMART_QUEUE = null;
const CLIENT_BUILD_VERSION = '20260718-patient-request-email-v1';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = (text, cls='') => `<span class="badge ${cls}">${esc(text)}</span>`;
const toast = msg => { const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'), 4200); };
const api = async (url, opts={}) => { const r = await fetch(url, opts); if (!r.ok) throw new Error((await r.json().catch(()=>({error:r.statusText}))).error || r.statusText); return r.json(); };
async function checkForAppUpdate(){
  try {
    const response = await fetch(`/api/build?t=${Date.now()}`, { cache:'no-store' });
    const build = await response.json();
    if (build.version && build.version !== CLIENT_BUILD_VERSION) {
      const target = new URL(window.location.href);
      target.searchParams.set('build', build.version);
      window.location.replace(target.toString());
    }
  } catch (_) {}
}

function statusClass(p){
  if(p.calculatedStatus==='Overdue' || p.calculatedStatus==='Due today') return 'danger';
  if(p.calculatedStatus==='Due soon' || p.calculatedStatus==='Due this week') return 'warn';
  return 'ok';
}
function patientBadges(p){
  const stream = p.packingStream || (p.mpsPatientId ? 'Sachet' : 'WP');
  return [badge(p.calculatedStatus||'Unknown', statusClass(p)), badge(stream, stream==='Sachet'?'blue':'mint'), p.mypakPatientId?badge('MyPak live','mint'):'', p.mpsPatientId?badge('MPS live','blue'):'', p.patientGroup?badge(p.patientGroup,'blue'):'', p.s8Priority?badge('S8','danger'):'', p.patientSuppliedMeds?badge('Patient supplied','blue'):'', p.urgent?badge('Urgent','danger'):'', p.scriptRequestStatus && p.scriptRequestStatus!=='Not checked'?badge(p.scriptRequestStatus,'warn'):'' ].join('');
}
function queueCard(p, mode='pickup'){
  if(mode==='dispense' && p.medications) return `<div class="queue-card dispense-card"><div><h3>${esc(p.fullName)}</h3><p><b>${p.medications.length}</b> medicines need dispensing · lowest balance <b>${esc(p.worstBalance)}</b></p><div class="badges">${badge(p.status.replaceAll('_',' '),p.status==='confirmed'?'ok':p.status==='dispensed'?'blue':'danger')} ${p.patientGroup?badge(p.patientGroup,'mint'):''}</div></div><div class="card-actions"><button class="ghost" onclick="openDispensePatient('${p.key}','${p.patientId}')">Balances</button>${p.status==='needs_dispense'?`<button onclick="setDispenseStatus('${p.key}','dispensed')">Dispensed</button>`:p.status==='dispensed'?`<button onclick="setDispenseStatus('${p.key}','confirmed')">Confirm ✓</button>`:`<button class="ghost" onclick="setDispenseStatus('${p.key}','needs_dispense')">Reopen</button>`}</div></div>`;
  const due = mode==='pack'?`Pack due: ${p.packDueDisplay||'—'}`:mode==='dispense'?`Dispense due: ${p.dispenseDueDisplay||'—'}`:mode==='order'?`Order due: ${p.orderDueDisplay||'—'}`:`Pickup: ${p.nextPickupDisplay||'—'}`;
  return `<div class="queue-card"><div><h3>${esc(p.fullName)}</h3><p>${due} · cycle ${esc(p.cycleDays)} days · pickup ${esc(p.nextPickupDisplay||'not set')}</p><div class="badges">${patientBadges(p)}</div></div><button class="ghost" onclick="openPatient('${p.id}')">Open</button></div>`;
}
function renderKPIs(k){
  const patients = STATE?.allPatientsComputed || STATE?.patientsComputed || [];
  const sachetCount = patients.filter(patient=>patient.mpsPatientId).length;
  const wpCount = patients.filter(patient=>!patient.mpsPatientId).length;
  const values = { ...k, packingStreams: `${sachetCount} / ${wpCount}` };
  const labels = [['activePatients','Active'],['needsDispense','Needs dispense'],['overdue','Overdue'],['dueThisWeek','Due this week'],['packingStreams','Sachet / WP'],['openDoctorUpdates','Doctor updates'],['scriptIssues','Script issues'],['specialOrdersDue','Special orders due']];
  $('#kpis').innerHTML = labels.map(([key,label])=>`<div class="kpi${key==='packingStreams'?' kpi-action':''}" ${key==='packingStreams'?`role="button" tabindex="0" title="Sachet residents / Webster Pack residents" onclick="showPackingPatients()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showPackingPatients()}"`:''}><span>${label}</span><b>${values[key]??0}</b>${key==='packingStreams'?'<small>First: Sachet (MPS) · Second: WP</small>':''}</div>`).join('');
}
function showPackingPatients(){
  showView('patients');
  $('#patientFilter').value = 'all';
  $('#patientSearch').value = '';
  renderPatients();
}
async function setDispenseStatus(key,status){ await api(`/api/dispense-workflow/${encodeURIComponent(key)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); toast(status==='confirmed'?'Dispense confirmed.':'Dispense workflow updated.'); await loadState(); }
async function openDispensePatient(key,patientId){ if(patientId) return openPatient(patientId); const item=(STATE.dispenseQueue||[]).find(x=>x.key===key); if(item) toast(`${item.fullName}: ${item.medications.length} medicines need dispensing.`); }
function renderDashboard(){
  const d = STATE.dashboard;
  renderKPIs(d.kpis);
  $('#packingDue').innerHTML = d.packingDue.length ? d.packingDue.map(p=>queueCard(p,'pack')).join('') : empty('No packing due items.');
  $('#dispenseDue').innerHTML = d.dispenseDue.length ? d.dispenseDue.map(p=>queueCard(p,'dispense')).join('') : empty('No dispense due items.');
  $('#orderingDue').innerHTML = d.orderingDue.length ? d.orderingDue.map(p=>queueCard(p,'order')).join('') : empty('No ordering due items.');
  $('#urgentQueue').innerHTML = d.urgent.length ? d.urgent.map(p=>queueCard(p)).join('') : empty('No urgent patients.');
  $('#specialDueDashboard').innerHTML = (d.specialOrdersDue||[]).length ? d.specialOrdersDue.map(o=>specialOrderCard(o, true)).join('') : empty('No special orders due.');
}
function empty(text){ return `<div class="empty">${esc(text)}</div>`; }
function patientAddress(p){
  if(!p?.address) return '—';
  if(typeof p.address === 'string') return p.address || '—';
  return p.address.fullAddress || [p.address.street,p.address.suburb,p.address.state,p.address.postalCode].filter(Boolean).join(', ') || '—';
}
function patientValue(value){ return value === null || value === undefined || value === '' ? '—' : value; }
function patientDemographics(p){
  const fields = [
    ['Date of birth', p.dob], ['Gender', p.gender], ['Address', patientAddress(p)], ['Phone', p.phone], ['Email', p.email],
    ['Packing stream', p.packingStream || (p.mpsPatientId ? 'Sachet' : 'WP')], ['Patient group', p.patientGroup], ['Room', p.room], ['Facility / ward', p.facilityWard], ['Dispense code', p.dispenseCode],
    ['Distribution', p.distribution], ['DAA funding', p.daaFunding], ['MyPak status', p.mypakPatientStatus], ['Packing status', p.mypakPackingStatus],
    ['MyPak patient ID', p.mypakPatientId], ['External patient ID', p.mypakExternalPatientId || p.externalId],
    ['MPS patient ID', p.mpsPatientId], ['MPS facility / wing', p.facilityWard], ['MPS active', p.mpsPatientId ? (p.mpsActive ? 'Yes' : 'No') : '—'],
    ['Vision impaired', p.mypakMetadata?.visionImpaired ? 'Yes' : 'No'], ['30-day dispensing', p.mypakMetadata?.days30Dispensing ? 'Yes' : 'No'],
    ['Last checked', p.mypakMetadata?.lastCheckedDate], ['Last MyPak sync', p.lastMyPakSyncAt ? new Date(p.lastMyPakSyncAt).toLocaleString() : '—'],
    ['Last MPS sync', p.lastMpsSyncAt ? new Date(p.lastMpsSyncAt).toLocaleString() : '—']
  ];
  return `<h3>Patient information</h3><table><tbody>${fields.map(([label,value])=>`<tr><th>${esc(label)}</th><td>${esc(patientValue(value))}</td></tr>`).join('')}</tbody></table>`;
}
function myPakMedicationBalances(rows,patientId){
  const scriptState = m => m.owing ? badge('OWING','danger') : m.requestFlag==='New script required' ? badge('New script required','warn') : m.requestFlag==='Low repeats' ? badge('Low repeats','warn') : m.requestFlag==='OK' ? badge('OK','ok') : m.newScriptNeeded===true ? badge('New script needed','warn') : m.newScriptNeeded===false ? badge('OK','ok') : '—';
  return rows?.length ? `<table><thead><tr><th>Medication</th><th>Directions</th><th>Current balance</th><th>Required / week</th><th>Repeats</th><th>Owing / status</th><th>Script</th><th>Source</th><th>Last update / dispense</th></tr></thead><tbody>${rows.map((m,index)=>{const lastDate=m.lastDispenseBalanceUpdated||m.scriptDispenseDate;const medication=m.medication||m.drugDescription||m.medicineName||'';const medicationArg=encodeURIComponent(medication).replaceAll("'",'%27');const inputId=`repeat-edit-${index}`;return `<tr><td><b>${esc(medication||'—')}</b><br><small>${esc(m.drugCode||'')}</small></td><td>${esc(m.direction||'—')}</td><td>${esc(patientValue(m.balanceQty))}</td><td>${esc(patientValue(m.weeklyQty))}</td><td><div class="repeat-editor"><button type="button" class="ghost" onclick="adjustRepeatOverride('${patientId}','${medicationArg}','${inputId}',-1)">−</button><input id="${inputId}" type="number" min="0" max="99" step="1" value="${esc(m.repeatsLeft??'')}"><button type="button" class="ghost" onclick="adjustRepeatOverride('${patientId}','${medicationArg}','${inputId}',1)">+</button><button type="button" onclick="saveRepeatOverride('${patientId}','${medicationArg}','${inputId}')">Save</button>${/Manual profile override/i.test(m.repeatSource||'')?`<button type="button" class="ghost" onclick="clearRepeatOverride('${patientId}','${medicationArg}')">Use synced</button>`:''}</div><small>${esc(m.repeatSource||'No repeat source')}</small></td><td>${scriptState(m)}</td><td>${m.scriptNumber?`<b>${esc(m.scriptNumber)}</b>`:'—'}</td><td>${esc(m.overviewSource||m.repeatSource||'MyPak')}</td><td>${esc(lastDate ? new Date(lastDate).toLocaleString() : '—')}</td></tr>`}).join('')}</tbody></table>` : empty('No medication, balance or script information is available for this patient.');
}
function mpsMedicationSummary(details){
  const packedDays = details.mpsPackedDays || [];
  const packedPrn = details.mpsPackedPrn || [];
  const orders = details.mpsOrders || [];
  if (!packedDays.length && !packedPrn.length && !orders.length) return empty('No synced MPS medication data is available for this resident.');
  const dayRows = packedDays.map(day=>`<tr><td>${esc(day.packDate ? new Date(day.packDate).toLocaleDateString('en-AU') : '—')}</td><td>${esc((day.packedMedications||[]).length)}</td><td>${esc(day.facilityId||'—')}</td><td>${esc(day.changeNumber||'—')}</td></tr>`).join('');
  const orderRows = orders.slice(0,100).map(order=>`<tr><td>${esc(order.createdAt||order.orderDate||order.lastUpdated||'—')}</td><td>${esc(order.medicationName||order.drugName||order.medication?.name||order.drug?.name||`Medication ${order.medicationId||'—'}`)}</td><td>${esc(order.status||order.orderStatus||'—')}</td></tr>`).join('');
  return `<div class="three-col"><div><h4>Packed days (${packedDays.length})</h4>${dayRows?`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Doses</th><th>Facility</th><th>Change #</th></tr></thead><tbody>${dayRows}</tbody></table></div>`:empty('No packed days.')}</div><div><h4>PRN records</h4><p><b>${esc(packedPrn.length)}</b> synced PRN record(s)</p></div><div><h4>Orders (${orders.length})</h4>${orderRows?`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Medicine</th><th>Status</th></tr></thead><tbody>${orderRows}</tbody></table></div>`:empty('No orders.')}</div></div>`;
}
function renderImportReview(){
  const rows = STATE.importReviews || [];
  $('#importReview').innerHTML = rows.length ? `<table><thead><tr><th>Result</th><th>Patient</th><th>Action</th><th>Source</th><th>Time</th></tr></thead><tbody>${rows.slice(0,250).map(r=>`<tr><td>${badge(r.result, r.severity==='warning'?'warn':r.severity==='review'?'blue':'ok')}</td><td>${esc(r.fullName)}</td><td>${esc(r.action)}</td><td>${esc(r.source)}</td><td>${esc((r.at||'').slice(0,19).replace('T',' '))}</td></tr>`).join('')}</tbody></table>` : empty('No import review yet. Upload List of Patients first.');
}
async function refreshMyPakStatus(){
  try {
    const [connection, sync] = await Promise.all([api('/api/mypak/status'), api('/api/mypak/sync/status')]);
    $('#mypakConnection').textContent = !connection.configured ? 'Not configured' : connection.authenticated ? 'Connected' : connection.lastError ? 'Authentication/request failed' : 'Configured';
    const when = connection.lastSyncAt ? new Date(connection.lastSyncAt).toLocaleString() : 'never';
    const progress = sync.running ? ` · syncing clinical data… ${sync.progress}%` : '';
    const error = connection.lastError || sync.lastError;
    $('#mypakSyncSummary').textContent = `Last sync: ${when} · Patients: ${connection.patientCount || 0}${progress}${error ? ` · Error: ${error}` : ''}`;
    $('#mypakSyncBtn').disabled = !connection.configured || sync.running;
  } catch (error) { $('#mypakConnection').textContent = 'Status unavailable'; $('#mypakSyncSummary').textContent = error.message; }
}
async function syncMyPakPatients({silent=false}={}){
  const buttons = [$('#mypakSyncBtn'), $('#mypakSyncBtnSettings'), $('#refreshBtn')].filter(Boolean);
  const refreshButton = $('#refreshBtn');
  buttons.forEach(button=>button.disabled=true);
  if(refreshButton){refreshButton.dataset.label=refreshButton.textContent;refreshButton.textContent='Refreshing MyPak…';}
  const poll = setInterval(refreshMyPakStatus, 750);
  try {
    const result = await api('/api/mypak/sync/patients', { method: 'POST' });
    if(result.started===false){
      for(let attempt=0;attempt<120;attempt++){
        const status=await api('/api/mypak/sync/status');
        if(!status.running) break;
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }
    if(!silent) toast('Live MyPak balances refreshed.');
    await loadState();
  }
  catch (error) { toast(error.message); }
  finally {
    clearInterval(poll);
    buttons.forEach(button=>button.disabled=false);
    if(refreshButton) refreshButton.textContent=refreshButton.dataset.label||'Refresh';
    await refreshMyPakStatus();
  }
}
async function refreshMpsStatus(){
  try {
    const [connection, sync] = await Promise.all([api('/api/mps/status'), api('/api/mps/sync/status')]);
    MPS_CONNECTION = connection;
    $('#mpsConnection').textContent = connection.online ? 'Online' : !connection.configured ? 'Offline · token not configured' : connection.lastError ? 'Offline · authentication/request failed' : 'Configured · not verified';
    const patientWhen = connection.lastPatientSyncAt ? new Date(connection.lastPatientSyncAt).toLocaleString() : 'never';
    const medicationWhen = connection.lastMedicationSyncAt ? new Date(connection.lastMedicationSyncAt).toLocaleString() : 'never';
    const offlineWhen = connection.lastOfflineImportAt ? new Date(connection.lastOfflineImportAt).toLocaleString() : 'never';
    const progress = sync.running ? ` · ${sync.operation || 'sync'} page ${sync.currentPage}` : '';
    const error = connection.lastError || sync.lastError;
    $('#mpsSyncSummary').textContent = `Patients: ${connection.patientCount || 0} (live ${patientWhen}; offline import ${offlineWhen}) · Drugs: ${connection.drugCount || 0} · Orders: ${connection.orderCount || 0} · Packed days: ${connection.packedDayCount || 0} (last ${medicationWhen})${progress}${error ? ` · Error: ${error}` : ''}`;
    $('#mpsPatientSyncBtn').disabled = !connection.configured || sync.running;
    $('#mpsMedicationSyncBtn').disabled = !connection.configured || sync.running;
    const sourceStatus = $('#mpsPatientSourceStatus');
    if (sourceStatus) {
      const cachedCount = patientPool().filter(patient => patient.mpsPatientId).length;
      sourceStatus.classList.toggle('online', Boolean(connection.online));
      sourceStatus.classList.toggle('offline', !connection.online);
      sourceStatus.textContent = connection.online
        ? `MPS Online · ${cachedCount} Sachet resident(s) saved locally · live sync available`
        : `MPS Offline · ${cachedCount} Sachet resident(s) cached · search still works locally${cachedCount ? '' : ' · import an MPS CSV/XLSX export to add residents'}`;
    }
  } catch (error) { $('#mpsConnection').textContent = 'Status unavailable'; $('#mpsSyncSummary').textContent = error.message; }
}
async function connectMps(e){
  e.preventDefault();
  const form = e.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  const body = { token: $('#mpsToken').value };
  try {
    await api('/api/mps/session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    $('#mpsToken').value = ''; toast('MPS MediSphere connected for this server session.'); await refreshMpsStatus();
  } catch (error) { $('#mpsToken').value = ''; toast(error.message); }
  finally { body.token = ''; button.disabled = false; }
}
async function syncMpsPatients(){
  $('#mpsPatientSyncBtn').disabled = true;
  const poll = setInterval(refreshMpsStatus, 750);
  try { const result = await api('/api/mps/sync/patients', { method:'POST' }); toast(`MPS patient sync complete: ${result.total || 0} residents.`); await loadState(); }
  catch (error) { toast(error.message); }
  finally { clearInterval(poll); await refreshMpsStatus(); }
}
async function syncMpsMedications(){
  $('#mpsMedicationSyncBtn').disabled = true;
  const poll = setInterval(refreshMpsStatus, 750);
  try { const result = await api('/api/mps/sync/medications', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({days:7}) }); toast(`MPS medication sync complete: ${result.packedDays || 0} packed days, ${result.orders || 0} orders.`); await loadState(); }
  catch (error) { toast(error.message); }
  finally { clearInterval(poll); await refreshMpsStatus(); }
}
async function importOfflineMpsPatients(e){
  e.preventDefault();
  const form = e.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  try {
    const result = await api('/api/mps/import/patients', { method:'POST', body:new FormData(form) });
    form.reset();
    toast(`MPS offline import complete: ${result.recordsAdded || 0} added, ${result.recordsUpdated || 0} updated.`);
    await loadState(); await refreshMpsStatus(); showView('patients');
    $('#patientFilter').value = 'sachet'; renderPatients();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}
function patientPool(){ return STATE?.allPatientsComputed || STATE?.patientsComputed || []; }
function filteredPatients(){
  const q = ($('#patientSearch')?.value||'').toLowerCase();
  const f = $('#patientFilter')?.value||'all';
  return patientPool().filter(p=>{
    if(f==='inactive' && p.active!==false) return false;
    if(f!=='inactive' && p.active===false) return false;
    if(q && !(`${p.fullName} ${p.phone} ${p.notes} ${p.patientGroup} ${p.externalId} ${p.dispenseCode} ${p.mpsPatientId} ${p.room} ${p.facilityWard}`.toLowerCase().includes(q))) return false;
    if(f==='sachet' && !p.mpsPatientId) return false;
    if(f==='wp' && p.mpsPatientId) return false;
    if(f==='due' && !(p.daysToPickup!==null && p.daysToPickup<=7)) return false;
    if(f==='s8' && !p.s8Priority) return false;
    if(f==='supplied' && !p.patientSuppliedMeds) return false;
    if(f==='script' && !/draft|sent|required|owing|low|needed/i.test(p.scriptRequestStatus||'')) return false;
    return true;
  });
}
function renderPatients(){
  const matches = filteredPatients();
  const pts = matches.slice(0,50);
  const summary = $('#patientResultSummary'); if(summary) summary.textContent = `${matches.length} patient(s) in this filter${matches.length>50?' · showing first 50':''} · ${patientPool().filter(p=>p.mpsPatientId).length} Sachet · ${patientPool().filter(p=>!p.mpsPatientId).length} WP`;
  const sachetSelected = $('#patientFilter')?.value === 'sachet';
  const noRows = sachetSelected && !patientPool().some(patient=>patient.mpsPatientId)
    ? 'No MPS/Sachet residents are saved yet. MPS is offline; use the Offline fallback import in Import Centre, or connect a valid MediSphere token and run Sync MPS patients.'
    : 'No patients in this list.';
  $('#patientTable').innerHTML = pts.length ? `<table><thead><tr><th>Name</th><th>Cycle</th><th>Last pickup</th><th>Next pickup</th><th>Pack</th><th>Dispense</th><th>Flags</th><th></th></tr></thead><tbody>${pts.map(p=>`<tr><td><button class="linkbtn" onclick="openPatient('${p.id}')">${esc(p.fullName)}</button><br><small>${esc(p.phone||'')}</small></td><td>${esc(p.cycleDays)} days</td><td>${esc(p.lastPickupDisplay||'—')}</td><td>${esc(p.nextPickupDisplay||'—')}<br><small>${esc(p.calculatedStatus)}</small></td><td>${esc(p.packStatus)}</td><td>${esc(p.dispenseStatus)}</td><td><div class="badges">${patientBadges(p)}</div></td><td><button class="ghost" onclick="editPatient('${p.id}')">Edit</button></td></tr>`).join('')}</tbody></table>` : empty(noRows);
}
async function openPatient(id){
  selectedPatientId = id;
  const d = await api(`/api/patients/${id}/details`);
  const p = d.patient;
  $('#patientDetails').classList.remove('hidden');
  $('#patientDetails').innerHTML = `<div class="panel-head"><h2>${esc(p.fullName)}</h2><span>${esc(p.calculatedStatus)} · Risk ${esc(p.riskScore)}</span></div><div class="two-col"><div><h3>Workflow</h3><p>Last pickup: <b>${esc(p.lastPickupDisplay||'not set')}</b><br>Next pickup: <b>${esc(p.nextPickupDisplay||'not set')}</b><br>Pack due: <b>${esc(p.packDueDisplay||'—')}</b><br>Dispense due: <b>${esc(p.dispenseDueDisplay||'—')}</b><br>Order due: <b>${esc(p.orderDueDisplay||'—')}</b></p><div class="badges">${patientBadges(p)}</div><p>${esc(p.notes||'')}</p><button onclick="editPatient('${p.id}')">Edit workflow</button> <button class="ghost" onclick="buildRequestForPatient('${p.id}')">Build script request</button></div><div>${patientDemographics(p)}</div></div><h3>MPS medication data</h3>${mpsMedicationSummary(d)}<h3>Medications, pill balance & scripts</h3><p class="muted">Repeat values can be corrected here. Manual values override synced/imported repeats without changing MyPak.</p>${myPakMedicationBalances(d.medicationOverview||d.medicationBalances,p.id)}`;
  showView('patients');
}
async function saveRepeatOverride(patientId, encodedMedication, inputId){
  const input = document.getElementById(inputId);
  if (!input) return;
  const medication = decodeURIComponent(encodedMedication);
  await api(`/api/patients/${patientId}/repeat-override`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ medication, repeatsLeft:input.value.trim() }) });
  toast('Repeat saved as a manual profile value.');
  await loadState();
  await openPatient(patientId);
}
async function clearRepeatOverride(patientId, encodedMedication){
  const medication = decodeURIComponent(encodedMedication);
  await api(`/api/patients/${patientId}/repeat-override`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ medication, repeatsLeft:'' }) });
  toast('Manual repeat cleared; synced/imported value is in use.');
  await loadState();
  await openPatient(patientId);
}
async function adjustRepeatOverride(patientId, encodedMedication, inputId, delta){
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = String(Math.min(99, Math.max(0, Number(input.value || 0) + Number(delta || 0))));
  await saveRepeatOverride(patientId, encodedMedication, inputId);
}
function editPatient(id){
  const p = patientPool().find(x=>x.id===id); if(!p) return;
  editPatientId = id;
  const fields = [
    ['fullName','Full name','text'],['email','Patient email','email'],['cycleDays','Pickup interval days','number'],['lastPickupDate','Last pickup date','date'],['packLeadDays','Pack lead days','number'],['dispenseLeadDays','Dispense lead days','number'],['orderLeadDays','Medicine order lead days','number'],
    ['packStatus','Pack status','select:Not started|In progress|Packed|Checked|Ready|Complete'],['dispenseStatus','Dispense status','select:Not dispensed|Dispense due|Dispensed|Complete'],['medicineOrderStatus','Medicine order status','select:Not checked|Needed|Ordered|Received|Not needed|Complete'],['scriptRequestStatus','Script request','select:Not checked|Needed|Draft request created|Sent to GP|Received|Complete'],
    ['patientSuppliedMeds','Patient supplied meds','checkbox'],['s8Priority','S8 priority','checkbox'],['urgent','Urgent','checkbox'],['notes','Notes','textarea']
  ];
  $('#editFields').innerHTML = fields.map(([k,l,t])=>fieldHTML(k,l,t,p[k])).join('');
  $('#editDialog').showModal();
}
function fieldHTML(k,l,t,v){
  const cls = t==='textarea'?'field full':'field';
  if(t.startsWith('select:')) return `<div class="${cls}"><label>${l}</label><select name="${k}">${t.split(':')[1].split('|').map(o=>`<option ${o==v?'selected':''}>${o}</option>`).join('')}</select></div>`;
  if(t==='checkbox') return `<div class="${cls}"><label><input type="checkbox" name="${k}" ${v?'checked':''}/> ${l}</label></div>`;
  if(t==='textarea') return `<div class="${cls}"><label>${l}</label><textarea name="${k}" rows="3">${esc(v||'')}</textarea></div>`;
  return `<div class="${cls}"><label>${l}</label><input name="${k}" type="${t}" value="${esc(v||'')}"></div>`;
}
async function savePatient(e){
  e.preventDefault();
  const fd = new FormData($('#editForm'));
  const body = Object.fromEntries(fd.entries());
  ['patientSuppliedMeds','s8Priority','urgent'].forEach(k=>body[k]=fd.has(k));
  await api(`/api/patients/${editPatientId}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  $('#editDialog').close(); toast('Patient workflow saved.'); await loadState();
}
function renderScriptPage(){
  renderScriptPatientSearch();
  $('#recentRequests').innerHTML = (STATE.scriptRequests||[]).length ? `<table><thead><tr><th>Date</th><th>Patient</th><th>Items</th><th>Status / next action</th><th>Request</th></tr></thead><tbody>${STATE.scriptRequests.slice(0,80).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.patientFullName)}</td><td>${r.items.length}</td><td>${badge(r.status,r.status==='Received'?'ok':r.status==='Sent'?'blue':'warn')}<div class="table-actions">${r.status==='Draft'?`<button onclick="setScriptRequestStatus('${r.id}','Sent')">Mark sent</button>`:''}${r.status==='Sent'?`<button onclick="setScriptRequestStatus('${r.id}','Received')">Mark received</button>`:''}${r.status==='Received'?`<button class="ghost" onclick="setScriptRequestStatus('${r.id}','Draft')">Reopen</button>`:''}</div></td><td><button class="linkbtn" onclick="printScriptRequest('${r.id}')">Print / email PDF</button> <a class="linkbtn" href="/api/letter/${r.id}" target="_blank">Preview</a> <button class="danger-action" onclick="deleteScriptRequest('${r.id}','${esc(r.patientFullName)}')">Delete</button></td></tr>`).join('')}</tbody></table>` : empty('No script requests created yet.');
}
const PATIENT_EMAIL_CONFIRMATION = 'Would you also like to email this prescription request to the patient?';
async function sendScriptRequestToPatient(id){
  return api(`/api/script-request/${id}/email-patient`, { method:'POST' });
}
async function printScriptRequest(id){
  const shouldEmail = window.confirm(PATIENT_EMAIL_CONFIRMATION);
  const pdfWindow = window.open(`/api/letter/${id}/pdf`, '_blank');
  if (!pdfWindow) toast('Your browser blocked the PDF window. Allow pop-ups and try again.');
  if (!shouldEmail) return;
  try {
    const result = await sendScriptRequestToPatient(id);
    toast(`PDF opened and emailed to ${result.to} from ${result.sender || 'the connected Gmail account'}.`);
  } catch (error) {
    toast(`PDF opened, but the email was not sent: ${error.message}`);
  }
}
async function setScriptRequestStatus(id,status){await api(`/api/script-request/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});toast(`Request marked ${status}.`);await loadState();showView('scripts');}
async function deleteScriptRequest(id,patientName){
  if(!window.confirm(`Delete the prescription request for ${patientName}?\n\nThe PDF record will be removed and its medicines will return to Needs review.`)) return;
  const result=await api(`/api/script-request/${id}`,{method:'DELETE'});
  toast(`Request deleted. ${result.reopenedItems||0} medicine(s) reopened for review.`);
  await loadState(); showView('scripts');
}
function renderScriptPatientSearch(){
  const box = $('#scriptPatientSearch');
  const q = (box?.value || '').toLowerCase().trim();
  const patients = STATE.patientsComputed || [];
  if (q.length < 2) {
    $('#scriptPatientResults').innerHTML = empty('Type at least 2 letters to find a patient.');
    return;
  }
  const results = patients.filter(p => `${p.fullName} ${p.phone||''} ${p.externalId||''}`.toLowerCase().includes(q)).slice(0, 20);
  $('#scriptPatientResults').innerHTML = results.length ? results.map(p=>`<div class="queue-card compact-script-patient ${p.id===selectedPatientId?'selected-card':''}"><div><h3>${esc(p.fullName)}</h3><p>${esc(p.patientGroup||'')} · ${esc(p.nextPickupDisplay||'pickup not set')}</p></div><button class="ghost" onclick="buildRequestForPatient('${p.id}')">Select</button></div>`).join('') : empty('No patient found. Check spelling or import List of Patients first.');
}
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function repeatPosition(value){
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
function shouldAutoSelectScript(item){
  if (/^Requested$/i.test(item?.status || '')) return false;
  if (item?.owing || /^Script owing$/i.test(item?.status || '')) return true;
  const repeats = repeatPosition(item?.repeatsLeft);
  return repeats !== null && repeats < 2;
}
async function buildRequestForPatient(id){
  const d = await api(`/api/patients/${id}/details`); selectedPatientId=id;
  const byMed = new Map();
  const lowRepeatThreshold = Number(STATE.settings?.scriptLowRepeatThreshold ?? 1);
  for (const m of d.prescriptions || []) {
    const key = norm(m.medication); if(!key) continue;
    const negative = Number(m.balanceQty) < 0 || m.isInsufficientPillBalance;
    const noScript = m.newScriptNeeded === true;
    byMed.set(key,{ prescriptionId:m.prescriptionId, medicineName:m.medication, directions:m.direction||'', timing:`Balance ${patientValue(m.balanceQty)} · weekly ${patientValue(m.weeklyQty)}`, repeatsLeft:m.repeatsLeft??'', status:m.requestStatus==='requested'?'Requested':m.requestFlag||(negative&&noScript?'No script / negative balance':negative?'Negative balance':noScript?'New script required':'OK'), source:m.repeatSource?'MyPak prescription + imported script':'MyPak prescription', drugCode:m.drugCode||'', owing:!!m.owing, scriptNumber:m.scriptNumber||'' });
  }
  for (const m of d.medicationBalances || []) {
    const key = norm(m.medication);
    if (!key) continue;
    const repeats = m.repeatsLeft ?? '';
    const lowRepeats = repeats !== '' && Number.isFinite(Number(repeats)) && Number(repeats) <= lowRepeatThreshold;
    const status = m.newScriptNeeded === true ? 'New script required' : lowRepeats ? 'Low repeats' : 'OK';
    const balance = `MyPak balance ${patientValue(m.balanceQty)} · required/week ${patientValue(m.weeklyQty)}`;
    const existing = byMed.get(key);
    byMed.set(key, existing ? { ...existing, directions: existing.directions || m.direction || '', timing: balance, repeatsLeft: repeatPosition(existing.repeatsLeft)===null?repeats:existing.repeatsLeft, status: m.requestFlag||(/^(OK)$/i.test(existing.status) ? status : existing.status), source: m.repeatSource?'MyPak prescription + imported script':'MyPak prescription + balance', owing:!!m.owing||!!existing.owing, scriptNumber:m.scriptNumber||existing.scriptNumber||'' } : { medicineName: m.medication, directions: m.direction || '', timing: balance, repeatsLeft: repeats, status:m.requestFlag||status, source:m.repeatSource?'MyPak + imported script':'MyPak live balance', drugCode: m.drugCode || '', owing:!!m.owing, scriptNumber:m.scriptNumber||'' });
  }
  for (const m of d.medications || []) {
    const key = norm(m.medicineName);
    if (!key) continue;
    const existing = byMed.get(key) || { medicineName: m.medicineName, repeatsLeft: '', status: 'Manual request', source: 'Medication list' };
    existing.directions = m.directions || existing.directions || '';
    existing.timing = m.timing || existing.timing || '';
    existing.source = existing.source === 'MyPak live balance' ? 'MyPak + medication report' : 'Medication list';
    byMed.set(key, existing);
  }
  for (const s of d.scripts || []) {
    const key = norm(s.matchedMedication || s.drugDescription);
    if (!key) continue;
    const existing = byMed.get(key) || { medicineName: s.drugDescription, directions: '', timing: '', source: 'Script list' };
    existing.repeatsLeft = s.repeatsLeft ?? '';
    existing.status = s.requestFlag || 'Manual request';
    existing.owing = !!s.owing;
    existing.scriptNumber = s.scriptNumber || '';
    existing.source = s.matchedMedication ? 'MyPak + imported script' : existing.source === 'Medication list' ? 'Medication + script' : 'Script list';
    byMed.set(key, existing);
  }
  const latestDispense = new Map();
  for (const x of d.dispenseHistory || []) {
    const key=norm(x.drugName); if(!key) continue;
    const old=latestDispense.get(key); if(!old || String(x.dateDispensed||'')>String(old.dateDispensed||'')) latestDispense.set(key,x);
  }
  for (const [key,x] of latestDispense) {
    const existing=byMed.get(key)||{medicineName:x.drugName,directions:x.direction||'',repeatsLeft:'',status:'Manual review',source:'MyPak dispense history'};
    const owing=/owing/i.test(`${x.scriptStatus||''} ${x.dispenseStatus||''}`) || (!x.scriptNumber && Number(x.quantity||x.manuallyQuantity)>0);
    byMed.set(key,{...existing,scriptNumber:x.scriptNumber||x.calculatedScriptNumber||existing.scriptNumber||'',lastDispenseDate:x.dateDispensed||'',lastDispenseQty:x.quantity??x.manuallyQuantity??'',dispenseStatus:x.dispenseStatus??'',owing, status:owing?'Script owing':existing.status,source:`${existing.source||'MyPak'} + dispense`});
  }
  const items = Array.from(byMed.values()).sort((a,b)=>a.medicineName.localeCompare(b.medicineName)).map(it=>{const selected=shouldAutoSelectScript(it);return {...it,selected,autoSelected:selected,manualOverride:false,owingCount:it.owing?1:''};});
  const actionableCount = items.filter(it => it.selected).length;
  const owingCount = items.filter(it => it.selected && (it.owing || /^Script owing$/i.test(it.status||''))).length;
  const lowRepeatCount = items.filter(it => it.selected && repeatPosition(it.repeatsLeft) !== null && repeatPosition(it.repeatsLeft) < 2).length;
  const doctors = d.doctors || [];
  const option = (cur, val) => `<option value="${esc(val)}" ${cur===val?'selected':''}>${esc(val)}</option>`;
  $('#requestBuilder').innerHTML = items.length ? `<div class="builder-head"><div><h3>${esc(d.patient.fullName)}</h3><p class="muted">Ready to send: every script with fewer than 2 repeats and every owing script is selected automatically. Untick anything you do not want, or show all medicines to add one manually.</p></div><button class="ghost" onclick="openPatient('${d.patient.id}')">Open profile</button></div>
    <div class="request-summary"><b>${esc(actionableCount)}</b> selected automatically · <b>${esc(lowRepeatCount)}</b> with 0–1 repeats · <b>${esc(owingCount)}</b> owing · <b>${esc(items.length-actionableCount)}</b> not selected</div>
    <div class="request-actions"><button class="ghost" onclick="tickAllRequestItems(true)">Restore automatic selection</button><button class="ghost" onclick="tickAllRequestItems(false)">Untick all</button><label class="inline-check"><input id="showOkItems" type="checkbox" onchange="renderRequestItems()"> Show all medicines / add manually</label></div>
    <div id="requestItems" class="request-list"></div>
    <label class="field"><span>Prescriber</span><select id="requestDoctor"><option value="">GP / Prescriber</option>${doctors.map(x=>`<option value="${esc(x.doctorId)}">${esc(`${x.firstName||''} ${x.lastName||''}`.trim())}${x.email?` · ${esc(x.email)}`:''}</option>`).join('')}</select></label>
    <textarea id="requestNote" rows="3" placeholder="Optional note to doctor / GP"></textarea>
    <button onclick="createScriptRequest()">Generate Last Repeat / Owing PDF</button>` : empty('No medicines/scripts found for this patient. Import List of Scripts first, then try this search again.');
  $('#requestBuilder').dataset.items = JSON.stringify(items);
  if (items.length) renderRequestItems();
  renderScriptPatientSearch();
  showView('scripts');
}
function smartValue(value, suffix=''){
  return value === null || value === undefined || value === '' ? '—' : `${Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : value}${suffix}`;
}
function renderSmartScriptResult(result){
  SMART_QUEUE = result;
  const assumptions = result.assumptions || {};
  const summary = result.summary || {};
  $('#smartSummary').innerHTML = `<b>${esc(summary.patientCount||0)}</b> patients · <b>${esc(summary.medicineCount||0)}</b> medicines ready for review · <b>${esc(summary.reviewCount||0)}</b> data issues<br><small>${esc(assumptions.packWeeks)}-week pack run · ${esc(assumptions.horizonMonths)} pack run(s) forecast · ${esc(assumptions.safetyDays)}-day safety buffer${assumptions.requireVerified?' · verified repeats only':''}</small>`;
  $('#smartScriptQueue').innerHTML = (result.patients||[]).length ? result.patients.map(patient=>`<article class="smart-patient-card"><div class="smart-patient-head"><div><h3>${esc(patient.patientFullName)}</h3><p>${esc(patient.patientGroup||'No patient group')} · earliest predicted need ${esc(patient.earliestNeededBy||'—')}</p></div><div class="card-actions"><button class="ghost" onclick="openPatient('${patient.patientId}')">Open profile</button><button onclick="buildSmartRequestForPatient('${patient.patientId}')">Review request</button></div></div><div class="smart-medicine-list">${patient.medicines.map(item=>`<div class="smart-medicine"><div><b>${esc(item.medication)}</b><div class="badges">${badge(item.requestUrgency,item.owing?'danger':'warn')} ${item.owing?badge('Owing','danger'):''} ${badge(item.repeatConfidence,item.verifiedRepeat?'ok':'warn')}</div></div><div class="smart-metrics"><span>Balance <b>${esc(smartValue(item.balanceQty))}</b></span><span>Use/week <b>${esc(smartValue(item.weeklyQty))}</b></span><span>Current pack needs <b>${esc(smartValue(item.currentPackRequired))}</b></span><span>Repeats <b>${esc(smartValue(item.repeatsLeft))}</b></span><span>Total cover <b>${esc(smartValue(item.totalCoverageDays,' days'))}</b></span><span>Shortfall <b>${esc(smartValue(item.shortfallQty))}</b></span></div><p class="smart-calculation">Available ${esc(smartValue(item.projectedUnitsAvailable))} units vs estimated ${esc(smartValue(item.projectedConsumption))} units through the selected horizon + buffer. Predicted prescription need: <b>${esc(item.neededByDisplay||item.neededByDate||'—')}</b>.</p></div>`).join('')}</div></article>`).join('') : empty('No verified medicines need a script within this forecast. Check the data-review list below, or widen the options.');
  const reviews = result.reviewItems || [];
  $('#smartReviewQueue').innerHTML = reviews.length ? `<table><thead><tr><th>Patient</th><th>Medicine</th><th>Problem</th><th>Repeat source</th><th></th></tr></thead><tbody>${reviews.map(item=>`<tr><td><b>${esc(item.patientFullName)}</b></td><td>${esc(item.medication||'—')}</td><td>${esc(item.dataIssue || (item.repeatZeroNeedsCheck?'Unverified zero repeat':'Repeat needs verification'))}</td><td>${esc(item.repeatConfidence||item.source||'—')}</td><td><button class="ghost" onclick="openPatient('${item.patientId}')">Check / edit</button></td></tr>`).join('')}</tbody></table>` : empty('No repeat or balance data issues in this forecast.');
}
async function runSmartScriptForecast(event){
  event?.preventDefault();
  const data = new FormData($('#smartScriptForm'));
  const params = new URLSearchParams({
    packWeeks:data.get('packWeeks'), horizonMonths:data.get('horizonMonths'), safetyDays:data.get('safetyDays'),
    includeOwing:data.has('includeOwing')?'1':'0', requireVerified:data.has('requireVerified')?'1':'0', includeIncomplete:data.has('includeIncomplete')?'1':'0'
  });
  $('#smartSummary').textContent = 'Analysing current balances, consumption and repeats…';
  renderSmartScriptResult(await api(`/api/smart-script-queue?${params}`));
}
async function buildSmartRequestForPatient(patientId){
  const patient = (SMART_QUEUE?.patients||[]).find(row=>row.patientId===patientId);
  if (!patient) return toast('Run Smart Script Request again.');
  await buildRequestForPatient(patientId);
  const names = new Set(patient.medicines.map(item=>norm(item.medication)));
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]').map(item=>{
    const selected = names.has(norm(item.medicineName));
    if (!selected) return { ...item, selected:false, manualOverride:false };
    const forecast = patient.medicines.find(row=>norm(row.medication)===norm(item.medicineName));
    const repeats = repeatPosition(item.repeatsLeft);
    const status = forecast?.owing ? 'Script owing' : repeats !== null && repeats <= 0 ? 'New script required' : 'Low repeats';
    return { ...item, selected:true, manualOverride:true, status, owing:!!forecast?.owing || item.owing };
  });
  $('#requestBuilder').dataset.items = JSON.stringify(items);
  renderRequestItems();
  toast(`${items.filter(item=>item.selected).length} forecast medicine(s) selected for pharmacist review.`);
}
function renderRequestItems(){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const showOk = !!$('#showOkItems')?.checked;
  const option = (cur, val) => `<option value="${esc(val)}" ${cur===val?'selected':''}>${esc(val)}</option>`;
  const visible = items.map((it,i)=>({...it,_i:i})).filter(it => showOk || it.selected);
  $('#requestItems').innerHTML = visible.length ? visible.map(it=>{const repeats=repeatPosition(it.repeatsLeft);const isOwing=it.owing||/^Script owing$/i.test(it.status||'');const quantity=isOwing?(it.owingCount||1):(it.repeatsLeft??'');const quantityLabel=isOwing?'Scripts owing':'Repeats left';const quantityBadge=isOwing?`${quantity} script${Number(quantity)===1?'':'s'} owing`:(repeats!==null?`${repeats} repeat${repeats===1?'':'s'} left`:'');return `<div class="request-item professional ${it.selected?'':'ok-item'}"><input type="checkbox" data-i="${it._i}" ${it.selected?'checked':''} onchange="requestItemToggled(this)"><div class="med-cell"><b>${esc(it.medicineName)}</b><small>${esc(it.directions || 'No directions')} · ${esc(it.timing || it.source || '')}</small><small>Last dispense: <b>${esc(it.lastDispenseDate||'—')}</b> · Qty: <b>${esc(patientValue(it.lastDispenseQty))}</b> · Script: <b>${esc(it.scriptNumber||'—')}</b></small>${it.source?`<em>${esc(it.source)}</em>`:''}${quantityBadge?badge(quantityBadge,isOwing?'danger':(repeats!==null&&repeats<2?'warn':'blue')):''}${it.status==='Requested'?badge('Already requested','ok'):''}</div><label><span>${quantityLabel}</span><input class="repeat-input" data-i="${it._i}" type="number" min="0" step="1" value="${esc(quantity)}" placeholder="0, 1, 2..." onchange="requestRepeatChanged(this)"></label><label><span>Request type</span><select data-i="${it._i}" onchange="requestStatusChanged(this)">${option(it.status,'No script / negative balance')}${option(it.status,'Negative balance')}${option(it.status,'New script required')}${option(it.status,'Script owing')}${option(it.status,'Low repeats')}${option(it.status,'Manual request')}${option(it.status,'OK')}</select></label></div>`}).join('') : empty('No script has fewer than 2 repeats and no owing script was found. Use “Show all medicines” to add one manually.');
}
function tickAllRequestItems(on){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  items.forEach(it=>{it.selected=on?shouldAutoSelectScript(it):false;it.autoSelected=it.selected;it.manualOverride=false;});
  $('#requestBuilder').dataset.items=JSON.stringify(items);
  renderRequestItems();
}
function requestItemToggled(input){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const item = items[Number(input.dataset.i)]; if(!item) return;
  item.selected=!!input.checked;
  item.manualOverride=true;
  if(item.selected && /^(OK|Requested|Manual review)$/i.test(item.status||'')) item.status='Manual request';
  $('#requestBuilder').dataset.items=JSON.stringify(items);
  renderRequestItems();
}
function requestStatusChanged(select){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const item = items[Number(select.dataset.i)]; if(!item) return;
  item.status=select.value;
  item.owing=/^Script owing$/i.test(select.value);
  if(item.owing && !Number(item.owingCount)) item.owingCount=1;
  item.selected=!/^(OK|Requested)$/i.test(select.value);
  item.manualOverride=true;
  $('#requestBuilder').dataset.items=JSON.stringify(items);
  renderRequestItems();
}
function requestRepeatChanged(input){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const item = items[Number(input.dataset.i)]; if(!item) return;
  const value=input.value.trim();
  if(item.owing||/^Script owing$/i.test(item.status||'')) item.owingCount=value;
  else item.repeatsLeft=value;
  const repeats=repeatPosition(item.repeatsLeft);
  if(!item.owing && !/^(Low repeats|New script required|Manual request)$/i.test(item.status||'') && repeats!==null){item.status=repeats<=0?'New script required':repeats<2?'Low repeats':'OK';}
  item.manualOverride=true;
  item.selected=!/^(OK|Requested)$/i.test(item.status||'');
  $('#requestBuilder').dataset.items=JSON.stringify(items);
  renderRequestItems();
}
async function createScriptRequest(){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const selected=items.filter(item=>item.selected).map(item=>({ prescriptionId:item.prescriptionId, medicineName:item.medicineName, directions:item.directions||'', repeatsLeft:item.repeatsLeft??'', owingCount:item.owingCount??'', status:/^OK$/i.test(item.status||'')?'Manual request':item.status, scriptNumber:item.scriptNumber||'', lastDispenseDate:item.lastDispenseDate||'', lastDispenseQty:item.lastDispenseQty??'', owing:!!item.owing }));
  if(!selected.length) return toast('No actionable medicine selected. OK / sufficient-repeat medicines are not added to the GP letter.');
  const shouldEmail = window.confirm(PATIENT_EMAIL_CONFIRMATION);
  const pdfWindow = window.open('', '_blank');
  const doctor=$('#requestDoctor');
  let r;
  try {
    r = await api('/api/script-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patientId:selectedPatientId,items:selected,note:$('#requestNote').value,doctorId:doctor?.value||'',recipient:doctor?.selectedOptions?.[0]?.textContent||'GP / Prescriber'})});
  } catch (error) {
    if (pdfWindow) pdfWindow.close();
    throw error;
  }
  const pdfUrl = `/api/letter/${r.id}/pdf`;
  if (pdfWindow) pdfWindow.location.replace(pdfUrl); else window.open(pdfUrl, '_blank');
  let message = 'Last Repeat / Owing PDF created.';
  if (shouldEmail) {
    try {
      const result = await sendScriptRequestToPatient(r.id);
      message = `PDF created and emailed to ${result.to} from ${result.sender || 'the connected Gmail account'}.`;
    } catch (error) {
      message = `PDF created, but the email was not sent: ${error.message}`;
    }
  }
  toast(message); await loadState(); showView('scripts');
}

function specialBadge(o){
  const cls = /overdue|due today/i.test(o.computedStatus||'') ? 'danger' : /due soon|due this week|needs/i.test(o.computedStatus||'') ? 'warn' : /received|complete/i.test(o.status||'') ? 'ok' : 'blue';
  return `${badge(o.computedStatus||'Scheduled', cls)} ${isS8Medicine(o)?badge('S8/Special','danger'):badge('Special Order','blue')} ${o.source?badge(o.source,'blue'):''}`;
}
function isS8Medicine(o={}){return /\b(s8|schedule\s*8|controlled)\b|methylphenidate|ritalin|dexamfetamine|dexamphetamine|vyvanse|lisdexamfetamine|oxycodone|morphine|fentanyl|tapentadol|buprenorphine|targin|panadeine\s+forte/i.test(`${o.schedule||''} ${o.category||''} ${o.medicine||o.medication||''}`);}
function localDateInput(value){const d=value?new Date(value):null;if(!d||Number.isNaN(d.getTime()))return '';const pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
function specialOrderCard(o, compact=false){
  const checked = !/received|complete|cancelled/i.test(o.status||'') && (o.daysToOrder===null || o.daysToOrder<=7) ? 'checked' : '';
  const schedule=o.emailAutomationEnabled?`Every ${esc(o.emailIntervalDays||14)} days · next ${esc(o.nextEmailAt?new Date(o.nextEmailAt).toLocaleDateString('en-AU'):'not set')}${o.lastEmailSentAt?` · last sent ${esc(new Date(o.lastEmailSentAt).toLocaleDateString('en-AU'))}`:''}`:'Automatic email off';
  return `<div class="queue-card special-card ${compact?'compact':''}"><label class="select-line"><input type="checkbox" class="special-select" data-id="${esc(o.id)}" ${checked}></label><div><h3>${esc(o.patientFullName)}</h3><p><b>${esc(o.medicine)}</b>${o.strength?` · ${esc(o.strength)}`:''}</p><p>Source: ${esc(o.source||'—')} · Order due: <b>${esc(o.orderDueDisplay||'needs pickup')}</b> · Next pickup: ${esc(o.nextPickupDisplay||'—')}</p><div class="badges">${specialBadge(o)} ${badge(o.status||'Not ordered')} ${o.emailAutomationEnabled?badge('Auto email','mint'):''}</div>${compact?'':`<small>${esc(o.notes||'')}</small><div class="email-schedule-line ${o.lastEmailError?'email-error':''}">${esc(o.lastEmailError||schedule)}</div>`}</div><div class="card-actions"><button class="ghost" onclick="editSpecialOrder('${o.id}')">Edit</button><button class="ghost" onclick="quickSpecialStatus('${o.id}','Ordered')">Ordered</button><button class="ghost" onclick="quickSpecialStatus('${o.id}','Received')">Received</button></div></div>`;
}
function filteredSpecialOrders(){
  const q=($('#specialSearch')?.value||'').toLowerCase().trim();
  const f=$('#specialFilter')?.value||'all';
  return (STATE.specialOrdersComputed||[]).filter(o=>{
    if(q && !`${o.patientFullName} ${o.medicine} ${o.source} ${o.category} ${o.notes}`.toLowerCase().includes(q)) return false;
    if(f==='due' && !(o.daysToOrder===null || o.daysToOrder<=7) ) return false;
    if(f==='s8' && !/s8|vyvanse|targin|diazepam|panadeine|controlled/i.test(`${o.category} ${o.medicine}`)) return false;
    if(f==='rdh' && !/rdh/i.test(o.source||'')) return false;
    if(f==='hibiscus' && !/hibiscus/i.test(o.source||'')) return false;
    if(f==='received' && !/received|complete/i.test(o.status||'')) return false;
    if(f==='all' && /received|complete|cancelled/i.test(o.status||'')) return false;
    return true;
  });
}
function renderSpecialOrders(){
  const orders=filteredSpecialOrders();
  const s8rx=(STATE.mypakPrescriptions||[]).filter(isS8Medicine).filter(m=>{const q=($('#specialSearch')?.value||'').toLowerCase().trim();return !q||`${m.firstName||''} ${m.lastName||''} ${m.medication||''} ${m.drugCode||''}`.toLowerCase().includes(q)}).slice(0,80);
  $('#liveS8List').innerHTML=s8rx.length?s8rx.map(m=>{const p=(STATE.patientsComputed||[]).find(x=>String(x.mypakPatientId)===String(m.patientId));const added=p&&(STATE.specialOrdersComputed||[]).some(o=>o.patientId===p.id&&norm(o.medicine)===norm(m.medication));return `<div class="queue-card"><div><h3>${esc(`${m.firstName||''} ${m.lastName||''}`.trim()||p?.fullName)}</h3><p><b>${esc(m.medication)}</b> · balance ${esc(patientValue(m.balanceQty))} · repeats ${esc(patientValue(m.repeatsLeft))}</p><div class="badges">${badge('S8','danger')} ${Number(m.balanceQty)<0?badge('Negative balance','warn'):''} ${added?badge('In special orders','ok'):''}</div></div>${p&&!added?`<button onclick="addLiveS8Special('${p.id}','${encodeURIComponent(m.medication||'')}')">Add to Special Orders</button>`:p?`<button class="ghost" onclick="editSpecialOrder('${(STATE.specialOrdersComputed||[]).find(o=>o.patientId===p.id&&norm(o.medicine)===norm(m.medication))?.id}')">Edit schedule</button>`:''}</div>`}).join(''):empty('No matching S8 medicine in the current MyPak sync.');
  $('#specialOrdersList').innerHTML = orders.length ? orders.map(o=>specialOrderCard(o)).join('') : empty('No special orders found. Add one manually or import/update patients first.');
  const patients=STATE.patientsComputed||[];
  const doctorEmails=(STATE.mypakDoctors||[]).filter(d=>d.email).map(d=>`<option value="${esc(d.email)}">${esc(`${d.firstName||''} ${d.lastName||''}`.trim())}</option>`).join('');
  $('#specialOrderForm').innerHTML = `<div class="field full"><label>Patient</label><select name="patientId" id="specialPatientSelect">${patients.map(p=>`<option value="${p.id}">${esc(p.fullName)}${p.mypakPatientId?' · MyPak':''}</option>`).join('')}</select></div><div class="field"><label>Medicine</label><input name="medicine" list="specialMedicineOptions" placeholder="Select or type medicine"><datalist id="specialMedicineOptions"></datalist></div>${fieldHTML('strength','Strength','text','')}${fieldHTML('directions','Dose / directions','text','')}${fieldHTML('source','Source','select:RDH|Hibiscus One|CP|NT|Patient/Carer|Other','RDH')}${fieldHTML('category','Category','select:Special Order|S8|S8/Special','Special Order')}${fieldHTML('lastPickupDate','Last pickup date','date','')}${fieldHTML('cycleDays','Cycle days','number',STATE.settings.defaultCycleDays)}${fieldHTML('orderLeadDays','Order lead days before next pickup','number',STATE.settings.defaultSpecialOrderLeadDays||14)}${fieldHTML('status','Status','select:Needs confirmation|Not ordered|Order due|Request generated|Ordered|Received|Packed|Dispensed|Complete|Cancelled','Not ordered')}${fieldHTML('notes','Notes','textarea','')}<div class="schedule-fields"><h3>Automatic Gmail schedule</h3><div class="schedule-grid"><label class="field"><span>Patient email</span><input name="patientEmail" type="email"></label><label class="field"><span>Doctor email</span><input name="doctorEmail" type="email" list="specialDoctorEmails"><datalist id="specialDoctorEmails">${doctorEmails}</datalist></label><label class="field"><span>Repeat every (days)</span><input name="emailIntervalDays" type="number" min="1" value="14"></label><label class="field"><span>First / next email date</span><input name="nextEmailDate" type="date"></label></div><div class="schedule-checks"><label><input name="emailAutomationEnabled" type="checkbox"> Enable automatic email</label><label><input name="sendToPatient" type="checkbox"> Patient</label><label><input name="sendToDoctor" type="checkbox"> Doctor</label><label><input name="sendToPharmacy" type="checkbox" checked> Pharmacy</label></div><p class="secret-note">Each recipient receives a separate email, so patient and doctor addresses are not disclosed to each other.</p></div><div class="field full"><button>Add special order</button></div>`;
  const patientSelect = $('#specialPatientSelect');
  const updateMedicineOptions = () => {
    const patient = patients.find(p => p.id === patientSelect?.value);
    const balances = (STATE.mypakMedicationBalances || []).filter(m => String(m.patientId) === String(patient?.mypakPatientId));
    $('#specialMedicineOptions').innerHTML = balances.map(m => `<option value="${esc(m.medication)}">${esc(m.drugCode || '')} · balance ${esc(patientValue(m.balanceQty))}</option>`).join('');
    if(!$('#specialOrderForm').dataset.editId) $('#specialOrderForm').elements.patientEmail.value=patient?.email||'';
  };
  if (patientSelect) { patientSelect.addEventListener('change', updateMedicineOptions); updateMedicineOptions(); }
  $('#recentSpecialRequests').innerHTML = (STATE.specialOrderRequests||[]).length ? `<table><thead><tr><th>Date</th><th>Recipient</th><th>Items</th><th>Status</th><th>PDF</th><th>Preview</th></tr></thead><tbody>${STATE.specialOrderRequests.slice(0,80).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.recipient)}</td><td>${esc((r.items||[]).length)}</td><td>${esc(r.status)}</td><td><a class="linkbtn" href="/api/special-order-letter/${r.id}/pdf" target="_blank">Open PDF</a></td><td><a class="linkbtn" href="/api/special-order-letter/${r.id}" target="_blank">HTML</a></td></tr>`).join('')}</tbody></table>` : empty('No special order request PDFs generated yet.');
}
async function addSpecialOrder(e){
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.currentTarget).entries());
  await api('/api/special-orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  toast('Special order added.'); await loadState(); showView('special');
}
function editSpecialOrder(id){
  const o=(STATE.specialOrdersComputed||[]).find(x=>x.id===id); if(!o) return;
  showView('special');
  const form=$('#specialOrderForm');
  form.patientId.value=o.patientId; form.medicine.value=o.medicine; form.strength.value=o.strength||''; form.directions.value=o.directions||''; form.source.value=o.source||'Other'; form.category.value=o.category||'Special Order'; form.lastPickupDate.value=o.lastPickupDate||''; form.cycleDays.value=o.cycleDays||''; form.orderLeadDays.value=o.orderLeadDays||''; form.status.value=o.status||'Not ordered'; form.notes.value=o.notes||'';
  form.patientEmail.value=o.patientEmail||'';form.doctorEmail.value=o.doctorEmail||'';form.emailIntervalDays.value=o.emailIntervalDays||14;form.nextEmailDate.value=localDateInput(o.nextEmailAt);form.emailAutomationEnabled.checked=!!o.emailAutomationEnabled;form.sendToPatient.checked=!!o.sendToPatient;form.sendToDoctor.checked=!!o.sendToDoctor;form.sendToPharmacy.checked=o.sendToPharmacy!==false;
  form.dataset.editId=id; form.querySelector('button').textContent='Save special order';
}
async function addLiveS8Special(patientId,encodedMedicine){
  const medicine=decodeURIComponent(encodedMedicine);const patient=(STATE.patientsComputed||[]).find(p=>p.id===patientId);if(!patient)return;
  await api('/api/special-orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patientId,medicine,category:'S8',source:'MyPak',patientEmail:patient.email||'',sendToPharmacy:true})});
  toast('S8 medicine added to Special Orders. Open Edit schedule to set automatic email.');await loadState();showView('special');
}
async function quickSpecialStatus(id,status){ await api(`/api/special-orders/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); toast(`Special order marked ${status}.`); await loadState(); }
async function specialOrderSubmit(e){
  e.preventDefault();
  const fd=new FormData(e.currentTarget);const body=Object.fromEntries(fd.entries());['emailAutomationEnabled','sendToPatient','sendToDoctor','sendToPharmacy'].forEach(name=>body[name]=fd.has(name));
  const editId=e.currentTarget.dataset.editId;
  if(editId){ await api(`/api/special-orders/${editId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); delete e.currentTarget.dataset.editId; toast('Special order saved.'); }
  else { await api('/api/special-orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); toast('Special order added.'); }
  await loadState(); showView('special');
}
function setSpecialChecks(mode){
  $$('#specialOrdersList .special-select').forEach(cb=>{
    if(mode==='none') cb.checked=false;
    else if(mode==='due') { const o=(STATE.specialOrdersComputed||[]).find(x=>x.id===cb.dataset.id); cb.checked=!!o && !/received|complete|cancelled/i.test(o.status||'') && (o.daysToOrder===null || o.daysToOrder<=7); }
  });
}
async function generateSpecialPdf(){
  const ids=$$('#specialOrdersList .special-select').filter(x=>x.checked).map(x=>x.dataset.id);
  if(!ids.length) return toast('Tick at least one special order.');
  const body={orderIds:ids,recipient:$('#specialRecipient').value,mode:$('#specialRequestMode').value,note:$('#specialRequestNote').value};
  const r=await api('/api/special-order-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  toast('Special Order PDF created.'); window.open(`/api/special-order-letter/${r.id}/pdf`,'_blank'); await loadState(); showView('special');
}

function renderDoctor(){
  const list = STATE.dashboard.doctorUpdates || [];
  $('#doctorList').innerHTML = list.length ? list.map(u=>`<div class="queue-card"><div><h3>${esc(u.patientFullName)}</h3><p>${esc(u.changeType)} · ${esc(u.medicine)} · ${esc(u.effectiveFrom)}</p><div class="badges">${badge(u.status,'warn')}${u.risk?badge(u.risk,/urgent|current|immediate/i.test(u.risk)?'danger':'blue'):''}</div></div><button class="ghost" onclick="markDoctor('${u.id}','Applied / closed')">Close</button></div>`).join('') : empty('No pending doctor updates.');
  $('#doctorForm').innerHTML = `<div class="field full"><label>Patient</label><select name="patientId">${STATE.patientsComputed.map(p=>`<option value="${p.id}">${esc(p.fullName)}</option>`).join('')}</select></div>${fieldHTML('receivedDate','Received date','date','')}${fieldHTML('source','Source','text','Doctor letter')}${fieldHTML('changeType','Change type','select:Add medicine|Stop medicine|Dose increase|Dose decrease|Direction changed|Timing changed|Temporary course|Clarification','')}${fieldHTML('medicine','Medicine','text','')}${fieldHTML('oldDirection','Old direction','text','')}${fieldHTML('newDirection','New direction','text','')}${fieldHTML('effectiveFrom','Effective from','select:Needs review|Immediately|Current pack|Next pack|Specific date|Waiting for script|Waiting for clarification','')}${fieldHTML('risk','Risk','select:Routine|Urgent|Affects current pack|S8/S4D|Waiting for script','')}${fieldHTML('notes','Notes','textarea','')}<div class="field full"><button>Add pending update</button></div>`;
  const patientSelect=$('#doctorAiPatient');
  if(patientSelect){const selected=patientSelect.value;patientSelect.innerHTML=(STATE.patientsComputed||[]).filter(p=>p.mypakPatientId).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.fullName)} · MyPak</option>`).join('');if(!activeDoctorAnalysisId&&patientSelect.value)loadPatientPackSnapshot(patientSelect.value);}
  const analyses=STATE.doctorChangeAnalyses||[];
  $('#doctorAnalysisList').innerHTML=analyses.length?analyses.slice(0,60).map(a=>`<div class="queue-card ${a.id===activeDoctorAnalysisId?'selected-card':''}"><div><h3>${esc(a.patientFullName)}</h3><p>${esc(a.sourceName)} · ${(a.changes||[]).length} proposed change(s)</p><div class="badges">${badge(a.status,a.status==='Approved for pack worksheet'?'ok':'warn')} ${a.packImpactUpdatedAt?badge('Pack data refreshed','mint'):''}</div></div><button class="ghost" onclick="openDoctorAnalysis('${a.id}')">Open</button></div>`).join(''):empty('No AI doctor-change analyses yet.');
  if(activeDoctorAnalysisId&&!analyses.some(a=>a.id===activeDoctorAnalysisId))activeDoctorAnalysisId=null;
  renderDoctorAnalysis();
  refreshDoctorAiStatus();
}
async function refreshDoctorAiStatus(){
  const label=$('#doctorAiStatus');if(!label)return;
  try{const status=await api('/api/doctor-change/ai-status');label.textContent=status.configured?`AI ready · ${status.model} · pharmacist approval required`:'AI not configured · manual entry remains available';label.className=status.configured?'ai-ready':'ai-offline';$('#doctorAnalyseBtn').disabled=!status.configured;}
  catch(error){label.textContent=error.message;}
}
async function loadPatientPackSnapshot(patientId){
  const box=$('#patientPackSnapshot');if(!box||!patientId)return;
  box.innerHTML='<span class="muted">Loading current MyPak pack jobs…</span>';
  try{const result=await api(`/api/patients/${patientId}/pack-jobs`);const jobs=result.jobs||[];box.innerHTML=`<div class="pack-snapshot-head"><b>MyPak monthly pack timeline</b><span>${jobs.length} synced job(s) · last sync ${result.lastSyncAt?new Date(result.lastSyncAt).toLocaleString():'never'}</span></div>${jobs.length?`<div class="pack-chips">${jobs.slice(0,18).map(j=>`<span class="pack-chip"><b>${esc(j.statusLabel)}</b> ${esc(j.packStartDate?new Date(j.packStartDate).toLocaleDateString('en-AU'):'—')} · ${esc(j.barcode||j.jobId)}</span>`).join('')}</div>`:empty('No MyPak pack jobs matched this patient yet. Press Refresh to sync.')}`;}
  catch(error){box.innerHTML=empty(error.message);}
}
function openDoctorAnalysis(id){activeDoctorAnalysisId=id;renderDoctor();document.querySelector('#doctorAnalysisWorkbench')?.scrollIntoView({behavior:'smooth',block:'start'});}
function decisionOptions(value){return ['Pending','Approved','Rejected'].map(item=>`<option ${item===value?'selected':''}>${item}</option>`).join('');}
function renderDoctorAnalysis(){
  const box=$('#doctorAnalysisWorkbench');if(!box)return;
  const analysis=(STATE.doctorChangeAnalyses||[]).find(item=>item.id===activeDoctorAnalysisId)||(STATE.doctorChangeAnalyses||[])[0];
  if(!analysis){box.innerHTML=empty('Analyse a doctor email or medication summary to create an exact pack amendment plan.');return;}
  activeDoctorAnalysisId=analysis.id;
  const changeRows=(analysis.changes||[]).map((change,index)=>`<tr data-change-index="${index}"><td><select class="change-decision">${decisionOptions(change.pharmacistDecision||'Pending')}</select></td><td><select class="change-type"><option value="add" ${change.changeType==='add'?'selected':''}>Add</option><option value="stop" ${change.changeType==='stop'?'selected':''}>Stop</option><option value="dose_change" ${change.changeType==='dose_change'?'selected':''}>Dose change</option><option value="timing_change" ${change.changeType==='timing_change'?'selected':''}>Timing change</option><option value="direction_change" ${change.changeType==='direction_change'?'selected':''}>Direction change</option><option value="temporary" ${change.changeType==='temporary'?'selected':''}>Temporary</option><option value="clarify" ${change.changeType==='clarify'?'selected':''}>Clarify</option></select></td><td><input class="change-med" value="${esc(change.medication)}"></td><td><input class="change-old" value="${esc(change.oldDirection)}"></td><td><input class="change-new" value="${esc(change.newDirection)}"></td><td><input class="change-effective" type="date" value="${esc(change.effectiveDate)}"></td><td>${badge(change.confidence||'low',change.confidence==='high'?'ok':change.confidence==='medium'?'warn':'danger')}<br><small>${esc(change.evidence||'')}</small></td></tr>`).join('');
  const packCards=(analysis.packImpact||[]).map(job=>{const instructions=(job.instructions||[]).map(ins=>{const cells=(ins.cells||[]).map(cell=>`<span class="dose-cell">${esc(cell.date?new Date(cell.date).toLocaleDateString('en-AU'):'date?')} · ${esc(cell.day)} · <b>${esc(cell.doseTime)}</b>${cell.quantity!==null&&cell.quantity!==undefined?` · qty ${esc(cell.quantity)}`:''}</span>`).join('');return `<div class="pack-instruction ${ins.exact?'exact':'needs-review'}"><div><b>${esc(ins.action)} ${esc(ins.matchedMedication||ins.medication)}</b><br><small>${esc(ins.previousDirection||'')} ${ins.newDirection?`→ ${esc(ins.newDirection)}`:''}</small></div>${cells?`<div class="dose-cells">${cells}</div>`:''}${ins.warning?`<p class="danger-text">${esc(ins.warning)}</p>`:''}</div>`}).join('');return `<article class="pack-job-card"><div class="pack-job-head"><div><h3>${esc(job.barcode||job.jobId)}</h3><p>${esc(job.patientName||analysis.patientFullName)} · start ${esc(job.packStartDate?new Date(job.packStartDate).toLocaleDateString('en-AU'):'—')} · ${esc(job.numberOfWeek||1)} week(s)</p></div><div class="badges">${badge(job.statusLabel,/completed|distribution/i.test(job.statusLabel)?'danger':/checking|packing|correction/i.test(job.statusLabel)?'warn':'blue')}</div></div><p><b>Workflow:</b> ${esc(job.workflowInstruction)}<br><b>Created by:</b> ${esc(job.createdBy||'—')} · <b>Packed:</b> ${esc(job.packedBy||'—')} · <b>Checked:</b> ${esc(job.checkedBy||'—')} · <b>Completed:</b> ${esc(job.completedBy||'—')}</p><div class="pack-actions"><a class="ghost" target="_blank" rel="noopener" href="/api/mypak/pack-jobs/${encodeURIComponent(job.jobId)}/print">Preview MyPak print</a></div>${instructions||empty(job.detailError||'No medication change falls inside this pack.')}</article>`}).join('');
  const worksheetReady=analysis.status==='Approved for pack worksheet'&&analysis.packImpactUpdatedAt&&(analysis.changes||[]).some(change=>change.pharmacistDecision==='Approved');
  box.innerHTML=`<div class="analysis-banner"><div><h3>${esc(analysis.patientFullName)}</h3><p>${esc(analysis.documentSummary||'No summary')}</p></div><div class="badges">${badge(analysis.status,'warn')}</div></div>${(analysis.warnings||[]).length?`<div class="clinical-warning"><b>AI warnings</b><ul>${analysis.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`:''}<div class="table-wrap change-review"><table><thead><tr><th>Decision</th><th>Change</th><th>Medicine</th><th>Previous</th><th>New</th><th>Effective</th><th>Evidence</th></tr></thead><tbody>${changeRows||'<tr><td colspan="7">No medication change was extracted.</td></tr>'}</tbody></table></div><div class="request-actions doctor-review-actions"><button onclick="saveDoctorAnalysis('${analysis.id}',false)">Save pharmacist review</button><button onclick="saveDoctorAnalysis('${analysis.id}',true)">Approve & refresh affected packs</button>${worksheetReady?`<a class="ghost" target="_blank" rel="noopener" href="/api/doctor-change/analyses/${analysis.id}/worksheet">Print pack amendment worksheet</a>`:'<span class="muted">Worksheet unlocks after pharmacist approval and a fresh MyPak pack check.</span>'}</div><div class="pack-impact-grid">${packCards||empty('Pack impact has not been refreshed yet. Approve changes, then refresh affected packs.')}</div>`;
}
function collectDoctorChanges(analysis){return (analysis.changes||[]).map((change,index)=>{const row=document.querySelector(`tr[data-change-index="${index}"]`);if(!row)return change;return {...change,pharmacistDecision:row.querySelector('.change-decision').value,changeType:row.querySelector('.change-type').value,medication:row.querySelector('.change-med').value,oldDirection:row.querySelector('.change-old').value,newDirection:row.querySelector('.change-new').value,effectiveDate:row.querySelector('.change-effective').value};});}
async function saveDoctorAnalysis(id,refreshPacks){
  const analysis=(STATE.doctorChangeAnalyses||[]).find(item=>item.id===id);if(!analysis)return;
  const changes=collectDoctorChanges(analysis);const approved=changes.filter(change=>change.pharmacistDecision==='Approved').length;
  if(refreshPacks&&!approved)return toast('Approve at least one medication change before generating pack instructions.');
  try{await api(`/api/doctor-change/analyses/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({changes,status:approved?'Approved for pack worksheet':'Pending pharmacist review'})});if(refreshPacks){toast('Reading exact pack contents from MyPak…');await api(`/api/doctor-change/analyses/${id}/pack-impact`,{method:'POST'});}await loadState();activeDoctorAnalysisId=id;renderDoctor();toast(refreshPacks?'Affected packs and compartments refreshed.':'Pharmacist review saved.');}catch(error){toast(error.message);}
}
async function doctorAiSubmit(event){
  event.preventDefault();const form=event.currentTarget;const button=$('#doctorAnalyseBtn');button.disabled=true;button.textContent='Analysing safely…';
  try{const result=await api('/api/doctor-change/analyse',{method:'POST',body:new FormData(form)});activeDoctorAnalysisId=result.id;await loadState();await api(`/api/doctor-change/analyses/${result.id}/pack-impact`,{method:'POST'});await loadState();activeDoctorAnalysisId=result.id;renderDoctor();toast('Draft changes extracted. Review every line before approval.');}
  catch(error){toast(error.message);}finally{button.textContent='Analyse medication changes';await refreshDoctorAiStatus();}
}
async function markDoctor(id,status){ await api(`/api/doctor-updates/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); toast('Doctor update closed.'); await loadState(); }
function renderSettings(){
  const s=STATE.settings;
  const fields=[['defaultCycleDays','Default cycle days'],['defaultPackLeadDays','Pack lead days'],['defaultDispenseLeadDays','Dispense lead days'],['defaultOrderLeadDays','Order lead days'],['urgentWindowDays','Urgent window days'],['dueSoonWindowDays','Due soon window'],['scriptLowRepeatThreshold','Low repeat threshold'],['monthlyDays','Monthly cycle days']];
  $('#settingsForm').innerHTML=fields.map(([k,l])=>fieldHTML(k,l,'number',s[k])).join('')+`<div class="field full"><button>Save settings</button></div>`;
  $('#pharmacyEmail').value=s.pharmacyEmail||'';
  const logs=STATE.specialEmailLog||[];
  $('#specialEmailLog').innerHTML=logs.length?`<table><thead><tr><th>Time</th><th>Patient</th><th>Medicine</th><th>Result</th></tr></thead><tbody>${logs.slice(0,50).map(log=>`<tr><td>${esc(new Date(log.at).toLocaleString('en-AU'))}</td><td>${esc(log.patientFullName)}</td><td>${esc(log.medicine)}</td><td>${esc(log.status)}${log.error?`<br><small class="email-error">${esc(log.error)}</small>`:''}</td></tr>`).join('')}</tbody></table>`:empty('No automatic special order emails sent yet.');
  $('#auditLog').innerHTML=(STATE.auditLog||[]).length?`<table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>${STATE.auditLog.slice(0,200).map(a=>`<tr><td>${esc((a.at||'').slice(0,19).replace('T',' '))}</td><td>${esc(a.action)}</td><td><code>${esc(JSON.stringify(a.details||{}))}</code></td></tr>`).join('')}</tbody></table>`:empty('No audit log yet.');
  refreshGmailStatus();
}
async function refreshGmailStatus(){
  try{const status=await api('/api/gmail/status');const label=$('#gmailStatus');const connect=$('#gmailConnect');label.textContent=status.connected?`Connected · ${status.emailAddress||'Gmail sender'}`:status.configured?'Ready to connect Gmail':'Google OAuth server credentials required';label.className=status.connected?'gmail-connected':'gmail-not-connected';connect.style.pointerEvents=status.configured?'':'none';connect.style.opacity=status.configured?'1':'.45';$('#gmailTest').disabled=!status.connected;$('#gmailRunNow').disabled=!status.connected;$('#gmailDisconnect').disabled=!status.connected;$('#gmailSetupHelp').textContent=status.configured?`Authorised redirect URI: ${status.redirectUri}`:`To activate the login button, add GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_TOKEN_KEY on the server. Redirect URI: ${status.redirectUri}`;}
  catch(error){$('#gmailStatus').textContent=error.message;}
}
async function emailSettingsSubmit(event){event.preventDefault();try{await api('/api/email-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pharmacyEmail:$('#pharmacyEmail').value})});await loadState();showView('settings');toast('Pharmacy email saved.');}catch(error){toast(error.message);}}
async function gmailTest(){try{await api('/api/gmail/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('#pharmacyEmail').value})});toast('Test email sent.');}catch(error){toast(error.message);}}
async function gmailDisconnect(){if(!window.confirm('Disconnect the Gmail sender? Automatic schedules will pause until Gmail is reconnected.'))return;await api('/api/gmail/disconnect',{method:'POST'});await refreshGmailStatus();toast('Gmail disconnected.');}
async function runSpecialEmailScheduler(){try{const result=await api('/api/special-orders/run-email-scheduler',{method:'POST'});await loadState();showView('settings');toast(result.skipped?`Scheduler paused: ${result.reason}`:`Due emails complete: ${result.sent} sent · ${result.failed} failed.`);}catch(error){toast(error.message);}}
function showView(id){
  $$('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  $$('.view').forEach(v=>v.classList.toggle('active',v.id===id));
  const titles={dashboard:['Dashboard','Prioritise packing, dispensing, ordering and prescription requests by pickup risk.'],import:['Import Centre','Stage imports safely: detect HIND, link medicines, calculate scripts, review exceptions.'],patients:['Patients','Master list for Webster/Sachet cycle, pickup date and workflow flags.'],scripts:['Script Requests','Build GP letters from patient medicine/script data.'],smart:['Smart Script Request','Forecast pack consumption and prescription coverage with auditable calculations.'],special:['Special Orders / S8','RDH, Hibiscus One, CP/NT and controlled medicine ordering by due date.'],doctor:['Doctor Updates','Medication changes stay pending until reviewed.'],settings:['Settings & Audit','Configure lead times and track changes.']};
  $('#pageTitle').textContent=titles[id][0]; $('#pageSubtitle').textContent=titles[id][1];
}
async function importForm(e){
  e.preventDefault(); const form=e.currentTarget; const type=form.dataset.import; const fd=new FormData(form);
  if(!fd.get('file')?.name) return toast('Choose a file first.');
  form.querySelector('button').disabled=true; form.querySelector('button').textContent='Importing...';
  try{
    const endpoint = type==='pack-record' ? '/api/import/pack-record' : `/api/import/${type}`;
    const result=await api(endpoint,{method:'POST',body:fd});
    const summaryParts = [];
    const preferredKeys = type === 'patients'
      ? ['totalRows','hindRows','added','updated','missing']
      : type === 'scripts'
        ? ['rows','parsed','matched','scripts','issues','skippedNonMedicine']
        : type === 'pack-record'
          ? ['rows','matched','unmatched','patientsUpdated']
          : ['rows','medications'];
    preferredKeys.forEach(k => { if (result[k] !== undefined) summaryParts.push(`${k} ${result[k]}`); });
    toast(`${type} imported: ${summaryParts.join(' · ')}`);
    await loadState();
    showView('import');
  }
  catch(err){ toast(err.message); }
  finally{ form.querySelector('button').disabled=false; form.querySelector('button').textContent= type==='patients'?'Import patients':type==='medications'?'Import medications':type==='pack-record'?'Import pack report':'Import scripts'; }
}
async function doctorSubmit(e){ e.preventDefault(); const body=Object.fromEntries(new FormData(e.currentTarget).entries()); await api('/api/doctor-updates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); toast('Doctor update added as pending review.'); await loadState(); showView('doctor'); }
async function settingsSubmit(e){ e.preventDefault(); const body=Object.fromEntries(new FormData(e.currentTarget).entries()); Object.keys(body).forEach(k=>body[k]=Number(body[k])); await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); toast('Settings saved.'); await loadState(); showView('settings'); }
function renderAll(){ renderDashboard(); renderImportReview(); renderPatients(); renderScriptPage(); renderSpecialOrders(); renderDoctor(); renderSettings(); }
async function loadState(){ STATE = await api('/api/state'); renderAll(); }

$$('.nav').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
$('#refreshBtn').addEventListener('click',()=>syncMyPakPatients());
$('#mypakSyncBtn').addEventListener('click',syncMyPakPatients);
$('#mypakSyncBtnSettings').addEventListener('click',syncMyPakPatients);
$('#mpsTokenForm').addEventListener('submit',connectMps);
$('#mpsPatientSyncBtn').addEventListener('click',syncMpsPatients);
$('#mpsMedicationSyncBtn').addEventListener('click',syncMpsMedications);
$('#mpsOfflineImportForm').addEventListener('submit',importOfflineMpsPatients);
$$('form.upload-card').forEach(f=>f.addEventListener('submit',importForm));
$$('form.quick-report-upload').forEach(f=>f.addEventListener('submit',importForm));
$('#patientSearch').addEventListener('input',renderPatients); $('#patientFilter').addEventListener('change',renderPatients);
$('#scriptPatientSearch').addEventListener('input',renderScriptPatientSearch); $('#clearScriptSearch').addEventListener('click',()=>{ $('#scriptPatientSearch').value=''; renderScriptPatientSearch(); });
$('#smartScriptForm').addEventListener('submit',runSmartScriptForecast);
$('#savePatientBtn').addEventListener('click',savePatient);
$('#doctorForm').addEventListener('submit',doctorSubmit);
$('#doctorAiForm').addEventListener('submit',doctorAiSubmit);
$('#doctorAiPatient').addEventListener('change',event=>loadPatientPackSnapshot(event.target.value));
$('#specialOrderForm').addEventListener('submit',specialOrderSubmit);
$('#specialSearch').addEventListener('input',renderSpecialOrders); $('#specialFilter').addEventListener('change',renderSpecialOrders);
$('#specialTickDue').addEventListener('click',()=>setSpecialChecks('due')); $('#specialUntick').addEventListener('click',()=>setSpecialChecks('none')); $('#generateSpecialPdf').addEventListener('click',generateSpecialPdf);
$('#settingsForm').addEventListener('submit',settingsSubmit);
$('#emailSettingsForm').addEventListener('submit',emailSettingsSubmit);$('#gmailTest').addEventListener('click',gmailTest);$('#gmailDisconnect').addEventListener('click',gmailDisconnect);$('#gmailRunNow').addEventListener('click',runSpecialEmailScheduler);
window.openPatient=openPatient; window.editPatient=editPatient; window.openDispensePatient=openDispensePatient; window.setDispenseStatus=setDispenseStatus; window.deleteScriptRequest=deleteScriptRequest; window.printScriptRequest=printScriptRequest; window.setScriptRequestStatus=setScriptRequestStatus; window.buildRequestForPatient=buildRequestForPatient; window.renderRequestItems=renderRequestItems; window.tickAllRequestItems=tickAllRequestItems; window.requestItemToggled=requestItemToggled; window.requestStatusChanged=requestStatusChanged; window.requestRepeatChanged=requestRepeatChanged; window.createScriptRequest=createScriptRequest; window.markDoctor=markDoctor; window.editSpecialOrder=editSpecialOrder; window.addLiveS8Special=addLiveS8Special; window.quickSpecialStatus=quickSpecialStatus; window.openDoctorAnalysis=openDoctorAnalysis; window.saveDoctorAnalysis=saveDoctorAnalysis;
window.saveRepeatOverride=saveRepeatOverride; window.clearRepeatOverride=clearRepeatOverride; window.adjustRepeatOverride=adjustRepeatOverride; window.buildSmartRequestForPatient=buildSmartRequestForPatient;
window.addEventListener('focus', checkForAppUpdate);
document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) checkForAppUpdate(); });
setInterval(checkForAppUpdate, 60000);
checkForAppUpdate();
loadState().then(async()=>{if(new URLSearchParams(location.search).has('gmail')){showView('settings');toast(new URLSearchParams(location.search).get('gmail')==='connected'?'Gmail connected successfully.':'Gmail connection was not approved.');}await Promise.all([refreshMyPakStatus(),refreshMpsStatus()]);await syncMyPakPatients({silent:true});}).catch(e=>toast(e.message));
