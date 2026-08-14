# PIUDI League Archive v0.3

Production-oriented archive for **piudileague.com** and the **Platinum Infinite Universal Dynasty Invitational**.

## Canonical history

- **2025** — inaugural completed season
- **2026** — active second season
- **Defending champion** — Snoe Flaco / StankyPanky1

## Production architecture

- GitHub: `CrawfordJoel/piudileague`
- Cloudflare Pages: public web hosting from `site/`
- Supabase/Postgres: canonical queryable league-history database
- Sleeper API: factual league-data source
- GitHub Actions: recurring current-season + player-reference sync
- `data/raw/`: immutable historical source exports used to bootstrap the archive

## Repository layout

```text
site/                   Current public prototype
supabase/migrations/    Version-controlled production database schema
scripts/                Historical importer and Sleeper sync tools
.github/workflows/      Scheduled/manual GitHub Actions
 data/raw/               Original Sleeper + chat exports
PRODUCTION_SETUP.md     Deployment and secret setup instructions
wrangler.toml           Cloudflare Pages output configuration
```

## Commands

```bash
npm install
npm run import:history
npm run sync:players
npm run sync:sleeper
npm run verify:data
```

See **PRODUCTION_SETUP.md** before deploying or adding credentials.
