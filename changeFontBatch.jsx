/**
 * 選択中のテキストレイヤーに、最後に選択したレイヤーのフォントを一括コピーします。
 * キーフレームが設定されたテキストにも対応しています
 *
 * 使い方:
 *   1. フォントを揃えたいテキストレイヤーを選択する
 *   2. 最後に見本にしたいテキストレイヤーを追加選択する
 *   3. スクリプトを実行する（Motion Tools Pro などに設定すると便利です）
 */
(function copyFontFromLastSelectedTextLayer() {
  app.beginUndoGroup("Copy Font From Last Selected Text Layer");

  try {
    var comp = app.project.activeItem;
    if (!(comp && comp instanceof CompItem)) {
      alert("コンポジションを開いてください。");
      return;
    }

    var selectedLayers = comp.selectedLayers;
    if (selectedLayers.length < 2) {
      alert(
        "2つ以上選択してください。\n最後に選択したレイヤーが見本になります。",
      );
      return;
    }

    var sourceLayer = selectedLayers[selectedLayers.length - 1];
    if (!(sourceLayer instanceof TextLayer)) {
      alert("最後に選択したレイヤーがテキストレイヤーではありません。");
      return;
    }

    var sourceTextProp = sourceLayer
      .property("ADBE Text Properties")
      .property("ADBE Text Document");
    if (!sourceTextProp) {
      alert("見本レイヤーのソーステキストが取得できませんでした。");
      return;
    }

    var sourceTextDocument = sourceTextProp.value;
    var targetFont = sourceTextDocument.font;
    var changedCount = 0;
    var skippedCount = 0;
    var errors = [];
    var i;

    for (i = 0; i < selectedLayers.length - 1; i++) {
      var layer = selectedLayers[i];
      if (!(layer instanceof TextLayer)) {
        skippedCount++;
        continue;
      }

      var targetTextProp = layer
        .property("ADBE Text Properties")
        .property("ADBE Text Document");
      if (!targetTextProp) {
        skippedCount++;
        continue;
      }

      try {
        if (targetTextProp.numKeys > 0) {
          var k;
          for (k = 1; k <= targetTextProp.numKeys; k++) {
            var keyedTextDocument = targetTextProp.keyValue(k);
            keyedTextDocument.font = targetFont;
            targetTextProp.setValueAtKey(k, keyedTextDocument);
          }
        } else {
          var textDocument = targetTextProp.value;
          textDocument.font = targetFont;
          targetTextProp.setValue(textDocument);
        }

        changedCount++;
      } catch (layerError) {
        skippedCount++;
        errors.push(layer.name + " (" + layerError.toString() + ")");
      }
    }

    var message =
      "フォントのコピーが完了しました。\n" +
      "見本: " +
      sourceLayer.name +
      "\n" +
      "フォント: " +
      targetFont +
      "\n" +
      "変更: " +
      changedCount +
      " レイヤー\n" +
      "スキップ: " +
      skippedCount +
      " レイヤー";

    if (errors.length > 0) {
      message += "\n\nエラー:\n" + errors.join("\n");
    }

    alert(message);
  } catch (error) {
    alert("エラーが発生しました: " + error.toString());
  } finally {
    app.endUndoGroup();
  }
})();
