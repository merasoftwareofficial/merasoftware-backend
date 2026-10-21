// Admin "Create Project" form + admin payment recording (work96):
//   ₹0 FREE project, optional website offer, "project created" review mail, and the
//   method-specific payment evidence rules (helpers/paymentEvidence.js).
// Isolated: in-memory MongoDB, the website and the mail provider are never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { requestMiddleware } = require('../helpers/emailController');
const { EmailDraft } = require('../models/emailControlModel');
const userModel = require('../models/userModel');
const orderModel = require('../models/orderProductModel');
const invoiceModel = require('../models/invoiceModel');
const transactionModel = require('../models/transactionModel');
const categoryBasePriceModel = require('../models/categoryBasePriceModel');
const authToken = require('../middleware/authToken');

const nativeFetch = global.fetch;
let db, server, base, admin, customer, websiteCalls, app;
const LIVE_OFFERS = [
  { slug: 'diwali', title: 'Diwali Offer', status: 'published', endsAt: '2099-01-01T00:00:00.000Z', mainPrice: 10000, offerPrice: 0, pricingRule: 'fixed_price', applicableCategories: ['standard_websites'], packageIds: [], inclusions: ['Free starter scope'], resolvedTerms: ['Agreed free setup'], quoteKey: 'diwali-v1' },
  { slug: 'page', title: 'Business Growth Starter', status: 'published', endsAt: '2099-01-01T00:00:00.000Z', mainPrice: 10000, offerPrice: 699, pricingRule: 'fixed_price', applicableCategories: ['standard_websites'], packageIds: [], inclusions: ['Starter scope'], resolvedTerms: ['Agreed starter terms'], quoteKey: 'starter-v1' },
];

const cookie = (user) => `token=${jwt.sign({ _id: String(user._id), role: user.roles[0] }, process.env.TOKEN_SECRET_KEY)}`;
async function api(path, body, method = 'POST') {
  const response = await nativeFetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie(admin) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, ...await response.json() };
}
const create = (body) => api(`/admin/clients/${customer._id}/create-project`, { category: 'standard_websites', ...(body.offerSlug === 'diwali' ? { offerQuoteKey: 'diwali-v1' } : {}), ...body });

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-project-form-secret';
  process.env.PORTFOLIO_WEBSITE_URL = 'https://website.example.test';
  process.env.PORTFOLIO_INTEGRATION_SECRET = 'x'.repeat(40);
  db = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  await mongoose.connect(db.getUri(), { dbName: 'project-form-isolated-test' });
  [admin, customer] = await userModel.create([
    { name: 'Admin', email: 'admin@example.test', roles: ['admin'] },
    { name: 'Customer', email: 'customer@example.test', roles: ['customer'] },
  ]);
  await categoryBasePriceModel.create({ category: 'standard_websites', basePrice: 10000 });
  // Only the website's live-offers endpoint is mocked; anything else is a test failure.
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://website.example.test/api/offers/live');
    assert.equal(options.headers.Authorization, `Bearer ${'x'.repeat(40)}`);
    websiteCalls += 1;
    return new Response(JSON.stringify({ offers: LIVE_OFFERS }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  app = express(); app.use(express.json()); app.use(cookieParser()); app.use(requestMiddleware);
  app.post('/admin/clients/:customerId/create-project', authToken, require('../controller/order/adminCreateProjectOrder'));
  app.get('/admin/website-offers', authToken, require('../controller/order/adminWebsiteOffers'));
  const salesController = require('../controller/order/salesPackagesController');
  app.get('/admin/sales-packages', authToken, salesController.adminRead);
  app.patch('/admin/sales-packages', authToken, salesController.adminSave);
  app.get('/integration/sales-packages', salesController.integrationRead);
  app.post('/admin/projects/:orderId/approval', authToken, require('../controller/order/approveProjectOrder'));
  app.post('/admin/clients/:customerId/recharge-wallet', authToken, require('../controller/user/adminRechargeWallet'));
  await transactionModel.syncIndexes();
  await orderModel.syncIndexes();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  websiteCalls = 0;
  await Promise.all([orderModel.deleteMany({}), invoiceModel.deleteMany({}), transactionModel.deleteMany({}), EmailDraft.deleteMany({}), require('../models/salesCatalogueModel').deleteMany({}), require('../models/productModel').deleteMany({})]);
});
after(async () => {
  global.fetch = nativeFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await db?.stop();
});

test('₹0 project: approved at birth, FREE paid invoice with discount line, final invoice paid, review mail queued', async () => {
  const result = await create({ sellingPrice: 0, paymentType: 'full', offerSlug: 'diwali' });
  assert.equal(result.status, 201, result.message);
  assert.equal(result.emailStatus, 'awaiting-review');
  assert.equal(result.emailDraftIds.length, 1);
  const draft = await EmailDraft.findById(result.emailDraftIds[0]).lean();
  assert.equal(draft.event, 'sendProjectCreatedEmail');
  assert.deepEqual(draft.to, ['customer@example.test']);
  assert.match(draft.text, /FREE/);
  assert.match(draft.text, /Diwali Offer/);

  const order = await orderModel.findById(result.data._id).lean();
  assert.equal(order.orderVisibility, 'approved');
  assert.equal(order.status, 'in_progress');
  assert.equal(order.paymentComplete, true);
  assert.deepEqual(order.projectSnapshot.offer, { slug: 'diwali', title: 'Diwali Offer' });

  const invoice = await invoiceModel.findOne({ orderId: order._id, invoiceType: 'project' }).lean();
  assert.equal(invoice.amount, 0);
  assert.equal(invoice.status, 'paid');
  assert.ok(invoice.paidDate);
  assert.deepEqual(invoice.lineItems.map((item) => [item.name, item.price]), [
    ['Diwali Offer', 10000],
    ['Offer benefit (Diwali Offer)', -10000],
  ]);
  const finalInvoice = await invoiceModel.findOne({ orderId: order._id, invoiceType: 'project_final' }).lean();
  assert.equal(finalInvoice.status, 'paid');
  assert.equal(await transactionModel.countDocuments(), 0, 'a free project records no payment');
});

test('₹0 project cannot be split into installments; missing price is still refused', async () => {
  assert.equal((await create({ sellingPrice: 0, paymentType: 'partial', installmentCount: 2 })).status, 400);
  assert.equal((await create({ sellingPrice: '', paymentType: 'full' })).status, 400);
  assert.equal(await orderModel.countDocuments(), 0);
});

test('offer that is not live on the website is refused before anything is written', async () => {
  const result = await create({ sellingPrice: 5000, paymentType: 'full', offerSlug: 'expired-offer' });
  assert.equal(result.status, 400);
  assert.equal(await orderModel.countDocuments(), 0);
  assert.equal(await invoiceModel.countDocuments(), 0);
});

test('website offers endpoint lists the live offers', async () => {
  const result = await api('/admin/website-offers', null, 'GET');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, LIVE_OFFERS);
});

test('UPI: digits only, at least 12 — a bad reference leaves no half-made project', async () => {
  const bad = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'upi', transactionReference: '12345678901' } });
  assert.equal(bad.status, 400);
  assert.equal(await orderModel.countDocuments(), 0);
  assert.equal(await invoiceModel.countDocuments(), 0);

  const ok = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'upi', transactionReference: '412345678901' } });
  assert.equal(ok.status, 201, ok.message);
  const invoice = await invoiceModel.findOne({ invoiceType: 'project' }).lean();
  assert.equal(invoice.status, 'paid');
  assert.deepEqual(invoice.lineItems.at(-1), { name: 'Discount', price: -2000 });
});

test('bank transfer needs a mode and an alphanumeric UTR; a UTR is recorded once', async () => {
  const noMode = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'bank_transfer', transactionReference: 'HDFC12345' } });
  assert.equal(noMode.status, 400);
  const badRef = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'bank_transfer', transactionReference: 'HD-1', paymentDetails: { transferMode: 'neft' } } });
  assert.equal(badRef.status, 400);
  assert.equal(await orderModel.countDocuments(), 0);

  const ok = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'bank_transfer', transactionReference: 'hdfcn5202610161', paymentDetails: { transferMode: 'neft' } } });
  assert.equal(ok.status, 201, ok.message);
  const txn = await transactionModel.findOne({ paymentMethod: 'bank_transfer' }).lean();
  assert.equal(txn.paymentEvidence.bankTransferMode, 'neft');
  assert.equal(txn.paymentEvidence.bankReference, 'HDFCN5202610161');
  assert.equal(txn.upiTransactionId, 'HDFCN5202610161');

  const dup = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'bank_transfer', transactionReference: 'HDFCN5202610161', paymentDetails: { transferMode: 'imps' } } });
  assert.equal(dup.status, 409);
  assert.equal(await orderModel.countDocuments(), 1);
});

test('cheque needs a 6-digit number, bank name and date', async () => {
  const bad = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'cheque', transactionReference: '12345', paymentDetails: { chequeBankName: 'SBI', chequeDate: '2026-10-16' } } });
  assert.equal(bad.status, 400);
  const noBank = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'cheque', transactionReference: '123456', paymentDetails: { chequeDate: '2026-10-16' } } });
  assert.equal(noBank.status, 400);

  const ok = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'cheque', transactionReference: '123456', paymentDetails: { chequeBankName: 'State Bank of India', chequeDate: '2026-10-16' } } });
  assert.equal(ok.status, 201, ok.message);
  const txn = await transactionModel.findOne({ paymentMethod: 'cheque' }).lean();
  assert.equal(txn.paymentEvidence.chequeNumber, '123456');
  assert.equal(txn.paymentEvidence.chequeBankName, 'State Bank of India');
  const invoice = await invoiceModel.findOne({ invoiceType: 'project' }).lean();
  assert.equal(invoice.paymentMethod, 'cheque');
});

test('cash needs no reference and stores none', async () => {
  const ok = await create({ sellingPrice: 8000, paymentType: 'full', recordPayment: { paymentMethod: 'cash', transactionReference: 'anything typed' } });
  assert.equal(ok.status, 201, ok.message);
  const txn = await transactionModel.findOne({ paymentMethod: 'cash' }).lean();
  assert.equal(txn.upiTransactionId, null);
});

test('approve-with-payment and wallet recharge apply the same rules', async () => {
  const pending = await create({ sellingPrice: 8000, paymentType: 'full' });
  assert.equal(pending.status, 201);
  const badApprove = await api(`/admin/projects/${pending.data._id}/approval`, { mode: 'approve_with_payment', paymentMethod: 'bank_transfer', transactionReference: 'ABC123' });
  assert.equal(badApprove.status, 400);
  const approve = await api(`/admin/projects/${pending.data._id}/approval`, { mode: 'approve_with_payment', paymentMethod: 'bank_transfer', transactionReference: 'ABC123456', paymentDetails: { transferMode: 'rtgs' } });
  assert.equal(approve.status, 200, approve.message);
  assert.equal((await orderModel.findById(pending.data._id).lean()).orderVisibility, 'approved');

  const badRecharge = await api(`/admin/clients/${customer._id}/recharge-wallet`, { amount: 500, paymentMethod: 'cheque', reference: '123' });
  assert.equal(badRecharge.status, 400);
  const before = (await userModel.findById(customer._id).lean()).walletBalance || 0;
  assert.equal(before, 0, 'a refused recharge never credits the wallet');
  const recharge = await api(`/admin/clients/${customer._id}/recharge-wallet`, { amount: 500, paymentMethod: 'cheque', reference: '654321', paymentDetails: { chequeBankName: 'HDFC Bank', chequeDate: '2026-10-15' } });
  assert.equal(recharge.status, 201, recharge.message);
  assert.equal((await userModel.findById(customer._id).lean()).walletBalance, 500);
});


test('package catalogue: three starter prices, category eligibility, immutable agreement, no service purchase', async () => {
  const catalog = await api('/admin/sales-packages', null, 'GET');
  assert.equal(catalog.status, 200, catalog.message);
  assert.deepEqual(catalog.data.packages.map(item => item.quote.finalPrice), [699, 2699, 4699]);
  const starter = catalog.data.packages[0];
  const created = await create({ sellingPrice: 699, paymentType: 'partial', installmentCount: 2, packageId: starter.id, packageQuoteKey: starter.quoteKey, offerSlug: 'page' });
  assert.equal(created.status, 201, created.message);
  const order = await orderModel.findById(created.data._id).lean();
  assert.equal(order.projectSnapshot.salesAgreement.package.id, 'starter');
  assert.equal(order.projectSnapshot.salesAgreement.finalPrice, 699);
  assert.equal(order.projectSnapshot.salesAgreement.offerDiscount, 9301);
  assert.equal(order.installments.reduce((sum, item) => sum + item.amount, 0), 699);
  assert.equal(await orderModel.countDocuments({ isServicePlan: true }), 0);
  const edited = { ...starter, name: 'Renamed Starter', inclusions: ['Changed scope'] };
  const saved = await api('/admin/sales-packages', { item: edited, creating: false }, 'PATCH');
  assert.equal(saved.status, 200, saved.message);
  const unchanged = await orderModel.findById(order._id).lean();
  assert.equal(unchanged.projectSnapshot.salesAgreement.package.name, 'Business Starter');
  assert.notDeepEqual(unchanged.projectSnapshot.salesAgreement.scope, ['Changed scope']);
  const stale = await create({ sellingPrice: 699, packageId: starter.id, packageQuoteKey: starter.quoteKey });
  assert.equal(stale.status, 409);
  assert.equal(await orderModel.countDocuments(), 1);
});

test('tampered price/category/quote and unexplained discount are refused before writes', async () => {
  const catalog = await api('/admin/sales-packages', null, 'GET');
  const starter = catalog.data.packages[0];
  const base = { sellingPrice: 699, packageId: starter.id, packageQuoteKey: starter.quoteKey };
  assert.equal((await create({ ...base, sellingPrice: 1 })).status, 409);
  assert.equal((await create({ ...base, category: 'dynamic_websites' })).status, 400);
  assert.equal((await create({ ...base, packageQuoteKey: 'stale' })).status, 409);
  assert.equal((await create({ ...base, sellingPrice: 599, adminDiscount: 100 })).status, 400);
  assert.equal(await orderModel.countDocuments(), 0);
  assert.equal(await invoiceModel.countDocuments(), 0);
  const valid = await create({ ...base, sellingPrice: 599, adminDiscount: 100, discountReason: 'Approved sample adjustment' });
  assert.equal(valid.status, 201, valid.message);
  const invoice = await invoiceModel.findOne({ orderId: valid.data._id }).lean();
  assert.equal(invoice.lineItems.reduce((sum, item) => sum + item.price, 0), 599);
  assert.match(invoice.lineItems.at(-1).name, /Additional admin discount/);
});

test('archived package cannot create new projects or reappear as a default', async () => {
  const catalog = await api('/admin/sales-packages', null, 'GET');
  const starter = catalog.data.packages[0];
  assert.equal((await api('/admin/sales-packages', { item: { ...starter, status: 'archived' }, creating: false }, 'PATCH')).status, 200);
  const rejected = await create({ sellingPrice: 699, packageId: starter.id, packageQuoteKey: starter.quoteKey });
  assert.equal(rejected.status, 400);
  const fresh = await api('/admin/sales-packages', null, 'GET');
  assert.equal(fresh.data.packages.find(item => item.id === 'starter').status, 'archived');
});

test('package management requires portal admin; integration requires shared secret', async () => {
  const forbidden = await nativeFetch(base + '/admin/sales-packages', { headers: { Cookie: cookie(customer) } });
  assert.equal(forbidden.status, 403);
  assert.equal((await nativeFetch(base + '/integration/sales-packages')).status, 401);
  const allowed = await nativeFetch(base + '/integration/sales-packages', { headers: { Authorization: `Bearer ${'x'.repeat(40)}` } });
  assert.equal(allowed.status, 200);
  const catalog = await allowed.json();
  assert.equal(catalog.data.packages.length, 3);
  assert.equal('linkedPlanIds' in catalog.data.packages[0], false);
});


test('repeated creation request creates one project and one payable bill', async () => {
  const payload = { creationKey: 'isolated-request-123456789', sellingPrice: 1000, paymentType: 'full' };
  const first = await create(payload);
  const second = await create(payload);
  assert.equal(first.status, 201, first.message);
  assert.equal(second.status, 200, second.message);
  assert.equal(String(first.data._id), String(second.data._id));
  assert.equal(await orderModel.countDocuments(), 1);
  assert.equal(await invoiceModel.countDocuments({ invoiceType: 'project' }), 1);
  assert.equal(await invoiceModel.countDocuments({ invoiceType: 'project_final' }), 1);
  assert.equal((await create({ ...payload, sellingPrice: 2000 })).status, 409);
});

if (process.env.TEST_SALES_BROWSER === '1') test('actual package editor, admin project form and client agreement work in the browser', { timeout: 120000 }, async () => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { build } = require('../../merasoftware/node_modules/esbuild');
  const { chromium } = require('../../merasoftware/node_modules/playwright');
  const parser = require('../../frontend/node_modules/@babel/parser');
  const frontend = path.resolve(__dirname, '../../frontend'); const website = path.resolve(__dirname, '../../merasoftware');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mera-sales-browser-'));
  const source = fs.readFileSync(path.join(frontend, 'src/pages/AdminClientWorkspace.js'), 'utf8');
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const declaration = ast.program.body.find(node => node.type === 'VariableDeclaration' && node.declarations.some(row => row.id.name === 'CreateProjectForClientForm'));
  const inputs = source.slice(source.indexOf('const projectFormInputClassName'), source.indexOf('const CreateProjectForClientForm'));
  const apiSource = `const SummaryApi=${JSON.stringify({ allProduct: { url: base+'/products' }, categoryBasePrices: { url: base+'/base-prices', method: 'get' }, adminSalesPackages: { url: base+'/admin/sales-packages' }, adminCreateProjectOrder: { url: base+'/admin/clients', method: 'post' } })};`;
  const entry = `import React,{useState,useEffect,useRef} from 'react';import{createRoot}from'react-dom/client';import{X,Save}from'lucide-react';import{toast}from'sonner';import projectCategoryOptions,{isFeatureForCategory}from'../helpers/projectCategoryOptions';import PaymentMethodFields from '../components/PaymentMethodFields';import{createPaymentEntry,getPaymentEntryError,toPaymentRequest}from'../helpers/paymentMethodRules';import{buildInstallmentPreview}from'../helpers/projectInstallments';import ProjectAgreement from '../components/ProjectAgreement';${apiSource}const PROJECT_CATEGORIES=projectCategoryOptions;const FEATURE_UPGRADE_CATEGORY='feature_upgrades';const getCategoryLabel=cat=>projectCategoryOptions.find(row=>row.value===cat)?.label||cat;${inputs}${source.slice(declaration.start,declaration.end)};const root=createRoot(document.getElementById('app'));if(location.pathname==='/client-agreement'){fetch('/latest-order').then(r=>r.json()).then(order=>root.render(<ProjectAgreement order={order}/>));}else root.render(<CreateProjectForClientForm clientName="Fixture Client" customerId="${customer._id}" onCancel={()=>{}} onCreated={()=>document.body.setAttribute('data-created','true')}/>);`;
  await build({ stdin: { contents: entry, loader: 'jsx', resolveDir: path.join(frontend,'src/pages') }, bundle:true, loader:{'.js':'jsx'}, outfile:path.join(folder,'project.js'), platform:'browser', jsx:'automatic' });
  const managerEntry = `import React from 'react';import{createRoot}from'react-dom/client';import{PackagesManager}from'@/app/admin/packages/packages-manager';fetch('/api/packages').then(r=>r.json()).then(initial=>createRoot(document.getElementById('app')).render(<PackagesManager initial={initial}/>));`;
  await build({ stdin:{contents:managerEntry,loader:'tsx',resolveDir:website},bundle:true,outfile:path.join(folder,'manager.js'),platform:'browser',jsx:'automatic',tsconfig:path.join(website,'tsconfig.json') });
  app.get('/api/time',(req,res)=>res.json({now:Date.now()}));
  app.get('/products', (req,res)=>res.json({success:true,data:[]}));
  app.get('/base-prices', (req,res)=>res.json({success:true,data:[{category:'standard_websites',basePrice:10000}]}));
  app.get('/api/packages', async(req,res)=>{const result=await nativeFetch(base+'/admin/sales-packages',{headers:{Cookie:cookie(admin)}});res.status(result.status).json((await result.json()).data);});
  app.patch('/api/packages', async(req,res)=>{const result=await nativeFetch(base+'/admin/sales-packages',{method:'PATCH',headers:{Cookie:cookie(admin),'Content-Type':'application/json'},body:JSON.stringify(req.body)});const body=await result.json();res.status(result.status).json(result.ok?body.data:{error:body.message});});
  app.get('/latest-order',async(req,res)=>res.json(await orderModel.findOne().lean()));
  app.get('/ui/:asset',(req,res)=>res.sendFile(path.join(folder,req.params.asset)));
  for(const route of ['/project-form','/package-manager','/client-agreement'])app.get(route,(req,res)=>res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px sans-serif;max-width:1000px;margin:20px auto;padding:16px}input,select,textarea{box-sizing:border-box;max-width:100%;padding:8px}label{display:block;margin:8px 0}fieldset{min-width:0}button{padding:10px;margin:8px}p,li{overflow-wrap:anywhere}</style></head><body><main id="app"></main><script src="/ui/${route==='/package-manager'?'manager':'project'}.js"></script></body></html>`));
  let browser;
  try {
    browser=await chromium.launch({headless:true});const context=await browser.newContext();
    await context.addCookies([{name:'token',value:cookie(admin).slice(6),url:base}]);
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error('Fixture browser error:',error.message);});
    await page.goto(base+'/package-manager');await page.getByRole('button',{name:'New package +',exact:true}).click();
    await page.getByLabel('Package name',{exact:true}).fill('Browser Package');await page.getByLabel('Permanent ID',{exact:true}).fill('browser-package');
    await page.getByLabel('Description',{exact:true}).fill('Editable starter example');await page.getByLabel('Included work (one item per line)',{exact:true}).fill('One-page business website');
    await page.getByLabel('Regular one-time price (₹)',{exact:true}).fill('10000');await page.getByLabel('Linked offer',{exact:true}).selectOption('page');await page.getByLabel('Status',{exact:true}).selectOption('published');
    await page.getByRole('button',{name:'Save package',exact:true}).click();await page.getByText('Package saved. Existing client agreements stay unchanged.',{exact:true}).waitFor();
    await page.reload();await page.getByRole('heading',{name:'Browser Package',exact:true}).waitFor();
    await page.goto(base+'/project-form');await page.locator('select').first().selectOption('standard_websites');
    await page.getByLabel('Showcase package',{exact:true}).selectOption('browser-package');
    const selling=page.locator('input[placeholder="e.g. 12000"]');await page.waitForFunction(()=>document.querySelector('input[placeholder="e.g. 12000"]')?.value==='699');
    assert.equal(await selling.getAttribute('readonly'),'');
    await page.getByRole('button',{name:'Next: Payment Settings',exact:true}).click();await page.getByRole('button',{name:'Just Add Project, Let Client Pay the Bill',exact:true}).click();
    await page.locator('button[type="submit"]').click();await page.waitForFunction(()=>document.body.dataset.created==='true');
    assert.equal(await orderModel.countDocuments(),1);assert.equal(await orderModel.countDocuments({isServicePlan:true}),0);
    await page.goto(base+'/client-agreement');await page.getByRole('heading',{name:'Browser Package',exact:true}).waitFor();await page.getByText('Offer applied: Business Growth Starter',{exact:true}).waitFor();
    for(const width of [390,1440]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(folder,`client-${width}.png`),fullPage:true});}
    assert.deepEqual(errors,[]);console.log('Sales browser evidence: '+folder);
  } finally {if(browser)await browser.close();}
});


test('package related-plan references do not purchase a service; extras and discounts reconcile', async () => {
  const Product = require('../models/productModel');
  const plan = await Product.create({ serviceName: 'Related Service', category: 'service_plan', isServicePlan: true, isHidden: false, sellingPrice: 1000, servicePlan: { purchaseType: 'one_time' } });
  const feature = await Product.create({ serviceName: 'Extra Design', category: 'feature_upgrades', isHidden: false, sellingPrice: 100.5, compatibleWith: ['standard_websites'], isQuantityBased: true });
  let catalog = await api('/admin/sales-packages', null, 'GET');
  let starter = catalog.data.packages[0];
  assert.equal((await api('/admin/sales-packages', { item: { ...starter, linkedPlanIds: [String(plan._id)] }, creating: false }, 'PATCH')).status, 200);
  catalog = await api('/admin/sales-packages', null, 'GET'); starter = catalog.data.packages[0];
  const created = await create({ sellingPrice: 850, packageId: starter.id, packageQuoteKey: starter.quoteKey, featureIds: [String(feature._id)], featureQuantities: { [String(feature._id)]: 2 }, adminDiscount: 50, discountReason: 'Sample client discount' });
  assert.equal(created.status, 201, created.message);
  const order = await orderModel.findById(created.data._id).lean();
  assert.equal(order.projectSnapshot.salesAgreement.extrasTotal, 201);
  assert.deepEqual(order.projectSnapshot.salesAgreement.package.linkedPlanIds, [String(plan._id)]);
  assert.equal(await orderModel.countDocuments({ isServicePlan: true }), 0);
  const invoice = await invoiceModel.findOne({ orderId: order._id, invoiceType: 'project' }).lean();
  assert.equal(invoice.lineItems.reduce((sum, item) => sum + item.price, 0), 850);
  assert.equal((await create({ sellingPrice: 699, packageId: starter.id, packageQuoteKey: starter.quoteKey, featureIds: [String(feature._id)], featureQuantities: { [String(feature._id)]: -1 } })).status, 400);
});
