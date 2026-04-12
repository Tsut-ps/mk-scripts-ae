/**
 * 選択したコンポジションの長さを再帰的に一括変更する
 */

(function (thisObj) {
  // =====================================================
  // ユーティリティ
  // =====================================================

  /**
   * ルートコンポ配下のネストコンポを DFS で全収集（ルート自身は含まない）
   * depthMap に comp.id → 検出深さ を記録する
   */
  function collectNestedComps(rootComp, depthMap) {
    var visited = {};
    var result = [];
    visited[rootComp.id] = true;
    depthMap[rootComp.id] = 0;

    function dfs(comp, depth) {
      for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        if (layer.source instanceof CompItem) {
          var nested = layer.source;
          if (!visited[nested.id]) {
            visited[nested.id] = true;
            depthMap[nested.id] = depth;
            result.push(nested);
            dfs(nested, depth + 1);
          }
        }
      }
    }

    dfs(rootComp, 1);
    return result;
  }

  /**
   * 直接の子コンポだけ収集（1階層のみ・再帰なし）
   */
  function collectDirectChildComps(rootComp, depthMap) {
    var visited = {};
    var result = [];
    for (var i = 1; i <= rootComp.numLayers; i++) {
      var layer = rootComp.layer(i);
      if (layer.source instanceof CompItem) {
        var nested = layer.source;
        if (!visited[nested.id]) {
          visited[nested.id] = true;
          depthMap[nested.id] = 1;
          result.push(nested);
        }
      }
    }
    return result;
  }

  /**
   * コンプの duration を変更する
   * adjustLayersAtTail が true のとき、末尾に接していたレイヤーの
   * OutPoint を新しい尺に合わせて移動する（延長・短縮どちらの方向にも追従）
   * 誤差許容は 1フレームの半分（fps ベース）
   */
  function applyDuration(comp, newDuration, adjustLayersAtTail) {
    var oldDuration = comp.duration;
    comp.duration = newDuration;

    if (adjustLayersAtTail) {
      var eps = 1 / (comp.frameRate * 2);
      for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        if (Math.abs(layer.outPoint - oldDuration) <= eps) {
          layer.outPoint = newDuration;
        }
      }
    }

    return oldDuration;
  }

  /**
   * タイムコード文字列を検証して秒数に変換する。
   * 成功: { ok: true, seconds: Number }
   * 失敗: { ok: false, message: String }
   */
  function parseTimecode(tcStr, fps) {
    var parts = tcStr.split(":");
    if (parts.length !== 4) {
      return {
        ok: false,
        message: "タイムコードは HH:MM:SS:FF 形式で入力してください。",
      };
    }

    var hh = parseInt(parts[0], 10);
    var mm = parseInt(parts[1], 10);
    var ss = parseInt(parts[2], 10);
    var ff = parseInt(parts[3], 10);

    if (isNaN(hh) || isNaN(mm) || isNaN(ss) || isNaN(ff)) {
      return {
        ok: false,
        message: "タイムコードに数値以外の文字が含まれています。",
      };
    }
    if (mm < 0 || mm > 59) {
      return {
        ok: false,
        message:
          "分 (MM) は 0〜59 の範囲で入力してください。（入力値: " + mm + "）",
      };
    }
    if (ss < 0 || ss > 59) {
      return {
        ok: false,
        message:
          "秒 (SS) は 0〜59 の範囲で入力してください。（入力値: " + ss + "）",
      };
    }
    // 小数 fps（23.976 など）は Math.floor で整数フレーム数を算出
    var maxFrame = Math.floor(fps) - 1;
    if (ff < 0 || ff > maxFrame) {
      return {
        ok: false,
        message:
          "フレーム (FF) は 0〜" +
          maxFrame +
          " の範囲で入力してください。（コンプ fps: " +
          fps +
          "、入力値: " +
          ff +
          "）",
      };
    }

    var seconds = hh * 3600 + mm * 60 + ss + ff / fps;
    if (seconds <= 0) {
      return { ok: false, message: "0 より大きい尺を指定してください。" };
    }

    return { ok: true, seconds: seconds };
  }

  // =====================================================
  // UI 構築
  // =====================================================

  var win =
    thisObj instanceof Panel
      ? thisObj
      : new Window("palette", "再帰的コンポ尺変更");

  win.orientation = "column";
  win.alignChildren = ["fill", "top"];
  win.spacing = 8;
  win.margins = 14;

  // --- 対象コンポ ---
  var pnlTarget = win.add("panel", undefined, "対象コンポジション");
  pnlTarget.orientation = "column";
  pnlTarget.alignChildren = ["left", "top"];
  pnlTarget.margins = 12;
  pnlTarget.spacing = 6;

  var rbActive = pnlTarget.add(
    "radiobutton",
    undefined,
    "アクティブコンポジション（現在開いているコンプ）",
  );
  var rbSelected = pnlTarget.add(
    "radiobutton",
    undefined,
    "プロジェクトパネルで選択したコンポジション",
  );
  rbActive.value = true;

  // --- 尺設定 ---
  var pnlDuration = win.add("panel", undefined, "新しい尺");
  pnlDuration.orientation = "column";
  pnlDuration.alignChildren = ["left", "top"];
  pnlDuration.margins = 12;
  pnlDuration.spacing = 8;

  var grpMode = pnlDuration.add("group");
  grpMode.orientation = "row";
  grpMode.spacing = 10;
  var rbSeconds = grpMode.add("radiobutton", undefined, "秒数");
  var rbTC = grpMode.add(
    "radiobutton",
    undefined,
    "タイムコード (HH:MM:SS:FF)",
  );
  rbSeconds.value = true;

  var grpInput = pnlDuration.add("group");
  grpInput.orientation = "row";
  grpInput.alignChildren = ["left", "center"];
  grpInput.spacing = 6;
  grpInput.add("statictext", undefined, "値:");
  var etInput = grpInput.add("edittext", undefined, "10.0");
  etInput.characters = 14;
  var stUnit = grpInput.add("statictext", undefined, "秒");

  // モードごとに入力値を別変数で保持し、切り替え時に保存・復元する
  var savedSeconds = "10.0";
  var savedTC = "00:00:10:00";

  function updateInputMode() {
    if (rbSeconds.value) {
      savedTC = etInput.text;
      etInput.text = savedSeconds;
      stUnit.text = "秒";
    } else {
      savedSeconds = etInput.text;
      etInput.text = savedTC;
      stUnit.text = "(HH:MM:SS:FF)";
    }
  }
  rbSeconds.onClick = updateInputMode;
  rbTC.onClick = updateInputMode;

  // --- オプション ---
  var pnlOpts = win.add("panel", undefined, "オプション");
  pnlOpts.orientation = "column";
  pnlOpts.alignChildren = ["left", "top"];
  pnlOpts.margins = 12;
  pnlOpts.spacing = 6;

  var cbRecursive = pnlOpts.add(
    "checkbox",
    undefined,
    "再帰的に変更する（チェックなし＝直接の子コンポのみ）",
  );
  cbRecursive.value = true;

  var cbAdjustTail = pnlOpts.add(
    "checkbox",
    undefined,
    "コンプ末尾に接しているレイヤーの OutPoint を新しい尺に合わせる（延長・短縮どちらも追従）",
  );
  cbAdjustTail.value = true;

  // --- ログ ---
  var pnlLog = win.add("panel", undefined, "実行ログ");
  pnlLog.orientation = "column";
  pnlLog.alignChildren = ["fill", "top"];
  pnlLog.margins = 10;

  var etLog = pnlLog.add("edittext", undefined, "", {
    multiline: true,
    scrolling: true,
  });
  etLog.size = [420, 150];
  etLog.enabled = false;

  function appendLog(msg) {
    etLog.text += msg + "\n";
  }
  function clearLog() {
    etLog.text = "";
  }

  // --- ボタン ---
  var grpBtns = win.add("group");
  grpBtns.alignment = "right";
  grpBtns.spacing = 8;
  var btnRun = grpBtns.add("button", undefined, "▶ 実行");

  if (!(thisObj instanceof Panel)) {
    var btnClose = grpBtns.add("button", undefined, "閉じる", {
      name: "cancel",
    });
    btnClose.onClick = function () {
      win.close();
    };
  }

  // =====================================================
  // 実行処理
  // =====================================================

  btnRun.onClick = function () {
    clearLog();

    // --- ガード: プロジェクトが開いているか ---
    if (!app.project) {
      alert("プロジェクトが開いていません。");
      return;
    }

    // --- Step 1: ルートコンポを先に確定 ---
    var rootComp = null;
    if (rbActive.value) {
      rootComp = app.project.activeItem;
      if (!(rootComp instanceof CompItem)) {
        alert(
          "アクティブなコンポジションが見つかりません。\n" +
            "コンポジションを開いてから実行してください。",
        );
        return;
      }
    } else {
      var sel = app.project.selection;
      var selComps = [];
      for (var k = 0; k < sel.length; k++) {
        if (sel[k] instanceof CompItem) selComps.push(sel[k]);
      }
      if (selComps.length === 0) {
        alert("プロジェクトパネルでコンポジションを選択してください。");
        return;
      }
      rootComp = selComps[0];
      if (selComps.length > 1) {
        appendLog(
          "⚠ " +
            selComps.length +
            " 個のコンポジションが選択されています。\n" +
            "  先頭の「" +
            rootComp.name +
            "」のみを対象にします。\n",
        );
      }
    }

    // --- Step 2: rootComp の fps で尺をパース ---
    var fps = rootComp.frameRate;
    var newDuration = 0;

    if (rbSeconds.value) {
      newDuration = parseFloat(etInput.text);
      if (isNaN(newDuration) || newDuration <= 0) {
        alert("秒数は正の数値で入力してください。");
        return;
      }
    } else {
      var tcResult = parseTimecode(etInput.text, fps);
      if (!tcResult.ok) {
        alert(tcResult.message);
        return;
      }
      newDuration = tcResult.seconds;
    }

    var adjustTail = cbAdjustTail.value;
    var recursive = cbRecursive.value;
    var depthMap = {};
    var changedCount = 0;

    // --- Step 3: 変更前にネストを全収集（探索対象の状態を先に確定）---
    var nested = recursive
      ? collectNestedComps(rootComp, depthMap)
      : collectDirectChildComps(rootComp, depthMap);

    // --- Step 4: ルートとネストに duration を適用 ---
    app.beginUndoGroup("再帰的コンプ尺変更");

    try {
      appendLog("━━ ルートコンポジション ━━");
      var oldD = applyDuration(rootComp, newDuration, adjustTail);
      appendLog(
        "✔ [検出深さ 0] " +
          rootComp.name +
          "  " +
          oldD.toFixed(3) +
          "s → " +
          newDuration.toFixed(3) +
          "s",
      );
      changedCount++;

      if (nested.length > 0) {
        appendLog(
          "\n━━ ネストコンポジション (" +
            (recursive ? "再帰" : "直接の子のみ") +
            ") ━━",
        );
        for (var n = 0; n < nested.length; n++) {
          var depth =
            depthMap[nested[n].id] !== undefined ? depthMap[nested[n].id] : "?";
          var oldN = applyDuration(nested[n], newDuration, adjustTail);
          appendLog(
            "✔ [検出深さ " +
              depth +
              "] " +
              nested[n].name +
              "  " +
              oldN.toFixed(3) +
              "s → " +
              newDuration.toFixed(3) +
              "s",
          );
          changedCount++;
        }
      } else {
        appendLog("\n（ネストコンポジションはありません）");
      }

      appendLog(
        "\n✅ 完了：" + changedCount + " コンポジションを変更しました。",
      );
    } catch (e) {
      appendLog("❌ エラー: " + e.toString());
    } finally {
      app.endUndoGroup();
    }
  };

  // パネル / ウィンドウで表示方法を分ける
  if (win instanceof Window) {
    win.center();
    win.show();
  } else {
    win.layout.layout(true);
  }
})(this);
