// Package working copies (models/packageDraftModel.js, merasoftware/src/docs/package-offers.md). Saving
// a draft needs only the package name, and the offer name when an offer was added; every other check runs
// when the website publishes it through the normal package save (helpers/salesPackages.js savePackage).
const Draft = require('../models/packageDraftModel');
const { fail, readPackages, reservedPackageIds, packageIdBase } = require('./salesPackages');

const MAX_BYTES = 300000;
const safeId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const view = row => row && { packageId: row.packageId, name: row.name, data: row.data, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, updatedBy: row.updatedBy || null };
const conflict = () => fail('Someone else saved this draft meanwhile. Reload the package to see their changes.', 409);

async function listDrafts() {
  return (await Draft.find().sort({ updatedAt: -1 }).lean()).map(view);
}
// IDs that are taken: live packages and other drafts, so a new draft never takes a published link.
async function takenIds() {
  const [reserved, drafts] = await Promise.all([reservedPackageIds(), Draft.find().select('packageId').lean()]);
  return new Set([...reserved, ...drafts.map(row => row.packageId)]);
}
function checkData(data) {
  if (!plain(data) || !plain(data.item)) fail('Nothing to save in this draft');
  const name = typeof data.item.name === 'string' ? data.item.name.trim() : '';
  if (!name) fail('Enter the package name to save a draft');
  if (name.length > 120) fail('The package name can be at most 120 characters');
  if (data.offer !== undefined && data.offer !== null) {
    if (!plain(data.offer)) fail('Nothing to save in this offer draft');
    if (typeof data.offer.title !== 'string' || !data.offer.title.trim()) fail('Enter the offer name to save the offer in the draft');
  }
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) fail('This draft is too large to save');
  return name;
}
// version 0 = the first draft of a live package; otherwise the version the editor opened.
async function saveDraft({ packageId, version, data }, userId = null) {
  const name = checkData(data);
  if (packageId === undefined || packageId === '') {
    // A new package: its permanent ID comes from the name now, so the link shown while drafting is the one it keeps.
    const base = packageIdBase(name);
    for (let attempt = 0; attempt < 20; attempt++) {
      const taken = await takenIds();
      let n = 1; let id = base;
      while (taken.has(id)) id = `${base}-${++n}`;
      try {
        const row = await Draft.create({ packageId: id, name, data: { ...data, item: { ...data.item, id } }, version: 1, updatedBy: userId });
        return view(row.toObject());
      } catch (error) { if (error.code !== 11000) throw error; }
    }
    fail('Could not reserve a package ID. Try again.', 409);
  }
  if (!safeId(packageId)) fail('Use a safe lowercase package ID');
  if (!Number.isInteger(version) || version < 0) fail('Reload the package and try again');
  const stored = { ...data, item: { ...data.item, id: packageId } };
  if (version === 0) {
    if (!(await readPackages()).some(row => row.id === packageId)) fail('Package not found', 404);
    try { return view((await Draft.create({ packageId, name, data: stored, version: 1, updatedBy: userId })).toObject()); }
    catch (error) { if (error.code === 11000) conflict(); throw error; }
  }
  const row = await Draft.findOneAndUpdate({ packageId, version }, { $set: { name, data: stored, updatedBy: userId }, $inc: { version: 1 } }, { new: true }).lean();
  if (row) return view(row);
  if (await Draft.exists({ packageId })) conflict();
  fail('This draft was published or discarded meanwhile. Reload the package.', 409);
}
// Publish (after a successful save) and Discard both remove the copy, only if nobody saved a newer one.
async function deleteDraft(packageId, version) {
  if (!safeId(packageId) || !Number.isInteger(version) || version < 1) fail('Reload the package and try again');
  const { deletedCount } = await Draft.deleteOne({ packageId, version });
  if (!deletedCount && await Draft.exists({ packageId })) conflict();
  return { packageId, deleted: deletedCount === 1 };
}
// "End offer" is live at once; the copy forgets that offer so it is never published again from it.
async function clearDraftOffer(packageId, offerSlug) {
  if (!safeId(packageId) || !safeId(offerSlug)) fail('Choose a valid offer');
  const { modifiedCount } = await Draft.updateOne({ packageId, 'data.offer.base.slug': offerSlug }, { $set: { 'data.offer': null }, $inc: { version: 1 } });
  return { packageId, cleared: modifiedCount === 1 };
}
// A deleted website page leaves the drafts too (salesPackages.js unlinkPackagePage does the live packages).
async function unlinkDraftPage(slug) {
  const { modifiedCount } = await Draft.updateMany({ 'data.item.pages': slug }, { $pull: { 'data.item.pages': slug } });
  return modifiedCount;
}
module.exports = { listDrafts, takenIds, saveDraft, deleteDraft, clearDraftOffer, unlinkDraftPage };
