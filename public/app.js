let STATE = null;
let selectedPatientId = null;
let editPatientId = null;
let MPS_CONNECTION = null;
const CLIENT_BUILD_VERSION = '20260714-last-repeat-owing-v1';

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
    ['Date of birth', p.dob], ['Gender', p.gender], ['Address', patientAddress(p)], ['Phone', p.phone],
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
function myPakMedicationBalances(rows){
  const scriptState = m => m.owing ? badge('OWING','danger') : m.requestFlag==='New script required' ? badge('New script required','warn') : m.requestFlag==='Low repeats' ? badge('Low repeats','warn') : m.requestFlag==='OK' ? badge('OK','ok') : m.newScriptNeeded===true ? badge('New script needed','warn') : m.newScriptNeeded===false ? badge('OK','ok') : '—';
  return rows?.length ? `<table><thead><tr><th>Medication</th><th>Directions</th><th>Current balance</th><th>Required / week</th><th>Repeats</th><th>Owing / status</th><th>Script</th><th>Source</th><th>Last update / dispense</th></tr></thead><tbody>${rows.map(m=>{const lastDate=m.lastDispenseBalanceUpdated||m.scriptDispenseDate;return `<tr><td><b>${esc(m.medication||'—')}</b><br><small>${esc(m.drugCode||'')}</small></td><td>${esc(m.direction||'—')}</td><td>${esc(patientValue(m.balanceQty))}</td><td>${esc(patientValue(m.weeklyQty))}</td><td><b>${esc(patientValue(m.repeatsLeft))}</b></td><td>${scriptState(m)}</td><td>${m.scriptNumber?`<b>${esc(m.scriptNumber)}</b>`:'—'}</td><td>${esc(m.overviewSource||m.repeatSource||'MyPak')}</td><td>${esc(lastDate ? new Date(lastDate).toLocaleString() : '—')}</td></tr>`}).join('')}</tbody></table>` : empty('No medication, balance or script information is available for this patient.');
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
  $('#patientDetails').innerHTML = `<div class="panel-head"><h2>${esc(p.fullName)}</h2><span>${esc(p.calculatedStatus)} · Risk ${esc(p.riskScore)}</span></div><div class="two-col"><div><h3>Workflow</h3><p>Last pickup: <b>${esc(p.lastPickupDisplay||'not set')}</b><br>Next pickup: <b>${esc(p.nextPickupDisplay||'not set')}</b><br>Pack due: <b>${esc(p.packDueDisplay||'—')}</b><br>Dispense due: <b>${esc(p.dispenseDueDisplay||'—')}</b><br>Order due: <b>${esc(p.orderDueDisplay||'—')}</b></p><div class="badges">${patientBadges(p)}</div><p>${esc(p.notes||'')}</p><button onclick="editPatient('${p.id}')">Edit workflow</button> <button class="ghost" onclick="buildRequestForPatient('${p.id}')">Build script request</button></div><div>${patientDemographics(p)}</div></div><h3>MPS medication data</h3>${mpsMedicationSummary(d)}<h3>Medications, pill balance & scripts</h3>${myPakMedicationBalances(d.medicationOverview||d.medicationBalances)}`;
  showView('patients');
}
function editPatient(id){
  const p = patientPool().find(x=>x.id===id); if(!p) return;
  editPatientId = id;
  const fields = [
    ['fullName','Full name','text'],['cycleDays','Pickup interval days','number'],['lastPickupDate','Last pickup date','date'],['packLeadDays','Pack lead days','number'],['dispenseLeadDays','Dispense lead days','number'],['orderLeadDays','Medicine order lead days','number'],
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
  $('#recentRequests').innerHTML = (STATE.scriptRequests||[]).length ? `<table><thead><tr><th>Date</th><th>Patient</th><th>Items</th><th>Status / next action</th><th>Request</th></tr></thead><tbody>${STATE.scriptRequests.slice(0,80).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.patientFullName)}</td><td>${r.items.length}</td><td>${badge(r.status,r.status==='Received'?'ok':r.status==='Sent'?'blue':'warn')}<div class="table-actions">${r.status==='Draft'?`<button onclick="setScriptRequestStatus('${r.id}','Sent')">Mark sent</button>`:''}${r.status==='Sent'?`<button onclick="setScriptRequestStatus('${r.id}','Received')">Mark received</button>`:''}${r.status==='Received'?`<button class="ghost" onclick="setScriptRequestStatus('${r.id}','Draft')">Reopen</button>`:''}</div></td><td><a class="linkbtn" href="/api/letter/${r.id}/pdf" target="_blank">Last Repeat / Owing PDF</a> <a class="linkbtn" href="/api/letter/${r.id}" target="_blank">Preview</a></td></tr>`).join('')}</tbody></table>` : empty('No script requests created yet.');
}
async function setScriptRequestStatus(id,status){await api(`/api/script-request/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});toast(`Request marked ${status}.`);await loadState();showView('scripts');}
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
  const items = Array.from(byMed.values()).sort((a,b)=>a.medicineName.localeCompare(b.medicineName)).map(it=>({...it,selected:shouldAutoSelectScript(it)}));
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
function renderRequestItems(){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const showOk = !!$('#showOkItems')?.checked;
  const option = (cur, val) => `<option value="${esc(val)}" ${cur===val?'selected':''}>${esc(val)}</option>`;
  const visible = items.map((it,i)=>({...it,_i:i})).filter(it => showOk || it.selected);
  $('#requestItems').innerHTML = visible.length ? visible.map(it=>{const repeats=repeatPosition(it.repeatsLeft);return `<div class="request-item professional ${it.selected?'':'ok-item'}"><input type="checkbox" data-i="${it._i}" ${it.selected?'checked':''} onchange="requestItemToggled(this)"><div class="med-cell"><b>${esc(it.medicineName)}</b><small>${esc(it.directions || 'No directions')} · ${esc(it.timing || it.source || '')}</small><small>Last dispense: <b>${esc(it.lastDispenseDate||'—')}</b> · Qty: <b>${esc(patientValue(it.lastDispenseQty))}</b> · Script: <b>${esc(it.scriptNumber||'—')}</b></small>${it.source?`<em>${esc(it.source)}</em>`:''}${it.owing||/^Script owing$/i.test(it.status||'')?badge('OWING — script required','danger'):''}${repeats!==null&&repeats<2?badge(`${repeats} repeat${repeats===1?'':'s'} left`,'warn'):''}${it.status==='Requested'?badge('Already requested','ok'):''}</div><label><span>Repeats left</span><input class="repeat-input" data-i="${it._i}" value="${esc(it.repeatsLeft ?? '')}" placeholder="0, 1, 2..." onchange="requestRepeatChanged(this)"></label><label><span>Status</span><select data-i="${it._i}" onchange="requestStatusChanged(this)">${option(it.status,'No script / negative balance')}${option(it.status,'Negative balance')}${option(it.status,'New script required')}${option(it.status,'Script owing')}${option(it.status,'Low repeats')}${option(it.status,'Manual request')}${option(it.status,'OK')}</select></label></div>`}).join('') : empty('No script has fewer than 2 repeats and no owing script was found. Use “Show all medicines” to add one manually.');
}
function tickAllRequestItems(on){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  items.forEach(it=>{it.selected=on?shouldAutoSelectScript(it):false;});
  $('#requestBuilder').dataset.items=JSON.stringify(items);
  renderRequestItems();
}
function requestItemToggled(input){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const item = items[Number(input.dataset.i)]; if(!item) return;
  item.selected=!!input.checked;
  if(item.selected && /^(OK|Requested)$/i.test(item.status||'')) item.status='Manual request';
  $('#requestBuilder').dataset.items=JSON.stringify(items);
  renderRequestItems();
}
function requestStatusChanged(select){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const item = items[Number(select.dataset.i)]; if(!item) return;
  item.status=select.value;
  item.owing=/^Script owing$/i.test(select.value);
  item.selected=!/^(OK|Requested)$/i.test(select.value);
  $('#requestBuilder').dataset.items=JSON.stringify(items);
  renderRequestItems();
}
function requestRepeatChanged(input){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const item = items[Number(input.dataset.i)]; if(!item) return;
  item.repeatsLeft=input.value.trim();
  const repeats=repeatPosition(item.repeatsLeft);
  if(!item.owing && repeats!==null){item.status=repeats<=0?'New script required':repeats<2?'Low repeats':'OK';}
  item.selected=shouldAutoSelectScript(item);
  $('#requestBuilder').dataset.items=JSON.stringify(items);
  renderRequestItems();
}
async function createScriptRequest(){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const selected=items.filter(item=>item.selected).map(item=>({ prescriptionId:item.prescriptionId, medicineName:item.medicineName, directions:item.directions||'', repeatsLeft:item.repeatsLeft??'', status:/^OK$/i.test(item.status||'')?'Manual request':item.status, scriptNumber:item.scriptNumber||'', lastDispenseDate:item.lastDispenseDate||'', lastDispenseQty:item.lastDispenseQty??'', owing:!!item.owing }));
  if(!selected.length) return toast('No actionable medicine selected. OK / sufficient-repeat medicines are not added to the GP letter.');
  const doctor=$('#requestDoctor'); const r = await api('/api/script-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patientId:selectedPatientId,items:selected,note:$('#requestNote').value,doctorId:doctor?.value||'',recipient:doctor?.selectedOptions?.[0]?.textContent||'GP / Prescriber'})});
  toast('Last Repeat / Owing PDF created.'); window.open(`/api/letter/${r.id}/pdf`,'_blank'); await loadState(); showView('scripts');
}

function specialBadge(o){
  const cls = /overdue|due today/i.test(o.computedStatus||'') ? 'danger' : /due soon|due this week|needs/i.test(o.computedStatus||'') ? 'warn' : /received|complete/i.test(o.status||'') ? 'ok' : 'blue';
  return `${badge(o.computedStatus||'Scheduled', cls)} ${/s8|vyvanse|targin|diazepam|panadeine|controlled/i.test(`${o.category} ${o.medicine}`)?badge('S8/Special','danger'):''} ${o.source?badge(o.source,'blue'):''}`;
}
function specialOrderCard(o, compact=false){
  const checked = !/received|complete|cancelled/i.test(o.status||'') && (o.daysToOrder===null || o.daysToOrder<=7) ? 'checked' : '';
  return `<div class="queue-card special-card ${compact?'compact':''}"><label class="select-line"><input type="checkbox" class="special-select" data-id="${esc(o.id)}" ${checked}></label><div><h3>${esc(o.patientFullName)}</h3><p><b>${esc(o.medicine)}</b>${o.strength?` · ${esc(o.strength)}`:''}</p><p>Source: ${esc(o.source||'—')} · Order due: <b>${esc(o.orderDueDisplay||'needs pickup')}</b> · Next pickup: ${esc(o.nextPickupDisplay||'—')}</p><div class="badges">${specialBadge(o)} ${badge(o.status||'Not ordered')}</div>${compact?'':`<small>${esc(o.notes||'')}</small>`}</div><div class="card-actions"><button class="ghost" onclick="editSpecialOrder('${o.id}')">Edit</button><button class="ghost" onclick="quickSpecialStatus('${o.id}','Ordered')">Ordered</button><button class="ghost" onclick="quickSpecialStatus('${o.id}','Received')">Received</button></div></div>`;
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
  const s8rx=(STATE.mypakPrescriptions||[]).filter(m=>/\b(s8|schedule\s*8|methylphenidate|ritalin|dexamfetamine|dexamphetamine|vyvanse|lisdexamfetamine|oxycodone|morphine|fentanyl|tapentadol|buprenorphine|targin)\b/i.test(`${m.schedule||''} ${m.medication||''}`)).filter(m=>{const q=($('#specialSearch')?.value||'').toLowerCase().trim();return !q||`${m.firstName||''} ${m.lastName||''} ${m.medication||''} ${m.drugCode||''}`.toLowerCase().includes(q)}).slice(0,80);
  $('#liveS8List').innerHTML=s8rx.length?s8rx.map(m=>{const p=(STATE.patientsComputed||[]).find(x=>String(x.mypakPatientId)===String(m.patientId));return `<div class="queue-card"><div><h3>${esc(`${m.firstName||''} ${m.lastName||''}`.trim()||p?.fullName)}</h3><p><b>${esc(m.medication)}</b> · balance ${esc(patientValue(m.balanceQty))} · repeats ${esc(patientValue(m.repeatsLeft))}</p><div class="badges">${badge('S8','danger')} ${Number(m.balanceQty)<0?badge('Negative balance','warn'):''}</div></div>${p?`<button onclick="buildRequestForPatient('${p.id}')">Request script</button>`:''}</div>`}).join(''):empty('No matching S8 medicine in the current MyPak sync.');
  $('#specialOrdersList').innerHTML = orders.length ? orders.map(o=>specialOrderCard(o)).join('') : empty('No special orders found. Add one manually or import/update patients first.');
  const patients=STATE.patientsComputed||[];
  $('#specialOrderForm').innerHTML = `<div class="field full"><label>Patient</label><select name="patientId" id="specialPatientSelect">${patients.map(p=>`<option value="${p.id}">${esc(p.fullName)}${p.mypakPatientId?' · MyPak':''}</option>`).join('')}</select></div><div class="field"><label>Medicine</label><input name="medicine" list="specialMedicineOptions" placeholder="Select or type medicine"><datalist id="specialMedicineOptions"></datalist></div>${fieldHTML('strength','Strength','text','')}${fieldHTML('directions','Dose / directions','text','')}${fieldHTML('source','Source','select:RDH|Hibiscus One|CP|NT|Patient/Carer|Other','RDH')}${fieldHTML('category','Category','select:Special Order|S8|S8/Special|External Supply|Patient Supplied','Special Order')}${fieldHTML('lastPickupDate','Last pickup date','date','')}${fieldHTML('cycleDays','Cycle days','number',STATE.settings.defaultCycleDays)}${fieldHTML('orderLeadDays','Order lead days before next pickup','number',STATE.settings.defaultSpecialOrderLeadDays||14)}${fieldHTML('status','Status','select:Needs confirmation|Not ordered|Order due|Request generated|Ordered|Received|Packed|Dispensed|Complete|Cancelled','Not ordered')}${fieldHTML('notes','Notes','textarea','')}<div class="field full"><button>Add special order</button></div>`;
  const patientSelect = $('#specialPatientSelect');
  const updateMedicineOptions = () => {
    const patient = patients.find(p => p.id === patientSelect?.value);
    const balances = (STATE.mypakMedicationBalances || []).filter(m => String(m.patientId) === String(patient?.mypakPatientId));
    $('#specialMedicineOptions').innerHTML = balances.map(m => `<option value="${esc(m.medication)}">${esc(m.drugCode || '')} · balance ${esc(patientValue(m.balanceQty))}</option>`).join('');
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
  form.dataset.editId=id; form.querySelector('button').textContent='Save special order';
}
async function quickSpecialStatus(id,status){ await api(`/api/special-orders/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); toast(`Special order marked ${status}.`); await loadState(); }
async function specialOrderSubmit(e){
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.currentTarget).entries());
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
}
async function markDoctor(id,status){ await api(`/api/doctor-updates/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})}); toast('Doctor update closed.'); await loadState(); }
function renderSettings(){
  const s=STATE.settings;
  const fields=[['defaultCycleDays','Default cycle days'],['defaultPackLeadDays','Pack lead days'],['defaultDispenseLeadDays','Dispense lead days'],['defaultOrderLeadDays','Order lead days'],['urgentWindowDays','Urgent window days'],['dueSoonWindowDays','Due soon window'],['scriptLowRepeatThreshold','Low repeat threshold'],['monthlyDays','Monthly cycle days']];
  $('#settingsForm').innerHTML=fields.map(([k,l])=>fieldHTML(k,l,'number',s[k])).join('')+`<div class="field full"><button>Save settings</button></div>`;
  $('#auditLog').innerHTML=(STATE.auditLog||[]).length?`<table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>${STATE.auditLog.slice(0,200).map(a=>`<tr><td>${esc((a.at||'').slice(0,19).replace('T',' '))}</td><td>${esc(a.action)}</td><td><code>${esc(JSON.stringify(a.details||{}))}</code></td></tr>`).join('')}</tbody></table>`:empty('No audit log yet.');
}
function showView(id){
  $$('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  $$('.view').forEach(v=>v.classList.toggle('active',v.id===id));
  const titles={dashboard:['Dashboard','Prioritise packing, dispensing, ordering and prescription requests by pickup risk.'],import:['Import Centre','Stage imports safely: detect HIND, link medicines, calculate scripts, review exceptions.'],patients:['Patients','Master list for Webster/Sachet cycle, pickup date and workflow flags.'],scripts:['Script Requests','Build GP letters from patient medicine/script data.'],special:['Special Orders / S8','RDH, Hibiscus One, CP/NT and controlled medicine ordering by due date.'],doctor:['Doctor Updates','Medication changes stay pending until reviewed.'],settings:['Settings & Audit','Configure lead times and track changes.']};
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
$('#savePatientBtn').addEventListener('click',savePatient);
$('#doctorForm').addEventListener('submit',doctorSubmit);
$('#specialOrderForm').addEventListener('submit',specialOrderSubmit);
$('#specialSearch').addEventListener('input',renderSpecialOrders); $('#specialFilter').addEventListener('change',renderSpecialOrders);
$('#specialTickDue').addEventListener('click',()=>setSpecialChecks('due')); $('#specialUntick').addEventListener('click',()=>setSpecialChecks('none')); $('#generateSpecialPdf').addEventListener('click',generateSpecialPdf);
$('#settingsForm').addEventListener('submit',settingsSubmit);
window.openPatient=openPatient; window.editPatient=editPatient; window.openDispensePatient=openDispensePatient; window.setDispenseStatus=setDispenseStatus; window.setScriptRequestStatus=setScriptRequestStatus; window.buildRequestForPatient=buildRequestForPatient; window.renderRequestItems=renderRequestItems; window.tickAllRequestItems=tickAllRequestItems; window.requestItemToggled=requestItemToggled; window.requestStatusChanged=requestStatusChanged; window.requestRepeatChanged=requestRepeatChanged; window.createScriptRequest=createScriptRequest; window.markDoctor=markDoctor; window.editSpecialOrder=editSpecialOrder; window.quickSpecialStatus=quickSpecialStatus;
window.addEventListener('focus', checkForAppUpdate);
document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) checkForAppUpdate(); });
setInterval(checkForAppUpdate, 60000);
checkForAppUpdate();
loadState().then(async()=>{await Promise.all([refreshMyPakStatus(),refreshMpsStatus()]);await syncMyPakPatients({silent:true});}).catch(e=>toast(e.message));
