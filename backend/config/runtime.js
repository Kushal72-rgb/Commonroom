'use strict';

const developmentOrigins = Object.freeze([
  'http://127.0.0.1:5500',
  'http://localhost:5500'
]);

function resolveCorsOrigins({ nodeEnv = process.env.NODE_ENV, configured = process.env.CORS_ORIGIN } = {}) {
  const production = nodeEnv === 'production';
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (!value) {
    if (production) throw new Error('CORS_ORIGIN must list the production frontend origin(s).');
    return [...developmentOrigins];
  }

  const origins = value.split(',').map(origin => origin.trim()).filter(Boolean);
  if (!origins.length) throw new Error('CORS_ORIGIN must list at least one frontend origin.');
  for (const origin of origins) {
    if (origin === '*') throw new Error('CORS_ORIGIN must not contain a wildcard.');
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error(`CORS_ORIGIN contains an invalid origin: ${origin}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`CORS_ORIGIN entries must be exact origins without paths: ${origin}`);
    }
    if (production && parsed.protocol !== 'https:') {
      throw new Error(`Production CORS origins must use HTTPS: ${origin}`);
    }
  }
  return [...new Set(origins)];
}

function resolvePort(value = process.env.PORT) {
  if (value === undefined || value === '') return 5000;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('PORT must be an integer from 1 to 65535.');
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('PORT must be an integer from 1 to 65535.');
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return port;
}

function validateJwtSecret(secret, nodeEnv = process.env.NODE_ENV) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes before starting the API.');
  }
  if (nodeEnv === 'production' && /^(replace|change[_-]?me|your[_-])/i.test(secret.trim())) {
    throw new Error('JWT_SECRET must be replaced with a production secret.');
  }
}

function validateMongoUri(uri, nodeEnv = process.env.NODE_ENV) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('MONGODB_URI must be configured before starting the API.');
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('MONGODB_URI must be a valid MongoDB connection URI.'); }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('MONGODB_URI must use mongodb:// or mongodb+srv://.');
  }
  if (nodeEnv === 'production' && (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname) || /replace|placeholder/i.test(uri))) {
    throw new Error('MONGODB_URI must point to a configured production database, not a local or placeholder URI.');
  }
}

module.exports = { resolveCorsOrigins, resolvePort, validateJwtSecret, validateMongoUri };
