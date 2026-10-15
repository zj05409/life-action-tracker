const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(readFileSync(path.join(__dirname, '../assets/guide-data.js'), 'utf8'), context, {
  filename: 'assets/guide-data.js',
  timeout: 5000,
});
// Compare plain objects in this realm; the shipped data runs in a browser realm.
const guide = JSON.parse(JSON.stringify(context.GUIDE_DATA));
const fieldLabels = ['成本', '说人话', '收益', '证据等级', '来源', '备注'];
const tagNames = ['money', 'time', 'willpower', 'benefit', 'scope', 'audience'];

function nonemptyString(value, message) {
  assert.equal(typeof value, 'string', message);
  assert.ok(value.trim().length > 0, message);
}

test('the content snapshot includes all 765 items across all 34 chapters', () => {
  assert.equal(guide.meta.total, 765);
  assert.equal(guide.items.length, 765);
  assert.equal(guide.chapters.length, 34);
  assert.deepEqual(guide.chapters.map(chapter => chapter.id), Array.from({ length: 34 }, (_, index) => index + 1));
  assert.equal(guide.meta.repository, 'https://github.com/eternity4719/HowToLiveBetter');
  assert.match(guide.meta.commit, /^[a-f\d]{40}$/);
  assert.equal(guide.meta.license, 'CC BY 4.0');
  assert.equal(guide.meta.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.ok(Number.isFinite(Date.parse(guide.meta.syncedAt)));
});

test('every item has its own stable identifier and belongs to a counted chapter', () => {
  const ids = new Set();
  const chapterIds = new Set(guide.chapters.map(chapter => chapter.id));
  for (const item of guide.items) {
    nonemptyString(item.id, 'Each item needs an identifier.');
    assert.ok(!ids.has(item.id), `Duplicate item identifier: ${item.id}`);
    ids.add(item.id);
    assert.ok(chapterIds.has(item.chapter), `Unknown chapter for ${item.id}`);
    assert.ok(Number.isInteger(item.number) && item.number > 0, `Missing display number for ${item.id}`);
    nonemptyString(item.title, `Missing item title for ${item.id}`);
  }
  assert.equal(ids.size, 765);

  let total = 0;
  for (const chapter of guide.chapters) {
    nonemptyString(chapter.title, `Missing chapter title for ${chapter.id}`);
    assert.match(chapter.file, /^book\/[^/]+\.md$/);
    const entries = guide.items.filter(item => item.chapter === chapter.id);
    assert.ok(entries.length > 0, `Chapter ${chapter.id} has no entries.`);
    assert.equal(chapter.count, entries.length, `Incorrect count for chapter ${chapter.id}`);
    assert.equal(new Set(entries.map(item => item.number)).size, entries.length, `Duplicate display numbers in chapter ${chapter.id}`);
    total += chapter.count;
  }
  assert.equal(total, guide.meta.total);
});

test('all six original fields and their complete text remain available in raw content', () => {
  for (const item of guide.items) {
    const description = `chapter ${item.chapter}, item ${item.number}`;
    assert.equal(item.fields.length, 6, description);
    assert.deepEqual(item.fields.map(field => field.label).sort(), [...fieldLabels].sort(), description);
    nonemptyString(item.raw, `Missing original content: ${description}`);
    assert.match(item.raw, /^### \d+\. \S/, `Missing original heading: ${description}`);

    for (const field of item.fields) {
      nonemptyString(field.text, `Empty ${field.label}: ${description}`);
      assert.ok(item.raw.includes(`- ${field.label}：`), `Missing original ${field.label} label: ${description}`);
      assert.ok(item.raw.includes(field.text), `Original ${field.label} text was truncated: ${description}`);
    }

    const original = Object.fromEntries(item.fields.map(field => [field.label, field.text]));
    assert.equal(item.summary, original['说人话'], `Summary must remain the upstream text: ${description}`);
    assert.equal(item.cost, original['成本'], `Cost text changed: ${description}`);
    assert.equal(item.benefit, original['收益'], `Benefit text changed: ${description}`);
    assert.ok(['A', 'B', 'C'].includes(item.evidence), `Invalid evidence grade: ${description}`);
    assert.ok(original['证据等级'].startsWith(item.evidence), `Evidence qualification was detached: ${description}`);
  }
});

test('each original-source link points to the same fixed GitHub commit and a heading', () => {
  const prefix = `/eternity4719/HowToLiveBetter/blob/${guide.meta.commit}/book/`;
  for (const item of guide.items) {
    const url = new URL(item.sourceUrl);
    assert.equal(url.protocol, 'https:', item.id);
    assert.equal(url.hostname, 'github.com', item.id);
    assert.equal(url.username, '', item.id);
    assert.equal(url.password, '', item.id);
    assert.equal(url.port, '', item.id);
    assert.equal(url.search, '', item.id);
    assert.ok(url.pathname.startsWith(prefix), `Source does not use the attributed repository and fixed commit: ${item.id}`);
    assert.ok(decodeURIComponent(url.pathname).endsWith('.md'), `Source is not a chapter file: ${item.id}`);
    assert.ok(decodeURIComponent(url.hash).length > 1, `Source has no heading anchor: ${item.id}`);
  }
});

test('every item retains all six upstream filtering categories', () => {
  const allowed = {
    money: ['0', '少', '多'],
    time: ['少', '中', '多'],
    willpower: ['否', '些', '是'],
    benefit: ['大', '中', '小'],
    scope: ['死亡率', '金钱', '时间', '自由'],
  };
  for (const item of guide.items) {
    for (const key of tagNames) {
      assert.ok(Object.hasOwn(item.tags, key), `Missing ${key} category: ${item.id}`);
      assert.equal(typeof item.tags[key], 'string', `Invalid ${key} category: ${item.id}`);
    }
    for (const [key, values] of Object.entries(allowed)) {
      assert.ok(values.includes(item.tags[key]), `Unknown ${key} value for ${item.id}`);
    }
    // An empty audience means the upstream did not restrict the audience.
    assert.ok(item.raw.includes('成本标签:'), `Original filtering tags missing: ${item.id}`);
  }
});
