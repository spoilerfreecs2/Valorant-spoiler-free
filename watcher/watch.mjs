/*
  Video watcher for Live Again Valorant, the spoiler-free Valorant site.

  Runs in GitHub Actions on a schedule (see .github/workflows/watch.yml). Each run:
    1. finds the events to show: the ones listed in watcher/config.json, plus the ones on
       vlr.gg's event lists whose names match config.discover.include and that start in its date range,
    2. reads each event's page and match list on vlr.gg, and the page of every finished match
       until its map videos are linked,
    3. looks for official highlight videos of recent matches (watcher/highlights.mjs),
    4. checks the videos with YouTube (if YOUTUBE_API_KEY is set) and leaves out any that can't be embedded,
    5. writes everything to auto.json, which the site merges with data.json when it loads,
       and a calendar feed per event into calendar/ (watcher/calendar.mjs).

  vlr.gg's match pages link each map to its place in Riot's broadcast on YouTube.
  A map ends where the next map in the same video starts, so the player can stop there.

  It never writes scores, winners, placements or video titles into the site files.

  Needs Node 20 or newer. No packages to install.
  Environment: YOUTUBE_API_KEY (optional, recommended), GITHUB_TOKEN + GITHUB_REPOSITORY (for the review issue).
  vlr.gg has no API: the watcher reads its public pages slowly (one request every few seconds),
  with a User-Agent that says what it is, only re-reads what can still change, and credits vlr.gg on the site.
*/
import { readFile, writeFile, appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEventList, parseEvent, parseEventMatches, parseMatch, PARSER_VERSION } from './vlr.mjs';
import { findHighlights } from './highlights.mjs';
import { buildCalendars } from './calendar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  config: path.join(ROOT, 'watcher', 'config.json'),
  state: path.join(ROOT, 'watcher', 'state.json'),
  auto: path.join(ROOT, 'auto.json'),
  autoImages: path.join(ROOT, 'images', 'auto'),
  teamImages: path.join(ROOT, 'images', 'teams'),
  calendar: path.join(ROOT, 'calendar'),
  ownImages: path.join(ROOT, 'images', 'events')
};
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const YT_API = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const VLR = process.env.VLR_BASE || 'https://www.vlr.gg';
const VLR_DELAY = process.env.VLR_BASE ? 0 : 3000;
const GH_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPOSITORY || '';
const NOW = process.env.WATCHER_NOW ? new Date(process.env.WATCHER_NOW) : new Date();
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const BUILD_VERSION = 1;
const USER_AGENT = 'valorant-spoiler-free-site video watcher (https://github.com/' + (GH_REPO || 'spoilerfreecs2/Valorant-spoiler-free') + ')';

/* ---------- small helpers ---------- */
const str = v => (v === null || v === undefined) ? '' : String(v);
const arr = v => Array.isArray(v) ? v : [];
const slug = s => str(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const shortHash = s => createHash('sha1').update(str(s)).digest('hex').slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withoutUpdatedAt = o => { const c = Object.assign({}, o); delete c.updatedAt; return JSON.stringify(c); };
const log = msg => console.log(msg);
const warn = msg => console.log('::warning::' + msg);

async function readJson(file, fallback) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(text); } catch (e) { throw new Error(path.relative(ROOT, file) + ' is not valid JSON: ' + e.message); }
}
async function writeJsonIfChanged(file, obj) {
  const next = JSON.stringify(obj, null, 2) + '\n';
  let prev = '';
  try { prev = await readFile(file, 'utf8'); } catch (e) { /* new file */ }
  if (prev === next) return false;
  await writeFile(file, next);
  return true;
}
function isoDurationSeconds(d) {
  const m = str(d).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function datesText(a, b) {
  const p = s => { const m = str(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; };
  const s = p(a), e = p(b) || s;
  if (!s) return '';
  if (s.y === e.y && s.m === e.m) return (s.d === e.d ? s.d : s.d + '–' + e.d) + ' ' + MONTHS[s.m] + ' ' + s.y;
  if (s.y === e.y) return s.d + ' ' + MONTHS[s.m] + ' – ' + e.d + ' ' + MONTHS[e.m] + ' ' + s.y;
  return s.d + ' ' + MONTHS[s.m] + ' ' + s.y + ' – ' + e.d + ' ' + MONTHS[e.m] + ' ' + e.y;
}
const shortDate = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';

/* ---------- vlr.gg ---------- */
let lastVlr = 0;
async function politeFetch(url) {
  const wait = lastVlr + VLR_DELAY - Date.now();
  if (wait > 0) await sleep(wait);
  lastVlr = Date.now();
  return fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' } });
}
async function vlr(p) {
  const r = await politeFetch(VLR + p);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('vlr.gg request for ' + p + ' failed: HTTP ' + r.status);
  return r.text();
}

/* ---------- YouTube ---------- */
async function yt(endpoint, params) {
  const url = new URL(YT_API + '/' + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', YT_KEY);
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('YouTube ' + endpoint + ' request failed: ' + ((body.error && body.error.message) || ('HTTP ' + r.status)));
  return body;
}

/* ---------- GitHub review issue ---------- */
async function gh(method, url, body) {
  const r = await fetch(GH_API + url, {
    method,
    headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'valorant-video-watcher', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return null;
  const json = await r.json().catch(() => null);
  if (!r.ok && r.status !== 422) throw new Error('GitHub ' + method + ' ' + url + ' failed: HTTP ' + r.status);
  return json;
}
async function updateReviewIssue(problems) {
  if (!GH_TOKEN || !GH_REPO) return;
  try {
    await gh('POST', '/repos/' + GH_REPO + '/labels', { name: 'needs-review', color: 'd93f0b', description: 'Things the video watcher needs a person to look at' });
    const open = await gh('GET', '/repos/' + GH_REPO + '/issues?labels=needs-review&state=open&per_page=1');
    const issue = Array.isArray(open) && open[0];
    if (!problems.length) {
      if (issue) {
        await gh('POST', '/repos/' + GH_REPO + '/issues/' + issue.number + '/comments', { body: 'Nothing needs a look any more. Closing.' });
        await gh('PATCH', '/repos/' + GH_REPO + '/issues/' + issue.number, { state: 'closed', state_reason: 'completed' });
      }
      return;
    }
    const body = ['The video watcher needs a quick look at these. Fix them in `watcher/config.json` and the next run picks the change up.', '']
      .concat(problems.map(p => '- [ ] ' + p)).join('\n');
    if (issue) { if (issue.body !== body) await gh('PATCH', '/repos/' + GH_REPO + '/issues/' + issue.number, { body }); }
    else await gh('POST', '/repos/' + GH_REPO + '/issues', { title: 'Video watcher: things to check', body, labels: ['needs-review'] });
  } catch (e) {
    warn('Couldn’t update the review issue: ' + e.message);
  }
}

/* ---------- building one tournament ---------- */

// Round names that would give a record away ("Round 2 (1-0)", "High (1-0)") lose the record.
const cleanRound = r => str(r).replace(/\s*\(\d+\s*[-–]\s*\d+\)/g, '').replace(/\s+/g, ' ').trim();
const teamId = name => 'vlr-' + slug(name);
const isTbd = name => !name || /^tbd$/i.test(name.trim());

// Turns an event's vlr.gg pages into the site's tournament, matches and map videos.
function buildTournament(ev, es, state) {
  const info = es.info || {};
  const name = str(ev.name) || info.name || ev.path;
  const id = str(ev.id) || slug(name);
  const sdate = info.sdate || '', edate = info.edate || '';
  const tournament = {
    id, name, page: ev.path, year: (sdate.match(/^\d{4}/) || [''])[0], sdate, edate,
    dates: datesText(sdate, edate),
    location: info.location || '',
    teamsText: '',
    image: info.logo || '', imageDark: ''
  };
  const rows = arr(es.matches).map(r => {
    const pm = (state.matches[r.id] || {}).parsed;
    return { ...r, pm, date: (pm && pm.date) || (r.day ? r.day + 'T12:00:00Z' : ''), stage: r.stage || (pm && pm.stage) || 'Main Event', round: cleanRound(r.round || (pm && pm.round) || 'Matches') };
  });
  tournament.days = [...new Set(rows.map(r => r.day).filter(Boolean))].sort();
  const known = rows.filter(r => !isTbd(r.a) && !isTbd(r.b) && r.a !== r.b);
  const teamNames = new Set(known.flatMap(r => [r.a, r.b]));
  if (teamNames.size) tournament.teamsText = teamNames.size + ' teams';

  // Stages and rounds go in the order they were played (earliest match first).
  const first = list => list.reduce((min, m) => (m.date && (!min || m.date < min)) ? m.date : min, '');
  const stageNames = [...new Set(known.map(m => m.stage))];
  const stageFirst = Object.fromEntries(stageNames.map(s => [s, first(known.filter(m => m.stage === s))]));
  stageNames.sort((a, b) => (stageFirst[a] || '9') < (stageFirst[b] || '9') ? -1 : (stageFirst[a] || '9') > (stageFirst[b] || '9') ? 1 : 0);

  const matches = [], videos = {};
  let roundOrder = 0;
  stageNames.forEach((stage, si) => {
    const inStage = known.filter(m => m.stage === stage);
    const roundNames = [...new Set(inStage.map(m => m.round))];
    const roundFirst = Object.fromEntries(roundNames.map(r => [r, first(inStage.filter(m => m.round === r))]));
    roundNames.sort((a, b) => {
      const x = roundFirst[a] || '9', y = roundFirst[b] || '9';
      return x < y ? -1 : x > y ? 1 : roundNames.indexOf(a) - roundNames.indexOf(b);
    });
    for (const round of roundNames) {
      roundOrder++;
      const list = inStage.filter(m => m.round === round).sort((p, q) => (p.date || '9') < (q.date || '9') ? -1 : (p.date || '9') > (q.date || '9') ? 1 : p.order - q.order);
      for (const m of list) {
        const mid = 'vlr-' + m.id;
        const pm = m.pm;
        const bo = (pm && pm.bo) || (/grand\s*final/i.test(round) ? 5 : 3);
        const row = { id: mid, tournamentId: id, tournament: name, stage, stageOrder: si, round, roundOrder, a: teamId(m.a), b: teamId(m.b), bo, date: shortDate(m.date), time: (pm && pm.date) || '', page: m.path };
        matches.push(row);
        // Map slots: the video and start time from vlr.gg, and an end time where the next
        // map in the same video begins. Maps after the last one played are marked as not played.
        const maps = [];
        for (let i = 0; i < bo; i++) {
          const mp = (pm && pm.maps[i]) || null;
          maps.push({ video: mp && mp.vod ? 'https://youtu.be/' + mp.vod.id : '', start: mp && mp.vod && mp.vod.start ? String(mp.vod.start) : '', end: '', name: (mp && mp.name) || '', notPlayed: !!(m.completed && pm && pm.maps.length && !mp) });
        }
        if (!maps.some(x => x.video) && pm && pm.seriesVod && maps.length) {
          maps[0].video = 'https://youtu.be/' + pm.seriesVod.id;
          maps[0].start = pm.seriesVod.start ? String(pm.seriesVod.start) : '';
          maps[0].series = true;
        }
        const byVideo = {};
        maps.forEach((x, i) => { if (x.video) (byVideo[x.video] = byVideo[x.video] || []).push(i); });
        for (const idxs of Object.values(byVideo)) {
          idxs.sort((p, q) => (+maps[p].start || 0) - (+maps[q].start || 0));
          for (let k = 0; k + 1 < idxs.length; k++) {
            const s = +maps[idxs[k]].start || 0, e = +maps[idxs[k + 1]].start || 0;
            if (e > s + 60) maps[idxs[k]].end = String(e);
          }
        }
        videos[mid] = { maps };
      }
    }
  });
  // Team names and logos, by the site's team id.
  for (const m of known) {
    for (const [nm, i] of [[m.a, 0], [m.b, 1]]) {
      const tid = teamId(nm);
      const t = state.teams[tid] || (state.teams[tid] = { id: tid, name: nm });
      t.name = nm;
      const pt = m.pm && m.pm.teams[i];
      if (pt && pt.logo && !/\/img\/vlr\/tmp\//.test(pt.logo)) t.logoUrl = pt.logo;
    }
  }
  return { tournament, matches, videos };
}

/* ---------- main ---------- */
async function main() {
  const config = await readJson(FILES.config, null);
  if (!config) throw new Error('watcher/config.json is missing.');
  const auto = await readJson(FILES.auto, {});
  const state = await readJson(FILES.state, {});
  if (state.source !== 'vlr') { for (const k of Object.keys(state)) delete state[k]; state.source = 'vlr'; }
  for (const k of ['events', 'matches', 'teams', 'videos', 'resolved']) if (!state[k] || typeof state[k] !== 'object') state[k] = {};
  // A newer page reader, or a change in what's built: read every page again.
  if (state.parserVersion !== PARSER_VERSION || state.buildVersion !== BUILD_VERSION) {
    state.events = {}; state.matches = {}; state.parserVersion = PARSER_VERSION; state.buildVersion = BUILD_VERSION;
  }
  if (auto.version !== 2) { for (const k of Object.keys(auto)) delete auto[k]; }
  auto.version = 2;
  auto.source = 'vlr.gg, https://www.vlr.gg/';
  for (const k of ['tournaments', 'teams', 'matches']) auto[k] = arr(auto[k]);
  auto.videos = (auto.videos && typeof auto.videos === 'object') ? auto.videos : {};

  const problems = [];
  const summary = { checked: 0, fetched: 0, tournaments: [] };
  const maxPages = +config.maxPagesPerRun || 60;
  const budget = () => summary.fetched < maxPages;

  /* 1. which events? Listed ones ("vlr": "/event/2766/valorant-champions-2026") and discovered ones. */
  const wanted = [];
  const eventPath = p => (str(p).match(/\/event\/\d+\/[a-z0-9-]+/) || [''])[0];
  for (const ec of arr(config.events)) {
    const p = eventPath(ec.vlr);
    if (p) wanted.push({ ...ec, path: p });
    else problems.push('The event "' + str(ec.vlr || ec.name) + '" in config.json needs its vlr.gg address, like "/event/2766/valorant-champions-2026".');
  }
  const disc = config.discover;
  if (disc && arr(disc.lists).length) {
    const ds = state.discover = (state.discover && typeof state.discover === 'object') ? state.discover : {};
    ds.info = (ds.info && typeof ds.info === 'object') ? ds.info : {};
    const from = str(disc.from), to = str(disc.to) || '9999';
    const key = JSON.stringify(disc);
    const include = arr(disc.include).map(x => new RegExp(x, 'i'));
    const exclude = arr(disc.exclude).map(x => new RegExp(x, 'i'));
    const due = !ds.checkedAt || ds.key !== key || NOW.getTime() - Date.parse(ds.checkedAt) > (+disc.everyHours || 12) * HOUR;
    if (due) {
      try {
        const found = new Set();
        for (const list of arr(disc.lists)) {
          const html = await vlr(list);
          summary.fetched++;
          if (html) parseEventList(html).forEach(p => found.add(p));
        }
        const fy = +from.slice(0, 4) || 0, ty = +to.slice(0, 4) || 9999;
        const candidates = [...found].filter(p => {
          const s = p.split('/')[3] || '';
          if (!include.some(r => r.test(s)) || exclude.some(r => r.test(s))) return false;
          const ys = (s.match(/\b(?:19|20)\d\d\b/g) || []).map(Number);
          return !ys.length || ys.some(y => y >= fy && y <= ty);
        });
        for (const p of candidates) {
          if (ds.info[p] && ds.info[p].sdate) continue;
          if (!budget()) break;
          const html = await vlr(p);
          summary.fetched++;
          if (html) { const e = parseEvent(html); ds.info[p] = { name: e.name, sdate: e.sdate, edate: e.edate }; }
        }
        ds.found = candidates.sort();
        ds.checkedAt = NOW.toISOString();
        ds.key = key;
      } catch (e) { warn('Couldn’t look for new events on vlr.gg: ' + e.message); }
    }
    const picked = arr(ds.found).filter(p => ds.info[p] && ds.info[p].sdate && ds.info[p].sdate >= from && ds.info[p].sdate <= to);
    for (const p of picked) if (!wanted.some(w => w.path === p)) wanted.push({ path: p, discovered: true });
    if (due) log('Found ' + picked.length + ' events on vlr.gg between ' + (from || 'the start') + ' and ' + to + '.');
  }

  /* 2. read what can still change: each event's page and match list while it's on or recent,
        and the page of each finished match until its map videos are linked */
  const built = [];
  for (const ev of wanted) {
    const es = state.events[ev.path] || (state.events[ev.path] = {});
    summary.checked++;
    try {
      const info = es.info || {};
      const start = Date.parse(info.sdate || ''), end = Date.parse((info.edate || '') + 'T23:59:59Z');
      const live = !es.info || !start || (NOW.getTime() > start - 3 * DAY && NOW.getTime() < end + 21 * DAY);
      const stale = since => !since || NOW.getTime() - Date.parse(since) > (live ? 25 * 60 * 1000 : (start > NOW.getTime() ? 12 * HOUR : 7 * DAY));
      if (stale(es.infoAt) && budget()) {
        const html = await vlr(ev.path);
        summary.fetched++;
        if (html === null) { problems.push('The vlr.gg event ' + ev.path + ' doesn’t exist any more.'); continue; }
        es.info = parseEvent(html); es.infoAt = NOW.toISOString();
      }
      if (stale(es.matchesAt) && budget()) {
        const id = ev.path.split('/')[2];
        const html = await vlr('/event/matches/' + id + '/?series_id=all');
        summary.fetched++;
        if (html) { es.matches = parseEventMatches(html); es.matchesAt = NOW.toISOString(); }
      }
      // Match pages: finished matches whose videos aren't all linked yet, newest first,
      // checked again every few hours for two weeks after the match.
      const todo = arr(es.matches).filter(r => r.completed && !isTbd(r.a) && !isTbd(r.b)).filter(r => {
        const ms = state.matches[r.id];
        if (!ms) return true;
        if (ms.done) return false;
        const age = NOW.getTime() - Date.parse(r.day || ms.checkedAt);
        if (age > 14 * DAY) { ms.done = true; return false; }
        return NOW.getTime() - Date.parse(ms.checkedAt) > (r.youtube ? 30 * 60 * 1000 : 4 * HOUR);
      }).sort((p, q) => (q.day || '').localeCompare(p.day || ''));
      for (const r of todo) {
        if (!budget()) break;
        const html = await vlr(r.path);
        summary.fetched++;
        if (!html) { state.matches[r.id] = { parsed: null, checkedAt: NOW.toISOString(), done: false }; continue; }
        const pm = parseMatch(html);
        const linked = pm.maps.length > 0 && pm.maps.every(x => x.vod);
        state.matches[r.id] = { parsed: pm, checkedAt: NOW.toISOString(), done: linked };
      }
      built.push({ ev, es });
    } catch (e) { warn('Couldn’t read ' + ev.path + ': ' + e.message); if (es.info) built.push({ ev, es }); }
  }
  const remaining = wanted.reduce((n, ev) => n + arr((state.events[ev.path] || {}).matches).filter(r => r.completed && !state.matches[r.id]).length, 0);
  if (remaining) log(remaining + ' finished matches are still to be read; later runs pick them up.');

  /* 3. replace the events in auto.json */
  for (const { ev, es } of built) {
    if (!es.info) continue;
    const { tournament, matches, videos } = buildTournament(ev, es, state);
    const old = auto.tournaments.find(t => t.page === ev.path);
    if (old) {
      auto.matches.filter(m => m.tournamentId === old.id).forEach(m => { delete auto.videos[m.id]; });
      auto.matches = auto.matches.filter(m => m.tournamentId !== old.id);
      auto.tournaments = auto.tournaments.filter(t => t !== old);
    }
    const linked = Object.values(videos).reduce((n, v) => n + v.maps.filter(x => x.video).length, 0);
    es.result = matches.length + ' matches, ' + linked + ' map videos';
    const upcoming = /^\d{4}-\d{2}-\d{2}/.test(tournament.sdate) ? Date.parse(tournament.sdate.slice(0, 10) + 'T00:00:00Z') > NOW.getTime() : false;
    if (!matches.length && !upcoming) { es.result = 'no matches, not on the site'; continue; }
    if (!matches.length) es.result = 'coming up, no matches drawn yet';
    const ended = Date.parse(str(tournament.edate).slice(0, 10) + 'T23:59:59Z');
    if (!linked && ended && NOW.getTime() - ended > 2 * DAY) { es.result += ', none with videos, so not on the site'; summary.tournaments.push(tournament.name + ': no videos, left off the site'); continue; }
    auto.tournaments.push(tournament);
    auto.matches.push(...matches);
    Object.assign(auto.videos, videos);
    summary.tournaments.push(tournament.name + ': ' + matches.length + ' matches, ' + linked + ' map videos');
  }
  // Events no longer wanted are dropped.
  const keep = new Set(wanted.map(ev => ev.path));
  for (const t of auto.tournaments.filter(t => !keep.has(t.page))) {
    auto.matches.filter(m => m.tournamentId === t.id).forEach(m => { delete auto.videos[m.id]; });
    auto.matches = auto.matches.filter(m => m.tournamentId !== t.id);
  }
  auto.tournaments = auto.tournaments.filter(t => keep.has(t.page)).sort((a, b) => (b.sdate || '') < (a.sdate || '') ? -1 : (b.sdate || '') > (a.sdate || '') ? 1 : 0);
  for (const p of Object.keys(state.events)) if (!keep.has(p)) {
    for (const r of arr(state.events[p].matches)) delete state.matches[r.id];
    delete state.events[p];
  }
  const withVideos = new Set(auto.matches.filter(m => arr((auto.videos[m.id] || {}).maps).some(x => x.video)).map(m => m.tournamentId));
  auto.featured = (auto.tournaments.find(t => withVideos.has(t.id)) || auto.tournaments[0] || {}).id || '';
  const usedTeams = new Set(auto.matches.flatMap(m => [m.a, m.b]));
  auto.teams = Object.values(state.teams).filter(t => usedTeams.has(t.id)).map(t => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name));
  for (const id of Object.keys(state.teams)) if (!usedTeams.has(id)) delete state.teams[id];

  /* 4b. official highlight videos: the short version of a series */
  if (YT_KEY) {
    try { await findHighlights({ config, state, auto, yt, now: NOW, log, warn }); } catch (e) { warn('Couldn’t look for highlights: ' + e.message); }
  }
  const matchIds = new Set(auto.matches.map(m => m.id));
  state.highlights = (state.highlights && typeof state.highlights === 'object') ? state.highlights : {};
  for (const mid of Object.keys(state.highlights)) if (!matchIds.has(mid)) delete state.highlights[mid];
  for (const [mid, vid] of Object.entries(state.highlights)) if (auto.videos[mid]) auto.videos[mid].highlight = 'https://youtu.be/' + vid;

  /* 5. check videos with YouTube: leave out ones that are private, deleted or can't be embedded */
  const allIds = new Set();
  for (const v of Object.values(auto.videos)) {
    for (const mp of v.maps) { const m = str(mp.video).match(/youtu\.be\/([\w-]{11})/); if (m) allIds.add(m[1]); }
    const hm = str(v.highlight).match(/youtu\.be\/([\w-]{11})/);
    if (hm) allIds.add(hm[1]);
  }
  if (YT_KEY) {
    const recheckAfter = (+config.recheckVideosAfterDays || 14) * 24 * HOUR;
    const toCheck = [...allIds].filter(id => !state.videos[id] || NOW.getTime() - Date.parse(state.videos[id].checkedAt) > recheckAfter);
    for (let i = 0; i < toCheck.length; i += 50) {
      const batch = toCheck.slice(i, i + 50);
      try {
        const res = await yt('videos', { part: 'contentDetails,status', id: batch.join(','), maxResults: '50' });
        const found = new Map(arr(res.items).map(v => [v.id, v]));
        for (const id of batch) {
          const v = found.get(id);
          state.videos[id] = { ok: !!(v && v.status && v.status.embeddable && v.status.privacyStatus !== 'private'), seconds: v ? isoDurationSeconds(v.contentDetails.duration) : 0, checkedAt: NOW.toISOString() };
        }
      } catch (e) { warn(e.message); break; }
    }
  } else {
    warn('YOUTUBE_API_KEY isn’t set, so videos weren’t checked for being playable on other sites.');
  }
  let blocked = 0;
  for (const v of Object.values(auto.videos)) for (const mp of v.maps) {
    const m = str(mp.video).match(/youtu\.be\/([\w-]{11})/);
    if (m && state.videos[m[1]] && !state.videos[m[1]].ok) { mp.video = ''; mp.start = ''; mp.end = ''; blocked++; }
  }
  // Highlights must play here and be longer than a two-minute clip (that's a Short, not a match).
  for (const v of Object.values(auto.videos)) {
    const hm = str(v.highlight).match(/youtu\.be\/([\w-]{11})/);
    const chk = hm && state.videos[hm[1]];
    if (hm && (!chk || !chk.ok || chk.seconds < 120)) delete v.highlight;
  }
  for (const id of Object.keys(state.videos)) if (!allIds.has(id)) delete state.videos[id];
  /* 6. pictures: your own picture in images/events/<id>.jpg (or .png/.webp) is used as an event's card picture;
        otherwise the event's logo, and each team's logo, are copied from vlr.gg once. Logos carry no results. */
  let own = [];
  try { own = await readdir(FILES.ownImages); } catch (e) { /* no folder yet */ }
  state.images = (state.images && typeof state.images === 'object') ? state.images : {};
  const want = [];
  let haveAuto = [], haveTeams = [];
  try { haveAuto = await readdir(FILES.autoImages); } catch (e) { /* no folder yet */ }
  try { haveTeams = await readdir(FILES.teamImages); } catch (e) { /* no folder yet */ }
  for (const t of auto.tournaments) {
    const mine = own.find(f => f.replace(/\.(jpe?g|png|webp|avif)$/i, '') === t.id);
    t.art = mine ? 'images/events/' + mine : '';
    t.logo = ''; t.logoDark = '';
    const url = t.image;
    if (!url) continue;
    const done = state.images[t.id];
    if (done && done.url === url && haveAuto.includes(done.saved)) t.logo = 'images/auto/' + done.saved;
    else want.push({ key: t.id, url, dir: FILES.autoImages, rel: 'images/auto/', set: f => { t.logo = f; } });
  }
  for (const tm of auto.teams) {
    const st = state.teams[tm.id] || {};
    if (!st.logoUrl) continue;
    const done = state.images['team:' + tm.id];
    if (done && done.url === st.logoUrl && haveTeams.includes(done.saved)) tm.logo = 'images/teams/' + done.saved;
    else want.push({ key: 'team:' + tm.id, url: st.logoUrl, dir: FILES.teamImages, rel: 'images/teams/', base: tm.id, set: f => { tm.logo = f; } });
  }
  for (const w of want.slice(0, +config.maxImagesPerRun || 40)) {
    try {
      const r = await politeFetch(w.url);
      if (!r.ok) { warn('Couldn’t download the picture ' + w.url + ': HTTP ' + r.status); continue; }
      const ext = (/\.(png|jpe?g|webp|gif|svg)(?:$|\?)/i.exec(w.url) || [, 'png'])[1].toLowerCase().replace('jpeg', 'jpg');
      const saved = (w.base || w.key) + '.' + ext;
      await mkdir(w.dir, { recursive: true });
      await writeFile(path.join(w.dir, saved), Buffer.from(await r.arrayBuffer()));
      const old = state.images[w.key];
      if (old && old.saved !== saved) await unlink(path.join(w.dir, old.saved)).catch(() => {});
      state.images[w.key] = { url: w.url, saved };
      w.set(w.rel + saved);
    } catch (e) { warn('Couldn’t download the picture ' + w.url + ': ' + e.message); }
  }
  // Pictures of events and teams no longer on the site are removed.
  const keepImg = new Set([...auto.tournaments.map(t => t.id), ...auto.teams.map(t => 'team:' + t.id)]);
  for (const [key, img] of Object.entries(state.images)) {
    if (keepImg.has(key)) continue;
    await unlink(path.join(key.startsWith('team:') ? FILES.teamImages : FILES.autoImages, img.saved)).catch(() => {});
    delete state.images[key];
  }

  /* 6b. calendar feeds, one per event, for the site's "Add to calendar" */
  const siteUrl = str(config.siteUrl) || ('https://' + (GH_REPO.split('/')[0] || 'spoilerfreecs2').toLowerCase() + '.github.io/' + (GH_REPO.split('/')[1] || 'Valorant-spoiler-free') + '/');
  const calendars = buildCalendars(auto, siteUrl, NOW);
  await mkdir(FILES.calendar, { recursive: true });
  for (const [rel, text] of Object.entries(calendars)) {
    const file = path.join(ROOT, rel);
    let prev = '';
    try { prev = await readFile(file, 'utf8'); } catch (e) { /* new file */ }
    if (prev !== text) await writeFile(file, text);
  }
  for (const f of await readdir(FILES.calendar)) if (f.endsWith('.ics') && !calendars['calendar/' + f]) await unlink(path.join(FILES.calendar, f)).catch(() => {});

  /* 7. save */
  const before = await readJson(FILES.auto, {});
  auto.updatedAt = withoutUpdatedAt(auto) !== withoutUpdatedAt(before) ? NOW.toISOString() : (before.updatedAt || '');
  await writeJsonIfChanged(FILES.auto, auto);
  await writeJsonIfChanged(FILES.state, state);
  await updateReviewIssue(problems);

  const line = 'Checked ' + summary.checked + ' events on vlr.gg and read ' + summary.fetched + ' pages.' + (blocked ? ' Left out ' + blocked + ' map videos that can’t be played here.' : '');
  log(line);
  summary.tournaments.forEach(t => log('- ' + t));
  problems.forEach(p => warn(p));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '### Video watcher\n\n' + line + '\n\n' + summary.tournaments.map(t => '- ' + t).join('\n') + '\n');
}

main().catch(e => { console.error('::error::' + e.message); process.exit(1); });
