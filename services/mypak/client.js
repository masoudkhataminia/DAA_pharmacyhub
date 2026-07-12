import { MyPakAuth } from './auth.js';
import { endpointPath, MYPAK_ENDPOINTS } from './endpoints.js';
import { MyPakError } from './errors.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class MyPakClient {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, auth = new MyPakAuth(env), timeoutMs = 15000, retries = 2 } = {}) {
    this.env = env; this.fetchImpl = fetchImpl; this.auth = auth; this.timeoutMs = timeoutMs; this.retries = retries;
    this.baseUrl = String(env.MYPAK_BASE_URL || 'https://api.mypak.app/api').replace(/\/$/, '');
    this.lastSuccessfulRequestAt = null;
  }
  isConfigured() { return this.auth.isConfigured(); }
  async request(name, { params, body } = {}) {
    const endpoint = MYPAK_ENDPOINTS[name];
    const path = endpointPath(name, params);
    const authorization = await this.auth.authorization();
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: endpoint.method,
          headers: { accept: 'application/json', 'content-type': 'application/json;charset=UTF-8', authorization },
          body: endpoint.method === 'GET' ? undefined : JSON.stringify(body || {}),
          signal: controller.signal
        });
        const raw = await response.text();
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch { throw new MyPakError('MyPak returned invalid JSON', { temporary: response.status >= 500 }); }
        if (!response.ok) {
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
  reportOptions() { return this.request('patientReportOptions'); }
  patientGroup(groupId) { return this.request('patientGroup', { params: { groupId } }); }
}
