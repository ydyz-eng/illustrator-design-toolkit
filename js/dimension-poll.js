/* Single-flight polling for the Illustrator canvas dimension capture session. */
(function (root, factory) {
  var createDimensionPoller = factory();
  if (typeof module === 'object' && module.exports) module.exports = createDimensionPoller;
  // CEP mixed contexts expose both CommonJS and window. The panel still needs
  // its browser global even when Node's module object is present.
  if (typeof window !== 'undefined') window.createDimensionPoller = createDimensionPoller;
  else if (root) root.createDimensionPoller = createDimensionPoller;
}(this, function () {
  'use strict';

  return function createDimensionPoller(options) {
    options = options || {};
    var request = options.request;
    if (typeof request !== 'function') throw new Error('Dimension poller requires a request function.');
    var parseResponse = options.parseResponse || JSON.parse;
    if (typeof parseResponse !== 'function') throw new Error('Dimension response parser must be a function.');
    var later = options.setTimeout || setTimeout;
    var cancel = options.clearTimeout || clearTimeout;
    var getBusy = options.getBusy || function () { return false; };
    var onUpdate = options.onUpdate || function () {};
    var onComplete = options.onComplete || function () {};
    var onError = options.onError || function () {};
    var timer = null;
    var running = false;
    var inFlight = false;
    var generation = 0;
    var token = '';
    var lastSignature = null;
    var delay = 450;

    function stop() {
      running = false;
      token = '';
      generation += 1;
      if (timer !== null) cancel(timer);
      timer = null;
      // A dispatched host request cannot be cancelled. Keep its slot occupied
      // until its callback arrives, including across a new start().
    }

    function schedule() {
      if (running && timer === null) timer = later(tick, delay);
    }

    function fail(message, data) {
      stop();
      onError(message, data);
    }

    function signature(data) {
      return JSON.stringify([
        data.active, data.phase, data.pointCount, data.neededPoints,
        data.msg, data.count, data.dimensionCount, data.autoPaused
      ]);
    }

    function tick() {
      timer = null;
      if (!running) return;
      if (inFlight || getBusy()) {
        schedule();
        return;
      }
      var requestGeneration = generation;
      var settled = false;
      // JSON string quoting plus line-separator escaping remains valid JSX even
      // for tokens containing quotes, backslashes, or Unicode line separators.
      var script = 'toolDimensionPickPoll(' + JSON.stringify(token)
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ')';
      inFlight = true;

      function receive(raw) {
        if (settled) return;
        settled = true;
        inFlight = false;
        if (!running || generation !== requestGeneration) {
          schedule();
          return;
        }
        var data;
        try {
          if (typeof raw !== 'string') throw new Error('Missing host response');
          data = parseResponse(raw);
          if (!data || typeof data !== 'object' || Object.prototype.toString.call(data) === '[object Array]') {
            throw new Error('Invalid host response');
          }
          if (!data.error && typeof data.active !== 'boolean') throw new Error('Missing capture state');
        } catch (error) {
          fail('无法读取画布取点状态，已暂停自动标注。请检查取点状态后重新开始。');
          return;
        }
        if (data.error) {
          fail(String(data.error), data);
          return;
        }
        if (!data.active) {
          stop();
          if (data.completed === true) onComplete(data);
          else onUpdate(data);
          return;
        }
        var currentSignature = signature(data);
        if (currentSignature !== lastSignature) {
          lastSignature = currentSignature;
          onUpdate(data);
        }
        // The consumer may stop or replace the session in onUpdate().
        if (running && generation === requestGeneration) schedule();
      }

      try {
        request(script, receive);
      } catch (error) {
        if (settled) throw error;
        settled = true;
        inFlight = false;
        if (running && generation === requestGeneration) {
          fail('画布取点通信失败，已暂停自动标注：' + (error && error.message ? error.message : String(error)));
        } else schedule();
      }
    }

    function start(nextToken) {
      if (typeof nextToken !== 'string' || !nextToken.length) {
        stop();
        return;
      }
      if (running && token === nextToken) return;
      stop();
      token = nextToken;
      lastSignature = null;
      running = true;
      schedule();
    }

    return { start: start, stop: stop, isRunning: function () { return running; } };
  };
}));
