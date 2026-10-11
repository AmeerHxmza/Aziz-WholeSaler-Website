import { enqueueOperation } from './queue';
import { amount, businessDate, quantity } from '../calculations';
import { offlineDb, type LocalSyncQueueItem } from './offline-db';

export interface Loan {
  id: string; person_name: string; type: 'GIVEN' | 'TAKEN'; amount: number;
  paid_amount: number; remaining_amount: number; status: string; loan_date: string;
  notes: string | null;
}

export async function recordLocalAction(type: LocalSyncQueueItem['operation_type'], payload: Record<string, unknown>) {
  return offlineDb.transaction('rw', offlineDb.tables, async () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const loans = ((await offlineDb.settings.get('cloud_loans'))?.value || []) as Loan[];
    if (type === 'CREATE_LOAN') {
      const value = amount(payload.amount);
      if (!value || !String(payload.person).trim() || !['GIVEN', 'TAKEN'].includes(String(payload.type))) throw new Error('Enter a person, type and positive whole amount.');
      loans.push({ id, person_name: String(payload.person).trim(), type: payload.type as Loan['type'], amount: value, paid_amount: 0, remaining_amount: value, status: 'OUTSTANDING', loan_date: businessDate(String(payload.date)), notes: null });
      payload = { ...payload, id };
      await offlineDb.settings.put({ key: 'cloud_loans', value: loans });
    } else if (type === 'SETTLE_LOAN') {
      const loan = loans.find(l => l.id === payload.loanId);
      const value = amount(payload.amount);
      const date = businessDate(String(payload.date));
      if (!loan || value <= 0 || value > loan.remaining_amount || date < loan.loan_date) throw new Error('Invalid repayment amount or date.');
      loan.paid_amount += value; loan.remaining_amount -= value;
      loan.status = loan.remaining_amount === 0 ? 'SETTLED' : 'OUTSTANDING';
      await offlineDb.settings.put({ key: 'cloud_loans', value: loans });
      const settlements = ((await offlineDb.settings.get('cloud_loan_settlements'))?.value || []) as Record<string, unknown>[];
      settlements.push({ id, loan_id: loan.id, amount: value, settlement_date: date });
      await offlineDb.settings.put({ key: 'cloud_loan_settlements', value: settlements });
    } else if (type === 'SAVE_SETTINGS') {
      if (!String(payload.business_name || '').trim()) throw new Error('Enter the business name.');
      await offlineDb.settings.put({ key: 'cloud_settings', value: payload });
    } else if (type === 'ADJUST_STOCK') {
      const product = await offlineDb.products.get(String(payload.productId));
      if (!product || !String(payload.reason || '').trim()) throw new Error('Choose a product and reason.');
      businessDate(String(payload.date));
      const delta = payload.type === 'PHYSICAL' ? quantity(payload.physicalCount, true) - product.current_stock
        : quantity(payload.quantity) * (payload.type === 'DECREASE' ? -1 : 1);
      if (!delta || product.current_stock + delta < 0) throw new Error('Adjustment must change stock without making it negative.');
      payload = { ...payload, expectedStock: product.current_stock };
      await offlineDb.products.update(product.id, { current_stock: product.current_stock + delta, updated_at: now });
      await offlineDb.inventory_movements.add({ id, product_id: product.id, movement_type: delta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT', quantity_delta: delta, unit_cost_snapshot: product.average_cost, reference_type: 'ADJUSTMENT', reference_id: id, notes: String(payload.reason), created_at: now });
    } else throw new Error('Unsupported local action.');
    await enqueueOperation({ id, operation_id: id, operation_type: type, entity_id: String(payload.id || payload.loanId || payload.productId || id), payload, status: 'PENDING', attempt_count: 0, last_attempt_at: null, last_error: null, created_at: now });
  });
}
