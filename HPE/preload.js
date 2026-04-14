const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Renderer プロセスに公開する API
contextBridge.exposeInMainWorld('electronAPI', {
  // ファイル選択ダイアログ
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  selectFiles: (options) => ipcRenderer.invoke('select-files', options),  // バッチ処理用（複数選択）
  selectFolder: (options) => ipcRenderer.invoke('select-folder', options),
  saveFileDialog: (options) => ipcRenderer.invoke('save-file-dialog', options),

  // プロジェクト保存・読み込み
  saveProject: (data, suggestedPath) => ipcRenderer.invoke('save-project', { data, suggestedPath }),
  saveProjectDirect: (data, filePath) => ipcRenderer.invoke('save-project-direct', { data, filePath }),
  loadProject: () => ipcRenderer.invoke('load-project'),
  loadProjectFromPath: (filePath) => ipcRenderer.invoke('load-project-from-path', filePath),

  // ファイル/ディレクトリの存在確認
  checkPathExists: (path) => ipcRenderer.invoke('check-path-exists', path),

  // ファイル書き込み
  writeFile: (filePath, content, binary = false) => ipcRenderer.invoke('write-file', { filePath, content, binary }),

  // ドラッグ&ドロップされたファイルのパスを取得
  // Electron 32+ では webUtils.getPathForFile を使用
  getFilePath: (file) => {
    try {
      if (file && webUtils && webUtils.getPathForFile) {
        return webUtils.getPathForFile(file);
      }
      return null;
    } catch (error) {
      return null;
    }
  },

  // ===================================
  // Python IPC 通信
  // ===================================
  // Pythonプロセスのステータス取得
  pythonStatus: () => ipcRenderer.invoke('python-status'),

  // Pythonへリクエスト送信（単発）
  pythonRequest: (action, data) => ipcRenderer.invoke('python-request', { action, data }),

  // Pythonへリクエスト送信（進捗付き）
  pythonRequestWithProgress: (action, data) => ipcRenderer.invoke('python-request-with-progress', { action, data }),

  // ポーズ推定をキャンセル
  cancelDetection: () => ipcRenderer.invoke('python-request', { action: 'cancel_detection', data: {} }),

  // Pythonプロセスを遅延起動（必要になった時に呼び出す）
  startPythonIfNeeded: () => ipcRenderer.invoke('start-python-if-needed'),

  // プロジェクトステータス更新
  updateProjectStatus: (status) => ipcRenderer.invoke('update-project-status', status),

  // Pythonからのステータス更新を受け取る
  onPythonStatusUpdate: (callback) => ipcRenderer.on('python-status-update', (event, data) => callback(data)),

  // Pythonからのモデルロード進捗を受け取る
  onPythonModelLoadingProgress: (callback) => ipcRenderer.on('python-model-loading-progress', (event, data) => callback(data)),

  // Pythonからのモデルロード完了を受け取る
  onPythonModelLoaded: (callback) => ipcRenderer.on('python-model-loaded', (event, data) => callback(data)),

  // Pythonからの進捗を受け取る
  onPythonProgress: (callback) => ipcRenderer.on('python-progress', (event, data) => callback(data)),

  // Pythonからの初期化情報を受け取る
  onPythonInit: (callback) => ipcRenderer.on('python-init', (event, data) => callback(data)),

  // Pythonからのログを受け取る
  onPythonLog: (callback) => ipcRenderer.on('python-log', (event, data) => callback(data)),

  // ===================================
  // メニューイベント
  // ===================================
  onMenuLoadVideo: (callback) => ipcRenderer.on('menu-load-video', callback),
  onMenuBatchProcess: (callback) => ipcRenderer.on('menu-batch-process', callback),
  onMenuSaveProject: (callback) => ipcRenderer.on('menu-save-project', callback),
  onMenuSaveProjectAs: (callback) => ipcRenderer.on('menu-save-project-as', callback),
  onMenuLoadProject: (callback) => ipcRenderer.on('menu-load-project', callback),
  onMenuCloseProject: (callback) => ipcRenderer.on('menu-close-project', callback),
  onMenuOpenSettings: (callback) => ipcRenderer.on('menu-open-settings', callback),
  onMenuSaveAndQuit: (callback) => ipcRenderer.on('menu-save-and-quit', callback),
  onMenuUndo: (callback) => ipcRenderer.on('menu-undo', callback),
  onMenuRedo: (callback) => ipcRenderer.on('menu-redo', callback),
  onMenuLoadProjectFile: (callback) => ipcRenderer.on('menu-load-project-file', (event, filePath) => callback(filePath)),

  // アプリ終了
  quitApp: () => ipcRenderer.send('quit-app'),

  // プラットフォーム情報
  platform: process.platform
});
