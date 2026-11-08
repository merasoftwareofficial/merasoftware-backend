const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.RESEND_API_KEY = 'not-a-real-provider-key';
process.env.FROM_EMAIL = 'sender@example.test';
process.env.TOKEN_SECRET_KEY = 'isolated-offer-target-secret';
process.env.PORTFOLIO_WEBSITE_URL = 'https://website.example.test';
process.env.PORTFOLIO_INTEGRATION_SECRET = 'isolated-test-secret-32-characters-long';

// Real routes, review decision and queue on an isolated database. Only the mail provider and the website's offer feed are fake.
const mongoose = require('mongoose');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Lead = require('../models/leadModel');
const User = require('../models/userModel');
const Target = require('../models/offerTargetModel');
const { EmailDraft, EmailHistory, EmailPolicy, EmailTemplate } = require('../models/emailControlModel');
const { FinalMessage, Lock, Queue, State } = require('../whatsapp/src/models.js');
const { requestMiddleware } = require('../helpers/emailController');
const { audience, eligible } = require('../helpers/broadcastAudience');
const { contactBlocks, blockForLead } = require('../helpers/leadContactBlock');
const { leadForNewRequest, clearClientDead } = require('../helpers/leadPhone');
const { ensureWonLead } = require('../helpers/wonLead');
const { behaviourFromStatus } = require('../helpers/leadStatuses');
const leadFileUpload = require('../middleware/leadFileUpload');

const nativeFetch = global.fetch;
const SLUG = 'digital-dhamaka';
const OFFER = { slug: SLUG, title: 'Digital Dhamaka', status: 'published', endsAt: new Date(Date.now() + 86_400_000).toISOString() };
let db, server, base, admin, liveOffers;
const cookie = () => `token=${jwt.sign({ _id: String(admin._id), role: 'admin' }, process.env.TOKEN_SECRET_KEY)}`;
const lead = (fields = {}) => Lead.create({ name: 'Ravi', phone: '9876543210', status: 'Contacted', ...fields });
const client = (fields = {}) => User.create({ name: 'Rajan', email: `rajan${Date.now()}${Math.random()}@example.test`, phone: '9876500000', roles: ['customer'], ...fields });
async function call(path, method = 'POST', body) {
  const response = await nativeFetch(`${base}${path}`, { method, headers: { Cookie: cookie(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...await response.json() };
}
const follow = (id, body) => call(`/admin/leads/${id}`, 'POST', { action: 'followUp', note: 'Called', ...body });
const addPeople = people => call(`/api/offer-targets/offers/${SLUG}/people`, 'POST', { people });
const stored = id => Lead.findById(id).lean();
const review = id => call(`/email-control/drafts/${id}`, 'GET').then(result => result.data);
const decide = (draft, channels) => call(`/email-control/drafts/${draft._id}/decision`, 'POST', { choice: 'send', channels, subject: draft.subject, subjectDoc: draft.templateSubjectDoc, doc: draft.templateDoc || draft.doc, templateId: draft.selectedTemplateId });
const finalRow = (leadId, fields) => FinalMessage.create({ leadId, phone: '919876543210', hours: 24, draftId: new mongoose.Types.ObjectId(), status: 'waiting', ...fields });

before(async () => {
  db = await MongoMemoryServer.create();
  process.env.MONGODB_URI = db.getUri();
  await mongoose.connect(db.getUri(), { dbName: 'offer-target-isolated-test' });
  await Promise.all([Queue.init(), Lead.init(), FinalMessage.init(), Target.init()]);
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const authToken = require('../middleware/authToken');
  app.use(requestMiddleware);
  app.use('/email-control', require('../routes/emailControl'));
  app.use('/api/offer-targets', require('../routes/offerTargets'));
  app.post('/admin/leads/:leadId/message', authToken, require('../controller/lead/leadMessage'));
  app.post('/admin/leads/:leadId/convert', authToken, require('../controller/lead/convertLead'));
  app.post('/admin/leads/:leadId/proposal/:version/whatsapp', authToken, require('../controller/lead/sendProposalWhatsapp'));
  app.post('/admin/leads/:leadId', authToken, leadFileUpload, require('../controller/lead/updateLead'));
  app.get('/admin/leads/:leadId', authToken, require('../controller/lead/getLeadDetail'));
  app.get('/my-referred-leads', authToken, require('../controller/user/myReferredLeads'));
  app.delete('/trash/:type/:id', authToken, require('../controller/trash/purgeTrash'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (url, options) => {
    if (String(url).includes('/api/offers/live')) return new Response(JSON.stringify({ offers: liveOffers, catalogueOffers: liveOffers }), { status: 200 });
    return new Response(JSON.stringify({ id: 'provider-id', received: options?.body ? true : false }), { status: 200 });
  };
});
beforeEach(async () => {
  process.env.ENABLE_WHATSAPP = 'true'; liveOffers = [OFFER];
  await Promise.all([Lead, User, Target, EmailDraft, EmailHistory, EmailPolicy, EmailTemplate, Queue, FinalMessage, State, Lock].map(model => model.deleteMany({})));
  admin = await User.create({ name: 'Admin', email: 'admin@example.test', roles: ['admin'] });
});
after(async () => {
  global.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

// Categories
test('a lead can take every new category, and Contacted stays the stored value', async () => {
  const { _id } = await lead();
  for (const badge of ['Positive', 'NotNow', 'Unhappy', 'Wrong', 'Contacted']) {
    assert.equal((await follow(_id, { badge })).status, 200, badge);
    assert.equal((await stored(_id)).status, badge);
  }
  assert.equal((await follow(_id, { badge: 'Active' })).status, 400, 'Active is Positive now (owner, 8 Nov 2026)');
});
test('Wrong is refused for a client: their own request lead and a number a client holds', async () => {
  const user = await client();
  const request = await lead({ requestedByUserId: user._id, phone: '9000000001' });
  assert.equal((await follow(request._id, { badge: 'Wrong' })).status, 400);
  const sameNumber = await lead({ phone: user.phone });
  assert.equal((await follow(sameNumber._id, { badge: 'Wrong' })).status, 400);
  const other = await lead({ phone: '9000000002' });
  assert.equal((await follow(other._id, { badge: 'Wrong' })).status, 200);
});
test('behaviour is for a client only, leaves Won alone, and shows on the timeline', async () => {
  const user = await client();
  const won = await ensureWonLead(user, admin._id);
  const open = await lead({ phone: '9000000003' });
  assert.equal((await call(`/api/offer-targets/leads/${open._id}/behaviour`, 'PATCH', { behaviour: 'NotNow' })).status, 409);
  assert.equal((await call(`/api/offer-targets/leads/${won._id}/behaviour`, 'PATCH', { behaviour: 'Wrong' })).status, 400);
  assert.equal((await call(`/api/offer-targets/leads/${won._id}/behaviour`, 'PATCH', { behaviour: 'NotNow' })).status, 200);
  const saved = await stored(won._id);
  assert.equal(saved.status, 'Won');
  assert.equal(saved.clientBehaviour, 'NotNow');
  assert.match(saved.followUps.at(-1).note, /Neutral to Not Now/);
  assert.equal((await call(`/admin/leads/${won._id}`, 'POST', { action: 'setBehaviour', behaviour: 'Unhappy' })).status, 200, 'the portal lead page path');
  assert.equal((await stored(won._id)).clientBehaviour, 'Unhappy');
  // A client's behaviour only says whether they may be marketed to (owner, 8 Nov 2026).
  for (const behaviour of ['Positive', 'Active', 'Inquiry']) assert.equal((await call(`/api/offer-targets/leads/${won._id}/behaviour`, 'PATCH', { behaviour })).status, 400, behaviour);
});
test('a lead becomes a client as Neutral, unless it was Not Now, Unhappy or Negative', () => {
  for (const [status, behaviour] of [['Positive', 'Contacted'], ['Active', 'Contacted'], ['Inquiry', 'Contacted'], ['Contacted', 'Contacted'], ['Dead', 'Contacted'],
    ['Lazy', 'NotNow'], ['Tough', 'NotNow'], ['NotNow', 'NotNow'], ['Unhappy', 'Unhappy'], ['Negative', 'Negative']]) assert.equal(behaviourFromStatus(status), behaviour, status);
});
test('the website panel gets its stages, client statuses and names from the one list', async () => {
  const { options } = (await call(`/api/offer-targets/offers/${SLUG}`, 'GET')).data;
  assert.deepEqual(options.stages.map(row => row.value), ['Contacted', 'Positive', 'Negative']);
  assert.deepEqual(options.behaviours.map(row => row.value), ['Contacted', 'NotNow', 'Negative', 'Unhappy', 'Dead']);
  assert.deepEqual(options.allStages.map(row => row.value), ['Contacted', 'Positive', 'Reservation', 'NotNow', 'Negative', 'Won']);
  assert.deepEqual(options.leadCategories.map(row => row.value), ['Inquiry', 'Contacted', 'Positive', 'Reservation', 'NotNow', 'Negative', 'Unhappy', 'Dead', 'Wrong']);
  assert.equal(options.labels.Contacted, 'Neutral');
  assert.equal(options.labels.Won, 'Matured');
  assert.equal(options.labels.Lazy, 'Lazy', 'older values still have a name');
});
test('existing clients are left as they are: no behaviour stored, and they count as Neutral', async () => {
  const user = await client();
  const won = await lead({ phone: user.phone, status: 'Won', convertedToUserId: user._id });
  const [row] = (await call(`/api/offer-targets/offers/${SLUG}/candidates`, 'GET')).data;
  assert.equal(row.category, 'Contacted');
  assert.equal((await stored(won._id)).clientBehaviour, undefined);
});
test('becoming a client: the category carries over, Dead and Wrong must change first through Convert', async () => {
  const tough = await lead({ status: 'Tough', phone: '9000000004', email: 'tough@example.test' });
  assert.equal((await call(`/admin/leads/${tough._id}/convert`, 'POST', {})).status, 200);
  const converted = await stored(tough._id);
  assert.equal(converted.status, 'Won');
  assert.equal(converted.clientBehaviour, 'NotNow');
  for (const status of ['Dead', 'Wrong']) {
    const blocked = await lead({ status, phone: `900000001${status.length}`, email: `${status}@example.test` });
    const result = await call(`/admin/leads/${blocked._id}/convert`, 'POST', {});
    assert.equal(result.status, 400);
    assert.match(result.message, /Change its stage/);
  }
  const dead = await lead({ status: 'Dead', phone: '9000000005', email: 'late@example.test' });
  const user = await client({ email: 'late@example.test', phone: '9000000005' });
  const won = await ensureWonLead(user, admin._id);
  assert.equal(String(won._id), String(dead._id));
  assert.equal(won.clientBehaviour, 'Contacted');
});
test('a client who referred someone never sees our categories', async () => {
  const user = await client();
  for (const [status, phone] of [['Tough', '9000000021'], ['Wrong', '9000000022'], ['Won', '9000000023'], ['Dead', '9000000024']]) await lead({ status, phone, referredByUserId: user._id, name: status });
  const response = await nativeFetch(`${base}/my-referred-leads`, { headers: { Cookie: `token=${jwt.sign({ _id: String(user._id), role: 'customer' }, process.env.TOKEN_SECRET_KEY)}` } });
  const { data } = await response.json();
  assert.deepEqual(Object.fromEntries(data.map(row => [row.name, row.status])), { Tough: 'In progress', Wrong: 'Closed', Won: 'Matured', Dead: 'Closed' });
});

// Do not disturb
test('countdown: before Send nothing is blocked, and pressing Send blocks at once, before the job runs', async () => {
  const { _id } = await lead();
  const marked = await follow(_id, { badge: 'Negative' });
  assert.equal(marked.emailDraftIds.length, 1);
  assert.equal(await blockForLead(await stored(_id)), null, 'the popup alone blocks nothing');
  assert.equal((await audience('Negative')).count, 1);
  const draft = await review(marked.emailDraftIds[0]);
  assert.equal((await FinalMessage.findOne({ leadId: _id })).status, 'review');
  await decide(draft, 'whatsapp');
  assert.equal((await FinalMessage.findOne({ leadId: _id })).status, 'review', 'the job has not run');
  assert.equal(await blockForLead(await stored(_id)), 'final-message');
  const group = await audience('Negative');
  assert.equal(group.count, 0);
  assert.equal(group.excluded.doNotDisturb, 1);
  assert.equal((await call(`/admin/leads/${_id}/message`)).status, 409);
});
test('the countdown reaches another lead with the same number, and a queued Broadcast recipient', async () => {
  const negative = await lead({ status: 'Negative' });
  const other = await lead({ phone: '+91 98765 43210', status: 'Positive', name: 'Ravi 2' });
  const recipient = (await audience('Positive')).recipients[0];
  assert.equal(String(recipient.leadId), String(other._id));
  await finalRow(negative._id);
  assert.equal((await audience('Positive')).count, 0);
  assert.equal(await eligible('Positive', recipient), null);
});
for (const [status, fields, why] of [
  ['email-only', {}, 'an email-only send starts no countdown'],
  ['not-sent', {}, "Don't Send or a failed send"],
  ['replied', { decision: 'keep' }, 'the admin decided'],
  ['stopped', {}, 'stopped'],
]) test(`the block ends: ${why}`, async () => {
  const { _id } = await lead({ status: 'Negative' });
  await finalRow(_id, { status, ...fields });
  assert.equal(await blockForLead(await stored(_id)), null);
});
test('a real reply stays blocked until decided; the admin moving the stage ends it', async () => {
  const { _id } = await lead({ status: 'Negative' });
  await finalRow(_id, { status: 'replied' });
  assert.equal(await blockForLead(await stored(_id)), 'needs-decision');
  await Lead.updateOne({ _id }, { status: 'Contacted' });
  assert.equal(await blockForLead(await stored(_id)), null);
});
test('Dead and Wrong block by number and from every group; a trashed one still counts', async () => {
  for (const [status, reason] of [['Dead', 'dead'], ['Wrong', 'wrong']]) {
    await Lead.deleteMany({});
    await lead({ status, deletedAt: status === 'Dead' ? new Date() : null });
    const other = await lead({ phone: '+919876543210', name: 'Other' });
    assert.equal(await blockForLead(await stored(other._id)), reason);
    assert.equal((await audience('Contacted')).count, 0);
  }
  await assert.rejects(audience('Dead'), /Choose a lead group/);
  await assert.rejects(audience('Wrong'), /Choose a lead group/);
});
test("a client's number goes by their behaviour alone, not by their own request lead", async () => {
  const user = await client();
  await lead({ phone: user.phone, status: 'Dead', requestedByUserId: user._id });
  const won = await ensureWonLead(user, admin._id);
  assert.equal((await contactBlocks()).size, 0);
  await Lead.updateOne({ _id: won._id }, { clientBehaviour: 'Dead' });
  assert.equal([...(await contactBlocks()).values()][0], 'client-dead');
  await clearClientDead({ convertedToUserId: user._id });
  const saved = await stored(won._id);
  assert.equal(saved.clientBehaviour, undefined);
  assert.equal((await contactBlocks()).size, 0);
  assert.equal(saved.status, 'Won');
});
test('a popup left open is checked again on Send', async () => {
  const { _id } = await lead();
  const opened = await call(`/admin/leads/${_id}/message`);
  const draft = await review(opened.emailDraftIds[0]);
  await Lead.updateOne({ _id }, { status: 'Dead' });
  const refused = await decide(draft, 'whatsapp');
  assert.equal(refused.status, 409);
  assert.equal(await Queue.countDocuments(), 0);
});
test('a phone-only proposal message is refused, and the proposal stays', async () => {
  const { _id } = await lead({ status: 'Dead', proposals: [{ version: 1, downloadLink: 'https://example.test/p', uploadedAt: new Date() }] });
  const result = await call(`/admin/leads/${_id}/proposal/1/whatsapp`, 'POST', {});
  assert.equal(result.status, 409);
  assert.equal((await stored(_id)).proposals.length, 1);
  assert.equal(await Queue.countDocuments(), 0);
});
test('a new request brings a Dead lead back to Neutral and ends a countdown; Wrong stays Wrong', async () => {
  const dead = await lead({ status: 'Dead', name: undefined });
  assert.equal(String((await leadForNewRequest('9876543210', { name: 'Ravi', email: 'r@example.test' }))._id), String(dead._id));
  const back = await stored(dead._id);
  assert.equal(back.status, 'Contacted');
  assert.equal(back.name, 'Ravi');
  const waiting = await lead({ status: 'Negative', phone: '9000000031' });
  await finalRow(waiting._id, { phone: '919000000031' });
  await leadForNewRequest('9000000031', { name: 'Ravi' });
  assert.equal((await stored(waiting._id)).status, 'Contacted');
  assert.equal((await FinalMessage.findOne({ leadId: waiting._id })).status, 'stopped');
  const wrong = await lead({ status: 'Wrong', phone: '9000000032' });
  assert.equal(String((await leadForNewRequest('9000000032', { name: 'X' }))._id), String(wrong._id));
  assert.equal((await stored(wrong._id)).status, 'Wrong');
  const plain = await lead({ status: 'Negative', phone: '9000000033' });
  assert.equal(await leadForNewRequest('9000000033', { name: 'X' }), null);
  assert.equal((await stored(plain._id)).status, 'Negative');
});
test('the Proposal Sent group takes the open categories, not Unhappy, Negative or Wrong', async () => {
  let n = 0;
  for (const status of ['Contacted', 'Positive', 'Active', 'Lazy', 'Tough', 'Negative', 'Unhappy', 'Wrong']) await lead({ status, phone: `90000001${String(n++).padStart(2, '0')}`, proposalSentAt: new Date() });
  assert.equal((await audience('Proposal Sent')).count, 5);
  await assert.rejects(audience('Active'), /Choose a lead group/, 'Active is no Broadcast group now');
  assert.equal((await audience('Unhappy')).count, 1);
});
test('the Matured group reaches Neutral clients only: Not Now, Unhappy, Negative and older statuses are left out', async () => {
  let n = 0;
  for (const clientBehaviour of [undefined, 'Contacted', 'Positive', 'Active', 'Inquiry', 'NotNow', 'Unhappy', 'Negative']) {
    await lead({ name: `Client ${n}`, status: 'Won', convertedToUserId: new mongoose.Types.ObjectId(), phone: `90000002${String(n++).padStart(2, '0')}`, ...(clientBehaviour ? { clientBehaviour } : {}) });
  }
  const group = await audience('Won');
  assert.equal(group.count, 2);
  const reached = await Lead.find({ _id: { $in: group.recipients.map(row => row.leadId) } }).lean();
  assert.deepEqual(reached.map(row => row.clientBehaviour || 'none').sort(), ['Contacted', 'none']);
});

// Offer targets
test('candidates: each person once, clients by account, with categories and reasons', async () => {
  const user = await client();
  await ensureWonLead(user, admin._id);
  await lead({ phone: user.phone, requestedByUserId: user._id, name: 'Request' });
  await lead({ phone: '9000000041', status: 'Lazy', name: 'Lazy one' });
  await lead({ phone: '+91 9000000041', status: 'Contacted', name: 'Same number' });
  await lead({ phone: '9000000042', status: 'Dead', name: 'Dead one' });
  await lead({ phone: '9000000043', status: 'Won', name: 'Ghost' }); // Won with no live client: not offered
  const rows = (await call(`/api/offer-targets/offers/${SLUG}/candidates`, 'GET')).data;
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(row => row.phone.endsWith('9000000041')).length, 1);
  assert.equal(rows.find(row => row.type === 'client').name, 'Rajan');
  assert.equal(rows.find(row => row.name === 'Dead one').blockLabel, 'Dead');
  assert.ok(!rows.some(row => row.name === 'Ghost' || row.name === 'Request'));
});
test('adding people: one row per offer, lead status untouched, blocked skipped, and a timeline line', async () => {
  const user = await client();
  const open = await lead({ phone: '9000000051', status: 'Lazy' });
  const dead = await lead({ phone: '9000000052', status: 'Dead' });
  const result = await addPeople([{ type: 'client', id: String(user._id) }, { type: 'lead', id: String(open._id) }, { type: 'lead', id: String(dead._id) }]);
  assert.equal(result.data.added, 2);
  assert.equal(result.data.skipped.length, 1);
  assert.match(result.data.skipped[0].reason, /Dead/);
  assert.equal((await addPeople([{ type: 'lead', id: String(open._id) }])).data.already, 1);
  assert.equal(await Target.countDocuments(), 2);
  const saved = await stored(open._id);
  assert.equal(saved.status, 'Lazy');
  assert.equal(saved.followUps.at(-1).offerSlug, SLUG);
  const won = await Lead.findOne({ convertedToUserId: user._id }).lean();
  assert.equal(won.status, 'Won');
  const { data } = await call(`/api/offer-targets/offers/${SLUG}`, 'GET');
  assert.equal(data.counts.total, 2);
  assert.equal(data.counts.clients, 1);
  assert.equal(data.counts.stages.Contacted, 2);
  assert.equal(data.counts.categories.Lazy, 1);
});
test('only a running offer takes new people', async () => {
  const open = await lead();
  liveOffers = [];
  assert.equal((await addPeople([{ type: 'lead', id: String(open._id) }])).status, 409);
  assert.equal(await Target.countDocuments(), 0);
});
test('a note on a reserved offer may keep its Reservation stage; the admin can still move it, but not to a system stage', async () => {
  const open = await lead();
  const target = await Target.create({ leadId: open._id, offerSlug: SLUG, offerTitle: 'One', stage: 'Reservation' });
  assert.equal((await follow(open._id, { badge: 'Reservation', offerSlug: SLUG })).status, 200, 'a note keeps the stage');
  assert.equal((await Target.findById(target._id)).stage, 'Reservation');
  assert.equal((await follow(open._id, { badge: 'NotNow', offerSlug: SLUG })).status, 400, 'Not Now on an offer is set only by the reservation');
  assert.equal((await follow(open._id, { badge: 'Positive', offerSlug: SLUG })).status, 200);
  assert.equal((await Target.findById(target._id)).stage, 'Positive');
  assert.equal((await follow(open._id, { badge: 'Reservation', offerSlug: SLUG })).status, 400, 'and once moved, the admin cannot set it back');
});
test("a follow-up for an offer moves only that offer: never the lead, another offer, or the final message", async () => {
  const open = await lead();
  const [first, second] = await Target.create([{ leadId: open._id, offerSlug: SLUG, offerTitle: 'One' }, { leadId: open._id, offerSlug: 'other-offer', offerTitle: 'Two' }]);
  const result = await follow(open._id, { badge: 'Negative', offerSlug: SLUG });
  assert.equal(result.status, 200);
  assert.equal(result.finalMessage, undefined);
  assert.equal(result.emailDraftIds, undefined);
  assert.equal((await stored(open._id)).status, 'Contacted');
  assert.equal((await Target.findById(first._id)).stage, 'Negative');
  assert.equal((await Target.findById(second._id)).stage, 'Contacted');
  assert.equal((await follow(open._id, { badge: 'Active', offerSlug: SLUG })).status, 400);
  assert.equal((await follow(open._id, { badge: 'Positive', offerSlug: 'not-in-this-offer' })).status, 404);
  assert.equal((await follow(open._id, { badge: 'Positive' })).status, 200);
  assert.equal((await stored(open._id)).status, 'Positive');
  assert.equal((await Target.findById(first._id)).stage, 'Negative');
});
test('a client can move in an offer while Matured stays; editing an offer line follows the latest-line rule', async () => {
  const user = await client();
  const won = await ensureWonLead(user, admin._id);
  const target = await Target.create({ leadId: won._id, offerSlug: SLUG, offerTitle: 'One' });
  assert.equal((await follow(won._id, { badge: 'Positive', offerSlug: SLUG })).status, 200);
  assert.equal((await Target.findById(target._id)).stage, 'Positive');
  assert.equal((await stored(won._id)).status, 'Won');
  const saved = await stored(won._id);
  const line = saved.followUps.find(item => item.offerSlug === SLUG);
  assert.equal((await call(`/admin/leads/${won._id}`, 'POST', { action: 'editFollowUp', followUpId: String(line._id), badge: 'Negative', note: 'Changed' })).status, 200);
  assert.equal((await Target.findById(target._id)).stage, 'Negative');
  assert.equal((await stored(won._id)).status, 'Won');
  assert.equal((await follow(won._id, { badge: 'Won' })).status, 200, 'a general line on a Matured lead still works');
});
test('Bought this offer: a client only; the Won lead stays, and Matured is final for that offer', async () => {
  const user = await client();
  const won = await ensureWonLead(user, admin._id);
  const target = await Target.create({ leadId: won._id, offerSlug: SLUG, offerTitle: 'One' });
  const open = await lead({ phone: '9000000061' });
  const other = await Target.create({ leadId: open._id, offerSlug: SLUG, offerTitle: 'One' });
  const refused = await call(`/api/offer-targets/people/${other._id}/bought`);
  assert.equal(refused.status, 409);
  assert.match(refused.message, /Convert/);
  assert.equal((await call(`/api/offer-targets/people/${target._id}/bought`)).status, 200);
  assert.equal((await Target.findById(target._id)).stage, 'Won');
  assert.equal((await stored(won._id)).status, 'Won');
  assert.equal((await call(`/api/offer-targets/people/${target._id}/stage`, 'PATCH', { stage: 'Negative' })).status, 409);
  assert.equal((await call(`/api/offer-targets/people/${other._id}/stage`, 'PATCH', { stage: 'Won' })).status, 400);
  assert.equal((await call(`/api/offer-targets/people/${other._id}/stage`, 'PATCH', { stage: 'Positive' })).status, 200);
});
test('a converted lead keeps its offer, the lead page lists offers and the block, and a purge removes targets', async () => {
  const open = await lead({ phone: '9000000071', email: 'keep@example.test' });
  const target = await Target.create({ leadId: open._id, offerSlug: SLUG, offerTitle: 'One', stage: 'Positive' });
  assert.equal((await call(`/admin/leads/${open._id}/convert`, 'POST', {})).status, 200);
  assert.equal((await call(`/api/offer-targets/people/${target._id}/bought`)).status, 200);
  const detail = (await call(`/admin/leads/${open._id}`, 'GET')).data;
  assert.equal(detail.offerTargets[0].stage, 'Won');
  assert.equal(detail.contactBlock, null);
  await Lead.updateOne({ _id: open._id }, { deletedAt: new Date() });
  assert.equal((await call(`/api/offer-targets/offers/${SLUG}`, 'GET')).data.counts.total, 0, 'a trashed lead does not count');
  assert.equal((await call(`/trash/lead/${open._id}`, 'DELETE')).status, 200);
  assert.equal(await Target.countDocuments(), 0);
});
