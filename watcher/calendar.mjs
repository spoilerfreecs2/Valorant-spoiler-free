/*
  Calendar feeds (.ics) for the site's "Add to calendar" reminders.

  Each event gets calendar/<event-id>.ics with one all-day entry per match day, placed on
  the day after it ("Saturday's matches are ready to watch"), since videos usually come out
  within a day. Entries never name teams, so a calendar can't give away who went through.
  Match days come from Liquipedia's schedule, including matches whose teams aren't known
  yet, plus the event's last day. Calendar apps that subscribed pick up new days on their
  next refresh.

  calendar/all.ics holds every event that's on now or coming up.
*/

const str = v => (v === null || v === undefined) ? '' : String(v);
const arr = v => Array.isArray(v) ? v : [];
const DAY = 24 * 3600 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d);
const isoDay = t => new Date(t).toISOString().slice(0, 10);
const icsDate = d => d.replace(/-/g, '');
// A fixed time stamp, so the files only change when the schedule does.
const STAMP = '20260101T000000Z';

// Text values: backslash, semicolon, comma and newlines are escaped (RFC 5545 3.3.11).
const esc = s => str(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 bytes are folded onto continuation lines that start with a space.
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// The days an event has matches on (UTC): drawn matches, scheduled ones, and the event's last day.
export function matchDays(t, matches) {
  const days = new Set(arr(t.days).filter(isDay));
  for (const m of matches) { const at = Date.parse(m.time); if (at) days.add(isoDay(at)); }
  const sd = str(t.sdate).slice(0, 10), ed = str(t.edate).slice(0, 10) || sd;
  if (!days.size && isDay(sd)) days.add(sd);
  if (isDay(ed)) days.add(ed);
  return [...days].filter(d => !isDay(ed) || d <= ed).sort();
}

function vevents(t, days, siteUrl) {
  const url = siteUrl + '#/t/' + t.id;
  const last = str(t.edate).slice(0, 10);
  const out = [];
  for (const d of days) {
    const on = Date.parse(d + 'T00:00:00Z') + DAY;
    const which = d === last ? 'the final day' : WEEKDAYS[new Date(d + 'T00:00:00Z').getUTCDay()] + '’s matches';
    out.push('BEGIN:VEVENT',
      'UID:' + t.id + '-' + icsDate(d) + '@cs2-spoiler-free',
      'DTSTAMP:' + STAMP,
      'DTSTART;VALUE=DATE:' + icsDate(isoDay(on)),
      'DTEND;VALUE=DATE:' + icsDate(isoDay(on + DAY)),
      'SUMMARY:' + esc(t.name + ': ' + (d === last ? 'final day' : which) + ' ready to watch'),
      'DESCRIPTION:' + esc('Videos from ' + which + ' of ' + t.name + ' should be up by now. Watch spoiler-free: ' + url),
      'URL:' + url,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(t.name + ' is ready to watch'), 'TRIGGER:PT9H', 'END:VALARM',
      'END:VEVENT');
  }
  return out;
}

function wrap(name, lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Spoiler-Free CS2//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(name), 'X-WR-CALDESC:' + esc('When each day is ready to watch. No teams, no results.'),
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H', ...lines, 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}

// { 'calendar/<id>.ics': text, ..., 'calendar/all.ics': text }
export function buildCalendars(auto, siteUrl, now) {
  const files = {};
  const all = [];
  const today = isoDay(now.getTime());
  for (const t of auto.tournaments) {
    const days = matchDays(t, auto.matches.filter(m => m.tournamentId === t.id));
    if (!days.length) continue;
    const lines = vevents(t, days, siteUrl);
    files['calendar/' + t.id + '.ics'] = wrap(t.name + ' (spoiler-free)', lines);
    if ((str(t.edate).slice(0, 10) || str(t.sdate).slice(0, 10)) >= today) all.push(...lines);
  }
  files['calendar/all.ics'] = wrap('Spoiler-Free CS2', all);
  return files;
}
