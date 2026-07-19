import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieValue, createWorkspaceSession, createWorkspaceTransfer, normalizeAccountEmail, verifyWorkspaceSession, workspaceSetupTokenMatches, workspaceTransferPublic, workspaceTransferTokenMatches } from '../services/workspace-auth.js';

test('workspace session is signed, expires, and cannot be changed to another email', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  const token = createWorkspaceSession('Owner@Example.com', 'session-secret', { now, ttlMs: 1000 });
  assert.equal(verifyWorkspaceSession(token, 'session-secret', { now: now + 500 }).email, 'owner@example.com');
  assert.equal(verifyWorkspaceSession(token, 'wrong-secret', { now: now + 500 }), null);
  assert.equal(verifyWorkspaceSession(token, 'session-secret', { now: now + 1001 }), null);
  const [payload, signature] = token.split('.');
  const changedPayload = Buffer.from(JSON.stringify({ email:'attacker@example.com', expiresAt:now + 1000 })).toString('base64url');
  assert.equal(verifyWorkspaceSession(`${changedPayload}.${signature}`, 'session-secret', { now }), null);
  assert.notEqual(payload, changedPayload);
});

test('workspace transfer requires a different verified target and hides data from unrelated accounts', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  const { token, transfer } = createWorkspaceTransfer('old@example.com', 'new@example.com', { now, ttlMs: 1000, token:'one-time-token' });
  assert.equal(token, 'one-time-token');
  assert.equal(workspaceTransferTokenMatches(transfer, token, { now:now + 500 }), true);
  assert.equal(workspaceTransferTokenMatches(transfer, 'wrong', { now:now + 500 }), false);
  assert.equal(workspaceTransferTokenMatches(transfer, token, { now:now + 1001 }), false);
  assert.equal(workspaceTransferPublic(transfer, 'unrelated@example.com', { now }), null);
  assert.equal(workspaceTransferPublic(transfer, 'new@example.com', { now }).verified, false);
  assert.throws(() => createWorkspaceTransfer('same@example.com', 'SAME@example.com'), /different Google account/);
});

test('account email and cookie parsing are normalized safely', () => {
  assert.equal(normalizeAccountEmail(' Pharmacy@Example.COM '), 'pharmacy@example.com');
  assert.equal(normalizeAccountEmail('not-an-email'), '');
  assert.equal(cookieValue('a=1; daa_workspace_session=abc%2Edef; c=3', 'daa_workspace_session'), 'abc.def');
});

test('one-time workspace setup token uses an exact timing-safe match', () => {
  assert.equal(workspaceSetupTokenMatches('secure-owner-token', 'secure-owner-token'), true);
  assert.equal(workspaceSetupTokenMatches('secure-owner-token', 'wrong-token'), false);
  assert.equal(workspaceSetupTokenMatches('', ''), false);
});
