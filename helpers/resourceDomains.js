// Ownership metadata only. Customer signals never contain business records.
const { FinalMessage, State, Queue, Rule, Inbox } = require('../whatsapp/src/models');
const { EmailTemplate, EmailPolicy, EmailDraft, EmailHistory } = require('../models/emailControlModel');
const { Broadcast, BroadcastRecipient } = require('../models/broadcastModel');
const definitions = [
  ...[State, Queue, Rule, Inbox, EmailTemplate, EmailPolicy, EmailDraft, EmailHistory, Broadcast, BroadcastRecipient].map(model => ['communication', model, null]),
  ['users', require('../models/userModel'), '_id'],
  ['orders', require('../models/orderProductModel'), 'userId'],
  ['payments', require('../models/transactionModel'), 'userId'],
  ['invoices', require('../models/invoiceModel'), 'userId'],
  ['invoices', require('../models/monthlyInvoiceModel'), 'userId'],
  ['tickets', require('../models/ticketModel'), 'userId'],
  ['uploads', require('../models/uploadSubmissionModel'), 'ownerId'],
  ['upload-links', require('../models/externalUploadLinkModel'), 'customerId'],
  ['updates', require('../models/updateRequestModel'), 'userId'],
  ['offers', require('../models/offerReservationModel'), 'userId'],
  ['catalog', require('../models/productModel'), '*'],
  ['catalog', require('../models/categoryBasePriceModel'), '*'],
  ['catalog', require('../models/servicePlanCategoryModel'), '*'],
  ['settings', require('../models/adminSettingsModel'), null],
  ['leads', require('../models/leadModel'), ['referredByUserId', 'convertedToUserId', 'requestedByUserId', 'reservationUserId']],
  ['leads', require('../models/offerTargetModel'), null],
  ['leads', FinalMessage, null],
];
module.exports = definitions.map(([domain, model, owner]) => ({ domain, model, owner, collection: model.collection.name }));
