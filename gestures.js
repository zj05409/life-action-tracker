/* Displacement-only swipe rules shared by the browser UI and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SwipeGesture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function intent(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const x = Math.abs(dx);
    const y = Math.abs(dy);
    if (Math.max(x, y) < 10) return 'pending';
    return x > y * 1.3 ? 'horizontal' : 'vertical';
  }

  function decision(dx, dy, width) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(width) || width <= 0) return null;
    const distance = Math.abs(dx);
    const threshold = Math.max(56, Math.min(100, width * 0.25));
    if (distance < threshold || distance <= Math.abs(dy) * 1.3) return null;
    return dx > 0 ? 'take' : 'skip';
  }

  return { intent, decision };
});
