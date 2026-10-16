// utils/otpUtils.js
const otpModel = require("../models/otpModel");
// Unattended OTP mail is disabled with all other legacy automatic email.
// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Save OTP to database
const saveOTP = async (userId, otp) => {
  try {
    // Delete any existing OTPs for this user
    await otpModel.deleteMany({ userId });
    
    // Create new OTP
    const otpDoc = new otpModel({
      userId,
      otp
    });
    
    await otpDoc.save();
    return true;
  } catch (error) {
    console.error("Error saving OTP:", error);
    return false;
  }
};

// Send OTP via email
const sendOTPEmail = async () => false;

// Verify OTP
const verifyOTP = async (userId, otp) => {
  try {
    const otpDoc = await otpModel.findOne({ userId, otp });

    if (!otpDoc) return false;

    const now = Date.now();
    const otpCreatedAt = new Date(otpDoc.createdAt).getTime();
    const isExpired = now - otpCreatedAt > 5 * 60 * 1000; // ✅ 5 minutes

    if (isExpired) {
      console.warn("OTP expired");
      return false;
    }

    return true; // valid and within time
  } catch (error) {
    console.error("Error verifying OTP:", error);
    return false;
  }
};


module.exports = {
  generateOTP,
  saveOTP,
  sendOTPEmail,
  verifyOTP
};
