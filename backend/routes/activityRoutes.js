const express = require('express');
const { myActivity, resourceActivity, bookingActivity, allActivity } = require('../controllers/activityController');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/my', authenticateToken, myActivity);
router.get('/resource/:resourceId', authenticateToken, authorizeRoles('owner', 'manager', 'admin'), resourceActivity);
router.get('/booking/:bookingId', authenticateToken, bookingActivity);
router.get('/', authenticateToken, authorizeRoles('admin'), allActivity);

module.exports = router;
