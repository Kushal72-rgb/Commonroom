function createAuthRateLimit({ windowMs = 15 * 60 * 1000, max = 10, now = Date.now } = {}) {
  const attempts = new Map();
  let lastCleanup = 0;

  return function authRateLimit(req, res, next) {
    const currentTime = now();
    if (currentTime - lastCleanup > windowMs) {
      for (const [key, entry] of attempts) {
        if (entry.resetAt <= currentTime) attempts.delete(key);
      }
      lastCleanup = currentTime;
    }

    const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${req.baseUrl}${req.path}`;
    let entry = attempts.get(key);
    if (!entry || entry.resetAt <= currentTime) {
      entry = { count: 0, resetAt: currentTime + windowMs };
      attempts.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000))));
      return res.status(429).json({ success: false, error: 'Too many authentication attempts. Try again later.' });
    }
    return next();
  };
}

module.exports = { createAuthRateLimit };
