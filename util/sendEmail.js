'use strict';

const axios = require('axios');

async function sendEmail(to, subject, text) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log(`⚠️  [EMAIL] BREVO_API_KEY not set — skipping email to ${to}`);
    return;
  }

  const senderEmail = process.env.SMTP_FROM || 'nwankwolivinus95@gmail.com';

  const { data } = await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender:      { name: 'PayFlex', email: senderEmail },
      to:          [{ email: to }],
      subject,
      textContent: text,
    },
    {
      headers: {
        'api-key':      apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  console.log(`✅ [EMAIL] Sent to ${to} — messageId: ${data.messageId}`);
}

module.exports = { sendEmail };
