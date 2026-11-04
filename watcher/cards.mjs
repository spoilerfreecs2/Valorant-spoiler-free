/*
  Link preview pictures: the 1200 x 630 card that Discord, X, Reddit, WhatsApp and the rest show when
  someone pastes a link to an event, match or team.

  They are drawn here from the same data as the pages (watcher/pages.mjs), so they follow the same
  spoiler rules, and they can't show anything the data doesn't have. The data has no scores or winners.
  - A match in an open round shows both teams.
  - A match in a hidden round shows a lock and the round's name, never the teams.
  - Every card carries a "No scores" badge, so people seeing the link know it's safe to click.

  Each card is an SVG turned into a PNG with resvg (npm @resvg/resvg-js, installed by the workflow).
  Without it the pages still build, with the event or team logo as a small preview, as before.
*/
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const W = 1200, H = 630;
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The site's own fonts, from Google Fonts (TTF, which resvg reads). Kept out of the published site.
const FONTS = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=Figtree:wght@500;700';
async function fonts() {
  const dir = path.join(os.tmpdir(), 'live-again-fonts');
  try {
    // An old browser name gets plain TTF files back instead of WOFF2.
    const css = await (await fetch(FONTS, { headers: { 'User-Agent': 'Mozilla/4.0' } })).text();
    const urls = [...css.matchAll(/url\((https:[^)]+\.ttf)\)/g)].map(m => m[1]);
    await mkdir(dir, { recursive: true });
    const files = [];
    for (const u of urls) {
      const f = path.join(dir, path.basename(new URL(u).pathname));
      try { await readFile(f); } catch (e) { await writeFile(f, Buffer.from(await (await fetch(u)).arrayBuffer())); }
      files.push(f);
    }
    return files;
  } catch (e) {
    console.log('Link previews: couldn’t get the site fonts (' + e.message + '), using the system ones.');
    return [];
  }
}

// Rough text fitting. resvg can't measure or wrap, so this goes by average letter widths.
const DISPLAY_W = 0.47, BODY_W = 0.54; // average letter width, as a share of the font size
function lines(text, size, width, max, wide = DISPLAY_W) {
  const per = Math.max(4, Math.floor(width / (size * wide)));
  const words = String(text).split(/\s+/).filter(Boolean), out = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= per) cur += ' ' + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > max) { out.length = max; out[max - 1] = out[max - 1].replace(/\s*\S*$/, '') + '…'; }
  return out.map(l => l.length > per ? l.slice(0, per - 1) + '…' : l);
}
// The biggest size (from the list) at which the text fits in `max` lines.
function fit(text, sizes, width, max, wide) {
  for (const s of sizes) {
    const per = Math.floor(width / (s * wide));
    const words = String(text).split(/\s+/);
    if (words.every(w => w.length <= per) && lines(text, s, width, 99, wide).length <= max) return s;
  }
  return sizes[sizes.length - 1];
}
function textBlock(text, x, y, o) {
  const size = o.size || fit(text, o.sizes, o.width, o.max, o.wide || DISPLAY_W);
  const ls = lines(text, size, o.width, o.max, o.wide || DISPLAY_W);
  const lh = Math.round(size * (o.lh || 1));
  const top = o.middle ? y - ((ls.length - 1) * lh) / 2 : y;
  return {
    svg: ls.map((l, i) => `<text x="${x}" y="${Math.round(top + i * lh)}" font-family="${o.font}" font-weight="${o.weight}" font-size="${size}" fill="${o.fill}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''}>${esc(o.upper ? l.toUpperCase() : l)}</text>`).join(''),
    bottom: top + (ls.length - 1) * lh, size
  };
}

const DISPLAY = "'Big Shoulders Display', 'Arial Narrow', sans-serif";
const BODY = "'Figtree', 'DejaVu Sans', sans-serif";

const images = new Map();
async function image(root, rel) {
  if (!rel || /^(https?:|data:)/.test(rel)) return '';
  if (!images.has(rel)) images.set(rel, readImage(root, rel));
  return images.get(rel);
}
async function readImage(root, rel) {
  try {
    const b = await readFile(path.join(root, rel));
    const type = /\.jpe?g$/i.test(rel) ? 'jpeg' : /\.svg$/i.test(rel) ? 'svg+xml' : 'png';
    return `data:image/${type};base64,${b.toString('base64')}`;
  } catch (e) { return ''; }
}
// Logos made for light backgrounds (black or navy marks) vanish on the dark card, so those sit on a
// light disc. Measured by drawing the logo small and averaging its visible pixels.
let R = null;
const darkness = new Map();
function isDark(href) {
  if (!R || !href) return false;
  if (!darkness.has(href)) {
    let dark = false;
    try {
      const px = new R(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><image href="${href}" width="48" height="48"/></svg>`).render().pixels;
      let sum = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 160) { sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; }
      dark = n > 0 && sum / n < 70;
    } catch (e) { /* treat as light */ }
    darkness.set(href, dark);
  }
  return darkness.get(href);
}
const plate = (href, cx, cy, size, s) => isDark(href) ? `<circle cx="${cx}" cy="${cy}" r="${size * 0.62}" fill="${s.fg}"/>` : '';
const logoAt = (href, x, y, size) => href ? `<image href="${href}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>` : '';
const initials = (name, cx, cy, size, s) => `<circle cx="${cx}" cy="${cy}" r="${size / 2}" fill="${s.card2}"/><text x="${cx}" y="${cy + size * 0.13}" text-anchor="middle" font-family="${DISPLAY}" font-weight="900" font-size="${size * 0.36}" fill="${s.muted}">${esc(String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 3).join('').toUpperCase() || '?')}</text>`;
const lockIcon = (cx, cy, k, fill) => `<g transform="translate(${cx - 12 * k} ${cy - 13 * k}) scale(${k})" fill="none" stroke="${fill}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="12" rx="2.5"/><path d="M7 11V7.5a5 5 0 0 1 10 0V11"/><circle cx="12" cy="17" r="1.4" fill="${fill}" stroke="none"/></g>`;
const eyeOff = (x, y, k, stroke) => `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7c2 0 3.8.7 5.3 1.7M22 12s-3.6 7-10 7c-2 0-3.8-.7-5.3-1.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></g>`;

// One card as SVG text.
async function svg(c, s) {
  const pad = 72;
  const parts = [];
  // Background: the site's near-black, a soft glow in the accent colour and a thin accent rule on top.
  parts.push(`<defs><radialGradient id="glow" cx="0.82" cy="0.05" r="0.9"><stop offset="0" stop-color="${s.accent}" stop-opacity="0.22"/><stop offset="0.55" stop-color="${s.accent}" stop-opacity="0.03"/><stop offset="1" stop-color="${s.accent}" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.35"/></linearGradient></defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="${s.ink}"/><rect width="${W}" height="${H}" fill="url(#glow)"/><rect width="${W}" height="${H}" fill="url(#fade)"/><rect width="${W}" height="8" fill="${s.accent}"/>`);
  // Top row: the brand, with its last word in the accent colour, and the badge.
  const cut = s.brand.lastIndexOf(' ');
  parts.push(`<text x="${pad}" y="104" font-family="${DISPLAY}" font-weight="900" font-size="46" letter-spacing="1" fill="${s.fg}">${esc((cut > 0 ? s.brand.slice(0, cut + 1) : s.brand).toUpperCase())}<tspan fill="${s.accent}">${esc(cut > 0 ? s.brand.slice(cut + 1).toUpperCase() : '')}</tspan></text>`);
  const badge = 'NO SCORES · NO SPOILERS', bw = 404, bx = W - pad - bw;
  parts.push(`<rect x="${bx}" y="62" width="${bw}" height="56" rx="28" fill="${s.accent}" fill-opacity="0.14" stroke="${s.accent}" stroke-opacity="0.75" stroke-width="2"/>`
    + eyeOff(bx + 22, 76, 1.15, s.accent)
    + `<text x="${bx + 64}" y="99" font-family="${BODY}" font-weight="700" font-size="22" letter-spacing="1.5" fill="${s.fg}">${badge}</text>`);

  const foot = (text, y = H - 70) => `<text x="${pad}" y="${y}" font-family="${BODY}" font-weight="500" font-size="28" fill="${s.muted}">${esc(text)}</text>`;
  const footLine = arr => arr.filter(Boolean).join('  ·  ');

  if (c.kind === 'match') {
    // Two teams, logos big, names under them, VS between.
    const a = await image(s.root, c.a.logo), b = await image(s.root, c.b.logo);
    const L = 210, cy = 268, ax = 330, bx2 = W - 330;
    const sz = h => isDark(h) ? L * 0.74 : L; // a logo on a disc is drawn a little smaller to fit it
    parts.push(a ? plate(a, ax, cy, L * 0.82, s) + logoAt(a, ax - sz(a) / 2, cy - sz(a) / 2, sz(a)) : initials(c.a.name, ax, cy, L, s));
    parts.push(b ? plate(b, bx2, cy, L * 0.82, s) + logoAt(b, bx2 - sz(b) / 2, cy - sz(b) / 2, sz(b)) : initials(c.b.name, bx2, cy, L, s));
    parts.push(`<text x="${W / 2}" y="${cy + 30}" text-anchor="middle" font-family="${DISPLAY}" font-weight="900" font-size="88" fill="${s.accent}">VS</text>`);
    for (const [t, x] of [[c.a.name, ax], [c.b.name, bx2]])
      parts.push(textBlock(t, x, 432, { sizes: [52, 46, 40, 34], width: 400, max: 1, font: DISPLAY, weight: 800, fill: s.fg, anchor: 'middle', upper: true, spacing: 0.5 }).svg);
    parts.push(textBlock(c.event, pad, 505, { sizes: [34, 30, 26], width: W - pad * 2, max: 1, font: BODY, weight: 700, fill: s.soft, wide: BODY_W }).svg);
    parts.push(foot(footLine(c.line)));
  } else if (c.kind === 'hidden') {
    // Hidden round: a lock and the round, never the teams. The event's logo shows it's a real link.
    const ev = await image(s.root, c.logo);
    parts.push(`<circle cx="${pad + 95}" cy="292" r="95" fill="${s.accent}" fill-opacity="0.12" stroke="${s.accent}" stroke-opacity="0.5" stroke-width="2"/>` + lockIcon(pad + 95, 292, 4.4, s.accent));
    const x = pad + 240, w = W - x - pad - (ev ? 150 : 0);
    parts.push(`<text x="${x}" y="206" font-family="${BODY}" font-weight="700" font-size="26" letter-spacing="2" fill="${s.accent}">MATCHUP HIDDEN</text>`);
    // One line if it fits, otherwise two smaller ones, so it never runs into the event's name.
    const one = fit(c.title, [92, 80, 68], w, 1, DISPLAY_W);
    const oneFits = lines(c.title, one, w, 9).length === 1;
    const t = textBlock(c.title, x, oneFits ? 302 : 280, { size: oneFits ? one : 58, width: w, max: 2, font: DISPLAY, weight: 900, fill: s.fg, upper: true, lh: 0.95 });
    parts.push(t.svg);
    parts.push(textBlock('The teams stay hidden until you open the round.', x, t.bottom + 50, { size: 28, width: W - x - pad, max: 1, font: BODY, weight: 500, fill: s.soft, wide: BODY_W }).svg);
    if (ev) parts.push(logoAt(ev, W - pad - 130, 210, 130));
    parts.push(textBlock(c.event, pad, 505, { sizes: [34, 30, 26], width: W - pad * 2, max: 1, font: BODY, weight: 700, fill: s.soft, wide: BODY_W }).svg);
    parts.push(foot(footLine(c.line)));
  } else {
    // An event, a team or the home page: a logo on the left (if there is one) and the name.
    const lg = await image(s.root, c.logo);
    const L = 250, x = lg || c.kind === 'team' ? pad + L + 56 : pad, w = W - x - pad;
    if (lg) parts.push(`<rect x="${pad}" y="${290 - L / 2 - 4}" width="${L}" height="${L}" rx="28" fill="${isDark(lg) ? s.fg : '#fff'}" fill-opacity="${isDark(lg) ? 1 : 0.04}"/>` + logoAt(lg, pad + 20, 290 - L / 2 + 16, L - 40));
    else if (c.kind === 'team') parts.push(initials(c.title, pad + L / 2, 286, L, s));
    const ty = c.kind === 'home' ? 318 : 300;
    const ts = fit(c.title, c.kind === 'home' ? [120, 108, 96, 84] : [96, 84, 72, 62, 54], w, c.kind === 'home' ? 1 : 2, DISPLAY_W);
    if (c.eyebrow) parts.push(`<text x="${x}" y="${Math.round(ty - ts * 0.78 - 26)}" font-family="${BODY}" font-weight="700" font-size="26" letter-spacing="2" fill="${s.accent}">${esc(c.eyebrow.toUpperCase())}</text>`);
    const t = textBlock(c.title, x, ty, { size: ts, width: w, max: c.kind === 'home' ? 1 : 2, font: DISPLAY, weight: 900, fill: s.fg, upper: true, lh: 0.95 });
    parts.push(t.svg);
    if (c.sub) parts.push(textBlock(c.sub, x, t.bottom + 58, { size: 30, width: w, max: 2, font: BODY, weight: 500, fill: s.soft, wide: BODY_W, lh: 1.3 }).svg);
    if (c.line && c.line.length) parts.push(foot(footLine(c.line)));
    // The home card lists the promises, as the home page does.
    if (c.chips) {
      let cx = pad;
      for (const chip of c.chips) {
        const cw = Math.round(chip.length * 13.5 + 48);
        parts.push(`<rect x="${cx}" y="500" width="${cw}" height="52" rx="26" fill="#fff" fill-opacity="0.06" stroke="#fff" stroke-opacity="0.12"/><text x="${cx + cw / 2}" y="534" text-anchor="middle" font-family="${BODY}" font-weight="700" font-size="23" fill="${s.fg}">${esc(chip)}</text>`);
        cx += cw + 14;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

// Draws every card into <out>/<card.file>. Returns the files drawn, or null when resvg isn't installed.
export async function drawCards(cards, s) {
  let Resvg;
  try { ({ Resvg } = await import('@resvg/resvg-js')); R = Resvg; } catch (e) {
    console.log('Link previews: @resvg/resvg-js isn’t installed, so pages use the logo as their preview.');
    return null;
  }
  const fontFiles = await fonts();
  const done = new Set();
  for (const c of cards) {
    try {
      const png = new Resvg(await svg(c, s), { fitTo: { mode: 'width', value: W }, font: { fontFiles, loadSystemFonts: !fontFiles.length, defaultFontFamily: 'Figtree' } }).render().asPng();
      await mkdir(path.dirname(path.join(s.out, c.file)), { recursive: true });
      await writeFile(path.join(s.out, c.file), png);
      done.add(c.file);
    } catch (e) { console.log('Link previews: couldn’t draw ' + c.file + ': ' + e.message); }
  }
  console.log('Link previews: ' + done.size + ' pictures in ' + path.join(s.out, 'og'));
  return done;
}
