import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

// Explicit opt-in: this script leaves visible QA transactions in the real shop.
assert.equal(process.env.ALLOW_LIVE_QA_WRITES, 'YES');
const origin = process.env.PWA_TEST_URL || 'http://127.0.0.1:3100';
const run = process.env.QA_RUN || new Date().toISOString().replace(/[:.]/g,'-');
const prefix = `QA LIVE ${run.slice(0,19)}`;
const folder = `.qa-live/${run}`;
await mkdir(folder, {recursive:true});
const client=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const login=await client.auth.signInWithPassword({email:process.env.TEST_ADMIN_EMAIL,password:process.env.TEST_ADMIN_PASSWORD});
assert.equal(login.error,null);
const snapshot=async()=>{const r=await client.rpc('shop_snapshot');assert.equal(r.error,null);return r.data;};
const waitCloud=async predicate=>{for(let i=0;i<60;i++){const data=await snapshot();if(predicate(data))return data;await new Promise(r=>setTimeout(r,1000));}throw new Error('Cloud did not reach expected state within 60 seconds');};
const baseline=await snapshot();
let context;
const launch=()=>chromium.launchPersistentContext(`${folder}/profile`,{channel:'chrome',headless:true,viewport:{width:1440,height:1000}});
const journal={prefix,origin,profile:`${folder}/profile`,stages:[]};
const stage=async name=>{journal.stages.push(name);await writeFile(`${folder}/journal.json`,JSON.stringify(journal,null,2));console.log(name);};
try {
 context=await launch();
 let page=await context.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const local=()=>page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('AzizWholesaleOfflineDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const names=['products','sales','sale_items','returns','return_items','sync_queue','settings'];
  try{return Object.fromEntries(await Promise.all(names.map(name=>new Promise(resolve=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve([name,r.result])}))))}finally{db.close()}
 });
 const sync=async()=>{
  await page.getByRole('button',{name:'Sync Now',exact:true}).click();
  await page.waitForFunction(async()=>{
   const db=await new Promise(resolve=>{const r=indexedDB.open('AzizWholesaleOfflineDB');r.onsuccess=()=>resolve(r.result)});
   const rows=await new Promise(resolve=>{const r=db.transaction('sync_queue').objectStore('sync_queue').getAll();r.onsuccess=()=>resolve(r.result)});db.close();
   return rows.every(r=>r.status==='SYNCED');
  },null,{timeout:90000});
  await page.getByRole('button',{name:'Sync Now',exact:true}).waitFor({state:'visible'});
 };
 await page.goto(origin);
 if(!process.env.QA_RUN){
 await page.getByLabel('Email',{exact:true}).fill(process.env.TEST_ADMIN_EMAIL);
 await page.getByLabel('Password',{exact:true}).fill(process.env.TEST_ADMIN_PASSWORD);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 }
 await page.getByRole('heading',{name:'Aziz & Son Wholesaler',exact:true}).waitFor();
 await stage('Authenticated browser ready');
 await page.waitForFunction(()=>document.querySelector('.sync-badge')?.textContent?.includes('All changes saved'),null,{timeout:1500}).catch(()=>{});
 await page.evaluate(async()=>{await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('SW readiness timeout')),10000))])});
 await stage('Offline service worker ready');
 for(let attempt=0;attempt<3;attempt++){
  await page.getByRole('button',{name:/^Products/}).click();
  try {await page.locator('#product-form').waitFor({timeout:5000});break;}catch(e){if(attempt===2)throw e;}
 }
 const products=[];
 for(const [suffix,buy,sell,qty,unit] of [['Boxes',100,150,10,'Box'],['Packets',50,80,20,'Packet'],['Crates',200,260,8,'Crate']]){
  const name=`${prefix} ${suffix}`,form=page.locator('#product-form');
  const existing=(await local()).products.find(p=>p.name===name);
  if(existing){products.push(existing);continue;}
  await form.getByLabel('Product name').fill(name);await form.locator('select').selectOption(unit);
  await form.getByLabel('Buying rate').fill(String(buy));await form.getByLabel('Selling rate').fill(String(sell));await form.getByLabel('Initial stock').fill(String(qty));
  await form.getByRole('button',{name:'Add product',exact:true}).click();
  await page.locator('table').getByText(name,{exact:true}).waitFor();
  const p=(await local()).products.find(p=>p.name===name);assert.ok(p);products.push(p);
  await stage(`Created ${name}`);
 }
 if((await local()).products.find(p=>p.id===products[0].id).current_stock===10){
 await page.locator('.inventory-tool summary').first().click();
 const purchase=page.locator('.inventory-action-form').first();
 await purchase.locator('select').selectOption(products[0].id);
 await purchase.getByLabel('Quantity',{exact:true}).fill('5');await purchase.getByLabel('Buying price').fill('130');
 await purchase.getByRole('button',{name:'Record stock purchase'}).click();
 await page.getByRole('status').filter({hasText:'Stock recorded and average buying cost recalculated.'}).waitFor();
 }
 await sync();
 let cloud=await waitCloud(s=>s.products.find(p=>p.id===products[0].id)?.average_cost===110);assert.equal(cloud.products.find(p=>p.id===products[0].id).average_cost,110);
 await stage('Online product creation and changed-price purchase confirmed in Supabase; average buying cost 110.');
 const sell=async(lines,customer)=>{
  await page.getByRole('button',{name:'New sale',exact:true}).click();
  await page.getByLabel('Customer name (optional)').fill(customer);
  for(let i=0;i<lines.length;i++){
   if(i)await page.getByRole('button',{name:'Add another item',exact:true}).click();
   await page.locator('[aria-haspopup="listbox"]').nth(i).click();
   await page.getByText(lines[i][0].name,{exact:true}).click();
   await page.locator('.pos-qty-group input').nth(i).fill(String(lines[i][1]));
  }
  await page.getByRole('button',{name:'Save & Print bill',exact:true}).click();await page.getByRole('button',{name:'Close',exact:true}).click();
  return (await local()).sales.find(s=>s.customer_name===customer);
 };
 const refund=async(sale,product,qty,damaged=false)=>{
  await page.getByRole('button',{name:'Returns',exact:true}).click();await page.getByLabel('Select invoice to return').selectOption(sale.id);
  await page.locator('[aria-haspopup="listbox"]').first().click();await page.getByText(product.name,{exact:true}).click();
  await page.locator('.pos-qty-group input').first().fill(String(qty));
  await page.getByLabel('Returned goods condition').selectOption(damaged?'DAMAGED':'SALEABLE');
  await page.getByRole('button',{name:'Save & Print Return Receipt',exact:true}).click();await page.getByRole('button',{name:'Close',exact:true}).click();
 };
 let sale=(await local()).sales.find(s=>s.customer_name===`${prefix} Offline customer`);
 if(!sale){
 await context.setOffline(true);
 sale=await sell([[products[0],4],[products[1],3]],`${prefix} Offline customer`);
 assert.equal(sale.total,840);assert.equal(sale.original_profit,250);
 await refund(sale,products[0],1);await refund(sale,products[1],1,true);
 let data=await local();assert.equal(data.sales.find(s=>s.id===sale.id).net_total,610);
 assert.equal(data.sync_queue.filter(q=>q.status!=='SYNCED').length,3);
 assert.equal((await snapshot()).sales.some(s=>s.id===sale.id),false);
 await stage('Offline sale 840, saleable refund 150, damaged refund 80 verified locally; all three absent from cloud until reconnect.');
 await context.close();context=await launch();await context.setOffline(true);page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.getByRole('heading',{name:'Aziz & Son Wholesaler',exact:true}).waitFor();
 data=await local();assert.equal(data.sales.find(s=>s.id===sale.id).net_total,610);assert.equal(data.sync_queue.filter(q=>q.status!=='SYNCED').length,3);
 await stage('Offline records and pending uploads survived a complete Chrome restart.');
 await context.setOffline(false);
 }
 // Automatic online event must drain the queue without clicking Sync Now.
 await page.waitForFunction(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('AzizWholesaleOfflineDB');r.onsuccess=()=>resolve(r.result)});const rows=await new Promise(resolve=>{const r=db.transaction('sync_queue').objectStore('sync_queue').getAll();r.onsuccess=()=>resolve(r.result)});db.close();return rows.every(r=>r.status==='SYNCED')},null,{timeout:90000});
 cloud=await waitCloud(s=>s.sales.find(b=>b.id===sale.id)?.net_total===610);assert.equal(cloud.sales.find(s=>s.id===sale.id).net_total,610);
 await stage('Automatic reconnection uploaded the offline sale and both returns to real Supabase.');
 let sale2=(await local()).sales.find(s=>s.customer_name===`${prefix} Online customer`);
 if(!sale2){sale2=await sell([[products[2],2]],`${prefix} Online customer`);await refund(sale2,products[2],2);}
 await sync();
 cloud=await waitCloud(s=>s.sales.find(b=>b.id===sale2.id)?.status==='FULLY_RETURNED');
 const ids=products.map(p=>p.id),saleIds=[sale.id,sale2.id];
 const finalProducts=cloud.products.filter(p=>ids.includes(p.id));
 for(const [i,stock,cost] of [[0,12,110],[1,17,50],[2,8,200]]){const p=finalProducts.find(p=>p.id===products[i].id);assert.equal(p.current_stock,stock);assert.equal(p.average_cost,cost);}
 const sales=cloud.sales.filter(s=>saleIds.includes(s.id)),returns=cloud.returns.filter(r=>saleIds.includes(r.sale_id));
 assert.equal(sales.length,2);assert.equal(returns.length,3);assert.equal(sales.find(s=>s.id===sale2.id).status,'FULLY_RETURNED');
 const totals={gross:sales.reduce((n,s)=>n+s.total,0),refunds:returns.reduce((n,r)=>n+r.refund_total,0),profit:sales.reduce((n,s)=>n+s.original_profit,0)-returns.reduce((n,r)=>n+r.profit_reversed,0)};
 assert.deepEqual(totals,{gross:1360,refunds:750,profit:130});
 await sync();const afterRetry=await snapshot();assert.equal(afterRetry.sales.filter(s=>saleIds.includes(s.id)).length,2);assert.equal(afterRetry.returns.filter(r=>saleIds.includes(r.sale_id)).length,3);
 for(const original of baseline.sales)assert.ok(afterRetry.sales.some(s=>s.id===original.id),'existing invoice retained');
 assert.deepEqual(errors,[]);
 await mkdir('qa-results',{recursive:true});
 await writeFile('qa-results/live-visible-results.json',JSON.stringify({prefix,origin,products:finalProducts.map(p=>({id:p.id,name:p.name,stock:p.current_stock,averageCost:p.average_cost})),sales:sales.map(s=>({id:s.id,invoice:s.invoice_number,date:s.sale_date,total:s.total,net:s.net_total,profit:s.original_profit,status:s.status})),returns:returns.map(r=>({number:r.return_number,refund:r.refund_total,profitReversed:r.profit_reversed})),totals,stages:journal.stages},null,2));
 await stage('PASS: real Supabase stock, sales, returns and profit verified; records left visible.');
} catch(e){if(context){const p=context.pages().at(-1);if(p){await p.screenshot({path:`${folder}/failure.png`}).catch(()=>{});console.log('PAGE',await p.locator('body').innerText().then(t=>t.slice(0,2500)).catch(()=>''));}}await stage(`FAILED: ${e.message}`);throw e;}finally{if(context)await context.close();}
