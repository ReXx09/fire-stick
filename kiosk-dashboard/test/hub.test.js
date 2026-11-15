const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hub = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('disabled screensaver stays off after activity and clears an active screen', () => {
  const start = hub.lastIndexOf('(function(){', hub.indexOf("const ss  = document.getElementById('screensaver')"));
  const end = hub.indexOf('})();', start) + '})();'.length;
  assert.ok(start >= 0 && end > start);
  const events = {};
  const timers = new Map();
  let nextTimer = 0;
  const classes = new Set();
  const ss = { classList: {
    add: value => classes.add(value),
    remove: value => classes.delete(value),
    contains: value => classes.has(value)
  } };
  const document = {
    body: { style: {} },
    getElementById: id => id === 'screensaver' ? ss : {},
    addEventListener: (name, handler) => { events[name] = handler; }
  };
  const window = {};
  vm.runInNewContext(hub.slice(start, end), {
    window, document,
    setInterval: () => 0,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id)
  });
  window._initScreensaver(false, 2);
  events.keydown();
  assert.equal(timers.size, 0);
  window._initScreensaver(true, 2);
  assert.equal(timers.size, 1);
  const [id, show] = [...timers][0];
  timers.delete(id);
  show();
  assert.equal(classes.has('active'), true);
  window._initScreensaver(false, 2);
  events.mousemove();
  assert.equal(classes.has('active'), false);
  assert.equal(timers.size, 0);
});

test('D-pad leaves input arrow keys alone but still navigates tiles', () => {
  const typingStart = hub.indexOf('function isTypingTarget(');
  const typingEnd = hub.indexOf('\n    function getRemoteAction', typingStart);
  const handlerStart = hub.indexOf("document.addEventListener('keydown', function (e)", hub.indexOf('Fire TV D-Pad'));
  const handlerEnd = hub.indexOf('\n\n      // Erste Kachel', handlerStart);
  assert.ok(typingStart >= 0 && typingEnd > typingStart && handlerStart >= 0 && handlerEnd > handlerStart);
  class Element {
    constructor(typing) { this.typing = typing; }
    closest() { return this.typing ? this : null; }
  }
  let handler;
  let focused = false;
  const tile = { focus: () => { focused = true; } };
  const document = {
    activeElement: null,
    addEventListener: (_name, fn) => { handler = fn; },
    querySelector: () => tile
  };
  vm.runInNewContext(hub.slice(typingStart, typingEnd) + '\n' + hub.slice(handlerStart, handlerEnd), {
    document, Element, focusables: () => [tile]
  });
  let prevented = false;
  handler({ key: 'ArrowLeft', target: new Element(true), preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(focused, false);
  handler({ key: 'ArrowRight', target: new Element(false), preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(focused, true);
});
