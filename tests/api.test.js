const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadClient(fetchImpl) {
  const store = new Map();
  const window = {
    COMMONROOM_API_BASE: 'http://example.test/api',
    localStorage: {
      getItem: key => store.get(key) || null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    dispatchEvent: event => { window.lastEvent = event.type; },
    CustomEvent: class { constructor(type) { this.type = type; } }
  };
  const context = vm.createContext({ window, fetch: fetchImpl, Headers, URLSearchParams, CustomEvent: window.CustomEvent });
  vm.runInContext(fs.readFileSync('api.js', 'utf8'), context);
  return window;
}

test('API client attaches its session token and returns JSON consistently', async () => {
  let call;
  const window = loadClient(async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  window.CommonroomApi.setSession({ token: 'frontend-test-token', user: { id: 'user-1' } });
  const result = await window.CommonroomApi.resources({ category: 'Equipment' });
  assert.equal(call.url, 'http://example.test/api/resources?category=Equipment');
  assert.equal(call.options.headers.get('Authorization'), 'Bearer frontend-test-token');
  assert.deepEqual(result.data, []);
  assert.equal(window.localStorage.getItem('commonroom.auth.profile'), JSON.stringify({ id: 'user-1' }));
});

test('API client reports backend errors and broadcasts unauthorized responses', async () => {
  const window = loadClient(async () => new Response(JSON.stringify({ success: false, error: 'Invalid or expired token.' }), { status: 401, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(window.CommonroomApi.me(), error => error.status === 401 && error.message === 'Invalid or expired token.');
  assert.equal(window.lastEvent, 'commonroom:unauthorized');
});

test('API client keeps unavailable login errors distinct and useful', async () => {
  const window = loadClient(async () => { throw new TypeError('network down'); });
  await assert.rejects(window.CommonroomApi.login({ email: 'borrower@example.invalid', password: 'wrong' }), error => error.status === 0 && /Cannot reach/.test(error.message));
  assert.equal(window.localStorage.getItem('commonroom.auth.token'), null);
  assert.equal(window.localStorage.getItem('commonroom.auth.profile'), null);
});

test('failed login preserves the clear 401 message without storing a session', async () => {
  const window = loadClient(async () => new Response(JSON.stringify({ error: 'Invalid email or password.' }), { status: 401, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(window.CommonroomApi.login({ email: 'borrower@example.invalid', password: 'wrong' }), error => error.status === 401 && error.message === 'Invalid email or password.');
  assert.equal(window.localStorage.getItem('commonroom.auth.token'), null);
  assert.equal(window.localStorage.getItem('commonroom.auth.profile'), null);
});

test('return API failures remain useful when the backend is unavailable', async () => {
  const window = loadClient(async () => { throw new TypeError('network down'); });
  await assert.rejects(window.CommonroomApi.bookingAction('booking-1', 'return', { returnCondition: 'Returned safely.' }), error => error.status === 0 && /Cannot reach/.test(error.message));
});

test('borrower return uses PATCH, returnCondition, and the current bearer token', async () => {
  let call;
  const window = loadClient(async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ success: true, data: { status: 'returned' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  window.CommonroomApi.setSession({ token: 'borrower-test-token', user: { id: 'borrower-1' } });
  const result = await window.CommonroomApi.bookingAction('booking-1', 'return', { returnCondition: 'Safe and complete.' });
  assert.equal(call.url, 'http://example.test/api/bookings/booking-1/return');
  assert.equal(call.options.method, 'PATCH');
  assert.equal(call.options.headers.get('Authorization'), 'Bearer borrower-test-token');
  assert.deepEqual(JSON.parse(call.options.body), { returnCondition: 'Safe and complete.' });
  assert.equal(result.data.status, 'returned');
});
