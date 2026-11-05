const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const mongoose=require('mongoose');
const {MongoMemoryReplSet}=require('mongodb-memory-server');
const Lead=require('../models/leadModel');
const User=require('../models/userModel');
const {Queue,FinalMessage}=require('../whatsapp/src/models.js');
const {EmailPolicy,EmailDraft,EmailHistory}=require('../models/emailControlModel');
const {availability,deliver}=require('../helpers/reviewDelivery');
const {enqueueWhatsAppForEmail}=require('../helpers/whatsappQueue');
const {audience,eligible}=require('../helpers/broadcastAudience');
const {contactBlocks}=require('../helpers/leadContactBlock');
let db;
const MAIN='919876543210', ALT='919811111111';
before(async()=>{db=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(db.getUri());await Promise.all([Queue.init(),Lead.init(),FinalMessage.init()]);});
beforeEach(async()=>{process.env.ENABLE_WHATSAPP='true';process.env.ALT_PHONE_SENDING_ENABLED='true';await Promise.all([Lead,User,Queue,FinalMessage,EmailPolicy,EmailDraft,EmailHistory].map(m=>m.deleteMany({})));});
after(async()=>{delete process.env.ALT_PHONE_SENDING_ENABLED;await mongoose.disconnect();await db.stop();});
const person=extra=>Lead.create({name:'Person',email:'person@example.test',phone:MAIN,altPhone:ALT,...extra});
const draft=lead=>({_id:new mongoose.Types.ObjectId(),event:'lead.message',to:[lead.email],whatsappTo:MAIN,leadId:lead._id,subject:'Hello',text:'Message'});

test('reviewed and automatic copies reach main and alt once; switch off and security stay main-only',async()=>{
 const lead=await person();
 for(const event of ['lead.message','invoice.created','sendClientAccountCreatedEmail','auth.otp']){
  const mail={...draft(lead),event}; const resolved=await availability(mail);
  assert.equal(resolved.recipients.length,['sendClientAccountCreatedEmail','auth.otp'].includes(event)?1:2);
  await enqueueWhatsAppForEmail(mail);await enqueueWhatsAppForEmail(mail);
  assert.equal(await Queue.countDocuments({emailDraftId:mail._id}),resolved.recipients.length);
 }
 process.env.ALT_PHONE_SENDING_ENABLED='false';const mail=draft(lead);assert.equal((await availability(mail)).recipients.length,1);
 await enqueueWhatsAppForEmail(mail);assert.equal(await Queue.countDocuments({emailDraftId:mail._id}),1);
});
test('invalid and identical alt are dropped; a blocked alt never disables reachable main',async()=>{
 const lead=await person({altPhone:'bad'}); assert.equal((await availability(draft(lead))).recipients.length,1);
 await Lead.updateOne({_id:lead._id},{$set:{altPhone:'+91 98765 43210'}});assert.equal((await availability(draft(lead))).recipients.length,1);
 await Lead.updateOne({_id:lead._id},{$set:{altPhone:ALT}});await person({email:'dead@example.test',phone:ALT,altPhone:'919822222222',status:'Dead',deletedAt:new Date()});
 const resolved=await availability(draft(lead));assert.deepEqual(resolved.recipients.map(r=>r.phone),[MAIN]);assert.equal(resolved.choices.find(x=>x.id==='whatsapp').enabled,true);
 assert.ok((await contactBlocks()).has('919822222222'));
});
test('broadcast adds alt rows and rechecks switch, contact edits and blocks on release',async()=>{
 const lead=await person();let selected=await audience('Contacted');assert.deepEqual(selected.recipients.map(r=>r.phone),[MAIN,ALT]);
 const alt=selected.recipients[1];assert.ok(await eligible('Contacted',alt));process.env.ALT_PHONE_SENDING_ENABLED='false';assert.equal(await eligible('Contacted',alt),null);
 process.env.ALT_PHONE_SENDING_ENABLED='true';await Lead.updateOne({_id:lead._id},{$set:{altPhone:'919822222222'}});assert.equal(await eligible('Contacted',alt),null);
 await person({phone:'919833333333',email:'other@example.test',altPhone:'919822222222'});selected=await audience('Contacted');assert.equal(selected.recipients.filter(r=>r.phone==='919822222222').length,1);
});
test('phone-only proposal retries partial insertion without repeating the successful number',async()=>{
 const lead=await person({email:''}); const proposal={version:1,downloadLink:'https://example.test/proposal.pdf',amount:100};
 const body={text:'Your proposal {{link}}',subject:'Proposal',channels:'whatsapp'};
 const {queueProposalWhatsApp}=require('../helpers/leadProposalMessage');const original=Queue.create;
 Queue.create=function(data,...args){if(data.alt)throw new Error('Injected alt insertion failure');return original.call(this,data,...args);};
 try{await assert.rejects(queueProposalWhatsApp(lead,proposal,body),/Injected/);}finally{Queue.create=original;}
 assert.equal(await Queue.countDocuments(),1);await queueProposalWhatsApp(lead,proposal,body);await queueProposalWhatsApp(lead,proposal,body);
 assert.deepEqual((await Queue.find().lean()).map(r=>r.to).sort(),[MAIN,ALT].sort());
});
test('review retries keep frozen destinations after contacts change',async()=>{
 const lead=await person();const mail=await EmailDraft.create({...draft(lead),application:'portal',status:'pending',expiresAt:new Date(Date.now()+60000)});
 const args={draft:mail,actor:null,decision:{channels:'whatsapp',subject:'Hello',text:'Message'},sendEmail:async()=>{},recordHistory:async()=>{},reviewedMail:()=>({text:'Message',plain:'Message'}),validateContent:()=>{}};
 await deliver(args);await Lead.updateOne({_id:lead._id},{$set:{altPhone:'919822222222'}});await deliver(args);
 assert.deepEqual((await Queue.find({emailDraftId:mail._id}).lean()).map(r=>r.to).sort(),[MAIN,ALT].sort());
});
test('migration previews without changes, replaces old indexes and preserves per-number uniqueness',async()=>{
 const {migrateQueueDraftIndex}=require('../scripts/migrateQueueDraftIndex');const local=mongoose.connection.client.db('isolated_queue_migration');const queue=local.collection('whatsapp_queue');
 await queue.createIndex({emailDraftId:1,email:1},{unique:true,partialFilterExpression:{emailDraftId:{$exists:true}}});await queue.createIndex({finalMessageExpiryId:1},{unique:true,partialFilterExpression:{finalMessageExpiryId:{$type:'objectId'}}});
 const id=new mongoose.Types.ObjectId();await queue.insertOne({emailDraftId:id,email:'a@example.test',to:MAIN});
 assert.equal((await migrateQueueDraftIndex({db:local})).applied,false);await assert.rejects(queue.insertOne({emailDraftId:id,email:'a@example.test',to:ALT}),e=>e.code===11000);
 assert.equal((await migrateQueueDraftIndex({db:local,apply:true})).applied,true);await queue.insertOne({emailDraftId:id,email:'a@example.test',to:ALT});
 await assert.rejects(queue.insertOne({emailDraftId:id,email:'a@example.test',to:ALT}),e=>e.code===11000);assert.equal((await migrateQueueDraftIndex({db:local,apply:true})).applied,true);
});
test('multiple email recipients resolve their own alternate numbers even when draft has a leadId',async()=>{
 const lead=await person();const other=await User.create({email:'client@example.test',phone:'919822222222',roles:['customer']});
 await person({phone:other.phone,email:other.email,altPhone:'919833333333',status:'Won',convertedToUserId:other._id});
 const mail={...draft(lead),to:[lead.email,other.email]};const resolved=await availability(mail);
 const clientRows=resolved.recipients.filter(r=>r.email===other.email);assert.deepEqual(clientRows.map(r=>r.phone),[other.phone,'919833333333']);
});

test('turning alt sending off cancels an already queued alternate before transport',async()=>{
  const {createSender}=require('../whatsapp/src/sender.js');const {State,STATE_ID}=require('../whatsapp/src/models.js');const {RECOMMENDED}=require('../whatsapp/src/settings.js');
  await State.updateOne({_id:STATE_ID},{$set:{settings:{...RECOMMENDED,quietHours:false,minGapSec:0,jitterSec:0,typing:false},paused:false,nextSendAt:null}},{upsert:true});
  const copy=await Queue.create({to:ALT,alt:true,text:'Queued before switch off',event:'invoice.created'});process.env.ALT_PHONE_SENDING_ENABLED='false';
  let sends=0;const sender=createSender({Queue,State,config:{timeZone:'Asia/Kolkata'},transport:{isConnected:()=>true,resolve:async to=>`${to}@s.whatsapp.net`,send:async()=>{sends++;return 'delivered';}}});
  await sender.step();assert.equal(sends,0);assert.equal((await Queue.findById(copy._id)).status,'cancelled');
});
