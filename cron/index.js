/**
 * Every 15 minutes, asks the review site to pull new Google reviews, match them to techs and tidy up old data.
 * Pages projects can't run on a schedule by themselves; this tiny Worker (free tier) does it.
 *
 * Settings: APP_URL in cron/wrangler.jsonc, and the same CRON_SECRET as the Pages project:
 *   npx wrangler secret put CRON_SECRET --config cron/wrangler.jsonc
 */
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};

async function run(env) {
  if (!env.CRON_SECRET || !env.APP_URL) throw new Error('Set APP_URL (cron/wrangler.jsonc) and the CRON_SECRET secret.');
  const res = await fetch(`${env.APP_URL.replace(/\/+$/, '')}/api/cron`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Review sync failed: ${res.status} ${body.slice(0, 300)}`);
  console.log('review sync', body);
}
