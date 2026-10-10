import { LEAGUES, LEAGUE_KEYS, LINE_FLOORS, DEFAULT_FLOOR } from './config.js';
import { buildLeagueData } from './espn.js';
import { computeRows, onePerPlayer, lineStats, sampleGames, bestLine, formatNote } from './props.js';

const STATIC_MAX_AGE = 36 * 3600e3; // pre-built data/*.json older than this triggers a live pull
const CACHE_MAX_AGE = 3 * 3600e3;
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
  if (state.upcoming && hasSchedule) players = players.filter((p) => nextGame(d, p));
  if (q) players = players.filter((p) => `${p.name} ${p.team}`.toLowerCase().includes(q));
  const markets = state.market === 'all' ? cfg.markets : cfg.markets.filter((m) => m.id === state.market);
  let rows = computeRows(players, markets, opts());
  if (state.onePer && state.market === 'all') rows = onePerPlayer(rows);
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
  for (const b of $('view').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.v === state.view));
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
  const { rows, hasSchedule } = filteredRows(d);

  const bits = [];
  if (d.error && !(d.players || []).length) {
    status.className = 'status err';
    status.innerHTML =
      `Couldn't load ${esc(LEAGUES[state.league].label)} stats (${esc(d.error.message || d.error)}). ` +
      `If ESPN is blocked from your browser, deploy with the included GitHub Action so data is pre-built.`;
  } else {
    bits.push(`<b>${rows.length}</b> props hitting ${Math.round(Number(state.minRate) * 100)}%+ over the ${windowLabel()}`);
    if (state.upcoming && !hasSchedule) bits.push('no upcoming schedule found, showing everyone');
    if (d.source === 'stale') bits.push('showing older data — live refresh failed');
    status.innerHTML = bits.join(' · ');
  }

  const when = d.generatedAt ? new Date(d.generatedAt) : null;
  $('updated').textContent = when ? `Updated ${when.toLocaleString()}` : '';
  const log = d.log || [];
  $('diag').hidden = !log.length;
  $('diagText').textContent = log.join('\n');

  if (!rows.length) {
    $('results').innerHTML = (d.players || []).length
      ? `<div class="empty">Nothing clears that bar. Try a lower hit rate, a different sample, or “Deep alts” under Lines.</div>`
      : '';
    return;
  }
  $('results').innerHTML = state.view === 'sheet' ? renderSheet(rows, d) : renderList(rows, d);
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
});

$('view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.view = b.dataset.v;
  savePrefs();
  render();
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

$('refresh').addEventListener('click', () => ensureData(true));

$('floor').innerHTML = LINE_FLOORS.map((f) => `<option value="${f.value}">${esc(f.label)}</option>`).join('');
if (!LINE_FLOORS.some((f) => String(f.value) === state.floor)) state.floor = String(DEFAULT_FLOOR);
renderChrome();
ensureData();
