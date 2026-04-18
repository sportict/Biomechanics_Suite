// ===================================
// HPE - Human Pose Estimation
// Vanilla JavaScript Version
// IPC-based communication with Python backend
// ===================================

// API_BASEは不要（IPC通信を使用）

// 定数定義
const CONSTANTS = {
  NEAREST_FRAME_SEARCH_RANGE: 10,  // 最も近いキャッシュ済みフレームを探す範囲
  DEFAULT_FPS: 30,                 // デフォルトのFPS
  VIDEO_LOAD_TIMEOUT_MS: 3000,     // 動画読み込みタイムアウト（ミリ秒）
  SLIDER_DEBOUNCE_MS: 16,          // スライダーデバウンス時間（約60fps）
  SEEK_THRESHOLD_FRAMES: 1,        // シーク閾値（フレーム数）
  CACHE_PAUSE_INTERVAL_MS: 50,     // キャッシュ一時停止時のチェック間隔
};

// 23点キーポイント定義（内部識別用）
const KEYPOINT_NAMES = [
  'right_hand_tip', 'right_wrist', 'right_elbow', 'right_shoulder',
  'left_hand_tip', 'left_wrist', 'left_elbow', 'left_shoulder',
  'right_toe_tip', 'right_small_toe', 'right_heel', 'right_ankle', 'right_knee', 'right_hip',
  'left_toe_tip', 'left_small_toe', 'left_heel', 'left_ankle', 'left_knee', 'left_hip',
  'head_top', 'tragus_point', 'suprasternal_notch'
];

// ============================================================
// SynthPose / OpenCapBench 形式（52点: nativeモデル出力 + pelvis）
// https://github.com/StanfordMIMI/OpenCapBench
// ============================================================
// モデル出力順 (config id2label に準拠)
// index 0-16: COCO 17点, index 17-51: SynthPose固有マーカー
const KEYPOINT_NAMES_SYNTHPOSE = [
  // COCO 17 (0-16)
  'Nose', 'L_Eye', 'R_Eye', 'L_Ear', 'R_Ear',
  'L_Shoulder', 'R_Shoulder', 'L_Elbow', 'R_Elbow', 'L_Wrist', 'R_Wrist',
  'L_Hip', 'R_Hip', 'L_Knee', 'R_Knee', 'L_Ankle', 'R_Ankle',
  // SynthPose固有 (17-51)
  'sternum', 'rshoulder', 'lshoulder',
  'r_lelbow', 'l_lelbow', 'r_melbow', 'l_melbow',
  'r_lwrist', 'l_lwrist', 'r_mwrist', 'l_mwrist',
  'r_ASIS', 'l_ASIS', 'r_PSIS', 'l_PSIS',
  'r_knee', 'l_knee', 'r_mknee', 'l_mknee',
  'r_ankle', 'l_ankle', 'r_mankle', 'l_mankle',
  'r_5meta', 'l_5meta', 'r_toe', 'l_toe', 'r_big_toe', 'l_big_toe', 'l_calc', 'r_calc',
  'C7', 'L2', 'T11', 'T6',
];

const KEYPOINT_NAMES_SYNTHPOSE_JP = [
  // COCO 17 (0-16)
  '鼻', '左目', '右目', '左耳', '右耳',
  '左肩(COCO)', '右肩(COCO)', '左肘(COCO)', '右肘(COCO)', '左手首(COCO)', '右手首(COCO)',
  '左股関節(COCO)', '右股関節(COCO)', '左膝(COCO)', '右膝(COCO)', '左足首(COCO)', '右足首(COCO)',
  // SynthPose固有 (17-51)
  '胸骨柄', '右肩', '左肩',
  '右外側肘', '左外側肘', '右内側肘', '左内側肘',
  '右外側手首', '左外側手首', '右内側手首', '左内側手首',
  '右ASIS', '左ASIS', '右PSIS', '左PSIS',
  '右外側膝', '左外側膝', '右内側膝', '左内側膝',
  '右外側足首', '左外側足首', '右内側足首', '左内側足首',
  '右第5中足骨', '左第5中足骨', '右つま先', '左つま先', '右母趾', '左母趾', '左踵骨', '右踵骨',
  'C7', 'L2', 'T11', 'T6',
];

// 公式エッジ (config "edges") + SynthPoseバイオメカニクスマーカー接続
const SKELETON_CONNECTIONS_SYNTHPOSE = [
  // === 公式エッジ (edges from model config) ===
  // 頭部
  ['Nose', 'L_Eye'], ['Nose', 'R_Eye'],
  ['L_Eye', 'R_Eye'], ['L_Eye', 'L_Ear'], ['R_Eye', 'R_Ear'],
  ['L_Ear', 'L_Shoulder'], ['R_Ear', 'R_Shoulder'],
  // 体幹
  ['L_Shoulder', 'R_Shoulder'],
  ['L_Shoulder', 'L_Hip'], ['R_Shoulder', 'R_Hip'],
  ['L_Hip', 'R_Hip'],
  // 右腕 (COCO)
  ['R_Shoulder', 'R_Elbow'], ['R_Elbow', 'R_Wrist'],
  // 左腕 (COCO)
  ['L_Shoulder', 'L_Elbow'], ['L_Elbow', 'L_Wrist'],
  // 右脚 (COCO)
  ['R_Hip', 'R_Knee'], ['R_Knee', 'R_Ankle'],
  // 左脚 (COCO)
  ['L_Hip', 'L_Knee'], ['L_Knee', 'L_Ankle'],
  // === SynthPose バイオメカニクスマーカー ===
  // 肩帯・鎖骨
  ['rshoulder', 'lshoulder'],
  ['rshoulder', 'sternum'], ['lshoulder', 'sternum'],
  // 頸椎（肩→C7）
  ['rshoulder', 'C7'], ['lshoulder', 'C7'],
  // 脊椎チェーン
  ['C7', 'T6'], ['T6', 'T11'], ['T11', 'L2'],
  // 骨盤
  ['r_ASIS', 'l_ASIS'],
  ['L2', 'r_ASIS'], ['L2', 'l_ASIS'],
  // 右腕 (SynthPose)
  ['rshoulder', 'r_lelbow'], ['r_lelbow', 'r_lwrist'],
  // 左腕 (SynthPose)
  ['lshoulder', 'l_lelbow'], ['l_lelbow', 'l_lwrist'],
  // 右脚 (SynthPose)
  ['r_ASIS', 'r_knee'], ['r_knee', 'r_ankle'],
  ['r_ankle', 'r_big_toe'], ['r_ankle', 'r_5meta'], ['r_ankle', 'r_calc'],
  // 左脚 (SynthPose)
  ['l_ASIS', 'l_knee'], ['l_knee', 'l_ankle'],
  ['l_ankle', 'l_big_toe'], ['l_ankle', 'l_5meta'], ['l_ankle', 'l_calc'],
];

// 日本語キーポイント名（表示用）
const KEYPOINT_NAMES_JP = [
  '右手先', '右手首', '右肘', '右肩',
  '左手先', '左手首', '左肘', '左肩',
  '右足先', '右小指', '右踵', '右足首', '右膝', '右股関節',
  '左足先', '左小指', '左踵', '左足首', '左膝', '左股関節',
  '頭頂', '耳珠点', '胸骨上切痕'
];

// 骨格接続定義（ViTPose COCO スタイルに準拠）
const SKELETON_CONNECTIONS = [
  // 右上肢
  ['right_hand_tip', 'right_wrist'], ['right_wrist', 'right_elbow'], ['right_elbow', 'right_shoulder'],
  // 左上肢
  ['left_hand_tip', 'left_wrist'], ['left_wrist', 'left_elbow'], ['left_elbow', 'left_shoulder'],
  // 右下肢
  ['right_toe_tip', 'right_ankle'], ['right_ankle', 'right_heel'], ['right_ankle', 'right_knee'], ['right_knee', 'right_hip'],
  // 左下肢
  ['left_toe_tip', 'left_ankle'], ['left_ankle', 'left_heel'], ['left_ankle', 'left_knee'], ['left_knee', 'left_hip'],
  // 体幹
  ['right_shoulder', 'left_shoulder'], ['right_hip', 'left_hip'],
  ['right_shoulder', 'right_hip'], ['left_shoulder', 'left_hip'],
  // 頭部チェーン（体幹とは接続しない）
  ['head_top', 'tragus_point'], ['tragus_point', 'suprasternal_notch'],
];

// ===================================
// 25点形式（阿江モデル対応）
// ===================================

// プリセット設定: preset value → { model, yolo, outputFormat }
// YOLO26m: mAP=53.4, CPU 97ms / RTMPose-M: CoreML 3ms / RTMPose-X: CoreML 10ms
const PRESET_CONFIG = {
  'fast':      { model: 'rtmpose-m',         yolo: 'yolo26m.onnx', outputFormat: '23pts' },
  'hq':        { model: 'rtmpose-x',         yolo: 'yolo26m.onnx', outputFormat: '23pts' },
  'synthpose': { model: 'synthpose-huge-onnx', yolo: 'yolo26m.onnx', outputFormat: 'synthpose' },
};

// ---- アクティブ形式ヘルパー（state.outputFormat を参照） ----
function getActiveKeypointNames() {
  const fmt = typeof state !== 'undefined' ? state.outputFormat : '23pts';
  if (fmt === 'synthpose') return KEYPOINT_NAMES_SYNTHPOSE;
  return KEYPOINT_NAMES;
}
function getActiveKeypointNamesJP() {
  const fmt = typeof state !== 'undefined' ? state.outputFormat : '23pts';
  if (fmt === 'synthpose') return KEYPOINT_NAMES_SYNTHPOSE_JP;
  return KEYPOINT_NAMES_JP;
}
function getActiveSkeletonConnections() {
  const fmt = typeof state !== 'undefined' ? state.outputFormat : '23pts';
  if (fmt === 'synthpose') return SKELETON_CONNECTIONS_SYNTHPOSE;
  return SKELETON_CONNECTIONS;
}

// 色定義
const COLORS = {
  right: '#EF4444',
  left: '#3B82F6',
  center: '#10B981'
};

// グラフ用の色（X座標とY座標）
const GRAPH_COLORS = {
  x: '#3b82f6',  // 青
  y: '#22c55e'   // 緑
};

const PERSON_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
];

// ===================================
// State
// ===================================
let state = {
  serverStatus: null,
  modelLoading: false,       // モデルロード中フラグ
  modelLoadingProgress: 0,   // モデルロード進捗 (0-100)
  modelLoadingMessage: '',   // モデルロードメッセージ
  loadedModels: null,        // ロード済みモデル情報
  currentDevice: null,       // 現在のデバイス (cuda, cpu)
  selectedFile: null,
  fileType: null,
  previewUrl: null,
  isProcessing: false,
  result: null,
  videoResult: null,
  filteredResult: null,  // フィルタ適用後のデータ
  currentFrame: 1,
  isPlaying: false,
  playbackSpeed: 1,
  playInterval: null,
  playbackAnimationId: null, // requestAnimationFrame ID
  frameCache: [],      // フレーム画像のキャッシュ
  isCaching: false,    // キャッシュ中フラグ
  viewMode: 'video',   // 'video' | 'skeleton' | 'graph'
  showSkeleton: true,  // 動画モードでスケルトンを表示するかどうか
  outputFormat: '23pts', // '23pts' | 'synthpose' — 出力キーポイント形式
  graphMode: 'list',   // 'list' | 'detail'
  selectedKeypoint: null, // 詳細表示中のキーポイント
  editHistory: [],     // 編集履歴
  redoHistory: [],     // やり直し履歴
  isEditing: false,    // 編集モード
  graphDragging: false, // グラフドラッグ中
  modelInfoInitialized: false, // モデル情報初期化完了フラグ
  skeletonZoom: 1.5,   // スケルトンプレビューのズーム倍率（初期値）
  skeletonPanX: 0,     // スケルトンプレビューのパンX
  skeletonPanY: 0,     // スケルトンプレビューのパンY
  usedModels: {        // 推定に使用したモデル情報
    yolo: null,
    pose: null
  },
  isSkeletonDragging: false, // スケルトンドラッグ中
  skeletonDragStartX: 0,
  skeletonDragStartY: 0,
  skeletonPreviewCentered: false, // スケルトンプレビュー初期センタリング済みフラグ
  resizing: false,     // リサイズ中
  graphYRangeX: null,  // X座標グラフのY軸範囲 {min, max}
  graphYRangeY: null,  // Y座標グラフのY軸範囲 {min, max}
  graphXRangeX: null,  // X座標グラフのX軸範囲 {min, max}
  graphXRangeY: null,  // Y座標グラフのX軸範囲 {min, max}
  graphPanning: false, // パンニング中
  graphPanningCanvas: null, // パンニングを開始したグラフ
  graphPanStartX: 0,   // パン開始時のマウスX座標
  graphPanStartY: 0,   // パン開始時のマウスY座標
  graphPanStartFrame: 0, // パン開始時のフレーム位置
  graphPanStartYValueX: 0, // パン開始時のX座標グラフのY軸値
  graphPanStartYValueY: 0,  // パン開始時のY座標グラフのY軸値
  graphContextTarget: null, // 右クリックコンテキストメニューのターゲット {personId, keypointIdx, frame}
  graphPanDidMove: false,   // 右クリックパン操作中に移動が発生したか
  // フレームスライダー最適化用
  sliderDebounceTimer: null, // デバウンスタイマー
  pendingFrame: null,        // 描画待ちフレーム番号
  lastDrawnFrame: null,      // 最後に描画したフレーム番号
  isSliderDragging: false,   // スライダードラッグ中
  showPreviewVideo: false,   // スケルトンプレビューに動画画像を表示
  currentProjectPath: null,  // 現在のプロジェクトファイルパス（上書き保存用）
  // 手動デジタイズ用
  digitizeMode: true,        // デジタイズモードON/OFF（デフォルトON）
  digitizeType: 'frame',     // 'frame': フレームデジタイズ, 'move': ポイント移動
  digitizeDragging: false,   // キーポイントドラッグ中
  digitizeTarget: null,      // ドラッグ中のターゲット {personId, keypointIdx}
  digitizeStartX: 0,         // ドラッグ開始時のマウスX
  digitizeStartY: 0,         // ドラッグ開始時のマウスY
  digitizePersonId: null,    // フレームデジタイズ対象人物ID
  digitizeKeypointIdx: null, // フレームデジタイズ対象キーポイントインデックス
  // 動画ビューのズーム・パン
  videoZoom: 1.0,            // 動画表示のズーム倍率
  videoPanX: 0,              // 動画表示のパンX
  videoPanY: 0,              // 動画表示のパンY
  videoPanning: false,       // パンニング中
  videoPanStartX: 0,         // パン開始時のマウスX
  videoPanStartY: 0,         // パン開始時のマウスY
  videoZoomInitialized: false, // 動画ズーム初期化済みフラグ

  // スケルトンレンダラー
  skeletonRenderer: null,
  skeletonPreviewRenderer: null,
  // ポイント描画設定
  pointSize: 5,              // ポイントサイズ（2-12）
  lineWidth: 2,              // 線の太さ (1-10)
  pointAlpha: 0.7,           // ポイント透過度（0.0-1.0）

  // セッション開始時のベースラインデータ（編集リセット用）
  // ポーズ推定完了時またはプロジェクト読み込み時に保存される
  sessionBaselineData: null,

  // 抽出フレーム用
  extractedFramesDir: null,   // フレーム画像が保存されたディレクトリパス
  frameImageCache: {},        // 読み込んだフレーム画像のキャッシュ
  isExtractingFrames: false,  // フレーム抽出中フラグ

  // バッチ処理用
  batchFiles: [],              // バッチ処理対象ファイルリスト
  batchProcessing: false,      // バッチ処理中フラグ
  batchCurrentIndex: 0,        // 現在処理中のファイルインデックス
  batchResults: [],            // バッチ処理結果
  batchCancelled: false,       // バッチ処理キャンセルフラグ
  batchTotalFrames: 0,         // 全ファイルの累計フレーム数
  batchProcessedFrames: 0,     // 処理済みフレーム数（累計）
  batchPreviousFilesFrames: 0, // 前のファイルまでの累計フレーム数
};

// 動画シーク完了待ちハンドラ（最新の1つだけ保持）
let pendingSeekedHandler = null;

// 状態を完全リセット（アプリ新規起動と同等の状態に）
function resetState() {
  console.log('[resetState] 状態をリセット');

  // 再生を停止
  if (state.playInterval) {
    clearInterval(state.playInterval);
    state.playInterval = null;
  }
  if (state.playbackAnimationId) {
    cancelAnimationFrame(state.playbackAnimationId);
    state.playbackAnimationId = null;
  }

  // 状態をクリア
  state.selectedFile = null;
  state.previewUrl = null;
  state.fileType = null;
  state.result = null;
  state.videoResult = null;
  state.filteredResult = null;
  state.exported = false;
  state.currentFrame = 1;
  state.isPlaying = false;
  state.isProcessing = false;
  state.viewMode = 'video';
  state.graphMode = 'list';
  state.editHistory = [];
  state.redoHistory = [];
  state.isEditing = false;
  state.graphYRangeX = null;
  state.graphYRangeY = null;
  state.graphXRangeX = null;
  state.graphXRangeY = null;
  state.currentProjectPath = null;
  state.selectedKeypoint = null;
  state.skeletonPreviewCentered = false;
  state.sessionBaselineData = null;  // セッションベースラインもクリア

  // スケルトンビューのリセット
  state.skeletonZoom = 1.5;
  state.skeletonPanX = 0;
  state.skeletonPanY = 0;
  state.showSkeleton = true; // スケルトン表示を強制ON
  if (elements.showSkeletonCheckbox) {
    elements.showSkeletonCheckbox.checked = true;
  }


  // 動画ビューのリセット
  state.videoZoom = 1.0;
  state.videoPanX = 0;
  state.videoPanY = 0;
  state.videoZoomInitialized = false;

  // フレームキャッシュをクリア
  if (state.frameCache) {
    state.frameCache = {};
  }

  // UIをリセット
  if (elements.previewVideo) {
    elements.previewVideo.src = '';
    elements.previewVideo.load();
  }
  if (elements.previewImage) {
    elements.previewImage.src = '';
  }
  if (elements.placeholder) {
    elements.placeholder.style.display = 'block';
  }
  if (elements.previewContainer) {
    elements.previewContainer.style.display = 'none';
  }
  if (elements.runButton) {
    elements.runButton.style.display = 'block';
    elements.runButton.disabled = false;
  }
  if (elements.fileInfo) {
    elements.fileInfo.style.display = 'none';
  }
  if (elements.undoEdit) {
    elements.undoEdit.disabled = true;
  }
  if (elements.graphEditMode) {
    elements.graphEditMode.textContent = '編集モード: OFF';
    elements.graphEditMode.classList.remove('active');
  }
  updateStepGuide();
}

// プロジェクトを閉じる（起動直後の状態に完全リセット）
async function closeProject() {
  // データがある場合は保存確認ダイアログを表示
  if (state.videoResult || state.result) {
    const confirmed = await showCloseConfirmDialog();
    if (confirmed === 'cancel') {
      return; // キャンセル
    }
    if (confirmed === 'save') {
      await saveProject();
    }
    // 'discard' の場合はそのまま閉じる
  }

  doCloseProject();
}

// 閉じる確認ダイアログを表示
async function showCloseConfirmDialog(message = 'プロジェクトを保存しますか？') {
  // OS ネイティブダイアログ（main プロセス経由）
  return await window.electronAPI.showSaveConfirm(message);
}

// 実際にプロジェクトを閉じる処理
function doCloseProject() {
  console.log('[closeProject] プロジェクトを閉じます');

  // 再生を停止
  if (state.playInterval) {
    clearInterval(state.playInterval);
    state.playInterval = null;
  }
  if (state.playbackAnimationId) {
    cancelAnimationFrame(state.playbackAnimationId);
    state.playbackAnimationId = null;
  }

  // 全ての状態をクリア
  state.selectedFile = null;
  state.previewUrl = null;
  state.fileType = null;
  state.result = null;
  state.videoResult = null;
  state.filteredResult = null;
  state.currentFrame = 1;
  state.isPlaying = false;
  state.isProcessing = false;
  state.viewMode = 'video';
  state.graphMode = 'list';
  state.editHistory = [];
  state.redoHistory = [];
  state.isEditing = false;
  state.graphYRangeX = null;
  state.graphYRangeY = null;
  state.graphXRangeX = null;
  state.graphXRangeY = null;
  state.currentProjectPath = null;
  state.selectedKeypoint = null;
  state.skeletonPreviewCentered = false;
  state.sessionBaselineData = null;
  state.extractedFramesDir = null;
  state.frameImageCache = {};
  state.isExtractingFrames = false;

  // スケルトンビューのリセット
  state.skeletonZoom = 1.5;
  state.skeletonPanX = 0;
  state.skeletonPanY = 0;
  state.showSkeleton = true; // スケルトン表示を強制ON
  if (elements.showSkeletonCheckbox) {
    elements.showSkeletonCheckbox.checked = true;
  }


  // 動画ビューのリセット
  state.videoZoom = 1.0;
  state.videoPanX = 0;
  state.videoPanY = 0;
  state.videoZoomInitialized = false;

  // フレームキャッシュをクリア
  state.frameCache = {};

  // UIを起動直後の状態にリセット
  if (elements.previewVideo) {
    elements.previewVideo.src = '';
    elements.previewVideo.load();
  }
  if (elements.previewImage) {
    elements.previewImage.src = '';
  }
  if (elements.placeholder) {
    elements.placeholder.style.display = 'block';
  }
  if (elements.previewContainer) {
    elements.previewContainer.style.display = 'none';
  }
  if (elements.runButton) {
    elements.runButton.style.display = 'block';
    elements.runButton.disabled = false;
  }
  if (elements.fileInfo) {
    elements.fileInfo.style.display = 'none';
  }
  // ドロップゾーンを再表示
  if (elements.dropZone) {
    elements.dropZone.style.display = 'block';
  }

  // 各種パネルを非表示
  if (elements.filterPanel) {
    elements.filterPanel.style.display = 'none';
  }
  if (elements.viewModePanel) {
    elements.viewModePanel.style.display = 'none';
  }
  if (elements.cleansingPanel) {
    elements.cleansingPanel.style.display = 'none';
  }
  if (elements.exportPanel) {
    elements.exportPanel.style.display = 'none';
  }
  // 動画/骨格モード用ツールバーも非表示
  const videoEditToolbar = document.getElementById('videoEditToolbar');
  if (videoEditToolbar) videoEditToolbar.style.display = 'none';
  if (elements.playbackFooter) {
    elements.playbackFooter.style.display = 'none';
  }
  if (elements.progressPanel) {
    elements.progressPanel.style.display = 'none';
  }

  // グラフ関連
  if (elements.graphContainer) {
    elements.graphContainer.style.display = 'none';
  }
  if (elements.skeletonPreview) {
    elements.skeletonPreview.style.display = 'none';
  }

  // キャッシュ進捗を非表示
  if (elements.cacheProgressContainer) {
    elements.cacheProgressContainer.style.display = 'none';
    if (elements.cacheLabel) {
      elements.cacheLabel.textContent = 'キャッシュ中...';
      elements.cacheLabel.classList.remove('complete');
    }
    if (elements.cacheProgressFill) {
      elements.cacheProgressFill.style.width = '0%';
      elements.cacheProgressFill.classList.remove('complete');
    }
    if (elements.cachePercent) {
      elements.cachePercent.textContent = '0%';
      elements.cachePercent.classList.remove('complete');
    }
  }

  // 編集UI
  if (elements.undoEdit) {
    elements.undoEdit.disabled = true;
  }
  if (elements.redoEdit) {
    elements.redoEdit.disabled = true;
  }
  if (elements.graphEditMode) {
    elements.graphEditMode.textContent = '編集モード: OFF';
    elements.graphEditMode.classList.remove('active');
  }

  // キャンバスをクリア
  if (elements.resultCanvas) {
    const ctx = elements.resultCanvas.getContext('2d');
    ctx.clearRect(0, 0, elements.resultCanvas.width, elements.resultCanvas.height);
  }
  if (elements.skeletonOverlayCanvas) {
    // OffscreenCanvasの場合はgetContextできないためスキップ（必要ならRenderer経由でクリア）
    if (!elements.skeletonOverlayCanvas._offscreenTransferred) {
      try {
        const ctx = elements.skeletonOverlayCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, elements.skeletonOverlayCanvas.width, elements.skeletonOverlayCanvas.height);
      } catch (e) {
        console.warn('Failed to clear skeletonOverlayCanvas:', e);
      }
    } else if (state.skeletonRenderer && typeof state.skeletonRenderer.clear === 'function') {
      state.skeletonRenderer.clear();
    }
  }
  if (elements.skeletonCanvas) {
    try {
      const ctx = elements.skeletonCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, elements.skeletonCanvas.width, elements.skeletonCanvas.height);
    } catch (e) {
      console.warn('Failed to clear skeletonCanvas:', e);
    }
  }
  if (elements.skeletonPreviewCanvas) {
    if (!elements.skeletonPreviewCanvas._offscreenTransferred) {
      try {
        const ctx = elements.skeletonPreviewCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, elements.skeletonPreviewCanvas.width, elements.skeletonPreviewCanvas.height);
      } catch (e) {
        console.warn('Failed to clear skeletonPreviewCanvas:', e);
      }
    } else if (state.skeletonPreviewRenderer && typeof state.skeletonPreviewRenderer.clear === 'function') {
      state.skeletonPreviewRenderer.clear();
    }
  }

  // エラーパネルを非表示
  hideError();

  console.log('[doCloseProject] プロジェクトを閉じました');
}

function resetPreviewView() {
  // 現在のフレームのバウンディングボックスの中心にリセット
  const data = getCurrentData();
  if (data && data.frames) {
    const frameData = data.frames.find(f => f.frame === state.currentFrame);
    if (frameData && frameData.keypoints) {
      // 全キーポイントからバウンディングボックスを計算
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let hasValidPoints = false;

      // 選択されている人物があればその人物のみ、なければ全員
      const selectedPersonId = elements.graphPerson?.value || elements.cleansingTargetPerson?.value;
      const targetKeypoints = selectedPersonId && frameData.keypoints[selectedPersonId]
        ? { [selectedPersonId]: frameData.keypoints[selectedPersonId] }
        : frameData.keypoints;

      Object.values(targetKeypoints).forEach(kpts => {
        kpts.forEach(kp => {
          if (kp && kp[2] > 0.3) {
            minX = Math.min(minX, kp[0]);
            maxX = Math.max(maxX, kp[0]);
            minY = Math.min(minY, kp[1]);
            maxY = Math.max(maxY, kp[1]);
            hasValidPoints = true;
          }
        });
      });

      if (hasValidPoints) {
        // バウンディングボックスの中心を計算
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const bboxWidth = maxX - minX;
        const bboxHeight = maxY - minY;

        // キャンバスサイズを取得（Wrapperから取得するのが確実）
        const wrapper = elements.skeletonPreviewWrapper;
        const canvasWidth = wrapper.clientWidth || elements.skeletonPreviewCanvas.width;
        const canvasHeight = wrapper.clientHeight || elements.skeletonPreviewCanvas.height;

        if (!canvasWidth || !canvasHeight) return; // サイズがない場合は計算しない

        // バウンディングボックスがウインドウに収まるようにズームを計算
        const margin = 50;
        const zoomX = (canvasWidth - margin * 2) / bboxWidth;
        const zoomY = (canvasHeight - margin * 2) / bboxHeight;
        state.skeletonZoom = Math.min(zoomX, zoomY, 3.0);
        state.skeletonZoom = Math.max(state.skeletonZoom, 0.5);

        // 中心が画面の中央に来るようにパン位置を計算
        state.skeletonPanX = canvasWidth / 2 - centerX * state.skeletonZoom;
        state.skeletonPanY = canvasHeight / 2 - centerY * state.skeletonZoom;
      }
    }
  } else {
    // データがない場合はデフォルトにリセット
    state.skeletonZoom = 1.5;
    state.skeletonPanX = 0;
    state.skeletonPanY = 0;
  }
  state.skeletonPreviewCentered = true;
  drawSkeletonPreview();
}

// スライダーデバウンス関数（高速操作時の描画を間引く）
function debouncedGoToFrame(frame) {
  state.pendingFrame = frame;

  // デバウンス: 既存のタイマーをクリア
  if (state.sliderDebounceTimer) {
    clearTimeout(state.sliderDebounceTimer);
  }

  // 抽出フレーム済みorキャッシュがある場合は即座に描画
  if (state.extractedFramesDir || state.frameCache[frame] || state.frameImageCache[frame]) {
    goToFrame(frame);
    return;
  }

  // キャッシュがない場合はデバウンス（16ms ≒ 60fps）
  state.sliderDebounceTimer = setTimeout(() => {
    state.sliderDebounceTimer = null;
    if (state.pendingFrame !== null) {
      goToFrame(state.pendingFrame);
      state.pendingFrame = null;
    }
  }, 16);
}

// ===================================
// DOM Elements
// ===================================
const elements = {};

function initElements() {
  elements.statusIndicator = document.getElementById('statusIndicator');
  elements.statusText = document.getElementById('statusText');
  elements.dropZone = document.getElementById('dropZone');
  elements.fileInfo = document.getElementById('fileInfo');
  elements.fileName = document.getElementById('fileName');
  elements.fileType = document.getElementById('fileType');
  elements.runButton = document.getElementById('runButton');
  elements.estimationModePanel = document.getElementById('estimationModePanel');
  elements.estimationMode = document.getElementById('estimationMode');
  elements.outputFormatSelect = document.getElementById('outputFormatSelect');
  elements.presetSelect = document.getElementById('presetSelect');
  elements.videoInfoPanel = document.getElementById('videoInfoPanel');
  elements.cameraType = document.getElementById('cameraType');
  elements.videoFps = document.getElementById('videoFps');
  elements.progressPanel = document.getElementById('progressPanel');
  elements.progressFill = document.getElementById('progressFill');
  elements.progressText = document.getElementById('progressText');
  elements.errorPanel = document.getElementById('errorPanel');
  elements.errorText = document.getElementById('errorText');
  elements.exportPanel = document.getElementById('exportPanel');
  elements.personSelect = document.getElementById('personSelect');
  elements.exportCSV = document.getElementById('exportCSV');
  elements.exportJSON = document.getElementById('exportJSON');
  elements.exportDataset = document.getElementById('exportDataset');
  elements.exportVideo = document.getElementById('exportVideo');
  elements.playbackFooter = document.getElementById('playbackFooter');
  elements.btnFirst = document.getElementById('btnFirst');
  elements.btnPrev = document.getElementById('btnPrev');
  elements.btnPlay = document.getElementById('btnPlay');
  elements.btnNext = document.getElementById('btnNext');
  elements.btnLast = document.getElementById('btnLast');
  elements.frameSlider = document.getElementById('frameSlider');
  elements.frameInfo = document.getElementById('frameInfo');
  elements.timeInfo = document.getElementById('timeInfo');
  elements.videoFps = document.getElementById('videoFps');
  elements.speedSelect = document.getElementById('speedSelect');
  elements.placeholder = document.getElementById('placeholder');
  elements.previewContainer = document.getElementById('previewContainer');
  elements.previewImage = document.getElementById('previewImage');
  elements.previewVideo = document.getElementById('previewVideo');
  elements.resultCanvas = document.getElementById('resultCanvas');
  elements.skeletonOverlayCanvas = document.getElementById('skeletonOverlayCanvas');
  elements.skeletonCanvas = document.getElementById('skeletonCanvas');
  elements.videoZoomReset = document.getElementById('videoZoomReset');

  // フィルタリング
  elements.filterPanel = document.getElementById('filterPanel');
  elements.enableOutlier = document.getElementById('enableOutlier');
  elements.enableInterpolation = document.getElementById('enableInterpolation');
  elements.enableButterworth = document.getElementById('enableButterworth');
  elements.enableKalman = document.getElementById('enableKalman');
  elements.applyFilter = document.getElementById('applyFilter');
  elements.manualIdSwap = document.getElementById('manualIdSwap');
  elements.autoFixLimbSwaps = document.getElementById('autoFixLimbSwaps');
  elements.swapLegs = document.getElementById('swapLegs');
  elements.swapArms = document.getElementById('swapArms');

  // データクレンジング
  elements.cleansingPanel = document.getElementById('cleansingPanel');
  elements.cleansingTargetPerson = document.getElementById('cleansingTargetPerson');
  elements.swapPersonB = document.getElementById('swapPersonB');

  // 一括削除モーダル
  elements.bulkDeletePersonsBtn = document.getElementById('bulkDeletePersonsBtn');
  elements.bulkDeleteModal = document.getElementById('bulkDeleteModal');
  elements.bulkDeletePersonList = document.getElementById('bulkDeletePersonList');
  elements.bulkDeleteSelectAll = document.getElementById('bulkDeleteSelectAll');
  elements.bulkDeleteDeselectAll = document.getElementById('bulkDeleteDeselectAll');
  elements.closeBulkDeleteBtn = document.getElementById('closeBulkDeleteBtn');
  elements.cancelBulkDeleteBtn = document.getElementById('cancelBulkDeleteBtn');
  elements.confirmBulkDeleteBtn = document.getElementById('confirmBulkDeleteBtn');

  // 表示モード
  elements.viewModePanel = document.getElementById('viewModePanel');
  elements.viewVideo = document.getElementById('viewVideo');
  elements.viewSkeleton = document.getElementById('viewSkeleton');
  elements.viewGraph = document.getElementById('viewGraph');
  elements.showSkeletonCheckbox = document.getElementById('showSkeletonCheckbox');
  elements.pointSizeSlider = document.getElementById('pointSizeSlider');
  elements.pointSizeValue = document.getElementById('pointSizeValue');
  elements.lineWidthSlider = document.getElementById('lineWidthSlider');
  elements.lineWidthValue = document.getElementById('lineWidthValue');
  elements.pointAlphaSlider = document.getElementById('pointAlphaSlider');
  elements.pointAlphaValue = document.getElementById('pointAlphaValue');
  elements.enableDigitize = document.getElementById('enableDigitize');
  elements.digitizeOptions = document.getElementById('digitizeOptions');
  elements.digitizeMode = document.getElementById('digitizeMode');
  elements.frameDigitizeOptions = document.getElementById('frameDigitizeOptions');
  elements.digitizeKeypoint = document.getElementById('digitizeKeypoint');

  // グラフ
  elements.graphContainer = document.getElementById('graphContainer');
  elements.graphModeList = document.getElementById('graphModeList');
  elements.graphModeDetail = document.getElementById('graphModeDetail');
  elements.graphPerson = document.getElementById('graphPerson');
  elements.graphKeypoint = document.getElementById('graphKeypoint');
  elements.graphDetailControls = document.getElementById('graphDetailControls');
  elements.graphListView = document.getElementById('graphListView');
  elements.graphDetailView = document.getElementById('graphDetailView');
  elements.graphDetailTitle = document.getElementById('graphDetailTitle');
  elements.backToList = document.getElementById('backToList');
  elements.graphCanvasX = document.getElementById('graphCanvasX');
  elements.graphCanvasY = document.getElementById('graphCanvasY');
  elements.graphContextMenu = document.getElementById('graphContextMenu');
  elements.graphContextMenuDelete = document.getElementById('graphContextMenuDelete');
  elements.graphFrameInfo = document.getElementById('graphFrameInfo');
  elements.graphValueInfo = document.getElementById('graphValueInfo');
  elements.graphEditMode = document.getElementById('graphEditMode');
  elements.undoEdit = document.getElementById('undoEdit');
  elements.redoEdit = document.getElementById('redoEdit');
  elements.resetEdit = document.getElementById('resetEdit');
  elements.deleteBefore = document.getElementById('deleteBefore');
  elements.deleteAfter = document.getElementById('deleteAfter');
  elements.deleteFrameData = document.getElementById('deleteFrameData');
  // bulkDeletePersonsBtn はグラフパネルのボタン（一括削除）

  // スケルトンプレビュー
  elements.skeletonPreview = document.getElementById('skeletonPreview');
  elements.skeletonPreviewCanvas = document.getElementById('skeletonPreviewCanvas');
  elements.skeletonPreviewWrapper = document.getElementById('skeletonPreviewWrapper');
  elements.zoomIn = document.getElementById('zoomIn');
  elements.zoomOut = document.getElementById('zoomOut');
  elements.zoomReset = document.getElementById('zoomReset');
  elements.alwaysCenter = document.getElementById('alwaysCenter');

  // リサイザー
  elements.graphResizer = document.getElementById('graphResizeHandle');

  // キャッシュ進捗
  elements.cacheProgressContainer = document.getElementById('cacheProgressContainer');
  elements.cacheLabel = document.getElementById('cacheLabel');
  elements.cacheProgressFill = document.getElementById('cacheProgressFill');
  elements.cachePercent = document.getElementById('cachePercent');

  // サイドバートグル
  elements.toggleSidebar = document.getElementById('toggleSidebar');
  elements.sidebar = document.getElementById('sidebar');
  elements.reselectVideoButton = document.getElementById('reselectVideoButton');

  // 設定モーダル
  elements.settingsModal = document.getElementById('settingsModal');
  elements.closeSettingsBtn = document.getElementById('closeSettingsBtn');
  elements.cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
  elements.saveSettingsBtn = document.getElementById('saveSettingsBtn');
  elements.yoloSizeSelect = document.getElementById('yoloSizeSelect');
  elements.confThresholdSlider = document.getElementById('confThresholdSlider');
  elements.confThresholdValue = document.getElementById('confThresholdValue');
  elements.nmsThresholdSlider = document.getElementById('nmsThresholdSlider');
  elements.nmsThresholdValue = document.getElementById('nmsThresholdValue');
}

// ポイント設定スライダーのイベントハンドラを設定
function initPointSettingsSliders() {
  // ... existing code ...
  // ポイントサイズスライダー
  if (elements.pointSizeSlider) {
    elements.pointSizeSlider.addEventListener('input', (e) => {
      state.pointSize = parseInt(e.target.value);
      if (elements.pointSizeValue) {
        elements.pointSizeValue.textContent = state.pointSize;
      }
      // 描画を更新
      if (state.viewMode === 'graph') {
        requestAnimationFrame(() => drawSkeletonPreview());
      } else if (state.viewMode === 'video' || state.viewMode === 'skeleton') {
        requestAnimationFrame(() => drawVideoFrame());
      }
    });
  }

  // 線の太さスライダー
  if (elements.lineWidthSlider) {
    elements.lineWidthSlider.addEventListener('input', (e) => {
      state.lineWidth = parseInt(e.target.value);
      if (elements.lineWidthValue) {
        elements.lineWidthValue.textContent = state.lineWidth;
      }
      // 描画を更新
      if (state.viewMode === 'graph') {
        requestAnimationFrame(() => drawSkeletonPreview());
      } else if (state.viewMode === 'video' || state.viewMode === 'skeleton') {
        requestAnimationFrame(() => drawVideoFrame());
      }
    });
  }

  // ポイント透過度スライダー
  if (elements.pointAlphaSlider) {
    elements.pointAlphaSlider.addEventListener('input', (e) => {
      state.pointAlpha = parseFloat(e.target.value);
      if (elements.pointAlphaValue) {
        elements.pointAlphaValue.textContent = state.pointAlpha.toFixed(1);
      }
      // 描画を更新
      if (state.viewMode === 'graph') {
        requestAnimationFrame(() => drawSkeletonPreview());
      } else if (state.viewMode === 'video' || state.viewMode === 'skeleton') {
        requestAnimationFrame(() => drawVideoFrame());
      }
    });
  }
}

// 設定モーダルのイベントハンドラを設定
function initSettingsModalEvents() {
  if (elements.closeSettingsBtn) elements.closeSettingsBtn.addEventListener('click', closeSettingsModal);
  if (elements.cancelSettingsBtn) elements.cancelSettingsBtn.addEventListener('click', closeSettingsModal);
  if (elements.saveSettingsBtn) elements.saveSettingsBtn.addEventListener('click', saveSettings);

  // スライダーの値表示更新
  if (elements.confThresholdSlider) {
    elements.confThresholdSlider.addEventListener('input', (e) => {
      elements.confThresholdValue.textContent = parseFloat(e.target.value).toFixed(2);
    });
  }
  if (elements.nmsThresholdSlider) {
    elements.nmsThresholdSlider.addEventListener('input', (e) => {
      elements.nmsThresholdValue.textContent = parseFloat(e.target.value).toFixed(2);
    });
  }

  // IPCハンドラ (メニューから設定を開く)
  if (window.electronAPI && window.electronAPI.onMenuOpenSettings) {
    window.electronAPI.onMenuOpenSettings(() => {
      openSettingsModal();
    });
  }
}

async function openSettingsModal() {
  if (!window.electronAPI) return;

  // Ensure elements are available
  if (!elements.settingsModal) {
    elements.settingsModal = document.getElementById('settingsModal');
    elements.saveSettingsBtn = document.getElementById('saveSettingsBtn');
    // Ensure inputs are also available if needed
    if (!elements.yoloSizeSelect) elements.yoloSizeSelect = document.getElementById('yoloSizeSelect');
    if (!elements.confThresholdSlider) elements.confThresholdSlider = document.getElementById('confThresholdSlider');
    if (!elements.confThresholdValue) elements.confThresholdValue = document.getElementById('confThresholdValue');
    if (!elements.nmsThresholdSlider) elements.nmsThresholdSlider = document.getElementById('nmsThresholdSlider');
    if (!elements.nmsThresholdValue) elements.nmsThresholdValue = document.getElementById('nmsThresholdValue');
  }

  if (!elements.settingsModal) {
    console.error('Settings modal element not found!');
    return;
  }

  console.log('Opening settings modal...', elements.settingsModal);

  try {
    // 現在の設定を取得
    // statusアクションはipc_handlerで { model_loaded, device_info, config } を返します
    const statusResponse = await window.electronAPI.pythonRequest('status', {});

    // pythonRequest returns { success: true, data: { ... } }
    // or sometimes data directly depending on implementation wrapper
    const statusData = statusResponse.data || statusResponse;

    if (statusData && statusData.config) {
      const config = statusData.config;
      console.log('Current config loaded:', config);

      if (elements.yoloSizeSelect) elements.yoloSizeSelect.value = config.yolo_size;
      if (elements.confThresholdSlider) {
        elements.confThresholdSlider.value = config.confidence_threshold;
        if (elements.confThresholdValue) elements.confThresholdValue.textContent = config.confidence_threshold.toFixed(2);
      }
      if (elements.nmsThresholdSlider) {
        const nms = config.nms_threshold || 0.45;
        elements.nmsThresholdSlider.value = nms;
        if (elements.nmsThresholdValue) elements.nmsThresholdValue.textContent = nms.toFixed(2);
      }

      // モデル設定をlocalStorageから読み込み
      loadAllSettingsFromStorage();

      // スライダーのイベントリスナーを設定
      setupSettingsSliderListeners();

      // Ensure modal is child of body to avoid clipping/hiding by parents
      if (elements.settingsModal.parentElement !== document.body) {
        document.body.appendChild(elements.settingsModal);
      }

      elements.settingsModal.classList.add('active');

      // Force styles via JS to ensure visibility regardless of CSS issues
      elements.settingsModal.style.display = 'flex';
      elements.settingsModal.style.position = 'fixed';
      elements.settingsModal.style.zIndex = '99999';

    } else {
      console.warn("Status result invalid or config missing:", statusResponse);
      // Fallback defaults - 全設定を読み込み
      loadAllSettingsFromStorage();
      setupSettingsSliderListeners();

      elements.settingsModal.classList.add('active');
      elements.settingsModal.style.display = 'flex';
      elements.settingsModal.style.position = 'fixed';
      elements.settingsModal.style.zIndex = '99999';
    }
  } catch (e) {
    console.error('Failed to load settings (using defaults):', e);
    // エラーでもとりあえず開く（デフォルト値で変更させて上書き）- 全設定を読み込み
    loadAllSettingsFromStorage();
    setupSettingsSliderListeners();

    elements.settingsModal.classList.add('active');
    elements.settingsModal.style.display = 'flex';
    elements.settingsModal.style.position = 'fixed';
    elements.settingsModal.style.zIndex = '99999';
  }
}

// 設定値をlocalStorageから読み込む
function loadAllSettingsFromStorage() {
  // モデル設定
  const drawThreshold = document.getElementById('settingsDrawThreshold');
  const drawThresholdValue = document.getElementById('drawThresholdValue');

  if (drawThreshold) {
    const val = parseFloat(localStorage.getItem('drawThreshold')) || 0.3;
    drawThreshold.value = val;
    if (drawThresholdValue) drawThresholdValue.textContent = val.toFixed(2);
  }

  // フィルタ設定
  const interpolationMethodInput = document.getElementById('settingsInterpolationMethod');
  const maxGapInput = document.getElementById('settingsMaxGap');
  const edgePaddingInput = document.getElementById('settingsEdgePadding');
  const butterworthCutoffInput = document.getElementById('settingsButterworthCutoff');

  if (interpolationMethodInput) interpolationMethodInput.value = localStorage.getItem('interpolationMethod') || 'pchip';
  if (maxGapInput) maxGapInput.value = localStorage.getItem('maxGap') || 50;
  if (edgePaddingInput) edgePaddingInput.value = localStorage.getItem('edgePadding') || 20;
  if (butterworthCutoffInput) butterworthCutoffInput.value = localStorage.getItem('butterworthCutoff') || 6.0;
}

// フィルタパネルの初期化（現在は特に設定なし）
function initFilterPanelDefaults() {
  // サイドバーのフィルタパネルはチェックボックスのみなので特に初期化不要
}

// スライダーのイベントリスナーを設定
function setupSettingsSliderListeners() {
  const drawThreshold = document.getElementById('settingsDrawThreshold');
  const drawThresholdValue = document.getElementById('drawThresholdValue');

  if (drawThreshold && drawThresholdValue) {
    // inputとchangeの両イベントに対応
    const updateValue = (e) => {
      drawThresholdValue.textContent = parseFloat(e.target.value).toFixed(2);
    };
    drawThreshold.addEventListener('input', updateValue);
    drawThreshold.addEventListener('change', updateValue);
  }
}

function closeSettingsModal() {
  if (!elements.settingsModal) return;

  elements.settingsModal.classList.remove('active');

  // Clear forced inline styles
  elements.settingsModal.style.display = '';
  elements.settingsModal.style.zIndex = '';
  elements.settingsModal.style.position = '';
  elements.settingsModal.style.width = '';
  elements.settingsModal.style.height = '';
  elements.settingsModal.style.top = '';
  elements.settingsModal.style.left = '';
  elements.settingsModal.style.backgroundColor = '';
}

async function saveSettings() {
  const yoloSize = parseInt(elements.yoloSizeSelect.value);
  const confThreshold = parseFloat(elements.confThresholdSlider.value);
  const nmsThreshold = parseFloat(elements.nmsThresholdSlider.value);

  // モデル設定を取得
  const drawThresholdInput = document.getElementById('settingsDrawThreshold');
  const drawThreshold = drawThresholdInput ? parseFloat(drawThresholdInput.value) || 0.3 : 0.3;

  // フィルタリング設定を取得
  const interpolationMethodInput = document.getElementById('settingsInterpolationMethod');
  const maxGapInput = document.getElementById('settingsMaxGap');
  const edgePaddingInput = document.getElementById('settingsEdgePadding');
  const butterworthCutoffInput = document.getElementById('settingsButterworthCutoff');
  const interpolationMethod = interpolationMethodInput ? interpolationMethodInput.value : 'pchip';
  const maxGap = maxGapInput ? parseInt(maxGapInput.value) || 50 : 50;
  const edgePadding = edgePaddingInput ? parseInt(edgePaddingInput.value) || 20 : 20;
  const butterworthCutoff = butterworthCutoffInput ? parseFloat(butterworthCutoffInput.value) || 6.0 : 6.0;

  try {
    elements.saveSettingsBtn.disabled = true;
    elements.saveSettingsBtn.textContent = '保存中...';

    // モデル設定をlocalStorageに保存
    localStorage.setItem('drawThreshold', drawThreshold);

    // フィルタリング設定をlocalStorageに保存
    localStorage.setItem('interpolationMethod', interpolationMethod);
    localStorage.setItem('maxGap', maxGap);
    localStorage.setItem('edgePadding', edgePadding);
    localStorage.setItem('butterworthCutoff', butterworthCutoff);

    const result = await window.electronAPI.pythonRequest('set_config', {
      yolo_size: yoloSize,
      confidence_threshold: confThreshold,
      nms_threshold: nmsThreshold
    });

    if (result.success) {
      closeSettingsModal();
      // リロードが必要な場合はPython側からのstatus updateで通知されるため、ここでは何もしない
      // (Loading表示などはServerStatusUIが処理する)
    } else {
      alert('設定の保存に失敗しました: ' + (result.error || 'Unknown error'));
    }
  } catch (e) {
    console.error('Failed to save settings:', e);
    alert('設定の保存に失敗しました。');
  } finally {
    elements.saveSettingsBtn.disabled = false;
    elements.saveSettingsBtn.textContent = '適用';
  }
}

// ===================================
// Init Model Info
// ===================================
// ===================================
// Init Model Info
// ===================================
async function initModelInfo(retryCount = 0) {
  if (!window.electronAPI) return;
  try {
    const result = await window.electronAPI.pythonRequest('get_model_info', {});
    if (result.success) {
      state.loadedModels = result.data.current;
      updateModelSelectorUI(
        result.data.current_type,
        result.data.available,
        result.data.current_yolo,
        result.data.available_yolo
      );
      updateModelInfoDisplay();
      updateDeviceSelectorUI(result.data.device);

      // モデル未ロード時: デバイスに応じてデフォルトプリセットを選択
      // GPU → 高精度(hq), CPU → 高速(fast)
      if (!result.data.current_type && elements.presetSelect) {
        const device = result.data.device || 'cpu';
        elements.presetSelect.value = (device === 'cpu') ? 'fast' : 'hq';  // mps/cuda は高精度、CPUのみ高速
      }

      console.log('Model info initialized successfully');
    } else {
      console.warn('Failed to get model info, retrying...', result.error);
      if (retryCount < 3) {
        setTimeout(() => initModelInfo(retryCount + 1), 1000);
      }
    }
  } catch (e) {
    console.warn("Failed to init model info:", e);
    if (retryCount < 3) {
      setTimeout(() => initModelInfo(retryCount + 1), 1000);
    }
  }
}

// ===================================
// Server Status (IPC-based)
// ===================================
async function checkServerStatus() {
  if (!window.electronAPI) {
    state.serverStatus = null;
    updateServerStatusUI();
    return;
  }

  try {
    const result = await window.electronAPI.pythonStatus();
    if (result.ready) {
      state.serverStatus = {
        model_loaded: true,
        device_info: { current_device: result.device || 'cpu' }
      };
    } else {
      state.serverStatus = null;
    }
    updateServerStatusUI();
  } catch (e) {
    state.serverStatus = null;
    updateServerStatusUI();
  }
}

function updateServerStatusUI() {
  if (state.serverStatus) {
    const _d = state.serverStatus.device_info.current_device;
    const deviceName = _d === 'mps' ? 'CoreML' : _d.toUpperCase();
    if (state.modelLoading) {
      elements.statusIndicator.className = 'status-indicator loading';
      const progress = state.modelLoadingProgress || 0;
      elements.statusText.textContent = `${deviceName} - Loading ${progress}%`;
    } else {
      elements.statusIndicator.className = 'status-indicator online';
      elements.statusText.textContent = deviceName;
    }
  } else {
    elements.statusIndicator.className = 'status-indicator offline';
    elements.statusText.textContent = 'Offline';
  }
  updateRunButton();
}

// Pythonからのステータス更新を受け取る
function initPythonStatusListener() {
  if (window.electronAPI && window.electronAPI.onPythonStatusUpdate) {
    window.electronAPI.onPythonStatusUpdate((data) => {
      if (data.ready) {
        state.serverStatus = {
          model_loaded: !data.modelLoading,
          device_info: { current_device: data.device || 'cpu' }
        };
        // すでにロード進捗が進んでいる場合は0リセットしない
        if (!state.modelLoading) {
          state.modelLoadingProgress = 0;
        }
        state.modelLoading = data.modelLoading || false;
        // デバイスセレクタを更新
        updateDeviceSelectorUI(data.device || 'cpu');

        // モデル情報がまだ初期化されていない場合は初期化
        if (!state.modelInfoInitialized) {
          console.log('[App] Python ready, initializing model info...');
          initModelInfo();
          state.modelInfoInitialized = true;
        }
      } else {
        state.serverStatus = null;
        state.modelLoading = false;
      }
      updateServerStatusUI();
    });
  }

  // モデルロード進捗イベント
  if (window.electronAPI && window.electronAPI.onPythonModelLoadingProgress) {
    window.electronAPI.onPythonModelLoadingProgress((data) => {
      state.modelLoading = true;
      state.modelLoadingProgress = data.progress || 0;
      state.modelLoadingMessage = data.message || '';

      // プログレスパネルを表示
      if (elements.progressPanel) {
        elements.progressPanel.style.display = 'block';
        if (elements.progressFill) elements.progressFill.style.width = `${state.modelLoadingProgress}%`;
        if (elements.progressText) elements.progressText.textContent = `${state.modelLoadingMessage} (${state.modelLoadingProgress}%)`;
      }

      updateServerStatusUI();
      updateModelInfoDisplay();
    });
  }

  // モデルロード完了イベント
  if (window.electronAPI && window.electronAPI.onPythonModelLoaded) {
    window.electronAPI.onPythonModelLoaded((data) => {
      state.modelLoading = false;
      state.modelLoadingProgress = 100;

      // プログレスパネルを非表示 (動画処理が続く場合はrunDetection側で再表示されるが、一旦消す)
      // ただし、detect_videoの直後なら process_message loop で progress が来るので
      // ここで消すと一瞬消えるかもしれない。
      // modelLoadingフラグが落ちるので updateServerStatusUI で Loading表示は消える。
      if (elements.progressPanel) {
        // elements.progressPanel.style.display = 'none'; 
        // ここでは消さないほうがスムーズかも？
        // しかし単独でモデルロードした場合は消さないといけない。
        // isProcessingをチェックする?
        if (!state.isProcessing) {
          setTimeout(() => {
            if (!state.modelLoading && !state.isProcessing && elements.progressPanel) {
              elements.progressPanel.style.display = 'none';
            }
          }, 500);
        }
      }

      if (data.success) {
        state.serverStatus = {
          model_loaded: true,
          device_info: { current_device: data.device || 'cpu' }
        };
        // ロードしたモデル情報を保存
        if (data.models) {
          state.loadedModels = data.models;
          const models = data.models;
          const modelInfo = [];
          if (models.yolo) modelInfo.push(models.yolo);
          if (models.vitpose) modelInfo.push(models.vitpose);

          // GPUフォールバック判定: サーバーからCPUが返ってきたらGPUフラグを下ろす
          if (data.device === 'cpu' && state.gpuAvailable) {
            console.warn('[App] Device fell back to CPU. Disabling GPU availability.');
            state.gpuAvailable = false;
          }

          if (modelInfo.length > 0) {
            if (models.warnings && models.warnings.length > 0) {
              showError(`⚠️ モデルロード完了（警告あり）: ${modelInfo.join(', ')}\n${models.warnings.join('\n')}`);
              setTimeout(hideError, 10000);
            } else {
              showError(`✅ モデルロード完了: ${modelInfo.join(', ')}`);
              setTimeout(hideError, 5000);
            }
          }
          // UIセレクタを現在のモデルに同期
          updateModelSelectorUI(models.vitpose_type, models.available_models);
        }
        // デバイスセレクタを更新
        updateDeviceSelectorUI(data.device);
      }
      updateServerStatusUI();
      updateModelInfoDisplay();
    });
  }

  // Pythonログイベント
  if (window.electronAPI && window.electronAPI.onPythonLog) {
    window.electronAPI.onPythonLog((data) => {
      console.log(`[Python] ${data}`);
      if (data.includes('Error') || data.includes('Exception') || data.includes('Traceback')) {
        console.error(`[Python Error] ${data}`);
      }
    });
  }
}

// モデル情報表示を更新
function updateModelInfoDisplay() {
  const modelInfoEl = document.getElementById('modelInfo');
  if (!modelInfoEl) return;

  if (state.modelLoading) {
    const progress = state.modelLoadingProgress || 0;
    const message = state.modelLoadingMessage || 'ロード中...';
    modelInfoEl.textContent = `${message} (${progress}%)`;
  } else if (state.loadedModels) {
    const yolo = (state.loadedModels.yolo_model || '').replace('.onnx', '').toUpperCase();
    const pose = state.loadedModels.vitpose || '不明';
    modelInfoEl.textContent = `現在: ${yolo} + ${pose}`;
  } else {
    modelInfoEl.textContent = '現在: 未ロード';
  }
}

// モデルセレクタUIを更新（プリセットセレクタを現在のモデルに同期）
function updateModelSelectorUI(currentType, availableModels, currentYolo, availableYolo) {
  // プリセットセレクタを現在のモデル+YOLOに合わせて同期
  const presetSel = document.getElementById('presetSelect');
  if (presetSel && currentType) {
    const matchingPreset = Object.entries(PRESET_CONFIG).find(([, cfg]) =>
      cfg.model === currentType && (!cfg.yolo || cfg.yolo === currentYolo)
    );
    if (matchingPreset) {
      presetSel.value = matchingPreset[0];
      state.outputFormat = matchingPreset[1].outputFormat;
    }
  }

}

// ステップガイドバーを現在の状態に合わせて更新
function updateStepGuide() {
  const stepIds = ['stepItem1', 'stepItem2', 'stepItem3', 'stepItem4'];
  const hint = document.getElementById('stepHint');

  const hasFile      = !!state.selectedFile;
  const hasResult    = !!(state.videoResult || state.result);
  const hasFiltered  = !!state.filteredResult;
  const isProcessing = !!state.isProcessing;
  const isExported   = !!state.exported;

  let activeStep, hintText, hintClass = '';

  if (isProcessing) {
    activeStep = 2;
    hintText   = '推定処理中...';
    hintClass  = 'processing';
  } else if (!hasFile) {
    activeStep = 1;
    hintText   = '動画または画像ファイルをドロップ';
  } else if (!hasResult) {
    activeStep = 2;
    hintText   = '「ポーズ推定を実行」ボタンを押してください';
  } else if (!hasFiltered) {
    activeStep = 3;
    hintText   = 'フィルタリングパネルでデータを平滑化できます';
    hintClass  = 'info';
  } else if (!isExported) {
    activeStep = 4;
    hintText   = 'エクスポートパネルでCSV保存できます';
    hintClass  = 'success';
  } else {
    activeStep = 5; // 全ステップ完了
    hintText   = '保存完了 — MotionDigitizer で HPEインポートして利用できます';
    hintClass  = 'success';
  }

  stepIds.forEach((id, index) => {
    const el = document.getElementById(id);
    if (!el) return;
    const step = index + 1;
    const cls  = step < activeStep ? 'done' : step === activeStep ? 'active' : 'pending';
    el.className = `step-item ${cls}`;
    const numEl = el.querySelector('.step-num');
    if (numEl) numEl.textContent = step < activeStep ? '✓' : String(step);
  });

  if (hint) {
    hint.textContent = '▶ ' + hintText;
    hint.className   = 'step-hint' + (hintClass ? ` ${hintClass}` : '');
  }
}

// モデル/デバイス切り替え
// モデル/デバイス切り替え
async function switchVitposeModel(modelType, device = null, yoloType = null) {
  if (!window.electronAPI) return;

  state.modelLoading = true;
  state.modelLoadingProgress = 0;
  updateServerStatusUI();
  updateModelInfoDisplay();

  try {
    const requestData = {};
    if (modelType) requestData.model_type = modelType;
    if (device) requestData.device = device;
    if (yoloType) requestData.yolo_model = yoloType;

    const result = await window.electronAPI.pythonRequestWithProgress('switch_model', requestData);

    if (result.success) {
      state.loadedModels = result.data.models;
      state.currentDevice = result.data.device;

      // サーバー状態も更新して右上の表示に反映
      if (state.serverStatus) {
        state.serverStatus.device_info = { current_device: result.data.device };
      } else {
        state.serverStatus = {
          model_loaded: true,
          device_info: { current_device: result.data.device }
        };
      }

      const deviceName = result.data.device === 'cuda' ? 'GPU' : result.data.device === 'mps' ? 'CoreML' : 'CPU';
      const modelName = result.data.models?.vitpose || modelType || '';
      const yoloName = result.data.models?.yolo || '';

      // 成功後に警告があるか確認
      if (result.data.models?.warnings && result.data.models.warnings.length > 0) {
        showError(`⚠️ 警告: 一部のモデルロードに失敗しました\n${result.data.models.warnings.join('\n')}`);
        // 長めに表示
        setTimeout(hideError, 8000);
      } else {
        showError(`✅ 切り替え完了: ${modelName} + ${yoloName} (${deviceName})`);
        setTimeout(hideError, 5000);
      }

      // UIセレクタを同期
      updateDeviceSelectorUI(result.data.device);
      updateModelSelectorUI(
        result.data.models?.vitpose_type,
        result.data.models?.available_models,
        result.data.models?.yolo_model,
        result.data.models?.available_yolo // 修正: models内に含まれるようになった
      );
    } else {
      showError(`❌ 切り替え失敗: ${result.error}`);
    }
  } catch (e) {
    showError(`❌ 切り替えエラー: ${e.message}`);
  } finally {
    state.modelLoading = false;
    updateServerStatusUI();
    updateModelInfoDisplay();
  }
}

// デバイスセレクタUIを更新（検出結果に応じて動的に設定）
function updateDeviceSelectorUI(currentDevice) {
  const selector = document.getElementById('deviceSelect');
  if (!selector) return;

  // GPUが利用可能か記録
  if (currentDevice === 'cuda') {
    state.gpuAvailable = true;
  }
  if (currentDevice === 'mps') {
    state.mpsAvailable = true;
  }

  // セレクタの内容をクリア
  selector.innerHTML = '';

  if (state.gpuAvailable || currentDevice === 'cuda') {
    // CUDA GPU利用可能: GPU / CPU を選択可能
    const optionGpu = document.createElement('option');
    optionGpu.value = 'cuda';
    optionGpu.textContent = 'GPU (CUDA)';
    selector.appendChild(optionGpu);

    const optionCpu = document.createElement('option');
    optionCpu.value = 'cpu';
    optionCpu.textContent = 'CPU';
    selector.appendChild(optionCpu);

    selector.value = currentDevice;
    selector.disabled = false;
  } else if (state.mpsAvailable || currentDevice === 'mps') {
    // Apple Silicon CoreML利用可能: CoreML / CPU を選択可能
    const optionMps = document.createElement('option');
    optionMps.value = 'mps';
    optionMps.textContent = 'CoreML (Apple Silicon)';
    selector.appendChild(optionMps);

    const optionCpu = document.createElement('option');
    optionCpu.value = 'cpu';
    optionCpu.textContent = 'CPU';
    selector.appendChild(optionCpu);

    selector.value = currentDevice;
    selector.disabled = false;
  } else {
    // CPUのみ利用可能
    const option = document.createElement('option');
    option.value = 'cpu';
    option.textContent = 'CPU';
    selector.appendChild(option);
    selector.value = 'cpu';
    selector.disabled = true;
  }
}

// ===================================
// File Selection
// ===================================
function isImageFile(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext);
}

function isVideoFile(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  return ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'asf', 'mpeg', 'mpg'].includes(ext);
}

async function handleFileSelect() {
  // まずダイアログを開く（他の処理は一切行わない）
  let selectedFilePath = null;
  let selectedFileName = null;
  let selectedFileObject = null;

  if (window.electronAPI) {
    const res = await window.electronAPI.selectFile();
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return; // キャンセルされた場合は何もしない
    }
    selectedFilePath = res.filePaths[0];
    selectedFileName = selectedFilePath.split(/[/\\]/).pop();
  } else {
    // ブラウザ環境ではファイル選択
    selectedFileObject = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*';
      input.onchange = (e) => {
        resolve(e.target.files[0] || null);
      };
      input.click();
    });
    if (!selectedFileObject) return; // キャンセルされた場合
  }

  // ファイル選択後、処理を開始
  if (selectedFilePath) {
    loadFile({ path: selectedFilePath, name: selectedFileName });
  } else if (selectedFileObject) {
    loadFile(selectedFileObject);
  }
}

async function loadFile(file) {
  resetForNewFile();

  // Electron環境では、Fileオブジェクトにpathプロパティが存在する
  // ブラウザ環境では、pathプロパティは存在しない
  // file.pathがある場合は、{ path, name }形式のオブジェクトとして保存
  // ない場合は、Fileオブジェクトをそのまま保存
  if (file.path) {
    // Electron環境でFileオブジェクトにpathプロパティがある場合、または{ path, name }形式のオブジェクトの場合
    state.selectedFile = {
      path: file.path,
      name: file.name
    };
  } else {
    // Fileオブジェクトでpathプロパティがない場合（ブラウザ環境）
    state.selectedFile = file;
  }

  const fileName = state.selectedFile.name || (state.selectedFile.path ? state.selectedFile.path.split(/[/\\]/).pop() : 'unknown');
  updateStepGuide();

  if (isImageFile(fileName)) {
    state.fileType = 'image';
    elements.fileType.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg> 画像';

    if (state.selectedFile.path) {
      try {
        const response = await fetch(`file://${state.selectedFile.path}`);
        const blob = await response.blob();
        state.previewUrl = URL.createObjectURL(blob);
      } catch (e) {
        showError('ファイルの読み込みに失敗しました');
        return;
      }
    } else {
      state.previewUrl = URL.createObjectURL(file);
    }

    elements.previewImage.src = state.previewUrl;
    elements.previewImage.style.display = 'block';
    elements.previewVideo.style.display = 'none';

  } else if (isVideoFile(fileName)) {
    state.fileType = 'video';
    elements.fileType.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg> 動画';

    // 動画のパスを取得
    let videoPath = state.selectedFile.path;

    // パスがある場合（Electron環境）、FFmpegで変換が必要かチェック
    if (videoPath && window.electronAPI) {
      // 高速化: MP4/WebM/Ogg はブラウザで再生可能とみなしてチェックをスキップ（0秒ロード）
      const ext = videoPath.split('.').pop().toLowerCase();
      if (['mp4', 'webm', 'ogg'].includes(ext)) {
        state.previewUrl = `file://${videoPath}`;
      } else {
        try {
          // その他の形式（MOV, AVI等）は変換が必要かチェック (IPC経由) - タイムアウト付き
          const checkPromise = window.electronAPI.pythonRequest('video_check', { file_path: videoPath });
          // 5秒は長すぎてUIがもっさりするので1.5秒に短縮
          const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 1500));

          const checkRes = await Promise.race([checkPromise, timeoutPromise]);

          if (checkRes.timeout) {
            console.warn('Video check timed out, skipping conversion check');
            // タイムアウト時はそのまま読み込みを試みる
          } else if (checkRes.success) {
            const checkResult = checkRes.data;

            // 既に変換済みの場合
            if (checkResult.already_converted) {
              videoPath = checkResult.converted_path;
              state.selectedFile.path = videoPath;
              state.selectedFile.originalPath = state.selectedFile.path;
              showError(`✅ 変換済みファイルを使用: ${checkResult.converted_path.split(/[/\\]/).pop()}`);
              setTimeout(hideError, 3000);
            }
            // 変換が必要な場合
            else if (checkResult.needs_conversion) {
              const videoInfo = checkResult.video_info;
              const codec = videoInfo.codec || 'unknown';
              const container = videoInfo.container || '';

              // 変換確認ダイアログ
              const confirmConvert = confirm(
                `この動画ファイル（${codec}/${container}）はブラウザで直接再生できません。\n\n` +
                `H.264/MP4に変換しますか？\n` +
                `（変換には少し時間がかかります）`
              );

              if (confirmConvert) {
                // 変換中表示
                showError('🔄 動画を変換中...');

                try {
                  const convertRes = await window.electronAPI.pythonRequest('video_convert', { file_path: videoPath });

                  if (convertRes.success) {
                    const convertResult = convertRes.data;
                    if (convertResult.success) {
                      videoPath = convertResult.output_path;
                      state.selectedFile.originalPath = state.selectedFile.path;
                      state.selectedFile.path = videoPath;
                      showError(`✅ 変換完了: ${convertResult.output_path.split(/[/\\]/).pop()}`);
                      setTimeout(hideError, 3000);
                    } else {
                      showError(`❌ 変換エラー: ${convertResult.error || '不明なエラー'}`);
                      return;
                    }
                  } else {
                    showError(`❌ 変換エラー: ${convertRes.error || '変換に失敗しました'}`);
                    return;
                  }
                } catch (e) {
                  showError(`❌ 変換エラー: ${e.message}`);
                  return;
                }
              } else {
                // 変換をキャンセルした場合、そのまま読み込みを試みる
                showError('⚠️ 変換をキャンセルしました。動画が正しく再生されない可能性があります。');
                setTimeout(hideError, 5000);
              }
            }
          }
        } catch (e) {
          // FFmpegチェックに失敗した場合は、そのまま読み込みを試みる
          console.warn('FFmpeg check failed:', e);
        }

        state.previewUrl = `file://${videoPath}`;
      }
    } else {
      state.previewUrl = URL.createObjectURL(file);
    }

    elements.previewVideo.src = state.previewUrl;
    elements.previewImage.style.display = 'none';
    elements.previewVideo.style.display = 'block';
  }

  elements.fileName.textContent = fileName;
  elements.fileInfo.style.display = 'block';
  elements.placeholder.style.display = 'none';
  elements.previewContainer.style.display = 'block';
  elements.resultCanvas.style.display = 'none';
  // ドロップゾーンを非表示
  if (elements.dropZone) {
    elements.dropZone.style.display = 'none';
  }

  updateRunButton();
}

// ===================================
// Video Relink (Link Repair)
// ===================================
async function handleRelinkVideo() {
  console.log('[RelinkVideo] 動画再選択を開始');
  // 動画ファイルを再選択する（プロジェクトの動画が見つからない場合など）
  // 既存の解析結果（state.result, state.videoResult etc）は維持する

  // ファイル選択
  let selectedFilePath = null;
  if (window.electronAPI) {
    const res = await window.electronAPI.selectFile();
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return;
    }
    selectedFilePath = res.filePaths[0];
  } else {
    // ブラウザ環境（略 - Electron前提）
    return;
  }

  if (!selectedFilePath) return;

  const fileName = selectedFilePath.split(/[/\\]/).pop();
  if (!isVideoFile(fileName)) {
    showError('動画ファイルを選択してください');
    return;
  }

  // パスを更新
  const oldPath = state.selectedFile ? state.selectedFile.path : 'none';
  console.log(`[RelinkVideo] Path changed: ${oldPath} -> ${selectedFilePath}`);

  state.selectedFile = {
    path: selectedFilePath,
    name: fileName
  };
  state.filePath = selectedFilePath;

  // プレビューURL更新
  state.previewUrl = `file://${selectedFilePath}`;
  if (elements.previewVideo) {
    elements.previewVideo.src = state.previewUrl;
    elements.previewVideo.load();
  }

  if (elements.fileName) {
    elements.fileName.textContent = fileName;
  }

  showError(`✅ 動画パスを更新しました: ${fileName}`);
  setTimeout(hideError, 3000);

  // フレームキャッシュは動画が変わると無効になるためリセット
  state.frameImageCache = {};
  state.extractedFramesDir = null;
  state.isExtractingFrames = false;
  if (elements.cacheProgressContainer) {
    elements.cacheProgressContainer.style.display = 'none';
    if (elements.cacheLabel) elements.cacheLabel.textContent = 'キャッシュ中...';
    if (elements.cacheProgressFill) elements.cacheProgressFill.style.width = '0%';
    if (elements.cachePercent) elements.cachePercent.textContent = '0%';
  }

  // 動画メタデータロード待ち
  if (elements.previewVideo) {
    elements.previewVideo.addEventListener('loadedmetadata', () => {
      console.log('[RelinkVideo] Metadata loaded. Redrawing...');
      drawVideoFrame();

      // フレーム抽出をバックグラウンドで開始
      extractVideoFrames();
    }, { once: true });
  }
}

function initVideoRelinkEvents() {
  if (elements.reselectVideoButton) {
    elements.reselectVideoButton.addEventListener('click', (e) => {
      e.stopPropagation(); // パネル開閉などの副作用防止
      handleRelinkVideo();
    });
  }
}

// ImageBitmapキャッシュを適切に解放する関数（メモリリーク防止）
function clearFrameCache() {
  if (state.frameCache) {
    // オブジェクト形式のキャッシュを処理
    Object.values(state.frameCache).forEach(bitmap => {
      if (bitmap && typeof bitmap.close === 'function') {
        bitmap.close();
      }
    });
    state.frameCache = {};
  }
}

// loadFile時に呼ばれる部分リセット関数
// 注: 完全なリセットは152行目のresetState()を使用
function resetForNewFile() {
  state.result = null;
  state.videoResult = null;
  state.filteredResult = null;
  state.currentFrame = 1;
  state.isPlaying = false;
  clearFrameCache();  // ImageBitmapを適切に解放
  state.isCaching = false;
  state.extractedFramesDir = null;  // フレームキャッシュディレクトリをリセット
  state.videoZoomInitialized = false;  // ズーム状態をリセット
  state.viewMode = 'video';
  state.editHistory = [];
  state.isEditing = false;
  state.skeletonZoom = 1.5;
  state.skeletonPanX = 0;
  state.skeletonPanY = 0;
  state.skeletonPanX = 0;
  state.skeletonPanY = 0;
  state.showSkeleton = true; // スケルトン表示を強制ON
  if (elements.showSkeletonCheckbox) {
    elements.showSkeletonCheckbox.checked = true;
  }
  state.skeletonPreviewCentered = false;
  state.graphYRangeX = null;
  state.graphYRangeY = null;
  state.graphXRangeX = null;
  state.graphXRangeY = null;
  state.graphPanning = false;
  stopPlayback();

  hideError();

  elements.exportPanel.style.display = 'none';
  elements.playbackFooter.style.display = 'none';
  elements.filterPanel.style.display = 'none';
  elements.viewModePanel.style.display = 'none';
  if (elements.cleansingPanel) elements.cleansingPanel.style.display = 'none';
  elements.resultCanvas.style.display = 'none';
  elements.graphContainer.style.display = 'none';
  // キャッシュ進捗UIを非表示
  if (elements.cacheProgressContainer) {
    elements.cacheProgressContainer.style.display = 'none';
  }

  // ビデオ要素をリセット（既存のソースを解放）
  if (elements.previewVideo) {
    elements.previewVideo.pause();
    elements.previewVideo.removeAttribute('src');
    elements.previewVideo.load();
  }
}

// ===================================
// Pose Detection
// ===================================
async function runDetection() {
  if (!state.selectedFile || state.isProcessing) return;
  if (!window.electronAPI) {
    showError('Electron API not available');
    return;
  }

  // Pythonサーバーが起動していない場合は遅延起動
  if (!state.serverStatus) {
    showError('⏳ Pythonサーバーを起動中...');
    try {
      const result = await window.electronAPI.startPythonIfNeeded();
      if (!result.success) {
        showError(`❌ Pythonサーバーの起動に失敗: ${result.error || '不明なエラー'}`);
        return;
      }
      // 起動完了を待つ（ステータス更新はpython-status-updateで受け取る）
      // 少し待機してステータスが反映されるのを待つ
      await new Promise(resolve => setTimeout(resolve, 1000));
      hideError();
    } catch (e) {
      showError(`❌ Pythonサーバーの起動エラー: ${e.message}`);
      return;
    }
  }

  state.isProcessing = true;
  updateRunButton();
  hideError();
  updateStepGuide();

  try {
    if (state.fileType === 'video') {
      const estimationMode = elements.estimationMode.value;
      const frameSkip = estimationMode === 'quick' ? 4 : 1;
      await runVideoDetection(frameSkip);
    } else {
      await runImageDetection();
    }

  } catch (e) {
    showError(`推定エラー: ${e.message}`);
  } finally {
    state.isProcessing = false;
    updateRunButton();
    elements.progressPanel.style.display = 'none';
    updateStepGuide();
  }
}

async function cancelDetection() {
  if (!state.isProcessing) return;

  console.log('[cancelDetection] キャンセルリクエストを送信');
  elements.progressText.textContent = 'キャンセル中...';

  try {
    const result = await window.electronAPI.cancelDetection();
    console.log('[cancelDetection] キャンセル結果:', result);
  } catch (e) {
    console.error('[cancelDetection] キャンセルエラー:', e);
  }
}

async function runImageDetection() {
  const filePath = state.selectedFile.path;
  if (!filePath) {
    throw new Error('画像ファイルのパスが取得できません');
  }

  // 画像パスを設定（動画と同じUIで表示するために必要）
  state.filePath = filePath;

  const res = await window.electronAPI.pythonRequest('detect_image', { file_path: filePath });

  if (!res.success) {
    throw new Error(res.error || 'API Error');
  }

  // 画像の結果を1フレームの動画結果として構造化
  state.videoResult = {
    fps: 1,
    total_frames: 1,
    processed_frames: 1,
    width: res.data.width || 0, // Python側で含めていない場合は0になるが、描画時に計算される
    height: res.data.height || 0,
    frames: [
      {
        frame: 1,
        keypoints: res.data.keypoints
      }
    ],
    keypoint_names: res.data.keypoint_names,
    processing_time_ms: res.data.processing_time_ms
  };

  state.result = res.data; // 後方互換性のため残す
  state.currentFrame = 1;

  // 使用モデル情報を記録
  state.usedModels = {
    yolo: state.loadedModels?.yolo_model || 'Unknown',
    pose: state.loadedModels?.vitpose || 'Unknown'
  };
  updateUsedModelInfoUI();

  // 動画と同じUIで表示
  showVideoResult();
}

async function runVideoDetection(frameSkip = 1) {
  elements.progressPanel.style.display = 'block';
  elements.progressFill.style.width = '0%';
  elements.progressText.textContent = '準備中...';

  const filePath = state.selectedFile.path;
  if (!filePath) {
    throw new Error('動画ファイルのパスが取得できません');
  }

  // 進捗コールバックを設定
  const progressHandler = (data) => {
    elements.progressFill.style.width = `${data.progress}%`;
    elements.progressText.textContent = `${data.frame} / ${data.total} フレーム (${data.progress}%)`;
  };

  const initHandler = (data) => {
    elements.progressText.textContent = `0 / ${data.total_frames} フレーム (0%)`;
  };

  // 進捗イベントリスナーを一時的に設定
  if (window.electronAPI.onPythonProgress) {
    window.electronAPI.onPythonProgress(progressHandler);
  }
  if (window.electronAPI.onPythonInit) {
    window.electronAPI.onPythonInit(initHandler);
  }

  try {
    const res = await window.electronAPI.pythonRequestWithProgress('detect_video', {
      file_path: filePath,
      frame_skip: frameSkip,
      output_format: state.outputFormat
    });

    if (!res.success) {
      throw new Error(res.error || 'API Error');
    }

    state.videoResult = res.data;
    state.currentFrame = 1;

    // キャンセルされた場合のメッセージ
    const wasCancelled = res.data.cancelled === true;

    // ポーズ推定と同時に抽出されたフレームキャッシュパスを設定
    if (res.data.extracted_frames_dir) {
      state.extractedFramesDir = res.data.extracted_frames_dir.replace(/\\/g, '/');
      state.frameImageCache = {}; // キャッシュをリセット
      console.log('[runVideoDetection] フレームキャッシュ設定:', state.extractedFramesDir);

      // キャッシュ完了UIを表示
      if (elements.cacheProgressContainer) {
        elements.cacheProgressContainer.style.display = 'flex';
        if (wasCancelled) {
          elements.cacheLabel.textContent = `✓ ${res.data.processed_frames}フレーム`;
        } else {
          elements.cacheLabel.textContent = '✓ キャッシュ済み';
        }
        elements.cacheLabel.classList.add('complete');
        elements.cacheProgressFill.style.width = '100%';
        elements.cacheProgressFill.classList.add('complete');
        elements.cachePercent.textContent = '100%';
        elements.cachePercent.classList.add('complete');
      }
    }

    const timeSec = (res.data.processing_time_ms / 1000).toFixed(1);
    if (wasCancelled) {
      const processedPercent = Math.round((res.data.processed_frames / res.data.total_frames) * 100);
      elements.progressFill.style.width = `${processedPercent}%`;
      elements.progressText.textContent = `中止しました (${res.data.processed_frames}/${res.data.total_frames}フレーム処理済み)`;
      showError(`⚠️ ポーズ推定を中止しました（${res.data.processed_frames}フレームまで処理済み）`);
    } else {
      elements.progressFill.style.width = '100%';
      elements.progressText.textContent = `完了！ (処理時間: ${timeSec}秒)`;
    }
    showVideoResult();

    // 使用モデル情報を記録
    state.usedModels = {
      yolo: state.loadedModels?.yolo_model || 'Unknown',
      pose: state.loadedModels?.vitpose || 'Unknown'
    };
    updateUsedModelInfoUI();

  } finally {
    // リスナーを解除する方法がないため、ステートで管理するか、
    // 進捗ハンドラ内でリクエストIDをチェックするなどの方法を使う
    // 現在の実装では、次のリクエストまで古いリスナーが残るが、
    // ハンドラは上書きされるため問題ない
  }
}

// ===================================
// Display Results
// ===================================
function showImageResult() {
  showExportPanel();
  drawImageResult();
}

function showVideoResult() {
  showExportPanel();
  elements.exportVideo.style.display = 'block';

  // セッション開始時のベースラインデータを保存（編集リセット用）
  // filteredResultがあればそれを、なければvideoResultをベースラインとする
  const currentData = state.filteredResult || state.videoResult;
  state.sessionBaselineData = JSON.parse(JSON.stringify(currentData));

  // Video controls
  elements.playbackFooter.style.display = 'flex';
  elements.frameSlider.max = state.videoResult.processed_frames;
  elements.frameSlider.value = state.currentFrame || 1;

  // 単一フレームの場合は再生コントロールを無効化
  const isSingleFrame = state.videoResult.processed_frames <= 1;
  const playbackButtons = [elements.btnPlay, elements.btnFirst, elements.btnPrev, elements.btnNext, elements.btnLast];
  playbackButtons.forEach(btn => {
    if (btn) btn.disabled = isSingleFrame;
  });
  if (elements.frameSlider) elements.frameSlider.disabled = isSingleFrame;
  // 動画エクスポートも動画でない場合は無効化
  if (elements.exportVideo) elements.exportVideo.disabled = isSingleFrame;

  // elements.videoFps.value = state.videoResult.fps || 30; // 動画FPSによる上書きを無効化
  updateFrameInfo();

  // フィルタリングパネルと表示モードパネルとデータクレンジングパネルを表示
  // 画像の場合はフィルタリングとクレンジングは不要なので非表示
  const isImage = state.fileType === 'image';
  elements.filterPanel.style.display = isImage ? 'none' : 'block';
  elements.viewModePanel.style.display = 'block';
  if (elements.cleansingPanel) elements.cleansingPanel.style.display = isImage ? 'none' : 'block';

  // オーバーレイ動画/画像保存ボタンのテキストを切り替え
  if (elements.exportVideo) {
    elements.exportVideo.textContent = isImage ? 'オーバーレイ画像を保存' : 'オーバーレイ動画を保存';
    elements.exportVideo.disabled = false;  // 画像の場合も有効化
  }

  // ID入替用のドロップダウンを更新
  updateSwapPersonSelects();

  // グラフ用の選択肢を初期化
  initGraphSelects();

  // 表示モードに応じて描画（setViewMode()を呼ぶことで、適切な描画が行われる）
  setViewMode(state.viewMode || 'video');

  // フォールバック: 初回描画が失敗した場合に備えて、少し遅延して再描画
  setTimeout(() => {
    if (state.viewMode === 'video') {
      drawVideoFrame();
    } else if (state.viewMode === 'skeleton') {
      drawSkeletonOnly();
    }
  }, 300);

  // OpenCVでフレームを抽出（バックグラウンド）
  extractVideoFrames();
}

// OpenCVを使用してフレームを抽出
async function extractVideoFrames() {
  if (!state.videoResult || !state.filePath) return;
  if (state.isExtractingFrames) return;  // 既に抽出中

  // 画像の場合はフレーム抽出を行わない（キャッシュ完了状態にする）
  if (state.fileType === 'image') {
    if (elements.cacheProgressContainer) {
      elements.cacheProgressContainer.style.display = 'flex';
      elements.cacheLabel.textContent = '✓ キャッシュ済み';
      elements.cacheLabel.classList.add('complete');
      elements.cacheProgressFill.style.width = '100%';
      elements.cacheProgressFill.classList.add('complete');
      elements.cachePercent.textContent = '100%';
      elements.cachePercent.classList.add('complete');
    }
    return;
  }

  // Pythonが準備完了していない場合は、起動（OpenCV）が必要なためキャッシュ生成をスキップ
  // ユーザー要望により、ファイルを開いただけではPythonを起動しない
  if (!state.serverStatus) {
    console.log('[extractVideoFrames] Python not ready. Skipping frame extraction to prioritize startup speed.');
    return;
  }

  // 抽出済みチェック（ディレクトリが実際に存在するか確認）
  if (state.extractedFramesDir) {
    // ディレクトリ存在確認（Electron環境）
    if (window.electronAPI && window.electronAPI.checkPathExists) {
      const exists = await window.electronAPI.checkPathExists(state.extractedFramesDir);
      if (exists) {
        console.log('[extractVideoFrames] 既に抽出済み:', state.extractedFramesDir);
        // UIを完了状態に更新
        if (elements.cacheProgressContainer) {
          elements.cacheProgressContainer.style.display = 'flex';
          elements.cacheLabel.textContent = '✓ キャッシュ済み';
          elements.cacheLabel.classList.add('complete');
          elements.cacheProgressFill.style.width = '100%';
          elements.cacheProgressFill.classList.add('complete');
          elements.cachePercent.textContent = '100%';
          elements.cachePercent.classList.add('complete');
        }
        return;
      } else {
        console.log('[extractVideoFrames] キャッシュディレクトリが見つかりません。再抽出します:', state.extractedFramesDir);
        state.extractedFramesDir = null;
      }
    } else {
      // 存在確認APIがない場合は抽出済みと仮定
      console.log('[extractVideoFrames] 既に抽出済み（存在確認スキップ）:', state.extractedFramesDir);
      return;
    }
  }

  state.frameImageCache = {};  // キャッシュをクリア

  state.isExtractingFrames = true;

  const videoPath = state.filePath;
  console.log('[extractVideoFrames] 抽出開始:', videoPath);

  if (elements.cacheProgressContainer) {
    elements.cacheProgressContainer.style.display = 'flex';
    elements.cacheLabel.textContent = '初期化中...';
    elements.cacheLabel.classList.remove('complete');
    elements.cacheProgressFill.classList.remove('complete');
    elements.cachePercent.classList.remove('complete');
  }



  if (elements.cacheLabel) elements.cacheLabel.textContent = 'フレーム抽出中...';

  try {
    // Pythonにフレーム抽出をリクエスト（output_dirを指定しない＝Temp使用）
    const response = await window.electronAPI.pythonRequestWithProgress('extract_frames', {
      video_path: videoPath,
      output_dir: null, // Tempディレクトリを自動生成させる
      quality: 85  // JPEG品質
    });

    if (response && response.success) {
      console.log('[extractVideoFrames] Response:', response);
      // output_dirの取得を堅牢に
      const outputDir = response.output_dir || (response.data && response.data.output_dir) || (response.result && response.result.output_dir);

      if (!outputDir) {
        console.error('[extractVideoFrames] output_dirが見つかりません:', response);
        throw new Error('フレーム出力パスが取得できませんでした');
      }

      // Windowsパスのバックスラッシュをスラッシュに置換して正規化
      state.extractedFramesDir = outputDir.replace(/\\/g, '/');
      console.log('[extractVideoFrames] 抽出完了:', state.extractedFramesDir);

      // 完了表示
      showError('✅ キャッシュ完了');
      setTimeout(hideError, 3000); // 3秒後に消す

      if (elements.cacheProgressContainer) {
        elements.cacheLabel.textContent = '✓ 完了';
        elements.cacheLabel.classList.add('complete');
        elements.cacheProgressFill.style.width = '100%';
        elements.cacheProgressFill.classList.add('complete');
        elements.cachePercent.textContent = '100%';
        elements.cachePercent.classList.add('complete');
        // 表示を維持
        elements.cacheProgressContainer.style.display = 'flex';
      }
    } else {
      console.warn('[extractVideoFrames] 抽出失敗:', response?.error);
      showError('❌ キャッシュ生成エラー: ' + (response?.error || '不明なエラー'));
      if (elements.cacheProgressContainer) {
        elements.cacheProgressContainer.style.display = 'none';
      }
    }
  } catch (error) {
    console.error('[extractVideoFrames] エラー:', error);
    showError('❌ キャッシュ生成エラー');
    if (elements.cacheProgressContainer) {
      elements.cacheProgressContainer.style.display = 'none';
    }
  } finally {
    state.isExtractingFrames = false;
  }
}

// フレーム画像をキャッシュ（ImageBitmap として保存）
// キャッシュID: 複数のキャッシュ処理が同時に走らないようにするためのID
let cacheSessionId = 0;

async function cacheVideoFrames() {
  // 既存のキャッシュ処理を中断
  if (state.isCaching) {
    state.isCaching = false;
    // 少し待機して既存処理が終了するのを待つ
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (!state.videoResult) return;

  // 新しいキャッシュセッションを開始
  const currentSessionId = ++cacheSessionId;
  state.isCaching = true;

  // 既存のキャッシュは保持（再開時に有効活用）
  if (!state.frameCache || state.frameCache.length === 0) {
    state.frameCache = [];
  }

  const video = elements.previewVideo;
  const totalFrames = state.videoResult.processed_frames;
  const fps = state.videoResult.fps || CONSTANTS.DEFAULT_FPS;

  // キャッシュ進捗UIを表示（一時無効化）
  // updateCacheProgress(0, totalFrames);
  // elements.cacheProgressContainer.style.display = 'flex';

  // 現在のフレームを基準に、前後に広げながらキャッシュ
  // まず現在フレーム周辺を優先的にキャッシュ
  const priorityFrames = getPriorityCacheFrames(state.currentFrame, totalFrames);
  let cachedCount = countCachedFrames(totalFrames);

  for (const frameNum of priorityFrames) {
    // このセッションが中断されていないか確認（別のキャッシュ処理が開始されていないか）
    if (currentSessionId !== cacheSessionId || !state.isCaching) {
      return;
    }

    // スライダー操作中は一時停止
    while (state.isSliderDragging) {
      await new Promise(resolve => setTimeout(resolve, CONSTANTS.CACHE_PAUSE_INTERVAL_MS));
      if (currentSessionId !== cacheSessionId || !state.isCaching) return;
    }

    // 既にキャッシュ済みならスキップ
    if (state.frameCache[frameNum]) continue;

    const targetTime = (frameNum - 1) / fps;

    // フレームをキャプチャ（requestVideoFrameCallback対応の場合はより正確）
    try {
      if ('requestVideoFrameCallback' in video) {
        // requestVideoFrameCallback を使用（より正確なフレームタイミング）
        await new Promise((resolve) => {
          // まずシーク
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            // シーク完了後、次のフレーム描画を待つ
            video.requestVideoFrameCallback(() => {
              resolve();
            });
          };
          video.addEventListener('seeked', onSeeked);
          video.currentTime = targetTime;
        });
      } else {
        // フォールバック: seeked イベントのみ
        await new Promise((resolve) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            resolve();
          };
          video.addEventListener('seeked', onSeeked);
          video.currentTime = targetTime;
        });
      }

      // セッション確認
      if (currentSessionId !== cacheSessionId || !state.isCaching) {
        return;
      }

      // ImageBitmap としてキャッシュ（同期的に描画可能）
      state.frameCache[frameNum] = await createImageBitmap(video);
      cachedCount++;
      // 10フレームごとにUI更新（頻繁すぎると重くなるため）
      if (cachedCount % 10 === 0 || cachedCount === totalFrames) {
        updateCacheProgress(cachedCount, totalFrames);
      }
    } catch (e) {
      console.warn(`フレーム ${frameNum} のキャッシュに失敗:`, e);
    }
  }

  // このセッションがまだ有効な場合のみ完了処理
  if (currentSessionId === cacheSessionId) {
    state.isCaching = false;
    // 最終進捗更新（完了状態）
    updateCacheProgress(totalFrames, totalFrames, true);
    // キャッシュ完了後、現在のフレームを再描画（キャッシュが使えるようになった）
    if (state.viewMode === 'video') {
      drawVideoFrame();
    }
  }
}

// キャッシュ済みフレーム数をカウント
function countCachedFrames(totalFrames) {
  if (!state.frameCache) return 0;
  let count = 0;
  for (let i = 1; i <= totalFrames; i++) {
    if (state.frameCache[i]) count++;
  }
  return count;
}

// キャッシュ進捗UIを更新
function updateCacheProgress(cached, total, isComplete = false) {
  if (!elements.cacheProgressContainer) return;

  const percent = total > 0 ? Math.round((cached / total) * 100) : 0;

  elements.cacheProgressFill.style.width = `${percent}%`;
  elements.cachePercent.textContent = `${percent}%`;

  if (isComplete) {
    elements.cacheLabel.textContent = '✓ キャッシュ完了';
    elements.cacheLabel.classList.add('complete');
    elements.cacheProgressFill.classList.add('complete');
    elements.cachePercent.classList.add('complete');
  } else {
    elements.cacheLabel.textContent = 'キャッシュ中...';
    elements.cacheLabel.classList.remove('complete');
    elements.cacheProgressFill.classList.remove('complete');
    elements.cachePercent.classList.remove('complete');
  }
}

// 現在フレームを基準に優先度順のフレームリストを生成
function getPriorityCacheFrames(currentFrame, totalFrames) {
  const frames = [];
  const maxOffset = Math.max(currentFrame - 1, totalFrames - currentFrame);

  // 現在フレームを最優先
  frames.push(currentFrame);

  // 前後に広げていく
  for (let offset = 1; offset <= maxOffset; offset++) {
    if (currentFrame + offset <= totalFrames) {
      frames.push(currentFrame + offset);
    }
    if (currentFrame - offset >= 1) {
      frames.push(currentFrame - offset);
    }
  }

  return frames;
}

function showExportPanel() {
  elements.exportPanel.style.display = 'block';
  updatePersonSelect();
}

function updatePersonSelect() {
  const personIds = getPersonIds();
  elements.personSelect.innerHTML = '<option value="all">全員</option>';
  personIds.forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `Person ${id}`;
    elements.personSelect.appendChild(option);
  });
  // 最初の人物をデフォルト選択
  if (personIds.length > 0) {
    elements.personSelect.value = personIds[0];
  }
}

// データクレンジング用のドロップダウンを更新
function updateSwapPersonSelects() {
  const personIds = getPersonIds();

  // 対象人物（セクション共通）
  if (elements.cleansingTargetPerson) {
    elements.cleansingTargetPerson.innerHTML = '';
    personIds.forEach(id => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `Person ${id}`;
      elements.cleansingTargetPerson.appendChild(option);
    });
    // 最初の人物をデフォルト選択
    if (personIds.length > 0) {
      elements.cleansingTargetPerson.value = personIds[0];
      state.digitizePersonId = personIds[0];  // デジタイズ対象人物も同期
    }
  }

  // ID入替相手を更新（対象人物を除外）
  updateSwapPersonB();
}

// ID入替相手ドロップダウンを更新（対象人物を除外）
function updateSwapPersonB() {
  const personIds = getPersonIds();
  const targetPerson = elements.cleansingTargetPerson?.value;

  if (elements.swapPersonB) {
    elements.swapPersonB.innerHTML = '';
    // 対象人物以外を追加
    personIds.filter(id => id !== targetPerson).forEach(id => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `Person ${id}`;
      elements.swapPersonB.appendChild(option);
    });
  }
}

// グラフ用人物ドロップダウンを更新
function updateGraphPersonSelect() {
  if (!elements.graphPerson) return;

  const personIds = getPersonIds();
  const currentValue = elements.graphPerson.value;

  elements.graphPerson.innerHTML = '<option value="">人物を選択</option>';
  personIds.forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `Person ${id}`;
    elements.graphPerson.appendChild(option);
  });

  // 以前の選択を維持（存在すれば）
  if (currentValue && personIds.includes(currentValue)) {
    elements.graphPerson.value = currentValue;
  } else if (personIds.length > 0) {
    elements.graphPerson.value = personIds[0];
  }
}

function getPersonIds() {
  const data = getCurrentData();
  if (!data || !data.frames) return [];

  const personIds = new Set();
  // 全フレームから人物IDを収集（画像も動画も同じ構造）
  const allPersonIds = new Set();
  data.frames.forEach(frame => {
    if (frame.keypoints) {
      Object.keys(frame.keypoints).forEach(id => allPersonIds.add(id));
    }
  });

  // 有効なキーポイント（信頼度 > 0）が1つでもある人物のみを残す
  allPersonIds.forEach(personId => {
    let hasValidKeypoint = false;
    for (const frame of data.frames) {
      const kpts = frame.keypoints?.[personId];
      if (kpts) {
        for (const kp of kpts) {
          if (kp && kp[2] > 0) {
            hasValidKeypoint = true;
            break;
          }
        }
      }
      if (hasValidKeypoint) break;
    }
    if (hasValidKeypoint) {
      personIds.add(personId);
    }
  });

  return Array.from(personIds).sort((a, b) => Number(a) - Number(b));
}

// ===================================
// Drawing
// ===================================
function drawImageResult() {
  const canvas = elements.resultCanvas;
  const image = elements.previewImage;
  const ctx = canvas.getContext('2d');

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  ctx.drawImage(image, 0, 0);

  drawKeypoints(ctx, state.result.keypoints, state.pointSize, state.pointAlpha, state.lineWidth);

  elements.previewImage.style.display = 'none';
  canvas.style.display = 'block';
}

function drawVideoFrame() {
  // 骨格モードの場合は drawSkeletonOnly にリダイレクト
  if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
    return;
  }

  const data = getCurrentData();
  if (!data) return;

  // 抽出フレームがあればそれを使用（高速シーク用）
  if (state.extractedFramesDir) {
    drawExtractedFrame();
    return;
  }

  const canvas = elements.resultCanvas;
  const ctx = canvas.getContext('2d');

  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (!frameData) return;

  // 画像モードの場合は画像描画ヘルパーを使用
  if (state.fileType === 'image') {
    const canvas = elements.resultCanvas;
    const ctx = canvas.getContext('2d');
    const image = elements.previewImage;
    if (image.complete) {
      drawFrameImage(ctx, canvas, image, frameData);
    } else {
      image.onload = () => drawFrameImage(ctx, canvas, image, frameData);
    }
    return;
  }

  const video = elements.previewVideo;

  // 動画のメタデータが読み込まれているか確認
  if (video.readyState < 1 || video.videoWidth === 0 || video.videoHeight === 0) {
    // メタデータが読み込まれていない場合は、読み込み完了を待つ
    video.addEventListener('loadedmetadata', () => {
      drawVideoFrame();
    }, { once: true });
    return;
  }

  // キャンバスサイズをコンテナに合わせる
  const container = canvas.parentElement;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  const cWidth = Math.floor(containerRect.width);
  const cHeight = Math.floor(containerRect.height);

  let resized = false;
  // コンテナサイズが0の場合はスキップ
  if (cWidth > 0 && cHeight > 0) {
    if (canvas.width !== cWidth || canvas.height !== cHeight) {
      canvas.width = cWidth;
      canvas.height = cHeight;
      resized = true;
      state.videoZoomInitialized = false; // サイズ変更時はズーム再計算用フラグをリセットしても良いが、UX的には維持したい場合もある

      // しかし初回ロードや大幅なリサイズ時はフィットさせたい。
      // ここでは「まだ初期化されていない」場合のみ計算するようにする。
    }
  }

  // 初期ズーム・パン計算（未初期化の場合）
  if (!state.videoZoomInitialized && cWidth > 0 && cHeight > 0) {
    // フィットスケールを計算
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const fitScale = Math.min(cWidth / vw, cHeight / vh);
    state.videoZoom = Number.isFinite(fitScale) ? fitScale : 1.0;
    state.videoFitScale = state.videoZoom; // ホイールズーム制限用に保存

    // 中央配置オフセット (サニタイズされた値を使用)
    state.videoPanX = (cWidth - vw * state.videoZoom) / 2;
    state.videoPanY = (cHeight - vh * state.videoZoom) / 2;

    state.videoZoomInitialized = true;
  }

  // 描画関数（描画時点でのstate.currentFrameを使用）
  const drawContent = (source) => {
    // 描画時点で再度フレームデータを取得（クロージャの古い参照を避ける）
    const currentFrameData = data.frames.find(f => f.frame === state.currentFrame);
    if (!currentFrameData) return;

    // ズーム・パンをリセットしてからクリア
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height); // 全体をクリア

    // ズーム・パン変換を適用
    // Canvas全体が描画領域なので、translate -> scale の順で適用
    // drawImage(video, 0, 0) は (videoPanX, videoPanY) に描画され、videoZoom倍される
    ctx.setTransform(state.videoZoom, 0, 0, state.videoZoom, state.videoPanX, state.videoPanY);

    ctx.drawImage(source, 0, 0);
    // スケルトン表示がONの場合のみ描画（動画キャンバスに直接描画）
    if (state.showSkeleton) {
      drawSkeletonOrKeypoints(ctx, currentFrameData.keypoints, state.currentFrame, true, state.pointSize, state.pointAlpha, state.lineWidth);
    }
    state.lastDrawnFrame = state.currentFrame;

    // Canvas表示を強制
    canvas.style.display = 'block';
  };

  // 動画のフレーム位置を設定
  const fps = data.fps || 30;
  const targetTime = (state.currentFrame - 1) / fps;

  // キャッシュがあればキャッシュを使用（同期的に描画）
  if (state.frameCache && state.frameCache[state.currentFrame]) {
    // 古い seeked ハンドラがあれば解除（別フレームが後から描画されるのを防止）
    if (pendingSeekedHandler) {
      elements.previewVideo.removeEventListener('seeked', pendingSeekedHandler);
      pendingSeekedHandler = null;
    }
    drawContent(state.frameCache[state.currentFrame]);
  } else {
    // スライダードラッグ中のみ、近いフレームのキャッシュを表示（ちらつき防止）
    if (state.isSliderDragging) {
      const nearestCachedFrame = findNearestCachedFrame(state.currentFrame);
      if (nearestCachedFrame && state.frameCache[nearestCachedFrame]) {
        // 近いフレームがキャッシュにある場合は、それを背景に表示
        // ここは暫定表示なので独自に描画（drawContentを使わない）
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(state.videoZoom, 0, 0, state.videoZoom, state.videoPanX, state.videoPanY);

        ctx.drawImage(state.frameCache[nearestCachedFrame], 0, 0);

        // 半透明オーバーレイで「読み込み中」を示す
        // fillRectはzoomの影響を受けるため、変換解除してから描画するのが無難だが、
        // 簡易的に全画面覆うために大きな矩形を描くか、変換リセットするか。
        // ここでは変換リセットして描画
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        // スライダー操作中は近いフレームのスケルトンを表示
        const nearestFrameData = data.frames.find(f => f.frame === nearestCachedFrame);
        if (nearestFrameData) {
          drawSkeletonOrKeypoints(ctx, nearestFrameData.keypoints, nearestCachedFrame, true, state.pointSize, state.pointAlpha);
        }
      }
    }

    // 古い seeked ハンドラがあれば解除
    if (pendingSeekedHandler) {
      video.removeEventListener('seeked', pendingSeekedHandler);
      pendingSeekedHandler = null;
    }

    const requestedFrame = state.currentFrame;

    // キャッシュがない場合は動画から描画
    const seekThreshold = 1 / fps;
    const isTimeSynced = Math.abs(video.currentTime - targetTime) <= seekThreshold;

    if (!isTimeSynced) {
      // フレーム位置が異なる場合はシーク
      let seekTimeout = null;

      const onSeeked = () => {
        if (seekTimeout) clearTimeout(seekTimeout);
        video.removeEventListener('seeked', onSeeked);
        pendingSeekedHandler = null;

        // すでに別フレームに移動していれば描画しない
        if (state.currentFrame !== requestedFrame) {
          return;
        }

        drawContent(video);
      };

      pendingSeekedHandler = onSeeked;
      video.addEventListener('seeked', onSeeked);

      // フォールバック: 200ms以内にseekedが発火しなければ強制描画
      seekTimeout = setTimeout(() => {
        if (pendingSeekedHandler === onSeeked) {

          video.removeEventListener('seeked', onSeeked);
          pendingSeekedHandler = null;
          if (state.currentFrame === requestedFrame) {
            drawContent(video);
          }
        }
      }, 200);

      // シーク中は現在の表示を維持（クリアしない）
      video.currentTime = targetTime;
    } else {
      // フレーム位置が近い場合は即座に描画
      drawContent(video);
    }
  }

  elements.previewImage.style.display = 'none';
  elements.previewVideo.style.display = 'none';
  elements.skeletonCanvas.style.display = 'none';
  canvas.style.display = 'block';

  // スケルトンオーバーレイ（Worker使用時）も表示状態にする
  if (state.skeletonRenderer && elements.skeletonOverlayCanvas) {
    if (state.digitizeMode || state.digitizeDragging) {
      elements.skeletonOverlayCanvas.style.display = 'none';
    } else {
      elements.skeletonOverlayCanvas.style.display = 'block';
    }
  }
}

// ヘルパー関数: スケルトン描画の振り分け
function drawSkeletonOrKeypoints(ctx, keypoints, frame, forceMain = false, pointSize = 5, pointAlpha = 0.7, lineWidth = 2) {
  // デジタイズモード中、または強制メインスレッド描画の場合は従来通り
  // デジタイズ中はハイライト処理などがあるためメインスレッドで描画した方が安全
  if (forceMain || state.digitizeMode || state.digitizeDragging || !state.skeletonRenderer) {
    // Workerオーバーレイをクリア/非表示にする
    if (state.skeletonRenderer) {
      state.skeletonRenderer.clear();
      // またはCSSで非表示にしているが、clearしておくと安心
    }
    // メインスレッドで描画（ctxは既にズーム・パン適用済み）
    drawKeypoints(ctx, keypoints, pointSize, pointAlpha, lineWidth);
  } else {
    // Workerで描画
    // zoom, pan情報を渡す
    state.skeletonRenderer.draw(keypoints, frame, {
      zoom: state.videoZoom,
      panX: state.videoPanX,
      panY: state.videoPanY,
      pointSize: pointSize,
      pointAlpha: pointAlpha,
      lineWidth: lineWidth
    });
  }
}

// 最も近いキャッシュ済みフレームを探す
function findNearestCachedFrame(targetFrame) {
  if (!state.frameCache || state.frameCache.length === 0) return null;

  // 前後のフレームを探す範囲
  for (let offset = 1; offset <= CONSTANTS.NEAREST_FRAME_SEARCH_RANGE; offset++) {
    if (state.frameCache[targetFrame - offset]) {
      return targetFrame - offset;
    }
    if (state.frameCache[targetFrame + offset]) {
      return targetFrame + offset;
    }
  }
  return null;
}

function drawKeypoints(ctx, keypoints, pointSize = 5, pointAlpha = 0.7, lineWidth = 2) {
  Object.entries(keypoints).forEach(([personId, kpts], idx) => {
    // 削除済み人物（全キーポイントの信頼度が0以下）をスキップ
    const hasValidKeypoint = kpts.some(kp => kp && kp[2] > 0);
    if (!hasValidKeypoint) return;

    const personColor = PERSON_COLORS[idx % PERSON_COLORS.length];

    // Bounding box
    const bbox = calculateBoundingBox(kpts);
    if (bbox) {
      ctx.strokeStyle = personColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
      ctx.setLineDash([]);

      // Label
      const labelText = `Person ${personId}`;
      ctx.font = 'bold 16px Arial';
      const textWidth = ctx.measureText(labelText).width;

      ctx.fillStyle = personColor;
      ctx.fillRect(bbox.x, bbox.y - 24, textWidth + 10, 22);

      ctx.fillStyle = '#000';
      ctx.fillText(labelText, bbox.x + 5, bbox.y - 8);
    }

    const keypointsMap = {};
    getActiveKeypointNames().forEach((name, i) => {
      keypointsMap[name] = kpts[i];
    });

    // Skeleton lines
    ctx.lineWidth = lineWidth;
    getActiveSkeletonConnections().forEach(([start, end]) => {
      const p1 = keypointsMap[start];
      const p2 = keypointsMap[end];
      if (p1 && p2 && p1[2] > 0.3 && p2[2] > 0.3) {
        ctx.strokeStyle = getLineColor(start, end);
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.stroke();
      }
    });

    // Keypoints（フレームデジタイズの選択キーポイントを黄色で強調）
    getActiveKeypointNames().forEach((name, i) => {
      const kp = kpts[i];
      if (kp && kp[2] > 0.3) {
        // フレームデジタイズモードで選択されているか確認
        const isFrameDigitizeTarget =
          elements.enableDigitize && elements.enableDigitize.checked &&
          elements.digitizeMode && elements.digitizeMode.value === 'frame' &&
          state.digitizePersonId === personId &&
          state.digitizeKeypointIdx === i;

        if (isFrameDigitizeTarget) {
          // 黄色で強調表示
          ctx.fillStyle = `rgba(255, 255, 0, ${pointAlpha})`;
          ctx.beginPath();
          ctx.arc(kp[0], kp[1], pointSize * 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#FF0000';
          ctx.lineWidth = lineWidth;
          ctx.stroke();
        } else {
          // 通常表示
          const baseColor = getPointColor(name);
          // 透過度適用（簡易）
          if (baseColor.startsWith('#')) {
            const r = parseInt(baseColor.slice(1, 3), 16);
            const g = parseInt(baseColor.slice(3, 5), 16);
            const b = parseInt(baseColor.slice(5, 7), 16);
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${pointAlpha})`;
          } else {
            ctx.fillStyle = baseColor;
          }

          ctx.beginPath();
          ctx.arc(kp[0], kp[1], pointSize, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1.0, pointAlpha + 0.2)})`; // 枠線も少し透過
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    });
  });
}

function calculateBoundingBox(kpts) {
  const validPoints = kpts.filter(kp => kp && kp[2] > 0.3);
  if (validPoints.length === 0) return null;

  const xs = validPoints.map(kp => kp[0]);
  const ys = validPoints.map(kp => kp[1]);

  const padding = 20;
  return {
    x: Math.min(...xs) - padding,
    y: Math.min(...ys) - padding,
    width: Math.max(...xs) - Math.min(...xs) + padding * 2,
    height: Math.max(...ys) - Math.min(...ys) + padding * 2
  };
}

function isRightSide(name) {
  return name.startsWith('right') || name.startsWith('r_') || name === 'rshoulder' ||
         name.startsWith('R_');
}
function isLeftSide(name) {
  return name.startsWith('left') || name.startsWith('l_') || name === 'lshoulder' ||
         name.startsWith('L_');
}

function getPointColor(name) {
  if (isRightSide(name)) return COLORS.right;
  if (isLeftSide(name)) return COLORS.left;
  return COLORS.center;
}

function getLineColor(start, end) {
  if (isRightSide(start) && isRightSide(end)) return COLORS.right;
  if (isLeftSide(start) && isLeftSide(end)) return COLORS.left;
  return COLORS.center;
}

// ===================================
// Video Playback
// ===================================
function startPlayback() {
  if (!state.videoResult) return;

  // 再生中はキャッシュ処理を停止
  if (state.isCaching) {
    state.isCaching = false;
  }

  state.isPlaying = true;
  elements.btnPlay.textContent = '⏸️';

  const fps = state.videoResult.fps || 30;
  const frameDuration = 1000 / (fps * state.playbackSpeed);

  let lastFrameTime = performance.now();
  let accumulatedTime = 0;

  // 再生開始時にプリロードを開始
  if (state.extractedFramesDir) {
    preloadVideoFrames(state.currentFrame);
  }

  const playbackLoop = (currentTime) => {
    if (!state.isPlaying) return;

    const deltaTime = currentTime - lastFrameTime;
    lastFrameTime = currentTime;
    accumulatedTime += deltaTime;

    if (accumulatedTime >= frameDuration) {
      const framesToAdvance = Math.floor(accumulatedTime / frameDuration);
      accumulatedTime -= framesToAdvance * frameDuration;
      state.currentFrame += framesToAdvance;

      if (state.currentFrame > state.videoResult.processed_frames) {
        state.currentFrame = 1;
        accumulatedTime = 0;
      }

      updateFrameInfo();

      // モードに応じて描画
      if (state.viewMode === 'skeleton') {
        drawSkeletonOnly();
      } else {
        // 抽出フレームがあれば使用、なければ従来の方式
        if (state.extractedFramesDir) {
          drawExtractedFrame();
          // 再生に合わせてプリロード（30フレームに1回程度チェック）
          if (state.currentFrame % 30 === 0) {
            preloadVideoFrames(state.currentFrame);
          }
        } else {
          drawVideoFrame();
        }
      }

      // グラフモード時のプレビュー更新
      if (state.viewMode === 'graph') {
        if (state.graphMode === 'list') {
          drawGraphList();
        } else {
          drawGraph();
        }
        drawSkeletonPreview();
      }
    }

    state.playbackAnimationId = requestAnimationFrame(playbackLoop);
  };

  state.playbackAnimationId = requestAnimationFrame(playbackLoop);
}

// フレーム画像のプリロード（先読み）
function preloadVideoFrames(startFrame) {
  if (!state.extractedFramesDir) return;

  const preloadCount = 60; // 2秒分（30fps換算）先読み
  const maxCacheSize = 300; // 最大キャッシュ保持数

  // 古いキャッシュを削除
  if (state.frameImageCache) {
    const keys = Object.keys(state.frameImageCache).map(Number).sort((a, b) => a - b);
    if (keys.length > maxCacheSize) {
      // 現在のフレームより前のキャッシュから削除
      const removeUntil = startFrame - 30; // 少しマージンを持たせる
      for (const frame of keys) {
        if (frame < removeUntil && frame < startFrame) { // ループ再生考慮で単純除去は危険だが、一旦簡易的に
          delete state.frameImageCache[frame];
          // 解放（null代入でGC促進）
          state.frameImageCache[frame] = null;
          delete state.frameImageCache[frame];
        } else {
          break;
        }
      }
      // それでも多すぎれば削除
      if (Object.keys(state.frameImageCache).length > maxCacheSize) {
        // ここは必要に応じて調整
      }
    }
  } else {
    state.frameImageCache = {};
  }

  // 先読み
  for (let i = 0; i < preloadCount; i++) {
    let targetFrame = startFrame + i;

    // 範囲外ならスキップ（短い動画では先読み数未満で終了）
    if (targetFrame > state.videoResult.processed_frames) {
      break; // これ以上先読みしても意味がないので終了
    }

    // 既にキャッシュにあればスキップ
    if (state.frameImageCache[targetFrame]) continue;

    const frameNum = String(targetFrame).padStart(5, '0');
    const framePath = `${state.extractedFramesDir}/frame_${frameNum}.jpg`;

    const img = new Image();
    img.src = `file://${framePath}`;
    state.frameImageCache[targetFrame] = img;
  }
}

// 抽出フレーム画像を使用した描画
function drawExtractedFrame() {
  // 骨格モードの場合は drawSkeletonOnly にリダイレクト
  if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
    return;
  }

  const data = getCurrentData();
  if (!data || !state.extractedFramesDir) return;

  const canvas = elements.resultCanvas;
  const ctx = canvas.getContext('2d');

  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (!frameData) return;

  // フレーム画像のパス
  const frameNum = String(state.currentFrame).padStart(5, '0');
  const framePath = `${state.extractedFramesDir}/frame_${frameNum}.jpg`;

  // キャッシュを確認
  let img = state.frameImageCache && state.frameImageCache[state.currentFrame];

  // キャッシュにあってもロード完了していない場合があるのでチェック (img.complete)
  if (img && img.complete) {
    drawFrameImage(ctx, canvas, img, frameData);
    return;
  }

  // キャッシュにない、またはロード中の場合
  if (!img) {
    img = new Image();
    img.src = `file://${framePath}`;
    // キャッシュに登録（次回以降のため）
    if (!state.frameImageCache) state.frameImageCache = {};
    state.frameImageCache[state.currentFrame] = img;

    // プリロードもトリガーしておく（このフレーム周辺がロードされていない可能性が高い）
    preloadVideoFrames(state.currentFrame);
  }

  // ロード完了を待って描画
  img.onload = () => {
    // 描画時点でまだ同じフレームなら描画
    if (state.currentFrame === parseInt(frameNum)) {
      drawFrameImage(ctx, canvas, img, frameData);
    }
  };
  img.onerror = () => {
    // フォールバック: 従来の動画シーク方式
    drawVideoFrame();
  };
}

// フレーム画像を描画
function drawFrameImage(ctx, canvas, img, frameData) {
  // キャンバスサイズをコンテナに合わせる
  const container = canvas.parentElement;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  const cWidth = Math.floor(containerRect.width);
  const cHeight = Math.floor(containerRect.height);

  // コンテナサイズが0の場合はスキップ
  if (cWidth > 0 && cHeight > 0) {
    if (canvas.width !== cWidth || canvas.height !== cHeight) {
      canvas.width = cWidth;
      canvas.height = cHeight;
      // リサイズ時
    }
  }

  // 初期ズーム・パン計算（未初期化の場合）
  if (!state.videoZoomInitialized && cWidth > 0 && cHeight > 0 && img.width > 0) {
    const iw = img.width || 1;
    const ih = img.height || 1;
    const fitScale = Math.min(cWidth / iw, cHeight / ih);
    state.videoZoom = Number.isFinite(fitScale) ? fitScale : 1.0;
    state.videoFitScale = state.videoZoom;
    state.videoPanX = (cWidth - iw * state.videoZoom) / 2;
    state.videoPanY = (cHeight - ih * state.videoZoom) / 2;
    state.videoZoomInitialized = true;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(state.videoZoom, 0, 0, state.videoZoom, state.videoPanX, state.videoPanY);

  ctx.drawImage(img, 0, 0);

  // スケルトン表示がONの場合のみ描画
  if (state.showSkeleton && frameData) {
    drawKeypoints(ctx, frameData.keypoints, state.pointSize, state.pointAlpha, state.lineWidth);
  }

  state.lastDrawnFrame = state.currentFrame;

  elements.previewImage.style.display = 'none';
  elements.previewVideo.style.display = 'none';
  elements.skeletonCanvas.style.display = 'none';
  if (elements.skeletonOverlayCanvas) {
    elements.skeletonOverlayCanvas.style.display = 'none';
  }
  canvas.style.display = 'block';
}

// キャッシュを使用した同期描画（再生中に使用）
function drawVideoFrameSync() {
  const data = getCurrentData();
  if (!data) return;

  const canvas = elements.resultCanvas;
  const ctx = canvas.getContext('2d');

  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (!frameData) return;

  const video = elements.previewVideo;

  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  if (state.frameCache[state.currentFrame]) {
    ctx.drawImage(state.frameCache[state.currentFrame], 0, 0);
    // スケルトン表示がONの場合のみ描画
    if (state.showSkeleton) {
      drawKeypoints(ctx, frameData.keypoints, state.pointSize, state.pointAlpha, state.lineWidth);
    }
    state.lastDrawnFrame = state.currentFrame;
  }

  elements.previewImage.style.display = 'none';
  elements.previewVideo.style.display = 'none';
  elements.skeletonCanvas.style.display = 'none';
  canvas.style.display = 'block';
}

// コールバック付き描画（シーク完了後にコールバックを呼ぶ）
function drawVideoFrameWithCallback(callback) {
  const data = getCurrentData();
  if (!data) {
    callback();
    return;
  }

  const canvas = elements.resultCanvas;
  const ctx = canvas.getContext('2d');

  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (!frameData) {
    callback();
    return;
  }

  const video = elements.previewVideo;

  if (video.videoWidth === 0 || video.videoHeight === 0) {
    callback();
    return;
  }

  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  const fps = data.fps || 30;
  const targetTime = (state.currentFrame - 1) / fps;
  const requestedFrame = state.currentFrame;

  // 古い seeked ハンドラがあれば解除
  if (pendingSeekedHandler) {
    video.removeEventListener('seeked', pendingSeekedHandler);
    pendingSeekedHandler = null;
  }

  const onSeeked = () => {
    video.removeEventListener('seeked', onSeeked);
    pendingSeekedHandler = null;

    // すでに別フレームに移動していれば描画しない
    if (state.currentFrame !== requestedFrame) {
      callback();
      return;
    }

    ctx.drawImage(video, 0, 0);
    // スケルトン表示がONの場合のみ描画
    if (state.showSkeleton) {
      drawKeypoints(ctx, frameData.keypoints, state.pointSize, state.pointAlpha, state.lineWidth);
    }
    state.lastDrawnFrame = state.currentFrame;

    elements.previewImage.style.display = 'none';
    elements.previewVideo.style.display = 'none';
    elements.skeletonCanvas.style.display = 'none';
    canvas.style.display = 'block';

    callback();
  };

  pendingSeekedHandler = onSeeked;
  video.addEventListener('seeked', onSeeked);
  video.currentTime = targetTime;
}

function stopPlayback() {
  state.isPlaying = false;
  elements.btnPlay.textContent = '▶️';

  if (state.playInterval) {
    clearInterval(state.playInterval);
    state.playInterval = null;
  }
  if (state.playbackAnimationId) {
    cancelAnimationFrame(state.playbackAnimationId);
    state.playbackAnimationId = null;
  }
}

function togglePlayback() {
  if (state.isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function goToFrame(frame) {
  const data = getCurrentData();
  if (!data) return;

  // キャッシュは isSliderDragging フラグで自動的に一時停止するため、
  // ここで明示的に中断する必要はない

  state.currentFrame = Math.max(1, Math.min(frame, data.processed_frames));
  updateFrameInfo();

  // 表示モードに応じて描画
  if (state.viewMode === 'graph') {
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    drawSkeletonPreview();
  } else if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
  } else {
    drawVideoFrame();
  }
}

function updateFrameInfo() {
  elements.frameSlider.value = state.currentFrame;
  elements.frameInfo.textContent = `フレーム: ${state.currentFrame} / ${state.videoResult.processed_frames}`;
  const time = (state.currentFrame - 1) / (state.videoResult.fps || 30);
  elements.timeInfo.textContent = `${time.toFixed(2)}秒`;
}

// ===================================
// 手動デジタイズ（キーポイント編集）
// ===================================

const KEYPOINT_HIT_RADIUS = 20; // キーポイントのヒット判定半径（ピクセル、ズーム1.0時）

function findKeypointAtPosition(x, y) {
  /**
   * 実座標(x, y)にあるキーポイントを検出
   * 注: x, y は既にズーム・パン変換済みの実座標を受け取る
   * Returns: {personId, keypointIdx, keypoint} or null
   */
  const data = getCurrentData();
  if (!data || !data.frames) return null;

  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (!frameData || !frameData.keypoints) return null;

  // ズームを考慮したヒット判定半径（拡大時は小さく、縮小時は大きく）
  const adjustedRadius = KEYPOINT_HIT_RADIUS / state.videoZoom;

  let closestPoint = null;
  let minDistance = Infinity;

  // 各人物の各キーポイントをチェック
  for (const [personId, kpts] of Object.entries(frameData.keypoints)) {
    for (let i = 0; i < kpts.length; i++) {
      const kp = kpts[i];
      if (kp && kp[2] > 0.1) { // 信頼度が低くても編集可能にする
        const dx = x - kp[0];
        const dy = y - kp[1];
        const distance = Math.sqrt(dx * dx + dy * dy);

        // 範囲内で、かつこれまでで最も近いポイントを探す
        if (distance <= adjustedRadius && distance < minDistance) {
          minDistance = distance;
          closestPoint = { personId, keypointIdx: i, keypoint: kp };
        }
      }
    }
  }
  return closestPoint;
}

function updateKeypointPosition(personId, keypointIdx, newX, newY) {
  /**
   * キーポイントの位置を更新
   */
  const data = getCurrentData();
  if (!data || !data.frames) return false;

  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (!frameData || !frameData.keypoints || !frameData.keypoints[personId]) return false;

  const kpts = frameData.keypoints[personId];
  if (keypointIdx >= kpts.length) return false;

  const oldKp = kpts[keypointIdx];
  // 値が変更されていない場合は何もしない
  if (oldKp[0] === newX && oldKp[1] === newY) return false;

  // 編集履歴を保存（軽量な差分のみ保存）
  // ドラッグ中は最初の1回だけ保存したいが、move中は連続して呼ばれる
  // digitizeDraggingフラグで制御している呼び出し元(mousemove)では履歴保存しないようにする
  // click (frame digitize) の場合は即保存
  if (!state.digitizeDragging) {
    state.editHistory.push({
      type: 'point',
      frame: state.currentFrame,
      personId: personId,
      keypointIdx: keypointIdx,
      oldValue: { x: oldKp[0], y: oldKp[1], c: oldKp[2] },
      newValue: { x: newX, y: newY, c: 1.0 }
    });
    elements.undoEdit.disabled = false;
  } else if (!state.isEditing) {
    // ドラッグ開始時（state.isEditingフラグなどで管理が必要だが、
    // 現状は digitizeDragging が true になる直前に保存するのが理想。
    // しかし mouse down で履歴保存するのは難しいので、
    // ドラッグ終了時に保存するか、ドラッグ開始直後の初回更新で保存する。
    // ここでは簡易的にドラッグ中は履歴保存をスキップし、mouseup時に何か処理が必要かもしれないが
    // 実装が複雑になるため、ドラッグ操作のUndoは「ドラッグ前の位置に戻す」1回分とするのが一般的。
    // 現状のコード構造だとmousemoveで連続更新されるため、ドラッグ開始位置を別途保持して
    // mouseupで履歴追加するのがベスト。
    // ただし今回は既存ロジックへの影響を最小限にするため、
    // ドラッグ開始時の値を保存する仕組みを導入する。
  }

  // 座標を更新（信頼度は1.0に設定 = 手動編集）
  kpts[keypointIdx][0] = newX;
  kpts[keypointIdx][1] = newY;
  kpts[keypointIdx][2] = 1.0;

  return true;
}

// ドラッグ開始時の値を保持する変数
let dragStartValues = null;

// mouse down イベントリスナー内などで初期化が必要だが、
// 既存コードを変えずに対応するため、state.digitizeDragging が true になったタイミングを検知する
// 既存の mousedown イベント内で処理を追加するのが良い。
// 後ほど initDigitizeEvents を修正する。

function updateDigitizePersonList() {
  /**
   * デジタイズ用：cleansingTargetPersonの現在値をdigitizePersonIdに設定し、キーポイントリストを更新
   */
  const personIds = getPersonIds();

  // cleansingTargetPersonの値を使用
  if (elements.cleansingTargetPerson && personIds.length > 0) {
    state.digitizePersonId = elements.cleansingTargetPerson.value || personIds[0];
    updateDigitizeKeypointList();
  }
}

function updateDigitizeKeypointList() {
  /**
   * デジタイズ対象キーポイントドロップダウンを更新
   */
  elements.digitizeKeypoint.innerHTML = '<option value="">キーポイントを選択</option>';

  getActiveKeypointNamesJP().forEach((nameJp, idx) => {
    const option = document.createElement('option');
    option.value = idx;
    option.textContent = `${idx + 1}: ${nameJp}`;
    elements.digitizeKeypoint.appendChild(option);
  });
}

// ===================================
// クレンジングタブ切替
// ===================================
function initCleansingTabs() {
  const tabs = document.querySelectorAll('.cleansing-tab');
  if (tabs.length === 0) return;
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // タブ状態
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // コンテンツ状態
      const targetId = tab.getAttribute('data-tab');
      document.querySelectorAll('.cleansing-tab-content').forEach(c => c.classList.remove('active'));
      const target = document.getElementById(targetId);
      if (target) target.classList.add('active');
    });
  });
}

// ===================================
// フレーム再推定
// ===================================
function initRedetectEvents() {
  const slider = document.getElementById('redetectConfThreshold');
  const valueDisplay = document.getElementById('redetectConfValue');
  const redetectBtn = document.getElementById('redetectCurrentFrame');

  if (slider && valueDisplay) {
    slider.addEventListener('input', () => {
      valueDisplay.textContent = parseFloat(slider.value).toFixed(2);
    });
  }

  if (redetectBtn) {
    redetectBtn.addEventListener('click', redetectCurrentFrame);
  }
}

async function redetectCurrentFrame() {
  console.log('[Redetect] Button clicked. videoResult:', !!state.videoResult, 'filePath:', state.filePath);
  if (!state.videoResult) {
    showError('推定結果がありません');
    return;
  }

  const currentFrame = state.currentFrame;
  const confThreshold = parseFloat(document.getElementById('redetectConfThreshold')?.value) || 0.25;
  const redetectBtn = document.getElementById('redetectCurrentFrame');

  // キャッシュ済みフレーム画像のパスを取得（動画ファイルを開き直すより確実）
  let frameImagePath = null;
  if (state.extractedFramesDir) {
    const paddedFrame = String(currentFrame).padStart(5, '0');
    const candidatePath = `${state.extractedFramesDir}/frame_${paddedFrame}.jpg`;
    const exists = await window.electronAPI.checkPathExists(candidatePath);
    if (exists) {
      frameImagePath = candidatePath;
    }
  }

  if (!frameImagePath && !state.filePath) {
    showError('フレーム画像が見つかりません');
    return;
  }

  try {
    // ボタンを無効化
    if (redetectBtn) {
      redetectBtn.disabled = true;
      redetectBtn.innerHTML = `
        <svg class="icon spin" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30 70"></circle>
        </svg>
        再推定中...
      `;
    }

    console.log(`[Redetect] Frame ${currentFrame}, image: ${frameImagePath || 'video'}, threshold: ${confThreshold}`);

    // キャッシュ画像があればdetect_image、なければdetect_frame（動画から抽出）
    let result;
    if (frameImagePath) {
      result = await window.electronAPI.pythonRequest('detect_image', {
        file_path: frameImagePath,
        confidence_threshold: confThreshold,
        output_format: state.outputFormat || '23pts'
      });
    } else {
      result = await window.electronAPI.pythonRequest('detect_frame', {
        file_path: state.filePath,
        frame_number: currentFrame,
        confidence_threshold: confThreshold,
        output_format: state.outputFormat || '23pts'
      });
    }

    if (!result.success) {
      throw new Error(result.error || '再推定に失敗しました');
    }

    const detectionResult = result.data;
    console.log(`[Redetect] Detected ${detectionResult.num_persons} persons`);

    // 現在のフレームのキーポイントを更新
    const frameData = state.videoResult.frames.find(f => f.frame === currentFrame);
    if (frameData) {
      // 既存のキーポイントを新しい検出結果で置き換え
      // 人物IDのマッピングを試みる（既存IDを優先）
      const existingIds = Object.keys(frameData.keypoints || {});
      const newKeypoints = {};

      // 新しい検出結果を割り当て
      let newIdCounter = 1;
      for (const [personId, kpts] of Object.entries(detectionResult.keypoints)) {
        // 既存のIDがあればそれを使う、なければ新しいIDを割り当て
        let assignedId;
        if (existingIds.length > 0) {
          assignedId = existingIds.shift();
        } else {
          // 新しい人物が検出された場合
          while (state.videoResult.frames.some(f => f.keypoints && f.keypoints[`Person ${newIdCounter}`])) {
            newIdCounter++;
          }
          assignedId = `Person ${newIdCounter}`;
          newIdCounter++;
        }
        newKeypoints[assignedId] = kpts;
      }

      frameData.keypoints = newKeypoints;

      // キャッシュをクリアして再描画
      clearFrameCache();

      if (state.viewMode === 'skeleton') {
        drawSkeletonOnly();
      } else {
        drawVideoFrame();
      }

      // 人物リストを更新
      updatePersonSelect();

      console.log(`[Redetect] Frame ${currentFrame} updated with ${Object.keys(newKeypoints).length} persons`);

      // 成功メッセージ（短時間表示）
      showSuccess(`フレーム ${currentFrame} を再推定しました（${detectionResult.num_persons}人検出）`);
    }

  } catch (e) {
    console.error('[Redetect] Error:', e);
    showError(`再推定エラー: ${e.message}`);
  } finally {
    // ボタンを復元
    if (redetectBtn) {
      redetectBtn.disabled = false;
      redetectBtn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        現在フレームを再推定
      `;
    }
  }
}

// 成功メッセージ表示（短時間）
function showSuccess(message) {
  // 既存のエラー表示機構を流用（緑色で表示）
  const existingToast = document.querySelector('.success-toast');
  if (existingToast) existingToast.remove();

  const toast = document.createElement('div');
  toast.className = 'success-toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: #059669;
    color: white;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    z-index: 10000;
    font-size: 0.9rem;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

function initDigitizeEvents() {
  /**
   * キャンバスにデジタイズ用のマウスイベントを設定
   */
  const canvas = elements.resultCanvas;

  canvas.addEventListener('mousedown', (e) => {
    if (!state.digitizeMode || state.isPlaying) return;
    if (e.button !== 0) return; // 左クリックのみ

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    // 内部解像度に変換
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    // ズーム・パンを考慮した実座標を計算（videoPanX/Yは内部座標系）
    const x = (mouseX - state.videoPanX) / state.videoZoom;
    const y = (mouseY - state.videoPanY) / state.videoZoom;

    // フレームデジタイズモード
    if (state.digitizeType === 'frame') {
      if (!state.digitizePersonId || state.digitizeKeypointIdx === null) {
        showError('⚠️ 対象人物とキーポイントを選択してください');
        setTimeout(hideError, 2000);
        return;
      }

      // 座標を設定
      const success = updateKeypointPosition(state.digitizePersonId, state.digitizeKeypointIdx, x, y);
      if (success) {
        // 再描画
        clearFrameCache();
        drawVideoFrame();

        // 次のフレームに自動で進む
        const data = getCurrentData();
        if (data && state.currentFrame < data.processed_frames) {
          setTimeout(() => {
            goToFrame(state.currentFrame + 1);
          }, 50);
        }
      }
      e.preventDefault();
      return;
    }

    // ポイント移動モード（既存の処理）
    const hit = findKeypointAtPosition(x, y);
    if (hit) {
      state.digitizeDragging = true;
      state.digitizeTarget = { personId: hit.personId, keypointIdx: hit.keypointIdx };
      state.digitizeStartX = x;
      state.digitizeStartY = y;

      // ドラッグ開始時の値を保存（履歴用）
      dragStartValues = {
        x: hit.keypoint[0],
        y: hit.keypoint[1],
        c: hit.keypoint[2]
      };

      canvas.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!state.digitizeMode) return;
    if (state.digitizeType === 'frame') return; // フレームデジタイズモードはドラッグ不要

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    // 内部解像度に変換
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    // ズーム・パンを考慮した実座標を計算
    const x = (mouseX - state.videoPanX) / state.videoZoom;
    const y = (mouseY - state.videoPanY) / state.videoZoom;

    if (state.digitizeDragging && state.digitizeTarget) {
      // ドラッグ中：キーポイントを移動
      // ここでは履歴保存せずに値だけ更新する
      const { personId, keypointIdx } = state.digitizeTarget;
      const data = getCurrentData();
      if (data && data.frames) {
        const frameData = data.frames.find(f => f.frame === state.currentFrame);
        if (frameData && frameData.keypoints[personId]) {
          const kpts = frameData.keypoints[personId];
          kpts[keypointIdx][0] = x;
          kpts[keypointIdx][1] = y;
          kpts[keypointIdx][2] = 1.0;
        }
      }

      // 再描画（キャッシュを使わない）
      drawVideoFrameWithoutCache();
    } else {
      // ホバー時：カーソルを変更
      const hit = findKeypointAtPosition(x, y);
      canvas.style.cursor = hit ? 'grab' : 'crosshair';
    }
  });

  canvas.addEventListener('mouseup', (e) => {
    if (state.digitizeDragging) {
      // ドラッグ終了時に履歴を保存
      if (dragStartValues && state.digitizeTarget) {
        // 最終的な位置を取得
        const data = getCurrentData();
        const { personId, keypointIdx } = state.digitizeTarget;
        const frameData = data.frames.find(f => f.frame === state.currentFrame);
        const currentKp = frameData.keypoints[personId][keypointIdx];

        // 値が変わっていれば保存
        if (currentKp[0] !== dragStartValues.x || currentKp[1] !== dragStartValues.y) {
          state.editHistory.push({
            type: 'point',
            frame: state.currentFrame,
            personId: personId,
            keypointIdx: keypointIdx,
            oldValue: dragStartValues,
            newValue: { x: currentKp[0], y: currentKp[1], c: currentKp[2] }
          });
          elements.undoEdit.disabled = false;
        }
      }

      state.digitizeDragging = false;
      state.digitizeTarget = null;
      dragStartValues = null;

      canvas.style.cursor = state.digitizeMode ? 'crosshair' : 'default';

      clearFrameCache();
      drawVideoFrame();
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (state.digitizeDragging) {
      // キャンバス外に出た場合も履歴保存して終了
      if (dragStartValues && state.digitizeTarget) {
        const data = getCurrentData();
        const { personId, keypointIdx } = state.digitizeTarget;
        const frameData = data.frames.find(f => f.frame === state.currentFrame);
        const currentKp = frameData.keypoints[personId][keypointIdx];

        if (currentKp[0] !== dragStartValues.x || currentKp[1] !== dragStartValues.y) {
          state.editHistory.push({
            type: 'point',
            frame: state.currentFrame,
            personId: personId,
            keypointIdx: keypointIdx,
            oldValue: dragStartValues,
            newValue: { x: currentKp[0], y: currentKp[1], c: currentKp[2] }
          });
          elements.undoEdit.disabled = false;
        }
      }

      state.digitizeDragging = false;
      state.digitizeTarget = null;
      dragStartValues = null;

      canvas.style.cursor = 'default';
    }
    if (state.videoPanning) {
      state.videoPanning = false;
      canvas.style.cursor = 'default';
    }
  });

  // ホイールズーム（マウス位置中心）
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    // 内部解像度に変換
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    // ズーム前のマウス位置（キャンバス内部座標系）
    const beforeZoomX = (mouseX - state.videoPanX) / state.videoZoom;
    const beforeZoomY = (mouseY - state.videoPanY) / state.videoZoom;

    // フィットスケール（100%）= 映像がキャンバスにぴったり収まる倍率
    // videoFitScale は drawVideoFrame / drawSkeletonOnly の初期化時に保存された値を使う
    const fitScale = state.videoFitScale || 0.5;

    // ズーム倍率を変更（上スクロール：拡大、下スクロール：縮小）
    const zoomDelta = e.deltaY < 0 ? 1.1 : 0.9;
    let newZoom = Math.min(10, state.videoZoom * zoomDelta);

    // 100%（フィットスケール）より縮小しようとしたらフィットにリセット
    if (newZoom <= fitScale) {
      newZoom = fitScale;
      // フィット時は中央配置（内部座標系）
      state.videoPanX = (canvas.width - (elements.previewVideo.videoWidth || 1) * newZoom) / 2;
      state.videoPanY = (canvas.height - (elements.previewVideo.videoHeight || 1) * newZoom) / 2;
      state.videoZoom = newZoom;
    } else {
      // ズーム後のパン位置を調整（マウス位置を中心に）
      state.videoPanX = mouseX - beforeZoomX * newZoom;
      state.videoPanY = mouseY - beforeZoomY * newZoom;
      state.videoZoom = newZoom;
    }

    drawVideoFrame();
  }, { passive: false });

  // ミドルクリックまたは右クリックでパン開始
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1 || e.button === 2) { // ミドル or 右クリック
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      // 内部解像度でのマウス位置
      const mouseX = (e.clientX - rect.left) * scaleX;
      const mouseY = (e.clientY - rect.top) * scaleY;

      state.videoPanning = true;
      // 現在のPanとの差分を保持（内部座標系）
      state.videoPanStartX = mouseX - state.videoPanX;
      state.videoPanStartY = mouseY - state.videoPanY;
      canvas.style.cursor = 'grabbing';
    }
  });

  // パン移動
  canvas.addEventListener('mousemove', (e) => {
    if (state.videoPanning) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      // 内部解像度でのマウス位置
      const mouseX = (e.clientX - rect.left) * scaleX;
      const mouseY = (e.clientY - rect.top) * scaleY;

      state.videoPanX = mouseX - state.videoPanStartX;
      state.videoPanY = mouseY - state.videoPanStartY;
      drawVideoFrame();
    }
  });

  // パン終了
  canvas.addEventListener('mouseup', (e) => {
    if ((e.button === 1 || e.button === 2) && state.videoPanning) {
      state.videoPanning = false;
      canvas.style.cursor = state.digitizeMode ? 'crosshair' : 'default';
    }
  });

  // コンテキストメニュー（右クリックメニュー）を無効化
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // ダブルクリックでズームリセット
  canvas.addEventListener('dblclick', (e) => {
    if (!state.digitizeMode) {
      state.videoZoom = 1.0;
      state.videoPanX = 0;
      state.videoPanY = 0;
      drawVideoFrame();
    }
  });
}

function drawVideoFrameWithoutCache() {
  /**
   * キャッシュを使わずに現在フレームを描画（デジタイズ用）
   */
  const data = getCurrentData();
  if (!data) return;

  const canvas = elements.resultCanvas;
  const ctx = canvas.getContext('2d');
  const video = elements.previewVideo;

  if (video.readyState < 1 || video.videoWidth === 0 || video.videoHeight === 0) return;

  // キャンバスサイズをコンテナに合わせる (無限キャンバス対応)
  const container = canvas.parentElement;
  if (container) {
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
    }
  }

  // ズーム・パンをリセットしてから描画
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ズーム・パン変換を適用
  ctx.setTransform(state.videoZoom, 0, 0, state.videoZoom, state.videoPanX, state.videoPanY);

  // フレーム画像キャッシュがあれば優先使用（ドラッグ中の描画安定化）
  if (state.extractedFramesDir) {
    const frameNum = String(state.currentFrame).padStart(5, '0');
    let img = state.frameImageCache && state.frameImageCache[state.currentFrame];
    if (img && img.complete) {
      ctx.drawImage(img, 0, 0);
    } else {
      ctx.drawImage(video, 0, 0);
    }
  } else {
    // 動画フレームを描画
    ctx.drawImage(video, 0, 0);
  }

  // キーポイントを描画（ドラッグ中のポイントをハイライト）
  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (frameData) {
    drawKeypointsWithHighlight(ctx, frameData.keypoints, state.digitizeTarget, state.pointSize, state.pointAlpha, state.lineWidth);
  }

  elements.previewImage.style.display = 'none';
  elements.previewVideo.style.display = 'none';
  elements.skeletonCanvas.style.display = 'none';
  canvas.style.display = 'block';
}

function drawKeypointsWithHighlight(ctx, keypoints, highlightTarget, pointSize, pointAlpha, lineWidth) {
  /**
   * キーポイントを描画（ドラッグ中のポイントをハイライト）
   */
  // デフォルト値
  pointSize = pointSize || 5;
  pointAlpha = pointAlpha || 0.7;
  lineWidth = lineWidth || 2;

  Object.entries(keypoints).forEach(([personId, kpts], idx) => {
    const personColor = PERSON_COLORS[idx % PERSON_COLORS.length];

    // Bounding box
    const bbox = calculateBoundingBox(kpts);
    if (bbox) {
      ctx.strokeStyle = personColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
      ctx.setLineDash([]);

      const labelText = `Person ${personId}`;
      ctx.font = 'bold 16px Arial';
      const textWidth = ctx.measureText(labelText).width;

      ctx.fillStyle = personColor;
      ctx.fillRect(bbox.x, bbox.y - 24, textWidth + 10, 22);

      ctx.fillStyle = '#000';
      ctx.fillText(labelText, bbox.x + 5, bbox.y - 8);
    }

    const keypointsMap = {};
    getActiveKeypointNames().forEach((name, i) => {
      keypointsMap[name] = kpts[i];
    });

    // Skeleton lines
    ctx.lineWidth = lineWidth;
    getActiveSkeletonConnections().forEach(([start, end]) => {
      const p1 = keypointsMap[start];
      const p2 = keypointsMap[end];
      if (p1 && p2 && p1[2] > 0.3 && p2[2] > 0.3) {
        ctx.strokeStyle = getLineColor(start, end);
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.stroke();
      }
    });

    // Keypoints（ハイライト対応）
    getActiveKeypointNames().forEach((name, i) => {
      const kp = kpts[i];
      if (kp && kp[2] > 0.1) { // 信頼度が低くても表示
        const isHighlighted = highlightTarget &&
          highlightTarget.personId === personId &&
          highlightTarget.keypointIdx === i;

        if (isHighlighted) {
          ctx.fillStyle = `rgba(255, 215, 0, ${pointAlpha})`; // Gold
          ctx.beginPath();
          ctx.arc(kp[0], kp[1], pointSize * 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#FF0000';
          ctx.lineWidth = lineWidth;
          ctx.stroke();
        } else {
          const baseColor = getPointColor(name);
          if (baseColor.startsWith('#')) {
            const r = parseInt(baseColor.slice(1, 3), 16);
            const g = parseInt(baseColor.slice(3, 5), 16);
            const b = parseInt(baseColor.slice(5, 7), 16);
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${pointAlpha})`;
          } else {
            ctx.fillStyle = baseColor;
          }
          ctx.beginPath();
          ctx.arc(kp[0], kp[1], pointSize, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1.0, pointAlpha + 0.2)})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    });
  });
}

// ===================================
// Limb Swap（左右脚・腕入替）
// ===================================

// キーポイントインデックス定義（23点形式）
const RIGHT_ARM_INDICES = [0, 1, 2, 3];    // right_hand_tip, right_wrist, right_elbow, right_shoulder
const LEFT_ARM_INDICES = [4, 5, 6, 7];      // left_hand_tip, left_wrist, left_elbow, left_shoulder
const RIGHT_LEG_INDICES = [8, 9, 10, 11, 12, 13];   // right_toe_tip ~ right_hip
const LEFT_LEG_INDICES = [14, 15, 16, 17, 18, 19];  // left_toe_tip ~ left_hip

function swapLimbs(limbType) {
  const data = getCurrentData();
  if (!data || !data.frames) {
    showError('データがありません');
    return;
  }

  const currentFrame = state.currentFrame;
  const personIds = getPersonIds();

  if (personIds.length === 0) {
    showError('人物が検出されていません');
    return;
  }

  // 対象の人物（データクレンジングで選択された人物）
  const targetPersonId = elements.cleansingTargetPerson?.value || personIds[0];

  // 対象のインデックスを決定
  let rightIndices, leftIndices, limbName;
  if (limbType === 'legs') {
    rightIndices = RIGHT_LEG_INDICES;
    leftIndices = LEFT_LEG_INDICES;
    limbName = '左右脚';
  } else if (limbType === 'arms') {
    rightIndices = RIGHT_ARM_INDICES;
    leftIndices = LEFT_ARM_INDICES;
    limbName = '左右腕';
  } else {
    showError('不明な入替タイプです');
    return;
  }

  // 編集履歴を保存（軽量なアクション情報のみ保存）
  state.editHistory.push({
    type: 'swapLimbs',
    frame: currentFrame, // 開始フレーム
    personId: targetPersonId,
    limbType: limbType
  });
  elements.undoEdit.disabled = false;

  performSwapLimbs(data, targetPersonId, currentFrame, rightIndices, leftIndices);

  // キャッシュをクリアして再描画
  clearFrameCache();

  if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
  } else {
    drawVideoFrame();
  }

  if (state.viewMode === 'graph') {
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    drawSkeletonPreview();
  }

  showError(`✅ Person ${targetPersonId} の${limbName}をフレーム ${currentFrame} 以降で入れ替えました`);
  setTimeout(hideError, 3000);
}

// 実際に入れ替え処理を行う関数（Undoでも再利用可能）
function performSwapLimbs(data, personId, startFrame, rightIndices, leftIndices) {
  let swappedCount = 0;
  for (let i = 0; i < data.frames.length; i++) {
    const frameData = data.frames[i];
    if (frameData.frame >= startFrame && frameData.keypoints[personId]) {
      const keypoints = frameData.keypoints[personId];

      // 左右のキーポイントを入れ替え
      for (let j = 0; j < rightIndices.length && j < leftIndices.length; j++) {
        const rightIdx = rightIndices[j];
        const leftIdx = leftIndices[j];

        if (rightIdx < keypoints.length && leftIdx < keypoints.length) {
          const temp = [...keypoints[rightIdx]];
          keypoints[rightIdx] = [...keypoints[leftIdx]];
          keypoints[leftIdx] = temp;
        }
      }
      swappedCount++;
    }
  }
  return swappedCount;
}

// ===================================
// Bulk Delete Persons
// ===================================

function openBulkDeleteModal() {
  const data = getCurrentData();
  if (!data || !data.frames) {
    showError('データがありません');
    return;
  }

  const personIds = getPersonIds();
  if (personIds.length === 0) {
    showError('削除する人物がありません');
    return;
  }

  // 人物リストを生成
  const listContainer = elements.bulkDeletePersonList;
  listContainer.innerHTML = '';

  // 各人物の出現フレーム数をカウント
  const personFrameCounts = {};
  for (const frame of data.frames) {
    if (frame.keypoints) {
      for (const personId of Object.keys(frame.keypoints)) {
        personFrameCounts[personId] = (personFrameCounts[personId] || 0) + 1;
      }
    }
  }

  personIds.forEach(personId => {
    const frameCount = personFrameCounts[personId] || 0;
    const item = document.createElement('div');
    item.style.cssText = 'display: flex; align-items: center; padding: 0.5rem; border-bottom: 1px solid #374151;';
    item.innerHTML = `
      <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; flex: 1;">
        <input type="checkbox" class="bulk-delete-checkbox" value="${personId}">
        <span style="flex: 1;">${personId}</span>
        <span style="color: #9ca3af; font-size: 0.8rem;">${frameCount}フレーム</span>
      </label>
    `;
    listContainer.appendChild(item);
  });

  // モーダルを表示
  elements.bulkDeleteModal.classList.add('active');
  elements.bulkDeleteModal.style.display = 'flex';
}

function closeBulkDeleteModal() {
  elements.bulkDeleteModal.classList.remove('active');
  elements.bulkDeleteModal.style.display = 'none';
}

function bulkDeleteSelectAll() {
  const checkboxes = elements.bulkDeletePersonList.querySelectorAll('.bulk-delete-checkbox');
  checkboxes.forEach(cb => cb.checked = true);
}

function bulkDeleteDeselectAll() {
  const checkboxes = elements.bulkDeletePersonList.querySelectorAll('.bulk-delete-checkbox');
  checkboxes.forEach(cb => cb.checked = false);
}

function confirmBulkDelete() {
  const checkboxes = elements.bulkDeletePersonList.querySelectorAll('.bulk-delete-checkbox:checked');
  const personIdsToDelete = Array.from(checkboxes).map(cb => cb.value);

  if (personIdsToDelete.length === 0) {
    showError('削除する人物を選択してください');
    return;
  }

  // 確認
  if (!confirm(`${personIdsToDelete.length}人の人物データを削除しますか？\n\n削除対象: ${personIdsToDelete.join(', ')}\n\nこの操作は元に戻せません。`)) {
    return;
  }

  // 削除実行
  const data = getCurrentData();
  let deletedCount = 0;

  for (const frame of data.frames) {
    if (frame.keypoints) {
      for (const personId of personIdsToDelete) {
        if (frame.keypoints[personId]) {
          delete frame.keypoints[personId];
          deletedCount++;
        }
      }
    }
  }

  console.log(`[BulkDelete] Deleted ${deletedCount} person-frame entries for: ${personIdsToDelete.join(', ')}`);

  // UI更新
  closeBulkDeleteModal();
  updatePersonSelect();       // エクスポート用ドロップダウン
  updateSwapPersonSelects();  // データクレンジング用ドロップダウン
  updateGraphPersonSelect();  // グラフ用ドロップダウン
  clearFrameCache();

  if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
  } else {
    drawVideoFrame();
  }

  if (state.viewMode === 'graph') {
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    drawSkeletonPreview();
  }

  showError(`✅ ${personIdsToDelete.length}人の人物を削除しました`);
  setTimeout(hideError, 3000);
}

// ===================================
// Filtering
// ===================================
async function applyFiltering() {
  if (!state.videoResult) return;

  const fps = parseFloat(elements.videoFps.value) || 30;

  // フィルタは編集済みデータに適用する（filteredResultがあればそれを使用）
  const sourceData = state.filteredResult || state.videoResult;

  const targetPersonId = elements.cleansingTargetPerson.value;
  if (!targetPersonId) {
    alert('対象人物を選択してください');
    return;
  }

  elements.applyFilter.disabled = true;
  elements.applyFilter.textContent = '⏳ 適用中...';

  try {
    // 選択された人物のデータのみを抽出して送信
    const framesToSend = sourceData.frames.map(f => {
      const kpts = {};
      // targetPersonIdのデータがあれば抽出
      if (f.keypoints && f.keypoints[targetPersonId]) {
        kpts[targetPersonId] = f.keypoints[targetPersonId];
      }
      return {
        frame: f.frame,
        keypoints: kpts
      };
    });

    const res = await window.electronAPI.pythonRequest('filter', {
      frames: framesToSend,
      fps: fps,
      confidence_threshold: 0.3,
      enable_outlier_removal: elements.enableOutlier.checked,
      enable_interpolation: elements.enableInterpolation.checked,
      enable_butterworth: elements.enableButterworth.checked,
      enable_kalman: elements.enableKalman.checked,
      enable_limb_swap_fix: elements.autoFixLimbSwaps.checked,
      // ID統合は推定完了時に自動実行されるため、フィルタリング時は不要
      interpolation_method: localStorage.getItem('interpolationMethod') || 'pchip',
      butterworth_cutoff: parseFloat(localStorage.getItem('butterworthCutoff')) || 6.0,
      butterworth_order: 4,
      max_gap: parseInt(localStorage.getItem('maxGap')) || 50,
      edge_padding: parseInt(localStorage.getItem('edgePadding')) || Math.ceil(fps)
    });

    if (!res.success) {
      throw new Error(res.error || 'Filter API Error');
    }

    const result = res.data;

    if (!result.success) {
      throw new Error(result.error || 'フィルタリングに失敗しました');
    }

    if (!result.frames || result.frames.length === 0) {
      throw new Error('フィルタリング結果が空です');
    }

    // ID統合の結果をログ
    if (result.id_mapping && Object.keys(result.id_mapping).length > 0) {
      console.log('[Filter] ID consolidation mapping:', result.id_mapping);
      for (const [oldId, newId] of Object.entries(result.id_mapping)) {
        console.log(`  ${oldId} -> ${newId}`);
      }
    }

    // 結果をマージ
    // filteredResult がなければ初期化
    if (!state.filteredResult) {
      state.filteredResult = JSON.parse(JSON.stringify(state.videoResult));
    }

    // 対象人物のデータのみを更新
    result.frames.forEach(resFrame => {
      const targetFrame = state.filteredResult.frames.find(f => f.frame === resFrame.frame);
      if (targetFrame) {
        if (!targetFrame.keypoints) targetFrame.keypoints = {};

        // APIから返ってきたデータで上書き
        if (resFrame.keypoints && resFrame.keypoints[targetPersonId]) {
          targetFrame.keypoints[targetPersonId] = resFrame.keypoints[targetPersonId];
        } else {
          // API結果にない場合（削除された場合など）は削除すべきか？
          // データがない場合は空配列かキーなしで返ってくる
          // ここではキーが存在しない場合は削除せず、存在する場合のみ更新する安全策をとる
          // (もしフィルタで全削除されたら [0,0,0] のリストが返ってくるはず)
        }
      }
    });

    // 人物リストを更新（ID統合後の変更を反映）
    updatePersonSelect();

    // 適用後は filteredResult を使用して再描画
    drawVideoFrame();
    if (state.viewMode === 'graph') {
      if (state.graphMode === 'list') {
        drawGraphList();
      } else {
        drawGraph();
      }
      drawSkeletonPreview();
    }

    // 成功メッセージ（ID統合情報を含む）
    const idMergeCount = result.id_mapping ? Object.keys(result.id_mapping).length : 0;
    const msg = idMergeCount > 0
      ? `✅ フィルタを適用しました（${idMergeCount}件のIDを統合）`
      : '✅ フィルタを適用しました';
    showError(msg);
    setTimeout(hideError, 3000);

  } catch (e) {
    console.error('Filter error:', e);
    const errorMsg = e.message || 'フィルタエラーが発生しました';
    showError(`フィルタエラー: ${errorMsg}`);
  } finally {
    elements.applyFilter.disabled = false;
    elements.applyFilter.textContent = '🔄 フィルタ適用';
    updateStepGuide();
  }
}

// 現在のデータソース（フィルタ適用後があればそれを使う）
function getCurrentData() {
  return state.filteredResult || state.videoResult;
}

// ===================================
// View Mode
// ===================================
function setViewMode(mode) {
  state.viewMode = mode;

  // ボタンのアクティブ状態を更新
  elements.viewVideo.classList.toggle('active', mode === 'video');
  elements.viewSkeleton.classList.toggle('active', mode === 'skeleton');
  elements.viewGraph.classList.toggle('active', mode === 'graph');

  // 動画/骨格モード用 編集ツールバーの表示切替
  const videoEditToolbar = document.getElementById('videoEditToolbar');
  if (videoEditToolbar) {
    // 推定結果があり、動画/骨格モードのときのみ表示
    const vr = state.videoResult || state.filteredResult;
    const hasData = vr && vr.frames && vr.frames.length > 0;
    videoEditToolbar.style.display = (mode !== 'graph' && hasData) ? '' : 'none';
  }

  // 表示切替
  if (mode === 'graph') {
    elements.previewContainer.style.display = 'none';
    elements.graphContainer.style.display = 'flex';
    // スケルトンプレビューを表示（closeProject後に非表示のままになる問題を修正）
    if (elements.skeletonPreview) {
      elements.skeletonPreview.style.display = 'flex';
    }
    // グラフモードに入る際はスケルトンプレビューを再センタリング
    state.skeletonPreviewCentered = false;
    // グラフの人物選択をデータクレンジング対象人物と同期
    if (elements.cleansingTargetPerson && elements.graphPerson) {
      elements.graphPerson.value = elements.cleansingTargetPerson.value;
    }
    // グラフモードに応じて描画
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    // DOMレイアウト完了後にリセットボタンをクリック（バウンディングボックス中心にセンタリング）
    // DOMレイアウト完了後にセンタリング（即座に呼び出し）
    requestAnimationFrame(() => {
      resetPreviewView();
    });
  } else {
    elements.previewContainer.style.display = 'block';
    elements.graphContainer.style.display = 'none';

    // DOMレイアウト完了後に描画（1フレーム待つ）
    requestAnimationFrame(() => {
      if (mode === 'skeleton') {
        drawSkeletonOnly();
      } else {
        drawVideoFrame();
      }
    });
  }
}

function drawSkeletonOnly() {
  const data = getCurrentData();
  if (!data) return;

  const canvas = elements.resultCanvas;
  const ctx = canvas.getContext('2d');
  const video = elements.previewVideo;


  // 動画のメタデータが読み込まれているか確認（動画モードのみ）
  if (state.fileType === 'video') {
    if (video.readyState < 1 || video.videoWidth === 0 || video.videoHeight === 0) {
      video.addEventListener('loadedmetadata', () => {
        drawSkeletonOnly();
      }, { once: true });
      return;
    }
  }

  // キャンバスサイズをコンテナに合わせる（無限キャンバス対応）
  const container = canvas.parentElement;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  const cWidth = Math.floor(containerRect.width);
  const cHeight = Math.floor(containerRect.height);

  // コンテナサイズが0の場合はスキップ
  if (cWidth > 0 && cHeight > 0) {
    if (canvas.width !== cWidth || canvas.height !== cHeight) {
      canvas.width = cWidth;
      canvas.height = cHeight;
      state.videoZoomInitialized = false;
    }
  }

  // 初期ズーム・パン計算（未初期化の場合）
  if (!state.videoZoomInitialized && cWidth > 0 && cHeight > 0) {
    let vw = video.videoWidth || 1;
    let vh = video.videoHeight || 1;
    if (state.fileType === 'image' && elements.previewImage.naturalWidth) {
      vw = elements.previewImage.naturalWidth;
      vh = elements.previewImage.naturalHeight;
    } else if (state.videoResult && state.videoResult.width) {
      vw = state.videoResult.width;
      vh = state.videoResult.height;
    }

    const fitScale = Math.min(cWidth / vw, cHeight / vh);
    state.videoZoom = Number.isFinite(fitScale) ? fitScale : 1.0;
    state.videoFitScale = state.videoZoom;
    state.videoPanX = (cWidth - vw * state.videoZoom) / 2;
    state.videoPanY = (cHeight - vh * state.videoZoom) / 2;
    state.videoZoomInitialized = true;
  }

  // ズーム・パンをリセットしてからクリア
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 黒背景を描画（動画の代わり）
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ズーム・パン変換を適用
  ctx.setTransform(state.videoZoom, 0, 0, state.videoZoom, state.videoPanX, state.videoPanY);

  // スケルトンを描画（動画キャンバスに直接描画）
  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (frameData) {
    drawSkeletonOrKeypoints(ctx, frameData.keypoints, state.currentFrame, true, state.pointSize, state.pointAlpha, state.lineWidth);
  }

  // 表示切替
  elements.previewImage.style.display = 'none';
  elements.previewVideo.style.display = 'none';
  elements.skeletonCanvas.style.display = 'none';
  canvas.style.display = 'block';

  // skeletonOverlayCanvasは骨格モードでは使用しない（メインキャンバスに直接描画）
  if (elements.skeletonOverlayCanvas) {
    elements.skeletonOverlayCanvas.style.display = 'none';
  }
}

// ===================================
// Graph
// ===================================
function initGraphSelects() {
  // 人物選択を初期化
  const personIds = getPersonIds();
  elements.graphPerson.innerHTML = '<option value="">人物を選択</option>';
  personIds.forEach(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `Person ${id}`;
    elements.graphPerson.appendChild(option);
  });
  if (personIds.length > 0) {
    elements.graphPerson.value = personIds[0];
  }

  // キーポイント選択を初期化（日本語・1始まり）
  elements.graphKeypoint.innerHTML = '<option value="">キーポイントを選択</option>';
  getActiveKeypointNamesJP().forEach((nameJp, idx) => {
    const option = document.createElement('option');
    option.value = idx;
    option.textContent = `${idx + 1}: ${nameJp}`;
    elements.graphKeypoint.appendChild(option);
  });
  // デフォルトは未選択状態（空文字列）
}

// グラフモード切替
function setGraphMode(mode) {
  state.graphMode = mode;

  elements.graphModeList.classList.toggle('active', mode === 'list');
  elements.graphModeDetail.classList.toggle('active', mode === 'detail');

  if (mode === 'list') {
    elements.graphListView.style.display = 'grid';
    elements.graphDetailView.style.display = 'none';
    elements.graphDetailControls.style.display = 'none';
    drawGraphList();
  } else {
    elements.graphListView.style.display = 'none';
    elements.graphDetailView.style.display = 'flex';
    elements.graphDetailControls.style.display = 'flex';
    drawGraph();
  }
  drawSkeletonPreview();
}

// 一覧表示を描画
function drawGraphList() {
  const data = getCurrentData();
  if (!data || !data.frames) return;

  const personId = elements.graphPerson.value;

  if (!personId) {
    elements.graphListView.innerHTML = '<p style="color: #9ca3af; text-align: center; padding: 2rem;">人物を選択してください</p>';
    return;
  }

  elements.graphListView.innerHTML = '';

  // 全キーポイントのグラフを生成
  getActiveKeypointNames().forEach((name, idx) => {
    const item = document.createElement('div');
    item.className = 'graph-list-item';
    if (state.selectedKeypoint === idx) {
      item.classList.add('selected');
    }
    item.dataset.keypointIdx = idx;

    const title = document.createElement('div');
    title.className = 'graph-list-item-title';
    title.textContent = `${idx + 1}: ${getActiveKeypointNamesJP()[idx]}`;

    const canvas = document.createElement('canvas');
    canvas.width = 280;
    canvas.height = 100;

    item.appendChild(title);
    item.appendChild(canvas);
    elements.graphListView.appendChild(item);

    // 小さなグラフを描画
    drawMiniGraph(canvas, personId, idx);

    // クリックで詳細表示
    item.addEventListener('click', () => {
      state.selectedKeypoint = idx;
      elements.graphKeypoint.value = idx;
      // 手動デジタイズの対象キーポイントも同期
      if (elements.digitizeKeypoint) {
        elements.digitizeKeypoint.value = idx;
        state.digitizeKeypointIdx = idx;
      }
      setGraphMode('detail');
      drawSkeletonPreview();
    });
  });

  // フレーム情報更新
  elements.graphFrameInfo.textContent = `フレーム: ${state.currentFrame} / ${data.processed_frames}`;
}

// ミニグラフを描画（X/Y両方を1つのグラフに表示）
function drawMiniGraph(canvas, personId, keypointIdx) {
  const data = getCurrentData();
  if (!data || !data.frames) return;

  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  // X/Yデータ抽出
  const xValues = [];
  const yValues = [];
  const frames = [];

  data.frames.forEach(frame => {
    if (!frame.keypoints) return;

    const kpts = frame.keypoints[String(personId)] || frame.keypoints[personId];
    if (kpts && kpts[keypointIdx]) {
      const kp = kpts[keypointIdx];
      if (!kp || kp[2] < 0.1 || (kp[0] === 0 && kp[1] === 0)) {
        xValues.push(null);
        yValues.push(null);
      } else {
        xValues.push(kp[0]);
        yValues.push(kp[1]);
      }
      frames.push(frame.frame);
    }
  });

  // 背景
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, width, height);

  const validX = xValues.filter(v => v !== null);
  const validY = yValues.filter(v => v !== null);

  if (validX.length === 0 && validY.length === 0) {
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('データなし', width / 2, height / 2);
    return;
  }

  const padding = { top: 5, right: 5, bottom: 5, left: 5 };
  const graphWidth = width - padding.left - padding.right;
  const graphHeight = height - padding.top - padding.bottom;

  // X/Y共通のスケールを計算
  const allValid = [...validX, ...validY];
  const minValue = Math.min(...allValid);
  const maxValue = Math.max(...allValid);
  const valueRange = maxValue - minValue || 1;

  const minFrame = Math.min(...frames);
  const maxFrame = Math.max(...frames);
  const frameRange = maxFrame - minFrame || 1;

  // X座標ライン（青）
  const xPoints = [];
  xValues.forEach((val, i) => {
    if (val !== null) {
      xPoints.push({ frame: frames[i], value: val });
    }
  });
  if (xPoints.length > 0) {
    ctx.strokeStyle = GRAPH_COLORS.x;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    xPoints.forEach((point, i) => {
      const x = padding.left + ((point.frame - minFrame) / frameRange) * graphWidth;
      const y = padding.top + ((maxValue - point.value) / valueRange) * graphHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Y座標ライン（オレンジ）
  const yPoints = [];
  yValues.forEach((val, i) => {
    if (val !== null) {
      yPoints.push({ frame: frames[i], value: val });
    }
  });
  if (yPoints.length > 0) {
    ctx.strokeStyle = GRAPH_COLORS.y;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    yPoints.forEach((point, i) => {
      const x = padding.left + ((point.frame - minFrame) / frameRange) * graphWidth;
      const y = padding.top + ((maxValue - point.value) / valueRange) * graphHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // 現在フレームの縦線（赤）
  const currentX = padding.left + ((state.currentFrame - minFrame) / frameRange) * graphWidth;
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(currentX, padding.top);
  ctx.lineTo(currentX, padding.top + graphHeight);
  ctx.stroke();
  ctx.setLineDash([]);

  // 凡例を右上に表示
  const legendX = width - 35;
  const legendY = 8;
  ctx.font = '9px Arial';
  // X
  ctx.fillStyle = GRAPH_COLORS.x;
  ctx.fillText('X', legendX, legendY);
  // Y
  ctx.fillStyle = GRAPH_COLORS.y;
  ctx.fillText('Y', legendX + 15, legendY);
}

// 詳細グラフを描画
function drawGraph() {
  const data = getCurrentData();
  if (!data || !data.frames) return;

  const personId = elements.graphPerson.value;
  const keypointIdx = parseInt(elements.graphKeypoint.value);

  if (!personId || isNaN(keypointIdx)) {
    // X座標グラフ
    const canvasX = elements.graphCanvasX;
    const wrapperX = canvasX.parentElement;
    const ctxX = canvasX.getContext('2d');
    canvasX.width = wrapperX.clientWidth;
    canvasX.height = wrapperX.clientHeight;
    ctxX.fillStyle = '#9ca3af';
    ctxX.font = '16px Arial';
    ctxX.textAlign = 'center';
    ctxX.fillText('人物とキーポイントを選択してください', canvasX.width / 2, canvasX.height / 2);

    // Y座標グラフ
    const canvasY = elements.graphCanvasY;
    const wrapperY = canvasY.parentElement;
    const ctxY = canvasY.getContext('2d');
    canvasY.width = wrapperY.clientWidth;
    canvasY.height = wrapperY.clientHeight;
    ctxY.fillStyle = '#9ca3af';
    ctxY.font = '16px Arial';
    ctxY.textAlign = 'center';
    ctxY.fillText('人物とキーポイントを選択してください', canvasY.width / 2, canvasY.height / 2);
    return;
  }

  // タイトル更新
  elements.graphDetailTitle.textContent = `${keypointIdx + 1}: ${getActiveKeypointNamesJP()[keypointIdx]}`;

  // X座標とY座標のデータを抽出
  const xValues = [];
  const yValues = [];
  const frames = [];

  data.frames.forEach(frame => {
    // フレームにkeypointsがない場合はスキップ
    if (!frame.keypoints) return;

    const kpts = frame.keypoints[String(personId)] || frame.keypoints[personId];
    if (kpts && kpts[keypointIdx]) {
      const kp = kpts[keypointIdx];
      // 信頼度が低い、または座標が極端に小さい（ノイズ・負値）の場合はnull（欠損）として扱う
      if (!kp || kp[2] < 0.1 || kp[0] < 10 || kp[1] < 10) {
        xValues.push(null);
        yValues.push(null);
      } else {
        xValues.push(kp[0]);
        yValues.push(kp[1]);
      }
      frames.push(frame.frame);
    }
    // フレームにこのpersonのデータがない場合は何もしない（スパースデータ対応）
  });

  // デバッグ用にデータをstateに保存
  state.lastGraphData = {
    personId,
    keypointIdx,
    frames,
    xValues,
    yValues,
    // 元の生データも参照できるように保持（信頼度確認用）
    rawFrames: data.frames
  };

  if (xValues.length === 0) {
    const canvasX = elements.graphCanvasX;
    const wrapperX = canvasX.parentElement;
    const ctxX = canvasX.getContext('2d');
    canvasX.width = wrapperX.clientWidth;
    canvasX.height = wrapperX.clientHeight;
    ctxX.fillStyle = '#9ca3af';
    ctxX.font = '16px Arial';
    ctxX.textAlign = 'center';
    ctxX.fillText('データがありません', canvasX.width / 2, canvasX.height / 2);

    const canvasY = elements.graphCanvasY;
    const wrapperY = canvasY.parentElement;
    const ctxY = canvasY.getContext('2d');
    canvasY.width = wrapperY.clientWidth;
    canvasY.height = wrapperY.clientHeight;
    ctxY.fillStyle = '#9ca3af';
    ctxY.font = '16px Arial';
    ctxY.textAlign = 'center';
    ctxY.fillText('データがありません', canvasY.width / 2, canvasY.height / 2);
    return;
  }

  // 有効なデータのみ抽出
  const validX = xValues.filter(v => v !== null);
  const validY = yValues.filter(v => v !== null);

  // Y軸範囲とX軸範囲を初期化（初回のみ、またはキーポイント/人物が変更された場合）
  const rangeKey = `${personId}_${keypointIdx}`;
  // 既存の範囲があり、keyが一致する場合は既存の範囲を保持（プロジェクト読み込み時など）
  if (!state.graphYRangeX || state.graphYRangeX.key !== rangeKey) {
    if (validX.length > 0) {
      const xMin = Math.min(...validX);
      const xMax = Math.max(...validX);
      const xRange = xMax - xMin || 1;
      state.graphYRangeX = {
        key: rangeKey,
        min: xMin - xRange * 0.1,  // 10%のマージン
        max: xMax + xRange * 0.1
      };
    } else {
      state.graphYRangeX = { key: rangeKey, min: 0, max: 1 };
    }
  }

  if (!state.graphYRangeY || state.graphYRangeY.key !== rangeKey) {
    if (validY.length > 0) {
      const yMin = Math.min(...validY);
      const yMax = Math.max(...validY);
      const yRange = yMax - yMin || 1;
      state.graphYRangeY = {
        key: rangeKey,
        min: yMin - yRange * 0.1,  // 10%のマージン
        max: yMax + yRange * 0.1
      };
    } else {
      state.graphYRangeY = { key: rangeKey, min: 0, max: 1 };
    }
  }

  // フレームの全体範囲を算出
  const frameMin = Math.min(...frames);
  const frameMax = Math.max(...frames);

  // X座標グラフ用のX軸範囲（フレームは0未満にならない）
  if (!state.graphXRangeX || state.graphXRangeX.key !== rangeKey) {
    state.graphXRangeX = {
      key: rangeKey,
      min: Math.max(0, frameMin),
      max: frameMax
    };
  }

  // Y座標グラフ用のX軸範囲（フレームは0未満にならない）
  if (!state.graphXRangeY || state.graphXRangeY.key !== rangeKey) {
    state.graphXRangeY = {
      key: rangeKey,
      min: Math.max(0, frameMin),
      max: frameMax
    };
  }

  // X座標グラフを描画（X用のX軸範囲）
  drawSingleGraph(elements.graphCanvasX, xValues, frames, 'X', personId, keypointIdx, 'x', state.graphYRangeX, state.graphXRangeX);

  // Y座標グラフを描画（Y用のX軸範囲）
  drawSingleGraph(elements.graphCanvasY, yValues, frames, 'Y', personId, keypointIdx, 'y', state.graphYRangeY, state.graphXRangeY);

  // フレーム情報更新
  elements.graphFrameInfo.textContent = `フレーム: ${state.currentFrame} / ${data.processed_frames}`;

  // 現在値を表示
  const currentFrameData = data.frames.find(f => f.frame === state.currentFrame);
  if (currentFrameData) {
    const kpts = currentFrameData.keypoints[personId];
    if (kpts && kpts[keypointIdx]) {
      elements.graphValueInfo.textContent = `X: ${kpts[keypointIdx][0].toFixed(2)}, Y: ${kpts[keypointIdx][1].toFixed(2)}`;
    }
  }
}

// 単一のグラフを描画
function drawSingleGraph(canvas, values, frames, axisLabel, personId, keypointIdx, axis, yRange = null, xRange = null) {
  const wrapper = canvas.parentElement;
  const ctx = canvas.getContext('2d');

  // Canvas サイズをコンテナに合わせる
  canvas.width = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;

  // グラフ描画設定
  const padding = { top: 30, right: 30, bottom: 50, left: 60 };
  const graphWidth = canvas.width - padding.left - padding.right;
  const graphHeight = canvas.height - padding.top - padding.bottom;

  // Y軸範囲を決定（固定範囲が指定されている場合はそれを使用、なければデータから計算）
  let minValue, maxValue;
  if (yRange) {
    minValue = yRange.min;
    maxValue = yRange.max;
  } else {
    minValue = Math.min(...values);
    maxValue = Math.max(...values);
  }
  const valueRange = maxValue - minValue || 1;

  // X軸範囲を決定（固定範囲が指定されている場合はそれを使用、なければデータから計算）
  let minFrame, maxFrame;
  if (xRange) {
    minFrame = xRange.min;
    maxFrame = xRange.max;
  } else {
    minFrame = Math.min(...frames);
    maxFrame = Math.max(...frames);
  }
  const frameRange = maxFrame - minFrame || 1;

  // 背景
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // グリッド
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1;

  // 横グリッド
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (graphHeight / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + graphWidth, y);
    ctx.stroke();

    // Y軸ラベル
    const val = maxValue - (valueRange / 5) * i;
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px Arial';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(1), padding.left - 10, y + 4);
  }

  // 縦グリッド
  for (let i = 0; i <= 10; i++) {
    const x = padding.left + (graphWidth / 10) * i;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + graphHeight);
    ctx.stroke();

    // X軸ラベル
    const frameNum = Math.round(minFrame + (frameRange / 10) * i);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(frameNum.toString(), x, padding.top + graphHeight + 20);
  }

  // データライン（有効な値のみを使用して描画）
  // グラフ領域にクリッピングを設定（Y軸より左にはみ出さないようにする）
  ctx.save();
  ctx.beginPath();
  ctx.rect(padding.left, padding.top, graphWidth, graphHeight);
  ctx.clip();

  ctx.strokeStyle = axis === 'x' ? GRAPH_COLORS.x : GRAPH_COLORS.y;
  ctx.lineWidth = 2;
  ctx.beginPath();

  // 有効な値のみを抽出してフレーム番号とペアにする
  const validPoints = [];
  values.forEach((val, i) => {
    if (val !== null) {
      validPoints.push({ frame: frames[i], value: val });
    }
  });

  // 有効なポイント間を線で結ぶ
  validPoints.forEach((point, i) => {
    const x = padding.left + ((point.frame - minFrame) / frameRange) * graphWidth;
    const y = padding.top + ((maxValue - point.value) / valueRange) * graphHeight;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  // データポイント（null値はスキップ）
  // データポイント（null値はスキップ）
  const pointColor = axis === 'x' ? GRAPH_COLORS.x : GRAPH_COLORS.y;
  values.forEach((val, i) => {
    if (val === null) return; // null値はスキップ

    const x = padding.left + ((frames[i] - minFrame) / frameRange) * graphWidth;
    const y = padding.top + ((maxValue - val) / valueRange) * graphHeight;

    ctx.fillStyle = frames[i] === state.currentFrame ? '#ef4444' : pointColor;
    ctx.beginPath();
    ctx.arc(x, y, frames[i] === state.currentFrame ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
  });

  // クリッピングを解除
  ctx.restore();

  // 現在フレームの縦線
  const currentX = padding.left + ((state.currentFrame - minFrame) / frameRange) * graphWidth;
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(currentX, padding.top);
  ctx.lineTo(currentX, padding.top + graphHeight);
  ctx.stroke();
  ctx.setLineDash([]);

  // データの実際の範囲を取得（パンニング制限用）
  const dataMinFrame = Math.min(...frames);
  const dataMaxFrame = Math.max(...frames);

  // グラフのクリック・ドラッグ編集用にメタデータを保存
  canvas.graphMeta = {
    padding, graphWidth, graphHeight,
    minValue, maxValue, valueRange,
    minFrame, maxFrame, frameRange,
    dataMinFrame, dataMaxFrame,  // データの実際の範囲
    personId, keypointIdx, axis,
    yRange: yRange,  // Y軸範囲の参照を保存
    xRange: xRange   // X軸範囲の参照を保存
  };
}

// スケルトンプレビューを描画
function drawSkeletonPreview() {
  console.log('[SkeletonPreview] drawSkeletonPreview called');
  const data = getCurrentData();
  if (!data || !data.frames) {
    console.log('[SkeletonPreview] No data or frames');
    return;
  }

  const canvas = elements.skeletonPreviewCanvas;
  const wrapper = elements.skeletonPreviewWrapper;

  const video = elements.previewVideo;

  // 動画のサイズが取得できない場合はデータから推定
  let videoWidth = video.videoWidth;
  let videoHeight = video.videoHeight;

  if (state.fileType === 'image' && elements.previewImage.naturalWidth) {
    videoWidth = elements.previewImage.naturalWidth;
    videoHeight = elements.previewImage.naturalHeight;
  }

  if (!videoWidth || !videoHeight) {
    if (state.videoResult && state.videoResult.width) {
      videoWidth = state.videoResult.width;
      videoHeight = state.videoResult.height;
    }
  }

  if (!videoWidth || !videoHeight) {
    videoWidth = 1920;
    videoHeight = 1080;
  }

  const wrapperRect = wrapper.getBoundingClientRect();
  const canvasWidth = wrapperRect.width;
  const canvasHeight = wrapperRect.height;

  // サイズが0なら何もしない（非表示状態など）
  if (canvasWidth === 0 || canvasHeight === 0) return;

  // キャンバスサイズをコンテナに合わせる
  if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
    if (state.skeletonPreviewRenderer) {
      state.skeletonPreviewRenderer.resize(canvasWidth, canvasHeight);
    } else {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }
  }

  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (!frameData) {
    return;
  }

  // 選択されているキーポイントを取得
  const selectedPersonId = elements.graphPerson.value;
  const selectedKeypointIdx = parseInt(elements.graphKeypoint.value);

  // 「常に中央」が有効または初回の場合、バウンディングボックス中心でセンタリング
  const alwaysCenter = elements.alwaysCenter?.checked;
  if (alwaysCenter || !state.skeletonPreviewCentered) {
    // Wrapperサイズ（表示サイズ）基準で計算する
    // actualCanvasWidth変数は廃止し、canvasWidth/canvasHeightを使用

    // 選択された人物のバウンディングボックスを計算
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasValidPoints = false;

    // 選択された人物のキーポイントを使用（なければ全員）
    const targetKeypoints = selectedPersonId && frameData.keypoints[selectedPersonId]
      ? { [selectedPersonId]: frameData.keypoints[selectedPersonId] }
      : frameData.keypoints;

    Object.values(targetKeypoints).forEach(kpts => {
      if (!kpts) return;
      kpts.forEach(kp => {
        if (kp && kp[2] > 0.3) {
          minX = Math.min(minX, kp[0]);
          minY = Math.min(minY, kp[1]);
          maxX = Math.max(maxX, kp[0]);
          maxY = Math.max(maxY, kp[1]);
          hasValidPoints = true;
        }
      });
    });

    if (hasValidPoints) {
      const bboxWidth = maxX - minX;
      const bboxHeight = maxY - minY;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      // 初回のみズームを計算（「常に中央」でもズームは維持）
      if (!state.skeletonPreviewCentered) {
        const margin = 50;
        const zoomX = (canvasWidth - margin * 2) / bboxWidth;
        const zoomY = (canvasHeight - margin * 2) / bboxHeight;
        state.skeletonZoom = Math.min(zoomX, zoomY, 3.0);
        state.skeletonZoom = Math.max(state.skeletonZoom, 0.5);
      }

      // 中心が画面中央に来るようにパン位置を設定
      state.skeletonPanX = canvasWidth / 2 - centerX * state.skeletonZoom;
      state.skeletonPanY = canvasHeight / 2 - centerY * state.skeletonZoom;
    } else if (!state.skeletonPreviewCentered) {
      // 有効なポイントがない場合、動画中央を表示（初回のみ）
      state.skeletonPanX = canvasWidth / 2 - (videoWidth / 2) * state.skeletonZoom;
      state.skeletonPanY = canvasHeight / 2 - (videoHeight / 2) * state.skeletonZoom;
    }

    state.skeletonPreviewCentered = true;
  }

  // Workerで描画（OffscreenCanvas使用時）
  if (state.skeletonPreviewRenderer) {
    console.log('[SkeletonPreview] Drawing with Worker');
    state.skeletonPreviewRenderer.drawScaled(frameData.keypoints, state.currentFrame, {
      scaleX: 1.0,
      scaleY: 1.0,
      selectedPersonId, selectedKeypointIdx,
      skeletonZoom: state.skeletonZoom,
      panX: state.skeletonPanX,
      panY: state.skeletonPanY,
      offsetX: 0,
      offsetY: 0,
      pointSize: state.pointSize,
      pointAlpha: state.pointAlpha,
      lineWidth: state.lineWidth
    });
  } else {
    // フォールバック（Worker未初期化時など）
    console.log('[SkeletonPreview] Drawing with Fallback (Main Thread)');
    const ctx = canvas.getContext('2d');

    // 背景をクリア
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // パンとズームを適用
    ctx.save();
    ctx.translate(state.skeletonPanX, state.skeletonPanY);
    ctx.scale(state.skeletonZoom, state.skeletonZoom);

    // スケルトンを描画（実サイズ）
    drawScaledKeypoints(ctx, frameData.keypoints, 1.0, 1.0, selectedPersonId, selectedKeypointIdx, state.skeletonZoom, state.pointSize, state.pointAlpha, state.lineWidth);

    ctx.restore();
  }
}

// スケルトンプレビューでのクリックを処理（関節選択）
function handleSkeletonPreviewClick(e) {
  const data = getCurrentData();
  if (!data || !data.frames) return;

  const frameData = data.frames.find(f => f.frame === state.currentFrame);
  if (!frameData) return;

  const canvas = elements.skeletonPreviewCanvas;
  const wrapper = elements.skeletonPreviewWrapper;
  const rect = wrapper.getBoundingClientRect();

  // クリック位置をキャンバス座標に変換
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  // キャンバス座標からスケルトン座標に逆変換
  // panX, panY, skeletonZoomを考慮
  const skeletonX = (clickX - state.skeletonPanX) / state.skeletonZoom;
  const skeletonY = (clickY - state.skeletonPanY) / state.skeletonZoom;

  // 最も近いキーポイントを探す
  let closestPersonId = null;
  let closestKeypointIdx = null;
  let closestDistance = Infinity;
  const hitRadius = 20 / state.skeletonZoom; // ズームを考慮したヒット判定半径

  Object.entries(frameData.keypoints).forEach(([personId, kpts]) => {
    kpts.forEach((kp, idx) => {
      if (kp && kp[2] > 0.3) {
        const dx = kp[0] - skeletonX;
        const dy = kp[1] - skeletonY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < closestDistance && distance < hitRadius) {
          closestDistance = distance;
          closestPersonId = personId;
          closestKeypointIdx = idx;
        }
      }
    });
  });

  if (closestPersonId !== null && closestKeypointIdx !== null) {
    // グラフの人物とキーポイントを選択
    elements.graphPerson.value = closestPersonId;
    elements.graphKeypoint.value = closestKeypointIdx;

    // 手動デジタイズの対象キーポイントも同期
    if (elements.digitizeKeypoint) {
      elements.digitizeKeypoint.value = closestKeypointIdx;
      state.digitizeKeypointIdx = closestKeypointIdx;
    }
    // 対象人物も同期
    state.digitizePersonId = closestPersonId;
    if (elements.cleansingTargetPerson) {
      elements.cleansingTargetPerson.value = closestPersonId;
    }
    // 詳細モードに切り替え
    if (state.graphMode !== 'detail') {
      state.graphMode = 'detail';
      elements.graphModeList.classList.remove('active');
      elements.graphModeDetail.classList.add('active');
      elements.graphListView.style.display = 'none';
      elements.graphDetailView.style.display = 'flex';
      elements.graphDetailControls.style.display = 'flex';
    }

    // グラフタイトル更新
    elements.graphDetailTitle.textContent = `${getActiveKeypointNames()[closestKeypointIdx]} (Person ${closestPersonId})`;

    // グラフを再描画
    drawGraph();

    // スケルトンプレビューを再描画（選択状態を反映）
    drawSkeletonPreview();
  }
}

// スケール適用してキーポイントを描画
// zoomFactor: ctx.scale()でズームが適用されている場合、ポイントサイズを補正するための係数
function drawScaledKeypoints(ctx, keypoints, scaleX, scaleY, selectedPersonId = null, selectedKeypointIdx = null, zoomFactor = 1, pointSize = 5, pointAlpha = 0.7, lineWidth = 2) {
  // ズームによるサイズ拡大を打ち消すための補正係数
  const sizeCompensation = 1 / zoomFactor;

  Object.entries(keypoints).forEach(([personId, kpts], idx) => {
    // 削除済み人物（全キーポイントの信頼度が0以下）をスキップ
    const hasValidKeypoint = kpts.some(kp => kp && kp[2] > 0);
    if (!hasValidKeypoint) return;

    // スケルトンプレビューでは選択した人物のみを表示したいので、
    // selectedPersonId が指定されている場合はそれ以外の人物をスキップ
    if (selectedPersonId && personId !== selectedPersonId) {
      return;
    }
    const personColor = PERSON_COLORS[idx % PERSON_COLORS.length];
    const isSelectedPerson = personId === selectedPersonId;

    // バウンディングボックスとラベル（動画モードと同じ）
    const bbox = calculateBoundingBox(kpts);
    if (bbox) {
      ctx.strokeStyle = personColor;
      ctx.lineWidth = 2 * sizeCompensation;
      ctx.setLineDash([5 * sizeCompensation, 5 * sizeCompensation]);
      ctx.strokeRect(bbox.x * scaleX, bbox.y * scaleY, bbox.width * scaleX, bbox.height * scaleY);
      ctx.setLineDash([]);

      // ラベル
      const labelText = `Person ${personId}`;
      const fontSize = Math.max(12, 16 * sizeCompensation);
      ctx.font = `bold ${fontSize}px Arial`;
      const textWidth = ctx.measureText(labelText).width;

      const labelX = bbox.x * scaleX;
      const labelY = bbox.y * scaleY - 24 * sizeCompensation;
      const labelHeight = 22 * sizeCompensation;

      ctx.fillStyle = personColor;
      ctx.fillRect(labelX, labelY, textWidth + 10 * sizeCompensation, labelHeight);

      ctx.fillStyle = '#000';
      ctx.fillText(labelText, labelX + 5 * sizeCompensation, labelY + labelHeight - 6 * sizeCompensation);
    }

    const keypointsMap = {};
    getActiveKeypointNames().forEach((name, i) => {
      keypointsMap[name] = kpts[i];
    });

    // Skeleton lines（線幅をズームで補正）
    ctx.lineWidth = lineWidth * sizeCompensation;
    getActiveSkeletonConnections().forEach(([start, end]) => {
      const p1 = keypointsMap[start];
      const p2 = keypointsMap[end];
      if (p1 && p2 && p1[2] > 0.3 && p2[2] > 0.3) {
        ctx.strokeStyle = getLineColor(start, end);
        ctx.beginPath();
        ctx.moveTo(p1[0] * scaleX, p1[1] * scaleY);
        ctx.lineTo(p2[0] * scaleX, p2[1] * scaleY);
        ctx.stroke();
      }
    });

    // Keypoints（ポイントサイズをズームで補正）
    getActiveKeypointNames().forEach((name, i) => {
      const kp = kpts[i];
      if (kp && kp[2] > 0.3) {
        const isSelected = isSelectedPerson && i === selectedKeypointIdx;
        const radius = (isSelected ? pointSize * 1.6 : pointSize) * sizeCompensation;
        const glowRadius = (isSelected ? pointSize * 2.4 : 0) * sizeCompensation;

        // 選択ポイントのグロー効果
        if (isSelected) {
          ctx.shadowBlur = 15 * sizeCompensation;
          ctx.shadowColor = '#ffff00';
          ctx.fillStyle = '#ffff00';
        } else {
          ctx.shadowBlur = 0;
          const baseColor = getPointColor(name);
          // applyAlpha関数がないため、ここで簡易的に透過度を適用
          // baseColorは#RRGGBB形式と仮定
          if (baseColor.startsWith('#')) {
            const r = parseInt(baseColor.slice(1, 3), 16);
            const g = parseInt(baseColor.slice(3, 5), 16);
            const b = parseInt(baseColor.slice(5, 7), 16);
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${pointAlpha})`;
          } else {
            ctx.fillStyle = baseColor;
          }
        }

        ctx.beginPath();
        ctx.arc(kp[0] * scaleX, kp[1] * scaleY, radius, 0, Math.PI * 2);
        ctx.fill();

        if (isSelected) {
          // 外側のリング
          ctx.strokeStyle = '#ffff00';
          ctx.lineWidth = lineWidth * sizeCompensation;
          ctx.beginPath();
          ctx.arc(kp[0] * scaleX, kp[1] * scaleY, glowRadius, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1 * sizeCompensation;
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(kp[0] * scaleX, kp[1] * scaleY, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  });
}

// ===================================
// Graph Interaction & Export
// ===================================

function handleGraphMouseDown(e) {
  // X座標またはY座標のどちらのグラフか判定
  const canvasX = elements.graphCanvasX;
  const canvasY = elements.graphCanvasY;
  const rectX = canvasX.getBoundingClientRect();
  const rectY = canvasY.getBoundingClientRect();

  let canvas = null;
  if (e.clientX >= rectX.left && e.clientX <= rectX.right &&
    e.clientY >= rectX.top && e.clientY <= rectX.bottom) {
    canvas = canvasX;
  } else if (e.clientX >= rectY.left && e.clientX <= rectY.right &&
    e.clientY >= rectY.top && e.clientY <= rectY.bottom) {
    canvas = canvasY;
  }

  if (!canvas || !canvas.graphMeta) return;

  // 右クリック：パンニング（ドラッグなしの場合はコンテキストメニュー表示）
  if (e.button === 2) {
    e.preventDefault();
    state.graphPanDidMove = false; // 移動フラグをリセット
    state.graphPanning = true;
    state.graphPanningCanvas = canvas;
    state.graphPanStartX = e.clientX;
    state.graphPanStartY = e.clientY;

    const meta = canvas.graphMeta;
    if (meta && meta.xRange) {
      state.graphPanStartFrame = meta.xRange.min;
    } else {
      state.graphPanStartFrame = 0;
    }

    canvas.style.cursor = 'grabbing';
    elements.graphCanvasX.style.cursor = 'grabbing';
    elements.graphCanvasY.style.cursor = 'grabbing';
    return;
  }

  // 左クリック：編集
  if (e.button === 0) {
    state.graphDragging = true;
    state.isEditing = true;
    elements.graphEditMode.textContent = '編集モード: ON';
    elements.graphEditMode.classList.add('active');

    // ドラッグ編集セッションの開始
    // 変更されたすべてのフレームの履歴を保存するためのMap
    state.dragSession = new Map();
    const meta = canvas.graphMeta;
    if (meta) {
      state.dragSessionMeta = {
        personId: meta.personId,
        keypointIdx: meta.keypointIdx,
        axis: meta.axis
      };
    }

    handleGraphEdit(e, canvas);
  }
}

function handleGraphMouseMove(e) {
  if (state.graphPanning && state.graphPanningCanvas) {
    state.graphPanDidMove = true; // パン操作が発生したことを記録
    const panningCanvas = state.graphPanningCanvas;
    const meta = panningCanvas.graphMeta;

    if (meta && meta.xRange) {
      const deltaX = e.clientX - state.graphPanStartX;
      const deltaFrame = (deltaX / meta.graphWidth) * meta.frameRange;

      const xRange = meta.xRange;
      const currentRange = xRange.max - xRange.min;
      let newMin = state.graphPanStartFrame - deltaFrame;
      let newMax = newMin + currentRange;

      const dataMin = meta.dataMinFrame;
      const dataMax = meta.dataMaxFrame;

      // 最小値は0未満にならない
      if (newMin < 0) {
        newMin = 0;
        newMax = newMin + currentRange;
      }
      if (newMin < dataMin) {
        newMin = dataMin;
        newMax = newMin + currentRange;
      }
      if (newMax > dataMax) {
        newMax = dataMax;
        newMin = newMax - currentRange;
      }
      // 再度0チェック（上記で調整後に0未満になる場合）
      if (newMin < 0) {
        newMin = 0;
      }

      xRange.min = newMin;
      xRange.max = newMax;
    }
    drawGraph();
    return;
  }

  if (state.graphDragging) {
    const canvasX = elements.graphCanvasX;
    const canvasY = elements.graphCanvasY;
    const rectX = canvasX.getBoundingClientRect();
    const rectY = canvasY.getBoundingClientRect();

    let canvas = null;
    if (e.clientX >= rectX.left && e.clientX <= rectX.right &&
      e.clientY >= rectX.top && e.clientY <= rectX.bottom) {
      canvas = canvasX;
    } else if (e.clientX >= rectY.left && e.clientX <= rectY.right &&
      e.clientY >= rectY.top && e.clientY <= rectY.bottom) {
      canvas = canvasY;
    }

    if (canvas) {
      handleGraphEdit(e, canvas);
    }
  }
}

function handleGraphMouseUp(e) {
  if (state.graphPanning) {
    state.graphPanning = false;
    state.graphPanningCanvas = null;
    elements.graphCanvasX.style.cursor = 'crosshair';
    elements.graphCanvasY.style.cursor = 'crosshair';
  }
  if (state.graphDragging) {
    if (state.dragSession && state.dragSession.size > 0 && state.dragSessionMeta) {
      const { personId, keypointIdx, axis } = state.dragSessionMeta;
      const data = getCurrentData();
      const modifications = [];

      if (data) {
        state.dragSession.forEach((oldValue, frame) => {
          const frameData = data.frames.find(f => f.frame === frame);
          if (frameData?.keypoints?.[personId]?.[keypointIdx]) {
            const kpts = frameData.keypoints[personId];
            const newValue = axis === 'x' ? kpts[keypointIdx][0] :
              axis === 'y' ? kpts[keypointIdx][1] :
                kpts[keypointIdx][2];

            if (newValue !== oldValue) {
              modifications.push({ frame, oldValue, newValue });
            }
          }
        });
      }

      if (modifications.length > 0) {
        state.editHistory.push({
          type: 'graphResultPath',
          personId, keypointIdx, axis,
          modifications
        });
        state.redoHistory = [];
        updateUndoRedoUI();
        if (elements.undoEdit) elements.undoEdit.disabled = false;
      }
    }
    state.dragSession = null;
    state.dragSessionMeta = null;
    state.dragStartInfo = null;
    state.graphDragging = false;
  }
}

function handleGraphWheel(e) {
  e.preventDefault();
  e.stopPropagation();

  const canvasX = elements.graphCanvasX;
  const canvasY = elements.graphCanvasY;
  const rectX = canvasX.getBoundingClientRect();
  const rectY = canvasY.getBoundingClientRect();

  let canvas = null;

  if (e.clientX >= rectX.left && e.clientX <= rectX.right &&
    e.clientY >= rectX.top && e.clientY <= rectX.bottom) {
    canvas = canvasX;
  } else if (e.clientX >= rectY.left && e.clientX <= rectY.right &&
    e.clientY >= rectY.top && e.clientY <= rectY.bottom) {
    canvas = canvasY;
  }

  if (!canvas || !canvas.graphMeta) return;

  const meta = canvas.graphMeta;
  const rect = canvas.getBoundingClientRect();
  const mouseY = e.clientY - rect.top;
  const mouseX = e.clientX - rect.left;

  if (mouseY < meta.padding.top || mouseY > meta.padding.top + meta.graphHeight) return;
  if (mouseX < meta.padding.left || mouseX > meta.padding.left + meta.graphWidth) return;

  const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;

  let xRange = null;
  if (canvas === canvasX) {
    xRange = state.graphXRangeX;
  } else if (canvas === canvasY) {
    xRange = state.graphXRangeY;
  }

  if (xRange) {
    const mouseFrame = meta.minFrame + ((mouseX - meta.padding.left) / meta.graphWidth) * meta.frameRange;
    const distanceToMin = mouseFrame - xRange.min;
    const distanceToMax = xRange.max - mouseFrame;

    let newMin = mouseFrame - distanceToMin * zoomFactor;
    let newMax = mouseFrame + distanceToMax * zoomFactor;

    const dataMin = meta.dataMinFrame;
    const dataMax = meta.dataMaxFrame;
    const newRange = newMax - newMin;

    if (newRange < 10) return;

    // 最小値は0未満にならない
    if (newMin < 0) {
      newMin = 0;
      newMax = newMin + newRange;
    }
    if (newMin < dataMin) {
      newMin = dataMin;
      newMax = newMin + newRange;
    }
    if (newMax > dataMax) {
      newMax = dataMax;
      newMin = newMax - newRange;
    }
    // 再度0チェック
    if (newMin < 0) {
      newMin = 0;
    }

    xRange.min = newMin;
    xRange.max = newMax;
  }

  drawGraph();
}

function handleGraphEdit(e, canvas) {
  const meta = canvas.graphMeta;
  if (!meta) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (x < meta.padding.left || x > meta.padding.left + meta.graphWidth) return;
  if (y < meta.padding.top || y > meta.padding.top + meta.graphHeight) return;

  const frameNum = Math.round(meta.minFrame + ((x - meta.padding.left) / meta.graphWidth) * meta.frameRange);
  const newValue = meta.maxValue - ((y - meta.padding.top) / meta.graphHeight) * meta.valueRange;

  const data = getCurrentData();
  if (!data) return;

  const frameData = data.frames.find(f => f.frame === frameNum);
  if (!frameData) return;

  if (!frameData.keypoints[meta.personId]) {
    frameData.keypoints[meta.personId] = [];
  }
  const kpts = frameData.keypoints[meta.personId];

  if (!kpts[meta.keypointIdx]) {
    kpts[meta.keypointIdx] = [0, 0, 0.0];
  }

  // ドラッグセッション中なら、変更前の値を保存（まだ保存していなければ）
  if (state.dragSession && !state.dragSession.has(frameNum)) {
    const oldValue = meta.axis === 'x' ? kpts[meta.keypointIdx][0] :
      meta.axis === 'y' ? kpts[meta.keypointIdx][1] :
        kpts[meta.keypointIdx][2];
    state.dragSession.set(frameNum, oldValue);
  }

  // 履歴への追加はドラッグ終了時(mouseup)に行うためここでは削除
  // state.editHistory.push(...)
  // Redo履歴のクリアやUI更新もmouseupで行う

  // elements.undoEdit.disabled = false; // ここではまだ有効化しない

  if (meta.axis === 'x') {
    kpts[meta.keypointIdx][0] = newValue;
  } else if (meta.axis === 'y') {
    kpts[meta.keypointIdx][1] = newValue;
  } else {
    kpts[meta.keypointIdx][2] = Math.max(0, Math.min(1, newValue));
  }

  drawGraph();
  drawSkeletonPreview();
}

// グラフを強制的に再描画する関数
function forceRedrawGraph() {
  if (state.viewMode === 'graph') {
    // Canvas を強制クリア（widthを再設定するとコンテキストがリセットされる）
    if (elements.graphCanvasX) {
      const parentX = elements.graphCanvasX.parentElement;
      elements.graphCanvasX.width = parentX ? parentX.clientWidth : elements.graphCanvasX.width;
    }
    if (elements.graphCanvasY) {
      const parentY = elements.graphCanvasY.parentElement;
      elements.graphCanvasY.width = parentY ? parentY.clientWidth : elements.graphCanvasY.width;
    }

    // リストグラフのCanvasも同様にクリア
    const listCanvases = document.querySelectorAll('.graph-row canvas');
    listCanvases.forEach(c => {
      const parent = c.parentElement;
      if (parent) c.width = parent.clientWidth;
    });

    // グラフを再描画
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    drawSkeletonPreview();
  } else if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
  } else {
    drawVideoFrame();
  }
}

function updateUndoRedoUI() {
  const canUndo = state.editHistory.length > 0;
  const canRedo = state.redoHistory.length > 0;
  if (elements.undoEdit) elements.undoEdit.disabled = !canUndo;
  if (elements.redoEdit) elements.redoEdit.disabled = !canRedo;
  // 動画/骨格モード用ツールバーも同期
  const vtUndo = document.getElementById('vt-undoEdit');
  const vtRedo = document.getElementById('vt-redoEdit');
  if (vtUndo) vtUndo.disabled = !canUndo;
  if (vtRedo) vtRedo.disabled = !canRedo;
}

function undoEdit() {
  if (state.editHistory.length === 0) return;

  const edit = state.editHistory.pop();
  const data = getCurrentData();
  if (!data) return;

  // Redo用データを作成
  const redoData = JSON.parse(JSON.stringify(edit));

  if (edit.type === 'point') {
    // 座標のUndo（デジタイズ）
    const frameData = data.frames.find(f => f.frame === edit.frame);
    if (frameData && frameData.keypoints[edit.personId]) {
      const kpts = frameData.keypoints[edit.personId];
      if (kpts[edit.keypointIdx]) {
        // 現在の値をRedo用に保存
        redoData.newValue = { x: kpts[edit.keypointIdx][0], y: kpts[edit.keypointIdx][1], c: kpts[edit.keypointIdx][2] };

        kpts[edit.keypointIdx][0] = edit.oldValue.x;
        kpts[edit.keypointIdx][1] = edit.oldValue.y;
        kpts[edit.keypointIdx][2] = edit.oldValue.c;
      }
    }
  } else if (edit.type === 'swapLimbs') {
    // 左右入れ替えのUndo
    const RIGHT_ARM_INDICES = [0, 1, 2, 3];
    const LEFT_ARM_INDICES = [4, 5, 6, 7];
    const RIGHT_LEG_INDICES = [8, 9, 10, 11, 12, 13];
    const LEFT_LEG_INDICES = [14, 15, 16, 17, 18, 19];

    let rightIndices, leftIndices;
    if (edit.limbType === 'legs') {
      rightIndices = RIGHT_LEG_INDICES;
      leftIndices = LEFT_LEG_INDICES;
    } else {
      rightIndices = RIGHT_ARM_INDICES;
      leftIndices = LEFT_ARM_INDICES;
    }

    performSwapLimbs(data, edit.personId, edit.frame, rightIndices, leftIndices);
  } else if (edit.type === 'deleteFrame') {
    // フレーム削除のUndo
    const frameData = data.frames.find(f => f.frame === edit.frame);
    if (frameData) {
      if (!frameData.keypoints) frameData.keypoints = {};
      frameData.keypoints[edit.personId] = edit.keypoints;
    }
  } else if (edit.type === 'deletePerson') {
    // 人物削除のUndo
    Object.entries(edit.allFramesData).forEach(([frameNum, keypoints]) => {
      const frameData = data.frames.find(f => f.frame === parseInt(frameNum));
      if (frameData) {
        if (!frameData.keypoints) frameData.keypoints = {};
        frameData.keypoints[edit.personId] = keypoints;
      }
    });
    initGraphSelects();
  } else if (edit.type === 'deleteRange') {
    // 範囲削除のUndo
    edit.deletedData.forEach(item => {
      const frameData = data.frames.find(f => f.frame === item.frame);
      if (frameData) {
        if (!frameData.keypoints) frameData.keypoints = {};
        frameData.keypoints[edit.personId] = item.keypoints;
      }
    });
  } else if (edit.type === 'graphResultPath') {
    // 軌跡（複数フレーム）のUndo
    edit.modifications.forEach(mod => {
      const frameData = data.frames.find(f => f.frame === mod.frame);
      if (frameData?.keypoints?.[edit.personId]?.[edit.keypointIdx]) {
        const kpts = frameData.keypoints[edit.personId];
        if (edit.axis === 'x') kpts[edit.keypointIdx][0] = mod.oldValue;
        else if (edit.axis === 'y') kpts[edit.keypointIdx][1] = mod.oldValue;
        else kpts[edit.keypointIdx][2] = mod.oldValue;
      }
    });
  } else if (edit.type === 'deleteGraphPoint') {
    // グラフポイント削除のUndo（信頼度を元の値に戻す）
    const frameData = data.frames.find(f => f.frame === edit.frame);
    if (frameData?.keypoints?.[edit.personId]) {
      frameData.keypoints[edit.personId][edit.keypointIdx] = [...edit.oldKp];
    }
  } else if (edit.type === 'graphPoint' || !edit.type) {
    // グラフ編集のUndo（graphPoint タイプまたは旧形式のtypeなし）
    const frameData = data.frames.find(f => f.frame === edit.frame);
    if (frameData && frameData.keypoints[edit.personId]) {
      const kpts = frameData.keypoints[edit.personId];
      if (kpts && kpts[edit.keypointIdx]) {
        // Redo用に保存
        if (edit.axis === 'x') redoData.newValue = kpts[edit.keypointIdx][0];
        else if (edit.axis === 'y') redoData.newValue = kpts[edit.keypointIdx][1];
        else redoData.newValue = kpts[edit.keypointIdx][2];

        if (edit.axis === 'x') {
          kpts[edit.keypointIdx][0] = edit.oldValue;
        } else if (edit.axis === 'y') {
          kpts[edit.keypointIdx][1] = edit.oldValue;
        } else {
          kpts[edit.keypointIdx][2] = edit.oldValue;
        }
      }
    }
  }

  state.redoHistory.push(redoData);
  updateUndoRedoUI();
  clearFrameCache();

  // グラフを強制的に再描画
  forceRedrawGraph();
}

function redoEdit() {
  if (state.redoHistory.length === 0) return;

  const edit = state.redoHistory.pop();
  const data = getCurrentData();
  if (!data) return;

  const undoData = JSON.parse(JSON.stringify(edit)); // Undo用データとして保存

  if (edit.type === 'point') {
    const frameData = data.frames.find(f => f.frame === edit.frame);
    if (frameData?.keypoints?.[edit.personId]?.[edit.keypointIdx] && edit.newValue) {
      frameData.keypoints[edit.personId][edit.keypointIdx][0] = edit.newValue.x;
      frameData.keypoints[edit.personId][edit.keypointIdx][1] = edit.newValue.y;
      frameData.keypoints[edit.personId][edit.keypointIdx][2] = edit.newValue.c;
    }
  } else if (edit.type === 'swapLimbs') {
    // スワップ実行（定義済みの配列を使用または再定義が必要だが、ロジック簡略化のためコピー）
    // ここでは簡略化のため再定義
    const RIGHT_ARM_INDICES = [0, 1, 2, 3];
    const LEFT_ARM_INDICES = [4, 5, 6, 7];
    const RIGHT_LEG_INDICES = [8, 9, 10, 11, 12, 13];
    const LEFT_LEG_INDICES = [14, 15, 16, 17, 18, 19];
    let rightIndices = edit.limbType === 'legs' ? RIGHT_LEG_INDICES : RIGHT_ARM_INDICES;
    let leftIndices = edit.limbType === 'legs' ? LEFT_LEG_INDICES : LEFT_ARM_INDICES;
    performSwapLimbs(data, edit.personId, edit.frame, rightIndices, leftIndices);
  } else if (edit.type === 'deleteFrame') {
    const frameData = data.frames.find(f => f.frame === edit.frame);
    if (frameData && frameData.keypoints) {
      delete frameData.keypoints[edit.personId];
    }
  } else if (edit.type === 'deletePerson') {
    data.frames.forEach(f => {
      if (f.keypoints) delete f.keypoints[edit.personId];
    });
    initGraphSelects();
  } else if (edit.type === 'deleteRange') {
    // 範囲削除のRedo（再度削除）
    edit.deletedData.forEach(item => {
      const frameData = data.frames.find(f => f.frame === item.frame);
      if (frameData && frameData.keypoints) {
        delete frameData.keypoints[edit.personId];
      }
    });
  } else if (edit.type === 'graphResultPath') {
    // 軌跡（複数フレーム）のRedo
    edit.modifications.forEach(mod => {
      const frameData = data.frames.find(f => f.frame === mod.frame);
      if (frameData?.keypoints?.[edit.personId]?.[edit.keypointIdx]) {
        const kpts = frameData.keypoints[edit.personId];
        if (edit.axis === 'x') kpts[edit.keypointIdx][0] = mod.newValue;
        else if (edit.axis === 'y') kpts[edit.keypointIdx][1] = mod.newValue;
        else kpts[edit.keypointIdx][2] = mod.newValue;
      }
    });
  } else if (edit.type === 'deleteGraphPoint') {
    // グラフポイント削除のRedo（再度信頼度を0に）
    const frameData = data.frames.find(f => f.frame === edit.frame);
    if (frameData?.keypoints?.[edit.personId]?.[edit.keypointIdx]) {
      frameData.keypoints[edit.personId][edit.keypointIdx][2] = 0;
    }
  } else if (edit.type === 'graphPoint' || !edit.type) {
    // グラフ編集のRedo（graphPoint タイプまたは旧形式のtypeなし）
    const frameData = data.frames.find(f => f.frame === edit.frame);
    if (frameData?.keypoints?.[edit.personId]?.[edit.keypointIdx] && edit.newValue !== undefined) {
      const kp = frameData.keypoints[edit.personId][edit.keypointIdx];
      if (edit.axis === 'x') kp[0] = edit.newValue;
      else if (edit.axis === 'y') kp[1] = edit.newValue;
      else kp[2] = edit.newValue;
    }
  }

  state.editHistory.push(undoData);
  updateUndoRedoUI();
  clearFrameCache();

  // グラフを強制的に再描画
  forceRedrawGraph();
}

// IPC Undo/Redo
// IPC Undo/Redo
window.electronAPI.onMenuUndo(() => {
  undoEdit();
});

window.electronAPI.onMenuRedo(() => {
  redoEdit();
});



function resetEdits() {
  if (!state.videoResult) return;

  // セッション開始時のベースラインデータに戻す
  if (state.sessionBaselineData) {
    // ベースラインデータを復元（ディープコピー）
    state.filteredResult = JSON.parse(JSON.stringify(state.sessionBaselineData));
    // videoResultも更新（ベースラインがvideoResultと同じ場合の整合性確保）
    state.videoResult = JSON.parse(JSON.stringify(state.sessionBaselineData));
  } else {
    // ベースラインがない場合は従来通りfilteredResultをクリア
    state.filteredResult = null;
  }

  state.editHistory = [];
  state.redoHistory = [];
  state.isEditing = false;

  // Y軸範囲とX軸範囲もリセット
  state.graphYRangeX = null;
  state.graphYRangeY = null;
  state.graphXRangeX = null;
  state.graphXRangeY = null;
  state.graphPanning = false;

  elements.undoEdit.disabled = true;
  elements.graphEditMode.textContent = '編集モード: OFF';
  elements.graphEditMode.classList.remove('active');

  // 人物選択ドロップダウンを更新（人物が削除されている可能性があるため）
  updateSwapPersonSelects();
  initGraphSelects();

  if (state.viewMode === 'graph') {
    // グラフモードに応じて適切な描画関数を呼ぶ
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    drawSkeletonPreview();
  } else if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
  } else {
    drawVideoFrame();
  }
}

// 現在フレームの選択人物のスケルトンデータを削除
function deleteCurrentFrameData() {
  const personId = elements.graphPerson.value;
  if (!personId) {
    alert('人物を選択してください');
    return;
  }

  const data = getCurrentData();
  if (!data || !data.frames) return;

  // filteredResultがなければ作成
  if (!state.filteredResult) {
    state.filteredResult = JSON.parse(JSON.stringify(state.videoResult));
  }

  const frameData = state.filteredResult.frames.find(f => f.frame === state.currentFrame);
  if (!frameData) return;

  if (!frameData.keypoints[personId]) {
    alert(`フレーム ${state.currentFrame} に Person ${personId} のデータがありません`);
    return;
  }

  // 編集履歴に保存
  state.editHistory.push({
    type: 'deleteFrame',
    personId,
    frame: state.currentFrame,
    keypoints: JSON.parse(JSON.stringify(frameData.keypoints[personId]))
  });

  // 全キーポイントを無効化（信頼度を0に）
  frameData.keypoints[personId] = frameData.keypoints[personId].map(kp => {
    if (kp) {
      return [kp[0], kp[1], 0];  // 信頼度を0にして無効化
    }
    return kp;
  });

  state.isEditing = true;
  elements.undoEdit.disabled = false;
  elements.graphEditMode.textContent = '編集モード: ON';
  elements.graphEditMode.classList.add('active');

  // 再描画
  if (state.viewMode === 'graph') {
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    drawSkeletonPreview();
  } else if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
  } else {
    drawVideoFrame();
  }
}

// グラフ上の指定フレームの特定キーポイント1点のみを削除（信頼度=0に設定）
function deleteGraphKeypoint(personId, keypointIdx, frame) {
  if (!state.filteredResult) {
    state.filteredResult = JSON.parse(JSON.stringify(state.videoResult));
  }
  const data = getCurrentData();
  if (!data) return;

  const frameData = data.frames.find(f => f.frame === frame);
  if (!frameData?.keypoints?.[personId]?.[keypointIdx]) return;

  const kp = frameData.keypoints[personId][keypointIdx];

  state.editHistory.push({
    type: 'deleteGraphPoint',
    personId,
    keypointIdx,
    frame,
    oldKp: [...kp]
  });
  state.redoHistory = [];
  updateUndoRedoUI();

  kp[2] = 0;

  state.isEditing = true;
  elements.undoEdit.disabled = false;
  elements.graphEditMode.textContent = '編集モード: ON';
  elements.graphEditMode.classList.add('active');

  clearFrameCache();
  forceRedrawGraph();
}

// グラフコンテキストメニューを表示
function showGraphContextMenu(clientX, clientY, personId, keypointIdx, frame) {
  const menu = elements.graphContextMenu;
  if (!menu) return;
  state.graphContextTarget = { personId, keypointIdx, frame };
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.style.display = 'block';

  // ビューポート外に出ないよう調整
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${clientX - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${clientY - rect.height}px`;
    }
  });
}

// グラフキャンバス上でクリック位置に有効なデータポイントがあればコンテキストメニューを表示
function tryShowGraphContextMenu(e, canvas) {
  const meta = canvas.graphMeta;
  if (!meta || meta.personId === undefined || meta.keypointIdx === undefined) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < meta.padding.left || x > meta.padding.left + meta.graphWidth) return;

  const frameNum = Math.round(meta.minFrame + ((x - meta.padding.left) / meta.graphWidth) * meta.frameRange);
  const data = getCurrentData();
  if (!data) return;

  const frameData = data.frames.find(f => f.frame === frameNum);
  const kp = frameData?.keypoints?.[meta.personId]?.[meta.keypointIdx];
  if (kp && kp[2] >= 0.1) {
    showGraphContextMenu(e.clientX, e.clientY, meta.personId, meta.keypointIdx, frameNum);
  }
}

// 選択人物を全フレームから削除
function deletePersonData() {
  const personId = elements.graphPerson.value;
  if (!personId) {
    alert('人物を選択してください');
    return;
  }

  if (!confirm(`Person ${personId} を全フレームから削除しますか？\n（編集はUndoで戻せます）`)) {
    return;
  }

  const data = getCurrentData();
  if (!data || !data.frames) return;

  // filteredResultがなければ作成
  if (!state.filteredResult) {
    state.filteredResult = JSON.parse(JSON.stringify(state.videoResult));
  }

  // 編集履歴に保存（全フレームのデータを保存）
  const historyData = {};
  state.filteredResult.frames.forEach(frameData => {
    if (frameData.keypoints[personId]) {
      historyData[frameData.frame] = JSON.parse(JSON.stringify(frameData.keypoints[personId]));
    }
  });

  state.editHistory.push({
    type: 'deletePerson',
    personId,
    allFramesData: historyData
  });

  // 全フレームから削除
  state.filteredResult.frames.forEach(frameData => {
    if (frameData.keypoints[personId]) {
      // 全キーポイントを無効化
      frameData.keypoints[personId] = frameData.keypoints[personId].map(kp => {
        if (kp) {
          return [kp[0], kp[1], 0];  // 信頼度を0にして無効化
        }
        return kp;
      });
    }
  });

  state.isEditing = true;
  elements.undoEdit.disabled = false;
  elements.graphEditMode.textContent = '編集モード: ON';
  elements.graphEditMode.classList.add('active');

  // 人物選択を更新
  initGraphSelects();

  // データクレンジングのドロップダウンも更新（対象人物・入替え相手）
  updateSwapPersonSelects();

  // エクスポートパネルのドロップダウンも更新
  updatePersonSelect();

  // 再描画
  if (state.viewMode === 'graph') {
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    drawSkeletonPreview();
  } else if (state.viewMode === 'skeleton') {
    drawSkeletonOnly();
  } else {
    drawVideoFrame();
  }
}

// 指定範囲のデータを削除
function performRangeDelete(direction) {
  const personId = String(elements.graphPerson.value);
  if (!personId) {
    alert('人物を選択してください');
    return;
  }

  if (!confirm(`現在のフレームを${direction === 'before' ? '含めてそれ以前' : '含めてそれ以降'}の全てのデータを削除しますか？\n対象: Person ${personId}`)) {
    return;
  }

  const data = getCurrentData();
  if (!data || !data.frames) return;

  // filteredResultがなければ作成
  if (!state.filteredResult) {
    state.filteredResult = JSON.parse(JSON.stringify(state.videoResult));
  }

  const framesToDelete = []; // Undo用の保存データ
  const currentFrame = state.currentFrame;

  // 削除処理
  state.filteredResult.frames.forEach(f => {
    let shouldDelete = false;
    if (direction === 'before') {
      shouldDelete = f.frame <= currentFrame;
    } else {
      shouldDelete = f.frame >= currentFrame;
    }

    if (shouldDelete && f.keypoints && f.keypoints[personId]) {
      // 削除対象のデータを保存
      framesToDelete.push({
        frame: f.frame,
        keypoints: JSON.parse(JSON.stringify(f.keypoints[personId]))
      });
      // 削除実行
      delete f.keypoints[personId];
    }
  });

  if (framesToDelete.length === 0) {
    alert('削除対象のデータがありませんでした。');
    return;
  }

  // 履歴に追加
  state.editHistory.push({
    type: 'deleteRange',
    direction: direction,
    personId: personId,
    pivotFrame: currentFrame, // 基準フレーム
    deletedData: framesToDelete
  });

  state.redoHistory = []; // 新しい操作をしたのでRedoスタックはクリア
  state.isEditing = true;
  updateUndoRedoUI();

  clearFrameCache();

  if (state.viewMode === 'graph') {
    if (state.graphMode === 'list') drawGraphList(); else drawGraph();
    drawSkeletonPreview();
  } else {
    drawVideoFrame();
  }
}



// ===================================
// Export
// ===================================
async function exportCSV() {
  // 編集済みデータを優先して使用
  let data = state.fileType === 'video' ? getCurrentData() : state.result;

  // 画像モードでも編集データ（videoResult構造）がある場合はそれを利用してデータ構築
  if (state.fileType === 'image' && (state.filteredResult || state.videoResult)) {
    const current = getCurrentData();
    if (current && current.frames && current.frames.length > 0) {
      // 画像は先頭フレームのデータを使用
      const frameData = current.frames[0];
      // 元の構造に合わせる（keypoints: { pid: [...] }）
      data = { keypoints: frameData.keypoints };
    }
  }

  if (!data) return;

  const selectedPerson = elements.personSelect.value;
  const targetIds = selectedPerson === 'all' ? getPersonIds() : [selectedPerson];

  const activeNames = getActiveKeypointNames();
  const xyHeaders = activeNames.map(n => `${n}_x,${n}_y`).join(',');
  const confHeaders = activeNames.map(n => `${n}_conf`).join(',');
  const header = (state.fileType === 'video' ? 'frame,' : '') + xyHeaders + ',' + confHeaders + '\n';

  // 動画と同じディレクトリをデフォルトに
  const videoDir = state.selectedFile?.path ? state.selectedFile.path.replace(/[/\\][^/\\]+$/, '') : '';

  for (const personId of targetIds) {
    let csvContent = header;

    if (state.fileType === 'video') {
      data.frames.forEach(frame => {
        const kpts = frame.keypoints[personId];
        if (kpts) {
          const row = [frame.frame];
          kpts.forEach(kp => row.push(kp[0].toFixed(2), kp[1].toFixed(2)));
          kpts.forEach(kp => row.push(kp[2].toFixed(3)));
          csvContent += row.join(',') + '\n';
        }
      });
    } else {
      const kpts = data.keypoints[personId];
      if (kpts) {
        const row = [];
        kpts.forEach(kp => row.push(kp[0].toFixed(2), kp[1].toFixed(2)));
        kpts.forEach(kp => row.push(kp[2].toFixed(3)));
        csvContent += row.join(',') + '\n';
      }
    }

    const defaultFileName = `${getBaseName()}_person${personId}.csv`;
    const defaultPath = videoDir ? `${videoDir}/${defaultFileName}` : defaultFileName;

    // Electron環境ではsaveFileDialogを使用
    if (window.electronAPI && window.electronAPI.saveFileDialog) {
      const saveResult = await window.electronAPI.saveFileDialog({
        title: 'CSVを保存',
        defaultPath: defaultPath,
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
      });

      if (!saveResult.canceled && saveResult.filePath) {
        // BOMを付与してUTF-8として正しく認識させる
        const csvWithBom = '\uFEFF' + csvContent;
        const result = await window.electronAPI.writeFile(saveResult.filePath, csvWithBom);
        if (result.success) {
          state.exported = true;
          updateStepGuide();
          showError(`✅ CSVを保存しました: ${saveResult.filePath.split(/[/\\]/).pop()}`);
          setTimeout(hideError, 3000);
        } else {
          showError(`❌ CSV保存エラー: ${result.error}`);
        }
      }
    } else {
      // ブラウザ環境ではダウンロード
      downloadFile('\uFEFF' + csvContent, defaultFileName, 'text/csv;charset=utf-8');
    }
  }
}

function exportJSON() {
  // 編集済みデータを優先して使用
  const data = state.fileType === 'video' ? getCurrentData() : state.result;
  if (!data) return;

  const exportData = {
    filename: state.selectedFile?.name,
    keypoint_names: getActiveKeypointNames(),
    output_format: state.outputFormat,
    ...data
  };

  downloadFile(JSON.stringify(exportData, null, 2), `${getBaseName()}.json`, 'application/json');
}

async function exportVideoWithSkeleton() {
  if (!state.videoResult || !state.selectedFile) return;
  if (!window.electronAPI) {
    showError('Electron API not available');
    return;
  }

  // 画像の場合は画像エクスポート処理
  if (state.fileType === 'image') {
    await exportImageWithSkeleton();
    return;
  }

  // 動画と同じディレクトリをデフォルトに
  const videoDir = state.selectedFile?.path ? state.selectedFile.path.replace(/[/\\][^/\\]+$/, '') : '';
  const defaultFileName = `skeleton_${state.selectedFile.name}`;
  const defaultPath = videoDir ? `${videoDir}/${defaultFileName}` : defaultFileName;

  // 保存先を選択
  const saveResult = await window.electronAPI.saveFileDialog({
    title: '骨格付き動画を保存',
    defaultPath: defaultPath,
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
  });

  if (saveResult.canceled || !saveResult.filePath) return;

  elements.exportVideo.disabled = true;
  elements.exportVideo.textContent = '⏳ エクスポート中...';

  try {
    const exportData = getCurrentData() || state.videoResult;
    const videoPath = state.selectedFile.path;

    if (!videoPath) {
      throw new Error('動画ファイルのパスが取得できません');
    }

    // 進捗表示
    if (window.electronAPI.onPythonProgress) {
      window.electronAPI.onPythonProgress((data) => {
        elements.exportVideo.textContent = `⏳ ${data.progress}%...`;
      });
    }

    const res = await window.electronAPI.pythonRequestWithProgress('export_video', {
      video_path: videoPath,
      keypoints_data: exportData,
      output_path: saveResult.filePath
    });

    if (!res.success) {
      throw new Error(res.error || 'Export failed');
    }

    showError(`✅ 動画を保存しました: ${saveResult.filePath.split(/[/\\]/).pop()}`);
    setTimeout(hideError, 3000);

  } catch (e) {
    showError(`エクスポートエラー: ${e.message}`);
  } finally {
    elements.exportVideo.disabled = false;
    elements.exportVideo.textContent = 'オーバーレイ動画を保存';
  }
}

async function exportImageWithSkeleton() {
  // 画像と同じディレクトリをデフォルトに
  const imageDir = state.selectedFile?.path ? state.selectedFile.path.replace(/[/\\][^/\\]+$/, '') : '';
  const baseName = state.selectedFile.name.replace(/\.[^.]+$/, '');
  const defaultFileName = `skeleton_${baseName}.png`;
  const defaultPath = imageDir ? `${imageDir}/${defaultFileName}` : defaultFileName;

  // 保存先を選択
  const saveResult = await window.electronAPI.saveFileDialog({
    title: '骨格付き画像を保存',
    defaultPath: defaultPath,
    filters: [
      { name: 'PNG Image', extensions: ['png'] },
      { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }
    ]
  });

  if (saveResult.canceled || !saveResult.filePath) return;

  elements.exportVideo.disabled = true;
  elements.exportVideo.textContent = '⏳ 保存中...';

  try {
    // resultCanvasの内容を取得
    const canvas = elements.resultCanvas;
    const ext = saveResult.filePath.split('.').pop().toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const quality = ext === 'png' ? 1.0 : 0.95;

    // キャンバスをBlobに変換
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = Array.from(new Uint8Array(arrayBuffer));

    // ファイルに保存（バイナリモード）
    const result = await window.electronAPI.writeFile(saveResult.filePath, uint8Array, true);
    if (!result.success) {
      throw new Error(result.error || '保存に失敗しました');
    }

    showError(`✅ 画像を保存しました: ${saveResult.filePath.split(/[/\\]/).pop()}`);
    setTimeout(hideError, 3000);

  } catch (e) {
    showError(`エクスポートエラー: ${e.message}`);
  } finally {
    elements.exportVideo.disabled = false;
    elements.exportVideo.textContent = 'オーバーレイ画像を保存';
  }
}

function getBaseName() {
  const name = state.selectedFile?.name || 'data';
  return name.replace(/\.[^/.]+$/, '');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ===================================
// UI Helpers
// ===================================
function updateRunButton() {
  // 解析結果が存在する場合は、実行ボタンと推定モードパネルを非表示
  if (state.videoResult || state.result) {
    elements.runButton.style.display = 'none';
    elements.estimationModePanel.style.display = 'none';
    // 動画情報パネルは表示を維持（FPS設定を保持するため）
    if (state.fileType === 'video') {
      elements.videoInfoPanel.style.display = 'block';
    }
    return;
  }

  // 結果がない場合は表示
  elements.runButton.style.display = 'block';

  const enabled = state.selectedFile && !state.isProcessing && state.serverStatus;
  elements.runButton.disabled = !enabled;

  // ファイルが選択されたら推定モードパネルを表示（画像・動画共通）
  if (state.selectedFile) {
    elements.estimationModePanel.style.display = 'block';
    // 動画情報パネルは動画の場合のみ表示
    elements.videoInfoPanel.style.display = state.fileType === 'video' ? 'block' : 'none';
  } else {
    elements.estimationModePanel.style.display = 'none';
    elements.videoInfoPanel.style.display = 'none';
  }

  if (state.isProcessing) {
    elements.runButton.innerHTML = '⏹ 中止';
    elements.runButton.classList.add('btn-cancel');
    elements.runButton.disabled = false;  // 中止ボタンは常に有効
  } else {
    elements.runButton.textContent = '🚀 ポーズ推定を実行';
    elements.runButton.classList.remove('btn-cancel');
  }
}

function showError(message) {
  // ヘッダーにメッセージ表示
  const headerMessage = document.getElementById('headerMessage');
  if (headerMessage) {
    headerMessage.textContent = message;
    headerMessage.style.display = 'block';
    // メッセージタイプに応じてスタイルを変更
    headerMessage.className = 'header-message';
    if (message.includes('✅') || message.includes('✓')) {
      headerMessage.classList.add('success');
    } else if (message.includes('❌') || message.includes('エラー')) {
      headerMessage.classList.add('error');
    } else if (message.includes('⚠️')) {
      headerMessage.classList.add('warning');
    }
  }
  // サイドバーのエラーパネルは非表示のまま（ヘッダーに移行）
}

function hideError() {
  const headerMessage = document.getElementById('headerMessage');
  if (headerMessage) {
    headerMessage.style.display = 'none';
    headerMessage.textContent = '';
  }
}

// ===================================
// Event Listeners
// ===================================
function initEventListeners() {
  // File selection
  elements.dropZone.addEventListener('click', handleFileSelect);
  elements.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropZone.classList.add('drag-over');
  });
  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('drag-over');
  });
  elements.dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    elements.dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) {
      // Electron環境でドラッグ&ドロップされたファイルのパスを取得
      if (window.electronAPI) {
        // Electron 32+ では webUtils.getPathForFile を使用してパスを取得
        let filePath = null;
        try {
          if (window.electronAPI.getFilePath) {
            filePath = window.electronAPI.getFilePath(file);
          }
        } catch (error) {
          console.error('ファイルパスの取得に失敗:', error);
        }

        if (filePath) {
          // パスが取得できた場合、{ path, name }形式のオブジェクトとして保存
          loadFile({ path: filePath, name: file.name });
        } else {
          // パスが取得できない場合、Fileオブジェクトをそのまま使用
          console.warn('ファイルパスを取得できませんでした。Fileオブジェクトをそのまま使用します。');
          loadFile(file);
        }
      } else {
        // ブラウザ環境では、Fileオブジェクトをそのまま使用
        loadFile(file);
      }
    }
  });

  // Run detection or cancel
  elements.runButton.addEventListener('click', () => {
    if (state.isProcessing) {
      cancelDetection();
    } else {
      runDetection();
    }
  });

  // Export
  elements.exportCSV.addEventListener('click', exportCSV);
  // elements.exportJSON.addEventListener('click', exportJSON);  // JSON形式エクスポートは現在無効化
  if (elements.exportDataset) {
    elements.exportDataset.addEventListener('click', async () => {
      if (!state.result && !state.videoResult) {
        showError('エクスポートするデータがありません。解析を実行してください。');
        return;
      }

      // 確認ダイアログ
      const confirmMsg = '現在の動画と解析結果から、YOLO Pose学習用データセットを作成しますか？\n（画像の切り出し処理が行われます）';
      if (!confirm(confirmMsg)) return;

      try {
        elements.exportDataset.disabled = true;
        const originalText = elements.exportDataset.innerHTML;

        // 保存先選択
        elements.exportDataset.textContent = '保存先を選択...';
        let outputRoot = null;

        if (window.electronAPI && window.electronAPI.selectFolder) {
          const folderResult = await window.electronAPI.selectFolder({
            title: '学習データの保存先を選択',
            buttonLabel: 'このフォルダに保存'
          });

          if (folderResult.canceled || !folderResult.filePaths || folderResult.filePaths.length === 0) {
            elements.exportDataset.innerHTML = originalText;
            elements.exportDataset.disabled = false;
            return;
          }
          outputRoot = folderResult.filePaths[0];
        }

        elements.exportDataset.textContent = '作成中...';

        const data = getCurrentData();
        const videoPath = state.selectedFile?.path;

        if (!videoPath) throw new Error("動画ファイルのパスが不明です");
        if (!window.electronAPI) throw new Error("Electron APIが使用できません");

        const result = await window.electronAPI.pythonRequest('export_dataset', {
          video_path: videoPath,
          keypoints_data: data,
          dataset_name: null, // 自動生成
          train_ratio: 0.8,
          output_root: outputRoot
        });

        // ipcMain.handle('python-request') returns { success: boolean, data: any, error?: string }
        // content of 'data' is what python sends: { success: boolean, output_dir: ..., frames_count: ... }

        if (result.success && result.data && result.data.success) {
          const info = result.data;
          alert(`データセットを作成しました！\n保管場所: ${info.output_dir}\n枚数: ${info.frames_count}枚`);
        } else {
          const errorMsg = result.error || (result.data && result.data.error) || '不明なエラー';
          showError(`作成失敗: ${errorMsg}`);
        }

        elements.exportDataset.innerHTML = originalText;
        elements.exportDataset.disabled = false;

      } catch (e) {
        showError(`エラー: ${e.message}`);
        elements.exportDataset.disabled = false;
        elements.exportDataset.textContent = 'YOLO学習データ作成';
      }
    });
  }
  elements.exportVideo.addEventListener('click', exportVideoWithSkeleton);

  // Video controls
  elements.btnFirst.addEventListener('click', () => goToFrame(1));
  elements.btnPrev.addEventListener('click', () => goToFrame(state.currentFrame - 1));
  elements.btnPlay.addEventListener('click', togglePlayback);
  elements.btnNext.addEventListener('click', () => goToFrame(state.currentFrame + 1));
  elements.btnLast.addEventListener('click', () => goToFrame(state.videoResult?.processed_frames || 1));

  elements.frameSlider.addEventListener('mousedown', () => {
    state.isSliderDragging = true;
  });

  elements.frameSlider.addEventListener('mouseup', () => {
    state.isSliderDragging = false;
    // ドラッグ終了時に最終位置に確実に移動
    const frame = parseInt(elements.frameSlider.value);
    if (state.currentFrame !== frame) {
      goToFrame(frame);
    }
  });

  elements.frameSlider.addEventListener('input', (e) => {
    // デバウンス関数を使用してスムーズに更新
    debouncedGoToFrame(parseInt(e.target.value));
  });

  elements.speedSelect.addEventListener('change', (e) => {
    state.playbackSpeed = parseFloat(e.target.value);
    if (state.isPlaying) {
      stopPlayback();
      startPlayback();
    }
  });

  // Image load
  elements.previewImage.addEventListener('load', () => {
    if (state.result) drawImageResult();
  });

  // Video metadata
  elements.previewVideo.addEventListener('loadedmetadata', () => {
    // Video ready
  });

  elements.previewVideo.addEventListener('seeked', () => {
    if (state.videoResult) {
      if (state.viewMode === 'skeleton') {
        drawSkeletonOnly();
      } else if (state.viewMode === 'video') {
        drawVideoFrame();
      }
    }
  });

  // =================================== 
  // 動画ビューのズーム・パン操作
  // ===================================
  const resultCanvas = elements.resultCanvas;

  // ホイールズーム
  resultCanvas.addEventListener('wheel', (e) => {
    if (state.viewMode !== 'video') return;
    // デジタイズドラッグ中はズームしない
    if (state.digitizeMode && state.digitizeDragging) return;
    e.preventDefault();

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const oldZoom = state.videoZoom;
    // 最小0.1倍、最大20倍
    const newZoom = Math.max(0.1, Math.min(20.0, oldZoom * delta));

    if (newZoom === oldZoom) return;

    // マウス位置（Canvas座標）
    const rect = resultCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // ズーム中心計算
    const logicalX = (mouseX - state.videoPanX) / oldZoom;
    const logicalY = (mouseY - state.videoPanY) / oldZoom;

    state.videoPanX = mouseX - logicalX * newZoom;
    state.videoPanY = mouseY - logicalY * newZoom;
    state.videoZoom = newZoom;

    drawVideoFrame();
  }, { passive: false });

  // パン操作 (右クリック or 中クリック)
  resultCanvas.addEventListener('mousedown', (e) => {
    if (state.viewMode !== 'video') return;
    // 右クリック(2) or 中クリック(1)
    if (e.button === 2 || e.button === 1) {
      state.videoPanning = true;
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const startPanX = state.videoPanX;
      const startPanY = state.videoPanY;

      resultCanvas.style.cursor = 'grabbing';

      const onMouseMove = (moveEvent) => {
        if (!state.videoPanning) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        state.videoPanX = startPanX + dx;
        state.videoPanY = startPanY + dy;
        drawVideoFrame();
      };

      const onMouseUp = () => {
        state.videoPanning = false;
        resultCanvas.style.cursor = state.digitizeMode ? 'crosshair' : 'default';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
  });

  // コンテキストメニュー無効化（右クリックパンのため）
  resultCanvas.addEventListener('contextmenu', (e) => {
    if (state.viewMode === 'video') e.preventDefault();
  });

  // FPS変更
  elements.videoFps.addEventListener('change', () => {
    const data = getCurrentData();
    if (data) {
      data.fps = parseFloat(elements.videoFps.value) || 30;
    }
  });

  // フィルタリング
  elements.applyFilter.addEventListener('click', applyFiltering);

  // 手動IDスワップ
  elements.manualIdSwap.addEventListener('click', () => {
    const data = getCurrentData();
    if (!data || !data.frames) {
      showError('データがありません');
      return;
    }

    // 対象人物と入替相手を取得
    const p1 = elements.cleansingTargetPerson?.value;
    const p2 = elements.swapPersonB?.value;

    if (!p1 || !p2) {
      showError('入替する2人を選択してください');
      return;
    }

    if (p1 === p2) {
      showError('同じ人物を選択しています');
      return;
    }

    const currentFrame = state.currentFrame;

    // 現在フレーム以降のIDを入れ替え
    for (let i = 0; i < data.frames.length; i++) {
      const frameData = data.frames[i];
      if (frameData.frame >= currentFrame) {
        const kp1 = frameData.keypoints[p1];
        const kp2 = frameData.keypoints[p2];

        // 両方undefinedの場合は何もしない
        if (kp1 === undefined && kp2 === undefined) {
          continue;
        }

        // 入れ替え処理（undefinedの場合はキーを削除）
        if (kp2 !== undefined) {
          frameData.keypoints[p1] = kp2;
        } else {
          delete frameData.keypoints[p1];
        }

        if (kp1 !== undefined) {
          frameData.keypoints[p2] = kp1;
        } else {
          delete frameData.keypoints[p2];
        }
      }
    }

    // 再描画
    state.frameCache = []; // キャッシュをクリア
    drawVideoFrame();
    if (state.viewMode === 'graph') {
      if (state.graphMode === 'list') {
        drawGraphList();
      } else {
        drawGraph();
      }
      drawSkeletonPreview();
    }

    showError(`✅ フレーム ${currentFrame} 以降でPerson ${p1}とPerson ${p2}のIDを入れ替えました`);
    setTimeout(hideError, 3000);
  });

  // 左右脚入替
  elements.swapLegs.addEventListener('click', () => swapLimbs('legs'));

  // 左右腕入替
  elements.swapArms.addEventListener('click', () => swapLimbs('arms'));

  // 一括削除モーダル
  if (elements.bulkDeletePersonsBtn) {
    elements.bulkDeletePersonsBtn.addEventListener('click', openBulkDeleteModal);
  }
  if (elements.closeBulkDeleteBtn) {
    elements.closeBulkDeleteBtn.addEventListener('click', closeBulkDeleteModal);
  }
  if (elements.cancelBulkDeleteBtn) {
    elements.cancelBulkDeleteBtn.addEventListener('click', closeBulkDeleteModal);
  }
  if (elements.bulkDeleteSelectAll) {
    elements.bulkDeleteSelectAll.addEventListener('click', bulkDeleteSelectAll);
  }
  if (elements.bulkDeleteDeselectAll) {
    elements.bulkDeleteDeselectAll.addEventListener('click', bulkDeleteDeselectAll);
  }
  if (elements.confirmBulkDeleteBtn) {
    elements.confirmBulkDeleteBtn.addEventListener('click', confirmBulkDelete);
  }
  // モーダル外クリックで閉じる
  if (elements.bulkDeleteModal) {
    elements.bulkDeleteModal.addEventListener('click', (e) => {
      if (e.target === elements.bulkDeleteModal) {
        closeBulkDeleteModal();
      }
    });
  }

  // 表示モード切替
  elements.viewVideo.addEventListener('click', () => setViewMode('video'));
  elements.viewSkeleton.addEventListener('click', () => setViewMode('skeleton'));
  elements.viewGraph.addEventListener('click', () => setViewMode('graph'));

  // 動画/骨格モード用 編集ツールバーのイベントハンドラ
  // グラフモード用ボタンと同じ処理関数を呼び出す
  const vtDeleteBefore = document.getElementById('vt-deleteBefore');
  const vtDeleteAfter = document.getElementById('vt-deleteAfter');
  const vtDeleteFrame = document.getElementById('vt-deleteFrameData');
  const vtBulkDelete = document.getElementById('vt-bulkDeletePersons');
  const vtUndo = document.getElementById('vt-undoEdit');
  const vtRedo = document.getElementById('vt-redoEdit');
  if (vtDeleteBefore) vtDeleteBefore.addEventListener('click', () => performRangeDelete('before'));
  if (vtDeleteAfter) vtDeleteAfter.addEventListener('click', () => performRangeDelete('after'));
  if (vtDeleteFrame) vtDeleteFrame.addEventListener('click', deleteCurrentFrameData);
  if (vtBulkDelete) vtBulkDelete.addEventListener('click', openBulkDeleteModal);
  if (vtUndo) vtUndo.addEventListener('click', undoEdit);
  if (vtRedo) vtRedo.addEventListener('click', redoEdit);

  // 手動デジタイズモード切替
  elements.enableDigitize.addEventListener('change', (e) => {
    state.digitizeMode = e.target.checked;
    const canvas = elements.resultCanvas;
    canvas.style.cursor = state.digitizeMode ? 'crosshair' : 'default';

    // オプションパネルの表示切替
    elements.digitizeOptions.style.display = state.digitizeMode ? 'block' : 'none';

    if (state.digitizeMode) {
      // 人物リストを更新
      updateDigitizePersonList();
    }
  });

  // デジタイズタイプ切替（ポイント移動 / フレームデジタイズ）
  elements.digitizeMode.addEventListener('change', (e) => {
    state.digitizeType = e.target.value;
    elements.frameDigitizeOptions.style.display = state.digitizeType === 'frame' ? 'block' : 'none';

    if (state.digitizeType === 'frame') {
      updateDigitizePersonList();
    }
  });

  // データクレンジング対象人物変更（フレームデジタイズとグラフ表示にも使用）
  elements.cleansingTargetPerson.addEventListener('change', (e) => {
    state.digitizePersonId = e.target.value || null;
    updateDigitizeKeypointList();
    // ID入替相手リストを更新（対象人物を除外）
    updateSwapPersonB();
    // グラフ表示の人物も同期
    if (elements.graphPerson && e.target.value) {
      elements.graphPerson.value = e.target.value;
    }
    // 即座に再描画
    if (state.viewMode === 'video') {
      drawVideoFrame();
    } else if (state.viewMode === 'graph') {
      if (state.graphMode === 'list') {
        drawGraphList();
      } else {
        drawGraph();
      }
      state.skeletonPreviewCentered = false; // 人物変更時は再センタリング
      drawSkeletonPreview();
    }
  });

  // デジタイズ対象キーポイント変更
  elements.digitizeKeypoint.addEventListener('change', (e) => {
    state.digitizeKeypointIdx = e.target.value ? parseInt(e.target.value) : null;

    // グラフモードのキーポイント選択も同期
    if (elements.graphKeypoint && e.target.value) {
      elements.graphKeypoint.value = e.target.value;
    }

    // 即座に再描画して強調表示を反映
    if (state.viewMode === 'video') {
      clearFrameCache();  // キャッシュをクリアして強調表示を反映
      drawVideoFrame();
    } else if (state.viewMode === 'graph') {
      // グラフモードの場合はスケルトンプレビューとグラフを再描画
      drawGraph();
      drawSkeletonPreview();
    }
  });

  // スケルトン表示切り替え
  if (elements.showSkeletonCheckbox) {
    elements.showSkeletonCheckbox.addEventListener('change', (e) => {
      state.showSkeleton = e.target.checked;

      // スケルトンオーバーレイキャンバスの表示/非表示を切り替え
      if (elements.skeletonOverlayCanvas) {
        elements.skeletonOverlayCanvas.style.display = state.showSkeleton ? 'block' : 'none';
      }

      // スケルトンレンダラーをクリア（非表示時）
      if (!state.showSkeleton && state.skeletonRenderer) {
        state.skeletonRenderer.clear();
      }

      // 現在のフレームを再描画（drawVideoFrame内でshowSkeletonをチェックする）
      if (state.viewMode === 'video') {
        drawVideoFrame();
      }
    });
  }

  // グラフモード切替
  elements.graphModeList.addEventListener('click', () => setGraphMode('list'));
  elements.graphModeDetail.addEventListener('click', () => setGraphMode('detail'));
  elements.backToList.addEventListener('click', () => setGraphMode('list'));

  // グラフ選択変更
  elements.graphPerson.addEventListener('change', () => {
    // データクレンジング対象人物も同期
    if (elements.cleansingTargetPerson && elements.graphPerson.value) {
      elements.cleansingTargetPerson.value = elements.graphPerson.value;
      state.digitizePersonId = elements.graphPerson.value;
      // ID入替相手リストも更新
      updateSwapPersonB();
    }
    if (state.graphMode === 'list') {
      drawGraphList();
    } else {
      drawGraph();
    }
    state.skeletonPreviewCentered = false; // 人物変更時は再センタリング
    drawSkeletonPreview();
  });
  elements.graphKeypoint.addEventListener('change', () => {
    // 手動デジタイズの対象キーポイントも同期
    const keypointValue = elements.graphKeypoint.value;
    if (elements.digitizeKeypoint && keypointValue) {
      elements.digitizeKeypoint.value = keypointValue;
      state.digitizeKeypointIdx = parseInt(keypointValue);
    }
    drawGraph();
    drawSkeletonPreview();
  });

  // グラフ編集（X座標とY座標の両方）
  elements.graphCanvasX.addEventListener('mousedown', handleGraphMouseDown);
  elements.graphCanvasX.addEventListener('mousemove', handleGraphMouseMove);
  elements.graphCanvasX.addEventListener('mouseup', handleGraphMouseUp);
  elements.graphCanvasX.addEventListener('mouseleave', handleGraphMouseUp);
  elements.graphCanvasX.addEventListener('wheel', handleGraphWheel, { passive: false });
  elements.graphCanvasX.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!state.graphPanDidMove) {
      tryShowGraphContextMenu(e, elements.graphCanvasX);
    }
    state.graphPanDidMove = false;
  });
  elements.graphCanvasX.style.cursor = 'crosshair';

  elements.graphCanvasY.addEventListener('mousedown', handleGraphMouseDown);
  elements.graphCanvasY.addEventListener('mousemove', handleGraphMouseMove);
  elements.graphCanvasY.addEventListener('mouseup', handleGraphMouseUp);
  elements.graphCanvasY.addEventListener('mouseleave', handleGraphMouseUp);
  elements.graphCanvasY.addEventListener('wheel', handleGraphWheel, { passive: false });
  elements.graphCanvasY.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!state.graphPanDidMove) {
      tryShowGraphContextMenu(e, elements.graphCanvasY);
    }
    state.graphPanDidMove = false;
  });
  elements.graphCanvasY.style.cursor = 'crosshair';

  // 編集操作
  elements.undoEdit.addEventListener('click', undoEdit);
  elements.redoEdit.addEventListener('click', redoEdit);
  elements.resetEdit.addEventListener('click', resetEdits);
  elements.deleteFrameData.addEventListener('click', deleteCurrentFrameData);

  // グラフ右クリックコンテキストメニュー
  if (elements.graphContextMenuDelete) {
    elements.graphContextMenuDelete.addEventListener('click', () => {
      if (state.graphContextTarget) {
        const { personId, keypointIdx, frame } = state.graphContextTarget;
        deleteGraphKeypoint(personId, keypointIdx, frame);
        state.graphContextTarget = null;
      }
      if (elements.graphContextMenu) {
        elements.graphContextMenu.style.display = 'none';
      }
    });
  }
  elements.deleteBefore.addEventListener('click', () => performRangeDelete('before'));
  elements.deleteAfter.addEventListener('click', () => performRangeDelete('after'));

  // ズームコントロール
  elements.zoomIn.addEventListener('click', () => {
    state.skeletonZoom = Math.min(state.skeletonZoom * 1.2, 20.0);
    drawSkeletonPreview();
  });

  elements.zoomOut.addEventListener('click', () => {
    state.skeletonZoom = Math.max(state.skeletonZoom / 1.2, 0.2);
    drawSkeletonPreview();
  });

  elements.zoomReset.addEventListener('click', resetPreviewView);



  // 動画モード用ズームリセット（初期画面サイズに戻す）
  elements.videoZoomReset.addEventListener('click', () => {
    // 初期化フラグをリセットして、次回描画時にフィットスケールを再計算させる
    state.videoZoomInitialized = false;
    drawVideoFrame();
  });

  // スケルトンドラッグ（パン）- スケルトンプレビュー用（右クリック）
  elements.skeletonPreviewWrapper.addEventListener('mousedown', (e) => {
    if (e.button === 2) { // 右クリックでパン
      state.isSkeletonDragging = true;
      state.skeletonDragStartX = e.clientX - state.skeletonPanX;
      state.skeletonDragStartY = e.clientY - state.skeletonPanY;
      elements.skeletonPreviewWrapper.classList.add('dragging');
      e.preventDefault();
    } else if (e.button === 0) { // 左クリックで関節選択
      handleSkeletonPreviewClick(e);
    }
  });

  // 右クリックメニュー無効化（スケルトンプレビュー）
  elements.skeletonPreviewWrapper.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // スケルトンドラッグ（パン）- スケルトンモード用
  elements.skeletonCanvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 && state.viewMode === 'skeleton') { // 左クリックかつスケルトンモード
      state.isSkeletonDragging = true;
      state.skeletonDragStartX = e.clientX - state.skeletonPanX;
      state.skeletonDragStartY = e.clientY - state.skeletonPanY;
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (state.isSkeletonDragging) {
      state.skeletonPanX = e.clientX - state.skeletonDragStartX;
      state.skeletonPanY = e.clientY - state.skeletonDragStartY;
      if (state.viewMode === 'skeleton') {
        drawSkeletonOnly();
      } else {
        drawSkeletonPreview();
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (state.isSkeletonDragging) {
      state.isSkeletonDragging = false;
      elements.skeletonPreviewWrapper.classList.remove('dragging');
    }
  });

  // グラフホバーイベント初期化
  initGraphHoverEvents();

  // マウスホイールでズーム - スケルトンプレビュー用
  elements.skeletonPreviewWrapper.addEventListener('wheel', (e) => {
    e.preventDefault();

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const oldZoom = state.skeletonZoom;
    const newZoom = Math.max(0.2, Math.min(20.0, oldZoom * delta));
    if (newZoom === oldZoom) {
      return;
    }

    // 中央配置オフセットを計算（drawSkeletonPreviewと同じロジック）
    const canvas = elements.skeletonPreviewCanvas;
    const wrapper = elements.skeletonPreviewWrapper;
    const video = elements.previewVideo;
    if (!video.videoWidth || !video.videoHeight) return;

    const aspectRatio = video.videoWidth / video.videoHeight;
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    let fitWidth, fitHeight;
    if (canvasWidth / aspectRatio <= canvasHeight) {
      fitWidth = canvasWidth;
      fitHeight = canvasWidth / aspectRatio;
    } else {
      fitHeight = canvasHeight;
      fitWidth = canvasHeight * aspectRatio;
    }

    const offsetX = (canvasWidth - fitWidth) / 2;
    const offsetY = (canvasHeight - fitHeight) / 2;

    // キャンバス内でのマウス位置を取得
    const canvasRect = canvas.getBoundingClientRect();
    const mouseXInCanvas = e.clientX - canvasRect.left;
    const mouseYInCanvas = e.clientY - canvasRect.top;

    // マウス位置での論理座標を計算（オフセット、パン、ズームを逆算）
    // 描画時: 描画座標 = オフセット + パン + 論理座標 * ズーム
    // なので: 論理座標 = (描画座標 - オフセット - パン) / ズーム
    const logicalX = (mouseXInCanvas - offsetX - state.skeletonPanX) / oldZoom;
    const logicalY = (mouseYInCanvas - offsetY - state.skeletonPanY) / oldZoom;

    // 新しいズームで同じ論理座標がマウス位置に来るようにパンを調整
    // 新描画座標 = オフセット + パン + 論理座標 * 新ズーム = マウス位置
    // なので: 新パン = マウス位置 - オフセット - 論理座標 * 新ズーム
    state.skeletonPanX = mouseXInCanvas - offsetX - logicalX * newZoom;
    state.skeletonPanY = mouseYInCanvas - offsetY - logicalY * newZoom;
    state.skeletonZoom = newZoom;

    drawSkeletonPreview();
  }, { passive: false });

  // マウスホイールでズーム - スケルトンモード用
  elements.skeletonCanvas.addEventListener('wheel', (e) => {
    if (state.viewMode === 'skeleton') {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1.1 : 0.9;
      const oldZoom = state.skeletonZoom;
      const newZoom = Math.max(0.2, Math.min(5.0, oldZoom * delta));
      if (newZoom === oldZoom) {
        return;
      }

      // マウス位置を中心にズーム（X方向とY方向両方）
      const canvas = elements.skeletonCanvas;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const k = newZoom / oldZoom;

      state.skeletonPanX = mouseX - k * (mouseX - state.skeletonPanX);
      state.skeletonPanY = mouseY - k * (mouseY - state.skeletonPanY);
      state.skeletonZoom = newZoom;

      drawSkeletonOnly();
    }
  }, { passive: false });

  // リサイザー
  let resizeStartX = 0;
  let resizeStartGraphWidth = 0;
  let resizeStartPreviewWidth = 0;

  elements.graphResizer.addEventListener('mousedown', (e) => {
    state.resizing = true;
    e.preventDefault();
    elements.graphResizer.classList.add('dragging');

    const graphMainContent = elements.graphContainer.querySelector('.graph-main-content');
    const skeletonPreview = elements.skeletonPreview;
    let graphView;
    if (state.graphMode === 'list') {
      graphView = elements.graphListView;
    } else {
      graphView = elements.graphDetailView;
    }

    resizeStartX = e.clientX;
    resizeStartGraphWidth = graphView.getBoundingClientRect().width;
    resizeStartPreviewWidth = skeletonPreview.getBoundingClientRect().width;
  });

  window.addEventListener('mousemove', (e) => {
    if (state.resizing) {
      const graphMainContent = elements.graphContainer.querySelector('.graph-main-content');
      const skeletonPreview = elements.skeletonPreview;
      let graphView;
      if (state.graphMode === 'list') {
        graphView = elements.graphListView;
      } else {
        graphView = elements.graphDetailView;
      }

      const deltaX = e.clientX - resizeStartX;
      const newGraphWidth = resizeStartGraphWidth + deltaX;
      const newPreviewWidth = resizeStartPreviewWidth - deltaX;

      const minWidth = 200;
      const maxWidth = graphMainContent.getBoundingClientRect().width - 200;

      if (newGraphWidth >= minWidth && newGraphWidth <= maxWidth) {
        graphView.style.width = `${newGraphWidth}px`;
        graphView.style.flex = 'none';
        skeletonPreview.style.width = `${newPreviewWidth}px`;
        skeletonPreview.style.flex = 'none';

        // グラフを再描画
        if (state.viewMode === 'graph') {
          if (state.graphMode === 'list') {
            drawGraphList();
          } else {
            drawGraph();
          }
        }
        drawSkeletonPreview();
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (state.resizing) {
      state.resizing = false;
      elements.graphResizer.classList.remove('dragging');
    }
  });

  // ウィンドウリサイズ時にグラフを再描画
  window.addEventListener('resize', () => {
    if (state.viewMode === 'graph') {
      if (state.graphMode === 'list') {
        drawGraphList();
      } else {
        drawGraph();
      }
    }
  });

  // ===================================
  // キーボードショートカット補助関数
  // ===================================

  // デジタイズキーポイントを方向 (±1) で移動する
  function navigateDigitizeKeypoint(direction) {
    const names = getActiveKeypointNamesJP();
    const total = names.length;
    if (total === 0) return;

    let current = state.digitizeKeypointIdx;
    if (current === null || current === undefined || isNaN(current)) {
      current = direction > 0 ? 0 : total - 1;
    } else {
      current = ((parseInt(current) + direction) + total) % total;
    }

    state.digitizeKeypointIdx = current;
    if (elements.digitizeKeypoint) {
      elements.digitizeKeypoint.value = current;
    }
    if (elements.graphKeypoint) {
      elements.graphKeypoint.value = current;
    }

    if (state.viewMode === 'video') {
      clearFrameCache();
      drawVideoFrame();
    } else if (state.viewMode === 'graph') {
      if (state.graphMode === 'detail') {
        drawGraph();
      }
      drawSkeletonPreview();
    }
  }

  // キーボードショートカット
  document.addEventListener('keydown', (e) => {
    // テキスト入力フィールドにフォーカスがある場合のみスキップ
    // SELECT・ボタン・チェックボックスにフォーカスがあっても常にショートカットが動作する
    if (e.target.tagName === 'TEXTAREA') {
      return;
    }
    if (e.target.tagName === 'INPUT') {
      const inputType = e.target.type.toLowerCase();
      if (['text', 'number', 'email', 'password', 'search', 'tel', 'url'].includes(inputType)) {
        return;
      }
    }

    // 動画が読み込まれていない場合はスキップ
    if (state.fileType !== 'video') return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goToFrame(state.currentFrame - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      goToFrame(state.currentFrame + 1);
    } else if (e.key === 'ArrowUp') {
      // デジタイズポイントを一つ前へ
      e.preventDefault();
      navigateDigitizeKeypoint(-1);
    } else if (e.key === 'ArrowDown') {
      // デジタイズポイントを一つ後へ
      e.preventDefault();
      navigateDigitizeKeypoint(1);
    } else if (e.key === 'Delete') {
      // 現在フレームの選択人物データを削除
      e.preventDefault();
      deleteCurrentFrameData();
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      // スペースキーで再生/一時停止
      e.preventDefault();
      togglePlayback();
    }
  });

  // サイドバートグル
  elements.toggleSidebar.addEventListener('click', () => {
    elements.sidebar.classList.toggle('collapsed');
    const isCollapsed = elements.sidebar.classList.contains('collapsed');
    elements.toggleSidebar.title = isCollapsed ? 'サイドバーを表示' : 'サイドバーを隠す';
  });

  // ボタン・SELECT・チェックボックスのクリック後にフォーカスを解除
  // （キーボードショートカットがフォーカスに関わらず常に動作するようにするため）
  document.addEventListener('click', (e) => {
    const target = e.target;
    // コンテキストメニュー外クリック時に閉じる
    if (elements.graphContextMenu &&
        !elements.graphContextMenu.contains(target)) {
      elements.graphContextMenu.style.display = 'none';
    }
    // フォーカスを解除（change/click イベントが先に発火するよう少し遅延）
    // SELECT はmacOSでネイティブドロップダウンが即閉じるためblur対象外
    if (target.tagName === 'BUTTON' ||
        (target.tagName === 'INPUT' && target.type === 'checkbox')) {
      setTimeout(() => {
        target.blur();
      }, 0);
    }
  });
}



// ===================================
// Skeleton Renderer Initialization
// ===================================
async function initSkeletonRenderers() {
  // メイン表示用（動画オーバーレイ）
  // メイン表示用（動画オーバーレイ）
  if (elements.skeletonOverlayCanvas && !elements.skeletonOverlayCanvas._offscreenTransferred) {
    state.skeletonRenderer = new SkeletonRenderer(elements.skeletonOverlayCanvas, {
      workerPath: 'skeleton-worker.js'
    });
    await state.skeletonRenderer.init();
    elements.skeletonOverlayCanvas._offscreenTransferred = true;
  }

  // スケルトンプレビュー用
  if (elements.skeletonPreviewCanvas && !elements.skeletonPreviewCanvas._offscreenTransferred) {
    console.log('[App] Initializing skeleton preview renderer');
    state.skeletonPreviewRenderer = new SkeletonRenderer(elements.skeletonPreviewCanvas, {
      workerPath: 'skeleton-worker.js'
    });
    await state.skeletonPreviewRenderer.init();
    elements.skeletonPreviewCanvas._offscreenTransferred = true;
  }

  console.log('[App] Skeleton renderers initialized');
}

function cleanup() {
  if (state.playInterval) clearInterval(state.playInterval);
  if (state.playbackAnimationId) cancelAnimationFrame(state.playbackAnimationId);
  if (state.sliderDebounceTimer) clearTimeout(state.sliderDebounceTimer);
  state.frameImageCache = {};

  // Workerの破棄
  // Workerの破棄とキャンバスのリセット
  if (state.skeletonRenderer) {
    state.skeletonRenderer.destroy();
    state.skeletonRenderer = null;
  }
  // OffscreenCanvas化したキャンバスは再利用できないため、DOM要素を置換してリセット
  if (elements.skeletonOverlayCanvas && elements.skeletonOverlayCanvas._offscreenTransferred) {
    const newCanvas = elements.skeletonOverlayCanvas.cloneNode(true);
    // プロパティはクローンされないが、念のため
    delete newCanvas._offscreenTransferred;
    elements.skeletonOverlayCanvas.parentNode.replaceChild(newCanvas, elements.skeletonOverlayCanvas);
    elements.skeletonOverlayCanvas = newCanvas;
    console.log('[cleanup] Replaced skeletonOverlayCanvas');
  }

  if (state.skeletonPreviewRenderer) {
    state.skeletonPreviewRenderer.destroy();
    state.skeletonPreviewRenderer = null;
  }
  if (elements.skeletonPreviewCanvas && elements.skeletonPreviewCanvas._offscreenTransferred) {
    const newCanvas = elements.skeletonPreviewCanvas.cloneNode(true);
    delete newCanvas._offscreenTransferred;
    elements.skeletonPreviewCanvas.parentNode.replaceChild(newCanvas, elements.skeletonPreviewCanvas);
    elements.skeletonPreviewCanvas = newCanvas;
    console.log('[cleanup] Replaced skeletonPreviewCanvas');
  }

  // Pythonバックエンドに一時ファイルの削除をリクエスト
  if (window.electronAPI && window.electronAPI.pythonRequest) {
    window.electronAPI.pythonRequest('cleanup', {});
  }
}

// ===================================
// Settings
// ===================================

function openSettings() {
  // 既存のモーダルがあれば削除
  const existingModal = document.getElementById('settingsModal');
  if (existingModal) {
    existingModal.remove();
  }

  // 設定モーダルを作成
  const modal = document.createElement('div');
  modal.id = 'settingsModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content settings-modal">
      <div class="modal-header">
        <h3>⚙️ 設定</h3>
        <button class="modal-close" id="closeSettings">&times;</button>
      </div>
      <div class="modal-body">
        <div class="settings-section">
          <h4>🔍 検出・推定設定</h4>
          <div class="settings-row">
            <label>人物検出 信頼度閾値</label>
            <input type="number" id="settingsDetectionThreshold" value="${localStorage.getItem('detectionThreshold') || 0.5}" min="0.1" max="1.0" step="0.05">
          </div>
          <div class="settings-row">
            <label>骨格描画 信頼度閾値</label>
            <input type="number" id="settingsDrawThreshold" value="${localStorage.getItem('drawThreshold') || 0.3}" min="0.1" max="1.0" step="0.05">
          </div>
        </div>
        
        <div class="settings-section">
          <h4>🔧 フィルタリング設定</h4>
          <div class="settings-row">
            <label>フィルタ信頼度閾値</label>
            <input type="number" id="settingsFilterThreshold" value="${localStorage.getItem('filterThreshold') || 0.3}" min="0.1" max="1.0" step="0.05">
          </div>
          <div class="settings-row">
            <label>補間最大ギャップ（フレーム）</label>
            <input type="number" id="settingsMaxGap" value="${localStorage.getItem('maxGap') || 50}" min="1" max="500" step="10">
          </div>
          <div class="settings-row">
            <label>エッジパディング（フレーム）</label>
            <input type="number" id="settingsEdgePadding" value="${localStorage.getItem('edgePadding') || 20}" min="0" max="120" step="5">
          </div>
        </div>
        



        
        <div class="settings-section">
          <h4>📊 エクスポート設定</h4>
          <div class="settings-row">
            <label>CSV座標精度（小数点以下桁数）</label>
            <input type="number" id="settingsCsvPrecision" value="${localStorage.getItem('csvPrecision') || 2}" min="0" max="6" step="1">
          </div>
        </div>
        
        <div class="settings-section">
          <h4>🎨 表示設定</h4>
          <div class="settings-row">
            <label>スケルトン線の太さ</label>
            <input type="number" id="settingsLineWidth" value="${localStorage.getItem('skeletonLineWidth') || 3}" min="1" max="10" step="1">
          </div>
          <div class="settings-row">
            <label>キーポイント半径</label>
            <input type="number" id="settingsPointRadius" value="${localStorage.getItem('keypointRadius') || 5}" min="2" max="15" step="1">
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" id="cancelSettings">キャンセル</button>
        <button class="btn btn-primary" id="saveSettings">保存</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // イベントリスナー
  document.getElementById('closeSettings').addEventListener('click', () => modal.remove());
  document.getElementById('cancelSettings').addEventListener('click', () => modal.remove());
  document.getElementById('saveSettings').addEventListener('click', () => {
    // 設定を保存
    const detectionThreshold = document.getElementById('settingsDetectionThreshold').value;
    const drawThreshold = document.getElementById('settingsDrawThreshold').value;
    const filterThreshold = document.getElementById('settingsFilterThreshold').value;
    const maxGap = document.getElementById('settingsMaxGap').value;
    const edgePadding = document.getElementById('settingsEdgePadding').value;
    const csvPrecision = document.getElementById('settingsCsvPrecision').value;
    const lineWidth = document.getElementById('settingsLineWidth').value;
    const pointRadius = document.getElementById('settingsPointRadius').value;

    // LocalStorageに保存
    localStorage.setItem('detectionThreshold', detectionThreshold);
    localStorage.setItem('drawThreshold', drawThreshold);
    localStorage.setItem('filterThreshold', filterThreshold);
    localStorage.setItem('maxGap', maxGap);
    localStorage.setItem('edgePadding', edgePadding);
    localStorage.setItem('csvPrecision', csvPrecision);
    localStorage.setItem('skeletonLineWidth', lineWidth);
    localStorage.setItem('keypointRadius', pointRadius);

    modal.remove();
    showError('✅ 設定を保存しました');
    setTimeout(hideError, 2000);
  });

  // モーダル外クリックで閉じる
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });


}

// ===================================
// Save/Load Project
// ===================================

// プロジェクトファイルパスから動画パスを相対パスに変換
// ドライブ共有時の互換性のため
function toRelativePath(projectPath, targetPath) {
  if (!projectPath || !targetPath) return targetPath;

  // パスを正規化（バックスラッシュをスラッシュに統一）
  const normalizedProject = projectPath.replace(/\\/g, '/');
  const normalizedTarget = targetPath.replace(/\\/g, '/');

  // プロジェクトディレクトリを取得
  const projectDir = normalizedProject.substring(0, normalizedProject.lastIndexOf('/'));

  // 同じディレクトリまたはサブディレクトリの場合、相対パスに変換
  if (normalizedTarget.startsWith(projectDir + '/')) {
    return './' + normalizedTarget.substring(projectDir.length + 1);
  }

  // 異なるドライブやディレクトリの場合は絶対パスを維持
  return targetPath;
}

// 相対パスを絶対パスに解決
function toAbsolutePath(projectPath, relativePath) {
  if (!projectPath || !relativePath) return relativePath;

  // 相対パスでない場合はそのまま返す（後方互換性のため）
  if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
    return relativePath;
  }

  // プロジェクトディレクトリを取得
  const normalizedProject = projectPath.replace(/\\/g, '/');
  const projectDir = normalizedProject.substring(0, normalizedProject.lastIndexOf('/'));

  // ./ を除去して結合
  const resolved = relativePath.replace(/^\.[\/\\]/, '');
  return projectDir + '/' + resolved;
}

// プロジェクトデータを生成する共通関数
// projectPath: 保存先のプロジェクトファイルパス（相対パス変換に使用）
function createProjectData(projectPath = null) {
  // 動画の絶対パスを取得
  let absoluteFilePath = null;
  if (state.selectedFile?.path) {
    absoluteFilePath = state.selectedFile.path;
  } else if (state.selectedFile instanceof File) {
    console.warn('Fileオブジェクトにはpathプロパティがありません。');
  } else if (state.previewUrl && typeof state.previewUrl === 'string' && state.previewUrl.startsWith('file://')) {
    absoluteFilePath = state.previewUrl.replace(/^file:\/\//, '');
  }

  // プロジェクトパスが指定されている場合、相対パスに変換
  const filePathToSave = projectPath ? toRelativePath(projectPath, absoluteFilePath) : absoluteFilePath;

  // 保存用にデータから不要なフィールドを除去
  const cleanData = (data) => {
    if (!data) return null;
    // fps, success, processing_time_ms, extracted_frames_dir を除去
    const { fps, success, processing_time_ms, extracted_frames_dir, ...rest } = data;
    return rest;
  };

  return {
    version: '1.2', // バージョンを更新（不要データ削除）
    timestamp: new Date().toISOString(),
    fileType: state.fileType,
    fileName: state.selectedFile?.name || 'unknown',
    filePath: filePathToSave,
    outputFormat: state.outputFormat || '23pts',
    // extractedFramesDirはOS一時ディレクトリなので保存しない
    // 軽量化: フィルタ済みデータがある場合は生データ(originalData)を保存しない
    originalData: cleanData(state.filteredResult ? null : (state.videoResult || state.result)),
    filteredData: cleanData(state.filteredResult),
    currentFrame: state.currentFrame,
    viewMode: state.viewMode || 'video',
    graphMode: state.graphMode || 'list',
    filterSettings: {
      cameraType: elements.cameraType?.value || 'normal',
      fps: parseFloat(elements.videoFps?.value) || 30,
      enableOutlier: elements.enableOutlier?.checked || false,
      enableInterpolation: elements.enableInterpolation?.checked || false,
      interpolationMethod: localStorage.getItem('interpolationMethod') || 'pchip',
      enableButterworth: elements.enableButterworth?.checked || false,
      butterworthCutoff: parseFloat(localStorage.getItem('butterworthCutoff')) || 6.0,
      enableKalman: elements.enableKalman?.checked || false
    },
    editHistory: state.editHistory,
    graphYRangeX: state.graphYRangeX,
    graphYRangeY: state.graphYRangeY,
    graphXRangeX: state.graphXRangeX,
    editHistory: state.editHistory,
    graphYRangeX: state.graphYRangeX,
    graphYRangeY: state.graphYRangeY,
    graphXRangeX: state.graphXRangeX,
    graphXRangeY: state.graphXRangeY,
    models: state.usedModels // 使用モデル情報を保存
  };
}

// デフォルトの保存パスを生成
function getSuggestedProjectPath() {
  if (state.selectedFile?.path) {
    const fullPath = state.selectedFile.path;
    const sep = fullPath.includes('\\') ? '\\' : '/';
    const dir = fullPath.substring(0, fullPath.lastIndexOf(sep));
    const base = fullPath.substring(fullPath.lastIndexOf(sep) + 1).replace(/\.[^/.]+$/, '');
    return `${dir}${sep}${base}.hpe`;
  } else if (state.selectedFile?.name) {
    const base = state.selectedFile.name.replace(/\.[^/.]+$/, '');
    return `${base}.hpe`;
  }
  return 'project.hpe';
}

// 上書き保存（既存パスがあればそこに保存、なければダイアログ表示）
async function saveProject() {
  if (!state.videoResult && !state.result) {
    showError('保存するデータがありません');
    return;
  }

  if (window.electronAPI) {
    try {
      // 既存の保存パスがある場合は上書き保存
      if (state.currentProjectPath) {
        // プロジェクトパスを渡して相対パス変換を適用
        const projectData = createProjectData(state.currentProjectPath);
        const result = await window.electronAPI.saveProjectDirect(projectData, state.currentProjectPath);
        if (result.success) {
          state.exported = true;
          updateStepGuide();
          showError('✅ プロジェクトを上書き保存しました');
          setTimeout(hideError, 2000);

          // プロジェクトステータス更新 (Launcher連携)
          if (window.electronAPI.updateProjectStatus) {
            window.electronAPI.updateProjectStatus({ step: 'hpe', status: 'completed' })
              .catch(err => console.error('Status update failed:', err));
          }
        } else {
          showError(`保存エラー: ${result.error || '不明なエラー'}`);
        }
      } else {
        // パスがない場合は名前を付けて保存
        await saveProjectAs();
      }
    } catch (e) {
      showError(`保存エラー: ${e.message}`);
    }
  } else {
    // ブラウザ環境では常にダウンロード（相対パス変換なし）
    const projectData = createProjectData();
    downloadProjectFile(projectData);
  }
}

// 使用モデル情報UIを更新
function updateUsedModelInfoUI() {
  const infoPanel = document.getElementById('usedModelInfo');
  const yoloSpan = document.getElementById('usedYoloModel');
  const poseSpan = document.getElementById('usedPoseModel');

  if (infoPanel && yoloSpan && poseSpan) {
    if (state.usedModels && (state.usedModels.yolo || state.usedModels.pose)) {
      // YOLO名: ファイル名から表示用に変換 (yolo26m.onnx → YOLO26-M)
      const yoloRaw = state.usedModels.yolo || '-';
      yoloSpan.textContent = yoloRaw.replace('.onnx', '').toUpperCase();
      poseSpan.textContent = state.usedModels.pose || '-';
      infoPanel.style.display = 'block';
    } else {
      infoPanel.style.display = 'none';
    }
  }
}

// 名前を付けて保存（常にダイアログ表示）
async function saveProjectAs() {
  if (!state.videoResult && !state.result) {
    showError('保存するデータがありません');
    return;
  }

  const suggestedPath = getSuggestedProjectPath();

  if (window.electronAPI) {
    try {
      // まずダイアログで保存先を決定
      const result = await window.electronAPI.saveProject(null, suggestedPath);
      if (result.success) {
        // 保存先パスを記録
        state.currentProjectPath = result.filePath;
        // 確定したパスで相対パス変換を適用してデータを生成
        const projectData = createProjectData(result.filePath);
        // データを保存
        const writeResult = await window.electronAPI.saveProjectDirect(projectData, result.filePath);
        if (writeResult.success) {
          state.exported = true;
          updateStepGuide();
          showError('✅ プロジェクトを保存しました');
          setTimeout(hideError, 2000);
        } else {
          showError(`保存エラー: ${writeResult.error || '不明なエラー'}`);
        }
      } else if (!result.canceled) {
        showError(`保存エラー: ${result.error || '不明なエラー'}`);
      }
    } catch (e) {
      showError(`保存エラー: ${e.message}`);
    }
  } else {
    // ブラウザ環境では相対パス変換なし
    const projectData = createProjectData();
    downloadProjectFile(projectData);
  }
}

// ブラウザ環境でのダウンロード
function downloadProjectFile(projectData) {
  const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'project.json';
  a.click();
  URL.revokeObjectURL(url);
  showError('✅ プロジェクトをダウンロードしました');
  setTimeout(hideError, 2000);
}

// ===================================
// バッチ処理
// ===================================
function openBatchModal() {
  const modal = document.getElementById('batchModal');
  if (modal) {
    // 状態をリセット
    state.batchFiles = [];
    state.batchProcessing = false;
    state.batchCurrentIndex = 0;
    state.batchResults = [];
    state.batchCancelled = false;

    // メイン画面の設定をバッチ設定に反映
    const batchCameraType = document.getElementById('batchCameraType');
    const batchFps = document.getElementById('batchFps');
    const batchPoseModel = document.getElementById('batchPoseModel');
    const batchEstimationMode = document.getElementById('batchEstimationMode');

    if (batchCameraType && elements.cameraType) {
      batchCameraType.value = elements.cameraType.value || 'normal';
    }
    if (batchFps && elements.videoFps) {
      batchFps.value = elements.videoFps.value || 60;
    }
    if (batchPoseModel) {
      // 現在ロードされているモデルを選択
      const currentType = state.loadedModels?.vitpose_type || 'rtmpose-x';
      batchPoseModel.value = currentType;
    }
    if (batchEstimationMode && elements.estimationMode) {
      batchEstimationMode.value = elements.estimationMode.value || 'full';
    }

    updateBatchUI();
    modal.style.display = 'flex';
  }
}

function closeBatchModal() {
  const modal = document.getElementById('batchModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function updateBatchUI() {
  const fileList = document.getElementById('batchFileList');
  const fileItems = document.getElementById('batchFileItems');
  const fileCount = document.getElementById('batchFileCount');
  const startBtn = document.getElementById('startBatchBtn');
  const progressSection = document.getElementById('batchProgressSection');
  const resultsSection = document.getElementById('batchResults');

  // ファイルリスト表示
  if (state.batchFiles.length > 0) {
    fileList.style.display = 'block';
    fileCount.textContent = state.batchFiles.length;
    fileItems.innerHTML = state.batchFiles.map((f, i) => {
      const status = state.batchResults[i];
      let statusIcon = '';
      if (status === 'success') statusIcon = '<span style="color: #22c55e;">✓</span> ';
      else if (status === 'error') statusIcon = '<span style="color: #ef4444;">✗</span> ';
      else if (status === 'skipped') statusIcon = '<span style="color: #f59e0b;">−</span> ';
      else if (state.batchProcessing && i === state.batchCurrentIndex) statusIcon = '<span style="color: #3b82f6;">●</span> ';
      return `<div style="padding: 4px 0; border-bottom: 1px solid #374151; font-size: 0.8rem; word-break: break-all; color: #d1d5db;">${statusIcon}${f}</div>`;
    }).join('');
  } else {
    fileList.style.display = 'none';
  }

  // ファイル選択/追加ボタン
  const selectBtn = document.getElementById('batchSelectFilesBtn');
  if (selectBtn) {
    if (state.batchFiles.length > 0) {
      selectBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" style="width: 1.2em; height: 1.2em;">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg> ファイルを追加...`;
    } else {
      selectBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" style="width: 1.2em; height: 1.2em;">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg> ファイルを選択...`;
    }
  }

  // 開始ボタン
  if (state.batchProcessing) {
    startBtn.textContent = 'キャンセル';
    startBtn.disabled = false;
    startBtn.classList.remove('btn-primary');
    startBtn.classList.add('btn-secondary');
  } else {
    // 処理完了後（結果がある場合）は処理開始ボタンを非表示
    const hasResults = state.batchResults.some(r => r !== null);
    if (hasResults) {
      startBtn.style.display = 'none';
    } else {
      startBtn.style.display = '';
      startBtn.textContent = '処理開始';
      startBtn.disabled = state.batchFiles.length === 0;
      startBtn.classList.remove('btn-secondary');
      startBtn.classList.add('btn-primary');
    }
  }

  // 進捗セクション（表示/非表示のみ。進捗値はupdateBatchProgressUI()で更新）
  if (state.batchProcessing || state.batchResults.length > 0) {
    progressSection.style.display = 'block';
  } else {
    progressSection.style.display = 'none';
  }

  // 結果セクション
  const hasCompletedResults = state.batchResults.some(r => r !== null);
  if (!state.batchProcessing && hasCompletedResults) {
    resultsSection.style.display = 'block';
    const successCount = state.batchResults.filter(r => r === 'success').length;
    const errorCount = state.batchResults.filter(r => r === 'error').length;
    const skippedCount = state.batchResults.filter(r => r === 'skipped').length;
    document.getElementById('batchResultItems').innerHTML = `
      <div style="color: #22c55e;">成功: ${successCount}件</div>
      ${errorCount > 0 ? `<div style="color: #ef4444;">エラー: ${errorCount}件</div>` : ''}
      ${skippedCount > 0 ? `<div style="color: #f59e0b;">スキップ: ${skippedCount}件</div>` : ''}
    `;
  } else {
    resultsSection.style.display = 'none';
  }
}

// バッチ処理の進捗バー（フレーム数ベース）を更新
function updateBatchProgressUI() {
  const progressLabel = document.getElementById('batchProgressLabel');
  const progressFill = document.getElementById('batchProgressFill');
  const fileProgress = document.getElementById('batchFileProgress');

  if (progressLabel) {
    if (state.batchTotalFrames > 0) {
      const percent = (state.batchProcessedFrames / state.batchTotalFrames * 100).toFixed(1);
      progressLabel.textContent = `${percent}%`;
    } else {
      progressLabel.textContent = '0%';
    }
  }

  if (progressFill) {
    const percent = state.batchTotalFrames > 0
      ? (state.batchProcessedFrames / state.batchTotalFrames * 100)
      : 0;
    progressFill.style.width = `${Math.min(percent, 100)}%`;
  }

  if (fileProgress) {
    const completedFiles = state.batchResults.filter(r => r !== null).length;
    fileProgress.textContent = `ファイル: ${completedFiles} / ${state.batchFiles.length}`;
  }
}

async function selectBatchFiles() {
  if (!window.electronAPI) return;

  const result = await window.electronAPI.selectFiles();
  if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
    addBatchFiles(result.filePaths);
  }
}

// バッチファイルを追加（重複を除去）
function addBatchFiles(newPaths) {
  // 既存のファイルと重複しないものだけ追加
  const existingSet = new Set(state.batchFiles);
  const uniqueNewPaths = newPaths.filter(p => !existingSet.has(p));

  if (uniqueNewPaths.length > 0) {
    state.batchFiles = [...state.batchFiles, ...uniqueNewPaths];
    state.batchResults = new Array(state.batchFiles.length).fill(null);
    updateBatchUI();
  }
}

function clearBatchFiles() {
  state.batchFiles = [];
  state.batchResults = [];
  updateBatchUI();
}

async function startBatchProcess() {
  if (state.batchProcessing) {
    // キャンセル
    state.batchCancelled = true;
    return;
  }

  if (state.batchFiles.length === 0) return;

  // バッチ設定を取得
  const batchCameraType = document.getElementById('batchCameraType')?.value || 'normal';
  const batchFps = parseFloat(document.getElementById('batchFps')?.value) || 60;
  const batchPoseModel = document.getElementById('batchPoseModel')?.value || 'rtmpose-x';
  const batchOutputFormat = batchPoseModel === 'synthpose-huge-onnx' ? 'synthpose' : '23pts';
  const batchEstimationMode = document.getElementById('batchEstimationMode')?.value || 'full';
  const frameSkip = batchEstimationMode === 'quick' ? 4 : 1;

  // Pythonサーバーが起動していない場合は遅延起動
  if (!state.serverStatus) {
    document.getElementById('batchCurrentFile').textContent = 'Pythonサーバーを起動中...';
    try {
      const result = await window.electronAPI.startPythonIfNeeded();
      if (!result.success) {
        showError(`Pythonサーバーの起動に失敗: ${result.error || '不明なエラー'}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) {
      showError(`Pythonサーバーの起動エラー: ${e.message}`);
      return;
    }
  }

  // モデルの確認・切り替え
  const currentPoseModel = state.loadedModels?.vitpose_type || 'rtmpose-x';
  if (currentPoseModel !== batchPoseModel) {
    document.getElementById('batchCurrentFile').textContent = `モデルを切り替え中 (${batchPoseModel})...`;
    try {
      const switchResult = await window.electronAPI.pythonRequestWithProgress('switch_model', {
        model_type: batchPoseModel
      });
      if (switchResult.success) {
        state.loadedModels = switchResult.data.models;
      } else {
        showError(`モデル切り替えに失敗: ${switchResult.error || '不明なエラー'}`);
        return;
      }
    } catch (e) {
      showError(`モデル切り替えエラー: ${e.message}`);
      return;
    }
  }

  state.batchProcessing = true;
  state.batchCancelled = false;
  state.batchCurrentIndex = 0;
  state.batchResults = new Array(state.batchFiles.length).fill(null);
  state.batchTotalFrames = 0;
  state.batchProcessedFrames = 0;
  state.batchPreviousFilesFrames = 0;

  // 各ファイルのフレーム数を保持
  let batchFilesFrames = new Array(state.batchFiles.length).fill(0);
  let currentFileTotalFrames = 0;

  updateBatchUI();
  updateBatchProgressUI();

  // 全ファイルのフレーム数を事前に取得
  document.getElementById('batchCurrentFile').textContent = 'ファイル情報を取得中...';
  try {
    const filesInfoResult = await window.electronAPI.pythonRequest('get_files_info', {
      file_paths: state.batchFiles
    });
    if (filesInfoResult.success && filesInfoResult.data) {
      state.batchTotalFrames = filesInfoResult.data.total_frames || 0;
      // 各ファイルのフレーム数を保存
      if (filesInfoResult.data.files) {
        filesInfoResult.data.files.forEach((fileInfo, idx) => {
          batchFilesFrames[idx] = fileInfo.frames || 0;
        });
      }
      updateBatchProgressUI();
    }
  } catch (e) {
    console.warn('Failed to get files info:', e);
    // 失敗しても処理は続行（従来通りinitハンドラで取得）
  }

  // initハンドラ（事前取得できなかった場合のフォールバック）
  const initHandler = (data) => {
    if (data.total_frames) {
      currentFileTotalFrames = data.total_frames;
      // 事前取得できなかった場合のみ加算
      if (batchFilesFrames[state.batchCurrentIndex] === 0) {
        batchFilesFrames[state.batchCurrentIndex] = data.total_frames;
        state.batchTotalFrames += data.total_frames;
        updateBatchProgressUI();
      }
    }
  };
  if (window.electronAPI.onPythonInit) {
    window.electronAPI.onPythonInit(initHandler);
  }

  // 進捗ハンドラを設定
  const progressHandler = (data) => {
    // 現在のファイルのフレーム進捗を更新
    state.batchProcessedFrames = state.batchPreviousFilesFrames + data.frame;

    const frameProgressText = document.getElementById('batchFrameProgress');
    if (frameProgressText) {
      frameProgressText.textContent = `${data.frame} / ${data.total}`;
    }

    updateBatchProgressUI();
  };
  if (window.electronAPI.onPythonProgress) {
    window.electronAPI.onPythonProgress(progressHandler);
  }

  for (let i = 0; i < state.batchFiles.length; i++) {
    if (state.batchCancelled) {
      // キャンセルされた場合、残りをスキップ
      for (let j = i; j < state.batchFiles.length; j++) {
        state.batchResults[j] = 'skipped';
      }
      break;
    }

    state.batchCurrentIndex = i;
    const filePath = state.batchFiles[i];
    const fileName = filePath.split(/[/\\]/).pop();
    currentFileTotalFrames = 0; // リセット

    document.getElementById('batchCurrentFile').textContent = `処理中: ${fileName}`;
    document.getElementById('batchFrameProgress').textContent = '';
    updateBatchUI();

    try {
      // ファイルタイプを判定
      const isVideo = isVideoFile(fileName);
      const isImage = isImageFile(fileName);

      if (!isVideo && !isImage) {
        state.batchResults[i] = 'skipped';
        continue;
      }

      // 推定を実行
      let detectionResult;
      if (isVideo) {
        detectionResult = await window.electronAPI.pythonRequestWithProgress('detect_video', {
          file_path: filePath,
          frame_skip: frameSkip,
          output_format: batchOutputFormat
        });
      } else {
        // 画像の場合は1フレームとしてカウント（事前取得できなかった場合のみ加算）
        currentFileTotalFrames = 1;
        if (batchFilesFrames[i] === 0) {
          batchFilesFrames[i] = 1;
          state.batchTotalFrames += 1;
          updateBatchProgressUI();
        }

        detectionResult = await window.electronAPI.pythonRequest('detect_image', {
          file_path: filePath
        });
      }

      if (!detectionResult.success) {
        state.batchResults[i] = 'error';
        continue;
      }

      // 結果を構造化
      let videoResult;
      if (isVideo) {
        videoResult = detectionResult.data;
      } else {
        // 画像の場合は1フレームの動画結果として構造化
        videoResult = {
          fps: 1,
          total_frames: 1,
          processed_frames: 1,
          width: detectionResult.data.width || 0,
          height: detectionResult.data.height || 0,
          frames: [{
            frame: 1,
            keypoints: detectionResult.data.keypoints
          }],
          keypoint_names: detectionResult.data.keypoint_names,
          processing_time_ms: detectionResult.data.processing_time_ms
        };
      }

      // プロジェクトデータを作成
      const hpePath = filePath.replace(/\.[^/.]+$/, '.hpe');
      const projectData = {
        version: '1.2',
        timestamp: new Date().toISOString(),
        fileType: isVideo ? 'video' : 'image',
        fileName: fileName,
        filePath: './' + fileName,  // 相対パス
        originalData: {
          total_frames: videoResult.total_frames,
          processed_frames: videoResult.processed_frames,
          width: videoResult.width,
          height: videoResult.height,
          frames: videoResult.frames,
          keypoint_names: videoResult.keypoint_names
        },
        filteredData: null,
        currentFrame: 1,
        viewMode: 'video',
        graphMode: 'list',
        filterSettings: {
          cameraType: batchCameraType,
          fps: batchFps,
          enableOutlier: false,
          enableInterpolation: false,
          interpolationMethod: 'pchip',
          enableButterworth: true,
          butterworthCutoff: 6.0,
          enableKalman: false
        },
        editHistory: [],
        models: {
          yolo: state.loadedModels?.yolo_model || 'Unknown',
          pose: state.loadedModels?.vitpose || 'Unknown'
        }
      };

      // hpeファイルを保存
      const saveResult = await window.electronAPI.saveProjectDirect(projectData, hpePath);
      if (saveResult.success) {
        state.batchResults[i] = 'success';
      } else {
        state.batchResults[i] = 'error';
      }

      // このファイルの処理済みフレーム数を累計に追加（事前取得したフレーム数を使用）
      const fileFrames = batchFilesFrames[i] || videoResult.processed_frames || videoResult.total_frames || 0;
      state.batchPreviousFilesFrames += fileFrames;
      state.batchProcessedFrames = state.batchPreviousFilesFrames;

    } catch (e) {
      console.error(`Batch error for ${fileName}:`, e);
      state.batchResults[i] = 'error';
      // エラー時もフレーム数を加算（事前取得またはinitで取得した値）
      const fileFrames = batchFilesFrames[i] || currentFileTotalFrames || 0;
      if (fileFrames > 0) {
        state.batchPreviousFilesFrames += fileFrames;
        state.batchProcessedFrames = state.batchPreviousFilesFrames;
      }
    }

    updateBatchUI();
    updateBatchProgressUI();
  }

  state.batchProcessing = false;
  document.getElementById('batchCurrentFile').textContent = state.batchCancelled ? 'キャンセルしました' : '処理完了';
  document.getElementById('batchFrameProgress').textContent = '';
  updateBatchUI();
  updateBatchProgressUI();
}

function initBatchModalEvents() {
  const modal = document.getElementById('batchModal');
  const closeBtn = document.getElementById('closeBatchBtn');
  const cancelBtn = document.getElementById('cancelBatchBtn');
  const selectBtn = document.getElementById('batchSelectFilesBtn');
  const clearBtn = document.getElementById('batchClearFilesBtn');
  const startBtn = document.getElementById('startBatchBtn');
  const modalBody = modal?.querySelector('.modal-body');

  if (closeBtn) closeBtn.addEventListener('click', closeBatchModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeBatchModal);
  if (selectBtn) selectBtn.addEventListener('click', selectBatchFiles);
  if (clearBtn) clearBtn.addEventListener('click', clearBatchFiles);
  if (startBtn) startBtn.addEventListener('click', startBatchProcess);

  // カメラタイプ変更時にFPSを自動設定
  const batchCameraType = document.getElementById('batchCameraType');
  const batchFps = document.getElementById('batchFps');
  if (batchCameraType && batchFps) {
    batchCameraType.addEventListener('change', () => {
      if (batchCameraType.value === 'highspeed') {
        batchFps.value = '240';
      } else {
        batchFps.value = '60';
      }
    });
  }

  // モーダル外クリックで閉じる
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal && !state.batchProcessing) {
        closeBatchModal();
      }
    });
  }

  // ドラッグ&ドロップ対応
  if (modalBody) {
    modalBody.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      modalBody.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
      modalBody.style.border = '2px dashed #3b82f6';
    });

    modalBody.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      modalBody.style.backgroundColor = '';
      modalBody.style.border = '';
    });

    modalBody.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      modalBody.style.backgroundColor = '';
      modalBody.style.border = '';

      if (state.batchProcessing) return;

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        const paths = [];
        for (let i = 0; i < files.length; i++) {
          // Electron環境でファイルパスを取得
          const filePath = window.electronAPI?.getFilePath(files[i]);
          if (filePath) {
            paths.push(filePath);
          }
        }
        if (paths.length > 0) {
          addBatchFiles(paths);
        }
      }
    });
  }
}

// プロジェクトデータを適用する関数 (共通ロジック)
async function applyProjectData(data, projectFilePath) {
  // ファイル読み込み成功後、状態を完全リセット
  console.log('[applyProjectData] プロジェクト読み込み開始 - 状態リセット');

  // 状態をクリア（アプリ新規起動と同等の状態に）
  state.selectedFile = null;
  state.previewUrl = null;
  state.fileType = null;
  state.result = null;
  state.videoResult = null;
  state.filteredResult = null;
  state.currentFrame = 1;
  state.isPlaying = false;
  state.isProcessing = false;
  state.viewMode = 'video';
  state.graphMode = 'list';
  state.editHistory = [];
  state.redoHistory = [];
  state.graphYRangeX = null;
  state.graphYRangeY = null;
  state.graphXRangeX = null;
  state.graphXRangeY = null;
  state.currentProjectPath = null;

  // フレームキャッシュをクリア
  if (state.frameCache) {
    state.frameCache = {};
  }

  // UIをリセット
  if (elements.previewVideo) {
    elements.previewVideo.src = '';
    elements.previewVideo.load();
  }
  if (elements.previewImage) {
    elements.previewImage.src = '';
  }
  if (elements.placeholder) {
    elements.placeholder.style.display = 'block';
  }
  if (elements.previewContainer) {
    elements.previewContainer.style.display = 'none';
  }
  if (elements.runButton) {
    elements.runButton.style.display = 'block';
  }
  if (elements.fileInfo) {
    elements.fileInfo.style.display = 'none';
  }

  // 少し待ってからデータを復元（UIリセットを確実に反映）
  await new Promise(resolve => setTimeout(resolve, 50));

  // fileTypeを設定
  state.fileType = data.fileType || 'video';

  // データを復元
  if (data.fileType === 'video') {
    // 軽量化対応: originalDataがない場合はfilteredDataを使用
    state.videoResult = data.originalData || data.filteredData;
    state.filteredResult = data.filteredData || null;
  } else {
    state.result = data.originalData;
  }

  // ファイル情報を復元（相対パスを絶対パスに解決）
  let resolvedFilePath = data.filePath;
  if (projectFilePath && data.filePath) {
    resolvedFilePath = toAbsolutePath(projectFilePath, data.filePath);
    console.log('[applyProjectData] パス解決:', data.filePath, '->', resolvedFilePath);
  }

  state.selectedFile = {
    path: resolvedFilePath || null,
    name: data.fileName || 'project'
  };
  state.filePath = resolvedFilePath || null; // 抽出処理用に設定

  // previewUrlを設定
  if (resolvedFilePath) {
    state.previewUrl = `file://${resolvedFilePath}`;
  }

  // 状態を復元
  state.currentFrame = data.currentFrame || 1;
  state.viewMode = data.viewMode || 'video';
  state.graphMode = data.graphMode || 'list';

  // 出力形式を復元してプリセットセレクタと同期
  state.outputFormat = data.outputFormat || '23pts';
  if (elements.presetSelect) {
    const matchingPreset = Object.entries(PRESET_CONFIG).find(([, cfg]) => cfg.outputFormat === state.outputFormat);
    if (matchingPreset) elements.presetSelect.value = matchingPreset[0];
  }
  state.editHistory = data.editHistory || [];
  state.graphYRangeX = data.graphYRangeX || null;
  state.graphYRangeY = data.graphYRangeY || null;

  if (data.graphXRangeX || data.graphXRangeY) {
    state.graphXRangeX = data.graphXRangeX || null;
    state.graphXRangeY = data.graphXRangeY || null;
  } else if (data.graphXRange) {
    state.graphXRangeX = data.graphXRange;
    state.graphXRangeY = data.graphXRange;
  }

  // フレームキャッシュパスを復元（存在確認は後で行う）
  state.extractedFramesDir = data.extractedFramesDir || null;
  state.frameImageCache = {}; // キャッシュをリセット

  // パスを記録
  state.currentProjectPath = projectFilePath;

  // 使用モデル情報を復元
  if (data.models) {
    state.usedModels = data.models || { yolo: null, pose: null };
    updateUsedModelInfoUI();
  } else {
    state.usedModels = { yolo: null, pose: null };
    const infoPanel = document.getElementById('usedModelInfo');
    if (infoPanel) infoPanel.style.display = 'none';
  }

  // フィルタ設定を復元
  if (data.filterSettings) {
    if (elements.cameraType) elements.cameraType.value = data.filterSettings.cameraType || 'normal';
    if (elements.videoFps) elements.videoFps.value = data.filterSettings.fps || 30;
    if (elements.enableOutlier) elements.enableOutlier.checked = data.filterSettings.enableOutlier || false;
    if (elements.enableInterpolation) elements.enableInterpolation.checked = data.filterSettings.enableInterpolation || false;
    // 補間手法とButterworthカットオフはlocalStorageに保存（設定パネルで管理）
    if (data.filterSettings.interpolationMethod) localStorage.setItem('interpolationMethod', data.filterSettings.interpolationMethod);
    if (elements.enableButterworth) elements.enableButterworth.checked = data.filterSettings.enableButterworth || false;
    if (data.filterSettings.butterworthCutoff) localStorage.setItem('butterworthCutoff', data.filterSettings.butterworthCutoff);
    if (elements.enableKalman) elements.enableKalman.checked = data.filterSettings.enableKalman || false;
  }

  // UIを更新
  elements.fileInfo.style.display = 'block';
  elements.fileName.textContent = data.fileName || 'プロジェクトファイル';
  elements.fileType.textContent = data.fileType === 'video' ? '動画' : '画像';
  elements.runButton.style.display = 'none';
  elements.placeholder.style.display = 'none';
  // ドロップゾーンを非表示
  if (elements.dropZone) {
    elements.dropZone.style.display = 'none';
  }
  elements.previewContainer.style.display = 'block';
  // 動画情報パネルを表示（FPS設定を確認・変更できるように）
  if (data.fileType === 'video') {
    elements.videoInfoPanel.style.display = 'block';
  }

  // 動画を読み込む（タイムアウト付き）
  if (data.fileType === 'video' && state.previewUrl) {
    elements.previewVideo.src = state.previewUrl;
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      elements.previewVideo.onloadeddata = () => {
        clearTimeout(timeout);
        resolve();
      };
      elements.previewVideo.onerror = () => {
        clearTimeout(timeout);
        console.warn('動画読み込み失敗:', state.previewUrl);
        resolve();
      };
    });
  }

  // 結果表示
  if (data.fileType === 'video') {
    showVideoResult();
  } else {
    showImageResult();
  }

  setGraphMode(state.graphMode);

  // 編集モードを更新
  if (state.editHistory.length > 0) {
    if (elements.undoEdit) elements.undoEdit.disabled = false;
    if (elements.graphEditMode) {
      elements.graphEditMode.textContent = '編集モード: ON';
      elements.graphEditMode.classList.add('active');
    }
  }

  updateStepGuide();
  showError('✅ プロジェクトを読み込みました');
  setTimeout(hideError, 2000);
}

// ファイルパスからプロジェクトを読み込む
async function loadProjectFromFilePath(filePath) {
  if (!window.electronAPI) return;
  // 既存プロジェクトがある場合は保存確認
  if (state.videoResult || state.result) {
    const confirmed = await showCloseConfirmDialog(
      '新しいプロジェクトを開く前に、現在のプロジェクトを保存しますか？'
    );
    if (confirmed === 'cancel') return;
    if (confirmed === 'save') await saveProject();
  }
  try {
    const result = await window.electronAPI.loadProjectFromPath(filePath);
    if (result.success) {
      await applyProjectData(result.data, result.filePath);
    } else {
      showError(`読み込みエラー: ${result.error}`);
    }
  } catch (e) {
    showError(`読み込みエラー: ${e.message}`);
  }
}

async function loadProject() {
  // 既存プロジェクトがある場合は保存確認を先に表示
  if (state.videoResult || state.result) {
    const confirmed = await showCloseConfirmDialog(
      '新しいプロジェクトを開く前に、現在のプロジェクトを保存しますか？'
    );
    if (confirmed === 'cancel') return;
    if (confirmed === 'save') await saveProject();
  }

  // ファイル選択ダイアログを開く
  let projectData = null;
  let projectFilePath = null;

  if (window.electronAPI) {
    try {
      const result = await window.electronAPI.loadProject();
      if (result.canceled || !result.success) {
        if (!result.canceled && result.error) {
          showError(`読み込みエラー: ${result.error}`);
        }
        return;
      }
      projectData = result.data;
      projectFilePath = result.filePath;
    } catch (e) {
      showError(`読み込みエラー: ${e.message}`);
      return;
    }
  } else {
    // ブラウザ環境ではファイル選択
    projectData = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.hpe';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (file) {
          try {
            const text = await file.text();
            resolve(JSON.parse(text));
          } catch (err) {
            showError(`読み込みエラー: ${err.message}`);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      };
      input.click();
    });
    if (!projectData) return;
  }

  // 共通処理でデータを適用
  await applyProjectData(projectData, projectFilePath);
}


// ===================================
// Initialize
// ===================================
document.addEventListener('DOMContentLoaded', () => {
  initElements();
  initEventListeners();
  initVideoRelinkEvents();
  initDigitizeEvents();  // 手動デジタイズ用イベント
  initRedetectEvents();  // フレーム再推定用イベント
  initCleansingTabs();   // クレンジングタブ切替

  // フィルタパネルの初期値をlocalStorageから読み込み
  initFilterPanelDefaults();

  // Pythonステータスリスナーを初期化
  initPythonStatusListener();

  // Pythonからのログをコンソールに出力 (initPythonStatusListener内で処理されるため削除)

  // 対象キーポイントリストを初期化（23ポイントを表示）
  updateDigitizeKeypointList();

  checkServerStatus();
  // IPC方式ではポーリングは不要だが、念のため残す（間隔を長くする）
  setInterval(checkServerStatus, 30000);

  // プリセット変更時の処理
  if (elements.presetSelect) {
    elements.presetSelect.addEventListener('change', async (e) => {
      const preset = e.target.value;
      const cfg = PRESET_CONFIG[preset];
      if (!cfg) return;

      // 出力形式を更新
      state.outputFormat = cfg.outputFormat;
      if (state.skeletonRenderer) {
        state.skeletonRenderer.updateConfig({ outputFormat: state.outputFormat });
      }
      if (state.skeletonPreviewRenderer) {
        state.skeletonPreviewRenderer.updateConfig({ outputFormat: state.outputFormat });
      }
      updateDigitizeKeypointList();
      if (state.videoResult || state.result) {
        renderCurrentFrame();
      }

      // モデルまたはYOLOが変わる場合はロード
      const modelChanged = cfg.model && state.loadedModels?.vitpose_type !== cfg.model;
      const yoloChanged  = cfg.yolo  && state.loadedModels?.yolo_model   !== cfg.yolo;
      if (modelChanged || yoloChanged) {
        await switchVitposeModel(cfg.model || null, null, cfg.yolo || null);
      }
    });
  }

  // カメラタイプ変更時にFPSを自動更新
  elements.cameraType.addEventListener('change', () => {
    const type = elements.cameraType.value;
    if (type === 'highspeed') {
      elements.videoFps.value = 240;
    } else {
      elements.videoFps.value = 60;
    }
  });

  // デバイス変更時（GPU環境でCPUに切り替え可能）
  const deviceSelect = document.getElementById('deviceSelect');
  if (deviceSelect) {
    deviceSelect.addEventListener('change', async (e) => {
      const device = e.target.value;
      // デバイス変更にはモデルの再ロードが必要
      await switchVitposeModel(null, device, null);
    });
  }


  // 初期モデル情報を取得 (python-status-update イベントで実行されるため削除)
  // initModelInfo();

  // メニューイベントのリスナーを設定
  if (window.electronAPI) {
    // ファイル関連メニュー
    window.electronAPI.onMenuLoadVideo(async () => {
      handleFileSelect();
    });

    window.electronAPI.onMenuLoadProjectFile(async (filePath) => {
      console.log('[Args] Loading project file:', filePath);
      try {
        if (filePath) {
          await loadProjectFromFilePath(filePath);
        }
      } catch (e) {
        showError('プロジェクト読み込みエラー', e.message);
      }
    });
    window.electronAPI.onMenuSaveProject(() => saveProject());
    window.electronAPI.onMenuSaveProjectAs(() => saveProjectAs());
    window.electronAPI.onMenuLoadProject(() => loadProject());
    window.electronAPI.onMenuCloseProject(() => closeProject());
    window.electronAPI.onMenuOpenSettings(() => openSettingsModal());
    window.electronAPI.onMenuBatchProcess(() => openBatchModal());
    window.electronAPI.onMenuSaveAndQuit(async () => {
      await saveProject();
      if (window.electronAPI.quitApp) {
        window.electronAPI.quitApp();
      }
    });
  }

  // スケルトンレンダラー初期化
  initSkeletonRenderers().catch(err => console.error(err));

  // ポイント設定スライダー初期化
  initPointSettingsSliders();

  // 設定モーダルイベント初期化
  initSettingsModalEvents();

  // バッチ処理モーダルイベント初期化
  initBatchModalEvents();

  // アプリ終了時のクリーンアップ
  window.addEventListener('beforeunload', cleanup);
});

// ===================================
// Graph Hover Events (Debug)
// ===================================
function initGraphHoverEvents() {
  const tooltip = document.createElement('div');
  tooltip.style.position = 'absolute';
  tooltip.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
  tooltip.style.color = 'white';
  tooltip.style.padding = '5px 10px';
  tooltip.style.borderRadius = '4px';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.fontSize = '12px';
  tooltip.style.display = 'none';
  tooltip.style.zIndex = '1000';
  tooltip.style.whiteSpace = 'pre-line'; // 改行を有効化
  tooltip.style.boxShadow = '0 2px 4px rgba(0,0,0,0.5)';
  tooltip.style.border = '1px solid rgba(255,255,255,0.2)';
  document.body.appendChild(tooltip);

  const handleMouseMove = (e, axis) => {
    if (!state.lastGraphData || state.viewMode !== 'graph' || state.graphMode !== 'detail') {
      tooltip.style.display = 'none';
      return;
    }

    const canvas = e.target;
    // キャンバスが非表示ならスキップ
    if (canvas.offsetParent === null) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // グラフの描画領域パラメータ（drawSingleGraphと同じ値を使用）
    const padding = { top: 30, right: 30, bottom: 50, left: 60 };
    const graphWidth = canvas.width - padding.left - padding.right;

    // 描画領域外なら非表示
    if (mouseX < padding.left || mouseX > canvas.width - padding.right ||
      mouseY < padding.top || mouseY > canvas.height - padding.bottom) {
      tooltip.style.display = 'none';
      return;
    }

    // マウス位置からフレームを逆算
    const { frames, rawFrames, personId, keypointIdx } = state.lastGraphData;

    // 現在の表示範囲
    // drawSingleGraphでのロジックと一致させる
    const frameData = state.lastGraphData.frames;

    // axisに応じて参照するX軸範囲を切り替え
    let currentXRange = null;
    if (axis === 'x') {
      currentXRange = state.graphXRangeX;
    } else {
      currentXRange = state.graphXRangeY;
    }

    const minFrame = currentXRange ? currentXRange.min : Math.min(...frameData);
    const maxFrame = currentXRange ? currentXRange.max : Math.max(...frameData);
    const frameRange = maxFrame - minFrame || 1;

    // 比率からフレームを特定
    const ratio = (mouseX - padding.left) / graphWidth;
    const targetFrame = Math.round(minFrame + ratio * frameRange);

    // 最寄りの有効フレームを探す（5px以内のフレーム）
    // ピクセルあたりのフレーム数
    const framesPerPixel = frameRange / graphWidth;
    const searchRadiusFrames = framesPerPixel * 5; // 5ピクセル分のフレーム範囲

    // ターゲットフレームに最も近いフレームを探す
    let closestFrameIdx = -1;
    let minDiff = Infinity;

    frames.forEach((f, i) => {
      const diff = Math.abs(f - targetFrame);
      if (diff < minDiff && diff <= searchRadiusFrames) {
        minDiff = diff;
        closestFrameIdx = i;
      }
    });

    if (closestFrameIdx !== -1) {
      const frameNum = frames[closestFrameIdx];
      const val = axis === 'x' ? state.lastGraphData.xValues[closestFrameIdx] : state.lastGraphData.yValues[closestFrameIdx];

      // 生データから情報を取得
      let confidence = 'N/A';
      let rawX = 'N/A', rawY = 'N/A';

      const rawFrame = rawFrames.find(f => f.frame === frameNum);
      if (rawFrame && rawFrame.keypoints) {
        const kpts = rawFrame.keypoints[String(personId)] || rawFrame.keypoints[personId];
        if (kpts && kpts[keypointIdx]) {
          confidence = kpts[keypointIdx][2].toFixed(3);
          rawX = kpts[keypointIdx][0].toFixed(2);
          rawY = kpts[keypointIdx][1].toFixed(2);
        }
      }

      // バリューがnullなら (Filtered) と表示
      const displayVal = val !== null ? val.toFixed(2) : 'null (Filtered out)';

      tooltip.style.display = 'block';
      tooltip.style.left = `${e.pageX + 10}px`;
      tooltip.style.top = `${e.pageY + 10}px`;
      tooltip.innerHTML = `Frame: ${frameNum}
Val (${axis.toUpperCase()}): ${displayVal}
Raw: (${rawX}, ${rawY})
Conf: ${confidence}`;
    } else {
      tooltip.style.display = 'none';
    }
  };

  const handleMouseLeave = () => {
    tooltip.style.display = 'none';
  };

  if (elements.graphCanvasX) {
    elements.graphCanvasX.addEventListener('mousemove', (e) => handleMouseMove(e, 'x'));
    elements.graphCanvasX.addEventListener('mouseleave', handleMouseLeave);
  }

  if (elements.graphCanvasY) {
    elements.graphCanvasY.addEventListener('mousemove', (e) => handleMouseMove(e, 'y'));
    elements.graphCanvasY.addEventListener('mouseleave', handleMouseLeave);
  }
}

// 使用モデル情報UIを更新
function updateUsedModelInfoUI() {
  const infoPanel = document.getElementById('usedModelInfo');
  const yoloSpan = document.getElementById('usedYoloModel');
  const poseSpan = document.getElementById('usedPoseModel');

  if (infoPanel && yoloSpan && poseSpan) {
    if (state.usedModels && (state.usedModels.yolo || state.usedModels.pose)) {
      // YOLO名: ファイル名から表示用に変換 (yolo26m.onnx → YOLO26-M)
      const yoloRaw = state.usedModels.yolo || '-';
      yoloSpan.textContent = yoloRaw.replace('.onnx', '').toUpperCase();
      poseSpan.textContent = state.usedModels.pose || '-';
      infoPanel.style.display = 'block';
    } else {
      infoPanel.style.display = 'none';
    }
  }
}
