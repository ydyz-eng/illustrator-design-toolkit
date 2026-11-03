/**
 * AI 设计工具箱 — JSX 后端
 *
 * 所有函数由前端通过 CSInterface.evalScript() 调用。
 * 返回值统一用 JSON 字符串，前端 JSON.parse() 解析。
 *
 * 新增工具：在此文件末尾追加函数即可。
 */


// ══════════════════════════════════════════════════════
//  CEP 安全 JSON 返回工具
//  ExtendScript 某些环境中 JSON.stringify 不稳定，所以全部手动拼接。
// ══════════════════════════════════════════════════════
function _escJson(v) {
  if (v === null || v === undefined) return "";
  v = String(v);
  v = v.replace(/\\/g, "\\\\");
  v = v.replace(/\"/g, "\\\"");
  v = v.replace(/\r/g, "\\r");
  v = v.replace(/\n/g, "\\n");
  v = v.replace(/\t/g, "\\t");
  v = v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, function (ch) {
    return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
  });
  return v;
}

function _jsonString(v) {
  return "\"" + _escJson(v) + "\"";
}

function _jsonNumber(v) {
  if (typeof v !== "number" || isNaN(v) || !isFinite(v)) return "0";
  return String(v);
}

function _jsonBool(v) {
  return v ? "true" : "false";
}

function _jsonObject(pairs) {
  var arr = [];
  for (var i = 0; i < pairs.length; i++) {
    var key = pairs[i][0];
    var type = pairs[i][1];
    var val = pairs[i][2];
    var s;
    if (type === "n") s = _jsonNumber(val);
    else if (type === "b") s = _jsonBool(val);
    else s = _jsonString(val);
    arr.push(_jsonString(key) + ":" + s);
  }
  return "{" + arr.join(",") + "}";
}

function _jsonError(msg) {
  return _jsonObject([["error", "s", msg]]);
}

// 将当前文档另存为 Illustrator 3 格式。
function toolSaveAsAI3() {
  try {
    if (app.documents.length === 0) return _jsonError("请先打开一个 Illustrator 文件");
    var doc = app.activeDocument;
    var sourceFile;
    try {
      sourceFile = doc.fullName;
      if (!sourceFile || !sourceFile.exists) throw new Error("文件未保存");
    } catch (e) {
      return _jsonError("请先保存当前文件，再另存为 AI3");
    }
    // name 是 URI 编码，使用系统路径取文件名，保留中文、# 和百分号。
    var baseName = sourceFile.fsName.replace(/^.*[\\\/]/, "").replace(/\.[^.]+$/, "");
    var targetFile = new File(sourceFile.parent.fsName + "/" + baseName + "_AI3.ai");
    if (targetFile.exists && !confirm("目标文件已存在，是否覆盖？\n" + targetFile.fsName)) {
      return _jsonObject([["cancelled", "b", true]]);
    }
    var options = new IllustratorSaveOptions();
    options.compatibility = Compatibility.ILLUSTRATOR3;
    options.flattenOutput = OutputFlattening.PRESERVEAPPEARANCE;
    options.saveMultipleArtboards = false;
    doc.saveAs(targetFile, options);
    return _jsonObject([["path", "s", targetFile.fsName]]);
  } catch (err) {
    return _jsonError("另存为 AI3 失败：" + (err.message || err));
  }
}

function _parseParams(str) {
  if (!str) return {};
  if (typeof str !== "string") return str;
  try {
    if (typeof JSON !== "undefined" && JSON.parse) {
      return JSON.parse(str);
    }
  } catch (e) {
    // Older ExtendScript hosts may expose partial JSON support; keep eval as fallback.
  }
  try {
    return eval("(" + str + ")");
  } catch (e2) {
    return {};
  }
}

// 表单空值、null、无穷值不能静默转换成有效绘图参数。
function _toolNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean" ||
      (typeof value === "string" && /^\s*$/.test(value))) return NaN;
  var number = Number(value);
  return isFinite(number) ? number : NaN;
}

function _toolContainsItem(container, item) {
  while (item && item.typename !== "Document") {
    if (item === container) return true;
    item = item.parent;
  }
  return false;
}

// ══════════════════════════════════════════════════════
//  工具 1：计算线长 + 统计孔洞
// ══════════════════════════════════════════════════════
function toolLineLength(unit) {
  try {
    if (app.documents.length === 0)
      return _jsonError("请先打开一个文档");

    var selection = app.activeDocument.selection;
    if (!selection || selection.length === 0)
      return _jsonError("请先选中路径对象");

    var totalPt = 0;
    var pathCount = 0;
    var compoundCount = 0;
    var allPaths = [];
    var visited = [];
    var closedCount = 0;
    var openCount = 0;
    var skippedCount = 0;

    function collectPaths(item) {
      if (!item) return;
      for (var vi = 0; vi < visited.length; vi++) if (visited[vi] === item) return;
      visited.push(item);
      if (item.hidden || item.locked || item.guides || item.clipping) { skippedCount++; return; }
      if (item.typename === "PathItem") {
        var pathLength = Number(item.length);
        if (!isFinite(pathLength) || pathLength < 0) { skippedCount++; return; }
        allPaths.push(item);
        totalPt += pathLength;
        pathCount++;
        if (item.closed) closedCount++;
        else openCount++;
      } else if (item.typename === "CompoundPathItem") {
        compoundCount++;
        for (var i = 0; i < item.pathItems.length; i++)
          collectPaths(item.pathItems[i]);
      } else if (item.typename === "GroupItem") {
        for (var j = 0; j < item.pageItems.length; j++)
          collectPaths(item.pageItems[j]);
      }
    }

    for (var s = 0; s < selection.length; s++) collectPaths(selection[s]);

    if (pathCount === 0)
      return _jsonError("没有找到可计算的路径");

    // 加工轮廓按闭合路径的奇偶嵌套统计；开放线条只累计线长。
    // 贝塞尔曲线展开为 0.05 pt 容差的折线，再检查真实包含关系。
    // 仅用包围框会把凹形缺口中的对象、相交轮廓误算成孔洞。
    var infos = [];
    for (var p = 0; p < allPaths.length; p++) {
      if (!allPaths[p].closed) continue;
      var polygon = _llFlattenPath(allPaths[p]);
      if (polygon.length >= 3) infos.push({ polygon: polygon, bounds: allPaths[p].geometricBounds });
    }
    var outerCount = 0;
    var innerCount = 0;
    var islandCount = 0;
    for (var i = 0; i < infos.length; i++) {
      var depth = 0;
      for (var j = 0; j < infos.length; j++) {
        if (i !== j && _llContainsContour(infos[j], infos[i])) depth++;
      }
      if (depth === 0) outerCount++;
      else if (depth % 2 === 1) innerCount++;
      else islandCount++;
    }

    var documentScale = 1;
    try { if (Number(app.activeDocument.scaleFactor) > 0) documentScale = Number(app.activeDocument.scaleFactor); } catch (scaleError) {}
    totalPt *= documentScale;
    var lengthMm = totalPt * 25.4 / 72;
    var lengthStr;
    if (unit === "mm")      lengthStr = (totalPt / 2.83464567).toFixed(3) + " mm";
    else if (unit === "in") lengthStr = (totalPt / 72).toFixed(4) + " in";
    else                    lengthStr = totalPt.toFixed(2) + " pt";

    return _jsonObject([
      ["pathCount", "n", pathCount],
      ["compoundCount", "n", compoundCount],
      ["outerCount", "n", outerCount],
      ["innerCount", "n", innerCount],
      ["openCount", "n", openCount],
      ["closedCount", "n", closedCount],
      ["islandCount", "n", islandCount],
      ["skippedCount", "n", skippedCount],
      ["length", "s", lengthStr],
      ["lengthMm", "n", lengthMm]
    ]);

  } catch (e) {
    return _jsonError("错误：" + e.message);
  }
}

function _llFlattenPath(path) {
  var pts = path.pathPoints;
  var result = [];
  if (!pts || pts.length < 2) return result;
  function midpoint(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  function distanceToSegment(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var lengthSq = dx * dx + dy * dy;
    var t = lengthSq ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq : 0;
    t = Math.max(0, Math.min(1, t));
    var x = p[0] - a[0] - t * dx, y = p[1] - a[1] - t * dy;
    return Math.sqrt(x * x + y * y);
  }
  function flatten(a, b, c, d, depth) {
    if (depth >= 12 || (distanceToSegment(b, a, d) <= 0.05 && distanceToSegment(c, a, d) <= 0.05)) {
      result.push([d[0], d[1]]);
      return;
    }
    var ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
    var abc = midpoint(ab, bc), bcd = midpoint(bc, cd), mid = midpoint(abc, bcd);
    flatten(a, ab, abc, mid, depth + 1);
    flatten(mid, bcd, cd, d, depth + 1);
  }
  result.push([pts[0].anchor[0], pts[0].anchor[1]]);
  for (var i = 0; i < pts.length; i++) {
    var next = pts[(i + 1) % pts.length];
    flatten(pts[i].anchor, pts[i].rightDirection, next.leftDirection, next.anchor, 0);
  }
  result.pop(); // 闭合终点与起点重合。
  return result;
}

function _llContainsContour(outer, inner) {
  var a = outer.bounds, b = inner.bounds, eps = 0.001;
  if (a[0] > b[0] || a[1] < b[1] || a[2] < b[2] || a[3] > b[3]) return false;
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]) return false;
  var op = outer.polygon, ip = inner.polygon;
  function cross(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
  function onSegment(p, a, b) {
    return Math.abs(cross(a, b, p)) <= eps && p[0] >= Math.min(a[0], b[0]) - eps &&
      p[0] <= Math.max(a[0], b[0]) + eps && p[1] >= Math.min(a[1], b[1]) - eps && p[1] <= Math.max(a[1], b[1]) + eps;
  }
  function inside(p) {
    var hit = false;
    for (var i = 0, j = op.length - 1; i < op.length; j = i++) {
      if (onSegment(p, op[j], op[i])) return false;
      if ((op[i][1] > p[1]) !== (op[j][1] > p[1]) &&
          p[0] < (op[j][0] - op[i][0]) * (p[1] - op[i][1]) / (op[j][1] - op[i][1]) + op[i][0]) hit = !hit;
    }
    return hit;
  }
  for (var k = 0; k < ip.length; k++) {
    if (!inside(ip[k])) return false;
    var p1 = ip[k], p2 = ip[(k + 1) % ip.length];
    for (var n = 0; n < op.length; n++) {
      var q1 = op[n], q2 = op[(n + 1) % op.length];
      var c1 = cross(p1, p2, q1), c2 = cross(p1, p2, q2);
      var c3 = cross(q1, q2, p1), c4 = cross(q1, q2, p2);
      if ((c1 * c2 < 0 && c3 * c4 < 0) || onSegment(q1, p1, p2) || onSegment(q2, p1, p2)) return false;
    }
  }
  return true;
}


// ══════════════════════════════════════════════════════
//  工具 2：尺寸标注
// ══════════════════════════════════════════════════════
function toolDimension(paramsJson) {
  var doc = null, previousLayer = null, previousSelection = null, previousPointSelection = null;
  var layer = null, batch = null, createdLayer = false;
  try {
    if (app.documents.length === 0) return _jsonError("请先打开一个文档");
    doc = app.activeDocument;
    previousLayer = doc.activeLayer;
    // 创建图层、路径或文字都可能改变 Illustrator 的实时 selection，必须预先快照。
    previousSelection = _dimensionSelection(doc);
    previousPointSelection = _dimensionPointSelection(previousSelection);
    var p = _parseParams(paramsJson);
    var mode = _dimensionChoice(p.mode, "each", ["each", "overall", "gap", "artboard", "aligned", "points"], "标注范围");
    var isAligned = mode === "aligned" || mode === "points";
    var alignedSide = isAligned ? _dimensionChoice(p.alignedSide, "auto", ["auto", "left", "right"], "斜边标注方向") : "auto";
    var unit = _dimensionChoice(p.unit, "mm", ["mm", "cm", "in", "pt", "px"], "单位");
    var decimals = _dimensionNumber(p.decimals, 2, 0, 4, "小数位数");
    if (decimals !== Math.floor(decimals)) throw new Error("小数位数必须是 0 到 4 的整数");
    var hostScale = 1;
    try { hostScale = Number(doc.scaleFactor); } catch (scaleError) {}
    if (!isFinite(hostScale) || hostScale <= 0) hostScale = 1;
    var mm = 72 / 25.4 / hostScale;
    var offset = _dimensionNumber(p.offset, 8, 0, 10000, "偏移距离") * mm;
    var fontSize = _dimensionNumber(p.fontSize, 10, 1, 1000, "字号") / hostScale;
    var arrow = _dimensionNumber(p.arrow, 2, 0, 100, "箭头大小") * mm;
    var stroke = _dimensionNumber(p.strokeWidth, 0.75, 0.05, 100, "线宽") / hostScale;
    var gap = _dimensionNumber(p.extensionGap, 1, 0, 1000, "延长线起始间隙") * mm;
    var overshoot = _dimensionNumber(p.extensionOvershoot, 2, 0, 1000, "延长线超出量") * mm;
    var scale = _dimensionNumber(p.scale, 1, 0.000001, 1000000, "标注倍率");
    var widthPosition = _dimensionChoice(p.widthPosition, "bottom", ["top", "bottom"], "宽度标注位置");
    var heightPosition = _dimensionChoice(p.heightPosition, "right", ["right", "left"], "高度标注位置");
    var boundsMode = isAligned ? "geometric" : _dimensionChoice(p.bounds, "geometric", ["geometric", "visible"], "边界类型");
    var arrowStyle = _dimensionChoice(p.arrowStyle, "filled", ["filled", "open", "tick", "none"], "箭头样式");
    var doWidth = p.doWidth !== false, doHeight = p.doHeight !== false;
    if (!isAligned && !doWidth && !doHeight) throw new Error("请至少勾选宽度或高度");
    var prefix = p.prefix === undefined ? "" : String(p.prefix);
    var suffix = p.suffix === undefined ? "" : String(p.suffix);
    if (prefix.length > 80 || suffix.length > 80 || /[\r\n]/.test(prefix + suffix))
      throw new Error("前后缀限 80 个字符，且不能包含换行");
    var color = _dimensionColor(p.color || "black", p.customColor);
    var warnings = [], targets = [], jobs = [];
    var epsilon = 0.00001 / hostScale;
    var i, j, b, ignored = 0;

    if (isAligned) {
      var paths = _dimensionPaths(previousSelection);
      if (mode === "points") {
        var picked = p.points === undefined ? _dimensionSelectedPoints(paths) : p.points;
        if (!picked || picked.length !== 2) throw new Error("任意标注需要两个点：请点选两点，或用直接选择工具恰好选中两个锚点");
        addAligned(_dimensionCoordinate(picked[0]), _dimensionCoordinate(picked[1]), alignedSide === "right" ? -1 : 1);
        if (!jobs.length) throw new Error("两个标注点重合，请选择不同的点");
        targets.push(null);
      } else {
        for (i = 0; i < paths.length; i++) {
          var edgePath = paths[i], pathPoints = edgePath.pathPoints, selectedAnchors = 0, selectedHandles = false;
          for (j = 0; j < pathPoints.length; j++) {
            if (_dimensionAnchorSelected(pathPoints[j])) selectedAnchors++;
            else if (_dimensionHandleSelected(pathPoints[j])) selectedHandles = true;
          }
          var partial = (selectedAnchors > 0 && selectedAnchors < pathPoints.length) || selectedHandles;
          var side = alignedSide === "right" ? -1 : 1;
          if (alignedSide === "auto" && edgePath.closed && _dimensionPathArea(pathPoints) > 0) side = -1;
          var before = jobs.length, edgeCount = edgePath.closed ? pathPoints.length : pathPoints.length - 1;
          for (j = 0; j < edgeCount; j++) {
            var pa = pathPoints[j], pb = pathPoints[(j + 1) % pathPoints.length];
            if (partial && (!_dimensionAnchorSelected(pa) || !_dimensionAnchorSelected(pb))) continue;
            if (!_dimensionStraightEdge(pa, pb, epsilon)) { ignored++; continue; }
            if (!addAligned(_dimensionCoordinate(pa.anchor), _dimensionCoordinate(pb.anchor), side)) ignored++;
          }
          if (jobs.length > before) targets.push(edgePath);
        }
        if (ignored) warnings.push("已跳过 " + ignored + " 段曲线或零长度边");
        if (!jobs.length) throw new Error("选区中没有可标注的直线边；局部选点时请选中同一条直边的两个端点");
      }
    } else if (mode === "artboard") {
      targets.push(_dimensionNormalizeBounds(doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect));
    } else {
      if (!previousSelection || !previousSelection.length) throw new Error("请先选中需要标注的对象");
      for (i = 0; i < previousSelection.length; i++) {
        var item = previousSelection[i];
        if (!item || item.typename === "TextRange") throw new Error("请退出文字编辑，使用选择工具选中文本对象后重试");
        if (_dimensionOwnedAncestor(item)) { ignored++; continue; }
        var isChild = false, parent = item.parent;
        while (parent && parent.typename !== "Document") {
          for (j = 0; j < previousSelection.length; j++) {
            if (previousSelection[j] === parent) { isChild = true; break; }
          }
          if (isChild) break;
          parent = parent.parent;
        }
        if (isChild) continue;
        b = _dimensionBounds(item, boundsMode);
        if (!b) { ignored++; continue; }
        targets.push(b);
      }
      if (ignored) warnings.push("已跳过 " + ignored + " 个已有标注、隐藏对象或无法测量的对象");
      if (!targets.length) throw new Error("选区中没有可标注的对象");
      if (mode === "gap" && targets.length !== 2) throw new Error("间距标注需要恰好选中两个对象或群组");
    }

    var count = targets.length;
    if (mode === "overall") {
      b = targets[0];
      for (i = 1; i < targets.length; i++) b = _dimensionUnion(b, targets[i]);
      targets = [b];
    }

    function addWidth(left, right, y1, y2, lineY) {
      if (right - left <= epsilon) return false;
      jobs.push({ horizontal: true, a: left, b: right, sourceA: y1, sourceB: y2, line: lineY, side: widthPosition === "top" ? 1 : -1 });
      return true;
    }
    function addHeight(bottom, top, x1, x2, lineX) {
      if (top - bottom <= epsilon) return false;
      jobs.push({ horizontal: false, a: bottom, b: top, sourceA: x1, sourceB: x2, line: lineX, side: heightPosition === "right" ? 1 : -1 });
      return true;
    }
    function addAligned(start, end, side) {
      var dx = end[0] - start[0], dy = end[1] - start[1];
      var length = Math.sqrt(dx * dx + dy * dy);
      if (!isFinite(length)) throw new Error("标注点坐标超出可测量范围");
      if (length <= epsilon) return false;
      var tx = dx / length, ty = dy / length;
      var angle = Math.atan2(ty, tx) * 180 / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      jobs.push({ aligned: true, origin: start, tangent: [tx, ty], normal: [-ty, tx], angle: angle,
        a: 0, b: length, sourceA: 0, sourceB: 0, line: side * offset, side: side });
      return true;
    }

    if (isAligned) {
      // 斜边和任意两点已在对象解析阶段生成局部坐标系中的标注任务。
    } else if (mode === "gap") {
      var one = targets[0], two = targets[1], low, high;
      if (doWidth) {
        low = one[0] < two[0] ? one : two;
        high = low === one ? two : one;
        var y1 = widthPosition === "top" ? low[1] : low[3];
        var y2 = widthPosition === "top" ? high[1] : high[3];
        var lineY = widthPosition === "top" ? Math.max(y1, y2) + offset : Math.min(y1, y2) - offset;
        if (!addWidth(low[2], high[0], y1, y2, lineY)) warnings.push("水平方向重叠或相接，已跳过水平间距");
      }
      if (doHeight) {
        low = one[3] < two[3] ? one : two;
        high = low === one ? two : one;
        var x1 = heightPosition === "right" ? low[2] : low[0];
        var x2 = heightPosition === "right" ? high[2] : high[0];
        var lineX = heightPosition === "right" ? Math.max(x1, x2) + offset : Math.min(x1, x2) - offset;
        if (!addHeight(low[1], high[3], x1, x2, lineX)) warnings.push("垂直方向重叠或相接，已跳过垂直间距");
      }
      if (!jobs.length) throw new Error("两个对象在所选方向上重叠或相接，没有正间距可标注");
    } else {
      for (i = 0; i < targets.length; i++) {
        b = targets[i];
        if (doWidth) {
          var edgeY = widthPosition === "top" ? b[1] : b[3];
          if (!addWidth(b[0], b[2], edgeY, edgeY, edgeY + (widthPosition === "top" ? offset : -offset)))
            warnings.push("第 " + (i + 1) + " 个对象宽度为零，已跳过宽度标注");
        }
        if (doHeight) {
          var edgeX = heightPosition === "right" ? b[2] : b[0];
          if (!addHeight(b[3], b[1], edgeX, edgeX, edgeX + (heightPosition === "right" ? offset : -offset)))
            warnings.push("第 " + (i + 1) + " 个对象高度为零，已跳过高度标注");
        }
      }
      if (!jobs.length) throw new Error("所选方向的尺寸为零，没有可生成的标注");
    }

    // 图层名称不能证明所有权；只有本工具写入的 note 标记才可用于复用/清理。
    layer = _dimensionFindLayer(doc.layers);
    if (!layer) {
      layer = doc.layers.add();
      createdLayer = true;
      layer.name = "尺寸标注 · AI设计工具箱";
      var marker = layer.groupItems.add();
      marker.name = "AI设计工具箱 · 标注图层标识";
      marker.note = "AI_DESIGN_TOOLBOX_DIMENSION_V1|layer";
      marker.hidden = true;
      marker.locked = true;
    }
    batch = layer.groupItems.add();
    batch.name = "尺寸标注 · " + jobs.length + " 处";
    batch.note = "AI_DESIGN_TOOLBOX_DIMENSION_V1|batch|" + _dimensionStamp();

    function labelFor(length) {
      var value = length * hostScale * scale;
      if (unit === "mm") value *= 25.4 / 72;
      else if (unit === "cm") value *= 2.54 / 72;
      else if (unit === "in") value /= 72;
      var label = value.toFixed(decimals);
      if (p.trimZeros !== false && label.indexOf(".") >= 0) label = label.replace(/0+$/, "").replace(/\.$/, "");
      return prefix + label + (p.showUnit === false ? "" : " " + unit) + suffix;
    }
    function path(group, points, closed, filled) {
      var result = group.pathItems.add();
      result.setEntirePath(points);
      result.closed = !!closed;
      result.filled = !!filled;
      result.stroked = !filled;
      if (filled) result.fillColor = color;
      else { result.strokeWidth = stroke; result.strokeColor = color; result.strokeDashes = []; }
      return result;
    }
    function point(job, along, across) {
      if (job.aligned) return [job.origin[0] + job.tangent[0] * along + job.normal[0] * across,
        job.origin[1] + job.tangent[1] * along + job.normal[1] * across];
      return job.horizontal ? [along, across] : [across, along];
    }
    function segment(group, job, from, to) {
      if (to - from > epsilon) path(group, [point(job, from, job.line), point(job, to, job.line)], false, false);
    }
    function extension(group, job, along, source) {
      var direction = job.line >= source ? 1 : -1;
      if (Math.abs(job.line - source) <= epsilon) direction = job.side;
      var start = source + direction * Math.min(gap, Math.abs(job.line - source));
      var end = job.line + direction * overshoot;
      if (Math.abs(end - start) > epsilon) path(group, [point(job, along, start), point(job, along, end)], false, false);
    }
    function arrowAt(group, job, along, direction) {
      if (arrowStyle === "none" || arrow <= epsilon) return;
      if (arrowStyle === "tick") {
        path(group, [point(job, along - arrow * 0.4, job.line - arrow * 0.4), point(job, along + arrow * 0.4, job.line + arrow * 0.4)], false, false);
        return;
      }
      var tip = point(job, along, job.line);
      var wingA = point(job, along - direction * arrow, job.line - arrow * 0.32);
      var wingB = point(job, along - direction * arrow, job.line + arrow * 0.32);
      if (arrowStyle === "open") path(group, [wingA, tip, wingB], false, false);
      else path(group, [tip, wingA, wingB], true, true);
    }
    function placeText(text, cx, cy) {
      var tb = text.geometricBounds;
      text.translate(cx - (tb[0] + tb[2]) / 2, cy - (tb[1] + tb[3]) / 2);
    }
    for (i = 0; i < jobs.length; i++) {
      var job = jobs[i], span = job.b - job.a;
      var group = batch.groupItems.add();
      group.name = (job.aligned ? "斜边 / 两点距离 " : (job.horizontal ? "宽度 / 水平间距 " : "高度 / 垂直间距 ")) + labelFor(span);
      var textItem = group.textFrames.add();
      textItem.contents = labelFor(span);
      textItem.textRange.characterAttributes.size = fontSize;
      textItem.textRange.characterAttributes.fillColor = color;
      textItem.textRange.characterAttributes.strokeWeight = 0;
      // 必须先测量未旋转文字：旋转后的轴对齐包围盒不能代表沿斜边的字宽。
      var tb = textItem.geometricBounds;
      var labelSpan = Math.abs(tb[2] - tb[0]);
      var labelThickness = Math.abs(tb[1] - tb[3]);
      var textAngle = job.aligned ? job.angle : (job.horizontal ? 0 : 90);
      if (textAngle) textItem.rotate(textAngle);
      var padding = Math.max(fontSize * 0.3, stroke * 2);
      var arrowReserve = arrowStyle === "none" ? 0 : arrow;
      var fits = span > labelSpan + padding * 2 + arrowReserve * 2;
      var middle = (job.a + job.b) / 2;
      var textAcross = fits ? job.line : job.line + job.side * (labelThickness / 2 + padding);
      var center = point(job, middle, textAcross);
      placeText(textItem, center[0], center[1]);
      extension(group, job, job.a, job.sourceA);
      extension(group, job, job.b, job.sourceB);
      if (fits) {
        segment(group, job, job.a, middle - labelSpan / 2 - padding);
        segment(group, job, middle + labelSpan / 2 + padding, job.b);
      } else {
        var tail = arrowStyle === "filled" || arrowStyle === "open" ? arrow * 1.35 : 0;
        segment(group, job, job.a - tail, job.b + tail);
      }
      // 尖端始终位于实际边界：空间充足时箭身在内，短尺寸时将箭身移到界外。
      arrowAt(group, job, job.a, fits ? -1 : 1);
      arrowAt(group, job, job.b, fits ? 1 : -1);
    }
    if (hostScale !== 1) warnings.push("已按 Illustrator 大画布倍率 " + hostScale + " 自动换算");
    return _jsonObject([["count", "n", count], ["dimensionCount", "n", jobs.length], ["warnings", "s", warnings.join("\n")]]);
  } catch (e) {
    // 本次生成失败时只回滚本次批次，之前的标注和用户图形保持完整。
    try { if (batch) batch.remove(); } catch (removeError) {}
    try { if (createdLayer && layer) layer.remove(); } catch (layerError) {}
    return _jsonError("尺寸标注失败：" + e.message);
  } finally {
    _dimensionRestore(doc, previousLayer, previousSelection);
    _dimensionRestorePointSelection(previousPointSelection);
  }
}

// 尺寸 API 的距离参数使用 mm，字号/线宽使用 pt；px 遵循 Illustrator 的 1 px = 1 pt。
// scale 只影响标签数值。aligned 使用直线边端点；points 使用原始文档 pt 坐标，均测量欧氏距离。
function _dimensionNumber(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === "") return fallback;
  var n = Number(value);
  if (!isFinite(n) || n < min || n > max) throw new Error(label + "必须为 " + min + " 到 " + max + " 之间的数字");
  return n;
}

function _dimensionChoice(value, fallback, choices, label) {
  if (value === undefined || value === null || value === "") return fallback;
  for (var i = 0; i < choices.length; i++) if (choices[i] === value) return value;
  throw new Error("无效的" + label);
}

function _dimensionColor(value, custom) {
  var rgb = { black: [0, 0, 0], red: [225, 48, 58], blue: [34, 110, 220], gray: [120, 120, 120] };
  var channels = rgb[value];
  if (value === "custom") {
    var hex = String(custom || "").replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error("自定义颜色请输入 #RRGGBB 格式的十六进制色值");
    channels = [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
  }
  if (!channels || channels.length !== 3) throw new Error("无效的标注颜色");
  var color = new RGBColor();
  color.red = channels[0]; color.green = channels[1]; color.blue = channels[2];
  return color;
}

function _dimensionSelection(doc) {
  var current = doc.selection, snapshot = [];
  if (current && current.typename === "TextRange") throw new Error("请退出文字编辑，使用选择工具选中文本对象后重试");
  if (current) for (var i = 0; i < current.length; i++) snapshot.push(current[i]);
  return snapshot;
}

function _dimensionRestore(doc, layer, selection) {
  if (!doc) return;
  try { if (selection !== null) doc.selection = selection; } catch (e) {}
  try { if (layer) doc.activeLayer = layer; } catch (e2) {}
}

// doc.selection 赋值可能把局部选择改为整条路径选择，须另存每个锚点及手柄的选择状态。
function _dimensionPointSelection(selection) {
  var snapshot = [], seen = [];
  function visit(item) {
    if (!item) return;
    for (var s = 0; s < seen.length; s++) if (seen[s] === item) return;
    seen.push(item);
    try {
      if (item.typename === "PathItem" && item.pathPoints) {
        for (var i = 0; i < item.pathPoints.length; i++) {
          var point = item.pathPoints[i];
          if (point.selected !== undefined) snapshot.push({ point: point, selected: point.selected });
        }
      } else {
        var children = item.typename === "CompoundPathItem" ? item.pathItems : item.pageItems;
        if (children) for (var j = 0; j < children.length; j++) if (children[j].parent === item) visit(children[j]);
      }
    } catch (e) {}
  }
  if (selection) for (var i = 0; i < selection.length; i++) visit(selection[i]);
  return snapshot;
}

function _dimensionRestorePointSelection(snapshot) {
  if (!snapshot) return;
  for (var i = 0; i < snapshot.length; i++) {
    try { snapshot[i].point.selected = snapshot[i].selected; } catch (e) {}
  }
}

function _dimensionAnchorSelected(point) {
  if (typeof PathPointSelection === "undefined") return false;
  return point.selected === PathPointSelection.ANCHORPOINT;
}

function _dimensionHandleSelected(point) {
  if (typeof PathPointSelection === "undefined" || point.selected === undefined) return false;
  return point.selected !== PathPointSelection.NOSELECTION && point.selected !== PathPointSelection.ANCHORPOINT;
}

function _dimensionCoordinate(point) {
  if (!point || point.length !== 2 || typeof point[0] !== "number" || typeof point[1] !== "number" ||
      !isFinite(point[0]) || !isFinite(point[1])) throw new Error("标注点必须是两个有效的文档坐标数值");
  return [point[0], point[1]];
}

function _dimensionIsMask(item) {
  if (item.typename === "PathItem") return !!item.clipping;
  if (item.typename === "CompoundPathItem") {
    for (var i = 0; i < item.pathItems.length; i++) if (item.pathItems[i].clipping) return true;
  }
  return false;
}

function _dimensionPathVisible(item) {
  var child = null;
  while (item && item.typename !== "Document") {
    if (item.hidden || item.guides || (item.typename === "Layer" && item.visible === false) || _dimensionOwnedAncestor(item)) return false;
    // 剪切群组仅标注蒙版边界，避免将被遮住的子对象边缘作为可见直边。
    if (item.typename === "GroupItem" && item.clipped && child && !_dimensionIsMask(child)) return false;
    child = item;
    item = item.parent;
  }
  return true;
}

function _dimensionPaths(selection) {
  var result = [];
  function visit(item) {
    if (!item || !_dimensionPathVisible(item)) return;
    if (item.typename === "PathItem") {
      if (!item.pathPoints || item.pathPoints.length < 2) return;
      for (var p = 0; p < result.length; p++) if (result[p] === item) return;
      result.push(item);
    } else if (item.typename === "CompoundPathItem") {
      for (var c = 0; c < item.pathItems.length; c++) visit(item.pathItems[c]);
    } else if (item.typename === "GroupItem") {
      for (var i = 0; i < item.pageItems.length; i++) {
        var child = item.pageItems[i];
        if (child.parent !== item || (item.clipped && !_dimensionIsMask(child))) continue;
        visit(child);
      }
    }
  }
  if (selection) for (var i = 0; i < selection.length; i++) visit(selection[i]);
  return result;
}

function _dimensionSelectedPoints(paths) {
  var points = [];
  for (var i = 0; i < paths.length; i++) {
    for (var j = 0; j < paths[i].pathPoints.length; j++) {
      if (_dimensionAnchorSelected(paths[i].pathPoints[j])) points.push(paths[i].pathPoints[j].anchor);
    }
  }
  // 群组选中时宿主可能未标记锚点；单独的两点线仍可作为一次两点测量。
  if (!points.length && paths.length === 1 && paths[0].pathPoints.length === 2 &&
      !_dimensionHandleSelected(paths[0].pathPoints[0]) && !_dimensionHandleSelected(paths[0].pathPoints[1]))
    return [paths[0].pathPoints[0].anchor, paths[0].pathPoints[1].anchor];
  return points;
}

function _dimensionPathArea(points) {
  // 平移到首个锚点计算，降低大坐标文档中鞋带公式的相消误差。
  var area = 0, origin = points[0].anchor;
  for (var i = 0; i < points.length; i++) {
    var a = points[i].anchor, b = points[(i + 1) % points.length].anchor;
    area += (a[0] - origin[0]) * (b[1] - origin[1]) - (b[0] - origin[0]) * (a[1] - origin[1]);
  }
  return area / 2;
}

function _dimensionStraightEdge(a, b, epsilon) {
  var start = _dimensionCoordinate(a.anchor), end = _dimensionCoordinate(b.anchor);
  var dx = end[0] - start[0], dy = end[1] - start[1], squared = dx * dx + dy * dy;
  if (squared <= epsilon * epsilon) return true; // 由调用者统计并跳过零长度段。
  var length = Math.sqrt(squared), controls = [a.rightDirection || start, b.leftDirection || end];
  for (var i = 0; i < controls.length; i++) {
    var handle = _dimensionCoordinate(controls[i]), hx = handle[0] - start[0], hy = handle[1] - start[1];
    if (Math.abs(dx * hy - dy * hx) > epsilon * length) return false;
    var projection = (dx * hx + dy * hy) / squared;
    if (projection < -epsilon / length || projection > 1 + epsilon / length) return false;
  }
  return true;
}

function _dimensionMarker(item) {
  try { return String(item.note || ""); } catch (e) { return ""; }
}

function _dimensionStamp() {
  var stamp = Math.max(new Date().getTime(), (_dimensionStamp.last || 0) + 1);
  _dimensionStamp.last = stamp;
  return stamp;
}

function _dimensionOwnedAncestor(item) {
  while (item && item.typename !== "Document") {
    var note = _dimensionMarker(item);
    if (note === "AI_DESIGN_TOOLBOX_DIMENSION_V1|layer" || /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|[0-9]+$/.test(note)) return true;
    item = item.parent;
  }
  return false;
}

function _dimensionFindLayer(layers) {
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i];
    if (layer.locked || !layer.visible) continue;
    for (var j = 0; j < layer.groupItems.length; j++) {
      var group = layer.groupItems[j];
      if (group.parent === layer && (_dimensionMarker(group) === "AI_DESIGN_TOOLBOX_DIMENSION_V1|layer" || /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|[0-9]+$/.test(_dimensionMarker(group)))) return layer;
    }
    var found = _dimensionFindLayer(layer.layers);
    if (found) return found;
  }
  return null;
}

function _dimensionNormalizeBounds(b) {
  if (!b || b.length !== 4) return null;
  for (var i = 0; i < 4; i++) if (!isFinite(Number(b[i]))) return null;
  return [Math.min(Number(b[0]), Number(b[2])), Math.max(Number(b[1]), Number(b[3])), Math.max(Number(b[0]), Number(b[2])), Math.min(Number(b[1]), Number(b[3]))];
}

function _dimensionUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]), Math.min(a[3], b[3])];
}

function _dimensionBounds(item, mode) {
  if (!item || item.hidden || item.guides || _dimensionOwnedAncestor(item)) return null;
  if (item.typename === "GroupItem") {
    if (item.clipped) {
      for (var c = 0; c < item.pageItems.length; c++) {
        var mask = item.pageItems[c];
        if (mask.parent !== item) continue;
        if (mask.typename === "PathItem" && mask.clipping) return _dimensionNormalizeBounds(mask.geometricBounds);
        if (mask.typename === "CompoundPathItem") {
          for (var cp = 0; cp < mask.pathItems.length; cp++) {
            if (mask.pathItems[cp].clipping) return _dimensionNormalizeBounds(mask.geometricBounds);
          }
        }
      }
      // 找不到剪切路径时不回退到整个群组边界，避免把蒙版外不可见内容计入。
      return null;
    }
    var bounds = null;
    for (var i = 0; i < item.pageItems.length; i++) {
      if (item.pageItems[i].parent === item) bounds = _dimensionUnion(bounds, _dimensionBounds(item.pageItems[i], mode));
    }
    return bounds;
  }
  try { return _dimensionNormalizeBounds(mode === "visible" ? item.visibleBounds : item.geometricBounds); }
  catch (e) { return null; }
}

// ══════════════════════════════════════════════════════
//  辅助：清除标注图层
// ══════════════════════════════════════════════════════
function clearDimensionLayer(paramsJson) {
  var doc = null, previousLayer = null, previousSelection = null, restoredLayers = [];
  try {
    if (app.documents.length === 0) return _jsonError("没有打开的文档");
    doc = app.activeDocument;
    previousLayer = doc.activeLayer;
    previousSelection = _dimensionSelection(doc);
    var p = paramsJson === "last" || paramsJson === "all" ? { scope: paramsJson } : _parseParams(paramsJson);
    var scope = _dimensionChoice(p.scope, "all", ["last", "all"], "清理范围");
    var batches = [];
    function collect(layers) {
      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        for (var j = 0; j < layer.groupItems.length; j++) {
          var group = layer.groupItems[j];
          if (group.parent !== layer) continue;
          var match = /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|([0-9]+)$/.exec(_dimensionMarker(group));
          if (match) batches.push({ group: group, layer: layer, time: Number(match[1]) });
        }
        collect(layer.layers);
      }
    }
    collect(doc.layers);
    if (!batches.length) return _jsonObject([["msg", "s", "没有找到本工具生成的标注；旧版或同名图层中的内容已保留"], ["removedCount", "n", 0]]);
    if (scope === "last") {
      var newest = batches[0];
      for (var n = 1; n < batches.length; n++) if (batches[n].time > newest.time) newest = batches[n];
      batches = [newest];
    }
    var removed = 0;
    for (var k = 0; k < batches.length; k++) {
      var owner = batches[k].layer, ancestors = [];
      while (owner && owner.typename === "Layer") {
        ancestors.push(owner);
        owner = owner.parent;
      }
      // 先解锁父图层，再处理子图层；恢复时反向操作以免再次被父层锁挡住。
      for (var a = ancestors.length - 1; a >= 0; a--) {
        restoredLayers.push({ layer: ancestors[a], locked: ancestors[a].locked, visible: ancestors[a].visible });
        ancestors[a].locked = false;
        ancestors[a].visible = true;
      }
      batches[k].group.locked = false;
      batches[k].group.hidden = false;
      batches[k].group.remove();
      removed++;
    }
    // 留下带所有权标记的空图层，保留活动图层引用，也避免触碰任何用户内容。
    return _jsonObject([["msg", "s", "已清除 " + removed + " 批本工具生成的标注"], ["removedCount", "n", removed]]);
  } catch (e) {
    return _jsonError("清除标注失败：" + e.message);
  } finally {
    for (var r = restoredLayers.length - 1; r >= 0; r--) {
      try { restoredLayers[r].layer.visible = restoredLayers[r].visible; restoredLayers[r].layer.locked = restoredLayers[r].locked; } catch (restoreError) {}
    }
    // 移除已删除的标注引用，仍保留选区中的原始设计对象。
    if (previousSelection) {
      var remaining = [];
      for (var s = 0; s < previousSelection.length; s++) {
        try { if (previousSelection[s].typename && previousSelection[s].parent) remaining.push(previousSelection[s]); } catch (selectionError) {}
      }
      previousSelection = remaining;
    }
    _dimensionRestore(doc, previousLayer, previousSelection);
  }
}


// ══════════════════════════════════════════════════════
//  ★ 新增工具函数模板
// ══════════════════════════════════════════════════════
/*
function myNewToolJsx() {
  try {
    // 在这里写工具逻辑
    // 通过 JSON 返回结果给前端
    return JSON.stringify({ msg: "执行成功" });
  } catch (e) {
    return _jsonError(e.message);
  }
}
*/


// ══════════════════════════════════════════════════════
//  工具 3：复杂图形智能直线折边助手
//  支持选中多个对象 / 群组 / 复合路径中的闭合路径，也支持单条或多条开放线条。
// ══════════════════════════════════════════════════════
function toolFlange(paramsJson) {
  var outputLayer = null;
  try {
    if (app.documents.length === 0)
      return _jsonError("请先打开一个文档");
    if (!app.selection || app.selection.length === 0)
      return _jsonError("请先选中闭合路径、非封闭线条、群组或复合路径");

    var p = _parseParams(paramsJson);
    var widthMm = _toolNumber(p.widthMm === undefined ? 5 : p.widthMm);
    var angleDeg = _toolNumber(p.angleDeg === undefined ? 45 : p.angleDeg);

    if (isNaN(widthMm) || widthMm <= 0)
      return _jsonError("折边宽度必须是大于 0 的数字");
    if (isNaN(angleDeg) || angleDeg <= 0 || angleDeg >= 89)
      return _jsonError("切角角度请输入 1 到 88 之间的数字，常用 30、45、60");

    var cfg = {
      top: !!p.top,
      bottom: !!p.bottom,
      left: !!p.left,
      right: !!p.right,
      chop: p.chop !== false,
      angleDeg: angleDeg,
      outerOnly: p.outerOnly !== false
    };

    if (!cfg.top && !cfg.bottom && !cfg.left && !cfg.right)
      return _jsonError("请至少选择一个折边方位");

    var doc = app.activeDocument;
    var targets = [];
    collectPathItems(app.selection, targets);

    if (targets.length === 0)
      return _jsonError("未找到可处理的路径。请选中闭合路径、非封闭线条、群组或复合路径");

    var wPt = mmToPt(widthMm);
    var bounds = getItemsBounds(targets);
    var center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];

    var layer = doc.layers.add();
    outputLayer = layer;
    layer.name = "折边 Flanges " + widthMm + "mm " + angleDeg + "deg";

    var allSidesSelected = cfg.top && cfg.bottom && cfg.left && cfg.right;
    var closedTargets = [];
    var openTargets = [];
    for (var ti = 0; ti < targets.length; ti++) {
      if (targets[ti].closed) closedTargets.push(targets[ti]);
      else openTargets.push(targets[ti]);
    }
    var workClosedTargets = cfg.outerOnly ? filterOuterPathItems(closedTargets) : closedTargets;
    var count = 0;

    if (cfg.outerOnly && !allSidesSelected && workClosedTargets.length > 0) {
      var globalSegments = [];
      for (var gt = 0; gt < workClosedTargets.length; gt++) {
        collectSegments(workClosedTargets[gt], globalSegments, center, bounds);
      }

      markBestOuterSegment("left", cfg.left, globalSegments);
      markBestOuterSegment("right", cfg.right, globalSegments);
      markBestOuterSegment("top", cfg.top, globalSegments);
      markBestOuterSegment("bottom", cfg.bottom, globalSegments);

      for (var gs = 0; gs < globalSegments.length; gs++) {
        if (globalSegments[gs].use) {
          drawFlangeSegment(globalSegments[gs], wPt, cfg, center, layer);
          count++;
        }
      }
    } else {
      for (var t = 0; t < workClosedTargets.length; t++) {
        count += processFlanges(workClosedTargets[t], wPt, cfg, center, bounds, layer);
      }
    }

    for (var ot = 0; ot < openTargets.length; ot++) {
      count += processFlanges(openTargets[ot], wPt, cfg, center, bounds, layer);
    }

    return _jsonObject([
      ["pathCount", "n", targets.length],
      ["count", "n", count]
    ]);

  } catch (e) {
    // 一批折边必须完整生成；复制外观或修改路径失败时不留下半成品。
    if (outputLayer) {
      try { outputLayer.remove(); } catch (cleanupError) {}
    }
    return _jsonError("错误：" + e.message);
  }

  function processFlanges(pathItem, w, cfg, globalCenter, globalBounds, targetLayer) {
    if (!pathItem || pathItem.pathPoints.length < 2) return 0;

    var pts = pathItem.pathPoints;
    var segments = [];
    var isOpenPath = pathItem.closed !== true;
    var segCount = pathItem.closed ? pts.length : pts.length - 1;
    if (segCount < 1) return 0;

    // 先收集所有直线段。这样可针对“圆台展开扇形”这类斜直边，
    // 按左 / 右 / 上 / 下方位选择真正位于外侧的那条直线边，
    // 而不是只判断是否贴着矩形边界。
    for (var i = 0; i < segCount; i++) {
      var currP = pts[i];
      var nextP = (i === pts.length - 1) ? pts[0] : pts[i + 1];
      if (!isStraight(currP, nextP)) continue;

      var p1 = [currP.anchor[0], currP.anchor[1]];
      var p2 = [nextP.anchor[0], nextP.anchor[1]];
      var dx = p2[0] - p1[0];
      var dy = p2[1] - p1[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.5) continue;

      var midX = (p1[0] + p2[0]) / 2;
      var midY = (p1[1] + p2[1]) / 2;
      var side = getSide(midX, midY, globalCenter, globalBounds);

      var seg = {
        pathItem: pathItem,
        p1: p1,
        p2: p2,
        dx: dx,
        dy: dy,
        len: len,
        midX: midX,
        midY: midY,
        side: side,
        use: false
      };

      if (isOpenPath) {
        addOpenSegmentCandidates(segments, seg, dy / len, -dx / len, cfg);
      } else {
        segments.push(seg);
      }
    }

    if (segments.length === 0) return 0;

    var allSidesSelected = cfg.top && cfg.bottom && cfg.left && cfg.right;

    if (cfg.outerOnly && !allSidesSelected) {
      // outerOnly=true 且只选部分方位时，每个方位只取最外侧的一条直线边。
      // 全选时应处理全部外轮廓直线边，例如六边形需要生成 6 个折边。
      markBestOuterSegment("left", cfg.left, segments);
      markBestOuterSegment("right", cfg.right, segments);
      markBestOuterSegment("top", cfg.top, segments);
      markBestOuterSegment("bottom", cfg.bottom, segments);
    } else {
      for (var si = 0; si < segments.length; si++) {
        if (cfg[segments[si].side]) segments[si].use = true;
      }
    }

    var made = 0;
    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      if (!seg.use) continue;
      drawFlangeSegment(seg, w, cfg, globalCenter, targetLayer);
      made++;
    }
    return made;
  }

  function collectSegments(pathItem, segments, globalCenter, globalBounds) {
    if (!pathItem || !pathItem.closed || pathItem.pathPoints.length < 2) return;

    var pts = pathItem.pathPoints;
    for (var i = 0; i < pts.length; i++) {
      var currP = pts[i];
      var nextP = (i === pts.length - 1) ? pts[0] : pts[i + 1];
      if (!isStraight(currP, nextP)) continue;

      var p1 = [currP.anchor[0], currP.anchor[1]];
      var p2 = [nextP.anchor[0], nextP.anchor[1]];
      var dx = p2[0] - p1[0];
      var dy = p2[1] - p1[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.5) continue;

      var midX = (p1[0] + p2[0]) / 2;
      var midY = (p1[1] + p2[1]) / 2;
      var side = getSide(midX, midY, globalCenter, globalBounds);

      segments.push({
        pathItem: pathItem,
        p1: p1,
        p2: p2,
        dx: dx,
        dy: dy,
        len: len,
        midX: midX,
        midY: midY,
        side: side,
        use: false
      });
    }
  }

  function drawFlangeSegment(seg, w, cfg, globalCenter, targetLayer) {
    var p1 = seg.p1;
    var p2 = seg.p2;
    var dx = seg.dx;
    var dy = seg.dy;
    var len = seg.len;
    var midX = seg.midX;
    var midY = seg.midY;

    var normal = getSegmentNormal(seg, w, globalCenter);
    var nx = normal[0];
    var ny = normal[1];

    var f1 = [p1[0] + nx * w, p1[1] + ny * w];
    var f2 = [p2[0] + nx * w, p2[1] + ny * w];

    var newPts;
    if (cfg.chop) {
      var chopLen = w / Math.tan(cfg.angleDeg * Math.PI / 180);
      var maxChop = len / 2 - 0.2;
      if (chopLen > maxChop) chopLen = Math.max(0, maxChop);

      if (chopLen > 0) {
        newPts = [
          p1,
          [f1[0] + (dx / len) * chopLen, f1[1] + (dy / len) * chopLen],
          [f2[0] - (dx / len) * chopLen, f2[1] - (dy / len) * chopLen],
          p2
        ];
      } else {
        newPts = [p1, f1, f2, p2];
      }
    } else {
      newPts = [p1, f1, f2, p2];
    }

    // 复制源路径后只替换几何，可保留完整填充/描边外观：无填充、无描边、
    // 渐变/图案/专色、虚线、端点/连接、透明度及路径上的画笔/外观属性。
    // 不把颜色重建为 RGB，也不写入 filled/stroked，避免覆盖源路径的外观。
    // 群组/图层祖先上的整体效果不属于此 PathItem，无法随单条边复制。
    var flange = seg.pathItem.duplicate(targetLayer, ElementPlacement.PLACEATEND);
    flange.setEntirePath(newPts);
    flange.closed = true;
    // 旧路径可能带有曲线控制柄；折边始终是四个角点构成的直线轮廓。
    for (var pi = 0; pi < flange.pathPoints.length; pi++) {
      var point = flange.pathPoints[pi];
      point.leftDirection = point.anchor;
      point.rightDirection = point.anchor;
      point.pointType = PointType.CORNER;
    }
  }

  function markBestOuterSegment(side, enabled, segments) {
    if (!enabled) return;
    var best = null;
    var bestScore = -999999999;

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.side !== side) continue;

      var score;
      if (side === "left") score = -seg.midX;
      else if (side === "right") score = seg.midX;
      else if (side === "top") score = seg.midY;
      else score = -seg.midY;

      if (score > bestScore) {
        bestScore = score;
        best = seg;
      }
    }

    if (best) best.use = true;
  }

  function collectPathItems(items, out) {
    for (var i = 0; i < items.length; i++) collectOne(items[i], out);
  }

  function collectOne(item, out) {
    if (!item) return;
    if (item.typename === "PathItem") {
      if (!item.guides && !item.clipping && item.pathPoints.length >= 2) out.push(item);
    } else if (item.typename === "GroupItem") {
      for (var i = 0; i < item.pageItems.length; i++) collectOne(item.pageItems[i], out);
    } else if (item.typename === "CompoundPathItem") {
      for (var j = 0; j < item.pathItems.length; j++) collectOne(item.pathItems[j], out);
    }
  }

  function filterOuterPathItems(items) {
    var out = [];
    var infos = [];

    for (var i = 0; i < items.length; i++) {
      infos.push({
        item: items[i],
        bounds: items[i].geometricBounds,
        area: boundsArea(items[i].geometricBounds)
      });
    }

    for (var p = 0; p < infos.length; p++) {
      var inner = false;
      for (var q = 0; q < infos.length; q++) {
        if (p === q) continue;
        if (infos[q].area <= infos[p].area) continue;
        if (boundsContainsBounds(infos[q].bounds, infos[p].bounds, 0.5)) {
          inner = true;
          break;
        }
      }
      if (!inner) out.push(infos[p].item);
    }

    return out;
  }

  function boundsArea(b) {
    return Math.abs((b[2] - b[0]) * (b[1] - b[3]));
  }

  function boundsContainsBounds(outer, inner, tol) {
    return outer[0] <= inner[0] + tol &&
           outer[2] >= inner[2] - tol &&
           outer[1] >= inner[1] - tol &&
           outer[3] <= inner[3] + tol;
  }

  function isStraight(p1, p2) {
    var eps = 0.01;
    var a = p1.anchor, r = p1.rightDirection;
    var b = p2.anchor, l = p2.leftDirection;
    return Math.abs(a[0] - r[0]) < eps && Math.abs(a[1] - r[1]) < eps &&
           Math.abs(b[0] - l[0]) < eps && Math.abs(b[1] - l[1]) < eps;
  }

  function getItemsBounds(items) {
    var left = 999999999, top = -999999999, right = -999999999, bottom = 999999999;
    for (var i = 0; i < items.length; i++) {
      var b = items[i].geometricBounds;
      if (b[0] < left) left = b[0];
      if (b[1] > top) top = b[1];
      if (b[2] > right) right = b[2];
      if (b[3] < bottom) bottom = b[3];
    }
    return [left, top, right, bottom];
  }

  function getSide(mx, my, center, bounds) {
    var halfW = Math.max(1, (bounds[2] - bounds[0]) / 2);
    var halfH = Math.max(1, (bounds[1] - bounds[3]) / 2);
    var dx = (mx - center[0]) / halfW;
    var dy = (my - center[1]) / halfH;
    return (Math.abs(dx) > Math.abs(dy)) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "top" : "bottom");
  }

  function addOpenSegmentCandidates(segments, baseSeg, nx, ny, cfg) {
    var sides = [];
    if (cfg.top) sides.push("top");
    if (cfg.bottom) sides.push("bottom");
    if (cfg.left) sides.push("left");
    if (cfg.right) sides.push("right");

    var addedPositive = false;
    var addedNegative = false;

    for (var i = 0; i < sides.length; i++) {
      var v = getSideVector(sides[i]);
      var dot = nx * v[0] + ny * v[1];

      if (dot >= 0) {
        if (!addedPositive) {
          segments.push(cloneOpenSegment(baseSeg, nx, ny, sides[i]));
          addedPositive = true;
        }
      } else if (!addedNegative) {
        segments.push(cloneOpenSegment(baseSeg, -nx, -ny, sides[i]));
        addedNegative = true;
      }
    }
  }

  function cloneOpenSegment(seg, nx, ny, side) {
    return {
      pathItem: seg.pathItem,
      p1: seg.p1,
      p2: seg.p2,
      dx: seg.dx,
      dy: seg.dy,
      len: seg.len,
      midX: seg.midX,
      midY: seg.midY,
      side: side,
      use: true,
      normalX: nx,
      normalY: ny
    };
  }

  function getSideVector(side) {
    if (side === "top") return [0, 1];
    if (side === "bottom") return [0, -1];
    if (side === "left") return [-1, 0];
    return [1, 0];
  }

  function getSegmentNormal(seg, w, globalCenter) {
    if (typeof seg.normalX === "number" && typeof seg.normalY === "number") {
      return [seg.normalX, seg.normalY];
    }

    var nx = seg.dy / seg.len;
    var ny = -seg.dx / seg.len;
    var d0 = dist2(seg.midX, seg.midY, globalCenter[0], globalCenter[1]);
    var d1 = dist2(seg.midX + nx * w, seg.midY + ny * w, globalCenter[0], globalCenter[1]);
    if (d1 < d0) {
      nx = -nx;
      ny = -ny;
    }

    return [nx, ny];
  }

  function isOuterBoundarySegment(p1, p2, side, bounds, tol) {
    if (side === "right") {
      return Math.abs(p1[0] - bounds[2]) <= tol && Math.abs(p2[0] - bounds[2]) <= tol;
    }
    if (side === "left") {
      return Math.abs(p1[0] - bounds[0]) <= tol && Math.abs(p2[0] - bounds[0]) <= tol;
    }
    if (side === "top") {
      return Math.abs(p1[1] - bounds[1]) <= tol && Math.abs(p2[1] - bounds[1]) <= tol;
    }
    if (side === "bottom") {
      return Math.abs(p1[1] - bounds[3]) <= tol && Math.abs(p2[1] - bounds[3]) <= tol;
    }
    return false;
  }

  function dist2(x1, y1, x2, y2) {
    var dx = x1 - x2;
    var dy = y1 - y2;
    return dx * dx + dy * dy;
  }

  function mmToPt(mm) {
    return mm * 2.834645669;
  }
}

// ══════════════════════════════════════════════════════
//  工具 4：圆台展开扇形
//  根据底部直径 a、顶部直径 b，以及垂直高度 c 或斜边高度 d 生成展开扇形。
//  生成后自动居中到当前画板中央。
// ══════════════════════════════════════════════════════
function toolSpiral(paramsJson) {
  try {
    var p = _parseParams(paramsJson);
    var mmToPtVal = 2.834645669;
    var pointsPerRound = 16;
    var mode = p.mode || "artboard";
    var weightMm = _toolNumber(p.weightMm);

    if (isNaN(weightMm) || weightMm <= 0) return _jsonError("线粗必须是大于 0 的数字");

    if (app.documents.length === 0) {
      if (mode === "ellipse") return _jsonError("请先打开文档并选中 1 个椭圆");
      app.documents.add();
    }

    var doc = app.activeDocument;
    var weightPt = weightMm * mmToPtVal;
    var rounds;
    var spacingMm;
    var diameterMm;

    if (mode === "artboard") {
      if ((p.artMode || "spacing") === "spacing") {
        rounds = _toolNumber(p.rounds);
        spacingMm = _toolNumber(p.spacingMm);
        if (isNaN(rounds) || rounds <= 0) return _jsonError("圈数必须是大于 0 的数字");
        if (isNaN(spacingMm) || spacingMm <= 0) return _jsonError("间距必须是大于 0 的数字");
        diameterMm = 2 * rounds * spacingMm;
      } else {
        diameterMm = _toolNumber(p.diameterMm);
        if (isNaN(diameterMm) || diameterMm <= 0) return _jsonError("最大直径必须是大于 0 的数字");
        if ((p.solve || "rounds") === "rounds") {
          rounds = _toolNumber(p.rounds);
          if (isNaN(rounds) || rounds <= 0) return _jsonError("圈数必须是大于 0 的数字");
          spacingMm = diameterMm / (2 * rounds);
        } else {
          spacingMm = _toolNumber(p.spacingMm);
          if (isNaN(spacingMm) || spacingMm <= 0) return _jsonError("间距必须是大于 0 的数字");
          rounds = diameterMm / (2 * spacingMm);
        }
      }

      var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
      var rect = ab.artboardRect;
      drawCircularSpiral(
        doc,
        (rect[0] + rect[2]) / 2,
        (rect[1] + rect[3]) / 2,
        rounds,
        spacingMm * mmToPtVal,
        diameterMm * mmToPtVal,
        weightPt
      );

      return _jsonObject([
        ["count", "n", 1],
        ["mode", "s", "画板中心"],
        ["rounds", "s", rounds.toFixed(3)],
        ["spacing", "s", spacingMm.toFixed(3) + " mm"],
        ["diameter", "s", diameterMm.toFixed(3) + " mm"]
      ]);
    }

    if (!doc.selection || doc.selection.length !== 1) return _jsonError("请先选中 1 个 Illustrator 标准椭圆");
    var item = doc.selection[0];
    if (item.typename !== "PathItem" || !isEllipseLike(item)) return _jsonError("当前选中的不是 Illustrator 标准椭圆路径");

    var gb = item.geometricBounds;
    var width = gb[2] - gb[0];
    var height = gb[1] - gb[3];
    if (width <= 0 || height <= 0) return _jsonError("椭圆尺寸异常");

    var centerX = (gb[0] + gb[2]) / 2;
    var centerY = (gb[1] + gb[3]) / 2;
    var aBase = width / 2;
    var bBase = height / 2;
    var maxRadius = Math.max(aBase, bBase);

    if ((p.ellipsePlacement || "inside") === "inside") {
      if ((p.ellipseInsideSolve || "spacing") === "spacing") {
        spacingMm = _toolNumber(p.spacingMm);
        if (isNaN(spacingMm) || spacingMm <= 0) return _jsonError("间距必须是大于 0 的数字");
        if (spacingMm * mmToPtVal >= maxRadius) return _jsonError("间距太大，超过椭圆可容纳范围");
        rounds = maxRadius / (spacingMm * mmToPtVal);
      } else {
        rounds = _toolNumber(p.rounds);
        if (isNaN(rounds) || rounds <= 0) return _jsonError("圈数必须是大于 0 的数字");
        spacingMm = (maxRadius / rounds) / mmToPtVal;
      }

      drawEllipseSpiralInside(doc, centerX, centerY, aBase, bBase, rounds, weightPt);
      return _jsonObject([
        ["count", "n", 1],
        ["mode", "s", "椭圆内部"],
        ["rounds", "s", rounds.toFixed(3)],
        ["spacing", "s", spacingMm.toFixed(3) + " mm"],
        ["diameter", "s", (Math.max(width, height) / mmToPtVal).toFixed(3) + " mm"]
      ]);
    }

    var extraRounds;
    var spacingPt;
    var outsideMode = p.ellipseOutsideMode || "classic";
    if (outsideMode === "classic") {
      spacingMm = _toolNumber(p.spacingMm);
      extraRounds = _toolNumber(p.extraRounds);
      if (isNaN(spacingMm) || spacingMm <= 0) return _jsonError("间距必须是大于 0 的数字");
      if (isNaN(extraRounds) || extraRounds <= 0) return _jsonError("外扩圈数必须是大于 0 的数字");
      spacingPt = spacingMm * mmToPtVal;
      diameterMm = (Math.max(width, height) + spacingPt * extraRounds * 2) / mmToPtVal;
    } else {
      var targetDiameterMm = _toolNumber(p.targetDiameterMm);
      if (isNaN(targetDiameterMm) || targetDiameterMm <= 0) return _jsonError("目标外径必须是大于 0 的数字");
      var originalMaxDiameterPt = Math.max(width, height);
      var targetDiameterPt = targetDiameterMm * mmToPtVal;
      if (targetDiameterPt <= originalMaxDiameterPt) return _jsonError("目标外径必须大于原椭圆直径");
      var ringWidthPt = (targetDiameterPt - originalMaxDiameterPt) / 2;

      if ((p.ellipseOutsideTargetSolve || "spacing") === "spacing") {
        spacingMm = _toolNumber(p.spacingMm);
        if (isNaN(spacingMm) || spacingMm <= 0) return _jsonError("间距必须是大于 0 的数字");
        spacingPt = spacingMm * mmToPtVal;
        if (spacingPt > ringWidthPt) return _jsonError("间距太大，超过原椭圆到目标外径之间的可用宽度");
        extraRounds = ringWidthPt / spacingPt;
      } else {
        extraRounds = _toolNumber(p.extraRounds);
        if (isNaN(extraRounds) || extraRounds <= 0) return _jsonError("外扩圈数必须是大于 0 的数字");
        spacingPt = ringWidthPt / extraRounds;
        spacingMm = spacingPt / mmToPtVal;
      }
      diameterMm = targetDiameterMm;
    }

    drawEllipseSpiralOutside(doc, centerX, centerY, aBase, bBase, spacingPt, extraRounds, weightPt);
    return _jsonObject([
      ["count", "n", 1],
      ["mode", "s", outsideMode === "classic" ? "椭圆外部" : "椭圆目标外径"],
      ["rounds", "s", extraRounds.toFixed(3)],
      ["spacing", "s", spacingMm.toFixed(3) + " mm"],
      ["diameter", "s", diameterMm.toFixed(3) + " mm"]
    ]);

  } catch (e) {
    return _jsonError("错误：" + e.message);
  }

  function samePoint(a, b) {
    var eps = 0.01;
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  }

  function isEllipseLike(pathItem) {
    if (pathItem.closed !== true || pathItem.pathPoints.length !== 4) return false;
    var pts = pathItem.pathPoints;
    for (var i = 0; i < pts.length; i++) {
      if (samePoint(pts[i].anchor, pts[i].leftDirection) && samePoint(pts[i].anchor, pts[i].rightDirection)) return false;
    }
    return true;
  }

  function finalizePath(doc, pathItem, weight) {
    pathItem.closed = false;
    pathItem.filled = false;
    pathItem.stroked = true;
    pathItem.strokeWidth = weight;
    try { pathItem.strokeCap = StrokeCap.ROUNDENDCAP; } catch (e1) {}
    try { pathItem.strokeJoin = StrokeJoin.ROUNDENDJOIN; } catch (e2) {}
    try {
      var c = new RGBColor();
      c.red = 0;
      c.green = 0;
      c.blue = 0;
      pathItem.strokeColor = c;
    } catch (e3) {}
    try {
      doc.selection = null;
      pathItem.selected = true;
      app.redraw();
    } catch (e4) {}
  }

  function buildOpenBezierPath(doc, data, weight) {
    var path = doc.pathItems.add();
    for (var i = 0; i < data.length; i++) {
      var pt = path.pathPoints.add();
      pt.anchor = data[i].anchor;
      pt.leftDirection = data[i].leftDirection;
      pt.rightDirection = data[i].rightDirection;
      pt.pointType = PointType.SMOOTH;
    }
    if (path.pathPoints.length > 0) {
      var first = path.pathPoints[0];
      first.leftDirection = first.anchor;
      first.pointType = PointType.CORNER;
      var last = path.pathPoints[path.pathPoints.length - 1];
      last.rightDirection = last.anchor;
      last.pointType = PointType.CORNER;
    }
    finalizePath(doc, path, weight);
    return path;
  }

  function getEllipseOffsetPoint(cx, cy, aBase, bBase, spacing, theta) {
    var offset = (spacing / (2 * Math.PI)) * theta;
    var cosT = Math.cos(theta);
    var sinT = Math.sin(theta);
    var nx = cosT / aBase;
    var ny = sinT / bBase;
    var nLen = Math.sqrt(nx * nx + ny * ny);
    if (nLen < 1e-12) nLen = 1e-12;
    nx /= nLen;
    ny /= nLen;
    return [cx + aBase * cosT + nx * offset, cy + bBase * sinT + ny * offset];
  }

  function getNumericTangent(cx, cy, aBase, bBase, spacing, theta, maxTheta) {
    var eps = Math.min(0.001, Math.max(0.0001, maxTheta / 100000));
    var t1 = theta - eps;
    var t2 = theta + eps;
    if (t1 < 0) t1 = 0;
    if (t2 > maxTheta) t2 = maxTheta;
    if (Math.abs(t2 - t1) < 1e-12) return [0, 0];
    var p1 = getEllipseOffsetPoint(cx, cy, aBase, bBase, spacing, t1);
    var p2 = getEllipseOffsetPoint(cx, cy, aBase, bBase, spacing, t2);
    return [(p2[0] - p1[0]) / (t2 - t1), (p2[1] - p1[1]) / (t2 - t1)];
  }

  function buildThetaList(maxTheta, pointsPerRound) {
    if (!isFinite(maxTheta) || maxTheta <= 0 || maxTheta / (2 * Math.PI) * pointsPerRound > 20000)
      throw new Error("螺旋点数超出范围，请减少圈数或增大间距（最多 20000 个锚点）");
    var deltaTheta = (2 * Math.PI) / pointsPerRound;
    var thetas = [];
    var i = 0;
    while (true) {
      var t = i * deltaTheta;
      if (t >= maxTheta - 1e-6) {
        thetas.push(maxTheta);
        break;
      }
      thetas.push(t);
      i++;
    }
    return thetas;
  }

  function drawCircularSpiral(doc, cx, cy, rounds, spacing, maxDiameter, weight) {
    var b = spacing / (2 * Math.PI);
    var maxTheta = 2 * Math.PI * rounds;
    var maxRadius = maxDiameter / 2;
    var thetas = buildThetaList(maxTheta, pointsPerRound);
    var pts = [];
    for (var j = 0; j < thetas.length; j++) {
      var theta = thetas[j];
      var dPrev = j > 0 ? (theta - thetas[j - 1]) : (2 * Math.PI) / pointsPerRound;
      var dNext = j < thetas.length - 1 ? (thetas[j + 1] - theta) : dPrev;
      var radius = b * theta;
      if (radius > maxRadius) radius = maxRadius;
      var x = cx + radius * Math.cos(theta);
      var y = cy + radius * Math.sin(theta);
      var dx = b * (Math.cos(theta) - theta * Math.sin(theta));
      var dy = b * (Math.sin(theta) + theta * Math.cos(theta));
      pts.push({ anchor: [x, y], leftDirection: [x - dx * dPrev / 3, y - dy * dPrev / 3], rightDirection: [x + dx * dNext / 3, y + dy * dNext / 3] });
    }
    return buildOpenBezierPath(doc, pts, weight);
  }

  function drawEllipseSpiralInside(doc, cx, cy, aBase, bBase, rounds, weight) {
    var maxTheta = 2 * Math.PI * rounds;
    var thetas = buildThetaList(maxTheta, pointsPerRound);
    var pts = [];
    for (var j = 0; j < thetas.length; j++) {
      var theta = thetas[j];
      var dPrev = j > 0 ? (theta - thetas[j - 1]) : (2 * Math.PI) / pointsPerRound;
      var dNext = j < thetas.length - 1 ? (thetas[j + 1] - theta) : dPrev;
      var tRatio = theta / maxTheta;
      var x = cx + (aBase * tRatio) * Math.cos(theta);
      var y = cy + (bBase * tRatio) * Math.sin(theta);
      var dt = 1 / maxTheta;
      var dx = aBase * (dt * Math.cos(theta) - tRatio * Math.sin(theta));
      var dy = bBase * (dt * Math.sin(theta) + tRatio * Math.cos(theta));
      pts.push({ anchor: [x, y], leftDirection: [x - dx * dPrev / 3, y - dy * dPrev / 3], rightDirection: [x + dx * dNext / 3, y + dy * dNext / 3] });
    }
    return buildOpenBezierPath(doc, pts, weight);
  }

  function drawEllipseSpiralOutside(doc, cx, cy, aBase, bBase, spacing, extraRounds, weight) {
    var maxTheta = 2 * Math.PI * extraRounds;
    var thetas = buildThetaList(maxTheta, pointsPerRound);
    var pts = [];
    for (var j = 0; j < thetas.length; j++) {
      var theta = thetas[j];
      var dPrev = j > 0 ? (theta - thetas[j - 1]) : (2 * Math.PI) / pointsPerRound;
      var dNext = j < thetas.length - 1 ? (thetas[j + 1] - theta) : dPrev;
      var point = getEllipseOffsetPoint(cx, cy, aBase, bBase, spacing, theta);
      var tangent = getNumericTangent(cx, cy, aBase, bBase, spacing, theta, maxTheta);
      var x = point[0], y = point[1], dx = tangent[0], dy = tangent[1];
      pts.push({ anchor: [x, y], leftDirection: [x - dx * dPrev / 3, y - dy * dPrev / 3], rightDirection: [x + dx * dNext / 3, y + dy * dNext / 3] });
    }
    return buildOpenBezierPath(doc, pts, weight);
  }
}

function toolConeFrustum(paramsJson) {
  try {
    var p = _parseParams(paramsJson);

    var a = _toolNumber(p.a);
    var b = _toolNumber(p.b);
    var mode = p.mode || "vertical";
    var c = _toolNumber(p.c);
    var d = _toolNumber(p.d);
    var mm2pt = 2.834645669;

    if (isNaN(a) || isNaN(b) || a < 0 || b < 0 || (a === 0 && b === 0)) {
      return _jsonError("直径输入非法：A、B 不能为负数，且不能同时为 0");
    }

    var finalL;
    var radiusDiff = Math.abs(a - b) / 2;
    if (mode === "slant") {
      if (isNaN(d) || d <= 0) return _jsonError("斜边高度 d 必须是大于 0 的数字");
      if (d < radiusDiff) return _jsonError("斜边高度 d 不能小于 A、B 半径差");
      finalL = d;
    } else {
      if (isNaN(c) || c <= 0) return _jsonError("垂直高度 c 必须是大于 0 的数字");
      finalL = Math.sqrt(Math.pow(c, 2) + Math.pow(radiusDiff, 2));
    }

    var doc = app.documents.length > 0 ? app.activeDocument : app.documents.add();
    var item;
    var Rmm;
    var rmm;
    var thetaRad;
    var thetaDeg;
    var radiusAmm;
    var radiusBmm;
    var outerSide;

    if (a === b) {
      item = drawCylinderUnfoldPath(doc, a * Math.PI * mm2pt, finalL * mm2pt);
      centerItemToActiveArtboard(doc, item);

      return _jsonObject([
        ["R", "s", "—"],
        ["r", "s", "—"],
        ["theta", "s", "圆柱展开"]
      ]);
    }

    if (a > b) {
      radiusAmm = (a * finalL) / (a - b);
      radiusBmm = radiusAmm - finalL;
      Rmm = radiusAmm;
      rmm = radiusBmm;
      thetaRad = (a * Math.PI) / radiusAmm;
      outerSide = "bottom";
    } else {
      radiusAmm = (a * finalL) / (b - a);
      radiusBmm = radiusAmm + finalL;
      Rmm = radiusBmm;
      rmm = radiusAmm;
      thetaRad = (b * Math.PI) / radiusBmm;
      outerSide = "top";
    }
    thetaDeg = thetaRad * 180 / Math.PI;

    item = drawConeFrustumPath(doc, Rmm * mm2pt, rmm * mm2pt, thetaRad, outerSide);
    centerItemToActiveArtboard(doc, item);

    return _jsonObject([
      ["R", "s", Rmm.toFixed(3) + " mm"],
      ["r", "s", rmm.toFixed(3) + " mm"],
      ["theta", "s", thetaDeg.toFixed(3) + "°"]
    ]);

  } catch (e) {
    return _jsonError("错误：" + e.message);
  }

  function drawCylinderUnfoldPath(doc, width, height) {
    var path = doc.pathItems.add();
    path.setEntirePath([[0, 0], [width, 0], [width, -height], [0, -height]]);
    path.closed = true;
    path.filled = false;
    path.stroked = true;
    path.strokeWidth = 1;

    try {
      var black = new GrayColor();
      black.gray = 100;
      path.strokeColor = black;
    } catch (e) {}

    return path;
  }

  function drawConeFrustumPath(doc, R, r, totalTheta, outerSide) {
    var path = doc.pathItems.add();
    path.closed = true;
    path.filled = false;
    path.stroked = true;
    path.strokeWidth = 1;

    try {
      var black = new GrayColor();
      black.gray = 100;
      path.strokeColor = black;
    } catch (e) {}

    var centerX = 0;
    var centerY = 0;
    var centerAngle = outerSide === "top" ? Math.PI / 2 : -Math.PI / 2;
    var startAngle = centerAngle - totalTheta / 2;

    var arcSegs = 4;
    var deltaT = totalTheta / arcSegs;
    var kR = R * (4 / 3) * Math.tan(deltaT / 4);
    var kr = r * (4 / 3) * Math.tan(deltaT / 4);

    for (var i = 0; i <= arcSegs; i++) {
      var ang = startAngle + i * deltaT;
      var pt = path.pathPoints.add();
      var x = centerX + R * Math.cos(ang);
      var y = centerY + R * Math.sin(ang);
      pt.anchor = [x, y];
      var dx = -Math.sin(ang), dy = Math.cos(ang);
      pt.leftDirection = [x - dx * kR, y - dy * kR];
      pt.rightDirection = [x + dx * kR, y + dy * kR];
    }

    if (r <= 0.001) {
      var centerPt = path.pathPoints.add();
      centerPt.anchor = [centerX, centerY];
      centerPt.leftDirection = centerPt.anchor;
      centerPt.rightDirection = centerPt.anchor;
    } else {
      for (var j = arcSegs; j >= 0; j--) {
        var ang2 = startAngle + j * deltaT;
        var pt2 = path.pathPoints.add();
        var x2 = centerX + r * Math.cos(ang2);
        var y2 = centerY + r * Math.sin(ang2);
        pt2.anchor = [x2, y2];
        var dx2 = -Math.sin(ang2), dy2 = Math.cos(ang2);
        pt2.leftDirection = [x2 + dx2 * kr, y2 + dy2 * kr];
        pt2.rightDirection = [x2 - dx2 * kr, y2 - dy2 * kr];
      }
    }

    path.pathPoints[0].leftDirection = path.pathPoints[0].anchor;
    path.pathPoints[arcSegs].rightDirection = path.pathPoints[arcSegs].anchor;
    if (r <= 0.001) {
      path.pathPoints[arcSegs + 1].leftDirection = path.pathPoints[arcSegs + 1].anchor;
      path.pathPoints[arcSegs + 1].rightDirection = path.pathPoints[arcSegs + 1].anchor;
    } else {
      path.pathPoints[arcSegs + 1].leftDirection = path.pathPoints[arcSegs + 1].anchor;
      path.pathPoints[path.pathPoints.length - 1].rightDirection = path.pathPoints[path.pathPoints.length - 1].anchor;
    }

    return path;
  }

  function centerItemToActiveArtboard(doc, item) {
    var abIndex = doc.artboards.getActiveArtboardIndex();
    var rect = doc.artboards[abIndex].artboardRect; // [left, top, right, bottom]
    var abCenterX = (rect[0] + rect[2]) / 2;
    var abCenterY = (rect[1] + rect[3]) / 2;

    var b = item.geometricBounds;
    var itemCenterX = (b[0] + b[2]) / 2;
    var itemCenterY = (b[1] + b[3]) / 2;

    item.translate(abCenterX - itemCenterX, abCenterY - itemCenterY);
  }
}


// ══════════════════════════════════════════════════════
//  工具 5：随机缩放并填充
//  选择规则：上方对象为填充物，下方对象为容器。
// ══════════════════════════════════════════════════════
function toolRandomFill(paramsJson) {
  try {
    if (app.documents.length === 0) return _jsonError("请先打开一个文档");
    if (!app.selection || app.selection.length < 2) {
      return _jsonError("请至少选择 2 个对象：上方为填充物，下方为容器");
    }

    var p = _parseParams(paramsJson);

    var useFillCount = p.useFillCount !== false;
    var fillCount = _toolNumber(p.fillCount);
    if (useFillCount && (isNaN(fillCount) || fillCount < 1 || fillCount > 1000 || fillCount !== Math.floor(fillCount))) {
      return _jsonError("填充数量必须为 1 到 1000 的整数");
    }

    var useScale = !!p.useScale;
    var minScale = _toolNumber(p.minScale);
    var maxScale = _toolNumber(p.maxScale);
    if (!useScale) { minScale = 1; maxScale = 1; }
    if (isNaN(minScale) || isNaN(maxScale) || minScale <= 0 || maxScale <= 0) {
      return _jsonError("缩放数值必须大于 0");
    }
    if (minScale > maxScale) {
      var tmp = minScale; minScale = maxScale; maxScale = tmp;
    }

    var randomRotate = !!p.randomRotate;
    var fixedAngle = _toolNumber(p.angle === undefined ? 0 : p.angle);
    if (!randomRotate && isNaN(fixedAngle)) return _jsonError("旋转角度必须是有效数字");

    var items = [];
    for (var i = 0; i < app.selection.length; i++) items.push(app.selection[i]);
    items.sort(function(a, b) { return b.top - a.top; });

    var container = items.pop();
    var seeds = items;
    if (!seeds || seeds.length === 0) return _jsonError("未找到填充物对象");
    if (container.typename === "RasterItem") return _jsonError("容器必须是路径或复合路径，不能是位图");

    var polyList = [];
    if (container.typename === "CompoundPathItem") {
      for (var ci = 0; ci < container.pathItems.length; ci++) {
        if (!container.pathItems[ci].closed) return _jsonError("填充容器的所有轮廓必须闭合");
        polyList.push(getPathPoints(container.pathItems[ci]));
      }
    } else if (container.typename === "PathItem") {
      if (!container.closed) return _jsonError("填充容器必须是闭合路径");
      polyList.push(getPathPoints(container));
    } else {
      return _jsonError("容器类型不支持，请取消编组或扩展外观后重试");
    }

    if (polyList.length === 0) return _jsonError("未识别到容器路径");

    var lb = container.geometricBounds;
    var cLeft = lb[0], cTop = lb[1], cRight = lb[2], cBottom = lb[3];
    var cWidth = cRight - cLeft;
    var cHeight = cTop - cBottom;
    if (cWidth <= 0 || cHeight <= 0) return _jsonError("容器尺寸异常");

    // 外接圆必须覆盖矩形对角线，才不会在随机旋转后相互碰撞或越界。
    var baseSize = 0;
    for (var seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
      var seedBounds = seeds[seedIndex].visibleBounds;
      var seedW = seedBounds[2] - seedBounds[0], seedH = seedBounds[1] - seedBounds[3];
      var seedDiameter = Math.sqrt(seedW * seedW + seedH * seedH);
      if (!isFinite(seedDiameter) || seedDiameter <= 0) return _jsonError("填充物尺寸异常");
      baseSize = Math.max(baseSize, seedDiameter);
    }

    if (!useFillCount) {
      var avgScale = useScale ? (minScale + maxScale) / 2 : 1;
      var estimateSize = Math.max(1, baseSize * avgScale);
      fillCount = Math.max(1, Math.min(300, Math.floor((cWidth * cHeight) / (estimateSize * estimateSize) * 0.55)));
    }

    var placedItems = [];
    var bestLayout = [];
    var bestLayoutScore = -999999999;
    var bestPlacedCount = 0;
    var layoutRounds = Math.max(8, Math.min(28, Math.ceil(fillCount / 6)));
    var candidateBatch = Math.max(80, Math.min(360, fillCount * 8));
    var maxAttemptsPerRound = Math.max(6000, fillCount * candidateBatch * 3);

    // 自动分散填充：不再使用间距倍数。
    // 每轮按“最远点采样”生成一套不重叠布局，再从多轮结果中选择整体最分散的一套。
    for (var round = 0; round < layoutRounds; round++) {
      var trialItems = [];
      var tries = 0;

      while (tries < maxAttemptsPerRound && trialItems.length < fillCount) {
        var best = null;
        var bestScore = -999999999;
        var batch = trialItems.length === 0 ? Math.max(30, Math.min(120, candidateBatch)) : candidateBatch;

        for (var cb = 0; cb < batch && tries < maxAttemptsPerRound; cb++, tries++) {
          var currentScale = minScale + Math.random() * (maxScale - minScale);
          var currentRadius = (baseSize * currentScale) / 2;
          var rndX = cLeft + Math.random() * cWidth;
          var rndY = cTop - Math.random() * cHeight;

          if (!circleInsideContainer(rndX, rndY, currentRadius, polyList)) continue;

          var fits = true;
          var nearestClearance = 999999999;
          var totalClearance = 0;

          for (var j = 0; j < trialItems.length; j++) {
            var other = trialItems[j];
            var dx = rndX - other[0];
            var dy = rndY - other[1];
            var dist = Math.sqrt(dx * dx + dy * dy);
            var minSafeDist = currentRadius + other[2];
            var clearance = dist - minSafeDist;
            if (clearance < 0) { fits = false; break; }
            if (clearance < nearestClearance) nearestClearance = clearance;
            totalClearance += clearance;
          }
          if (!fits) continue;

          var edgeScore = distanceToBoundsScore(rndX, rndY, currentRadius, cLeft, cTop, cRight, cBottom);
          var score = trialItems.length === 0 ? edgeScore : nearestClearance * 10 + totalClearance * 0.03 + edgeScore * 0.15;

          if (score > bestScore) {
            bestScore = score;
            best = [rndX, rndY, currentRadius, currentScale];
          }
        }

        if (best) trialItems.push(best);
        else break;
      }

      var layoutScore = scoreLayout(trialItems);
      if (trialItems.length > bestPlacedCount || (trialItems.length === bestPlacedCount && layoutScore > bestLayoutScore)) {
        bestPlacedCount = trialItems.length;
        bestLayoutScore = layoutScore;
        bestLayout = trialItems;
      }
      if (bestPlacedCount >= fillCount && round >= 3) break;
    }

    placedItems = bestLayout;

    if (useFillCount && placedItems.length < fillCount) {
      return _jsonError("填充数量过多：程序已自动尝试在容器内尽量分散放置，但当前数量会导致重叠。当前最多成功放入 " + placedItems.length + " 个，请减少填充数量、缩小填充物或放大容器后重试");
    }

    if (placedItems.length === 0) return _jsonError("容器内没有足够空间放置填充物，请缩小填充物后重试");
    var resultGroup = app.activeDocument.groupItems.add();
    resultGroup.move(container, ElementPlacement.PLACEBEFORE);
    for (var k = 0; k < placedItems.length; k++) {
      var data = placedItems[k];
      var newItem = seeds[k % seeds.length].duplicate(resultGroup, ElementPlacement.PLACEATEND);
      if (data[3] !== 1.0) newItem.resize(data[3] * 100, data[3] * 100, true, true, true, true, data[3] * 100);
      if (randomRotate) newItem.rotate(Math.random() * 360);
      else if (fixedAngle !== 0) newItem.rotate(fixedAngle);
      var newBounds = newItem.visibleBounds;
      newItem.translate(data[0] - (newBounds[0] + newBounds[2]) / 2, data[1] - (newBounds[1] + newBounds[3]) / 2);
    }

    if (!!p.deleteContainer) container.remove();

    return _jsonObject([["count", "n", placedItems.length]]);

  } catch (e) {
    if (resultGroup) { try { resultGroup.remove(); } catch (cleanupError) {} }
    return _jsonError("错误：" + e.message);
  }

  function circleInsideContainer(x, y, r, polyList) {
    if (!isInsideEvenOdd([x, y], polyList)) return false;
    // 检查圆心到每条边的最短距离，离散圆周采样会漏过狭窄孔洞。
    for (var pi = 0; pi < polyList.length; pi++) {
      var polygon = polyList[pi];
      for (var ei = 0; ei < polygon.length; ei++) {
        var a = polygon[ei], b = polygon[(ei + 1) % polygon.length];
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var lengthSq = dx * dx + dy * dy;
        var t = lengthSq ? ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSq : 0;
        t = Math.max(0, Math.min(1, t));
        var distanceX = x - a[0] - t * dx, distanceY = y - a[1] - t * dy;
        if (distanceX * distanceX + distanceY * distanceY < (r + 0.05) * (r + 0.05)) return false;
      }
    }
    return true;
  }

  function distanceToBoundsScore(x, y, r, left, top, right, bottom) {
    var a = x - left - r;
    var b = right - x - r;
    var c = top - y - r;
    var d = y - bottom - r;
    return Math.min(Math.min(a, b), Math.min(c, d));
  }

  function scoreLayout(items) {
    if (!items || items.length === 0) return -999999999;
    if (items.length === 1) return 0;
    var minClearance = 999999999;
    var sumClearance = 0;
    var pairs = 0;
    for (var i = 0; i < items.length; i++) {
      for (var j = i + 1; j < items.length; j++) {
        var dx = items[i][0] - items[j][0];
        var dy = items[i][1] - items[j][1];
        var dist = Math.sqrt(dx * dx + dy * dy);
        var clearance = dist - items[i][2] - items[j][2];
        if (clearance < minClearance) minClearance = clearance;
        sumClearance += clearance;
        pairs++;
      }
    }
    return minClearance * 10 + (pairs > 0 ? sumClearance / pairs : 0);
  }

  function isInsideEvenOdd(pt, polyList) {
    var insideCount = 0;
    for (var p = 0; p < polyList.length; p++) {
      if (isPointInPolygon(pt, polyList[p])) insideCount++;
    }
    return insideCount % 2 !== 0;
  }

  function isPointInPolygon(pt, vs) {
    var x = pt[0], y = pt[1];
    var inside = false;
    for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      var xi = vs[i][0], yi = vs[i][1];
      var xj = vs[j][0], yj = vs[j][1];
      var intersect = ((yi > y) != (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function getPathPoints(pathItem) {
    return _llFlattenPath(pathItem);
  }
}




// ══════════════════════════════════════════════════════
//  工具 7：沿路径均匀分布
//  选择规则：最下方对象为路径，其余上方对象为图形。
// ══════════════════════════════════════════════════════
function toolDistributeAlongPath(paramsJson) {
  try {
    if (app.documents.length === 0) return _jsonError("请先打开一个文档");
    var doc = app.activeDocument;
    var sel = doc.selection;

    if (!sel || sel.length < 2) return _jsonError("请至少选中 2 个对象：最下面的是路径，其余上方对象是图形");

    var p = _parseParams(paramsJson);
    var count = _toolNumber(p.count);
    if (isNaN(count) || count < 1 || count > 10000 || count !== Math.floor(count)) return _jsonError("数量必须是 1 到 10000 的整数");

    var angleOffset = _toolNumber(p.angleOffset);
    if (isNaN(angleOffset)) return _jsonError("旋转角度补偿必须是数字");

    var endScale = _toolNumber(p.endScale);
    if (isNaN(endScale) || endScale <= 0) return _jsonError("末个缩放必须是大于 0 的数字");

    var rotateWithPath = p.rotateWithPath !== false;
    var scaleDown = !!p.scaleDown;
    var keepOriginal = p.keepOriginal !== false;
    var deleteOldCopies = !!p.deleteOldCopies;
    var openCurveIncludeEnds = !!p.openCurveIncludeEnds;
    var openPolylineIncludeEnds = !!p.openPolylineIncludeEnds;
    var polylinePlacementMode = p.polylinePlacementMode === "midpoints" ? "midpoints" : "vertices";
    var multiCurveMultiplier = _toolNumber(p.multiCurveMultiplier === undefined ? 1 : p.multiCurveMultiplier);
    if (isNaN(multiCurveMultiplier) || multiCurveMultiplier < 1 || multiCurveMultiplier > 10000 || multiCurveMultiplier !== Math.floor(multiCurveMultiplier))
      return _jsonError("多图形倍数必须是 1 到 10000 的整数");

    var pathItem = null;
    var shapeItems = [];
    var lowestCenterY = null;
    var lowestIndex = -1;

    for (var i = 0; i < sel.length; i++) {
      var c = getItemCenter(sel[i]);
      if (lowestCenterY === null || c.y < lowestCenterY) {
        lowestCenterY = c.y;
        lowestIndex = i;
      }
    }

    pathItem = sel[lowestIndex];
    for (i = 0; i < sel.length; i++) {
      if (i !== lowestIndex) shapeItems.push(sel[i]);
    }

    if (!isPathLike(pathItem)) return _jsonError("识别出的最下方对象不是可处理的路径类型（当前仅支持 PathItem）");
    if (shapeItems.length < 1) return _jsonError("请至少选择 1 个图形对象");

    var isPolylinePath = isPolyline(pathItem);
    var isMultiShape = shapeItems.length > 1;

    if (isMultiShape) {
      shapeItems.sort(function(a, b) {
        var ca = getItemCenter(a);
        var cb = getItemCenter(b);
        if (Math.abs(ca.x - cb.x) > 0.01) return ca.x - cb.x;
        return cb.y - ca.y;
      });
    }

    var pointsData = [];
    var sampled = null;
    var warning = "";

    if (isPolylinePath) {
      pointsData = getPolylinePlacementPoints(pathItem, polylinePlacementMode, openPolylineIncludeEnds);
      if (pointsData.length < 1) return _jsonError("当前设置下，折线路径没有可用的放置位置");

      if (isMultiShape && (pointsData.length % shapeItems.length !== 0)) {
        warning = "可用放置点数不能被图形数整除，各图形出现次数会不一致";
      }
    } else {
      sampled = sampleEntirePath(pathItem, 400);
      if (!sampled || sampled.points.length < 2 || sampled.totalLength <= 0) return _jsonError("路径长度无效，无法分布");

      if (isMultiShape) {
        if (shapeItems.length * multiCurveMultiplier > 10000) return _jsonError("生成对象总数不能超过 10000 个");
        pointsData = getCurveDistributionPoints(pathItem, sampled, shapeItems.length * multiCurveMultiplier, openCurveIncludeEnds);
      } else {
        pointsData = getCurveDistributionPoints(pathItem, sampled, count, openCurveIncludeEnds);
      }

      var maxShapeSize = getMaxShapeSize(shapeItems);
      if (maxShapeSize > sampled.totalLength / 2) {
        warning = "当前图形最大尺寸大于路径总长度的 1/2，可能会重叠或效果不理想";
      }
    }

    var made = distributeByPoints(
      doc,
      pathItem,
      shapeItems,
      pointsData,
      rotateWithPath,
      angleOffset,
      scaleDown,
      endScale,
      keepOriginal,
      deleteOldCopies,
      isPolylinePath,
      isMultiShape
    );

    return _jsonObject([
      ["count", "n", made],
      ["pathType", "s", isPolylinePath ? "折线" : "曲线路径"],
      ["shapeMode", "s", isMultiShape ? "多图形" : "单图形"],
      ["warning", "s", warning]
    ]);

  } catch (e) {
    return _jsonError("错误：" + e.message);
  }

  function distributeByPoints(doc, pathItem, shapeItems, pointsData, rotateWithPath, angleOffset, scaleDown, endScale, keepOriginal, deleteOldCopies, isPolylinePath, isMultiShape) {
    var groupName = "__DistributeAlongPath_Result__";

    var resultGroup = doc.groupItems.add();
    resultGroup.name = groupName;

    var totalCount = pointsData.length;
    try {
    for (var i = 0; i < totalCount; i++) {
      var ptInfo = pointsData[i];
      var srcShape;

      if (isMultiShape) {
        srcShape = isPolylinePath ? shapeItems[i % shapeItems.length] : shapeItems[i % shapeItems.length];
      } else {
        srcShape = shapeItems[0];
      }

      var copy = srcShape.duplicate(resultGroup, ElementPlacement.PLACEATEND);
      var c = getItemCenter(copy);
      copy.translate(ptInfo.x - c.x, ptInfo.y - c.y);

      if (rotateWithPath) {
        copy.rotate(ptInfo.angle + angleOffset, true, true, true, true, Transformation.CENTER);
      }

      if (scaleDown) {
        var scaleValue = getScaleValue(i, totalCount, endScale, pathItem.closed && !isPolylinePath);
        copy.resize(scaleValue, scaleValue, true, true, true, true, scaleValue, Transformation.CENTER);
      }
    }
    } catch (copyError) {
      try { resultGroup.remove(); } catch (cleanupError) {}
      throw copyError;
    }

    // 全部生成成功后再清除旧结果，保留包含当前输入对象的旧结果组。
    if (deleteOldCopies) removeOldGroups(doc, groupName, resultGroup);

    if (!keepOriginal) {
      for (var j = 0; j < shapeItems.length; j++) shapeItems[j].hidden = true;
    }

    return totalCount;
  }

  function getCurveDistributionPoints(pathItem, sampled, count, includeEnds) {
    var arr = [];
    var isClosed = pathItem.closed;

    for (var i = 0; i < count; i++) {
      var t;
      if (isClosed) {
        t = i / count;
      } else if (includeEnds) {
        t = count === 1 ? 0 : i / (count - 1);
      } else {
        t = (i + 1) / (count + 1);
      }

      var targetLen = sampled.totalLength * t;
      var pt = getPointAtLength(sampled, targetLen);
      arr.push({
        x: pt.x,
        y: pt.y,
        angle: getTangentAngleAtLength(sampled, targetLen, isClosed)
      });
    }
    return arr;
  }

  function getPolylinePlacementPoints(pathItem, placementMode, includeEndsForOpenVertices) {
    if (placementMode === "midpoints") return getPolylineMidpointPoints(pathItem);
    return getPolylineVertexPoints(pathItem, includeEndsForOpenVertices);
  }

  function getPolylineVertexPoints(pathItem, includeEndsForOpen) {
    var pts = pathItem.pathPoints;
    var arr = [];
    var len = pts.length;
    if (!pts || len < 2) return arr;

    var startIndex = 0;
    var endIndex = len - 1;
    if (!pathItem.closed && !includeEndsForOpen) {
      startIndex = 1;
      endIndex = len - 2;
    }

    for (var i = startIndex; i <= endIndex; i++) {
      var cur = pts[i];
      var prevPt;
      var nextPt;

      if (!pathItem.closed) {
        if (i === 0) {
          prevPt = pointFromArray(cur.anchor);
          nextPt = pointFromArray(pts[i + 1].anchor);
        } else if (i === len - 1) {
          prevPt = pointFromArray(pts[i - 1].anchor);
          nextPt = pointFromArray(cur.anchor);
        } else {
          prevPt = pointFromArray(pts[i - 1].anchor);
          nextPt = pointFromArray(pts[i + 1].anchor);
        }
      } else {
        prevPt = pointFromArray(pts[(i - 1 + len) % len].anchor);
        nextPt = pointFromArray(pts[(i + 1) % len].anchor);
      }

      var curPt = pointFromArray(cur.anchor);
      arr.push({
        x: curPt.x,
        y: curPt.y,
        angle: Math.atan2(nextPt.y - prevPt.y, nextPt.x - prevPt.x) * 180 / Math.PI
      });
    }
    return arr;
  }

  function getPolylineMidpointPoints(pathItem) {
    var pts = pathItem.pathPoints;
    var arr = [];
    var len = pts.length;
    if (!pts || len < 2) return arr;

    var segCount = pathItem.closed ? len : len - 1;
    for (var i = 0; i < segCount; i++) {
      var a = pointFromArray(pts[i].anchor);
      var b = pointFromArray(pts[(i + 1) % len].anchor);
      arr.push({
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
      });
    }
    return arr;
  }

  function getScaleValue(index, count, endScale, isClosedCurve) {
    if (count <= 1) return 100;
    var ratio = isClosedCurve ? index / count : index / (count - 1);
    return 100 + (endScale - 100) * ratio;
  }

  function isPolyline(pathItem) {
    if (!pathItem || pathItem.typename !== "PathItem") return false;
    var pts = pathItem.pathPoints;
    if (!pts || pts.length < 2) return false;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!samePoint(p.anchor, p.leftDirection) || !samePoint(p.anchor, p.rightDirection)) return false;
    }
    return true;
  }

  function samePoint(a, b) {
    var eps = 0.01;
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  }

  function pointFromArray(a) {
    return { x: a[0], y: a[1] };
  }

  function isPathLike(item) {
    return item && item.typename === "PathItem";
  }

  function getItemCenter(item) {
    var vb = item.visibleBounds;
    return { x: (vb[0] + vb[2]) / 2, y: (vb[1] + vb[3]) / 2 };
  }

  function getItemMaxSize(item) {
    var vb = item.visibleBounds;
    return Math.max(Math.abs(vb[2] - vb[0]), Math.abs(vb[1] - vb[3]));
  }

  function getMaxShapeSize(shapeItems) {
    var maxSize = 0;
    for (var i = 0; i < shapeItems.length; i++) maxSize = Math.max(maxSize, getItemMaxSize(shapeItems[i]));
    return maxSize;
  }

  function removeOldGroups(doc, groupName, keepGroup) {
    for (var i = doc.groupItems.length - 1; i >= 0; i--) {
      var candidate = doc.groupItems[i];
      if (candidate.name !== groupName || candidate === keepGroup || _toolContainsItem(candidate, pathItem)) continue;
      var isSource = false;
      for (var s = 0; s < shapeItems.length; s++) if (_toolContainsItem(candidate, shapeItems[s])) isSource = true;
      if (!isSource) { try { candidate.remove(); } catch (removeError) {} }
    }
  }

  function cubicBezierPoint(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    var mt2 = mt * mt;
    var t2 = t * t;
    return {
      x: mt2 * mt * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t2 * t * p3[0],
      y: mt2 * mt * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t2 * t * p3[1]
    };
  }

  function distance(p1, p2) {
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function sampleEntirePath(pathItem, stepsPerSeg) {
    var pts = pathItem.pathPoints;
    if (pts.length < 2) return null;

    var merged = [];
    var cum = 0;
    var lastPt = null;
    var segCount = pathItem.closed ? pts.length : pts.length - 1;

    for (var i = 0; i < segCount; i++) {
      var a = pts[i];
      var b = pts[(i + 1) % pts.length];
      for (var s = 0; s <= stepsPerSeg; s++) {
        if (merged.length > 0 && s === 0) continue;
        var pt = cubicBezierPoint(a.anchor, a.rightDirection, b.leftDirection, b.anchor, s / stepsPerSeg);
        if (lastPt) cum += distance(lastPt, pt);
        merged.push({ x: pt.x, y: pt.y, len: cum });
        lastPt = pt;
      }
    }

    return { points: merged, totalLength: cum };
  }

  function getPointAtLength(sampled, targetLen) {
    var pts = sampled.points;
    if (targetLen <= 0) return { x: pts[0].x, y: pts[0].y };
    if (targetLen >= sampled.totalLength) return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };

    for (var i = 1; i < pts.length; i++) {
      if (pts[i].len >= targetLen) {
        var p1 = pts[i - 1];
        var p2 = pts[i];
        var segLen = p2.len - p1.len;
        if (segLen <= 0) return { x: p1.x, y: p1.y };
        var localT = (targetLen - p1.len) / segLen;
        return {
          x: p1.x + (p2.x - p1.x) * localT,
          y: p1.y + (p2.y - p1.y) * localT
        };
      }
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }

  function getTangentAngleAtLength(sampled, targetLen, isClosed) {
    var total = sampled.totalLength;
    var delta = Math.max(total * 0.002, 0.5);
    var len1 = targetLen - delta;
    var len2 = targetLen + delta;

    if (isClosed) {
      len1 = normalizeLength(len1, total);
      len2 = normalizeLength(len2, total);
    } else {
      if (len1 < 0) len1 = 0;
      if (len2 > total) len2 = total;
    }

    var p1 = getPointAtLength(sampled, len1);
    var p2 = getPointAtLength(sampled, len2);
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) return 0;
    return Math.atan2(dy, dx) * 180 / Math.PI;
  }

  function normalizeLength(len, total) {
    while (len < 0) len += total;
    while (len >= total) len -= total;
    return len;
  }
}


function toolDistributeAlongPathInspectSelection() {
  try {
    if (app.documents.length === 0) return _jsonObject([["ok", "b", false], ["closed", "b", false], ["polyline", "b", false], ["shapeCount", "n", 0]]);
    var sel = app.activeDocument.selection;
    if (!sel || sel.length < 2) return _jsonObject([["ok", "b", false], ["closed", "b", false], ["polyline", "b", false], ["shapeCount", "n", 0]]);

    var lowestCenterY = null;
    var lowestIndex = -1;
    for (var i = 0; i < sel.length; i++) {
      var vb = sel[i].visibleBounds;
      var cy = (vb[1] + vb[3]) / 2;
      if (lowestCenterY === null || cy < lowestCenterY) {
        lowestCenterY = cy;
        lowestIndex = i;
      }
    }

    var item = sel[lowestIndex];
    var ok = item && item.typename === "PathItem";
    var polyline = ok && inspectIsPolyline(item);
    return _jsonObject([
      ["ok", "b", ok],
      ["closed", "b", ok && item.closed === true],
      ["polyline", "b", polyline],
      ["shapeCount", "n", ok ? sel.length - 1 : 0]
    ]);
  } catch (e) {
    return _jsonObject([["ok", "b", false], ["closed", "b", false], ["polyline", "b", false], ["shapeCount", "n", 0]]);
  }

  function inspectIsPolyline(pathItem) {
    if (!pathItem || pathItem.typename !== "PathItem") return false;
    var pts = pathItem.pathPoints;
    if (!pts || pts.length < 2) return false;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!inspectSamePoint(p.anchor, p.leftDirection) || !inspectSamePoint(p.anchor, p.rightDirection)) return false;
    }
    return true;
  }

  function inspectSamePoint(a, b) {
    var eps = 0.01;
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  }
}


// ══════════════════════════════════════════════════════
//  工具 9：曲线等分
//  沿路径真实长度标记或切断曲线。
// ══════════════════════════════════════════════════════
function toolDivideCurve(paramsJson) {
  try {
    if (app.documents.length === 0)
      return _jsonError("请先打开一个文档");
    if (!app.selection || app.selection.length === 0)
      return _jsonError("请先选中 1 条需要等分的曲线");

    var p = _parseParams(paramsJson);
    var parts = _toolNumber(p.parts);
    var markerMm = _toolNumber(p.markerMm);
    var mode = p.mode === "cut" ? "cut" : "mark";
    var deleteOld = p.deleteOld !== false;

    if (isNaN(parts) || parts < 2 || parts > 10000 || parts !== Math.floor(parts))
      return _jsonError("等分份数必须是 2 到 10000 的整数");
    if (mode === "mark" && (isNaN(markerMm) || markerMm <= 0))
      return _jsonError("标记直径必须是大于 0 的数字");

    var paths = [];
    collectDividePaths(app.selection, paths);
    if (paths.length !== 1)
      return _jsonError("请只选中 1 条普通路径；如果是编组或复合路径，请确保里面只有 1 条路径");

    var pathItem = paths[0];
    if (pathItem.pathPoints.length < 2)
      return _jsonError("当前路径点数不足，无法等分");

    var sampled = sampleDividePath(pathItem, 500);
    if (!sampled || sampled.totalLength <= 0)
      return _jsonError("路径长度无效，无法等分");

    var doc = app.activeDocument;
    var layerName = "曲线等分 Divide";

    var layer = doc.layers.add();
    layer.name = layerName;

    var count;
    if (mode === "cut") {
      count = cutDividePath(pathItem, sampled, parts, layer);
    } else {
      count = markDividePoints(pathItem, sampled, parts, markerMm, layer);
    }
    if (deleteOld) removeDivideLayers(doc, layerName, layer, pathItem);
    if (mode === "cut") pathItem.hidden = true;

    return _jsonObject([
      ["parts", "n", parts],
      ["count", "n", count],
      ["mode", "s", mode],
      ["segmentLength", "s", (sampled.totalLength / parts / 2.834645669).toFixed(3) + " mm"]
    ]);

  } catch (e) {
    if (layer) { try { layer.remove(); } catch (cleanupError) {} }
    return _jsonError("错误：" + e.message);
  }

  function collectDividePaths(items, out) {
    for (var i = 0; i < items.length; i++) collectDivideOne(items[i], out);
  }

  function collectDivideOne(item, out) {
    if (!item) return;
    if (item.typename === "PathItem") {
      if (!item.guides && !item.clipping) out.push(item);
    } else if (item.typename === "GroupItem") {
      for (var i = 0; i < item.pageItems.length; i++) collectDivideOne(item.pageItems[i], out);
    } else if (item.typename === "CompoundPathItem") {
      for (var j = 0; j < item.pathItems.length; j++) collectDivideOne(item.pathItems[j], out);
    }
  }

  function removeDivideLayers(doc, layerName, keepLayer, sourcePath) {
    for (var i = doc.layers.length - 1; i >= 0; i--) {
      var candidate = doc.layers[i];
      if (candidate.name === layerName && candidate !== keepLayer && !_toolContainsItem(candidate, sourcePath)) {
        try { candidate.remove(); } catch (removeError) {}
      }
    }
  }

  function markDividePoints(pathItem, sampled, parts, markerMm, layer) {
    var markerPt = markerMm * 2.834645669;
    var markerCount = pathItem.closed ? parts : parts - 1;
    var red = new RGBColor();
    red.red = 255;
    red.green = 0;
    red.blue = 0;

    for (var i = 0; i < markerCount; i++) {
      var t = pathItem.closed ? (i / parts) : ((i + 1) / parts);
      var pt = getDividePointAtLength(sampled, sampled.totalLength * t);
      var dot = layer.pathItems.ellipse(
        pt.y + markerPt / 2,
        pt.x - markerPt / 2,
        markerPt,
        markerPt
      );
      dot.stroked = false;
      dot.filled = true;
      dot.fillColor = red;
    }

    return markerCount;
  }

  function cutDividePath(pathItem, sampled, parts, layer) {
    var made = 0;
    for (var i = 0; i < parts; i++) {
      var startLen = sampled.totalLength * i / parts;
      var endLen = sampled.totalLength * (i + 1) / parts;
      var pieces = getDivideBezierPieces(pathItem, sampled, startLen, endLen);
      if (pieces.length > 0) {
        createDivideBezierPath(layer, pieces, pathItem);
        made++;
      }
    }
    return made;
  }

  function copyDivideAppearance(src, dst) {
    var hasStroke = true;
    try { hasStroke = src.stroked; } catch (e0) {}
    dst.stroked = true;
    try { dst.strokeWidth = hasStroke ? src.strokeWidth : 1; } catch (e2) { dst.strokeWidth = 1; }
    try {
      if (hasStroke) dst.strokeColor = src.strokeColor;
      else if (src.filled) dst.strokeColor = src.fillColor;
    } catch (e3) {}
    try { dst.strokeCap = src.strokeCap; } catch (e4) {}
    try { dst.strokeJoin = src.strokeJoin; } catch (e5) {}
    try { dst.miterLimit = src.miterLimit; } catch (e6) {}
    try { dst.opacity = src.opacity; } catch (e7) {}
    dst.filled = false;
  }

  function sampleDividePath(pathItem, stepsPerSeg) {
    var pts = pathItem.pathPoints;
    var merged = [];
    var cum = 0;
    var lastPt = null;
    var segCount = pathItem.closed ? pts.length : pts.length - 1;

    for (var i = 0; i < segCount; i++) {
      var a = pts[i];
      var b = pts[(i + 1) % pts.length];
      for (var s = 0; s <= stepsPerSeg; s++) {
        if (merged.length > 0 && s === 0) continue;
        var pt = divideCubicPoint(a.anchor, a.rightDirection, b.leftDirection, b.anchor, s / stepsPerSeg);
        if (lastPt) cum += divideDistance(lastPt, pt);
        merged.push({ x: pt.x, y: pt.y, len: cum, seg: i, t: s / stepsPerSeg });
        lastPt = pt;
      }
    }

    return { points: merged, totalLength: cum };
  }

  function divideCubicPoint(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    var mt2 = mt * mt;
    var t2 = t * t;
    return {
      x: mt2 * mt * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t2 * t * p3[0],
      y: mt2 * mt * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t2 * t * p3[1]
    };
  }

  function divideDistance(p1, p2) {
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getDividePointAtLength(sampled, targetLen) {
    var pts = sampled.points;
    if (targetLen <= 0) return { x: pts[0].x, y: pts[0].y };
    if (targetLen >= sampled.totalLength) return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };

    for (var i = 1; i < pts.length; i++) {
      if (pts[i].len >= targetLen) {
        var p1 = pts[i - 1];
        var p2 = pts[i];
        var segLen = p2.len - p1.len;
        if (segLen <= 0) return { x: p1.x, y: p1.y };
        var localT = (targetLen - p1.len) / segLen;
        return {
          x: p1.x + (p2.x - p1.x) * localT,
          y: p1.y + (p2.y - p1.y) * localT
        };
      }
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }

  function getDivideLocationAtLength(sampled, targetLen) {
    var pts = sampled.points;
    if (targetLen <= 0) return { seg: pts[0].seg, t: pts[0].t };
    if (targetLen >= sampled.totalLength) return { seg: pts[pts.length - 1].seg, t: pts[pts.length - 1].t };

    for (var i = 1; i < pts.length; i++) {
      if (pts[i].len >= targetLen) {
        var p1 = pts[i - 1];
        var p2 = pts[i];
        var segLen = p2.len - p1.len;
        if (segLen <= 0) return { seg: p1.seg, t: p1.t };
        var k = (targetLen - p1.len) / segLen;
        if (p1.seg !== p2.seg) {
          return {
            seg: p2.seg,
            t: p2.t * k
          };
        }
        return {
          seg: p1.seg,
          t: p1.t + (p2.t - p1.t) * k
        };
      }
    }
    return { seg: pts[pts.length - 1].seg, t: pts[pts.length - 1].t };
  }

  function getDivideBezierPieces(pathItem, sampled, startLen, endLen) {
    var startLoc = getDivideLocationAtLength(sampled, startLen);
    var endLoc = getDivideLocationAtLength(sampled, endLen);
    var pieces = [];

    for (var si = startLoc.seg; si <= endLoc.seg; si++) {
      var t0 = (si === startLoc.seg) ? startLoc.t : 0;
      var t1 = (si === endLoc.seg) ? endLoc.t : 1;
      if (t1 - t0 <= 0.000001) continue;
      pieces.push(subDivideCubic(getDivideCubic(pathItem, si), t0, t1));
    }

    return pieces;
  }

  function createDivideBezierPath(layer, pieces, src) {
    var anchors = [];
    anchors.push([pieces[0][0][0], pieces[0][0][1]]);
    for (var i = 0; i < pieces.length; i++) {
      anchors.push([pieces[i][3][0], pieces[i][3][1]]);
    }

    var item = layer.pathItems.add();
    item.setEntirePath(anchors);
    item.closed = false;
    copyDivideAppearance(src, item);

    for (var p = 0; p < item.pathPoints.length; p++) {
      var pp = item.pathPoints[p];
      pp.pointType = PointType.CORNER;
      if (p === 0) {
        pp.leftDirection = pp.anchor;
        pp.rightDirection = pieces[0][1];
      } else if (p === item.pathPoints.length - 1) {
        pp.leftDirection = pieces[p - 1][2];
        pp.rightDirection = pp.anchor;
      } else {
        pp.leftDirection = pieces[p - 1][2];
        pp.rightDirection = pieces[p][1];
      }
    }

    return item;
  }

  function getDivideCubic(pathItem, segIndex) {
    var pts = pathItem.pathPoints;
    var a = pts[segIndex];
    var b = pts[(segIndex + 1) % pts.length];
    return [
      [a.anchor[0], a.anchor[1]],
      [a.rightDirection[0], a.rightDirection[1]],
      [b.leftDirection[0], b.leftDirection[1]],
      [b.anchor[0], b.anchor[1]]
    ];
  }

  function subDivideCubic(c, t0, t1) {
    if (t0 < 0) t0 = 0;
    if (t1 > 1) t1 = 1;
    if (t0 <= 0.000001 && t1 >= 0.999999) return cloneDivideCubic(c);

    var work = cloneDivideCubic(c);
    if (t1 < 0.999999) {
      work = splitDivideCubic(work, t1)[0];
    }
    if (t0 > 0.000001) {
      var localT = t1 <= 0.000001 ? 0 : t0 / t1;
      work = splitDivideCubic(work, localT)[1];
    }
    return work;
  }

  function splitDivideCubic(c, t) {
    var p01 = lerpDividePoint(c[0], c[1], t);
    var p12 = lerpDividePoint(c[1], c[2], t);
    var p23 = lerpDividePoint(c[2], c[3], t);
    var p012 = lerpDividePoint(p01, p12, t);
    var p123 = lerpDividePoint(p12, p23, t);
    var p0123 = lerpDividePoint(p012, p123, t);
    return [
      [c[0], p01, p012, p0123],
      [p0123, p123, p23, c[3]]
    ];
  }

  function lerpDividePoint(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t
    ];
  }

  function cloneDivideCubic(c) {
    return [
      [c[0][0], c[0][1]],
      [c[1][0], c[1][1]],
      [c[2][0], c[2][1]],
      [c[3][0], c[3][1]]
    ];
  }
}


// ══════════════════════════════════════════════════════
//  工具 10：全能镜像
//  可按左 / 右 / 上 / 下边界、方向角度或选中直线段生成镜像对象。
// ══════════════════════════════════════════════════════
function toolFourWayMirror(paramsJson) {
  try {
    if (app.documents.length === 0)
      return _jsonError("请先打开一个 Illustrator 文档");

    var doc = app.activeDocument;
    if (!doc.selection || doc.selection.length === 0)
      return _jsonError("请先选中需要处理的对象");

    var p = _parseParams(paramsJson);
    var doLeft = !!p.left;
    var doRight = !!p.right;
    var doTop = !!p.top;
    var doBottom = !!p.bottom;
    var doDirectional = !!p.directional;
    var doAxisLine = !!p.axisLine;
    var axisLineMode = p.axisLineMode === "perpendicular" ? "perpendicular" : "segment";
    var selectNew = !!p.selectNew;

    if (!doLeft && !doRight && !doTop && !doBottom && !doDirectional && !doAxisLine)
      return _jsonError("请至少选择一个镜像方向，或启用方向角度对称 / 指定线段镜像");

    var angleDeg = _toolNumber(p.angle);
    var cornerIndex = parseInt(p.cornerIndex, 10);
    if (isNaN(cornerIndex) || cornerIndex < 0 || cornerIndex > 3) cornerIndex = 3;

    if (doDirectional) {
      if (isNaN(angleDeg))
        return _jsonError("请输入有效的角度数字");
      if (angleDeg < 0 || angleDeg > 90)
        return _jsonError("方向角度请输入 0 到 90 之间的数字");
    }

    var axisLine = null;
    if (doAxisLine) {
      axisLine = findSelectedAxisLine(doc.selection);
      if (axisLine.error) return _jsonError(axisLine.error);
      if (!axisLine.item)
        return _jsonError("请同时选中 1 条开放直线段作为镜像轴");
    }

    var sourceItems = [];
    for (var i = 0; i < doc.selection.length; i++) {
      if (doc.selection[i].typename === "TextRange")
        return _jsonError("请先退出文字编辑状态，再用选择工具选中对象运行工具");
      if (axisLine && axisLine.item && doc.selection[i] === axisLine.item)
        continue;
      sourceItems.push(doc.selection[i]);
    }

    if (sourceItems.length === 0)
      return _jsonError("请在镜像轴之外，至少再选中 1 个需要镜像的对象");

    var baseBounds = getUnionBounds(sourceItems);
    var createdItems = [];
    var mirrorCount = 0;
    var directionalCount = 0;
    var axisLineCount = 0;

    if (doLeft) {
      createdItems.push(createMirror(sourceItems, baseBounds, "left"));
      mirrorCount++;
    }
    if (doRight) {
      createdItems.push(createMirror(sourceItems, baseBounds, "right"));
      mirrorCount++;
    }
    if (doTop) {
      createdItems.push(createMirror(sourceItems, baseBounds, "top"));
      mirrorCount++;
    }
    if (doBottom) {
      createdItems.push(createMirror(sourceItems, baseBounds, "bottom"));
      mirrorCount++;
    }
    if (doDirectional) {
      createdItems.push(createDirectionalSymmetry(sourceItems, baseBounds, cornerIndex, angleDeg));
      directionalCount++;
    }
    if (doAxisLine) {
      createdItems.push(createAxisLineMirror(sourceItems, axisLine.p1, axisLine.p2, axisLineMode));
      axisLineCount++;
    }

    createdItems = compactItems(createdItems);
    if (createdItems.length === 0)
      return _jsonError("没有生成任何镜像对象");

    bringItemsToFront(createdItems);
    forceRefreshHide(createdItems);

    if (selectNew) {
      tryDeselectAll();
      for (var s = 0; s < createdItems.length; s++) {
        try { createdItems[s].selected = true; } catch (e1) {}
      }
    } else {
      tryDeselectAll();
    }

    app.redraw();

    return _jsonObject([
      ["count", "n", createdItems.length],
      ["mirrorCount", "n", mirrorCount],
      ["directionalCount", "n", directionalCount],
      ["axisLineCount", "n", axisLineCount]
    ]);

  } catch (e) {
    return _jsonError("错误：" + e.message);
  }

  function createMirror(items, baseBounds, direction) {
    var group = duplicateSelectionAsGroup(items);
    var attrs = captureAppearance(group);

    try { group.name = "Mirror_" + direction; } catch (e0) {}

    if (direction === "left") {
      group.resize(-100, 100, true, true, true, true, 1, Transformation.CENTER);
      var b1 = getBounds(group);
      group.translate(baseBounds[0] - b1[2], 0);
    }

    if (direction === "right") {
      group.resize(-100, 100, true, true, true, true, 1, Transformation.CENTER);
      var b2 = getBounds(group);
      group.translate(baseBounds[2] - b2[0], 0);
    }

    if (direction === "top") {
      group.resize(100, -100, true, true, true, true, 1, Transformation.CENTER);
      var b3 = getBounds(group);
      group.translate(0, baseBounds[1] - b3[3]);
    }

    if (direction === "bottom") {
      group.resize(100, -100, true, true, true, true, 1, Transformation.CENTER);
      var b4 = getBounds(group);
      group.translate(0, baseBounds[3] - b4[1]);
    }

    restoreAppearance(attrs);
    return group;
  }

  function createDirectionalSymmetry(items, baseBounds, cornerIndex, angleDeg) {
    var group = duplicateSelectionAsGroup(items);
    var attrs = captureAppearance(group);

    try {
      group.name = "DirectionalSymmetry_" + getCornerName(cornerIndex) + "_" + angleDeg;
    } catch (e0) {}

    var pivot = getCornerPoint(baseBounds, cornerIndex);
    var originalCenter = getBoundsCenter(baseBounds);

    var originalVector = [
      originalCenter[0] - pivot[0],
      originalCenter[1] - pivot[1]
    ];

    var targetVector = getTargetVector(baseBounds, cornerIndex, angleDeg);
    var originalAngle = Math.atan2(originalVector[1], originalVector[0]);
    var targetAngle = Math.atan2(targetVector[1], targetVector[0]);
    var delta = normalizeRadians(targetAngle - originalAngle);
    var axisAngle = originalAngle + delta / 2;
    var matrix = getReflectionMatrix(pivot, axisAngle);

    try {
      group.transform(matrix, true, true, true, true, 1, Transformation.DOCUMENTORIGIN);
    } catch (e1) {
      try { group.remove(); } catch (e2) {}
      throw new Error("方向角度对称执行失败");
    }

    restoreAppearance(attrs);
    return group;
  }

  function createAxisLineMirror(items, p1, p2, mode) {
    var group = duplicateSelectionAsGroup(items);
    var attrs = captureAppearance(group);

    try {
      group.name = mode === "perpendicular" ? "AxisLinePerpendicularMirror" : "AxisLineMirror";
    } catch (e0) {}

    var axisAngle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    var pivot = p1;
    if (mode === "perpendicular") {
      pivot = [
        (p1[0] + p2[0]) / 2,
        (p1[1] + p2[1]) / 2
      ];
      axisAngle += Math.PI / 2;
    }
    var matrix = getReflectionMatrix(pivot, axisAngle);

    try {
      group.transform(matrix, true, true, true, true, 1, Transformation.DOCUMENTORIGIN);
    } catch (e1) {
      try { group.remove(); } catch (e2) {}
      throw new Error("指定线段镜像执行失败");
    }

    restoreAppearance(attrs);
    return group;
  }

  function getTargetVector(bounds, cornerIndex, angleDeg) {
    var rad = angleDeg * Math.PI / 180;
    var xAbs = Math.cos(rad);
    var yAbs = Math.sin(rad);
    var yUpSign = bounds[1] > bounds[3] ? 1 : -1;
    var yDownSign = -yUpSign;

    if (cornerIndex === 0) return [-xAbs, yUpSign * yAbs];
    if (cornerIndex === 1) return [-xAbs, yDownSign * yAbs];
    if (cornerIndex === 2) return [xAbs, yUpSign * yAbs];
    return [xAbs, yDownSign * yAbs];
  }

  function getCornerPoint(bounds, cornerIndex) {
    var left = bounds[0];
    var top = bounds[1];
    var right = bounds[2];
    var bottom = bounds[3];

    if (cornerIndex === 0) return [left, top];
    if (cornerIndex === 1) return [left, bottom];
    if (cornerIndex === 2) return [right, top];
    return [right, bottom];
  }

  function getCornerName(cornerIndex) {
    if (cornerIndex === 0) return "LeftTop";
    if (cornerIndex === 1) return "LeftBottom";
    if (cornerIndex === 2) return "RightTop";
    return "RightBottom";
  }

  function getBoundsCenter(bounds) {
    return [
      (bounds[0] + bounds[2]) / 2,
      (bounds[1] + bounds[3]) / 2
    ];
  }

  function normalizeRadians(rad) {
    while (rad <= -Math.PI) rad += Math.PI * 2;
    while (rad > Math.PI) rad -= Math.PI * 2;
    return rad;
  }

  function getReflectionMatrix(pivot, axisAngle) {
    var cos2 = Math.cos(2 * axisAngle);
    var sin2 = Math.sin(2 * axisAngle);
    var r11 = cos2;
    var r12 = sin2;
    var r21 = sin2;
    var r22 = -cos2;

    var px = pivot[0];
    var py = pivot[1];

    var tx = px - (r11 * px + r12 * py);
    var ty = py - (r21 * px + r22 * py);

    var m = app.getIdentityMatrix();
    m.mValueA = r11;
    m.mValueB = r21;
    m.mValueC = r12;
    m.mValueD = r22;
    m.mValueTX = tx;
    m.mValueTY = ty;

    return m;
  }

  function findSelectedAxisLine(selection) {
    var candidates = [];

    for (var i = 0; i < selection.length; i++) {
      var line = getAxisLineCandidate(selection[i]);
      if (line) candidates.push(line);
    }

    if (candidates.length === 0) return {};
    if (candidates.length > 1) {
      return {
        error: "检测到多条开放直线段。请只选中 1 条作为镜像轴；如果要镜像其它直线段，请先把它们编组。"
      };
    }

    return candidates[0];
  }

  function getAxisLineCandidate(item) {
    if (!item || item.typename !== "PathItem") return null;
    if (item.closed || item.pathPoints.length !== 2) return null;
    if (!isStraightAxisPoint(item.pathPoints[0]) || !isStraightAxisPoint(item.pathPoints[1])) return null;

    var p1 = [item.pathPoints[0].anchor[0], item.pathPoints[0].anchor[1]];
    var p2 = [item.pathPoints[1].anchor[0], item.pathPoints[1].anchor[1]];
    var dx = p2[0] - p1[0];
    var dy = p2[1] - p1[1];
    if (Math.sqrt(dx * dx + dy * dy) < 0.5) return null;

    return { item: item, p1: p1, p2: p2 };
  }

  function isStraightAxisPoint(pathPoint) {
    var eps = 0.01;
    return (
      Math.abs(pathPoint.leftDirection[0] - pathPoint.anchor[0]) <= eps &&
      Math.abs(pathPoint.leftDirection[1] - pathPoint.anchor[1]) <= eps &&
      Math.abs(pathPoint.rightDirection[0] - pathPoint.anchor[0]) <= eps &&
      Math.abs(pathPoint.rightDirection[1] - pathPoint.anchor[1]) <= eps
    );
  }

  function duplicateSelectionAsGroup(items) {
    var group = doc.groupItems.add();

    for (var i = 0; i < items.length; i++) {
      try { items[i].duplicate(group, ElementPlacement.PLACEATEND); } catch (e0) {}
    }

    if (group.pageItems.length === 0) {
      try { group.remove(); } catch (e1) {}
      throw new Error("未能复制选中对象，请检查对象是否可编辑");
    }

    return group;
  }

  function getBounds(item) {
    try {
      return item.visibleBounds;
    } catch (e1) {
      try {
        return item.geometricBounds;
      } catch (e2) {
        return [0, 0, 0, 0];
      }
    }
  }

  function getUnionBounds(items) {
    var b = getBounds(items[0]);
    var left = b[0];
    var top = b[1];
    var right = b[2];
    var bottom = b[3];

    for (var i = 1; i < items.length; i++) {
      var bb = getBounds(items[i]);
      if (bb[0] < left) left = bb[0];
      if (bb[1] > top) top = bb[1];
      if (bb[2] > right) right = bb[2];
      if (bb[3] < bottom) bottom = bb[3];
    }

    return [left, top, right, bottom];
  }

  function bringItemsToFront(items) {
    for (var i = 0; i < items.length; i++) {
      try {
        items[i].hidden = false;
        items[i].locked = false;
        items[i].opacity = 100;
        items[i].zOrder(ZOrderMethod.BRINGTOFRONT);
      } catch (e0) {}
    }
  }

  function tryDeselectAll() {
    try {
      app.executeMenuCommand("deselectall");
    } catch (e1) {
      try { doc.selection = null; } catch (e2) {}
    }
  }

  function forceRefreshHide(items) {
    tryDeselectAll();

    for (var i = 0; i < items.length; i++) {
      try { items[i].hidden = true; } catch (e0) {}
    }

    app.redraw();

    for (var j = 0; j < items.length; j++) {
      try {
        items[j].hidden = false;
        items[j].zOrder(ZOrderMethod.BRINGTOFRONT);
      } catch (e1) {}
    }

    app.redraw();
  }

  function captureAppearance(root) {
    var result = [];
    collectAppearance(root, result);
    return result;
  }

  function collectAppearance(item, result) {
    if (!item) return;

    if (item.typename === "GroupItem") {
      for (var i = 0; i < item.pageItems.length; i++) {
        collectAppearance(item.pageItems[i], result);
      }
      return;
    }

    if (item.typename === "CompoundPathItem") {
      for (var c = 0; c < item.pathItems.length; c++) {
        collectAppearance(item.pathItems[c], result);
      }
      return;
    }

    if (item.typename === "PathItem") {
      var data = { item: item };

      safeRead(data, item, "stroked");
      safeRead(data, item, "strokeWidth");
      safeRead(data, item, "strokeColor");
      safeRead(data, item, "strokeCap");
      safeRead(data, item, "strokeJoin");
      safeRead(data, item, "strokeMiterLimit");
      safeRead(data, item, "strokeDashes");
      safeRead(data, item, "strokeDashOffset");
      safeRead(data, item, "strokeOverprint");

      safeRead(data, item, "filled");
      safeRead(data, item, "fillColor");
      safeRead(data, item, "fillOverprint");

      safeRead(data, item, "opacity");
      safeRead(data, item, "blendingMode");

      result.push(data);
      return;
    }

    var otherData = { item: item };
    safeRead(otherData, item, "opacity");
    safeRead(otherData, item, "blendingMode");
    result.push(otherData);
  }

  function safeRead(data, item, prop) {
    try { data[prop] = item[prop]; } catch (e0) {}
  }

  function restoreAppearance(records) {
    for (var i = 0; i < records.length; i++) {
      var data = records[i];
      var item = data.item;
      if (!item) continue;

      safeWrite(item, data, "stroked");
      safeWrite(item, data, "strokeWidth");
      safeWrite(item, data, "strokeColor");
      safeWrite(item, data, "strokeCap");
      safeWrite(item, data, "strokeJoin");
      safeWrite(item, data, "strokeMiterLimit");
      safeWrite(item, data, "strokeDashes");
      safeWrite(item, data, "strokeDashOffset");
      safeWrite(item, data, "strokeOverprint");

      safeWrite(item, data, "filled");
      safeWrite(item, data, "fillColor");
      safeWrite(item, data, "fillOverprint");

      safeWrite(item, data, "opacity");
      safeWrite(item, data, "blendingMode");
    }
  }

  function safeWrite(item, data, prop) {
    if (!data.hasOwnProperty(prop)) return;
    try { item[prop] = data[prop]; } catch (e0) {}
  }

  function compactItems(items) {
    var result = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i]) result.push(items[i]);
    }
    return result;
  }
}


// ══════════════════════════════════════════════════════
//  工具 8：批量导出顶层对象为加工文件
// ══════════════════════════════════════════════════════
function toolBatchExportTopItems(format) {
  var srcDoc = null;
  try {
    if (app.documents.length === 0)
      return _jsonError("请先打开一个文档");

    format = String(format || "AI3");
    if (format !== "AI3" && format !== "DXF2000") format = "AI3";

    srcDoc = app.activeDocument;
    var exportFolder = Folder.selectDialog("请选择导出文件夹");
    if (!exportFolder)
      return _jsonError("已取消导出");

    var items = _collectTopLevelExportItems(srcDoc);
    if (items.length === 0)
      return _jsonError("当前文档中没有找到可导出的顶层对象");

    var exportedCount = 0;
    var failedCount = 0;
    var lastError = "";

    for (var i = 0; i < items.length; i++) {
      var srcItem = items[i];
      var tempDoc = null;

      try {
        var baseName = "export_" + _zeroPad(i + 1, 3);
        var gb = srcItem.visibleBounds;
        var width = Math.abs(gb[2] - gb[0]);
        var height = Math.abs(gb[1] - gb[3]);

        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
          failedCount++;
          lastError = "对象没有可导出的尺寸";
          continue;
        }

        tempDoc = app.documents.add(srcDoc.documentColorSpace, width, height);
        // 直接跨文档复制对象，避免改变原选择集和覆盖系统剪贴板。
        var pasted = srcItem.duplicate(tempDoc.layers[0], ElementPlacement.PLACEATBEGINNING);
        var pgb = pasted.visibleBounds;
        pasted.translate(-pgb[0], height - pgb[1]);
        tempDoc.artboards[0].artboardRect = [0, height, width, 0];

        var outFile;
        if (format === "AI3") {
          outFile = _makeUniqueExportFile(exportFolder, baseName, ".ai");
          _saveAsIllustrator3(tempDoc, outFile);
        } else {
          outFile = _makeUniqueExportFile(exportFolder, baseName, ".dxf");
          _exportAsDXF2000(tempDoc, outFile);
        }

        if (outFile && outFile.exists) {
          exportedCount++;
        } else {
          failedCount++;
          lastError = "文件未生成";
        }

      } catch (itemErr) {
        failedCount++;
        lastError = String(itemErr && itemErr.message ? itemErr.message : itemErr);
        $.writeln("批量导出失败：" + (i + 1) + " / " + itemErr);
      } finally {
        // 只关闭本次创建的临时文档，不能误关用户切换到的其他文档。
        if (tempDoc) { try { tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) {} }
      }
    }

    return _jsonObject([
      ["count", "n", exportedCount],
      ["format", "s", format === "AI3" ? "Illustrator 3" : "AutoCAD 2000 DXF"],
      ["folder", "s", exportFolder.fsName],
      ["failed", "n", failedCount],
      ["message", "s", failedCount > 0 ? ("部分文件导出失败：" + failedCount + " 个。" + (lastError ? " 最后错误：" + lastError : "")) : ""]
    ]);

  } catch (e) {
    return _jsonError("错误：" + e.message);
  } finally {
    if (srcDoc) { try { srcDoc.activate(); } catch (activateError) {} }
  }
}

function _makeUniqueExportFile(folder, stem, extension) {
  var file = new File(folder.fsName + "/" + stem + extension);
  var counter = 2;
  while (file.exists) {
    file = new File(folder.fsName + "/" + stem + "_" + counter + extension);
    counter++;
  }
  return file;
}

function _collectTopLevelExportItems(doc) {
  var result = [];

  for (var l = 0; l < doc.layers.length; l++) {
    _collectExportItemsFromLayer(doc.layers[l], result);
  }

  return result;
}

function _collectExportItemsFromLayer(layer, result) {
  if (layer.locked || !layer.visible) return;

  for (var i = 0; i < layer.pageItems.length; i++) {
    var item = layer.pageItems[i];

    if (!_isDirectChildOfLayer(item)) continue;
    if (!_canExportTopItem(item)) continue;

    if (
      item.typename === "GroupItem" ||
      item.typename === "CompoundPathItem" ||
      item.typename === "PathItem"
    ) {
      result.push(item);
    }
  }

  for (var s = 0; s < layer.layers.length; s++) {
    _collectExportItemsFromLayer(layer.layers[s], result);
  }
}

function _isDirectChildOfLayer(item) {
  try {
    return item.parent && item.parent.typename === "Layer";
  } catch (e) {
    return false;
  }
}

function _canExportTopItem(item) {
  try {
    if (item.locked || item.hidden || item.guides) return false;
    if (item.typename === "PathItem" && item.clipping) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function _saveAsIllustrator3(doc, file) {
  var opt = new IllustratorSaveOptions();
  opt.compatibility = Compatibility.ILLUSTRATOR3;
  opt.pdfCompatible = false;
  opt.compressed = false;
  opt.embedICCProfile = false;
  doc.saveAs(file, opt);
}

function _exportAsDXF2000(doc, file) {
  // 尺寸修复版：DXF 内部坐标优先按 Illustrator 点单位导出。
  // 这样重新打开 DXF 或给加工软件读取时，尺寸不会因为 mm/pt 自动换算而变小。
  var opt = new ExportOptionsAutoCAD();

  try {
    if (typeof AutoCADExportFileFormat !== "undefined" && AutoCADExportFileFormat.DXF !== undefined) {
      opt.exportFileFormat = AutoCADExportFileFormat.DXF;
    }
  } catch (e1) {}

  try {
    if (typeof AutoCADCompatibility !== "undefined") {
      if (AutoCADCompatibility.AutoCAD2000 !== undefined) {
        opt.version = AutoCADCompatibility.AutoCAD2000;
      } else if (AutoCADCompatibility.AutoCADRelease2000 !== undefined) {
        opt.version = AutoCADCompatibility.AutoCADRelease2000;
      } else if (AutoCADCompatibility.AUTOCAD2000 !== undefined) {
        opt.version = AutoCADCompatibility.AUTOCAD2000;
      }
    }
  } catch (e2) {}

  // 关键：不要强制 Millimeters。
  // 部分 AI 版本导出 DXF 后再打开，会把 mm 数值当作 pt 读取，导致尺寸变小。
  // 使用 Points 可保持与原 AI 文档几何尺寸一致。
  try {
    if (typeof AutoCADUnit !== "undefined") {
      if (AutoCADUnit.Points !== undefined) {
        opt.unit = AutoCADUnit.Points;
      } else if (AutoCADUnit.Point !== undefined) {
        opt.unit = AutoCADUnit.Point;
      }
    }
  } catch (e3) {}

  // 1:1 比例，防止 DXF 单位自动缩放。
  try { opt.unitScaleRatio = 1; } catch (e4) {}
  try { opt.scaleLineweights = false; } catch (e5) {}
  try { opt.convertTextToOutlines = true; } catch (e6) {}
  try { opt.exportSelectedArtOnly = false; } catch (e7) {}
  try { opt.alterPathsForAppearance = false; } catch (e8) {}

  if (file.exists) throw new Error("输出文件已存在，请选择新的文件名");

  // 不再 fallback 到无参数导出；无参数导出会使用 AI 默认单位，容易造成尺寸变化。
  try {
    doc.exportFile(file, ExportType.AUTOCAD, opt);
  } catch (err) {
    throw new Error("DXF导出失败：" + err.message);
  }
}

function _zeroPad(num, len) {
  var s = String(num);
  while (s.length < len) s = "0" + s;
  return s;
}


// ══════════════════════════════════════════════════
//  工具 10：批量查找替换文本
// ══════════════════════════════════════════════════
function toolReplaceText(findText, replaceText, caseSensitive, selectedOnly, skipLockedHidden) {
  try {
    if (app.documents.length === 0)
      return _jsonError("请先打开一个 Illustrator 文件。");

    findText = String(findText || "").replace(/\r\n|\n/g, "\r");
    replaceText = (replaceText === undefined ? "" : String(replaceText)).replace(/\r\n|\n/g, "\r");
    caseSensitive = caseSensitive !== false;
    selectedOnly = selectedOnly === true;
    skipLockedHidden = skipLockedHidden !== false;

    if (findText === "")
      return _jsonError("请输入要查找的文字。");

    var doc = app.activeDocument;
    var textFrames = [];

    if (selectedOnly) {
      if (!doc.selection || doc.selection.length === 0)
        return _jsonError("当前没有选中任何对象。");

      for (var s = 0; s < doc.selection.length; s++)
        _collectReplaceTextFrames(doc.selection[s], textFrames);
    } else {
      for (var i = 0; i < doc.textFrames.length; i++)
        textFrames.push(doc.textFrames[i]);
    }

    if (textFrames.length === 0)
      return _jsonError("没有找到可处理的文本对象。");

    var changedFrameCount = 0;
    var replaceCount = 0;
    var skippedCount = 0;

    for (var j = 0; j < textFrames.length; j++) {
      var textFrame = textFrames[j];
      try {
        if (skipLockedHidden && !_isReplaceTextEditable(textFrame)) {
          skippedCount++;
          continue;
        }

        var matches = _findPlainTextMatches(String(textFrame.contents), findText, caseSensitive);
        if (matches.length > 0) {
          var frameChanged = false;
          // 从后往前仅修改命中范围，保留未命中文字的字体、颜色和段落样式。
          // 写入整个 textFrame.contents 会丢失框内混合格式。
          for (var mi = matches.length - 1; mi >= 0; mi--) {
            var range = textFrame.textRange.characters[matches[mi].index];
            range.length = matches[mi].length;
            range.contents = replaceText;
            replaceCount++;
            if (!frameChanged) { changedFrameCount++; frameChanged = true; }
          }
        }
      } catch (itemError) {
        skippedCount++;
      }
    }

    app.redraw();
    return _jsonObject([
      ["scanned", "n", textFrames.length],
      ["changed", "n", changedFrameCount],
      ["count", "n", replaceCount],
      ["skipped", "n", skippedCount]
    ]);
  } catch (e) {
    return _jsonError("替换失败：" + e.message);
  }
}

function _collectReplaceTextFrames(item, result) {
  if (!item) return;

  if (item.typename === "TextFrame") {
    for (var ri = 0; ri < result.length; ri++) if (result[ri] === item) return;
    result.push(item);
    return;
  }

  if (item.typename === "GroupItem" || item.typename === "Layer") {
    for (var i = 0; i < item.pageItems.length; i++)
      _collectReplaceTextFrames(item.pageItems[i], result);
  }
}

function _replacePlainText(source, findText, replaceText, caseSensitive) {
  var matches = _findPlainTextMatches(source, findText, caseSensitive);
  var output = source;
  for (var i = matches.length - 1; i >= 0; i--) {
    output = output.substring(0, matches[i].index) + replaceText + output.substring(matches[i].index + matches[i].length);
  }
  return { text: output, count: matches.length };
}

function _findPlainTextMatches(source, findText, caseSensitive) {
  var matches = [];
  if (!findText) return matches;
  // RegExp.index 保留原字符串索引；整串 toLowerCase 可能因 Unicode 扩展而错位。
  var escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var expression = new RegExp(escaped, caseSensitive ? "g" : "gi");
  var match;
  while ((match = expression.exec(source)) !== null) matches.push({ index: match.index, length: match[0].length });
  return matches;
}

function _isReplaceTextEditable(item) {
  var current = item;

  while (current && current.typename !== "Document") {
    try { if (current.locked === true) return false; } catch (e1) {}
    try { if (current.hidden === true) return false; } catch (e2) {}
    try { if (current.visible === false) return false; } catch (e3) {}
    current = current.parent;
  }

  return true;
}

function toolParametricArc(paramsJson) {
 var path = null;
 try {
 var params = _parseParams(paramsJson), W = Number(params.width), H = Number(params.height);
 if (!isFinite(W) || !isFinite(H) || W <= 0 || H <= 0) return _jsonError("请输入大于 0 的有效宽度和高度");
    // ===== 圆弧几何计算 =====
    var mm = 72 / 25.4;
    var a = W / 2;

    // 根据弦长和弓高计算圆半径
    var R = (a * a + H * H) / (2 * H);

    // 圆心位于圆弧顶点下方
    var cy = H - R;

    var start = Math.atan2(-cy, -a);
    var end = Math.atan2(-cy, a);

    // 保证从左端点沿上方圆弧走到右端点
    var sweep = start - end;
    if (sweep < 0) sweep += 2 * Math.PI;

    // 每段不超过45度，提高精度
    var segments = Math.max(
        1, Math.ceil(sweep / (Math.PI / 4))
    );

    var delta = sweep / segments;
    var k = 4 / 3 * Math.tan(delta / 4);

    // ===== Illustrator 文档 =====
    var doc = app.documents.length ?
        app.activeDocument :
        app.documents.add(DocumentColorSpace.RGB);

    path = doc.pathItems.add();

    path.stroked = true;
    path.filled = false;
    path.strokeWidth = 0.25 * mm;

    var black = new RGBColor();
    black.red = 0;
    black.green = 0;
    black.blue = 0;
    path.strokeColor = black;

    // ===== 生成圆弧 =====
    for (var i = 0; i <= segments; i++) {

        var t = start - i * delta;

        var x = a + R * Math.cos(t);
        var y = cy + R * Math.sin(t);

        var p = path.pathPoints.add();

        p.anchor = [x * mm, y * mm];
        p.pointType = PointType.SMOOTH;

        // 从左向右的切线方向
        var tx = Math.sin(t);
        var ty = -Math.cos(t);

        p.leftDirection = [
            (x - k * R * tx) * mm,
            (y - k * R * ty) * mm
        ];

        p.rightDirection = [
            (x + k * R * tx) * mm,
            (y + k * R * ty) * mm
        ];
    }

    // 开放路径
    path.closed = false;

    // 首尾控制柄
    path.pathPoints[0].leftDirection =
        path.pathPoints[0].anchor;

    path.pathPoints[segments].rightDirection =
        path.pathPoints[segments].anchor;

    // ===== 精确调整外接矩形 =====
    // 校准路径的几何外接矩形，不包含描边
    var bounds = path.geometricBounds;

    var actualW = bounds[2] - bounds[0];
    var actualH = bounds[1] - bounds[3];

    if (actualW > 0 && actualH > 0) {
        path.resize(
            W * mm / actualW * 100,
            H * mm / actualH * 100,
            true, true, true, true,
            100,
            Transformation.CENTER
        );
    }

    path.selected = true;


 return _jsonObject([["radius", "s", R.toFixed(4)]]);
 } catch (err) { if (path) { try { path.remove(); } catch (ignored) {} } return _jsonError("生成圆弧失败：" + (err.message || err)); }
}
