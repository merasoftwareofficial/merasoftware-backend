const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { FinalMessage } = require('../whatsapp/src/models.js');
const signup = require('../controller/user/userSignUp');
const adminCreate = (...args) => require('../controller/user/adminCreateAccount')(...args);
const createLead = require('../controller/lead/createLead');
const convert = require('../controller/lead/convertLead');
const { requestMiddleware } = require('../helpers/emailController');
const express = require('express');
let db, admin, server, base;
const form = (extra = {}) => ({ name: 'Website Person', email: 'person@example.test', phone: '9876543210', countryCode: '+91', password: 'secret123', ...extra });
const lead = extra => Lead.create({ name: 'Existing lead', phone: '9876543210', ...extra });
async function call(handler, body, extra = {}) {
  let result;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { result = { status: this.statusCode, ...body }; return this; } };
  await handler({ body, userId: admin._id, userRole: 'admin', ...extra }, res);
  return result;
}
before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(db.getUri()); await Promise.all([User.init(), Lead.init(), FinalMessage.init()]);
  const app = express(); app.use(express.json()); app.use((req,res,next) => {req.userId=admin._id;req.userRole='admin';next();}); app.use(requestMiddleware); app.post('/convert/:leadId',convert);
  await new Promise(resolve => {server=app.listen(0,'127.0.0.1',resolve);}); base=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { await Promise.all([User,Lead,FinalMessage].map(model => model.deleteMany({}))); admin=await User.create({name:'Admin',email:'admin@example.test',roles:['admin']}); });
after(async () => {if(server) await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();await db.stop();});

test('signup creates one Contacted lead; duplicate live email and main phone are refused', async () => {
  const first = await call(signup, form({role:'admin'})); assert.equal(first.success,true); assert.deepEqual(first.data.roles,['member']);
  const saved=await Lead.findOne(); assert.equal(saved.source,'Website signup'); assert.equal(saved.status,'Contacted'); assert.equal(String(saved.reservationUserId),String(first.data._id));
  assert.equal((await call(signup,form({phone:'9811111111'}))).success,false);
  assert.equal((await call(signup,form({email:'other@example.test'}))).success,false);
  assert.equal(await Lead.countDocuments(),1);
});
for (const state of [{isActive:false},{deletedAt:new Date()}]) test(`signup refuses a non-guest phone holder: ${Object.keys(state)[0]}`,async()=>{
  await User.create({name:'Owner',email:'old@example.test',phone:'+91 98765 43210',roles:['member'],...state});
  assert.equal((await call(signup,form())).success,false); assert.equal(await Lead.countDocuments(),0);
});
test('guest phone alone does not block signup',async()=>{
  await User.create({name:'Guest',email:'guest@example.test',phone:'+919876543210',isGuest:true});
  assert.equal((await call(signup,form())).success,true); assert.equal(await Lead.countDocuments(),1);
});
test('phone match wins, preserves earlier email and replaces a WhatsApp guess',async()=>{
  const old=await lead({name:'Guessed',nameFromWhatsapp:true,status:'Inquiry',email:'old@example.test',phone:'+91 98765 43210'});
  const result=await call(signup,form()); assert.equal(result.success,true);
  const saved=await Lead.findById(old._id); assert.equal(saved.email,form().email); assert.equal(saved.name,form().name); assert.equal(saved.nameFromWhatsapp,false); assert.equal(saved.status,'Contacted'); assert.match(saved.followUps.map(x=>x.note).join('\n'),/Earlier email: old@example.test/); assert.equal(await Lead.countDocuments(),1);
});
for(const occupiedAlt of [false,true]) test(`email match moves old main to ${occupiedAlt?'note':'alt'}`,async()=>{
  const old=await lead({email:form().email,phone:'9811111111',...(occupiedAlt?{altPhone:'9822222222'}:{})});
  assert.equal((await call(signup,form())).success,true); const saved=await Lead.findById(old._id);
  assert.equal(saved.phone,'+919876543210'); assert.equal(saved.altPhone,occupiedAlt?'9822222222':'9811111111');
  if(occupiedAlt) assert.match(saved.followUps.map(x=>x.note).join('\n'),/Earlier phone: 9811111111/);
});
test('conflicting phone and email leads link the phone lead and note the other',async()=>{
  const a=await lead({email:'old@example.test'}); const b=await lead({phone:'9811111111',email:form().email});
  const result=await call(signup,form()); assert.equal(result.success,true);
  assert.equal(String((await Lead.findById(a._id)).reservationUserId),String(result.data._id));
  assert.match((await Lead.findById(b._id)).followUps.map(x=>x.note).join('\n'),new RegExp(String(a._id)));
});
test('alt-only match links that lead: the account number becomes main, the old main the alternate (owner, 7 Nov)',async()=>{
  const old=await lead({phone:'9811111111',altPhone:form().phone,email:'old@example.test'});
  const result=await call(signup,form()); assert.equal(result.success,true); assert.equal(await Lead.countDocuments(),1);
  const saved=await Lead.findById(old._id); assert.equal(String(saved.reservationUserId),String(result.data._id));
  assert.equal(saved.phone,'+919876543210'); assert.equal(saved.altPhone,'9811111111'); assert.equal(saved.email,'person@example.test');
  assert.match(saved.followUps.map(x=>x.note).join('\n'),/Earlier email: old@example.test/);
});
test('admin Add Lead: a number another lead has as phone or alternate is refused, either way round',async()=>{
  await lead({phone:'9811111111',altPhone:'9822222222'});
  for (const body of [{phone:'9822222222'},{phone:'9833333333',altPhone:'+91 98111 11111'},{phone:'9833333333',altPhone:'9822222222'}]) {
    assert.equal((await call(createLead,{name:'New',...body})).status,409,JSON.stringify(body));
  }
  assert.equal((await call(createLead,{name:'New',phone:'9833333333',altPhone:'9844444444'})).status,201);
  assert.equal(await Lead.countDocuments(),2);
});
test('occupied lead is never stolen, and no second lead is made: it is used without the link',async()=>{
  const owner=await User.create({email:'owner@example.test',roles:['member']}); const old=await lead({reservationUserId:owner._id});
  assert.equal((await call(signup,form())).success,true); assert.equal(String((await Lead.findById(old._id)).reservationUserId),String(owner._id)); assert.equal(await Lead.countDocuments(),1);
  assert.match((await Lead.findById(old._id)).followUps.map(x=>x.note).join('\n'),/belongs to another account/);
});
for(const status of ['Contacted','Dead','Wrong']) test(`signup reuses trashed ${status} lead`,async()=>{
  const old=await lead({status,deletedAt:new Date()}); assert.equal((await call(signup,form())).success,true);
  const saved=await Lead.findById(old._id); assert.equal(saved.deletedAt,null); assert.equal(saved.status,status==='Dead'?'Contacted':status); assert.equal(await Lead.countDocuments(),1);
});
test('lead failure cannot fail the saved signup',async()=>{
  const original=Lead.findOne; Lead.findOne=()=>{throw new Error('Injected lead failure');};
  try {assert.equal((await call(signup,form())).success,true);} finally {Lead.findOne=original;}
  assert.ok(await User.findOne({email:form().email}));
});
test('admin endpoint checks database access, allowed roles and never creates staff signup leads',async()=>{
  const member=await User.create({email:'member@example.test',roles:['member']});
  assert.equal((await call(adminCreate,form({role:'admin'}),{userId:member._id})).status,403);
  assert.equal((await call(adminCreate,form({role:'owner'}))).success,false);
  assert.equal((await call(adminCreate,form({role:'developer'}))).success,true); assert.equal(await Lead.countDocuments(),0);
  const customer=await call(adminCreate,form({email:'customer@example.test',phone:'9811111111',role:'customer'})); assert.equal(customer.success,true);
  assert.equal((await Lead.findOne({convertedToUserId:customer.data._id})).status,'Won');
  const denied=await call(adminCreate,form({email:'second@example.test',role:'partner'})); assert.equal(denied.success,false); assert.match(denied.message,/person@example.test/);
});
test('manual lead links a member by main phone; an existing member lead returns 409',async()=>{
  const member=await User.create({email:'member@example.test',phone:'+919876543210',roles:['member']});
  const first=await call(createLead,{name:'Manual',phone:'9876543210'}); assert.equal(first.success,true); assert.equal(String(first.data.reservationUserId),String(member._id));
  const second=await call(createLead,{name:'Another',phone:'+91 98765 43210'}); assert.equal(second.status,409); assert.equal(await Lead.countDocuments(),1);
});
test('conversion finds the member by phone, requires confirmation and keeps the account ID',async()=>{
  const member=await User.create({name:'Website member',email:'member@example.test',phone:'+919876543210',roles:['member']}); const old=await lead({email:'different@example.test'});
  const send=async body=>{const r=await fetch(`${base}/convert/${old._id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();};
  const prompt=await send({}); assert.equal(prompt.code,'EXISTING_MEMBER'); assert.equal(prompt.matchedBy,'phone');
  const result=await send({upgradeExisting:true}); assert.equal(result.success,true); assert.equal(String(result.data.userId),String(member._id));
  const saved=await Lead.findById(old._id); assert.equal(saved.email,member.email); assert.equal(saved.status,'Won'); assert.equal(await User.countDocuments({roles:'customer'}),1);
});
test('phone-matched member upgrade rolls back when saving the converted lead fails',async()=>{
  const member=await User.create({name:'Member',email:'member@example.test',phone:'+919876543210',roles:['member']}); const old=await lead({email:'different@example.test'});
  const save=Lead.prototype.save;
  Lead.prototype.save=function(...args){if(String(this._id)===String(old._id)&&this.status==='Won')throw new Error('Injected conversion save failure');return save.apply(this,args);};
  try{
    const response=await fetch(`${base}/convert/${old._id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upgradeExisting:true})});assert.equal((await response.json()).success,false);
  }finally{Lead.prototype.save=save;}
  assert.deepEqual((await User.findById(member._id)).roles,['member']);assert.equal((await Lead.findById(old._id)).convertedToUserId,null);
});
