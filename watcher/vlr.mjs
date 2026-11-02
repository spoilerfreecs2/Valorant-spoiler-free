/*
  Reads vlr.gg pages into plain data: an event's name, dates and place, its list of matches,
  and each match's teams, start time, series length and per-map videos.

  It deliberately ignores scores, winners, picks and bans. The only result-like fact it keeps
  is which maps were played, so a series' unplayed maps can be marked as such.
*/

// Bump when the reader changes, so the watcher reads every page again with the new version.
export const PARSER_VERSION = 1;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', sdot: '·', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘' };
export function plain(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ').trim();
}
const abs = src => !src ? '' : src.startsWith('//') ? 'https:' + src : src.startsWith('/') ? 'https://www.vlr.gg' + src : src;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => y && m && d ? y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') : '';

// "Sep 24 – Oct 18, 2026", "Jul 15 – 27, 2026", "Jan 11, 2027", "Dec 28, 2026 – Jan 4, 2027" -> ISO dates
export function parseDates(text) {
  const t = plain(text).replace(/\s*[–-]\s*/g, ' – ');
  const parts = t.split(' – ');
  const one = (s, fallbackMonth, fallbackYear) => {
    const m = s.match(/^(?:([A-Za-z]{3})[a-z]*\s+)?(\d{1,2})(?:,\s*(\d{4}))?$/);
    if (!m) return null;
    return { m: m[1] ? MON[m[1].toLowerCase()] : fallbackMonth, d: +m[2], y: m[3] ? +m[3] : fallbackYear };
  };
  const endRaw = one(parts[parts.length - 1].trim());
  if (!endRaw) return { sdate: '', edate: '' };
  const startRaw = parts.length > 1 ? one(parts[0].trim(), endRaw.m, endRaw.y) : endRaw;
  if (!startRaw) return { sdate: '', edate: '' };
  if (!endRaw.m) endRaw.m = startRaw.m;
  if (!startRaw.y) startRaw.y = endRaw.y;
  // "Dec 28 – Jan 4, 2027": the start is in the year before.
  if (startRaw.y === endRaw.y && startRaw.m > endRaw.m) startRaw.y--;
  return { sdate: iso(startRaw.y, startRaw.m, startRaw.d), edate: iso(endRaw.y, endRaw.m, endRaw.d) };
}

// Event links on a vlr.gg events list page: "/event/2766/valorant-champions-2026"
export function parseEventList(html) {
  return [...new Set([...String(html).matchAll(/href="(\/event\/\d+\/[a-z0-9-]+)"/g)].map(m => m[1]))];
}

// An event's overview page: name, dates, location, logo.
export function parseEvent(html) {
  const t = String(html);
  const name = plain((t.match(/<h1 class="event-header-main-title">([\s\S]*?)<\/h1>/) || [])[1]);
  const meta = {};
  for (const m of t.matchAll(/<div class="ge-text-light label">\s*([\s\S]*?)\s*<\/div>\s*<div class="value"[^>]*>([\s\S]*?)<\/div>/g)) meta[plain(m[1]).toLowerCase()] = plain(m[2]);
  const { sdate, edate } = parseDates(meta.dates || '');
  const logo = abs((t.match(/<div class="event-header-thumb">[\s\S]*?<img src="([^"]+)"/) || [])[1]);
  return { name, sdate, edate, location: meta.location || '', logo: /\/img\/vlr\/tmp\//.test(logo) ? '' : logo };
}

// An event's match list (/event/matches/<id>/?series_id=all): one row per match, in page order.
// Rows carry the teams' names, the day, round and stage, whether it's finished and whether it has
// a YouTube video. The scores on this page are never read.
export function parseEventMatches(html) {
  const t = String(html);
  const out = [];
  // Day headings and match rows in page order.
  const re = /<div class="wf-label mod-large">([\s\S]*?)<\/div>|<a href="(\/(\d+)\/[a-z0-9-]+)" class="wf-module-item match-item[^"]*">([\s\S]*?)<\/a>/g;
  let day = '', order = 0, m;
  while ((m = re.exec(t))) {
    if (m[1] !== undefined) {
      const d = plain(m[1]).replace(/^(Today|Yesterday|Tomorrow)\s*/i, '');
      const dm = d.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/);
      day = dm ? iso(+dm[3], MON[dm[1].toLowerCase()], +dm[2]) : '';
      continue;
    }
    const body = m[4];
    const teams = [...body.matchAll(/<div class="match-item-vs-team-name">([\s\S]*?)<\/div>\s*<\/div>/g)].map(x => plain(x[1]));
    const series = plain((body.match(/<div class="match-item-event-series[^"]*">([\s\S]*?)<\/div>/) || [])[1]);
    const ev = (body.match(/<div class="match-item-event text-of">([\s\S]*?)<\/div>\s*$/) || [])[1] || '';
    const stage = plain(ev.replace(/<div class="match-item-event-series[\s\S]*?<\/div>/, ''));
    const status = plain((body.match(/<div class="ml-status">([\s\S]*?)<\/div>/) || [])[1]).toLowerCase();
    out.push({
      id: m[3], path: m[2], day, order: order++,
      a: teams[0] || '', b: teams[1] || '',
      stage, round: series,
      completed: status === 'completed',
      youtube: /\bmod-yt\b/.test(body)
    });
  }
  return out;
}

// One match page: teams (with vlr ids and logos), start time, series length, maps played and
// their videos. Picks, bans and scores are on the page too and are left alone.
export function parseMatch(html) {
  const t = String(html);
  const head = (t.match(/<div class="match-header-super">([\s\S]*?)<div class="match-header-note">/) || t.match(/<div class="match-header-super">([\s\S]*?)<div class="sm-root/) || [])[1] || '';
  const seriesText = plain((head.match(/<div class="match-header-event-series">([\s\S]*?)<\/div>/) || [])[1]);
  const utc = (head.match(/data-utc-ts="(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}"/) || []);
  const date = utc[1] ? utc[1] + 'T' + utc[2] + ':00Z' : '';
  const teams = [];
  for (const m of head.matchAll(/<a class="match-header-link[^"]*mod-([12])"\s*href="\/team\/(\d+)\/([a-z0-9-]+)"\s*>([\s\S]*?)<\/a>/g)) {
    const inner = m[4];
    teams[+m[1] - 1] = {
      vlrId: m[2], slug: m[3],
      name: plain((inner.match(/<div class="wf-title-med[^"]*">([\s\S]*?)<\/div>/) || [])[1]),
      logo: abs((inner.match(/<img src="([^"]+)"/) || [])[1])
    };
  }
  const notes = [...head.matchAll(/<div class="match-header-vs-note">\s*([\s\S]*?)\s*<\/div>/g)].map(x => plain(x[1]));
  const boNote = notes.map(n => n.match(/^Bo(\d)$/i)).find(Boolean);
  const bo = boNote ? +boNote[1] : 0;
  // Maps played, from the per-map tabs ("1 Summit", "2 Lotus" ...).
  const nav = (t.match(/<div class="vm-stats-gamesnav[^"]*">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '';
  const played = [...nav.matchAll(/data-game-id="(\d+)"\s+data-disabled="(\d)"[^>]*>([\s\S]*?)<\/a>/g)]
    .filter(x => x[2] === '0')
    .map(x => plain(x[3]).replace(/^\d+\s+/, ''))
    .filter(Boolean);
  // Videos: YouTube ones, by map number. A "Full match" entry (no number) is the whole series.
  const vodPane = (t.match(/<div class="sm-pane sm-pane-vods">([\s\S]*?)<div class="match-stream-embed/) || [])[1] || '';
  const maps = [];
  let seriesVod = null;
  for (const v of vodPane.matchAll(/<div class="sm-vod[^"]*" data-site="youtube">([\s\S]*?)<\/a>\s*<\/div>/g)) {
    const id = (v[1].match(/data-site-id="([\w-]{11})"/) || [])[1];
    if (!id) continue;
    const start = +((v[1].match(/data-embed-start="(\d+)"/) || [])[1] || 0);
    const num = +((v[1].match(/<span class="sm-vod-num">(\d+)<\/span>/) || [])[1] || 0);
    const name = plain((v[1].match(/<span class="sm-vod-name">([\s\S]*?)<\/span>/) || [])[1]);
    if (num) maps[num - 1] = { name, vod: { id, start } };
    else if (!seriesVod) seriesVod = { id, start };
  }
  const out = [];
  const n = Math.max(played.length, maps.length);
  for (let i = 0; i < n; i++) out.push({ name: played[i] || (maps[i] && maps[i].name) || '', played: true, vod: maps[i] ? maps[i].vod : null });
  const [stage, ...rest] = seriesText.split(':');
  return { stage: rest.length ? stage.trim() : '', round: rest.length ? rest.join(':').trim() : seriesText, date, teams, bo, maps: out, seriesVod };
}
