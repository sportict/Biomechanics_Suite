'use strict';

/**
 * Biomechanics Suite 共通 Electron ユーティリティ
 *
 * 使用例:
 *   const { buildMacAppMenu, buildQuitMenuItem, getIconPath,
 *           isDev, getFilePathFromArgs, suppressChromiumLogs } = require('../shared/electron-utils');
 *
 * MotionViewer のように main.js が深い階層にある場合:
 *   require('../../shared/electron-utils')
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────
// メニュー関連
// ─────────────────────────────────────────────

/**
 * macOS 標準アプリメニュー（メニューバー先頭）を生成する。
 * Windows では空配列を返すのでそのままスプレッドできる。
 *
 * @returns {object[]}
 *
 * @example
 *   const template = [...buildMacAppMenu(), { label: 'ファイル', submenu: [...] }];
 */
function buildMacAppMenu() {
  if (process.platform !== 'darwin') return [];
  return [{
    label: app.name,
    submenu: [
      { role: 'about',      label: `${app.name} について` },
      { type: 'separator' },
      { role: 'services',   label: 'サービス' },
      { type: 'separator' },
      { role: 'hide',       label: `${app.name} を隠す` },
      { role: 'hideOthers', label: 'ほかを隠す' },
      { role: 'unhide',     label: 'すべてを表示' },
      { type: 'separator' },
      { role: 'quit',       label: `${app.name} を終了` }
    ]
  }];
}

/**
 * 「ファイル」メニュー末尾の「終了」項目を生成する。
 * macOS では空配列を返す（アプリメニューの role:'quit' が担うため）。
 *
 * @param {Function} [clickHandler] - クリック時の処理。省略時は app.quit()
 * @returns {object[]}
 *
 * @example
 *   submenu: [
 *     ...,
 *     { type: 'separator' },
 *     ...buildQuitMenuItem(() => mainWindow.close())
 *   ]
 */
function buildQuitMenuItem(clickHandler) {
  if (process.platform === 'darwin') return [];
  return [{
    label: '終了',
    accelerator: 'CmdOrCtrl+Q',
    click: clickHandler || (() => app.quit())
  }];
}

// ─────────────────────────────────────────────
// ウィンドウ関連
// ─────────────────────────────────────────────

/**
 * アイコンファイルのフルパスを返す。
 * パッケージ版では process.resourcesPath を使い、開発時は baseDir を使う。
 *
 * @param {string} baseDir  - 開発時の基準ディレクトリ（通常 __dirname）
 * @param {string} pngName  - macOS 用 PNG ファイル名（例: 'HPE.png'）
 * @param {string} icoName  - Windows 用 ICO ファイル名（例: 'HPE.ico'）
 * @returns {string}
 *
 * @example
 *   icon: getIconPath(__dirname, 'HPE.png', 'HPE.ico')
 *   // MotionViewer など深い階層の場合:
 *   icon: getIconPath(path.join(__dirname, '..', '..'), 'MViewer.png', 'MViewer.ico')
 */
function getIconPath(baseDir, pngName, icoName) {
  const iconFile = process.platform === 'darwin' ? pngName : icoName;
  return app.isPackaged
    ? path.join(process.resourcesPath, iconFile)
    : path.join(baseDir, iconFile);
}

// ─────────────────────────────────────────────
// 環境判定
// ─────────────────────────────────────────────

/**
 * 開発モード（非パッケージ版）かどうかを返す。
 * @returns {boolean}
 */
function isDev() {
  return process.env.NODE_ENV === 'development' || !app.isPackaged;
}

// ─────────────────────────────────────────────
// ファイルパス解決
// ─────────────────────────────────────────────

/**
 * コマンドライン引数から特定拡張子のファイルパスを取得する。
 * "--" で始まる引数はフラグとして無視する。
 *
 * @param {string[]} argv      - process.argv または commandLine 引数配列
 * @param {string}   extension - 対象拡張子（例: '.hpe'）
 * @returns {string|null}
 *
 * @example
 *   const filePath = getFilePathFromArgs(process.argv, '.hpe');
 */
function getFilePathFromArgs(argv, extension) {
  const ext = extension.toLowerCase();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--') && arg.toLowerCase().endsWith(ext)) {
      if (fs.existsSync(arg)) return arg;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Chromium ログ抑制
// ─────────────────────────────────────────────

/**
 * Chromium 内部の不要ログ（Unsupported pixel format 等）を抑制する。
 * app.ready より前に呼ぶこと。
 */
function suppressChromiumLogs() {
  app.commandLine.appendSwitch('log-level', '3');          // ERROR 以上のみ
  app.commandLine.appendSwitch('disable-features', 'Autofill');
}

// ─────────────────────────────────────────────

module.exports = {
  buildMacAppMenu,
  buildQuitMenuItem,
  getIconPath,
  isDev,
  getFilePathFromArgs,
  suppressChromiumLogs
};
