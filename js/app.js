/* Shared panel shell and host-operation guard. No build step or runtime downloads. */
var hostBusy = false;
var hostBackground = false;
var TOOL_GROUPS = [
  {label:"测量统计",ids:["dimension","lineLength"]},
  {label:"绘图加工",ids:["flange","coneFrustum","randomFill","parametricArc","spiral","distributeAlongPath","fourWayMirror","divideCurve"]},
  {label:"文本处理",ids:["replaceText"]},
  {label:"文件导出",ids:["batchExportTopItems","saveAsAI3"]}
];
var TOOL_DESCRIPTIONS = {
  dimension:"让每一处尺寸，清楚可见。",
  lineLength:"统计选中路径的长度、闭合轮廓与加工费用。",
  flange:"沿图形边缘生成可编辑的拼接折边。",
  coneFrustum:"从直径和高度计算圆台的平面展开图。",
  randomFill:"将选中的图形随机缩放、旋转并填入容器。",
  parametricArc:"按宽度和高度绘制圆弧。",
  spiral:"以圈数、间距或目标直径构建螺旋线。",
  distributeAlongPath:"将图形沿曲线或折线规律排布。",
  fourWayMirror:"围绕指定轴线生成对称图形。",
  divideCurve:"按弧长等分路径，生成标记或独立线段。",
  replaceText:"批量查找并替换文档中的文字。",
  batchExportTopItems:"将顶层对象分别导出为加工文件。",
  saveAsAI3:"将当前文档另存为 Illustrator 3 格式。"
};

function setStatus(type, msg) {
  var dot = document.getElementById("statusDot"), text = document.getElementById("statusText");
  if (!dot || !text) return;
  dot.className = "status-dot" + (type ? " " + type : "");
  text.textContent = msg || "就绪";
  text.parentNode.title = msg || "就绪";
}

function validatePanel(panel) {
  var fields = panel.querySelectorAll('input[type="number"]');
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.disabled) continue;
    var hiddenSection = false, ancestor = f.parentElement;
    while (ancestor && ancestor !== panel) {
      if (ancestor.hidden || ancestor.style.display === "none") { hiddenSection = true; break; }
      ancestor = ancestor.parentElement;
    }
    if (hiddenSection) continue;
    var n = Number(f.value), problem = "";
    if (!f.value.trim() || !isFinite(n)) problem = "请输入有效数值";
    else if (f.min !== "" && n < Number(f.min)) problem = "数值不能小于 " + f.min;
    else if (f.max !== "" && n > Number(f.max)) problem = "数值不能大于 " + f.max;
    else if (f.getAttribute("data-integer") === "true" && n % 1 !== 0) problem = "请输入整数";
    f.classList.toggle("invalid", !!problem);
    f.setAttribute("aria-invalid", String(!!problem));
    if (problem) {
      var details = f.closest("details"); if (details) details.open = true;
      var label = document.querySelector('label[for="' + f.id + '"]');
      setStatus("err", (label ? label.textContent + "：" : "") + problem);
      f.focus(); return false;
    }
  }
  return true;
}

(function initPanel() {
  // Older CEP Chromium versions support grid gaps but ignore flex gaps.
  var gapProbe = document.createElement("div");
  gapProbe.style.cssText = "position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px";
  gapProbe.innerHTML = '<div style="height:1px"></div><div style="height:1px"></div>';
  document.body.appendChild(gapProbe);
  document.documentElement.classList.toggle("no-flex-gap", gapProbe.scrollHeight !== 3);
  document.body.removeChild(gapProbe);
  var originalEval = csInterface.evalScript;
  var hostQueue = [];
  csInterface.evalScript = function (script, callback, options) {
    if (hostBusy && hostBackground && !(options && options.background)) { hostQueue.push({script:script,callback:callback,options:options}); return; }
    if (hostBusy) { if (callback) callback(JSON.stringify({error:"上一项操作仍在执行，请稍候"})); return; }
    hostBusy = true;
    var background = options && options.background;
    hostBackground = !!background;
    if (!background) {
      document.body.classList.add("host-busy");
      document.getElementById("contentArea").setAttribute("aria-busy", "true");
    }
    var finished = false;
    function finish(result) {
      if (finished) return;
      finished = true; hostBusy = false; hostBackground = false;
      if (!background) {
        document.body.classList.remove("host-busy");
        document.getElementById("contentArea").setAttribute("aria-busy", "false");
      }
      try { if (callback) callback(result); }
      finally {
        if (!hostBusy && hostQueue.length) { var next = hostQueue.shift(); csInterface.evalScript(next.script,next.callback,next.options); }
      }
    }
    try { originalEval.call(csInterface, script, finish); }
    catch (e) { finish(JSON.stringify({error:"与 Illustrator 通信失败：" + e.message})); }
  };

  var nav = document.getElementById("tabBar"), content = document.getElementById("contentArea");
  nav.innerHTML = '<div class="brand-row"><div class="brand-symbol" aria-hidden="true">Ai</div><div class="brand"><strong>设计工具箱</strong><span>DESIGN TOOLKIT</span></div><span class="version-tag">1.3</span></div>' +
    '<div class="tool-switch"><label class="sr-only" for="toolSelect">选择工具</label><select id="toolSelect" class="tool-select"></select><button type="button" class="icon-btn" id="browseTools" title="查找全部工具" aria-label="查找全部工具" aria-expanded="false">⌕</button></div>' +
    '<nav class="quick-nav" aria-label="常用工具"><button type="button" data-tool="dimension">尺寸标注</button><button type="button" data-tool="lineLength">线长统计</button><button type="button" data-tool="flange">拼接折边</button></nav>' +
    '<div id="toolDrawer" class="tool-drawer" hidden><label class="sr-only" for="toolSearch">搜索工具</label><input type="search" id="toolSearch" placeholder="搜索工具名称…"/><div id="toolList"></div><p id="noTools" class="field-note" hidden>没有匹配的工具</p></div>';
  var selector = document.getElementById("toolSelect"), drawer = document.getElementById("toolDrawer"), search = document.getElementById("toolSearch"), list = document.getElementById("toolList");
  var toolMap = {};
  TOOLS.forEach(function (t) { toolMap[t.id] = t; });
  TOOL_GROUPS.forEach(function (group) {
    var optgroup = document.createElement("optgroup"); optgroup.label = group.label;
    selector.appendChild(optgroup);
    group.ids.forEach(function (id) {
      var tool = toolMap[id]; if (!tool) return;
      var opt = document.createElement("option"); opt.value = id; opt.textContent = tool.name; optgroup.appendChild(opt);
      var entry = document.createElement("button"); entry.type = "button"; entry.className = "tool-entry"; entry.setAttribute("data-tool",id); entry.textContent = tool.name;
      var category = document.createElement("span"); category.textContent = group.label; entry.appendChild(category); list.appendChild(entry);
      var panel = document.createElement("section"); panel.id = "panel-" + id; panel.className = "tool-panel"; panel.setAttribute("aria-label",tool.name); content.appendChild(panel);
      tool.buildPanel(panel);
      var heading = document.createElement("div"); heading.className = "tool-heading";
      var eyebrow = document.createElement("span"); eyebrow.className = "eyebrow"; eyebrow.textContent = group.label + " / " + String(group.ids.indexOf(id)+1).replace(/^(\d)$/, "0$1");
      var h = document.createElement("h1"); h.textContent = tool.name;
      var description = document.createElement("p"); description.textContent = TOOL_DESCRIPTIONS[id] || "";
      heading.appendChild(eyebrow); heading.appendChild(h); heading.appendChild(description); panel.insertBefore(heading,panel.firstChild);
      panel.querySelectorAll(".form-row").forEach(function (row) { var label=row.querySelector("label"), field=row.querySelector("input,select"); if(label && field && field.id) label.setAttribute("for",field.id); });
      panel.querySelectorAll("button").forEach(function (b) { b.type="button"; });
    });
  });
  function toggleDrawer(open) { drawer.hidden = !open; document.getElementById("browseTools").setAttribute("aria-expanded",String(open)); if(open) search.focus(); }
  function activate(id) {
    if (hostBusy || !toolMap[id] || (dimensionPickActive && id !== "dimension")) return;
    document.querySelectorAll(".tool-panel").forEach(function (panel) { panel.classList.toggle("active",panel.id === "panel-" + id); });
    document.querySelectorAll("[data-tool]").forEach(function (b) { var active=b.getAttribute("data-tool") === id; b.classList.toggle("active",active); b.setAttribute("aria-current",active ? "page" : "false"); });
    selector.value=id; content.scrollTop=0; toggleDrawer(false);
    try { localStorage.setItem("aitools.activeTool",id); } catch(e) {}
    setStatus(window.__adobe_cep__ ? "ok" : "", window.__adobe_cep__ ? "就绪 · 在画板中选择对象后操作" : "界面预览 · 请在 Illustrator 中执行工具");
  }
  selector.addEventListener("change",function () { activate(this.value); });
  document.addEventListener("aitools:dimension-picking", function () { activate("dimension"); });
  nav.addEventListener("click",function(e) { var b=e.target.closest("[data-tool]"); if(b) activate(b.getAttribute("data-tool")); });
  document.getElementById("browseTools").addEventListener("click",function() { toggleDrawer(drawer.hidden); });
  search.addEventListener("input",function () { var found=0, q=this.value.trim().toLowerCase(); list.querySelectorAll("[data-tool]").forEach(function(b) { b.hidden=b.textContent.toLowerCase().indexOf(q)<0; if(!b.hidden) found++; }); document.getElementById("noTools").hidden=!!found; });
  search.addEventListener("keydown",function(e) { if(e.key === "Escape") { toggleDrawer(false); document.getElementById("browseTools").focus(); } });
  document.getElementById("reloadBtn").addEventListener("click",reloadPanel);

  ["dap-count","dap-multi-curve-multiplier","dc-parts","rf-fillCount"].forEach(function(id) { var f=document.getElementById(id); if(f) f.setAttribute("data-integer","true"); });
  ["dap-count","dap-multi-curve-multiplier","dc-parts"].forEach(function(id) { document.getElementById(id).max="10000"; });
  document.getElementById("rf-fillCount").max="1000";
  // Validate before legacy handlers can turn invalid values into silent defaults.
  document.addEventListener("click",function(e) {
    var b=e.target.closest("button"); if(!b) return;
    if(hostBusy && !hostBackground) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if(dimensionPickActive && b.closest(".tool-panel") && b.closest(".tool-panel").id !== "panel-dimension") { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (/-run$/.test(b.id)) {
      var panel=b.closest(".tool-panel");
      if(panel && !validatePanel(panel)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if(panel) panel.querySelectorAll(".result-card").forEach(function(r) { r.classList.remove("visible"); });
    }
  },true);
  document.addEventListener("input",function(e) { if(e.target.classList) { e.target.classList.remove("invalid"); e.target.removeAttribute("aria-invalid"); } });
  var flangeIds=["fl-top","fl-bottom","fl-left","fl-right"];
  flangeIds.forEach(function(id) { document.getElementById(id).addEventListener("change",function() { var n=flangeIds.filter(function(key) { return document.getElementById(key).checked; }).length; document.getElementById("fl-all").checked=n===4; document.getElementById("fl-all").indeterminate=n>0&&n<4; }); });
  document.getElementById("fl-all").addEventListener("change",function() { this.indeterminate=false; });
  ["dc-mode-mark","dc-mode-cut"].forEach(function(id) { document.getElementById(id).addEventListener("change",function() { document.getElementById("dc-marker").disabled=document.getElementById("dc-mode-cut").checked; }); });
  var active="dimension"; try { active=localStorage.getItem("aitools.activeTool") || active; } catch(e) {}
  activate(toolMap[active] ? active : "dimension");
  if(window.__adobe_cep__) { setStatus("busy","正在加载工具脚本…"); reloadJSX(function(error) { setStatus(error?"err":"ok",error || "工具箱已就绪"); if(!error) document.dispatchEvent(new CustomEvent("aitools:hostready")); }); }
})();
