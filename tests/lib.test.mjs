import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conferenceKeys, createJournalIndex, dblpKey, deadlineStatus, esc, findJournal, formatCountdown, formatInZone,
  parseCcfList, parseTimezone, pickDeadline, processConferences, safeUrl, wallTimeToUtc
} from '../assets/lib.js';

const H = 3600 * 1000;
const D = 24 * H;

test('parseTimezone handles AoE, offsets and named zones', () => {
  assert.deepEqual(parseTimezone('AoE'), { offset: -12 });
  assert.deepEqual(parseTimezone(undefined), { offset: -12 });
  assert.deepEqual(parseTimezone('UTC'), { offset: 0 });
  assert.deepEqual(parseTimezone('UTC-12'), { offset: -12 });
  assert.deepEqual(parseTimezone('UTC+8'), { offset: 8 });
  assert.deepEqual(parseTimezone('UTC+5:30'), { offset: 5.5 });
  assert.deepEqual(parseTimezone('PT'), { zone: 'America/Los_Angeles' });
  assert.deepEqual(parseTimezone('Asia/Tokyo'), { zone: 'Asia/Tokyo' });
  assert.deepEqual(parseTimezone('nonsense'), { offset: -12 });
});

test('wallTimeToUtc converts AoE deadlines to the right instant', () => {
  // 2026-09-30 23:59:59 AoE == 2026-10-01 11:59:59 UTC == 19:59:59 Beijing
  assert.equal(wallTimeToUtc('2026-09-30 23:59:59', 'AoE'), Date.UTC(2026, 9, 1, 11, 59, 59));
  assert.equal(wallTimeToUtc('2026-09-30 23:59:59', 'UTC+8'), Date.UTC(2026, 8, 30, 15, 59, 59));
  assert.equal(wallTimeToUtc('2026-09-30', 'UTC'), Date.UTC(2026, 8, 30, 23, 59, 59));
  assert.equal(wallTimeToUtc('TBD', 'AoE'), null);
  assert.equal(wallTimeToUtc(undefined, 'AoE'), null);
});

test('wallTimeToUtc follows DST for named zones', () => {
  // Pacific time: PDT (UTC-7) in July, PST (UTC-8) in January.
  assert.equal(wallTimeToUtc('2026-07-01 12:00:00', 'PT'), Date.UTC(2026, 6, 1, 19, 0, 0));
  assert.equal(wallTimeToUtc('2026-01-15 12:00:00', 'PT'), Date.UTC(2026, 0, 15, 20, 0, 0));
});

test('formatInZone renders in Beijing time and fixed offsets', () => {
  const ms = Date.UTC(2026, 9, 1, 11, 59, 59);
  assert.equal(formatInZone(ms, { zone: 'Asia/Shanghai' }), '2026-10-01 19:59');
  assert.equal(formatInZone(ms, { offset: -12 }), '2026-09-30 23:59');
  assert.match(formatInZone(ms, { zone: 'Asia/Shanghai' }, true), /^2026-10-01 19:59 周四$/);
});

test('pickDeadline prefers the next upcoming round', () => {
  const now = Date.UTC(2026, 8, 25);
  const timeline = [
    { deadline: Date.UTC(2026, 8, 20), comment: 'Round 1' },
    { deadline: Date.UTC(2026, 9, 20), comment: 'Round 2' },
    { deadline: Date.UTC(2027, 0, 20), comment: 'Round 3' }
  ];
  const d = pickDeadline(timeline, now);
  assert.equal(d.comment, 'Round 2');
  assert.equal(d.rounds, 3);
  assert.equal(d.status, 'warning');
  // All rounds passed: report the last one.
  assert.equal(pickDeadline(timeline, Date.UTC(2027, 5, 1)).comment, 'Round 3');
  assert.equal(pickDeadline([{ deadline: null }], now), null);
});

test('deadlineStatus and formatCountdown', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(deadlineStatus(now - 1, now), 'passed');
  assert.equal(deadlineStatus(now + 3 * D, now), 'urgent');
  assert.equal(deadlineStatus(now + 20 * D, now), 'warning');
  assert.equal(deadlineStatus(now + 60 * D, now), 'normal');
  assert.equal(deadlineStatus(null, now), 'unknown');
  assert.equal(formatCountdown(now + 3 * D + 5 * H, now), '还剩 3 天 5 小时');
  assert.equal(formatCountdown(now + 2 * H + 30 * 60000, now), '还剩 2 小时 30 分');
  assert.equal(formatCountdown(now - 1, now), '已截稿');
});

test('processConferences flattens editions and matches acceptance rates', () => {
  const confs = [{
    title: 'KDD', description: 'Knowledge Discovery', sub: 'DB', rank: { ccf: 'A' },
    confs: [{
      year: 2026, link: 'https://kdd.org', timezone: 'AoE', date: 'Aug', place: 'Jeju',
      timeline: [{ abstract_deadline: '2026-02-01 23:59:59', deadline: '2026-02-08 23:59:59', comment: 'Cycle 2' }]
    }]
  }, { title: 'X', confs: [{ year: 2026, timeline: [{ deadline: 'TBD' }] }] }];
  const accs = [{ title: 'KDD', accept_rates: [{ year: 2025, rate: 0.2, str: '20%' }, { year: 2026, rate: 0.19, str: '19%' }] }];
  const [kdd, x] = processConferences(confs, accs);
  assert.equal(kdd.rank, 'A');
  assert.equal(kdd.acceptance.year, 2026);
  assert.equal(kdd.timeline[0].deadline, Date.UTC(2026, 1, 9, 11, 59, 59));
  assert.equal(kdd.timeline[0].abstract, Date.UTC(2026, 1, 2, 11, 59, 59));
  assert.equal(kdd.timeline[0].comment, 'Cycle 2');
  assert.equal(x.rank, 'N');
  assert.equal(x.timeline[0].deadline, null);
  assert.equal(x.acceptance, null);
});

test('parseCcfList reads category, type and level from headings', () => {
  const md = [
    '##### 中国计算机学会推荐国际学术期刊（人工智能）',
    '###### 一、A 类',
    '| 序号 | 刊物简称 | 刊物全称 | 出版社 | 网址 |',
    '| ---- | ---- | ---- | ---- | ---- |',
    '| 1 | TPAMI | IEEE Transactions on Pattern Analysis and Machine Intelligence | IEEE | http://dblp.org/db/journals/tpami/ |',
    '##### 中国计算机学会推荐国际学术会议(数据库／数据挖掘／内容检索)',
    '###### 二、B 类',
    '| 1 | CIKM | Conference on Information and Knowledge Management | ACM | https://dblp.org/y |',
    '| 2 |  | Parallel Computing | Elsevier | |'
  ].join('\n');
  const rows = parseCcfList(md);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    name: 'TPAMI', full: 'IEEE Transactions on Pattern Analysis and Machine Intelligence',
    category: '人工智能', type: '期刊', level: 'A', publisher: 'IEEE', url: 'http://dblp.org/db/journals/tpami/', dblp: 'tpami'
  });
  assert.equal(rows[1].category, '数据库/数据挖掘/内容检索');
  assert.equal(rows[1].type, '会议');
  assert.equal(rows[1].level, 'B');
  assert.equal(rows[2].name, '');
});

test('journal matching tolerates JCR naming quirks', () => {
  const names = [
    'COMPUTERS & GRAPHICS-UK',
    'Future Generation Computer Systems-The International Journal of eScience',
    'ACM Transactions on Quantum Computing',
    'JOURNAL OF SYSTEMS ARCHITECTURE',
    'PERFORMANCE EVALUATION',
    'IEEE TRANSACTIONS ON SYSTEMS MAN CYBERNETICS-SYSTEMS'
  ];
  const index = createJournalIndex(names);
  assert.equal(findJournal(index, 'Computers & Graphics'), 0);
  assert.equal(findJournal(index, 'Future Generation Computer Systems'), 1);
  assert.equal(findJournal(index, 'ACM Transactions in Quantum Computing'), 2);
  assert.equal(findJournal(index, 'Journal of Systems Architecture: Embedded Software Design'), 3);
  assert.equal(findJournal(index, 'Performance Evaluation: An International Journal'), 4);
  assert.equal(findJournal(index, 'IEEE Transactions on Systems, Man, and Cybernetics: Systems'), 5);
  assert.equal(findJournal(index, 'Nonexistent Journal'), -1);
});

test('conference keys link CCF names to ccfddl via DBLP', () => {
  assert.equal(dblpKey('https://dblp.uni-trier.de/db/conf/kdd/index.html'), 'kdd');
  assert.equal(dblpKey('http://dblp.uni-trier.de/db/journals/tocs/'), 'tocs');
  assert.equal(dblpKey(''), '');
  const ccf = conferenceKeys('SIGKDD', 'kdd');
  const ddl = conferenceKeys('KDD', 'kdd');
  assert.ok(ccf.some((k) => ddl.includes(k)));
  assert.deepEqual(conferenceKeys('', ''), []);
});

test('ambiguous journal names are not guessed', () => {
  const index = createJournalIndex(['JOURNAL OF X AND Y', 'Journal of X & Y']);
  assert.equal(findJournal(index, 'Journal of X and Y'), -1);
});

test('esc and safeUrl neutralise untrusted values', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.equal(safeUrl('https://kdd.org/2026/'), 'https://kdd.org/2026/');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('https://a.com/" onmouseover="x'), '');
});
