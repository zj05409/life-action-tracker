const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../state.js');

const CREATED = '2026-10-01T00:00:00.000Z';
const EARLIER = '2026-10-10T00:00:00.000Z';
const LATER = '2026-10-15T00:00:00.000Z';
const ids = new Set(['learn', 'exercise', 'budget']);

function makeRecord(patch = {}) {
  return { ...S.record(), ...patch };
}

function backup(records = {}, preferences = { weeklyGoal: 5 }) {
  return { ...S.fresh(CREATED), records, preferences };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('local day keys, real dates, leap years, and month/year shifts', () => {
  assert.equal(S.dayKey(new Date(2026, 9, 5, 23, 59)), '2026-10-05');
  for (const day of ['2024-02-29', '2026-01-01', '2026-12-31']) {
    assert.equal(S.validDay(day), true, day);
  }
  for (const day of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00', '2026-1-01', '', null, 20261015]) {
    assert.equal(S.validDay(day), false, String(day));
  }
  assert.equal(S.shiftDay('2026-01-31', 1), '2026-02-01');
  assert.equal(S.shiftDay('2024-03-01', -1), '2024-02-29');
  assert.equal(S.shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(S.shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(S.shiftDay('2026-03-08', 1), '2026-03-09', 'spring daylight-saving changes retain the calendar date');
  assert.equal(S.shiftDay('2026-11-01', 1), '2026-11-02', 'autumn daylight-saving changes retain the calendar date');
});

test('weeks start Monday and may cross a month or year boundary', () => {
  assert.equal(S.monday('2026-11-01'), '2026-10-26');
  assert.equal(S.monday('2026-11-02'), '2026-11-02');
  assert.equal(S.monday('2027-01-03'), '2026-12-28');
});

test('fresh states and missing records have independent defaults', () => {
  const a = S.fresh(CREATED);
  const b = S.fresh(CREATED);
  assert.equal(a.schema, S.SCHEMA);
  assert.equal(a.version, 1);
  assert.equal(a.preferences.weeklyGoal, 5);
  a.preferences.weeklyGoal = 9;
  assert.equal(b.preferences.weeklyGoal, 5);
  const missing = S.get(a, 'learn');
  missing.checks.push('2026-10-15');
  assert.deepEqual(S.get(a, 'learn').checks, []);
  assert.deepEqual(a.records, {});
});

test('one-off completion can be undone and completed again', () => {
  const state = S.fresh(CREATED);
  const done = S.complete(state, 'learn', '2026-10-15', LATER);
  assert.equal(done.status, 'done');
  assert.equal(done.planned, true);
  assert.equal(done.completedAt, LATER);
  assert.equal(S.isChecked(done, '2026-10-15'), true);
  assert.equal(S.isDue(done, '2026-10-15'), false);
  assert.equal(state.updatedAt, LATER);

  const undone = S.complete(state, 'learn', '2026-10-16', '2026-10-16T00:00:00Z');
  assert.equal(undone.status, 'doing');
  assert.equal(undone.completedAt, '');
  assert.equal(undone.focusDate, '2026-10-16');
  assert.equal(S.isChecked(undone, '2026-10-16'), false);
  assert.equal(S.isDue(undone, '2026-10-16'), true);
  assert.deepEqual(S.events(state), {});

  S.complete(state, 'learn', '2026-10-16', '2026-10-16T01:00:00Z');
  assert.equal(S.get(state, 'learn').status, 'done');
});

test('repeating completion toggles only that day and never duplicates checks', () => {
  const state = S.fresh(CREATED);
  S.update(state, 'exercise', { recurrence: 'daily' }, EARLIER);
  S.complete(state, 'exercise', '2026-10-14', EARLIER);
  S.complete(state, 'exercise', '2026-10-15', LATER);
  assert.deepEqual(S.get(state, 'exercise').checks, ['2026-10-14', '2026-10-15']);
  assert.equal(S.get(state, 'exercise').status, 'doing');
  assert.equal(S.get(state, 'exercise').completedAt, '');
  assert.equal(S.isChecked(S.get(state, 'exercise'), '2026-10-15'), true);
  S.complete(state, 'exercise', '2026-10-15', LATER);
  assert.deepEqual(S.get(state, 'exercise').checks, ['2026-10-14']);
  assert.equal(S.isDue(S.get(state, 'exercise'), '2026-10-15'), true);
});

test('daily, weekly, and monthly cycles expire at their real boundaries', () => {
  const daily = makeRecord({ planned: true, status: 'doing', recurrence: 'daily', checks: ['2026-10-31'] });
  assert.equal(S.cycleDone(daily, '2026-10-31'), true);
  assert.equal(S.isDue(daily, '2026-11-01'), true);

  const weekly = makeRecord({ planned: true, status: 'doing', recurrence: 'weekly', checks: ['2026-10-26'] });
  assert.equal(S.cycleDone(weekly, '2026-11-01'), true);
  assert.equal(S.isDue(weekly, '2026-11-01'), false);
  assert.equal(S.isDue(weekly, '2026-11-02'), true);
  assert.equal(S.cycleDone(makeRecord({ recurrence: 'weekly', checks: ['2026-11-01'] }), '2026-10-31'), false, 'future check-ins do not satisfy an earlier day');

  const monthly = makeRecord({ planned: true, status: 'doing', recurrence: 'monthly', checks: ['2026-10-01'] });
  assert.equal(S.cycleDone(monthly, '2026-10-31'), true);
  assert.equal(S.isDue(monthly, '2026-11-01'), true);
  assert.equal(S.cycleDone(makeRecord({ recurrence: 'monthly', checks: ['2026-10-31'] }), '2026-10-15'), false);
});

test('due items respect plans, exclusions, completion, focus dates, and deadlines', () => {
  const day = '2026-10-15';
  const scheduled = makeRecord({ planned: true, focusDate: day });
  assert.equal(S.isDue(scheduled, day), true);
  assert.equal(S.isDue({ ...scheduled, planned: false }, day), false);
  assert.equal(S.isDue({ ...scheduled, status: 'na' }, day), false);
  assert.equal(S.isDue({ ...scheduled, status: 'done' }, day), false);
  assert.equal(S.isDue({ ...scheduled, focusDate: '2026-10-16' }, day), false);
  assert.equal(S.isDue(makeRecord({ planned: true }), day), false);
  assert.equal(S.isDue(makeRecord({ planned: true, dueDate: day }), day), true);
  assert.equal(S.isDue(makeRecord({ planned: true, dueDate: '2026-10-14' }), day), true);
  assert.equal(S.isDue(makeRecord({ planned: true, dueDate: '2026-10-16' }), day), false);
  assert.equal(S.isDue(makeRecord({ planned: true, recurrence: 'daily', focusDate: '2026-10-16' }), day), false);
});

test('backup validation filters unknown IDs, normalizes checks, and keeps text literal', () => {
  const text = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const incoming = backup({
    learn: makeRecord({ recurrence: 'weekly', note: text, steps: [{ id: 'step-1', title: text, done: false }], checks: ['2026-10-15', '2026-10-14', '2026-10-15'] }),
    removedFromGuide: { malformed: true },
  }, { weeklyGoal: 12 });
  const result = S.validate(incoming, ids);
  assert.equal(result.unknown, 1);
  assert.deepEqual(Object.keys(result.state.records), ['learn']);
  assert.equal(result.state.records.learn.note, text);
  assert.equal(result.state.records.learn.recurrence, 'weekly');
  assert.equal(result.state.records.learn.steps[0].title, text);
  assert.deepEqual(result.state.records.learn.checks, ['2026-10-14', '2026-10-15']);
  assert.equal(result.state.preferences.weeklyGoal, 12);
  assert.equal(result.state.createdAt, CREATED);
});

test('backup validation rejects incompatible schemas and malformed records', () => {
  for (const invalid of [null, {}, { ...backup(), version: 2 }, { ...backup(), schema: 'other' }, { ...backup(), records: [] }]) {
    assert.throws(() => S.validate(invalid, ids));
  }
  const invalidRecords = [
    null,
    [],
    makeRecord({ status: 'deleted' }),
    makeRecord({ recurrence: 'yearly' }),
    makeRecord({ focusDate: '2026-02-30' }),
    makeRecord({ dueDate: '2026-04-31' }),
    makeRecord({ checks: ['2026-10-32'] }),
    makeRecord({ checks: '2026-10-15' }),
    makeRecord({ note: { html: '<script>' } }),
    makeRecord({ note: 'x'.repeat(20001) }),
    makeRecord({ steps: [{ id: '../x', title: 'Title', done: false }] }),
    makeRecord({ steps: [{ id: 'x', title: '   ', done: false }] }),
    makeRecord({ steps: [{ id: 'x', title: 'Title', done: 'true' }] }),
    makeRecord({ steps: [{ id: 'x', title: 'A', done: false }, { id: 'x', title: 'B', done: true }] }),
    makeRecord({ updatedAt: 'not-a-date' }),
    makeRecord({ completedAt: 'not-a-date' }),
  ];
  for (const rec of invalidRecords) assert.throws(() => S.validate(backup({ learn: rec }), ids));
});

test('record timestamps reject impossible calendar days instead of rolling into a later month', () => {
  for (const field of ['updatedAt', 'completedAt']) {
    for (const value of ['2026-02-30T12:00:00Z', '2026-02-29T12:00:00.000Z', '2026-04-31T12:00:00+09:00']) {
      assert.throws(() => S.validate(backup({ learn: makeRecord({ [field]: value }) }), ids), /时间/, `${field}: ${value}`);
    }
    const validLeapDay = '2024-02-29T23:30:00-05:00';
    const result = S.validate(backup({ learn: makeRecord({ [field]: validLeapDay }) }), ids);
    assert.equal(result.state.records.learn[field], validLeapDay);
  }
});

test('invalid weekly goals fall back safely', () => {
  for (const weeklyGoal of [0, -1, 101, 1.5, 'bad', undefined]) {
    assert.equal(S.validate(backup({}, { weeklyGoal }), ids).state.preferences.weeklyGoal, 5);
  }
});

test('invalid updates do not partially change state', () => {
  const state = S.fresh(CREATED);
  S.update(state, 'learn', { note: 'keep' }, EARLIER);
  S.update(state, 'exercise', { recurrence: 'daily' }, EARLIER);
  const before = JSON.stringify(state);
  assert.throws(() => S.update(state, 'learn', { note: 'replace', focusDate: '2026-02-30' }, LATER));
  assert.equal(JSON.stringify(state), before);
  assert.throws(() => S.complete(state, 'exercise', 'invalid-day', LATER), /日期/);
  assert.equal(JSON.stringify(state), before);
});

test('storage round-trips progress and reports malformed JSON or denied access', () => {
  const storage = memoryStorage();
  assert.deepEqual(S.load(storage, ids).records, {});
  const state = S.fresh(CREATED);
  S.update(state, 'learn', { note: '下一个小步骤', planned: true, focusDate: '2026-10-15' }, LATER);
  S.save(storage, state);
  assert.deepEqual(S.load(storage, ids), state);
  storage.setItem(S.KEY, '{broken');
  assert.throws(() => S.load(storage, ids), SyntaxError);
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota exceeded'); } };
  assert.throws(() => S.load(denied, ids), /denied/);
  assert.throws(() => S.save(denied, state), /quota exceeded/);
});

test('local loading keeps historical guide IDs while backup imports skip them', () => {
  const storage = memoryStorage();
  const historicalId = 'ch03-a1b2c3d4e5f6';
  const historical = makeRecord({ note: '标题更新前写下的笔记', recurrence: 'weekly', checks: ['2026-10-14'], updatedAt: EARLIER });
  const incoming = backup({
    learn: makeRecord({ note: '当前指南中的事项', updatedAt: LATER }),
    [historicalId]: historical,
    unrelatedId: makeRecord({ note: '非指南记录' }),
  });
  S.save(storage, incoming);
  const loaded = S.load(storage, ids);
  assert.deepEqual(loaded.records[historicalId], historical);
  assert.equal(loaded.records.learn.note, '当前指南中的事项');
  assert.equal(Object.hasOwn(loaded.records, 'unrelatedId'), false);
  assert.equal(ids.has(historicalId), false, 'loading does not change the caller catalog');
  S.save(storage, loaded);
  assert.deepEqual(S.load(storage, ids).records[historicalId], historical, 'a subsequent save keeps historical notes and checks');

  const imported = S.validate(incoming, ids);
  assert.equal(imported.unknown, 2);
  assert.deepEqual(Object.keys(imported.state.records), ['learn']);
});

test('malformed historical local records raise an error instead of silently losing progress', () => {
  const storage = memoryStorage();
  S.save(storage, backup({ 'ch03-a1b2c3d4e5f6': makeRecord({ checks: ['2026-02-30'] }) }));
  assert.throws(() => S.load(storage, ids), /日期/);
});

test('merge keeps newer fields, adds old check-ins, and keeps unmentioned records', () => {
  const current = backup({
    learn: makeRecord({ note: 'new local', updatedAt: LATER, checks: ['2026-10-15'] }),
    budget: makeRecord({ note: 'keep local', updatedAt: LATER }),
  });
  const incoming = backup({
    learn: makeRecord({ note: 'old imported', updatedAt: EARLIER, checks: ['2026-10-14', '2026-10-15'] }),
    exercise: makeRecord({ recurrence: 'weekly', updatedAt: EARLIER, checks: ['2026-10-13'] }),
  });
  const next = S.merge(current, incoming, LATER);
  assert.equal(next.records.learn.note, 'new local');
  assert.deepEqual(next.records.learn.checks, ['2026-10-14', '2026-10-15']);
  assert.equal(next.records.budget.note, 'keep local');
  assert.equal(next.records.exercise.recurrence, 'weekly');
  assert.equal(next.updatedAt, LATER);
  assert.deepEqual(current.records.learn.checks, ['2026-10-15']);
});

test('merge selects newer imports and resolves equal timestamps consistently', () => {
  const current = backup({ learn: makeRecord({ note: 'local', updatedAt: EARLIER, checks: ['2026-10-13'] }) });
  const incoming = backup({ learn: makeRecord({ note: 'imported', updatedAt: LATER, checks: ['2026-10-14'] }) });
  const next = S.merge(current, incoming, LATER);
  assert.equal(next.records.learn.note, 'imported');
  assert.deepEqual(next.records.learn.checks, ['2026-10-13', '2026-10-14']);
  const equal = S.merge(backup({ learn: makeRecord({ note: 'local', updatedAt: LATER }) }), incoming, LATER);
  assert.equal(equal.records.learn.note, 'imported');
});

test('merged state owns its records without changing either input backup', () => {
  const current = backup({ learn: makeRecord({ updatedAt: EARLIER, checks: ['2026-10-13'] }) });
  const incoming = backup({ learn: makeRecord({ note: 'imported', updatedAt: LATER, checks: ['2026-10-14'], steps: [{ id: 'first', title: 'start', done: false }] }) });
  const beforeCurrent = JSON.stringify(current);
  const beforeIncoming = JSON.stringify(incoming);
  const next = S.merge(current, incoming, LATER);
  assert.equal(JSON.stringify(current), beforeCurrent);
  assert.equal(JSON.stringify(incoming), beforeIncoming);
  next.records.learn.note = 'edited';
  next.records.learn.steps[0].done = true;
  assert.equal(incoming.records.learn.note, 'imported');
  assert.equal(incoming.records.learn.steps[0].done, false);
});

test('progress events count completions and check-ins by the local calendar day', () => {
  const completedAt = new Date(2026, 9, 15, 0, 30).toISOString();
  const state = backup({
    learn: makeRecord({ status: 'done', completedAt }),
    exercise: makeRecord({ recurrence: 'daily', status: 'doing', checks: ['2026-10-14', '2026-10-15'] }),
    budget: makeRecord({ status: 'doing', completedAt }),
  });
  assert.deepEqual(S.events(state), { '2026-10-14': 1, '2026-10-15': 2 });
  S.complete(state, 'learn', '2026-10-15', LATER);
  assert.deepEqual(S.events(state), { '2026-10-14': 1, '2026-10-15': 1 });
  S.complete(state, 'exercise', '2026-10-15', LATER);
  assert.deepEqual(S.events(state), { '2026-10-14': 1 });
});
