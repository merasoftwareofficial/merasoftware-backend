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
// A monthly package project (merasoftware/src/docs/package.md decision 9): one installment per billing
// cycle, due on its date (dueBy 'date'), never by progress. Cycle 1 is due at creation. Every cycle costs
// the same whole-rupee cyclePrice; the percentages are in paise-free hundredths, the last absorbing the rest.
const addMonths = (date, months) => { const result = new Date(date); result.setMonth(result.getMonth() + Number(months || 0)); return result; };
function buildCycleInstallments(cyclePrice, totalCycles, cycleMonths, start = new Date()) {
  let allocated = 0;
  return Array.from({ length: Number(totalCycles) }, (_, index) => {
    const percentage = index === totalCycles - 1 ? Math.round((100 - allocated) * 100) / 100 : Math.round(10000 / totalCycles) / 100;
    allocated += percentage;
    return { installmentNumber: index + 1, percentage, amount: Number(cyclePrice), paid: false, paymentStatus: 'none',
      progressThreshold: null, dueBy: 'date', dueDate: addMonths(start, index * cycleMonths) };
  });
}
module.exports = { buildInstallments, buildCycleInstallments, addMonths };
