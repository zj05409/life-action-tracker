(() => {
  'use strict';
  const D = globalThis.GUIDE_DATA;
  const S = globalThis.LifeState;
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plain = text => String(text || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#]/g, '').replace(/<!--[^]*?-->/g, '').trim();
  const truncate = (value, count = 100) => { const text = plain(value); return text.length > count ? `${text.slice(0, count)}…` : text; };
  const icons = {
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>', plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 4 4L19 6"/>',
    book: '<path d="M12 5v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v14c-4-1-6 0-9 2-3-2-5-3-9-2Z"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="m12 12 8-8"/>',
    leaf: '<path d="M5 19C0 8 9 3 21 3c0 13-6 19-13 15M5 21 16 10"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    repeat: '<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>', settings: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.leaf}</svg>`;
  const ids = new Set(D.items.map(item => item.id));
  const byId = new Map(D.items.map(item => [item.id, item]));
  const chapters = new Map(D.chapters.map(ch => [ch.id, ch]));
  const statusText = { todo: '待行动', doing: '进行中', done: '已完成', na: '暂不适用' };
  const cycleText = { once: '一次性行动', daily: '每天', weekly: '每周', monthly: '每月' };
  const views = { today: '今日行动', library: '完整指南', plan: '我的计划', review: '进度回顾', settings: '数据与设置' };
  let storageWarning = '';
  let state;
  try { state = S.load(localStorage, ids); }
  catch (error) {
    state = S.fresh();
    storageWarning = '浏览器中的旧进度无法读取。原数据已保留；请先在“数据与设置”导出原始数据，再恢复备份。';
  }
  let view = Object.hasOwn(views, location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  let filters = { query: '', chapter: '', evidence: '', money: '', time: '', status: '', group: '', quick: '' };
  let planStatus = 'active';
  let page = 1;
  let dialogId = '';
  let dialogRevision = '';
  let savedDraft = '';
  let toastTimer;
  const date = () => S.dayKey();
  const rec = id => S.get(state, id);
  const formatDate = day => day ? new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : '';
  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3600);
  }
  function exclusive(operation) {
    return navigator.locks ? navigator.locks.request(S.KEY, operation) : Promise.resolve().then(operation);
  }
  async function commit(operation, message) {
    const apply = () => {
      if (storageWarning) { toast('请先导出原始数据并恢复备份，避免覆盖尚未读取的进度。'); return false; }
      let before = JSON.stringify(state);
      try {
        // Re-read inside the cross-tab lock so unrelated edits cannot overwrite each other.
        state = S.load(localStorage, ids);
        before = JSON.stringify(state);
        operation();
        S.save(localStorage, state);
      } catch (error) {
        state = JSON.parse(before);
        if (error.code === 'CONFLICT') {
          confirmAction('这个事项在另一标签页更新了', '本页草稿已保留。继续保存将使用本页的状态、日期、笔记和步骤，其他标签页的打卡仍会保留。', '保存本页草稿', () => saveDetail(error.today, true));
        } else toast('保存失败，修改未生效。请检查浏览器存储空间或隐私设置，并先导出备份。');
        return false;
      }
      render();
      if (message) toast(message);
      return true;
    };
    return exclusive(apply);
  }
  function navigate(next) {
    if (!Object.hasOwn(views, next)) return;
    view = next;
    if (location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
    $('#sidebar').classList.remove('is-open');
    $('#mobile-menu').setAttribute('aria-expanded', 'false');
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function tag(text, type = '') { return `<span class="tag ${type}">${esc(text)}</span>`; }
  function button(label, action, id = '', type = 'secondary', symbol = '') {
    return `<button type="button" class="button ${type}" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}>${symbol ? icon(symbol) : ''}${label}</button>`;
  }
  function empty(title, body, action = '') {
    return `<div class="empty-state"><div class="empty-icon">${icon('leaf')}</div><h3>${title}</h3><p>${body}</p>${action}</div>`;
  }
  function heading(eyebrow, title, subtitle, action = '') {
    return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</div>`;
  }
  function metrics() {
    const records = D.items.map(item => rec(item.id));
    const done = records.filter(r => r.status === 'done').length;
    const na = records.filter(r => r.status === 'na').length;
    const planned = records.filter(r => r.planned && !['done', 'na'].includes(r.status)).length;
    const habits = records.filter(r => r.planned && r.recurrence !== 'once' && !['done', 'na'].includes(r.status));
    const activity = S.events(state);
    const start = S.monday(date());
    const week = Object.entries(activity).filter(([day]) => day >= start && day <= date()).reduce((sum, [, count]) => sum + count, 0);
    const covered = new Set(D.items.filter(item => rec(item.id).status === 'done').map(item => item.chapter)).size;
    return { done, na, planned, habits, activity, week, covered, total: D.items.length - na };
  }
  function statCards(m) {
    const values = [
      ['target', m.planned, '正在推进', '把注意力留给眼前的几件事'],
      ['check', m.done, '已完成事项', `占适用事项的 ${m.total ? Math.round(m.done / m.total * 100) : 0}%`],
      ['repeat', `${m.week}<small> / ${state.preferences.weeklyGoal}</small>`, '本周行动次数', '完成事项与习惯打卡均计入'],
      ['book', `${m.covered}<small> / ${D.chapters.length}</small>`, '已实践章节', '完成至少一项即点亮章节']
    ];
    return `<div class="stat-grid">${values.map(([symbol, value, label, caption]) => `<article class="stat-card"><span class="stat-icon">${icon(symbol)}</span><div class="stat-value">${value}</div><div class="stat-label">${label}</div><p class="stat-caption">${caption}</p></article>`).join('')}</div>`;
  }
  function card(item, compact = false) {
    const r = rec(item.id);
    const checked = S.isChecked(r, date());
    const cycleChecked = r.recurrence !== 'once' && S.cycleDone(r, date());
    const overdue = r.dueDate && r.dueDate < date() && !['done', 'na'].includes(r.status);
    return `<article class="task-card${checked ? ' completed' : ''}" data-item="${esc(item.id)}">
      ${r.planned && r.status !== 'na' ? `<button type="button" class="task-check${checked ? ' is-done' : ''}" data-action="complete" data-id="${item.id}" aria-label="${checked ? '撤销完成：' : '完成或打卡：'}${esc(item.title)}" aria-pressed="${checked}">${checked ? icon('check') : ''}</button>` : `<span class="task-number">${String(item.chapter).padStart(2, '0')}</span>`}
      <div class="task-body"><div class="task-meta"><span>第 ${item.chapter} 章 · 第 ${item.number} 条</span>${r.planned || r.status === 'na' ? tag(statusText[r.status], r.status === 'done' ? 'green' : 'muted') : ''}${item.evidence ? tag(`${item.evidence} 级证据`, 'green') : ''}${r.recurrence !== 'once' ? tag(cycleText[r.recurrence]) : ''}${overdue ? tag('已到期', 'amber') : ''}${cycleChecked && !checked ? tag('本周期已打卡', 'green') : ''}</div>
      <button type="button" class="task-title" data-action="detail" data-id="${item.id}">${esc(item.title)}</button>
      ${!compact ? `<p class="task-summary">${esc(truncate(item.summary, 110))}</p>` : ''}
      <div class="card-footer"><span>${item.tags.money ? `花钱${esc(item.tags.money) === '无' ? '：无' : `：${esc(item.tags.money)}`}` : ''}${item.tags.time ? ` · 用时：${esc(item.tags.time)}` : ''}${r.dueDate ? ` · ${formatDate(r.dueDate)}前` : ''}</span><div class="task-actions">${!r.planned && r.status !== 'na' ? button('加入计划', 'add', item.id, 'ghost small', 'plus') : ''}${r.planned && !['done', 'na'].includes(r.status) && !S.isDue(r, date()) && !checked ? button('今天做', 'focus', item.id, 'ghost small') : ''}${button('查看', 'detail', item.id, 'ghost small', 'arrow')}</div></div></div></article>`;
  }
  function panel(title, content, action = '', caption = '') {
    return `<section class="panel"><div class="panel-heading"><div><h2 class="panel-title">${title}</h2>${caption ? `<p class="subtitle">${caption}</p>` : ''}</div>${action}</div>${content}</section>`;
  }
  function todayView() {
    const m = metrics();
    const due = D.items.filter(item => S.isDue(rec(item.id), date()));
    const checked = D.items.filter(item => {
      const r = rec(item.id);
      return r.status !== 'na' && (r.checks.includes(date()) || (r.status === 'done' && r.completedAt && S.dayKey(new Date(r.completedAt)) === date()));
    });
    const welcome = m.done || m.planned ? '每一个小行动，都在让生活变好。' : '把读过的道理，变成过好的日常。';
    const suggestions = [
      D.items.find(i => i.chapter === 14 && /双重|两步|二次|双因素/.test(i.title)),
      D.items.find(i => i.chapter === 3 && /通知/.test(i.title)),
      D.items.find(i => i.chapter === 1 && /安全带/.test(i.title))
    ].filter(Boolean).filter(i => !rec(i.id).planned && rec(i.id).status !== 'na').slice(0, 3);
    const goal = Math.min(100, Math.round(m.week / state.preferences.weeklyGoal * 100));
    return `${heading('A LITTLE BETTER, EVERY DAY', '今天，也好好生活。', '不必一下做完。选一件值得做的小事，就从这里开始。')}
      <section class="hero"><div class="hero-copy"><span class="hero-note">你的个人生活实践手册</span><h2>${welcome}</h2><p>从 ${D.items.length} 条建议中，找到适合自己的下一步。<br>把大目标拆小，把小行动坚持下去。</p><div class="hero-actions">${button('去挑选下一步', 'library', '', 'primary', 'arrow')}${button('查看我的计划', 'plan', '', 'ghost')}</div><span class="hero-footnote">进度自动保存在当前浏览器 · 随时可以备份</span></div><div class="hero-visual" aria-hidden="true"><span>01</span><span>02</span><span>03</span><div class="plant"><i></i><i></i><i></i><i></i></div><div class="visual-caption">one step at a time.</div></div></section>
      ${statCards(m)}<div class="content-grid"><div>${panel(`今日待办 <span class="filter-count">${due.length}</span>`, due.length ? `<div class="task-list">${due.map(i => card(i, true)).join('')}</div>` : empty('给今天留一个小目标', '在指南中挑选事项，加入计划后点“今天做”。', button('浏览完整指南', 'library', '', 'secondary', 'plus')), button('管理计划', 'plan', '', 'ghost small', 'arrow'))}
      ${checked.length ? panel('今天已经做到', `<div class="task-list">${checked.map(i => card(i, true)).join('')}</div>`) : ''}
      ${suggestions.length ? panel('可以从这些小事开始', `<p class="subtitle panel-intro">挑一件与你有关的事。这里只是入口，随时可以换一个。</p><div class="task-list">${suggestions.map(i => card(i)).join('')}</div>`, tag('轻松起步', 'green')) : ''}</div>
      <aside>${panel('本周的小目标', `<div class="weekly-value">${m.week}<span> / ${state.preferences.weeklyGoal} 次行动</span></div><div class="progress-bar"><div class="progress-fill" style="width:${goal}%"></div></div><p class="subtitle">${m.week >= state.preferences.weeklyGoal ? '这周的目标达成了，记得给自己一点肯定。' : `再行动 ${state.preferences.weeklyGoal - m.week} 次，就达成本周目标。`}</p><div class="habit-days">${Array.from({ length: 7 }, (_, i) => { const day = S.shiftDay(S.monday(date()), i); return `<div><span>${'一二三四五六日'[i]}</span><div class="habit-dot${m.activity[day] ? ' active' : ''}${day === date() ? ' current' : ''}" title="${day} · ${m.activity[day] || 0} 次">${m.activity[day] ? icon('check') : ''}</div></div>`; }).join('')}</div>`, button('调整', 'settings', '', 'ghost small'))}
      ${panel('让行动更容易发生', `<div class="note-box"><span class="note-number">01 / 选择</span><h3>先挑最适合你的</h3><p>用花钱、用时和章节筛选，从眼前能做到的开始。</p></div><div class="note-box"><span class="note-number">02 / 拆小</span><h3>写下具体的下一步</h3><p>每条建议都可以添加自己的步骤、时间和笔记。</p></div><div class="note-box"><span class="note-number">03 / 重复</span><h3>好习惯，慢慢养成</h3><p>持续行动可设为每天、每周或每月，完成后打卡。</p></div>`)}
      <p class="small-note">指南是一份备选单。暂不适用的事项可以先放下，也计入你的整理进度。</p></aside></div>`;
  }
  const groups = { health: [1, 2, 3, 13, 16, 24, 28, 34], money: [5, 6, 7, 12, 19, 23, 26, 31], family: [10, 17, 18, 20, 25, 27, 29, 30, 33], life: [4, 8, 9, 11, 14, 15, 21, 22, 32] };
  function filteredItems() {
    const words = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return D.items.filter(item => {
      const r = rec(item.id);
      return (!filters.chapter || item.chapter === Number(filters.chapter)) && (!filters.evidence || item.evidence === filters.evidence) && (!filters.money || item.tags.money === filters.money) && (!filters.time || item.tags.time === filters.time) && (!filters.status || r.status === filters.status) && (!filters.group || groups[filters.group].includes(item.chapter)) && (!filters.quick || (!['多', '中'].includes(item.tags.money) && item.tags.time === '少' && item.tags.willpower === '否')) && words.every(word => `${item.title} ${item.summary} ${item.cost} ${item.raw} ${chapters.get(item.chapter).title}`.toLowerCase().includes(word));
    });
  }
  function select(name, label, options, current, extra = '') {
    return `<label class="field"><span class="field-label">${label}</span><select ${extra} name="${name}" aria-label="${label}"><option value="">全部${label}</option>${options.map(([value, text]) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
  }
  function libraryResults() {
    const items = filteredItems();
    const pages = Math.max(1, Math.ceil(items.length / 15));
    page = Math.min(page, pages);
    return `<div class="results-heading"><p class="subtitle">找到 <strong>${items.length}</strong> 条建议 · 第 ${page} / ${pages} 页</p><p class="subtitle">A / B / C 为原指南的证据分级</p></div><div class="task-list">${items.length ? items.slice((page - 1) * 15, page * 15).map(i => card(i)).join('') : empty('暂时没有匹配的事项', '试着减少筛选条件，或换一个关键词。', button('清除筛选', 'clear-filters'))}</div>${pages > 1 ? `<div class="pagination"><button class="button secondary small" data-action="prev-page"${page === 1 ? ' disabled' : ''}>上一页</button><span>第 ${page} / ${pages} 页</span><button class="button secondary small" data-action="next-page"${page === pages ? ' disabled' : ''}>下一页</button></div>` : ''}`;
  }
  function libraryView() {
    const money = [...new Set(D.items.map(i => i.tags.money).filter(Boolean))].sort();
    const time = [...new Set(D.items.map(i => i.tags.time).filter(Boolean))].sort();
    return `${heading('YOUR GUIDE TO A BETTER EVERYDAY', '完整指南', `${D.chapters.length} 个章节，${D.items.length} 条建议。每一条，都可以成为你的下一步。`)}
      <div class="filter-group">${[['', '全部领域'], ['health', '健康与安全'], ['money', '金钱与工作'], ['family', '关系与家庭'], ['life', '生活与权益']].map(([key, label]) => `<button class="chip${filters.group === key ? ' active' : ''}" data-action="group" data-value="${key}">${label}</button>`).join('')}<button class="chip${filters.quick ? ' active' : ''}" data-action="quick">${icon('leaf')}低成本 · 少用时</button></div>
      <section class="panel filter-panel"><label class="field library-search"><span class="field-label">搜一件你在意的事</span><input id="library-query" class="search-input" type="search" placeholder="搜索建议、正文或章节，比如：睡眠、密码、租房…" value="${esc(filters.query)}"></label><div class="toolbar" id="library-filters">${select('chapter', '章节', D.chapters.map(c => [c.id, `${c.id}. ${c.title}`]), filters.chapter)}${select('evidence', '证据', ['A', 'B', 'C'].map(v => [v, `${v} 级`]), filters.evidence)}${select('money', '花钱', money.map(v => [v, v]), filters.money)}${select('time', '用时', time.map(v => [v, v]), filters.time)}${select('status', '状态', Object.entries(statusText), filters.status)}${button('重置', 'clear-filters', '', 'ghost small')}</div></section><section id="library-results" class="panel">${libraryResults()}</section>`;
  }
  function planView() {
    const items = D.items.filter(item => { const r = rec(item.id); if (!r.planned && r.status !== 'na') return false; return planStatus === 'all' || (planStatus === 'active' ? !['done', 'na'].includes(r.status) : planStatus === 'habit' ? r.recurrence !== 'once' && !['done', 'na'].includes(r.status) : r.status === planStatus); }).sort((a, b) => (rec(a.id).dueDate || '9999').localeCompare(rec(b.id).dueDate || '9999'));
    const habitCount = D.items.filter(i => rec(i.id).planned && rec(i.id).recurrence !== 'once' && !['done', 'na'].includes(rec(i.id).status)).length;
    return `${heading('MAKE ROOM FOR WHAT MATTERS', '我的计划', '留几件想做的事在这里。安排时间、拆成步骤，然后慢慢完成。', button('添加事项', 'library', '', 'primary', 'plus'))}<div class="filter-group">${[['active', '待推进'], ['doing', '进行中'], ['habit', `持续习惯 ${habitCount}`], ['done', '已完成'], ['na', '暂不适用'], ['all', '全部']].map(([key, label]) => `<button class="chip${planStatus === key ? ' active' : ''}" data-action="plan-status" data-value="${key}">${label}</button>`).join('')}</div><section class="panel"><div class="results-heading"><span class="subtitle">${items.length} 件事项${planStatus === 'active' ? ' · 按截止日期排序' : ''}</span>${tag('计划由你决定', 'green')}</div>${items.length ? `<div class="task-list">${items.map(i => card(i)).join('')}</div>` : empty('这里还没有事项', '不必列很长的清单。先从一两件真正想做的开始。', button('去指南中挑选', 'library', '', 'primary', 'plus'))}</section>`;
  }
  function reviewView() {
    const m = metrics();
    const days = Array.from({ length: 84 }, (_, i) => S.shiftDay(date(), i - 83));
    const activeDays = Object.keys(m.activity).filter(d => d <= date() && m.activity[d] > 0).length;
    let streak = 0;
    let cursor = m.activity[date()] ? date() : S.shiftDay(date(), -1);
    while (m.activity[cursor]) { streak++; cursor = S.shiftDay(cursor, -1); }
    return `${heading('LOOK HOW FAR YOU HAVE COME', '每一步，都算数。', '回头看看，生活正在被这些小小的行动改变。')}${statCards(m)}<section class="panel"><div class="panel-heading"><div><h2 class="panel-title">最近 12 周的行动足迹</h2><p class="subtitle">累计行动 ${activeDays} 天 · 当前连续 ${streak} 天</p></div><span class="tag green">${formatDate(days[0])} — 今天</span></div><div class="activity-grid" aria-label="最近84天行动记录">${days.map(day => `<div tabindex="0" class="activity-day level-${Math.min(4, m.activity[day] || 0)}" title="${day}：${m.activity[day] || 0} 次行动" aria-label="${day}：${m.activity[day] || 0} 次行动"><span>${Number(day.slice(-2))}</span></div>`).join('')}</div><div class="heatmap-legend"><span>少</span>${[0, 1, 2, 3, 4].map(n => `<i class="activity-day level-${n}"></i>`).join('')}<span>多</span><span class="legend-note">完成事项或一次习惯打卡 = 1 次行动</span></div></section><div class="panel-heading chapter-heading"><h2 class="panel-title">逐章点亮你的生活</h2><span class="subtitle">${m.na} 条暂不适用 · ${m.total} 条纳入完成进度</span></div><div class="chapter-grid">${D.chapters.map(ch => {
      const items = D.items.filter(i => i.chapter === ch.id);
      const done = items.filter(i => rec(i.id).status === 'done').length;
      const na = items.filter(i => rec(i.id).status === 'na').length;
      const total = items.length - na;
      return `<button class="chapter-card${done ? ' active' : ''}" data-action="chapter" data-value="${ch.id}"><span class="chapter-number">${String(ch.id).padStart(2, '0')}${done ? icon('leaf') : ''}</span><h3>${esc(ch.title)}</h3><span class="subtitle">${done} / ${total} 已完成${na ? ` · ${na} 暂不适用` : ''}</span><div class="progress-bar"><div class="progress-fill" style="width:${total ? done / total * 100 : 0}%"></div></div></button>`;
    }).join('')}</div>`;
  }
  function settingsView() {
    return `${heading('YOUR PROGRESS, IN YOUR HANDS', '数据与设置', '进度属于你。给自己的努力留一份备份，也按自己的节奏调整目标。')}<div class="settings-grid">${panel('进度备份', `<p class="subtitle">进度保存在当前浏览器，不会上传到 GitHub。更换浏览器、清理网站数据前，请先导出备份。</p><div class="settings-actions">${button('导出 JSON 备份', 'export', '', 'primary', 'download')}<label class="button secondary" for="import-file">导入备份</label><input id="import-file" type="file" accept="application/json,.json" hidden></div><p class="small-note">导入采用合并：同一事项保留更新时间较新的状态、笔记与步骤，打卡日期取并集。当前周目标保持不变。</p>${storageWarning ? `<div class="note-box"><p>${esc(storageWarning)}</p>${button('导出浏览器原始数据', 'export-raw', '', 'secondary small')}${button('从有效备份恢复', 'recover', '', 'secondary small')}</div>` : ''}`)}
      ${panel('给本周一个小目标', `<form id="goal-form" class="inline-form"><label class="field"><span class="field-label">每周行动次数（完成事项 + 习惯打卡）</span><input type="number" name="goal" min="1" max="100" required value="${state.preferences.weeklyGoal}"></label><button class="button primary" type="submit">保存目标</button></form><p class="small-note">目标是提醒，不是考核。默认每周 5 次，可以随时调整。</p>`)}
      ${panel('关于这份指南', `<div class="detail-field"><span class="field-label">原始内容</span><p><a href="${D.meta.repository}" target="_blank" rel="noopener noreferrer">eternity4719 / HowToLiveBetter ${icon('arrow')}</a></p></div><div class="details-grid"><div><span class="field-label">本地快照</span><p>${esc(D.meta.syncedAt.slice(0, 10))} · ${D.items.length} 条</p></div><div><span class="field-label">固定版本</span><p><a href="${D.meta.repository}/tree/${D.meta.commit}" target="_blank" rel="noopener noreferrer">${D.meta.commit.slice(0, 12)}</a></p></div></div><p class="small-note">正文按 <a href="${D.meta.licenseUrl}" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> 使用。原文内容保留，已转为行动卡片并添加个人计划、步骤和打卡功能。本工具为独立衍生项目。完整内容许可见 <a href="CONTENT-LICENSE.txt" target="_blank">许可文件</a>。</p><p class="small-note">适用条件请看每条原文及备注；指南中的法律、医保和社保制度按中国大陆编写，办理时需核对当地现行规定。</p>`)}
      ${panel('使用与安装', `<p class="subtitle">在这台 Mac 的 Safari 或 Chrome 中收藏当前页面，随时打开。Safari 可通过“文件 → 添加到程序坞”作为独立窗口使用。</p><p class="small-note">首次通过 HTTPS 或 localhost 打开后会缓存应用和指南，离线也能查看和打卡。不同网站地址及不同浏览器的进度各自保存；需要迁移时使用 JSON 备份。</p><p class="small-note">浏览器不会在页面关闭时发送打卡提醒。你设置的日期会在下次打开“今日行动”时显示。</p>`)}
      ${panel('清空进度', `<p class="subtitle">清空会移除计划、笔记、步骤和所有打卡。建议先导出一份备份。</p>${button('清空本浏览器进度', 'reset', '', 'ghost danger')}`)}</div>`;
  }
  function render() {
    document.title = `${views[view]} · 好好生活`;
    $('#today-label').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    $('#view-eyebrow').textContent = views[view];
    document.querySelectorAll('[data-view]').forEach(nav => {
      nav.classList.toggle('active', nav.dataset.view === view);
      if (nav.dataset.view === view) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
    });
    $('#app-content').innerHTML = `${storageWarning ? `<div class="storage-warning" role="alert">${esc(storageWarning)} ${button('前往数据与设置', 'settings', '', 'ghost small')}</div>` : ''}${({ today: todayView, library: libraryView, plan: planView, review: reviewView, settings: settingsView })[view]()}`;
    const m = metrics();
    $('#sidebar-progress').innerHTML = `<span>生活实践进度</span><strong>${m.done}<small> / ${m.total}</small></strong><div class="progress-bar"><div class="progress-fill" style="width:${m.total ? m.done / m.total * 100 : 0}%"></div></div><p>${m.na ? `${m.na} 条暂不适用，` : ''}按自己的节奏前进</p>`;
  }
  function inlineMarkdown(text, item) {
    // Render only links and text; never accept upstream/backup HTML as markup.
    const token = /\[([^\]]+)\]\(([^\s)]+)\)|<(https?:\/\/[^>]+)>|(https?:\/\/[^\s<>]+)/g;
    let html = '', start = 0, match;
    while ((match = token.exec(text))) {
      html += esc(text.slice(start, match.index));
      let url = match[2] || match[3] || match[4];
      const label = match[1] || url;
      try {
        const file = chapters.get(item.chapter).file;
        url = new URL(url, `${D.meta.repository}/blob/${D.meta.commit}/${file}`).href;
        html += /^https?:/.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
      } catch { html += esc(label); }
      start = token.lastIndex;
    }
    return html + esc(text.slice(start));
  }
  function openDetail(id) {
    const item = byId.get(id);
    if (!item) return;
    dialogId = id;
    const r = rec(id);
    $('#dialog-content').innerHTML = `<div class="breadcrumb">第 ${item.chapter} 章 · ${esc(chapters.get(item.chapter).title)} / 第 ${item.number} 条</div><h2 id="item-title">${esc(item.title)}</h2><div class="task-meta">${tag(`${item.evidence} 级证据`, 'green')}${tag(`花钱：${item.tags.money || '未标注'}`)}${tag(`用时：${item.tags.time || '未标注'}`)}${tag(`毅力：${item.tags.willpower || '未标注'}`)}</div><div class="detail-summary"><span class="field-label">原文 · 说人话</span><p>${inlineMarkdown(item.summary, item)}</p></div>${item.tags.audience ? `<p class="small-note">原文人群标签：${esc(item.tags.audience)}</p>` : ''}
      <form id="item-form"><div class="details-grid"><label class="field"><span class="field-label">行动状态</span><select name="status">${Object.entries(statusText).map(([key, text]) => `<option value="${key}"${r.status === key ? ' selected' : ''}>${key === 'done' && r.recurrence !== 'once' ? '已完成（结束此习惯）' : text}</option>`).join('')}</select></label><label class="field"><span class="field-label">行动周期</span><select name="recurrence">${Object.entries(cycleText).map(([key, text]) => `<option value="${key}"${r.recurrence === key ? ' selected' : ''}>${text}</option>`).join('')}</select></label><label class="field"><span class="field-label">计划开始日期</span><input type="date" name="focusDate" value="${r.focusDate}"></label><label class="field"><span class="field-label">截止日期（可选）</span><input type="date" name="dueDate" value="${r.dueDate}"></label></div><div class="detail-field"><label class="field" for="item-note"><span class="field-label">我的行动笔记</span></label><textarea id="item-note" name="note" rows="3" maxlength="20000" placeholder="我为什么想做？下一步准备怎么做？">${esc(r.note)}</textarea></div><div class="detail-field"><span class="field-label">把行动拆成更小的步骤</span><div id="step-list">${r.steps.map(step => stepRow(step)).join('')}</div><div class="inline-form"><input id="new-step" aria-label="新的行动步骤" type="text" maxlength="500" placeholder="例如：查找需要的资料，安排一个时间"><button type="button" class="button secondary small" data-action="add-step">${icon('plus')}添加步骤</button></div></div><div class="dialog-actions"><button type="submit" class="button primary">${r.planned ? '保存计划' : '保存并加入计划'}</button>${button('今天做', 'save-focus', id, 'secondary')}${r.planned ? button('移出计划', 'remove-plan', id, 'ghost small') : ''}</div><p class="small-note">笔记、日期与步骤在点击保存后生效。重复行动每周期完成一次即可，频率以原文为准。设为“已完成”会结束此习惯；恢复为“进行中”可继续。</p></form>
      ${r.checks.length ? `<div class="detail-field"><span class="field-label">最近打卡（点日期可撤销）</span><div class="filter-group">${r.checks.slice(-20).reverse().map(day => `<button class="chip active" data-action="remove-check" data-day="${day}" data-id="${id}" title="撤销 ${day} 的打卡">${day} ×</button>`).join('')}</div></div>` : ''}
      <details class="source-content"><summary>查看完整原文、适用条件与来源</summary>${item.fields.filter(f => f.label !== '说人话').map(field => `<div class="detail-field"><h3>${esc(field.label)}</h3><div>${inlineMarkdown(field.text, item)}</div></div>`).join('')}<a class="button secondary small" href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">在 GitHub 查看固定版本原文 ${icon('arrow')}</a></details>`;
    $('#item-dialog').setAttribute('aria-labelledby', 'item-title');
    if (!$('#item-dialog').open) $('#item-dialog').showModal();
    dialogRevision = r.updatedAt;
    savedDraft = detailDraft();
    $('#item-dialog').scrollTop = 0;
  }
  function stepRow(step) {
    return `<div class="step-row" data-step-id="${esc(step.id)}"><label><input type="checkbox"${step.done ? ' checked' : ''}><span>${esc(step.title)}</span></label><button type="button" class="icon-button" data-action="remove-step" aria-label="删除步骤：${esc(step.title)}">${icon('close')}</button></div>`;
  }
  function detailDraft() {
    const form = $('#item-form');
    if (!form) return '';
    return JSON.stringify({ values: [...new FormData(form)], steps: [...document.querySelectorAll('#step-list .step-row')].map(row => [row.dataset.stepId, row.querySelector('input').checked, row.querySelector('span').textContent]), step: $('#new-step').value });
  }
  function requestDetailClose() {
    if (detailDraft() !== savedDraft) confirmAction('离开前保存这些修改？', '笔记、日期和步骤还有尚未保存的编辑。可以取消后保存，也可以舍弃本次编辑。', '舍弃本次编辑', () => $('#item-dialog').close());
    else $('#item-dialog').close();
  }
  async function saveDetail(today = false, force = false) {
    const form = $('#item-form');
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const current = rec(dialogId);
    const status = values.get('status');
    const recurrence = values.get('recurrence');
    const steps = Array.from(document.querySelectorAll('#step-list .step-row')).map(row => ({ id: row.dataset.stepId, title: row.querySelector('span').textContent, done: row.querySelector('input').checked }));
    const unsavedStep = $('#new-step').value.trim();
    if (unsavedStep) steps.push({ id: `s${crypto.randomUUID().replace(/-/g, '')}`, title: unsavedStep, done: false });
    if (steps.length > 100) { toast('每个事项最多保留 100 个步骤。'); return; }
    const ok = await commit(() => {
      if (!force && rec(dialogId).updatedAt !== dialogRevision) { const error = new Error('conflict'); error.code = 'CONFLICT'; error.today = today; throw error; }
      S.update(state, dialogId, { status: today && ['done', 'na'].includes(status) ? 'doing' : status, planned: status !== 'na' || today, recurrence, focusDate: today ? date() : values.get('focusDate'), dueDate: values.get('dueDate'), note: values.get('note'), steps, completedAt: status === 'done' && !today ? current.completedAt || new Date().toISOString() : '' });
    }, today ? '已加入今日行动' : '计划已保存');
    if (ok) $('#item-dialog').close();
  }
  function download(text, name, mime = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function exportData() {
    if (storageWarning) {
      try { download(localStorage.getItem(S.KEY) || '{}', `好好生活-原始数据-${date()}.json`); toast('已导出尚未解析的原始数据，请保留后再恢复。'); }
      catch { toast('浏览器禁止读取数据，请检查存储权限。'); }
      return;
    }
    download(JSON.stringify({ ...state, exportedAt: new Date().toISOString(), guideCommit: D.meta.commit }, null, 2), `好好生活-进度备份-${date()}.json`);
    toast('备份已导出，请妥善保存');
  }
  function confirmAction(title, description, label, callback, danger = false) {
    $('#confirm-content').innerHTML = `<h2 id="confirm-title">${esc(title)}</h2><p>${esc(description)}</p><div class="dialog-actions"><button class="button secondary" id="cancel-confirm">取消</button><button class="button ${danger ? 'danger' : 'primary'}" id="accept-confirm">${esc(label)}</button></div>`;
    $('#confirm-dialog').setAttribute('aria-labelledby', 'confirm-title');
    $('#cancel-confirm').onclick = () => $('#confirm-dialog').close();
    $('#accept-confirm').onclick = () => { $('#confirm-dialog').close(); callback(); };
    $('#confirm-dialog').showModal();
  }
  async function importFile(file, recover = false) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast('备份文件过大，请选择本工具导出的 JSON 文件。'); return; }
    try {
      const parsed = S.validate(JSON.parse(await file.text()), ids);
      const count = Object.keys(parsed.state.records).length;
      if (!count) { toast('这份备份没有可恢复的事项记录，当前数据未改变。'); return; }
      confirmAction(recover ? '从备份恢复进度？' : '合并这份备份？', `已识别 ${count} 条事项记录${parsed.unknown ? `，另有 ${parsed.unknown} 条不属于当前指南，已跳过` : ''}。${recover ? '将用这份备份恢复当前浏览器，请确认已导出原始数据。' : '保留较新的状态和笔记，合并所有打卡；当前其他事项不会删除。'}`, recover ? '恢复进度' : '确认合并', async () => {
        if (recover) {
          await exclusive(() => {
            const previous = state;
            try { S.save(localStorage, parsed.state); state = parsed.state; storageWarning = ''; render(); toast('进度已恢复'); }
            catch { state = previous; toast('恢复失败，浏览器数据未改变。'); }
          });
        } else commit(() => { state = S.merge(state, parsed.state); }, '备份已合并');
      });
    } catch (error) { toast(`导入失败：${error.message.includes('JSON') ? '文件不是有效的 JSON 备份。' : error.message}`); }
  }
  let recovering = false;
  document.addEventListener('click', event => {
    if ($('#sidebar').classList.contains('is-open') && !event.target.closest('#sidebar, .mobile-menu')) {
      $('#sidebar').classList.remove('is-open');
      $('#mobile-menu').setAttribute('aria-expanded', 'false');
    }
    const nav = event.target.closest('[data-view]');
    if (nav) { navigate(nav.dataset.view); return; }
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.action) {
      case 'today': case 'library': case 'plan': case 'review': case 'settings': navigate(el.dataset.action); break;
      case 'detail': openDetail(id); break;
      case 'add': commit(() => S.update(state, id, { planned: true, status: 'todo' }), '已加入我的计划；点“今天做”可安排到今天'); break;
      case 'focus': commit(() => S.update(state, id, { planned: true, status: 'doing', focusDate: date() }), '已加入今日行动'); break;
      case 'complete': {
        const checked = S.isChecked(rec(id), date());
        commit(() => S.complete(state, id), checked ? '已撤销，可继续推进' : rec(id).recurrence === 'once' ? '又完成了一件事，真好。' : '今天的打卡已记下'); break;
      }
      case 'group': filters.group = el.dataset.value; filters.chapter = ''; page = 1; render(); break;
      case 'quick': filters.quick = filters.quick ? '' : 'easy'; page = 1; render(); break;
      case 'clear-filters': filters = { query: '', chapter: '', evidence: '', money: '', time: '', status: '', group: '', quick: '' }; page = 1; render(); break;
      case 'prev-page': page--; $('#library-results').innerHTML = libraryResults(); $('#library-results').scrollIntoView({ block: 'start' }); break;
      case 'next-page': page++; $('#library-results').innerHTML = libraryResults(); $('#library-results').scrollIntoView({ block: 'start' }); break;
      case 'plan-status': planStatus = el.dataset.value; render(); break;
      case 'chapter': filters = { query: '', chapter: el.dataset.value, evidence: '', money: '', time: '', status: '', group: '', quick: '' }; page = 1; navigate('library'); break;
      case 'save-focus': saveDetail(true); break;
      case 'remove-plan': confirmAction('将事项移出计划？', '已保存的笔记、步骤和打卡会保留，事项可以随时重新加入。当前尚未保存的编辑将舍弃。', '移出计划', async () => { if (await commit(() => S.update(state, id, { planned: false, status: 'todo', focusDate: '', dueDate: '', completedAt: '' }), '已移出计划')) $('#item-dialog').close(); }); break;
      case 'add-step': {
        const value = $('#new-step').value.trim();
        if (!value) { $('#new-step').focus(); return; }
        if (document.querySelectorAll('.step-row').length >= 100) { toast('最多添加 100 个步骤'); return; }
        $('#step-list').insertAdjacentHTML('beforeend', stepRow({ id: `s${crypto.randomUUID().replace(/-/g, '')}`, title: value, done: false }));
        $('#new-step').value = ''; $('#new-step').focus(); break;
      }
      case 'remove-step': el.closest('.step-row').remove(); break;
      case 'remove-check': {
        const day = el.dataset.day;
        confirmAction('撤销这次打卡？', `将移除 ${day} 的打卡。当前尚未保存的编辑将舍弃。`, '撤销打卡', async () => { if (await commit(() => S.update(state, id, { checks: rec(id).checks.filter(d => d !== day) }), '已撤销这次打卡')) openDetail(id); }); break;
      }
      case 'export': exportData(); break;
      case 'export-raw': try { download(localStorage.getItem(S.KEY) || '{}', `好好生活-原始数据-${date()}.json`); } catch { toast('浏览器禁止读取存储，请检查浏览器设置。'); } break;
      case 'recover': recovering = true; $('#import-file').click(); break;
      case 'reset': confirmAction('清空当前浏览器的全部进度？', '所有计划、笔记、步骤、习惯打卡和周目标都会清空。此操作无法撤销；导出的备份可以重新导入。', '清空进度', async () => exclusive(() => {
        try { localStorage.removeItem(S.KEY); state = S.fresh(); storageWarning = ''; render(); toast('进度已清空'); } catch { toast('清空失败，请检查浏览器设置。'); }
      }), true); break;
    }
  });
  document.addEventListener('change', event => {
    if (event.target.closest('#library-filters')) { filters[event.target.name] = event.target.value; page = 1; $('#library-results').innerHTML = libraryResults(); }
    if (event.target.id === 'import-file') { importFile(event.target.files[0], recovering); recovering = false; event.target.value = ''; }
    if (event.target.name === 'recurrence' && event.target.closest('#item-form')) {
      const option = $('#item-form [name="status"] option[value="done"]');
      option.textContent = event.target.value === 'once' ? '已完成' : '已完成（结束此习惯）';
    }
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'library-query') { filters.query = event.target.value; page = 1; $('#library-results').innerHTML = libraryResults(); }
  });
  document.addEventListener('submit', event => {
    if (event.target.id === 'item-form') { event.preventDefault(); saveDetail(); }
    if (event.target.id === 'goal-form') {
      event.preventDefault();
      const goal = Number(new FormData(event.target).get('goal'));
      if (Number.isInteger(goal) && goal >= 1 && goal <= 100) commit(() => { state.preferences.weeklyGoal = goal; state.updatedAt = new Date().toISOString(); }, '每周目标已保存');
    }
    if (event.target.id === 'global-search-form') { event.preventDefault(); filters = { query: $('#global-search').value, chapter: '', evidence: '', money: '', time: '', status: '', group: '', quick: '' }; page = 1; navigate('library'); }
  });
  document.addEventListener('keydown', event => {
    if (event.target.id === 'new-step' && event.key === 'Enter') { event.preventDefault(); document.querySelector('[data-action="add-step"]').click(); }
    if (event.key === '/' && !event.target.closest('input, textarea, select') && !$('#item-dialog').open && !$('#confirm-dialog').open) { event.preventDefault(); $('#global-search').focus(); }
    if (event.key === 'Escape') { $('#sidebar').classList.remove('is-open'); $('#mobile-menu').setAttribute('aria-expanded', 'false'); }
  });
  $('#export-top').addEventListener('click', exportData);
  $('#close-dialog').addEventListener('click', event => { event.preventDefault(); requestDetailClose(); });
  $('#item-dialog').addEventListener('cancel', event => { event.preventDefault(); requestDetailClose(); });
  document.querySelector('.mobile-menu')?.addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('is-open');
    document.querySelector('.mobile-menu').setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (Object.hasOwn(views, next)) { view = next; render(); } });
  window.addEventListener('storage', event => {
    if (event.key !== S.KEY) return;
    try { state = S.load(localStorage, ids); storageWarning = ''; render(); toast($('#item-dialog').open ? '另一标签页的进度已同步，本页未保存的草稿已保留。' : '另一标签页的修改已同步'); }
    catch { storageWarning = '另一标签页写入的数据无法读取，请先导出原始数据。'; render(); }
  });
  let lastDate = date();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && lastDate !== date()) { lastDate = date(); render(); } });
  setInterval(() => { if (lastDate !== date()) { lastDate = date(); render(); } }, 60000);
  render();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').then(registration => {
      registration.addEventListener('updatefound', () => { const worker = registration.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) toast('有新版本可用，下次重新打开页面时更新。'); }); });
    }).catch(() => toast('离线缓存未启用，联网使用与进度保存不受影响。'));
  }
})();
