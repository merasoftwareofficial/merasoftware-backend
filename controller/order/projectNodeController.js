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
const { safePrepareNodeMessage } = require('../../helpers/projectNodeCommunication');
const { createHash } = require('node:crypto');

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

  const order = await orderProductModel.findById(orderId).populate('productId', 'serviceName category');
  if (!order) {
    res.status(404).json({ success: false, error: true, message: "Project order not found" });
    return null;
  }
  if (!order.isWebsiteProject) {
    res.status(400).json({ success: false, error: true, message: "Node operations are supported only for projects" });
    return null;
  }
  if (!await require('../../models/userModel').exists({ _id: req.userId, roles: 'admin', isGuest: { $ne: true }, isActive: { $ne: false }, deletedAt: null })) {
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

async function respondWithSavedNode(req, res, order, node) {
  let serviceActivationPending = false;
  if (order.projectProgress >= 100) {
    try { await activateAfterProjectServices({ projectOrderId: order._id, actorId: req.userId }); }
    catch (error) { serviceActivationPending = true; console.error('[project-node] Service activation pending:', error.message); }
  }
  const communication = await safePrepareNodeMessage(req, order, node);
  return res.json({ success: true, message: 'Project node saved', data: order, savedNodeId: node.nodeId, serviceActivationPending, ...communication });
}

const createProjectNode = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const order = await getOrderForAdmin(req, res);
    if (!order) return;

    const requestId = req.body?.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(requestId))) throw new Error('Valid request ID required');
    const fingerprint = createHash('sha256').update(JSON.stringify([String(req.userId), String(req.body?.title || '').trim(), Number(req.body?.cumulativeProgress), String(req.body?.message || '').trim()])).digest('hex');
    const previous = requestId && order.projectNodes.find(node => node.clientRequestId === requestId);
    if (previous) {
      if (previous.requestFingerprint !== fingerprint) return res.status(409).json({ success: false, message: 'This request ID belongs to another node update' });
      return await respondWithSavedNode(req, res, order, previous);
    }
    const node = appendProjectNode({
      order,
      title: req.body?.title,
      cumulativeProgress: req.body?.cumulativeProgress,
      actorId: req.userId,
    });
    const savedNode = order.projectNodes.find(row => row.nodeId === node.nodeId);
    savedNode.clientRequestId = requestId;
    savedNode.requestFingerprint = fingerprint;

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
      savedNode.messageIds.push(String(savedMessage._id));
    }

    // Compare-and-set prevents concurrent requests from appending duplicate work.
    order.$where = { ...order.$where, __v: order.__v };
    order.increment();
    await order.save();
    return await respondWithSavedNode(req, res, order, savedNode);
  } catch (error) {
    if (error.name === 'VersionError' || error.name === 'DocumentNotFoundError') return res.status(409).json({ success: false, message: 'The timeline changed. Retry the same node details to confirm the saved update.' });
    console.error("Error creating project node:", error);
    return res.status(400).json({ success: false, error: true, message: error.message });
  }
};

const prepareProjectNodeMessage = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const order = await getOrderForAdmin(req, res);
    if (!order) return;
    const node = order.projectNodes.find(row => row.nodeId === req.body?.nodeId);
    if (!node) return res.status(404).json({ success: false, message: 'Node not found' });
    return res.json({ success: true, savedNodeId: node.nodeId, ...await safePrepareNodeMessage(req, order, node) });
  } catch (error) { return res.status(400).json({ success: false, message: error.message }); }
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
  prepareProjectNodeMessage,
  createProjectNode,
  editProjectNode: editProjectNodeController,
  deleteProjectNodes,
  restoreProjectNodes: restoreProjectNodesController,
  setProjectNodeVisibility: setProjectNodeVisibilityController,
  resetProjectNodes,
};
