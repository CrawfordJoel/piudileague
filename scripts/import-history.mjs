import fs from 'node:fs';
import path from 'node:path';
import { adminClient, collectPlayerIds, isoFromMs, replaceAssets, score, upsertChunked } from './lib.mjs';

const sourcePath = process.argv[2] ?? path.resolve('data/raw/sleeper_league_history.json');
const archive = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const client = adminClient();

const seasons = Object.entries(archive.league_history ?? {}).sort(([a], [b]) => Number(a) - Number(b));
if (!seasons.length) throw new Error('No league_history seasons found in source JSON.');

const allPlayerIds = new Set();
for (const [, seasonData] of seasons) {
  for (const id of collectPlayerIds(seasonData)) allPlayerIds.add(id);
}
await upsertChunked(client, 'players', [...allPlayerIds].map(player_id => ({ player_id })), { onConflict: 'player_id' });

for (const [seasonLabel, data] of seasons) {
  const league = data.league;
  const season = Number(league?.season ?? seasonLabel);
  if (!league?.league_id) throw new Error(`Season ${seasonLabel} has no league_id`);
  console.log(`Importing ${season} (${league.league_id})`);

  await upsertChunked(client, 'league_seasons', [{
    league_id: String(league.league_id),
    season,
    name: league.name,
    status: league.status ?? 'unknown',
    previous_league_id: league.previous_league_id && league.previous_league_id !== '0' ? String(league.previous_league_id) : null,
    total_rosters: league.total_rosters ?? league.settings?.num_teams ?? null,
    settings: league.settings ?? {},
    scoring_settings: league.scoring_settings ?? {},
    roster_positions: league.roster_positions ?? [],
    metadata: league.metadata ?? {},
    source_payload: league,
    synced_at: new Date().toISOString()
  }], { onConflict: 'league_id' });

  const users = data.users ?? [];
  const managerRows = users.map(user => ({
    user_id: String(user.user_id),
    display_name: user.display_name ?? String(user.user_id),
    avatar: user.avatar ?? user.metadata?.avatar ?? null,
    sleeper_profile_url: `https://sleeper.com/user/${user.user_id}`,
    first_seen_season: season,
    last_seen_season: season,
    source_payload: user,
    updated_at: new Date().toISOString()
  }));

  // Preserve earliest first_seen values already imported by processing seasons in ascending order.
  for (const row of managerRows) {
    const { data: existing } = await client.from('managers').select('first_seen_season,x_handle,x_profile_url').eq('user_id', row.user_id).maybeSingle();
    if (existing?.first_seen_season) row.first_seen_season = Math.min(existing.first_seen_season, season);
    if (existing?.x_handle) row.x_handle = existing.x_handle;
    if (existing?.x_profile_url) row.x_profile_url = existing.x_profile_url;
  }
  await upsertChunked(client, 'managers', managerRows, { onConflict: 'user_id' });

  const usersById = new Map(users.map(u => [String(u.user_id), u]));
  const franchiseRows = (data.rosters ?? []).map(roster => {
    const settings = roster.settings ?? {};
    const user = usersById.get(String(roster.owner_id));
    return {
      league_id: String(league.league_id),
      roster_id: roster.roster_id,
      season,
      owner_user_id: roster.owner_id ? String(roster.owner_id) : null,
      team_name: user?.metadata?.team_name ?? null,
      wins: settings.wins ?? null,
      losses: settings.losses ?? null,
      ties: settings.ties ?? null,
      points_for: score(settings, 'fpts', 'fpts_decimal'),
      points_against: score(settings, 'fpts_against', 'fpts_against_decimal'),
      potential_points: score(settings, 'ppts', 'ppts_decimal'),
      waiver_position: settings.waiver_position ?? null,
      waiver_budget_used: settings.waiver_budget_used ?? null,
      total_moves: settings.total_moves ?? null,
      starters: roster.starters ?? [],
      players: roster.players ?? [],
      reserve: roster.reserve ?? [],
      taxi: roster.taxi ?? [],
      metadata: roster.metadata ?? {},
      source_payload: roster,
      synced_at: new Date().toISOString()
    };
  });
  await upsertChunked(client, 'franchise_seasons', franchiseRows, { onConflict: 'league_id,roster_id' });

  const matchupRows = [];
  for (const [weekLabel, entries] of Object.entries(data.matchups_by_week ?? {})) {
    const week = Number(weekLabel);
    for (const m of entries ?? []) {
      matchupRows.push({
        league_id: String(league.league_id), season, week,
        roster_id: m.roster_id, matchup_id: m.matchup_id ?? null,
        points: Number(m.points ?? 0), custom_points: m.custom_points ?? null,
        starters: m.starters ?? [], players: m.players ?? [],
        starters_points: m.starters_points ?? [], players_points: m.players_points ?? {},
        source_payload: m
      });
    }
  }
  await upsertChunked(client, 'matchups', matchupRows, { onConflict: 'league_id,week,roster_id' });

  const txRows = [];
  const assetRows = [];
  const txIds = [];
  for (const [weekLabel, entries] of Object.entries(data.transactions_by_week ?? {})) {
    const week = Number(weekLabel);
    for (const tx of entries ?? []) {
      if (!tx.transaction_id) continue;
      const transaction_id = String(tx.transaction_id);
      txIds.push(transaction_id);
      txRows.push({
        transaction_id, league_id: String(league.league_id), season, week,
        type: tx.type ?? 'unknown', status: tx.status ?? null,
        creator_user_id: tx.creator ? String(tx.creator) : null,
        created_at: isoFromMs(tx.created), status_updated_at: isoFromMs(tx.status_updated),
        roster_ids: tx.roster_ids ?? [], consenter_ids: tx.consenter_ids ?? [],
        waiver_budget: tx.waiver_budget ?? [], settings: tx.settings ?? {}, metadata: tx.metadata ?? {},
        source_payload: tx
      });
      for (const [player_id, roster_id] of Object.entries(tx.adds ?? {})) {
        assetRows.push({ transaction_id, asset_type: 'player', direction: 'add', player_id: String(player_id), roster_id, raw_asset: { player_id, roster_id } });
      }
      for (const [player_id, roster_id] of Object.entries(tx.drops ?? {})) {
        assetRows.push({ transaction_id, asset_type: 'player', direction: 'drop', player_id: String(player_id), roster_id, raw_asset: { player_id, roster_id } });
      }
      for (const pick of tx.draft_picks ?? []) {
        assetRows.push({
          transaction_id, asset_type: 'draft_pick', direction: 'transfer',
          roster_id: pick.owner_id ?? null, season: Number(pick.season), round: pick.round,
          original_roster_id: pick.roster_id ?? null, previous_owner_id: pick.previous_owner_id ?? null,
          owner_id: pick.owner_id ?? null, raw_asset: pick
        });
      }
    }
  }
  await upsertChunked(client, 'transactions', txRows, { onConflict: 'transaction_id' });
  await replaceAssets(client, txIds, assetRows);

  const draftRows = [];
  const draftPickRows = [];
  for (const wrapper of data.drafts ?? []) {
    const draft = wrapper.draft ?? wrapper;
    if (!draft?.draft_id) continue;
    draftRows.push({
      draft_id: String(draft.draft_id), league_id: String(league.league_id), season: Number(draft.season ?? season),
      type: draft.type ?? null, status: draft.status ?? null, start_time: isoFromMs(draft.start_time),
      rounds: draft.settings?.rounds ?? null, draft_order: draft.draft_order ?? {}, settings: draft.settings ?? {},
      metadata: draft.metadata ?? {}, source_payload: draft
    });
    for (const pick of wrapper.picks ?? []) {
      draftPickRows.push({
        draft_id: String(draft.draft_id), pick_no: pick.pick_no, round: pick.round ?? null,
        draft_slot: pick.draft_slot ?? null, roster_id: pick.roster_id ?? null,
        picked_by_user_id: pick.picked_by ? String(pick.picked_by) : null,
        player_id: pick.player_id ? String(pick.player_id) : null,
        player_snapshot: pick.metadata ?? {}, source_payload: pick
      });
    }
  }
  await upsertChunked(client, 'drafts', draftRows, { onConflict: 'draft_id' });
  await upsertChunked(client, 'draft_picks', draftPickRows, { onConflict: 'draft_id,pick_no' });

  const tradedPickRows = (data.traded_picks ?? []).map(pick => ({
    league_id: String(league.league_id), season: Number(pick.season), round: pick.round,
    original_roster_id: pick.roster_id, owner_id: pick.owner_id ?? null,
    previous_owner_id: pick.previous_owner_id ?? null, source_payload: pick
  }));
  await upsertChunked(client, 'traded_picks', tradedPickRows, { onConflict: 'league_id,season,round,original_roster_id' });

  const playoffRows = [];
  for (const [bracket_type, entries] of [['winners', data.winners_bracket], ['losers', data.losers_bracket]]) {
    for (const game of entries ?? []) {
      playoffRows.push({
        league_id: String(league.league_id), bracket_type, round: game.r, matchup: game.m,
        team1_roster_id: game.t1 ?? null, team2_roster_id: game.t2 ?? null,
        winner_roster_id: game.w ?? null, loser_roster_id: game.l ?? null,
        team1_from: game.t1_from ?? null, team2_from: game.t2_from ?? null, source_payload: game
      });
    }
  }
  await upsertChunked(client, 'playoff_games', playoffRows, { onConflict: 'league_id,bracket_type,round,matchup' });

  console.log(`  managers=${managerRows.length} rosters=${franchiseRows.length} matchups=${matchupRows.length} transactions=${txRows.length} drafts=${draftRows.length} picks=${draftPickRows.length}`);
}

console.log('Historical import complete. Run npm run sync:players next to enrich player names.');
