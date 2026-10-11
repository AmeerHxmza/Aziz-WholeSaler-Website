import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.TEST_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.TEST_SUPABASE_ANON_KEY || '';

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !process.env.TEST_ADMIN_EMAIL || !process.env.TEST_ADMIN_PASSWORD) throw new Error('Explicit TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY, TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD are required.');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_ADMIN_EMAIL,
    password: process.env.TEST_ADMIN_PASSWORD || ''
  });

  if (authError) {
    console.error('Auth error:', authError);
    return;
  }
  console.log('Logged in as user ID:', authData.user.id);

  // Check what tables exist and what columns
  const { data: sales, error: salesErr } = await supabase.from('sales').select('*').limit(1);
  console.log('Sales table probe:', { hasData: !!sales, error: salesErr?.message, sample: sales?.[0] });

  const { data: returns, error: retErr } = await supabase.from('returns').select('*').limit(1);
  console.log('Returns table probe:', { hasData: !!returns, error: retErr?.message, sample: returns?.[0] });

  const { data: stockEntries, error: seErr } = await supabase.from('stock_entries').select('*').limit(1);
  console.log('stock_entries probe:', { hasData: !!stockEntries, error: seErr?.message });

  const { data: invMov, error: imErr } = await supabase.from('inventory_movements').select('*').limit(1);
  console.log('inventory_movements probe:', { hasData: !!invMov, error: imErr?.message });

  const { data: retItems, error: riErr } = await supabase.from('return_items').select('*').limit(1);
  console.log('return_items probe:', { hasData: !!retItems, error: riErr?.message });
}

main().catch(console.error);
