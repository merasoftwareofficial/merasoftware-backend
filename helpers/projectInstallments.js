// Calculate in paise; the last installment absorbs the remainder exactly.
function buildInstallments(totalAmount, installmentCount) {
  const splits = Number(installmentCount) === 3 ? [30, 30, 40] : [50, 50];
  const thresholds = splits.length === 3 ? [null, 50, 90] : [null, 90];
  const totalPaise = Math.round(Number(totalAmount) * 100);
  let allocated = 0;
  return splits.map((percentage, index) => {
    const paise = index === splits.length - 1 ? totalPaise - allocated : Math.round(totalPaise * percentage / 100);
    allocated += paise;
    return { installmentNumber: index + 1, percentage, amount: paise / 100, paid: false, paymentStatus: 'none', progressThreshold: thresholds[index] };
  });
}
// An offer may let the customer choose the first (token) payment. It is a real
// first installment, so every existing invoice, approval and refund path can
// keep treating a settled first bill as the project-start milestone.
function buildAdvanceInstallments(totalAmount, installmentCount, advanceAmount) {
  const totalPaise = Math.round(Number(totalAmount) * 100);
  const advancePaise = Math.round(Number(advanceAmount) * 100);
  const count = Number(installmentCount);
  if (!Number.isInteger(count) || ![2, 3].includes(count)) throw new Error('Choose a valid payment schedule');
  if (!(advancePaise > 0) || advancePaise > totalPaise) throw new Error('Choose a valid advance payment');
  if (advancePaise === totalPaise) return [];
  const thresholds = count === 3 ? [null, 50, 90] : [null, 90];
  const amounts = [advancePaise];
  const remaining = totalPaise - advancePaise;
  for (let index = 1, allocated = 0; index < count; index += 1) {
    const paise = index === count - 1 ? remaining - allocated : Math.round(remaining / (count - 1));
    allocated += paise; amounts.push(paise);
  }
  return amounts.map((paise, index) => ({ installmentNumber: index + 1,
    percentage: Math.round(paise / totalPaise * 10000) / 100,
    amount: paise / 100, paid: false, paymentStatus: 'none', progressThreshold: thresholds[index] }));
}
const addMonths = (date, months) => { const result = new Date(date); result.setMonth(result.getMonth() + Number(months || 0)); return result; };
module.exports = { buildInstallments, buildAdvanceInstallments, addMonths };
