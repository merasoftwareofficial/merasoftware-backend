import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

// Baileys' own useMultiFileAuthState, stored in MongoDB instead of files: Render's disk is wiped on
// every restart, the database is not, so a restart reconnects without a new QR scan.
export async function useMongoAuthState(Auth) {
  const encode = value => JSON.stringify(value, BufferJSON.replacer);
  const decode = text => JSON.parse(text, BufferJSON.reviver);
  const saved = await Auth.findById('creds').lean();
  const creds = saved ? decode(saved.value) : initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const rows = await Auth.find({ _id: { $in: ids.map(id => `${type}-${id}`) } }).lean();
          const found = new Map(rows.map(row => [row._id, row.value]));
          const data = {};
          for (const id of ids) {
            const text = found.get(`${type}-${id}`);
            let value = text ? decode(text) : null;
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async data => {
          const writes = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const _id = `${type}-${id}`;
              writes.push(value
                ? { updateOne: { filter: { _id }, update: { $set: { value: encode(value) } }, upsert: true } }
                : { deleteOne: { filter: { _id } } });
            }
          }
          if (writes.length) await Auth.bulkWrite(writes, { ordered: false });
        },
      },
    },
    saveCreds: () => Auth.updateOne({ _id: 'creds' }, { $set: { value: encode(creds) } }, { upsert: true }),
  };
}

export function clearAuthState(Auth) {
  return Auth.deleteMany({});
}
