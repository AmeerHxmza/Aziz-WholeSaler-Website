# Aziz & Son Wholesale Ledger

A single-administrator, offline-first PWA for a wholesale shop. Products, purchases, sales, linked customer returns (saleable or damaged), physical stock counts, loans, repayments and receipt settings save to IndexedDB before synchronization.

## Local storage and installation

Install the production website using **Install app** in Chrome or Edge on the laptop. The database is named `AzizWholesaleOfflineDB` and lives in the browser profile, normally on the Windows C: drive. It is not a standalone SQLite file and does not require a local server after installation.

1. Open the production HTTPS URL while online and sign in as the shop administrator.
2. Wait for successful synchronization. In Settings, check that the offline app is ready and whether persistent storage was granted.
3. Install the PWA and test closing/reopening it with internet disconnected.
4. Keep using the same browser profile and website address. Different ports, domains, browsers and private windows have separate databases.

The app requests persistent storage. Browsers can decline it, and manually clearing site data or deleting the browser profile still removes local records. Export regular JSON backups from Settings. The production build precaches the complete application shell and its JavaScript/CSS assets. New builds activate after old app windows close; finish current work before reopening for an update.

## Synchronization rules

- A business change and its upload-queue entry commit together in one local transaction.
- Only queued changes are uploaded. Unchanged local rows are never re-uploaded.
- Every operation has a stable UUID, monotonic local sequence and immutable payload. PostgreSQL records its result in the same transaction as the change. Retrying after a lost connection cannot apply it twice.
- Sale/return UUIDs and printed document numbers remain the same offline and online. Numbers include a device identifier to avoid collisions between laptops.
- Reconnect triggers synchronization automatically; it also retries every 20 seconds while the browser is online.
- After uploads, one consistent, complete server snapshot is downloaded, including stock/loan history and audit data. There is no 300-sale or 100-return cutoff.
- Local tables are replaced atomically only if there are no outstanding operations. A transaction created during the download prevents replacement. The complete cloud snapshot is also retained locally for recovery and conflict review.
- Conflicts and failed/interrupted operations remain visible and count as unsynchronized. The app never silently discards them or overwrites pending work. Dependent uploads stop behind a failed operation.
- Product edits detect intervening edits on another device. Physical adjustments detect intervening stock changes. Offline stock cannot be globally reserved across disconnected laptops: insufficient cloud stock requires reconciliation when reconnecting.
- Keep the PWA open to synchronize. Browsers do not guarantee uploads after the app is closed.

## Whole-number business inputs

New quantities, selling/purchase prices, minimum-stock levels and cash/repayment amounts must be whole numbers. Fractional input is rejected, not rounded into an accepted entry. Historical records are retained without truncation.

Weighted-average inventory costs can still be fractional even when all purchases are whole numbers. Internal unit costs retain six decimals and posted cost/profit amounts use two decimals consistently in both databases. For example, buying two units at Rs. 1 and one at Rs. 2 gives an average cost of 1.333333. Rounding that to an integer would corrupt profit. Whole-number money displays without an unnecessary `.00` suffix.

Returns use original sale snapshots, preserve all returned lines, respect the selected business date and determine full-return status from quantities. Saleable returns restore inventory value at the original cost; damaged returns do not restore stock. Final partial returns reconcile any remaining cost allocation. Reports retain negative totals in return-only periods.

New returns require the original invoice. Legacy unlinked returns are preserved in the archive, local snapshot, reports and backups. Creating new standalone refunds is not part of the current linked-invoice workflow.

## Supabase setup / upgrade

Use a dedicated test project before upgrading a working shop. Save a Supabase database backup and the existing local export first.

For a new database, run these files in order in the Supabase SQL editor:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_wholesale_core.sql`
3. `supabase/migrations/003_fix_reset_shop_data.sql`
4. `supabase/migrations/004_durable_offline_sync.sql`

If migrations 001–003 are already installed, apply **004**. It adds the idempotent sync RPC, complete snapshot RPC, stable item IDs, corrected return/accounting behavior, and legacy data backfills. Deploy the app only after this migration succeeds. The application does not apply database migrations automatically.

Create the administrator through Supabase Auth and disable public signup. The initial administrator email in migration 001 must match that account. Only public/publishable keys belong in browser configuration:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-public-key
```

Place those in `.env.local` for local development and deployment environment variables for hosting. Never expose a service-role key as `NEXT_PUBLIC_*`.

### Existing unsynchronized records from the old app

The old queue did not use server-side operation IDs, so an old failed/interrupted upload may already exist remotely under another ID. The new app deliberately retains and blocks these legacy queue entries rather than guessing and duplicating money or stock. Export both local and cloud records and reconcile their invoices/items before upgrading those operations. Do not delete a queue entry or blindly label it synchronized to remove the warning.

## Running and deployment

```bash
npm install
npm run dev
```

Development does not install a new service worker. Test offline behavior against a production build on a separate port:

```bash
npm run build
npm start -- --port 3100
```

`npm run build` runs a postbuild script that generates `public/sw-assets.js` from the exact build assets. On Vercel or another host, use **`npm run build`** as the build command, not a bare `next build`, and deploy that generated public file with the build. The generated file is intentionally gitignored.

## Backups and recovery

Settings exports every local database store in one read transaction, including pending operations, settings, stock entries and the last complete cloud snapshot. Restore accepts a valid backup only into an empty local database belonging to the same administrator; it rejects replacement/merging of an existing ledger. Restore preserves operation IDs for safe retry and assigns a new device identifier for future invoice numbers.

Restoring an old local backup does not undo a cloud reset. Disaster recovery of already-synchronized records after a server deletion requires restoring the server backup as well. Restore an offline backup before reconnecting and review its contents against the server state.

The refresh button synchronizes without deleting local records. Full reset requires synchronization, a complete cloud+local safety export and the exact confirmation phrase. Local writes are blocked while reset runs. Keep the downloaded backup; the app cannot verify that the browser download was saved to a separate disk.

## Verification

```bash
npm test
npm run lint
npm run build
# With the production server running on port 3100:
node scripts/pwa-smoke.mjs
```

The default test suite uses fake IndexedDB and [PGlite](https://pglite.dev/docs/) (local PostgreSQL) only. It covers integer validation, actual SQL migrations, legacy upgrades, lost-response retries, concurrent sync callers, complete history, local writes during downloads, returns, valuation, signed reporting and backup restoration. The PWA test uses a separate Chrome profile, blocks external requests and reopens the app in a new browser process with networking disabled.

The optional deployed-schema contract test is read-only and skipped by default. It requires `RUN_LIVE_TESTS=1` plus `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`, `TEST_ADMIN_EMAIL`, and `TEST_ADMIN_PASSWORD`; use only an isolated test shop. No administrator password is embedded in the source.

Physical 80 mm receipt printing still needs a check on the client's printer at 100% scale. Browser storage persistence and final installation should also be checked on the actual laptop.

The dependency audit currently reports development-only advisories in the ESLint glob dependency chain. The suggested automated fix downgrades the Next.js ESLint configuration across major versions, so it was not applied. Production dependencies were not flagged by that audit run.
