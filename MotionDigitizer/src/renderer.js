/**
 * renderer.js - MotionDigitizer v1.0 レンダラープロセス
 * アプリケーション初期化・イベントリスナー設定・IPC通信管理
 * OpenCVモジュール統合・ArUco機能サポート（IPC経由）
 */

// DevToolsの不要ログ抑制（デバッグ用に一時的に無効化）
// (function suppressRendererLogs(){
// 	try {
// 		const noop = () => {};
// 		console.log = noop;
// 		console.warn = noop;
// 	} catch (_) {}
// })();

// レンダラープロセス用のOpenCVモジュールアクセス
// OpenCVモジュールはメインプロセス（electron-main.js）で読み込まれ、IPCを通じてアクセス

var ipcRenderer = (window && window.ipcRenderer) ? window.ipcRenderer : require('electron').ipcRenderer;
window.ipcRenderer = ipcRenderer;

// Electron 12+: webUtilsでファイルパス取得
var webUtils = null;
try {
    webUtils = require('electron').webUtils;
} catch (e) {
    // 旧バージョンでは利用不可
}

// グローバルデータ構造の初期化
if (!window.projectData) {
    window.projectData = {
        frameData: new Map(),
        analysisResults: {
            coordinates3D: new Map(),
            standardErrors: new Map()
        },
        settings: {
            currentFrame: 1,
            fps: 30,
            digitizeInterval: 1
        }
    };
}

// プレビュープレイヤーのグローバル変数
let previewPlayer;

// 現在選択中のポイント（モード別）
let selectedMotionLandmark = null;      // モーションモード用
let selectedCalibrationLandmark = null; // キャリブレーションモード用

// 起動時の自己診断は行わず、必要時のみIPCで確認する方針に変更

/**
 * アプリケーション初期化
 */
function initializeApp() {

    // データ構造の事前初期化
    if (!window.projectData.frameData) {
        window.projectData.frameData = new Map();
    }
    if (!window.projectData.analysisResults) {
        window.projectData.analysisResults = {
            coordinates3D: new Map(),
            standardErrors: new Map()
        };
    }

    window.setupDigitizeCanvas();
    // 初期ランドマークセレクタ設定（デフォルトはキャリブレーションモード）
    initializeCalibrationLandmarkSelector();
    document.getElementById('calibration-landmark-selector').style.display = 'flex';
    document.getElementById('motion-landmark-selector').style.display = 'none';
    setupEventListeners();
    setupDataTableClickEvent();
    setupCalibrationButtonEvent();

    // プレビュープレイヤーの初期化
    previewPlayer = new PreviewPlayer();

    // 必要カメラ数の初期表示を更新
    updateCameraRequirementUI();

    // 追加: アプリのグローバル設定を読み込む
    loadAndApplyAppSettings();

    // 起動時のデフォルト選択を設定
    setDefaultSelections();

    // ファイル選択UIを初期化
    if (typeof window.updateFileSelectionUI === 'function') {
        window.updateFileSelectionUI();
    }

    // ファイル選択ボタンはHTMLのonclick属性を使用（イベントリスナー設定不要）

    updateUI();

    // 2次元DLT法の較正表示を初期化
    updateCalibrationDisplay(null, null);

    // カメラ定数算出ボタンの状態を初期化
    updateCalibrationButtonState();

    showMessage('アプリケーションが起動しました');

    // IPCリスナーの設定
    setupIPCListeners();

    // 起動時の自己診断は行わず、必要時に機能側から確認します

    // プレビュー動画の初期ロード（条件が揃っていれば）
    try { applyVideoIfConditionsMet(); } catch (_) { }

    // デジタイズ間隔UI初期化
    try {
        const input = document.getElementById('digitize-interval');
        if (input) {
            const initVal = Number(window.projectData?.settings?.digitizeInterval) || 1;
            input.value = String(initVal);
            input.addEventListener('change', () => {
                let v = Number(input.value);
                if (!Number.isFinite(v)) v = 1;
                v = Math.max(1, Math.min(20, Math.floor(v)));
                window.projectData.settings.digitizeInterval = v;
                input.value = String(v);
                if (typeof window.showMessage === 'function') {
                    window.showMessage(`デジタイズ間隔を ${v} に設定しました`);
                }
            });
        }
    } catch (_) { }

    // モードに応じて表示/非表示を初期反映
    try { toggleDigitizeIntervalVisibility(); } catch (_) { }

    // 表示設定: ポイントサイズ/軌跡表示/太さ 初期化
    try {
        // 既定値
        projectData.settings.pointSize = Number(projectData?.settings?.pointSize) || 5;
        projectData.settings.showTrajectory = !!projectData?.settings?.showTrajectory;
        projectData.settings.trajectoryWidth = Number(projectData?.settings?.trajectoryWidth) || 5;
        projectData.settings.reverseDigitize = !!projectData?.settings?.reverseDigitize;

        const psInput = document.getElementById('point-size');
        if (psInput) {
            psInput.value = String(projectData.settings.pointSize);
            psInput.addEventListener('change', () => {
                let v = Number(psInput.value);
                if (!Number.isFinite(v)) v = 5;
                v = Math.max(1, Math.min(20, Math.floor(v)));
                projectData.settings.pointSize = v;
                psInput.value = String(v);
                try { redrawCanvasOnly(); } catch (_) { }
            });
        }

        const showTraj = document.getElementById('show-trajectory');
        if (showTraj) {
            showTraj.checked = !!projectData.settings.showTrajectory;
            showTraj.addEventListener('change', () => {
                projectData.settings.showTrajectory = !!showTraj.checked;
                try { redrawCanvasOnly(); } catch (_) { }
            });
        }

        const trajWidth = document.getElementById('trajectory-width');
        if (trajWidth) {
            trajWidth.value = String(projectData.settings.trajectoryWidth);
            trajWidth.addEventListener('change', () => {
                let v = Number(trajWidth.value);
                if (!Number.isFinite(v)) v = 5;
                v = Math.max(1, Math.min(10, Math.floor(v)));
                projectData.settings.trajectoryWidth = v;
                trajWidth.value = String(v);
                try { redrawCanvasOnly(); } catch (_) { }
            });
        }

        // 動作設定: リバースデジタイズ
        const reverseChk = document.getElementById('reverse-digitize');
        if (reverseChk) {
            reverseChk.checked = !!projectData.settings.reverseDigitize;
            reverseChk.addEventListener('change', () => {
                projectData.settings.reverseDigitize = !!reverseChk.checked;
            });
        }
    } catch (_) { }

    // CC法カメラ初期位置の入力同期
    try {
        const setupCCInput = (id, cam, axis) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', () => {
                    if (!window.projectData.ccInitialPositions) window.projectData.ccInitialPositions = { cam1: {}, cam2: {} };
                    if (!window.projectData.ccInitialPositions[cam]) window.projectData.ccInitialPositions[cam] = {};
                    window.projectData.ccInitialPositions[cam][axis] = el.value;
                });
                // 初期値同期（ロード直後など）
                if (window.projectData.ccInitialPositions?.[cam]?.[axis] !== undefined) {
                    el.value = window.projectData.ccInitialPositions[cam][axis];
                }
            }
        };

        ['cam1', 'cam2'].forEach(cam => {
            ['x', 'y', 'z'].forEach(axis => {
                setupCCInput(`cc-${cam}-${axis}`, cam, axis);
            });
        });
    } catch (_) { }

    // 初期化完了フラグを設定（file-handler.jsが待機するため）
    window.__rendererInitialized = true;
    document.dispatchEvent(new CustomEvent('renderer-initialized'));
}

/**
 * 起動時のデフォルト選択を設定する関数
 */
function setDefaultSelections() {
    // デフォルト: キャリブレーション + カメラ1
    const calibrationRadio = document.getElementById('calibration');
    const motionRadio = document.getElementById('motion');
    if (calibrationRadio) calibrationRadio.checked = true;
    if (motionRadio) motionRadio.checked = false;

    const camera1Radio = document.getElementById('camera1');
    const camera2Radio = document.getElementById('camera2');
    if (camera1Radio) camera1Radio.checked = true;
    if (camera2Radio) camera2Radio.checked = false;

    window.currentMode = 'calibration';
    window.currentCamera = 'cam1';

    // カメラ台数セレクト（デフォルト1台）
    const camCountSelect = document.getElementById('camera-count-select');
    if (camCountSelect) {
        camCountSelect.addEventListener('change', () => {
            updateCameraCountUI(parseInt(camCountSelect.value));
        });
        updateCameraCountUI(1);
    }

    // 起動時のファイル表示更新
    setTimeout(() => { if (typeof updateActiveFileDisplay === 'function') updateActiveFileDisplay(); }, 100);
}

// シングルカメラのキャリブレーション方法
const SINGLE_CAM_METHODS = ['4-point', '2d-dlt-single', 'charuco-single'];

/**
 * キャリブレーション方法に応じてカメラ台数を自動設定
 */
function applyCameraCountForMethod(method) {
    const camCountSelect = document.getElementById('camera-count-select');
    if (!camCountSelect) return;

    if (SINGLE_CAM_METHODS.includes(method)) {
        // シングル系: 1台固定
        camCountSelect.value = '1';
        camCountSelect.disabled = true;
        updateCameraCountUI(1);
    } else if (method) {
        // 3D系: デフォルト2台、変更可能
        camCountSelect.disabled = false;
        const current = parseInt(camCountSelect.value);
        if (current < 2) {
            camCountSelect.value = '2';
            updateCameraCountUI(2);
        }
    } else {
        // 未選択
        camCountSelect.disabled = false;
    }
}
window.applyCameraCountForMethod = applyCameraCountForMethod;

/**
 * カメラ台数に応じてボタンの有効/無効を制御
 */
function updateCameraCountUI(count) {
    const camIds = ['camera1', 'camera2', 'camera3', 'camera4'];
    camIds.forEach((id, i) => {
        const radio = document.getElementById(id);
        const label = radio ? radio.nextElementSibling : null;
        if (radio && label) {
            const enabled = i < count;
            radio.disabled = !enabled;
            label.classList.toggle('disabled', !enabled);
        }
    });
    // 選択中のカメラが範囲外なら1に戻す
    const currentCam = parseInt((window.currentCamera || 'cam1').replace('cam', ''));
    if (currentCam > count) {
        const cam1Radio = document.getElementById('camera1');
        if (cam1Radio) { cam1Radio.checked = true; window.currentCamera = 'cam1'; }
        if (typeof updateActiveFileDisplay === 'function') updateActiveFileDisplay();
        applyVideoIfConditionsMet();
    }
}
window.updateCameraCountUI = updateCameraCountUI;

/**
 * カメラ選択の有効/無効を現在の状態に応じて制御
 * - Charucoステレオ法 + デジタイズタブ: 無効（両カメラ同時使用）
 * - それ以外: 常に有効
 */
function updateCameraSelectState() {
    const cameraRadios = document.querySelectorAll('input[name="camera"]');
    const cameraSection = document.getElementById('camera-select-section');
    const currentMode = (typeof getCurrentMode === 'function') ? getCurrentMode() : '';
    const currentTab = (typeof getCurrentActiveTab === 'function') ? getCurrentActiveTab() : '';
    const methodSelect = document.getElementById('calibration-method');
    const isStereo = methodSelect && methodSelect.value === 'charuco-stereo';

    // ステレオ法 + キャリブレーション + デジタイズタブの場合のみ無効
    const shouldDisable = (currentMode === 'calibration' && isStereo && currentTab !== 'preview');

    cameraRadios.forEach(r => { r.disabled = shouldDisable; });
    if (cameraSection) cameraSection.style.opacity = shouldDisable ? '0.5' : '1';
}
window.updateCameraSelectState = updateCameraSelectState;

/**
 * 動画ファイル情報表示を現在のモード+カメラに連動して更新
 */
function updateActiveFileDisplay() {
    const mode = (typeof getCurrentMode === 'function') ? getCurrentMode() : 'calibration';
    const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
    const modeLabel = mode === 'calibration' ? 'キャリブ' : 'モーション';
    const camLabel = cam.replace('cam', 'Cam');

    // バッジ更新
    const badge = document.getElementById('active-file-badge');
    if (badge) badge.textContent = `${modeLabel} / ${camLabel}`;

    // ファイル名更新
    const fileKey = mode === 'calibration' ? `cal-${cam}` : `motion-${cam}`;
    const fileData = window.fileState ? window.fileState[fileKey] : null;
    const nameEl = document.getElementById('active-file-name');
    if (nameEl) {
        if (fileData) {
            const name = typeof fileData === 'string' ? fileData.split(/[/\\]/).pop() : (fileData.name || '');
            nameEl.textContent = name || 'ファイル';
            nameEl.classList.remove('empty');
        } else {
            nameEl.textContent = '未選択';
            nameEl.classList.add('empty');
        }
    }

    // ＋ボタンのonclick更新
    window._addActiveFile = function() {
        if (typeof selectFile === 'function') selectFile(fileKey);
    };

    // ファイルリスト表示（ソースリストをそのまま移動して表示）
    const listContainer = document.getElementById('active-file-list-container');
    const sourceList = document.getElementById(`${fileKey}-list`);
    if (listContainer) {
        // 以前表示していたリストを元の場所に戻す
        const prevList = listContainer.firstElementChild;
        if (prevList && prevList._originalParent) {
            prevList._originalParent.appendChild(prevList);
        }
        listContainer.innerHTML = '';
        // ソースリストをそのまま移動（イベントハンドラを維持）
        if (sourceList) {
            sourceList._originalParent = sourceList.parentElement;
            listContainer.appendChild(sourceList);
        }
    }

    updateCamDots();
}
window.updateActiveFileDisplay = updateActiveFileDisplay;

/**
 * カメラドットインジケータを更新
 */
function updateCamDots() {
    ['cam1', 'cam2', 'cam3', 'cam4'].forEach(cam => {
        const dot = document.getElementById(`${cam}-dot`);
        if (!dot) return;
        const calFile = window.fileState && window.fileState[`cal-${cam}`];
        const motFile = window.fileState && window.fileState[`motion-${cam}`];
        dot.classList.toggle('has-file', !!(calFile || motFile));
    });
}
window.updateCamDots = updateCamDots;

/**
 * イベントリスナーの設定
 */
function setupEventListeners() {
    // グローバル設定(Charucoなど)の自動保存イベントリスナー
    const charucoInputs = ['charuco-rows', 'charuco-cols', 'charuco-square-mm', 'charuco-marker-mm', 'charuco-dictionary'];
    charucoInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', saveAppSettings);
        }
    });
    // フレームスライダー（最適化版）
    const frameSlider = document.getElementById('frame-slider');
    let lastSliderUpdateTime = 0;
    const SLIDER_UPDATE_INTERVAL = 50; // ms (Max 20fps drawing during drag)

    // スライダードラッグ中フラグ（ドラッグ中は自動検出を無効化）
    window.__sliderDragging = false;

    if (frameSlider) {
        // スライダードラッグ中：フレーム番号更新と画面表示のみ（検出なし）
        frameSlider.addEventListener('input', (e) => {
            // ドラッグ中フラグをON
            window.__sliderDragging = true;

            const frameNumber = parseInt(e.target.value);
            window.projectData.settings.currentFrame = frameNumber;
            updateFrameInfo();

            // 描画更新は間引く（Scrubbing対応）- 検出中でなければ
            if (!window.__charucoDetectionInProgress) {
                const now = Date.now();
                if (now - lastSliderUpdateTime > SLIDER_UPDATE_INTERVAL) {
                    lastSliderUpdateTime = now;
                    displayCurrentFrame();
                }
            }
        });

        // スライダーリリース時：フレーム移動確定 → 検出実行
        frameSlider.addEventListener('change', (e) => {
            // ドラッグ終了
            window.__sliderDragging = false;

            // 検出中は何もしない
            if (window.__charucoDetectionInProgress) return;

            const frameNumber = parseInt(e.target.value);
            if (typeof goToFrame === 'function') {
                goToFrame(frameNumber);
            } else {
                displayCurrentFrame();
            }
        });
    }

    // FPSフィールドのイベント
    const fpsInput = document.getElementById('fps');
    if (fpsInput) {
        const onFpsUpdate = (e) => {
            const newFps = parseFloat(e.target.value);
            if (newFps > 0) {
                window.projectData.settings.fps = newFps;
                // 総フレーム数は動画ファイルの実際のフレーム数として固定
                // FPS変更では総フレーム数を変更しない
                updateFrameInfo();
            }
        };
        fpsInput.addEventListener('change', onFpsUpdate);
        fpsInput.addEventListener('input', onFpsUpdate);
    }

    // キーボードイベントリスナーは setupKeyboardEvents() で一元管理するため、ここは削除
    // document.addEventListener('keydown', ...);

    // ポイント名表示/非表示のチェックボックスイベント
    const showPointNamesCheckbox = document.getElementById('show-point-names');
    if (showPointNamesCheckbox) {
        showPointNamesCheckbox.addEventListener('change', function () {
            redrawCanvas();
        });
    }

    // 歪み補正画像表示チェックボックス
    const showUndistortedCheckbox = document.getElementById('show-undistorted-image');
    if (showUndistortedCheckbox) {
        showUndistortedCheckbox.addEventListener('change', function () {
            // フレームを再表示
            if (typeof window.displayCurrentFrame === 'function') {
                window.displayCurrentFrame();
            }
        });
    }

    // Undo/Redo メニューイベント (HTML要素 & IPC)
    const undoMenu = document.getElementById('menu-undo');
    if (undoMenu) {
        undoMenu.addEventListener('click', () => {
            if (window.undoManager) window.undoManager.undo();
        });
    }
    // Native MenuからのIPCイベント
    if (window.ipcRenderer) {
        window.ipcRenderer.on('menu-undo', () => {
            if (window.undoManager) window.undoManager.undo();
        });
        window.ipcRenderer.on('menu-redo', () => {
            if (window.undoManager) window.undoManager.redo();
        });
    }

    const redoMenu = document.getElementById('menu-redo');
    if (redoMenu) {
        redoMenu.addEventListener('click', () => {
            if (window.undoManager) window.undoManager.redo();
        });
    }

    // グローバルキーボードショートカット (Undo/Redo)
    document.addEventListener('keydown', function (event) {
        // 入力フィールド内の場合は除外（ただしUndoはテキストボックス標準動作があるため、アプリ独自のUndoは抑制するか、コンテキストを判断する）
        // ここでは、入力フィールド以外でのみ有効にする
        if (isInputField(event.target)) return;

        if (event.ctrlKey) {
            if (event.key === 'z') {
                event.preventDefault();
                if (window.undoManager) window.undoManager.undo();
            } else if (event.key === 'y') {
                event.preventDefault();
                if (window.undoManager) window.undoManager.redo();
            }
        }
    });

    // キャリブレーション方法変更時のイベントリスナー
    const calibrationMethodSelect = document.getElementById('calibration-method');
    if (calibrationMethodSelect) {
        calibrationMethodSelect.addEventListener('change', function () {
            updateCameraRequirementUI();
            updateCalibrationDataTable();
            try { updateStereoIntrinsicDisplay(); } catch (_) { }
            // ChArUcoボード選択UIの表示切替
            try { if (typeof window.updateCharucoBoardSelectUI === 'function') window.updateCharucoBoardSelectUI(); } catch (_) { }
            // 分析タブのボード選択UIを更新
            try { if (typeof window.updateAnalysisBoardSelectUI === 'function') window.updateAnalysisBoardSelectUI(); } catch (_) { }
        });
    }

    // 統合されたイベントリスナー設定
    setupUnifiedEventListeners();

    // カメラ選択のイベントリスナーを追加
    const camera1Radio = document.getElementById('camera1');
    const camera2Radio = document.getElementById('camera2');

    if (camera1Radio) {
        camera1Radio.addEventListener('change', () => {
            if (camera1Radio.checked) {
                updateMotionDataTableForCurrentCamera();
                try { redrawCanvas(); } catch (_) { }
            }
        });
    }

    if (camera2Radio) {
        camera2Radio.addEventListener('change', () => {
            if (camera2Radio.checked) {
                updateMotionDataTableForCurrentCamera();
                try { redrawCanvas(); } catch (_) { }
            }
        });
    }

    // ドラッグアンドドロップリスナーの設定
    setupDragAndDropListeners();
}

/**
 * ドラッグアンドドロップリスナーの設定
 */
function setupDragAndDropListeners() {
    const dropZones = [
        { id: 'cal-cam1', fileId: 'cal-cam1' },
        { id: 'cal-cam2', fileId: 'cal-cam2' },
        { id: 'motion-cam1', fileId: 'motion-cam1' },
        { id: 'motion-cam2', fileId: 'motion-cam2' }
    ];

    dropZones.forEach(zone => {
        const element = document.getElementById(zone.id);
        if (!element) return;

        // ドラッグオーバー時の処理（ドロップ許可）
        element.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            element.classList.add('drag-over');
        });

        // ドラッグリーブ時の処理（スタイル解除）
        element.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            element.classList.remove('drag-over');
        });

        // ドロップ時の処理（複数ファイル対応）
        element.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            element.classList.remove('drag-over');

            const files = e.dataTransfer.files;
            if (!files || files.length === 0) return;

            let successCount = 0;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];

                // ファイルパス取得（Electron 12+対応）
                let filePath = file.path;
                if (!filePath && webUtils && typeof webUtils.getPathForFile === 'function') {
                    try {
                        filePath = webUtils.getPathForFile(file);
                    } catch (err) {
                        console.error('webUtils.getPathForFile error:', err);
                    }
                }

                if (filePath) {
                    const fileObj = {
                        name: file.name,
                        path: filePath
                    };

                    // file-handler.js の共通処理を呼び出し
                    if (typeof window.processSelectedFile === 'function') {
                        window.processSelectedFile(zone.fileId, fileObj);
                        successCount++;
                    } else {
                        console.error('processSelectedFile function not found');
                    }
                }
            }

            if (successCount > 1) {
                if (typeof showMessage === 'function') {
                    showMessage(`${successCount}件のファイルを追加しました`);
                }
            }
        });
    });

    // ドロップゾーン: ファイル情報エリア + キャンバス
    const dropZoneEl = document.getElementById('active-file-drop-zone');
    const canvasEl = document.getElementById('digitize-canvas');
    [dropZoneEl, canvasEl].filter(Boolean).forEach(target => {
        target.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dropZoneEl) dropZoneEl.classList.add('drag-active');
        });
        target.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dropZoneEl) dropZoneEl.classList.remove('drag-active');
        });
        target.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dropZoneEl) dropZoneEl.classList.remove('drag-active');

            const mode = (typeof getCurrentMode === 'function') ? getCurrentMode() : 'calibration';
            const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
            const fileId = mode === 'calibration' ? `cal-${cam}` : `motion-${cam}`;

            const files = e.dataTransfer.files;
            if (!files || files.length === 0) return;

            let count = 0;
            for (let i = 0; i < files.length; i++) {
                let filePath = files[i].path;
                if (!filePath && typeof webUtils !== 'undefined' && webUtils.getPathForFile) {
                    try { filePath = webUtils.getPathForFile(files[i]); } catch (_) {}
                }
                if (filePath && typeof window.processSelectedFile === 'function') {
                    window.processSelectedFile(fileId, { name: files[i].name, path: filePath });
                    count++;
                }
            }
            if (count > 0 && typeof showMessage === 'function') {
                const label = mode === 'calibration' ? 'キャリブレーション' : 'モーション';
                showMessage(`${label}(${cam}) に ${count}件追加しました`);
            }
        });
    });
}

/**
 * IPCリスナーの設定
 */
function setupIPCListeners() {

    // メニューイベント
    ipcRenderer.on('menu-new-project', () => {
        newProject();
    });
    ipcRenderer.on('menu-open-project', () => {
        if (typeof window.loadProject === 'function') {
            window.loadProject();
        } else {
            showError('プロジェクト読み込み機能が利用できません');
        }
    });
    ipcRenderer.on('menu-save-project', () => {
        if (typeof window.saveProject === 'function') {
            window.saveProject();
        } else {
            showError('プロジェクト保存機能が利用できません');
        }
    });

    // テンプレートとして保存
    ipcRenderer.on('menu-save-template', () => {
        if (typeof window.saveProjectAsTemplate === 'function') {
            window.saveProjectAsTemplate();
        } else {
            showError('テンプレート保存機能が利用できません');
        }
    });
    ipcRenderer.on('menu-load-video', () => {
        if (typeof window.loadVideo === 'function') {
            window.loadVideo();
        } else if (typeof loadVideo === 'function') {
            loadVideo();
        }
    });
    ipcRenderer.on('menu-analyze-videos', () => {
        if (typeof window.analyzeVideos === 'function') {
            window.analyzeVideos();
        } else if (typeof analyzeVideos === 'function') {
            analyzeVideos();
        }
    });
    ipcRenderer.on('menu-calculate-3d', () => {
        if (typeof window.calculateRealLength === 'function') {
            window.calculateRealLength();
        } else if (typeof calculateRealLength === 'function') {
            calculateRealLength();
        }
    });
    ipcRenderer.on('menu-calculate-error', () => {
        if (typeof window.calculateError === 'function') {
            window.calculateError();
        } else if (typeof calculateError === 'function') {
            calculateError();
        }
    });
    ipcRenderer.on('menu-export-excel', () => {
        if (typeof window.exportExcel === 'function') {
            window.exportExcel();
        } else if (typeof exportExcel === 'function') {
            exportExcel();
        }
    });
    ipcRenderer.on('menu-calibration', () => {
        if (typeof window.showCalibration === 'function') {
            window.showCalibration();
        } else if (typeof showCalibration === 'function') {
            showCalibration();
        }
    });
    // メニューイベント: 保存系 (file-handler.js に集約されているためここでは登録しない)
    try {
        const { ipcRenderer } = window;
        if (ipcRenderer) {
            // 設定ダイアログを開く
            ipcRenderer.on('menu-open-settings', () => {
                openSettingsDialog();
            });
        }
    } catch (_) { }
}

/**
 * 設定ダイアログを開く
 */
function openSettingsDialog() {
    const dialog = document.getElementById('settingsDialog');
    if (!dialog) return;

    // 現在の設定値を反映
    const cacheLimitInput = document.getElementById('cache-limit-input');
    if (cacheLimitInput && typeof frameCache !== 'undefined') {
        cacheLimitInput.value = frameCache.limit || 1000;
    }

    dialog.style.display = 'flex';
}
window.openSettingsDialog = openSettingsDialog;

/**
 * 設定ダイアログを閉じる
 */
function closeSettingsDialog() {
    const dialog = document.getElementById('settingsDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
}
window.closeSettingsDialog = closeSettingsDialog;

/**
 * 設定を適用する
 */
function applySettings() {
    // キャッシュタイプの設定
    const cacheTypeSelect = document.getElementById('cache-type-select');
    if (cacheTypeSelect) {
        const newType = cacheTypeSelect.value;
        if (!projectData.settings) projectData.settings = {};
        projectData.settings.cacheType = newType;

        // グローバル変数に設定
        window.cacheType = newType;
    }

    // キャッシュ上限の設定
    const cacheLimitInput = document.getElementById('cache-limit-input');
    if (cacheLimitInput) {
        const newLimit = parseInt(cacheLimitInput.value, 10);
        if (newLimit >= 100 && newLimit <= 10000) {
            // FrameCacheの上限を更新
            if (typeof frameCache !== 'undefined') {
                frameCache.limit = newLimit;
            }
        } else {
            showError('キャッシュ上限は100〜10000の範囲で指定してください');
            return;
        }
    }

    const cacheType = window.cacheType || 'memory';
    showMessage(`キャッシュ設定を適用しました（${cacheType === 'disk' ? 'ディスク' : 'メモリ'}）`);
    closeSettingsDialog();
}
window.applySettings = applySettings;

/**
 * 統合されたイベントリスナー設定
 */
function setupUnifiedEventListeners() {
    // モード選択の変更イベント
    document.querySelectorAll('input[name="mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const selectedMode = e.target.value;
            window.currentMode = selectedMode;

            updateCameraSelectState();

            if (selectedMode === 'calibration') {
                showMessage('キャリブレーションモード: ポイントを打ってもフレームは移動しません');
                // タブ切り替えを削除 - 現在のタブを維持
                maintainCurrentTab();
                showDataStatus(); // データ状態を表示

                // ランドマークセレクタを切り替え
                document.getElementById('motion-landmark-selector').style.display = 'none';
                document.getElementById('calibration-landmark-selector').style.display = 'flex';
                initializeCalibrationLandmarkSelector();

                // キャリブレーションモードではポイント名表示をオン
                const showPointNamesCheckbox = document.getElementById('show-point-names');
                if (showPointNamesCheckbox) {
                    showPointNamesCheckbox.checked = true;
                }
            } else {
                showMessage('モーションモード: ポイントを打つと次のフレームに移動します');
                // タブ切り替えを削除 - 現在のタブを維持
                maintainCurrentTab();
                showDataStatus(); // データ状態を表示

                // ランドマークセレクタを切り替え
                document.getElementById('calibration-landmark-selector').style.display = 'none';
                document.getElementById('motion-landmark-selector').style.display = 'flex';
                initializeMotionLandmarkSelector();

                // モーションモードではポイント名表示をオフ
                const showPointNamesCheckbox = document.getElementById('show-point-names');
                if (showPointNamesCheckbox) {
                    showPointNamesCheckbox.checked = false;
                }
            }

            applyVideoIfConditionsMet();
            updateActiveFileDisplay();

            // デジタイズ間隔の表示/非表示を更新
            try { toggleDigitizeIntervalVisibility(); } catch (_) { }
        });
    });

    // カメラ選択の変更イベント
    document.querySelectorAll('input[name="camera"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const selectedCamera = e.target.value;
            window.currentCamera = selectedCamera;
            // カメラ別のモーションデータテーブルを更新（検証用）
            updateMotionDataTableForCurrentCamera();

            // ファイル選択UIの表示を更新
            if (typeof window.updateFileSelectionVisibility === 'function') {
                window.updateFileSelectionVisibility();
            }

            // 既存の処理も実行
            applyVideoIfConditionsMet();
            updateActiveFileDisplay();
        });
    });

    // キャリブレーション方法切替でUIをトグル
    const methodSelect = document.getElementById('calibration-method');
    if (methodSelect) {
        methodSelect.addEventListener('change', () => {
            toggleCalibrationPanels(methodSelect.value);
            // キャリブレーション方法に応じてカメラ台数を自動設定
            applyCameraCountForMethod(methodSelect.value);
            // ChArUcoボード選択UIの表示切替
            if (typeof window.updateCharucoBoardSelectUI === 'function') {
                window.updateCharucoBoardSelectUI();
            }
            // 分析タブのボード選択UIを更新
            if (typeof window.updateAnalysisBoardSelectUI === 'function') {
                window.updateAnalysisBoardSelectUI();
            }
        });
        // 初期適用
        toggleCalibrationPanels(methodSelect.value);
    }
}

// デジタイズ間隔の可視性をモードに応じて切り替え
function toggleDigitizeIntervalVisibility() {
    try {
        const input = document.getElementById('digitize-interval');
        if (!input) return;
        const container = input.closest('.action-group') || input.parentElement;
        if (!container) return;
        const mode = (typeof getCurrentMode === 'function') ? getCurrentMode() : 'calibration';
        container.style.display = (mode === 'calibration') ? 'none' : '';
    } catch (_) { }
}

/**
 * キーボードイベント設定
 */
function setupKeyboardEvents() {
    document.addEventListener('keydown', function (event) {
        // 入力フィールド内の場合（テキスト入力やテキストエリア）は通常のキー動作を許可
        // ただし、select要素の場合は矢印キーをデジタイズ操作に使用
        const isSelectElement = event.target && event.target.tagName.toLowerCase() === 'select';
        const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code);

        if (isInputField(event.target) && !isSelectElement) {
            return;
        }

        const currentTab = getCurrentActiveTab();

        // デジタイズタブがアクティブな場合のみ特殊キー処理
        if (currentTab === 'digitize') {
            // select要素にフォーカスがある場合、矢印キーはデジタイズ操作に使用
            if (isSelectElement && isArrowKey) {
                event.preventDefault();
                event.stopPropagation();
            }

            // バックスペースキー: 1コマ戻る
            if (event.key === 'Backspace') {
                event.preventDefault();
                previousFrame();
                return;
            }

            // スペースキー: 再生/一時停止
            if (event.code === 'Space') {
                event.preventDefault(); // デフォルトのスクロール動作を防止
                if (typeof togglePlayback === 'function') {
                    togglePlayback();
                } else if (typeof window.togglePlayback === 'function') {
                    window.togglePlayback();
                }
                return;
            }

            // 右矢印: 1コマ進む
            if (event.code === 'ArrowRight') {
                event.preventDefault();
                nextFrame();
                return;
            }

            // 左矢印: 1コマ戻る
            if (event.code === 'ArrowLeft') {
                event.preventDefault();
                previousFrame();
                return;
            }

            // 上矢印: 前のポイントに移動（モードに応じて）
            if (event.code === 'ArrowUp') {
                event.preventDefault();
                const currentMode = typeof getCurrentMode === 'function' ? getCurrentMode() : 'motion';
                if (currentMode === 'calibration') {
                    if (typeof previousCalPoint === 'function') {
                        previousCalPoint();
                    } else if (typeof window.previousCalPoint === 'function') {
                        window.previousCalPoint();
                    }
                } else {
                    if (typeof previousPoint === 'function') {
                        previousPoint();
                    } else if (typeof window.previousPoint === 'function') {
                        window.previousPoint();
                    }
                }
                return;
            }

            // 下矢印: 次のポイントに移動（モードに応じて）
            if (event.code === 'ArrowDown') {
                event.preventDefault();
                const currentMode = typeof getCurrentMode === 'function' ? getCurrentMode() : 'motion';
                if (currentMode === 'calibration') {
                    if (typeof nextCalPoint === 'function') {
                        nextCalPoint();
                    } else if (typeof window.nextCalPoint === 'function') {
                        window.nextCalPoint();
                    }
                } else {
                    if (typeof nextPoint === 'function') {
                        nextPoint();
                    } else if (typeof window.nextPoint === 'function') {
                        window.nextPoint();
                    }
                }
                return;
            }
        }

        // デジタイズタブ以外では何もしない（通常のキー動作を許可）
    });
}

/**
 * 入力フィールドかどうかをチェック
 */
function isInputField(element) {
    if (!element) return false;

    const inputTypes = ['input', 'textarea', 'select'];
    const tagName = element.tagName.toLowerCase();

    if (inputTypes.includes(tagName)) {
        return true;
    }

    // contenteditableプロパティを持つ要素もチェック
    if (element.contentEditable === 'true') {
        return true;
    }

    // インライン編集用のクラスを持つ要素もチェック
    if (element.classList && element.classList.contains('point-name-edit')) {
        return true;
    }

    // 親要素が入力フィールドの場合もチェック
    const parent = element.parentElement;
    if (parent && isInputField(parent)) {
        return true;
    }

    return false;
}

/**
 * 現在のタブ状態を取得する関数
 */
function getCurrentActiveTab() {
    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) {
        const onclickAttr = activeTab.getAttribute('onclick');
        const match = onclickAttr ? onclickAttr.match(/switchTab\('([^']+)'\)/) : null;
        return match ? match[1] : 'digitize';
    }
    return 'digitize'; // デフォルトはデジタイズタブ
}

/**
 * モード切り替え時に現在のタブを維持
 */
function maintainCurrentTab() {
    const currentTab = getCurrentActiveTab();
}

/**
 * 現在選択中のポイントを取得する関数（モードに応じて）
 */
function getSelectedLandmark() {
    const currentMode = getCurrentMode();
    if (currentMode === 'calibration') {
        return selectedCalibrationLandmark;
    } else {
        return selectedMotionLandmark;
    }
}

/**
 * 選択中のポイントを設定する関数（モードに応じて）
 */
function setSelectedLandmark(landmark) {
    const currentMode = getCurrentMode();
    if (currentMode === 'calibration') {
        selectedCalibrationLandmark = landmark;
    } else {
        selectedMotionLandmark = landmark;
    }
}

/**
 * モードに応じてランドマークセレクタを切り替える関数
 */
function updateLandmarkSelectorVisibility() {
    const currentMode = getCurrentMode();
    const motionSelector = document.getElementById('motion-landmark-selector');
    const calibrationSelector = document.getElementById('calibration-landmark-selector');

    if (currentMode === 'calibration') {
        motionSelector.style.display = 'none';
        calibrationSelector.style.display = 'block';
    } else {
        motionSelector.style.display = 'block';
        calibrationSelector.style.display = 'none';
    }
}

/**
 * アプリケーション初期化
 */
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    // 追加: ボタンイベント登録
    const loadVideoBtn = document.getElementById('load-video-btn');
    if (loadVideoBtn) {
        loadVideoBtn.addEventListener('click', () => window.loadVideo());
    }

    // 実長換算実行ボタン
    const calcRealBtn = document.getElementById('calculate-real-length');
    if (calcRealBtn) {
        calcRealBtn.addEventListener('click', () => {
            if (window && window.__DEBUG__) {

            }
            if (typeof window.calculateRealLength === 'function') {
                window.calculateRealLength();
            }
        });
    }

    // .rd(CSV) 出力ボタン
    const exportRdBtn = document.getElementById('export-real-length');
    if (exportRdBtn) {
        exportRdBtn.addEventListener('click', () => {

            if (typeof window.exportMotionDataToRd === 'function') {

                window.exportMotionDataToRd();
            } else {

            }
        });
    }

    // C3D 出力ボタン
    const exportC3dBtn = document.getElementById('export-c3d');
    if (exportC3dBtn) {
        exportC3dBtn.addEventListener('click', () => {
            if (typeof window.exportMotionDataToC3D === 'function') {
                window.exportMotionDataToC3D();
            } else {
                showError('C3Dエクスポート機能が利用できません');
            }
        });
    }

    // TRC 出力ボタン (OpenSim)
    const exportTrcBtn = document.getElementById('export-trc');
    if (exportTrcBtn) {
        exportTrcBtn.addEventListener('click', () => {
            if (typeof window.exportMotionDataToTRC === 'function') {
                window.exportMotionDataToTRC();
            } else {
                showError('TRCエクスポート機能が利用できません');
            }
        });
    }

    // TRC マーカーマップ読み込みボタン
    const loadMarkerMapBtn = document.getElementById('trc-load-marker-map');
    if (loadMarkerMapBtn) {
        loadMarkerMapBtn.addEventListener('click', async () => {
            if (typeof window.loadTRCMarkerMapFromFile === 'function') {
                await window.loadTRCMarkerMapFromFile();
                // ステータス表示更新
                const status = document.getElementById('trc-map-status');
                if (status && window.trcMarkerMap) {
                    status.textContent = `${Object.keys(window.trcMarkerMap).length}件読み込み済み`;
                }
            }
        });
    }

    // 選択したボードのフレームを表示ボタン（キャリブレーションタブ用）
    const showBoardFrameBtn = document.getElementById('show-selected-board-frame');
    if (showBoardFrameBtn) {
        showBoardFrameBtn.addEventListener('click', () => {
            const boardSelect = document.getElementById('charuco-board-select');
            const boardIndex = boardSelect ? parseInt(boardSelect.value || '-1', 10) : -1;

            if (boardIndex < 0) {
                if (typeof window.showError === 'function') {
                    window.showError('ボードを選択してください');
                }
                return;
            }

            const calib = window.projectData && window.projectData.calibration ? window.projectData.calibration : null;
            if (!calib || !calib.frameNumbers || !calib.frameNumbers[boardIndex]) {
                if (typeof window.showError === 'function') {
                    window.showError('選択したボードのフレーム番号が記録されていません');
                }
                return;
            }

            const frameNumber = calib.frameNumbers[boardIndex];

            // キャリブレーションモードに切り替え
            const calibrationModeRadio = document.querySelector('input[name="mode"][value="calibration"]');
            if (calibrationModeRadio) {
                calibrationModeRadio.checked = true;
                calibrationModeRadio.dispatchEvent(new Event('change'));
            }

            // フレーム番号を設定（キャリブレーションモードなのでcalibrationFrameも設定）
            if (typeof window.setCurrentFrameNumber === 'function') {
                window.setCurrentFrameNumber(frameNumber);
            } else {
                // フォールバック: 直接設定
                if (window.projectData && window.projectData.settings) {
                    window.projectData.settings.calibrationFrame = frameNumber;
                    window.projectData.settings.currentFrame = frameNumber;
                }
            }

            // フレームスライダーを更新（イベント発火前に値を設定）
            const frameSlider = document.getElementById('frame-slider');
            if (frameSlider) {
                // スライダーの値を更新（イベント発火を防ぐため、一時的にdisabledにする）
                frameSlider.value = frameNumber;
                // プロジェクトデータも更新
                if (window.projectData && window.projectData.settings) {
                    window.projectData.settings.calibrationFrame = frameNumber;
                    window.projectData.settings.currentFrame = frameNumber;
                }
                // フレーム情報を更新
                if (typeof window.updateFrameInfo === 'function') {
                    window.updateFrameInfo();
                }
                // フレーム表示を更新
                setTimeout(() => {
                    if (typeof window.displayCurrentFrame === 'function') {
                        window.displayCurrentFrame();
                    }
                }, 100);
            }

            // デジタイズタブに切り替え
            if (typeof window.switchTab === 'function') {
                window.switchTab('digitize');
            }

            if (typeof window.showMessage === 'function') {
                window.showMessage(`ボード #${boardIndex + 1}のフレーム ${frameNumber} を表示しました`);
            }
        });
    }

    // Vicon XCP ロードボタン
    const loadXcpBtn = document.getElementById('load-vicon-xcp-btn');
    if (loadXcpBtn) {
        loadXcpBtn.addEventListener('click', () => {
            if (typeof window.loadViconXcpFile === 'function') {
                window.loadViconXcpFile();
            } else {
                showError('XCP読み込み機能が利用できません');
            }
        });
    }

    // Vicon XCP カメラ選択
    ['vicon-camera-a', 'vicon-camera-b'].forEach(id => {
        const sel = document.getElementById(id);
        if (sel) {
            sel.addEventListener('change', () => handleViconCameraSelectChange());
        }
    });

    // Vicon 三角測量実行
    const runViconBtn = document.getElementById('run-vicon-triangulation');
    if (runViconBtn) {
        runViconBtn.addEventListener('click', () => runViconTriangulation());
    }

    window.addEventListener('vicon-calibration-loaded', (event) => {
        handleViconCalibrationLoaded(event?.detail);
    });

    // キャリブレーション方法の変更イベントを追加
    const calibrationMethodSelect = document.getElementById('calibration-method');
    if (calibrationMethodSelect) {
        calibrationMethodSelect.addEventListener('change', function () {
            // 必要カメラ数の表示を更新
            updateCameraRequirementUI();
            // Charuco関連UIの表示切替
            try { updateCharucoSidebarVisibility(); } catch (_) { }
            // キャリブタブのモード別UI切替
            try { toggleCalibrationPanels(this.value); } catch (_) { }
            // 3次元CC法 UI の表示切替
            try { handleCCMethodVisibility(this.value); } catch (_) { }
            // ChArUcoボード選択UIの表示切替
            try { if (typeof window.updateCharucoBoardSelectUI === 'function') window.updateCharucoBoardSelectUI(); } catch (_) { }
            // 分析タブのボード選択UIを更新
            try { if (typeof window.updateAnalysisBoardSelectUI === 'function') window.updateAnalysisBoardSelectUI(); } catch (_) { }
            // ChArUco以外へ切替時は連続検出を停止
            try {
                const method = this.value;
                if (method !== 'charuco-single' && method !== 'charuco-stereo') {
                    if (typeof window.stopCharucoAutoDetection === 'function') {
                        window.stopCharucoAutoDetection();
                    }
                }
            } catch (_) { }
        });
    }

    // 初期ワークフローステップ更新
    updateWorkflowSteps();

    // キーボードイベントリスナーを追加
    setupKeyboardEvents();
    // Charuco関連UIの初期表示切替
    try { updateCharucoSidebarVisibility(); } catch (_) { }
    // キャリブタブのモード別UI初期表示
    try {
        const initialMethod = document.getElementById('calibration-method')?.value || '2d-dlt-single';
        toggleCalibrationPanels(initialMethod);
        handleCCMethodVisibility(initialMethod);
    } catch (_) { }

    // マーカー間距離入力のイベント設定
    try {
        if (typeof window.setupMarkerDistanceInput === 'function') {
            window.setupMarkerDistanceInput();
        }
    } catch (_) { }

    updateViconTriangulationButtonState();
});

// -------- 3次元CC法 UI: 表示切替とダミーイベント --------
window.handleCCMethodVisibility = function handleCCMethodVisibility(method) {
    const isCCMethod = (method === '3d-cc-method');

    // CC法専用のUI要素を3次元CC法選択時のみ表示
    const ccElements = [
        'cc-method-container',      // CC法メインコンテナ
        'cc-camera-positions',      // カメラ初期位置設定
        'cc-actions',               // CC法キャリブレーション実行ボタン
        'cc-progress',              // 進捗表示
        'cc-visualization'          // 最適化過程・再投影誤差の推移
    ];

    ccElements.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.display = isCCMethod ? 'block' : 'none';
        }
    });

    // 3次元CC法が選択されたときにテーブルを更新
    if (isCCMethod && typeof updateCCControlPointsTable === 'function') {
        updateCCControlPointsTable();
    }
}

// 3次元CC法用制御点データ（グローバル）
if (!window.ccControlPoints) {
    window.ccControlPoints = [];
}
// 選択中の制御点インデックス
window.selectedCCControlPointIndex = -1;

// CC法制御点テーブルの更新
function updateCCControlPointsTable() {
    const tbody = document.getElementById('cc-cp-table')?.querySelector('tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    const points = window.ccControlPoints || [];
    const selectedIdx = window.selectedCCControlPointIndex || -1;

    points.forEach((cp, idx) => {
        const row = document.createElement('tr');
        const isSelected = idx === selectedIdx;
        const rowStyle = isSelected ? 'background-color: #e3f2fd;' : '';
        row.style.cssText = rowStyle;
        row.setAttribute('data-cp-index', idx);

        // 誤差の表示（評価後）
        const xe = cp.errors?.x !== undefined ? cp.errors.x.toFixed(3) : '';
        const ye = cp.errors?.y !== undefined ? cp.errors.y.toFixed(3) : '';
        const ze = cp.errors?.z !== undefined ? cp.errors.z.toFixed(3) : '';
        const err = cp.errors?.total !== undefined ? cp.errors.total.toFixed(3) : '';
        const errorStyle = cp.errors?.total && cp.errors.total > 0.05 ? 'background-color: #fff3cd;' : '';

        row.innerHTML = `
            <td>CP${idx + 1}</td>
            <td><input type="number" class="cc-cp-x" step="0.001" value="${cp.realCoords?.x || 0}" style="width:80px;"></td>
            <td><input type="number" class="cc-cp-y" step="0.001" value="${cp.realCoords?.y || 0}" style="width:80px;"></td>
            <td><input type="number" class="cc-cp-z" step="0.001" value="${cp.realCoords?.z || 0}" style="width:80px;"></td>
            <td><input type="number" class="cc-cp-u1" step="0.1" value="${cp.imageCoords?.u || 0}" style="width:80px;"></td>
            <td><input type="number" class="cc-cp-v1" step="0.1" value="${cp.imageCoords?.v || 0}" style="width:80px;"></td>
            <td><input type="number" class="cc-cp-u2" step="0.1" value="${cp.imageCoords2?.u || 0}" style="width:80px;"></td>
            <td><input type="number" class="cc-cp-v2" step="0.1" value="${cp.imageCoords2?.v || 0}" style="width:80px;"></td>
            <td><input type="checkbox" class="cc-cp-enabled" ${cp.enabled !== false ? 'checked' : ''}></td>
        `;

        // 行クリックで選択状態にする（チェックボックスと入力欄以外）
        row.addEventListener('click', (e) => {
            if (e.target.tagName !== 'INPUT') {
                window.selectedCCControlPointIndex = idx;
                updateCCControlPointsTable(); // 再描画して選択状態を反映
                if (typeof window.showMessage === 'function') {
                    window.showMessage(`CP${idx + 1}を選択しました。キャンバス上でクリックして画像座標を設定してください。`);
                }
            }
        });

        // 入力変更時にデータを更新
        row.querySelectorAll('input').forEach(input => {
            input.addEventListener('change', () => {
                const rowIdx = Array.from(tbody.children).indexOf(row);
                if (rowIdx >= 0 && rowIdx < window.ccControlPoints.length) {
                    const cp = window.ccControlPoints[rowIdx];
                    if (input.classList.contains('cc-cp-x')) cp.realCoords = cp.realCoords || {}; cp.realCoords.x = parseFloat(input.value) || 0;
                    if (input.classList.contains('cc-cp-y')) cp.realCoords = cp.realCoords || {}; cp.realCoords.y = parseFloat(input.value) || 0;
                    if (input.classList.contains('cc-cp-z')) cp.realCoords = cp.realCoords || {}; cp.realCoords.z = parseFloat(input.value) || 0;
                    if (input.classList.contains('cc-cp-u1')) cp.imageCoords = cp.imageCoords || {}; cp.imageCoords.u = parseFloat(input.value) || 0;
                    if (input.classList.contains('cc-cp-v1')) cp.imageCoords = cp.imageCoords || {}; cp.imageCoords.v = parseFloat(input.value) || 0;
                    if (input.classList.contains('cc-cp-u2')) cp.imageCoords2 = cp.imageCoords2 || {}; cp.imageCoords2.u = parseFloat(input.value) || 0;
                    if (input.classList.contains('cc-cp-v2')) cp.imageCoords2 = cp.imageCoords2 || {}; cp.imageCoords2.v = parseFloat(input.value) || 0;
                    if (input.classList.contains('cc-cp-enabled')) cp.enabled = input.checked;
                }
            });
        });

        tbody.appendChild(row);
    });
}

function initCCMethodUIBindings() {
    const runBtn = document.getElementById('cc-run');
    const cancelBtn = document.getElementById('cc-cancel');
    const importBtn = document.getElementById('cc-import-asc');
    const exportBtn = document.getElementById('cc-export-asc');
    const planePresetBtn = document.getElementById('cc-plane-preset');
    const addBtn = document.getElementById('cc-add-cp');
    const delBtn = document.getElementById('cc-del-cp');
    const pasteBtn = document.getElementById('cc-paste-cp');

    // 制御点追加
    if (addBtn) addBtn.addEventListener('click', () => {
        if (!window.ccControlPoints) window.ccControlPoints = [];
        window.ccControlPoints.push({
            realCoords: { x: 0, y: 0, z: 0 },
            imageCoords: { u: 0, v: 0 },
            imageCoords2: { u: 0, v: 0 },
            enabled: true
        });
        updateCCControlPointsTable();
    });

    // 制御点削除
    if (delBtn) delBtn.addEventListener('click', () => {
        const tbody = document.getElementById('cc-cp-table')?.querySelector('tbody');
        if (!tbody) return;
        const checked = Array.from(tbody.querySelectorAll('input[type="checkbox"]:checked'));
        if (checked.length === 0) {
            if (typeof window.showError === 'function') window.showError('削除する行を選択してください');
            return;
        }
        checked.forEach(cb => {
            const row = cb.closest('tr');
            const idx = Array.from(tbody.children).indexOf(row);
            if (idx >= 0) {
                window.ccControlPoints.splice(idx, 1);
            }
        });
        updateCCControlPointsTable();
    });

    // 貼り付け（クリップボードから）
    if (pasteBtn) pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            const lines = text.trim().split('\n').filter(l => l.trim());
            if (lines.length === 0) {
                if (typeof window.showError === 'function') window.showError('クリップボードが空です');
                return;
            }

            const newPoints = [];
            lines.forEach(line => {
                const parts = line.split(/[\s,]+/).filter(p => p);
                if (parts.length >= 5) {
                    newPoints.push({
                        realCoords: {
                            x: parseFloat(parts[0]) || 0,
                            y: parseFloat(parts[1]) || 0,
                            z: parseFloat(parts[2]) || 0
                        },
                        imageCoords: {
                            u: parseFloat(parts[3]) || 0,
                            v: parseFloat(parts[4]) || 0
                        },
                        imageCoords2: {
                            u: parts.length >= 7 ? parseFloat(parts[5]) || 0 : 0,
                            v: parts.length >= 7 ? parseFloat(parts[6]) || 0 : 0
                        },
                        enabled: true
                    });
                }
            });

            if (newPoints.length > 0) {
                if (!window.ccControlPoints) window.ccControlPoints = [];
                window.ccControlPoints.push(...newPoints);
                updateCCControlPointsTable();
                if (typeof window.showMessage === 'function') window.showMessage(`${newPoints.length}個の制御点を追加しました`);
            }
        } catch (e) {
            if (typeof window.showError === 'function') window.showError('貼り付けエラー: ' + e.message);
        }
    });

    // ASC/CSV取込
    if (importBtn) importBtn.addEventListener('click', async () => {
        try {
            const result = await ipcRenderer.invoke('select-file', {
                filters: [
                    { name: 'ASC/CSV', extensions: ['asc', 'csv', 'txt'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });

            if (!result || !result.success || !result.filePath) return;

            const readResult = await ipcRenderer.invoke('read-text-file', result.filePath);
            if (!readResult || !readResult.success) {
                if (typeof window.showError === 'function') window.showError('ファイル読み込みエラー: ' + (readResult?.error || '不明'));
                return;
            }

            // ASCファイルパース
            if (typeof window.CCMethod !== 'undefined' && window.CCMethod.parseASCFile) {
                const parsed = window.CCMethod.parseASCFile(readResult.content);
                if (parsed.success && parsed.points) {
                    if (!window.ccControlPoints) window.ccControlPoints = [];
                    parsed.points.forEach((pt, idx) => {
                        window.ccControlPoints.push({
                            realCoords: { x: 0, y: 0, z: 0 }, // ASCには実座標がないので0
                            imageCoords: { u: pt.u, v: pt.v },
                            enabled: true
                        });
                    });
                    updateCCControlPointsTable();
                    if (typeof window.showMessage === 'function') window.showMessage(`${parsed.points.length}個の制御点を読み込みました（実座標は手動で入力してください）`);
                } else {
                    if (typeof window.showError === 'function') window.showError('ASCファイルの解析に失敗しました');
                }
            } else {
                // シンプルなCSV形式（u,v, x,y,z または x,y,z, u,v）
                const lines = readResult.content.trim().split('\n').filter(l => l.trim());
                const newPoints = [];
                lines.forEach(line => {
                    const parts = line.split(/[\s,]+/).filter(p => p);
                    if (parts.length >= 5) {
                        // 最初の2つがu,v、次の3つがx,y,zと仮定
                        newPoints.push({
                            realCoords: {
                                x: parseFloat(parts[2]) || 0,
                                y: parseFloat(parts[3]) || 0,
                                z: parseFloat(parts[4]) || 0
                            },
                            imageCoords: {
                                u: parseFloat(parts[0]) || 0,
                                v: parseFloat(parts[1]) || 0
                            },
                            enabled: true
                        });
                    }
                });
                if (newPoints.length > 0) {
                    if (!window.ccControlPoints) window.ccControlPoints = [];
                    window.ccControlPoints.push(...newPoints);
                    updateCCControlPointsTable();
                    if (typeof window.showMessage === 'function') window.showMessage(`${newPoints.length}個の制御点を読み込みました`);
                }
            }
        } catch (e) {
            if (typeof window.showError === 'function') window.showError('取込エラー: ' + e.message);
        }
    });

    // ASC/CSVエクスポート
    if (exportBtn) exportBtn.addEventListener('click', async () => {
        const points = (window.ccControlPoints || []).filter(cp => cp.enabled !== false);
        if (points.length === 0) {
            if (typeof window.showError === 'function') window.showError('エクスポートする制御点がありません');
            return;
        }

        try {
            const result = await ipcRenderer.invoke('save-file', {
                filters: [
                    { name: 'CSV', extensions: ['csv'] },
                    { name: 'ASC', extensions: ['asc'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
                defaultPath: 'cc_control_points.csv'
            });

            if (!result || !result.success || !result.filePath) return;

            // CSV形式で出力（u,v, x,y,z）
            const lines = points.map(cp => {
                const u = cp.imageCoords?.u || 0;
                const v = cp.imageCoords?.v || 0;
                const x = cp.realCoords?.x || 0;
                const y = cp.realCoords?.y || 0;
                const z = cp.realCoords?.z || 0;
                return `${u},${v},${x},${y},${z}`;
            });

            const content = lines.join('\n');
            const writeResult = await ipcRenderer.invoke('write-text-file', result.filePath, content);

            if (writeResult && writeResult.success) {
                if (typeof window.showMessage === 'function') window.showMessage(`${points.length}個の制御点をエクスポートしました`);
            } else {
                if (typeof window.showError === 'function') window.showError('エクスポートエラー: ' + (writeResult?.error || '不明'));
            }
        } catch (e) {
            if (typeof window.showError === 'function') window.showError('エクスポートエラー: ' + e.message);
        }
    });

    // 地面Z=0を適用
    if (planePresetBtn) planePresetBtn.addEventListener('click', () => {
        const tbody = document.getElementById('cc-cp-table')?.querySelector('tbody');
        if (!tbody) return;
        const inputs = tbody.querySelectorAll('.cc-cp-z');
        inputs.forEach(input => {
            input.value = '0';
            const row = input.closest('tr');
            const idx = Array.from(tbody.children).indexOf(row);
            if (idx >= 0 && idx < window.ccControlPoints.length) {
                const cp = window.ccControlPoints[idx];
                if (!cp.realCoords) cp.realCoords = {};
                cp.realCoords.z = 0;
            }
        });
        if (typeof window.showMessage === 'function') window.showMessage('すべての制御点のZ座標を0に設定しました');
    });

    // 外部パラメータ読み込み (Cam1)
    const loadCam1Btn = document.getElementById('cc-load-internal-params-cam1');
    const clearCam1Btn = document.getElementById('cc-clear-internal-params-cam1');
    const statusCam1 = document.getElementById('cc-internal-params-status-cam1');

    if (loadCam1Btn) loadCam1Btn.addEventListener('click', async () => {
        try {
            const result = await ipcRenderer.invoke('select-file', {
                filters: [{ name: 'Camera Parameters', extensions: ['cprm'] }, { name: 'All Files', extensions: ['*'] }]
            });
            if (!result || !result.success || !result.filePath) return;

            const readResult = await ipcRenderer.invoke('read-text-file', result.filePath);
            const content = (readResult && readResult.content) ? readResult.content : readResult;
            const data = (typeof content === 'string') ? JSON.parse(content) : content;

            // cameraMatrixからパラメータ抽出: [fx, 0, cx, 0, fy, cy, 0, 0, 1]
            if (data.cameraMatrix && Array.isArray(data.cameraMatrix)) {
                // U0/V0は動画の画像中心に強制固定（CC法の拘束条件）
                const vidEl = document.getElementById('digitize-video-cam1') || document.getElementById('digitize-video');
                const vw = vidEl?.videoWidth || window.projectData?.settings?.videoWidth || 1920;
                const vh = vidEl?.videoHeight || window.projectData?.settings?.videoHeight || 1080;
                window.ccFixedInternalParams1 = {
                    F: (data.cameraMatrix[0] + data.cameraMatrix[4]) / 2,
                    U0: vw / 2,
                    V0: vh / 2,
                    sourceFile: result.filePath
                };
                if (statusCam1) statusCam1.textContent = `Cam1: ${result.filePath.split(/[\\/]/).pop()} 適用中 (U0/V0=画像中心固定)`;
                if (clearCam1Btn) clearCam1Btn.style.display = 'inline-block';
                if (typeof window.showMessage === 'function') window.showMessage(`Cam1の内部パラメータを適用しました（U0=${vw / 2}, V0=${vh / 2} 画像中心固定）`);
            }
        } catch (e) {
            console.error('Error loading cam1 params:', e);
            if (typeof window.showError === 'function') window.showError('ファイル読み込みに失敗しました');
        }
    });

    if (clearCam1Btn) clearCam1Btn.addEventListener('click', () => {
        window.ccFixedInternalParams1 = null;
        if (statusCam1) statusCam1.textContent = 'Cam1: 未適用';
        clearCam1Btn.style.display = 'none';
    });

    // 外部パラメータ読み込み (Cam2)
    const loadCam2Btn = document.getElementById('cc-load-internal-params-cam2');
    const clearCam2Btn = document.getElementById('cc-clear-internal-params-cam2');
    const statusCam2 = document.getElementById('cc-internal-params-status-cam2');

    if (loadCam2Btn) loadCam2Btn.addEventListener('click', async () => {
        try {
            const result = await ipcRenderer.invoke('select-file', {
                filters: [{ name: 'Camera Parameters', extensions: ['cprm'] }, { name: 'All Files', extensions: ['*'] }]
            });
            if (!result || !result.success || !result.filePath) return;

            const readResult = await ipcRenderer.invoke('read-text-file', result.filePath);
            const content = (readResult && readResult.content) ? readResult.content : readResult;
            const data = (typeof content === 'string') ? JSON.parse(content) : content;

            if (data.cameraMatrix && Array.isArray(data.cameraMatrix)) {
                // U0/V0は動画の画像中心に強制固定（CC法の拘束条件）
                const vidEl2 = document.getElementById('digitize-video-cam2') || document.getElementById('digitize-video');
                const vw2 = vidEl2?.videoWidth || window.projectData?.settings?.videoWidth || 1920;
                const vh2 = vidEl2?.videoHeight || window.projectData?.settings?.videoHeight || 1080;
                window.ccFixedInternalParams2 = {
                    F: (data.cameraMatrix[0] + data.cameraMatrix[4]) / 2,
                    U0: vw2 / 2,
                    V0: vh2 / 2,
                    sourceFile: result.filePath
                };
                if (statusCam2) statusCam2.textContent = `Cam2: ${result.filePath.split(/[\\/]/).pop()} 適用中 (U0/V0=画像中心固定)`;
                if (clearCam2Btn) clearCam2Btn.style.display = 'inline-block';
                if (typeof window.showMessage === 'function') window.showMessage(`Cam2の内部パラメータを適用しました（U0=${vw2 / 2}, V0=${vh2 / 2} 画像中心固定）`);
            }
        } catch (e) {
            console.error('Error loading cam2 params:', e);
            if (typeof window.showError === 'function') window.showError('ファイル読み込みに失敗しました');
        }
    });

    if (clearCam2Btn) clearCam2Btn.addEventListener('click', () => {
        window.ccFixedInternalParams2 = null;
        if (statusCam2) statusCam2.textContent = 'Cam2: 未適用';
        clearCam2Btn.style.display = 'none';
    });

    // キャリブレーション実行
    if (runBtn) runBtn.addEventListener('click', async () => {
        console.log('[CC法] キャリブレーション実行ボタンがクリックされました');

        // 進捗表示の初期化
        const status = document.getElementById('cc-status');
        const progressFill = document.getElementById('cc-progress-fill');
        const ccLog = document.getElementById('cc-log');

        if (status) status.textContent = 'データ確認中...';
        if (progressFill) progressFill.style.width = '5%';
        if (ccLog) ccLog.textContent = '[開始] CC法キャリブレーション\n';

        // 既存のキャリブレーションテーブル（calibrationData.points）からデータを取得
        const allPoints = window.calibrationData?.points || [];
        console.log('[CC法] calibrationData.points:', allPoints);
        if (ccLog) ccLog.textContent += `[情報] キャリブレーションテーブルのポイント数: ${allPoints.length}\n`;

        const calPoints = allPoints.filter(p => {
            // デジタイズ座標と実空間座標が入力されているポイントのみ使用
            const hasCam1 = p.digitizedCoords?.cam1?.x != null && p.digitizedCoords?.cam1?.y != null;
            const hasReal = p.realCoords?.x != null || p.realCoords?.y != null || p.realCoords?.z != null;
            console.log(`[CC法] ポイント ${p.id}: hasCam1=${hasCam1}, hasReal=${hasReal}`, p);
            return hasCam1 && hasReal;
        });

        console.log('[CC法] 有効な制御点数:', calPoints.length);
        if (ccLog) ccLog.textContent += `[情報] 有効な制御点数: ${calPoints.length}\n`;

        if (calPoints.length < 3) {
            const msg = `最低3点の制御点が必要です（現在: ${calPoints.length}点）。\nキャリブレーションテーブルにデジタイズ座標(u,v)と実空間座標(X,Y,Z)を入力してください。`;
            if (status) status.textContent = 'エラー';
            if (ccLog) ccLog.textContent += `[エラー] ${msg}\n`;
            if (typeof window.showError === 'function') {
                window.showError(msg);
            }
            return;
        }

        // 制御点データを準備（calibrationData.pointsの形式からCC法の形式に変換）
        const controlPoints = calPoints.map(p => ({
            realCoords: {
                x: p.realCoords?.x || 0,
                y: p.realCoords?.y || 0,
                z: p.realCoords?.z || 0
            },
            imageCoords: {
                u: p.digitizedCoords?.cam1?.x || 0,
                v: p.digitizedCoords?.cam1?.y || 0
            },
            // カメラ2の座標も保持（将来のステレオCC法用）
            imageCoords2: {
                u: p.digitizedCoords?.cam2?.x || 0,
                v: p.digitizedCoords?.cam2?.y || 0
            }
        }));

        // CCMethodが読み込まれているか確認
        if (typeof window.CCMethod === 'undefined' || !window.CCMethod.perform3DCCCalibration) {
            const msg = '3次元CC法モジュールが読み込まれていません。ページを再読み込みしてください。';
            console.error('[CC法] CCMethodモジュールが未定義:', window.CCMethod);
            if (ccLog) ccLog.textContent += `[エラー] ${msg}\n`;
            if (status) status.textContent = 'エラー';
            if (typeof window.showError === 'function') window.showError(msg);
            return;
        }

        console.log('[CC法] CCMethodモジュールが利用可能');
        if (ccLog) ccLog.textContent += '[情報] CC法モジュール確認OK\n';

        const progressGen = document.getElementById('cc-gen');
        const progressBest = document.getElementById('cc-best');

        if (status) status.textContent = '最適化実行中...';
        if (progressFill) progressFill.style.width = '10%';
        if (progressGen) progressGen.textContent = '0';
        if (progressBest) progressBest.textContent = '-';
        if (ccLog) ccLog.textContent += '[情報] 最適化を開始します...\n';

        // 解像度を取得（video要素から直接取得 → projectData → デフォルト1920x1080の順）
        const vidForRes = document.getElementById('digitize-video-cam1') || document.getElementById('digitize-video');
        const resolution = [
            (vidForRes?.videoWidth > 0 ? vidForRes.videoWidth : null) || window.projectData?.settings?.videoWidth || 1920,
            (vidForRes?.videoHeight > 0 ? vidForRes.videoHeight : null) || window.projectData?.settings?.videoHeight || 1080
        ];
        console.log(`[CC法] 使用する解像度: ${resolution[0]}x${resolution[1]}`);

        // カメラ1の初期位置をUIから取得
        const cam1XEl = document.getElementById('cc-cam1-x');
        const cam1YEl = document.getElementById('cc-cam1-y');
        const cam1ZEl = document.getElementById('cc-cam1-z');
        const cam1X = cam1XEl ? parseFloat(cam1XEl.value) : -40;
        const cam1Y = cam1YEl ? parseFloat(cam1YEl.value) : -10;
        const cam1Z = cam1ZEl ? parseFloat(cam1ZEl.value) : 13;
        const initialCameraPosition1 = [cam1X, cam1Y, cam1Z];

        // カメラ2の初期位置をUIから取得
        const cam2XEl = document.getElementById('cc-cam2-x');
        const cam2YEl = document.getElementById('cc-cam2-y');
        const cam2ZEl = document.getElementById('cc-cam2-z');
        const cam2X = cam2XEl ? parseFloat(cam2XEl.value) : 40;
        const cam2Y = cam2YEl ? parseFloat(cam2YEl.value) : -10;
        const cam2Z = cam2ZEl ? parseFloat(cam2ZEl.value) : 13;
        const initialCameraPosition2 = [cam2X, cam2Y, cam2Z];

        // 探索範囲を取得
        const searchRangeSelect = document.getElementById('cc-search-range');
        let searchRange = [5, 5, 3, Math.PI / 10, Math.PI / 10, Math.PI / 10];
        if (searchRangeSelect) {
            if (searchRangeSelect.value === 'wide') {
                searchRange = [30, 30, 20, Math.PI, Math.PI, Math.PI];
            } else if (searchRangeSelect.value === 'narrow') {
                searchRange = [2, 2, 1, Math.PI / 20, Math.PI / 20, Math.PI / 20];
            }
        }

        try {
            const startTime = performance.now(); // 計測開始

            // 非同期で実行（UIブロック回避）
            const result = await new Promise((resolve) => {
                setTimeout(() => {
                    // 初期化メソッドの取得
                    const initMethodEl = document.getElementById('cc-init-method');
                    const initMethod = initMethodEl ? initMethodEl.value : 'auto';

                    const calibResult = window.CCMethod.perform3DCCCalibration({
                        controlPoints: controlPoints,
                        resolution: resolution,
                        initialCameraPosition1: initialCameraPosition1,
                        initialCameraPosition2: initialCameraPosition2,
                        searchRange: searchRange,
                        options: {
                            gridSteps: 5,
                            numTrials: 5, // 5回試行して最良の結果を採用
                            generations: 200, // GA世代数を増やす
                            populationSize: 300, // GA個体数を増やす
                            maxIterations: 5000,
                            tolerance: 1e-8,
                            fixedInternalParams1: window.ccFixedInternalParams1,
                            fixedInternalParams2: window.ccFixedInternalParams2,
                            initMethod: initMethod,
                            estimateFocal: document.getElementById('cc-estimate-focal')?.checked,
                            twoStepOptimization: document.getElementById('cc-two-step')?.checked
                        },
                        onProgress: (stage, currentErr, bestErr) => {
                            if (status) status.textContent = stage;
                            if (ccLog) ccLog.textContent += `[進捗] ${stage}`;
                            if (currentErr !== null) ccLog.textContent += ` (現在: ${currentErr.toFixed(3)})`;
                            if (bestErr !== null) {
                                ccLog.textContent += ` (最良: ${bestErr.toFixed(3)})`;
                                if (progressBest) progressBest.textContent = bestErr.toFixed(3);
                            }
                            ccLog.textContent += '\n';

                            // スクロールを下に
                            ccLog.scrollTop = ccLog.scrollHeight;
                        }
                    });

                    // 実行時間を記録
                    const endTime = performance.now();
                    calibResult.execTime = endTime - startTime;

                    resolve(calibResult);
                }, 10);
            });

            if (result.success) {
                // 各制御点の誤差を計算して保存
                if (result.errorStats && result.errorStats.perPoint) {
                    result.errorStats.perPoint.forEach((err, idx) => {
                        if (idx < calPoints.length) {
                            // calPointsはcalibrationData.pointsの参照を持っているので、直接更新可能
                            const cp = calPoints[idx];
                            if (!cp.errors) cp.errors = {};
                            cp.errors.x = err.dx || 0;
                            cp.errors.y = err.dy || 0;
                            cp.errors.z = err.dz || 0;
                            cp.errors.total = err.error || 0;

                            console.log(`[CC法] ポイント ${cp.id} の誤差更新:`, cp.errors);
                        }
                    });
                }

                // 結果をプロジェクトデータに保存
                if (!window.projectData) window.projectData = {};
                window.projectData.ccCalibration = {
                    cameraParams: result.cameraParams, // Cam1
                    dltParams: result.dltParams,      // Cam1
                    stereoDLTParams: result.stereoDLTParams, // [Cam1, Cam2]
                    results: result.results,           // 詳細データ
                    errorStats: result.errorStats
                };

                // 既存のDLT計算ロジックとの互換性のため dltCalibration にも保存
                if (result.stereoDLTParams && result.stereoDLTParams[0] && result.stereoDLTParams[1]) {
                    window.projectData.dltCalibration = {
                        method: '3d-DLT', // 計算上はDLT係数を使うため
                        params: result.stereoDLTParams,
                        rms: result.errorStats.rms
                    };
                    console.log('[CC法] DLTパラメータを dltCalibration にも適用しました');
                }

                // 結果をUIに表示
                displayCCMethodResults(result);

                // キャリブレーションテーブルを更新（誤差を表示）
                if (typeof window.updateCalibrationDataTable === 'function') {
                    window.updateCalibrationDataTable();
                }

                if (status) status.textContent = '完了';
                if (progressFill) progressFill.style.width = '100%';

                // 進捗パネルの「最良誤差」を最終RMS (NM局所最適化後) に同期
                // GA段階の最後の値で止まっていると、結果パネルの値と食い違って見えるため。
                const finalRms = result.errorStats.rms;
                if (progressBest) progressBest.textContent = finalRms.toFixed(3);
                if (progressGen) progressGen.textContent = '完了';

                const msg = `3次元CC法キャリブレーション完了（RMS誤差: ${finalRms.toFixed(3)} px）`;
                if (ccLog) {
                    const cam1Rms = result.results?.cam1?.errorStats?.rms;
                    const cam2Rms = result.results?.cam2?.errorStats?.rms;
                    if (typeof cam1Rms === 'number') ccLog.textContent += `[結果] Cam1 最終RMS (NM後): ${cam1Rms.toFixed(3)} px\n`;
                    if (typeof cam2Rms === 'number') ccLog.textContent += `[結果] Cam2 最終RMS (NM後): ${cam2Rms.toFixed(3)} px\n`;
                    ccLog.textContent += `[成功] ${msg}\n`;
                    ccLog.scrollTop = ccLog.scrollHeight;
                }
                if (typeof window.showMessage === 'function') {
                    window.showMessage(msg);
                }
            } else {
                if (status) status.textContent = 'エラー';
                if (typeof window.showError === 'function') window.showError('キャリブレーション失敗: ' + (result.error || '不明'));
            }
        } catch (e) {
            if (status) status.textContent = 'エラー';
            if (typeof window.showError === 'function') window.showError('キャリブレーションエラー: ' + e.message);
        }
    });

    // キャリブレーション中止
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
        const status = document.getElementById('cc-status');
        if (status) status.textContent = '中止';
        if (typeof window.showMessage === 'function') window.showMessage('キャリブレーションを中止しました');
    });

    // 入力補助ボタン（レーザー距離計からの算出）
    if (inputAssistBtn) inputAssistBtn.addEventListener('click', () => {
        if (typeof window.showMessage === 'function') {
            window.showMessage('入力補助機能は今後実装予定です。現在は手動でカメラ位置座標を入力してください。');
        }
        // TODO: レーザー距離計からのカメラ位置算出機能を実装
    });

    // 初期テーブル更新
    updateCCControlPointsTable();
}

// CC法結果表示
function displayCCMethodResults(result) {
    if (!result || !result.success) return;

    // カメラパラメータテーブル更新
    const tbody = document.getElementById('cc-camera-params-body');
    if (tbody) {
        tbody.innerHTML = '';

        const cam1 = result.results?.cam1?.cameraParams || result.cameraParams;
        const cam2 = result.results?.cam2?.cameraParams || null;

        const formatVal = (v) => (v !== undefined && v !== null) ? v.toFixed(3) : '-';
        const formatInt = (v) => (v !== undefined && v !== null) ? Math.round(v).toString() : '-';
        const toDeg = (rad) => (rad !== undefined && rad !== null) ? (rad * 180 / Math.PI).toFixed(2) : '-';

        const params = [
            { label: 'U0 (画像中心X)', val1: cam1?.U0, val2: cam2?.U0, fmt: formatInt },
            { label: 'V0 (画像中心Y)', val1: cam1?.V0, val2: cam2?.V0, fmt: formatInt },
            { label: 'F (焦点距離)', val1: cam1?.F, val2: cam2?.F, fmt: formatVal },
            { label: 'X0 (カメラ位置X)', val1: cam1?.X0, val2: cam2?.X0, fmt: formatVal },
            { label: 'Y0 (カメラ位置Y)', val1: cam1?.Y0, val2: cam2?.Y0, fmt: formatVal },
            { label: 'Z0 (カメラ位置Z)', val1: cam1?.Z0, val2: cam2?.Z0, fmt: formatVal },
            { label: 'ω (回転角X)', val1: cam1?.omega, val2: cam2?.omega, fmt: toDeg },
            { label: 'φ (回転角Y)', val1: cam1?.phi, val2: cam2?.phi, fmt: toDeg },
            { label: 'κ (回転角Z)', val1: cam1?.kappa, val2: cam2?.kappa, fmt: toDeg }
        ];

        params.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td style="font-weight:bold; white-space:nowrap; padding:2px 6px;">${p.label}</td>
                            <td style="text-align:right; padding:2px 6px;">${p.fmt(p.val1)}</td>
                            <td style="text-align:right; padding:2px 6px;">${p.fmt(p.val2)}</td>`;
            tbody.appendChild(tr);
        });
    }

    const { errorStats } = result;

    // テキスト設定ヘルパー
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(val);
    };

    // 誤差統計
    const rms = errorStats.rms;
    if (typeof window.setCalibErrorValue === 'function') {
        window.setCalibErrorValue('cc-reproj-error', rms, null);
    } else {
        setText('cc-reproj-error', rms.toFixed(3));
    }
    setText('cc-point-count', errorStats.perPoint?.length || 0);

    // 実行時間と収束世代数
    if (result.execTime !== undefined) {
        setText('cc-exec-time', Math.round(result.execTime));
    }

    // 品質カード更新
    const CC_SCALE_MAX = 3.0;
    // "RMS誤差 X.XXX px (Y.YYY mm)" 形式。mm概算が取れない場合はpxのみ。
    const _mmFactor = (typeof window.getPixelToMmFactor === 'function') ? window.getPixelToMmFactor() : null;
    const _rmsMm = _mmFactor ? (rms * _mmFactor * 1000) : null;
    const rmsText = (_rmsMm !== null && isFinite(_rmsMm))
        ? `${rms.toFixed(3)} px (${_rmsMm.toFixed(3)} mm)`
        : `${rms.toFixed(3)} px`;
    let ccQualityLevel, ccQualityIcon, ccQualityBadge, ccQualityDesc;
    if (rms <= 0.5) {
        ccQualityLevel = 'excellent'; ccQualityIcon = 'verified'; ccQualityBadge = '非常に良好';
        ccQualityDesc = `RMS誤差 ${rmsText} は非常に良好です。高精度な3D計測が期待できます。`;
    } else if (rms <= 1.0) {
        ccQualityLevel = 'good'; ccQualityIcon = 'check_circle'; ccQualityBadge = '良好';
        ccQualityDesc = `RMS誤差 ${rmsText} は良好な範囲です。スポーツ動作解析などの用途に適しています。`;
    } else if (rms <= 2.0) {
        ccQualityLevel = 'fair'; ccQualityIcon = 'warning'; ccQualityBadge = '普通';
        ccQualityDesc = `RMS誤差 ${rmsText} はやや大きめです。コントロールポイントの配置・座標を確認してください。`;
    } else {
        ccQualityLevel = 'poor'; ccQualityIcon = 'error'; ccQualityBadge = '要改善';
        ccQualityDesc = `RMS誤差 ${rmsText} は大きすぎます。コントロールポイントの座標・デジタイズを見直してください。`;
    }
    const ccCard = document.getElementById('cc-quality-card');
    if (ccCard) {
        ccCard.className = ccCard.className.replace(/\bquality-\w+/g, '').trim();
        ccCard.classList.add(`quality-${ccQualityLevel}`);
    }
    const ccIcon = document.getElementById('cc-quality-icon');
    if (ccIcon) ccIcon.textContent = ccQualityIcon;
    const ccBadge = document.getElementById('cc-quality-badge');
    if (ccBadge) ccBadge.textContent = ccQualityBadge;
    const ccDesc = document.getElementById('cc-quality-desc');
    if (ccDesc) ccDesc.textContent = ccQualityDesc;
    const ccMarker = document.getElementById('cc-quality-marker');
    if (ccMarker) {
        const pct = Math.min(rms / CC_SCALE_MAX * 100, 100);
        ccMarker.style.left = pct + '%';
    }

    // 品質説明文に最適化反復回数を追記
    let iterCount = 0;
    if (result.results?.cam1?.optimization) {
        iterCount = result.results.cam1.optimization.iterations || 0;
    }
    if (iterCount > 0) {
        ccQualityDesc += ` （Nelder-Mead法 ${iterCount}回反復で収束）`;
    }

    // DLTパラメータ表示
    const dltBody = document.getElementById('cc-dlt-params-body');
    if (dltBody) {
        dltBody.innerHTML = '';
        const dlt1 = (result.stereoDLTParams && result.stereoDLTParams[0]) ? result.stereoDLTParams[0] : result.dltParams;
        const dlt2 = (result.stereoDLTParams && result.stereoDLTParams[1]) ? result.stereoDLTParams[1] : null;

        if (dlt1) {
            for (let i = 0; i < 11; i++) {
                const tr = document.createElement('tr');
                const val1 = dlt1[i] !== undefined ? dlt1[i].toFixed(6) : '-';
                const val2 = (dlt2 && dlt2[i] !== undefined) ? dlt2[i].toFixed(6) : '-';
                tr.innerHTML = `<td style="font-weight:bold; padding:2px 4px;">L${i + 1}</td><td style="text-align:right; padding:2px 4px;">${val1}</td><td style="text-align:right; padding:2px 4px;">${val2}</td>`;
                dltBody.appendChild(tr);
            }
        } else {
            dltBody.innerHTML = '<tr><td colspan="3" style="text-align:center;">データなし</td></tr>';
        }
    }


    // キャリブレーションテーブルの誤差（m単位）を計算して更新
    if (result.stereoDLTParams && result.stereoDLTParams[0] && result.stereoDLTParams[1] && window.AnalysisEngine && typeof window.AnalysisEngine.reconstruct3DPointFromPixels === 'function') {
        const dlt1 = result.stereoDLTParams[0];
        const dlt2 = result.stereoDLTParams[1];

        // L1..L11オブジェクトへ変換
        const toObj = (arr) => { const o = {}; for (let i = 0; i < 11; i++) o[`L${i + 1}`] = arr[i]; return o; };
        const C1 = toObj(dlt1);
        const C2 = toObj(dlt2);

        if (window.calibrationData && Array.isArray(window.calibrationData.points)) {
            window.calibrationData.points.forEach(p => {
                // errors初期化
                if (!p.errors) p.errors = { x: null, y: null, z: null };

                // デジタイズ座標と実座標がある場合のみ計算
                const u1 = p?.digitizedCoords?.cam1?.x;
                const v1 = p?.digitizedCoords?.cam1?.y;
                const u2 = p?.digitizedCoords?.cam2?.x;
                const v2 = p?.digitizedCoords?.cam2?.y;
                const rx = p?.realCoords?.x;
                const ry = p?.realCoords?.y;
                const rz = p?.realCoords?.z;

                if ([u1, v1, u2, v2, rx, ry, rz].every(v => typeof v === 'number' && isFinite(v))) {
                    const est = window.AnalysisEngine.reconstruct3DPointFromPixels(u1, v1, u2, v2, C1, C2);
                    if (est) {
                        p.errors.x = est.x - rx;
                        p.errors.y = est.y - ry;
                        p.errors.z = est.z - rz;
                    } else {
                        p.errors.x = p.errors.y = p.errors.z = null;
                    }
                } else {
                    p.errors.x = p.errors.y = p.errors.z = null;
                }
            });

            // テーブル再描画
            if (typeof updateCalibrationPointsTable === 'function') {
                updateCalibrationPointsTable();
            }
        }
    }

    // ヒントメッセージの表示
    const feedback = document.getElementById('cc-validation-feedback');
    if (feedback) feedback.style.display = 'block';

    // 収束グラフの描画
    const chartDiv = document.getElementById('cc-convergence-chart');
    if (chartDiv && window.Plotly) {
        const traces = [];

        const setupTrace = (camName, resultData, color) => {
            if (!resultData || !resultData.optimization || !resultData.optimization.history) return;

            const history = resultData.optimization.history;
            const splitIdx = resultData.optimization.gaSplitIndex || 0;

            // GA部分
            if (splitIdx > 0) {
                traces.push({
                    x: Array.from({ length: splitIdx }, (_, i) => i),
                    y: history.slice(0, splitIdx),
                    name: `${camName}: GA (大域)`,
                    type: 'scatter',
                    mode: 'lines',
                    line: { color: color, width: 1, dash: 'dot' }
                });
            }

            // NM部分
            if (history.length > splitIdx) {
                traces.push({
                    x: Array.from({ length: history.length - splitIdx }, (_, i) => i + splitIdx),
                    y: history.slice(splitIdx),
                    name: `${camName}: NM (局所)`,
                    type: 'scatter',
                    mode: 'lines',
                    line: { color: color, width: 2 }
                });
            }
        };

        setupTrace('Cam1', result.results?.cam1, '#1f77b4');
        setupTrace('Cam2', result.results?.cam2, '#ff7f0e');

        const layout = {
            title: {
                text: '最適化収束過程 (再投影誤差)',
                font: { size: 14 }
            },
            xaxis: { title: '反復・世代数', tickfont: { size: 10 } },
            yaxis: {
                title: 'RMS誤差 [px]',
                type: 'log',
                tickfont: { size: 10 },
                autorange: true
            },
            margin: { t: 40, b: 40, l: 50, r: 20 },
            showlegend: true,
            legend: { x: 1, xanchor: 'right', y: 1, font: { size: 9 } },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0.02)'
        };

        const config = { responsive: true, displayModeBar: false };
        window.Plotly.newPlot('cc-convergence-chart', traces, layout, config);
    }

    // 結果コンテナを表示
    const resultsContainer = document.getElementById('cc-method-results-container');
    if (resultsContainer) resultsContainer.style.display = 'block';
}

try { initCCMethodUIBindings(); } catch (_) { }

// グローバル関数としてエクスポート
window.initializeApp = initializeApp;
window.getSelectedLandmark = getSelectedLandmark;
window.setSelectedLandmark = setSelectedLandmark;
window.updateLandmarkSelectorVisibility = updateLandmarkSelectorVisibility;
window.updateCCControlPointsTable = updateCCControlPointsTable;
window.displayCCMethodResults = displayCCMethodResults;

// ===== ChArUco Calibration IPC wrappers =====
// 3D DLT 結果のUI反映（A〜K×2, SE, 平均/最大, 状態）
// （update3DDLTResultsDisplay は ui-components.js へ移動済み）

// CharucoサイドバーUIの表示切替
// ChArUcoシングルモード用: ボード選択UIの表示制御
window.updateCharucoBoardSelectUI = function updateCharucoBoardSelectUI() {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    const boardSelectContainer = document.getElementById('charuco-single-board-select');
    const boardSelect = document.getElementById('charuco-board-select');

    if (!boardSelectContainer || !boardSelect) return;

    // charuco-singleモードの場合のみ表示
    if (method === 'charuco-single') {
        boardSelectContainer.style.display = 'block';

        // 現在選択されている値を保存
        const currentValue = boardSelect.value;

        // ボード選択のドロップダウンを更新
        const calib = window.projectData && window.projectData.calibration ? window.projectData.calibration : null;
        boardSelect.innerHTML = '<option value="">-- ボードを選択 --</option>';

        if (calib && calib.rvecs && calib.rvecs.length > 0) {
            calib.rvecs.forEach((rvec, idx) => {
                const opt = document.createElement('option');
                opt.value = String(idx);
                // ビューエラーがある場合は表示
                const viewError = (calib.viewErrors && calib.viewErrors[idx]) ? calib.viewErrors[idx] : null;
                const errorText = viewError ? ` (RMS: ${Number(viewError).toFixed(2)}px)` : '';
                // フレーム番号がある場合は表示
                const frameNum = (calib.frameNumbers && calib.frameNumbers[idx]) ? calib.frameNumbers[idx] : null;
                const frameText = frameNum ? ` [F:${frameNum}]` : '';
                opt.textContent = `ボード #${idx + 1}${frameText}${errorText}`;
                boardSelect.appendChild(opt);
            });

            // 保存した値を復元（有効な値の場合のみ）
            if (currentValue && parseInt(currentValue, 10) >= 0 && parseInt(currentValue, 10) < calib.rvecs.length) {
                boardSelect.value = currentValue;
            }

            // サイドバー「選択フレームを表示」ボタンは廃止（選択 = 即フレーム表示）
            const showBtn = document.getElementById('show-selected-board-frame');
            if (showBtn) showBtn.style.display = 'none';

            // サイドバーのボード選択も、変更即フレーム移動
            const sidebarHandler = () => {
                const selectedIndex = parseInt(boardSelect.value || '-1', 10);
                if (selectedIndex >= 0 && typeof window.jumpToCharucoBoardFrame === 'function') {
                    if (!window.__suppressBoardSelectCascade) {
                        window.__suppressBoardSelectCascade = true;
                        try {
                            window.jumpToCharucoBoardFrame(selectedIndex);
                        } finally {
                            window.__suppressBoardSelectCascade = false;
                        }
                    }
                }
            };
            boardSelect.removeEventListener('change', boardSelect._charucoBoardChangeHandler);
            boardSelect._charucoBoardChangeHandler = sidebarHandler;
            boardSelect.addEventListener('change', sidebarHandler);
        } else {
            // キャリブレーション結果がない場合のメッセージ
            const noCalibOpt = document.createElement('option');
            noCalibOpt.value = '';
            noCalibOpt.textContent = '-- キャリブレーション結果がありません --';
            noCalibOpt.disabled = true;
            boardSelect.appendChild(noCalibOpt);
        }
    } else {
        boardSelectContainer.style.display = 'none';
    }
};

window.updateCharucoSidebarVisibility = function updateCharucoSidebarVisibility() {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    const show = (method === 'charuco-single' || method === 'charuco-stereo');

    // ChArUcoキャリブレーションセクション全体の表示/非表示
    const charucoSection = document.getElementById('charuco-calibration-section');
    if (charucoSection) {
        charucoSection.style.display = show ? '' : 'none';
    } else {
        console.error('[updateCharucoSidebarVisibility] charuco-calibration-section NOT FOUND');
    }

    // 個別要素の表示/非表示（後方互換性のため）
    const setVisible = (el, visible) => { if (el) el.style.display = visible ? '' : 'none'; };

    // ChArUcoボード設定（見出し+入力3つ）を含む action-group
    const rows = document.getElementById('charuco-rows');
    const settingGroup = rows ? rows.closest('.action-group') : null;
    setVisible(settingGroup, show);

    // Charuco検出ボタンの action-group
    const detectBtn = document.querySelector('button[onclick="detectCharucoBoard()"]');
    const detectGroup = detectBtn ? detectBtn.closest('.action-group') : null;
    setVisible(detectGroup, show);

    // 検出結果欄
    const results = document.querySelector('.charuco-results');
    setVisible(results, show);

    // キャリブレーション開始/追加/実行の action-group
    const startBtn = document.querySelector('button[onclick="calibration.start()"]');
    const startGroup = startBtn ? startBtn.closest('.action-group') : null;
    setVisible(startGroup, show);

    // ステータス行
    const statusP = document.getElementById('calibration-inline-status');
    setVisible(statusP, show);
}

// 分析タブのボード選択UI更新関数
window.updateAnalysisBoardSelectUI = function updateAnalysisBoardSelectUI() {
    const boardSelect = document.getElementById('analysis-board-select');
    const extrinsicSection = document.getElementById('extrinsic-params-section');
    const showBtn = document.getElementById('show-analysis-board-frame');
    const infoDiv = document.getElementById('selected-extrinsic-info');

    if (!boardSelect || !extrinsicSection) return;

    // キャリブレーション結果の確認
    const calib = window.projectData && window.projectData.calibration ? window.projectData.calibration : null;
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';

    // ChArUcoシングルモードの場合のみ表示
    if (method === 'charuco-single' && calib && calib.rvecs && calib.rvecs.length > 0) {
        extrinsicSection.style.display = 'block';

        // 現在選択されている値を保存
        const currentValue = boardSelect.value;

        // ボード選択のドロップダウンを更新
        boardSelect.innerHTML = '<option value="">-- ボードを選択 --</option>';

        calib.rvecs.forEach((rvec, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            // ビューエラーがある場合は表示
            const viewError = (calib.viewErrors && calib.viewErrors[idx]) ? calib.viewErrors[idx] : null;
            const errorText = viewError ? ` (RMS: ${Number(viewError).toFixed(2)}px)` : '';
            // フレーム番号がある場合は表示
            const frameNum = (calib.frameNumbers && calib.frameNumbers[idx]) ? calib.frameNumbers[idx] : null;
            const frameText = frameNum ? ` [F:${frameNum}]` : '';
            opt.textContent = `ボード #${idx + 1}${frameText}${errorText}`;
            boardSelect.appendChild(opt);
        });

        // 保存した値を復元（有効な値の場合のみ）
        if (currentValue && parseInt(currentValue, 10) >= 0 && parseInt(currentValue, 10) < calib.rvecs.length) {
            boardSelect.value = currentValue;
        }

        // ボード選択変更時の処理
        // 選択と同時にそのボードのフレームへ自動移動する（別途のフレーム表示ボタンは廃止）
        const updateExtrinsicInfo = () => {
            const selectedIndex = parseInt(boardSelect.value || '-1', 10);
            if (selectedIndex >= 0 && selectedIndex < calib.rvecs.length) {
                const rvec = calib.rvecs[selectedIndex];
                const tvec = calib.tvecs && calib.tvecs[selectedIndex] ? calib.tvecs[selectedIndex] : null;
                const frameNum = (calib.frameNumbers && calib.frameNumbers[selectedIndex]) ? calib.frameNumbers[selectedIndex] : null;

                // 情報表示を更新
                const boardNameEl = document.getElementById('selected-board-name');
                const rvecEl = document.getElementById('selected-rvec');
                const tvecEl = document.getElementById('selected-tvec');

                if (boardNameEl) {
                    const frameText = frameNum ? ` [F:${frameNum}]` : '';
                    boardNameEl.textContent = `ボード #${selectedIndex + 1}${frameText}`;
                }
                if (rvecEl && rvec) {
                    rvecEl.textContent = `[${rvec.map(v => Number(v).toFixed(6)).join(', ')}]`;
                }
                if (tvecEl && tvec) {
                    tvecEl.textContent = `[${tvec.map(v => Number(v).toFixed(6)).join(', ')}]`;
                }

                if (infoDiv) infoDiv.style.display = 'block';
            } else {
                if (infoDiv) infoDiv.style.display = 'none';
            }
            // ボタンは廃止したので常に非表示
            if (showBtn) showBtn.style.display = 'none';
        };

        // change: 情報表示更新 + 即フレーム移動
        const onBoardSelectChange = () => {
            updateExtrinsicInfo();
            const selectedIndex = parseInt(boardSelect.value || '-1', 10);
            if (selectedIndex >= 0 && typeof window.jumpToCharucoBoardFrame === 'function') {
                // change イベントの無限ループ防止: jumpToCharucoBoardFrame は analysis-board-select に
                // change を再発火するので、再入ガードで止める
                if (!window.__suppressBoardSelectCascade) {
                    window.__suppressBoardSelectCascade = true;
                    try {
                        window.jumpToCharucoBoardFrame(selectedIndex);
                    } finally {
                        window.__suppressBoardSelectCascade = false;
                    }
                }
            }
        };

        // 既存のイベントリスナーを削除してから追加（重複を防ぐ）
        boardSelect.removeEventListener('change', boardSelect._analysisBoardChangeHandler);
        boardSelect._analysisBoardChangeHandler = onBoardSelectChange;
        boardSelect.addEventListener('change', onBoardSelectChange);

        // 初期状態を更新
        updateExtrinsicInfo();

        // 「選択フレームを表示」ボタンは廃止（選択 = 即フレーム表示）
        if (showBtn) showBtn.style.display = 'none';
    } else {
        extrinsicSection.style.display = 'none';
    }
};
function setCalibStatus(text, type = 'info') {
    const el = document.getElementById('calibration-inline-status');
    if (!el) return;
    el.textContent = text;
    if (type === 'error') el.style.color = '#c33';
    else if (type === 'success') el.style.color = '#0a5';
    else el.style.color = '#555';
    // 親ステータス行のトーンを状態に同期
    const row = el.closest('.cc-status-row');
    if (row) {
        row.classList.remove('active', 'error');
        if (type === 'error') row.classList.add('error');
        else if (window.__calibSessionActive) row.classList.add('active');
    }
}

// 収集セッション状態（自動追加のON/OFF判定用）
window.__calibActive = false;

async function startCalibrationSession() {
    try {
        setCalibStatus('セッション初期化中…');
        const res = await ipcRenderer.invoke('calib-start');
        if (res && res.success) {
            showMessage('キャリブレーションセッションを開始しました');
            setCalibStatus('セッション開始', 'success');
            // 自動追加の対象期間を開始
            window.__calibActive = true;
            // 開始直後に1回検出を実行
            try {
                if (typeof window.detectCharucoBoard === 'function') {
                    await window.detectCharucoBoard();
                }
            } catch (_) { }
            return true;
        }
        showMessage(`キャリブレーション開始に失敗: ${res && res.error ? res.error : 'unknown error'}`);
        setCalibStatus(`開始失敗: ${res && res.error ? res.error : 'unknown error'}`, 'error');
        return false;
    } catch (e) {
        showMessage(`キャリブレーション開始エラー: ${e.message}`);
        setCalibStatus(`開始エラー: ${e.message}`, 'error');
        return false;
    }
}

async function captureCalibrationSample() {
    try {
        const settings = projectData && projectData.settings ? projectData.settings : {};
        const videoFile = settings.videoFile;
        const videoPath = typeof videoFile === 'string' ? videoFile : (videoFile && videoFile.path);
        const frameNumber = settings.currentFrame || 1;
        if (!videoPath) {
            showMessage('動画が選択されていません');
            setCalibStatus('動画未選択', 'error');
            return { success: false };
        }

        // Charucoボード設定をUIから取得してネイティブへ渡す
        const rowsEl = document.getElementById('charuco-rows');
        const colsEl = document.getElementById('charuco-cols');
        const sqEl = document.getElementById('charuco-square-mm');
        const mkEl = document.getElementById('charuco-marker-mm');
        const dictEl = document.getElementById('charuco-dictionary');

        const rows = rowsEl ? parseInt(rowsEl.value, 10) : 5;
        const cols = colsEl ? parseInt(colsEl.value, 10) : 7;
        const squareMm = sqEl ? parseFloat(sqEl.value) : 165;
        const markerMm = mkEl ? parseFloat(mkEl.value) : 123;
        const dictionary = dictEl && dictEl.value ? dictEl.value : 'DICT_4X4_50';

        const boardConfig = {
            rows,
            cols,
            squareSizeMm: squareMm,
            markerSizeMm: markerMm,
            dictionary,
            legacyPattern: true
        };

        // 検出時に保存した元フレーム ImageData を使用（アノテーション描画前の状態）
        let imageData = null;
        const frameMatchesDetect = window.__originalFrameImageData &&
            Number(window.__originalFrameNumber) === Number(frameNumber);
        if (!frameMatchesDetect && typeof window.detectCharucoBoard === 'function') {
            // 最新の未加工フレームを確保するため detectCharucoBoard を先に実行
            await window.detectCharucoBoard();
        }
        if (window.__originalFrameImageData &&
            Number(window.__originalFrameNumber) === Number(frameNumber)) {
            imageData = window.__originalFrameImageData;
        } else {
            // フォールバック: canvas.currentImage の生ピクセル
            const canvas = document.getElementById('digitize-canvas');
            if (canvas && canvas.currentImage) {
                try {
                    imageData = canvasToImageDataObj(canvas.currentImage);
                } catch (e) {
                    console.warn('[CALIB-CAPTURE] currentImage取得失敗:', e);
                }
            }
            if (!imageData) {
                console.warn('[CALIB-CAPTURE] No clean frame available, skipping capture');
            }
        }

        setCalibStatus(`サンプル追加中… (F:${frameNumber})`);
        const res = await ipcRenderer.invoke('calib-capture', {
            videoPath,
            frameNumber,
            boardConfig,
            imageData
        });
        if (res && res.success) {
            showMessage(`サンプルを追加しました（フレーム: ${frameNumber}、ポイント: ${res.points}、累計: ${res.samples}件）`);
            setCalibStatus(`追加: フレーム${frameNumber} / ポイント${res.points} / 累計${res.samples}`, 'success');
            // ステップガイドを更新
            if (typeof updateCharucoGuide === 'function') {
                charucoGuideState.currentStep = 3;
                charucoGuideState.samples = res.samples || 0;
                if (charucoGuideState.samples >= 20) {
                    charucoGuideState.currentStep = 4;
                }
                updateCharucoGuide();
            }
        } else {
            const debugInfo = res && res.debug ? ` (debug: ${res.debug})` : '';
            console.warn('[CALIB-CAPTURE] Failed:', res);
            showMessage(`サンプル追加に失敗: ${res && res.error ? res.error : 'unknown error'}${debugInfo}`);
            setCalibStatus(`追加失敗: ${res && res.error ? res.error : 'unknown error'}`, 'error');
        }
        return res;
    } catch (e) {
        showMessage(`サンプル追加エラー: ${e.message}`);
        setCalibStatus(`追加エラー: ${e.message}`, 'error');
        return { success: false, error: e.message };
    }
}

// ============================
// 単眼 ChArUco キャリブレーション
// ============================

async function computeCalibration() {
    try {
        setCalibStatus('キャリブレーション計算中…');
        const res = await ipcRenderer.invoke('calib-compute');
        if (res && res.success) {
            if (!window.projectData) window.projectData = {};
            window.projectData.calibration = {
                cameraMatrix: res.cameraMatrix,
                distCoeffs: res.distCoeffs,
                reprojectionError: res.reprojectionError,
                samples: res.samples,
                rvecs: res.rvecs || [],
                tvecs: res.tvecs || [],
                rotationMatrices: res.rotationMatrices || [],
                viewErrors: res.viewErrors || [],
                cornerCounts: res.cornerCounts || [],
                markerCounts: res.markerCounts || [],
                frameNumbers: res.frameNumbers || [], // 各サンプルのフレーム番号（表示用・フィルタ反映）
                // 現在のビュー配列 → 元の g_allImagePoints インデックス のマップ
                // 初回計算時は除外がないので [0, 1, ..., N-1]
                originalSampleIndices: (res.rvecs || []).map((_, i) => i),
                // 点群データ（除外計算用）— フル長のオリジナル
                allImagePoints: res.allImagePoints || [],
                allObjectPoints: res.allObjectPoints || [],
                // 復元用フル長コピー: 除外を繰り返してもネイティブに常にフル原本を渡せるよう保持
                allCornerCounts: (res.cornerCounts || []).slice(),
                allMarkerCounts: (res.markerCounts || []).slice(),
                allFrameNumbers: (res.frameNumbers || []).slice(),
                imageWidth: res.imageWidth || 0,
                imageHeight: res.imageHeight || 0
            };
            const err = typeof res.reprojectionError === 'number' ? res.reprojectionError.toFixed(4) : String(res.reprojectionError);
            showMessage(`キャリブレーション完了（サンプル: ${res.samples}、誤差: ${err}）`);
            setCalibStatus(`完了: サンプル${res.samples}, 誤差${err}`, 'success');
            // ステップガイドを更新
            if (typeof updateCharucoGuide === 'function') {
                charucoGuideState.currentStep = 5;
                charucoGuideState.calibrationCompleted = true;
                updateCharucoGuide();
            }
            // 分析タブのボード選択UIを更新
            if (typeof window.updateAnalysisBoardSelectUI === 'function') {
                window.updateAnalysisBoardSelectUI();
            }

            // 画面に結果を反映
            updateCalibrationResultUI(window.projectData.calibration);
            populateExtrinsicViewSelect(window.projectData.calibration);
            updateExtrinsicResultUI(window.projectData.calibration, 0);
            buildCharucoTable(window.projectData.calibration, 'charuco-table-body-cam1');
            updateErrorBarChart(window.projectData.calibration.viewErrors || [], 'charuco-error-chart-cam1', 'ビュー毎RMS誤差 (Cam1)');
            // ボード選択UIを更新
            if (typeof window.updateCharucoBoardSelectUI === 'function') {
                window.updateCharucoBoardSelectUI();
            }
            // 収集セッション終了
            window.__calibActive = false;
            // 連続検出を停止
            try {
                if (typeof window.stopCharucoAutoDetection === 'function') {
                    window.stopCharucoAutoDetection();
                }
            } catch (_) { }
        } else {
            showMessage(`キャリブレーションに失敗: ${res && res.error ? res.error : 'unknown error'}`);
            setCalibStatus(`計算失敗: ${res && res.error ? res.error : 'unknown error'}`, 'error');
        }
        return res;
    } catch (e) {
        showMessage(`キャリブレーション実行エラー: ${e.message}`);
        setCalibStatus(`計算エラー: ${e.message}`, 'error');
        return { success: false, error: e.message };
    }
}

// ビュー単位RMSグラフから外れ値ビューを除外して再キャリブレーション
if (!window.projectData) window.projectData = {};
window.projectData.charucoExcludedViews = window.projectData.charucoExcludedViews || [];

window.excludeCharucoViewAndRecompute = async function (viewIndex) {
    try {
        if (!Number.isFinite(viewIndex) || viewIndex < 0) return;

        const calib = window.projectData?.calibration;
        if (!calib?.allImagePoints?.length) {
            showError('除外再計算には点群データが必要です。キャリブレーションを再実行してから保存してください。');
            return;
        }

        // クリックされたのは「現在表示中のビュー配列上のインデックス」。
        // これを元の g_allImagePoints 上の sample index に変換する。
        // originalSampleIndices が未設定な古い計算結果の場合は、そのまま viewIndex を使う。
        const originalIdx = (Array.isArray(calib.originalSampleIndices) &&
            calib.originalSampleIndices.length === calib.rvecs.length &&
            viewIndex < calib.originalSampleIndices.length)
            ? calib.originalSampleIndices[viewIndex]
            : viewIndex;

        // 除外累積リスト(元のサンプルインデックス基準)を更新
        if (!Array.isArray(window.projectData.charucoExcludedViews)) {
            window.projectData.charucoExcludedViews = [];
        }
        if (!window.projectData.charucoExcludedViews.includes(originalIdx)) {
            window.projectData.charucoExcludedViews.push(originalIdx);
        }
        const exclude = window.projectData.charucoExcludedViews.slice().sort((a, b) => a - b);

        // ネイティブ側のバッファを毎回フル原本で復元
        // calib.cornerCounts/frameNumbers は除外後のフィルタ済みなので、
        // 復元には allCornerCounts/allMarkerCounts/allFrameNumbers(フル原本)を使う
        try {
            await ipcRenderer.invoke('restore-calibration-buffers', {
                allImagePoints: calib.allImagePoints,
                allObjectPoints: calib.allObjectPoints,
                cornerCounts: calib.allCornerCounts || calib.cornerCounts || [],
                markerCounts: calib.allMarkerCounts || calib.markerCounts || [],
                frameNumbers: calib.allFrameNumbers || calib.frameNumbers || [],
                imageWidth: calib.imageWidth || window.projectData?.settings?.calibrationVideoWidth || 1920,
                imageHeight: calib.imageHeight || window.projectData?.settings?.calibrationVideoHeight || 1080
            });
        } catch (_) {}

        setCalibStatus(`サンプル #${originalIdx + 1} を除外して再計算中…`);
        const res = await ipcRenderer.invoke('calib-compute-exclude', { exclude });
        if (!res || !res.success) {
            const msg = res && res.error ? res.error : '除外付きキャリブレーション計算に失敗しました';
            showError(msg);
            setCalibStatus(`除外付き再計算失敗: ${msg}`, 'error');
            return;
        }

        // 元のフル点群バッファ(allImagePoints/allObjectPoints 等)は温存する。
        // 一方で、rvecs/tvecs/viewErrors/cornerCounts/markerCounts/frameNumbers は
        // 除外後のフィルタ済み配列で上書きする(長さが縮む)。
        // originalSampleIndices は「現在のビュー番号 → 元 g_allImagePoints インデックス」のマップ。
        const prevCalib = window.projectData.calibration || {};
        window.projectData.calibration = {
            // 先に旧データを展開して allImagePoints/allObjectPoints を温存
            ...prevCalib,
            cameraMatrix: res.cameraMatrix,
            distCoeffs: res.distCoeffs,
            reprojectionError: res.reprojectionError,
            samples: res.samples,
            rvecs: res.rvecs || [],
            tvecs: res.tvecs || [],
            rotationMatrices: res.rotationMatrices || [],
            viewErrors: res.viewErrors || [],
            cornerCounts: res.cornerCounts || [],
            markerCounts: res.markerCounts || [],
            frameNumbers: res.frameNumbers || [],
            originalSampleIndices: Array.isArray(res.originalIndices) && res.originalIndices.length
                ? res.originalIndices
                : (res.rvecs || []).map((_, i) => i)
        };

        // UI更新
        updateCalibrationResultUI(projectData.calibration);
        populateExtrinsicViewSelect(projectData.calibration);
        updateExtrinsicResultUI(projectData.calibration, 0);
        buildCharucoTable(projectData.calibration, 'charuco-table-body-cam1');
        if (projectData.calibration.viewErrors && projectData.calibration.viewErrors.length > 0) {
            updateErrorBarChart(projectData.calibration.viewErrors, 'charuco-error-chart-cam1', 'ビュー毎RMS誤差 (Cam1)');
        }

        const err = typeof res.reprojectionError === 'number'
            ? res.reprojectionError.toFixed(4)
            : String(res.reprojectionError);
        showMessage(`除外付きキャリブレーション完了（サンプル: ${res.samples}、誤差: ${err}）`);
        setCalibStatus(`除外付き完了: サンプル${res.samples}, 誤差${err}`, 'success');
        // 分析タブのボード選択UIを更新
        if (typeof window.updateAnalysisBoardSelectUI === 'function') {
            window.updateAnalysisBoardSelectUI();
        }
    } catch (e) {
        showError('除外付きキャリブレーションエラー: ' + e.message);
        setCalibStatus(`除外付きエラー: ${e.message}`, 'error');
    }
};

// ステレオキャリブレーション: ビュー除外→再計算
window.excludeStereoViewAndRecompute = async function (viewIndex) {
    try {
        if (!Number.isFinite(viewIndex) || viewIndex < 0) return;

        if (!Array.isArray(window.projectData.stereoExcludedViews)) {
            window.projectData.stereoExcludedViews = [];
        }
        if (!window.projectData.stereoExcludedViews.includes(viewIndex)) {
            window.projectData.stereoExcludedViews.push(viewIndex);
        }
        const exclude = window.projectData.stereoExcludedViews.slice().sort((a, b) => a - b);

        setCalibStatus(`ステレオ ビュー #${viewIndex + 1} を除外して再計算中…`);
        const res = await ipcRenderer.invoke('charuco-stereo-compute-exclude', { exclude });
        if (!res || !res.success) {
            const msg = res && res.error ? res.error : 'ステレオ除外付き再計算に失敗しました';
            showError(msg);
            setCalibStatus(`ステレオ除外付き再計算失敗: ${msg}`, 'error');
            return;
        }

        // ステレオキャリブレーション結果を更新
        if (!window.projectData.stereoCalibration) window.projectData.stereoCalibration = {};
        Object.assign(window.projectData.stereoCalibration, {
            rms: res.rms,
            baseline: res.baseline,
            R: res.R,
            T: res.T,
            perViewErrors: res.perViewErrors || [],
            samples: res.samples
        });
        window.projectData.stereoCalibration.viewErrors = res.perViewErrors || [];

        // UI更新（棒グラフ再描画）
        if (typeof window.displayStereoCalibrationErrorChart === 'function') {
            window.displayStereoCalibrationErrorChart(window.projectData.stereoCalibration);
        }

        const err = typeof res.rms === 'number' ? res.rms.toFixed(4) : String(res.rms);
        showMessage(`ステレオ除外付き再計算完了（サンプル: ${res.samples}、RMS: ${err}、baseline: ${res.baseline?.toFixed(3) || '-'}）`);
        setCalibStatus(`ステレオ除外完了: サンプル${res.samples}, RMS=${err}`, 'success');
    } catch (e) {
        showError('ステレオ除外付き再計算エラー: ' + e.message);
        setCalibStatus(`ステレオ除外エラー: ${e.message}`, 'error');
    }
};

function updateCalibrationResultUI(calib) {
    if (!calib) return;
    const M = calib.cameraMatrix || [];
    const fx = M[0], fy = M[4], cx = M[2], cy = M[5];
    const distArr = calib.distCoeffs || [];
    const dist = distArr.map(v => Number(v).toFixed(6)).join(', ');
    const rpe = typeof calib.reprojectionError === 'number' ? calib.reprojectionError : null;
    const samples = calib.samples ?? '-';

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    // 後方互換用（非表示要素）
    set('calib-samples', samples);
    set('calib-reproj', rpe !== null ? rpe.toFixed(6) : '-');
    set('calib-dist', dist || '-');

    // 焦点距離
    set('calib-fx', fx != null ? Number(fx).toFixed(3) : '-');
    set('calib-fy', fy != null ? Number(fy).toFixed(3) : '-');

    // fx/fy比バッジ
    const fxfyBadge = document.getElementById('calib-focal-ratio-badge');
    if (fxfyBadge && fx != null && fy != null) {
        const ratio = Number(fx) / Number(fy);
        const diff = Math.abs(ratio - 1) * 100;
        fxfyBadge.textContent = `fx/fy = ${ratio.toFixed(4)}`;
        fxfyBadge.className = 'calib-param-badge ' + (diff < 0.5 ? 'badge-ok' : diff < 1 ? 'badge-warn' : 'badge-warn');
    }

    // 主点
    set('calib-cx', cx != null ? Number(cx).toFixed(3) : '-');
    set('calib-cy', cy != null ? Number(cy).toFixed(3) : '-');

    // 主点の中心からのずれ
    const principalBadge = document.getElementById('calib-principal-badge');
    const centerOffsetEl = document.getElementById('calib-center-offset');
    const imgW = calib.imageWidth || window.projectData?.settings?.calibrationVideoWidth || 0;
    const imgH = calib.imageHeight || window.projectData?.settings?.calibrationVideoHeight || 0;
    if (cx != null && cy != null) {
        const halfW = imgW ? imgW / 2 : null;
        const halfH = imgH ? imgH / 2 : null;
        if (halfW && halfH) {
            const dx = Number(cx) - halfW, dy = Number(cy) - halfH;
            const offset = Math.sqrt(dx * dx + dy * dy);
            if (centerOffsetEl) centerOffsetEl.textContent = offset.toFixed(1);
            if (principalBadge) {
                const pct = offset / halfW * 100;
                principalBadge.textContent = `中心から ${offset.toFixed(1)} px (${pct.toFixed(1)}%)`;
                principalBadge.className = 'calib-param-badge ' + (pct < 1 ? 'badge-ok' : pct < 2 ? 'badge-neutral' : 'badge-warn');
            }
        } else {
            if (centerOffsetEl) centerOffsetEl.textContent = '-';
        }
    }

    // 歪み係数
    const dv = (i) => distArr[i] != null ? Number(distArr[i]).toFixed(6) : '-';
    set('calib-dist-k1', dv(0));
    set('calib-dist-k2', dv(1));
    set('calib-dist-p1', dv(2));
    set('calib-dist-p2', dv(3));
    set('calib-dist-k3', dv(4));

    const distBadge = document.getElementById('calib-distortion-badge');
    if (distBadge && distArr.length > 0) {
        const k1 = Number(distArr[0]);
        const p1 = distArr[2] != null ? Number(distArr[2]) : 0;
        const p2 = distArr[3] != null ? Number(distArr[3]) : 0;
        const radType = Math.abs(k1) < 0.01 ? '放射歪みほぼなし' : k1 < 0 ? '樽型歪み' : '糸巻型歪み';
        const tangStr = (Math.abs(p1) < 0.001 && Math.abs(p2) < 0.001) ? '接線歪み小' : '接線歪みあり';
        distBadge.textContent = `${radType} / ${tangStr}`;
        distBadge.className = 'calib-param-badge ' + (Math.abs(k1) < 0.1 ? 'badge-ok' : 'badge-warn');
    }

    // --- 品質カード ---
    const card = document.getElementById('calib-quality-card');
    if (typeof window.setCalibErrorValue === 'function') {
        window.setCalibErrorValue('calib-reproj-big', rpe, null);
    } else {
        set('calib-reproj-big', rpe !== null ? rpe.toFixed(3) : '-');
    }
    set('calib-samples-big', samples);

    if (rpe !== null && card) {
        // "再投影誤差 X.XXX px (Y.YYY mm)" 形式。mm概算が取れない場合はpxのみ。
        const _chMmFactor = (typeof window.getPixelToMmFactor === 'function') ? window.getPixelToMmFactor() : null;
        const _chRpeMm = _chMmFactor ? (rpe * _chMmFactor * 1000) : null;
        const rpeText = (_chRpeMm !== null && isFinite(_chRpeMm))
            ? `${rpe.toFixed(3)} px (${_chRpeMm.toFixed(3)} mm)`
            : `${rpe.toFixed(3)} px`;
        let level, label, icon, desc;
        if (rpe <= 0.5) {
            level = 'excellent'; label = '非常に良好'; icon = 'verified';
            desc = `再投影誤差 ${rpeText} は最高水準です。このキャリブレーションは3D計測・解析に高い精度で使用できます。`;
        } else if (rpe <= 1.0) {
            level = 'good'; label = '良好'; icon = 'check_circle';
            desc = `再投影誤差 ${rpeText} は実用レベルです。バイオメカニクス計測に十分な精度があります。`;
        } else if (rpe <= 2.0) {
            level = 'fair'; label = '許容範囲'; icon = 'warning';
            desc = `再投影誤差 ${rpeText} はやや大きめです。精度重視の計測では撮影条件を見直しての再実行を推奨します。`;
        } else {
            level = 'poor'; label = '要再実行'; icon = 'error';
            desc = `再投影誤差 ${rpeText} は大きすぎます。ボードの検出品質や撮影姿勢のバリエーションを確認して再実行してください。`;
        }

        card.className = 'calib-quality-card quality-' + level;
        set('calib-quality-badge', label);
        set('calib-quality-desc', desc);
        const iconEl = document.getElementById('calib-quality-icon');
        if (iconEl) iconEl.textContent = icon;

        // マーカー位置（0〜3 px スケール → 0〜100%）
        const marker = document.getElementById('calib-quality-marker');
        if (marker) {
            const pct = Math.min(rpe / 3.0, 1.0) * 100;
            marker.style.left = pct + '%';
        }

        // サンプル数の追加コメント
        if (typeof samples === 'number' && samples < 15) {
            const descEl = document.getElementById('calib-quality-desc');
            if (descEl) descEl.textContent += ` (サンプル数 ${samples} 枚は少なめです。20枚以上が推奨)`;
        }
    }
}

// ステレオキャリブレーション結果を表示
function updateStereoCalibrationResultUI(stereoCalib) {
    if (!stereoCalib) return;

    const rms = typeof stereoCalib.rms === 'number' ? stereoCalib.rms : null;
    const baseline = typeof stereoCalib.baseline === 'number' ? stereoCalib.baseline : null;
    const samples = stereoCalib.samples || 0;
    const R = stereoCalib.R && Array.isArray(stereoCalib.R) && stereoCalib.R.length === 9 ? stereoCalib.R : null;
    const T = stereoCalib.T && Array.isArray(stereoCalib.T) && stereoCalib.T.length === 3 ? stereoCalib.T : null;

    // --- 品質評価 (ステレオRMS閾値: excellent≤1.0, good≤2.0, fair≤3.0, poor>3.0) ---
    const SCALE_MAX = 4.0;
    // "RMS誤差 X.XXX px (Y.YYY mm)" 形式。mm概算が取れない場合はpxのみ。
    const _stMmFactor = (typeof window.getPixelToMmFactor === 'function') ? window.getPixelToMmFactor() : null;
    const _stRmsMm = (rms !== null && _stMmFactor) ? (rms * _stMmFactor * 1000) : null;
    const stRmsText = rms !== null
        ? ((_stRmsMm !== null && isFinite(_stRmsMm)) ? `${rms.toFixed(3)} px (${_stRmsMm.toFixed(3)} mm)` : `${rms.toFixed(3)} px`)
        : '-';
    let quality = 'poor', qualityLabel = '要再実行', qualityIcon = 'error', qualityDesc = '';
    if (rms !== null) {
        if (rms <= 1.0) {
            quality = 'excellent'; qualityLabel = '非常に良好'; qualityIcon = 'verified';
            qualityDesc = `RMS誤差 ${stRmsText} は非常に良好です。ステレオ3D計測に十分な精度があります。`;
        } else if (rms <= 2.0) {
            quality = 'good'; qualityLabel = '良好'; qualityIcon = 'check_circle';
            qualityDesc = `RMS誤差 ${stRmsText} は良好な範囲です。スポーツ動作解析などの用途に適しています。`;
        } else if (rms <= 3.0) {
            quality = 'fair'; qualityLabel = '許容範囲'; qualityIcon = 'warning';
            qualityDesc = `RMS誤差 ${stRmsText} はやや大きいです。可能であればキャリブレーションを再実行し、精度の向上を試みてください。`;
        } else {
            quality = 'poor'; qualityLabel = '要再実行'; qualityIcon = 'error';
            qualityDesc = `RMS誤差 ${stRmsText} は大きすぎます。撮影条件を見直してキャリブレーションを再実行してください。`;
        }
    }

    // --- 品質カード更新 ---
    const card = document.getElementById('stereo-quality-card');
    if (card) {
        card.className = `calib-quality-card quality-${quality}`;
    }
    const iconEl = document.getElementById('stereo-quality-icon');
    if (iconEl) iconEl.textContent = qualityIcon;
    const badgeEl = document.getElementById('stereo-quality-badge');
    if (badgeEl) badgeEl.textContent = qualityLabel;
    if (typeof window.setCalibErrorValue === 'function') {
        window.setCalibErrorValue('stereo-reproj-big', rms, null);
    } else {
        const reprojBig = document.getElementById('stereo-reproj-big');
        if (reprojBig) reprojBig.textContent = rms !== null ? rms.toFixed(3) : '-';
    }
    const samplesBig = document.getElementById('stereo-samples-big');
    if (samplesBig) samplesBig.textContent = samples || '-';
    const descEl = document.getElementById('stereo-quality-desc');
    if (descEl) descEl.textContent = qualityDesc;

    // マーカー位置: rms / SCALE_MAX, クランプ 0-100%
    const markerEl = document.getElementById('stereo-quality-marker');
    if (markerEl && rms !== null) {
        const pct = Math.min(rms / SCALE_MAX, 1.0) * 100;
        markerEl.style.left = `${pct}%`;
    }

    // --- ベースライン ---
    const baselineEl = document.getElementById('stereo-baseline');
    if (baselineEl) baselineEl.textContent = baseline !== null ? baseline.toFixed(4) : '-';

    // 収束角: T ベクトルの XZ 面での角度（おおよそのトーイン/パラレル判断）
    const angleEl = document.getElementById('stereo-convergence-angle');
    if (angleEl && T) {
        const angleRad = Math.atan2(Math.abs(T[0]), Math.abs(T[2]));
        const angleDeg = (angleRad * 180 / Math.PI).toFixed(1);
        angleEl.textContent = angleDeg;
    } else if (angleEl) {
        angleEl.textContent = '-';
    }

    // ベースラインバッジ
    const baselineBadge = document.getElementById('stereo-baseline-badge');
    if (baselineBadge && baseline !== null) {
        if (baseline >= 0.3 && baseline <= 3.0) {
            baselineBadge.textContent = '適切な間隔';
            baselineBadge.className = 'calib-param-badge badge-ok';
        } else if (baseline < 0.1) {
            baselineBadge.textContent = '近すぎる';
            baselineBadge.className = 'calib-param-badge badge-warn';
        } else {
            baselineBadge.className = 'calib-param-badge badge-neutral';
        }
    }

    // --- T ベクトル成分 ---
    const txEl = document.getElementById('stereo-tx');
    const tyEl = document.getElementById('stereo-ty');
    const tzEl = document.getElementById('stereo-tz');
    if (T) {
        if (txEl) txEl.textContent = T[0].toFixed(4);
        if (tyEl) tyEl.textContent = T[1].toFixed(4);
        if (tzEl) tzEl.textContent = T[2].toFixed(4);
    }

    // --- R 行列テーブル ---
    const rTableBody = document.getElementById('stereo-R-table');
    if (rTableBody && R) {
        rTableBody.innerHTML = '';
        const colColors = ['#ffebee', '#e8f5e9', '#e3f2fd'];
        for (let row = 0; row < 3; row++) {
            const tr = document.createElement('tr');
            for (let col = 0; col < 3; col++) {
                const td = document.createElement('td');
                td.textContent = R[row * 3 + col].toFixed(6);
                td.style.background = colColors[col];
                tr.appendChild(td);
            }
            rTableBody.appendChild(tr);
        }
    }

    // --- 後方互換用非表示要素 ---
    const rmsEl = document.getElementById('stereo-rms');
    if (rmsEl) rmsEl.textContent = rms !== null ? rms.toFixed(6) : '-';
    const samplesEl = document.getElementById('stereo-samples');
    if (samplesEl) samplesEl.textContent = samples || '-';
    const rEl = document.getElementById('stereo-R');
    if (rEl && R) rEl.textContent = `[${R.slice(0,3).map(v=>v.toFixed(4)).join(', ')}; ${R.slice(3,6).map(v=>v.toFixed(4)).join(', ')}; ${R.slice(6,9).map(v=>v.toFixed(4)).join(', ')}]`;
    const tEl = document.getElementById('stereo-T');
    if (tEl && T) tEl.textContent = `[${T.map(v=>v.toFixed(4)).join(', ')}]`;

    // ステレオキャリブレーション結果ブロックを表示
    const stereoBlock = document.getElementById('stereo-calibration-result-block');
    if (stereoBlock) stereoBlock.style.display = '';

    // 単眼パラメータの状態表示も更新
    if (typeof window.updateIntrinsicStatus === 'function') {
        window.updateIntrinsicStatus();
    }

    // ステレオ誤差グラフを描画
    if (typeof window.displayStereoCalibrationErrorChart === 'function') {
        window.displayStereoCalibrationErrorChart(stereoCalib);
    }
}

// グローバルスコープに公開
window.updateStereoCalibrationResultUI = updateStereoCalibrationResultUI;

// ===== ステレオキャリブレーション結果の保存・読み込み・3D表示 =====

/**
 * ステレオキャリブレーション結果を保存
 */
window.saveStereoCalibration = async function () {
    const stereoCalib = window.projectData?.stereoCalibration;
    if (!stereoCalib || !stereoCalib.R || !stereoCalib.T) {
        showError('ステレオキャリブレーション結果がありません。先にキャリブレーションを実行してください。');
        return;
    }

    // 内部パラメータも含めて保存
    const intr = window.projectData?.stereoIntrinsics || {};

    const stereoData = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        // ステレオ外部パラメータ
        rms: stereoCalib.rms,
        baseline: stereoCalib.baseline,
        R: stereoCalib.R,
        T: stereoCalib.T,
        samples: stereoCalib.samples,
        rvecs: stereoCalib.rvecs || [],
        tvecs: stereoCalib.tvecs || [],
        // グラフ表示用の点群データ
        objectPoints: stereoCalib.objectPoints || [],
        imagePoints1: stereoCalib.imagePoints1 || [],
        imagePoints2: stereoCalib.imagePoints2 || [],
        // Cam1内部パラメータ
        cam1: intr.cam1 ? {
            cameraMatrix: intr.cam1.cameraMatrix,
            distCoeffs: intr.cam1.distCoeffs,
            reprojectionError: intr.cam1.reprojectionError,
            samples: intr.cam1.samples
        } : null,
        // Cam2内部パラメータ
        cam2: intr.cam2 ? {
            cameraMatrix: intr.cam2.cameraMatrix,
            distCoeffs: intr.cam2.distCoeffs,
            reprojectionError: intr.cam2.reprojectionError,
            samples: intr.cam2.samples
        } : null
    };

    try {
        const result = await ipcRenderer.invoke('save-stereo-calibration', stereoData);
        if (result && result.success) {
            showMessage('ステレオキャリブレーション結果を保存しました: ' + result.filePath);
        } else {
            showError('ステレオキャリブレーション結果の保存に失敗しました');
        }
    } catch (e) {
        showError('ステレオキャリブレーション結果の保存中にエラーが発生しました: ' + e.message);
    }
};

/**
 * ステレオキャリブレーション結果を読み込み
 */
window.loadStereoCalibration = async function () {
    try {
        const result = await ipcRenderer.invoke('load-stereo-calibration');
        if (!result || !result.success) {
            if (result && result.cancelled) return; // キャンセル時は何もしない
            showError('ステレオキャリブレーション結果の読み込みに失敗しました');
            return;
        }

        const data = result.data;

        // ステレオキャリブレーション結果を復元
        if (!window.projectData) window.projectData = {};
        window.projectData.stereoCalibration = {
            rms: data.rms,
            baseline: data.baseline,
            R: data.R,
            T: data.T,
            samples: data.samples,
            // ビューごとのRMS誤差（棒グラフ用）
            viewErrors: data.perViewErrors || data.viewErrors || [],
            rvecs: data.rvecs || [],
            tvecs: data.tvecs || [],
            // グラフ表示用の点群データ
            objectPoints: data.objectPoints || [],
            imagePoints1: data.imagePoints1 || [],
            imagePoints2: data.imagePoints2 || []
        };

        // 内部パラメータも復元（存在する場合）
        if (data.cam1 || data.cam2) {
            if (!window.projectData) window.projectData = {};
            window.projectData.stereoIntrinsics = window.projectData.stereoIntrinsics || {};
            if (data.cam1) {
                window.projectData.stereoIntrinsics.cam1 = {
                    cameraMatrix: data.cam1.cameraMatrix,
                    distCoeffs: data.cam1.distCoeffs,
                    reprojectionError: data.cam1.reprojectionError,
                    samples: data.cam1.samples
                };
            }
            if (data.cam2) {
                window.projectData.stereoIntrinsics.cam2 = {
                    cameraMatrix: data.cam2.cameraMatrix,
                    distCoeffs: data.cam2.distCoeffs,
                    reprojectionError: data.cam2.reprojectionError,
                    samples: data.cam2.samples
                };
            }
        }

        // UI更新
        updateStereoCalibrationResultUI(window.projectData.stereoCalibration);
        if (typeof updateStereoIntrinsicDisplay === 'function') {
            updateStereoIntrinsicDisplay();
        }
        if (typeof updateIntrinsicStatus === 'function') {
            updateIntrinsicStatus();
        }

        showMessage(`ステレオキャリブレーション結果を読み込みました: ${result.filePath} `);
    } catch (e) {
        showError('ステレオキャリブレーション結果の読み込み中にエラーが発生しました: ' + e.message);
    }
};

/**
 * ステレオキャリブレーション結果の3D表示
 * show3DCalibrationView に統合されたため、そちらを呼び出す
 */
window.showStereo3DView = function () {
    // show3DCalibrationView を呼び出す（ステレオモードの場合はステレオ表示される）
    if (typeof window.show3DCalibrationView === 'function') {
        window.show3DCalibrationView();
    } else {
        showError('3D表示機能が利用できません');
    }
};

// ステレオ用: Cam2 の内部パラメータ表示
function updateStereoIntrinsicDisplay() {
    const panelCam2 = document.getElementById('calibration-result-panel-cam2');
    if (!panelCam2) return;

    const methodSelect = document.getElementById('calibration-method');
    const isStereo = methodSelect && methodSelect.value === 'charuco-stereo';

    // ステレオ以外ではパネルごと非表示
    panelCam2.style.display = isStereo ? '' : 'none';
    if (!isStereo) {
        const reset = (id, val = '-') => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        reset('calib2-samples');
        reset('calib2-reproj');
        reset('calib2-fx');
        reset('calib2-fy');
        reset('calib2-cx');
        reset('calib2-cy');
        return;
    }

    const intr = window.projectData?.stereoIntrinsics?.cam2 || null;

    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    if (!intr || !intr.cameraMatrix) {
        set('calib2-samples', '-');
        set('calib2-reproj', '-');
        set('calib2-fx', '-');
        set('calib2-fy', '-');
        set('calib2-cx', '-');
        set('calib2-cy', '-');
        return;
    }

    const M = intr.cameraMatrix || [];
    const fx = M[0], fy = M[4], cx = M[2], cy = M[5];

    set('calib2-samples', intr.samples ?? '-');
    set('calib2-reproj',
        (typeof intr.reprojectionError === 'number')
            ? intr.reprojectionError.toFixed(6)
            : (intr.reprojectionError ?? '-')
    );
    set('calib2-fx', (fx != null) ? Number(fx).toFixed(6) : '-');
    set('calib2-fy', (fy != null) ? Number(fy).toFixed(6) : '-');
    set('calib2-cx', (cx != null) ? Number(cx).toFixed(6) : '-');
    set('calib2-cy', (cy != null) ? Number(cy).toFixed(6) : '-');
}

// updateStereoIntrinsicDisplayをグローバルに公開
window.updateStereoIntrinsicDisplay = updateStereoIntrinsicDisplay;

function populateExtrinsicViewSelect(calib) {
    const sel = document.getElementById('calib-view-select');
    if (!sel) return;
    sel.innerHTML = '';
    const n = (calib && calib.rvecs) ? calib.rvecs.length : 0;
    for (let i = 0; i < n; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `#${i + 1} `;
        sel.appendChild(opt);
    }
    sel.onchange = () => {
        const idx = parseInt(sel.value || '0', 10) || 0;
        updateExtrinsicResultUI(calib, idx);
    };
}

function updateExtrinsicResultUI(calib, idx) {
    if (!calib) return;
    const r = (calib.rvecs && calib.rvecs[idx]) ? calib.rvecs[idx] : null;
    const t = (calib.tvecs && calib.tvecs[idx]) ? calib.tvecs[idx] : null;
    const R = (calib.rotationMatrices && calib.rotationMatrices[idx]) ? calib.rotationMatrices[idx] : null;

    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt('calib-rvec', r ? `[${r.map(v => Number(v).toFixed(6)).join(', ')}]` : '-');
    setTxt('calib-tvec', t ? `[${t.map(v => Number(v).toFixed(6)).join(', ')}]` : '-');

    if (R && R.length === 9) {
        // テーブル形式のR行列表示用
        const updateRRow = (rowId, v0, v1, v2) => {
            const row = document.getElementById(rowId);
            if (row) {
                row.innerHTML = `<td>${Number(v0).toFixed(6)}</td><td>${Number(v1).toFixed(6)}</td><td>${Number(v2).toFixed(6)}</td>`;
            }
        };
        updateRRow('calib-R-row0', R[0], R[1], R[2]);
        updateRRow('calib-R-row1', R[3], R[4], R[5]);
        updateRRow('calib-R-row2', R[6], R[7], R[8]);
    } else {
        const resetRRow = (rowId) => {
            const row = document.getElementById(rowId);
            if (row) row.innerHTML = '<td>-</td><td>-</td><td>-</td>';
        };
        resetRRow('calib-R-row0');
        resetRRow('calib-R-row1');
        resetRRow('calib-R-row2');
    }

    // 距離計算（tはボード原点のカメラ座標）
    if (t && t.length === 3) {
        const tx = Number(t[0]);
        const ty = Number(t[1]);
        const tz = Number(t[2]);
        const dOrigin = Math.sqrt(tx * tx + ty * ty + tz * tz);
        setTxt('calib-dist-origin', dOrigin.toFixed(6));
        setTxt('calib-dist-z', tz.toFixed(6));

        // 面法線方向の距離: |n^T * t|, n = R[:,2]（ボードのZ軸）
        if (R && R.length === 9) {
            const nx = Number(R[2]);
            const ny = Number(R[5]);
            const nz = Number(R[8]);
            const dPlane = Math.abs(nx * tx + ny * ty + nz * tz);
            setTxt('calib-dist-plane', dPlane.toFixed(6));
        } else {
            setTxt('calib-dist-plane', '-');
        }
    } else {
        setTxt('calib-dist-origin', '-');
        setTxt('calib-dist-z', '-');
        setTxt('calib-dist-plane', '-');
    }
}

// ============================
// ChArUco ボード検出
// ============================

/**
 * ChArUcoボードをcanvas現在画像から検出し結果をオーバーレイ描画する。
 * シングルモード（charuco-single）とステレオモード（charuco-stereo）両対応。
 */

// ---- Canvas → RGBA 生ピクセル Buffer への変換（モジュール共通ヘルパー） ----
// JPEG エンコード/デコードを完全にバイパスして検出速度を向上。
// Electron 33+ は Node Buffer を IPC でゼロコピー転送する。
function canvasToImageDataObj(source) {
    try {
        const w = source.width || source.videoWidth;
        const h = source.height || source.videoHeight;
        if (!w || !h) return null;

        let srcCanvas = source;
        if (!(source instanceof HTMLCanvasElement)) {
            const tmp = document.createElement('canvas');
            tmp.width = w;
            tmp.height = h;
            tmp.getContext('2d').drawImage(source, 0, 0);
            srcCanvas = tmp;
        }
        const ctx = srcCanvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, w, h);
        const buffer = Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
        return {
            width: w,
            height: h,
            channels: 4,
            stride: w * 4,
            buffer
        };
    } catch (e) {
        console.error('[canvasToImageDataObj] error:', e);
        return null;
    }
}

async function detectCharucoBoard() {
    // 重複実行防止
    if (window.__charucoDetectionInProgress) {
        return;
    }

    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    const isStereo = (method === 'charuco-stereo');
    const isSingle = (method === 'charuco-single');

    if (!isSingle && !isStereo) {
        // ChArUco法以外では何もしない
        return;
    }

    // UIからボード設定を取得するヘルパー
    function getBoardConfig() {
        const rowsEl = document.getElementById('charuco-rows');
        const colsEl = document.getElementById('charuco-cols');
        const sqEl = document.getElementById('charuco-square-mm');
        const mkEl = document.getElementById('charuco-marker-mm');
        const dictEl = document.getElementById('charuco-dictionary');
        return {
            rows: rowsEl ? parseInt(rowsEl.value, 10) : 5,
            cols: colsEl ? parseInt(colsEl.value, 10) : 7,
            squareSizeMm: sqEl ? parseFloat(sqEl.value) : 165,
            markerSizeMm: mkEl ? parseFloat(mkEl.value) : 123,
            dictionary: dictEl && dictEl.value ? dictEl.value : 'DICT_4X4_50',
            legacyPattern: true
        };
    }

    const frameNumber = (projectData && projectData.settings && projectData.settings.currentFrame) || 1;

    // canvas/ctx を取得
    const canvas = document.getElementById('digitize-canvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) {
        console.warn('[detectCharucoBoard] canvas not found');
        return;
    }

    // zoom/pan 変換を canvas 座標→フレーム座標に変換するヘルパー
    // digitizeCanvas に描かれている変換: translate(w/2,h/2) translate(panX,panY) scale(z,z) drawImage(src, -sw/2, -sh/2)
    // 逆変換: (canvasX - w/2 - panX) / zoom + sw/2
    function canvasToFrame(cx, cy, srcW, srcH) {
        const cw = canvas.width;
        const ch = canvas.height;
        const z = (typeof zoomScale !== 'undefined') ? zoomScale : 1;
        const px = (typeof panX !== 'undefined') ? panX : 0;
        const py = (typeof panY !== 'undefined') ? panY : 0;
        return {
            x: (cx - cw / 2 - px) / z + srcW / 2,
            y: (cy - ch / 2 - py) / z + srcH / 2
        };
    }

    /**
     * 1枚の画像に対して検出し、canvasの指定領域にオーバーレイ描画する。
     * @param {string} videoPath  - 動画ファイルパス（IPC用）
     * @param {object|null} imageData - { width, height, channels, buffer } or null
     * @param {object} boardConfig  - ボード設定
     * @param {number} frameOffsetX - ステレオ時の左ビューX開始位置（フレーム座標）
     * @param {number} frameW       - ビューの幅（フレーム座標）
     * @param {number} frameH       - ビューの高さ（フレーム座標）
     * @returns {{ corners, markerCorners, ids }} 検出結果
     */
    async function detectAndDrawSingle(videoPath, imageData, boardConfig, frameOffsetX, frameW, frameH) {
        const res = await ipcRenderer.invoke('detect-charuco-board', {
            videoPath,
            frameNumber,
            boardConfig,
            imageData
        });

        if (!res || !res.success) {
            console.warn('[detectCharucoBoard] 検出失敗:', res && res.error);
            return null;
        }

        // ---- canvas オーバーレイ描画 ----
        const z = (typeof zoomScale !== 'undefined') ? zoomScale : 1;
        const px = (typeof panX !== 'undefined') ? panX : 0;
        const py = (typeof panY !== 'undefined') ? panY : 0;
        const cw = canvas.width;
        const ch = canvas.height;

        // フレーム座標 (fx, fy) → canvas 座標変換
        // (フレームが canvasの中央に scale/translate で配置されている前提)
        // ステレオ時: cam2 は フレームoffsetX分ズレている
        function frameToCanvas(fx, fy) {
            // stereoCanvas上のX = fx + frameOffsetX (cam1: +0, cam2: +cam1W)
            // renderImageの変換: translate(cw/2,ch/2) scale(z) drawImage(src, -cw/2, -ch/2)
            // → canvas座標 = (stereoX - cw/2) * z + cw/2 + px
            const localX = (fx + frameOffsetX - cw / 2) * z + cw / 2 + px;
            // Y方向: cam1/2ともにcombinedHeight中心に配置 → (fy - frameH/2)*z + ch/2 + py
            const localY = (fy - frameH / 2) * z + ch / 2 + py;
            return { x: localX, y: localY };
        }
        function scalePx(px_) { return px_ * z; }

        ctx.save();

        // ChArUcoコーナー（内側コーナー点） → シアン円
        // ネイティブは charucoCorners: [{x, y}, ...], charucoIds: [id, ...] を返す
        const corners = res.charucoCorners || [];
        const cornerIds = res.charucoIds || [];
        if (corners.length > 0) {
            ctx.strokeStyle = 'cyan';
            ctx.fillStyle = 'cyan';
            ctx.lineWidth = Math.max(1, scalePx(2));
            const r = Math.max(2, scalePx(5));
            corners.forEach((c, i) => {
                if (!c) return;
                // ネイティブは {x, y} オブジェクト形式
                const fx = (c.x !== undefined) ? c.x : (Array.isArray(c) ? c[0] : 0);
                const fy = (c.y !== undefined) ? c.y : (Array.isArray(c) ? c[1] : 0);
                const p = frameToCanvas(fx, fy);
                ctx.beginPath();
                ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
                ctx.fill();
                // IDラベル
                if (cornerIds[i] !== undefined) {
                    ctx.fillStyle = 'cyan';
                    ctx.font = `bold ${Math.max(18, scalePx(28))}px Arial`;
                    ctx.fillText(String(cornerIds[i]), p.x + r + 2, p.y - r);
                }
            });
        }

        // ArUcoマーカーの4隅 → 緑矩形
        // ネイティブは markerCorners2D: [[{x,y},{x,y},{x,y},{x,y}], ...] を返す
        const markerCornersData = res.markerCorners2D || [];
        if (markerCornersData.length > 0) {
            ctx.strokeStyle = '#00ff44';
            ctx.lineWidth = Math.max(1, scalePx(2));
            markerCornersData.forEach(mc => {
                if (!mc || mc.length < 4) return;
                const pts = mc.map(pt => {
                    const fx = (pt.x !== undefined) ? pt.x : (Array.isArray(pt) ? pt[0] : 0);
                    const fy = (pt.y !== undefined) ? pt.y : (Array.isArray(pt) ? pt[1] : 0);
                    return frameToCanvas(fx, fy);
                });
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
                ctx.closePath();
                ctx.stroke();
            });
        }

        // テキストオーバーレイ描画（コーナー数・マーカー数）
        const cornerCount = corners.length;
        const markerCount = markerCornersData.length;
        const camLabel = (frameOffsetX === 0) ? 'Cam1' : 'Cam2';

        // テキスト位置（左上に表示）
        // canvasと実フレームの縦方向スケール比を計算して文字サイズをスケール
        const scaleRatio = ch / frameH;  // canvas/動画 の縦比率
        const baseFontSize = Math.max(40, Math.round(80 * scaleRatio));
        const subFontSize = Math.max(24, Math.round(45 * scaleRatio));
        const lh = Math.round(baseFontSize * 1.15); // lineHeight
        const pt = frameToCanvas(20, 20); // テキスト左上位置
        const textX = pt.x;
        const textY = pt.y;

        ctx.font = `bold ${baseFontSize}px Arial`;
        ctx.textBaseline = 'top';

        // 影を付けて視認性を確保
        ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 3;
        ctx.shadowOffsetY = 3;

        // カメララベル（黄色）—ステレオ時のCam2はレイアウト上おかしいので非表示
        if (frameOffsetX === 0) {
            ctx.fillStyle = '#ffff00';
            ctx.fillText(camLabel, textX, textY);
        } else {
            ctx.fillStyle = '#ffff00';
            ctx.fillText(camLabel, textX, textY);
        }

        // マーカー数・コーナー数（白）
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`マーカー: ${markerCount}個`, textX, textY + lh);
        ctx.fillText(`コーナー: ${cornerCount}個`, textX, textY + lh * 2);

        // コーナーIDを表示（デバッグ用）
        if (cornerIds.length > 0) {
            ctx.font = `bold ${subFontSize}px Arial`;
            ctx.fillStyle = '#00ffff';
            ctx.fillText(`ID: [${cornerIds.join(', ')}]`, textX, textY + lh * 3);

            // --- 各カメラごとの「追加可能」判定の表示 ---
            const methodSelect = document.getElementById('calibration-method');
            const currentMode = typeof getCurrentMode === 'function' ? getCurrentMode() : '';
            const isStereo = (currentMode === 'calibration' && methodSelect && methodSelect.value === 'charuco-stereo');

            if (isStereo) {
                // そのカメラ単体のコーナー数が6以上かどうかで判定
                const canAddLocal = cornerIds.length >= 6;
                let statusText = canAddLocal ? '追加可能' : '追加不可';
                let statusColor = canAddLocal ? '#00e676' : '#ff5252';

                ctx.fillStyle = statusColor;
                ctx.fillText(statusText, textX, textY + lh * 4);
            }
        }

        // 影をリセット
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        ctx.restore();

        return res;
    }

    // ---- 元フレーム画像(ImageData形式)を取得するヘルパー ----
    function getOriginalImageDataForCamera(camKey) {
        const keyMap = {
            'cam1': window.__originalFrameImageData_cam1,
            'cam2': window.__originalFrameImageData_cam2,
            'single': window.__originalFrameImageData
        };
        const frameMap = {
            'cam1': window.__originalFrameNumber_cam1,
            'cam2': window.__originalFrameNumber_cam2,
            'single': window.__originalFrameNumber
        };
        const stored = keyMap[camKey];
        const storedFrame = frameMap[camKey];
        const currentFrame = (typeof getCurrentFrameNumber === 'function') ? getCurrentFrameNumber() : (projectData?.settings?.currentFrame || 1);

        if (stored && Number(storedFrame) === Number(currentFrame)) {
            return stored;
        }

        try {
            const v1 = (typeof digitizeVideo !== 'undefined') ? digitizeVideo : null;
            const v2 = (typeof digitizeVideo2 !== 'undefined') ? digitizeVideo2 : null;
            let targetVideo = null;
            if (camKey === 'cam1' || camKey === 'single') targetVideo = v1;
            else if (camKey === 'cam2') targetVideo = v2;

            let obj = null;
            if (targetVideo && targetVideo.videoWidth > 0 && targetVideo.readyState >= 2) {
                obj = canvasToImageDataObj(targetVideo);
            } else if (canvas.currentImage && !(canvas.currentImage instanceof HTMLCanvasElement)) {
                obj = canvasToImageDataObj(canvas.currentImage);
            }

            if (obj) {
                if (camKey === 'cam1') {
                    window.__originalFrameImageData_cam1 = obj;
                    window.__originalFrameNumber_cam1 = currentFrame;
                    window.__originalFrameNumber_stereo = currentFrame;
                } else if (camKey === 'cam2') {
                    window.__originalFrameImageData_cam2 = obj;
                    window.__originalFrameNumber_cam2 = currentFrame;
                    window.__originalFrameNumber_stereo = currentFrame;
                } else if (camKey === 'single') {
                    window.__originalFrameImageData = obj;
                    window.__originalFrameNumber = currentFrame;
                }
                return obj;
            }

            console.warn(`[getOriginalImageDataForCamera] Unable to get clean frame for ${camKey}`);
            return null;
        } catch (e) {
            console.error('[getOriginalImageDataForCamera] error:', e);
            return null;
        }
    }

    window.__charucoDetectionInProgress = true;

    try {
        const boardConfig = getBoardConfig();

        if (isStereo) {
            // ---- ステレオモード: カメラ1・2を並列検出 ----
            const cam1File = (typeof fileState !== 'undefined') ? fileState['cal-cam1'] : null;
            const cam2File = (typeof fileState !== 'undefined') ? fileState['cal-cam2'] : null;
            if (!cam1File || !cam2File) {
                showMessage('ステレオキャリブレーション: カメラ1・2の動画を選択してください');
                return;
            }
            const path1 = typeof cam1File === 'string' ? cam1File : cam1File.path;
            const path2 = typeof cam2File === 'string' ? cam2File : cam2File.path;

            // 現在のstereoCanvas情報（displayCurrentFrameで更新済み）からサイズを取得
            const srcImg = canvas.currentImage; // stereoCanvas or img
            let totalW = canvas.width;
            let totalH = canvas.height;
            if (srcImg) {
                totalW = srcImg.width || srcImg.videoWidth || totalW;
                totalH = srcImg.height || srcImg.videoHeight || totalH;
            }

            // ---- cam1/cam2 の実際のビデオサイズを優先的に使用 ----
            // digitizeVideo/digitizeVideo2 はui-components.jsで管理されている
            const v1 = (typeof digitizeVideo !== 'undefined') ? digitizeVideo : null;
            const v2 = (typeof digitizeVideo2 !== 'undefined') ? digitizeVideo2 : null;

            const cam1W = (v1 && v1.videoWidth > 0) ? v1.videoWidth : (totalW / 2);
            const cam1H = (v1 && v1.videoHeight > 0) ? v1.videoHeight : totalH;
            const cam2W = (v2 && v2.videoWidth > 0) ? v2.videoWidth : (totalW - cam1W);
            const cam2H = (v2 && v2.videoHeight > 0) ? v2.videoHeight : totalH;

            console.log('[detectCharucoBoard] stereo sizes: cam1=' + cam1W + 'x' + cam1H + ' cam2=' + cam2W + 'x' + cam2H);

            // 各カメラ画像を ImageData 形式で切り出す（生ピクセル、JPEGエンコードなし）
            function extractCamImageData(camIdx) {
                try {
                    const w = (camIdx === 1) ? cam1W : cam2W;
                    const h = (camIdx === 1) ? cam1H : cam2H;
                    const offsetX = (camIdx === 1) ? 0 : cam1W;
                    const vElem = (camIdx === 1) ? v1 : v2;

                    if (w <= 0 || h <= 0) {
                        console.warn('[detectCharucoBoard] cam' + camIdx + ' size is 0, skip');
                        return null;
                    }

                    const tmp = document.createElement('canvas');
                    tmp.width = w;
                    tmp.height = h;
                    const tctx = tmp.getContext('2d');

                    if (srcImg && (srcImg.width > 0 || srcImg.videoWidth > 0)) {
                        tctx.drawImage(srcImg, offsetX, 0, w, h, 0, 0, w, h);
                    } else if (vElem && vElem.videoWidth > 0 && vElem.readyState >= 2) {
                        tctx.drawImage(vElem, 0, 0, vElem.videoWidth, vElem.videoHeight, 0, 0, w, h);
                    } else {
                        console.warn('[detectCharucoBoard] cam' + camIdx + ': no valid source image');
                        return null;
                    }
                    return canvasToImageDataObj(tmp);
                } catch (e) {
                    console.error('[detectCharucoBoard] extractCamImageData error:', e);
                    return null;
                }
            }

            const stored1 = (window.__originalFrameImageData_cam1 && window.__originalFrameNumber_stereo === frameNumber)
                ? window.__originalFrameImageData_cam1 : null;
            const stored2 = (window.__originalFrameImageData_cam2 && window.__originalFrameNumber_stereo === frameNumber)
                ? window.__originalFrameImageData_cam2 : null;
            const img1 = stored1 || extractCamImageData(1);
            const img2 = stored2 || extractCamImageData(2);

            if (!img1 || !img2) {
                showMessage('ChArUcoボード検出: カメラ映像が準備できていません。フレームを再表示してから再試行してください。');
                setCalibStatus('映像未準備', 'error');
                return;
            }

            // 元フレーム画像を保存（フレーム追加時に使用）
            window.__originalFrameImageData_cam1 = img1;
            window.__originalFrameImageData_cam2 = img2;
            window.__originalFrameNumber_stereo = frameNumber;

            showMessage('ChArUcoボード検出中（ステレオ）…');

            const [res1, res2] = await Promise.all([
                detectAndDrawSingle(path1, img1, boardConfig, 0, cam1W, cam1H),
                detectAndDrawSingle(path2, img2, boardConfig, cam1W, cam2W, cam2H)
            ]);

            // 検出結果表示（ネイティブのcharucoCorners/markerCorners2Dを使用）
            const c1 = (res1 && res1.charucoCorners) ? res1.charucoCorners.length : (res1 ? (res1.cornerCount || 0) : 0);
            const c2 = (res2 && res2.charucoCorners) ? res2.charucoCorners.length : (res2 ? (res2.cornerCount || 0) : 0);
            const m1 = (res1 && res1.markerCorners2D) ? res1.markerCorners2D.length : (res1 ? (res1.markerCount || 0) : 0);
            const m2 = (res2 && res2.markerCorners2D) ? res2.markerCorners2D.length : (res2 ? (res2.markerCount || 0) : 0);
            const ids1 = (res1 && res1.charucoIds) ? res1.charucoIds : [];
            const ids2 = (res2 && res2.charucoIds) ? res2.charucoIds : [];
            console.log('[detectCharucoBoard] Detection results:',
                'Cam1 corners:', c1, 'ids:', JSON.stringify(ids1),
                'Cam2 corners:', c2, 'ids:', JSON.stringify(ids2));

            const msg = `Cam1 マーカー${m1}個・コーナー${c1}個 / Cam2 マーカー${m2}個・コーナー${c2}個`;
            showMessage(msg);

            // 検出数UIを更新（ステータスバーには反映しない、サイドバーのみ）
            updateCharucoDetectionCountUI(c1, m1, c2, m2);

            // オーバーレイ込みのcanvas内容をcurrentImageとして保存（フレーム移動時の上書き防止）
            const overlayCanvas = document.createElement('canvas');
            overlayCanvas.width = canvas.width;
            overlayCanvas.height = canvas.height;
            const octx = overlayCanvas.getContext('2d');
            octx.drawImage(canvas, 0, 0);
            canvas.currentImage = overlayCanvas;
            console.log('[detectCharucoBoard] Updated currentImage with overlay');

        } else {
            // ---- シングルモード: 1カメラ ----
            const settings = projectData && projectData.settings ? projectData.settings : {};
            const videoFile = settings.videoFile;
            const videoPath = typeof videoFile === 'string' ? videoFile : (videoFile && videoFile.path);

            // fileStateからキャリブレーション用の動画パスも確認
            let path = videoPath;
            if (!path && typeof fileState !== 'undefined') {
                const cam1File = fileState['cal-cam1'];
                if (cam1File) {
                    path = typeof cam1File === 'string' ? cam1File : cam1File.path;
                }
            }

            if (!path) {
                showMessage('動画が選択されていません');
                setCalibStatus('動画未選択', 'error');
                return;
            }

            const imageData = getOriginalImageDataForCamera('single');

            const srcImg = canvas.currentImage;
            const frameW = srcImg ? (srcImg.width || srcImg.videoWidth || canvas.width) : canvas.width;
            const frameH = srcImg ? (srcImg.height || srcImg.videoHeight || canvas.height) : canvas.height;

            showMessage('ChArUcoボード検出中…');
            const res = await detectAndDrawSingle(path, imageData, boardConfig, 0, frameW, frameH);

            if (res) {
                const corners = (res.charucoCorners || []).length || res.cornerCount || 0;
                const markers = (res.markerCorners2D || []).length || res.markerCount || 0;
                const msg = `マーカー${markers}個・コーナー${corners}個`;
                showMessage(msg);
                // サイドバーの検出数のみ更新（ステータスバーには反映しない）
                updateCharucoDetectionCountUI(corners, markers, null, null);

                // オーバーレイ込みのcanvas内容をcurrentImageとして保存
                const overlayCanvas = document.createElement('canvas');
                overlayCanvas.width = canvas.width;
                overlayCanvas.height = canvas.height;
                const octx = overlayCanvas.getContext('2d');
                octx.drawImage(canvas, 0, 0);
                canvas.currentImage = overlayCanvas;
            } else {
                showMessage('ChArUcoボード検出: ボードが見つかりませんでした');
                updateCharucoDetectionCountUI(0, 0, null, null);
            }
        }
    } catch (e) {
        console.error('[detectCharucoBoard] error:', e);
        showMessage('ChArUcoボード検出エラー: ' + e.message);
        setCalibStatus('検出エラー: ' + e.message, 'error');
    } finally {
        window.__charucoDetectionInProgress = false;
    }
}

/**
 * ChArUco検出数をサイドバーのUIを更新する。
 * @param {number} corners1 - Cam1（シングル時はcam1）の検出コーナー数
 * @param {number} markers1 - Cam1（シングル時はcam1）の検出マーカー数
 * @param {number|null} corners2 - Cam2の検出コーナー数（シングル時はnull）
 * @param {number|null} markers2 - Cam2の検出マーカー数（シングル時はnull）
 */
function updateCharucoDetectionCountUI(corners1, markers1, corners2, markers2) {
    try {
        const isStereo = corners2 !== null && corners2 !== undefined;

        // シングル表示/ステレオ表示の切り替え
        const singleDiv = document.getElementById('charuco-detect-single');
        const stereoDiv = document.getElementById('charuco-detect-stereo');

        if (isStereo) {
            if (singleDiv) singleDiv.style.display = 'none';
            if (stereoDiv) stereoDiv.style.display = 'block';

            const c1El = document.getElementById('charuco-corners-cam1');
            const m1El = document.getElementById('charuco-markers-cam1');
            const c2El = document.getElementById('charuco-corners-cam2');
            const m2El = document.getElementById('charuco-markers-cam2');
            if (c1El) c1El.textContent = String(corners1 || 0);
            if (m1El) m1El.textContent = String(markers1 || 0);
            if (c2El) c2El.textContent = String(corners2 || 0);
            if (m2El) m2El.textContent = String(markers2 || 0);
        } else {
            if (singleDiv) singleDiv.style.display = 'block';
            if (stereoDiv) stereoDiv.style.display = 'none';

            const cornerEl = document.getElementById('charuco-corners');
            const markerEl = document.getElementById('charuco-markers');
            if (cornerEl) cornerEl.textContent = String(corners1 || 0);
            if (markerEl) markerEl.textContent = String(markers1 || 0);
        }
    } catch (_) { }
}

// グローバルに公開
window.detectCharucoBoard = detectCharucoBoard;
window.updateCharucoDetectionCountUI = updateCharucoDetectionCountUI;

window.calibration = {
    start: startCalibrationSession,
    capture: captureCalibrationSample,
    compute: computeCalibration
};

// ============================
// ステレオ ChArUco キャリブレーション
// ============================

window.stereoCalibration = {
    async start() {
        // ステレオ用内部パラメータをカメラ別に優先的に使用（オプション）
        let K1 = null, dist1 = null, K2 = null, dist2 = null;
        let hasIntrinsics = false;

        // 1) ステレオ専用の内部パラメータJSONが両方読み込まれているかをチェック
        if (
            window.projectData?.stereoIntrinsics?.cam1 &&
            window.projectData?.stereoIntrinsics?.cam2 &&
            Array.isArray(window.projectData.stereoIntrinsics.cam1.cameraMatrix) &&
            Array.isArray(window.projectData.stereoIntrinsics.cam1.distCoeffs) &&
            Array.isArray(window.projectData.stereoIntrinsics.cam2.cameraMatrix) &&
            Array.isArray(window.projectData.stereoIntrinsics.cam2.distCoeffs)) {

            K1 = window.projectData.stereoIntrinsics.cam1.cameraMatrix;
            dist1 = window.projectData.stereoIntrinsics.cam1.distCoeffs;
            K2 = window.projectData.stereoIntrinsics.cam2.cameraMatrix;
            dist2 = window.projectData.stereoIntrinsics.cam2.distCoeffs;
            hasIntrinsics = true;
        } else {
            // フォールバック: 単眼キャリブ結果を両カメラ共通として使用
            // 【修正】このロジックは削除: 単一のパラメータを両方に使用してしまい、かつ同時推定（結果の保存）を阻害するため
            /* 
            const calib = projectData.calibration;
            if (calib && Array.isArray(calib.cameraMatrix) && Array.isArray(calib.distCoeffs)) {
                K1 = calib.cameraMatrix;
                dist1 = calib.distCoeffs;
                K2 = calib.cameraMatrix;
                dist2 = calib.distCoeffs;
                hasIntrinsics = true;
            }
            */
            // 内部パラメータがない場合でも続行（同時推定モード）
        }

        // ステータス行に開始処理中であることを表示
        try {
            if (hasIntrinsics) {
                setCalibStatus('ステレオセッション初期化中…（内部パラメータ固定モード）');
            } else {
                setCalibStatus('ステレオセッション初期化中…（内部パラメータ同時推定モード）');
            }
        } catch (_) { }

        // 内部パラメータがある場合のみ渡す、ない場合は空のパラメータ
        const params = hasIntrinsics ? { K1, dist1, K2, dist2 } : {};
        const res = await ipcRenderer.invoke('charuco-stereo-start', params);
        if (!res || !res.success) {
            const msg = res && res.error ? res.error : 'ステレオキャリブセッション開始に失敗しました';
            showError(msg);
            try { setCalibStatus(`ステレオ開始失敗: ${msg} `, 'error'); } catch (_) { }
        } else {
            const modeMsg = res.hasIntrinsics ? '（内部パラメータ固定）' : '（同時推定モード）';
            showMessage(`ステレオChArUcoキャリブレーションセッションを開始しました${modeMsg} `);
            try { setCalibStatus(`ステレオセッション開始${modeMsg} `, 'success'); } catch (_) { }
            // 単眼と同様に、自動追加判定の対象期間を開始
            window.__calibActive = true;
            // 視覚的なフィードバックのため、開始直後に1回だけ左右同時検出を実行（失敗しても無視）
            try {
                if (typeof window.detectCharucoBoard === 'function') {
                    await window.detectCharucoBoard();
                }
            } catch (_) { }
        }
        return res;
    },

    async capture() {
        // カメラ1・2のキャリブレーション動画が必要
        const cam1 = fileState['cal-cam1'];
        const cam2 = fileState['cal-cam2'];
        if (!cam1 || !cam2) {
            showError('ステレオキャリブレーションにはキャリブレーション動画（カメラ1・2）の両方が必要です。');
            return { success: false };
        }
        const frameNumber = projectData.settings.currentFrame || 1;

        // ボード設定をUIから取得（detectCharucoBoard / captureCalibrationSample と同等）
        const rowsEl = document.getElementById('charuco-rows');
        const colsEl = document.getElementById('charuco-cols');
        const sqEl = document.getElementById('charuco-square-mm');
        const mkEl = document.getElementById('charuco-marker-mm');
        const dictEl = document.getElementById('charuco-dictionary');

        const rows = rowsEl ? parseInt(rowsEl.value, 10) : 5;
        const cols = colsEl ? parseInt(colsEl.value, 10) : 7;
        const squareMm = sqEl ? parseFloat(sqEl.value) : 165;
        const markerMm = mkEl ? parseFloat(mkEl.value) : 123;
        const dictionary = dictEl && dictEl.value ? dictEl.value : 'DICT_4X4_50';

        const boardConfig = {
            rows,
            cols,
            squareSizeMm: squareMm,
            markerSizeMm: markerMm,
            dictionary,
            legacyPattern: true
        };

        const videoPath1 = typeof cam1 === 'string' ? cam1 : cam1.path;
        const videoPath2 = typeof cam2 === 'string' ? cam2 : cam2.path;

        // 検出時に保存した元フレーム ImageData を使用（アノテーション描画前の状態）
        let imageData1 = null;
        let imageData2 = null;

        const frameMatchesDetectStereo =
            window.__originalFrameImageData_cam1 && window.__originalFrameImageData_cam2 &&
            Number(window.__originalFrameNumber_stereo) === Number(frameNumber);

        if (!frameMatchesDetectStereo && typeof window.detectCharucoBoard === 'function') {
            await window.detectCharucoBoard();
        }

        if (window.__originalFrameImageData_cam1 && window.__originalFrameImageData_cam2 &&
            Number(window.__originalFrameNumber_stereo) === Number(frameNumber)) {
            imageData1 = window.__originalFrameImageData_cam1;
            imageData2 = window.__originalFrameImageData_cam2;
        } else {
            // フォールバック: canvas.currentImage から左右を切り出す（アノテーションなし・生ピクセル）
            const canvas = document.getElementById('digitize-canvas');
            if (canvas && canvas.currentImage) {
                try {
                    const srcImage = canvas.currentImage;
                    const halfWidth = Math.floor(srcImage.width / 2);
                    const srcHeight = srcImage.height;
                    const canvas1 = document.createElement('canvas');
                    canvas1.width = halfWidth;
                    canvas1.height = srcHeight;
                    canvas1.getContext('2d').drawImage(srcImage, 0, 0, halfWidth, srcHeight, 0, 0, halfWidth, srcHeight);
                    imageData1 = canvasToImageDataObj(canvas1);
                    const canvas2 = document.createElement('canvas');
                    canvas2.width = srcImage.width - halfWidth;
                    canvas2.height = srcHeight;
                    canvas2.getContext('2d').drawImage(srcImage, halfWidth, 0, srcImage.width - halfWidth, srcHeight, 0, 0, srcImage.width - halfWidth, srcHeight);
                    imageData2 = canvasToImageDataObj(canvas2);
                } catch (e) {
                    console.warn('[CHARUCO-STEREO-CAPTURE] currentImage切り出し失敗:', e);
                }
            }
        }

        try { setCalibStatus(`ステレオサンプル追加中… (F: ${frameNumber})`); } catch (_) { }
        const res = await ipcRenderer.invoke('charuco-stereo-capture', {
            videoPath1,
            videoPath2,
            frameNumber,
            boardConfig,
            imageData1,
            imageData2
        });
        if (!res || !res.success) {
            let msg = res && res.error ? res.error : 'ステレオサンプルの追加に失敗しました';
            // commonCountを取得（エラーメッセージからも抽出を試みる）
            let commonCount = null;
            if (typeof res?.commonCount === 'number') {
                commonCount = res.commonCount;
            } else if (msg.includes('detected:')) {
                // エラーメッセージから数値を抽出: "detected: 4"
                const match = msg.match(/detected:\s*(\d+)/);
                if (match) {
                    commonCount = parseInt(match[1], 10);
                }
            }

            // エラーメッセージにデバッグ情報が含まれている場合はそのまま表示
            // （ネイティブコードで検出されたIDのリストが含まれている）
            if (msg.includes('Not enough common ChArUco corners') || msg.includes('Not enough common object points')) {
                const countText = (commonCount !== null) ? `${commonCount} 個` : '不明';
                // エラーメッセージから検出されたIDのリストを抽出
                let debugInfo = '';
                if (msg.includes('ids1:') && msg.includes('ids2:')) {
                    const ids1Match = msg.match(/ids1:\s*\[([^\]]+)\]/);
                    const ids2Match = msg.match(/ids2:\s*\[([^\]]+)\]/);
                    if (ids1Match && ids2Match) {
                        debugInfo = `\n検出ID - Cam1: [${ids1Match[1]}], Cam2: [${ids2Match[1]}]`;
                    }
                }
                msg = `共通のChArUcoコーナーが不足しています（検出: ${countText}、必要: 6個）。\n` +
                    `ボード全体が両方のカメラに写っているか、照明や角度を確認してください。${debugInfo} \n` +
                    `エラー詳細: ${msg} `;
            }
            showError(msg);
            try {
                setCalibStatus(`ステレオ追加失敗: 共通ID = ${commonCount ?? '?'}/6`, 'error');
            } catch (_) { }
            // オーバーレイ情報を更新（追加不可）
            window.__stereoOverlayInfo = {
                commonCount: commonCount,
                required: 6,
                canAdd: false
            };
            // 検出結果はすでに表示されているため、再描画は不要
        } else {
            showMessage(`ステレオサンプルを追加しました（フレーム: ${frameNumber}, 点数: ${res.points}, 累計: ${res.samples}件）`);
            try {
                setCalibStatus(
                    `ステレオ追加: フレーム${frameNumber} / ポイント${res.points} / 累計${res.samples}`,
                    'success'
                );
            } catch (_) { }
            // オーバーレイ情報を更新（追加可能）
            window.__stereoOverlayInfo = {
                commonCount: (typeof res.commonCount === 'number') ? res.commonCount : null,
                required: 6,
                canAdd: true
            };
            // 最後に追加したサンプル数を保存（3D表示用）
            window.__lastStereoCapture = { samples: res.samples };
        }
        // 検出結果はすでに表示されているため、再描画は不要
        // redrawCanvasOnly() を呼ぶと検出結果（マーカー・コーナー）が消えてしまう
        return res;
    },

    async compute() {
        try { setCalibStatus('ステレオキャリブレーション計算中…'); } catch (_) { }
        const res = await ipcRenderer.invoke('charuco-stereo-compute');
        if (!res || !res.success) {
            const msg = res && res.error ? res.error : 'ステレオキャリブレーション計算に失敗しました';
            showError(msg);
            try { setCalibStatus(`ステレオ計算失敗: ${msg}`, 'error'); } catch (_) { }
            return res;
        }

        // 結果を projectData に保持しておく
        // ステレオキャリブレーションのサンプル数を取得（最後に追加したサンプル数から）
        const lastCapture = window.__lastStereoCapture || {};
        const stereoSamples = lastCapture.samples || 0;

        // window.projectDataを明示的に使用（data-manager.jsとの共有を確実にするため）
        if (!window.projectData) window.projectData = {};
        window.projectData.stereoCalibration = {
            rms: res.rms,
            R: res.R,
            T: res.T,
            baseline: res.baseline,
            samples: stereoSamples,
            // ビューごとのRMS誤差（棒グラフ用）
            viewErrors: res.perViewErrors || res.viewErrors || [],
            // 各サンプルでのボード位置（Cam1座標系）
            rvecs: res.rvecs || [],
            tvecs: res.tvecs || [],
            // 拡張: 再投影誤差計算用の点群データ
            objectPoints: res.objectPoints || [],
            imagePoints1: res.imagePoints1 || [],
            imagePoints2: res.imagePoints2 || []
        };

        console.log('[StereoCalib] Compute result:', res);

        // NativeモジュールはK1, dist1などをDirectに返すため、UI/保存形式に合わせてcam1, cam2オブジェクトを構築
        if (!res.cam1 && res.K1 && res.dist1) {
            res.cam1 = {
                cameraMatrix: res.K1,
                distCoeffs: res.dist1
            };
        }
        if (!res.cam2 && res.K2 && res.dist2) {
            res.cam2 = {
                cameraMatrix: res.K2,
                distCoeffs: res.dist2
            };
        }

        // ステレオ計算で得られた各カメラの内部パラメータも保存
        if (res.cam1 && res.cam2) {
            console.log('[StereoCalib] Saving stereoIntrinsics from result');
            window.projectData.stereoIntrinsics = {
                cam1: res.cam1,
                cam2: res.cam2
            };
            // UIの内部パラメータ状態表示を更新
            if (typeof window.updateIntrinsicStatus === 'function') {
                window.updateIntrinsicStatus();
            }
        } else if (res.hasIntrinsics) {
            console.log('[StereoCalib] Using existing intrinsics (CALIB_FIX_INTRINSIC used).');
        } else {
            console.warn('[StereoCalib] res.cam1 or res.cam2 is MISSING. stereoIntrinsics will not be saved.');
        }

        const rmsText = typeof res.rms === 'number' ? res.rms.toFixed(4) : String(res.rms);
        const baselineText = typeof res.baseline === 'number' ? res.baseline.toFixed(3) : String(res.baseline);
        showMessage(`ステレオキャリブレーション完了（RMS: ${rmsText} px, ベースライン: ${baselineText}）`);

        // 既存のUI（例: ステータス行）にも簡易表示
        try {
            setCalibStatus(`ステレオ完了: RMS=${rmsText}px, baseline=${baselineText}`, 'success');
        } catch (_) { }

        // ステレオキャリブレーション結果を表示
        try {
            updateStereoCalibrationResultUI(window.projectData.stereoCalibration);
        } catch (_) { }

        // 収集セッション終了
        window.__calibActive = false;

        return res;
    }
};

// ステレオ ChArUco 用 3次元復元ヘルパー
// OpenCV 公式: undistortPoints / triangulatePoints
// https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html
window.charucoStereoTriangulate = async function (pointPairs) {
    if (!Array.isArray(pointPairs) || pointPairs.length === 0) {
        showError('3次元復元: pointPairs が空です');
        return { success: false, error: 'no points' };
    }

    const intr = window.projectData?.stereoIntrinsics || {};
    const cam1 = intr.cam1;
    const cam2 = intr.cam2;
    const stereo = window.projectData?.stereoCalibration || {};

    if (!cam1 || !cam2 || !Array.isArray(cam1.cameraMatrix) || !Array.isArray(cam2.cameraMatrix)) {
        showError('3次元復元: Cam1/Cam2 の内部パラメータが未設定です');
        return { success: false, error: 'intrinsics not set' };
    }
    if (!stereo.R || !stereo.T) {
        showError('3次元復元: ステレオキャリブレーション(R/T)が未計算です');
        return { success: false, error: 'stereo R/T not set' };
    }

    const flattenMat3x3 = (M) => {
        // cameraMatrix は [fx, 0, cx, 0, fy, cy, 0, 0, 1] の一次元配列を想定
        if (Array.isArray(M) && M.length === 9) return M.slice();
        return M;
    };

    const pointsCam1 = pointPairs.map(p => p.cam1);
    const pointsCam2 = pointPairs.map(p => p.cam2);

    const payload = {
        pointsCam1,
        pointsCam2,
        K1: flattenMat3x3(cam1.cameraMatrix),
        dist1: cam1.distCoeffs || [],
        K2: flattenMat3x3(cam2.cameraMatrix),
        dist2: cam2.distCoeffs || [],
        R: stereo.R || [],
        T: stereo.T || []
    };

    const res = await ipcRenderer.invoke('charuco-stereo-triangulate', payload);
    if (!res || !res.success) {
        showError('3次元復元に失敗しました: ' + (res && res.error ? res.error : 'unknown error'));
        return res;
    }
    // res.points3D: [{x,y,z}, ...]
    return res;
};

// ChArUcoシングルモード: 画像座標から実長座標への変換（ボード平面上）
window.charucoProjectPointsInverse = async function (imagePoints, cameraMatrix, distCoeffs, rvec, tvec) {
    if (!Array.isArray(imagePoints) || imagePoints.length === 0) {
        showError('画像座標が空です');
        return { success: false, error: 'no points' };
    }

    if (!cameraMatrix || !Array.isArray(cameraMatrix) || cameraMatrix.length !== 9) {
        showError('カメラマトリックスが不正です');
        return { success: false, error: 'invalid camera matrix' };
    }

    if (!distCoeffs || !Array.isArray(distCoeffs)) {
        showError('歪み係数が不正です');
        return { success: false, error: 'invalid dist coeffs' };
    }

    if (!rvec || !Array.isArray(rvec) || rvec.length !== 3) {
        showError('回転ベクトルが不正です');
        return { success: false, error: 'invalid rvec' };
    }

    if (!tvec || !Array.isArray(tvec) || tvec.length !== 3) {
        showError('並進ベクトルが不正です');
        return { success: false, error: 'invalid tvec' };
    }

    const payload = {
        imagePoints: imagePoints,
        cameraMatrix: cameraMatrix,
        distCoeffs: distCoeffs,
        rvec: rvec,
        tvec: tvec
    };

    const res = await ipcRenderer.invoke('charuco-project-points-inverse', payload);
    if (!res || !res.success) {
        showError('画像座標から実長座標への変換に失敗しました: ' + (res && res.error ? res.error : 'unknown error'));
        return res;
    }

    return res;
};

// ===== ChArUcoキャリブレーション手順ガイド =====
let charucoGuideState = {
    currentStep: 0,
    samples: 0,
    calibrationCompleted: false,
    saved: false
};

const CHARUCO_STEPS = [
    {
        id: 1,
        title: 'ボードの準備と設置',
        description: {
            single: 'ChArUcoボードを床や壁などに対して垂直に立てかけ、動作空間と同じ位置・高さに設置します。',
            stereo: 'ChArUcoボードを床や壁などに対して垂直に立てかけ、動作空間と同じ位置・高さに設置します。カメラ1/カメラ2の両方から同じボードが十分な大きさで写るように配置してください。'
        },
        action: null
    },
    {
        id: 2,
        title: '内部パラメータの準備',
        description: {
            single: '単眼ChArUcoキャリブレーションを実行し、内部パラメータを求めます（または保存済みJSONを読み込みます）。',
            stereo: '各カメラごとにChArUcoキャリブ結果JSONを読み込みます。カメラ選択で「カメラ1」「カメラ2」を切り替え、それぞれで「読み込み」ボタンからJSONを読み込んでください。'
        },
        action: null
    },
    {
        id: 3,
        title: 'セッション開始とサンプル追加',
        description: {
            single: '「自動ChArUcoボード検出」→「現在フレームを追加」でサンプルを蓄積します（20フレーム以上推奨）。',
            stereo: '「自動ChArUcoボード検出」ボタンを押してステレオセッションを開始します。フレームスライダーで左右映像を同期させ、良いフレームで「現在フレームを追加」を押してください（20フレーム以上推奨）。'
        },
        action: 'calibration.start()'
    },
    {
        id: 4,
        title: 'キャリブレーション計算',
        description: {
            single: '十分なサンプルが集まったら「キャリブレーション実行」で単眼キャリブレーションを計算します。',
            stereo: '十分なフレーム数が追加されたら「キャリブレーション実行」を押してステレオキャリブレーションを計算します。RMS誤差とベースライン長（カメラ間距離）を確認してください。'
        },
        action: 'calibration.compute()'
    },
    {
        id: 5,
        title: '結果の確認と保存',
        description: {
            single: '内部・外部パラメータを確認し、「保存」ボタンでJSONとして保存します。',
            stereo: '内部パラメータ（単眼）、ステレオ結果（R, T, ベースライン）を確認し、必要に応じてキャリブ結果を保存します。'
        },
        action: 'saveCharucoCalibration()'
    },
    {
        id: 6,
        title: '3D復元・実長換算',
        description: {
            single: 'モーションモードで身体座標をデジタイズし、実長換算を実行します。',
            stereo: 'モーションモードに切り替え、両カメラのデジタイズ結果を使って3D復元・実長換算を実行します。'
        },
        action: 'calculateRealLength()'
    }
];

/**
 * ChArUcoキャリブレーション手順ガイドの初期化
 */
function initCharucoGuide() {
    const container = document.getElementById('charuco-guide-container');
    const stepsContainer = document.getElementById('charuco-steps');
    if (!container || !stepsContainer) return;

    // キャリブレーション方法がChArUcoの場合のみ表示
    const methodSelect = document.getElementById('calibration-method');
    if (methodSelect) {
        const updateGuideVisibility = () => {
            const method = methodSelect.value;
            const isCharuco = method === 'charuco-single' || method === 'charuco-stereo';
            container.style.display = isCharuco ? 'block' : 'none';
            if (isCharuco) {
                updateCharucoGuide();
            }
        };
        methodSelect.addEventListener('change', updateGuideVisibility);
        updateGuideVisibility();
    }

    // ステップを生成
    stepsContainer.innerHTML = '';
    CHARUCO_STEPS.forEach((step, index) => {
        const stepDiv = document.createElement('div');
        stepDiv.className = 'charuco-step';
        stepDiv.id = `charuco-step-${step.id}`;
        stepDiv.style.cssText = `
            padding: 8px;
            border-radius: 4px;
            border-left: 3px solid #ccc;
            background: #fff;
            transition: all 0.3s ease;
        `;

        const stepNumber = document.createElement('div');
        stepNumber.style.cssText = 'font-weight:600; color:#666; margin-bottom:4px;';
        stepNumber.textContent = `ステップ ${step.id}: ${step.title}`;

        const stepDesc = document.createElement('div');
        stepDesc.className = 'charuco-step-desc';
        stepDesc.style.cssText = 'font-size:0.85em; color:#888; margin-bottom:4px;';
        // 初期表示時点のモードに応じた説明文
        const method = methodSelect ? methodSelect.value : '';
        const isStereo = (method === 'charuco-stereo');
        if (typeof step.description === 'string') {
            stepDesc.textContent = step.description;
        } else {
            stepDesc.textContent = isStereo ? (step.description.stereo || '') : (step.description.single || '');
        }

        const stepStatus = document.createElement('div');
        stepStatus.className = 'charuco-step-status';
        stepStatus.style.cssText = 'font-size:0.8em; color:#999;';
        stepStatus.textContent = '未完了';

        stepDiv.appendChild(stepNumber);
        stepDiv.appendChild(stepDesc);
        stepDiv.appendChild(stepStatus);
        stepsContainer.appendChild(stepDiv);
    });
}

/**
 * ChArUcoキャリブレーション手順ガイドの更新
 */
function updateCharucoGuide() {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    const isStereo = (method === 'charuco-stereo');

    const currentStepText = document.getElementById('charuco-current-step-text');
    if (currentStepText) {
        // ステレオ時はステップ1をスキップして表示上は2から始める
        const displayIndex = isStereo
            ? Math.max(0, charucoGuideState.currentStep - 1)
            : charucoGuideState.currentStep;
        const currentStep = CHARUCO_STEPS[displayIndex];
        currentStepText.textContent = currentStep ? currentStep.title : '-';
    }

    CHARUCO_STEPS.forEach((step, index) => {
        const stepDiv = document.getElementById(`charuco-step-${step.id}`);
        const statusDiv = stepDiv?.querySelector('.charuco-step-status');
        const descDiv = stepDiv?.querySelector('.charuco-step-desc');
        if (!stepDiv || !statusDiv) return;

        // ステレオ時はステップ1を非表示
        if (isStereo && step.id === 1) {
            stepDiv.style.display = 'none';
        } else {
            stepDiv.style.display = '';
        }

        // 説明文をモードに応じて更新
        if (descDiv && step.description) {
            if (typeof step.description === 'string') {
                descDiv.textContent = step.description;
            } else {
                descDiv.textContent = isStereo
                    ? (step.description.stereo || '')
                    : (step.description.single || '');
            }
        }

        let status = '';
        let bgColor = '#fff';
        let borderColor = '#ccc';
        let textColor = '#666';

        if (index < charucoGuideState.currentStep) {
            // 完了済み
            status = '✓ 完了';
            bgColor = '#e8f5e9';
            borderColor = '#4caf50';
            textColor = '#2e7d32';
        } else if (index === charucoGuideState.currentStep) {
            // 現在のステップ
            status = '→ 実行中';
            bgColor = '#e3f2fd';
            borderColor = '#2196f3';
            textColor = '#1565c0';
        } else {
            // 未完了
            status = '未完了';
            bgColor = '#fff';
            borderColor = '#ccc';
            textColor = '#999';
        }

        // ステップ3の特別処理（フレーム数表示）
        if (step.id === 3) {
            if (charucoGuideState.samples > 0) {
                status = `進行中 (${charucoGuideState.samples}フレーム)`;
                if (charucoGuideState.samples >= 20) {
                    status = `✓ 完了 (${charucoGuideState.samples}フレーム)`;
                    bgColor = '#e8f5e9';
                    borderColor = '#4caf50';
                    textColor = '#2e7d32';
                }
            }
        }

        // ステップ4の特別処理（キャリブレーション完了）
        if (step.id === 4 && charucoGuideState.calibrationCompleted) {
            status = '✓ 完了';
            bgColor = '#e8f5e9';
            borderColor = '#4caf50';
            textColor = '#2e7d32';
        }

        // ステップ5の特別処理（保存完了）
        if (step.id === 5 && charucoGuideState.saved) {
            status = '✓ 完了';
            bgColor = '#e8f5e9';
            borderColor = '#4caf50';
            textColor = '#2e7d32';
        }

        stepDiv.style.background = bgColor;
        stepDiv.style.borderLeftColor = borderColor;
        stepDiv.querySelector('div').style.color = textColor;
        statusDiv.textContent = status;
        statusDiv.style.color = textColor;
    });
}

// キャリブレーション関数をラップしてステップガイドを更新
const originalStartCalibrationSession = window.calibration.start;
const originalCaptureCalibrationSample = window.calibration.capture;
const originalComputeCalibration = window.calibration.compute;

// セッションアクティブフラグ
window.__calibSessionActive = false;

// セッション開始/終了のUI更新
function updateSessionButtonUI(isActive) {
    const btn = document.getElementById('calib-session-btn');
    if (!btn) return;

    if (isActive) {
        btn.textContent = 'セッション終了';
        btn.classList.remove('primary', 'cc-btn-primary');
        btn.classList.add('danger');
        btn.style.backgroundColor = '';
        btn.style.borderColor = '';
    } else {
        btn.textContent = 'セッション開始';
        btn.classList.remove('danger');
        btn.classList.add('primary', 'cc-btn-primary');
        btn.style.backgroundColor = '';
        btn.style.borderColor = '';
    }

    // ステータス行のアクティブ状態を同期
    const row = document.querySelector('.cc-status-row');
    if (row) {
        row.classList.remove('active', 'error');
        if (isActive) row.classList.add('active');
    }
}

// セッション開始/終了トグル
window.calibration.toggleSession = async function () {
    if (window.__calibSessionActive) {
        // セッション終了
        window.__calibSessionActive = false;
        window.__calibActive = false;
        updateSessionButtonUI(false);
        showMessage('キャリブレーションセッションを終了しました');
        try { setCalibStatus('セッション終了', 'success'); } catch (_) { }
    } else {
        // セッション開始
        await window.calibration.start();
    }
};

window.calibration.start = async function () {
    // ChArUcoモードに応じて単眼/ステレオを切り替え
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    let result;
    if (method === 'charuco-stereo') {
        result = await window.stereoCalibration.start();
    } else {
        result = await originalStartCalibrationSession();
    }
    if (result) {
        charucoGuideState.currentStep = 2; // ステップ2完了
        updateCharucoGuide();

        // セッションアクティブ化
        window.__calibSessionActive = true;
        updateSessionButtonUI(true);

        // 開始直後に自動検出
        try {
            if (typeof window.detectCharucoBoard === 'function') {
                await window.detectCharucoBoard();
            }
        } catch (_) { }
    }
    return result;
};

window.calibration.capture = async function () {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    let result;
    if (method === 'charuco-stereo') {
        result = await window.stereoCalibration.capture();
    } else {
        result = await originalCaptureCalibrationSample();
    }
    if (result && result.success) {
        charucoGuideState.currentStep = 3; // ステップ3実行中
        charucoGuideState.samples = result.samples || 0;
        if (charucoGuideState.samples >= 20) {
            charucoGuideState.currentStep = 4; // ステップ3完了、ステップ4へ
        }
        updateCharucoGuide();
    }
    return result;
};

window.calibration.compute = async function () {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    let result;
    if (method === 'charuco-stereo') {
        result = await window.stereoCalibration.compute();
    } else {
        result = await originalComputeCalibration();
    }
    if (result && result.success) {
        charucoGuideState.currentStep = 5; // ステップ4完了、ステップ5へ
        charucoGuideState.calibrationCompleted = true;
        updateCharucoGuide();
    }
    return result;
};

// 保存関数をラップ
const originalSaveCharucoCalibration = window.saveCharucoCalibration;
if (typeof originalSaveCharucoCalibration === 'function') {
    window.saveCharucoCalibration = async function () {
        const result = await originalSaveCharucoCalibration();
        // 保存成功時（エラーでない場合）にステップを更新
        if (result !== false) {
            charucoGuideState.currentStep = 6; // ステップ5完了、ステップ6へ
            charucoGuideState.saved = true;
            updateCharucoGuide();
        }
        return result;
    };
}

// 初期化時にガイドを設定
function initializeCharucoGuideOnReady() {
    setTimeout(() => {
        if (typeof initCharucoGuide === 'function') {
            initCharucoGuide();
        }
    }, 500);
}

// 既存のDOMContentLoadedイベントリスナーに統合
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeCharucoGuideOnReady);
} else {
    initializeCharucoGuideOnReady();
}

/**
 * ChArUcoキャリブレーション結果を保存
 */
window.saveCharucoCalibration = async function () {
    const calib = projectData.calibration;
    if (!calib) {
        showError('キャリブレーション結果がありません。先にキャリブレーションを実行してください。');
        return;
    }

    // ボード設定を取得
    const rowsEl = document.getElementById('charuco-rows');
    const colsEl = document.getElementById('charuco-cols');
    const sqEl = document.getElementById('charuco-square-mm');
    const mkEl = document.getElementById('charuco-marker-mm');
    const dictEl = document.getElementById('charuco-dictionary');

    const rows = rowsEl ? parseInt(rowsEl.value, 10) : 5;
    const cols = colsEl ? parseInt(colsEl.value, 10) : 7;
    const squareSizeMm = sqEl ? parseFloat(sqEl.value) : 130;
    const markerSizeMm = mkEl ? parseFloat(mkEl.value) : 97;
    const dictionary = dictEl ? dictEl.value : 'DICT_4X4_50';

    // 保存用データを構築
    const calibrationData = {
        version: '1.1', // 点群データ追加によりバージョンアップ
        savedAt: new Date().toISOString(),
        cameraMatrix: calib.cameraMatrix || [],
        distCoeffs: calib.distCoeffs || [],
        reprojectionError: calib.reprojectionError || 0,
        samples: calib.samples || 0,
        rvecs: calib.rvecs || [],
        tvecs: calib.tvecs || [],
        rotationMatrices: calib.rotationMatrices || [],
        viewErrors: calib.viewErrors || [],
        cornerCounts: calib.cornerCounts || [],
        markerCounts: calib.markerCounts || [],
        frameNumbers: calib.frameNumbers || [],
        // 点群データ（除外計算用）
        allImagePoints: calib.allImagePoints || [],
        allObjectPoints: calib.allObjectPoints || [],
        imageWidth: calib.imageWidth || 0,
        imageHeight: calib.imageHeight || 0,
        boardConfig: {
            rows: rows,
            cols: cols,
            squareSizeMm: squareSizeMm,
            markerSizeMm: markerSizeMm,
            dictionary: dictionary
        }
    };

    try {
        const result = await ipcRenderer.invoke('save-charuco-calibration', calibrationData);
        if (result.success) {
            showMessage(`キャリブレーション結果を保存しました: ${result.path}`);
            // ステップガイドを更新
            if (typeof updateCharucoGuide === 'function') {
                charucoGuideState.currentStep = 6;
                charucoGuideState.saved = true;
                updateCharucoGuide();
            }


        } else if (result.error !== 'cancelled') {
            showError('保存に失敗しました: ' + (result.error || 'unknown error'));
        }
    } catch (e) {
        showError('保存エラー: ' + e.message);
    }
};

/**
 * ChArUcoキャリブレーション結果を読み込み
 */
// 共通コア: slot が 'cam1'/'cam2' のときはそのカメラ用として保存
window.loadCharucoCalibration = async function (slot) {
    try {
        const result = await ipcRenderer.invoke('load-charuco-calibration');
        if (!result.success) {
            if (result.error !== 'cancelled') {
                showError('読み込みに失敗しました: ' + (result.error || 'unknown error'));
            }
            return;
        }

        const data = result.data;

        // データ検証
        if (!data.cameraMatrix || !data.distCoeffs) {
            showError('無効なキャリブレーションファイルです。');
            return;
        }

        // ステレオモードかどうかを確認
        const methodSelect = document.getElementById('calibration-method');
        const method = methodSelect ? methodSelect.value : '';
        // 内部パラメータ再推定オプション (UIから削除されたため、デフォルトでfalse）
        const recalcIntrinsics = false;
        const isStereo = (method === 'charuco-stereo');

        // ステレオモードの場合、slotに応じて適切なスロットに保存
        if (isStereo) {
            // 明示指定 slot 優先、未指定なら現在選択カメラ
            let cam = slot;
            if (!cam) {
                cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
            }
            if (!window.projectData) window.projectData = {};
            if (!window.projectData.stereoIntrinsics) window.projectData.stereoIntrinsics = {};
            const stereoSlot = (cam === 'cam2') ? 'cam2' : 'cam1';

            // 指定されたスロットのみに保存（rvecs/tvecsも含めて保存）
            window.projectData.stereoIntrinsics[stereoSlot] = {
                cameraMatrix: data.cameraMatrix,
                distCoeffs: data.distCoeffs,
                samples: data.samples || 0,
                reprojectionError: data.reprojectionError || 0,
                rvecs: data.rvecs || [],
                tvecs: data.tvecs || [],
                rotationMatrices: data.rotationMatrices || [],
                viewErrors: data.viewErrors || [],
                cornerCounts: data.cornerCounts || [],
                markerCounts: data.markerCounts || [],
                frameNumbers: data.frameNumbers || []
            };

            // UI更新: Cam1の場合はCam1用UI、Cam2の場合はCam2用UIのみ更新
            if (stereoSlot === 'cam1') {
                // Cam1の場合は、window.projectData.calibrationにも保存（後方互換性のため）
                window.projectData.calibration = {
                    cameraMatrix: data.cameraMatrix,
                    distCoeffs: data.distCoeffs,
                    reprojectionError: data.reprojectionError || 0,
                    samples: data.samples || 0,
                    rvecs: data.rvecs || [],
                    tvecs: data.tvecs || [],
                    rotationMatrices: data.rotationMatrices || [],
                    viewErrors: data.viewErrors || [],
                    cornerCounts: data.cornerCounts || [],
                    markerCounts: data.markerCounts || [],
                    frameNumbers: data.frameNumbers || [] // 各サンプルのフレーム番号
                };
                updateCalibrationResultUI(window.projectData.calibration);
                populateExtrinsicViewSelect(window.projectData.calibration);
                updateExtrinsicResultUI(window.projectData.calibration, 0);
                buildCharucoTable(window.projectData.calibration, 'charuco-table-body-cam1');
                if (window.projectData.calibration.viewErrors && window.projectData.calibration.viewErrors.length > 0) {
                    updateErrorBarChart(window.projectData.calibration.viewErrors, 'charuco-error-chart-cam1', 'ビュー毎RMS誤差 (Cam1)');
                }
            } else {
                // Cam2の場合は、Cam2用UIのみ更新
                updateStereoIntrinsicDisplay();
            }
        } else {
            // 単眼モードの場合、従来通りwindow.projectData.calibrationに保存
            if (!window.projectData) window.projectData = {};
            window.projectData.calibration = {
                cameraMatrix: data.cameraMatrix,
                distCoeffs: data.distCoeffs,
                reprojectionError: data.reprojectionError || 0,
                samples: data.samples || 0,
                rvecs: data.rvecs || [],
                tvecs: data.tvecs || [],
                rotationMatrices: data.rotationMatrices || [],
                viewErrors: data.viewErrors || [],
                cornerCounts: data.cornerCounts || [],
                markerCounts: data.markerCounts || [],
                frameNumbers: data.frameNumbers || [], // 各サンプルのフレーム番号
                // 点群データ（除外計算用）
                allImagePoints: data.allImagePoints || [],
                allObjectPoints: data.allObjectPoints || [],
                imageWidth: data.imageWidth || 0,
                imageHeight: data.imageHeight || 0
            };
            updateCalibrationResultUI(window.projectData.calibration);
            populateExtrinsicViewSelect(window.projectData.calibration);
            updateExtrinsicResultUI(window.projectData.calibration, 0);
            buildCharucoTable(window.projectData.calibration, 'charuco-table-body-cam1');
            if (window.projectData.calibration.viewErrors && window.projectData.calibration.viewErrors.length > 0) {
                updateErrorBarChart(window.projectData.calibration.viewErrors, 'charuco-error-chart-cam1', 'ビュー毎RMS誤差 (Cam1)');
            }

            // 点群データがある場合、C++バッファを復元（除外計算を可能にする）
            if (data.allImagePoints && data.allImagePoints.length > 0 &&
                data.allObjectPoints && data.allObjectPoints.length > 0) {
                try {
                    const restoreResult = await ipcRenderer.invoke('restore-calibration-buffers', {
                        allImagePoints: data.allImagePoints,
                        allObjectPoints: data.allObjectPoints,
                        cornerCounts: data.cornerCounts || [],
                        markerCounts: data.markerCounts || [],
                        frameNumbers: data.frameNumbers || [],
                        imageWidth: data.imageWidth || 1920,
                        imageHeight: data.imageHeight || 1080
                    });
                    if (restoreResult && restoreResult.success) {
                        showMessage(`点群データを復元しました（${restoreResult.restoredViews}ビュー）- 除外計算が可能です`);
                    }
                } catch (restoreErr) {
                    // 復元失敗しても読み込み自体は成功とする
                }
            }
        }

        // ボード設定を復元
        if (data.boardConfig) {
            const rowsEl = document.getElementById('charuco-rows');
            const colsEl = document.getElementById('charuco-cols');
            const sqEl = document.getElementById('charuco-square-mm');
            const mkEl = document.getElementById('charuco-marker-mm');
            const dictEl = document.getElementById('charuco-dictionary');

            if (rowsEl && data.boardConfig.rows) rowsEl.value = data.boardConfig.rows;
            if (colsEl && data.boardConfig.cols) colsEl.value = data.boardConfig.cols;
            if (sqEl && data.boardConfig.squareSizeMm) sqEl.value = data.boardConfig.squareSizeMm;
            if (mkEl && data.boardConfig.markerSizeMm) mkEl.value = data.boardConfig.markerSizeMm;
            if (dictEl && data.boardConfig.dictionary) dictEl.value = data.boardConfig.dictionary;
        }

        showMessage(`キャリブレーション結果を読み込みました: ${result.path}`);

        // 内部パラメータ読み込み状態を更新
        if (typeof window.updateIntrinsicStatus === 'function') {
            window.updateIntrinsicStatus();
        }
    } catch (e) {
        showError('読み込みエラー: ' + e.message);
    }
};

// Cam1/Cam2 用の明示的な読み込みボタンから呼び出すラッパ
window.loadCharucoCalibrationCam1 = function () {
    return window.loadCharucoCalibration('cam1');
};

window.loadCharucoCalibrationCam2 = function () {
    return window.loadCharucoCalibration('cam2');
};

// Cam1用の保存関数（単眼モードと同じ）
window.saveCharucoCalibrationCam1 = async function () {
    return window.saveCharucoCalibration();
};

// Cam2用の保存関数
window.saveCharucoCalibrationCam2 = async function () {
    try {
        // ステレオモードの場合、Cam2のデータを保存
        if (!window.projectData?.stereoIntrinsics?.cam2) {
            showError('Cam2のキャリブレーションデータがありません。先にカメラパラメータを読み込んでください。');
            return;
        }

        const cam2Data = window.projectData.stereoIntrinsics.cam2;

        const calibrationData = {
            version: '1.1',
            savedAt: new Date().toISOString(),
            cameraMatrix: cam2Data.cameraMatrix,
            distCoeffs: cam2Data.distCoeffs,
            reprojectionError: cam2Data.reprojectionError || 0,
            samples: cam2Data.samples || 0,
            rvecs: cam2Data.rvecs || [],
            tvecs: cam2Data.tvecs || [],
            rotationMatrices: cam2Data.rotationMatrices || [],
            viewErrors: cam2Data.viewErrors || [],
            cornerCounts: cam2Data.cornerCounts || [],
            markerCounts: cam2Data.markerCounts || [],
            frameNumbers: cam2Data.frameNumbers || [],
            allImagePoints: cam2Data.allImagePoints || [],
            allObjectPoints: cam2Data.allObjectPoints || [],
            imageWidth: cam2Data.imageWidth || 0,
            imageHeight: cam2Data.imageHeight || 0,
            boardConfig: {
                rows: parseInt(document.getElementById('charuco-rows')?.value) || 5,
                cols: parseInt(document.getElementById('charuco-cols')?.value) || 7,
                squareSizeMm: parseFloat(document.getElementById('charuco-square-mm')?.value) || 165,
                markerSizeMm: parseFloat(document.getElementById('charuco-marker-mm')?.value) || 123,
                dictionary: document.getElementById('charuco-dictionary')?.value || 'DICT_4X4_50'
            }
        };

        const result = await ipcRenderer.invoke('save-charuco-calibration', calibrationData);
        if (result.success) {
            showMessage('Cam2のキャリブレーション結果を保存しました: ' + result.path);
        } else {
            if (result.error !== 'cancelled') {
                showError('保存に失敗しました: ' + (result.error || 'unknown error'));
            }
        }
    } catch (e) {
        showError('保存エラー: ' + e.message);
    }
};

// Cam1用の3D表示関数（単一カメラキャリブレーション結果）
window.show3DCalibrationViewCam1 = async function () {
    // Cam1のキャリブレーションデータを確認
    // 単眼モードの場合は window.projectData.calibration を使用
    // ステレオモードの場合は window.projectData.stereoIntrinsics.cam1 または window.projectData.calibration を使用
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    const isStereo = (method === 'charuco-stereo');

    let calibData = null;

    if (isStereo) {
        // ステレオモード: stereoIntrinsics.cam1 または calibration を使用
        if (window.projectData?.stereoIntrinsics?.cam1?.rvecs?.length > 0) {
            calibData = window.projectData.stereoIntrinsics.cam1;
        } else if (window.projectData?.calibration?.rvecs?.length > 0) {
            calibData = window.projectData.calibration;
        }
    } else {
        // 単眼モード: calibration を使用
        if (projectData.calibration && projectData.calibration.rvecs && projectData.calibration.rvecs.length > 0) {
            calibData = projectData.calibration;
        }
    }

    if (!calibData || !calibData.rvecs || !calibData.tvecs || calibData.rvecs.length === 0) {
        showError('Cam1のキャリブレーションデータにrvecs/tvecsが含まれていません。\n\n読み込んだパラメータファイルにボード位置情報（rvecs/tvecs）が保存されていない可能性があります。\nキャリブレーション実行後に保存したファイルを使用してください。');
        return;
    }

    // ボード設定を取得
    const rowsEl = document.getElementById('charuco-rows');
    const colsEl = document.getElementById('charuco-cols');
    const sqEl = document.getElementById('charuco-square-mm');
    const rows = rowsEl ? parseInt(rowsEl.value, 10) : 5;
    const cols = colsEl ? parseInt(colsEl.value, 10) : 7;
    const squareSizeMm = sqEl ? parseFloat(sqEl.value) : 165;

    // 単一カメラ用のキャリブレーションデータを準備
    const calibrationData = {
        boardRows: rows,
        boardCols: cols,
        squareSizeMm: squareSizeMm,
        isStereo: false, // 単一カメラモードとして表示
        rvecs: calibData.rvecs,
        tvecs: calibData.tvecs,
        cameraLabel: 'Cam1'
    };

    // IPC経由で別ウィンドウを開く
    try {
        const result = await ipcRenderer.invoke('open-3d-calibration-view', calibrationData);
        if (!result.success) {
            showError('3D表示ウィンドウのオープンに失敗: ' + (result.error || 'unknown error'));
        }
    } catch (e) {
        showError('3D表示エラー: ' + e.message);
    }
};

// Cam2用の3D表示関数（単一カメラキャリブレーション結果）
window.show3DCalibrationViewCam2 = async function () {
    // Cam2のキャリブレーションデータを確認
    // まずstereoIntrinsics.cam2を確認、なければcalibration（Cam1のデータがCam2として読み込まれた場合）
    let calibData = null;
    let dataSource = '';

    if (window.projectData?.stereoIntrinsics?.cam2) {
        calibData = window.projectData.stereoIntrinsics.cam2;
        dataSource = 'stereoIntrinsics.cam2';
    }

    if (!calibData) {
        showError('Cam2のキャリブレーションデータがありません。先に「カメラパラメータ読み込み」ボタンでパラメータファイルを読み込んでください。');
        return;
    }

    if (!calibData.rvecs || !calibData.tvecs || calibData.rvecs.length === 0) {
        const rvecsInfo = calibData.rvecs ? `rvecs.length=${calibData.rvecs.length}` : 'rvecs=undefined';
        const tvecsInfo = calibData.tvecs ? `tvecs.length=${calibData.tvecs.length}` : 'tvecs=undefined';
        showError(`Cam2のキャリブレーションデータにrvecs/tvecsが含まれていません。\n\nデータソース: ${dataSource}\n${rvecsInfo}, ${tvecsInfo}\n\n読み込んだパラメータファイルにボード位置情報（rvecs/tvecs）が保存されていない可能性があります。\nキャリブレーション実行後に保存したファイルを使用してください。`);
        return;
    }

    // ボード設定を取得
    const rowsEl = document.getElementById('charuco-rows');
    const colsEl = document.getElementById('charuco-cols');
    const sqEl = document.getElementById('charuco-square-mm');
    const rows = rowsEl ? parseInt(rowsEl.value, 10) : 5;
    const cols = colsEl ? parseInt(colsEl.value, 10) : 7;
    const squareSizeMm = sqEl ? parseFloat(sqEl.value) : 165;

    // 単一カメラ用のキャリブレーションデータを準備
    const calibrationData = {
        boardRows: rows,
        boardCols: cols,
        squareSizeMm: squareSizeMm,
        isStereo: false, // 単一カメラモードとして表示
        rvecs: calibData.rvecs,
        tvecs: calibData.tvecs,
        cameraLabel: 'Cam2'
    };

    // IPC経由で別ウィンドウを開く
    try {
        const result = await ipcRenderer.invoke('open-3d-calibration-view', calibrationData);
        if (!result.success) {
            showError('3D表示ウィンドウのオープンに失敗: ' + (result.error || 'unknown error'));
        }
    } catch (e) {
        showError('3D表示エラー: ' + e.message);
    }
};

// 内部パラメータ読み込み状態を更新
window.updateIntrinsicStatus = function () {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    const isStereo = (method === 'charuco-stereo');

    // ステレオモード用の表示切り替え
    const cam1SingleDetails = document.getElementById('cam1-single-details');

    if (!isStereo) {
        // 単眼モードではカードを非表示、テーブル/グラフを表示
        const cam1Card = document.getElementById('cam1-intrinsic-card');
        if (cam1Card) cam1Card.style.display = 'none';
        if (cam1SingleDetails) cam1SingleDetails.style.display = 'block';
        return;
    }

    // ステレオモード: カードを表示、テーブル/グラフを非表示
    if (cam1SingleDetails) cam1SingleDetails.style.display = 'none';

    // Cam1 カード更新
    updateIntrinsicCard('cam1', window.projectData?.stereoIntrinsics?.cam1);
    // Cam2 カード更新
    updateIntrinsicCard('cam2', window.projectData?.stereoIntrinsics?.cam2);
};

// 内部パラメータ状態カードを更新（ステレオモード用）
function updateIntrinsicCard(camId, calibData) {
    const card = document.getElementById(`${camId}-intrinsic-card`);
    if (!card) return;

    card.style.display = 'block';

    const iconEl = document.getElementById(`${camId}-status-icon`);
    const labelEl = document.getElementById(`${camId}-intrinsic-status-text`);
    const hintEl = document.getElementById(`${camId}-intrinsic-status-hint`);
    const paramsEl = document.getElementById(`${camId}-intrinsic-summary`);

    if (calibData && calibData.cameraMatrix) {
        // 読み込み済み
        card.className = 'intrinsic-status-card intrinsic-loaded';
        if (iconEl) iconEl.textContent = 'verified';
        const rms = calibData.reprojectionError;
        if (labelEl) labelEl.textContent = `内部パラメータ 読み込み済み${rms ? '  RMS: ' + rms.toFixed(4) + ' px' : ''}`;
        if (hintEl) hintEl.textContent = `サンプル数: ${calibData.samples || '-'} 枚`;
        if (paramsEl) paramsEl.style.display = 'block';
        // パラメータ値を更新
        updateCameraIntrinsicSummary(camId, calibData);
    } else {
        // 未読み込み
        card.className = 'intrinsic-status-card intrinsic-not-loaded';
        if (iconEl) iconEl.textContent = 'error';
        if (labelEl) labelEl.textContent = '内部パラメータ 未読み込み';
        if (hintEl) hintEl.textContent = '「カメラパラメータ読み込み」で .json ファイルを指定するか、ステレオキャリブレーションを実行してください';
        if (paramsEl) paramsEl.style.display = 'none';
    }
}

// カメラ内部パラメータサマリーを更新
function updateCameraIntrinsicSummary(camId, calibData) {
    const samplesEl = document.getElementById(`${camId}-samples`);
    const rmsEl = document.getElementById(`${camId}-rms`);
    const fxEl = document.getElementById(`${camId}-fx`);
    const fyEl = document.getElementById(`${camId}-fy`);
    const cxEl = document.getElementById(`${camId}-cx`);
    const cyEl = document.getElementById(`${camId}-cy`);

    if (!calibData || !calibData.cameraMatrix) {
        if (samplesEl) samplesEl.textContent = '-';
        if (rmsEl) rmsEl.textContent = '-';
        if (fxEl) fxEl.textContent = '-';
        if (fyEl) fyEl.textContent = '-';
        if (cxEl) cxEl.textContent = '-';
        if (cyEl) cyEl.textContent = '-';
        return;
    }

    const M = calibData.cameraMatrix;
    const fx = M[0], fy = M[4], cx = M[2], cy = M[5];

    if (samplesEl) samplesEl.textContent = calibData.samples || '-';
    if (rmsEl) rmsEl.textContent = calibData.reprojectionError ? calibData.reprojectionError.toFixed(4) : '-';
    if (fxEl) fxEl.textContent = fx ? fx.toFixed(2) : '-';
    if (fyEl) fyEl.textContent = fy ? fy.toFixed(2) : '-';
    if (cxEl) cxEl.textContent = cx ? cx.toFixed(2) : '-';
    if (cyEl) cyEl.textContent = cy ? cy.toFixed(2) : '-';
}

/**
 * 2D DLT ステレオモード時のフレーム範囲自動入力
 * モーションデータテーブルから、各カメラで実際にデータが存在するフレームの範囲を取得
 */
function autoPopulateStereoFrameRanges() {
    try {
        if (typeof window.cameraDigitizeData === 'undefined') return;

        // ヘルパー関数: 実際にデータが存在するフレームのみを抽出
        const getFramesWithData = (camData) => {
            if (!camData) return [];
            return Object.keys(camData)
                .map(Number)
                .filter(frameNum => {
                    if (isNaN(frameNum)) return false;
                    const frameData = camData[frameNum];
                    if (!frameData) return false;
                    // Map の場合は size、通常オブジェクトの場合は keys の長さでチェック
                    if (frameData instanceof Map) {
                        return frameData.size > 0;
                    } else if (typeof frameData === 'object') {
                        return Object.keys(frameData).length > 0;
                    }
                    return false;
                });
        };

        // cam1
        const cam1Start = document.getElementById('cam1-start');
        const cam1End = document.getElementById('cam1-end');
        if (cam1Start && cam1End && window.cameraDigitizeData['cam1']) {
            const keys = getFramesWithData(window.cameraDigitizeData['cam1']);
            if (keys.length > 0) {
                const min = Math.min(...keys);
                const max = Math.max(...keys);
                cam1Start.value = min;
                cam1End.value = max;
                console.log(`[autoPopulateStereoFrameRanges] cam1: ${min} - ${max} (${keys.length} frames with data)`);
            }
        }

        // cam2
        const cam2Start = document.getElementById('cam2-start');
        const cam2End = document.getElementById('cam2-end');
        if (cam2Start && cam2End && window.cameraDigitizeData['cam2']) {
            const keys = getFramesWithData(window.cameraDigitizeData['cam2']);
            if (keys.length > 0) {
                const min = Math.min(...keys);
                const max = Math.max(...keys);
                cam2Start.value = min;
                cam2End.value = max;
                console.log(`[autoPopulateStereoFrameRanges] cam2: ${min} - ${max} (${keys.length} frames with data)`);
            }
        }
    } catch (e) {
        console.error('Frame range auto-population failed:', e);
    }
}
window.autoPopulateStereoFrameRanges = autoPopulateStereoFrameRanges;

function toggleCalibrationPanels(method) {
    const legacy = document.getElementById('legacy-calibration-container');
    const charuco = document.getElementById('charuco-result-container');
    const cam2 = document.getElementById('charuco-cam2-block');
    const dlt2d = document.getElementById('dlt2d-results-container');
    const dlt3d = document.getElementById('dlt3d-results-container');
    const charucoParams = document.getElementById('intrinsic-extrinsic-container');
    const viconPanel = document.getElementById('vicon-xcp-panel');
    const ccSettings = document.getElementById('cc-method-settings');
    // CC法関連はデフォルトで非表示（3d-cc-methodの場合のみ表示）
    if (ccSettings) ccSettings.style.display = 'none';

    // 手法別ガイドの切り替え
    document.querySelectorAll('.method-guide').forEach(el => { el.style.display = 'none'; });
    const guideEl = document.getElementById('method-guide-' + method);
    if (guideEl) guideEl.style.display = '';
    const ccResults = document.getElementById('cc-method-results-container');
    if (ccResults) ccResults.style.display = 'none';
    // 余計なツールバーは撤去済み（2D/3Dともボタンは「カメラ定数」のみ）
    // 注: 要素が存在しない場合でも処理を続行（早期終了を避ける）
    if (method === 'charuco-single' || method === 'charuco-stereo') {
        // サイドバーのChArUcoセクションも表示
        if (typeof window.updateCharucoSidebarVisibility === 'function') {
            window.updateCharucoSidebarVisibility();
        }

        if (legacy) legacy.style.display = 'none';
        if (charuco) {
            charuco.style.display = '';
        }
        if (cam2) cam2.style.display = (method === 'charuco-stereo') ? '' : 'none';
        const camGrid = document.getElementById('charuco-tables');
        if (camGrid) camGrid.classList.toggle('cc-cam-grid-stereo', method === 'charuco-stereo');
        if (dlt2d) dlt2d.style.display = 'none';
        if (dlt3d) dlt3d.style.display = 'none';
        // ステレオモードでは内部・外部パラメータコンテナを非表示（Cam1/Cam2に個別表示するため）
        if (charucoParams) charucoParams.style.display = (method === 'charuco-stereo') ? 'none' : '';
        // ステレオモードでは外部パラメータの表を非表示
        const extrinsicPanel = document.getElementById('extrinsic-result-panel');
        if (extrinsicPanel) {
            extrinsicPanel.style.display = (method === 'charuco-stereo') ? 'none' : '';
        }
        if (viconPanel) viconPanel.style.display = 'none';

        // ステレオキャリブレーション結果ブロックの表示切り替え
        const stereoResultBlock = document.getElementById('stereo-calibration-result-block');
        if (stereoResultBlock) {
            stereoResultBlock.style.display = (method === 'charuco-stereo') ? '' : 'none';
        }

        // 内部パラメータ読み込み状態を更新
        if (typeof window.updateIntrinsicStatus === 'function') {
            window.updateIntrinsicStatus();
        }

        // ステレオモードで既存のステレオキャリブレーション結果があれば表示を更新
        if (method === 'charuco-stereo' && window.projectData && window.projectData.stereoCalibration) {
            if (typeof window.updateStereoCalibrationResultUI === 'function') {
                window.updateStereoCalibrationResultUI(window.projectData.stereoCalibration);
            }
            // ステレオ内部パラメータ表示も更新
            if (typeof window.updateStereoIntrinsicDisplay === 'function') {
                window.updateStereoIntrinsicDisplay();
            }
        }

        // ステレオ/シングルに応じてカメラ2とファイル枠の有効・表示を切り替え
        try {
            const cam1Radio = document.getElementById('camera1');
            const cam2Radio = document.getElementById('camera2');
            const calCam2Element = document.getElementById('cal-cam2');
            const motionCam2Element = document.getElementById('motion-cam2');
            const showCam2 = (method === 'charuco-stereo');

            if (cam2Radio) {
                cam2Radio.disabled = !showCam2;
            }
            if (calCam2Element) calCam2Element.style.display = showCam2 ? 'block' : 'none';
            if (motionCam2Element) motionCam2Element.style.display = showCam2 ? 'block' : 'none';

            // もしカメラ2が無効状態で選択されていたらカメラ1に戻す
            if (cam1Radio && cam2Radio && cam2Radio.disabled && cam2Radio.checked) {
                cam1Radio.checked = true;
            }

            // ステレオ/シングルに応じて結果テーブルの表示を切り替え
            const singleTables = document.getElementById('charuco-tables-single');
            const stereoTables = document.getElementById('charuco-tables-stereo');
            if (singleTables && stereoTables) {
                if (method === 'charuco-stereo') {
                    singleTables.style.display = 'none';
                    stereoTables.style.display = 'block';
                } else {
                    singleTables.style.display = 'block';
                    stereoTables.style.display = 'none';
                }
            }
        } catch (_) { }
        return;
    }

    if (method === '2d-dlt-single' || method === '2d-dlt-stereo' || method === '4-point') {
        if (legacy) legacy.style.display = '';
        if (charuco) charuco.style.display = 'none';
        if (dlt2d) dlt2d.style.display = '';
        if (dlt3d) dlt3d.style.display = 'none';
        if (charucoParams) charucoParams.style.display = 'none';
        if (viconPanel) viconPanel.style.display = 'none';

        // 2D DLT ステレオ用パネル表示切替
        const stereoPanel = document.getElementById('dlt2d-stereo-panel');
        if (stereoPanel) {
            stereoPanel.style.display = (method === '2d-dlt-stereo') ? 'block' : 'none';
            if (method === '2d-dlt-stereo') {
                autoPopulateStereoFrameRanges();
            }
        }

        // カメラ選択の可用性切替
        try {
            const cam2Radio = document.getElementById('camera2');
            const cam1Radio = document.getElementById('camera1');
            if (method === '2d-dlt-single' || method === '4-point') {
                if (cam2Radio) {
                    cam2Radio.disabled = true;
                }
                if (cam1Radio && cam2Radio && cam2Radio.checked) {
                    cam1Radio.checked = true;
                }
                const calCam2Element = document.getElementById('cal-cam2');
                const motionCam2Element = document.getElementById('motion-cam2');
                if (calCam2Element) calCam2Element.style.display = 'none';
                if (motionCam2Element) motionCam2Element.style.display = 'none';
            } else {
                if (cam2Radio) cam2Radio.disabled = false;
                const calCam2Element = document.getElementById('cal-cam2');
                const motionCam2Element = document.getElementById('motion-cam2');
                if (calCam2Element) calCam2Element.style.display = 'block';
                if (motionCam2Element) motionCam2Element.style.display = 'block';
            }
        } catch (_) { }

        // 4点実長換算の場合はCalポイントを再設定し、カメラ定数表を非表示
        const errorLegend = document.getElementById('calibration-error-legend');
        if (method === '4-point') {
            initializeFourPointCalibrationPoints();
            try { if (typeof window.updatePointsTab === 'function') window.updatePointsTab(); } catch (_) { }
            // 4点実長換算ではカメラ定数表・誤差凡例を非表示
            if (dlt2d) dlt2d.style.display = 'none';
            if (errorLegend) errorLegend.style.display = 'none';
            // カメラ定数ボタンを非表示
            const cameraConstantsBtn = document.getElementById('calculate-camera-coefficients');
            if (cameraConstantsBtn) cameraConstantsBtn.style.display = 'none';
            // マーカー間距離入力ボックスを表示
            const fourPointInput = document.getElementById('four-point-input-container');
            if (fourPointInput) fourPointInput.style.display = 'block';
        } else {
            // 4点実長換算から離れた場合は元のCalポイントに復元・誤差凡例を再表示
            if (errorLegend) errorLegend.style.display = '';
            restoreCalibrationPointsIfNeeded();
            try { if (typeof window.updatePointsTab === 'function') window.updatePointsTab(); } catch (_) { }
            // カメラ定数ボタンを表示
            const cameraConstantsBtn = document.getElementById('calculate-camera-coefficients');
            if (cameraConstantsBtn) cameraConstantsBtn.style.display = '';
            // 他の方法の場合はマーカー間距離入力ボックスを非表示
            const fourPointInput = document.getElementById('four-point-input-container');
            if (fourPointInput) fourPointInput.style.display = 'none';
        }
        return;
    }

    if (method === '3d-dlt') {
        if (legacy) legacy.style.display = '';
        if (charuco) charuco.style.display = 'none';
        if (dlt2d) dlt2d.style.display = 'none';
        if (dlt3d) dlt3d.style.display = '';
        if (charucoParams) charucoParams.style.display = 'none';
        if (viconPanel) viconPanel.style.display = 'none';
        return;
    }

    if (method === 'vicon-xcp-triangulation') {
        if (legacy) legacy.style.display = 'none';
        if (charuco) charuco.style.display = 'none';
        if (dlt2d) dlt2d.style.display = 'none';
        if (dlt3d) dlt3d.style.display = 'none';
        if (charucoParams) charucoParams.style.display = 'none';
        if (viconPanel) viconPanel.style.display = '';
        updateViconTriangulationButtonState();
        return;
    }

    if (method === '3d-cc-method') {
        // 3次元CC法でもキャリブレーションテーブルを表示（デジタイズ座標・実空間座標入力用）
        if (legacy) legacy.style.display = '';
        if (charuco) charuco.style.display = 'none';
        if (dlt2d) dlt2d.style.display = 'none';
        if (dlt3d) dlt3d.style.display = 'none';
        if (charucoParams) charucoParams.style.display = 'none';
        if (viconPanel) viconPanel.style.display = 'none';
        // CC法設定部分を表示
        const ccSettingsEl = document.getElementById('cc-method-settings');
        if (ccSettingsEl) ccSettingsEl.style.display = '';
        // CC法結果コンテナ: 結果がある場合は再表示
        if (ccResults && window.projectData?.ccCalibration?.results) {
            ccResults.style.display = 'block';
        }
        // CC法コンテナの表示は handleCCMethodVisibility で制御されるが、
        // 念のため applyCalibrationModeUI も呼び出す
        if (typeof window.applyCalibrationModeUI === 'function') window.applyCalibrationModeUI();
        // キャリブレーションテーブルを更新
        if (typeof window.updateCalibrationDataTable === 'function') window.updateCalibrationDataTable();
        return;
    }

    // fallback
    if (legacy) legacy.style.display = '';
    if (charuco) charuco.style.display = 'none';
    if (dlt2d) dlt2d.style.display = 'none';
    if (dlt3d) dlt3d.style.display = 'none';
    if (charucoParams) charucoParams.style.display = 'none';
    if (viconPanel) viconPanel.style.display = 'none';
}

// toggleCalibrationPanelsをグローバルに公開（プロジェクト読み込み時に使用）
window.toggleCalibrationPanels = toggleCalibrationPanels;

// 4点実長換算用のCalポイント初期化関数（任意の縦横比/原点を含む）
function initializeFourPointCalibrationPoints() {
    if (!window.calibrationData) {
        window.calibrationData = { points: [], method: null };
    }

    // 既存ポイントのバックアップ（初回のみ）
    try {
        if (!window.__fourPointBackup) {
            window.__fourPointBackup = {
                points: Array.isArray(window.calibrationData.points) ? JSON.parse(JSON.stringify(window.calibrationData.points)) : [],
                method: window.calibrationData.method || null
            };
        }
    } catch (_) { }

    const defs = [
        { id: 'Cal1', name: 'マーカー左奥' },
        { id: 'Cal2', name: 'マーカー右奥' },
        { id: 'Cal3', name: 'マーカー左手前' },
        { id: 'Cal4', name: 'マーカー右手前' },
        { id: 'ScaleH_L', name: 'スケール水平左（任意）' },
        { id: 'ScaleH_R', name: 'スケール水平右（任意）' },
        { id: 'ScaleV_T', name: 'スケール垂直上（任意）' },
        { id: 'ScaleV_B', name: 'スケール垂直下（任意）' },
        { id: 'OriginXY', name: '原点（任意）' }
    ];

    // 既存データを引き継ぎ
    const prevById = new Map((window.calibrationData.points || []).map(p => [String(p.id), p]));
    window.calibrationData.points = defs.map(def => {
        const old = prevById.get(def.id);
        return {
            id: def.id,
            name: def.name,
            digitizedCoords: old && old.digitizedCoords ? JSON.parse(JSON.stringify(old.digitizedCoords)) : { cam1: { x: null, y: null }, cam2: { x: null, y: null } },
            realCoords: old && old.realCoords ? JSON.parse(JSON.stringify(old.realCoords)) : { x: null, y: null, z: null },
            errors: old && old.errors ? JSON.parse(JSON.stringify(old.errors)) : { x: null, y: null, z: null },
            isDigitized: old && typeof old.isDigitized === 'boolean' ? old.isDigitized : false,
            frameNumber: old && old.frameNumber ? old.frameNumber : null,
            frameNumber2: old && old.frameNumber2 ? old.frameNumber2 : null
        };
    });

    window.calibrationData.method = '4-point';

    // UIを更新
    if (typeof window.initializeCalibrationLandmarkSelector === 'function') window.initializeCalibrationLandmarkSelector();

    // 現在の選択を維持。無ければ先頭
    try {
        const cur = (typeof window.getSelectedLandmark === 'function') ? window.getSelectedLandmark() : null;
        const sel = document.getElementById('calibration-landmark-select');
        if (cur && sel && sel.querySelector(`option[value="${String(cur.id)}"]`)) {
            sel.value = String(cur.id);
        } else if (window.calibrationData.points.length > 0) {
            if (typeof window.setSelectedLandmark === 'function') window.setSelectedLandmark(window.calibrationData.points[0]);
            if (sel) sel.value = window.calibrationData.points[0].id;
        }
    } catch (_) { }

    if (typeof window.updateCalibrationDataTable === 'function') window.updateCalibrationDataTable();

    if (typeof window.showMessage === 'function') {
        window.showMessage('4点実長換算: 既存のデジタイズ座標を保持してUIを切り替えました');
    }
}

// 4点実長換算専用ポイントから、元のCalポイントへ復元
function restoreCalibrationPointsIfNeeded() {
    try {
        const backup = window.__fourPointBackup;
        if (!backup) return;
        // 復元
        window.calibrationData.points = Array.isArray(backup.points) ? JSON.parse(JSON.stringify(backup.points)) : [];
        window.calibrationData.method = backup.method || null;
        // UI反映
        if (typeof window.initializeCalibrationLandmarkSelector === 'function') {
            window.initializeCalibrationLandmarkSelector();
        }
        if (typeof window.updateCalibrationDataTable === 'function') {
            window.updateCalibrationDataTable();
        }
        // バックアップは一度使ったら破棄
        window.__fourPointBackup = null;
    } catch (_) { }
}

// グローバル関数として公開
window.initializeFourPointCalibrationPoints = initializeFourPointCalibrationPoints;

// -------- Vicon XCP 三角測量支援 --------

function ensureViconTriangulationSettings() {
    if (!projectData.settings) projectData.settings = {};
    if (!projectData.settings.viconTriangulation) {
        projectData.settings.viconTriangulation = { cameraA: null, cameraB: null };
    }
    return projectData.settings.viconTriangulation;
}

function handleViconCalibrationLoaded(calibration) {
    if (!calibration) {
        updateViconCalibrationSummary(null);
        populateViconCameraSelectors(null);
        updateViconTriangulationButtonState();
        return;
    }
    updateViconCalibrationSummary(calibration);
    populateViconCameraSelectors(calibration);
    updateViconTriangulationButtonState();
}

function populateViconCameraSelectors(calibration) {
    const selectA = document.getElementById('vicon-camera-a');
    const selectB = document.getElementById('vicon-camera-b');
    const settings = ensureViconTriangulationSettings();
    const cameras = (calibration && Array.isArray(calibration.cameras)) ? calibration.cameras : [];
    [selectA, selectB].forEach(sel => {
        if (!sel) return;
        sel.innerHTML = '<option value="">-- 選択 --</option>';
        cameras.forEach(cam => {
            const opt = document.createElement('option');
            opt.value = cam.userId || cam.deviceId || '';
            opt.textContent = formatViconCameraLabel(cam);
            sel.appendChild(opt);
        });
    });
    if (selectA) selectA.value = settings.cameraA || '';
    if (selectB) selectB.value = settings.cameraB || '';
}

function formatViconCameraLabel(cam) {
    const display = cam?.type || cam?.display || 'Camera';
    const userId = cam?.userId != null ? `UID:${cam.userId}` : '';
    const deviceId = cam?.deviceId ? `ID:${cam.deviceId}` : '';
    return `${display} ${userId} ${deviceId}`.trim();
}

function handleViconCameraSelectChange() {
    const selectA = document.getElementById('vicon-camera-a');
    const selectB = document.getElementById('vicon-camera-b');
    const settings = ensureViconTriangulationSettings();
    if (selectA) settings.cameraA = selectA.value || null;
    if (selectB) settings.cameraB = selectB.value || null;
    updateViconTriangulationButtonState();
}

function updateViconCalibrationSummary(calibration, stats = null) {
    const label = document.getElementById('vicon-xcp-file-label');
    const summary = document.getElementById('vicon-xcp-summary');
    if (label) {
        label.textContent = calibration ? '読み込み済み' : '未読込';
    }
    if (!summary) return;
    if (!calibration) {
        summary.innerHTML = '<p>Vicon XCPキャリブレーションが読み込まれていません。</p>';
        return;
    }
    const info = calibration.cameras || [];
    const rows = info.slice(0, 4).map(cam => {
        const fx = cam?.cameraMatrix?.[0]?.[0];
        const fy = cam?.cameraMatrix?.[1]?.[1];
        const cx = cam?.cameraMatrix?.[0]?.[2];
        const cy = cam?.cameraMatrix?.[1]?.[2];
        const pos = cam?.position || [];
        return `<li>${formatViconCameraLabel(cam)} | fx:${formatNumber(fx)} fy:${formatNumber(fy)} | cx:${formatNumber(cx)} cy:${formatNumber(cy)} | Pos(${formatNumber(pos[0])}, ${formatNumber(pos[1])}, ${formatNumber(pos[2])})</li>`;
    }).join('');
    const statsHtml = stats ? `<p>再投影誤差 (Cam1): ${formatNumber(stats.cam1?.mean)} px / 最大 ${formatNumber(stats.cam1?.max)} px<br>再投影誤差 (Cam2): ${formatNumber(stats.cam2?.mean)} px / 最大 ${formatNumber(stats.cam2?.max)} px</p>` : '';
    summary.innerHTML = `<p>カメラ数: ${info.length}</p><ul>${rows}</ul>${statsHtml || ''}`;
}

function formatNumber(value) {
    return (value != null && isFinite(value)) ? Number(value).toFixed(3) : '-';
}

function collectViconTriangulationSamples() {
    const cam1Store = (window.cameraDigitizeData && window.cameraDigitizeData.cam1) ? window.cameraDigitizeData.cam1 : {};
    const cam2Store = (window.cameraDigitizeData && window.cameraDigitizeData.cam2) ? window.cameraDigitizeData.cam2 : {};
    const frames = new Set([
        ...enumerateFrameKeys(cam1Store),
        ...enumerateFrameKeys(cam2Store)
    ]);
    const samples = [];
    frames.forEach(frameKey => {
        const entry1 = normalizeDigitizeEntry(cam1Store[frameKey]);
        const entry2 = normalizeDigitizeEntry(cam2Store[frameKey]);
        if (!entry1 || !entry2) return;
        const pointIds = new Set([...Object.keys(entry1), ...Object.keys(entry2)]);
        pointIds.forEach(pointId => {
            const p1 = entry1[pointId];
            const p2 = entry2[pointId];
            if (!p1 || !p2) return;
            if (![p1.x, p1.y, p2.x, p2.y].every(v => Number.isFinite(Number(v)))) return;
            samples.push({
                frame: Number(frameKey),
                pointId: pointId,
                cam1: { x: Number(p1.x), y: Number(p1.y) },
                cam2: { x: Number(p2.x), y: Number(p2.y) }
            });
        });
    });
    return samples;
}

function normalizeDigitizeEntry(entry) {
    if (!entry) return null;
    if (typeof entry.get === 'function') {
        const obj = {};
        entry.forEach((value, key) => {
            obj[String(key)] = value;
        });
        return obj;
    }
    return entry;
}

function enumerateFrameKeys(store) {
    if (!store) return [];
    if (store instanceof Map) {
        const keys = [];
        store.forEach((_, key) => keys.push(key));
        return keys;
    }
    if (typeof store.forEach === 'function' && typeof store.entries !== 'function') {
        const keys = [];
        store.forEach((_, key) => keys.push(key));
        return keys;
    }
    return Object.keys(store);
}

function buildViconTriangulationPayload() {
    const calibration = projectData?.settings?.viconCalibration;
    if (!calibration) {
        showError('XCPキャリブレーションを読み込んでください');
        return null;
    }
    const settings = ensureViconTriangulationSettings();
    if (!settings.cameraA || !settings.cameraB) {
        showError('2台のカメラを選択してください');
        return null;
    }
    if (settings.cameraA === settings.cameraB) {
        showError('異なるカメラを選択してください');
        return null;
    }
    const samples = collectViconTriangulationSamples();
    if (!samples.length) {
        showError('デジタイズ済みのフレームが不足しています');
        return null;
    }
    return {
        calibration,
        cameraAId: settings.cameraA,
        cameraBId: settings.cameraB,
        samples
    };
}

async function runViconTriangulation() {
    const btn = document.getElementById('run-vicon-triangulation');
    const payload = buildViconTriangulationPayload();
    if (!payload) {
        updateViconTriangulationButtonState();
        return;
    }
    try {
        if (btn) btn.disabled = true;
        const res = await ipcRenderer.invoke('triangulate-vicon', payload);
        if (res && res.success) {
            applyViconTriangulationResults(res);
        } else {
            showError(res && res.error ? res.error : 'Vicon三角測量に失敗しました');
        }
    } catch (error) {
        console.error('runViconTriangulation error:', error);
        showError(error?.message || 'Vicon三角測量でエラーが発生しました');
    } finally {
        updateViconTriangulationButtonState();
    }
}

function applyViconTriangulationResults(result) {
    if (!projectData.analysisResults) {
        projectData.analysisResults = { coordinates3D: new Map(), standardErrors: new Map() };
    }
    if (!projectData.analysisResults.coordinates3D || typeof projectData.analysisResults.coordinates3D.set !== 'function') {
        projectData.analysisResults.coordinates3D = new Map();
    }
    const coordMap = projectData.analysisResults.coordinates3D;
    (result.points || []).forEach(pt => {
        const frameKey = String(pt.frame);
        let perFrame = coordMap.get(frameKey);
        if (!perFrame) {
            perFrame = {};
        }
        const identifier = pt.pointId ? String(pt.pointId) : `point-${Object.keys(perFrame).length + 1}`;
        perFrame[identifier] = { x: pt.x, y: pt.y, z: pt.z };
        coordMap.set(frameKey, perFrame);
    });
    projectData.analysisResults.viconErrors = result.samples || [];
    updateViconCalibrationSummary(projectData.settings?.viconCalibration, result.stats);
    renderViconErrorSummary(result.stats);
    renderViconErrorTable(result.samples);
    checkViconAccuracyThreshold(result.stats);
    showMessage(`Vicon三角測量: ${result.points?.length || 0} 点を算出しました`);
}

function updateViconTriangulationButtonState() {
    const btn = document.getElementById('run-vicon-triangulation');
    if (!btn) return;
    const calibrationLoaded = !!projectData?.settings?.viconCalibration;
    const settings = ensureViconTriangulationSettings();
    const hasTwoCameras = !!(settings.cameraA && settings.cameraB && settings.cameraA !== settings.cameraB);
    const hasSamples = collectViconTriangulationSamples().length > 0;
    const methodSelect = document.getElementById('calibration-method');
    const isActive = methodSelect && methodSelect.value === 'vicon-xcp-triangulation';
    btn.disabled = !(calibrationLoaded && hasTwoCameras && hasSamples && isActive);
}

function renderViconErrorSummary(stats) {
    setText('vicon-error-cam1-mean', formatNumber(stats?.cam1?.mean));
    setText('vicon-error-cam1-max', formatNumber(stats?.cam1?.max));
    setText('vicon-error-cam2-mean', formatNumber(stats?.cam2?.mean));
    setText('vicon-error-cam2-max', formatNumber(stats?.cam2?.max));
}

function renderViconErrorTable(samples = []) {
    const tbody = document.getElementById('vicon-error-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!samples.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 4;
        cell.textContent = 'データがありません';
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
    }
    samples.forEach(sample => {
        const row = document.createElement('tr');
        const err1 = sample?.error?.cam1;
        const err2 = sample?.error?.cam2;
        row.innerHTML = `
            <td>${sample.frame ?? '-'}</td>
            <td>${sample.pointId ?? '-'}</td>
            <td class="${highlightError(err1)}">${formatNumber(err1)}</td>
            <td class="${highlightError(err2)}">${formatNumber(err2)}</td>
        `;
        tbody.appendChild(row);
    });
}

function highlightError(errorValue, threshold = 1.0) {
    if (!isFinite(errorValue)) return '';
    return Math.abs(errorValue) > threshold ? 'error-highlight' : '';
}

function checkViconAccuracyThreshold(stats, threshold = 1.0) {
    const exceedsCam1 = stats?.cam1 && stats.cam1.max != null && stats.cam1.max > threshold;
    const exceedsCam2 = stats?.cam2 && stats.cam2.max != null && stats.cam2.max > threshold;
    if (exceedsCam1 || exceedsCam2) {
        showError(`再投影誤差が閾値 ${threshold}px を超えています。Cam1: ${formatNumber(stats?.cam1?.max)} px / Cam2: ${formatNumber(stats?.cam2?.max)} px`);
    }
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = text != null ? text : '-';
    }
}

// x,y座標テーブル（現在カメラ）の描画
function renderXYTableForCurrentCamera() {
    const methodSel = document.getElementById('calibration-method');
    const method = methodSel ? methodSel.value : '';
    if (method === 'vicon-xcp-triangulation') {
        if (!renderVicon3DRealLengthTable()) {
            clearRealLengthTable();
            showError('Vicon三角測量の3次元データが存在しません。先に三角測量を実行してください。');
        }
        return;
    }

    const headEl = document.getElementById('real-length-table-head');
    const bodyEl = document.getElementById('real-length-table-body');
    if (!headEl || !bodyEl) return;

    headEl.innerHTML = '';
    bodyEl.innerHTML = '';

    // ヘッダー作成
    const hr = document.createElement('tr');
    const thFrame = document.createElement('th');
    thFrame.textContent = 'フレーム';
    hr.appendChild(thFrame);
    (window.motionPoints || []).forEach(p => {
        const th = document.createElement('th');
        th.textContent = `${p.id}. ${p.name}`;
        hr.appendChild(th);
    });
    headEl.appendChild(hr);

    // データ本体
    const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
    const store = (window.cameraDigitizeData && window.cameraDigitizeData[cam]) ? window.cameraDigitizeData[cam] : {};
    const totalFrames = (window.projectData && window.projectData.settings && window.projectData.settings.motionFrameCount) ? window.projectData.settings.motionFrameCount : 0;

    for (let f = 1; f <= totalFrames; f++) {
        const tr = document.createElement('tr');
        const tdF = document.createElement('td');
        tdF.textContent = String(f);
        tr.appendChild(tdF);

        (window.motionPoints || []).forEach(p => {
            const td = document.createElement('td');
            const entry = store ? store[f] : null;
            let c = null;
            if (entry) {
                if (typeof entry.get === 'function') {
                    c = entry.get(p.id) || entry.get(String(p.id));
                } else {
                    c = entry[p.id] || entry[String(p.id)];
                }
            }
            if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) {
                td.textContent = `${Math.round(c.x)}, ${Math.round(c.y)}`;
            } else {
                td.textContent = '-';
            }
            tr.appendChild(td);
        });

        bodyEl.appendChild(tr);
    }
}

// wireRealLengthButton() は削除済み - calculateRealLength() が正しいテーブルを生成するため不要

function renderVicon3DRealLengthTable() {
    const coordMap = normalizeCoordinateFrameMap(projectData?.analysisResults?.coordinates3D);
    if (!coordMap || coordMap.size === 0) {
        return false;
    }
    const results = [];
    coordMap.forEach((perPoint, frameKey) => {
        const dict = normalizePointDictionary(perPoint);
        Object.keys(dict || {}).forEach(pointId => {
            const coords = dict[pointId];
            if (coords && isFinite(coords.x) && isFinite(coords.y) && isFinite(coords.z)) {
                results.push({
                    frame: Number(frameKey),
                    pointId,
                    x: Number(coords.x),
                    y: Number(coords.y),
                    z: Number(coords.z)
                });
            }
        });
    });
    if (!results.length) {
        return false;
    }
    results.sort((a, b) => {
        if (a.frame === b.frame) {
            return Number(a.pointId) - Number(b.pointId);
        }
        return a.frame - b.frame;
    });
    window.realLengthData = results;
    if (typeof window.displayRealLengthTable === 'function') {
        window.displayRealLengthTable(results);
    } else {
        render3DFallbackTable(results);
    }
    updateRealLengthStatsFromResults(results);
    return true;
}

function normalizeCoordinateFrameMap(source) {
    if (!source) return new Map();
    if (source instanceof Map) return source;
    try {
        return new Map(Object.entries(source));
    } catch (_) {
        return new Map();
    }
}

function normalizePointDictionary(entry) {
    if (!entry) return {};
    if (entry instanceof Map) {
        const obj = {};
        entry.forEach((value, key) => {
            obj[String(key)] = value;
        });
        return obj;
    }
    return entry;
}

function render3DFallbackTable(results) {
    const headEl = document.getElementById('real-length-table-head');
    const bodyEl = document.getElementById('real-length-table-body');
    if (!headEl || !bodyEl) return;
    headEl.innerHTML = '';
    bodyEl.innerHTML = '';
    const points = Array.isArray(window.motionPoints) ? window.motionPoints : [];

    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th>フレーム</th>';
    points.forEach(point => {
        headerRow.innerHTML += `<th colspan="3">${point.name || `P${point.id}`}</th>`;
    });
    headEl.appendChild(headerRow);

    const subHeaderRow = document.createElement('tr');
    subHeaderRow.innerHTML = '<th></th>';
    points.forEach(() => {
        subHeaderRow.innerHTML += '<th>X (m)</th><th>Y (m)</th><th>Z (m)</th>';
    });
    headEl.appendChild(subHeaderRow);

    const frameToPoints = new Map();
    (results || []).forEach(r => {
        if (!frameToPoints.has(r.frame)) frameToPoints.set(r.frame, {});
        frameToPoints.get(r.frame)[String(r.pointId)] = { x: r.x, y: r.y, z: r.z };
    });

    Array.from(frameToPoints.keys()).sort((a, b) => a - b).forEach(frame => {
        const row = document.createElement('tr');
        row.innerHTML = `<td>${frame}</td>`;
        const map = frameToPoints.get(frame);
        points.forEach(p => {
            const pd = map[String(p.id)];
            if (pd) {
                row.innerHTML += `<td>${pd.x.toFixed(6)}</td><td>${pd.y.toFixed(6)}</td><td>${pd.z.toFixed(6)}</td>`;
            } else {
                row.innerHTML += '<td>-</td><td>-</td><td>-</td>';
            }
        });
        bodyEl.appendChild(row);
    });
}

function updateRealLengthStatsFromResults(results) {
    const setTextContent = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(val);
    };
    const frames = new Set(results.map(r => r.frame));
    const motionPoints = Array.isArray(window.motionPoints) ? window.motionPoints : [];
    setTextContent('total-frames', frames.size || 0);
    setTextContent('total-points', motionPoints.length || 0);
    setTextContent('average-error', '—');
    setTextContent('max-error', '—');
}

function clearRealLengthTable() {
    const headEl = document.getElementById('real-length-table-head');
    const bodyEl = document.getElementById('real-length-table-body');
    if (headEl) headEl.innerHTML = '';
    if (bodyEl) bodyEl.innerHTML = '';
}

// 実長換算ボタンにフックして x,y 表示を更新
// 4点実長換算モード用UIの可視/不可視切り替え
function applyCalibrationModeUI() {
    const methodSel = document.getElementById('calibration-method');
    const method = methodSel ? methodSel.value : '';

    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };

    const isFourPoint = method === '4-point';
    const isCCMethod = method === '3d-cc-method';
    const isCharuco = method === 'charuco-single' || method === 'charuco-stereo';

    // 4点実長換算で必要なもの
    show('four-point-input-container', isFourPoint);

    // 4点実長換算とCC法では「カメラ定数」ボタンを非表示（CC法は専用ボタンで実行）
    show('calculate-camera-coefficients', !isFourPoint && !isCCMethod); // ボタン自体
    const cc = document.querySelector('.calibration-controls');
    if (cc) cc.style.display = (isFourPoint || isCCMethod) ? 'none' : '';

    show('dlt2d-results-container', !isFourPoint && !isCCMethod && !isCharuco);
    show('dlt3d-results-container', method === '3d-dlt');
    show('cc-method-container', isCCMethod);
    show('charuco-result-container', isCharuco);
    show('intrinsic-extrinsic-container', isCharuco && method !== 'charuco-stereo');

    // テーブルは常時表示だが、ヘッダ/列は table-operations.js 側で method に応じて制御済み
}

// 初期適用とセレクタ変更に応じて適用
(function wireCalibrationMethodUI() {
    const sel = document.getElementById('calibration-method');
    if (sel) {
        sel.addEventListener('change', applyCalibrationModeUI);
        // 初期状態でも適用
        applyCalibrationModeUI();
    }
})();

// 他モジュールから呼び出せるよう公開
window.applyCalibrationModeUI = applyCalibrationModeUI;

// 表のビルド（Cam1/2）
function buildCharucoTable(calib, tbodyId) {
    const body = document.getElementById(tbodyId);
    if (!body) return;
    body.innerHTML = '';
    if (!calib || !calib.tvecs) return;
    const n = calib.tvecs.length;
    for (let i = 0; i < n; i++) {
        const t = calib.tvecs[i] || [0, 0, 0];
        const R = calib.rotationMatrices && calib.rotationMatrices[i];
        const tx = Number(t[0]), ty = Number(t[1]), tz = Number(t[2]);
        const dOrigin = Math.sqrt(tx * tx + ty * ty + tz * tz);
        let dPlane = '-';
        if (R && R.length === 9) {
            const nx = Number(R[2]);
            const ny = Number(R[5]);
            const nz = Number(R[8]);
            dPlane = Math.abs(nx * tx + ny * ty + nz * tz).toFixed(6);
        }
        const corners = calib.cornerCounts ? (calib.cornerCounts[i] ?? '-') : '-';
        const markers = calib.markerCounts ? (calib.markerCounts[i] ?? '-') : '-';
        const frameNum = (calib.frameNumbers && calib.frameNumbers[i]) ? calib.frameNumbers[i] : null;
        const tr = document.createElement('tr');
        tr.dataset.boardIndex = String(i);
        if (frameNum) tr.dataset.frameNumber = String(frameNum);
        tr.style.cursor = 'pointer';
        tr.title = frameNum
            ? `クリック: フレーム ${frameNum} に移動し、実長換算ボードとして選択`
            : `クリック: このボード(#${i + 1})を実長換算ボードとして選択`;
        tr.innerHTML = `
            <td>${i + 1}${frameNum ? ` <span class="cc-row-frame">[F:${frameNum}]</span>` : ''}</td>
            <td>${corners}</td>
            <td>${markers}</td>
            <td>${dOrigin.toFixed(6)}</td>
            <td>${tz.toFixed(6)}</td>
            <td>${dPlane}</td>
        `;
        tr.addEventListener('click', () => {
            if (typeof window.jumpToCharucoBoardFrame === 'function') {
                window.jumpToCharucoBoardFrame(i);
            }
            // 視覚的なハイライト
            body.querySelectorAll('tr.cc-row-selected').forEach(r => r.classList.remove('cc-row-selected'));
            tr.classList.add('cc-row-selected');
        });
        body.appendChild(tr);
    }
}

/**
 * 指定したキャリブレーションボード(index) に対応するフレームへ移動し、
 * 実長換算用のボード選択 (analysis-board-select / charuco-board-select) を同期する。
 *
 * ChArUco 結果テーブルの行クリック時と、
 * 既存「選択したボードのフレームを表示」ボタンの両方から呼ばれる共通処理。
 */
window.jumpToCharucoBoardFrame = function jumpToCharucoBoardFrame(boardIndex) {
    const calib = window.projectData && window.projectData.calibration;
    if (!calib || !calib.rvecs || boardIndex < 0 || boardIndex >= calib.rvecs.length) {
        if (typeof window.showError === 'function') {
            window.showError('選択されたボードのキャリブレーション結果が見つかりません');
        }
        return;
    }

    const frameNumber = (calib.frameNumbers && calib.frameNumbers[boardIndex])
        ? calib.frameNumbers[boardIndex] : null;

    // 実長換算用ボード選択を同期
    const analysisSelect = document.getElementById('analysis-board-select');
    if (analysisSelect) {
        analysisSelect.value = String(boardIndex);
        analysisSelect.dispatchEvent(new Event('change'));
    }
    const sidebarSelect = document.getElementById('charuco-board-select');
    if (sidebarSelect) {
        const hasOption = Array.from(sidebarSelect.options).some(o => o.value === String(boardIndex));
        if (hasOption) {
            sidebarSelect.value = String(boardIndex);
            sidebarSelect.dispatchEvent(new Event('change'));
        }
    }

    if (!frameNumber) {
        if (typeof window.showMessage === 'function') {
            window.showMessage(`ボード #${boardIndex + 1} を実長換算用に選択しました（対応フレーム番号なし）`);
        }
        return;
    }

    // キャリブレーションモードへ切替
    const calibrationModeRadio = document.querySelector('input[name="mode"][value="calibration"]');
    if (calibrationModeRadio && !calibrationModeRadio.checked) {
        calibrationModeRadio.checked = true;
        calibrationModeRadio.dispatchEvent(new Event('change'));
    }

    // フレーム番号を設定
    if (typeof window.setCurrentFrameNumber === 'function') {
        window.setCurrentFrameNumber(frameNumber);
    } else if (window.projectData && window.projectData.settings) {
        window.projectData.settings.calibrationFrame = frameNumber;
        window.projectData.settings.currentFrame = frameNumber;
    }

    // フレームスライダーを同期
    const frameSlider = document.getElementById('frame-slider');
    if (frameSlider) {
        frameSlider.value = frameNumber;
    }
    if (typeof window.updateFrameInfo === 'function') {
        window.updateFrameInfo();
    }
    // 次フレーム描画までキャンバスサイズ再計算のタイミングを譲る
    setTimeout(() => {
        if (typeof window.displayCurrentFrame === 'function') {
            window.displayCurrentFrame();
        }
    }, 80);

    // デジタイズタブを開く（キャリブレーション動画はそこに表示される）
    if (typeof window.switchTab === 'function') {
        window.switchTab('digitize');
    }

    if (typeof window.showMessage === 'function') {
        window.showMessage(`ボード #${boardIndex + 1} / フレーム ${frameNumber} に移動しました`);
    }
};

/**
 * 現在のフレーム番号と一致する ChArUco ボードがあれば、
 * analysis-board-select および結果テーブルのハイライトを同期する。
 *
 * frame slider 操作・矢印キーでフレーム移動しても、
 * 「選択中のボード」表示が追従するようにするためのフック。
 * updateFrameInfo() から呼ばれる。
 */
window.syncCharucoSelectionToCurrentFrame = function () {
    // 再入防止: jumpToCharucoBoardFrame 経由のフレーム変更では同期処理をスキップ
    if (window.__suppressBoardSelectCascade) return;

    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    if (method !== 'charuco-single') return;

    const calib = window.projectData && window.projectData.calibration;
    if (!calib || !Array.isArray(calib.frameNumbers) || calib.frameNumbers.length === 0) return;

    const currentFrame = (window.projectData && window.projectData.settings &&
        (window.projectData.settings.currentFrame || window.projectData.settings.calibrationFrame)) || null;
    if (!currentFrame) return;

    const matchIdx = calib.frameNumbers.findIndex(f => Number(f) === Number(currentFrame));
    if (matchIdx < 0) return;

    // analysis-board-select の値を同期（change イベントは発火しない＝フレーム再移動ループを防止）
    const sel = document.getElementById('analysis-board-select');
    if (sel && sel.value !== String(matchIdx)) {
        sel.value = String(matchIdx);
        // 情報パネルだけは更新したいので、updateAnalysisBoardSelectUI 内の updateExtrinsicInfo 相当を手動で呼ぶ
        const boardNameEl = document.getElementById('selected-board-name');
        const rvecEl = document.getElementById('selected-rvec');
        const tvecEl = document.getElementById('selected-tvec');
        const infoDiv = document.getElementById('selected-extrinsic-info');
        const rvec = calib.rvecs && calib.rvecs[matchIdx];
        const tvec = calib.tvecs && calib.tvecs[matchIdx];
        if (boardNameEl) boardNameEl.textContent = `ボード #${matchIdx + 1} [F:${currentFrame}]`;
        if (rvecEl && rvec) rvecEl.textContent = `[${rvec.map(v => Number(v).toFixed(6)).join(', ')}]`;
        if (tvecEl && tvec) tvecEl.textContent = `[${tvec.map(v => Number(v).toFixed(6)).join(', ')}]`;
        if (infoDiv) infoDiv.style.display = 'block';
    }

    // サイドバーのボード選択も同期
    const sidebarSel = document.getElementById('charuco-board-select');
    if (sidebarSel && sidebarSel.value !== String(matchIdx)) {
        const hasOption = Array.from(sidebarSel.options).some(o => o.value === String(matchIdx));
        if (hasOption) sidebarSel.value = String(matchIdx);
    }

    // 結果テーブルの行ハイライト
    const tbody = document.getElementById('charuco-table-body-cam1');
    if (tbody) {
        tbody.querySelectorAll('tr.cc-row-selected').forEach(r => r.classList.remove('cc-row-selected'));
        const target = tbody.querySelector(`tr[data-board-index="${matchIdx}"]`);
        if (target) target.classList.add('cc-row-selected');
    }
};

function updateErrorBarChart(errors, containerId, title) {
    if (!Array.isArray(errors)) return;
    if (!window.Plotly) return;
    const plotDiv = document.getElementById(containerId);
    if (!plotDiv) return;

    // 横軸はビューID（1-based連番）
    const x = errors.map((_, i) => i + 1);
    const y = errors.map(v => Number(v));

    // 外れ値によるスケール歪みを防ぐため、IQR方式でY軸上限を設定
    const sorted = [...y].filter(v => v >= 0).sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)] || 0;
    const q3 = sorted[Math.floor(sorted.length * 0.75)] || 1;
    const iqr = q3 - q1;
    const upperFence = q3 + iqr * 2.5;
    // Y軸上限: 外れ値フェンスか最大値の小さい方（最低でも全体RMSの3倍）
    const overallRms = window.projectData?.calibration?.reprojectionError || 1;
    const yAxisMax = Math.max(upperFence, overallRms * 3, q3 * 2);

    // 外れ値（フェンス超え）は赤色で強調
    const colors = y.map(v => v > upperFence ? '#e45756' : '#4e79a7');

    const data = [{
        type: 'bar', x, y, marker: { color: colors },
        hovertemplate: 'ビュー %{x}<br>RMS: %{y:.4f} px<extra></extra>'
    }];
    const layout = {
        title: title || 'ビュー毎RMS誤差',
        margin: { t: 30, r: 5, l: 40, b: 30 },
        autosize: true,
        xaxis: { title: 'ビュー', dtick: 1, tickformat: 'd', range: [0.5, x.length + 0.5] },
        bargap: 0.15,
        yaxis: {
            title: 'RMS [px]',
            range: [0, yAxisMax * 1.1]
        }
    };
    const config = { displayModeBar: false, responsive: true };

    // 既存チャートの有無で newPlot/react を切り替え（react は差分更新で確実）
    if (plotDiv._fullLayout) {
        window.Plotly.react(plotDiv, data, layout, config);
    } else {
        window.Plotly.newPlot(plotDiv, data, layout, config);
    }

    // クリックリスナーは1回だけ登録（purge/react で自動リセットされるため毎回設定）
    plotDiv.removeAllListeners?.('plotly_click');
    plotDiv.on('plotly_click', (ev) => {
        if (!ev || !ev.points || !ev.points.length) return;
        const pt = ev.points[0];
        const arrayIdx = (typeof pt.pointIndex === 'number') ? pt.pointIndex : pt.pointNumber;
        if (!Number.isFinite(arrayIdx)) return;
        // ビューID（0-based index）
        const rms = errors[arrayIdx];
        const ok = window.confirm(
            `ビュー #${arrayIdx + 1} (RMS=${Number(rms).toFixed(4)} px) を\n` +
            `キャリブレーションから除外して再計算しますか？`
        );
        if (!ok) return;
        if (typeof window.excludeCharucoViewAndRecompute === 'function') {
            window.excludeCharucoViewAndRecompute(arrayIdx);
        }
    });
}

/**
 * CC法用 3Dキャリブレーション表示を開く（別ウィンドウ）
 */
window.show3DCCMethodView = async function () {
    const ccCalib = window.projectData?.ccCalibration;
    if (!ccCalib || !ccCalib.results) {
        if (typeof window.showError === 'function') {
            window.showError('CC法のキャリブレーション結果がありません。先にキャリブレーションを実行してください。');
        }
        return;
    }

    const res = ccCalib.results;

    // カメラパラメータ取得（res.cam1.cameraParams に格納されている）
    const cam1Params = res.cam1?.cameraParams || {};
    const cam2Params = res.cam2?.cameraParams || {};

    // 制御点座標を取得（計算に使用したデータをそのまま利用）
    const points = window.calibrationData?.points || [];

    // 有効な（実空間座標がある）ポイントのみ抽出
    const validPoints = points.filter(p =>
        p.realCoords &&
        typeof p.realCoords.x === 'number' &&
        typeof p.realCoords.y === 'number' &&
        typeof p.realCoords.z === 'number'
    ).map(p => ({
        name: p.name,
        x: p.realCoords.x,
        y: p.realCoords.y,
        z: p.realCoords.z
    }));

    const data = {
        isCCMethod: true,
        cam1: {
            x: cam1Params.X0,
            y: cam1Params.Y0,
            z: cam1Params.Z0
        },
        cam2: {
            x: cam2Params.X0,
            y: cam2Params.Y0,
            z: cam2Params.Z0
        },
        points: validPoints
    };

    // IPC経由で別ウィンドウを開く
    try {
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('open-3d-calibration-view', data);
        if (!result.success) {
            if (typeof window.showError === 'function') {
                window.showError('3D表示ウィンドウのオープンに失敗: ' + (result.error || 'unknown error'));
            }
        }
    } catch (e) {
        if (typeof window.showError === 'function') {
            window.showError('3D表示エラー: ' + e.message);
        }
    }
}

/**
 * 3次元DLT法用 3Dキャリブレーション表示を開く（別ウィンドウ）
 */
window.show3DDLTMethodView = async function () {
    const coeffs3D = window.projectData?.cameraCoefficients3D;
    const points = window.calibrationData?.points || [];

    // Fallback: search for dltCalibration or ccCalibration.params
    const ccCalib = window.projectData?.ccCalibration || window.projectData?.dltCalibration;
    let dltParams = null;
    if (ccCalib) {
        dltParams = ccCalib.stereoDLTParams || ccCalib.params;
    }

    let cam1Coeffs = coeffs3D?.cam1;
    let cam2Coeffs = coeffs3D?.cam2;

    // Convert array format to object format if necessary
    if (!cam1Coeffs && dltParams && dltParams[0]) {
        const toLObj = arr => ({
            L1: arr[0], L2: arr[1], L3: arr[2], L4: arr[3],
            L5: arr[4], L6: arr[5], L7: arr[6], L8: arr[7],
            L9: arr[8], L10: arr[9], L11: arr[10]
        });
        cam1Coeffs = toLObj(dltParams[0]);
        cam2Coeffs = toLObj(dltParams[1]);
    }

    if (!cam1Coeffs || !cam2Coeffs) {
        if (typeof window.showError === 'function') {
            window.showError('3次元DLT法のキャリブレーション結果がありません。先に「カメラ定数」を計算してください。');
        }
        return;
    }

    // DLT行列からカメラの原点座標(- M1^-1 * m4)を求める
    const calcCameraCenter = (C) => {
        try {
            const math = window.math || (typeof require === 'function' ? require('mathjs') : null);
            if (!math) return null;
            const M1 = [
                [C.L1, C.L2, C.L3],
                [C.L5, C.L6, C.L7],
                [C.L9, C.L10, C.L11]
            ];
            const m4 = [C.L4, C.L8, 1];
            const invM1 = math.inv(M1);
            // mathjsのmultiplyで2次元x1次元の場合はベクトルになる
            const m4_col = [[m4[0]], [m4[1]], [m4[2]]];
            const center_col = math.multiply(invM1, m4_col);
            return {
                x: -center_col[0][0],
                y: -center_col[1][0],
                z: -center_col[2][0]
            };
        } catch (e) {
            console.error("Failed to extract camera center from DLT", e);
            return null;
        }
    };

    const cam1Pos = calcCameraCenter(cam1Coeffs) || { x: 0, y: 0, z: 0 };
    const cam2Pos = calcCameraCenter(cam2Coeffs) || { x: 0, y: 0, z: 0 };

    // 有効な（実空間座標がある）ポイントのみ抽出
    const validPoints = points.filter(p =>
        p.realCoords &&
        typeof p.realCoords.x === 'number' &&
        typeof p.realCoords.y === 'number' &&
        typeof p.realCoords.z === 'number'
    ).map(p => ({
        name: p.name,
        x: p.realCoords.x,
        y: p.realCoords.y,
        z: p.realCoords.z
    }));

    const data = {
        is3DDLTMethod: true,
        cam1: cam1Pos,
        cam2: cam2Pos,
        points: validPoints
    };

    // IPC経由で別ウィンドウを開く
    try {
        const { ipcRenderer } = require('electron');
        const result = await ipcRenderer.invoke('open-3d-calibration-view', data);
        if (!result.success) {
            if (typeof window.showError === 'function') {
                window.showError('3D表示ウィンドウのオープンに失敗: ' + (result.error || 'unknown error'));
            }
        }
    } catch (e) {
        if (typeof window.showError === 'function') {
            window.showError('3D表示エラー: ' + e.message);
        }
    }
}

window.show3DCalibrationView = async function () {
    // ステレオモードかどうかを確認
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    const isStereo = (method === 'charuco-stereo');

    // ボード設定を取得
    const rowsEl = document.getElementById('charuco-rows');
    const colsEl = document.getElementById('charuco-cols');
    const sqEl = document.getElementById('charuco-square-mm');
    const rows = rowsEl ? parseInt(rowsEl.value, 10) : 5;
    const cols = colsEl ? parseInt(colsEl.value, 10) : 7;
    const squareSizeMm = sqEl ? parseFloat(sqEl.value) : 130;

    // キャリブレーションデータを準備
    const calibrationData = {
        boardRows: rows,
        boardCols: cols,
        squareSizeMm: squareSizeMm,
        isStereo: isStereo
    };

    if (isStereo) {
        // ステレオモード: ステレオキャリブレーション結果を使用
        const stereoCalib = window.projectData?.stereoCalibration;
        if (!stereoCalib || !stereoCalib.R || !stereoCalib.T) {
            showError('ステレオキャリブレーション結果がありません。先にステレオキャリブレーションを実行してください。');
            return;
        }

        // ステレオカメラの位置関係を計算
        // Cam1を原点、Cam2の位置はR, Tから計算
        // R, TはCam1からCam2への変換
        calibrationData.stereoR = stereoCalib.R;
        calibrationData.stereoT = stereoCalib.T;
        calibrationData.baseline = stereoCalib.baseline;
        calibrationData.stereoSamples = stereoCalib.samples || 0;

        // ステレオキャリブレーションで使用したボード位置を表示
        // ステレオキャリブレーションの結果に含まれるrvecs, tvecsを使用（Cam1座標系）
        if (stereoCalib.rvecs && stereoCalib.tvecs && stereoCalib.rvecs.length > 0) {
            calibrationData.rvecs = stereoCalib.rvecs;
            calibrationData.tvecs = stereoCalib.tvecs;
        }
    } else {
        // 単眼モード: 従来通り
        const calib = projectData.calibration;
        if (!calib || !calib.rvecs || !calib.tvecs || calib.rvecs.length === 0) {
            showError('キャリブレーション結果がありません。先にキャリブレーションを実行してください。');
            return;
        }
        calibrationData.rvecs = calib.rvecs;
        calibrationData.tvecs = calib.tvecs;
    }

    // IPC経由で別ウィンドウを開く
    try {
        const result = await ipcRenderer.invoke('open-3d-calibration-view', calibrationData);
        if (!result.success) {
            showError('3D表示ウィンドウのオープンに失敗: ' + (result.error || 'unknown error'));
        }
    } catch (e) {
        showError('3D表示エラー: ' + e.message);
    }
}

/**
 * 3D表示を更新（モーダル用 - 後方互換性のため残す）
 */
window.close3DCalibrationView = function () {
    const modal = document.getElementById('calibration-3d-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * 3D表示を更新（モーダル用 - 後方互換性のため残す）
 */
window.update3DView = function () {
    const calib = projectData.calibration;
    if (!calib || !calib.rvecs || !calib.tvecs) return;

    const viewType = document.getElementById('3d-view-type')?.value || 'pattern-centric';
    const chartDiv = document.getElementById('calibration-3d-chart');
    if (!chartDiv || !window.Plotly) return;

    // ボード設定を取得
    const rowsEl = document.getElementById('charuco-rows');
    const colsEl = document.getElementById('charuco-cols');
    const sqEl = document.getElementById('charuco-square-mm');
    const rows = rowsEl ? parseInt(rowsEl.value, 10) : 5;
    const cols = colsEl ? parseInt(colsEl.value, 10) : 7;
    const squareSizeMm = sqEl ? parseFloat(sqEl.value) : 130;
    const squareSizeM = squareSizeMm / 1000; // mm → m

    const boardWidthM = (cols - 1) * squareSizeM;
    const boardHeightM = (rows - 1) * squareSizeM;

    // OpenCV座標系から表示座標系への変換
    // OpenCV: X右, Y下, Z奥行き
    // 表示: X右, Y奥行き, Z上
    const transformToDisplay = (point) => {
        return [point[0], point[2], -point[1]];
    };

    // 回転ベクトルから回転行列を計算
    const rodrigues = (rvec) => {
        const theta = Math.sqrt(rvec[0] ** 2 + rvec[1] ** 2 + rvec[2] ** 2);
        if (theta < 1e-6) {
            return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        }
        const kx = rvec[0] / theta;
        const ky = rvec[1] / theta;
        const kz = rvec[2] / theta;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const v = 1 - c;
        return [
            [kx * kx * v + c, kx * ky * v - kz * s, kx * kz * v + ky * s],
            [kx * ky * v + kz * s, ky * ky * v + c, ky * kz * v - kx * s],
            [kx * kz * v - ky * s, ky * kz * v + kx * s, kz * kz * v + c]
        ];
    };

    // 行列とベクトルの積
    const matMul = (R, v) => {
        return [
            R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
            R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
            R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]
        ];
    };

    // 転置行列
    const transpose = (R) => {
        return [
            [R[0][0], R[1][0], R[2][0]],
            [R[0][1], R[1][1], R[2][1]],
            [R[0][2], R[1][2], R[2][2]]
        ];
    };

    const traces = [];
    const colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];

    if (viewType === 'pattern-centric') {
        // Pattern-centric view: ボードを原点に置き、カメラ位置を表示
        const boardCornersOpenCV = [
            [0, 0, 0],
            [boardWidthM, 0, 0],
            [boardWidthM, boardHeightM, 0],
            [0, boardHeightM, 0]
        ];

        const boardCornersDisplay = boardCornersOpenCV.map(transformToDisplay);
        boardCornersDisplay.push(boardCornersDisplay[0]); // 閉じる

        // ボードを描画
        traces.push({
            type: 'scatter3d',
            mode: 'lines',
            x: boardCornersDisplay.map(p => p[0]),
            y: boardCornersDisplay.map(p => p[1]),
            z: boardCornersDisplay.map(p => p[2]),
            line: { color: 'gray', width: 3 },
            name: 'Board',
            showlegend: false
        });

        // 各ビューのカメラ位置を計算
        calib.rvecs.forEach((rvec, i) => {
            const tvec = calib.tvecs[i];
            const R = rodrigues(rvec);
            const tvecM = [tvec[0], tvec[1], tvec[2]]; // メートル単位のまま使用

            // カメラ位置（OpenCV座標系）= -R^T @ t
            const RT = transpose(R);
            const cameraPosOpenCV = [
                -(RT[0][0] * tvecM[0] + RT[0][1] * tvecM[1] + RT[0][2] * tvecM[2]),
                -(RT[1][0] * tvecM[0] + RT[1][1] * tvecM[1] + RT[1][2] * tvecM[2]),
                -(RT[2][0] * tvecM[0] + RT[2][1] * tvecM[1] + RT[2][2] * tvecM[2])
            ];

            const cameraPosDisplay = transformToDisplay(cameraPosOpenCV);
            const color = colors[i % colors.length];

            // カメラ位置を点で表示
            traces.push({
                type: 'scatter3d',
                mode: 'markers+text',
                x: [cameraPosDisplay[0]],
                y: [cameraPosDisplay[1]],
                z: [cameraPosDisplay[2]],
                marker: { size: 8, color: color },
                text: [String(i)],
                textposition: 'top center',
                name: `View ${i}`,
                showlegend: true
            });
        });

        const layout = {
            title: 'Pattern-centric View (Board at origin, showing camera positions)',
            scene: {
                xaxis: { title: 'X (m)' },
                yaxis: { title: 'Y (m) - depth' },
                zaxis: { title: 'Z (m) - up' },
                aspectmode: 'data'
            },
            margin: { l: 0, r: 0, t: 30, b: 0 }
        };

        window.Plotly.newPlot(chartDiv, traces, layout, { displayModeBar: true });

    } else {
        // Camera-centric view: カメラを原点に置き、ボード位置を表示
        // カメラ位置（原点）
        traces.push({
            type: 'scatter3d',
            mode: 'markers',
            x: [0],
            y: [0],
            z: [0],
            marker: { size: 10, color: 'gray' },
            name: 'Camera',
            showlegend: true
        });

        // 各ビューのボード位置を計算
        const boardCornersOpenCV = [
            [0, 0, 0],
            [boardWidthM, 0, 0],
            [boardWidthM, boardHeightM, 0],
            [0, boardHeightM, 0]
        ];

        calib.rvecs.forEach((rvec, i) => {
            const tvec = calib.tvecs[i];
            const R = rodrigues(rvec);
            const tvecM = [tvec[0], tvec[1], tvec[2]]; // メートル単位のまま使用

            // ボードをカメラ座標系に変換（OpenCV座標系）
            const boardCornersCamOpenCV = boardCornersOpenCV.map(corner => {
                const rotated = matMul(R, corner);
                return [
                    rotated[0] + tvecM[0],
                    rotated[1] + tvecM[1],
                    rotated[2] + tvecM[2]
                ];
            });

            const boardCornersCamDisplay = boardCornersCamOpenCV.map(transformToDisplay);
            boardCornersCamDisplay.push(boardCornersCamDisplay[0]); // 閉じる

            const color = colors[i % colors.length];

            // ボードを描画
            traces.push({
                type: 'scatter3d',
                mode: 'lines',
                x: boardCornersCamDisplay.map(p => p[0]),
                y: boardCornersCamDisplay.map(p => p[1]),
                z: boardCornersCamDisplay.map(p => p[2]),
                line: { color: color, width: 2 },
                name: `View ${i}`,
                showlegend: true
            });
        });

        const layout = {
            title: 'Camera-centric View (Camera at origin, showing board positions)',
            scene: {
                xaxis: { title: 'X (m)' },
                yaxis: { title: 'Y (m) - depth' },
                zaxis: { title: 'Z (m) - up' },
                aspectmode: 'data'
            },
            margin: { l: 0, r: 0, t: 30, b: 0 }
        };

        window.Plotly.newPlot(chartDiv, traces, layout, { displayModeBar: true });
    }
}

// ----------------------------------------------------
// Export UI functions for file-handler.js
// ----------------------------------------------------
window.buildCharucoTable = buildCharucoTable;
window.updateErrorBarChart = updateErrorBarChart;
window.populateExtrinsicViewSelect = populateExtrinsicViewSelect;
window.updateExtrinsicResultUI = updateExtrinsicResultUI;

// ----------------------------------------------------
// Global App Settings (Charuco properties etc)
// ----------------------------------------------------

/**
 * アプリのグローバル設定をロードしてUIに反映する
 */
async function loadAndApplyAppSettings() {
    try {
        const res = await ipcRenderer.invoke('load-app-settings');
        if (res && res.success && res.data) {
            const data = res.data;
            if (data.charucoRows !== undefined) {
                const el = document.getElementById('charuco-rows');
                if (el) el.value = data.charucoRows;
            }
            if (data.charucoCols !== undefined) {
                const el = document.getElementById('charuco-cols');
                if (el) el.value = data.charucoCols;
            }
            if (data.charucoSquareMm !== undefined) {
                const el = document.getElementById('charuco-square-mm');
                if (el) el.value = data.charucoSquareMm;
            }
            if (data.charucoMarkerMm !== undefined) {
                const el = document.getElementById('charuco-marker-mm');
                if (el) el.value = data.charucoMarkerMm;
            }
            if (data.charucoDictionary !== undefined) {
                const el = document.getElementById('charuco-dictionary');
                if (el) el.value = data.charucoDictionary;
            }
        }
    } catch (e) {
        console.warn('[Renderer] Failed to load app settings:', e);
    }
}

/**
 * アプリのグローバル設定を保存する
 */
async function saveAppSettings() {
    try {
        const rowsEl = document.getElementById('charuco-rows');
        const colsEl = document.getElementById('charuco-cols');
        const sqEl = document.getElementById('charuco-square-mm');
        const mkEl = document.getElementById('charuco-marker-mm');
        const dictEl = document.getElementById('charuco-dictionary');

        const settingsToSave = {
            charucoRows: rowsEl ? parseInt(rowsEl.value, 10) : 5,
            charucoCols: colsEl ? parseInt(colsEl.value, 10) : 7,
            charucoSquareMm: sqEl ? parseFloat(sqEl.value) : 165,
            charucoMarkerMm: mkEl ? parseFloat(mkEl.value) : 123,
            charucoDictionary: dictEl ? dictEl.value : 'DICT_4X4_50'
        };

        await ipcRenderer.invoke('save-app-settings', settingsToSave);
    } catch (e) {
        console.warn('[Renderer] Failed to save app settings:', e);
    }
}