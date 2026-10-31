const express = require('express');
const {
  createBooking,
  listMyBookings,
  listOwnerBookings,
  getBooking,
  approveBooking,
  rejectBooking,
  waitlistBooking,
  cancelBooking,
  checkInBooking,
  returnBooking
} = require('../controllers/bookingController');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');

const router = express.Router();
const ownerRoles = authorizeRoles('owner', 'manager', 'admin');

router.post('/', authenticateToken, createBooking);
router.get('/my', authenticateToken, listMyBookings);
router.get('/owner', authenticateToken, ownerRoles, listOwnerBookings);
router.get('/:id', authenticateToken, getBooking);
router.patch('/:id/approve', authenticateToken, ownerRoles, approveBooking);
router.patch('/:id/reject', authenticateToken, ownerRoles, rejectBooking);
router.patch('/:id/waitlist', authenticateToken, ownerRoles, waitlistBooking);
router.patch('/:id/cancel', authenticateToken, cancelBooking);
router.patch('/:id/check-in', authenticateToken, ownerRoles, checkInBooking);
router.patch('/:id/return', authenticateToken, returnBooking);

module.exports = router;
