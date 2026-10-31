require('dotenv').config();

const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { resolveCorsOrigins, resolvePort, validateJwtSecret, validateMongoUri } = require('./config/runtime');
const authRoutes = require('./routes/authRoutes');
const resourceRoutes = require('./routes/resourceRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const incidentRoutes = require('./routes/incidentRoutes');
const activityRoutes = require('./routes/activityRoutes');

const app = express();
const port = resolvePort();
const allowedOrigins = resolveCorsOrigins();

app.disable('x-powered-by');
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use('/api/auth', authRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/activity', activityRoutes);

app.get('/api/health', (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'unavailable',
    service: 'commonroom-api',
    database: connected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (process.env.NODE_ENV === 'production') {
    console.error('Request failed.', { name: err.name || 'Error', code: err.code || undefined });
  } else {
    console.error('Request error:', err.message);
  }
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
    ? err.status
    : 500;
  res.status(status).json({
    success: false,
    error: status === 400 ? 'Invalid request body' : 'Internal server error'
  });
});

async function startServer() {
  try {
    validateJwtSecret(process.env.JWT_SECRET);
    validateMongoUri(process.env.MONGODB_URI);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  try {
    await connectDB();
    app.listen(port, () => {
      console.log(`Commonroom API listening on port ${port}`);
    });
  } catch (err) {
    console.error('Unable to start Commonroom API because the database connection failed.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
