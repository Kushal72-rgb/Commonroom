const test = require('node:test');
const assert = require('node:assert/strict');
const workflow = require('../workflow.js');

const fresh = status => ({
  requests: [], incidents: [], audit: [],
  request: { id: 'req-1', user: 'Aarav Kumar', resource: 'laser', status, step: status.toLowerCase() }
});
const time = '2026-10-31T10:00:00.000Z';

test('escapes user-provided HTML and rejects whitespace-only values', () => {
  assert.equal(workflow.escapeHtml(`<img src=x onerror="alert('x')">`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;');
  assert.equal(workflow.hasText(' \t\n '), false);
  assert.equal(workflow.hasText('  drawing a prototype  '), true);
});

test('renders Restore only for archived resources and escapes the resource ID', () => {
  const archived = workflow.resourceStatusAction('archived', '"><img src=x>');
  assert.match(archived, /data-restore=/);
  assert.match(archived, />Restore<\/button>/);
  assert.doesNotMatch(archived, /data-archive=/);
  assert.match(archived, /&quot;&gt;&lt;img/);

  const active = workflow.resourceStatusAction('active', 'resource-id');
  assert.match(active, /data-archive="resource-id"/);
  assert.doesNotMatch(active, /data-restore=/);
});

test('supports the full request, owner approval, check-in, incident, and return lifecycle', () => {
  const state = fresh('Pending');
  const { request } = state;
  workflow.approve(request, state, 'Laser Cutter', 'Makerspace team', time);
  assert.equal(request.status, 'Approved');
  workflow.checkIn(request, state, 'Laser Cutter', 'No visible damage.', 'Aarav Kumar', time);
  assert.equal(request.status, 'In use');
  workflow.reportIncident(request, state, 'Laser Cutter', 'The acrylic sheet jammed; staff informed.', 'Aarav Kumar', time);
  assert.equal(request.status, 'Issue reported');
  assert.equal(state.incidents.length, 1);
  workflow.returnResource(request, state, 'Laser Cutter', 'Returned to staff; no further damage.', 'Aarav Kumar', time);
  assert.equal(request.status, 'Returned');
  assert.equal(state.audit.length, 4);
  assert.match(state.audit[1].action, /^reported an issue/);
  assert.match(state.audit[0].action, /^returned/);
  assert.equal(request.issue, 'The acrylic sheet jammed; staff informed.');
  assert.equal(request.finalCondition, 'Returned to staff; no further damage.');
});

test('requires a real rejection reason and records the owner-entered reason', () => {
  const state = fresh('Pending');
  assert.throws(() => workflow.reject(state.request, state, 'Laser Cutter', '   ', 'Makerspace team', time), /reason is required/);
  workflow.reject(state.request, state, 'Laser Cutter', 'Staff supervision is unavailable at that time.', 'Makerspace team', time);
  assert.equal(state.request.status, 'Rejected');
  assert.equal(state.request.decisionReason, 'Staff supervision is unavailable at that time.');
  assert.match(state.audit[0].action, /Reason: Staff supervision is unavailable at that time\./);
});

test('owner can process a waitlisted request by approving or rejecting it', () => {
  const approved = fresh('Waitlist');
  workflow.approve(approved.request, approved, 'Laser Cutter', 'Makerspace team', time);
  assert.equal(approved.request.status, 'Approved');
  assert.match(approved.audit[0].action, /approved waitlisted request/);

  const rejected = fresh('Waitlist');
  workflow.reject(rejected.request, rejected, 'Laser Cutter', 'Owner cancelled the slot.', 'Makerspace team', time);
  assert.equal(rejected.request.status, 'Rejected');
  assert.match(rejected.audit[0].action, /declined waitlisted request/);
});

test('workflow helpers reject blank condition and incident notes', () => {
  const state = fresh('Approved');
  assert.throws(() => workflow.checkIn(state.request, state, 'Laser Cutter', '   '), /condition note is required/);
  workflow.checkIn(state.request, state, 'Laser Cutter', 'Checked before use.', 'Aarav Kumar', time);
  assert.throws(() => workflow.reportIncident(state.request, state, 'Laser Cutter', '  '), /description is required/);
  assert.throws(() => workflow.returnResource(state.request, state, 'Laser Cutter', ' '), /return condition note is required/);
});

test('button loading always resets after rejected work and suppresses duplicate work', async () => {
  const button = { disabled: false, textContent: 'Sign in', dataset: {} };
  let finish;
  let calls = 0;
  const pending = workflow.withButtonLoading(button, () => {
    calls += 1;
    return new Promise((resolve, reject) => { finish = { resolve, reject }; });
  });
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Working…');
  assert.equal(await workflow.withButtonLoading(button, async () => { calls += 1; }), false);
  assert.equal(calls, 1);
  finish.reject(Object.assign(new Error('Invalid email or password.'), { status: 401 }));
  await assert.rejects(pending, /Invalid email or password/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Sign in');
});
