# PIUDI v0.4 - Live Site Setup

This release connects the public static archive to the production Supabase database while keeping a static fallback.

## 1. Update local environment

Your existing `.env` already has the server-side values. Add the public anon key:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
SLEEPER_CURRENT_LEAGUE_ID=1313002588936880128
```

The anon key is intentionally safe to use in browser code because database writes remain protected by RLS. Never expose the service-role key.

## 2. Install/update dependencies

```powershell
npm install
```

## 3. Generate browser config locally

```powershell
npm run build
```

This writes `site/config.js` from `SUPABASE_URL` and `SUPABASE_ANON_KEY`. `site/config.js` is gitignored.

## 4. Verify data scripts

The scripts now load `.env` automatically:

```powershell
npm run verify:data
npm run sync:players
```

The player sync includes retry logic for transient network failures.

## 5. Commit v0.4

```powershell
git add .
git commit -m "Connect PIUDI archive to live Supabase data"
git push
```

## 6. Cloudflare Pages settings

In the Cloudflare Pages project connected to `CrawfordJoel/piudileague`:

- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `site`

Add these Cloudflare build environment variables:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Do NOT add `SUPABASE_SERVICE_ROLE_KEY` to the public site build unless a future server-only Worker specifically needs it. It is not required for this website.

## 7. Current live behavior

When Supabase is configured, the site reads live values for:

- available seasons and active/completed status
- franchise/manager count
- current transaction wire
- season standings
- manager directory
- manager season history
- waiver/free-agent feeds
- transaction archive

The original generated HTML remains in each page as fallback content if Supabase cannot be reached.

## 8. Next planned data views

The next release can add calculated database views for:

- true H2H standings separated from Sleeper league-average wins
- all-time records and career leaderboards
- trade detail pages with player names and pick lineage
- draft detail pages
- current rosters and player ownership history
- playoff/championship history
- searchable trash-talk/archive entries
