'use strict';

/**
 * Expo Push Notification Service
 *
 * Sends push notifications to users via Expo's Push API.
 * Uses the user's expoPushToken stored in the User model.
 *
 * Expo Push API is free and requires no API key — it routes
 * through APNs (iOS) and FCM (Android) automatically.
 */

const axios = require('axios');
const User  = require('../models/user');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send a push notification to a single user by their userId.
 *
 * @param {string} userId   - MongoDB user _id
 * @param {object} opts
 * @param {string} opts.title   - Notification title
 * @param {string} opts.body    - Notification body text
 * @param {object} [opts.data]  - Extra data payload (accessible in app)
 * @param {string} [opts.sound] - 'default' or null
 */
async function sendToUser(userId, { title, body, data = {}, sound = 'default' }) {
  try {
    const user = await User.findById(userId).select('expoPushToken');
    if (!user?.expoPushToken) {
      console.log(`[push] User ${userId} has no push token — skipping`);
      return { sent: false, reason: 'no_token' };
    }
    return await sendToToken(user.expoPushToken, { title, body, data, sound });
  } catch (err) {
    console.error(`[push] sendToUser error for ${userId}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Send a push notification directly to an Expo push token.
 *
 * @param {string} pushToken  - ExponentPushToken[...]
 * @param {object} opts
 */
async function sendToToken(pushToken, { title, body, data = {}, sound = 'default' }) {
  if (!pushToken || !pushToken.startsWith('ExponentPushToken')) {
    console.warn('[push] Invalid Expo push token:', pushToken);
    return { sent: false, reason: 'invalid_token' };
  }

  try {
    const { data: response } = await axios.post(
      EXPO_PUSH_URL,
      { to: pushToken, title, body, data, sound },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 }
    );

    const result = response?.data?.[0] || response;
    if (result?.status === 'error') {
      console.warn('[push] Expo push error:', result.message, result.details);
      return { sent: false, reason: result.message };
    }

    console.log(`[push] Sent to ${pushToken.slice(0, 30)}… — "${title}"`);
    return { sent: true, ticketId: result?.id };
  } catch (err) {
    console.error('[push] sendToToken error:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Send to multiple users at once (batched).
 *
 * @param {string[]} userIds
 * @param {object}   opts  - same as sendToUser opts
 */
async function sendToUsers(userIds, opts) {
  const users = await User.find({ _id: { $in: userIds }, expoPushToken: { $exists: true, $ne: null } })
    .select('expoPushToken')
    .lean();

  if (users.length === 0) return { sent: 0 };

  const messages = users.map(u => ({
    to:    u.expoPushToken,
    title: opts.title,
    body:  opts.body,
    data:  opts.data || {},
    sound: opts.sound || 'default',
  })).filter(m => m.to.startsWith('ExponentPushToken'));

  if (messages.length === 0) return { sent: 0 };

  try {
    await axios.post(EXPO_PUSH_URL, messages, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 15000,
    });
    console.log(`[push] Batch sent to ${messages.length} users — "${opts.title}"`);
    return { sent: messages.length };
  } catch (err) {
    console.error('[push] batch send error:', err.message);
    return { sent: 0, error: err.message };
  }
}

module.exports = { sendToUser, sendToToken, sendToUsers };
