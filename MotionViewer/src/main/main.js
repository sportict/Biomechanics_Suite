const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');

// === アイコンパス解決 ===
function getIconPath() {
  const iconFile = process.platform === 'darwin' ? 'MViewer.png' : 'MViewer.ico';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, iconFile);
  } else {
    return path.join(__dirname, '..', '..', iconFile);
  }
}

// 追加: 直前に開いたモーションデータのディレクトリを記憶
let lastMotionDir = null;
// 追加: 現在のプロジェクトファイルパス
let currentProjectFilePath = null;

/**
 * MotionViewer Electron メインプロセス（最小構成）
 * 軽快な動作を重視したシンプル実装
 */
class MotionViewerApp {
  constructor() {
    this.mainWindow = null;
    this.sequenceDrawWindow = null;
    this.isDev = process.argv.includes('--dev');
    this.pendingProjectFile = null;  // 起動時に開くプロジェクトファイル
    this.init();
  }

  init() {
    // シングルインスタンスを強制（二重起動防止）
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
      return;
    }

    // 二重起動時：既存のウィンドウにファイルを渡す
    app.on('second-instance', (event, commandLine) => {
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
        // コマンドライン引数からmvpファイルを探す
        const mvpFile = this.findMvpFileInArgs(commandLine);
        if (mvpFile) {
          this.openProjectFile(mvpFile);
        }
      }
    });

    app.whenReady().then(() => {
      // 起動引数解析
      const args = process.argv;
      const dataPathArg = args.find(arg => arg.startsWith('--data-path='));
      if (dataPathArg) {
        this.projectDataPath = dataPathArg.split('=')[1];
      }

      // コマンドライン引数からmvpファイルを探す（open-fileで先にセットされていなければ）
      if (!this.pendingProjectFile) {
        this.pendingProjectFile = this.findMvpFileInArgs(args);
      }

      this.createWindow();
      this.createMenu();
      this.setupIPC();
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) this.createWindow();
    });

    // macOS: ファイルをアプリにドロップして開く
    app.on('open-file', (event, filePath) => {
      event.preventDefault();
      if (filePath.endsWith('.mvp')) {
        if (this.mainWindow) {
          this.openProjectFile(filePath);
        } else {
          this.pendingProjectFile = filePath;
        }
      }
    });
  }

  /**
   * コマンドライン引数からmvpファイルを探す
   */
  findMvpFileInArgs(args) {
    console.log('[Main] findMvpFileInArgs called with:', args);
    for (const arg of args) {
      // 大文字小文字を区別せず.mvp拡張子をチェック
      if (arg.toLowerCase().endsWith('.mvp') && !arg.startsWith('-')) {
        console.log('[Main] Found .mvp argument:', arg);
        // ファイル存在確認
        if (fsSync.existsSync(arg)) {
          console.log('[Main] File exists, returning:', arg);
          return arg;
        } else {
          console.log('[Main] File does not exist:', arg);
        }
      }
    }
    console.log('[Main] No valid .mvp file found');
    return null;
  }



  /**
   * メインウィンドウ作成
   */
  createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      icon: getIconPath(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // ドラッグ&ドロップでfile.pathを取得するために必要
        preload: path.join(__dirname, 'preload.js')
      },
      show: false,
      titleBarStyle: 'default'
    });

    // HTML読み込み
    const htmlPath = path.join(__dirname, '../renderer/index.html');
    this.mainWindow.loadFile(htmlPath);

    // 表示準備完了
    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
      if (this.isDev) this.mainWindow.webContents.openDevTools();

      // 起動時に開くプロジェクトファイルがあれば開く
      if (this.pendingProjectFile) {
        // レンダラーの初期化を待つ
        setTimeout(() => {
          this.openProjectFile(this.pendingProjectFile);
          this.pendingProjectFile = null;
        }, 500);
      }
    });
  }

  /**
   * 図形描写ウィンドウ作成
   */
  createSequenceDrawWindow() {
    console.log('[DEBUG] createSequenceDrawWindow called');

    if (this.sequenceDrawWindow && !this.sequenceDrawWindow.isDestroyed()) {
      console.log('[DEBUG] window already exists, focusing');
      this.sequenceDrawWindow.focus();
      return this.sequenceDrawWindow;
    }

    console.log('[DEBUG] creating new window');
    this.sequenceDrawWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      icon: getIconPath(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      },
      show: false,
      title: '図形描写（連続写真）',
      backgroundColor: '#f0f0f0'
    });

    const htmlPath = path.join(__dirname, '../renderer/sequence-draw-window.html');
    console.log('[DEBUG] loading html from:', htmlPath);
    this.sequenceDrawWindow.loadFile(htmlPath);

    this.sequenceDrawWindow.once('ready-to-show', () => {
      console.log('[DEBUG] window ready to show');
      this.sequenceDrawWindow.show();
      if (this.isDev) this.sequenceDrawWindow.webContents.openDevTools();
    });

    this.sequenceDrawWindow.on('closed', () => {
      console.log('[DEBUG] window closed');
      this.sequenceDrawWindow = null;
    });

    return this.sequenceDrawWindow;
  }

  /**
   * アプリケーションメニュー作成
   */
  createMenu() {
    const template = this._buildMenuTemplate();
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  /**
   * メニューテンプレートを構築する（共通化）
   * @param {number | null} stickType - チェック状態にするスティックピクチャーのタイプ (23 or 25)
   * @returns {object[]} Electronメニューテンプレート
   */
  _buildMenuTemplate(stickType = null) {
    const template = [
      {
        label: 'ファイル',
        submenu: [
          {
            label: '新規プロジェクト',
            accelerator: 'CmdOrCtrl+N',
            click: () => {
              currentProjectFilePath = null;
              if (this.mainWindow) {
                this.mainWindow.webContents.send('new-project');
              }
            }
          },
          {
            label: 'プロジェクトを開く...',
            accelerator: 'CmdOrCtrl+Shift+O',
            click: () => this.openProjectFile()
          },
          {
            label: 'プロジェクトを上書き保存',
            accelerator: 'CmdOrCtrl+S',
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send('save-project', { saveAs: false });
              }
            }
          },
          {
            label: 'プロジェクトを別名で保存...',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send('save-project', { saveAs: true });
              }
            }
          },
          { type: 'separator' },
          {
            label: 'ファイルを開く...',
            accelerator: 'CmdOrCtrl+O',
            click: () => this.openFileDialog()
          },
          {
            label: 'ファイルを閉じる',
            accelerator: 'CmdOrCtrl+R',
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.reload();
              }
            }
          },
          { type: 'separator' },
          {
            label: '設定ファイルを保存...',
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.send('trigger-save-settings');
              }
            }
          },
          {
            label: '設定ファイルを読み込み...',
            click: () => this.loadSettingsFile()
          },
          { type: 'separator' },
          {
            label: '終了',
            accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
            click: () => app.quit()
          }
        ]
      },
      {
        label: '設定',
        submenu: [
          {
            label: 'セグメント定義…',
            click: () => {
              this.mainWindow.webContents.send('show-segment-definition-dialog');
            }
          },
          { type: 'separator' },
          {
            label: 'フォースプレート設定…',
            click: () => {
              this.mainWindow.webContents.send('show-force-plate-dialog');
            }
          },
          { type: 'separator' },
          {
            label: '逆動力学計算…',
            click: () => {
              this.mainWindow.webContents.send('show-inverse-dynamics-dialog');
            }
          }
        ]
      },
      {
        label: 'スティックピクチャー',
        submenu: [
          {
            label: '身体23ポイント',
            type: 'checkbox',
            checked: stickType === 23,
            click: (menuItem, browserWindow) => {
              if (menuItem.checked) {
                this.setStickPictureMenu(23);
                browserWindow.webContents.send('show-stick-picture-23');
              } else {
                this.setStickPictureMenu(null);
                browserWindow.webContents.send('hide-stick-picture');
              }
            }
          },
          {
            label: '身体25ポイント',
            type: 'checkbox',
            checked: stickType === 25,
            click: (menuItem, browserWindow) => {
              if (menuItem.checked) {
                this.setStickPictureMenu(25);
                browserWindow.webContents.send('show-stick-picture-25');
              } else {
                this.setStickPictureMenu(null);
                browserWindow.webContents.send('hide-stick-picture');
              }
            }
          },
          {
            label: '慣性楕円体を表示',
            id: 'menu-inertia-visualization',
            type: 'checkbox',
            click: (menuItem) => {
              this.mainWindow.webContents.send('toggle-inertia-visualization', menuItem.checked);
            }
          }
        ]
      },
      {
        label: 'ヘルプ',
        submenu: [
          {
            label: '開発者ツール',
            accelerator: 'F12',
            click: () => {
              if (this.mainWindow) {
                this.mainWindow.webContents.toggleDevTools();
              }
            }
          }
        ]
      }
    ];

    // macOS用アプリケーションメニュー
    if (process.platform === 'darwin') {
      template.unshift({
        label: 'MotionViewer',
        submenu: [
          {
            label: 'MotionViewerについて',
            click: () => this.showAbout()
          },
          { type: 'separator' },
          { label: 'MotionViewerを隠す', accelerator: 'Command+H', role: 'hide' },
          { label: '他を隠す', accelerator: 'Command+Shift+H', role: 'hideothers' },
          { label: 'すべてを表示', role: 'unhide' },
          { type: 'separator' },
          { label: 'MotionViewerを終了', accelerator: 'Command+Q', click: () => app.quit() }
        ]
      });
    }

    return template;
  }

  /**
   * 設定ファイル読み込み
   */
  async loadSettingsFile() {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        title: '設定ファイルを開く',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
        properties: ['openFile'],
        defaultPath: lastMotionDir || undefined // 追加: 直前のディレクトリを指定
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        const content = await fs.readFile(filePath, 'utf8');
        this.mainWindow.webContents.send('load-settings-data', content);
      }
    } catch (error) {
      console.error('設定ファイルの読み込みエラー:', error);
      this.showError(`設定ファイルの読み込みに失敗しました:\n${error.message}`);
    }
  }

  /**
   * ファイルダイアログ表示
   */
  async openFileDialog() {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        title: 'モーションファイルを開く',
        filters: [
          { name: 'モーションファイル', extensions: ['sd', 'rd', '2d', '3d', 'c3d'] },
          { name: 'C3Dファイル', extensions: ['c3d'] },
          { name: 'すべてのファイル', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (!result.canceled && result.filePaths.length > 0) {
        // 追加: ディレクトリを記憶
        lastMotionDir = path.dirname(result.filePaths[0]);
        await this.loadFile(result.filePaths[0]);
      }
    } catch (error) {
      console.error('ファイルダイアログエラー:', error);
      this.showError('ファイルの選択中にエラーが発生しました。');
    }
  }

  /**
   * ファイル読み込み・送信
   */
  async loadFile(filePath) {
    try {
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      if (ext === '.c3d') {
        // C3Dファイルはバイナリとして読み込み
        const buffer = await fs.readFile(filePath);
        const c3dResult = this.parseC3D(buffer);

        // レンダラープロセスに送信
        this.mainWindow.webContents.send('file-loaded', {
          fileName,
          content: c3dResult.csvData,
          filePath,
          isC3D: true,
          c3dMetadata: c3dResult.metadata
        });
      } else {
        // テキストファイル
        const content = await fs.readFile(filePath, 'utf8');
        this.mainWindow.webContents.send('file-loaded', {
          fileName,
          content,
          filePath
        });
      }
    } catch (error) {
      if (this.isDev) console.error('ファイル読み込みエラー:', error);
      this.showError(`ファイルの読み込みに失敗しました:\n${error.message}`);
    }
  }

  /**
   * C3Dファイルをパースする
   * C3D.org仕様に準拠: https://www.c3d.org/HTML/Documents/theheadersection.htm
   * @param {Buffer} buffer - C3Dファイルのバッファ
   * @returns {object} パースされたモーションデータとメタデータ
   */
  parseC3D(buffer) {
    try {
      // C3Dヘッダーの読み取り（最初の512バイト）
      const parameterBlock = buffer.readUInt8(0);  // パラメータセクションへのポインタ
      const signature = buffer.readUInt8(1);       // シグネチャ（0x50 = 'P'）

      if (signature !== 0x50) {
        throw new Error('無効なC3Dファイル形式です（シグネチャ: 0x' + signature.toString(16) + '）');
      }

      // パラメータセクションの位置（512バイトブロック単位）
      const paramStart = (parameterBlock - 1) * 512;

      // ヘッダーから基本情報を読み取り（16ビットワード単位）
      // Word 2: 3Dポイント数
      const numPoints = buffer.readInt16LE(2);
      // Word 3: 1フレームあたりのアナログサンプル総数
      const analogSamplesPerFrame = buffer.readInt16LE(4);
      // Word 4-5: フレーム範囲
      const firstFrame = buffer.readInt16LE(6);
      const lastFrame = buffer.readInt16LE(8);
      // Word 6: 最大補間ギャップ
      const maxGap = buffer.readInt16LE(10);
      // Word 7-8: スケールファクター（32ビット浮動小数点）
      // 負の値 = 浮動小数点形式、正の値 = 整数形式
      const scaleFactor = buffer.readFloatLE(12);
      // Word 9: データセクション開始ブロック
      const dataStart = buffer.readInt16LE(16);
      // Word 10: アナログサンプリングレート倍率（通常使用しない）
      const analogRateMultiplier = buffer.readInt16LE(18);
      // Word 11-12: 3Dフレームレート（Hz）
      const frameRate = buffer.readFloatLE(20);

      // 総フレーム数
      const totalFrames = lastFrame - firstFrame + 1;

      // データセクション開始位置（バイト）
      const dataOffset = (dataStart - 1) * 512;

      // スケールファクターの符号でデータ形式を判定
      const isFloat = scaleFactor < 0;
      const scale = Math.abs(scaleFactor);

      // ポイント名を取得（パラメータセクションから）
      const pointLabels = this.parseC3DPointLabels(buffer, paramStart, numPoints);

      // POINT:UNITSを取得して単位変換係数を決定
      const pointUnits = this.parseC3DPointUnits(buffer, paramStart);
      const unitLower = pointUnits.toLowerCase().trim();
      let unitScale = 0.001; // デフォルト: mm -> m（ほとんどのC3DファイルはVicon等でmm単位）
      if (unitLower === 'mm' || unitLower === 'millimeter' || unitLower === 'millimeters') {
        unitScale = 0.001; // mm -> m
      } else if (unitLower === 'cm' || unitLower === 'centimeter' || unitLower === 'centimeters') {
        unitScale = 0.01; // cm -> m
      } else if (unitLower === 'm' || unitLower === 'meter' || unitLower === 'meters') {
        unitScale = 1.0; // m -> m（変換不要）
      }
      // 不明な単位の場合もデフォルトでmm扱い（Vicon等の標準形式）
      console.log('[C3D] POINT:UNITS:', pointUnits, '-> unitScale:', unitScale);

      // 1フレームあたりのデータサイズを計算
      // 3Dポイント: x, y, z, residual（各4バイト=16バイト for float, 各2バイト=8バイト for int16）
      const pointDataSize = isFloat ? 16 : 8;
      // アナログデータ: analogSamplesPerFrame個のサンプル（float=4バイト, int16=2バイト）
      const analogDataSize = analogSamplesPerFrame * (isFloat ? 4 : 2);
      const frameSize = numPoints * pointDataSize + analogDataSize;

      if (this.isDev) {
        console.log('[C3D] Points:', numPoints, 'Frames:', totalFrames, 'Rate:', frameRate, 'Hz');
        console.log('[C3D] Float format:', isFloat, 'Frame size:', frameSize, 'bytes');
        console.log('[C3D] Analog samples/frame:', analogSamplesPerFrame);
      }

      // フレームデータを読み取り
      const frames = [];
      let offset = dataOffset;

      for (let f = 0; f < totalFrames; f++) {
        const framePoints = [];
        const frameStartOffset = offset;

        for (let p = 0; p < numPoints; p++) {
          let x, y, z;

          let residual;
          if (isFloat) {
            x = buffer.readFloatLE(offset);
            y = buffer.readFloatLE(offset + 4);
            z = buffer.readFloatLE(offset + 8);
            residual = buffer.readFloatLE(offset + 12);
            offset += 16;
          } else {
            x = buffer.readInt16LE(offset) * scale;
            y = buffer.readInt16LE(offset + 2) * scale;
            z = buffer.readInt16LE(offset + 4) * scale;
            residual = buffer.readInt16LE(offset + 6);
            offset += 8;
          }

          // 欠損値の検出: residual < 0 または座標が全て0
          const isMissing = residual < 0 || (x === 0 && y === 0 && z === 0);

          if (isMissing) {
            // 欠損値はnullとして保存
            framePoints.push(null);
          } else {
            // 単位をメートルに変換（POINT:UNITSに基づく）
            framePoints.push({
              x: x * unitScale,
              y: y * unitScale,
              z: z * unitScale
            });
          }
        }

        // アナログデータをスキップ（フレーム境界を正確に維持）
        offset = frameStartOffset + frameSize;

        frames.push(framePoints);
      }

      // CSV形式に変換（既存のパーサーと互換性のある形式）
      const frameInterval = frameRate > 0 ? 1.0 / frameRate : 0.01;

      // ヘッダー行: フレーム数, ポイント数, フレーム間隔
      let result = `${totalFrames},${numPoints},${frameInterval.toFixed(6)}\n`;

      // フレームデータ: x1,y1,z1,x2,y2,z2,...（欠損値はNaN）
      for (let f = 0; f < frames.length; f++) {
        const values = [];
        for (const p of frames[f]) {
          if (p === null) {
            values.push('NaN', 'NaN', 'NaN');
          } else {
            values.push(p.x.toFixed(6), p.y.toFixed(6), p.z.toFixed(6));
          }
        }
        result += values.join(',') + '\n';
      }

      // フォースプレート情報を取得
      const forcePlates = this.parseC3DForcePlatforms(buffer, paramStart, analogSamplesPerFrame, dataOffset, totalFrames, frameSize, numPoints, isFloat, frameRate);

      // メタデータ
      const metadata = {
        pointLabels: pointLabels,
        frameRate: frameRate,
        source: 'C3D',
        firstFrame: firstFrame,
        lastFrame: lastFrame,
        forcePlates: forcePlates
      };

      return { csvData: result, metadata: metadata };
    } catch (error) {
      console.error('C3Dパースエラー:', error);
      throw new Error(`C3Dファイルのパースに失敗しました: ${error.message}`);
    }
  }

  /**
   * C3Dパラメータセクションからポイントラベルを取得
   * C3D.org仕様: https://www.c3d.org/HTML/Documents/pointlabels.htm
   */
  parseC3DPointLabels(buffer, paramStart, numPoints) {
    const labels = [];

    try {
      // パラメータセクションヘッダー（4バイト）
      const numParamBlocks = buffer.readUInt8(paramStart + 2);
      const maxOffset = paramStart + numParamBlocks * 512;

      // グループIDとグループ名のマッピング
      const groups = new Map();

      // パラメータセクションをスキャンしてPOINT:LABELSを探す
      let offset = paramStart + 4;
      let iterations = 0;
      const maxIterations = 1000;

      while (offset < maxOffset && iterations < maxIterations) {
        iterations++;

        const nameLen = buffer.readInt8(offset);
        if (nameLen === 0) break;

        const actualNameLen = Math.abs(nameLen);
        if (actualNameLen === 0 || actualNameLen > 127 || offset + 2 + actualNameLen > buffer.length) break;

        const id = buffer.readInt8(offset + 1);
        const isGroup = id < 0;
        const name = buffer.toString('ascii', offset + 2, offset + 2 + actualNameLen).trim().toUpperCase();

        // 次のオフセットワードの位置
        const nextOffsetWordPos = offset + 2 + actualNameLen;

        if (isGroup) {
          // グループ定義: nameLen(1) + id(1) + name(n) + nextOffset(2) + descLen(1) + desc(m)
          groups.set(Math.abs(id), name);

          const descLen = buffer.readUInt8(nextOffsetWordPos + 2);
          offset = nextOffsetWordPos + 2 + 1 + descLen;
        } else {
          // パラメータ定義: nameLen(1) + id(1) + name(n) + nextOffset(2) + type(1) + numDims(1) + dims(d) + data + descLen(1) + desc(m)
          const groupName = groups.get(Math.abs(id)) || '';

          const dataTypeOffset = nextOffsetWordPos + 2;
          const dataType = buffer.readInt8(dataTypeOffset);
          const numDims = buffer.readUInt8(dataTypeOffset + 1);

          const dims = [];
          for (let d = 0; d < numDims; d++) {
            dims.push(buffer.readUInt8(dataTypeOffset + 2 + d));
          }

          // データサイズを計算（スカラーの場合は1要素）
          let totalElements = 1;
          for (const d of dims) totalElements *= d;
          // 次元が0を含む場合はデータなし
          if (numDims > 0 && dims.includes(0)) totalElements = 0;

          const typeSize = Math.abs(dataType) || 1;
          const dataSize = totalElements * typeSize;

          // 説明の位置
          const descLenOffset = dataTypeOffset + 2 + numDims + dataSize;
          const descLen = buffer.readUInt8(descLenOffset);

          // POINT:LABELSを検出
          if (name === 'LABELS' && groupName === 'POINT') {
            // 文字配列（dataType = -1）で2次元（ラベル長 x ラベル数）
            if (dataType === -1 && dims.length >= 2) {
              const labelLen = dims[0];
              const labelCount = dims[1];
              const labelDataOffset = dataTypeOffset + 2 + numDims;

              if (this.isDev) {
                console.log('[C3D] Found POINT:LABELS:', labelCount, 'labels x', labelLen, 'chars');
              }

              for (let i = 0; i < Math.min(labelCount, numPoints); i++) {
                const start = labelDataOffset + i * labelLen;
                const end = start + labelLen;
                if (end <= buffer.length) {
                  let label = buffer.toString('ascii', start, end).trim();
                  // *で始まるラベル（無効マーカー）は汎用名に置換
                  if (label.startsWith('*') || label === '') {
                    label = `Point${i + 1}`;
                  }
                  labels.push(label);
                }
              }
            }
            break;  // ラベルを見つけたので終了
          }

          // 次のパラメータへ移動（手動計算）
          offset = descLenOffset + 1 + descLen;
        }
      }
    } catch (e) {
      console.warn('C3Dポイントラベル取得エラー:', e);
    }

    // ラベルが見つからない場合はデフォルト名を生成
    while (labels.length < numPoints) {
      labels.push(`Point${labels.length + 1}`);
    }

    return labels;
  }

  /**
   * C3DパラメータセクションからPOINT:UNITS（座標単位）を取得
   * @returns {string} 'mm', 'm', 'cm' などの単位文字列（不明な場合は'mm'をデフォルト）
   */
  parseC3DPointUnits(buffer, paramStart) {
    try {
      const numParamBlocks = buffer.readUInt8(paramStart + 2);
      const maxOffset = paramStart + numParamBlocks * 512;

      const groups = new Map();
      let offset = paramStart + 4;
      let iterations = 0;
      const maxIterations = 1000;

      while (offset < maxOffset && iterations < maxIterations) {
        iterations++;

        const nameLen = buffer.readInt8(offset);
        if (nameLen === 0) break;

        const actualNameLen = Math.abs(nameLen);
        if (actualNameLen === 0 || actualNameLen > 127 || offset + 2 + actualNameLen > buffer.length) break;

        const id = buffer.readInt8(offset + 1);
        const isGroup = id < 0;
        const name = buffer.toString('ascii', offset + 2, offset + 2 + actualNameLen).trim().toUpperCase();

        const nextOffsetWordPos = offset + 2 + actualNameLen;

        if (isGroup) {
          groups.set(Math.abs(id), name);
          const descLen = buffer.readUInt8(nextOffsetWordPos + 2);
          offset = nextOffsetWordPos + 2 + 1 + descLen;
        } else {
          const groupName = groups.get(Math.abs(id)) || '';

          const dataTypeOffset = nextOffsetWordPos + 2;
          const dataType = buffer.readInt8(dataTypeOffset);
          const numDims = buffer.readUInt8(dataTypeOffset + 1);

          const dims = [];
          for (let d = 0; d < numDims; d++) {
            dims.push(buffer.readUInt8(dataTypeOffset + 2 + d));
          }

          let totalElements = 1;
          for (const d of dims) totalElements *= d;
          if (numDims > 0 && dims.includes(0)) totalElements = 0;

          const typeSize = Math.abs(dataType) || 1;
          const dataSize = totalElements * typeSize;
          const descLenOffset = dataTypeOffset + 2 + numDims + dataSize;
          const descLen = buffer.readUInt8(descLenOffset);

          // POINT:UNITSを検出
          if (name === 'UNITS' && groupName === 'POINT') {
            // 文字列パラメータ（dataType = -1）
            if (dataType === -1) {
              const strLen = dims.length > 0 ? dims[0] : totalElements;
              const strDataOffset = dataTypeOffset + 2 + numDims;
              const units = buffer.toString('ascii', strDataOffset, strDataOffset + strLen).trim().toLowerCase();
              if (this.isDev) {
                console.log('[C3D] Found POINT:UNITS:', units);
              }
              return units;
            }
          }

          offset = descLenOffset + 1 + descLen;
        }
      }
    } catch (e) {
      console.warn('C3D POINT:UNITS取得エラー:', e);
    }

    // デフォルトはmm（多くのC3Dファイルがmm単位）
    return 'mm';
  }

  /**
   * C3DパラメータセクションからFORCE_PLATFORM情報を取得
   * C3D.org仕様: https://www.c3d.org/HTML/Documents/forceplategroup.htm
   */
  parseC3DForcePlatforms(buffer, paramStart, analogSamplesPerFrame, dataOffset, totalFrames, frameSize, numPoints, isFloat, frameRate) {
    const forcePlates = [];

    try {
      const numParamBlocks = buffer.readUInt8(paramStart + 2);
      const maxOffset = paramStart + numParamBlocks * 512;

      const groups = new Map();
      const fpParams = {};  // FORCE_PLATFORMパラメータを格納

      let offset = paramStart + 4;
      let iterations = 0;
      const maxIterations = 1000;

      while (offset < maxOffset && iterations < maxIterations) {
        iterations++;

        const nameLen = buffer.readInt8(offset);
        if (nameLen === 0) break;

        const actualNameLen = Math.abs(nameLen);
        if (actualNameLen === 0 || actualNameLen > 127 || offset + 2 + actualNameLen > buffer.length) break;

        const id = buffer.readInt8(offset + 1);
        const isGroup = id < 0;
        const name = buffer.toString('ascii', offset + 2, offset + 2 + actualNameLen).trim().toUpperCase();
        const nextOffsetWordPos = offset + 2 + actualNameLen;

        if (isGroup) {
          groups.set(Math.abs(id), name);
          const descLen = buffer.readUInt8(nextOffsetWordPos + 2);
          offset = nextOffsetWordPos + 2 + 1 + descLen;
        } else {
          const groupName = groups.get(Math.abs(id)) || '';

          const dataTypeOffset = nextOffsetWordPos + 2;
          const dataType = buffer.readInt8(dataTypeOffset);
          const numDims = buffer.readUInt8(dataTypeOffset + 1);

          const dims = [];
          for (let d = 0; d < numDims; d++) {
            dims.push(buffer.readUInt8(dataTypeOffset + 2 + d));
          }

          let totalElements = 1;
          for (const d of dims) totalElements *= d;
          if (numDims > 0 && dims.includes(0)) totalElements = 0;

          const typeSize = Math.abs(dataType) || 1;
          const dataSize = totalElements * typeSize;
          const dataStartOffset = dataTypeOffset + 2 + numDims;
          const descLenOffset = dataStartOffset + dataSize;
          const descLen = buffer.readUInt8(descLenOffset);

          // ANALOGグループのパラメータを収集
          if (groupName === 'ANALOG') {
            if (name === 'USED') {
              // アナログチャンネル総数（スカラー整数）
              fpParams.analogUsed = buffer.readInt16LE(dataStartOffset);
            } else if (name === 'RATE') {
              // アナログサンプリングレート（Hz）
              fpParams.analogRate = buffer.readFloatLE(dataStartOffset);
            } else if (name === 'SCALE') {
              // チャンネルごとのスケール係数（浮動小数点配列）
              fpParams.analogScale = [];
              for (let i = 0; i < totalElements; i++) {
                fpParams.analogScale.push(buffer.readFloatLE(dataStartOffset + i * 4));
              }
            } else if (name === 'OFFSET') {
              // チャンネルごとのオフセット（整数配列）
              fpParams.analogOffset = [];
              for (let i = 0; i < totalElements; i++) {
                fpParams.analogOffset.push(buffer.readInt16LE(dataStartOffset + i * 2));
              }
            } else if (name === 'GEN_SCALE') {
              // 全体スケール係数（スカラー浮動小数点）
              fpParams.analogGenScale = buffer.readFloatLE(dataStartOffset);
            } else if (name === 'FORMAT') {
              // アナログデータ形式: 'SIGNED' または 'UNSIGNED'
              const strLen = dims.length > 0 ? dims[0] : totalElements;
              fpParams.analogFormat = buffer.toString('ascii', dataStartOffset, dataStartOffset + strLen).trim().toUpperCase();
            } else if (name === 'BITS') {
              // アナログデータのビット深度（通常12または16）
              fpParams.analogBits = buffer.readInt16LE(dataStartOffset);
            }
          }

          // FORCE_PLATFORMグループのパラメータを収集
          if (groupName === 'FORCE_PLATFORM') {
            if (name === 'USED') {
              // プレート数（スカラー整数）
              fpParams.used = buffer.readInt16LE(dataStartOffset);
            } else if (name === 'TYPE') {
              // プレートタイプ（整数配列）
              fpParams.types = [];
              for (let i = 0; i < totalElements; i++) {
                fpParams.types.push(buffer.readInt16LE(dataStartOffset + i * 2));
              }
            } else if (name === 'CORNERS') {
              // プレートコーナー座標（3次元配列: 3 x 4 x プレート数）
              // dims[0]=3 (xyz), dims[1]=4 (corners), dims[2]=plateCount
              fpParams.corners = [];
              if (dims.length >= 3) {
                const plateCount = dims[2];
                for (let p = 0; p < plateCount; p++) {
                  const corners = [];
                  for (let c = 0; c < 4; c++) {
                    const corner = [];
                    for (let xyz = 0; xyz < 3; xyz++) {
                      const idx = xyz + c * 3 + p * 12;
                      corner.push(buffer.readFloatLE(dataStartOffset + idx * 4));
                    }
                    corners.push(corner);
                  }
                  fpParams.corners.push(corners);
                }
              }
            } else if (name === 'ORIGIN') {
              // プレート原点（3次元配列: 3 x プレート数）
              fpParams.origins = [];
              if (dims.length >= 2) {
                const plateCount = dims[1];
                for (let p = 0; p < plateCount; p++) {
                  const origin = [];
                  for (let xyz = 0; xyz < 3; xyz++) {
                    origin.push(buffer.readFloatLE(dataStartOffset + (xyz + p * 3) * 4));
                  }
                  fpParams.origins.push(origin);
                }
              }
            } else if (name === 'CHANNEL') {
              // アナログチャンネルマッピング（2次元配列: チャンネル数 x プレート数）
              fpParams.channels = [];
              if (dims.length >= 2) {
                const channelsPerPlate = dims[0];
                const plateCount = dims[1];
                for (let p = 0; p < plateCount; p++) {
                  const channels = [];
                  for (let ch = 0; ch < channelsPerPlate; ch++) {
                    channels.push(buffer.readInt16LE(dataStartOffset + (ch + p * channelsPerPlate) * 2));
                  }
                  fpParams.channels.push(channels);
                }
              }
            } else if (name === 'CAL_MATRIX') {
              // キャリブレーション行列（6x6 x プレート数）
              // Type 2, 4, 5 プレートで必要
              fpParams.calMatrix = [];
              if (dims.length >= 3) {
                const rows = dims[0]; // 通常6
                const cols = dims[1]; // 通常6
                const plateCount = dims[2];
                for (let p = 0; p < plateCount; p++) {
                  const matrix = [];
                  for (let r = 0; r < rows; r++) {
                    const row = [];
                    for (let c = 0; c < cols; c++) {
                      const idx = c + r * cols + p * rows * cols;
                      row.push(buffer.readFloatLE(dataStartOffset + idx * 4));
                    }
                    matrix.push(row);
                  }
                  fpParams.calMatrix.push(matrix);
                }
                console.log('[C3D] CAL_MATRIX found for', plateCount, 'plates');
              }
            } else if (name === 'SCALE') {
              // FORCE_PLATFORM:SCALE - 追加のスケール係数
              fpParams.fpScale = [];
              for (let i = 0; i < totalElements; i++) {
                fpParams.fpScale.push(buffer.readFloatLE(dataStartOffset + i * 4));
              }
              console.log('[C3D] FORCE_PLATFORM:SCALE:', fpParams.fpScale);
            }
          }

          offset = descLenOffset + 1 + descLen;
        }
      }

      // フォースプレートが見つかった場合、データ構造を構築
      if (fpParams.used && fpParams.used > 0) {
        // アナログデータのサンプリングレート倍率を計算
        const analogPerPointFrame = analogSamplesPerFrame > 0 && fpParams.channels && fpParams.channels[0]
          ? Math.floor(analogSamplesPerFrame / (fpParams.channels.reduce((sum, ch) => sum + ch.length, 0) || 1))
          : 1;

        if (this.isDev) {
          console.log('[C3D] Force plates:', fpParams.used);
          console.log('[C3D] Types:', fpParams.types);
          console.log('[C3D] Channels:', fpParams.channels);
          console.log('[C3D] Analog samples/frame:', analogSamplesPerFrame);
        }

        for (let p = 0; p < fpParams.used; p++) {
          const plate = {
            index: p,
            type: fpParams.types ? fpParams.types[p] : 1,
            corners: fpParams.corners ? fpParams.corners[p] : null,  // mm
            origin: fpParams.origins ? fpParams.origins[p] : [0, 0, 0],  // mm
            channels: fpParams.channels ? fpParams.channels[p] : [],
            forceData: []  // 各フレームの力データ
          };

          // アナログデータから力を読み取り（Type 2: Fx,Fy,Fz,Mx,My,Mz）
          if (plate.channels.length >= 3) {
            const pointDataSize = isFloat ? 16 : 8;
            const pointBlockSize = numPoints * pointDataSize;

            // アナログスケール係数を取得
            const genScale = fpParams.analogGenScale || 1.0;
            const scales = fpParams.analogScale || [];
            const offsets = fpParams.analogOffset || [];

            // 総アナログチャンネル数を取得
            // 優先順位: ANALOG:USED > FORCE_PLATFORM:CHANNELの最大値 > フォールバック
            let totalAnalogChannels = fpParams.analogUsed || 0;
            if (totalAnalogChannels === 0 && fpParams.channels) {
              // FORCE_PLATFORM:CHANNELから最大チャンネル番号を取得
              for (const plateChannels of fpParams.channels) {
                for (const ch of plateChannels) {
                  if (ch > totalAnalogChannels) totalAnalogChannels = ch;
                }
              }
            }
            // フォールバック: アナログサンプル数から推測（少なくとも6チャンネル）
            if (totalAnalogChannels === 0) {
              totalAnalogChannels = Math.max(6, analogSamplesPerFrame);
            }

            // 1ビデオフレームあたりのアナログサブフレーム数を計算
            // ANALOG:RATEが利用可能な場合はそれを使用
            let analogSubframes = 1;
            if (fpParams.analogRate && frameRate > 0) {
              analogSubframes = Math.round(fpParams.analogRate / frameRate);
            } else if (totalAnalogChannels > 0) {
              analogSubframes = Math.floor(analogSamplesPerFrame / totalAnalogChannels);
            }
            const analogByteSize = isFloat ? 4 : 2;

            if (this.isDev || p === 0) {
              console.log('[C3D] === Force Plate', p, 'Debug Info ===');
              console.log('[C3D] ANALOG:USED:', fpParams.analogUsed);
              console.log('[C3D] ANALOG:RATE:', fpParams.analogRate);
              console.log('[C3D] ANALOG:FORMAT:', fpParams.analogFormat || 'SIGNED (default)');
              console.log('[C3D] ANALOG:BITS:', fpParams.analogBits);
              console.log('[C3D] Video frame rate:', frameRate);
              console.log('[C3D] Plate channels:', plate.channels);
              console.log('[C3D] Total analog channels:', totalAnalogChannels);
              console.log('[C3D] Analog samples per video frame:', analogSamplesPerFrame);
              console.log('[C3D] Analog subframes per video frame:', analogSubframes);
              // このプレートで使用するチャンネルのスケールを表示
              const channelScales = plate.channels.map((ch, i) => {
                const idx = ch - 1;
                return `Ch${i}(analog${idx}): scale=${scales[idx] || 1.0}, offset=${offsets[idx] || 0}`;
              });
              console.log('[C3D] Channel scales for this plate:', channelScales);
              console.log('[C3D] Gen scale:', genScale);
              console.log('[C3D] isFloat:', isFloat, 'analogByteSize:', analogByteSize);
              console.log('[C3D] pointBlockSize:', pointBlockSize, 'frameSize:', frameSize);
              console.log('[C3D] dataOffset:', dataOffset, 'totalFrames:', totalFrames);
              console.log('[C3D] CAL_MATRIX exists:', !!fpParams.calMatrix?.[p]);
              console.log('[C3D] FP_SCALE exists:', !!fpParams.fpScale);
            }

            // フレーム100あたり（歩行中のデータがある可能性が高い）でもデバッグ
            const debugFrames = [0, Math.min(100, totalFrames - 1), Math.floor(totalFrames / 2)];

            for (let f = 0; f < totalFrames; f++) {
              const frameStart = dataOffset + f * frameSize + pointBlockSize;

              // 力・モーメント成分を初期化 (Type 2: Fx, Fy, Fz, Mx, My, Mz)
              let fx = 0, fy = 0, fz = 0, mx = 0, my = 0, mz = 0;

              // 各チャンネルからデータを読み取り（6チャンネル全て）
              // サブフレームの中央値または最初のサンプルを使用
              const subframeToRead = 0; // 最初のサブフレーム

              // デバッグ: 特定のフレームで生のバイトデータを確認
              if (debugFrames.includes(f) && p === 0) {
                console.log(`[C3D] Frame ${f} debug: dataOffset=${dataOffset}, frameSize=${frameSize}, frameStart=${frameStart}`);
                // 最初の24バイト（6チャンネル × 4バイト）をダンプ
                const dumpSize = Math.min(24, buffer.length - frameStart);
                if (dumpSize > 0) {
                  const hexDump = [];
                  for (let i = 0; i < dumpSize; i++) {
                    hexDump.push(buffer.readUInt8(frameStart + i).toString(16).padStart(2, '0'));
                  }
                  console.log(`[C3D] Frame ${f} raw bytes at frameStart: ${hexDump.join(' ')}`);
                }
              }

              for (let ch = 0; ch < Math.min(plate.channels.length, 6); ch++) {
                const channelIndex = plate.channels[ch] - 1;  // 1-indexed -> 0-indexed
                if (channelIndex >= 0) {
                  // アナログデータのオフセット計算
                  // C3D format: [ch0_s0, ch1_s0, ..., chN_s0, ch0_s1, ch1_s1, ..., chN_s1, ...]
                  const analogOffset = frameStart + (subframeToRead * totalAnalogChannels + channelIndex) * analogByteSize;

                  if (analogOffset + analogByteSize <= buffer.length) {
                    let rawValue;
                    if (isFloat) {
                      rawValue = buffer.readFloatLE(analogOffset);
                    } else {
                      // ANALOG:FORMATに基づいて符号付き/符号なしを選択
                      const isUnsigned = fpParams.analogFormat === 'UNSIGNED';
                      rawValue = isUnsigned
                        ? buffer.readUInt16LE(analogOffset)
                        : buffer.readInt16LE(analogOffset);
                    }

                    // スケーリング適用: (raw - offset) * scale * genScale
                    const chOffset = offsets[channelIndex] || 0;
                    const chScale = scales[channelIndex] || 1.0;
                    const scaledValue = (rawValue - chOffset) * chScale * genScale;

                    // デバッグ: 特定のフレームで値を確認
                    if (debugFrames.includes(f) && p === 0) {
                      console.log(`[C3D] Frame ${f}, Ch ${ch} (analogCh ${channelIndex}): analogOffset=${analogOffset}, raw=${rawValue}, offset=${chOffset}, scale=${chScale}, genScale=${genScale}, scaled=${scaledValue.toFixed(2)}`);
                    }

                    if (ch === 0) fx = scaledValue;
                    else if (ch === 1) fy = scaledValue;
                    else if (ch === 2) fz = scaledValue;
                    else if (ch === 3) mx = scaledValue;
                    else if (ch === 4) my = scaledValue;
                    else if (ch === 5) mz = scaledValue;
                  } else if (debugFrames.includes(f) && p === 0) {
                    console.warn(`[C3D] Frame ${f}: Analog offset ${analogOffset} out of bounds (buffer length: ${buffer.length})`);
                  }
                }
              }

              // CAL_MATRIXが存在する場合は適用（6x6行列 × 6要素ベクトル）
              if (fpParams.calMatrix && fpParams.calMatrix[p]) {
                const cal = fpParams.calMatrix[p];
                const raw = [fx, fy, fz, mx, my, mz];
                const calibrated = [0, 0, 0, 0, 0, 0];
                for (let r = 0; r < 6; r++) {
                  for (let c = 0; c < 6; c++) {
                    calibrated[r] += cal[r][c] * raw[c];
                  }
                }
                fx = calibrated[0];
                fy = calibrated[1];
                fz = calibrated[2];
                mx = calibrated[3];
                my = calibrated[4];
                mz = calibrated[5];
              }

              // FORCE_PLATFORM:SCALEが存在する場合は適用
              if (fpParams.fpScale && fpParams.fpScale.length > 0) {
                const fpScaleValue = fpParams.fpScale[p] || fpParams.fpScale[0] || 1.0;
                fx *= fpScaleValue;
                fy *= fpScaleValue;
                fz *= fpScaleValue;
                mx *= fpScaleValue;
                my *= fpScaleValue;
                mz *= fpScaleValue;
              }

              plate.forceData.push({ fx, fy, fz, mx, my, mz });
            }
          }

          // デバッグ出力: 最大値と統計情報
          if (plate.forceData.length > 0) {
            const f0 = plate.forceData[0];
            const f100 = plate.forceData[Math.min(100, plate.forceData.length - 1)];
            console.log(`[C3D] Plate ${p} force data - Frame 0: fx=${f0.fx.toFixed(2)}, fy=${f0.fy.toFixed(2)}, fz=${f0.fz.toFixed(2)}, mx=${f0.mx.toFixed(2)}, my=${f0.my.toFixed(2)}, mz=${f0.mz.toFixed(2)}`);
            console.log(`[C3D] Plate ${p} force data - Frame 100: fx=${f100.fx.toFixed(2)}, fy=${f100.fy.toFixed(2)}, fz=${f100.fz.toFixed(2)}, mx=${f100.mx.toFixed(2)}, my=${f100.my.toFixed(2)}, mz=${f100.mz.toFixed(2)}`);

            // 最大値を検索
            let maxFx = 0, maxFy = 0, maxFz = 0, maxFzFrame = 0;
            for (let i = 0; i < plate.forceData.length; i++) {
              const fd = plate.forceData[i];
              if (Math.abs(fd.fx) > Math.abs(maxFx)) maxFx = fd.fx;
              if (Math.abs(fd.fy) > Math.abs(maxFy)) maxFy = fd.fy;
              if (Math.abs(fd.fz) > Math.abs(maxFz)) {
                maxFz = fd.fz;
                maxFzFrame = i;
              }
            }
            console.log(`[C3D] Plate ${p} MAX values: Fx=${maxFx.toFixed(1)}N, Fy=${maxFy.toFixed(1)}N, Fz=${maxFz.toFixed(1)}N at frame ${maxFzFrame}`);
            console.log(`[C3D] Plate ${p} CAL_MATRIX applied:`, !!fpParams.calMatrix?.[p]);
            console.log(`[C3D] Plate ${p} FP_SCALE applied:`, fpParams.fpScale?.[p] || fpParams.fpScale?.[0] || 'none');

            // 歩行時の期待値との比較
            if (Math.abs(maxFz) < 100) {
              console.warn(`[C3D] WARNING: Plate ${p} maxFz(${maxFz.toFixed(1)}N) is very small. Expected ~700-1000N for walking. Check scale factors!`);
            }
          }

          forcePlates.push(plate);
        }
      }
    } catch (e) {
      console.warn('C3Dフォースプレート取得エラー:', e);
    }

    return forcePlates;
  }

  /**
   * プロジェクトファイルを開く
   * @param {string|null} targetFilePath - 開きたいファイルのパス。nullの場合はダイアログを開く
   */
  async openProjectFile(targetFilePath = null) {
    try {
      let filePath = targetFilePath;

      // 引数にパスが指定されていない場合はファイル選択ダイアログを表示
      if (!filePath) {
        const result = await dialog.showOpenDialog(this.mainWindow, {
          title: 'プロジェクトファイルを開く',
          filters: [
            { name: 'MotionViewer Project', extensions: ['mvp'] },
            { name: 'すべてのファイル', extensions: ['*'] }
          ],
          properties: ['openFile'],
          defaultPath: lastMotionDir || undefined
        });

        if (result.canceled || result.filePaths.length === 0) {
          return; // キャンセルされた場合は何もしない
        }
        filePath = result.filePaths[0];
      }

      // ファイルを開く処理
      currentProjectFilePath = filePath;
      lastMotionDir = path.dirname(filePath);

      const content = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(content);

      // 相対パスを絶対パスに変換
      if (data.motionFilePath && !path.isAbsolute(data.motionFilePath)) {
        data.motionFilePath = path.resolve(path.dirname(filePath), data.motionFilePath);
      }

      this.mainWindow.webContents.send('load-project-data', {
        data,
        projectPath: filePath
      });
    } catch (error) {
      console.error('プロジェクトファイル読み込みエラー:', error);
      this.showError(`プロジェクトファイルの読み込みに失敗しました:\n${error.message}`);
    }
  }

  /**
   * IPC通信設定
   */
  setupIPC() {
    // ファイル読み込み
    ipcMain.handle('load-file', async (event, filePath) => {
      try {
        const ext = path.extname(filePath).toLowerCase();

        if (ext === '.c3d') {
          // C3Dファイルはバイナリとして読み込みパース
          const buffer = await fs.readFile(filePath);
          const c3dResult = this.parseC3D(buffer);
          return {
            success: true,
            data: c3dResult.csvData,
            isC3D: true,
            c3dMetadata: c3dResult.metadata
          };
        } else {
          // テキストファイル
          const data = await fs.readFile(filePath, 'utf8');
          return { success: true, data };
        }
      } catch (error) {
        if (this.isDev) console.error('ファイル読み込みエラー:', error);
        return { success: false, error: error.message };
      }
    });

    // show-save-dialog ハンドラ追加
    ipcMain.handle('show-save-dialog', async (event, options) => {
      return await dialog.showSaveDialog(this.mainWindow, options);
    });

    // 設定保存ダイアログ
    ipcMain.handle('save-settings-dialog', async (event, settingsData, defaultName) => {
      try {
        const { canceled, filePath } = await dialog.showSaveDialog(this.mainWindow, {
          title: '設定ファイルを保存',
          defaultPath: defaultName || 'motion-settings.json',
          filters: [{ name: 'JSON Files', extensions: ['json'] }]
        });

        if (!canceled && filePath) {
          await fs.writeFile(filePath, JSON.stringify(settingsData, null, 2));
          return { success: true, filePath };
        }
        return { success: false, error: 'Save dialog was canceled.' };
      } catch (error) {
        if (this.isDev) console.error('設定ファイルの保存エラー:', error);
        return { success: false, error: error.message };
      }
    });

    // プロジェクト保存（新規）
    ipcMain.handle('save-project-file', async (event, data) => {
      try {
        // モーションファイルのパスとファイル名からデフォルトパスを設定
        let defaultPath = 'project.mvp';
        if (data.motionFilePath) {
          const motionDir = path.dirname(data.motionFilePath);
          const motionBaseName = path.basename(data.motionFilePath, path.extname(data.motionFilePath));
          defaultPath = path.join(motionDir, motionBaseName + '.mvp');
        }

        const { canceled, filePath } = await dialog.showSaveDialog(this.mainWindow, {
          title: 'プロジェクトを保存',
          defaultPath: defaultPath,
          filters: [{ name: 'MotionViewer Project', extensions: ['mvp'] }]
        });

        if (canceled || !filePath) {
          return { success: false, error: 'cancelled' };
        }

        // モーションファイルパスを相対パスに変換
        const dataToSave = { ...data };
        if (dataToSave.motionFilePath && path.isAbsolute(dataToSave.motionFilePath)) {
          dataToSave.motionFilePath = path.relative(path.dirname(filePath), dataToSave.motionFilePath);
        }

        await fs.writeFile(filePath, JSON.stringify(dataToSave, null, 2));
        currentProjectFilePath = filePath;

        // ステータス更新
        await this.updateProjectStatus('completed');

        return { success: true, path: filePath };
      } catch (error) {
        console.error('プロジェクト保存エラー:', error);
        return { success: false, error: error.message };
      }
    });

    // プロジェクト上書き保存
    ipcMain.handle('overwrite-project-file', async (event, args) => {
      try {
        const targetPath = args && args.path;
        const data = args && args.data;

        if (!targetPath) {
          return { success: false, error: 'path is required' };
        }

        // モーションファイルパスを相対パスに変換
        const dataToSave = { ...data };
        if (dataToSave.motionFilePath && path.isAbsolute(dataToSave.motionFilePath)) {
          dataToSave.motionFilePath = path.relative(path.dirname(targetPath), dataToSave.motionFilePath);
        }

        await fs.writeFile(targetPath, JSON.stringify(dataToSave, null, 2));
        currentProjectFilePath = targetPath;

        // ステータス更新
        await this.updateProjectStatus('completed');

        return { success: true, path: targetPath };
      } catch (error) {
        console.error('プロジェクト上書き保存エラー:', error);
        return { success: false, error: error.message };
      }
    });

    // プロジェクトステータス更新 IPC (レンダラーから呼び出し用)
    ipcMain.handle('update-project-status', async (event, { step, status }) => {
      return await this.updateProjectStatus(status, step);
    });

    // 現在のプロジェクトパスを取得
    ipcMain.handle('get-current-project-path', () => {
      return currentProjectFilePath;
    });



    // アプリケーション情報
    ipcMain.handle('get-app-info', () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform
    }));

    // スティックピクチャーメニューのリセット
    ipcMain.handle('reset-stick-picture-menu', () => {
      this.setStickPictureMenu(null);
    });

    // フレーム画像を一時フォルダに保存
    ipcMain.handle('save-frame-image', async (event, dataURL, frameNumber) => {
      try {
        const tempDir = path.join(app.getPath('temp'), 'motion-viewer-frames');
        await fs.mkdir(tempDir, { recursive: true });

        const base64Data = dataURL.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const framePath = path.join(tempDir, `frame_${frameNumber.toString().padStart(4, '0')}.png`);

        await fs.writeFile(framePath, buffer);
        return { success: true };
      } catch (error) {
        if (this.isDev) console.error('フレーム画像保存エラー:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('set-inertia-visualization-menu', async (event, checked) => {
      const menu = Menu.getApplicationMenu();
      const item = menu ? menu.getMenuItemById('menu-inertia-visualization') : null;
      if (item) {
        item.checked = !!checked;
      }
    });

    // 動画生成
    ipcMain.handle('create-video-from-frames', async (event, totalFrames, outputPath, speedValue = 1.0, inputFps = 250) => {
      try {
        const tempDir = path.join(app.getPath('temp'), 'motion-viewer-frames');
        const tempOutDir = path.join(app.getPath('temp'), 'motion-viewer-frames-out');
        await fs.mkdir(tempOutDir, { recursive: true });
        // 画像列のコピー
        for (let i = 0; i < totalFrames; i++) {
          const srcPath = path.join(tempDir, `frame_${i.toString().padStart(4, '0')}.png`);
          const dstPath = path.join(tempOutDir, `frame_${i.toString().padStart(4, '0')}.png`);
          await fs.copyFile(srcPath, dstPath);
        }
        // ffmpegで動画化（FHD: 1920x1080）
        const ffmpegCommand = [
          '-framerate', '60',
          '-i', path.join(tempOutDir, 'frame_%04d.png'),
          '-vf', `setpts=1*PTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2`,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-r', '60',
          '-y',
          outputPath
        ];
        return await new Promise((resolve) => {
          execFile(ffmpegPath, ffmpegCommand, async (error, stdout, stderr) => {
            // 一時ファイル削除
            try {
              const files = await fs.readdir(tempOutDir);
              for (const file of files) {
                await fs.unlink(path.join(tempOutDir, file));
              }
              await fs.rmdir(tempOutDir);
            } catch (cleanupError) { }
            if (error) {
              if (this.isDev) console.error('動画生成エラー:', error, stderr);
              resolve({ success: false, error: error.message, stderr });
              return;
            }
            resolve({ success: true });
          });
        });
      } catch (error) {
        if (this.isDev) console.error('動画生成エラー:', error);
        return { success: false, error: error.message };
      }
    });

    // 図形描写ウィンドウを開く
    ipcMain.handle('open-sequence-draw-window', async (event, data) => {
      try {
        console.log('[DEBUG] open-sequence-draw-window called');
        console.log('[DEBUG] data keys:', Object.keys(data));

        const window = this.createSequenceDrawWindow();
        console.log('[DEBUG] createSequenceDrawWindow returned');

        // ウィンドウが準備できたらデータを送信
        window.webContents.once('did-finish-load', () => {
          console.log('[DEBUG] sequence window loaded, sending data');
          window.webContents.send('draw-sequence-data', data);
        });

        return { success: true };
      } catch (error) {
        console.error('[ERROR] 図形描写ウィンドウエラー:', error);
        return { success: false, error: error.message };
      }
    });

    // 画像ファイル保存
    ipcMain.handle('save-image-file', async (event, filePath, base64Data) => {
      try {
        const buffer = Buffer.from(base64Data, 'base64');
        await fs.writeFile(filePath, buffer);
        return { success: true };
      } catch (error) {
        if (this.isDev) console.error('画像ファイル保存エラー:', error);
        return { success: false, error: error.message };
      }
    });

    // GLBファイル保存
    ipcMain.handle('save-glb-file', async (event, filePath, base64Data) => {
      try {
        const buffer = Buffer.from(base64Data, 'base64');
        await fs.writeFile(filePath, buffer);
        return { success: true };
      } catch (error) {
        if (this.isDev) console.error('GLBファイル保存エラー:', error);
        return { success: false, error: error.message };
      }
    });

    // SVGファイル保存
    ipcMain.handle('save-svg-file', async (event, filePath, svgContent) => {
      try {
        await fs.writeFile(filePath, svgContent, 'utf8');
        return { success: true };
      } catch (error) {
        if (this.isDev) console.error('SVGファイル保存エラー:', error);
        return { success: false, error: error.message };
      }
    });

    // ファイル存在確認
    ipcMain.handle('check-file-exists', async (event, filePath) => {
      try {
        await fs.access(filePath);
        return { exists: true };
      } catch (error) {
        return { exists: false };
      }
    });

    // 任意ファイル読み込み（Base64返却）
    ipcMain.handle('read-binary-file', async (event, filePath) => {
      try {
        const buffer = await fs.readFile(filePath);
        return { success: true, data: buffer.toString('base64') };
      } catch (error) {
        if (this.isDev) console.error('ファイル読み込みエラー:', error);
        return { success: false, error: error.message };
      }
    });

    // 設定ファイル読み込み
    ipcMain.handle('read-settings-file', async (event, filePath) => {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        return { success: true, content };
      } catch (error) {
        if (this.isDev) console.error('設定ファイル読み込みエラー:', error);
        return { success: false, error: error.message };
      }
    });

    // モーションデータを開くダイアログ（ツールバーから呼び出し用）
    ipcMain.handle('open-motion-dialog', async () => {
      await this.openFileDialog();
    });

    // プロジェクトファイルを開くダイアログ（ツールバーから呼び出し用）
    ipcMain.handle('open-project-dialog', async () => {
      await this.openProjectFile();
    });

    // プロジェクト保存ダイアログ（ツールバーから呼び出し用）
    ipcMain.handle('trigger-save-project', async () => {
      this.mainWindow.webContents.send('save-project', { isNew: false });
    });
  }

  /**
   * About ダイアログ表示
   */
  showAbout() {
    dialog.showMessageBox(this.mainWindow, {
      type: 'info',
      title: 'MotionViewerについて',
      message: 'MotionViewer v1.0.0',
      detail: '軽量モーションデータ3D可視化アプリケーション\n\n対応形式: .sd, .rd, .2d, .3d\n\nThree.js + Electron製'
    });
  }

  /**
   * エラー表示
   */
  showError(message) {
    dialog.showErrorBox('エラー', message);
  }

  setStickPictureMenu(type) {
    const template = this._buildMenuTemplate(type);
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  /**
   * プロジェクトステータス更新
   * @param {string} status - 'completed' etc.
   * @param {string} step - 'motionViewer' (default)
   */
  async updateProjectStatus(status, step = 'motionViewer') {
    if (!this.projectDataPath) return { success: false, error: 'No project data path set' };

    const statusPath = path.join(this.projectDataPath, 'status.json');
    try {
      let statusData = {};

      // check if file exists
      try {
        await fs.access(statusPath);
        const content = await fs.readFile(statusPath, 'utf8');
        statusData = JSON.parse(content);
      } catch (e) {
        // ignore if parsing failed or file missing, start empty
      }

      if (!statusData.steps) statusData.steps = {};
      if (!statusData.steps[step]) statusData.steps[step] = {};

      statusData.steps[step].status = status;
      statusData.steps[step].updated_at = new Date().toISOString();

      await fs.writeFile(statusPath, JSON.stringify(statusData, null, 2));
      return { success: true };
    } catch (error) {
      console.error('Failed to update status:', error);
      return { success: false, error: error.message };
    }
  }
}

// アプリケーション起動
const motionViewerApp = new MotionViewerApp();