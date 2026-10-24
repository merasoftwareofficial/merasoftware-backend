const invoiceModel = require("../models/invoiceModel");

const generateInvoiceNumber = async ({ session = null } = {}) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `INV-${year}${month}`;

  const lastInvoice = await invoiceModel
    .findOne({ invoiceNumber: new RegExp(`^${prefix}`) })
    .sort({ invoiceNumber: -1 }).session(session);

  let sequenceNumber = 1;
  if (lastInvoice) {
    const lastSequence = parseInt(lastInvoice.invoiceNumber.split('-')[2], 10);
    sequenceNumber = lastSequence + 1;
  }

  return `${prefix}-${String(sequenceNumber).padStart(4, '0')}`;
};

module.exports = generateInvoiceNumber;
