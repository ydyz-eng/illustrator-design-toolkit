const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function bridge(cep) {
  const sandbox = {window:{__adobe_cep__:cep},console:{warn(){},log(){}},buildDimensionPanel(){}};
  vm.createContext(sandbox);
  for (const file of ['js/CSInterface.js','js/main.js']) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),sandbox);
  return sandbox;
}
test('JSX quoting safely round-trips quotes, backslashes, newlines and Unicode line separators', () => {
  const s = bridge();
  for (const value of ["C:\\图稿\\O'Reilly",'a\r\nb\tend','a\u2028b\u2029c',"'); throw new Error('injected'); //"]) {
    assert.equal(vm.runInContext(s.jsxQuote(value),s),value);
    assert.ok(!s.jsxQuote(value).includes('\u2028'));
  }
});
test('CEP JSON parsing reports host errors and recovers wrapped JSON', () => {
  const s=bridge();
  assert.equal(s.parseEvalJson('prefix {"count":2} suffix').count,2);
  assert.throws(()=>s.parseEvalJson('EvalScript error.'));
  assert.throws(()=>s.parseEvalJson(''));
});
test('reloading uses the defined extension system path and checks actual JSX load success', () => {
  let call='', reply='ok';
  const s=bridge({getHostEnvironment(){return '{}';},getSystemPath(key){assert.equal(key,'extension');return "C:/O'Reilly/工具箱";},evalScript(script,done){call=script;done(reply);}});
  let error;
  s.reloadJSX(e=>error=e); assert.equal(error,null); assert.match(call,/\$\.evalFile/); assert.match(call,/tools\.jsx/); assert.match(call,/dimension-pick\.jsx/);
  reply='EvalScript error.'; s.reloadJSX(e=>error=e); assert.match(error,/加载失败/);
});

function hostLoadingBridge() {
  const state = { failure: '', omitPick: false, calls: [], host: null };
  const host = vm.createContext({
    loadJsxSource(filename) {
      state.calls.push(filename);
      if (state.failure && filename.endsWith(state.failure)) throw new Error('Injected JSX load failure');
      if (state.omitPick && filename.endsWith('dimension-pick.jsx')) return '';
      const relative = filename.slice('C:/toolkit/'.length);
      return fs.readFileSync(path.join(root, relative), 'utf8');
    }
  });
  state.host = host;
  const s = bridge({
    getHostEnvironment() { return '{}'; },
    getSystemPath() { return 'C:/toolkit'; },
    evalScript(script, done) {
      // Model ExtendScript evalFile's caller scope with direct eval. A JS
      // function stub for evalFile would always create its own scope and hide
      // the very regression this test exercises.
      const executable = script.replace(/\$\.evalFile\(([^;]+?)\);/g, 'eval(loadJsxSource($1));');
      done(vm.runInContext(executable, host));
    }
  });
  return { bridge: s, state, host };
}

test('JSX loading exposes capture entry points to later host calls and preserves sessions across reload', () => {
  const { bridge: s, state, host } = hostLoadingBridge();
  let error;
  s.reloadJSX(value => { error = value; });
  assert.equal(error, null);
  assert.equal(host._aiToolsJsxLoadStatus, 'ok');
  assert.deepEqual(state.calls, ['C:/toolkit/jsx/tools.jsx', 'C:/toolkit/jsx/dimension-pick.jsx']);
  for (const name of ['toolDimension', 'toolDimensionPickBegin', 'toolDimensionPickStatus', 'toolDimensionPickPoll', 'toolDimensionPickFinish', 'toolDimensionPickCancel']) {
    assert.equal(vm.runInContext('typeof ' + name, host), 'function', name);
  }
  assert.equal(JSON.parse(vm.runInContext('toolDimensionPickStatus()', host)).active, false);
  const session = { token: 'existing-capture' }, completion = { token: 'previous-capture', result: 'previous-result' };
  host._dimensionPickSession = session;
  host._dimensionPickLastResult = completion;
  s.reloadJSX(value => { error = value; });
  assert.equal(error, null);
  assert.equal(host._dimensionPickSession, session);
  assert.equal(host._dimensionPickLastResult, completion);
});

test('a JSX load exception is returned through the global status and a successful retry clears it', () => {
  for (const filename of ['tools.jsx', 'dimension-pick.jsx']) {
    const { bridge: s, state, host } = hostLoadingBridge();
    state.failure = filename;
    let error;
    s.reloadJSX(value => { error = value; });
    assert.match(error, /Injected JSX load failure/);
    assert.match(host._aiToolsJsxLoadStatus, /Injected JSX load failure/);
    state.failure = '';
    s.reloadJSX(value => { error = value; });
    assert.equal(error, null);
    assert.equal(host._aiToolsJsxLoadStatus, 'ok');
    assert.equal(JSON.parse(vm.runInContext('toolDimensionPickStatus()', host)).active, false);
  }
});

test('a missing capture script cannot be reported as a successful JSX load', () => {
  const { bridge: s, state, host } = hostLoadingBridge();
  state.omitPick = true;
  let error;
  s.reloadJSX(value => { error = value; });
  assert.match(error, /尺寸标注脚本未完整加载/);
  assert.match(host._aiToolsJsxLoadStatus, /尺寸标注脚本未完整加载/);
});
test('preview and malformed host-environment data do not crash the panel bridge', () => {
  const preview=bridge(); let result;
  preview.csInterface.evalScript('toolDimension()',r=>result=JSON.parse(r)); assert.match(result.error,/Illustrator/);
  const s=bridge({getHostEnvironment(){return '{broken';}}); assert.equal(s.csInterface.hostEnvironment,null);
});
