import { mergeMyPakPatients } from './mapper.js';

const initialStatus = () => ({ running: false, progress: 0, currentPage: 0, pagesCompleted: 0, recordsProcessed: 0, recordsAdded: 0, recordsUpdated: 0, recordsSkipped: 0, lastError: null, startedAt: null, finishedAt: null });

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
      const balances = [];
      for (let pageIndex = 1; pageIndex <= this.maxPages; pageIndex++) {
        const response = await this.client.listVirtualPillBalances({ pageIndex, pageSize: this.pageSize, patientIds: [], patientGroupIds: [], isShowPacked: true, sortField: 'PatientLastName', sortOrder: 1, packingStatus: ['0'] });
        const pageRows = Array.isArray(response.data) ? response.data : [];
        const balanceTotal = Number.isFinite(Number(response.total)) ? Number(response.total) : null;
        balances.push(...pageRows);
        if (!pageRows.length || (balanceTotal !== null && balances.length >= balanceTotal)) break;
        if (pageIndex === this.maxPages) throw new Error('MyPak pill balance pagination safety limit reached');
      }
      const prescriptions = [];
      const prescriptionPageSize = 50;
      const prescriptionMaxPages = Math.max(this.maxPages, 250);
      for (let pageIndex = 1; pageIndex <= prescriptionMaxPages; pageIndex++) {
        const response = await this.client.listQuickDispense({ pageIndex, pageSize: prescriptionPageSize, patientGroupIds: [], patientIds: [], qScriptFilters: [], packCycle: 1, packStartDate: new Date().toDateString(), sortField: 'LastName', sortOrder: 1 });
        const pageRows = Array.isArray(response.data) ? response.data : [];
        const prescriptionTotal = Number.isFinite(Number(response.total)) ? Number(response.total) : null;
        prescriptions.push(...pageRows);
        if (!pageRows.length || (prescriptionTotal !== null && prescriptions.length >= prescriptionTotal)) break;
        if (pageIndex === prescriptionMaxPages) throw new Error('MyPak prescription pagination safety limit reached');
      }
      const insufficientResponse = await this.client.listInsufficientPillBalances({ patientGroupIds: [], patientIds: [], qScriptFilters: [], packCycle: 1, packStartDate: new Date().toDateString() });
      const insufficient = new Map((Array.isArray(insufficientResponse.data) ? insufficientResponse.data : []).map(row => [String(row.prescriptionId), Boolean(row.isInsufficientPillBalance)]));
      const doctorsResponse = await this.client.listDoctors();
      const doctors = Array.isArray(doctorsResponse.data) ? doctorsResponse.data : [];
      const dispenseHistory = [];
      for (let pageIndex = 1; pageIndex <= this.maxPages; pageIndex++) {
        const response = await this.client.listDispenseTracking({ pageIndex, pageSize: this.pageSize, scriptType: 0, dateFrom: '', dateTo: '', dispenseScriptType: [], sortField: 'DateDispensed', sortOrder: -1 });
        const pageRows = Array.isArray(response.data) ? response.data : [];
        const dispenseTotal = Number.isFinite(Number(response.total)) ? Number(response.total) : null;
        dispenseHistory.push(...pageRows);
        if (!pageRows.length || (dispenseTotal !== null && dispenseHistory.length >= dispenseTotal)) break;
        if (pageIndex === this.maxPages) throw new Error('MyPak dispense history pagination safety limit reached');
      }
      const store = this.readStore(); const at = new Date().toISOString(); const stats = mergeMyPakPatients(store, rows, at);
      store.mypakMedicationBalances = [...new Map(balances.map(row => [String(row.vpBalanceId || `${row.patientId}:${row.drugCode || row.medication}`), row])).values()];
      store.mypakPrescriptions = [...new Map(prescriptions.map(row => [String(row.prescriptionId), { ...row, isInsufficientPillBalance: insufficient.get(String(row.prescriptionId)) || false }])).values()];
      store.mypakDoctors = [...new Map(doctors.map(row => [String(row.doctorId), row])).values()];
      store.mypakDispenseHistory = [...new Map(dispenseHistory.map(row => [String(row.scriptTrackingId), row])).values()];
      store.mypakSync = { lastSyncAt: at, lastSuccessAt: at, lastError: null, totalPatients: rows.length, totalMedicationBalances: store.mypakMedicationBalances.length, totalPrescriptions: store.mypakPrescriptions.length, totalDoctors: store.mypakDoctors.length, totalDispenseHistory: store.mypakDispenseHistory.length, status: 'success' };
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
      this.writeStore(store);
      this.status.running = false;
      return patientResult;
    } catch (error) {
      this.status.running = false; this.status.lastError = error.message; this.status.finishedAt = new Date().toISOString();
      throw error;
    }
  }
}
