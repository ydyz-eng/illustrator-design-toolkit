/* Native Pen input for canvas dimensions. State survives panel reloads. */
if (typeof _dimensionPickSession === "undefined") var _dimensionPickSession = null;
if (typeof _dimensionPickLastResult === "undefined") var _dimensionPickLastResult = null;

function _dimensionPickThree(s) { return s.interaction === "threeClick"; }
function _dimensionPickScale(doc) {
  var scale = 1;
  try { scale = Number(doc.scaleFactor); } catch (e) {}
  return isFinite(scale) && scale > 0 ? scale : 1;
}

// Snapshot only the supported style fields. Subsequent panel edits cannot change
// the settings of an in-progress capture, and validation happens before locking art.
function _dimensionPickSettings(settings) {
  var p = settings === undefined ? {} : settings;
  if (!p || typeof p !== "object" || p instanceof Array) throw new Error("标注设置无效");
  var out = { mode: "points" };
  out.unit = _dimensionChoice(p.unit, "mm", ["mm", "cm", "in", "pt", "px"], "单位");
  out.decimals = _dimensionNumber(p.decimals, 2, 0, 4, "小数位数");
  if (out.decimals !== Math.floor(out.decimals)) throw new Error("小数位数必须是 0 到 4 的整数");
  out.fontSize = _dimensionNumber(p.fontSize, 10, 1, 1000, "字号");
  out.arrow = _dimensionNumber(p.arrow, 2, 0, 100, "箭头大小");
  out.strokeWidth = _dimensionNumber(p.strokeWidth, 0.75, 0.05, 100, "线宽");
  out.extensionGap = _dimensionNumber(p.extensionGap, 1, 0, 1000, "延长线起始间隙");
  out.extensionOvershoot = _dimensionNumber(p.extensionOvershoot, 2, 0, 1000, "延长线超出量");
  out.scale = _dimensionNumber(p.scale, 1, 0.000001, 1000000, "标注倍率");
  out.arrowStyle = _dimensionChoice(p.arrowStyle, "filled", ["filled", "open", "tick", "none"], "箭头样式");
  out.color = _dimensionChoice(p.color, "black", ["black", "red", "blue", "gray", "custom"], "标注颜色");
  out.customColor = p.customColor === undefined ? "" : String(p.customColor);
  _dimensionColor(out.color, out.customColor);
  out.prefix = p.prefix === undefined ? "" : String(p.prefix);
  out.suffix = p.suffix === undefined ? "" : String(p.suffix);
  if (out.prefix.length > 80 || out.suffix.length > 80 || /[\r\n]/.test(out.prefix + out.suffix))
    throw new Error("前后缀限 80 个字符，且不能包含换行");
  out.showUnit = p.showUnit !== false;
  out.trimZeros = p.trimZeros !== false;
  return out;
}

function _dimensionPickAlive(s) {
  if (!s) return false;
  for (var i = 0; i < app.documents.length; i++) if (app.documents[i] === s.doc) return true;
  return false;
}

function _dimensionPickCandidate(s) {
  var items = [], three = _dimensionPickThree(s), needed = three ? 3 : 2;
  for (var i = 0; i < s.layer.pageItems.length; i++) {
    var item = s.layer.pageItems[i];
    if (item.parent === s.layer && item !== s.marker) items.push(item);
  }
  if (!items.length) return { phase: three ? "waitingStart" : "waiting", pointCount: 0, msg: "请在画布上单击测量起点；不要拖动。" };
  if (items.length !== 1 || items[0].typename !== "PathItem")
    return { phase: "invalid", pointCount: 0, msg: "取点层中有多个对象；请仅保留一条取点路径，或取消后重试。" };
  var path = items[0], pts = path.pathPoints;
  var count = pts ? pts.length : 0;
  if (path.guides || path.clipping || path.hidden || path.locked)
    return { phase: "invalid", pointCount: count, msg: "取点线已变成参考线、剪切路径或被隐藏锁定，请取消取点；这些额外内容将保留。" };
  if (path.closed || !pts || pts.length > needed)
    return { phase: "invalid", pointCount: count, msg: three ? "请依次单击起点、终点、标注位置，共三个点；不要闭合或添加第四点。" : "请仅单击两个端点，不要闭合或添加第三个点。可取消后重新取点。" };
  var points = [];
  for (var p = 0; p < count; p++) {
    var a = pts[p].anchor, l = pts[p].leftDirection, r = pts[p].rightDirection;
    if (!a || !isFinite(Number(a[0])) || !isFinite(Number(a[1]))) return { phase: "invalid", pointCount: count, msg: "端点坐标无效，请取消后重试。" };
    if ((l && (!isFinite(Number(l[0])) || !isFinite(Number(l[1])) || Math.abs(l[0] - a[0]) > 0.00001 || Math.abs(l[1] - a[1]) > 0.00001)) ||
        (r && (!isFinite(Number(r[0])) || !isFinite(Number(r[1])) || Math.abs(r[0] - a[0]) > 0.00001 || Math.abs(r[1] - a[1]) > 0.00001)))
      return { phase: "invalid", pointCount: count, msg: "检测到曲线手柄。取点时请单击，不要按住拖动。" };
    points.push([Number(a[0]), Number(a[1])]);
  }
  if (count < 2) return { phase: three ? (count ? "waitingEnd" : "waitingStart") : "waiting", pointCount: count,
    path: path, msg: count ? "起点已记录，请单击测量终点。" : "请在画布上单击测量起点；不要拖动。" };
  var dx = points[1][0] - points[0][0], dy = points[1][1] - points[0][1];
  var length = Math.sqrt(dx * dx + dy * dy);
  if (!isFinite(length) || length <= 0.00001 / _dimensionPickScale(s.doc))
    return { phase: "invalid", pointCount: count, msg: "两个端点重合或坐标超出范围，请选择不同位置。" };
  if (three && count < 3) return { phase: "waitingPlacement", pointCount: count, path: path,
    msg: "起点、终点已记录，请在所需标注线位置单击第三点；随后自动生成。" };
  return { phase: "ready", pointCount: count, path: path, points: points,
    msg: three ? "三个点已就绪，正在生成尺寸标注。" : "两个端点已就绪，可以生成尺寸标注。" };
}

function _dimensionPickStatusResult(s, candidate, error) {
  var pairs = [["active", "b", true], ["token", "s", s.token], ["interaction", "s", _dimensionPickThree(s) ? "threeClick" : "twoPoint"],
    ["neededPoints", "n", _dimensionPickThree(s) ? 3 : 2], ["pointCount", "n", candidate.pointCount || 0],
    ["phase", "s", candidate.phase], ["autoPaused", "b", !!s.autoPaused], ["msg", "s", s.autoPaused ? s.lastError : candidate.msg]];
  if (error) pairs.push(["error", "s", error]);
  return _jsonObject(pairs);
}

function _dimensionPickRestore(s) {
  var failures = [];
  for (var i = 0; i < s.locks.length; i++) {
    try { s.locks[i].layer.locked = s.locks[i].locked; } catch (e) { failures.push("部分图层锁定状态未能恢复"); }
  }
  try { s.doc.activeLayer = s.activeLayer; } catch (layerError) { failures.push("活动图层未能恢复"); }
  try { s.doc.selection = s.selection; } catch (selectionError) { failures.push("选区未能恢复"); }
  // Restore partial anchors/handles last: layer, selection and tool changes can
  // otherwise promote the original path back to a whole-object selection.
  try { _dimensionRestorePointSelection(s.pointSelection); } catch (pointError) {}
  return failures.join("；");
}

function _dimensionPickCleanup(s, acceptedPath) {
  var retained = false, warning = "";
  try {
    s.layer.locked = false;
    if (acceptedPath && acceptedPath.parent === s.layer) {
      acceptedPath.locked = false;
      acceptedPath.remove();
    }
    if (s.marker && s.marker.parent === s.layer) {
      s.marker.locked = false;
      if (s.marker.pageItems.length === 0) s.marker.remove();
      else { s.marker.hidden = false; s.marker.note = ""; s.marker.name = "取点期间添加的图稿"; retained = true; }
    }
    if (s.layer.pageItems.length === 0 && s.layer.layers.length === 0) s.layer.remove();
    else { retained = true; s.layer.name = "尺寸取点 · 保留的额外图稿"; }
  } catch (e) { warning = "取点辅助内容未完全清理，请检查取点图层"; }
  // End native Pen input before restoring the user's precise anchor selection.
  // Selecting the black arrow afterwards can replace it with all path anchors.
  try { if (app.activeDocument === s.doc) app.selectTool("Adobe Select Tool"); } catch (toolError) {}
  var restoreWarning = _dimensionPickRestore(s);
  if (restoreWarning) warning += (warning ? "；" : "") + restoreWarning;
  if (retained) warning += (warning ? "；" : "") + "已保留取点层中的额外图稿";
  _dimensionPickSession = null;
  return warning;
}

function toolDimensionPickBegin(paramsJson) {
  if (_dimensionPickSession && _dimensionPickAlive(_dimensionPickSession)) return toolDimensionPickStatus();
  _dimensionPickSession = null;
  var s = null;
  try {
    if (!app.documents.length) return _jsonError("请先打开一个文档");
    var request = _parseParams(paramsJson);
    var interaction = _dimensionChoice(request.interaction, "twoPoint", ["twoPoint", "threeClick"], "取点方式");
    var settings = interaction === "threeClick" ? _dimensionPickSettings(request.settings) : null;
    var doc = app.activeDocument, selection = _dimensionSelection(doc);
    s = { doc: doc, token: String(_dimensionStamp()), selection: selection,
      pointSelection: _dimensionPointSelection(selection), activeLayer: doc.activeLayer, locks: [], layer: null, marker: null,
      interaction: interaction, settings: settings, finishing: false, autoPaused: false, lastError: "" };
    for (var i = 0; i < doc.layers.length; i++) s.locks.push({ layer: doc.layers[i], locked: doc.layers[i].locked });
    s.layer = doc.layers.add();
    s.layer.name = interaction === "threeClick" ? "尺寸取点 · 起点 → 终点 → 标注位置" : "尺寸取点 · 单击两个端点后返回面板";
    s.marker = s.layer.groupItems.add();
    s.marker.note = "AI_DESIGN_TOOLBOX_POINT_PICK_V1|" + s.token;
    s.marker.name = interaction === "threeClick" ? "三点取样标识" : "双点取样标识";
    s.marker.hidden = true; s.marker.locked = true;
    doc.selection = null;
    for (var k = 0; k < s.locks.length; k++) s.locks[k].layer.locked = true;
    doc.activeLayer = s.layer;
    var toolSelected = false;
    try { toolSelected = app.selectTool("Adobe Pen Tool") !== false; } catch (toolError) {}
    _dimensionPickSession = s;
    return _jsonObject([["active", "b", true], ["token", "s", s.token], ["toolSelected", "b", toolSelected],
      ["interaction", "s", interaction], ["neededPoints", "n", interaction === "threeClick" ? 3 : 2], ["pointCount", "n", 0], ["autoPaused", "b", false],
      ["phase", "s", interaction === "threeClick" ? "waitingStart" : "waiting"],
      ["msg", "s", (toolSelected ? "已切换钢笔工具。" : "请在 Illustrator 中按 P 切换钢笔工具。") +
        (interaction === "threeClick" ? "在画布上依次单击起点、终点、标注线位置，随后自动生成。" : "在画板上单击起点、终点，再返回面板生成。") + "其他图层暂时锁定，完成或取消后恢复。"]]);
  } catch (e) {
    if (s) { try { if (s.layer) { s.layer.locked = false; s.layer.remove(); } } catch (removeError) {} _dimensionPickRestore(s); }
    _dimensionPickSession = null;
    return _jsonError("无法开始取点：" + e.message);
  }
}

function toolDimensionPickStatus(token) {
  var s = _dimensionPickSession;
  if (!s || !_dimensionPickAlive(s)) { _dimensionPickSession = null; return _jsonObject([["active", "b", false], ["msg", "s", "未在取点"]]); }
  if (token && String(token) !== s.token) return _jsonError("取点会话已改变，请重新读取状态");
  try {
    var candidate = app.activeDocument === s.doc ? _dimensionPickCandidate(s) : { phase: "documentChanged", msg: "请切回开始取点的文档，或取消取点以恢复原图层。" };
    return _dimensionPickStatusResult(s, candidate);
  } catch (e) {
    return _dimensionPickStatusResult(s, { phase: "invalid", msg: "取点层已改变，请取消取点后重新开始。" });
  }
}

function toolDimensionPickPoll(token) {
  if (_dimensionPickLastResult && token && String(token) === _dimensionPickLastResult.token) return _dimensionPickLastResult.result;
  var status = toolDimensionPickStatus(token), data = _parseParams(status), s = _dimensionPickSession;
  if (data.error || !data.active || !s || !_dimensionPickThree(s) || s.autoPaused || s.finishing || data.phase !== "ready") return status;
  if (!token || String(token) !== s.token) return _jsonError("请提供当前取点会话标识");
  return toolDimensionPickFinish({ pickToken: s.token });
}

function toolDimensionPickFinish(paramsJson) {
  var s = null, ownsFinish = false;
  try {
    var p = _parseParams(paramsJson);
    if (_dimensionPickLastResult && p.pickToken && String(p.pickToken) === _dimensionPickLastResult.token) return _dimensionPickLastResult.result;
    s = _dimensionPickSession;
    if (!s || !_dimensionPickAlive(s)) { _dimensionPickSession = null; return _jsonError("取点会话已结束，请重新开始"); }
    if (!p.pickToken || String(p.pickToken) !== s.token) return _jsonError("取点会话不匹配，请重新读取状态");
    if (app.activeDocument !== s.doc) return _jsonError("请先切回开始取点的文档，避免标注到其他文档");
    if (s.finishing) return toolDimensionPickStatus(s.token);
    var candidate = _dimensionPickCandidate(s);
    if (candidate.phase !== "ready") return _jsonError(candidate.msg);
    s.finishing = true; ownsFinish = true; s.autoPaused = false; s.lastError = "";
    if (_dimensionPickThree(s)) {
      p = {};
      for (var key in s.settings) if (s.settings.hasOwnProperty(key)) p[key] = s.settings[key];
      var a = candidate.points[0], b = candidate.points[1], c = candidate.points[2];
      var dx = b[0] - a[0], dy = b[1] - a[1], length = Math.sqrt(dx * dx + dy * dy);
      var signedOffset = (c[0] - a[0]) * (-dy / length) + (c[1] - a[1]) * (dx / length);
      p.offset = Math.abs(signedOffset) * 25.4 / 72 * _dimensionPickScale(s.doc);
      if (!isFinite(p.offset) || p.offset > 10000) throw new Error("标注线位置距测量线超过 10000 mm，请调整第三点后重试");
      p.alignedSide = signedOffset < 0 ? "right" : "left";
    }
    p.mode = "points"; p.points = [candidate.points[0], candidate.points[1]];
    // Mouse input is complete. Restore original locks so existing output layers can be reused.
    // If rendering fails, protect the artwork again while the user corrects or cancels capture.
    var result, data, generated = false;
    try {
      for (var i = 0; i < s.locks.length; i++) s.locks[i].layer.locked = s.locks[i].locked;
      result = toolDimension(p); data = _parseParams(result);
      if (data.error) throw new Error(data.error);
      if (!data || !(Number(data.dimensionCount) > 0)) throw new Error("标注结果无效，已保留端点以便重试");
      generated = true;
    } finally {
      if (!generated) for (var k = 0; k < s.locks.length; k++) { try { s.locks[k].layer.locked = true; } catch (lockError) {} }
    }
    var cleanupWarning = _dimensionPickCleanup(s, candidate.path);
    var warnings = (data.warnings || "") + (cleanupWarning ? "\n" + cleanupWarning : "");
    var completed = _jsonObject([["active", "b", false], ["completed", "b", true], ["token", "s", s.token],
      ["count", "n", data.count], ["dimensionCount", "n", data.dimensionCount], ["warnings", "s", warnings.replace(/^\n/, "")], ["picking", "b", false]]);
    _dimensionPickLastResult = { token: s.token, result: completed };
    return completed;
  } catch (e) {
    var message = "取点标注失败：" + e.message + "。可以重试或取消取点。";
    if (s && ownsFinish && _dimensionPickThree(s)) {
      s.autoPaused = true; s.lastError = message;
      return _dimensionPickStatusResult(s, { phase: "ready", pointCount: 3 }, message);
    }
    return _jsonError(message);
  } finally { if (s && ownsFinish) s.finishing = false; }
}

function toolDimensionPickCancel(token) {
  var s = _dimensionPickSession;
  if (!s || !_dimensionPickAlive(s)) { _dimensionPickSession = null; return _jsonObject([["active", "b", false], ["msg", "s", "取点已结束"]]); }
  if (token && String(token) !== s.token) return _jsonError("取点会话已改变，未清理其他会话的内容");
  if (s.finishing) return toolDimensionPickStatus(s.token);
  var candidate = null;
  try { candidate = _dimensionPickCandidate(s); } catch (e) {}
  // Only discard the single simple helper path. Unexpected art stays in the document.
  var path = candidate && (candidate.phase === "ready" || candidate.phase === "waiting" || candidate.phase === "waitingStart" ||
    candidate.phase === "waitingEnd" || candidate.phase === "waitingPlacement") ? candidate.path : null;
  var warning = _dimensionPickCleanup(s, path);
  return _jsonObject([["active", "b", false], ["msg", "s", "已取消取点并恢复图层" + (warning ? "；" + warning : "")]]);
}
