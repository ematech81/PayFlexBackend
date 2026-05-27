'use strict';

const express = require('express');
const router  = express.Router();
const { handleWebhook } = require('../controllers/vtuAfricaWebhookController');

// POST /api/vtu-africa/webhook
// Note: express.raw() is applied to this path in server.js BEFORE express.json()
// so req.body arrives as a Buffer here — do not add express.json() middleware here.
router.post('/webhook', handleWebhook);

module.exports = router;
