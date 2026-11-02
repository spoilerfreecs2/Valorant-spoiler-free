/*
  Finds the organisers' official highlight videos ("Team A vs Team B - HIGHLIGHTS | Event")
  on their main YouTube channels, and links each one to its match. The site offers them as
  a short version of a series.

  A video counts as a match's highlights when its title says "highlights", names both
  teams, and it came out within a few days after the match started. Titles are only read
  here to make that match: they are never saved, since they can carry the score.

  Results are kept in state.highlights (match id -> video id), so they survive a tournament
  page being read again and the video scrolling out of the channel's latest uploads.
*/

const str = v => (v === null || v === undefined) ? '' : String(v);
const arr = v => Array.isArray(v) ? v : [];
const HOUR = 3600 * 1000;
// Lowercase letters and digits only, so "Team Vitality" matches "TEAM VITALITY" and "Vitality".
const flat = s => str(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

// The ways a team's name can appear in a title: "Team Falcons" also as "Falcons".
export function nameForms(name) {
  const n = str(name).trim();
  const forms = new Set([flat(n)]);
  const bare = n.replace(/^(team|the)\s+/i, '').replace(/\s+(esports|e-sports|gaming|team|club|clan|gg|academy)$/i, '');
  forms.add(flat(bare));
  return [...forms].filter(f => f.length >= 2);
}

// Is this title a highlight video of a match between these two teams?
// Uploads from an all-highlights channel (anyTitle) count without the word in the title.
export function titleMatches(title, formsA, formsB, anyTitle = false) {
  if ((!anyTitle && !/highlight/i.test(title)) || /#shorts?\b/i.test(title)) return false;
  const t = flat(title);
  return formsA.some(f => t.includes(f)) && formsB.some(f => t.includes(f));
}

// Picks a match for each upload: both teams in the title, published 0 to maxDays after the match started.
// When a pair played more than once, the latest match before the upload wins.
export function matchUploads(uploads, matches, teamName, maxDays = 4, aliases = {}, anyTitle = []) {
  const found = {};
  const forms = new Map();
  // The site's name ("NAVI") and Liquipedia's full one from the id ("lp-natus-vincere" -> "Natus Vincere").
  const formsOf = id => {
    // Plus any other names from config.highlights.aliases, such as MOUZ's YouTube handle "@mousesports".
    if (!forms.has(id)) forms.set(id, [...new Set(nameForms(teamName(id)).concat(nameForms(str(id).replace(/^lp-/, '').replace(/-/g, ' ')), arr(aliases[id]).flatMap(nameForms)))]);
    return forms.get(id);
  };
  for (const up of uploads) {
    const at = Date.parse(up.publishedAt);
    if (!at) continue;
    let best = null;
    for (const m of matches) {
      const t = Date.parse(m.time);
      if (!t || at < t || at - t > maxDays * 24 * HOUR) continue;
      if (!titleMatches(up.title, formsOf(m.a), formsOf(m.b), anyTitle.includes(up.channel))) continue;
      if (!best || t > Date.parse(best.time)) best = m;
    }
    if (best && !found[best.id]) found[best.id] = up.id;
  }
  return found;
}

/* Reads the latest uploads of the configured channels and records new highlight matches.
   yt(endpoint, params) is the watcher's YouTube helper. Returns how many new links it found. */
export async function findHighlights({ config, state, auto, yt, now, log, warn }) {
  const hc = config.highlights;
  if (!hc || !arr(hc.channels).length) return 0;
  const hs = state.highlightScan = (state.highlightScan && typeof state.highlightScan === 'object') ? state.highlightScan : {};
  state.highlights = (state.highlights && typeof state.highlights === 'object') ? state.highlights : {};
  hs.uploads = (hs.uploads && typeof hs.uploads === 'object') ? hs.uploads : {};
  const every = (+hc.everyHours || 3) * HOUR;
  // A changed "highlights" setting scans again straight away, and reads further back the first time.
  const key = JSON.stringify(hc);
  const fresh = hs.key !== key;
  if (!fresh && hs.checkedAt && now.getTime() - Date.parse(hs.checkedAt) < every) return 0;

  // Only matches from the last few weeks can still get highlights.
  const since = now.getTime() - (+hc.lookBackDays || 21) * 24 * HOUR;
  const recent = auto.matches.filter(m => m.time && Date.parse(m.time) > since && !state.highlights[m.id]);
  if (!recent.length) return 0;
  hs.checkedAt = now.toISOString();
  hs.key = key;

  const teams = new Map(arr(auto.teams).map(t => [t.id, t.name]));
  const uploads = [];
  for (const handle of arr(hc.channels).map(str)) {
    try {
      // A channel's uploads are a playlist. Its id is looked up once per channel (1 quota unit).
      let list = hs.uploads[handle];
      if (!list) {
        const res = await yt('channels', { part: 'contentDetails', forHandle: handle.replace(/^@/, '') });
        list = (((arr(res.items)[0] || {}).contentDetails || {}).relatedPlaylists || {}).uploads || '';
        if (!list) { warn('Couldn’t find the YouTube channel ' + handle + ' for highlights.'); continue; }
        hs.uploads[handle] = list;
      }
      let token = '';
      for (let page = 0; page < (fresh ? +hc.firstPages || 10 : +hc.pages || 4); page++) {
        const q = { part: 'snippet', playlistId: list, maxResults: '50' };
        if (token) q.pageToken = token;
        const res = await yt('playlistItems', q);
        for (const it of arr(res.items)) {
          const sn = it.snippet || {};
          const id = (sn.resourceId || {}).videoId;
          if (id) uploads.push({ id, title: str(sn.title), publishedAt: str(sn.publishedAt), channel: handle });
        }
        token = res.nextPageToken;
        if (!token) break;
      }
    } catch (e) { warn('Couldn’t read the uploads of ' + handle + ': ' + e.message); }
  }
  const aliases = (hc.aliases && typeof hc.aliases === 'object') ? hc.aliases : {};
  const found = matchUploads(uploads, recent, id => teams.get(id) || '', +hc.maxDaysAfter || 4, aliases, arr(hc.anyTitle).map(str));
  Object.assign(state.highlights, found);
  const n = Object.keys(found).length;
  hs.last = scanReport(uploads, recent, id => teams.get(id) || '', found, arr(hc.anyTitle).map(str));
  log('Read ' + uploads.length + ' recent uploads from ' + arr(hc.channels).join(', ') + ' and found highlights for ' + n + ' more matches.');
  return n;
}

/* What the last scan saw, saved in state.json so a scan that finds nothing can be looked into.
   Up to 10 highlight titles per channel are kept, with every known team name and anything like a score blanked out. */
function scanReport(uploads, matches, teamName, found, anyTitle = []) {
  const teamIds = [...new Set(matches.flatMap(m => [m.a, m.b]))];
  const allForms = teamIds.flatMap(id => nameForms(teamName(id))).filter(f => f.length >= 3).sort((a, b) => b.length - a.length);
  const mask = title => {
    let t = str(title).replace(/\b\d{1,2}\s*[-:–]\s*\d{1,2}\b/g, '#-#');
    for (const f of allForms) t = t.replace(new RegExp(f.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]*'), 'gi'), '<team>');
    return t;
  };
  const channels = {};
  for (const u of uploads) {
    const c = channels[u.channel] = channels[u.channel] || { uploads: 0, sayHighlights: 0, oldest: '', newest: '' };
    c.uploads++;
    if (/highlight/i.test(u.title)) c.sayHighlights++;
    if (!c.oldest || u.publishedAt < c.oldest) c.oldest = u.publishedAt;
    if (!c.newest || u.publishedAt > c.newest) c.newest = u.publishedAt;
  }
  // Up to 10 per channel, so one busy channel doesn't crowd out the others.
  const perChannel = {};
  const samples = uploads.filter(u => (anyTitle.includes(u.channel) || /highlight/i.test(u.title)) && (perChannel[u.channel] = (perChannel[u.channel] || 0) + 1) <= 10).map(u => ({ channel: u.channel, at: u.publishedAt.slice(0, 16), title: mask(u.title) }));
  const times = matches.map(m => m.time).filter(Boolean).sort();
  return { matchesLookedFor: matches.length, matchesFrom: (times[0] || '').slice(0, 10), matchesTo: (times[times.length - 1] || '').slice(0, 10), found: Object.keys(found).length, channels, samples };
}
