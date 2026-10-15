#!/usr/bin/env node
/**
 * Convert the upstream Markdown into browser data without rewriting its advice.
 * Usage: node scripts/import-guide.mjs /path/to/HowToLiveBetter [--check]
 * Node.js 20+; no dependencies or network access are needed during import.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const repository = 'https://github.com/eternity4719/HowToLiveBetter';
const licenseUrl = 'https://creativecommons.org/licenses/by/4.0/';
const output = fileURLToPath(new URL('../assets/guide-data.js', import.meta.url));
const licenseOutput = fileURLToPath(new URL('../CONTENT-LICENSE.txt', import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const positional = args.filter(arg => arg !== '--check');
if (positional.length !== 1 || positional[0].startsWith('--')) {
  console.error('Usage: node scripts/import-guide.mjs /path/to/HowToLiveBetter [--check]');
  process.exit(1);
}
const upstream = resolve(positional[0]);
const git = (...gitArgs) => execFileSync('git', ['-C', upstream, ...gitArgs], { encoding: 'utf8' }).trim();
const read = path => readFile(resolve(upstream, path), 'utf8');
const commit = git('rev-parse', 'HEAD');
assert.match(commit, /^[a-f\d]{40}$/, 'The upstream must have a full Git commit identifier.');
assert.match(git('config', '--get', 'remote.origin.url'), /(?:github\.com[:/])eternity4719\/HowToLiveBetter(?:\.git)?\/?$/, 'Use a checkout of the attributed upstream repository.');
assert.equal(git('status', '--porcelain', '--', 'book', 'README.md', 'LICENSE'), '', 'Commit or discard upstream content edits first; source links must describe the imported content.');

const [readme, upstreamLicense, fileNames] = await Promise.all([
  read('README.md'), read('LICENSE'), readdir(resolve(upstream, 'book')),
]);
assert.match(upstreamLicense, /Attribution 4\.0 International/, 'The expected CC BY 4.0 content license was not found.');
assert.match(readme, /正文用 \[CC BY 4\.0\]/, 'Check the upstream content license before importing.');

const files = fileNames.filter(file => /^\d+-.*\.md$/.test(file)).sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
const referencedFiles = new Set([...readme.matchAll(/\]\((book\/\d+-[^)]+\.md)\)/g)].map(match => match[1]));
assert.equal(files.length, referencedFiles.size, 'README chapter links and book files differ.');
for (const file of files) assert.ok(referencedFiles.has(`book/${file}`), `README is missing ${file}.`);

const labels = ['成本', '说人话', '收益', '证据等级', '来源', '备注'];
const tagNames = { 钱: 'money', 时间: 'time', 毅力: 'willpower', 收益: 'benefit', 口径: 'scope', 人群: 'audience' };
const allowedTags = {
  money: new Set(['0', '少', '多']), time: new Set(['少', '中', '多']),
  willpower: new Set(['否', '些', '是']), benefit: new Set(['大', '中', '小']),
  scope: new Set(['死亡率', '金钱', '时间', '自由']),
};
const chapters = [];
const items = [];
const ids = new Set();
let originalHeadingCount = 0;

// GitHub strips punctuation/symbols (except hyphen and underscore), lowers
// Latin letters, replaces each space with a hyphen, and suffixes duplicates.
// Verified against GitHub-rendered HTML for all 765 headings in this snapshot.
function createSlugger() {
  const occurrences = new Map();
  return heading => {
    const base = heading.toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replace(/ /g, '-');
    let slug = base;
    let suffix = 0;
    while (occurrences.has(slug)) slug = `${base}-${++suffix}`;
    occurrences.set(slug, true);
    return slug;
  };
}

function stableId(chapter, title) {
  // Numbers displayed before titles are deliberately excluded: upstream can
  // insert items without moving the existing user's progress to another item.
  const normalized = title.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `ch${String(chapter).padStart(2, '0')}-${hash}`;
}

for (const [fileIndex, file] of files.entries()) {
  const path = `book/${file}`;
  const markdown = await read(path);
  const chapterHeading = markdown.match(/^# (\d+)\. (.+)$/m);
  assert.ok(chapterHeading, `No chapter heading: ${path}`);
  const chapter = Number(chapterHeading[1]);
  assert.equal(chapter, fileIndex + 1, `Chapter numbering is not contiguous: ${path}`);
  assert.equal(chapter, Number.parseInt(file), `Filename and heading disagree: ${path}`);
  const headingMatches = [...markdown.matchAll(/^### (\d+)\. (.+)$/gm)];
  const allThirdLevelHeadings = [...markdown.matchAll(/^### /gm)];
  assert.equal(headingMatches.length, allThirdLevelHeadings.length, `An item heading could not be parsed: ${path}`);
  originalHeadingCount += allThirdLevelHeadings.length;
  assert.ok(headingMatches.length, `No items: ${path}`);
  chapters.push({ id: chapter, title: chapterHeading[2], file: path, count: headingMatches.length });

  const slugger = createSlugger();
  const anchors = new Map();
  for (const match of markdown.matchAll(/^#{1,6} (.+)$/gm)) anchors.set(match.index, slugger(match[1]));

  for (const [itemIndex, heading] of headingMatches.entries()) {
    const number = Number(heading[1]);
    assert.equal(number, itemIndex + 1, `Item numbering is not contiguous: ${path}, item ${number}`);
    const title = heading[2];
    const raw = markdown.slice(heading.index, headingMatches[itemIndex + 1]?.index ?? markdown.length);
    const fieldMatches = [...raw.matchAll(/^- (成本|说人话|收益|证据等级|来源|备注)：/gm)];
    assert.deepEqual(fieldMatches.map(match => match[1]), labels, `Missing, repeated or reordered fields: ${path}, item ${number}`);
    const fields = fieldMatches.map((match, index) => ({
      label: match[1],
      text: raw.slice(match.index + match[0].length, fieldMatches[index + 1]?.index ?? raw.length).trim(),
    }));
    for (const field of fields) assert.ok(field.text, `Empty ${field.label}: ${path}, item ${number}`);
    const values = Object.fromEntries(fields.map(field => [field.label, field.text]));
    // A few upstream grades carry a parenthetical qualification. Preserve it
    // in fields/raw while exposing the initial letter for evidence filtering.
    assert.match(values['证据等级'], /^[ABC](?:（[^\n]*）)?$/, `Unknown evidence grade: ${path}, item ${number}`);

    const tagMatch = raw.match(/^<!--\s*成本标签:\s*(.*?)\s*-->\s*$/m);
    assert.ok(tagMatch, `Missing cost tags: ${path}, item ${number}`);
    const tags = { money: '', time: '', willpower: '', benefit: '', scope: '', audience: '' };
    for (const pair of tagMatch[1].split(/\s+/)) {
      const separator = pair.indexOf('=');
      assert.ok(separator > 0, `Invalid cost tag ${pair}: ${path}, item ${number}`);
      const key = tagNames[pair.slice(0, separator)];
      assert.ok(key, `Unknown cost tag ${pair}: ${path}, item ${number}`);
      assert.equal(tags[key], '', `Repeated cost tag ${pair}: ${path}, item ${number}`);
      tags[key] = pair.slice(separator + 1);
    }
    for (const [key, allowed] of Object.entries(allowedTags)) assert.ok(allowed.has(tags[key]), `Invalid ${key} tag ${tags[key]}: ${path}, item ${number}`);

    const id = stableId(chapter, title);
    assert.ok(!ids.has(id), `Stable ID collision (review titles before changing IDs): ${path}, item ${number}`);
    ids.add(id);
    const anchor = anchors.get(heading.index);
    assert.ok(anchor, `Missing source anchor: ${path}, item ${number}`);
    items.push({
      id, chapter, number, title,
      summary: values['说人话'], cost: values['成本'], benefit: values['收益'], evidence: values['证据等级'][0],
      tags, fields, raw,
      sourceUrl: `${repository}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}#${encodeURIComponent(anchor)}`,
    });
  }
}

assert.equal(items.length, originalHeadingCount, 'Original item headings were lost during import.');
assert.equal(chapters.reduce((total, chapter) => total + chapter.count, 0), items.length, 'Chapter counts differ from imported items.');
const advertisedCount = readme.match(/(?:^|\n)(\d+) 条建议/m);
assert.ok(advertisedCount, 'The README item total could not be read.');
assert.equal(items.length, Number(advertisedCount[1]), 'README item total differs from imported items.');
assert.ok(items.every(item => item.fields.find(field => field.label === '说人话').text === item.summary), 'A summary was rewritten.');
const data = {
  meta: { title: '高性价比人生指南', repository, commit, syncedAt: new Date().toISOString(), license: 'CC BY 4.0', licenseUrl, total: items.length },
  chapters, items,
};
const licenseText = `高性价比人生指南 — 内容署名与许可\n\n来源：${repository}\n作者：eternity4719 及上游贡献者\n固定版本：${commit}\n许可：CC BY 4.0（知识共享署名 4.0 国际）\n许可链接：${licenseUrl}\n原许可文件：${repository}/blob/${commit}/LICENSE\n\n本工具将 book/ 的 ${chapters.length} 节 ${items.length} 条 Markdown 内容转换为可筛选、\n可记录个人进度的数据格式。标题、成本、说人话、收益、证据等级、来源、备注\n均取自上游，不另行编写行动建议；完整条目原文保存在 raw 字段。\n每条内容提供固定版本的原文链接。个人状态、日期与笔记由使用者自行填写，\n不属于原作者内容。本工具为独立衍生项目，未获原作者背书。\n\n上游说明：法律、医保、社保等制度内容按中国大陆规定编写；内容可能过时\n或有错，各地执行可能不同。指南是供选择的备选单，并不要求人人做完。\n\n下附上游 LICENSE 全文。该许可只适用于本工具引入的指南内容；\n本工具自身源代码许可另见 LICENSE。\n\n=======================================================================\n\n${upstreamLicense.trimEnd()}\n`;

if (check) {
  const existing = runInNewContext(`${await readFile(output, 'utf8')}\nJSON.stringify(globalThis.GUIDE_DATA)`);
  const parsed = JSON.parse(existing);
  assert.match(parsed.meta.syncedAt, /^\d{4}-\d{2}-\d{2}T/, 'Invalid content sync timestamp.');
  data.meta.syncedAt = parsed.meta.syncedAt;
  assert.deepEqual(parsed, data, 'Generated guide-data.js differs from upstream; run the importer.');
  assert.equal(await readFile(licenseOutput, 'utf8'), licenseText, 'CONTENT-LICENSE.txt differs from upstream.');
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `/* Generated from ${repository} @ ${commit}. Content: CC BY 4.0. See CONTENT-LICENSE.txt. */\nglobalThis.GUIDE_DATA = ${JSON.stringify(data)};\n`);
  await writeFile(licenseOutput, licenseText);
}

const evidence = Object.fromEntries(['A', 'B', 'C'].map(grade => [grade, items.filter(item => item.evidence === grade).length]));
console.log(JSON.stringify({ mode: check ? 'verified' : 'imported', commit, chapters: chapters.length, originalHeadings: originalHeadingCount, items: items.length, uniqueIds: ids.size, fieldsPerItem: labels.length, evidence, license: data.meta.license }));
