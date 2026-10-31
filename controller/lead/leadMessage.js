const leadModel = require("../../models/leadModel");
const { prepare } = require("../../helpers/leadMessage");

const reply = (res, status, message) => res.status(status).json({ message, error: status >= 400, success: status < 400 });

// The lead page's Send message button: the normal review popup opens from this response (helpers/emailController.js).
const leadMessageController = async (req, res) => {
  try {
    if (req.userRole !== "admin") return reply(res, 403, "Forbidden");
    const lead = await leadModel.findOne({ _id: req.params.leadId, deletedAt: null }).lean();
    if (!lead) return reply(res, 404, "Lead not found");
    return await prepare(lead)
      ? reply(res, 200, "Message prepared")
      : reply(res, 409, "No message could be prepared: check this lead's WhatsApp number and email, and that a message type is On in Email Templates.");
  } catch (error) {
    console.error("Error preparing the lead message:", error);
    return reply(res, 400, error.message || "Failed to prepare the message");
  }
};

module.exports = leadMessageController;
