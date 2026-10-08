import {
  offlineDb,
  type LocalProduct,
  type LocalSale,
  type LocalSaleItem,
  type LocalReturn,
  type LocalReturnItem,
  type LocalStockEntry,
  type LocalInventoryMovement,
  type LocalSyncQueueItem
} from './offline-db';
import { roundMoney, lineAmount } from '../calculations';

function todayString(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Generate human-readable sequential counters (e.g. AS-000001, RT-000001)
async function getNextSequence(key: 'sale' | 'return' | 'stock'): Promise<string> {
  const settingKey = `seq_${key}`;
  const record = await offlineDb.settings.get(settingKey);
  const current = (record?.value as number) || 0;
  const next = current + 1;
  await offlineDb.settings.put({ key: settingKey, value: next });

  const prefix = key === 'sale' ? 'AS' : key === 'return' ? 'RT' : 'SE';
  return `${prefix}-${String(next).padStart(6, '0')}`;
}

export async function setSequenceFloor(key: 'sale' | 'return' | 'stock', floor: number): Promise<void> {
  const settingKey = `seq_${key}`;
  const record = await offlineDb.settings.get(settingKey);
  const current = (record?.value as number) || 0;
  if (floor > current) {
    await offlineDb.settings.put({ key: settingKey, value: floor });
  }
}

// -----------------------------------------------------------------------------
// 1. CREATE OFFLINE SALE
// -----------------------------------------------------------------------------
export async function createOfflineSale(params: {
  items: Array<{ productId: string; quantity: number; unitPrice?: number }>;
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
}): Promise<{ sale: LocalSale; items: LocalSaleItem[] }> {
  return await offlineDb.transaction(
    'rw',
    [
      offlineDb.products,
      offlineDb.sales,
      offlineDb.sale_items,
      offlineDb.inventory_movements,
      offlineDb.sync_queue,
      offlineDb.settings
    ],
    async () => {
      const today = todayString();
      const saleId = crypto.randomUUID();
      const invoiceNumber = await getNextSequence('sale');
      const operationId = crypto.randomUUID();

      let subtotal = 0;
      let totalProfit = 0;
      const saleItemsToInsert: LocalSaleItem[] = [];
      const movementsToInsert: LocalInventoryMovement[] = [];

      // Validate products & stock
      for (const reqItem of params.items) {
        const product = await offlineDb.products.get(reqItem.productId);
        if (!product) throw new Error(`Product not found: ${reqItem.productId}`);
        if (!product.active) throw new Error(`Product "${product.name}" is deactivated.`);
        if (reqItem.quantity > product.current_stock) {
          throw new Error(
            `Insufficient stock for "${product.name}". Available: ${product.current_stock} ${product.unit}, Requested: ${reqItem.quantity}`
          );
        }

        const unitPrice = Number(reqItem.unitPrice ?? product.sale_price);
        const lineTotal = lineAmount(reqItem.quantity, unitPrice);
        const costSnapshot = Number(product.average_cost ?? product.purchase_cost ?? 0);
        const lineProfit = roundMoney((unitPrice - costSnapshot) * reqItem.quantity);

        subtotal += lineTotal;
        totalProfit += lineProfit;

        const saleItemId = crypto.randomUUID();
        saleItemsToInsert.push({
          id: saleItemId,
          sale_id: saleId,
          product_id: product.id,
          product_name_snapshot: product.name,
          unit_snapshot: product.unit,
          quantity: reqItem.quantity,
          unit_sale_price: unitPrice,
          unit_cost_snapshot: costSnapshot,
          line_total: lineTotal,
          original_profit: lineProfit
        });

        // Decrement local product stock
        const newStock = roundMoney(product.current_stock - reqItem.quantity);
        await offlineDb.products.update(product.id, {
          current_stock: newStock,
          updated_at: new Date().toISOString()
        });

        // Record immutable inventory movement
        movementsToInsert.push({
          id: crypto.randomUUID(),
          product_id: product.id,
          movement_type: 'SALE_OUT',
          quantity_delta: -reqItem.quantity,
          unit_cost_snapshot: costSnapshot,
          reference_type: 'SALE',
          reference_id: saleId,
          notes: `Invoice ${invoiceNumber}`,
          created_at: new Date().toISOString()
        });
      }

      subtotal = roundMoney(subtotal);
      totalProfit = roundMoney(totalProfit);

      const saleRecord: LocalSale = {
        id: saleId,
        invoice_number: invoiceNumber,
        sale_date: today,
        customer_name: params.customerName || null,
        customer_phone: params.customerPhone || null,
        subtotal,
        total: subtotal,
        net_total: subtotal,
        original_profit: totalProfit,
        status: 'COMPLETED',
        notes: params.notes || null,
        created_at: new Date().toISOString(),
        sync_status: 'PENDING'
      };

      // Durable sync queue entry
      const syncItem: LocalSyncQueueItem = {
        id: crypto.randomUUID(),
        operation_id: operationId,
        operation_type: 'CREATE_SALE',
        entity_id: saleId,
        payload: {
          id: saleId,
          invoice_number: invoiceNumber,
          sale_date: today,
          customer_name: params.customerName || null,
          customer_phone: params.customerPhone || null,
          notes: params.notes || null,
          items: saleItemsToInsert.map((item) => ({
            productId: item.product_id,
            quantity: item.quantity,
            unitPrice: item.unit_sale_price
          }))
        },
        status: 'PENDING',
        attempt_count: 0,
        last_attempt_at: null,
        last_error: null,
        created_at: new Date().toISOString()
      };

      await offlineDb.sales.add(saleRecord);
      await offlineDb.sale_items.bulkAdd(saleItemsToInsert);
      await offlineDb.inventory_movements.bulkAdd(movementsToInsert);
      await offlineDb.sync_queue.add(syncItem);

      return { sale: saleRecord, items: saleItemsToInsert };
    }
  );
}

// -----------------------------------------------------------------------------
// 2. CREATE OFFLINE RETURN
// -----------------------------------------------------------------------------
export async function createOfflineReturn(params: {
  saleId: string;
  items: Array<{ productId: string; quantity: number }>;
  reason?: string | null;
}): Promise<{ returnRow: LocalReturn; items: LocalReturnItem[] }> {
  return await offlineDb.transaction(
    'rw',
    [
      offlineDb.products,
      offlineDb.sales,
      offlineDb.sale_items,
      offlineDb.returns,
      offlineDb.return_items,
      offlineDb.inventory_movements,
      offlineDb.sync_queue,
      offlineDb.settings
    ],
    async () => {
      const today = todayString();
      const returnId = crypto.randomUUID();
      const returnNumber = await getNextSequence('return');
      const operationId = crypto.randomUUID();

      const sale = await offlineDb.sales.get(params.saleId);
      if (!sale) throw new Error('Original sale bill not found in local records.');

      const saleItems = await offlineDb.sale_items.where('sale_id').equals(params.saleId).toArray();
      const existingReturns = await offlineDb.returns.where('sale_id').equals(params.saleId).toArray();
      const existingReturnItems = await offlineDb.return_items
        .where('return_id')
        .anyOf(existingReturns.map((r) => r.id))
        .toArray();

      let refundTotal = 0;
      let profitReversed = 0;
      const returnItemsToInsert: LocalReturnItem[] = [];
      const movementsToInsert: LocalInventoryMovement[] = [];

      for (const reqItem of params.items) {
        const saleItem = saleItems.find((si) => si.product_id === reqItem.productId);
        if (!saleItem) throw new Error(`Product was not part of original sale invoice ${sale.invoice_number}`);

        const alreadyReturned = existingReturnItems
          .filter((ri) => ri.sale_item_id === saleItem.id)
          .reduce((sum, ri) => sum + ri.quantity_returned, 0);

        const returnable = saleItem.quantity - alreadyReturned;
        if (reqItem.quantity > returnable) {
          throw new Error(
            `Maximum returnable quantity for ${saleItem.product_name_snapshot} is ${returnable}. Requested: ${reqItem.quantity}`
          );
        }

        const refundLine = roundMoney(reqItem.quantity * saleItem.unit_sale_price);
        const costLine = roundMoney(reqItem.quantity * saleItem.unit_cost_snapshot);
        const profitLine = roundMoney(refundLine - costLine);

        refundTotal += refundLine;
        profitReversed += profitLine;

        const returnItemId = crypto.randomUUID();
        returnItemsToInsert.push({
          id: returnItemId,
          return_id: returnId,
          sale_item_id: saleItem.id,
          product_id: reqItem.productId,
          quantity_returned: reqItem.quantity,
          unit_sale_price_snapshot: saleItem.unit_sale_price,
          unit_cost_snapshot: saleItem.unit_cost_snapshot,
          refund_amount: refundLine,
          profit_reversed: profitLine
        });

        // Restore local product stock
        const product = await offlineDb.products.get(reqItem.productId);
        if (product) {
          const newStock = roundMoney(product.current_stock + reqItem.quantity);
          await offlineDb.products.update(product.id, {
            current_stock: newStock,
            updated_at: new Date().toISOString()
          });
        }

        // Record inventory movement
        movementsToInsert.push({
          id: crypto.randomUUID(),
          product_id: reqItem.productId,
          movement_type: 'SALE_RETURN_IN',
          quantity_delta: reqItem.quantity,
          unit_cost_snapshot: saleItem.unit_cost_snapshot,
          reference_type: 'RETURN',
          reference_id: returnId,
          notes: `Return ${returnNumber} for Invoice ${sale.invoice_number}`,
          created_at: new Date().toISOString()
        });
      }

      refundTotal = roundMoney(refundTotal);
      profitReversed = roundMoney(profitReversed);

      const returnRecord: LocalReturn = {
        id: returnId,
        return_number: returnNumber,
        sale_id: sale.id,
        invoice_number: sale.invoice_number,
        return_date: today,
        refund_total: refundTotal,
        profit_reversed: profitReversed,
        reason: params.reason || null,
        created_at: new Date().toISOString(),
        sync_status: 'PENDING'
      };

      // Update sale status
      const totalRefundedOnSale = existingReturns.reduce((sum, r) => sum + r.refund_total, 0) + refundTotal;
      const newStatus = totalRefundedOnSale >= sale.total ? 'FULLY_RETURNED' : 'PARTIALLY_RETURNED';
      const newNetTotal = roundMoney(sale.total - totalRefundedOnSale);

      await offlineDb.sales.update(sale.id, {
        status: newStatus,
        net_total: newNetTotal
      });

      // Enqueue sync operation
      const syncItem: LocalSyncQueueItem = {
        id: crypto.randomUUID(),
        operation_id: operationId,
        operation_type: 'CREATE_RETURN',
        entity_id: returnId,
        payload: {
          id: returnId,
          sale_id: sale.id,
          return_number: returnNumber,
          date: today,
          reason: params.reason || null,
          items: params.items.map((i) => ({ productId: i.productId, quantity: i.quantity }))
        },
        status: 'PENDING',
        attempt_count: 0,
        last_attempt_at: null,
        last_error: null,
        created_at: new Date().toISOString()
      };

      await offlineDb.returns.add(returnRecord);
      await offlineDb.return_items.bulkAdd(returnItemsToInsert);
      await offlineDb.inventory_movements.bulkAdd(movementsToInsert);
      await offlineDb.sync_queue.add(syncItem);

      return { returnRow: returnRecord, items: returnItemsToInsert };
    }
  );
}

// -----------------------------------------------------------------------------
// 3. RECORD OFFLINE STOCK (PURCHASE / RESTOCK)
// -----------------------------------------------------------------------------
export async function recordOfflineStock(params: {
  productId: string;
  quantity: number;
  purchaseCost: number;
  movementType?: 'PURCHASE' | 'OPENING';
  date?: string;
  notes?: string | null;
}): Promise<LocalStockEntry> {
  return await offlineDb.transaction(
    'rw',
    [
      offlineDb.products,
      offlineDb.stock_entries,
      offlineDb.stock_entry_items,
      offlineDb.inventory_movements,
      offlineDb.sync_queue,
      offlineDb.settings
    ],
    async () => {
      const today = params.date || todayString();
      const product = await offlineDb.products.get(params.productId);
      if (!product) throw new Error('Product not found in local catalog.');

      const entryId = crypto.randomUUID();
      const entryNumber = await getNextSequence('stock');
      const operationId = crypto.randomUUID();
      const totalAmount = roundMoney(params.quantity * params.purchaseCost);

      // Weighted average calculation
      const currentStock = Number(product.current_stock || 0);
      const currentAvg = Number(product.average_cost || product.purchase_cost || 0);
      const newStock = roundMoney(currentStock + params.quantity);
      const newAverage =
        newStock > 0
          ? roundMoney((currentStock * currentAvg + params.quantity * params.purchaseCost) / newStock)
          : params.purchaseCost;

      // Update product stock and costs
      await offlineDb.products.update(product.id, {
        current_stock: newStock,
        average_cost: newAverage,
        purchase_cost: params.purchaseCost,
        updated_at: new Date().toISOString()
      });

      const entryRecord: LocalStockEntry = {
        id: entryId,
        entry_number: entryNumber,
        entry_date: today,
        movement_type: params.movementType || 'PURCHASE',
        total_amount: totalAmount,
        notes: params.notes || null,
        created_at: new Date().toISOString(),
        sync_status: 'PENDING'
      };

      const movement: LocalInventoryMovement = {
        id: crypto.randomUUID(),
        product_id: product.id,
        movement_type: params.movementType === 'OPENING' ? 'OPENING_STOCK' : 'STOCK_IN',
        quantity_delta: params.quantity,
        unit_cost_snapshot: params.purchaseCost,
        reference_type: 'STOCK_ENTRY',
        reference_id: entryId,
        notes: params.notes || `Stock entry ${entryNumber}`,
        created_at: new Date().toISOString()
      };

      const syncItem: LocalSyncQueueItem = {
        id: crypto.randomUUID(),
        operation_id: operationId,
        operation_type: 'RECORD_STOCK',
        entity_id: entryId,
        payload: {
          id: entryId,
          productId: product.id,
          quantity: params.quantity,
          purchaseCost: params.purchaseCost,
          date: today,
          movementType: params.movementType || 'PURCHASE',
          notes: params.notes || null
        },
        status: 'PENDING',
        attempt_count: 0,
        last_attempt_at: null,
        last_error: null,
        created_at: new Date().toISOString()
      };

      await offlineDb.stock_entries.add(entryRecord);
      await offlineDb.stock_entry_items.add({
        id: crypto.randomUUID(),
        entry_id: entryId,
        product_id: product.id,
        quantity: params.quantity,
        purchase_cost: params.purchaseCost,
        line_total: totalAmount
      });
      await offlineDb.inventory_movements.add(movement);
      await offlineDb.sync_queue.add(syncItem);

      return entryRecord;
    }
  );
}

// -----------------------------------------------------------------------------
// 4. CREATE / UPDATE OFFLINE PRODUCT (WITH AUTOMATIC DEDUPLICATION)
// -----------------------------------------------------------------------------
export async function deduplicateLocalProducts(): Promise<void> {
  const allProducts = await offlineDb.products.toArray();
  const byName = new Map<string, LocalProduct[]>();

  for (const p of allProducts) {
    const key = p.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(p);
  }

  for (const [, group] of byName) {
    if (group.length > 1) {
      // Sort: highest stock first, then latest updated
      group.sort((a, b) => (b.current_stock - a.current_stock) || b.updated_at.localeCompare(a.updated_at));
      const keeper = group[0];
      const duplicates = group.slice(1);

      let mergedStock = keeper.current_stock;
      for (const dup of duplicates) {
        if (dup.current_stock > 0) {
          mergedStock += dup.current_stock;
        }
        await offlineDb.products.delete(dup.id);
        await offlineDb.sale_items.where('product_id').equals(dup.id).modify({ product_id: keeper.id });
        await offlineDb.return_items.where('product_id').equals(dup.id).modify({ product_id: keeper.id });
        await offlineDb.stock_entry_items.where('product_id').equals(dup.id).modify({ product_id: keeper.id });
        await offlineDb.inventory_movements.where('product_id').equals(dup.id).modify({ product_id: keeper.id });
      }

      if (mergedStock !== keeper.current_stock) {
        await offlineDb.products.update(keeper.id, {
          current_stock: mergedStock,
          updated_at: new Date().toISOString()
        });
      }
    }
  }
}

export async function saveOfflineProduct(params: {
  id?: string;
  name: string;
  unit: string;
  purchaseCost?: number;
  purchase_cost?: number;
  salePrice?: number;
  sale_price?: number;
  minimumStock?: number;
  minimum_stock?: number;
  openingStock?: number;
  opening_stock?: number;
  active?: boolean;
}): Promise<LocalProduct> {
  return await offlineDb.transaction(
    'rw',
    [
      offlineDb.products,
      offlineDb.inventory_movements,
      offlineDb.sync_queue
    ],
    async () => {
      const normalizedName = params.name.trim().toLowerCase();
      const operationId = crypto.randomUUID();
      const openingStock = Number(params.openingStock ?? params.opening_stock ?? 0);
      const purchaseCost = Number(params.purchaseCost ?? params.purchase_cost ?? 0);
      const salePrice = Number(params.salePrice ?? params.sale_price ?? 0);
      const minimumStock = Number(params.minimumStock ?? params.minimum_stock ?? 10);

      // 1. Check if editing by ID or if a product with the same name already exists
      let existing: LocalProduct | undefined;
      if (params.id) {
        existing = await offlineDb.products.get(params.id);
      } else {
        const allProducts = await offlineDb.products.toArray();
        existing = allProducts.find((p) => p.name.trim().toLowerCase() === normalizedName);
      }

      let product: LocalProduct;

      if (existing) {
        // Product already exists: update details and add any opening stock entered
        const currentStock = Number(existing.current_stock || 0);
        const currentAvg = Number(existing.average_cost || existing.purchase_cost || 0);
        const newStock = roundMoney(currentStock + openingStock);
        const newAverage =
          newStock > 0 && openingStock > 0
            ? roundMoney((currentStock * currentAvg + openingStock * purchaseCost) / newStock)
            : (existing.average_cost || purchaseCost);

        product = {
          ...existing,
          name: params.name.trim(),
          unit: params.unit.trim(),
          current_stock: newStock,
          average_cost: newAverage,
          purchase_cost: purchaseCost,
          sale_price: salePrice,
          minimum_stock: minimumStock,
          active: params.active ?? existing.active,
          updated_at: new Date().toISOString()
        };
        await offlineDb.products.put(product);

        if (openingStock > 0) {
          await offlineDb.inventory_movements.add({
            id: crypto.randomUUID(),
            product_id: product.id,
            movement_type: 'STOCK_IN',
            quantity_delta: openingStock,
            unit_cost_snapshot: purchaseCost,
            reference_type: 'STOCK_ENTRY',
            reference_id: product.id,
            notes: 'Stock added to existing product',
            created_at: new Date().toISOString()
          });
        }

        await offlineDb.sync_queue.add({
          id: crypto.randomUUID(),
          operation_id: operationId,
          operation_type: 'UPDATE_PRODUCT',
          entity_id: product.id,
          payload: {
            id: product.id,
            name: product.name,
            unit: product.unit,
            purchaseCost: product.purchase_cost,
            salePrice: product.sale_price,
            minimumStock: product.minimum_stock,
            active: product.active
          },
          status: 'PENDING',
          attempt_count: 0,
          last_attempt_at: null,
          last_error: null,
          created_at: new Date().toISOString()
        });
      } else {
        // Brand new product
        const productId = params.id || crypto.randomUUID();
        product = {
          id: productId,
          name: params.name.trim(),
          unit: params.unit.trim(),
          current_stock: openingStock,
          average_cost: purchaseCost,
          purchase_cost: purchaseCost,
          sale_price: salePrice,
          minimum_stock: minimumStock,
          active: true,
          updated_at: new Date().toISOString()
        };
        await offlineDb.products.add(product);

        if (openingStock > 0) {
          await offlineDb.inventory_movements.add({
            id: crypto.randomUUID(),
            product_id: productId,
            movement_type: 'OPENING_STOCK',
            quantity_delta: openingStock,
            unit_cost_snapshot: purchaseCost,
            reference_type: 'INITIAL_PRODUCT',
            reference_id: productId,
            notes: 'Initial opening stock',
            created_at: new Date().toISOString()
          });
        }

        await offlineDb.sync_queue.add({
          id: crypto.randomUUID(),
          operation_id: operationId,
          operation_type: 'CREATE_PRODUCT',
          entity_id: productId,
          payload: {
            id: productId,
            name: product.name,
            unit: product.unit,
            purchaseCost: product.purchase_cost,
            salePrice: product.sale_price,
            minimumStock: product.minimum_stock,
            openingStock
          },
          status: 'PENDING',
          attempt_count: 0,
          last_attempt_at: null,
          last_error: null,
          created_at: new Date().toISOString()
        });
      }

      return product;
    }
  );
}

// -----------------------------------------------------------------------------
// 5. EXPORT OFFLINE BACKUP
// -----------------------------------------------------------------------------
export async function exportOfflineBackup() {
  const [
    products,
    sales,
    sale_items,
    returns,
    return_items,
    stock_entries,
    stock_entry_items,
    inventory_movements,
    sync_queue,
    settings
  ] = await Promise.all([
    offlineDb.products.toArray(),
    offlineDb.sales.toArray(),
    offlineDb.sale_items.toArray(),
    offlineDb.returns.toArray(),
    offlineDb.return_items.toArray(),
    offlineDb.stock_entries.toArray(),
    offlineDb.stock_entry_items.toArray(),
    offlineDb.inventory_movements.toArray(),
    offlineDb.sync_queue.toArray(),
    offlineDb.settings.toArray()
  ]);

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    products,
    sales,
    sale_items,
    returns,
    return_items,
    stock_entries,
    stock_entry_items,
    inventory_movements,
    sync_queue,
    settings
  };
}
