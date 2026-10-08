-- ==============================================================================
-- AZIZ & SON WHOLESALE: CORE WHOLESALE ENGINE & DATABASE TRANSACTIONS
-- Architecture: STOCK -> SALE -> RETURN -> PROFIT -> REPORTS
-- Precision: numeric(14,2) money, numeric(14,3) quantity, numeric(16,6) unit cost
-- Single administrator: aziz@gmail.com
-- ==============================================================================

create extension if not exists pgcrypto;

-- 1. SEQUENCES (Concurrency-safe, gapless receipt numbering)
create sequence if not exists public.sale_invoice_seq start with 1 increment by 1;
create sequence if not exists public.return_number_seq start with 1 increment by 1;
create sequence if not exists public.stock_entry_seq start with 1 increment by 1;

-- 2. PRODUCTS TABLE ENHANCEMENTS
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  sku text,
  unit text not null check (length(trim(unit)) between 1 and 40),
  current_stock numeric(14,3) not null default 0 check (current_stock >= 0),
  average_cost numeric(16,6) not null default 0 check (average_cost >= 0 and average_cost <= 1000000000),
  default_sale_price numeric(14,2) not null default 0 check (default_sale_price >= 0 and default_sale_price <= 1000000000),
  low_stock_threshold numeric(14,3) not null default 10 check (low_stock_threshold >= 0),
  is_active boolean not null default true,
  purchase_cost numeric(16,6) not null default 0,
  sale_price numeric(14,2) not null default 0,
  minimum_stock numeric(14,3) not null default 10,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, id)
);

-- Ensure all columns exist on products if already created in earlier migration
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='sku') then
    alter table public.products add column sku text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='current_stock') then
    alter table public.products add column current_stock numeric(14,3) not null default 0 check (current_stock >= 0);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='average_cost') then
    alter table public.products add column average_cost numeric(16,6) not null default 0 check (average_cost >= 0);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='default_sale_price') then
    alter table public.products add column default_sale_price numeric(14,2) not null default 0 check (default_sale_price >= 0);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='low_stock_threshold') then
    alter table public.products add column low_stock_threshold numeric(14,3) not null default 10 check (low_stock_threshold >= 0);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='is_active') then
    alter table public.products add column is_active boolean not null default true;
  end if;
end $$;

-- Populate compatibility columns
update public.products
set
  average_cost = case when average_cost = 0 and purchase_cost > 0 then purchase_cost else average_cost end,
  default_sale_price = case when default_sale_price = 0 and sale_price > 0 then sale_price else default_sale_price end,
  low_stock_threshold = case when low_stock_threshold = 10 and minimum_stock <> 10 then minimum_stock else low_stock_threshold end,
  is_active = active;

-- 3. STOCK ENTRIES & ITEMS (Add Stock transactions)
create table if not exists public.stock_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  reference_number text not null,
  entry_date date not null,
  supplier_name text,
  notes text,
  total_cost numeric(14,2) not null default 0 check (total_cost >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique(owner_id, reference_number)
);

create table if not exists public.stock_entry_items (
  id bigint generated always as identity primary key,
  stock_entry_id uuid not null references public.stock_entries(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  line_cost numeric(14,2) not null check (line_cost >= 0),
  created_at timestamptz not null default now()
);

-- 4. IMMUTABLE INVENTORY MOVEMENTS LEDGER (Audit trail of every stock change)
create table if not exists public.inventory_movements (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  movement_type text not null check (movement_type in ('OPENING_STOCK','STOCK_IN','SALE_OUT','SALE_RETURN_IN','ADJUSTMENT_IN','ADJUSTMENT_OUT','VOID_REVERSAL')),
  quantity_delta numeric(14,3) not null check (quantity_delta <> 0),
  unit_cost_snapshot numeric(16,6) check (unit_cost_snapshot is null or unit_cost_snapshot >= 0),
  reference_type text not null,
  reference_id text not null,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

-- 5. SALES & SALE ITEMS
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  invoice_number text not null,
  sale_date date not null,
  customer_name text,
  customer_phone text,
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0 and subtotal <= 1000000000),
  total numeric(14,2) not null default 0 check (total >= 0 and total <= 1000000000),
  net_total numeric(14,2) not null default 0,
  original_profit numeric(14,2) not null default 0,
  status text not null default 'COMPLETED',
  notes text,
  void_reason text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique(owner_id, id),
  unique(owner_id, invoice_number)
);

-- Add any missing columns to sales from 001
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales' and column_name='customer_name') then
    alter table public.sales add column customer_name text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales' and column_name='customer_phone') then
    alter table public.sales add column customer_phone text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales' and column_name='subtotal') then
    alter table public.sales add column subtotal numeric(14,2) not null default 0;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales' and column_name='total') then
    alter table public.sales add column total numeric(14,2) not null default 0;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales' and column_name='original_profit') then
    alter table public.sales add column original_profit numeric(14,2) not null default 0;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales' and column_name='created_by') then
    alter table public.sales add column created_by uuid references auth.users(id) on delete set null;
  end if;
end $$;

-- Update sales check constraint for new statuses
alter table public.sales drop constraint if exists sales_status_check;
alter table public.sales add constraint sales_status_check check (status in ('COMPLETED','PARTIALLY_RETURNED','FULLY_RETURNED','VOIDED','CONFIRMED'));

create table if not exists public.sale_items (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  product_name_snapshot text not null,
  unit_snapshot text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_sale_price numeric(14,2) not null default 0 check (unit_sale_price >= 0),
  unit_cost_snapshot numeric(16,6) not null default 0 check (unit_cost_snapshot >= 0),
  line_total numeric(14,2) not null check (line_total >= 0),
  original_profit numeric(14,2) not null default 0,
  purchase_cost_snapshot numeric(16,6) not null default 0,
  cost_total_snapshot numeric(14,2) not null default 0,
  unit_price numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  unique(sale_id, product_id)
);

-- Add any missing columns to sale_items from 001
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sale_items' and column_name='unit_sale_price') then
    alter table public.sale_items add column unit_sale_price numeric(14,2) not null default 0;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sale_items' and column_name='unit_cost_snapshot') then
    alter table public.sale_items add column unit_cost_snapshot numeric(16,6) not null default 0;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='sale_items' and column_name='original_profit') then
    alter table public.sale_items add column original_profit numeric(14,2) not null default 0;
  end if;
end $$;

-- 6. RETURNS & RETURN ITEMS (Clean migration from legacy flat returns)
do $$
begin
  if exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' and table_name = 'returns' and data_type = 'bigint' and column_name = 'id'
  ) then
    alter table public.returns rename to returns_legacy;
  end if;
end $$;

create table if not exists public.returns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  return_number text not null,
  bill_number text,
  sale_id uuid not null references public.sales(id) on delete restrict,
  invoice_number text,
  return_date date not null,
  movement_date date,
  refund_total numeric(14,2) not null check (refund_total >= 0),
  profit_reversed numeric(14,2) not null default 0,
  reason text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique(owner_id, return_number)
);

create table if not exists public.return_items (
  id bigint generated always as identity primary key,
  return_id uuid not null references public.returns(id) on delete cascade,
  sale_item_id bigint not null references public.sale_items(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity_returned numeric(14,3) not null check (quantity_returned > 0),
  unit_sale_price_snapshot numeric(14,2) not null check (unit_sale_price_snapshot >= 0),
  unit_cost_snapshot numeric(16,6) not null check (unit_cost_snapshot >= 0),
  refund_amount numeric(14,2) not null check (refund_amount >= 0),
  profit_reversed numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

-- Migrate any rows from returns_legacy if existing
do $$
declare
  r record;
  v_new_id uuid;
  v_sale_item_id bigint;
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='returns_legacy') then
    for r in select * from public.returns_legacy loop
      if not exists (select 1 from public.returns where return_number = r.return_number) then
        v_new_id := gen_random_uuid();
        insert into public.returns(id, owner_id, return_number, bill_number, sale_id, invoice_number, return_date, movement_date, refund_total, profit_reversed, reason, notes, created_at, created_by)
        values(v_new_id, r.owner_id, r.return_number, r.bill_number, r.sale_id, r.invoice_number, r.movement_date, r.movement_date, r.refund_amount, 0, r.reason, r.notes, r.created_at, r.owner_id);

        select id into v_sale_item_id from public.sale_items where sale_id = r.sale_id and product_id = r.product_id limit 1;
        if v_sale_item_id is not null then
          insert into public.return_items(return_id, sale_item_id, product_id, quantity_returned, unit_sale_price_snapshot, unit_cost_snapshot, refund_amount, profit_reversed, created_at)
          values(v_new_id, v_sale_item_id, r.product_id, r.quantity, round(r.refund_amount / nullif(r.quantity, 0), 2), r.purchase_cost_snapshot, r.refund_amount, 0, r.created_at);
        end if;
      end if;
    end loop;
  end if;
end $$;

-- Synchronize sequences with existing invoice/return numbers to avoid conflicts
do $$
declare
  v_max_sale int;
  v_max_return int;
begin
  select coalesce(max(nullif(regexp_replace(invoice_number, '\D', '', 'g'), '')::int), 0) into v_max_sale from public.sales;
  if v_max_sale > 0 then
    perform setval('public.sale_invoice_seq', v_max_sale);
  end if;
  
  select coalesce(max(nullif(regexp_replace(return_number, '\D', '', 'g'), '')::int), 0) into v_max_return from public.returns;
  if v_max_return > 0 then
    perform setval('public.return_number_seq', v_max_return);
  end if;
end $$;

-- 7. INDEXES FOR PERFORMANCE
create index if not exists idx_products_owner_stock on public.products(owner_id, current_stock);
create index if not exists idx_products_owner_active on public.products(owner_id, is_active, name);
create index if not exists idx_stock_entries_date on public.stock_entries(owner_id, entry_date desc);
create index if not exists idx_inv_movements_prod on public.inventory_movements(owner_id, product_id, created_at desc);
create index if not exists idx_sales_date on public.sales(owner_id, sale_date desc);
create index if not exists idx_sales_invoice on public.sales(owner_id, invoice_number);
create index if not exists idx_sale_items_sale on public.sale_items(sale_id);
create index if not exists idx_returns_sale on public.returns(sale_id);
create index if not exists idx_returns_date on public.returns(owner_id, return_date desc);
create index if not exists idx_return_items_sale_item on public.return_items(sale_item_id);
create index if not exists idx_stock_entry_items_entry on public.stock_entry_items(stock_entry_id);
create index if not exists idx_return_items_return on public.return_items(return_id);

-- 8. ROW LEVEL SECURITY (Direct, error-free policies)
alter table public.stock_entries enable row level security;
alter table public.stock_entry_items enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.returns enable row level security;
alter table public.return_items enable row level security;

drop policy if exists owner_read on public.stock_entries;
create policy owner_read on public.stock_entries for select to authenticated
  using (owner_id = auth.uid() and public.is_shop_admin());

drop policy if exists owner_read on public.stock_entry_items;
create policy owner_read on public.stock_entry_items for select to authenticated
  using (exists (select 1 from public.stock_entries se where se.id = stock_entry_items.stock_entry_id and se.owner_id = auth.uid() and public.is_shop_admin()));

drop policy if exists owner_read on public.inventory_movements;
create policy owner_read on public.inventory_movements for select to authenticated
  using (owner_id = auth.uid() and public.is_shop_admin());

drop policy if exists owner_read on public.returns;
create policy owner_read on public.returns for select to authenticated
  using (owner_id = auth.uid() and public.is_shop_admin());

drop policy if exists owner_read on public.return_items;
create policy owner_read on public.return_items for select to authenticated
  using (exists (select 1 from public.returns r where r.id = return_items.return_id and r.owner_id = auth.uid() and public.is_shop_admin()));

-- 9. AUTHORITATIVE DATABASE VIEWS
create or replace view public.sale_item_balances as
select
  si.id as sale_item_id,
  si.sale_id,
  si.product_id,
  si.product_name_snapshot,
  si.unit_snapshot,
  si.quantity as original_quantity,
  coalesce(sum(ri.quantity_returned), 0)::numeric(14,3) as returned_quantity,
  (si.quantity - coalesce(sum(ri.quantity_returned), 0))::numeric(14,3) as net_quantity,
  si.unit_sale_price,
  si.unit_cost_snapshot,
  si.line_total as original_revenue,
  coalesce(sum(ri.refund_amount), 0)::numeric(14,2) as returned_revenue,
  (si.line_total - coalesce(sum(ri.refund_amount), 0))::numeric(14,2) as net_revenue,
  si.original_profit,
  coalesce(sum(ri.profit_reversed), 0)::numeric(14,2) as reversed_profit,
  (si.original_profit - coalesce(sum(ri.profit_reversed), 0))::numeric(14,2) as net_profit
from public.sale_items si
left join public.return_items ri on ri.sale_item_id = si.id
group by si.id;

create or replace view public.sale_balances as
select
  s.id as sale_id,
  s.owner_id,
  s.invoice_number,
  s.sale_date,
  s.status,
  s.customer_name,
  s.customer_phone,
  s.total as original_total,
  coalesce(sum(ri.refund_amount), 0)::numeric(14,2) as refunded_total,
  (s.total - coalesce(sum(ri.refund_amount), 0))::numeric(14,2) as net_total,
  s.original_profit,
  coalesce(sum(ri.profit_reversed), 0)::numeric(14,2) as reversed_profit,
  (s.original_profit - coalesce(sum(ri.profit_reversed), 0))::numeric(14,2) as net_profit,
  count(distinct si.id) as items_count,
  s.notes,
  s.created_at
from public.sales s
join public.sale_items si on si.sale_id = s.id
left join public.return_items ri on ri.sale_item_id = si.id
group by s.id;

-- Clean up legacy overloaded function signatures from migration 001 to resolve PostgREST ambiguity
drop function if exists public.create_product(text, text, numeric, numeric, numeric, numeric);
drop function if exists public.update_product(uuid, text, text, numeric, numeric, numeric, boolean);
drop function if exists public.create_sale(date, jsonb, text);
drop function if exists public.create_return(date, text, jsonb, uuid, text);

-- A. ADD STOCK (Multi-product atomic transaction, weighted-average cost, audit trail)
create or replace function public.add_stock(
  p_items jsonb,
  p_entry_date date default current_date,
  p_supplier text default null,
  p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_entry_id uuid := gen_random_uuid();
  v_seq integer := nextval('public.stock_entry_seq');
  v_ref text := format('STK-%s-%s', to_char(p_entry_date, 'YYYYMMDD'), lpad(v_seq::text, 5, '0'));
  v_total_cost numeric(14,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric(14,3);
  v_cost numeric(14,2);
  v_line numeric(14,2);
  v_new_avg numeric(16,6);
  v_count integer := 0;
begin
  if v_owner is null or not public.is_shop_admin() then
    raise exception 'Sign in as the shop administrator before adding stock.';
  end if;
  if p_entry_date is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Stock entry must contain a date and at least one item.';
  end if;

  insert into public.stock_entries(id, owner_id, reference_number, entry_date, supplier_name, notes, total_cost, created_by)
  values(v_entry_id, v_owner, v_ref, p_entry_date, nullif(trim(coalesce(p_supplier,'')),''), nullif(trim(coalesce(p_notes,'')),''), 0, v_owner);

  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = (v_item->>'productId')::uuid and owner_id = v_owner for update;
    if not found then raise exception 'Product % not found.', (v_item->>'productId'); end if;

    v_qty := (v_item->>'quantity')::numeric;
    v_cost := (v_item->>'unitCost')::numeric;

    if v_qty <= 0 or v_qty > 1000000 or v_qty <> round(v_qty, 3) then
      raise exception 'Quantity for % must be positive with at most 3 decimals.', v_product.name;
    end if;
    if v_cost < 0 or v_cost > 1000000000 or v_cost <> round(v_cost, 2) then
      raise exception 'Purchase cost for % must be between 0 and 1,000,000,000 with at most 2 decimals.', v_product.name;
    end if;

    v_line := round(v_qty * v_cost, 2);
    v_total_cost := round(v_total_cost + v_line, 2);

    -- Moving weighted-average cost formula
    if v_product.current_stock <= 0 then
      v_new_avg := round(v_cost, 6);
    else
      v_new_avg := round(((v_product.current_stock * v_product.average_cost) + (v_qty * v_cost)) / (v_product.current_stock + v_qty), 6);
    end if;

    -- Update product stock and average cost atomically
    update public.products
    set
      current_stock = current_stock + v_qty,
      average_cost = v_new_avg,
      purchase_cost = v_new_avg,
      updated_at = now()
    where id = v_product.id;

    -- Insert stock entry item
    insert into public.stock_entry_items(stock_entry_id, product_id, quantity, unit_cost, line_cost)
    values(v_entry_id, v_product.id, v_qty, v_cost, v_line);

    -- Insert immutable inventory movement
    insert into public.inventory_movements(owner_id, product_id, movement_type, quantity_delta, unit_cost_snapshot, reference_type, reference_id, notes, created_by)
    values(v_owner, v_product.id, 'STOCK_IN', v_qty, v_cost, 'STOCK_ENTRY', v_ref, coalesce(p_notes, 'Purchased stock'), v_owner);

    -- Keep legacy stock_movements in sync
    insert into public.stock_movements(owner_id, product_id, quantity, movement_type, reference_type, reference_id, movement_date, unit_cost, note)
    values(v_owner, v_product.id, v_qty, 'PURCHASE', 'PURCHASE_RECEIPT', v_ref, p_entry_date, v_cost, coalesce(p_notes, v_ref));

    v_count := v_count + 1;
  end loop;

  update public.stock_entries set total_cost = v_total_cost where id = v_entry_id;

  insert into public.audit_log(owner_id, action, entity_type, entity_id, details)
  values(v_owner, 'STOCK_ADDED', 'STOCK_ENTRY', v_ref, format('Added %s items. Total cost Rs. %s', v_count, v_total_cost));

  return jsonb_build_object(
    'id', v_entry_id,
    'referenceNumber', v_ref,
    'totalCost', v_total_cost,
    'itemCount', v_count
  );
end $$;

-- Single-product stock addition wrapper
create or replace function public.record_stock(
  p_product_id uuid,
  p_quantity numeric,
  p_purchase_cost numeric,
  p_date date,
  p_movement_type text default 'PURCHASE',
  p_reference text default null,
  p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb;
begin
  v_res := public.add_stock(
    jsonb_build_array(jsonb_build_object('productId', p_product_id, 'quantity', p_quantity, 'unitCost', p_purchase_cost)),
    p_date,
    null,
    coalesce(p_notes, p_reference)
  );
  return jsonb_build_object(
    'reference', v_res->>'referenceNumber',
    'stock', (select current_stock from public.products where id = p_product_id),
    'averageCost', (select average_cost from public.products where id = p_product_id)
  );
end $$;

-- B. CREATE SALE (Overselling prevention, snapshot unit cost, authoritative totals & profit)
create or replace function public.create_sale(
  p_date date,
  p_items jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_seq integer := nextval('public.sale_invoice_seq');
  v_invoice text := format('AS-%s', lpad(v_seq::text, 6, '0'));
  v_sale_id uuid := gen_random_uuid();
  v_subtotal numeric(14,2) := 0;
  v_profit numeric(14,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric(14,3);
  v_price numeric(14,2);
  v_line numeric(14,2);
  v_item_cost numeric(14,2);
  v_item_profit numeric(14,2);
begin
  if v_owner is null or not public.is_shop_admin() then
    raise exception 'Sign in as the shop administrator before creating a sale.';
  end if;
  if p_date is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Sale must contain a date and at least one item.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) x group by x->>'productId' having count(*) > 1) then
    raise exception 'Each product can appear only once in a bill.';
  end if;

  insert into public.sales(
    id, owner_id, invoice_number, sale_date, customer_name, customer_phone,
    subtotal, total, net_total, original_profit, status, notes, created_by
  )
  values(
    v_sale_id, v_owner, v_invoice, p_date, nullif(trim(coalesce(p_customer_name,'')),''), nullif(trim(coalesce(p_customer_phone,'')),''),
    0, 0, 0, 0, 'COMPLETED', nullif(trim(coalesce(p_notes,'')),''), v_owner
  );

  for v_item in select value from jsonb_array_elements(p_items) order by value->>'productId' loop
    select * into v_product from public.products where id = (v_item->>'productId')::uuid and owner_id = v_owner for update;
    if not found or not v_product.is_active then
      raise exception 'A selected product is missing or inactive.';
    end if;

    v_qty := (v_item->>'quantity')::numeric;
    v_price := coalesce((v_item->>'unitPrice')::numeric, v_product.default_sale_price);

    if v_qty <= 0 or v_qty > 1000000 or v_qty <> round(v_qty, 3) then
      raise exception 'Quantity for % must be positive with at most 3 decimals.', v_product.name;
    end if;
    if v_price < 0 or v_price > 1000000000 or v_price <> round(v_price, 2) then
      raise exception 'Selling rate for % must be valid with at most 2 decimals.', v_product.name;
    end if;

    -- Strict overselling prevention
    if v_product.current_stock < v_qty then
      raise exception 'Only % % are available of %. You attempted to sell %.',
        v_product.current_stock, v_product.unit, v_product.name, v_qty;
    end if;

    v_line := round(v_qty * v_price, 2);
    v_item_cost := round(v_qty * v_product.average_cost, 2);
    v_item_profit := round(v_line - v_item_cost, 2);

    v_subtotal := round(v_subtotal + v_line, 2);
    v_profit := round(v_profit + v_item_profit, 2);

    -- Insert sale item with immutable unit cost snapshot
    insert into public.sale_items(
      owner_id, sale_id, product_id, product_name_snapshot, unit_snapshot,
      quantity, unit_sale_price, unit_cost_snapshot, line_total, original_profit,
      purchase_cost_snapshot, cost_total_snapshot, unit_price
    )
    values(
      v_owner, v_sale_id, v_product.id, v_product.name, v_product.unit,
      v_qty, v_price, v_product.average_cost, v_line, v_item_profit,
      v_product.average_cost, v_item_cost, v_price
    );

    -- Reduce current stock atomically
    update public.products
    set current_stock = current_stock - v_qty, updated_at = now()
    where id = v_product.id;

    -- Insert immutable inventory movement
    insert into public.inventory_movements(
      owner_id, product_id, movement_type, quantity_delta, unit_cost_snapshot,
      reference_type, reference_id, notes, created_by
    )
    values(
      v_owner, v_product.id, 'SALE_OUT', -v_qty, v_product.average_cost,
      'SALE_INVOICE', v_invoice, format('Sale %s', v_invoice), v_owner
    );

    -- Legacy stock movements sync
    insert into public.stock_movements(
      owner_id, product_id, quantity, movement_type, reference_type, reference_id,
      movement_date, unit_cost, note
    )
    values(
      v_owner, v_product.id, -v_qty, 'SALE', 'SALE_INVOICE', v_invoice,
      p_date, v_product.average_cost, format('Sale %s', v_invoice)
    );
  end loop;

  update public.sales
  set subtotal = v_subtotal, total = v_subtotal, net_total = v_subtotal, original_profit = v_profit, updated_at = now()
  where id = v_sale_id;

  insert into public.audit_log(owner_id, action, entity_type, entity_id, details)
  values(v_owner, 'SALE_CONFIRMED', 'SALE', v_invoice, format('Confirmed sale %s. Total Rs. %s', v_invoice, v_subtotal));

  return jsonb_build_object(
    'id', v_sale_id,
    'invoiceNumber', v_invoice,
    'subtotal', v_subtotal,
    'total', v_subtotal,
    'netTotal', v_subtotal,
    'originalProfit', v_profit
  );
end $$;

-- C. CREATE RETURN (Linked to original sale_item, uses original cost snapshot, reverses profit)
create or replace function public.create_return(
  p_sale_id uuid,
  p_date date,
  p_items jsonb,
  p_reason text default null,
  p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_seq integer := nextval('public.return_number_seq');
  v_return_num text := format('RT-%s', lpad(v_seq::text, 6, '0'));
  v_return_id uuid := gen_random_uuid();
  v_refund_total numeric(14,2) := 0;
  v_profit_reversed numeric(14,2) := 0;
  v_item jsonb;
  v_sale_item public.sale_items%rowtype;
  v_product public.products%rowtype;
  v_qty numeric(14,3);
  v_prev_returned numeric(14,3);
  v_remaining numeric(14,3);
  v_item_refund numeric(14,2);
  v_item_profit_reversed numeric(14,2);
  v_all_fully_returned boolean := true;
  v_item_check record;
  v_count integer := 0;
begin
  if v_owner is null or not public.is_shop_admin() then
    raise exception 'Sign in as the shop administrator before creating a return.';
  end if;
  if p_sale_id is null or p_date is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Return requires a valid sale, return date, and at least one item.';
  end if;

  select * into v_sale from public.sales where id = p_sale_id and owner_id = v_owner for update;
  if not found then raise exception 'Sale invoice not found.'; end if;
  if v_sale.status not in ('COMPLETED', 'PARTIALLY_RETURNED', 'CONFIRMED') then
    raise exception 'This invoice cannot accept returns (status: %).', v_sale.status;
  end if;
  if p_date < v_sale.sale_date then
    raise exception 'Return date (%) cannot be earlier than sale date (%).', p_date, v_sale.sale_date;
  end if;

  insert into public.returns(
    id, owner_id, return_number, bill_number, sale_id, invoice_number,
    return_date, movement_date, refund_total, profit_reversed, reason, notes, created_by
  )
  values(
    v_return_id, v_owner, v_return_num, v_return_num, v_sale.id, v_sale.invoice_number,
    p_date, p_date, 0, 0, nullif(trim(coalesce(p_reason,'')),''), nullif(trim(coalesce(p_notes, p_reason,'')),''), v_owner
  );

  for v_item in select value from jsonb_array_elements(p_items) loop
    -- Lookup the original sale item
    if (v_item->>'saleItemId') is not null then
      select * into v_sale_item from public.sale_items
      where id = (v_item->>'saleItemId')::bigint and sale_id = v_sale.id and owner_id = v_owner
      for update;
    elsif (v_item->>'productId') is not null then
      select * into v_sale_item from public.sale_items
      where product_id = (v_item->>'productId')::uuid and sale_id = v_sale.id and owner_id = v_owner
      for update;
    else
      raise exception 'Return item must specify saleItemId or productId.';
    end if;

    if not found then
      raise exception 'The returned product was not found on this invoice.';
    end if;

    select * into v_product from public.products where id = v_sale_item.product_id and owner_id = v_owner for update;
    if not found then raise exception 'Product % not found.', v_sale_item.product_name_snapshot; end if;

    v_qty := (v_item->>'quantity')::numeric;
    if v_qty <= 0 or v_qty > 1000000 or v_qty <> round(v_qty, 3) then
      raise exception 'Return quantity for % must be positive with at most 3 decimals.', v_sale_item.product_name_snapshot;
    end if;

    -- Calculate already-returned quantity for this sale item
    select coalesce(sum(quantity_returned), 0) into v_prev_returned
    from public.return_items
    where sale_item_id = v_sale_item.id;

    v_remaining := v_sale_item.quantity - v_prev_returned;

    if v_qty > v_remaining then
      raise exception 'Maximum returnable quantity for % is % %.',
        v_sale_item.product_name_snapshot, v_remaining, v_sale_item.unit_snapshot;
    end if;

    -- Financial calculations using ORIGINAL sale snapshots (Never current average cost!)
    v_item_refund := round(v_qty * v_sale_item.unit_sale_price, 2);
    v_item_profit_reversed := round(v_qty * (v_sale_item.unit_sale_price - v_sale_item.unit_cost_snapshot), 2);

    v_refund_total := round(v_refund_total + v_item_refund, 2);
    v_profit_reversed := round(v_profit_reversed + v_item_profit_reversed, 2);

    -- Insert return_items row referencing original sale item
    insert into public.return_items(
      return_id, sale_item_id, product_id, quantity_returned,
      unit_sale_price_snapshot, unit_cost_snapshot, refund_amount, profit_reversed
    )
    values(
      v_return_id, v_sale_item.id, v_product.id, v_qty,
      v_sale_item.unit_sale_price, v_sale_item.unit_cost_snapshot, v_item_refund, v_item_profit_reversed
    );

    -- Restore stock atomically
    update public.products
    set current_stock = current_stock + v_qty, updated_at = now()
    where id = v_product.id;

    -- Immutable inventory movement
    insert into public.inventory_movements(
      owner_id, product_id, movement_type, quantity_delta, unit_cost_snapshot,
      reference_type, reference_id, notes, created_by
    )
    values(
      v_owner, v_product.id, 'SALE_RETURN_IN', v_qty, v_sale_item.unit_cost_snapshot,
      'RETURN_RECORD', v_return_num, format('Return for %s: %s', v_sale.invoice_number, coalesce(p_reason,'')), v_owner
    );

    -- Legacy stock_movements sync
    insert into public.stock_movements(
      owner_id, product_id, quantity, movement_type, reference_type, reference_id,
      movement_date, unit_cost, note
    )
    values(
      v_owner, v_product.id, v_qty, 'RETURN', 'RETURN_RECORD', v_return_num,
      p_date, v_sale_item.unit_cost_snapshot, format('Return for %s', v_sale.invoice_number)
    );

    v_count := v_count + 1;
  end loop;

  -- Update return header totals
  update public.returns
  set refund_total = v_refund_total, profit_reversed = v_profit_reversed
  where id = v_return_id;

  -- Check if EVERY item on the invoice is now completely returned
  for v_item_check in (
    select
      si.quantity as original_qty,
      coalesce(sum(ri.quantity_returned), 0) as returned_qty
    from public.sale_items si
    left join public.return_items ri on ri.sale_item_id = si.id
    where si.sale_id = v_sale.id
    group by si.id, si.quantity
  ) loop
    if v_item_check.returned_qty < v_item_check.original_qty then
      v_all_fully_returned := false;
    end if;
  end loop;

  -- Update sale status: FULLY_RETURNED or PARTIALLY_RETURNED
  update public.sales
  set
    status = case when v_all_fully_returned then 'FULLY_RETURNED' else 'PARTIALLY_RETURNED' end,
    updated_at = now()
  where id = v_sale.id;

  insert into public.audit_log(owner_id, action, entity_type, entity_id, details)
  values(v_owner, 'RETURN_RECORDED', 'RETURN', v_return_num, format('Recorded return %s for invoice %s. Refund Rs. %s', v_return_num, v_sale.invoice_number, v_refund_total));

  return jsonb_build_object(
    'id', v_return_id,
    'returnNumber', v_return_num,
    'billNumber', v_return_num,
    'refundTotal', v_refund_total,
    'profitReversed', v_profit_reversed,
    'saleStatus', case when v_all_fully_returned then 'FULLY_RETURNED' else 'PARTIALLY_RETURNED' end
  );
end $$;

-- D. STOCK ADJUSTMENT (Audit logged, prevents negative stock)
create or replace function public.adjust_stock(
  p_product_id uuid,
  p_adjustment_type text,
  p_quantity numeric default null,
  p_physical_count numeric default null,
  p_reason text default 'Stock adjustment',
  p_date date default current_date,
  p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_product public.products%rowtype;
  v_old_stock numeric(14,3);
  v_new_stock numeric(14,3);
  v_delta numeric(14,3);
  v_ref text := format('ADJ-%s-%s', to_char(p_date, 'YYYYMMDD'), upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));
begin
  if v_owner is null or not public.is_shop_admin() then
    raise exception 'Sign in as the shop administrator before adjusting stock.';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A stock adjustment reason is required.';
  end if;

  select * into v_product from public.products where id = p_product_id and owner_id = v_owner for update;
  if not found then raise exception 'Product not found.'; end if;

  v_old_stock := v_product.current_stock;

  if p_adjustment_type = 'PHYSICAL' then
    if p_physical_count is null or p_physical_count < 0 or p_physical_count <> round(p_physical_count, 3) then
      raise exception 'Physical count must be non-negative with at most 3 decimals.';
    end if;
    v_new_stock := p_physical_count;
    v_delta := round(v_new_stock - v_old_stock, 3);
  elsif p_adjustment_type in ('INCREASE', 'DECREASE') then
    if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) then
      raise exception 'Adjustment quantity must be positive with at most 3 decimals.';
    end if;
    v_delta := case when p_adjustment_type = 'INCREASE' then p_quantity else -p_quantity end;
    v_new_stock := round(v_old_stock + v_delta, 3);
  else
    raise exception 'Choose a valid adjustment method.';
  end if;

  if v_delta = 0 then
    raise exception 'Count matches recorded stock. No adjustment needed.';
  end if;
  if v_new_stock < 0 then
    raise exception 'Stock cannot be reduced below zero.';
  end if;

  update public.products
  set current_stock = v_new_stock, updated_at = now()
  where id = v_product.id;

  insert into public.inventory_movements(
    owner_id, product_id, movement_type, quantity_delta, unit_cost_snapshot,
    reference_type, reference_id, notes, created_by
  )
  values(
    v_owner, v_product.id,
    case when v_delta > 0 then 'ADJUSTMENT_IN' else 'ADJUSTMENT_OUT' end,
    v_delta, v_product.average_cost, 'STOCK_ADJUSTMENT', v_ref,
    trim(p_reason) || case when nullif(trim(coalesce(p_notes,'')),'') is null then '' else ' - ' || trim(p_notes) end,
    v_owner
  );

  insert into public.stock_movements(
    owner_id, product_id, quantity, movement_type, reference_type, reference_id,
    movement_date, unit_cost, note
  )
  values(
    v_owner, v_product.id, v_delta, 'ADJUSTMENT', 'STOCK_ADJUSTMENT', v_ref,
    p_date, v_product.average_cost, trim(p_reason)
  );

  insert into public.audit_log(owner_id, action, entity_type, entity_id, details)
  values(v_owner, 'STOCK_ADJUSTED', 'STOCK_ADJUSTMENT', v_ref, format('%s: %s to %s %s. %s', v_product.name, v_old_stock, v_new_stock, v_product.unit, trim(p_reason)));

  return jsonb_build_object(
    'adjustmentNumber', v_ref,
    'previousStock', v_old_stock,
    'physicalCount', v_new_stock,
    'adjustmentQuantity', v_delta
  );
end $$;

-- E. CREATE PRODUCT
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

-- F. UPDATE PRODUCT
create or replace function public.update_product(
  p_product_id uuid,
  p_name text,
  p_unit text,
  p_purchase_cost numeric,
  p_sale_price numeric,
  p_minimum_stock numeric,
  p_active boolean,
  p_sku text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_product public.products%rowtype;
begin
  if v_owner is null or not public.is_shop_admin() then
    raise exception 'Sign in as the shop administrator before editing products.';
  end if;
  select * into v_product from public.products where id = p_product_id and owner_id = v_owner for update;
  if not found then raise exception 'Product not found.'; end if;

  if length(trim(coalesce(p_name,''))) not between 1 and 160 or length(trim(coalesce(p_unit,''))) not between 1 and 40 then
    raise exception 'Enter a product name and selling unit.';
  end if;
  if p_sale_price < 0 or p_sale_price > 1000000000 or p_sale_price <> round(p_sale_price, 2) then
    raise exception 'Selling rate must have at most 2 decimals.';
  end if;
  if p_minimum_stock < 0 or p_minimum_stock > 1000000 or p_minimum_stock <> round(p_minimum_stock, 3) then
    raise exception 'Minimum stock must have at most 3 decimals.';
  end if;

  update public.products
  set
    name = trim(p_name),
    sku = nullif(trim(coalesce(p_sku, sku)), ''),
    unit = trim(p_unit),
    average_cost = case when current_stock <= 0 then p_purchase_cost else average_cost end,
    purchase_cost = case when current_stock <= 0 then p_purchase_cost else average_cost end,
    default_sale_price = p_sale_price,
    sale_price = p_sale_price,
    low_stock_threshold = p_minimum_stock,
    minimum_stock = p_minimum_stock,
    is_active = p_active,
    active = p_active,
    updated_at = now()
  where id = p_product_id;

  insert into public.audit_log(owner_id, action, entity_type, entity_id, details)
  values(v_owner, 'PRODUCT_UPDATED', 'PRODUCT', p_product_id::text, format('Updated product %s', trim(p_name)));

  return jsonb_build_object('id', p_product_id);
end $$;

-- 11. FUNCTION PERMISSIONS
grant execute on function public.add_stock(jsonb, date, text, text) to authenticated;
grant execute on function public.record_stock(uuid, numeric, numeric, date, text, text, text) to authenticated;
grant execute on function public.create_sale(date, jsonb, text, text, text) to authenticated;
grant execute on function public.create_return(uuid, date, jsonb, text, text) to authenticated;
grant execute on function public.adjust_stock(uuid, text, numeric, numeric, text, date, text) to authenticated;
grant execute on function public.create_product(text, text, numeric, numeric, numeric, numeric, text, uuid) to authenticated;
grant execute on function public.update_product(uuid, text, text, numeric, numeric, numeric, boolean, text) to authenticated;
grant select on public.sale_item_balances to authenticated;
grant select on public.sale_balances to authenticated;

-- 12. CASCADE-SAFE RESET OF BUSINESS DATA
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

  -- 2. Delete return items and returns
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

  -- 4. Delete stock entry items and stock entries
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'stock_entry_items') then
    delete from public.stock_entry_items where stock_entry_id in (select id from public.stock_entries where owner_id = v_owner);
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'stock_entries') then
    delete from public.stock_entries where owner_id = v_owner;
  end if;

  -- 5. Delete inventory movements and adjustments
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'inventory_movements') then
    delete from public.inventory_movements where owner_id = v_owner;
  end if;

  delete from public.stock_adjustments where owner_id = v_owner;
  delete from public.stock_movements where owner_id = v_owner;
  delete from public.invoice_sequences where owner_id = v_owner;
  delete from public.return_sequences where owner_id = v_owner;

  -- 6. Delete products
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

