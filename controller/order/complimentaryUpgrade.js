const { prepare } = require("../../helpers/complimentaryUpgrade");

const reply = (res, status, message) => res.status(status).json({ message, error: status >= 400, success: status < 400 });

// Send Upgrade on a completed project's page: the normal review popup opens from this response (helpers/emailController.js).
const complimentaryUpgradeController = async (req, res) => {
  try {
    if (req.userRole !== "admin") return reply(res, 403, "Forbidden");
    await prepare(req.params.orderId, req.body?.event);
    return reply(res, 200, "Message prepared");
  } catch (error) {
    if (!error.status) console.error("Error preparing the upgrade message:", error);
    return reply(res, error.status || 400, error.message || "Failed to prepare the message");
  }
};

module.exports = complimentaryUpgradeController;
