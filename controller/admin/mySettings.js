const User = require('../../models/userModel');
const { PHONE_COUNTRIES, parsePhone } = require('../../helpers/phoneNumber');

const view = user => ({ name: user.name || '', loginEmail: user.email, contactEmail: user.adminContact?.email || '', whatsappNumbers: user.adminContact?.whatsappNumbers || [], countries: PHONE_COUNTRIES });
async function handle(req, res) {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.roles.includes('admin') || user.isGuest || user.isActive === false || user.deletedAt) return res.status(403).json({ success: false, message: 'Current admin access required' });
    if (req.method === 'PATCH') {
      const { name, contactEmail, whatsappNumbers } = req.body;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw new Error('Name must be 1–120 characters');
      if (typeof contactEmail !== 'string' || contactEmail.length > 254 || (contactEmail.trim() && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contactEmail.trim()))) throw new Error('Enter a valid contact email');
      if (!Array.isArray(whatsappNumbers) || whatsappNumbers.length > 2) throw new Error('Save at most two WhatsApp numbers');
      const numbers = whatsappNumbers.map(value => {
        if (typeof value !== 'string') throw new Error('Enter a country code and phone number');
        const country = PHONE_COUNTRIES.find(row => value.startsWith(row.code));
        if (!country) throw new Error('Choose a supported country code');
        return parsePhone({ countryCode: country.code, phone: value.slice(country.code.length) });
      });
      if (new Set(numbers).size !== numbers.length) throw new Error('WhatsApp numbers must be different');
      user.name = name.trim();
      user.adminContact = { email: contactEmail.trim().toLowerCase(), whatsappNumbers: numbers };
      await user.save();
    }
    return res.json({ success: true, data: view(user) });
  } catch (error) { return res.status(400).json({ success: false, message: error.message }); }
}
module.exports = handle;
