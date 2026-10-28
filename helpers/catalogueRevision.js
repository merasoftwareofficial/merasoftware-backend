// Optimistic edit guard for catalogue documents. Keeps Mongoose validation/save hooks.
const conflict = () => Object.assign(new Error('This item changed in another session. Reload it and review your changes before saving.'), { statusCode: 409 });
const revision = (row) => row?.updatedAt ? new Date(row.updatedAt).toISOString() : null;
function assertRevision(row, expected) {
  // Legacy callers without a token remain compatible; active managers always send one.
  if (expected !== undefined && expected !== revision(row)) throw conflict();
}
const revisionFilter = (row) => ({ _id: row._id, updatedAt: row.updatedAt || null });
const nextTime = (row) => new Date(Math.max(Date.now(), row.updatedAt ? new Date(row.updatedAt).getTime() + 1 : 0));
async function saveRevision(row, expected) {
  assertRevision(row, expected);
  row.$where = { updatedAt: row.updatedAt || null };
  row.updatedAt = nextTime(row);
  try { await row.save({ timestamps: false }); }
  catch (error) {
    if (error.name === 'DocumentNotFoundError' || error.name === 'VersionError') throw conflict();
    throw error;
  }
  return row;
}
async function deleteRevision(Model, row, expected) {
  assertRevision(row, expected);
  if (!await Model.findOneAndDelete(revisionFilter(row))) throw conflict();
}
module.exports = { assertRevision, revisionFilter, nextTime, saveRevision, deleteRevision, conflict };
