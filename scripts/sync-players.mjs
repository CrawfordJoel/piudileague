import { adminClient, upsertChunked } from './lib.mjs';

const client = adminClient();
const response = await fetch('https://api.sleeper.app/v1/players/nfl', {
  headers: { 'User-Agent': 'PIUDI-League-Archive/0.3' }
});
if (!response.ok) throw new Error(`Sleeper player sync failed: HTTP ${response.status}`);
const players = await response.json();
const rows = Object.entries(players).map(([player_id, p]) => ({
  player_id: String(player_id),
  first_name: p.first_name ?? null,
  last_name: p.last_name ?? null,
  full_name: p.full_name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null),
  position: p.position ?? null,
  team: p.team ?? null,
  status: p.status ?? null,
  years_exp: Number.isFinite(Number(p.years_exp)) ? Number(p.years_exp) : null,
  active: typeof p.active === 'boolean' ? p.active : null,
  fantasy_positions: p.fantasy_positions ?? [],
  source_payload: p,
  updated_at: new Date().toISOString()
}));
await upsertChunked(client, 'players', rows, { onConflict: 'player_id', chunkSize: 250, maxRetries: 4 });
console.log(`Synced ${rows.length} NFL player records from Sleeper.`);
