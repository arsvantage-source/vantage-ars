/**
 * The general product catalogue.
 *
 * The office sells whatever is in the `products` table, priced by the founder.
 * The legacy hardcoded catalogue in `catalogue.ts` is used only to seed a fresh
 * database, so the original rate card survives the migration and the office
 * keeps selling what it sold before. After that, products are managed from the
 * office and the hardcoded list is never read at runtime.
 */
import { getSql } from "../db";
import { PUBLISHED_RATES } from "./catalogue";

export type Product = {
  id: string;
  title: string;
  scope: string;
  price: string;
  basis: string;
  offered: boolean;
  category: string;
};

export async function ensureProductsTable(): Promise<void> {
  const sql = await getSql();
  await sql`
    create table if not exists products (
      id text primary key,
      title text not null,
      scope text not null default '',
      price text not null default '',
      basis text not null default '',
      offered boolean not null default true,
      category text not null default 'general',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`create index if not exists products_offered_idx on products (offered, category)`;
}

export async function seedProductsIfEmpty(): Promise<void> {
  await ensureProductsTable();
  const sql = await getSql();
  const count = await sql<{ n: number }>`select count(*)::int as n from products`.then((r) => r[0]?.n ?? 0);
  if (count > 0) {
    // warm the cache even when already seeded
    const existing = await listProducts(true);
    OFFERED_CACHE.clear();
    for (const p of existing) if (p.offered) OFFERED_CACHE.add(p.id);
    return;
  }
  for (const rate of PUBLISHED_RATES) {
    await sql`
      insert into products (id, title, scope, price, basis, offered, category)
      values (${rate.id}, ${rate.title}, ${rate.scope}, ${rate.price}, ${rate.basis}, ${rate.offered}, 'general')
      on conflict (id) do nothing
    `;
  }
  const seeded = await listProducts(true);
  OFFERED_CACHE.clear();
  for (const p of seeded) if (p.offered) OFFERED_CACHE.add(p.id);
}

const OFFERED_CACHE = new Set<string>();

export function offeredProductIdsSync(): string[] {
  return [...OFFERED_CACHE];
}

export function isOfferedProductSync(id: string): boolean {
  if (OFFERED_CACHE.has(id)) return true;
  return PUBLISHED_RATES.some((r) => r.id === id && r.offered);
}

export async function listProducts(onlyOffered = false): Promise<Product[]> {
  await seedProductsIfEmpty();
  const sql = await getSql();
  const rows = onlyOffered
    ? await sql<Record<string, unknown>>`select * from products where offered = true order by title asc`
    : await sql<Record<string, unknown>>`select * from products order by title asc`;
  const mapped = rows.map(mapProduct);
  OFFERED_CACHE.clear();
  for (const p of mapped) if (p.offered) OFFERED_CACHE.add(p.id);
  return mapped;
}

export async function getProduct(id: string): Promise<Product | null> {
  await seedProductsIfEmpty();
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`select * from products where id = ${id}`;
  return rows.length ? mapProduct(rows[0]) : null;
}

export async function createProduct(input: Omit<Product, "id"> & { id?: string }): Promise<Product> {
  await ensureProductsTable();
  const sql = await getSql();
  const id = input.id?.trim() || crypto.randomUUID();
  await sql`
    insert into products (id, title, scope, price, basis, offered, category)
    values (${id}, ${input.title}, ${input.scope}, ${input.price}, ${input.basis}, ${input.offered}, ${input.category})
  `;
  const product = await getProduct(id);
  if (!product) throw new Error("Product was not created.");
  return product;
}

export async function updateProduct(id: string, patch: Partial<Omit<Product, "id">>): Promise<Product> {
  await ensureProductsTable();
  const sql = await getSql();
  const current = await getProduct(id);
  if (!current) throw new Error("Product not found.");
  const next = { ...current, ...patch };
  await sql`
    update products
    set title = ${next.title}, scope = ${next.scope}, price = ${next.price},
        basis = ${next.basis}, offered = ${next.offered}, category = ${next.category},
        updated_at = now()
    where id = ${id}
  `;
  const product = await getProduct(id);
  if (!product) throw new Error("Product was not updated.");
  return product;
}

export async function deleteProduct(id: string): Promise<void> {
  await ensureProductsTable();
  const sql = await getSql();
  await sql`delete from products where id = ${id}`;
}

function mapProduct(row: Record<string, unknown>): Product {
  return {
    id: String(row.id),
    title: String(row.title),
    scope: String(row.scope ?? ""),
    price: String(row.price ?? ""),
    basis: String(row.basis ?? ""),
    offered: row.offered === true,
    category: String(row.category ?? "general"),
  };
}
