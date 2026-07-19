import crypto from 'crypto';

const clean = value => String(value ?? '').trim().toLowerCase();

export function normalizeAccountEmail(value) {
  const email = clean(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

const signatureFor = (payload, secret) => crypto.createHmac('sha256', String(secret || '')).update(payload).digest('base64url');

export function createWorkspaceSession(email, secret, { now = Date.now(), ttlMs = 12 * 60 * 60 * 1000 } = {}) {
  const accountEmail = normalizeAccountEmail(email);
  if (!accountEmail) throw new Error('A valid Google account email is required');
  if (!String(secret || '')) throw new Error('APP_SESSION_SECRET is required');
  const payload = Buffer.from(JSON.stringify({ email: accountEmail, expiresAt: now + ttlMs }), 'utf8').toString('base64url');
  return `${payload}.${signatureFor(payload, secret)}`;
}

export function verifyWorkspaceSession(value, secret, { now = Date.now() } = {}) {
  try {
    const [payload, signature, extra] = String(value || '').split('.');
    if (!payload || !signature || extra || !String(secret || '')) return null;
    const expected = signatureFor(payload, secret);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const email = normalizeAccountEmail(decoded.email);
    const expiresAt = Number(decoded.expiresAt);
    if (!email || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
    return { email, expiresAt };
  } catch {
    return null;
  }
}

export function cookieValue(header, name) {
  const key = `${name}=`;
  for (const part of String(header || '').split(';')) {
    const item = part.trim();
    if (item.startsWith(key)) return decodeURIComponent(item.slice(key.length));
  }
  return '';
}
