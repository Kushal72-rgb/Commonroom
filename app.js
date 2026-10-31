(() => {
  'use strict';
  const api = window.CommonroomApi;
  const $ = selector => document.querySelector(selector);
  const esc = value => window.CommonroomWorkflow.escapeHtml(value ?? '');
  const hasText = value => window.CommonroomWorkflow.hasText(value);
  const state = { user: api.getProfile(), resources: [], myResources: [], bookings: [], ownerBookings: [], incidents: [], ownerIncidents: [], activity: [], activeFilter: 'all', loading: false };
  const ownerRoles = new Set(['owner', 'manager', 'admin']);
  const icons = { Equipment: '✳', Spaces: '▱', Technology: '⌗' };
  const isOwner = () => !!state.user && ownerRoles.has(state.user.role);
  const isAdmin = () => state.user?.role === 'admin';
  const formatDate = value => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const label = value => String(value || '').replace(/_/g, ' ');
  function toast(message, kind = '') { const el = $('#toast'); el.textContent = message; el.className = `${kind ? `${kind} ` : ''}show`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.className = ''; }, 4200); }
  const message = error => error instanceof api.ApiError ? error.message : 'Something went wrong. Please try again.';
  function showModalError(selector, error) { const el = $(selector); if (!el) return toast(message(error), 'error'); el.textContent = typeof error === 'string' ? error : message(error); el.hidden = false; }
  function clearModalError(selector) { const el = $(selector); if (el) { el.textContent = ''; el.hidden = true; } }
  const modal = content => { $('#modal-content').innerHTML = content; $('#modal').showModal(); };
  const closeModal = () => $('#modal').close();
  function working(button, value) { if (button) { button.disabled = value; button.dataset.label ||= button.textContent; button.textContent = value ? 'Working…' : button.dataset.label; } }
  function authRequired(action = 'continue') { toast(`Sign in to ${action}.`, 'error'); openAuth(); }

  function renderProfile() {
    const user = state.user;
    $('#avatar').textContent = user ? user.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() : 'CR';
    $('#profile-copy').innerHTML = user ? `${esc(user.name)}<small>${esc(user.role.toUpperCase())}</small>` : 'Sign in<small>ACCESS YOUR ACCOUNT</small>';
    $('#list-resource').style.display = isOwner() ? '' : 'none';
  }
  function resourceCard(resource) {
    const own = state.user && (isAdmin() || resource.owner?._id === state.user.id || resource.owner === state.user.id);
    const photo = ['a', 'b', 'c', 'd', 'e', 'f'][Math.abs(resource._id?.charCodeAt(0) || 0) % 6];
    return `<article class="resource-card"><div class="resource-photo photo-${photo}"><span class="badge">${esc(label(resource.status))}</span><span class="emoji">${icons[resource.category] || '✳'}</span></div><div class="card-body"><div class="card-meta"><strong>${esc(resource.category)}</strong><span>Owner approval</span></div><h3>${esc(resource.name)}</h3><p>${esc(resource.description)}</p><div class="card-meta" style="margin-top:9px">⌖ &nbsp;${esc(resource.location)}</div><div class="card-foot"><span class="owner">Shared by <b>${esc(resource.owner?.name || 'Community owner')}</b></span><span><button class="request-button" type="button" data-request="${esc(resource._id)}">Request access ↗</button>${own ? `<button class="action-button" type="button" data-resource-history="${esc(resource._id)}">History</button><button class="action-button" type="button" data-edit-resource="${esc(resource._id)}">Edit</button><button class="action-button" type="button" data-archive="${esc(resource._id)}">Archive</button>` : ''}</span></div></div></article>`;
  }
  function renderResources() {
    const items = state.resources.filter(resource => state.activeFilter === 'all' || resource.category === state.activeFilter);
    $('#resource-grid').innerHTML = state.loading ? '<div class="empty-state">Loading resources…</div>' : items.length ? items.map(resourceCard).join('') : '<div class="empty-state">No active resources match those filters.</div>';
    $('#resource-total').textContent = state.resources.length;
    ['all', 'Equipment', 'Spaces', 'Technology'].forEach(category => { const target = document.querySelector(`[data-chip-count="${category}"]`); if (target) target.textContent = category === 'all' ? state.resources.length : state.resources.filter(item => item.category === category).length; });
    document.querySelectorAll('[data-request]').forEach(button => { button.onclick = () => openBooking(button.dataset.request); });
    document.querySelectorAll('[data-edit-resource]').forEach(button => { button.onclick = () => openResourceForm(button.dataset.editResource); });
    document.querySelectorAll('[data-resource-history]').forEach(button => { button.onclick = () => showResourceHistory(button.dataset.resourceHistory); });
    document.querySelectorAll('[data-archive]').forEach(button => { button.onclick = () => archiveResource(button.dataset.archive); });
  }
  function buttons(booking, owner = false) {
    const attrs = `data-id="${esc(booking._id)}"`;
    if (owner && ['pending', 'waitlisted'].includes(booking.status)) return `<button class="action-button primary" data-booking-action="approve" ${attrs}>Approve</button><button class="action-button" data-booking-action="reject" ${attrs}>Decline</button>${booking.status === 'pending' ? `<button class="action-button" data-booking-action="waitlist" ${attrs}>Waitlist</button>` : ''}`;
    if (owner && booking.status === 'approved') return `<button class="action-button primary" data-booking-action="check-in" ${attrs}>Check in</button>`;
    if (owner && booking.status === 'in_use') return `<button class="action-button primary" data-booking-action="return" ${attrs}>Return</button>`;
    if (!owner && ['pending', 'waitlisted', 'approved'].includes(booking.status)) return `<button class="action-button" data-booking-action="cancel" ${attrs}>Cancel</button>`;
    if (!owner && booking.status === 'in_use') return `<button class="action-button" data-booking-action="incident" ${attrs}>Report issue</button><button class="action-button primary" data-booking-action="return" ${attrs}>Return</button>`;
    return '';
  }
  function bookingRow(booking, owner = false) {
    const resource = booking.resource || {}; const borrower = booking.borrower || {}; const incident = state.incidents.find(item => item.booking?._id === booking._id || item.booking === booking._id);
    return `<article class="request-card"><div class="request-info"><div class="mini-icon">${icons[resource.category] || '✳'}</div><div><h3>${esc(resource.name || 'Resource')} ${owner ? `<span style="color:#929b95;font:11px 'DM Sans'">· ${esc(borrower.name || borrower.email || 'Borrower')}</span>` : ''}</h3><p>${esc(formatDate(booking.startDate))} to ${esc(formatDate(booking.endDate))} · ${esc(booking.purpose)}</p>${booking.rejectionReason ? `<p style="margin-top:5px;color:#a34f44">Decision: ${esc(booking.rejectionReason)}</p>` : ''}${booking.checkInCondition ? `<p style="margin-top:5px">Check-in: ${esc(booking.checkInCondition)}</p>` : ''}${booking.returnCondition ? `<p style="margin-top:5px">Return: ${esc(booking.returnCondition)}</p>` : ''}${incident ? `<p style="margin-top:5px;color:#a34f44">Incident: ${esc(incident.status)}</p>` : ''}</div></div><div class="request-actions"><span class="state ${esc(booking.status)}">${esc(label(booking.status))}</span>${buttons(booking, owner)}<button class="action-button" data-history="${esc(booking._id)}">History</button></div></article>`;
  }
  function wireBookings() { document.querySelectorAll('[data-booking-action]').forEach(button => { button.onclick = () => bookingAction(button.dataset.id, button.dataset.bookingAction, button); }); document.querySelectorAll('[data-history]').forEach(button => { button.onclick = () => showHistory(button.dataset.history); }); }
  function renderBookings() {
    $('#booking-total').textContent = state.bookings.length; $('#request-count').textContent = state.bookings.filter(item => ['pending', 'approved', 'waitlisted', 'in_use'].includes(item.status)).length;
    $('#requests-list').innerHTML = !state.user ? '<div class="empty-state"><b>Sign in to see your bookings.</b></div>' : state.bookings.length ? state.bookings.map(item => bookingRow(item)).join('') : '<div class="empty-state"><b>Your next idea starts here.</b>Request a resource and track it here.</div>';
    $('#my-incidents').innerHTML = state.incidents.length ? state.incidents.map(item => incidentRow(item, false)).join('') : state.user ? '<div class="empty-state">No incidents reported.</div>' : '';
    $('#my-activity-list').innerHTML = state.myActivity?.length ? state.myActivity.slice(0, 10).map(activityRow).join('') : state.user ? '<div class="empty-state">No personal activity yet.</div>' : ''; wireBookings();
  }
  function activityRow(item) { return `<div class="audit-row"><span class="audit-dot"></span><span><b>${esc(item.user?.name || 'System')}</b> ${esc(label(item.action))} <span style="color:#a0a8a2">· ${esc(formatDate(item.createdAt))}</span></span></div>`; }
  function incidentRow(incident, manage = true) {
    const booking = incident.booking || {}; const resource = booking.resource || {};
    const actions = !manage ? '' : incident.status === 'open' ? `<button class="action-button" data-incident-action="review" data-id="${esc(incident._id)}">Review</button><button class="action-button" data-incident-action="dismiss" data-id="${esc(incident._id)}">Dismiss</button>` : incident.status === 'review' ? `<button class="action-button primary" data-incident-action="resolve" data-id="${esc(incident._id)}">Resolve</button><button class="action-button" data-incident-action="dismiss" data-id="${esc(incident._id)}">Dismiss</button>` : '';
    return `<article class="request-card"><div class="request-info"><div class="mini-icon">!</div><div><h3>${esc(resource.name || 'Resource')} · ${esc(label(incident.status))}</h3><p>${esc(incident.description)}</p><p style="margin-top:5px;color:#78817c">Reported by ${esc(incident.reportedBy?.name || 'Borrower')} · ${esc(formatDate(incident.createdAt))}</p>${incident.dismissalReason ? `<p style="margin-top:5px;color:#a34f44">Dismissal: ${esc(incident.dismissalReason)}</p>` : ''}</div></div><div class="request-actions">${actions}</div></article>`;
  }
  function renderManage() {
    $('#manage-view .owner-tag').textContent = isOwner() ? `${state.user.name} · ${state.user.role}` : 'Owner access required';
    if (!isOwner()) { $('#owner-resources').innerHTML = '<div class="empty-state">Sign in with an owner, manager, or admin account to manage resources.</div>'; $('#manage-list').innerHTML = '<div class="empty-state">Owner access required.</div>'; $('#owner-incidents').innerHTML = ''; $('#audit-list').innerHTML = ''; return; }
    $('#owner-resources').innerHTML = state.myResources.length ? state.myResources.map(resource => `<article class="request-card"><div class="request-info"><div class="mini-icon">${icons[resource.category] || '✳'}</div><div><h3>${esc(resource.name)}</h3><p>${esc(resource.category)} · ${esc(resource.location)} · ${esc(label(resource.status))}</p></div></div><div class="request-actions"><button class="action-button" data-resource-history="${esc(resource._id)}">History</button><button class="action-button" data-edit-resource="${esc(resource._id)}">Edit</button>${window.CommonroomWorkflow.resourceStatusAction(resource.status, resource._id)}</div></article>`).join('') : '<div class="empty-state">No resources listed yet.</div>';
    $('#pending-count').textContent = state.ownerBookings.filter(item => ['pending', 'waitlisted'].includes(item.status)).length; $('#active-count').textContent = state.ownerBookings.filter(item => ['approved', 'in_use'].includes(item.status)).length; $('#incident-count').textContent = state.ownerIncidents.length;
    $('#manage-list').innerHTML = state.ownerBookings.length ? state.ownerBookings.map(item => bookingRow(item, true)).join('') : '<div class="empty-state">No booking requests for your resources.</div>';
    $('#owner-incidents').innerHTML = state.ownerIncidents.length ? state.ownerIncidents.map(item => incidentRow(item, true)).join('') : '<div class="empty-state">No incidents reported for your resources.</div>';
    $('#audit-list').innerHTML = state.activity.length ? state.activity.slice(0, 10).map(activityRow).join('') : '<div class="empty-state">No activity yet.</div>'; wireBookings();
    document.querySelectorAll('[data-resource-history]').forEach(button => { button.onclick = () => showResourceHistory(button.dataset.resourceHistory); });
    document.querySelectorAll('[data-edit-resource]').forEach(button => { button.onclick = () => openResourceForm(button.dataset.editResource); });
    document.querySelectorAll('[data-archive]').forEach(button => { button.onclick = () => archiveResource(button.dataset.archive); });
    document.querySelectorAll('[data-restore]').forEach(button => { button.onclick = () => restoreResource(button.dataset.restore, button); });
    document.querySelectorAll('[data-incident-action]').forEach(button => { button.onclick = () => incidentAction(button.dataset.id, button.dataset.incidentAction, button); });
  }
  async function loadResources() {
    state.loading = true; renderResources();
    try { const query = {}; const search = $('#search').value.trim(); const category = $('#category').value; const location = $('#location').value.trim(); if (search) query.search = search; if (category !== 'all') query.category = category; if (location) query.location = location; const result = await api.resources(query); state.resources = result.data; $('#connection-note').textContent = `${result.pagination.total} active resources`; }
    catch (error) { state.resources = []; $('#connection-note').textContent = message(error); toast(message(error), 'error'); }
    finally { state.loading = false; renderResources(); }
  }
  async function loadPrivate() {
    if (!state.user) { state.bookings = []; state.ownerBookings = []; state.incidents = []; state.ownerIncidents = []; state.activity = []; state.myActivity = []; renderBookings(); renderManage(); return; }
    try { state.bookings = (await api.myBookings()).data; } catch (error) { if (error.status !== 401) toast(message(error), 'error'); }
    try { state.incidents = (await api.myIncidents()).data; } catch { state.incidents = []; }
    try { state.myActivity = (await api.myActivity()).data; } catch { state.myActivity = []; }
    if (isOwner()) { try { state.myResources = (await api.myResources()).data; state.ownerBookings = (await api.ownerBookings()).data; state.ownerIncidents = (await api.ownerIncidents()).data; } catch (error) { toast(message(error), 'error'); } try { state.activity = (isAdmin() ? await api.allActivity() : await api.myActivity()).data; } catch { state.activity = []; } }
    renderBookings(); renderManage();
  }
  async function refresh() { renderProfile(); await Promise.all([loadResources(), loadPrivate()]); }
  function openAuth(mode = 'login') {
    modal(`<div class="modal-kicker">COMMONROOM ACCOUNT</div><h2 class="modal-title">${mode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p class="modal-description">${mode === 'login' ? 'Sign in to request and manage resources.' : 'New accounts begin as members.'}</p>${mode === 'register' ? '<label class="field">Name<input id="auth-name" maxlength="120" autocomplete="name" /></label>' : ''}<label class="field">Email<input id="auth-email" type="email" autocomplete="email" /></label><label class="field">Password<input id="auth-password" type="password" autocomplete="current-password" /></label><p class="form-error" id="auth-error" role="alert" hidden></p><button class="modal-submit" type="button" id="auth-submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button><p class="modal-description"><button class="action-button" id="auth-switch" type="button">${mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}</button></p>`);
    $('#auth-switch').onclick = () => openAuth(mode === 'login' ? 'register' : 'login');
    ['#auth-name', '#auth-email', '#auth-password'].forEach(selector => { const input = $(selector); if (input) input.addEventListener('input', () => clearModalError('#auth-error')); });
    $('#auth-submit').onclick = async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      const email = $('#auth-email').value.trim(); const password = $('#auth-password').value; const name = mode === 'register' ? $('#auth-name').value.trim() : undefined;
      if (!hasText(email) || !hasText(password) || (mode === 'register' && !hasText(name))) return showModalError('#auth-error', 'Complete every required field.');
      clearModalError('#auth-error');
      try {
        await window.CommonroomWorkflow.withButtonLoading(button, async () => {
          const result = mode === 'login' ? await api.login({ email, password }) : await api.register({ name, email, password });
          api.setSession(result); state.user = result.user; closeModal(); toast(mode === 'login' ? 'Signed in.' : 'Account created and signed in.'); await refresh();
        });
      } catch (error) { showModalError('#auth-error', error); }
    };
  }
  async function openBooking(id) {
    if (!state.user) return authRequired('request a resource');
    try { const resource = (await api.resource(id)).data; const start = new Date(Date.now() + 86400000).toISOString().slice(0, 10); const end = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10); modal(`<div class="modal-kicker">ACCESS REQUEST</div><h2 class="modal-title">${esc(resource.name)}</h2><p class="modal-description">${esc(resource.description)}<br>${esc(resource.location)}</p><div class="requirements"><b>Eligibility requirements</b><br>${esc((resource.eligibilityRequirements || []).join(', ') || 'None')}<br><br><b>Usage rules</b><br>${esc((resource.usageRules || []).join(', ') || 'Ask the owner')}</div><label class="field">Start date<input required type="date" id="book-start" value="${start}" /></label><label class="field">End date<input required type="date" id="book-end" value="${end}" /></label><label class="field">What will you use it for?<textarea required id="book-purpose" maxlength="1000"></textarea></label><button class="modal-submit" type="button" id="submit-request">Send request for review</button>`); $('#submit-request').onclick = async event => { const startDate = $('#book-start').value; const endDate = $('#book-end').value; const purpose = $('#book-purpose').value.trim(); if (!hasText(purpose) || !startDate || !endDate) return toast('Choose dates and add a purpose.', 'error'); working(event.currentTarget, true); try { await api.createBooking({ resource: id, startDate, endDate, purpose }); closeModal(); toast('Booking request sent for owner review.'); await loadPrivate(); } catch (error) { toast(message(error), 'error'); } finally { working(event.currentTarget, false); } }; } catch (error) { toast(message(error), 'error'); }
  }
  async function bookingAction(id, action, button) {
    if (!state.user) return authRequired('continue'); if (['reject', 'return', 'check-in', 'incident'].includes(action)) return actionModal(id, action);
    working(button, true); try { await api.bookingAction(id, action); toast(action === 'approve' ? 'Booking approved.' : action === 'waitlist' ? 'Booking added to the waitlist.' : 'Booking cancelled.'); await loadPrivate(); } catch (error) { toast(message(error), 'error'); } finally { working(button, false); }
  }
  function actionModal(id, action) {
    const copy = { reject: ['OWNER DECISION', 'Decline request', 'Reason', 'Decline with reason'], 'check-in': ['BOOKING RECORD', 'Record check-in', 'Starting condition', 'Confirm check-in'], return: ['BOOKING RECORD', 'Record return', 'Return condition', 'Confirm return'], incident: ['INCIDENT REPORT', 'Report an issue', 'What happened?', 'Send incident report'] }[action];
    modal(`<div class="modal-kicker">${copy[0]}</div><h2 class="modal-title">${copy[1]}</h2><label class="field">${copy[2]}<textarea id="action-note" required maxlength="${action === 'incident' || action === 'return' ? 2000 : 1000}"></textarea></label><p class="form-error" id="action-error" role="alert" hidden></p><button class="modal-submit" type="button" id="action-submit">${copy[3]}</button>`);
    $('#action-note').addEventListener('input', () => clearModalError('#action-error'));
    $('#action-submit').onclick = async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      const note = $('#action-note').value.trim();
      if (!hasText(note)) return showModalError('#action-error', 'Enter a note to continue.');
      clearModalError('#action-error');
      try {
        await window.CommonroomWorkflow.withButtonLoading(button, async () => {
          if (action === 'incident') await api.createIncident({ booking: id, description: note });
          else await api.bookingAction(id, action, action === 'reject' ? { reason: note } : action === 'return' ? { returnCondition: note } : { checkInCondition: note });
          closeModal();
          toast(action === 'incident' ? 'Incident reported. You can still return the resource.' : action === 'return' ? 'Resource returned.' : 'Booking updated.');
          await loadPrivate();
        });
      } catch (error) { showModalError('#action-error', error); }
    };
  }
  async function incidentAction(id, action, button) {
    if (action === 'dismiss') {
      modal('<div class="modal-kicker">INCIDENT DECISION</div><h2 class="modal-title">Dismiss incident</h2><label class="field">Reason<textarea id="dismissal-reason" required maxlength="1000"></textarea></label><button class="modal-submit" type="button" id="dismiss-incident">Dismiss with reason</button>');
      $('#dismiss-incident').onclick = async event => { const reason = $('#dismissal-reason').value.trim(); if (!hasText(reason)) return toast('Enter a dismissal reason.', 'error'); working(event.currentTarget, true); try { await api.incidentAction(id, action, { reason }); closeModal(); toast('Incident dismissed.'); await loadPrivate(); } catch (error) { toast(message(error), 'error'); } finally { working(event.currentTarget, false); } };
      return;
    }
    working(button, true); try { await api.incidentAction(id, action); toast(action === 'review' ? 'Incident moved to review.' : 'Incident resolved.'); await loadPrivate(); } catch (error) { toast(message(error), 'error'); } finally { working(button, false); }
  }
  async function showHistory(id) { try { const result = await api.bookingActivity(id); modal(`<div class="modal-kicker">ACTIVITY HISTORY</div><h2 class="modal-title">Booking history</h2><div class="audit-list">${result.data.length ? result.data.map(item => `<div class="audit-row"><span class="audit-dot"></span><span><b>${esc(item.user?.name || 'System')}</b> ${esc(label(item.action))}<br><small>${esc(formatDate(item.createdAt))}</small></span></div>`).join('') : '<div class="empty-state">No history available.</div>'}</div>`); } catch (error) { toast(message(error), 'error'); } }
  async function showResourceHistory(id) { try { const result = await api.ownerActivity(id); modal(`<div class="modal-kicker">ACTIVITY HISTORY</div><h2 class="modal-title">Resource history</h2><div class="audit-list">${result.data.length ? result.data.map(activityRow).join('') : '<div class="empty-state">No history available.</div>'}</div>`); } catch (error) { toast(message(error), 'error'); } }
  async function archiveResource(id) { if (!confirm('Archive this resource? Existing history will remain available.')) return; try { await api.archiveResource(id); toast('Resource archived.'); await refresh(); } catch (error) { toast(message(error), 'error'); } }
  async function restoreResource(id, button) { if (!isOwner()) return authRequired('restore a resource'); if (button.disabled) return; working(button, true); try { await api.updateResource(id, { status: 'active' }); toast('Resource restored.'); await refresh(); } catch (error) { toast(message(error), 'error'); } finally { working(button, false); } }
  async function openResourceForm(id) {
    if (!isOwner()) return authRequired('list a resource');
    let existing = null;
    try { if (id) existing = (await api.resource(id)).data; } catch (error) { return toast(message(error), 'error'); }
    const value = (field, fallback = '') => esc(existing?.[field] ?? fallback);
    modal(`<div class="modal-kicker">${existing ? 'RESOURCE EDITOR' : 'OWNER LISTING'}</div><h2 class="modal-title">${existing ? 'Edit resource' : 'Share a resource'}</h2><label class="field">Resource name<input id="new-name" maxlength="160" value="${value('name')}" /></label><label class="field">Category<select id="new-category">${['Equipment', 'Spaces', 'Technology'].map(item => `<option ${existing?.category === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label><label class="field">Location<input id="new-location" maxlength="240" value="${value('location')}" /></label><label class="field">Eligibility requirements <small>comma-separated</small><input id="new-requirements" maxlength="240" value="${esc((existing?.eligibilityRequirements || []).join(', '))}" /></label><label class="field">Usage rules <small>comma-separated</small><input id="new-rules" maxlength="500" value="${esc((existing?.usageRules || []).join(', '))}" /></label><label class="field">Description<textarea id="new-description" maxlength="4000">${value('description')}</textarea></label><button class="modal-submit" type="button" id="publish-resource">${existing ? 'Save changes' : 'Publish listing'}</button>`);
    $('#publish-resource').onclick = async event => { const name = $('#new-name').value.trim(); const location = $('#new-location').value.trim(); const description = $('#new-description').value.trim(); if (![name, location, description].every(hasText)) return toast('Name, location, and description are required.', 'error'); const split = selector => $(selector).value.split(',').map(item => item.trim()).filter(Boolean); const input = { name, category: $('#new-category').value, location, description, eligibilityRequirements: split('#new-requirements'), usageRules: split('#new-rules') }; if (!existing) input.availability = [{ startDate: new Date(Date.now() + 86400000).toISOString(), endDate: new Date(Date.now() + 366 * 86400000).toISOString() }]; working(event.currentTarget, true); try { if (existing) await api.updateResource(id, input); else await api.createResource({ ...input, status: 'active' }); closeModal(); toast(existing ? 'Resource updated.' : 'Resource published.'); await refresh(); } catch (error) { toast(message(error), 'error'); } finally { working(event.currentTarget, false); } };
  }
  function bind() {
    $('.close').onclick = closeModal; $('#modal-form').addEventListener('submit', event => event.preventDefault()); $('#profile-button').onclick = () => state.user ? modal(`<div class="modal-kicker">ACCOUNT</div><h2 class="modal-title">${esc(state.user.name)}</h2><p class="modal-description">${esc(state.user.email)}<br>${esc(state.user.role)}</p><button class="modal-submit" id="logout" type="button">Sign out</button>`):openAuth(); document.addEventListener('click', event => { if (event.target.id === 'logout') { api.clearSession(); state.user = null; closeModal(); toast('Signed out.'); refresh(); } });
    document.querySelectorAll('.nav-link').forEach(button => button.onclick = () => { document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === button)); document.querySelectorAll('.view').forEach(item => item.classList.toggle('hidden', item.id !== `${button.dataset.view}-view`)); if (button.dataset.view === 'manage') loadPrivate(); window.scrollTo({ top: 0, behavior: 'smooth' }); }); document.querySelectorAll('.chip').forEach(button => button.onclick = () => { state.activeFilter = button.dataset.filter; document.querySelectorAll('.chip').forEach(item => item.classList.toggle('selected', item === button)); renderResources(); });
    let timer; ['search', 'location'].forEach(id => { $(`#${id}`).oninput = () => { clearTimeout(timer); timer = setTimeout(loadResources, 250); }; }); $('#category').onchange = loadResources; $('#list-resource').onclick = () => openResourceForm(); window.addEventListener('commonroom:unauthorized', () => { if (state.user) { api.clearSession(); state.user = null; toast('Your session expired. Please sign in again.', 'error'); refresh(); } });
  }
  async function start() { bind(); if (api.getToken()) { try { const result = await api.me(); state.user = result.user; api.setSession({ token: api.getToken(), user: result.user }); } catch { api.clearSession(); state.user = null; } } await refresh(); }
  start();
})();
