import { adminClient } from './lib.mjs';
const client = adminClient();

const checks = [
  ['league_seasons', 2],
  ['managers', 10],
  ['franchise_seasons', 20],
  ['matchups', 1],
  ['transactions', 1],
  ['drafts', 1],
  ['draft_picks', 1]
];

let failed = false;
for (const [table, minimum] of checks) {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  const ok = Number(count ?? 0) >= minimum;
  console.log(`${ok ? 'OK' : 'FAIL'} ${table}: ${count} (minimum ${minimum})`);
  if (!ok) failed = true;
}

const { data: seasons, error: seasonError } = await client.from('league_seasons').select('season,status,name').order('season');
if (seasonError) throw seasonError;
console.log('Seasons:', seasons);

if (failed) process.exit(1);
