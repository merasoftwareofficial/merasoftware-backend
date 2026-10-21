// The sending rules the owner changes on the admin page (website /admin/whatsapp → Sending rules).
// Stored in whatsapp_state.settings; the worker reads them before every message, so a change applies
// at once. RECOMMENDED is what "Reset to recommended" restores and what applies to anything not saved.
export const RECOMMENDED = Object.freeze({
  minGapSec: 30, // Owner rule: never sooner than 30 seconds after the last message.
  jitterSec: 15, // a random 0–15 seconds more, so the gap is never the same twice
  dailyLimit: 50, // a newly linked number is watched closely by WhatsApp; raise it after a few quiet weeks
  typing: true, // show "typing…" in the chat before each message
  typingMinSec: 2,
  typingMaxSec: 8,
  quietHours: true, // no messages at night (India time); they wait and go in the morning
  quietFrom: 22,
  quietTo: 8,
  retryDelayMin: 5,
  maxAttempts: 3,
  maxAgeHours: 24, // Owner rule: a message still waiting after this long is dropped, never sent late.
});

// [lowest, highest] each number may be set to. Outside these, the risk of a ban is too high or the setting makes no sense.
export const LIMITS = Object.freeze({
  minGapSec: [30, 600], jitterSec: [0, 120], dailyLimit: [1, 300],
  typingMinSec: [0, 20], typingMaxSec: [0, 20],
  quietFrom: [0, 23], quietTo: [0, 23],
  retryDelayMin: [1, 60], maxAttempts: [1, 5], maxAgeHours: [1, 72],
});

const LABELS = {
  minGapSec: 'Gap between messages', jitterSec: 'Random extra gap', dailyLimit: 'Messages per day',
  typing: 'Show "typing…"', typingMinSec: 'Shortest typing time', typingMaxSec: 'Longest typing time',
  quietHours: 'Quiet hours', quietFrom: 'Quiet hours start', quietTo: 'Quiet hours end',
  retryDelayMin: 'Wait before trying again', maxAttempts: 'Tries per message', maxAgeHours: 'Drop a message after',
};

/** null when the value is allowed for this setting, otherwise the reason in plain words. */
function fieldError(key, value) {
  if (typeof RECOMMENDED[key] === 'boolean') return typeof value === 'boolean' ? null : `${LABELS[key]} must be on or off.`;
  const [min, max] = LIMITS[key];
  return Number.isInteger(value) && value >= min && value <= max ? null : `${LABELS[key]} must be a whole number from ${min} to ${max}.`;
}

/** The full set of rules from an admin's form; throws (status 400) with the first problem found. */
export function validateSettings(input) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object') fail('Send all the sending rules.');
  const settings = {};
  for (const key of Object.keys(RECOMMENDED)) {
    const error = fieldError(key, input[key]);
    if (error) fail(error);
    settings[key] = input[key];
  }
  if (settings.typingMinSec > settings.typingMaxSec) fail('Shortest typing time cannot be more than the longest typing time.');
  if (settings.quietHours && settings.quietFrom === settings.quietTo) fail('Quiet hours cannot start and end at the same hour.');
  return settings;
}

/** The rules in force: what was saved, with the recommended value for anything missing or unusable. */
export function effectiveSettings(stored) {
  const settings = { ...RECOMMENDED };
  for (const key of Object.keys(RECOMMENDED)) {
    if (stored && fieldError(key, stored[key]) === null) settings[key] = stored[key];
  }
  return settings;
}

/** Hours from the start to the end of quiet hours, e.g. 22 → 8 is 10. */
export function quietLength(settings) {
  return settings.quietHours ? (settings.quietTo - settings.quietFrom + 24) % 24 : 0;
}

/** Allowed but risky combinations, shown to the admin after loading or saving. */
export function settingsWarnings(settings) {
  const warnings = [];
  if (quietLength(settings) >= settings.maxAgeHours) {
    warnings.push(`Quiet hours last ${quietLength(settings)} hours but messages are dropped after ${settings.maxAgeHours}, so messages made at night will expire without being sent.`);
  }
  return warnings;
}

function hourIn(date, timeZone) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date));
}

/** true while sending is stopped for the night. 22 → 8 covers 22:00 to 07:59. */
export function inQuietHours(settings, date, timeZone) {
  if (!settings.quietHours || settings.quietFrom === settings.quietTo) return false;
  const hour = hourIn(date, timeZone);
  const { quietFrom: from, quietTo: to } = settings;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
