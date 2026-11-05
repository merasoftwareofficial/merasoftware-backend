const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');
const { STORE_PLAIN_PASSWORD } = require('../config/accessControlConfig');
const { parsePhone, assertSignupPhoneVerification } = require('./phoneNumber');
const { findAccountsByPhone } = require('./leadPhone');

// One way to make an account, for the website's signup (a blog-only 'member') and the portal's Add Admin /
// Developer / Partner / Customer forms (controller/user/adminCreateAccount.js). One main phone = one person:
// a number on another account is refused, including a banned or trashed one (it can be restored). A guest's
// temporary demo account does not count. Purged accounts are gone, so their number is free again.
const PHONE_TAKEN = 'This number is already registered. Please sign in.';

/** The account that holds this main phone (live or trashed, not a guest), or null. */
async function phoneOwner(phone) {
  const [owner] = (await findAccountsByPhone(phone)).filter(user => !user.isGuest);
  return owner || null;
}

/** Checks the form and creates the account with this one role. Throws a message the form can show. */
async function createAccount({ email, password, name, referredBy, countryCode, phone }, role, { phoneTakenMessage } = {}) {
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) throw new Error('Please provide valid email address');
  if (!email) throw new Error('Please provide email');
  if (!password) throw new Error('Please provide password');
  if (!name) throw new Error('Please provide name');
  // Owner rule: no account without a mobile number (country code + national number).
  const cleanPhone = parsePhone({ countryCode, phone });
  assertSignupPhoneVerification();
  if (password.length < 6) throw new Error('Password must be at least 6 characters long');

  const hashPassword = bcrypt.hashSync(password, bcrypt.genSaltSync(10));
  if (!hashPassword) throw new Error('Something is Wrong');

  const normalizedEmail = email.trim().toLowerCase();
  // Creating never grants a role to an existing account: an account that already exists should sign in instead.
  if (await userModel.findOne({ email: normalizedEmail })) throw new Error('An account with this email already exists. Please sign in.');
  const owner = await phoneOwner(cleanPhone);
  if (owner) throw new Error(phoneTakenMessage ? phoneTakenMessage(owner) : PHONE_TAKEN);

  const payload = {
    email: normalizedEmail,
    name,
    phone: cleanPhone,
    phoneVerified: false,
    password: hashPassword,
    roles: [role],
    walletBalance: 0,
    referredBy: referredBy ? referredBy : null, // Store the referrer ID
    referrals: [], // Initialize an empty array for tracking referrals
  };
  // Store plaintext copy for admin viewing (gated by config flag).
  if (STORE_PLAIN_PASSWORD) payload.plainPassword = password;

  const saved = await new userModel(payload).save();
  if (referredBy) {
    await userModel.findByIdAndUpdate(referredBy, {
      $addToSet: { referrals: { userId: saved._id, role, referredDate: new Date() } },
    });
  }
  return saved;
}

const publicAccount = user => ({ ...user.toObject(), password: undefined, plainPassword: undefined });

module.exports = { PHONE_TAKEN, phoneOwner, createAccount, publicAccount };
