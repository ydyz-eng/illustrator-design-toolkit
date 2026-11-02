const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the production bridge guard in isolation: the rest of app.js builds
// the panel DOM and is unrelated to CEP request ordering.
function guardedBridge(host) {
  const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const start = source.indexOf('  var originalEval = csInterface.evalScript;');
  const end = source.indexOf('  var nav = document.getElementById("tabBar")', start);
  assert.ok(start >= 0 && end > start, 'The host guard must remain identifiable');
  const classes = new Set();
  const attributes = {};
  const context = vm.createContext({
    hostBusy: false,
    hostBackground: false,
    csInterface: {evalScript: host},
    document: {
      body: {classList: {add(name) { classes.add(name); }, remove(name) { classes.delete(name); }}},
      getElementById(id) {
        assert.equal(id, 'contentArea');
        return {setAttribute(name, value) { attributes[name] = value; }};
      }
    }
  });
  vm.runInContext(source.slice(start, end), context, {filename: 'app.js:host-guard'});
  return {context, bridge: context.csInterface, classes, attributes};
}

test('cancel waits for a background poll and executes exactly once even if the poll replies twice', () => {
  const requests = [];
  const state = guardedBridge((script, reply) => requests.push({script, reply}));
  const replies = [];
  state.bridge.evalScript('toolDimensionPickPoll("session")', value => replies.push(['poll', value]), {background: true});
  state.bridge.evalScript('toolDimensionPickCancel("session")', value => replies.push(['cancel', value]));

  assert.equal(requests.length, 1, 'Cancel must not overlap the native poll');
  assert.equal(state.context.hostBusy, true);
  assert.equal(state.context.hostBackground, true);
  assert.equal(state.classes.has('host-busy'), false, 'Polls must leave Cancel clickable');

  requests[0].reply('{"active":true,"pointCount":1}');
  assert.equal(requests.length, 2);
  assert.match(requests[1].script, /PickCancel/);
  assert.equal(state.context.hostBackground, false);
  assert.equal(state.classes.has('host-busy'), true);
  assert.equal(state.attributes['aria-busy'], 'true');

  requests[0].reply('{"active":true,"pointCount":2}');
  assert.equal(requests.length, 2);
  assert.equal(replies.length, 1);
  assert.equal(state.context.hostBusy, true, 'A late poll callback must not unlock Cancel');

  requests[1].reply('{"active":false}');
  requests[1].reply('{"active":false}');
  assert.deepEqual(replies, [['poll', '{"active":true,"pointCount":1}'], ['cancel', '{"active":false}']]);
  assert.equal(state.context.hostBusy, false);
  assert.equal(state.context.hostBackground, false);
  assert.equal(state.classes.has('host-busy'), false);
  assert.equal(state.attributes['aria-busy'], 'false');
});

test('foreground requests queued behind a poll drain in order without concurrent host calls', () => {
  const requests = [];
  let active = 0;
  const state = guardedBridge((script, done) => {
    assert.equal(active, 0, 'Only one native request may run at a time');
    active++;
    requests.push({script, reply(value) { active--; done(value); }});
  });
  const results = [];
  state.bridge.evalScript('poll', () => results.push('poll'), {background: true});
  state.bridge.evalScript('cancel', () => results.push('cancel'));
  state.bridge.evalScript('recover', () => results.push('recover'));
  assert.deepEqual(requests.map(request => request.script), ['poll']);
  requests[0].reply('ok');
  assert.deepEqual(requests.map(request => request.script), ['poll', 'cancel']);
  requests[1].reply('ok');
  assert.deepEqual(requests.map(request => request.script), ['poll', 'cancel', 'recover']);
  requests[2].reply('ok');
  assert.deepEqual(results, ['poll', 'cancel', 'recover']);
  assert.equal(active, 0);
  assert.equal(state.context.hostBusy, false);
});

test('a consumer callback exception still starts the queued cancel and leaves it protected', () => {
  const requests = [];
  const state = guardedBridge((script, reply) => requests.push({script, reply}));
  let pollCallbacks = 0;
  let cancelCallbacks = 0;
  state.bridge.evalScript('poll', () => {
    pollCallbacks++;
    throw new Error('consumer rendering failed');
  }, {background: true});
  state.bridge.evalScript('cancel', () => { cancelCallbacks++; });

  assert.throws(() => requests[0].reply('{"active":true}'), /consumer rendering failed/);
  assert.deepEqual(requests.map(request => request.script), ['poll', 'cancel']);
  assert.equal(state.context.hostBusy, true, 'Cancel must own the guard despite the consumer exception');
  assert.equal(state.context.hostBackground, false);
  assert.equal(state.classes.has('host-busy'), true);

  assert.doesNotThrow(() => requests[0].reply('{"active":true}'));
  assert.equal(pollCallbacks, 1);
  assert.equal(requests.length, 2);
  assert.equal(state.context.hostBusy, true);
  requests[1].reply('{"active":false}');
  assert.equal(cancelCallbacks, 1);
  assert.equal(state.context.hostBusy, false);
  assert.equal(state.classes.has('host-busy'), false);
  assert.equal(state.attributes['aria-busy'], 'false');
});

test('overlapping polls and operations during a foreground mutation are rejected without disturbing it', () => {
  const requests = [];
  const state = guardedBridge((script, reply) => requests.push({script, reply}));
  let overlapError;
  state.bridge.evalScript('poll', () => {}, {background: true});
  state.bridge.evalScript('poll-again', value => { overlapError = JSON.parse(value).error; }, {background: true});
  assert.match(overlapError, /上一项操作/);
  assert.equal(requests.length, 1);
  requests[0].reply('ok');

  state.bridge.evalScript('generate', () => {});
  let mutationError;
  state.bridge.evalScript('other-mutation', value => { mutationError = JSON.parse(value).error; });
  assert.match(mutationError, /上一项操作/);
  assert.equal(requests.length, 2);
  assert.equal(state.context.hostBusy, true);
  assert.equal(state.classes.has('host-busy'), true);
  requests[1].reply('ok');
  assert.equal(state.context.hostBusy, false);
});

test('a synchronous CEP transport exception releases the guard so the next request can proceed', () => {
  let attempts = 0;
  const state = guardedBridge((script, reply) => {
    attempts++;
    if (attempts === 1) throw new Error('transport unavailable');
    reply('{"count":1}');
  });
  const results = [];
  state.bridge.evalScript('generate', value => results.push(JSON.parse(value)));
  assert.match(results[0].error, /transport unavailable/);
  assert.equal(state.context.hostBusy, false);
  assert.equal(state.classes.has('host-busy'), false);
  state.bridge.evalScript('retry', value => results.push(JSON.parse(value)));
  assert.deepEqual(results[1], {count: 1});
  assert.equal(attempts, 2);
  assert.equal(state.context.hostBusy, false);
  assert.equal(state.attributes['aria-busy'], 'false');
});
