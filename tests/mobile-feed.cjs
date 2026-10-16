/*
 * Standalone WebKit regression checks. Supply Playwright through NODE_PATH.
 * QA_URL can target the local preview or another deployment of this app.
 * All progress is created in disposable browser contexts, never a user profile.
 */
const { webkit, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const { mkdtemp } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const base = new URL(process.env.QA_URL || 'http://127.0.0.1:4173/');
base.hash = '';
const FEED_KEY = 'life-in-progress.feed-session.v1';
const views = ['library', 'today', 'plan', 'review', 'settings'];
const failures = [];
let passed = 0;
let screenshotDirectory;

function feedButton(page, action) {
  return page.locator(`${action === "undo" ? ".feed-topline" : ".feed-actions"} [data-action="feed-${action}"]`);
}

async function clickFeedButton(page, action, method = 'click', options) {
  if (action !== 'undo') {
    const menu = page.locator('.feed-action-menu');
    if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
  }
  await feedButton(page, action)[method](options);
}

async function readProgress(page) {
  return page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem(LifeState.KEY) || 'null');
    return saved?.records || {};
  });
}

async function readSession(page) {
  return page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || '{"history":[],"seen":[]}'), FEED_KEY);
}

async function currentId(page) {
  await expect(page.locator('#swipe-card')).toBeVisible();
  return page.locator('#swipe-card').getAttribute('data-id');
}

async function open(page, hash = '') {
  const url = new URL(base.href);
  url.hash = hash;
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), `Preview did not load successfully: ${url.href}`);
  await expect(page.locator('#app-content')).not.toBeEmpty();
}

async function navigate(page, view) {
  const button = page.locator(`#mobile-nav [data-view="${view}"]`);
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('body')).toHaveAttribute('data-view', view);
  await expect(button).toHaveAttribute('aria-current', 'page');
}

async function historyLength(page, length) {
  await expect.poll(async () => (await readSession(page)).history.length).toBe(length);
}

async function clickAction(page, action) {
  const before = await readSession(page);
  const id = await currentId(page);
  await clickFeedButton(page, action);
  await historyLength(page, before.history.length + 1);
  await expect(page.locator('#swipe-card')).not.toHaveAttribute('data-id', id);
  await expect(feedButton(page, 'take')).toBeEnabled();
  return id;
}

async function undo(page, expectedId, expectedHistoryLength) {
  await clickFeedButton(page, 'undo');
  await historyLength(page, expectedHistoryLength);
  if (expectedId) await expect(page.locator('#swipe-card')).toHaveAttribute('data-id', expectedId);
}

async function drag(page, dx, dy, { cancel = false, steps = 10 } = {}) {
  const card = page.locator('#swipe-card');
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const rect = await card.boundingBox();
  assert.ok(rect && rect.height > 40, 'The swipe card must provide a usable drag surface.');
  // Start on the title/copy rather than on the nested detail button.
  const x = rect.x + rect.width / 2;
  const y = rect.y + Math.min(70, rect.height / 3);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps });
  if (cancel) await card.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
  await page.mouse.up();
}

async function assertStillUnchanged(page, before) {
  // Wait beyond the card's departure animation before checking for stray saves.
  await page.waitForTimeout(260);
  assert.equal(await currentId(page), before.id, 'A noncommitting gesture changed the card.');
  assert.deepEqual(await readProgress(page), before.records, 'A noncommitting gesture changed saved progress.');
  assert.deepEqual(await readSession(page), before.session, 'A noncommitting gesture changed the browsing history.');
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(dimensions.root <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1,
    `${label} overflows horizontally: ${JSON.stringify(dimensions)}`);
}

async function assertReachable(locator, label) {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      within: rect.left >= -1 && rect.right <= innerWidth + 1 && y >= 0 && y <= innerHeight,
      reachable: !!hit && (element === hit || element.contains(hit)),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hit: hit?.closest('button')?.outerHTML.slice(0, 180) || hit?.tagName || null,
    };
  });
  assert.ok(result.within && result.reachable, `${label} cannot be reached: ${JSON.stringify(result)}`);
}

async function saveNoteInDetail(page, note) {
  await expect(page.locator('#item-dialog')).toBeVisible();
  await page.locator('#item-note').fill(note);
  await page.locator('#item-form button[type="submit"]').click();
  await expect(page.locator('#item-dialog')).not.toBeVisible();
}

async function fixtureWithUnplannedNote(page) {
  const id = await currentId(page);
  await page.locator('#swipe-card [data-action="detail"]').click();
  await page.locator('#item-note').fill('先核对适用条件，再选择具体日期。<这是个人笔记>');
  await page.locator('#new-step').fill('查找原始资料并记录疑问');
  await page.locator('[data-action="add-step"]').click();
  await page.locator('#item-form button[type="submit"]').click();
  await expect(page.locator('#item-dialog')).not.toBeVisible();
  await navigate(page, 'plan');
  await page.locator(`.task-card[data-item="${id}"] .task-title`).click();
  await page.locator('[data-action="remove-plan"]').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#accept-confirm').click();
  await expect(page.locator('#item-dialog')).not.toBeVisible();
  await navigate(page, 'library');
  await expect(page.locator('#swipe-card')).toHaveAttribute('data-id', id);
  const original = (await readProgress(page))[id];
  assert.equal(original.planned, false);
  assert.equal(original.status, 'todo');
  assert.equal(original.steps.length, 1);
  return { id, original };
}

async function run(browser, name, task, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Tokyo',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
    ...options,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await task(page, context);
    assert.deepEqual(pageErrors, [], 'The browser reported JavaScript errors.');
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, message: error.stack || String(error) });
    console.error(`FAIL ${name}\n${error.stack || error}`);
    try {
      screenshotDirectory ||= await mkdtemp(path.join(os.tmpdir(), 'life-action-tracker-mobile-'));
      const screenshot = path.join(screenshotDirectory, `${String(failures.length).padStart(2, '0')}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      console.error(`Failure screenshot: ${screenshot}`);
    } catch { /* Preserve the original failure if the page/browser is gone. */ }
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    await run(browser, '390 × 844 opens one discovery card and all five bottom tabs work', async page => {
      await open(page);
      assert.equal(new URL(page.url()).hash, '', 'The initial route should be tested without a hash.');
      await expect(page.locator('body')).toHaveAttribute('data-view', 'library');
      await expect(page.locator('#swipe-card')).toHaveCount(1);
      await expect(page.locator('.library-view.is-feed')).toBeVisible();
      assert.deepEqual(await readProgress(page), {});
      for (const view of ['today', 'plan', 'review', 'settings', 'library']) {
        await assertReachable(page.locator(`#mobile-nav [data-view="${view}"]`), `${view} navigation`);
        await navigate(page, view);
        await assertNoHorizontalOverflow(page, view);
      }
      await expect(page.locator('#swipe-card')).toHaveCount(1);
    });

    await run(browser, 'left mouse/pointer drag skips one card without creating progress and undo returns it', async page => {
      await open(page);
      const id = await currentId(page);
      await drag(page, -135, 5);
      await historyLength(page, 1);
      await expect(page.locator('#swipe-card')).not.toHaveAttribute('data-id', id);
      assert.deepEqual(await readProgress(page), {});
      const session = await readSession(page);
      assert.equal(session.history[0].id, id);
      assert.equal(session.history[0].action, 'skip');
      await undo(page, id, 0);
      assert.deepEqual(await readProgress(page), {});
    });

    await run(browser, 'right drag schedules today; a reload retains undo and restores a previously absent record', async page => {
      await open(page);
      const id = await currentId(page);
      assert.equal((await readProgress(page))[id] ?? null, null);
      await drag(page, 135, 5);
      await historyLength(page, 1);
      const record = (await readProgress(page))[id];
      assert.equal(record.planned, true);
      assert.equal(record.status, 'doing');
      assert.equal(record.focusDate, await page.evaluate(() => LifeState.dayKey()));
      await navigate(page, 'today');
      await expect(page.locator(`.task-card[data-item="${id}"]`)).toBeVisible();
      await navigate(page, 'library');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#swipe-card')).toBeVisible();
      await historyLength(page, 1);
      await undo(page, id, 0);
      assert.equal((await readProgress(page))[id] ?? null, null);
      await navigate(page, 'today');
      await expect(page.locator(`.content-grid > div > .panel:first-child .task-card[data-item="${id}"]`)).toHaveCount(0);
    });

    await run(browser, 'undo after reload restores an existing note, steps and unplanned state', async page => {
      await open(page);
      const { id, original } = await fixtureWithUnplannedNote(page);
      await clickAction(page, 'take');
      assert.equal((await readProgress(page))[id].note, original.note);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#swipe-card')).toBeVisible();
      await undo(page, id, 0);
      const restored = (await readProgress(page))[id];
      const { updatedAt: originalRevision, ...originalValues } = original;
      const { updatedAt: restoredRevision, ...restoredValues } = restored;
      assert.deepEqual(restoredValues, originalValues);
      assert.ok(Date.parse(restoredRevision) >= Date.parse(originalRevision), 'Restoration keeps a current revision.');
      await page.locator('#swipe-card [data-action="detail"]').click();
      await expect(page.locator('#item-note')).toHaveValue(original.note);
      await expect(page.locator('#step-list .step-row')).toHaveCount(1);
    });

    await run(browser, 'three consecutive skips undo in reverse order using the remembered item IDs', async page => {
      await open(page);
      const skipped = [];
      for (let index = 0; index < 3; index++) skipped.push(await clickAction(page, 'skip'));
      assert.equal(new Set(skipped).size, 3);
      assert.ok(!skipped.includes(await currentId(page)));
      for (let index = 2; index >= 0; index--) await undo(page, skipped[index], index);
      assert.deepEqual(await readProgress(page), {});
    });

    await run(browser, 'short, vertical, diagonal and cancelled gestures leave the card and records unchanged', async page => {
      await open(page);
      for (const [label, dx, dy, options] of [
        ['short right', 28, 2, {}],
        ['short left', -28, -2, {}],
        ['vertical', 12, 125, {}],
        ['diagonal', 125, 125, {}],
        ['cancelled horizontal', 135, 0, { cancel: true }],
      ]) {
        const before = { id: await currentId(page), records: await readProgress(page), session: await readSession(page) };
        await drag(page, dx, dy, options);
        try { await assertStillUnchanged(page, before); }
        catch (error) { error.message = `${label}: ${error.message}`; throw error; }
      }
    });

    await run(browser, 'buttons match gestures and rapid double clicks create only one action', async page => {
      await open(page);
      const id = await currentId(page);
      await clickFeedButton(page, 'skip', 'dblclick', { delay: 20 });
      await historyLength(page, 1);
      assert.equal((await readSession(page)).history[0].id, id);
      assert.equal((await readSession(page)).history[0].action, 'skip');
      assert.deepEqual(await readProgress(page), {});
      await undo(page, id, 0);
      await clickFeedButton(page, 'take', 'dblclick', { delay: 20 });
      await historyLength(page, 1);
      const records = await readProgress(page);
      assert.deepEqual(Object.keys(records), [id]);
      assert.equal(records[id].planned, true);
      assert.equal(records[id].status, 'doing');
      assert.equal(records[id].focusDate, await page.evaluate(() => LifeState.dayKey()));
      await undo(page, id, 0);
      assert.equal((await readProgress(page))[id] ?? null, null);
    });

    await run(browser, 'search and chapter/evidence filters work in both discovery and full-list modes', async page => {
      await open(page);
      await page.locator('[data-action="toggle-feed-filters"]').click();
      await page.locator('#library-filters [name="chapter"]').selectOption('14');
      await page.locator('#library-filters [name="evidence"]').selectOption('A');
      await page.locator('#library-query').fill('密码');
      const id = await currentId(page);
      const matching = await page.evaluate(id => GUIDE_DATA.items.find(item => item.id === id), id);
      assert.equal(matching.chapter, 14);
      assert.equal(matching.evidence, 'A');
      assert.ok(`${matching.title} ${matching.raw}`.includes('密码'));
      await page.locator('[data-action="library-mode"][data-value="list"]').click();
      await expect(page.locator('.library-view.is-list')).toBeVisible();
      await expect(page.locator('#swipe-card')).toHaveCount(0);
      await expect(page.locator('#library-query')).toHaveValue('密码');
      await expect(page.locator('#library-filters [name="chapter"]')).toHaveValue('14');
      await expect(page.locator('#library-filters [name="evidence"]')).toHaveValue('A');
      assert.ok(await page.locator('#library-results .task-card').count() > 0);
      const listIds = await page.locator('#library-results .task-card').evaluateAll(cards => cards.map(card => card.dataset.item));
      const listItems = await page.evaluate(ids => GUIDE_DATA.items.filter(item => ids.includes(item.id)), listIds);
      assert.ok(listItems.every(item => item.chapter === 14 && item.evidence === 'A' && `${item.title} ${item.raw}`.includes('密码')));
      await page.locator('[data-action="library-mode"][data-value="feed"]').click();
      await expect(page.locator('#swipe-card')).toHaveAttribute('data-id', id);
      await page.locator('#library-query').fill('不存在的行动_QA_984572');
      await expect(page.locator('#swipe-card')).toHaveCount(0);
      await expect(page.locator('#library-results .empty-state')).toBeVisible();
      await page.locator('#guide-filter-panel [data-action="clear-filters"]').click();
      await expect(page.locator('#library-query')).toHaveValue('');
      await expect(page.locator('#swipe-card')).toHaveCount(1);
      await expect(page.locator('.feed-count')).toContainText('765');
      assert.deepEqual(await readProgress(page), {});
    });

    await run(browser, 'another tab editing the same item blocks stale undo without blocking earlier undo', async (page, context) => {
      await open(page);
      const skipped = await clickAction(page, 'skip');
      const taken = await clickAction(page, 'take');
      const secondTab = await context.newPage();
      await open(secondTab, 'today');
      await secondTab.locator(`.task-card[data-item="${taken}"] .task-title`).click();
      const note = '另一标签页保存的新笔记，撤销旧滑动时必须保留。';
      await saveNoteInDetail(secondTab, note);
      const latest = (await readProgress(secondTab))[taken];
      assert.equal(latest.note, note);
      await page.bringToFront();
      await undo(page, null, 1);
      await expect(page.locator('#toast')).toContainText('后来又有修改');
      assert.deepEqual((await readProgress(page))[taken], latest, 'A stale undo overwrote the other tab.');
      await undo(page, skipped, 0);
      assert.deepEqual((await readProgress(page))[taken], latest, 'Undoing the earlier skip changed unrelated saved progress.');
      await secondTab.close();
    });

    await run(browser, 'merged check-ins survive undo even when a backup kept the item revision unchanged', async (page, context) => {
      await open(page);
      const skipped = await clickAction(page, 'skip');
      const taken = await clickAction(page, 'take');
      const afterSwipe = (await readProgress(page))[taken];
      const secondTab = await context.newPage();
      await open(secondTab, 'settings');
      // Model an older backup's additive check-ins. A merge can change checks
      // without changing the newer item revision, so timestamp-only undo is unsafe.
      await secondTab.evaluate(id => {
        const saved = JSON.parse(localStorage.getItem(LifeState.KEY));
        saved.records[id].checks = [...new Set([...saved.records[id].checks, LifeState.dayKey()])];
        saved.updatedAt = new Date().toISOString();
        localStorage.setItem(LifeState.KEY, JSON.stringify(saved));
      }, taken);
      const latest = (await readProgress(secondTab))[taken];
      assert.equal(latest.updatedAt, afterSwipe.updatedAt, 'This regression requires an unchanged item revision.');
      assert.equal(latest.checks.length, 1);
      await page.bringToFront();
      await undo(page, null, 1);
      await expect(page.locator('#toast')).toContainText('后来又有修改');
      assert.deepEqual((await readProgress(page))[taken], latest, 'Undo removed a merged check-in.');
      await undo(page, skipped, 0);
      assert.deepEqual((await readProgress(page))[taken], latest);
      await secondTab.close();
    });

    await run(browser, 'leaving discovery while a save waits for another tab cancels the old swipe', async (page, context) => {
      await open(page);
      const locker = await context.newPage();
      await open(locker, 'settings');
      await locker.evaluate(() => new Promise(ready => {
        navigator.locks.request(LifeState.KEY, () => {
          ready(true);
          return new Promise(release => { window.releaseTestLock = release; });
        });
      }));
      try {
        await clickFeedButton(page, 'take');
        await page.waitForTimeout(250);
        await navigate(page, 'plan');
      } finally { await locker.evaluate(() => window.releaseTestLock()); }
      await expect.poll(() => locker.evaluate(async () => (await navigator.locks.query()).held.filter(lock => lock.name === LifeState.KEY).length)).toBe(0);
      await page.waitForTimeout(100);
      assert.deepEqual(await readProgress(page), {}, 'A cancelled swipe still created a plan.');
      await historyLength(page, 0);
      await navigate(page, 'library');
      await expect(feedButton(page, 'take')).toBeEnabled();
      await locker.close();
    });

    await run(browser, 'a failed progress save retains the current card and undo history', async page => {
      await page.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'life-in-progress.v1') throw new DOMException('Storage full', 'QuotaExceededError');
          return original.call(this, key, value);
        };
      });
      await open(page);
      const id = await currentId(page);
      await clickFeedButton(page, 'take');
      await expect(page.locator('#toast')).toContainText('保存失败');
      await expect(feedButton(page, 'take')).toBeEnabled();
      assert.equal(await currentId(page), id);
      assert.deepEqual(await readProgress(page), {});
      assert.equal((await readSession(page)).history.length, 0);
    });

    await run(browser, 'clearing progress removes personal undo snapshots in every open tab', async (page, context) => {
      await open(page);
      await fixtureWithUnplannedNote(page);
      await clickAction(page, 'take');
      assert.ok((await readSession(page)).history[0].before.note);
      const second = await context.newPage();
      await open(second);
      await clickAction(second, 'take');
      await historyLength(second, 1);
      await navigate(page, 'settings');
      await page.locator('[data-action="reset"]').click();
      await page.locator('#accept-confirm').click();
      await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), FEED_KEY)).toBe(null);
      await expect.poll(() => second.evaluate(key => sessionStorage.getItem(key), FEED_KEY)).toBe(null);
      assert.deepEqual(await readProgress(page), {});
      await navigate(page, 'library');
      await expect(feedButton(page, 'undo')).toBeDisabled();
      await expect(feedButton(second, 'undo')).toBeDisabled();
      await second.close();
    });

    await run(browser, 'browser bars and keyboard viewport changes keep the card above in-flow tabs', async page => {
      await page.addInitScript(() => {
        const viewport = new EventTarget();
        viewport.height = innerHeight;
        viewport.offsetTop = 0;
        window.testViewport = viewport;
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      });
      await open(page);
      for (const { height, top } of [{ height: 640, top: 0 }, { height: 520, top: 0 }, { height: 380, top: 60 }]) {
        await page.evaluate(({ height, top }) => {
          window.testViewport.height = height;
          window.testViewport.offsetTop = top;
          window.testViewport.dispatchEvent(new Event('resize'));
          window.testViewport.dispatchEvent(new Event('scroll'));
        }, { height, top });
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-viewport-height').trim())).toBe(`${height}px`);
        const boxes = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
          return { shell: rect('.main-shell'), card: rect('#swipe-card'), tabs: rect('#mobile-nav'), hint: rect('.feed-hint'), tabPosition: getComputedStyle(document.querySelector('#mobile-nav')).position };
        });
        assert.ok(Math.abs(boxes.shell.top - top) <= 1 && Math.abs(boxes.shell.height - height) <= 1);
        assert.equal(boxes.tabPosition, 'static', 'Feed tabs must consume layout space rather than overlay the card.');
        assert.ok(boxes.tabs.bottom <= top + height + 1);
        assert.ok(boxes.card.bottom <= boxes.tabs.top && boxes.hint.bottom <= boxes.tabs.top);
        await expect(page.locator('.feed-actions')).not.toBeVisible();
        await assertReachable(feedButton(page, 'undo'), 'undo above the card');
        for (const view of views) await assertReachable(page.locator(`#mobile-nav [data-view="${view}"]`), `${view} in-flow tab`);
      }
    });

    for (const viewport of [
      { width: 320, height: 480 },
      { width: 320, height: 568 },
      { width: 390, height: 600 },
      { width: 375, height: 812 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 844, height: 390 },
    ]) {
      await run(browser, `${viewport.width} × ${viewport.height} layout has no horizontal overflow and reachable bottom controls`, async page => {
        await open(page);
        for (const view of views) {
          await assertReachable(page.locator(`#mobile-nav [data-view="${view}"]`), `${view} bottom tab`);
          await navigate(page, view);
          await assertNoHorizontalOverflow(page, `${viewport.width} × ${viewport.height} ${view}`);
        }
        await navigate(page, 'library');
        await page.locator('[data-action="library-mode"][data-value="feed"]').click();
        await expect(page.locator('#swipe-card')).toHaveCount(1);
        await expect(page.locator('.feed-action-menu')).not.toHaveAttribute('open', '');
        await expect(page.locator('.feed-actions')).not.toBeVisible();
        await assertReachable(feedButton(page, 'undo'), 'persistent undo');
        await assertReachable(page.locator('.feed-action-menu > summary'), 'more actions');
        await page.locator('.feed-action-menu > summary').click();
        for (const action of ['skip', 'undo', 'take']) {
          await assertReachable(feedButton(page, action), `${action} card control`);
        }
        await assertNoHorizontalOverflow(page, `${viewport.width} × ${viewport.height} discovery`);
      }, { viewport });
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ passed, failed: failures.length, url: base.href, screenshots: screenshotDirectory || null }));
  if (failures.length) process.exitCode = 1;
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
