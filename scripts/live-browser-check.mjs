import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Explicit credentials only; this check never creates or resets business data.
assert.ok(process.env.TEST_ADMIN_EMAIL && process.env.TEST_ADMIN_PASSWORD);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const snapshotResponse = page.waitForResponse(r => r.url().includes('/rpc/shop_snapshot') && r.ok(), { timeout: 60000 });
  await page.goto(process.env.PWA_TEST_URL || 'http://127.0.0.1:3100');
  await page.getByLabel('Email', { exact: true }).fill(process.env.TEST_ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(process.env.TEST_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const cloud = await (await snapshotResponse).json();
  await page.getByRole('heading', { name: 'Aziz & Son Wholesaler', exact: true }).waitFor();
  await page.waitForFunction(async expected => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('AzizWholesaleOfflineDB'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const tx = db.transaction(['products', 'sales', 'returns', 'settings'], 'readonly');
      const read = (store, key) => new Promise(resolve => { const r = key ? tx.objectStore(store).get(key) : tx.objectStore(store).count(); r.onsuccess = () => resolve(r.result); });
      const values = await Promise.all([read('products'), read('sales'), read('returns'), read('settings', 'last_sync')]);
      return values[0] === expected[0] && values[1] === expected[1] && values[2] === expected[2] && Boolean(values[3]);
    } finally { db.close(); }
  }, [cloud.products.length, cloud.sales.length, cloud.returns.length]);
  console.log('PASS: live login, migration 004 snapshot, and local mirror counts agree.');
  for (const section of ['Products', 'New sale', 'Returns']) {
    await page.getByRole('button', { name: section === 'Products' ? /^Products/ : section, exact: section !== 'Products' }).click();
  }
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: 'Aziz & Son Wholesaler', exact: true }).waitFor();
  await page.getByRole('button', { name: /^Products/ }).click();
  await page.locator('#product-form').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: authenticated website reopens offline with cached shop data and no JavaScript errors.');
} finally { await browser.close(); }
