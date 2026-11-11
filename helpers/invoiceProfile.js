const AdminSettings = require('../models/adminSettingsModel');
const mongoose = require('mongoose');

const FALLBACK = {
  businessName: 'Mera Software', legalName: '', tagline: 'Digital Solutions',
  addressLines: ['VA Computers, Near New Bus Stand, Majitha 143601'],
  email: 'contact@merasoftware.com', phone: '+91 92565 37003',
  websiteUrl: 'https://www.merasoftware.com', termsUrl: 'https://www.merasoftware.com/terms', gstin: '', pan: '',
};

// PDFs are generated on demand, so a newly saved profile is used by every new
// view, download and resend, including for historical invoice records.
async function getInvoiceProfile() {
  // Isolated PDF unit tests do not open Mongo. Production requests run only
  // after the application database has connected, so they always read saved data.
  if (mongoose.connection.readyState === 0) return { ...FALLBACK, addressLines: [...FALLBACK.addressLines] };
  const settings = await AdminSettings.getSettings();
  const saved = settings.invoiceProfile?.toObject ? settings.invoiceProfile.toObject() : settings.invoiceProfile;
  const addressLines = saved?.addressLines?.filter(Boolean);
  return { ...FALLBACK, ...(saved || {}), addressLines: addressLines?.length ? addressLines : FALLBACK.addressLines };
}

module.exports = { getInvoiceProfile, FALLBACK };
