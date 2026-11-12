const mongoose = require('mongoose');
const { currentAdmin } = require('./offerReservations');
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };

// Controls live on the record owned by each existing scheduler. No separate enrollment engine.
async function setPaused({ source, entityId, paused, expectedPaused, actorId }) {
  if (!mongoose.isValidObjectId(entityId) || typeof paused !== 'boolean' || (expectedPaused !== undefined && typeof expectedPaused !== 'boolean')) fail('Choose a record and reminder state.', 400);
  await currentAdmin(actorId);
  let Model, field, changedAt, changedBy, filter;
  if (source === 'reservation' || source === 'reservation_team') {
    Model = require('../models/offerReservationModel');
    filter = { _id: entityId, projectId: null, confirmedAt: null };
    if (source === 'reservation') {
      Object.assign(filter, { remindersEnabled: true });
      field = 'remindersPaused'; changedAt = 'remindersPauseChangedAt'; changedBy = 'remindersPauseChangedBy';
    } else {
      const row = await Model.findOne({ ...filter, startRequestedAt: { $ne: null } }).select('startRequestedAt startRequests').lean();
      if (!row || !row.startRequests?.length || row.startRequests.at(-1).ended) fail('This start request is no longer open.');
      filter.startRequestedAt = row.startRequestedAt;
      field = 'teamRemindersPaused'; changedAt = 'teamRemindersPauseChangedAt'; changedBy = 'teamRemindersPauseChangedBy';
    }
  } else if (source === 'package_request') {
    Model = require('../models/packageStartRequestModel'); filter = { _id: entityId, closedAt: null };
    field = 'remindersPaused'; changedAt = 'remindersPauseChangedAt'; changedBy = 'remindersPauseChangedBy';
  } else if (source === 'offer_payment') {
    Model = require('../models/invoiceModel');
    const invoice = await Model.findById(entityId).select('orderId').lean();
    const order = invoice && await require('../models/orderProductModel').findById(invoice.orderId).select('paymentPolicy orderVisibility').lean();
    if (!order?.paymentPolicy || order.orderVisibility === 'cancelled') fail('This invoice has no active offer reminder workflow.');
    filter = { _id: entityId, invoiceType: { $in: ['project', 'plan_renewal'] }, status: { $in: ['unpaid', 'partially_paid', 'overdue'] } };
    field = 'offerRemindersPaused'; changedAt = 'offerRemindersPauseChangedAt'; changedBy = 'offerRemindersPauseChangedBy';
  } else fail('Unknown reminder source.', 400);
  if (expectedPaused !== undefined) filter[field] = expectedPaused ? true : { $ne: true };
  const row = await Model.findOneAndUpdate(filter, { $set: { [field]: paused, [changedAt]: new Date(), [changedBy]: actorId } }, { new: true }).lean();
  if (!row) fail('The record or reminder state changed. Refresh and review again.');
  return { source, entityId: String(row._id), paused: !!row[field] };
}
module.exports = { setPaused };
