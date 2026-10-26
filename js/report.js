// Plain-text Matchups report for the build log: the same numbers as the Matchups tab
// (defense ranks, positions vs defense, players to watch, injuries), one block per game.
import { defenseVsPosition, usualValue, activePlayers, upcomingGames } from './props.js';
import { injuriesByTeam, returningPlayers } from './injuries.js';

const OFFENSE_POS = new Set(['QB', 'RB', 'FB', 'HB', 'WR', 'TE', 'T', 'G', 'C', 'OT', 'OG', 'OL', 'LT', 'RT', 'LG', 'RG']);
const BADGE = { out: 'OUT', doubtful: 'DOUBT', q: 'Q', dtd: 'DTD' };
const fmt = (n) => (Math.round(n * 10) / 10).toString();
const signedPct = (x) => `${x >= 0 ? '+' : '-'}${Math.abs(Math.round(x * 100))}%`;

function when(t) {
  if (!t) return '';
  return new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
}

function injuryText(x) {
  const bits = [x.pos, x.part].filter(Boolean).join(', ');
  const since = x.date ? ` since ${String(x.date).slice(5, 10)}` : '';
  return `${BADGE[x.level]} ${x.name}${bits ? ` (${bits})` : ''}${since}`;
}

/** -> string[] of log lines. teams / injuries may be null when they failed to load. */
export function matchupReport(cfg, data, teamsData, injuries) {
  const players = data.players || [];
  const teams = (teamsData && teamsData.teams) || {};
  const dvp = defenseVsPosition(players, cfg);
  const markets = new Map(cfg.markets.map((m) => [m.id, m]));
  const list = (injuries && injuries.ok && injuries.list) || [];
  const injByTeam = injuriesByTeam(list, teams, players);
  const injById = new Map(list.filter((x) => x.id).map((x) => [x.id, x]));
  const football = cfg.kind === 'football';
  const active = new Set(activePlayers(players).map((p) => p.id));
  // Same BACK tag as the tab: missed recent games, off the injury report now.
  const back = new Map(returningPlayers(players, new Set(injById.keys()), dvp.season).map((r) => [r.player.id, r.missed]));
  const of = Object.values(teams).filter((x) => x.n).length;

  const side = (off, def) => {
    const out = [`-- ${off} offense vs ${(teams[def] && teams[def].name) || def} defense --`];
    const dt = teams[def] && teams[def].n ? teams[def] : null;
    if (dt) {
      out.push(`Defense (#1 = toughest of ${of}): ${cfg.teamStats.map((s) => `${s.label} ${Number.isFinite(dt.stats[s.id]) ? fmt(dt.stats[s.id]) : '-'} (#${dt.ranks[s.id] || '-'})`).join(' | ')}`);
    } else out.push('Defense: not available');
    for (const [group, ids] of Object.entries(cfg.dvp)) {
      for (const id of ids) {
        const a = ((dvp.teams[def] || {})[group] || {})[id];
        if (!a) continue;
        const games = a.games.map((x) => `${x.name} ${fmt(x.v)}/${fmt(x.usual)}`).join(', ');
        out.push(`${group} ${markets.get(id).label}: avg ${fmt(a.avg)}, beat usual ${a.overs}/${a.n}, ${signedPct(a.pct)} vs usual (#${a.rank || '-'} of ${a.of || '-'}) [${games}]`);
      }
    }
    // Every tracked player on the offense: usual number and last 10 games for his position's props.
    const roster = players.filter((p) => p.team === off && (active.has(p.id) || injById.has(String(p.id)) || back.has(p.id)));
    for (const p of roster.slice(0, 14)) {
      const g = cfg.positionGroups.find((x) => x.match.includes(String(p.pos || '').toUpperCase()));
      const ids = (g && cfg.dvp[g.label]) || [];
      if (!ids.length) continue;
      const x = injById.get(String(p.id));
      const tag = x
        ? ` [${BADGE[x.level]}]`
        : back.has(p.id)
          ? ` [BACK: missed last ${back.get(p.id)} game${back.get(p.id) === 1 ? '' : 's'}, off the injury report]`
          : active.has(p.id) ? '' : ' [not played in 10+ days]';
      const props = ids.map((id) => {
        const m = markets.get(id);
        const last = p.games.slice(0, 10).map((gm) => fmt(m.value(gm) ?? 0)).join(' ');
        return `${m.label} usual ${fmt(usualValue(p, m, dvp.season))}, L10 ${last}`;
      });
      out.push(`  ${p.name} ${p.pos}${tag}: ${props.join(' | ')}`);
    }
    const offInj = (injByTeam[off] || []).filter((x) => !football || !x.pos || OFFENSE_POS.has(x.pos.toUpperCase()));
    out.push(`Injuries ${off} ${football ? 'offense' : 'roster'}: ${offInj.map(injuryText).join('; ') || 'none listed'}`);
    if (football) {
      const defInj = (injByTeam[def] || []).filter((x) => x.pos && !OFFENSE_POS.has(x.pos.toUpperCase()));
      out.push(`Injuries ${def} defense: ${defInj.map(injuryText).join('; ') || 'none listed'}`);
    }
    return out;
  };

  const lines = [
    `MATCHUPS ${cfg.label} (built ${data.generatedAt}; defense: ${(teamsData && teamsData.seasonNote) || 'unavailable'}; ` +
      `injuries: ${injuries && injuries.ok ? injuries.generatedAt : 'unavailable'}; L10 lists newest first; vs-position games show actual/usual)`,
  ];
  for (const g of upcomingGames(data.schedule)) {
    lines.push('', `=== ${g.away} @ ${g.home} ${g.live ? 'LIVE' : when(g.t)} ===`, ...side(g.away, g.home), ...side(g.home, g.away));
  }
  return lines;
}
