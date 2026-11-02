#!/usr/bin/env node
/*
  Video watcher for the spoiler-free CS2 site.

  Every run it:
    1. asks Liquipedia which of the tournament pages in watcher/config.json changed since last time,
    2. reads the changed pages: stages, rounds, matches, teams, and each map's video link and start time,
    3. looks for the organisers' highlight videos of recent matches (watcher/highlights.mjs),
    4. checks the videos with YouTube (if YOUTUBE_API_KEY is set) and leaves out any that can't be embedded,
    5. writes everything to auto.json, which the site merges with data.json when it loads,
       and a calendar feed per event into calendar/ (watcher/calendar.mjs).

  The organisers post one video per series on their archive channels ("ESL Archives",
  "BLAST Premier VOD Archive", "PGL VOD's"), and Liquipedia records where each map starts.
  A map ends where the next map in the same video starts, so the player can stop there.

  It never writes scores, winners, placements or video titles into the site files.

  Needs Node 20 or newer. No packages to install.
  Environment: YOUTUBE_API_KEY (optional, recommended), GITHUB_TOKEN + GITHUB_REPOSITORY (for the review issue).
  Liquipedia's API rules: an identifying User-Agent and at most one request every 2 seconds.
  Its content is CC BY-SA, so the site credits it.
*/
import { readFile, writeFile, appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parsePage, parseInfobox, teamNamesFromExpansion, teamLogoFiles, PARSER_VERSION } from './liquipedia.mjs';
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
const LP_API = process.env.LIQUIPEDIA_API_BASE || 'https://liquipedia.net/counterstrike/api.php';
const LP_DELAY = process.env.LIQUIPEDIA_API_BASE ? 0 : 2500;
const GH_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPOSITORY || '';
const NOW = process.env.WATCHER_NOW ? new Date(process.env.WATCHER_NOW) : new Date();
const HOUR = 3600 * 1000;
// 2: matches keep their start time (for highlights and calendars), and events their match days.
const BUILD_VERSION = 2;
const USER_AGENT = 'cs2-spoiler-free-site video watcher (https://github.com/' + (GH_REPO || 'spoilerfreecs2/CS2-Spoil-free') + ')';

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

/* ---------- Liquipedia ---------- */
let lastLp = 0;
async function lp(params) {
  const wait = lastLp + LP_DELAY - Date.now();
  if (wait > 0) await sleep(wait);
  lastLp = Date.now();
  const url = new URL(LP_API);
  for (const [k, v] of Object.entries({ format: 'json', formatversion: '2', ...params })) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' } });
  if (!r.ok) throw new Error('Liquipedia request failed: HTTP ' + r.status);
  const body = await r.json();
  if (body.error) throw new Error('Liquipedia: ' + (body.error.info || body.error.code));
  return body;
}
// Latest revision ids for up to 50 titles at a time. Missing pages come back as null.
async function revisions(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const res = await lp({ action: 'query', prop: 'revisions', rvprop: 'ids', titles: titles.slice(i, i + 50).join('|') });
    const norm = new Map(arr(res.query.normalized).map(n => [n.to, n.from]));
    for (const p of arr(res.query.pages)) out[norm.get(p.title) || p.title] = p.missing ? null : (p.revisions && p.revisions[0].revid) || null;
  }
  return out;
}
async function pageText(title) {
  const res = await lp({ action: 'query', prop: 'revisions', rvprop: 'content|ids', rvslots: 'main', titles: title });
  const p = arr(res.query.pages)[0];
  if (!p || p.missing || !p.revisions) return null;
  return { revid: p.revisions[0].revid, text: p.revisions[0].slots.main.content || '' };
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
    headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cs2-video-watcher', 'Content-Type': 'application/json' },
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

// Turns parsed Liquipedia pages into the site's tournament, matches and map videos.
function buildTournament(tc, pages, teamOf) {
  const main = pages[0];
  const info = main.info;
  const name = str(tc.name) || info.name || info.displayTitle || tc.page;
  const id = str(tc.id) || slug(name);
  const sdate = info.sdate || '', edate = info.edate || '';
  const tournament = {
    id, name, page: tc.page, year: (sdate.match(/^\d{4}/) || [''])[0], sdate, edate,
    dates: datesText(sdate, edate),
    location: [info.city, info.country].filter(Boolean).join(', ') || (info.type === 'Online' ? 'Online' : ''),
    teamsText: info.teamNumber ? info.teamNumber + ' teams' : '',
    image: info.image || '', imageDark: info.imageDark || ''
  };

  const all = [];
  pages.forEach((pg, pi) => pg.matches.forEach(m => all.push({ ...m, pageIndex: pi, page: pg.title })));
  const known = all.filter(m => m.a && m.b && m.a !== m.b);
  // The days with matches, including ones whose teams aren't known yet, for the calendar feeds.
  tournament.days = [...new Set(all.map(m => Date.parse(m.date)).filter(Boolean).map(t => new Date(t).toISOString().slice(0, 10)))].sort();
  // Stages and rounds go in the order they were played (earliest match first), so watching
  // from the top follows the event as it happened.
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
        const mid = 'lp-' + shortHash(tc.page + '|' + m.page + '|' + m.container + '|' + m.key);
        const a = teamOf(m.a), b = teamOf(m.b);
        const bo = m.bo || (/grand\s*final/i.test(round) ? 5 : 3);
        const row = { id: mid, tournamentId: id, tournament: name, stage, stageOrder: si, round, roundOrder, a: a.id, b: b.id, bo, date: shortDate(m.date), time: m.date || '' };
        // A match on a stage subpage keeps that page, so "Show me the result" can open it.
        if (m.page && m.page !== tc.page) row.page = m.page;
        matches.push(row);

        // Map slots: the video and start time from Liquipedia, and an end time where the next
        // map in the same video begins. Older pages only link one video for the whole series.
        const maps = [];
        for (let i = 0; i < bo; i++) {
          const mp = m.maps[i] || { name: '', played: null, vod: null };
          maps.push({ video: mp.vod ? 'https://youtu.be/' + mp.vod.id : '', start: mp.vod && mp.vod.start ? String(mp.vod.start) : '', end: '', name: mp.name || '', notPlayed: mp.played === false });
        }
        if (!maps.some(x => x.video) && m.seriesVod && maps.length) {
          maps[0].video = 'https://youtu.be/' + m.seriesVod.id;
          maps[0].start = m.seriesVod.start ? String(m.seriesVod.start) : '';
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
  return { tournament, matches, videos };
}

// Liquipedia's short names are sometimes initials ("GL", "PV"). Those get the fuller name
// ("GamerLegion", "PARIVISION"), without a trailing "Esports" or "Gaming".
function displayName({ name, page }) {
  if (name.length > 3 || !page || page === name) return name;
  const full = page.replace(/\s+(esports|e-sports|gaming|team|club|gg)$/i, '').trim();
  return full.length > 3 ? full : name;
}

/* ---------- main ---------- */
async function main() {
  const config = await readJson(FILES.config, null);
  if (!config) throw new Error('watcher/config.json is missing.');
  const auto = await readJson(FILES.auto, {});
  const state = await readJson(FILES.state, {});
  if (state.version !== 2) { for (const k of Object.keys(state)) delete state[k]; state.version = 2; }
  for (const k of ['pages', 'resolved', 'teams', 'videos']) if (!state[k] || typeof state[k] !== 'object') state[k] = {};
  // A newer page reader: read every page again.
  if (state.parserVersion !== PARSER_VERSION) { state.pages = {}; state.teams = {}; state.parserVersion = PARSER_VERSION; }
  // A change in what's built from the pages (not in how they're read): read every page again, keeping team names.
  if (state.buildVersion !== BUILD_VERSION) { state.pages = {}; state.buildVersion = BUILD_VERSION; }
  if (auto.version !== 2) { for (const k of Object.keys(auto)) delete auto[k]; }
  auto.version = 2;
  auto.source = 'Liquipedia (CC BY-SA 3.0), https://liquipedia.net/counterstrike/';
  for (const k of ['tournaments', 'teams', 'matches']) auto[k] = arr(auto[k]);
  auto.videos = (auto.videos && typeof auto.videos === 'object') ? auto.videos : {};

  const problems = [];
  const summary = { checked: 0, fetched: 0, tournaments: [] };
  const maxPages = +config.maxPagesPerRun || 30;

  /* 1. which Liquipedia page is each tournament? */
  const wanted = [];
  for (const tc of arr(config.tournaments)) {
    if (tc.liquipedia) { wanted.push({ ...tc, page: str(tc.liquipedia).trim() }); continue; }
    if (!tc.search) continue;
    let page = state.resolved[tc.search];
    if (!page) {
      try {
        const res = await lp({ action: 'query', list: 'search', srsearch: tc.search, srlimit: '10', srnamespace: '0' });
        const hit = arr(res.query.search).map(x => x.title).find(t => t.includes('/') && !/\/(Qualifier|Qualifiers|Statistics|Results|Media|Broadcast)/i.test(t));
        if (hit) { page = state.resolved[tc.search] = hit; log('Liquipedia search "' + tc.search + '" found the page ' + hit + '.'); }
      } catch (e) { warn(e.message); }
    }
    if (page) wanted.push({ ...tc, page });
    else problems.push('Couldn’t find a Liquipedia page for the search "' + tc.search + '". Add `"liquipedia": "<page name>"` instead.');
  }

  /* 1b. tournaments found automatically: the pages in Liquipedia's tier categories
        (such as "Category:S-Tier Tournaments") that start within the configured dates */
  const disc = config.discover;
  if (disc && arr(disc.categories).length) {
    const ds = state.discover = (state.discover && typeof state.discover === 'object') ? state.discover : {};
    ds.info = (ds.info && typeof ds.info === 'object') ? ds.info : {};
    const from = str(disc.from), to = str(disc.to) || '9999';
    const key = JSON.stringify(disc);
    const due = !ds.checkedAt || ds.key !== key || NOW.getTime() - Date.parse(ds.checkedAt) > (+disc.everyHours || 12) * HOUR;
    if (due) {
      try {
        const titles = new Set();
        for (const cat of arr(disc.categories)) {
          let cont = '';
          for (let i = 0; i < 10; i++) {
            const q = { action: 'query', list: 'categorymembers', cmtitle: cat, cmnamespace: '0', cmlimit: '500', cmprop: 'title' };
            if (cont) q.cmcontinue = cont;
            const res = await lp(q);
            arr(res.query.categorymembers).forEach(m => titles.add(m.title));
            cont = res.continue && res.continue.cmcontinue;
            if (!cont) break;
          }
          if (![...titles].length) problems.push('The Liquipedia category "' + cat + '" in config.json has no tournaments. Check its name.');
        }
        // Read the infobox of pages not seen before, skipping titles that name a year outside the range.
        const fy = +from.slice(0, 4) || 0, ty = +to.slice(0, 4) || 9999;
        const unknown = [...titles].filter(t => !(ds.info[t] && ds.info[t].sdate) && !/qualifier/i.test(t))
          .filter(t => { const ys = (t.match(/\b(?:19|20)\d\d\b/g) || []).map(Number); return !ys.length || ys.some(y => y >= fy && y <= ty); });
        for (let i = 0; i < unknown.length && i < 400; i += 20) {
          const res = await lp({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: unknown.slice(i, i + 20).join('|') });
          for (const p of arr(res.query.pages)) {
            const ib = parseInfobox(p.revisions ? p.revisions[0].slots.main.content || '' : '');
            ds.info[p.title] = { name: ib.name || '', sdate: ib.sdate || '', edate: ib.edate || '' };
          }
        }
        ds.titles = [...titles].sort();
        ds.checkedAt = NOW.toISOString();
        ds.key = key;
      } catch (e) { warn('Couldn’t look for new tournaments on Liquipedia: ' + e.message); }
    }
    // an entry ending in "/" leaves out every page under it, e.g. "FISSURE/"
    const skip = arr(disc.exclude).map(str).filter(Boolean);
    const skipped = t => skip.some(x => x.endsWith('/') ? t.startsWith(x) : t === x);
    const picked = arr(ds.titles).filter(t => !skipped(t) && ds.info[t] && ds.info[t].sdate && ds.info[t].sdate >= from && ds.info[t].sdate <= to);
    for (const t of picked) if (!wanted.some(w => w.page === t)) wanted.push({ page: t, discovered: true });
    if (due) log('Found ' + picked.length + ' tournaments in ' + arr(disc.categories).join(', ') + ' between ' + (from || 'the start') + ' and ' + to + '.');
  }

  /* 2. which pages changed? (the main page and any stage subpages) */
  const titles = [];
  for (const tc of wanted) titles.push(tc.page, ...arr((state.pages[tc.page] || {}).subpages));
  let revs = {};
  try { revs = await revisions([...new Set(titles)]); } catch (e) { warn(e.message); }

  const teamKeys = new Set();
  const built = [];
  for (const tc of wanted) {
    const ps = state.pages[tc.page] || (state.pages[tc.page] = {});
    if (revs[tc.page] === null) { problems.push('The Liquipedia page "' + tc.page + '" doesn’t exist. Check the name in config.json.'); continue; }
    const subs = arr(ps.subpages);
    const changed = !ps.revid || revs[tc.page] !== ps.revid || subs.some(s => revs[s] !== (ps.subRevids || {})[s]);
    summary.checked++;
    if (!changed) continue;
    if (summary.fetched >= maxPages) { log('Page limit reached for this run; ' + tc.page + ' waits for the next one.'); continue; }
    try {
      const mainPage = await pageText(tc.page);
      summary.fetched++;
      if (!mainPage) { problems.push('The Liquipedia page "' + tc.page + '" doesn’t exist.'); continue; }
      const pages = [{ title: tc.page, ...parsePage(mainPage.text, tc.page) }];
      // Majors and other big events keep their matches on stage subpages ("…/Legends Stage").
      let subpages = arr(tc.subpages);
      if (!subpages.length && pages[0].matches.length < 2) {
        const res = await lp({ action: 'query', list: 'prefixsearch', pssearch: tc.page + '/', pslimit: '30' });
        subpages = arr(res.query.prefixsearch).map(x => x.title)
          .filter(t => t.split('/').length === tc.page.split('/').length + 1 && !/\/(Qualifier|Qualifiers|Statistics|Results|Media|Broadcast|Showmatch|Open Qualifier|Closed Qualifier|Minor|Minor Qualifier|Regional|Ranking|Talent)/i.test(t) && !/Qualifier/i.test(t));
      }
      const subRevids = {};
      for (const sp of subpages) {
        const t = await pageText(sp);
        summary.fetched++;
        if (!t) continue;
        const parsed = parsePage(t.text, sp);
        if (!parsed.matches.length) continue;
        subRevids[sp] = t.revid;
        pages.push({ title: sp, ...parsed });
      }
      ps.revid = mainPage.revid;
      ps.subpages = Object.keys(subRevids);
      ps.subRevids = subRevids;
      ps.fetchedAt = NOW.toISOString();
      for (const pg of pages) for (const m of pg.matches) { if (m.a) teamKeys.add(m.a); if (m.b) teamKeys.add(m.b); }
      built.push({ tc, pages });
    } catch (e) { warn('Couldn’t read ' + tc.page + ': ' + e.message); }
  }

  /* 3. team names, from Liquipedia's team templates (one request for all new teams) */
  const unknown = [...teamKeys].filter(k => !state.teams[k]);
  for (let i = 0; i < unknown.length; i += 50) {
    const batch = unknown.slice(i, i + 50);
    try {
      const res = await lp({ action: 'expandtemplates', prop: 'wikitext', text: batch.map(k => '{{TeamShort|' + k + '}}').join('\n') });
      const names = teamNamesFromExpansion(res.expandtemplates.wikitext);
      batch.forEach((k, j) => {
        const n = names[j];
        state.teams[k] = n && n.name ? { id: 'lp-' + slug(n.page || n.name), name: displayName(n) } : { id: 'lp-' + slug(k), name: k.replace(/\b\w/g, c => c.toUpperCase()) };
      });
    } catch (e) { warn('Couldn’t look up team names: ' + e.message); }
  }
  const teamOf = k => state.teams[k] || { id: 'lp-' + slug(k), name: k };

  /* 4. replace the changed tournaments in auto.json */
  for (const { tc, pages } of built) {
    const { tournament, matches, videos } = buildTournament(tc, pages, teamOf);
    const old = auto.tournaments.find(t => t.page === tc.page);
    if (old) {
      auto.matches.filter(m => m.tournamentId === old.id).forEach(m => { delete auto.videos[m.id]; });
      auto.matches = auto.matches.filter(m => m.tournamentId !== old.id);
      auto.tournaments = auto.tournaments.filter(t => t !== old);
    }
    const linked = Object.values(videos).reduce((n, v) => n + v.maps.filter(x => x.video).length, 0);
    // Events whose matches aren't drawn yet stay off the site until they are, and so do
    // finished events that never got any videos (some organisers don't post them).
    // What happened is noted in state.json too, since the run logs aren't always at hand.
    const ps = state.pages[tc.page];
    ps.result = matches.length + ' matches, ' + linked + ' map videos';
    // Events that haven't started are listed under "Coming up" even before their matches are drawn.
    const upcoming = /^\d{4}-\d{2}-\d{2}/.test(tournament.sdate) ? Date.parse(tournament.sdate.slice(0, 10) + 'T00:00:00Z') > NOW.getTime() : false;
    if (!matches.length && !upcoming) { ps.result = 'no matches, not on the site'; continue; }
    if (!matches.length) ps.result = 'coming up, no matches drawn yet';
    const ended = Date.parse(str(tournament.edate).slice(0, 10) + 'T23:59:59Z');
    if (!linked && ended && NOW.getTime() - ended > 2 * 24 * HOUR) { ps.result += ', none with videos, so not on the site'; summary.tournaments.push(tournament.name + ': no videos, left off the site'); continue; }
    auto.tournaments.push(tournament);
    auto.matches.push(...matches);
    Object.assign(auto.videos, videos);
    summary.tournaments.push(tournament.name + ': ' + matches.length + ' matches, ' + linked + ' map videos');
  }
  // Tournaments no longer in the config are dropped.
  const keep = new Set(wanted.map(tc => tc.page));
  for (const t of auto.tournaments.filter(t => !keep.has(t.page))) {
    auto.matches.filter(m => m.tournamentId === t.id).forEach(m => { delete auto.videos[m.id]; });
    auto.matches = auto.matches.filter(m => m.tournamentId !== t.id);
  }
  auto.tournaments = auto.tournaments.filter(t => keep.has(t.page)).sort((a, b) => (b.sdate || '') < (a.sdate || '') ? -1 : (b.sdate || '') > (a.sdate || '') ? 1 : 0);
  // The home page features the newest tournament that has videos to watch.
  const withVideos = new Set(auto.matches.filter(m => arr((auto.videos[m.id] || {}).maps).some(x => x.video)).map(m => m.tournamentId));
  auto.featured = (auto.tournaments.find(t => withVideos.has(t.id)) || auto.tournaments[0] || {}).id || '';
  const usedTeams = new Set(auto.matches.flatMap(m => [m.a, m.b]));
  const teamList = new Map();
  for (const t of Object.values(state.teams)) if (usedTeams.has(t.id)) teamList.set(t.id, { id: t.id, name: t.name });
  auto.teams = [...teamList.values()].sort((a, b) => a.name.localeCompare(b.name));

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
  for (const p of Object.keys(state.pages)) if (!keep.has(p)) delete state.pages[p];

  /* 6. event pictures: your own picture in images/events/<id>.jpg (or .png/.webp) is used as the card picture;
        otherwise the event's logo is copied from Liquipedia into images/auto/ once */
  let own = [];
  try { own = await readdir(FILES.ownImages); } catch (e) { /* no folder yet */ }
  let have = [];
  try { have = await readdir(FILES.autoImages); } catch (e) { /* no folder yet */ }
  state.images = (state.images && typeof state.images === 'object') ? state.images : {};
  const wantFiles = [];
  for (const t of auto.tournaments) {
    const mine = own.find(f => f.replace(/\.(jpe?g|png|webp|avif)$/i, '') === t.id);
    t.art = mine ? 'images/events/' + mine : '';
    for (const [field, file, suffix] of [['logo', t.image, ''], ['logoDark', t.imageDark, '-dark']]) {
      t[field] = '';
      if (!file) continue;
      const done = state.images[t.id + suffix];
      if (done && done.file === file && have.includes(done.saved)) t[field] = 'images/auto/' + done.saved;
      else wantFiles.push({ t, field, file, key: t.id + suffix });
    }
  }
  if (wantFiles.length) {
    await mkdir(FILES.autoImages, { recursive: true });
    const batch = wantFiles.slice(0, +config.maxImagesPerRun || 20);
    try {
      const res = await lp({ action: 'query', prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '640', titles: [...new Set(batch.map(w => 'File:' + w.file))].join('|') });
      const norm = new Map(arr(res.query.normalized).map(n => [n.to, n.from]));
      const urls = new Map(arr(res.query.pages).map(p => [norm.get(p.title) || p.title, p.imageinfo && p.imageinfo[0]]));
      for (const w of batch) {
        const ii = urls.get('File:' + w.file);
        if (!ii) continue;
        const url = ii.thumburl || ii.url;
        const ext = (/\.(png|jpe?g|webp|gif|svg)(?:$|\?)/i.exec(url) || [, 'png'])[1].toLowerCase();
        const saved = w.key + '.' + (ext === 'jpeg' ? 'jpg' : ext);
        const wait = lastLp + LP_DELAY - Date.now();
        if (wait > 0) await sleep(wait);
        lastLp = Date.now();
        const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!r.ok) { warn('Couldn’t download the picture ' + w.file + ': HTTP ' + r.status); continue; }
        await writeFile(path.join(FILES.autoImages, saved), Buffer.from(await r.arrayBuffer()));
        const old = state.images[w.key];
        if (old && old.saved !== saved) await unlink(path.join(FILES.autoImages, old.saved)).catch(() => {});
        state.images[w.key] = { file: w.file, saved };
        w.t[w.field] = 'images/auto/' + saved;
      }
    } catch (e) { warn('Couldn’t fetch event pictures: ' + e.message); }
  }
  // Pictures of tournaments that are no longer on the site are removed.
  const ids = new Set(auto.tournaments.flatMap(t => [t.id, t.id + '-dark']));
  for (const [key, img] of Object.entries(state.images)) {
    if (ids.has(key)) continue;
    await unlink(path.join(FILES.autoImages, img.saved)).catch(() => {});
    delete state.images[key];
  }

  /* 6a. team logos: each team's logo (and its version for dark backgrounds, where there is one) is copied from
         Liquipedia's team template ({{TeamIcon|key}}) into images/teams/<team-id>.png once. Logos carry no results. */
  state.teamLogos = (state.teamLogos && typeof state.teamLogos === 'object') ? state.teamLogos : {};
  let haveTeams = [];
  try { haveTeams = await readdir(FILES.teamImages); } catch (e) { /* no folder yet */ }
  const keyOf = new Map();
  for (const [k, t] of Object.entries(state.teams)) if (usedTeams.has(t.id) && !keyOf.has(t.id)) keyOf.set(t.id, k);
  const unseen = [...keyOf].filter(([id]) => !state.teamLogos[id]);
  for (let i = 0; i < unseen.length && i < 120; i += 40) {
    const batch = unseen.slice(i, i + 40);
    try {
      const res = await lp({ action: 'expandtemplates', prop: 'wikitext', text: batch.map(([, k]) => '{{TeamIcon|' + k + '}}').join('\n@@@\n') });
      const parts = res.expandtemplates.wikitext.split('@@@');
      batch.forEach(([id], j) => { state.teamLogos[id] = { ...teamLogoFiles(parts[j] || ''), saved: {} }; });
    } catch (e) { warn('Couldn’t look up team logos: ' + e.message); break; }
  }
  const wantLogos = [];
  for (const [id] of keyOf) {
    const tl = state.teamLogos[id];
    if (!tl) continue;
    for (const [field, file, saved] of [['logo', tl.light, id + '.png'], ['logoDark', tl.dark && tl.dark !== tl.light ? tl.dark : '', id + '-dark.png']]) {
      if (!file) continue;
      if (haveTeams.includes(saved) && (tl.saved[field] === file || !tl.saved[field])) { tl.saved[field] = file; continue; }
      wantLogos.push({ id, field, file, saved, tl });
    }
  }
  if (wantLogos.length) {
    await mkdir(FILES.teamImages, { recursive: true });
    const batch = wantLogos.slice(0, +config.maxTeamLogosPerRun || 40);
    try {
      const res = await lp({ action: 'query', prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '256', titles: [...new Set(batch.map(w => 'File:' + w.file))].join('|') });
      const norm = new Map(arr(res.query.normalized).map(n => [n.to, n.from]));
      const urls = new Map(arr(res.query.pages).map(p => [norm.get(p.title) || p.title, p.imageinfo && p.imageinfo[0]]));
      for (const w of batch) {
        const ii = urls.get('File:' + w.file);
        if (!ii) continue;
        const wait = lastLp + LP_DELAY - Date.now();
        if (wait > 0) await sleep(wait);
        lastLp = Date.now();
        const r = await fetch(ii.thumburl || ii.url, { headers: { 'User-Agent': USER_AGENT } });
        if (!r.ok) { warn('Couldn’t download the logo ' + w.file + ': HTTP ' + r.status); continue; }
        await writeFile(path.join(FILES.teamImages, w.saved), Buffer.from(await r.arrayBuffer()));
        w.tl.saved[w.field] = w.file;
        if (!haveTeams.includes(w.saved)) haveTeams.push(w.saved);
      }
    } catch (e) { warn('Couldn’t fetch team logos: ' + e.message); }
  }
  for (const t of auto.teams) {
    const tl = state.teamLogos[t.id];
    if (!tl) continue;
    if (tl.saved.logo && haveTeams.includes(t.id + '.png')) t.logo = 'images/teams/' + t.id + '.png';
    if (tl.saved.logoDark && haveTeams.includes(t.id + '-dark.png')) t.logoDark = 'images/teams/' + t.id + '-dark.png';
  }

  /* 6b. calendar feeds, one per event, for the site's "Add to calendar" */
  const siteUrl = str(config.siteUrl) || ('https://' + (GH_REPO.split('/')[0] || 'spoilerfreecs2').toLowerCase() + '.github.io/' + (GH_REPO.split('/')[1] || 'CS2-Spoil-free') + '/');
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

  const line = 'Checked ' + summary.checked + ' tournaments on Liquipedia and read ' + summary.fetched + ' changed pages.' + (blocked ? ' Left out ' + blocked + ' map videos that can’t be played here.' : '');
  log(line);
  summary.tournaments.forEach(t => log('- ' + t));
  problems.forEach(p => warn(p));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '### Video watcher\n\n' + line + '\n\n' + summary.tournaments.map(t => '- ' + t).join('\n') + '\n');
}

main().catch(e => { console.error('::error::' + e.message); process.exit(1); });
