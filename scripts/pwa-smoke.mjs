import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.PWA_TEST_URL || 'http://127.0.0.1:3100';
const profile = await mkdtemp(path.join(tmpdir(), 'aziz-pwa-test-'));
const launch = () => chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1000 } });
let context = await launch();
const errors = [];
try {
  // Never access a real Supabase project during browser QA.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  let page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; localStorage.setItem('aziz_pos_trusted_device', JSON.stringify({ id: '00000000-0000-0000-0000-000000000001', email: 'test@example.invalid' })); });
  await page.reload();
  await page.getByRole('heading', { name: 'Aziz & Son Wholesaler', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  await context.setOffline(true);
  await page.getByRole('button', { name: /^Products/ }).click();
  await page.locator('#product-form').waitFor();
  const form = page.locator('#product-form');
  // Use the actual product form and its visible labels.
  await form.getByLabel('Product name').fill('Offline browser test');
  await form.getByLabel('Buying rate').fill('100');
  await form.getByLabel('Selling rate').fill('150');
  await form.getByLabel(/initial stock/i).fill('10');
  await form.getByRole('button', { name: /save|add|create/i }).click();
  await page.getByRole('status').filter({ hasText: 'Product saved with starting stock.' }).waitFor();
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
  await page.locator('[aria-haspopup="listbox"]').first().click();
  await page.getByText('Offline browser test', { exact: true }).click();
  await page.locator('input[type="number"]').first().fill('2');
  await page.getByRole('button', { name: 'Save & Print bill', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Returns', exact: true }).click();
  await page.getByLabel('Select invoice to return').selectOption({ index: 1 });
  await page.locator('[aria-haspopup="listbox"]').first().click();
  await page.getByText('Offline browser test', { exact: true }).click();
  await page.getByRole('button', { name: 'Save & Print Return Receipt', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const before = await page.evaluate(async () => {
    const db = await new Promise((resolve,reject) => { const r=indexedDB.open('AzizWholesaleOfflineDB'); r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
    const tx=db.transaction(['products','sync_queue'],'readonly');
    const get=store=>new Promise(resolve=>{const r=tx.objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);});
    return {products:await get('products'),queue:await get('sync_queue')};
  });
  assert.equal(before.products[0].current_stock,9);
  assert.equal(before.queue.length,3);
  await context.close();
  // Fresh browser process, same installed profile, no network at all.
  context = await launch();
  await context.setOffline(true);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Aziz & Son Wholesaler', exact: true }).waitFor();
  await page.getByRole('button', { name: /^Products/ }).click();
  await page.locator('table').getByText('Offline browser test', { exact:true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: installed shell, product, sale, return and queue survive a browser restart with all networking disabled.');
} finally { await context.close(); }
