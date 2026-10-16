const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const G = require('../gestures.js');

test('small pointer movement stays pending until it reaches ten pixels', () => {
  for (const [dx, dy] of [[0, 0], [9, 0], [-9, 9], [9.99, -9.99]]) {
    assert.equal(G.intent(dx, dy), 'pending');
  }
  assert.equal(G.intent(10, 0), 'horizontal');
  assert.equal(G.intent(-10, 0), 'horizontal');
  assert.equal(G.intent(0, 10), 'vertical');
  assert.equal(G.intent(0, -10), 'vertical');
});

test('horizontal intent alone does not commit a short swipe', () => {
  assert.equal(G.intent(35, 3), 'horizontal');
  assert.equal(G.decision(35, 3, 320), null);
  assert.equal(G.intent(-35, -3), 'horizontal');
  assert.equal(G.decision(-35, -3, 320), null);
  assert.equal(G.decision(0, 0, 320), null);
});

test('a long drag can finish after many small movements without requiring velocity', () => {
  const rightwardPositions = [8, 20, 35, 50, 65, 79, 80];
  for (const dx of rightwardPositions.slice(0, -1)) {
    assert.equal(G.decision(dx, 4, 320), null);
  }
  assert.equal(G.decision(rightwardPositions.at(-1), 4, 320), 'take');
  assert.equal(G.decision(-80, -4, 320), 'skip');
});

test('vertical scrolling and ambiguous diagonal movement do not select a card', () => {
  for (const [dx, dy] of [[0, 150], [50, 150], [-50, -150], [100, 100], [-100, 100]]) {
    assert.equal(G.intent(dx, dy), 'vertical');
    assert.equal(G.decision(dx, dy, 320), null);
  }
  assert.equal(G.intent(130, 100), 'vertical', 'The diagonal boundary is exclusive.');
  assert.equal(G.decision(130, 100, 320), null);
  assert.equal(G.intent(131, 100), 'horizontal');
  assert.equal(G.decision(131, 100, 320), 'take');
  assert.equal(G.decision(-131, -100, 320), 'skip');
});

test('left and right swipes share the same inclusive distance boundary', () => {
  assert.equal(G.decision(79.99, 0, 320), null);
  assert.equal(G.decision(-79.99, 0, 320), null);
  assert.equal(G.decision(80, 0, 320), 'take');
  assert.equal(G.decision(-80, 0, 320), 'skip');
  assert.equal(G.decision(81, 0, 320), 'take');
  assert.equal(G.decision(-81, 0, 320), 'skip');
});

test('distance scales with the card width and stays usable on narrow and wide cards', () => {
  assert.equal(G.decision(55.99, 0, 160), null);
  assert.equal(G.decision(56, 0, 160), 'take', 'Narrow cards retain a minimum drag distance.');
  assert.equal(G.decision(-56, 0, 160), 'skip');
  assert.equal(G.decision(69.99, 0, 280), null);
  assert.equal(G.decision(70, 0, 280), 'take');
  assert.equal(G.decision(80, 0, 400), null, 'The same drag may be short on a wider card.');
  assert.equal(G.decision(99.99, 0, 400), null);
  assert.equal(G.decision(100, 0, 400), 'take');
  assert.equal(G.decision(99.99, 0, 1600), null);
  assert.equal(G.decision(100, 0, 1600), 'take', 'Wide cards cap the required drag distance.');
  assert.equal(G.decision(-100, 0, 1600), 'skip');
});

test('invalid coordinates or unusable widths never produce gesture actions', () => {
  const invalidNumbers = [NaN, Infinity, -Infinity, undefined, null, '80', {}, []];
  for (const invalid of invalidNumbers) {
    assert.equal(G.intent(invalid, 0), null);
    assert.equal(G.intent(0, invalid), null);
    assert.equal(G.decision(invalid, 0, 320), null);
    assert.equal(G.decision(100, invalid, 320), null);
    assert.equal(G.decision(100, 0, invalid), null);
  }
  assert.equal(G.decision(100, 0, 0), null);
  assert.equal(G.decision(100, 0, -320), null);
});

test('the browser global exposes the same gesture decisions as CommonJS', () => {
  const browser = vm.createContext({});
  vm.runInContext(readFileSync(path.join(__dirname, '../gestures.js'), 'utf8'), browser, {
    filename: 'gestures.js',
    timeout: 1000,
  });
  assert.equal(typeof browser.SwipeGesture.intent, 'function');
  assert.equal(typeof browser.SwipeGesture.decision, 'function');
  assert.equal(browser.SwipeGesture.intent(5, 2), 'pending');
  assert.equal(browser.SwipeGesture.intent(50, 4), 'horizontal');
  assert.equal(browser.SwipeGesture.decision(90, 4, 320), 'take');
  assert.equal(browser.SwipeGesture.decision(-90, 4, 320), 'skip');
  assert.equal(browser.SwipeGesture.decision(90, 100, 320), null);
});
