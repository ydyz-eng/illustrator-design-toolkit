/* Dimension panel. The diagram is an illustrative preview, never document data. */
var dimensionPickActive = false;
function buildDimensionPanel(container) {
  container.innerHTML = `
    <div class="dimension-preview" aria-label="尺寸标注样式示意">
      <div class="preview-caption"><span>标注示意</span><span id="dm-preview-caption">逐个对象 · mm</span></div>
      <svg id="dm-preview" viewBox="0 0 320 144" role="img" aria-label="矩形宽高标注示意"></svg>
      <span class="preview-footnote">示意图 · 非当前选区</span>
    </div>
    <section class="section">
      <div class="section-header"><span class="section-index">01</span> 测量范围</div>
      <div class="section-body">
        <div class="mode-grid" role="group" aria-label="测量范围">
          <button type="button" class="mode-btn active" data-mode="each" aria-pressed="true"><span>▣</span>逐个对象</button>
          <button type="button" class="mode-btn" data-mode="overall" aria-pressed="false"><span>▧</span>整体尺寸</button>
          <button type="button" class="mode-btn" data-mode="gap" aria-pressed="false"><span>↔</span>对象间距</button>
          <button type="button" class="mode-btn" data-mode="artboard" aria-pressed="false"><span>□</span>当前画板</button>
          <button type="button" class="mode-btn" data-mode="aligned" aria-pressed="false"><span>⤢</span>斜边标注</button>
          <button type="button" class="mode-btn" data-mode="points" aria-pressed="false"><span>⌖</span>画布点击</button>
        </div>
        <input type="hidden" id="dm-mode" value="each"/>
        <p class="field-note" id="dm-mode-help">分别标注每个选中对象，群组作为一个整体。</p>
        <div class="form-row"><label for="dm-bounds">测量边界</label><select id="dm-bounds"><option value="geometric">几何边界（不含描边）</option><option value="visible">可见边界（含描边）</option></select></div>
        <div class="point-picker" id="dm-point-picker" hidden>
          <p class="field-note">无需选中对象，在画布任意位置单击三个点，自动生成真实距离标注。请单击，不要拖动。</p>
          <ol class="pick-steps" id="dm-pick-steps" aria-label="画布标注步骤"><li>起点</li><li>终点</li><li>标注位置</li></ol>
          <button type="button" class="btn" id="dm-pick-start">⌖ 开始画布标注</button>
          <p class="pick-status" id="dm-pick-status" role="status" aria-live="polite">第三点确定尺寸线的侧边和距离，无需返回面板生成。</p>
          <div class="action-pair" id="dm-pick-actions" hidden><button type="button" class="btn btn-secondary" id="dm-pick-status-btn">检查状态</button><button type="button" class="btn btn-secondary" id="dm-pick-cancel">取消并恢复</button></div>
          <p class="field-note">先设置单位与样式，再开始。已有两个选中锚点时，也可直接生成：</p>
          <button type="button" class="btn btn-quiet" id="dm-selected-run">标注已选两点</button>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-header"><span class="section-index">02</span> 位置与数值</div>
      <div class="section-body">
        <div class="axis-row" id="dm-axes"><label class="check-item"><input id="dm-width" type="checkbox" checked/>宽度</label><select id="dm-widthPosition" aria-label="宽度标注位置"><option value="bottom">下方 ↓</option><option value="top">上方 ↑</option></select><label class="check-item"><input id="dm-height" type="checkbox" checked/>高度</label><select id="dm-heightPosition" aria-label="高度标注位置"><option value="right">右侧 →</option><option value="left">左侧 ←</option></select></div>
        <div class="form-row" id="dm-aligned-side-row" hidden><label for="dm-alignedSide">标注侧边</label><select id="dm-alignedSide"><option value="auto">自动（闭合路径向外）</option><option value="left">沿路径方向左侧</option><option value="right">沿路径方向右侧</option></select></div>
        <p class="field-note" id="dm-click-position-note" hidden>画布点击时，侧边与偏移由第三点决定；以下位置参数仅用于已选锚点。</p>
        <div class="field-grid">
          <div class="field"><label for="dm-unit">显示单位</label><select id="dm-unit"><option value="mm">毫米 mm</option><option value="cm">厘米 cm</option><option value="in">英寸 in</option><option value="pt">磅 pt</option><option value="px">像素 px</option></select></div>
          <div class="field"><label for="dm-decimals">小数位数</label><select id="dm-decimals"><option>0</option><option>1</option><option selected>2</option><option>3</option><option>4</option></select></div>
          <div class="field"><label for="dm-offset">偏移距离 <small>mm</small></label><input id="dm-offset" type="number" value="8" min="0" max="10000" step="any" required/></div>
          <div class="field"><label for="dm-scale">数值倍率 <small>×</small></label><input id="dm-scale" type="number" value="1" min="0.0001" max="100000" step="any" required/></div>
        </div>
        <p class="field-note">1:10 的缩小图稿，倍率填 10。仅换算标注数值。</p>
      </div>
    </section>
    <section class="section">
      <div class="section-header"><span class="section-index">03</span> 标注样式 <span class="header-tail">自动记忆</span></div>
      <div class="section-body">
        <div class="preset-row" role="group" aria-label="样式预设"><button type="button" class="preset-btn" data-preset="compact">精细图稿</button><button type="button" class="preset-btn" data-preset="standard">标准标注</button><button type="button" class="preset-btn" data-preset="large">大幅图稿</button></div>
        <div class="field-grid">
          <div class="field"><label for="dm-fontsize">文字大小 <small>pt</small></label><input id="dm-fontsize" type="number" value="10" min="1" max="1000" step="any" required/></div>
          <div class="field"><label for="dm-arrow">箭头大小 <small>mm</small></label><input id="dm-arrow" type="number" value="2" min="0.1" max="100" step="any" required/></div>
        </div>
        <div class="form-row"><label for="dm-color">标注颜色</label><select id="dm-color"><option value="black">黑色 · 印刷</option><option value="red">红色 · 加工</option><option value="blue">蓝色 · 参考</option><option value="gray">灰色 · 辅助</option><option value="custom">自定义颜色</option></select><input id="dm-customColor" type="color" value="#f2b46a" aria-label="自定义标注颜色" hidden/></div>
      </div>
      <details class="advanced"><summary>更多样式选项</summary><div class="section-body">
        <div class="form-row"><label for="dm-arrowStyle">端点样式</label><select id="dm-arrowStyle"><option value="filled">实心箭头</option><option value="open">开放箭头</option><option value="tick">斜线刻度</option><option value="none">无端点</option></select></div>
        <div class="form-row"><label for="dm-strokeWidth">线宽 pt</label><input id="dm-strokeWidth" type="number" value="0.75" min="0.1" max="100" step="any" required/></div>
        <div class="form-row"><label for="dm-extensionGap">引线留空 mm</label><input id="dm-extensionGap" type="number" value="1" min="0" max="1000" step="any" required/></div>
        <div class="form-row"><label for="dm-extensionOvershoot">引线超出 mm</label><input id="dm-extensionOvershoot" type="number" value="2" min="0" max="1000" step="any" required/></div>
        <div class="form-row"><label for="dm-prefix">文字前缀</label><input id="dm-prefix" type="text" maxlength="40" placeholder="例如 W = "/></div>
        <div class="form-row"><label for="dm-suffix">文字后缀</label><input id="dm-suffix" type="text" maxlength="40" placeholder="例如 ±0.2"/></div>
        <div class="check-row"><label class="check-item"><input type="checkbox" id="dm-showUnit" checked/>显示单位</label><label class="check-item"><input type="checkbox" id="dm-trimZeros" checked/>去除末尾零</label></div>
        <p class="field-note">px 按 Illustrator 的 72 px/in 换算。文字保持可编辑。</p>
      </div></details>
    </section>
    <div class="result-card" id="dm-result" role="status"><div class="result-row"><span class="rk">本次标注</span><span class="rv accent" id="dm-result-count">—</span></div><p class="field-note" id="dm-result-note"></p></div>
    <div class="dimension-actions"><button type="button" class="btn" id="dm-run"><span>＋</span> 生成尺寸标注</button><div class="action-pair"><button type="button" class="btn btn-secondary" id="dm-clear-last">移除上次标注</button><button type="button" class="btn btn-quiet" id="dm-clear">清除全部标注</button></div></div>
    <p class="hint">生成到独立标注图层；清除仅作用于本版本生成的标注。原图稿缩放或修改后，请重新生成标注。</p>
  `;
  var fields = { mode: "mode", bounds: "bounds", alignedSide: "alignedSide", doWidth: "width", doHeight: "height", widthPosition: "widthPosition", heightPosition: "heightPosition", unit: "unit", decimals: "decimals", offset: "offset", scale: "scale", fontSize: "fontsize", arrow: "arrow", color: "color", customColor: "customColor", arrowStyle: "arrowStyle", strokeWidth: "strokeWidth", extensionGap: "extensionGap", extensionOvershoot: "extensionOvershoot", prefix: "prefix", suffix: "suffix", showUnit: "showUnit", trimZeros: "trimZeros" };
  var numeric = ["decimals", "offset", "scale", "fontSize", "arrow", "strokeWidth", "extensionGap", "extensionOvershoot"];
  function el(name) { return document.getElementById("dm-" + fields[name]); }
  function read() {
    var data = {};
    Object.keys(fields).forEach(function (key) { var f = el(key); data[key] = f.type === "checkbox" ? f.checked : (numeric.indexOf(key) >= 0 ? Number(f.value) : f.value); });
    return data;
  }
  function apply(data) {
    Object.keys(fields).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) return;
      var f = el(key);
      if (f.type === "checkbox") { if (typeof data[key] === "boolean") f.checked = data[key]; }
      else if (f.tagName === "SELECT") { for (var i = 0; i < f.options.length; i++) if (f.options[i].value === String(data[key])) f.value = data[key]; }
      else if (f.type === "number") { var n = Number(data[key]); if (isFinite(n) && n >= Number(f.min) && n <= Number(f.max)) f.value = n; }
      else if (key === "mode") { if (["each", "overall", "gap", "artboard", "aligned", "points"].indexOf(data[key]) >= 0) f.value = data[key]; }
      else f.value = String(data[key]).substring(0, 40);
    });
  }
  try { apply(JSON.parse(localStorage.getItem("aitools.dimension.v2") || "{}")); } catch (e) { /* Settings may be unavailable in CEP. */ }
  var pickToken = "", pickInteraction = "", pickPaused = false;
  var modeHelp = { each: "分别标注每个选中对象，群组作为一个整体。", overall: "将全部选中对象的外接矩形作为整体标注。", gap: "请选择两个对象，测量水平 / 垂直边缘间距；重叠方向将跳过。", artboard: "标注当前活动画板，无需选择对象。", aligned: "选中路径，沿每条直边标注真实长度；只选部分锚点时，仅标注两端均选中的直边。曲线段跳过。", points: "起点 → 终点 → 标注位置，支持空白处与任意斜向距离。" };
  function update(save) {
    var p = read();
    container.querySelectorAll("[data-mode]").forEach(function (b) { var active = b.getAttribute("data-mode") === p.mode; b.classList.toggle("active", active); b.setAttribute("aria-pressed", String(active)); });
    document.getElementById("dm-mode-help").textContent = modeHelp[p.mode];
    var aligned = p.mode === "aligned" || p.mode === "points";
    el("bounds").disabled = p.mode === "artboard" || aligned;
    document.getElementById("dm-axes").hidden = aligned;
    document.getElementById("dm-aligned-side-row").hidden = !aligned;
    document.getElementById("dm-point-picker").hidden = p.mode !== "points";
    document.getElementById("dm-click-position-note").hidden = p.mode !== "points";
    el("alignedSide").disabled = !aligned;
    el("alignedSide").options[0].textContent = p.mode === "points" ? "自动（起点 → 终点左侧）" : "自动（闭合路径向外）";
    document.getElementById("dm-preview").setAttribute("aria-label", aligned ? "斜向两点距离标注示意" : "矩形宽高标注示意");
    el("widthPosition").disabled = !p.doWidth;
    el("heightPosition").disabled = !p.doHeight;
    el("customColor").hidden = p.color !== "custom";
    document.getElementById("dm-preview-caption").textContent = {each:"逐个对象",overall:"整体尺寸",gap:"对象间距",artboard:"当前画板",aligned:"沿真实边长",points:"画布点击"}[p.mode] + " · " + p.unit;
    var run = document.getElementById("dm-run");
    run.disabled = dimensionPickActive && pickInteraction === "threeClick" && !pickPaused;
    run.textContent = dimensionPickActive ? (pickPaused ? "重试生成标注" : (pickInteraction === "threeClick" ? "请在画布上完成三次点击" : "生成取点标注")) : (p.mode === "points" ? "⌖ 开始画布标注" : "＋ 生成尺寸标注");
    if (dimensionPickActive) container.querySelectorAll("input, select, [data-preset]").forEach(function(f) { f.disabled = true; });
    renderDimensionPreview(document.getElementById("dm-preview"), p);
    if (save) try { localStorage.setItem("aitools.dimension.v2", JSON.stringify(p)); } catch (e) { /* Optional persistence. */ }
  }
  container.querySelectorAll("[data-mode]").forEach(function (b) { b.addEventListener("click", function () { el("mode").value = this.getAttribute("data-mode"); update(true); }); });
  var presets = {compact:{fontSize:7,arrow:1,strokeWidth:0.35,offset:4},standard:{fontSize:10,arrow:2,strokeWidth:0.75,offset:8},large:{fontSize:24,arrow:4,strokeWidth:1.5,offset:16}};
  container.querySelectorAll("[data-preset]").forEach(function (b) { b.addEventListener("click", function () { apply(presets[this.getAttribute("data-preset")]); update(true); setStatus("ok", "已应用「" + this.textContent + "」样式"); }); });
  container.addEventListener("input", function () { update(true); });
  container.addEventListener("change", function () { update(true); });
  function execute(script, done, failed) {
    setStatus("busy", "正在处理标注…");
    csInterface.evalScript(script, function (result) {
      try { var data = parseEvalJson(result); if (data.error) { setStatus("err", data.error); if (failed) failed(data.error, data); return; } done(data); }
      catch (e) { var message = "标注执行失败：" + e.message; setStatus("err", message); if (failed) failed(message); }
    });
  }
  function renderResult(data, mode) {
    document.getElementById("dm-result-count").textContent = data.dimensionCount + " 条 / " + data.count + (mode === "points" ? " 处测量" : " 个对象");
    document.getElementById("dm-result-note").textContent = data.warnings || "已生成可编辑标注，原始选择已保留。";
    document.getElementById("dm-result").classList.add("visible");
    setStatus(data.warnings ? "warn" : "ok", data.warnings || "已生成 " + data.dimensionCount + " 条尺寸标注");
  }
  function showPickProgress(data) {
    document.getElementById("dm-pick-status").textContent = data.msg || "请在画布上单击起点、终点和标注位置。";
    var count = Number(data.pointCount) || 0;
    container.querySelectorAll(".pick-steps li").forEach(function(step, index) {
      step.classList.toggle("complete", dimensionPickActive && index < count);
      step.classList.toggle("current", dimensionPickActive && index === count);
      if (dimensionPickActive && index === count) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current");
    });
    if (data.autoPaused) { pickPaused = true; update(false); }
  }
  function pausePicking(message, data) {
    if (dimensionPickActive) {
      pickPaused = true;
      showPickProgress({msg:message + "；请点击下方「重试生成标注」，或取消并恢复。", pointCount:data && data.pointCount, autoPaused:true});
    }
    setStatus("err", message);
  }
  var poller = createDimensionPoller({
    parseResponse:parseEvalJson,
    request:function(script, callback) { csInterface.evalScript(script, callback, {background:true}); },
    getBusy:function() { return hostBusy; },
    onUpdate:function(data) {
      if (!data.active) { setPicking(data); return; }
      showPickProgress(data);
      setStatus(data.phase === "invalid" || data.phase === "documentChanged" || data.autoPaused ? "warn" : "ok", data.msg);
      if (data.autoPaused) poller.stop();
    },
    onComplete:function(data) {
      setPicking({active:false,msg:"标注已自动生成。可以开始下一次画布标注。"});
      renderResult(data, "points");
    },
    onError:pausePicking
  });
  function setPicking(data) {
    var wasActive = dimensionPickActive;
    dimensionPickActive = !!data.active;
    pickToken = dimensionPickActive ? data.token : "";
    pickInteraction = dimensionPickActive ? data.interaction : "";
    pickPaused = dimensionPickActive && !!data.autoPaused;
    if (!dimensionPickActive) {
      poller.stop();
      container.querySelectorAll("input, select, [data-preset]").forEach(function(f) { f.disabled = false; });
    }
    document.body.classList.toggle("dimension-picking", dimensionPickActive);
    if (dimensionPickActive) el("mode").value = "points";
    container.querySelectorAll("[data-mode]").forEach(function (b) { b.disabled = dimensionPickActive; });
    document.getElementById("dm-pick-start").disabled = dimensionPickActive;
    document.getElementById("dm-selected-run").disabled = dimensionPickActive;
    document.getElementById("dm-clear").disabled = dimensionPickActive;
    document.getElementById("dm-clear-last").disabled = dimensionPickActive;
    document.getElementById("dm-pick-actions").hidden = !dimensionPickActive;
    showPickProgress(data);
    if (document.getElementById("toolSelect")) document.getElementById("toolSelect").disabled = dimensionPickActive;
    if (dimensionPickActive && !wasActive) document.dispatchEvent(new CustomEvent("aitools:dimension-picking"));
    update(true);
    if (dimensionPickActive && pickInteraction === "threeClick" && !pickPaused) poller.start(pickToken);
  }
  function startPick() {
    if (!validatePanel(container)) return;
    document.getElementById("dm-result").classList.remove("visible");
    var options = {interaction:"threeClick",settings:read()};
    execute("toolDimensionPickBegin(" + jsxQuote(JSON.stringify(options)) + ")", function (data) { setPicking(data); setStatus("ok", data.msg); });
  }
  document.getElementById("dm-pick-start").addEventListener("click", startPick);
  document.getElementById("dm-pick-status-btn").addEventListener("click", function () {
    execute("toolDimensionPickStatus(" + jsxQuote(pickToken) + ")", function (data) { setPicking(data); setStatus(data.phase === "invalid" || data.phase === "documentChanged" ? "warn" : "ok", data.msg); });
  });
  document.getElementById("dm-pick-cancel").addEventListener("click", function () {
    poller.stop();
    execute("toolDimensionPickCancel(" + jsxQuote(pickToken) + ")", function (data) { setPicking(data); setStatus("ok", data.msg); }, pausePicking);
  });
  document.addEventListener("aitools:hostready", function () {
    csInterface.evalScript("toolDimensionPickStatus()", function (result) {
      try { var data = parseEvalJson(result); if (data.active) { setPicking(data); setStatus("warn", "已恢复画布取点，可继续点击或取消并恢复。"); } } catch (e) {}
    });
  });
  function generate() {
    var p = read();
    var aligned = p.mode === "aligned" || p.mode === "points";
    if (!aligned && !p.doWidth && !p.doHeight) { setStatus("err", "请至少启用宽度或高度标注"); return; }
    if (dimensionPickActive) p.pickToken = pickToken;
    var command = dimensionPickActive ? "toolDimensionPickFinish" : "toolDimension";
    if (dimensionPickActive) poller.stop();
    execute(command + "(" + jsxQuote(JSON.stringify(p)) + ")", function (data) {
      if (data.picking === false) setPicking({active:false,msg:"标注已生成，取点辅助线已清理，原图层已恢复。"});
      renderResult(data, p.mode);
    }, pausePicking);
  }
  document.getElementById("dm-run").addEventListener("click", function () {
    if (el("mode").value === "points" && !dimensionPickActive) startPick(); else generate();
  });
  document.getElementById("dm-selected-run").addEventListener("click", generate);
  function clear(scope) {
    execute("clearDimensionLayer(" + jsxQuote(scope) + ")", function (data) { document.getElementById("dm-result").classList.remove("visible"); setStatus("ok", data.msg || "标注已清除"); });
  }
  document.getElementById("dm-clear-last").addEventListener("click", function () { clear("last"); });
  document.getElementById("dm-clear").addEventListener("click", function () { clear("all"); });
  window.addEventListener("beforeunload", function() { poller.stop(); });
  update(false);
}

function renderDimensionPreview(svg, p) {
  var ns = "http://www.w3.org/2000/svg";
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var color = {black:"#d8dee9",red:"#f17e73",blue:"#84b7ff",gray:"#a1aab7",custom:p.customColor}[p.color] || "#d8dee9";
  function node(tag, attrs, text) { var n = document.createElementNS(ns, tag); Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); }); if (text !== undefined) n.textContent = text; svg.appendChild(n); return n; }
  function line(x1,y1,x2,y2) { node("line",{x1:x1,y1:y1,x2:x2,y2:y2,stroke:color,"stroke-width":Math.min(2,Math.max(.6,p.strokeWidth || .75))}); }
  function label(value,x,y,rotate) {
    var factors = {mm:1,cm:.1,in:1/25.4,pt:72/25.4,px:72/25.4};
    var v = (value * factors[p.unit] * (isFinite(p.scale) ? p.scale : 1)).toFixed(Math.max(0,Math.min(4,p.decimals)));
    if (p.trimZeros) v = v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    var text = p.prefix + v + (p.showUnit ? " " + p.unit : "") + p.suffix;
    if (text.length > 26) text = text.substring(0,23) + "…";
    node("text",{x:x,y:y,fill:color,"text-anchor":"middle","font-size":10,transform:rotate ? "rotate(-90 " + x + " " + y + ")" : ""},text);
  }
  function arrow(x,y,dx,dy) {
    if (p.arrowStyle === "none") return;
    var s = Math.min(7,Math.max(2,(p.arrow || 2)*2));
    if (p.arrowStyle === "tick") { line(x-3,y+4,x+3,y-4); return; }
    node("path",{d:"M"+(x+dx*s-dy*s*.42)+","+(y+dy*s+dx*s*.42)+" L"+x+","+y+" L"+(x+dx*s+dy*s*.42)+","+(y+dy*s-dx*s*.42),stroke:color,fill:p.arrowStyle === "filled" ? color : "none","stroke-width":1});
  }
  var gap = p.mode === "gap";
  node("rect",{x:70,y:40,width:gap?55:170,height:60,rx:2,fill:"#ffffff05",stroke:"#7b899b","stroke-width":1.3});
  if (gap) node("rect",{x:180,y:40,width:60,height:60,rx:2,fill:"#ffffff05",stroke:"#7b899b"});
  if (p.mode === "overall") node("rect",{x:68,y:38,width:174,height:64,fill:"none",stroke:"#d9ac72","stroke-dasharray":"3 3"});
  if (p.mode === "artboard") node("text",{x:155,y:75,fill:"#788698","text-anchor":"middle","font-size":10},"ARTBOARD");
  if (p.mode === "aligned" || p.mode === "points") {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var a = [78,102], b = [224,48], dx = b[0]-a[0], dy = b[1]-a[1], length = Math.sqrt(dx*dx+dy*dy);
    var ux=dx/length,uy=dy/length,nx=uy,ny=-ux,sign=p.alignedSide === "right" ? -1:1;
    var ax=a[0]+nx*23*sign,ay=a[1]+ny*23*sign,bx=b[0]+nx*23*sign,by=b[1]+ny*23*sign;
    node("line",{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:"#7b899b","stroke-width":2});
    [a,b].forEach(function(pt) {node("circle",{cx:pt[0],cy:pt[1],r:3,fill:color});});
    line(a[0],a[1],ax+nx*5*sign,ay+ny*5*sign);line(b[0],b[1],bx+nx*5*sign,by+ny*5*sign);line(ax,ay,bx,by);arrow(ax,ay,ux,uy);arrow(bx,by,-ux,-uy);
    var tx=(ax+bx)/2+nx*7*sign,ty=(ay+by)/2+ny*7*sign;
    label(100,tx,ty,false);svg.lastChild.setAttribute("transform","rotate("+(Math.atan2(dy,dx)*180/Math.PI)+" "+tx+" "+ty+")");
    return;
  }
  if (p.doWidth) { var y = p.widthPosition === "top" ? 23 : 118, x1=gap?125:70,x2=gap?180:240; line(x1,37,x1,125); line(x2,37,x2,125); line(x1,y,x2,y); arrow(x1,y,1,0);arrow(x2,y,-1,0);label(gap?32:100,(x1+x2)/2,y-5,false); }
  if (p.doHeight && !gap) { var x = p.heightPosition === "left" ? 49 : 261;line(x-6,40,243,40);line(x-6,100,243,100);line(x,40,x,100);arrow(x,40,0,1);arrow(x,100,0,-1);label(35,x-5,70,true); }
}
