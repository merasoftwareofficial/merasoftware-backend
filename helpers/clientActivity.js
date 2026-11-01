const Order = require('../models/orderProductModel');
const Update = require('../models/updateRequestModel');
const Transaction = require('../models/transactionModel');
const Invoice = require('../models/monthlyInvoiceModel');
const Ticket = require('../models/ticketModel');

const field = (value, source) => ({ value, source });
const array = (path, date, source) => ({ $map: { input: { $ifNull: [path, []] }, as: 'row', in: field(`$$row.${date}`, source) } });
const first = (...fields) => fields.reduceRight((fallback, value) => ({ $ifNull: [value, fallback] }), null);
const definitions = [
  [Order, { $concatArrays: [
    [field('$createdAt', 'purchase'), field('$updatedAt', 'project_updated'), field('$lastUpdated', 'project_updated')],
    array('$checkpoints', 'completedAt', 'checkpoint_completed'), array('$messages', 'timestamp', 'project_message'),
    array('$projectNodeEvents', 'occurredAt', 'project_node_updated'), array('$monthlyRenewalHistory', 'renewalDate', 'plan_renewed'),
  ] }],
  [Update, { $concatArrays: [
    [field('$createdAt', 'update_request'), field('$updatedAt', 'update_request_updated'), field('$completedAt', 'update_completed')],
    array('$instructions', 'timestamp', 'update_request'), array('$developerNotes', 'timestamp', 'developer_note'), array('$developerMessages', 'timestamp', 'developer_message'),
  ] }],
  [Transaction, [field({ $switch: { branches: [
    { case: { $or: [{ $eq: ['$paymentStatus', 'approved'] }, { $eq: ['$status', 'completed'] }] }, then: first('$verificationDate', '$updatedAt', '$createdAt') },
    { case: { $or: [{ $eq: ['$paymentStatus', 'rejected'] }, { $eq: ['$status', 'rejected'] }] }, then: first('$rejectedAt', '$verificationDate', '$updatedAt', '$createdAt') },
  ], default: first('$createdAt', '$date', '$updatedAt') } }, 'payment_updated')]],
  [Invoice, [field({ $cond: [{ $eq: ['$status', 'paid'] }, first('$paidDate', '$updatedAt'), first('$updatedAt', '$createdAt')] }, { $cond: [{ $eq: ['$status', 'paid'] }, 'invoice_paid', 'invoice_updated'] })]],
  [Ticket, { $concatArrays: [
    [field('$createdAt', 'ticket_created'), field('$updatedAt', 'ticket_updated')],
    array('$messages', 'timestamp', 'ticket_message'), array('$statusHistory', 'timestamp', 'ticket_status_updated'),
  ] }],
];

// Aggregate only the latest activity per client, rather than transferring every
// order/message/checkpoint to Node. Candidate order and strict ties match legacy.
async function readClientActivity(clientIds) {
  if (!clientIds.length) return new Map();
  const groups = await Promise.all(definitions.map(([model, candidates]) => model.aggregate([
    { $match: { userId: { $in: clientIds } } },
    { $sort: { _id: 1 } },
    { $project: { userId: 1, activity: { $reduce: {
      input: candidates, initialValue: { timestamp: 0, value: null, source: 'client_created' },
      in: { $let: { vars: { date: { $convert: { input: '$$this.value', to: 'date', onError: null, onNull: null } } }, in: {
        $cond: [{ $gt: [{ $ifNull: [{ $convert: { input: '$$date', to: 'long', onError: 0, onNull: 0 } }, 0] }, '$$value.timestamp'] },
          { timestamp: { $toLong: '$$date' }, value: '$$this.value', source: '$$this.source' }, '$$value'],
      } } },
    } } } },
    { $sort: { 'activity.timestamp': -1, _id: 1 } },
    { $group: { _id: '$userId', activity: { $first: '$activity' } } },
  ])));
  const result = new Map();
  for (const rows of groups) for (const row of rows) {
    const key = String(row._id);
    if (!result.has(key) || row.activity.timestamp > result.get(key).timestamp) result.set(key, row.activity);
  }
  return result;
}
module.exports = readClientActivity;
