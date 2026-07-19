import { mergeMyPakPatients, normalizeMyPakMedicationBalance } from './mapper.js';
import { mergePackJobs, packRows } from './packs.js';

const initialStatus = () => ({ running: false, progress: 0, currentPage: 0, pagesCompleted: 0, recordsProcessed: 0, recordsAdded: 0, recordsUpdated: 0, recordsSkipped: 0, lastError: null, startedAt: null, finishedAt: null });

async function collectPaged(fetchPage, { pageSize, maxPages, label, concurrency = 4 }) {
  const first = await fetchPage(1); const rows = Array.isArray(first.data) ? [...first.data] : [];
  const total = Number.isFinite(Number(first.total)) ? Number(first.total) : null;
  if (total !== null) {
    const pageCount = Math.ceil(total / pageSize);
    if (pageCount > maxPages) throw new Error(`${label} pagination safety limit reached`);
    for (let start = 2; start <= pageCount; start += concurrency) {
      const pages = Array.from({ length: Math.min(concurrency, pageCount - start + 1) }, (_, index) => start + index);
      const responses = await Promise.all(pages.map(fetchPage));
      responses.forEach(response => rows.push(...(Array.isArray(response.data) ? response.data : [])));
    }
    return rows.slice(0, total);
  }
  for (let page = 2; page <= maxPages && rows.length; page++) {
    const response = await fetchPage(page); const pageRows = Array.isArray(response.data) ? response.data : [];
    rows.push(...pageRows); if (pageRows.length < pageSize) break;
    if (page === maxPages) throw new Error(`${label} pagination safety limit reached`);
  }
  return rows;
}

export class MyPakSyncService {
  constructor({ client, readStore, writeStore, pageSize = 200, maxPages = 100 } = {}) { this.client = client; this.readStore = readStore; this.writeStore = writeStore; this.pageSize = pageSize; this.maxPages = maxPages; this.status = initialStatus(); }
  getStatus() { return { ...this.status }; }
  async syncPatients() {
    if (this.status.running) return { started: false, status: this.getStatus() };
    this.status = { ...initialStatus(), running: true, startedAt: new Date().toISOString() };
    try {
      const rows = []; let total = null;
      for (let pageIndex = 1; pageIndex <= this.maxPages; pageIndex++) {
        this.status.currentPage = pageIndex;
        const response = await this.client.listPatients({ pageIndex, pageSize: this.pageSize, packingStatus: [0, 1, 3], sortField: 'LastName', sortOrder: 1 });
        const pageRows = Array.isArray(response.data) ? response.data : [];
        total = Number.isFinite(Number(response.total)) ? Number(response.total) : total;
        rows.push(...pageRows); this.status.pagesCompleted = pageIndex; this.status.recordsProcessed = rows.length;
        this.status.progress = total ? Math.min(99, Math.round(rows.length / total * 100)) : 0;
        if (!pageRows.length || (total !== null && rows.length >= total)) break;
        if (pageIndex === this.maxPages) throw new Error('MyPak pagination safety limit reached');
      }
      const balances = await collectPaged(pageIndex => this.client.listVirtualPillBalances({ pageIndex, pageSize: this.pageSize, patientIds: [], patientGroupIds: [], isShowPacked: true, sortField: 'PatientLastName', sortOrder: 1, packingStatus: ['0'] }), { pageSize: this.pageSize, maxPages: this.maxPages, label: 'MyPak pill balance' });
      const quickDispense = await collectPaged(pageIndex => this.client.listQuickDispense({ pageIndex, pageSize: this.pageSize, patientIds: [], patientGroupIds: [], sortField: 'PatientLastName', sortOrder: 1 }), { pageSize: this.pageSize, maxPages: this.maxPages, label: 'MyPak prescriptions' });
      const insufficientResponse = await this.client.listInsufficientPillBalances({ patientGroupIds: [], patientIds: [], qScriptFilters: [], packCycle: 1, packStartDate: new Date().toDateString() });
      const insufficient = new Map((Array.isArray(insufficientResponse.data) ? insufficientResponse.data : []).map(row => [String(row.prescriptionId), Boolean(row.isInsufficientPillBalance)]));
      const doctorsResponse = await this.client.listDoctors();
      const doctors = Array.isArray(doctorsResponse.data) ? doctorsResponse.data : [];
      const today = new Date(); const from = new Date(today); from.setDate(from.getDate() - 90);
      const dispenseHistory = await collectPaged(pageIndex => this.client.listDispenseTracking({ pageIndex, pageSize: this.pageSize, scriptType: 0, dateFrom: from.toISOString(), dateTo: today.toISOString(), dispenseScriptType: [], sortField: 'DateDispensed', sortOrder: -1 }), { pageSize: this.pageSize, maxPages: 50, label: 'MyPak dispense history' });
      const createdDateTo = new Date(); const createdDateFrom = new Date(createdDateTo); createdDateFrom.setDate(createdDateFrom.getDate() - 120);
      const packSummaryResponse = await this.client.packJobSummary({ pageIndex: 1, pageSize: 99999, createdDateFrom: createdDateFrom.toISOString(), createdDateTo: createdDateTo.toISOString() });
      const packSummary = packSummaryResponse.data || {};
      const totalPackJobs = ['printingCount','packingCount','correctionCount','checkingCount','distributionCount','failedCount','completeCount'].reduce((sum, name) => sum + Number(packSummary[name] || 0), 0);
      const store = this.readStore(); const at = new Date().toISOString(); const stats = mergeMyPakPatients(store, rows, at);
      store.mypakMedicationBalances = [...new Map(balances.map(rawRow => {
        const row = normalizeMyPakMedicationBalance(rawRow);
        return [String(row.vpBalanceId || `${row.patientId}:${row.drugCode || row.medication}`), row];
      })).values()];
      store.mypakPrescriptions = [...new Map([...store.mypakMedicationBalances, ...quickDispense].map(rawRow => {
        const row = normalizeMyPakMedicationBalance(rawRow);
        const prescriptionId = row.prescriptionId || row.vpBalanceId || `${row.patientId}:${row.drugCode || row.medication}`;
        return [String(prescriptionId), { ...row, prescriptionId, lastDispenseDate: row.lastDispenseDate || row.lastDispenseBalanceUpdated || '', isInsufficientPillBalance: insufficient.get(String(prescriptionId)) || Number(row.balanceQty) < 0 }];
      })).values()];
      store.mypakDoctors = [...new Map(doctors.map(row => [String(row.doctorId), row])).values()];
      store.mypakDispenseHistory = [...new Map(dispenseHistory.map(row => [String(row.scriptTrackingId), row])).values()];
      store.mypakPackSummary = packSummary;
      store.mypakSync = { lastSyncAt: at, lastSuccessAt: at, lastError: null, totalPatients: rows.length, totalMedicationBalances: store.mypakMedicationBalances.length, totalPrescriptions: store.mypakPrescriptions.length, totalDoctors: store.mypakDoctors.length, totalDispenseHistory: store.mypakDispenseHistory.length, totalPackJobs, status: 'success' };
      this.writeStore(store); Object.assign(this.status, stats, { running: false, progress: 100, finishedAt: at });
      return { started: true, status: this.getStatus() };
    } catch (error) {
      const at = new Date().toISOString(); this.status = { ...this.status, running: false, lastError: error.message, finishedAt: at };
      try { const store = this.readStore(); store.mypakSync = { ...(store.mypakSync || {}), lastSyncAt: at, lastError: error.message, status: 'error' }; this.writeStore(store); } catch {}
      throw error;
    }
  }
  async syncAll() {
    if (this.status.running) return { started: false, status: this.getStatus() };
    const patientResult = await this.syncPatients();
    this.status.running = true;
    try {
      const store = this.readStore();
      store.mypakReportOptions = await this.client.reportOptions();
      const groupIds = [...new Set(store.patients.map(p => p.mypakPatientGroupId).filter(Boolean))];
      const groups = [];
      for (const groupId of groupIds) groups.push(await this.client.patientGroup(groupId));
      store.mypakGroups = groups;
      const createdDateTo = new Date(); const createdDateFrom = new Date(createdDateTo); createdDateFrom.setFullYear(createdDateFrom.getFullYear() - 1);
      const packJobs = await collectPaged(pageIndex => this.client.listPackJobs({ pageIndex, pageSize: this.pageSize, status: ['0','1','2','3','4','5','6','7'], patientIds: [], patientGroupIds: [], createdDateFrom: createdDateFrom.toISOString(), createdDateTo: createdDateTo.toISOString(), sortField: 'CreatedDate', sortOrder: -1 }), { pageSize: this.pageSize, maxPages: this.maxPages, label: 'MyPak pack jobs' });
      store.mypakPackJobs = mergePackJobs(store.mypakPackJobs, packRows({ data: packJobs }));
      store.mypakSync = { ...(store.mypakSync || {}), totalGroups: groups.length, totalPackJobs: store.mypakPackJobs.length, fullSyncAt: new Date().toISOString(), status: 'success' };
      this.writeStore(store);
      this.status.running = false;
      return { ...patientResult, fullSync: true, groups: groups.length, packJobs: store.mypakPackJobs.length };
    } catch (error) {
      this.status.running = false; this.status.lastError = error.message; this.status.finishedAt = new Date().toISOString();
      try { const store = this.readStore(); store.mypakSync = { ...(store.mypakSync || {}), lastError: error.message, status: 'error' }; this.writeStore(store); } catch {}
      throw error;
    }
  }
}
