const leadModel = require("../../models/leadModel");
const userModel = require("../../models/userModel");
const uploadProductPermission = require("../../helpers/permission");
const { isAccountEmail } = require("../../helpers/emailValidator");
const {
  CLIENT_DEFAULT_PASSWORD,
  isUpgradeableMember,
  createClientAccount,
  upgradeMemberToClient,
} = require("../../helpers/clientAccount");
const { executeGuestCascadeDelete } = require("../../helpers/guestCascadeDelete");
const { sendClientAccountCreatedEmail } = require("../../helpers/emailService");

const convertLeadController = async (req, res) => {
  try {
    // Creating or upgrading a login account: the token's role must be admin AND
    // the account must still be admin in the database (a token lives 365 days,
    // so a demoted admin's token alone is not enough — same rule as addRole).
    if (req.userRole !== "admin" || !(await uploadProductPermission(req.userId))) {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { leadId } = req.params;
    const upgradeExisting = req.body?.upgradeExisting === true;

    const lead = await leadModel.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        message: "Lead not found",
        error: true,
        success: false,
      });
    }

    if (lead.convertedToUserId) {
      return res.status(409).json({
        message: "This lead is already converted to a client",
        error: true,
        success: false,
      });
    }

    // A project request sent from the portal comes from someone who is already a client.
    if (lead.requestedByUserId) {
      return res.status(409).json({
        message: "This request came from an existing client account, so there is nothing to convert. Open the client from the notes instead.",
        error: true,
        success: false,
      });
    }

    const cleanPhone = (lead.phone || "").trim();
    const cleanEmail = (lead.email || "").trim().toLowerCase();

    if (!cleanPhone) {
      return res.status(400).json({
        message: "This lead has no phone number. Add a phone before converting.",
        error: true,
        success: false,
      });
    }

    if (!cleanEmail) {
      return res.status(400).json({
        message: "This lead has no email. An email is required to create a client account.",
        error: true,
        success: false,
      });
    }

    // The lead's email becomes the client's login email.
    if (!isAccountEmail(cleanEmail)) {
      return res.status(400).json({
        message: "This lead's email is not a valid email address. Correct it before converting.",
        error: true,
        success: false,
      });
    }

    // Existing-user guard (same email cannot become a second account), decided
    // before anything is deleted. Two exceptions:
    // - the lead's own live guest account: a guest shares its lead's email, and
    //   is cascade-deleted below, since userModel.email has a hard unique index;
    // - a blog-only website member: upgraded in place into the client account,
    //   but only after the admin confirms it (upgradeExisting).
    let memberToUpgrade = null;
    const existingUser = await userModel.findOne({ email: cleanEmail });
    if (lead.reservationUserId && (!existingUser || String(existingUser._id) !== String(lead.reservationUserId))) {
      return res.status(409).json({ message: "This lead is linked to a reserving account. Restore that account's email before converting.", error: true, success: false });
    }
    if (lead.reservationUserId && lead.guestUserId) return res.status(409).json({ message: "Review this linked account's guest access before converting.", error: true, success: false });
    if (existingUser) {
      const isOwnGuest =
        lead.guestUserId && String(existingUser._id) === String(lead.guestUserId);

      if (isUpgradeableMember(existingUser)) {
        if (!upgradeExisting) {
          return res.status(409).json({
            message: "This email already has a website account. Confirm to turn that account into the client account.",
            code: "EXISTING_MEMBER",
            error: true,
            success: false,
          });
        }
        memberToUpgrade = existingUser;
      } else if (!isOwnGuest) {
        return res.status(409).json({
          message: "A user with this email already exists. Cannot convert.",
          error: true,
          success: false,
        });
      }
    }

    // The lead's guest account goes away on convert, whether or not its email
    // still matches the lead's (the lead's email may have been edited since).
    if (lead.guestUserId) {
      const guestResult = await executeGuestCascadeDelete(lead.guestUserId);
      if (!guestResult.deleted && guestResult.reason === "active_chess_game") {
        return res.status(409).json({
          message: "This lead's guest account is in a live chess game. Convert again after the game ends.",
          error: true,
          success: false,
        });
      }
      // Deleted, already gone, or no longer a guest: the link is stale either way.
      lead.guestUserId = null;
    }

    let clientUser;
    if (lead.reservationUserId) {
      // Account upgrade and lead conversion share the same commit as reservation ownership.
      clientUser = await require('mongoose').connection.transaction(async session => {
        const current = await leadModel.findById(leadId).session(session);
        const actor = await userModel.findById(req.userId).session(session);
        const account = current && await userModel.findById(current.reservationUserId).session(session);
        if (!actor?.roles?.includes('admin') || actor.isActive === false || actor.deletedAt) throw new Error('Current admin access required');
        if (!current || current.deletedAt || current.convertedToUserId || current.guestUserId
          || !isUpgradeableMember(account) || account.isActive === false || current.email !== account.email
          || current.email !== cleanEmail || current.phone !== lead.phone) throw new Error('Lead or linked account changed. Refresh before converting.');
        const upgraded = await upgradeMemberToClient(account, { phone: cleanPhone, session });
        current.convertedToUserId = upgraded._id; current.status = 'Won';
        await current.save({ session });
        return upgraded;
      });
    } else {
      clientUser = memberToUpgrade
        ? await upgradeMemberToClient(memberToUpgrade, { phone: cleanPhone })
        : await createClientAccount({ name: lead.name, email: cleanEmail, phone: cleanPhone });
      lead.convertedToUserId = clientUser._id;
      lead.status = "Won";
      await lead.save();
    }

    // "Client account created" mail: prepared for the admin's Send / Don't Send review and
    // dropped if this response fails. It never carries the default password.
    await sendClientAccountCreatedEmail(clientUser);

    return res.json({
      message: memberToUpgrade
        ? "Existing website account turned into the client account"
        : "Lead converted to client successfully",
      data: {
        userId: clientUser._id,
        email: clientUser.email,
        defaultPassword: CLIENT_DEFAULT_PASSWORD,
        upgradedExisting: Boolean(memberToUpgrade),
      },
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error converting lead:", error);
    return res.status(400).json({
      message: error.message || "Failed to convert lead",
      error: true,
      success: false,
    });
  }
};

module.exports = convertLeadController;
