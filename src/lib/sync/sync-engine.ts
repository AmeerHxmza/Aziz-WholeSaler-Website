import { offlineDb, type LocalSale, type LocalSyncQueueItem } from '../db/offline-db';
import { getSupabase } from '../supabase';
import { exportOfflineBackup } from '../db/offline-operations';

type Row = Record<string, unknown>;
export type CloudSnapshot = Record<string, unknown> & { owner_id: string };
export interface SyncStatusState {
  isOnline: boolean; isSyncing: boolean; pendingCount: number;
  lastSyncTime: string | null; lastError: string | null;
}
type SyncListener = (state: SyncStatusState) => void;
const str = (v: unknown) => v == null ? '' : String(v);
const num = (v: unknown) => Number(v ?? 0);
const message = (e: unknown) => e instanceof Error ? e.message : str((e as Row)?.message || e);
const rows = (snapshot: CloudSnapshot, key: string): Row[] => {
  if (!Array.isArray(snapshot[key])) throw new Error(`Incomplete cloud snapshot: ${key}. Local records were retained.`);
  return snapshot[key] as Row[];
};

// Check the queue and replace all tables in one transaction. A sale made while
// downloading prevents replacement, so its stock effect can never be overwritten.
export async function applyCloudSnapshot(snapshot: CloudSnapshot, owner: string): Promise<boolean> {
  if (snapshot.owner_id !== owner) throw new Error('Cloud snapshot belongs to another account.');
  for (const table of ['products','sales','sale_items','returns','return_items','stock_entries','stock_entry_items','inventory_movements','loans','loan_settlements','business_settings','stock_movements','stock_adjustments','invoice_sequences','return_sequences','audit_log']) rows(snapshot, table);
  const saleItems = rows(snapshot, 'sale_items');
  const itemIds = new Map(saleItems.map(i => [str(i.id), str(i.client_id || i.id)]));
  return offlineDb.transaction('rw', offlineDb.tables, async () => {
    const bound = await offlineDb.settings.get('owner_id');
    if (bound && bound.value !== owner) throw new Error('Local database belongs to another account.');
    await offlineDb.settings.put({ key: 'cloud_snapshot', value: snapshot });
    if (await offlineDb.sync_queue.filter(q => q.status !== 'SYNCED').count()) return false;
    for (const table of offlineDb.tables) if (!['sync_queue', 'settings'].includes(table.name)) await table.clear();
    await offlineDb.products.bulkPut(rows(snapshot,'products').map(p => ({
      id: str(p.id), name: str(p.name), unit: str(p.unit), current_stock: num(p.current_stock),
      average_cost: num(p.average_cost), purchase_cost: num(p.purchase_cost), sale_price: num(p.sale_price),
      minimum_stock: num(p.minimum_stock), active: Boolean(p.active), updated_at: str(p.updated_at)
    })));
    await offlineDb.sales.bulkPut(rows(snapshot,'sales').map(s => ({
      id: str(s.id), invoice_number: str(s.invoice_number), sale_date: str(s.sale_date),
      customer_name: str(s.customer_name), customer_phone: str(s.customer_phone), subtotal: num(s.subtotal),
      total: num(s.total), net_total: num(s.net_total), original_profit: num(s.original_profit),
      status: (s.status === 'CONFIRMED' ? 'COMPLETED' : s.status) as LocalSale['status'],
      notes: str(s.notes), created_at: str(s.created_at), sync_status: 'SYNCED'
    })));
    await offlineDb.sale_items.bulkPut(saleItems.map(i => ({
      id: str(i.client_id || i.id), sale_id: str(i.sale_id), product_id: str(i.product_id),
      product_name_snapshot: str(i.product_name_snapshot), unit_snapshot: str(i.unit_snapshot),
      quantity: num(i.quantity), unit_sale_price: num(i.unit_sale_price), unit_cost_snapshot: num(i.unit_cost_snapshot),
      line_total: num(i.line_total), original_profit: num(i.original_profit)
    })));
    await offlineDb.returns.bulkPut(rows(snapshot,'returns').map(r => ({
      id: str(r.id), return_number: str(r.return_number), sale_id: str(r.sale_id), invoice_number: str(r.invoice_number),
      return_date: str(r.return_date), refund_total: num(r.refund_total), profit_reversed: num(r.profit_reversed),
      reason: str(r.reason), created_at: str(r.created_at), sync_status: 'SYNCED'
    })));
    await offlineDb.return_items.bulkPut(rows(snapshot,'return_items').map(i => {
      const original = saleItems.find(si => str(si.id) === str(i.sale_item_id));
      return {
        id: str(i.client_id || i.id), return_id: str(i.return_id), sale_item_id: itemIds.get(str(i.sale_item_id)) || str(i.sale_item_id),
        product_id: str(i.product_id), quantity_returned: num(i.quantity_returned),
        unit_sale_price_snapshot: num(i.unit_sale_price_snapshot), unit_cost_snapshot: num(i.unit_cost_snapshot),
        refund_amount: num(i.refund_amount), profit_reversed: num(i.profit_reversed), restock: i.restock !== false,
        product_name_snapshot: str(original?.product_name_snapshot), unit_snapshot: str(original?.unit_snapshot)
      };
    }));
    await offlineDb.stock_entries.bulkPut(rows(snapshot,'stock_entries').map(s => ({ id: str(s.id), entry_number: str(s.reference_number), entry_date: str(s.entry_date), movement_type: 'PURCHASE', total_amount: num(s.total_cost), notes: str(s.notes), created_at: str(s.created_at), sync_status: 'SYNCED' })));
    await offlineDb.stock_entry_items.bulkPut(rows(snapshot,'stock_entry_items').map(i => ({ id: str(i.id), entry_id: str(i.stock_entry_id), product_id: str(i.product_id), quantity: num(i.quantity), purchase_cost: num(i.unit_cost), line_total: num(i.line_cost) })));
    await offlineDb.inventory_movements.bulkPut(rows(snapshot,'inventory_movements').map(m => ({
      id: str(m.id), product_id: str(m.product_id), movement_type: m.movement_type as 'STOCK_IN',
      quantity_delta: num(m.quantity_delta), unit_cost_snapshot: num(m.unit_cost_snapshot),
      reference_type: str(m.reference_type), reference_id: str(m.reference_id), notes: str(m.notes), created_at: str(m.created_at)
    })));
    await offlineDb.settings.delete('maintenance');
    await offlineDb.settings.bulkPut([
      { key: 'owner_id', value: owner }, { key: 'cloud_loans', value: snapshot.loans },
      { key: 'cloud_loan_settlements', value: snapshot.loan_settlements },
      { key: 'cloud_settings', value: rows(snapshot, 'business_settings')[0] || null },
      { key: 'cloud_snapshot', value: snapshot }, { key: 'last_sync', value: new Date().toISOString() }
    ]);
    return true;
  });
}

export class SyncEngine {
  private listeners = new Set<SyncListener>();
  private isSyncing = false;
  private isOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
  private pendingCount = 0;
  private lastSyncTime: string | null = null;
  private lastError: string | null = null;
  private active: Promise<void> | null = null;
  constructor(private readonly clientFactory = getSupabase) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.isOnline = true; void this.sync(); });
      window.addEventListener('offline', () => { this.isOnline = false; this.notify(); });
      setInterval(() => { if (navigator.onLine) void this.sync(); }, 20_000);
      void this.updatePendingCount();
    }
  }
  subscribe(listener: SyncListener) { this.listeners.add(listener); listener(this.getState()); return () => { this.listeners.delete(listener); }; }
  getState(): SyncStatusState { return { isOnline: this.isOnline, isSyncing: this.isSyncing, pendingCount: this.pendingCount, lastSyncTime: this.lastSyncTime, lastError: this.lastError }; }
  private notify() { for (const listener of this.listeners) listener(this.getState()); }
  async updatePendingCount() {
    this.pendingCount = await offlineDb.sync_queue.filter(q => q.status !== 'SYNCED').count();
    this.notify(); return this.pendingCount;
  }
  async checkActualConnection() {
    const client = this.clientFactory();
    if (!client || (typeof navigator !== 'undefined' && navigator.onLine === false)) return false;
    const { data, error } = await client.auth.getSession();
    return !error && Boolean(data.session);
  }
  sync(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.withLock().finally(() => { this.active = null; });
    return this.active;
  }
  private async withLock() {
    if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request('aziz-cloud-sync', () => this.run());
    else await this.run();
  }
  private async run() {
    this.isSyncing = true; this.lastError = null; this.notify();
    try {
      const client = this.clientFactory();
      if (!client) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { this.isOnline = false; return; }
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (!data.session) throw new Error('Sign in online to synchronize. Your local records are retained.');
      const owner = data.session.user.id;
      const bound = await offlineDb.settings.get('owner_id');
      if (bound && bound.value !== owner) throw new Error('Sign in with the account assigned to this local database.');
      const { data: admin, error: adminError } = await client.rpc('is_shop_admin');
      if (adminError) throw adminError;
      if (!admin) throw new Error('Shop administrator access required.');
      await offlineDb.settings.put({ key: 'owner_id', value: owner });
      this.isOnline = true;
      const queue = (await offlineDb.sync_queue.filter(q => q.status !== 'SYNCED').toArray()).sort((a,b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.created_at.localeCompare(b.created_at));
      for (const item of queue) {
        if (item.payload.protocol !== 2) throw new Error('Old unsynchronized records need reconciliation. Export a backup before proceeding; nothing was discarded.');
        await this.processQueueItem(item);
      }
      await this.pullCloudState(owner);
    } catch (error) {
      this.lastError = message(error);
      if (/fetch|network|offline/i.test(this.lastError)) this.isOnline = false;
    } finally { this.isSyncing = false; await this.updatePendingCount(); this.notify(); }
  }
  private async processQueueItem(item: LocalSyncQueueItem) {
    const client = this.clientFactory();
    if (!client) throw new Error('Cloud connection is not configured.');
    await offlineDb.sync_queue.update(item.id, { status: 'SYNCING', attempt_count: item.attempt_count + 1, last_attempt_at: new Date().toISOString() });
    const { error } = await client.rpc('sync_shop_operation', { p_operation_id: item.operation_id, p_type: item.operation_type, p_payload: item.payload });
    if (error) {
      await offlineDb.sync_queue.update(item.id, { status: error.message.includes('CONFLICT:') ? 'CONFLICT' : 'FAILED', last_error: error.message });
      // Keep a complete cloud snapshot for conflict review without replacing pending local work.
      await this.pullCloudState().catch(() => {});
      throw error;
    }
    await offlineDb.sync_queue.update(item.id, { status: 'SYNCED', last_error: null });
  }
  async pullCloudState(expectedOwner?: string) {
    const client = this.clientFactory();
    if (!client) throw new Error('Cloud connection is not configured.');
    const { data: auth } = await client.auth.getSession();
    const owner = expectedOwner || auth.session?.user.id;
    if (!owner) throw new Error('Sign in before downloading cloud records.');
    const { data, error } = await client.rpc('shop_snapshot');
    if (error) throw error;
    if (await applyCloudSnapshot(data as CloudSnapshot, owner)) {
      this.lastSyncTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('aziz-data-changed'));
    }
  }
  async clearLocalDatabase() {
    await offlineDb.transaction('rw', offlineDb.tables, async () => {
      if (await offlineDb.sync_queue.filter(q => q.status !== 'SYNCED').count()) throw new Error('Cannot clear local storage while unsynchronized records exist. Export a backup and resolve synchronization first.');
      for (const table of offlineDb.tables) await table.clear();
    });
    this.pendingCount = 0; this.notify();
  }
  async resetShop(confirmation: string, saveBackup: (backup: unknown) => void) {
    if (confirmation !== 'RESET AZIZ SHOP') throw new Error('Reset confirmation does not match.');
    await this.sync();
    if (this.lastError) throw new Error(this.lastError);
    const reset = async () => {
      await offlineDb.transaction('rw', offlineDb.settings, offlineDb.sync_queue, async () => {
        if (await offlineDb.sync_queue.filter(q => q.status !== 'SYNCED').count()) throw new Error('Resolve pending transactions before resetting.');
        await offlineDb.settings.put({ key: 'maintenance', value: true });
      });
      try {
        const client = this.clientFactory();
        if (!client) throw new Error('Cloud configuration is missing.');
        const { data, error } = await client.rpc('shop_snapshot');
        if (error) throw error;
        saveBackup({ ...(await exportOfflineBackup()), cloud: data });
        const result = await client.rpc('reset_shop_data', { p_confirmation: confirmation });
        if (result.error) throw result.error;
        await this.clearLocalDatabase();
      } finally { await offlineDb.settings.delete('maintenance'); }
    };
    if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request('aziz-cloud-sync', reset);
    else await reset();
  }
}
export const syncEngine = new SyncEngine();
