import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { offlineDb } from '../src/lib/db/offline-db';
import {
  saveOfflineProduct,
  recordOfflineStock,
  createOfflineSale,
  createOfflineReturn
} from '../src/lib/db/offline-operations';
import { roundMoney, formatMoney } from '../src/lib/calculations';

test('End-to-End Wholesaler Flow: New Product -> Stock Inward -> Sale -> Return -> Dashboard Verification', async () => {
  // 0. Clean DB
  await offlineDb.transaction('rw', [
    offlineDb.products,
    offlineDb.sales,
    offlineDb.sale_items,
    offlineDb.returns,
    offlineDb.return_items,
    offlineDb.inventory_movements,
    offlineDb.sync_queue
  ], async () => {
    await offlineDb.products.clear();
    await offlineDb.sales.clear();
    await offlineDb.sale_items.clear();
    await offlineDb.returns.clear();
    await offlineDb.return_items.clear();
    await offlineDb.inventory_movements.clear();
    await offlineDb.sync_queue.clear();
  });

  // STEP 1: Save New Product with Opening Shelf Stock
  // Super Basmati Rice 25kg, Buying: Rs. 2,500, Selling: Rs. 3,200, Opening stock: 10 bags
  const productA = await saveOfflineProduct({
    name: 'Super Basmati Rice 25kg',
    unit: 'Bag',
    purchaseCost: 2500,
    salePrice: 3200,
    minimumStock: 5,
    openingStock: 10
  });

  assert.equal(productA.current_stock, 10, 'Initial stock should be 10 bags');
  assert.equal(productA.purchase_cost, 2500, 'Purchase cost should be Rs. 2,500');
  assert.equal(productA.sale_price, 3200, 'Sale price should be Rs. 3,200');

  // STEP 2: Stock Inward (+Stock)
  // Receive 5 additional bags at Rs. 2,500
  await recordOfflineStock({
    productId: productA.id,
    quantity: 5,
    purchaseCost: 2500,
    movementType: 'PURCHASE',
    date: new Date().toISOString().slice(0, 10),
    notes: 'Warehouse batch shipment'
  });

  const updatedProdA = await offlineDb.products.get(productA.id);
  assert.equal(updatedProdA?.current_stock, 15, 'Stock after inward must be 10 + 5 = 15 bags');

  // STEP 3: Write a Sale Bill
  // Customer buys 4 bags @ Rs. 3,200 = Rs. 12,800
  const saleResult = await createOfflineSale({
    customerName: 'Haji Aslam Wholesale',
    customerPhone: '03001234567',
    items: [
      {
        productId: productA.id,
        quantity: 4,
        unitPrice: 3200
      }
    ]
  });

  assert.equal(saleResult.sale.net_total, 12800, 'Sale total must be 4 * 3200 = Rs. 12,800');
  const prodAfterSale = await offlineDb.products.get(productA.id);
  assert.equal(prodAfterSale?.current_stock, 11, 'Stock after sale must be 15 - 4 = 11 bags');

  // Profit on sale: 4 * (3200 - 2500) = Rs. 2,800
  const originalProfit = saleResult.sale.original_profit;
  assert.equal(originalProfit, 2800, 'Sale gross profit must be 4 * 700 = Rs. 2,800');

  // STEP 4: Record a Customer Return
  // Customer returns 1 bag restocked (saleable) from the invoice
  const returnResult = await createOfflineReturn({
    saleId: saleResult.sale.id,
    items: [
      {
        productId: productA.id,
        quantity: 1
      }
    ],
    reason: 'Wrong variant'
  });

  assert.equal(returnResult.returnRow.refund_total, 3200, 'Refund total must be 1 * 3200 = Rs. 3,200');
  const prodAfterReturn = await offlineDb.products.get(productA.id);
  assert.equal(prodAfterReturn?.current_stock, 12, 'Stock after return must be 11 + 1 = 12 bags');

  // STEP 5: Dashboard Overview Verification
  // Load data as page.tsx does:
  const allSales = await offlineDb.sales.toArray();
  const allSaleItems = await offlineDb.sale_items.toArray();
  const allReturns = await offlineDb.returns.toArray();
  const allProducts = await offlineDb.products.toArray();

  const allReturnItems = await offlineDb.return_items.toArray();

  const hydratedSales = allSales.map((s) => ({
    ...s,
    items: allSaleItems
      .filter((i) => i.sale_id === s.id)
      .map((si) => ({
        ...si,
        cost_total_snapshot: Number(si.unit_cost_snapshot * si.quantity),
        purchase_cost_snapshot: Number(si.unit_cost_snapshot)
      }))
  }));

  const hydratedReturns = allReturns.map((r) => {
    const ri = allReturnItems.find((item) => item.return_id === r.id);
    return {
      ...r,
      movement_date: r.return_date,
      refund_amount: Number(r.refund_total),
      cost_amount_snapshot: Number(ri ? ri.unit_cost_snapshot * ri.quantity_returned : 0),
      restock: true
    };
  });

  // Calculations:
  const getSaleProfit = (s: any) => {
    return s.items.reduce(
      (sum: number, item: any) => sum + (Number(item.line_total) - Number(item.cost_total_snapshot)),
      0
    );
  };
  const getReturnProfitReduction = (r: any) => {
    const refund = Number(r.refund_amount);
    const cost = r.restock ? Number(r.cost_amount_snapshot || 0) : 0;
    return refund - cost;
  };

  const grossSales = roundMoney(hydratedSales.reduce((sum, s) => sum + Number(s.total ?? s.net_total), 0));
  const refunds = roundMoney(hydratedReturns.reduce((sum, r) => sum + Number(r.refund_amount), 0));
  const netRevenue = roundMoney(grossSales - refunds);

  const saleProfits = hydratedSales.reduce((sum, s) => sum + getSaleProfit(s), 0);
  const returnProfitReductions = hydratedReturns.reduce((sum, r) => sum + getReturnProfitReduction(r), 0);
  const tradingProfit = roundMoney(saleProfits - returnProfitReductions);

  const cogs = roundMoney(netRevenue - tradingProfit);
  const marginPct = ((tradingProfit / netRevenue) * 100).toFixed(1);
  const stockValuation = roundMoney(
    allProducts.reduce((sum, p) => sum + Math.max(0, p.current_stock) * p.purchase_cost, 0)
  );

  // Assertions on Dashboard Metrics:
  assert.equal(grossSales, 12800, 'Gross sales must be exactly Rs. 12,800.00');
  assert.equal(refunds, 3200, 'Refunds must be exactly Rs. 3,200.00');
  assert.equal(netRevenue, 9600, 'Net revenue must be 12,800 - 3,200 = Rs. 9,600.00');

  // COGS for 3 retained bags: 3 * 2,500 = Rs. 7,500
  assert.equal(cogs, 7500, 'COGS for 3 sold bags must be Rs. 7,500.00');

  // Net Profit for 3 retained bags: 3 * (3,200 - 2,500) = Rs. 2,100
  assert.equal(tradingProfit, 2100, 'Net trading profit must be Rs. 2,100.00');

  // Margin: 2,100 / 9,600 = 21.875% -> 21.9%
  assert.equal(marginPct, '21.9', 'Trading margin percentage must be 21.9%');

  // Inventory valuation: 12 bags on shelf * Rs. 2,500 = Rs. 30,000
  assert.equal(stockValuation, 30000, 'Stock on hand valuation must be 12 * 2500 = Rs. 30,000.00');

  // Output verified clean summary
  console.log('✅ Wholesaler Verification Summary:');
  console.log(`   - Shelf Stock Remaining: ${prodAfterReturn?.current_stock} ${productA.unit}`);
  console.log(`   - Stock Valuation: ${formatMoney(stockValuation)}`);
  console.log(`   - Gross Sales: ${formatMoney(grossSales)}`);
  console.log(`   - Customer Refunds: ${formatMoney(refunds)}`);
  console.log(`   - Net Revenue: ${formatMoney(netRevenue)}`);
  console.log(`   - Cost of Goods Sold (COGS): ${formatMoney(cogs)}`);
  console.log(`   - Net Trading Profit: ${formatMoney(tradingProfit)}`);
  console.log(`   - Profit Margin: ${marginPct}%`);
});
