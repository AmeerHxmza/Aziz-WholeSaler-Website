import { offlineDb } from './offline-db';

/** Recovery onto an empty browser profile. Never merge two divergent ledgers. */
export async function restoreOfflineBackup(input: unknown, owner: string) {
  if (!input || typeof input !== 'object') throw new Error('Invalid backup file.');
  const backup = input as Record<string, unknown>;
  if (backup.version !== 1) throw new Error('Unsupported backup version.');
  for (const table of offlineDb.tables) {
    if (!Array.isArray(backup[table.name])) throw new Error(`Backup is missing ${table.name}.`);
    const keys = new Set();
    for (const row of backup[table.name] as Record<string, unknown>[]) {
      const key = row?.[table.name === 'settings' ? 'key' : 'id'];
      if (typeof key !== 'string' || !key || keys.has(key)) throw new Error(`Invalid or duplicate ${table.name} key.`);
      keys.add(key);
    }
  }
  const settings = backup.settings as { key: string; value: unknown }[];
  if (settings.find(s => s.key === 'owner_id')?.value !== owner) throw new Error('This backup belongs to another account or has no verified owner.');
  const products = new Set((backup.products as { id: string }[]).map(p => p.id));
  const sales = new Set((backup.sales as { id: string }[]).map(p => p.id));
  const saleItems = new Set((backup.sale_items as { id: string }[]).map(p => p.id));
  const returns = new Set((backup.returns as { id: string }[]).map(p => p.id));
  for (const row of backup.sale_items as { product_id: string; sale_id: string }[]) {
    if (!products.has(row.product_id) || !sales.has(row.sale_id)) throw new Error('Backup contains a sale item with missing references.');
  }
  for (const row of backup.return_items as { return_id: string; sale_item_id: string }[]) {
    if (!returns.has(row.return_id) || !saleItems.has(row.sale_item_id)) throw new Error('Backup contains a return item with missing references.');
  }
  await offlineDb.transaction('rw', offlineDb.tables, async () => {
    for (const table of offlineDb.tables) {
      if (table.name !== 'settings' && await table.count()) throw new Error('Restore requires an empty local database. Existing records were not changed.');
    }
    await offlineDb.settings.clear();
    for (const table of offlineDb.tables) await table.bulkPut(backup[table.name] as Record<string, unknown>[]);
    await offlineDb.settings.delete('maintenance');
    await offlineDb.settings.put({ key: 'device_id', value: crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase() });
  });
}
