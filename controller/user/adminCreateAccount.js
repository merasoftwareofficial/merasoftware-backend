const uploadProductPermission = require("../../helpers/permission");
const { createAccount, publicAccount } = require("../../helpers/accountCreation");
const { ensureWonLead } = require("../../helpers/wonLead");

// The portal's Add Admin / Developer / Partner / Customer forms (frontend/src/helpers/createAccountWithRole.js).
// The account gets its role in one step, so it never passes through the website's signup: no member lead is made
// for a team account. A customer gets their Won lead, as /api/addRole gives it.
const ROLES = ["admin", "developer", "partner", "customer"];

async function adminCreateAccountController(req, res) {
  try {
    // Admin-only, checked against the database, not the token's role, which a role switch can change.
    if (!(await uploadProductPermission(req.userId))) {
      return res.status(403).json({ success: false, error: true, message: "Permission denied" });
    }
    const { role, ...account } = req.body || {};
    const roleLower = String(role || "").toLowerCase();
    if (!ROLES.includes(roleLower)) throw new Error("Choose a valid role");

    const user = await createAccount(account, roleLower, {
      phoneTakenMessage: (owner) => `This number is already registered to ${owner.name || owner.email} (${owner.email})${owner.deletedAt ? ", now in Trash" : ""}. Use that account instead.`,
    });
    // The account exists whatever happens here; the backfill script can add a missing lead later.
    await ensureWonLead(user, req.userId).catch((error) => console.error("Could not add the client's Won lead:", error.message));

    res.status(201).json({ success: true, error: false, message: "Account created", data: publicAccount(user) });
  } catch (err) {
    res.status(400).json({ success: false, error: true, message: err.message || "Failed to create the account" });
  }
}

module.exports = adminCreateAccountController;
