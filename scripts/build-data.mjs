// Builds the compact JSON files the page loads from data-src/ and ccfddl.
//
//   data/conferences.json  ccfddl deadlines + acceptance rates (snapshot)
//   data/ccf-list.json     CCF recommended list, with JCR / CAS cross-reference
//   data/journals.json     JCR + CAS + XR partitions, with CCF level cross-reference
//   data/meta.json         versions and build dates shown on the page
//
// Usage: node scripts/build-data.mjs [--offline]
// --offline skips the ccfddl download and keeps the existing conference snapshot.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { conferenceKeys, createJournalIndex, findJournal, parseCcfList, parseCsv, processConferences } from '../assets/lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data-src');
const OUT = join(ROOT, 'data');

// Edit these when a new edition lands in data-src/. Journal tables are the
// CSVs published by https://github.com/hitfyd/ShowJCR (folder
// 中科院分区表及JCR原始数据文件/, files JCR<year>-UTF8.csv, FQBJCR<year>-UTF8.csv,
// XR<year>-UTF8.csv); copy them in and bump the versions below.
const SOURCES = {
  ccfList: { file: 'ccf-2026.md', version: '2026' },
  // JCR "2025" = impact factors for 2025, released by Clarivate in June 2026.
  jcr: { file: 'jcr-2025.csv', version: '2025' },
  // 中科院分区表升级版 (fenqubiao.com). 2025 is the latest edition.
  cas: { file: 'cas-2025.csv', version: '2025' },
  // 新锐期刊分区表 (xr-scholar.com), published 2026-03-24.
  xr: { file: 'xr-2026.csv', version: '2026' }
};

// CCF journals whose name maps to several JCR entries (or to none under the
// CCF spelling): pin them by ISSN.
const ISSN_OVERRIDES = {
  'Journal of Computer Science and Technology': '1000-9000',
  // Renamed to "Journal of Computer Languages" in 2019.
  'Computer Languages, Systems and Structures': '2590-1184'
};
// Same files, two hosts; whichever answers first through the local network wins.
const CCFDDL_MIRRORS = [
  'https://raw.githubusercontent.com/ccfddl/ccfddl.github.io/page/conference',
  'https://ccfddl.com/conference'
];

const offline = process.argv.includes('--offline');
const today = new Date().toISOString().slice(0, 10);

const writeJson = (name, data) => {
  const file = join(OUT, name);
  writeFileSync(file, JSON.stringify(data));
  console.log(`[build] ${name} ${(readFileSync(file).length / 1024).toFixed(0)} KB`);
};

const readJson = (name) => {
  try {
    return JSON.parse(readFileSync(join(OUT, name), 'utf8'));
  } catch {
    return null;
  }
};

// Env proxy first, then the Windows system proxy (e.g. Clash), which curl ignores by default.
const findProxy = () => {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
  if (env) return env;
  if (process.platform !== 'win32') return null;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const out = execFileSync('reg', ['query', key], { encoding: 'utf8' });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) return null;
    const server = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
    return server ? `http://${server.replace(/^https?=|;.*$/g, '')}` : null;
  } catch {
    return null;
  }
};

const curl = (url, proxy) => {
  const args = ['-s', '-f', '-L', '-m', '60'];
  if (proxy) args.push('-x', proxy);
  args.push(url);
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
};

// Tries each mirror with the proxy, then without it.
const downloadCcfddl = (file) => {
  const proxy = findProxy();
  const errors = [];
  for (const base of CCFDDL_MIRRORS) {
    for (const p of proxy ? [proxy, null] : [null]) {
      try {
        return curl(`${base}/${file}`, p);
      } catch (err) {
        errors.push(`${base}${p ? ' (proxy)' : ''}: curl exit ${err.status}`);
      }
    }
  }
  throw new Error(`${file} unavailable; ${errors.join(', ')}`);
};

// ---------- Conferences ----------

function buildConferences() {
  const previous = readJson('conferences.json');
  if (offline) {
    if (!previous) throw new Error('--offline needs an existing data/conferences.json');
    console.log(`[build] conferences: offline, keeping snapshot from ${previous.updated}`);
    return previous;
  }
  try {
    const confs = yaml.load(downloadCcfddl('allconf.yml'));
    const accs = yaml.load(downloadCcfddl('allacc.yml'));
    const rows = processConferences(confs, accs);
    if (rows.length < 100) throw new Error(`only ${rows.length} rows, refusing to overwrite`);
    return { updated: new Date().toISOString(), rows };
  } catch (err) {
    if (!previous) throw err;
    console.warn(`[build] ccfddl download failed (${err.message}); keeping snapshot from ${previous.updated}`);
    return previous;
  }
}

// ---------- Journals ----------

const readCsv = (file) => parseCsv(readFileSync(join(SRC, file), 'utf8'));
const cleanIssn = (s) => (/^\d{4}-\d{3}[\dX]$/i.test(String(s).trim()) ? String(s).trim().toUpperCase() : '');
const zoneNumber = (s) => Number(String(s).match(/^\s*([1-4])/)?.[1] || 0);

// Looks rows up by ISSN / eISSN first, then by journal name.
function createLookup(rows, issnsOf, nameOf) {
  const byIssn = new Map();
  rows.forEach((r, i) => issnsOf(r).forEach((s) => byIssn.has(s) || byIssn.set(s, i)));
  const names = createJournalIndex(rows.map(nameOf));
  return (issns, name) => {
    for (const s of issns) if (byIssn.has(s)) return rows[byIssn.get(s)];
    const i = findJournal(names, name);
    return i < 0 ? null : rows[i];
  };
}

function readJournals() {
  const journals = readCsv(SOURCES.jcr.file).map((r) => {
    const jif = String(r[`IF(${SOURCES.jcr.version})`] || '').trim();
    const categories = [];
    let quartile = '';
    let rank = '';
    for (let n = 1; n <= 6; n++) {
      const cat = String(r[`Category_${n}`] || '').trim();
      if (!cat) continue;
      categories.push(cat);
      // A journal listed in several categories gets its best quartile.
      const q = String(r[`IF Quartile(${SOURCES.jcr.version})_${n}`] || '').trim();
      if (/^Q[1-4]$/.test(q) && (!quartile || q < quartile)) {
        quartile = q;
        rank = String(r[`IF Rank(${SOURCES.jcr.version})_${n}`] || '').trim();
      }
    }
    return {
      name: String(r.Journal || '').trim(),
      issn: cleanIssn(r.ISSN),
      eissn: cleanIssn(r.EISSN),
      categories,
      // "<0.1" keeps its label; "N/A" means no impact factor (e.g. new ESCI titles).
      jif: /^(<\s*)?\d/.test(jif) ? jif : '',
      quartile,
      rank
    };
  }).filter((j) => j.name);

  const casRows = readCsv(SOURCES.cas.file);
  const findCas = createLookup(
    casRows,
    (r) => String(r['ISSN/EISSN'] || '').split('/').map(cleanIssn).filter(Boolean),
    (r) => r.Journal
  );
  const xrRows = readCsv(SOURCES.xr.file);
  const findXr = createLookup(xrRows, (r) => [cleanIssn(r.ISSN), cleanIssn(r.EISSN)].filter(Boolean), (r) => r.Journal);

  let casMatched = 0;
  let xrMatched = 0;
  for (const j of journals) {
    const issns = [j.issn, j.eissn].filter(Boolean);
    const cas = findCas(issns, j.name);
    const casZone = cas && zoneNumber(cas['大类分区']);
    if (casZone) {
      j.cas = casZone;
      j.casTop = cas.Top === '是';
      casMatched++;
    }
    const xr = findXr(issns, j.name);
    const xrZone = xr && zoneNumber(xr['大类新锐分区']);
    if (xrZone) {
      j.xr = xrZone;
      j.xrTop = xr.Top === 'Top';
      j.xrWarn = String(xr['预警标记'] || '').trim() ? 1 : 0;
      xrMatched++;
    }
  }
  console.log(`[build] journals: ${journals.length} JCR ${SOURCES.jcr.version} rows, ${casMatched} in CAS ${SOURCES.cas.version}, ${xrMatched} in XR ${SOURCES.xr.version}`);
  return journals;
}

// ---------- Main ----------

mkdirSync(OUT, { recursive: true });

const conferences = buildConferences();
const journals = readJournals();
const ccfList = parseCcfList(readFileSync(join(SRC, SOURCES.ccfList.file), 'utf8'));

// Cross-reference CCF journals with JCR / CAS.
const journalIndex = createJournalIndex(journals.map((j) => j.name));
const byIssn = new Map();
journals.forEach((j, i) => [j.issn, j.eissn].filter(Boolean).forEach((s) => byIssn.set(s, i)));
let linked = 0;
const unmatched = [];
for (const item of ccfList) {
  if (item.type !== '期刊') continue;
  const pinned = ISSN_OVERRIDES[item.full];
  const i = pinned ? byIssn.get(pinned) ?? -1 : findJournal(journalIndex, item.full);
  if (i < 0) {
    unmatched.push(item.full);
    continue;
  }
  const j = journals[i];
  for (const key of ['jif', 'quartile', 'cas', 'casTop', 'xr', 'xrTop', 'xrWarn']) if (j[key]) item[key] = j[key];
  if (!j.ccf || j.ccf > item.level) j.ccf = item.level;
  linked++;
}
console.log(`[build] CCF list: ${ccfList.length} rows, ${linked} journals linked to JCR`);
if (unmatched.length) console.log(`[build] not in JCR (${unmatched.length}): ${unmatched.join('; ')}`);

// Conferences: attach the CCF list level when ccfddl has none.
const ccfConf = new Map();
for (const r of ccfList) {
  if (r.type === '会议') for (const k of conferenceKeys(r.name, r.dblp)) ccfConf.set(k, r.level);
}
for (const row of conferences.rows) {
  if (row.rank && row.rank !== 'N') continue;
  const level = conferenceKeys(row.title, row.dblp).map((k) => ccfConf.get(k)).find(Boolean);
  if (level) row.rank = level;
}

writeJson('conferences.json', conferences);
writeJson('ccf-list.json', ccfList);
// Journals are the bulk of the payload: store rows as arrays and categories
// as indexes into a shared list. assets/app.js (unpackJournals) reverses this.
const categories = [...new Set(journals.flatMap((j) => j.categories))].sort();
const catIndex = new Map(categories.map((c, i) => [c, i]));
writeJson('journals.json', {
  fields: ['name', 'issn', 'eissn', 'categories', 'jif', 'quartile', 'rank', 'cas', 'casTop', 'xr', 'xrTop', 'xrWarn', 'ccf'],
  categories,
  rows: journals.map((j) => [
    j.name, j.issn, j.eissn, j.categories.map((c) => catIndex.get(c)),
    j.jif, j.quartile, j.rank, j.cas || 0, j.casTop ? 1 : 0, j.xr || 0, j.xrTop ? 1 : 0, j.xrWarn || 0, j.ccf || ''
  ])
});
writeJson('meta.json', {
  built: today,
  conferencesUpdated: conferences.updated,
  ccfListVersion: SOURCES.ccfList.version,
  jcrVersion: SOURCES.jcr.version,
  casVersion: SOURCES.cas.version,
  xrVersion: SOURCES.xr.version
});
