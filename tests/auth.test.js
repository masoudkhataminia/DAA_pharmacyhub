import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieValue, createWorkspaceSession, normalizeAccountEmail, verifyWorkspaceSession } from '../services/workspace-auth.js';

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

test('account email and cookie parsing are normalized safely', () => {
  assert.equal(normalizeAccountEmail(' Pharmacy@Example.COM '), 'pharmacy@example.com');
  assert.equal(normalizeAccountEmail('not-an-email'), '');
  assert.equal(cookieValue('a=1; daa_workspace_session=abc%2Edef; c=3', 'daa_workspace_session'), 'abc.def');
});
