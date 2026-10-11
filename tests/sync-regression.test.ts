import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { offlineDb } from '../src/lib/db/offline-db';
import { createOfflineSale, createOfflineReturn, recordOfflineStock, saveOfflineProduct } from '../src/lib/db/offline-operations';
import { applyCloudSnapshot, type CloudSnapshot, SyncEngine, syncEngine } from '../src/lib/sync/sync-engine';
import { recordLocalAction } from '../src/lib/db/offline-ledger';

test('Real PostgreSQL migrations, replay-safe sync, complete snapshot and integer lifecycle', async () => {
  const pg = new PGlite();
  try {
    const owner = crypto.randomUUID();
    await pg.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select '${owner}'::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{"email":"aziz@gmail.com"}'::jsonb $$;
      insert into auth.users values('${owner}');`);
    for (const name of ['001_initial_schema','002_wholesale_core','003_fix_reset_shop_data','004_durable_offline_sync']) {
      const sql = (await readFile(`supabase/migrations/${name}.sql`, 'utf8')).replace(/create extension if not exists pgcrypto;/gi, '');
      await pg.exec(sql);
    }
    await pg.query('select public.claim_shop_admin()');
    const p = await saveOfflineProduct({ name: 'Integer stock', unit: 'Box', purchaseCost: 100, salePrice: 250, openingStock: 10 });
    await assert.rejects(() => saveOfflineProduct({ name: 'Integer stock', unit: 'Box', purchaseCost: 100, salePrice: 250, openingStock: 5 }), /already exists/);
    await assert.rejects(() => createOfflineSale({ items: [{ productId: p.id, quantity: 0.5 }] }), /whole number/);
    const sale = await createOfflineSale({ items: [{ productId: p.id, quantity: 10 }] });
    await recordOfflineStock({ productId: p.id, quantity: 10, purchaseCost: 200 });
    const returned = await createOfflineReturn({ saleId: sale.sale.id, items: [{ productId: p.id, quantity: 10 }], date: sale.sale.sale_date });
    assert.equal((await offlineDb.products.get(p.id))?.average_cost, 150);
    assert.equal((await offlineDb.products.get(p.id))?.current_stock, 20);
    assert.equal((await offlineDb.sales.get(sale.sale.id))?.net_total, 0);
    await recordLocalAction('CREATE_LOAN', { person: 'Customer', type: 'GIVEN', amount: 200, date: sale.sale.sale_date });
    const loanOp = await offlineDb.sync_queue.where('operation_type').equals('CREATE_LOAN').first();
    await recordLocalAction('SETTLE_LOAN', { loanId: loanOp!.entity_id, amount: 50, date: sale.sale.sale_date });
    await recordLocalAction('SAVE_SETTINGS', { business_name: 'Audit shop', address: 'Test', phone1: '', phone2: '', receipt_footer: 'Thanks' });
    const queue = (await offlineDb.sync_queue.toArray()).sort((a,b) => a.sequence! - b.sequence!);
    await assert.rejects(() => syncEngine.clearLocalDatabase(), /unsynchronized/);
    for (const operation of queue) {
      const args = [operation.operation_id, operation.operation_type, JSON.stringify(operation.payload)];
      const first = await pg.query('select public.sync_shop_operation($1,$2,$3) as result', args);
      const second = await pg.query('select public.sync_shop_operation($1,$2,$3) as result', args);
      assert.deepEqual(first.rows, second.rows, 'retry must return the same result');
      await offlineDb.sync_queue.update(operation.id, { status: 'SYNCED' });
    }
    const snapshot = async () => (await pg.query<{ value: CloudSnapshot }>('select public.shop_snapshot() as value')).rows[0].value;
    const cloud = await snapshot();
    assert.equal((cloud.sales as { id: string }[])[0].id, sale.sale.id);
    assert.equal((cloud.returns as { id: string }[])[0].id, returned.returnRow.id);
    assert.equal((cloud.sales as { invoice_number: string }[])[0].invoice_number, sale.sale.invoice_number);
    assert.equal((cloud.products as { current_stock: number }[])[0].current_stock, 20);
    assert.equal((cloud.products as { average_cost: number }[])[0].average_cost, 150);
    assert.equal(await applyCloudSnapshot(cloud, owner), true);
    assert.equal((await offlineDb.return_items.toArray())[0].unit_sale_price_snapshot, 250);
    assert.equal((await offlineDb.return_items.toArray())[0].sale_item_id, sale.items[0].id);
    // A new sale during a download must keep its local stock and identity.
    const duringDownload = await createOfflineSale({ items: [{ productId: p.id, quantity: 1 }] });
    assert.equal(await applyCloudSnapshot(cloud, owner), false);
    assert.equal((await offlineDb.products.get(p.id))?.current_stock, 19);
    assert.ok(await offlineDb.sales.get(duringDownload.sale.id));
    // Failed and interrupted entries remain visible to the operator.
    const last = await offlineDb.sync_queue.where('entity_id').equals(duringDownload.sale.id).first();
    await offlineDb.sync_queue.update(last!.id, { status: 'FAILED' });
    assert.equal(await syncEngine.updatePendingCount(), 1);
    await offlineDb.sync_queue.update(last!.id, { status: 'SYNCING' });
    assert.equal(await syncEngine.updatePendingCount(), 1);
    // Validate fractional input in SQL before NUMERIC precision could round it.
    await assert.rejects(() => pg.query('select public.sync_shop_operation($1,$2,$3)', [crypto.randomUUID(), 'CREATE_SALE', JSON.stringify({ protocol: 2, id: crypto.randomUUID(), invoice_number: 'INVALID', sale_date: sale.sale.sale_date, items: [{ productId: p.id, quantity: 1.0001, unitPrice: 250 }] })]), /whole number/);
    // Multi-item and damaged returns retain each item and do not restock damage.
    const damaged = await createOfflineReturn({ saleId: duringDownload.sale.id, items: [{ productId: p.id, quantity: 1, restock: false }] });
    assert.equal((await offlineDb.products.get(p.id))?.current_stock, 19);
    assert.equal(damaged.returnRow.profit_reversed, 250);
    // Simulate a response lost AFTER PostgreSQL commits, then retry twice concurrently.
    let loseResponse = true;
    let uploads = 0;
    let rejectReset = false;
    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: owner } } }, error: null }) },
      rpc: async (name: string, args?: Record<string, unknown>) => {
        if (name === 'is_shop_admin') return { data: true, error: null };
        if (name === 'shop_snapshot') return { data: await snapshot(), error: null };
        if (name === 'reset_shop_data') {
          if (rejectReset) return { data: null, error: new Error('Simulated server reset failure') };
          const result = await pg.query('select public.reset_shop_data($1) as result', [args!.p_confirmation]);
          return { data: result.rows[0], error: null };
        }
        uploads++;
        const value = await pg.query('select public.sync_shop_operation($1,$2,$3) as result', [args!.p_operation_id, args!.p_type, JSON.stringify(args!.p_payload)]);
        if (loseResponse) { loseResponse = false; return { data: null, error: { message: 'Network response lost after commit' } }; }
        return { data: value.rows[0], error: null };
      }
    } as unknown as SupabaseClient;
    const engine = new SyncEngine(() => client);
    await engine.sync();
    assert.match(engine.getState().lastError || '', /Network/);
    assert.equal(engine.getState().pendingCount, 2);
    await Promise.all([engine.sync(), engine.sync(), engine.sync()]);
    assert.equal(engine.getState().lastError, null);
    assert.equal(engine.getState().pendingCount, 0);
    assert.equal(uploads, 3, 'one lost response plus one retry plus the dependent return');
    assert.equal((await snapshot()).sales && (await offlineDb.sales.count()), 2);
    assert.equal((await offlineDb.products.get(p.id))?.current_stock, 19);
    // Snapshots are not limited to the latest 300 sales or 100 returns.
    await pg.query(`insert into public.sales(owner_id,invoice_number,sale_date,subtotal,total,net_total,status)
      select $1,'ARCHIVE-'||i,current_date,0,0,0,'COMPLETED' from generate_series(1,305) i`, [owner]);
    await engine.sync();
    assert.equal(await offlineDb.sales.count(), 307);
    assert.ok(await offlineDb.sales.get(sale.sale.id), 'original invoice remains available');
    // A failed cloud reset must never erase the laptop's records.
    rejectReset = true;
    await assert.rejects(() => engine.resetShop('RESET AZIZ SHOP', () => {}), /Simulated server reset failure/);
    assert.equal(await offlineDb.sales.count(), 307);
    assert.equal((await snapshot()).sales instanceof Array && ((await snapshot()).sales as unknown[]).length, 307);
    assert.equal(await offlineDb.settings.get('maintenance'), undefined);
    rejectReset = false;
    let backupSaved = false;
    await engine.resetShop('RESET AZIZ SHOP', backup => {
      assert.ok((backup as { cloud: CloudSnapshot }).cloud);
      backupSaved = true;
    });
    assert.equal(backupSaved, true);
    for (const table of offlineDb.tables) assert.equal(await table.count(), 0, `${table.name} must reset locally`);
    const afterReset = await snapshot();
    for (const table of ['products','sales','sale_items','returns','return_items','stock_entries','stock_entry_items','inventory_movements','loans','loan_settlements','business_settings','stock_movements','stock_adjustments']) {
      assert.deepEqual(afterReset[table], [], `${table} must reset online`);
    }
    await engine.sync();
    assert.equal(await offlineDb.products.count(), 0, 'sync must not resurrect reset products');
    assert.equal(await offlineDb.sales.count(), 0, 'sync must not resurrect reset sales');
  } finally { await pg.close(); }
});
