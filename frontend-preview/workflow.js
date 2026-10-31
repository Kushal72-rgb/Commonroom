/* Small, DOM-free lifecycle helpers so the state transitions are easy to verify. */
(function (root) {
  'use strict';

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  const hasText = value => typeof value === 'string' && value.trim().length > 0;

  async function withButtonLoading(button, operation) {
    if (!button || button.disabled) return false;
    const idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      await operation();
      return true;
    } finally {
      button.disabled = false;
      button.textContent = idleLabel;
    }
  }

  function resourceCard(resource) {
    const photo = /^photo-[a-f]$/.test(resource.photo) ? resource.photo : 'photo-a';
    const status = String(resource.status || 'Availability to confirm');
    return '<article class="resource-card"><div class="resource-photo ' + photo + '"><span class="badge ' + (status.includes('Next') ? 'busy' : '') + '">' + escapeHtml(status) + '</span><span class="emoji">' + escapeHtml(resource.emoji) + '</span></div><div class="card-body"><div class="card-meta"><strong>' + escapeHtml(resource.category) + '</strong><span>' + escapeHtml(resource.price) + '</span></div><h3>' + escapeHtml(resource.name) + '</h3><p>' + escapeHtml(resource.description) + '</p><div class="card-meta" style="margin-top:9px">⌖ &nbsp;' + escapeHtml(resource.location) + '</div><div class="card-foot"><span class="owner">Shared by <b>' + escapeHtml(resource.owner) + '</b> · demo listing</span><button class="request-button" type="button" data-request="' + escapeHtml(resource.id) + '">Request access ↗</button></div></div></article>';
  }

  function appendAudit(data, action, by = 'Aarav Kumar', at = new Date().toISOString()) {
    if (!Array.isArray(data.audit)) data.audit = [];
    data.audit.unshift({ action, by, time: at });
  }

  function decide(request, data, resourceName, status, reason, by, at) {
    if (!['Pending', 'Waitlist'].includes(request.status)) {
      throw new Error('Only pending or waitlisted requests can be decided.');
    }
    if (status === 'Rejected' && !hasText(reason)) {
      throw new Error('A rejection reason is required.');
    }
    const source = request.status === 'Waitlist' ? 'waitlisted request' : 'request';
    request.status = status;
    request.step = status === 'Approved' ? 'approved' : 'rejected';
    if (status === 'Rejected') request.decisionReason = reason.trim();
    else delete request.decisionReason;
    appendAudit(data,
      status === 'Approved'
        ? `approved ${source} for ${resourceName} for ${request.user}.`
        : `declined ${source} for ${resourceName}. Reason: ${request.decisionReason}`,
      by, at);
  }

  function approve(request, data, resourceName, by = 'Makerspace team', at) {
    decide(request, data, resourceName, 'Approved', '', by, at);
  }

  function reject(request, data, resourceName, reason, by = 'Makerspace team', at) {
    decide(request, data, resourceName, 'Rejected', reason, by, at);
  }

  function waitlist(request, data, resourceName, by = 'Makerspace team', at) {
    if (request.status !== 'Pending') throw new Error('Only pending requests can be waitlisted.');
    request.status = 'Waitlist';
    request.step = 'waitlisted';
    appendAudit(data, `placed ${request.user}'s ${resourceName} request on the waitlist. Reason: limited slots.`, by, at);
  }

  function checkIn(request, data, resourceName, note, by = request.user, at) {
    if (request.status !== 'Approved') throw new Error('Only approved requests can check in.');
    if (!hasText(note)) throw new Error('A condition note is required.');
    request.status = 'In use';
    request.step = 'checked-in';
    request.initialCondition = note.trim();
    appendAudit(data, `checked in ${resourceName}. Condition: ${request.initialCondition}`, by, at);
  }

  function reportIncident(request, data, resourceName, note, by = request.user, at) {
    if (request.status !== 'In use') throw new Error('An incident can be reported only during an active booking.');
    if (!hasText(note)) throw new Error('An incident description is required.');
    request.status = 'Issue reported';
    request.step = 'incident-reported';
    request.issue = note.trim();
    if (!Array.isArray(data.incidents)) data.incidents = [];
    data.incidents.push({ request: request.id, note: request.issue, time: at || new Date().toISOString() });
    appendAudit(data, `reported an issue for ${resourceName}: ${request.issue}`, by, at);
  }

  function returnResource(request, data, resourceName, note, by = request.user, at) {
    if (!['In use', 'Issue reported'].includes(request.status)) {
      throw new Error('Only an active booking can be returned.');
    }
    if (!hasText(note)) throw new Error('A return condition note is required.');
    request.status = 'Returned';
    request.step = 'returned';
    request.finalCondition = note.trim();
    appendAudit(data, `returned ${resourceName}. Condition: ${request.finalCondition}`, by, at);
  }

  const api = Object.freeze({ escapeHtml, hasText, withButtonLoading, resourceCard, appendAudit, approve, reject, waitlist, checkIn, reportIncident, returnResource });
  root.CommonroomWorkflow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
