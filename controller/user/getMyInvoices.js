const mongoose = require('mongoose');
const readCustomerInvoices = require('../../helpers/customerInvoices');
module.exports = async (req, res) => {
  const filter = { userId: req.userId };
  for (const key of ['orderId', 'invoiceId']) {
    if (req.query[key] !== undefined) {
      if (!mongoose.isObjectIdOrHexString(req.query[key])) return res.status(400).json({ success: false, message: 'Invalid invoice filter' });
      filter[key === 'invoiceId' ? '_id' : key] = req.query[key];
    }
  }
  try {
    const data = await readCustomerInvoices(filter);
    return res.json({ success: true, error: false, data });
  } catch {
    return res.status(500).json({ success: false, message: 'Could not load invoices' });
  }
};
