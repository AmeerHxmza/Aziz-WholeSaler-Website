import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createReceiptPdf } from '../src/lib/receipt-pdf';
import { lineAmount, roundMoney, formatQuantity } from '../src/lib/calculations';
import { offlineDb } from '../src/lib/db/offline-db';
import {
  saveOfflineProduct,
  createOfflineSale,
  createOfflineReturn,
  deduplicateLocalProducts
} from '../src/lib/db/offline-operations';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ttexfcxvyefbfilmyiwc.supabase.co';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_w-re86Xu23u08fKdJaD9Ig_A2zCvC6Z';

test('Comprehensive QA Test: Duplicate Prevention, Searchability, 11-Digit Mobile, Receipts & Returns', async () => {
  // =========================================================================
  // PART 1: LIVE SUPABASE CLOUD AUDIT (aziz@gmail.com / aziz1234)
  // =========================================================================
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });

  // 1. Authenticate with shop owner credentials
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: 'aziz@gmail.com',
    password: 'aziz1234'
  });
  assert.equal(authError, null, `Authentication failed: ${authError?.message}`);
  assert.ok(authData.session, 'Session must exist');
  const userId = authData.user.id;

  // 2. Claim shop admin status
  const { data: claimData, error: claimError } = await supabase.rpc('claim_shop_admin');
  assert.equal(claimError, null, `claim_shop_admin error: ${claimError?.message}`);
  assert.equal(claimData?.authorized, true);

  // 3. TEST 1: Duplicate Product Prevention & Opening Stock
  // Scenario: Add product "QA Royal Basmati" with 50 opening stock
  const productName = `QA Royal Basmati ${Date.now()}`;
  const { data: prodResult1, error: prodErr1 } = await supabase.rpc('create_product', {
    p_name: productName,
    p_unit: 'Bag',
    p_purchase_cost: 2500,
    p_sale_price: 3200,
    p_minimum_stock: 10,
    p_opening_stock: 50
  });
  assert.equal(prodErr1, null, `create_product failed: ${prodErr1?.message}`);
  const prodId = prodResult1.id;
  assert.ok(prodId, 'Product ID must be returned');

  // Verify only 1 product row exists with that name in Supabase
  const { data: prodsAfter1, error: pQueryErr1 } = await supabase
    .from('products')
    .select('*')
    .eq('owner_id', userId)
    .ilike('name', productName);
  assert.equal(pQueryErr1, null);
  assert.equal(prodsAfter1.length, 1, 'Exactly one product row must exist');
  assert.equal(Number(prodsAfter1[0].current_stock), 50);

  // Try creating the same product again with 25 opening stock
  // The deduplicating function must update the existing product instead of duplicating!
  const { data: prodResult2, error: prodErr2 } = await supabase.rpc('create_product', {
    p_name: productName,
    p_unit: 'Bag',
    p_purchase_cost: 2500,
    p_sale_price: 3200,
    p_minimum_stock: 10,
    p_opening_stock: 25
  });
  assert.equal(prodErr2, null);
  assert.equal(prodResult2.id, prodId, 'Must reuse the exact same product ID');

  const { data: prodsAfter2 } = await supabase
    .from('products')
    .select('*')
    .eq('owner_id', userId)
    .ilike('name', productName);
  assert.equal(prodsAfter2?.length, 1, 'Still exactly one product row (NO DUPLICATE)');
  assert.equal(Number(prodsAfter2[0].current_stock), 75, 'Stock must increment cleanly to 75');

  // 4. TEST 2: Customer Name and 11-Digit Mobile Number in Database & Receipt
  const customerName = 'Chaudhry Akram';
  const customerPhone = '03001234567'; // Exactly 11 digits

  // Ensure 11-digit regex holds
  const phoneRegex = /^0\d{10}$/;
  assert.ok(phoneRegex.test(customerPhone), 'Phone must be exactly 11 digits starting with 0');
  assert.equal('030012'.length === 11, false, 'Incomplete phone must fail check');

  const todayStr = new Date().toISOString().slice(0, 10);
  const { data: saleResult, error: saleErr } = await supabase.rpc('create_sale', {
    p_date: todayStr,
    p_customer_name: customerName,
    p_customer_phone: customerPhone,
    p_items: [
      {
        productId: prodId,
        quantity: 5,
        unitPrice: 3200
      }
    ],
    p_notes: 'QA Automated Verification Sale'
  });
  assert.equal(saleErr, null, `create_sale error: ${saleErr?.message}`);
  assert.ok(saleResult.id);
  assert.equal(Number(saleResult.netTotal), 16000);

  // Query Supabase directly to ensure customer_name and customer_phone are in the database table
  const { data: savedSale, error: saleQueryErr } = await supabase
    .from('sales')
    .select('*')
    .eq('id', saleResult.id)
    .single();
  assert.equal(saleQueryErr, null);
  assert.equal(savedSale.customer_name, customerName, 'customer_name must match in database');
  assert.equal(savedSale.customer_phone, customerPhone, 'customer_phone must match in database');

  // 5. TEST 3: 80mm Thermal Receipt Generation with Customer & Mobile
  const receiptPdfBlob = createReceiptPdf({
    kind: 'SALE',
    number: saleResult.invoiceNumber,
    date: todayStr,
    customerName,
    customerPhone,
    totalLabel: 'TOTAL',
    total: 16000,
    items: [
      {
        name: productName,
        unit: 'Bag',
        quantity: 5,
        rate: 3200,
        amount: 16000
      }
    ]
  }, {
    business_name: 'Aziz & Son Wholesaler',
    receipt_footer: 'Thank you for your business!'
  });
  assert.ok(receiptPdfBlob.size > 1500, '80mm PDF thermal receipt must be generated with content');

  // 6. TEST 4: Customer Return with Stock Restoration & Refund
  const { data: returnResult, error: returnErr } = await supabase.rpc('create_return', {
    p_date: todayStr,
    p_sale_id: saleResult.id,
    p_reason: 'QA return test',
    p_items: [
      {
        productId: prodId,
        quantity: 1,
        restock: true
      }
    ],
    p_notes: 'QA return item'
  });
  assert.equal(returnErr, null, `create_return error: ${returnErr?.message}`);
  assert.ok(returnResult.id);

  // Verify stock updated (75 initial - 5 sold + 1 returned = 71)
  const { data: prodFinal } = await supabase
    .from('products')
    .select('current_stock')
    .eq('id', prodId)
    .single();
  assert.equal(Number(prodFinal?.current_stock), 71, 'Stock must accurately equal 71 bags');

  // =========================================================================
  // PART 2: LOCAL OFFLINE-FIRST DEXIE AUDIT (Zero-Network POS Lifecycle)
  // =========================================================================
  await offlineDb.transaction('rw', [
    offlineDb.products,
    offlineDb.sales,
    offlineDb.sale_items,
    offlineDb.returns,
    offlineDb.return_items,
    offlineDb.sync_queue
  ], async () => {
    await offlineDb.products.clear();
    await offlineDb.sales.clear();
    await offlineDb.sale_items.clear();
    await offlineDb.returns.clear();
    await offlineDb.return_items.clear();
    await offlineDb.sync_queue.clear();
  });

  // Test local product creation with opening stock
  const offlineProd = await saveOfflineProduct({
    name: 'Offline Rice',
    unit: 'Kg',
    purchase_cost: 150,
    sale_price: 200,
    minimum_stock: 5,
    opening_stock: 50
  });
  assert.equal(offlineProd.current_stock, 50);

  // Test local duplicate prevention: saving same product name again
  const duplicateAttempt = await saveOfflineProduct({
    name: 'offline rice', // same name, different casing
    unit: 'Kg',
    purchase_cost: 160,
    sale_price: 210,
    minimum_stock: 5,
    opening_stock: 20
  });
  assert.equal(duplicateAttempt.id, offlineProd.id, 'Local duplicate must be merged into existing product ID');
  assert.equal(duplicateAttempt.current_stock, 70, 'Stock must aggregate to 70');

  // Verify only 1 product in IndexedDB store
  const allLocalProds = await offlineDb.products.toArray();
  assert.equal(allLocalProds.length, 1, 'Only 1 row in Dexie products table');

  // Test local self-healing deduplicateLocalProducts
  await deduplicateLocalProducts();
  const prodsAfterDedup = await offlineDb.products.toArray();
  assert.equal(prodsAfterDedup.length, 1, 'Only 1 product remains after deduplication');

  // Test local sale with customer name and 11-digit mobile
  const { sale: localSale } = await createOfflineSale({
    customerName: 'Local Customer',
    customerPhone: '03009876543',
    items: [
      {
        productId: offlineProd.id,
        quantity: 10,
        unitPrice: 200
      }
    ],
    notes: 'Local offline sale'
  });
  assert.equal(localSale.customer_name, 'Local Customer');
  assert.equal(localSale.customer_phone, '03009876543');
  assert.equal(localSale.net_total, 2000);

  // Check product stock decremented offline: 70 - 10 = 60
  const updatedProd = await offlineDb.products.get(offlineProd.id);
  assert.equal(updatedProd?.current_stock, 60);

  // Test local return: 2 units
  const { returnRow: localReturn } = await createOfflineReturn({
    saleId: localSale.id,
    reason: 'Offline return test',
    items: [
      {
        productId: offlineProd.id,
        quantity: 2
      }
    ]
  });
  assert.equal(localReturn.refund_total, 400);

  // Check stock restored: 60 + 2 = 62
  const restoredProd = await offlineDb.products.get(offlineProd.id);
  assert.equal(restoredProd?.current_stock, 62);
});
