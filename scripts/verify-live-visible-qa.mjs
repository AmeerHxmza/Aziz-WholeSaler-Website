import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const expected=JSON.parse(await readFile('qa-results/live-visible-results.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(expected.origin);
 await page.getByLabel('Email',{exact:true}).fill(process.env.TEST_ADMIN_EMAIL);
 await page.getByLabel('Password',{exact:true}).fill(process.env.TEST_ADMIN_PASSWORD);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('heading',{name:'Aziz & Son Wholesaler',exact:true}).waitFor();
 const read=()=>page.evaluate(async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('AzizWholesaleOfflineDB');r.onsuccess=()=>resolve(r.result)});
 const result=Object.fromEntries(await Promise.all(['products','sales','returns','sync_queue'].map(name=>new Promise(resolve=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve([name,r.result])}))));db.close();return result;
 });
 let data;
 for(let i=0;i<60;i++){data=await read();if(expected.sales.every(s=>data.sales.some(a=>a.id===s.id))&&data.returns.length>=3)break;await page.waitForTimeout(1000);}
 for(const p of expected.products){const actual=data.products.find(a=>a.id===p.id);assert.ok(actual);assert.equal(actual.current_stock,p.stock);assert.equal(actual.average_cost,p.averageCost);}
 for(const s of expected.sales){const actual=data.sales.find(a=>a.id===s.id);assert.ok(actual);assert.equal(actual.net_total,s.net);assert.equal(actual.status,s.status);}
 for(const r of expected.returns){const actual=data.returns.find(a=>a.return_number===r.number);assert.ok(actual);assert.equal(actual.refund_total,r.refund);assert.equal(actual.profit_reversed,r.profitReversed);}
 assert.equal(data.sync_queue.filter(q=>q.status!=='SYNCED').length,0);
 await page.screenshot({path:'qa-results/live-overview.png',fullPage:true});
 await page.getByRole('button',{name:/^Products/}).click();
 for(const p of expected.products)await page.locator('table').getByText(p.name,{exact:true}).waitFor();
 await page.screenshot({path:'qa-results/live-products.png',fullPage:true});
 await page.evaluate(async()=>{await navigator.serviceWorker.ready});
 await page.reload();await context.setOffline(true);await page.reload();
 await page.getByRole('heading',{name:'Aziz & Son Wholesaler',exact:true}).waitFor();
 await page.getByRole('button',{name:/^Products/}).click();
 for(const p of expected.products)await page.locator('table').getByText(p.name,{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: fresh browser downloaded all QA products, both invoices and three returns; exact stock, average costs, balances and profits verified locally; records visible in tables and available after offline reload.');
}finally{await browser.close()}
