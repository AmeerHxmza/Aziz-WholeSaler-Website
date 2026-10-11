-- Apply after 001, 002, 003. Back up existing data before upgrading.
-- Operations and their receipts commit in one PostgreSQL transaction.
create table if not exists public.sync_operations (
 owner_id uuid not null references auth.users(id), operation_id uuid not null,
 operation_type text not null, payload jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(), primary key(owner_id, operation_id)
);
alter table public.sync_operations enable row level security;
revoke all on public.sync_operations from anon, authenticated;
alter table public.sale_items add column if not exists client_id uuid unique;
alter table public.return_items add column if not exists client_id uuid unique;
alter table public.return_items add column if not exists restock boolean not null default true;
-- Backfill legacy 001 snapshots. CONFIRMED is the legacy-only sale status.
update public.sale_items si set unit_sale_price=si.unit_price,
 unit_cost_snapshot=si.purchase_cost_snapshot, original_profit=si.line_total-si.cost_total_snapshot
from public.sales s where s.id=si.sale_id and s.status='CONFIRMED';
update public.sales s set subtotal=s.net_total,total=s.net_total,
 original_profit=(select coalesce(sum(si.original_profit),0) from public.sale_items si where si.sale_id=s.id)
where s.status='CONFIRMED' and s.total=0;
update public.products p set current_stock=(select coalesce(sum(m.quantity),0) from public.stock_movements m where m.product_id=p.id)
where not exists(select 1 from public.inventory_movements im where im.product_id=p.id);
-- Reconstruct every linked legacy return line, including multi-product bills
-- that older migration 002 copied only partially. Keep unlinked rows archived.
do $$
declare header record; new_id uuid;
begin
 if exists(select 1 from information_schema.tables ist where ist.table_schema='public' and ist.table_name='returns_legacy') then
   for header in select owner_id,return_number,sale_id,min(bill_number) as bill_number,min(invoice_number) as invoice_number,min(movement_date) as movement_date,min(reason) as reason,min(created_at) as created_at from public.returns_legacy where sale_id is not null group by owner_id,return_number,sale_id loop
     select id into new_id from public.returns where owner_id=header.owner_id and return_number=header.return_number;
     if new_id is null then
       new_id:=gen_random_uuid();
       insert into public.returns(id,owner_id,return_number,bill_number,sale_id,invoice_number,return_date,movement_date,refund_total,profit_reversed,reason,created_at,created_by)
       values(new_id,header.owner_id,header.return_number,header.bill_number,header.sale_id,header.invoice_number,header.movement_date,header.movement_date,0,0,header.reason,header.created_at,header.owner_id);
     end if;
     delete from public.return_items where return_id=new_id;
     insert into public.return_items(return_id,sale_item_id,product_id,quantity_returned,unit_sale_price_snapshot,unit_cost_snapshot,refund_amount,profit_reversed,restock,created_at)
     select new_id,si.id,l.product_id,l.quantity,round(l.refund_amount/l.quantity,2),si.unit_cost_snapshot,l.refund_amount,
       l.refund_amount-case when l.restock then round(l.quantity*si.unit_cost_snapshot,2) else 0 end,l.restock,l.created_at
     from public.returns_legacy l join public.sale_items si on si.sale_id=l.sale_id and si.product_id=l.product_id
     where l.owner_id=header.owner_id and l.return_number=header.return_number;
     update public.returns set refund_total=(select coalesce(sum(refund_amount),0) from public.return_items where return_id=new_id),profit_reversed=(select coalesce(sum(profit_reversed),0) from public.return_items where return_id=new_id) where id=new_id;
   end loop;
 end if;
end $$;
update public.sales s set net_total=s.total-(select coalesce(sum(r.refund_total),0) from public.returns r where r.sale_id=s.id),
 status=case when not exists(select 1 from public.sale_items si where si.sale_id=s.id and si.quantity>(select coalesce(sum(ri.quantity_returned),0) from public.return_items ri where ri.sale_item_id=si.id)) then 'FULLY_RETURNED' else 'PARTIALLY_RETURNED' end
where s.status='CONFIRMED' and exists(select 1 from public.returns r where r.sale_id=s.id);
alter view public.sale_balances set (security_invoker = true);
alter view public.sale_item_balances set (security_invoker = true);


create or replace function public.add_stock(
  p_items jsonb,
  p_entry_date date default current_date,
  p_supplier text default null,
  p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_entry_id uuid := coalesce(nullif(current_setting('aziz.entity_id', true), '')::uuid, gen_random_uuid());
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

    if v_qty <= 0 or v_qty > 1000000 or v_qty <> trunc(v_qty) then
      raise exception 'Quantity for % must be positive whole numbers.', v_product.name;
    end if;
    if v_cost < 0 or v_cost > 1000000000 or v_cost <> trunc(v_cost) then
      raise exception 'Purchase cost for % must be between 0 and 1,000,000,000 as whole numbers.', v_product.name;
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
  v_invoice text := coalesce(nullif(current_setting('aziz.document_number', true), ''), format('AS-%s', v_seq));
  v_sale_id uuid := coalesce(nullif(current_setting('aziz.entity_id', true), '')::uuid, gen_random_uuid());
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

    if v_qty <= 0 or v_qty > 1000000 or v_qty <> trunc(v_qty) then
      raise exception 'Quantity for % must be positive whole numbers.', v_product.name;
    end if;
    if v_price < 0 or v_price > 1000000000 or v_price <> trunc(v_price) then
      raise exception 'Selling rate for % must be valid whole numbers.', v_product.name;
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
      client_id, owner_id, sale_id, product_id, product_name_snapshot, unit_snapshot,
      quantity, unit_sale_price, unit_cost_snapshot, line_total, original_profit,
      purchase_cost_snapshot, cost_total_snapshot, unit_price
    )
    values(
      coalesce((v_item->>'id')::uuid, gen_random_uuid()), v_owner, v_sale_id, v_product.id, v_product.name, v_product.unit,
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
  v_return_num text := coalesce(nullif(current_setting('aziz.document_number', true), ''), format('RT-%s', v_seq));
  v_return_id uuid := coalesce(nullif(current_setting('aziz.entity_id', true), '')::uuid, gen_random_uuid());
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
  v_restock boolean;
  v_cost numeric;
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
    if v_qty <= 0 or v_qty > 1000000 or v_qty <> trunc(v_qty) then
      raise exception 'Return quantity for % must be positive whole numbers.', v_sale_item.product_name_snapshot;
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
    v_restock := coalesce((v_item->>'restock')::boolean, true);
    v_item_refund := case when v_qty = v_remaining then v_sale_item.line_total - (select coalesce(sum(refund_amount),0) from public.return_items where sale_item_id=v_sale_item.id) else round(v_qty * v_sale_item.unit_sale_price,2) end;
    v_cost := case when v_qty = v_remaining then round(v_sale_item.quantity*v_sale_item.unit_cost_snapshot,2) - (select coalesce(sum(round(quantity_returned*unit_cost_snapshot,2)),0) from public.return_items where sale_item_id=v_sale_item.id) else round(v_qty*v_sale_item.unit_cost_snapshot,2) end;
    v_item_profit_reversed := v_item_refund - case when v_restock then v_cost else 0 end;

    v_refund_total := round(v_refund_total + v_item_refund, 2);
    v_profit_reversed := round(v_profit_reversed + v_item_profit_reversed, 2);

    -- Insert return_items row referencing original sale item
    insert into public.return_items(
      client_id, restock, return_id, sale_item_id, product_id, quantity_returned,
      unit_sale_price_snapshot, unit_cost_snapshot, refund_amount, profit_reversed
    )
    values(
      coalesce((v_item->>'id')::uuid,gen_random_uuid()), v_restock, v_return_id, v_sale_item.id, v_product.id, v_qty,
      v_sale_item.unit_sale_price, v_sale_item.unit_cost_snapshot, v_item_refund, v_item_profit_reversed
    );

    if v_restock then
    -- Restore stock atomically
    update public.products
    set average_cost = round((current_stock*average_cost + v_qty*v_sale_item.unit_cost_snapshot)/(current_stock+v_qty),6), current_stock = current_stock + v_qty, updated_at = now()
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

    end if;
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
    net_total = total - (select coalesce(sum(refund_total),0) from public.returns where sale_id=v_sale.id),
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

create or replace function public.create_loan(p_person_name text,p_type text,p_amount numeric,p_date date,p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid:=auth.uid(); v_id uuid:=coalesce(nullif(current_setting('aziz.entity_id', true),'')::uuid,gen_random_uuid());
begin
  if v_owner is null or not public.is_shop_admin() then raise exception 'Sign in as the shop administrator before recording money.'; end if;
  if length(trim(coalesce(p_person_name,'')))=0 or p_type not in ('GIVEN','TAKEN') or p_amount<=0 or p_amount>1000000000 or p_amount<>trunc(p_amount) then raise exception 'Enter a name, type and valid amount.'; end if;
  insert into public.loans(id,owner_id,person_name,type,amount,paid_amount,remaining_amount,status,loan_date,notes)
  values(v_id,v_owner,trim(p_person_name),p_type,p_amount,0,p_amount,'OUTSTANDING',p_date,nullif(trim(coalesce(p_notes,'')),''));
  insert into public.audit_log(owner_id,action,entity_type,entity_id,details) values(v_owner,'LOAN_CREATED','LOAN',v_id::text,'Created '||p_type||' record of Rs. '||p_amount);
  return jsonb_build_object('id',v_id,'remainingAmount',p_amount);
end $$;

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
  if p_purchase_cost < 0 or p_purchase_cost > 1000000000 or p_purchase_cost <> trunc(p_purchase_cost) or
     p_sale_price < 0 or p_sale_price > 1000000000 or p_sale_price <> trunc(p_sale_price) then
    raise exception 'Rates must be between 0 and 1,000,000,000 as whole numbers.';
  end if;
  if p_minimum_stock < 0 or p_minimum_stock > 1000000 or p_minimum_stock <> trunc(p_minimum_stock) or
     p_opening_stock < 0 or p_opening_stock > 1000000 or p_opening_stock <> trunc(p_opening_stock) then
    raise exception 'Stock quantities must be between 0 and 1,000,000 as whole numbers.';
  end if;

  -- 1. Check if a product with the same name already exists for this owner
  select id into v_existing_id from public.products
  where owner_id = v_owner and lower(trim(name)) = lower(trim(p_name))
  limit 1;

  if v_existing_id is not null then raise exception 'Product name already exists. Use the existing product.'; end if;

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


create or replace function public.sync_shop_operation(p_operation_id uuid, p_type text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid:=auth.uid(); v_existing public.sync_operations%rowtype; v_result jsonb; v_product public.products%rowtype; v_item jsonb; v_number numeric; v_key text;
begin
 if v_owner is null or not public.is_shop_admin() then raise exception 'Administrator login required.'; end if;
 -- Serializes sync and snapshot requests for this shop, including other laptops.
 perform pg_advisory_xact_lock(hashtextextended(v_owner::text,0));
 select * into v_existing from public.sync_operations where owner_id=v_owner and operation_id=p_operation_id;
 if found then
   if v_existing.operation_type<>p_type or v_existing.payload<>p_payload then raise exception 'Operation ID reused with different data.'; end if;
   return v_existing.result;
 end if;
 if p_operation_id is null or coalesce((p_payload->>'protocol')::int,0)<>2 then raise exception 'Legacy queue requires reconciliation before upload.'; end if;
 -- Validate JSON before assigning to scaled NUMERIC variables (which round on assignment).
 for v_item in select value from jsonb_array_elements(coalesce(p_payload->'items','[]'::jsonb)) loop
   if (v_item->>'quantity')::numeric <> trunc((v_item->>'quantity')::numeric) then raise exception 'Quantity must be a whole number.'; end if;
   if v_item ? 'unitPrice' and (v_item->>'unitPrice')::numeric <> trunc((v_item->>'unitPrice')::numeric) then raise exception 'Price must be a whole number.'; end if;
 end loop;
 foreach v_key in array array['amount','quantity','physicalCount','salePrice','minimumStock','openingStock'] loop
   if p_payload ? v_key and p_payload->>v_key is not null then
     v_number := (p_payload->>v_key)::numeric;
     if v_number < 0 or v_number <> trunc(v_number) then raise exception '% must be a non-negative whole number.',v_key; end if;
   end if;
 end loop;
 perform set_config('aziz.entity_id',coalesce(p_payload->>'id',''),true);
 perform set_config('aziz.document_number',coalesce(p_payload->>'invoice_number',p_payload->>'return_number',''),true);
 case p_type
 when 'CREATE_PRODUCT' then
   v_result:=public.create_product(p_payload->>'name',p_payload->>'unit',(p_payload->>'purchaseCost')::numeric,(p_payload->>'salePrice')::numeric,(p_payload->>'minimumStock')::numeric,(p_payload->>'openingStock')::numeric,null,(p_payload->>'id')::uuid);
 when 'UPDATE_PRODUCT' then
   select * into v_product from public.products where id=(p_payload->>'id')::uuid and owner_id=v_owner for update;
   if not found then raise exception 'Product no longer exists.'; end if;
   if p_payload ? 'expected' and jsonb_build_object('name',v_product.name,'unit',v_product.unit,'sale_price',v_product.sale_price,'minimum_stock',v_product.minimum_stock,'active',v_product.active) <> p_payload->'expected' then raise exception 'CONFLICT: Product was edited on another device. Review both versions.'; end if;
   if v_product.unit<>p_payload->>'unit' then raise exception 'Product unit cannot change.'; end if;
   if exists(select 1 from public.products where owner_id=v_owner and id<>v_product.id and lower(trim(name))=lower(trim(p_payload->>'name'))) then raise exception 'Product name already exists.'; end if;
   v_result:=public.update_product(v_product.id,p_payload->>'name',p_payload->>'unit',(p_payload->>'purchaseCost')::numeric,(p_payload->>'salePrice')::numeric,(p_payload->>'minimumStock')::numeric,(p_payload->>'active')::boolean,null);
 when 'CREATE_SALE' then
   v_result:=public.create_sale((p_payload->>'sale_date')::date,p_payload->'items',p_payload->>'customer_name',p_payload->>'customer_phone',p_payload->>'notes');
 when 'CREATE_RETURN' then
   v_result:=public.create_return((p_payload->>'sale_id')::uuid,(p_payload->>'date')::date,p_payload->'items',p_payload->>'reason',null);
 when 'RECORD_STOCK' then
   if (p_payload->>'quantity')::numeric<>trunc((p_payload->>'quantity')::numeric) or (p_payload->>'purchaseCost')::numeric<>trunc((p_payload->>'purchaseCost')::numeric) then raise exception 'Stock and buying price must be whole numbers.'; end if;
   v_result:=public.record_stock((p_payload->>'productId')::uuid,(p_payload->>'quantity')::numeric,(p_payload->>'purchaseCost')::numeric,(p_payload->>'date')::date,p_payload->>'movementType',null,p_payload->>'notes');
 when 'ADJUST_STOCK' then
   select * into v_product from public.products where id=(p_payload->>'productId')::uuid and owner_id=v_owner for update;
   if not found or v_product.current_stock<>(p_payload->>'expectedStock')::numeric then raise exception 'CONFLICT: Stock changed since physical adjustment.'; end if;
   v_result:=public.adjust_stock(v_product.id,p_payload->>'type',(p_payload->>'quantity')::numeric,(p_payload->>'physicalCount')::numeric,p_payload->>'reason',(p_payload->>'date')::date,null);
 when 'CREATE_LOAN' then
   v_result:=public.create_loan(p_payload->>'person',p_payload->>'type',(p_payload->>'amount')::numeric,(p_payload->>'date')::date,null);
 when 'SETTLE_LOAN' then
   v_result:=public.settle_loan((p_payload->>'loanId')::uuid,(p_payload->>'amount')::numeric,(p_payload->>'date')::date,null);
 when 'SAVE_SETTINGS' then
   perform public.save_business_settings(p_payload->>'business_name',p_payload->>'address',p_payload->>'phone1',p_payload->>'phone2',p_payload->>'receipt_footer');
   v_result:='{}'::jsonb;
 else raise exception 'Unsupported operation.';
 end case;
 insert into public.sync_operations(owner_id,operation_id,operation_type,payload,result) values(v_owner,p_operation_id,p_type,p_payload,coalesce(v_result,'{}'::jsonb));
 return v_result;
end $$;
revoke all on function public.sync_shop_operation(uuid,text,jsonb) from public,anon;
grant execute on function public.sync_shop_operation(uuid,text,jsonb) to authenticated;

-- A single snapshot is consistent across all tables; no row-limit truncation or partial commits.
create or replace function public.shop_snapshot()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid:=auth.uid(); result jsonb:='{}'::jsonb; table_name text; rows jsonb;
begin
 if v_owner is null or not public.is_shop_admin() then raise exception 'Administrator login required.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_owner::text,0));
 foreach table_name in array array['products','sales','sale_items','returns','stock_entries','inventory_movements','loans','loan_settlements','business_settings','stock_movements','stock_adjustments','invoice_sequences','return_sequences','audit_log'] loop
   execute format('select coalesce(jsonb_agg(t),''[]''::jsonb) from public.%I t where owner_id=$1',table_name) into rows using v_owner;
   result:=result || jsonb_build_object(table_name,rows);
 end loop;
 select coalesce(jsonb_agg(ri),'[]'::jsonb) into rows from public.return_items ri join public.returns r on r.id=ri.return_id where r.owner_id=v_owner;
 result:=result || jsonb_build_object('return_items',rows);
 select coalesce(jsonb_agg(si),'[]'::jsonb) into rows from public.stock_entry_items si join public.stock_entries s on s.id=si.stock_entry_id where s.owner_id=v_owner;
 result := result || jsonb_build_object('stock_entry_items',rows,'owner_id',v_owner,'snapshot_at',now());
 if exists(select 1 from information_schema.tables ist where ist.table_schema='public' and ist.table_name='returns_legacy') then
   select coalesce(jsonb_agg(t),'[]'::jsonb) into rows from public.returns_legacy t where owner_id=v_owner;
   result:=result || jsonb_build_object('returns_legacy',rows);
 end if;
 return result;
end $$;
revoke all on function public.shop_snapshot() from public,anon;
grant execute on function public.shop_snapshot() to authenticated;


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

  perform pg_advisory_xact_lock(hashtextextended(v_owner::text,0));
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
