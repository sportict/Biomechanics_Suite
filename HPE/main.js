const { app, BrowserWindow, ipcMain, dialog, Menu, webUtils } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const {
  buildMacAppMenu, buildQuitMenuItem,
  getIconPath, isDev: getIsDev,
  getFilePathFromArgs, suppressChromiumLogs
} = require(app.isPackaged ? './shared/electron-utils' : '../shared/electron-utils');

// アプリ名を設定（メニューバー・Dockに反映）
app.setName('HPE');

// Chromium 内部の不要ログを抑制
suppressChromiumLogs();

let mainWindow;
let pythonProcess = null;
let logFile = null;
let forceQuit = false;

// IPC通信用
let pendingRequests = new Map(); // requestId -> {resolve, reject, onProgress}
let pythonReady = false;
let pythonDevice = 'cpu';
let pythonModelLoaded = false;
let pythonModelLoading = true;
let loadedModels = null;

// ログファイルに書き込む（コンソール出力なし）
function writeLog(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  if (logFile) {
    fs.appendFileSync(logFile, logMessage);
  }
  // コンソールにも出力
  console.log(logMessage.trim());
}

// 開発モードかどうか
const isDev = getIsDev();

// リソースのベースパスを取得
function getResourcesPath() {
  if (isDev) {
    return __dirname;
  } else {
    return process.resourcesPath;
  }
}

// UUIDの簡易生成（外部ライブラリなし）
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Pythonプロセスを起動
function startPythonProcess() {
  const resourcesPath = getResourcesPath();
  const ipcScript = path.join(resourcesPath, 'server', 'ipc_handler.py');
  const serverCwd = path.join(resourcesPath, 'server');

  // ログファイルを初期化
  logFile = path.join(resourcesPath, 'hpe-server.log');
  fs.writeFileSync(logFile, '');

  writeLog(`[Main] isDev: ${isDev}`);
  writeLog(`[Main] resourcesPath: ${resourcesPath}`);

  // Python実行ファイルのパスを決定
  //
  // 優先順位 (Windows):
  //   1. python_embed_gpu/python.exe  (GPU 版。デフォルト優先)
  //   2. python_embed_cpu/python.exe  (CPU 版)
  //   3. python_embed/python.exe       (installer 展開後のジャンクション or 旧構成互換)
  //   4. .venv/Scripts/python.exe      (最後のフォールバック)
  //   5. システム python                (最終手段)
  //
  // 環境変数 HPE_DEV_MODE で明示的に切替可能:
  //   HPE_DEV_MODE=gpu → GPU を強制 (python_embed_gpu のみ許容)
  //   HPE_DEV_MODE=cpu → CPU を強制 (python_embed_cpu を最優先)
  //
  // 2026-04-19 変更:
  //   python_embed を python_embed_gpu / python_embed_cpu に分離 (案 B)。
  //   これによりモード切替が再ビルド不要になる。
  //   installer (dist/HPE-GPU-Setup-*.exe / HPE-CPU-Setup-*.exe) では
  //   build_*.bat がジャンクション python_embed → python_embed_<mode> を
  //   一時的に張るため、配布先では依然として resourcesPath/python_embed を参照可能。
  const isWin = process.platform === 'win32';
  const venvBinDir = isWin ? 'Scripts' : 'bin';
  const pythonName = isWin ? 'python.exe' : 'python';
  const python3Name = isWin ? 'python.exe' : 'python3';
  const systemFallback = isWin ? 'python' : 'python3';

  // 明示切替スイッチ (gpu|cpu|auto)
  const devMode = (process.env.HPE_DEV_MODE || 'auto').toLowerCase();

  // Mode-split embed 候補 (Windows のみ)
  // 順序は HPE_DEV_MODE で並べ替え (デフォルトは gpu → cpu)
  const makeEmbedCandidates = (mode) => {
    const dirName = `python_embed_${mode}`;
    return [
      path.join(resourcesPath, dirName, 'python.exe'),
      path.join(__dirname, dirName, 'python.exe'),
    ];
  };

  let embedCandidates = [];
  if (isWin) {
    if (devMode === 'cpu') {
      embedCandidates = [...makeEmbedCandidates('cpu'), ...makeEmbedCandidates('gpu')];
    } else if (devMode === 'gpu') {
      // gpu 強制: python_embed_cpu はフォールバックさせない (誤起動防止)
      embedCandidates = makeEmbedCandidates('gpu');
    } else {
      // auto: gpu 優先、無ければ cpu
      embedCandidates = [...makeEmbedCandidates('gpu'), ...makeEmbedCandidates('cpu')];
    }

    // 後方互換: 旧 python_embed/ (ジャンクションまたは旧レイアウト)
    embedCandidates.push(
      path.join(resourcesPath, 'python_embed', 'python.exe'),
      path.join(__dirname, 'python_embed', 'python.exe')
    );
  }

  // .venv フォールバック候補
  const venvCandidates = [
    path.join(resourcesPath, '.venv', venvBinDir, pythonName),
    path.join(resourcesPath, '.venv', venvBinDir, python3Name),
    path.join(__dirname, '.venv', venvBinDir, pythonName),
    path.join(__dirname, '.venv', venvBinDir, python3Name),
  ];

  let pythonExecutable = systemFallback;
  let pythonSource = 'system';
  let pythonEmbedDir = null;  // _HPE_BUILD_MODE 読み取り用

  writeLog(`[Main] HPE_DEV_MODE=${devMode}`);

  // 1. python_embed_* を優先探索
  for (const candidate of embedCandidates) {
    if (fs.existsSync(candidate)) {
      pythonExecutable = candidate;
      pythonSource = 'python_embed';
      pythonEmbedDir = path.dirname(candidate);
      writeLog(`[Main] Using python_embed: ${pythonExecutable}`);
      // ビルドモードマーカーを読む
      const markerPath = path.join(pythonEmbedDir, '_HPE_BUILD_MODE');
      if (fs.existsSync(markerPath)) {
        try {
          const markerMode = fs.readFileSync(markerPath, 'utf-8').trim();
          writeLog(`[Main] python_embed build mode: ${markerMode}`);
          if (devMode === 'gpu' && markerMode.toLowerCase() !== 'gpu') {
            writeLog(`[Main] WARN: HPE_DEV_MODE=gpu ですが、選択された python_embed は ${markerMode} ビルドです。`);
          } else if (devMode === 'cpu' && markerMode.toLowerCase() !== 'cpu') {
            writeLog(`[Main] WARN: HPE_DEV_MODE=cpu ですが、選択された python_embed は ${markerMode} ビルドです。`);
          }
        } catch (e) {
          writeLog(`[Main] Failed to read ${markerPath}: ${e.message}`);
        }
      } else {
        writeLog(`[Main] WARN: _HPE_BUILD_MODE marker not found in ${pythonEmbedDir}`);
      }
      break;
    }
  }

  // 2. .venv フォールバック
  if (pythonSource === 'system') {
    for (const candidate of venvCandidates) {
      if (fs.existsSync(candidate)) {
        pythonExecutable = candidate;
        pythonSource = 'venv';
        writeLog(`[Main] Using venv python (fallback): ${pythonExecutable}`);
        writeLog(`[Main] WARN: python_embed_gpu / python_embed_cpu が見つかりません。`);
        writeLog(`[Main]       構築するには: build_python_embed.ps1 -Mode Gpu  (または -Mode Cpu)`);
        break;
      }
    }
  }

  // 3. システム python フォールバック
  if (pythonSource === 'system') {
    writeLog(`[Main] Using system ${systemFallback} (last resort fallback)`);
  }

  writeLog(`[Main] Starting IPC handler: ${ipcScript}`);
  writeLog(`[Main] CWD: ${serverCwd}`);

  if (!fs.existsSync(ipcScript)) {
    writeLog(`[Main] ERROR: IPC script not found: ${ipcScript}`);
    return;
  }

  writeLog(`[Main] Files exist, spawning process...`);

  pythonProcess = spawn(pythonExecutable, ['-u', ipcScript], {
    cwd: serverCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  // stdoutから1行ずつ読み取る
  const rl = readline.createInterface({
    input: pythonProcess.stdout,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      // result / image_result は全フレームのキーポイントを含む巨大 JSON のため
      // コンソール・ログファイルへの全文出力をスキップし、サマリのみ記録する
      const SUPPRESS_TYPES = new Set(['result', 'image_result']);
      if (SUPPRESS_TYPES.has(message.type)) {
        const frames = message.data?.frames;
        const frameCount = Array.isArray(frames) ? frames.length : '?';
        writeLog(`[Python] {type:"${message.type}", id:"${message.id}", frames:${frameCount}, bytes:${line.length}}`);
      } else {
        writeLog(`[Python] ${line}`);
      }
      handlePythonMessage(message);
    } catch (e) {
      // JSON でない行（Python の print 等）はそのままログ
      writeLog(`[Python] ${line}`);
    }
  });

  pythonProcess.stderr?.on('data', (data) => {
    writeLog(`[Python Error] ${data}`);
    console.error(`[Python stderr] ${data}`);
  });

  pythonProcess.on('close', (code) => {
    writeLog(`[Python] Process exited with code ${code}`);
    pythonProcess = null;
    pythonReady = false;

    // 保留中のリクエストをすべてエラーにする
    for (const [id, handler] of pendingRequests) {
      handler.reject(new Error('Python process exited'));
    }
    pendingRequests.clear();
  });

  pythonProcess.on('error', (err) => {
    writeLog(`[Python] Failed to start: ${err.message}`);
    pythonProcess = null;
    pythonReady = false;
  });

  writeLog('[Main] Python process started');
}

// Pythonからのメッセージを処理
function handlePythonMessage(message) {
  const { id, type, data } = message;

  // 初期化メッセージ（ready）
  if (type === 'ready') {
    pythonReady = true;
    pythonDevice = data?.device || 'cpu';
    const modelLoading = data?.model_loading || false;
    writeLog(`[Main] Python ready, device: ${pythonDevice}, model_loading: ${modelLoading}`);

    // rendererにステータス更新を通知
    // DOMContentLoaded後のハンドラ登録を待つため少し遅延
    const sendReadyAndProject = () => {
      if (!mainWindow) return;

      mainWindow.webContents.send('python-status-update', {
        ready: true,
        device: pythonDevice,
        modelLoading: modelLoading
      });

      // 保留中のプロジェクトファイルがあれば開く
      if (global.pendingProjectFile) {
        const pendingFile = global.pendingProjectFile;
        global.pendingProjectFile = null;
        writeLog(`[Main] Opening pending project file: ${pendingFile}`);
        // ステータス更新の処理を待ってからプロジェクトを開く
        setTimeout(() => {
          mainWindow.webContents.send('menu-load-project-file', pendingFile);
        }, 100);
      }
    };

    if (mainWindow) {
      if (mainWindow.webContents.isLoading()) {
        // まだロード中なら完了を待つ
        mainWindow.webContents.once('did-finish-load', () => {
          // DOMContentLoaded + ハンドラ登録を待つ
          setTimeout(sendReadyAndProject, 500);
        });
      } else {
        // 既にロード完了している場合も少し待つ（ハンドラ登録完了を待つ）
        setTimeout(sendReadyAndProject, 500);
      }
    }
    return;
  }

  // モデルロード進捗メッセージ
  if (type === 'model_loading_progress') {
    if (mainWindow) {
      mainWindow.webContents.send('python-model-loading-progress', {
        progress: data?.progress || 0,
        message: data?.message || ''
      });
    }
    return;
  }

  // ログメッセージの転送
  if (type === 'log') {
    if (mainWindow) {
      mainWindow.webContents.send('python-log', data);
    }
    // メインプロセスログにも出力
    writeLog(`[Python Log] ${data}`);
    return;
  }

  // モデルロード完了メッセージ
  if (type === 'model_loaded') {
    writeLog(`[Main] Model loaded: ${data?.success ? 'success' : 'failed'}`);
    pythonModelLoading = false;
    pythonModelLoaded = data?.success || false;
    if (data?.device) {
      pythonDevice = data.device;
    }
    if (data?.models) {
      loadedModels = data.models;
      writeLog(`[Main] Loaded models: ${JSON.stringify(data.models)}`);
    }
    if (mainWindow) {
      mainWindow.webContents.send('python-model-loaded', {
        success: data?.success || false,
        device: data?.device || pythonDevice,
        models: data?.models || {},
        error: data?.error
      });
    }
    return;
  }

  // リクエストへのレスポンス
  const handler = pendingRequests.get(id);
  if (!handler) {
    writeLog(`[Main] No handler for request id: ${id}`);
    return;
  }

  if (type === 'progress') {
    // 進捗通知
    if (handler.onProgress) {
      handler.onProgress(data);
    }
  } else if (type === 'init') {
    // 初期化情報（動画検出開始時など）
    if (handler.onInit) {
      handler.onInit(data);
    }
  } else if (type === 'result') {
    // 成功
    pendingRequests.delete(id);
    handler.resolve(data);
  } else if (type === 'error') {
    // エラー
    pendingRequests.delete(id);
    handler.reject(new Error(data?.error || 'Unknown error'));
  }
}

// Pythonにリクエストを送信
function sendToPython(action, data, onProgress = null, onInit = null) {
  return new Promise((resolve, reject) => {
    if (!pythonProcess || !pythonReady) {
      reject(new Error('Python process not ready'));
      return;
    }

    const requestId = generateId();
    pendingRequests.set(requestId, { resolve, reject, onProgress, onInit });

    const message = JSON.stringify({
      id: requestId,
      action: action,
      data: data
    }) + '\n';

    writeLog(`[Main] Sending to Python: ${action}`);
    pythonProcess.stdin.write(message);
  });
}

// 保存確認ダイアログ（統一形式）
async function showSaveConfirmDialog(win, message = 'プロジェクトを保存しますか？') {
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['保存', '保存しない', 'キャンセル'],
    defaultId: 0,
    cancelId: 2,
    title: '保存確認',
    message: message,
    noLink: true,
  });
  return ['save', 'discard', 'cancel'][result.response];
}

// Pythonプロセスを停止
function stopPythonProcess() {
  if (pythonProcess) {
    // Windows では taskkill を使用して確実に終了
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', pythonProcess.pid, '/f', '/t']);
    } else {
      pythonProcess.kill('SIGTERM');
    }

    pythonProcess = null;
    pythonReady = false;
  }
}

// 一時キャッシュを削除
function cleanupTempFiles() {
  const os = require('os');
  const tmpDir = os.tmpdir();

  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      // HPE が作成した一時ファイル/ディレクトリのみ削除
      if (entry.startsWith('hpe_frames_') || entry.startsWith('hpe_video_') || entry.startsWith('hpe_redet_')) {
        const fullPath = require('path').join(tmpDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          writeLog(`[Cleanup] Removed: ${entry}`);
        } catch (e) {
          // 削除失敗は無視（他プロセスが使用中など）
        }
      }
    }
    // hpe_cache ディレクトリも削除
    const hpeCacheDir = require('path').join(tmpDir, 'hpe_cache');
    if (fs.existsSync(hpeCacheDir)) {
      fs.rmSync(hpeCacheDir, { recursive: true, force: true });
      writeLog('[Cleanup] Removed: hpe_cache');
    }
  } catch (e) {
    writeLog(`[Cleanup] Error: ${e.message}`);
  }
}

// Pythonプロセスを遅延起動（必要になった時に呼び出す）
function startPythonIfNeeded() {
  if (pythonProcess || pythonReady) {
    writeLog('[Main] Python already running or ready');
    return Promise.resolve({ success: true, alreadyRunning: true });
  }

  writeLog('[Main] Starting Python process on demand (deferred start)');
  global.pythonDeferred = false;
  startPythonProcess();

  // Pythonが準備完了するまで待つPromiseを返す
  return new Promise((resolve) => {
    const checkReady = setInterval(() => {
      if (pythonReady) {
        clearInterval(checkReady);
        resolve({ success: true, alreadyRunning: false });
      }
    }, 100);

    // 30秒でタイムアウト
    setTimeout(() => {
      clearInterval(checkReady);
      if (!pythonReady) {
        resolve({ success: false, error: 'Python startup timeout' });
      }
    }, 30000);
  });
}

// Pythonを必要に応じて起動するIPCハンドラー
ipcMain.handle('start-python-if-needed', async () => {
  return await startPythonIfNeeded();
});

// メインウィンドウを作成
function createWindow() {
  // アイコンパスを設定（macOSはPNG、WindowsはICO）
  const iconPath = getIconPath(__dirname, 'HPE.png', 'HPE.ico');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'HPE - Human Pose Estimation',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 開発環境では DevTools を開く
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
  });

  // ウィンドウを閉じようとした時のイベント（×ボタン、Cmd+Q、メニュー終了）
  mainWindow.on('close', async (e) => {
    if (forceQuit) return;
    e.preventDefault();

    const choice = await showSaveConfirmDialog(mainWindow);
    if (choice === 'save') {
      mainWindow.webContents.send('menu-save-and-quit');
    } else if (choice === 'discard') {
      forceQuit = true;
      app.quit();
    }
    // 'cancel' → 何もしない
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ウィンドウ作成時にPythonの状態を送信
  mainWindow.webContents.on('did-finish-load', () => {
    // Python遅延起動モードの場合（hpeファイルから起動）
    if (global.pythonDeferred && global.pendingProjectFile) {
      const pendingFile = global.pendingProjectFile;
      global.pendingProjectFile = null;
      writeLog(`[Main] Deferred mode: Loading project file immediately: ${pendingFile}`);

      // Pythonなしでプロジェクトを開く（ステータスは「オフライン」）
      mainWindow.webContents.send('python-status-update', {
        ready: false,
        device: 'unknown',
        modelLoading: false,
        deferred: true  // 遅延起動フラグ
      });

      // 少し遅延させてレンダラーの初期化完了を待つ
      setTimeout(() => {
        mainWindow.webContents.send('menu-load-project-file', pendingFile);
      }, 300);
      return;
    }

    if (pythonReady) {
      // まずステータス更新を送信
      mainWindow.webContents.send('python-status-update', {
        ready: true,
        device: pythonDevice,
        modelLoading: pythonModelLoading
      });
      // モデルがすでにロード済みの場合はその情報も送信
      if (pythonModelLoaded) {
        mainWindow.webContents.send('python-model-loaded', {
          success: true,
          device: pythonDevice,
          models: loadedModels || {}
        });
      }
    }
  });
}

// ===================================
// Python通信用IPCハンドラー
// ===================================
ipcMain.handle('python-status', async () => {
  return {
    ready: pythonReady,
    device: pythonDevice
  };
});

ipcMain.handle('python-request', async (event, { action, data }) => {
  try {
    const result = await sendToPython(action, data);
    return { success: true, data: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 進捗付きリクエスト（動画検出など）
ipcMain.handle('python-request-with-progress', async (event, { action, data }) => {
  // このハンドラは進捗を別チャネルで送信する
  const requestId = generateId();

  return new Promise((resolve, reject) => {
    if (!pythonProcess || !pythonReady) {
      resolve({ success: false, error: 'Python process not ready' });
      return;
    }

    pendingRequests.set(requestId, {
      resolve: (result) => resolve({ success: true, data: result }),
      reject: (err) => resolve({ success: false, error: err.message }),
      onProgress: (progressData) => {
        if (mainWindow) {
          mainWindow.webContents.send('python-progress', { requestId, ...progressData });
        }
      },
      onInit: (initData) => {
        if (mainWindow) {
          mainWindow.webContents.send('python-init', { requestId, ...initData });
        }
      }
    });

    const message = JSON.stringify({
      id: requestId,
      action: action,
      data: data
    }) + '\n';

    writeLog(`[Main] Sending to Python (with progress): ${action}`);
    // デバッグ: 送信するJSONの最初の500文字をログ出力
    writeLog(`[Main] Message content (first 500 chars): ${message.substring(0, 500)}`);
    pythonProcess.stdin.write(message);
  });
});

// ===================================
// 既存のIPCハンドラー
// ===================================
// レンダラーから呼べる保存確認ダイアログ
ipcMain.handle('show-save-confirm', async (event, message) => {
  return await showSaveConfirmDialog(mainWindow, message || 'プロジェクトを保存しますか？');
});

ipcMain.handle('select-file', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: options?.filters || [
      { name: 'Media Files', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'asf', 'mpeg', 'mpg'] },
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] },
      { name: 'Videos', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'asf', 'mpeg', 'mpg'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result;
});

// 複数ファイル選択（バッチ処理用）
ipcMain.handle('select-files', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: options?.filters || [
      { name: 'Media Files', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'asf', 'mpeg', 'mpg'] },
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] },
      { name: 'Videos', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'asf', 'mpeg', 'mpg'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result;
});

ipcMain.handle('select-folder', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: options?.defaultPath,
    buttonLabel: options?.buttonLabel,
    title: options?.title
  });
  return result;
});

ipcMain.handle('save-file-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options?.title || 'ファイルを保存',
    defaultPath: options?.defaultPath,
    filters: options?.filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  return result;
});

ipcMain.on('quit-app', () => {
  forceQuit = true;
  app.quit();
});

ipcMain.handle('save-project', async (event, { data, suggestedPath }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'プロジェクトを保存',
    defaultPath: suggestedPath || 'project.hpe',
    filters: [
      { name: 'HPE Project Files', extensions: ['hpe'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled) {
    return { success: false, canceled: true };
  }

  // dataがnullの場合はパス取得のみ（実際の保存はsave-project-directで行う）
  if (data === null) {
    return { success: true, filePath: result.filePath };
  }

  try {
    const jsonData = await new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(JSON.stringify(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    await require('fs').promises.writeFile(result.filePath, jsonData, 'utf-8');
    return { success: true, filePath: result.filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-project-direct', async (event, { data, filePath }) => {
  try {
    const jsonData = await new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(JSON.stringify(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    await require('fs').promises.writeFile(filePath, jsonData, 'utf-8');
    return { success: true, filePath: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'プロジェクトを読み込み',
    filters: [
      { name: 'HPE Project Files', extensions: ['hpe'] },
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  try {
    const filePath = result.filePaths[0];
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(fileContent);
    return { success: true, data: data, filePath: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-project-from-path', async (event, filePath) => {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(fileContent);
    return { success: true, data: data, filePath: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-project-data', async () => {
  return { success: true };
});

ipcMain.handle('get-file-path', async (event, fileData) => {
  try {
    return { success: false, error: 'File path not available in Electron 32+' };
  } catch (e) {
    console.error('パスの取得に失敗:', e);
    return { success: false, error: e.message };
  }
});

// ファイル/ディレクトリの存在確認
ipcMain.handle('check-path-exists', async (event, pathToCheck) => {
  try {
    await fs.promises.access(pathToCheck);
    return true;
  } catch {
    return false;
  }
});

// ファイル書き込み
ipcMain.handle('write-file', async (event, { filePath, content, binary }) => {
  try {
    if (binary) {
      // バイナリデータの場合（画像など）
      const buffer = Buffer.from(content);
      await fs.promises.writeFile(filePath, buffer);
    } else {
      // テキストデータの場合
      await fs.promises.writeFile(filePath, content, 'utf-8');
    }

    // CSV保存時（エクスポート時）にステータスを更新
    if (filePath.toLowerCase().endsWith('.csv')) {
      await updateProjectStatus('hpe', 'completed');
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// メニューバーを作成
function createMenu() {
  const template = [
    ...buildMacAppMenu(),
    {
      label: 'ファイル',
      submenu: [
        {
          label: 'プロジェクトを開く...',
          accelerator: 'CmdOrCtrl+O',
          click: () => { if (mainWindow) mainWindow.webContents.send('menu-load-project'); }
        },
        {
          label: 'プロジェクトを閉じる',
          accelerator: 'CmdOrCtrl+W',
          click: () => { if (mainWindow) mainWindow.webContents.send('menu-close-project'); }
        },
        { type: 'separator' },
        {
          label: '上書き保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => { if (mainWindow) mainWindow.webContents.send('menu-save-project'); }
        },
        {
          label: '名前を付けて保存...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => { if (mainWindow) mainWindow.webContents.send('menu-save-project-as'); }
        },
        { type: 'separator' },
        {
          label: 'バッチ処理...',
          accelerator: 'CmdOrCtrl+B',
          click: () => { if (mainWindow) mainWindow.webContents.send('menu-batch-process'); }
        },
        { type: 'separator' },
        ...buildQuitMenuItem(() => { if (mainWindow) mainWindow.close(); })
      ]
    },
    {
      label: '編集',
      submenu: [
        {
          label: '元に戻す',
          accelerator: 'CmdOrCtrl+Z',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-undo');
            }
          }
        },
        {
          label: 'やり直し',
          accelerator: 'CmdOrCtrl+Y',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-redo');
            }
          }
        },
        {
          label: 'やり直し (代替)',
          accelerator: 'CmdOrCtrl+Shift+Z',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-redo');
            }
          }
        }
      ]
    },
    {
      label: '設定',
      submenu: [
        {
          label: '設定を開く',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-open-settings');
            }
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
            if (mainWindow) {
              mainWindow.webContents.toggleDevTools();
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// 起動引数からファイルパスを取得（--フラグでないもの）
function getFilePathFromArgv(argv) {
  return getFilePathFromArgs(argv, '.hpe');
}

// 単一インスタンスロック
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // macOS: ファイルダブルクリックや Dock へのドロップで開く
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!filePath.endsWith('.hpe')) return;
    writeLog(`[Main] open-file event: ${filePath}`);
    if (mainWindow && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('menu-load-project-file', filePath);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      global.pendingProjectFile = filePath;
    }
  });

  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // 2つ目のインスタンスが起動された時、既存のウィンドウにフォーカス
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      // 引数からファイルパスを取得して開く
      const filePath = getFilePathFromArgv(commandLine);
      if (filePath) {
        // レンダラーに通知してファイルを開かせる
        // 少し待ってから送ると安定する場合がある
        setTimeout(() => {
          mainWindow.webContents.send('menu-load-project-file', filePath);
        }, 500);
      }
    }
  });

  // アプリ起動時
  app.whenReady().then(() => {
    // macOS: DockアイコンをHPEアイコンに設定（dock.setIconはPNGのみ対応）
    if (process.platform === 'darwin' && app.dock) {
      const dockIcon = path.join(__dirname, 'HPE.png');
      if (fs.existsSync(dockIcon)) {
        try { app.dock.setIcon(dockIcon); } catch (e) { writeLog(`[Main] dock.setIcon failed: ${e.message}`); }
      }
    }

    // 起動引数解析
    const args = process.argv;
    writeLog(`[Main] process.argv: ${JSON.stringify(args)}`);

    const dataPathArg = args.find(arg => arg.startsWith('--data-path='));
    if (dataPathArg) {
      global.projectDataPath = dataPathArg.split('=')[1];
    }

    // メニューバーを作成
    createMenu();

    // 起動時のファイル読み込み（open-fileで先にセットされていなければ引数から取得）
    const filePath = global.pendingProjectFile || getFilePathFromArgv(args);
    writeLog(`[Main] project file to open: ${filePath}`);

    // Pythonプロセスは常に起動する
    startPythonProcess();
    if (filePath) {
      writeLog(`[Main] Project file specified, will open after ready`);
      global.pendingProjectFile = filePath;
      global.pythonDeferred = false;
    } else {
      writeLog(`[Main] No project file specified`);
    }

    // ウィンドウを作成
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

// プロジェクトステータス更新 ヘルパー
async function updateProjectStatus(step, status) {
  if (!global.projectDataPath) {
    // データパスがない場合は何もしない（単体起動時など）
    return { success: false, error: 'No project data path set' };
  }

  const statusPath = path.join(global.projectDataPath, 'status.json');
  try {
    let statusData = {};
    if (fs.existsSync(statusPath)) {
      statusData = JSON.parse(await fs.promises.readFile(statusPath, 'utf8'));
    }

    if (!statusData.steps) statusData.steps = {};
    if (!statusData.steps[step]) statusData.steps[step] = {};

    statusData.steps[step].status = status;
    statusData.steps[step].updated_at = new Date().toISOString();

    await fs.promises.writeFile(statusPath, JSON.stringify(statusData, null, 2));
    console.log(`[Status] Updated ${step} to ${status}`);
    return { success: true };
  } catch (error) {
    console.error('Failed to update status:', error);
    return { success: false, error: error.message };
  }
}

// プロジェクトステータス更新 IPC
ipcMain.handle('update-project-status', async (event, { step, status }) => {
  return await updateProjectStatus(step, status);
});

// 全ウィンドウが閉じられた時
app.on('window-all-closed', () => {
  stopPythonProcess();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// アプリ終了時
app.on('quit', () => {
  stopPythonProcess();
  cleanupTempFiles();
});

// 予期しない終了時もPythonプロセスを停止
process.on('exit', () => {
  stopPythonProcess();
});
