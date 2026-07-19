import crypto from 'crypto';
import fs from 'fs';

const clean = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
export const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
export const base64Url = value => Buffer.from(value, 'utf8').toString('base64url');

const base64Lines = value => Buffer.from(value).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
const attachmentName = value => clean(value || 'attachment').replace(/["\\]/g, '').slice(0, 160) || 'attachment';

export function buildGmailMime({ to, subject, text, html, from, attachments = [] } = {}) {
  if (!validEmail(to)) throw new Error('A valid recipient email is required');
  const body = html || String(text || '');
  const files = (Array.isArray(attachments) ? attachments : []).filter(file => file?.content !== undefined && file?.content !== null);
  const boundary = `daa_${crypto.randomBytes(18).toString('hex')}`;
  const headers = [
    ...(from ? [`From: ${clean(from)}`] : []),
    `To: ${clean(to)}`,
    `Subject: ${clean(subject || 'Hibiscus Pharmacy special order reminder')}`,
    'MIME-Version: 1.0',
    ...(files.length
      ? [`Content-Type: multipart/mixed; boundary="${boundary}"`]
      : [`Content-Type: ${html ? 'text/html' : 'text/plain'}; charset="UTF-8"`, 'Content-Transfer-Encoding: 8bit'])
  ];
  if (!files.length) return `${headers.join('\r\n')}\r\n\r\n${body}`;
  const parts = [
    `--${boundary}`,
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: 8bit',
    '',
    body
  ];
  for (const file of files) {
    const filename = attachmentName(file.filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${clean(file.contentType || 'application/octet-stream')}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(file.content)
    );
  }
  parts.push(`--${boundary}--`, '');
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

export class GmailService {
  constructor({ clientId, clientSecret, redirectUri, tokenFile, encryptionKey, fetchImpl = fetch } = {}) {
    this.clientId = clean(clientId);
    this.clientSecret = clean(clientSecret);
    this.redirectUri = clean(redirectUri);
    this.tokenFile = tokenFile;
    this.encryptionKey = clean(encryptionKey);
    this.fetch = fetchImpl;
  }

  configured() { return Boolean(this.clientId && this.clientSecret && this.redirectUri && this.tokenFile && this.encryptionKey); }

  authorizationUrl(state) {
    if (!this.configured()) throw new Error('Gmail OAuth is not configured on the server');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/gmail.send',
      access_type: 'offline',
      prompt: 'select_account consent',
      include_granted_scopes: 'true',
      state
    }).toString();
    return url.toString();
  }

  key() { return crypto.createHash('sha256').update(this.encryptionKey).digest(); }

  writeTokens(tokens) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    const payload = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
    fs.writeFileSync(this.tokenFile, JSON.stringify(payload), { mode: 0o600 });
    fs.chmodSync(this.tokenFile, 0o600);
  }

  readTokens() {
    if (!this.configured() || !fs.existsSync(this.tokenFile)) return null;
    try {
      const payload = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch { return null; }
  }

  clear() { if (this.tokenFile && fs.existsSync(this.tokenFile)) fs.unlinkSync(this.tokenFile); }

  async tokenRequest(params) {
    const response = await this.fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(clean(data.error_description || data.error || 'Google OAuth token request failed'));
    return data;
  }

  async exchangeCode(code) {
    const data = await this.tokenRequest({ code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri, grant_type: 'authorization_code' });
    if (!data.refresh_token) throw new Error('Google did not return an offline refresh token. Reconnect and approve access again.');
    if (!data.access_token) throw new Error('Google did not return an access token. Please reconnect.');
    const profile = await this.accountProfile(data.access_token);
    const emailAddress = clean(profile.email || profile.emailAddress);
    if (!validEmail(emailAddress)) throw new Error('Google account email could not be verified. Please choose another account.');
    const tokens = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000, emailAddress };
    this.writeTokens(tokens);
    return tokens;
  }

  async accountProfile(accessToken) {
    const response = await this.fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(clean(data.error_description || data.error || 'Google account profile request failed'));
    return data;
  }

  async accessToken() {
    const tokens = this.readTokens();
    if (!tokens?.refreshToken) throw new Error('Gmail is not connected');
    if (tokens.accessToken && Number(tokens.expiresAt) > Date.now() + 60000) return tokens.accessToken;
    const data = await this.tokenRequest({ refresh_token: tokens.refreshToken, client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'refresh_token' });
    const updated = { ...tokens, accessToken: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
    this.writeTokens(updated);
    return updated.accessToken;
  }

  async googleRequest(url, options = {}) {
    const token = await this.accessToken();
    const response = await this.fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(clean(data.error?.message || data.error || 'Gmail API request failed'));
    return data;
  }

  async send({ to, subject, text, html, attachments } = {}) {
    const tokens = this.readTokens();
    const raw = base64Url(buildGmailMime({ to, subject, text, html, attachments, from: tokens?.emailAddress }));
    return this.googleRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
  }

  status() {
    const tokens = this.readTokens();
    return { configured: this.configured(), connected: Boolean(tokens?.refreshToken), emailAddress: clean(tokens?.emailAddress), redirectUri: this.redirectUri };
  }
}
