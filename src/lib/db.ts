/** Thin helpers over D1. D1 rejects `undefined` bindings, so they become NULL. */
const clean = (params: unknown[]) => params.map((p) => (p === undefined ? null : p));

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...clean(params)).all<T>();
  return res.results ?? [];
}

export async function one<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...clean(params)).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...clean(params)).run();
}

export function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...clean(params));
}

export async function scalar(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const row = await one<Record<string, unknown>>(db, sql, ...params);
  if (!row) return 0;
  const v = Object.values(row)[0];
  return typeof v === 'number' ? v : Number(v ?? 0) || 0;
}

/** Every techs column but the photo itself (up to ~200 KB): `photo` comes back as 1 or 0, which is all most pages need. */
export const TECH_COLS = `id, slug, name, first_name, role, aliases, email, phone, photo IS NOT NULL AS photo, active, sort, password_hash,
  invite_hash, invite_expires_at, home_location, today_location, today_on, created_at, updated_at`;
