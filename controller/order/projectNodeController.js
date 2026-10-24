const mongoose = require("mongoose");
const orderProductModel = require("../../models/orderProductModel");
const {
  appendProjectNode,
  editProjectNode,
  resetProjectTimeline,
  restoreProjectNodes,
  setProjectNodeVisibility,
  softDeleteProjectNodes,
} = require("../../helpers/projectNodeService");
const { activateAfterProjectServices } = require('../../helpers/serviceLifecycle');

const requireAdmin = (req, res) => {
  if (req.userRole !== "admin") {
    res.status(403).json({ success: false, error: true, message: "Forbidden" });
    return false;
  }
  return true;
};

const getOrderForAdmin = async (req, res) => {
  const { orderId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    res.status(400).json({ success: false, error: true, message: "Valid orderId is required" });
    return null;
  }

  const order = await orderProductModel.findById(orderId);
  if (!order) {
    res.status(404).json({ success: false, error: true, message: "Project order not found" });
    return null;
  }
  if (!order.isWebsiteProject) {
    res.status(400).json({ success: false, error: true, message: "Node operations are supported only for projects" });
    return null;
  }
  if (order.offerReservationId && !await require('../../models/userModel').exists({ _id: req.userId, roles: 'admin', isActive: { $ne: false }, deletedAt: null })) {
    res.status(403).json({ success: false, error: true, message: 'Current portal admin access required' });
    return null;
  }
  if (order.projectTimelineVersion !== 1 || !order.projectTimelineInitialized) {
    res.status(409).json({
      success: false,
      error: true,
      message: "Project timeline must be migrated before node operations are enabled",
    });
    return null;
  }
  return order;
};

const saveResponse = async (res, order, message, actorId) => {
  // One document commit saves the node and first-trigger fact together. Concurrent
  // first updates must refresh rather than overwrite the original trigger.
  if (order.offerReservationId && order.isModified('offerFirstWorkUpdate') && order.offerFirstWorkUpdate) {
    order.$where = { ...order.$where, offerFirstWorkUpdate: null };
  }
  await order.save();
  if (order.projectProgress >= 100) {
    await activateAfterProjectServices({ projectOrderId: order._id, actorId });
  }
  return res.status(200).json({ success: true, error: false, message, data: order });
};

const createProjectNode = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const order = await getOrderForAdmin(req, res);
    if (!order) return;

    const node = appendProjectNode({
      order,
      title: req.body?.title,
      cumulativeProgress: req.body?.cumulativeProgress,
      actorId: req.userId,
    });

    const messageText = String(req.body?.message || "").trim();
    if (messageText) {
      order.messages.push({
        sender: "admin",
        senderId: req.userId,
        message: messageText,
        timestamp: new Date(),
        checkpointName: node.title,
        nodeId: node.nodeId,
        runId: node.runId,
      });
      const savedMessage = order.messages[order.messages.length - 1];
      node.messageIds.push(String(savedMessage._id));
    }

    return await saveResponse(res, order, "Project node created successfully", req.userId);
  } catch (error) {
    console.error("Error creating project node:", error);
    return res.status(400).json({ success: false, error: true, message: error.message });
  }
};

const editProjectNodeController = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const order = await getOrderForAdmin(req, res);
    if (!order) return;

    const node = editProjectNode({
      order,
      nodeId: req.body?.nodeId,
      title: req.body?.title,
      cumulativeProgress: req.body?.cumulativeProgress,
      actorId: req.userId,
    });

    const messageText = String(req.body?.message || "").trim();
    if (messageText) {
      order.messages.push({
        sender: "admin",
        senderId: req.userId,
        message: messageText,
        timestamp: new Date(),
        checkpointName: node.title,
        nodeId: node.nodeId,
        runId: node.runId,
      });
      const savedMessage = order.messages[order.messages.length - 1];
      node.messageIds.push(String(savedMessage._id));
    }

    return await saveResponse(res, order, "Project node updated successfully", req.userId);
  } catch (error) {
    console.error("Error editing project node:", error);
    return res.status(400).json({ success: false, error: true, message: error.message });
  }
};

const deleteProjectNodes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const order = await getOrderForAdmin(req, res);
    if (!order) return;
    softDeleteProjectNodes({ order, nodeIds: req.body?.nodeIds, actorId: req.userId });
    return await saveResponse(res, order, "Project node(s) deleted successfully");
  } catch (error) {
    console.error("Error deleting project nodes:", error);
    return res.status(400).json({ success: false, error: true, message: error.message });
  }
};

const restoreProjectNodesController = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const order = await getOrderForAdmin(req, res);
    if (!order) return;
    restoreProjectNodes({ order, nodeIds: req.body?.nodeIds, actorId: req.userId });
    return await saveResponse(res, order, "Project node(s) restored successfully");
  } catch (error) {
    console.error("Error restoring project nodes:", error);
    return res.status(400).json({ success: false, error: true, message: error.message });
  }
};

const setProjectNodeVisibilityController = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const order = await getOrderForAdmin(req, res);
    if (!order) return;
    setProjectNodeVisibility({
      order,
      nodeIds: req.body?.nodeIds,
      visibleToClient: req.body?.visibleToClient,
      actorId: req.userId,
    });
    return await saveResponse(res, order, "Project node visibility updated successfully");
  } catch (error) {
    console.error("Error updating project node visibility:", error);
    return res.status(400).json({ success: false, error: true, message: error.message });
  }
};

const resetProjectNodes = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const order = await getOrderForAdmin(req, res);
    if (!order) return;
    resetProjectTimeline({
      order,
      startingNodeTitle: req.body?.startingNodeTitle,
      actorId: req.userId,
    });
    return await saveResponse(res, order, "Project timeline reset successfully");
  } catch (error) {
    console.error("Error resetting project timeline:", error);
    return res.status(400).json({ success: false, error: true, message: error.message });
  }
};

module.exports = {
  createProjectNode,
  editProjectNode: editProjectNodeController,
  deleteProjectNodes,
  restoreProjectNodes: restoreProjectNodesController,
  setProjectNodeVisibility: setProjectNodeVisibilityController,
  resetProjectNodes,
};
