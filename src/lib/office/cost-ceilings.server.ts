/**
 * Founder-controlled cost ceilings for the model budget.
 *
 * The office reads these at admission time and can never write them. A level
 * with no row falls back to the documented default in `cost.ts`, so a fresh
 * office keeps its original envelope.
 */
import { getSql } from "../db";
import { CAPSULE_BUDGET_CENTS, DAILY_BUDGET_CENTS, FIRE_BUDGET_CENTS, MONTHLY_BUDGET_CENTS } from "./cost";

const DEFAULTS: Record<string, number> = {
  capsule: CAPSULE_BUDGET_CENTS,
  fire: FIRE_BUDGET_CENTS,
  daily: DAILY_BUDGET_CENTS,
  monthly: MONTHLY_BUDGET_CENTS,
};

export async function ensureCostCeilings(): Promise<void> {
  const sql = await getSql();
  await sql`
    create table if not exists cost_ceilings (
      level text primary key,
      ceiling_cents integer not null,
      updated_at timestamptz not null default now(),
      updated_by text not null default 'founder'
    )
  `;
}

export async function readCostCeilings(): Promise<Record<string, number>> {
  await ensureCostCeilings();
  const sql = await getSql();
  const rows = await sql<{ level: string; ceiling_cents: number }>`
    select level, ceiling_cents from cost_ceilings
  `;
  const out: Record<string, number> = { ...DEFAULTS };
  for (const row of rows) {
    if (row.level in DEFAULTS) out[row.level] = Number(row.ceiling_cents);
  }
  return out;
}

export async function writeCostCeilings(
  input: Partial<Record<"capsule" | "fire" | "daily" | "monthly", number>>,
  updatedBy: string,
): Promise<void> {
  await ensureCostCeilings();
  const sql = await getSql();
  for (const level of ["capsule", "fire", "daily", "monthly"] as const) {
    const value = input[level];
    if (value === undefined || !Number.isFinite(value) || value < 0) continue;
    await sql`
      insert into cost_ceilings (level, ceiling_cents, updated_at, updated_by)
      values (${level}, ${Math.trunc(value)}, now(), ${updatedBy})
      on conflict (level) do update
        set ceiling_cents = excluded.ceiling_cents,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
    `;
  }
}
