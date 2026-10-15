const bcrypt = require("bcryptjs");
const userModel = require("../models/userModel");
const { STORE_PLAIN_PASSWORD } = require("../config/accessControlConfig");

// Universal default password given to every admin-made client account (lead
// convert, Add Client). The customer is prompted to set their own on first
// login (mustResetPassword flag, honoured by both the portal and the website login).
const CLIENT_DEFAULT_PASSWORD = "1234";

// Same hashing approach as userSignUp; the plaintext copy is gated by the flag.
const applyDefaultPassword = (user) => {
  const salt = bcrypt.genSaltSync(10);
  user.password = bcrypt.hashSync(CLIENT_DEFAULT_PASSWORD, salt);
  user.mustResetPassword = true;
  if (STORE_PLAIN_PASSWORD) {
    user.plainPassword = CLIENT_DEFAULT_PASSWORD;
  }
};

// A blog-only account made by the website's "Create account" (userSignUp gives
// it roles ['member']). Only such an account may be upgraded into a client;
// staff, partners, customers, guests and trashed accounts never are.
const isUpgradeableMember = (user) =>
  Boolean(user) &&
  !user.isGuest &&
  !user.deletedAt &&
  Array.isArray(user.roles) &&
  user.roles.length > 0 &&
  user.roles.every((role) => role === "member");

const createClientAccount = async ({ name, email, phone }) => {
  const user = new userModel({
    name,
    email,
    phone,
    roles: ["customer"],
    walletBalance: 0,
    referredBy: null,
    referrals: [],
  });
  applyDefaultPassword(user);
  return user.save();
};

// Keeps the same account (_id), so the website profile linked to it — blog
// role, posts, comments — stays linked. Sign-up never verifies the email, so
// whoever chose this member's password may not be the client: the password is
// reset to the default, exactly as for a new client account.
const upgradeMemberToClient = async (user, { phone }) => {
  user.roles = ["customer"];
  if (!user.phone && phone) {
    user.phone = phone;
  }
  applyDefaultPassword(user);
  return user.save();
};

module.exports = {
  CLIENT_DEFAULT_PASSWORD,
  isUpgradeableMember,
  createClientAccount,
  upgradeMemberToClient,
};
