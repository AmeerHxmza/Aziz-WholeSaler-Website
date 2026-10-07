import Dexie, { type Table } from 'dexie';

export interface LocalProduct {
  id: string;
  name: string;
  unit: string;
  current_stock: number;
  average_cost: number;
  purchase_cost: number;
  sale_price: number;
  minimum_stock: number;
  active: boolean;
  updated_at: string;
}

export interface LocalSale {
  id: string;
  invoice_number: string;
  sale_date: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  subtotal: number;
  total: number;
  net_total: number;
  original_profit: number;
  status: 'COMPLETED' | 'PARTIALLY_RETURNED' | 'FULLY_RETURNED' | 'VOIDED';
  notes?: string | null;
  created_at: string;
  sync_status: 'PENDING' | 'SYNCED' | 'FAILED';
}

export interface LocalSaleItem {
  id: string;
  sale_id: string;
  product_id: string;
  product_name_snapshot: string;
  unit_snapshot: string;
  quantity: number;
  unit_sale_price: number;
  unit_cost_snapshot: number;
  line_total: number;
  original_profit: number;
}

export interface LocalReturn {
  id: string;
  return_number: string;
  sale_id: string;
  invoice_number: string;
  return_date: string;
  refund_total: number;
  profit_reversed: number;
  reason?: string | null;
  created_at: string;
  sync_status: 'PENDING' | 'SYNCED' | 'FAILED';
}

export interface LocalReturnItem {
  id: string;
  return_id: string;
  sale_item_id: string;
  product_id: string;
  quantity_returned: number;
  unit_sale_price_snapshot: number;
  unit_cost_snapshot: number;
  refund_amount: number;
  profit_reversed: number;
}

export interface LocalStockEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  movement_type: 'PURCHASE' | 'OPENING';
  total_amount: number;
  notes?: string | null;
  created_at: string;
  sync_status: 'PENDING' | 'SYNCED' | 'FAILED';
}

export interface LocalStockEntryItem {
  id: string;
  entry_id: string;
  product_id: string;
  quantity: number;
  purchase_cost: number;
  line_total: number;
}

export interface LocalInventoryMovement {
  id: string;
  product_id: string;
  movement_type: 'OPENING_STOCK' | 'STOCK_IN' | 'SALE_OUT' | 'SALE_RETURN_IN' | 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT';
  quantity_delta: number;
  unit_cost_snapshot: number;
  reference_type: string;
  reference_id: string;
  notes?: string | null;
  created_at: string;
}

export interface LocalSyncQueueItem {
  id: string;
  operation_id: string;
  operation_type: 'CREATE_SALE' | 'CREATE_RETURN' | 'RECORD_STOCK' | 'CREATE_PRODUCT' | 'UPDATE_PRODUCT';
  entity_id: string;
  payload: any;
  status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'CONFLICT';
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface LocalSetting {
  key: string;
  value: any;
}

export class AzizOfflineDatabase extends Dexie {
  products!: Table<LocalProduct, string>;
  sales!: Table<LocalSale, string>;
  sale_items!: Table<LocalSaleItem, string>;
  returns!: Table<LocalReturn, string>;
  return_items!: Table<LocalReturnItem, string>;
  stock_entries!: Table<LocalStockEntry, string>;
  stock_entry_items!: Table<LocalStockEntryItem, string>;
  inventory_movements!: Table<LocalInventoryMovement, string>;
  sync_queue!: Table<LocalSyncQueueItem, string>;
  settings!: Table<LocalSetting, string>;

  constructor() {
    super('AzizWholesaleOfflineDB');
    this.version(1).stores({
      products: 'id, name, active, updated_at',
      sales: 'id, invoice_number, sale_date, status, sync_status, created_at',
      sale_items: 'id, sale_id, product_id',
      returns: 'id, return_number, sale_id, sync_status, created_at',
      return_items: 'id, return_id, sale_item_id, product_id',
      stock_entries: 'id, entry_number, entry_date, sync_status',
      stock_entry_items: 'id, entry_id, product_id',
      inventory_movements: 'id, product_id, reference_type, reference_id, created_at',
      sync_queue: 'id, operation_id, operation_type, entity_id, status, created_at',
      settings: 'key'
    });
  }
}

// Singleton offline DB instance
export const offlineDb = new AzizOfflineDatabase();
