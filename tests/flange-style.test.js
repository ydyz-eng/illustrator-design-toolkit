/* Run: node tests/flange-style.test.js. Illustrator host contract + geometry regression tests. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../jsx/tools.jsx'), 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }

function contour(coords, style = {}, closed = true) {
  return Object.assign({
    typename: 'PathItem', closed, filled: false, stroked: false,
    geometricBounds: [Math.min(...coords.map(p => p[0])), Math.max(...coords.map(p => p[1])),
      Math.max(...coords.map(p => p[0])), Math.min(...coords.map(p => p[1]))],
    pathPoints: coords.map(p => ({ anchor: p.slice(), leftDirection: p.slice(), rightDirection: p.slice() }))
  }, style);
}
function square(x = 0, y = 0, style = {}) {
  return contour([[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100]], style);
}
const appearanceKeys = ['filled', 'stroked', 'fillColor', 'strokeColor', 'strokeWidth', 'strokeCap',
  'strokeJoin', 'strokeMiterLimit', 'strokeDashes', 'strokeDashOffset', 'opacity', 'blendingMode',
  'fillOverprint', 'strokeOverprint', 'evenodd', 'artworkKnockout', 'opaqueAppearance'];

function flangeHost(selection, options = {}) {
  const copies = [], layers = [];
  let duplicateCount = 0;
  const originalLayer = { name: 'Original artwork', remove() { throw new Error('Original layer removed'); } };
  layers.push(originalLayer);
  layers.add = () => {
    const layer = { typename: 'Layer', items: [], removed: false,
      remove() { this.removed = true; this.items.forEach(item => { item.removed = true; }); },
      pathItems: { add() { throw new Error('Creating a default-style path discards the source appearance'); } } };
    layers.push(layer); return layer;
  };
  function installDuplicate(item) {
    if (item.typename === 'GroupItem') return item.pageItems.forEach(installDuplicate);
    if (item.typename === 'CompoundPathItem') return item.pathItems.forEach(installDuplicate);
    item.duplicate = (parent, insertion) => {
      duplicateCount++;
      if (duplicateCount === options.failDuplicateAt) throw new Error('Cannot duplicate appearance');
      assert.equal(parent, layers[1]);
      assert.equal(insertion, 'at-end');
      const data = Object.assign({}, item, { parent, closed: item.closed, sourceItem: item, removed: false,
        pathPoints: item.pathPoints.map(p => Object.assign({}, p)),
        setEntirePath(points) {
          if (options.failGeometry) throw new Error('Cannot replace geometry');
          this.pathPoints = points.map(p => ({ anchor: Array.from(p), leftDirection: [999, 999], rightDirection: [-999, -999] }));
        } });
      // Appearance values are opaque host data. A path duplicate carries them, and
      // the flange operation must not flatten or override any of them afterwards.
      const copy = new Proxy(data, { set(target, key, value) {
        if (appearanceKeys.includes(key)) throw new Error('Source appearance overwritten: ' + key);
        target[key] = value; return true;
      } });
      copies.push(copy); parent.items.push(copy); return copy;
    };
  }
  selection.forEach(installDuplicate);
  const ctx = vm.createContext({ app: { documents: [{}], selection, activeDocument: { layers } },
    ElementPlacement: { PLACEATEND: 'at-end' }, PointType: { CORNER: 'corner' }, $: { writeln() {} } });
  vm.runInContext(source, ctx);
  const run = (params = {}) => JSON.parse(ctx.toolFlange(JSON.stringify(Object.assign({ widthMm: 5, angleDeg: 45,
    top: true, bottom: true, left: true, right: true, chop: false, outerOnly: true }, params))));
  return { run, copies, layers, originalLayer };
}
function assertAppearance(copy, original) {
  appearanceKeys.forEach(key => assert.strictEqual(copy[key], original[key], key + ' must remain unchanged'));
}
function assertFourStraightCorners(copy) {
  assert.equal(copy.closed, true);
  assert.equal(copy.pathPoints.length, 4);
  copy.pathPoints.forEach(point => {
    assert.deepEqual(point.leftDirection, point.anchor);
    assert.deepEqual(point.rightDirection, point.anchor);
    assert.equal(point.pointType, 'corner');
  });
}

test('closed all-sides flanges inherit fill, dashed stroke, overprint and complete path appearance', () => {
  const original = square(0, 0, { filled: true, stroked: true,
    fillColor: { typename: 'GradientColor', gradient: { name: 'Brand gradient' }, origin: [30, 40], angle: 35 },
    strokeColor: { typename: 'SpotColor', spot: { name: 'Cut spot' }, tint: 72 },
    strokeWidth: 2.5, strokeCap: 'round', strokeJoin: 'bevel', strokeMiterLimit: 7,
    strokeDashes: [8, 2, 1, 2], strokeDashOffset: 3, opacity: 67, blendingMode: 'multiply',
    fillOverprint: true, strokeOverprint: true, evenodd: true, artworkKnockout: 'enabled',
    opaqueAppearance: { brush: 'Art brush', multipleStrokes: ['outer', 'inner'] } });
  const before = JSON.stringify(original);
  const state = flangeHost([original]);
  assert.equal(state.run().count, 4);
  state.copies.forEach(copy => { assertAppearance(copy, original); assertFourStraightCorners(copy); });
  assert.equal(JSON.stringify(original), before);
});

test('single outer-side branch preserves stroke-only artwork without adding a black fill', () => {
  const original = square(0, 0, { filled: false, stroked: true, strokeWidth: 0.4,
    fillColor: { typename: 'NoColor' }, strokeColor: { typename: 'CMYKColor', cyan: 100, magenta: 10, yellow: 0, black: 0 },
    strokeDashes: [4, 3], strokeDashOffset: 1 });
  const state = flangeHost([original]);
  const result = state.run({ bottom: false, left: false, right: false });
  assert.equal(result.count, 1);
  assertAppearance(state.copies[0], original);
  assertFourStraightCorners(state.copies[0]);
  assert.deepEqual(state.copies[0].pathPoints.map(p => p.anchor), [[100, 100], [100, 114.173228345], [0, 114.173228345], [0, 100]]);
});

test('open paths generate both sides with original stroke format and remain open themselves', () => {
  const original = contour([[0, 0], [100, 0]], { filled: false, stroked: true,
    strokeColor: { typename: 'PatternColor', pattern: { name: 'Cut pattern' } }, strokeWidth: 3,
    strokeCap: 'projecting', strokeJoin: 'round', strokeDashes: [6, 2], strokeDashOffset: 2 }, false);
  const state = flangeHost([original]);
  const result = state.run({ left: false, right: false });
  assert.equal(result.count, 2);
  state.copies.forEach(copy => { assertAppearance(copy, original); assertFourStraightCorners(copy); });
  assert.equal(original.closed, false);
  const outerYs = state.copies.map(copy => copy.pathPoints[1].anchor[1]).sort((a, b) => a - b);
  assert.deepEqual(outerYs, [-14.173228345, 14.173228345]);
});

test('group and compound-path children retain their individual colors and no-stroke flags', () => {
  const a = square(0, 0, { filled: true, stroked: false, fillColor: { typename: 'RGBColor', red: 220, green: 10, blue: 40 } });
  const b = square(200, 0, { filled: true, stroked: true, fillColor: { typename: 'PatternColor', pattern: { name: 'Tiles' } }, strokeWidth: 5 });
  const c = square(400, 0, { filled: false, stroked: false });
  const state = flangeHost([{ typename: 'GroupItem', pageItems: [a, { typename: 'CompoundPathItem', pathItems: [b, c] }] }]);
  const result = state.run({ outerOnly: false });
  assert.equal(result.pathCount, 3); assert.equal(result.count, 12);
  [a, b, c].forEach(original => {
    const produced = state.copies.filter(copy => copy.sourceItem === original);
    assert.equal(produced.length, 4);
    produced.forEach(copy => assertAppearance(copy, original));
  });
});

test('chopped flanges retain prior geometry and reset all inherited Bezier handles', () => {
  const original = square();
  // The right edge is curved; its handles must never leak into a top flange.
  original.pathPoints[1].rightDirection = [115, 35];
  original.pathPoints[2].leftDirection = [115, 70];
  const before = JSON.stringify(original.pathPoints);
  const state = flangeHost([original]);
  assert.equal(state.run({ bottom: false, left: false, right: false, chop: true }).count, 1);
  const copy = state.copies[0], width = 14.173228345;
  assertFourStraightCorners(copy);
  const anchors = copy.pathPoints.map(p => p.anchor);
  const expected = [[100, 100], [100 - width, 100 + width], [width, 100 + width], [0, 100]];
  anchors.forEach((point, index) => point.forEach((n, axis) => assert(Math.abs(n - expected[index][axis]) < 1e-9)));
  assert.equal(JSON.stringify(original.pathPoints), before);
});

test('a source with many anchors is replaced by exactly four flange corners', () => {
  const original = contour([[0, 0], [30, 0], [60, 0], [100, 0], [100, 100], [60, 100], [30, 100], [0, 100]]);
  const state = flangeHost([original]);
  assert.equal(state.run().count, 8);
  state.copies.forEach(assertFourStraightCorners);
  assert.equal(original.pathPoints.length, 8);
});

test('a duplication failure removes only the incomplete output batch', () => {
  const original = square(0, 0, { filled: false, stroked: true });
  const before = JSON.stringify(original);
  const state = flangeHost([original], { failDuplicateAt: 2 });
  assert.match(state.run().error, /Cannot duplicate appearance/);
  assert.equal(state.layers[1].removed, true);
  assert.equal(state.copies.length, 1); assert.equal(state.copies[0].removed, true);
  assert.equal(state.layers[0], state.originalLayer);
  assert.equal(JSON.stringify(original), before);
});

test('a geometry failure also removes the duplicated source and batch layer', () => {
  const original = square();
  const state = flangeHost([original], { failGeometry: true });
  assert.match(state.run().error, /Cannot replace geometry/);
  assert.equal(state.layers[1].removed, true);
  assert.equal(state.copies[0].removed, true);
  assert.equal(original.pathPoints.length, 4);
});

console.log('\n' + passed + ' flange regressions passed.');
