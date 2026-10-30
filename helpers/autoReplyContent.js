const { decode, encode, render, textToDoc } = require('./broadcastContent');

// Auto Reply's reply message. It goes to a number with no name yet, so it can never hold the name field.
const NO_FIELDS = { fields: [] };
const FIRST_REPLY = `Thanks for reaching out.

ਸਾਡੀ post/video ਦੇਖ ਕੇ contact ਕਰਨ ਲਈ ਧੰਨਵਾਦ। Mera Software ਦੀ team ਜਲਦੀ ਹੀ ਤੁਹਾਡੇ ਨਾਲ ਗੱਲ ਕਰੇਗੀ।

ਅਗਰ ਕੋਈ specific query ਹੈ, ਤਾਂ ਤੁਸੀਂ ਇੱਥੇ message drop ਕਰ ਸਕਦੇ ਹੋ।

Best regards,
Mera Software`;

const replyDoc = rule => (rule?.reply ? decode(rule.reply, NO_FIELDS) : textToDoc(FIRST_REPLY));
const replyText = rule => render(replyDoc(rule));
const encodeReply = doc => encode(doc, NO_FIELDS);

module.exports = { FIRST_REPLY, replyDoc, replyText, encodeReply };
