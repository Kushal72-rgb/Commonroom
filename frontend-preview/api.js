(function (root) {
  'use strict';

  const defaultBase = 'http://127.0.0.1:5000/api';
  const baseUrl = String(root.COMMONROOM_API_BASE || defaultBase).replace(/\/$/, '');
  const tokenKey = 'commonroom.auth.token';
  const profileKey = 'commonroom.auth.profile';

  class ApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }

  function getToken() { return root.localStorage.getItem(tokenKey); }
  function getProfile() {
    try { return JSON.parse(root.localStorage.getItem(profileKey)); } catch { return null; }
  }
  function setSession({ token, user }) {
    root.localStorage.setItem(tokenKey, token);
    root.localStorage.setItem(profileKey, JSON.stringify(user));
  }
  function clearSession() {
    root.localStorage.removeItem(tokenKey);
    root.localStorage.removeItem(profileKey);
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    } catch {
      throw new ApiError('Cannot reach the Commonroom API. Start the backend and try again.', 0);
    }
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      if (response.status === 401) root.dispatchEvent(new CustomEvent('commonroom:unauthorized'));
      throw new ApiError(body?.error || `Request failed (${response.status}).`, response.status, body);
    }
    return body;
  }

  const api = {
    baseUrl, ApiError, request, getToken, getProfile, setSession, clearSession,
    register: input => request('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
    login: input => request('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
    me: () => request('/auth/me'),
    resources: query => request(`/resources${query ? `?${new URLSearchParams(query)}` : ''}`),
    myResources: () => request('/resources/my'),
    resource: id => request(`/resources/${id}`),
    createResource: input => request('/resources', { method: 'POST', body: JSON.stringify(input) }),
    updateResource: (id, input) => request(`/resources/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
    archiveResource: id => request(`/resources/${id}`, { method: 'DELETE' }),
    createBooking: input => request('/bookings', { method: 'POST', body: JSON.stringify(input) }),
    myBookings: () => request('/bookings/my'), ownerBookings: () => request('/bookings/owner'),
    bookingAction: (id, action, input) => request(`/bookings/${id}/${action}`, { method: 'PATCH', ...(input === undefined ? {} : { body: JSON.stringify(input) }) }),
    createIncident: input => request('/incidents', { method: 'POST', body: JSON.stringify(input) }),
    myIncidents: () => request('/incidents/my'), ownerIncidents: () => request('/incidents/owner'),
    incidentAction: (id, action, input) => request(`/incidents/${id}/${action}`, { method: 'PATCH', ...(input === undefined ? {} : { body: JSON.stringify(input) }) }),
    myActivity: () => request('/activity/my'), ownerActivity: id => request(`/activity/resource/${id}`), bookingActivity: id => request(`/activity/booking/${id}`), allActivity: () => request('/activity')
  };
  root.CommonroomApi = Object.freeze(api);
})(window);
