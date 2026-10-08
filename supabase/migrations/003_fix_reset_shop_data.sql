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

-- ==============================================================================
-- Drop older 7-parameter signature to prevent PostgREST PGRST203 overload ambiguity
drop function if exists public.create_product(text, text, numeric, numeric, numeric, numeric, text);

create or replace function public.create_product(
  p_name text,
  p_unit text,
  p_purchase_cost numeric,
  p_sale_price numeric,
  p_minimum_stock numeric default 10,
  p_opening_stock numeric default 0,
  p_sku text default null,
  p_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_id uuid;
  v_existing_id uuid;
begin
  if v_owner is null or not public.is_shop_admin() then
    raise exception 'Sign in as the shop administrator before creating a product.';
  end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 160 or length(trim(coalesce(p_unit,''))) not between 1 and 40 then
    raise exception 'Enter a product name and selling unit.';
  end if;
  if p_purchase_cost < 0 or p_purchase_cost > 1000000000 or p_purchase_cost <> round(p_purchase_cost, 2) or
     p_sale_price < 0 or p_sale_price > 1000000000 or p_sale_price <> round(p_sale_price, 2) then
    raise exception 'Rates must be between 0 and 1,000,000,000 with at most 2 decimals.';
  end if;
  if p_minimum_stock < 0 or p_minimum_stock > 1000000 or p_minimum_stock <> round(p_minimum_stock, 3) or
     p_opening_stock < 0 or p_opening_stock > 1000000 or p_opening_stock <> round(p_opening_stock, 3) then
    raise exception 'Stock quantities must be between 0 and 1,000,000 with at most 3 decimals.';
  end if;

  -- 1. Check if a product with the same name already exists for this owner
  select id into v_existing_id from public.products
  where owner_id = v_owner and lower(trim(name)) = lower(trim(p_name))
  limit 1;

  if v_existing_id is not null then
    -- Product already exists: update prices, ensure active, and increment opening stock if specified
    update public.products
    set
      current_stock = current_stock + p_opening_stock,
      purchase_cost = p_purchase_cost,
      average_cost = case when (current_stock + p_opening_stock) > 0
                     then round(((current_stock * average_cost) + (p_opening_stock * p_purchase_cost)) / (current_stock + p_opening_stock), 6)
                     else p_purchase_cost end,
      sale_price = p_sale_price,
      default_sale_price = p_sale_price,
      minimum_stock = p_minimum_stock,
      low_stock_threshold = p_minimum_stock,
      active = true,
      is_active = true,
      updated_at = now()
    where id = v_existing_id;

    if p_opening_stock > 0 then
      insert into public.inventory_movements(
        owner_id, product_id, movement_type, quantity_delta, unit_cost_snapshot,
        reference_type, reference_id, notes, created_by
      )
      values(
        v_owner, v_existing_id, 'STOCK_IN', p_opening_stock, p_purchase_cost,
        'STOCK_ENTRY', format('STK-%s-%s', to_char(current_date, 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
        'Added to existing product', v_owner
      );
    end if;

    return jsonb_build_object('id', v_existing_id, 'updated', true);
  end if;

  -- 2. New product insertion with specified or generated ID
  v_id := coalesce(p_id, gen_random_uuid());

  insert into public.products(
    id, owner_id, name, sku, unit, current_stock, average_cost, default_sale_price,
    low_stock_threshold, is_active, purchase_cost, sale_price, minimum_stock, active
  )
  values(
    v_id, v_owner, trim(p_name), nullif(trim(coalesce(p_sku,'')),''), trim(p_unit),
    p_opening_stock, p_purchase_cost, p_sale_price, p_minimum_stock, true,
    p_purchase_cost, p_sale_price, p_minimum_stock, true
  );

  if p_opening_stock > 0 then
    insert into public.inventory_movements(
      owner_id, product_id, movement_type, quantity_delta, unit_cost_snapshot,
      reference_type, reference_id, notes, created_by
    )
    values(
      v_owner, v_id, 'OPENING_STOCK', p_opening_stock, p_purchase_cost,
      'OPENING_STOCK', format('OPEN-%s-%s', to_char(current_date, 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
      'Opening inventory', v_owner
    );

    insert into public.stock_movements(
      owner_id, product_id, quantity, movement_type, reference_type, reference_id,
      movement_date, unit_cost, note
    )
    values(
      v_owner, v_id, p_opening_stock, 'OPENING', 'OPENING_STOCK',
      format('OPEN-%s-%s', to_char(current_date, 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
      current_date, p_purchase_cost, 'Opening inventory'
    );
  end if;

  insert into public.audit_log(owner_id, action, entity_type, entity_id, details)
  values(v_owner, 'PRODUCT_CREATED', 'PRODUCT', v_id::text, format('Created product %s', trim(p_name)));

  return jsonb_build_object('id', v_id, 'created', true);
end $$;

grant execute on function public.create_product(text, text, numeric, numeric, numeric, numeric, text, uuid) to authenticated;

