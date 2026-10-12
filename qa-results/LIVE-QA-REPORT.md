# Visible live-database QA ? 12 October 2026

The transactions below were entered through the production website at http://127.0.0.1:3100, connected to the real configured Supabase project. They remain saved and visible. This was not the earlier temporary bulk-test database.

Open the website, sign in, click **Sync Now**, then open Products, Overview or Returns. Search for **QA LIVE 2026-10-12T09-02-00**. Use the 12 October 2026 date or All-Time History for reports.

## Transactions entered

1. Boxes: opening 10 at Rs. 100; selling price Rs. 150. Purchased 5 more at Rs. 130. Result: 15 boxes, average cost Rs. 110.
2. Packets: opening 20 at Rs. 50; selling price Rs. 80.
3. Crates: opening 8 at Rs. 200; selling price Rs. 260.
4. Offline invoice AS-BF2805927A97-000001: sold 4 boxes and 3 packets. Gross Rs. 840, original cost Rs. 590, original profit Rs. 250.
5. Offline saleable return: 1 box, refund Rs. 150, stock restored by 1, recovered cost Rs. 110, profit reversal Rs. 40.
6. Offline damaged return: 1 packet, refund Rs. 80, no stock restored, profit reversal Rs. 80.
7. Closed Chrome completely and reopened the same profile offline. Invoice, both returns and all three pending operations survived.
8. Reconnected. The offline invoice and both returns arrived in real Supabase automatically. Cloud values were checked directly.
9. Online invoice AS-BF2805927A97-000002: sold 2 crates, total Rs. 520, original profit Rs. 120; returned both saleable crates for Rs. 520. Invoice became FULLY_RETURNED, with zero remaining revenue/profit.
10. Repeated synchronization and verified exactly 2 QA invoices and 3 QA returns remained.
11. Signed into an independent fresh browser profile. Verified all three products, both invoices and all three returns downloaded into its local IndexedDB, matched server quantities/amounts, appeared in the website, and stayed visible after an offline reload.

## Final reconciliation

| Measure | Expected | Actual |
|---|---:|---:|
| Gross sales | Rs. 1,360 | Rs. 1,360 |
| Refunds | Rs. 750 | Rs. 750 |
| Net sales | Rs. 610 | Rs. 610 |
| Net cost of goods sold | Rs. 480 | Rs. 480 |
| Trading profit | Rs. 130 | Rs. 130 |
| Boxes stock / average cost | 12 / Rs. 110 | 12 / Rs. 110 |
| Packets stock / average cost | 17 / Rs. 50 | 17 / Rs. 50 |
| Crates stock / average cost | 8 / Rs. 200 | 8 / Rs. 200 |
| Inventory valuation | Rs. 3,770 | Rs. 3,770 |

All values passed in live Supabase and in the independent browser's local database. Dashboard screenshots also show the matching report totals.

## Evidence and scope

- `live-visible-results.json`: live IDs, document numbers and financial results. Invoice `profit` fields are original profit before return reversals; the totals field shows final trading profit.
- `live-overview.png`: actual dashboard displaying invoices, refunds and profit.
- `live-products.png`: actual product table showing remaining stock and buying rates.
- Browser writes used explicitly authorized QA products only. No reset or deletion was performed.
- QA transactions are included in real reports. They have deliberately been left in place for inspection.
- Early automation attempts required selector and synchronization-wait corrections. Existing QA rows were reused on continuation; final counts and amounts were verified independently. These were test-harness failures, not confirmed application calculation defects.
- The application ran locally on port 3100 against real Supabase. No externally hosted URL was supplied or tested. Other browsers on the same project receive these records when synchronized, provided they run the updated app and have no unresolved pending conflicts.
