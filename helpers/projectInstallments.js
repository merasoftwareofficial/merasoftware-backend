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
module.exports = { buildInstallments };
