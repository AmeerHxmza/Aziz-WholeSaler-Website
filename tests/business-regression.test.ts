import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { tradingTotals } from '../src/lib/reports';
import { offlineDb } from '../src/lib/db/offline-db';
import { createOfflineReturn, createOfflineSale, exportOfflineBackup, recordOfflineStock, saveOfflineProduct } from '../src/lib/db/offline-operations';
import { restoreOfflineBackup } from '../src/lib/db/backup';

test('Returns-only periods retain signed revenue, COGS and profit', () => {
  assert.deepEqual(tradingTotals([], [{ refund: 100, costRestocked: 60 }]), {
    grossSales: 0, grossCogs: 0, refunds: 100, returnedCost: 60, netSales: -100, cogs: -60, profit: -40
  });
  assert.equal(tradingTotals([], [{ refund: 100, costRestocked: 0 }]).profit, -100);
});

test('Whole-number sales, exact partial reversals, multi-item returns and safe backup recovery', async () => {
  const owner = crypto.randomUUID();
  await offlineDb.settings.put({ key: 'owner_id', value: owner });
  const p = await saveOfflineProduct({ name: 'Weighted cost', unit: 'Box', purchaseCost: 1, salePrice: 3, openingStock: 2 });
  await recordOfflineStock({ productId: p.id, quantity: 1, purchaseCost: 2 });
  assert.equal((await offlineDb.products.get(p.id))?.average_cost, 1.333333);
  const q = await saveOfflineProduct({ name: 'Second product', unit: 'Box', purchaseCost: 5, salePrice: 8, openingStock: 2 });
  const sale = await createOfflineSale({ items: [{ productId: p.id, quantity: 3 }, { productId: q.id, quantity: 2 }] });
  const first = await createOfflineReturn({ saleId: sale.sale.id, items: [{ productId: p.id, quantity: 1 }, { productId: q.id, quantity: 1 }] });
  assert.equal(first.items.length, 2);
  assert.equal((await offlineDb.sales.get(sale.sale.id))?.status, 'PARTIALLY_RETURNED');
  await createOfflineReturn({ saleId: sale.sale.id, items: [{ productId: p.id, quantity: 1 }] });
  await createOfflineReturn({ saleId: sale.sale.id, items: [{ productId: p.id, quantity: 1 }, { productId: q.id, quantity: 1 }] });
  assert.equal((await offlineDb.sales.get(sale.sale.id))?.net_total, 0);
  assert.equal((await offlineDb.sales.get(sale.sale.id))?.status, 'FULLY_RETURNED');
  const reversed = (await offlineDb.returns.toArray()).reduce((n, r) => n + r.profit_reversed, 0);
  assert.equal(Math.round(reversed * 100), Math.round(sale.sale.original_profit * 100));
  await assert.rejects(() => createOfflineReturn({ saleId: sale.sale.id, items: [{ productId: p.id, quantity: 1 }] }), /cannot accept/);
  const backup = await exportOfflineBackup();
  await assert.rejects(() => restoreOfflineBackup(backup, crypto.randomUUID()), /another account/);
  await assert.rejects(() => restoreOfflineBackup(backup, owner), /empty local database/);
  const oldDevice = (await offlineDb.settings.get('device_id'))?.value;
  await offlineDb.transaction('rw', offlineDb.tables, async () => { for (const table of offlineDb.tables) await table.clear(); });
  await restoreOfflineBackup(backup, owner);
  assert.equal(await offlineDb.sale_items.count(), 2);
  assert.equal(await offlineDb.return_items.count(), 5);
  assert.equal(await offlineDb.sync_queue.count(), backup.sync_queue.length);
  assert.notEqual((await offlineDb.settings.get('device_id'))?.value, oldDevice);
  assert.deepEqual(await offlineDb.sync_queue.toArray(), backup.sync_queue);
});
