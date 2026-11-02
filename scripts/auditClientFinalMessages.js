// Read-only audit. Supply MONGODB_URI explicitly. This script never edits records.
const mongoose = require('mongoose');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { normalizePhone } = require('../helpers/whatsappQueue');

async function auditClientFinalMessages() {
  const [users, leads] = await Promise.all([
    User.find({ roles: 'customer', deletedAt: null, isGuest: { $ne: true } }).select('email phone').lean(),
    Lead.find({}).select('email phone status convertedToUserId deletedAt requestedByUserId').lean(),
  ]);
  const phones = new Map();
  for (const user of users) {
    const phone = normalizePhone(user.phone);
    if (phone) phones.set(phone, (phones.get(phone) || 0) + 1);
  }
  const result = { clients: users.length, linked: 0, invalidLinkedRecord: 0, missing: 0, ambiguous: 0, trashedLink: 0, duplicateLinks: 0, invalidPhone: 0, sharedPhone: 0, candidates: [] };
  for (const user of users) {
    const linked = leads.filter(lead => String(lead.convertedToUserId || '') === String(user._id));
    const live = linked.filter(lead => !lead.deletedAt);
    const phone = normalizePhone(user.phone);
    if (!phone) result.invalidPhone++;
    if (phone && phones.get(phone) > 1) result.sharedPhone++;
    if (live.length > 1) { result.duplicateLinks++; continue; }
    if (live.length === 1) {
      const link = live[0];
      if (link.status !== 'Won' || link.requestedByUserId || (phone && normalizePhone(link.phone) !== phone)) result.invalidLinkedRecord++;
      else result.linked++;
      continue;
    }
    if (linked.length) { result.trashedLink++; continue; }
    const email = String(user.email || '').trim().toLowerCase();
    const matches = leads.filter(lead => !lead.deletedAt && !lead.convertedToUserId && !lead.requestedByUserId && ((phone && normalizePhone(lead.phone) === phone) || (email && String(lead.email || '').trim().toLowerCase() === email)));
    if (matches.length || (phone && phones.get(phone) > 1)) { result.ambiguous++; continue; }
    result.missing++;
    result.candidates.push(String(user._id));
  }
  return result;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI explicitly for the database to audit.');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  try { console.log(JSON.stringify({ database: mongoose.connection.name, ...(await auditClientFinalMessages()) }, null, 2)); }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { auditClientFinalMessages };
