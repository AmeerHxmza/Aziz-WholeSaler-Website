import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { offlineDb } from '../src/lib/db/offline-db';
import {
  saveOfflineProduct,
  recordOfflineStock,
  createOfflineSale,
  createOfflineReturn,
  exportOfflineBackup
} from '../src/lib/db/offline-operations';
import { syncEngine } from '../src/lib/sync/sync-engine';

test('Offline First POS: Complete lifecycle with zero network connectivity', async () => {
  // Clear offline database tables
  await offlineDb.transaction('rw', [
    offlineDb.products,
    offlineDb.sales,
    offlineDb.sale_items,
    offlineDb.returns,
    offlineDb.return_items,
    offlineDb.stock_entries,
    offlineDb.stock_entry_items,
    offlineDb.inventory_movements,
    offlineDb.sync_queue,
    offlineDb.settings
  ], async () => {
    await offlineDb.products.clear();
    await offlineDb.sales.clear();
    await offlineDb.sale_items.clear();
    await offlineDb.returns.clear();
    await offlineDb.return_items.clear();
    await offlineDb.stock_entries.clear();
    await offlineDb.stock_entry_items.clear();
    await offlineDb.inventory_movements.clear();
    await offlineDb.sync_queue.clear();
    await offlineDb.settings.clear();
  });

  // 1. Create a product offline with opening stock of 100 @ Rs 80
  const product = await saveOfflineProduct({
    name: 'Iranian Sweet Pistachio Box',
    unit: 'Boxes',
    purchaseCost: 80,
    salePrice: 100,
    minimumStock: 10,
    openingStock: 100
  });

  assert.ok(product.id, 'Product should have locally generated UUID/ULID');
  assert.equal(product.current_stock, 100, 'Initial stock should be 100');
  assert.equal(product.purchase_cost, 80, 'Initial cost should be 80');

  // Verify sync queue received product creation
  const productQueue = await offlineDb.sync_queue.where('entity_id').equals(product.id).first();
  assert.ok(productQueue, 'Product creation should be queued for sync');
  assert.equal(productQueue.operation_type, 'CREATE_PRODUCT');
  assert.equal(productQueue.status, 'PENDING');

  // 2. Add stock offline: 50 boxes at Rs 110 cost
  // Weighted average: (100 * 80 + 50 * 110) / 150 = (8000 + 5500) / 150 = 13500 / 150 = 90
  const stockEntry = await recordOfflineStock({
    productId: product.id,
    quantity: 50,
    purchaseCost: 110,
    notes: 'Direct warehouse truck'
  });

  assert.ok(stockEntry.entry_number.startsWith('SE-'), 'Stock entry should have offline receipt number');
  const updatedProductAfterStock = await offlineDb.products.get(product.id);
  assert.ok(updatedProductAfterStock);
  assert.equal(updatedProductAfterStock.current_stock, 150, 'Stock should increase to 150');
  assert.equal(updatedProductAfterStock.average_cost, 90, 'Weighted average cost should be Rs 90');

  // 3. Make a sale offline: Sell 50 boxes at Rs 100
  // Revenue: 50 * 100 = 5000. Cost: 50 * 90 = 4500. Profit: 500. Remaining stock: 100.
  const { sale, items: saleItems } = await createOfflineSale({
    customerName: 'Bismillah General Store',
    notes: 'Full payment cash',
    items: [
      {
        productId: product.id,
        quantity: 50,
        unitPrice: 100
      }
    ]
  });

  assert.ok(sale.invoice_number.startsWith('AS-'), 'Sale invoice number should be AS-000001 pattern');
  assert.equal(sale.subtotal, 5000, 'Sale subtotal should be 5000');
  assert.equal(sale.net_total, 5000, 'Sale net total should be 5000');
  assert.equal(sale.original_profit, 500, 'Sale profit should be 500');
  assert.equal(saleItems.length, 1);
  assert.equal(saleItems[0].unit_cost_snapshot, 90, 'Unit cost snapshot must freeze at Rs 90');

  const updatedProductAfterSale = await offlineDb.products.get(product.id);
  assert.ok(updatedProductAfterSale);
  assert.equal(updatedProductAfterSale.current_stock, 100, 'Stock should decrease to 100');

  // Verify sale sync queue operation
  const saleQueue = await offlineDb.sync_queue.where('entity_id').equals(sale.id).first();
  assert.ok(saleQueue, 'Sale should be queued for sync');
  assert.equal(saleQueue.operation_type, 'CREATE_SALE');
  assert.equal(saleQueue.status, 'PENDING');
  assert.ok(saleQueue.operation_id, 'Sale must have an idempotency key');

  // 4. Customer returns 20 boxes offline
  // Refund amount: 20 * 100 = 2000. Cost reversal: 20 * 90 = 1800. Net stock becomes 120.
  const { returnRow } = await createOfflineReturn({
    saleId: sale.id,
    reason: 'Customer ordered extra',
    items: [
      {
        productId: product.id,
        quantity: 20
      }
    ]
  });

  assert.ok(returnRow.return_number.startsWith('RT-'), 'Return number should be RT-000001 pattern');
  assert.equal(returnRow.refund_total, 2000, 'Refund total should be 2000');
  assert.equal(returnRow.profit_reversed, 200, 'Profit reversed should be (100 - 90) * 20 = 200');

  const updatedProductAfterReturn = await offlineDb.products.get(product.id);
  assert.ok(updatedProductAfterReturn);
  assert.equal(updatedProductAfterReturn.current_stock, 120, 'Stock should restore to 120');

  // 5. Verify local inventory movements ledger
  const movements = await offlineDb.inventory_movements.where('product_id').equals(product.id).toArray();
  // 1: initial stock (100), 2: stock entry (+50), 3: sale (-50), 4: return (+20)
  assert.equal(movements.length, 4, 'Four inventory movements must be recorded in local ledger');

  // 6. Verify Backup Export
  const backup = await exportOfflineBackup();
  assert.equal(backup.version, 1, 'Backup format version should be 1');
  assert.equal(backup.products.length, 1, 'Backup should export 1 product');
  assert.equal(backup.sales.length, 1, 'Backup should export 1 sale');
  assert.equal(backup.returns.length, 1, 'Backup should export 1 return');
  assert.equal(backup.sync_queue.length, 4, 'Backup should preserve 4 pending sync queue operations');
});

test('Offline Database Reset: clearLocalDatabase empties all stores immediately', async () => {
  // Ensure data exists first
  await saveOfflineProduct({
    name: 'Test Reset Item',
    unit: 'Kg',
    purchaseCost: 50,
    salePrice: 75,
    minimumStock: 5,
    openingStock: 10
  });

  const productsBefore = await offlineDb.products.count();
  assert.ok(productsBefore > 0, 'Database should contain products before reset');

  // Perform full clear
  await syncEngine.clearLocalDatabase();

  const [productsAfter, salesAfter, returnsAfter, queueAfter] = await Promise.all([
    offlineDb.products.count(),
    offlineDb.sales.count(),
    offlineDb.returns.count(),
    offlineDb.sync_queue.count()
  ]);

  assert.equal(productsAfter, 0, 'Products should be empty after clearLocalDatabase');
  assert.equal(salesAfter, 0, 'Sales should be empty after clearLocalDatabase');
  assert.equal(returnsAfter, 0, 'Returns should be empty after clearLocalDatabase');
  assert.equal(queueAfter, 0, 'Sync queue should be empty after clearLocalDatabase');
});

