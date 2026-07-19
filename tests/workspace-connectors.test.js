import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { gmailForEmail, mpsForEmail, mypakForEmail } = await import('../server.js');

test('live connector credentials and token files are isolated by Google account', () => {
  const firstEmail = 'connector-one@example.com';
  const secondEmail = 'connector-two@example.com';
  const firstMyPak = mypakForEmail(firstEmail);
  const secondMyPak = mypakForEmail(secondEmail);
  firstMyPak.client.configureCredentials('first-user', 'first-password');
  assert.equal(firstMyPak.client.isConfigured(), true);
  assert.equal(secondMyPak.client.isConfigured(), false);
  assert.equal(mypakForEmail(firstEmail).client, firstMyPak.client);
  firstMyPak.client.disconnect();

  const firstMps = mpsForEmail(firstEmail);
  const secondMps = mpsForEmail(secondEmail);
  firstMps.client.configureToken('first-token');
  assert.equal(firstMps.client.isConfigured(), true);
  assert.equal(secondMps.client.isConfigured(), false);
  firstMps.client.clearToken();

  const firstGmail = gmailForEmail(firstEmail);
  const secondGmail = gmailForEmail(secondEmail);
  assert.notEqual(firstGmail.tokenFile, secondGmail.tokenFile);
  assert.doesNotMatch(firstGmail.tokenFile, /connector-one@example\.com/);
  assert.doesNotMatch(secondGmail.tokenFile, /connector-two@example\.com/);
});
