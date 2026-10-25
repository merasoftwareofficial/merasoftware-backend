const Transaction = require('../models/transactionModel');
const { createProjectInvoice } = require('./paymentRecording');
const { getOrderAmountReceived, getInvoiceAmountReceived } = require('./orderPaymentTotals');
const { refundWalletInstant } = require('./transactionService');
const cents = value => Math.round(Number(value) * 100);

// Keep each receipt's identity across allocation legs. Rejection can then return
// only that receipt's remaining money, including amounts carried to later bills.
async function projectReceiptLots(orderId, session) {
  const rows = await Transaction.find({ orderId, status: 'completed', type: { $in: ['payment', 'refund'] } }).sort({ _id: 1 }).session(session).lean();
  const lots = new Map();
  const add = (root, invoiceId, amount) => {
    const key = `${root}:${invoiceId}`;
    const lot = lots.get(key) || { root, invoiceId, amount: 0 };
    lot.amount += amount; lots.set(key, lot);
  };
  for (const row of rows) if (row.type === 'payment' && row.paymentMethod !== 'allocation' && row.invoiceId) add(row.transactionId, String(row.invoiceId), cents(row.amount));
  for (const row of rows) {
    if (row.type === 'payment' && row.paymentMethod !== 'allocation') continue;
    if (!row.invoiceId) continue;
    if (row.parentTransactionId && [...lots.values()].some(lot => lot.root === row.parentTransactionId)) {
      add(row.parentTransactionId, String(row.invoiceId), (row.type === 'refund' ? -1 : 1) * cents(row.amount));
    } else if (row.type === 'refund') {
      let remainder = cents(row.amount);
      for (const lot of lots.values()) {
        if (lot.invoiceId !== String(row.invoiceId)) continue;
        const amount = Math.min(remainder, Math.max(0, lot.amount)); lot.amount -= amount; remainder -= amount;
      }
      if (remainder) throw new Error('Existing receipt reversals need review');
    } else throw new Error('Receipt allocation is missing its original payment');
  }
  if ([...lots.values()].some(lot => lot.amount < 0)) throw new Error('Receipt reversals exceed the original allocation');
  return [...lots.values()];
}

// Existing payment/refund ledger stays the money SSOT. Original receipts remain
// untouched; paired allocation legs move money between bills without wallet movement.
async function reallocateProjectReceipts({ order, invoices, installments, finalPrice, revision, session }) {
  const totalReceived = cents(await getOrderAmountReceived(order._id, { session }));
  const surplus = Math.max(0, totalReceived - cents(finalPrice));
  const key = `PRICE-${order._id}-${revision}`;
  const lots = await projectReceiptLots(order._id, session);
  let creditLeft = surplus;
  const sources = [];
  for (const bill of invoices) {
    let received = cents(await getInvoiceAmountReceived(bill._id, { session }));
    const amount = installments ? cents(installments[bill.installmentNumber - 1].amount) : cents(finalPrice);
    const credit = Math.min(creditLeft, Math.max(0, received - amount));
    if (credit) {
      let creditRemaining = credit;
      for (const lot of lots) {
        if (lot.invoiceId !== String(bill._id) || !creditRemaining) continue;
        const amount = Math.min(creditRemaining, Math.max(0, lot.amount));
        if (!amount) continue;
        await refundWalletInstant({ userId: order.userId, orderId: order._id, invoiceId: bill._id,
          transactionId: `${key}-CREDIT-${bill._id}-${lot.root}`, parentTransactionId: lot.root, amount: amount / 100,
          description: `Price revision ${revision}: surplus project payment credited to wallet`, session });
        lot.amount -= amount; creditRemaining -= amount;
      }
      if (creditRemaining) throw new Error('Surplus payment needs receipt attribution');
      received -= credit; creditLeft -= credit;
    }
    if (received > amount) sources.push({ bill, excess: received - amount });
  }
  if (creditLeft) throw new Error('Project receipts need allocation review before wallet credit');
  if (installments) {
    for (const installment of installments) {
      if (!sources.some(source => source.excess > 0)) break;
      let bill = invoices.find(item => item.installmentNumber === installment.installmentNumber);
      if (!bill) {
        bill = await createProjectInvoice({ customerId: order.userId, orderId: order._id, amount: installment.amount,
          installmentNumber: installment.installmentNumber, dueDate: order.installments[installment.installmentNumber - 1].dueDate || new Date(),
          lineItems: [{ name: `Project installment ${installment.installmentNumber}`, price: installment.amount }], session });
        invoices.push(bill);
      }
      let available = Math.max(0, cents(installment.amount) - cents(await getInvoiceAmountReceived(bill._id, { session })));
      for (const source of sources) {
        if (!available || !source.excess || String(source.bill._id) === String(bill._id)) continue;
        for (const lot of lots) {
          if (lot.invoiceId !== String(source.bill._id)) continue;
          const transfer = Math.min(available, source.excess, Math.max(0, lot.amount));
          if (!transfer) continue;
          const common = { userId: order.userId, orderId: order._id, amount: transfer / 100, status: 'completed', paymentStatus: 'approved',
            parentTransactionId: lot.root, paymentMethod: 'allocation', sourceType: 'invoice', description: `Receipt allocation for price revision ${revision}` };
          await Transaction.create([
            { ...common, transactionId: `${key}-FROM-${source.bill._id}-TO-${bill._id}-${lot.root}`, type: 'refund', invoiceId: source.bill._id },
            { ...common, transactionId: `${key}-TO-${bill._id}-FROM-${source.bill._id}-${lot.root}`, type: 'payment', invoiceId: bill._id },
          ], { session, ordered: true });
          lot.amount -= transfer;
          lots.push({ root: lot.root, invoiceId: String(bill._id), amount: transfer });
          available -= transfer; source.excess -= transfer;
        }
      }
    }
  }
  if (sources.some(source => source.excess)) throw new Error('Could not allocate existing project receipts');
  return { walletCredit: surplus / 100 };
}
module.exports = { reallocateProjectReceipts, projectReceiptLots };
