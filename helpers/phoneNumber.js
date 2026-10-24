// Single source for account phone numbers (owner rule 24 Oct 2026): a country code plus the
// national number, stored as one string (+919876543210). Website and portal read this list
// through GET /api/phone-countries, so the dropdown and the server check never drift apart.
const PHONE_COUNTRIES = [
  { code: '+91', label: 'India', digits: 10 },
  { code: '+1', label: 'USA / Canada', digits: 10 },
  { code: '+44', label: 'United Kingdom', digits: 10 },
  { code: '+971', label: 'UAE', digits: 9 },
  { code: '+966', label: 'Saudi Arabia', digits: 9 },
  { code: '+974', label: 'Qatar', digits: 8 },
  { code: '+65', label: 'Singapore', digits: 8 },
  { code: '+61', label: 'Australia', digits: 9 },
  { code: '+977', label: 'Nepal', digits: 10 },
];
const DEFAULT_COUNTRY = '+91';

const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

/** { countryCode: '+91', phone: '98765 43210' } → '+919876543210'; anything else throws a readable 400. */
function parsePhone({ countryCode, phone } = {}) {
  const country = PHONE_COUNTRIES.find(row => row.code === (countryCode || DEFAULT_COUNTRY));
  if (!country) fail('Choose a supported country code');
  const digits = String(phone || '').replace(/[\s\-().]/g, '');
  if (!digits) fail('Please provide your mobile number');
  if (!new RegExp(`^\\d{${country.digits}}$`).test(digits)) fail(`Enter a ${country.digits}-digit mobile number for ${country.label}`);
  if (country.code === '+91' && !/^[6-9]/.test(digits)) fail('Enter a valid Indian mobile number');
  return `${country.code}${digits}`;
}

// Provision only: WhatsApp OTP at signup comes later. While the flag is off, numbers are
// saved unverified (phoneVerified: false). Turning the flag on before OTP exists refuses
// signups instead of silently treating numbers as verified.
function assertSignupPhoneVerification() {
  if (process.env.SIGNUP_PHONE_OTP_ENABLED === 'true') {
    throw Object.assign(new Error('Phone verification is not available yet. Please try again later.'), { statusCode: 503 });
  }
}

module.exports = { PHONE_COUNTRIES, DEFAULT_COUNTRY, parsePhone, assertSignupPhoneVerification };
