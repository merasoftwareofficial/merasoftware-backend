const { Inbox } = require('../whatsapp/src/models.js');

// Every minute (index.js). So far Auto Reply only recognises messages, so a recognised row is closed with
// nothing done, and can't send or make a lead later. Rows with no number stay visible for the admin.
async function processInbox() {
  if (process.env.ENABLE_WHATSAPP !== 'true') return { reason: 'disabled', closed: 0 };
  const { modifiedCount } = await Inbox.updateMany({ status: 'new' }, { $set: { status: 'closed', outcome: 'detected-only' } });
  return { reason: 'done', closed: modifiedCount };
}

module.exports = { processInbox };
