import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ttexfcxvyefbfilmyiwc.supabase.co';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_w-re86Xu23u08fKdJaD9Ig_A2zCvC6Z';

test('Comprehensive Business Verification: TEST A through TEST G', async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });

  // Auth setup
  const password = process.env.ADMIN_PASSWORD || 'aziz1234';
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: 'aziz@gmail.com',
    password
  });
  assert.equal(authError, null, `Auth failed: ${authError?.message}`);
  assert.ok(authData.session, 'User session missing');

  await supabase.rpc('claim_shop_admin');

  const today = new Date().toISOString().slice(0, 10);
  const ts = Date.now();

  // -------------------------------------------------------------
  // TEST A: Normal Sale
  // Add: 100 units cost Rs 80.
  // Sell: 50 units selling price Rs 100.
  // Expected: Stock = 50, Gross Sale = Rs 5000, Net Sale = Rs 5000, Profit = Rs 1000
  // -------------------------------------------------------------
  const prodA = await supabase.rpc('create_product', {
    p_name: `Test A Product ${ts}`,
    p_unit: 'Piece',
    p_purchase_cost: 80,
    p_sale_price: 100,
    p_minimum_stock: 5,
    p_opening_stock: 0
  });
  assert.equal(prodA.error, null);
  const prodAId = prodA.data.id;

  // Add stock: 100 @ Rs 80
  const stockA = await supabase.rpc('add_stock', {
    p_items: [{ productId: prodAId, quantity: 100, unitCost: 80 }],
    p_entry_date: today,
    p_supplier: 'Vendor A'
  });
  assert.equal(stockA.error, null);

  // Check product stock after add
  const { data: prodACheck1 } = await supabase.from('products').select('*').eq('id', prodAId).single();
  assert.equal(Number(prodACheck1.current_stock), 100);
  assert.equal(Number(prodACheck1.average_cost), 80);

  // Sell 50 @ Rs 100
  const saleA = await supabase.rpc('create_sale', {
    p_date: today,
    p_items: [{ productId: prodAId, quantity: 50, unitPrice: 100 }]
  });
  assert.equal(saleA.error, null);
  assert.equal(Number(saleA.data.total), 5000);
  assert.equal(Number(saleA.data.originalProfit), 1000); // 50 * (100 - 80) = 1000

  const { data: prodACheck2 } = await supabase.from('products').select('*').eq('id', prodAId).single();
  assert.equal(Number(prodACheck2.current_stock), 50); // Stock = 50

  // -------------------------------------------------------------
  // TEST B: Partial Return
  // Return 20 from the above sale.
  // Expected: Stock = 70, Original Sold = 50, Returned = 20, Net Sold = 30,
  // Gross Sale = Rs 5000, Return = Rs 2000, Net Sale = Rs 3000, Profit = Rs 600
  // -------------------------------------------------------------
  const returnB = await supabase.rpc('create_return', {
    p_sale_id: saleA.data.id,
    p_date: today,
    p_items: [{ productId: prodAId, quantity: 20 }],
    p_reason: 'Test B partial return'
  });
  assert.equal(returnB.error, null);
  assert.equal(Number(returnB.data.refundTotal), 2000);
  assert.equal(Number(returnB.data.profitReversed), 400); // 20 * (100 - 80) = 400
  assert.equal(returnB.data.saleStatus, 'PARTIALLY_RETURNED');

  const { data: prodACheck3 } = await supabase.from('products').select('*').eq('id', prodAId).single();
  assert.equal(Number(prodACheck3.current_stock), 70); // Stock = 70

  const { data: saleBalanceB } = await supabase.from('sale_balances').select('*').eq('sale_id', saleA.data.id).single();
  assert.equal(Number(saleBalanceB.original_total), 5000);
  assert.equal(Number(saleBalanceB.refunded_total), 2000);
  assert.equal(Number(saleBalanceB.net_total), 3000);
  assert.equal(Number(saleBalanceB.original_profit), 1000);
  assert.equal(Number(saleBalanceB.reversed_profit), 400);
  assert.equal(Number(saleBalanceB.net_profit), 600); // Profit = 600

  // -------------------------------------------------------------
  // TEST D: Over Return (Tested prior to final return)
  // Original sale quantity = 50, already returned = 20.
  // Attempt to return 31.
  // Expected: REJECT. No database values should change.
  // -------------------------------------------------------------
  const returnOver = await supabase.rpc('create_return', {
    p_sale_id: saleA.data.id,
    p_date: today,
    p_items: [{ productId: prodAId, quantity: 31 }],
    p_reason: 'Test D over return attempt'
  });
  assert.ok(returnOver.error, 'Over return of 31 units must be rejected');
  assert.match(returnOver.error.message, /Maximum returnable quantity/);

  // Stock and balance should be unchanged
  const { data: prodACheckD } = await supabase.from('products').select('*').eq('id', prodAId).single();
  assert.equal(Number(prodACheckD.current_stock), 70);

  // -------------------------------------------------------------
  // TEST C: Full Return After Partial Return
  // Return remaining 30.
  // Expected: Stock = 100, Original Sold = 50, Total Returned = 50, Net Sold = 0,
  // Net Sale = Rs 0, Profit = Rs 0, Sale status = FULLY_RETURNED
  // -------------------------------------------------------------
  const returnC = await supabase.rpc('create_return', {
    p_sale_id: saleA.data.id,
    p_date: today,
    p_items: [{ productId: prodAId, quantity: 30 }],
    p_reason: 'Test C return remaining 30'
  });
  assert.equal(returnC.error, null);
  assert.equal(Number(returnC.data.refundTotal), 3000);
  assert.equal(Number(returnC.data.profitReversed), 600); // 30 * (100 - 80) = 600
  assert.equal(returnC.data.saleStatus, 'FULLY_RETURNED');

  const { data: prodACheck4 } = await supabase.from('products').select('*').eq('id', prodAId).single();
  assert.equal(Number(prodACheck4.current_stock), 100); // Stock back to 100

  const { data: saleBalanceC } = await supabase.from('sale_balances').select('*').eq('sale_id', saleA.data.id).single();
  assert.equal(Number(saleBalanceC.original_total), 5000);
  assert.equal(Number(saleBalanceC.refunded_total), 5000);
  assert.equal(Number(saleBalanceC.net_total), 0); // Net Sale = 0
  assert.equal(Number(saleBalanceC.net_profit), 0); // Profit = 0
  assert.equal(saleBalanceC.status, 'FULLY_RETURNED');

  // -------------------------------------------------------------
  // TEST E: Overselling
  // Current stock = 10. Attempt sale quantity = 11.
  // Expected: REJECT. Stock remains 10.
  // -------------------------------------------------------------
  const prodE = await supabase.rpc('create_product', {
    p_name: `Test E Product ${ts}`,
    p_unit: 'Box',
    p_purchase_cost: 10,
    p_sale_price: 20,
    p_minimum_stock: 2,
    p_opening_stock: 10
  });
  assert.equal(prodE.error, null);
  const prodEId = prodE.data.id;

  const saleOversell = await supabase.rpc('create_sale', {
    p_date: today,
    p_items: [{ productId: prodEId, quantity: 11, unitPrice: 20 }]
  });
  assert.ok(saleOversell.error, 'Oversell attempt must be rejected');
  assert.match(saleOversell.error.message, /available/);

  const { data: prodECheck } = await supabase.from('products').select('*').eq('id', prodEId).single();
  assert.equal(Number(prodECheck.current_stock), 10); // Stock remains 10

  // -------------------------------------------------------------
  // TEST F: Different Purchase Costs (Moving Weighted Average)
  // Add: 100 @ Rs 80.
  // Then add: 100 @ Rs 100.
  // Expected moving average: Rs 90.
  // Sell: 10 @ Rs 120.
  // Expected: Cost snapshot = Rs 90, Profit = Rs 300.
  // -------------------------------------------------------------
  const prodF = await supabase.rpc('create_product', {
    p_name: `Test F Product ${ts}`,
    p_unit: 'Kg',
    p_purchase_cost: 80,
    p_sale_price: 120,
    p_minimum_stock: 5,
    p_opening_stock: 0
  });
  assert.equal(prodF.error, null);
  const prodFId = prodF.data.id;

  // Add 100 @ Rs 80
  await supabase.rpc('add_stock', {
    p_items: [{ productId: prodFId, quantity: 100, unitCost: 80 }],
    p_entry_date: today
  });

  // Add 100 @ Rs 100 -> Average should be (100*80 + 100*100) / 200 = 90
  await supabase.rpc('add_stock', {
    p_items: [{ productId: prodFId, quantity: 100, unitCost: 100 }],
    p_entry_date: today
  });

  const { data: prodFCheck1 } = await supabase.from('products').select('*').eq('id', prodFId).single();
  assert.equal(Number(prodFCheck1.current_stock), 200);
  assert.equal(Number(prodFCheck1.average_cost), 90); // Moving average = Rs 90

  // Sell: 10 @ Rs 120
  const saleF = await supabase.rpc('create_sale', {
    p_date: today,
    p_items: [{ productId: prodFId, quantity: 10, unitPrice: 120 }]
  });
  assert.equal(saleF.error, null);
  assert.equal(Number(saleF.data.total), 1200); // 10 * 120
  assert.equal(Number(saleF.data.originalProfit), 300); // 10 * (120 - 90) = 300

  // Verify sale_items cost snapshot is Rs 90
  const { data: saleFItem } = await supabase.from('sale_items').select('*').eq('sale_id', saleF.data.id).single();
  assert.equal(Number(saleFItem.unit_cost_snapshot), 90);
  assert.equal(Number(saleFItem.original_profit), 300);

  // -------------------------------------------------------------
  // TEST G: Historical Return After Cost Changes
  // Take the sale from TEST F.
  // Later add new stock at a different purchase cost so product average cost changes.
  // Then return 5 items from the earlier sale.
  // The return MUST use the old sale item's unit_cost_snapshot = Rs 90.
  // Expected reversed profit: 5 * (120 - 90) = Rs 150.
  // -------------------------------------------------------------
  // Add new stock at Rs 200/unit to drastically change current product average cost
  await supabase.rpc('add_stock', {
    p_items: [{ productId: prodFId, quantity: 100, unitCost: 200 }],
    p_entry_date: today
  });

  const { data: prodFCheck2 } = await supabase.from('products').select('*').eq('id', prodFId).single();
  // Old stock was 190 @ 90, added 100 @ 200 -> new avg is (190*90 + 100*200) / 290 = 127.93...
  assert.notEqual(Number(prodFCheck2.average_cost), 90, 'Average cost should have changed');

  // Return 5 from earlier sale F
  const returnG = await supabase.rpc('create_return', {
    p_sale_id: saleF.data.id,
    p_date: today,
    p_items: [{ productId: prodFId, quantity: 5 }],
    p_reason: 'Test G historical cost return'
  });
  assert.equal(returnG.error, null);
  assert.equal(Number(returnG.data.refundTotal), 600); // 5 * 120 = 600
  assert.equal(Number(returnG.data.profitReversed), 150); // 5 * (120 - 90) = 150! Must NOT use 127.93!

  const { data: returnGItem } = await supabase.from('return_items').select('*').eq('return_id', returnG.data.id).single();
  assert.equal(Number(returnGItem.unit_cost_snapshot), 90, 'Return item cost snapshot MUST equal original sale snapshot of 90');
  assert.equal(Number(returnGItem.profit_reversed), 150);
});
