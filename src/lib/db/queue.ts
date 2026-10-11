import { offlineDb, type LocalSyncQueueItem } from './offline-db';

// Called inside the same write transaction as the business change. Millisecond
// timestamps alone cannot order dependent operations created in quick succession.
export async function enqueueOperation(item: LocalSyncQueueItem) {
  if ((await offlineDb.settings.get('maintenance'))?.value) throw new Error('Shop data maintenance is in progress. Try again when it finishes.');
  const last = await offlineDb.settings.get('operation_sequence');
  const sequence = Number(last?.value || 0) + 1;
  await offlineDb.settings.put({ key: 'operation_sequence', value: sequence });
  await offlineDb.sync_queue.add({ ...item, sequence, payload: { ...item.payload, protocol: 2 } });
}
