create extension if not exists pgcrypto;

create table if not exists public.shop_admin (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.business_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  business_name text not null default 'Aziz & Son Wholesaler',
  address text not null default '',
  phone1 text not null default '',
  phone2 text not null default '',
  receipt_footer text not null default 'Thank you for your business!',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  unit text not null check (length(trim(unit)) between 1 and 40),
  purchase_cost numeric(16,6) not null default 0 check (purchase_cost between 0 and 1000000000),
  sale_price numeric(12,2) not null default 0 check (sale_price between 0 and 1000000000),
  minimum_stock numeric(12,3) not null default 10 check (minimum_stock between 0 and 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, id)
);

create table if not exists public.stock_movements (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null,
  quantity numeric(12,3) not null check (quantity <> 0),
  movement_type text not null check (movement_type in ('OPENING','PURCHASE','SALE','RETURN','ADJUSTMENT','SALE_VOID')),
  reference_type text not null,
  reference_id text not null,
  movement_date date not null,
  unit_cost numeric(16,6),
  note text,
  created_at timestamptz not null default now(),
  foreign key(owner_id, product_id) references public.products(owner_id, id) on delete restrict
);

create table if not exists public.stock_adjustments (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  adjustment_number text not null,
  product_id uuid not null,
  previous_stock numeric(12,3) not null,
  physical_count numeric(12,3) not null check (physical_count >= 0),
  adjustment_quantity numeric(12,3) not null check (adjustment_quantity <> 0),
  reason text not null check (length(trim(reason)) > 0),
  movement_date date not null,
  created_at timestamptz not null default now(),
  foreign key(owner_id, product_id) references public.products(owner_id, id) on delete restrict
);

create table if not exists public.invoice_sequences (
  owner_id uuid not null references auth.users(id) on delete cascade,
  year integer not null,
  next_value integer not null default 1,
  primary key(owner_id, year)
);

create table if not exists public.return_sequences (
  owner_id uuid not null references auth.users(id) on delete cascade,
  year integer not null,
  next_value integer not null default 1,
  primary key(owner_id, year)
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  invoice_number text not null,
  sale_date date not null,
  net_total numeric(12,2) not null check (net_total between 0 and 1000000000),
  status text not null default 'CONFIRMED' check (status in ('CONFIRMED','VOIDED')),
  notes text,
  void_reason text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, id),
  unique(owner_id, invoice_number)
);

create table if not exists public.sale_items (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null,
  product_id uuid not null,
  product_name_snapshot text not null,
  unit_snapshot text not null,
  purchase_cost_snapshot numeric(16,6) not null,
  cost_total_snapshot numeric(12,2) not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price numeric(12,2) not null,
  line_total numeric(12,2) not null,
  foreign key(owner_id, sale_id) references public.sales(owner_id, id) on delete restrict,
  foreign key(owner_id, product_id) references public.products(owner_id, id) on delete restrict,
  unique(sale_id, product_id)
);

create table if not exists public.returns (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  return_number text not null,
  bill_number text not null,
  sale_id uuid,
  invoice_number text,
  product_id uuid not null,
  product_name_snapshot text not null,
  unit_snapshot text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  refund_amount numeric(12,2) not null check (refund_amount >= 0),
  purchase_cost_snapshot numeric(16,6) not null,
  cost_amount_snapshot numeric(12,2) not null,
  restock boolean not null default true,
  reason text not null,
  movement_date date not null,
  notes text,
  created_at timestamptz not null default now(),
  foreign key(owner_id, sale_id) references public.sales(owner_id, id) on delete restrict,
  foreign key(owner_id, product_id) references public.products(owner_id, id) on delete restrict
);

create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  person_name text not null check (length(trim(person_name)) > 0),
  type text not null check (type in ('GIVEN','TAKEN')),
  amount numeric(12,2) not null check (amount > 0),
  paid_amount numeric(12,2) not null default 0,
  remaining_amount numeric(12,2) not null,
  status text not null default 'OUTSTANDING' check (status in ('OUTSTANDING','SETTLED')),
  loan_date date not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, id)
);

create table if not exists public.loan_settlements (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  loan_id uuid not null,
  amount numeric(12,2) not null check (amount > 0),
  settlement_date date not null,
  notes text,
  created_at timestamptz not null default now(),
  foreign key(owner_id, loan_id) references public.loans(owner_id, id) on delete restrict
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  details text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_product_idx on public.stock_movements(owner_id, product_id, id);
create index if not exists sales_date_idx on public.sales(owner_id, sale_date desc);
create index if not exists returns_date_idx on public.returns(owner_id, movement_date desc);
create index if not exists loans_date_idx on public.loans(owner_id, loan_date desc);

alter table public.business_settings enable row level security;
alter table public.products enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock_adjustments enable row level security;
alter table public.invoice_sequences enable row level security;
alter table public.return_sequences enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.returns enable row level security;
alter table public.loans enable row level security;
alter table public.loan_settlements enable row level security;
alter table public.audit_log enable row level security;
alter table public.shop_admin enable row level security;

create or replace function public.is_shop_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.shop_admin where user_id = auth.uid())
$$;

create or replace function public.claim_shop_admin()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid := auth.uid(); v_email text := lower(coalesce(auth.jwt() ->> 'email', '')); v_admin uuid;
begin
  if v_user is null then raise exception 'Sign in before claiming shop administration.'; end if;
  select user_id into v_admin from public.shop_admin where singleton = true;
  if v_admin = v_user then return jsonb_build_object('authorized', true); end if;
  if v_email <> 'aziz@gmail.com' then raise exception 'Only the initial aziz@gmail.com account can claim shop administration.'; end if;
  insert into public.shop_admin(singleton, user_id) values(true, v_user) on conflict(singleton) do nothing;
  select user_id into v_admin from public.shop_admin where singleton = true for update;
  if v_admin <> v_user then raise exception 'Shop administration has already been claimed by its single administrator.'; end if;
  return jsonb_build_object('authorized', true);
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['business_settings','products','stock_movements','stock_adjustments','invoice_sequences','return_sequences','sales','sale_items','returns','loans','loan_settlements','audit_log'] loop
    execute format('drop policy if exists owner_access on public.%I', table_name);
    execute format('drop policy if exists owner_read on public.%I', table_name);
    execute format('create policy owner_read on public.%I for select to authenticated using (owner_id = auth.uid() and public.is_shop_admin())', table_name);
  end loop;
end $$;

drop function if exists public.create_product(text,text,numeric,numeric,numeric);
create or replace function public.create_product(p_name text,p_unit text,p_purchase_cost numeric,p_sale_price numeric,p_minimum_stock numeric default 10,p_opening_stock numeric default 0)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid(); v_id uuid := gen_random_uuid();
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before creating a product.'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 160 or length(trim(coalesce(p_unit,''))) not between 1 and 40 then raise exception 'Enter a product name and selling unit.'; end if;
  if p_purchase_cost < 0 or p_purchase_cost > 1000000000 or p_purchase_cost <> round(p_purchase_cost,2) or p_sale_price < 0 or p_sale_price > 1000000000 or p_sale_price <> round(p_sale_price,2) then raise exception 'Product rates must have at most 2 decimal places.'; end if;
  if p_minimum_stock < 0 or p_minimum_stock > 1000000 or p_minimum_stock <> round(p_minimum_stock,3) then raise exception 'Minimum stock must have at most 3 decimal places.'; end if;
  if p_opening_stock < 0 or p_opening_stock > 1000000 or p_opening_stock <> round(p_opening_stock,3) then raise exception 'Opening stock must have at most 3 decimal places.'; end if;
  insert into public.products(id,owner_id,name,unit,purchase_cost,sale_price,minimum_stock)
  values(v_id,v_owner,trim(p_name),trim(p_unit),p_purchase_cost,p_sale_price,p_minimum_stock);
  if p_opening_stock > 0 then
    insert into public.stock_movements(owner_id,product_id,quantity,movement_type,reference_type,reference_id,movement_date,unit_cost,note)
    values(v_owner,v_id,p_opening_stock,'OPENING','OPENING_STOCK','OPEN-'||to_char(current_date,'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),current_date,p_purchase_cost,'Opening inventory');
  end if;
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details) values(v_owner,'PRODUCT_CREATED','PRODUCT',v_id::text,'Created product '||trim(p_name));
  return jsonb_build_object('id',v_id);
end $$;

create or replace function public.update_product(p_product_id uuid,p_name text,p_unit text,p_purchase_cost numeric,p_sale_price numeric,p_minimum_stock numeric,p_active boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid:=auth.uid(); v_product public.products%rowtype; v_stock numeric(12,3);
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before editing products.'; end if;
  select * into v_product from public.products where id=p_product_id and owner_id=v_owner for update;
  if not found then raise exception 'Product not found.'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 160 or length(trim(coalesce(p_unit,''))) not between 1 and 40 then raise exception 'Enter a product name and selling unit.'; end if;
  if p_sale_price<0 or p_sale_price>1000000000 or p_sale_price<>round(p_sale_price,2) then raise exception 'Selling rate must have at most 2 decimal places.'; end if;
  if p_minimum_stock<0 or p_minimum_stock>1000000 or p_minimum_stock<>round(p_minimum_stock,3) then raise exception 'Minimum stock must have at most 3 decimal places.'; end if;
  select coalesce(sum(quantity),0) into v_stock from public.stock_movements where owner_id=v_owner and product_id=p_product_id;
  if exists(select 1 from public.stock_movements where owner_id=v_owner and product_id=p_product_id) and p_unit<>v_product.unit then raise exception 'Unit cannot change after stock history exists.'; end if;
  if p_purchase_cost<0 or p_purchase_cost>1000000000 then raise exception 'Buying rate must be between zero and 1,000,000,000.'; end if;
  if v_stock>0 then
    if p_purchase_cost<>v_product.purchase_cost then raise exception 'Use a stock purchase to update average buying cost.'; end if;
  elsif p_purchase_cost<>round(p_purchase_cost,2) then
    raise exception 'Buying rate must have at most 2 decimal places.';
  end if;
  update public.products set name=trim(p_name),unit=trim(p_unit),purchase_cost=case when v_stock>0 then purchase_cost else p_purchase_cost end,sale_price=p_sale_price,minimum_stock=p_minimum_stock,active=p_active,updated_at=now() where id=p_product_id;
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details) values(v_owner,'PRODUCT_UPDATED','PRODUCT',p_product_id::text,'Updated product '||trim(p_name));
  return jsonb_build_object('id',p_product_id);
end $$;

create or replace function public.save_business_settings(p_business_name text,p_address text,p_phone1 text,p_phone2 text,p_receipt_footer text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before saving settings.'; end if;
  if length(trim(coalesce(p_business_name,''))) = 0 then raise exception 'Business name is required.'; end if;
  insert into public.business_settings(owner_id,business_name,address,phone1,phone2,receipt_footer,updated_at)
  values(v_owner,trim(p_business_name),coalesce(p_address,''),coalesce(p_phone1,''),coalesce(p_phone2,''),coalesce(p_receipt_footer,''),now())
  on conflict(owner_id) do update set business_name=excluded.business_name,address=excluded.address,phone1=excluded.phone1,phone2=excluded.phone2,receipt_footer=excluded.receipt_footer,updated_at=now();
end $$;

create or replace function public.create_sale(p_date date, p_items jsonb, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_year integer := extract(year from p_date)::integer;
  v_seq integer;
  v_invoice text;
  v_sale_id uuid := gen_random_uuid();
  v_total numeric(12,2) := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric(12,3);
  v_price numeric(12,2);
  v_line numeric(12,2);
  v_cost numeric(12,2);
  v_stock numeric(12,3);
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before recording a sale.'; end if;
  if p_date is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Sale must contain at least one item and a valid date.'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'productId' having count(*) > 1) then raise exception 'Each product can appear only once in a sale.'; end if;
  insert into public.invoice_sequences(owner_id, year, next_value) values(v_owner, v_year, 2)
  on conflict(owner_id, year) do update set next_value = public.invoice_sequences.next_value + 1
  returning next_value - 1 into v_seq;
  v_invoice := format('INV-%s-%s', v_year, lpad(v_seq::text, 6, '0'));
  insert into public.sales(id, owner_id, invoice_number, sale_date, net_total, notes)
  values(v_sale_id, v_owner, v_invoice, p_date, 0, nullif(trim(coalesce(p_notes,'')),''));
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'productId' loop
    select * into v_product from public.products where id = (v_item->>'productId')::uuid and owner_id = v_owner for update;
    if not found or not v_product.active then raise exception 'A selected product is missing or inactive.'; end if;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := coalesce((v_item->>'unitPrice')::numeric, v_product.sale_price);
    if v_qty <= 0 or v_qty > 1000000 or v_qty <> round(v_qty,3) then raise exception 'Quantity must be positive and have at most 3 decimal places.'; end if;
    if v_price < 0 or v_price > 1000000000 or v_price <> round(v_price,2) then raise exception 'Sale rate must be valid with at most 2 decimal places.'; end if;
    select coalesce(sum(quantity),0) into v_stock from public.stock_movements where owner_id = v_owner and product_id = v_product.id;
    if v_stock < v_qty then raise exception 'Insufficient stock for %. Available: % %.', v_product.name, v_stock, v_product.unit; end if;
    v_line := round(v_qty * v_price, 2);
    v_cost := round(v_qty * v_product.purchase_cost, 2);
    v_total := round(v_total + v_line, 2);
    if v_total > 1000000000 then raise exception 'A bill total cannot exceed Rs. 1,000,000,000.'; end if;
    insert into public.sale_items(owner_id, sale_id, product_id, product_name_snapshot, unit_snapshot, purchase_cost_snapshot, cost_total_snapshot, quantity, unit_price, line_total)
    values(v_owner, v_sale_id, v_product.id, v_product.name, v_product.unit, v_product.purchase_cost, v_cost, v_qty, v_price, v_line);
    insert into public.stock_movements(owner_id, product_id, quantity, movement_type, reference_type, reference_id, movement_date, unit_cost, note)
    values(v_owner, v_product.id, -v_qty, 'SALE', 'SALE_INVOICE', v_invoice, p_date, v_product.purchase_cost, 'Sale '||v_invoice);
  end loop;
  update public.sales set net_total = v_total, updated_at = now() where id = v_sale_id;
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details) values(v_owner,'SALE_CONFIRMED','SALE',v_invoice,'Confirmed sale. Total Rs. '||v_total);
  return jsonb_build_object('id',v_sale_id,'invoiceNumber',v_invoice,'netTotal',v_total);
end $$;

create or replace function public.record_stock(p_product_id uuid, p_quantity numeric, p_purchase_cost numeric, p_date date, p_movement_type text default 'PURCHASE', p_reference text default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid := auth.uid(); v_product public.products%rowtype; v_stock numeric(12,3); v_ref text; v_cost numeric(16,6);
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before recording stock.'; end if;
  select * into v_product from public.products where id=p_product_id and owner_id=v_owner for update;
  if not found then raise exception 'Product not found.'; end if;
  if p_quantity <= 0 or p_quantity > 1000000 or p_quantity <> round(p_quantity,3) then raise exception 'Stock quantity must be positive with at most 3 decimals.'; end if;
  if p_purchase_cost < 0 or p_purchase_cost > 1000000000 or p_purchase_cost <> round(p_purchase_cost,2) then raise exception 'Buying rate must have at most 2 decimals.'; end if;
  if p_movement_type not in ('OPENING','PURCHASE') then raise exception 'Invalid stock movement type.'; end if;
  select coalesce(sum(quantity),0) into v_stock from public.stock_movements where owner_id=v_owner and product_id=p_product_id;
  v_cost := round(((v_stock*v_product.purchase_cost)+(p_quantity*p_purchase_cost))/(v_stock+p_quantity),6);
  update public.products set purchase_cost=v_cost,updated_at=now() where id=p_product_id;
  v_ref := coalesce(
    nullif(trim(p_reference), ''),
    (case when p_movement_type = 'OPENING' then 'OPEN-' else 'PUR-' end)
      || to_char(p_date, 'YYYYMMDD')
      || '-'
      || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  );
  insert into public.stock_movements(owner_id,product_id,quantity,movement_type,reference_type,reference_id,movement_date,unit_cost,note)
  values(v_owner,p_product_id,p_quantity,p_movement_type,case when p_movement_type='OPENING' then 'OPENING_STOCK' else 'PURCHASE_RECEIPT' end,v_ref,p_date,p_purchase_cost,coalesce(nullif(trim(p_notes),''),v_ref));
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details) values(v_owner,'STOCK_RECORDED','STOCK_MOVEMENT',v_ref,'Added '||p_quantity||' '||v_product.unit||' of '||v_product.name);
  return jsonb_build_object('reference',v_ref,'stock',v_stock+p_quantity,'averageCost',v_cost);
end $$;

create or replace function public.create_return(p_date date, p_reason text, p_items jsonb, p_sale_id uuid default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid:=auth.uid(); v_sale public.sales%rowtype; v_item jsonb; v_product public.products%rowtype; v_sale_item public.sale_items%rowtype; v_qty numeric(12,3); v_refund numeric(12,2); v_cost numeric(12,2); v_prev_qty numeric(12,3); v_prev_refund numeric(12,2); v_prev_cost numeric(12,2); v_remaining numeric(12,3); v_restock boolean; v_bill text; v_seq integer; v_year integer:=extract(year from p_date)::integer; v_count integer:=0; v_total numeric(12,2):=0; v_rec_id bigint; v_stock numeric(12,3);
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before recording a return.'; end if;
  if p_date is null or length(trim(coalesce(p_reason,'')))=0 or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Enter a date, reason, and at least one return item.'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'productId' having count(*)>1) then raise exception 'Each product can appear only once per return bill.'; end if;
  if p_sale_id is not null then
    select * into v_sale from public.sales where id=p_sale_id and owner_id=v_owner for update;
    if not found or v_sale.status<>'CONFIRMED' then raise exception 'Choose a saved, non-cancelled sale.'; end if;
    if p_date<v_sale.sale_date then raise exception 'Return date cannot be before the sale date.'; end if;
  end if;
  insert into public.return_sequences(owner_id,year,next_value) values(v_owner,v_year,2)
  on conflict(owner_id,year) do update set next_value=public.return_sequences.next_value+1 returning next_value-1 into v_seq;
  v_bill:=format('RET-%s-%s',v_year,lpad(v_seq::text,6,'0'));
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'productId' loop
    select * into v_product from public.products where id=(v_item->>'productId')::uuid and owner_id=v_owner for update;
    if not found then raise exception 'Return product not found.'; end if;
    v_qty:=(v_item->>'quantity')::numeric; v_restock:=coalesce((v_item->>'restock')::boolean,true);
    if v_qty<=0 or v_qty>1000000 or v_qty<>round(v_qty,3) then raise exception 'Return quantity must be positive with at most 3 decimals.'; end if;
    if p_sale_id is not null then
      select * into v_sale_item from public.sale_items where owner_id=v_owner and sale_id=p_sale_id and product_id=v_product.id;
      if not found then raise exception 'This product was not on the selected invoice.'; end if;
      select coalesce(sum(quantity),0),coalesce(sum(refund_amount),0),coalesce(sum(cost_amount_snapshot),0) into v_prev_qty,v_prev_refund,v_prev_cost from public.returns where owner_id=v_owner and sale_id=p_sale_id and product_id=v_product.id;
      v_remaining:=v_sale_item.quantity-v_prev_qty;
      if v_qty>v_remaining then raise exception 'Only % % can still be returned.',v_remaining,v_sale_item.unit_snapshot; end if;
      v_refund:=case when v_qty=v_remaining then round(v_sale_item.line_total-v_prev_refund,2) else least(round(v_sale_item.line_total-v_prev_refund,2),round(v_qty*v_sale_item.unit_price,2)) end;
      v_cost:=case when v_qty=v_remaining then round(v_sale_item.cost_total_snapshot-v_prev_cost,2) else least(round(v_sale_item.cost_total_snapshot-v_prev_cost,2),round(v_qty*v_sale_item.purchase_cost_snapshot,2)) end;
      v_product.name:=v_sale_item.product_name_snapshot; v_product.unit:=v_sale_item.unit_snapshot; v_product.purchase_cost:=v_sale_item.purchase_cost_snapshot;
    else
      v_refund:=(v_item->>'refundAmount')::numeric;
      if v_refund<0 or v_refund>1000000000 or v_refund<>round(v_refund,2) then raise exception 'Enter a valid refund with at most 2 decimals.'; end if;
      v_cost:=round(v_qty*v_product.purchase_cost,2);
    end if;
    insert into public.returns(owner_id,return_number,bill_number,sale_id,invoice_number,product_id,product_name_snapshot,unit_snapshot,quantity,refund_amount,purchase_cost_snapshot,cost_amount_snapshot,restock,reason,movement_date,notes)
    values(v_owner,v_bill,v_bill,p_sale_id,case when p_sale_id is not null then v_sale.invoice_number else null end,v_product.id,v_product.name,v_product.unit,v_qty,v_refund,v_product.purchase_cost,v_cost,v_restock,trim(p_reason),p_date,nullif(trim(coalesce(p_notes,'')),'')) returning id into v_rec_id;
    if v_restock then
      select coalesce(sum(quantity),0) into v_stock from public.stock_movements where owner_id=v_owner and product_id=v_product.id;
      update public.products set purchase_cost=round(((v_stock*purchase_cost)+(v_qty*v_product.purchase_cost))/(v_stock+v_qty),6),updated_at=now() where id=v_product.id;
      insert into public.stock_movements(owner_id,product_id,quantity,movement_type,reference_type,reference_id,movement_date,unit_cost,note)
      values(v_owner,v_product.id,v_qty,'RETURN','RETURN_RECORD',v_bill,p_date,v_product.purchase_cost,'Return: '||trim(p_reason));
    end if;
    v_total:=v_total+v_refund; v_count:=v_count+1;
  end loop;
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details) values(v_owner,'RETURN_RECORDED','RETURN',v_bill,'Recorded '||v_count||' return line(s). Refund Rs. '||v_total);
  return jsonb_build_object('billNumber',v_bill,'items',v_count,'refundTotal',round(v_total,2));
end $$;

create or replace function public.create_loan(p_person_name text,p_type text,p_amount numeric,p_date date,p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid:=auth.uid(); v_id uuid:=gen_random_uuid();
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before recording money.'; end if;
  if length(trim(coalesce(p_person_name,'')))=0 or p_type not in ('GIVEN','TAKEN') or p_amount<=0 or p_amount>1000000000 or p_amount<>round(p_amount,2) then raise exception 'Enter a name, type and valid amount.'; end if;
  insert into public.loans(id,owner_id,person_name,type,amount,paid_amount,remaining_amount,status,loan_date,notes)
  values(v_id,v_owner,trim(p_person_name),p_type,p_amount,0,p_amount,'OUTSTANDING',p_date,nullif(trim(coalesce(p_notes,'')),''));
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details) values(v_owner,'LOAN_CREATED','LOAN',v_id::text,'Created '||p_type||' record of Rs. '||p_amount);
  return jsonb_build_object('id',v_id,'remainingAmount',p_amount);
end $$;

create or replace function public.settle_loan(p_loan_id uuid,p_amount numeric,p_date date,p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid:=auth.uid(); v_loan public.loans%rowtype; v_paid numeric(12,2); v_remaining numeric(12,2);
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before recording repayment.'; end if;
  select * into v_loan from public.loans where id=p_loan_id and owner_id=v_owner for update;
  if not found then raise exception 'Money record not found.'; end if;
  if p_amount<=0 or p_amount<>round(p_amount,2) or p_amount>v_loan.remaining_amount then raise exception 'Repayment must be positive and no greater than the remaining balance.'; end if;
  if p_date<v_loan.loan_date then raise exception 'Repayment date cannot be before the original record.'; end if;
  v_paid:=round(v_loan.paid_amount+p_amount,2); v_remaining:=round(v_loan.remaining_amount-p_amount,2);
  insert into public.loan_settlements(owner_id,loan_id,amount,settlement_date,notes) values(v_owner,p_loan_id,p_amount,p_date,nullif(trim(coalesce(p_notes,'')),''));
  update public.loans set paid_amount=v_paid,remaining_amount=v_remaining,status=case when v_remaining=0 then 'SETTLED' else 'OUTSTANDING' end,updated_at=now() where id=p_loan_id;
  return jsonb_build_object('paidAmount',v_paid,'remainingAmount',v_remaining);
end $$;

create or replace function public.adjust_stock(p_product_id uuid,p_adjustment_type text,p_quantity numeric,p_physical_count numeric,p_reason text,p_date date,p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid:=auth.uid(); v_product public.products%rowtype; v_stock numeric(12,3); v_adjustment numeric(12,3); v_physical numeric(12,3); v_number text;
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before adjusting stock.'; end if;
  if length(trim(coalesce(p_reason,'')))=0 then raise exception 'A stock adjustment reason is required.'; end if;
  select * into v_product from public.products where id=p_product_id and owner_id=v_owner for update;
  if not found then raise exception 'Product not found.'; end if;
  select coalesce(sum(quantity),0) into v_stock from public.stock_movements where owner_id=v_owner and product_id=p_product_id;
  if p_adjustment_type='PHYSICAL' then
    if p_physical_count is null or p_physical_count<0 or p_physical_count>1000000 or p_physical_count<>round(p_physical_count,3) then raise exception 'Physical count must be between 0 and 1,000,000 with at most 3 decimals.'; end if;
    v_physical:=p_physical_count; v_adjustment:=round(v_physical-v_stock,3);
  elsif p_adjustment_type in ('INCREASE','DECREASE') then
    if p_quantity is null or p_quantity<=0 or p_quantity>1000000 or p_quantity<>round(p_quantity,3) then raise exception 'Adjustment quantity must be positive with at most 3 decimals.'; end if;
    v_adjustment:=case when p_adjustment_type='INCREASE' then p_quantity else -p_quantity end;
    v_physical:=round(v_stock+v_adjustment,3);
  else
    raise exception 'Choose a valid adjustment method.';
  end if;
  if v_adjustment=0 then raise exception 'Physical count matches the recorded stock. No adjustment needed.'; end if;
  if v_physical<0 then raise exception 'Stock cannot be reduced below zero.'; end if;
  v_number:='ADJ-'||to_char(p_date,'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  insert into public.stock_adjustments(owner_id,adjustment_number,product_id,previous_stock,physical_count,adjustment_quantity,reason,movement_date)
  values(v_owner,v_number,p_product_id,v_stock,v_physical,v_adjustment,trim(p_reason),p_date);
  insert into public.stock_movements(owner_id,product_id,quantity,movement_type,reference_type,reference_id,movement_date,unit_cost,note)
  values(v_owner,p_product_id,v_adjustment,'ADJUSTMENT','STOCK_ADJUSTMENT',v_number,p_date,v_product.purchase_cost,trim(p_reason)||case when nullif(trim(coalesce(p_notes,'')),'') is null then '' else ' - '||trim(p_notes) end);
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details)
  values(v_owner,'STOCK_ADJUSTED','STOCK_ADJUSTMENT',v_number,v_product.name||': '||v_stock||' to '||v_physical||' '||v_product.unit||'. '||trim(p_reason));
  return jsonb_build_object('adjustmentNumber',v_number,'previousStock',v_stock,'physicalCount',v_physical,'adjustmentQuantity',v_adjustment);
end $$;

create or replace function public.reset_shop_data(p_confirmation text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Only the shop administrator can reset business data.'; end if;
  if p_confirmation <> 'RESET AZIZ SHOP' then raise exception 'Type RESET AZIZ SHOP to confirm the full reset.'; end if;
  delete from public.loan_settlements where owner_id=v_owner;
  delete from public.loans where owner_id=v_owner;
  delete from public.returns where owner_id=v_owner;
  delete from public.sale_items where owner_id=v_owner;
  delete from public.sales where owner_id=v_owner;
  delete from public.stock_adjustments where owner_id=v_owner;
  delete from public.stock_movements where owner_id=v_owner;
  delete from public.invoice_sequences where owner_id=v_owner;
  delete from public.return_sequences where owner_id=v_owner;
  delete from public.products where owner_id=v_owner;
  delete from public.business_settings where owner_id=v_owner;
  delete from public.audit_log where owner_id=v_owner;
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details)
  values(v_owner,'BUSINESS_DATA_RESET','ADMIN',v_owner::text,'Administrator reset all shop data.');
  return jsonb_build_object('reset',true);
end $$;

revoke all on function public.is_shop_admin() from public, anon;
revoke all on function public.claim_shop_admin() from public, anon;
revoke all on function public.create_product(text,text,numeric,numeric,numeric,numeric) from public, anon;
revoke all on function public.update_product(uuid,text,text,numeric,numeric,numeric,boolean) from public, anon;
revoke all on function public.save_business_settings(text,text,text,text,text) from public, anon;
revoke all on function public.create_sale(date,jsonb,text) from public, anon;
revoke all on function public.record_stock(uuid,numeric,numeric,date,text,text,text) from public, anon;
revoke all on function public.create_return(date,text,jsonb,uuid,text) from public, anon;
revoke all on function public.create_loan(text,text,numeric,date,text) from public, anon;
revoke all on function public.settle_loan(uuid,numeric,date,text) from public, anon;
revoke all on function public.adjust_stock(uuid,text,numeric,numeric,text,date,text) from public, anon;
revoke all on function public.reset_shop_data(text) from public, anon;
grant execute on function public.is_shop_admin() to authenticated;
grant execute on function public.claim_shop_admin() to authenticated;
grant execute on function public.create_product(text,text,numeric,numeric,numeric,numeric) to authenticated;
grant execute on function public.update_product(uuid,text,text,numeric,numeric,numeric,boolean) to authenticated;
grant execute on function public.save_business_settings(text,text,text,text,text) to authenticated;
grant execute on function public.create_sale(date,jsonb,text) to authenticated;
grant execute on function public.record_stock(uuid,numeric,numeric,date,text,text,text) to authenticated;
grant execute on function public.create_return(date,text,jsonb,uuid,text) to authenticated;
grant execute on function public.create_loan(text,text,numeric,date,text) to authenticated;
grant execute on function public.settle_loan(uuid,numeric,date,text) to authenticated;
grant execute on function public.adjust_stock(uuid,text,numeric,numeric,text,date,text) to authenticated;
grant execute on function public.reset_shop_data(text) to authenticated;