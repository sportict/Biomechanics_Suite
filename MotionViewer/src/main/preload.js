const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * MotionViewer Preload Script（最小構成）
 * セキュアなAPI公開のみに特化
 */

// ドロップされたファイルのパスを一時保存
let lastDroppedFilePath = null;

// DOMContentLoadedでドロップイベントをキャプチャ
window.addEventListener('DOMContentLoaded', () => {
  console.log('[Preload] DOMContentLoaded - ドロップイベントリスナーを設定');
  document.addEventListener('drop', (e) => {
    console.log('[Preload] ドロップイベント発生');
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      // webUtils.getPathForFile()を使用してファイルパスを取得
      try {
        const filePath = webUtils.getPathForFile(file);
        console.log('[Preload] webUtils.getPathForFile():', filePath);
        if (filePath) {
          lastDroppedFilePath = filePath;
          console.log('[Preload] ファイルパスを保存:', lastDroppedFilePath);
        } else {
          console.log('[Preload] ファイルパスが空です');
        }
      } catch (err) {
        console.log('[Preload] webUtils.getPathForFile()エラー:', err);
      }
    }
  }, true); // キャプチャフェーズで実行
});

// レンダラープロセスに安全なAPIを公開
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * ファイル操作API
   */
  // ファイル読み込み完了イベントリスナー
  onFileLoaded: (callback) => {
    ipcRenderer.on('file-loaded', (event, data) => callback(data));
  },

  // 汎用イベントリスナー
  on: (channel, callback) => {
    const validChannels = [
      'file-loaded', 'show-stick-picture-23', 'show-stick-picture-25',
      'hide-stick-picture', 'show-point-settings', 'show-line-settings',
      'show-floor-settings-dialog', 'trigger-save-settings', 'load-settings-data',
      'set-camera-view', 'show-graph-display', 'show-background-color-dialog',
      'show-filter-dialog', 'show-sequence-draw-dialog', 'draw-sequence-data',
      'show-body-com-dialog', 'toggle-inertia-visualization',
      'new-project', 'save-project', 'load-project-data',
      'show-force-plate-dialog', 'show-inverse-dynamics-dialog', 'show-segment-definition-dialog'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },

  // イベントリスナー削除
  removeFileLoadedListener: () => {
    ipcRenderer.removeAllListeners('file-loaded');
  },

  // ファイル読み込み要求
  loadFile: (filePath) => ipcRenderer.invoke('load-file', filePath),

  /**
   * アプリケーション情報API
   */
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  /**
   * 動画出力API
   */
  saveFrameImage: (dataURL, frameNumber) => ipcRenderer.invoke('save-frame-image', dataURL, frameNumber),
  createVideoFromFrames: (totalFrames, outputPath, speedValue, inputFps) => ipcRenderer.invoke('create-video-from-frames', totalFrames, outputPath, speedValue, inputFps),

  /**
   * プラットフォーム情報
   */
  platform: process.platform,
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
  isLinux: process.platform === 'linux',
  // renderer -> main (invoke/handle)
  invoke: (channel, ...args) => {
    const validChannels = [
      'show-save-dialog', 'save-frame-image', 'create-video-from-frames',
      'save-settings-dialog', 'reset-stick-picture-menu',
      'open-sequence-draw-window', 'save-image-file', 'save-glb-file', 'save-svg-file',
      'check-file-exists', 'read-settings-file', 'read-binary-file',
      'set-inertia-visualization-menu',
      'save-project-file', 'overwrite-project-file', 'get-current-project-path',
      'load-file', 'open-motion-dialog', 'open-project-dialog', 'trigger-save-project'
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
  }
});

/**
 * ファイル操作API（ドラッグ&ドロップ用）
 */
contextBridge.exposeInMainWorld('fileAPI', {
  // ファイル読み取り
  readFileAsText: (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('ファイル読み込み失敗'));
      reader.readAsText(file);
    });
  },

  // ファイル情報取得
  getFileInfo: (file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    extension: file.name.split('.').pop().toLowerCase()
  }),

  // 対応ファイル形式チェック
  isSupportedFile: (file) => {
    const supportedExtensions = ['sd', 'rd', '2d', '3d', 'c3d'];
    const extension = file.name.split('.').pop().toLowerCase();
    return supportedExtensions.includes(extension);
  },

  // 最後にドロップされたファイルのパスを取得
  getLastDroppedFilePath: () => {
    const path = lastDroppedFilePath;
    lastDroppedFilePath = null; // 取得後にクリア
    return path;
  }
});

/**
 * デバッグ情報（開発時のみ）
 */
if (process.env.NODE_ENV === 'development') {
  contextBridge.exposeInMainWorld('debugAPI', {
    versions: {
      node: process.versions.node,
      chrome: process.versions.chrome,
      electron: process.versions.electron
    },
    platform: process.platform,
    arch: process.arch
  });
}

// 初期化完了（開発時のみログ出力）
if (process.env.NODE_ENV === 'development') {
  console.log('MotionViewer Preload Script 読み込み完了');
  console.log('Platform:', process.platform);
  console.log('Electron:', process.versions.electron);
}
