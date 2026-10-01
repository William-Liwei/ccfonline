import {
  conferenceKeys, esc, formatCountdown, formatInZone, parseTimezone, pickDeadline, processConferences, safeUrl, wallTimeToUtc
} from './lib.js';

const PAGE_SIZE = 50;
const CONF_CACHE_KEY = 'ccfonline-conferences-v3';
const LEGACY_CACHE_KEYS = ['conferenceData_v2', 'acceptanceRateData_v2', 'lastUpdate_v2'];
const STALE_MS = 24 * 3600 * 1000;
const CCFDDL_MIRRORS = [
  'https://ccfddl.com/conference',
  'https://raw.githubusercontent.com/ccfddl/ccfddl.github.io/page/conference'
];
const BEIJING = { zone: 'Asia/Shanghai' };

const SUB_NAMES = {
  AI: '人工智能', CG: '计算机图形学与多媒体', CT: '计算机科学理论', DB: '数据库/数据挖掘/内容检索',
  DS: '计算机体系结构/并行与分布计算/存储系统', HI: '人机交互与普适计算', MX: '交叉/综合/新兴',
  NW: '计算机网络', SC: '网络与信息安全', SE: '软件工程/系统软件/程序设计语言'
};
const RANK_ORDER = { A: 0, B: 1, C: 2, N: 3 };

const $ = (sel) => document.querySelector(sel);

// ---------- Data ----------

const data = { meta: null, conf: null, confUpdated: null, confNext: new Map(), ccf: null, ccfLevels: new Map(), jcr: null };
const pending = {};

function once(key, fn) {
  pending[key] ||= fn().catch((err) => {
    delete pending[key];
    throw err;
  });
  return pending[key];
}

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const loadMeta = () => once('meta', async () => {
  data.meta = await getJson('data/meta.json');
});

const loadCcfList = () => once('ccf', async () => {
  const rows = await getJson('data/ccf-list.json');
  data.ccf = rows.map((r) => ({ ...r, _s: `${r.name} ${r.full} ${r.publisher}`.toLowerCase() }));
  for (const r of rows) {
    if (r.type === '会议') for (const k of conferenceKeys(r.name, r.dblp)) data.ccfLevels.set(k, r.level);
  }
});

const loadJournals = () => once('jcr', async () => {
  const json = await getJson('data/journals.json');
  data.jcrCategories = json.categories;
  data.jcr = json.rows.map((row) => {
    const j = {};
    json.fields.forEach((field, i) => { j[field] = row[i]; });
    j.categories = j.categories.map((i) => json.categories[i]);
    const jif = parseFloat(j.jif);
    j.jifNum = Number.isFinite(jif) ? jif : j.jif.startsWith('<') ? 0 : null;
    j._s = `${j.name} ${j.issn} ${j.eissn}`.toLowerCase();
    return j;
  });
});

function readCachedConferences() {
  try {
    const cached = JSON.parse(localStorage.getItem(CONF_CACHE_KEY));
    return cached?.updated && Array.isArray(cached.rows) ? cached : null;
  } catch {
    return null;
  }
}

function setConferences(snapshot) {
  data.confUpdated = snapshot.updated;
  const latestYear = new Map();
  for (const r of snapshot.rows) latestYear.set(r.title, Math.max(latestYear.get(r.title) ?? 0, r.year ?? 0));
  data.conf = snapshot.rows.map((r) => {
    const rank = r.rank && r.rank !== 'N' ? r.rank
      : conferenceKeys(r.title, r.dblp).map((k) => data.ccfLevels.get(k)).find(Boolean) || 'N';
    return { ...r, rank, latest: (r.year ?? 0) === latestYear.get(r.title), _s: `${r.title} ${r.description}`.toLowerCase() };
  });
  refreshDeadlines();
}

// Recomputes "next deadline" per edition and per conference title (used by the CCF list tab).
function refreshDeadlines() {
  if (!data.conf) return;
  const now = Date.now();
  data.confNext = new Map();
  for (const r of data.conf) {
    r.dl = pickDeadline(r.timeline, now);
    if (!r.dl || r.dl.status === 'passed') continue;
    for (const key of conferenceKeys(r.title, r.dblp)) {
      const current = data.confNext.get(key);
      if (!current || r.dl.deadline < current.deadline) data.confNext.set(key, { ...r.dl, year: r.year });
    }
  }
}

const loadConferences = () => once('conf', async () => {
  await loadCcfList().catch(() => {}); // only used to fill missing CCF levels
  const snapshot = await getJson('data/conferences.json');
  const cached = readCachedConferences();
  const best = cached && Date.parse(cached.updated) > Date.parse(snapshot.updated) ? cached : snapshot;
  setConferences(best);
  if (Date.now() - Date.parse(best.updated) > STALE_MS) refreshConferences({ silent: true });
});

async function fetchCcfddl() {
  const { load } = await import('./vendor/js-yaml.js');
  const options = typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(20000), cache: 'no-cache' } : { cache: 'no-cache' };
  let lastError;
  for (const base of CCFDDL_MIRRORS) {
    try {
      const [confText, accText] = await Promise.all(['allconf.yml', 'allacc.yml'].map(async (file) => {
        const res = await fetch(`${base}/${file}`, options);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      }));
      const rows = processConferences(load(confText), load(accText));
      if (rows.length < 100) throw new Error('数据不完整');
      return { updated: new Date().toISOString(), rows };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

let refreshing = false;
async function refreshConferences({ silent = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  const btn = $('#refresh-btn');
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const snapshot = await fetchCcfddl();
    setConferences(snapshot);
    try {
      localStorage.setItem(CONF_CACHE_KEY, JSON.stringify(snapshot));
    } catch {
      // Storage full or disabled: the fresh data still applies to this visit.
    }
    if (state.tab !== 'jcr') render();
    if (!silent) toast(`已更新，共 ${snapshot.rows.length} 条会议记录`);
  } catch (err) {
    if (!silent) toast(`更新失败（${err.message || '网络错误'}），继续使用当前数据`);
  } finally {
    refreshing = false;
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

// ---------- Tab definitions ----------

const rankBadge = (rank) => `<span class="rank rank-${esc(rank || 'N')}">${rank && rank !== 'N' ? esc(rank) : '—'}</span>`;
const sub = (text) => (text ? `<span class="cell-sub">${text}</span>` : '');

function deadlineZone(mode, row) {
  if (mode === 'local') return null;
  if (mode === 'orig') return parseTimezone(row.timezone);
  return BEIJING;
}

function deadlineCell(row) {
  const d = row.dl;
  if (!d) return '<span class="muted">待公布</span>';
  const mode = state.filters.conf.tz;
  const zone = deadlineZone(mode, row);
  const suffix = mode === 'orig' ? ` <span class="muted">${esc(row.timezone)}</span>` : '';
  const notes = [d.rounds > 1 ? `共 ${d.rounds} 轮` : '', d.comment].filter(Boolean).join(' · ');
  return `<div class="deadline status-${d.status}">`
    + `<time datetime="${new Date(d.deadline).toISOString()}">${esc(formatInZone(d.deadline, zone, true))}</time>${suffix}`
    + `<span class="countdown">${esc(formatCountdown(d.deadline))}</span>`
    + (d.abstract ? sub(`摘要 ${esc(formatInZone(d.abstract, zone))}`) : '')
    + (notes ? sub(esc(notes)) : '')
    + '</div>';
}

function acceptanceCell(row) {
  const a = row.acceptance;
  if (!a) return '<span class="muted">—</span>';
  return `<span title="${esc(a.str)}">${(a.rate * 100).toFixed(1)}%</span>${sub(`${esc(a.year)} 年`)}`;
}

function journalMetrics(j, versions) {
  const tags = [];
  if (j.jif) tags.push(`<span class="tag" title="JCR ${esc(versions.jcrVersion)} 影响因子">IF ${esc(j.jif)}</span>`);
  if (j.quartile) tags.push(`<span class="tag">${esc(j.quartile)}</span>`);
  if (j.cas) tags.push(`<span class="tag" title="中科院分区 ${esc(versions.casVersion)}">中科院 ${esc(j.cas)} 区</span>`);
  if (j.casTop) tags.push('<span class="tag tag-top">Top</span>');
  return tags.join('');
}

const copyBtn = (i) => `<button type="button" class="row-btn" data-copy="${i}">复制</button>`;

const TABS = {
  conf: {
    placeholder: '搜索会议简称或全称，如 KDD、NeurIPS',
    load: loadConferences,
    defaultSort: { key: 'deadline', dir: 'asc' },
    filters: [
      { key: 'sub', label: '领域', options: () => Object.entries(SUB_NAMES) },
      { key: 'rank', label: 'CCF 等级', options: () => [['A', 'A 类'], ['B', 'B 类'], ['C', 'C 类'], ['N', '非 CCF']] },
      { key: 'status', label: '截稿状态', options: () => [['open', '未截稿'], ['week', '7 天内截稿'], ['month', '30 天内截稿'], ['passed', '已截稿'], ['tbd', '待公布']] },
      { key: 'tz', label: '截稿时间显示为', def: 'bj', noAll: true, options: () => [['bj', '北京时间'], ['local', '本机时区'], ['orig', '会议原时区']] },
      { key: 'latest', label: '只看每个会议最新一届', type: 'check', def: '1' }
    ],
    match(r, f) {
      if (f.sub !== 'all' && r.sub !== f.sub) return false;
      if (f.rank !== 'all' && r.rank !== f.rank) return false;
      if (f.latest === '1' && !r.latest) return false;
      const s = r.dl?.status;
      switch (f.status) {
        case 'open': return !!r.dl && s !== 'passed';
        case 'week': return s === 'urgent';
        case 'month': return s === 'urgent' || s === 'warning';
        case 'passed': return s === 'passed';
        case 'tbd': return !r.dl;
        default: return true;
      }
    },
    sortValue: {
      title: (r) => r.title.toLowerCase(),
      rank: (r) => RANK_ORDER[r.rank] ?? 3,
      acc: (r) => r.acceptance?.rate ?? null
    },
    columns: [
      { label: '会议', sort: 'title', cls: 'cell-title', render: (r) => {
        const url = safeUrl(r.link);
        const name = `${esc(r.title)} ${esc(r.year ?? '')}`;
        return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${name}</a>` : name;
      } },
      { label: '全称', cls: 'cell-full', render: (r) => `${esc(r.description)}${sub(esc([r.date, r.place].filter(Boolean).join(' · ')))}` },
      { label: 'CCF', sort: 'rank', render: (r) => rankBadge(r.rank) },
      { label: '领域', render: (r) => esc(SUB_NAMES[r.sub] || r.sub) },
      { label: '截稿时间', sort: 'deadline', render: deadlineCell },
      { label: '录用率', sort: 'acc', render: acceptanceCell },
      { label: '', render: (r, i) => copyBtn(i) }
    ],
    copyText(r) {
      const d = r.dl;
      const lines = [`${r.title} ${r.year ?? ''}（CCF ${r.rank !== 'N' ? r.rank : '未收录'}）`, r.description];
      if (d) lines.push(`截稿：${formatInZone(d.deadline, BEIJING)} 北京时间（${formatInZone(d.deadline, parseTimezone(r.timezone))} ${r.timezone}）`);
      else lines.push('截稿：待公布');
      if (r.date || r.place) lines.push(`会议：${[r.date, r.place].filter(Boolean).join(' · ')}`);
      if (r.acceptance) lines.push(`录用率：${(r.acceptance.rate * 100).toFixed(1)}%（${r.acceptance.year}）`);
      if (safeUrl(r.link)) lines.push(r.link);
      return lines.join('\n');
    },
    note: () => (data.confUpdated ? `会议数据更新于 ${formatInZone(Date.parse(data.confUpdated), null)} · 来源 ccfddl` : '')
  },

  ccf: {
    placeholder: '搜索简称、全称或出版社',
    load: () => Promise.all([loadCcfList(), loadMeta(), loadConferences().catch(() => {})]),
    defaultSort: null,
    filters: [
      { key: 'cat', label: '领域', options: () => unique(data.ccf, 'category') },
      { key: 'type', label: '类型', options: () => [['期刊', '期刊'], ['会议', '会议']] },
      { key: 'level', label: '级别', options: () => [['A', 'A 类'], ['B', 'B 类'], ['C', 'C 类']] },
      { key: 'pub', label: '出版社', options: () => unique(data.ccf, 'publisher') }
    ],
    match: (r, f) => (f.cat === 'all' || r.category === f.cat) && (f.type === 'all' || r.type === f.type)
      && (f.level === 'all' || r.level === f.level) && (f.pub === 'all' || r.publisher === f.pub),
    sortValue: {
      name: (r) => (r.name || r.full).toLowerCase(),
      level: (r) => RANK_ORDER[r.level] ?? 3
    },
    columns: [
      { label: '简称', sort: 'name', cls: 'cell-title', render: (r) => esc(r.name) || '<span class="muted">—</span>' },
      { label: '全称', cls: 'cell-full', render: (r) => {
        const url = safeUrl(r.url);
        return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(r.full)}</a>` : esc(r.full);
      } },
      { label: '级别', sort: 'level', render: (r) => rankBadge(r.level) },
      { label: '类型', render: (r) => esc(r.type) },
      { label: '领域', render: (r) => esc(r.category) },
      { label: '出版社', render: (r) => esc(r.publisher) },
      { label: '指标 / 截稿', render: (r) => {
        if (r.type === '期刊') return journalMetrics(r, data.meta || {}) || '<span class="muted">未收录于 JCR</span>';
        const next = conferenceKeys(r.name, r.dblp).map((k) => data.confNext.get(k)).find(Boolean);
        if (!next) return '<span class="muted">—</span>';
        return `<div class="deadline status-${next.status}"><time>${esc(formatInZone(next.deadline, BEIJING))}</time>`
          + `<span class="countdown">${esc(next.year)} · ${esc(formatCountdown(next.deadline))}</span></div>`;
      } },
      { label: '', render: (r, i) => copyBtn(i) }
    ],
    copyText(r) {
      const lines = [[r.name, r.full].filter(Boolean).join(' - '), `CCF ${r.level} 类${r.type} · ${r.category}`, `出版社：${r.publisher}`];
      if (r.type === '期刊' && r.jif) {
        const m = data.meta || {};
        lines.push(`JCR ${m.jcrVersion}：IF ${r.jif}${r.quartile ? `，${r.quartile}` : ''}`);
        if (r.cas) lines.push(`中科院 ${m.casVersion}：${r.cas} 区${r.casTop ? ' Top' : ''}`);
      }
      if (safeUrl(r.url)) lines.push(r.url);
      return lines.join('\n');
    },
    note: () => (data.meta ? `CCF 推荐目录 ${data.meta.ccfListVersion} 版 · 期刊指标：JCR ${data.meta.jcrVersion} / 中科院分区 ${data.meta.casVersion}` : '')
  },

  jcr: {
    placeholder: '搜索期刊名或 ISSN',
    load: () => Promise.all([loadJournals(), loadMeta()]),
    defaultSort: { key: 'jif', dir: 'desc' },
    filters: [
      { key: 'jcat', label: 'JCR 学科', options: () => data.jcrCategories.map((c) => [c, c]) },
      { key: 'jif', label: '影响因子', options: () => [['10', '≥ 10'], ['5', '5 – 10'], ['3', '3 – 5'], ['0', '< 3']] },
      { key: 'quart', label: 'JCR 分区', options: () => ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => [q, q]) },
      { key: 'cas', label: '中科院分区', options: () => [1, 2, 3, 4].map((z) => [String(z), `${z} 区`]) },
      { key: 'ccf', label: 'CCF 推荐', options: () => [['any', 'CCF 收录'], ['A', 'A 类'], ['B', 'B 类'], ['C', 'C 类']] },
      { key: 'top', label: '只看中科院 Top', type: 'check', def: '0' }
    ],
    match(j, f) {
      if (f.jcat !== 'all' && !j.categories.includes(f.jcat)) return false;
      if (f.quart !== 'all' && j.quartile !== f.quart) return false;
      if (f.cas !== 'all' && String(j.cas) !== f.cas) return false;
      if (f.top === '1' && !j.casTop) return false;
      if (f.ccf === 'any' && !j.ccf) return false;
      if (f.ccf !== 'all' && f.ccf !== 'any' && j.ccf !== f.ccf) return false;
      if (f.jif !== 'all') {
        const v = j.jifNum;
        if (v == null) return false;
        const ranges = { 10: [10, Infinity], 5: [5, 10], 3: [3, 5], 0: [0, 3] };
        const [lo, hi] = ranges[f.jif] || [-Infinity, Infinity];
        if (v < lo || v >= hi) return false;
      }
      return true;
    },
    sortValue: {
      name: (j) => j.name.toLowerCase(),
      jif: (j) => j.jifNum,
      quart: (j) => (j.quartile ? Number(j.quartile[1]) : null),
      cas: (j) => j.cas || null,
      ccf: (j) => (j.ccf ? RANK_ORDER[j.ccf] : null)
    },
    columns: [
      { label: '期刊', sort: 'name', cls: 'cell-full', render: (j) => `<strong>${esc(j.name)}</strong>${sub(`<span class="mono">${esc([j.issn, j.eissn].filter(Boolean).join(' / '))}</span>`)}` },
      { label: 'JCR 学科', render: (j) => sub(esc(j.categories.join('；'))) },
      { label: '影响因子', sort: 'jif', render: (j) => (j.jif ? `<strong>${esc(j.jif)}</strong>${sub(esc(j.rank))}` : '<span class="muted">—</span>') },
      { label: 'JCR', sort: 'quart', render: (j) => (j.quartile ? `<span class="tag">${esc(j.quartile)}</span>` : '<span class="muted">—</span>') },
      { label: '中科院', sort: 'cas', render: (j) => (j.cas ? `<span class="tag">${esc(j.cas)} 区</span>${j.casTop ? '<span class="tag tag-top">Top</span>' : ''}` : '<span class="muted">—</span>') },
      { label: 'CCF', sort: 'ccf', render: (j) => (j.ccf ? rankBadge(j.ccf) : '<span class="muted">—</span>') },
      { label: '', render: (j, i) => copyBtn(i) }
    ],
    copyText(j) {
      const m = data.meta || {};
      const lines = [j.name, `ISSN ${j.issn || '—'} / eISSN ${j.eissn || '—'}`];
      if (j.jif) lines.push(`JCR ${m.jcrVersion}：IF ${j.jif}${j.quartile ? `，${j.quartile}` : ''}${j.rank ? `，学科排名 ${j.rank}` : ''}`);
      if (j.cas) lines.push(`中科院 ${m.casVersion}：${j.cas} 区${j.casTop ? ' Top' : ''}`);
      if (j.ccf) lines.push(`CCF 推荐：${j.ccf} 类`);
      return lines.join('\n');
    },
    note: () => (data.meta ? `JCR ${data.meta.jcrVersion} 年度影响因子 · 中科院分区 ${data.meta.casVersion} 版 · 共 ${data.jcr?.length ?? 0} 种期刊` : '')
  }
};

function unique(rows, key) {
  return [...new Set((rows || []).map((r) => r[key]).filter(Boolean))].map((v) => [v, v]);
}

// ---------- State & URL ----------

const state = { tab: 'conf', q: '', filters: {}, sort: {}, page: 1, view: [] };

function defaultFilters(tab) {
  return Object.fromEntries(TABS[tab].filters.map((f) => [f.key, f.def ?? 'all']));
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.tab = TABS[p.get('tab')] ? p.get('tab') : 'conf';
  state.q = p.get('q') || '';
  state.page = Math.max(1, Number(p.get('p')) || 1);
  for (const tab of Object.keys(TABS)) {
    state.filters[tab] = defaultFilters(tab);
    state.sort[tab] = TABS[tab].defaultSort;
  }
  const filters = state.filters[state.tab];
  for (const key of Object.keys(filters)) if (p.has(key)) filters[key] = p.get(key);
  const sortKey = p.get('sort');
  if (sortKey) state.sort[state.tab] = { key: sortKey, dir: p.get('dir') === 'desc' ? 'desc' : 'asc' };
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.tab !== 'conf') p.set('tab', state.tab);
  if (state.q) p.set('q', state.q);
  const defaults = defaultFilters(state.tab);
  for (const [key, value] of Object.entries(state.filters[state.tab])) if (value !== defaults[key]) p.set(key, value);
  const sort = state.sort[state.tab];
  const def = TABS[state.tab].defaultSort;
  if (sort && (sort.key !== def?.key || sort.dir !== def?.dir)) {
    p.set('sort', sort.key);
    p.set('dir', sort.dir);
  }
  if (state.page > 1) p.set('p', state.page);
  const qs = p.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
}

// ---------- Rendering ----------

function renderTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    const active = btn.dataset.tab === state.tab;
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  $('#panel').setAttribute('aria-labelledby', `tab-${state.tab}`);
  $('#search').placeholder = TABS[state.tab].placeholder;
  $('#search').value = state.q;
  $('#refresh-btn').hidden = state.tab !== 'conf';
}

function renderFilters() {
  const tab = TABS[state.tab];
  const values = state.filters[state.tab];
  $('#filters').innerHTML = tab.filters.map((f) => {
    const id = `f-${f.key}`;
    if (f.type === 'check') {
      return `<label class="check"><input type="checkbox" id="${id}" data-filter="${f.key}"${values[f.key] === '1' ? ' checked' : ''}>${esc(f.label)}</label>`;
    }
    const options = f.options();
    if (values[f.key] !== (f.def ?? 'all') && !options.some(([v]) => v === values[f.key])) values[f.key] = f.def ?? 'all';
    const all = f.noAll ? '' : '<option value="all">全部</option>';
    const opts = options.map(([v, label]) => `<option value="${esc(v)}"${v === values[f.key] ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<label for="${id}">${esc(f.label)}<select id="${id}" data-filter="${f.key}">${all}${opts}</select></label>`;
  }).join('');
}

function compareRows(tab, sort) {
  if (!sort) return null;
  const sign = sort.dir === 'desc' ? -1 : 1;
  if (tab === 'conf' && sort.key === 'deadline') {
    // asc: upcoming soonest first, then TBD, then passed (most recent first).
    const group = (r) => (!r.dl ? 1 : r.dl.status === 'passed' ? 2 : 0);
    return (a, b) => {
      if (sort.dir === 'asc') {
        const g = group(a) - group(b);
        if (g) return g;
        if (!a.dl) return 0;
        return group(a) === 2 ? b.dl.deadline - a.dl.deadline : a.dl.deadline - b.dl.deadline;
      }
      if (!a.dl || !b.dl) return (a.dl ? 0 : 1) - (b.dl ? 0 : 1);
      return b.dl.deadline - a.dl.deadline;
    };
  }
  const get = TABS[tab].sortValue[sort.key];
  if (!get) return null;
  return (a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va == null || vb == null) return (va == null) - (vb == null); // empty values always last
    return (va < vb ? -1 : va > vb ? 1 : 0) * sign;
  };
}

function computeView() {
  const tab = TABS[state.tab];
  const rows = data[state.tab] || [];
  const f = state.filters[state.tab];
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const view = rows.filter((r) => terms.every((t) => r._s.includes(t)) && tab.match(r, f));
  const cmp = compareRows(state.tab, state.sort[state.tab]);
  return cmp ? view.sort(cmp) : view;
}

function render() {
  const tab = TABS[state.tab];
  if (!data[state.tab]) return;
  state.view = computeView();
  const pages = Math.max(1, Math.ceil(state.view.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * PAGE_SIZE;
  const sort = state.sort[state.tab];

  $('#thead').innerHTML = `<tr>${tab.columns.map((c) => {
    if (!c.sort) return `<th scope="col">${c.label ? esc(c.label) : '<span class="visually-hidden">操作</span>'}</th>`;
    const aria = sort?.key === c.sort ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none';
    return `<th scope="col" aria-sort="${aria}"><button type="button" class="sort-btn" data-sort="${c.sort}">${esc(c.label)}</button></th>`;
  }).join('')}</tr>`;

  $('#tbody').innerHTML = state.view.slice(start, start + PAGE_SIZE).map((row, i) => `<tr>${tab.columns.map((c) => {
    const cls = c.cls ? ` class="${c.cls}"` : '';
    return `<td data-label="${esc(c.label)}"${cls}>${c.render(row, start + i)}</td>`;
  }).join('')}</tr>`).join('');

  $('#empty').hidden = state.view.length > 0;
  $('#loading').hidden = true;
  $('#result-count').textContent = `共 ${state.view.length} 条${pages > 1 ? `，第 ${state.page} / ${pages} 页` : ''}`;
  $('#data-note').textContent = tab.note();
  renderPagination(pages);
  writeUrl();
}

function renderPagination(pages) {
  const nav = $('#pagination');
  if (pages <= 1) {
    nav.innerHTML = '';
    return;
  }
  const p = state.page;
  const shown = [...new Set([1, p - 2, p - 1, p, p + 1, p + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  let html = `<button type="button" data-page="${p - 1}"${p === 1 ? ' disabled' : ''} aria-label="上一页">‹</button>`;
  shown.forEach((n, i) => {
    if (i && n - shown[i - 1] > 1) html += '<span class="gap">…</span>';
    html += `<button type="button" data-page="${n}"${n === p ? ' aria-current="page"' : ''}>${n}</button>`;
  });
  html += `<button type="button" data-page="${p + 1}"${p === pages ? ' disabled' : ''} aria-label="下一页">›</button>`;
  nav.innerHTML = html;
}

async function showTab(tab, { resetPage = true } = {}) {
  state.tab = tab;
  if (resetPage) state.page = 1;
  renderTabs();
  if (!data[tab]) {
    $('#thead').innerHTML = '';
    $('#tbody').innerHTML = '';
    $('#filters').innerHTML = '';
    $('#pagination').innerHTML = '';
    $('#result-count').textContent = '';
    $('#data-note').textContent = '';
    $('#empty').hidden = true;
    $('#loading').hidden = false;
    $('#loading').textContent = tab === 'jcr' ? '正在加载期刊数据（约 2 万种）…' : '正在加载数据…';
    try {
      await TABS[tab].load();
    } catch (err) {
      $('#loading').textContent = location.protocol === 'file:'
        ? '请通过本地服务器打开页面（npm run serve），直接打开文件无法加载数据。'
        : `数据加载失败：${err.message}。请刷新重试。`;
      return;
    }
    if (state.tab !== tab) return; // user switched tabs meanwhile
  }
  renderFilters();
  render();
}

// ---------- Utilities ----------

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('copy failed');
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Time zone tool ----------

const TZ_OPTIONS = [
  ['AoE', 'AoE（UTC−12）'], ['Asia/Shanghai', '北京'], ['UTC', 'UTC'],
  ['America/Los_Angeles', '洛杉矶 / 美西'], ['America/New_York', '纽约 / 美东'],
  ['Europe/London', '伦敦'], ['Europe/Paris', '巴黎 / 中欧'], ['Asia/Tokyo', '东京'],
  ['Asia/Seoul', '首尔'], ['Asia/Singapore', '新加坡'], ['Australia/Sydney', '悉尼'], ['Pacific/Honolulu', '檀香山']
];

function convertTime() {
  const from = $('#tz-from').value;
  const ms = wallTimeToUtc(`${$('#tz-date').value} ${$('#tz-time').value}`, from);
  if (ms == null) return;
  $('#tz-result').innerHTML = TZ_OPTIONS.map(([zone, label]) => `<li${zone === from ? ' class="is-source"' : ''}>`
    + `<span>${esc(label)}</span><strong>${esc(formatInZone(ms, parseTimezone(zone), true))}</strong></li>`).join('');
}

function initTimeTool() {
  $('#tz-from').innerHTML = TZ_OPTIONS.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  $('#tz-date').value = formatInZone(Date.now(), null).slice(0, 10);
  $('#tz-form').addEventListener('submit', (e) => {
    e.preventDefault();
    convertTime();
  });
  $('#tz-form').addEventListener('change', convertTime);
  convertTime();
}

// ---------- Events ----------

function bindEvents() {
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((btn, i) => {
    btn.addEventListener('click', () => btn.dataset.tab !== state.tab && showTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      showTab(next.dataset.tab);
    });
  });

  const onSearch = debounce(() => {
    state.q = $('#search').value.trim();
    state.page = 1;
    render();
  }, 150);
  $('#search').addEventListener('input', onSearch);

  $('#filters').addEventListener('change', (e) => {
    const key = e.target.dataset.filter;
    if (!key) return;
    state.filters[state.tab][key] = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value;
    state.page = 1;
    render();
  });

  $('#thead').addEventListener('click', (e) => {
    const key = e.target.closest('[data-sort]')?.dataset.sort;
    if (!key) return;
    const current = state.sort[state.tab];
    const dir = current?.key === key && current.dir === 'asc' ? 'desc' : 'asc';
    state.sort[state.tab] = { key, dir };
    state.page = 1;
    render();
  });

  $('#tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const row = state.view[Number(btn.dataset.copy)];
    if (!row) return;
    try {
      await copyText(TABS[state.tab].copyText(row));
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请检查浏览器权限');
    }
  });

  $('#pagination').addEventListener('click', (e) => {
    const page = Number(e.target.closest('[data-page]')?.dataset.page);
    if (!page) return;
    state.page = page;
    render();
    $('.tabs').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  $('#reset-btn').addEventListener('click', () => {
    state.q = '';
    state.filters[state.tab] = defaultFilters(state.tab);
    state.sort[state.tab] = TABS[state.tab].defaultSort;
    state.page = 1;
    $('#search').value = '';
    renderFilters();
    render();
  });

  $('#share-btn').addEventListener('click', async () => {
    try {
      await copyText(location.href);
      toast('链接已复制，打开后会保留当前筛选条件');
    } catch {
      toast('复制失败，请手动复制地址栏链接');
    }
  });

  $('#refresh-btn').addEventListener('click', () => refreshConferences());

  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('wl-theme', next);
    } catch {
      // Private mode: the toggle still works for this visit.
    }
  });

  // Keep countdowns current.
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !data.conf) return;
    refreshDeadlines();
    if (state.tab !== 'jcr' && !document.activeElement?.closest?.('#tbody')) render();
  }, 60 * 1000);
}

// ---------- Init ----------

try {
  LEGACY_CACHE_KEYS.forEach((k) => localStorage.removeItem(k));
} catch {
  // Storage disabled.
}
readUrl();
bindEvents();
initTimeTool();
showTab(state.tab, { resetPage: false });
