// A lead "has a name" only when a person gave it: the admin, or the person on a form. A name the
// auto reply guessed from the WhatsApp profile (leadModel.nameFromWhatsapp) is shown, but every rule
// that waits for a name (Inquiry → Contacted, stage moves, broadcasts by name, convert) treats it as none.
const hasConfirmedName = (lead) => Boolean(String(lead?.name || "").trim()) && !lead?.nameFromWhatsapp;

module.exports = { hasConfirmedName };
