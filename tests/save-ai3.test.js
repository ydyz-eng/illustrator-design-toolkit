const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../jsx/tools.jsx'), 'utf8');

function makeHost({ sourceFile, targetExists = false, confirmResult = true, failure = null } = {}) {
  let saved, confirmed = 0;
  const doc = {
    get fullName() { if (!sourceFile) throw Error('unsaved'); return sourceFile; },
    saveAs(file, options) { if (failure) throw Error(failure); saved = { file, options }; }
  };
  const ctx = vm.createContext({
    app: { documents: [doc], activeDocument: doc },
    File: function (name) { this.fsName = name; this.exists = targetExists; },
    IllustratorSaveOptions: function () {},
    Compatibility: { ILLUSTRATOR3: 'AI3' },
    OutputFlattening: { PRESERVEAPPEARANCE: 'appearance' },
    confirm() { confirmed++; return confirmResult; }
  });
  vm.runInContext(source, ctx);
  return { ctx, run: () => JSON.parse(ctx.toolSaveAsAI3()), saved: () => saved, confirmations: () => confirmed };
}

test('AI3 save retains native filename characters and original save options', () => {
  const file = { fsName: 'C:\\设计\\图#100% 完成.ai', name: '%E5%9B%BE%23100%25%20%E5%AE%8C%E6%88%90.ai', parent: { fsName: 'C:\\设计' }, exists: true };
  const host = makeHost({ sourceFile: file });
  assert.equal(host.run().path, 'C:\\设计/图#100% 完成_AI3.ai');
  assert.equal(host.saved().file.fsName, 'C:\\设计/图#100% 完成_AI3.ai');
  assert.equal(host.saved().options.compatibility, 'AI3');
  assert.equal(host.saved().options.flattenOutput, 'appearance');
  assert.equal(host.saved().options.saveMultipleArtboards, false);
  assert.equal(host.confirmations(), 0);
});

test('existing targets require confirmation and cancellation performs no save', () => {
  const file = { fsName: 'C:\\x\\file.ai', parent: { fsName: 'C:\\x' }, exists: true };
  const host = makeHost({ sourceFile: file, targetExists: true, confirmResult: false });
  assert.equal(host.run().cancelled, true);
  assert.equal(host.confirmations(), 1);
  assert.equal(host.saved(), undefined);
  const accepted = makeHost({ sourceFile: file, targetExists: true });
  assert.equal(accepted.run().path, 'C:\\x/file_AI3.ai');
  assert.equal(accepted.confirmations(), 1);
});

test('missing documents, unsaved files and host save failures return errors', () => {
  const host = makeHost();
  host.ctx.app.documents = [];
  assert.match(host.run().error, /打开/);
  host.ctx.app.documents = [{}];
  assert.match(host.run().error, /保存/);
  const file = { fsName: 'C:\\x\\file.ai', parent: { fsName: 'C:\\x' }, exists: true };
  assert.match(makeHost({ sourceFile: file, failure: '写入失败' }).run().error, /写入失败/);
});
