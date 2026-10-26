import { LEAGUES, LEAGUE_KEYS, LINE_FLOORS, DEFAULT_FLOOR } from './config.js';
import { buildLeagueData, fetchPlayerGames } from './espn.js';
import { fetchMarketQuotes, nameKey, kalshiFee } from './odds.js';
import { buildTeamData } from './teams.js';
import { fetchInjuries, injuriesByTeam, returningPlayers } from './injuries.js';
import { fetchRoster, searchPlayers } from './roster.js';
import { scalarRows } from './ladders.js';
import { computeRows, onePerPlayer, lineStats, sampleGames, bestLine, formatNote, bestBets, americanOdds, defenseVsPosition, usualValue, activePlayers, median, upcomingGames } from './props.js';

const STATIC_MAX_AGE = 36 * 3600e3; // pre-built data/*.json older than this triggers a live pull
const CACHE_MAX_AGE = 3 * 3600e3;
const ODDS_MAX_AGE = 12 * 3600e3; // pre-built market prices older than this are ignored
const ODDS_REFRESH = 5 * 60e3; // re-pull live prices after this long
const TEAMS_CACHE_AGE = 6 * 3600e3;
const INJURY_REFRESH = 15 * 60e3; // re-pull the injury report after this long
const ROSTER_MAX_AGE = 7 * 24 * 3600e3;
const LOOKUP_REFRESH = 15 * 60e3; // re-pull a looked-up player's game log after this long
const VENUES = { K: 'Kalshi' };
const HEADSHOT_PATH = { nfl: 'nfl', cfb: 'college-football', nba: 'nba', wnba: 'wnba' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* quota / private mode — fine */
    }
  },
};

const state = {
  league: 'nfl',
  view: 'top',
  window: '10',
  minRate: '0.8',
  floor: String(DEFAULT_FLOOR),
  market: 'all',
  search: '',
  upcoming: true,
  onePer: true,
  ...store.get('prefs', {}),
  data: {}, // league -> dataset
  odds: {}, // league -> { quotes, venues, generatedAt, log, fetchedAt }
  teams: {}, // league -> { data, error, loading, progress }
  injuries: {}, // league -> { data, loading, fetchedAt }
  rosters: {}, // league -> { players, loading }
  lookups: {}, // "league:playerId" -> { games, error, loading, fetchedAt }
  betsKind: 'props', // Best bets: 'props' (yes/no lines) or 'ladders' (ladders + escalators)
  pick: null, // Players tab: { league, id, name, pos, team, teamId }
  pickMarket: null,
  expanded: null, // "playerId:marketId"
  custom: {}, // "playerId:marketId" -> custom line
  loading: false,
};
if (!LEAGUES[state.league]) state.league = 'nfl';
if (state.pick && state.pick.league !== state.league) state.pick = null;

function savePrefs() {
  const { league, view, window, minRate, floor, market, upcoming, onePer, pick, betsKind } = state;
  store.set('prefs', { league, view, window, minRate, floor, market, upcoming, onePer, pick, betsKind });
}

// ---------- data loading ----------

async function fetchStatic(key) {
  try {
    const res = await fetch(`data/${key}.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const age = (d) => (d && d.generatedAt ? Date.now() - new Date(d.generatedAt).getTime() : Infinity);

async function loadLeague(key, { force = false } = {}) {
  const cached = store.get(`data:${key}`, null);
  if (!force && cached && age(cached) < CACHE_MAX_AGE) return { data: cached, source: 'cache' };

  const stat = force ? null : await fetchStatic(key);
  if (stat && age(stat) < STATIC_MAX_AGE && stat.players && stat.players.length) return { data: stat, source: 'static' };

  try {
    const live = await buildLeagueData(LEAGUES[key], {
      onProgress: (p) => key === state.league && showProgress(p),
    });
    if (!live.players.length) throw new Error(live.log[0] || 'no players returned');
    store.set(`data:${key}`, live);
    return { data: live, source: 'live' };
  } catch (err) {
    const fallback = stat || cached;
    if (fallback) return { data: fallback, source: 'stale', error: err };
    throw err;
  }
}

function showProgress(p) {
  const el = $('status');
  el.className = 'status';
  if (p.phase === 'players') el.innerHTML = `Finding ${esc(LEAGUES[state.league].label)} players…`;
  else {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    el.innerHTML = `Pulling game logs ${p.done}/${p.total}<div class="bar"><i style="width:${pct}%"></i></div>`;
  }
}

async function ensureData(force = false) {
  const key = state.league;
  if (state.data[key] && !force) return render();
  state.loading = true;
  renderChrome();
  $('results').innerHTML = '';
  showProgress({ phase: 'players' });
  try {
    const { data, source, error } = await loadLeague(key, { force });
    state.data[key] = { ...data, source, error };
  } catch (err) {
    state.data[key] = { players: [], schedule: {}, error: err, log: [String(err && err.message)] };
  } finally {
    state.loading = false;
  }
  if (key === state.league) render();
}

const hasMarkets = (key) => Boolean(LEAGUES[key].kalshiSeries);

// Live Kalshi prices, falling back to the pre-built file
// (Kalshi in particular may refuse requests straight from a browser).
async function ensureOdds(force = false) {
  const key = state.league;
  if (!hasMarkets(key)) return;
  const cur = state.odds[key];
  if (cur && (cur.loading || (!force && Date.now() - cur.fetchedAt < ODDS_REFRESH))) return;
  state.odds[key] = { ...(cur || { quotes: [], venues: {}, log: [] }), loading: true };
  if (state.view === 'bets') render();
  const [live, stat] = await Promise.all([fetchMarketQuotes(LEAGUES[key]), fetchStatic(`${key}-odds`)]);
  const quotes = [];
  const scalars = [];
  const venues = {};
  for (const v of Object.keys(VENUES)) {
    if (live.venues[v]) {
      quotes.push(...live.quotes.filter((q) => q.v === v));
      scalars.push(...(live.scalars || []).filter((q) => q.v === v));
      venues[v] = 'live';
    } else if (stat && stat.venues && stat.venues[v] && age(stat) < ODDS_MAX_AGE) {
      quotes.push(...stat.quotes.filter((q) => q.v === v));
      scalars.push(...(stat.scalars || []).filter((q) => q.v === v));
      venues[v] = stat.generatedAt;
    }
  }
  state.odds[key] = { quotes, scalars, venues, log: live.log, fetchedAt: Date.now(), loading: false };
  if (key === state.league && state.view === 'bets') render();
}

const hasMatchups = (key) => Boolean(LEAGUES[key].teamStats);

// Team defense: browser cache, then the pre-built file, then a live pull of box scores.
async function ensureTeams(force = false) {
  const key = state.league;
  if (!hasMatchups(key)) return;
  const cur = state.teams[key];
  if (cur && (cur.loading || (!force && cur.data && !cur.error))) return;
  state.teams[key] = { loading: true, data: cur && cur.data };
  if (state.view === 'matchups') render();
  let data = null;
  let error = null;
  if (!force) {
    const cached = store.get(`teams:${key}`, null);
    if (cached && age(cached) < TEAMS_CACHE_AGE) data = cached;
  }
  if (!data && !force) {
    const stat = await fetchStatic(`${key}-teams`);
    if (stat && age(stat) < STATIC_MAX_AGE && Object.values(stat.teams || {}).some((t) => t.n)) data = stat;
  }
  if (!data) {
    try {
      data = await buildTeamData(LEAGUES[key], {
        onProgress: (p) => key === state.league && state.view === 'matchups' && showTeamProgress(p),
      });
      if (Object.values(data.teams).some((t) => t.n)) store.set(`teams:${key}`, data);
      else error = new Error(data.log[0] || 'no finished games found');
    } catch (err) {
      error = err;
    }
  }
  state.teams[key] = { data: data || (cur && cur.data) || null, error, loading: false };
  if (key === state.league && state.view === 'matchups') render();
}

// Injury report: live from ESPN, else the pre-built file (12h max).
async function ensureInjuries(force = false) {
  const key = state.league;
  if (!hasMatchups(key)) return;
  const cur = state.injuries[key];
  if (cur && (cur.loading || (!force && Date.now() - cur.fetchedAt < INJURY_REFRESH))) return;
  state.injuries[key] = { ...(cur || {}), loading: true };
  let data = await fetchInjuries(LEAGUES[key]);
  if (!data.ok) {
    const stat = await fetchStatic(`${key}-injuries`);
    if (stat && stat.ok && age(stat) < ODDS_MAX_AGE) data = { ...stat, fromFile: true, log: data.log };
  }
  state.injuries[key] = { data, loading: false, fetchedAt: Date.now() };
  if (key === state.league && state.view === 'matchups') render();
}

// Players tab search list: browser cache, then the pre-built file, then every team's roster live.
async function ensureRoster() {
  const key = state.league;
  if (!LEAGUES[key].roster || state.rosters[key]) return;
  state.rosters[key] = { loading: true, players: [] };
  let data = store.get(`roster:${key}`, null);
  if (!data || age(data) > ROSTER_MAX_AGE) data = await fetchStatic(`${key}-roster`);
  if (!data || !data.ok || age(data) > ROSTER_MAX_AGE) {
    const live = await fetchRoster(LEAGUES[key]);
    if (live.ok) {
      data = live;
      store.set(`roster:${key}`, live);
    }
  }
  state.rosters[key] = { players: (data && data.players) || [], loading: false };
  if (key === state.league && state.view === 'players') render();
}

// The picked player's full, current game log (tracked players are capped at 25 games).
async function ensurePlayerGames(force = false) {
  const pick = state.pick;
  if (!pick) return;
  const key = `${pick.league}:${pick.id}`;
  const cur = state.lookups[key];
  if (cur && (cur.loading || (!force && Date.now() - cur.fetchedAt < LOOKUP_REFRESH))) return;
  state.lookups[key] = { ...(cur || {}), loading: true };
  try {
    const games = await fetchPlayerGames(LEAGUES[pick.league], pick.id, { maxGames: 100, enough: 20 });
    state.lookups[key] = { games, fetchedAt: Date.now(), loading: false };
  } catch (err) {
    state.lookups[key] = { ...(cur || {}), error: err, fetchedAt: Date.now(), loading: false };
  }
  if (state.pick && state.pick.id === pick.id && state.view === 'players') render();
}

function showTeamProgress(p) {
  const el = $('status');
  el.className = 'status';
  if (p.phase === 'teams') el.innerHTML = 'Loading team schedules…';
  else {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    el.innerHTML = `Reading box scores ${p.done}/${p.total}<div class="bar"><i style="width:${pct}%"></i></div>`;
  }
}

// ---------- helpers ----------

function nextGame(d, p) {
  const s = d.schedule || {};
  return s[p.team] || (p.teamId && s[`id:${p.teamId}`]) || null;
}

function shortNames(players) {
  const byLast = new Map();
  for (const p of players) {
    const parts = p.name.split(' ');
    const last = parts.slice(1).join(' ') || p.name;
    byLast.set(last, (byLast.get(last) || 0) + 1);
  }
  const out = new Map();
  for (const p of players) {
    const parts = p.name.split(' ');
    const last = parts.slice(1).join(' ') || p.name;
    out.set(p.id, byLast.get(last) > 1 ? `${parts[0][0]}. ${last}` : last);
  }
  return out;
}

function headshot(p) {
  const path = HEADSHOT_PATH[state.league];
  return `https://a.espncdn.com/combiner/i?img=/i/headshots/${path}/players/full/${encodeURIComponent(p.id)}.png&w=96&h=96&scale=crop`;
}

function opts() {
  return {
    window: state.window === 'season' ? 'season' : Number(state.window),
    minRate: Number(state.minRate),
    floor: Number(state.floor),
    minGames: state.window === 'season' ? 3 : Math.min(5, Number(state.window)),
  };
}

function filteredRows(d) {
  const cfg = LEAGUES[state.league];
  const q = state.search.trim().toLowerCase();
  const hasSchedule = Object.keys(d.schedule || {}).length > 0;
  let players = d.players || [];
  if (state.upcoming && hasSchedule && state.view !== 'bets') players = players.filter((p) => nextGame(d, p));
  if (q) players = players.filter((p) => `${p.name} ${p.team}`.toLowerCase().includes(q));
  const markets = state.market === 'all' ? cfg.markets : cfg.markets.filter((m) => m.id === state.market);
  let rows;
  let priced = 0;
  if (state.view === 'bets') {
    const odds = state.odds[state.league];
    rows = bestBets(players, markets, (odds && odds.quotes) || [], nameKey, opts());
    priced = rows.length;
    rows = rows.filter((r) => r.edge > 0);
  } else {
    rows = computeRows(players, markets, opts());
  }
  if (state.onePer && state.market === 'all') rows = onePerPlayer(rows);
  rows.priced = priced;
  return { rows, hasSchedule };
}

function windowLabel() {
  return state.window === 'season' ? 'this season' : `last ${state.window}`;
}

// ---------- rendering ----------

function renderChrome() {
  $('leagues').innerHTML = LEAGUE_KEYS.map(
    (k) => `<button data-league="${k}" aria-pressed="${k === state.league}">${LEAGUES[k].label}</button>`,
  ).join('');
  if (state.view === 'bets' && !hasMarkets(state.league)) state.view = 'top';
  if (state.view === 'matchups' && !hasMatchups(state.league)) state.view = 'top';
  for (const b of $('view').querySelectorAll('button')) {
    b.setAttribute('aria-selected', String(b.dataset.v === state.view));
    if (b.dataset.v === 'bets') b.hidden = !hasMarkets(state.league);
    if (b.dataset.v === 'matchups') b.hidden = !hasMatchups(state.league);
  }
  // Best Bets uses each market's own line, so the line pickers don't apply there;
  // Matchups is season-to-date team data, so none of the prop filters do.
  // Players is one player's game log: only the sample and the search apply.
  const mu = state.view === 'matchups';
  const pl = state.view === 'players';
  for (const id of ['minRate', 'floor']) $(id).closest('.field').hidden = state.view === 'bets' || mu || pl;
  $('window').closest('.field').hidden = mu;
  $('upcoming').closest('.chk').hidden = state.view === 'bets' || mu || pl;
  const lad = state.view === 'bets' && state.betsKind === 'ladders' && hasLadders(state.league);
  $('onePer').closest('.chk').hidden = mu || pl || lad;
  $('markets').hidden = mu || pl;
  $('search').placeholder = pl ? `Search any ${LEAGUES[state.league].label} player` : 'Player or team';
  $('window').value = state.window;
  $('minRate').value = state.minRate;
  $('floor').value = state.floor;
  $('upcoming').checked = state.upcoming;
  $('onePer').checked = state.onePer;
  const cfg = LEAGUES[state.league];
  // Ladders only exist for receiving yards, rushing yards and receptions.
  const chipMarkets = lad ? cfg.markets.filter((m) => Object.values(cfg.kalshiScalar).some((x) => x.stat === m.id)) : cfg.markets;
  if (state.market !== 'all' && !chipMarkets.some((m) => m.id === state.market)) state.market = 'all';
  $('markets').innerHTML = [{ id: 'all', label: 'All props' }, ...chipMarkets]
    .map((m) => `<button data-market="${m.id}" aria-pressed="${m.id === state.market}">${esc(m.label)}</button>`)
    .join('');
}

function render() {
  renderChrome();
  if (state.loading) return;
  const d = state.data[state.league];
  if (!d) return;

  const status = $('status');
  status.className = 'status';
  if (state.view === 'players') return renderPlayersView(d);
  if (state.view === 'bets' && state.betsKind === 'ladders' && hasLadders(state.league) && !(d.error && !(d.players || []).length)) {
    return renderLadders(d);
  }
  if (state.view === 'matchups' && !(d.error && !(d.players || []).length)) return renderMatchupsView(d);
  const { rows, hasSchedule } = filteredRows(d);

  const bits = [];
  if (d.error && !(d.players || []).length) {
    status.className = 'status err';
    status.innerHTML =
      `Couldn't load ${esc(LEAGUES[state.league].label)} stats (${esc(d.error.message || d.error)}). ` +
      `If ESPN is blocked from your browser, deploy with the included GitHub Action so data is pre-built.`;
  } else if (state.view === 'bets') {
    bits.push(...betsStatus(rows));
    status.innerHTML = bits.join(' · ');
  } else {
    bits.push(`<b>${rows.length}</b> props hitting ${Math.round(Number(state.minRate) * 100)}%+ over the ${windowLabel()}`);
    if (state.upcoming && !hasSchedule) bits.push('no upcoming schedule found, showing everyone');
    if (d.source === 'stale') bits.push('showing older data — live refresh failed');
    status.innerHTML = bits.join(' · ');
  }

  const when = d.generatedAt ? new Date(d.generatedAt) : null;
  $('updated').textContent = when ? `Updated ${when.toLocaleString()}` : '';
  const odds = state.view === 'bets' && state.odds[state.league];
  const log = [...(d.log || []), ...((odds && odds.log) || [])];
  $('diag').hidden = !log.length;
  $('diagText').textContent = log.join('\n');

  if (!rows.length) {
    const msg =
      state.view === 'bets'
        ? odds && !odds.loading && (odds.quotes || []).length
          ? 'None of the listed props beat their price over this sample right now. Try a different sample.'
          : ''
        : 'Nothing clears that bar. Try a lower hit rate, a different sample, or “Deep alts” under Lines.';
    $('results').innerHTML = (state.view === 'bets' ? betsToggle() : '') + ((d.players || []).length && msg ? `<div class="empty">${msg}</div>` : '');
    return;
  }
  $('results').innerHTML =
    state.view === 'sheet' ? renderSheet(rows, d) : state.view === 'bets' ? betsToggle() + renderBets(rows, d) : renderList(rows, d);
}

function gameTag(d, p) {
  const g = nextGame(d, p);
  if (!g) return '';
  const day = g.t ? new Date(g.t).toLocaleDateString(undefined, { weekday: 'short' }) : '';
  return ` · ${g.live ? 'LIVE ' : ''}${g.h} ${esc(g.opp)}${day ? ` ${day}` : ''}`;
}

function dots(r) {
  // oldest -> newest, left to right
  const cells = [...r.hitsArr].reverse().map((h) => `<i class="${h ? '' : 'm'}"></i>`).join('');
  const note = formatNote(r);
  const cls = note.startsWith('Hit') ? 'note good' : 'note';
  return `${cells}${note ? `<span class="${cls}">${esc(note)}</span>` : ''}`;
}

function renderList(rows, d) {
  const items = rows.slice(0, 150).map((r, i) => {
    const p = r.player;
    const key = `${p.id}:${r.market.id}`;
    const open = state.expanded === key;
    const perfect = r.hits === r.n;
    return `<li class="row">
      <button data-expand="${esc(key)}" aria-expanded="${open}">
        <span class="rank">${i + 1}</span>
        <img class="avatar" src="${headshot(p)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <span class="who">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ''}${gameTag(d, p)}</div>
          <div class="prop"><b>${r.line}+</b> ${esc(r.market.label)} <span class="pct">· median ${fmt(r.typical)}</span></div>
        </span>
        <span class="score ${perfect ? 'perfect' : ''}">
          <div class="frac">${r.hits}/${r.n}</div>
          <div class="pct">${Math.round(r.rate * 100)}%</div>
        </span>
        <span class="dots">${dots(r)}</span>
      </button>
      ${open ? renderDetail(r) : ''}
    </li>`;
  });
  return `<ul class="list">${items.join('')}</ul>`;
}

const fmt = (n) => (Math.round(n * 10) / 10).toString();

function renderDetail(r) {
  const p = r.player;
  const key = `${p.id}:${r.market.id}`;
  const line = state.custom[key] ?? r.line;
  const games = sampleGames(p.games, opts().window);
  const values = games.map((g) => r.market.value(g) ?? 0);
  const st = lineStats(values, line);
  const others = LEAGUES[state.league].markets
    .filter((m) => m.id !== r.market.id)
    .map((m) => bestLine(p, m, opts()))
    .filter(Boolean)
    .map((o) => `<span><b>${o.line}+</b> ${esc(o.market.label)} ${o.hits}/${o.n}</span>`);
  return `<div class="detail">
    <h4>${esc(r.market.label)} — ${windowLabel()}</h4>
    ${chart(games, values, line)}
    <div class="custom">
      <span>Test a line:</span>
      <button data-step="-1" data-key="${esc(key)}" aria-label="Lower line">−</button>
      <span class="lineval">${line}+</span>
      <button data-step="1" data-key="${esc(key)}" aria-label="Raise line">+</button>
      <span class="res">hit <b>${st.hits}/${st.n}</b> (${Math.round(st.rate * 100)}%)</span>
    </div>
    ${others.length ? `<h4>Other props that hit for ${esc(p.name.split(' ').slice(-1)[0])}</h4><div class="others">${others.join('')}</div>` : ''}
    <button class="link" data-open-player="${esc(p.id)}">Full game log →</button>
  </div>`;
}

function chart(games, values, line) {
  const n = values.length;
  const W = 640;
  const H = 170;
  const top = 18;
  const bottom = 30;
  const max = Math.max(line * 1.25, ...values, 1);
  const bw = W / Math.max(n, 1);
  const dense = n > 20; // a full season: bars only, details on hover
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const bars = [];
  // oldest on the left
  for (let i = n - 1, x = 0; i >= 0; i--, x++) {
    const v = values[i];
    const g = games[i];
    const hit = v >= line;
    const bx = x * bw + bw * 0.15;
    const w = bw * 0.7;
    bars.push(
      `<rect x="${bx}" y="${y(v)}" width="${w}" height="${Math.max(H - bottom - y(v), 1)}" rx="${dense ? 1 : 3}" fill="${hit ? 'var(--accent)' : 'var(--miss)'}"><title>${esc(g.d)} ${esc(g.h)} ${esc(g.o)}: ${v}</title></rect>`,
    );
    if (dense) continue;
    bars.push(
      `<text class="val" x="${bx + w / 2}" y="${y(v) - 4}" text-anchor="middle">${fmt(v)}</text>`,
      `<text x="${bx + w / 2}" y="${H - bottom + 13}" text-anchor="middle">${esc(g.o)}</text>`,
      `<text x="${bx + w / 2}" y="${H - bottom + 25}" text-anchor="middle">${esc(g.d.slice(5).replace('-', '/'))}</text>`,
    );
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Game by game results against the line">
    ${bars.join('')}
    <line class="ln" x1="0" x2="${W}" y1="${y(line)}" y2="${y(line)}"></line>
  </svg>`;
}

function betsStatus(rows) {
  const odds = state.odds[state.league];
  if (!odds || odds.loading) return ['Loading Kalshi prices…'];
  const venues = Object.entries(odds.venues || {});
  if (!venues.length) return ['Couldn\'t reach Kalshi right now. Try “Refresh” in a minute.'];
  if (!odds.quotes.length) return [`No ${esc(LEAGUES[state.league].label)} player props are listed on ${venues.map(([v]) => VENUES[v]).join(' or ')} right now.`];
  const bits = [`<b>${rows.length}</b> of ${rows.priced || 0} priced props beat the market over the ${windowLabel()}`];
  const missing = Object.keys(VENUES).filter((v) => !odds.venues[v]);
  if (missing.length) bits.push(`${missing.map((v) => VENUES[v]).join(', ')} unavailable`);
  const old = venues.filter(([, when]) => when !== 'live');
  for (const [v, when] of old) bits.push(`${VENUES[v]} prices from ${new Date(when).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  return bits;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const cents = (p) => `${Math.round(p * 100)}¢`;

function renderBets(rows, d) {
  const items = rows.slice(0, 150).map((r, i) => {
    const p = r.player;
    const key = `b:${p.id}:${r.market.id}:${r.line}`;
    const open = state.expanded === key;
    const prices = r.quotes
      .map((q) => `<a href="${esc(q.url)}" target="_blank" rel="noopener" class="venue${q === r.best ? ' best' : ''}">${VENUES[q.v]} ${cents(q.price)} <span>(${americanOdds(q.price)})</span></a>`)
      .join('');
    return `<li class="row">
      <button data-expand="${esc(key)}" aria-expanded="${open}">
        <span class="rank">${i + 1}</span>
        <img class="avatar" src="${headshot(p)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <span class="who">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ''}${gameTag(d, p)}</div>
          <div class="prop"><b>${r.line}+</b> ${esc(r.market.label)} <span class="pct">· hit ${r.hits}/${r.n} · median ${fmt(r.typical)}</span></div>
        </span>
        <span class="score edge">
          <div class="frac">+${Math.round(r.edge * 100)}%</div>
          <div class="pct">edge</div>
        </span>
        <span class="dots">${dots(r)}</span>
      </button>
      <div class="prices">${prices}<span class="vs">Hits ${pct(r.rate)} vs ${pct(r.best.cost)} to buy after fees</span></div>
      ${open ? renderDetail(r) : ''}
    </li>`;
  });
  return `<p class="explain">Edge = how often the player has cleared the market's line (adjusted for small samples) minus what it costs to buy on Kalshi, with Kalshi's trading fee added. Prices and odds shown are exactly what the Kalshi app shows, before the fee. Past hit rates don't account for injuries, matchups or role changes — use it as a starting point.</p>
    <ul class="list">${items.join('')}</ul>`;
}

// ---------- Matchups ----------


let dvpMemo = { data: null, result: null };
function dvpFor(d) {
  if (dvpMemo.data !== d) dvpMemo = { data: d, result: defenseVsPosition(d.players || [], LEAGUES[state.league]) };
  return dvpMemo.result;
}

const signedPct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;

// Rank pill from an over bettor's view: top quarter = tough defense, bottom quarter = soft.
function rankPill(rank, of) {
  if (!rank || !of) return '<span class="pill">–</span>';
  const cls = rank <= Math.ceil(of / 4) ? 'tough' : rank > of - Math.ceil(of / 4) ? 'soft' : '';
  return `<span class="pill ${cls}" title="#${rank} toughest of ${of}">#${rank}</span>`;
}

function marketLabel(id) {
  const m = LEAGUES[state.league].markets.find((x) => x.id === id);
  return m ? m.label : id;
}

// The friendliest spots for offenses against this defense, for the collapsed card.
function softSpots(dvp, def) {
  const out = [];
  for (const [group, stats] of Object.entries((dvp.teams[def] || {}))) {
    for (const [id, a] of Object.entries(stats)) if (a.rank && a.pct > 0.08) out.push({ group, id, a });
  }
  return out.sort((x, y) => y.a.pct - x.a.pct).slice(0, 2);
}

function renderMatchupsView(d) {
  const cfg = LEAGUES[state.league];
  const t = state.teams[state.league];
  const status = $('status');
  $('updated').textContent = d.generatedAt ? `Updated ${new Date(d.generatedAt).toLocaleString()}` : '';
  const injState = state.injuries[state.league];
  const log = [...(d.log || []), ...((t && t.data && t.data.log) || []), ...((injState && injState.data && injState.data.log) || [])];
  $('diag').hidden = !log.length;
  $('diagText').textContent = log.join('\n');

  if (!t || (t.loading && !t.data)) {
    status.innerHTML = 'Loading team defense…';
    $('results').innerHTML = '';
    return;
  }
  const teams = (t.data && t.data.teams) || {};
  const dvp = dvpFor(d);
  const inj = injuryContext(d, teams, dvp);
  const q = state.search.trim().toLowerCase();
  const nameOf = (abbr) => (teams[abbr] && teams[abbr].name) || abbr;
  let games = upcomingGames(d.schedule);
  if (q) games = games.filter((g) => `${g.away} ${g.home} ${nameOf(g.away)} ${nameOf(g.home)}`.toLowerCase().includes(q));

  const bits = [];
  const hasDefense = Object.values(teams).some((x) => x.n);
  if (!hasDefense) {
    status.className = 'status err';
    bits.push(
      `Couldn't load team defense numbers${t.error ? ` (${esc(t.error.message || t.error)})` : ''}. The position stats below still work. Tap “Refresh from ESPN” to try again.`,
    );
  } else {
    bits.push(`<b>${games.length}</b> upcoming game${games.length === 1 ? '' : 's'}`);
    if (t.data) bits.push(`team defense from ${esc(t.data.seasonNote || 'this season')}`);
    if (dvp.window) bits.push(`positions vs defense from each team's last ${dvp.window} games${dvp.mixed ? ' (incl. end of last season)' : ''}`);
    else if (dvp.season) bits.push(`positions vs defense from ${dvp.season} games of tracked players`);
    if (inj.updated) bits.push(`injury report ${inj.live ? 'as of' : 'from'} ${new Date(inj.updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    else if (inj.loading) bits.push('loading injury report…');
    else bits.push('injury report unavailable');
  }
  status.innerHTML = bits.join(' · ');

  const cards = games.map((g) => {
    const key = `g:${g.away}@${g.home}`;
    const open = state.expanded === key;
    const when = g.t ? new Date(g.t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const injChips = [g.away, g.home].flatMap((team) => keyInjuryChips(inj, team));
    const spots = [
      ...injChips,
      ...softSpots(dvp, g.home).map((x) => `${esc(g.away)} ${esc(x.group)}: ${esc(marketLabel(x.id))} ${signedPct(x.a.pct)} vs ${esc(g.home)}`),
      ...softSpots(dvp, g.away).map((x) => `${esc(g.home)} ${esc(x.group)}: ${esc(marketLabel(x.id))} ${signedPct(x.a.pct)} vs ${esc(g.away)}`),
    ];
    return `<li class="row">
      <button class="mu-head" data-expand="${esc(key)}" aria-expanded="${open}">
        <span class="mu-teams">${esc(g.away)} <span class="at">@</span> ${esc(g.home)}</span>
        <span class="mu-when">${g.live ? 'LIVE' : esc(when)}</span>
        <span class="mu-spots">${spots.length ? spots.map((x) => `<span>${x}</span>`).join('') : '<span class="none">Tap for defense and position stats</span>'}</span>
      </button>
      ${open ? `<div class="detail">${matchupSide(d, teams, dvp, inj, g.away, g.home)}${matchupSide(d, teams, dvp, inj, g.home, g.away)}</div>` : ''}
    </li>`;
  });

  const table = renderDefenseTable(teams, cfg);
  $('results').innerHTML = `<p class="explain">For each game: the defense's averages and league ranks (#1 = toughest, green = soft spot for overs), then how each position has done against that defense compared with each player's usual number (his median this season once he has 3 games, otherwise over his recent games). Players to watch skips anyone who hasn't played in the 10 days before his team's latest game (injured, benched or backup). Injuries come from ESPN's injury report: OUT, DOUBT (doubtful), Q (questionable), DTD (day-to-day), and BACK for a tracked player who missed recent games but is off the report now.</p>
    ${games.length ? `<ul class="list">${cards.join('')}</ul>` : '<div class="empty">No upcoming games on the schedule right now.</div>'}
    ${table}`;
}

function matchupSide(d, teams, dvp, inj, off, def) {
  const cfg = LEAGUES[state.league];
  const dt = teams[def] && teams[def].n ? teams[def] : null;
  const defRows = cfg.teamStats
    .map((s) => {
      const v = dt && dt.stats[s.id];
      const of = Object.values(teams).filter((x) => x.ranks[s.id]).length;
      return `<tr><td>${esc(s.label)}</td><td class="num">${Number.isFinite(v) ? fmt(v) : '–'}</td><td>${rankPill(dt && dt.ranks[s.id], of)}</td></tr>`;
    })
    .join('');

  // One table row per position/stat; tapping it reveals the games behind it in a row below.
  const posRows = [];
  for (const [group, ids] of Object.entries(cfg.dvp)) {
    for (const id of ids) {
      const a = ((dvp.teams[def] || {})[group] || {})[id];
      if (!a) continue;
      const games = a.games
        .map(
          (x) =>
            `<li><span class="when">${esc(x.d.slice(5).replace('-', '/'))}</span><span class="who">${esc(x.name)} <span class="muted">${esc(x.team)}</span></span><span class="num">${fmt(x.v)}</span><span class="num muted">usual ${fmt(x.usual)}</span><span class="${x.v > x.usual ? 'up' : 'down'}">${x.v > x.usual ? '✓' : '✗'}</span></li>`,
        )
        .join('');
      posRows.push(
        `<tr class="dvp-row" data-dvp tabindex="0" aria-expanded="false"><td>${esc(group)} · ${esc(marketLabel(id))}</td><td class="num">${fmt(a.avg)}</td><td class="num">${a.overs}/${a.n}</td><td class="num ${a.pct >= 0 ? 'up' : 'down'}">${signedPct(a.pct)}</td><td>${rankPill(a.rank, a.of)}</td></tr>
        <tr class="dvp-games-row" hidden><td colspan="5"><ul class="dvp-games">${games}</ul></td></tr>`,
      );
    }
  }

  // Offense players we track, with how their position has done against this defense.
  const markets = new Map(cfg.markets.map((m) => [m.id, m]));
  const watch = [];
  // Only players who've played recently: injured, benched and backup players drop off.
  for (const p of activePlayers(d.players || [])) {
    if (p.team !== off) continue;
    const g = cfg.positionGroups.find((x) => x.match.includes(String(p.pos || '').toUpperCase()));
    const ids = g && cfg.dvp[g.label];
    if (!ids) continue;
    const id = ids[0];
    const usual = usualValue(p, markets.get(id), dvp.season);
    if (!(usual > 0)) continue;
    const a = ((dvp.teams[def] || {})[g.label] || {})[id];
    watch.push({ p, id, usual, a, group: g.label });
  }
  watch.sort((x, y) => (y.a ? y.a.pct : -9) - (x.a ? x.a.pct : -9));
  const watchHtml = watch
    .slice(0, 8)
    .map(
      (w) =>
        `<li>${playerBadge(inj, w.p)}<b>${esc(w.p.name)}</b> <span class="muted">${esc(w.p.pos)}</span> · usual ${fmt(w.usual)} ${esc(marketLabel(w.id))}${
          w.a ? ` · <span class="${w.a.pct >= 0 ? 'up' : 'down'}">${esc(w.group)} vs ${esc(def)} ${signedPct(w.a.pct)}</span>` : ''
        }</li>`,
    )
    .join('');

  return `<section class="mu-side">
    <h4>${esc(off)} offense vs ${esc((dt && dt.name) || def)} defense</h4>
    ${
      dt
        ? `<div class="tscroll"><table class="mtable">
      <thead><tr><th>Defense</th><th class="num">Per game</th><th>Rank of ${Object.values(teams).filter((x) => x.n).length}</th></tr></thead>
      <tbody>${defRows}</tbody>
    </table></div>`
        : `<p class="explain">Team defense numbers for ${esc(def)} aren't available right now.</p>`
    }
    ${
      posRows.length
        ? `<div class="tscroll"><table class="mtable">
      <thead><tr><th>Vs position</th><th class="num">Avg</th><th class="num">Beat usual</th><th class="num">Vs usual</th><th>Rank</th></tr></thead>
      <tbody>${posRows.join('')}</tbody>
    </table></div>`
        : `<p class="explain">No tracked players have faced ${esc(def)} yet this season.</p>`
    }
    ${watchHtml ? `<h4>${esc(off)} players to watch</h4><ul class="watch">${watchHtml}</ul>` : ''}
    ${injurySection(inj, off, def)}
  </section>`;
}

// ---------- Injuries in Matchups ----------

const OFFENSE_POS = new Set(['QB', 'RB', 'FB', 'HB', 'WR', 'TE', 'T', 'G', 'C', 'OT', 'OG', 'OL', 'LT', 'RT', 'LG', 'RG']);
const BADGE = { out: 'OUT', doubtful: 'DOUBT', q: 'Q', dtd: 'DTD' };

function injuryContext(d, teams, dvp) {
  const st = state.injuries[state.league];
  const data = st && st.data;
  const list = (data && data.ok && data.list) || [];
  const players = d.players || [];
  const byTeam = injuriesByTeam(list, teams, players);
  const byPlayer = new Map(list.filter((x) => x.id).map((x) => [x.id, x]));
  const back = {};
  for (const r of returningPlayers(players, new Set(byPlayer.keys()), dvp.season)) (back[r.player.team] = back[r.player.team] || []).push(r);
  const tracked = new Set(players.map((p) => String(p.id)));
  return {
    byTeam,
    byPlayer,
    back,
    tracked,
    updated: data && data.ok ? data.generatedAt : null,
    live: Boolean(data && data.ok && !data.fromFile),
    loading: Boolean(st && st.loading && !data),
  };
}

const isNew = (x) => x.date && Date.now() - Date.parse(x.date) < 7 * 86400000;

function injuryLine(x) {
  const when = isNew(x)
    ? '<span class="inj-new">new this week</span>'
    : x.date
      ? `<span class="muted">since ${esc(new Date(x.date).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }))}</span>`
      : '';
  const ret = x.returnDate ? ` <span class="muted">· est. return ${esc(new Date(x.returnDate).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }))}</span>` : '';
  return `<li><span class="inj-badge ${x.level}">${BADGE[x.level]}</span><b>${esc(x.name)}</b> <span class="muted">${esc(x.pos)}${x.part ? ` · ${esc(x.part)}` : ''}</span> ${when}${ret}</li>`;
}

function playerBadge(inj, p) {
  const x = inj.byPlayer.get(String(p.id));
  if (x) return `<span class="inj-badge ${x.level}">${BADGE[x.level]}</span>`;
  if ((inj.back[p.team] || []).some((r) => r.player.id === p.id)) return '<span class="inj-badge back">BACK</span>';
  return '';
}

// Collapsed-card chips: tracked (prop-relevant) players who are hurt or returning.
function keyInjuryChips(inj, team) {
  const hurt = (inj.byTeam[team] || []).filter((x) => inj.tracked.has(x.id) && x.level !== 'dtd');
  const chips = hurt.slice(0, 3).map((x) => `<span class="chip-inj">${BADGE[x.level]} ${esc(x.name)} (${esc(team)})</span>`);
  for (const r of (inj.back[team] || []).slice(0, 2)) chips.push(`<span class="chip-back">BACK ${esc(r.player.name)} (${esc(team)})</span>`);
  return chips;
}

function injurySection(inj, off, def) {
  if (!inj.updated) return '';
  const football = LEAGUES[state.league].kind === 'football';
  const offList = (inj.byTeam[off] || []).filter((x) => !football || !x.pos || OFFENSE_POS.has(x.pos.toUpperCase()));
  const defList = football ? (inj.byTeam[def] || []).filter((x) => x.pos && !OFFENSE_POS.has(x.pos.toUpperCase())) : [];
  const backList = (inj.back[off] || []).map(
    (r) =>
      `<li><span class="inj-badge back">BACK</span><b>${esc(r.player.name)}</b> <span class="muted">${esc(r.player.pos)} · missed last ${r.missed} game${r.missed === 1 ? '' : 's'}, not on the report now</span></li>`,
  );
  const block = (title, items) =>
    `<div class="inj-block"><h5>${title}</h5>${items.length ? `<ul class="inj">${items.join('')}</ul>` : '<p class="muted inj-none">Nothing on the report.</p>'}</div>`;
  return `<h4>Injuries</h4><div class="inj-grid">
    ${block(`${esc(off)} ${football ? 'offense' : 'roster'}`, [...backList, ...offList.map(injuryLine)])}
    ${football ? block(`${esc(def)} defense`, defList.map(injuryLine)) : ''}
  </div>`;
}

function renderDefenseTable(teams, cfg) {
  const list = Object.values(teams).filter((t) => t.n);
  if (!list.length) return '';
  const first = cfg.teamStats[0].id;
  list.sort((a, b) => (a.ranks[first] || 99) - (b.ranks[first] || 99));
  const head = cfg.teamStats.map((s) => `<th class="num">${esc(s.label.replace(' allowed', ''))}</th>`).join('');
  const rows = list
    .map(
      (t) =>
        `<tr><td><b>${esc(t.abbr)}</b></td>${cfg.teamStats
          .map((s) => {
            const r = t.ranks[s.id];
            const cls = r && r <= Math.ceil(list.length / 4) ? 'tough' : r && r > list.length - Math.ceil(list.length / 4) ? 'soft' : '';
            return `<td class="num ${cls}">${Number.isFinite(t.stats[s.id]) ? fmt(t.stats[s.id]) : '–'}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return `<details class="alldef"><summary>All team defenses (per game allowed)</summary>
    <div class="tscroll"><table class="mtable"><thead><tr><th>Team</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
  </details>`;
}

// ---------- Best bets: ladders & escalators ----------

const hasLadders = (key) => Boolean(LEAGUES[key].kalshiScalar);
const STAT_LABEL = { recYds: 'Rec Yds', rushYds: 'Rush Yds', rec: 'Receptions' };
const signedCents = (x) => `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(1)}¢`;

function betsToggle() {
  if (!hasLadders(state.league)) return '';
  const b = (k, label) => `<button data-bets-kind="${k}" aria-pressed="${state.betsKind === k}">${label}</button>`;
  return `<div class="chips bets-kind">${b('props', 'Yes/no props')}${b('ladders', 'Ladders &amp; escalators')}</div>`;
}

function renderLadders(d) {
  const status = $('status');
  const odds = state.odds[state.league];
  const q = state.search.trim().toLowerCase();
  let players = d.players || [];
  if (q) players = players.filter((p) => `${p.name} ${p.team}`.toLowerCase().includes(q));
  let rows = scalarRows(players, (odds && odds.scalars) || [], nameKey, opts());
  if (state.market !== 'all') rows = rows.filter((r) => r.q.stat === state.market);
  const good = rows.filter((r) => r.edge > 0).length;
  if (!odds || odds.loading) status.innerHTML = 'Loading Kalshi prices…';
  else if (!(odds.scalars || []).length) status.innerHTML = Object.keys(odds.venues || {}).length ? 'No ladders or escalators are listed on Kalshi right now.' : betsStatus([])[0];
  else status.innerHTML = `<b>${good}</b> of ${rows.length} ladders &amp; escalators are worth more than their price over the ${windowLabel()}`;
  const log = [...(d.log || []), ...((odds && odds.log) || [])];
  $('diag').hidden = !log.length;
  $('diagText').textContent = log.join('\n');

  const items = rows.slice(0, 150).map((r, i) => {
    const p = r.player;
    const key = `l:${p.id}:${r.q.kind}:${r.q.stat}`;
    const open = state.expanded === key;
    const ladder = r.q.kind === 'ladder';
    const unit = ladder ? (r.q.stat === 'rec' ? '5¢ per catch' : '0.25¢ per yard') : 'pays more for bigger games';
    const sideCost = r.side === 'YES' ? r.q.cost : 1 - r.q.bid + kalshiFee(r.q.bid);
    const roi = r.edge / sideCost;
    const read = ladder
      ? `Price expects <b>${fmt(r.implied)}</b> ${r.q.stat === 'rec' ? 'catches' : 'yds'} · his avg ${fmt(r.avg)} (median ${fmt(r.med)})`
      : `Worth <b>${cents(r.worth)}</b> a game on his ${r.games.length} games · paid more than the price in ${r.beat}/${r.games.length}`;
    const games = r.games
      .map((g, j) => `<li><span class="when">${esc(g.d.slice(5).replace('-', '/'))}</span><span class="who">${esc(g.h === '@' ? '@' : 'vs')} ${esc(g.o)}</span><span class="num">${fmt(r.values[j])}</span><span class="num muted">pays ${(r.pays[j] * 100).toFixed(1)}¢</span><span class="${r.pays[j] > r.q.price ? 'up' : 'down'}">${r.pays[j] > r.q.price ? '✓' : '✗'}</span></li>`)
      .join('');
    return `<li class="row">
      <button data-expand="${esc(key)}" aria-expanded="${open}">
        <span class="rank">${i + 1}</span>
        <img class="avatar" src="${headshot(p)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <span class="who">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ''}${gameTag(d, p)}</div>
          <div class="prop"><b>${esc(STAT_LABEL[r.q.stat] || r.q.stat)} ${ladder ? 'ladder' : 'escalator'}</b> <span class="pct">· ${unit}</span></div>
        </span>
        <span class="score ${r.edge > 0 ? 'edge' : 'neg'}">
          <div class="frac">${r.edge > 0 ? `${r.side} +${Math.round(roi * 100)}%` : `${Math.round(roi * 100)}%`}</div>
          <div class="pct">${signedCents(r.edge)} / contract</div>
        </span>
      </button>
      <div class="prices"><a href="${esc(r.q.url)}" target="_blank" rel="noopener" class="venue best">Kalshi YES ${cents(r.q.price)}${r.q.bid ? ` <span>· NO ${cents(1 - r.q.bid)}</span>` : ''}</a><span class="vs">${read}</span></div>
      ${open ? `<div class="detail"><h4>What each game would have paid</h4><ul class="dvp-games">${games}</ul></div>` : ''}
    </li>`;
  });
  $('results').innerHTML = `${betsToggle()}<p class="explain">Ladders pay a fixed slice of $1 per yard or catch (rec/rush yards 0.25¢ a yard up to 400, receptions 5¢ a catch up to 20). Escalators pay (yards ÷ 200)³ in 10-yard steps (catches: (n ÷ 14)³), so most of their value is in rare huge games. “Worth” is what the contract would have paid on average over the ${windowLabel()}; the edge compares that with buying YES at the ask, or NO at 1 − bid, after Kalshi's fee. Escalator numbers swing a lot on small samples — one 150-yard game moves them.</p>
    ${rows.length ? `<ul class="list">${items.join('')}</ul>` : ''}`;
}

// ---------- Players: any player's game log ----------

function seasonLabel(s) {
  if (!s) return 'this season';
  return LEAGUES[state.league].kind === 'basketball' ? `${s - 1}-${String(s).slice(2)} season` : `${s} season`;
}

function renderPlayersView(d) {
  const status = $('status');
  const cfg = LEAGUES[state.league];
  $('diag').hidden = true;
  if (state.pick) return renderPlayerCard(d);

  const roster = state.rosters[state.league];
  const tracked = d.players || [];
  const all = (roster && roster.players) || [];
  const total = new Set([...tracked, ...all].map((p) => p.id)).size;
  status.innerHTML =
    roster && roster.loading
      ? `Loading the ${esc(cfg.label)} player list…`
      : `Search ${total.toLocaleString()} ${esc(cfg.label)} players${cfg.roster ? '' : ' (stat leaders)'} · last 5–20 games or this season`;
  const q = state.search.trim();
  if (!q) {
    $('results').innerHTML = '<div class="empty">Type a player\'s name (or a team like “SF”) above.</div>';
    return;
  }
  const matches = searchPlayers(q, [tracked, all]);
  state.matches = new Map(matches.map((p) => [p.id, p]));
  if (!matches.length) {
    $('results').innerHTML = `<div class="empty">No ${esc(cfg.label)} player matches “${esc(q)}”.</div>`;
    return;
  }
  $('results').innerHTML = `<ul class="list">${matches
    .map(
      (p) => `<li class="row"><button class="pl-row" data-pick="${esc(p.id)}">
        <img class="avatar" src="${headshot(p)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <span class="who">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ''}${gameTag(d, p)}</div>
        </span>
        <span class="chev" aria-hidden="true">›</span>
      </button></li>`,
    )
    .join('')}</ul>`;
}

// Ladder line closest to the player's median: where a book would hang the main line.
function mainLine(m, values) {
  const mid = median(values);
  return m.ladder.reduce((best, l) => (Math.abs(l - mid) < Math.abs(best - mid) ? l : best), m.ladder[0]);
}

function renderPlayerCard(d) {
  const cfg = LEAGUES[state.league];
  const pick = state.pick;
  const tracked = (d.players || []).find((p) => p.id === pick.id);
  const look = state.lookups[`${pick.league}:${pick.id}`] || {};
  const allGames = (look.games && look.games.length ? look.games : tracked && tracked.games) || [];
  const p = { ...pick, ...(tracked || {}), games: allGames };
  const status = $('status');
  status.innerHTML = look.loading ? 'Pulling the latest game log…' : '';
  const back = state.search.trim() ? '<button class="link" data-back>← Back to results</button>' : '';
  const head = `<div class="pl-head">
      <img class="avatar big" src="${headshot(p)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="who"><div class="name">${esc(p.name)}</div>
      <div class="meta">${esc(p.team)}${p.pos ? ` · ${esc(p.pos)}` : ''}${gameTag(d, p)}</div></div>
    </div>`;
  if (!allGames.length) {
    const msg = look.loading
      ? ''
      : look.error
        ? `Couldn't load ${esc(p.name)}'s game log (${esc(look.error.message || look.error)}). Try “Refresh” in a minute.`
        : `No games found for ${esc(p.name)} yet.`;
    $('results').innerHTML = `${back}<div class="pcard">${head}${msg ? `<div class="empty">${msg}</div>` : ''}</div>`;
    return;
  }

  const win = opts().window;
  const games = sampleGames(allGames, win);
  const label = win === 'season' ? seasonLabel(allGames[0].s) : `Last ${games.length} games`;
  if (look.error && !look.games) status.innerHTML = 'Showing saved games — live refresh failed.';

  // Prop tiles: the markets this player plays, with avg / median over the sample.
  const markets = cfg.markets.filter((m) => !m.yesNo && m.eligible(allGames.slice(0, 10)));
  if (!markets.some((m) => m.id === state.pickMarket)) state.pickMarket = markets.length ? markets[0].id : null;
  const tiles = markets
    .map((m) => {
      const vals = games.map((g) => m.value(g) ?? 0);
      const avgV = vals.reduce((a, b) => a + b, 0) / vals.length;
      return `<button class="tile" data-pm="${m.id}" aria-pressed="${m.id === state.pickMarket}">
        <span class="tl">${esc(m.label)}</span><b>${fmt(avgV)}</b><span class="tm">med ${fmt(median(vals))}</span></button>`;
    })
    .join('');

  let propBox = '';
  const m = markets.find((x) => x.id === state.pickMarket);
  if (m) {
    const values = games.map((g) => m.value(g) ?? 0);
    const key = `p:${p.id}:${m.id}`;
    const base = mainLine(m, allGames.slice(0, 20).map((g) => m.value(g) ?? 0));
    const line = state.custom[key] ?? base;
    const st = lineStats(values, line);
    const stepSize = m.ladder[1] - m.ladder[0] >= 5 ? 5 : 1;
    propBox = `<div class="detail">
      <h4>${esc(m.label)} — ${esc(label.toLowerCase())}</h4>
      ${chart(games, values, line)}
      <div class="custom">
        <span>Line:</span>
        <button data-step="-${stepSize}" data-key="${esc(key)}" data-base="${base}" aria-label="Lower line">−</button>
        <span class="lineval">${line}+</span>
        <button data-step="${stepSize}" data-key="${esc(key)}" data-base="${base}" aria-label="Raise line">+</button>
        <span class="res">hit <b>${st.hits}/${st.n}</b> (${Math.round(st.rate * 100)}%)${formatNote(st) ? ` · ${esc(formatNote(st))}` : ''}</span>
      </div>
    </div>`;
  }

  $('results').innerHTML = `${back}<div class="pcard">${head}
    <div class="pl-sub">${esc(label)}${look.loading ? ' · updating…' : ''}</div>
    ${tiles ? `<div class="tiles">${tiles}</div>` : ''}
    ${propBox}
    ${gameLogTable(games, cfg)}
  </div>`;
}

function gameLogTable(games, cfg) {
  const groups = cfg.log.filter((g) => g.show(games));
  if (!groups.length) return '<div class="empty">ESPN has no offensive stats for this player.</div>';
  const keys = Object.keys(cfg.stats);
  const avgGame = {};
  for (const k of keys) avgGame[k] = Number(fmt(games.reduce((a, g) => a + (g[k] ?? 0), 0) / games.length));
  const cell = (c, g, isAvg) => {
    const text = c.text ? c.text(g) : isAvg ? fmt(c.value(g) ?? 0) : c.value(g) ?? 0;
    return `<td class="num">${esc(text)}</td>`;
  };
  const cols = groups.flatMap((g) => g.cols.map((c, i) => ({ ...c, first: i === 0 })));
  const groupRow =
    groups.length > 1 || groups[0].label
      ? `<tr class="grp"><th colspan="3"></th>${groups.map((g) => `<th colspan="${g.cols.length}">${esc(g.label)}</th>`).join('')}</tr>`
      : '';
  const rows = games
    .map((g) => {
      const res = g.r ? `<span class="${g.r === 'W' ? 'up' : g.r === 'L' ? 'down' : ''}">${esc(g.r)}</span> ${esc(g.sc)}` : esc(g.sc);
      return `<tr><td>${esc(g.d.slice(5).replace('-', '/'))}${g.p ? ' <small class="muted">PO</small>' : ''}</td><td>${esc(g.h === '@' ? '@' : 'vs')} ${esc(g.o)}</td><td>${res}</td>${cols.map((c) => cell(c, g, false)).join('')}</tr>`;
    })
    .join('');
  return `<div class="tscroll"><table class="mtable glog">
    <thead>${groupRow}<tr><th>Date</th><th>Opp</th><th>Result</th>${cols.map((c) => `<th class="num">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">Average</td>${cols.map((c) => cell(c, avgGame, true)).join('')}</tr></tfoot>
  </table></div>`;
}

function openPlayer(p) {
  state.pick = { league: state.league, id: p.id, name: p.name, pos: p.pos || '', team: p.team || '', teamId: p.teamId || '' };
  state.pickMarket = null;
  savePrefs();
  render();
  window.scrollTo({ top: 0 });
  ensurePlayerGames();
}

function renderSheet(rows, d) {
  const cfg = LEAGUES[state.league];
  const names = shortNames(rows.map((r) => r.player));
  const groups = cfg.positionGroups.map((g) => ({ ...g, rows: [] }));
  const other = { label: 'Others', rows: [] };
  for (const r of rows) {
    const pos = String(r.player.pos || '').toUpperCase();
    (groups.find((g) => g.match.includes(pos)) || other).rows.push(r);
  }
  const lines = [];
  const html = [...groups, other]
    .filter((g) => g.rows.length)
    .map((g) => {
      lines.push('', g.label);
      const items = g.rows.slice(0, 25).map((r) => {
        const note = formatNote(r);
        const text = `${names.get(r.player.id)} ${r.line}+ ${r.market.label} ${r.hits}/${r.n}${note.startsWith('Missed') ? ` (${note})` : ''}`;
        lines.push(`- ${text}${r.hits === r.n ? ' ✅' : ''}`);
        return `<li>${esc(text)}${r.hits === r.n ? ' ✅' : ''}<span class="muted">${gameTag(d, r.player)}</span></li>`;
      });
      return `<h3>${esc(g.label)}</h3><ul>${items.join('')}</ul>`;
    })
    .join('');
  const title = `${cfg.label} Cheatsheet`;
  state.sheetText = `${title} (${windowLabel()})\n${lines.join('\n')}`;
  return `<div class="sheet">
    <div class="title"><h2>${esc(title)} 🚨</h2><button class="copy" id="copySheet">Copy</button></div>
    ${html}
  </div>`;
}

// ---------- events ----------

$('leagues').addEventListener('click', (e) => {
  const b = e.target.closest('[data-league]');
  if (!b || b.dataset.league === state.league) return;
  state.league = b.dataset.league;
  state.market = 'all';
  state.expanded = null;
  state.pick = null;
  savePrefs();
  ensureData();
  ensureOdds();
  if (state.view === 'players') ensureRoster();
  if (state.view === 'matchups') {
    ensureTeams();
    ensureInjuries();
  }
});

$('view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.view = b.dataset.v;
  state.expanded = null;
  savePrefs();
  render();
  if (state.view === 'bets') ensureOdds();
  if (state.view === 'matchups') {
    ensureTeams();
    ensureInjuries();
  }
  if (state.view === 'players') {
    ensureRoster();
    ensurePlayerGames();
  }
});

$('markets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-market]');
  if (!b) return;
  state.market = b.dataset.market;
  savePrefs();
  render();
});

for (const [id, key] of [['window', 'window'], ['minRate', 'minRate'], ['floor', 'floor']]) {
  $(id).addEventListener('change', (e) => {
    state[key] = e.target.value;
    state.custom = {};
    savePrefs();
    render();
  });
}
for (const [id, key] of [['upcoming', 'upcoming'], ['onePer', 'onePer']]) {
  $(id).addEventListener('change', (e) => {
    state[key] = e.target.checked;
    savePrefs();
    render();
  });
}
let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    if (state.view === 'players') state.pick = null; // a new search goes back to the results
    render();
  }, 120);
});

$('results').addEventListener('click', async (e) => {
  const dvpRow = e.target.closest('[data-dvp]');
  if (dvpRow) {
    const games = dvpRow.nextElementSibling;
    games.hidden = !games.hidden;
    dvpRow.setAttribute('aria-expanded', String(!games.hidden));
    return;
  }
  const kindBtn = e.target.closest('[data-bets-kind]');
  if (kindBtn) {
    state.betsKind = kindBtn.dataset.betsKind;
    state.expanded = null;
    savePrefs();
    return render();
  }
  const pickBtn = e.target.closest('[data-pick]');
  if (pickBtn) return openPlayer(state.matches.get(pickBtn.dataset.pick));
  if (e.target.closest('[data-back]')) {
    state.pick = null;
    savePrefs();
    return render();
  }
  const pm = e.target.closest('[data-pm]');
  if (pm) {
    state.pickMarket = pm.dataset.pm;
    return render();
  }
  const openBtn = e.target.closest('[data-open-player]');
  if (openBtn) {
    const p = (state.data[state.league].players || []).find((x) => x.id === openBtn.dataset.openPlayer);
    if (!p) return;
    state.view = 'players';
    state.search = '';
    $('search').value = '';
    ensureRoster();
    return openPlayer(p);
  }
  const step = e.target.closest('[data-step]');
  if (step && step.dataset.base) {
    const key = step.dataset.key;
    state.custom[key] = Math.max(0, (state.custom[key] ?? Number(step.dataset.base)) + Number(step.dataset.step));
    return render();
  }
  if (step) {
    const key = step.dataset.key;
    const row = filteredRows(state.data[state.league]).rows.find((r) => `${r.player.id}:${r.market.id}` === key);
    const cur = state.custom[key] ?? (row ? row.line : 0);
    state.custom[key] = Math.max(0, cur + Number(step.dataset.step));
    return render();
  }
  if (e.target.id === 'copySheet') {
    try {
      await navigator.clipboard.writeText(state.sheetText || '');
      e.target.textContent = 'Copied!';
    } catch {
      e.target.textContent = 'Copy failed';
    }
    return;
  }
  const ex = e.target.closest('[data-expand]');
  if (ex) {
    state.expanded = state.expanded === ex.dataset.expand ? null : ex.dataset.expand;
    render();
  }
});

$('results').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-dvp]')) {
    e.preventDefault();
    e.target.click();
  }
});

$('refresh').addEventListener('click', () => {
  ensureData(true);
  if (state.view === 'bets') ensureOdds(true);
  if (state.view === 'matchups') {
    ensureTeams(true);
    ensureInjuries(true);
  }
  if (state.view === 'players') ensurePlayerGames(true);
});

$('floor').innerHTML = LINE_FLOORS.map((f) => `<option value="${f.value}">${esc(f.label)}</option>`).join('');
if (!LINE_FLOORS.some((f) => String(f.value) === state.floor)) state.floor = String(DEFAULT_FLOOR);
renderChrome();
ensureData();
if (state.view === 'bets') ensureOdds();
if (state.view === 'matchups') {
  ensureTeams();
  ensureInjuries();
}
if (state.view === 'players') {
  ensureRoster();
  ensurePlayerGames();
}
