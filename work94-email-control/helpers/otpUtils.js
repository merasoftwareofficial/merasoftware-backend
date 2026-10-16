// utils/otpUtils.js
const otpModel = require("../models/otpModel");
const sgMail = require('@sendgrid/mail');

// Set SendGrid API key
const sendGridApiKey = process.env.SENDGRID_API_KEY;
if (sendGridApiKey && sendGridApiKey.startsWith("SG.")) {
  sgMail.setApiKey(sendGridApiKey);
} else {
  console.warn('SENDGRID_API_KEY missing or invalid (must start with "SG."). Email features are disabled.');
}

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
const sendOTPEmail = async (email, otp, name) => {
  try {
    if (!sendGridApiKey || !sendGridApiKey.startsWith("SG.")) {
      console.warn("Skipping OTP email because SendGrid API key is not configured correctly.");
      return false;
    }

    const msg = {
      from: {
        email: process.env.FROM_EMAIL,
        name: process.env.FROM_NAME || 'Your E-commerce Store'
      },
      to: email,
      subject: 'Your Login Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Login Verification</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Hello ${name},</p>
            
            <p>Please use the following verification code to complete your login:</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center;">
              <h2 style="margin: 0; color: #333; letter-spacing: 5px;">${otp}</h2>
            </div>
            
            <p>This verification code will expire in <strong>5 minutes</strong>.</p>
            
            <p>If you did not attempt to log in, please ignore this email or contact support if you're concerned about your account security.</p>
            
            <p>Thank you!</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Your E-commerce Store. All rights reserved.</p>
          </div>
        </div>
      `
    };
    
    await sgMail.send(msg);
    console.log('OTP email sent successfully to:', email);
    return true;
  } catch (error) {
    console.error('Error sending OTP email:', error);
    return false;
  }
};

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
