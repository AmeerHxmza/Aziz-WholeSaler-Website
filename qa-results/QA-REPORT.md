# Data-flow QA report

Date: 12 October 2026 (Asia/Karachi)

## Result

PASS for the scenarios executed, after correcting one weighted-average precision defect. This is evidence for the tested workflows, not a guarantee that every possible input or deployment condition is defect-free.

15 automated tests passed, zero failed, one optional live-contract test skipped in the standard suite. A separate authenticated live-browser check passed against the configured Supabase project. Production build (including TypeScript), ESLint, and offline browser checks passed.

No test products, sales, returns, repayments, or resets were written to the live shop. Bulk writes and destructive reset tests used disposable local databases.

## Dataset actually entered through business operations

| Record/action | Count |
|---|---:|
| Products with opening stock | 120 |
| Additional stock purchases | 240 |
| Sale invoices | 600 |
| Sale lines | 1,800 |
| Return documents | 240 |
| Return lines | 720 |
| Physical stock adjustments | 12 |
| Loans, given and taken | 20 |
| Repayments | 20 |
| Queued changes uploaded | 1,252 |
| Uploads deliberately replayed | 126 |

Every invoice contained three distinct products. The first 120 invoices were returned in two stages, testing partial and complete return status. Restockable and damaged returns were mixed. Some sales were free or below cost, intentionally exercising negative profits. Buying prices changed both before sales and before returns.

Loan principal totaled Rs. 39,000; repayments totaled Rs. 10,000; outstanding balances totaled Rs. 29,000. Each individual loan balance was verified after synchronization.

## Independently calculated financial reconciliation

All figures below are rupees. Expected figures use a separate BigInt integer-arithmetic model, not the application's calculation helpers. Buying-cost precision is six decimal places; posted accounting totals are in paisa. User-entered prices and quantities are whole numbers.

| Measure | Expected | Actual after sync | Difference |
|---|---:|---:|---:|
| Gross sales | 1,291,103.00 | 1,291,103.00 | 0.00 |
| Original cost of goods sold | 1,239,683.70 | 1,239,683.70 | 0.00 |
| Customer refunds | 256,162.00 | 256,162.00 | 0.00 |
| Cost recovered from restocked returns | 159,452.71 | 159,452.71 | 0.00 |
| Net sales | 1,034,941.00 | 1,034,941.00 | 0.00 |
| Net cost of goods sold | 1,080,230.99 | 1,080,230.99 | 0.00 |
| Net trading profit / loss | -45,289.99 | -45,289.99 | 0.00 |

The negative profit is intentional: the dataset includes free sales, below-cost sales, and damaged goods refunded without restoring inventory. This checks that the application does not incorrectly hide losses by clamping values to zero.

## Checks performed

### Local business operations and rollback

- Verified every product's remaining stock and six-decimal weighted-average cost against the independent model.
- Verified all 600 invoice totals, original profits, and balances after returns.
- Verified every return document's refund and reversed profit during creation.
- Confirmed all 120 fully returned invoices reach FULLY_RETURNED and zero net sales balance.
- Confirmed damaged returns do not restore stock or recover inventory cost.
- Confirmed original sale costs remain unchanged after later purchases at different prices.
- Rejected overselling, including a multi-item invoice whose first line is valid and later line is invalid. Subsequent stock checks verify transaction rollback; rejected operations do not enter the queue.
- Rejected returns against already fully returned invoices.
- Existing regression tests also cover fractional inputs, duplicate products, invalid dates, signed return-only reports, and exact final partial-return residuals.

### PostgreSQL and synchronization

- Executed actual migrations 001?004 in PGlite PostgreSQL with a simulated authorized account.
- Uploaded all 1,252 queued operations in their original order using sync_shop_operation.
- Replayed 126 operations and verified identical responses, unchanged document counts, and correct stock totals.
- Downloaded shop_snapshot and replaced the local mirror through the application's applyCloudSnapshot function.
- Rechecked all product quantities/costs and all invoice financial totals after download.
- Compared every one of the 1,800 sale lines and 720 return lines before and after synchronization, including original cost snapshots, identities and restock flags.
- Compared every return header's financial amounts before and after synchronization.
- Confirmed complete download of 600 sales and 240 returns, exceeding the former history limits.
- Existing transport regression simulates a lost response after database commit, concurrent sync calls, retry of interrupted operations, and local transactions created while downloading.

### Reset, recovery, migration and receipts

- Existing database regression verifies successful reset clears cloud business tables and every local store, then synchronization does not recreate cleared sales/products.
- Simulated server reset failure verifies local records remain intact.
- Backup restore tests verify account ownership, refusal to overwrite a nonempty ledger, preservation of pending operations, and regeneration of future device numbering.
- Legacy migration tests verify multi-line returns, damaged returns, original sale totals, and stock survive upgrades.
- PDF tests verify 80 mm receipts and long-content single-page roll sizing.

### Real browser and live service

- Production Chrome test: create a product with 10 units at buying rate 100 and selling rate 150, sell 2, return 1, verify stock 9 and three queued operations, close Chrome, reopen the same profile with all networking disabled and verify the product remains accessible.
- Separate live check: sign in with the supplied account, download the deployed migration-004 snapshot, verify local product/sale/return counts match, visit the main business sections, and reload offline without JavaScript errors.
- Live check used a separate browser context and did not submit business transactions or reset the shop.

## Defects found and changes made

1. **Weighted-average precision mismatch ? fixed.** The bulk oracle found a local cost of 202.444984 where exact arithmetic required 202.444985. JavaScript floating-point rounding could disagree with PostgreSQL NUMERIC at a half-step. averageCost now uses integer scaled arithmetic; the complete bulk test passes against PostgreSQL after the fix. This is an application-code change; it requires redeployment, not another SQL migration. It does not rewrite historical cost snapshots.
2. **Browser test selected a hidden option ? fixed in the test.** Moving inventory controls above the table meant a generic text locator found a hidden dropdown option first. The restart check now targets the visible product table. No production data-loss bug was involved; the corrected browser test passes.

## Limits and review

- The bulk scenario runs the same local business functions and real PostgreSQL RPC implementations, with fake IndexedDB and simulated auth. It is not 600 manually clicked browser invoices or a hosted Supabase load/concurrency benchmark.
- Live Supabase coverage here is authentication and read/download/offline reopening. Hosted write load, real network outage timing and simultaneous disconnected laptops were not exercised against the live shop.
- Trading profit here is sales minus refunds minus net goods cost; it does not represent business net income after rent, wages, taxes or other expenses.
- A browser cannot guarantee synchronization while it is closed. Reopen the installed app with internet to synchronize.
- Physical printer output and the client's actual laptop persistence settings remain hardware-specific checks.
- Previously documented limitations still apply: old pre-protocol-2 pending queues require reconciliation, new returns must reference an invoice, and independently offline laptops cannot reserve the same stock globally.

## Reproduction and evidence

- Run `npm test` for the regression and volume suites.
- Volume test: `tests/volume-qa.test.ts`.
- Generated expected/actual figures: `qa-results/volume-results.json`.
- Build with `npm run build`, then start with `npm start -- --port 3100`.
- Run `node scripts/pwa-smoke.mjs` for isolated offline browser verification.
- `scripts/live-browser-check.mjs` requires explicit TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD environment variables; it uses the application's configured Supabase project.
