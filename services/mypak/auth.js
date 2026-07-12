import { MyPakError } from './errors.js';

export class MyPakAuth {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, baseUrl = 'https://api.mypak.app/api' } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.token = '';
    this.refreshToken = '';
    this.staticTokenRejected = false;
  }
  hasCredentials() { return Boolean(this.env.MYPAK_USERNAME && this.env.MYPAK_PASSWORD); }
  isConfigured() { return Boolean(this.env.MYPAK_AUTHORIZATION || this.hasCredentials()); }
  canRefresh() { return Boolean(this.refreshToken || this.hasCredentials()); }
  async post(path, body) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json;charset=UTF-8' }, body: JSON.stringify(body)
    });
    const raw = await response.text();
    let json = {};
    try { json = raw ? JSON.parse(raw) : {}; } catch { throw new MyPakError('MyPak login returned invalid JSON', { status: 502 }); }
    if (!response.ok || !json.token) throw new MyPakError('MyPak authentication failed', { status: response.status || 401 });
    this.token = String(json.token);
    this.refreshToken = String(json.refreshToken || '');
    return this.token;
  }
  async login() {
    if (!this.hasCredentials()) throw new MyPakError('MyPak login credentials are not configured', { status: 503, code: 'NOT_CONFIGURED' });
    return this.post('/token', { username: this.env.MYPAK_USERNAME, password: this.env.MYPAK_PASSWORD });
  }
  async refresh() {
    this.staticTokenRejected = true;
    if (this.refreshToken) {
      try { return await this.post('/token/refreshtoken', { refreshToken: this.refreshToken }); }
      catch { this.token = ''; this.refreshToken = ''; }
    }
    return this.login();
  }
  async authorization() {
    if (this.token) return this.token;
    if (this.env.MYPAK_AUTHORIZATION && !this.staticTokenRejected) return this.env.MYPAK_AUTHORIZATION;
    if (this.hasCredentials()) return this.login();
    throw new MyPakError('MyPak authorization is not configured', { status: 503, code: 'NOT_CONFIGURED' });
  }
}
