// Builds the compact JSON files the page loads from data-src/ and ccfddl.
//
//   data/conferences.json  ccfddl deadlines + acceptance rates (snapshot)
//   data/ccf-list.json     CCF recommended list, with JCR / CAS cross-reference
//   data/journals.json     JCR + CAS partitions, with CCF level cross-reference
//   data/meta.json         versions and build dates shown on the page
//
// Usage: node scripts/build-data.mjs [--offline]
// --offline skips the ccfddl download and keeps the existing conference snapshot.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import * as XLSX from 'xlsx';
import { conferenceKeys, createJournalIndex, findJournal, parseCcfList, processConferences } from '../assets/lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data-src');
const OUT = join(ROOT, 'data');

// Edit these when a new edition of a source file lands in data-src/.
const SOURCES = {
  ccfList: { file: 'ccf-2026.md', version: '2026' },
  jcr: { file: 'jcr.xlsx', jcrSheet: 0, casSheet: 1, jcrVersion: '2024', casVersion: '2025' }
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

function readJournals() {
  const wb = XLSX.read(readFileSync(join(SRC, SOURCES.jcr.file)), { type: 'buffer' });
  const sheet = (i) => XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { defval: '' });
  const jifKey = `${SOURCES.jcr.jcrVersion}JIF`;
  const casKey = `${SOURCES.jcr.casVersion}分区`;

  const journals = sheet(SOURCES.jcr.jcrSheet).map((r) => {
    const jifRaw = String(r[jifKey] ?? '').trim();
    const jif = parseFloat(jifRaw);
    return {
      name: String(r['期刊名'] || '').trim(),
      issn: String(r.ISSN || '').trim(),
      eissn: String(r.eISSN || '').trim(),
      category: String(r.Category || '').trim(),
      // "<0.1" style values sort as 0 but keep their label.
      jif: Number.isFinite(jif) ? jif : jifRaw.startsWith('<') ? 0 : null,
      jifLabel: jifRaw && jifRaw !== 'N/A' ? jifRaw : '',
      quartile: /^Q[1-4]$/.test(r.Quartile) ? r.Quartile : '',
      rank: String(r['JIF rank'] || '').trim()
    };
  }).filter((j) => j.name);

  const casRows = sheet(SOURCES.jcr.casSheet).filter((r) => r['期刊名称']);
  const casIndex = createJournalIndex(casRows.map((r) => r['期刊名称']));
  let casMatched = 0;
  for (const j of journals) {
    const i = findJournal(casIndex, j.name);
    if (i < 0) continue;
    const zone = Number(casRows[i][casKey]);
    if (!zone) continue;
    j.cas = zone;
    j.casTop = casRows[i].Top === '是';
    casMatched++;
  }
  console.log(`[build] journals: ${journals.length} JCR rows, ${casMatched} matched to CAS ${SOURCES.jcr.casVersion}`);
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
  item.jif = j.jifLabel;
  item.quartile = j.quartile;
  if (j.cas) {
    item.cas = j.cas;
    item.casTop = j.casTop;
  }
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
const categories = [...new Set(journals.flatMap((j) => j.category.split(';').filter(Boolean)))].sort();
const catIndex = new Map(categories.map((c, i) => [c, i]));
writeJson('journals.json', {
  fields: ['name', 'issn', 'eissn', 'categories', 'jif', 'quartile', 'rank', 'cas', 'casTop', 'ccf'],
  categories,
  rows: journals.map((j) => [
    j.name, j.issn, j.eissn,
    j.category.split(';').filter(Boolean).map((c) => catIndex.get(c)),
    j.jifLabel, j.quartile, j.rank, j.cas || 0, j.casTop ? 1 : 0, j.ccf || ''
  ])
});
writeJson('meta.json', {
  built: today,
  conferencesUpdated: conferences.updated,
  ccfListVersion: SOURCES.ccfList.version,
  jcrVersion: SOURCES.jcr.jcrVersion,
  casVersion: SOURCES.jcr.casVersion
});
