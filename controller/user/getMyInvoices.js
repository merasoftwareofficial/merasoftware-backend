const mongoose = require('mongoose');
const readCustomerInvoices = require('../../helpers/customerInvoices');
const INVOICE_TYPES = require('../../models/invoiceModel').schema.path('invoiceType').enumValues;
module.exports = async (req, res) => {
  const filter = { userId: req.userId };
  for (const key of ['orderId', 'invoiceId']) {
    if (req.query[key] !== undefined) {
      if (!mongoose.isObjectIdOrHexString(req.query[key])) return res.status(400).json({ success: false, message: 'Invalid invoice filter' });
      filter[key === 'invoiceId' ? '_id' : key] = req.query[key];
    }
  }
  // Purchase history asks for its complimentary upgrades by type (helpers/complimentaryUpgrade.js).
  if (req.query.invoiceType !== undefined) {
    if (!INVOICE_TYPES.includes(req.query.invoiceType)) return res.status(400).json({ success: false, message: 'Invalid invoice filter' });
    filter.invoiceType = req.query.invoiceType;
  }
  try {
    const data = await readCustomerInvoices(filter);
    return res.json({ success: true, error: false, data });
  } catch {
    return res.status(500).json({ success: false, message: 'Could not load invoices' });
  }
};
