const userModel = require("../../models/userModel");
const uploadProductPermission = require("../../helpers/permission");

async function addRoleToUserController(req, res) {
  try {
    // Admin-only: this is how every portal role is granted. Checked against the
    // database, not the token's role, which a role switch can change.
    if (!(await uploadProductPermission(req.userId))) {
      return res.status(403).json({
        success: false,
        error: true,
        message: "Permission denied",
      });
    }

    const { userId, role } = req.body;

    if (!userId) {
      throw new Error("User ID is required");
    }
    if (!role) {
      throw new Error("Role is required");
    }

    const user = await userModel.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const roleLower = role.toLowerCase();

    if (user.roles.includes(roleLower)) {
      throw new Error("User already has this role");
    }

    // Single role system - replace existing role instead of adding
    user.roles = [roleLower];
    await user.save();

    res.status(200).json({
      success: true,
      error: false,
      message: "Role added to user successfully",
      data: { ...user.toObject(), password: undefined, plainPassword: undefined },
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: true,
      message: err.message || "Failed to add role to user",
    });
  }
}

module.exports = addRoleToUserController;
