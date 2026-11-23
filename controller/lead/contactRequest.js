const { requireIntegration } = require("../../helpers/integrationAuth");
const { parsePhone } = require("../../helpers/phoneNumber");

const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};

/**
 * Public Contact Us form submission from the website (PATCH /api/integration/contact-request).
 * Validates the visitor's contact details without creating a Lead.
 */
async function integrationContactRequest(req, res) {
  try {
    await requireIntegration(req);
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const project = String(body.project || "").trim();
    const message = String(body.message || "").trim();

    if (name.length < 2) fail("Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Please enter a valid email address.");
    if (!project) fail("Please select what you need.");
    const phone = parsePhone({ countryCode: body.countryCode || "+91", phone: body.phone });

    return res.set("Cache-Control", "no-store").status(200).json({
      success: true,
      error: false,
      message: "Request received",
      data: { submitted: true, contact: { name, email, phone, project, message } },
    });
  } catch (error) {
    if (!error.statusCode) console.error("Error handling contact request:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: true,
      message: error.statusCode ? error.message : "Could not send your request. Please try again.",
    });
  }
}

module.exports = { integrationContactRequest };
