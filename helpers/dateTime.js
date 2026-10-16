/** Backend time policy: UTC persistence; IST human output and calendar queries. */
const INDIA_TIME_ZONE = 'Asia/Kolkata';
function date(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}
function formatIndiaDate(value, options = {}) {
  const result = date(value);
  return result ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', ...options, timeZone: INDIA_TIME_ZONE }).format(result) : '—';
}
function formatIndiaDateTime(value, options = {}) {
  const result = date(value);
  return result ? `${new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, ...options, timeZone: INDIA_TIME_ZONE }).format(result)} IST` : '—';
}
function indiaYear(value) { return formatIndiaDate(value, { day: undefined, month: undefined, year: 'numeric' }); }
function indiaDayKey(value = Date.now()) {
  const result = date(value);
  if (!result) throw new Error('Invalid date');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: INDIA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(result);
  const part = name => parts.find(p => p.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function indiaDayStart(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use an India calendar date (YYYY-MM-DD)');
  const result = date(`${value}T00:00:00+05:30`);
  if (!result || indiaDayKey(result) !== value) throw new Error('Invalid calendar date');
  return result;
}
module.exports = { INDIA_TIME_ZONE, formatIndiaDate, formatIndiaDateTime, indiaYear, indiaDayKey, indiaDayStart };
