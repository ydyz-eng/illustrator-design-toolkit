/* Run: node --test tests/dimension-pick.test.js.
 * The host mock checks capture ownership, document binding, cleanup, and recovery.
 * Native Pen interactions still require a smoke test inside Illustrator.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hostSource = fs.readFileSync(path.join(__dirname, '../jsx/tools.jsx'), 'utf8');
const pickFile = path.join(__dirname, '../jsx/dimension-pick.jsx');

function makeHost(options = {}) {
  const state = { removed: [], tools: [], dimensions: [], failDimension: false, failNextLayer: false };
  const app = { documents: [], redraw() {} };

  function isEditable(item) {
    while (item && item.typename !== 'Document') {
      if (item.removed) throw new Error('Object removed');
      if (item.locked) throw new Error('Object locked');
      item = item.parent;
    }
  }

  function descendants(parent) {
    return (parent._children || []).flatMap(item => [item, ...descendants(item)]);
  }

  function collection(parent, type, add, deep = false) {
    const values = () => (deep ? descendants(parent) : parent._children).filter(item => !type || item.typename === type);
    return new Proxy({ add }, { get(target, key) {
      if (key === 'length') return values().length;
      if (/^\d+$/.test(String(key))) return values()[Number(key)];
      return target[key];
    } });
  }

  function documentOf(item) {
    while (item && item.typename !== 'Document') item = item.parent;
    return item;
  }

  function base(parent, typename) {
    isEditable(parent);
    const item = { typename, parent, name: '', note: '', hidden: false, visible: true, editable: true, removed: false };
    let locked = false, selected = false;
    Object.defineProperty(item, 'locked', { enumerable: true, get() { return locked; }, set(value) {
      isEditable(parent); locked = !!value;
    } });
    Object.defineProperty(item, 'selected', { enumerable: true, get() { return selected; }, set(value) {
      if (value) isEditable(item);
      selected = !!value;
      const doc = documentOf(item);
      if (doc && doc._selection) {
        const index = doc._selection.indexOf(item);
        if (selected && index < 0) doc._selection.push(item);
        if (!selected && index >= 0) doc._selection.splice(index, 1);
      }
      if (item.pathPoints) item.pathPoints.forEach(point => { point.selected = selected ? 'ANCHORPOINT' : 'NOSELECTION'; });
    } });
    item.remove = function () {
      isEditable(item);
      state.removed.push(item);
      parent._children.splice(parent._children.indexOf(item), 1);
      item.removed = true;
      const doc = documentOf(item);
      if (doc) doc._selection = doc._selection.filter(selectedItem => selectedItem !== item);
    };
    parent._children.push(item);
    return item;
  }

  function addPath(parent, coords = []) {
    const item = base(parent, 'PathItem');
    item.closed = false;
    item.guides = false;
    item.clipping = false;
    item.setEntirePath = points => {
      item.pathPoints = Array.from(points, point => ({
        anchor: Array.from(point), leftDirection: Array.from(point), rightDirection: Array.from(point), selected: 'NOSELECTION'
      }));
    };
    item.setEntirePath(coords);
    return item;
  }

  function container(parent, type) {
    const item = base(parent, type);
    item._children = [];
    item.pageItems = collection(item, null, undefined, true);
    item.groupItems = collection(item, 'GroupItem', () => container(item, 'GroupItem'), true);
    item.pathItems = collection(item, 'PathItem', () => addPath(item), true);
    item.layers = collection(item, 'Layer', () => container(item, 'Layer'));
    return item;
  }

  function document() {
    const doc = { typename: 'Document', _children: [], _selection: [], name: 'Untitled', scaleFactor: 1 };
    doc.layers = collection(doc, 'Layer', () => {
      if (state.failNextLayer) { state.failNextLayer = false; throw new Error('Layer creation failed'); }
      const layer = container(doc, 'Layer');
      doc.activeLayer = layer;
      return layer;
    });
    doc.pageItems = collection(doc, null, undefined, true);
    Object.defineProperty(doc, 'selection', { get() { return doc._selection; }, set(items) {
      const previous = doc._selection.slice();
      previous.forEach(item => { item.selected = false; });
      doc._selection = [];
      if (items) Array.from(items).forEach(item => { item.selected = true; });
    } });
    doc.activate = () => { app.activeDocument = doc; };
    app.documents.push(doc);
    return doc;
  }

  const doc = document();
  app.activeDocument = doc;
  Object.defineProperty(app, 'selection', { get() { return app.activeDocument.selection; }, set(value) { app.activeDocument.selection = value; } });
  const artworkLayer = doc.layers.add();
  artworkLayer.name = 'Original artwork';
  const original = addPath(artworkLayer, [[10, 20], [30, 40], [60, 10]]);
  original.closed = true;
  doc.selection = [original];
  original.pathPoints[1].selected = 'NOSELECTION';
  original.pathPoints[2].selected = 'LEFTDIRECTION';
  const lockedLayer = doc.layers.add();
  lockedLayer.name = 'Originally locked';
  lockedLayer.locked = true;
  doc.activeLayer = artworkLayer;
  if (!options.noSelectTool) app.selectTool = name => {
    state.tools.push(name);
    if (options.failSelectTool) throw new Error('Tool unavailable');
    if (options.selectToolReturnsFalse) return false;
    // Illustrator's black selection arrow can promote selected anchors/handles
    // to whole-path selection. Merely recording the tool name misses this effect.
    if (options.selectionToolSelectsWholePaths && name === 'Adobe Select Tool') {
      app.activeDocument.selection.forEach(item => {
        if (item.pathPoints) item.pathPoints.forEach(point => { point.selected = 'ANCHORPOINT'; });
      });
    }
    return true;
  };
  const context = vm.createContext({ app, console, RGBColor: function RGBColor() {}, PathPointSelection: {
    ANCHORPOINT: 'ANCHORPOINT', NOSELECTION: 'NOSELECTION', LEFTDIRECTION: 'LEFTDIRECTION'
  } });
  vm.runInContext(hostSource, context, { filename: 'tools.jsx' });
  context.toolDimension = value => {
    const params = typeof value === 'string' ? JSON.parse(value) : JSON.parse(JSON.stringify(value));
    state.dimensions.push({ params, document: app.activeDocument, artworkLocked: artworkLayer.locked, lockedLayerLocked: lockedLayer.locked });
    return JSON.stringify(state.failDimension ? { error: 'Injected dimension failure' } : { count: 1, dimensionCount: 1, warnings: '' });
  };
  const reload = () => vm.runInContext(fs.readFileSync(pickFile, 'utf8'), context, { filename: 'dimension-pick.jsx' });
  reload();
  const call = (name, value) => JSON.parse(context[name](value));
  const begin = params => call('toolDimensionPickBegin', params ? JSON.stringify(params) : undefined);
  const status = token => call('toolDimensionPickStatus', token);
  const poll = token => call('toolDimensionPickPoll', token);
  const finish = (token, settings = {}) => call('toolDimensionPickFinish', JSON.stringify({ ...settings, pickToken: token }));
  const cancel = token => call('toolDimensionPickCancel', token);
  const helper = coords => addPath(doc.activeLayer, coords || [[12, 24], [42, 64]]);
  return { state, app, doc, artworkLayer, lockedLayer, original, context, document, addPath, container, begin, status, poll, finish, cancel, helper, reload };
}

function ok(result) {
  assert.equal(result.error, undefined, result.error);
  return result;
}

function restored(host) {
  assert.equal(host.artworkLayer.locked, false);
  assert.equal(host.lockedLayer.locked, true);
  assert.equal(host.doc.activeLayer, host.artworkLayer);
  assert.deepEqual(Array.from(host.doc.selection), [host.original]);
  assert.deepEqual(host.original.pathPoints.map(point => point.selected), ['ANCHORPOINT', 'NOSELECTION', 'LEFTDIRECTION']);
  assert.equal(host.original.removed, false);
}

test('begin creates an isolated layer and protects existing artwork without losing capture on a second begin', () => {
  const host = makeHost();
  const first = ok(host.begin());
  assert.equal(first.active, true);
  assert.ok(first.token);
  const layer = host.doc.activeLayer;
  assert.notEqual(layer, host.artworkLayer);
  assert.equal(host.artworkLayer.locked, true);
  assert.equal(host.lockedLayer.locked, true);
  assert.equal(layer.locked, false);
  assert.equal(layer.pathItems.length, 0);
  assert.equal(layer.groupItems.length, 1);
  assert.equal(layer.groupItems[0].hidden, true);
  assert.equal(layer.groupItems[0].locked, true);
  assert.equal(host.state.tools[0], 'Adobe Pen Tool');
  const second = host.begin();
  assert.equal(host.doc.layers.length, 3);
  assert.equal(host.doc.activeLayer, layer);
  if (!second.error) assert.equal(second.token, first.token);
  ok(host.cancel(first.token));
  restored(host);
});

test('finish injects captured document coordinates, preserves dimension options and restores original point selection', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  const layer = host.doc.activeLayer;
  const helper = host.helper([[-30, 25], [90, -65]]);
  const result = ok(host.finish(capture.token, { unit: 'cm', scale: 25, offset: 9, mode: 'artboard', points: [[0, 0], [1, 1]] }));
  assert.equal(result.dimensionCount, 1);
  assert.equal(result.picking, false);
  assert.equal(host.state.dimensions.length, 1);
  const run = host.state.dimensions[0];
  assert.equal(run.document, host.doc);
  assert.deepEqual(run.params.points, [[-30, 25], [90, -65]]);
  assert.equal(run.params.mode, 'points');
  assert.equal(run.params.unit, 'cm');
  assert.equal(run.params.scale, 25);
  assert.equal(run.params.offset, 9);
  assert.equal(helper.removed, true);
  assert.equal(layer.removed, true);
  assert.equal(host.status().active, false);
  assert.ok(host.state.tools.includes('Adobe Select Tool'));
  restored(host);
});

test('zero or one captured point remains pending and can be cancelled safely', () => {
  for (const coords of [null, [[12, 34]]]) {
    const host = makeHost();
    const capture = ok(host.begin());
    const helper = coords ? host.helper(coords) : null;
    const status = ok(host.status(capture.token));
    assert.equal(status.active, true);
    assert.notEqual(status.phase, 'ready');
    assert.ok(host.finish(capture.token).error);
    assert.equal(host.state.dimensions.length, 0);
    ok(host.cancel(capture.token));
    if (helper) assert.equal(helper.removed, true);
    restored(host);
  }
});

test('invalid geometry is never dimensioned or silently removed on cancellation', () => {
  const cases = [
    helper => { helper.closed = true; },
    helper => { helper.pathPoints[0].rightDirection = [500, 500]; },
    helper => { helper.setEntirePath([[1, 1], [2, 2], [3, 3]]); },
    helper => { helper.guides = true; },
    helper => { helper.clipping = true; }
  ];
  for (const mutate of cases) {
    const host = makeHost();
    const capture = ok(host.begin());
    const layer = host.doc.activeLayer;
    const helper = host.helper();
    mutate(helper);
    assert.ok(host.finish(capture.token).error);
    assert.equal(host.state.dimensions.length, 0);
    assert.equal(helper.removed, false);
    ok(host.cancel(capture.token));
    assert.equal(helper.removed, false);
    assert.equal(layer.removed, false);
    assert.equal(layer.locked, false);
    restored(host);
  }
});

test('duplicate endpoints and multiple helper paths cannot create dimensions', () => {
  for (const multiple of [false, true]) {
    const host = makeHost();
    const capture = ok(host.begin());
    host.helper(multiple ? [[0, 0], [10, 10]] : [[8, 8], [8, 8]]);
    if (multiple) host.helper([[30, 40], [80, 90]]);
    assert.ok(host.finish(capture.token).error);
    assert.equal(host.state.dimensions.length, 0);
    ok(host.cancel(capture.token));
    restored(host);
  }
});

test('nested unexpected artwork survives cancellation and cannot act as a capture helper', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  const layer = host.doc.activeLayer;
  const group = host.container(layer, 'GroupItem');
  const nested = host.addPath(group, [[5, 5], [20, 20]]);
  assert.ok(host.finish(capture.token).error);
  assert.equal(host.state.dimensions.length, 0);
  ok(host.cancel(capture.token));
  assert.equal(group.removed, false);
  assert.equal(nested.removed, false);
  assert.equal(layer.removed, false);
  assert.equal(layer.groupItems.length, 1);
  restored(host);
});

test('artwork inserted into an unlocked capture marker is preserved on cancellation', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  const layer = host.doc.activeLayer;
  const marker = layer.groupItems[0];
  marker.locked = false;
  const nested = host.addPath(marker, [[5, 5], [20, 20]]);
  ok(host.cancel(capture.token));
  assert.equal(marker.removed, false);
  assert.equal(nested.removed, false);
  assert.equal(layer.removed, false);
  restored(host);
});

test('foreign tokens cannot read, finish or cancel the live session', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  const helper = host.helper();
  assert.ok(host.status('invalid-token').error);
  assert.ok(host.finish('invalid-token').error);
  assert.ok(host.cancel('invalid-token').error);
  assert.equal(helper.removed, false);
  assert.equal(host.state.dimensions.length, 0);
  assert.equal(ok(host.status(capture.token)).active, true);
  ok(host.cancel(capture.token));
  restored(host);
});

test('switching documents cannot write captured dimensions into another document', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  const helper = host.helper();
  const foreign = host.document();
  foreign.layers.add();
  host.app.activeDocument = foreign;
  assert.equal(ok(host.status(capture.token)).phase, 'documentChanged');
  assert.ok(host.finish(capture.token).error);
  assert.equal(host.state.dimensions.length, 0);
  assert.equal(helper.removed, false);
  assert.equal(foreign.layers.length, 1);
  host.app.activeDocument = host.doc;
  ok(host.cancel(capture.token));
  restored(host);
});

test('cancelling from another document restores only the source document and leaves the active document and tool alone', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  const helper = host.helper();
  const foreign = host.document();
  const foreignLayer = foreign.layers.add();
  const foreignArt = host.addPath(foreignLayer, [[1, 3], [4, 7]]);
  foreign.selection = [foreignArt];
  host.app.activeDocument = foreign;
  const toolCalls = host.state.tools.length;
  ok(host.cancel(capture.token));
  assert.equal(host.app.activeDocument, foreign);
  assert.equal(host.state.tools.length, toolCalls);
  assert.equal(foreign.activeLayer, foreignLayer);
  assert.equal(foreignLayer.locked, false);
  assert.deepEqual(Array.from(foreign.selection), [foreignArt]);
  assert.equal(foreignArt.removed, false);
  assert.equal(helper.removed, true);
  restored(host);
});

test('dimension engine errors retain captured points for a settings correction and retry', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  const helper = host.helper();
  host.state.failDimension = true;
  assert.match(host.finish(capture.token).error, /Injected dimension failure/);
  assert.equal(helper.removed, false);
  assert.equal(ok(host.status(capture.token)).active, true);
  host.state.failDimension = false;
  ok(host.finish(capture.token, { offset: 5 }));
  assert.equal(host.state.dimensions.length, 2);
  restored(host);
});

test('reloading the host helper preserves a capture session and its ownership', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  host.helper();
  const session = host.context._dimensionPickSession;
  host.reload();
  assert.equal(host.context._dimensionPickSession, session);
  assert.equal(ok(host.status(capture.token)).token, capture.token);
  ok(host.finish(capture.token));
  restored(host);
});

test('begin fails cleanly if layer creation fails or no document is open', () => {
  const host = makeHost();
  host.state.failNextLayer = true;
  assert.ok(host.begin().error);
  assert.equal(host.doc.layers.length, 2);
  restored(host);
  host.app.documents.length = 0;
  assert.ok(host.begin().error);
  assert.equal(host.doc.layers.length, 2);
});

test('hosts lacking tool selection still expose the manual Pen workflow and restore on cancel', () => {
  for (const options of [{ noSelectTool: true }, { failSelectTool: true }, { selectToolReturnsFalse: true }]) {
    const host = makeHost(options);
    const capture = ok(host.begin());
    assert.equal(capture.active, true);
    assert.equal(capture.toolSelected, false);
    ok(host.cancel(capture.token));
    restored(host);
  }
});

test('three-click capture reports each phase and waits without rendering until placement is clicked', () => {
  const host = makeHost();
  const capture = ok(host.begin({ interaction: 'threeClick', settings: { unit: 'cm' } }));
  assert.equal(capture.interaction, 'threeClick');
  assert.equal(capture.neededPoints, 3);
  assert.equal(capture.phase, 'waitingStart');
  assert.equal(capture.pointCount, 0);
  const layer = host.doc.activeLayer;
  assert.equal(ok(host.poll(capture.token)).phase, 'waitingStart');
  const helper = host.helper([[12, 24]]);
  const one = ok(host.poll(capture.token));
  assert.equal(one.phase, 'waitingEnd');
  assert.equal(one.pointCount, 1);
  helper.setEntirePath([[12, 24], [42, 64]]);
  const two = ok(host.poll(capture.token));
  assert.equal(two.phase, 'waitingPlacement');
  assert.equal(two.pointCount, 2);
  assert.equal(host.state.dimensions.length, 0);
  assert.equal(host.doc.activeLayer, layer);
  assert.equal(helper.removed, false);
  assert.equal(host.artworkLayer.locked, true);
  helper.setEntirePath([[12, 24], [42, 64], [-10, 70]]);
  const complete = ok(host.poll(capture.token));
  assert.equal(complete.active, false);
  assert.equal(complete.completed, true);
  assert.equal(complete.token, capture.token);
  assert.equal(complete.dimensionCount, 1);
  assert.equal(host.state.dimensions[0].artworkLocked, false);
  assert.equal(host.state.dimensions[0].lockedLayerLocked, true);
  assert.equal(helper.removed, true);
  assert.equal(layer.removed, true);
  restored(host);
});

test('third click controls the perpendicular offset and side while only AB is measured', () => {
  const cases = [
    { points: [[0, 0], [100, 0], [40, 25]], side: 'left', offsetPt: 25 },
    { points: [[0, 0], [100, 0], [900, -25]], side: 'right', offsetPt: 25 },
    { points: [[100, 0], [0, 0], [40, 25]], side: 'right', offsetPt: 25 },
    { points: [[0, 0], [0, 100], [-25, 70]], side: 'left', offsetPt: 25 },
    { points: [[0, 0], [0, 100], [25, 70]], side: 'right', offsetPt: 25 },
    { points: [[0, 100], [0, 0], [25, 70]], side: 'left', offsetPt: 25 },
    { points: [[0, 0], [30, 40], [-9, 38]], side: 'left', offsetPt: 30 },
    { points: [[0, 0], [30, 40], [39, 2]], side: 'right', offsetPt: 30 },
    { points: [[0, 0], [100, 0], [60, 0]], side: 'left', offsetPt: 0 },
    { points: [[0, 0], [10, 0], [4, 2.5]], side: 'left', offsetPt: 2.5, hostScale: 10 }
  ];
  for (const example of cases) {
    const host = makeHost();
    host.doc.scaleFactor = example.hostScale || 1;
    const capture = ok(host.begin({ interaction: 'threeClick', settings: { offset: 999, alignedSide: 'auto', scale: 5 } }));
    host.helper(example.points);
    ok(host.poll(capture.token));
    const params = host.state.dimensions[0].params;
    assert.deepEqual(params.points, example.points.slice(0, 2));
    assert.equal(params.alignedSide, example.side);
    assert.ok(Math.abs(params.offset - example.offsetPt * 25.4 / 72 * host.doc.scaleFactor) < 1e-10);
    assert.equal(params.scale, 5);
    restored(host);
  }
});

test('three-click settings are validated before locking artwork and snapshotted for automatic or explicit finish', () => {
  for (const settings of [null, [], { unit: 'bad' }, { decimals: 1.5 }, { fontSize: -1 }, { strokeWidth: 0 },
    { scale: 0 }, { color: 'orange' }, { color: 'custom', customColor: 'oops' }, { prefix: 'first\nsecond' }]) {
    const host = makeHost();
    assert.ok(host.begin({ interaction: 'threeClick', settings }).error);
    assert.equal(host.doc.layers.length, 2);
    restored(host);
  }
  const host = makeHost();
  const settings = { unit: 'cm', decimals: 3, fontSize: 15, arrow: 3, arrowStyle: 'tick', color: 'custom', customColor: '#abcdef',
    extensionGap: 2, extensionOvershoot: 3, strokeWidth: 1.5, scale: 25, prefix: 'L=', suffix: ' exact', showUnit: false, trimZeros: false };
  const capture = ok(host.begin({ interaction: 'threeClick', settings }));
  settings.unit = 'pt';
  host.helper([[0, 0], [100, 0], [50, 20]]);
  ok(host.finish(capture.token, { unit: 'in', scale: 100 }));
  const params = host.state.dimensions[0].params;
  assert.equal(params.unit, 'cm');
  assert.equal(params.scale, 25);
  assert.equal(params.showUnit, false);
  assert.equal(params.trimZeros, false);
  assert.equal(params.prefix, 'L=');
  assert.equal(params.suffix, ' exact');
  assert.equal(params.customColor, '#abcdef');
  assert.equal(params.fontSize, 15);
  assert.equal(params.arrowStyle, 'tick');
  restored(host);
});

test('three-click cancellation cleans only valid unfinished or complete helper paths', () => {
  for (const coords of [null, [], [[12, 34]], [[12, 34], [56, 78]], [[12, 34], [56, 78], [80, 90]]]) {
    const host = makeHost();
    const capture = ok(host.begin({ interaction: 'threeClick' }));
    const layer = host.doc.activeLayer;
    const helper = coords ? host.helper(coords) : null;
    ok(host.cancel(capture.token));
    assert.equal(host.state.dimensions.length, 0);
    if (helper) assert.equal(helper.removed, true);
    assert.equal(layer.removed, true);
    restored(host);
  }
});

test('invalid extra points, duplicate endpoints, curves and unknown art survive three-click cancellation', () => {
  const cases = [
    (host, helper) => helper.setEntirePath([[0, 0], [10, 0], [5, 10], [8, 12]]),
    (host, helper) => helper.setEntirePath([[0, 0], [0, 0], [5, 10]]),
    (host, helper) => { helper.pathPoints[2].rightDirection = [99, 99]; },
    (host, helper) => { helper.pathPoints[0].leftDirection = [NaN, 0]; },
    (host, helper) => { helper.closed = true; },
    (host, helper) => { helper.guides = true; },
    (host, helper) => { helper.clipping = true; },
    host => host.helper([[30, 40], [80, 90], [20, 20]]),
    host => host.container(host.doc.activeLayer, 'GroupItem')
  ];
  for (const mutate of cases) {
    const host = makeHost();
    const capture = ok(host.begin({ interaction: 'threeClick' }));
    const helper = host.helper([[0, 0], [10, 0], [5, 10]]);
    mutate(host, helper);
    assert.equal(ok(host.poll(capture.token)).phase, 'invalid');
    assert.equal(host.state.dimensions.length, 0);
    ok(host.cancel(capture.token));
    assert.equal(helper.removed, false);
    restored(host);
  }
});

test('automatic completion is idempotent across duplicate polls, reentry and panel reloads', () => {
  const host = makeHost();
  const capture = ok(host.begin({ interaction: 'threeClick' }));
  host.helper([[0, 0], [100, 0], [50, 20]]);
  const render = host.context.toolDimension;
  let reentry, directReentry, cancelReentry;
  host.context.toolDimension = params => {
    reentry = host.poll(capture.token);
    directReentry = host.finish(capture.token);
    assert.equal(host.context._dimensionPickSession.finishing, true);
    cancelReentry = host.cancel(capture.token);
    return render(params);
  };
  const result = ok(host.poll(capture.token));
  assert.equal(reentry.active, true);
  assert.equal(directReentry.active, true);
  assert.equal(cancelReentry.active, true);
  assert.equal(host.state.dimensions.length, 1);
  assert.deepEqual(host.poll(capture.token), result);
  assert.deepEqual(host.finish(capture.token), result);
  host.reload();
  assert.deepEqual(host.poll(capture.token), result);
  assert.equal(host.state.dimensions.length, 1);
  restored(host);
});

test('poll never renders with a stale or absent token or in a foreign document', () => {
  const host = makeHost();
  const capture = ok(host.begin({ interaction: 'threeClick' }));
  const helper = host.helper([[0, 0], [100, 0], [50, 20]]);
  assert.ok(host.poll('stale-token').error);
  assert.ok(host.poll().error);
  const foreign = host.document();
  foreign.layers.add();
  host.app.activeDocument = foreign;
  assert.equal(ok(host.poll(capture.token)).phase, 'documentChanged');
  assert.equal(host.state.dimensions.length, 0);
  assert.equal(helper.removed, false);
  assert.equal(foreign.layers.length, 1);
  host.app.activeDocument = host.doc;
  ok(host.poll(capture.token));
  restored(host);
});

test('a closed source document discards its capture without rendering in the new document', () => {
  const host = makeHost();
  const capture = ok(host.begin({ interaction: 'threeClick' }));
  host.helper([[0, 0], [100, 0], [50, 20]]);
  const foreign = host.document();
  foreign.layers.add();
  host.app.activeDocument = foreign;
  host.app.documents.splice(host.app.documents.indexOf(host.doc), 1);
  assert.equal(ok(host.poll(capture.token)).active, false);
  assert.equal(host.context._dimensionPickSession, null);
  assert.equal(host.state.dimensions.length, 0);
  assert.equal(foreign.layers.length, 1);
});

test('render errors pause automatic retries and preserve points and protection until explicit retry succeeds', () => {
  const host = makeHost();
  const capture = ok(host.begin({ interaction: 'threeClick', settings: { unit: 'cm' } }));
  const helper = host.helper([[0, 0], [100, 0], [50, 20]]);
  host.state.failDimension = true;
  const failed = host.poll(capture.token);
  assert.match(failed.error, /Injected dimension failure/);
  assert.equal(failed.active, true);
  assert.equal(failed.autoPaused, true);
  assert.equal(helper.removed, false);
  assert.equal(host.artworkLayer.locked, true);
  host.state.failDimension = false;
  assert.equal(ok(host.poll(capture.token)).autoPaused, true);
  host.reload();
  assert.equal(ok(host.poll(capture.token)).autoPaused, true);
  assert.equal(host.state.dimensions.length, 1);
  ok(host.finish(capture.token));
  assert.equal(host.state.dimensions.length, 2);
  assert.equal(host.state.dimensions[1].params.unit, 'cm');
  restored(host);
});

test('out-of-range placement pauses without rendering and can be corrected before retry', () => {
  const host = makeHost();
  const capture = ok(host.begin({ interaction: 'threeClick' }));
  const helper = host.helper([[0, 0], [100, 0], [50, 100000]]);
  const failed = host.poll(capture.token);
  assert.equal(failed.autoPaused, true);
  assert.match(failed.error, /10000 mm/);
  assert.equal(host.state.dimensions.length, 0);
  assert.equal(host.artworkLayer.locked, true);
  helper.setEntirePath([[0, 0], [100, 0], [50, 20]]);
  assert.equal(ok(host.poll(capture.token)).autoPaused, true);
  ok(host.finish(capture.token));
  assert.equal(host.state.dimensions.length, 1);
  restored(host);
});

test('legacy two-point capture is never automatically rendered by polling', () => {
  const host = makeHost();
  const capture = ok(host.begin());
  host.helper([[0, 0], [100, 0]]);
  assert.equal(ok(host.poll(capture.token)).phase, 'ready');
  assert.equal(host.state.dimensions.length, 0);
  ok(host.finish(capture.token));
  restored(host);
});

test('thrown renderer failures pause automatic completion and cancellation restores original locks', () => {
  const host = makeHost();
  const capture = ok(host.begin({ interaction: 'threeClick' }));
  const helper = host.helper([[0, 0], [100, 0], [50, 20]]);
  let calls = 0;
  host.context.toolDimension = () => { calls++; throw new Error('Host text operation unavailable'); };
  const failed = host.poll(capture.token);
  assert.match(failed.error, /Host text operation unavailable/);
  assert.equal(failed.autoPaused, true);
  assert.equal(host.context._dimensionPickSession.finishing, false);
  assert.equal(host.artworkLayer.locked, true);
  assert.equal(host.lockedLayer.locked, true);
  assert.equal(ok(host.poll(capture.token)).autoPaused, true);
  assert.equal(calls, 1);
  ok(host.cancel(capture.token));
  assert.equal(helper.removed, true);
  restored(host);
});

test('finishing and cancelling restore partial anchors and handles after switching back to the selection tool', () => {
  for (const action of ['finish', 'poll', 'cancel']) {
    const host = makeHost({ selectionToolSelectsWholePaths: true });
    const capture = ok(host.begin(action === 'poll' ? { interaction: 'threeClick' } : undefined));
    const helper = host.helper(action === 'poll' ? [[0, 0], [100, 0], [50, 20]] : [[0, 0], [100, 0]]);
    host.doc.selection = [helper];
    ok(host[action](capture.token));
    assert.equal(host.state.tools[host.state.tools.length - 1], 'Adobe Select Tool');
    restored(host);
  }
});
