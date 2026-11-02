/**
 * AI 设计工具箱 — 前端主控
 *
 * 架构：
 *  TOOLS 数组 → 每项是一个工具描述对象
 *    { id, name, buildPanel(container), init? }
 *  框架自动生成 Tab + 内容区，工具只管自己的 HTML 和逻辑
 *
 * 新增工具：在 TOOLS 数组末尾追加一个对象即可，无需改其他代码
 */

var csInterface = new CSInterface();


// CEP 返回值清洗：有时 evalScript 会返回多余字符，先提取 JSON 再解析
function parseEvalJson(result) {
  if (!result) throw new Error("empty result");
  result = String(result);
  var start = result.indexOf("{");
  var end = result.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(result);
  return JSON.parse(result.substring(start, end + 1));
}

function jsxQuote(str) {
  str = String(str);
  str = str.replace(/\\/g, "\\\\");
  str = str.replace(/'/g, "\\'");
  str = str.replace(/\r/g, "\\r");
  str = str.replace(/\n/g, "\\n");
  str = str.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return "'" + str + "'";
}




// ══════════════════════════════════════════════════════
//  开发辅助：重新加载 JSX + 刷新面板
// ══════════════════════════════════════════════════════
function reloadJSX(callback) {
  try {
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var jsxFile = extRoot + "/jsx/tools.jsx";
    // Keep evalFile at the host's top level: wrapping it in a function can put
    // imported declarations in that function's scope, losing them after return.
    // The last expression supplies CEP's result while capture state stays global.
    var script = 'var _aiToolsJsxLoadStatus="ok";try{$.evalFile(' + jsxQuote(jsxFile) + ');$.evalFile(' + jsxQuote(extRoot + "/jsx/dimension-pick.jsx") + ');' +
      'if(typeof toolDimension!=="function"||typeof toolDimensionPickBegin!=="function"||typeof toolDimensionPickStatus!=="function"||typeof toolDimensionPickPoll!=="function"||typeof toolDimensionPickFinish!=="function"||typeof toolDimensionPickCancel!=="function")throw new Error("尺寸标注脚本未完整加载");' +
      '}catch(_aiToolsLoadError){_aiToolsJsxLoadStatus=String(_aiToolsLoadError);}_aiToolsJsxLoadStatus;';
    csInterface.evalScript(script, function (result) {
      if (callback) callback(result === "ok" ? null : "工具脚本加载失败：" + result);
    });
  } catch (e) {
    console.log("JSX 重载失败:", e);
    if (callback) callback("工具脚本加载失败：" + e.message);
  }
}

function reloadPanel() {
  setStatus("busy", "正在重载插件…");
  if (!window.__adobe_cep__) { window.location.reload(); return; }
  reloadJSX(function (error) {
    if (error) { setStatus("err", error); return; }
    setTimeout(function () {
      var base = window.location.href.split("?")[0];
      window.location.replace(base + "?reload=" + new Date().getTime());
    }, 120);
  });
}


// ══════════════════════════════════════════════════════
//  工具定义区 — 每个工具是一个对象
// ══════════════════════════════════════════════════════

var TOOLS = [

  // ── 工具 1：线长 & 孔洞统计 ─────────────────────────
  {
    id: "lineLength",
    name: "计算线长及孔洞",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">参数设置</div>
          <div class="section-body">
            <div class="form-row">
              <label>长度单位</label>
              <select id="ll-unit">
                <option value="mm">毫米 mm</option>
                <option value="in">英寸 in</option>
                <option value="pt">磅 pt</option>
              </select>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">价格计算</div>
          <div class="section-body">
            <div class="form-row">
              <label>每个孔洞价格</label>
              <input type="number" id="ll-holePrice" value="0" min="0" step="0.01"/>
            </div>
            <div class="form-row">
              <label>每米价格</label>
              <input type="number" id="ll-meterPrice" value="0" min="0" step="0.01"/>
            </div>
          </div>
        </div>

        <p class="hint">选中路径后计算线长与费用。孔洞按闭合轮廓的奇偶嵌套估算；开放路径仅累计线长。相交、自交或叠加填色图稿需人工复核孔洞。</p>

        <button class="btn" id="ll-run">▶  计 算</button>

        <div class="result-card" id="ll-result">
          <div class="result-row">
            <span class="rk">路径总数</span>
            <span class="rv" id="ll-pathCount">—</span>
          </div>
          <div class="result-row">
            <span class="rk">复合路径</span>
            <span class="rv" id="ll-compoundCount">—</span>
          </div>
          <div class="result-row"><span class="rk">开放 / 闭合路径</span><span class="rv" id="ll-openClosed">—</span></div>
          <div class="result-row"><span class="rk">嵌套实心区域</span><span class="rv" id="ll-islands">—</span></div>
          <div class="result-row">
            <span class="rk">最外围轮廓</span>
            <span class="rv" id="ll-outerCount">—</span>
          </div>
          <div class="result-row">
            <span class="rk">孔洞估算</span>
            <span class="rv accent" id="ll-innerCount">—</span>
          </div>
          <div class="result-row">
            <span class="rk">总线长</span>
            <span class="rv accent" id="ll-length">—</span>
          </div>
          <div class="result-row">
            <span class="rk">总价</span>
            <span class="rv" id="ll-totalPrice" style="color: var(--error); font-size: 13px;">—</span>
          </div>
        </div>
      `;

      var lastMeasure = null;
      function updatePrice() {
        if (!lastMeasure) return;
        var holePrice = Number(document.getElementById("ll-holePrice").value);
        var meterPrice = Number(document.getElementById("ll-meterPrice").value);
        var valid = isFinite(holePrice) && isFinite(meterPrice) && holePrice >= 0 && meterPrice >= 0;
        document.getElementById("ll-totalPrice").textContent = valid ? (lastMeasure.innerCount * holePrice + lastMeasure.lengthMm / 1000 * meterPrice).toFixed(2) : "单价无效";
      }
      document.getElementById("ll-holePrice").addEventListener("input", updatePrice);
      document.getElementById("ll-meterPrice").addEventListener("input", updatePrice);
      document.getElementById("ll-run").addEventListener("click", function () {
        var unit = document.getElementById("ll-unit").value;
        setStatus("busy", "计算中…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolLineLength("' + unit + '")',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") {
              setStatus("err", "执行出错，请检查选中内容");
              return;
            }
            try {
              var data = parseEvalJson(result);
              if (data.error) {
                setStatus("err", data.error);
                return;
              }
              document.getElementById("ll-pathCount").textContent    = data.pathCount + " 个";
              document.getElementById("ll-compoundCount").textContent = data.compoundCount + " 个";
              document.getElementById("ll-openClosed").textContent = data.openCount + " / " + data.closedCount + " 个";
              document.getElementById("ll-islands").textContent = data.islandCount + " 个";
              document.getElementById("ll-outerCount").textContent   = data.outerCount + " 个";
              document.getElementById("ll-innerCount").textContent   = data.innerCount + " 个";
              document.getElementById("ll-length").textContent       = data.length;
              lastMeasure = data;
              updatePrice();
              document.getElementById("ll-result").classList.add("visible");
              setStatus("ok", "计算完成" + (data.skippedCount ? " · 已跳过 " + data.skippedCount + " 个辅助或不可用对象" : ""));
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  },

  // ── 工具 2：尺寸标注 ────────────────────────────────
  {
    id: "dimension",
    name: "尺寸标注",

    buildPanel: buildDimensionPanel
  }

  ,// ── 工具 3：加折边（拼接边） ─────────────────────────────
  {
    id: "flange",
    name: "加折边（拼接边）",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">折边参数</div>
          <div class="section-body">
            <div class="form-row">
              <label>折边宽度 mm</label>
              <input type="number" id="fl-width" value="5" min="0.1" step="0.5"/>
            </div>
            <div class="form-row">
              <label>切角角度 °</label>
              <input type="number" id="fl-angle" value="45" min="1" max="88" step="1"/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">折边方位</div>
          <div class="section-body">
            <div class="check-row">
              <label class="check-item"><input type="checkbox" id="fl-top"/> 上</label>
              <label class="check-item"><input type="checkbox" id="fl-bottom"/> 下</label>
            </div>
            <div class="check-row">
              <label class="check-item"><input type="checkbox" id="fl-left"/> 左</label>
              <label class="check-item"><input type="checkbox" id="fl-right" checked/> 右</label>
            </div>
            <label class="check-item"><input type="checkbox" id="fl-all"/> 全选</label>
          </div>
        </div>

        <div class="section">
          <div class="section-header">生成选项</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="fl-chop" checked/> 启用切角</label>
            <label class="check-item"><input type="checkbox" id="fl-outer" checked/> 仅处理整体外轮廓</label>
          </div>
        </div>

        <p class="hint">选中闭合路径、非封闭线条、群组或复合路径后执行。闭合图形会按所选方位识别直线边；开放线条会按勾选方位作为偏移方向生成折边。折边继承对应来源路径的填充与描边样式。</p>

        <button class="btn" id="fl-run">▶  生成折边</button>

        <div class="result-card" id="fl-result">
          <div class="result-row"><span class="rk">识别路径</span><span class="rv" id="fl-paths">—</span></div>
          <div class="result-row"><span class="rk">生成折边</span><span class="rv accent" id="fl-count">—</span></div>
        </div>
      `;

      var all = document.getElementById("fl-all");
      var ids = ["fl-top", "fl-bottom", "fl-left", "fl-right"];
      all.addEventListener("change", function () {
        for (var i = 0; i < ids.length; i++) document.getElementById(ids[i]).checked = all.checked;
      });

      document.getElementById("fl-run").addEventListener("click", function () {
        var params = {
          widthMm: parseFloat(document.getElementById("fl-width").value) || 5,
          angleDeg: parseFloat(document.getElementById("fl-angle").value) || 45,
          top: document.getElementById("fl-top").checked,
          bottom: document.getElementById("fl-bottom").checked,
          left: document.getElementById("fl-left").checked,
          right: document.getElementById("fl-right").checked,
          chop: document.getElementById("fl-chop").checked,
          outerOnly: document.getElementById("fl-outer").checked
        };

        if (!params.top && !params.bottom && !params.left && !params.right) {
          setStatus("err", "请至少选择一个折边方位");
          return;
        }

        setStatus("busy", "生成折边中…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolFlange(' + jsxQuote(JSON.stringify(params)) + ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") {
              setStatus("err", "执行出错"); return;
            }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("fl-paths").textContent = data.pathCount + " 个";
              document.getElementById("fl-count").textContent = data.count + " 个";
              document.getElementById("fl-result").classList.add("visible");
              setStatus("ok", "已生成 " + data.count + " 个折边");
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }

  ,// ── 工具 4：圆台展开扇形 ───────────────────────────
  {
    id: "coneFrustum",
    name: "圆台展开扇形",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">直径尺寸 mm</div>
          <div class="section-body">
            <div class="form-row">
              <label>底部直径 a</label>
              <input type="number" id="cf-a" value="100" min="0" step="1"/>
            </div>
            <div class="form-row">
              <label>顶部直径 b</label>
              <input type="number" id="cf-b" value="50" min="0" step="1"/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">高度模式</div>
          <div class="section-body">
            <label class="check-item"><input type="radio" name="cf-mode" id="cf-mode-c" value="vertical" checked/> 使用垂直高度 c</label>
            <div class="form-row">
              <label>垂直高度 c</label>
              <input type="number" id="cf-c" value="80" min="0.1" step="1"/>
            </div>
            <label class="check-item"><input type="radio" name="cf-mode" id="cf-mode-d" value="slant"/> 使用斜边高度 d</label>
            <div class="form-row">
              <label>斜边高度 d</label>
              <input type="number" id="cf-d" value="80" min="0.1" step="1" disabled/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">位置示意</div>
          <div class="section-body">
            <div class="cf-diagram">
              <svg viewBox="0 0 150 158" role="img" aria-label="圆台尺寸示意">
                <defs>
                  <linearGradient id="cfShade" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="#4a9eff" stop-opacity="0.55"/>
                    <stop offset="1" stop-color="#252525" stop-opacity="0.2"/>
                  </linearGradient>
                </defs>
                <g class="cf-solid">
                  <path d="M28 42 C28 26 92 26 92 42 L112 112 C112 128 8 128 8 112 Z"/>
                  <ellipse cx="60" cy="42" rx="32" ry="10"/>
                  <ellipse cx="60" cy="112" rx="52" ry="15"/>
                  <line x1="28" y1="42" x2="92" y2="42"/>
                  <line x1="8" y1="112" x2="112" y2="112"/>
                  <line x1="118" y1="42" x2="118" y2="112"/>
                  <line x1="112" y1="42" x2="124" y2="42"/>
                  <line x1="112" y1="112" x2="124" y2="112"/>
                  <line x1="24" y1="45" x2="5" y2="112"/>
                  <line x1="17" y1="42" x2="31" y2="46"/>
                  <line x1="-2" y1="108" x2="12" y2="116"/>
                  <text x="55" y="26">B</text>
                  <text x="55" y="145">A</text>
                  <text x="124" y="82">C</text>
                  <text x="11" y="79">D</text>
                </g>
              </svg>
            </div>
          </div>
        </div>

        <p class="hint">生成圆台展开扇形，完成后会自动居中到当前画板中央。</p>

        <button class="btn" id="cf-run">▶  生成扇形</button>

        <div class="result-card" id="cf-result">
          <div class="result-row"><span class="rk">外半径 R</span><span class="rv" id="cf-R">—</span></div>
          <div class="result-row"><span class="rk">内半径 r</span><span class="rv" id="cf-r">—</span></div>
          <div class="result-row"><span class="rk">展开角度</span><span class="rv accent" id="cf-theta">—</span></div>
        </div>
      `;

      function syncMode() {
        var useC = document.getElementById("cf-mode-c").checked;
        document.getElementById("cf-c").disabled = !useC;
        document.getElementById("cf-d").disabled = useC;
      }
      document.getElementById("cf-mode-c").addEventListener("change", syncMode);
      document.getElementById("cf-mode-d").addEventListener("change", syncMode);

      document.getElementById("cf-run").addEventListener("click", function () {
        var params = {
          a: parseFloat(document.getElementById("cf-a").value) || 0,
          b: parseFloat(document.getElementById("cf-b").value) || 0,
          mode: document.getElementById("cf-mode-c").checked ? "vertical" : "slant",
          c: parseFloat(document.getElementById("cf-c").value) || 0,
          d: parseFloat(document.getElementById("cf-d").value) || 0
        };

        setStatus("busy", "生成扇形中…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolConeFrustum(' + jsxQuote(JSON.stringify(params)) + ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") {
              setStatus("err", "执行出错"); return;
            }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("cf-R").textContent = data.R;
              document.getElementById("cf-r").textContent = data.r;
              document.getElementById("cf-theta").textContent = data.theta;
              document.getElementById("cf-result").classList.add("visible");
              setStatus("ok", "扇形已生成并居中");
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }


  ,// ── 工具 5：随机缩放并填充 ─────────────────────────
  {
    id: "randomFill",
    name: "随机填充",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">使用提示</div>
          <div class="section-body">
            <p class="hint" style="margin:0">请先选中至少 2 个对象：上方图形为填充物，最下方为闭合路径或复合路径容器。多个填充图形依次使用；自动沿曲线边界检查可用空间。</p>
          </div>
        </div>


        <div class="section">
          <div class="section-header">填充数量</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="rf-useFillCount" checked/> 指定填充数量</label>
            <div class="form-row">
              <label>填充数量</label>
              <input type="number" id="rf-fillCount" value="50" min="1" step="1"/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">随机大小</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="rf-useScale"/> 启用随机缩放</label>
            <div class="form-row">
              <label>最小缩放</label>
              <input type="number" id="rf-minScale" value="0.5" min="0.01" step="0.1" disabled/>
            </div>
            <div class="form-row">
              <label>最大缩放</label>
              <input type="number" id="rf-maxScale" value="1.5" min="0.01" step="0.1" disabled/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">旋转设置</div>
          <div class="section-body">
            <label class="check-item"><input type="radio" name="rf-rot" id="rf-rotRandom" checked/> 随机 360°</label>
            <label class="check-item"><input type="radio" name="rf-rot" id="rf-rotFixed"/> 固定角度</label>
            <div class="form-row">
              <label>固定角度 °</label>
              <input type="number" id="rf-angle" value="0" step="1" disabled/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">生成选项</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="rf-delContainer"/> 完成后删除容器</label>
          </div>
        </div>

        <button class="btn" id="rf-run">▶  开始精准填充</button>

        <div class="result-card" id="rf-result">
          <div class="result-row"><span class="rk">生成数量</span><span class="rv accent" id="rf-count">—</span></div>
        </div>
      `;

      var useScale = document.getElementById("rf-useScale");
      var minScale = document.getElementById("rf-minScale");
      var maxScale = document.getElementById("rf-maxScale");
      var useFillCount = document.getElementById("rf-useFillCount");
      var fillCountInput = document.getElementById("rf-fillCount");
      useFillCount.addEventListener("change", function () {
        fillCountInput.disabled = !useFillCount.checked;
      });
      useScale.addEventListener("change", function () {
        minScale.disabled = !useScale.checked;
        maxScale.disabled = !useScale.checked;
      });

      function syncRot() {
        document.getElementById("rf-angle").disabled = !document.getElementById("rf-rotFixed").checked;
      }
      document.getElementById("rf-rotRandom").addEventListener("change", syncRot);
      document.getElementById("rf-rotFixed").addEventListener("change", syncRot);

      document.getElementById("rf-run").addEventListener("click", function () {
        var params = {
          useFillCount: document.getElementById("rf-useFillCount").checked,
          fillCount: parseInt(document.getElementById("rf-fillCount").value, 10) || 50,
          useScale: document.getElementById("rf-useScale").checked,
          minScale: parseFloat(document.getElementById("rf-minScale").value) || 0.5,
          maxScale: parseFloat(document.getElementById("rf-maxScale").value) || 1.5,
          randomRotate: document.getElementById("rf-rotRandom").checked,
          angle: parseFloat(document.getElementById("rf-angle").value) || 0,
          deleteContainer: document.getElementById("rf-delContainer").checked
        };

        setStatus("busy", "精准填充中…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolRandomFill(' + jsxQuote(JSON.stringify(params)) + ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") { setStatus("err", "执行出错"); return; }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("rf-count").textContent = data.count + " 个";
              document.getElementById("rf-result").classList.add("visible");
              setStatus("ok", "已生成 " + data.count + " 个填充物");
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }


  // ── 工具 6：高精度螺旋线 ─────────────────────────────
  ,{
    id: "spiral",
    name: "高精度螺旋线",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">生成位置</div>
          <div class="section-body">
            <label class="check-item"><input type="radio" name="sp-mode" id="sp-mode-artboard" checked/> 画板中心</label>
            <label class="check-item"><input type="radio" name="sp-mode" id="sp-mode-ellipse"/> 按选中椭圆</label>
          </div>
        </div>

        <div class="section">
          <div class="section-header">通用参数</div>
          <div class="section-body">
            <div class="form-row">
              <label>线粗 mm</label>
              <input type="number" id="sp-weight" value="0.5" min="0.01" step="0.1"/>
            </div>
          </div>
        </div>

        <div id="sp-artboard-panel">
          <div class="section">
            <div class="section-header">画板中心算法</div>
            <div class="section-body">
              <label class="check-item"><input type="radio" name="sp-art-mode" id="sp-art-spacing" checked/> 已知圈数 + 间距</label>
              <label class="check-item"><input type="radio" name="sp-art-mode" id="sp-art-diameter"/> 已知最大直径</label>
            </div>
          </div>
          <div class="section" id="sp-art-spacing-panel">
            <div class="section-header">参数</div>
            <div class="section-body">
              <div class="form-row"><label>圈数</label><input type="number" id="sp-art-rounds" value="10" min="0.01" step="0.1"/></div>
              <div class="form-row"><label>间距 mm</label><input type="number" id="sp-art-spacing-mm" value="5" min="0.01" step="0.1"/></div>
            </div>
          </div>
          <div class="section" id="sp-art-diameter-panel">
            <div class="section-header">最大直径参数</div>
            <div class="section-body">
              <div class="form-row"><label>最大直径</label><input type="number" id="sp-art-diameter-mm" value="100" min="0.01" step="1"/></div>
              <label class="check-item"><input type="radio" name="sp-art-solve" id="sp-art-solve-rounds" checked/> 输入圈数，自动算间距</label>
              <div class="form-row"><label>圈数</label><input type="number" id="sp-art-diameter-rounds" value="10" min="0.01" step="0.1"/></div>
              <label class="check-item"><input type="radio" name="sp-art-solve" id="sp-art-solve-spacing"/> 输入间距，自动算圈数</label>
              <div class="form-row"><label>间距 mm</label><input type="number" id="sp-art-diameter-spacing" value="5" min="0.01" step="0.1"/></div>
            </div>
          </div>
        </div>

        <div id="sp-ellipse-panel">
          <div class="section">
            <div class="section-header">椭圆位置</div>
            <div class="section-body">
              <label class="check-item"><input type="radio" name="sp-ellipse-place" id="sp-ellipse-inside" checked/> 画在里面</label>
              <label class="check-item"><input type="radio" name="sp-ellipse-place" id="sp-ellipse-outside"/> 画在外面</label>
            </div>
          </div>
          <div class="section" id="sp-ellipse-inside-panel">
            <div class="section-header">内部参数</div>
            <div class="section-body">
              <label class="check-item"><input type="radio" name="sp-ellipse-inside-solve" id="sp-ellipse-inside-spacing" checked/> 输入间距，自动算圈数</label>
              <div class="form-row"><label>间距 mm</label><input type="number" id="sp-ellipse-inside-spacing-mm" value="5" min="0.01" step="0.1"/></div>
              <label class="check-item"><input type="radio" name="sp-ellipse-inside-solve" id="sp-ellipse-inside-rounds"/> 输入圈数，自动算间距</label>
              <div class="form-row"><label>圈数</label><input type="number" id="sp-ellipse-inside-rounds-val" value="10" min="0.01" step="0.1"/></div>
            </div>
          </div>
          <div id="sp-ellipse-outside-panel">
            <div class="section">
              <div class="section-header">外扩方式</div>
              <div class="section-body">
                <label class="check-item"><input type="radio" name="sp-ellipse-outside-mode" id="sp-ellipse-outside-classic" checked/> 普通外扩</label>
                <label class="check-item"><input type="radio" name="sp-ellipse-outside-mode" id="sp-ellipse-outside-target"/> 按目标外径</label>
              </div>
            </div>
            <div class="section" id="sp-ellipse-outside-classic-panel">
              <div class="section-header">普通外扩参数</div>
              <div class="section-body">
                <div class="form-row"><label>间距 mm</label><input type="number" id="sp-ellipse-outside-spacing-mm" value="5" min="0.01" step="0.1"/></div>
                <div class="form-row"><label>外扩圈数</label><input type="number" id="sp-ellipse-extra-rounds" value="3" min="0.01" step="0.1"/></div>
              </div>
            </div>
            <div class="section" id="sp-ellipse-outside-target-panel">
              <div class="section-header">目标外径参数</div>
              <div class="section-body">
                <div class="form-row"><label>目标外径</label><input type="number" id="sp-ellipse-target-diameter" value="160" min="0.01" step="1"/></div>
                <label class="check-item"><input type="radio" name="sp-ellipse-target-solve" id="sp-ellipse-target-spacing" checked/> 输入间距，自动算圈数</label>
                <div class="form-row"><label>间距 mm</label><input type="number" id="sp-ellipse-target-spacing-mm" value="5" min="0.01" step="0.1"/></div>
                <label class="check-item"><input type="radio" name="sp-ellipse-target-solve" id="sp-ellipse-target-rounds"/> 输入圈数，自动算间距</label>
                <div class="form-row"><label>外扩圈数</label><input type="number" id="sp-ellipse-target-rounds-val" value="3" min="0.01" step="0.1"/></div>
              </div>
            </div>
          </div>
        </div>

        <p class="hint">画板中心模式会在当前画板中心生成；椭圆模式需先选中 1 个 Illustrator 标准椭圆。</p>
        <button class="btn" id="sp-run">▶  生成螺旋线</button>
        <div class="result-card" id="sp-result">
          <div class="result-row"><span class="rk">模式</span><span class="rv" id="sp-res-mode">—</span></div>
          <div class="result-row"><span class="rk">圈数</span><span class="rv" id="sp-res-rounds">—</span></div>
          <div class="result-row"><span class="rk">间距</span><span class="rv" id="sp-res-spacing">—</span></div>
          <div class="result-row"><span class="rk">外径</span><span class="rv accent" id="sp-res-diameter">—</span></div>
        </div>
      `;

      function show(el, yes) { el.style.display = yes ? "" : "none"; }
      function syncSpiralUI() {
        var isArt = document.getElementById("sp-mode-artboard").checked;
        var artBySpacing = document.getElementById("sp-art-spacing").checked;
        var ellipseInside = document.getElementById("sp-ellipse-inside").checked;
        var outsideClassic = document.getElementById("sp-ellipse-outside-classic").checked;
        show(document.getElementById("sp-artboard-panel"), isArt);
        show(document.getElementById("sp-ellipse-panel"), !isArt);
        show(document.getElementById("sp-art-spacing-panel"), artBySpacing);
        show(document.getElementById("sp-art-diameter-panel"), !artBySpacing);
        show(document.getElementById("sp-ellipse-inside-panel"), ellipseInside);
        show(document.getElementById("sp-ellipse-outside-panel"), !ellipseInside);
        show(document.getElementById("sp-ellipse-outside-classic-panel"), outsideClassic);
        show(document.getElementById("sp-ellipse-outside-target-panel"), !outsideClassic);
        document.getElementById("sp-art-diameter-rounds").disabled = !document.getElementById("sp-art-solve-rounds").checked;
        document.getElementById("sp-art-diameter-spacing").disabled = !document.getElementById("sp-art-solve-spacing").checked;
        document.getElementById("sp-ellipse-inside-spacing-mm").disabled = !document.getElementById("sp-ellipse-inside-spacing").checked;
        document.getElementById("sp-ellipse-inside-rounds-val").disabled = !document.getElementById("sp-ellipse-inside-rounds").checked;
        document.getElementById("sp-ellipse-target-spacing-mm").disabled = !document.getElementById("sp-ellipse-target-spacing").checked;
        document.getElementById("sp-ellipse-target-rounds-val").disabled = !document.getElementById("sp-ellipse-target-rounds").checked;
      }

      [
        "sp-mode-artboard", "sp-mode-ellipse", "sp-art-spacing", "sp-art-diameter",
        "sp-art-solve-rounds", "sp-art-solve-spacing", "sp-ellipse-inside",
        "sp-ellipse-outside", "sp-ellipse-inside-spacing", "sp-ellipse-inside-rounds",
        "sp-ellipse-outside-classic", "sp-ellipse-outside-target",
        "sp-ellipse-target-spacing", "sp-ellipse-target-rounds"
      ].forEach(function (id) {
        document.getElementById(id).addEventListener("change", syncSpiralUI);
      });
      syncSpiralUI();

      document.getElementById("sp-run").addEventListener("click", function () {
        var params = {
          mode: document.getElementById("sp-mode-artboard").checked ? "artboard" : "ellipse",
          weightMm: parseFloat(document.getElementById("sp-weight").value) || 0.5
        };

        if (params.mode === "artboard") {
          params.artMode = document.getElementById("sp-art-spacing").checked ? "spacing" : "diameter";
          if (params.artMode === "spacing") {
            params.rounds = parseFloat(document.getElementById("sp-art-rounds").value) || 0;
            params.spacingMm = parseFloat(document.getElementById("sp-art-spacing-mm").value) || 0;
          } else {
            params.diameterMm = parseFloat(document.getElementById("sp-art-diameter-mm").value) || 0;
            params.solve = document.getElementById("sp-art-solve-rounds").checked ? "rounds" : "spacing";
            params.rounds = parseFloat(document.getElementById("sp-art-diameter-rounds").value) || 0;
            params.spacingMm = parseFloat(document.getElementById("sp-art-diameter-spacing").value) || 0;
          }
        } else {
          params.ellipsePlacement = document.getElementById("sp-ellipse-inside").checked ? "inside" : "outside";
          if (params.ellipsePlacement === "inside") {
            params.ellipseInsideSolve = document.getElementById("sp-ellipse-inside-spacing").checked ? "spacing" : "rounds";
            params.spacingMm = parseFloat(document.getElementById("sp-ellipse-inside-spacing-mm").value) || 0;
            params.rounds = parseFloat(document.getElementById("sp-ellipse-inside-rounds-val").value) || 0;
          } else {
            params.ellipseOutsideMode = document.getElementById("sp-ellipse-outside-classic").checked ? "classic" : "target";
            if (params.ellipseOutsideMode === "classic") {
              params.spacingMm = parseFloat(document.getElementById("sp-ellipse-outside-spacing-mm").value) || 0;
              params.extraRounds = parseFloat(document.getElementById("sp-ellipse-extra-rounds").value) || 0;
            } else {
              params.targetDiameterMm = parseFloat(document.getElementById("sp-ellipse-target-diameter").value) || 0;
              params.ellipseOutsideTargetSolve = document.getElementById("sp-ellipse-target-spacing").checked ? "spacing" : "rounds";
              params.spacingMm = parseFloat(document.getElementById("sp-ellipse-target-spacing-mm").value) || 0;
              params.extraRounds = parseFloat(document.getElementById("sp-ellipse-target-rounds-val").value) || 0;
            }
          }
        }

        setStatus("busy", "生成螺旋线中…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolSpiral(' + jsxQuote(JSON.stringify(params)) + ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") { setStatus("err", "执行出错"); return; }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("sp-res-mode").textContent = data.mode;
              document.getElementById("sp-res-rounds").textContent = data.rounds;
              document.getElementById("sp-res-spacing").textContent = data.spacing;
              document.getElementById("sp-res-diameter").textContent = data.diameter;
              document.getElementById("sp-result").classList.add("visible");
              setStatus("ok", "螺旋线已生成");
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }


  // ── 工具 7：沿路径均匀分布 ─────────────────────────
  ,{
    id: "distributeAlongPath",
    name: "沿路径均匀分布",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">分布数量</div>
          <div class="section-body">
            <div class="form-row">
              <label>数量</label>
              <input type="number" id="dap-count" value="5" min="1" step="1"/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">使用规则</div>
          <div class="section-body">
            <p class="hint" style="margin:0">请至少选中 2 个对象。程序会按上下位置自动识别：最下方对象为路径，其余上方对象为图形；多个图形会按从左到右顺序放置。</p>
            <button class="btn btn-secondary" id="dap-refresh" style="margin-top:4px">识别当前选区</button>
            <p class="hint" id="dap-detect-status" style="margin:0">尚未识别</p>
          </div>
        </div>

        <div class="section">
          <div class="section-header">曲线参数</div>
          <div class="section-body">
            <label class="check-item"><input type="radio" name="dap-open-curve" id="dap-open-curve-exclude" checked/> 开放曲线不在两个端点放置</label>
            <label class="check-item"><input type="radio" name="dap-open-curve" id="dap-open-curve-include"/> 开放曲线在两个端点放置</label>
            <div class="form-row">
              <label>多图形倍数</label>
              <input type="number" id="dap-multi-curve-multiplier" value="1" min="1" step="1" disabled/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">折线参数</div>
          <div class="section-body">
            <label class="check-item"><input type="radio" name="dap-poly-mode" id="dap-poly-vertices" checked/> 放在顶点</label>
            <label class="check-item"><input type="radio" name="dap-poly-mode" id="dap-poly-midpoints"/> 放在每个线段中点</label>
          </div>
        </div>

        <div class="section">
          <div class="section-header">生成选项</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="dap-rotate" checked/> 沿路径方向旋转</label>
            <div class="form-row">
              <label>角度补偿 °</label>
              <input type="number" id="dap-angle-offset" value="0" step="1"/>
            </div>
            <label class="check-item"><input type="checkbox" id="dap-scale-down"/> 逐级缩放</label>
            <div class="form-row">
              <label>末个缩放 %</label>
              <input type="number" id="dap-end-scale" value="50" min="0.1" step="1" disabled/>
            </div>
            <label class="check-item"><input type="checkbox" id="dap-keep" checked/> 保留原始图形</label>
            <label class="check-item"><input type="checkbox" id="dap-delete-old"/> 删除同名旧分布组</label>
          </div>
        </div>

        <button class="btn" id="dap-run">▶  生成分布</button>

        <div class="result-card" id="dap-result">
          <div class="result-row"><span class="rk">路径类型</span><span class="rv" id="dap-path-type">—</span></div>
          <div class="result-row"><span class="rk">图形模式</span><span class="rv" id="dap-shape-mode">—</span></div>
          <div class="result-row"><span class="rk">生成数量</span><span class="rv accent" id="dap-count-result">—</span></div>
          <div class="result-row"><span class="rk">提示</span><span class="rv" id="dap-warning">—</span></div>
        </div>
      `;

      var scaleDown = document.getElementById("dap-scale-down");
      var endScale = document.getElementById("dap-end-scale");
      var countInput = document.getElementById("dap-count");
      var multiCurveMultiplier = document.getElementById("dap-multi-curve-multiplier");
      var openCurveExclude = document.getElementById("dap-open-curve-exclude");
      var openCurveInclude = document.getElementById("dap-open-curve-include");
      scaleDown.addEventListener("change", function () {
        endScale.disabled = !scaleDown.checked;
      });

      function syncPathState(report) {
        csInterface.evalScript('toolDistributeAlongPathInspectSelection()', function (result) {
          try {
            var data = parseEvalJson(result);
            var disabled = !!(data.ok && data.closed);
            openCurveExclude.disabled = disabled;
            openCurveInclude.disabled = disabled;
            countInput.disabled = !!(data.ok && data.polyline);
            multiCurveMultiplier.disabled = !(data.ok && !data.polyline && Number(data.shapeCount || 0) > 1);
            if (report) {
              var msg = data.ok
                ? (data.polyline
                  ? "已识别：折线，分布数量不可用"
                  : (Number(data.shapeCount || 0) > 1
                    ? (data.closed ? "已识别：多图形 + 封闭曲线，多图形倍数可用" : "已识别：多图形 + 开放曲线，多图形倍数可用")
                    : (data.closed ? "已识别：封闭路径，开放曲线端点选项不可用" : "已识别：开放曲线，分布数量和端点选项可用")))
                : "未识别到有效路径，请确认最下方对象是路径";
              document.getElementById("dap-detect-status").textContent = msg;
              setStatus(data.ok ? "ok" : "err", msg);
            }
          } catch (e) {}
        });
      }
      document.getElementById("dap-refresh").addEventListener("click", function () {
        syncPathState(true);
      });

      document.getElementById("dap-run").addEventListener("click", function () {
        var params = {
          count: parseInt(document.getElementById("dap-count").value, 10) || 0,
          openCurveIncludeEnds: document.getElementById("dap-open-curve-include").checked,
          polylinePlacementMode: document.getElementById("dap-poly-midpoints").checked ? "midpoints" : "vertices",
          openPolylineIncludeEnds: true,
          multiCurveMultiplier: parseInt(document.getElementById("dap-multi-curve-multiplier").value, 10) || 1,
          rotateWithPath: document.getElementById("dap-rotate").checked,
          angleOffset: parseFloat(document.getElementById("dap-angle-offset").value) || 0,
          scaleDown: document.getElementById("dap-scale-down").checked,
          endScale: parseFloat(document.getElementById("dap-end-scale").value) || 50,
          keepOriginal: document.getElementById("dap-keep").checked,
          deleteOldCopies: document.getElementById("dap-delete-old").checked
        };

        setStatus("busy", "沿路径分布中…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolDistributeAlongPath(' + jsxQuote(JSON.stringify(params)) + ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") { setStatus("err", "执行出错"); return; }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("dap-path-type").textContent = data.pathType;
              document.getElementById("dap-shape-mode").textContent = data.shapeMode;
              document.getElementById("dap-count-result").textContent = data.count + " 个";
              document.getElementById("dap-warning").textContent = data.warning || "—";
              document.getElementById("dap-result").classList.add("visible");
              setStatus(data.warning ? "warn" : "ok", data.warning || "已生成 " + data.count + " 个分布对象");
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }


  // ── 工具 8：全能镜像 ─────────────────────────
  ,{
    id: "fourWayMirror",
    name: "全能镜像",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">镜像方向</div>
          <div class="section-body">
            <div class="check-row">
              <label class="check-item"><input type="checkbox" id="fwm-left"/> 左</label>
              <label class="check-item"><input type="checkbox" id="fwm-right"/> 右</label>
            </div>
            <div class="check-row">
              <label class="check-item"><input type="checkbox" id="fwm-top"/> 上</label>
              <label class="check-item"><input type="checkbox" id="fwm-bottom"/> 下</label>
            </div>
            <label class="check-item"><input type="checkbox" id="fwm-all"/> 四方全部</label>
          </div>
        </div>

        <div class="section">
          <div class="section-header">方向角度对称</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="fwm-directional"/> 启用方向角度对称</label>
            <div class="form-row">
              <label>方位</label>
              <select id="fwm-corner">
                <option value="0">左上</option>
                <option value="1">左下</option>
                <option value="2">右上</option>
                <option value="3" selected>右下</option>
              </select>
            </div>
            <div class="form-row">
              <label>角度 °</label>
              <input type="number" id="fwm-angle" value="45" min="0" max="90" step="1"/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">指定线段镜像</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="fwm-axis-line"/> 启用指定线段镜像</label>
            <label class="check-item"><input type="radio" name="fwm-axis-mode" id="fwm-axis-mode-segment" value="segment" checked/> 沿这条直线段</label>
            <label class="check-item"><input type="radio" name="fwm-axis-mode" id="fwm-axis-mode-perp" value="perpendicular"/> 沿这条直线段的垂直中线</label>
          </div>
        </div>

        <div class="section">
          <div class="section-header">生成选项</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="fwm-select-new"/> 完成后选中新对象</label>
          </div>
        </div>

        <p class="hint">选中路径、图形、复合路径、编组或多个对象后执行。使用指定线段镜像时，请同时选中 1 条开放直线段；可沿线段本身镜像，或沿经过线段中点的垂直线镜像。轴线会保留，工具只复制并镜像其它对象。</p>

        <button class="btn" id="fwm-run">▶  生成镜像</button>

        <div class="result-card" id="fwm-result">
          <div class="result-row"><span class="rk">镜像方向</span><span class="rv" id="fwm-mirror-count">—</span></div>
          <div class="result-row"><span class="rk">角度对称</span><span class="rv" id="fwm-directional-count">—</span></div>
          <div class="result-row"><span class="rk">线段镜像</span><span class="rv" id="fwm-axis-count">—</span></div>
          <div class="result-row"><span class="rk">生成总数</span><span class="rv accent" id="fwm-count">—</span></div>
        </div>
      `;

      var all = document.getElementById("fwm-all");
      var directionIds = ["fwm-left", "fwm-right", "fwm-top", "fwm-bottom"];
      all.addEventListener("change", function () {
        for (var i = 0; i < directionIds.length; i++) {
          document.getElementById(directionIds[i]).checked = all.checked;
        }
      });

      function syncAll() {
        all.checked =
          document.getElementById("fwm-left").checked &&
          document.getElementById("fwm-right").checked &&
          document.getElementById("fwm-top").checked &&
          document.getElementById("fwm-bottom").checked;
      }

      for (var d = 0; d < directionIds.length; d++) {
        document.getElementById(directionIds[d]).addEventListener("change", syncAll);
      }

      var directional = document.getElementById("fwm-directional");
      function syncDirectional() {
        var disabled = !directional.checked;
        document.getElementById("fwm-corner").disabled = disabled;
        document.getElementById("fwm-angle").disabled = disabled;
      }
      directional.addEventListener("change", syncDirectional);
      syncDirectional();

      var axisLine = document.getElementById("fwm-axis-line");
      function syncAxisLine() {
        var disabled = !axisLine.checked;
        document.getElementById("fwm-axis-mode-segment").disabled = disabled;
        document.getElementById("fwm-axis-mode-perp").disabled = disabled;
      }
      axisLine.addEventListener("change", syncAxisLine);
      syncAxisLine();

      document.getElementById("fwm-run").addEventListener("click", function () {
        var axisModeEl = document.querySelector('input[name="fwm-axis-mode"]:checked');
        var params = {
          left: document.getElementById("fwm-left").checked,
          right: document.getElementById("fwm-right").checked,
          top: document.getElementById("fwm-top").checked,
          bottom: document.getElementById("fwm-bottom").checked,
          directional: document.getElementById("fwm-directional").checked,
          axisLine: document.getElementById("fwm-axis-line").checked,
          axisLineMode: axisModeEl ? axisModeEl.value : "segment",
          cornerIndex: parseInt(document.getElementById("fwm-corner").value, 10),
          angle: parseFloat(document.getElementById("fwm-angle").value),
          selectNew: document.getElementById("fwm-select-new").checked
        };

        if (!params.left && !params.right && !params.top && !params.bottom && !params.directional && !params.axisLine) {
          setStatus("err", "请至少选择一个镜像方向，或启用方向角度对称 / 指定线段镜像");
          return;
        }

        if (params.directional && (isNaN(params.angle) || params.angle < 0 || params.angle > 90)) {
          setStatus("err", "方向角度请输入 0 到 90 之间的数字");
          return;
        }

        setStatus("busy", "生成镜像中…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolFourWayMirror(' + jsxQuote(JSON.stringify(params)) + ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") { setStatus("err", "执行出错"); return; }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("fwm-mirror-count").textContent = data.mirrorCount + " 个";
              document.getElementById("fwm-directional-count").textContent = data.directionalCount + " 个";
              document.getElementById("fwm-axis-count").textContent = (data.axisLineCount || 0) + " 个";
              document.getElementById("fwm-count").textContent = data.count + " 个";
              document.getElementById("fwm-result").classList.add("visible");
              setStatus("ok", "已生成 " + data.count + " 个镜像对象");
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }


  // ── 工具 8：批量导出顶层对象 ───────────────────────
  ,{
    id: "batchExportTopItems",
    name: "批量导出加工文件",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">导出设置</div>
          <div class="section-body">
            <div class="form-row">
              <label>文件格式</label>
              <select id="be-format">
                <option value="AI3">Illustrator 3（.ai）</option>
                <option value="DXF2000">AutoCAD 2000 DXF（.dxf）</option>
              </select>
            </div>
          </div>
        </div>

        <p class="hint">将当前文档中的顶层对象按单个文件批量导出。导出单位包括：顶层编组、顶层复合路径、顶层普通路径。不会拆分编组内部对象，也不会修改原文件。</p>

        <button class="btn" id="be-run">▶  选择文件夹并导出</button>

        <div class="result-card" id="be-result">
          <div class="result-row">
            <span class="rk">导出格式</span>
            <span class="rv" id="be-formatText">—</span>
          </div>
          <div class="result-row">
            <span class="rk">导出数量</span>
            <span class="rv accent" id="be-count">—</span>
          </div>
          <div class="result-row">
            <span class="rk">保存位置</span>
            <span class="rv" id="be-folder" style="word-break:break-all;">—</span>
          </div>
        </div>
      `;

      document.getElementById("be-run").addEventListener("click", function () {
        var format = document.getElementById("be-format").value;

        var go = confirm(
          "提示：\n\n" +
          "导出文件过多时，Illustrator 可能出现卡顿或无响应。\n" +
          "请提前将当前文件存档后再继续。\n\n" +
          "是否继续导出？"
        );
        if (!go) {
          setStatus("", "已取消导出");
          return;
        }

        setStatus("busy", "准备导出…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolBatchExportTopItems(' + jsxQuote(format) + ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") { setStatus("err", "执行出错"); return; }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("be-formatText").textContent = data.format;
              document.getElementById("be-count").textContent = data.count + " 个";
              document.getElementById("be-folder").textContent = data.folder;
              document.getElementById("be-result").classList.add("visible");
              if (data.failed && Number(data.failed) > 0) {
                setStatus("err", data.message || ("有 " + data.failed + " 个文件导出失败"));
              } else {
                setStatus("ok", "导出完成，共 " + data.count + " 个");
              }
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }


  // ── 工具 9：曲线等分 ─────────────────────────────
  ,{
    id: "divideCurve",
    name: "曲线等分",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">等分设置</div>
          <div class="section-body">
            <div class="form-row">
              <label>等分份数</label>
              <input type="number" id="dc-parts" value="4" min="2" step="1"/>
            </div>
            <div class="form-row">
              <label>标记直径 mm</label>
              <input type="number" id="dc-marker" value="2" min="0.1" step="0.1"/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">生成选项</div>
          <div class="section-body">
            <label class="check-item"><input type="radio" name="dc-mode" id="dc-mode-mark" value="mark" checked/> 标记等分点</label>
            <label class="check-item"><input type="radio" name="dc-mode" id="dc-mode-cut" value="cut"/> 直接切断</label>
            <label class="check-item"><input type="checkbox" id="dc-delete-old" checked/> 删除旧等分结果图层</label>
          </div>
        </div>

        <p class="hint">选中 1 条普通曲线或折线后执行。标记模式只生成等分点；切断模式会生成独立分段路径并隐藏原曲线。</p>

        <button class="btn" id="dc-run">▶  执行等分</button>

        <div class="result-card" id="dc-result">
          <div class="result-row"><span class="rk">等分份数</span><span class="rv" id="dc-parts-result">—</span></div>
          <div class="result-row"><span class="rk">生成数量</span><span class="rv accent" id="dc-marker-count">—</span></div>
          <div class="result-row"><span class="rk">每份长度</span><span class="rv" id="dc-segment-length">—</span></div>
        </div>
      `;

      document.getElementById("dc-run").addEventListener("click", function () {
        var params = {
          parts: parseInt(document.getElementById("dc-parts").value, 10) || 0,
          markerMm: parseFloat(document.getElementById("dc-marker").value) || 2,
          mode: document.getElementById("dc-mode-cut").checked ? "cut" : "mark",
          deleteOld: document.getElementById("dc-delete-old").checked
        };

        setStatus("busy", params.mode === "cut" ? "切断曲线中…" : "生成等分标记中…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolDivideCurve(' + jsxQuote(JSON.stringify(params)) + ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") { setStatus("err", "执行出错"); return; }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("dc-parts-result").textContent = data.parts + " 份";
              document.getElementById("dc-marker-count").textContent = data.count + " 个";
              document.getElementById("dc-segment-length").textContent = data.segmentLength;
              document.getElementById("dc-result").classList.add("visible");
              setStatus("ok", data.mode === "cut" ? ("已切成 " + data.count + " 段") : ("已生成 " + data.count + " 个等分标记"));
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }


  // ── 工具 10：批量查找替换文本 ───────────────────
  ,{
    id: "replaceText",
    name: "批量查找替换文本",

    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">查找与替换</div>
          <div class="section-body">
            <div class="form-row">
              <label>查找文字</label>
              <input type="text" id="rt-find" placeholder="请输入要查找的文字"/>
            </div>
            <div class="form-row">
              <label>替换成</label>
              <input type="text" id="rt-replace" placeholder="留空表示删除"/>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">替换选项</div>
          <div class="section-body">
            <label class="check-item"><input type="checkbox" id="rt-case" checked/> 区分大小写</label>
            <label class="check-item"><input type="checkbox" id="rt-selected"/> 只处理当前选中的对象</label>
            <label class="check-item"><input type="checkbox" id="rt-skip" checked/> 跳过锁定或隐藏对象</label>
          </div>
        </div>

        <p class="hint">替换当前 Illustrator 文档中的文本。替换文字留空时，会删除匹配到的内容。</p>

        <button class="btn" id="rt-run">▶  开始替换</button>

        <div class="result-card" id="rt-result">
          <div class="result-row"><span class="rk">扫描文本框</span><span class="rv" id="rt-scanned">—</span></div>
          <div class="result-row"><span class="rk">已修改文本框</span><span class="rv" id="rt-changed">—</span></div>
          <div class="result-row"><span class="rk">替换次数</span><span class="rv accent" id="rt-count">—</span></div>
          <div class="result-row"><span class="rk">跳过数量</span><span class="rv" id="rt-skipped">—</span></div>
        </div>
      `;

      document.getElementById("rt-run").addEventListener("click", function () {
        var findText = document.getElementById("rt-find").value;
        if (!findText) {
          setStatus("err", "请输入要查找的文字");
          document.getElementById("rt-find").focus();
          return;
        }

        var replaceText = document.getElementById("rt-replace").value;
        var caseSensitive = document.getElementById("rt-case").checked;
        var selectedOnly = document.getElementById("rt-selected").checked;
        var skipLockedHidden = document.getElementById("rt-skip").checked;

        setStatus("busy", "正在替换文本…");
        this.disabled = true;
        var btn = this;

        csInterface.evalScript(
          'toolReplaceText(' +
            jsxQuote(findText) + ',' +
            jsxQuote(replaceText) + ',' +
            (caseSensitive ? 'true' : 'false') + ',' +
            (selectedOnly ? 'true' : 'false') + ',' +
            (skipLockedHidden ? 'true' : 'false') +
          ')',
          function (result) {
            btn.disabled = false;
            if (!result || result === "EvalScript error.") { setStatus("err", "执行出错"); return; }
            try {
              var data = parseEvalJson(result);
              if (data.error) { setStatus("err", data.error); return; }
              document.getElementById("rt-scanned").textContent = data.scanned + " 个";
              document.getElementById("rt-changed").textContent = data.changed + " 个";
              document.getElementById("rt-count").textContent = data.count + " 次";
              document.getElementById("rt-skipped").textContent = data.skipped + " 个";
              document.getElementById("rt-result").classList.add("visible");
              setStatus("ok", "替换完成，共 " + data.count + " 次");
            } catch (e) {
              setStatus("err", "数据解析失败");
            }
          }
        );
      });
    }
  }


  // ══════════════════════════════════════════════════
  ,{
    id: "saveAsAI3",
    name: "另存为 AI3",
    buildPanel: function (container) {
      container.innerHTML = `
        <div class="section">
          <div class="section-header">另存为 Illustrator 3</div>
          <div class="section-body">
            <p class="hint">请先保存当前文件。将在原文件所在文件夹生成“原文件名_AI3.ai”；如果目标已存在，会询问是否覆盖。</p>
            <p class="hint">执行后当前文档会切换到另存的 AI3 文件。旧格式可能扁平化内容、改变不兼容的效果或影响多画板，请保留原文件。</p>
          </div>
        </div>
        <button class="btn" id="ai3-run">▶  另存为 AI3</button>
        <div class="result-card" id="ai3-result">
          <div class="result-row"><span class="rk">保存位置</span><span class="rv" id="ai3-path" style="word-break:break-all;">—</span></div>
        </div>
      `;
      document.getElementById("ai3-run").addEventListener("click", function () {
        var btn = this;
        btn.disabled = true;
        document.getElementById("ai3-result").classList.remove("visible");
        setStatus("busy", "正在另存为 AI3…");
        csInterface.evalScript("toolSaveAsAI3()", function (result) {
          btn.disabled = false;
          if (!result || result === "EvalScript error.") { setStatus("err", "执行出错"); return; }
          try {
            var data = parseEvalJson(result);
            if (data.error) { setStatus("err", data.error); return; }
            if (data.cancelled) { setStatus("", "已取消另存"); return; }
            document.getElementById("ai3-path").textContent = data.path;
            document.getElementById("ai3-result").classList.add("visible");
            setStatus("ok", "已另存为 AI3");
          } catch (e) { setStatus("err", "数据解析失败"); }
        });
      });
    }
  }

  //  ★ 新增工具模板 — 复制此块，改 id / name / buildPanel
  // ══════════════════════════════════════════════════
  /*
  ,{
    id: "myNewTool",
    name: "新工具",

    buildPanel: function (container) {
      container.innerHTML = `
        <p class="hint">这里写工具说明</p>
        <button class="btn" id="nt-run">▶  执 行</button>
      `;
      document.getElementById("nt-run").addEventListener("click", function () {
        csInterface.evalScript('myNewToolJsx()', function (result) {
          setStatus("ok", "执行完成");
        });
      });
    }
  }
  */

];
