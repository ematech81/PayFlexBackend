'use strict';

const express = require('express');
const router  = express.Router();
const { protect, adminOnly } = require('../middleware/auth');
const ctrl = require('../controllers/adminController');

// All admin routes require auth + admin role
router.use(protect, adminOnly);

router.get('/stats',                              ctrl.getStats);
router.get('/transactions',                       ctrl.getTransactions);
router.get('/transactions/:reference',            ctrl.getTransaction);
router.post('/transactions/:reference/refund',    ctrl.refundTransaction);
router.get('/users',                              ctrl.getUsers);
router.get('/users/:id',                          ctrl.getUser);
router.patch('/users/:id/toggle-active',          ctrl.toggleUserActive);

module.exports = router;
