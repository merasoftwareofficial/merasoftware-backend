const Order = require('../models/orderProductModel');
require('../models/productModel'); // registered for the productId populate below
const User = require('../models/userModel');
const Invoice = require('../models/invoiceModel');
const { EmailDraft } = require('../models/emailControlModel');
const { queueMail } = require('./emailController');
const { buildTemplatedMail } = require('./emailTemplates');
const { byKey } = require('./emailCatalog');
const generateInvoiceNumber = require('./generateInvoiceNumber');
const { getOrderDisplayName } = require('./orderPresentation');
const { isProjectOrder, isCancelled } = require('./orderStatusEngine');

// Send Upgrade on a completed project's page. Fully manual: the admin picks one of three messages and sends it
// whenever they like; nothing waits, counts down or follows up. The review popup, channels, sending, the WhatsApp
// queue and History are the normal ones. Only Upgrade completed leaves a record: a ₹0 complimentary_upgrade
// invoice on the same project. That invoice is the one record every surface reads (project page, purchase
// history, invoices), so they can never disagree. It is not an order: no order engine ever sees it.
const EVENTS = ['project.upgrade.offer', 'project.upgrade.started', 'project.upgrade.completed'];
const COMPLETED = 'project.upgrade.completed';
const TYPE = 'complimentary_upgrade';
const NOTE = 'This upgrade was provided free of cost, at our own choice. No payment is due for it. It is a one-time complimentary service and does not create any obligation for further free work or maintenance.';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const loadOrder = id => Order.findById(id).populate('productId', 'serviceName category').lean();

/** Prepares the chosen message in the current request, so the portal opens the review popup. */
async function prepare(orderId, event) {
  if (!EVENTS.includes(event)) fail('Choose one of the upgrade messages.', 400);
  const order = await loadOrder(orderId);
  if (!order) fail('Project not found', 404);
  if (!isProjectOrder(order) || isCancelled(order) || Number(order.projectProgress) < 100) fail('Send Upgrade is only for a completed project.');
  const customer = await User.findById(order.userId).select('name email phone isActive deletedAt').lean();
  if (!customer || customer.isActive === false || customer.deletedAt) fail('This project has no active customer to message.');
  const mail = buildTemplatedMail(event, customer, order);
  const result = mail && await queueMail(event, { ...mail, orderId: order._id });
  if (!result?.draftId) fail(`No message could be prepared: check the customer's email and WhatsApp number, and that ${byKey.get(event).label} is On in Email Templates.`);
}

/** After a send (emailController.decide): Upgrade completed leaves its ₹0 invoice. A retry of the same message never adds a second. */
async function recordCompleted(draftId) {
  const draft = await EmailDraft.findById(draftId).select('event orderId').lean();
  if (draft?.event !== COMPLETED || !draft.orderId) return null;
  const existing = await Invoice.findOne({ emailDraftId: draft._id }).lean();
  if (existing) return existing;
  const order = await loadOrder(draft.orderId);
  if (!order) return null;
  const now = new Date();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await Invoice.create({
        userId: order.userId, orderId: order._id, invoiceNumber: await generateInvoiceNumber(), invoiceType: TYPE,
        amount: 0, amountPaid: 0, status: 'paid', invoiceDate: now, dueDate: now, paidDate: now,
        lineItems: [{ name: `Complimentary upgrade — ${getOrderDisplayName(order, 'Project')}`, price: 0 }],
        notes: NOTE, emailDraftId: draft._id,
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      if (error.keyPattern?.emailDraftId) return Invoice.findOne({ emailDraftId: draft._id }).lean();
      // Another invoice took the same number at the same moment: the next attempt takes the following one.
    }
  }
  throw new Error('Could not number the complimentary invoice');
}

/** The complimentary invoices matching `filter` (an order, or a customer), newest first. */
const listFor = filter => Invoice.find({ ...filter, invoiceType: TYPE })
  .sort({ invoiceDate: -1 }).select('invoiceNumber invoiceType amount status invoiceDate lineItems').lean();

module.exports = { EVENTS, TYPE, prepare, recordCompleted, listFor };
