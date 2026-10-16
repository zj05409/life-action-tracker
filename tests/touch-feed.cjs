/*
 * Native WebKit touch regression checks. Run with Playwright available through NODE_PATH.
 * QA_URL defaults to the local preview; every case uses a disposable browser context.
 *
 * Playwright's public touchscreen API only exposes taps. The private in-process
 * adapter below reaches WebKit's Input.dispatchTouchEvent protocol, which routes
 * through native touch hit testing, implicit pointer capture, and Pointer Events.
 * This suite deliberately fails if that entry point is unavailable. It never
 * substitutes mouse events or synthetic DOM dispatchEvent for a finger swipe.
 *
 * Protocol: https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/webkit/protocol.d.ts
 * Native implementation: https://github.com/microsoft/playwright/blob/v1.62.1/browser_patches/webkit/patches/bootstrap.diff
 */
const assert = require('node:assert/strict');
const playwright = require('playwright');
const { expect } = require('playwright/test');

const base = new URL(process.env.QA_URL || 'http://127.0.0.1:4173/');
base.hash = 'library';
const FEED_KEY = 'life-in-progress.feed-session.v1';
const failures = [];
let passed = 0;

function nativeTouchSession(page) {
  const connection = page._connection;
  assert.equal(typeof connection?.toImpl, 'function', 'Native touch requires Playwright in-process connection.toImpl; no mouse fallback is allowed.');
  const impl = connection.toImpl(page);
  const session = (impl?.delegate || impl?._delegate)?._pageProxySession;
  assert.equal(typeof session?.send, 'function', 'The WebKit page-proxy session is unavailable; native touch coverage cannot run.');
  return session;
}

async function readSaved(page) {
  return page.evaluate(key => ({
    records: JSON.parse(localStorage.getItem(LifeState.KEY) || '{"records":{}}').records,
    session: JSON.parse(sessionStorage.getItem(key) || '{"history":[],"seen":[]}'),
  }), FEED_KEY);
}

async function currentId(page) {
  await expect(page.locator('#swipe-card')).toBeVisible();
  return page.locator('#swipe-card').getAttribute('data-id');
}

async function visiblePoint(locator) {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate(element => {
    const card = element.closest('#swipe-card');
    if (!card) throw new Error('The touch start must be inside the swipe card.');
    const bounds = element.getBoundingClientRect();
    let left = Math.max(bounds.left + 4, 30);
    let right = Math.min(bounds.right - 4, innerWidth - 30);
    let top = Math.max(bounds.top + 4, 4);
    let bottom = Math.min(bounds.bottom - 4, innerHeight - 4);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clip = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left + 3); right = Math.min(right, clip.right - 3); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top + 3); bottom = Math.min(bottom, clip.bottom - 3); }
    }
    const nav = document.querySelector('#mobile-nav');
    if (nav) bottom = Math.min(bottom, nav.getBoundingClientRect().top - 4);
    if (right - left < 8 || bottom - top < 8) throw new Error('The requested title/body touch target has no unobstructed visible area.');
    const x = Math.round((left + right) / 2);
    const y = Math.round(top + Math.min(18, (bottom - top) / 2));
    const hit = document.elementFromPoint(x, y);
    if (!hit || !element.contains(hit)) throw new Error(`Touch start is covered by ${hit?.tagName || 'nothing'} instead of the requested card text.`);
    if (hit === card) throw new Error('The regression must start on a text child, not card padding.');
    return { x, y };
  });
}

async function swipe(page, selector, dx, dy = 0, { cancel = false, shouldDrag = false } = {}) {
  const session = nativeTouchSession(page);
  const start = await visiblePoint(page.locator(selector));
  const id = 7;
  let last = { ...start, id };
  let active = false;
  let dragged = false;
  await page.evaluate(() => { window.__nativeTouchTrace = []; });
  try {
    // WebKit expects the released/cancelled point on touchEnd/touchCancel too.
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [last], modifiers: 0 });
    active = true;
    for (let step = 1; step <= 12; step++) {
      last = { x: Math.round(start.x + dx * step / 12), y: Math.round(start.y + dy * step / 12), id };
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [last], modifiers: 0 });
      const displacement = await page.locator('#swipe-card').evaluate(card => Number.parseFloat(card.style.getPropertyValue('--swipe-x')) || 0);
      if (Math.abs(displacement) >= 20) dragged = true;
      await page.waitForTimeout(16);
    }
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [last], modifiers: 0 });
    active = false;
  } finally {
    if (active) await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [last], modifiers: 0 }).catch(() => {});
  }
  const trace = await page.evaluate(() => window.__nativeTouchTrace);
  assert.ok(trace.some(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted && event.button === 0 && event.primary), `No trusted primary touch pointerdown was observed: ${JSON.stringify(trace)}`);
  assert.ok(trace.some(event => ['pointermove', 'pointercancel'].includes(event.type) && event.pointerType === 'touch' && event.trusted), `Native touch did not generate a pointer stream: ${JSON.stringify(trace)}`);
  if (shouldDrag) {
    assert.ok(dragged, `The card never followed a finger moving over its text: ${JSON.stringify(trace)}`);
    assert.ok(trace.some(event => event.type === 'pointerup' && event.pointerType === 'touch' && event.trusted), `The committing finger swipe never reached a trusted pointerup: ${JSON.stringify(trace)}`);
  }
  return trace;
}

async function undo(page, expectedId) {
  const control = page.locator('[data-action="feed-undo"]:visible').first();
  await expect(control).toBeEnabled();
  await control.tap();
  await expect.poll(async () => (await readSaved(page)).session.history.length).toBe(0);
  await expect(page.locator('#swipe-card')).toHaveAttribute('data-id', expectedId);
}

async function run(browser, name, task) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block', reducedMotion: 'no-preference' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      window.__nativeTouchTrace = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
        document.addEventListener(type, event => {
          window.__nativeTouchTrace.push({ type, target: event.target.id || event.target.className || event.target.tagName, pointerType: event.pointerType, trusted: event.isTrusted, button: event.button, primary: event.isPrimary });
        }, true);
      }
    });
    const response = await page.goto(base.href, { waitUntil: 'domcontentloaded' });
    assert.ok(response?.ok(), `Preview did not load: ${base.href}`);
    await expect(page.locator('.library-view.is-feed')).toBeVisible();
    nativeTouchSession(page);
    await task(page);
    assert.deepEqual(errors, [], 'The page reported JavaScript errors.');
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, message: error.stack || String(error) });
    console.error(`FAIL ${name}\n${error.stack || error}`);
    console.error('Native touch trace:', JSON.stringify(await page.evaluate(() => window.__nativeTouchTrace).catch(() => null)));
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await playwright.webkit.launch({ headless: true });
  try {
    for (const [label, selector] of [['title', '#swipe-card .feed-card-title'], ['body text', '#swipe-card .feed-summary']]) {
      await run(browser, `native touch left swipe starting on ${label} skips once and undo returns it`, async page => {
        const id = await currentId(page);
        await swipe(page, selector, -120, 0, { shouldDrag: true });
        await expect.poll(async () => (await readSaved(page)).session.history.length).toBe(1);
        await expect(page.locator('#swipe-card')).not.toHaveAttribute('data-id', id);
        assert.deepEqual((await readSaved(page)).records, {});
        await undo(page, id);
        assert.deepEqual((await readSaved(page)).records, {});
      });
      await run(browser, `native touch right swipe starting on ${label} plans once and undo removes the new record`, async page => {
        const id = await currentId(page);
        await swipe(page, selector, 120, 0, { shouldDrag: true });
        await expect.poll(async () => (await readSaved(page)).session.history.length).toBe(1);
        const saved = (await readSaved(page)).records;
        assert.deepEqual(Object.keys(saved), [id]);
        assert.equal(saved[id].planned, true);
        assert.equal(saved[id].status, 'doing');
        await undo(page, id);
        assert.deepEqual((await readSaved(page)).records, {});
      });
    }
    for (const [name, selector, dx, dy, options] of [
      ['short finger motion', '#swipe-card .feed-card-title', 24, 0, {}],
      ['vertical finger scroll', '#swipe-card .feed-summary', 4, -110, {}],
      ['cancelled native touch', '#swipe-card .feed-card-title', 120, 0, { cancel: true }],
    ]) {
      await run(browser, `${name} does not skip or plan a card`, async page => {
        const id = await currentId(page);
        const before = await readSaved(page);
        await swipe(page, selector, dx, dy, options);
        await page.waitForTimeout(300);
        assert.equal(await currentId(page), id);
        assert.deepEqual(await readSaved(page), before);
      });
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ passed, failed: failures.length, url: base.href, input: 'WebKit native Input.dispatchTouchEvent', mouseFallback: false }));
  if (failures.length) process.exitCode = 1;
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
