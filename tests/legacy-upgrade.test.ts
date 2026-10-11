import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Upgrade preserves legacy stock, both return lines, damaged condition and original sale totals', async () => {
  const pg = new PGlite();
  const owner = crypto.randomUUID();
  const migrate = async (name: string) => pg.exec((await readFile(`supabase/migrations/${name}.sql`, 'utf8')).replace(/create extension if not exists pgcrypto;/gi, ''));
  try {
    await pg.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select '${owner}'::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select '{"email":"aziz@gmail.com"}'::jsonb$$;
      insert into auth.users values('${owner}');`);
    await migrate('001_initial_schema');
    await pg.query('select public.claim_shop_admin()');
    const a = (await pg.query<{ value: { id: string } }>("select public.create_product('Legacy A','Box',100,150,1,10) as value")).rows[0].value.id;
    const b = (await pg.query<{ value: { id: string } }>("select public.create_product('Legacy B','Box',50,80,1,10) as value")).rows[0].value.id;
    const sale = (await pg.query<{ value: { id: string } }>("select public.create_sale('2026-01-01',$1,null) as value", [JSON.stringify([{ productId: a, quantity: 2 }, { productId: b, quantity: 2 }])])).rows[0].value.id;
    await pg.query("select public.create_return('2026-01-02','Legacy multi return',$1,$2,null)", [JSON.stringify([{ productId: a, quantity: 1 }, { productId: b, quantity: 1, restock: false }]), sale]);
    for (const migration of ['002_wholesale_core','003_fix_reset_shop_data','004_durable_offline_sync']) await migrate(migration);
    const quantities = await pg.query<{ name: string; current_stock: string }>('select name,current_stock from public.products order by name');
    assert.deepEqual(quantities.rows.map(r => Number(r.current_stock)), [9, 8]);
    const header = (await pg.query<{ total: string; net_total: string; original_profit: string }>('select total,net_total,original_profit from public.sales')).rows[0];
    assert.equal(Number(header.total), 460);
    assert.equal(Number(header.net_total), 230);
    assert.equal(Number(header.original_profit), 160);
    const returns = await pg.query<{ refund_amount: string; restock: boolean }>('select refund_amount,restock from public.return_items');
    assert.equal(returns.rows.length, 2);
    assert.equal(returns.rows.filter(r => !r.restock).length, 1);
    assert.equal(returns.rows.reduce((n, r) => n + Number(r.refund_amount), 0), 230);
  } finally { await pg.close(); }
});
