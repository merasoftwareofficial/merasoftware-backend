const mongoose = require('mongoose');
const leadModel = require('../models/leadModel');
const { INQUIRY, CONTACTED } = require('./leadStatuses');
const { phoneKey, findLeadsByPhone, findLeadsByContactNumber, isReturning, revive } = require('./leadPhone');
const { hasConfirmedName } = require('./leadName');

// One main phone = one person = one lead (merasoftware/src/docs/signup.md §3). A website member's account owns at
// most one lead (leadModel reservationUserId is unique). This file finds or makes that lead, the same way for every
// way in: signup, an offer reservation and a member's plan request. The phone is the identity; email is lead data.
const SIGNUP_SOURCE = 'Website signup';

const line = (note, badge, createdBy) => ({ note, badge, date: new Date(), createdAt: new Date(), ...(createdBy ? { createdBy } : {}) });
const emailOf = value => String(value || '').trim().toLowerCase();
const liveFirst = leads => [...leads.filter(lead => !lead.deletedAt), ...leads.filter(lead => lead.deletedAt)];

/** A lead nobody else owns: not a client's, not a client's project request, not linked to another account. Trash counts. */
const freeFor = userId => ({ convertedToUserId: null, requestedByUserId: null, reservationUserId: { $in: [null, userId] } });
const isFree = (lead, userId) => !lead.convertedToUserId && !lead.requestedByUserId && (!lead.reservationUserId || String(lead.reservationUserId) === String(userId));

async function addNote(lead, note, session) {
  await leadModel.updateOne({ _id: lead._id }, { $push: { followUps: line(note, lead.status) } }, { session });
}

/**
 * The person's lead takes the account: restored from Trash, Inquiry → Contacted, Dead (or Negative in its final
 * message) → Contacted, Wrong stays Wrong. A name the person typed replaces one guessed from WhatsApp.
 */
async function takeOver(lead, user, { session }) {
  if (lead.deletedAt) lead.set({ deletedAt: null, deletedBy: null });
  if (lead.status === INQUIRY) lead.set({ status: CONTACTED });
  else if (await isReturning(lead, { session })) await revive(lead, { name: user.name, email: user.email }, { session });
  if (!hasConfirmedName(lead) && user.name) lead.set({ name: user.name, nameFromWhatsapp: false });
}

/** Signup rule table, cases 3-7 (signup.md §3.6), on the caller's session. Returns { lead, created, phoneChanged }. */
async function linkInSession(user, { session, source, fields }) {
  const email = emailOf(user.email);
  const linked = await leadModel.findOne({ reservationUserId: user._id }).session(session);
  if (linked) {
    // Already this account's lead. A client's or a trashed one is for the team to review (callers say so).
    if (linked.deletedAt || linked.convertedToUserId) return { lead: linked, created: false, phoneChanged: false };
    await takeOver(linked, user, { session });
    await linked.save({ session });
    return { lead: linked, created: false, phoneChanged: false };
  }

  const byPhone = user.phone ? await findLeadsByPhone(user.phone, {}, { session }) : [];
  const byEmail = email ? await leadModel.find({ email }).sort({ updatedAt: -1 }).session(session) : [];
  const phoneLead = liveFirst(byPhone.filter(lead => isFree(lead, user._id)))[0];
  const emailLead = liveFirst(byEmail.filter(lead => isFree(lead, user._id)))[0];
  const who = `${user.email}${user.name ? ` (${user.name})` : ''}`;
  const lead = phoneLead || emailLead;

  // A lead with this number or email that belongs to someone else stays theirs: it only gets a note.
  const noted = new Set(lead ? [String(lead._id)] : []);
  for (const other of [...byPhone, ...byEmail].filter(row => !row.deletedAt && !isFree(row, user._id))) {
    if (noted.has(String(other._id))) continue;
    noted.add(String(other._id));
    await addNote(other, `A website account (${who}) signed up with this lead's ${byPhone.includes(other) ? 'phone number' : 'email'}. This lead belongs to another account, so it was not linked.`, session);
  }

  if (lead) {
    let phoneChanged = false;
    const notes = [];
    if (lead === phoneLead) {
      // Case 3 (and 5): the phone wins. The account's email becomes the lead's; the old one is kept in a note.
      const earlier = emailOf(lead.email);
      if (earlier && earlier !== email) notes.push(`Signed up on website. Earlier email: ${lead.email}`);
      lead.set({ email });
      if (emailLead && String(emailLead._id) !== String(lead._id)) await addNote(emailLead, `Same email signed up on the website, see lead ${lead.name ? `${lead.name} ` : ''}(${lead._id}).`, session);
    } else {
      // Case 4: matched by email only. The account's phone becomes the main number; the old one moves to alternate or a note.
      const earlier = String(lead.phone || '').trim();
      if (earlier && phoneKey(earlier) !== phoneKey(user.phone)) {
        if (!String(lead.altPhone || '').trim()) lead.set({ altPhone: earlier });
        else notes.push(`Signed up on website. Earlier phone: ${earlier}`);
      }
      phoneChanged = phoneKey(earlier) !== phoneKey(user.phone);
      lead.set({ phone: user.phone });
    }
    await takeOver(lead, user, { session });
    lead.set({ reservationUserId: user._id });
    for (const note of notes) lead.followUps.push(line(note, lead.status));
    await lead.save({ session });
    return { lead, created: false, phoneChanged };
  }

  // Case 6: the number is only some lead's alternate number. A shared number is not proof of the same person.
  if (user.phone) {
    for (const other of (await findLeadsByContactNumber(user.phone, { deletedAt: null }, { session })).filter(row => phoneKey(row.phone) !== phoneKey(user.phone))) {
      await addNote(other, `A website account (${who}) signed up with this lead's alternate number.`, session);
    }
  }
  // Case 7: a new lead, Contacted (the model's default), like any other Contacted lead.
  const [created] = await leadModel.create([{ name: user.name || user.email, email, phone: user.phone || '', source, reservationUserId: user._id, ...fields }], { session });
  return { lead: created, created: true, phoneChanged: false };
}

/**
 * Finds or makes this member's one lead and links it (reservationUserId). Pass `session` to join the caller's
 * transaction; otherwise it runs in its own. `fields` are only for a new lead (notes, createdBy). When the lead's
 * main phone changed (`phoneChanged`), the caller runs finalMessageCycle.reconcileCycle after its commit.
 */
async function linkPersonLead(user, { session, source = SIGNUP_SOURCE, fields = {} } = {}) {
  const run = activeSession => linkInSession(user, { session: activeSession, source, fields });
  // Inside the caller's transaction an error aborts it: it is the caller's to handle.
  if (session) return run(session);
  try {
    let result;
    await mongoose.connection.transaction(async own => { result = await run(own); });
    if (result.phoneChanged) await require('./finalMessageCycle').reconcileCycle(result.lead._id);
    return result;
  } catch (error) {
    // Two ways in at once for the same account: the unique link lets one win, and the other uses its lead.
    if (error.code !== 11000 || !String(error.message).includes('reservationUserId')) throw error;
    const lead = await leadModel.findOne({ reservationUserId: user._id });
    if (!lead) throw error;
    return { lead, created: false, phoneChanged: false };
  }
}

/**
 * The website member on this main phone, for a lead an admin saves by hand: { member, conflict }. A member without a
 * lead gets this one as theirs; a member who already has one is a conflict (one person, one lead), never relinked.
 */
async function memberOnPhone(phone, { exceptLeadId } = {}) {
  if (!phone) return { member: null, conflict: null };
  const { findAccountsByPhone } = require('./leadPhone');
  const member = (await findAccountsByPhone(phone)).find(user => !user.isGuest && !user.deletedAt && (user.roles || []).length > 0 && user.roles.every(role => role === 'member'));
  if (!member) return { member: null, conflict: null };
  const own = await leadModel.findOne({ reservationUserId: member._id, ...(exceptLeadId ? { _id: { $ne: exceptLeadId } } : {}) }).select('_id').lean();
  return own
    ? { member: null, conflict: `This number belongs to the website account ${member.email}, which already has a lead. Open that lead instead.` }
    : { member, conflict: null };
}

module.exports = { SIGNUP_SOURCE, freeFor, isFree, linkPersonLead, memberOnPhone };
