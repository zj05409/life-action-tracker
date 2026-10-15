/* Local-only progress model. No account, analytics, or network storage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LifeState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'life-in-progress.v1';
  const SCHEMA = 'life-action-tracker';
  const STATUSES = ['todo', 'doing', 'done', 'na'];
  const RECURRENCES = ['once', 'daily', 'weekly', 'monthly'];
  function dayKey(date = new Date()) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00`);
    return !Number.isNaN(date.getTime()) && dayKey(date) === value;
  }
  function shiftDay(value, amount) {
    const date = new Date(`${value}T12:00:00`);
    date.setDate(date.getDate() + amount);
    return dayKey(date);
  }
  function monday(value) {
    const date = new Date(`${value}T12:00:00`);
    return shiftDay(value, -((date.getDay() + 6) % 7));
  }
  function fresh(now = new Date().toISOString()) {
    return { schema: SCHEMA, version: 1, createdAt: now, updatedAt: now, records: {}, preferences: { weeklyGoal: 5 } };
  }
  function record() {
    return { status: 'todo', planned: false, focusDate: '', dueDate: '', recurrence: 'once', checks: [], note: '', steps: [], updatedAt: '', completedAt: '' };
  }
  function get(state, id) { return state.records[id] || record(); }
  function normalizeRecord(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('备份中有无法识别的事项记录。');
    if (!STATUSES.includes(input.status) || !RECURRENCES.includes(input.recurrence)) throw new Error('备份中的事项状态或重复周期无效。');
    const result = record();
    result.status = input.status;
    result.recurrence = input.recurrence;
    result.planned = input.planned === true;
    for (const key of ['focusDate', 'dueDate']) {
      if (input[key] && !validDay(input[key])) throw new Error('备份中有无效日期。');
      result[key] = input[key] || '';
    }
    if (!Array.isArray(input.checks) || input.checks.length > 40000 || input.checks.some(d => !validDay(d))) throw new Error('备份中的打卡日期无效。');
    result.checks = [...new Set(input.checks)].sort();
    if (typeof input.note !== 'string' || input.note.length > 20000) throw new Error('备份中的笔记无效或过长。');
    result.note = input.note;
    if (!Array.isArray(input.steps) || input.steps.length > 100) throw new Error('备份中的行动步骤无效。');
    const stepIds = new Set();
    result.steps = input.steps.map(step => {
      if (!step || typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(step.id) || stepIds.has(step.id) || typeof step.title !== 'string' || !step.title.trim() || step.title.length > 500 || typeof step.done !== 'boolean') throw new Error('备份中的行动步骤无效。');
      stepIds.add(step.id);
      return { id: step.id, title: step.title, done: step.done };
    });
    for (const key of ['updatedAt', 'completedAt']) {
      if (input[key] && (typeof input[key] !== 'string' || !Number.isFinite(Date.parse(input[key])) || !validDay(input[key].slice(0, 10)))) throw new Error('备份中的时间记录无效。');
      result[key] = input[key] || '';
    }
    return result;
  }
  function validate(input, ids) {
    if (!input || input.schema !== SCHEMA || input.version !== 1 || !input.records || typeof input.records !== 'object' || Array.isArray(input.records)) throw new Error('请选择本工具导出的 v1 JSON 备份。');
    if (Object.keys(input.records).length > 20000) throw new Error('备份文件包含过多事项。');
    const result = fresh();
    let unknown = 0;
    for (const [id, value] of Object.entries(input.records)) {
      if (!ids.has(id)) { unknown++; continue; }
      result.records[id] = normalizeRecord(value);
    }
    for (const key of ['createdAt', 'updatedAt']) {
      if (typeof input[key] === 'string' && Number.isFinite(Date.parse(input[key]))) result[key] = input[key];
    }
    const goal = Number(input.preferences?.weeklyGoal);
    if (Number.isInteger(goal) && goal >= 1 && goal <= 100) result.preferences.weeklyGoal = goal;
    return { state: result, unknown };
  }
  function load(storage, ids) {
    const text = storage.getItem(KEY);
    if (!text) return fresh();
    const input = JSON.parse(text);
    // Keep historical local records after a guide rename/move. They stay in
    // backups, while imports still explicitly skip IDs outside this snapshot.
    const localIds = new Set(ids);
    for (const id of Object.keys(input?.records || {})) if (/^ch\d{2}-[a-f0-9]{12}$/.test(id)) localIds.add(id);
    return validate(input, localIds).state;
  }
  function save(storage, state) { storage.setItem(KEY, JSON.stringify(state)); }
  function update(state, id, patch, now = new Date().toISOString()) {
    const next = normalizeRecord({ ...get(state, id), ...patch, updatedAt: now });
    state.records[id] = next;
    state.updatedAt = now;
    return next;
  }
  function complete(state, id, day = dayKey(), now = new Date().toISOString()) {
    const current = get(state, id);
    if (current.recurrence !== 'once') {
      const checked = current.checks.includes(day);
      return update(state, id, { planned: true, status: 'doing', checks: checked ? current.checks.filter(d => d !== day) : [...current.checks, day] }, now);
    }
    const done = current.status === 'done';
    return update(state, id, { planned: true, status: done ? 'doing' : 'done', completedAt: done ? '' : now, focusDate: done ? day : current.focusDate }, now);
  }
  function isChecked(rec, day = dayKey()) { return rec.recurrence === 'once' ? rec.status === 'done' : rec.checks.includes(day); }
  function cycleDone(rec, day) {
    if (rec.recurrence === 'daily') return rec.checks.includes(day);
    if (rec.recurrence === 'weekly') return rec.checks.some(d => d >= monday(day) && d <= day);
    if (rec.recurrence === 'monthly') return rec.checks.some(d => d.slice(0, 7) === day.slice(0, 7) && d <= day);
    return rec.status === 'done';
  }
  function isDue(rec, day = dayKey()) {
    if (rec.status === 'na' || rec.status === 'done' || !rec.planned || (rec.focusDate && rec.focusDate > day)) return false;
    if (rec.recurrence !== 'once') return !cycleDone(rec, day);
    return Boolean((rec.focusDate && rec.focusDate <= day) || (rec.dueDate && rec.dueDate <= day));
  }
  function events(state) {
    const counts = {};
    for (const rec of Object.values(state.records)) {
      if (rec.status === 'done' && rec.completedAt) {
        const day = dayKey(new Date(rec.completedAt));
        counts[day] = (counts[day] || 0) + 1;
      }
      for (const day of rec.checks) counts[day] = (counts[day] || 0) + 1;
    }
    return counts;
  }
  function merge(current, imported, now = new Date().toISOString()) {
    const next = JSON.parse(JSON.stringify(current));
    for (const [id, rec] of Object.entries(imported.records)) {
      const existing = current.records[id];
      if (!existing || (Date.parse(rec.updatedAt) || 0) >= (Date.parse(existing.updatedAt) || 0)) next.records[id] = JSON.parse(JSON.stringify(rec));
      // Check-ins are additive even when notes/status come from the newer record.
      if (existing) next.records[id].checks = [...new Set([...existing.checks, ...rec.checks])].sort();
    }
    next.updatedAt = now;
    return next;
  }
  return { KEY, SCHEMA, STATUSES, RECURRENCES, dayKey, validDay, shiftDay, monday, fresh, record, get, validate, load, save, update, complete, isChecked, cycleDone, isDue, events, merge };
});
