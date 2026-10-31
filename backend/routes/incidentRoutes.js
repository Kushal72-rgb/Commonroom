const express = require('express');
const {
  createIncident,
  listMyIncidents,
  listOwnerIncidents,
  getIncident,
  reviewIncident,
  resolveIncident,
  dismissIncident
} = require('../controllers/incidentController');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');

const router = express.Router();
const ownerRoles = authorizeRoles('owner', 'manager', 'admin');

router.post('/', authenticateToken, createIncident);
router.get('/my', authenticateToken, listMyIncidents);
router.get('/owner', authenticateToken, ownerRoles, listOwnerIncidents);
router.get('/:id', authenticateToken, getIncident);
router.patch('/:id/review', authenticateToken, ownerRoles, reviewIncident);
router.patch('/:id/resolve', authenticateToken, ownerRoles, resolveIncident);
router.patch('/:id/dismiss', authenticateToken, ownerRoles, dismissIncident);

module.exports = router;
