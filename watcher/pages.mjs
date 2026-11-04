/*
  Findable pages: a real address for every event, team and match, for search engines and shared links.

  The site itself is one page (index.html) that draws everything from addresses like #/t/<id>, which
  search engines mostly skip. So when the site is published this writes, next to index.html:

    event/<id>/index.html     one per event
    team/<id>/index.html      one per team that plays in an open round
    match/<id>/index.html     one per match
    teams/index.html          the list of teams
    privacy/, terms/, contact/ the privacy policy, terms of use and contact page (legalPage() in index.html)
    404.html                  turns any other address of that shape into the site's own (#/...)
    sitemap.xml               every page above, to submit in Google Search Console
    og/...png                 each page's link preview picture (watcher/cards.mjs)

  Each is a copy of index.html with its own title, description and link preview, and a plain version of
  the page's content for search engines that don't run JavaScript. When a visitor opens one, the site
  starts on the matching #/ address, so everything works as before. As they move around, the site keeps
  the address bar on the matching page (pageFor() in index.html), so a link copied from it gets that
  page's preview when it's pasted into Discord, X or Reddit.

  Spoiler rules, the same as the site's:
  - Nothing here mentions scores or winners (the data has none).
  - A match in a hidden round (anything after an event's first round) never names its teams: not in the
    title, description or content. Its page asks the visitor before showing the matchup.
  - A team page lists only matches in open rounds, so it can't show how far a team went.
  - Link preview pictures follow the same rules: a hidden-round match shows a lock, not the teams.

  To get the site's data exactly as the browser sees it, this reads normalize() and mergeAuto() (which
  decide the rounds and which ones are hidden) straight out of index.html.

  Usage: node watcher/pages.mjs <site folder>   (run by the workflow after the site files are collected)
*/
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { drawCards, W as CARD_W, H as CARD_H } from './cards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '_site'));

const str = v => (v === null || v === undefined) ? '' : String(v);
const arr = v => Array.isArray(v) ? v : [];
const esc = s => str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const readJson = async f => { try { return JSON.parse(await readFile(f, 'utf8')); } catch (e) { return null; } };

/* ---------- the site's own data code ---------- */
// Pulls top-level `const x = ...;` lines and `function x(...) {...}` blocks out of index.html by name.
function grab(src, name) {
  const c = src.match(new RegExp('^const ' + name + ' = .*;$', 'm'));
  if (c) return c[0];
  const at = src.search(new RegExp('^function ' + name + '\\(', 'm'));
  if (at < 0) throw new Error('index.html has no ' + name + '()');
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error('Couldn’t read ' + name + '() from index.html');
}
function siteData(html, d, auto) {
  const names = ['str', 'arr', 'clone', 'blankMap', 'normMatch', 'normalize', 'looseName', 'roundRank', 'mergeAuto'];
  const code = names.map(n => grab(html, n)).join('\n') + '\n;mergeAuto(normalize(D), A)';
  return vm.runInNewContext(code, { D: d, A: auto });
}

/* ---------- pages ---------- */
function siteUrl(config) {
  const repo = str(process.env.GITHUB_REPOSITORY);
  const u = str(config.siteUrl) || ('https://' + (repo.split('/')[0] || 'spoilerfreecs2').toLowerCase() + '.github.io/' + (repo.split('/')[1] || 'Valorant-spoiler-free') + '/');
  return u.endsWith('/') ? u : u + '/';
}

// A copy of index.html for one page. `depth` is how many folders down it sits, for <base>.
function page(html, o) {
  const site = o.siteName;
  const card = !!o.card; // a full-size preview picture from cards.mjs, rather than a small logo
  const title = o.title ? o.title + ' · ' + site : site + ' · Watch Valorant without spoilers';
  const head = [
    `<base href="${o.base}">`,
    `<link rel="canonical" href="${esc(o.url)}">`,
    `<meta property="og:site_name" content="${esc(site)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(o.title || site)}">`,
    `<meta property="og:description" content="${esc(o.desc)}">`,
    `<meta property="og:url" content="${esc(o.url)}">`,
    o.image ? `<meta property="og:image" content="${esc(o.image)}">` : '',
    o.image && card ? `<meta property="og:image:width" content="${CARD_W}">\n<meta property="og:image:height" content="${CARD_H}">` : '',
    o.image ? `<meta property="og:image:alt" content="${esc(o.imageAlt || o.title || site)}">` : '',
    `<meta name="twitter:card" content="${card ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${esc(o.title || site)}">`,
    `<meta name="twitter:description" content="${esc(o.desc)}">`,
    o.image ? `<meta name="twitter:image" content="${esc(o.image)}">` : '',
    o.image ? `<meta name="twitter:image:alt" content="${esc(o.imageAlt || o.title || site)}">` : '',
    o.verify ? `<meta name="google-site-verification" content="${esc(o.verify)}">` : '',
    o.noindex ? '<meta name="robots" content="noindex">' : '',
    // Cloudflare Web Analytics: counts visits with no cookies and nothing stored on the visitor's device.
    o.analytics ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${esc(JSON.stringify({ token: o.analytics }))}"></script>` : '',
    // The site works from #/ addresses, so the visitor's address becomes the site's own one for this page,
    // with nothing reloaded. One they already had (from a shared #/ link) wins.
    `<script>window.SF_ROOT = ${JSON.stringify(o.root)};</script>`,
    o.hash ? `<script>window.SF_LANDING = ${JSON.stringify(o.landing || {})}; try { if (!/^#\\//.test(location.hash)) history.replaceState(null, '', location.pathname + location.search + ${JSON.stringify(o.hash)}); } catch (e) { /* stays on this address */ }</script>` : '',
    o.script || ''
  ].filter(Boolean).join('\n');
  let out = html
    .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n' + head)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(o.desc)}">`);
  if (o.body) out = out.replace('<main id="app"></main>', `<main id="app">${o.body}</main>`);
  return out;
}

async function build(html, d, auto, config, out) {
  const data = siteData(html, d, auto);
  const base = siteUrl(config);
  const siteName = data.site.name || 'Live Again Valorant';
  const verify = str(d && d.site && d.site.googleVerification);
  const analytics = str(d && d.site && d.site.cloudflareAnalytics).trim();
  const teamById = new Map(data.teams.map(t => [t.id, t]));
  const teamName = id => (teamById.get(id) || {}).name || 'TBD';
  const abs = rel => rel && !/^(data:|https?:)/.test(rel) ? base + rel : (/^https?:/.test(rel) ? rel : '');
  const files = {};
  const urls = [base, base + 'teams/'];
  // <base> is the site's root as an absolute path, so the site's files still load after it moves the
  // address bar to another page's address.
  const root = new URL(base).pathname;
  const common = { siteName, verify, analytics, base: root, root };
  // Pages wait here until their preview pictures are drawn: { rel: page options }.
  const pages = {};
  const cards = [];
  const game = /valorant/i.test(siteName) ? 'Valorant' : 'CS2';
  const preview = (rel, o, c) => { pages[rel] = o; if (c) { o.card = 'og/' + c.file; cards.push({ ...c, file: o.card }); } };

  // Matches, rounds and the open ones, as the browser has them.
  const rows = [];
  data.tournaments.forEach(t => t.stages.forEach(s => s.rounds.forEach(rd => rd.matches.forEach(m => rows.push({ t, s, rd, m })))));
  const where = (t, s, rd) => [t.stages.length > 1 && s.name !== rd.name ? s.name : '', rd.name].filter(Boolean).join(' / ');
  const vs = m => teamName(m.a) + ' vs ' + teamName(m.b);
  const matchLine = ({ t, s, rd, m }) => [where(t, s, rd), 'Best of ' + m.bo, m.date].filter(Boolean).join(' · ');
  const link = (href, text) => `<a href="${esc(href)}">${esc(text)}</a>`;

  // Teams with a match in an open round. Others only play in hidden rounds, so they get no page.
  const open = new Map();
  rows.forEach(x => { if (!x.rd.locked) [x.m.a, x.m.b].forEach(id => { if (teamById.has(id) && teamName(id) !== 'TBD') { if (!open.has(id)) open.set(id, []); open.get(id).push(x); } }); });

  for (const t of data.tournaments) {
    const ms = rows.filter(x => x.t === t);
    const when = [t.dates, t.location, t.teamsText].filter(Boolean).join(' · ');
    const rounds = t.stages.flatMap(s => s.rounds.map(rd => {
      const list = rd.locked ? '<p>Hidden until you open it, so it can’t give away earlier results.</p>'
        : '<ul>' + rd.matches.map(m => `<li>${link('match/' + m.id + '/', vs(m))} · Best of ${m.bo}${m.date ? ' · ' + esc(m.date) : ''}</li>`).join('') + '</ul>';
      return `<h2>${esc(where(t, s, rd) || 'Matches')}</h2>${list}`;
    })).join('');
    preview('event/' + t.id + '/index.html', { ...common, url: base + 'event/' + t.id + '/', hash: '#/t/' + t.id,
      title: t.name, image: abs(t.logo), imageAlt: t.name + ' on ' + siteName + ': every map, no scores',
      desc: 'Watch ' + t.name + ' spoiler-free: every map from the first round on, with no scores, no video lengths and later matchups hidden.' + (when ? ' ' + when + '.' : ''),
      body: `<section class="wrap t-head"><h1 class="t-title">${esc(t.name)}</h1>${when ? `<p class="lede">${esc(when)}</p>` : ''}<p>${ms.length ? 'Every match, no scores or video lengths.' : 'Matches show up here once they’re drawn.'}</p>${rounds}</section>` },
      { file: 'event/' + t.id + '.png', kind: 'event', title: t.name, logo: t.logoDark || t.logo, eyebrow: game + ' event',
        sub: ms.length ? 'Every map from the first round on. No scores, no video lengths.' : 'Every map, spoiler-free, once the matches are drawn.',
        line: [t.dates, t.location, t.teamsText] });
    urls.push(base + 'event/' + t.id + '/');
  }

  for (const x of rows) {
    const { t, rd, m } = x;
    const named = !rd.locked;
    const title = named ? vs(m) + ' · ' + t.name : [rd.name, t.name].filter(Boolean).join(' · ');
    const desc = (named ? 'Watch ' + vs(m) + ' at ' + t.name : 'Watch ' + (rd.name || 'this match') + ' of ' + t.name)
      + ' without spoilers: ' + [named ? where(x.t, x.s, rd) : '', 'Best of ' + m.bo, m.date].filter(Boolean).join(' · ') + '. No scores, no video lengths.';
    preview('match/' + m.id + '/index.html', { ...common, url: base + 'match/' + m.id + '/', hash: '#/match/' + m.id + '/0',
      landing: { match: m.id }, title, desc, image: abs(t.logo), imageAlt: named ? vs(m) + ', ' + t.name + '. No score shown.' : (rd.name || 'Match') + ' of ' + t.name + '. Matchup hidden.',
      body: `<section class="wrap t-head"><p>${link('event/' + t.id + '/', t.name)}</p><h1 class="t-title">${esc(named ? vs(m) : rd.name || 'Match')}</h1><p>${esc(matchLine(x))}</p>`
        + (named ? '' : '<p>This matchup is hidden, so it can’t give away results from earlier rounds.</p>') + '</section>' },
      named ? { file: 'match/' + m.id + '.png', kind: 'match', event: t.name, line: [where(x.t, x.s, rd), 'Best of ' + m.bo, m.date],
        a: { name: teamName(m.a), logo: (teamById.get(m.a) || {}).logoDark || (teamById.get(m.a) || {}).logo },
        b: { name: teamName(m.b), logo: (teamById.get(m.b) || {}).logoDark || (teamById.get(m.b) || {}).logo } }
        // Hidden round: only what the page itself shows. No teams, no logos of theirs.
        : { file: 'match/' + m.id + '.png', kind: 'hidden', title: rd.name || 'Match', event: t.name, logo: t.logoDark || t.logo,
          line: [x.t.stages.length > 1 && x.s.name !== rd.name ? x.s.name : '', 'Best of ' + m.bo, m.date] });
    urls.push(base + 'match/' + m.id + '/');
  }

  const teams = [...open.keys()].sort((a, b) => teamName(a).localeCompare(teamName(b)));
  for (const id of teams) {
    const tm = teamById.get(id), xs = open.get(id);
    const evs = [...new Set(xs.map(x => x.t))];
    const body = evs.map(t => `<h2>${link('event/' + t.id + '/', t.name)}</h2><ul>`
      + xs.filter(x => x.t === t).map(x => `<li>${link('match/' + x.m.id + '/', vs(x.m))} · ${esc(matchLine(x))}</li>`).join('') + '</ul>').join('');
    preview('team/' + id + '/index.html', { ...common, url: base + 'team/' + id + '/', hash: '#/team/' + id,
      title: tm.name, image: abs(tm.logo), imageAlt: tm.name + ' on ' + siteName + '. No scores shown.',
      desc: 'Watch ' + tm.name + '’s Valorant matches without spoilers: ' + evs.map(t => t.name).slice(0, 4).join(', ') + '. No scores, and later rounds stay hidden.',
      body: `<section class="wrap t-head"><h1 class="t-title">${esc(tm.name)}</h1><p>Matches in rounds that can’t give away results.</p>${body}</section>` },
      { file: 'team/' + id + '.png', kind: 'team', title: tm.name, logo: tm.logoDark || tm.logo, eyebrow: game + ' team',
        sub: 'Watch their matches without spoilers.', line: [evs.map(t => t.name).slice(0, 2).join(', ') + (evs.length > 2 ? ' and more' : '')] });
    urls.push(base + 'team/' + id + '/');
  }
  // Privacy policy, terms and contact: the same text the site shows at #/privacy and the rest, readable without JavaScript.
  const legal = vm.runInNewContext([grab(html, 'LEGAL_SITE'), grab(html, 'legalPage')].join('\n') + '\n;({ L: LEGAL_SITE, legalPage })', {});
  const contact = data.site.contact || {}, fb = data.site.firebase || {};
  for (const k of ['privacy', 'terms', 'contact']) {
    const lp = legal.legalPage(k, { legal: legal.L, name: siteName, email: str(contact.email), issues: str(contact.issues), firebase: !!(fb.apiKey && fb.databaseURL) });
    preview(k + '/index.html', { ...common, url: base + k + '/', hash: '#/' + k, title: lp.title, desc: lp.desc,
      body: `<section class="wrap legal">${lp.html}</section>` }, { file: 'site.png', shared: true });
    urls.push(base + k + '/');
  }
  preview('teams/index.html', { ...common, url: base + 'teams/', hash: '#/teams', title: 'Teams',
    desc: 'Valorant teams and their matches, to watch without spoilers.',
    body: '<section class="wrap t-head"><h1 class="t-title">Teams</h1><ul>' + teams.map(id => `<li>${link('team/' + id + '/', teamName(id))}</li>`).join('') + '</ul></section>' },
    { file: 'teams.png', kind: 'team-list', title: 'Teams', eyebrow: game + ' teams', sub: 'Every team’s matches, to watch without spoilers.' });

  // The home page gets its address and link preview too.
  preview('index.html', { ...common, url: base, desc: 'Watch Valorant tournament videos without spoilers: no scores, no video lengths, no giveaways.' },
    { file: 'site.png', kind: 'home', title: siteName, eyebrow: game + ' tournaments, spoiler-free', sub: 'Every match as if it were live. No scores, no video lengths, nothing that gives the result away.',
      chips: ['No scores', 'No video lengths', 'Every map listed', 'Later rounds locked'] });
  // Any other address: event/<id>/<stage>/<round>, match/<id>/<map> and the rest open the site's own.
  files['404.html'] = page(html, { ...common, url: base, noindex: true, title: 'Page not found', desc: 'Page not found',
    script: `<script>(function () { var p = location.pathname.slice(${JSON.stringify(root)}.length).split('/').filter(Boolean), k = { event: 't', match: 'match', team: 'team', teams: 'teams', collection: 'c', privacy: 'privacy', terms: 'terms', contact: 'contact' }[p[0]];
  if (k === 'match') window.SF_LANDING = { match: p[1] };
  if (k && !/^#\\//.test(location.hash)) try { history.replaceState(null, '', ${JSON.stringify(root)} + location.search + '#/' + [k].concat(p.slice(1)).join('/')); } catch (e) { /* stays here */ } })();</script>` });

  // The pictures, then the pages that show them. A page whose picture couldn't be drawn keeps its logo.
  const unique = [...new Map(cards.filter(c => c.kind).map(c => [c.file, c])).values()];
  const drawn = await drawCards(unique, { out, root: ROOT, brand: siteName, accent: ACCENT, ink: '#0a0a0b', fg: '#f3f1ee', soft: '#cfcac3', muted: '#8f8b85', card2: '#1f1f22' });
  for (const [rel, o] of Object.entries(pages)) {
    if (o.card && drawn && drawn.has(o.card)) o.image = base + o.card;
    else o.card = '';
    files[rel] = page(html, o);
  }

  files['sitemap.xml'] = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map(u => `  <url><loc>${esc(u)}</loc></url>`).join('\n') + '\n</urlset>\n';
  return files;
}

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
// The site's accent colour (dark theme), for the preview pictures.
const ACCENT = (html.match(/--orange:(#[0-9a-f]{6})/i) || [])[1] || '#ff8a3d';
const files = await build(html, await readJson(path.join(ROOT, 'data.json')) || {}, await readJson(path.join(ROOT, 'auto.json')), await readJson(path.join(ROOT, 'watcher', 'config.json')) || {}, OUT);
for (const [rel, text] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(OUT, rel)), { recursive: true });
  await writeFile(path.join(OUT, rel), text);
}
console.log('Findable pages: ' + Object.keys(files).filter(f => f.endsWith('index.html')).length + ' pages and a sitemap in ' + OUT);
