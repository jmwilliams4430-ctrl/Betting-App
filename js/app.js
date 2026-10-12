import { LEAGUES, LEAGUE_KEYS, LINE_FLOORS, DEFAULT_FLOOR } from './config.js';
import { buildLeagueData } from './espn.js';
import { fetchMarketQuotes, nameKey } from './odds.js';
import { buildTeamData } from './teams.js';
import { computeRows, onePerPlayer, lineStats, sampleGames, bestLine, formatNote, bestBets, americanOdds, defenseVsPosition, median } from './props.js';

const STATIC_MAX_AGE = 36 * 3600e3; // pre-built data/*.json older than this triggers a live pull
const CACHE_MAX_AGE = 3 * 3600e3;
const ODDS_MAX_AGE = 12 * 3600e3; // pre-built market prices older than this are ignored
const ODDS_REFRESH = 5 * 60e3; // re-pull live prices after this long
const TEAMS_CACHE_AGE = 6 * 3600e3;
const VENUES = { K: 'Kalshi', P: 'Polymarket US' };
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
  expanded: null, // "playerId:marketId"
  custom: {}, // "playerId:marketId" -> custom line
  loading: false,
};
if (!LEAGUES[state.league]) state.league = 'nfl';

function savePrefs() {
  const { league, view, window, minRate, floor, market, upcoming, onePer } = state;
  store.set('prefs', { league, view, window, minRate, floor, market, upcoming, onePer });
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

const hasMarkets = (key) => Boolean(LEAGUES[key].kalshiSeries || LEAGUES[key].polyTag);

// Live prices from Kalshi + Polymarket, topped up per venue from the pre-built file
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
  const venues = {};
  for (const v of Object.keys(VENUES)) {
    if (live.venues[v]) {
      quotes.push(...live.quotes.filter((q) => q.v === v));
      venues[v] = 'live';
    } else if (stat && stat.venues && stat.venues[v] && age(stat) < ODDS_MAX_AGE) {
      quotes.push(...stat.quotes.filter((q) => q.v === v));
      venues[v] = stat.generatedAt;
    }
  }
  state.odds[key] = { quotes, venues, log: live.log, fetchedAt: Date.now(), loading: false };
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
  const mu = state.view === 'matchups';
  for (const id of ['minRate', 'floor']) $(id).closest('.field').hidden = state.view === 'bets' || mu;
  $('window').closest('.field').hidden = mu;
  $('upcoming').closest('.chk').hidden = state.view === 'bets' || mu;
  $('onePer').closest('.chk').hidden = mu;
  $('markets').hidden = mu;
  $('window').value = state.window;
  $('minRate').value = state.minRate;
  $('floor').value = state.floor;
  $('upcoming').checked = state.upcoming;
  $('onePer').checked = state.onePer;
  const cfg = LEAGUES[state.league];
  if (state.market !== 'all' && !cfg.markets.some((m) => m.id === state.market)) state.market = 'all';
  $('markets').innerHTML = [{ id: 'all', label: 'All props' }, ...cfg.markets]
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
    $('results').innerHTML = (d.players || []).length && msg ? `<div class="empty">${msg}</div>` : '';
    return;
  }
  $('results').innerHTML =
    state.view === 'sheet' ? renderSheet(rows, d) : state.view === 'bets' ? renderBets(rows, d) : renderList(rows, d);
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
      `<rect x="${bx}" y="${y(v)}" width="${w}" height="${Math.max(H - bottom - y(v), 1)}" rx="3" fill="${hit ? 'var(--accent)' : 'var(--miss)'}"><title>${esc(g.d)} ${esc(g.h)} ${esc(g.o)}: ${v}</title></rect>`,
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
  if (!odds || odds.loading) return ['Loading Kalshi and Polymarket US prices…'];
  const venues = Object.entries(odds.venues || {});
  if (!venues.length) return ['Couldn\'t reach Kalshi or Polymarket US right now. Try “Refresh” in a minute.'];
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
  return `<p class="explain">Edge = how often the player has cleared the market's line (adjusted for small samples) minus what it costs to buy on Kalshi or Polymarket US, with each one's trading fee added. Prices and odds shown are exactly what each app shows, before fees. Past hit rates don't account for injuries, matchups or role changes — use it as a starting point.</p>
    <ul class="list">${items.join('')}</ul>`;
}

// ---------- Matchups ----------

function upcomingGames(schedule) {
  const seen = new Set();
  const games = [];
  for (const [team, g] of Object.entries(schedule || {})) {
    if (team.startsWith('id:') || g.h !== '@') continue;
    const key = `${team}@${g.opp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    games.push({ away: team, home: g.opp, t: g.t, live: g.live });
  }
  return games.sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

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
  const log = [...(d.log || []), ...((t && t.data && t.data.log) || [])];
  $('diag').hidden = !log.length;
  $('diagText').textContent = log.join('\n');

  if (!t || (t.loading && !t.data)) {
    status.innerHTML = 'Loading team defense…';
    $('results').innerHTML = '';
    return;
  }
  const teams = (t.data && t.data.teams) || {};
  const dvp = dvpFor(d);
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
    if (dvp.season) bits.push(`positions vs defense from ${dvp.season} games of tracked players`);
  }
  status.innerHTML = bits.join(' · ');

  const cards = games.map((g) => {
    const key = `g:${g.away}@${g.home}`;
    const open = state.expanded === key;
    const when = g.t ? new Date(g.t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const spots = [
      ...softSpots(dvp, g.home).map((x) => `${esc(g.away)} ${esc(x.group)}: ${esc(marketLabel(x.id))} ${signedPct(x.a.pct)} vs ${esc(g.home)}`),
      ...softSpots(dvp, g.away).map((x) => `${esc(g.home)} ${esc(x.group)}: ${esc(marketLabel(x.id))} ${signedPct(x.a.pct)} vs ${esc(g.away)}`),
    ];
    return `<li class="row">
      <button class="mu-head" data-expand="${esc(key)}" aria-expanded="${open}">
        <span class="mu-teams">${esc(g.away)} <span class="at">@</span> ${esc(g.home)}</span>
        <span class="mu-when">${g.live ? 'LIVE' : esc(when)}</span>
        <span class="mu-spots">${spots.length ? spots.map((x) => `<span>${x}</span>`).join('') : '<span class="none">Tap for defense and position stats</span>'}</span>
      </button>
      ${open ? `<div class="detail">${matchupSide(d, teams, dvp, g.away, g.home)}${matchupSide(d, teams, dvp, g.home, g.away)}</div>` : ''}
    </li>`;
  });

  const table = renderDefenseTable(teams, cfg);
  $('results').innerHTML = `<p class="explain">For each game: the defense's averages and league ranks (#1 = toughest, green = soft spot for overs), then how each position has done against that defense compared with each player's usual number (his median over his recent games).</p>
    ${games.length ? `<ul class="list">${cards.join('')}</ul>` : '<div class="empty">No upcoming games on the schedule right now.</div>'}
    ${table}`;
}

function matchupSide(d, teams, dvp, off, def) {
  const cfg = LEAGUES[state.league];
  const dt = teams[def] && teams[def].n ? teams[def] : null;
  const defRows = cfg.teamStats
    .map((s) => {
      const v = dt && dt.stats[s.id];
      const of = Object.values(teams).filter((x) => x.ranks[s.id]).length;
      return `<tr><td>${esc(s.label)}</td><td class="num">${Number.isFinite(v) ? fmt(v) : '–'}</td><td>${rankPill(dt && dt.ranks[s.id], of)}</td></tr>`;
    })
    .join('');

  // One expandable block per position/stat: the summary line, then every game behind it.
  const posRows = [];
  for (const [group, ids] of Object.entries(cfg.dvp)) {
    for (const id of ids) {
      const a = ((dvp.teams[def] || {})[group] || {})[id];
      if (!a) continue;
      const games = a.games
        .map(
          (x) =>
            `<li><span class="when">${esc(x.d.slice(5).replace('-', '/'))}</span><span class="who">${esc(x.name)} <span class="muted">${esc(x.team)}</span></span><span class="num">${fmt(x.v)}</span><span class="num muted">usual ${fmt(x.usual)}</span><span class="${x.v > x.usual ? 'up' : 'down'}">${x.v > x.usual ? '✓ over' : '✗ under'}</span></li>`,
        )
        .join('');
      posRows.push(`<details class="dvp">
        <summary>
          <span class="lbl">${esc(group)} · ${esc(marketLabel(id))}</span>
          <span class="num">${fmt(a.avg)}/g</span>
          <span class="num">${a.overs}/${a.n} over</span>
          <span class="num ${a.pct >= 0 ? 'up' : 'down'}">${signedPct(a.pct)}</span>
          ${rankPill(a.rank, a.of)}
        </summary>
        <ul class="dvp-games">${games}</ul>
      </details>`);
    }
  }

  // Offense players we track, with how their position has done against this defense.
  const markets = new Map(cfg.markets.map((m) => [m.id, m]));
  const watch = [];
  for (const p of d.players || []) {
    if (p.team !== off) continue;
    const g = cfg.positionGroups.find((x) => x.match.includes(String(p.pos || '').toUpperCase()));
    const ids = g && cfg.dvp[g.label];
    if (!ids) continue;
    const id = ids[0];
    const usual = median(p.games.map((x) => markets.get(id).value(x) ?? 0));
    if (!(usual > 0)) continue;
    const a = ((dvp.teams[def] || {})[g.label] || {})[id];
    watch.push({ p, id, usual, a, group: g.label });
  }
  watch.sort((x, y) => (y.a ? y.a.pct : -9) - (x.a ? x.a.pct : -9));
  const watchHtml = watch
    .slice(0, 8)
    .map(
      (w) =>
        `<li><b>${esc(w.p.name)}</b> <span class="muted">${esc(w.p.pos)}</span> · usual ${fmt(w.usual)} ${esc(marketLabel(w.id))}${
          w.a ? ` · <span class="${w.a.pct >= 0 ? 'up' : 'down'}">${esc(w.group)} vs ${esc(def)} ${signedPct(w.a.pct)}</span>` : ''
        }</li>`,
    )
    .join('');

  return `<section class="mu-side">
    <h4>${esc(off)} offense vs ${esc((dt && dt.name) || def)} defense</h4>
    ${
      dt
        ? `<div class="tscroll"><table class="mtable">
      <thead><tr><th>Defense (${dt.n} games)</th><th class="num">Per game</th><th>Rank of ${Object.values(teams).filter((x) => x.n).length}</th></tr></thead>
      <tbody>${defRows}</tbody>
    </table></div>`
        : `<p class="explain">Team defense numbers for ${esc(def)} aren't available right now.</p>`
    }
    <h4>How opponents did vs ${esc(def)} this season</h4>
    ${
      posRows.length
        ? `<p class="explain">Every tracked player who faced ${esc(def)} this season: average, how many went over their usual number, and by how much. Tap a row to see each game.</p>
      <div class="dvp-list">${posRows.join('')}</div>`
        : `<p class="explain">No tracked players have faced ${esc(def)} yet this season.</p>`
    }
    ${watchHtml ? `<h4>${esc(off)} players to watch</h4><ul class="watch">${watchHtml}</ul>` : ''}
  </section>`;
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
  savePrefs();
  ensureData();
  ensureOdds();
  if (state.view === 'matchups') ensureTeams();
});

$('view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.view = b.dataset.v;
  state.expanded = null;
  savePrefs();
  render();
  if (state.view === 'bets') ensureOdds();
  if (state.view === 'matchups') ensureTeams();
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
    render();
  }, 120);
});

$('results').addEventListener('click', async (e) => {
  const step = e.target.closest('[data-step]');
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

$('refresh').addEventListener('click', () => {
  ensureData(true);
  if (state.view === 'bets') ensureOdds(true);
  if (state.view === 'matchups') ensureTeams(true);
});

$('floor').innerHTML = LINE_FLOORS.map((f) => `<option value="${f.value}">${esc(f.label)}</option>`).join('');
if (!LINE_FLOORS.some((f) => String(f.value) === state.floor)) state.floor = String(DEFAULT_FLOOR);
renderChrome();
ensureData();
if (state.view === 'bets') ensureOdds();
if (state.view === 'matchups') ensureTeams();
