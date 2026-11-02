/*
  Reads a Liquipedia Counter-Strike tournament page (its wikitext) into plain data:
  the infobox, and every match with its stage, round, teams, date and per-map videos.

  It deliberately ignores scores, winners and placements. The only result-like facts it
  keeps are which maps were played, so a series' unplayed maps can be marked as such.
*/

// Bump when the reader changes, so the watcher reads every page again with the new version.
export const PARSER_VERSION = 6;

/* ---------- template parsing ---------- */

// Finds every {{Name ...}} template in text (not nested ones inside other matches of the same name).
export function findTemplates(text, name, from = 0, to = text.length) {
  const out = [];
  const re = new RegExp('\\{\\{\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?=[|}\\n])', 'gi');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text)) && m.index < to) {
    const end = closingBraces(text, m.index);
    if (end < 0) break;
    out.push({ start: m.index, end, inner: text.slice(m.index + 2, end - 2) });
    re.lastIndex = end;
  }
  return out;
}

// Index just past the "}}" that closes the "{{" at pos, or -1.
function closingBraces(text, pos) {
  let depth = 0;
  for (let i = pos; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; }
    else if (text[i] === '}' && text[i + 1] === '}') { depth--; i++; if (depth === 0) return i + 1; }
  }
  return -1;
}

// "Name|a=1|b={{X|y}}|pos" -> { _name: 'Name', a: '1', b: '{{X|y}}', 1: 'pos' }
export function params(inner) {
  const parts = [];
  let depth = 0, link = 0, cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i], n = inner[i + 1];
    if (c === '{' && n === '{') { depth++; cur += '{{'; i++; continue; }
    if (c === '}' && n === '}') { depth--; cur += '}}'; i++; continue; }
    if (c === '[' && n === '[') { link++; cur += '[['; i++; continue; }
    if (c === ']' && n === ']') { link--; cur += ']]'; i++; continue; }
    if (c === '|' && depth === 0 && link === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  const out = { _name: parts.shift().trim() };
  let pos = 0;
  for (const p of parts) {
    const eq = p.indexOf('=');
    const brace = p.indexOf('{{');
    if (eq > 0 && (brace < 0 || eq < brace)) out[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
    else out[++pos] = p.trim();
  }
  return out;
}

const stripComments = s => String(s || '').replace(/<!--[\s\S]*?-->/g, '');
const plain = s => stripComments(s)
  .replace(/\{\{\s*Stage\s*\|([^}|]*)[^}]*\}\}/gi, '$1')
  .replace(/\{\{[^{}]*\}\}/g, '')
  .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
  .replace(/'{2,}/g, '')
  .replace(/<[^>]+>/g, '')
  .replace(/&(nbsp|amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (m, e) => ({ nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[e.toLowerCase()]
    || String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)))
  .replace(/\s+/g, ' ')
  .trim();

/* ---------- dates ---------- */

const TZ = {
  UTC: 0, GMT: 0, WET: 0, WEST: 1, BST: 1, CET: 1, CEST: 2, EET: 2, EEST: 3, MSK: 3, AST: 3, GST: 4, IST: 5.5,
  ALMT: 5, ICT: 7, SGT: 8, MYT: 8, HKT: 8, PHT: 8, AWST: 8, KST: 9, JST: 9, AEST: 10, AEDT: 11, NZDT: 13,
  BRT: -3, ART: -3, CLT: -4, CLST: -3, EDT: -4, EST: -5, CDT: -5, CST: -6, MDT: -6, MST: -7, PDT: -7, PST: -8
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// "October 3, 2026 - 11:00 {{Abbr/CEST}}" -> "2026-10-03T09:00:00.000Z" (or a date-only ISO string).
export function parseDate(s) {
  s = String(s || '');
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:\s*-\s*(\d{1,2}):(\d{2}))?/);
  if (m) {
    const mon = MONTHS.indexOf(m[1].toLowerCase());
    if (mon < 0) return '';
    const tzm = s.match(/Abbr\/([A-Z]+)/) || s.match(/\b(UTC|GMT|[A-Z]{2,4}T)\b/);
    const off = tzm && TZ[tzm[1]] !== undefined ? TZ[tzm[1]] : 0;
    const t = Date.UTC(+m[3], mon, +m[2], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0) - off * 3600 * 1000;
    return new Date(t).toISOString();
  }
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return iso ? new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], 12)).toISOString() : '';
}

/* ---------- videos ---------- */

// A YouTube link (with an optional start time) -> { id, start } or null. Twitch and other hosts are skipped.
export function parseVod(url) {
  url = String(url || '').trim();
  const id = (url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/live\/)([\w-]{11})/) || [])[1];
  if (!id) return null;
  let start = 0;
  const t = url.match(/[?&#]t=([\dhms]+)/i) || url.match(/[?&]start=(\d+)/i);
  if (t) {
    const v = t[1];
    if (/^\d+$/.test(v)) start = +v;
    else { const p = v.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i); start = (+p[1] || 0) * 3600 + (+p[2] || 0) * 60 + (+p[3] || 0); }
  }
  return { id, start };
}

/* ---------- the page ---------- */

const SKIP_HEADINGS = /^(overview|detailed results|results|high|low|mid|middle|matches)$/i;

// Just the infobox: name, dates, place, tier and size.
export function parseInfobox(text) {
  const info = {};
  const ib = findTemplates(text, 'Infobox league')[0];
  if (ib) {
    const p = params(ib.inner);
    Object.assign(info, {
      name: plain(p.name), shortname: plain(p.shortname), series: plain(p.series), organizer: plain(p.organizer),
      sdate: stripComments(p.sdate || p.date).trim(), edate: stripComments(p.edate || p.date).trim(),
      city: plain(p.city), country: plain(p.country), type: plain(p.type), tier: plain(p.liquipediatier),
      teamNumber: plain(p.team_number), prizepool: plain(p.prizepoolusd || p.prizepool),
      // Logo file names on Liquipedia: one for light backgrounds, and one for dark if there is one.
      image: plain(p.image), imageDark: plain(p.imagedark || p.imagedarkmode)
    });
  }
  const display = (text.match(/\{\{DISPLAYTITLE:\s*([^}]*)\}\}/) || [])[1] || '';
  info.displayTitle = plain(display);
  return info;
}

export function parsePage(text, pageTitle = '') {
  const info = parseInfobox(text);

  // Headings, comments and match containers, in page order.
  const headings = [...text.matchAll(/^(={2,6})\s*(.*?)\s*\1\s*$/gm)].map(m => ({ pos: m.index, level: m[1].length, text: m[2] }));
  const comments = [...text.matchAll(/<!--\s*([\s\S]*?)\s*-->/g)].map(m => ({ pos: m.index, text: m[1].trim() }));
  const resultsAt = (headings.find(h => h.level === 2 && /results/i.test(plain(h.text))) || { pos: 0 }).pos;
  const resultsEnd = (headings.find(h => h.level === 2 && h.pos > resultsAt && !/results/i.test(plain(h.text))) || { pos: text.length }).pos;
  const containers = [];
  for (const kind of ['Matchlist', 'Bracket', 'SingleMatch']) {
    for (const c of findTemplates(text, kind, resultsAt, resultsEnd)) {
      // Only the container's own parameters (not the matches inside it).
      const head = params(stripComments(c.inner.replace(/\{\{[\s\S]*$/, '')));
      containers.push({ ...c, kind, id: head.id || '', title: plain(head.matchsection || head.title || ''), head });
    }
  }
  containers.sort((a, b) => a.start - b.start);

  const pageStage = info.displayTitle.includes(':') ? info.displayTitle.split(':').pop().trim().replace(/^the\s+/i, '').replace(/^new\s+/i, '') : '';
  const matches = [];
  for (const c of containers) {
    const before = headings.filter(h => h.pos < c.start && h.pos > resultsAt);
    // Stage: a {{Stage|...}} heading, else the first level-3 heading under Results, else the subpage's own stage name.
    const stageH = [...before].reverse().find(h => /\{\{\s*Stage\s*\|/i.test(h.text)) || [...before].reverse().find(h => h.level === 3 && !SKIP_HEADINGS.test(plain(h.text)));
    const stage = (stageH && plain(stageH.text)) || pageStage || 'Main Event';
    const group = [...before].reverse().find(h => (!stageH || (h.pos > stageH.pos && h.level > stageH.level)) && /^group\s+\w+$/i.test(plain(h.text)));
    const groupName = group ? plain(group.text) : '';

    const inner = findTemplates(text, 'Match', c.start + 2, c.end);
    inner.forEach((mt, idx) => {
      const p = params(mt.inner);
      // Round name: the Matchlist's section, or the nearest comment in a bracket ("Upper Bracket Final").
      let round = '';
      let key = 'M' + (idx + 1);
      if (c.kind === 'Bracket') {
        const keyM = text.slice(Math.max(c.start, mt.start - 40), mt.start).match(/\|\s*(R\d+M\d+|RxMTP|RxMBR|R\w+)\s*=\s*$/);
        if (keyM) key = keyM[1];
        const cm = [...comments].reverse().find(x => x.pos > c.start && x.pos < mt.start);
        round = cm ? cm.text : '';
        if (!round) { const hdr = c.head[key.replace(/M\d+$/, 'M1') + 'header'] || ''; round = plain(hdr); }
        if (!round) { const r = key.match(/^R(\d+)/); round = r ? 'Round ' + r[1] : 'Bracket'; }
      } else {
        round = c.title || (([...before].reverse().find(h => !SKIP_HEADINGS.test(plain(h.text))) || {}).text || '');
        round = plain(round);
      }
      round = round.replace(/\s+(high|low|mid|middle)(\s+matches?)?$/i, '').replace(/\s+matches?$/i, '').trim() || 'Matches';
      if (groupName && !round.toLowerCase().startsWith('group')) round = groupName + ': ' + round;

      const team = v => {
        const t = findTemplates(String(v || ''), 'TeamOpponent')[0];
        if (!t) return '';
        const tp = params(t.inner);
        const k = String(tp.template || tp[1] || '').trim().toLowerCase();
        return k && k !== 'tbd' ? k : '';
      };
      const maps = [];
      for (let i = 1; i <= 9; i++) {
        const raw = p['map' + i];
        if (!raw) continue;
        const mp = findTemplates(raw, 'Map')[0];
        const mpp = mp ? params(mp.inner) : {};
        const fin = String(mpp.finished || '').toLowerCase();
        const vod = parseVod(mpp.vod || p['vodgame' + i] || '');
        maps.push({ name: plain(mpp.map), played: fin === 'skip' ? false : (fin === 'true' ? true : null), vod });
      }
      const seriesVod = parseVod(p.vod || '');
      let bo = +plain(p.bestof) || maps.length || 0;
      if (![1, 3, 5].includes(bo)) bo = bo === 2 ? 3 : (bo === 4 ? 5 : (bo > 5 ? 5 : 0));
      const stream = (String(p.youtube || '').match(/\/([\w-]{11})\s*$/) || [])[1] || '';
      matches.push({
        container: c.id || (c.kind + c.start), key, stage, round,
        a: team(p.opponent1), b: team(p.opponent2),
        date: parseDate(p.date), bo, finished: String(p.finished || '').toLowerCase() === 'true',
        maps, seriesVod, stream, order: matches.length
      });
    });
  }
  return { info, matches };
}

// Expanded {{TeamShort|key}} templates -> names, in order.
export function teamNamesFromExpansion(wikitext) {
  return String(wikitext || '').split('\n').map(line => {
    const m = line.match(/team-template-text">\s*\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/);
    return m ? { page: plain(m[1]), name: plain(m[2] || m[1]) } : null;
  });
}

/* One expanded {{TeamIcon|key}} -> { light, dark } logo file names. The template wraps them in spans
   marked lightmode and darkmode; a team with a single logo uses it for both. */
export function teamLogoFiles(wikitext) {
  const t = String(wikitext);
  const files = [...t.matchAll(/\[\[(?:File|Image):([^|\]]+)/gi)].map(m => m[1].trim());
  const dark = (t.match(/darkmode[^[]*\[\[(?:File|Image):([^|\]]+)/i) || [])[1];
  const light = (t.match(/lightmode[^[]*\[\[(?:File|Image):([^|\]]+)/i) || [])[1];
  return { light: (light || files[0] || '').trim(), dark: (dark || '').trim() };
}
