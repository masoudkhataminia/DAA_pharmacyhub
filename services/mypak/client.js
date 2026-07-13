import { MyPakAuth } from './auth.js';
import { endpointPath, MYPAK_ENDPOINTS } from './endpoints.js';
import { MyPakError } from './errors.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class MyPakClient {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, auth, timeoutMs = 15000, retries = 2 } = {}) {
    this.env = env; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.retries = retries;
    this.baseUrl = String(env.MYPAK_BASE_URL || 'https://api.mypak.app/api').replace(/\/$/, '');
    this.auth = auth || new MyPakAuth({ env, fetchImpl, baseUrl: this.baseUrl });
    this.lastSuccessfulRequestAt = null;
  }
  isConfigured() { return this.auth.isConfigured(); }
  async request(name, { params, body, query } = {}) {
    const endpoint = MYPAK_ENDPOINTS[name];
    const path = endpointPath(name, params);
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const authorization = await this.auth.authorization();
        const queryString = query ? `?${new URLSearchParams(query).toString()}` : '';
        const response = await this.fetchImpl(`${this.baseUrl}${path}${queryString}`, {
          method: endpoint.method,
          headers: { accept: 'application/json', 'content-type': 'application/json;charset=UTF-8', authorization },
          body: endpoint.method === 'GET' ? undefined : JSON.stringify(body || {}),
          signal: controller.signal
        });
        const raw = await response.text();
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch { throw new MyPakError('MyPak returned invalid JSON', { temporary: response.status >= 500 }); }
        if (!response.ok) {
          if (response.status === 401 && attempt < this.retries && this.auth.canRefresh()) { await this.auth.refresh(); continue; }
          const temporary = response.status === 429 || response.status >= 500;
          throw new MyPakError(response.status === 401 || response.status === 403 ? 'MyPak authentication failed' : `MyPak request failed (${response.status})`, { status: response.status, temporary });
        }
        if (json?.isSuccess === false) throw new MyPakError(json.message || 'MyPak reported an unsuccessful request', { status: 502 });
        this.lastSuccessfulRequestAt = new Date().toISOString();
        return json;
      } catch (error) {
        const wrapped = error instanceof MyPakError ? error : new MyPakError(error?.name === 'AbortError' ? 'MyPak request timed out' : 'MyPak network request failed', { temporary: true });
        if (!wrapped.temporary || attempt === this.retries) throw wrapped;
        await delay(100 * (2 ** attempt));
      } finally { clearTimeout(timer); }
    }
  }
  listPatients(body) { return this.request('patientList', { body }); }
  listVirtualPillBalances(body) { return this.request('virtualPillBalances', { body }); }
  listQuickDispense(body) { return this.request('quickDispense', { body }); }
  listInsufficientPillBalances(body) { return this.request('insufficientPillBalances', { body }); }
  listDoctors() { return this.request('doctors', { query: { pageIndex: 1, pageSize: 99999, sortField: 'FirstName', sortOrder: 1 } }); }
  patientDetail(patientId) { return this.request('patientDetail', { params: { patientId } }); }
  listDispenseTracking(body) { return this.request('dispenseTracking', { body }); }
  reportOptions() { return this.request('patientReportOptions'); }
  patientGroup(groupId) { return this.request('patientGroup', { params: { groupId } }); }
  listPackJobs(body) { return this.request('packJobs', { body }); }
  packJobSummary(body) { return this.request('packJobSummary', { body }); }
  packJobChecking(jobId) { return this.request('packJobChecking', { params: { jobId } }); }
  packJobDistribution(jobId) { return this.request('packJobDistribution', { params: { jobId } }); }
  packJobCorrection(jobId) { return this.request('packJobCorrection', { params: { jobId } }); }
  packJobPdf(jobId) { return this.request('packJobPdf', { body: { ids: [jobId] } }); }
}
