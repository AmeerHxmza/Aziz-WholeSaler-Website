import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

// Optional deployed-schema verification. Business transactions are tested against
// local PostgreSQL instead of inserting audit products into a customer's shop.
test('Deployed Supabase exposes the authenticated snapshot contract (read-only)', {
  skip: process.env.RUN_LIVE_TESTS !== '1'
}, async () => {
  const names = ['TEST_SUPABASE_URL','TEST_SUPABASE_ANON_KEY','TEST_ADMIN_EMAIL','TEST_ADMIN_PASSWORD'] as const;
  for (const name of names) assert.ok(process.env[name], `${name} must be explicitly configured.`);
  const client = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const auth = await client.auth.signInWithPassword({ email: process.env.TEST_ADMIN_EMAIL!, password: process.env.TEST_ADMIN_PASSWORD! });
  assert.equal(auth.error, null);
  const { data, error } = await client.rpc('shop_snapshot');
  assert.equal(error, null, 'Apply migration 004 before deploying this app.');
  assert.equal(data.owner_id, auth.data.user?.id);
  for (const table of ['products','sales','sale_items','returns','return_items','stock_entries','stock_entry_items','inventory_movements','loans','loan_settlements','business_settings']) assert.ok(Array.isArray(data[table]), `${table} missing from snapshot`);
});
