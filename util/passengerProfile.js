// utils/passengerProfileUtils.js
const PassengerProfile = require('../models/PassengerProfile');

/**
 * Save or update passenger profiles for auto-fill feature
 * Used by both transport and flight bookings
 * 
 * @param {String} userId - User ID
 * @param {Array} passengers - Array of passenger objects
 * @returns {Promise<void>}
 */
const savePassengerProfiles = async (userId, passengers) => {
  try {
    // Find or create user's passenger profile document
    let userProfiles = await PassengerProfile.findOne({ userId });

    if (!userProfiles) {
      userProfiles = await PassengerProfile.create({
        userId,
        profiles: [],
      });
    }

    // Process each passenger
    for (const passenger of passengers) {
      // Check if profile already exists (by phone number)
      const existingProfileIndex = userProfiles.profiles.findIndex(
        (p) => p.phone === passenger.phone
      );

      // Prepare profile data
      const profileData = {
        fullName: passenger.fullName,
        phone: passenger.phone,
        email: passenger.email,
        age: passenger.age,
        gender: passenger.gender,
        title: passenger.title,
        nextOfKin: passenger.nextOfKin || '',
        nextOfKinPhone: passenger.nextOfKinPhone || '',
        lastUsed: new Date(),
      };

      if (existingProfileIndex !== -1) {
        // Update existing profile
        userProfiles.profiles[existingProfileIndex] = {
          ...userProfiles.profiles[existingProfileIndex].toObject(),
          ...profileData,
          timesUsed: (userProfiles.profiles[existingProfileIndex].timesUsed || 0) + 1,
        };
        console.log(`✅ Updated profile for ${passenger.phone}`);
      } else {
        // Add new profile (max 10 profiles per user)
        if (userProfiles.profiles.length >= 10) {
          // Remove least recently used profile
          userProfiles.profiles.sort((a, b) => b.lastUsed - a.lastUsed);
          userProfiles.profiles.pop();
          console.log('🗑️ Removed oldest profile (max 10 limit)');
        }
        
        userProfiles.profiles.push({ 
          ...profileData, 
          timesUsed: 1 
        });
        console.log(`✅ Added new profile for ${passenger.phone}`);
      }
    }

    // Save all changes
    await userProfiles.save();
    console.log(`✅ Saved ${passengers.length} passenger profile(s)`);
    
  } catch (error) {
    console.error('❌ Error saving passenger profiles:', error);
    // Don't throw - passenger profiles are non-critical
    // Booking should succeed even if profile save fails
  }
};

/**
 * Search for passenger profile by phone number
 * 
 * @param {String} userId - User ID
 * @param {String} phone - Phone number to search
 * @returns {Promise<Object|null>} - Passenger profile or null
 */
const searchPassengerByPhone = async (userId, phone) => {
  try {
    const userProfiles = await PassengerProfile.findOne({ userId });

    if (!userProfiles || userProfiles.profiles.length === 0) {
      return null;
    }

    // Find profile by phone
    const profile = userProfiles.profiles.find((p) => p.phone === phone);

    if (!profile) {
      return null;
    }

    console.log(`✅ Found profile for ${phone}`);
    return profile;

  } catch (error) {
    console.error('❌ Error searching passenger profile:', error);
    return null;
  }
};

/**
 * Get all passenger profiles for a user
 * 
 * @param {String} userId - User ID
 * @returns {Promise<Array>} - Array of passenger profiles
 */
const getUserProfiles = async (userId) => {
  try {
    const userProfiles = await PassengerProfile.findOne({ userId });

    if (!userProfiles) {
      return [];
    }

    // Sort by most recently used
    const sortedProfiles = userProfiles.profiles.sort(
      (a, b) => b.lastUsed - a.lastUsed
    );

    return sortedProfiles;

  } catch (error) {
    console.error('❌ Error getting user profiles:', error);
    return [];
  }
};

module.exports = {
  savePassengerProfiles,
  searchPassengerByPhone,
  getUserProfiles,
};