import { MyPakError } from './errors.js';

export class MyPakAuth {
  constructor(env = process.env) { this.env = env; }
  isConfigured() { return Boolean(this.env.MYPAK_AUTHORIZATION); }
  async authorization() {
    if (this.env.MYPAK_AUTHORIZATION) return this.env.MYPAK_AUTHORIZATION;
    if (this.env.MYPAK_USERNAME && this.env.MYPAK_PASSWORD) {
      if (!this.env.MYPAK_LOGIN_URL) throw new MyPakError('MyPak login URL is not configured', { status: 503, code: 'NOT_CONFIGURED' });
      throw new MyPakError('Automatic MyPak login is not enabled until its endpoint is verified', { status: 503, code: 'LOGIN_UNVERIFIED' });
    }
    throw new MyPakError('MyPak authorization is not configured', { status: 503, code: 'NOT_CONFIGURED' });
  }
}
