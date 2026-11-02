const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createDimensionPoller = require('../js/dimension-poll.js');

function harness(overrides = {}) {
  let now = 0, nextId = 1, busy = false;
  const timers = new Map(), calls = [], updates = [], completions = [], errors = [];
  const poller = createDimensionPoller({
    setTimeout(fn, delay) { const id = nextId++; timers.set(id, { time: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    request(script, callback) { calls.push({ script, callback }); },
    getBusy() { return busy; },
    onUpdate(data) { updates.push(data); },
    onComplete(data) { completions.push(data); },
    onError(message, data) { errors.push({ message, data }); },
    ...overrides
  });
  function advance(duration = 450) {
    const end = now + duration;
    while (true) {
      const next = [...timers].filter(([, entry]) => entry.time <= end).sort((a, b) => a[1].time - b[1].time)[0];
      if (!next) break;
      now = next[1].time;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  }
  function reply(data, index = calls.length - 1) { calls[index].callback(JSON.stringify(data)); }
  return { poller, timers, calls, updates, completions, errors, advance, reply, setBusy(value) { busy = value; } };
}

test('polling is single flight and repeated start with same token is idempotent', () => {
  const h = harness();
  h.poller.start('session');
  h.advance(449);
  assert.equal(h.calls.length, 0);
  h.advance(1);
  h.poller.start('session');
  h.advance(4500);
  assert.equal(h.calls.length, 1);
  h.reply({ active: true, phase: 'waitingStart', pointCount: 0, neededPoints: 3 });
  h.advance();
  assert.equal(h.calls.length, 2);
});

test('polling defers while another host operation is busy', () => {
  const h = harness();
  h.setBusy(true);
  h.poller.start('session');
  h.advance(4500);
  assert.equal(h.calls.length, 0);
  h.setBusy(false);
  h.advance();
  assert.equal(h.calls.length, 1);
});

test('stop invalidates pending callbacks and cancels subsequent polling', () => {
  const h = harness();
  h.poller.start('session');
  h.advance();
  h.poller.stop();
  h.reply({ active: false, completed: true, count: 1 });
  h.advance(4500);
  assert.equal(h.poller.isRunning(), false);
  assert.equal(h.completions.length, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(h.calls.length, 1);
});

test('new token ignores old response and waits for its host request to settle', () => {
  const h = harness();
  h.poller.start('old');
  h.advance();
  h.poller.start('new');
  h.advance(4500);
  assert.equal(h.calls.length, 1);
  h.reply({ error: 'old error', active: true, autoPaused: true }, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.poller.isRunning(), true);
  h.advance();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].script, 'toolDimensionPickPoll("new")');
  h.reply({ active: true, phase: 'waitingEnd', pointCount: 1 });
  assert.equal(h.updates.length, 1);
});

test('phase progress is delivered only when meaningful state changes', () => {
  const h = harness();
  h.poller.start('session');
  const statuses = [
    { active: true, phase: 'waitingStart', pointCount: 0, neededPoints: 3, msg: '起点' },
    { active: true, phase: 'waitingEnd', pointCount: 1, neededPoints: 3, msg: '终点' },
    { active: true, phase: 'waitingPlacement', pointCount: 2, neededPoints: 3, msg: '位置' },
    { active: true, phase: 'invalid', pointCount: 4, neededPoints: 3, msg: '重新取点' },
    { active: true, phase: 'documentChanged', pointCount: 4, neededPoints: 3, msg: '切换回来' }
  ];
  for (const status of statuses) {
    h.advance(); h.reply(status);
    h.advance(); h.reply({ ...status, timestamp: Date.now() });
  }
  assert.deepEqual(h.updates, statuses);
});

test('completion is delivered once and stops polling even for duplicate callback', () => {
  const h = harness();
  h.poller.start('session'); h.advance();
  const result = { active: false, completed: true, count: 1, dimensionCount: 1, warnings: ['字体回退'] };
  h.reply(result); h.reply(result);
  h.advance(4500);
  assert.deepEqual(h.completions, [result]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.poller.isRunning(), false);
});

test('automatic pause error stops without retrying a host mutation', () => {
  const h = harness();
  h.poller.start('session'); h.advance();
  const result = { error: '生成失败', active: true, autoPaused: true };
  h.reply(result); h.advance(4500);
  assert.deepEqual(h.errors, [{ message: '生成失败', data: result }]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.poller.isRunning(), false);
});

test('cancelled or closed session updates UI and stops without completion', () => {
  for (const result of [{ active: false, cancelled: true }, { active: false, phase: 'closed' }]) {
    const h = harness();
    h.poller.start('session'); h.advance(); h.reply(result); h.advance(4500);
    assert.deepEqual(h.updates, [result]);
    assert.equal(h.completions.length, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.poller.isRunning(), false);
  }
});

test('invalid host responses stop polling without retry', () => {
  for (const raw of ['EvalScript error.', '', 'null', '[]', '{}', 'true', '{"active":"true"}', undefined]) {
    const h = harness();
    h.poller.start('session'); h.advance(); h.calls[0].callback(raw); h.advance(4500);
    assert.equal(h.errors.length, 1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.poller.isRunning(), false);
  }
});

test('injected CEP parser accepts wrapped JSON for progress and completion', () => {
  const context = { window: {}, console: { warn() {}, log() {} }, buildDimensionPanel() {} };
  vm.createContext(context);
  for (const file of ['CSInterface.js', 'main.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'), context);
  }
  const h = harness({ parseResponse: context.parseEvalJson });
  h.poller.start('session'); h.advance();
  h.calls[0].callback('CEP prefix {"active":true,"phase":"waitingEnd","pointCount":1} suffix');
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].phase, 'waitingEnd');
  h.advance();
  h.calls[1].callback('CEP prefix {"active":false,"completed":true,"dimensionCount":1} suffix');
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].dimensionCount, 1);
  assert.equal(h.poller.isRunning(), false);
  assert.equal(h.errors.length, 0);
});

test('injected parser failures and invalid parsed structures still stop polling', () => {
  const parsers = [
    () => { throw new Error('invalid wrapper'); },
    () => null,
    () => [],
    () => ({ active: 'true' })
  ];
  for (const parseResponse of parsers) {
    const h = harness({ parseResponse });
    h.poller.start('session'); h.advance(); h.calls[0].callback('wrapped response'); h.advance(4500);
    assert.equal(h.errors.length, 1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.poller.isRunning(), false);
  }
});

test('transport exception stops polling without retry', () => {
  let attempts = 0;
  const h = harness({ request() { attempts++; throw new Error('CEP disconnected'); } });
  h.poller.start('session'); h.advance(4500);
  assert.equal(attempts, 1);
  assert.match(h.errors[0].message, /CEP disconnected/);
  assert.equal(h.poller.isRunning(), false);
});

test('empty tokens do not poll, and starting empty cancels a previous session', () => {
  const h = harness();
  h.poller.start(''); h.advance();
  assert.equal(h.calls.length, 0);
  h.poller.start('session'); h.poller.start(null); h.advance();
  assert.equal(h.calls.length, 0);
  assert.equal(h.poller.isRunning(), false);
});

test('session token is safely quoted for JSX and cannot inject another call', () => {
  const h = harness();
  const token = '\" ); dangerous(); // \\ \n\u2028\u2029';
  h.poller.start(token); h.advance();
  let received;
  vm.runInNewContext(h.calls[0].script, { toolDimensionPickPoll(value) { received = value; } });
  assert.equal(received, token);
  assert.equal(/[\u2028\u2029]/.test(h.calls[0].script), false);
});

test('browser build exposes createDimensionPoller without a module system', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/dimension-poll.js'), 'utf8'), context);
  assert.equal(typeof context.createDimensionPoller, 'function');
});

test('CEP mixed context exposes the browser global alongside CommonJS export', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/dimension-poll.js'), 'utf8');
  const context = { module: { exports: {} } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(typeof context.window.createDimensionPoller, 'function');
  assert.equal(context.module.exports, context.window.createDimensionPoller);
  assert.equal(vm.runInContext('typeof createDimensionPoller', context), 'function');
});

test('consumer may stop during update without scheduling another request', () => {
  let h;
  h = harness({ onUpdate() { h.poller.stop(); } });
  h.poller.start('session'); h.advance(); h.reply({ active: true, phase: 'waitingStart' });
  h.advance(4500);
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});
