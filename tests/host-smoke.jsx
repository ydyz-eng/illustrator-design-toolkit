/* Optional real-host smoke test. Attach using host-smoke.vbs; never launches Illustrator.
   Only the disposable document created here is changed or closed. */
(function () {
  var scriptFile = new File($.fileName);
  var root = scriptFile.parent.parent;
  var startedAt = String(new Date()), hostVersion = String(app.version);
  var original = app.documents.length ? app.activeDocument : null;
  var created = null, passed = [], diagnostics = [], failure = "", cleanupFailure = "";
  function check(condition, label) { if (!condition) throw new Error(label); passed.push(label); }
  function result(value) { return eval("(" + value + ")"); }
  function run(params) {
    var value = result(toolDimension(params));
    if (value.error) throw new Error(value.error);
    return value;
  }
  function allText(container, list) {
    for (var i = 0; i < container.pageItems.length; i++) {
      var item = container.pageItems[i];
      if (item.parent !== container) continue;
      if (item.typename === "TextFrame") list.push(item.contents);
      else if (item.typename === "GroupItem") allText(item, list);
    }
  }
  function addedLayer(snapshot) {
    var added = null;
    for (var i = 0; i < created.layers.length; i++) {
      var known = false;
      for (var j = 0; j < snapshot.length; j++) if (snapshot[j].layer === created.layers[i]) known = true;
      if (!known) {
        if (added) return null;
        added = created.layers[i];
      }
    }
    return added;
  }
  function layerDetails() {
    var details = [];
    for (var i = 0; i < created.layers.length; i++)
      details.push(created.layers[i].name + ": " + created.layers[i].pathItems.length + " paths");
    return details.join("; ");
  }
  function containsLayerName(name) {
    // Illustrator may throw even on an identity comparison with a removed
    // host object. Compare a saved primitive name against surviving objects.
    for (var i = 0; i < created.layers.length; i++) if (created.layers[i].name === name) return true;
    return false;
  }
  function sameRGB(one, two) {
    return one.typename === "RGBColor" && two.typename === "RGBColor" &&
      Math.abs(one.red - two.red) < 0.01 && Math.abs(one.green - two.green) < 0.01 && Math.abs(one.blue - two.blue) < 0.01;
  }
  function lockSnapshot() {
    var snapshot = [];
    for (var i = 0; i < created.layers.length; i++) snapshot.push({ layer: created.layers[i], locked: created.layers[i].locked });
    return snapshot;
  }
  function locksMatch(snapshot) {
    for (var i = 0; i < snapshot.length; i++) if (snapshot[i].layer.locked !== snapshot[i].locked) return false;
    return true;
  }
  function pointsMatch(path, selected) {
    for (var i = 0; i < selected.length; i++) if (String(path.pathPoints[i].selected) !== String(selected[i])) return false;
    return true;
  }
  function selectedPointValues(path) {
    var values = [];
    for (var i = 0; i < path.pathPoints.length; i++) values.push(String(path.pathPoints[i].selected));
    return values;
  }
  function hasPartialHandleSelection(path) {
    var selected = false, unselected = false, realHandle = false;
    for (var i = 0; i < path.pathPoints.length; i++) {
      var point = path.pathPoints[i], state = String(point.selected), anchor = point.anchor;
      if (state === String(PathPointSelection.NOSELECTION)) unselected = true;
      else selected = true;
      var leftSelected = state === String(PathPointSelection.LEFTDIRECTION) || state === String(PathPointSelection.LEFTRIGHTPOINT);
      var rightSelected = state === String(PathPointSelection.RIGHTDIRECTION) || state === String(PathPointSelection.LEFTRIGHTPOINT);
      if (leftSelected && (Math.abs(point.leftDirection[0] - anchor[0]) > 0.01 || Math.abs(point.leftDirection[1] - anchor[1]) > 0.01)) realHandle = true;
      if (rightSelected && (Math.abs(point.rightDirection[0] - anchor[0]) > 0.01 || Math.abs(point.rightDirection[1] - anchor[1]) > 0.01)) realHandle = true;
    }
    return selected && unselected && realHandle;
  }
  function checkSavedPointSnapshot(label, expected) {
    var saved = _dimensionPickSession.pointSelection || [], matches = saved.length === expected.length;
    for (var i = 0; matches && i < saved.length; i++) if (String(saved[i].selected) !== expected[i]) matches = false;
    check(matches, label + " snapshots actual normalized point selection");
  }
  function selectionDiagnostic(label, source, expectedLayer) {
    try {
      var selection = created.selection || [], items = [], pointStates = [], snapshot = [];
      for (var i = 0; i < selection.length; i++)
        items.push(i + ":" + selection[i].typename + ":source=" + (selection[i] === source));
      for (var p = 0; p < source.pathPoints.length; p++) {
        var point = source.pathPoints[p];
        pointStates.push(p + ":" + String(point.selected) + "(" + Number(point.selected) + ")" +
          ":anchor=" + point.anchor + ":left=" + point.leftDirection + ":right=" + point.rightDirection);
      }
      if (typeof _dimensionPickSession !== "undefined" && _dimensionPickSession) {
        var saved = _dimensionPickSession.pointSelection || [];
        for (var s = 0; s < saved.length; s++) snapshot.push(s + ":" + String(saved[s].selected) +
          "(" + Number(saved[s].selected) + ")" + ":anchor=" + saved[s].point.anchor);
      }
      diagnostics.push(label + " | selectionCount=" + selection.length + " | selectedItems=" + items.join(",") +
        " | activeLayer=" + created.activeLayer.name + ":expected=" + (created.activeLayer === expectedLayer) +
        " | points=" + pointStates.join(";") + " | sessionPointSnapshot=" + (snapshot.length ? snapshot.join(";") : "none"));
    } catch (diagnosticError) { diagnostics.push(label + " | diagnostic error: " + diagnosticError.message); }
  }
  function checkRestoredSelection(label, source, expectedLayer, selected) {
    check(created.selection.length === 1, label + " restores selection count");
    check(created.selection[0] === source, label + " restores source object identity");
    check(created.activeLayer === expectedLayer, label + " restores active layer");
    check(pointsMatch(source, selected), label + " restores original partial anchor and handle selection");
  }
  function groupWithLabel(container, label) {
    for (var i = 0; i < container.pageItems.length; i++) {
      var item = container.pageItems[i];
      if (item.parent !== container) continue;
      if (item.typename === "TextFrame" && item.contents === label) return container;
      if (item.typename === "GroupItem") {
        var found = groupWithLabel(item, label);
        if (found) return found;
      }
    }
    return null;
  }
  function ownedLayers(layers, found) {
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i], owned = false;
      // Read-only assertions must include layers temporarily locked by capture.
      // The production finder intentionally skips them when choosing an output layer.
      for (var j = 0; j < layer.groupItems.length; j++) {
        var group = layer.groupItems[j], marker = _dimensionMarker(group);
        if (group.parent === layer && (marker === "AI_DESIGN_TOOLBOX_DIMENSION_V1|layer" ||
            /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|[0-9]+$/.test(marker))) owned = true;
      }
      if (owned) found.push(layer);
      ownedLayers(layer.layers, found);
    }
    return found;
  }
  function ownedLayerForReading() {
    var layers = ownedLayers(created.layers, []);
    return layers.length ? layers[0] : null;
  }
  function batchCount() {
    var layers = ownedLayers(created.layers, []), count = 0;
    for (var l = 0; l < layers.length; l++) {
      var layer = layers[l];
      for (var i = 0; i < layer.groupItems.length; i++) {
        var group = layer.groupItems[i];
        if (group.parent === layer && /^AI_DESIGN_TOOLBOX_DIMENSION_V1\|batch\|[0-9]+$/.test(_dimensionMarker(group))) count++;
      }
    }
    return count;
  }
  function hasDimensionLineAt(group, origin, normal, signedOffset) {
    for (var i = 0; i < group.pathItems.length; i++) {
      var points = group.pathItems[i].pathPoints;
      if (points.length !== 2) continue;
      var a = points[0].anchor, b = points[1].anchor;
      var aOffset = (a[0] - origin[0]) * normal[0] + (a[1] - origin[1]) * normal[1];
      var bOffset = (b[0] - origin[0]) * normal[0] + (b[1] - origin[1]) * normal[1];
      if (Math.abs(aOffset - signedOffset) < 0.01 && Math.abs(bOffset - signedOffset) < 0.01 &&
          Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 0.01) return true;
    }
    return false;
  }
  try {
    $.evalFile(new File(root.fsName + "/jsx/tools.jsx"));
    $.evalFile(new File(root.fsName + "/jsx/dimension-pick.jsx"));
    // Never disturb a user-owned point capture in another document.
    if (result(toolDimensionPickStatus()).active) throw new Error("Finish or cancel the existing point capture before running host smoke");
    created = app.documents.add(DocumentColorSpace.RGB, 600, 500);
    var artworkLayer = created.activeLayer;
    artworkLayer.name = "Disposable smoke artwork";
    var first = artworkLayer.pathItems.rectangle(400, 50, 72, 36);
    first.filled = false; first.stroked = true; first.strokeWidth = 2;
    var second = artworkLayer.pathItems.rectangle(300, 180, 72, 36);
    second.filled = false; second.stroked = false;
    created.selection = [first];
    var each = run({ mode: "each", decimals: 2 });
    check(each.count === 1 && each.dimensionCount === 2, "each creates two axes");
    check(created.selection.length === 1 && created.selection[0] === first, "selection restored");
    check(created.activeLayer === artworkLayer, "active layer restored");
    var ownedLayer = ownedLayerForReading(), labels = [];
    allText(ownedLayer, labels);
    check(labels.join("|").indexOf("25.4 mm") >= 0 && labels.join("|").indexOf("12.7 mm") >= 0, "physical unit labels correct");
    var batch = null;
    for (var i = 0; i < ownedLayer.groupItems.length; i++) {
      if (/\|batch\|/.test(_dimensionMarker(ownedLayer.groupItems[i]))) { batch = ownedLayer.groupItems[i]; break; }
    }
    check(batch && batch.groupItems.length === 2, "one grouped annotation per axis");
    var cleared = result(clearDimensionLayer("last"));
    check(!cleared.error && cleared.removedCount === 1, "last batch clears");
    created.selection = [first, second];
    var overall = run({ mode: "overall", bounds: "visible" });
    check(overall.count === 2 && overall.dimensionCount === 2, "overall visible bounds");
    var gap = run({ mode: "gap", arrowStyle: "open", widthPosition: "top", heightPosition: "left" });
    check(gap.dimensionCount === 2, "horizontal and vertical edge gaps");
    created.selection = null;
    var artboard = run({ mode: "artboard", arrowStyle: "tick", showUnit: false, prefix: "W ", suffix: " test", scale: 2 });
    check(artboard.dimensionCount === 2, "artboard works without selection");
    var clip = artworkLayer.groupItems.add();
    var hiddenExtent = clip.pathItems.rectangle(240, 280, 180, 160);
    hiddenExtent.filled = true; hiddenExtent.stroked = false;
    var mask = clip.pathItems.rectangle(220, 300, 72, 36);
    mask.filled = false; mask.stroked = false; mask.clipping = true;
    clip.clipped = true;
    created.selection = [clip];
    var clipBounds = _dimensionBounds(clip, "visible");
    check(Math.abs(clipBounds[2] - clipBounds[0] - 72) < 0.001, "clipping ignores hidden extents");
    check(run({ bounds: "visible" }).dimensionCount === 2, "clipped group can be annotated");
    var narrow = artworkLayer.pathItems.rectangle(80, 50, 2, 2);
    created.selection = [narrow];
    check(run({ fontSize: 14, customColor: "#7357FF", color: "custom" }).dimensionCount === 2, "narrow custom-color annotations");
    var legacy = created.layers.add(); legacy.name = "尺寸标注";
    var legacyArt = legacy.pathItems.rectangle(50, 20, 10, 10);
    created.selection = [first]; created.activeLayer = artworkLayer;
    var removed = result(clearDimensionLayer("all"));
    check(!removed.error && removed.removedCount === 5, "all batches clear");
    check(legacyArt.parent === legacy && legacy.pageItems.length === 1, "same-name user layer preserved");
    check(created.selection.length === 1 && created.selection[0] === first && created.activeLayer === artworkLayer, "clear restores selection and layer");

    // New features are tested after the original five-batch clear expectation.
    var strokeColor = new RGBColor(); strokeColor.red = 205; strokeColor.green = 37; strokeColor.blue = 89;
    first.strokeColor = strokeColor; first.strokeWidth = 2.5; first.strokeDashes = [4, 2]; first.strokeDashOffset = 1;
    first.strokeCap = StrokeCap.ROUNDENDCAP; first.strokeJoin = StrokeJoin.ROUNDENDJOIN; first.opacity = 67;
    var beforeFlangeLayers = lockSnapshot();
    var flange = result(toolFlange({ widthMm: 3.25, angleDeg: 45, top: true, bottom: true, left: true, right: true, chop: true }));
    check(!flange.error && flange.count === 4, "all four styled flanges generated");
    // Identify the new layer by object identity. Its localized display name is
    // not the geometry contract and can be decoded differently by script loaders.
    var flangeLayer = addedLayer(beforeFlangeLayers);
    check(flangeLayer && flangeLayer.pathItems.length === 4,
      "flanges are independent paths in a new layer" + (!flangeLayer || flangeLayer.pathItems.length !== 4 ? " [" + layerDetails() + "]" : ""));
    for (var f = 0; f < flangeLayer.pathItems.length; f++) {
      var flangePath = flangeLayer.pathItems[f];
      check(!flangePath.filled && flangePath.stroked && sameRGB(flangePath.strokeColor, first.strokeColor) &&
        Math.abs(flangePath.strokeWidth - first.strokeWidth) < 0.001 &&
        flangePath.strokeDashes[0] === first.strokeDashes[0] && flangePath.strokeDashes[1] === first.strokeDashes[1] &&
        flangePath.strokeDashOffset === first.strokeDashOffset && flangePath.strokeCap === first.strokeCap &&
        flangePath.strokeJoin === first.strokeJoin && Math.abs(flangePath.opacity - first.opacity) < 0.001,
        "flange " + (f + 1) + " retains no-fill and full dashed stroke format");
      check(flangePath.closed && flangePath.pathPoints.length === 4, "flange " + (f + 1) + " has four closed corners");
    }
    var fillColor = new RGBColor(); fillColor.red = 23; fillColor.green = 147; fillColor.blue = 211;
    second.filled = true; second.fillColor = fillColor; second.stroked = false;
    created.selection = [second];
    var beforeFilledLayers = lockSnapshot();
    var filledFlange = result(toolFlange({ widthMm: 4, angleDeg: 45, top: true, chop: false }));
    var filledLayer = addedLayer(beforeFilledLayers);
    check(!filledFlange.error && filledFlange.count === 1 && filledLayer && filledLayer.pathItems.length === 1,
      "single outer-side flange generated");
    check(filledLayer.pathItems[0].filled && !filledLayer.pathItems[0].stroked &&
      sameRGB(filledLayer.pathItems[0].fillColor, second.fillColor), "single flange retains fill and no-stroke format");

    var diagonal = artworkLayer.pathItems.add();
    diagonal.setEntirePath([[60, 100], [132, 196]]); diagonal.closed = false; diagonal.filled = false; diagonal.stroked = true;
    created.selection = [diagonal]; created.activeLayer = artworkLayer;
    check(run({ mode: "aligned", unit: "pt", prefix: "EDGE ", decimals: 2 }).dimensionCount === 1,
      "aligned edge generates one true-length annotation");
    var alignedText = []; allText(ownedLayerForReading(), alignedText);
    check(alignedText.join("|").indexOf("EDGE 120 pt") >= 0, "diagonal annotation uses Euclidean length");
    check(created.selection.length === 1 && created.selection[0] === diagonal && created.activeLayer === artworkLayer,
      "aligned measurement restores source selection and layer");
    created.selection = null;
    check(run({ mode: "points", points: [[10, 10], [82, 106]], unit: "pt", prefix: "POINT " }).dimensionCount === 1,
      "explicit arbitrary points work without selection");
    var pointsText = []; allText(ownedLayerForReading(), pointsText);
    check(pointsText.join("|").indexOf("POINT 120 pt") >= 0, "arbitrary points use true distance");

    var nestedLocked = artworkLayer.layers.add(); nestedLocked.name = "Prelocked nested layer"; nestedLocked.locked = true;
    var nestedOpen = artworkLayer.layers.add(); nestedOpen.name = "Unlocked nested layer"; nestedOpen.locked = false;
    var originallyLocked = created.layers.add(); originallyLocked.name = "Prelocked top layer"; originallyLocked.locked = true;
    created.activeLayer = artworkLayer; created.selection = [first];
    // LEFTDIRECTION needs a real handle. A rectangle's coincident handle is not
    // a valid fixture for asserting restoration of a selected curve direction.
    var handleAnchor = first.pathPoints[2].anchor;
    first.pathPoints[2].leftDirection = [handleAnchor[0] - 8, handleAnchor[1] + 8];
    var requestedPoints = [PathPointSelection.ANCHORPOINT, PathPointSelection.NOSELECTION,
      PathPointSelection.LEFTDIRECTION, PathPointSelection.NOSELECTION];
    for (var sp = 0; sp < requestedPoints.length; sp++) first.pathPoints[sp].selected = requestedPoints[sp];
    // Illustrator normalizes adjacent anchor/handle selection when assigning a
    // later point. Preserve its final actual state, not an unrealizable sequence
    // of individual setter values. Strings keep this expectation host-independent.
    var selectedPoints = selectedPointValues(first);
    diagnostics.push("requested point setters | " + requestedPoints.join(";") +
      " | actual expected snapshot=" + selectedPoints.join(";"));
    selectionDiagnostic("before native capture", first, artworkLayer);
    check(hasPartialHandleSelection(first), "fixture provides actual partial selection including a real selected handle");
    var previousLocks = lockSnapshot();
    var picking = result(toolDimensionPickBegin());
    selectionDiagnostic("after native capture begins (saved point snapshot)", first, artworkLayer);
    check(!picking.error && picking.active && picking.token, "native point capture begins");
    checkSavedPointSnapshot("native begin", selectedPoints);
    var captureLayer = created.activeLayer;
    var captureLayerName = "HOST_SMOKE_TWO_POINT_" + picking.token;
    captureLayer.name = captureLayerName;
    check(captureLayer !== artworkLayer && artworkLayer.locked && originallyLocked.locked && !captureLayer.locked,
      "capture isolates drawing and protects source layers");
    check(result(toolDimensionPickStatus(picking.token)).phase === "waiting", "capture initially waits for two clicks");
    var helper = captureLayer.pathItems.add(); helper.setEntirePath([[220, 180], [292, 276]]);
    helper.closed = false; helper.filled = false; helper.stroked = true; created.selection = [helper];
    check(result(toolDimensionPickStatus(picking.token)).phase === "ready", "native two-point helper becomes ready");
    var finished = result(toolDimensionPickFinish({ pickToken: picking.token, unit: "pt", prefix: "PICK " }));
    selectionDiagnostic("after native capture finishes", first, artworkLayer);
    check(!finished.error && finished.dimensionCount === 1 && finished.picking === false, "native point capture finishes");
    check(!containsLayerName(captureLayerName) && created.layers.length === previousLocks.length &&
      !result(toolDimensionPickStatus()).active, "finish removes only the capture helper layer");
    check(locksMatch(previousLocks) && nestedLocked.locked && !nestedOpen.locked, "finish restores parent and nested layer locks");
    checkRestoredSelection("finish", first, artworkLayer, selectedPoints);
    var pickedText = []; allText(ownedLayerForReading(), pickedText);
    check(pickedText.join("|").indexOf("PICK 120 pt") >= 0, "native picked coordinates use true distance");

    previousLocks = lockSnapshot();
    selectedPoints = selectedPointValues(first);
    selectionDiagnostic("before cancelled capture", first, artworkLayer);
    var cancelPick = result(toolDimensionPickBegin());
    selectionDiagnostic("after cancelled capture begins (saved point snapshot)", first, artworkLayer);
    check(!cancelPick.error && cancelPick.active, "second capture can begin");
    checkSavedPointSnapshot("cancel begin", selectedPoints);
    var cancelLayer = created.activeLayer;
    var cancelLayerName = "HOST_SMOKE_CANCEL_" + cancelPick.token;
    cancelLayer.name = cancelLayerName;
    var onePoint = cancelLayer.pathItems.add(); onePoint.setEntirePath([[210, 150]]); onePoint.closed = false;
    check(result(toolDimensionPickStatus(cancelPick.token)).phase === "waiting", "single clicked point remains pending");
    var cancelled = result(toolDimensionPickCancel(cancelPick.token));
    selectionDiagnostic("after cancelled capture restores", first, artworkLayer);
    check(!cancelled.error && !cancelled.active && !containsLayerName(cancelLayerName) &&
      created.layers.length === previousLocks.length, "cancel removes the single-point helper");
    check(locksMatch(previousLocks) && nestedLocked.locked && !nestedOpen.locked, "cancel restores all layer locks");
    checkRestoredSelection("cancel", first, artworkLayer, selectedPoints);

    // Simulate native Pen anchors in this disposable document. This exercises
    // the real geometry and automatic completion; manual clicks are a separate UI smoke.
    for (var sideIndex = 0; sideIndex < 2; sideIndex++) {
      var signedDistance = sideIndex === 0 ? 30 : -42;
      var autoPrefix = sideIndex === 0 ? "AUTO LEFT " : "AUTO RIGHT ";
      var expectedLabel = autoPrefix + "240.000 pt";
      var beforeBatches = batchCount();
      previousLocks = lockSnapshot();
      selectedPoints = selectedPointValues(first);
      selectionDiagnostic(autoPrefix + "before capture", first, artworkLayer);
      var autoPick = result(toolDimensionPickBegin('{"interaction":"threeClick","settings":{' +
        '"unit":"pt","decimals":3,"trimZeros":false,"scale":2,"fontSize":12,' +
        '"strokeWidth":1.25,"arrowStyle":"none","color":"custom","customColor":"#178FD3",' +
        '"prefix":"' + autoPrefix + '"}}'));
      selectionDiagnostic(autoPrefix + "after capture begins (saved point snapshot)", first, artworkLayer);
      check(!autoPick.error && autoPick.active && autoPick.interaction === "threeClick" &&
        autoPick.neededPoints === 3 && autoPick.pointCount === 0 && autoPick.phase === "waitingStart",
        autoPrefix + "capture accepts JSON settings and waits for start");
      checkSavedPointSnapshot(autoPrefix + "begin", selectedPoints);
      var autoLayer = created.activeLayer;
      var autoLayerName = "HOST_SMOKE_AUTO_" + autoPick.token;
      autoLayer.name = autoLayerName;
      check(autoLayer !== artworkLayer && artworkLayer.locked && originallyLocked.locked && !autoLayer.locked,
        autoPrefix + "capture protects existing artwork");
      var pendingStart = result(toolDimensionPickPoll(autoPick.token));
      check(!pendingStart.error && pendingStart.active && pendingStart.phase === "waitingStart",
        autoPrefix + "poll with zero anchors remains pending");
      var autoHelper = autoLayer.pathItems.add();
      autoHelper.setEntirePath([[220, 180]]);
      autoHelper.closed = false; autoHelper.filled = false; autoHelper.stroked = true;
      var pendingEnd = result(toolDimensionPickPoll(autoPick.token));
      check(!pendingEnd.error && pendingEnd.active && pendingEnd.phase === "waitingEnd" && pendingEnd.pointCount === 1,
        autoPrefix + "first anchor waits for endpoint");
      autoHelper.setEntirePath([[220, 180], [292, 276]]);
      var pendingPlacementRaw = toolDimensionPickPoll(autoPick.token);
      diagnostics.push(autoPrefix + "two-point poll=" + pendingPlacementRaw +
        " | batchesBefore=" + beforeBatches + " | batchesNow=" + batchCount());
      var pendingPlacement = result(pendingPlacementRaw);
      check(!pendingPlacement.error && pendingPlacement.active && pendingPlacement.phase === "waitingPlacement" &&
        pendingPlacement.pointCount === 2 && batchCount() === beforeBatches,
        autoPrefix + "two anchors wait for placement without generating dimensions");
      // Unit tangent = [0.6, 0.8], unit left normal = [-0.8, 0.6].
      autoHelper.setEntirePath([[220, 180], [292, 276], [256 - 0.8 * signedDistance, 228 + 0.6 * signedDistance]]);
      created.selection = [autoHelper];
      var automaticRaw = toolDimensionPickPoll(autoPick.token);
      diagnostics.push(autoPrefix + "automatic poll=" + automaticRaw +
        " | batchesBefore=" + beforeBatches + " | batchesNow=" + batchCount());
      var automatic = result(automaticRaw);
      selectionDiagnostic(autoPrefix + "after automatic completion", first, artworkLayer);
      check(!automatic.error && automatic.active === false && automatic.completed === true &&
        automatic.dimensionCount === 1 && automatic.token === autoPick.token,
        autoPrefix + "third anchor automatically creates one dimension");
      check(batchCount() === beforeBatches + 1, autoPrefix + "automatic completion creates exactly one batch");
      var autoGroup = groupWithLabel(ownedLayerForReading(), expectedLabel);
      check(!!autoGroup, autoPrefix + "stored units, multiplier, precision and prefix are applied");
      check(hasDimensionLineAt(autoGroup, [220, 180], [-0.8, 0.6], signedDistance),
        autoPrefix + "third anchor sets exact perpendicular offset and side");
      var autoColor = new RGBColor(); autoColor.red = 23; autoColor.green = 143; autoColor.blue = 211;
      var autoText = autoGroup.textFrames[0];
      check(Math.abs(autoText.textRange.characterAttributes.size - 12) < 0.01 &&
        sameRGB(autoText.textRange.characterAttributes.fillColor, autoColor),
        autoPrefix + "stored font size and custom color are applied");
      var strokesMatch = autoGroup.pathItems.length > 0;
      for (var ap = 0; ap < autoGroup.pathItems.length; ap++) {
        var autoPath = autoGroup.pathItems[ap];
        if (!autoPath.stroked || autoPath.filled || Math.abs(autoPath.strokeWidth - 1.25) > 0.01 ||
            !sameRGB(autoPath.strokeColor, autoColor)) strokesMatch = false;
      }
      check(strokesMatch, autoPrefix + "stored stroke format and no-arrow setting are applied");
      check(!containsLayerName(autoLayerName) && created.layers.length === previousLocks.length &&
        !result(toolDimensionPickStatus()).active,
        autoPrefix + "automatic completion removes its capture helper");
      check(locksMatch(previousLocks) && nestedLocked.locked && !nestedOpen.locked,
        autoPrefix + "automatic completion restores layer locks");
      checkRestoredSelection(autoPrefix + "automatic completion", first, artworkLayer, selectedPoints);
      var afterAutoItems = ownedLayerForReading().pageItems.length;
      var repeatPoll = result(toolDimensionPickPoll(autoPick.token));
      var repeatFinish = result(toolDimensionPickFinish({ pickToken: autoPick.token }));
      check(!repeatPoll.error && repeatPoll.completed && !repeatFinish.error && repeatFinish.completed &&
        batchCount() === beforeBatches + 1 && ownedLayerForReading().pageItems.length === afterAutoItems,
        autoPrefix + "repeated poll or finish returns completion without duplicate artwork");
    }
  } catch (e) {
    failure = String(e.message || e) + (e.line ? " (line " + e.line + ")" : "");
  } finally {
    try {
      if (created && typeof _dimensionPickSession !== "undefined" && _dimensionPickSession && _dimensionPickSession.doc === created)
        toolDimensionPickCancel(_dimensionPickSession.token);
    } catch (pickCleanupError) { cleanupFailure += "capture: " + pickCleanupError.message; }
    try { if (created) created.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) { cleanupFailure += "close: " + closeError.message; }
    try { if (original) original.activate(); } catch (activateError) { cleanupFailure += " restore: " + activateError.message; }
  }
  var message = "HOST_SMOKE " + (failure || cleanupFailure ? "FAIL" : "PASS") + " | " + passed.length + " checks" +
    " | Illustrator " + hostVersion + " | started " + startedAt;
  if (failure) message += " | " + failure;
  if (cleanupFailure) message += " | " + cleanupFailure;
  var output = new File(scriptFile.parent.fsName + "/host-smoke-result.txt");
  output.encoding = "UTF-8";
  if (output.open("w")) {
    output.write(message + "\n" + passed.join("\n") + (diagnostics.length ? "\nDIAGNOSTICS\n" + diagnostics.join("\n") : ""));
    output.close();
  }
  return message;
}());
