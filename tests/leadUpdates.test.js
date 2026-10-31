const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { FinalMessage } = require('../whatsapp/src/models.js');
process.env.TOKEN_SECRET_KEY = 'isolated-live-updates-test';
let db, server, base, admin, worker;
const cookie = (role = 'admin') => `token=${jwt.sign({ _id: String(admin._id), role }, process.env.TOKEN_SECRET_KEY)}`;
before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri(), { dbName: 'merasoftware-fix-test' });
  await Promise.all([Lead.init(), FinalMessage.init(), User.init()]);
  admin = await User.create({ name: 'Test admin', email: 'live@example.test', roles: ['admin'] });
  worker = new MongoClient(db.getUri()); await worker.connect();
  const app = express(); app.use(cookieParser());
  app.get('/updates', require('../middleware/authToken'), require('../routes/leadUpdates'));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await worker.close(); await mongoose.disconnect(); await db.stop(); });
async function open() {
 const controller = new AbortController();
 const response = await fetch(base+'/updates', { headers: {cookie:cookie()}, signal:controller.signal });
 assert.equal(response.status,200); assert.match(response.headers.get('content-type'),/text\/event-stream/);
 const reader=response.body.getReader();let buffered='';
 async function next(type){const deadline=Date.now()+10000;while(Date.now()<deadline){let end;while((end=buffered.indexOf('\n\n'))>=0){const frame=buffered.slice(0,end);buffered=buffered.slice(end+2);const data=frame.split('\n').find(x=>x.startsWith('data: '));if(data){const message=JSON.parse(data.slice(6));if(message.type===type)return message;}}
 const result=await reader.read();if(result.done)throw Error('Stream ended');buffered+=new TextDecoder().decode(result.value);}
 throw Error('Notification timeout');}
 return {next,close:()=>controller.abort()};
}
test('SSE refuses anonymous, customer active role and revoked admin role', async () => {
 assert.equal((await fetch(base+'/updates')).status,401);
 assert.equal((await fetch(base+'/updates',{headers:{cookie:cookie('customer')}})).status,403);
 await User.updateOne({_id:admin._id},{$set:{roles:['customer']}});
 assert.equal((await fetch(base+'/updates',{headers:{cookie:cookie()}})).status,403);
 await User.updateOne({_id:admin._id},{$set:{roles:['admin']}});
});
test('two browsers receive IDs for API writes and separate worker writes, without private data', async () => {
 const one=await open(),two=await open();
 try {
  await Promise.all([one.next('ready'),two.next('ready')]);
  const lead=await Lead.create({name:'Private name',phone:'9876543210',status:'Negative'});
  const changes=await Promise.all([one.next('changed'),two.next('changed')]);
  for(const change of changes){assert.ok(change.ids.includes(String(lead._id)));assert.doesNotMatch(JSON.stringify(change),/Private name|9876543210/);}
  await worker.db('merasoftware-fix-test').collection(FinalMessage.collection.name).insertOne({leadId:lead._id,status:'replied',lastReplyText:'Private reply'});
  const changed=await one.next('changed');assert.ok(changed.ids.includes(String(lead._id)));assert.doesNotMatch(JSON.stringify(changed),/Private reply/);
  await worker.db('merasoftware-fix-test').collection(Lead.collection.name).updateOne({_id:lead._id},{$set:{status:'Dead'}});
  assert.ok((await one.next('changed')).ids.includes(String(lead._id)));
 }finally{one.close();two.close();}
});
test('reconnecting receives a fresh reconciliation marker', async()=>{const session=await open();try{assert.equal((await session.next('ready')).type,'ready');}finally{session.close();}});
