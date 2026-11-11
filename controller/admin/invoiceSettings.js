const AdminSettings = require('../../models/adminSettingsModel');
const { FALLBACK } = require('../../helpers/invoiceProfile');

const trim = (value, label, max, required = false) => {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const result = value.trim();
  if (required && !result) throw new Error(`${label} is required`);
  if (result.length > max) throw new Error(`${label} is too long`);
  return result;
};
const validUrl = (value, label) => {
  const result = trim(value, label, 500, true);
  try { const parsed = new URL(result); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
  catch { throw new Error(`Enter a valid ${label}`); }
  return result;
};
function profileFrom(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invoice profile is required');
  const addressLines = Array.isArray(body.addressLines) ? body.addressLines.map(line => trim(String(line), 'Address line', 160)).filter(Boolean) : [];
  if (!addressLines.length || addressLines.length > 4) throw new Error('Enter 1 to 4 address lines');
  const email = trim(body.email, 'Invoice email', 254, true).toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new Error('Enter a valid invoice email');
  const phone = trim(body.phone, 'Invoice phone', 40, true);
  if (!/[0-9]{7}/.test(phone.replace(/\D/g, ''))) throw new Error('Enter a valid invoice phone');
  return {
    businessName: trim(body.businessName, 'Business name', 120, true), legalName: trim(body.legalName || '', 'Legal name', 160),
    tagline: trim(body.tagline || '', 'Tagline', 120), addressLines, email, phone,
    websiteUrl: validUrl(body.websiteUrl, 'website URL'), termsUrl: validUrl(body.termsUrl, 'terms URL'),
    gstin: trim(body.gstin || '', 'GSTIN', 30), pan: trim(body.pan || '', 'PAN', 30),
  };
}
const view = settings => ({ ...FALLBACK, ...((settings.invoiceProfile?.toObject ? settings.invoiceProfile.toObject() : settings.invoiceProfile) || {}) });
const allow = (req, res) => { if (req.userRole === 'admin') return true; res.status(403).json({ success: false, error: true, message: 'Forbidden' }); return false; };
async function get(req, res) { try { if (!allow(req, res)) return; return res.json({ success: true, error: false, data: view(await AdminSettings.getSettings()) }); } catch (error) { return res.status(400).json({ success: false, error: true, message: error.message }); } }
async function patch(req, res) { try { if (!allow(req, res)) return; const settings = await AdminSettings.getSettings(); settings.invoiceProfile = { ...profileFrom(req.body), updatedBy: req.userId }; await settings.save(); return res.json({ success: true, error: false, message: 'Invoice settings updated', data: view(settings) }); } catch (error) { return res.status(400).json({ success: false, error: true, message: error.message }); } }
module.exports = { get, patch, profileFrom };
