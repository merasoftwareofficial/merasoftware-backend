const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const leadModel = require("../models/leadModel");
const userModel = require("../models/userModel");
const {
  unlinkDeletedClients,
  inspectLeadClient,
  healOrphanedLeads,
} = require("../helpers/leadClientLink");

describe("leadClientLink helper", () => {
  const originals = {};

  beforeEach(() => {
    originals.leadUpdateMany = leadModel.updateMany;
    originals.leadUpdateOne = leadModel.updateOne;
    originals.userFindById = userModel.findById;
    originals.userFind = userModel.find;
  });

  afterEach(() => {
    leadModel.updateMany = originals.leadUpdateMany;
    leadModel.updateOne = originals.leadUpdateOne;
    userModel.findById = originals.userFindById;
    userModel.find = originals.userFind;
  });

  it("unlinkDeletedClients skips empty input and updates matching leads", async () => {
    let calls = [];
    leadModel.updateMany = async (filter, update) => {
      calls.push({ filter, update });
      return { modifiedCount: 2 };
    };

    const empty = await unlinkDeletedClients([]);
    assert.equal(empty.modifiedCount, 0);
    assert.equal(calls.length, 0);

    const res = await unlinkDeletedClients(["u1", null, "u2"]);
    assert.equal(res.modifiedCount, 2);
    assert.deepEqual(calls[0].filter, { convertedToUserId: { $in: ["u1", "u2"] } });
    assert.deepEqual(calls[0].update, { $set: { convertedToUserId: null } });
  });

  it("inspectLeadClient returns none when not converted", async () => {
    const res = await inspectLeadClient({ _id: "l1", convertedToUserId: null });
    assert.deepEqual(res, { status: "none", user: null });
  });

  it("inspectLeadClient auto-heals orphaned lead when user no longer exists", async () => {
    let healed = null;
    userModel.findById = () => ({ select: () => ({ lean: async () => null }) });
    leadModel.updateOne = async (filter, update) => {
      healed = { filter, update };
      return { modifiedCount: 1 };
    };

    const lead = { _id: "l1", convertedToUserId: "u-missing" };
    const res = await inspectLeadClient(lead);
    assert.deepEqual(res, { status: "none", user: null });
    assert.equal(lead.convertedToUserId, null);
    assert.deepEqual(healed.filter, { _id: "l1", convertedToUserId: "u-missing" });
    assert.deepEqual(healed.update, { $set: { convertedToUserId: null } });
  });

  it("inspectLeadClient distinguishes trashed vs active client", async () => {
    const trashedUser = { _id: "u1", deletedAt: new Date() };
    userModel.findById = () => ({ select: () => ({ lean: async () => trashedUser }) });
    const trashedRes = await inspectLeadClient({ _id: "l1", convertedToUserId: "u1" });
    assert.equal(trashedRes.status, "trashed");

    const activeUser = { _id: "u2", deletedAt: null };
    userModel.findById = () => ({ select: () => ({ lean: async () => activeUser }) });
    const activeRes = await inspectLeadClient({ _id: "l2", convertedToUserId: "u2" });
    assert.equal(activeRes.status, "active");
  });

  it("healOrphanedLeads batch-heals missing users and flags trashed clients", async () => {
    let updatedFilter = null;
    userModel.find = () => ({
      select: () => ({
        lean: async () => [
          { _id: "u-active", deletedAt: null },
          { _id: "u-trashed", deletedAt: new Date() },
        ],
      }),
    });
    leadModel.updateMany = async (filter) => {
      updatedFilter = filter;
      return { modifiedCount: 1 };
    };

    const leads = [
      { _id: "l-open", convertedToUserId: null },
      { _id: "l-active", convertedToUserId: "u-active" },
      { _id: "l-trashed", convertedToUserId: "u-trashed" },
      { _id: "l-orphan", convertedToUserId: "u-gone" },
    ];
    await healOrphanedLeads(leads);

    assert.equal(leads[1].convertedToUserId, "u-active");
    assert.equal(leads[1].clientInTrash, undefined);
    assert.equal(leads[2].convertedToUserId, "u-trashed");
    assert.equal(leads[2].clientInTrash, true);
    assert.equal(leads[3].convertedToUserId, null);
    assert.deepEqual(updatedFilter, { _id: { $in: ["u-gone" ? "l-orphan" : ""] } });
  });
});
