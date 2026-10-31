const express = require('express');
const { register, login, getMe } = require('../controllers/authController');
const { authenticateToken } = require('../middleware/authMiddleware');
const { createAuthRateLimit } = require('../middleware/authRateLimit');

const router = express.Router();
const registerLimiter = createAuthRateLimit({ max: 10 });
const loginLimiter = createAuthRateLimit({ max: 10 });

router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.get('/me', authenticateToken, getMe);

module.exports = router;
