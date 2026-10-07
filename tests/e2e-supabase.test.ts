import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createReceiptPdf } from '../src/lib/receipt-pdf';
import { lineAmount, roundMoney } from '../src/lib/calculations';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ttexfcxvyefbfilmyiwc.supabase.co';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_w-re86Xu23u08fKdJaD9Ig_A2zCvC6Z';

test('End-to-end Supabase flow: Auth, Products, Sales, 80mm Receipt, Returns & Profit', async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });

  // 1. Sign In
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: 'aziz@gmail.com',
    password: '123456'
  });
  assert.equal(authError, null, `Auth failed: ${authError?.message}`);
  assert.ok(authData.session, 'User session missing');

  // 2. Claim / Verify Shop Admin
  const { data: claimData, error: claimError } = await supabase.rpc('claim_shop_admin');
  assert.equal(claimError, null, `claim_shop_admin failed: ${claimError?.message}`);
  assert.equal(claimData?.authorized, true);

  const { data: isAdmin, error: adminCheckError } = await supabase.rpc('is_shop_admin');
  assert.equal(adminCheckError, null);
  assert.equal(isAdmin, true, 'User must be shop admin');

  // 3. Create or reuse test product
  const testProductName = `Automated Audit Product ${Date.now()}`;
  const buyingRate = 50.0;
  const sellingRate = 100.0;
  const openingStock = 2500;

  const { data: productResult, error: prodError } = await supabase.rpc('create_product', {
    p_name: testProductName,
    p_unit: 'Box',
    p_purchase_cost: buyingRate,
    p_sale_price: sellingRate,
    p_minimum_stock: 10,
    p_opening_stock: openingStock
  });
  assert.equal(prodError, null, `create_product failed: ${prodError?.message}`);
  const productId = productResult.id;
  assert.ok(productId, 'Product ID missing');

  // 4. Create Sale: Customer buys 2,000 units
  // Expected Revenue = 2,000 * 100 = 200,000
  // Expected Cost = 2,000 * 50 = 100,000
  // Expected Profit = 100,000
  const saleQty = 2000;
  const todayDate = new Date().toISOString().slice(0, 10);
  const { data: saleResult, error: saleError } = await supabase.rpc('create_sale', {
    p_date: todayDate,
    p_items: [
      {
        productId,
        quantity: saleQty,
        unitPrice: sellingRate
      }
    ],
    p_notes: 'Audit verification test sale'
  });
  assert.equal(saleError, null, `create_sale failed: ${saleError?.message}`);
  assert.ok(saleResult.id, 'Sale ID missing');
  assert.equal(Number(saleResult.netTotal), 200000);

  // 5. Test 80mm PDF Receipt generation
  const receiptBlob = createReceiptPdf({
    kind: 'SALE',
    number: saleResult.invoiceNumber,
    date: todayDate,
    totalLabel: 'TOTAL',
    total: 200000,
    items: [
      {
        name: testProductName,
        unit: 'Box',
        quantity: saleQty,
        rate: sellingRate,
        amount: 200000
      }
    ]
  }, {
    business_name: 'Aziz & Son Wholesaler',
    receipt_footer: 'Thank you for your business!'
  });
  assert.ok(receiptBlob.size > 1000, 'Receipt PDF generated');

  // 6. Query sale items from Supabase
  const { data: saleItems, error: itemsError } = await supabase
    .from('sale_items')
    .select('*')
    .eq('sale_id', saleResult.id);
  assert.equal(itemsError, null);
  assert.equal(saleItems.length, 1);
  const item = saleItems[0];
  const initialProfit = roundMoney(Number(item.line_total) - Number(item.cost_total_snapshot));
  assert.equal(initialProfit, 100000, 'Initial profit should be 100,000');

  // 7. Customer Returns 1,000 units (restock = true)
  // Expected Refund = 1,000 * 100 = 100,000
  // Expected Cost Snapshot = 1,000 * 50 = 50,000
  // Profit reduction = 100,000 - 50,000 = 50,000
  // New Net Profit = 100,000 - 50,000 = 50,000 (exactly 50% decrease!)
  const returnQty = 1000;
  const { data: returnResult, error: returnError } = await supabase.rpc('create_return', {
    p_date: todayDate,
    p_reason: 'Audit verification return',
    p_sale_id: saleResult.id,
    p_items: [
      {
        productId,
        quantity: returnQty,
        restock: true
      }
    ],
    p_notes: 'Half returned'
  });
  assert.equal(returnError, null, `create_return failed: ${returnError?.message}`);
  assert.equal(Number(returnResult.refundTotal), 100000, 'Refund should be 100,000');

  // 8. Fetch Returns from Supabase & Verify Profit Math
  const { data: returnsData, error: retFetchError } = await supabase
    .from('returns')
    .select('*')
    .eq('sale_id', saleResult.id);
  assert.equal(retFetchError, null);
  assert.equal(returnsData.length, 1);
  const retRow = returnsData[0];
  assert.equal(Number(retRow.refund_amount), 100000);
  assert.equal(Number(retRow.cost_amount_snapshot), 50000);

  // Profit calculation logic exactly matching frontend:
  const returnProfitImpact = roundMoney(
    Number(retRow.refund_amount) - (retRow.restock ? Number(retRow.cost_amount_snapshot) : 0)
  );
  assert.equal(returnProfitImpact, 50000, 'Return impact should be 50,000');
  const finalProfit = roundMoney(initialProfit - returnProfitImpact);
  assert.equal(finalProfit, 50000, 'Final adjusted profit must be 50,000 after 1k return!');

  // 9. Verify Stock in stock_movements
  const { data: movements, error: moveError } = await supabase
    .from('stock_movements')
    .select('quantity')
    .eq('product_id', productId);
  assert.equal(moveError, null);
  // Opening: +2500, Sale: -2000, Return: +1000 -> Expected Remaining Stock: 1500
  const totalStock = movements.reduce((sum, m) => sum + Number(m.quantity), 0);
  assert.equal(totalStock, 1500, 'Stock after return should be 1,500');
});
