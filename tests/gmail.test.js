import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GmailService, buildGmailMime, validEmail } from '../services/gmail.js';
process.env.NODE_ENV = 'test';
const { isS8Medication, specialOrderRecipients, shouldSendSpecialOrderEmail, processSpecialOrderEmailSchedules, scriptRequestPatientEmail, emailScriptRequestToPatient } = await import('../server.js');

test('Gmail MIME is header-safe and addressed to one recipient', () => {
  assert.equal(validEmail('doctor@example.com'), true);
  assert.equal(validEmail('not-an-email'), false);
  const mime = buildGmailMime({ to: 'doctor@example.com', subject: 'Reminder\r\nBcc: attacker@example.com', html: '<b>Medicine due</b>' });
  assert.match(mime, /To: doctor@example\.com/);
  assert.match(mime, /Subject: Reminder Bcc: attacker@example\.com/);
  assert.doesNotMatch(mime, /\r\nBcc:/);
});

test('Gmail MIME supports a PDF attachment without exposing raw binary data', () => {
  const mime = buildGmailMime({
    to: 'patient@example.com',
    subject: 'Prescription request',
    html: '<p>Your request is attached.</p>',
    attachments: [{ filename:'prescription-request.pdf', contentType:'application/pdf', content:Buffer.from('%PDF-test') }]
  });
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /Content-Disposition: attachment; filename="prescription-request\.pdf"/);
  assert.match(mime, /JVBERi10ZXN0/);
  assert.doesNotMatch(mime, /%PDF-test/);
});

test('Gmail tokens are encrypted at rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daa-gmail-'));
  const tokenFile = path.join(dir, 'token.json');
  const service = new GmailService({ clientId:'client', clientSecret:'secret', redirectUri:'https://example.com/callback', tokenFile, encryptionKey:'test-key' });
  service.writeTokens({ refreshToken:'private-refresh-token', emailAddress:'pharmacy@example.com' });
  const disk = fs.readFileSync(tokenFile, 'utf8');
  assert.doesNotMatch(disk, /private-refresh-token|pharmacy@example\.com/);
  assert.equal(service.readTokens().refreshToken, 'private-refresh-token');
  fs.rmSync(dir, { recursive:true, force:true });
});

test('special queue accepts S8 and explicit special orders only', () => {
  assert.equal(isS8Medication({ schedule:'S8', medicine:'Example' }), true);
  assert.equal(isS8Medication({ medicine:'Vyvanse 30mg' }), true);
  assert.equal(isS8Medication({ schedule:'S4', medicine:'Amlodipine' }), false);
});

test('scheduled recipients are valid, selected, unique emails', () => {
  const store = { settings:{ pharmacyEmail:'pharmacy@example.com' }, patients:[{ id:'p1', email:'patient@example.com' }] };
  const recipients = specialOrderRecipients({ patientId:'p1', sendToPatient:true, sendToDoctor:true, doctorEmail:'doctor@example.com', sendToPharmacy:true }, store);
  assert.deepEqual(recipients, ['patient@example.com','doctor@example.com','pharmacy@example.com']);
});

test('automatic special email is due only when enabled and open', () => {
  const now = new Date('2026-07-14T00:00:00Z');
  assert.equal(shouldSendSpecialOrderEmail({ emailAutomationEnabled:true, nextEmailAt:'2026-07-13T00:00:00Z', status:'Ordered' }, now), true);
  assert.equal(shouldSendSpecialOrderEmail({ emailAutomationEnabled:true, nextEmailAt:'2026-07-13T00:00:00Z', status:'Complete' }, now), false);
  assert.equal(shouldSendSpecialOrderEmail({ emailAutomationEnabled:false, nextEmailAt:'2026-07-13T00:00:00Z' }, now), false);
});

test('scheduler sends each due recipient separately and advances the interval', async () => {
  const now = new Date('2026-07-14T00:00:00Z'); const deliveries = [];
  const store = { settings:{ pharmacyEmail:'pharmacy@example.com', defaultCycleDays:14, defaultSpecialOrderLeadDays:14 }, patients:[{id:'p1',fullName:'Test Patient'}], specialOrders:[{ id:'o1', patientId:'p1', patientFullName:'Test Patient', medicine:'Vyvanse 30mg', category:'S8', status:'Ordered', active:true, emailAutomationEnabled:true, emailIntervalDays:10, nextEmailAt:'2026-07-13T00:00:00Z', sendToPatient:true, patientEmail:'patient@example.com', sendToPharmacy:true }], specialEmailLog:[], auditLog:[] };
  const gmail = { status:()=>({connected:true}), send:async message=>{deliveries.push(message);} };
  const result = await processSpecialOrderEmailSchedules({ gmail, now, read:()=>structuredClone(store), write:updated=>Object.assign(store,updated) });
  assert.equal(result.sent,1); assert.equal(deliveries.length,2); assert.deepEqual(deliveries.map(item=>item.to),['patient@example.com','pharmacy@example.com']);
  assert.equal(store.specialOrders[0].emailSendCount,1); assert.equal(store.specialOrders[0].nextEmailAt,'2026-07-24T00:00:00.000Z');
});

test('patient prescription email removes name tags and escapes clinical content', () => {
  const message = scriptRequestPatientEmail({
    patientFullName:'Masoud Khataminia (RDH)',
    note:'Review <carefully>',
    items:[{ medicineName:'Example <medicine>', repeatsLeft:0, status:'New script required' }]
  });
  assert.equal(message.subject, 'Prescription request - Masoud Khataminia');
  assert.match(message.html, /Hello Masoud Khataminia/);
  assert.doesNotMatch(message.html, /\(RDH\)|<carefully>|<medicine>/);
  assert.match(message.html, /Review &lt;carefully&gt;|Example &lt;medicine&gt;/);
});

test('confirmed patient email uses the connected Gmail sender and attaches the request PDF', async () => {
  const deliveries = [];
  const store = {
    patients:[{ id:'p1', fullName:'Masoud Khataminia (RDH)', email:'patient@example.com' }],
    scriptRequests:[{ id:'r1', patientId:'p1', patientFullName:'Masoud Khataminia (RDH)', items:[{ medicineName:'Example medicine', repeatsLeft:0, status:'New script required' }] }],
    auditLog:[]
  };
  const gmail = {
    status:()=>({ connected:true, emailAddress:'signed-in@example.com' }),
    send:async message=>deliveries.push(message)
  };
  const result = await emailScriptRequestToPatient('r1', {
    gmail,
    now:new Date('2026-07-18T01:02:03Z'),
    read:()=>structuredClone(store),
    write:updated=>Object.assign(store, updated),
    renderPdf:async()=>Buffer.from('%PDF-request')
  });
  assert.deepEqual(result, { ok:true, to:'patient@example.com', sender:'signed-in@example.com', sentAt:'2026-07-18T01:02:03.000Z' });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].to, 'patient@example.com');
  assert.equal(deliveries[0].attachments[0].contentType, 'application/pdf');
  assert.equal(deliveries[0].attachments[0].content.toString(), '%PDF-request');
  assert.equal(store.scriptRequests[0].patientEmailSender, 'signed-in@example.com');
  assert.equal(store.auditLog.at(-1).action, 'Emailed prescription request to patient');
});

test('patient prescription email is blocked when the patient has no valid email', async () => {
  const store = { patients:[{ id:'p1', email:'' }], scriptRequests:[{ id:'r1', patientId:'p1', patientFullName:'Test Patient', items:[] }], auditLog:[] };
  let sent = false;
  await assert.rejects(
    emailScriptRequestToPatient('r1', {
      gmail:{ status:()=>({connected:true}), send:async()=>{sent=true;} },
      read:()=>structuredClone(store),
      write:()=>{},
      renderPdf:async()=>Buffer.from('unused')
    }),
    /Patient email is missing or invalid/
  );
  assert.equal(sent, false);
});
