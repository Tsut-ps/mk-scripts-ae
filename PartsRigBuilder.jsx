/*
 * PartsRigBuilder.jsx  -  After Effects 用 パーツ制御ビルダー（ScriptUI パネル）
 *
 * 指定したコンポの階層（親コンポ → 子コンポ → パーツレイヤー）を、スライダー形式の制御エフェクトとして
 * 1か所にまとめ、位置・拡大率・回転の調整と一括スタッガー（時間差）を行えるようにする。
 *
 * インストール:
 *   Scripts/ScriptUI Panels/ に置いて After Effects を再起動し、ウィンドウメニューから開く。
 *   （ファイル > スクリプト > スクリプトファイルを実行 から、1回だけ実行してもよい）
 * 必要な設定:
 *   環境設定 > スクリプトとエクスプレッション >「スクリプトによるファイルへの書き込みとネットワークへのアクセスを許可」
 *   （疑似エフェクトの定義ファイルを一時フォルダに書き出して適用するため）
 *
 * 文字コード: UTF-8（BOM付き）。編集するときは、BOM を残したまま保存すること（外すと日本語が文字化けする）。
 * 
 * ここに記載されている仕様は、After Effects の公式仕様ではなく、実際のプリセットファイルを解析して得たものであるため、
 * 実際の動作と一致しない可能性があります。また、将来のバージョンで仕様が変更される可能性もあります。使用には十分注意してください（無保証）
 */
(function (thisObj) {
/* ================================================================
 * 疑似エフェクト(.ffx)の「ひな型」データ
 *
 * .ffx は、パラメーター（スライダー・チェックボックスなど）ごとに決まった形のバイト列を並べたファイルである。
 * 公式の仕様は公開されていないため、実際のプリセットファイルを解析して、
 * 「種類ごとに毎回同じになる部分」だけをここに記録している。
 * 名前・初期値・スライダー範囲など、パラメーターごとに変わる部分は、生成時（第1部）に上書きする。
 *
 * ひな型の大部分は 0 で、0 以外のバイトはわずかしかない。
 * そこで「全体の長さ」と「0 以外の部分（位置, 16進のバイト列）」だけで書き表している。
 * 意味が分かっている箇所には名前とコメントを付けている。
 * 意味が分からない箇所は 0 のままにしている（After Effects は、その箇所が 0 でも疑似エフェクトを登録できる）。
 *
 * 1パラメーターを構成するチャンク:
 *   pard = パラメーター定義 148 バイト（種類・名前・既定値・範囲）
 *   tdbs = 値まわりの入れ物。中身は次の順に並ぶ
 *     tdsb = 区分 / tdsn = 表示名 / tdb4 = 表示属性 / cdat = 現在値 / tdpi = 参照レイヤー番号 /
 *     tdum, tduM = スライダー操作範囲の最小・最大
 * ================================================================ */

/* 長さ length バイトの 0 埋めデータに、runs = [[開始位置, "16進のバイト列"], ...] を書き込み、16進文字列で返す */
function makeTemplateHex(length, runs) {
  var bytes = [], i, run, hex, k;
  for (i = 0; i < length; i++) bytes[i] = 0;
  for (i = 0; i < runs.length; i++) {
    run = runs[i];
    hex = run[1];
    for (k = 0; k < hex.length; k += 2) {
      bytes[run[0] + k / 2] = parseInt(hex.substr(k, 2), 16);
    }
  }
  hex = "";
  for (i = 0; i < length; i++) hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return hex;
}

/* 整数を、ビッグエンディアンの byteCount バイトの16進文字列にする（-1 は全ビット 1） */
function hexOfInteger(value, byteCount) {
  var hex = (value >>> 0).toString(16);
  while (hex.length < byteCount * 2) hex = "0" + hex;
  return hex.substr(hex.length - byteCount * 2);
}

/* ---------- 共通の固定値 ---------- */

/* 倍精度浮動小数点数 1.0 のバイト列 */
var TEMPLATE_DOUBLE_ONE = "3ff0000000000000";

/* パラメーター定義(pard)の長さ、状態データ(tdb4)の長さ */
var TEMPLATE_PARD_LENGTH = 148;
var TEMPLATE_TDB4_LENGTH = 124;

/* pard の先頭から 12 バイト目の 32 ビット整数が「パラメーターの種類」。ルートだけは 0 */
var TEMPLATE_PARD_TYPE_OFFSET = 12;
var PARD_TYPE = { POINT: 6, POPUP: 7, SLIDER: 10, CHECK: 4, GROUP: 13, GROUP_END: 14 };

/* pard の 48 バイト目の 32 ビット整数は動作フラグ。値 2 = 「キーフレームを打てない」。
   ルートとポップアップに付いている */
var TEMPLATE_BEHAVIOR_FLAGS_OFFSET = 48;
var BEHAVIOR_FLAG_NO_KEYFRAMES = 2;

/* ルート項目だけが持つ値。pard の 56 バイト目(32ビット) = 1、128 バイト目(32ビット) = -1 */
var TEMPLATE_ROOT_PARD_RUNS = [[56, hexOfInteger(1, 4)], [128, hexOfInteger(-1, 4)]];

/* 状態データ(tdb4)の先頭 16 バイトは、32 ビット整数 4 個
   [型の署名, 時間の目盛り(または配置), 状態フラグ, 変化率] で構成される。 */
var TDB4_SIGNATURE = {
  DISCRETE: 0xdb990001,    /* 段階的な値（チェックボックス・ポップアップ・ルート） */
  CONTINUOUS: 0xbd990001,  /* 連続的な値（スライダー・グループ） */
  POINT: 0xdb990002        /* 2次元座標 */
};
var TDB4_TIME_SCALE = 0x10000;
var TDB4_POINT_LAYOUT = 0x000f0003;
var TDB4_FLAGS = {
  ROOT: 0x10000,
  STEP: 0x10004,      /* 補間しない値（キーフレーム間を滑らかに変化させない） */
  ANIMATED: 0x100ff   /* 通常のアニメーション可能な値 */
};
var TDB4_RATE = { ROOT: 600, PROPERTY: 23976 };

/* 状態データ(tdb4)の先頭 16 バイトを作る。引数は上記 4 つの整数 */
function makeTdb4Head(signature, timeScale, flags, rate) {
  return [[0, hexOfInteger(signature, 4) + hexOfInteger(timeScale, 4) + hexOfInteger(flags, 4) + hexOfInteger(rate, 4)]];
}

/* tdpi の値。ルートは 1、グループの終了は 0 */
var TDPI_ROOT = 1;
var TDPI_END = 0;

/* 各種類の状態データ(tdb4)を、位置と値の組(runs)から作る */
function makeTdb4(runs) {
  return makeTemplateHex(TEMPLATE_TDB4_LENGTH, runs);
}

/* 1つの項目を構成する tdbs の中身のうち、種類によらず先頭に来る 2 つ（区分・表示名）。
   表示名は生成時に必ず上書きするので、ひな型では空にしておく */
function makeTdbsLeading(partitionNumber) {
  return [["tdsb", hexOfInteger(partitionNumber, 4)], ["tdsn", ""]];
}

/* ---------- ひな型本体 ---------- */

var FFX_TEMPLATE = {
  /* ファイル先頭のヘッダー(16バイト) = 32 ビット整数 4 個 [3, 68, 1, 0x01000000]。
     先頭 3 つの意味は未解析、最後は形式の版 */
  head: hexOfInteger(3, 4) + hexOfInteger(68, 4) + hexOfInteger(1, 4) + hexOfInteger(0x01000000, 4),

  /* エフェクト全体の設定(56バイト)。内訳:
     32ビット整数 [1, 1, 0, 変化率 23976, 0, 0] / 16ビット整数 [100, 100, 100, 100] /
     倍精度 [1.0, 1.0] / 32ビット整数 [0, -1] */
  beso: hexOfInteger(1, 4) + hexOfInteger(1, 4) + hexOfInteger(0, 4) + hexOfInteger(TDB4_RATE.PROPERTY, 4) +
    hexOfInteger(0, 4) + hexOfInteger(0, 4) +
    hexOfInteger(100, 2) + hexOfInteger(100, 2) + hexOfInteger(100, 2) + hexOfInteger(100, 2) +
    TEMPLATE_DOUBLE_ONE + TEMPLATE_DOUBLE_ONE + hexOfInteger(0, 4) + hexOfInteger(-1, 4),

  /* ファイル名の欄(48バイト)。使わないので 0 のまま */
  fnam: makeTemplateHex(48, []),

  /* ルート（エフェクト自身を表す先頭の項目）。名前は持たない */
  root: {
    pard: makeTemplateHex(TEMPLATE_PARD_LENGTH,
      [[TEMPLATE_BEHAVIOR_FLAGS_OFFSET, hexOfInteger(BEHAVIOR_FLAG_NO_KEYFRAMES, 4)]].concat(TEMPLATE_ROOT_PARD_RUNS)),
    tdbs: makeTdbsLeading(3).concat([
      ["tdb4", makeTdb4(makeTdb4Head(TDB4_SIGNATURE.DISCRETE, TDB4_TIME_SCALE, TDB4_FLAGS.ROOT, TDB4_RATE.ROOT))],
      ["cdat", makeTemplateHex(40, [])],
      ["tdpi", hexOfInteger(TDPI_ROOT, 4)]
    ])
  },

  /* グループの開始 */
  group: {
    pard: makeTemplateHex(TEMPLATE_PARD_LENGTH, [[TEMPLATE_PARD_TYPE_OFFSET, hexOfInteger(PARD_TYPE.GROUP, 4)]]),
    tdbs: makeTdbsLeading(1).concat([
      ["tdb4", makeTdb4(makeTdb4Head(TDB4_SIGNATURE.CONTINUOUS, TDB4_TIME_SCALE, TDB4_FLAGS.STEP, TDB4_RATE.PROPERTY))],
      ["cdat", makeTemplateHex(40, [])]
    ])
  },

  /* グループの終了。名前は持たない */
  end: {
    pard: makeTemplateHex(TEMPLATE_PARD_LENGTH, [[TEMPLATE_PARD_TYPE_OFFSET, hexOfInteger(PARD_TYPE.GROUP_END, 4)]]),
    tdbs: makeTdbsLeading(1).concat([
      ["tdb4", makeTdb4(makeTdb4Head(TDB4_SIGNATURE.CONTINUOUS, TDB4_TIME_SCALE, TDB4_FLAGS.STEP, TDB4_RATE.PROPERTY))],
      ["cdat", makeTemplateHex(40, [])],
      ["tdpi", hexOfInteger(TDPI_END, 4)]
    ])
  },

  /* チェックボックス。既定値は pard の位置 60 と cdat の先頭 8 バイトで、生成時に書き込む */
  check: {
    pard: makeTemplateHex(TEMPLATE_PARD_LENGTH, [[TEMPLATE_PARD_TYPE_OFFSET, hexOfInteger(PARD_TYPE.CHECK, 4)]]),
    tdbs: makeTdbsLeading(1).concat([
      ["tdb4", makeTdb4(makeTdb4Head(TDB4_SIGNATURE.DISCRETE, TDB4_TIME_SCALE, TDB4_FLAGS.STEP, TDB4_RATE.PROPERTY))],
      ["cdat", makeTemplateHex(40, [])]
    ])
  },

  /* ポップアップ（ドロップダウン）。選択肢の文字列は pdnm チャンクに、既定値は pard と cdat に生成時に書き込む。
     pard の位置 61 の値 3 は選択肢の個数欄に見えるが、実ファイルでは選択肢が 1 つでも 3 だったため、そのまま再現している */
  popup: {
    pard: makeTemplateHex(TEMPLATE_PARD_LENGTH, [[TEMPLATE_PARD_TYPE_OFFSET, hexOfInteger(PARD_TYPE.POPUP, 4)],
      [TEMPLATE_BEHAVIOR_FLAGS_OFFSET, hexOfInteger(BEHAVIOR_FLAG_NO_KEYFRAMES, 4)], [61, "03"]]),
    tdbs: makeTdbsLeading(1).concat([
      ["tdb4", makeTdb4(makeTdb4Head(TDB4_SIGNATURE.DISCRETE, TDB4_TIME_SCALE, TDB4_FLAGS.ANIMATED, TDB4_RATE.PROPERTY))],
      ["cdat", makeTemplateHex(40, [])]
    ])
  },

  /* スライダー。値の範囲・既定値・小数桁数は pard に、操作範囲は tdum / tduM に、生成時に書き込む */
  slider: {
    pard: makeTemplateHex(TEMPLATE_PARD_LENGTH, [[TEMPLATE_PARD_TYPE_OFFSET, hexOfInteger(PARD_TYPE.SLIDER, 4)]]),
    tdbs: makeTdbsLeading(1).concat([
      ["tdb4", makeTdb4(makeTdb4Head(TDB4_SIGNATURE.CONTINUOUS, TDB4_TIME_SCALE, TDB4_FLAGS.ANIMATED, TDB4_RATE.PROPERTY))],
      ["cdat", makeTemplateHex(40, [])],
      ["tdum", makeTemplateHex(8, [])],
      ["tduM", makeTemplateHex(8, [])]
    ])
  },

  /* ポイント（X・Y の2次元座標）。現在値の欄(cdat)だけ他より 8 バイト長い。
     状態データの先頭は [署名, 配置 0x000f0003, -1, 変化率] */
  point: {
    pard: makeTemplateHex(TEMPLATE_PARD_LENGTH, [[TEMPLATE_PARD_TYPE_OFFSET, hexOfInteger(PARD_TYPE.POINT, 4)]]),
    tdbs: makeTdbsLeading(1).concat([
      ["tdb4", makeTdb4(makeTdb4Head(TDB4_SIGNATURE.POINT, TDB4_POINT_LAYOUT, -1, TDB4_RATE.PROPERTY))],
      ["cdat", makeTemplateHex(48, [])]
    ])
  }
};

/* ================================================================
 * 第1部: バイナリ処理 + 疑似エフェクト(.ffx)ジェネレーター
 *
 * After Effects のスクリプトAPIには疑似エフェクトを新規定義する機能がないため、
 * プリセット(.ffx)をその場でバイナリとして生成し、applyPreset で適用する。
 * ExtendScript は ES3 相当でバイト配列型を持たないので、
 * 1文字 = 1バイトの文字列（以下「バイナリ文字列」）としてバイト列を扱う。
 * ================================================================ */

/* ---------- 定数 ---------- */

/* パラメーター定義(pard)チャンクの大きさと、書き換える項目のバイト位置。実ファイルの解析で特定した値。
   pard の中身は 32 ビット整数が中心で、ここで指定するのは「書き換える1バイト（または数バイト）」の位置:
     種類        : 12 バイト目からの 32 ビット整数（ひな型で設定済みなので書き換えない）
     動作フラグ  : 48 バイト目からの 32 ビット整数。フラグは下位バイト(51 バイト目)にある
     ポップアップ: 56 バイト目からの 32 ビット整数 = 選択中の番号(下位バイトが 59)、62 バイト目からの 16 ビット整数 = 既定の番号(下位バイトが 63)
                   (60 バイト目の 16 ビット整数は選択肢の数に関係なく 3 で固定。選択肢の数は pdnm 側だけが持つ)
     チェック    : 60 バイト目 = 既定値(0 / 1)
     スライダー  : 104 バイト目から単精度浮動小数点数が 5 個
                   [入力できる最小, 入力できる最大, スライダーの最小, スライダーの最大, 既定値]、続けて 16 ビット整数で小数桁数、さらに 16 ビット整数で表示単位 */
/* スライダーの表示単位(126 バイト目の 16 ビット整数)。実ファイル 3 種(なし / パーセント / ピクセル)で確認した値 */
var SLIDER_UNITS = { NONE: 0, PERCENT: 1, PIXELS: 2 };
var PARD_SIZE = 148;
var PARD_OFFSET = {
  NAME: 16,
  POPUP_VALUE: 59,
  CHECK_DEFAULT: 60,
  POPUP_DEFAULT: 63,
  SLIDER_VALID_MIN: 104,
  SLIDER_VALID_MAX: 108,
  SLIDER_MIN: 112,
  SLIDER_MAX: 116,
  SLIDER_DEFAULT: 120,
  SLIDER_PRECISION: 124,
  SLIDER_UNITS: 126
};

/* 名前の欄は NUL 終端を含めて 32 バイト。AE の名前上限に合わせて本文は 31 バイトまで */
var PARD_NAME_FIELD_LENGTH = 32;
var PARAM_NAME_MAX_BYTES = 31;

/* グループの開閉状態は .ffx に保存されない(開いた状態と閉じた状態で書き出したファイルのバイナリ部分が完全に一致する)。
   適用したグループは常に閉じた状態で追加されるため、開閉を指定する機能は持たない */

/* 各チャンクが持つ名前欄(tdmn)は 40 バイト固定 */
var MATCH_NAME_FIELD_LENGTH = 40;

/* 生成方法（バイト列の組み立て方）を変えたときに上げる版番号。matchName のハッシュに含める。
   同じ matchName のまま中身だけ変わると、After Effects が先に読んだ古い定義を使い回すため */
var FFX_GENERATOR_VERSION = "g4";

/* 疑似エフェクトの matchName は "Pseudo/" で始める決まり。"PRB" は本ツール名(PartsRigBuilder)の略。
   この接頭辞で「自分が作ったエフェクト」を見分けるので、既存リグを認識し続けるために値を変えないこと */
var EFFECT_MATCH_PREFIX = "Pseudo/PRB-";

/* matchName の末尾に付ける連番の桁数（"-0000" 形式） */
var MATCH_NAME_SERIAL_DIGITS = 4;

/* RIFX 全体の先頭に置く形式タグ（FaFX = After Effects のプリセット） */
var FFX_FORM_TYPE = "FaFX";

/* 2進数・数値変換で使う定数 */
var BIT_EXPONENT_BIAS_DOUBLE = 1023;
var BIT_EXPONENT_BIAS_SINGLE = 127;
var TWO_POW_20 = 1048576;
var TWO_POW_23 = 8388608;
var TWO_POW_31 = 2147483648;
var TWO_POW_32 = 4294967296;

/* matchName のハッシュ計算に使う係数。2種類を連結して衝突しにくくする */
var HASH_PARAMS = [
  { multiplier: 31, seed: 7 },
  { multiplier: 131, seed: 11 }
];
var HASH_SECOND_HEX_LENGTH = 4;

/* ---------- 文字列・バイト列の変換 ---------- */

/* 16進文字列（例 "0a1b"）を、1文字=1バイトのバイナリ文字列に変換する */
function hexToBinaryString(hex) {
  var result = "", i;
  for (i = 0; i < hex.length; i += 2) {
    result += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return result;
}

/* 32ビット符号なし整数を、ビッグエンディアン4バイトのバイナリ文字列にする（RIFX はビッグエンディアン） */
function uint32BE(value) {
  value = value >>> 0;
  return String.fromCharCode((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

/* 16ビット符号なし整数を、ビッグエンディアン2バイトのバイナリ文字列にする */
function uint16BE(value) {
  return String.fromCharCode((value >>> 8) & 255, value & 255);
}

/* 値が 0 のバイトを count 個並べたバイナリ文字列を返す */
function zeroBytes(count) {
  var result = "";
  while (count > 0) {
    result += "\0";
    count--;
  }
  return result;
}

/* バイナリ文字列 binary を、length バイトになるまで末尾を 0 で埋める（長ければそのまま） */
function padWithZeros(binary, length) {
  return binary.length >= length ? binary : binary + zeroBytes(length - binary.length);
}

/* 数値を 4 桁の 0 埋め文字列にする（matchName の連番用） */
function padNumberTo4Digits(number) {
  var text = String(number);
  while (text.length < MATCH_NAME_SERIAL_DIGITS) text = "0" + text;
  return text;
}

/* 数値を指数部 e と仮数部 m（1 <= m < 2）に分解する。Math.log の丸め誤差で e が1ずれるのを補正する
   （ExtendScript には DataView 等がなく、IEEE754 のビット列を自前で組み立てる必要があるため） */
function splitFloatParts(absoluteValue) {
  var exponent = Math.floor(Math.log(absoluteValue) / Math.LN2);
  if (Math.pow(2, exponent) > absoluteValue) exponent--;
  else if (Math.pow(2, exponent + 1) <= absoluteValue) exponent++;
  return { exponent: exponent, mantissa: absoluteValue / Math.pow(2, exponent) - 1 };
}

/* 数値を IEEE754 倍精度（8バイト、ビッグエンディアン）のバイナリ文字列にする */
function float64BE(value) {
  var sign = 0, parts, mantissaHigh, mantissaLow, highWord;
  if (value === 0) return zeroBytes(8);
  if (value < 0) {
    sign = 1;
    value = -value;
  }
  parts = splitFloatParts(value);
  mantissaHigh = Math.floor(parts.mantissa * TWO_POW_20);
  mantissaLow = Math.floor((parts.mantissa * TWO_POW_20 - mantissaHigh) * TWO_POW_32);
  highWord = (sign * TWO_POW_31) + ((parts.exponent + BIT_EXPONENT_BIAS_DOUBLE) * TWO_POW_20) + mantissaHigh;
  return uint32BE(highWord) + uint32BE(mantissaLow);
}

/* 数値を IEEE754 単精度（4バイト、ビッグエンディアン）のバイナリ文字列にする */
function float32BE(value) {
  var sign = 0, parts, mantissa, exponent, bits;
  if (value === 0) return zeroBytes(4);
  if (value < 0) {
    sign = 1;
    value = -value;
  }
  parts = splitFloatParts(value);
  exponent = parts.exponent;
  mantissa = Math.round(parts.mantissa * TWO_POW_23);
  /* 丸めで仮数が桁あふれしたら、指数を1つ繰り上げる */
  if (mantissa >= TWO_POW_23) {
    mantissa = 0;
    exponent++;
  }
  bits = (sign * TWO_POW_31) + ((exponent + BIT_EXPONENT_BIAS_SINGLE) * TWO_POW_23) + mantissa;
  return uint32BE(bits);
}

/* 文字列を UTF-8 のバイナリ文字列にする（日本語のパラメーター名をファイルに書くため） */
function encodeUtf8(text) {
  var result = "", i, code, nextCode;
  for (i = 0; i < text.length; i++) {
    code = text.charCodeAt(i);
    /* サロゲートペア（絵文字など）は2文字で1つのコードポイントとして扱う */
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      nextCode = text.charCodeAt(i + 1);
      if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
        code = 0x10000 + ((code - 0xD800) * 1024) + (nextCode - 0xDC00);
        i++;
      }
    }
    if (code < 0x80) {
      result += String.fromCharCode(code);
    } else if (code < 0x800) {
      result += String.fromCharCode(0xC0 | (code >> 6), 0x80 | (code & 63));
    } else if (code < 0x10000) {
      result += String.fromCharCode(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      result += String.fromCharCode(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
  }
  return result;
}

/* UTF-8 にしたときの長さが maxBytes 以下になるよう、文字列の末尾を切り詰める。
   文字の途中で切ると壊れた文字になるため、1文字単位で切る */
function truncateUtf8(text, maxBytes) {
  var result = "", usedBytes = 0, i, character, code, nextCode, characterBytes;
  for (i = 0; i < text.length; i++) {
    character = text.charAt(i);
    code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      nextCode = text.charCodeAt(i + 1);
      if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
        character = text.substr(i, 2);
        i++;
      }
    }
    characterBytes = encodeUtf8(character).length;
    if (usedBytes + characterBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

/* ---------- RIFX チャンクの組み立て ---------- */

/* タグ(4文字) + 長さ(4バイト) + 本体 のチャンクを作る。本体が奇数バイトなら 1 バイトの詰め物を足す（RIFF 系の決まり） */
function makeChunk(tag, body) {
  return tag + uint32BE(body.length) + body + ((body.length & 1) ? "\0" : "");
}

/* 子チャンクを束ねる LIST チャンクを作る（長さには種別の4文字分も含める） */
function makeListChunk(kind, children) {
  return "LIST" + uint32BE(4 + children.length) + kind + children;
}

/* 文字列を 40 バイト固定長（末尾 NUL 埋め）にする。matchName を格納するチャンク用 */
function makeFixedLengthName(text) {
  var bytes = encodeUtf8(text);
  if (bytes.length > MATCH_NAME_FIELD_LENGTH - 1) bytes = bytes.substr(0, MATCH_NAME_FIELD_LENGTH - 1);
  return bytes + zeroBytes(MATCH_NAME_FIELD_LENGTH - bytes.length);
}

/* ---------- ハッシュ（matchName 生成用） ---------- */

/* 文字列から 32 ビットのハッシュ値を計算する。暗号強度は不要で、定義が変わったら値が変わればよい */
function hash32(text, multiplier, seed) {
  var hash = seed, i;
  for (i = 0; i < text.length; i++) {
    hash = (hash * multiplier + text.charCodeAt(i) + 1) % TWO_POW_32;
  }
  return hash;
}

/* 数値を 8 桁の 16 進文字列にする */
function toHex8(value) {
  var text = (value >>> 0).toString(16);
  while (text.length < 8) text = "0" + text;
  return text;
}

/* エフェクト定義全体から matchName を作る。
   定義の内容が変わったら必ず別の matchName になるようにしている。
   同じ matchName のまま定義だけ変えると、After Effects が古い定義を使い回してしまうため。 */
function makeMatchName(spec) {
  var signature = [FFX_GENERATOR_VERSION, spec.effectName], i, item, hashText, hex = "";
  for (i = 0; i < spec.items.length; i++) {
    item = spec.items[i];
    signature.push([item.kind, item.name || "", item.defaultValue, item.validMin, item.validMax,
      item.sliderMin, item.sliderMax, item.precision,
      item.options ? item.options.join("|") : ""].join("~"));
  }
  hashText = signature.join("\n");
  for (i = 0; i < HASH_PARAMS.length; i++) {
    hex += toHex8(hash32(hashText, HASH_PARAMS[i].multiplier, HASH_PARAMS[i].seed));
  }
  /* 2つ目のハッシュは前半だけ使い、全体を短く保つ */
  return EFFECT_MATCH_PREFIX + hex.substr(0, 8) + hex.substr(8, HASH_SECOND_HEX_LENGTH);
}

/* ---------- パラメーター1個分の生成 ---------- */

/* バイナリ文字列 binary の offset 以降を、replacement に置き換えた新しい文字列を返す（長さは変えない）。
   バイト配列(push や concat)は ExtendScript では非常に遅いため、文字列の切り貼りで済ませる */
function overwriteBytes(binary, offset, replacement) {
  return binary.substring(0, offset) + replacement + binary.substring(offset + replacement.length);
}

/* パラメーター定義 item から pard（148バイト）を作る。
   雛形のバイト列をコピーして、名前・初期値・範囲だけを上書きする */
function makeParamDefinition(item) {
  var pard = hexToBinaryString(FFX_TEMPLATE[item.kind].pard), choice;

  /* ルートと終端には名前がない（雛形の値をそのまま使う） */
  if (item.kind !== "root" && item.kind !== "end") {
    pard = overwriteBytes(pard, PARD_OFFSET.NAME, padWithZeros(encodeUtf8(truncateUtf8(item.name, PARAM_NAME_MAX_BYTES)), PARD_NAME_FIELD_LENGTH));
  }

  if (item.kind === "slider") {
    pard = overwriteBytes(pard, PARD_OFFSET.SLIDER_VALID_MIN, float32BE(item.validMin) + float32BE(item.validMax) +
      float32BE(item.sliderMin) + float32BE(item.sliderMax));
    /* この位置が「リセット時の既定値」。別の資料でも同じ位置が既定値とされており、信頼できる。
       作成直後の値は cdat 側にも書くので、両方が一致する */
    pard = overwriteBytes(pard, PARD_OFFSET.SLIDER_DEFAULT, float32BE(item.defaultValue) + uint16BE(item.precision) + uint16BE(item.units || SLIDER_UNITS.NONE));
  } else if (item.kind === "check") {
    pard = overwriteBytes(pard, PARD_OFFSET.CHECK_DEFAULT, String.fromCharCode(item.defaultValue ? 1 : 0));
  } else if (item.kind === "popup") {
    choice = String.fromCharCode(item.defaultValue || 1);
    pard = overwriteBytes(pard, PARD_OFFSET.POPUP_VALUE, choice);
    pard = overwriteBytes(pard, PARD_OFFSET.POPUP_DEFAULT, choice);
    /* 60 バイト目の 16 ビット整数(見本では 3)は、選択肢が 1/2/3/5 個のどれでも同じ値だったため、雛形のまま触らない */
  }
  return pard;
}

/* パラメーター定義 item から、値・名前・スライダー範囲を保持する LIST tdbs を作る */
function makeParamValueList(item, effectName) {
  var sequence = FFX_TEMPLATE[item.kind].tdbs, children = "", i, tag, body;
  for (i = 0; i < sequence.length; i++) {
    tag = sequence[i][0];
    body = hexToBinaryString(sequence[i][1]);
    if (tag === "tdsn") {
      /* 表示名。終端は、エフェクト名と同じ名前を持つ（ルートは空） */
      if (item.kind === "root") body = "\0";
      else if (item.kind === "end") body = encodeUtf8(effectName) + "\0";
      else body = encodeUtf8(truncateUtf8(item.name, PARAM_NAME_MAX_BYTES)) + "\0";
    } else if (tag === "cdat") {
      /* 先頭 8 バイトが「作成直後の値」（倍精度）。残りは雛形のまま */
      if (item.kind === "slider") body = float64BE(item.defaultValue) + body.substr(8);
      else if (item.kind === "check") body = float64BE(item.defaultValue ? 1 : 0) + body.substr(8);
      else if (item.kind === "popup") body = float64BE(item.defaultValue || 1) + body.substr(8);
    } else if (tag === "tdum") {
      body = float64BE(item.sliderMin);
    } else if (tag === "tduM") {
      body = float64BE(item.sliderMax);
    }
    children += makeChunk(tag, body);
  }
  return makeListChunk("tdbs", children);
}

/* ---------- ファイル全体の生成 ---------- */

/* 疑似エフェクト定義 spec から .ffx ファイルの中身（バイナリ文字列）を作る。
   spec = { matchName, effectName, items: [ { kind, name, ... } ] }
   kind ごとの項目:
     group  : { name }
     end    : なし（group の閉じ）
     check  : { defaultValue(0|1) }
     popup  : { options[], defaultValue(1始まりの番号) }
     slider : { defaultValue, validMin, validMax, sliderMin, sliderMax, precision }
     point  : なし */
function buildFfx(spec) {
  var effectName = truncateUtf8(spec.effectName, PARAM_NAME_MAX_BYTES);
  var params = [{ kind: "root", name: "" }], i, param, paramMatchName, paramMatchChunk;
  var paramList, valueGroup, effectBlock, shapeSpec, body;

  for (i = 0; i < spec.items.length; i++) params.push(spec.items[i]);

  paramList = makeChunk("parn", uint32BE(params.length));
  valueGroup = makeChunk("tdsb", uint32BE(1)) + makeChunk("tdsn", encodeUtf8(effectName) + "\0");
  for (i = 0; i < params.length; i++) {
    param = params[i];
    /* パラメーターごとの識別名。matchName + 連番 */
    paramMatchName = spec.matchName + "-" + padNumberTo4Digits(i);
    paramMatchChunk = makeChunk("tdmn", makeFixedLengthName(paramMatchName));
    paramList += paramMatchChunk + makeChunk("pard", makeParamDefinition(param));
    if (param.kind === "check") {
      paramList += makeChunk("pdnm", "\0");
    } else if (param.kind === "popup") {
      /* ポップアップの選択肢は "|" 区切りで 1 つの文字列にする */
      paramList += makeChunk("pdnm", encodeUtf8(param.options.join("|")) + "\0");
    }
    valueGroup += paramMatchChunk + makeParamValueList(param, effectName);
  }
  valueGroup += makeChunk("tdmn", makeFixedLengthName("ADBE Group End"));

  effectBlock = makeChunk("beso", hexToBinaryString(FFX_TEMPLATE.beso));
  /* エフェクトの置き場所（エフェクトパレード → このエフェクト）を示す */
  effectBlock += makeListChunk("tdsp",
    makeChunk("tdot", uint32BE(0xFFFFFFFF)) + makeChunk("tdpl", uint32BE(2)) +
    makeListChunk("tdsi", makeChunk("tdix", uint32BE(0xFFFFFFFF)) + makeChunk("tdmn", makeFixedLengthName("ADBE Effect Parade"))) +
    makeListChunk("tdsi", makeChunk("tdix", uint32BE(0)) + makeChunk("tdmn", makeFixedLengthName(spec.matchName))));
  effectBlock += makeChunk("tdsn", encodeUtf8(effectName) + "\0");
  effectBlock += makeListChunk("tdsp",
    makeChunk("tdot", uint32BE(0xFFFFFFFF)) + makeChunk("tdpl", uint32BE(1)) +
    makeListChunk("tdsi", makeChunk("tdix", uint32BE(0xFFFFFFFF)) + makeChunk("tdmn", makeFixedLengthName("ADBE End of path sentinel"))));
  shapeSpec = makeChunk("fnam", hexToBinaryString(FFX_TEMPLATE.fnam)) + makeListChunk("parT", paramList) + makeListChunk("tdgp", valueGroup);
  effectBlock += makeListChunk("sspc", shapeSpec);

  /* RIFX の長さ欄には、形式タグ以降の全バイト数を入れる */
  body = FFX_FORM_TYPE + makeChunk("head", hexToBinaryString(FFX_TEMPLATE.head)) + makeListChunk("besc", effectBlock);
  return "RIFX" + uint32BE(body.length) + body;
}

/* ================================================================
 * 第2部: コンポ階層のスキャン、計画・分割、エクスプレッション生成
 *
 * After Effects の画面操作に依存しない純粋なロジック部分。
 * AEオブジェクトへ触れる範囲を小さく保つことで、モックを使った自動テストを可能にしている。
 * ================================================================ */

/* ---------- 定数 ---------- */

/* 本ツールが設定した式の先頭に必ず付ける目印。
   ユーザーが自分で書いた式を、解除・最適化のときに誤って消さないために使う */
var EXPRESSION_MARKER = "/*PRB*/";

/* レイヤーの種類。オプションの対象種別のキーにもなる（"null" は予約語なので別名にしている） */
var LAYER_KIND = {
  FOOTAGE: "footage",
  COMP: "comp",
  SHAPE: "shape",
  TEXT: "text",
  SOLID: "solid",
  NULL_OBJECT: "nullObject",
  ADJUSTMENT: "adjustment"
};

/* オプションの選択肢（文字列の打ち間違いを防ぐため、文字列を直接書かず必ずこの定数を使う） */
var POSITION_INPUT = { POINT: "point", SLIDER: "slider" };
var SCALE_INPUT = { UNIFORM: "uniform", XY: "xy" };
var STAGGER_MODE = { MASTER: "master", OFF: "off" };
var TIME_SYNC_MODE = { BAKED: "baked", DYNAMIC: "dynamic", NONE: "none" };

/* 式を設定する対象。制御行の役割(role)名にも流用する */
var TRANSFORM_TARGET = {
  POSITION: "position",
  POSITION_X: "positionX",
  POSITION_Y: "positionY",
  SCALE: "scale",
  SCALE_X: "scaleX",
  SCALE_Y: "scaleY",
  ROTATION: "rotation"
};

/* After Effects のプロパティ識別名 */
var PROP_MATCH_NAME = {
  EFFECT_PARADE: "ADBE Effect Parade",
  TRANSFORM_GROUP: "ADBE Transform Group",
  POSITION: "ADBE Position",
  POSITION_X: "ADBE Position_0",
  POSITION_Y: "ADBE Position_1",
  POSITION_Z: "ADBE Position_2",
  SCALE: "ADBE Scale",
  ROTATION_Z: "ADBE Rotate Z"
};

/* マスター（一括スタッガー）エフェクトの項目名。式から名前で参照するので、定義と式で必ず同じ値を使う */
var MASTER_PARAM_NAME = {
  ENABLE: "スタッガー有効",
  DELAY: "ディレイ(f)",
  ORDER: "順序",
  SCOPE: "範囲",
  SEED: "ランダムシード",
  APPLY_TO_POSITION: "位置に適用",
  APPLY_TO_SCALE: "拡大率に適用",
  APPLY_TO_ROTATION: "回転に適用"
};

/* 「順序」ポップアップの選択肢の番号（1始まり。式の中で数値として比較する） */
var ORDER_CHOICE = { ASCENDING: 1, DESCENDING: 2, RANDOM: 3 };
/* 「範囲」ポップアップの選択肢の番号 */
var SCOPE_CHOICE = { WITHIN_GROUP: 1, WHOLE: 2 };

/* マスターエフェクトの初期値と範囲 */
var MASTER_DEFAULT = {
  DELAY_FRAMES: 2,
  DELAY_VALID_RANGE: 1000,
  DELAY_SLIDER_RANGE: 20,
  SEED: 1,
  SEED_VALID_MAX: 100000,
  SEED_SLIDER_MAX: 100
};

/* 制御行の表示名 */
var ROW_LABEL = {
  POSITION: "位置",
  POSITION_X: "X",
  POSITION_Y: "Y",
  SCALE: "拡大率",
  SCALE_X: "拡大X",
  SCALE_Y: "拡大Y",
  ROTATION: "回転"
};

/* 1つのエフェクトに入りきらず分割したときの、グループ名の末尾 */
var CONTINUED_GROUP_SUFFIX = " (続き)";

/* 制御スライダーの値の範囲（validMin/Max = 入力できる範囲、sliderMin/Max = スライダーの可動域） */
var SLIDER_RANGE = {
  POSITION: { defaultValue: 0, validMin: -100000, validMax: 100000, sliderMin: -2000, sliderMax: 2000, precision: 1 },
  SCALE: { defaultValue: 100, validMin: -10000, validMax: 10000, sliderMin: 0, sliderMax: 300, precision: 1 },
  ROTATION: { defaultValue: 0, validMin: -100000, validMax: 100000, sliderMin: -360, sliderMax: 360, precision: 1 }
};

/* 「何もしない値」。最適化で未使用を判定するときの基準になる。
   OFFSET = 足し算で効く項目（位置・回転）の値、SCALE_PERCENT = 掛け算で効く拡大率の値 */
var NEUTRAL_VALUE = { OFFSET: 0, SCALE_PERCENT: 100 };

/* エフェクト1個あたりの項目数の制限。
   - 既定値: 1エフェクトに入れる項目数の目安
   - 下限/上限: 画面から入力できる範囲
   - MIN_USABLE_CAP: これ以下だと「グループ1個+行」すら入らず分割が終わらなくなるため、内部で確保する最小値 */
var PARAMS_PER_EFFECT = { DEFAULT: 100, MIN_INPUT: 20, MAX_INPUT: 1000, MIN_USABLE_CAP: 12 };

/* グループ1個が消費する項目数（開始と終了の2つ） */
var GROUP_OVERHEAD_PARAMS = 2;

/* 乱数シードを「ランダムシード × この値 + レイヤー番号」で作る。
   シードが1違うだけでレイヤー間の乱数列が相関しないよう、十分大きな間隔を空けるため */
var RANDOM_SEED_STRIDE = 1000;

/* 制御レイヤーとマスターエフェクトの標準名 */
var DEFAULT_CONTROL_LAYER_NAME = "制御まとめ";
var DEFAULT_MASTER_EFFECT_NAME = "一括スタッガー";

/* 「順序」「範囲」ポップアップの選択肢 */
var ORDER_OPTIONS = ["昇順", "降順", "ランダム"];
var SCOPE_OPTIONS = ["グループ内", "全体通し"];

/* ---------- オプション ---------- */

/* 画面で変更できる設定の初期値を返す。呼ぶたびに新しいオブジェクトを返すので、受け取った側で自由に書き換えてよい */
function defaultOptions() {
  var layerTypes = {};
  layerTypes[LAYER_KIND.FOOTAGE] = true;
  layerTypes[LAYER_KIND.COMP] = true;
  layerTypes[LAYER_KIND.SHAPE] = true;
  layerTypes[LAYER_KIND.TEXT] = true;
  layerTypes[LAYER_KIND.SOLID] = true;
  layerTypes[LAYER_KIND.NULL_OBJECT] = false;
  layerTypes[LAYER_KIND.ADJUSTMENT] = false;
  return {
    layerTypes: layerTypes,
    includeGuideLayers: false,
    recurseIntoComps: true,
    controlCompLayers: true,
    controlledProps: { position: true, scale: true, rotation: true },
    positionInput: POSITION_INPUT.POINT,
    scaleInput: SCALE_INPUT.UNIFORM,
    maxParamsPerEffect: PARAMS_PER_EFFECT.DEFAULT,
    /* MASTER = マスター付き（初期状態はOFF）、OFF = マスターなしの最軽量の式 */
    staggerMode: STAGGER_MODE.MASTER,
    /* ネストしたコンポレイヤーの開始時間のずれの扱い（固定値 / 動的に追従 / 補正なし） */
    timeSyncMode: TIME_SYNC_MODE.BAKED,
    controlLayerName: DEFAULT_CONTROL_LAYER_NAME,
    masterEffectName: DEFAULT_MASTER_EFFECT_NAME,
    overwriteExisting: false
  };
}

/* マスター（一括スタッガー）エフェクトの項目定義を返す */
function masterItems() {
  return [
    { kind: "check", name: MASTER_PARAM_NAME.ENABLE, defaultValue: 0 },
    {
      kind: "slider", name: MASTER_PARAM_NAME.DELAY, defaultValue: MASTER_DEFAULT.DELAY_FRAMES,
      validMin: -MASTER_DEFAULT.DELAY_VALID_RANGE, validMax: MASTER_DEFAULT.DELAY_VALID_RANGE,
      sliderMin: -MASTER_DEFAULT.DELAY_SLIDER_RANGE, sliderMax: MASTER_DEFAULT.DELAY_SLIDER_RANGE, precision: 1
    },
    { kind: "popup", name: MASTER_PARAM_NAME.ORDER, options: ORDER_OPTIONS, defaultValue: ORDER_CHOICE.ASCENDING },
    { kind: "popup", name: MASTER_PARAM_NAME.SCOPE, options: SCOPE_OPTIONS, defaultValue: SCOPE_CHOICE.WITHIN_GROUP },
    {
      kind: "slider", name: MASTER_PARAM_NAME.SEED, defaultValue: MASTER_DEFAULT.SEED,
      validMin: 0, validMax: MASTER_DEFAULT.SEED_VALID_MAX, sliderMin: 0, sliderMax: MASTER_DEFAULT.SEED_SLIDER_MAX, precision: 0
    },
    { kind: "check", name: MASTER_PARAM_NAME.APPLY_TO_POSITION, defaultValue: 1 },
    { kind: "check", name: MASTER_PARAM_NAME.APPLY_TO_SCALE, defaultValue: 1 },
    { kind: "check", name: MASTER_PARAM_NAME.APPLY_TO_ROTATION, defaultValue: 1 }
  ];
}

/* ---------- 文字列ヘルパー ---------- */

/* 文字列を式の中に埋め込める "..." リテラルにする。
   名前に " や \ や改行が含まれていても式が壊れないようにエスケープする */
function quoteForExpression(text) {
  return '"' + String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\u2028\u2029]+/g, " ") + '"';
}

/* 数値を 2 桁の 0 埋め文字列にする（項目名の連番用） */
function padNumberTo2Digits(number) {
  return (number < 10) ? "0" + number : String(number);
}

/* 項目名として使えない文字（制御文字と、ポップアップの区切りに使う "|"）を空白に置き換える */
function sanitizeParamName(text) {
  return String(text).replace(/[\u0000-\u001F\u007F|]/g, " ");
}

/* baseName から、usedNames に無い名前を作って usedNames に登録し、その名前を返す。
   同名の項目があると式から参照できなくなるため、重複したら " 2", " 3" ... を付ける。
   連番を付けても 31 バイトに収まるよう、本体側を切り詰める */
function makeUniqueName(baseName, usedNames) {
  var base = truncateUtf8(sanitizeParamName(baseName), PARAM_NAME_MAX_BYTES);
  var serial = 1, candidate = base, suffix;
  while (usedNames[candidate]) {
    serial++;
    suffix = " " + serial;
    candidate = truncateUtf8(base, PARAM_NAME_MAX_BYTES - suffix.length) + suffix;
  }
  usedNames[candidate] = true;
  return candidate;
}

/* ---------- レイヤーの分類 ---------- */

/* レイヤーの種類（LAYER_KIND のどれか）を返す。ライトやカメラなど、位置を持たないレイヤーは null */
function classifyLayerKind(layer) {
  if (!(layer instanceof AVLayer)) return null;
  if (layer instanceof ShapeLayer) return LAYER_KIND.SHAPE;
  if (layer instanceof TextLayer) return LAYER_KIND.TEXT;
  if (layer.nullLayer) return LAYER_KIND.NULL_OBJECT;
  if (layer.adjustmentLayer) return LAYER_KIND.ADJUSTMENT;
  if (layer.source instanceof CompItem) return LAYER_KIND.COMP;
  if (layer.source && layer.source.mainSource instanceof SolidSource) return LAYER_KIND.SOLID;
  return LAYER_KIND.FOOTAGE;
}

/* 式の中でレイヤーを指す文字列（comp("コンポ名").layer(...)）を作る。
   同名レイヤーが複数あると名前では特定できないので、その場合だけレイヤー番号で指す */
function makeLayerReference(comp, layer) {
  var sameNameCount = 0, i;
  for (i = 1; i <= comp.numLayers; i++) {
    if (comp.layer(i).name === layer.name) sameNameCount++;
  }
  return "comp(" + quoteForExpression(comp.name) + ").layer(" +
    (sameNameCount > 1 ? layer.index : quoteForExpression(layer.name)) + ")";
}

/* ルートからあるノードまでたどるコンポレイヤーの1段分（パスの1要素）を作る。
   ネストしたコンポ内のレイヤーは、親コンポレイヤーの開始時間ぶん時間がずれる。
   親コンポの名前がプロジェクト内で重複していると式の comp("名前") がどれを指すか曖昧になるので、
   その場合は開始時間を式に参照させず数値(固定値)として埋め込む */
function makePathStep(comp, layer, context) {
  var mode = context.options.timeSyncMode, followDynamically = (mode === TIME_SYNC_MODE.DYNAMIC);
  if (followDynamically && context.nameCounts && context.nameCounts[comp.name] > 1) {
    followDynamically = false;
    if (layer.startTime !== 0) context.bakedCount++;
  }
  return {
    reference: makeLayerReference(comp, layer),
    dynamic: followDynamically,
    startTime: (mode === TIME_SYNC_MODE.NONE) ? 0 : layer.startTime
  };
}

/* ---------- コンポ階層のスキャン ---------- */

/* comp の中のレイヤーを調べて、制御対象のノードの木を作る。
   path はルートからこの comp までのコンポレイヤーの並び（時間のずれの計算用） */
function scanCompTree(comp, context, path) {
  var nodes = [], i, layer, kind, node, children;
  var options = context.options;

  /* 同じコンポを2回以上たどると無限再帰や二重制御になるので、一度訪れたコンポは覚えておく */
  context.visited[comp.id] = true;
  for (i = 1; i <= comp.numLayers; i++) {
    layer = comp.layer(i);
    /* 制御レイヤー自身を制御対象にすると、自分の式で自分を動かす循環になる */
    if (context.hostComp && comp.id === context.hostComp.id && layer.name === options.controlLayerName && layer.nullLayer) continue;
    kind = classifyLayerKind(layer);
    if (!kind) continue;
    if (layer.guideLayer && !options.includeGuideLayers) continue;
    if (!options.layerTypes[kind]) continue;

    node = {
      layer: layer, comp: comp, name: layer.name, kind: kind,
      isGroup: false, children: [], path: path, controlsSelf: true,
      localIndex: -1, localCount: 0, globalIndex: -1, globalCount: 0, binding: null
    };
    if (kind === LAYER_KIND.COMP && options.recurseIntoComps) {
      if (context.visited[layer.source.id]) {
        context.warnings.push("コンポ「" + layer.source.name + "」は複数回使われています。内側のレイヤー制御は最初の1箇所にまとめています");
      } else {
        children = scanCompTree(layer.source, context, path.concat([makePathStep(comp, layer, context)]));
        node.children = children;
        node.isGroup = children.length > 0;
      }
    }
    if (node.isGroup && !options.controlCompLayers) node.controlsSelf = false;
    /* 中身が空で、コンポ自身も制御しないなら、制御するものが何もないので載せない */
    if (kind === LAYER_KIND.COMP && !node.isGroup && !node.controlsSelf) continue;
    nodes.push(node);
  }
  return nodes;
}

/* 全ノードに、スタッガーの順番を決めるための番号を振る。
   localIndex/localCount = 同じ階層（グループ内）での順番と総数、
   globalIndex/globalCount = 木全体を通した順番と総数。
   allNodes には全体通しの順番に並んだノードを集める */
function assignStaggerIndexes(nodes, allNodes) {
  var members = [], i;
  for (i = 0; i < nodes.length; i++) {
    if (nodes[i].controlsSelf) members.push(nodes[i]);
  }
  for (i = 0; i < members.length; i++) {
    members[i].localIndex = i;
    members[i].localCount = members.length;
  }
  for (i = 0; i < nodes.length; i++) {
    if (nodes[i].controlsSelf) {
      /* push する前の長さを使うことで 0 始まりの通し番号になる */
      nodes[i].globalIndex = allNodes.length;
      allNodes.push(nodes[i]);
    }
    if (nodes[i].children.length) assignStaggerIndexes(nodes[i].children, allNodes);
  }
}

/* ---------- 制御行（レイヤー1枚につき作るスライダー/ポイント） ---------- */

/* 設定に応じて、レイヤー1枚ぶんの制御行（位置・拡大率・回転）の定義を返す */
function buildOwnRows(options) {
  var rows = [], position = SLIDER_RANGE.POSITION, scale = SLIDER_RANGE.SCALE, rotation = SLIDER_RANGE.ROTATION;

  /* range のスライダー設定に、役割(role)と表示名(label)を付けた行を作る */
  function sliderRow(role, label, range) {
    return {
      role: role, kind: "slider", label: label, defaultValue: range.defaultValue,
      validMin: range.validMin, validMax: range.validMax, sliderMin: range.sliderMin, sliderMax: range.sliderMax,
      precision: range.precision
    };
  }

  if (options.controlledProps.position) {
    if (options.positionInput === POSITION_INPUT.POINT) {
      rows.push({ role: TRANSFORM_TARGET.POSITION, kind: "point", label: ROW_LABEL.POSITION });
    } else {
      rows.push(sliderRow(TRANSFORM_TARGET.POSITION_X, ROW_LABEL.POSITION_X, position));
      rows.push(sliderRow(TRANSFORM_TARGET.POSITION_Y, ROW_LABEL.POSITION_Y, position));
    }
  }
  if (options.controlledProps.scale) {
    if (options.scaleInput === SCALE_INPUT.XY) {
      rows.push(sliderRow(TRANSFORM_TARGET.SCALE_X, ROW_LABEL.SCALE_X, scale));
      rows.push(sliderRow(TRANSFORM_TARGET.SCALE_Y, ROW_LABEL.SCALE_Y, scale));
    } else {
      rows.push(sliderRow(TRANSFORM_TARGET.SCALE, ROW_LABEL.SCALE, scale));
    }
  }
  if (options.controlledProps.rotation) {
    rows.push(sliderRow(TRANSFORM_TARGET.ROTATION, ROW_LABEL.ROTATION, rotation));
  }
  return rows;
}

/* ---------- ユニット化・コスト計算・分割・詰め込み ----------
   ユニット = ノード1個ぶんの「グループ + 制御行 + 子ユニット」のまとまり。
   After Effects は1エフェクトのパラメーター数に上限があるため、
   大きな階層はユニット単位で複数のエフェクトに振り分ける */

/* ノードの木から、ユニットの木を作る */
function makeUnit(node, options) {
  var unit = { name: node.name, rows: node.controlsSelf ? buildOwnRows(options) : [], children: [], node: node, isContinuation: false };
  var i;
  for (i = 0; i < node.children.length; i++) unit.children.push(makeUnit(node.children[i], options));
  return unit;
}

/* ユニット（子孫を含む）が消費するパラメーター数を数える */
function countUnitParams(unit) {
  var count = GROUP_OVERHEAD_PARAMS + unit.rows.length, i;
  for (i = 0; i < unit.children.length; i++) count += countUnitParams(unit.children[i]);
  return count;
}

/* ユニットが上限 cap を超えるとき、cap に収まる複数のユニットに分割する。
   子を1つずつ詰めていき、あふれたら「(続き)」グループに移る */
function splitUnit(unit, cap) {
  var pieces = [], current, currentCount, i, j, childPieces, childPiece, childCount;
  if (countUnitParams(unit) <= cap) return [unit];

  current = { name: unit.name, rows: unit.rows, children: [], node: unit.node, isContinuation: false };
  currentCount = GROUP_OVERHEAD_PARAMS + unit.rows.length;
  for (i = 0; i < unit.children.length; i++) {
    /* 子はこのユニットのグループの内側に入るため、グループぶんの2つを引いた上限で分割する */
    childPieces = splitUnit(unit.children[i], cap - GROUP_OVERHEAD_PARAMS);
    for (j = 0; j < childPieces.length; j++) {
      childPiece = childPieces[j];
      childCount = countUnitParams(childPiece);
      /* 先頭の子が入らないほど大きいときに空のまま閉じてしまわないよう、子が1つ以上あるときだけ閉じる */
      if (currentCount + childCount > cap && current.children.length > 0) {
        pieces.push(current);
        current = { name: unit.name, rows: [], children: [], node: unit.node, isContinuation: true };
        currentCount = GROUP_OVERHEAD_PARAMS;
      }
      current.children.push(childPiece);
      currentCount += childCount;
    }
  }
  pieces.push(current);
  return pieces;
}

/* 複数のユニットを、1つあたり cap 以内に収まるように、エフェクトごとのまとまりへ詰め込む。
   戻り値はエフェクト1個ぶんのユニット配列の配列 */
function packUnitsIntoEffects(units, cap) {
  var pieces = [], effects = [], current = [], currentCount = 0, i, j, splitPieces, pieceCount;
  for (i = 0; i < units.length; i++) {
    splitPieces = splitUnit(units[i], cap);
    for (j = 0; j < splitPieces.length; j++) pieces.push(splitPieces[j]);
  }
  for (i = 0; i < pieces.length; i++) {
    pieceCount = countUnitParams(pieces[i]);
    if (currentCount + pieceCount > cap && current.length > 0) {
      effects.push(current);
      current = [];
      currentCount = 0;
    }
    current.push(pieces[i]);
    currentCount += pieceCount;
  }
  if (current.length > 0) effects.push(current);
  return effects;
}

/* ---------- ユニット → 疑似エフェクトの項目 ---------- */

/* 制御行 row を、疑似エフェクトの項目定義に変換する */
function makeItemFromRow(row, itemName) {
  if (row.kind === "point") return { kind: "point", name: itemName };
  return {
    kind: "slider", name: itemName, defaultValue: row.defaultValue,
    validMin: row.validMin, validMax: row.validMax, sliderMin: row.sliderMin, sliderMax: row.sliderMax, precision: row.precision
  };
}

/* ユニットの制御行を項目として items に追加し、ノードに「どの項目名がどの役割か」(binding)を記録する。
   項目名にはグループごとの連番を付ける。同名の子コンポが複数あっても名前が衝突しないようにするため */
function emitUnitRows(unit, items, renderState) {
  var i, serialText, namesByRole, itemName;
  if (unit.rows.length === 0) return;
  renderState.serial++;
  serialText = padNumberTo2Digits(renderState.serial);
  namesByRole = {};
  for (i = 0; i < unit.rows.length; i++) {
    itemName = makeUniqueName(unit.rows[i].label + " " + serialText, renderState.usedNames);
    namesByRole[unit.rows[i].role] = itemName;
    items.push(makeItemFromRow(unit.rows[i], itemName));
  }
  unit.node.binding = { effectName: renderState.effectName, names: namesByRole };
}

/* ユニット（グループ + 制御行 + 子ユニット）を項目として items に追加する */
function emitUnit(unit, items, renderState) {
  var groupName = makeUniqueName(unit.name + (unit.isContinuation ? CONTINUED_GROUP_SUFFIX : ""), renderState.usedNames);
  var i;
  items.push({ kind: "group", name: groupName });
  emitUnitRows(unit, items, renderState);
  for (i = 0; i < unit.children.length; i++) emitUnit(unit.children[i], items, renderState);
  items.push({ kind: "end" });
}

/* 最上位のコンポ用。エフェクト名がすでにそのコンポの名前なので、自身のグループは作らず、
   自身の制御行をエフェクトの先頭に置き、子コンポだけをグループにする */
function emitRootUnit(unit, items, renderState) {
  var i;
  emitUnitRows(unit, items, renderState);
  for (i = 0; i < unit.children.length; i++) emitUnit(unit.children[i], items, renderState);
}

/* ---------- 全体の計画 ---------- */

/* rootComp を調べて、作るべきエフェクトとノード対応表(plan)を作る。AEのプロジェクトは変更しない。
   hostComp = 制御レイヤーを置くコンポ（省略時は rootComp）。
   nameCounts = プロジェクト内のコンポ名ごとの個数（同名コンポの判定用、省略可）。
   戻り値: { nodes(木), flat(通し順の一覧), effects, master, warnings, baked, stats } */
function planRig(rootComp, options, hostComp, nameCounts) {
  var context = {
    options: options, visited: {}, warnings: [], rootComp: rootComp,
    hostComp: hostComp || rootComp, nameCounts: nameCounts || null, bakedCount: 0
  };
  var nodes = scanCompTree(rootComp, context, []);
  var allNodes = [], units = [], effects = [], pendingUnits = [], usedEffectNames = {};
  var totalParams = 0, totalGroups = 0, master = null;
  var masterEffectName = truncateUtf8(options.masterEffectName, PARAM_NAME_MAX_BYTES);
  var paramCap, i, j, pieces;

  assignStaggerIndexes(nodes, allNodes);
  for (i = 0; i < allNodes.length; i++) allNodes[i].globalCount = allNodes.length;

  /* ルートの項目(エフェクト自身)が1つ分加わるため、上限から1引く */
  paramCap = Math.max(PARAMS_PER_EFFECT.MIN_USABLE_CAP, options.maxParamsPerEffect - 1);
  /* マスターと同名のエフェクトができると式の参照先がぶつかるので、先に予約する */
  usedEffectNames[masterEffectName] = true;

  /* 1個のエフェクトを作って effects に追加する。asRoot = 先頭ユニットをエフェクト自身として展開する */
  function addEffect(baseName, effectUnits, asRoot) {
    var effectName = makeUniqueName(baseName, usedEffectNames);
    var renderState = { usedNames: {}, serial: 0, effectName: effectName };
    var items = [], k, spec;
    if (asRoot) emitRootUnit(effectUnits[0], items, renderState);
    else for (k = 0; k < effectUnits.length; k++) emitUnit(effectUnits[k], items, renderState);
    spec = { matchName: "", effectName: effectName, items: items };
    spec.matchName = makeMatchName(spec);
    effects.push(spec);
    totalParams += items.length;
    for (k = 0; k < items.length; k++) if (items[k].kind === "group") totalGroups++;
  }

  /* 子コンポを持たないノードがたまったら、まとめて詰め込んで「制御まとめ」エフェクトにする */
  function flushPendingUnits() {
    var packs, k;
    if (pendingUnits.length === 0) return;
    packs = packUnitsIntoEffects(pendingUnits, paramCap);
    for (k = 0; k < packs.length; k++) addEffect(options.controlLayerName, packs[k], false);
    pendingUnits = [];
  }

  for (i = 0; i < nodes.length; i++) {
    units.push(makeUnit(nodes[i], options));
    if (nodes[i].isGroup) {
      /* 子コンポを持つコンポは専用のエフェクト（コンポ名で命名）になり、ネストした子コンポはその中のグループになる。
         直前までにたまった単独レイヤーは、表示順を保つために先に出力する */
      flushPendingUnits();
      /* ルート展開はグループのぶん(2項目)が不要なので、その分だけ上限を広げて分割する */
      pieces = splitUnit(units[i], paramCap + GROUP_OVERHEAD_PARAMS);
      for (j = 0; j < pieces.length; j++) addEffect(nodes[i].name, [pieces[j]], true);
    } else {
      pendingUnits.push(units[i]);
    }
  }
  flushPendingUnits();

  if (options.staggerMode === STAGGER_MODE.MASTER) {
    master = { matchName: "", effectName: masterEffectName, items: masterItems() };
    master.matchName = makeMatchName(master);
  }
  return {
    nodes: nodes, flat: allNodes, effects: effects, master: master, warnings: context.warnings, baked: context.bakedCount,
    stats: { layers: allNodes.length, groups: totalGroups, params: totalParams, effects: effects.length }
  };
}

/* プレビュー表示用に、ノードの木をインデント付きの行の配列にする */
function previewLines(nodes, depth, lines) {
  var i, node, indent = "", level;
  lines = lines || [];
  depth = depth || 0;
  for (level = 0; level < depth; level++) indent += "  ";
  for (i = 0; i < nodes.length; i++) {
    node = nodes[i];
    lines.push(indent + (node.isGroup ? "▼ " : "・") + node.name +
      (node.isGroup ? "  (" + node.children.length + ")" : ""));
    if (node.children.length) previewLines(node.children, depth + 1, lines);
  }
  return lines;
}

/* ---------- エクスプレッション生成 ---------- */

/* ネストしたコンポ内のレイヤーのスライダー時間を、ルートコンポの時間に合わせるための式の断片を返す。
   固定値にできる分(開始時間)は足し合わせて 1 つの数値にし、動的に追従する分だけ式として残す。
   式の評価は毎フレーム走るので、できるだけ短く・軽くするため */
function makeTimeOffsetExpression(path, context) {
  var dynamicPart = "", fixedSeconds = 0, i, step;
  for (i = 0; i < path.length; i++) {
    step = path[i];
    if (step.dynamic) dynamicPart += "+" + step.reference + ".startTime";
    else fixedSeconds += step.startTime;
  }
  fixedSeconds += (context.hostFixedOffset || 0);
  if (fixedSeconds !== 0) dynamicPart += (fixedSeconds < 0 ? "" : "+") + fixedSeconds;
  return dynamicPart + (context.hostDynamicOffset || "");
}

/* 式の対象(target)に対応する、マスターの「〜に適用」スイッチの名前を返す */
function applySwitchNameFor(target) {
  if (target === TRANSFORM_TARGET.ROTATION) return MASTER_PARAM_NAME.APPLY_TO_ROTATION;
  if (target === TRANSFORM_TARGET.SCALE) return MASTER_PARAM_NAME.APPLY_TO_SCALE;
  return MASTER_PARAM_NAME.APPLY_TO_POSITION;
}

/* node のレイヤーの target（位置/拡大率/回転 など）に設定する式の文字列を作る。
   context = { hostComp, hostFixedOffset, hostDynamicOffset, controlLayerName, masterEffectName, options }。
   isThreeD = 3Dレイヤーのとき、Z 成分を変えずに戻すために必要。

   生成する式の構造（変数名は、AEが提供する関数名と衝突しないよう選んでいる）:
     hostComp   … 制御レイヤーのあるコンポ
     controlFx  … このノードの項目を持つエフェクト
     masterFx   … マスターエフェクト（スタッガー時のみ）
     delaySec   … スタッガーによる時間のずれ（秒）。OFFのとき 0

   処理が重くならないよう、時間オフセットや順番・乱数の計算は「スタッガーが本当にONのときだけ」評価する。
   OFF のときの 1 プロパティあたりの負荷は、レイヤー参照 1 回 + エフェクト参照 1 回 + 値の読み取り 1 回
   （マスターがある場合は、加えてスイッチ読み取り 2 回） */
function buildExpr(target, node, context, isThreeD) {
  var names = node.binding.names, options = context.options;
  var zComponent = isThreeD ? ",value[2]" : "";
  var staggerEnabled = (options.staggerMode === STAGGER_MODE.MASTER);
  var hostCompExpression = (node.comp.id === context.hostComp.id) ? "thisComp" : "comp(" + quoteForExpression(context.hostComp.name) + ")";
  var timeOffset = makeTimeOffsetExpression(node.path, context);
  var applySwitchName = applySwitchNameFor(target);
  var expression;

  /* 制御項目 itemName の現在値を読む式。スタッガー中は、ずらした時刻の値を読む */
  function readItem(itemName) {
    var quoted = quoteForExpression(itemName);
    if (!staggerEnabled) return "controlFx(" + quoted + ").value";
    return "(delaySec?controlFx(" + quoted + ").valueAtTime(time" + timeOffset + "-delaySec):controlFx(" + quoted + ").value)";
  }

  expression = EXPRESSION_MARKER + "\n" + "var hostComp=" + hostCompExpression +
    ",controlLayer=hostComp.layer(" + quoteForExpression(context.controlLayerName) + ")" +
    ",controlFx=controlLayer.effect(" + quoteForExpression(node.binding.effectName) + ")";

  if (staggerEnabled) {
    /* マスターの項目は「有効」「適用スイッチ」「ディレイ」の順に &&で評価し、
       どれかが OFF/0 ならそれ以降（順番・乱数の計算）を一切評価しない */
    expression += ",masterFx=controlLayer.effect(" + quoteForExpression(context.masterEffectName) + "),delaySec=0,delayFrames;\n" +
      "if(masterFx(" + quoteForExpression(MASTER_PARAM_NAME.ENABLE) + ").value" +
      "&&masterFx(" + quoteForExpression(applySwitchName) + ").value" +
      "&&(delayFrames=masterFx(" + quoteForExpression(MASTER_PARAM_NAME.DELAY) + ").value)){" +
      "var isGroupScope=masterFx(" + quoteForExpression(MASTER_PARAM_NAME.SCOPE) + ").value==" + SCOPE_CHOICE.WITHIN_GROUP +
      ",staggerIndex=isGroupScope?" + node.localIndex + ":" + node.globalIndex +
      ",staggerCount=isGroupScope?" + node.localCount + ":" + node.globalCount +
      ",orderChoice=masterFx(" + quoteForExpression(MASTER_PARAM_NAME.ORDER) + ").value;" +
      "if(orderChoice==" + ORDER_CHOICE.DESCENDING + ")staggerIndex=staggerCount-1-staggerIndex;" +
      "if(orderChoice==" + ORDER_CHOICE.RANDOM + "){seedRandom(masterFx(" + quoteForExpression(MASTER_PARAM_NAME.SEED) + ").value*" +
      RANDOM_SEED_STRIDE + "+" + node.globalIndex + ",true);staggerIndex=Math.floor(random()*staggerCount);}" +
      "delaySec=staggerIndex*delayFrames*hostComp.frameDuration;}\n";
  } else {
    expression += ";\n";
  }

  if (target === TRANSFORM_TARGET.ROTATION) {
    return expression + "value+" + readItem(names.rotation);
  }
  if (target === TRANSFORM_TARGET.SCALE) {
    if (options.scaleInput === SCALE_INPUT.XY) {
      return expression + "var scaleXPercent=" + readItem(names.scaleX) + ",scaleYPercent=" + readItem(names.scaleY) +
        ";\n[value[0]*scaleXPercent/100,value[1]*scaleYPercent/100" + zComponent + "]";
    }
    return expression + "value*" + readItem(names.scale) + "/100";
  }
  if (target === TRANSFORM_TARGET.POSITION) {
    if (options.positionInput === POSITION_INPUT.POINT) {
      return expression + "var offsetPoint=" + readItem(names.position) + ";\n[value[0]+offsetPoint[0],value[1]+offsetPoint[1]" + zComponent + "]";
    }
    return expression + "var offsetX=" + readItem(names.positionX) + ",offsetY=" + readItem(names.positionY) +
      ";\n[value[0]+offsetX,value[1]+offsetY" + zComponent + "]";
  }
  /* 位置の次元分割(X/Y を別プロパティにしたレイヤー)のとき、それぞれ単独の値を返す */
  if (target === TRANSFORM_TARGET.POSITION_X) {
    return expression + (options.positionInput === POSITION_INPUT.POINT ? "value+" + readItem(names.position) + "[0]" : "value+" + readItem(names.positionX));
  }
  return expression + (options.positionInput === POSITION_INPUT.POINT ? "value+" + readItem(names.position) + "[1]" : "value+" + readItem(names.positionY));
}

/* ---------- エクスプレッションの適用（After Effects のプロパティ操作） ---------- */

/* group の中の子プロパティを matchName で取得する。存在しないときは例外ではなく null を返す */
function findProperty(group, matchName) {
  try {
    return group.property(matchName);
  } catch (e) {
    return null;
  }
}

/* プロパティ prop に式を設定し、結果（成功・スキップ・エラー）を report に記録する。
   既存の式は、本ツールが付けた式でない限り、上書き設定がオンでなければ残す（ユーザーの式を壊さないため） */
function setExpressionSafely(prop, expression, options, report, label) {
  var currentExpression;
  if (!prop) {
    report.skipped++;
    return;
  }
  if (!prop.canSetExpression) {
    report.skipped++;
    report.notes.push(label + ": 式を設定できません");
    return;
  }
  currentExpression = prop.expression;
  if (currentExpression !== "" && currentExpression.indexOf(EXPRESSION_MARKER) < 0 && !options.overwriteExisting) {
    report.existing++;
    report.notes.push(label + ": 既存の式があるためスキップしました");
    return;
  }
  prop.expression = expression;
  if (prop.expressionError !== "") {
    report.errors++;
    report.notes.push(label + ": 式エラー " + prop.expressionError);
  } else {
    report.set++;
  }
}

/* node のレイヤーに、位置・拡大率・回転の式を設定する。
   ロックされたレイヤーはプロパティを変更できないため、一時的にロックを外して、終わったら必ず戻す */
function applyNodeExpressions(node, context, report) {
  var layer = node.layer, options = context.options, transformGroup, position, wasLocked, label, isThreeD;
  if (!node.binding) return;
  label = node.comp.name + " / " + node.name;

  /* 変形グループ内の matchName のプロパティへ、target 用の式を設定する。labelSuffix はメッセージ用の項目名 */
  function setTransformExpression(matchName, target, labelSuffix) {
    setExpressionSafely(findProperty(transformGroup, matchName), buildExpr(target, node, context, isThreeD),
      options, report, label + labelSuffix);
  }

  wasLocked = layer.locked;
  if (wasLocked) layer.locked = false;
  try {
    transformGroup = layer.property(PROP_MATCH_NAME.TRANSFORM_GROUP);
    isThreeD = !!layer.threeDLayer;
    if (options.controlledProps.position) {
      position = findProperty(transformGroup, PROP_MATCH_NAME.POSITION);
      /* 次元を分割した位置は、X/Y が別プロパティになり、元の「位置」には式を書けない */
      if (position && position.dimensionsSeparated) {
        setTransformExpression(PROP_MATCH_NAME.POSITION_X, TRANSFORM_TARGET.POSITION_X, " X位置");
        setTransformExpression(PROP_MATCH_NAME.POSITION_Y, TRANSFORM_TARGET.POSITION_Y, " Y位置");
      } else {
        setTransformExpression(PROP_MATCH_NAME.POSITION, TRANSFORM_TARGET.POSITION, " 位置");
      }
    }
    if (options.controlledProps.scale) {
      setTransformExpression(PROP_MATCH_NAME.SCALE, TRANSFORM_TARGET.SCALE, " 拡大率");
    }
    if (options.controlledProps.rotation) {
      setTransformExpression(PROP_MATCH_NAME.ROTATION_Z, TRANSFORM_TARGET.ROTATION, " 回転");
    }
  } finally {
    if (wasLocked) layer.locked = true;
  }
}

/* ---------- コンポ階層の走査と掃除 ---------- */

/* root から、中に含まれるコンポも含めてすべてのレイヤーに callback(layer, comp) を呼ぶ。
   同じコンポを何度も辿らないよう、訪問済みを記録する */
function forEachLayerInTree(root, callback) {
  var seen = {}, stack = [root], comp, i, layer;
  while (stack.length > 0) {
    comp = stack.pop();
    if (seen[comp.id]) continue;
    seen[comp.id] = true;
    for (i = 1; i <= comp.numLayers; i++) {
      layer = comp.layer(i);
      callback(layer, comp);
      if ((layer instanceof AVLayer) && (layer.source instanceof CompItem)) stack.push(layer.source);
    }
  }
}

/* 変形プロパティのうち、式を設定しうるものの matchName 一覧 */
var EXPRESSION_TARGET_PROPERTIES = [
  PROP_MATCH_NAME.POSITION, PROP_MATCH_NAME.POSITION_X, PROP_MATCH_NAME.POSITION_Y, PROP_MATCH_NAME.POSITION_Z,
  PROP_MATCH_NAME.SCALE, PROP_MATCH_NAME.ROTATION_Z
];

/* root 以下のすべてのレイヤーから、本ツールが設定した式（目印付き）だけを消す。消した個数を返す。
   ユーザー自身の式は残す。ロックされたレイヤーは、一時的にロックを外して処理する */
function clearRigExpressions(root) {
  var removedCount = 0;
  forEachLayerInTree(root, function (layer) {
    var transformGroup, i, prop, wasLocked;
    if (!(layer instanceof AVLayer)) return;
    try {
      transformGroup = layer.property(PROP_MATCH_NAME.TRANSFORM_GROUP);
      for (i = 0; i < EXPRESSION_TARGET_PROPERTIES.length; i++) {
        prop = findProperty(transformGroup, EXPRESSION_TARGET_PROPERTIES[i]);
        if (prop && prop.canSetExpression && prop.expression !== "" && prop.expression.indexOf(EXPRESSION_MARKER) === 0) {
          wasLocked = layer.locked;
          if (wasLocked) layer.locked = false;
          prop.expression = "";
          if (wasLocked) layer.locked = true;
          removedCount++;
        }
      }
    } catch (e) {
      /* 変形グループを持たないレイヤーなどは対象外なので、黙って飛ばす */
    }
  });
  return removedCount;
}

/* ---------- 最適化: 使われていない制御の式を外す ---------- */
/* 式は、スライダーが初期値のままでも毎フレーム評価される。
   触っていないパーツの式を外せば、その評価コストをなくせる。 */

/* 制御行の役割(role)ごとの「何もしない値」を返す。この値のままなら、元の値に何も足さない/掛けない */
function neutralValueForRole(role) {
  if (role === TRANSFORM_TARGET.POSITION) return [NEUTRAL_VALUE.OFFSET, NEUTRAL_VALUE.OFFSET];
  if (role === TRANSFORM_TARGET.SCALE || role === TRANSFORM_TARGET.SCALE_X || role === TRANSFORM_TARGET.SCALE_Y) return NEUTRAL_VALUE.SCALE_PERCENT;
  return NEUTRAL_VALUE.OFFSET;
}

/* 制御項目 prop が「未使用」か判定する。
   初期値のまま・キーフレームなし・式なし、のすべてを満たすときだけ未使用とする。
   どれか 1 つでも当てはまらなければ、ユーザーが使っている可能性があるので残す */
function isControlUntouched(prop, role) {
  var neutral = neutralValueForRole(role), value, i;
  if (!prop) return false;
  try {
    if (prop.numKeys > 0) return false;
    if (prop.expression !== "") return false;
    value = prop.value;
    if (neutral instanceof Array) {
      for (i = 0; i < neutral.length; i++) {
        if (value[i] !== neutral[i]) return false;
      }
      return true;
    }
    return value === neutral;
  } catch (e) {
    /* 値を読めないときは、安全側(使用中)として扱う */
    return false;
  }
}

/* 制御行の役割(role)から、それが制御するレイヤーの変形(位置/拡大率/回転)を返す */
function transformTargetOfRole(role) {
  if (role === TRANSFORM_TARGET.POSITION || role === TRANSFORM_TARGET.POSITION_X || role === TRANSFORM_TARGET.POSITION_Y) return TRANSFORM_TARGET.POSITION;
  if (role === TRANSFORM_TARGET.SCALE || role === TRANSFORM_TARGET.SCALE_X || role === TRANSFORM_TARGET.SCALE_Y) return TRANSFORM_TARGET.SCALE;
  return TRANSFORM_TARGET.ROTATION;
}

/* 変形(位置/拡大率/回転)に対応する、式を持ちうるプロパティの matchName 一覧を返す */
function propertyMatchNamesOfTarget(target) {
  if (target === TRANSFORM_TARGET.POSITION) return [PROP_MATCH_NAME.POSITION, PROP_MATCH_NAME.POSITION_X, PROP_MATCH_NAME.POSITION_Y];
  if (target === TRANSFORM_TARGET.SCALE) return [PROP_MATCH_NAME.SCALE];
  return [PROP_MATCH_NAME.ROTATION_Z];
}

/* 計画 plan の各ノードについて、制御項目が未使用の変形から本ツールの式を外す。
   propMaps = { エフェクト名: { 項目名: Property } }（現在のコンポ内のエフェクトの項目）。
   位置・拡大率・回転は変形ごとに独立して判定する（位置だけ使っているなら、拡大率と回転の式だけ外せる）。
   戻り値: { removed(外した式の数), kept(残した式の数), missing(対応するエフェクトが見つからないノード数) } */
function optimizeNodes(plan, propMaps) {
  var result = { removed: 0, kept: 0, missing: 0 }, i, node, role, itemMap, target, untouchedByTarget, transformGroup, matchNames, j, prop, wasLocked;
  for (i = 0; i < plan.flat.length; i++) {
    node = plan.flat[i];
    if (!node.binding) continue;
    itemMap = propMaps[node.binding.effectName];
    if (!itemMap) {
      result.missing++;
      continue;
    }

    untouchedByTarget = {};
    untouchedByTarget[TRANSFORM_TARGET.POSITION] = true;
    untouchedByTarget[TRANSFORM_TARGET.SCALE] = true;
    untouchedByTarget[TRANSFORM_TARGET.ROTATION] = true;
    for (role in node.binding.names) {
      if (!isControlUntouched(itemMap[node.binding.names[role]], role)) untouchedByTarget[transformTargetOfRole(role)] = false;
    }

    wasLocked = node.layer.locked;
    if (wasLocked) node.layer.locked = false;
    try {
      transformGroup = node.layer.property(PROP_MATCH_NAME.TRANSFORM_GROUP);
      for (target in untouchedByTarget) {
        matchNames = propertyMatchNamesOfTarget(target);
        for (j = 0; j < matchNames.length; j++) {
          prop = findProperty(transformGroup, matchNames[j]);
          /* 本ツールの式（目印が先頭にあるもの）以外は、ユーザーの式なので触らない */
          if (!prop || !prop.canSetExpression || prop.expression === "" || prop.expression.indexOf(EXPRESSION_MARKER) !== 0) continue;
          if (untouchedByTarget[target]) {
            prop.expression = "";
            result.removed++;
          } else {
            result.kept++;
          }
        }
      }
    } finally {
      if (wasLocked) node.layer.locked = true;
    }
  }
  return result;
}

/* ================================================================
 * 第3部: After Effects 側の処理（ファイル出力、エフェクト適用、パネルUI）
 * ================================================================ */

/* ---------- 定数 ---------- */

var SCRIPT_NAME = "パーツ制御ビルダー";
var SCRIPT_VERSION = "1.0.0";

/* 設定を保存するときのセクション名（After Effects の設定ファイル内で他のスクリプトと区別するため） */
var SETTINGS_SECTION = "PartsRigBuilder";

/* 一時ファイルの名前の接頭辞。他のアプリのファイルと区別するため */
var TEMP_FILE_PREFIX = "PRB_";

/* 「スクリプトによるファイルへの書き込みとネットワークへのアクセスを許可」の設定キー。1 = 許可 */
var PREF_SECTION_MAIN = "Main Pref Section";
var PREF_KEY_FILE_NETWORK = "Pref_SCRIPTING_FILE_NETWORK_SECURITY";
var PREF_VALUE_ALLOWED = 1;

/* 画面に出す結果メッセージの最大行数（これを超えた分は件数だけ表示する） */
var MAX_NOTES_SHOWN = 30;

/* パネルの部品の大きさ */
var PREVIEW_SIZE = [260, 120];
var LOG_SIZE = [260, 90];
var HOST_DROPDOWN_WIDTH = 170;
var CONTROL_NAME_FIELD_CHARS = 16;
var MAX_PARAMS_FIELD_CHARS = 5;

/* ドロップダウンの表示名と、選ばれた番号に対応する設定値。2つの配列は同じ並びにしておく */
var POSITION_INPUT_LABELS = ["ポイントコントロール", "スライダー（X・Y）"];
var POSITION_INPUT_VALUES = [POSITION_INPUT.POINT, POSITION_INPUT.SLIDER];
var SCALE_INPUT_LABELS = ["縦横共通（1本）", "縦横別（X・Y）"];
var SCALE_INPUT_VALUES = [SCALE_INPUT.UNIFORM, SCALE_INPUT.XY];
var STAGGER_LABELS = ["使える（マスターで切替）", "使わない（最軽量）"];
var STAGGER_VALUES = [STAGGER_MODE.MASTER, STAGGER_MODE.OFF];
var TIME_SYNC_LABELS = ["固定値（軽い）", "動的に追従（重い）", "なし"];
var TIME_SYNC_VALUES = [TIME_SYNC_MODE.BAKED, TIME_SYNC_MODE.DYNAMIC, TIME_SYNC_MODE.NONE];

/* 「置き場所」ドロップダウンの先頭項目 = 対象コンポの中に制御レイヤーを置く */
var HOST_SAME_COMP_LABEL = "対象コンポ内";
var HOST_SAME_COMP_INDEX = 0;

/* ---------- After Effects の操作 ---------- */

/* 「スクリプトによるファイルへの書き込み」が許可されているか調べる。
   設定を読めない環境では、判定できないので許可されているものとして進める（実際の書き込みで失敗すれば別のエラーになる） */
function canWriteFiles() {
  try {
    return app.preferences.getPrefAsLong(PREF_SECTION_MAIN, PREF_KEY_FILE_NETWORK) === PREF_VALUE_ALLOWED;
  } catch (e) {
    return true;
  }
}

/* 生成した .ffx を一時フォルダに書き出して、そのファイルを返す。
   applyPreset はファイルパスしか受け取れないため、ファイルを経由する必要がある */
function writeTempFfx(binaryContent, nameTag) {
  var file = new File(Folder.temp.fsName + "/" + TEMP_FILE_PREFIX + nameTag + ".ffx");
  file.encoding = "BINARY";
  if (!file.open("w")) {
    throw new Error("一時ファイルを書き込めません。環境設定 > スクリプトとエクスプレッション >「スクリプトによるファイルへの書き込みを許可」をオンにしてください。");
  }
  file.write(binaryContent);
  file.close();
  return file;
}

/* layer だけを選択状態にして、それまで選択されていたレイヤーの一覧を返す。
   applyPreset は、呼び出したレイヤーではなく「選択中のレイヤー」に適用されるため
   （何も選択していないと、AE は平面を新規作成してそこに適用してしまう）。
   選択は、レイヤーのあるコンポが画面に開かれていないと反映されないので、先に開く */
function selectOnlyLayer(layer) {
  var previousSelection = [], comp, selected, i;
  try {
    comp = layer.containingComp;
    try {
      comp.openInViewer();
    } catch (e) {
      /* 開けなくても、選択だけで足りる場合があるので続行する */
    }
    selected = comp.selectedLayers;
    for (i = 0; i < selected.length; i++) {
      previousSelection.push(selected[i]);
      selected[i].selected = false;
    }
    layer.selected = true;
  } catch (e2) {
    /* 選択を操作できなくても、適用後の個数確認で失敗を検出できる */
  }
  return previousSelection;
}

/* selectOnlyLayer で退避した選択状態に戻す */
function restoreSelection(layer, previousSelection) {
  var i;
  try {
    layer.selected = false;
    for (i = 0; i < previousSelection.length; i++) previousSelection[i].selected = true;
  } catch (e) {
    /* レイヤーが既に無い場合などは、戻せなくても作業結果に影響しない */
  }
}

/* 適用のずれで誤って作られた平面を消す。comp の先頭から、増えた枚数ぶんだけを調べる。
   増えた分しか調べないのは、ユーザー自身の平面レイヤーを誤って消さないため */
function removeStraySolids(comp, layerCountBefore) {
  var extraCount, i, layer;
  try {
    extraCount = comp.numLayers - layerCountBefore;
  } catch (e) {
    return;
  }
  for (i = Math.min(extraCount, comp.numLayers); i >= 1; i--) {
    try {
      layer = comp.layer(i);
      if (layer.source && layer.source.mainSource instanceof SolidSource) layer.remove();
    } catch (e2) {
      /* 調べられないレイヤーは、そのままにする */
    }
  }
}

/* 疑似エフェクト spec を layer に1個適用して、追加されたエフェクトを返す。
   適用後に「個数が1つ増えたか」「matchName が想定どおりか」を確認する。
   定義が壊れていると AE は黙って何も追加しないことがあるため、ここで失敗を検出する */
function applyPseudoEffect(layer, spec) {
  var file = writeTempFfx(buildFfx(spec), spec.matchName.substr(EFFECT_MATCH_PREFIX.length));
  var effectParade = layer.property(PROP_MATCH_NAME.EFFECT_PARADE);
  var countBefore = effectParade.numProperties, effect;
  var comp = layer.containingComp, layerCountBefore = comp.numLayers;
  var previousSelection = selectOnlyLayer(layer);
  try {
    layer.applyPreset(file);
    removeStraySolids(comp, layerCountBefore);
  } finally {
    restoreSelection(layer, previousSelection);
  }
  try {
    file.remove();
  } catch (e) {
    /* 一時ファイルが消せなくても、動作には影響しないので無視する */
  }
  if (effectParade.numProperties !== countBefore + 1) {
    throw new Error("エフェクトを適用できませんでした: " + spec.effectName);
  }
  effect = effectParade.property(effectParade.numProperties);
  if (effect.matchName !== spec.matchName) {
    throw new Error("適用されたエフェクトのmatchNameが一致しません: " + effect.matchName);
  }
  effect.name = spec.effectName;
  return effect;
}

/* group の下にあるすべての「値を持つプロパティ」を、名前をキーにして propertyMap に集める。
   疑似エフェクトの項目はグループの入れ子になっているため、再帰でたどる */
function collectLeafProperties(group, propertyMap) {
  var i, child;
  for (i = 1; i <= group.numProperties; i++) {
    child = group.property(i);
    if (child.propertyType === PropertyType.PROPERTY) {
      propertyMap[child.name] = child;
    } else {
      collectLeafProperties(child, propertyMap);
    }
  }
}

/* 適用直後のエフェクトの初期値が定義どおりか確認し、違っていれば定義の値に直す。
   定義ファイル内の初期値が実際の値に反映されない場合への保険 */
function ensureInitialValues(effect, spec, report) {
  var propertyMap = {}, i, item, prop, fixedCount = 0;
  try {
    collectLeafProperties(effect, propertyMap);
  } catch (e) {
    return;
  }
  for (i = 0; i < spec.items.length; i++) {
    item = spec.items[i];
    if (item.kind !== "slider" && item.kind !== "check" && item.kind !== "popup") continue;
    prop = propertyMap[item.name];
    if (!prop) continue;
    try {
      if (prop.value !== item.defaultValue) {
        prop.setValue(item.defaultValue);
        fixedCount++;
      }
    } catch (e2) {
      /* 読み取り専用などで直せない項目は、そのままにする */
    }
  }
  if (fixedCount > 0) report.notes.push(spec.effectName + ": 初期値を" + fixedCount + "件補正しました");
}

/* layer から、本ツールが作ったエフェクト（matchName の接頭辞で判定）をすべて削除し、削除した数を返す。
   後ろから消すのは、削除するたびに番号が詰まるため */
function removeRigEffects(layer) {
  var effectParade = layer.property(PROP_MATCH_NAME.EFFECT_PARADE), i, removedCount = 0;
  for (i = effectParade.numProperties; i >= 1; i--) {
    if (effectParade.property(i).matchName.indexOf(EFFECT_MATCH_PREFIX) === 0) {
      effectParade.property(i).remove();
      removedCount++;
    }
  }
  return removedCount;
}

/* comp の中から、指定した名前のレイヤーを探す。なければ null */
function findControlLayer(comp, layerName) {
  var i, layer;
  for (i = 1; i <= comp.numLayers; i++) {
    layer = comp.layer(i);
    if (layer.name === layerName) return layer;
  }
  return null;
}

/* 制御用のヌルレイヤーを探し、なければ作って最前面に置く。
   同名の通常レイヤーがある場合は、それにエフェクトを付けると別物を壊すので、エラーにして止める */
function ensureControlLayer(comp, layerName) {
  var layer = findControlLayer(comp, layerName);
  if (layer) {
    if (!layer.nullLayer) {
      throw new Error("「" + layerName + "」という名前の通常レイヤーが既にあります。制御レイヤー名を変更してください。");
    }
    return layer;
  }
  layer = comp.layers.addNull(comp.duration);
  layer.name = layerName;
  /* コンポの全期間に存在させる（途中で切れると、その区間だけスライダーが効かなくなる） */
  layer.startTime = 0;
  layer.inPoint = 0;
  layer.outPoint = comp.duration;
  layer.moveToBeginning();
  return layer;
}

/* ---------- 作成 / 再適用 / 最適化 / 解除 ---------- */

/* プロジェクト内のコンポ名ごとの個数を数える。
   同名コンポがあると、式の comp("名前") でどれを指すか決まらないため、事前に把握しておく */
function countCompNamesInProject() {
  var counts = {}, i, item;
  for (i = 1; i <= app.project.numItems; i++) {
    item = app.project.item(i);
    if (item instanceof CompItem) counts[item.name] = (counts[item.name] || 0) + 1;
  }
  return counts;
}

/* 作業結果を記録するレポートを新しく作る */
function createReport() {
  return { set: 0, existing: 0, errors: 0, skipped: 0, notes: [] };
}

/* 制御レイヤーを置くコンポ(host)が対象コンポ(root)を1回だけ直接含むとき、
   スライダーのキーフレームは host の時間で打たれる。root の時間と合わせるために足す開始時間を、
   { fixed: 秒数(固定値), dynamic: 式の断片 } で返す。
   host の名前が重複していなければ動的に追従でき、重複していれば固定値にするしかない */
function calcHostTimeOffset(host, root, nameCounts, timeSyncMode) {
  var i, layer, found = null, matchCount = 0;
  if (host.id === root.id || timeSyncMode === TIME_SYNC_MODE.NONE) return { fixed: 0, dynamic: "" };
  for (i = 1; i <= host.numLayers; i++) {
    layer = host.layer(i);
    if ((layer instanceof AVLayer) && (layer.source instanceof CompItem) && layer.source.id === root.id) {
      matchCount++;
      found = layer;
    }
  }
  /* 0個または複数個含むときは、どの時間に合わせるべきか決められないので補正しない */
  if (matchCount !== 1) return { fixed: 0, dynamic: "" };
  if (timeSyncMode === TIME_SYNC_MODE.DYNAMIC && !(nameCounts[host.name] > 1)) {
    return { fixed: 0, dynamic: "+" + makeLayerReference(host, found) + ".startTime" };
  }
  return { fixed: found.startTime, dynamic: "" };
}

/* 式の生成に必要な情報（制御レイヤーの場所、時間補正、名前など）をまとめて返す */
function makeExpressionContext(comp, options, host, plan, nameCounts) {
  var timeOffset = calcHostTimeOffset(host, comp, nameCounts, options.timeSyncMode);
  return {
    hostComp: host,
    hostFixedOffset: timeOffset.fixed,
    hostDynamicOffset: timeOffset.dynamic,
    controlLayerName: options.controlLayerName,
    masterEffectName: plan.master ? plan.master.effectName : "",
    options: options
  };
}

/* 制御レイヤーのエフェクトを、「エフェクト名 → { 項目名 → プロパティ }」の表にして返す。
   本ツールのエフェクトだけが対象 */
function collectEffectPropertyMaps(controlLayer) {
  var effectParade = controlLayer.property(PROP_MATCH_NAME.EFFECT_PARADE), maps = {}, i, effect, propertyMap;
  for (i = 1; i <= effectParade.numProperties; i++) {
    effect = effectParade.property(i);
    if (effect.matchName.indexOf(EFFECT_MATCH_PREFIX) !== 0) continue;
    propertyMap = {};
    collectLeafProperties(effect, propertyMap);
    maps[effect.name] = propertyMap;
  }
  return maps;
}

/* 既存の制御レイヤーを取得する。なければ「作成」を促すエラーにする */
function requireControlLayer(host, options) {
  var layer = findControlLayer(host, options.controlLayerName);
  if (!layer || !layer.nullLayer) {
    throw new Error("制御レイヤーが見つかりません。「作成 / 再構築」を実行してください。");
  }
  return layer;
}

/* comp を対象に、制御レイヤー・疑似エフェクト・エクスプレッションを一式作る（既にあれば作り直す）。
   戻り値: { plan, report }。
   エフェクトの適用時に制御レイヤーのあるコンポを画面に開くので、終わったら元のコンポを開き直す
   （開いたままだと、パネルの「対象コンポ」が勝手に切り替わってしまうため） */
function runBuild(comp, options, host) {
  var originalActiveItem = app.project.activeItem;
  try {
    return buildRig(comp, options, host);
  } finally {
    if (originalActiveItem instanceof CompItem) {
      try {
        originalActiveItem.openInViewer();
      } catch (e) {
        /* 元のコンポを開き直せなくても、作成結果には影響しない */
      }
    }
  }
}

/* runBuild の本体（制御レイヤーの用意、エフェクトの適用、式の設定） */
function buildRig(comp, options, host) {
  var report = createReport();
  var nameCounts = countCompNamesInProject();
  var plan = planRig(comp, options, host, nameCounts);
  var controlLayer, effect, i, context, hasLayerOutsideHost = false;

  for (i = 0; i < plan.flat.length; i++) {
    if (plan.flat[i].comp.id !== host.id) hasLayerOutsideHost = true;
  }
  /* 制御レイヤーを置くコンポが同名だと、別コンポ内のレイヤーの式から host を特定できない */
  if (hasLayerOutsideHost && nameCounts[host.name] > 1) {
    throw new Error("制御レイヤーを置くコンポ「" + host.name + "」と同じ名前のコンポが他にもあります。式から区別できないため、どちらかの名前を変えてください。");
  }
  if (plan.stats.layers === 0) {
    throw new Error("対象になるレイヤーがありません。（対象レイヤーの種類の設定を確認してください）");
  }

  /* 古い式を先に消す。残っていると、新しい式の設定が「既存の式あり」としてスキップされてしまうため */
  clearRigExpressions(comp);
  controlLayer = ensureControlLayer(host, options.controlLayerName);
  removeRigEffects(controlLayer);

  /* 制御レイヤーを最前面に挿入すると、同じコンポ内のレイヤー番号が1つずれる。
     式はレイヤー番号で参照する場合があるため、挿入後にもう一度計画を作り直す */
  plan = planRig(comp, options, host, nameCounts);
  if (plan.baked > 0) {
    report.notes.push("同名のコンポがあるため、" + plan.baked + " 件は開始時間のずれを固定値にしました");
  }

  if (plan.master) {
    effect = applyPseudoEffect(controlLayer, plan.master);
    ensureInitialValues(effect, plan.master, report);
  }
  for (i = 0; i < plan.effects.length; i++) {
    effect = applyPseudoEffect(controlLayer, plan.effects[i]);
    ensureInitialValues(effect, plan.effects[i], report);
  }

  context = makeExpressionContext(comp, options, host, plan, nameCounts);
  for (i = 0; i < plan.flat.length; i++) applyNodeExpressions(plan.flat[i], context, report);
  controlLayer.selected = true;
  return { plan: plan, report: report };
}

/* 既存の制御エフェクトはそのままに、すべてのレイヤーへ式だけを付け直す（「最適化」で外した式を元に戻す用途） */
function runReapply(comp, options, host) {
  var report = createReport();
  var nameCounts = countCompNamesInProject();
  var plan = planRig(comp, options, host, nameCounts);
  var controlLayer = requireControlLayer(host, options);
  var maps = collectEffectPropertyMaps(controlLayer), i, context;

  /* 設定を変えた後だと、エフェクトの構成が今の設定と食い違う。そのまま式を付けると存在しない項目を参照してしまうので止める */
  for (i = 0; i < plan.flat.length; i++) {
    if (plan.flat[i].binding && !maps[plan.flat[i].binding.effectName]) {
      throw new Error("制御エフェクトの構成が現在の設定と合いません。「作成 / 再構築」を実行してください。");
    }
  }
  context = makeExpressionContext(comp, options, host, plan, nameCounts);
  for (i = 0; i < plan.flat.length; i++) applyNodeExpressions(plan.flat[i], context, report);
  return { plan: plan, report: report };
}

/* 触っていない制御に対応するレイヤーの式を外して、評価の負荷を減らす。戻り値は optimizeNodes と同じ */
function runOptimize(comp, options, host) {
  var plan = planRig(comp, options, host, countCompNamesInProject());
  var controlLayer = requireControlLayer(host, options);
  return optimizeNodes(plan, collectEffectPropertyMaps(controlLayer));
}

/* 本ツールが設定した式と制御エフェクトを取り除く。removeLayer が true なら制御レイヤー自体も削除する */
function runClear(comp, options, removeLayer, host) {
  var removedExpressions = clearRigExpressions(comp);
  var controlLayer = findControlLayer(host, options.controlLayerName);
  var removedEffects = 0, layerRemoved = false;
  if (controlLayer && controlLayer.nullLayer) {
    removedEffects = removeRigEffects(controlLayer);
    if (removeLayer) {
      controlLayer.remove();
      layerRemoved = true;
    }
  }
  return { removed: removedExpressions, effects: removedEffects, layerRemoved: layerRemoved };
}

/* ---------- パネル ---------- */

/* parent に、部品を横に並べる行を追加して返す */
function addRow(parent) {
  var row = parent.add("group");
  row.orientation = "row";
  row.alignChildren = ["left", "center"];
  return row;
}

/* parent に「ラベル + ドロップダウン」の行を追加し、ドロップダウンを返す（先頭の項目を選択済みにする） */
function addDropdownRow(parent, labelText, itemLabels) {
  var row = addRow(parent), dropdown;
  row.add("statictext", undefined, labelText);
  dropdown = row.add("dropdownlist", undefined, itemLabels);
  dropdown.selection = 0;
  return dropdown;
}

/* parent に、縦に部品を並べる枠(パネル)を追加して返す */
function addPanel(parent, title) {
  var panel = parent.add("panel", undefined, title);
  panel.orientation = "column";
  panel.alignChildren = ["fill", "top"];
  return panel;
}

/* ScriptUI パネル（ドッキング可能なウィンドウ）または単独ウィンドウを作って表示する */
function buildPanel(hostObject) {
  var win = (hostObject instanceof Panel) ? hostObject : new Window("palette", SCRIPT_NAME + " v" + SCRIPT_VERSION, undefined, { resizeable: true });
  var layerTypeChecks = {}, propChecks = {};
  var hostCompList = [null];   /* 「置き場所」ドロップダウンの各項目に対応するコンポ。先頭 null = 対象コンポ内 */
  var targetLabel, previewText, logText, refreshButton;
  var positionInputDropdown, scaleInputDropdown, staggerDropdown, timeSyncDropdown, hostDropdown;
  var controlNameField, maxParamsField, selfCompCheck, overwriteCheck, removeLayerCheck;
  var buildButton, optimizeButton, reapplyButton, clearButton;
  var panel, row, leftColumn, rightColumn, key;

  win.orientation = "column";
  win.alignChildren = ["fill", "top"];
  win.spacing = 6;
  win.margins = 8;

  /* 対象コンポの表示と更新ボタン */
  row = win.add("group");
  row.orientation = "row";
  row.alignChildren = ["fill", "center"];
  targetLabel = row.add("statictext", undefined, "対象: -", { truncate: "end" });
  targetLabel.alignment = ["fill", "center"];
  refreshButton = row.add("button", undefined, "更新");
  refreshButton.alignment = ["right", "center"];

  /* 制御対象にするレイヤーの種類 */
  panel = win.add("panel", undefined, "対象レイヤーの種類");
  panel.orientation = "row";
  panel.alignChildren = ["left", "top"];
  leftColumn = panel.add("group");
  leftColumn.orientation = "column";
  leftColumn.alignChildren = ["left", "top"];
  rightColumn = panel.add("group");
  rightColumn.orientation = "column";
  rightColumn.alignChildren = ["left", "top"];
  layerTypeChecks[LAYER_KIND.FOOTAGE] = leftColumn.add("checkbox", undefined, "画像・動画（PSDパーツ）");
  layerTypeChecks[LAYER_KIND.COMP] = leftColumn.add("checkbox", undefined, "コンポ（中身も再帰）");
  layerTypeChecks[LAYER_KIND.SHAPE] = leftColumn.add("checkbox", undefined, "シェイプ");
  layerTypeChecks[LAYER_KIND.TEXT] = leftColumn.add("checkbox", undefined, "テキスト");
  layerTypeChecks[LAYER_KIND.SOLID] = rightColumn.add("checkbox", undefined, "平面");
  layerTypeChecks[LAYER_KIND.NULL_OBJECT] = rightColumn.add("checkbox", undefined, "ヌル");
  layerTypeChecks[LAYER_KIND.ADJUSTMENT] = rightColumn.add("checkbox", undefined, "調整レイヤー");
  /* ガイドレイヤーは「種類」ではなく別の属性なので、キーを分けて持つ */
  layerTypeChecks.guide = rightColumn.add("checkbox", undefined, "ガイドレイヤー");
  layerTypeChecks[LAYER_KIND.FOOTAGE].value = true;
  layerTypeChecks[LAYER_KIND.COMP].value = true;
  layerTypeChecks[LAYER_KIND.SHAPE].value = true;
  layerTypeChecks[LAYER_KIND.TEXT].value = true;
  layerTypeChecks[LAYER_KIND.SOLID].value = true;

  /* 制御する項目（位置・拡大率・回転）と入力方式 */
  panel = addPanel(win, "制御する項目");
  row = panel.add("group");
  row.orientation = "row";
  propChecks.position = row.add("checkbox", undefined, "位置");
  propChecks.scale = row.add("checkbox", undefined, "拡大率");
  propChecks.rotation = row.add("checkbox", undefined, "回転");
  propChecks.position.value = true;
  propChecks.scale.value = true;
  propChecks.rotation.value = true;
  positionInputDropdown = addDropdownRow(panel, "位置の入力:", POSITION_INPUT_LABELS);
  scaleInputDropdown = addDropdownRow(panel, "拡大率:", SCALE_INPUT_LABELS);
  selfCompCheck = panel.add("checkbox", undefined, "子コンポ自身（コンポレイヤー）の位置・拡大率・回転も制御する");
  selfCompCheck.value = true;

  /* 出力の設定 */
  panel = addPanel(win, "出力");
  row = addRow(panel);
  row.add("statictext", undefined, "制御レイヤー名:");
  controlNameField = row.add("edittext", undefined, DEFAULT_CONTROL_LAYER_NAME);
  controlNameField.characters = CONTROL_NAME_FIELD_CHARS;
  hostDropdown = addDropdownRow(panel, "置き場所:", [HOST_SAME_COMP_LABEL]);
  hostDropdown.preferredSize.width = HOST_DROPDOWN_WIDTH;
  staggerDropdown = addDropdownRow(panel, "スタッガー:", STAGGER_LABELS);
  timeSyncDropdown = addDropdownRow(panel, "時間のずれ補正:", TIME_SYNC_LABELS);
  row = addRow(panel);
  row.add("statictext", undefined, "1エフェクトの最大項目数:");
  maxParamsField = row.add("edittext", undefined, String(PARAMS_PER_EFFECT.DEFAULT));
  maxParamsField.characters = MAX_PARAMS_FIELD_CHARS;
  overwriteCheck = panel.add("checkbox", undefined, "既存のエクスプレッションを上書きする");

  /* プレビュー（作成前に、どういう構成になるかを確認する） */
  previewText = win.add("edittext", undefined, "", { multiline: true, readonly: true, scrollable: true });
  previewText.preferredSize = PREVIEW_SIZE;
  previewText.alignment = ["fill", "fill"];

  /* 操作ボタン */
  row = win.add("group");
  row.orientation = "row";
  row.alignChildren = ["fill", "center"];
  buildButton = row.add("button", undefined, "作成 / 再構築");
  clearButton = row.add("button", undefined, "解除");
  row = win.add("group");
  row.orientation = "row";
  row.alignChildren = ["fill", "center"];
  optimizeButton = row.add("button", undefined, "最適化（未使用の式を外す）");
  reapplyButton = row.add("button", undefined, "式を再適用");
  removeLayerCheck = win.add("checkbox", undefined, "解除時に制御レイヤーも削除する");

  logText = win.add("edittext", undefined, "", { multiline: true, readonly: true, scrollable: true });
  logText.preferredSize = LOG_SIZE;
  logText.alignment = ["fill", "fill"];

  /* ---- パネルの動作 ---- */

  /* 結果欄に1行追加する（edittext の改行は "\r"） */
  function log(message) {
    logText.text = logText.text + message + "\r";
  }

  /* いま開いている（アクティブな）コンポを返す。コンポ以外が選ばれているときは null */
  function getActiveComp() {
    var item = app.project.activeItem;
    return (item instanceof CompItem) ? item : null;
  }

  /* 「置き場所」ドロップダウンの項目を、プロジェクト内のコンポ一覧で作り直す。
     再構築前に選んでいたコンポは、できるだけ選択したままにする */
  function fillHostList() {
    var keepCompId = -1, i, item, index, selectedIndex = hostDropdown.selection ? hostDropdown.selection.index : HOST_SAME_COMP_INDEX;
    if (selectedIndex > HOST_SAME_COMP_INDEX && hostCompList[selectedIndex]) {
      try {
        keepCompId = hostCompList[selectedIndex].id;
      } catch (e) {
        /* 選んでいたコンポが削除されていると id を読めない。その場合は選択を引き継がない */
        keepCompId = -1;
      }
    }
    hostDropdown.removeAll();
    hostCompList = [null];
    hostDropdown.add("item", HOST_SAME_COMP_LABEL);
    for (i = 1; i <= app.project.numItems; i++) {
      item = app.project.item(i);
      if (item instanceof CompItem) {
        hostDropdown.add("item", item.name);
        hostCompList.push(item);
      }
    }
    hostDropdown.selection = HOST_SAME_COMP_INDEX;
    if (keepCompId >= 0) {
      for (index = 1; index < hostCompList.length; index++) {
        if (hostCompList[index].id === keepCompId) {
          hostDropdown.selection = index;
          break;
        }
      }
    }
  }

  /* 制御レイヤーを置くコンポを返す。「対象コンポ内」のときは対象コンポ自身 */
  function getHostComp(targetComp) {
    var selectedIndex = hostDropdown.selection ? hostDropdown.selection.index : HOST_SAME_COMP_INDEX;
    var host = (selectedIndex > HOST_SAME_COMP_INDEX) ? hostCompList[selectedIndex] : null;
    return host || targetComp;
  }

  /* 画面の入力内容から、planRig / runBuild に渡す options を作る */
  function readOptions() {
    var options = defaultOptions(), kind, maxParams;
    for (kind in layerTypeChecks) {
      if (kind === "guide") continue;
      options.layerTypes[kind] = layerTypeChecks[kind].value;
    }
    options.includeGuideLayers = layerTypeChecks.guide.value;
    /* 「コンポ」にチェックがなければ、中身にも入らない */
    options.recurseIntoComps = layerTypeChecks[LAYER_KIND.COMP].value;
    options.controlledProps.position = propChecks.position.value;
    options.controlledProps.scale = propChecks.scale.value;
    options.controlledProps.rotation = propChecks.rotation.value;
    options.positionInput = POSITION_INPUT_VALUES[positionInputDropdown.selection.index];
    options.scaleInput = SCALE_INPUT_VALUES[scaleInputDropdown.selection.index];
    options.controlCompLayers = selfCompCheck.value;
    options.staggerMode = STAGGER_VALUES[staggerDropdown.selection.index];
    options.timeSyncMode = TIME_SYNC_VALUES[timeSyncDropdown.selection.index];

    maxParams = parseInt(maxParamsField.text, 10);
    if (isNaN(maxParams)) maxParams = PARAMS_PER_EFFECT.DEFAULT;
    options.maxParamsPerEffect = Math.max(PARAMS_PER_EFFECT.MIN_INPUT, Math.min(PARAMS_PER_EFFECT.MAX_INPUT, maxParams));

    options.controlLayerName = truncateUtf8(controlNameField.text.replace(/^\s+|\s+$/g, ""), PARAM_NAME_MAX_BYTES);
    if (options.controlLayerName === "") options.controlLayerName = DEFAULT_CONTROL_LAYER_NAME;
    /* 制御レイヤー名とマスターのエフェクト名が同じだと、エフェクト名で引く式が曖昧になる */
    if (options.controlLayerName === options.masterEffectName) options.masterEffectName = options.masterEffectName + "2";
    options.overwriteExisting = overwriteCheck.value;
    return options;
  }

  /* 対象コンポの構成（レイヤー数・グループ数・項目数・階層）をプレビュー欄に表示する */
  function refreshPreview() {
    var comp = getActiveComp(), plan;
    if (!comp) {
      targetLabel.text = "対象: （コンポをアクティブにしてください）";
      previewText.text = "";
      return;
    }
    targetLabel.text = "対象: " + comp.name;
    try {
      plan = planRig(comp, readOptions(), getHostComp(comp), countCompNamesInProject());
      previewText.text = "レイヤー " + plan.stats.layers + " / グループ " + plan.stats.groups + " / 項目 " + plan.stats.params +
        " / エフェクト " + plan.stats.effects + (plan.master ? "（＋一括スタッガー）" : "") + "\r" + previewLines(plan.nodes).join("\r");
    } catch (e) {
      previewText.text = "プレビューできません: " + e.toString();
    }
  }

  /* 保存対象の設定: キー名と、その値を持つ画面部品の対応表 */
  function savedDropdowns() {
    return [
      { key: "xy", dropdown: positionInputDropdown },
      { key: "scale", dropdown: scaleInputDropdown },
      { key: "stagger", dropdown: staggerDropdown },
      { key: "timeSync", dropdown: timeSyncDropdown }
    ];
  }

  /* 主な設定を After Effects の設定ファイルに保存する（次回起動時に復元するため）。保存できなくても作業には支障がない */
  function saveSettings() {
    var options = readOptions(), saved = savedDropdowns(), i;
    try {
      app.settings.saveSetting(SETTINGS_SECTION, "controlLayerName", options.controlLayerName);
      app.settings.saveSetting(SETTINGS_SECTION, "maxParams", String(options.maxParamsPerEffect));
      for (i = 0; i < saved.length; i++) {
        app.settings.saveSetting(SETTINGS_SECTION, saved[i].key, String(saved[i].dropdown.selection.index));
      }
    } catch (e) {
      /* 設定ファイルに書けない環境では、保存せずに続行する */
    }
  }

  /* 保存済みの設定があれば画面に復元する */
  function loadSettings() {
    var saved = savedDropdowns(), i;
    try {
      if (app.settings.haveSetting(SETTINGS_SECTION, "controlLayerName")) controlNameField.text = app.settings.getSetting(SETTINGS_SECTION, "controlLayerName");
      if (app.settings.haveSetting(SETTINGS_SECTION, "maxParams")) maxParamsField.text = app.settings.getSetting(SETTINGS_SECTION, "maxParams");
      for (i = 0; i < saved.length; i++) {
        if (app.settings.haveSetting(SETTINGS_SECTION, saved[i].key)) {
          saved[i].dropdown.selection = parseInt(app.settings.getSetting(SETTINGS_SECTION, saved[i].key), 10);
        }
      }
    } catch (e) {
      /* 壊れた設定値は読み込まず、初期値のまま続行する */
    }
  }

  /* アクティブなコンポを対象に action(comp) を実行する。
     1回の操作を「元に戻す」で一括して戻せるよう、Undo グループにまとめる。
     エラーは結果欄に出して、パネルが止まらないようにする */
  function runUndoable(undoLabel, action) {
    var comp = getActiveComp();
    logText.text = "";
    if (!comp) {
      alert("コンポをアクティブにしてから実行してください。");
      return;
    }
    app.beginUndoGroup(SCRIPT_NAME + ": " + undoLabel);
    try {
      action(comp);
    } catch (e) {
      log("エラー: " + e.toString() + (e.line ? " (行 " + e.line + ")" : ""));
    } finally {
      app.endUndoGroup();
    }
  }

  /* 「作成 / 再構築」ボタンの処理 */
  function onBuildClicked() {
    var options;
    if (!getActiveComp()) {
      logText.text = "";
      alert("コンポをアクティブにしてから実行してください。");
      return;
    }
    if (!canWriteFiles()) {
      alert("「スクリプトによるファイルへの書き込みを許可」がオフです。\r環境設定 > スクリプトとエクスプレッション でオンにしてから、もう一度実行してください。");
      return;
    }
    options = readOptions();
    if (!options.controlledProps.position && !options.controlledProps.scale && !options.controlledProps.rotation) {
      alert("制御する項目を1つ以上選んでください。");
      return;
    }
    saveSettings();
    runUndoable("作成", function (comp) {
      var result = runBuild(comp, options, getHostComp(comp)), k;
      var effectCount = result.plan.stats.effects + (result.plan.master ? 1 : 0);
      log("完了: レイヤー " + result.plan.stats.layers + " 枚 / エフェクト " + effectCount + " 個 / 項目 " + result.plan.stats.params);
      log("式を設定: " + result.report.set + " 件" + (result.report.existing ? " / 既存の式でスキップ: " + result.report.existing : "") + (result.report.errors ? " / エラー: " + result.report.errors : ""));
      for (k = 0; k < result.plan.warnings.length; k++) log("注意: " + result.plan.warnings[k]);
      for (k = 0; k < result.report.notes.length && k < MAX_NOTES_SHOWN; k++) log("・" + result.report.notes[k]);
      if (result.report.notes.length > MAX_NOTES_SHOWN) log("…ほか " + (result.report.notes.length - MAX_NOTES_SHOWN) + " 件");
    });
    refreshPreview();
  }

  /* 「最適化」ボタンの処理 */
  function onOptimizeClicked() {
    runUndoable("最適化", function (comp) {
      var result = runOptimize(comp, readOptions(), getHostComp(comp));
      log("最適化: 式を " + result.removed + " 件外しました / 残した式 " + result.kept + " 件" + (result.missing ? " / 対応エフェクトなし " + result.missing : ""));
      log("※ 外したパーツは、スライダーを動かしても反映されません。動かす前に「式を再適用」を押してください。");
    });
  }

  /* 「式を再適用」ボタンの処理 */
  function onReapplyClicked() {
    runUndoable("式を再適用", function (comp) {
      var result = runReapply(comp, readOptions(), getHostComp(comp));
      log("再適用: 式を " + result.report.set + " 件設定" + (result.report.errors ? " / エラー " + result.report.errors : ""));
    });
  }

  /* 「解除」ボタンの処理 */
  function onClearClicked() {
    runUndoable("解除", function (comp) {
      var result = runClear(comp, readOptions(), removeLayerCheck.value, getHostComp(comp));
      log("解除: 式 " + result.removed + " 件を削除 / エフェクト " + result.effects + " 個を削除" + (result.layerRemoved ? " / 制御レイヤーを削除" : ""));
    });
    refreshPreview();
  }

  refreshButton.onClick = function () {
    fillHostList();
    refreshPreview();
  };
  hostDropdown.onChange = refreshPreview;
  staggerDropdown.onChange = refreshPreview;
  timeSyncDropdown.onChange = refreshPreview;
  positionInputDropdown.onChange = refreshPreview;
  scaleInputDropdown.onChange = refreshPreview;
  maxParamsField.onChange = refreshPreview;
  controlNameField.onChange = refreshPreview;
  selfCompCheck.onClick = refreshPreview;
  for (key in layerTypeChecks) layerTypeChecks[key].onClick = refreshPreview;
  for (key in propChecks) propChecks[key].onClick = refreshPreview;

  buildButton.onClick = onBuildClicked;
  optimizeButton.onClick = onOptimizeClicked;
  reapplyButton.onClick = onReapplyClicked;
  clearButton.onClick = onClearClicked;

  win.onResizing = win.onResize = function () {
    this.layout.resize();
  };

  loadSettings();
  try {
    fillHostList();
  } catch (e) {
    /* プロジェクトを読めないタイミング(起動直後など)でも、パネル自体は開けるようにする */
  }
  refreshPreview();
  if (win instanceof Window) {
    win.center();
    win.show();
  } else {
    win.layout.layout(true);
  }
  return win;
}

/* After Effects 上で実行されたときだけパネルを開く（自動テストなど、AE以外の環境で読み込んでも動かないようにする） */
if (typeof app !== "undefined" && typeof Window !== "undefined" && typeof thisObj !== "undefined") {
  buildPanel(thisObj);
}

})(this);
