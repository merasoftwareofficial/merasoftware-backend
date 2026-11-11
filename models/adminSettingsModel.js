const mongoose = require('mongoose');

const businessProfileSchema = new mongoose.Schema({
  businessName: { type: String, default: 'Mera Software', trim: true },
  legalName: { type: String, default: '', trim: true },
  tagline: { type: String, default: 'Digital Solutions', trim: true },
  addressLines: { type: [String], default: ['VA Computers, Near New Bus Stand, Majitha 143601'] },
  email: { type: String, default: 'contact@merasoftware.com', trim: true, lowercase: true },
  phone: { type: String, default: '+91 92565 37003', trim: true },
  websiteUrl: { type: String, default: 'https://www.merasoftware.com', trim: true },
  termsUrl: { type: String, default: 'https://www.merasoftware.com/terms', trim: true },
  gstin: { type: String, default: '', trim: true },
  pan: { type: String, default: '', trim: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', default: null },
}, { _id: false });

const adminSettingsSchema = new mongoose.Schema({
  fileExpirationDays: {
    type: Number,
    default: 30, // Default to 30 days
    min: 1,
    max: 365
  },
  // Wallet amount credited to a customer when a new lead is linked to them via
  // the Add Lead "Reference" flow (createLead.js). Admin-editable so it isn't
  // hardcoded in controller code.
  leadReferralRewardAmount: {
    type: Number,
    default: 500,
    min: 0
  },
  // Global billing identity. Team notification recipients remain on user.adminContact.
  invoiceProfile: { type: businessProfileSchema, default: () => ({}) },
  // Other admin settings can be added here
}, {
  timestamps: true
});

// Ensure only one settings document exists
adminSettingsSchema.statics.getSettings = async function() {
  const settings = await this.findOne();
  if (settings) {
    return settings;
  } else {
    // Create default settings if none exist
    return await this.create({});
  }
};

const AdminSettings = mongoose.model('AdminSettings', adminSettingsSchema);

module.exports = AdminSettings;
