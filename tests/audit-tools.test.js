/* Run: node tests/audit-tools.test.js. No Illustrator or dependencies needed. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../jsx/tools.jsx'), 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function host(extra) {
  const context = vm.createContext(Object.assign({
    app: { documents: [{}], activeDocument: {}, redraw() {} },
    $: { writeln() {} }
  }, extra));
  vm.runInContext(source, context);
  return context;
}
function contour(coords, closed = true, length = 72) {
  return {
    typename: 'PathItem', closed, length,
    geometricBounds: [Math.min(...coords.map(p => p[0])), Math.max(...coords.map(p => p[1])),
      Math.max(...coords.map(p => p[0])), Math.min(...coords.map(p => p[1]))],
    pathPoints: coords.map(p => ({ anchor: p, leftDirection: p, rightDirection: p }))
  };
}
function square(min, max, length) { return contour([[min, min], [max, min], [max, max], [min, max]], true, length); }
function measure(items, scaleFactor = 1) {
  const ctx = host();
  ctx.app.activeDocument = { selection: items, scaleFactor };
  return JSON.parse(ctx.toolLineLength('in'));
}
test('open paths contribute length but never hole counts', () => {
  const result = measure([square(0, 10), contour([[2, 2], [3, 3]], false)]);
  assert.equal(result.pathCount, 2);
  assert.equal(result.innerCount, 0);
  assert.equal(result.openCount, 1);
  assert.equal(result.closedCount, 1);
  assert.equal(result.length, '2.0000 in');
});
test('nested material islands are not counted as holes', () => {
  const result = measure([square(0, 100), square(10, 90), square(20, 80), square(30, 70)]);
  assert.equal(result.outerCount, 1);
  assert.equal(result.innerCount, 2);
  assert.equal(result.islandCount, 1);
});
test('bounding-box containment alone cannot invent a hole', () => {
  const triangle = contour([[0, 0], [10, 0], [0, 10]]);
  const result = measure([triangle, square(6, 7)]);
  assert.equal(result.innerCount, 0);
  assert.equal(result.outerCount, 2);
});
test('inner edges crossing a concave boundary are rejected', () => {
  const outer = contour([[0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]]);
  const crossing = contour([[1, 2], [9, 2], [9, 8], [1, 8]]);
  assert.equal(measure([outer, crossing]).innerCount, 0);
});
test('curved contours use handles, not just anchors', () => {
  const circle = contour([[10, 0], [0, 10], [-10, 0], [0, -10]]);
  const k = 5.5228475;
  const handles = [[[10, -k], [10, k]], [[k, 10], [-k, 10]], [[-10, k], [-10, -k]], [[-k, -10], [k, -10]]];
  circle.pathPoints.forEach((p, i) => { p.leftDirection = handles[i][0]; p.rightDirection = handles[i][1]; });
  const trueInner = contour([[6, 6], [6.5, 6], [6.5, 6.5], [6, 6.5]]);
  assert.equal(measure([circle, trueInner]).innerCount, 1);
});
test('duplicate references, guides and clipping paths are excluded', () => {
  const item = square(0, 10);
  const guide = Object.assign(square(2, 3), { guides: true });
  const clip = Object.assign(square(4, 5), { clipping: true });
  const result = measure([{ typename: 'GroupItem', pageItems: [item, guide, clip] }, item]);
  assert.equal(result.pathCount, 1);
  assert.equal(result.innerCount, 0);
  assert.equal(result.skippedCount, 2);
});
test('large canvas length uses document scale factor', () => {
  assert.equal(measure([square(0, 10)], 10).length, '10.0000 in');
});
test('JSON response escapes all control characters', () => {
  const ctx = host();
  const value = '\u0000\b\f\n\r\t"\\';
  assert.equal(JSON.parse(ctx._jsonError(value)).error, value);
});
test('numeric inputs reject blank, null, nonfinite and partial numbers', () => {
  const ctx = host();
  [null, undefined, '', ' ', Infinity, '-Infinity', '12mm', false].forEach(value => assert(Number.isNaN(ctx._toolNumber(value))));
  assert.equal(ctx._toolNumber('0'), 0);
  assert.equal(ctx._toolNumber('1.25'), 1.25);
});
test('zero flange width no longer silently becomes 5 mm', () => {
  const ctx = host(); ctx.app.selection = [{}];
  assert(JSON.parse(ctx.toolFlange(JSON.stringify({ widthMm: 0, angleDeg: 45, top: true }))).error);
});
test('fractional distribution/division counts are rejected before mutation', () => {
  const ctx = host(); ctx.app.selection = [{}]; ctx.app.activeDocument.selection = [{}, {}];
  assert(JSON.parse(ctx.toolDivideCurve(JSON.stringify({ parts: 2.5, markerMm: 1 }))).error);
  assert(JSON.parse(ctx.toolDistributeAlongPath(JSON.stringify({ count: 2.5, angleOffset: 0, endScale: 100 }))).error);
});
test('plain replacement is literal, empty-safe and preserves Unicode indices', () => {
  const ctx = host();
  assert.equal(ctx._replacePlainText('a.* a.*', 'a.*', '$&', true).text, '$& $&');
  assert.equal(ctx._replacePlainText('anything', '', 'x', true).text, 'anything');
  assert.equal(ctx._replacePlainText('\u0130AB', 'ab', 'Z', false).text, '\u0130Z');
});
function textFrame(content) {
  let chars = content.split('').map((text, i) => ({ text, style: i }));
  const frame = { typename: 'TextFrame', parent: { typename: 'Document' }, get contents() { return chars.map(c => c.text).join(''); },
    set contents(value) { throw new Error('Whole-frame write destroys formatting'); },
    styles() { return chars.map(c => c.style); } };
  Object.defineProperty(frame, 'textRange', { get() { return { characters: new Proxy({}, { get(target, key) {
    const start = Number(key);
    return { length: 1, set contents(value) {
      const style = chars[start].style;
      chars.splice(start, this.length, ...String(value).split('').map(text => ({ text, style })));
    } };
  } }) }; } });
  return frame;
}
test('text replacement retains unaffected styling and uses backward ranges', () => {
  const ctx = host(), frame = textFrame('AB xx AB!');
  ctx.app.activeDocument = { textFrames: [frame] };
  const result = JSON.parse(ctx.toolReplaceText('AB', 'Long', true, false, true));
  assert.equal(result.count, 2); assert.equal(result.changed, 1); assert.equal(result.skipped, 0);
  assert.equal(frame.contents, 'Long xx Long!');
  assert.deepEqual(frame.styles().slice(4, 8), [2, 3, 4, 5]);
  assert.equal(frame.styles().at(-1), 8);
});
test('text replacement normalizes multiline input and deduplicates selected frames', () => {
  const ctx = host(), frame = textFrame('A\rB');
  ctx.app.activeDocument = { selection: [{ typename: 'GroupItem', pageItems: [frame] }, frame] };
  const result = JSON.parse(ctx.toolReplaceText('A\nB', 'C\nD', true, true, true));
  assert.equal(result.scanned, 1); assert.equal(result.count, 1); assert.equal(frame.contents, 'C\rD');
});
function exportHost(failDuplicate = false) {
  const files = new Set(['/exports/export_001.ai', '/exports/export_001.dxf']);
  const saved = [], tempDocs = [];
  const ctx = host({
    File: function (name) { this.fsName = name; Object.defineProperty(this, 'exists', { get: () => files.has(name) }); },
    Folder: { selectDialog: () => ({ fsName: '/exports' }) },
    IllustratorSaveOptions: function () {}, ExportOptionsAutoCAD: function () {},
    Compatibility: { ILLUSTRATOR3: 3 }, ExportType: { AUTOCAD: 1 },
    SaveOptions: { DONOTSAVECHANGES: 2 }, ElementPlacement: { PLACEATBEGINNING: 1 }
  });
  const selection = ['keep-selected'];
  const srcDoc = { selection, documentColorSpace: 1, activate() { ctx.app.activeDocument = this; } };
  const layer = { typename: 'Layer', visible: true, layers: [], pageItems: [] };
  const item = { typename: 'PathItem', parent: layer, geometricBounds: [0, 10, 10, 0], visibleBounds: [-1, 11, 11, -1],
    duplicate() { if (failDuplicate) throw new Error('duplicate failed'); return { visibleBounds: [-1, 11, 11, -1], translate() {} }; } };
  layer.pageItems.push(item); srcDoc.layers = [layer];
  const foreign = { close() { throw new Error('Must not close unrelated documents'); } };
  ctx.app = { activeDocument: srcDoc, copy() { throw new Error('Clipboard mutated'); }, paste() { throw new Error('Clipboard mutated'); },
    documents: { length: 1, add() {
      const temp = { layers: [{}], artboards: [{}], closeCount: 0, close() { this.closeCount++; },
        saveAs(file) { saved.push(file.fsName); files.add(file.fsName); }, exportFile(file) { saved.push(file.fsName); files.add(file.fsName); } };
      tempDocs.push(temp); ctx.app.activeDocument = foreign; return temp;
    } } };
  return { ctx, srcDoc, selection, tempDocs, saved, files };
}
test('batch AI export avoids overwrites and preserves original document/selection/clipboard', () => {
  const state = exportHost();
  const result = JSON.parse(state.ctx.toolBatchExportTopItems('AI3'));
  assert.equal(result.count, 1); assert.equal(result.failed, 0);
  assert.deepEqual(state.saved, ['/exports/export_001_2.ai']);
  assert.strictEqual(state.ctx.app.activeDocument, state.srcDoc);
  assert.strictEqual(state.srcDoc.selection, state.selection);
  assert.equal(state.tempDocs[0].closeCount, 1);
});
test('batch DXF export avoids overwrites without deleting existing files', () => {
  const state = exportHost();
  const result = JSON.parse(state.ctx.toolBatchExportTopItems('DXF2000'));
  assert.equal(result.count, 1); assert(state.files.has('/exports/export_001.dxf'));
  assert.deepEqual(state.saved, ['/exports/export_001_2.dxf']);
});
test('failed export closes its own temporary document and restores source', () => {
  const state = exportHost(true);
  const result = JSON.parse(state.ctx.toolBatchExportTopItems('AI3'));
  assert.equal(result.failed, 1); assert.equal(result.count, 0);
  assert.equal(state.tempDocs[0].closeCount, 1);
  assert.strictEqual(state.ctx.app.activeDocument, state.srcDoc);
  assert.strictEqual(state.srcDoc.selection, state.selection);
});
test('random fill rejects an open container before producing artwork', () => {
  const ctx = host(), container = contour([[0, 0], [10, 10]], false);
  container.top = 10;
  ctx.app.selection = [{ top: 20 }, container];
  assert.match(JSON.parse(ctx.toolRandomFill('{"fillCount":1}')).error, /闭合/);
});
test('random fill cannot squeeze square corners outside a small container', () => {
  const ctx = host(), container = square(0, 11);
  container.top = 11;
  ctx.app.selection = [{ top: 20, visibleBounds: [0, 10, 10, 0] }, container];
  ctx.app.activeDocument.groupItems = { add() { throw new Error('Must not create group for impossible layout'); } };
  assert.match(JSON.parse(ctx.toolRandomFill('{"fillCount":1}')).error, /填充数量过多/);
});
test('random fill includes every seed and places visible bounds fully inside', () => {
  const ctx = host({ ElementPlacement: { PLACEATEND: 1, PLACEBEFORE: 2 } });
  const container = square(0, 100), copies = [];
  container.top = 100;
  function seed(id, top) { return { top, visibleBounds: [0, 4, 4, 0], duplicate() {
    const copy = { id, visibleBounds: [0, 4, 4, 0], translate(x, y) { this.visibleBounds = [x, y + 4, x + 4, y]; } };
    copies.push(copy); return copy;
  } }; }
  ctx.app.selection = [seed('A', 200), seed('B', 150), container];
  ctx.app.activeDocument.groupItems = { add() { return { move() {}, remove() {} }; } };
  const result = JSON.parse(ctx.toolRandomFill('{"fillCount":2}'));
  assert.equal(result.count, 2);
  assert.deepEqual(copies.map(c => c.id), ['A', 'B']);
  copies.forEach(c => {
    assert(c.visibleBounds[0] > 0 && c.visibleBounds[2] < 100);
    assert(c.visibleBounds[3] > 0 && c.visibleBounds[1] < 100);
  });
});
function divideHost(failCreation) {
  const ctx = host({ RGBColor: function () {} });
  const oldLayer = { typename: 'Layer', name: '曲线等分 Divide', removed: false, remove() { this.removed = true; } };
  const line = contour([[0, 0], [100, 0]], false); line.parent = oldLayer;
  const layers = [oldLayer];
  layers.add = () => {
    const layer = { typename: 'Layer', removed: false, remove() { this.removed = true; }, pathItems: { ellipse() {
      if (failCreation) throw new Error('Host could not create marker'); return {};
    } } };
    layers.push(layer); return layer;
  };
  ctx.app.activeDocument = { layers }; ctx.app.selection = [line];
  return { ctx, layers, oldLayer };
}
test('divide cleanup preserves old output layer when it contains the selected source', () => {
  const state = divideHost(false);
  const result = JSON.parse(state.ctx.toolDivideCurve('{"parts":2,"markerMm":1,"deleteOld":true}'));
  assert.equal(result.count, 1); assert.equal(state.oldLayer.removed, false);
  assert.equal(state.layers[1].removed, false);
});
test('failed division retains old output and removes only the partial new layer', () => {
  const state = divideHost(true);
  assert(JSON.parse(state.ctx.toolDivideCurve('{"parts":2,"markerMm":1,"deleteOld":true}')).error);
  assert.equal(state.oldLayer.removed, false); assert.equal(state.layers[1].removed, true);
});
test('failed path distribution retains old results and removes partial new copies', () => {
  const ctx = host({ ElementPlacement: { PLACEATEND: 1 } });
  const line = contour([[0, 0], [50, 0], [100, 0]], false); line.visibleBounds = line.geometricBounds;
  const shape = { visibleBounds: [0, 100, 10, 90], duplicate() { throw new Error('duplicate failed'); } };
  const oldGroup = { name: '__DistributeAlongPath_Result__', removed: false, remove() { this.removed = true; } };
  const groups = [oldGroup]; groups.add = () => {
    const group = { removed: false, remove() { this.removed = true; } }; groups.push(group); return group;
  };
  ctx.app.activeDocument = { selection: [shape, line], groupItems: groups };
  const result = JSON.parse(ctx.toolDistributeAlongPath('{"count":3,"angleOffset":0,"endScale":100,"deleteOldCopies":true,"openPolylineIncludeEnds":true}'));
  assert(result.error); assert.equal(oldGroup.removed, false); assert.equal(groups[1].removed, true);
});
console.log('\n' + passed + ' audit regressions passed.');
