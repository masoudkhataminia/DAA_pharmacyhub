import { MpsError } from './errors.js';
import { mergeMpsPatients } from './mapper.js';

const initialStatus = () => ({ running: false, operation: null, progress: 0, currentPage: 0, pagesCompleted: 0, recordsProcessed: 0, recordsAdded: 0, recordsUpdated: 0, recordsSkipped: 0, lastError: null, startedAt: null, finishedAt: null });
const rowsOf = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
const identifier = value => String(value?.hsId ?? value?.facilityGroupId ?? value?.id ?? '').trim();
const isoDay = date => date.toISOString().slice(0, 10);
const uniqueBy = (rows, key) => [...new Map(rows.map(row => [String(row?.[key] ?? JSON.stringify(row)), row])).values()];

export async function fetchAllByChangeNumber(fetchPage, { pageSize = 200, maxPages = 100, cursorName = 'changeNumber', status } = {}) {
  const rows = [];
  let cursor = 0;
  for (let page = 1; page <= maxPages; page++) {
    if (status) status.currentPage = page;
    const pageRows = rowsOf(await fetchPage(cursor, pageSize));
    rows.push(...pageRows);
    if (status) { status.pagesCompleted++; status.recordsProcessed += pageRows.length; }
    if (pageRows.length < pageSize) return rows;
    const next = Number(pageRows.at(-1)?.[cursorName]);
    if (!Number.isFinite(next) || next <= cursor) throw new MpsError(`MPS ${cursorName} pagination did not advance`, { status: 502 });
    cursor = next;
  }
  throw new MpsError('MPS pagination safety limit reached', { status: 502 });
}

export class MpsSyncService {
  constructor({ client, readStore, writeStore, pageSize = 200, maxPages = 100 } = {}) {
    this.client = client;
    this.readStore = readStore;
    this.writeStore = writeStore;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.status = initialStatus();
  }

  getStatus() { return { ...this.status }; }
  begin(operation) {
    if (this.status.running) return false;
    this.status = { ...initialStatus(), running: true, operation, startedAt: new Date().toISOString() };
    return true;
  }
  fail(error) {
    const at = new Date().toISOString();
    this.status = { ...this.status, running: false, lastError: error.message, finishedAt: at };
    try {
      const store = this.readStore();
      store.mpsSync = { ...(store.mpsSync || {}), lastError: error.message, status: 'error' };
      this.writeStore(store);
    } catch {}
  }
  finish(extra = {}) {
    const at = new Date().toISOString();
    this.status = { ...this.status, ...extra, running: false, progress: 100, finishedAt: at };
    return at;
  }
  async facilityContext() {
    const [groupResponse, facilityResponse] = await Promise.all([this.client.listFacilityGroups(), this.client.listFacilities()]);
    const groups = rowsOf(groupResponse);
    const facilities = rowsOf(facilityResponse);
    if (!groups.length) throw new MpsError('MPS returned no accessible facility groups', { status: 403 });
    return { groups, facilities };
  }

  async syncPatients() {
    if (!this.begin('patients')) return { started: false, status: this.getStatus() };
    try {
      const { groups, facilities } = await this.facilityContext();
      const rows = [];
      for (const group of groups) {
        const facilityGroupId = identifier(group);
        if (!facilityGroupId) continue;
        const groupRows = await fetchAllByChangeNumber(
          (changeNumber, pageSize) => this.client.listPatients({ facilityGroupId, changeNumber, pageSize }),
          { pageSize: this.pageSize, maxPages: this.maxPages, status: this.status }
        );
        rows.push(...groupRows);
      }
      const patients = uniqueBy(rows, 'hsId');
      const store = this.readStore();
      const at = new Date().toISOString();
      const stats = mergeMpsPatients(store, patients, facilities, at);
      store.mpsFacilityGroups = groups;
      store.mpsFacilities = facilities;
      store.mpsSync = { ...(store.mpsSync || {}), lastPatientSyncAt: at, lastSuccessAt: at, lastError: null, totalPatients: patients.length, status: 'success' };
      this.writeStore(store);
      this.finish(stats);
      return { started: true, total: patients.length, status: this.getStatus() };
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async syncMedicationData({ days = 7 } = {}) {
    if (!this.begin('medications')) return { started: false, status: this.getStatus() };
    const boundedDays = Math.min(31, Math.max(1, Number(days) || 7));
    try {
      const { groups, facilities } = await this.facilityContext();
      const drugs = await fetchAllByChangeNumber(
        (changeNumber, pageSize) => this.client.listDrugs({ changeNumber, pageSize }),
        { pageSize: this.pageSize, maxPages: this.maxPages, status: this.status }
      );
      const drugForms = await fetchAllByChangeNumber(
        (changeNumber, pageSize) => this.client.listDrugForms({ changeNumber, pageSize }),
        { pageSize: this.pageSize, maxPages: this.maxPages, status: this.status }
      );
      const start = new Date(); start.setUTCDate(start.getUTCDate() - boundedDays);
      const end = new Date(); end.setUTCDate(end.getUTCDate() + 1);
      const orders = []; const packedDays = []; const packedPrn = [];
      for (const group of groups) {
        const facilityGroupId = identifier(group);
        if (!facilityGroupId) continue;
        orders.push(...await fetchAllByChangeNumber(
          (changeNumber, pageSize) => this.client.listOrders({ facilityGroupId, changeNumber, pageSize }),
          { pageSize: this.pageSize, maxPages: this.maxPages, status: this.status }
        ));
        packedDays.push(...await fetchAllByChangeNumber(
          (sinceChangeNumber, pageSize) => this.client.listPackedDays({ sinceChangeNumber, facilityGroupId, pageSize, startDate: isoDay(start), endDate: isoDay(end) }),
          { pageSize: Math.min(300, this.pageSize), maxPages: this.maxPages, cursorName: 'changeNumber', status: this.status }
        ));
        packedPrn.push(...await fetchAllByChangeNumber(
          (sinceChangeNumber, pageSize) => this.client.listPackedPrn({ sinceChangeNumber, facilityGroupId, pageSize }),
          { pageSize: this.pageSize, maxPages: this.maxPages, cursorName: 'changeNumber', status: this.status }
        ));
      }
      const at = new Date().toISOString();
      const store = this.readStore();
      store.mpsFacilityGroups = groups;
      store.mpsFacilities = facilities;
      store.mpsDrugs = uniqueBy(drugs, 'hsId');
      store.mpsDrugForms = uniqueBy(drugForms, 'hsId');
      store.mpsOrders = uniqueBy(orders, 'hsId');
      store.mpsPackedDays = uniqueBy(packedDays, 'changeNumber');
      store.mpsPackedPrn = uniqueBy(packedPrn, 'changeNumber');
      store.mpsSync = { ...(store.mpsSync || {}), lastMedicationSyncAt: at, lastSuccessAt: at, lastError: null, totalDrugs: store.mpsDrugs.length, totalOrders: store.mpsOrders.length, totalPackedDays: store.mpsPackedDays.length, totalPackedPrn: store.mpsPackedPrn.length, medicationDays: boundedDays, status: 'success' };
      this.writeStore(store);
      this.finish({ recordsAdded: drugs.length + orders.length + packedDays.length + packedPrn.length });
      return { started: true, days: boundedDays, drugs: store.mpsDrugs.length, orders: store.mpsOrders.length, packedDays: store.mpsPackedDays.length, packedPrn: store.mpsPackedPrn.length, status: this.getStatus() };
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
}
