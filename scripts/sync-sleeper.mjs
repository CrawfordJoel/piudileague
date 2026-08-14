import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requiredEnv } from './lib.mjs';

const BASE = 'https://api.sleeper.app/v1';
const currentLeagueId = requiredEnv('SLEEPER_CURRENT_LEAGUE_ID');
const backfill = String(process.env.SLEEPER_BACKFILL ?? '').toLowerCase() === 'true';
const weeks = Array.from({ length: 18 }, (_, i) => i + 1);

async function get(pathname) {
  const response = await fetch(`${BASE}${pathname}`, { headers: { 'User-Agent': 'PIUDI-League-Archive/0.3' } });
  if (!response.ok) throw new Error(`Sleeper HTTP ${response.status} for ${pathname}`);
  return response.json();
}

async function downloadLeague(leagueId) {
  const league = await get(`/league/${leagueId}`);
  const seasonLabel = String(league.season);
  console.log(`Downloading Sleeper season ${seasonLabel} (${leagueId})`);
  const [users, rosters, traded_picks, winners_bracket, losers_bracket, drafts] = await Promise.all([
    get(`/league/${leagueId}/users`),
    get(`/league/${leagueId}/rosters`),
    get(`/league/${leagueId}/traded_picks`),
    get(`/league/${leagueId}/winners_bracket`),
    get(`/league/${leagueId}/losers_bracket`),
    get(`/league/${leagueId}/drafts`)
  ]);

  const matchups_by_week = {};
  const transactions_by_week = {};
  for (const week of weeks) {
    const [matchups, transactions] = await Promise.all([
      get(`/league/${leagueId}/matchups/${week}`),
      get(`/league/${leagueId}/transactions/${week}`)
    ]);
    matchups_by_week[String(week)] = matchups;
    transactions_by_week[String(week)] = transactions;
  }

  const draftWrappers = [];
  for (const draft of drafts ?? []) {
    const [picks, draftTradedPicks] = await Promise.all([
      get(`/draft/${draft.draft_id}/picks`),
      get(`/draft/${draft.draft_id}/traded_picks`)
    ]);
    draftWrappers.push({ draft, picks, traded_picks: draftTradedPicks });
  }

  return {
    seasonLabel,
    previousLeagueId: league.previous_league_id,
    data: { league, users, rosters, traded_picks, winners_bracket, losers_bracket, drafts: draftWrappers, matchups_by_week, transactions_by_week }
  };
}

const history = {};
let leagueId = currentLeagueId;
while (leagueId && leagueId !== '0') {
  const downloaded = await downloadLeague(leagueId);
  history[downloaded.seasonLabel] = downloaded.data;
  if (!backfill) break;
  leagueId = downloaded.previousLeagueId;
}

const tmp = path.join(os.tmpdir(), `piudi-sleeper-${Date.now()}.json`);
fs.writeFileSync(tmp, JSON.stringify({ generated_at_utc: new Date().toISOString(), source: 'Sleeper public API', api_base_url: BASE, league_history: history }, null, 2));

const result = spawnSync(process.execPath, ['scripts/import-history.mjs', tmp], { stdio: 'inherit', env: process.env });
fs.unlinkSync(tmp);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Sleeper sync complete.');
