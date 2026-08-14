import json, sqlite3, shutil, html, os, re
from pathlib import Path
from datetime import datetime, timezone

ROOT=Path('/mnt/data/piudileague')
SRC=Path('/mnt/data/sleeper_league_history.json')
CHAT=Path('/mnt/data/dynasty.chat.txt')
if ROOT.exists(): shutil.rmtree(ROOT)
(ROOT/'site').mkdir(parents=True)
(ROOT/'data'/'raw').mkdir(parents=True)
shutil.copy2(SRC, ROOT/'data'/'raw'/'sleeper_league_history.json')
shutil.copy2(CHAT, ROOT/'data'/'raw'/'dynasty.chat.txt')

data=json.loads(SRC.read_text())
LH=data['league_history']

def user_maps(season):
    users={u['user_id']:u for u in LH[season]['users']}
    roster_owner={r['roster_id']:r.get('owner_id') for r in LH[season]['rosters']}
    roster_user={rid:users.get(uid,{}) for rid,uid in roster_owner.items()}
    return users,roster_owner,roster_user

def team_name(u): return (u.get('metadata') or {}).get('team_name') or u.get('display_name') or 'Unknown'
def manager_name(u): return u.get('display_name') or 'Unknown'
def dt(ms): return datetime.fromtimestamp(ms/1000, tz=timezone.utc)
def fmt_date(ms): return dt(ms).strftime('%b %-d, %Y')

def matchup_rows(season):
    out=[]
    for wk, arr in LH[season]['matchups_by_week'].items():
        if not arr: continue
        groups={}
        for x in arr:
            groups.setdefault(x.get('matchup_id'),[]).append(x)
        for mid, sides in groups.items():
            if mid is None or len(sides)!=2: continue
            a,b=sides
            out.append((int(wk),mid,a['roster_id'],float(a.get('points') or 0),b['roster_id'],float(b.get('points') or 0)))
    return sorted(out)

def h2h_standings(season, max_week=13):
    stats={r['roster_id']:{'w':0,'l':0,'pf':0.0,'pa':0.0} for r in LH[season]['rosters']}
    for wk,mid,a,ap,b,bp in matchup_rows(season):
        if wk>max_week: continue
        stats[a]['pf']+=ap; stats[a]['pa']+=bp; stats[b]['pf']+=bp; stats[b]['pa']+=ap
        if ap>bp: stats[a]['w']+=1; stats[b]['l']+=1
        elif bp>ap: stats[b]['w']+=1; stats[a]['l']+=1
    return stats

def all_trades(season):
    trades=[]
    for wk, arr in LH[season]['transactions_by_week'].items():
        for t in arr or []:
            if t.get('type')=='trade' and t.get('status')=='complete':
                trades.append((int(wk),t))
    # dedupe transaction IDs in case API repeats
    seen=set(); out=[]
    for wk,t in sorted(trades,key=lambda z:z[1].get('created',0)):
        tid=t.get('transaction_id')
        if tid in seen: continue
        seen.add(tid); out.append((wk,t))
    return out

def asset_summary(t):
    pieces=[]
    if t.get('adds'): pieces.append(f"{len(t['adds'])} player movement" + ('s' if len(t['adds'])!=1 else ''))
    if t.get('draft_picks'): pieces.append(f"{len(t['draft_picks'])} draft pick" + ('s' if len(t['draft_picks'])!=1 else ''))
    return ' + '.join(pieces) or 'asset exchange'

# SQLite normalized archive
DB=ROOT/'data'/'piudi.sqlite'
con=sqlite3.connect(DB); c=con.cursor()
c.executescript('''
PRAGMA foreign_keys=ON;
CREATE TABLE managers(manager_id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE seasons(season INTEGER PRIMARY KEY, league_id TEXT NOT NULL, league_name TEXT, status TEXT, previous_league_id TEXT);
CREATE TABLE franchises(season INTEGER, roster_id INTEGER, manager_id TEXT, team_name TEXT, wins INTEGER, losses INTEGER, points_for REAL, PRIMARY KEY(season,roster_id));
CREATE TABLE matchups(season INTEGER, week INTEGER, matchup_id INTEGER, roster_a INTEGER, points_a REAL, roster_b INTEGER, points_b REAL, PRIMARY KEY(season,week,matchup_id));
CREATE TABLE transactions(transaction_id TEXT PRIMARY KEY, season INTEGER, week INTEGER, created_ms INTEGER, type TEXT, status TEXT, roster_ids_json TEXT, adds_json TEXT, drops_json TEXT, draft_picks_json TEXT);
CREATE TABLE drafts(draft_id TEXT PRIMARY KEY, season INTEGER, type TEXT, status TEXT, rounds INTEGER);
CREATE TABLE draft_picks(draft_id TEXT, pick_no INTEGER, round INTEGER, draft_slot INTEGER, roster_id INTEGER, player_id TEXT, player_name TEXT, metadata_json TEXT, PRIMARY KEY(draft_id,pick_no));
CREATE TABLE league_events(event_id TEXT PRIMARY KEY, event_date TEXT, event_type TEXT, title TEXT, detail TEXT, source TEXT);
''')
all_managers={}
for season in LH:
    league=LH[season]['league']
    c.execute('INSERT INTO seasons VALUES(?,?,?,?,?)',(int(season),league['league_id'],league.get('name'),league.get('status'),league.get('previous_league_id')))
    users,roster_owner,roster_user=user_maps(season)
    for uid,u in users.items(): all_managers[uid]=manager_name(u)
    for r in LH[season]['rosters']:
        u=roster_user[r['roster_id']]; s=r.get('settings') or {}
        pf=float(s.get('fpts') or 0)+(float(s.get('fpts_decimal') or 0)/100)
        c.execute('INSERT INTO franchises VALUES(?,?,?,?,?,?,?)',(int(season),r['roster_id'],r.get('owner_id'),team_name(u),s.get('wins'),s.get('losses'),pf))
    for row in matchup_rows(season): c.execute('INSERT INTO matchups VALUES(?,?,?,?,?,?,?)',(int(season),)+row)
    for wk,arr in LH[season]['transactions_by_week'].items():
        for t in arr or []:
            tid=t.get('transaction_id');
            if not tid: continue
            c.execute('INSERT OR IGNORE INTO transactions VALUES(?,?,?,?,?,?,?,?,?,?)',(tid,int(season),int(wk),t.get('created'),t.get('type'),t.get('status'),json.dumps(t.get('roster_ids')),json.dumps(t.get('adds')),json.dumps(t.get('drops')),json.dumps(t.get('draft_picks'))))
    for dwrap in LH[season].get('drafts',[]):
        d=dwrap.get('draft') or {}; did=d.get('draft_id');
        if not did: continue
        c.execute('INSERT OR IGNORE INTO drafts VALUES(?,?,?,?,?)',(did,int(season),d.get('type'),d.get('status'),(d.get('settings') or {}).get('rounds')))
        for p in dwrap.get('picks') or []:
            meta=p.get('metadata') or {}; name=meta.get('first_name','')+' '+meta.get('last_name',''); name=name.strip() or meta.get('player_id') or p.get('player_id')
            c.execute('INSERT OR IGNORE INTO draft_picks VALUES(?,?,?,?,?,?,?,?)',(did,p.get('pick_no'),p.get('round'),p.get('draft_slot'),p.get('roster_id'),p.get('player_id'),name,json.dumps(meta)))
for uid,name in all_managers.items(): c.execute('INSERT OR REPLACE INTO managers VALUES(?,?)',(uid,name))
# curated factual events from chat + API
EVENTS=[
('founding','2025-04-01','governance','League bylaws established','PIUDI established its founding rules, including $50 dues, six playoff teams, league-average matchups, future-pick payment requirements, and a last-place punishment framework.','dynasty.chat.txt'),
('startup','2025-04-20','draft','Inaugural startup draft','The league completed its inaugural startup draft and began its first dynasty season.','Sleeper API + chat'),
('champ2025','2025-12-28','championship','Snoe Flaco wins the inaugural championship','StankyPanky1 / Snoe Flaco defeated RedHairing in the championship bracket to become the first PIUDI champion.','Sleeper API + chat'),
('punishment2025','2026-04-01','league','Inaugural last-place punishment completed','ElGuey72 completed the league-selected six Last Dab hot-wings punishment.','dynasty.chat.txt'),
('tradeveto','2026-05-05','governance','League trade voting abolished','The league voted to move to commissioner-only vetoes for collusion.','dynasty.chat.txt'),
('rules2026','2026-08-03','governance','2026 offseason rule changes implemented','IR increased by one, taxi squad increased by two, TE limit increased from four to six, and trade voting was removed.','dynasty.chat.txt')]
for e in EVENTS:c.execute('INSERT INTO league_events VALUES(?,?,?,?,?,?)',e)
con.commit(); con.close()

# HTML helpers
CSS='''
:root{--bg:#081018;--panel:#0e1a26;--panel2:#122233;--text:#f4f7fb;--muted:#8fa3b8;--line:#203447;--accent:#d7b66a;--good:#7bd3a7;--bad:#e68a8a;--blue:#7ab5ff}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#071018 0%,#0a131d 100%);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit;text-decoration:none}.wrap{max-width:1180px;margin:auto;padding:0 22px}.top{position:sticky;top:0;z-index:5;background:rgba(7,16,24,.93);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}nav{height:68px;display:flex;align-items:center;gap:24px}.brand{font-weight:900;letter-spacing:.12em;font-size:18px;color:var(--accent);margin-right:auto}.navlinks{display:flex;gap:18px;color:var(--muted);font-weight:700;font-size:13px}.navlinks a:hover{color:white}.hero{padding:74px 0 46px;border-bottom:1px solid var(--line)}.eyebrow{color:var(--accent);font-weight:900;letter-spacing:.15em;text-transform:uppercase;font-size:12px}.hero h1{font-size:clamp(40px,7vw,78px);line-height:.95;margin:14px 0 18px;max-width:900px;letter-spacing:-.045em}.hero p{color:var(--muted);font-size:18px;max-width:720px}.grid{display:grid;gap:16px}.g4{grid-template-columns:repeat(4,1fr)}.g3{grid-template-columns:repeat(3,1fr)}.g2{grid-template-columns:repeat(2,1fr)}.card{background:linear-gradient(180deg,var(--panel),#0c1721);border:1px solid var(--line);border-radius:14px;padding:20px}.stat .num{font-size:32px;font-weight:900;letter-spacing:-.04em}.stat .label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:800}.section{padding:38px 0}.section h2{font-size:26px;margin:0 0 18px}.sectionhead{display:flex;align-items:end;justify-content:space-between;margin-bottom:16px}.sectionhead p{margin:0;color:var(--muted)}table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line)}th{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}tr:last-child td{border-bottom:0}.rank{color:var(--muted);width:48px}.team{font-weight:850}.manager{color:var(--muted);font-size:12px}.pill{display:inline-block;border:1px solid var(--line);background:var(--panel2);border-radius:999px;padding:5px 9px;color:var(--muted);font-size:11px;font-weight:800}.gold{color:var(--accent)}.timeline{border-left:1px solid var(--line);margin-left:8px}.event{position:relative;padding:0 0 24px 26px}.event:before{content:"";position:absolute;width:9px;height:9px;border-radius:50%;background:var(--accent);left:-5px;top:7px}.event .date{font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:800;letter-spacing:.08em}.event h3{margin:3px 0 4px;font-size:17px}.event p{margin:0;color:var(--muted)}.trade{display:flex;gap:12px;align-items:center}.trade .side{flex:1}.trade .arrow{color:var(--accent);font-size:22px}.asset{font-size:13px;color:var(--muted)}.footer{border-top:1px solid var(--line);padding:35px 0 60px;color:var(--muted);font-size:12px}.pagehead{padding:50px 0 25px}.pagehead h1{font-size:46px;margin:8px 0}.sub{color:var(--muted)}.record{display:flex;justify-content:space-between;gap:12px;padding:15px 0;border-bottom:1px solid var(--line)}.record:last-child{border-bottom:0}.record strong{font-size:18px}.record span{color:var(--muted)}@media(max-width:800px){.g4,.g3,.g2{grid-template-columns:1fr 1fr}.navlinks{overflow:auto}.hero{padding-top:48px}}@media(max-width:540px){.g4,.g3,.g2{grid-template-columns:1fr}.navlinks a:nth-child(n+5){display:none}.hero h1{font-size:44px}th:nth-child(n+5),td:nth-child(n+5){display:none}}
'''
(ROOT/'site'/'style.css').write_text(CSS)

def shell(title,body):
    nav='''<div class="top"><div class="wrap"><nav><a class="brand" href="index.html">PIUDI</a><div class="navlinks"><a href="season-2025.html">Seasons</a><a href="franchises.html">Franchises</a><a href="trades.html">Trades</a><a href="records.html">Records</a><a href="timeline.html">Timeline</a></div></nav></div></div>'''
    return f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)} · PIUDI</title><link rel="stylesheet" href="style.css"></head><body>{nav}{body}<footer class="footer"><div class="wrap">PIUDI League Archive · Platinum Infinite Universal Dynasty Invitational · Source data preserved from Sleeper and league chat.</div></footer></body></html>'

def write(name,title,body): (ROOT/'site'/name).write_text(shell(title,body))

users25,own25,ru25=user_maps('2025')
st=h2h_standings('2025',13)
rows=sorted(st.items(),key=lambda z:(-z[1]['w'],-z[1]['pf']))
champ=team_name(ru25[2])
# records
all25=[]
for wk,mid,a,ap,b,bp in matchup_rows('2025'):
    if wk<=13:
        all25 += [(ap,a,wk,bp,b),(bp,b,wk,ap,a)]
high=max(all25); low=min(all25)
blow=max(all25,key=lambda x:x[0]-x[3])
closest=min([x for x in all25 if x[0]>x[3]],key=lambda x:x[0]-x[3])
trade_count=sum(len(all_trades(s)) for s in LH)
transaction_count=sum(sum(len(v or []) for v in LH[s]['transactions_by_week'].values()) for s in LH)

stand_html=''.join(f'<tr><td class="rank">{i}</td><td><div class="team">{html.escape(team_name(ru25[rid]))}</div><div class="manager">{html.escape(manager_name(ru25[rid]))}</div></td><td>{x["w"]}-{x["l"]}</td><td>{x["pf"]:.2f}</td><td>{x["pa"]:.2f}</td></tr>' for i,(rid,x) in enumerate(rows,1))
recent=[]
for season in LH:
    for wk,t in all_trades(season): recent.append((t.get('created',0),season,wk,t))
recent=sorted(recent,reverse=True)[:5]
trade_cards=''
for created,season,wk,t in recent:
    _,_,ru=user_maps(season); names=[team_name(ru.get(r,{})) for r in t.get('roster_ids') or []]
    trade_cards+=f'<div class="card"><div class="pill">{fmt_date(created)} · {season}</div><h3>{" ↔ ".join(map(html.escape,names))}</h3><div class="asset">{html.escape(asset_summary(t))} · Sleeper transaction {t.get("transaction_id")}</div></div>'

home=f'''<header class="hero"><div class="wrap"><div class="eyebrow">Official League Archive · Est. 2025</div><h1>Platinum Infinite Universal Dynasty Invitational</h1><p>The permanent statistical record of PIUDI: every season, franchise, matchup, draft, trade, transaction, championship, and league milestone.</p></div></header>
<section class="section"><div class="wrap grid g4"><div class="card stat"><div class="num gold">{champ}</div><div class="label">Defending Champion</div></div><div class="card stat"><div class="num">2</div><div class="label">Seasons Archived</div></div><div class="card stat"><div class="num">{trade_count}</div><div class="label">Completed Trades</div></div><div class="card stat"><div class="num">{transaction_count}</div><div class="label">API Transactions</div></div></div></section>
<section class="section"><div class="wrap"><div class="sectionhead"><div><div class="eyebrow">Inaugural Season</div><h2>2025 H2H Standings</h2></div><a class="pill" href="season-2025.html">Full season →</a></div><table><thead><tr><th>#</th><th>Franchise</th><th>H2H</th><th>PF</th><th>PA</th></tr></thead><tbody>{stand_html}</tbody></table></div></section>
<section class="section"><div class="wrap"><div class="sectionhead"><div><div class="eyebrow">Transaction Wire</div><h2>Recent completed trades</h2></div><a class="pill" href="trades.html">Trade archive →</a></div><div class="grid g2">{trade_cards}</div></div></section>'''
write('index.html','League Archive',home)

# Season 2025
br=LH['2025']['winners_bracket']
playoff=''.join(f'<div class="record"><span>Round {m.get("r")} · Match {m.get("m")}</span><strong>{html.escape(team_name(ru25.get(m.get("w"),{})))} def. {html.escape(team_name(ru25.get(m.get("l"),{})))}</strong></div>' for m in br)
season_body=f'''<div class="wrap"><header class="pagehead"><div class="eyebrow">Season Archive</div><h1>2025 · Inaugural Season</h1><p class="sub">The first season in PIUDI history. Six-team playoff. Weeks 16–17 combined championship structure.</p></header><div class="grid g4"><div class="card stat"><div class="num gold">{champ}</div><div class="label">Champion</div></div><div class="card stat"><div class="num">{team_name(ru25[7])}</div><div class="label">Runner-up</div></div><div class="card stat"><div class="num">{high[0]:.2f}</div><div class="label">Highest Weekly Score</div></div><div class="card stat"><div class="num">{len(all_trades("2025"))}</div><div class="label">Completed Trades</div></div></div><section class="section"><h2>Regular season · head-to-head</h2><table><thead><tr><th>#</th><th>Franchise</th><th>H2H</th><th>PF</th><th>PA</th></tr></thead><tbody>{stand_html}</tbody></table></section><section class="section"><h2>Playoff bracket results</h2><div class="card">{playoff}</div></section></div>'''
write('season-2025.html','2025 Season',season_body)

# franchises
cards=''
for rid,u in sorted(ru25.items()):
    x=st[rid]; current=team_name(user_maps('2026')[2].get(rid,u))
    cards+=f'<div class="card"><div class="pill">Roster {rid}</div><h2>{html.escape(current)}</h2><p class="sub">Manager · {html.escape(manager_name(u))}</p><div class="grid g2"><div class="stat"><div class="num">{x["w"]}-{x["l"]}</div><div class="label">2025 H2H</div></div><div class="stat"><div class="num">{x["pf"]:.1f}</div><div class="label">2025 PF</div></div></div></div>'
write('franchises.html','Franchises',f'<div class="wrap"><header class="pagehead"><div class="eyebrow">Permanent identities</div><h1>Franchises</h1><p class="sub">Managers are tracked separately from changing team names so history survives rebrands.</p></header><div class="grid g2">{cards}</div></div>')

# trades
trade_html=''
for season in sorted(LH,reverse=True):
    _,_,ru=user_maps(season)
    for wk,t in reversed(all_trades(season)):
        names=[team_name(ru.get(r,{})) for r in t.get('roster_ids') or []]
        picks=t.get('draft_picks') or []
        picktxt=', '.join(f"{p.get('season')} R{p.get('round')}" for p in picks) or 'No draft picks'
        trade_html+=f'<div class="card"><div class="pill">{fmt_date(t.get("created"))} · {season} · Week {wk}</div><h3>{" ↔ ".join(map(html.escape,names))}</h3><p class="sub">{html.escape(asset_summary(t))}</p><div class="asset">Draft capital: {html.escape(picktxt)}</div><div class="asset">Transaction ID: {t.get("transaction_id")}</div></div>'
write('trades.html','Trade Archive',f'<div class="wrap"><header class="pagehead"><div class="eyebrow">Immutable transaction log</div><h1>Trade Archive</h1><p class="sub">Every completed trade captured by Sleeper. Player-name enrichment and asset-by-side trade trees are the next data layer.</p></header><div class="grid g2">{trade_html}</div></div>')

# records
rec=f'''<div class="grid g2"><div class="card"><div class="eyebrow">Single game</div><div class="record"><span>Highest score</span><strong>{high[0]:.2f} · {html.escape(team_name(ru25[high[1]]))}</strong></div><div class="record"><span>Lowest score</span><strong>{low[0]:.2f} · {html.escape(team_name(ru25[low[1]]))}</strong></div><div class="record"><span>Largest H2H margin</span><strong>{blow[0]-blow[3]:.2f} · {html.escape(team_name(ru25[blow[1]]))}</strong></div><div class="record"><span>Closest H2H win</span><strong>{closest[0]-closest[3]:.2f} · {html.escape(team_name(ru25[closest[1]]))}</strong></div></div><div class="card"><div class="eyebrow">League history</div><div class="record"><span>First champion</span><strong>{html.escape(champ)}</strong></div><div class="record"><span>First runner-up</span><strong>{html.escape(team_name(ru25[7]))}</strong></div><div class="record"><span>Most 2025 H2H wins</span><strong>{rows[0][1]['w']} · {html.escape(team_name(ru25[rows[0][0]]))}</strong></div><div class="record"><span>Most 2025 H2H PF</span><strong>{max(rows,key=lambda z:z[1]['pf'])[1]['pf']:.2f} · {html.escape(team_name(ru25[max(rows,key=lambda z:z[1]['pf'])[0]]))}</strong></div></div></div>'''
write('records.html','Record Book',f'<div class="wrap"><header class="pagehead"><div class="eyebrow">PIUDI Record Book</div><h1>Records</h1><p class="sub">Calculated from archived source matchups, not manually entered summaries.</p></header>{rec}</div>')

# timeline from events + trades + drafts compact
items=[]
for e in EVENTS: items.append((e[1],e[2],e[3],e[4]))
for season in LH:
    for wk,t in all_trades(season):
        _,_,ru=user_maps(season); names=[team_name(ru.get(r,{})) for r in t.get('roster_ids') or []]
        items.append((dt(t['created']).date().isoformat(),'trade',f"Trade · {' ↔ '.join(names)}",asset_summary(t)))
for season in LH:
    for dwrap in LH[season].get('drafts',[]):
        d=dwrap.get('draft') or {}; start=d.get('start_time')
        if start: items.append((dt(start).date().isoformat(),'draft',f"{season} draft",f"{len(dwrap.get('picks') or [])} selections archived"))
items=sorted(items,reverse=True)
tl=''.join(f'<div class="event"><div class="date">{d} · {typ}</div><h3>{html.escape(title)}</h3><p>{html.escape(detail)}</p></div>' for d,typ,title,detail in items)
write('timeline.html','Timeline',f'<div class="wrap"><header class="pagehead"><div class="eyebrow">Chronological ledger</div><h1>League Timeline</h1><p class="sub">Trades, drafts, championships, governance changes, and league milestones in one permanent history.</p></header><div class="timeline">{tl}</div></div>')

# README and build metadata
README='''# PIUDI League Archive\n\nPrototype repository for **piudileague.com**.\n\n## What is here\n- `site/` static prototype pages\n- `data/piudi.sqlite` normalized SQLite archive\n- `data/raw/` preserved source exports\n- `build_piudi.py` generator\n\n## Prototype scope\nHome, 2025 season, franchises, trade archive, record book, and chronological timeline.\n\n## Next data work\n1. Add Sleeper NFL player reference data so all transaction player IDs render as names.\n2. Normalize transaction assets by side and build permanent trade detail pages / trade trees.\n3. Add complete draft pages and player pages.\n4. Add current 2026 roster pages and automatic API sync.\n5. Add source citations/lineage in an admin/debug view.\n\n## Intended public repository\n`CrawfordJoel/piudileague`\n'''
(ROOT/'README.md').write_text(README)
shutil.copy2('/mnt/data/build_piudi.py', ROOT/'build_piudi.py')
(ROOT/'BUILD_INFO.json').write_text(json.dumps({'domain':'piudileague.com','github_repo':'CrawfordJoel/piudileague','generated_utc':datetime.now(timezone.utc).isoformat(),'seasons':list(LH.keys()),'completed_trades':trade_count,'transactions':transaction_count},indent=2))
# zip
shutil.make_archive('/mnt/data/piudileague-prototype-v0.1','zip','/mnt/data','piudileague')
print('built',ROOT)
print('pages',sorted(p.name for p in (ROOT/'site').glob('*.html')))
print('db bytes',DB.stat().st_size)
print('zip bytes',Path('/mnt/data/piudileague-prototype-v0.1.zip').stat().st_size)
