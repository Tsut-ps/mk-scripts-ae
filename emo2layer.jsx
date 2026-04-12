/**
 * emo2layer.jsx
 * 指定レイヤーを登録し、任意の場所のマーカーで排他的に表示を切り替える
 */

(function emo2layer(thisObj) {
  // 共通定数
  var CTRL_PREFIX = "[C] ";
  var EXPR_SIGNATURE = "emo2layerCtrlMarker";
  var BUTTON_HEIGHT = 24;
  var LABEL_WIDTH = 40;
  var DROPDOWN_MIN_WIDTH = 140;
  var GRID_MIN_BUTTON_WIDTH = 60;
  var GRID_SPACING = 6;
  var MARKER_EPSILON = 0.0001;

  // アクティブなコンポを返す
  function getActiveComp() {
    var item = app.project ? app.project.activeItem : null;
    return item && item instanceof CompItem ? item : null;
  }

  // プロジェクト内のコンポ一覧
  function getProjectComps() {
    var comps = [];
    if (!app.project) return comps;

    for (var i = 1; i <= app.project.numItems; i++) {
      var item = app.project.item(i);
      if (item instanceof CompItem) comps.push(item);
    }
    return comps;
  }

  function findCompByName(name) {
    var comps = getProjectComps();
    for (var i = 0; i < comps.length; i++) {
      if (comps[i].name === name) return comps[i];
    }
    return null;
  }

  function getSelectedComp(dropdown) {
    return dropdown.selection ? findCompByName(dropdown.selection.text) : null;
  }

  function getCtrlLayerName(targetCompName) {
    return CTRL_PREFIX + targetCompName;
  }

  // 現在時刻に有効な CTRL レイヤーを探す
  function findCtrlLayerInComp(ctrlComp, targetCompName, time) {
    if (!ctrlComp) return null;

    var ctrlName = getCtrlLayerName(targetCompName);
    var fallback = null;

    for (var i = 1; i <= ctrlComp.numLayers; i++) {
      var layer = ctrlComp.layer(i);
      if (layer.name !== ctrlName) continue;
      if (!fallback) fallback = layer;
      if (time >= layer.inPoint && time < layer.outPoint) return layer;
    }

    return fallback;
  }

  function createCtrlLayer(ctrlComp, targetCompName) {
    var layer = findCtrlLayerInComp(ctrlComp, targetCompName, 0);
    if (layer) return layer;

    layer = ctrlComp.layers.addNull(ctrlComp.duration);
    layer.name = getCtrlLayerName(targetCompName);
    layer.startTime = 0;
    layer.inPoint = 0;
    layer.outPoint = ctrlComp.duration;
    layer.shy = true;
    layer.guideLayer = true;
    layer.label = 11;
    return layer;
  }

  function buildOpacityExpression(ctrlCompName, targetCompName) {
    return [
      "// " + EXPR_SIGNATURE,
      'var ctrlComp = comp("' + ctrlCompName + '");',
      'var ctrlName = "' + getCtrlLayerName(targetCompName) + '";',
      "function findCtrlLayer() {",
      "  var fallback = null;",
      "  for (var i = 1; i <= ctrlComp.numLayers; i++) {",
      "    var layer = ctrlComp.layer(i);",
      "    if (layer.name !== ctrlName) continue;",
      "    if (!fallback) fallback = layer;",
      "    if (time >= layer.inPoint && time < layer.outPoint) return layer;",
      "  }",
      "  return fallback;",
      "}",
      "function getCurrentMarkerName(ctrlLayer) {",
      "  if (!ctrlLayer) return null;",
      "  var marker = ctrlLayer.marker;",
      "  if (marker.numKeys === 0) return null;",
      "  var index = marker.nearestKey(time).index;",
      "  if (marker.key(index).time > time) index--;",
      "  if (index < 1) return null;",
      "  return marker.key(index).comment;",
      "}",
      "var ctrlLayer = findCtrlLayer();",
      "var markerName = getCurrentMarkerName(ctrlLayer);",
      "markerName !== null && thisLayer.name === markerName ? 100 : 0;",
    ].join("\n");
  }

  function isRegistered(layer) {
    if (!layer) return false;
    try {
      return layer.transform.opacity.expression.indexOf(EXPR_SIGNATURE) >= 0;
    } catch (e) {
      return false;
    }
  }

  // 選択レイヤーを登録する
  function registerSelectedLayers(targetComp, ctrlCompName) {
    var selectedLayers = targetComp.selectedLayers;
    if (!selectedLayers || selectedLayers.length === 0) return 0;

    var expression = buildOpacityExpression(ctrlCompName, targetComp.name);
    var count = 0;

    app.beginUndoGroup("emo2layer: Register");
    try {
      for (var i = 0; i < selectedLayers.length; i++) {
        var layer = selectedLayers[i];
        if (!layer) continue;
        layer.transform.opacity.expression = expression;
        layer.enabled = true;
        count++;
      }
    } finally {
      app.endUndoGroup();
    }

    return count;
  }

  // 登録済みレイヤー名を重複なしで集める
  function collectMarkerNames(targetComp) {
    var names = [];
    var seen = {};
    if (!targetComp) return names;

    for (var i = 1; i <= targetComp.numLayers; i++) {
      var layer = targetComp.layer(i);
      if (!isRegistered(layer) || seen[layer.name]) continue;
      seen[layer.name] = true;
      names.push(layer.name);
    }

    return names;
  }

  function countRegisteredLayers(targetComp) {
    var count = 0;
    if (!targetComp) return 0;

    for (var i = 1; i <= targetComp.numLayers; i++) {
      if (isRegistered(targetComp.layer(i))) count++;
    }

    return count;
  }

  // 同時刻のマーカーは置き換える
  function removeMarkerAtTime(layer, time) {
    if (!layer) return;

    try {
      var marker = layer.property("Marker");
      for (var i = marker.numKeys; i >= 1; i--) {
        if (Math.abs(marker.keyTime(i) - time) < MARKER_EPSILON) {
          marker.removeKey(i);
        }
      }
    } catch (e) {}
  }

  // CTRL レイヤーへマーカー名を書き込む
  function writeMarkerName(targetComp, ctrlComp, markerName) {
    var ctrlLayer = findCtrlLayerInComp(
      ctrlComp,
      targetComp.name,
      targetComp.time,
    );
    if (!ctrlLayer) return false;

    app.beginUndoGroup("emo2layer: Write Marker");
    try {
      removeMarkerAtTime(ctrlLayer, targetComp.time);
      ctrlLayer
        .property("Marker")
        .setValueAtTime(targetComp.time, new MarkerValue(markerName));
    } finally {
      app.endUndoGroup();
    }

    return true;
  }

  function lockButtonSize(button, width, height) {
    button.preferredSize = [width, height];
    button.minimumSize = [width, height];
    button.maximumSize = [width, height];
  }

  // 対象・制御 の行 UI
  function addCompRow(parent, labelText, buttonText) {
    var row = parent.add("group");
    row.orientation = "row";
    row.alignment = ["fill", "top"];
    row.alignChildren = ["left", "center"];
    row.spacing = 6;

    var field = row.add("group");
    field.orientation = "row";
    field.alignment = ["fill", "center"];
    field.alignChildren = ["left", "center"];
    field.spacing = 6;

    var label = field.add("statictext", undefined, labelText);
    label.preferredSize = [LABEL_WIDTH, BUTTON_HEIGHT];

    var dropdown = field.add("dropdownlist", undefined, []);
    dropdown.alignment = ["fill", "center"];
    dropdown.minimumSize = [DROPDOWN_MIN_WIDTH, BUTTON_HEIGHT];
    dropdown.preferredSize.height = BUTTON_HEIGHT;

    var button = row.add("button", undefined, buttonText);
    button.alignment = ["right", "center"];
    lockButtonSize(button, 120, BUTTON_HEIGHT);

    return { dropdown: dropdown, button: button };
  }

  // ドロップダウンをコンポ一覧で作り直す
  function rebuildDropdown(dropdown, selectedName) {
    var comps = getProjectComps();
    dropdown.removeAll();

    for (var i = 0; i < comps.length; i++) {
      dropdown.add("item", comps[i].name);
    }

    if (dropdown.items.length === 0) return;

    for (var j = 0; j < dropdown.items.length; j++) {
      if (dropdown.items[j].text === selectedName) {
        dropdown.selection = j;
        return;
      }
    }

    dropdown.selection = 0;
  }

  // パネル幅に応じてマーカーボタンの列数を決める
  function getGridColumns() {
    if (columnDropdown.selection && columnDropdown.selection.text !== "Auto") {
      return parseInt(columnDropdown.selection.text, 10);
    }

    var width = markerGridPanel.size ? markerGridPanel.size.width : 360;
    var columns = Math.floor(width / (GRID_MIN_BUTTON_WIDTH + GRID_SPACING));
    if (columns < 1) columns = 1;
    if (columns > 4) columns = 4;
    return columns;
  }

  function getGridButtonWidth(columns) {
    var width = markerGridPanel.size ? markerGridPanel.size.width : 360;
    var margins = markerGridPanel.margins;
    var innerWidth = width - margins.left - margins.right;
    var buttonWidth = Math.floor(
      (innerWidth - (columns - 1) * GRID_SPACING) / columns,
    );
    if (buttonWidth < GRID_MIN_BUTTON_WIDTH)
      buttonWidth = GRID_MIN_BUTTON_WIDTH;
    return buttonWidth;
  }

  var win =
    thisObj instanceof Panel
      ? thisObj
      : new Window("palette", "emo2layer", undefined, {
          resizeable: true,
        });

  win.orientation = "column";
  win.alignChildren = ["fill", "top"];
  win.spacing = 8;
  win.margins = 10;

  var topRow = win.add("group");
  topRow.orientation = "row";
  topRow.alignment = ["fill", "top"];
  topRow.alignChildren = ["left", "center"];
  topRow.spacing = 6;

  var title = topRow.add("statictext", undefined, "レイヤーセレクター");
  title.graphics.font = ScriptUI.newFont(
    title.graphics.font.name,
    "BOLD",
    title.graphics.font.size + 1,
  );

  var topSpacer = topRow.add("group");
  topSpacer.alignment = ["fill", "center"];

  var helpBtn = topRow.add("button", undefined, "Help");
  helpBtn.alignment = ["right", "center"];
  helpBtn.helpTip = "使い方を表示";
  lockButtonSize(helpBtn, 64, BUTTON_HEIGHT);

  var targetRow = addCompRow(win, "対象", "レイヤー登録");
  var ctrlRow = addCompRow(win, "制御", "CTRL作成");

  var infoRow = win.add("group");
  infoRow.orientation = "row";
  infoRow.alignChildren = ["left", "center"];
  infoRow.spacing = 12;

  var targetStatusInfo = infoRow.add("statictext", undefined, "対象 -");
  var ctrlStatusInfo = infoRow.add("statictext", undefined, "制御 -");
  var ctrlLayerInfo = infoRow.add("statictext", undefined, "CTRL -");

  var markerHeaderRow = win.add("group");
  markerHeaderRow.orientation = "row";
  markerHeaderRow.alignChildren = ["left", "center"];
  markerHeaderRow.spacing = 10;

  var markerCountInfo = markerHeaderRow.add(
    "statictext",
    undefined,
    "登録レイヤー: 0 / マーカー数: 0",
  );
  markerHeaderRow.add("statictext", undefined, "列");

  var columnDropdown = markerHeaderRow.add("dropdownlist", undefined, [
    "Auto",
    "1",
    "2",
    "3",
    "4",
  ]);
  columnDropdown.selection = 0;

  var markerGridPanel = win.add("panel");
  markerGridPanel.alignment = ["fill", "fill"];
  markerGridPanel.margins = 8;

  var markerGrid = markerGridPanel.add("group");
  markerGrid.orientation = "column";
  markerGrid.alignChildren = ["fill", "top"];
  markerGrid.alignment = ["fill", "fill"];
  markerGrid.spacing = GRID_SPACING;

  var statusText = win.add(
    "statictext",
    undefined,
    "対象コンポと制御コンポを選択してください。",
  );
  statusText.alignment = ["fill", "bottom"];

  var currentMarkerNames = [];
  var currentSelectedMarker = null;
  var isRebuildingGrid = false;

  function setStatus(text) {
    statusText.text = text;
  }

  function showHelpDialog() {
    var dialog = new Window("dialog", "使い方");
    dialog.orientation = "column";
    dialog.alignChildren = ["fill", "top"];
    dialog.margins = 16;
    dialog.spacing = 8;
    dialog.add(
      "statictext",
      undefined,
      "1. 対象コンポと制御コンポを選択します。",
    );
    dialog.add(
      "statictext",
      undefined,
      "2. 必要なら CTRL作成 で制御用レイヤーを作ります。",
    );
    dialog.add(
      "statictext",
      undefined,
      "3. 対象コンポでレイヤーを選択して レイヤー登録 を押します。",
    );
    dialog.add(
      "statictext",
      undefined,
      "4. マーカーボタンを押すと、CTRLレイヤーの現在時間に名前を書き込みます。",
    );
    dialog.add("button", undefined, "閉じる", { name: "ok" });
    dialog.show();
  }

  // 選択状態に応じて上部の情報表示を更新
  function updateInfo(targetComp) {
    var ctrlComp = getSelectedComp(ctrlRow.dropdown);
    var ctrlLayer =
      targetComp && ctrlComp
        ? findCtrlLayerInComp(ctrlComp, targetComp.name, targetComp.time)
        : null;

    targetStatusInfo.text = targetComp ? "対象 OK" : "対象 -";
    ctrlStatusInfo.text = ctrlComp ? "制御 OK" : "制御 -";
    ctrlLayerInfo.text = ctrlLayer ? "CTRL OK" : "CTRL -";
    markerCountInfo.text =
      "登録レイヤー: " +
      countRegisteredLayers(targetComp) +
      " / マーカー数: " +
      currentMarkerNames.length;
  }

  // リサイズ時は既存ボタンの幅だけ更新する
  function resizeGridButtons() {
    var columns = getGridColumns();
    var buttonWidth = getGridButtonWidth(columns);

    for (var i = 0; i < markerGrid.children.length; i++) {
      var row = markerGrid.children[i];
      for (var j = 0; j < row.children.length; j++) {
        row.children[j].size = [buttonWidth, BUTTON_HEIGHT];
      }
    }

    markerGrid.layout.layout(true);
    markerGridPanel.layout.layout(true);
  }

  // ボタンの並び自体を作り直す
  function rebuildMarkerGrid() {
    if (isRebuildingGrid) return;
    isRebuildingGrid = true;

    try {
      for (var i = markerGrid.children.length - 1; i >= 0; i--) {
        markerGrid.remove(markerGrid.children[i]);
      }

      var columns = getGridColumns();
      var total = currentMarkerNames.length;
      var rowsPerColumn = total > 0 ? Math.ceil(total / columns) : 0;
      var buttonWidth = getGridButtonWidth(columns);

      for (var rowIndex = 0; rowIndex < rowsPerColumn; rowIndex++) {
        var row = markerGrid.add("group");
        row.orientation = "row";
        row.alignment = ["fill", "top"];
        row.alignChildren = ["left", "center"];
        row.spacing = GRID_SPACING;

        for (var colIndex = 0; colIndex < columns; colIndex++) {
          var index = colIndex * rowsPerColumn + rowIndex;
          if (index >= total) break;

          var markerName = currentMarkerNames[index];
          var button = row.add(
            "button",
            undefined,
            currentSelectedMarker === markerName
              ? "[" + markerName + "]"
              : markerName,
          );
          button.size = [buttonWidth, BUTTON_HEIGHT];
          button.helpTip = markerName;
          button.onClick = (function (name) {
            return function () {
              var targetComp = getSelectedComp(targetRow.dropdown);
              var ctrlComp = getSelectedComp(ctrlRow.dropdown);

              if (!targetComp) {
                setStatus("対象コンポを選択してください。");
                return;
              }
              if (!ctrlComp) {
                setStatus("制御コンポを選択してください。");
                return;
              }

              var ctrlLayer = findCtrlLayerInComp(
                ctrlComp,
                targetComp.name,
                targetComp.time,
              );
              if (!ctrlLayer) {
                setStatus(
                  "先に CTRL を作成してください。 " +
                    ctrlComp.name +
                    " に " +
                    getCtrlLayerName(targetComp.name) +
                    " が必要です。",
                );
                return;
              }

              currentSelectedMarker = name;
              if (!writeMarkerName(targetComp, ctrlComp, name)) return;

              rebuildMarkerGrid();
              setStatus(
                "マーカー「" +
                  name +
                  "」を " +
                  ctrlComp.name +
                  " / " +
                  ctrlLayer.name +
                  " の現在時間に書き込みました。",
              );
            };
          })(markerName);
        }
      }

      markerGrid.layout.layout(true);
      markerGridPanel.layout.layout(true);
    } finally {
      isRebuildingGrid = false;
    }
  }

  function rebuildList() {
    var targetComp = getSelectedComp(targetRow.dropdown);
    currentMarkerNames = collectMarkerNames(targetComp);

    if (currentSelectedMarker) {
      var found = false;
      for (var i = 0; i < currentMarkerNames.length; i++) {
        if (currentMarkerNames[i] === currentSelectedMarker) {
          found = true;
          break;
        }
      }
      if (!found) currentSelectedMarker = null;
    }

    updateInfo(targetComp);
    rebuildMarkerGrid();

    if (!targetComp) {
      setStatus("対象コンポを選択してください。");
    }
  }

  helpBtn.onClick = function () {
    showHelpDialog();
  };

  ctrlRow.button.onClick = function () {
    var targetComp = getSelectedComp(targetRow.dropdown);
    var ctrlComp = getSelectedComp(ctrlRow.dropdown);

    if (!targetComp) {
      setStatus("対象コンポを選択してください。");
      return;
    }
    if (!ctrlComp) {
      setStatus("制御コンポを選択してください。");
      return;
    }

    var ctrlLayer = createCtrlLayer(ctrlComp, targetComp.name);
    rebuildList();
    setStatus("CTRLを作成しました: " + ctrlComp.name + " / " + ctrlLayer.name);
  };

  targetRow.button.onClick = function () {
    var targetComp = getSelectedComp(targetRow.dropdown);
    var ctrlComp = getSelectedComp(ctrlRow.dropdown);

    if (!targetComp) {
      setStatus("対象コンポを選択してください。");
      return;
    }
    if (!ctrlComp) {
      setStatus("制御コンポを選択してください。");
      return;
    }

    var activeComp = getActiveComp();
    if (!activeComp || activeComp.name !== targetComp.name) {
      setStatus(
        "レイヤー登録をするには、対象コンポをアクティブにしてください: " +
          targetComp.name,
      );
      return;
    }

    var count = registerSelectedLayers(targetComp, ctrlComp.name);
    rebuildList();
    setStatus(
      count +
        " レイヤーを登録しました。対象コンポで選択していたレイヤーが反映されています。",
    );
  };

  targetRow.dropdown.onChange = function () {
    rebuildList();
  };

  ctrlRow.dropdown.onChange = function () {
    rebuildList();
  };

  columnDropdown.onChange = function () {
    rebuildMarkerGrid();
  };

  win.onResizing = win.onResize = function () {
    this.layout.resize();
    resizeGridButtons();
  };

  var activeComp = getActiveComp();
  var activeCompName = activeComp ? activeComp.name : null;
  rebuildDropdown(targetRow.dropdown, activeCompName);
  rebuildDropdown(ctrlRow.dropdown, activeCompName);
  rebuildList();

  if (win instanceof Window) {
    win.center();
    win.show();
  } else {
    win.layout.layout(true);
  }
})(this);
