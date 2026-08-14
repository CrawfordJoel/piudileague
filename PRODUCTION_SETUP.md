# PIUDI production setup

Target repository: `CrawfordJoel/piudileague`  
Target domain: `piudileague.com`

## Architecture

- **GitHub** stores the site, schema migrations, import/sync code, and immutable historical source exports.
- **Supabase/Postgres** is the canonical queryable history database.
- **Cloudflare Pages** serves the public site from the `site/` directory and deploys from GitHub.
- **GitHub Actions** periodically sync current Sleeper league data into Supabase.
- **Sleeper public API** is the factual source for league, roster, matchup, transaction, draft, bracket, traded-pick, and player-reference data.
- **Sleeper chat exports** remain a separate source for curated quotes, rules, and league lore. They are not allowed to overwrite factual Sleeper transaction/matchup data.

## 1. Create/link the Supabase project

Use one production Supabase project for PIUDI. Do not manually create the archive tables in the remote Table Editor after migrations begin.

From a local clone of the repository with the Supabase CLI installed:

```bash
supabase login
supabase link
supabase db push
```

The initial schema is:

`supabase/migrations/20260814220000_initial_piudi_schema.sql`

## 2. Import the historical archive once

Create a local `.env` from `.env.example` and set:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SLEEPER_CURRENT_LEAGUE_ID=1313002588936880128`

Then:

```bash
npm install
npm run import:history
npm run sync:players
npm run verify:data
```

The importer is idempotent: stable Sleeper IDs are used as database keys so rerunning it updates the same records rather than creating duplicates.

## 3. GitHub repository secrets

In `CrawfordJoel/piudileague` -> Settings -> Secrets and variables -> Actions, create:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service-role key is **server-side only**. Never place it in site JavaScript or commit it.

The workflows already in `.github/workflows/` will then be usable:

- `sleeper-sync.yml` — current league sync
- `player-sync.yml` — player-name/reference enrichment

Both can be run manually from GitHub Actions before relying on their schedules.

## 4. Cloudflare Pages

Connect the GitHub repository in Cloudflare Pages.

Recommended configuration:

- Production branch: `main`
- Build command: blank
- Build output directory: `site`

`wrangler.toml` contains the equivalent Pages output setting for CLI/local development.

After the first successful Pages deploy, attach `piudileague.com` as the custom domain.

## 5. Public database access

The migration enables row-level security on archive tables and creates **read-only public SELECT policies**. Imports and automated syncs require the service-role key.

The public website should eventually use only:

- `SUPABASE_URL`
- the project's public/anon browser key

The browser must never receive the service-role key.

## 6. Data ownership rules

1. Raw Sleeper API payloads are preserved in `source_payload` JSONB fields and/or `data/raw/` source exports.
2. Calculated records are derived from canonical matchup/transaction/draft tables, not manually entered totals.
3. Manager display names and team names may change; Sleeper `user_id` is the manager identity key and `league_id + roster_id` is the season roster key.
4. 2025 is the inaugural completed season.
5. 2026 is the active second season.
6. Snoe Flaco / StankyPanky1 is the sole defending champion until the 2026 championship is completed.
7. Chat-derived quotes/lore stay separated in `quotes` / `league_events` and do not alter factual sports records.

## 7. Next production frontend step

Once the database is populated and verified, replace the current generated data tables page-by-page with Supabase-backed queries. Recommended order:

1. Homepage current season/recent transactions
2. League Review season pages
3. Manager pages
4. Transactions + Waiver Wire
5. Trades + trade detail/tree pages
6. Draft pages
7. Records/H2H
8. Trash Talk curated feed
9. Global search

This avoids a large frontend rewrite before the canonical database is proven.
