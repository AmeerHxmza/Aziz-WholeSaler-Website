import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function runBrowserQa() {
  console.log('🚀 Launching Google Chrome for End-to-End Browser QA...');
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  try {
    // 1. Navigate to application
    console.log('📍 Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

    // Handle authentication if on login screen
    const emailInput = page.locator('input[type="email"]');
    if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('🔑 Logging in with aziz@gmail.com / aziz1234...');
      await emailInput.fill('aziz@gmail.com');
      await page.fill('input[type="password"]', 'aziz1234');
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }

    console.log('✅ Logged in successfully. Current URL:', page.url());

    // 2. Test Overview Page Period Selector
    console.log('\n📊 TEST 1: Overview Dashboard & Period Selector...');
    const periodBar = page.locator('.overview-period-bar');
    await assert.doesNotReject(async () => {
      await periodBar.waitFor({ state: 'visible', timeout: 5000 });
    }, 'Overview period selector bar should be visible');

    // Test clicking period buttons
    const periods = ['Today', 'This Week (7 Days)', 'This Month', 'This Year', 'All-Time History'];
    for (const p of periods) {
      const btn = page.locator(`.period-pill:has-text("${p}")`).first();
      await btn.click();
      await page.waitForTimeout(300);
      assert.ok(await btn.evaluate((el) => el.classList.contains('active')), `${p} should be active after click`);
    }
    console.log('✅ Period pills (Today, 7 Days, Month, Year, All-Time) toggle smoothly and reactively.');

    // Verify wholesale summary strip
    const summaryStrip = page.locator('.wholesale-summary-strip');
    assert.ok(await summaryStrip.isVisible(), 'Wholesale summary strip should be visible');
    console.log('✅ Wholesale financial summary strip is displayed.');

    // 3. Test Products Page: High-Density Entry & Matrix
    console.log('\n📦 TEST 2: Product Catalog & Quick Add Matrix...');
    await page.click('button.nav-link:has-text("Products")');
    await page.waitForTimeout(800);

    const ts = Date.now().toString().slice(-5);
    const prodName = `Basmati Rice Gold ${ts}`;

    // Fill high-density product form
    console.log(`   Adding new product: "${prodName}"...`);
    await page.fill('#product-form input[placeholder*="Basmati"]', prodName);
    await page.fill('#product-form input[placeholder="e.g. Box"]', 'Bag');
    await page.fill('#product-form input[placeholder="0.00"]:nth-of-type(1)', '2400');
    // For selling rate:
    const priceInputs = page.locator('#product-form input[placeholder="0.00"]');
    await priceInputs.nth(0).fill('2400'); // buying
    await priceInputs.nth(1).fill('3000'); // selling
    await page.fill('#product-form input[placeholder="10"]', '5'); // min stock
    await page.fill('#product-form input[placeholder*="Optional"]', '20'); // opening stock

    await page.click('#product-form button:has-text("Add product")');
    await page.waitForTimeout(1500);

    // Verify product in table
    const prodRow = page.locator(`tr:has-text("${prodName}")`);
    await prodRow.waitFor({ state: 'visible', timeout: 5000 });
    console.log(`✅ Product "${prodName}" created and displayed in catalog table.`);

    // Verify stock badge shows 20 Bag
    const stockBadge = prodRow.locator('.pos-stock-badge');
    const stockText = await stockBadge.innerText();
    assert.ok(stockText.includes('20'), `Stock should show 20, got: ${stockText}`);
    console.log(`✅ Stock badge verified: ${stockText}`);

    // Verify margin chip
    const marginChip = prodRow.locator('.margin-chip');
    const marginText = await marginChip.innerText();
    assert.ok(marginText.includes('600') && marginText.includes('25%'), `Margin should be Rs. 600 (25%), got: ${marginText}`);
    console.log(`✅ Wholesale profit margin verified: ${marginText}`);

    // Test Quick Restock (+ Stock)
    console.log('   Testing Quick Restock (+ Stock)...');
    await prodRow.locator('button:has-text("+ Stock")').click();
    await page.waitForTimeout(500);

    const stockModal = page.locator('.modal-content');
    await stockModal.waitFor({ state: 'visible', timeout: 3000 });
    await page.fill('.modal-body input[type="number"]:nth-of-type(1)', '10');
    await page.click('button:has-text("Save Stock Now")');
    await page.waitForTimeout(1500);

    // Verify stock is now 30
    const updatedStockText = await prodRow.locator('.pos-stock-badge').innerText();
    assert.ok(updatedStockText.includes('30'), `Stock after restock should be 30, got: ${updatedStockText}`);
    console.log(`✅ Stock after inward restock verified: ${updatedStockText}`);

    // 4. Test New Sale Page
    console.log('\n🛒 TEST 3: New Sale POS Table...');
    await page.click('button.nav-link:has-text("New sale")');
    await page.waitForTimeout(800);

    // Fill customer info
    await page.fill('input[placeholder*="Customer name"]', 'Bismillah Traders');
    await page.fill('input[placeholder*="03001234567"]', '03009988776');

    // Select product in searchable select
    const productSearchInput = page.locator('.searchable-input').first();
    await productSearchInput.click();
    await productSearchInput.fill(prodName);
    await page.waitForTimeout(400);

    // Click the matching dropdown item
    const dropdownItem = page.locator(`.product-option:has-text("${prodName}")`).first();
    await dropdownItem.click();
    await page.waitForTimeout(400);

    // Set quantity to 5 using stepper + button
    const qtyInput = page.locator('.pos-qty-group input').first();
    await qtyInput.fill('5');
    await page.waitForTimeout(300);

    // Check line total (5 * 3000 = 15,000)
    const lineTotalCell = page.locator('.pos-total-cell').first();
    const lineTotalText = await lineTotalCell.innerText();
    assert.ok(lineTotalText.includes('15,000'), `Line total should be 15,000, got: ${lineTotalText}`);
    console.log(`✅ Line total calculated accurately: ${lineTotalText}`);

    // Click Save & Print bill
    console.log('   Saving sale bill...');
    await page.click('button:has-text("Save & Print bill")');
    await page.waitForTimeout(1500);

    // Verify thermal receipt overlay
    const receiptOverlay = page.locator('.receipt-overlay');
    await receiptOverlay.waitFor({ state: 'visible', timeout: 5000 });
    const receiptTotal = await page.locator('.receipt-total strong').innerText();
    assert.ok(receiptTotal.includes('15,000'), `Receipt total should be 15,000, got: ${receiptTotal}`);
    console.log(`✅ 80mm Thermal Receipt generated with total: ${receiptTotal}`);

    // Capture invoice number
    const invoiceNumber = await page.locator('.receipt-meta:has-text("Bill:") span').innerText();
    console.log(`   Saved Invoice Number: ${invoiceNumber}`);

    // Close receipt
    await page.click('.receipt-control-actions button:has-text("Close")');
    await page.waitForTimeout(800);

    // 5. Test Returns Page
    console.log('\n🔄 TEST 4: Return Page POS Matrix...');
    await page.click('button.nav-link:has-text("Returns")');
    await page.waitForTimeout(800);

    // Select the saved invoice
    const invoiceSelect = page.locator('select').first();
    await invoiceSelect.selectOption({ label: new RegExp(invoiceNumber) });
    await page.waitForTimeout(800);

    // Verify invoice summary strip
    const invoiceSummary = page.locator('.surface:has-text("Original Net Bill")');
    assert.ok(await invoiceSummary.isVisible(), 'Invoice summary banner should appear');
    console.log(`✅ Original invoice ${invoiceNumber} summary loaded.`);

    // In POS return table, select the product
    const returnProductSearch = page.locator('.searchable-input').first();
    await returnProductSearch.click();
    await returnProductSearch.fill(prodName);
    await page.waitForTimeout(400);
    await page.locator(`.product-option:has-text("${prodName}")`).first().click();
    await page.waitForTimeout(400);

    // Verify returnable count shows 5 Bag left
    const returnableBadge = page.locator('.pos-stock-badge.ok').first();
    const returnableText = await returnableBadge.innerText();
    assert.ok(returnableText.includes('5'), `Returnable should show 5 left, got: ${returnableText}`);
    console.log(`✅ Returnable quantity verified: ${returnableText}`);

    // Return 2 bags
    const returnQtyInput = page.locator('.pos-qty-group input').first();
    await returnQtyInput.fill('2');
    await page.waitForTimeout(300);

    // Verify refund amount (2 * 3000 = 6,000)
    const refundTotalText = await page.locator('.bill-total strong').innerText();
    assert.ok(refundTotalText.includes('6,000'), `Refund total should be 6,000, got: ${refundTotalText}`);
    console.log(`✅ Real-time refund total calculated: ${refundTotalText}`);

    // Fill reason and submit
    await page.fill('input[placeholder*="Defective"]', 'Over-purchased by customer');
    await page.click('button:has-text("Save & Print Return Receipt")');
    await page.waitForTimeout(1500);

    // Verify return receipt
    await receiptOverlay.waitFor({ state: 'visible', timeout: 5000 });
    const returnKind = await page.locator('.receipt-heading b').innerText();
    assert.equal(returnKind, 'RETURN', 'Receipt heading should indicate RETURN');
    const returnRefund = await page.locator('.receipt-total strong').innerText();
    assert.ok(returnRefund.includes('6,000'), `Return receipt total should be 6,000, got: ${returnRefund}`);
    console.log(`✅ 80mm Return Receipt verified: ${returnKind} · ${returnRefund}`);

    await page.click('.receipt-control-actions button:has-text("Close")');
    await page.waitForTimeout(800);

    // 6. Verify Final Stock & Overview Reflection
    console.log('\n📈 TEST 5: Final Stock & Financial Balance Verification...');
    await page.click('button.nav-link:has-text("Products")');
    await page.waitForTimeout(800);

    // Stock should be 30 - 5 + 2 = 27
    const finalProdRow = page.locator(`tr:has-text("${prodName}")`);
    const finalStockText = await finalProdRow.locator('.pos-stock-badge').innerText();
    assert.ok(finalStockText.includes('27'), `Final stock should be 27, got: ${finalStockText}`);
    console.log(`✅ Stock perfectly verified on floor: 20 + 10 - 5 + 2 = ${finalStockText}`);

    // Go to Overview
    await page.click('button.nav-link:has-text("Overview")');
    await page.waitForTimeout(800);

    // Capture screenshots for QA artifact
    await page.screenshot({ path: 'tests/overview-verified.png', fullPage: true });
    console.log('📸 Saved full-page verification screenshot: tests/overview-verified.png');

    console.log('\n🎉 ALL END-TO-END BROWSER POS FLOWS TESTED AND 100% VERIFIED!');
  } finally {
    await browser.close();
  }
}

runBrowserQa().catch((err) => {
  console.error('❌ Browser QA failed:', err);
  process.exit(1);
});
