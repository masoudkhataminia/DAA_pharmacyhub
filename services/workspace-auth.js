import crypto from 'crypto';

const clean = value => String(value ?? '').trim().toLowerCase();

export function normalizeAccountEmail(value) {
  const email = clean(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

const signatureFor = (payload, secret) => crypto.createHmac('sha256', String(secret || '')).update(payload).digest('base64url');

export function workspaceSetupTokenMatches(expected, actual) {
  const expectedBytes = Buffer.from(String(expected || ''));
  const actualBytes = Buffer.from(String(actual || ''));
  return Boolean(expectedBytes.length && actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes));
}

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

export function createWorkspaceTransfer(ownerEmail, targetEmail, { now = Date.now(), ttlMs = 48 * 60 * 60 * 1000, token = crypto.randomBytes(32).toString('base64url') } = {}) {
  const owner = normalizeAccountEmail(ownerEmail);
  const target = normalizeAccountEmail(targetEmail);
  if (!owner || !target) throw new Error('Both workspace emails must be valid');
  if (owner === target) throw new Error('Choose a different Google account for the transfer');
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  return {
    token,
    transfer: {
      fromEmail: owner,
      targetEmail: target,
      tokenHash,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      verifiedAt: null
    }
  };
}

export function workspaceTransferTokenMatches(transfer, token, { now = Date.now() } = {}) {
  if (!transfer?.tokenHash || !token) return false;
  const expiresAt = Date.parse(transfer.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const actual = crypto.createHash('sha256').update(String(token)).digest('hex');
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(String(transfer.tokenHash));
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function workspaceTransferPublic(transfer, viewerEmail, { now = Date.now() } = {}) {
  if (!transfer) return null;
  const viewer = normalizeAccountEmail(viewerEmail);
  if (![normalizeAccountEmail(transfer.fromEmail), normalizeAccountEmail(transfer.targetEmail)].includes(viewer)) return null;
  return {
    fromEmail: normalizeAccountEmail(transfer.fromEmail),
    targetEmail: normalizeAccountEmail(transfer.targetEmail),
    createdAt: transfer.createdAt || null,
    expiresAt: transfer.expiresAt || null,
    expired: !Number.isFinite(Date.parse(transfer.expiresAt || '')) || Date.parse(transfer.expiresAt) <= now,
    verified: Boolean(transfer.verifiedAt),
    verifiedAt: transfer.verifiedAt || null
  };
}
