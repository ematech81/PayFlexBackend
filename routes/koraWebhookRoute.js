const express = require('express');
const router  = express.Router();
const { handleWebhook } = require('../controllers/payStackController');

// Central Kora Pay router POSTs here: /api/webhooks/korapay
router.post('/', handleWebhook);

module.exports = router;
