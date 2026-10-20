/** Who changed what in the office dashboard. Owners read it under Settings → Activity log. */
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { run } from './db';
import { line, newId, now } from './util';

export async function audit(c: Context<AppEnv>, action: string, detail?: string): Promise<void> {
  const a = c.get('admin');
  await run(c.env.DB, `INSERT INTO audit_log (id, admin_id, admin_name, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    newId('al'), a?.id ?? null, a?.name ?? 'system', line(action, 80), detail ? line(detail, 300) : null, now());
}
