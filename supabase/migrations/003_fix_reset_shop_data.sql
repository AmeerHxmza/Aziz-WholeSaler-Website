-- ==============================================================================
-- AZIZ & SON WHOLESALE: COMPLETE & CASCADE-SAFE RESET OF BUSINESS DATA
-- Fixes foreign key constraint violations on stock_entry_items, inventory_movements,
-- and return_items during business reset.
-- ==============================================================================

create or replace function public.reset_shop_data(p_confirmation text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null or not public.is_shop_admin() then
    raise exception 'Only the shop administrator can reset business data.';
  end if;

  if p_confirmation <> 'RESET AZIZ SHOP' then
    raise exception 'Type RESET AZIZ SHOP to confirm the full reset.';
  end if;

  -- 1. Delete loan settlements and loans
  delete from public.loan_settlements where owner_id = v_owner;
  delete from public.loans where owner_id = v_owner;

  -- 2. Delete return items and returns (return_items has FK restrict to sale_items and products)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'return_items') then
    delete from public.return_items where return_id in (select id from public.returns where owner_id = v_owner);
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'returns_legacy') then
    delete from public.returns_legacy where owner_id = v_owner;
  end if;

  delete from public.returns where owner_id = v_owner;

  -- 3. Delete sale items and sales
  delete from public.sale_items where owner_id = v_owner;
  delete from public.sales where owner_id = v_owner;

  -- 4. Delete stock entry items and stock entries (stock_entry_items has FK restrict to products)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'stock_entry_items') then
    delete from public.stock_entry_items where stock_entry_id in (select id from public.stock_entries where owner_id = v_owner);
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'stock_entries') then
    delete from public.stock_entries where owner_id = v_owner;
  end if;

  -- 5. Delete inventory movements and adjustments (inventory_movements has FK restrict to products)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'inventory_movements') then
    delete from public.inventory_movements where owner_id = v_owner;
  end if;

  delete from public.stock_adjustments where owner_id = v_owner;
  delete from public.stock_movements where owner_id = v_owner;
  delete from public.invoice_sequences where owner_id = v_owner;
  delete from public.return_sequences where owner_id = v_owner;

  -- 6. Delete products (now completely safe, all child references removed)
  delete from public.products where owner_id = v_owner;

  -- 7. Reset sequences to 1 if existing
  if exists (select 1 from pg_sequences where schemaname = 'public' and sequencename = 'sale_invoice_seq') then
    perform setval('public.sale_invoice_seq', 1, false);
  end if;

  if exists (select 1 from pg_sequences where schemaname = 'public' and sequencename = 'return_number_seq') then
    perform setval('public.return_number_seq', 1, false);
  end if;

  if exists (select 1 from pg_sequences where schemaname = 'public' and sequencename = 'stock_entry_seq') then
    perform setval('public.stock_entry_seq', 1, false);
  end if;

  -- 8. Business settings & Audit Log
  delete from public.business_settings where owner_id = v_owner;
  delete from public.audit_log where owner_id = v_owner;

  insert into public.audit_log(owner_id, action, entity_type, entity_id, details)
  values(v_owner, 'BUSINESS_DATA_RESET', 'ADMIN', v_owner::text, 'Administrator reset all shop data.');

  return jsonb_build_object('reset', true);
end $$;

revoke all on function public.reset_shop_data(text) from public, anon;
grant execute on function public.reset_shop_data(text) to authenticated;
