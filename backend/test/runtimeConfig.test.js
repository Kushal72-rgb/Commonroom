const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveCorsOrigins, resolvePort, validateJwtSecret, validateMongoUri } = require('../config/runtime');

test('development uses the two documented local frontend origins when unset', () => {
  assert.deepEqual(resolveCorsOrigins({ nodeEnv: 'development', configured: '' }), [
    'http://127.0.0.1:5500',
    'http://localhost:5500'
  ]);
});

test('port configuration accepts valid values and rejects malformed values', () => {
  assert.equal(resolvePort(undefined), 5000);
  assert.equal(resolvePort('5001'), 5001);
  for (const value of ['abc', '0', '65536', '5000/api']) {
    assert.throws(() => resolvePort(value), /PORT/);
  }
});

test('production JWT configuration rejects missing, short, and placeholder secrets', () => {
  assert.throws(() => validateJwtSecret(undefined, 'production'), /32 bytes/);
  assert.throws(() => validateJwtSecret('replace-with-a-random-secret-at-least-32-bytes', 'production'), /replaced/);
  assert.doesNotThrow(() => validateJwtSecret('x'.repeat(48), 'production'));
});

test('production MongoDB configuration rejects missing, local, and placeholder URIs', () => {
  assert.throws(() => validateMongoUri('', 'production'), /MONGODB_URI/);
  assert.throws(() => validateMongoUri('mongodb://127.0.0.1:27017/commonroom', 'production'), /production database/);
  assert.throws(() => validateMongoUri('mongodb+srv://<user>:<password>@<cluster>/commonroom', 'production'), /valid MongoDB/);
  assert.doesNotThrow(() => validateMongoUri('mongodb+srv://db-user:encoded%40password@cluster.example.net/commonroom?retryWrites=true', 'production'));
  assert.doesNotThrow(() => validateMongoUri('mongodb://127.0.0.1:27017/commonroom', 'development'));
});

test('production requires explicit exact HTTPS frontend origins', () => {
  assert.throws(() => resolveCorsOrigins({ nodeEnv: 'production', configured: '' }), /must list/);
  assert.throws(() => resolveCorsOrigins({ nodeEnv: 'production', configured: '*' }), /wildcard/);
  assert.throws(() => resolveCorsOrigins({ nodeEnv: 'production', configured: 'http://app.example.com' }), /HTTPS/);
  assert.throws(() => resolveCorsOrigins({ nodeEnv: 'production', configured: 'https://app.example.com/path' }), /exact origins/);
  assert.deepEqual(resolveCorsOrigins({
    nodeEnv: 'production',
    configured: 'https://app.example.com,https://admin.example.com,https://app.example.com'
  }), ['https://app.example.com', 'https://admin.example.com']);
});
