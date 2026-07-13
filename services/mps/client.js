import { endpointUrl, MPS_ENDPOINTS } from './endpoints.js';
import { MpsError } from './errors.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalizeToken = value => {
  const token = String(value || '').trim();
  if (!token) return '';
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
};

export class MpsClient {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000, retries = 2 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.baseUrl = String(env.MPS_BASE_URL || 'https://www.medisphere.mpsconnect.com.au').replace(/\/$/, '');
    this.authorizationValue = normalizeToken(env.MPS_BEARER_TOKEN || env.MPS_AUTHORIZATION);
    this.lastSuccessfulRequestAt = null;
  }

  isConfigured() { return Boolean(this.authorizationValue); }
  configureToken(token) { this.authorizationValue = normalizeToken(token); }
  clearToken() { this.authorizationValue = ''; }

  async request(name, { params, query } = {}) {
    const endpoint = MPS_ENDPOINTS[name];
    const path = endpointUrl(name, { params, query });
    if (endpoint.auth !== false && !this.authorizationValue) {
      throw new MpsError('MPS bearer token is not configured', { status: 401, code: 'MPS_NOT_CONFIGURED' });
    }

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = { accept: endpoint.response === 'text' ? 'text/plain, */*' : 'application/json' };
        if (endpoint.auth !== false) headers.authorization = this.authorizationValue;
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: endpoint.method, headers, signal: controller.signal });
        const raw = await response.text();
        if (!response.ok) {
          const temporary = response.status === 429 || response.status >= 500;
          const message = response.status === 401 || response.status === 403
            ? 'MPS authentication failed'
            : `MPS request failed (${response.status})`;
          throw new MpsError(message, { status: response.status, temporary });
        }
        this.lastSuccessfulRequestAt = new Date().toISOString();
        if (endpoint.response === 'text') return raw;
        if (!raw) return {};
        try { return JSON.parse(raw); }
        catch { throw new MpsError('MPS returned invalid JSON', { temporary: false }); }
      } catch (error) {
        const wrapped = error instanceof MpsError
          ? error
          : new MpsError(error?.name === 'AbortError' ? 'MPS request timed out' : 'MPS network request failed', { temporary: true });
        if (!wrapped.temporary || attempt === this.retries) throw wrapped;
        await delay(150 * (2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  health() { return this.request('health'); }
  currentUser() { return this.request('currentUser'); }
  listFacilityGroups() { return this.request('facilityGroups'); }
  listFacilities() { return this.request('facilities'); }
  facilityGroupConfiguration(facilityGroupId) { return this.request('facilityGroupConfiguration', { params: { facilityGroupId } }); }
  listPatients(query) { return this.request('patients', { query }); }
  patientMhr(facilityGroupId, patientId) { return this.request('patientMhr', { params: { facilityGroupId, patientId } }); }
  listPatientMovements(query) { return this.request('patientMovements', { query }); }
  medicationChart(patientId) { return this.request('medicationChart', { query: { patientId } }); }
  listDrugs(query) { return this.request('drugs', { query }); }
  listDrugForms(query) { return this.request('drugForms', { query }); }
  listDrugCategories(etag) { return this.request('drugCategories', { query: { etag } }); }
  listOrders(query) { return this.request('orders', { query }); }
  listPackedDays(query) { return this.request('packedDays', { query }); }
  listPackedPrn(query) { return this.request('packedPrn', { query }); }
  medicationChangesReport(query) { return this.request('medicationChangesReport', { query }); }
}
