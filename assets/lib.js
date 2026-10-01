// Pure helpers shared by the browser app (assets/app.js) and the Node build
// script (scripts/build-data.mjs). No DOM access here so it can be unit tested.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ---------- Time zones ----------

// Abbreviations seen in ccfddl data (plus common ones) that follow DST.
const NAMED_ZONES = {
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  CET: 'Europe/Paris', CEST: 'Europe/Paris', BST: 'Europe/London',
  JST: 'Asia/Tokyo', KST: 'Asia/Seoul'
};

// Returns { offset } (fixed hours from UTC) or { zone } (IANA name).
// Unknown or missing values fall back to AoE, the ccfddl default.
export function parseTimezone(tz) {
  const s = String(tz ?? '').trim();
  if (!s || /^aoe$/i.test(s)) return { offset: -12 };
  if (/^(utc|gmt|z)$/i.test(s)) return { offset: 0 };
  const m = s.match(/^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (m) return { offset: (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3] || 0) / 60) };
  const named = NAMED_ZONES[s.toUpperCase()];
  if (named) return { zone: named };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return { zone: s };
  } catch {
    return { offset: -12 };
  }
}

const dtfCache = new Map();
function zoneFormatter(zone) {
  if (!dtfCache.has(zone)) {
    dtfCache.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
  }
  return dtfCache.get(zone);
}

// Offset of an IANA zone from UTC at a given instant, in milliseconds.
export function zoneOffset(zone, utcMs) {
  const parts = {};
  for (const p of zoneFormatter(zone).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// "2026-09-30 23:59:59" + "AoE" -> UTC milliseconds. Date-only values mean end of day.
export function wallTimeToUtc(str, tz) {
  const m = String(str ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] == null ? 23 : +m[4], m[5] == null ? 59 : +m[5], m[6] == null ? 59 : +m[6]);
  const t = parseTimezone(tz);
  if (t.zone == null) return wall - t.offset * HOUR;
  // Two passes so wall times right after a DST switch resolve correctly.
  const guess = wall - zoneOffset(t.zone, wall);
  return wall - zoneOffset(t.zone, guess);
}

const fmtCache = new Map();
function formatter(locale, options) {
  const key = locale + JSON.stringify(options);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(locale, options));
  return fmtCache.get(key);
}

// UTC ms -> "2026-09-30 23:59" in a zone from parseTimezone(); null means the
// browser's own zone. withWeekday appends e.g. " 周三".
export function formatInZone(ms, spec, withWeekday = false) {
  if (ms == null) return '';
  let date = new Date(ms);
  let timeZone;
  if (spec?.zone) {
    timeZone = spec.zone;
  } else if (typeof spec?.offset === 'number') {
    date = new Date(ms + spec.offset * HOUR);
    timeZone = 'UTC';
  }
  const parts = {};
  const options = { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  for (const p of formatter('en-US', options).formatToParts(date)) parts[p.type] = p.value;
  const text = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return withWeekday ? `${text} ${formatter('zh-CN', { timeZone, weekday: 'short' }).format(date)}` : text;
}

// ---------- Deadlines ----------

export function deadlineStatus(ms, now = Date.now()) {
  if (ms == null) return 'unknown';
  const diff = ms - now;
  if (diff < 0) return 'passed';
  if (diff <= 7 * DAY) return 'urgent';
  if (diff <= 30 * DAY) return 'warning';
  return 'normal';
}

// Picks the next upcoming deadline of a conference edition; if every round has
// passed, the latest one. Returns null when no round has a parsable date.
export function pickDeadline(timeline, now = Date.now()) {
  const rounds = (timeline || []).filter((r) => r.deadline != null);
  if (!rounds.length) return null;
  const upcoming = rounds.filter((r) => r.deadline >= now).sort((a, b) => a.deadline - b.deadline);
  const round = upcoming[0] || rounds.reduce((a, b) => (b.deadline > a.deadline ? b : a));
  return { ...round, rounds: rounds.length, status: deadlineStatus(round.deadline, now) };
}

export function formatCountdown(ms, now = Date.now()) {
  if (ms == null) return '';
  const diff = ms - now;
  if (diff < 0) return '已截稿';
  const days = Math.floor(diff / DAY);
  const hours = Math.floor((diff % DAY) / HOUR);
  if (days > 0) return `还剩 ${days} 天 ${hours} 小时`;
  const minutes = Math.max(1, Math.floor((diff % HOUR) / 60000));
  return hours > 0 ? `还剩 ${hours} 小时 ${minutes} 分` : `还剩 ${minutes} 分钟`;
}

// ---------- Conference data (ccfddl allconf.yml / allacc.yml) ----------

function buildAcceptanceIndex(accList) {
  const index = new Map();
  for (const item of accList || []) {
    if (!item?.title || !Array.isArray(item.accept_rates)) continue;
    const rates = index.get(item.title) || [];
    for (const r of item.accept_rates) {
      if (r?.year != null && typeof r.rate === 'number') rates.push({ year: Number(r.year), rate: r.rate, str: r.str || '' });
    }
    index.set(item.title, rates.sort((a, b) => b.year - a.year));
  }
  return index;
}

// Flattens ccfddl YAML (already parsed) into one row per conference edition.
export function processConferences(confList, accList) {
  const acc = buildAcceptanceIndex(accList);
  const rows = [];
  for (const conf of confList || []) {
    if (!conf?.title || !Array.isArray(conf.confs)) continue;
    const rates = acc.get(conf.title) || [];
    for (const c of conf.confs) {
      const timeline = (c.timeline || []).map((t) => {
        const round = { deadline: wallTimeToUtc(t.deadline, c.timezone) };
        const abstract = wallTimeToUtc(t.abstract_deadline, c.timezone);
        if (abstract != null) round.abstract = abstract;
        if (t.comment) round.comment = String(t.comment);
        return round;
      });
      const rate = rates.find((r) => r.year === Number(c.year)) || rates[0] || null;
      rows.push({
        title: String(conf.title),
        dblp: String(conf.dblp || '').toLowerCase(),
        description: conf.description || '',
        sub: conf.sub || '',
        rank: conf.rank?.ccf || 'N',
        year: Number(c.year) || null,
        link: c.link || '',
        date: c.date || '',
        place: c.place || '',
        timezone: c.timezone || 'AoE',
        timeline,
        acceptance: rate
      });
    }
  }
  return rows;
}

// ---------- CCF recommended list (Markdown tables) ----------

export function parseCcfList(markdown) {
  const rows = [];
  let category = '';
  let type = '';
  let level = '';
  for (const rawLine of String(markdown).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('######')) {
      const m = line.match(/([ABC])\s*类/);
      if (m) level = m[1];
      continue;
    }
    if (line.startsWith('#####')) {
      const m = line.match(/[（(]([^）)]+)[）)]/);
      if (m) category = m[1].replace(/／/g, '/').replace(/\s+/g, '');
      type = line.includes('期刊') ? '期刊' : line.includes('会议') ? '会议' : type;
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((s) => s.trim());
    if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
    const row = {
      name: cells[1] || '',
      full: cells[2] || '',
      category, type, level,
      publisher: cells[3] || '',
      url: cells[4] || ''
    };
    const dblp = dblpKey(row.url);
    if (dblp) row.dblp = dblp;
    rows.push(row);
  }
  return rows;
}

// DBLP key from a CCF list URL such as https://dblp.org/db/conf/kdd/index.html.
export function dblpKey(url) {
  return (String(url ?? '').match(/\/db\/(?:conf|journals)\/([^/]+)/i)?.[1] || '').toLowerCase();
}

// Keys used to link a CCF list conference with ccfddl rows (which use different
// names for some, e.g. "SIGKDD" vs "KDD").
export function conferenceKeys(name, dblp) {
  return [nameKey(name) && `n:${nameKey(name)}`, dblp && `d:${dblp}`].filter(Boolean);
}

// ---------- Journal name matching ----------

// Strict key: case, accents, "&" vs "and" and punctuation are ignored
// (NFKD splits accents into combining marks, which the last replace drops).
export function nameKey(name) {
  return String(name ?? '').toLowerCase().normalize('NFKD')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '');
}

// Loose key: also drops function words, so "Transactions in/on X" or
// "Systems, Man, and Cybernetics" variants line up.
export function looseKey(name) {
  return String(name ?? '').toLowerCase().normalize('NFKD')
    .replace(/&/g, ' ').replace(/\b(the|and|of|on|in|for|an|a)\b/g, ' ').replace(/[^a-z0-9]+/g, '');
}

// Index for looking up journals by name. JCR often appends a suffix after "-"
// (e.g. "COMPUTERS & GRAPHICS-UK"), so the part before it is indexed too.
export function createJournalIndex(names) {
  const strict = new Map();
  const loose = new Map();
  const add = (map, key, i) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, i);
    else if (map.get(key) !== i) map.set(key, -1); // ambiguous
  };
  names.forEach((name, i) => {
    add(strict, nameKey(name), i);
    add(loose, looseKey(name), i);
  });
  names.forEach((name, i) => {
    const prefix = String(name).split(/\s*-\s*(?=[A-Za-z])/)[0];
    if (prefix !== name && prefix.split(/\s+/).length >= 2) {
      const k = nameKey(prefix);
      if (!strict.has(k)) strict.set(k, i);
      const lk = looseKey(prefix);
      if (!loose.has(lk)) loose.set(lk, i);
    }
  });
  return { strict, loose };
}

export function findJournal(index, name) {
  const candidates = [name];
  const beforeColon = String(name).split(':')[0];
  if (beforeColon !== name) candidates.push(beforeColon);
  for (const c of candidates) {
    for (const [map, key] of [[index.strict, nameKey(c)], [index.loose, looseKey(c)]]) {
      const i = map.get(key);
      if (i != null && i >= 0) return i;
    }
  }
  return -1;
}

// ---------- CSV ----------

// RFC 4180 CSV (quoted fields, "" escapes, embedded newlines) -> array of
// objects keyed by the header row. A leading BOM is ignored.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header = [], ...body] = rows;
  return body.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// ---------- Output helpers ----------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Only http(s) links from third-party data are rendered.
export function safeUrl(value) {
  const s = String(value ?? '').trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}
