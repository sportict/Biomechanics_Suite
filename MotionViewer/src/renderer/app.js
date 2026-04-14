/**
 * MotionViewer - 軽量モーションデータ3D可視化アプリ
 * 全機能統合版（ファイル処理 + Three.js + アニメーション + UI制御）
 */

import * as THREE from './lib/three.module.js';
import { OrbitControls } from './lib/OrbitControls.js';
import { butterWinter, addPadding, removePadding, calculateWaWCutoff, differentiateSpline, calculateResidualCurve, interpolateMissingData, filterVelocity } from './filter.js';
import { BodyCenterOfMass } from './body-com.js';

class MotionViewer {
  constructor() {
    // アプリケーション状態
    this.motionData = null;
    this.isPlaying = false;
    this.currentFrame = 0;
    this.animationSpeed = 1.0;
    this.animationId = null;
    this.currentProjectPath = null; // プロジェクトファイルパス
    this.pendingC3DMetadata = null; // C3Dファイルのメタデータ（ポイントラベル等）

    // Three.js関連
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.joints = [];
    this.bones = [];
    this.controls = null;

    // UI要素
    this.elements = {};

    // 人体骨格接続定義（29ポイント想定）
    this.skeletonConnections = [
      [0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [5, 6],  // 頭部・右腕
      [1, 7], [7, 8], [8, 9], [2, 10], [10, 11], [11, 12], // 左腕・胴体
      [12, 13], [13, 14], [14, 15], [12, 16], [16, 17], [17, 18], // 右脚
      [10, 19], [19, 20], [20, 21], [10, 22], [22, 23], [23, 24], // 左脚
      [15, 25], [18, 26], [21, 27], [24, 28] // 末端
    ];

    this.points = null;
    this.spheres = [];

    // 骨格結線リスト（0始まり）
    this.skeleton23 = [
      [0, 1, 2, 3, 13],         // 右上肢
      [4, 5, 6, 7, 22],         // 左上肢
      [8, 9, 10, 11, 12, 13, 19], // 右下肢
      [14, 15, 16, 17, 18, 19, 7], // 左下肢
      [20, 21, 22, 3]          // 頭部・体幹
    ];
    this.skeleton25 = [
      [0, 1, 2, 3, 23, 13],         // 右上肢
      [4, 5, 6, 7, 22],            // 左上肢
      [8, 9, 10, 11, 12, 13, 19],    // 右下肢
      [14, 15, 16, 17, 18, 19, 24, 7],// 左下肢
      [20, 21, 22, 3],            // 頭部・体幹
      [23, 24]                  // 肋骨
    ];

    // クラスプロパティに骨格線保持用配列を追加
    this.skeletonLines = [];
    this.stickLines = null;

    // データ中心点を保持するプロパティ
    this.dataCenter = new THREE.Vector3(0, 0, 0);

    // ラインごとの設定を保持する配列
    this.lineSettings = [];

    this.currentPointNames = [];
    this.currentStickType = null;
    this.dragCounter = 0;
    this.selectedJoints = new Set();

    // グリッド設定のデフォルト値をプロパティとして保持
    this.gridSize = 10;
    this.gridRows = 10;
    this.gridCols = 10;
    this.gridColor1 = '#888888';
    this.gridColor2 = '#cccccc';

    // 身体ポイント名リスト
    this.bodyPointNames23 = [
      "右手先", "右手首", "右肘", "右肩", "左手先", "左手首", "左肘", "左肩", "右つま先", "右母指球", "右かかと", "右足首", "右膝", "右大転子", "左つま先", "左母指球", "左かかと", "左足首", "左膝", "左大転子", "頭頂", "耳珠点", "胸骨上縁"
    ];
    this.bodyPointNames25 = [
      "右手先", "右手首", "右肘", "右肩", "左手先", "左手首", "左肘", "左肩", "右つま先", "右母指球", "右かかと", "右足首", "右膝", "右大転子", "左つま先", "左母指球", "左かかと", "左足首", "左膝", "左大転子", "頭頂", "耳珠点", "胸骨上縁", "右肋骨下端", "左肋骨下端"
    ];

    this.VIRTUAL_POINTS = {
      HIP_CENTER: 'hipCenter',
      RIB_LOWER_MIDPOINT: 'ribLowerMidpoint'
    };

    this.jointAngleDefinitionsBase = [
      { id: 'joint-1', name: '右手首', distalPoint: 0, jointCenter: 1, proximalPoint: 2 },
      { id: 'joint-2', name: '右肘', distalPoint: 1, jointCenter: 2, proximalPoint: 3 },
      { id: 'joint-3', name: '右肩', distalPoint: 2, jointCenter: 3, proximalPoint: 13 },
      { id: 'joint-4', name: '左手首', distalPoint: 4, jointCenter: 5, proximalPoint: 6 },
      { id: 'joint-5', name: '左肘', distalPoint: 5, jointCenter: 6, proximalPoint: 7 },
      { id: 'joint-6', name: '左肩', distalPoint: 6, jointCenter: 7, proximalPoint: 19 },
      { id: 'joint-7', name: '右母指球', distalPoint: 8, jointCenter: 9, proximalPoint: 11 },
      { id: 'joint-8', name: '右足首', distalPoint: 9, jointCenter: 11, proximalPoint: 12 },
      { id: 'joint-9', name: '右膝', distalPoint: 11, jointCenter: 12, proximalPoint: 13 },
      { id: 'joint-10', name: '右股関節', distalPoint: 12, jointCenter: 13, proximalPoint: 3 },
      { id: 'joint-11', name: '左母指球', distalPoint: 14, jointCenter: 15, proximalPoint: 17 },
      { id: 'joint-12', name: '左足首', distalPoint: 15, jointCenter: 17, proximalPoint: 18 },
      { id: 'joint-13', name: '左膝', distalPoint: 17, jointCenter: 18, proximalPoint: 19 },
      { id: 'joint-14', name: '左股関節', distalPoint: 18, jointCenter: 19, proximalPoint: 7 },
      { id: 'joint-15', name: '首', distalPoint: 20, jointCenter: 22, proximalPoint: this.VIRTUAL_POINTS.HIP_CENTER }
    ];

    this.segmentAngleDefinitions23 = [
      { id: 'segment-1', name: '右手', distalPoint: 0, proximalPoint: 1 },
      { id: 'segment-2', name: '右前腕', distalPoint: 1, proximalPoint: 2 },
      { id: 'segment-3', name: '右上腕', distalPoint: 2, proximalPoint: 3 },
      { id: 'segment-4', name: '左手', distalPoint: 4, proximalPoint: 5 },
      { id: 'segment-5', name: '左前腕', distalPoint: 5, proximalPoint: 6 },
      { id: 'segment-6', name: '左上腕', distalPoint: 6, proximalPoint: 7 },
      { id: 'segment-7', name: '右足部', distalPoint: 8, proximalPoint: 10 },
      { id: 'segment-8', name: '右下腿', distalPoint: 11, proximalPoint: 12 },
      { id: 'segment-9', name: '右大腿', distalPoint: 12, proximalPoint: 13 },
      { id: 'segment-10', name: '左足部', distalPoint: 14, proximalPoint: 16 },
      { id: 'segment-11', name: '左下腿', distalPoint: 17, proximalPoint: 18 },
      { id: 'segment-12', name: '左大腿', distalPoint: 18, proximalPoint: 19 },
      { id: 'segment-13', name: '頭部', distalPoint: 20, proximalPoint: 21 },
      { id: 'segment-14', name: '体幹', distalPoint: 22, proximalPoint: this.VIRTUAL_POINTS.HIP_CENTER }
    ];

    this.segmentAngleDefinitions25Extras = [
      { id: 'segment-15', name: '上胴', distalPoint: 22, proximalPoint: this.VIRTUAL_POINTS.RIB_LOWER_MIDPOINT },
      { id: 'segment-16', name: '下胴', distalPoint: this.VIRTUAL_POINTS.HIP_CENTER, proximalPoint: this.VIRTUAL_POINTS.RIB_LOWER_MIDPOINT }
    ];

    // 25点モデル用の関節角度定義（股関節は肋骨下端中点を使用）
    this.jointAngleDefinitions25 = [
      { id: 'joint-1', name: '右手首', distalPoint: 0, jointCenter: 1, proximalPoint: 2 },
      { id: 'joint-2', name: '右肘', distalPoint: 1, jointCenter: 2, proximalPoint: 3 },
      { id: 'joint-3', name: '右肩', distalPoint: 2, jointCenter: 3, proximalPoint: 13 },
      { id: 'joint-4', name: '左手首', distalPoint: 4, jointCenter: 5, proximalPoint: 6 },
      { id: 'joint-5', name: '左肘', distalPoint: 5, jointCenter: 6, proximalPoint: 7 },
      { id: 'joint-6', name: '左肩', distalPoint: 6, jointCenter: 7, proximalPoint: 19 },
      { id: 'joint-7', name: '右母指球', distalPoint: 8, jointCenter: 9, proximalPoint: 11 },
      { id: 'joint-8', name: '右足首', distalPoint: 9, jointCenter: 11, proximalPoint: 12 },
      { id: 'joint-9', name: '右膝', distalPoint: 11, jointCenter: 12, proximalPoint: 13 },
      { id: 'joint-10', name: '右股関節', distalPoint: 12, jointCenter: 13, proximalPoint: this.VIRTUAL_POINTS.RIB_LOWER_MIDPOINT },
      { id: 'joint-11', name: '左母指球', distalPoint: 14, jointCenter: 15, proximalPoint: 17 },
      { id: 'joint-12', name: '左足首', distalPoint: 15, jointCenter: 17, proximalPoint: 18 },
      { id: 'joint-13', name: '左膝', distalPoint: 17, jointCenter: 18, proximalPoint: 19 },
      { id: 'joint-14', name: '左股関節', distalPoint: 18, jointCenter: 19, proximalPoint: this.VIRTUAL_POINTS.RIB_LOWER_MIDPOINT },
      { id: 'joint-15', name: '首', distalPoint: 20, jointCenter: 22, proximalPoint: this.VIRTUAL_POINTS.HIP_CENTER }
    ];

    // 身体重心設定
    this.bodyCOM = null;                    // BodyCenterOfMassインスタンス
    this.bodyCOMResults = [];               // 全フレームの身体重心計算結果
    this.bodyCOMSphere = null;              // 身体重心表示用の球体
    this.bodyCOMEnabled = false;            // 身体重心表示が有効か

    // 軌跡設定
    this.trajectorySettings = [];
    this.trajectoryLines = [];
    this.lineTrajectoryLines = []; // ライン軌跡用

    this.currentLineColor = 0x0000ff;  // デフォルトの色（青）
    this.currentLineWidth = 10;         // デフォルトの太さ

    // 色の定義（名前と16進数カラーコードのマッピング）
    this.colorOptions = {
      '赤': 0xff0000,
      '青': 0x0000ff,
      '黄': 0xffff00,
      '白': 0xffffff,
      '紫': 0x800080,
      '緑': 0x008000,
      '黒': 0x000000,
      'オレンジ': 0xffa500,
      'ピンク': 0xffc0cb,
      'グレー': 0x808080
    };

    // 連続写真（図形描写）設定
    this.sequenceDrawing = {
      enabled: false,
      startFrame: 1,
      endFrame: 10,
      interval: 10
    };
    this.sequenceSkeletons = []; // 連続写真用の骨格群を保持

    // グラフ設定
    this.velocityAxis = 'composite'; // 'composite', 'x', 'y', 'z'
    this.positionAxis = 'x'; // 'x', 'y', 'z'
    this.graphMode = 'velocity'; // 'velocity' | 'position' | 'jointAngle' | 'segmentAngle' | 'jointTorque' | 'jointPower'
    this.selectedJointAngles = new Set();
    this.selectedSegmentAngles = new Set();
    this.visibleJointAngleArcs = new Set();
    this.visibleSegmentAngleArcs = new Set();  // セグメント角度弧表示用
    this.segmentAnglePlane = 'yz';
    this.segmentReferenceFrame = 'global';  // 'global' (GCS) or 'pelvis' (LCS)
    this.graphMinValue = null; // null = 自動
    this.graphMaxValue = null; // null = 自動
    this.graphControlsInitialized = false;

    // グラフズーム状態
    this.graphZoom = {
      timeMin: null,    // null = 自動（0）
      timeMax: null,    // null = 自動（totalTime）
      isDragging: false,   // 左クリック範囲選択
      isPanning: false,    // 右クリックパンニング
      dragStartX: 0,
      dragStartY: 0,
      dragCurrentX: 0,
      dragCurrentY: 0,
      panStartTimeMin: 0,
      panStartTimeMax: 0,
      panStartValueMin: 0,
      panStartValueMax: 0
    };

    // Canvas ベースの凡例状態
    this.legendState = {
      x: null,
      y: null,
      width: Math.max(120, 160), // 初期目安
      height: 0,
      minWidth: 80,        // 最小幅
      minHeight: 40,       // 最小高さ
      isDragging: false,
      dragOffsetX: 0,
      dragOffsetY: 0,
      isResizing: false,   // リサイズ中フラグ
      resizeEdge: null,    // リサイズエッジ: 'e', 'w', 'n', 's', 'ne', 'nw', 'se', 'sw'
      resizeStartX: 0,
      resizeStartY: 0,
      resizeStartWidth: 0,
      resizeStartHeight: 0,
      resizeStartLX: 0,
      resizeStartLY: 0,
      customSize: false,   // ユーザーがサイズを変更したか
      visible: false,
      colors: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF'],
      fontSize: 12,       // 凡例フォントサイズ
      titleFontSize: 11,  // 凡例タイトルフォントサイズ
      direction: 'vertical', // 'vertical' or 'horizontal'
      maxWidth: 300       // 横並び時の最大幅
    };

    // 現在選択中のシリーズデータ（色設定用）
    this.currentSeriesData = [];

    // グラフ設定
    this.graphSettings = {
      lineWidth: 2,       // グラフ線の太さ
      showGrid: true,     // グリッド表示
      gridColor: '#e0e0e0'
    };

    // 逆動力学
    this.inverseDynamicsResults = null;  // 計算結果
    this.inverseDynamicsInstance = null; // InverseDynamicsインスタンス
    this.selectedTorqueJoints = null; // 表示する関節トルク（nullで全選択）
    this.selectedPowerJoints = null;  // 表示する関節パワー（nullで全選択）

    // 速度データキャッシュ（スプライン微分法）
    this.velocityCache = null;  // { vx: [[]], vy: [[]], vz: [[]], composite: [[]] }
    this.velocityCacheValid = false;

    // グラフデータキャッシュ（パフォーマンス最適化）
    this.graphDataCache = null;  // { mode, seriesData, minValue, maxValue }
    this.graphDataCacheValid = false;
    this.graphDrawPending = false;  // 描画リクエストのスロットリング用

    // スティックピクチャー用の角度オーバーレイ格納先
    this.jointAngleArcObjects = new Map();
    this.segmentAngleArcObjects = new Map();  // セグメント角度弧

    // 慣性楕円体可視化
    this.inertiaVisualizationEnabled = false;
    this.inertiaMeshesById = new Map();
    this.inertiaBaseGeometry = new THREE.SphereGeometry(1, 24, 24);
    this.inertiaCogGeometry = new THREE.SphereGeometry(0.04, 16, 16);

    // フォースプレート可視化
    this.forcePlateData = null;         // C3Dから読み込んだフォースプレートデータ
    this.pendingForcePlateData = null;  // 初期化前の一時保存用
    this.forcePlateEnabled = true;      // フォースプレート表示有効
    this.forcePlateObjects = [];        // フォースプレートの3Dオブジェクト（矩形）
    this.forceVectorObjects = [];       // 力ベクトルの3Dオブジェクト（矢印）
    this.forceVectorScale = 0.001;      // 力ベクトルのスケール（N -> m）
    this.forceVectorColor = 0xff0000;   // 力ベクトルの色（赤）
    this.forcePlateOpacity = 0.3;       // プレートの透明度

    // 急峻移動ポイント検出設定
    this.highMotionVelocityThreshold = 1.0; // m/s
    // セグメント定義（ラベル名ベースの計算用）
    this.segmentDefinitions = {};

    this.init();
  }

  /**
   * アプリケーション初期化
   */
  async init() {
    console.log('MotionViewer 起動');
    this.initUIElements();
    this.setupEventListeners();
    this.setupFileHandling();
    this.updateUIState('no-file');
    console.log('初期化完了');

    // Electron IPCイベント受信でダイアログ表示
    if (window.electronAPI && window.electronAPI.on) {
      window.electronAPI.on('show-floor-settings-dialog', () => {
        this.showFloorSettingsDialog();
      });
      window.electronAPI.on('toggle-inertia-visualization', (enabled) => {
        this.toggleInertiaVisualization(!!enabled);
      });
    }

    // 動画出力ボタンのイベント設定（レガシー対応）
    const exportVideoBtn = document.getElementById('exportVideoBtn');
    if (exportVideoBtn) {
      exportVideoBtn.onclick = () => this.exportVideo();
    }

    // 画像出力ボタンのイベント設定
    const exportImageBtn = document.getElementById('exportImageBtn');
    if (exportImageBtn) {
      exportImageBtn.onclick = () => {
        if (!this.motionData || !this.renderer) {
          alert('モーションデータが読み込まれていません');
          return;
        }
        this.showImageFormatDialog();
      };
    }

    // 画像形式選択ダイアログのイベント設定
    const exportPngBtn = document.getElementById('exportPngBtn');
    const exportSvgBtn = document.getElementById('exportSvgBtn');
    const imageFormatCancel = document.getElementById('imageFormatCancel');
    const imageFormatDialog = document.getElementById('imageFormatDialog');

    if (exportPngBtn) {
      exportPngBtn.onclick = async () => {
        if (imageFormatDialog) imageFormatDialog.style.display = 'none';
        try {
          await this.saveScreenshotPNG();
        } catch (error) {
          console.error('PNG出力エラー:', error);
          alert('PNGの出力に失敗しました: ' + error.message);
        }
      };
    }

    if (exportSvgBtn) {
      exportSvgBtn.onclick = async () => {
        if (imageFormatDialog) imageFormatDialog.style.display = 'none';
        try {
          await this.saveScreenshotSVG();
        } catch (error) {
          console.error('SVG出力エラー:', error);
          alert('SVGの出力に失敗しました: ' + error.message);
        }
      };
    }

    if (imageFormatCancel) {
      imageFormatCancel.onclick = () => {
        if (imageFormatDialog) imageFormatDialog.style.display = 'none';
      };
    }
  }

  /**
   * UI要素の参照取得
   */
  initUIElements() {
    this.elements = {
      fileName: document.getElementById('fileName'),
      fileDetails: document.getElementById('fileDetails'),
      dropZone: document.getElementById('dropZone'),
      dropOverlay: document.getElementById('dropOverlay'),
      viewerContainer: document.getElementById('viewerContainer'),
      threeCanvas: document.getElementById('threeCanvas'),
      loadingIndicator: document.getElementById('loadingIndicator'),
      playBtn: document.getElementById('playBtn'),
      resetBtn: document.getElementById('resetBtn'),
      frameBackBtn: document.getElementById('frameBackBtn'),
      frameForwardBtn: document.getElementById('frameForwardBtn'),
      frameSlider: document.getElementById('frameSlider'),
      frameInput: document.getElementById('frameInput'),
      currentFrame: document.getElementById('currentFrame'),
      totalFrames: document.getElementById('totalFrames'),
      speedSlider: document.getElementById('speedSlider'),
      speedValue: document.getElementById('speedValue'),
      pointCount: document.getElementById('pointCount'),
      frameInterval: document.getElementById('frameInterval'),
      menuBackgroundColor: document.getElementById('menuBackgroundColor'),
      menuFloorSettings: document.getElementById('menuFloorSettings'),
      backgroundColorDialog: document.getElementById('backgroundColorDialog'),
      bgColorInput: document.getElementById('bgColorInput'),
      bgColorOk: document.getElementById('bgColorOk'),
      bgColorCancel: document.getElementById('bgColorCancel'),
      floorSettingsDialog: document.getElementById('floorSettingsDialog'),
      floorSizeInput: document.getElementById('floorSizeInput'),
      floorColorInput: document.getElementById('floorColorInput'),
      floorSettingsOk: document.getElementById('floorSettingsOk'),
      floorSettingsCancel: document.getElementById('floorSettingsCancel'),
      gridSizeInput: document.getElementById('gridSizeInput'),
      gridRowsInput: document.getElementById('gridRowsInput'),
      gridColsInput: document.getElementById('gridColsInput'),
      gridColorInput: document.getElementById('gridColorInput'),
      gridColor2Input: document.getElementById('gridColor2Input'),
      gridBgColorInput: document.getElementById('gridBgColorInput'),
      exportElapsedTime: document.getElementById('exportElapsedTime'),
      jointCheckboxes: document.getElementById('jointCheckboxes'),
      resizeHandle: document.getElementById('resizeHandle')
    };
  }

  /**
   * イベントリスナー設定
   */
  setupEventListeners() {
    // 再生制御
    this.elements.playBtn.addEventListener('click', () => this.toggleAnimation());
    this.elements.resetBtn.addEventListener('click', () => this.resetToFirstFrame());

    // コマ送り・戻し
    if (this.elements.frameBackBtn) {
      this.elements.frameBackBtn.addEventListener('click', () => {
        this.setCurrentFrame(this.currentFrame - 1);
      });
    }
    if (this.elements.frameForwardBtn) {
      this.elements.frameForwardBtn.addEventListener('click', () => {
        this.setCurrentFrame(this.currentFrame + 1);
      });
    }

    // フレーム制御
    this.elements.frameSlider.addEventListener('input', (e) => {
      this.setCurrentFrame(parseInt(e.target.value));
    });
    // 時間入力ボックスのイベントを'input'に変更し、即時反映させる
    this.elements.frameInput.addEventListener('input', (e) => {
      const time = parseFloat(e.target.value);
      if (this.motionData) {
        const frameInterval = this.motionData.header.frameInterval;
        if (!isNaN(time) && frameInterval > 0) {
          const frame = Math.round(time / frameInterval);
          // 無限ループを防ぐため、フレーム番号が実際に変わる場合のみ更新
          if (frame !== this.currentFrame) {
            this.setCurrentFrame(frame);
          }
        }
      }
    });
    // 時間入力ボックスの矢印キー操作をハンドル
    this.elements.frameInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.setCurrentFrame(this.currentFrame + 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.setCurrentFrame(this.currentFrame - 1);
      }
    });

    // 速度制御
    this.elements.speedSlider.addEventListener('input', (e) => {
      this.setAnimationSpeed(parseFloat(e.target.value));
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => this.handleKeyboard(e));

    // ウィンドウリサイズ
    window.addEventListener('resize', () => this.onWindowResize());

    // 背景色設定メニュー（要素が存在する場合のみ）
    if (this.elements.menuBackgroundColor) {
      this.elements.menuBackgroundColor.addEventListener('click', () => {
        // 現在の背景色を初期値にセット
        if (this.scene && this.scene.background) {
          this.elements.bgColorInput.value = '#' + this.scene.background.getHexString();
        } else {
          this.elements.bgColorInput.value = '#ffffff';
        }
        this.elements.backgroundColorDialog.style.display = 'flex';
      });
    }
    if (this.elements.bgColorOk) {
      this.elements.bgColorOk.addEventListener('click', () => {
        const color = this.elements.bgColorInput.value;
        if (this.scene) this.scene.background = new THREE.Color(color);
        this.elements.backgroundColorDialog.style.display = 'none';
      });
    }
    if (this.elements.bgColorCancel) {
      this.elements.bgColorCancel.addEventListener('click', () => {
        this.elements.backgroundColorDialog.style.display = 'none';
      });
    }
    // --- 床面設定ダイアログのイベントリスナー修正 ---
    if (this.elements.menuFloorSettings) {
      this.elements.menuFloorSettings.addEventListener('click', () => {
        this.showFloorSettingsDialog();
      });
    }

    if (this.elements.floorSettingsOk) {
      this.elements.floorSettingsOk.addEventListener('click', () => {
        this.gridColor1 = this.elements.gridColorInput.value;
        this.gridColor2 = this.elements.gridColor2Input.value;
        const color = new THREE.Color(this.gridColor1);
        const color2 = new THREE.Color(this.gridColor2);
        const bgColor = new THREE.Color(this.elements.gridBgColorInput.value);

        this.scene.background = bgColor;

        // 既存グリッドの色だけを変更
        if (this.gridHelpers) {
          this.gridHelpers.forEach(g => {
            g.material.color.set(color);
            if (g.material.color2) {
              g.material.color2.set(color2);
            }
          });
        }
        this.elements.floorSettingsDialog.style.display = 'none';
      });
    }

    if (this.elements.floorSettingsCancel) {
      this.elements.floorSettingsCancel.addEventListener('click', () => {
        this.elements.floorSettingsDialog.style.display = 'none';
      });
    }

    // グラフ表示メニューのイベントリスナー
    window.electronAPI.on('show-graph-display', () => {
      this.showGraphPanel();
    });

    // フィルタ設定ダイアログ表示
    window.electronAPI.on('show-filter-dialog', () => {
      this.showFilterDialog();
    });

    // 身体重心算出ダイアログ表示
    window.electronAPI.on('show-body-com-dialog', () => {
      this.showBodyCOMDialog();
    });

    // フォースプレート設定ダイアログ表示
    window.electronAPI.on('show-force-plate-dialog', () => {
      this.showForcePlateDialog();
    });

    // 逆動力学ダイアログ表示
    window.electronAPI.on('show-inverse-dynamics-dialog', () => {
      this.showInverseDynamicsDialog();
    });

    // セグメント定義ダイアログ表示
    window.electronAPI.on('show-segment-definition-dialog', () => {
      this.showSegmentDefinitionDialog();
    });

    // ポイント選択ボタンのイベント
    const toggleJointPanelBtn = document.getElementById('toggleJointPanel');
    const jointFloatPanel = document.getElementById('jointFloatPanel');
    const jointFloatClose = document.getElementById('jointFloatClose');

    if (toggleJointPanelBtn && jointFloatPanel) {
      toggleJointPanelBtn.addEventListener('click', () => {
        const isHidden = jointFloatPanel.style.display === 'none' || !jointFloatPanel.style.display;
        if (isHidden) {
          jointFloatPanel.style.display = 'block';
          const jointFloatBody = document.getElementById('jointFloatBody');
          if (jointFloatBody) {
            this.populateSelectionContainer(jointFloatBody, { idPrefix: 'float' });
          }
        } else {
          jointFloatPanel.style.display = 'none';
        }
      });
    }

    if (jointFloatClose) {
      jointFloatClose.addEventListener('click', () => {
        jointFloatPanel.style.display = 'none';
      });
    }

    // グラフ設定ボタンのイベント
    const openGraphSettingsBtn = document.getElementById('openGraphSettings');
    if (openGraphSettingsBtn) {
      openGraphSettingsBtn.addEventListener('click', () => {
        this.showGraphSettingsDialog();
      });
    }

    // グラフズームリセットボタンのイベント
    const resetGraphZoomBtn = document.getElementById('resetGraphZoom');
    if (resetGraphZoomBtn) {
      resetGraphZoomBtn.addEventListener('click', () => {
        this.resetGraphZoom();
      });
    }

    // フローティングパネルのドラッグ機能
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let panelStartX = 0, panelStartY = 0;

    const jointFloatHeader = document.getElementById('jointFloatHeader');
    if (jointFloatHeader && jointFloatPanel) {
      jointFloatHeader.addEventListener('mousedown', (e) => {
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const rect = jointFloatPanel.getBoundingClientRect();
        panelStartX = rect.left;
        panelStartY = rect.top;
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        jointFloatPanel.style.left = (panelStartX + dx) + 'px';
        jointFloatPanel.style.top = (panelStartY + dy) + 'px';
        jointFloatPanel.style.right = 'auto'; // rightを解除
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
      });
    }

    // ============================================
    // ツールバーボタンのイベントハンドラー
    // ============================================
    this.setupToolbarButtons();
  }

  /**
   * ツールバーボタンのセットアップ
   */
  setupToolbarButtons() {
    // モーションデータを開く
    const btnOpenMotion = document.getElementById('btnOpenMotion');
    if (btnOpenMotion) {
      btnOpenMotion.addEventListener('click', async () => {
        if (window.electronAPI && window.electronAPI.invoke) {
          await window.electronAPI.invoke('open-motion-dialog');
        }
      });
    }

    // プロジェクトを開く
    const btnOpenProject = document.getElementById('btnOpenProject');
    if (btnOpenProject) {
      btnOpenProject.addEventListener('click', async () => {
        if (window.electronAPI && window.electronAPI.invoke) {
          await window.electronAPI.invoke('open-project-dialog');
        }
      });
    }

    // プロジェクト保存
    const btnSaveProject = document.getElementById('btnSaveProject');
    if (btnSaveProject) {
      btnSaveProject.addEventListener('click', async () => {
        if (window.electronAPI && window.electronAPI.invoke) {
          await window.electronAPI.invoke('trigger-save-project');
        }
      });
    }

    // フィルタダイアログ
    const btnFilter = document.getElementById('btnFilter');
    if (btnFilter) {
      btnFilter.addEventListener('click', () => {
        this.showFilterDialog();
      });
    }

    // 身体重心ダイアログ
    const btnBodyCOM = document.getElementById('btnBodyCOM');
    if (btnBodyCOM) {
      btnBodyCOM.addEventListener('click', () => {
        this.showBodyCOMDialog();
      });
    }

    // 図形描写ウインドウを開く
    const btnSequenceDraw = document.getElementById('btnSequenceDraw');
    if (btnSequenceDraw) {
      btnSequenceDraw.addEventListener('click', () => {
        if (!this.motionData) return;
        this.showSequenceDrawDialog();
      });
    }

    // グラフ表示切り替え
    const btnGraph = document.getElementById('btnGraph');
    if (btnGraph) {
      btnGraph.addEventListener('click', () => {
        this.showGraphPanel();
        const graphContainer = document.getElementById('graphContainer');
        if (graphContainer && graphContainer.style.display !== 'none') {
          btnGraph.classList.add('active');
          this.onWindowResize(); // グラフ表示時にリサイズをトリガー
        } else {
          btnGraph.classList.remove('active');
        }
      });
    }

    // 画像出力
    const btnExportImage = document.getElementById('btnExportImage');
    if (btnExportImage) {
      btnExportImage.addEventListener('click', () => {
        if (!this.motionData || !this.renderer) {
          alert('モーションデータが読み込まれていません');
          return;
        }
        this.showImageFormatDialog();
      });
    }

    // 動画出力
    const btnExportVideo = document.getElementById('btnExportVideo');
    if (btnExportVideo) {
      btnExportVideo.addEventListener('click', () => {
        this.exportVideo();
      });
    }

    // ヘルプ
    const btnHelp = document.getElementById('btnHelp');
    if (btnHelp) {
      btnHelp.addEventListener('click', () => {
        this.showHelpDialog();
      });
    }

    // カメラビュー x-y平面
    const btnViewXY = document.getElementById('btnViewXY');
    if (btnViewXY) {
      btnViewXY.addEventListener('click', () => {
        this.setCameraView('xy');
      });
    }

    // カメラビュー y-z平面
    const btnViewYZ = document.getElementById('btnViewYZ');
    if (btnViewYZ) {
      btnViewYZ.addEventListener('click', () => {
        this.setCameraView('yz');
      });
    }

    // カメラビュー x-z平面
    const btnViewXZ = document.getElementById('btnViewXZ');
    if (btnViewXZ) {
      btnViewXZ.addEventListener('click', () => {
        this.setCameraView('xz');
      });
    }

    // ポイント設定
    const btnPointSettings = document.getElementById('btnPointSettings');
    if (btnPointSettings) {
      btnPointSettings.addEventListener('click', () => {
        this.showPointSettingsDialog();
      });
    }

    // ライン設定
    const btnLineSettings = document.getElementById('btnLineSettings');
    if (btnLineSettings) {
      btnLineSettings.addEventListener('click', () => {
        this.showLineSettingsDialog();
      });
    }

    // セグメント定義
    const btnSegmentDef = document.getElementById('btnSegmentDef');
    if (btnSegmentDef) {
      btnSegmentDef.addEventListener('click', () => {
        this.showSegmentDefinitionDialog();
      });
    }

    // 床面設定
    const btnFloorSettings = document.getElementById('btnFloorSettings');
    if (btnFloorSettings) {
      btnFloorSettings.addEventListener('click', () => {
        this.showFloorSettingsDialog();
      });
    }
  }

  /**
   * ツールバーボタンの有効/無効を切り替え
   */
  updateToolbarState(hasMotionData) {
    const buttons = [
      'btnSaveProject', 'btnFilter', 'btnBodyCOM', 'btnSequenceDraw',
      'btnGraph', 'btnExportImage', 'btnExportVideo',
      'btnViewXY', 'btnViewYZ', 'btnViewXZ',
      'btnPointSettings', 'btnLineSettings', 'btnFloorSettings'
    ];

    buttons.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.disabled = !hasMotionData;
      }
    });
  }

  /**
   * ヘルプダイアログ表示
   */
  showHelpDialog() {
    const dlg = document.getElementById('helpDialog');
    if (!dlg) return;

    const closeBtn = document.getElementById('helpClose');
    if (closeBtn) {
      closeBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * シンプルなグラフパネル表示/非表示切り替え
   */
  showGraphPanel() {
    console.log('[showGraphPanel] 呼び出し - selectedJoints:', Array.from(this.selectedJoints || []));
    const graphContainer = document.getElementById('graphContainer');
    const resizeHandle = document.getElementById('resizeHandle');
    const viewerContainer = document.querySelector('.viewer-container');
    const mainContent = document.querySelector('.main-content');
    if (!graphContainer || !viewerContainer || !mainContent) return;

    // 表示/非表示を切り替え
    const isVisible = graphContainer.style.display !== 'none' && graphContainer.style.display !== '';
    console.log('[showGraphPanel] isVisible:', isVisible);

    if (!isVisible) {
      console.log('[showGraphPanel] グラフを表示');
      // グラフを表示する場合
      graphContainer.style.display = 'flex';
      if (resizeHandle) {
        resizeHandle.style.display = 'block';
      }

      // 50%-50%のサイズを明示的に設定
      requestAnimationFrame(() => {
        const totalWidth = mainContent.offsetWidth;
        const handleWidth = resizeHandle ? 8 : 0;

        // 50%-50% の比率で設定 (flex-growを使用)
        viewerContainer.style.flex = `1 1 0px`;
        graphContainer.style.flex = `1 1 0px`;

        this.initGraph();
        this.setupResizeHandle();

        // レンダラーのサイズを更新
        requestAnimationFrame(() => {
          if (this.camera && this.renderer) {
            this.onWindowResize();
          }
        });
      });
    } else {
      console.log('[showGraphPanel] グラフを非表示');
      // グラフを非表示にする場合
      graphContainer.style.display = 'none';
      if (resizeHandle) {
        resizeHandle.style.display = 'none';
      }

      // レイアウトをリセット
      viewerContainer.style.flex = '1';
      graphContainer.style.flex = '1';

      // レンダラーのサイズを更新
      requestAnimationFrame(() => {
        if (this.camera && this.renderer) {
          this.onWindowResize();
        }
      });
    }
    console.log('[showGraphPanel] 完了 - selectedJoints:', Array.from(this.selectedJoints || []));
  }

  /**
   * リサイズハンドルの設定
   */
  setupResizeHandle() {
    const resizeHandle = document.getElementById('resizeHandle');
    const viewerContainer = document.querySelector('.viewer-container');
    const graphContainer = document.getElementById('graphContainer');

    if (!resizeHandle || !viewerContainer || !graphContainer) return;

    let isResizing = false;
    let startX = 0;
    let startViewerWidth = 0;
    let startGraphWidth = 0;

    const handleMouseDown = (e) => {
      isResizing = true;
      startX = e.clientX;
      startViewerWidth = viewerContainer.offsetWidth;
      startGraphWidth = graphContainer.offsetWidth;

      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      e.preventDefault();
    };

    const handleMouseMove = (e) => {
      if (!isResizing) return;

      const deltaX = e.clientX - startX;
      const newViewerWidth = startViewerWidth + deltaX;
      const newGraphWidth = startGraphWidth - deltaX;

      const mainContent = document.querySelector('.main-content');
      const totalWidth = mainContent.offsetWidth - 8; // リサイズハンドルの幅を除く

      // 最小幅制限（各パネル20%以上）
      const minWidth = totalWidth * 0.2;

      if (newViewerWidth >= minWidth && newGraphWidth >= minWidth) {
        // 固定ピクセルではなく比率 (flex-grow) として設定
        viewerContainer.style.flex = `${newViewerWidth} 1 0px`;
        graphContainer.style.flex = `${newGraphWidth} 1 0px`;
      }

      e.preventDefault();
    };

    const handleMouseUp = () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';

        // リサイズ完了時にレンダラーのサイズを更新
        // requestAnimationFrameを使用して確実に更新
        requestAnimationFrame(() => {
          if (this.camera && this.renderer) {
            this.onWindowResize();
          }
        });
      }
    };

    // イベントリスナーを設定（既存のリスナーがあれば削除）
    resizeHandle.onmousedown = handleMouseDown;
    document.onmousemove = handleMouseMove;
    document.onmouseup = handleMouseUp;
  }

  /**
   * データが2次元かどうかを判定
   */
  is2DData() {
    if (!this.motionData || !this.motionData.frames || this.motionData.frames.length === 0) {
      return false;
    }

    // 最初の数フレームをチェックして、すべてのZ座標が0または非常に小さい値かを確認
    const framesToCheck = Math.min(10, this.motionData.frames.length);
    let maxZ = 0;

    for (let f = 0; f < framesToCheck; f++) {
      const frame = this.motionData.frames[f];
      if (frame) {
        frame.forEach(point => {
          if (point && point.z !== undefined) {
            maxZ = Math.max(maxZ, Math.abs(point.z));
          }
        });
      }
    }

    // Z座標の最大値が0.001未満なら2次元とみなす
    return maxZ < 0.001;
  }

  /**
   * グラフの初期化
   */
  initGraph() {
    console.log('[initGraph] 開始');
    if (!this.motionData) return;

    // Canvas2Dコンテキストを取得
    const canvas = document.getElementById('scatterCanvas');
    if (!canvas) return;

    this.scatterCtx = canvas.getContext('2d');
    console.log('[initGraph] selectedJoints 初期化前:', this.selectedJoints);
    this.selectedJoints = this.selectedJoints || new Set();
    console.log('[initGraph] selectedJoints 初期化後:', Array.from(this.selectedJoints));

    // マウスホバー情報を初期化
    this.graphHoverInfo = null;

    // マウスイベントを設定
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const mouseX = (e.clientX - rect.left) * scaleX;
      const mouseY = (e.clientY - rect.top) * scaleY;

      // 凡例の操作チェック
      if (this.legendState.visible) {
        const lx = this.legendState.x;
        const ly = this.legendState.y;
        const lw = this.legendState.width;
        const lh = this.legendState.height;

        // リサイズエッジの検出
        const edge = this._detectLegendResizeEdge(mouseX, mouseY, lx, ly, lw, lh);
        if (edge) {
          this.legendState.isResizing = true;
          this.legendState.resizeEdge = edge;
          this.legendState.resizeStartX = mouseX;
          this.legendState.resizeStartY = mouseY;
          this.legendState.resizeStartWidth = lw;
          this.legendState.resizeStartHeight = lh;
          this.legendState.resizeStartLX = lx;
          this.legendState.resizeStartLY = ly;
          return;
        }

        // 凡例のバウンディングボックス内をクリックしたか判定（移動）
        if (mouseX >= lx && mouseX <= lx + lw && mouseY >= ly && mouseY <= ly + lh) {
          this.legendState.isDragging = true;
          this.legendState.dragOffsetX = mouseX - lx;
          this.legendState.dragOffsetY = mouseY - ly;
          canvas.style.cursor = 'move';
          return;
        }
      }

      // プロット領域内でのマウス操作
      const margin = 80;
      if (mouseX >= margin && mouseX <= canvas.width - margin &&
        mouseY >= margin && mouseY <= canvas.height - margin) {

        if (e.button === 0) {
          // 左クリック：範囲選択
          this.graphZoom.isDragging = true;
          this.graphZoom.isPanning = false;
          this.graphZoom.dragStartX = mouseX;
          this.graphZoom.dragStartY = mouseY;
          this.graphZoom.dragCurrentX = mouseX;
          this.graphZoom.dragCurrentY = mouseY;
        } else if (e.button === 2) {
          // 右クリック：パンニング
          const totalFrames = this.motionData ? this.motionData.frames.length : 1;
          const frameInterval = this.motionData ? (this.motionData.header.frameInterval || 0.004) : 0.004;
          const totalTime = totalFrames * frameInterval;

          // 現在のY軸範囲を取得
          const config = this.getGraphModeConfig();
          let dataMinValue = 0, dataMaxValue = 1;
          if (config) {
            dataMinValue = Infinity;
            dataMaxValue = -Infinity;
            config.selectedItems.forEach(item => {
              for (let frame = 0; frame < totalFrames; frame++) {
                const value = config.getValue(item, frame);
                if (value !== null && !isNaN(value)) {
                  dataMinValue = Math.min(dataMinValue, value);
                  dataMaxValue = Math.max(dataMaxValue, value);
                }
              }
            });
            if (!isFinite(dataMinValue)) dataMinValue = 0;
            if (!isFinite(dataMaxValue)) dataMaxValue = 1;
          }

          this.graphZoom.isPanning = true;
          this.graphZoom.isDragging = false;
          this.graphZoom.dragStartX = mouseX;
          this.graphZoom.dragStartY = mouseY;
          this.graphZoom.panStartTimeMin = this.graphZoom.timeMin !== null ? this.graphZoom.timeMin : 0;
          this.graphZoom.panStartTimeMax = this.graphZoom.timeMax !== null ? this.graphZoom.timeMax : totalTime;
          this.graphZoom.panStartValueMin = this.graphMinValue !== null ? this.graphMinValue : dataMinValue;
          this.graphZoom.panStartValueMax = this.graphMaxValue !== null ? this.graphMaxValue : dataMaxValue;
          canvas.style.cursor = 'grabbing';
        }
      }
    });

    // 右クリックメニューを無効化
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const mouseX = (e.clientX - rect.left) * scaleX;
      const mouseY = (e.clientY - rect.top) * scaleY;

      // リサイズ中
      if (this.legendState.isResizing) {
        this._handleLegendResize(mouseX, mouseY, canvas);
        this.drawScatterPlot();
        return;
      }

      // 凡例ドラッグによる移動
      if (this.legendState.isDragging) {
        this.legendState.x = mouseX - this.legendState.dragOffsetX;
        this.legendState.y = mouseY - this.legendState.dragOffsetY;
        this.legendState.x = Math.max(0, Math.min(canvas.width - this.legendState.width, this.legendState.x));
        this.legendState.y = Math.max(0, Math.min(canvas.height - this.legendState.height, this.legendState.y));
        this.drawScatterPlot();
        return;
      }

      // 範囲選択ドラッグ中（左クリック）
      if (this.graphZoom.isDragging) {
        this.graphZoom.dragCurrentX = mouseX;
        this.graphZoom.dragCurrentY = mouseY;
        this.drawScatterPlot();
        return;
      }

      // パンニング中（右クリック）
      if (this.graphZoom.isPanning) {
        const margin = 80;
        const plotWidth = canvas.width - margin * 2;
        const plotHeight = canvas.height - margin * 2;

        const totalFrames = this.motionData ? this.motionData.frames.length : 1;
        const frameInterval = this.motionData ? (this.motionData.header.frameInterval || 0.004) : 0.004;
        const totalTime = totalFrames * frameInterval;

        // X軸（時間）のパンニング
        const timeRange = this.graphZoom.panStartTimeMax - this.graphZoom.panStartTimeMin;
        const dx = mouseX - this.graphZoom.dragStartX;
        const timeDelta = -(dx / plotWidth) * timeRange;

        let newTimeMin = this.graphZoom.panStartTimeMin + timeDelta;
        let newTimeMax = this.graphZoom.panStartTimeMax + timeDelta;

        // 範囲を制限（0〜totalTimeの範囲内に収める）
        if (newTimeMin < 0) {
          newTimeMax -= newTimeMin;
          newTimeMin = 0;
        }
        if (newTimeMax > totalTime) {
          newTimeMin -= (newTimeMax - totalTime);
          newTimeMax = totalTime;
        }
        newTimeMin = Math.max(0, newTimeMin);
        newTimeMax = Math.min(totalTime, newTimeMax);

        this.graphZoom.timeMin = newTimeMin;
        this.graphZoom.timeMax = newTimeMax;

        // Y軸（値）のパンニング
        const valueRange = this.graphZoom.panStartValueMax - this.graphZoom.panStartValueMin;
        const dy = mouseY - this.graphZoom.dragStartY;
        // Y軸は画面座標と逆方向（上がプラス）
        const valueDelta = (dy / plotHeight) * valueRange;

        let newValueMin = this.graphZoom.panStartValueMin + valueDelta;
        let newValueMax = this.graphZoom.panStartValueMax + valueDelta;

        this.graphMinValue = newValueMin;
        this.graphMaxValue = newValueMax;

        this.drawScatterPlot();
        return;
      }

      // マウス位置から時間と速度を計算
      this.updateGraphHoverInfo(mouseX, mouseY, canvas.width, canvas.height);
      this.drawScatterPlot();

      // カーソルスタイルの変更
      if (this.legendState.visible) {
        const lx = this.legendState.x;
        const ly = this.legendState.y;
        const lw = this.legendState.width;
        const lh = this.legendState.height;

        const edge = this._detectLegendResizeEdge(mouseX, mouseY, lx, ly, lw, lh);
        if (edge) {
          canvas.style.cursor = this._getResizeCursor(edge);
        } else if (mouseX >= lx && mouseX <= lx + lw && mouseY >= ly && mouseY <= ly + lh) {
          canvas.style.cursor = 'grab';
        } else {
          canvas.style.cursor = 'crosshair';
        }
      } else {
        canvas.style.cursor = 'crosshair';
      }
    });

    canvas.addEventListener('mouseup', (e) => {
      if (this.legendState.isDragging) {
        this.legendState.isDragging = false;
      }
      if (this.legendState.isResizing) {
        this.legendState.isResizing = false;
        this.legendState.resizeEdge = null;
        this.legendState.customSize = true;
      }

      // 範囲選択完了 - ズーム適用
      if (this.graphZoom.isDragging) {
        this.graphZoom.isDragging = false;
        const margin = 80;
        const plotWidth = canvas.width - margin * 2;
        const plotHeight = canvas.height - margin * 2;

        // 最小ドラッグ距離をチェック（10px以上）
        const dx = Math.abs(this.graphZoom.dragCurrentX - this.graphZoom.dragStartX);
        const dy = Math.abs(this.graphZoom.dragCurrentY - this.graphZoom.dragStartY);
        if (dx > 10 && dy > 10) {
          // 現在の表示範囲を取得
          const totalFrames = this.motionData ? this.motionData.frames.length : 1;
          const frameInterval = this.motionData ? (this.motionData.header.frameInterval || 0.004) : 0.004;
          const totalTime = totalFrames * frameInterval;
          const currentTimeMin = this.graphZoom.timeMin !== null ? this.graphZoom.timeMin : 0;
          const currentTimeMax = this.graphZoom.timeMax !== null ? this.graphZoom.timeMax : totalTime;
          const timeRange = currentTimeMax - currentTimeMin;

          // ドラッグ範囲から新しい時間範囲を計算（X軸）
          const x1 = Math.max(margin, Math.min(this.graphZoom.dragStartX, this.graphZoom.dragCurrentX));
          const x2 = Math.min(canvas.width - margin, Math.max(this.graphZoom.dragStartX, this.graphZoom.dragCurrentX));
          const newTimeMin = currentTimeMin + ((x1 - margin) / plotWidth) * timeRange;
          const newTimeMax = currentTimeMin + ((x2 - margin) / plotWidth) * timeRange;

          // Y軸範囲も更新
          const config = this.getGraphModeConfig();
          if (config) {
            // 現在表示中のY軸範囲を取得
            let dataMinValue = Infinity, dataMaxValue = -Infinity;
            config.selectedItems.forEach(item => {
              for (let frame = 0; frame < totalFrames; frame++) {
                const value = config.getValue(item, frame);
                if (value !== null && !isNaN(value)) {
                  dataMinValue = Math.min(dataMinValue, value);
                  dataMaxValue = Math.max(dataMaxValue, value);
                }
              }
            });
            const currentMin = this.graphMinValue !== null ? this.graphMinValue : dataMinValue;
            const currentMax = this.graphMaxValue !== null ? this.graphMaxValue : dataMaxValue;
            const valueRange = currentMax - currentMin || 1;

            // Y座標からY軸値を計算（Y軸は上が大きい値、画面座標は上が小さい）
            const y1 = Math.max(margin, Math.min(this.graphZoom.dragStartY, this.graphZoom.dragCurrentY));
            const y2 = Math.min(canvas.height - margin, Math.max(this.graphZoom.dragStartY, this.graphZoom.dragCurrentY));
            const newMax = currentMax - ((y1 - margin) / plotHeight) * valueRange;
            const newMin = currentMax - ((y2 - margin) / plotHeight) * valueRange;

            this.graphMinValue = newMin;
            this.graphMaxValue = newMax;
          }

          this.graphZoom.timeMin = newTimeMin;
          this.graphZoom.timeMax = newTimeMax;

          // UIの入力欄を更新
          this.updateGraphRangeInputs();
        }
        this.drawScatterPlot();
      }

      // パンニング終了
      if (this.graphZoom.isPanning) {
        this.graphZoom.isPanning = false;
        // UIの入力欄を更新
        this.updateGraphRangeInputs();
      }

      canvas.style.cursor = 'crosshair';
    });

    canvas.addEventListener('mouseleave', () => {
      if (this.legendState.isDragging) {
        this.legendState.isDragging = false;
      }
      if (this.legendState.isResizing) {
        this.legendState.isResizing = false;
        this.legendState.resizeEdge = null;
      }
      if (this.graphZoom.isDragging) {
        this.graphZoom.isDragging = false;
      }
      if (this.graphZoom.isPanning) {
        this.graphZoom.isPanning = false;
      }
      canvas.style.cursor = 'crosshair';
      this.graphHoverInfo = null;
      this.drawScatterPlot();
    });

    // マウスホイールでズーム（X軸・Y軸両方）
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const mouseX = (e.clientX - rect.left) * scaleX;
      const mouseY = (e.clientY - rect.top) * scaleY;
      const margin = 80;

      // プロット領域外なら無視
      if (mouseX < margin || mouseX > canvas.width - margin) return;
      if (mouseY < margin || mouseY > canvas.height - margin) return;

      const totalFrames = this.motionData ? this.motionData.frames.length : 1;
      const frameInterval = this.motionData ? (this.motionData.header.frameInterval || 0.004) : 0.004;
      const totalTime = totalFrames * frameInterval;
      const plotWidth = canvas.width - margin * 2;
      const plotHeight = canvas.height - margin * 2;

      // === X軸（時間軸）のズーム ===
      const currentTimeMin = this.graphZoom.timeMin !== null ? this.graphZoom.timeMin : 0;
      const currentTimeMax = this.graphZoom.timeMax !== null ? this.graphZoom.timeMax : totalTime;
      const timeRange = currentTimeMax - currentTimeMin;

      // マウス位置を基準にズーム
      const mouseTimeRatio = (mouseX - margin) / plotWidth;
      const mouseTime = currentTimeMin + mouseTimeRatio * timeRange;

      // ズーム係数（ホイールアップで拡大、ダウンで縮小）
      const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;
      const newTimeRange = timeRange * zoomFactor;

      // 新しい時間範囲を計算（マウス位置を維持）
      let newTimeMin = mouseTime - mouseTimeRatio * newTimeRange;
      let newTimeMax = mouseTime + (1 - mouseTimeRatio) * newTimeRange;

      // 範囲制限
      if (newTimeMin < 0) {
        newTimeMax -= newTimeMin;
        newTimeMin = 0;
      }
      if (newTimeMax > totalTime) {
        newTimeMin -= (newTimeMax - totalTime);
        newTimeMax = totalTime;
      }
      newTimeMin = Math.max(0, newTimeMin);
      newTimeMax = Math.min(totalTime, newTimeMax);

      // === Y軸（値軸）のズーム ===
      // 現在のY軸範囲を取得
      const config = this.getGraphModeConfig();
      let dataMinValue = 0, dataMaxValue = 1;
      if (config) {
        dataMinValue = Infinity;
        dataMaxValue = -Infinity;
        config.selectedItems.forEach(item => {
          for (let frame = 0; frame < totalFrames; frame++) {
            const value = config.getValue(item, frame);
            if (value !== null && !isNaN(value)) {
              dataMinValue = Math.min(dataMinValue, value);
              dataMaxValue = Math.max(dataMaxValue, value);
            }
          }
        });
        if (!isFinite(dataMinValue)) dataMinValue = 0;
        if (!isFinite(dataMaxValue)) dataMaxValue = 1;
      }

      const currentValueMin = this.graphMinValue !== null ? this.graphMinValue : dataMinValue;
      const currentValueMax = this.graphMaxValue !== null ? this.graphMaxValue : dataMaxValue;
      const valueRange = currentValueMax - currentValueMin || 1;

      // マウスY位置を基準にズーム（Y軸は上が大きい値、画面座標は上が小さい）
      const mouseYRatio = (canvas.height - margin - mouseY) / plotHeight; // 0が下、1が上
      const mouseValue = currentValueMin + mouseYRatio * valueRange;

      const newValueRange = valueRange * zoomFactor;

      // 新しい値範囲を計算（マウス位置を維持）
      let newValueMin = mouseValue - mouseYRatio * newValueRange;
      let newValueMax = mouseValue + (1 - mouseYRatio) * newValueRange;

      // 最小範囲チェック
      const minYRange = Math.abs(dataMaxValue - dataMinValue) * 0.001 || 0.001;
      if (newTimeMax - newTimeMin >= 0.01 && newValueMax - newValueMin >= minYRange) {
        this.graphZoom.timeMin = newTimeMin;
        this.graphZoom.timeMax = newTimeMax;
        this.graphMinValue = newValueMin;
        this.graphMaxValue = newValueMax;
        this.updateGraphRangeInputs();
        this.drawScatterPlot();
      }
    }, { passive: false });

    if (!this.graphControlsInitialized) {
      this.setupGraphControlEvents();
      this.graphControlsInitialized = true;
    }
    this.refreshGraphControls();
    this.updateStickArcToggleVisibility();
    console.log('[initGraph] 完了');
  }

  setupGraphControlEvents() {
    const graphModeSelect = document.getElementById('graphModeSelect');
    if (graphModeSelect) {
      graphModeSelect.addEventListener('change', (e) => {
        this.graphMode = e.target.value;
        this.invalidateGraphCache();  // キャッシュ無効化
        this.updateGraphControlsVisibility();
        this.renderGraphSelectionList();
        this.drawScatterPlot();
      });
    }

    const velocityAxisRadios = document.querySelectorAll('input[name="velocityAxis"]');
    velocityAxisRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.velocityAxis = e.target.value;
        this.drawScatterPlot();
      });
    });

    const positionAxisRadios = document.querySelectorAll('input[name="positionAxis"]');
    positionAxisRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.positionAxis = e.target.value;
        this.drawScatterPlot();
      });
    });

    const segmentPlaneRadios = document.querySelectorAll('input[name="segmentPlane"]');
    segmentPlaneRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.segmentAnglePlane = e.target.value;
        this.invalidateGraphCache();
        this.drawScatterPlot();
        this.updateSegmentAngleArcs();  // スティックピクチャーのアークも更新
      });
    });

    // 座標系選択（グローバル/骨盤基準）
    const segmentReferenceRadios = document.querySelectorAll('input[name="segmentReference"]');
    segmentReferenceRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.segmentReferenceFrame = e.target.value;
        this.invalidateGraphCache();
        this.drawScatterPlot();
        this.updateSegmentAngleArcs();  // スティックピクチャーのアークも更新
      });
    });

    const graphMinInput = document.getElementById('graphMinValue');
    const graphMaxInput = document.getElementById('graphMaxValue');

    if (graphMinInput) {
      graphMinInput.addEventListener('change', (e) => {
        const val = e.target.value;
        this.graphMinValue = val === '' ? null : parseFloat(val);
        this.drawScatterPlot();
      });
    }

    if (graphMaxInput) {
      graphMaxInput.addEventListener('change', (e) => {
        const val = e.target.value;
        this.graphMaxValue = val === '' ? null : parseFloat(val);
        this.drawScatterPlot();
      });
    }

    // X軸（時間）範囲入力
    const graphTimeMinInput = document.getElementById('graphTimeMinValue');
    const graphTimeMaxInput = document.getElementById('graphTimeMaxValue');

    if (graphTimeMinInput) {
      graphTimeMinInput.addEventListener('change', (e) => {
        const val = e.target.value;
        this.graphZoom.timeMin = val === '' ? null : parseFloat(val);
        this.drawScatterPlot();
      });
    }

    if (graphTimeMaxInput) {
      graphTimeMaxInput.addEventListener('change', (e) => {
        const val = e.target.value;
        this.graphZoom.timeMax = val === '' ? null : parseFloat(val);
        this.drawScatterPlot();
      });
    }
  }

  refreshGraphControls() {
    const graphModeSelect = document.getElementById('graphModeSelect');
    if (graphModeSelect) {
      graphModeSelect.value = this.graphMode;
    }

    const velocityAxisRadios = document.querySelectorAll('input[name="velocityAxis"]');
    velocityAxisRadios.forEach(radio => {
      radio.checked = (radio.value === this.velocityAxis);
    });

    const positionAxisRadios = document.querySelectorAll('input[name="positionAxis"]');
    positionAxisRadios.forEach(radio => {
      radio.checked = (radio.value === this.positionAxis);
    });

    const segmentPlaneRadios = document.querySelectorAll('input[name="segmentPlane"]');
    segmentPlaneRadios.forEach(radio => {
      radio.checked = (radio.value === this.segmentAnglePlane);
    });

    const graphMinInput = document.getElementById('graphMinValue');
    const graphMaxInput = document.getElementById('graphMaxValue');
    if (graphMinInput) {
      graphMinInput.value = this.graphMinValue !== null ? this.graphMinValue : '';
    }
    if (graphMaxInput) {
      graphMaxInput.value = this.graphMaxValue !== null ? this.graphMaxValue : '';
    }

    this.updateGraphControlsVisibility();
    this.renderGraphSelectionList();
    this.updateStickArcToggleVisibility();
  }

  updateGraphControlsVisibility() {
    const velocitySelector = document.querySelector('.velocity-axis-selector');
    if (velocitySelector) {
      velocitySelector.style.display = this.graphMode === 'velocity' ? 'block' : 'none';
    }

    if (this.graphMode === 'velocity') {
      this.updateVelocityAxisOptions();
    }

    const positionSelector = document.getElementById('positionAxisSelector');
    if (positionSelector) {
      positionSelector.style.display = this.graphMode === 'position' ? 'block' : 'none';
    }

    if (this.graphMode === 'position') {
      this.updatePositionAxisOptions();
    }

    // 平面セレクターは廃止（水平面からの仰角のみ）- 常に非表示
    const segmentSelector = document.getElementById('segmentPlaneSelector');
    if (segmentSelector) {
      segmentSelector.style.display = 'none';
    }

    // 座標系セレクター（セグメント角度モード時のみ表示）
    const referenceSelector = document.getElementById('segmentReferenceSelector');
    if (referenceSelector) {
      if (this.graphMode === 'segmentAngle') {
        referenceSelector.style.display = 'block';
      } else {
        referenceSelector.style.display = 'none';
      }
    }

    const title = document.getElementById('graphSelectionTitle');
    if (title) {
      if (this.graphMode === 'jointAngle') {
        title.textContent = '表示する関節角度を選択：';
      } else if (this.graphMode === 'segmentAngle') {
        title.textContent = '表示するセグメント角度を選択：';
      } else if (this.graphMode === 'jointTorque') {
        title.textContent = '表示する関節トルクを選択：';
      } else if (this.graphMode === 'jointPower') {
        title.textContent = '表示する関節パワーを選択：';
      } else {
        title.textContent = '表示するポイントを選択：';
      }
    }

    const jointFloatPanel = document.getElementById('jointFloatPanel');
    if (jointFloatPanel && jointFloatPanel.style.display === 'block') {
      const jointFloatBody = document.getElementById('jointFloatBody');
      if (jointFloatBody) {
        this.populateSelectionContainer(jointFloatBody, { idPrefix: 'float' });
      }
    }

    const jointAngleOptions = document.getElementById('jointAngleOptions');
    if (jointAngleOptions) {
      jointAngleOptions.style.display = this.graphMode === 'jointAngle' ? 'block' : 'none';
    }

    this.updateStickArcToggleVisibility();
  }

  updateSegmentPlaneOptions() {
    const segmentSelector = document.getElementById('segmentPlaneSelector');
    if (!segmentSelector) return;
    const is2D = this.is2DData();
    const radios = segmentSelector.querySelectorAll('input[name="segmentPlane"]');
    radios.forEach(radio => {
      const parentLabel = radio.parentElement;
      if (!parentLabel) return;
      if (is2D && radio.value !== 'xy') {
        parentLabel.style.display = 'none';
        if (radio.checked) {
          this.segmentAnglePlane = 'xy';
          const xyRadio = segmentSelector.querySelector('input[name="segmentPlane"][value="xy"]');
          if (xyRadio) xyRadio.checked = true;
        }
      } else {
        parentLabel.style.display = '';
      }
    });
  }

  renderGraphSelectionList() {
    const container = document.getElementById('jointCheckboxes');
    if (container) {
      this.populateSelectionContainer(container, { idPrefix: 'graph' });
    }
  }

  getGraphSelectionMeta() {
    if (!this.motionData) {
      return {
        title: '表示するポイントを選択：',
        items: [],
        selectedSet: this.selectedJoints
      };
    }

    if (this.graphMode === 'jointAngle') {
      const defs = this.getJointAngleDefinitions();
      return {
        title: '表示する関節角度を選択：',
        items: defs.map(def => ({ id: def.id, name: def.name })),
        selectedSet: this.selectedJointAngles
      };
    }

    if (this.graphMode === 'segmentAngle') {
      const defs = this.getSegmentAngleDefinitions();
      return {
        title: '表示するセグメント角度を選択：',
        items: defs.map(def => ({ id: def.id, name: def.name })),
        selectedSet: this.selectedSegmentAngles
      };
    }

    if (this.graphMode === 'jointTorque') {
      const items = [];
      const joints = ['hip', 'knee', 'ankle'];
      const jointNamesJa = { hip: '股関節', knee: '膝関節', ankle: '足関節' };

      if (this.inverseDynamicsResults?.right) {
        joints.forEach(j => items.push({ id: `right_${j}`, name: `右${jointNamesJa[j]}` }));
      }
      if (this.inverseDynamicsResults?.left) {
        joints.forEach(j => items.push({ id: `left_${j}`, name: `左${jointNamesJa[j]}` }));
      }

      // 結果がない場合はプレースホルダー
      if (items.length === 0) {
        items.push({ id: 'none', name: '（計算結果なし）' });
      }

      return {
        title: '表示する関節トルクを選択：',
        items,
        selectedSet: this.selectedTorqueJoints
      };
    }

    if (this.graphMode === 'jointPower') {
      const items = [];
      const joints = ['hip', 'knee', 'ankle'];
      const jointNamesJa = { hip: '股関節', knee: '膝関節', ankle: '足関節' };

      if (this.inverseDynamicsResults?.right) {
        joints.forEach(j => items.push({ id: `right_${j}`, name: `右${jointNamesJa[j]}` }));
      }
      if (this.inverseDynamicsResults?.left) {
        joints.forEach(j => items.push({ id: `left_${j}`, name: `左${jointNamesJa[j]}` }));
      }

      // 結果がない場合はプレースホルダー
      if (items.length === 0) {
        items.push({ id: 'none', name: '（計算結果なし）' });
      }

      return {
        title: '表示する関節パワーを選択：',
        items,
        selectedSet: this.selectedPowerJoints
      };
    }

    const pointNames = this.currentPointNames || [];
    const items = pointNames.map((name, index) => ({
      id: index,
      name: name || `ポイント${index + 1}`
    }));

    return {
      title: '表示するポイントを選択：',
      items,
      selectedSet: this.selectedJoints
    };
  }

  populateSelectionContainer(container, options = {}) {
    if (!container) return;
    const meta = this.getGraphSelectionMeta();
    if (!meta) return;

    // selectedSetがnullの場合、全アイテムを選択状態で初期化
    if (!meta.selectedSet) {
      meta.selectedSet = new Set(meta.items.map(item => item.id));
      // 親のselectedSetも更新
      if (this.graphMode === 'jointTorque') {
        this.selectedTorqueJoints = meta.selectedSet;
      } else if (this.graphMode === 'jointPower') {
        this.selectedPowerJoints = meta.selectedSet;
      }
    }

    container.innerHTML = '';
    meta.items.forEach((item, idx) => {
      const checkboxItem = document.createElement('div');
      checkboxItem.className = 'joint-checkbox-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.graphItemId = item.id;
      const checkboxId = `${options.idPrefix || 'graph'}-item-${idx}`;
      checkbox.id = checkboxId;
      checkbox.checked = meta.selectedSet.has(item.id);

      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          meta.selectedSet.add(item.id);
        } else {
          meta.selectedSet.delete(item.id);
        }
        this.invalidateGraphCache();
        this.syncSelectionCheckboxes(item.id, e.target.checked, e.target);
        this.drawScatterPlot();
        if (this.graphMode === 'jointAngle') {
          this.handleJointAngleSelectionChange();
        } else if (this.graphMode === 'segmentAngle') {
          this.handleSegmentAngleSelectionChange();
        }
      });

      const label = document.createElement('label');
      label.htmlFor = checkboxId;
      label.textContent = item.name;

      checkboxItem.appendChild(checkbox);
      checkboxItem.appendChild(label);
      container.appendChild(checkboxItem);
    });
  }

  syncSelectionCheckboxes(itemId, checked, origin) {
    const checkboxes = document.querySelectorAll(`input[data-graph-item-id="${itemId}"]`);
    checkboxes.forEach(box => {
      if (box === origin) return;
      box.checked = checked;
    });
  }

  handleJointAngleSelectionChange() {
    const toggleInput = document.getElementById('toggleStickArcJoint');
    if (toggleInput && toggleInput.checked) {
      if (this.selectedJointAngles.size === 0) {
        toggleInput.checked = false;
        this.visibleJointAngleArcs.clear();
      } else {
        this.visibleJointAngleArcs = new Set(this.selectedJointAngles);
      }
    } else {
      const filtered = new Set();
      this.visibleJointAngleArcs.forEach(id => {
        if (this.selectedJointAngles.has(id)) {
          filtered.add(id);
        }
      });
      this.visibleJointAngleArcs = filtered;
    }
    this.updateJointAngleArcs(this.getCurrentFramePoints());
    this.updateStickArcToggleVisibility();
  }

  handleSegmentAngleSelectionChange() {
    const toggleInput = document.getElementById('toggleStickArcSegment');
    if (toggleInput && toggleInput.checked) {
      if (this.selectedSegmentAngles.size === 0) {
        toggleInput.checked = false;
        this.visibleSegmentAngleArcs.clear();
      } else {
        this.visibleSegmentAngleArcs = new Set(this.selectedSegmentAngles);
      }
    } else {
      const filtered = new Set();
      this.visibleSegmentAngleArcs.forEach(id => {
        if (this.selectedSegmentAngles.has(id)) {
          filtered.add(id);
        }
      });
      this.visibleSegmentAngleArcs = filtered;
    }
    this.updateSegmentAngleArcs(this.getCurrentFramePoints());
    this.updateStickArcToggleVisibility();
  }

  updateStickArcToggleVisibility() {
    const syncChecked = (checked) => {
      ['toggleStickArcJoint', 'toggleStickArcSegment'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = checked;
      });
    };

    const setupToggle = (id, mode) => {
      const toggle = document.getElementById(id);
      if (!toggle) return;

      // チェックボックスは常に押せるようにする（UX改善）
      toggle.disabled = false;

      const isVisible = mode === 'jointAngle'
        ? this.visibleJointAngleArcs.size > 0
        : this.visibleSegmentAngleArcs.size > 0;
      toggle.checked = isVisible;

      if (!toggle.dataset.bound) {
        toggle.dataset.bound = 'true';
        toggle.addEventListener('change', (e) => {
          const checked = e.target.checked;
          syncChecked(checked);

          if (this.graphMode === 'jointAngle') {
            if (checked) {
              if (this.selectedJointAngles.size === 0) {
                alert('スティックピクチャーに表示するには、右側のリストから少なくとも1つの関節角度を選択してください。');
                e.target.checked = false;
                syncChecked(false);
                this.visibleJointAngleArcs.clear();
              } else {
                this.visibleJointAngleArcs = new Set(this.selectedJointAngles);
              }
            } else {
              this.visibleJointAngleArcs.clear();
            }
            this.updateJointAngleArcs();
          } else if (this.graphMode === 'segmentAngle') {
            if (checked) {
              if (this.selectedSegmentAngles.size === 0) {
                alert('スティックピクチャーに表示するには、右側のリストから少なくとも1つのセグメント角度を選択してください。');
                e.target.checked = false;
                syncChecked(false);
                this.visibleSegmentAngleArcs.clear();
              } else {
                this.visibleSegmentAngleArcs = new Set(this.selectedSegmentAngles);
              }
            } else {
              this.visibleSegmentAngleArcs.clear();
            }
            this.updateSegmentAngleArcs();
          }
        });
      }
    };

    setupToggle('toggleStickArcJoint', 'jointAngle');
    setupToggle('toggleStickArcSegment', 'segmentAngle');

    const jointContainer = document.getElementById('jointAngleOptions');
    if (jointContainer) {
      jointContainer.style.display = this.graphMode === 'jointAngle' ? 'block' : 'none';
    }
    const segmentContainer = document.getElementById('segmentReferenceSelector');
    if (segmentContainer) {
      segmentContainer.style.display = this.graphMode === 'segmentAngle' ? 'block' : 'none';
    }
  }

  /**
   * 速度軸オプションの表示/非表示を更新
   */
  updateVelocityAxisOptions() {
    const is2D = this.is2DData();
    const zAxisLabel = document.querySelector('input[name="velocityAxis"][value="z"]')?.parentElement;

    if (zAxisLabel) {
      if (is2D) {
        // 2次元データの場合、Z軸ラジオボタンを非表示
        zAxisLabel.style.display = 'none';

        // 現在Z軸が選択されている場合、合成に変更
        if (this.velocityAxis === 'z') {
          this.velocityAxis = 'composite';
          const compositeRadio = document.querySelector('input[name="velocityAxis"][value="composite"]');
          if (compositeRadio) {
            compositeRadio.checked = true;
          }
        }
      } else {
        // 3次元データの場合、Z軸ラジオボタンを表示
        zAxisLabel.style.display = '';
      }
    }
  }

  /**
   * 位置軸オプションの表示/非表示を更新
   */
  updatePositionAxisOptions() {
    const is2D = this.is2DData();
    const zAxisLabel = document.querySelector('input[name="positionAxis"][value="z"]')?.parentElement;

    if (zAxisLabel) {
      if (is2D) {
        // 2次元データの場合、Z軸ラジオボタンを非表示
        zAxisLabel.style.display = 'none';

        // 現在Z軸が選択されている場合、X軸に変更
        if (this.positionAxis === 'z') {
          this.positionAxis = 'x';
          const xAxisRadio = document.querySelector('input[name="positionAxis"][value="x"]');
          if (xAxisRadio) {
            xAxisRadio.checked = true;
          }
        }
      } else {
        // 3次元データの場合、Z軸ラジオボタンを表示
        zAxisLabel.style.display = '';
      }
    }
  }

  /**
   * グラフのマウスホバー情報を更新
   */
  updateGraphHoverInfo(mouseX, mouseY, canvasWidth, canvasHeight) {
    if (!this.motionData) return;
    const config = this.getGraphModeConfig();
    if (!config || config.selectedItems.length === 0) {
      this.graphHoverInfo = null;
      return;
    }

    const margin = 80;
    const plotWidth = canvasWidth - margin * 2;
    const plotHeight = canvasHeight - margin * 2;

    // マウスがプロット領域内かチェック
    if (mouseX < margin || mouseX > canvasWidth - margin ||
      mouseY < margin || mouseY > canvasHeight - margin) {
      this.graphHoverInfo = null;
      return;
    }

    // マウス位置から時間を計算（ズーム範囲を考慮）
    const frameInterval = this.motionData.header.frameInterval || 0.004;
    const totalFrames = this.motionData.frames.length;
    const totalTime = totalFrames * frameInterval;

    // ズーム状態から表示範囲を取得
    const displayTimeMin = this.graphZoom.timeMin !== null ? this.graphZoom.timeMin : 0;
    const displayTimeMax = this.graphZoom.timeMax !== null ? this.graphZoom.timeMax : totalTime;
    const displayTimeRange = displayTimeMax - displayTimeMin || 1;

    const relativeX = mouseX - margin;
    const time = displayTimeMin + (relativeX / plotWidth) * displayTimeRange;
    const frame = Math.round(time / frameInterval);

    // フレーム範囲内かチェック
    if (frame < 0 || frame >= totalFrames) {
      this.graphHoverInfo = null;
      return;
    }

    const entries = [];
    const colorIndexMap = new Map();
    config.selectedItems.forEach((item, idx) => colorIndexMap.set(item, idx));
    config.selectedItems.forEach(item => {
      const value = config.getValue(item, frame);
      if (value !== null && !isNaN(value)) {
        entries.push({
          name: config.getLabel(item),
          value,
          colorIndex: colorIndexMap.get(item) ?? 0
        });
      }
    });

    if (entries.length === 0) {
      this.graphHoverInfo = null;
      return;
    }

    this.graphHoverInfo = {
      mouseX,
      mouseY,
      time,
      frame,
      entries,
      unit: config.tooltipUnit
    };
  }


  /**
   * 時間微分による速度を計算（Frame-DIAS6の計算式）
   */
  calculateVelocity(jointIndex, frame, axis) {
    const totalFrames = this.motionData.frames.length;
    const frameInterval = this.motionData.header.frameInterval || 0.004;

    // フレームが範囲外の場合
    if (frame < 0 || frame >= totalFrames) return NaN;

    const getCurrentPoint = (f) => {
      if (f < 0 || f >= totalFrames) return null;
      return this.motionData.frames[f][jointIndex];
    };

    const getAxisValue = (point) => {
      if (!point) return NaN;
      if (axis === 'x') return point.x;
      if (axis === 'y') return point.y;
      if (axis === 'z') return point.z;
      return NaN;
    };

    if (frame === 0) {
      // 最初のフレーム: S'(t1) = (-3S(t1) + 4S(t2) - S(t3)) / (2Δt)
      const p0 = getCurrentPoint(0);
      const p1 = getCurrentPoint(1);
      const p2 = getCurrentPoint(2);
      if (!p0 || !p1 || !p2) return NaN;
      const s0 = getAxisValue(p0);
      const s1 = getAxisValue(p1);
      const s2 = getAxisValue(p2);
      return (-3 * s0 + 4 * s1 - s2) / (2 * frameInterval);
    } else if (frame === totalFrames - 1) {
      // 最後のフレーム: S'(tn) = (S(tn-2) - 4S(tn-1) + 3S(tn)) / (2Δt)
      const pn_2 = getCurrentPoint(frame - 2);
      const pn_1 = getCurrentPoint(frame - 1);
      const pn = getCurrentPoint(frame);
      if (!pn_2 || !pn_1 || !pn) return NaN;
      const sn_2 = getAxisValue(pn_2);
      const sn_1 = getAxisValue(pn_1);
      const sn = getAxisValue(pn);
      return (sn_2 - 4 * sn_1 + 3 * sn) / (2 * frameInterval);
    } else {
      // 中間のフレーム: S'(ti) = (-S(ti-1) + S(ti+1)) / (2Δt)
      const p_prev = getCurrentPoint(frame - 1);
      const p_next = getCurrentPoint(frame + 1);
      if (!p_prev || !p_next) return NaN;
      const s_prev = getAxisValue(p_prev);
      const s_next = getAxisValue(p_next);
      return (-s_prev + s_next) / (2 * frameInterval);
    }
  }

  /**
   * 合成速度を計算
   */
  calculateCompositeVelocity(jointIndex, frame) {
    const vx = this.calculateVelocity(jointIndex, frame, 'x');
    const vy = this.calculateVelocity(jointIndex, frame, 'y');
    const vz = this.calculateVelocity(jointIndex, frame, 'z');
    return Math.sqrt(vx * vx + vy * vy + vz * vz);
  }

  getGraphModeConfig() {
    if (!this.motionData) return null;
    const totalFrames = this.motionData.frames.length;
    if (!totalFrames) return null;

    if (this.graphMode === 'jointAngle') {
      const definitions = this.getJointAngleDefinitions();
      const map = new Map(definitions.map(def => [def.id, def]));
      const selectedItems = Array.from(this.selectedJointAngles || []).filter(id => map.has(id));
      return {
        mode: 'jointAngle',
        selectedItems,
        axisLabel: '関節角度 (度)',
        tooltipUnit: '°',
        minSuggested: 0,
        maxSuggested: 180,
        getLabel: (id) => map.get(id).name,
        getValue: (id, frame) => this.calculateJointAngleValue(map.get(id), frame)
      };
    }

    if (this.graphMode === 'segmentAngle') {
      const definitions = this.getSegmentAngleDefinitions();
      const map = new Map(definitions.map(def => [def.id, def]));
      const selectedItems = Array.from(this.selectedSegmentAngles || []).filter(id => map.has(id));
      return {
        mode: 'segmentAngle',
        selectedItems,
        axisLabel: 'セグメント角度 (度)',
        tooltipUnit: '°',
        minSuggested: null,  // アンラップ後は±180を超えるため自動スケール
        maxSuggested: null,
        getLabel: (id) => map.get(id).name,
        getValue: (id, frame) => this.calculateSegmentAngleValue(map.get(id), frame)
      };
    }

    if (this.graphMode === 'position') {
      const selectedItems = Array.from(this.selectedJoints || []);
      const axisLabels = { x: 'X', y: 'Y', z: 'Z' };
      return {
        mode: 'position',
        selectedItems,
        axisLabel: `${axisLabels[this.positionAxis]}座標 (m)`,
        tooltipUnit: 'm',
        minSuggested: null,
        maxSuggested: null,
        getLabel: (index) => this.currentPointNames[index] || `ポイント${index + 1}`,
        getValue: (index, frame) => {
          const point = this.motionData.frames[frame]?.[index];
          if (!point) return null;
          return point[this.positionAxis];
        }
      };
    }

    // 関節トルク（両脚対応）
    if (this.graphMode === 'jointTorque') {
      if (!this.inverseDynamicsResults) {
        return {
          mode: 'jointTorque',
          selectedItems: [],
          axisLabel: '関節トルク (Nm)',
          tooltipUnit: 'Nm',
          minSuggested: null,
          maxSuggested: null,
          getLabel: () => '',
          getValue: () => null
        };
      }

      // 左右・各関節の組み合わせでアイテムを生成
      const jointItems = [];
      const jointLabels = {};
      const joints = ['hip', 'knee', 'ankle'];
      const jointNamesJa = { hip: '股関節', knee: '膝関節', ankle: '足関節' };

      if (this.inverseDynamicsResults.right) {
        joints.forEach(j => {
          jointItems.push(`right_${j}`);
          jointLabels[`right_${j}`] = `右${jointNamesJa[j]}`;
        });
      }
      if (this.inverseDynamicsResults.left) {
        joints.forEach(j => {
          jointItems.push(`left_${j}`);
          jointLabels[`left_${j}`] = `左${jointNamesJa[j]}`;
        });
      }

      const selectedItems = Array.from(this.selectedTorqueJoints || new Set(jointItems));

      return {
        mode: 'jointTorque',
        selectedItems,
        axisLabel: '関節トルク (Nm)',
        tooltipUnit: 'Nm',
        minSuggested: null,
        maxSuggested: null,
        getLabel: (item) => jointLabels[item] || item,
        getValue: (item, frame) => {
          const [side, joint] = item.split('_');
          const sideData = this.inverseDynamicsResults[side];
          if (!sideData || !sideData.dynamics?.[joint]?.moment) return null;
          return sideData.dynamics[joint].moment[frame];
        }
      };
    }

    // 関節パワー（両脚対応）
    if (this.graphMode === 'jointPower') {
      if (!this.inverseDynamicsResults) {
        return {
          mode: 'jointPower',
          selectedItems: [],
          axisLabel: '関節パワー (W)',
          tooltipUnit: 'W',
          minSuggested: null,
          maxSuggested: null,
          getLabel: () => '',
          getValue: () => null
        };
      }

      // 左右・各関節の組み合わせでアイテムを生成
      const jointItems = [];
      const jointLabels = {};
      const joints = ['hip', 'knee', 'ankle'];
      const jointNamesJa = { hip: '股関節', knee: '膝関節', ankle: '足関節' };

      if (this.inverseDynamicsResults.right) {
        joints.forEach(j => {
          jointItems.push(`right_${j}`);
          jointLabels[`right_${j}`] = `右${jointNamesJa[j]}`;
        });
      }
      if (this.inverseDynamicsResults.left) {
        joints.forEach(j => {
          jointItems.push(`left_${j}`);
          jointLabels[`left_${j}`] = `左${jointNamesJa[j]}`;
        });
      }

      const selectedItems = Array.from(this.selectedPowerJoints || new Set(jointItems));

      return {
        mode: 'jointPower',
        selectedItems,
        axisLabel: '関節パワー (W)',
        tooltipUnit: 'W',
        minSuggested: null,
        maxSuggested: null,
        getLabel: (item) => jointLabels[item] || item,
        getValue: (item, frame) => {
          const [side, joint] = item.split('_');
          const sideData = this.inverseDynamicsResults[side];
          if (!sideData || !sideData.power?.[joint]) return null;
          return sideData.power[joint][frame];
        }
      };
    }

    // 地面反力 (GRF)
    if (this.graphMode === 'grf') {
      if (!this.inverseDynamicsResults) {
        return {
          mode: 'grf',
          selectedItems: [],
          axisLabel: '地面反力 (N)',
          tooltipUnit: 'N',
          minSuggested: null,
          maxSuggested: null,
          getLabel: () => '',
          getValue: () => null
        };
      }

      const forceItems = ['fx', 'fy', 'fz'];
      const forceLabels = { fx: 'Fx (前後)', fy: 'Fy (左右)', fz: 'Fz (鉛直)' };
      const selectedItems = forceItems; // 全て表示

      return {
        mode: 'grf',
        selectedItems,
        axisLabel: '地面反力 (N)',
        tooltipUnit: 'N',
        minSuggested: null,
        maxSuggested: null,
        getLabel: (axis) => forceLabels[axis] || axis,
        getValue: (axis, frame) => {
          // 右脚または左脚の結果からGRFを取得
          const sideData = this.inverseDynamicsResults.right || this.inverseDynamicsResults.left;
          const data = sideData?.grf?.[axis];
          if (!data) return null;
          return data[frame];
        }
      };
    }

    const selectedItems = Array.from(this.selectedJoints || []);

    // 速度キャッシュが無効な場合は再計算
    if (!this.velocityCacheValid) {
      this.calculateAndCacheVelocity();
    }

    return {
      mode: 'velocity',
      selectedItems,
      axisLabel: '速度 (m/s)',
      tooltipUnit: 'm/s',
      minSuggested: this.velocityAxis === 'composite' ? 0 : null,
      maxSuggested: null,
      getLabel: (index) => this.currentPointNames[index] || `ポイント${index + 1}`,
      getValue: (index, frame) => {
        // FDF法でフィルタされた速度をキャッシュから取得
        return this.getVelocityFromCache(index, frame, this.velocityAxis);
      }
    };
  }

  /**
   * グラフデータキャッシュを無効化
   */
  invalidateGraphCache() {
    this.graphDataCacheValid = false;
    this.clearSegmentAngleCache();
  }

  /**
   * 散布図を描画
   */
  drawScatterPlot() {
    if (!this.scatterCtx || !this.motionData) return;
    const config = this.getGraphModeConfig();
    if (!config || config.selectedItems.length === 0) {
      this.legendState.visible = false;
      this.scatterCtx.clearRect(0, 0, this.scatterCtx.canvas.width, this.scatterCtx.canvas.height);
      return;
    }

    const canvas = document.getElementById('scatterCanvas');
    const ctx = this.scatterCtx;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const marginL = 100;
    const marginR = 60;
    const marginT = 40;
    const marginB = 60;
    const plotWidth = width - marginL - marginR;
    const plotHeight = height - marginT - marginB;
    const totalFrames = this.motionData.frames.length;
    const frameInterval = this.motionData.header.frameInterval || 0.004;
    const totalTime = totalFrames * frameInterval;

    // ズーム状態から表示範囲を取得
    const displayTimeMin = this.graphZoom.timeMin !== null ? this.graphZoom.timeMin : 0;
    const displayTimeMax = this.graphZoom.timeMax !== null ? this.graphZoom.timeMax : totalTime;
    const displayTimeRange = displayTimeMax - displayTimeMin || 1;

    // キャッシュキーを生成
    let cacheKey = `${config.mode}:${[...config.selectedItems].sort().join(',')}`;
    if (config.mode === 'segmentAngle') {
      cacheKey += `:${this.segmentReferenceFrame}`;
    } else if (config.mode === 'position') {
      cacheKey += `:${this.positionAxis}`;
    } else if (config.mode === 'velocity') {
      cacheKey += `:${this.velocityAxis}`;
    }

    // キャッシュが無効または異なるキーなら再計算
    let seriesData, minValue, maxValue, hasData;
    if (this.graphDataCacheValid && this.graphDataCache && this.graphDataCache.key === cacheKey) {
      // キャッシュヒット
      seriesData = this.graphDataCache.seriesData;
      minValue = this.graphDataCache.minValue;
      maxValue = this.graphDataCache.maxValue;
      hasData = this.graphDataCache.hasData;
    } else {
      // キャッシュミス - 再計算

      seriesData = [];
      const colorIndexMap = new Map();
      config.selectedItems.forEach((item, idx) => colorIndexMap.set(item, idx));
      minValue = Infinity;
      maxValue = -Infinity;
      hasData = false;

      config.selectedItems.forEach((item) => {
        const colorIndex = colorIndexMap.get(item) ?? 0;
        let values;

        // セグメント角度の場合は最適化された方法を使用
        if (config.mode === 'segmentAngle') {
          const unwrapped = this.getUnwrappedSegmentAngles(item, this.segmentReferenceFrame);
          if (unwrapped) {
            values = unwrapped.map(v => (v !== null && !isNaN(v)) ? v : null);
            values.forEach(v => {
              if (v !== null) {
                hasData = true;
                minValue = Math.min(minValue, v);
                maxValue = Math.max(maxValue, v);
              }
            });
          } else {
            values = new Array(totalFrames).fill(null);
          }
        } else {
          // 他のモードは従来通り
          values = [];
          for (let frame = 0; frame < totalFrames; frame++) {
            const value = config.getValue(item, frame);
            const valid = value !== null && !isNaN(value);
            values.push(valid ? value : null);
            if (valid) {
              hasData = true;
              minValue = Math.min(minValue, value);
              maxValue = Math.max(maxValue, value);
            }
          }
        }

        seriesData.push({
          item,
          label: config.getLabel(item),
          values,
          colorIndex
        });
      });

      // キャッシュを更新
      this.graphDataCache = { key: cacheKey, seriesData, minValue, maxValue, hasData };
      this.graphDataCacheValid = true;
    }

    if (!hasData) {
      this.legendState.visible = false;
      return;
    }

    if (typeof config.minSuggested === 'number') {
      minValue = Math.min(minValue, config.minSuggested);
    }
    if (typeof config.maxSuggested === 'number') {
      maxValue = Math.max(maxValue, config.maxSuggested);
    }

    // カスタムのY軸範囲が設定されていれば適用
    if (this.graphMinValue !== null && !isNaN(this.graphMinValue)) {
      minValue = this.graphMinValue;
    }
    if (this.graphMaxValue !== null && !isNaN(this.graphMaxValue)) {
      maxValue = this.graphMaxValue;
    }

    if (!isFinite(minValue) || !isFinite(maxValue) || minValue === maxValue) {
      minValue = minValue === maxValue ? minValue - 1 : 0;
      maxValue = maxValue + 1;
    }

    const valueRange = maxValue - minValue || 1;

    // 軸
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(marginL, marginT);
    ctx.lineTo(marginL, height - marginB);
    ctx.lineTo(width - marginR, height - marginB);
    ctx.stroke();

    // 横軸目盛
    ctx.fillStyle = '#333';
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const timeIntervals = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
    let timeStep = timeIntervals[0];
    for (const interval of timeIntervals) {
      if (displayTimeRange / interval <= 10) {
        timeStep = interval;
        break;
      }
    }

    const startTick = Math.ceil(displayTimeMin / timeStep) * timeStep;
    for (let t = startTick; t <= displayTimeMax; t += timeStep) {
      const x = marginL + ((t - displayTimeMin) / displayTimeRange) * plotWidth;
      if (x >= marginL && x <= width - marginR) {
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, height - marginB);
        ctx.lineTo(x, marginT);
        ctx.stroke();
        ctx.fillStyle = '#333';
        ctx.fillText(t.toFixed(2) + 's', x, height - marginB + 5);
      }
    }

    // 縦軸目盛
    ctx.font = '16px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const valueIntervals = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    let valueStep = valueIntervals[valueIntervals.length - 1];  // デフォルトは最大値
    for (const interval of valueIntervals) {
      if (valueRange / interval <= 10) {
        valueStep = interval;
        break;
      }
    }
    const minTick = Math.floor(minValue / valueStep) * valueStep;
    const maxTick = Math.ceil(maxValue / valueStep) * valueStep;

    for (let v = minTick; v <= maxTick; v += valueStep) {
      const y = height - marginB - ((v - minValue) / valueRange) * plotHeight;
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(marginL, y);
      ctx.lineTo(width - marginR, y);
      ctx.stroke();
      ctx.fillStyle = '#333';
      ctx.fillText(v.toFixed(1), marginL - 10, y);
    }

    // 軸ラベル
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(marginL, marginT);
    ctx.lineTo(marginL, height - marginB);
    ctx.lineTo(width - marginR, height - marginB);
    ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.font = '20px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('時間（秒）', width / 2, height - marginB + 30);

    ctx.save();
    ctx.translate(marginL - 75, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(config.axisLabel, 0, 0);
    ctx.restore();

    // プロット領域にクリッピングを設定
    ctx.save();
    ctx.beginPath();
    ctx.rect(marginL, marginT, plotWidth, plotHeight);
    ctx.clip();

    // データ線
    seriesData.forEach((series) => {
      const color = this.legendState.colors[series.colorIndex % this.legendState.colors.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = this.graphSettings.lineWidth || 2;
      ctx.beginPath();
      let hasStroke = false;
      for (let frame = 0; frame < totalFrames; frame++) {
        const value = series.values[frame];
        if (value === null || isNaN(value)) {
          // データが無効な場合、現在のパスをストロークしてリセット
          if (hasStroke) {
            ctx.stroke();
            ctx.beginPath();
            hasStroke = false;
          }
          continue;
        }
        const time = frame * frameInterval;
        // ズーム範囲外のポイントはスキップ
        if (time < displayTimeMin || time > displayTimeMax) {
          // 範囲外に出た場合、現在のパスをストロークしてリセット
          if (hasStroke) {
            ctx.stroke();
            ctx.beginPath();
            hasStroke = false;
          }
          continue;
        }
        const x = marginL + ((time - displayTimeMin) / displayTimeRange) * plotWidth;
        const y = height - marginB - ((value - minValue) / valueRange) * plotHeight;
        if (!hasStroke) {
          ctx.moveTo(x, y);
          hasStroke = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (hasStroke) {
        ctx.stroke();
      }
    });

    // 現在フレーム位置
    if (this.currentFrame >= 0 && this.currentFrame < totalFrames) {
      const time = this.currentFrame * frameInterval;
      // ズーム範囲内にある場合のみ描画
      if (time >= displayTimeMin && time <= displayTimeMax) {
        const x = marginL + ((time - displayTimeMin) / displayTimeRange) * plotWidth;

        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, marginT);
        ctx.lineTo(x, height - marginB);
        ctx.stroke();

        // 現在位置の値を表示
        seriesData.forEach((series) => {
          const value = series.values[this.currentFrame];
          if (value !== null && !isNaN(value)) {
            const y = height - marginB - ((value - minValue) / valueRange) * plotHeight;
            const color = this.legendState.colors[series.colorIndex % this.legendState.colors.length];
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        });
      }
    }

    // クリッピングを解除
    ctx.restore();

    // --- ここまで本来の描画処理 ---

    // 凡例 (Canvas上に直接描画)
    this.legendState.visible = true;
    this.drawCanvasLegend(ctx, seriesData, width);

    // ホバー情報
    if (this.graphHoverInfo && this.graphHoverInfo.entries.length > 0) {
      const info = this.graphHoverInfo;
      const hoverX = info.mouseX;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(hoverX, marginT);
      ctx.lineTo(hoverX, height - marginB);
      ctx.stroke();
      ctx.setLineDash([]);

      const tooltipEntries = info.entries.map(entry => ({
        text: `${entry.name}: ${entry.value.toFixed(2)} ${info.unit}`,
        colorIndex: entry.colorIndex ?? 0
      }));
      const tooltipLines = [`時間: ${info.time.toFixed(3)}秒`, ...tooltipEntries.map(entry => entry.text)];

      ctx.font = '20px Arial';
      const lineHeight = 28;
      const padding = 12;
      let maxWidth = 0;
      tooltipLines.forEach(line => {
        const metrics = ctx.measureText(line);
        maxWidth = Math.max(maxWidth, metrics.width);
      });

      const tooltipWidth = maxWidth + padding * 2;
      const tooltipHeight = tooltipLines.length * lineHeight + padding * 2;
      let tooltipX = hoverX + 10;
      let tooltipY = info.mouseY - tooltipHeight / 2;

      if (tooltipX + tooltipWidth > width - 10) {
        tooltipX = hoverX - tooltipWidth - 10;
      }
      if (tooltipY < marginT) {
        tooltipY = marginT;
      } else if (tooltipY + tooltipHeight > height - marginB) {
        tooltipY = height - marginB - tooltipHeight;
      }

      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      tooltipLines.forEach((line, idx) => {
        const textX = tooltipX + padding;
        const textY = tooltipY + padding + idx * lineHeight;
        if (idx === 0) {
          ctx.fillStyle = '#000000';
        } else {
          const entry = tooltipEntries[idx - 1];
          const colorIdx = entry ? entry.colorIndex : idx - 1;
          ctx.fillStyle = this.legendState.colors[colorIdx % this.legendState.colors.length];
        }
        ctx.fillText(line, textX, textY);
      });
    }

    // 範囲選択中の矩形を描画
    if (this.graphZoom.isDragging) {
      // X座標の範囲（プロット領域内に制限）
      const x1 = Math.max(marginL, Math.min(this.graphZoom.dragStartX, this.graphZoom.dragCurrentX));
      const x2 = Math.min(width - marginR, Math.max(this.graphZoom.dragStartX, this.graphZoom.dragCurrentX));
      // Y座標の範囲（プロット領域内に制限）
      const y1 = Math.max(marginT, Math.min(this.graphZoom.dragStartY, this.graphZoom.dragCurrentY));
      const y2 = Math.min(height - marginB, Math.max(this.graphZoom.dragStartY, this.graphZoom.dragCurrentY));

      const rectX = x1;
      const rectY = y1;
      const rectW = x2 - x1;
      const rectH = y2 - y1;

      // 選択範囲を半透明の青で塗りつぶし
      ctx.fillStyle = 'rgba(100, 150, 255, 0.2)';
      ctx.fillRect(rectX, rectY, rectW, rectH);

      // 選択範囲の境界線
      ctx.strokeStyle = 'rgba(50, 100, 200, 0.8)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(rectX, rectY, rectW, rectH);
      ctx.setLineDash([]);
    }
  }

  /**
   * Canvas 上に直接凡例を描画する（サイズに応じた自動レイアウト）
   */
  drawCanvasLegend(ctx, seriesData, canvasWidth) {
    // 現在のシリーズデータを保存（グラフ設定ダイアログで使用）
    this.currentSeriesData = seriesData;

    const fontSize = this.legendState.fontSize || 12;
    const padding = 8;
    const colorBoxWidth = 20;
    const colorBoxHeight = 3;
    const itemGap = 8;
    const itemHeight = Math.max(18, fontSize + 6);
    const useCustomSize = this.legendState.customSize;

    ctx.font = `${fontSize}px Arial`;

    // アイテムサイズを計算
    const itemMeasures = seriesData.map(s => {
      const textWidth = ctx.measureText(s.label).width;
      return {
        textWidth,
        itemWidth: colorBoxWidth + 6 + textWidth + itemGap
      };
    });

    let lw, lh;

    // カスタムサイズ使用時は既存サイズを使用
    if (useCustomSize) {
      lw = this.legendState.width;
      lh = this.legendState.height;
    } else {
      // 自動サイズ計算（デフォルトは横並び優先でコンパクトに）
      const maxWidth = this.legendState.maxWidth || 300;
      const { rows } = this._calculateLegendRows(itemMeasures, maxWidth, padding);
      lw = Math.max(80, Math.max(...rows.map(r => r.width)) + padding);
      lh = padding * 2 + rows.length * itemHeight;
    }

    // 位置設定
    if (this.legendState.x === null || this.legendState.y === null) {
      this.legendState.x = (canvasWidth - lw) / 2;
      this.legendState.y = 10;
    }

    if (!useCustomSize) {
      this.legendState.width = lw;
      this.legendState.height = lh;
    }

    const lx = this.legendState.x;
    const ly = this.legendState.y;

    // 現在のサイズでレイアウトを再計算（カスタムサイズの場合も含む）
    const { rows } = this._calculateLegendRows(itemMeasures, lw - padding, padding);

    // 背景描画
    this._drawLegendBackground(ctx, lx, ly, lw, lh);

    // クリップ領域を設定
    ctx.save();
    ctx.beginPath();
    ctx.rect(lx, ly, lw, lh);
    ctx.clip();

    // アイテム描画（サイズに応じて自動的に折り返し）
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `${fontSize}px Arial`;

    rows.forEach((row, rowIdx) => {
      let xOffset = lx + padding;
      const itemY = ly + padding + rowIdx * itemHeight + itemHeight / 2;

      row.items.forEach((item) => {
        const series = seriesData[item.index];
        const color = this.legendState.colors[series.colorIndex % this.legendState.colors.length];

        ctx.fillStyle = color;
        ctx.fillRect(xOffset, itemY - colorBoxHeight / 2, colorBoxWidth, colorBoxHeight);

        ctx.fillStyle = '#333333';
        ctx.fillText(series.label, xOffset + colorBoxWidth + 6, itemY);

        xOffset += item.itemWidth;
      });
    });

    ctx.restore();
  }

  /**
   * 凡例アイテムの行レイアウトを計算
   */
  _calculateLegendRows(itemMeasures, maxWidth, padding) {
    const rows = [];
    let currentRow = [];
    let currentRowWidth = padding;

    itemMeasures.forEach((m, i) => {
      if (currentRowWidth + m.itemWidth > maxWidth && currentRow.length > 0) {
        rows.push({ items: currentRow, width: currentRowWidth });
        currentRow = [];
        currentRowWidth = padding;
      }
      currentRow.push({ index: i, ...m });
      currentRowWidth += m.itemWidth;
    });
    if (currentRow.length > 0) {
      rows.push({ items: currentRow, width: currentRowWidth });
    }

    return { rows };
  }

  /**
   * 凡例描画（旧縦並び用 - 互換性のため残す）
   */
  _drawVerticalLegendItems(ctx, seriesData, itemMeasures, lx, ly, lw, lh, padding, colorBoxWidth, colorBoxHeight, fontSize) {
    const itemHeight = Math.max(20, fontSize + 8);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `${fontSize}px Arial`;

    seriesData.forEach((series, i) => {
      const itemY = ly + padding + i * itemHeight + itemHeight / 2;
      const color = this.legendState.colors[series.colorIndex % this.legendState.colors.length];

      ctx.fillStyle = color;
      ctx.fillRect(lx + padding, itemY - colorBoxHeight / 2, colorBoxWidth, colorBoxHeight);

      ctx.fillStyle = '#333333';
      ctx.fillText(series.label, lx + padding + colorBoxWidth + 8, itemY);
    });
  }

  /**
   * 凡例の背景を描画
   */
  _drawLegendBackground(ctx, lx, ly, lw, lh) {
    // 影
    ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;

    // 背景
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillRect(lx, ly, lw, lh);

    // 影リセット
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // ボーダー
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 1;
    ctx.strokeRect(lx, ly, lw, lh);
  }

  /**
   * 凡例のリサイズエッジを検出する
   * @returns {string|null} 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw' or null
   */
  _detectLegendResizeEdge(mouseX, mouseY, lx, ly, lw, lh) {
    const edgeSize = 8; // エッジの検出範囲（ピクセル）

    const nearLeft = mouseX >= lx - edgeSize && mouseX <= lx + edgeSize;
    const nearRight = mouseX >= lx + lw - edgeSize && mouseX <= lx + lw + edgeSize;
    const nearTop = mouseY >= ly - edgeSize && mouseY <= ly + edgeSize;
    const nearBottom = mouseY >= ly + lh - edgeSize && mouseY <= ly + lh + edgeSize;

    const inHorizontalRange = mouseX >= lx - edgeSize && mouseX <= lx + lw + edgeSize;
    const inVerticalRange = mouseY >= ly - edgeSize && mouseY <= ly + lh + edgeSize;

    // コーナー
    if (nearTop && nearLeft) return 'nw';
    if (nearTop && nearRight) return 'ne';
    if (nearBottom && nearLeft) return 'sw';
    if (nearBottom && nearRight) return 'se';

    // エッジ
    if (nearTop && inHorizontalRange) return 'n';
    if (nearBottom && inHorizontalRange) return 's';
    if (nearLeft && inVerticalRange) return 'w';
    if (nearRight && inVerticalRange) return 'e';

    return null;
  }

  /**
   * リサイズエッジに対応するカーソルを取得
   */
  _getResizeCursor(edge) {
    const cursors = {
      'n': 'ns-resize',
      's': 'ns-resize',
      'e': 'ew-resize',
      'w': 'ew-resize',
      'ne': 'nesw-resize',
      'sw': 'nesw-resize',
      'nw': 'nwse-resize',
      'se': 'nwse-resize'
    };
    return cursors[edge] || 'default';
  }

  /**
   * 凡例のリサイズを処理
   */
  _handleLegendResize(mouseX, mouseY, canvas) {
    const edge = this.legendState.resizeEdge;
    const dx = mouseX - this.legendState.resizeStartX;
    const dy = mouseY - this.legendState.resizeStartY;
    const minW = this.legendState.minWidth;
    const minH = this.legendState.minHeight;

    let newX = this.legendState.resizeStartLX;
    let newY = this.legendState.resizeStartLY;
    let newW = this.legendState.resizeStartWidth;
    let newH = this.legendState.resizeStartHeight;

    // 幅の変更
    if (edge.includes('e')) {
      newW = Math.max(minW, this.legendState.resizeStartWidth + dx);
    }
    if (edge.includes('w')) {
      const proposedW = this.legendState.resizeStartWidth - dx;
      if (proposedW >= minW) {
        newW = proposedW;
        newX = this.legendState.resizeStartLX + dx;
      }
    }

    // 高さの変更
    if (edge.includes('s')) {
      newH = Math.max(minH, this.legendState.resizeStartHeight + dy);
    }
    if (edge.includes('n')) {
      const proposedH = this.legendState.resizeStartHeight - dy;
      if (proposedH >= minH) {
        newH = proposedH;
        newY = this.legendState.resizeStartLY + dy;
      }
    }

    // キャンバス境界チェック
    newX = Math.max(0, newX);
    newY = Math.max(0, newY);
    if (newX + newW > canvas.width) newW = canvas.width - newX;
    if (newY + newH > canvas.height) newH = canvas.height - newY;

    this.legendState.x = newX;
    this.legendState.y = newY;
    this.legendState.width = newW;
    this.legendState.height = newH;
  }

  /**
   * グラフに描画するデータ系列を取得する
   */
  getGraphSeriesData(config) {
    if (!this.motionData || !this.motionData.frames || this.motionData.frames.length === 0) {
      return [];
    }

    const seriesData = [];
    const numFrames = this.motionData.frames.length;
    let colorCount = 0;

    config.selectedItems.forEach(pointIdx => {
      const pName = this.currentPointNames[pointIdx] || `Point ${pointIdx}`;
      const values = new Array(numFrames).fill(null);

      for (let f = 0; f < numFrames; f++) {
        const frameData = this.motionData.frames[f];
        if (!frameData || !frameData[pointIdx]) continue;

        let val = null;
        if (config.mode === 'position') {
          // 位置
          if (config.axis === 'x') val = frameData[pointIdx].x;
          else if (config.axis === 'y') val = frameData[pointIdx].y;
          else if (config.axis === 'z') val = frameData[pointIdx].z;
        } else if (config.mode === 'velocity' || config.mode === 'acceleration') {
          // 速度・加速度はキャッシュから取得
          const cache = config.mode === 'velocity' ? this.velocityCache : this.accelerationCache;
          if (cache && cache[pointIdx] && cache[pointIdx][f]) {
            const vec = cache[pointIdx][f];
            if (config.axis === 'v' || config.axis === 'a') {
              val = Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
            } else if (config.axis === 'x') val = vec.x;
            else if (config.axis === 'y') val = vec.y;
            else if (config.axis === 'z') val = vec.z;
          }
        } else if (config.mode === 'angle') {
          // 角度（セグメント角度）
          if (this.angleDataCache && this.angleDataCache[pointIdx]) {
            val = this.angleDataCache[pointIdx][f];
          }
        }
        values[f] = val;
      }

      seriesData.push({
        label: pName,
        colorIndex: colorCount++,
        values: values
      });
    });

    return seriesData;
  }


  /**
   * マウスホバー位置からグラフ情報を更新
   */
  updateGraphHoverInfo(mouseX, mouseY, width, height) {
    const config = this.getGraphModeConfig();
    if (!config) {
      this.graphHoverInfo = null;
      return;
    }
    const seriesData = this.getGraphSeriesData(config);

    if (!seriesData || seriesData.length === 0) {
      this.graphHoverInfo = null;
      return;
    }

    const marginL = 100;
    const marginR = 60;
    const marginT = 40;
    const marginB = 60;
    const plotWidth = width - marginL - marginR;
    const plotHeight = height - marginT - marginB;

    // Y軸の範囲計算
    let valMin = Infinity;
    let valMax = -Infinity;
    seriesData.forEach((series) => {
      series.values.forEach((v) => {
        if (v !== null && !isNaN(v)) {
          if (v < valMin) valMin = v;
          if (v > valMax) valMax = v;
        }
      });
    });

    if (valMin === Infinity || valMax === -Infinity) {
      this.graphHoverInfo = null;
      return;
    }

    if (valMin === valMax) {
      valMin -= 1;
      valMax += 1;
    }

    const valueRange = valMax - valMin;

    if (mouseX < marginL || mouseX > width - marginR || mouseY < marginT || mouseY > height - marginB) {
      this.graphHoverInfo = null;
      return;
    }

    let frameInterval = 1 / 30;
    if (this.motionData && this.motionData.frameTime) {
      frameInterval = this.motionData.frameTime;
    }

    const totalFrames = this.motionData ? this.motionData.frames : 0;
    if (totalFrames <= 0) {
      this.graphHoverInfo = null;
      return;
    }

    const totalTime = (totalFrames > 0) ? (totalFrames - 1) * frameInterval : 0;
    const safeTotalTime = totalTime > 0 ? totalTime : 1;

    // ズーム状態から表示範囲を取得
    const displayTimeMin = this.graphZoom.timeMin !== null ? this.graphZoom.timeMin : 0;
    const displayTimeMax = this.graphZoom.timeMax !== null ? this.graphZoom.timeMax : safeTotalTime;
    const displayTimeRange = displayTimeMax - displayTimeMin || 1;

    // x座標から時間を計算（ズーム範囲を考慮）
    const hoverTime = displayTimeMin + ((mouseX - marginL) / plotWidth) * displayTimeRange;
    // 最も近いフレームを検索
    let nearestFrame = Math.round(hoverTime / frameInterval);
    nearestFrame = Math.max(0, Math.min(totalFrames - 1, nearestFrame));

    // スナップしたX座標（ズーム範囲を考慮）
    const snappedTime = nearestFrame * frameInterval;
    const snappedX = marginL + ((snappedTime - displayTimeMin) / displayTimeRange) * plotWidth;

    const entries = [];
    seriesData.forEach((series) => {
      const v = series.values[nearestFrame];
      if (v !== null && !isNaN(v)) {
        entries.push({
          name: series.label,
          value: v,
          colorIndex: series.colorIndex
        });
      }
    });

    if (entries.length > 0) {
      this.graphHoverInfo = {
        mouseX: snappedX, // スナップしたX座標を使用
        mouseY,
        time: snappedTime,
        entries,
        unit: config.unit
      };
    } else {
      this.graphHoverInfo = null;
    }
  }

  /**
   * 床面設定ダイアログ表示
   */
  showFloorSettingsDialog() {
    // 現在の設定値をダイアログに反映
    this.elements.gridColorInput.value = this.gridColor1;
    this.elements.gridColor2Input.value = this.gridColor2;
    this.elements.gridBgColorInput.value = (this.scene && this.scene.background && this.scene.background.isColor)
      ? '#' + this.scene.background.getHexString()
      : '#ffffff';
    this.elements.floorSettingsDialog.style.display = 'flex';
  }

  /**
   * ファイル処理設定
   */
  setupFileHandling() {
    // Electronからのファイル読み込み
    if (window.electronAPI) {
      window.electronAPI.onFileLoaded((data) => {
        console.log('[onFileLoaded] data:', { fileName: data.fileName, filePath: data.filePath, hasContent: !!data.content, isC3D: data.isC3D });
        // C3Dメタデータがある場合は保存
        if (data.isC3D && data.c3dMetadata) {
          this.pendingC3DMetadata = data.c3dMetadata;
        } else {
          this.pendingC3DMetadata = null;
        }
        this.handleFileData(data.content, data.fileName, data.filePath);
      });
    }

    // ドラッグ&ドロップ
    const dropZone = this.elements.dropZone;
    const dropOverlay = this.elements.dropOverlay;

    // ドラッグカウンター方式で点滅防止
    dropZone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragCounter++;
      dropZone.classList.add('drag-over');
      dropOverlay.style.display = 'flex';
    });
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragCounter--;
      if (this.dragCounter === 0) {
        dropZone.classList.remove('drag-over');
        dropOverlay.style.display = 'none';
      }
    });
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragCounter = 0;
      dropZone.classList.remove('drag-over');
      dropOverlay.style.display = 'none';
      const file = e.dataTransfer.files[0];
      if (!window.fileAPI.isSupportedFile(file)) {
        alert('対応していないファイル形式です');
        return;
      }

      // preloadで取得したファイルパスを使用（キャプチャフェーズで先に保存される）
      await new Promise(resolve => setTimeout(resolve, 10));
      const filePath = window.fileAPI.getLastDroppedFilePath?.() || null;
      console.log('[Drop] file:', file.name, 'filePath:', filePath);

      if (filePath && window.electronAPI && window.electronAPI.invoke) {
        console.log('[Drop] IPCでファイルを読み込み:', filePath);
        try {
          const result = await window.electronAPI.invoke('load-file', filePath);
          if (result && result.success) {
            console.log('[Drop] IPC読み込み成功, isC3D:', result.isC3D);
            // C3Dメタデータがある場合は保存
            if (result.isC3D && result.c3dMetadata) {
              this.pendingC3DMetadata = result.c3dMetadata;
            } else {
              this.pendingC3DMetadata = null;
            }
            this.handleFileData(result.data, file.name, filePath);
            return;
          }
        } catch (err) {
          console.log('[Drop] IPC読み込みに失敗、直接読み込みにフォールバック:', err);
        }
      }
      // フォールバック: FileReader APIで読み込み（パスなし）
      console.log('[Drop] FileReader APIで読み込み（パスなし）');
      const text = await window.fileAPI.readFileAsText(file);
      this.handleFileData(text, file.name, null);
    });

    // メニューイベント受信
    if (window.electronAPI && window.electronAPI.on) {
      window.electronAPI.on('show-stick-picture-23', () => {
        this.currentStickType = 23;

        // ポイント名リストを23点表示用に調整
        if (this.currentPointNames.length > 23 && this.currentPointNames[23] === this.bodyPointNames25[23]) {
          this.currentPointNames[23] = `ポイント24`;
        }
        if (this.currentPointNames.length > 24 && this.currentPointNames[24] === this.bodyPointNames25[24]) {
          this.currentPointNames[24] = `ポイント25`;
        }

        this.initializeLineSettings(23);
        // セグメント定義テンプレートも自動適用
        this._applySegmentDefinitionTemplate('hpe23');
        if (this.motionData && this.motionData.frames) {
          const frameData = this.motionData.frames[this.currentFrame];
          this.drawStickPicture(frameData);
        }
      });
      window.electronAPI.on('show-stick-picture-25', () => {
        this.currentStickType = 25;

        // ポイント名リストを25点表示用に調整
        if (this.currentPointNames.length > 23 && this.currentPointNames[23] === `ポイント24`) {
          this.currentPointNames[23] = this.bodyPointNames25[23];
        }
        if (this.currentPointNames.length > 24 && this.currentPointNames[24] === `ポイント25`) {
          this.currentPointNames[24] = this.bodyPointNames25[24];
        }

        this.initializeLineSettings(25);
        // セグメント定義テンプレートも自動適用
        this._applySegmentDefinitionTemplate('hpe25');
        if (this.motionData && this.motionData.frames) {
          const frameData = this.motionData.frames[this.currentFrame];
          this.drawStickPicture(frameData);
        }
      });
      window.electronAPI.on('hide-stick-picture', () => {
        this.currentStickType = null;
        this.removeStickPicture();
      });
      window.electronAPI.on('show-point-settings', () => {
        console.log('app.js: show-point-settingsイベント受信');
        this.showPointSettingsDialog();
      });
      window.electronAPI.on('show-line-settings', () => {
        this.showLineSettingsDialog();
      });
      window.electronAPI.on('show-sequence-draw-dialog', () => {
        console.log('[DEBUG] show-sequence-draw-dialog event received');
        this.showSequenceDrawDialog();
      });
      window.electronAPI.on('set-camera-view', (viewType) => {
        console.log('[app.js] set-camera-viewイベント受信:', viewType);
        this.setCameraView(viewType);
      });

      // 設定保存のトリガー
      window.electronAPI.on('trigger-save-settings', async () => {
        if (!this.motionData || !this.motionData.header.fileName) {
          alert('設定を保存するには、まずモーションファイルを開いてください。');
          return;
        }
        try {
          const baseName = this.motionData.header.fileName.replace(/\.[^/.]+$/, "");
          const defaultSettingsName = `${baseName}.json`;

          const settings = this.collectSettings();
          const result = await window.electronAPI.invoke('save-settings-dialog', settings, this.getDefaultSavePath(defaultSettingsName));
          if (result.success) {
            alert('設定ファイルを保存しました: ' + result.filePath);
          } else if (result.error && !result.error.includes('canceled')) {
            throw new Error(result.error);
          }
        } catch (error) {
          console.error('設定の保存に失敗:', error);
          alert('設定の保存に失敗しました: ' + error.message);
        }
      });

      // 設定読み込みのトリガー
      window.electronAPI.on('load-settings-data', (content) => {
        if (!this.motionData) {
          alert('設定を読み込むには、まずモーションファイルを開いてください。');
          return;
        }
        try {
          const settings = JSON.parse(content);
          this.applySettings(settings);
        } catch (error) {
          console.error('設定ファイルの解析または適用エラー:', error);
          alert('設定ファイルの読み込みに失敗しました: ' + error.message);
        }
      });

      // 新規プロジェクト
      window.electronAPI.on('new-project', () => {
        // 現在のプロジェクトパスをクリア
        this.currentProjectPath = null;
        // ウィンドウをリロードして初期状態に戻す
        window.location.reload();
      });

      // プロジェクト保存
      window.electronAPI.on('save-project', async (options) => {
        try {
          // モーションデータが読み込まれているか確認
          if (!this.motionData || !this.motionData.frames) {
            alert('モーションファイルが読み込まれていません。\nファイルを読み込んでから保存してください。');
            return;
          }

          const projectData = this.collectProjectData();

          // 現在のプロジェクトパスを取得
          const currentPath = await window.electronAPI.invoke('get-current-project-path');

          if (!options.saveAs && currentPath) {
            // 上書き保存
            const result = await window.electronAPI.invoke('overwrite-project-file', {
              path: currentPath,
              data: projectData
            });
            if (result.success) {
              this.currentProjectPath = result.path;
              console.log('プロジェクトを上書き保存しました:', result.path);
            } else if (result.error && result.error !== 'cancelled') {
              throw new Error(result.error);
            }
          } else {
            // 新規保存（ダイアログ表示）
            const result = await window.electronAPI.invoke('save-project-file', projectData);
            if (result.success) {
              this.currentProjectPath = result.path;
              console.log('プロジェクトを保存しました:', result.path);
            } else if (result.error && result.error !== 'cancelled') {
              throw new Error(result.error);
            }
          }
        } catch (error) {
          console.error('プロジェクト保存エラー:', error);
          alert('プロジェクトの保存に失敗しました: ' + error.message);
        }
      });

      // プロジェクト読み込み
      window.electronAPI.on('load-project-data', async (payload) => {
        try {
          const { data, projectPath } = payload;
          this.currentProjectPath = projectPath;

          // バージョン2.0以降：フレームデータがプロジェクトに含まれている場合
          if (data.version === '2.0' && data.frames && data.motionHeader) {
            // プロジェクトのフレームデータから直接復元
            await this.restoreFromProjectData(data, projectPath);
          } else if (data.motionFilePath) {
            // 旧バージョン：モーションファイルを読み込み
            const fileResult = await window.electronAPI.invoke('load-file', data.motionFilePath);
            if (fileResult.success) {
              const fileName = data.motionFilePath.split(/[\\/]/).pop();
              await this.handleFileData(fileResult.data, fileName, data.motionFilePath);

              // 設定を適用
              if (data.settings) {
                this.applySettings(data.settings);
              }

              // カメラ・フレーム・速度を復元
              this.restoreCameraAndPlayback(data);

              console.log('プロジェクトを読み込みました:', projectPath);
            } else {
              throw new Error('モーションファイルの読み込みに失敗しました: ' + (fileResult.error || '不明なエラー'));
            }
          } else {
            // モーションデータが含まれていないプロジェクト
            throw new Error('プロジェクトにモーションデータが含まれていません。\nモーションファイルを読み込んだ状態で保存してください。');
          }
        } catch (error) {
          console.error('プロジェクト読み込みエラー:', error);
          alert('プロジェクトの読み込みに失敗しました: ' + error.message);
        }
      });
    }
  }

  /**
   * プロジェクトデータから直接復元する（バージョン2.0以降）
   */
  async restoreFromProjectData(data, projectPath) {
    try {
      const header = data.motionHeader;

      // モーションデータを構築（新形式のみ対応）
      this.motionData = {
        header: {
          fileName: header.fileName,
          frameCount: header.frameCount,
          pointCount: header.pointCount,
          frameInterval: header.frameInterval,
          duration: header.duration,
          dimension: header.dimension || 3
        },
        frames: data.frames
      };

      // ファイルパスを設定（参照用）
      this.lastLoadedFilePath = data.motionFilePath;

      // データ中心点を計算
      this.calculateDataCenter();

      // グラフ関連の状態をリセット
      this.selectedJoints = new Set();
      this.selectedJointAngles = new Set();
      this.selectedSegmentAngles = new Set();
      this.visibleJointAngleArcs = new Set();
      this.visibleSegmentAngleArcs = new Set();
      this.graphMode = 'velocity';
      this.velocityAxis = 'composite';
      this.positionAxis = 'x';
      this.segmentAnglePlane = 'xy';
      this.graphMinValue = null;
      this.graphMaxValue = null;
      this.velocityCacheValid = false;
      this.velocityCache = null;

      // ポイント名を設定（settingsから）
      if (data.settings && data.settings.pointSettings) {
        this.currentPointNames = data.settings.pointSettings.map(p => p.name);
      } else {
        this.initializePointNames();
      }

      // グラフのポイント選択パネルを更新
      const jointFloatBody = document.getElementById('jointFloatBody');
      if (jointFloatBody) {
        this.populateSelectionContainer(jointFloatBody, { idPrefix: 'float' });
      }

      // 軌跡設定を復元
      if (data.trajectorySettings) {
        this.trajectorySettings = data.trajectorySettings;
      } else {
        this.initializeTrajectorySettings();
      }

      // ライン軌跡設定を復元
      if (data.lineTrajectorySettings) {
        this.lineTrajectorySettings = data.lineTrajectorySettings;
      }

      // 連続描写設定を復元
      if (data.sequenceDrawing) {
        this.sequenceDrawing = data.sequenceDrawing;
      }

      // セグメント定義を復元
      if (data.segmentDefinitions) {
        this.segmentDefinitions = data.segmentDefinitions;
      } else if (data.settings && data.settings.segmentDefinitions) {
        this.segmentDefinitions = data.settings.segmentDefinitions;
      } else {
        this.segmentDefinitions = {};
      }

      // 現在のフレームとプレイ状態
      this.currentFrame = 0;
      this.isPlaying = false;

      // UI更新
      this.updateFileInfo(data.motionHeader.fileName);
      this.updateFrameControls();
      this.updateDataInfo();
      this.updateUIState('file-loaded');

      // 3Dシーンを初期化
      this.initThreeScene(() => {
        // ライン設定を先に復元（drawStickPictureで使用される）
        if (data.lineSettings && data.lineSettings.length > 0) {
          this.lineSettings = data.lineSettings;
        }

        // スティックピクチャータイプを設定して描画
        if (data.stickPictureType) {
          this.currentStickType = data.stickPictureType;
          if (this.motionData && this.motionData.frames) {
            const frameData = this.motionData.frames[this.currentFrame];
            this.drawStickPicture(frameData);
          }
          // メニューの状態を更新
          if (window.electronAPI && window.electronAPI.invoke) {
            window.electronAPI.invoke('reset-stick-picture-menu', data.stickPictureType);
          }
        }

        // 床面設定を先に適用（グリッド作成前に色を設定）
        if (data.settings && data.settings.floorSettings) {
          this.gridColor1 = data.settings.floorSettings.gridColor1 || this.gridColor1;
          this.gridColor2 = data.settings.floorSettings.gridColor2 || this.gridColor2;
        }

        // 床グリッドを調整（色設定済みの状態で作成）
        if (this.motionData && this.motionData.frames && this.motionData.frames.length > 0) {
          this.autoAdjustFloorGrid(this.motionData.frames);
        }

        // 床面背景色を適用（グリッド作成後に上書き）
        if (data.settings && data.settings.floorSettings && data.settings.floorSettings.backgroundColor) {
          this.scene.background = new THREE.Color(data.settings.floorSettings.backgroundColor);
        }

        // 表示設定を適用（ポイント・ライン設定など）
        if (data.settings) {
          this.applySettings(data.settings);
        }

        // カメラ・フレーム・速度を復元
        this.restoreCameraAndPlayback(data);

        console.log('プロジェクトを復元しました:', projectPath);
      });
    } catch (error) {
      console.error('プロジェクト復元エラー:', error);
      throw error;
    }
  }

  /**
   * カメラ位置と再生設定を復元
   */
  restoreCameraAndPlayback(data) {
    // カメラ位置を復元
    if (data.cameraPosition && this.camera) {
      this.camera.position.set(
        data.cameraPosition.x,
        data.cameraPosition.y,
        data.cameraPosition.z
      );
    }
    if (data.cameraTarget && this.controls) {
      this.controls.target.set(
        data.cameraTarget.x,
        data.cameraTarget.y,
        data.cameraTarget.z
      );
      this.controls.update();
    }

    // 現在のフレームを復元
    if (typeof data.currentFrame === 'number') {
      this.setCurrentFrame(data.currentFrame);
    }

    // 再生速度を復元
    if (typeof data.animationSpeed === 'number') {
      this.setAnimationSpeed(data.animationSpeed);
    }
  }

  /**
   * ファイル読み込み（Promise）
   */
  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('ファイル読み込み失敗'));
      reader.readAsText(file);
    });
  }

  /**
   * ファイルデータ処理
   */
  async handleFileData(content, fileName, filePath = null) {
    try {
      console.log('ファイル解析開始:', fileName);
      this.motionData = this.parseMotionFile(content, fileName);

      // ファイルパスを保存
      this.lastLoadedFilePath = filePath;

      // キャッシュを無効化
      this.invalidateGraphCache();
      this.velocityCacheValid = false;

      // データ中心点を計算
      this.calculateDataCenter();

      // スティックピクチャーの状態をリセット
      this.currentStickType = null;
      this.removeStickPicture();
      // メニューのチェックを外すようメインプロセスに通知
      if (window.electronAPI) {
        window.electronAPI.invoke('reset-stick-picture-menu');
      }

      // グラフのポイント選択状態をリセット
      console.log('[handleFileData] selectedJointsをリセット');
      this.selectedJoints = new Set();
      this.selectedJointAngles = new Set();
      this.selectedSegmentAngles = new Set();
      this.visibleJointAngleArcs = new Set();
      this.visibleSegmentAngleArcs = new Set();
      this.graphMode = 'velocity';
      this.velocityAxis = 'composite';
      this.positionAxis = 'x';
      this.segmentAnglePlane = 'xy';
      this.graphMinValue = null;
      this.graphMaxValue = null;
      // 速度キャッシュを無効化（新しいデータ読み込み時）
      this.velocityCacheValid = false;
      this.velocityCache = null;
      if (this.graphControlsInitialized) {
        this.refreshGraphControls();
      }
      this.toggleInertiaVisualization(false);
      this.requestInertiaMenuUpdate(false);

      this.initializePointNames();
      await this.applyPointNamesFromSet(filePath);
      this.pruneGraphSelections();
      this.initializeTrajectorySettings();
      this.currentFrame = 0;
      this.isPlaying = false;
      this.updateFileInfo(fileName);
      this.updateFrameControls();
      this.updateDataInfo();
      this.updateUIState('file-loaded');
      this.initThreeScene(() => {
        if (this.motionData && this.motionData.frames && this.motionData.frames.length > 0) {
          this.autoAdjustFloorGrid(this.motionData.frames);
        }
        // 同名の設定ファイル（.json）の自動読み込みをチェック
        this.checkAndLoadSettingsFile(fileName, filePath);
      });

      // Launcher への進捗通知（Launcher経由でない起動時はスキップ）
      try {
        if (window.electronAPI && window.electronAPI.invoke) {
          await window.electronAPI.invoke('update-project-status', { step: 'motionViewer', status: 'completed' });
        }
      } catch (e) {
        console.log('進捗更新をスキップ（Launcher連携なし）');
      }
    } catch (error) {
      console.error('ファイル解析エラー:', error);
      alert(`ファイル解析エラー: ${error.message}`);
    } finally {
      this.showLoading(false);
    }
  }

  /**
   * データ全体の中心点を計算する
   */
  calculateDataCenter() {
    if (!this.motionData || !this.motionData.frames || this.motionData.frames.length === 0) {
      this.dataCenter.set(0, 0, 0);
      return;
    }

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    for (const frame of this.motionData.frames) {
      for (const point of frame) {
        // nullポイント（欠損値）をスキップ
        if (!point) continue;
        // プレーンオブジェクトのx, y, zプロパティに直接アクセス
        if (point.x < min.x) min.x = point.x;
        if (point.y < min.y) min.y = point.y;
        if (point.z < min.z) min.z = point.z;
        if (point.x > max.x) max.x = point.x;
        if (point.y > max.y) max.y = point.y;
        if (point.z > max.z) max.z = point.z;
      }
    }

    this.dataCenter.addVectors(min, max).multiplyScalar(0.5);
    console.log('[calculateDataCenter] 計算されたデータ中心点:', this.dataCenter);
  }

  autoAdjustFloorGrid(pointsArray) {
    console.log('[autoAdjustFloorGrid] called');
    if (!this.scene) {
      console.warn('[autoAdjustFloorGrid] scene is null');
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const frame of pointsArray) {
      for (const pt of frame) {
        // nullポイント（欠損値）をスキップ
        if (!pt) continue;
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
    // 少し余裕を持たせる（10%拡張）
    const marginX = (maxX - minX) * 0.1;
    const marginY = (maxY - minY) * 0.1;
    minX -= marginX; maxX += marginX;
    minY -= marginY; maxY += marginY;
    // 1メッシュ=1mで行数・列数を計算
    const gridSize = 1; // 1m
    const cols = Math.ceil((maxX - minX) / gridSize);
    const rows = Math.ceil((maxY - minY) / gridSize);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    console.log('[autoAdjustFloorGrid] x範囲:', minX.toFixed(3), '～', maxX.toFixed(3));
    console.log('[autoAdjustFloorGrid] y範囲:', minY.toFixed(3), '～', maxY.toFixed(3));
    console.log('[autoAdjustFloorGrid] meshSize:', gridSize, '行数:', rows, '列数:', cols);

    this.gridSize = gridSize;
    this.gridRows = rows;
    this.gridCols = cols;

    if (this.gridHelpers) {
      for (const g of this.gridHelpers) this.scene.remove(g);
    }
    this.gridHelpers = [];
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        const grid = new THREE.GridHelper(gridSize, 1, this.gridColor1, this.gridColor2);
        grid.position.set(
          (col - (this.gridCols - 1) / 2) * gridSize + centerX,
          (row - (this.gridRows - 1) / 2) * gridSize + centerY,
          0
        );
        grid.rotation.x = Math.PI / 2;
        this.scene.add(grid);
        this.gridHelpers.push(grid);
      }
    }
    // 背景色が未設定の場合のみ白で初期化
    if (!this.scene.background) {
      this.scene.background = new THREE.Color(0xffffff);
    }
  }

  /**
   * モーションファイル解析
   */
  parseMotionFile(content, fileName) {
    const lines = content.trim().split('\n');

    if (lines.length < 2) {
      throw new Error('ファイル形式が正しくありません');
    }

    // ヘッダー解析
    const headerParts = lines[0].split(',');
    const frameCount = parseInt(headerParts[0]);
    const pointCount = parseInt(headerParts[1]);
    const frameInterval = parseFloat(headerParts[2]);

    if (isNaN(frameCount) || isNaN(pointCount) || isNaN(frameInterval)) {
      throw new Error('ヘッダー形式が無効です');
    }

    // 最初のデータ行から次元を判定
    const firstDataValues = lines[1].split(',').map(s => {
      const trimmed = s.trim();
      const parsed = parseFloat(trimmed);
      // NaNはそのまま保持（欠損値）、有効値は小数点第3位までに丸める
      return isNaN(parsed) ? NaN : Math.round(parsed * 1000) / 1000;
    });
    const dimension = firstDataValues.length / pointCount;

    if (dimension !== 2 && dimension !== 3) {
      throw new Error(`座標の次元を特定できません。1行のデータ数: ${firstDataValues.length}, ポイント数: ${pointCount}`);
    }

    // フレームデータ解析
    const frames = [];
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => {
        const trimmed = v.trim();
        const parsed = parseFloat(trimmed);
        // NaNはそのまま保持（欠損値）、有効値は小数点第3位までに丸める
        return isNaN(parsed) ? NaN : Math.round(parsed * 1000) / 1000;
      });

      // 空行は無視
      if (values.length === 1 && isNaN(values[0])) {
        continue;
      }

      if (values.length !== pointCount * dimension) {
        console.warn(`フレーム${i}のデータ数がヘッダーと一致しません。スキップします。(データ数: ${values.length}, 期待値: ${pointCount * dimension})`);
        continue;
      }

      const points = [];
      for (let j = 0; j < pointCount; j++) {
        const x = values[j * dimension];
        const y = values[j * dimension + 1];
        const z = dimension === 3 ? values[j * dimension + 2] : 0;
        // いずれかの座標がNaNの場合はnull（欠損ポイント）として扱う
        if (isNaN(x) || isNaN(y) || (dimension === 3 && isNaN(z))) {
          points.push(null);
        } else {
          points.push({ x, y, z });
        }
      }
      frames.push(points);
    }

    return {
      header: {
        frameCount: frames.length,
        pointCount,
        frameInterval,
        duration: frames.length * frameInterval,
        fileName,
        dimension
      },
      frames
    };
  }

  /**
   * Three.jsシーン初期化
   */
  initThreeScene(onReady) {
    console.log('initThreeScene called');
    document.body.classList.add('file-loaded');
    document.body.classList.remove('no-file');
    const tryInit = (retry = 0) => {
      const container = this.elements.threeCanvas;
      const w = container.clientWidth;
      const h = container.clientHeight;
      console.log(`[initThreeScene] canvas size:`, w, h, `retry:`, retry);
      if (w === 0 || h === 0) {
        if (retry < 10) {
          setTimeout(() => tryInit(retry + 1), 100);
        } else {
          console.error('threeCanvasサイズが0のままです。レイアウト/CSSを確認してください。');
        }
        return;
      }
      // Three.js初期化処理
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0xffffff);
      this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);

      // データの次元に応じてカメラを調整
      if (this.motionData && this.motionData.header.dimension === 2) {
        // 2次元データの場合：Z軸方向から見下ろす
        this.camera.up.set(0, 1, 0);
        this.camera.position.set(this.dataCenter.x, this.dataCenter.y, this.dataCenter.z + 10);
      } else {
        // 3次元データの場合：従来の設定をデータ中心基準に
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(this.dataCenter.x, this.dataCenter.y - 10, this.dataCenter.z + 10);
      }
      this.camera.lookAt(this.dataCenter);

      this.renderer = new THREE.WebGLRenderer({ canvas: container, antialias: true });
      this.renderer.setPixelRatio(window.devicePixelRatio);
      this.renderer.setSize(container.clientWidth, container.clientHeight, true);
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      // 回転の中心点をデータ中心に設定
      this.controls.target.copy(this.dataCenter);
      this.controls.enableDamping = false;
      this.controls.screenSpacePanning = true;
      this.controls.update();
      // 既存の点群があれば削除
      if (this.points) {
        this.scene.remove(this.points);
        this.points.geometry.dispose();
        this.points.material.dispose();
        this.points = null;
      }
      // 既存の球体があれば削除
      if (this.spheres && this.spheres.length > 0) {
        for (const s of this.spheres) {
          this.scene.remove(s);
          s.geometry.dispose();
          s.material.dispose();
        }
        this.spheres = [];
      }
      // ファイルから読み込んだ点群を球体Meshで描画
      if (this.motionData && this.motionData.frames && this.motionData.frames.length > 0) {
        const frameData = this.motionData.frames[this.currentFrame];
        const pointCount = this.motionData.header.pointCount;
        for (let i = 0; i < pointCount; i++) {
          const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
          // 各球体に個別のジオメトリを生成
          const geometry = new THREE.SphereGeometry(0.04, 16, 16);
          const sphere = new THREE.Mesh(geometry, material);
          // nullチェック（欠損データの場合は非表示で原点に配置）
          if (frameData[i] && this.isValidPoint(frameData[i])) {
            sphere.position.set(frameData[i].x, frameData[i].y, frameData[i].z);
            sphere.visible = true;
          } else {
            sphere.position.set(0, 0, 0);
            sphere.visible = false;
          }
          sphere.userData.pattern = 'sphere'; // パターンを初期設定
          this.scene.add(sphere);
          this.spheres.push(sphere);
        }
        // 簡易ライト
        const light = new THREE.DirectionalLight(0xffffff, 1);
        light.position.set(0, -10, 10);
        this.scene.add(light);
        const ambient = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambient);
      }
      // 座標軸
      // const axesHelper = new THREE.AxesHelper(5);
      // this.scene.add(axesHelper);

      // フォースプレートの初期化
      this.initializeForcePlates();

      // === ここから床面メッシュとグリッドを追加 ===
      const gridSize = 10;
      const gridRows = 10;
      const gridCols = 10;
      const gridColor = 0x888888;
      const gridColor2 = 0xcccccc;
      const gridBgColor = 0xffffff;
      // 背景色
      this.scene.background = new THREE.Color(gridBgColor);
      // グリッド
      this.gridHelpers = [];
      for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
          const grid = new THREE.GridHelper(gridSize, gridRows, gridColor, gridColor2);
          grid.position.set(
            (col - (gridCols - 1) / 2) * gridSize,
            (row - (gridRows - 1) / 2) * gridSize,
            0
          );
          grid.rotation.x = Math.PI / 2;
          this.scene.add(grid);
          this.gridHelpers.push(grid);
        }
      }
      // レンダリングループ
      const animate = () => {
        requestAnimationFrame(animate);
        this.renderer.render(this.scene, this.camera);
      };
      animate();
      // リサイズ対応は setupEventListeners() で一元管理（重複リスナーを削除）
      if (typeof onReady === 'function') onReady();
    };
    tryInit();
  }

  /**
   * フレーム設定
   */
  setCurrentFrame(frameIndex) {
    if (!this.motionData) return;
    const maxFrame = this.motionData.header.frameCount - 1;
    this.currentFrame = Math.max(0, Math.min(frameIndex, maxFrame));
    this.elements.frameSlider.value = this.currentFrame;
    // 経過時間（秒）を表示
    const frameInterval = this.motionData.header.frameInterval;
    const elapsed = frameInterval * this.currentFrame;
    this.elements.frameInput.value = elapsed.toFixed(3);
    this.elements.currentFrame.textContent = this.currentFrame + 1; // 1ベースで表示
    // 球体アニメーション更新
    if (this.spheres && this.motionData.frames && this.motionData.frames.length > this.currentFrame) {
      const frameData = this.motionData.frames[this.currentFrame];
      if (frameData) {
        for (let i = 0; i < this.spheres.length; i++) {
          if (frameData[i] && this.isValidPoint(frameData[i])) {
            this.spheres[i].position.set(frameData[i].x, frameData[i].y, frameData[i].z);
            this.spheres[i].visible = this.pointSettings?.[i]?.visible ?? true;
          } else {
            // 欠損データの場合はポイントを非表示にする
            this.spheres[i].visible = false;
          }
        }
      }
    }
    if (this.currentStickType && this.motionData && this.motionData.frames) {
      const frameData = this.motionData.frames[this.currentFrame];
      if (frameData) {
        this.drawStickPicture(frameData);
      }
    }
    if (this.inertiaVisualizationEnabled && this.motionData && this.motionData.frames) {
      const frameData = this.motionData.frames[this.currentFrame];
      if (frameData) {
        this.updateInertiaVisualization(frameData);
      }
    }

    // 軌跡の更新
    this.updateTrajectories();
    this.updateLineTrajectories();

    // 身体重心の更新
    this.updateBodyCOMDisplay();

    // フォースベクトルの更新
    this.updateForceVectors();

    // 散布図の更新
    if (this.scatterCtx && this.shouldDrawGraph()) {
      this.drawScatterPlot();
    }
  }

  shouldDrawGraph() {
    if (this.graphMode === 'jointAngle') {
      return this.selectedJointAngles && this.selectedJointAngles.size > 0;
    }
    if (this.graphMode === 'segmentAngle') {
      return this.selectedSegmentAngles && this.selectedSegmentAngles.size > 0;
    }
    // 逆動力学系のモードはinverseDynamicsResultsがあればOK
    if (this.graphMode === 'jointTorque' || this.graphMode === 'jointPower' || this.graphMode === 'grf') {
      return !!this.inverseDynamicsResults;
    }
    return this.selectedJoints && this.selectedJoints.size > 0;
  }

  getCurrentFramePoints() {
    if (!this.motionData || !this.motionData.frames || this.motionData.frames.length === 0) return null;
    return this.motionData.frames[this.currentFrame] || null;
  }

  clearJointAngleArcs() {
    if (!this.jointAngleArcObjects) return;
    this.jointAngleArcObjects.forEach(group => {
      if (!group) return;
      group.traverse(obj => {
        if (obj !== group) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) {
              obj.material.forEach(mat => mat.dispose());
            } else {
              obj.material.dispose();
            }
          }
        }
      });
      if (this.scene && group.parent === this.scene) {
        this.scene.remove(group);
      }
    });
    this.jointAngleArcObjects.clear();
  }

  updateJointAngleArcs(points = null) {
    this.clearJointAngleArcs();
    if (!this.scene || !this.currentStickType) return;
    if (!this.visibleJointAngleArcs || this.visibleJointAngleArcs.size === 0) return;
    const framePoints = points || this.getCurrentFramePoints();
    if (!framePoints) return;

    const defs = this.getJointAngleDefinitions().filter(def => this.visibleJointAngleArcs.has(def.id));
    defs.forEach(def => {
      const group = this.createJointAngleArcGroup(def, framePoints);
      if (group) {
        this.scene.add(group);
        this.jointAngleArcObjects.set(def.id, group);
      }
    });
  }

  createJointAngleArcGroup(definition, framePoints) {
    if (!definition || !framePoints) return null;
    const p1 = this.getPointCoordinates(framePoints, definition.distalPoint);
    const p2 = this.getPointCoordinates(framePoints, definition.jointCenter);
    const p3 = this.getPointCoordinates(framePoints, definition.proximalPoint);
    if (!this.isValidPoint(p1) || !this.isValidPoint(p2) || !this.isValidPoint(p3)) return null;

    const dimension = this.motionData ? this.motionData.header.dimension : 3;
    const angleDeg = this.calculateJointAngle(p1, p2, p3, dimension);
    if (angleDeg === null || angleDeg <= 0) return null;
    const angleRad = THREE.MathUtils.degToRad(angleDeg);

    const center = new THREE.Vector3(p2.x, p2.y, p2.z);
    const vecDistal = new THREE.Vector3(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
    const vecProximal = new THREE.Vector3(p3.x - p2.x, p3.y - p2.y, p3.z - p2.z);
    const lenDistal = vecDistal.length();
    const lenProximal = vecProximal.length();
    if (lenDistal === 0 || lenProximal === 0) return null;

    const dirDistal = vecDistal.clone().normalize();
    const dirProximal = vecProximal.clone().normalize();
    const normal = dirProximal.clone().cross(dirDistal).normalize();
    if (!this.isValidNumber(normal.lengthSq()) || normal.lengthSq() < 1e-6) return null;

    const axisX = dirProximal.clone();
    // axisY は dirProximal と垂直で、平面（dirProximal-dirDistal）内にあり、dirDistal 側に展開されるもの
    let axisY = dirDistal.clone().projectOnPlane(axisX).normalize();
    if (axisY.lengthSq() < 1e-6) {
      // ベクトルが平行な場合は扇形を描画できない
      return null;
    }

    const radius = Math.min(lenDistal, lenProximal) * 0.4;
    if (radius <= 0) return null;

    const segments = 48;
    const arcPoints = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const theta = angleRad * t;
      const dir = axisX.clone().multiplyScalar(Math.cos(theta))
        .add(axisY.clone().multiplyScalar(Math.sin(theta)));
      const point = center.clone().add(dir.multiplyScalar(radius));
      arcPoints.push(point);
    }

    if (arcPoints.length < 2) return null;

    const arcGeometry = new THREE.BufferGeometry().setFromPoints(arcPoints);
    const arcMaterial = new THREE.LineBasicMaterial({
      color: 0xff8800,
      linewidth: 2
    });
    const arcLine = new THREE.Line(arcGeometry, arcMaterial);

    const triangleCount = arcPoints.length - 1;
    const positions = new Float32Array(triangleCount * 9);
    for (let i = 0; i < triangleCount; i++) {
      const pA = arcPoints[i];
      const pB = arcPoints[i + 1];
      const offset = i * 9;
      positions[offset] = center.x;
      positions[offset + 1] = center.y;
      positions[offset + 2] = center.z;
      positions[offset + 3] = pA.x;
      positions[offset + 4] = pA.y;
      positions[offset + 5] = pA.z;
      positions[offset + 6] = pB.x;
      positions[offset + 7] = pB.y;
      positions[offset + 8] = pB.z;
    }
    const fillGeometry = new THREE.BufferGeometry();
    fillGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    fillGeometry.computeVertexNormals();
    const fillMaterial = new THREE.MeshBasicMaterial({
      color: 0xff8800,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const fillMesh = new THREE.Mesh(fillGeometry, fillMaterial);

    const group = new THREE.Group();
    group.add(fillMesh);
    group.add(arcLine);
    return group;
  }

  // ========================================
  // セグメント角度弧の可視化
  // ========================================

  clearSegmentAngleArcs() {
    if (!this.segmentAngleArcObjects) return;
    this.segmentAngleArcObjects.forEach(group => {
      if (!group) return;
      group.traverse(obj => {
        if (obj !== group) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) {
              obj.material.forEach(mat => mat.dispose());
            } else {
              obj.material.dispose();
            }
          }
        }
      });
      if (this.scene && group.parent === this.scene) {
        this.scene.remove(group);
      }
    });
    this.segmentAngleArcObjects.clear();
  }

  updateSegmentAngleArcs(points = null) {
    this.clearSegmentAngleArcs();
    if (!this.scene || !this.currentStickType) return;
    if (!this.visibleSegmentAngleArcs || this.visibleSegmentAngleArcs.size === 0) return;
    const framePoints = points || this.getCurrentFramePoints();
    if (!framePoints) return;

    const defs = this.getSegmentAngleDefinitions().filter(def => this.visibleSegmentAngleArcs.has(def.id));
    const dimension = this.motionData?.header?.dimension || 3;

    // LCSモードの場合は骨盤LCSを事前計算
    const referenceFrame = this.segmentReferenceFrame || 'global';
    let lcs = null;
    if (referenceFrame === 'pelvis' && dimension === 3) {
      lcs = this.computePelvisLCS(framePoints);
    }

    defs.forEach(def => {
      const group = this.createSegmentAngleArcGroup(def, framePoints, dimension, referenceFrame, lcs);
      if (group) {
        this.scene.add(group);
        this.segmentAngleArcObjects.set(def.id, group);
      }
    });
  }

  /**
   * セグメント角度の弧を作成
   * 水平面からセグメント方向への仰角を可視化
   * 正の角度 = 水平より上向き、負の角度 = 水平より下向き
   * @param {number} dimension - 2 (2D) or 3 (3D)
   * @param {string} referenceFrame - 'global' (GCS) or 'pelvis' (LCS)
   * @param {Object|null} lcs - 骨盤LCS（referenceFrame === 'pelvis'の場合）
   */
  createSegmentAngleArcGroup(definition, framePoints, dimension = 3, referenceFrame = 'global', lcs = null) {
    if (!definition || !framePoints) return null;

    const distal = this.getPointCoordinates(framePoints, definition.distalPoint);
    const proximal = this.getPointCoordinates(framePoints, definition.proximalPoint);
    if (!this.isValidPoint(distal) || !this.isValidPoint(proximal)) return null;

    // セグメントベクトル（proximal → distal）
    const segmentVec = new THREE.Vector3(
      distal.x - proximal.x,
      distal.y - proximal.y,
      distal.z - proximal.z
    );
    const segmentLen = segmentVec.length();
    if (segmentLen === 0) return null;
    const segmentDir = segmentVec.clone().normalize();

    // 弧の中心点（proximal位置）
    const center = new THREE.Vector3(proximal.x, proximal.y, proximal.z);
    const radius = segmentLen * 0.3;

    let refDir, vertDir, angleDeg;
    const useLCS = (referenceFrame === 'pelvis' && lcs && dimension === 3);

    if (dimension === 2) {
      // 2D: XY平面でXが水平、Yが垂直
      refDir = new THREE.Vector3(1, 0, 0);
      vertDir = new THREE.Vector3(0, 1, 0);
      angleDeg = Math.atan2(segmentDir.y, segmentDir.x) * (180 / Math.PI);
    } else if (useLCS) {
      // LCS 3D: 骨盤座標系の水平面からの仰角
      const lcsUp = new THREE.Vector3(lcs.up.x, lcs.up.y, lcs.up.z);
      const lcsRight = new THREE.Vector3(lcs.right.x, lcs.right.y, lcs.right.z);
      const lcsForward = new THREE.Vector3(lcs.forward.x, lcs.forward.y, lcs.forward.z);

      // セグメントのLCS成分
      const segUp = segmentDir.dot(lcsUp);
      const segRight = segmentDir.dot(lcsRight);
      const segForward = segmentDir.dot(lcsForward);
      const horizontal = Math.sqrt(segRight * segRight + segForward * segForward);
      angleDeg = Math.atan2(segUp, horizontal) * (180 / Math.PI);

      // アーク描画平面: セグメントと上方向を含む平面
      // 水平方向 = セグメントのXY投影を正規化
      if (horizontal > 0.001) {
        refDir = lcsRight.clone().multiplyScalar(segRight / horizontal)
          .add(lcsForward.clone().multiplyScalar(segForward / horizontal));
      } else {
        refDir = lcsForward.clone();
      }
      vertDir = lcsUp.clone();
    } else {
      // GCS 3D: グローバル水平面（XY）からの仰角
      const horizontal = Math.sqrt(segmentDir.x * segmentDir.x + segmentDir.y * segmentDir.y);
      angleDeg = Math.atan2(segmentDir.z, horizontal) * (180 / Math.PI);

      // アーク描画平面: セグメントとZ軸を含む平面
      // 水平方向 = セグメントのXY投影を正規化
      if (horizontal > 0.001) {
        refDir = new THREE.Vector3(segmentDir.x / horizontal, segmentDir.y / horizontal, 0);
      } else {
        refDir = new THREE.Vector3(1, 0, 0);
      }
      vertDir = new THREE.Vector3(0, 0, 1);
    }

    const angleRad = angleDeg * (Math.PI / 180);
    if (Math.abs(angleRad) < 0.01) return null;  // 角度が小さすぎる場合はスキップ

    // 弧の描画（水平から始まり、セグメント方向まで）
    const segments = 32;
    const arcPoints = [];

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const theta = angleRad * t;

      // 水平方向成分と垂直方向成分からアーク上の点を計算
      const hComp = radius * Math.cos(theta);
      const vComp = radius * Math.sin(theta);
      const point = center.clone()
        .add(refDir.clone().multiplyScalar(hComp))
        .add(vertDir.clone().multiplyScalar(vComp));
      arcPoints.push(point);
    }

    if (arcPoints.length < 2) return null;

    // 弧の線
    const arcGeometry = new THREE.BufferGeometry().setFromPoints(arcPoints);
    const arcMaterial = new THREE.LineBasicMaterial({
      color: 0x00ccff,  // シアン色（関節角度のオレンジと区別）
      linewidth: 2
    });
    const arcLine = new THREE.Line(arcGeometry, arcMaterial);

    // 塗りつぶし（扇形）
    const triangleCount = arcPoints.length - 1;
    const positions = new Float32Array(triangleCount * 9);
    for (let i = 0; i < triangleCount; i++) {
      const pA = arcPoints[i];
      const pB = arcPoints[i + 1];
      const offset = i * 9;
      positions[offset] = center.x;
      positions[offset + 1] = center.y;
      positions[offset + 2] = center.z;
      positions[offset + 3] = pA.x;
      positions[offset + 4] = pA.y;
      positions[offset + 5] = pA.z;
      positions[offset + 6] = pB.x;
      positions[offset + 7] = pB.y;
      positions[offset + 8] = pB.z;
    }
    const fillGeometry = new THREE.BufferGeometry();
    fillGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    fillGeometry.computeVertexNormals();
    const fillMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ccff,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const fillMesh = new THREE.Mesh(fillGeometry, fillMaterial);

    // 基準線（水平方向）を描画
    const refLineEnd = center.clone().add(refDir.clone().multiplyScalar(radius));
    const refLineGeometry = new THREE.BufferGeometry().setFromPoints([center, refLineEnd]);
    const refLineMaterial = new THREE.LineDashedMaterial({
      color: 0x888888,
      linewidth: 1,
      dashSize: 0.02,
      gapSize: 0.01
    });
    const refLine = new THREE.Line(refLineGeometry, refLineMaterial);
    refLine.computeLineDistances();

    const group = new THREE.Group();
    group.add(fillMesh);
    group.add(arcLine);
    group.add(refLine);
    return group;
  }

  toggleInertiaVisualization(enabled) {
    if (!enabled) {
      this.inertiaVisualizationEnabled = false;
      this.clearInertiaMeshes();
      this.requestInertiaMenuUpdate(false);
      return;
    }
    if (!this.motionData || !this.scene) {
      this.inertiaVisualizationEnabled = false;
      alert('モーションデータを読み込んでから利用してください。');
      this.requestInertiaMenuUpdate(false);
      return;
    }
    this.inertiaVisualizationEnabled = true;
    this.updateInertiaVisualization();
    this.requestInertiaMenuUpdate(true);
  }

  clearInertiaMeshes() {
    if (!this.inertiaMeshesById) return;
    this.inertiaMeshesById.forEach(group => {
      if (this.scene && group.parent === this.scene) {
        this.scene.remove(group);
      }
      if (group.userData && group.userData.materials) {
        group.userData.materials.forEach(mat => {
          if (mat && typeof mat.dispose === 'function') {
            mat.dispose();
          }
        });
      }
    });
    this.inertiaMeshesById.clear();
  }

  updateInertiaVisualization(framePoints = null) {
    if (!this.inertiaVisualizationEnabled || !this.scene || !this.motionData) return;
    const points = framePoints || this.getCurrentFramePoints();
    if (!points) return;

    const defs = this.getInertiaSegmentDefinitions();
    const activeIds = new Set();

    defs.forEach(def => {
      const transform = this.computeInertiaSegmentTransform(def, points);
      if (!transform) return;
      let group = this.inertiaMeshesById.get(def.id);
      if (!group) {
        group = this.createInertiaSegmentGroup(def);
        if (!group) return;
        this.scene.add(group);
        this.inertiaMeshesById.set(def.id, group);
      }
      this.applyInertiaTransform(group, transform);
      group.visible = true;
      activeIds.add(def.id);
    });

    this.inertiaMeshesById.forEach((group, id) => {
      if (!activeIds.has(id)) {
        group.visible = false;
      }
    });
  }

  createInertiaSegmentGroup(def) {
    const ellipsoidMaterial = new THREE.MeshStandardMaterial({
      color: def.color,
      transparent: true,
      opacity: 0.35,
      roughness: 0.6,
      metalness: 0.2,
      depthWrite: false
    });
    const cogMaterial = new THREE.MeshBasicMaterial({
      color: def.color
    });
    const ellipsoid = new THREE.Mesh(this.inertiaBaseGeometry, ellipsoidMaterial);
    const cog = new THREE.Mesh(this.inertiaCogGeometry, cogMaterial);
    const group = new THREE.Group();
    group.add(ellipsoid);
    group.add(cog);
    group.userData = {
      ellipsoid,
      cog,
      materials: [ellipsoidMaterial, cogMaterial],
      definition: def
    };
    return group;
  }

  computeInertiaSegmentTransform(definition, framePoints) {
    const proximal = this.getPointCoordinates(framePoints, definition.proximalRef);
    const distal = this.getPointCoordinates(framePoints, definition.distalRef);
    if (!this.isValidPoint(proximal) || !this.isValidPoint(distal)) return null;

    const proximalVec = new THREE.Vector3(proximal.x, proximal.y, proximal.z);
    const distalVec = new THREE.Vector3(distal.x, distal.y, distal.z);
    const axis = distalVec.clone().sub(proximalVec);
    const length = axis.length();
    if (!this.isValidNumber(length) || length < 1e-4) return null;

    const axisDir = axis.clone().normalize();
    const center = proximalVec.clone().lerp(distalVec, definition.comRatio);
    const longRadius = length * definition.longScale;
    const shortRadius = length * definition.shortScale;

    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axisDir);

    return {
      center,
      quaternion,
      longRadius,
      shortRadius
    };
  }

  applyInertiaTransform(group, transform) {
    if (!group || !group.userData) return;
    const { ellipsoid, cog } = group.userData;
    if (ellipsoid) {
      ellipsoid.position.copy(transform.center);
      ellipsoid.quaternion.copy(transform.quaternion);
      ellipsoid.scale.set(transform.shortRadius, transform.shortRadius, transform.longRadius);
    }
    if (cog) {
      cog.position.copy(transform.center);
    }
  }

  getInertiaSegmentDefinitions() {
    if (!this.motionData) return [];
    const hipCenter = this.VIRTUAL_POINTS.HIP_CENTER;
    return [
      { id: 'rightUpperArm', proximalRef: 3, distalRef: 2, comRatio: 0.436, longScale: 0.5, shortScale: 0.18, color: 0x4caf50 },
      { id: 'rightForearm', proximalRef: 2, distalRef: 1, comRatio: 0.430, longScale: 0.45, shortScale: 0.15, color: 0x81c784 },
      { id: 'rightThigh', proximalRef: 13, distalRef: 12, comRatio: 0.433, longScale: 0.55, shortScale: 0.22, color: 0x1e88e5 },
      { id: 'rightShank', proximalRef: 12, distalRef: 11, comRatio: 0.433, longScale: 0.5, shortScale: 0.18, color: 0x64b5f6 },
      { id: 'rightFoot', proximalRef: 11, distalRef: 8, comRatio: 0.50, longScale: 0.35, shortScale: 0.14, color: 0x90caf9 },
      { id: 'leftUpperArm', proximalRef: 7, distalRef: 6, comRatio: 0.436, longScale: 0.5, shortScale: 0.18, color: 0xff7043 },
      { id: 'leftForearm', proximalRef: 6, distalRef: 5, comRatio: 0.430, longScale: 0.45, shortScale: 0.15, color: 0xffab91 },
      { id: 'leftThigh', proximalRef: 19, distalRef: 18, comRatio: 0.433, longScale: 0.55, shortScale: 0.22, color: 0xf06292 },
      { id: 'leftShank', proximalRef: 18, distalRef: 17, comRatio: 0.433, longScale: 0.5, shortScale: 0.18, color: 0xf8bbd0 },
      { id: 'leftFoot', proximalRef: 17, distalRef: 14, comRatio: 0.50, longScale: 0.35, shortScale: 0.14, color: 0xf48fb1 },
      { id: 'trunk', proximalRef: 22, distalRef: hipCenter, comRatio: 0.50, longScale: 0.6, shortScale: 0.3, color: 0x795548 },
      { id: 'headNeck', proximalRef: 21, distalRef: 20, comRatio: 0.50, longScale: 0.35, shortScale: 0.2, color: 0x9c27b0 }
    ];
  }

  requestInertiaMenuUpdate(checked) {
    if (window.electronAPI && window.electronAPI.invoke) {
      window.electronAPI.invoke('set-inertia-visualization-menu', !!checked);
    }
  }

  /**
   * アニメーション再生切り替え
   */
  toggleAnimation() {
    if (!this.motionData) return;

    this.isPlaying = !this.isPlaying;

    if (this.isPlaying) {
      this.startAnimation();
      // 一時停止アイコンに変更
      this.elements.playBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="6" y="4" width="4" height="16" fill="currentColor"/>
          <rect x="14" y="4" width="4" height="16" fill="currentColor"/>
        </svg>`;
      this.elements.playBtn.classList.add('playing');
    } else {
      this.stopAnimation();
      // 再生アイコンに変更
      this.elements.playBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="6,4 20,12 6,20" fill="currentColor"/>
        </svg>`;
      this.elements.playBtn.classList.remove('playing');
    }
  }

  /**
   * アニメーション開始
   */
  startAnimation() {
    if (!this.motionData || this.animationId) return;
    const frameInterval = this.motionData.header.frameInterval;
    const fps = frameInterval > 0 ? 1 / frameInterval : 0;
    this.startTime = performance.now();
    this.baseFrame = this.currentFrame;
    const animate = () => {
      if (!this.isPlaying) return;
      const now = performance.now();
      const elapsedSec = (now - this.startTime) / 1000;
      const speed = this.animationSpeed;
      const frameCount = this.motionData.header.frameCount;
      const targetFrame = Math.floor(this.baseFrame + elapsedSec * fps * speed) % frameCount;
      this.setCurrentFrame(targetFrame);
      this.animationId = requestAnimationFrame(animate);
    };
    animate();
  }

  /**
   * アニメーション停止
   */
  stopAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * 停止（先頭フレームに戻る）
   */
  resetToFirstFrame() {
    this.stopAnimation();
    this.isPlaying = false;
    this.setCurrentFrame(0);
    // 再生アイコンに戻す
    this.elements.playBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="6,4 20,12 6,20" fill="currentColor"/>
      </svg>`;
    this.elements.playBtn.classList.remove('playing');
  }

  /**
   * 速度設定
   */
  setAnimationSpeed(speed) {
    this.animationSpeed = speed;
    this.elements.speedValue.textContent = `${speed.toFixed(1)}x`;

    if (this.isPlaying) {
      this.stopAnimation();
      this.startAnimation();
    }
  }

  /**
   * キーボード処理
   */
  handleKeyboard(e) {
    if (!this.motionData) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.toggleAnimation();
        break;
      case 'Home':
        e.preventDefault();
        this.resetToFirstFrame();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.setCurrentFrame(this.currentFrame - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.setCurrentFrame(this.currentFrame + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        const newSpeedUp = Math.min(5.0, this.animationSpeed + 0.1);
        this.setAnimationSpeed(newSpeedUp);
        break;
      case 'ArrowDown':
        e.preventDefault();
        const newSpeedDown = Math.max(0.1, this.animationSpeed - 0.1);
        this.setAnimationSpeed(newSpeedDown);
        break;
    }
  }

  /**
   * ウィンドウリサイズ
   */
  onWindowResize() {
    if (!this.camera || !this.renderer) return;

    const container = this.elements.threeCanvas;
    if (!container) return;

    // 親コンテナ（viewerContainer）のサイズを取得
    const viewerContainer = document.querySelector('.viewer-container');
    if (viewerContainer) {
      // viewerContainerの実際のサイズを取得
      const rect = viewerContainer.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);

      if (width > 0 && height > 0) {
        // カメラのアスペクト比を更新
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        // レンダラーのサイズを更新（CSSも自動更新）
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height, true);
      }
    }

    // グラフのキャンバスサイズも更新する
    const graphContainer = document.getElementById('graphContainer');
    if (graphContainer && graphContainer.style.display !== 'none') {
      const canvasContainer = document.querySelector('.canvas-container');
      const scatterCanvas = document.getElementById('scatterCanvas');

      if (canvasContainer && scatterCanvas) {
        // Flexboxによって決定されたコンテナの実際の表示サイズを取得
        // clientWidth/clientHeight はパディングを除いた内寸
        const graphWidth = Math.floor(canvasContainer.clientWidth);
        const graphHeight = Math.floor(canvasContainer.clientHeight);

        if (graphWidth > 0 && graphHeight > 0) {
          // Canvasの内部解像度を表示サイズと一致させる
          scatterCanvas.width = graphWidth;
          scatterCanvas.height = graphHeight;

          // キャンバスサイズが変わったので再描画
          if (this.motionData) {
            requestAnimationFrame(() => {
              this.drawScatterPlot();
            });
          }
        }
      }
    }
  }

  /**
   * カメラビュー設定
   */
  setCameraView(viewType) {
    if (!this.camera) return;

    console.log(`[app.js] setCameraView実行: ${viewType}`);
    const distance = 10; // カメラの距離

    switch (viewType) {
      case 'xy':
        // x-y平面（上から見下ろす）
        this.camera.position.set(this.dataCenter.x, this.dataCenter.y, this.dataCenter.z + distance);
        this.camera.up.set(0, 1, 0);
        break;
      case 'yz':
        // y-z平面（x軸方向から見る）
        this.camera.position.set(this.dataCenter.x + distance, this.dataCenter.y, this.dataCenter.z);
        this.camera.up.set(0, 0, 1);
        break;
      case 'xz':
        // x-z平面（y軸方向から見る）
        this.camera.position.set(this.dataCenter.x, this.dataCenter.y - distance, this.dataCenter.z);
        this.camera.up.set(0, 0, 1);
        break;
      default:
        console.warn('未知のビュータイプ:', viewType);
        return;
    }

    this.camera.lookAt(this.dataCenter);
    this.controls.target.copy(this.dataCenter);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    console.log(`カメラビューを${viewType}平面に設定しました`);
  }

  /**
   * UI更新メソッド群
   */
  updateFileInfo(fileName) {
    this.elements.fileName.textContent = fileName;
    const details = [
      `${this.motionData.header.frameCount} フレーム`,
      `${this.motionData.header.pointCount} ポイント`,
      `${this.motionData.header.duration.toFixed(3)}秒`
    ];
    this.elements.fileDetails.textContent = details.join(' | ');
  }

  updateFrameControls() {
    if (!this.motionData) return;

    const maxFrame = this.motionData.header.frameCount - 1;

    this.elements.frameSlider.max = maxFrame;
    this.elements.totalFrames.textContent = this.motionData.header.frameCount; // 1ベースで表示
    this.setCurrentFrame(0);
  }

  updateDataInfo() {
    if (!this.motionData) return;
    this.elements.pointCount.textContent = this.motionData.header.pointCount;
    // FPS表示
    const frameInterval = this.motionData.header.frameInterval;
    const fps = frameInterval > 0 ? Math.round(1 / frameInterval) : 0;
    this.elements.frameInterval.textContent = `FPS: ${fps}`;
  }

  updateUIState(state) {
    document.body.className = state;

    if (state === 'no-file') {
      this.elements.dropZone.style.display = 'flex';
      this.elements.viewerContainer.style.display = 'none';
      this.updateToolbarState(false);
    } else if (state === 'file-loaded') {
      this.elements.dropZone.style.display = 'none';
      this.elements.viewerContainer.style.display = 'block';
      this.updateToolbarState(true);
    }
  }

  updateToolbarState(enabled) {
    const buttons = [
      'btnSaveProject', 'btnPointSettings', 'btnLineSettings', 'btnSegmentDef',
      'btnFloorSettings', 'btnFilter', 'btnBodyCOM', 'btnSequenceDraw',
      'btnGraph', 'btnViewXY', 'btnViewYZ', 'btnViewXZ', 'btnExportImage', 'btnExportVideo'
    ];
    buttons.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !enabled;
    });
  }

  showLoading(show) {
    this.elements.loadingIndicator.style.display = show ? 'flex' : 'none';
  }

  // スティックピクチャー描画メソッド
  /**
   * 値が有効な数値かどうかをチェックするヘルパー関数
   */
  isValidNumber(value) {
    return typeof value === 'number' && !isNaN(value) && isFinite(value);
  }

  /**
   * ポイントが有効な座標値を持っているかチェックする
   */
  isValidPoint(point) {
    return point &&
      this.isValidNumber(point.x) &&
      this.isValidNumber(point.y) &&
      this.isValidNumber(point.z);
  }

  drawStickPicture(points) {
    // 既存のラインを全て削除
    if (this.skeletonLines) {
      this.skeletonLines.forEach(line => {
        // メッシュの場合はジオメトリとマテリアルも破棄
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
        this.scene.remove(line);
      });
      this.skeletonLines = [];
    }

    // ポイントデータがない場合は何もしない
    if (!points) {
      this.clearJointAngleArcs();
      this.clearSegmentAngleArcs();
      return;
    }

    if (!this.currentStickType) {
      this.clearJointAngleArcs();
      this.clearSegmentAngleArcs();
      return;
    }

    // lineSettingsに基づいて線を再描画
    this.lineSettings.forEach(setting => {
      if (setting.visible && setting.width > 0) {
        const p1Index = this.currentPointNames.indexOf(setting.name1);
        const p2Index = this.currentPointNames.indexOf(setting.name2);

        if (p1Index > -1 && p2Index > -1 && points[p1Index] && points[p2Index]) {
          const p1 = points[p1Index];
          const p2 = points[p2Index];

          // ポイントの有効性をチェック
          if (!this.isValidPoint(p1) || !this.isValidPoint(p2)) {
            console.warn(`無効なポイントデータをスキップ: ${setting.name1} または ${setting.name2}`);
            return;
          }

          const startVec = new THREE.Vector3(p1.x, p1.y, p1.z);
          const endVec = new THREE.Vector3(p2.x, p2.y, p2.z);

          let lineObject;

          if (setting.style === 'dashed' || setting.style === 'dotted') {
            // 破線・点線の場合はLineDashedMaterialを使用
            const geometry = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
            const material = new THREE.LineDashedMaterial({
              color: setting.color,
              linewidth: setting.width,
              scale: 1,
              dashSize: setting.style === 'dashed' ? 0.1 : 0.02,
              gapSize: setting.style === 'dashed' ? 0.05 : 0.02
            });
            lineObject = new THREE.Line(geometry, material);
            lineObject.computeLineDistances();
          } else {
            // 実線の場合はTubeGeometryを使用
            const curve = new THREE.LineCurve3(startVec, endVec);

            // UIの「太さ」をチューブの半径に変換 (スケールは調整が必要な場合があります)
            const thickness = setting.width / 1000.0;

            const tubeGeometry = new THREE.TubeGeometry(curve, 1, thickness, 8, false);
            const material = new THREE.MeshStandardMaterial({
              color: setting.color,
              roughness: 0.8,
              metalness: 0.2
            });
            lineObject = new THREE.Mesh(tubeGeometry, material);
          }

          this.scene.add(lineObject);
          this.skeletonLines.push(lineObject);
        }
      }
    });

    this.updateJointAngleArcs(points);
    this.updateSegmentAngleArcs(points);
  }

  // スティックピクチャー削除メソッド
  removeStickPicture() {
    if (this.skeletonLines) {
      this.skeletonLines.forEach(line => {
        // メッシュの場合はジオメトリとマテリアルも破棄
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
        this.scene.remove(line);
      });
      this.skeletonLines = [];
    }
    this.stickLines = null; // 互換性のために残す
    this.clearJointAngleArcs();
    this.clearSegmentAngleArcs();
  }

  // 図形描写ウィンドウを直接開くメソッド（ダイアログをスキップ）
  async showSequenceDrawDialog() {
    console.log('[DEBUG] showSequenceDrawDialog called');

    const totalFrames = this.motionData ? this.motionData.frames.length : 0;
    console.log('[DEBUG] totalFrames:', totalFrames);

    // デフォルト設定を適用してすぐにウィンドウを開く
    this.sequenceDrawing.startFrame = 1;
    this.sequenceDrawing.endFrame = totalFrames;
    this.sequenceDrawing.interval = 10;
    this.sequenceDrawing.enabled = true;

    // 別ウィンドウで図形描写を表示
    await this.openSequenceDrawWindow();
  }

  // 連続写真を描画するメソッド
  drawSequenceStickPicture() {
    // 既存の連続写真をクリア
    this.clearSequenceStickPicture();

    if (!this.motionData || !this.currentStickType) return;

    const { startFrame, endFrame, interval, opacityMode, baseOpacity, colorMode, startColor, endColor } = this.sequenceDrawing;

    // フレーム範囲を調整（1始まりのフレーム番号を0始まりの配列インデックスに変換）
    const startIdx = Math.max(0, startFrame - 1);
    const endIdx = Math.min(this.motionData.frames.length - 1, endFrame - 1);

    // 描画するフレームのリストを作成
    const framesToDraw = [];
    for (let i = startIdx; i <= endIdx; i += interval) {
      framesToDraw.push(i);
    }

    const totalDrawFrames = framesToDraw.length;

    // 各フレームを描画
    framesToDraw.forEach((frameIdx, drawIdx) => {
      const points = this.motionData.frames[frameIdx];

      // 透明度を計算
      let opacity;
      if (opacityMode === 'gradient') {
        // 古いフレームほど透明に
        opacity = baseOpacity * (drawIdx + 1) / totalDrawFrames;
      } else {
        opacity = baseOpacity;
      }

      // 色を計算
      let lineColor;
      if (colorMode === 'gradient') {
        // 開始色から終了色へグラデーション
        const startRGB = this.hexToRgb(startColor);
        const endRGB = this.hexToRgb(endColor);
        const ratio = drawIdx / (totalDrawFrames - 1 || 1);
        lineColor = new THREE.Color(
          (startRGB.r + (endRGB.r - startRGB.r) * ratio) / 255,
          (startRGB.g + (endRGB.g - startRGB.g) * ratio) / 255,
          (startRGB.b + (endRGB.b - startRGB.b) * ratio) / 255
        );
      } else {
        lineColor = new THREE.Color(this.currentLineColor);
      }

      // このフレーム用の骨格群を作成
      const frameSkeleton = [];

      // lineSettingsに基づいて線を描画
      this.lineSettings.forEach(setting => {
        if (setting.visible && setting.width > 0) {
          const p1Index = this.currentPointNames.indexOf(setting.name1);
          const p2Index = this.currentPointNames.indexOf(setting.name2);

          if (p1Index > -1 && p2Index > -1 && points[p1Index] && points[p2Index]) {
            const p1 = points[p1Index];
            const p2 = points[p2Index];

            if (!this.isValidPoint(p1) || !this.isValidPoint(p2)) {
              return;
            }

            const startVec = new THREE.Vector3(p1.x, p1.y, p1.z);
            const endVec = new THREE.Vector3(p2.x, p2.y, p2.z);

            let lineObject;

            if (setting.style === 'dashed' || setting.style === 'dotted') {
              const geometry = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
              const material = new THREE.LineDashedMaterial({
                color: lineColor,
                linewidth: setting.width,
                scale: 1,
                dashSize: setting.style === 'dashed' ? 0.1 : 0.02,
                gapSize: setting.style === 'dashed' ? 0.05 : 0.02,
                transparent: true,
                opacity: opacity
              });
              lineObject = new THREE.Line(geometry, material);
              lineObject.computeLineDistances();
            } else {
              const curve = new THREE.LineCurve3(startVec, endVec);
              const thickness = setting.width / 1000.0;
              const tubeGeometry = new THREE.TubeGeometry(curve, 1, thickness, 8, false);
              const material = new THREE.MeshStandardMaterial({
                color: lineColor,
                roughness: 0.8,
                metalness: 0.2,
                transparent: true,
                opacity: opacity
              });
              lineObject = new THREE.Mesh(tubeGeometry, material);
            }

            this.scene.add(lineObject);
            frameSkeleton.push(lineObject);
          }
        }
      });

      // このフレームの骨格群を保存
      this.sequenceSkeletons.push(frameSkeleton);
    });
  }

  // 連続写真をクリアするメソッド
  clearSequenceStickPicture() {
    this.sequenceSkeletons.forEach(frameSkeleton => {
      frameSkeleton.forEach(line => {
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
        this.scene.remove(line);
      });
    });
    this.sequenceSkeletons = [];
    this.sequenceDrawing.enabled = false;
  }

  // 別ウィンドウで図形描写を開く
  async openSequenceDrawWindow() {
    console.log('[DEBUG] openSequenceDrawWindow called');

    if (!this.motionData) {
      console.log('[DEBUG] motionData missing');
      return;
    }

    try {
      console.log('[DEBUG] preparing data');

      // ファイル名から拡張子を除いたベース名を取得
      const fileName = this.motionData.header.fileName || 'sequence-draw';
      const baseName = fileName.replace(/\.[^/.]+$/, '');

      // ポイント設定を収集
      const pointSettings = this.spheres ? this.spheres.map((sphere, i) => {
        const geoParams = sphere.geometry.parameters;
        const pattern = sphere.userData.pattern || 'sphere';
        let size;
        if (pattern === 'sphere') {
          size = (geoParams.radius || 0) * 100;
        } else if (pattern === 'cone') {
          size = (geoParams.radius || 0) * 100;
        } else {
          size = (geoParams.width || 0) * 100;
        }
        return {
          name: this.currentPointNames[i] || `ポイント${i + 1}`,
          color: '#' + sphere.material.color.getHexString(),
          size: size,
          pattern: pattern,
          visible: sphere.visible
        };
      }) : [];

      // 別ウィンドウに渡すデータを準備
      const data = {
        frames: this.motionData.frames,
        lineSettings: this.lineSettings,
        pointNames: this.currentPointNames,
        pointSettings: pointSettings,  // ポイント設定を追加
        sequenceSettings: this.sequenceDrawing,
        fileName: baseName,  // ファイル名を追加
        filePath: this.lastLoadedFilePath  // ファイルパスを追加
      };

      console.log('[DEBUG] calling invoke open-sequence-draw-window');
      // 別ウィンドウを開く
      const result = await window.electronAPI.invoke('open-sequence-draw-window', data);
      console.log('[DEBUG] invoke result:', result);
    } catch (error) {
      console.error('[ERROR] openSequenceDrawWindow error:', error);
      alert('図形描写ウィンドウの表示に失敗しました: ' + error.message);
    }
  }

  // 色変換ヘルパーメソッド
  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  }

  // ライン設定を初期化するメソッド
  initializeLineSettings(type) {
    this.lineSettings = [];
    const skeleton = (type === 25) ? this.skeleton25 : this.skeleton23;
    const names = this.currentPointNames;

    // セグメントタイプの自動検出マッピング（23/25点モデル用）
    // [p1_index, p2_index] => segmentType
    const segmentTypeMap = type === 25 ? {
      // 25点モデル: 右脚
      '12_13': 'rightThigh',  // 右股関節→右膝
      '13_14': 'rightShank',  // 右膝→右足首
      '14_15': 'rightFoot',   // 右足首→右つま先
      '14_16': 'rightHeel',   // 右足首→右踵
      // 25点モデル: 左脚
      '17_18': 'leftThigh',   // 左股関節→左膝
      '18_19': 'leftShank',   // 左膝→左足首
      '19_20': 'leftFoot',    // 左足首→左つま先
      '19_21': 'leftHeel'     // 左足首→左踵
    } : {
      // 23点モデル: 右脚
      '12_13': 'rightThigh',
      '13_14': 'rightShank',
      '14_15': 'rightFoot',
      '14_16': 'rightHeel',   // 右足首→右踵
      // 23点モデル: 左脚
      '17_18': 'leftThigh',
      '18_19': 'leftShank',
      '19_20': 'leftFoot',
      '19_21': 'leftHeel'     // 左足首→左踵
    };

    skeleton.forEach(chain => {
      for (let i = 0; i < chain.length - 1; i++) {
        const p1_index = chain[i];
        const p2_index = chain[i + 1];
        const name1 = names[p1_index];
        const name2 = names[p2_index];

        if (name1 && name2) {
          // セグメントタイプを検出
          const key = `${p1_index}_${p2_index}`;
          const segmentType = segmentTypeMap[key] || 'none';

          this.lineSettings.push({
            name1: name1,
            name2: name2,
            color: this.currentLineColor, // デフォルト色
            width: this.currentLineWidth, // デフォルト太さ
            style: 'solid', // デフォルトスタイル: 'solid', 'dashed', 'dotted'
            visible: true,
            trajectoryVisible: false, // 軌跡表示
            trajectoryOpacity: 0.7,    // 軌跡透過性
            trajectoryLength: 50,      // 軌跡長さ
            segmentType: segmentType   // セグメントタイプ（逆動力学用）
          });
        }
      }
    });
  }

  // ポイント設定ダイアログ表示・反映
  showPointSettingsDialog() {
    console.log('app.js: showPointSettingsDialog呼び出し');
    const dialog = document.getElementById('pointSettingsDialog');
    const list = document.getElementById('pointSettingsList');

    // 色選択のオプションHTMLを生成
    const colorOptionsHTML = Object.keys(this.colorOptions).map(name =>
      `<option value="${name}" ${name === '黒' ? 'selected' : ''}>${name}</option>`
    ).join('');

    // 一括設定欄（モダンデザイン）
    let bulkHTML = `
      <div class="settings-bulk-area">
        <div class="bulk-group bulk-select-all">
          <input type="checkbox" id="pointSelectAll">
          <label>全選択</label>
        </div>
        <div class="bulk-group">
          <label>色</label>
          <select id="bulkPointColor">${colorOptionsHTML}</select>
          <span id="bulkPointColorMap" class="color-preview" style="background-color: #000000;"></span>
        </div>
        <div class="bulk-group">
          <label>サイズ</label>
          <input type="text" id="bulkPointSize" inputmode="numeric" pattern="[0-9]*" value="4" class="size-input">
        </div>
        <div class="bulk-group">
          <label>形状</label>
          <select id="bulkPointPattern">
            <option value="sphere">球体</option>
            <option value="box">四角</option>
            <option value="cone">コーン</option>
          </select>
        </div>
        <div class="bulk-group">
          <input type="checkbox" id="bulkTrajectoryVisible">
          <label>軌跡表示</label>
        </div>
        <div class="bulk-group">
          <label>透過性</label>
          <input type="range" id="bulkTrajectoryOpacity" min="0" max="1" step="0.1" value="0.7">
        </div>
        <div class="bulk-group">
          <label>軌跡長さ</label>
          <input type="text" id="bulkTrajectoryLength" inputmode="numeric" pattern="[0-9]*" value="50" class="size-input">
        </div>
        <button id="applyBulkPointSettings" class="apply-btn">一括適用</button>
      </div>
    `;
    // テーブルHTMLを生成（モダンデザイン）
    let tableHTML = `
      <div class="settings-table-container">
      <table class="settings-table">
        <thead>
          <tr>
            <th style="width: 40px;"></th>
            <th style="width: 50px;">No.</th>
            <th style="width: 140px;">名称</th>
            <th style="width: 150px;">色</th>
            <th style="width: 70px;">サイズ</th>
            <th style="width: 90px;">形状</th>
            <th style="width: 60px;">軌跡</th>
            <th style="width: 100px;">透過性</th>
            <th style="width: 70px;">長さ</th>
          </tr>
        </thead>
        <tbody>
    `;
    if (this.spheres) {
      this.spheres.forEach((sphere, i) => {
        const colorHex = parseInt(sphere.material.color.getHexString(), 16);
        const currentColorName = this.getColorNameFromHex(colorHex);
        const currentColorHexStr = this.toHex(this.getHexFromColorName(currentColorName));
        const geoParams = sphere.geometry.parameters;
        const pattern = sphere.userData.pattern || 'sphere';
        let size;
        if (pattern === 'sphere') {
          size = Math.round((geoParams.radius || 0) * 100);
        } else if (pattern === 'cone') {
          // ConeGeometryのparametersではradiusが使われる（radiusBottomではない）
          size = Math.round((geoParams.radius || 0) * 100);
        } else {
          size = Math.round((geoParams.width || 0) * 100);
        }
        const name = this.currentPointNames[i] || `ポイント${i + 1}`;
        const trajectoryVisible = this.trajectorySettings[i] ? this.trajectorySettings[i].visible : false;
        const trajectoryOpacity = this.trajectorySettings[i] ? this.trajectorySettings[i].opacity : 0.7;
        const trajectoryLength = this.trajectorySettings[i] ? this.trajectorySettings[i].trajectoryLength : 50;
        tableHTML += `
          <tr>
            <td><input type="checkbox" class="pointRowCheck" data-index="${i}"></td>
            <td class="row-number">${i + 1}</td>
            <td><input type="text" id="pointNameInput${i}" value="${name}"></td>
            <td>
              <div class="color-cell">
                <select id="pointColorInput${i}">${colorOptionsHTML}</select>
                <span id="pointColorMap_${i}" class="color-preview" style="background-color: ${currentColorHexStr};"></span>
              </div>
            </td>
            <td><input type="text" id="pointSizeInput${i}" inputmode="numeric" pattern="[0-9]*" value="${size}" class="size-input"></td>
            <td>
              <select id="pointPatternInput${i}">
                <option value="sphere" ${pattern === 'sphere' ? 'selected' : ''}>球体</option>
                <option value="box" ${pattern === 'box' ? 'selected' : ''}>四角</option>
                <option value="cone" ${pattern === 'cone' ? 'selected' : ''}>コーン</option>
              </select>
            </td>
            <td><input type="checkbox" id="pointTrajectoryVisible${i}" ${trajectoryVisible ? 'checked' : ''}></td>
            <td><input type="range" id="pointTrajectoryOpacity${i}" min="0" max="1" step="0.1" value="${trajectoryOpacity}"></td>
            <td><input type="text" id="pointTrajectoryLength${i}" inputmode="numeric" pattern="[0-9]*" value="${trajectoryLength}" class="size-input"></td>
          </tr>
        `;
      });
    }
    tableHTML += '</tbody></table></div>';
    list.innerHTML = bulkHTML + tableHTML;

    // 全選択チェックボックス
    const selectAll = document.getElementById('pointSelectAll');
    selectAll.onclick = () => {
      const checks = list.querySelectorAll('.pointRowCheck');
      checks.forEach(cb => { cb.checked = selectAll.checked; });
    };

    // 一括設定のカラーマップを更新
    const bulkPointColorMap = document.getElementById('bulkPointColorMap');
    const bulkPointColorSelect = document.getElementById('bulkPointColor');
    if (bulkPointColorMap && bulkPointColorSelect) {
      const bulkColorHex = this.toHex(this.getHexFromColorName(bulkPointColorSelect.value));
      bulkPointColorMap.style.backgroundColor = bulkColorHex;

      // 一括設定の色選択変更時にカラーマップを更新
      bulkPointColorSelect.onchange = () => {
        const selectedColorHex = this.toHex(this.getHexFromColorName(bulkPointColorSelect.value));
        bulkPointColorMap.style.backgroundColor = selectedColorHex;
      };
    }

    // 各ポイントの色選択状態を復元とカラーマップを初期化・更新
    if (this.spheres) {
      this.spheres.forEach((sphere, i) => {
        const colorSelect = document.getElementById(`pointColorInput${i}`);
        const colorMap = document.getElementById(`pointColorMap_${i}`);
        if (colorSelect && colorMap) {
          const colorHex = parseInt(sphere.material.color.getHexString(), 16);
          const currentColorName = this.getColorNameFromHex(colorHex);
          colorSelect.value = currentColorName;

          const colorHexStr = this.toHex(this.getHexFromColorName(currentColorName));
          colorMap.style.backgroundColor = colorHexStr;

          // 色選択変更時にカラーマップを更新
          colorSelect.onchange = () => {
            const selectedColorHex = this.toHex(this.getHexFromColorName(colorSelect.value));
            colorMap.style.backgroundColor = selectedColorHex;
          };
        }
      });
    }

    // 一括適用ボタン
    document.getElementById('applyBulkPointSettings').onclick = () => {
      const colorName = document.getElementById('bulkPointColor').value;
      const size = parseFloat(document.getElementById('bulkPointSize').value) / 100;
      const pattern = document.getElementById('bulkPointPattern').value;
      const trajectoryVisible = document.getElementById('bulkTrajectoryVisible').checked;
      const trajectoryOpacity = parseFloat(document.getElementById('bulkTrajectoryOpacity').value);
      const trajectoryLength = parseInt(document.getElementById('bulkTrajectoryLength').value);
      const checks = list.querySelectorAll('.pointRowCheck');
      checks.forEach((cb, i) => {
        if (cb.checked && this.spheres[i]) {
          document.getElementById(`pointColorInput${i}`).value = colorName;
          const colorMap = document.getElementById(`pointColorMap_${i}`);
          if (colorMap) {
            const colorHex = this.toHex(this.getHexFromColorName(colorName));
            colorMap.style.backgroundColor = colorHex;
          }
          // 軌跡の色も同じ色に同期する準備（最終的にはOKボタンで確定）
          document.getElementById(`pointSizeInput${i}`).value = size * 100;
          document.getElementById(`pointPatternInput${i}`).value = pattern;
          document.getElementById(`pointTrajectoryVisible${i}`).checked = trajectoryVisible;
          document.getElementById(`pointTrajectoryOpacity${i}`).value = trajectoryOpacity;
          document.getElementById(`pointTrajectoryLength${i}`).value = trajectoryLength;
        }
      });
    };

    dialog.style.display = 'block';

    // OKボタン
    document.getElementById('pointSettingsOk').onclick = () => {
      if (this.spheres) {
        this.spheres.forEach((sphere, i) => {
          // 名称更新
          if (this.currentPointNames) {
            const nameInput = document.getElementById(`pointNameInput${i}`);
            if (nameInput) {
              this.currentPointNames[i] = nameInput.value;
              // 軌跡設定の名前も同期
              if (this.trajectorySettings[i]) {
                this.trajectorySettings[i].name = nameInput.value;
              }
            }
          }
          const colorName = document.getElementById(`pointColorInput${i}`).value;
          const colorHex = this.getHexFromColorName(colorName);
          const size = parseFloat(document.getElementById(`pointSizeInput${i}`).value) / 100;
          const pattern = document.getElementById(`pointPatternInput${i}`).value;

          sphere.material.color.setHex(colorHex);
          sphere.userData.pattern = pattern;

          // ジオメトリを更新
          sphere.geometry.dispose();

          let newGeo;
          if (size <= 0) {
            // サイズが0の場合は非表示にし、サイズ0のジオメトリを作成
            sphere.visible = false;
            if (pattern === 'box') {
              newGeo = new THREE.BoxGeometry(0, 0, 0);
            } else if (pattern === 'cone') {
              newGeo = new THREE.ConeGeometry(0, 0, 16);
            } else {
              newGeo = new THREE.SphereGeometry(0, 16, 16);
            }
          } else {
            // サイズがある場合は表示し、指定サイズのジオメトリを作成
            sphere.visible = true;
            if (pattern === 'box') {
              newGeo = new THREE.BoxGeometry(size, size, size);
            } else if (pattern === 'cone') {
              // ConeGeometry(radius, height, radialSegments) - 高さ=直径にする、Z方向に先端を向ける
              newGeo = new THREE.ConeGeometry(size, size * 2, 16);
              newGeo.translate(0, size, 0); // 底面が原点になるようにY方向に平行移動
              newGeo.rotateX(Math.PI / 2);
            } else {
              newGeo = new THREE.SphereGeometry(size, 16, 16);
            }
          }
          sphere.geometry = newGeo;

          // 軌跡設定も更新
          if (this.trajectorySettings[i]) {
            // ポイントの色を軌跡の色にも反映
            this.trajectorySettings[i].color = colorHex;
            this.trajectorySettings[i].visible = document.getElementById(`pointTrajectoryVisible${i}`).checked;
            this.trajectorySettings[i].opacity = parseFloat(document.getElementById(`pointTrajectoryOpacity${i}`).value);
            this.trajectorySettings[i].trajectoryLength = parseInt(document.getElementById(`pointTrajectoryLength${i}`).value);
          }
        });
      }

      // 軌跡を更新
      this.updateTrajectories();
      this.updateLineTrajectories();
      dialog.style.display = 'none';
    };

    // キャンセルボタン
    document.getElementById('pointSettingsCancel').onclick = () => {
      dialog.style.display = 'none';
    };
  }

  // ライン設定ダイアログ表示・反映
  showLineSettingsDialog() {
    console.log('app.js: showLineSettingsDialog呼び出し');
    const dialog = document.getElementById('lineSettingsDialog');
    const container = document.getElementById('lineSettingsListContainer');

    // ダイアログの現在の状態から設定を読み込むヘルパー関数
    const syncSettingsFromDialog = () => {
      const newSettings = [];
      container.querySelectorAll('tbody tr').forEach(tr => {
        const i = tr.dataset.index;
        if (i === undefined) return;

        const segmentTypeSelect = document.getElementById(`lineSegmentType_${i}`);
        newSettings.push({
          name1: document.getElementById(`lineName1_${i}`).value,
          name2: document.getElementById(`lineName2_${i}`).value,
          color: this.getHexFromColorName(document.getElementById(`lineColor_${i}`).value),
          width: parseInt(document.getElementById(`lineWidth_${i}`).value, 10),
          style: document.getElementById(`lineStyle_${i}`).value,
          visible: document.getElementById(`lineVisible_${i}`).checked,
          trajectoryVisible: document.getElementById(`lineTrajectoryVisible${i}`).checked,
          trajectoryOpacity: parseFloat(document.getElementById(`lineTrajectoryOpacity${i}`).value),
          trajectoryLength: parseInt(document.getElementById(`lineTrajectoryLength${i}`).value),
          segmentType: segmentTypeSelect ? segmentTypeSelect.value : 'none'
        });
      });
      this.lineSettings = newSettings;
    };

    const updateLineSettingsDialog = () => {
      let pointNames = this.currentPointNames || [];
      if (pointNames.length === 0) {
        // ポイント名が利用できない場合は、現在の設定を元に名前を収集
        const namesFromSettings = new Set();
        this.lineSettings.forEach(s => {
          namesFromSettings.add(s.name1);
          namesFromSettings.add(s.name2);
        });
        // モーションデータからポイント数を取得して汎用名を追加
        if (this.motionData && this.motionData.header && this.motionData.header.pointCount) {
          for (let i = 0; i < this.motionData.header.pointCount; i++) {
            namesFromSettings.add(`ポイント${i + 1}`);
          }
        }
        pointNames = Array.from(namesFromSettings).filter(n => n).sort();
      }

      // 色選択のオプションHTMLを生成
      const colorOptionsHTML = Object.keys(this.colorOptions).map(name =>
        `<option value="${name}" ${name === '青' ? 'selected' : ''}>${name}</option>`
      ).join('');

      // 一括設定欄（モダンデザイン）
      const bulkHTML = `
        <div class="settings-bulk-area">
          <div class="bulk-group bulk-select-all">
            <input type="checkbox" id="lineSelectAll">
            <label for="lineSelectAll">全選択</label>
          </div>
          <div class="bulk-group">
            <label>色</label>
            <div class="color-cell">
              <select id="bulkLineColor">${colorOptionsHTML}</select>
              <span id="bulkLineColorMap" class="color-preview" style="background-color: #0000ff;"></span>
            </div>
          </div>
          <div class="bulk-group">
            <label>太さ</label>
            <input type="text" id="bulkLineWidth" inputmode="numeric" pattern="[0-9]*" value="10" class="size-input">
          </div>
          <div class="bulk-group">
            <label>スタイル</label>
            <select id="bulkLineStyle">
              <option value="solid">実線</option>
              <option value="dashed">破線</option>
              <option value="dotted">点線</option>
            </select>
          </div>
          <div class="bulk-group">
            <label>軌跡</label>
            <input type="checkbox" id="bulkLineTrajectoryVisible">
          </div>
          <div class="bulk-group">
            <label>透過性</label>
            <input type="range" id="bulkLineTrajectoryOpacity" min="0" max="1" step="0.1" value="0.7">
          </div>
          <div class="bulk-group">
            <label>軌跡長さ</label>
            <input type="text" id="bulkLineTrajectoryLength" inputmode="numeric" pattern="[0-9]*" value="50" class="size-input">
          </div>
          <button id="applyBulkLineSettings" class="apply-btn">一括適用</button>
        </div>
      `;

      const pointOptions = pointNames.map(name => `<option value="${name}">${name}</option>`).join('');

      // セグメントタイプオプション
      const segmentTypeOptions = `
        <option value="none">なし</option>
        <option value="rightThigh">右大腿</option>
        <option value="leftThigh">左大腿</option>
        <option value="rightShank">右下腿</option>
        <option value="leftShank">左下腿</option>
        <option value="rightFoot">右足</option>
        <option value="leftFoot">左足</option>
        <option value="rightHeel">右踵</option>
        <option value="leftHeel">左踵</option>
      `;

      let tableHTML = `
        <div class="settings-table-container">
        <table class="settings-table">
          <thead>
            <tr>
              <th style="width: 40px;"></th>
              <th style="width: 120px;">開始点</th>
              <th style="width: 120px;">終了点</th>
              <th style="width: 90px;">セグメント</th>
              <th style="width: 140px;">色</th>
              <th style="width: 70px;">太さ</th>
              <th style="width: 60px;"><input type="checkbox" id="line-visible-all" title="すべて表示/非表示"> 表示</th>
              <th style="width: 90px;">スタイル</th>
              <th style="width: 60px;">軌跡</th>
              <th style="width: 100px;">透過性</th>
              <th style="width: 70px;">長さ</th>
              <th style="width: 60px;"></th>
            </tr>
          </thead>
          <tbody>
      `;

      this.lineSettings.forEach((setting, i) => {
        const currentColorName = this.getColorNameFromHex(setting.color);
        const currentColorHex = this.toHex(this.getHexFromColorName(currentColorName));
        tableHTML += `
          <tr data-index="${i}">
            <td><input type="checkbox" class="lineRowCheck" data-index="${i}"></td>
            <td><select id="lineName1_${i}">${pointOptions}</select></td>
            <td><select id="lineName2_${i}">${pointOptions}</select></td>
            <td><select id="lineSegmentType_${i}">${segmentTypeOptions}</select></td>
            <td>
              <div class="color-cell">
                <select id="lineColor_${i}">${colorOptionsHTML}</select>
                <span id="lineColorMap_${i}" class="color-preview" style="background-color: ${currentColorHex};"></span>
              </div>
            </td>
            <td><input type="text" id="lineWidth_${i}" inputmode="numeric" pattern="[0-9]*" value="${setting.width}" class="size-input"></td>
            <td><input type="checkbox" class="line-visible-checkbox" id="lineVisible_${i}" ${setting.visible ? 'checked' : ''}></td>
            <td>
              <select id="lineStyle_${i}">
                <option value="solid">実線</option>
                <option value="dashed">破線</option>
                <option value="dotted">点線</option>
              </select>
            </td>
            <td><input type="checkbox" class="line-trajectory-checkbox" id="lineTrajectoryVisible${i}" ${setting.trajectoryVisible ? 'checked' : ''}></td>
            <td><input type="range" id="lineTrajectoryOpacity${i}" min="0" max="1" step="0.1" value="${setting.trajectoryOpacity}"></td>
            <td><input type="text" id="lineTrajectoryLength${i}" inputmode="numeric" pattern="[0-9]*" value="${setting.trajectoryLength}" class="size-input"></td>
            <td><button class="delete-line-btn delete-btn" data-index="${i}">削除</button></td>
          </tr>
        `;
      });

      tableHTML += '</tbody></table></div>';
      container.innerHTML = bulkHTML + tableHTML;

      // selectの選択状態を復元
      this.lineSettings.forEach((setting, i) => {
        document.getElementById(`lineName1_${i}`).value = setting.name1;
        document.getElementById(`lineName2_${i}`).value = setting.name2;
        const currentColorName = this.getColorNameFromHex(setting.color);
        document.getElementById(`lineColor_${i}`).value = currentColorName;
        document.getElementById(`lineStyle_${i}`).value = setting.style;
        // セグメントタイプを復元
        const segmentTypeSelect = document.getElementById(`lineSegmentType_${i}`);
        if (segmentTypeSelect) {
          segmentTypeSelect.value = setting.segmentType || 'none';
        }

        // カラーマップを更新
        const colorMap = document.getElementById(`lineColorMap_${i}`);
        if (colorMap) {
          const colorHex = this.toHex(this.getHexFromColorName(currentColorName));
          colorMap.style.backgroundColor = colorHex;
        }
      });

      // 一括設定のカラーマップを更新
      const bulkColorMap = document.getElementById('bulkLineColorMap');
      if (bulkColorMap) {
        const bulkColorSelect = document.getElementById('bulkLineColor');
        if (bulkColorSelect) {
          const bulkColorHex = this.toHex(this.getHexFromColorName(bulkColorSelect.value));
          bulkColorMap.style.backgroundColor = bulkColorHex;

          // 一括設定の色選択変更時にカラーマップを更新
          bulkColorSelect.onchange = () => {
            const selectedColorHex = this.toHex(this.getHexFromColorName(bulkColorSelect.value));
            bulkColorMap.style.backgroundColor = selectedColorHex;
          };
        }
      }

      // 各ラインの色選択変更時にカラーマップを更新
      this.lineSettings.forEach((setting, i) => {
        const colorSelect = document.getElementById(`lineColor_${i}`);
        const colorMap = document.getElementById(`lineColorMap_${i}`);
        if (colorSelect && colorMap) {
          colorSelect.onchange = () => {
            const selectedColorHex = this.toHex(this.getHexFromColorName(colorSelect.value));
            colorMap.style.backgroundColor = selectedColorHex;
          };
        }
      });

      // 削除ボタンにイベント設定
      container.querySelectorAll('.delete-line-btn').forEach(btn => {
        btn.onclick = (e) => {
          const indexToRemove = parseInt(e.target.dataset.index, 10);
          this.lineSettings.splice(indexToRemove, 1);
          updateLineSettingsDialog(); // ダイアログを再描画
        };
      });

      // --- 一括設定イベント ---
      const selectAllCheckbox = document.getElementById('lineSelectAll');
      if (selectAllCheckbox) {
        selectAllCheckbox.onclick = () => {
          container.querySelectorAll('.lineRowCheck').forEach(cb => { cb.checked = selectAllCheckbox.checked; });
        };
      }

      const applyBulkButton = document.getElementById('applyBulkLineSettings');
      if (applyBulkButton) {
        applyBulkButton.onclick = () => {
          const colorName = document.getElementById('bulkLineColor').value;
          const colorHex = this.toHex(this.getHexFromColorName(colorName));
          const width = document.getElementById('bulkLineWidth').value;
          const style = document.getElementById('bulkLineStyle').value;
          const trajectoryVisible = document.getElementById('bulkLineTrajectoryVisible').checked;
          const trajectoryOpacity = parseFloat(document.getElementById('bulkLineTrajectoryOpacity').value);
          const trajectoryLength = parseInt(document.getElementById('bulkLineTrajectoryLength').value);
          container.querySelectorAll('.lineRowCheck').forEach(cb => {
            if (cb.checked) {
              const i = cb.dataset.index;
              document.getElementById(`lineColor_${i}`).value = colorName;
              // カラープレビューも更新
              const colorMap = document.getElementById(`lineColorMap_${i}`);
              if (colorMap) {
                colorMap.style.backgroundColor = colorHex;
              }
              document.getElementById(`lineWidth_${i}`).value = width;
              document.getElementById(`lineStyle_${i}`).value = style;
              document.getElementById(`lineTrajectoryVisible${i}`).checked = trajectoryVisible;
              document.getElementById(`lineTrajectoryOpacity${i}`).value = trajectoryOpacity;
              document.getElementById(`lineTrajectoryLength${i}`).value = trajectoryLength;
            }
          });
        };
      }

      // --- 表示/非表示 一括切り替えイベント ---
      const checkAllVisible = document.getElementById('line-visible-all');
      if (checkAllVisible) {
        const allVisibleCheckboxes = container.querySelectorAll('.line-visible-checkbox');
        const allAreVisible = allVisibleCheckboxes.length > 0 && [...allVisibleCheckboxes].every(cb => cb.checked);
        checkAllVisible.checked = allAreVisible;

        checkAllVisible.onclick = (e) => {
          const isChecked = e.target.checked;
          allVisibleCheckboxes.forEach(checkbox => { checkbox.checked = isChecked; });
        };
      }

      // 個別の表示チェックボックスが変更されたら「すべて表示」の状態を更新
      container.querySelectorAll('.line-visible-checkbox').forEach(checkbox => {
        checkbox.onchange = () => {
          if (checkAllVisible) {
            const allVisibleCheckboxes = container.querySelectorAll('.line-visible-checkbox');
            const allAreVisible = [...allVisibleCheckboxes].every(cb => cb.checked);
            checkAllVisible.checked = allAreVisible;
          }
        };
      });
    };

    // スティックピクチャーがなくても、データがあればポイント名を取得してダイアログを表示
    if (!this.currentStickType && this.lineSettings.length === 0 && (!this.currentPointNames || this.currentPointNames.length === 0)) {
      container.innerHTML = '<p>モーションデータまたはスティックピクチャーを先に読み込んでください。</p>';
    } else {
      updateLineSettingsDialog();
    }

    dialog.style.display = 'block';

    document.getElementById('lineSettingsAddLine').onclick = () => {
      // データがあればポイント名を取得可能なので、スティックピクチャーなしでも追加を許可
      // UIの変更を保存してから新しいラインを追加
      syncSettingsFromDialog();

      const pointNames = this.currentPointNames || [];
      this.lineSettings.push({
        name1: '',
        name2: '',
        color: this.currentLineColor,
        width: this.currentLineWidth,
        style: 'solid',
        visible: true,
        trajectoryVisible: false,
        trajectoryOpacity: 0.7,
        trajectoryLength: 50,
        segmentType: 'none'  // セグメントタイプ（逆動力学用）
      });
      updateLineSettingsDialog();
    };

    document.getElementById('lineSettingsOk').onclick = () => {
      // 最終的なUIの状態を保存
      syncSettingsFromDialog();

      if (this.motionData) {
        this.drawStickPicture(this.motionData.frames[this.currentFrame]);
        this.updateTrajectories();
        this.updateLineTrajectories();
      }
      dialog.style.display = 'none';
    };
    document.getElementById('lineSettingsCancel').onclick = () => {
      dialog.style.display = 'none';
    };
  }

  // 補助関数: 数値を16進数カラーコードに変換
  toHex(c) {
    return '#' + c.toString(16).padStart(6, '0');
  }

  // 補助関数: 16進数カラーコードから最も近い色名を取得
  getColorNameFromHex(hexColor) {
    const color = typeof hexColor === 'number' ? hexColor : parseInt(hexColor.replace('#', '0x'));

    // 色の距離を計算する関数
    const colorDistance = (c1, c2) => {
      const r1 = (c1 >> 16) & 0xff;
      const g1 = (c1 >> 8) & 0xff;
      const b1 = c1 & 0xff;
      const r2 = (c2 >> 16) & 0xff;
      const g2 = (c2 >> 8) & 0xff;
      const b2 = c2 & 0xff;
      return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
    };

    let closestColor = '青'; // デフォルト
    let minDistance = Infinity;

    for (const [name, hex] of Object.entries(this.colorOptions)) {
      const distance = colorDistance(color, hex);
      if (distance < minDistance) {
        minDistance = distance;
        closestColor = name;
      }
    }

    return closestColor;
  }

  // 補助関数: 色名から16進数カラーコードに変換
  getHexFromColorName(colorName) {
    return this.colorOptions[colorName] || this.colorOptions['青'];
  }

  /**
   * 現在の設定を収集する
   */
  collectSettings() {
    const pointSettings = this.spheres.map((sphere, i) => {
      const geoParams = sphere.geometry.parameters;
      const pat = sphere.userData.pattern || 'sphere';
      let size;
      if (pat === 'sphere') {
        size = Math.round((geoParams.radius || 0) * 100);
      } else if (pat === 'cone') {
        // ConeGeometryのparametersではradiusが使われる（radiusBottomではない）
        size = Math.round((geoParams.radius || 0) * 100);
      } else {
        size = Math.round((geoParams.width || 0) * 100);
      }
      return {
        name: this.currentPointNames[i] || `ポイント${i + 1}`,
        color: '#' + sphere.material.color.getHexString(),
        size: size,
        pattern: pat
      };
    });

    const lineSettings = this.lineSettings.map(setting => ({
      name1: setting.name1,
      name2: setting.name2,
      color: '#' + new THREE.Color(setting.color).getHexString(),
      width: setting.width,
      style: setting.style || 'solid',
      visible: setting.visible,
      trajectoryVisible: setting.trajectoryVisible || false,
      trajectoryOpacity: setting.trajectoryOpacity || 0.7,
      trajectoryLength: setting.trajectoryLength || 50,
      segmentType: setting.segmentType || 'none'
    }));

    const trajectorySettings = this.trajectorySettings.map(setting => ({
      pointIndex: setting.pointIndex,
      name: setting.name,
      color: setting.color,
      opacity: setting.opacity,
      interval: 1,
      visible: setting.visible,
      trajectoryLength: setting.trajectoryLength || 50
    }));

    const floorSettings = {
      gridColor1: this.gridColor1,
      gridColor2: this.gridColor2,
      backgroundColor: (this.scene && this.scene.background) ? '#' + this.scene.background.getHexString() : '#ffffff'
    };

    return {
      pointSettings,
      lineSettings,
      trajectorySettings,
      floorSettings,
      stickPictureType: this.currentStickType,
      segmentDefinitions: this.segmentDefinitions || {}
    };
  }

  /**
   * プロジェクトデータを収集する
   */
  collectProjectData() {
    const projectData = {
      version: '2.0',  // バージョンアップ（フレームデータ含む）
      savedAt: new Date().toISOString(),

      // モーションファイルのパス（参照用）
      motionFilePath: this.lastLoadedFilePath || null,

      // モーションデータ（ヘッダー情報）
      motionHeader: this.motionData ? {
        fileName: this.motionData.header.fileName,
        frameCount: this.motionData.header.frameCount,
        pointCount: this.motionData.header.pointCount,
        frameInterval: this.motionData.header.frameInterval,
        duration: this.motionData.header.duration,
        dimension: this.motionData.header.dimension
      } : null,

      // フレームデータ（フィルタ適用後の座標データ）
      frames: this.motionData ? this.motionData.frames : null,

      // 表示設定
      settings: this.collectSettings(),

      // ライン設定（詳細）
      lineSettings: this.lineSettings ? this.lineSettings.map(setting => ({
        name1: setting.name1,
        name2: setting.name2,
        color: setting.color,
        width: setting.width,
        style: setting.style,
        visible: setting.visible,
        segmentType: setting.segmentType || 'none'
      })) : [],

      // 軌跡設定（詳細）
      trajectorySettings: this.trajectorySettings ? this.trajectorySettings.map(setting => ({
        pointIndex: setting.pointIndex,
        name: setting.name,
        color: setting.color,
        opacity: setting.opacity,
        visible: setting.visible,
        trajectoryLength: setting.trajectoryLength || 50
      })) : [],

      // ライン軌跡設定
      lineTrajectorySettings: this.lineTrajectorySettings || [],

      // 連続描写設定
      sequenceDrawing: this.sequenceDrawing || null,

      // カメラ位置
      cameraPosition: this.camera ? {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z
      } : null,

      // カメラターゲット
      cameraTarget: this.controls ? {
        x: this.controls.target.x,
        y: this.controls.target.y,
        z: this.controls.target.z
      } : null,

      // 現在のフレーム
      currentFrame: this.currentFrame,

      // 再生速度
      animationSpeed: this.animationSpeed,

      // スティックピクチャータイプ
      stickPictureType: this.currentStickType,

      // セグメント定義
      segmentDefinitions: this.segmentDefinitions || {}
    };

    return projectData;
  }

  /**
   * 同名の設定ファイルの存在を確認し、自動読み込みを提案する
   */
  async checkAndLoadSettingsFile(dataFileName, dataFilePath) {
    try {
      // ファイルパスがない場合は何もしない
      if (!dataFilePath) {
        console.log('ファイルパスが取得できないため、設定ファイルの自動読み込みをスキップします');
        return;
      }

      // ファイル名から拡張子を除いたベース名を取得
      const baseName = dataFileName.replace(/\.[^/.]+$/, '');

      // 同名の.jsonファイルのパスを構築
      const settingsFilePath = dataFilePath.replace(/\.[^/.]+$/, '.json');

      // ファイルが存在するかチェック
      const checkResult = await window.electronAPI.invoke('check-file-exists', settingsFilePath);

      if (checkResult.exists) {
        // 確認ダイアログを表示
        const shouldLoad = confirm(`同名の設定ファイル（${baseName}.json）が見つかりました。\n設定ファイルを読み込みますか？`);

        if (shouldLoad) {
          // ファイルを読み込む
          const readResult = await window.electronAPI.invoke('read-settings-file', settingsFilePath);
          if (readResult.success) {
            const settings = JSON.parse(readResult.content);
            this.applySettings(settings);
          } else {
            console.error('設定ファイルの読み込みエラー:', readResult.error);
            alert('設定ファイルの読み込みに失敗しました。');
          }
        }
      }
    } catch (error) {
      console.error('設定ファイル自動読み込みエラー:', error);
    }
  }

  /**
   * 保存時のデフォルトパスを取得（モーションデータのディレクトリ + ファイル名）
   */
  getDefaultSavePath(fileName) {
    if (this.lastLoadedFilePath) {
      // ファイルパスからディレクトリを取得
      const lastSlashIndex = Math.max(
        this.lastLoadedFilePath.lastIndexOf('/'),
        this.lastLoadedFilePath.lastIndexOf('\\')
      );
      if (lastSlashIndex > -1) {
        const directory = this.lastLoadedFilePath.substring(0, lastSlashIndex + 1);
        return directory + fileName;
      }
    }
    // フォールバック：ファイル名のみ
    return fileName;
  }

  /**
   * 設定を適用する
   */
  applySettings(settings) {
    if (!settings) return;

    try {
      if (settings.pointSettings && this.spheres.length === settings.pointSettings.length) {
        this.currentPointNames = settings.pointSettings.map(p => p.name);
        settings.pointSettings.forEach((p, i) => {
          const sphere = this.spheres[i];
          sphere.material.color.set(p.color);

          const size = parseFloat(p.size) / 100;
          const pattern = p.pattern;
          sphere.userData.pattern = pattern;

          sphere.geometry.dispose();
          let newGeo;
          if (pattern === 'box') {
            newGeo = new THREE.BoxGeometry(size, size, size);
          } else if (pattern === 'cone') {
            newGeo = new THREE.ConeGeometry(size, size * 2, 16);
            newGeo.translate(0, size, 0); // 底面が原点になるようにY方向に平行移動
            newGeo.rotateX(Math.PI / 2);
          } else {
            newGeo = new THREE.SphereGeometry(size, 16, 16);
          }
          sphere.geometry = newGeo;
        });

        // グラフのポイント選択パネルを更新
        const jointFloatBody = document.getElementById('jointFloatBody');
        if (jointFloatBody) {
          this.populateSelectionContainer(jointFloatBody, { idPrefix: 'float' });
        }
      }

      if (settings.lineSettings) {
        this.lineSettings = settings.lineSettings.map(setting => ({
          name1: setting.name1,
          name2: setting.name2,
          color: parseInt(setting.color.replace('#', '0x')),
          width: setting.width,
          style: setting.style || 'solid',
          visible: setting.visible,
          trajectoryVisible: setting.trajectoryVisible || false,
          trajectoryOpacity: setting.trajectoryOpacity || 0.7,
          trajectoryLength: setting.trajectoryLength || 50,
          segmentType: setting.segmentType || 'none'
        }));
      }

      if (settings.trajectorySettings) {
        this.trajectorySettings = settings.trajectorySettings.map(setting => ({
          pointIndex: setting.pointIndex,
          name: setting.name,
          color: setting.color || parseInt(this.currentPointNames[setting.pointIndex] ? this.spheres[setting.pointIndex].material.color.getHexString() : 'ff0000', 16), // デフォルト色の処理
          opacity: setting.opacity,
          interval: 1,
          visible: setting.visible,
          trajectoryLength: setting.trajectoryLength || 50
        }));
      }

      // スティックピクチャータイプの適用とメニュー更新
      this.currentStickType = settings.stickPictureType || null;
      if (this.currentStickType) {
        // メニューの状態を更新
        if (window.electronAPI && window.electronAPI.invoke) {
          window.electronAPI.invoke('reset-stick-picture-menu', this.currentStickType);
        }
      }

      // セグメント定義の復元
      if (settings.segmentDefinitions) {
        this.segmentDefinitions = settings.segmentDefinitions;
      }

      if (settings.floorSettings) {
        this.gridColor1 = settings.floorSettings.gridColor1;
        this.gridColor2 = settings.floorSettings.gridColor2;
        this.scene.background = new THREE.Color(settings.floorSettings.backgroundColor);

        const color = new THREE.Color(this.gridColor1);
        const color2 = new THREE.Color(this.gridColor2);
        if (this.gridHelpers) {
          this.gridHelpers.forEach(g => {
            g.material.color.set(color);
            if (g.material.color2) {
              g.material.color.set(color2);
            }
          });
        }
      }

      if (this.motionData) {
        this.drawStickPicture(this.motionData.frames[this.currentFrame]);
        this.updateTrajectories();
        this.updateLineTrajectories();
      }

    } catch (error) {
      console.error('設定の適用エラー:', error);
      alert(`設定ファイルの適用中にエラーが発生しました: ${error.message}`);
    }
  }

  // 新しいメソッド
  initializePointNames() {
    if (!this.motionData) {
      this.currentPointNames = [];
      return;
    }
    const pointCount = this.motionData.header.pointCount;

    // C3Dファイルからのポイントラベルがある場合はそれを優先使用
    if (this.pendingC3DMetadata && this.pendingC3DMetadata.pointLabels && this.pendingC3DMetadata.pointLabels.length > 0) {
      console.log('[initializePointNames] C3Dポイントラベルを使用:', this.pendingC3DMetadata.pointLabels);
      this.currentPointNames = [...this.pendingC3DMetadata.pointLabels];
      // ポイント数が足りない場合は汎用名を追加
      for (let i = this.currentPointNames.length; i < pointCount; i++) {
        this.currentPointNames.push(`ポイント${i + 1}`);
      }
      // フォースプレートデータを保存（initializeForcePlatesで使用）
      if (this.pendingC3DMetadata.forcePlates && this.pendingC3DMetadata.forcePlates.length > 0) {
        this.pendingForcePlateData = this.pendingC3DMetadata.forcePlates;
        console.log('[C3D Renderer] フォースプレートデータを受信:', this.pendingForcePlateData.length, 'プレート');

        // 各プレートのデータを詳細表示
        this.pendingForcePlateData.forEach((plate, idx) => {
          console.log(`[C3D Renderer] Plate ${idx}:`, {
            type: plate.type,
            channels: plate.channels,
            forceDataLength: plate.forceData?.length || 0,
            corners: plate.corners,
            origin: plate.origin
          });

          // フレーム100とフレーム1251の力データを確認
          if (plate.forceData && plate.forceData.length > 100) {
            const f100 = plate.forceData[100];
            const midFrame = Math.floor(plate.forceData.length / 2);
            const fMid = plate.forceData[midFrame];
            console.log(`[C3D Renderer] Plate ${idx} Frame 100:`, f100);
            console.log(`[C3D Renderer] Plate ${idx} Frame ${midFrame}:`, fMid);

            // 最大Fzを探す
            let maxFz = 0, maxFzFrame = 0;
            for (let i = 0; i < plate.forceData.length; i++) {
              const fz = Math.abs(plate.forceData[i]?.fz || 0);
              if (fz > maxFz) {
                maxFz = fz;
                maxFzFrame = i;
              }
            }
            console.log(`[C3D Renderer] Plate ${idx} 最大Fz: ${maxFz.toFixed(1)}N at frame ${maxFzFrame}`);
          }
        });
      }
      // 使用後にクリア
      this.pendingC3DMetadata = null;
      return;
    }

    let baseNames = [];

    // Use the most specific list as a base
    if (pointCount >= 25 && this.bodyPointNames25.length > 0) {
      baseNames = this.bodyPointNames25;
    } else if (pointCount >= 23 && this.bodyPointNames23.length > 0) {
      baseNames = this.bodyPointNames23;
    }

    // Create a mutable copy
    this.currentPointNames = [...baseNames];

    // Add generic names for any extra points
    for (let i = this.currentPointNames.length; i < pointCount; i++) {
      this.currentPointNames.push(`ポイント${i + 1}`);
    }
  }

  async applyPointNamesFromSet(filePath) {
    console.log('[applyPointNamesFromSet] filePath:', filePath);
    if (!this.motionData || !filePath || !window.electronAPI || !window.electronAPI.invoke) {
      console.log('[applyPointNamesFromSet] 早期リターン - motionData:', !!this.motionData, 'filePath:', !!filePath, 'electronAPI:', !!window.electronAPI);
      return;
    }

    // 小文字と大文字の両方を試す
    const setPathLower = this.replaceFileExtension(filePath, '.set');
    const setPathUpper = this.replaceFileExtension(filePath, '.SET');
    if (!setPathLower) return;

    let setPath = null;
    try {
      // 小文字の.setを先に試す
      let existsResult = await window.electronAPI.invoke('check-file-exists', setPathLower);
      if (existsResult && existsResult.exists) {
        setPath = setPathLower;
      } else {
        // 大文字の.SETを試す
        existsResult = await window.electronAPI.invoke('check-file-exists', setPathUpper);
        if (existsResult && existsResult.exists) {
          setPath = setPathUpper;
        }
      }

      if (!setPath) {
        console.log('[applyPointNamesFromSet] setファイルが見つかりません');
        return;
      }

      console.log('[applyPointNamesFromSet] setファイルを読み込み:', setPath);

      const readResult = await window.electronAPI.invoke('read-binary-file', setPath);
      if (!readResult || !readResult.success || !readResult.data) {
        console.log('[applyPointNamesFromSet] setファイルの読み込みに失敗');
        return;
      }

      const binary = this.decodeBase64ToUint8Array(readResult.data);
      const decoder = new TextDecoder('shift-jis');
      const setText = decoder.decode(binary);
      const pointNames = this.extractPointNamesFromSet(setText);

      console.log('[applyPointNamesFromSet] 抽出されたポイント名:', pointNames.length, '個');

      if (pointNames.length > 0) {
        const pointCount = this.motionData.header.pointCount;
        // ポイント数が異なる場合でも、可能な範囲で適用
        const applyCount = Math.min(pointNames.length, pointCount);
        for (let i = 0; i < applyCount; i++) {
          this.currentPointNames[i] = pointNames[i];
        }
        console.log('[applyPointNamesFromSet] ポイント名を適用:', applyCount, '個');
      }
    } catch (error) {
      console.error('[applyPointNamesFromSet] エラー:', error);
      // SETファイル読み込みに失敗しても既定名称を使用
    }
  }

  replaceFileExtension(filePath, newExtension) {
    if (!filePath || !newExtension) return null;
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) {
      return `${filePath}${newExtension}`;
    }
    return `${filePath.substring(0, lastDot)}${newExtension}`;
  }

  decodeBase64ToUint8Array(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  extractPointNamesFromSet(setContent) {
    if (!setContent) return [];
    const lines = setContent.split(/\r?\n/);
    // 大文字小文字を区別しないで PointName を探す
    const pointLine = lines.find(line => line.trim().toLowerCase().startsWith('pointname'));
    if (!pointLine) {
      console.log('[extractPointNamesFromSet] PointName行が見つかりません');
      // デバッグ用に最初の数行を出力
      console.log('[extractPointNamesFromSet] ファイル内容(最初の5行):', lines.slice(0, 5));
      return [];
    }

    console.log('[extractPointNamesFromSet] PointName行:', pointLine);

    const matches = pointLine.match(/"([^"]*)"/g);
    if (!matches) {
      console.log('[extractPointNamesFromSet] ダブルクォートで囲まれた名前が見つかりません');
      return [];
    }

    return matches.map(token => token.replace(/^"|"$/g, ''));
  }

  initializeTrajectorySettings() {
    if (!this.motionData) {
      this.trajectorySettings = [];
      return;
    }

    this.trajectorySettings = [];
    for (let i = 0; i < this.motionData.header.pointCount; i++) {
      this.trajectorySettings.push({
        pointIndex: i,
        name: this.currentPointNames[i] || `ポイント${i + 1}`,
        color: '#ff0000',
        opacity: 0.7,
        interval: 1,
        visible: false,
        trajectoryLength: 50  // デフォルト50フレーム
      });
    }
  }

  pruneGraphSelections() {
    if (!this.motionData) {
      this.selectedJoints = new Set();
      this.selectedJointAngles = new Set();
      this.selectedSegmentAngles = new Set();
      return;
    }

    const pointCount = this.motionData.header.pointCount || 0;
    if (this.selectedJoints) {
      const toRemove = [];
      this.selectedJoints.forEach(idx => {
        if (typeof idx !== 'number' || idx < 0 || idx >= pointCount) {
          toRemove.push(idx);
        }
      });
      toRemove.forEach(idx => this.selectedJoints.delete(idx));
    }

    const jointDefs = this.getJointAngleDefinitions();
    const jointIds = new Set(jointDefs.map(def => def.id));
    this.selectedJointAngles.forEach(id => {
      if (!jointIds.has(id)) this.selectedJointAngles.delete(id);
    });

    const segmentDefs = this.getSegmentAngleDefinitions();
    const segmentIds = new Set(segmentDefs.map(def => def.id));
    this.selectedSegmentAngles.forEach(id => {
      if (!segmentIds.has(id)) this.selectedSegmentAngles.delete(id);
    });
  }

  getJointAngleDefinitions() {
    if (!this.motionData) return this.jointAngleDefinitionsBase;
    const pointCount = this.motionData.header.pointCount || 0;
    const labels = this.currentPointNames || [];

    // 肋骨下端のラベルが存在するか確認
    const hasRibLabels = labels.some(l => l && (l.includes('肋骨下端') || l.toLowerCase().includes('rib_lower')));

    // 25点点モデルの場合は肋骨下端を使用した定義を返す
    if (pointCount >= 25 && hasRibLabels) {
      return this.jointAngleDefinitions25;
    }
    return this.jointAngleDefinitionsBase;
  }

  getSegmentAngleDefinitions() {
    if (!this.motionData) return this.segmentAngleDefinitions23;
    const pointCount = this.motionData.header.pointCount || 0;
    if (pointCount >= 25) {
      return [...this.segmentAngleDefinitions23, ...this.segmentAngleDefinitions25Extras];
    }
    return this.segmentAngleDefinitions23;
  }

  getPointCoordinates(frameData, descriptor) {
    if (descriptor === this.VIRTUAL_POINTS.HIP_CENTER) {
      return this.computeHipCenter(frameData);
    }
    if (descriptor === this.VIRTUAL_POINTS.RIB_LOWER_MIDPOINT) {
      return this.computeRibLowerMidpoint(frameData);
    }
    if (typeof descriptor === 'number') {
      return frameData ? frameData[descriptor] : null;
    }
    return null;
  }

  computeHipCenter(frameData) {
    if (!frameData || frameData.length < 20) return null;
    const rightHip = frameData[13];
    const leftHip = frameData[19];
    if (!rightHip || !leftHip) return null;
    return {
      x: (rightHip.x + leftHip.x) / 2,
      y: (rightHip.y + leftHip.y) / 2,
      z: (rightHip.z + leftHip.z) / 2
    };
  }

  computeRibLowerMidpoint(frameData) {
    if (!frameData || frameData.length < 25) return null;
    const rightRib = frameData[23];
    const leftRib = frameData[24];
    if (!rightRib || !leftRib) return null;
    return {
      x: (rightRib.x + leftRib.x) / 2,
      y: (rightRib.y + leftRib.y) / 2,
      z: (rightRib.z + leftRib.z) / 2
    };
  }

  /**
   * 骨盤基準の局所座標系 (LCS) を計算
   * - 原点: Hip Center (左右大転子の中点)
   * - 上方向 (up): Hip Center → 胸骨上縁
   * - 右方向 (right): 左大転子 → 右大転子
   * - 前方向 (forward): 右方向 × 上方向 (右手系)
   * @returns {Object|null} { origin, up, right, forward } 各軸は正規化済み
   */
  computePelvisLCS(frameData) {
    if (!frameData || frameData.length < 23) return null;

    // ポイント取得（HPE 23/25点モデル）
    const rightHip = frameData[13];   // 右大転子
    const leftHip = frameData[19];    // 左大転子
    const trunk = frameData[22];      // 胸骨上縁

    if (!rightHip || !leftHip || !trunk) return null;
    if (!this.isValidPoint(rightHip) || !this.isValidPoint(leftHip) || !this.isValidPoint(trunk)) return null;

    // 原点: Hip Center
    const origin = {
      x: (rightHip.x + leftHip.x) / 2,
      y: (rightHip.y + leftHip.y) / 2,
      z: (rightHip.z + leftHip.z) / 2
    };

    // 右方向ベクトル: 左大転子 → 右大転子
    const rightVec = {
      x: rightHip.x - leftHip.x,
      y: rightHip.y - leftHip.y,
      z: rightHip.z - leftHip.z
    };
    const rightLen = Math.sqrt(rightVec.x ** 2 + rightVec.y ** 2 + rightVec.z ** 2);
    if (rightLen === 0) return null;
    const right = { x: rightVec.x / rightLen, y: rightVec.y / rightLen, z: rightVec.z / rightLen };

    // 上方向ベクトル: Hip Center → 胸骨上縁
    const upVec = {
      x: trunk.x - origin.x,
      y: trunk.y - origin.y,
      z: trunk.z - origin.z
    };
    // 右方向との直交化 (Gram-Schmidt)
    const dot = upVec.x * right.x + upVec.y * right.y + upVec.z * right.z;
    const upOrtho = {
      x: upVec.x - dot * right.x,
      y: upVec.y - dot * right.y,
      z: upVec.z - dot * right.z
    };
    const upLen = Math.sqrt(upOrtho.x ** 2 + upOrtho.y ** 2 + upOrtho.z ** 2);
    if (upLen === 0) return null;
    const up = { x: upOrtho.x / upLen, y: upOrtho.y / upLen, z: upOrtho.z / upLen };

    // 前方向ベクトル: right × up (右手系)
    const forward = {
      x: right.y * up.z - right.z * up.y,
      y: right.z * up.x - right.x * up.z,
      z: right.x * up.y - right.y * up.x
    };

    return { origin, up, right, forward };
  }

  /**
   * セグメントベクトルをLCSに変換し、水平面からの仰角を計算
   * @param {Object} segmentVec - セグメントベクトル {x, y, z}
   * @param {Object} lcs - 局所座標系 {up, right, forward}
   * @returns {number|null} 水平面からの仰角（度）
   */
  calculateSegmentAngleInLCS(segmentVec, lcs) {
    if (!segmentVec || !lcs) return null;

    // セグメントベクトルをLCS軸に射影
    const segRight = segmentVec.x * lcs.right.x + segmentVec.y * lcs.right.y + segmentVec.z * lcs.right.z;
    const segUp = segmentVec.x * lcs.up.x + segmentVec.y * lcs.up.y + segmentVec.z * lcs.up.z;
    const segForward = segmentVec.x * lcs.forward.x + segmentVec.y * lcs.forward.y + segmentVec.z * lcs.forward.z;

    // 水平面（right-forward平面）からの仰角
    // 水平成分 = right-forward平面への投影長、垂直成分 = up方向
    const horizontal = Math.sqrt(segRight * segRight + segForward * segForward);
    const vertical = segUp;

    // 水平面からの角度（仰角）
    return Math.atan2(vertical, horizontal) * (180 / Math.PI);
  }

  calculateJointAngle(p1, p2, p3, dimension = 3) {
    if (!p1 || !p2 || !p3) return null;
    if (dimension === 2) {
      const vec1 = { x: p1.x - p2.x, y: p1.y - p2.y };
      const vec2 = { x: p3.x - p2.x, y: p3.y - p2.y };
      const dot = vec1.x * vec2.x + vec1.y * vec2.y;
      const mag1 = Math.sqrt(vec1.x * vec1.x + vec1.y * vec1.y);
      const mag2 = Math.sqrt(vec2.x * vec2.x + vec2.y * vec2.y);
      if (mag1 === 0 || mag2 === 0) return null;
      const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
      return Math.acos(cosTheta) * (180 / Math.PI);
    }

    const vec1 = { x: p1.x - p2.x, y: p1.y - p2.y, z: p1.z - p2.z };
    const vec2 = { x: p3.x - p2.x, y: p3.y - p2.y, z: p3.z - p2.z };
    const dot = vec1.x * vec2.x + vec1.y * vec2.y + vec1.z * vec2.z;
    const mag1 = Math.sqrt(vec1.x * vec1.x + vec1.y * vec1.y + vec1.z * vec1.z);
    const mag2 = Math.sqrt(vec2.x * vec2.x + vec2.y * vec2.y + vec2.z * vec2.z);
    if (mag1 === 0 || mag2 === 0) return null;
    const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    return Math.acos(cosTheta) * (180 / Math.PI);
  }

  /**
   * セグメント角度を計算（基本計算、-180〜+180の範囲）
   * 基準方向（0度）：
   * - yz平面: +Z方向（上向き）
   * - xz平面: +Z方向（上向き）
   * - xy平面: +Y方向（進行方向）
   * 正の角度: 基準から時計回り（右回り）
   */
  /**
   * セグメント角度を計算（水平面からの仰角）
   * 正の値 = セグメントが水平より上向き
   * 負の値 = セグメントが水平より下向き
   * p1 = 遠位端、p2 = 近位端
   * @param {string} dimension - 2 (2D) or 3 (3D)
   */
  calculateSegmentAngle(p1, p2, plane = 'xy') {
    if (!p1 || !p2) return null;

    // セグメントベクトル（近位→遠位）
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = p1.z - p2.z;

    let coord1, coord2;
    switch (plane) {
      case 'yz':
        // YZ平面: Zが垂直(基準)、Yが水平
        coord1 = dy; // 水平
        coord2 = dz; // 垂直 (基準軸)
        break;
      case 'xz':
        // XZ平面: Zが垂直(基準)、Xが水平
        coord1 = dx; // 水平
        coord2 = dz; // 垂直 (基準軸)
        break;
      case 'xy':
      default:
        // XY平面: Yが垂直(基準)、Xが水平
        coord1 = dx; // 水平
        coord2 = dy; // 垂直 (基準軸)
        break;
    }

    // Z軸(またはY軸)正の向きを0度とし、時計回りに0-360度
    // 通常のatan2(y, x)はx軸正から反時計回りなので変換が必要
    // atan2(水平, 垂直) とすることで、垂直軸(coord2)正が0度、時計回りが正になる
    let angle = Math.atan2(coord1, coord2) * (180 / Math.PI);

    // 0〜360度の範囲に変換
    if (angle < 0) {
      angle += 360;
    }

    return angle;
  }

  /**
   * セグメント角度のアンラップ（連続化）処理
   * ±180度のジャンプを解消して滑らかな角度変化にする
   * @param {string} segmentId - セグメントID
   * @param {string} referenceFrame - 座標系 ('global' or 'pelvis')
   */
  getUnwrappedSegmentAngles(segmentId, referenceFrame = 'global') {
    if (!this.motionData || !this.motionData.frames) return null;
    if (!segmentId) return null;

    const dimension = this.motionData.header.dimension || 3;

    // キャッシュキー（座標系を含める）
    const cacheKey = `${segmentId}_${referenceFrame}`;
    if (!this._unwrappedSegmentAngleCache) {
      this._unwrappedSegmentAngleCache = new Map();
    }

    // キャッシュチェック
    if (this._unwrappedSegmentAngleCache.has(cacheKey)) {
      return this._unwrappedSegmentAngleCache.get(cacheKey);
    }

    // セグメント定義を取得
    const definitions = this.getSegmentAngleDefinitions();
    const definition = definitions.find(d => d.id === segmentId);
    if (!definition) {
      console.warn(`[SegmentAngle] Definition not found for ${segmentId}`);
      return null;
    }

    // 全フレームの角度を計算
    const frameCount = this.motionData.frames.length;
    const angles = new Array(frameCount);

    for (let i = 0; i < frameCount; i++) {
      const frameData = this.motionData.frames[i];
      const distal = this.getPointCoordinates(frameData, definition.distalPoint);
      const proximal = this.getPointCoordinates(frameData, definition.proximalPoint);

      if (!distal || !proximal) {
        angles[i] = null;
        continue;
      }

      if (referenceFrame === 'pelvis' && dimension === 3) {
        // 骨盤基準LCSで計算（水平面からの仰角）
        const lcs = this.computePelvisLCS(frameData);
        if (!lcs) {
          angles[i] = null;
          continue;
        }
        // セグメントベクトル（近位→遠位）
        const segmentVec = {
          x: distal.x - proximal.x,
          y: distal.y - proximal.y,
          z: distal.z - proximal.z
        };
        angles[i] = this.calculateSegmentAngleInLCS(segmentVec, lcs);
      } else {
        // グローバル座標系で計算（Z軸基準 0-360度）
        angles[i] = this.calculateSegmentAngle(distal, proximal, this.segmentAnglePlane || 'xy');
      }
    }

    // アンラップ処理
    const unwrapped = this.unwrapAngles(angles);

    // キャッシュに保存
    this._unwrappedSegmentAngleCache.set(cacheKey, unwrapped);

    return unwrapped;
  }

  /**
   * 角度配列をアンラップ（連続化）
   * ±180度の境界でジャンプを検出し、360度を加減して連続にする
   */
  unwrapAngles(angles) {
    if (!angles || angles.length === 0) return angles;

    const unwrapped = new Array(angles.length);
    unwrapped[0] = angles[0];
    let offset = 0;

    for (let i = 1; i < angles.length; i++) {
      if (angles[i] === null || angles[i - 1] === null) {
        unwrapped[i] = angles[i];
        continue;
      }

      // 元の角度同士を比較（重要：アンラップ済みの値ではなく元の値を比較）
      let diff = angles[i] - angles[i - 1];

      // 180度以上のジャンプを検出
      if (diff > 180) {
        offset -= 360;
      } else if (diff < -180) {
        offset += 360;
      }

      unwrapped[i] = angles[i] + offset;
    }

    return unwrapped;
  }

  /**
   * セグメント角度キャッシュをクリア
   */
  clearSegmentAngleCache() {
    if (this._unwrappedSegmentAngleCache) {
      this._unwrappedSegmentAngleCache.clear();
    }
  }

  calculateJointAngleValue(definition, frameIndex) {
    if (!this.motionData || !definition) return null;
    const frameData = this.motionData.frames[frameIndex];
    if (!frameData) return null;

    const p1 = this.getPointCoordinates(frameData, definition.distalPoint);
    const p2 = this.getPointCoordinates(frameData, definition.jointCenter);
    const p3 = this.getPointCoordinates(frameData, definition.proximalPoint);
    return this.calculateJointAngle(p1, p2, p3, this.motionData.header.dimension);
  }

  calculateSegmentAngleValue(definition, frameIndex) {
    if (!this.motionData || !definition) return null;

    const referenceFrame = this.segmentReferenceFrame || 'global';

    // アンラップ済み角度を取得
    const unwrapped = this.getUnwrappedSegmentAngles(definition.id, referenceFrame);
    if (unwrapped && unwrapped[frameIndex] !== null && unwrapped[frameIndex] !== undefined) {
      return unwrapped[frameIndex];
    }

    // フォールバック: 従来の計算
    const frameData = this.motionData.frames[frameIndex];
    if (!frameData) return null;
    const distal = this.getPointCoordinates(frameData, definition.distalPoint);
    const proximal = this.getPointCoordinates(frameData, definition.proximalPoint);
    if (!distal || !proximal) return null;
    return this.calculateSegmentAngle(distal, proximal, this.segmentAnglePlane || 'yz');
  }

  updateTrajectories() {
    // 既存の軌跡を削除
    if (this.trajectoryLines) {
      this.trajectoryLines.forEach(line => {
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
        this.scene.remove(line);
      });
      this.trajectoryLines = [];
    }

    if (!this.motionData || !this.motionData.frames) return;

    // 表示設定されている軌跡を描画
    this.trajectorySettings.forEach(setting => {
      if (setting.visible) {
        const points = [];
        const startFrame = Math.max(0, this.currentFrame - (setting.trajectoryLength || 50)); // 設定された軌跡長さ

        for (let frame = startFrame; frame <= this.currentFrame; frame += 1) {
          if (frame < this.motionData.frames.length) {
            const point = this.motionData.frames[frame][setting.pointIndex];
            if (point && this.isValidPoint(point)) {
              points.push(new THREE.Vector3(point.x, point.y, point.z));
            }
          }
        }

        if (points.length > 1) {
          const geometry = new THREE.BufferGeometry().setFromPoints(points);
          const material = new THREE.LineBasicMaterial({
            color: setting.color,
            opacity: setting.opacity,
            transparent: true,
            linewidth: 2
          });
          const trajectory = new THREE.Line(geometry, material);
          this.scene.add(trajectory);
          this.trajectoryLines.push(trajectory);
        }
      }
    });
  }

  // ライン軌跡の更新
  updateLineTrajectories() {
    // 既存のライン軌跡を削除
    if (this.lineTrajectoryLines) {
      this.lineTrajectoryLines.forEach(line => {
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
        this.scene.remove(line);
      });
      this.lineTrajectoryLines = [];
    }

    if (!this.motionData || !this.motionData.frames) return;

    // 表示設定されているライン軌跡を描画
    this.lineSettings.forEach(setting => {
      if (setting.trajectoryVisible && setting.visible) {
        const p1Index = this.currentPointNames.indexOf(setting.name1);
        const p2Index = this.currentPointNames.indexOf(setting.name2);

        if (p1Index > -1 && p2Index > -1) {
          const trajectoryLength = setting.trajectoryLength || 50;
          const startFrame = Math.max(0, this.currentFrame - trajectoryLength);

          // 各フレームでのライン全体を描画（フェード効果付き）
          for (let frame = startFrame; frame <= this.currentFrame; frame += 1) {
            if (frame < this.motionData.frames.length) {
              const point1 = this.motionData.frames[frame][p1Index];
              const point2 = this.motionData.frames[frame][p2Index];
              if (point1 && point2 && this.isValidPoint(point1) && this.isValidPoint(point2)) {
                // ライン全体を描画
                const lineGeometry = new THREE.BufferGeometry().setFromPoints([
                  new THREE.Vector3(point1.x, point1.y, point1.z),
                  new THREE.Vector3(point2.x, point2.y, point2.z)
                ]);

                // フレームに応じて透過度を調整（古いフレームほど薄く）
                const frameProgress = (frame - startFrame + 1) / trajectoryLength;
                const frameOpacity = setting.trajectoryOpacity * frameProgress;

                const lineMaterial = new THREE.LineBasicMaterial({
                  color: setting.color,
                  opacity: frameOpacity,
                  transparent: true,
                  linewidth: Math.max(1, setting.width * frameProgress)
                });

                const trajectoryLine = new THREE.Line(lineGeometry, lineMaterial);
                this.scene.add(trajectoryLine);
                this.lineTrajectoryLines.push(trajectoryLine);
              }
            }
          }
        }
      }
    });
  }

  /**
   * フィルタ設定ダイアログの表示とイベント設定
   */
  showFilterDialog() {
    const dlg = document.getElementById('filterDialog');
    if (!dlg) return;

    // 位置フィルタ設定要素
    const autoMode = document.getElementById('autoFcMode');
    const manualMode = document.getElementById('manualFcMode');
    const manualFcInput = document.getElementById('manualFcInput');
    const correctPadding = document.getElementById('correctPadding');
    const padLengthInput = document.getElementById('padLengthInput');

    // 位置フィルタのラジオに応じた有効制御
    const updateModeUI = () => {
      const isAuto = autoMode && autoMode.checked;
      if (manualFcInput) manualFcInput.disabled = isAuto;
    };

    if (autoMode) autoMode.onchange = updateModeUI;
    if (manualMode) manualMode.onchange = updateModeUI;

    if (correctPadding) {
      correctPadding.onchange = () => {
        if (padLengthInput) padLengthInput.disabled = !correctPadding.checked;
      };
    }

    updateModeUI();
    // パディング欄の初期有効/無効を現在のチェック状態で反映
    if (padLengthInput && correctPadding) {
      padLengthInput.disabled = !correctPadding.checked;
    }

    // ボタン
    const okBtn = document.getElementById('filterOk');
    const cancelBtn = document.getElementById('filterCancel');
    const residualBtn = document.getElementById('showResidualAnalysis');

    if (okBtn) {
      okBtn.onclick = () => {
        const mode = autoMode && autoMode.checked ? 'auto' : 'manual';
        const fc = manualFcInput ? parseFloat(manualFcInput.value) : 6;
        const doPad = correctPadding ? !!correctPadding.checked : false;
        const padLen = padLengthInput ? parseInt(padLengthInput.value, 10) : 0;

        // 速度キャッシュを無効化（設定変更のため再計算が必要）
        this.velocityCacheValid = false;

        // methodは常に'winter', cutoffMethodは常に'waw'
        this.applyButterworthFilter({ mode, method: 'winter', cutoffMethod: 'waw', fc, doPad, padLen });
        dlg.style.display = 'none';
      };
    }
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }
    if (residualBtn) {
      residualBtn.onclick = () => {
        this.showResidualAnalysisGraph();
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * 身体重心算出ダイアログ表示
   */
  showBodyCOMDialog() {
    const dlg = document.getElementById('bodyCOMDialog');
    if (!dlg) return;

    // 年代選択のイベントリスナー
    const ageGroupAdult = document.getElementById('ageGroupAdult');
    const ageGroupChild = document.getElementById('ageGroupChild');
    const ageGroupElderly = document.getElementById('ageGroupElderly');
    const childSettings = document.getElementById('childSettings');

    const updateChildSettings = () => {
      if (ageGroupChild && ageGroupChild.checked) {
        childSettings.style.display = 'block';
      } else {
        childSettings.style.display = 'none';
      }
    };

    if (ageGroupAdult) ageGroupAdult.onchange = updateChildSettings;
    if (ageGroupChild) ageGroupChild.onchange = updateChildSettings;
    if (ageGroupElderly) ageGroupElderly.onchange = updateChildSettings;

    // 初期状態を設定
    updateChildSettings();

    // OKボタン
    const okBtn = document.getElementById('bodyCOMOk');
    if (okBtn) {
      okBtn.onclick = () => {
        // 年代取得
        let ageGroup = 'adult';
        if (ageGroupChild && ageGroupChild.checked) ageGroup = 'child';
        if (ageGroupElderly && ageGroupElderly.checked) ageGroup = 'elderly';

        // 子どもの場合の追加設定
        let childAge = null;
        let bodyType = 'normal';
        if (ageGroup === 'child') {
          const childAgeInput = document.getElementById('childAge');
          if (childAgeInput) childAge = parseInt(childAgeInput.value);

          const bodyTypeThin = document.getElementById('bodyTypeThin');
          const bodyTypeObese = document.getElementById('bodyTypeObese');
          if (bodyTypeThin && bodyTypeThin.checked) bodyType = 'thin';
          if (bodyTypeObese && bodyTypeObese.checked) bodyType = 'obese';
        }

        // 性別取得
        const sexMale = document.getElementById('sexMale');
        const sex = (sexMale && sexMale.checked) ? 'male' : 'female';

        // ポイント数取得
        const points23 = document.getElementById('points23');
        const pointCount = (points23 && points23.checked) ? 23 : 25;

        // 身体重心を計算
        this.calculateBodyCOM({
          ageGroup,
          childAge,
          bodyType,
          sex,
          pointCount
        });

        dlg.style.display = 'none';
      };
    }

    // キャンセルボタン
    const cancelBtn = document.getElementById('bodyCOMCancel');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * グラフズームをリセット
   */
  resetGraphZoom() {
    this.graphZoom.timeMin = null;
    this.graphZoom.timeMax = null;
    this.graphZoom.isDragging = false;
    this.graphZoom.isPanning = false;
    // Y軸範囲もリセット
    this.graphMinValue = null;
    this.graphMaxValue = null;
    // UIの入力欄をクリア
    this.updateGraphRangeInputs();
    this.drawScatterPlot();
  }

  /**
   * グラフ範囲入力欄を現在の値で更新
   */
  updateGraphRangeInputs() {
    // X軸（時間）範囲
    const graphTimeMinInput = document.getElementById('graphTimeMinValue');
    const graphTimeMaxInput = document.getElementById('graphTimeMaxValue');
    if (graphTimeMinInput) {
      graphTimeMinInput.value = this.graphZoom.timeMin !== null ? this.graphZoom.timeMin.toFixed(3) : '';
    }
    if (graphTimeMaxInput) {
      graphTimeMaxInput.value = this.graphZoom.timeMax !== null ? this.graphZoom.timeMax.toFixed(3) : '';
    }

    // Y軸範囲
    const graphMinInput = document.getElementById('graphMinValue');
    const graphMaxInput = document.getElementById('graphMaxValue');
    if (graphMinInput) {
      graphMinInput.value = this.graphMinValue !== null ? this.graphMinValue.toFixed(2) : '';
    }
    if (graphMaxInput) {
      graphMaxInput.value = this.graphMaxValue !== null ? this.graphMaxValue.toFixed(2) : '';
    }
  }

  /**
   * グラフ設定ダイアログ表示
   */
  showGraphSettingsDialog() {
    const dlg = document.getElementById('graphSettingsDialog');
    if (!dlg) return;

    // 要素取得
    const fontSizeSlider = document.getElementById('legendFontSize');
    const fontSizeValue = document.getElementById('legendFontSizeValue');
    const lineWidthSlider = document.getElementById('graphLineWidth');
    const lineWidthValue = document.getElementById('graphLineWidthValue');
    const colorListContainer = document.getElementById('graphColorList');
    const directionVertical = document.getElementById('legendDirectionVertical');
    const directionHorizontal = document.getElementById('legendDirectionHorizontal');
    const maxWidthOption = document.getElementById('legendMaxWidthOption');
    const maxWidthSlider = document.getElementById('legendMaxWidth');
    const maxWidthValue = document.getElementById('legendMaxWidthValue');
    const sizeResetBtn = document.getElementById('legendSizeReset');
    const sizeStatus = document.getElementById('legendSizeStatus');

    // 現在の設定を反映
    if (fontSizeSlider) {
      fontSizeSlider.value = this.legendState.fontSize || 12;
      if (fontSizeValue) fontSizeValue.textContent = fontSizeSlider.value + 'px';
    }
    if (lineWidthSlider) {
      lineWidthSlider.value = this.graphSettings.lineWidth || 2;
      if (lineWidthValue) lineWidthValue.textContent = lineWidthSlider.value + 'px';
    }
    if (maxWidthSlider) {
      maxWidthSlider.value = this.legendState.maxWidth || 300;
      if (maxWidthValue) maxWidthValue.textContent = maxWidthSlider.value + 'px';
    }

    // サイズ状態表示
    const updateSizeStatus = () => {
      if (sizeStatus) {
        if (this.legendState.customSize) {
          sizeStatus.textContent = `(${Math.round(this.legendState.width)} x ${Math.round(this.legendState.height)}px)`;
        } else {
          sizeStatus.textContent = '(自動)';
        }
      }
    };
    updateSizeStatus();

    // サイズリセットボタン
    if (sizeResetBtn) {
      sizeResetBtn.onclick = () => {
        this.legendState.customSize = false;
        this.legendState.x = null;
        this.legendState.y = null;
        updateSizeStatus();
        this.drawScatterPlot();
      };
    }

    // レイアウト方向
    const currentDirection = this.legendState.direction || 'vertical';
    if (directionVertical) directionVertical.checked = (currentDirection === 'vertical');
    if (directionHorizontal) directionHorizontal.checked = (currentDirection === 'horizontal');

    // 横並び時のみ最大幅オプションを表示
    const updateMaxWidthVisibility = () => {
      if (maxWidthOption) {
        maxWidthOption.style.display = (directionHorizontal && directionHorizontal.checked) ? 'flex' : 'none';
      }
    };
    updateMaxWidthVisibility();

    if (directionVertical) directionVertical.onchange = updateMaxWidthVisibility;
    if (directionHorizontal) directionHorizontal.onchange = updateMaxWidthVisibility;

    // スライダーのリアルタイム更新
    if (fontSizeSlider && fontSizeValue) {
      fontSizeSlider.oninput = () => {
        fontSizeValue.textContent = fontSizeSlider.value + 'px';
      };
    }
    if (lineWidthSlider && lineWidthValue) {
      lineWidthSlider.oninput = () => {
        lineWidthValue.textContent = lineWidthSlider.value + 'px';
      };
    }
    if (maxWidthSlider && maxWidthValue) {
      maxWidthSlider.oninput = () => {
        maxWidthValue.textContent = maxWidthSlider.value + 'px';
      };
    }

    // 色リストを生成（現在選択中のシリーズに基づく）
    if (colorListContainer) {
      colorListContainer.innerHTML = '';

      // 現在のシリーズデータがあればそれを使用、なければ汎用表示
      const seriesData = this.currentSeriesData || [];
      const colorsToShow = seriesData.length > 0 ? seriesData.length : this.legendState.colors.length;

      for (let idx = 0; idx < colorsToShow; idx++) {
        const color = this.legendState.colors[idx % this.legendState.colors.length] || '#888888';
        const series = seriesData[idx];
        const labelText = series ? series.label : `系列 ${idx + 1}`;

        const colorItem = document.createElement('div');
        colorItem.style.cssText = 'display: flex; align-items: center; gap: 6px; min-width: 140px;';

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = color;
        colorInput.dataset.colorIndex = idx;
        colorInput.style.cssText = 'width: 32px; height: 24px; border: 1px solid #ccc; cursor: pointer; border-radius: 3px;';

        const label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText = 'font-size: 12px; color: #333;';

        colorItem.appendChild(colorInput);
        colorItem.appendChild(label);
        colorListContainer.appendChild(colorItem);
      }

      // 色が足りない場合に追加できるようにする
      if (seriesData.length === 0) {
        const addColorBtn = document.createElement('button');
        addColorBtn.textContent = '+';
        addColorBtn.title = '色を追加';
        addColorBtn.style.cssText = 'width: 32px; height: 24px; cursor: pointer; font-size: 14px; border-radius: 3px;';
        addColorBtn.onclick = () => {
          const randomColor = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
          this.legendState.colors.push(randomColor);
          this.showGraphSettingsDialog();
        };
        colorListContainer.appendChild(addColorBtn);
      }
    }

    // OKボタン
    const okBtn = document.getElementById('graphSettingsOk');
    if (okBtn) {
      okBtn.onclick = () => {
        // フォントサイズ適用
        if (fontSizeSlider) {
          this.legendState.fontSize = parseInt(fontSizeSlider.value, 10);
          this.legendState.titleFontSize = Math.max(8, this.legendState.fontSize - 1);
        }
        // 線の太さ適用
        if (lineWidthSlider) {
          this.graphSettings.lineWidth = parseInt(lineWidthSlider.value, 10);
        }
        // レイアウト方向
        if (directionHorizontal && directionHorizontal.checked) {
          this.legendState.direction = 'horizontal';
        } else {
          this.legendState.direction = 'vertical';
        }
        // 最大幅
        if (maxWidthSlider) {
          this.legendState.maxWidth = parseInt(maxWidthSlider.value, 10);
        }
        // 色適用
        const colorInputs = colorListContainer?.querySelectorAll('input[type="color"]');
        if (colorInputs) {
          colorInputs.forEach((input) => {
            const idx = parseInt(input.dataset.colorIndex, 10);
            if (!isNaN(idx)) {
              // 色配列を必要に応じて拡張
              while (this.legendState.colors.length <= idx) {
                this.legendState.colors.push('#888888');
              }
              this.legendState.colors[idx] = input.value;
            }
          });
        }

        // 凡例位置をリセット（レイアウト変更時に再配置）
        this.legendState.x = null;
        this.legendState.y = null;

        // グラフ再描画
        this.drawScatterPlot();
        dlg.style.display = 'none';
      };
    }

    // キャンセルボタン
    const cancelBtn = document.getElementById('graphSettingsCancel');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * フォースプレート設定ダイアログ表示
   */
  showForcePlateDialog() {
    const dlg = document.getElementById('forcePlateDialog');
    if (!dlg) return;

    // 現在の設定を反映
    const enabledCheckbox = document.getElementById('forcePlateEnabled');
    const vectorEnabledCheckbox = document.getElementById('forceVectorEnabled');
    const colorInput = document.getElementById('forceVectorColorInput');
    const scaleInput = document.getElementById('forceVectorScaleInput');
    const opacitySlider = document.getElementById('forcePlateOpacity');
    const opacityValue = document.getElementById('forcePlateOpacityValue');
    const forcePlateInfo = document.getElementById('forcePlateInfo');
    const forcePlateList = document.getElementById('forcePlateList');

    if (enabledCheckbox) enabledCheckbox.checked = this.forcePlateEnabled;
    if (vectorEnabledCheckbox) vectorEnabledCheckbox.checked = this.forcePlateEnabled;
    if (scaleInput) scaleInput.value = this.forceVectorScale;
    if (colorInput) colorInput.value = '#' + this.forceVectorColor.toString(16).padStart(6, '0');
    if (opacitySlider) {
      opacitySlider.value = this.forcePlateOpacity;
      if (opacityValue) opacityValue.textContent = this.forcePlateOpacity.toFixed(1);
    }

    // スライダーのイベント
    if (opacitySlider && opacityValue) {
      opacitySlider.oninput = () => {
        opacityValue.textContent = parseFloat(opacitySlider.value).toFixed(1);
      };
    }

    // フォースプレート情報を表示
    if (this.forcePlateData && this.forcePlateData.length > 0) {
      if (forcePlateInfo) forcePlateInfo.style.display = 'block';
      if (forcePlateList) {
        forcePlateList.innerHTML = this.forcePlateData.map((plate, i) => {
          const typeNames = { 1: 'Type 1', 2: 'Type 2 (Fx,Fy,Fz,Mx,My,Mz)', 3: 'Type 3', 4: 'Type 4' };
          return `<div>プレート ${i + 1}: ${typeNames[plate.type] || 'Type ' + plate.type}</div>`;
        }).join('');
      }
    } else {
      if (forcePlateInfo) forcePlateInfo.style.display = 'none';
    }

    // OKボタン
    const okBtn = document.getElementById('forcePlateOk');
    if (okBtn) {
      okBtn.onclick = () => {
        // 設定を適用
        this.forcePlateEnabled = enabledCheckbox ? enabledCheckbox.checked : true;

        if (scaleInput) {
          const scaleVal = parseFloat(scaleInput.value);
          if (!isNaN(scaleVal) && scaleVal > 0) {
            this.forceVectorScale = scaleVal;
          }
        }

        if (colorInput) {
          this.forceVectorColor = parseInt(colorInput.value.replace('#', ''), 16);
          // 既存のベクトルの色を更新
          for (const arrow of this.forceVectorObjects) {
            if (arrow.setColor) arrow.setColor(this.forceVectorColor);
          }
        }

        if (opacitySlider) {
          this.forcePlateOpacity = parseFloat(opacitySlider.value);
          // 既存のプレートの透明度を更新
          for (const obj of this.forcePlateObjects) {
            if (obj.material && obj.material.opacity !== undefined) {
              obj.material.opacity = this.forcePlateOpacity;
            }
          }
        }

        // 表示を更新
        this.toggleForcePlateVisibility(this.forcePlateEnabled);

        dlg.style.display = 'none';
      };
    }

    // キャンセルボタン
    const cancelBtn = document.getElementById('forcePlateCancel');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * 逆動力学ダイアログ表示
   */
  showInverseDynamicsDialog() {
    console.log('[InverseDynamics] showInverseDynamicsDialog called');
    const dlg = document.getElementById('inverseDynamicsDialog');
    if (!dlg) {
      console.error('[InverseDynamics] Dialog element not found');
      return;
    }

    // モーションデータのチェック
    if (!this.motionData || !this.motionData.frames) {
      console.warn('[InverseDynamics] No motion data');
      alert('モーションデータを先に読み込んでください。');
      return;
    }
    console.log('[InverseDynamics] Motion data OK, forcePlateData:', this.forcePlateData);

    // フォースプレートの状態を表示
    const fpStatus = document.getElementById('idForcePlateStatus');
    if (fpStatus) {
      if (this.forcePlateData && this.forcePlateData.length > 0) {
        fpStatus.innerHTML = `<span style="color: green;">✓ ${this.forcePlateData.length}枚のフォースプレートを検出</span>`;
      } else {
        fpStatus.innerHTML = `<span style="color: orange;">⚠ フォースプレートデータなし（力=0で計算）</span>`;
      }
    }

    // ポイントマッピングはセグメント定義から自動取得（ダイアログでの設定は不要）

    // OKボタン
    const okBtn = document.getElementById('inverseDynamicsOk');
    if (okBtn) {
      okBtn.onclick = () => {
        const bodyMass = parseFloat(document.getElementById('idBodyMass').value) || 70;
        const sex = document.getElementById('idSexMale').checked ? 'male' : 'female';
        const filterCutoff = parseFloat(document.getElementById('idFilterCutoff').value) || 6;

        // ポイントマッピングを取得
        const pointMapping = this._getInverseDynamicsPointMapping();

        dlg.style.display = 'none';

        // 逆動力学計算を実行（両脚）
        this.calculateInverseDynamics({
          bodyMass,
          sex,
          filterCutoff,
          pointMapping
        });
      };
    }

    // キャンセルボタン
    const cancelBtn = document.getElementById('inverseDynamicsCancel');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
    console.log('[InverseDynamics] Dialog displayed');
  }

  /**
   * ライン設定からセグメントタイプに基づいてポイントマッピングを取得
   */
  _getPointMappingFromLineSettings() {
    const mapping = {
      rightHip: -1, rightKnee: -1, rightAnkle: -1, rightToe: -1, rightHeel: -1,
      leftHip: -1, leftKnee: -1, leftAnkle: -1, leftToe: -1, leftHeel: -1
    };
    const pointNames = this.currentPointNames || [];

    // セグメントタイプからポイントマッピングを構築
    // name1 = 近位端（proximal）, name2 = 遠位端（distal）
    // 例: rightThigh -> name1=hip, name2=knee
    this.lineSettings.forEach(setting => {
      if (!setting.segmentType || setting.segmentType === 'none') return;

      const p1Idx = pointNames.indexOf(setting.name1);
      const p2Idx = pointNames.indexOf(setting.name2);

      switch (setting.segmentType) {
        case 'rightThigh':
          if (p1Idx >= 0) mapping.rightHip = p1Idx;
          if (p2Idx >= 0) mapping.rightKnee = p2Idx;
          break;
        case 'leftThigh':
          if (p1Idx >= 0) mapping.leftHip = p1Idx;
          if (p2Idx >= 0) mapping.leftKnee = p2Idx;
          break;
        case 'rightShank':
          if (p1Idx >= 0) mapping.rightKnee = p1Idx;
          if (p2Idx >= 0) mapping.rightAnkle = p2Idx;
          break;
        case 'leftShank':
          if (p1Idx >= 0) mapping.leftKnee = p1Idx;
          if (p2Idx >= 0) mapping.leftAnkle = p2Idx;
          break;
        case 'rightFoot':
          if (p1Idx >= 0) mapping.rightAnkle = p1Idx;
          if (p2Idx >= 0) mapping.rightToe = p2Idx;
          break;
        case 'leftFoot':
          if (p1Idx >= 0) mapping.leftAnkle = p1Idx;
          if (p2Idx >= 0) mapping.leftToe = p2Idx;
          break;
        case 'rightHeel':
          // 踵セグメント: name1=足首, name2=踵
          if (p1Idx >= 0) mapping.rightAnkle = p1Idx;
          if (p2Idx >= 0) mapping.rightHeel = p2Idx;
          break;
        case 'leftHeel':
          if (p1Idx >= 0) mapping.leftAnkle = p1Idx;
          if (p2Idx >= 0) mapping.leftHeel = p2Idx;
          break;
      }
    });

    return mapping;
  }

  /**
   * セグメント定義ダイアログを表示
   */
  showSegmentDefinitionDialog() {
    const dlg = document.getElementById('segmentDefinitionDialog');
    if (!dlg) {
      console.error('[SegmentDef] Dialog element not found');
      return;
    }

    const pointNames = this.currentPointNames || [];
    if (pointNames.length === 0 && !this.motionData) {
      alert('モーションデータを先に読み込んでください。');
      return;
    }

    // ポイント選択セレクトを設定
    this._populateSegmentDefinitionSelects();

    // 現在のセグメント定義を復元
    this._restoreSegmentDefinitions();

    // 折りたたみセクションのイベント設定
    const upperBodyToggle = document.getElementById('segDefUpperBodyToggle');
    const upperBodyContent = document.getElementById('segDefUpperBodyContent');
    if (upperBodyToggle && upperBodyContent) {
      upperBodyToggle.onclick = () => {
        const isHidden = upperBodyContent.style.display === 'none';
        upperBodyContent.style.display = isHidden ? 'grid' : 'none';
        const icon = upperBodyToggle.querySelector('.collapse-icon');
        if (icon) icon.classList.toggle('expanded', isHidden);
      };
    }

    const trunkToggle = document.getElementById('segDefTrunkToggle');
    const trunkContent = document.getElementById('segDefTrunkContent');
    if (trunkToggle && trunkContent) {
      trunkToggle.onclick = () => {
        const isHidden = trunkContent.style.display === 'none';
        trunkContent.style.display = isHidden ? 'grid' : 'none';
        const icon = trunkToggle.querySelector('.collapse-icon');
        if (icon) icon.classList.toggle('expanded', isHidden);
      };
    }

    // テンプレート適用ボタン
    const applyTemplateBtn = document.getElementById('segmentDefApplyTemplate');
    if (applyTemplateBtn) {
      applyTemplateBtn.onclick = () => {
        const template = document.getElementById('segmentDefTemplate').value;
        this._applySegmentDefinitionTemplate(template);
      };
    }

    // OKボタン
    const okBtn = document.getElementById('segmentDefOk');
    if (okBtn) {
      okBtn.onclick = () => {
        this._saveSegmentDefinitions();
        const syncToLineSettings = document.getElementById('segDefSyncToLineSettings').checked;
        if (syncToLineSettings) {
          this._syncSegmentDefinitionsToLineSettings();
        }
        dlg.style.display = 'none';
      };
    }

    // キャンセルボタン
    const cancelBtn = document.getElementById('segmentDefCancel');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * セグメント定義のポイント選択セレクトを設定
   */
  _populateSegmentDefinitionSelects() {
    const pointNames = this.currentPointNames || [];
    const selects = [
      'segDefRightThighProx', 'segDefRightThighDist',
      'segDefRightShankProx', 'segDefRightShankDist',
      'segDefRightFootProx', 'segDefRightFootDist',
      'segDefRightHeelProx', 'segDefRightHeelDist',
      'segDefLeftThighProx', 'segDefLeftThighDist',
      'segDefLeftShankProx', 'segDefLeftShankDist',
      'segDefLeftFootProx', 'segDefLeftFootDist',
      'segDefLeftHeelProx', 'segDefLeftHeelDist',
      'segDefRightUpperArmProx', 'segDefRightUpperArmDist',
      'segDefRightForearmProx', 'segDefRightForearmDist',
      'segDefLeftUpperArmProx', 'segDefLeftUpperArmDist',
      'segDefLeftForearmProx', 'segDefLeftForearmDist',
      'segDefTrunkProx', 'segDefTrunkDist',
      'segDefPelvisProx', 'segDefPelvisDist'
    ];

    for (const selectId of selects) {
      const select = document.getElementById(selectId);
      if (!select) continue;

      select.innerHTML = '<option value="-1">-- 選択 --</option>';
      pointNames.forEach((name, idx) => {
        const option = document.createElement('option');
        option.value = idx;
        option.textContent = `${idx}: ${name || 'Point' + idx}`;
        select.appendChild(option);
      });
    }
  }

  /**
   * セグメント定義を復元
   */
  _restoreSegmentDefinitions() {
    if (!this.segmentDefinitions) {
      // ライン設定から初期値を取得
      const mapping = this._getPointMappingFromLineSettings();
      this._setSegmentSelectValue('segDefRightThighProx', mapping.rightHip);
      this._setSegmentSelectValue('segDefRightThighDist', mapping.rightKnee);
      this._setSegmentSelectValue('segDefRightShankProx', mapping.rightKnee);
      this._setSegmentSelectValue('segDefRightShankDist', mapping.rightAnkle);
      this._setSegmentSelectValue('segDefRightFootProx', mapping.rightAnkle);
      this._setSegmentSelectValue('segDefRightFootDist', mapping.rightToe);
      this._setSegmentSelectValue('segDefRightHeelProx', mapping.rightAnkle);
      this._setSegmentSelectValue('segDefRightHeelDist', mapping.rightHeel);
      this._setSegmentSelectValue('segDefLeftThighProx', mapping.leftHip);
      this._setSegmentSelectValue('segDefLeftThighDist', mapping.leftKnee);
      this._setSegmentSelectValue('segDefLeftShankProx', mapping.leftKnee);
      this._setSegmentSelectValue('segDefLeftShankDist', mapping.leftAnkle);
      this._setSegmentSelectValue('segDefLeftFootProx', mapping.leftAnkle);
      this._setSegmentSelectValue('segDefLeftFootDist', mapping.leftToe);
      this._setSegmentSelectValue('segDefLeftHeelProx', mapping.leftAnkle);
      this._setSegmentSelectValue('segDefLeftHeelDist', mapping.leftHeel);
      return;
    }

    // 保存されたセグメント定義を復元
    for (const [key, value] of Object.entries(this.segmentDefinitions)) {
      this._setSegmentSelectValue(key, value);
    }
  }

  _setSegmentSelectValue(selectId, value) {
    const select = document.getElementById(selectId);
    if (select && value !== undefined && value >= -1) {
      select.value = value;
    }
  }

  /**
   * セグメント定義を保存
   */
  _saveSegmentDefinitions() {
    const getValue = (id) => {
      const select = document.getElementById(id);
      return select ? parseInt(select.value, 10) : -1;
    };

    this.segmentDefinitions = {
      // 右脚
      segDefRightThighProx: getValue('segDefRightThighProx'),
      segDefRightThighDist: getValue('segDefRightThighDist'),
      segDefRightShankProx: getValue('segDefRightShankProx'),
      segDefRightShankDist: getValue('segDefRightShankDist'),
      segDefRightFootProx: getValue('segDefRightFootProx'),
      segDefRightFootDist: getValue('segDefRightFootDist'),
      segDefRightHeelProx: getValue('segDefRightHeelProx'),
      segDefRightHeelDist: getValue('segDefRightHeelDist'),
      // 左脚
      segDefLeftThighProx: getValue('segDefLeftThighProx'),
      segDefLeftThighDist: getValue('segDefLeftThighDist'),
      segDefLeftShankProx: getValue('segDefLeftShankProx'),
      segDefLeftShankDist: getValue('segDefLeftShankDist'),
      segDefLeftFootProx: getValue('segDefLeftFootProx'),
      segDefLeftFootDist: getValue('segDefLeftFootDist'),
      segDefLeftHeelProx: getValue('segDefLeftHeelProx'),
      segDefLeftHeelDist: getValue('segDefLeftHeelDist'),
      // 上肢
      segDefRightUpperArmProx: getValue('segDefRightUpperArmProx'),
      segDefRightUpperArmDist: getValue('segDefRightUpperArmDist'),
      segDefRightForearmProx: getValue('segDefRightForearmProx'),
      segDefRightForearmDist: getValue('segDefRightForearmDist'),
      segDefLeftUpperArmProx: getValue('segDefLeftUpperArmProx'),
      segDefLeftUpperArmDist: getValue('segDefLeftUpperArmDist'),
      segDefLeftForearmProx: getValue('segDefLeftForearmProx'),
      segDefLeftForearmDist: getValue('segDefLeftForearmDist'),
      // 体幹
      segDefTrunkProx: getValue('segDefTrunkProx'),
      segDefTrunkDist: getValue('segDefTrunkDist'),
      segDefPelvisProx: getValue('segDefPelvisProx'),
      segDefPelvisDist: getValue('segDefPelvisDist')
    };

    console.log('[SegmentDef] 保存:', this.segmentDefinitions);
  }

  /**
   * セグメント定義をライン設定に同期
   */
  _syncSegmentDefinitionsToLineSettings() {
    const pointNames = this.currentPointNames || [];
    const getName = (idx) => idx >= 0 && idx < pointNames.length ? pointNames[idx] : '';

    // セグメントタイプとセレクトIDのマッピング
    const segmentMap = [
      // 下肢
      { type: 'rightThigh', proxId: 'segDefRightThighProx', distId: 'segDefRightThighDist' },
      { type: 'rightShank', proxId: 'segDefRightShankProx', distId: 'segDefRightShankDist' },
      { type: 'rightFoot', proxId: 'segDefRightFootProx', distId: 'segDefRightFootDist' },
      { type: 'rightHeel', proxId: 'segDefRightHeelProx', distId: 'segDefRightHeelDist' },
      { type: 'leftThigh', proxId: 'segDefLeftThighProx', distId: 'segDefLeftThighDist' },
      { type: 'leftShank', proxId: 'segDefLeftShankProx', distId: 'segDefLeftShankDist' },
      { type: 'leftFoot', proxId: 'segDefLeftFootProx', distId: 'segDefLeftFootDist' },
      { type: 'leftHeel', proxId: 'segDefLeftHeelProx', distId: 'segDefLeftHeelDist' },
      // 上肢
      { type: 'rightUpperArm', proxId: 'segDefRightUpperArmProx', distId: 'segDefRightUpperArmDist' },
      { type: 'rightForearm', proxId: 'segDefRightForearmProx', distId: 'segDefRightForearmDist' },
      { type: 'leftUpperArm', proxId: 'segDefLeftUpperArmProx', distId: 'segDefLeftUpperArmDist' },
      { type: 'leftForearm', proxId: 'segDefLeftForearmProx', distId: 'segDefLeftForearmDist' },
      // 体幹
      { type: 'trunk', proxId: 'segDefTrunkProx', distId: 'segDefTrunkDist' },
      { type: 'pelvis', proxId: 'segDefPelvisProx', distId: 'segDefPelvisDist' }
    ];

    for (const seg of segmentMap) {
      const proxIdx = this.segmentDefinitions[seg.proxId];
      const distIdx = this.segmentDefinitions[seg.distId];
      if (proxIdx < 0 || distIdx < 0) continue;

      const proxName = getName(proxIdx);
      const distName = getName(distIdx);
      if (!proxName || !distName) continue;

      // 既存のライン設定を検索
      let found = false;
      for (const setting of this.lineSettings) {
        if (setting.segmentType === seg.type) {
          setting.name1 = proxName;
          setting.name2 = distName;
          found = true;
          break;
        }
      }

      // 見つからない場合は新規追加
      if (!found) {
        this.lineSettings.push({
          name1: proxName,
          name2: distName,
          color: this.currentLineColor || 0x0000ff,
          width: this.currentLineWidth || 10,
          style: 'solid',
          visible: true,
          trajectoryVisible: false,
          trajectoryOpacity: 0.7,
          trajectoryLength: 50,
          segmentType: seg.type
        });
      }
    }

    console.log('[SegmentDef] ライン設定に同期完了');

    // ライン設定がある場合はスティックピクチャーを有効化
    if (this.lineSettings.length > 0 && !this.currentStickType) {
      // ポイント数に基づいてスティックタイプを設定
      const pointCount = this.currentPointNames.length;
      this.currentStickType = pointCount >= 25 ? 25 : (pointCount >= 23 ? 23 : 'custom');
      console.log(`[SegmentDef] currentStickType を ${this.currentStickType} に設定`);
    }

    // スティックピクチャーを再描画
    if (this.motionData && this.motionData.frames) {
      this.drawStickPicture(this.motionData.frames[this.currentFrame]);
    }
  }

  /**
   * セグメント定義テンプレートを適用
   */
  _applySegmentDefinitionTemplate(template) {
    const pointNames = this.currentPointNames || [];

    // テンプレート定義
    // HPE 23/25点モデルのインデックス:
    // 0:鼻, 1:左目内, 2:左目, 3:左目外, 4:右目内, 5:右目, 6:右目外, 7:左耳, 8:右耳
    // 9:左肩, 10:右肩, 11:左肘, 12:右肘, 13:左手首, 14:右手首
    // 15:左股関節, 16:右股関節, 17:左膝, 18:右膝, 19:左足首, 20:右足首
    // 21:左つま先, 22:右つま先 (23点まで)
    // ※実際の骨格定義と異なる可能性があるため、skeleton23/25を参照
    // bodyPointNames23基準:
    // 0:右手先, 1:右手首, 2:右肘, 3:右肩, 4:左手先, 5:左手首, 6:左肘, 7:左肩
    // 8:右つま先, 9:右母指球, 10:右かかと, 11:右足首, 12:右膝, 13:右大転子
    // 14:左つま先, 15:左母指球, 16:左かかと, 17:左足首, 18:左膝, 19:左大転子
    // 20:頭頂, 21:耳珠点, 22:胸骨上縁, (23:右肋骨下端, 24:左肋骨下端 - 25点のみ)
    const templates = {
      hpe23: {
        // HPE 23点モデル（bodyPointNames23基準）
        // 下肢
        rightThigh: { prox: 13, dist: 12 },   // 右大転子(13)→右膝(12)
        rightShank: { prox: 12, dist: 11 },   // 右膝(12)→右足首(11)
        rightFoot: { prox: 11, dist: 8 },     // 右足首(11)→右つま先(8)
        rightHeel: { prox: 11, dist: 10 },    // 右足首(11)→右かかと(10)
        leftThigh: { prox: 19, dist: 18 },    // 左大転子(19)→左膝(18)
        leftShank: { prox: 18, dist: 17 },    // 左膝(18)→左足首(17)
        leftFoot: { prox: 17, dist: 14 },     // 左足首(17)→左つま先(14)
        leftHeel: { prox: 17, dist: 16 },     // 左足首(17)→左かかと(16)
        // 上肢
        rightUpperArm: { prox: 3, dist: 2 },  // 右肩(3)→右肘(2)
        rightForearm: { prox: 2, dist: 1 },   // 右肘(2)→右手首(1)
        leftUpperArm: { prox: 7, dist: 6 },   // 左肩(7)→左肘(6)
        leftForearm: { prox: 6, dist: 5 },    // 左肘(6)→左手首(5)
        // 体幹
        trunk: { prox: 22, dist: 13 },        // 胸骨上縁(22)→右大転子(13)
        pelvis: { prox: 13, dist: 19 }        // 右大転子(13)→左大転子(19)
      },
      hpe25: {
        // HPE 25点モデル（bodyPointNames25基準）
        // 下肢
        rightThigh: { prox: 13, dist: 12 },   // 右大転子(13)→右膝(12)
        rightShank: { prox: 12, dist: 11 },   // 右膝(12)→右足首(11)
        rightFoot: { prox: 11, dist: 8 },     // 右足首(11)→右つま先(8)
        rightHeel: { prox: 11, dist: 10 },    // 右足首(11)→右かかと(10)
        leftThigh: { prox: 19, dist: 18 },    // 左大転子(19)→左膝(18)
        leftShank: { prox: 18, dist: 17 },    // 左膝(18)→左足首(17)
        leftFoot: { prox: 17, dist: 14 },     // 左足首(17)→左つま先(14)
        leftHeel: { prox: 17, dist: 16 },     // 左足首(17)→左かかと(16)
        // 上肢
        rightUpperArm: { prox: 3, dist: 2 },  // 右肩(3)→右肘(2)
        rightForearm: { prox: 2, dist: 1 },   // 右肘(2)→右手首(1)
        leftUpperArm: { prox: 7, dist: 6 },   // 左肩(7)→左肘(6)
        leftForearm: { prox: 6, dist: 5 },    // 左肘(6)→左手首(5)
        // 体幹
        trunk: { prox: 22, dist: 13 },        // 胸骨上縁(22)→右大転子(13)
        pelvis: { prox: 13, dist: 19 }        // 右大転子(13)→左大転子(19)
      },
      plugingait: {
        // マーカー名で検索
        // 下肢
        rightThigh: { proxMarker: ['RASI', 'RHIP'], distMarker: ['RKNE', 'RKnee'] },
        rightShank: { proxMarker: ['RKNE', 'RKnee'], distMarker: ['RANK', 'RAnkle'] },
        rightFoot: { proxMarker: ['RANK', 'RAnkle'], distMarker: ['RTOE'] },
        rightHeel: { proxMarker: ['RANK', 'RAnkle'], distMarker: ['RHEE', 'RHeel'] },
        leftThigh: { proxMarker: ['LASI', 'LHIP'], distMarker: ['LKNE', 'LKnee'] },
        leftShank: { proxMarker: ['LKNE', 'LKnee'], distMarker: ['LANK', 'LAnkle'] },
        leftFoot: { proxMarker: ['LANK', 'LAnkle'], distMarker: ['LTOE'] },
        leftHeel: { proxMarker: ['LANK', 'LAnkle'], distMarker: ['LHEE', 'LHeel'] },
        // 上肢
        rightUpperArm: { proxMarker: ['RSHO', 'RShoulder'], distMarker: ['RELB', 'RElbow'] },
        rightForearm: { proxMarker: ['RELB', 'RElbow'], distMarker: ['RWRA', 'RWrist'] },
        leftUpperArm: { proxMarker: ['LSHO', 'LShoulder'], distMarker: ['LELB', 'LElbow'] },
        leftForearm: { proxMarker: ['LELB', 'LElbow'], distMarker: ['LWRA', 'LWrist'] },
        // 体幹
        trunk: { proxMarker: ['C7', 'T10', 'STRN'], distMarker: ['SACR', 'LPSI', 'RPSI'] },
        pelvis: { proxMarker: ['RASI', 'RPSI'], distMarker: ['LASI', 'LPSI'] }
      }
    };

    // C3D自動検出
    if (template === 'c3d_auto') {
      this._applySegmentDefinitionTemplate('plugingait');
      return;
    }

    const tpl = templates[template];
    if (!tpl) return;

    const findMarkerIndex = (markers) => {
      for (const marker of markers) {
        const idx = pointNames.findIndex(n => n && n.toUpperCase() === marker.toUpperCase());
        if (idx >= 0) return idx;
      }
      return -1;
    };

    // セグメントIDマッピング
    const segmentIds = {
      // 下肢
      rightThigh: ['segDefRightThighProx', 'segDefRightThighDist'],
      rightShank: ['segDefRightShankProx', 'segDefRightShankDist'],
      rightFoot: ['segDefRightFootProx', 'segDefRightFootDist'],
      rightHeel: ['segDefRightHeelProx', 'segDefRightHeelDist'],
      leftThigh: ['segDefLeftThighProx', 'segDefLeftThighDist'],
      leftShank: ['segDefLeftShankProx', 'segDefLeftShankDist'],
      leftFoot: ['segDefLeftFootProx', 'segDefLeftFootDist'],
      leftHeel: ['segDefLeftHeelProx', 'segDefLeftHeelDist'],
      // 上肢
      rightUpperArm: ['segDefRightUpperArmProx', 'segDefRightUpperArmDist'],
      rightForearm: ['segDefRightForearmProx', 'segDefRightForearmDist'],
      leftUpperArm: ['segDefLeftUpperArmProx', 'segDefLeftUpperArmDist'],
      leftForearm: ['segDefLeftForearmProx', 'segDefLeftForearmDist'],
      // 体幹
      trunk: ['segDefTrunkProx', 'segDefTrunkDist'],
      pelvis: ['segDefPelvisProx', 'segDefPelvisDist']
    };

    for (const [segName, def] of Object.entries(tpl)) {
      const ids = segmentIds[segName];
      if (!ids) continue;

      let proxIdx, distIdx;
      if (def.prox !== undefined) {
        proxIdx = def.prox;
        distIdx = def.dist;
      } else if (def.proxMarker) {
        proxIdx = findMarkerIndex(def.proxMarker);
        distIdx = findMarkerIndex(def.distMarker);
      }

      if (proxIdx !== undefined && proxIdx >= 0) {
        this._setSegmentSelectValue(ids[0], proxIdx);
      }
      if (distIdx !== undefined && distIdx >= 0) {
        this._setSegmentSelectValue(ids[1], distIdx);
      }
    }

    console.log(`[SegmentDef] テンプレート "${template}" を適用`);
  }

  /**
   * セグメント定義を取得（他の機能から使用）
   */
  getSegmentDefinitions() {
    if (!this.segmentDefinitions) {
      // ライン設定から取得
      const mapping = this._getPointMappingFromLineSettings();
      return {
        rightThigh: { prox: mapping.rightHip, dist: mapping.rightKnee },
        rightShank: { prox: mapping.rightKnee, dist: mapping.rightAnkle },
        rightFoot: { prox: mapping.rightAnkle, dist: mapping.rightToe },
        rightHeel: { prox: mapping.rightAnkle, dist: mapping.rightHeel },
        leftThigh: { prox: mapping.leftHip, dist: mapping.leftKnee },
        leftShank: { prox: mapping.leftKnee, dist: mapping.leftAnkle },
        leftFoot: { prox: mapping.leftAnkle, dist: mapping.leftToe },
        leftHeel: { prox: mapping.leftAnkle, dist: mapping.leftHeel }
      };
    }

    return {
      rightThigh: { prox: this.segmentDefinitions.segDefRightThighProx, dist: this.segmentDefinitions.segDefRightThighDist },
      rightShank: { prox: this.segmentDefinitions.segDefRightShankProx, dist: this.segmentDefinitions.segDefRightShankDist },
      rightFoot: { prox: this.segmentDefinitions.segDefRightFootProx, dist: this.segmentDefinitions.segDefRightFootDist },
      rightHeel: { prox: this.segmentDefinitions.segDefRightHeelProx, dist: this.segmentDefinitions.segDefRightHeelDist },
      leftThigh: { prox: this.segmentDefinitions.segDefLeftThighProx, dist: this.segmentDefinitions.segDefLeftThighDist },
      leftShank: { prox: this.segmentDefinitions.segDefLeftShankProx, dist: this.segmentDefinitions.segDefLeftShankDist },
      leftFoot: { prox: this.segmentDefinitions.segDefLeftFootProx, dist: this.segmentDefinitions.segDefLeftFootDist },
      leftHeel: { prox: this.segmentDefinitions.segDefLeftHeelProx, dist: this.segmentDefinitions.segDefLeftHeelDist }
    };
  }

  /**
   * ポイントマッピングをセグメント定義から取得
   */
  _getInverseDynamicsPointMapping() {
    const segDefs = this.getSegmentDefinitions();
    return {
      rightHip: segDefs.rightThigh?.prox ?? -1,
      rightKnee: segDefs.rightThigh?.dist ?? -1,
      rightAnkle: segDefs.rightShank?.dist ?? -1,
      rightToe: segDefs.rightFoot?.dist ?? -1,
      rightHeel: segDefs.rightHeel?.dist ?? -1,
      leftHip: segDefs.leftThigh?.prox ?? -1,
      leftKnee: segDefs.leftThigh?.dist ?? -1,
      leftAnkle: segDefs.leftShank?.dist ?? -1,
      leftToe: segDefs.leftFoot?.dist ?? -1,
      leftHeel: segDefs.leftHeel?.dist ?? -1
    };
  }

  /**
   * 逆動力学計算を実行（両脚）
   */
  calculateInverseDynamics(settings) {
    try {
      const pm = settings.pointMapping;
      const results = { right: null, left: null };
      const calculatedSides = [];

      // 地面反力データを準備
      const forceData = {
        plates: this.forcePlateData || []
      };

      // motionDataにpointLabelsを追加（C3Dマーカー名解決用）
      const motionDataWithLabels = {
        ...this.motionData,
        pointLabels: this.currentPointNames || []
      };

      // 右脚の計算
      const rightPoints = [pm.rightHip, pm.rightKnee, pm.rightAnkle, pm.rightToe, pm.rightHeel];
      if (rightPoints.every(idx => idx >= 0)) {
        const idRight = new InverseDynamics({
          bodyMass: settings.bodyMass,
          sex: settings.sex,
          pointMapping: settings.pointMapping
        });
        results.right = idRight.calculate(motionDataWithLabels, forceData, {
          filterCutoff: settings.filterCutoff,
          side: 'right'
        });
        calculatedSides.push('右脚');
      }

      // 左脚の計算
      const leftPoints = [pm.leftHip, pm.leftKnee, pm.leftAnkle, pm.leftToe, pm.leftHeel];
      if (leftPoints.every(idx => idx >= 0)) {
        const idLeft = new InverseDynamics({
          bodyMass: settings.bodyMass,
          sex: settings.sex,
          pointMapping: settings.pointMapping
        });
        results.left = idLeft.calculate(motionDataWithLabels, forceData, {
          filterCutoff: settings.filterCutoff,
          side: 'left'
        });
        calculatedSides.push('左脚');
      }

      if (calculatedSides.length === 0) {
        alert('必要なセグメントが定義されていません。\n「設定」→「セグメント定義」で下肢のセグメントを設定してください。');
        return;
      }

      // 結果を保存（両脚分）
      this.inverseDynamicsResults = results;
      this.invalidateGraphCache();  // グラフキャッシュ無効化

      // 結果ダイアログを表示
      this.showInverseDynamicsResultsBilateral(results, settings, calculatedSides);

    } catch (error) {
      console.error('逆動力学計算エラー:', error);
      alert('逆動力学の計算中にエラーが発生しました:\n' + error.message);
    }
  }

  /**
   * 逆動力学結果を表示
   */
  showInverseDynamicsResults(id, settings) {
    const dlg = document.getElementById('inverseDynamicsResultDialog');
    const content = document.getElementById('idResultContent');
    if (!dlg || !content) return;

    // サマリー統計を取得
    const summary = id.getSummary();
    const normalized = id.normalizeByBodyWeight();

    // 結果HTMLを生成
    let html = `
      <div style="margin-bottom: 16px;">
        <h4 style="margin: 0 0 8px 0;">計算条件</h4>
        <table style="font-size: 13px; border-collapse: collapse;">
          <tr><td style="padding: 2px 8px;">体重:</td><td>${settings.bodyMass} kg</td></tr>
          <tr><td style="padding: 2px 8px;">性別:</td><td>${settings.sex === 'male' ? '男性' : '女性'}</td></tr>
          <tr><td style="padding: 2px 8px;">解析脚:</td><td>${settings.side === 'right' ? '右脚' : '左脚'}</td></tr>
          <tr><td style="padding: 2px 8px;">フィルタ:</td><td>${settings.filterCutoff} Hz</td></tr>
        </table>
      </div>

      <div style="margin-bottom: 16px;">
        <h4 style="margin: 0 0 8px 0;">関節モーメント [Nm]</h4>
        <table style="font-size: 13px; border-collapse: collapse; width: 100%;">
          <tr style="background: #f0f0f0;">
            <th style="padding: 4px 8px; text-align: left;">関節</th>
            <th style="padding: 4px 8px; text-align: right;">最小</th>
            <th style="padding: 4px 8px; text-align: right;">最大</th>
            <th style="padding: 4px 8px; text-align: right;">平均</th>
          </tr>
          <tr>
            <td style="padding: 4px 8px;">足関節</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.ankle.moment.min.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.ankle.moment.max.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.ankle.moment.mean.toFixed(1)}</td>
          </tr>
          <tr style="background: #fafafa;">
            <td style="padding: 4px 8px;">膝関節</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.knee.moment.min.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.knee.moment.max.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.knee.moment.mean.toFixed(1)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 8px;">股関節</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.hip.moment.min.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.hip.moment.max.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.hip.moment.mean.toFixed(1)}</td>
          </tr>
        </table>
      </div>

      <div style="margin-bottom: 16px;">
        <h4 style="margin: 0 0 8px 0;">関節パワー [W]</h4>
        <table style="font-size: 13px; border-collapse: collapse; width: 100%;">
          <tr style="background: #f0f0f0;">
            <th style="padding: 4px 8px; text-align: left;">関節</th>
            <th style="padding: 4px 8px; text-align: right;">最小</th>
            <th style="padding: 4px 8px; text-align: right;">最大</th>
            <th style="padding: 4px 8px; text-align: right;">平均</th>
          </tr>
          <tr>
            <td style="padding: 4px 8px;">足関節</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.ankle.power.min.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.ankle.power.max.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.ankle.power.mean.toFixed(1)}</td>
          </tr>
          <tr style="background: #fafafa;">
            <td style="padding: 4px 8px;">膝関節</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.knee.power.min.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.knee.power.max.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.knee.power.mean.toFixed(1)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 8px;">股関節</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.hip.power.min.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.hip.power.max.toFixed(1)}</td>
            <td style="padding: 4px 8px; text-align: right;">${summary.hip.power.mean.toFixed(1)}</td>
          </tr>
        </table>
      </div>

      <div>
        <h4 style="margin: 0 0 8px 0;">正規化値 [Nm/kg, W/kg]</h4>
        <p style="font-size: 12px; color: #666; margin: 0;">
          足関節モーメント: ${(summary.ankle.moment.max / settings.bodyMass).toFixed(2)} Nm/kg<br>
          膝関節モーメント: ${(summary.knee.moment.max / settings.bodyMass).toFixed(2)} Nm/kg<br>
          股関節モーメント: ${(summary.hip.moment.max / settings.bodyMass).toFixed(2)} Nm/kg
        </p>
      </div>
    `;

    content.innerHTML = html;

    // グラフ表示ボタン
    const showGraphBtn = document.getElementById('idResultShowGraph');
    if (showGraphBtn) {
      showGraphBtn.onclick = () => {
        dlg.style.display = 'none';
        this.showInverseDynamicsGraph();
      };
    }

    // 閉じるボタン
    const closeBtn = document.getElementById('idResultClose');
    if (closeBtn) {
      closeBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * 逆動力学結果を表示（両脚）
   */
  showInverseDynamicsResultsBilateral(results, settings, calculatedSides) {
    const dlg = document.getElementById('inverseDynamicsResultDialog');
    const content = document.getElementById('idResultContent');
    if (!dlg || !content) return;

    // 結果HTMLを生成
    let html = `
      <div style="margin-bottom: 16px;">
        <h4 style="margin: 0 0 8px 0;">計算条件</h4>
        <table style="font-size: 13px; border-collapse: collapse;">
          <tr><td style="padding: 2px 8px;">体重:</td><td>${settings.bodyMass} kg</td></tr>
          <tr><td style="padding: 2px 8px;">性別:</td><td>${settings.sex === 'male' ? '男性' : '女性'}</td></tr>
          <tr><td style="padding: 2px 8px;">解析脚:</td><td>${calculatedSides.join('・')}</td></tr>
          <tr><td style="padding: 2px 8px;">フィルタ:</td><td>${settings.filterCutoff} Hz</td></tr>
        </table>
      </div>
    `;

    // 各脚の結果を表示
    const sides = [
      { key: 'right', name: '右脚', data: results.right },
      { key: 'left', name: '左脚', data: results.left }
    ];

    for (const side of sides) {
      if (!side.data) continue;

      const summary = this._calculateInverseDynamicsSummary(side.data);

      html += `
        <div style="margin-bottom: 16px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
          <h4 style="margin: 0 0 8px 0; color: #333;">${side.name}</h4>
          <table style="font-size: 12px; border-collapse: collapse; width: 100%;">
            <tr style="background: #e9ecef;">
              <th style="padding: 4px 6px; text-align: left;">関節</th>
              <th style="padding: 4px 6px; text-align: right;">モーメント最大 [Nm]</th>
              <th style="padding: 4px 6px; text-align: right;">パワー最大 [W]</th>
            </tr>
            <tr>
              <td style="padding: 4px 6px;">足関節</td>
              <td style="padding: 4px 6px; text-align: right;">${summary.ankle.moment.max.toFixed(1)}</td>
              <td style="padding: 4px 6px; text-align: right;">${summary.ankle.power.max.toFixed(1)}</td>
            </tr>
            <tr style="background: #f8f9fa;">
              <td style="padding: 4px 6px;">膝関節</td>
              <td style="padding: 4px 6px; text-align: right;">${summary.knee.moment.max.toFixed(1)}</td>
              <td style="padding: 4px 6px; text-align: right;">${summary.knee.power.max.toFixed(1)}</td>
            </tr>
            <tr>
              <td style="padding: 4px 6px;">股関節</td>
              <td style="padding: 4px 6px; text-align: right;">${summary.hip.moment.max.toFixed(1)}</td>
              <td style="padding: 4px 6px; text-align: right;">${summary.hip.power.max.toFixed(1)}</td>
            </tr>
          </table>
        </div>
      `;
    }

    html += `<p style="font-size: 12px; color: #666;">グラフ表示で詳細を確認できます。</p>`;

    content.innerHTML = html;

    // グラフ表示ボタン
    const showGraphBtn = document.getElementById('idResultShowGraph');
    if (showGraphBtn) {
      showGraphBtn.onclick = () => {
        dlg.style.display = 'none';
        this.showInverseDynamicsGraph();
      };
    }

    // 閉じるボタン
    const closeBtn = document.getElementById('idResultClose');
    if (closeBtn) {
      closeBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * 逆動力学結果のサマリーを計算
   */
  _calculateInverseDynamicsSummary(data) {
    const calcStats = (arr) => {
      if (!arr) return { min: 0, max: 0, mean: 0 };
      const valid = arr.filter(v => v !== null && !isNaN(v) && isFinite(v));
      if (valid.length === 0) return { min: 0, max: 0, mean: 0 };
      return {
        min: Math.min(...valid),
        max: Math.max(...valid),
        mean: valid.reduce((a, b) => a + b, 0) / valid.length
      };
    };

    return {
      ankle: {
        moment: calcStats(data.dynamics?.ankle?.moment),
        power: calcStats(data.power?.ankle)
      },
      knee: {
        moment: calcStats(data.dynamics?.knee?.moment),
        power: calcStats(data.power?.knee)
      },
      hip: {
        moment: calcStats(data.dynamics?.hip?.moment),
        power: calcStats(data.power?.hip)
      }
    };
  }

  /**
   * 逆動力学グラフを表示
   */
  showInverseDynamicsGraph() {
    if (!this.inverseDynamicsResults) {
      alert('先に逆動力学計算を実行してください。');
      return;
    }

    // グラフパネルを表示
    this.showGraphPanel();

    // グラフモードを関節トルクに設定
    const modeSelect = document.getElementById('graphModeSelect');
    if (modeSelect) {
      // jointTorque オプションがなければ追加
      if (!modeSelect.querySelector('option[value="jointTorque"]')) {
        const torqueOption = document.createElement('option');
        torqueOption.value = 'jointTorque';
        torqueOption.textContent = '関節トルク';
        modeSelect.appendChild(torqueOption);

        const powerOption = document.createElement('option');
        powerOption.value = 'jointPower';
        powerOption.textContent = '関節パワー';
        modeSelect.appendChild(powerOption);
      }

      // grf オプションがなければ追加
      if (!modeSelect.querySelector('option[value="grf"]')) {
        const grfOption = document.createElement('option');
        grfOption.value = 'grf';
        grfOption.textContent = '地面反力';
        modeSelect.appendChild(grfOption);
      }

      modeSelect.value = 'jointTorque';
      modeSelect.dispatchEvent(new Event('change'));
    }
  }

  /**
   * 身体重心を計算
   */
  calculateBodyCOM(settings) {
    if (!this.motionData || !this.motionData.frames) {
      alert('モーションデータが読み込まれていません');
      return;
    }

    // 現在のポイント数をチェック
    const currentPointCount = this.motionData.header.pointCount;

    if (settings.pointCount === 23) {
      // 23点モード：データが23点以上あればOK（最初の23点を使用）
      if (currentPointCount < 23) {
        alert(`現在のデータは${currentPointCount}点です。23点モードには最低23点が必要です。`);
        return;
      }
    } else if (settings.pointCount === 25) {
      // 25点モード：データが25点未満の場合はエラー
      if (currentPointCount < 25) {
        alert(`現在のデータは${currentPointCount}点です。25点モードには25点以上が必要です。`);
        return;
      }
    }

    try {
      // BodyCenterOfMassインスタンスを作成
      const model = settings.pointCount === 23 ? 'ae14' : 'ae15';
      const config = {
        method: model,
        sex: settings.sex,
        ageGroup: settings.ageGroup,
        childAge: settings.childAge,
        bodyType: settings.bodyType
      };
      this.bodyCOM = new BodyCenterOfMass(config);

      // データを body-com.js の形式に変換
      // {x, y, z} 形式を [x, y, z] 形式に変換
      const formattedMotionData = this.motionData.frames.map((frame, frameIndex) => ({
        frame: frameIndex,
        points: frame.map(point => [point.x, point.y, point.z])
      }));

      // 全フレームの身体重心を計算
      this.bodyCOMResults = this.bodyCOM.calculateAllFrames(formattedMotionData);

      // 有効な結果の数を数える
      const validResults = this.bodyCOMResults.filter(r => r.valid).length;
      const totalFrames = this.bodyCOMResults.length;

      if (validResults === 0) {
        alert('身体重心の計算に失敗しました。\nデータに不備がある可能性があります。');
        return;
      }

      // 身体重心をモーションデータに追加
      this.addBodyCOMToMotionData();

      // 身体重心を表示
      this.bodyCOMEnabled = true;
      this.displayBodyCOM();

      // 現在のフレームの身体重心を表示
      this.updateBodyCOMDisplay();

      // 速度キャッシュを無効化（新しいポイントが追加されたため）
      this.velocityCacheValid = false;

      // グラフ選択リストを更新（身体重心を選択可能にする）
      this.renderGraphSelectionList();

      // グラフを再描画
      this.drawScatterPlot();

      // 年代の表示文字列
      let ageGroupText = '大人';
      if (settings.ageGroup === 'child') {
        ageGroupText = `子ども（${settings.childAge}歳・${settings.bodyType === 'thin' ? '痩身' : settings.bodyType === 'obese' ? '肥満' : '標準'}）`;
      } else if (settings.ageGroup === 'elderly') {
        ageGroupText = '高齢者';
      }

      alert(`身体重心の計算が完了しました。\n\n` +
        `モデル: ${model === 'ae14' ? '阿江14 (23点)' : '阿江15 (25点)'}\n` +
        `年代: ${ageGroupText}\n` +
        `性別: ${settings.sex === 'male' ? '男性' : '女性'}\n` +
        `有効フレーム: ${validResults} / ${totalFrames}\n\n` +
        `身体重心がポイント${this.motionData.header.pointCount}として追加されました。`);

    } catch (error) {
      alert('身体重心の計算中にエラーが発生しました:\n' + error.message);
    }
  }

  /**
   * 身体重心をモーションデータに追加
   */
  addBodyCOMToMotionData() {
    if (!this.motionData || !this.bodyCOMResults) return;

    // すでに身体重心が追加されているかチェック
    const lastPointName = this.currentPointNames[this.currentPointNames.length - 1];
    if (lastPointName === '身体重心') {
      // 既に追加されている場合は、データを更新
      for (let i = 0; i < this.motionData.frames.length; i++) {
        const result = this.bodyCOMResults[i];
        const lastIndex = this.motionData.frames[i].length - 1;

        if (result && result.valid && result.bodyCOM) {
          this.motionData.frames[i][lastIndex] = {
            x: result.bodyCOM[0],
            y: result.bodyCOM[1],
            z: result.bodyCOM[2]
          };
        } else {
          this.motionData.frames[i][lastIndex] = {
            x: 0,
            y: 0,
            z: 0
          };
        }
      }

      // 球体の位置も更新
      if (this.spheres && this.spheres.length > 0) {
        const lastSphereIndex = this.spheres.length - 1;
        const result = this.bodyCOMResults[this.currentFrame];
        if (result && result.valid && result.bodyCOM) {
          this.spheres[lastSphereIndex].position.set(
            result.bodyCOM[0],
            result.bodyCOM[1],
            result.bodyCOM[2]
          );
        }
      }
      return;
    }

    // 各フレームに身体重心の座標を追加
    for (let i = 0; i < this.motionData.frames.length; i++) {
      const result = this.bodyCOMResults[i];

      if (result && result.valid && result.bodyCOM) {
        // 身体重心の座標を追加
        this.motionData.frames[i].push({
          x: result.bodyCOM[0],
          y: result.bodyCOM[1],
          z: result.bodyCOM[2]
        });
      } else {
        // 無効なフレームの場合は原点を追加
        this.motionData.frames[i].push({
          x: 0,
          y: 0,
          z: 0
        });
      }
    }

    // ポイント数を更新
    this.motionData.header.pointCount += 1;

    // ポイント名リストに追加
    if (this.currentPointNames && this.currentPointNames.length > 0) {
      this.currentPointNames.push('身体重心');
    }

    // 球体配列に身体重心用の球体を追加
    if (this.spheres && this.scene) {
      const geometry = new THREE.SphereGeometry(0.04, 16, 16);
      const material = new THREE.MeshStandardMaterial({
        color: 0xff0000,  // 赤色
        metalness: 0.3,
        roughness: 0.7
      });
      const sphere = new THREE.Mesh(geometry, material);

      // userDataを設定（ポイント設定ダイアログで表示されるように）
      sphere.userData.pattern = 'sphere';

      this.scene.add(sphere);
      this.spheres.push(sphere);

      // 軌跡設定の初期値を追加（これがないと軌跡表示が効かない）
      const newPointIndex = this.motionData.header.pointCount - 1;
      this.trajectorySettings.push({
        pointIndex: newPointIndex,
        name: '身体重心',
        color: 0xff0000,
        opacity: 0.7,
        interval: 1,
        visible: false,
        trajectoryLength: 50
      });

      // 現在のフレームの位置に配置
      const result = this.bodyCOMResults[this.currentFrame];
      if (result && result.valid && result.bodyCOM) {
        sphere.position.set(
          result.bodyCOM[0],
          result.bodyCOM[1],
          result.bodyCOM[2]
        );
      }
    }
  }

  /**
   * 身体重心を3D空間に表示
   */
  displayBodyCOM() {
    if (!this.scene) return;

    // 既存の身体重心球体を削除
    if (this.bodyCOMSphere) {
      this.scene.remove(this.bodyCOMSphere);
      this.bodyCOMSphere = null;
    }

    // 赤い球体を作成
    const geometry = new THREE.SphereGeometry(0.05, 16, 16);
    const material = new THREE.MeshStandardMaterial({
      color: 0xff0000,
      metalness: 0.3,
      roughness: 0.7
    });

    this.bodyCOMSphere = new THREE.Mesh(geometry, material);
    this.scene.add(this.bodyCOMSphere);
  }

  /**
   * 身体重心の表示を更新
   */
  updateBodyCOMDisplay() {
    if (!this.bodyCOMEnabled || !this.bodyCOMSphere || !this.bodyCOMResults) return;

    const result = this.bodyCOMResults[this.currentFrame];

    if (result && result.valid && result.bodyCOM) {
      this.bodyCOMSphere.visible = true;
      // bodyCOMは[x, y, z]形式の配列
      this.bodyCOMSphere.position.set(
        result.bodyCOM[0],
        result.bodyCOM[1],
        result.bodyCOM[2]
      );
    } else {
      this.bodyCOMSphere.visible = false;
    }
  }

  /**
   * 身体重心表示を非表示にする
   */
  hideBodyCOM() {
    if (this.bodyCOMSphere) {
      this.scene.remove(this.bodyCOMSphere);
      this.bodyCOMSphere = null;
    }
    this.bodyCOMEnabled = false;
    this.bodyCOMResults = [];
  }

  /**
   * Butterworthフィルタ適用
   */
  applyButterworthFilter({ mode, method, cutoffMethod, fc, doPad, padLen }) {
    if (!this.motionData || !this.motionData.frames || this.motionData.frames.length === 0) return;
    const frames = this.motionData.frames;
    const nf = frames.length;
    const np = this.motionData.header.pointCount;
    const dim = this.motionData.header.dimension || 3;
    const dt = this.motionData.header.frameInterval;
    const fs = dt > 0 ? (1 / dt) : 0;
    if (fs <= 0) { alert('フレーム間隔が不正です。'); return; }

    const highMotionPoints = this.detectHighMotionPoints(frames, dt, dim);

    if (mode === 'auto') {
      // 自動遮断周波数（Wells and Winter法）

      // 各ポイント×各成分を独立チャンネルとして抽出
      const channels = [];
      const indexMap = [];
      for (let p = 0; p < np; p++) {
        const xs = new Array(nf), ys = new Array(nf), zs = new Array(nf);
        for (let f = 0; f < nf; f++) {
          const pt = frames[f][p];
          // nullポイント（欠損値）はNaNとして扱う
          if (!pt) {
            xs[f] = NaN; ys[f] = NaN; if (dim === 3) zs[f] = NaN;
          } else {
            xs[f] = pt.x; ys[f] = pt.y; if (dim === 3) zs[f] = pt.z;
          }
        }
        channels.push(xs); indexMap.push({ pointIndex: p, component: 'x' });
        channels.push(ys); indexMap.push({ pointIndex: p, component: 'y' });
        if (dim === 3) { channels.push(zs); indexMap.push({ pointIndex: p, component: 'z' }); }
      }

      const fcList = calculateWaWCutoff(channels, fs, { tailCount: 10 });

      // 動的最小パディング（端部トランジェント抑制用）
      const dynamicPad = (fcVal) => {
        const base = Math.ceil(3 * fs / Math.max(fcVal, 0.1));
        const capped = Math.min(Math.floor(nf / 3), base);
        return Math.max(20, capped);
      };

      const newFramesAuto = frames.map(row => row.map(pt => pt ? { x: pt.x, y: pt.y, z: pt.z } : null));
      for (let ch = 0; ch < channels.length; ch++) {
        const { pointIndex, component } = indexMap[ch];
        const series = channels[ch];
        let fcUse = fcList[ch];
        if (highMotionPoints.has(pointIndex) && this.highMotionCutoffHz) {
          fcUse = Math.max(fcUse, this.highMotionCutoffHz);
        }
        const minPad = dynamicPad(fcUse);
        const usedPad = doPad ? Math.max(padLen, minPad) : minPad;
        let proc = addPadding(series, usedPad);
        // フィルタ構造はWinter/Bryant共通。Residual分析はW&W。
        proc = butterWinter(proc, fs, fcUse);
        proc = removePadding(proc, usedPad);
        for (let f = 0; f < nf; f++) {
          if (component === 'x') newFramesAuto[f][pointIndex].x = proc[f];
          else if (component === 'y') newFramesAuto[f][pointIndex].y = proc[f];
          else newFramesAuto[f][pointIndex].z = proc[f];
        }
      }

      this.motionData.frames = newFramesAuto;

      // 速度キャッシュを無効化（位置データが変更されたため再計算が必要）
      this.velocityCacheValid = false;

      this.setCurrentFrame(this.currentFrame);
      this.updateTrajectories();
      this.updateLineTrajectories();
      return;
    }

    // 手動遮断周波数（Winterの方法）

    // 動的最小パディング（端部トランジェント抑制用）
    const dynamicPad = (fcVal) => {
      const base = Math.ceil(3 * fs / Math.max(fcVal, 0.1));
      const capped = Math.min(Math.floor(nf / 3), base);
      return Math.max(20, capped);
    };

    // 各ポイント・各次元ごとに時系列を抽出してフィルタ
    // 出力を新しい配列に格納してから置換
    const newFrames = new Array(nf);
    for (let f = 0; f < nf; f++) {
      newFrames[f] = new Array(np);
      for (let p = 0; p < np; p++) {
        const src = frames[f][p];
        // nullポイント（欠損値）はそのまま保持
        newFrames[f][p] = src ? { x: src.x, y: src.y, z: src.z } : null;
      }
    }

    // x, y, z それぞれの系列を構築してフィルタ
    const applyOneComponent = (getter, setter) => {
      for (let p = 0; p < np; p++) {
        const series = new Array(nf);
        for (let f = 0; f < nf; f++) {
          const pt = frames[f][p];
          series[f] = pt ? getter(pt) : NaN;
        }

        const fcForPoint = highMotionPoints.has(p) && this.highMotionCutoffHz
          ? Math.max(fc, this.highMotionCutoffHz)
          : fc;
        const minPad = dynamicPad(fcForPoint);
        const usedPad = doPad ? Math.max(padLen, minPad) : minPad;
        let proc = addPadding(series, usedPad);
        proc = butterWinter(proc, fs, fcForPoint);
        proc = removePadding(proc, usedPad);

        for (let f = 0; f < nf; f++) {
          if (newFrames[f][p]) setter(newFrames[f][p], proc[f]);
        }
      }
    };

    applyOneComponent(pt => pt.x, (pt, v) => { pt.x = v; });
    applyOneComponent(pt => pt.y, (pt, v) => { pt.y = v; });
    if (dim === 3) applyOneComponent(pt => pt.z, (pt, v) => { pt.z = v; });

    // 置き換え
    this.motionData.frames = newFrames;

    // 速度キャッシュを無効化（位置データが変更されたため再計算が必要）
    this.velocityCacheValid = false;

    // 表示更新
    this.setCurrentFrame(this.currentFrame);
    this.updateTrajectories();
    this.updateLineTrajectories();
  }

  /**
   * 速度データの計算とキャッシュ（FDF法：Filter-Differentiate-Filter）
   * 位置フィルタ後のデータから速度を計算し、さらにフィルタを適用
   */
  calculateAndCacheVelocity() {
    if (!this.motionData || !this.motionData.frames || this.motionData.frames.length < 3) {
      this.velocityCache = null;
      this.velocityCacheValid = false;
      return;
    }

    const frames = this.motionData.frames;
    const nf = frames.length;
    const np = this.motionData.header.pointCount;
    const dim = this.motionData.header.dimension || 3;
    const dt = this.motionData.header.frameInterval || 0.004;
    const fs = dt > 0 ? (1 / dt) : 240;

    // 各ポイント・各軸の速度時系列を計算
    const vxAll = [];
    const vyAll = [];
    const vzAll = [];

    for (let p = 0; p < np; p++) {
      // 位置時系列を抽出
      const posX = new Array(nf);
      const posY = new Array(nf);
      const posZ = dim === 3 ? new Array(nf) : null;

      for (let f = 0; f < nf; f++) {
        const pt = frames[f][p];
        // nullポイント（欠損値）はNaNとして扱う
        if (!pt) {
          posX[f] = NaN;
          posY[f] = NaN;
          if (dim === 3) posZ[f] = NaN;
        } else {
          posX[f] = pt.x;
          posY[f] = pt.y;
          if (dim === 3) posZ[f] = pt.z;
        }
      }
      // 欠損箇所（NaN）をスプライン補間して連続データにする
      const interpolatedX = interpolateMissingData(posX);
      const interpolatedY = interpolateMissingData(posY);
      const interpolatedZ = dim === 3 ? interpolateMissingData(posZ) : null;

      // スプライン微分で速度計算（S.KOIKE 2003.12.25アルゴリズム）
      let vx = differentiateSpline(interpolatedX, dt);
      let vy = differentiateSpline(interpolatedY, dt);
      let vz = dim === 3 ? differentiateSpline(interpolatedZ, dt) : new Array(nf).fill(0);

      // C3Dなどの生データ由来のノイズを抑えるため、速度データに再度ローパスフィルタ（FDF法）を適用
      // カットオフ周波数は高周波ノイズを除去するために広めに設定（例: 10Hz）
      // ※ すでにフィルタ済みのMVPデータであっても、微分のノイズ増幅を抑えるために軽くかける
      const fc = this.filterCutoffHz || 10;
      vx = filterVelocity(vx, fs, fc);
      vy = filterVelocity(vy, fs, fc);
      if (dim === 3) vz = filterVelocity(vz, fs, fc);

      vxAll.push(vx);
      vyAll.push(vy);
      vzAll.push(vz);
    }

    // 合成速度の計算
    const compositeAll = [];
    for (let p = 0; p < np; p++) {
      const composite = new Array(nf);
      for (let f = 0; f < nf; f++) {
        const vx = vxAll[p][f];
        const vy = vyAll[p][f];
        const vz = vzAll[p][f];
        composite[f] = Math.sqrt(vx * vx + vy * vy + vz * vz);
      }
      compositeAll.push(composite);
    }

    // キャッシュに保存
    this.velocityCache = {
      vx: vxAll,
      vy: vyAll,
      vz: vzAll,
      composite: compositeAll
    };
    this.velocityCacheValid = true;

    console.log(`速度データキャッシュ完了: ${np}ポイント × ${nf}フレーム (スプライン微分法)`);
  }

  /**
   * キャッシュから速度を取得（キャッシュがない場合は従来の計算）
   */
  getVelocityFromCache(jointIndex, frame, axis) {
    // キャッシュが有効な場合はキャッシュから取得
    if (this.velocityCacheValid && this.velocityCache) {
      const cache = this.velocityCache;
      if (jointIndex < 0 || jointIndex >= cache.vx.length) return 0;
      if (frame < 0 || frame >= cache.vx[jointIndex].length) return 0;

      switch (axis) {
        case 'x': return cache.vx[jointIndex][frame];
        case 'y': return cache.vy[jointIndex][frame];
        case 'z': return cache.vz[jointIndex][frame];
        case 'composite': return cache.composite[jointIndex][frame];
        default: return cache.composite[jointIndex][frame];
      }
    }

    // キャッシュがない場合は従来の方法で計算
    if (axis === 'composite') {
      return this.calculateCompositeVelocity(jointIndex, frame);
    }
    return this.calculateVelocity(jointIndex, frame, axis);
  }

  /**
   * 画像出力形式選択ダイアログを表示
   */
  showImageFormatDialog() {
    const dialog = document.getElementById('imageFormatDialog');
    if (dialog) {
      dialog.style.display = 'flex';
    }
  }

  /**
   * 動画を出力
   */
  async exportVideo() {
    if (!this.motionData || !this.renderer) {
      alert('モーションデータが読み込まれていません');
      return;
    }

    try {
      // 保存先ダイアログ
      const baseName = this.motionData.header.fileName.replace(/\.[^/.]+$/, "");
      const defaultVideoName = `${baseName}.mp4`;
      const result = await window.electronAPI.invoke('show-save-dialog', {
        title: '動画の保存先を選択',
        defaultPath: this.getDefaultSavePath(defaultVideoName),
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
      });
      if (!result || result.canceled || !result.filePath) return;
      const filePath = result.filePath;

      // ローディング画面を表示
      const loadingScreen = document.getElementById('videoExportLoading');
      const progressText = document.getElementById('exportProgress');
      if (loadingScreen) {
        loadingScreen.style.display = 'flex';
      }

      // 現在の再生状態を保存
      const wasPlaying = this.isPlaying;
      const currentFrame = this.currentFrame;
      const currentSpeed = this.animationSpeed;

      // 再生を停止し、最初のフレームに戻す
      if (wasPlaying) this.stopAnimation();
      this.setCurrentFrame(0);

      // サンプリングロジック
      const frameInterval = this.motionData.header.frameInterval;
      const inputFps = frameInterval > 0 ? (1 / frameInterval) : 250;
      const totalFrames = this.motionData.frames.length;
      const outputFps = 60;
      const speedValue = this.animationSpeed || 1.0;

      const duration = totalFrames / inputFps / speedValue;
      const outputFrameCount = Math.round(outputFps * duration);

      const frameIndices = [];
      for (let i = 0; i < outputFrameCount; i++) {
        const srcFrame = Math.round(i * totalFrames / outputFrameCount);
        frameIndices.push(Math.min(srcFrame, totalFrames - 1));
      }

      const loadImageAsync = (src) => {
        return new Promise((resolve, reject) => {
          const img = new window.Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      };

      const graphContainer = document.getElementById('graphContainer');
      const isGraphVisible = graphContainer && graphContainer.style.display !== 'none';

      const outputHeight = 1080;
      let outputViewerWidth, outputGraphWidth;

      if (isGraphVisible) {
        outputViewerWidth = 960;
        outputGraphWidth = 960;
      } else {
        outputViewerWidth = 1920;
        outputGraphWidth = 0;
      }

      const originalViewerSize = new THREE.Vector2();
      this.renderer.getSize(originalViewerSize);
      const originalCameraAspect = this.camera.aspect;

      const scatterCanvas = document.getElementById('scatterCanvas');
      let originalGraphSize = null;
      if (isGraphVisible && scatterCanvas) {
        originalGraphSize = {
          width: scatterCanvas.width,
          height: scatterCanvas.height
        };
      }

      try {
        for (let i = 0; i < frameIndices.length; i++) {
          const srcFrame = frameIndices[i];
          this.setCurrentFrame(srcFrame);

          if (progressText) {
            progressText.textContent = `フレーム ${i + 1} / ${frameIndices.length} を処理中...`;
          }

          this.renderer.setSize(outputViewerWidth, outputHeight);
          this.camera.aspect = outputViewerWidth / outputHeight;
          this.camera.updateProjectionMatrix();
          this.renderer.render(this.scene, this.camera);

          if (isGraphVisible && this.scatterCtx && this.selectedJoints && this.selectedJoints.size > 0 && scatterCanvas) {
            scatterCanvas.width = outputGraphWidth;
            scatterCanvas.height = outputHeight;
            this.drawScatterPlot();
          }

          const elapsedSec = srcFrame / inputFps;
          const webglDataURL = this.renderer.domElement.toDataURL('image/png');
          const viewerWidth = outputViewerWidth;
          const viewerHeight = outputHeight;

          let finalCanvas, finalCtx;

          if (isGraphVisible) {
            const graphWidth = outputGraphWidth;
            const graphHeight = outputHeight;
            const totalWidth = viewerWidth + graphWidth;
            const totalHeight = outputHeight;

            finalCanvas = document.createElement('canvas');
            finalCanvas.width = totalWidth;
            finalCanvas.height = totalHeight;
            finalCtx = finalCanvas.getContext('2d');

            finalCtx.fillStyle = '#ffffff';
            finalCtx.fillRect(0, 0, totalWidth, totalHeight);

            const viewerImg = await loadImageAsync(webglDataURL);
            finalCtx.drawImage(viewerImg, 0, 0, viewerWidth, viewerHeight);

            if (scatterCanvas) {
              finalCtx.drawImage(scatterCanvas, viewerWidth, 0, graphWidth, graphHeight);
            }
          } else {
            finalCanvas = document.createElement('canvas');
            finalCanvas.width = viewerWidth;
            finalCanvas.height = viewerHeight;
            finalCtx = finalCanvas.getContext('2d');

            const viewerImg = await loadImageAsync(webglDataURL);
            finalCtx.drawImage(viewerImg, 0, 0, viewerWidth, viewerHeight);
          }

          finalCtx.font = 'bold 32px sans-serif';
          finalCtx.strokeStyle = 'black';
          finalCtx.lineWidth = 5;
          finalCtx.lineJoin = 'round';
          finalCtx.fillStyle = 'white';
          const text = `Time: ${elapsedSec.toFixed(3)}s`;
          finalCtx.strokeText(text, 30, 50);
          finalCtx.fillText(text, 30, 50);

          const dataURL = finalCanvas.toDataURL('image/png');
          await window.electronAPI.saveFrameImage(dataURL, i);
        }

        if (progressText) {
          progressText.textContent = '動画を生成中...';
        }

        const videoResult = await window.electronAPI.createVideoFromFrames(outputFrameCount, filePath, this.animationSpeed, inputFps);

        if (videoResult.success) {
          alert('動画の出力が完了しました: ' + filePath);
        } else {
          throw new Error(videoResult.error || '動画の生成に失敗しました');
        }

      } finally {
        this.renderer.setSize(originalViewerSize.x, originalViewerSize.y);
        this.camera.aspect = originalCameraAspect;
        this.camera.updateProjectionMatrix();

        if (originalGraphSize && scatterCanvas) {
          scatterCanvas.width = originalGraphSize.width;
          scatterCanvas.height = originalGraphSize.height;
        }

        this.renderer.render(this.scene, this.camera);

        if (isGraphVisible && this.scatterCtx && this.selectedJoints && this.selectedJoints.size > 0) {
          this.drawScatterPlot();
        }

        if (loadingScreen) {
          loadingScreen.style.display = 'none';
        }

        this.setCurrentFrame(currentFrame);
        this.setAnimationSpeed(currentSpeed);
        if (wasPlaying) this.startAnimation();
      }

    } catch (error) {
      console.error('動画出力エラー:', error);
      alert('動画の出力に失敗しました: ' + error.message);
    }
  }

  /**
   * 現在の画面をPNG形式で保存
   */
  async saveScreenshotPNG() {
    try {
      // 高解像度でレンダリング
      const width = 1920;
      const height = 1080;

      // 一時的にレンダラーのサイズを変更
      const originalSize = this.renderer.getSize(new THREE.Vector2());
      this.renderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();

      // レンダリング
      this.renderer.render(this.scene, this.camera);

      // キャンバスから画像データを取得
      const dataURL = this.renderer.domElement.toDataURL('image/png');

      // サイズを元に戻す
      this.renderer.setSize(originalSize.x, originalSize.y);
      this.camera.aspect = originalSize.x / originalSize.y;
      this.camera.updateProjectionMatrix();

      // ファイル保存ダイアログ
      if (window.electronAPI) {
        const baseName = this.motionData.header.fileName.replace(/\.[^/.]+$/, '');
        const result = await window.electronAPI.invoke('show-save-dialog', {
          title: '画像を保存',
          defaultPath: this.getDefaultSavePath(`${baseName}.png`),
          filters: [{ name: 'PNG画像', extensions: ['png'] }]
        });

        if (!result.canceled && result.filePath) {
          // Base64データをファイルに保存
          const base64Data = dataURL.replace(/^data:image\/png;base64,/, '');
          await window.electronAPI.invoke('save-image-file', result.filePath, base64Data);
          alert('画像を保存しました！');
        }
      }
    } catch (error) {
      console.error('スクリーンショット保存エラー:', error);
      throw error;
    }
  }

  /**
   * 現在の画面をSVG形式で保存
   */
  async saveScreenshotSVG() {
    try {
      if (!this.motionData || !this.currentPointNames) {
        throw new Error('モーションデータが読み込まれていません');
      }

      // カメラのビュー行列とプロジェクション行列を取得
      const viewMatrix = new THREE.Matrix4();
      viewMatrix.copy(this.camera.matrixWorldInverse);

      const projectionMatrix = new THREE.Matrix4();
      projectionMatrix.copy(this.camera.projectionMatrix);

      // ビュー・プロジェクション合成行列
      const vpMatrix = new THREE.Matrix4();
      vpMatrix.multiplyMatrices(projectionMatrix, viewMatrix);

      const currentFrame = this.motionData.frames[this.currentFrame];
      if (!currentFrame) {
        throw new Error('現在のフレームデータが見つかりません');
      }
      const aspect = this.camera.aspect;

      // SVGのスケール
      const scale = 500;
      const scaleX = scale;
      const scaleY = scale;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const svgLines = [];
      const svgCircles = [];

      // 線を描画（ライン設定を参照）
      if (this.lineSettings && this.lineSettings.length > 0) {
        this.lineSettings.forEach((setting) => {
          // ライン設定を参照：表示/非表示、色、太さ
          if (setting.visible && setting.width > 0) {
            const p1Index = this.currentPointNames.indexOf(setting.name1);
            const p2Index = this.currentPointNames.indexOf(setting.name2);

            if (p1Index > -1 && p2Index > -1 && currentFrame[p1Index] && currentFrame[p2Index]) {
              const p1 = currentFrame[p1Index];
              const p2 = currentFrame[p2Index];

              // 無効な点をスキップ
              if (!this.isValidPoint(p1) || !this.isValidPoint(p2)) {
                return;
              }

              // 3D座標を作成
              const start3D = new THREE.Vector3(p1.x, p1.y, p1.z);
              const end3D = new THREE.Vector3(p2.x, p2.y, p2.z);

              // スクリーン座標に変換
              start3D.applyMatrix4(vpMatrix);
              end3D.applyMatrix4(vpMatrix);

              // 正規化デバイス座標からSVG座標へ
              const start2D = {
                x: (start3D.x * aspect + 1) * scaleX,
                y: (1 - start3D.y) * scaleY
              };
              const end2D = {
                x: (end3D.x * aspect + 1) * scaleX,
                y: (1 - end3D.y) * scaleY
              };

              // 境界ボックスを更新
              minX = Math.min(minX, start2D.x, end2D.x);
              minY = Math.min(minY, start2D.y, end2D.y);
              maxX = Math.max(maxX, start2D.x, end2D.x);
              maxY = Math.max(maxY, start2D.y, end2D.y);

              // 色を16進数からRGBに変換
              const color = new THREE.Color(setting.color);

              svgLines.push({
                start: start2D,
                end: end2D,
                color: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
                strokeWidth: Math.max(2, setting.width / 2)
              });
            }
          }
        });
      }

      // 点を描画（ポイント設定を参照）
      if (this.spheres && this.spheres.length > 0) {
        this.spheres.forEach((sphere, index) => {
          // ポイント設定を参照：表示/非表示、色、サイズ
          if (sphere.visible && currentFrame[index]) {
            const point = currentFrame[index];
            if (!this.isValidPoint(point)) return;

            const point3D = new THREE.Vector3(point.x, point.y, point.z);
            point3D.applyMatrix4(vpMatrix);

            const point2D = {
              x: (point3D.x * aspect + 1) * scaleX,
              y: (1 - point3D.y) * scaleY
            };

            // ポイント設定から色とサイズを取得
            const color = sphere.material.color;
            const geoParams = sphere.geometry.parameters;
            const pattern = sphere.userData.pattern || 'sphere';

            // サイズを取得（球体/ボックス/コーンで異なる）
            let radius;
            if (pattern === 'sphere') {
              radius = (geoParams.radius !== undefined && geoParams.radius !== null) ? geoParams.radius * 100 : 0;
            } else if (pattern === 'cone') {
              // ConeGeometryのparametersではradiusが使われる（radiusBottomではない）
              radius = (geoParams.radius !== undefined && geoParams.radius !== null) ? geoParams.radius * 100 : 0;
            } else {
              radius = (geoParams.width !== undefined && geoParams.width !== null) ? geoParams.width * 100 : 0;
            }

            // サイズが0以下の場合は描画をスキップ
            if (radius <= 0) {
              return;
            }

            // SVG上でのサイズに変換（線と同じスケール、最小2ピクセル）
            const svgRadius = Math.max(2, radius / 2);

            minX = Math.min(minX, point2D.x - svgRadius);
            minY = Math.min(minY, point2D.y - svgRadius);
            maxX = Math.max(maxX, point2D.x + svgRadius);
            maxY = Math.max(maxY, point2D.y + svgRadius);

            svgCircles.push({
              center: point2D,
              radius: svgRadius,
              color: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
              pattern: pattern // 円以外の形状もサポートするため追加
            });
          }
        });
      }

      // マージンを追加
      const margin = 50;
      minX -= margin;
      minY -= margin;
      maxX += margin;
      maxY += margin;

      const width = maxX - minX;
      const height = maxY - minY;

      // SVG生成
      let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}">\n`;
      svg += `  <title>フレーム ${this.currentFrame + 1}</title>\n`;

      // 1. 背景色を追加
      // シーンの背景色を取得（未設定の場合は黒に近いグレーなどデフォルトを設定）
      let bgColor = '#f0f0f0';
      if (this.scene.background) {
        bgColor = '#' + this.scene.background.getHexString();
      }
      svg += `  <!-- Background -->\n`;
      svg += `  <rect x="${minX.toFixed(2)}" y="${minY.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${bgColor}" />\n\n`;

      // 2. 床面（グリッドと軸）を追加
      svg += `  <!-- Floor Grid & Axes -->\n`;
      svg += `  <g id="floor-grid">\n`;
      if (this.gridHelpers && this.elements.floorVisible && this.elements.floorVisible.checked) {
        this.gridHelpers.forEach((grid) => {
          if (!grid.visible) return;
          const pos = grid.position;
          const size = grid.geometry.parameters ? grid.geometry.parameters.size : 10;
          const divisions = grid.geometry.parameters ? grid.geometry.parameters.divisions : 10;
          const step = size / divisions;
          const halfSize = size / 2;

          const color1 = grid.material.color.getStyle(); // 中心軸の色
          const color2 = grid.material.color2 ? grid.material.color2.getStyle() : color1; // グリッドの色

          // -z to +z (vertical lines in local grid space)
          for (let i = 0, k = -halfSize; i <= divisions; i++, k += step) {
            const isCenter = (i === divisions / 2);
            const color = isCenter ? color1 : color2;

            const p1_3d = new THREE.Vector3(k, 0, -halfSize).add(pos);
            const p2_3d = new THREE.Vector3(k, 0, halfSize).add(pos);

            p1_3d.applyMatrix4(vpMatrix);
            p2_3d.applyMatrix4(vpMatrix);

            const p1_2d = { x: (p1_3d.x * aspect + 1) * scaleX, y: (1 - p1_3d.y) * scaleY };
            const p2_2d = { x: (p2_3d.x * aspect + 1) * scaleX, y: (1 - p2_3d.y) * scaleY };

            // Zクリッピングの簡易チェック（カメラの後ろにあるなら描画しない）
            if (p1_3d.z > 1 || p2_3d.z > 1) continue;

            svg += `    <line x1="${p1_2d.x.toFixed(2)}" y1="${p1_2d.y.toFixed(2)}" x2="${p2_2d.x.toFixed(2)}" y2="${p2_2d.y.toFixed(2)}" stroke="${color}" stroke-width="${isCenter ? 2 : 1}" />\n`;
          }

          // -x to +x (horizontal lines in local grid space)
          for (let i = 0, k = -halfSize; i <= divisions; i++, k += step) {
            const isCenter = (i === divisions / 2);
            const color = isCenter ? color1 : color2;

            const p1_3d = new THREE.Vector3(-halfSize, 0, k).add(pos);
            const p2_3d = new THREE.Vector3(halfSize, 0, k).add(pos);

            p1_3d.applyMatrix4(vpMatrix);
            p2_3d.applyMatrix4(vpMatrix);

            const p1_2d = { x: (p1_3d.x * aspect + 1) * scaleX, y: (1 - p1_3d.y) * scaleY };
            const p2_2d = { x: (p2_3d.x * aspect + 1) * scaleX, y: (1 - p2_3d.y) * scaleY };

            if (p1_3d.z > 1 || p2_3d.z > 1) continue;

            svg += `    <line x1="${p1_2d.x.toFixed(2)}" y1="${p1_2d.y.toFixed(2)}" x2="${p2_2d.x.toFixed(2)}" y2="${p2_2d.y.toFixed(2)}" stroke="${color}" stroke-width="${isCenter ? 2 : 1}" />\n`;
          }
        });
      }
      svg += `  </g>\n\n`;

      // 1フレームを1グループにまとめる
      svg += `  <g id="frame-${this.currentFrame + 1}" data-frame="${this.currentFrame + 1}">\n`;
      svg += `    <title>フレーム ${this.currentFrame + 1}</title>\n`;

      // 3. 線を描画
      svg += `    <!-- Lines -->\n`;
      svgLines.forEach((line, index) => {
        svg += `    <line id="frame-${this.currentFrame + 1}-line-${index}" `;
        svg += `x1="${line.start.x.toFixed(2)}" y1="${line.start.y.toFixed(2)}" `;
        svg += `x2="${line.end.x.toFixed(2)}" y2="${line.end.y.toFixed(2)}" `;
        svg += `stroke="${line.color}" stroke-width="${line.strokeWidth}" `;
        svg += `stroke-linecap="round" />\n`;
      });

      // 4. 点を描画（形状に応じて）
      svg += `    <!-- Points -->\n`;
      svgCircles.forEach((circle, index) => {
        const id = `frame-${this.currentFrame + 1}-point-${index}`;
        if (circle.pattern === 'cone') {
          // 上向きの三角形（コーン）
          const w = circle.radius * 2;
          const h = circle.radius * 2.5; // コーンは少し縦長にする
          const pt1 = `${circle.center.x.toFixed(2)},${(circle.center.y - h / 2).toFixed(2)}`;
          const pt2 = `${(circle.center.x - w / 2).toFixed(2)},${(circle.center.y + h / 2).toFixed(2)}`;
          const pt3 = `${(circle.center.x + w / 2).toFixed(2)},${(circle.center.y + h / 2).toFixed(2)}`;
          svg += `    <polygon id="${id}" points="${pt1} ${pt2} ${pt3}" fill="${circle.color}" />\n`;
        } else if (circle.pattern === 'cube' || circle.pattern === 'box') {
          // 四角形（ボックス）
          const size = circle.radius * 2;
          svg += `    <rect id="${id}" x="${(circle.center.x - size / 2).toFixed(2)}" y="${(circle.center.y - size / 2).toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" fill="${circle.color}" />\n`;
        } else {
          // デフォルトは球（円）
          svg += `    <circle id="${id}" cx="${circle.center.x.toFixed(2)}" cy="${circle.center.y.toFixed(2)}" r="${circle.radius.toFixed(2)}" fill="${circle.color}" />\n`;
        }
      });

      svg += `  </g>\n\n`;

      // 5. 凡例を描画（表示されている場合）
      // WebGLの描画領域内の相対的な位置に描画する
      const legendToggle = document.getElementById('toggleLegend');
      const isLegendVisible = legendToggle && legendToggle.classList.contains('active') && this.legendState.visible;

      const scatterCanvas = document.getElementById('scatterCanvas');
      const isGraphVisible = scatterCanvas && scatterCanvas.style.display !== 'none';

      if (isLegendVisible && isGraphVisible && this.currentSeriesData.length > 0) {
        svg += `  <!-- Legend -->\n`;
        // キャンバスのサイズを SVG viewBox のサイズにマッピングする
        const canvasW = scatterCanvas.width;
        const canvasH = scatterCanvas.height;
        // マッピング用のスケール比
        const mapX = width / canvasW;
        const mapY = height / canvasH;

        const legX = minX + (this.legendState.x || 10) * mapX;
        const legY = minY + (this.legendState.y || 10) * mapY;
        const legW = this.legendState.width * mapX;
        const legH = this.legendState.height * mapY;

        // 凡例の背景
        svg += `  <rect x="${legX.toFixed(2)}" y="${legY.toFixed(2)}" width="${legW.toFixed(2)}" height="${legH.toFixed(2)}" fill="white" fill-opacity="0.8" stroke="#333" stroke-width="1" rx="5" ry="5" />\n`;

        // フォントサイズもスケールさせる
        const fontSize = (this.legendState.fontSize || 12) * mapY;
        const titleFontSize = (this.legendState.titleFontSize || 11) * mapY;

        let currentY = legY + 5 * mapY + titleFontSize;
        const startX = legX + 10 * mapX;

        // タイトル
        const isSelected = this.scatterCtx && this.selectedJoints && this.selectedJoints.size > 0;
        const titleText = isSelected ? '凡例 (クリックで表示/非表示)' : 'ポイントを選択してください';
        svg += `  <text x="${startX.toFixed(2)}" y="${currentY.toFixed(2)}" font-family="sans-serif" font-size="${titleFontSize.toFixed(2)}px" fill="#666">${titleText}</text>\n`;

        currentY += 10 * mapY;
        const isHorizontal = this.legendState.direction === 'horizontal';

        // シリーズデータの描画
        let currentX = startX;
        this.currentSeriesData.forEach((series, index) => {
          if (isHorizontal) {
            // 横並びの場合
            svg += `  <circle cx="${(currentX + 5 * mapX).toFixed(2)}" cy="${(currentY - 4 * mapY).toFixed(2)}" r="${(4 * mapY).toFixed(2)}" fill="${series.hidden ? '#ccc' : series.color}" />\n`;
            svg += `  <text x="${(currentX + 15 * mapX).toFixed(2)}" y="${currentY.toFixed(2)}" font-family="sans-serif" font-size="${fontSize.toFixed(2)}px" fill="${series.hidden ? '#999' : '#333'}">${series.name}</text>\n`;
            // 次の開始位置計算 (単純な固定幅。必要に応じてCanvasのmeasureText近似を用いるか固定幅に)
            const textW = series.name.length * fontSize * 0.7; // 粗い推定
            currentX += 15 * mapX + textW + 15 * mapX;
            if (currentX > legX + legW - 20 * mapX) {
              currentX = startX;
              currentY += fontSize + 8 * mapY;
            }
          } else {
            // 縦並びの場合
            currentY += fontSize + 8 * mapY;
            svg += `  <circle cx="${(currentX + 5 * mapX).toFixed(2)}" cy="${(currentY - 4 * mapY).toFixed(2)}" r="${(4 * mapY).toFixed(2)}" fill="${series.hidden ? '#ccc' : series.color}" />\n`;
            svg += `  <text x="${(currentX + 15 * mapX).toFixed(2)}" y="${currentY.toFixed(2)}" font-family="sans-serif" font-size="${fontSize.toFixed(2)}px" fill="${series.hidden ? '#999' : '#333'}">${series.name}</text>\n`;
          }
        });
      }

      svg += `</svg>`;

      // ファイル保存ダイアログ
      if (window.electronAPI) {
        const baseName = this.motionData.header.fileName.replace(/\.[^/.]+$/, '');
        const result = await window.electronAPI.invoke('show-save-dialog', {
          title: 'SVG画像を保存',
          defaultPath: this.getDefaultSavePath(`${baseName}_frame${this.currentFrame + 1}.svg`),
          filters: [{ name: 'SVGファイル', extensions: ['svg'] }]
        });

        if (!result.canceled && result.filePath) {
          await window.electronAPI.invoke('save-svg-file', result.filePath, svg);
          alert('SVGファイルを保存しました！\nPowerPointで「図形に変換」すると編集可能になります。');
        }
      }
    } catch (error) {
      console.error('SVG保存エラー:', error);
      throw error;
    }
  }

  // ===== フォースプレート可視化メソッド =====

  /**
   * フォースプレートを初期化
   */
  initializeForcePlates() {
    // 既存のオブジェクトをクリア
    this.clearForcePlates();

    // 保存されたフォースプレートデータを使用
    if (!this.pendingForcePlateData || this.pendingForcePlateData.length === 0) {
      return;
    }

    this.forcePlateData = this.pendingForcePlateData;
    this.pendingForcePlateData = null;  // 使用後にクリア

    console.log('[ForcePlate] プレート数:', this.forcePlateData.length);

    // 各プレートの矩形とベクトルを作成
    for (let i = 0; i < this.forcePlateData.length; i++) {
      const plate = this.forcePlateData[i];
      this.createForcePlateObject(plate, i);
      this.createForceVectorObject(plate, i);
    }
  }

  /**
   * フォースプレートの矩形オブジェクトを作成
   */
  createForcePlateObject(plate, index) {
    if (!plate.corners || plate.corners.length < 4) {
      console.warn('[ForcePlate] コーナー座標が不足:', index);
      return;
    }

    // コーナー座標（mm -> m）
    const corners = plate.corners.map(c => new THREE.Vector3(
      c[0] / 1000,
      c[1] / 1000,
      c[2] / 1000
    ));

    // プレートの色（インデックスに応じて変更）
    const colors = [0x3498db, 0xe74c3c, 0x2ecc71, 0xf39c12];
    const color = colors[index % colors.length];

    // 矩形のジオメトリを作成
    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array([
      // 三角形1
      corners[0].x, corners[0].y, corners[0].z,
      corners[1].x, corners[1].y, corners[1].z,
      corners[2].x, corners[2].y, corners[2].z,
      // 三角形2
      corners[0].x, corners[0].y, corners[0].z,
      corners[2].x, corners[2].y, corners[2].z,
      corners[3].x, corners[3].y, corners[3].z
    ]);
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.computeVertexNormals();

    // 半透明のマテリアル
    const material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: this.forcePlateOpacity,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.forcePlateIndex = index;
    mesh.visible = this.forcePlateEnabled;
    this.scene.add(mesh);
    this.forcePlateObjects.push(mesh);

    // 枠線を追加
    const edgeGeometry = new THREE.BufferGeometry();
    const edgeVertices = new Float32Array([
      corners[0].x, corners[0].y, corners[0].z,
      corners[1].x, corners[1].y, corners[1].z,
      corners[1].x, corners[1].y, corners[1].z,
      corners[2].x, corners[2].y, corners[2].z,
      corners[2].x, corners[2].y, corners[2].z,
      corners[3].x, corners[3].y, corners[3].z,
      corners[3].x, corners[3].y, corners[3].z,
      corners[0].x, corners[0].y, corners[0].z
    ]);
    edgeGeometry.setAttribute('position', new THREE.BufferAttribute(edgeVertices, 3));

    const edgeMaterial = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edges.userData.forcePlateIndex = index;
    edges.visible = this.forcePlateEnabled;
    this.scene.add(edges);
    this.forcePlateObjects.push(edges);
  }

  /**
   * 力ベクトルのオブジェクトを作成
   *
   * 【座標系について - 白紙から再設計】
   *
   * 重要な原則:
   * 1. 力データはプレートローカル座標系で記録されている
   * 2. プレート座標系の定義はコーナーから計算される
   * 3. 座標系を修正せず、元の定義をそのまま使用する
   * 4. 力の変換は元の座標系を使用し、結果を解釈する
   *
   * C3D Type 2 フォースプレート:
   * - 力データ: 「body on plate」規約
   * - 体が床を踏む → Fz正（プレートZ方向の力）
   * - GRF = -力データ（プレート座標変換後）
   */
  createForceVectorObject(plate, index) {
    if (!plate.corners || plate.corners.length < 4) {
      return;
    }

    // プレート中心を計算（mm -> m）
    const center = new THREE.Vector3(0, 0, 0);
    for (const corner of plate.corners) {
      center.x += corner[0] / 1000;
      center.y += corner[1] / 1000;
      center.z += corner[2] / 1000;
    }
    center.divideScalar(4);

    // コーナー座標を取得（mm単位のまま、後で変換用に使用）
    const c0 = new THREE.Vector3(plate.corners[0][0], plate.corners[0][1], plate.corners[0][2]);
    const c1 = new THREE.Vector3(plate.corners[1][0], plate.corners[1][1], plate.corners[1][2]);
    const c3 = new THREE.Vector3(plate.corners[3][0], plate.corners[3][1], plate.corners[3][2]);

    // プレートローカル軸の計算（元の定義をそのまま使用、修正しない）
    // X軸: corner0 → corner1
    const plateXAxis = new THREE.Vector3().subVectors(c1, c0).normalize();
    // Y軸: corner0 → corner3
    const plateYAxis = new THREE.Vector3().subVectors(c3, c0).normalize();
    // Z軸: X × Y（右手系の外積）
    const plateZAxis = new THREE.Vector3().crossVectors(plateXAxis, plateYAxis).normalize();

    // 矢印ヘルパーを作成（初期方向は上向き）
    const dir = new THREE.Vector3(0, 0, 1);
    const length = 0.1;
    const arrowColor = this.forceVectorColor;

    const arrow = new THREE.ArrowHelper(dir, center, length, arrowColor, 0.02, 0.01);
    arrow.userData.forcePlateIndex = index;
    arrow.userData.plateCenter = center.clone();
    arrow.userData.plateXAxis = plateXAxis.clone();
    arrow.userData.plateYAxis = plateYAxis.clone();
    arrow.userData.plateZAxis = plateZAxis.clone();
    arrow.visible = this.forcePlateEnabled;
    this.scene.add(arrow);
    this.forceVectorObjects.push(arrow);
  }

  /**
   * フォースベクトルを更新
   *
   * 【処理の流れ - 白紙から再設計】
   *
   * 1. COP（圧力中心）の計算
   *    - プレートローカル座標系で計算: copX = -My/Fz, copY = Mx/Fz
   *    - プレート原点からのオフセットを加算
   *    - グローバル座標系に変換
   *
   * 2. 力ベクトルの計算
   *    - C3D規約: 力は「body on plate」として記録
   *    - プレートZ軸方向が下向きなら、Fz正=下向きの力
   *    - GRF（地面反力）を表示するには反転が必要
   */
  updateForceVectors() {
    if (!this.forcePlateData || !this.forcePlateEnabled) {
      return;
    }

    for (let i = 0; i < this.forceVectorObjects.length; i++) {
      const arrow = this.forceVectorObjects[i];
      const plate = this.forcePlateData[i];

      if (!plate || !plate.forceData || !plate.forceData[this.currentFrame]) {
        arrow.visible = false;
        continue;
      }

      const force = plate.forceData[this.currentFrame];

      // 合成ベクトルの大きさ
      const magnitude = Math.sqrt(force.fx * force.fx + force.fy * force.fy + force.fz * force.fz);

      // 閾値以下の力は非表示
      if (magnitude < 10) {
        arrow.visible = false;
        continue;
      }

      // 取得したデータ
      const plateCenter = arrow.userData.plateCenter;
      const plateXAxis = arrow.userData.plateXAxis;
      const plateYAxis = arrow.userData.plateYAxis;
      const plateZAxis = arrow.userData.plateZAxis;

      // モーメント値（存在しない場合は0）
      const mx = typeof force.mx === 'number' ? force.mx : 0;
      const my = typeof force.my === 'number' ? force.my : 0;

      // プレート原点（mm単位、プレート中心からのオフセット）
      const origin = plate.origin || [0, 0, 0];

      // ========================================
      // COP（圧力中心）の計算
      // ========================================
      let copPosition = plateCenter.clone();

      if (Math.abs(force.fz) > 20) {
        // COP計算にはGRF規約のFz（正=上向き）を使用
        // C3Dデータ: force.fz < 0 (body on plate、下向き=負)
        // GRF: Fz_grf = -force.fz > 0 (上向き=正)
        const grfFz = -force.fz;

        // 標準COP公式（GRF規約、Fz > 0を前提）
        // copX = -My / Fz_grf
        // copY = Mx / Fz_grf
        const copLocalX = -my / grfFz;
        const copLocalY = mx / grfFz;

        // 原点オフセットを加算（プレート座標系の原点からのオフセット）
        const copInPlate = new THREE.Vector3(
          copLocalX + origin[0],
          copLocalY + origin[1],
          0
        );

        // プレート座標系 → グローバル座標系への変換
        // プレートX軸、Y軸方向にオフセットを適用
        const copGlobalOffset = new THREE.Vector3()
          .addScaledVector(plateXAxis, copInPlate.x / 1000)  // mm → m
          .addScaledVector(plateYAxis, copInPlate.y / 1000);

        copPosition.add(copGlobalOffset);
      }

      // 矢印の位置を更新
      arrow.position.copy(copPosition);

      // 力ベクトルの方向計算
      // C3D「body on plate」規約: 体が床を踏む → Fz負
      // GRFを得るには全成分を反転
      const grf = new THREE.Vector3()
        .addScaledVector(plateXAxis, -force.fx)
        .addScaledVector(plateYAxis, -force.fy)
        .addScaledVector(new THREE.Vector3(0, 0, 1), -force.fz);

      // 方向ベクトル（正規化）
      const dir = grf.clone().normalize();
      const length = magnitude * this.forceVectorScale;

      // ArrowHelperの更新
      arrow.setDirection(dir);
      arrow.setLength(Math.max(0.01, length), Math.min(0.05, length * 0.2), Math.min(0.02, length * 0.1));
      arrow.visible = this.forcePlateEnabled;
    }
  }

  /**
   * フォースプレートオブジェクトをクリア
   */
  clearForcePlates() {
    for (const obj of this.forcePlateObjects) {
      this.scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    this.forcePlateObjects = [];

    for (const obj of this.forceVectorObjects) {
      this.scene.remove(obj);
      // ArrowHelperは内部でdisposeが必要
      if (obj.line) {
        if (obj.line.geometry) obj.line.geometry.dispose();
        if (obj.line.material) obj.line.material.dispose();
      }
      if (obj.cone) {
        if (obj.cone.geometry) obj.cone.geometry.dispose();
        if (obj.cone.material) obj.cone.material.dispose();
      }
    }
    this.forceVectorObjects = [];
    this.forcePlateData = null;
  }

  /**
   * フォースプレート表示の切り替え
   */
  toggleForcePlateVisibility(enabled) {
    this.forcePlateEnabled = enabled;

    for (const obj of this.forcePlateObjects) {
      obj.visible = enabled;
    }
    for (const obj of this.forceVectorObjects) {
      if (enabled) {
        this.updateForceVectors();  // 表示時は現在フレームで更新
      } else {
        obj.visible = false;
      }
    }
  }

  /**
   * ポイントが有効かどうかをチェック
   */
  isValidPoint(point) {
    return point &&
      typeof point.x === 'number' &&
      typeof point.y === 'number' &&
      typeof point.z === 'number' &&
      !isNaN(point.x) &&
      !isNaN(point.y) &&
      !isNaN(point.z) &&
      isFinite(point.x) &&
      isFinite(point.y) &&
      isFinite(point.z);
  }

  detectHighMotionPoints(frames, dt, dim) {
    const result = new Set();
    if (!frames || frames.length < 2 || dt <= 0 || !this.highMotionVelocityThreshold) {
      return result;
    }
    const nf = frames.length;
    const np = frames[0] ? frames[0].length : 0;
    if (np === 0) return result;
    for (let p = 0; p < np; p++) {
      let prev = frames[0][p];
      if (!this.isValidPoint(prev)) continue;
      let maxVel = 0;
      for (let f = 1; f < nf; f++) {
        const curr = frames[f][p];
        if (!this.isValidPoint(curr)) continue;
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        const dz = dim === 3 ? (curr.z - prev.z) : 0;
        const vel = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
        if (vel > maxVel) maxVel = vel;
        prev = curr;
      }
      if (maxVel >= this.highMotionVelocityThreshold) {
        result.add(p);
      }
    }
    return result;
  }

  /**
   * Wells & Winter法の残差分析グラフを別ウィンドウで表示
   */
  showResidualAnalysisGraph() {
    if (!this.motionData || !this.motionData.frames || this.motionData.frames.length === 0) {
      alert('モーションデータが読み込まれていません。');
      return;
    }

    const frames = this.motionData.frames;
    const nf = frames.length;
    const np = this.motionData.header.pointCount;
    const dim = this.motionData.header.dimension || 3;
    const dt = this.motionData.header.frameInterval;
    const fs = dt > 0 ? (1 / dt) : 0;

    if (fs <= 0) {
      alert('フレーム間隔が不正です。');
      return;
    }

    // 各ポイント×各成分の残差曲線データを計算
    const analysisData = [];
    const pointNames = this.currentPointNames || [];

    for (let p = 0; p < np; p++) {
      const components = ['X', 'Y'];
      if (dim === 3) components.push('Z');

      for (const comp of components) {
        const series = new Array(nf);
        for (let f = 0; f < nf; f++) {
          const pt = frames[f][p];
          // nullポイント（欠損値）はNaNとして扱う
          if (!pt) {
            series[f] = NaN;
          } else {
            series[f] = comp === 'X' ? pt.x : (comp === 'Y' ? pt.y : pt.z);
          }
        }

        const curveData = calculateResidualCurve(series, fs, { tailCount: 10 });
        const pointName = pointNames[p] || `Point ${p}`;

        analysisData.push({
          pointIndex: p,
          pointName: pointName,
          component: comp,
          label: `${pointName} (${comp})`,
          ...curveData
        });
      }
    }

    // 別ウィンドウを開く
    const newWindow = window.open('', 'residualAnalysis', 'width=1200,height=800,scrollbars=yes,resizable=yes');
    if (!newWindow) {
      alert('ポップアップがブロックされました。ポップアップを許可してください。');
      return;
    }

    // HTMLコンテンツを生成
    const html = this._generateResidualAnalysisHTML(analysisData, fs);
    newWindow.document.write(html);
    newWindow.document.close();
  }

  /**
   * 残差分析グラフのHTML生成
   */
  _generateResidualAnalysisHTML(analysisData, fs) {
    const nyq = fs / 2;

    // 各ポイントの最適fcサマリーを生成
    const summaryRows = analysisData.map(d =>
      `<tr>
        <td>${d.pointIndex}</td>
        <td>${d.pointName}</td>
        <td>${d.component}</td>
        <td>${d.optimalFc.toFixed(2)} Hz</td>
      </tr>`
    ).join('');

    // グラフデータをJSON化
    const graphDataJSON = JSON.stringify(analysisData);

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>残差分析 - Wells & Winter法</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
    }
    .info {
      background: #fff;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .controls {
      margin-bottom: 20px;
      display: flex;
      gap: 20px;
      align-items: center;
      flex-wrap: wrap;
    }
    .controls label {
      font-weight: bold;
    }
    .controls select {
      padding: 8px 12px;
      font-size: 14px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }
    .graph-container {
      background: #fff;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    canvas {
      max-width: 100%;
    }
    .summary-table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .summary-table th, .summary-table td {
      padding: 10px 15px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    .summary-table th {
      background: #4a90d9;
      color: white;
    }
    .summary-table tr:hover {
      background: #f0f7ff;
      cursor: pointer;
    }
    .summary-table tr.selected {
      background: #d0e7ff;
    }
    .legend-info {
      margin-top: 10px;
      padding: 10px;
      background: #f9f9f9;
      border-radius: 4px;
      font-size: 13px;
    }
    .legend-info span {
      margin-right: 20px;
    }
    .legend-info .residual-line { color: #2196F3; }
    .legend-info .noise-line { color: #FF5722; }
    .legend-info .optimal-fc { color: #4CAF50; }
    .fc-summary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px 30px;
      border-radius: 12px;
      margin-bottom: 20px;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    }
    .fc-summary h2 {
      margin: 0 0 15px 0;
      font-size: 18px;
      font-weight: 600;
    }
    .fc-summary .fc-range {
      font-size: 32px;
      font-weight: bold;
      margin: 10px 0;
    }
    .fc-summary .fc-details {
      display: flex;
      gap: 30px;
      margin-top: 15px;
      font-size: 14px;
    }
    .fc-summary .fc-stat {
      display: flex;
      flex-direction: column;
    }
    .fc-summary .fc-stat-label {
      opacity: 0.8;
      font-size: 12px;
    }
    .fc-summary .fc-stat-value {
      font-size: 18px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <h1>残差分析グラフ（Wells & Winter法）</h1>

  <div class="info">
    <strong>サンプリング周波数:</strong> ${fs.toFixed(1)} Hz |
    <strong>ナイキスト周波数:</strong> ${nyq.toFixed(1)} Hz |
    <strong>ポイント数:</strong> ${analysisData.length / (analysisData[0]?.component === 'Z' ? 3 : 2)}
  </div>

  ${this._generateFcSummaryHTML(analysisData)}

  <div class="controls">
    <label>ポイント選択:</label>
    <select id="pointSelect">
      ${analysisData.map((d, i) =>
      `<option value="${i}">${d.label} - fc: ${d.optimalFc.toFixed(2)} Hz</option>`
    ).join('')}
    </select>
  </div>

  <div class="graph-container">
    <canvas id="residualChart" width="800" height="400"></canvas>
    <div class="legend-info">
      <span class="residual-line">● 残差曲線 R(fc)</span>
      <span class="noise-line">● ノイズ直線（高域回帰）</span>
      <span class="optimal-fc">● 最適遮断周波数 fc</span>
    </div>
  </div>

  <h2>全ポイント最適遮断周波数一覧</h2>
  <table class="summary-table">
    <thead>
      <tr>
        <th>Index</th>
        <th>ポイント名</th>
        <th>成分</th>
        <th>最適 fc</th>
      </tr>
    </thead>
    <tbody>
      ${summaryRows}
    </tbody>
  </table>

  <script>
    const analysisData = ${graphDataJSON};
    let chart = null;

    function drawChart(index) {
      const data = analysisData[index];
      const ctx = document.getElementById('residualChart').getContext('2d');

      if (chart) {
        chart.destroy();
      }

      // 残差曲線データ
      const residualData = data.fcList.map((fc, i) => ({ x: fc, y: data.residuals[i] }));

      // ノイズ直線データ（全範囲）
      const { m, b, a } = data.noiseLine;
      const noiseLineData = [
        { x: data.fcList[0], y: a },
        { x: data.fcList[data.fcList.length - 1], y: a }
      ];

      // 高域回帰部分（点線で表示）
      const tailStart = data.tailStartIndex;
      const regressionLineData = data.fcList.slice(tailStart).map(fc => ({
        x: fc,
        y: m * fc + b
      }));

      chart = new Chart(ctx, {
        type: 'scatter',
        data: {
          datasets: [
            {
              label: '残差 R(fc)',
              data: residualData,
              borderColor: '#2196F3',
              backgroundColor: 'rgba(33, 150, 243, 0.1)',
              showLine: true,
              fill: false,
              pointRadius: 2,
              borderWidth: 2,
              order: 2
            },
            {
              label: 'ノイズレベル a (Y切片)',
              data: noiseLineData,
              borderColor: '#FF5722',
              borderWidth: 2,
              borderDash: [5, 5],
              showLine: true,
              fill: false,
              pointRadius: 0,
              order: 1
            },
            {
              label: '高域回帰直線',
              data: regressionLineData,
              borderColor: '#FF9800',
              borderWidth: 1,
              borderDash: [3, 3],
              showLine: true,
              fill: false,
              pointRadius: 0,
              order: 3
            },
            {
              label: '最適 fc = ' + data.optimalFc.toFixed(2) + ' Hz',
              data: [{ x: data.optimalFc, y: 0 }, { x: data.optimalFc, y: data.residuals[0] }],
              borderColor: '#4CAF50',
              borderWidth: 3,
              showLine: true,
              fill: false,
              pointRadius: 0,
              order: 0
            }
          ]
        },
        options: {
          responsive: true,
          plugins: {
            title: {
              display: true,
              text: data.label + ' - 最適fc: ' + data.optimalFc.toFixed(2) + ' Hz',
              font: { size: 16 }
            },
            legend: {
              position: 'top'
            }
          },
          scales: {
            x: {
              type: 'linear',
              title: {
                display: true,
                text: '遮断周波数 fc (Hz)'
              },
              min: 0
            },
            y: {
              type: 'linear',
              title: {
                display: true,
                text: '残差 Residual'
              },
              min: 0
            }
          }
        }
      });
    }

    // 初期表示
    drawChart(0);

    // セレクト変更時
    document.getElementById('pointSelect').addEventListener('change', (e) => {
      drawChart(parseInt(e.target.value));
    });

    // テーブル行クリック時
    document.querySelectorAll('.summary-table tbody tr').forEach((row, i) => {
      row.addEventListener('click', () => {
        document.querySelectorAll('.summary-table tbody tr').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        document.getElementById('pointSelect').value = i;
        drawChart(i);
      });
    });
  </script>
</body>
</html>`;
  }

  /**
   * 最適遮断周波数サマリーHTML生成
   */
  _generateFcSummaryHTML(analysisData) {
    const fcValues = analysisData.map(d => d.optimalFc);
    const minFc = Math.min(...fcValues);
    const maxFc = Math.max(...fcValues);
    const avgFc = fcValues.reduce((a, b) => a + b, 0) / fcValues.length;
    const medianFc = [...fcValues].sort((a, b) => a - b)[Math.floor(fcValues.length / 2)];

    // 標準偏差
    const variance = fcValues.reduce((sum, fc) => sum + Math.pow(fc - avgFc, 2), 0) / fcValues.length;
    const stdFc = Math.sqrt(variance);

    return `
    <div class="fc-summary">
      <h2>最適遮断周波数 (Wells & Winter法)</h2>
      <div class="fc-range">${minFc.toFixed(2)} Hz 〜 ${maxFc.toFixed(2)} Hz</div>
      <div class="fc-details">
        <div class="fc-stat">
          <span class="fc-stat-label">最小値</span>
          <span class="fc-stat-value">${minFc.toFixed(2)} Hz</span>
        </div>
        <div class="fc-stat">
          <span class="fc-stat-label">最大値</span>
          <span class="fc-stat-value">${maxFc.toFixed(2)} Hz</span>
        </div>
        <div class="fc-stat">
          <span class="fc-stat-label">平均値</span>
          <span class="fc-stat-value">${avgFc.toFixed(2)} Hz</span>
        </div>
        <div class="fc-stat">
          <span class="fc-stat-label">中央値</span>
          <span class="fc-stat-value">${medianFc.toFixed(2)} Hz</span>
        </div>
        <div class="fc-stat">
          <span class="fc-stat-label">標準偏差</span>
          <span class="fc-stat-value">±${stdFc.toFixed(2)} Hz</span>
        </div>
      </div>
    </div>`;
  }

  /**
   * セグメント定義ダイアログを表示する
   */
  showSegmentDefinitionDialog() {
    const dlg = document.getElementById('segmentDefinitionDialog');
    if (!dlg) return;

    // ポイント選択肢の生成
    const pointNames = this.currentPointNames || [];
    const optionsHTML = '<option value="">未設定</option>' +
      pointNames.map((name, i) => `<option value="${name}">${name}</option>`).join('');

    // 全てのセレクトボックスに選択肢をセット
    const selects = dlg.querySelectorAll('.segment-point-select');
    selects.forEach(select => {
      const currentValue = this.getSegmentPointFromId(select.id);
      select.innerHTML = optionsHTML;
      select.value = currentValue || "";
    });

    // テンプレート適用ボタン
    const applyTemplateBtn = document.getElementById('segmentDefApplyTemplate');
    if (applyTemplateBtn) {
      applyTemplateBtn.onclick = () => {
        const template = document.getElementById('segmentDefTemplate').value;
        this.applySegmentTemplate(template);
      };
    }

    // 折りたたみセクションの制御
    const setupCollapsible = (headerId, contentId) => {
      const header = document.getElementById(headerId);
      const content = document.getElementById(contentId);
      if (header && content) {
        header.onclick = () => {
          const isHidden = content.style.display === 'none';
          content.style.display = isHidden ? 'grid' : 'none';
          header.querySelector('.collapse-icon').textContent = isHidden ? '▼' : '▶';
        };
      }
    };
    setupCollapsible('segDefUpperBodyToggle', 'segDefUpperBodyContent');
    setupCollapsible('segDefTrunkToggle', 'segDefTrunkContent');

    // OKボタン
    const okBtn = document.getElementById('segmentDefOk');
    if (okBtn) {
      okBtn.onclick = () => {
        this.saveSegmentDefinitionsFromUI();
        dlg.style.display = 'none';
      };
    }

    // キャンセルボタン
    const cancelBtn = document.getElementById('segmentDefCancel');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        dlg.style.display = 'none';
      };
    }

    dlg.style.display = 'flex';
  }

  /**
   * UIのセレクトボックスIDから現在の設定値を取得する
   */
  getSegmentPointFromId(elementId) {
    if (!this.segmentDefinitions) return null;

    // IDのネーミングルール: segDef[SegmentName][Prox/Dist]
    const match = elementId.match(/^segDef(.*?)(Prox|Dist)$/);
    if (!match) return null;

    const segName = match[1].charAt(0).toLowerCase() + match[1].slice(1);
    const type = match[2].toLowerCase(); // prox or dist

    return this.segmentDefinitions[segName] ? this.segmentDefinitions[segName][type] : null;
  }

  /**
   * ダイアログの入力値を segmentDefinitions に保存する
   */
  saveSegmentDefinitionsFromUI() {
    const dlg = document.getElementById('segmentDefinitionDialog');
    const selects = dlg.querySelectorAll('.segment-point-select');

    if (!this.segmentDefinitions) this.segmentDefinitions = {};

    selects.forEach(select => {
      const match = select.id.match(/^segDef(.*?)(Prox|Dist)$/);
      if (match) {
        const segName = match[1].charAt(0).toLowerCase() + match[1].slice(1);
        const type = match[2].toLowerCase();

        if (!this.segmentDefinitions[segName]) {
          this.segmentDefinitions[segName] = { prox: null, dist: null };
        }
        this.segmentDefinitions[segName][type] = select.value || null;
      }
    });

    // ライン設定との同期
    if (document.getElementById('segDefSyncToLineSettings').checked) {
      this.syncSegmentDefinitionsToLineSettings();
    }
  }

  /**
   * セグメント定義をライン設定に反映させる
   */
  syncSegmentDefinitionsToLineSettings() {
    if (!this.segmentDefinitions) return;

    // セグメント名とlineSettingsのsegmentTypeの対応マップ
    const segTypeMap = {
      rightThigh: 'rightThigh',
      rightShank: 'rightShank',
      rightFoot: 'rightFoot',
      leftThigh: 'leftThigh',
      leftShank: 'leftShank',
      leftFoot: 'leftFoot',
      rightHeel: 'rightHeel',
      leftHeel: 'leftHeel',
      rightUpperArm: 'none',
      rightForearm: 'none',
      leftUpperArm: 'none',
      leftForearm: 'none',
      trunk: 'none',
      pelvis: 'none'
    };

    Object.entries(this.segmentDefinitions).forEach(([segName, points]) => {
      const lineType = segTypeMap[segName];
      if (points.prox && points.dist) {
        // 既存のライン設定を更新（名称またはタイプで一致）
        let line = this.lineSettings.find(l =>
          (lineType !== 'none' && l.segmentType === lineType) ||
          (l.name1 === points.prox && l.name2 === points.dist)
        );

        if (line) {
          line.name1 = points.prox;
          line.name2 = points.dist;
          if (lineType !== 'none') line.segmentType = lineType;
        } else {
          // なければ新規追加
          this.lineSettings.push({
            name1: points.prox,
            name2: points.dist,
            color: this.currentLineColor,
            width: this.currentLineWidth,
            style: 'solid',
            visible: true,
            trajectoryVisible: false,
            trajectoryOpacity: 0.7,
            trajectoryLength: 50,
            segmentType: lineType || 'none'
          });
        }
      }
    });

    // スティックピクチャーを再描画
    if (this.motionData) {
      this.drawStickPicture(this.motionData.frames[this.currentFrame]);
    }
  }

  /**
   * テンプレートを適用する
   */
  applySegmentTemplate(template) {
    let mapping = {};

    if (template === 'hpe23' || template === 'hpe25') {
      mapping = {
        RightThigh: { Prox: '右股関節', Dist: '右膝' },
        RightShank: { Prox: '右膝', Dist: '右足首' },
        RightFoot: { Prox: '右足首', Dist: '右つま先' },
        RightHeel: { Prox: '右足首', Dist: '右踵' },
        LeftThigh: { Prox: '左股関節', Dist: '左膝' },
        LeftShank: { Prox: '左膝', Dist: '左足首' },
        LeftFoot: { Prox: '左足首', Dist: '左つま先' },
        LeftHeel: { Prox: '左足首', Dist: '左踵' },
        RightUpperArm: { Prox: '右肩', Dist: '右肘' },
        RightForearm: { Prox: '右肘', Dist: '右手首' },
        LeftUpperArm: { Prox: '左肩', Dist: '左肘' },
        LeftForearm: { Prox: '左肘', Dist: '左手首' },
        Trunk: { Prox: '首', Dist: '腰' }
      };
    } else if (template === 'plugingait') {
      mapping = {
        RightThigh: { Prox: 'RASI', Dist: 'RKNE' },
        RightShank: { Prox: 'RKNE', Dist: 'RANK' },
        RightFoot: { Prox: 'RANK', Dist: 'RTOE' },
        LeftThigh: { Prox: 'LASI', Dist: 'LKNE' },
        LeftShank: { Prox: 'LKNE', Dist: 'LANK' },
        LeftFoot: { Prox: 'LANK', Dist: 'LTOE' }
      };
    } else if (template === 'c3d_auto') {
      const labels = this.currentPointNames || [];
      const findLabel = (keywords) => {
        return labels.find(l => keywords.some(k => l.toLowerCase().includes(k.toLowerCase())));
      };

      mapping = {
        RightThigh: { Prox: findLabel(['RHIP', 'R_HIP']), Dist: findLabel(['RKNE', 'R_KNE']) },
        RightShank: { Prox: findLabel(['RKNE', 'R_KNE']), Dist: findLabel(['RANK', 'R_ANK']) },
        LeftThigh: { Prox: findLabel(['LHIP', 'L_HIP']), Dist: findLabel(['LKNE', 'L_KNE']) },
        LeftShank: { Prox: findLabel(['LKNE', 'L_KNE']), Dist: findLabel(['LANK', 'L_ANK']) }
      };
    }

    // UIのセレクトボックスを更新
    Object.entries(mapping).forEach(([segName, points]) => {
      const proxSelect = document.getElementById(`segDef${segName}Prox`);
      const distSelect = document.getElementById(`segDef${segName}Dist`);

      if (proxSelect && points.Prox) proxSelect.value = points.Prox;
      if (distSelect && points.Dist) distSelect.value = points.Dist;
    });
  }
}

// アプリケーション開始
document.addEventListener('DOMContentLoaded', () => {
  window.motionApp = new MotionViewer();
});

// グローバルアクセス用
window.MotionViewer = MotionViewer;