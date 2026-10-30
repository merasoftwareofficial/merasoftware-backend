const { AsyncResource } = require("node:async_hooks");
const upload = require("./uploadFiles");
const { MAX_UPLOAD_FILE_SIZE_BYTES } = require("../config/uploadLimits");

// The shared upload policy, with a refused file answered as JSON so the Leads screens can show why.
// The callback is bound to this request because multer's stream events lose the async context, and
// without it the mail scope (helpers/emailController.js) is gone and no review draft can be prepared.
const acceptFiles = upload.any();
const leadFileUpload = (req, res, next) => acceptFiles(req, res, AsyncResource.bind((error) => {
  if (!error) return next();
  const message = error.code === "LIMIT_FILE_SIZE"
    ? `The file must be ${MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024)} MB or smaller`
    : error.message;
  return res.status(400).json({ message, error: true, success: false });
}));

module.exports = leadFileUpload;
