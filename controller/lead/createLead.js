const leadModel = require("../../models/leadModel");
const userModel = require("../../models/userModel");
const AdminSettings = require("../../models/adminSettingsModel");
const { creditWalletInstant } = require("../../helpers/transactionService");
const { findLeadsByPhone, phoneKey } = require("../../helpers/leadPhone");
const { isAccountEmail } = require("../../helpers/emailValidator");
const { memberOnPhone } = require("../../helpers/personLead");

const createLeadController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { name, phone, email, source, notes, referredByUserId, businessName, altPhone } = req.body;

    const cleanName = (name || "").trim();
    const cleanPhone = (phone || "").trim();
    const cleanEmail = (email || "").trim().toLowerCase();
    // Optional extras: search and contact only, never used to match or block a person.
    const cleanBusinessName = String(businessName || "").trim();
    const cleanAltPhone = String(altPhone || "").trim();

    // Only meaningful when Source = "Reference" and an existing customer was
    // matched/selected in the Add Lead form. Validated here so a stale/tampered
    // id can never silently link to the wrong (or no) customer.
    let cleanReferredByUserId = null;
    if (referredByUserId) {
      const referrer = await userModel.findById(referredByUserId).select("_id");
      if (!referrer) {
        return res.status(400).json({
          message: "Selected reference customer not found",
          error: true,
          success: false,
        });
      }
      cleanReferredByUserId = referrer._id;
    }

    if (!cleanName) {
      return res.status(400).json({
        message: "Please provide lead name",
        error: true,
        success: false,
      });
    }

    if (!cleanPhone) {
      return res.status(400).json({
        message: "Please provide a phone number",
        error: true,
        success: false,
      });
    }

    // Same rule as Edit Lead (updateLead.js "editDetails"): an email that is there must be a real address.
    if (cleanEmail && !isAccountEmail(cleanEmail)) {
      return res.status(400).json({
        message: "Please provide a valid email address",
        error: true,
        success: false,
      });
    }

    if (cleanAltPhone && phoneKey(cleanAltPhone) === phoneKey(cleanPhone)) {
      return res.status(400).json({
        message: "The alternate number is the same as the phone number",
        error: true,
        success: false,
      });
    }

    // Duplicate guard within leads only (phone or email match)
    const duplicateOr = [];
    if (cleanEmail) duplicateOr.push({ email: cleanEmail });
    if (cleanPhone) duplicateOr.push({ phone: cleanPhone });

    if (duplicateOr.length) {
      const existingLead = await leadModel.findOne({ $or: duplicateOr }).lean();
      if (existingLead || (await findLeadsByPhone(cleanPhone)).length) {
        return res.status(409).json({
          message: "A lead with this phone or email already exists",
          error: true,
          success: false,
        });
      }
    }

    // One main phone = one person: a website member on this number gets this lead as their one lead.
    const { member, conflict } = await memberOnPhone(cleanPhone);
    if (conflict) return res.status(409).json({ message: conflict, error: true, success: false });

    const lead = new leadModel({
      ...(member ? { reservationUserId: member._id } : {}),
      name: cleanName,
      businessName: cleanBusinessName,
      phone: cleanPhone,
      altPhone: cleanAltPhone,
      email: cleanEmail,
      source: (source || "").trim(),
      notes: notes || "",
      referredByUserId: cleanReferredByUserId,
      createdBy: req.userId,
    });

    const savedLead = await lead.save();

    // Reference reward: credited instantly on link (not on conversion), no cap
    // on repeat references — confirmed with the user. Deterministic
    // transactionId keyed on the lead keeps this idempotent against retries.
    // Isolated in its own try/catch: the lead is already saved by this point,
    // so a reward-credit failure (rare DB glitch) must never turn into a false
    // "lead not created" error for the admin — it's logged for follow-up instead.
    if (cleanReferredByUserId) {
      try {
        const settings = await AdminSettings.getSettings();
        const rewardAmount = settings.leadReferralRewardAmount;

        if (rewardAmount > 0) {
          // Not using userModel.referrals[] here: that array's userId is typed
          // (and used elsewhere) as a real converted user, never a raw lead —
          // pushing a leadId into it would corrupt that shape. The credited
          // transaction (referredBy field, see transactionService.js) plus
          // lead.referredByUserId together are the full audit trail here.
          await creditWalletInstant({
            userId: cleanReferredByUserId,
            transactionId: `LEADREF-${savedLead._id}`,
            amount: rewardAmount,
            paymentMethod: "reward",
            description: `Reward for referring lead: ${cleanName}`,
            actorId: req.userId,
          });
        }
      } catch (rewardError) {
        console.error(
          `Lead ${savedLead._id} created, but reference reward credit failed for user ${cleanReferredByUserId}:`,
          rewardError
        );
      }
    }

    // The lead is saved regardless of the mail choice. Delivery happens only
    // after a successful response and an explicit, reviewed Send Mail decision.
    if ((cleanEmail || req.body.emailReview?.channels === 'whatsapp') && req.body.emailReview?.choice === 'send') {
      try {
        const { queueMail } = require('../../helpers/emailController');
        const { reviewTextFromEditor, reviewSubjectFromEditor, resolveTemplate } = require('../../helpers/emailTemplates');
        // The popup sends the editor's document; the send decision after the response reads this text.
        const text = reviewTextFromEditor('lead.created', req.body.emailReview, { name: cleanName }, {});
        const subject = reviewSubjectFromEditor('lead.created', req.body.emailReview, { name: cleanName });
        const original = req.body.emailReview.templateId && req.body.emailReview.templateId !== 'current' ? await resolveTemplate('lead.created', req.body.emailReview.templateId) : null;
        req.body.emailReview = { ...req.body.emailReview, text, subject };
        await queueMail('lead.created', {
          to: cleanEmail ? [cleanEmail] : [], phone: cleanPhone, leadId: savedLead._id, subject, text, reviewed: true, sourceTemplateId: original?._id,
        }, { name: cleanName });
      } catch (mailError) {
        console.error('Lead saved; email draft unavailable:', mailError.message);
        req.emailPreparationFailed = true;
      }
    }

    return res.status(201).json({
      message: "Lead created successfully",
      data: savedLead,
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error creating lead:", error);
    return res.status(400).json({
      message: error.message || "Failed to create lead",
      error: true,
      success: false,
    });
  }
};

module.exports = createLeadController;
