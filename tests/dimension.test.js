/*
 * Run: node --test tests/dimension.test.js
 * Illustrator is mocked for deterministic geometry / lifecycle checks.
 * Font metrics and host undo behavior still require an Illustrator smoke test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'jsx', 'tools.jsx'), 'utf8');
const MM = 72 / 25.4;

function makeHost(options = {}) {
  const state = { created: [], pathAdds: 0, textAdds: 0 };
  let doc;

  function requireUnlocked(item) {
    while (item && item !== doc) {
      if (item.locked) throw new Error('Cannot edit a locked item or layer');
      item = item.parent;
    }
  }

  function detach(item) {
    if (item.parent && item.parent._children) {
      const index = item.parent._children.indexOf(item);
      if (index !== -1) item.parent._children.splice(index, 1);
    }
    item.removed = true;
  }

  function boundsFrom(points) {
    if (!points.length) return [0, 0, 0, 0];
    return [
      Math.min(...points.map(point => point[0])),
      Math.max(...points.map(point => point[1])),
      Math.max(...points.map(point => point[0])),
      Math.min(...points.map(point => point[1]))
    ];
  }

  function allItems(parent) {
    return (parent._children || []).flatMap(item => [item, ...allItems(item)]);
  }

  function collection(parent, type, add) {
    const getItems = () => (parent._children || []).filter(item => !type || item.typename === type);
    return new Proxy({
      add,
      getByName(name) {
        const item = getItems().find(item => item.name === name);
        if (!item) throw new Error('No such item: ' + name);
        return item;
      }
    }, {
      get(target, key) {
        if (key === 'length') return getItems().length;
        if (key === Symbol.iterator) return getItems()[Symbol.iterator].bind(getItems());
        if (/^\d+$/.test(String(key))) return getItems()[Number(key)];
        return target[key];
      }
    });
  }

  function base(parent, typename) {
    requireUnlocked(parent);
    const item = {
      parent, name: '', note: '', hidden: false, locked: false,
      editable: true, selected: false, removed: false,
      remove() { requireUnlocked(this); detach(this); },
      move(nextParent) {
        detach(this);
        this.removed = false;
        this.parent = nextParent;
        nextParent._children.push(this);
      }
    };
    let isLocked = false;
    Object.defineProperty(item, 'locked', {
      enumerable: true,
      get() { return isLocked; },
      set(value) { requireUnlocked(this.parent); isLocked = value; }
    });
    Object.defineProperty(item, 'typename', { enumerable: true, get() {
      let cursor = this;
      while (cursor && cursor !== doc) {
        if (cursor.removed) throw new Error('Object is no longer valid');
        cursor = cursor.parent;
      }
      return typename;
    } });
    parent._children.push(item);
    state.created.push(item);
    return item;
  }

  function addPath(parent) {
    state.pathAdds++;
    if (options.failPathAt === state.pathAdds) throw new Error('Injected path creation failure');
    const item = base(parent, 'PathItem');
    item.points = [];
    item.pathPoints = [];
    item.closed = false;
    item.filled = false;
    item.stroked = false;
    item.strokeWidth = 0;
    item.strokeDashes = [3, 2]; // Illustrator can inherit the document's last stroke style.
    item.setEntirePath = function (points) {
      this.points = Array.from(points, point => Array.from(point));
      this.pathPoints = this.points.map(point => ({ anchor: point, leftDirection: point, rightDirection: point }));
    };
    Object.defineProperty(item, 'geometricBounds', { get() { return boundsFrom(this.points); } });
    Object.defineProperty(item, 'visibleBounds', { get() { return this.geometricBounds; } });
    return item;
  }

  function addText(parent) {
    state.textAdds++;
    if (options.failTextAt === state.textAdds) throw new Error('Injected text creation failure');
    const item = base(parent, 'TextFrame');
    item.contents = '';
    item.left = 0;
    item.top = 0;
    item.rotation = 0;
    item.textRange = { characterAttributes: { size: 10, strokeWeight: 2 }, paragraphAttributes: {} };
    item.rotate = function (angle) { this.rotation += angle; };
    item.translate = function (x, y) { this.left += x; this.top += y; };
    const unrotatedSize = () => [item.contents.length * item.textRange.characterAttributes.size * 0.55, item.textRange.characterAttributes.size];
    Object.defineProperty(item, 'width', { get() {
      const [w, h] = unrotatedSize(), radians = this.rotation * Math.PI / 180;
      return Math.abs(w * Math.cos(radians)) + Math.abs(h * Math.sin(radians));
    } });
    Object.defineProperty(item, 'height', { get() {
      const [w, h] = unrotatedSize(), radians = this.rotation * Math.PI / 180;
      return Math.abs(w * Math.sin(radians)) + Math.abs(h * Math.cos(radians));
    } });
    Object.defineProperty(item, 'position', {
      get() { return [this.left, this.top]; },
      set(value) { this.left = value[0]; this.top = value[1]; }
    });
    Object.defineProperty(item, 'geometricBounds', { get() { return [this.left, this.top, this.left + this.width, this.top - this.height]; } });
    Object.defineProperty(item, 'visibleBounds', { get() { return this.geometricBounds; } });
    return item;
  }

  function container(parent, type) {
    const item = base(parent, type);
    item._children = [];
    item.visible = true;
    item.pageItems = collection(item, null);
    item.groupItems = collection(item, 'GroupItem', () => container(item, 'GroupItem'));
    item.pathItems = collection(item, 'PathItem', () => addPath(item));
    item.textFrames = collection(item, 'TextFrame', () => addText(item));
    item.layers = collection(item, 'Layer', () => container(item, 'Layer'));
    return item;
  }

  doc = { typename: 'Document', _children: [], scaleFactor: options.scaleFactor || 1, selection: [], documentColorSpace: 'RGB' };
  if (options.selectsAllAnchorsOnRestore) {
    let selected = [];
    Object.defineProperty(doc, 'selection', {
      get() { return selected; },
      set(value) {
        selected = value;
        for (const item of value || []) {
          for (const child of [item, ...allItems(item)]) {
            for (const point of child.pathPoints || []) point.selected = 'ANCHORPOINT';
          }
        }
      }
    });
  }
  doc.layers = collection(doc, 'Layer', () => {
    const layer = container(doc, 'Layer');
    doc.activeLayer = layer;
    if (options.mutateSelectionOnLayerAdd) doc.selection = [];
    return layer;
  });
  doc.artboards = [{ artboardRect: options.artboardRect || [0, 200, 300, 0] }];
  doc.artboards.getActiveArtboardIndex = () => 0;
  const artworkLayer = doc.layers.add();
  artworkLayer.name = 'Artwork';
  state.created = [];

  function artwork(bounds, properties = {}) {
    const item = base(properties.parent || artworkLayer, properties.typename || 'PathItem');
    Object.assign(item, {
      geometricBounds: bounds.slice(), visibleBounds: bounds.slice(), closed: true
    });
    for (const key of Object.keys(properties)) if (key !== 'typename') item[key] = properties[key];
    return item;
  }

  const app = {
    documents: options.noDocument ? [] : [doc], activeDocument: doc,
    redraw() {}, textFonts: { getByName() { return {}; } }
  };
  Object.defineProperty(app, 'selection', { get() { return doc.selection; }, set(value) { doc.selection = value; } });
  const context = vm.createContext({
    app, console, RGBColor: function RGBColor() {}, CMYKColor: function CMYKColor() {},
    NoColor: function NoColor() {}, Justification: { CENTER: 'CENTER' },
    ElementPlacement: { PLACEATEND: 'PLACEATEND', PLACEATBEGINNING: 'PLACEATBEGINNING' },
    DocumentColorSpace: { RGB: 'RGB', CMYK: 'CMYK' },
    StrokeCap: { BUTTENDCAP: 'BUTTENDCAP' }, Transformation: { CENTER: 'CENTER' },
    PathPointSelection: { ANCHORPOINT: 'ANCHORPOINT', NOSELECTION: 'NOSELECTION', LEFTDIRECTION: 'LEFTDIRECTION', RIGHTDIRECTION: 'RIGHTDIRECTION', LEFTRIGHTPOINT: 'LEFTRIGHTPOINT' }
  });
  vm.runInContext(source, context, { filename: 'tools.jsx' });
  const select = (...items) => { doc.selection = items; };
  const run = (params = {}) => JSON.parse(context.toolDimension(JSON.stringify(params)));
  const clear = (scope) => JSON.parse(context.clearDimensionLayer(scope === undefined ? undefined : JSON.stringify({ scope })));
  const output = () => allItems(doc).filter(item => item.parent !== artworkLayer && item.typename !== 'Layer');
  return { app, doc, state, context, artworkLayer, artwork, select, run, clear, output, allItems, container };
}

function labelTexts(host) {
  return host.output().filter(item => item.typename === 'TextFrame').map(item => item.contents);
}

function expectSuccess(result) {
  assert.equal(result.error, undefined, result.error);
  return result;
}

function assertClose(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be close to ${expected}`);
}

function edgeArtwork(host, coordinates, properties = {}) {
  const pathPoints = coordinates.map(anchor => ({
    anchor: anchor.slice(), leftDirection: anchor.slice(), rightDirection: anchor.slice(), selected: 'NOSELECTION'
  }));
  const bounds = [Math.min(...coordinates.map(p => p[0])), Math.max(...coordinates.map(p => p[1])),
    Math.max(...coordinates.map(p => p[0])), Math.min(...coordinates.map(p => p[1]))];
  return host.artwork(bounds, { pathPoints, ...properties });
}

function dimensionGroups(host) {
  return host.output().filter(item => item.typename === 'GroupItem' && /^(斜边|宽度|高度) \/ /.test(item.name));
}

function arrowTips(host) {
  return dimensionGroups(host).map(group => group._children.filter(item => item.typename === 'PathItem' && item.filled).map(item => item.points[0]));
}

test('each mode emits one width and height per object and preserves selection / active layer', () => {
  const host = makeHost({ mutateSelectionOnLayerAdd: true });
  const first = host.artwork([0, 100, 72, 28]);
  const second = host.artwork([100, 80, 136, 8]);
  host.select(first, second);
  const result = expectSuccess(host.run({ unit: 'in' }));
  assert.equal(result.count, 2);
  assert.equal(result.dimensionCount, 4);
  assert.deepEqual(labelTexts(host), ['1 in', '1 in', '0.5 in', '1 in']);
  assert.deepEqual(Array.from(host.doc.selection), [first, second]);
  assert.equal(host.doc.activeLayer, host.artworkLayer);
  assert.deepEqual(first.geometricBounds, [0, 100, 72, 28]);
});

test('overall mode uses the selection union, including negative coordinates', () => {
  const host = makeHost();
  host.select(host.artwork([-30, 90, 30, 10]), host.artwork([70, 100, 114, -44]));
  const result = expectSuccess(host.run({ mode: 'overall', unit: 'pt' }));
  assert.equal(result.count, 2);
  assert.equal(result.dimensionCount, 2);
  assert.deepEqual(labelTexts(host), ['144 pt', '144 pt']);
});

test('gap measures the empty edge-to-edge distance independent of selection order', () => {
  for (const reverse of [false, true]) {
    const host = makeHost();
    const items = [host.artwork([0, 100, 20, 80]), host.artwork([50, 50, 70, 30])];
    host.select(...(reverse ? items.reverse() : items));
    const result = expectSuccess(host.run({ mode: 'gap', unit: 'pt' }));
    assert.equal(result.dimensionCount, 2);
    assert.deepEqual(labelTexts(host), ['30 pt', '30 pt']);
  }
});

test('gap skips overlapping projections and rejects an entirely overlapping selection', () => {
  const host = makeHost();
  host.select(host.artwork([0, 100, 40, 60]), host.artwork([10, 30, 50, 0]));
  const result = expectSuccess(host.run({ mode: 'gap', unit: 'pt' }));
  assert.equal(result.dimensionCount, 1);
  assert.match(result.warnings, /水平/);
  assert.deepEqual(labelTexts(host), ['30 pt']);
  const overlap = makeHost();
  overlap.select(overlap.artwork([0, 100, 40, 60]), overlap.artwork([10, 90, 50, 50]));
  assert.match(overlap.run({ mode: 'gap' }).error, /重叠|相接/);
  assert.equal(overlap.doc.layers.length, 1);
});

test('artboard mode measures the active artboard without requiring selection', () => {
  const host = makeHost({ artboardRect: [-72, 144, 144, 0] });
  const result = expectSuccess(host.run({ mode: 'artboard', unit: 'in' }));
  assert.equal(result.count, 1);
  assert.equal(result.dimensionCount, 2);
  assert.deepEqual(labelTexts(host), ['3 in', '2 in']);
  assert.equal(host.doc.selection.length, 0);
});

test('all units and label scaling use physical dimensions without changing artwork', () => {
  for (const [unit, expected] of [['mm', '25.4 mm'], ['cm', '2.54 cm'], ['in', '1 in'], ['pt', '72 pt'], ['px', '72 px']]) {
    const host = makeHost();
    const artwork = host.artwork([0, 10, 72, 0]);
    host.select(artwork);
    expectSuccess(host.run({ unit, doHeight: false }));
    assert.deepEqual(labelTexts(host), [expected]);
    assert.deepEqual(artwork.geometricBounds, [0, 10, 72, 0]);
  }
  const scaled = makeHost();
  scaled.select(scaled.artwork([0, 10, 2 * MM, 0]));
  expectSuccess(scaled.run({ scale: 10, doHeight: false }));
  assert.deepEqual(labelTexts(scaled), ['20 mm']);
});

test('label formatting preserves optional zeros, prefix, suffix and unit visibility', () => {
  const host = makeHost();
  host.select(host.artwork([0, 10, 72, 0]));
  expectSuccess(host.run({ unit: 'in', doHeight: false, trimZeros: false, decimals: 3, prefix: 'W=', suffix: ' ±0.1', showUnit: false }));
  assert.deepEqual(labelTexts(host), ['W=1.000 ±0.1']);
  const rounded = makeHost();
  rounded.select(rounded.artwork([0, 10, 12.3456, 0]));
  expectSuccess(rounded.run({ unit: 'pt', doHeight: false, decimals: 2 }));
  assert.deepEqual(labelTexts(rounded), ['12.35 pt']);
});

test('geometric and visible bounds produce distinct, explicit measurements', () => {
  for (const [bounds, expected] of [['geometric', '72 pt'], ['visible', '82 pt']]) {
    const host = makeHost();
    host.select(host.artwork([0, 50, 72, 0], { visibleBounds: [-5, 55, 77, -5] }));
    expectSuccess(host.run({ bounds, unit: 'pt', doHeight: false }));
    assert.deepEqual(labelTexts(host), [expected]);
  }
});

test('clipping groups use the mask and ignore artwork outside it', () => {
  const host = makeHost();
  const group = host.container(host.artworkLayer, 'GroupItem');
  group.clipped = true;
  host.artwork([-500, 500, 500, -500], { parent: group });
  host.artwork([0, 20, 30, 0], { parent: group, clipping: true, visibleBounds: [-3, 23, 33, -3] });
  host.select(group);
  expectSuccess(host.run({ unit: 'pt', bounds: 'visible' }));
  assert.deepEqual(labelTexts(host), ['30 pt', '20 pt']);
});

test('nested groups deduplicate selected descendants and exclude hidden / guide objects', () => {
  const host = makeHost();
  const group = host.container(host.artworkLayer, 'GroupItem');
  const inner = host.container(group, 'GroupItem');
  const child = host.artwork([0, 20, 30, 0], { parent: inner });
  host.artwork([-500, 500, 500, -500], { parent: group, hidden: true });
  host.artwork([-700, 700, 700, -700], { parent: inner, guides: true });
  host.select(group, child);
  const result = expectSuccess(host.run({ unit: 'pt' }));
  assert.equal(result.count, 1);
  assert.deepEqual(labelTexts(host), ['30 pt', '20 pt']);
});

test('invalid inputs fail before document mutations', () => {
  const invalid = [
    { mode: 'bad' }, { unit: 'bad' }, { decimals: 1.5 }, { decimals: 5 },
    { fontSize: 0 }, { fontSize: 'Infinity' }, { scale: 0 }, { scale: 'NaN' },
    { offset: -1 }, { arrow: -1 }, { strokeWidth: 0 }, { extensionGap: -1 },
    { widthPosition: 'middle' }, { bounds: 'bad' }, { arrowStyle: 'bad' },
    { doWidth: false, doHeight: false }, { prefix: 'line\nbreak' }, { suffix: 'x'.repeat(81) },
    { color: 'custom', customColor: 'oops' }
  ];
  for (const params of invalid) {
    const host = makeHost();
    const item = host.artwork([0, 20, 30, 0]);
    host.select(item);
    const result = host.run(params);
    assert.ok(result.error, JSON.stringify(params));
    assert.equal(host.doc.layers.length, 1, JSON.stringify(params));
    assert.equal(host.state.textAdds, 0);
    assert.equal(host.state.pathAdds, 0);
    assert.equal(host.doc.activeLayer, host.artworkLayer);
    assert.deepEqual(Array.from(host.doc.selection), [item]);
  }
});

test('zero offset / arrow / extension settings are accepted without default replacement', () => {
  const host = makeHost();
  host.select(host.artwork([0, 20, 100, 0]));
  expectSuccess(host.run({ doHeight: false, unit: 'pt', offset: 0, arrow: 0, extensionGap: 0, extensionOvershoot: 0 }));
  const paths = host.output().filter(item => item.typename === 'PathItem');
  assert.ok(paths.length > 0);
  assert.ok(paths.every(item => !item.filled));
  assert.ok(paths.every(item => item.points.every(point => point[1] === 0)));
});

test('zero-size dimensions are skipped and totally degenerate artwork is rejected', () => {
  const line = makeHost();
  line.select(line.artwork([20, 100, 20, 0]));
  const result = expectSuccess(line.run({ unit: 'pt' }));
  assert.equal(result.dimensionCount, 1);
  assert.match(result.warnings, /宽度为零/);
  assert.deepEqual(labelTexts(line), ['100 pt']);
  const point = makeHost();
  point.select(point.artwork([20, 20, 20, 20]));
  assert.match(point.run().error, /尺寸为零/);
  assert.equal(point.doc.layers.length, 1);
});

test('no document, no selection, TextRange and invalid bounds are handled explicitly', () => {
  assert.match(makeHost({ noDocument: true }).run().error, /文档/);
  assert.match(makeHost().run().error, /选中/);
  const text = makeHost();
  text.doc.selection = { typename: 'TextRange' };
  assert.match(text.run().error, /文字编辑/);
  const bounds = makeHost();
  bounds.select(bounds.artwork([0, 10, NaN, 0]));
  assert.match(bounds.run().error, /没有可标注/);
  assert.equal(bounds.doc.layers.length, 1);
});

test('narrow dimensions place arrow bodies outside the measured span and text off the line', () => {
  const host = makeHost();
  host.select(host.artwork([0, 10, 1, 0]));
  expectSuccess(host.run({ unit: 'pt', doHeight: false, offset: 3, arrow: 2 }));
  const paths = host.output().filter(item => item.typename === 'PathItem');
  const arrows = paths.filter(item => item.filled);
  assert.equal(arrows.length, 2);
  assertClose(arrows[0].points[0][0], 0);
  assertClose(arrows[1].points[0][0], 1);
  assert.ok(arrows[0].points.slice(1).every(point => point[0] < 0));
  assert.ok(arrows[1].points.slice(1).every(point => point[0] > 1));
  const text = host.output().find(item => item.typename === 'TextFrame');
  assert.ok(text.geometricBounds[1] < -3 * MM);
  assert.ok(paths.every(item => item.points.every(point => point.every(Number.isFinite))));
});

test('wide dimensions leave a line gap around the label and put arrow bodies inside', () => {
  const host = makeHost();
  host.select(host.artwork([0, 50, 300, 0]));
  expectSuccess(host.run({ unit: 'pt', doHeight: false, offset: 3, arrow: 2 }));
  const lineY = -3 * MM;
  const text = host.output().find(item => item.typename === 'TextFrame');
  const paths = host.output().filter(item => item.typename === 'PathItem');
  const arrows = paths.filter(item => item.filled);
  assert.ok(arrows[0].points.slice(1).every(point => point[0] > 0));
  assert.ok(arrows[1].points.slice(1).every(point => point[0] < 300));
  const lineSegments = paths.filter(item => !item.filled && item.points.every(point => Math.abs(point[1] - lineY) < 1e-6));
  assert.equal(lineSegments.length, 2);
  for (const line of lineSegments) {
    const minX = Math.min(...line.points.map(point => point[0]));
    const maxX = Math.max(...line.points.map(point => point[0]));
    assert.ok(maxX < text.geometricBounds[0] || minX > text.geometricBounds[2]);
  }
});

test('large canvas multiplies measured labels and divides physical style sizes once', () => {
  const host = makeHost({ scaleFactor: 10 });
  host.select(host.artwork([0, 10, 7.2, 0]));
  const result = expectSuccess(host.run({ unit: 'mm', doHeight: false, fontSize: 10, strokeWidth: 1, offset: 8, scale: 2 }));
  assert.deepEqual(labelTexts(host), ['50.8 mm']);
  assert.match(result.warnings, /大画布/);
  const text = host.output().find(item => item.typename === 'TextFrame');
  assertClose(text.textRange.characterAttributes.size, 1);
  const stroke = host.output().find(item => item.typename === 'PathItem' && item.stroked);
  assertClose(stroke.strokeWidth, 0.1);
  const arrow = host.output().find(item => item.typename === 'PathItem' && item.filled);
  assertClose(arrow.points[0][1], -8 * MM / 10);
});

test('clear preserves same-named user layers and unowned objects within an owned layer', () => {
  const host = makeHost();
  const userLayer = host.doc.layers.add();
  userLayer.name = '尺寸标注';
  const userArt = host.artwork([0, 10, 20, 0], { parent: userLayer });
  host.doc.activeLayer = host.artworkLayer;
  const sourceArt = host.artwork([0, 10, 100, 0]);
  host.select(sourceArt);
  expectSuccess(host.run({ doHeight: false }));
  const ownedLayer = Array.from(host.doc.layers).find(layer => layer !== host.artworkLayer && layer !== userLayer);
  const userInside = host.artwork([10, 10, 30, 0], { parent: ownedLayer });
  const result = expectSuccess(host.clear());
  assert.equal(result.removedCount, 1);
  assert.equal(userArt.removed, false);
  assert.equal(userInside.removed, false);
  assert.equal(userLayer.removed, false);
  assert.equal(ownedLayer.removed, false);
  assert.equal(labelTexts(host).length, 0);
  assert.deepEqual(Array.from(host.doc.selection), [sourceArt]);
});

test('clear last removes only the latest batch and restores locked / hidden layers', () => {
  const host = makeHost();
  const sourceArt = host.artwork([0, 10, 100, 0]);
  host.select(sourceArt);
  expectSuccess(host.run({ doHeight: false }));
  const first = host.output().find(item => /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|/.test(item.note));
  first.note = 'AI_DESIGN_TOOLBOX_DIMENSION_V1|batch|100';
  expectSuccess(host.run({ doHeight: false }));
  const second = host.output().find(item => /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|/.test(item.note) && item !== first);
  second.note = 'AI_DESIGN_TOOLBOX_DIMENSION_V1|batch|200';
  const ownedLayer = first.parent;
  ownedLayer.locked = true;
  ownedLayer.visible = false;
  host.select(sourceArt, second);
  const result = expectSuccess(host.clear('last'));
  assert.equal(result.removedCount, 1);
  assert.equal(first.removed, false);
  assert.equal(second.removed, true);
  assert.equal(ownedLayer.locked, true);
  assert.equal(ownedLayer.visible, false);
  assert.deepEqual(Array.from(host.doc.selection), [sourceArt]);
});

test('draw failure rolls back a new layer and restores artwork selection', () => {
  const host = makeHost({ failPathAt: 2, mutateSelectionOnLayerAdd: true });
  const sourceArt = host.artwork([0, 20, 100, 0]);
  host.select(sourceArt);
  assert.match(host.run().error, /Injected path creation failure/);
  assert.equal(host.doc.layers.length, 1);
  assert.equal(host.output().length, 0);
  assert.equal(sourceArt.removed, false);
  assert.equal(host.doc.activeLayer, host.artworkLayer);
  assert.deepEqual(Array.from(host.doc.selection), [sourceArt]);
});

test('draw failure in an existing owned layer preserves earlier batches', () => {
  const host = makeHost({ failTextAt: 2 });
  const sourceArt = host.artwork([0, 20, 100, 0]);
  host.select(sourceArt);
  expectSuccess(host.run({ doHeight: false }));
  const priorLabels = labelTexts(host);
  assert.match(host.run({ doHeight: false }).error, /Injected text creation failure/);
  assert.deepEqual(labelTexts(host), priorLabels);
  assert.equal(host.output().filter(item => /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|/.test(item.note)).length, 1);
  assert.equal(host.doc.layers.length, 2);
});

test('owned annotation selection is ignored when measuring original artwork again', () => {
  const host = makeHost();
  const original = host.artwork([0, 20, 100, 0]);
  host.select(original);
  expectSuccess(host.run({ doHeight: false, unit: 'pt' }));
  const oldLabel = host.output().find(item => item.typename === 'TextFrame');
  host.select(original, oldLabel);
  const result = expectSuccess(host.run({ doHeight: false, unit: 'pt' }));
  assert.equal(result.count, 1);
  assert.match(result.warnings, /跳过/);
  assert.deepEqual(labelTexts(host), ['100 pt', '100 pt']);
});

test('clear unlocks nested ancestors before children and restores their individual lock states', () => {
  const host = makeHost();
  const sourceArt = host.artwork([0, 20, 100, 0]);
  host.select(sourceArt);
  expectSuccess(host.run({ doHeight: false }));
  const batch = host.output().find(item => /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|/.test(item.note));
  const ownedLayer = batch.parent;
  const outer = host.doc.layers.add();
  outer.name = 'Outer';
  const middle = outer.layers.add();
  middle.name = 'Middle';
  ownedLayer.move(middle);
  ownedLayer.locked = true;
  ownedLayer.visible = false;
  middle.locked = true;
  outer.locked = true;
  host.doc.activeLayer = host.artworkLayer;
  const result = expectSuccess(host.clear());
  assert.equal(result.removedCount, 1);
  assert.equal(ownedLayer.locked, true);
  assert.equal(ownedLayer.visible, false);
  assert.equal(middle.locked, true);
  assert.equal(outer.locked, true);
  assert.equal(host.doc.activeLayer, host.artworkLayer);
});

test('last clear chooses the latest batch even when generation timestamps share a millisecond', () => {
  const host = makeHost();
  host.context.Date = class FixedDate { getTime() { return 1000; } };
  host.select(host.artwork([0, 20, 100, 0]));
  expectSuccess(host.run({ doHeight: false }));
  const first = host.output().find(item => /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|/.test(item.note));
  expectSuccess(host.run({ doHeight: false }));
  const second = host.output().find(item => /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|/.test(item.note) && item !== first);
  expectSuccess(host.clear('last'));
  assert.equal(first.removed, false);
  assert.equal(second.removed, true);
});

test('annotation strokes do not inherit dashed or outlined text styles', () => {
  const host = makeHost();
  host.select(host.artwork([0, 20, 100, 0]));
  expectSuccess(host.run({ doHeight: false }));
  for (const item of host.output()) {
    if (item.typename === 'PathItem' && item.stroked) assert.equal(item.strokeDashes.length, 0);
    if (item.typename === 'TextFrame') assert.equal(item.textRange.characterAttributes.strokeWeight, 0);
  }
});

test('two explicit points use Euclidean distance, normal offsets and true endpoint arrow tips', () => {
  const host = makeHost();
  const result = expectSuccess(host.run({ mode: 'points', points: [[10, 20], [40, 60]], unit: 'pt',
    alignedSide: 'left', offset: 2, extensionGap: 0.5, extensionOvershoot: 1, arrow: 1 }));
  assert.equal(result.count, 1);
  assert.equal(result.dimensionCount, 1);
  assert.deepEqual(labelTexts(host), ['50 pt']);
  const [start, end] = arrowTips(host)[0];
  assertClose(start[0], 10 - 0.8 * 2 * MM);
  assertClose(start[1], 20 + 0.6 * 2 * MM);
  assertClose(end[0], 40 - 0.8 * 2 * MM);
  assertClose(end[1], 60 + 0.6 * 2 * MM);
  const extensions = dimensionGroups(host)[0]._children.filter(item => item.typename === 'PathItem' && !item.filled).slice(0, 2);
  assertClose(extensions[0].points[0][0], 10 - 0.8 * 0.5 * MM);
  assertClose(extensions[0].points[0][1], 20 + 0.6 * 0.5 * MM);
  assertClose(extensions[0].points[1][0], 10 - 0.8 * 3 * MM);
  assertClose(extensions[0].points[1][1], 20 + 0.6 * 3 * MM);
  const text = dimensionGroups(host)[0]._children.find(item => item.typename === 'TextFrame');
  assertClose(text.rotation, Math.atan2(4, 3) * 180 / Math.PI);
  assert.equal(host.doc.selection.length, 0);
});

test('point order controls left and right while labels remain readable at arbitrary angles', () => {
  for (const degrees of [-179, -135, -91, -90, -43, 0, 17, 89, 90, 91, 145, 180]) {
    for (const side of ['auto', 'left', 'right']) {
      const host = makeHost(), angle = degrees * Math.PI / 180;
      const end = [100 * Math.cos(angle), 100 * Math.sin(angle)];
      expectSuccess(host.run({ mode: 'points', points: [[0, 0], end], unit: 'pt', alignedSide: side, offset: 1 }));
      assert.deepEqual(labelTexts(host), ['100 pt']);
      const text = dimensionGroups(host)[0]._children.find(item => item.typename === 'TextFrame');
      assert.ok(text.rotation >= -90 && text.rotation <= 90, String(degrees));
      const sign = side === 'right' ? -1 : 1;
      assertClose(arrowTips(host)[0][0][0], -Math.sin(angle) * MM * sign);
      assertClose(arrowTips(host)[0][0][1], Math.cos(angle) * MM * sign);
    }
  }
  const forward = makeHost(), reverse = makeHost();
  expectSuccess(forward.run({ mode: 'points', points: [[0, 0], [30, 40]], alignedSide: 'left' }));
  expectSuccess(reverse.run({ mode: 'points', points: [[30, 40], [0, 0]], alignedSide: 'right' }));
  arrowTips(forward)[0].forEach((tip, index) => tip.forEach((value, axis) => assertClose(value, arrowTips(reverse)[0][1 - index][axis])));
});

test('diagonal label fit uses unrotated width and leaves the expected along-line opening', () => {
  const host = makeHost(), length = 50, angle = Math.PI / 4;
  expectSuccess(host.run({ mode: 'points', points: [[0, 0], [length * Math.cos(angle), length * Math.sin(angle)]],
    unit: 'pt', offset: 0, arrow: 0, extensionGap: 0, extensionOvershoot: 0, fontSize: 10 }));
  const group = dimensionGroups(host)[0], text = group._children.find(item => item.typename === 'TextFrame');
  const lines = group._children.filter(item => item.typename === 'PathItem');
  assert.equal(lines.length, 2);
  const measuredLabelWidth = '50 pt'.length * 10 * 0.55;
  const project = p => (p[0] + p[1]) / Math.sqrt(2);
  assertClose(project(lines[0].points[1]), 25 - measuredLabelWidth / 2 - 3);
  assertClose(project(lines[1].points[0]), 25 + measuredLabelWidth / 2 + 3);
  assertClose((text.geometricBounds[0] + text.geometricBounds[2]) / 2, length / 2 / Math.sqrt(2));
  assertClose((text.geometricBounds[1] + text.geometricBounds[3]) / 2, length / 2 / Math.sqrt(2));
});

test('aligned rotated closed polygons include the closing edge and place automatic offsets outward', () => {
  const vertices = [[0, 0], [30, 40], [-10, 70], [-40, 30]];
  for (const reverse of [false, true]) {
    const host = makeHost();
    host.select(edgeArtwork(host, reverse ? vertices.slice().reverse() : vertices));
    const result = expectSuccess(host.run({ mode: 'aligned', unit: 'pt', offset: 1 }));
    assert.equal(result.count, 1);
    assert.equal(result.dimensionCount, 4);
    assert.deepEqual(labelTexts(host), ['50 pt', '50 pt', '50 pt', '50 pt']);
    const center = [-5, 35];
    for (const [start, end] of arrowTips(host)) {
      const middle = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      assertClose(Math.hypot(middle[0] - center[0], middle[1] - center[1]), 25 + MM);
    }
  }
});

test('aligned open paths use deterministic left auto side and explicit side overrides', () => {
  for (const side of ['auto', 'left', 'right']) {
    const host = makeHost();
    host.select(edgeArtwork(host, [[5, 8], [35, 48], [65, 88]], { closed: false }));
    const result = expectSuccess(host.run({ mode: 'aligned', alignedSide: side, unit: 'pt', offset: 1 }));
    assert.equal(result.dimensionCount, 2);
    const sign = side === 'right' ? -1 : 1;
    assertClose(arrowTips(host)[0][0][0], 5 - 0.8 * MM * sign);
    assertClose(arrowTips(host)[0][0][1], 8 + 0.6 * MM * sign);
  }
});

test('direct selection dimensions only edges with both endpoints selected and preserves exact anchor/handle states', () => {
  for (const failPathAt of [undefined, 2]) {
    const host = makeHost({ selectsAllAnchorsOnRestore: true, mutateSelectionOnLayerAdd: true, failPathAt });
    const artwork = edgeArtwork(host, [[0, 0], [30, 40], [50, 30], [40, 0]]);
    host.select(artwork);
    const selected = ['ANCHORPOINT', 'ANCHORPOINT', 'RIGHTDIRECTION', 'NOSELECTION'];
    artwork.pathPoints.forEach((point, index) => { point.selected = selected[index]; });
    const original = JSON.stringify(artwork.pathPoints), result = host.run({ mode: 'aligned', unit: 'pt' });
    if (failPathAt) {
      assert.match(result.error, /Injected/);
      assert.equal(host.doc.layers.length, 1);
    } else {
      expectSuccess(result);
      assert.equal(result.dimensionCount, 1);
      assert.deepEqual(labelTexts(host), ['50 pt']);
    }
    assert.equal(JSON.stringify(artwork.pathPoints), original);
    assert.deepEqual(Array.from(host.doc.selection), [artwork]);
    assert.equal(host.doc.activeLayer, host.artworkLayer);
  }
});

test('selected closing endpoints measure their closing edge while non-adjacent anchors produce no false diagonal', () => {
  const host = makeHost(), art = edgeArtwork(host, [[0, 0], [30, 40], [50, 30], [40, 0]]);
  host.select(art);
  art.pathPoints[0].selected = art.pathPoints[3].selected = 'ANCHORPOINT';
  const result = expectSuccess(host.run({ mode: 'aligned', unit: 'pt' }));
  assert.equal(result.dimensionCount, 1);
  assert.deepEqual(labelTexts(host), ['40 pt']);
  art.pathPoints[3].selected = 'NOSELECTION';
  art.pathPoints[2].selected = 'ANCHORPOINT';
  assert.match(host.run({ mode: 'aligned' }).error, /没有可标注/);
});

test('curved and overshooting Bezier segments are skipped, collinear in-segment controls are straight', () => {
  const host = makeHost(), art = edgeArtwork(host, [[0, 0], [30, 40], [60, 80], [90, 120], [120, 160]], { closed: false });
  art.pathPoints[0].rightDirection = [9, 12];
  art.pathPoints[1].leftDirection = [21, 28]; // Both lie on the first edge.
  art.pathPoints[1].rightDirection = [50, 40]; // A genuine curve.
  art.pathPoints[3].leftDirection = [120, 160]; // Collinear but overshoots the third edge.
  host.select(art);
  const original = JSON.stringify(art.pathPoints);
  const result = expectSuccess(host.run({ mode: 'aligned', unit: 'pt' }));
  assert.equal(result.dimensionCount, 2);
  assert.match(result.warnings, /2 段曲线/);
  assert.deepEqual(labelTexts(host), ['50 pt', '50 pt']);
  assert.equal(JSON.stringify(art.pathPoints), original);
});

test('two selected anchors can span different paths and selected 2-point lines work directly', () => {
  const host = makeHost();
  const first = edgeArtwork(host, [[0, 0], [10, 0], [10, 10]]);
  const second = edgeArtwork(host, [[30, 40], [60, 0], [60, 10]]);
  first.pathPoints[0].selected = second.pathPoints[0].selected = 'ANCHORPOINT';
  host.select(first, second);
  const result = expectSuccess(host.run({ mode: 'points', unit: 'pt' }));
  assert.equal(result.dimensionCount, 1);
  assert.deepEqual(labelTexts(host), ['50 pt']);
  const line = makeHost();
  line.select(edgeArtwork(line, [[0, 0], [3, 4]], { closed: false }));
  expectSuccess(line.run({ mode: 'points', unit: 'pt' }));
  assert.deepEqual(labelTexts(line), ['5 pt']);
});

test('point fallback rejects missing, excess and handle-only selection without creating annotation items', () => {
  for (const count of [0, 1, 3]) {
    const host = makeHost(), art = edgeArtwork(host, [[0, 0], [20, 0], [20, 20]]);
    art.pathPoints.forEach((point, index) => { point.selected = index < count ? 'ANCHORPOINT' : 'NOSELECTION'; });
    host.select(art);
    assert.match(host.run({ mode: 'points' }).error, /两个点/);
    assert.equal(host.doc.layers.length, 1);
    assert.equal(host.state.textAdds, 0);
  }
  const host = makeHost(), art = edgeArtwork(host, [[0, 0], [20, 0]], { closed: false });
  art.pathPoints[0].selected = 'LEFTRIGHTPOINT';
  host.select(art);
  assert.match(host.run({ mode: 'points' }).error, /两个点/);
  assert.match(host.run({ mode: 'aligned' }).error, /没有可标注/);
});

test('path traversal supports nested groups and compound masks while skipping hidden and clipped artwork', () => {
  const host = makeHost(), outer = host.container(host.artworkLayer, 'GroupItem');
  const inner = host.container(outer, 'GroupItem');
  const child = edgeArtwork(host, [[0, 0], [3, 4]], { parent: inner, closed: false });
  edgeArtwork(host, [[0, 0], [300, 400]], { parent: inner, hidden: true, closed: false });
  edgeArtwork(host, [[0, 0], [300, 400]], { parent: inner, guides: true, closed: false });
  const clipped = host.container(outer, 'GroupItem');
  clipped.clipped = true;
  const outside = edgeArtwork(host, [[-500, -500], [500, 500]], { parent: clipped, closed: false });
  const mask = host.container(clipped, 'CompoundPathItem');
  edgeArtwork(host, [[0, 0], [6, 8]], { parent: mask, closed: false, clipping: true });
  const hiddenGroup = host.container(outer, 'GroupItem');
  hiddenGroup.hidden = true;
  const hiddenChild = edgeArtwork(host, [[0, 0], [300, 400]], { parent: hiddenGroup, closed: false });
  host.select(outer, child, outside, hiddenChild);
  const result = expectSuccess(host.run({ mode: 'aligned', unit: 'pt' }));
  assert.equal(result.count, 2);
  assert.equal(result.dimensionCount, 2);
  assert.deepEqual(labelTexts(host), ['5 pt', '10 pt']);
});

test('aligned ignores annotation paths and excludes zero-length segments', () => {
  const host = makeHost(), art = edgeArtwork(host, [[0, 0], [0, 0], [3, 4]], { closed: false });
  host.select(art);
  const first = expectSuccess(host.run({ mode: 'aligned', unit: 'pt' }));
  assert.equal(first.dimensionCount, 1);
  assert.match(first.warnings, /零长度/);
  const generated = dimensionGroups(host)[0];
  host.select(art, generated);
  const second = expectSuccess(host.run({ mode: 'aligned', unit: 'pt' }));
  assert.equal(second.dimensionCount, 1);
  assert.deepEqual(labelTexts(host), ['5 pt', '5 pt']);
});

test('points validate raw coordinates and sides before mutation and ignore axis-only settings', () => {
  for (const points of [null, [], [[0, 0]], [[0, 0], [0, 0]], [[0, 0], [null, 2]], [[0, 0], ['2', 3]], [[0, 0], [2, 3, 4]], [[0, 0], [1e308, 1e308]]]) {
    const host = makeHost();
    assert.ok(host.run({ mode: 'points', points }).error, JSON.stringify(points));
    assert.equal(host.doc.layers.length, 1);
    assert.equal(host.state.pathAdds, 0);
  }
  const host = makeHost();
  assert.ok(host.run({ mode: 'points', points: [[0, 0], [3, 4]], alignedSide: 'wrong' }).error);
  expectSuccess(host.run({ mode: 'points', points: [[0, 0], [3, 4]], unit: 'pt', bounds: 'ignored', doWidth: false, doHeight: false }));
  assert.deepEqual(labelTexts(host), ['5 pt']);
});

test('diagonal large-canvas measurement scales label and styles once with rollback on subsequent failure', () => {
  const host = makeHost({ scaleFactor: 10, failTextAt: 2 });
  const params = { mode: 'points', points: [[0, 0], [3, 4]], unit: 'pt', offset: 1, scale: 2, fontSize: 10, strokeWidth: 1 };
  const result = expectSuccess(host.run(params));
  assert.deepEqual(labelTexts(host), ['100 pt']);
  assert.match(result.warnings, /大画布/);
  assertClose(arrowTips(host)[0][0][0], -0.8 * MM / 10);
  const group = dimensionGroups(host)[0];
  assertClose(group._children.find(item => item.typename === 'TextFrame').textRange.characterAttributes.size, 1);
  assertClose(group._children.find(item => item.typename === 'PathItem' && item.stroked).strokeWidth, 0.1);
  assert.match(host.run(params).error, /Injected/);
  assert.equal(dimensionGroups(host).length, 1);
  assert.deepEqual(labelTexts(host), ['100 pt']);
});
