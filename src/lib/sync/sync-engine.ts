import { offlineDb, type LocalSyncQueueItem } from '../db/offline-db';
import { setSequenceFloor } from '../db/offline-operations';
import { getSupabase } from '../supabase';

export interface SyncStatusState {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncTime: string | null;
  lastError: string | null;
}

type SyncListener = (state: SyncStatusState) => void;

class SyncEngine {
  private listeners: Set<SyncListener> = new Set();
  private isSyncing = false;
  private isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private pendingCount = 0;
  private lastSyncTime: string | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.notify();
        void this.sync();
      });
      window.addEventListener('offline', () => {
        this.isOnline = false;
        this.notify();
      });

      // Update pending count on boot
      void this.updatePendingCount();

      // Periodic check every 20 seconds
      this.timer = setInterval(() => {
        if (this.isOnline && !this.isSyncing) {
          void this.sync();
        }
      }, 20000);
    }
  }

  public subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  public getState(): SyncStatusState {
    return {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingCount: this.pendingCount,
      lastSyncTime: this.lastSyncTime,
      lastError: this.lastError
    };
  }

  private notify() {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }

  public async updatePendingCount(): Promise<number> {
    try {
      this.pendingCount = await offlineDb.sync_queue
        .where('status')
        .equals('PENDING')
        .count();
      this.notify();
      return this.pendingCount;
    } catch {
      return 0;
    }
  }

  // Real connectivity ping (not just navigator.onLine)
  public async checkActualConnection(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return false;
    }
    const supabase = getSupabase();
    if (!supabase) return false;
    try {
      // Lightweight call with 2 second timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const { error } = await supabase.from('products').select('id').limit(1).abortSignal(controller.signal);
      clearTimeout(timeout);
      return !error;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // MAIN SYNC WORKFLOW
  // ---------------------------------------------------------------------------
  public async sync(): Promise<void> {
    if (this.isSyncing) return;
    const supabase = getSupabase();
    if (!supabase) return;

    const reachable = await this.checkActualConnection();
    if (!reachable) {
      this.isOnline = false;
      this.notify();
      return;
    }

    this.isOnline = true;
    this.isSyncing = true;
    this.lastError = null;
    this.notify();

    try {
      // 1. Process outbound pending operations in chronological order
      const pendingItems = await offlineDb.sync_queue
        .where('status')
        .equals('PENDING')
        .sortBy('created_at');

      for (const item of pendingItems) {
        await this.processQueueItem(item);
      }

      // 2. Download authoritative cloud state to keep local mirror current
      await this.pullCloudState();

      this.lastSyncTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (err: any) {
      this.lastError = err?.message || 'Sync encountered an error';
    } finally {
      this.isSyncing = false;
      await this.updatePendingCount();
      this.notify();
    }
  }

  private async processQueueItem(item: LocalSyncQueueItem): Promise<void> {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      await offlineDb.sync_queue.update(item.id, { status: 'SYNCING' });

      switch (item.operation_type) {
        case 'CREATE_SALE': {
          const payload = item.payload;
          const { error } = await supabase.rpc('create_sale', {
            p_date: payload.sale_date,
            p_items: payload.items,
            p_customer_name: payload.customer_name,
            p_customer_phone: payload.customer_phone,
            p_notes: payload.notes
          });
          if (error && !error.message.includes('duplicate')) throw error;

          await offlineDb.sales.update(item.entity_id, { sync_status: 'SYNCED' });
          break;
        }

        case 'CREATE_RETURN': {
          const payload = item.payload;
          const { error } = await supabase.rpc('create_return', {
            p_sale_id: payload.sale_id,
            p_date: payload.date,
            p_items: payload.items,
            p_reason: payload.reason
          });
          if (error && !error.message.includes('duplicate')) throw error;

          await offlineDb.returns.update(item.entity_id, { sync_status: 'SYNCED' });
          break;
        }

        case 'RECORD_STOCK': {
          const payload = item.payload;
          const { error } = await supabase.rpc('record_stock', {
            p_product_id: payload.productId,
            p_quantity: payload.quantity,
            p_purchase_cost: payload.purchaseCost,
            p_date: payload.date,
            p_movement_type: payload.movementType,
            p_reference: null,
            p_notes: payload.notes
          });
          if (error && !error.message.includes('duplicate')) throw error;

          await offlineDb.stock_entries.update(item.entity_id, { sync_status: 'SYNCED' });
          break;
        }

        case 'CREATE_PRODUCT': {
          const payload = item.payload;
          const { error } = await supabase.rpc('create_product', {
            p_name: payload.name,
            p_unit: payload.unit,
            p_purchase_cost: payload.purchaseCost,
            p_sale_price: payload.salePrice,
            p_minimum_stock: payload.minimumStock,
            p_opening_stock: payload.openingStock,
            p_id: payload.id
          });
          if (error && !error.message.includes('duplicate')) throw error;
          break;
        }

        case 'UPDATE_PRODUCT': {
          const payload = item.payload;
          const { error } = await supabase.rpc('update_product', {
            p_product_id: payload.id,
            p_name: payload.name,
            p_unit: payload.unit,
            p_purchase_cost: payload.purchaseCost,
            p_sale_price: payload.salePrice,
            p_minimum_stock: payload.minimumStock,
            p_active: payload.active
          });
          if (error) throw error;
          break;
        }
      }

      await offlineDb.sync_queue.update(item.id, {
        status: 'SYNCED',
        last_attempt_at: new Date().toISOString(),
        last_error: null
      });
    } catch (err: any) {
      await offlineDb.sync_queue.update(item.id, {
        status: 'FAILED',
        attempt_count: item.attempt_count + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: err?.message || 'Sync failed'
      });
    }
  }

  // Wipe local IndexedDB offline tables completely
  public async clearLocalDatabase(): Promise<void> {
    await offlineDb.transaction('rw', [
      offlineDb.products,
      offlineDb.sales,
      offlineDb.sale_items,
      offlineDb.returns,
      offlineDb.return_items,
      offlineDb.stock_entries,
      offlineDb.stock_entry_items,
      offlineDb.inventory_movements,
      offlineDb.sync_queue,
      offlineDb.settings
    ], async () => {
      await Promise.all([
        offlineDb.products.clear(),
        offlineDb.sales.clear(),
        offlineDb.sale_items.clear(),
        offlineDb.returns.clear(),
        offlineDb.return_items.clear(),
        offlineDb.stock_entries.clear(),
        offlineDb.stock_entry_items.clear(),
        offlineDb.inventory_movements.clear(),
        offlineDb.sync_queue.clear(),
        offlineDb.settings.clear()
      ]);
    });
    this.pendingCount = 0;
    this.notify();
  }

  // Pull latest cloud state to IndexedDB and adjust invoice numbering floors
  public async pullCloudState(): Promise<void> {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Fetch Cloud Products
      const { data: cloudProducts, error: prodErr } = await supabase
        .from('products')
        .select('*');

      if (!prodErr && Array.isArray(cloudProducts)) {
        const cloudProductIds = new Set(cloudProducts.map((p) => p.id));

        // Keep local offline products that have pending creation queued
        const pendingProductOps = await offlineDb.sync_queue
          .where('operation_type')
          .equals('CREATE_PRODUCT')
          .toArray();
        const pendingProductIds = new Set(pendingProductOps.map((op) => op.entity_id));

        // Delete any local product that was deleted/reset in cloud and is NOT pending upload
        const localProducts = await offlineDb.products.toArray();
        for (const lp of localProducts) {
          if (!cloudProductIds.has(lp.id) && !pendingProductIds.has(lp.id)) {
            await offlineDb.products.delete(lp.id);
          }
        }

        // Upsert all authoritative cloud products
        for (const cp of cloudProducts) {
          await offlineDb.products.put({
            id: cp.id,
            name: cp.name,
            unit: cp.unit,
            current_stock: Number(cp.current_stock ?? cp.stock ?? 0),
            average_cost: Number(cp.average_cost ?? cp.purchase_cost ?? 0),
            purchase_cost: Number(cp.purchase_cost ?? 0),
            sale_price: Number(cp.sale_price ?? cp.default_sale_price ?? 0),
            minimum_stock: Number(cp.minimum_stock ?? cp.low_stock_threshold ?? 10),
            active: cp.active ?? cp.is_active ?? true,
            updated_at: cp.updated_at || new Date().toISOString()
          });
        }
      }

      // 2. Fetch Cloud Sales and Sale Items
      const { data: cloudSales, error: salesErr } = await supabase
        .from('sales')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);

      if (!salesErr && Array.isArray(cloudSales)) {
        const cloudSaleIds = new Set(cloudSales.map((s) => s.id));

        // Any local sale marked SYNCED that is NOT in cloud must be removed (e.g. database was reset)
        const localSales = await offlineDb.sales.toArray();
        for (const ls of localSales) {
          if (ls.sync_status === 'SYNCED' && !cloudSaleIds.has(ls.id)) {
            await offlineDb.sales.delete(ls.id);
            await offlineDb.sale_items.where('sale_id').equals(ls.id).delete();
          }
        }

        if (cloudSales.length > 0) {
          const { data: cloudSaleItems } = await supabase
            .from('sale_items')
            .select('*')
            .in('sale_id', Array.from(cloudSaleIds));

          // Put sales into IndexedDB (preserving any local PENDING sales)
          for (const cs of cloudSales) {
            const existing = await offlineDb.sales.get(cs.id);
            if (!existing || existing.sync_status !== 'PENDING') {
              await offlineDb.sales.put({
                id: cs.id,
                invoice_number: cs.invoice_number,
                sale_date: cs.sale_date,
                customer_name: cs.customer_name || null,
                customer_phone: cs.customer_phone || null,
                subtotal: Number(cs.subtotal),
                total: Number(cs.total),
                net_total: Number(cs.net_total),
                original_profit: Number(cs.original_profit || 0),
                status: cs.status,
                notes: cs.notes || null,
                created_at: cs.created_at,
                sync_status: 'SYNCED'
              });
            }
          }

          // Put sale_items into IndexedDB
          if (cloudSaleItems) {
            for (const csi of cloudSaleItems) {
              await offlineDb.sale_items.put({
                id: String(csi.id),
                sale_id: csi.sale_id,
                product_id: csi.product_id,
                product_name_snapshot: csi.product_name_snapshot,
                unit_snapshot: csi.unit_snapshot,
                quantity: Number(csi.quantity),
                unit_sale_price: Number(csi.unit_price ?? csi.unit_sale_price ?? 0),
                unit_cost_snapshot: Number(csi.purchase_cost_snapshot ?? csi.unit_cost_snapshot ?? 0),
                line_total: Number(csi.line_total),
                original_profit: Number(csi.original_profit ?? (csi.line_total - (csi.cost_total_snapshot || ((csi.purchase_cost_snapshot || csi.unit_cost_snapshot || 0) * csi.quantity) || 0)))
              });
            }
          }

          let maxSeq = 0;
          for (const s of cloudSales) {
            const match = s.invoice_number?.match(/\d+/);
            if (match) {
              const num = parseInt(match[0], 10);
              if (num > maxSeq) maxSeq = num;
            }
          }
          if (maxSeq > 0) {
            await setSequenceFloor('sale', maxSeq);
          }
        } else {
          // Cloud sales is empty - reset sequence floor
          await offlineDb.settings.put({ key: 'seq_sale', value: 0 });
        }
      }

      // 3. Fetch Cloud Returns and Return Items
      const { data: cloudReturns, error: returnsErr } = await supabase
        .from('returns')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (!returnsErr && Array.isArray(cloudReturns)) {
        const cloudReturnIds = new Set(cloudReturns.map((r) => r.id));

        // Any local return marked SYNCED not in cloud must be removed
        const localReturns = await offlineDb.returns.toArray();
        for (const lr of localReturns) {
          if (lr.sync_status === 'SYNCED' && !cloudReturnIds.has(lr.id)) {
            await offlineDb.returns.delete(lr.id);
            await offlineDb.return_items.where('return_id').equals(lr.id).delete();
          }
        }

        if (cloudReturns.length > 0) {
          const { data: cloudReturnItems } = await supabase
            .from('return_items')
            .select('*')
            .in('return_id', Array.from(cloudReturnIds));

          for (const cr of cloudReturns) {
            const existing = await offlineDb.returns.get(cr.id);
            if (!existing || existing.sync_status !== 'PENDING') {
              await offlineDb.returns.put({
                id: cr.id,
                return_number: cr.return_number,
                sale_id: cr.sale_id,
                invoice_number: cr.invoice_number || '',
                return_date: cr.return_date,
                refund_total: Number(cr.refund_amount ?? cr.refund_total ?? 0),
                profit_reversed: Number(cr.profit_reversed ?? 0),
                reason: cr.reason,
                created_at: cr.created_at,
                sync_status: 'SYNCED'
              });
            }
          }

          if (cloudReturnItems) {
            for (const cri of cloudReturnItems) {
              await offlineDb.return_items.put({
                id: String(cri.id),
                return_id: cri.return_id,
                sale_item_id: cri.sale_item_id || '',
                product_id: cri.product_id,
                quantity_returned: Number(cri.quantity_returned ?? cri.quantity ?? 0),
                unit_sale_price_snapshot: Number(cri.unit_price_snapshot ?? cri.unit_sale_price ?? 0),
                unit_cost_snapshot: Number(cri.unit_cost_snapshot ?? 0),
                refund_amount: Number(cri.refund_amount ?? 0),
                profit_reversed: Number(cri.profit_reversed ?? 0)
              });
            }
          }

          let maxRetSeq = 0;
          for (const r of cloudReturns) {
            const match = r.return_number?.match(/\d+/);
            if (match) {
              const num = parseInt(match[0], 10);
              if (num > maxRetSeq) maxRetSeq = num;
            }
          }
          if (maxRetSeq > 0) {
            await setSequenceFloor('return', maxRetSeq);
          }
        } else {
          await offlineDb.settings.put({ key: 'seq_return', value: 0 });
        }
      }

      // 4. Fetch Cloud Loans
      const { data: cloudLoans, error: loansErr } = await supabase
        .from('loans')
        .select('*')
        .order('created_at', { ascending: false });
      if (!loansErr && Array.isArray(cloudLoans)) {
        await offlineDb.settings.put({
          key: 'cloud_loans',
          value: cloudLoans.map((loan) => ({
            ...loan,
            amount: Number(loan.amount),
            paid_amount: Number(loan.paid_amount),
            remaining_amount: Number(loan.remaining_amount)
          }))
        });
      }

      // 5. Fetch Business Settings
      const { data: cloudSettings, error: settingsErr } = await supabase
        .from('business_settings')
        .select('*')
        .maybeSingle();
      if (!settingsErr) {
        await offlineDb.settings.put({
          key: 'cloud_settings',
          value: {
            business_name: cloudSettings?.business_name || 'Aziz & Son Wholesaler',
            address: cloudSettings?.address || '',
            phone1: cloudSettings?.phone1 || '',
            phone2: cloudSettings?.phone2 || '',
            receipt_footer: cloudSettings?.receipt_footer || 'Thank you for your business!'
          }
        });
      }
    } catch {
      // Non-fatal pull error
    }
  }
}

export const syncEngine = new SyncEngine();
