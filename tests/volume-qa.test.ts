import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { offlineDb } from '../src/lib/db/offline-db';
import { saveOfflineProduct, recordOfflineStock, createOfflineSale, createOfflineReturn } from '../src/lib/db/offline-operations';
import { recordLocalAction } from '../src/lib/db/offline-ledger';
import { applyCloudSnapshot, type CloudSnapshot } from '../src/lib/sync/sync-engine';
import { tradingTotals } from '../src/lib/reports';

// Independent integer arithmetic oracle: micro-rupee costs and paisa totals.
const divide = (n: bigint, d: bigint) => (n + d / 2n) / d;
const money = (qty: number, micro: bigint) => divide(BigInt(qty) * micro, 10000n);
const rupees = (paisa: bigint) => Number(paisa) / 100;
type Product = { id: string; stock: number; cost: bigint; price: number };
type Bill = { id: string; lines: { product: Product; qty: number; price: number; cost: bigint; cogs: bigint }[]; total: bigint; profit: bigint; refund: bigint };

test('Volume QA: 120 products, 600 invoices, 240 returns, exact accounting and PostgreSQL synchronization', { timeout: 180000 }, async () => {
 const started = Date.now();
 const pg = new PGlite();
 const owner = crypto.randomUUID();
 const products: Product[] = [];
 const bills: Bill[] = [];
 let gross = 0n, cogs = 0n, refunds = 0n, recovered = 0n;
 try {
  await pg.exec(`create role anon; create role authenticated; create schema auth;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select '${owner}'::uuid $$;
   create function auth.jwt() returns jsonb language sql stable as $$ select '{"email":"aziz@gmail.com"}'::jsonb $$;
   insert into auth.users values('${owner}');`);
  for (const name of ['001_initial_schema','002_wholesale_core','003_fix_reset_shop_data','004_durable_offline_sync']) {
   await pg.exec((await readFile(`supabase/migrations/${name}.sql`, 'utf8')).replace(/create extension if not exists pgcrypto;/gi,''));
  }
  await pg.query('select public.claim_shop_admin()');
  for(let i=0;i<120;i++) {
   const cost=17+i*3, qty=80+i%11, price=cost+20;
   const p=await saveOfflineProduct({name:`QA product ${i+1}`,unit:['Box','Crate','Packet'][i%3],purchaseCost:cost,salePrice:price,openingStock:qty});
   products.push({id:p.id,stock:qty,cost:BigInt(cost)*1000000n,price});
  }
  const buy=async(p:Product,qty:number,price:number)=>{
   await recordOfflineStock({productId:p.id,quantity:qty,purchaseCost:price});
   p.cost=divide(BigInt(p.stock)*p.cost+BigInt(qty*price)*1000000n,BigInt(p.stock+qty));p.stock+=qty;
  };
  for(let i=0;i<120;i++)await buy(products[i],13+i%7,21+i*3);
  for(let n=0;n<600;n++) {
   const lines=[0,17,43].map((offset,j)=>{
    const product=products[(n+offset)%120],qty=2+(n+j)%4;
    const price=n%37===0?0:n%29===0?1:product.price+n%5;
    return {product,qty,price,cost:product.cost,cogs:money(qty,product.cost)};
   });
   const total=lines.reduce((v,l)=>v+BigInt(l.qty*l.price)*100n,0n);
   const cost=lines.reduce((v,l)=>v+l.cogs,0n);
   const result=await createOfflineSale({items:lines.map(l=>({productId:l.product.id,quantity:l.qty,unitPrice:l.price})),customerName:`QA customer ${n%50}`});
   assert.equal(result.sale.total,rupees(total));assert.equal(result.sale.original_profit,rupees(total-cost));
   for(const l of lines)l.product.stock-=l.qty;
   bills.push({id:result.sale.id,lines,total,profit:total-cost,refund:0n});gross+=total;cogs+=cost;
  }
  // Change today's average before returning yesterday's original-cost stock.
  for(let i=0;i<120;i++)await buy(products[i],7+i%5,35+i*3);
  for(let n=0;n<120;n++) {
   const bill=bills[n];
   for(let part=0;part<2;part++) {
    let expectedRefund=0n,expectedRecovered=0n;
    const items=bill.lines.map((l,j)=>{
     const qty=part===0?1:l.qty-1,restock=(n+j+part)%4!==0;
     const refund=BigInt(qty*l.price)*100n;
     const cost=part===0?money(1,l.cost):l.cogs-money(1,l.cost);
     expectedRefund+=refund;
     if(restock){expectedRecovered+=cost;l.product.cost=divide(BigInt(l.product.stock)*l.product.cost+BigInt(qty)*l.cost,BigInt(l.product.stock+qty));l.product.stock+=qty;}
     return {productId:l.product.id,quantity:qty,restock};
    });
    const result=await createOfflineReturn({saleId:bill.id,items});
    assert.equal(result.returnRow.refund_total,rupees(expectedRefund));
    assert.equal(result.returnRow.profit_reversed,rupees(expectedRefund-expectedRecovered));
    bill.refund+=expectedRefund;refunds+=expectedRefund;recovered+=expectedRecovered;
   }
   assert.equal((await offlineDb.sales.get(bill.id))?.status,'FULLY_RETURNED');
  }
  // Reconciliation and ledger transactions use the same durable queue.
  for(let i=0;i<12;i++){
   const p=products[i],count=p.stock+(i%2===0?3:-2);
   await recordLocalAction('ADJUST_STOCK',{productId:p.id,type:'PHYSICAL',physicalCount:count,reason:'QA count',date:'2026-10-12'});p.stock=count;
  }
  for(let i=0;i<20;i++){
   await recordLocalAction('CREATE_LOAN',{person:`QA person ${i}`,type:i%2?'TAKEN':'GIVEN',amount:1000+i*100,date:'2026-10-12'});
   const op=(await offlineDb.sync_queue.toArray()).filter(q=>q.operation_type==='CREATE_LOAN').sort((a,b)=>b.sequence!-a.sequence!)[0];
   await recordLocalAction('SETTLE_LOAN',{loanId:op.entity_id,amount:500,date:'2026-10-12'});
  }
  const queueBefore=await offlineDb.sync_queue.count();
  await assert.rejects(()=>createOfflineSale({items:[{productId:products[0].id,quantity:999999}]}),/Insufficient/);
  await assert.rejects(()=>createOfflineSale({items:[{productId:products[0].id,quantity:1},{productId:products[1].id,quantity:999999}]}),/Insufficient/);
  await assert.rejects(()=>createOfflineReturn({saleId:bills[0].id,items:[{productId:products[0].id,quantity:1}]}),/cannot accept/);
  assert.equal(await offlineDb.sync_queue.count(),queueBefore,'rejected transactions must not enqueue');
  const verifyLocal=async()=>{
   for(const p of products){const actual=await offlineDb.products.get(p.id);assert.equal(actual?.current_stock,p.stock);assert.equal(actual?.average_cost,Number(p.cost)/1e6);}
   for(const b of bills){const actual=await offlineDb.sales.get(b.id);assert.equal(actual?.total,rupees(b.total));assert.equal(actual?.original_profit,rupees(b.profit));assert.equal(actual?.net_total,rupees(b.total-b.refund));}
  };
  await verifyLocal();
  const expected={grossSales:rupees(gross),grossCogs:rupees(cogs),refunds:rupees(refunds),returnedCost:rupees(recovered),netSales:rupees(gross-refunds),cogs:rupees(cogs-recovered),profit:rupees(gross-refunds-cogs+recovered)};
  const report=async()=>tradingTotals((await offlineDb.sales.toArray()).map(s=>({total:s.total,cost:s.total-s.original_profit})),(await offlineDb.returns.toArray()).map(r=>({refund:r.refund_total,costRestocked:r.refund_total-r.profit_reversed})));
  assert.deepEqual(await report(),expected);
  const beforeSales = await offlineDb.sale_items.toArray();
  const beforeReturns = await offlineDb.return_items.toArray();
  const beforeReturnHeaders = await offlineDb.returns.toArray();
  const queue=(await offlineDb.sync_queue.toArray()).sort((a,b)=>a.sequence!-b.sequence!);
  let replays=0;
  for(let i=0;i<queue.length;i++){
   const op=queue[i],args=[op.operation_id,op.operation_type,JSON.stringify(op.payload)];
   const first=await pg.query('select public.sync_shop_operation($1,$2,$3) as result',args);
   if(i%10===0){assert.deepEqual((await pg.query('select public.sync_shop_operation($1,$2,$3) as result',args)).rows,first.rows);replays++;}
   await offlineDb.sync_queue.update(op.id,{status:'SYNCED'});
  }
  const cloud=(await pg.query<{ value: CloudSnapshot }>('select public.shop_snapshot() as value')).rows[0].value;
  assert.equal((cloud.products as unknown[]).length,120);assert.equal((cloud.sales as unknown[]).length,600);assert.equal((cloud.returns as unknown[]).length,240);
  for(const p of products){const row=(await pg.query<{current_stock:number;average_cost:number}>('select current_stock,average_cost from products where id=$1',[p.id])).rows[0];assert.equal(Number(row.current_stock),p.stock);assert.equal(Number(row.average_cost),Number(p.cost)/1e6);}
  await applyCloudSnapshot(cloud,owner);await verifyLocal();assert.deepEqual(await report(),expected);
  for(const line of beforeSales) {
   const actual=await offlineDb.sale_items.get(line.id);
   assert.deepEqual(actual,line,'every sale line must retain its identity and financial snapshots');
  }
  for(const line of beforeReturns) assert.deepEqual(await offlineDb.return_items.get(line.id),line,'every return line must retain original cost, refund and damaged flag');
  for(const header of beforeReturnHeaders) {
   const actual=await offlineDb.returns.get(header.id);
   assert.equal(actual?.refund_total,header.refund_total);assert.equal(actual?.profit_reversed,header.profit_reversed);
  }
  const loans=cloud.loans as {amount:number;paid_amount:number;remaining_amount:number}[];
  assert.equal(loans.length,20);for(const l of loans){assert.equal(l.paid_amount,500);assert.equal(l.remaining_amount,l.amount-500);}
  const result={products:120,purchases:240,invoices:600,saleLines:1800,returns:240,returnLines:720,physicalCounts:12,loans:20,repayments:20,queuedOperations:queue.length,replayedOperations:replays,finalStock:products.reduce((n,p)=>n+p.stock,0),expected,actual:await report(),elapsedSeconds:(Date.now()-started)/1000};
  await mkdir('qa-results',{recursive:true});await writeFile('qa-results/volume-results.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
 } finally {await pg.close();}
});
