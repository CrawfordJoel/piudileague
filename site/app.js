(function () {
  const cfg = window.PIUDI_CONFIG || {};
  const enabled = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const headers = enabled ? {
    apikey: cfg.supabaseAnonKey,
    Authorization: `Bearer ${cfg.supabaseAnonKey}`
  } : {};

  async function rest(table, params = '') {
    if (!enabled) throw new Error('Live data is not configured');
    const url = `${cfg.supabaseUrl}/rest/v1/${table}${params ? `?${params}` : ''}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmtDate = value => value ? new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric'}).format(new Date(value)) : '—';
  const labelType = type => ({waiver:'Waiver',free_agent:'Free Agent',trade:'Trade'}[type] || String(type || 'Transaction').replaceAll('_',' '));
  const currentYear = new Date().getFullYear();

  function liveStatus(message, ok = true) {
    const el = document.querySelector('[data-live-status]');
    if (!el) return;
    el.textContent = message;
    el.className = ok ? 'live-status ok' : 'live-status';
  }

  async function loadCore() {
    const [seasons, managers, franchises] = await Promise.all([
      rest('league_seasons', 'select=league_id,season,name,status,source_payload&order=season.desc'),
      rest('managers', 'select=user_id,display_name,sleeper_profile_url,x_handle,x_profile_url,first_seen_season,last_seen_season'),
      rest('franchise_seasons', 'select=league_id,roster_id,season,owner_user_id,team_name,wins,losses,ties,points_for,points_against,total_moves,waiver_budget_used&order=season.desc,roster_id.asc')
    ]);
    return { seasons, managers, franchises };
  }

  function ownerMap(core, season) {
    const managers = new Map(core.managers.map(m => [m.user_id, m]));
    const map = new Map();
    core.franchises.filter(f => f.season === season).forEach(f => {
      map.set(Number(f.roster_id), { ...f, manager: managers.get(f.owner_user_id) || null });
    });
    return map;
  }

  async function home(core) {
    const current = core.seasons.find(s => s.status !== 'complete') || core.seasons[0];
    const completed = core.seasons.filter(s => s.status === 'complete');
    const currentSeason = current?.season || currentYear;

    document.querySelectorAll('[data-current-season]').forEach(el => el.textContent = currentSeason);
    document.querySelectorAll('[data-season-count]').forEach(el => el.textContent = core.seasons.length);
    document.querySelectorAll('[data-franchise-count]').forEach(el => el.textContent = new Set(core.managers.map(m => m.user_id)).size);

    const strip = document.querySelector('[data-season-strip]');
    if (strip) {
      strip.innerHTML = core.seasons.map(s => {
        const active = s.status !== 'complete';
        return `<a class="card yearcard" href="season-${esc(s.season)}.html"><span class="pill ${active ? 'live' : ''}">${active ? 'Current season' : 'Completed'}</span><h3>${esc(s.season)}</h3><div class="muted">${active ? `Season ${core.seasons.length} · in progress` : 'League archive'}</div></a>`;
      }).join('');
    }

    const latest = await rest('transactions', `select=transaction_id,season,week,type,status,created_at,roster_ids&season=eq.${currentSeason}&order=created_at.desc&limit=8`);
    const om = ownerMap(core, currentSeason);
    const wire = document.querySelector('[data-transaction-wire]');
    if (wire && latest.length) {
      wire.innerHTML = latest.map(tx => {
        const rosterIds = Array.isArray(tx.roster_ids) ? tx.roster_ids : [];
        const names = rosterIds.map(id => om.get(Number(id))?.team_name || om.get(Number(id))?.manager?.display_name).filter(Boolean);
        return `<div class="listrow"><div class="date">${fmtDate(tx.created_at)}</div><div><span class="pill">${esc(labelType(tx.type))}</span><strong>${esc(names.join(' ↔ ') || 'League transaction')}</strong><div class="sub">${esc(tx.season)} · Week ${esc(tx.week)} · ${esc(tx.transaction_id)}</div></div></div>`;
      }).join('');
    }

    const championEl = document.querySelector('[data-defending-champion]');
    if (championEl && completed.length) {
      const last = completed.sort((a,b)=>b.season-a.season)[0];
      const winnerId = Number(last.source_payload?.metadata?.latest_league_winner_roster_id ?? last.source_payload?.metadata?.latest_league_winner_roster_id);
      const lastMap = ownerMap(core, last.season);
      const winner = lastMap.get(winnerId);
      if (winner) {
        championEl.innerHTML = `<div class="num gold">${esc(winner.team_name || winner.manager?.display_name)}</div><div class="label">Defending Champion · ${esc(winner.manager?.display_name || '')}</div>`;
      }
    }
  }

  async function managerDirectory(core) {
    const grid = document.querySelector('[data-manager-grid]');
    if (!grid) return;
    const current = core.seasons.find(s => s.status !== 'complete') || core.seasons[0];
    const om = ownerMap(core, current.season);
    const rosterByUser = new Map([...om.values()].map(f => [f.owner_user_id, f]));
    grid.innerHTML = core.managers.slice().sort((a,b)=>a.display_name.localeCompare(b.display_name)).map(m => {
      const f = rosterByUser.get(m.user_id);
      const slug = m.display_name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      return `<a class="card manager-card" href="manager-${slug}.html"><div class="avatar small">${esc(m.display_name.slice(0,2).toUpperCase())}</div><h3>${esc(m.display_name)}</h3><div class="muted">${esc(f?.team_name || 'PIUDI franchise')}</div><div class="sub">Since ${esc(m.first_seen_season || 2025)}</div></a>`;
    }).join('');
  }

  async function seasonPage(core) {
    const season = Number(document.body.dataset.season);
    if (!season) return;
    const fs = core.franchises.filter(f => f.season === season);
    const managers = new Map(core.managers.map(m => [m.user_id,m]));
    const tbody = document.querySelector('[data-live-standings]');
    if (tbody && fs.length) {
      const sorted = fs.slice().sort((a,b)=>(b.wins-a.wins)||((b.points_for||0)-(a.points_for||0)));
      tbody.innerHTML = sorted.map((f,i)=>`<tr><td>${i+1}</td><td><div class="team">${esc(f.team_name || managers.get(f.owner_user_id)?.display_name)}</div><div class="sub">${esc(managers.get(f.owner_user_id)?.display_name || '')}</div></td><td>${esc(f.wins ?? '—')}-${esc(f.losses ?? '—')}${f.ties ? `-${esc(f.ties)}` : ''}</td><td>${Number(f.points_for || 0).toFixed(2)}</td><td>${Number(f.points_against || 0).toFixed(2)}</td></tr>`).join('');
    }
  }

  async function transactionsPage(core, onlyWaivers = false) {
    const container = document.querySelector('[data-live-transactions]');
    if (!container) return;
    const season = Number(document.body.dataset.season || 0);
    const filters = [];
    if (season) filters.push(`season=eq.${season}`);
    if (onlyWaivers) filters.push('type=in.(waiver,free_agent)');
    const qs = `select=transaction_id,season,week,type,status,created_at,roster_ids&order=created_at.desc&limit=300${filters.length ? '&'+filters.join('&') : ''}`;
    const txs = await rest('transactions', qs);
    const maps = new Map(core.seasons.map(s => [s.season, ownerMap(core,s.season)]));
    container.innerHTML = txs.map(tx => {
      const om = maps.get(tx.season) || new Map();
      const ids = Array.isArray(tx.roster_ids) ? tx.roster_ids : [];
      const names = ids.map(id => om.get(Number(id))?.team_name || om.get(Number(id))?.manager?.display_name).filter(Boolean);
      return `<div class="feeditem searchable"><div class="feedmeta">${fmtDate(tx.created_at)} · ${esc(tx.season)} · Week ${esc(tx.week)}</div><div><span class="pill">${esc(labelType(tx.type))}</span> <strong>${esc(names.join(' ↔ ') || 'League transaction')}</strong></div><div class="sub">Sleeper transaction ${esc(tx.transaction_id)}</div></div>`;
    }).join('') || '<div class="notice">No transactions found.</div>';
  }

  async function managerPage(core) {
    const user = document.body.dataset.manager;
    if (!user) return;
    const manager = core.managers.find(m => m.display_name.toLowerCase() === user.toLowerCase() || m.user_id === user);
    if (!manager) return;
    const history = core.franchises.filter(f => f.owner_user_id === manager.user_id).sort((a,b)=>b.season-a.season);
    document.querySelectorAll('[data-manager-name]').forEach(el=>el.textContent=manager.display_name);
    const team = document.querySelector('[data-current-team]'); if (team) team.textContent = history[0]?.team_name || 'PIUDI franchise';
    const sleeper = document.querySelector('[data-sleeper-link]'); if (sleeper && manager.sleeper_profile_url) sleeper.href = manager.sleeper_profile_url;
    const x = document.querySelector('[data-x-link]'); if (x && manager.x_profile_url) { x.href=manager.x_profile_url; x.classList.remove('hidden'); }
    const historyEl = document.querySelector('[data-manager-history]');
    if (historyEl) historyEl.innerHTML = history.map(f=>`<div class="record"><span>${esc(f.season)} · ${esc(f.team_name || manager.display_name)}</span><strong>${esc(f.wins ?? 0)}-${esc(f.losses ?? 0)} · ${Number(f.points_for||0).toFixed(2)} PF</strong></div>`).join('');
  }

  async function init() {
    if (!enabled) { liveStatus('Static fallback · live Supabase not configured', false); return; }
    try {
      const core = await loadCore();
      liveStatus(`Live archive · synced from Supabase`);
      const page = document.body.dataset.page;
      if (page === 'home') await home(core);
      if (page === 'managers') await managerDirectory(core);
      if (page === 'season') await seasonPage(core);
      if (page === 'transactions') await transactionsPage(core, false);
      if (page === 'waivers') await transactionsPage(core, true);
      if (page === 'manager') await managerPage(core);
    } catch (err) {
      console.error(err);
      liveStatus('Live data unavailable · showing cached/static archive', false);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
