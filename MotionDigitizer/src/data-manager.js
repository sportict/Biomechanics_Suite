/**
 * data-manager.js - MotionDigitizer v1.0 データ管理
 * プロジェクトデータ構造の管理・フレームデータの保存取得・キャリブレーションデータ管理
 */

var ipcRenderer = (window && window.ipcRenderer) ? window.ipcRenderer : require('electron').ipcRenderer;
window.ipcRenderer = ipcRenderer;

// ファイル選択状態の管理（グローバル共有）
var fileState = (window && window.fileState) ? window.fileState : {
    'cal-cam1': null,
    'cal-cam2': null,
    'motion-cam1': null,
    'motion-cam2': null
};
window.fileState = fileState;

// カメラ別のデジタイズ結果を保存（グローバル共有）
var cameraDigitizeData = (window && window.cameraDigitizeData) ? window.cameraDigitizeData : {
    'cam1': {},
    'cam2': {}
};
window.cameraDigitizeData = cameraDigitizeData;


// モーションポイント専用データ構造（独立・グローバル共有）
var motionPoints = (window && window.motionPoints) ? window.motionPoints : [
    { id: 1, name: "右手先", category: "上肢" },
    { id: 2, name: "右手首", category: "上肢" },
    { id: 3, name: "右肘", category: "上肢" },
    { id: 4, name: "右肩", category: "上肢" },
    { id: 5, name: "左手先", category: "上肢" },
    { id: 6, name: "左手首", category: "上肢" },
    { id: 7, name: "左肘", category: "上肢" },
    { id: 8, name: "左肩", category: "上肢" },
    { id: 9, name: "右つま先", category: "下肢" },
    { id: 10, name: "右母指球", category: "下肢" },
    { id: 11, name: "右かかと", category: "下肢" },
    { id: 12, name: "右足首", category: "下肢" },
    { id: 13, name: "右膝", category: "下肢" },
    { id: 14, name: "右大転子", category: "下肢" },
    { id: 15, name: "左つま先", category: "下肢" },
    { id: 16, name: "左母指球", category: "下肢" },
    { id: 17, name: "左かかと", category: "下肢" },
    { id: 18, name: "左足首", category: "下肢" },
    { id: 19, name: "左膝", category: "下肢" },
    { id: 20, name: "左大転子", category: "下肢" },
    { id: 21, name: "頭頂", category: "体幹" },
    { id: 22, name: "耳珠点", category: "体幹" },
    { id: 23, name: "胸骨上縁", category: "体幹" }
];
window.motionPoints = motionPoints;

// キャリブレーションデータ管理（独立・グローバル共有）
var calibrationData = (window && window.calibrationData) ? window.calibrationData : {
    points: [], // Calポイントのデータ
    method: null // 現在のキャリブレーション方法
};
window.calibrationData = calibrationData;

// プロジェクトデータのメイン構造（グローバル共有）
var projectData = (window && window.projectData) ? window.projectData : {
    settings: {
        videoFile: null,
        videoWidth: 0,
        videoHeight: 0,
        fps: 30,
        digitizeInterval: 1,
        calibrationFrameCount: 0,         // キャリブレーション動画のフレーム数
        motionFrameCount: 0,              // モーション動画のフレーム数
        currentFrame: 1,                  // モーションモード用フレーム番号
        calibrationFrame: 1,              // キャリブレーションモード用フレーム番号
        startFrame: 1,
        endFrame: 100
    },
    frameData: new Map(), // 互換のため保持（新実装では未使用）
    digitizedPoints: {},
    landmarks: [],
    analysisResults: {
        coordinates3D: new Map(),
        standardErrors: new Map()
    },
    // カメラ定数を追加
    cameraCoefficients: {
        cam1: null,
        cam2: null
    }
};
window.projectData = projectData;

/**
 * Calポイントの初期化（既存データがある場合は保持）
 */
function initializeCalibrationPoints() {
    // 既存のキャリブレーションデータがある場合は初期化しない
    if (!calibrationData.points || calibrationData.points.length === 0) {
        calibrationData.points = []; // 初期状態のみ空配列で初期化
    }
}

/**
 * 現在のフレーム番号を取得する関数（モードに応じて）
 */
function getCurrentFrameNumber() {
    const currentMode = getCurrentMode();
    if (currentMode === 'calibration') {
        const calibrationFrame = projectData.settings.calibrationFrame;
        const currentFrame = projectData.settings.currentFrame;

        // renderer.js でのスライダーイベントは projectData.settings.currentFrame を直接更新している
        // もし currentFrame と calibrationFrame がずれている場合は、currentFrame を優先する（操作中とみなす）
        if (currentFrame && currentFrame > 0 && currentFrame !== calibrationFrame) {
            // 同期させておく
            projectData.settings.calibrationFrame = currentFrame;
            return currentFrame;
        }

        if (calibrationFrame && calibrationFrame > 0) {
            return calibrationFrame;
        } else if (currentFrame && currentFrame > 0) {
            return currentFrame;
        } else {
            return 1;
        }
    } else {
        return projectData.settings.currentFrame || 1;
    }
}

/**
 * フレーム番号を設定する関数（モードに応じて）
 */
function setCurrentFrameNumber(frameNumber) {
    const currentMode = getCurrentMode();
    const previousFrame = getCurrentFrameNumber();

    if (currentMode === 'calibration') {
        projectData.settings.calibrationFrame = frameNumber;
        // キャリブレーションモードでもcurrentFrameも更新（互換性のため）
        projectData.settings.currentFrame = frameNumber;
    } else {
        projectData.settings.currentFrame = frameNumber;
    }
}

/**
 * 現在のモードを取得
 */
function getCurrentMode() {
    const modeInput = document.querySelector('input[name="mode"]:checked');
    return modeInput ? modeInput.value : 'motion'; // デフォルトはモーションモード
}

/**
 * 現在のカメラ選択を取得
 */
function getCurrentCamera() {
    const cameraInput = document.querySelector('input[name="camera"]:checked');
    return cameraInput ? cameraInput.value : 'cam1'; // デフォルトはカメラ1
}

/**
 * モードをプログラムから設定し、UIに反映
 * @param {string} mode - 'calibration' または 'motion'
 */
window.setCurrentMode = function (mode) {
    const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
    if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
};

/**
 * カメラをプログラムから設定し、UIに反映
 * @param {string} camera - 'cam1' または 'cam2'
 */
window.setCurrentCamera = function (camera) {
    const radio = document.querySelector(`input[name="camera"][value="${camera}"]`);
    if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
};

/**
 * フレームアクセス時の初期化
 */
function ensureFrameDataExists(frameNumber) {
    // 互換目的で空実装（cameraDigitizeData を使用）
    if (!projectData.frameData.has(frameNumber)) {
        projectData.frameData.set(frameNumber, new Map());
    }
}

/**
 * 新規プロジェクト
 */
async function newProject() {
    // プロジェクトに未保存の変更があるかチェック
    if (typeof window.hasUnsavedChanges === 'function' && window.hasUnsavedChanges()) {
        const response = await ipcRenderer.invoke('show-message-box', {
            type: 'question',
            buttons: ['保存して新規作成', '保存せずに新規作成', 'キャンセル'],
            defaultId: 0,
            cancelId: 2,
            title: '新規プロジェクトの確認',
            message: 'プロジェクトに未保存の変更があります。',
            detail: '保存せずに新規作成すると、変更データは失われます。どうしますか？'
        });

        if (response.response === 2) {
            // キャンセル
            return;
        } else if (response.response === 0) {
            // 保存して新規
            if (typeof window.saveProject === 'function') {
                const saved = await window.saveProject();
                if (!saved) return; // 保存に失敗・キャンセルした場合は新規作成を中断
            }
        }
    }

    // アプリケーション（Webページ）を完全リロードして、起動直後の状態に戻す
    window.location.reload();
}

/**
 * プロジェクト状態をクリア（プロジェクト読み込み時などに使用）
 */
async function clearProjectState() {
    // 0) パスリセット
    window.currentProjectFilePath = null;

    // 1) コアデータの初期化
    projectData = {
        settings: {
            videoFile: null,
            videoWidth: 0,
            videoHeight: 0,
            fps: 30,
            digitizeInterval: 1,
            calibrationFrameCount: 0,
            motionFrameCount: 0,
            currentFrame: 1,
            startFrame: 1,
            endFrame: 100
        },
        frameData: new Map(),
        digitizedPoints: {},
        landmarks: [],
        analysisResults: {
            coordinates3D: new Map(),
            standardErrors: new Map()
        },
        // カメラ定数を追加
        cameraCoefficients: {
            cam1: null,
            cam2: null
        }
    };
    // 追加: 2D/3D用係数やステレオ結果を完全リセット
    try { delete projectData.cameraCoefficients2D; } catch (_) { }
    try { delete projectData.cameraCoefficients3D; } catch (_) { }
    try { delete projectData.stereo2DDLT; } catch (_) { }

    // モーションポイントを初期化
    motionPoints = [
        { id: 1, name: "右手先", category: "上肢" },
        { id: 2, name: "右手首", category: "上肢" },
        { id: 3, name: "右肘", category: "上肢" },
        { id: 4, name: "右肩", category: "上肢" },
        { id: 5, name: "左手先", category: "上肢" },
        { id: 6, name: "左手首", category: "上肢" },
        { id: 7, name: "左肘", category: "上肢" },
        { id: 8, name: "左肩", category: "上肢" },
        { id: 9, name: "右つま先", category: "下肢" },
        { id: 10, name: "右母指球", category: "下肢" },
        { id: 11, name: "右かかと", category: "下肢" },
        { id: 12, name: "右足首", category: "下肢" },
        { id: 13, name: "右膝", category: "下肢" },
        { id: 14, name: "右大転子", category: "下肢" },
        { id: 15, name: "左つま先", category: "下肢" },
        { id: 16, name: "左母指球", category: "下肢" },
        { id: 17, name: "左かかと", category: "下肢" },
        { id: 18, name: "左足首", category: "下肢" },
        { id: 19, name: "左膝", category: "下肢" },
        { id: 20, name: "左大転子", category: "下肢" },
        { id: 21, name: "頭頂", category: "体幹" },
        { id: 22, name: "耳珠点", category: "体幹" },
        { id: 23, name: "胸骨上縁", category: "体幹" }
    ];

    // 2) カメラ別データ・キャリブデータ・ファイル状態の初期化
    window.cameraDigitizeData = { cam1: {}, cam2: {} };
    calibrationData.points = [];
    calibrationData.method = null;
    // ファイル選択状態
    try {
        window.fileState = {
            'cal-cam1': null,
            'cal-cam2': null,
            'motion-cam1': null,
            'motion-cam2': null
        };
        if (window.fileStateLists) {
            window.fileStateLists['cal-cam1'] = [];
            window.fileStateLists['cal-cam2'] = [];
            window.fileStateLists['motion-cam1'] = [];
            window.fileStateLists['motion-cam2'] = [];
        }
    } catch (_) { }
    // 実長換算の結果
    try { window.realLengthData = []; } catch (_) { }

    // 3) UI初期化（アプリ起動時同等）
    try { if (typeof clearMemoizedTableData === 'function') clearMemoizedTableData(); } catch (_) { }
    try { clearDataTable(); } catch (_) { }
    try { clearDigitizeCanvas(); } catch (_) { }

    // UI初期化：全未選択状態にする
    try {
        // モード選択解除
        const calRadio = document.getElementById('calibration');
        const motionRadio = document.getElementById('motion');
        if (calRadio) calRadio.checked = false;
        if (motionRadio) motionRadio.checked = false;

        // カメラ選択解除
        const cam1Radio = document.getElementById('camera1');
        const cam2Radio = document.getElementById('camera2');
        if (cam1Radio) cam1Radio.checked = false;
        if (cam2Radio) cam2Radio.checked = false;

        // キャリブレーション方法リセット
        const methodSelect = document.getElementById('calibration-method');
        if (methodSelect) methodSelect.value = "";

        // グローバルステートリセット
        window.currentMode = null;
        window.currentCamera = null;

        // UI更新
        if (typeof updateUI === 'function') updateUI();
        if (typeof updateCameraRequirementUI === 'function') updateCameraRequirementUI();
    } catch (_) { }

    // ファイルUIと必要カメラ表示の更新
    try { if (typeof updateFileSelectionUI === 'function') updateFileSelectionUI(); } catch (_) { }
    try { if (typeof updateCameraRequirementUI === 'function') updateCameraRequirementUI(); } catch (_) { }
    try { if (typeof updateFileSelectionVisibility === 'function') updateFileSelectionVisibility(); } catch (_) { }

    // テーブル・ポイントUIの初期化
    try { if (typeof updateCalibrationDataTable === 'function') updateCalibrationDataTable(); } catch (_) { }
    try { if (typeof updatePointsTab === 'function') updatePointsTab(); } catch (_) { }
    try { if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera(); } catch (_) { }

    // プレビュー初期化
    try {
        const videoEl = document.getElementById('preview-video');
        if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); }
        if (window.previewPlayer && typeof window.previewPlayer.stop === 'function') {
            window.previewPlayer.stop();
        }
    } catch (_) { }

    // ヘッダ/分析テーブルのクリア（実長換算）
    try {
        const rh = document.getElementById('real-length-table-head');
        const rb = document.getElementById('real-length-table-body');
        if (rh) rh.innerHTML = '';
        if (rb) rb.innerHTML = '';
    } catch (_) { }

    // 共通UI更新
    try { updateUI(); } catch (_) { }

    // UI入力フィールドをリセット（FPS, DigitizeIntervalなど）
    try { if (typeof window.resetUIInputs === 'function') window.resetUIInputs(); } catch (_) { }

}

/**
 * プロジェクト保存
 */
/**
 * プロジェクト保存
 * NOTE: file-handler.js に移行されました。互換性のために残していますが、実行されないようにコメントアウトまたは無効化する必要があります。
 */
/**
 * プロジェクト保存
 * NOTE: file-handler.js に移行されました。
 * ここでは window.saveProject を上書きしないように空実装、またはウィンドウ側の関数を呼ぶようにします。
 */
async function _deprecated_saveProject(forceSaveAs = false) {
    console.log('[DATA-MANAGER] _deprecated_saveProject called.');
    if (window.saveProject) {
        return await window.saveProject();
    }
    // file-handler.js が正しくロードされていればここには来ないはずだが、念のため
    console.warn('[DATA-MANAGER] window.saveProject is not available or is circular.');
    return false;
}
/*
    try {
        console.log('[RENDERER] saveProject started...');
        const PD = (window.projectData) || {};
        const PDS = (PD.settings) || {};

        // ... (省略: 旧保存ロジック) ...
        
    } catch (e) {
        console.error('[RENDERER] CRITICAL SAVE ERROR:', e);
        return false;
    }
}
*/

/**
 * プロジェクト上書き保存
 */
// async function saveProjectOverwrite() {
//    return saveProject();
// }

/**
 * プロジェクト別名保存
 */
// async function saveProjectAs() {
//    return saveProject(true);
// }

/**
 * データ保持状況を表示する関数
 */

/**
 * データ保持状況を表示する関数
 */
function showDataStatus() {
    const currentMode = getCurrentMode();
    const cam = getCurrentCamera();
    const frameDataSize = window.cameraDigitizeData && window.cameraDigitizeData[cam]
        ? Object.keys(window.cameraDigitizeData[cam]).length : 0;
    const calibrationDataSize = calibrationData.points ? calibrationData.points.length : 0;

    if (currentMode === 'motion' && frameDataSize > 0) {
        showMessage(`モーションデータ: ${frameDataSize}フレーム分保存済み`);
    } else if (currentMode === 'calibration' && calibrationDataSize > 0) {
        showMessage(`キャリブレーションデータ: ${calibrationDataSize}ポイント分保存済み`);
    }
}

// グローバル関数としてエクスポート
window.projectData = projectData;
window.calibrationData = calibrationData;
window.motionPoints = motionPoints;
window.fileState = fileState;
window.cameraDigitizeData = cameraDigitizeData;

window.getCurrentFrameNumber = getCurrentFrameNumber;
window.setCurrentFrameNumber = setCurrentFrameNumber;
window.getCurrentMode = getCurrentMode;
window.getCurrentCamera = getCurrentCamera;
window.ensureFrameDataExists = ensureFrameDataExists;
window.initializeCalibrationPoints = initializeCalibrationPoints;

window.newProject = newProject;
// window.saveProject = saveProject;
// window.saveProjectOverwrite = saveProjectOverwrite;
// window.saveProjectAs = saveProjectAs;
window.showDataStatus = showDataStatus;

/**
 * プロジェクトに未保存の変更があるかチェック
 */
function hasUnsavedChanges() {
    try {
        // プロジェクトが新規作成された場合（保存されていない）
        if (!projectData || !projectData.settings || !projectData.settings.projectPath) {
            // デジタイズデータがある場合は未保存とみなす
            return hasDigitizeData();
        }

        // 既存プロジェクトの場合、デジタイズデータがあるかチェック
        return hasDigitizeData();
    } catch (error) {

        return false;
    }
}

/**
 * デジタイズデータが存在するかチェック
 */
function hasDigitizeData() {
    try {
        // キャリブレーションデータのチェック
        if (window.calibrationData && window.calibrationData.points) {
            const hasCalibrationData = window.calibrationData.points.some(point =>
                point.isDigitized ||
                (point.digitizedCoords &&
                    (point.digitizedCoords.cam1.x !== null || point.digitizedCoords.cam2.x !== null))
            );
            if (hasCalibrationData) return true;
        }

        // モーションデータのチェック
        if (window.cameraDigitizeData) {
            for (const camera in window.cameraDigitizeData) {
                const cameraData = window.cameraDigitizeData[camera];
                if (cameraData && Object.keys(cameraData).length > 0) {
                    return true;
                }
            }
        }

        // プロジェクトデータのチェック
        if (projectData && projectData.frameData && projectData.frameData.size > 0) {
            return true;
        }

        return false;
    } catch (error) {

        return false;
    }
}

window.hasUnsavedChanges = hasUnsavedChanges;

/**
 * デジタイズ座標を保存（モーション）
 */
function savePointData(landmark, x, y) {
    if (!landmark) return;
    const frameNumber = getCurrentFrameNumber();
    const currentCamera = getCurrentCamera();

    // カメラ別データ（Map）に保存
    const frameKey = frameNumber.toString();
    const pointIdNum = landmark.id != null ? Number(landmark.id) : NaN;
    if (isNaN(pointIdNum)) return;
    if (!cameraDigitizeData[currentCamera][frameKey]) {
        cameraDigitizeData[currentCamera][frameKey] = new Map();
    }
    cameraDigitizeData[currentCamera][frameKey].set(pointIdNum, { x, y });

    // テーブルの該当セルだけ更新
    if (typeof updateDataTableCell === 'function') {
        updateDataTableCell(frameNumber, pointIdNum, x, y);
    }
}

// グローバル公開
window.savePointData = savePointData;

/**
 * デジタイズ座標を取得（モーション）
 */
function getPointData(landmark) {
    if (!landmark) return null;
    const frameNumber = getCurrentFrameNumber();
    const currentCamera = getCurrentCamera();
    const frameKey = frameNumber.toString();
    const pointIdNum = landmark.id != null ? Number(landmark.id) : NaN;
    if (isNaN(pointIdNum)) return null;

    if (cameraDigitizeData[currentCamera][frameKey] && cameraDigitizeData[currentCamera][frameKey].has(pointIdNum)) {
        return cameraDigitizeData[currentCamera][frameKey].get(pointIdNum);
    }
    return null;
}
window.getPointData = getPointData;

/**
 * デジタイズ座標を削除（モーション）
 */
function deletePointData(landmark) {
    if (!landmark) return;
    const frameNumber = getCurrentFrameNumber();
    const currentCamera = getCurrentCamera();
    const frameKey = frameNumber.toString();
    const pointIdNum = landmark.id != null ? Number(landmark.id) : NaN;
    if (isNaN(pointIdNum)) return;

    if (cameraDigitizeData[currentCamera][frameKey]) {
        cameraDigitizeData[currentCamera][frameKey].delete(pointIdNum);
    }

    // テーブル更新（空白で）
    if (typeof updateDataTableCell === 'function') {
        updateDataTableCell(frameNumber, pointIdNum, null, null);
    }
}
window.deletePointData = deletePointData;

// window.saveProject = saveProject;
// window.overwriteProject = saveProjectOverwrite;
// window.saveProjectAs = saveProjectAs;

/**
 * データ保持状況を表示する関数
 */
function showDataStatus() {
    const currentMode = getCurrentMode();
    const cam = getCurrentCamera();
    const frameDataSize = window.cameraDigitizeData && window.cameraDigitizeData[cam]
        ? Object.keys(window.cameraDigitizeData[cam]).length : 0;
    const calibrationDataSize = calibrationData.points ? calibrationData.points.length : 0;

    if (currentMode === 'motion' && frameDataSize > 0) {
        showMessage(`モーションデータ: ${frameDataSize}フレーム分保存済み`);
    } else if (currentMode === 'calibration' && calibrationDataSize > 0) {
        showMessage(`キャリブレーションデータ: ${calibrationDataSize}ポイント分保存済み`);
    }
}

// グローバル関数としてエクスポート
window.projectData = projectData;
window.calibrationData = calibrationData;
window.motionPoints = motionPoints;
window.fileState = fileState;
window.cameraDigitizeData = cameraDigitizeData;

window.getCurrentFrameNumber = getCurrentFrameNumber;
window.setCurrentFrameNumber = setCurrentFrameNumber;
window.getCurrentMode = getCurrentMode;
window.getCurrentCamera = getCurrentCamera;
window.ensureFrameDataExists = ensureFrameDataExists;
window.initializeCalibrationPoints = initializeCalibrationPoints;

window.newProject = newProject;
// window.saveProject = _deprecated_saveProject;
// window.saveProjectOverwrite = saveProjectOverwrite;
// window.saveProjectAs = saveProjectAs;
// window.loadProject = loadProject;  // file-handler.jsで定義済み
window.showDataStatus = showDataStatus;

/**
 * プロジェクトに未保存の変更があるかチェック
 */
function hasUnsavedChanges() {
    try {
        if (!projectData || !projectData.settings || !projectData.settings.projectPath) {
            return hasDigitizeData();
        }
        return hasDigitizeData();
    } catch (error) {
        return false;
    }
}

/**
 * デジタイズデータが存在するかチェック
 */
function hasDigitizeData() {
    try {
        if (window.calibrationData && window.calibrationData.points) {
            const hasCalibrationData = window.calibrationData.points.some(point =>
                point.isDigitized ||
                (point.digitizedCoords &&
                    (point.digitizedCoords.cam1.x !== null || point.digitizedCoords.cam2.x !== null))
            );
            if (hasCalibrationData) return true;
        }

        if (window.cameraDigitizeData) {
            for (const camera in window.cameraDigitizeData) {
                const cameraData = window.cameraDigitizeData[camera];
                if (cameraData && Object.keys(cameraData).length > 0) {
                    return true;
                }
            }
        }
        return false;
    } catch (error) {
        return false;
    }
}

window.hasUnsavedChanges = hasUnsavedChanges;

/**
 * デジタイズ座標を保存（モーション）
 */
function savePointData(landmark, x, y) {
    if (!landmark) return;
    const frameNumber = getCurrentFrameNumber();
    const currentCamera = getCurrentCamera();

    const frameKey = frameNumber.toString();
    const pointIdNum = landmark.id != null ? Number(landmark.id) : NaN;
    if (isNaN(pointIdNum)) return;
    if (!cameraDigitizeData[currentCamera][frameKey]) {
        cameraDigitizeData[currentCamera][frameKey] = new Map();
    }
    cameraDigitizeData[currentCamera][frameKey].set(pointIdNum, { x, y });

    if (typeof updateDataTableCell === 'function') {
        updateDataTableCell(frameNumber, pointIdNum, x, y);
    }
}
window.savePointData = savePointData;

/**
 * デジタイズデータを削除
 */
function deletePointData(landmark) {
    if (!landmark) return;
    const frameNumber = getCurrentFrameNumber();
    const currentCamera = getCurrentCamera();
    const frameKey = frameNumber.toString();
    const pointIdNum = landmark.id != null ? Number(landmark.id) : NaN;

    if (cameraDigitizeData[currentCamera][frameKey]) {
        cameraDigitizeData[currentCamera][frameKey].delete(pointIdNum);
        if (cameraDigitizeData[currentCamera][frameKey].size === 0) {
            delete cameraDigitizeData[currentCamera][frameKey];
        }
    }
    if (typeof updateDataTableCell === 'function') {
        updateDataTableCell(frameNumber, pointIdNum, null, null);
    }
}
window.deletePointData = deletePointData;

/**
 * サイドバーの表示/非表示をトグル
 */
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    if (!sidebar) return;

    sidebar.classList.toggle('collapsed');

    if (toggleBtn) {
        const isCollapsed = sidebar.classList.contains('collapsed');
        toggleBtn.classList.toggle('sidebar-collapsed', isCollapsed);
        toggleBtn.title = isCollapsed ? 'サイドバーを表示' : 'サイドバーを隠す';
    }
}
window.toggleSidebar = toggleSidebar;
window.newProject = newProject;
window.clearProjectState = clearProjectState;