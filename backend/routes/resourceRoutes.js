const express = require('express');
const {
  createResource,
  listResources,
  listMyResources,
  getResource,
  updateResource,
  deleteResource
} = require('../controllers/resourceController');
const { authenticateToken, optionalAuthenticateToken, authorizeRoles } = require('../middleware/authMiddleware');

const router = express.Router();
const authenticated = authenticateToken;
const resourceManagers = authorizeRoles('owner', 'manager', 'admin');

router.post('/', authenticated, resourceManagers, createResource);
router.get('/', optionalAuthenticateToken, listResources);
router.get('/my', authenticated, resourceManagers, listMyResources);
router.get('/:id', getResource);
router.put('/:id', authenticated, resourceManagers, updateResource);
router.delete('/:id', authenticated, resourceManagers, deleteResource);

module.exports = router;
