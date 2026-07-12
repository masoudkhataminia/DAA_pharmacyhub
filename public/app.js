let STATE = null;
let selectedPatientId = null;
let editPatientId = null;

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = (text, cls='') => `<span class="badge ${cls}">${esc(text)}</span>`;
const toast = msg => { const t=$('#toast'); t.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'), 4200); };
const api = async (url, opts={}) => { const r = await fetch(url, opts); if (!r.ok) throw new Error((await r.json().catch(()=>({error:r.statusText}))).error || r.statusText); return r.json(); };

function statusClass(p){
  if(p.calculatedStatus==='Overdue' || p.calculatedStatus==='Due today') return 'danger';
  if(p.calculatedStatus==='Due soon' || p.calculatedStatus==='Due this week') return 'warn';
  return 'ok';
}
function patientBadges(p){
  return [badge(p.calculatedStatus||'Unknown', statusClass(p)), p.mypakPatientId?badge('MyPak live','mint'):'', p.patientGroup?badge(p.patientGroup,'blue'):'', p.s8Priority?badge('S8','danger'):'', p.patientSuppliedMeds?badge('Patient supplied','blue'):'', p.urgent?badge('Urgent','danger'):'', p.scriptRequestStatus && p.scriptRequestStatus!=='Not checked'?badge(p.scriptRequestStatus,'warn'):'' ].join('');
}
function queueCard(p, mode='pickup'){
  if(mode==='dispense' && p.medications) return `<div class="queue-card dispense-card"><div><h3>${esc(p.fullName)}</h3><p><b>${p.medications.length}</b> medicines need dispensing · lowest balance <b>${esc(p.worstBalance)}</b></p><div class="badges">${badge(p.status.replaceAll('_',' '),p.status==='confirmed'?'ok':p.status==='dispensed'?'blue':'danger')} ${p.patientGroup?badge(p.patientGroup,'mint'):''}</div></div><div class="card-actions"><button class="ghost" onclick="openDispensePatient('${p.key}','${p.patientId}')">Balances</button>${p.status==='needs_dispense'?`<button onclick="setDispenseStatus('${p.key}','dispensed')">Dispensed</button>`:p.status==='dispensed'?`<button onclick="setDispenseStatus('${p.key}','confirmed')">Confirm ✓</button>`:`<button class="ghost" onclick="setDispenseStatus('${p.key}','needs_dispense')">Reopen</button>`}</div></div>`;
  const due = mode==='pack'?`Pack due: ${p.packDueDisplay||'—'}`:mode==='dispense'?`Dispense due: ${p.dispenseDueDisplay||'—'}`:mode==='order'?`Order due: ${p.orderDueDisplay||'—'}`:`Pickup: ${p.nextPickupDisplay||'—'}`;
  return `<div class="queue-card"><div><h3>${esc(p.fullName)}</h3><p>${due} · cycle ${esc(p.cycleDays)} days · pickup ${esc(p.nextPickupDisplay||'not set')}</p><div class="badges">${patientBadges(p)}</div></div><button class="ghost" onclick="openPatient('${p.id}')">Open</button></div>`;
}
function renderKPIs(k){
  const labels = [['activePatients','Active'],['needsDispense','Needs dispense'],['overdue','Overdue'],['dueThisWeek','Due this week'],['s8Priority','S8'],['openDoctorUpdates','Doctor updates'],['scriptIssues','Script issues'],['specialOrdersDue','Special orders due']];
  $('#kpis').innerHTML = labels.map(([key,label])=>`<div class="kpi"><span>${label}</span><b>${k[key]??0}</b></div>`).join('');
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
    ['Patient group', p.patientGroup], ['Room', p.room], ['Facility / ward', p.facilityWard], ['Dispense code', p.dispenseCode],
    ['Distribution', p.distribution], ['DAA funding', p.daaFunding], ['MyPak status', p.mypakPatientStatus], ['Packing status', p.mypakPackingStatus],
    ['MyPak patient ID', p.mypakPatientId], ['External patient ID', p.mypakExternalPatientId || p.externalId],
    ['Vision impaired', p.mypakMetadata?.visionImpaired ? 'Yes' : 'No'], ['30-day dispensing', p.mypakMetadata?.days30Dispensing ? 'Yes' : 'No'],
    ['Last checked', p.mypakMetadata?.lastCheckedDate], ['Last MyPak sync', p.lastMyPakSyncAt ? new Date(p.lastMyPakSyncAt).toLocaleString() : '—']
  ];
  return `<h3>Patient information</h3><table><tbody>${fields.map(([label,value])=>`<tr><th>${esc(label)}</th><td>${esc(patientValue(value))}</td></tr>`).join('')}</tbody></table>`;
}
function myPakMedicationBalances(rows){
  return rows?.length ? `<table><thead><tr><th>Medication</th><th>Directions</th><th>Current balance</th><th>Required / week</th><th>Repeats</th><th>Script</th><th>Last update</th></tr></thead><tbody>${rows.map(m=>`<tr><td><b>${esc(m.medication||'—')}</b><br><small>${esc(m.drugCode||'')}</small></td><td>${esc(m.direction||'—')}</td><td>${esc(patientValue(m.balanceQty))}</td><td>${esc(patientValue(m.weeklyQty))}</td><td>${esc(patientValue(m.repeatsLeft))}</td><td>${m.newScriptNeeded===true?badge('New script needed','warn'):m.newScriptNeeded===false?badge('OK','ok'):'—'}</td><td>${esc(m.lastDispenseBalanceUpdated ? new Date(m.lastDispenseBalanceUpdated).toLocaleString() : '—')}</td></tr>`).join('')}</tbody></table>` : empty('No MyPak medication balance is available for this patient.');
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
    const progress = sync.running ? ` · ${sync.progress}% · page ${sync.currentPage}` : '';
    const error = connection.lastError || sync.lastError;
    $('#mypakSyncSummary').textContent = `Last sync: ${when} · Patients: ${connection.patientCount || 0}${progress}${error ? ` · Error: ${error}` : ''}`;
    $('#mypakSyncBtn').disabled = !connection.configured || sync.running;
  } catch (error) { $('#mypakConnection').textContent = 'Status unavailable'; $('#mypakSyncSummary').textContent = error.message; }
}
async function syncMyPakPatients(){
  $('#mypakSyncBtn').disabled = true;
  const poll = setInterval(refreshMyPakStatus, 750);
  try { await api('/api/mypak/sync/patients', { method: 'POST' }); toast('MyPak patient sync complete.'); await loadState(); }
  catch (error) { toast(error.message); }
  finally { clearInterval(poll); await refreshMyPakStatus(); }
}
function filteredPatients(){
  const q = ($('#patientSearch')?.value||'').toLowerCase();
  const f = $('#patientFilter')?.value||'all';
  if(q.trim().length < 2) return [];
  return (STATE.patientsComputed||[]).filter(p=>{
    if(q && !(`${p.fullName} ${p.phone} ${p.notes} ${p.patientGroup} ${p.externalId} ${p.dispenseCode}`.toLowerCase().includes(q))) return false;
    if(f==='due' && !(p.daysToPickup!==null && p.daysToPickup<=7)) return false;
    if(f==='s8' && !p.s8Priority) return false;
    if(f==='supplied' && !p.patientSuppliedMeds) return false;
    if(f==='script' && !/draft|sent|required|owing|low|needed/i.test(p.scriptRequestStatus||'')) return false;
    return true;
  }).slice(0,50);
}
function renderPatients(){
  const pts = filteredPatients();
  $('#patientTable').innerHTML = pts.length ? `<table><thead><tr><th>Name</th><th>Cycle</th><th>Last pickup</th><th>Next pickup</th><th>Pack</th><th>Dispense</th><th>Flags</th><th></th></tr></thead><tbody>${pts.map(p=>`<tr><td><button class="linkbtn" onclick="openPatient('${p.id}')">${esc(p.fullName)}</button><br><small>${esc(p.phone||'')}</small></td><td>${esc(p.cycleDays)} days</td><td>${esc(p.lastPickupDisplay||'—')}</td><td>${esc(p.nextPickupDisplay||'—')}<br><small>${esc(p.calculatedStatus)}</small></td><td>${esc(p.packStatus)}</td><td>${esc(p.dispenseStatus)}</td><td><div class="badges">${patientBadges(p)}</div></td><td><button class="ghost" onclick="editPatient('${p.id}')">Edit</button></td></tr>`).join('')}</tbody></table>` : empty(($('#patientSearch')?.value||'').trim().length<2?'Type at least 2 letters to search patients.':'No matching patients.');
}
async function openPatient(id){
  selectedPatientId = id;
  const d = await api(`/api/patients/${id}/details`);
  const p = d.patient;
  $('#patientDetails').classList.remove('hidden');
  $('#patientDetails').innerHTML = `<div class="panel-head"><h2>${esc(p.fullName)}</h2><span>${esc(p.calculatedStatus)} · Risk ${esc(p.riskScore)}</span></div><div class="two-col"><div><h3>Workflow</h3><p>Last pickup: <b>${esc(p.lastPickupDisplay||'not set')}</b><br>Next pickup: <b>${esc(p.nextPickupDisplay||'not set')}</b><br>Pack due: <b>${esc(p.packDueDisplay||'—')}</b><br>Dispense due: <b>${esc(p.dispenseDueDisplay||'—')}</b><br>Order due: <b>${esc(p.orderDueDisplay||'—')}</b></p><div class="badges">${patientBadges(p)}</div><p>${esc(p.notes||'')}</p><button onclick="editPatient('${p.id}')">Edit workflow</button></div><div>${patientDemographics(p)}</div></div><h3>MyPak medications & pill balance</h3>${myPakMedicationBalances(d.medicationBalances)}<h3>Imported medication list</h3>${d.medications.length?`<table><tbody>${d.medications.map(m=>`<tr><td>${esc(m.medicineName)}</td><td>${esc(m.directions)}</td></tr>`).join('')}</tbody></table>`:empty('No medications imported for this patient.')}<h3>Scripts</h3>${d.scripts.length?`<table><thead><tr><th>Drug</th><th>Repeats</th><th>Owing</th><th>Flag</th></tr></thead><tbody>${d.scripts.map(s=>`<tr><td>${esc(s.drugDescription)}</td><td>${esc(s.repeatsLeft)}</td><td>${s.owing?'Yes':'No'}</td><td>${badge(s.requestFlag, s.requestFlag==='OK'?'ok':'warn')}</td></tr>`).join('')}</tbody></table>`:empty('No scripts imported.')}`;
  showView('patients');
}
function editPatient(id){
  const p = STATE.patientsComputed.find(x=>x.id===id); if(!p) return;
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
  $('#recentRequests').innerHTML = (STATE.scriptRequests||[]).length ? `<table><thead><tr><th>Date</th><th>Patient</th><th>Items</th><th>Status</th><th>PDF</th><th>Preview</th></tr></thead><tbody>${STATE.scriptRequests.slice(0,80).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.patientFullName)}</td><td>${r.items.length}</td><td>${esc(r.status)}</td><td><a class="linkbtn" href="/api/letter/${r.id}/pdf" target="_blank">Open PDF</a></td><td><a class="linkbtn" href="/api/letter/${r.id}" target="_blank">HTML</a></td></tr>`).join('')}</tbody></table>` : empty('No script requests created yet.');
}
function renderScriptPatientSearch(){
  const box = $('#scriptPatientSearch');
  const q = (box?.value || '').toLowerCase().trim();
  const patients = STATE.patientsComputed || [];
  const results = q
    ? patients.filter(p => `${p.fullName} ${p.phone||''} ${p.externalId||''}`.toLowerCase().includes(q)).slice(0, 40)
    : patients.slice().sort((a,b)=>a.fullName.localeCompare(b.fullName)).slice(0, 25);
  $('#scriptPatientResults').innerHTML = results.length ? results.map(p=>`<div class="queue-card ${p.id===selectedPatientId?'selected-card':''}"><div><h3>${esc(p.fullName)}</h3><p>${esc(p.nextPickupDisplay||'pickup not set')} · cycle ${esc(p.cycleDays)} days</p><div class="badges">${patientBadges(p)}</div></div><button class="ghost" onclick="buildRequestForPatient('${p.id}')">Select</button></div>`).join('') : empty('No patient found. Check spelling or import List of Patients first.');
}
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
async function buildRequestForPatient(id){
  const d = await api(`/api/patients/${id}/details`); selectedPatientId=id;
  const byMed = new Map();
  const lowRepeatThreshold = Number(STATE.settings?.scriptLowRepeatThreshold ?? 1);
  for (const m of d.prescriptions || []) {
    const key = norm(m.medication); if(!key) continue;
    const negative = Number(m.balanceQty) < 0 || m.isInsufficientPillBalance;
    const noScript = Number(m.repeatsLeft) <= 0;
    byMed.set(key,{ prescriptionId:m.prescriptionId, medicineName:m.medication, directions:m.direction||'', timing:`Balance ${patientValue(m.balanceQty)} · weekly ${patientValue(m.weeklyQty)}`, repeatsLeft:m.repeatsLeft??'', status:m.requestStatus==='requested'?'Requested':negative&&noScript?'No script / negative balance':negative?'Negative balance':noScript?'New script required':'OK', source:'MyPak prescription', drugCode:m.drugCode||'' });
  }
  for (const m of d.medicationBalances || []) {
    const key = norm(m.medication);
    if (!key) continue;
    const repeats = m.repeatsLeft ?? '';
    const lowRepeats = repeats !== '' && Number.isFinite(Number(repeats)) && Number(repeats) <= lowRepeatThreshold;
    const status = m.newScriptNeeded === true ? 'New script required' : lowRepeats ? 'Low repeats' : 'OK';
    const balance = `MyPak balance ${patientValue(m.balanceQty)} · required/week ${patientValue(m.weeklyQty)}`;
    const existing = byMed.get(key);
    byMed.set(key, existing ? { ...existing, directions: existing.directions || m.direction || '', timing: balance, repeatsLeft: existing.repeatsLeft ?? repeats, status: /^(OK)$/i.test(existing.status) ? status : existing.status, source: 'MyPak prescription + balance' } : { medicineName: m.medication, directions: m.direction || '', timing: balance, repeatsLeft: repeats, status, source: 'MyPak live balance', drugCode: m.drugCode || '' });
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
    const key = norm(s.drugDescription);
    if (!key) continue;
    const existing = byMed.get(key) || { medicineName: s.drugDescription, directions: '', timing: '', source: 'Script list' };
    existing.repeatsLeft = s.repeatsLeft ?? '';
    existing.status = s.requestFlag || 'Manual request';
    existing.owing = !!s.owing;
    existing.scriptNumber = s.scriptNumber || '';
    existing.source = existing.source === 'Medication list' ? 'Medication + script' : 'Script list';
    byMed.set(key, existing);
  }
  const items = Array.from(byMed.values()).sort((a,b)=>a.medicineName.localeCompare(b.medicineName));
  const actionableCount = items.filter(it => !/^(OK|Requested)$/i.test(it.status)).length;
  const doctors = d.doctors || [];
  const option = (cur, val) => `<option value="${esc(val)}" ${cur===val?'selected':''}>${esc(val)}</option>`;
  $('#requestBuilder').innerHTML = items.length ? `<div class="builder-head"><div><h3>${esc(d.patient.fullName)}</h3><p class="muted">Search patient → review medicines → only non-OK / low-repeat / owing items go to the GP letter. Saved data stays after refresh/restart until a newer file is imported.</p></div><button class="ghost" onclick="openPatient('${d.patient.id}')">Open profile</button></div>
    <div class="request-summary"><b>${esc(actionableCount)}</b> medicines need action · <b>${esc(items.length-actionableCount)}</b> OK/sufficient-repeat medicines hidden from letter · MyPak balances included</div>
    <div class="request-actions"><button class="ghost" onclick="tickAllRequestItems(true)">Tick action items</button><button class="ghost" onclick="tickAllRequestItems(false)">Untick all</button><label class="inline-check"><input id="showOkItems" type="checkbox" onchange="renderRequestItems()"> Show OK medicines</label></div>
    <div id="requestItems" class="request-list"></div>
    <label class="field"><span>Prescriber</span><select id="requestDoctor"><option value="">GP / Prescriber</option>${doctors.map(x=>`<option value="${esc(x.doctorId)}">${esc(`${x.firstName||''} ${x.lastName||''}`.trim())}${x.email?` · ${esc(x.email)}`:''}</option>`).join('')}</select></label>
    <textarea id="requestNote" rows="3" placeholder="Optional note to doctor / GP"></textarea>
    <button onclick="createScriptRequest()">Generate PDF script request</button>` : empty('No medicines/scripts found for this patient. Import List of Scripts first, then try this search again.');
  $('#requestBuilder').dataset.items = JSON.stringify(items);
  if (items.length) renderRequestItems();
  renderScriptPatientSearch();
  showView('scripts');
}
function renderRequestItems(){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const showOk = !!$('#showOkItems')?.checked;
  const option = (cur, val) => `<option value="${esc(val)}" ${cur===val?'selected':''}>${esc(val)}</option>`;
  const visible = items.map((it,i)=>({...it,_i:i})).filter(it => showOk || !/^(OK|Requested)$/i.test(it.status));
  $('#requestItems').innerHTML = visible.length ? visible.map(it=>`<div class="request-item professional ${it.status==='OK'?'ok-item':''}"><input type="checkbox" data-i="${it._i}" ${!/^(OK|Requested)$/i.test(it.status)?'checked':''} ${/^(OK|Requested)$/i.test(it.status)?'disabled':''}><div class="med-cell"><b>${esc(it.medicineName)}</b><small>${esc(it.directions || 'No directions')} · ${esc(it.timing || it.source || '')}</small>${it.source?`<em>${esc(it.source)}</em>`:''}${it.status==='Requested'?badge('Requested','ok'):''}</div><label><span>Repeats left</span><input class="repeat-input" value="${esc(it.repeatsLeft ?? '')}" placeholder="0, 1, 2..."></label><label><span>Status</span><select>${option(it.status,'No script / negative balance')}${option(it.status,'Negative balance')}${option(it.status,'New script required')}${option(it.status,'Script owing')}${option(it.status,'Low repeats')}${option(it.status,'Manual request')}${option(it.status,'OK')}</select></label></div>`).join('') : empty('All medicines are OK or already requested.');
}
function tickAllRequestItems(on){
  $$('#requestItems input[type=checkbox]').forEach(x=>{ if(!x.disabled) x.checked=!!on; });
}
async function createScriptRequest(){
  const items = JSON.parse($('#requestBuilder').dataset.items||'[]');
  const selected=[];
  $$('#requestItems .request-item').forEach((row)=>{
    const cb = row.querySelector('input[type=checkbox]');
    const idx = Number(cb.dataset.i);
    const status = row.querySelector('select').value;
    if(cb.checked && status !== 'OK'){ selected.push({ prescriptionId:items[idx].prescriptionId, medicineName: items[idx].medicineName, directions: items[idx].directions || '', repeatsLeft: row.querySelector('.repeat-input').value, status }); }
  });
  if(!selected.length) return toast('No actionable medicine selected. OK / sufficient-repeat medicines are not added to the GP letter.');
  const doctor=$('#requestDoctor'); const r = await api('/api/script-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patientId:selectedPatientId,items:selected,note:$('#requestNote').value,doctorId:doctor?.value||'',recipient:doctor?.selectedOptions?.[0]?.textContent||'GP / Prescriber'})});
  toast('PDF script request created.'); window.open(`/api/letter/${r.id}/pdf`,'_blank'); await loadState(); showView('scripts');
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
  const a=STATE.prescriptionAutomation||{}; const f=$('#automationForm');
  if(f){ f.frequency.value=a.frequency||'manual'; f.intervalDays.value=a.intervalDays||14; f.nextRunDate.value=a.nextRunDate||''; f.recipients.value=a.recipients||''; f.subjectTemplate.value=a.subjectTemplate||''; f.bodyTemplate.value=a.bodyTemplate||''; f.enabled.checked=!!a.enabled; }
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
async function automationSubmit(e){ e.preventDefault(); const fd=new FormData(e.currentTarget); const body=Object.fromEntries(fd.entries()); body.enabled=fd.has('enabled'); await api('/api/prescription-automation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); toast('Prescription schedule and template saved.'); await loadState(); showView('settings'); }
function renderAll(){ renderDashboard(); renderImportReview(); renderPatients(); renderScriptPage(); renderSpecialOrders(); renderDoctor(); renderSettings(); }
async function loadState(){ STATE = await api('/api/state'); renderAll(); }

$$('.nav').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
$('#refreshBtn').addEventListener('click',loadState);
$('#mypakSyncBtn').addEventListener('click',syncMyPakPatients);
$('#mypakSyncBtnSettings').addEventListener('click',syncMyPakPatients);
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
$('#automationForm').addEventListener('submit',automationSubmit);
window.openPatient=openPatient; window.editPatient=editPatient; window.openDispensePatient=openDispensePatient; window.setDispenseStatus=setDispenseStatus; window.buildRequestForPatient=buildRequestForPatient; window.renderRequestItems=renderRequestItems; window.tickAllRequestItems=tickAllRequestItems; window.createScriptRequest=createScriptRequest; window.markDoctor=markDoctor; window.editSpecialOrder=editSpecialOrder; window.quickSpecialStatus=quickSpecialStatus;
loadState().then(refreshMyPakStatus).catch(e=>toast(e.message));
