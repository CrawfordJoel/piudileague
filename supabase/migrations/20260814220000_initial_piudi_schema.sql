-- PIUDI production schema v0.3
-- Canonical historical store for piudileague.com

create extension if not exists pgcrypto;

create table if not exists public.league_seasons (
  league_id text primary key,
  season integer not null unique,
  name text not null,
  status text not null,
  previous_league_id text,
  total_rosters integer,
  settings jsonb not null default '{}'::jsonb,
  scoring_settings jsonb not null default '{}'::jsonb,
  roster_positions jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);

create table if not exists public.managers (
  user_id text primary key,
  display_name text not null,
  avatar text,
  sleeper_profile_url text,
  x_handle text,
  x_profile_url text,
  first_seen_season integer,
  last_seen_season integer,
  source_payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.franchise_seasons (
  league_id text not null references public.league_seasons(league_id) on delete cascade,
  roster_id integer not null,
  season integer not null,
  owner_user_id text references public.managers(user_id),
  team_name text,
  wins integer,
  losses integer,
  ties integer,
  points_for numeric(12,2),
  points_against numeric(12,2),
  potential_points numeric(12,2),
  waiver_position integer,
  waiver_budget_used integer,
  total_moves integer,
  starters jsonb not null default '[]'::jsonb,
  players jsonb not null default '[]'::jsonb,
  reserve jsonb not null default '[]'::jsonb,
  taxi jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  primary key (league_id, roster_id)
);
create index if not exists franchise_seasons_owner_idx on public.franchise_seasons(owner_user_id, season);

create table if not exists public.players (
  player_id text primary key,
  first_name text,
  last_name text,
  full_name text,
  position text,
  team text,
  status text,
  years_exp integer,
  active boolean,
  fantasy_positions jsonb not null default '[]'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists players_name_idx on public.players(full_name);

create table if not exists public.matchups (
  league_id text not null references public.league_seasons(league_id) on delete cascade,
  season integer not null,
  week integer not null,
  roster_id integer not null,
  matchup_id integer,
  points numeric(12,2) not null default 0,
  custom_points numeric(12,2),
  starters jsonb not null default '[]'::jsonb,
  players jsonb not null default '[]'::jsonb,
  starters_points jsonb not null default '[]'::jsonb,
  players_points jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  primary key (league_id, week, roster_id)
);
create index if not exists matchups_season_week_idx on public.matchups(season, week);
create index if not exists matchups_matchup_idx on public.matchups(league_id, week, matchup_id);

create table if not exists public.transactions (
  transaction_id text primary key,
  league_id text not null references public.league_seasons(league_id) on delete cascade,
  season integer not null,
  week integer not null,
  type text not null,
  status text,
  creator_user_id text,
  created_at timestamptz,
  status_updated_at timestamptz,
  roster_ids jsonb not null default '[]'::jsonb,
  consenter_ids jsonb not null default '[]'::jsonb,
  waiver_budget jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb
);
create index if not exists transactions_season_week_idx on public.transactions(season, week, created_at desc);
create index if not exists transactions_type_idx on public.transactions(type, status);

create table if not exists public.transaction_assets (
  id bigint generated always as identity primary key,
  transaction_id text not null references public.transactions(transaction_id) on delete cascade,
  asset_type text not null check (asset_type in ('player','draft_pick')),
  direction text not null check (direction in ('add','drop','transfer')),
  player_id text references public.players(player_id),
  roster_id integer,
  season integer,
  round integer,
  original_roster_id integer,
  previous_owner_id integer,
  owner_id integer,
  raw_asset jsonb not null default '{}'::jsonb
);
create index if not exists transaction_assets_tx_idx on public.transaction_assets(transaction_id);
create index if not exists transaction_assets_player_idx on public.transaction_assets(player_id);

create table if not exists public.drafts (
  draft_id text primary key,
  league_id text not null references public.league_seasons(league_id) on delete cascade,
  season integer not null,
  type text,
  status text,
  start_time timestamptz,
  rounds integer,
  draft_order jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb
);

create table if not exists public.draft_picks (
  draft_id text not null references public.drafts(draft_id) on delete cascade,
  pick_no integer not null,
  round integer,
  draft_slot integer,
  roster_id integer,
  picked_by_user_id text,
  player_id text references public.players(player_id),
  player_snapshot jsonb not null default '{}'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  primary key (draft_id, pick_no)
);
create index if not exists draft_picks_player_idx on public.draft_picks(player_id);

create table if not exists public.traded_picks (
  league_id text not null references public.league_seasons(league_id) on delete cascade,
  season integer not null,
  round integer not null,
  original_roster_id integer not null,
  owner_id integer,
  previous_owner_id integer,
  source_payload jsonb not null default '{}'::jsonb,
  primary key (league_id, season, round, original_roster_id)
);

create table if not exists public.playoff_games (
  league_id text not null references public.league_seasons(league_id) on delete cascade,
  bracket_type text not null check (bracket_type in ('winners','losers')),
  round integer not null,
  matchup integer not null,
  team1_roster_id integer,
  team2_roster_id integer,
  winner_roster_id integer,
  loser_roster_id integer,
  team1_from jsonb,
  team2_from jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  primary key (league_id, bracket_type, round, matchup)
);

create table if not exists public.league_events (
  id uuid primary key default gen_random_uuid(),
  event_date timestamptz,
  season integer,
  event_type text not null,
  title text not null,
  summary text,
  manager_user_ids jsonb not null default '[]'::jsonb,
  roster_ids jsonb not null default '[]'::jsonb,
  related_transaction_id text references public.transactions(transaction_id),
  source_type text not null default 'derived',
  source_locator text,
  is_public boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists league_events_season_date_idx on public.league_events(season, event_date desc);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  season integer,
  occurred_at timestamptz,
  speaker_display_name text,
  speaker_user_id text references public.managers(user_id),
  quote_text text not null,
  category text,
  source_line_start integer,
  source_line_end integer,
  is_public boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Public site is read-only. Imports/syncs use the service-role key, which bypasses RLS.
alter table public.league_seasons enable row level security;
alter table public.managers enable row level security;
alter table public.franchise_seasons enable row level security;
alter table public.players enable row level security;
alter table public.matchups enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_assets enable row level security;
alter table public.drafts enable row level security;
alter table public.draft_picks enable row level security;
alter table public.traded_picks enable row level security;
alter table public.playoff_games enable row level security;
alter table public.league_events enable row level security;
alter table public.quotes enable row level security;

create policy "public read league_seasons" on public.league_seasons for select using (true);
create policy "public read managers" on public.managers for select using (true);
create policy "public read franchise_seasons" on public.franchise_seasons for select using (true);
create policy "public read players" on public.players for select using (true);
create policy "public read matchups" on public.matchups for select using (true);
create policy "public read transactions" on public.transactions for select using (true);
create policy "public read transaction_assets" on public.transaction_assets for select using (true);
create policy "public read drafts" on public.drafts for select using (true);
create policy "public read draft_picks" on public.draft_picks for select using (true);
create policy "public read traded_picks" on public.traded_picks for select using (true);
create policy "public read playoff_games" on public.playoff_games for select using (true);
create policy "public read public league_events" on public.league_events for select using (is_public);
create policy "public read public quotes" on public.quotes for select using (is_public);

-- Stable helper view for manager career summaries.
create or replace view public.manager_career_summary as
select
  m.user_id,
  m.display_name,
  count(fs.season) as seasons,
  min(fs.season) as first_season,
  max(fs.season) as latest_season,
  coalesce(sum(fs.wins),0) as sleeper_wins,
  coalesce(sum(fs.losses),0) as sleeper_losses,
  coalesce(sum(fs.ties),0) as sleeper_ties,
  round(coalesce(sum(fs.points_for),0),2) as total_points_for,
  round(coalesce(avg(fs.points_for),0),2) as avg_season_points_for
from public.managers m
left join public.franchise_seasons fs on fs.owner_user_id = m.user_id
group by m.user_id, m.display_name;
