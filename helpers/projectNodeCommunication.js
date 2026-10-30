const User = require('../models/userModel');
const { EmailDraft, EmailHistory, EmailPolicy } = require('../models/emailControlModel');
const { queueMail, registerReviewDraft } = require('./emailController');
const { buildTemplatedMail } = require('./emailTemplates');
const { getOrderDisplayName } = require('./orderPresentation');

// A saved node is the business event. Retrying its message never repeats the node mutation.
async function prepareNodeMessage(req, order, node) {
  const dedupeKey = `project-node:${order._id}:${node.nodeId}`;
  if (await EmailPolicy.exists({ event: 'sendProjectUpdateEmail', mode: 'off' })) return { emailStatus: 'disabled-or-unavailable' };
  if (node.status !== 'active' || !node.visibleToClient || node.editedAt || node.cumulativeProgress <= 0 || !order.projectRuns.some(run => run.runId === node.runId && run.status === 'active')) return { emailStatus: 'not-available' };
  const existing = await EmailDraft.findOne({ dedupeKey }).lean();
  if (existing) {
    if (registerReviewDraft(existing)) return {};
    return { emailStatus: existing.expiresAt <= new Date() ? 'expired' : existing.status };
  }
  if (await EmailHistory.exists({ dedupeKey })) return { emailStatus: 'already-processed' };
  const customer = await User.findById(order.userId).select('name email phone isActive deletedAt').lean();
  if (!customer || customer.isActive === false || customer.deletedAt) return { emailStatus: 'no-recipient' };
  const mail = buildTemplatedMail('sendProjectUpdateEmail', customer, {
    projectName: getOrderDisplayName(order), checkpointName: node.title,
    projectProgress: node.cumulativeProgress, portalUrl: process.env.FORNTEND_URL ? `${process.env.FORNTEND_URL.replace(/\/$/, '')}/project-details/${order._id}` : '',
  });
  if (!mail) return { emailStatus: 'no-recipient' };
  const result = await queueMail('sendProjectUpdateEmail', { ...mail, dedupeKey });
  return result.queued ? {} : { emailStatus: 'disabled-or-unavailable' };
}

async function safePrepareNodeMessage(req, order, node) {
  try { return await prepareNodeMessage(req, order, node); }
  catch (error) {
    console.error('[project-node] Message preparation failed:', error.message);
    req.emailPreparationFailed = true;
    return { emailStatus: 'unavailable' };
  }
}
module.exports = { safePrepareNodeMessage };
