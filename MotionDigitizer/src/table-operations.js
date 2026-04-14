/**
 * table-operations.js
 * MotionDigitizer v1.0 - テーブル操作機能
 * 
 * 責任範囲:
 * - モーションデータテーブル生成・更新
 * - キャリブレーションテーブル管理
 * - Excel風の選択・コピー・ペースト機能
 * - クリップボード操作
 * 
 * 依存関係（他モジュールからインポート必要）:
 * - projectData (data-manager.js)
 * - motionPoints (data-manager.js)
 * - calibrationData (data-manager.js)
 * - showMessage, showError (utils.js)
 * - getCurrentMode, getCurrentCamera (utils.js)
 * - getSelectedLandmark (ui-components.js)
 * - ensureFrameDataExists (data-manager.js)
 */

// ========================================
// グローバル変数・状態管理
// ========================================

// メモ化によるパフォーマンス改善
const memoizedTableData = new Map();

// セル選択の状態管理
let tableSelection = {
    isSelecting: false,
    startCell: null,
    endCell: null,
    selectedCells: new Set()
};

// キャリブレーションテーブル選択機能のグローバル変数
let calibrationTableSelection = {
    selectedCells: new Set(),
    isSelecting: false,
    startCell: null,
    endCell: null
};

// キャリブレーションテーブル用のアクティブセル・アンカー管理（Excel風操作用）
let calibrationActiveCellPos = { row: 0, col: 0 };
let calibrationAnchorCellPos = null;

// キャリブレーションテーブルの編集モード状態
let calibrationEditingCell = null;

// フルカラム選択状態を追跡（Shift+Arrowで全行を維持するため）
let isFullColumnSelection = false;

// ========================================
// モーションデータテーブル関連
// ========================================

/**
 * モーションデータテーブル更新関数（最適化版）
 */
function updateMotionDataTable() {
    const tableHead = document.getElementById('data-table-head');
    const tableBody = document.getElementById('data-table-body');

    if (!tableHead || !tableBody) {
        return;
    }

    // ヘッダーのみ即座に更新
    updateMotionTableHeader(tableHead);

    // ボディ更新はカメラ別経路に委譲
    try {
        const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
        if (typeof updateMotionDataTableWithCameraData === 'function') {
            updateMotionDataTableWithCameraData(cam);
            return;
        }
    } catch (_) { }
    // フォールバック（旧実装）
    updateMotionTableBodyOptimized(tableBody);
}

/**
 * モーションテーブルヘッダー更新
 */
function updateMotionTableHeader(tableHead) {
    tableHead.innerHTML = '';
    const headerRow = tableHead.insertRow();

    const frameHeader = document.createElement('th');
    frameHeader.textContent = 'フレーム';
    frameHeader.className = 'frame-header';
    headerRow.appendChild(frameHeader);

    motionPoints.forEach(point => {
        const pointHeader = document.createElement('th');
        pointHeader.textContent = `${point.id}. ${point.name}`;
        pointHeader.className = 'point-header';
        headerRow.appendChild(pointHeader);
    });
}

/**
 * モーションテーブルボディ更新（最適化版）
 */
function updateMotionTableBodyOptimized(tableBody) {
    // cameraDigitizeData から推定
    let frameCount = 0;
    try {
        const currentCamera = typeof getCurrentCamera === 'function' ? getCurrentCamera() : 'cam1';
        const camData = window.cameraDigitizeData && window.cameraDigitizeData[currentCamera];
        if (camData) {
            const keys = Object.keys(camData).map(Number).filter(n => !isNaN(n));
            if (keys.length > 0) frameCount = Math.max(...keys);
        }
    } catch (_) { }

    // 動画のフレーム数を優先使用
    if (projectData.settings && projectData.settings.motionFrameCount) {
        frameCount = projectData.settings.motionFrameCount;
    }

    // デフォルトフレーム数を設定
    if (frameCount <= 0) {
        frameCount = 100; // デフォルト100フレーム
    }


    // 動画のフレーム数分すべて表示
    const fragment = document.createDocumentFragment();

    for (let i = 1; i <= frameCount; i++) {
        const row = createTableRow(i);
        fragment.appendChild(row);
    }

    // --- スクロール位置の退避 ---
    const container = tableBody.closest('.table-container');
    const savedScrollTop = container ? container.scrollTop : 0;
    const savedScrollLeft = container ? container.scrollLeft : 0;

    tableBody.innerHTML = '';
    tableBody.appendChild(fragment);

    // --- スクロール位置の復元（再描画直後に行うことでガタつきを防止） ---
    if (container) {
        container.scrollTop = savedScrollTop;
        container.scrollLeft = savedScrollLeft;
    }

    // 貼り付け・選択機能を有効化
    initializeTableSelection();
}

/**
 * メモ化によるパフォーマンス改善
 */
function getMemoizedTableData(frameNumber, pointId) {
    const key = `${frameNumber}-${pointId}`;
    if (!memoizedTableData.has(key)) {
        let pointData = null;
        try {
            const currentCamera = typeof getCurrentCamera === 'function' ? getCurrentCamera() : 'cam1';
            const frameMap = (window.cameraDigitizeData && window.cameraDigitizeData[currentCamera])
                ? window.cameraDigitizeData[currentCamera][frameNumber]
                : null;
            if (frameMap && typeof frameMap.get === 'function') {
                pointData = frameMap.get(Number(pointId)) || null;
            }
        } catch (_) { pointData = null; }
        memoizedTableData.set(key, pointData);
    }
    return memoizedTableData.get(key);
}

/**
 * テーブル行作成のヘルパー関数（メモ化対応）
 */
function createTableRow(frameNumber) {
    const row = document.createElement('tr');

    const frameCell = document.createElement('td');
    frameCell.textContent = frameNumber;
    frameCell.className = 'frame-cell';
    row.appendChild(frameCell);

    motionPoints.forEach(point => {
        const pointCell = document.createElement('td');

        // data-point属性を追加（カメラ切り替え時のデータ表示用）
        pointCell.setAttribute('data-point', point.id);

        // メモ化されたデータを使用
        const pointData = getMemoizedTableData(frameNumber, point.id);

        if (pointData) {
            pointCell.textContent = `${Math.round(pointData.x)}, ${Math.round(pointData.y)}`;
            pointCell.classList.add('point-cell');
        } else {
            pointCell.textContent = '-';
            pointCell.classList.add('clickable-cell');
        }
        row.appendChild(pointCell);
    });

    return row;
}

/**
 * カメラ別データテーブル用の行作成関数（完全独立化対応）
 */
function createTableRowForCamera(frameNumber, camera) {
    const row = document.createElement('tr');

    const frameCell = document.createElement('td');
    frameCell.textContent = frameNumber;
    frameCell.className = 'frame-cell';
    row.appendChild(frameCell);

    motionPoints.forEach(point => {
        const pointCell = document.createElement('td');
        pointCell.setAttribute('data-point', point.id);

        // データの読み取りのみ（変更・上書きなし）
        let pointData = null;
        if (cameraDigitizeData[camera] && cameraDigitizeData[camera][frameNumber]) {
            const frameData = cameraDigitizeData[camera][frameNumber];
            // データ構造の違いに対応（Mapまたは通常のオブジェクト）
            if (frameData && typeof frameData === 'object') {
                if (frameData.get) {
                    // Mapの場合
                    pointData = frameData.get(point.id);
                } else {
                    // 通常のオブジェクトの場合
                    pointData = frameData[point.id];
                }
            }
        }

        if (pointData) {
            pointCell.textContent = `${Math.round(pointData.x)}, ${Math.round(pointData.y)}`;
            pointCell.classList.add('point-cell');
            if (pointData.__interpolated === true) {
                pointCell.classList.add('interpolated-cell');
            }
        } else {
            pointCell.textContent = '-';
            pointCell.classList.add('clickable-cell');
        }

        row.appendChild(pointCell);
    });

    return row;
}

/**
 * 特定のセルのみを更新する関数
 */
function updateDataTableCell(frameNumber, pointId, x, y) {
    const tableBody = document.getElementById('data-table-body');
    if (!tableBody) return;

    const currentMode = getCurrentMode();
    if (currentMode !== 'motion') return;

    // フレーム番号に対応する行を取得
    const rowIndex = frameNumber - 1;
    if (rowIndex < 0 || rowIndex >= tableBody.rows.length) return;

    const row = tableBody.rows[rowIndex];
    if (!row) return;

    // ポイントIDに対応するセルを取得
    const pointIndex = motionPoints.findIndex(p => p.id === pointId);
    if (pointIndex < 0 || pointIndex + 1 >= row.cells.length) return;

    const cell = row.cells[pointIndex + 1]; // +1はフレーム番号列を考慮

    // セルの内容を更新
    if (x !== null && y !== null) {
        cell.textContent = `${Math.round(x)}, ${Math.round(y)}`;
        cell.classList.add('point-cell');
        // 直接デジタイズ反映時は補間ハイライトを除去
        cell.classList.remove('interpolated-cell');
    } else {
        cell.textContent = '-';
        cell.classList.remove('point-cell');
    }
}

/**
 * カメラ別のモーションデータテーブル更新
 */
function updateMotionDataTableForCurrentCamera() {
    const currentCamera = getCurrentCamera();

    // cameraDigitizeData の存在のみで判定（fileState のチェックを削除）
    const hasData = window.cameraDigitizeData &&
        window.cameraDigitizeData[currentCamera] &&
        Object.keys(window.cameraDigitizeData[currentCamera]).length > 0;

    if (hasData) {
        // カメラ別データでテーブルを更新
        updateMotionDataTableWithCameraData(currentCamera);
    } else {
        // データがない場合はテーブルをクリア
        clearMotionDataTable();
    }

    // モーションタブのミニマップを更新
    setTimeout(() => {
        if (typeof updateMotionTabMinimap === 'function') {
            updateMotionTabMinimap();
        }
    }, 50);
}

/**
 * カメラ別の保存されたデータでモーションデータテーブルを更新（検証版）
 */
function updateMotionDataTableWithCameraData(camera) {

    // カメラ別データの詳細をログ出力

    if (cameraDigitizeData[camera]) {
        const frameCount = Object.keys(cameraDigitizeData[camera]).length;

        // 最初の3フレームのデータ詳細を表示
        const firstFrames = Object.keys(cameraDigitizeData[camera]).slice(0, 3);
        firstFrames.forEach(frameNum => {
            const frameData = cameraDigitizeData[camera][frameNum];
            if (frameData && typeof frameData === 'object') {
            }
        });
    } else {
    }

    // テーブルヘッダーを更新
    updateMotionTableHeader(document.getElementById('data-table-head'));

    // テーブルボディを更新
    const tableBody = document.getElementById('data-table-body');
    if (tableBody) {
        tableBody.innerHTML = '';
        // ハイライト状態をリセット（テーブル再構築後に再描画される）
        if (typeof resetTableHighlights === 'function') {
            setTimeout(() => resetTableHighlights(), 0);
        }

        // 動画の総フレーム数を使用（保存されたデータのフレーム数ではない）
        let totalFrames = projectData.settings.motionFrameCount;

        // motionFrameCount が0の場合、cameraDigitizeData からフレーム数を推定
        if (totalFrames <= 0 && cameraDigitizeData[camera]) {
            const frameKeys = Object.keys(cameraDigitizeData[camera]).map(Number).filter(n => !isNaN(n));
            if (frameKeys.length > 0) {
                totalFrames = Math.max(...frameKeys);
            }
        }

        if (totalFrames > 0) {
            let dataCount = 0;

            // 修正: createTableRowForCameraを使用してカメラ別データでテーブル作成
            for (let frameNumber = 1; frameNumber <= totalFrames; frameNumber++) {
                const row = createTableRowForCamera(frameNumber, camera);
                tableBody.appendChild(row);

                // データが設定されたセルの数をカウント
                const pointCells = row.querySelectorAll('.point-cell');
                dataCount += pointCells.length;
            }


            // 選択・貼り付け機能を有効化
            initializeTableSelection();
        }
    }

}

/**
 * モーションデータテーブルをクリア
 */
function clearMotionDataTable() {
    const tableHead = document.getElementById('data-table-head');
    const tableBody = document.getElementById('data-table-body');

    if (tableHead) {
        tableHead.innerHTML = '<th>フレーム</th>';
    }
    if (tableBody) {
        tableBody.innerHTML = '';
    }

}

/**
 * データテーブルクリア
 */
function clearDataTable() {
    const tableBody = document.getElementById('data-table-body');
    if (tableBody) {
        tableBody.innerHTML = '';
    }

    // メモ化キャッシュもクリア
    memoizedTableData.clear();
}

// ========================================
// キャリブレーションテーブル関連
// ========================================

/**
 * キャリブレーションデータテーブル更新関数（新規作成）
 */
function updateCalibrationDataTable() {
    const tableHead = document.getElementById('calibration-table-head');
    const tableBody = document.getElementById('calibration-table-body');

    if (!tableHead || !tableBody) {
        return;
    }

    // ヘッダー更新
    updateCalibrationTableHeader(tableHead);

    // ボディ更新
    updateCalibrationTableBody(tableBody);

    // セル選択機能を初期化
    initializeCalibrationTableSelection();
}

/**
 * キャリブレーションテーブルヘッダー更新
 */
function updateCalibrationTableHeader(tableHead) {
    tableHead.innerHTML = '';
    const headerRow = tableHead.insertRow();

    const method = document.getElementById('calibration-method').value;
    const isTwoCamera = method === '3d-dlt' || method === 'checkerboard' || method === '2d-dlt-stereo' || method === '3d-cc-method';
    const isThreeDim = method === '3d-dlt' || method === 'checkerboard' || method === '3d-cc-method';
    const isFourPoint = method === '4-point';

    // Calポイント列
    const calHeader = document.createElement('th');
    calHeader.textContent = 'Calポイント';
    headerRow.appendChild(calHeader);

    // カメラ1デジタイズ座標列
    const cam1DigitizeHeader = document.createElement('th');
    cam1DigitizeHeader.textContent = 'カメラ1デジタイズ座標(x,y)';
    headerRow.appendChild(cam1DigitizeHeader);

    // 2カメラモードの場合はカメラ2デジタイズ座標列も追加
    if (isTwoCamera) {
        const cam2DigitizeHeader = document.createElement('th');
        cam2DigitizeHeader.textContent = 'カメラ2デジタイズ座標(x,y)';
        headerRow.appendChild(cam2DigitizeHeader);
    }

    // 4点実長換算以外の場合のみ実空間座標列を追加
    if (!isFourPoint) {
        // 実空間座標列
        const realXHeader = document.createElement('th');
        realXHeader.textContent = '実空間座標(x)[m]';
        headerRow.appendChild(realXHeader);

        const realYHeader = document.createElement('th');
        realYHeader.textContent = '実空間座標(y)[m]';
        headerRow.appendChild(realYHeader);

        // 3D対応の場合はz座標も追加
        if (isThreeDim) {
            const realZHeader = document.createElement('th');
            realZHeader.textContent = '実空間座標(z)[m]';
            headerRow.appendChild(realZHeader);
        }

        // 誤差列
        const errorXHeader = document.createElement('th');
        errorXHeader.textContent = '誤差(x)';
        headerRow.appendChild(errorXHeader);

        const errorYHeader = document.createElement('th');
        errorYHeader.textContent = '誤差(y)';
        headerRow.appendChild(errorYHeader);

        // 3D対応の場合はz誤差も追加
        if (isThreeDim) {
            const errorZHeader = document.createElement('th');
            errorZHeader.textContent = '誤差(z)';
            headerRow.appendChild(errorZHeader);
        }
    }

    // 削除列（常に表示）
    const deleteHeader = document.createElement('th');
    deleteHeader.textContent = '削除';
    deleteHeader.className = 'delete-column-header';
    deleteHeader.style.width = '50px';
    headerRow.appendChild(deleteHeader);
}

/**
 * キャリブレーションテーブルボディ更新
 */
function updateCalibrationTableBody(tableBody) {
    tableBody.innerHTML = '';

    const method = document.getElementById('calibration-method').value;
    const isTwoCamera = method === '3d-dlt' || method === 'checkerboard' || method === '2d-dlt-stereo' || method === '3d-cc-method';
    const isThreeDim = method === '3d-dlt' || method === 'checkerboard' || method === '3d-cc-method';
    const isFourPoint = method === '4-point';
    // 2D DLT法も実空間座標がメートル単位なので、誤差もメートル基準で色分け
    const useMeterUnit = ['3d-dlt', 'checkerboard', '3d-cc-method', '2d-dlt-stereo', '2d-dlt-single'].includes(method);

    calibrationData.points.forEach((point, index) => {
        // realCoordsが存在しない場合は初期化
        if (!point.realCoords) {
            point.realCoords = { x: null, y: null, z: null };
        }

        // errorsオブジェクトの初期化
        if (!point.errors) {
            point.errors = { x: null, y: null, z: null };
        }

        const row = tableBody.insertRow();
        row.style.cursor = 'pointer'; // カーソルをポインタに変更

        // 行クリックイベント
        row.addEventListener('click', (e) => {
            // 入力フィールドのクリックは除外
            if (e.target.tagName === 'INPUT') return;
            handleCalibrationRowClick(point);
        });

        // 現在選択中のCalポイントかどうかチェック
        if (getSelectedLandmark() && getSelectedLandmark().id === point.id) {
            row.classList.add('current-calibration-row');
        }

        // Calポイント名
        const calCell = row.insertCell();
        calCell.classList.add('read-only-cell');
        // point.nameが存在する場合はそれを使用、存在しない場合はpoint.idを使用
        calCell.textContent = point.name || point.id;

        // カメラ1デジタイズ座標
        const cam1DigitizeCell = row.insertCell();
        cam1DigitizeCell.classList.add('read-only-cell');
        if (point.digitizedCoords && point.digitizedCoords.cam1 &&
            point.digitizedCoords.cam1.x !== null && point.digitizedCoords.cam1.y !== null) {
            cam1DigitizeCell.textContent = `${Math.round(point.digitizedCoords.cam1.x)}, ${Math.round(point.digitizedCoords.cam1.y)}`;
        } else {
            cam1DigitizeCell.textContent = '';
        }

        // 2カメラモードの場合はカメラ2デジタイズ座標も追加
        if (isTwoCamera) {
            const cam2DigitizeCell = row.insertCell();
            cam2DigitizeCell.classList.add('read-only-cell');
            if (point.digitizedCoords && point.digitizedCoords.cam2 &&
                point.digitizedCoords.cam2.x !== null && point.digitizedCoords.cam2.y !== null) {
                cam2DigitizeCell.textContent = `${Math.round(point.digitizedCoords.cam2.x)}, ${Math.round(point.digitizedCoords.cam2.y)}`;
            } else {
                cam2DigitizeCell.textContent = '';
            }
        }

        // 4点実長換算以外の場合のみ実空間座標と誤差列を追加
        if (!isFourPoint) {
            // 実空間座標X（編集可能セル）
            const realXCell = row.insertCell();
            realXCell.textContent = (point.realCoords.x !== null && point.realCoords.x !== undefined && point.realCoords.x !== '') ? point.realCoords.x : '';
            realXCell.className = 'real-coord-cell editable-cell';
            realXCell.dataset.pointId = point.id;
            realXCell.dataset.coordType = 'x';
            realXCell.dataset.editable = 'true';
            realXCell.tabIndex = 0;

            // 実空間座標Y（編集可能セル）
            const realYCell = row.insertCell();
            realYCell.textContent = (point.realCoords.y !== null && point.realCoords.y !== undefined && point.realCoords.y !== '') ? point.realCoords.y : '';
            realYCell.className = 'real-coord-cell editable-cell';
            realYCell.dataset.pointId = point.id;
            realYCell.dataset.coordType = 'y';
            realYCell.dataset.editable = 'true';
            realYCell.tabIndex = 0;

            // 3D対応の場合はz座標も追加（編集可能セル）
            if (isThreeDim) {
                const realZCell = row.insertCell();
                realZCell.textContent = (point.realCoords.z !== null && point.realCoords.z !== undefined && point.realCoords.z !== '') ? point.realCoords.z : '';
                realZCell.className = 'real-coord-cell editable-cell';
                realZCell.dataset.pointId = point.id;
                realZCell.dataset.coordType = 'z';
                realZCell.dataset.editable = 'true';
                realZCell.tabIndex = 0;
            }

            // 誤差
            const errorXCell = row.insertCell();
            errorXCell.classList.add('read-only-cell');
            if (point.errors.x !== null && point.errors.x !== undefined) {
                errorXCell.textContent = point.errors.x.toFixed(5);
                errorXCell.className = getCalibrationErrorClass(point.errors.x, useMeterUnit ? 'm' : 'px');
            } else {
                errorXCell.textContent = '';
            }

            const errorYCell = row.insertCell();
            errorYCell.classList.add('read-only-cell');
            if (point.errors.y !== null && point.errors.y !== undefined) {
                errorYCell.textContent = point.errors.y.toFixed(5);
                errorYCell.className = getCalibrationErrorClass(point.errors.y, useMeterUnit ? 'm' : 'px');
            } else {
                errorYCell.textContent = '';
            }

            // 3D対応の場合はz誤差も追加（X/Yと同じ小数表示・色分けを適用）
            if (isThreeDim) {
                const errorZCell = row.insertCell();
                errorZCell.classList.add('read-only-cell');
                if (point.errors.z !== null && point.errors.z !== undefined) {
                    errorZCell.textContent = point.errors.z.toFixed(5);
                    errorZCell.className = getCalibrationErrorClass(point.errors.z, useMeterUnit ? 'm' : 'px');
                } else {
                    errorZCell.textContent = '';
                }
            }
        }

        // 削除ボタンセル（常に追加）
        const deleteCell = row.insertCell();
        deleteCell.className = 'delete-cell';
        deleteCell.style.textAlign = 'center';
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-delete-row';
        deleteBtn.textContent = '×';
        deleteBtn.title = `${point.name || point.id} を削除`;
        deleteBtn.dataset.pointId = point.id;
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 行クリックイベントを阻止
            if (typeof window.deleteCalibrationPoint === 'function') {
                window.deleteCalibrationPoint(point.id);
            }
        });
        deleteCell.appendChild(deleteBtn);
    });
}

/**
 * 誤差値に応じたCSSクラス名を返す
 * @param {number} errorValue 誤差の値
 * @param {string} unit 単位 ('m' = メートル基準, 'px' = ピクセル基準など)
 * @returns {string} CSSクラス名
 */
function getCalibrationErrorClass(errorValue, unit = 'm') {
    if (errorValue === null || errorValue === undefined || isNaN(errorValue)) return '';

    const absVal = Math.abs(errorValue);

    // 実空間 (メートル) 基準の閾値
    // < 0.02m (2cm) : 緑 (low)
    // < 0.05m (5cm) : 黄色 (medium)
    // >= 0.05m      : 赤 (high)
    if (unit === 'm') {
        if (absVal < 0.02) return 'low-error';
        if (absVal < 0.05) return 'medium-error';
        return 'high-error';
    }

    // ピクセル等、その他の基準のフォールバック
    if (absVal < 10) return 'low-error';
    if (absVal < 50) return 'medium-error';
    return 'high-error';
}

// ========================================
// テーブルハイライト機能
// ========================================

// Excel風選択拡張のためのアンカー/アクティブ状態
let activeCellPos = { row: 0, col: 0 };
let anchorCellPos = null; // { row, col } または null

function getTableBodies() {
    const table = document.getElementById('data-table');
    if (!table) return { table: null, tbody: null };
    const tbody = table.querySelector('tbody');
    return { table, tbody };
}

function clampCellPos(row, col) {
    const { tbody } = getTableBodies();
    const maxRow = Math.max(0, (tbody?.rows.length || 1) - 1);
    const maxCol = Math.max(0, ((tbody?.rows[0]?.cells.length) || 1) - 1);
    return { row: Math.max(0, Math.min(maxRow, row)), col: Math.max(0, Math.min(maxCol, col)) };
}

function focusCell(row, col) {
    const { tbody } = getTableBodies();
    const r = tbody?.rows[row];
    const cell = r?.cells[col];
    if (cell) {
        try { cell.focus(); } catch (_) { }
        activeCellPos = { row, col };
    }
}

function selectRange(anchor, active) {
    clearTableSelection();
    const minRow = Math.min(anchor.row, active.row);
    const maxRow = Math.max(anchor.row, active.row);
    const minCol = Math.min(anchor.col, active.col);
    const maxCol = Math.max(anchor.col, active.col);

    // 最適化: 直接IDを生成（addCellToSelectionを使わない）
    for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
            tableSelection.selectedCells.add(`${r}-${c}`);
        }
    }

    updateSelectionHighlight();
}

function selectEntireColumn(colIndex) {
    const { tbody } = getTableBodies();
    if (!tbody) return;
    clearTableSelection();

    // フルカラム選択フラグを立てる
    isFullColumnSelection = true;

    // 最適化: addCellToSelectionを使わずに直接IDを生成（O(n)）
    const rowCount = tbody.rows.length;
    for (let r = 0; r < rowCount; r++) {
        if (tbody.rows[r]?.cells[colIndex]) {
            tableSelection.selectedCells.add(`${r}-${colIndex}`);
        }
    }

    updateSelectionHighlight();
    anchorCellPos = { row: 0, col: colIndex };
    activeCellPos = { row: Math.max(0, rowCount - 1), col: colIndex };
    focusCell(0, colIndex);
}

function selectEntireRow(rowIndex) {
    const { tbody } = getTableBodies();
    if (!tbody) return;
    const row = tbody.rows[rowIndex];
    if (!row) return;
    clearTableSelection();

    // 最適化: 直接IDを生成（addCellToSelectionを使わない）
    const cellCount = row.cells.length;
    for (let c = 0; c < cellCount; c++) {
        tableSelection.selectedCells.add(`${rowIndex}-${c}`);
    }

    updateSelectionHighlight();
    anchorCellPos = { row: rowIndex, col: 0 };
    activeCellPos = { row: rowIndex, col: Math.max(0, cellCount - 1) };
    focusCell(rowIndex, 0);
}

/**
 * テーブル全体を選択（左上コーナークリック用）
 */
function selectAll() {
    const { tbody } = getTableBodies();
    if (!tbody) return;

    const rowCount = tbody.rows.length;
    if (rowCount === 0) return;
    const colCount = tbody.rows[0].cells.length;
    if (colCount === 0) return;

    clearTableSelection();

    // 全セルを選択
    for (let r = 0; r < rowCount; r++) {
        for (let c = 0; c < colCount; c++) {
            tableSelection.selectedCells.add(`${r}-${c}`);
        }
    }

    updateSelectionHighlight();
    anchorCellPos = { row: 0, col: 0 };
    activeCellPos = { row: rowCount - 1, col: colCount - 1 };
    focusCell(0, 0);
}

function makeDataCellsFocusable() {
    const { tbody } = getTableBodies();
    if (!tbody) return;

    // 最適化: querySelectorAllを避けて直接行/セルをイテレート
    const rows = tbody.rows;
    for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].cells;
        for (let j = 0; j < cells.length; j++) {
            cells[j].tabIndex = 0;
        }
    }
}

function handleDataTableClick(event) {
    const cell = event.target.closest('td');
    if (!cell) return;
    const { tbody } = getTableBodies();
    if (!tbody) return;

    // 最適化: Array.from().indexOf() を避けて直接プロパティを使用
    const rowElement = cell.parentElement;
    const row = rowElement.sectionRowIndex; // tbody内の行インデックス
    const col = cell.cellIndex; // 行内のセルインデックス

    // 行ヘッダ（frame-cell）は行一括選択で処理
    if (cell.classList.contains('frame-cell')) return;

    // --- ここから追加: クリックによるモード・フレーム・ポイント切り替え ---
    const currentMode = (typeof getCurrentMode === 'function') ? getCurrentMode() : null;

    // 1. ポイント選択 (列番号 - 1 がポイントインデックス)
    // 列0はフレーム番号なので、列1がポイント0
    const pointIndex = col - 1;
    if (pointIndex >= 0 && window.motionPoints && pointIndex < window.motionPoints.length) {
        const targetPoint = window.motionPoints[pointIndex];
        if (typeof setSelectedLandmark === 'function') {
            setSelectedLandmark(targetPoint);
        }
        // UI（プルダウン等）の同期
        const motionSelect = document.getElementById('motion-landmark-select');
        if (motionSelect) {
            motionSelect.value = targetPoint.id;
            // 変更イベントが必要な場合は発火（通常はsetSelectedLandmarkで足りるが念のため）
            if (typeof onMotionLandmarkChange === 'function') {
                // onMotionLandmarkChange内でsetSelectedLandmarkを呼んでいる場合は無限ループに注意
                // ここではUI同期のみ意図
            }
        }
    }

    // 2. フレーム移動 (行番号 + 1)
    const targetFrame = row + 1;
    if (typeof setCurrentFrameNumber === 'function' && typeof getCurrentFrameNumber === 'function') {
        if (getCurrentFrameNumber() !== targetFrame) {
            setCurrentFrameNumber(targetFrame);
            if (typeof updateFrameInfo === 'function') updateFrameInfo();
            // 少し遅延させて描画更新（モード切り替え直後の安定性のため）
            setTimeout(() => {
                if (typeof displayCurrentFrame === 'function') displayCurrentFrame();
            }, 10);
        }
    }

    // --- 追加：行列を一時保存し、初期化後に再度クリックしたことにする ---
    // 3. モーションモードでない場合は切り替え
    if (currentMode !== 'motion') {
        const motionRadio = document.getElementById('motion');
        if (motionRadio) {
            motionRadio.checked = true;
            motionRadio.dispatchEvent(new Event('change'));
        }

        // テーブル再描画待ちして選択状態とフォーカスを再現
        const _savedRow = row, _savedCol = col;
        setTimeout(() => {
            const newTable = document.getElementById('data-table');
            const newTbody = newTable ? newTable.querySelector('tbody') : null;

            if (newTbody && newTbody.rows[_savedRow] && newTbody.rows[_savedRow].cells[_savedCol]) {
                const newCell = newTbody.rows[_savedRow].cells[_savedCol];

                // 選択状態をクリアし、保存した位置のセルを選択
                clearTableSelection();
                addCellToSelection(newCell);
                updateSelectionHighlight();

                // ハイライト表示（オレンジの枠線など）を更新
                if (typeof updateTableHighlights === 'function') updateTableHighlights();

                // フォーカスと位置情報の更新
                anchorCellPos = { row: _savedRow, col: _savedCol };
                activeCellPos = { row: _savedRow, col: _savedCol };
                focusCell(_savedRow, _savedCol);
            }
        }, 50); // DOM更新時間を考慮して50ms待機

        return;
    }

    if (event.shiftKey && anchorCellPos) {
        const clamped = clampCellPos(row, col);
        activeCellPos = clamped;
        focusCell(clamped.row, clamped.col);
        selectRange(anchorCellPos, activeCellPos);
        return;
    }
    clearTableSelection();
    addCellToSelection(cell);
    updateSelectionHighlight();
    if (typeof updateTableHighlights === 'function') updateTableHighlights(); // 通常時も呼び出し
    anchorCellPos = { row, col };
    activeCellPos = { row, col };
    focusCell(row, col);
}


// ヘッダー選択状態管理用（列）
let isHeaderDragging = false;
let headerDragStartCol = -1;

// 行選択状態管理用
let isRowDragging = false;
let rowDragStartRow = -1;

function setupColumnRowHeaderSelection() {
    const { table, tbody } = getTableBodies();
    if (!table) return;
    const thead = table.querySelector('thead');
    if (thead) {
        // --- 左上コーナークリックで全選択 ---
        thead.addEventListener('click', (e) => {
            const th = e.target.closest('th');
            if (!th) return;
            // 最初のthで、point-headerクラスがなければコーナー（フレームヘッダー）
            const ths = thead.querySelectorAll('th');
            if (ths[0] === th && !th.classList.contains('point-header')) {
                selectAll();
                e.preventDefault();
                e.stopPropagation();
            }
        });

        // --- カラムヘッダーのドラッグ選択実装 ---
        thead.addEventListener('mousedown', (e) => {
            const th = e.target.closest('th.point-header');
            if (!th) return;
            const ths = thead.querySelectorAll('th');
            let colIndex = -1;
            for (let i = 0; i < ths.length; i++) {
                if (ths[i] === th) { colIndex = i; break; }
            }

            if (colIndex >= 0) {
                isHeaderDragging = true;
                headerDragStartCol = colIndex;
                // まずは単一列選択
                selectEntireColumn(colIndex);
                e.preventDefault(); // テキスト選択防止
            }
        });

        thead.addEventListener('mousemove', (e) => {
            if (!isHeaderDragging) return;
            const th = e.target.closest('th.point-header');
            if (!th) return;
            const ths = Array.from(thead.querySelectorAll('th'));
            const colIndex = ths.indexOf(th);

            if (colIndex >= 0) {
                // 開始列から現在列までの範囲を選択
                selectColumnRange(headerDragStartCol, colIndex);
            }
        });

        document.addEventListener('mouseup', () => {
            isHeaderDragging = false;
            headerDragStartCol = -1;
        });
        // --- 列選択実装終了 ---
    }

    // --- 行ヘッダー（フレームセル）のドラッグ選択実装 ---
    if (tbody) {
        tbody.addEventListener('mousedown', (e) => {
            const cell = e.target.closest('td.frame-cell');
            if (!cell) return;

            const row = cell.parentElement;
            const rowIndex = Array.from(tbody.rows).indexOf(row);

            if (rowIndex >= 0) {
                isRowDragging = true;
                rowDragStartRow = rowIndex;
                selectEntireRow(rowIndex);
                e.preventDefault();
            }
        });

        tbody.addEventListener('mousemove', (e) => {
            if (!isRowDragging) return;
            const cell = e.target.closest('td.frame-cell');
            if (!cell) return;

            const row = cell.parentElement;
            const rowIndex = Array.from(tbody.rows).indexOf(row);

            if (rowIndex >= 0) {
                selectRowRange(rowDragStartRow, rowIndex);
            }
        });

        document.addEventListener('mouseup', () => {
            isRowDragging = false;
            rowDragStartRow = -1;
        });
    }
    // --- 行選択実装終了 ---
}

/**
 * 列の範囲選択（開始列から終了列まで）
 */
function selectColumnRange(startCol, endCol) {
    clearTableSelection();

    // フルカラム選択フラグを立てる
    isFullColumnSelection = true;

    // min, maxを計算
    const min = Math.min(startCol, endCol);
    const max = Math.max(startCol, endCol);

    const { tbody } = getTableBodies();
    if (!tbody) return;

    // 最適化: Array.from を避けて直接イテレート
    const rows = tbody.rows;
    const rowCount = rows.length;
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const row = rows[rowIndex];
        for (let c = min; c <= max; c++) {
            if (row.cells[c]) {
                tableSelection.selectedCells.add(`${rowIndex}-${c}`);
            }
        }
    }

    updateSelectionHighlight();
}

/**
 * 行の範囲選択（開始行から終了行まで）
 */
function selectRowRange(startRow, endRow) {
    clearTableSelection();

    const min = Math.min(startRow, endRow);
    const max = Math.max(startRow, endRow);

    const { tbody } = getTableBodies();
    if (!tbody) return;

    const rows = tbody.rows;
    if (rows.length === 0) return;
    const colCount = rows[0].cells.length;

    for (let rowIndex = min; rowIndex <= max; rowIndex++) {
        for (let c = 0; c < colCount; c++) {
            tableSelection.selectedCells.add(`${rowIndex}-${c}`);
        }
    }

    updateSelectionHighlight();
    anchorCellPos = { row: min, col: 0 };
    activeCellPos = { row: max, col: colCount - 1 };
}

// 前回のハイライト状態を追跡（差分更新用）
let lastHighlightedFrameRow = -1;
let lastHighlightedColIndex = -1;

/**
 * ハイライト専用の更新関数（両テーブル対応）- 最適化版
 * @param {boolean} forceUpdate - trueの場合、差分チェックを無視して強制的に更新
 */
function updateTableHighlights(forceUpdate = false) {
    const getCurrentModeFunc = window.getCurrentMode || getCurrentMode;
    const getCurrentFrameNumberFunc = window.getCurrentFrameNumber || getCurrentFrameNumber;
    const getSelectedLandmarkFunc = window.getSelectedLandmark || getSelectedLandmark;

    const currentMode = typeof getCurrentModeFunc === 'function' ? getCurrentModeFunc() : 'calibration';
    const currentFrame = typeof getCurrentFrameNumberFunc === 'function' ? getCurrentFrameNumberFunc() : 1;
    const selectedLandmark = typeof getSelectedLandmarkFunc === 'function' ? getSelectedLandmarkFunc() : null;

    // キャリブレーションテーブルのハイライト処理（行数少ないので最適化不要）
    const calibrationTableBody = document.getElementById('calibration-table-body');
    if (calibrationTableBody) {
        const rows = calibrationTableBody.rows;
        for (let i = 0; i < rows.length; i++) {
            rows[i].classList.remove('current-calibration-row');
        }
        if (currentMode === 'calibration' && selectedLandmark && calibrationData.points.length > 0) {
            const pointIndex = calibrationData.points.findIndex(p => p.id === selectedLandmark.id);
            if (pointIndex >= 0 && pointIndex < rows.length) {
                rows[pointIndex].classList.add('current-calibration-row');
            }
        }
    }

    // モーションデータテーブルのハイライト処理（差分更新）
    const dataTableBody = document.getElementById('data-table-body');
    if (!dataTableBody) return;

    const rows = dataTableBody.rows;
    const rowCount = rows.length;
    if (rowCount === 0) return;

    // 現在のフレーム行インデックス (0-based)
    const newFrameRowIndex = (currentMode === 'motion' && currentFrame > 0 && currentFrame <= rowCount)
        ? currentFrame - 1 : -1;

    // 現在のポイント列インデックス
    let newColIndex = -1;
    if (currentMode === 'motion' && selectedLandmark) {
        const pointIndex = motionPoints.findIndex(p => p.id === selectedLandmark.id);
        if (pointIndex >= 0) {
            newColIndex = pointIndex + 1; // 0列目はフレーム番号
        }
    }

    // --- 差分更新: フレーム行 ---
    if (forceUpdate || lastHighlightedFrameRow !== newFrameRowIndex) {
        // 前回のハイライトを解除
        if (lastHighlightedFrameRow >= 0 && lastHighlightedFrameRow < rowCount) {
            rows[lastHighlightedFrameRow].classList.remove('current-frame-row');
        }
        // 新しいハイライトを設定
        if (newFrameRowIndex >= 0) {
            rows[newFrameRowIndex].classList.add('current-frame-row');
        }
        lastHighlightedFrameRow = newFrameRowIndex;
    }

    // --- 差分更新: ポイント列 ---
    if (forceUpdate || lastHighlightedColIndex !== newColIndex) {
        // 前回のハイライトを解除
        if (lastHighlightedColIndex >= 0) {
            for (let i = 0; i < rowCount; i++) {
                const cell = rows[i].cells[lastHighlightedColIndex];
                if (cell) cell.classList.remove('selected-point-cell');
            }
        }
        // 新しいハイライトを設定
        if (newColIndex >= 0) {
            for (let i = 0; i < rowCount; i++) {
                const cell = rows[i].cells[newColIndex];
                if (cell) cell.classList.add('selected-point-cell');
            }
        }
        lastHighlightedColIndex = newColIndex;
    }
}

/**
 * ハイライト状態をリセットし、強制的に再描画
 */
function resetTableHighlights() {
    lastHighlightedFrameRow = -1;
    lastHighlightedColIndex = -1;
    updateTableHighlights(true);
}


// ========================================
// Excel風テーブル選択・コピペ機能
// ========================================

/**
 * テーブル選択機能の初期化
 */
function initializeTableSelection() {
    const dataTable = document.getElementById('data-table');
    if (!dataTable) return;

    // 既存のイベントリスナーを削除
    dataTable.removeEventListener('mousedown', handleTableMouseDown);
    dataTable.removeEventListener('mousemove', handleTableMouseMove);
    dataTable.removeEventListener('mouseup', handleTableMouseUp);

    // 新しいイベントリスナーを追加
    dataTable.addEventListener('mousedown', handleTableMouseDown);
    dataTable.addEventListener('mousemove', handleTableMouseMove);
    dataTable.addEventListener('mouseup', handleTableMouseUp);

    // ドラッグによる文字選択を無効化
    dataTable.style.userSelect = 'none';
    dataTable.style.webkitUserSelect = 'none';
    dataTable.style.mozUserSelect = 'none';
    dataTable.style.msUserSelect = 'none';

    // キーボードイベントリスナーを追加（Ctrl+C/Ctrl+V対応・重複防止）
    document.removeEventListener('keydown', handleTableKeyDown);
    document.addEventListener('keydown', handleTableKeyDown);

    // ウィンドウリサイズ時の境界線再描画
    window.addEventListener('resize', debounce(updateSelectionHighlight, 100));

    // テーブルスクロール時の境界線再描画
    const tableContainer = dataTable.closest('.table-container');
    if (tableContainer) {
        tableContainer.addEventListener('scroll', debounce(updateSelectionHighlight, 50));
    }

    // 右クリックメニュー（補間）
    try {
        dataTable.addEventListener('contextmenu', (e) => {
            e.preventDefault();

            // 座標ベースでセルを特定
            let cell = e.target.closest && e.target.closest('td');
            if (!cell) {
                const el = document.elementFromPoint(e.clientX, e.clientY);
                if (el && el.closest) cell = el.closest('td');
            }

            if (!cell) {
                showInterpolationMenu(e.clientX, e.clientY);
                return;
            }

            if (cell.cellIndex === 0) {
                showInterpolationMenu(e.clientX, e.clientY);
                return;
            }

            // 右クリック位置に選択を同期（そのセルが未選択なら単独選択に切り替え）
            const cellId = getCellId(cell);
            if (!tableSelection.selectedCells.has(cellId)) {
                clearTableSelection();
                addCellToSelection(cell);
                const pos = getCellPosition(cell);
                anchorCellPos = { row: pos.row, col: pos.col };
                activeCellPos = { row: pos.row, col: pos.col };
                updateSelectionHighlight();
            }

            // 選択範囲ログ
            try {
                if (tableSelection.selectedCells.size > 0) {
                    let minRow = Infinity, maxRow = -Infinity;
                    let minCol = Infinity, maxCol = -Infinity;
                    tableSelection.selectedCells.forEach(id => {
                        const [r, c] = id.split('-').map(Number);
                        minRow = Math.min(minRow, r);
                        maxRow = Math.max(maxRow, r);
                        minCol = Math.min(minCol, c);
                        maxCol = Math.max(maxCol, c);
                    });
                    const dataMinCol = Math.max(1, minCol);
                    const dataMaxCol = Math.max(1, maxCol);
                    const rangeText = `rows ${minRow + 1}-${maxRow + 1}, cols ${minCol}-${maxCol} (data-cols ${dataMinCol}-${dataMaxCol})`;
                }
            } catch (logErr) { }

            showInterpolationMenu(e.clientX, e.clientY);
        });
    } catch (_) { }

    // 追加: セルフォーカス可能化とヘッダ/行見出しクリック選択
    makeDataCellsFocusable();
    setupColumnRowHeaderSelection();

    // 追加: セルクリック（Shift+クリック対応）
    const tbody = dataTable.querySelector('tbody');
    if (tbody) {
        tbody.removeEventListener('click', handleDataTableClick);
        tbody.addEventListener('click', handleDataTableClick);
    }

    // 初期アンカー/アクティブ（フレーム列1つ右の最初のポイント列）
    anchorCellPos = { row: 0, col: 1 };
    activeCellPos = { row: 0, col: 1 };
    focusCell(0, 1);
}

// 簡易コンテキストメニュー
function showInterpolationMenu(x, y) {
    hideInterpolationMenu();
    const menu = document.createElement('div');
    menu.id = 'interp-menu';
    menu.style.position = 'fixed';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.background = '#fff';
    menu.style.border = '1px solid #ccc';
    menu.style.zIndex = 10000;
    menu.style.padding = '6px 10px';
    menu.style.cursor = 'pointer';
    menu.textContent = '補間（スプライン）';
    menu.addEventListener('click', () => {
        try { performSplineInterpolationOnSelection(); } catch (_) { }
        hideInterpolationMenu();
    });
    document.body.appendChild(menu);
    const onDismiss = (ev) => {
        if (!menu.contains(ev.target)) {
            hideInterpolationMenu();
            document.removeEventListener('mousedown', onDismiss);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', onDismiss), 0);
}

function hideInterpolationMenu() {
    const el = document.getElementById('interp-menu');
    if (el) el.remove();
}

// 選択範囲に対してスプライン補間（自然三次）を実行
function performSplineInterpolationOnSelection() {
    if (tableSelection.selectedCells.size === 0) {
        try { if (typeof showMessage === 'function') showMessage('補間できません: セルが選択されていません'); } catch (_) { }
        return;
    }
    const { tbody } = getTableBodies();
    if (!tbody) return;
    // 列ごとに処理（同一ポイント列）
    const byCol = new Map(); // col -> rows[]
    tableSelection.selectedCells.forEach(cellId => {
        const [rowIndex, colIndex] = cellId.split('-').map(Number);
        if (colIndex === 0) return;
        if (!byCol.has(colIndex)) byCol.set(colIndex, []);
        byCol.get(colIndex).push(rowIndex);
    });
    const currentCam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';

    if (byCol.size === 0) {
        try { if (typeof showMessage === 'function') showMessage('補間できません: フレーム列のみが選択されています'); } catch (_) { }
        return;
    }

    // 補間対象のデータを事前計算（バックアップ + 補間値）
    const changes = []; // { frame, pid, oldValue(null|{x,y,...}), newValue({x,y,__interpolated:true}) }

    let totalColumns = 0;
    let totalInterpolatedColumns = 0;
    let skippedNotEnoughKnown = 0;
    let skippedNoBlanks = 0;
    let skippedNoCamData = 0;

    byCol.forEach((rows, colIndex) => {
        totalColumns++;
        rows.sort((a, b) => a - b);
        const pointIndex = colIndex - 1;
        const point = window.motionPoints && window.motionPoints[pointIndex];
        if (!point) return;
        const pid = point.id;

        const startRow = rows[0];
        const endRow = rows[rows.length - 1];
        const camStore = window.cameraDigitizeData && window.cameraDigitizeData[currentCam] ? window.cameraDigitizeData[currentCam] : null;
        if (!camStore) {
            skippedNoCamData++;
            return;
        }

        // 既知サンプル抽出
        const xs = [], ux = [], uy = [];
        const allFrames = Object.keys(camStore).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        const minF = allFrames.length ? allFrames[0] : (startRow + 1);
        const maxF = allFrames.length ? allFrames[allFrames.length - 1] : (endRow + 1);
        for (let f = minF; f <= maxF; f++) {
            const entry = camStore[f];
            const c = entry && entry.get && entry.get(pid);
            if (c && c.__interpolated !== true && Number.isFinite(c.x) && Number.isFinite(c.y)) {
                xs.push(f);
                ux.push(c.x);
                uy.push(c.y);
            }
        }
        if (xs.length < 2) {
            skippedNotEnoughKnown++;
            return;
        }

        // ブランクセル確認
        let blankCountInRange = 0;
        for (let r = startRow; r <= endRow; r++) {
            const f = r + 1;
            const entry = window.cameraDigitizeData[currentCam][f];
            const c = entry && entry.get && entry.get(pid);
            if (!(c && Number.isFinite(c.x) && Number.isFinite(c.y))) blankCountInRange++;
        }
        if (blankCountInRange === 0) {
            skippedNoBlanks++;
            return;
        }

        // スプライン係数作成
        const sx = buildNaturalCubicSpline(xs, ux);
        const sy = buildNaturalCubicSpline(xs, uy);

        // 書き込み対象を収集
        for (let r = startRow; r <= endRow; r++) {
            const f = r + 1;
            const entry = window.cameraDigitizeData[currentCam][f];
            const c = entry && entry.get && entry.get(pid);
            const hasManual = c && c.__interpolated !== true && Number.isFinite(c.x) && Number.isFinite(c.y);
            if (hasManual) continue;
            const ix = evalSplineAt(sx, f);
            const iy = evalSplineAt(sy, f);
            changes.push({
                frame: f,
                pid: pid,
                oldValue: c ? { ...c } : null,
                newValue: { x: ix, y: iy, __interpolated: true }
            });
        }
        totalInterpolatedColumns++;
    });

    if (changes.length === 0) {
        const summary = [
            `補間対象列: ${totalColumns}`,
            `既知点不足: ${skippedNotEnoughKnown}`,
            `空白なし: ${skippedNoBlanks}`,
            `カメラ未設定: ${skippedNoCamData}`
        ].join(' / ');
        try { if (typeof showMessage === 'function') showMessage(`スプライン補間: 補間できるセルがありませんでした (${summary})`); } catch (_) { }
        return;
    }

    // Undo対応コマンド作成
    const cam = currentCam;
    const command = {
        description: `スプライン補間 (${changes.length}セル)`,
        execute: () => {
            changes.forEach(ch => {
                if (!window.cameraDigitizeData[cam][ch.frame]) window.cameraDigitizeData[cam][ch.frame] = new Map();
                window.cameraDigitizeData[cam][ch.frame].set(ch.pid, ch.newValue);
            });
            if (typeof window.clearMemoizedTableData === 'function') window.clearMemoizedTableData();
            if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera();
            if (typeof window.redrawCanvas === 'function') window.redrawCanvas();
        },
        undo: () => {
            changes.forEach(ch => {
                const store = window.cameraDigitizeData[cam];
                if (!store || !store[ch.frame]) return;
                if (ch.oldValue === null) {
                    // 元々データなし → 削除
                    if (store[ch.frame] instanceof Map) store[ch.frame].delete(ch.pid);
                    else delete store[ch.frame][ch.pid];
                } else {
                    // 元のデータに復元
                    if (store[ch.frame] instanceof Map) store[ch.frame].set(ch.pid, ch.oldValue);
                    else store[ch.frame][ch.pid] = ch.oldValue;
                }
            });
            if (typeof window.clearMemoizedTableData === 'function') window.clearMemoizedTableData();
            if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera();
            if (typeof window.redrawCanvas === 'function') window.redrawCanvas();
        }
    };

    if (window.undoManager) {
        window.undoManager.execute(command);
    } else {
        command.execute();
    }

    // 結果表示
    const summary = [
        `補間対象列: ${totalColumns}`,
        `補間成功列: ${totalInterpolatedColumns}`,
        `埋めたセル: ${changes.length}`,
        `既知点不足: ${skippedNotEnoughKnown}`,
        `空白なし: ${skippedNoBlanks}`,
        `カメラ未設定: ${skippedNoCamData}`
    ].join(' / ');
    try { if (typeof showMessage === 'function') showMessage(`スプライン補間: ${summary}`); } catch (_) { }
}

// 自然三次スプラインのビルド
function buildNaturalCubicSpline(xs, ys) {
    const n = xs.length;
    const a = ys.slice();
    const h = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) h[i] = xs[i + 1] - xs[i];
    const al = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) al[i] = (3 / h[i]) * (a[i + 1] - a[i]) - (3 / h[i - 1]) * (a[i] - a[i - 1]);
    const l = new Array(n).fill(0), mu = new Array(n).fill(0), z = new Array(n).fill(0);
    l[0] = 1; mu[0] = 0; z[0] = 0;
    for (let i = 1; i < n - 1; i++) {
        l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
        mu[i] = h[i] / l[i];
        z[i] = (al[i] - h[i - 1] * z[i - 1]) / l[i];
    }
    l[n - 1] = 1; z[n - 1] = 0;
    const c = new Array(n).fill(0), b = new Array(n - 1).fill(0), d = new Array(n - 1).fill(0);
    for (let j = n - 2; j >= 0; j--) {
        c[j] = z[j] - mu[j] * c[j + 1];
        b[j] = (a[j + 1] - a[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
        d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    }
    return { xs, a, b, c, d };
}

function evalSplineAt(s, x) {
    const n = s.xs.length;
    let i = 0;
    if (x <= s.xs[0]) return s.a[0];
    if (x >= s.xs[n - 1]) return s.a[n - 1];
    // 区間探索（線形で十分; 範囲は選択区間内）
    for (i = 0; i < n - 1; i++) {
        if (x >= s.xs[i] && x <= s.xs[i + 1]) break;
    }
    const dx = x - s.xs[i];
    return s.a[i] + s.b[i] * dx + s.c[i] * dx * dx + s.d[i] * dx * dx * dx;
}

/**
 * デバウンス関数（頻繁な呼び出しを制限）
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * マウスダウンイベントハンドラー
 */
function handleTableMouseDown(event) {
    // 左クリックのみ処理
    if (event.button !== 0) return;

    const cell = event.target.closest('td');
    if (!cell) return;

    // フレームセル（1列目）の場合は行ごと選択
    if (cell.cellIndex === 0 || cell.classList.contains('frame-cell')) {
        event.preventDefault();
        const row = cell.parentElement;
        // tbody内でのインデックスを取得
        const { tbody } = getTableBodies();
        const rowIndex = Array.from(tbody.rows).indexOf(row);

        if (rowIndex >= 0) {
            selectEntireRow(rowIndex);
        }
        return;
    }

    event.preventDefault();

    // 選択状態をリセット
    clearTableSelection();

    // 選択開始
    tableSelection.isSelecting = true;
    tableSelection.startCell = cell;
    tableSelection.endCell = cell;

    // 開始セルを選択状態にする
    addCellToSelection(cell);
    updateSelectionHighlight();
}

/**
 * マウス移動イベントハンドラー
 */
function handleTableMouseMove(event) {
    if (!tableSelection.isSelecting) return;

    const cell = event.target.closest('td');
    if (!cell || cell === tableSelection.endCell) return;

    // 終了セルを更新
    tableSelection.endCell = cell;

    // 選択範囲を更新
    updateSelectionRange();
    updateSelectionHighlight();
}

/**
 * マウスアップイベントハンドラー
 */
function handleTableMouseUp(event) {
    if (tableSelection.isSelecting) {
        tableSelection.isSelecting = false;
    }
}

/**
 * セルを選択に追加
 */
function addCellToSelection(cell) {
    const cellId = getCellId(cell);
    tableSelection.selectedCells.add(cellId);
}

/**
 * セルIDを取得（行インデックス-列インデックス形式）
 */
function getCellId(cell) {
    const row = cell.parentElement;
    const table = row.closest('table');
    const tbody = table.querySelector('tbody');

    const rowIndex = Array.from(tbody.rows).indexOf(row);
    const cellIndex = Array.from(row.cells).indexOf(cell);

    return `${rowIndex}-${cellIndex}`;
}

/**
 * セルIDからセル要素を取得
 */
function getCellFromId(cellId) {
    const [rowIndex, cellIndex] = cellId.split('-').map(Number);
    const table = document.getElementById('data-table');
    const tbody = table.querySelector('tbody');

    if (tbody.rows[rowIndex] && tbody.rows[rowIndex].cells[cellIndex]) {
        return tbody.rows[rowIndex].cells[cellIndex];
    }
    return null;
}

/**
 * 選択範囲を更新
 */
function updateSelectionRange() {
    if (!tableSelection.startCell || !tableSelection.endCell) return;

    // 選択範囲をクリア
    tableSelection.selectedCells.clear();

    // 開始・終了セルの位置を取得
    const startPos = getCellPosition(tableSelection.startCell);
    const endPos = getCellPosition(tableSelection.endCell);

    // 範囲の最小・最大値を計算
    const minRow = Math.min(startPos.row, endPos.row);
    const maxRow = Math.max(startPos.row, endPos.row);
    const minCol = Math.min(startPos.col, endPos.col);
    const maxCol = Math.max(startPos.col, endPos.col);

    // 範囲内の全セルを選択に追加
    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            const cellId = `${row}-${col}`;
            const cell = getCellFromId(cellId);
            if (cell) {
                tableSelection.selectedCells.add(cellId);
            }
        }
    }
}

/**
 * セルの位置（行・列インデックス）を取得
 */
function getCellPosition(cell) {
    const row = cell.parentElement;
    const table = row.closest('table');
    const tbody = table.querySelector('tbody');

    const rowIndex = Array.from(tbody.rows).indexOf(row);
    const cellIndex = Array.from(row.cells).indexOf(cell);

    return { row: rowIndex, col: cellIndex };
}

/**
 * 選択ハイライトを更新
 */
function updateSelectionHighlight() {
    // 既存の境界線を削除
    clearSelectionBorder();

    if (tableSelection.selectedCells.size === 0) {
        return;
    }

    // 選択範囲全体の境界線を作成・表示
    createSelectionBorder();

    // フルカラム選択時のヘッダースタイル更新
    const table = document.getElementById('data-table');
    const thead = table ? table.querySelector('thead') : null;
    if (thead) {
        // まず全ヘッダーの選択クラスを解除
        const ths = thead.querySelectorAll('th');
        ths.forEach(th => th.classList.remove('selected-col-header'));

        if (isFullColumnSelection && tableSelection.selectedCells.size > 0) {
            // 選択されている列インデックスを収集
            const selectedCols = new Set();
            tableSelection.selectedCells.forEach(cellId => {
                const [, col] = cellId.split('-').map(Number);
                selectedCols.add(col);
            });

            // 対応するヘッダーにクラスを付与
            selectedCols.forEach(colIndex => {
                // thsは行ヘッダ(0)を含むので、colIndexと一致するはず
                if (ths[colIndex]) {
                    ths[colIndex].classList.add('selected-col-header');
                }
            });
        }
    }
}

/**
 * 選択範囲の境界線を削除
 */
function clearSelectionBorder() {
    const table = document.getElementById('data-table');
    if (!table) return;
    const existingBorder = table.querySelector('.table-selection-border');
    if (existingBorder) {
        existingBorder.remove();
    }
}

/**
 * 選択範囲全体の境界線を作成または更新
 */
function createSelectionBorder() {
    if (tableSelection.selectedCells.size === 0) return;

    const table = document.getElementById('data-table');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    // 選択範囲の最小・最大位置を計算
    let minRow = Infinity, maxRow = -1;
    let minCol = Infinity, maxCol = -1;

    tableSelection.selectedCells.forEach(cellId => {
        const [rowIndex, colIndex] = cellId.split('-').map(Number);
        minRow = Math.min(minRow, rowIndex);
        maxRow = Math.max(maxRow, rowIndex);
        minCol = Math.min(minCol, colIndex);
        maxCol = Math.max(maxCol, colIndex);
    });

    // 境界線の位置とサイズを計算
    const topLeftCell = tbody.rows[minRow]?.cells[minCol];
    const bottomRightCell = tbody.rows[maxRow]?.cells[maxCol];

    if (!topLeftCell || !bottomRightCell) return;

    const tableRect = table.getBoundingClientRect();
    const topLeftRect = topLeftCell.getBoundingClientRect();
    const bottomRightRect = bottomRightCell.getBoundingClientRect();

    // 位置とサイズを計算（テーブル相対位置）
    const left = topLeftRect.left - tableRect.left;
    const top = topLeftRect.top - tableRect.top;
    const width = bottomRightRect.right - topLeftRect.left;
    const height = bottomRightRect.bottom - topLeftRect.top;

    // 既存の境界線要素を再利用または新規作成
    let border = table.querySelector('.table-selection-border');
    if (!border) {
        border = document.createElement('div');
        border.className = 'table-selection-border';
        table.style.position = 'relative';
        table.appendChild(border);
    }

    // 位置とサイズを設定
    border.style.left = `${left}px`;
    border.style.top = `${top}px`;
    border.style.width = `${width}px`;
    border.style.height = `${height}px`;
}

/**
 * テーブル選択をクリア
 */
function clearTableSelection() {
    tableSelection.selectedCells.clear();
    clearSelectionBorder();
    // フルカラム選択フラグをリセット
    isFullColumnSelection = false;
}

/**
 * キーボードイベントハンドラー（Ctrl+C・Ctrl+V対応）
 */
function handleTableKeyDown(event) {
    // データテーブルタブがアクティブでない場合は何もしない
    const dataTab = document.getElementById('data-tab');
    if (!dataTab || !dataTab.classList.contains('active')) {
        return;
    }

    // Excel風 矢印/Shift/Ctrl+Shift 対応
    const isArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key);
    if (isArrow) {
        event.preventDefault();
        const { tbody } = getTableBodies();
        if (!tbody) return;

        const maxRow = Math.max(0, tbody.rows.length - 1);
        const maxCol = Math.max(0, (tbody.rows[0]?.cells.length || 1) - 1);

        // Ctrl+矢印 → 端まで選択拡大（Shiftがあってもなくても）
        if (event.ctrlKey) {
            let target = { ...activeCellPos };
            if (event.key === 'ArrowUp') target.row = 0;
            if (event.key === 'ArrowDown') target.row = maxRow;
            if (event.key === 'ArrowLeft') target.col = 0;
            if (event.key === 'ArrowRight') target.col = maxCol;

            activeCellPos = target;
            focusCell(target.row, target.col);

            if (event.shiftKey) {
                // Ctrl+Shift+矢印: アンカーから端まで選択拡大
                if (!anchorCellPos) anchorCellPos = { row: 0, col: activeCellPos.col };

                // フルカラム選択中は列範囲選択を使用
                if (isFullColumnSelection && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                    selectColumnRange(anchorCellPos.col, target.col);
                } else {
                    selectRange(anchorCellPos, target);
                }
            } else {
                // Ctrl+矢印のみ: 端に移動して単一選択
                anchorCellPos = { ...target };
                clearTableSelection();
                tableSelection.selectedCells.add(`${target.row}-${target.col}`);
                updateSelectionHighlight();
            }
            return;
        }

        // Shift+矢印 → 範囲拡大（列選択中も機能）
        if (event.shiftKey) {
            if (!anchorCellPos) anchorCellPos = { ...activeCellPos };

            let newActive = { ...activeCellPos };
            if (event.key === 'ArrowUp') newActive.row = Math.max(0, newActive.row - 1);
            if (event.key === 'ArrowDown') newActive.row = Math.min(maxRow, newActive.row + 1);
            if (event.key === 'ArrowLeft') newActive.col = Math.max(0, newActive.col - 1);
            if (event.key === 'ArrowRight') newActive.col = Math.min(maxCol, newActive.col + 1);

            activeCellPos = newActive;
            focusCell(newActive.row, newActive.col);

            // フルカラム選択中は列範囲選択を使用
            if (isFullColumnSelection && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                selectColumnRange(anchorCellPos.col, newActive.col);
            } else {
                selectRange(anchorCellPos, newActive);
            }
            return;
        }

        // 通常矢印 → 単純移動
        const delta = { row: 0, col: 0 };
        if (event.key === 'ArrowUp') delta.row = -1;
        if (event.key === 'ArrowDown') delta.row = 1;
        if (event.key === 'ArrowLeft') delta.col = -1;
        if (event.key === 'ArrowRight') delta.col = 1;

        const next = clampCellPos(activeCellPos.row + delta.row, activeCellPos.col + delta.col);
        activeCellPos = next;
        anchorCellPos = { ...next };
        focusCell(next.row, next.col);
        clearTableSelection();
        tableSelection.selectedCells.add(`${next.row}-${next.col}`);
        updateSelectionHighlight();
        return;
    }

    // Ctrl+C の場合
    if (event.ctrlKey && event.key === 'c') {
        // 選択されたセルがある場合のみコピー処理を実行
        if (tableSelection.selectedCells.size > 0) {
            event.preventDefault();
            copySelectedCellsToClipboard();
        }
    }

    // Ctrl+V の場合
    if (event.ctrlKey && event.key === 'v') {
        // 選択されたセルがある場合のみ貼り付け処理を実行
        if (tableSelection.selectedCells.size > 0) {
            event.preventDefault();
            pasteFromClipboardWithUndo(); // Undo対応版
        }
    }

    // Delete の場合
    if (event.key === 'Delete') {
        // 選択されたセルがある場合のみ削除処理を実行
        if (tableSelection.selectedCells.size > 0) {
            event.preventDefault();
            deleteSelectedCellsWithUndo(); // Undo対応版
        }
    }
}

// ========================================
// クリップボード操作機能
// ========================================

/**
 * 選択されたセルをクリップボードにコピー
 */
async function copySelectedCellsToClipboard() {
    if (tableSelection.selectedCells.size === 0) {
        showMessage('選択されたセルがありません');
        return;
    }

    try {
        // 選択されたセルを行・列順に整理
        const cellData = organizeSelectedCells();

        // タブ区切り・改行区切りのテキストを作成
        const clipboardText = createClipboardText(cellData);

        // クリップボードに書き込み
        await navigator.clipboard.writeText(clipboardText);

        showMessage(`${tableSelection.selectedCells.size}個のセルをクリップボードにコピーしました`);

    } catch (error) {
        showError('クリップボードへのコピーに失敗しました');
    }
}

/**
 * 選択されたセルを行・列順に整理
 */
function organizeSelectedCells() {
    const cellData = new Map(); // row -> Map(col -> cellContent)

    tableSelection.selectedCells.forEach(cellId => {
        const [rowIndex, colIndex] = cellId.split('-').map(Number);
        const cell = getCellFromId(cellId);

        if (cell) {
            if (!cellData.has(rowIndex)) {
                cellData.set(rowIndex, new Map());
            }

            // セルの内容を取得・処理
            const cellContent = processCellContent(cell, colIndex);
            cellData.get(rowIndex).set(colIndex, cellContent);
        }
    });

    return cellData;
}

/**
 * セルの内容を処理（x,y座標の分離など）
 */
function processCellContent(cell, colIndex) {
    const text = cell.textContent.trim();

    // フレーム番号列（通常は0列目）の場合
    if (colIndex === 0) {
        return [text]; // 単一の値として返す
    }

    // 座標データの場合（"1251, 692" のような形式）
    if (text.includes(',')) {
        const parts = text.split(',').map(part => part.trim());
        if (parts.length === 2) {
            return parts; // [x座標, y座標] として返す
        }
    }

    // その他の場合（空セルや不明な形式）
    if (text === '-' || text === '') {
        return ['', '']; // 空の2列として返す
    }

    return [text]; // 単一の値として返す
}

/**
 * クリップボード用のテキストを作成
 */
function createClipboardText(cellData) {
    const rows = [];

    // 行を順番に処理
    const sortedRows = Array.from(cellData.keys()).sort((a, b) => a - b);

    for (const rowIndex of sortedRows) {
        const rowData = cellData.get(rowIndex);
        const sortedCols = Array.from(rowData.keys()).sort((a, b) => a - b);

        const rowText = [];

        for (const colIndex of sortedCols) {
            const cellContent = rowData.get(colIndex);

            // セルの内容を展開してタブ区切りで結合
            if (Array.isArray(cellContent)) {
                rowText.push(...cellContent);
            } else {
                rowText.push(cellContent);
            }
        }

        rows.push(rowText.join('\t'));
    }

    return rows.join('\n');
}

/**
 * クリップボードからデータを貼り付け
 */
async function pasteFromClipboard() {
    if (tableSelection.selectedCells.size === 0) {
        showMessage('貼り付け先のセルを選択してください');
        return;
    }

    try {
        // クリップボードからテキストを読み取り
        const clipboardText = await navigator.clipboard.readText();

        if (!clipboardText.trim()) {
            showMessage('クリップボードにデータがありません');
            return;
        }

        // データを解析・変換して貼り付け
        const result = processPasteData(clipboardText);

        if (result.success) {
            // 貼り付けられたセルのみを更新（テーブル全体は更新しない）
            updatePastedCells(result.rows, result.cols);

            // モーション用: 貼り付け完了後にカメラ別データへ反映
            try {
                if (tableSelection.selectedCells.size > 0) {
                    const firstId = Array.from(tableSelection.selectedCells)[0];
                    const [startRow] = firstId.split('-').map(Number);
                    commitPastedMotionDataToCamera(startRow, result.rows);
                }
            } catch (e) {
            }

            // 選択をクリア
            clearTableSelection();

            showMessage('エクセルデータを貼り付けました');
        } else {
            showMessage('貼り付けに失敗しました。データ形式を確認してください。');
        }

    } catch (error) {
        showError('クリップボードからの読み取りに失敗しました');
    }
}

/**
 * 貼り付けデータを処理
 */
function processPasteData(clipboardText) {
    try {
        // 改行で行を分割し、余分な文字を除去
        const rows = clipboardText.trim().split('\n').map(row => row.replace(/\r/g, ''));

        // クリップボードのサイズを確認
        const clipboardRows = rows.length;
        const clipboardCols = Math.max(...rows.map(row => row.split('\t').length));

        // 選択されたセルから開始位置を決定
        let startRow = 0, startCol = 0;

        if (tableSelection.selectedCells.size > 0) {
            // 選択されたセルの位置を開始位置とする
            const cellId = Array.from(tableSelection.selectedCells)[0];
            const [rowIndex, colIndex] = cellId.split('-').map(Number);
            startRow = rowIndex;
            startCol = colIndex;
        }

        // フレーム範囲チェック（動画のフレーム数を使用）
        const maxFrameCount = projectData.settings.motionFrameCount;
        const availableRows = Math.min(clipboardRows, maxFrameCount - startRow);

        if (availableRows <= 0) {
            showError(`フレーム範囲外です。開始フレーム${startRow + 1}は最大フレーム${maxFrameCount}を超えています。`);
            return false;
        }

        // データを貼り付け
        let pastedCount = 0;

        for (let i = 0; i < availableRows; i++) {
            const rowData = rows[i].split('\t'); // タブ区切りで列を分割
            const targetRowIndex = startRow + i;
            const frameNumber = targetRowIndex + 1; // 1ベース

            // 2列以上のデータの場合、X座標とY座標を座標ペアとして処理
            if (clipboardCols >= 2 && rowData.length >= 2) {
                // 座標ペアの数を計算（2列で1組）
                const coordinatePairs = Math.floor(clipboardCols / 2);

                // 各座標ペアを処理
                for (let pairIndex = 0; pairIndex < coordinatePairs; pairIndex++) {
                    const colOffset = pairIndex * 2;
                    const xData = rowData[colOffset]?.trim();
                    const yData = rowData[colOffset + 1]?.trim();

                    if (isNumeric(xData) && isNumeric(yData)) {
                        const x = parseFloat(xData);
                        const y = parseFloat(yData);

                        if (!isNaN(x) && !isNaN(y)) {
                            const coordinates = { x: x, y: y };

                            // 対応する列のポイントIDを決定
                            const targetColIndex = startCol + pairIndex;
                            const pointIndex = targetColIndex - 1; // フレーム列を除く
                            const pointId = pointIndex + 1; // 1ベースのポイントID

                            if (pointIndex >= 0 && pointIndex < motionPoints.length) {
                                const point = motionPoints[pointIndex];

                                // cameraDigitizeData に保存
                                const cam = typeof getCurrentCamera === 'function' ? getCurrentCamera() : 'cam1';
                                if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
                                if (!window.cameraDigitizeData[cam][frameNumber]) window.cameraDigitizeData[cam][frameNumber] = new Map();
                                window.cameraDigitizeData[cam][frameNumber].set(point.id, { x: coordinates.x, y: coordinates.y });
                                pastedCount++;
                            }
                        }
                    }
                }
            } else {
                // 従来の処理（複数列データの場合）
                for (let j = 0; j < rowData.length; j++) {
                    const targetColIndex = startCol + j;

                    // フレーム番号列（0列目）はスキップ
                    if (targetColIndex === 0) {
                        continue;
                    }

                    // ポイントインデックスを計算
                    const pointIndex = targetColIndex - 1;
                    if (pointIndex >= motionPoints.length) {
                        break;
                    }

                    const point = motionPoints[pointIndex];

                    // エクセルの2列データ（X座標、Y座標）を処理
                    if (j + 1 < rowData.length) {
                        const xData = rowData[j]?.trim();
                        const yData = rowData[j + 1]?.trim();

                        if (isNumeric(xData) && isNumeric(yData)) {
                            const x = parseFloat(xData);
                            const y = parseFloat(yData);

                            if (!isNaN(x) && !isNaN(y)) {
                                const coordinates = { x: x, y: y };

                                // cameraDigitizeData に保存
                                const cam = typeof getCurrentCamera === 'function' ? getCurrentCamera() : 'cam1';
                                if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
                                if (!window.cameraDigitizeData[cam][frameNumber]) window.cameraDigitizeData[cam][frameNumber] = new Map();
                                window.cameraDigitizeData[cam][frameNumber].set(point.id, { x: coordinates.x, y: coordinates.y });
                                pastedCount++;

                                // 次の列（Y座標）をスキップ
                                j++;
                                continue;
                            }
                        }
                    }

                    // 単一セルのデータを処理（"X, Y"形式や単一数値）
                    const cellData = rowData[j]?.trim();
                    if (cellData && cellData !== '') {
                        const coordinates = parseCoordinates(cellData);

                        if (coordinates) {
                            // cameraDigitizeData に保存
                            const cam = typeof getCurrentCamera === 'function' ? getCurrentCamera() : 'cam1';
                            if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
                            if (!window.cameraDigitizeData[cam][frameNumber]) window.cameraDigitizeData[cam][frameNumber] = new Map();
                            window.cameraDigitizeData[cam][frameNumber].set(point.id, { x: coordinates.x, y: coordinates.y });
                            pastedCount++;
                        }
                    }
                }
            }
        }

        // 処理された行数、列数、成功フラグを返す
        return { success: pastedCount > 0, rows: availableRows, cols: clipboardCols };

    } catch (error) {
        showError('貼り付けデータの処理に失敗しました');
        return false;
    }
}

/**
 * 座標データを解析する関数
 */
function parseCoordinates(cellData) {
    // "x, y" 形式の文字列の場合
    if (cellData.includes(',')) {
        const parts = cellData.split(',').map(part => part.trim());
        if (parts.length === 2 && isNumeric(parts[0]) && isNumeric(parts[1])) {
            const x = parseFloat(parts[0]);
            const y = parseFloat(parts[1]);
            if (!isNaN(x) && !isNaN(y)) {
                return { x: x, y: y };
            }
        }
    }

    // 単一の数値の場合
    if (isNumeric(cellData)) {
        const value = parseFloat(cellData);
        if (!isNaN(value)) {
            // 単一値の場合は、仮のy座標を0として設定（必要に応じて調整）
            return { x: value, y: 0 };
        }
    }

    return null; // 無効なデータ
}

/**
 * 数値かどうかを判定
 */
function isNumeric(str) {
    if (typeof str !== 'string') return false;
    return !isNaN(str) && !isNaN(parseFloat(str)) && str.trim() !== '';
}

/**
 * 選択されたセルのデータを削除
 */
function deleteSelectedCells() {
    if (tableSelection.selectedCells.size === 0) {
        showMessage('削除するセルを選択してください');
        return;
    }

    // 削除対象のセルを収集
    const cellsToDelete = [];

    tableSelection.selectedCells.forEach(cellId => {
        const [rowIndex, colIndex] = cellId.split('-').map(Number);

        // フレーム番号列（0列目）は削除対象外
        if (colIndex === 0) return;

        // ポイントインデックスを計算
        const pointIndex = colIndex - 1;
        if (pointIndex >= 0 && pointIndex < motionPoints.length) {
            const point = motionPoints[pointIndex];
            const frameNumber = rowIndex + 1; // 1ベース

            cellsToDelete.push({
                frameNumber: frameNumber,
                pointId: point.id,
                pointName: point.name,
                rowIndex: rowIndex,
                colIndex: colIndex
            });
        }
    });

    if (cellsToDelete.length === 0) {
        showMessage('削除可能なセルがありません');
        return;
    }

    // データを削除（内部データ本体と後方互換の両方）
    let deletedCount = 0;
    const currentCam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';

    cellsToDelete.forEach(({ frameNumber, pointId }) => {
        // 1) 後方互換: 旧 frameData 側の削除
        try {
            const frameData = projectData && projectData.frameData && projectData.frameData.get(frameNumber.toString());
            if (frameData && frameData.has(pointId.toString())) {
                frameData.delete(pointId.toString());
                deletedCount++;
            }
        } catch (_) { }

        // 2) 本体: cameraDigitizeData 側の削除（number / string キー両対応）
        try {
            const store = window.cameraDigitizeData && window.cameraDigitizeData[currentCam];
            if (store) {
                const numKey = Number(frameNumber);
                const strKey = String(frameNumber);

                const eraseFromEntry = (entry) => {
                    if (entry && typeof entry.delete === 'function') {
                        // pointId は number と string の両方で念のため削除
                        entry.delete(Number(pointId));
                        entry.delete(String(pointId));
                        return true;
                    }
                    return false;
                };

                if (eraseFromEntry(store[numKey])) {
                    if (!store[numKey] || store[numKey].size === 0) delete store[numKey];
                }
                if (eraseFromEntry(store[strKey])) {
                    if (!store[strKey] || store[strKey].size === 0) delete store[strKey];
                }
            }
        } catch (_) { }
    });

    // セル表示を更新
    updateDeletedCells(cellsToDelete);

    // メモ化・テーブルを更新し、復活を防止
    try { if (typeof window.clearMemoizedTableData === 'function') window.clearMemoizedTableData(); } catch (_) { }
    // try { if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera(); } catch (_) { } // 部分更新済みのため全更新は不要
    try { if (typeof window.redrawCanvas === 'function') window.redrawCanvas(); } catch (_) { }

    // 選択は維持（カーソル位置を保持）

    showMessage(`${deletedCount}個のセルのデータを削除しました`);
}

/**
 * 削除されたセルの表示を更新
 */
function updateDeletedCells(cellsToDelete) {
    const tableBody = document.getElementById('data-table-body');
    if (!tableBody) return;

    cellsToDelete.forEach(({ rowIndex, colIndex }) => {
        const row = tableBody.rows[rowIndex];
        if (!row) return;

        const cell = row.cells[colIndex];
        if (!cell) return;

        // セルの表示をクリア
        cell.textContent = '-';
        cell.classList.remove('point-cell');
    });
}

/**
 * 貼り付けられたセルのみを更新
 */
function updatePastedCells(clipboardRows, clipboardCols) {
    const tableBody = document.getElementById('data-table-body');
    if (!tableBody) return;

    // 更新対象のセルを一括で収集
    const cellsToUpdate = [];

    // 2列または4列データの場合、クリップボードの行数分のセルを更新
    if (tableSelection.selectedCells.size === 1) {
        const [startRow, startCol] = Array.from(tableSelection.selectedCells)[0].split('-').map(Number);

        // 座標ペアの数を計算（2列で1組）
        const coordinatePairs = Math.floor(clipboardCols / 2);

        // 各列のセルを収集
        for (let colOffset = 0; colOffset < coordinatePairs; colOffset++) {
            const colIndex = startCol + colOffset;
            const pointIndex = colIndex - 1; // フレーム列を除く
            const pointId = pointIndex + 1; // 1ベースのポイントID

            if (pointIndex >= 0 && pointIndex < motionPoints.length) {
                const point = motionPoints[pointIndex];

                // 各行のセルを収集
                for (let i = 0; i < clipboardRows; i++) {
                    const rowIndex = startRow + i;

                    const row = tableBody.rows[rowIndex];
                    if (!row) continue;

                    const cell = row.cells[colIndex];
                    if (!cell) continue;

                    // フレーム番号列（0列目）はスキップ
                    if (colIndex === 0) continue;

                    const frameNumber = rowIndex + 1; // 1ベース

                    // cameraDigitizeData から座標を取得
                    const cam = typeof getCurrentCamera === 'function' ? getCurrentCamera() : 'cam1';
                    const frameMap = window.cameraDigitizeData && window.cameraDigitizeData[cam]
                        ? window.cameraDigitizeData[cam][frameNumber]
                        : null;
                    const pointData = frameMap ? frameMap.get(point.id) : null;

                    cellsToUpdate.push({
                        cell: cell,
                        pointData: pointData,
                        pointName: point.name
                    });
                }
            }
        }
    } else {
        // 従来の処理（複数セル選択の場合）
        tableSelection.selectedCells.forEach(cellId => {
            const [rowIndex, colIndex] = cellId.split('-').map(Number);
            const row = tableBody.rows[rowIndex];
            if (!row) return;

            const cell = row.cells[colIndex];
            if (!cell) return;

            // フレーム番号列（0列目）はスキップ
            if (colIndex === 0) return;

            // ポイントインデックスを計算
            const pointIndex = colIndex - 1;
            if (pointIndex >= motionPoints.length) return;

            const point = motionPoints[pointIndex];
            const frameNumber = rowIndex + 1; // 1ベース

            // cameraDigitizeData から座標を取得
            const cam = typeof getCurrentCamera === 'function' ? getCurrentCamera() : 'cam1';
            const frameMap = window.cameraDigitizeData && window.cameraDigitizeData[cam]
                ? window.cameraDigitizeData[cam][frameNumber]
                : null;
            const pointData = frameMap ? frameMap.get(point.id) : null;

            cellsToUpdate.push({
                cell: cell,
                pointData: pointData,
                pointName: point.name
            });
        });
    }

    // 最適化された一括更新処理

    // パフォーマンス最適化のため、requestAnimationFrameを使用
    if (cellsToUpdate.length > 1000) {
        // 大量データの場合は、バッチ処理で分割
        const batchSize = 1000;
        const totalBatches = Math.ceil(cellsToUpdate.length / batchSize);

        let currentBatch = 0;

        function processBatch() {
            const start = currentBatch * batchSize;
            const end = Math.min(start + batchSize, cellsToUpdate.length);
            const batch = cellsToUpdate.slice(start, end);

            // 現在のバッチを処理
            batch.forEach(({ cell, pointData, pointName }) => {
                if (pointData) {
                    const displayText = `${Math.round(pointData.x)}, ${Math.round(pointData.y)}`;
                    cell.textContent = displayText;
                    cell.classList.add('point-cell');
                } else {
                    cell.textContent = '-';
                    cell.classList.remove('point-cell');
                }
            });

            currentBatch++;

            if (currentBatch < totalBatches) {
                // 次のバッチを非同期で処理
                requestAnimationFrame(processBatch);
            } else {
            }
        }

        // 最初のバッチを開始
        requestAnimationFrame(processBatch);
    } else {
        // 少量データの場合は従来通り一括処理
        cellsToUpdate.forEach(({ cell, pointData, pointName }) => {
            if (pointData) {
                const displayText = `${Math.round(pointData.x)}, ${Math.round(pointData.y)}`;
                cell.textContent = displayText;
                cell.classList.add('point-cell');
            } else {
                cell.textContent = '-';
                cell.classList.remove('point-cell');
            }
        });
    }
}

/**
 * モーション貼り付けデータをカメラ別データへ反映
 * @param {number} startRow0Based 行開始(0ベース)
 * @param {number} rowCount 行数
 */
function commitPastedMotionDataToCamera(startRow0Based, rowCount) {
    if (typeof getCurrentCamera !== 'function') return;
    const currentCamera = getCurrentCamera(); // 'cam1' | 'cam2'
    if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
    const target = window.cameraDigitizeData[currentCamera] || (window.cameraDigitizeData[currentCamera] = {});

    for (let i = 0; i < rowCount; i++) {
        const frameNumber = startRow0Based + i + 1; // 1ベース
        const frameKey = frameNumber.toString();
        const frameData = projectData.frameData.get(frameKey);
        if (!frameData) continue;

        // Map<pointId(string), {x,y}> → Map<number, {x,y}>
        const mapForCamera = new Map();
        frameData.forEach((coords, pointIdStr) => {
            const pid = parseInt(pointIdStr, 10);
            if (!isNaN(pid) && coords && typeof coords.x === 'number' && typeof coords.y === 'number') {
                mapForCamera.set(pid, { x: coords.x, y: coords.y });
            }
        });

        target[frameNumber] = mapForCamera;
    }
}

/**
 * CSSスタイルを追加（選択ハイライト用）
 */
function addTableSelectionStyles() {
    // 既存のスタイルが存在するかチェック
    if (document.getElementById('table-selection-styles')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'table-selection-styles';
    style.textContent = `
        .table-selection-border {
            position: absolute;
            border: 2px solid #2563eb;
            pointer-events: none;
            z-index: 1000;
            background-color: transparent;
        }
        
        .data-table td {
            position: relative;
        }
        
        .data-table {
            border-collapse: separate;
            border-spacing: 0;
        }
    `;

    document.head.appendChild(style);
}

// ========================================
// キャリブレーションテーブル選択機能
// ========================================

/**
 * キャリブレーションテーブル用のセル選択機能を初期化
 */
function initializeCalibrationTableSelection() {
    const tableBody = document.getElementById('calibration-table-body');
    if (!tableBody) return;

    // 既存のイベントリスナーを削除（重複を避けるため）
    tableBody.removeEventListener('mousedown', handleCalibrationTableMouseDown);
    tableBody.removeEventListener('mouseover', handleCalibrationTableMouseOver);
    tableBody.removeEventListener('mouseup', handleCalibrationTableMouseUp);

    // 新しいイベントリスナーを追加
    tableBody.addEventListener('mousedown', handleCalibrationTableMouseDown);
    tableBody.addEventListener('mouseover', handleCalibrationTableMouseOver);
    tableBody.addEventListener('mouseup', handleCalibrationTableMouseUp);

    // キーボードイベントリスナーを追加
    tableBody.addEventListener('keydown', handleCalibrationTableKeyDown);

    // セルをフォーカス可能にし、編集可能セルにダブルクリックイベントを追加
    const cells = tableBody.querySelectorAll('td');
    cells.forEach(cell => {
        cell.tabIndex = 0;
        // 編集可能セルにダブルクリックイベントを追加
        if (cell.dataset.editable === 'true') {
            cell.addEventListener('dblclick', handleCalibrationCellDblClick);
        }
    });
}

/**
 * キャリブレーションテーブルのマウスダウン処理
 */
function handleCalibrationTableMouseDown(event) {
    // 入力フィールド上では選択処理を無効化し、編集を優先
    if (event.target && (event.target.tagName === 'INPUT' || event.target.closest('input'))) {
        return;
    }
    const cell = event.target.closest('td');
    if (!cell) return;

    event.preventDefault();

    // 行インデックスから対応するキャリブレーションポイントを取得
    const row = cell.closest('tr');
    if (row && window.calibrationData && window.calibrationData.points) {
        const rowIndex = Array.from(row.parentElement.rows).indexOf(row);
        if (rowIndex >= 0 && rowIndex < window.calibrationData.points.length) {
            const point = window.calibrationData.points[rowIndex];

            // キャリブレーションモードに切り替え
            const calibrationRadio = document.querySelector('input[name="mode"][value="calibration"]');
            if (calibrationRadio && !calibrationRadio.checked) {
                calibrationRadio.checked = true;
                calibrationRadio.dispatchEvent(new Event('change'));
            }

            // ポイントを選択状態にする
            if (typeof window.setSelectedLandmark === 'function') {
                window.setSelectedLandmark(point);
            }
            const select = document.getElementById('calibration-landmark-select');
            if (select) {
                select.value = point.id;
            }

            // クリックされた列インデックスを取得
            const colIndex = Array.from(row.cells).indexOf(cell);

            // キャリブレーション方法を確認
            const methodSelect = document.getElementById('calibration-method');
            const isTwoCamera = methodSelect && (methodSelect.value === '3d-dlt' || methodSelect.value === 'checkerboard' || methodSelect.value === '2d-dlt-stereo');

            let targetCamera = null;
            let frameNumber = null;

            if (isTwoCamera) {
                if (colIndex === 1) {
                    // カメラ1デジタイズ座標列
                    targetCamera = 'cam1';
                    frameNumber = point.frameNumber;
                } else if (colIndex === 2) {
                    // カメラ2デジタイズ座標列
                    targetCamera = 'cam2';
                    frameNumber = point.frameNumber2;
                } else {
                    // Calポイント列または他の列：現在のカメラを維持
                    const currentCamera = typeof window.getCurrentCamera === 'function' ? window.getCurrentCamera() : 'cam1';
                    frameNumber = currentCamera === 'cam1' ? point.frameNumber : point.frameNumber2;
                }
            } else {
                // シングルカメラモード
                frameNumber = point.frameNumber;
            }

            // カメラを切り替え
            if (targetCamera) {
                const cameraRadio = document.getElementById(targetCamera === 'cam1' ? 'camera1' : 'camera2');
                if (cameraRadio && !cameraRadio.checked) {
                    cameraRadio.checked = true;
                    cameraRadio.dispatchEvent(new Event('change'));
                }
            }

            // フレーム移動
            if (frameNumber && typeof window.setCurrentFrameNumber === 'function') {
                window.setCurrentFrameNumber(frameNumber);
            }

            // ハイライトを更新
            if (typeof window.updateTableHighlights === 'function') {
                window.updateTableHighlights();
            }
        }
    }

    // 既存の選択をクリア
    clearCalibrationTableSelection();

    // 新しい選択を開始
    calibrationTableSelection.isSelecting = true;
    calibrationTableSelection.startCell = cell;
    calibrationTableSelection.endCell = cell;

    // アクティブセル位置を更新
    const cellPos = getCalibrationCellPosition(cell);
    calibrationActiveCellPos = { row: cellPos.row, col: cellPos.col };
    calibrationAnchorCellPos = { ...calibrationActiveCellPos };

    // セルを選択状態にする
    const cellId = getCalibrationCellId(cell);
    calibrationTableSelection.selectedCells.add(cellId);
    cell.classList.add('selected');

    // 選択ハイライトを更新
    updateCalibrationSelectionHighlight();

    // セルにフォーカス
    cell.focus();
}

/**
 * キャリブレーションテーブルのマウスオーバー処理
 */
function handleCalibrationTableMouseOver(event) {
    // 入力フィールド上のドラッグは無視
    if (event.target && (event.target.tagName === 'INPUT' || event.target.closest('input'))) {
        return;
    }
    if (!calibrationTableSelection.isSelecting) return;

    const cell = event.target.closest('td');
    if (!cell || cell === calibrationTableSelection.endCell) return;

    // 選択範囲を更新
    calibrationTableSelection.endCell = cell;

    // アクティブセル位置を更新
    const cellPos = getCalibrationCellPosition(cell);
    calibrationActiveCellPos = { row: cellPos.row, col: cellPos.col };

    updateCalibrationTableSelection();
}

/**
 * キャリブレーションテーブルのマウスアップ処理
 */
function handleCalibrationTableMouseUp(event) {
    if (calibrationTableSelection.isSelecting) {
        calibrationTableSelection.isSelecting = false;
    }
}

/**
 * キャリブレーションテーブルのキーボード処理（Excel風拡張）
 */
function handleCalibrationTableKeyDown(event) {
    // 編集中（INPUT内）の場合は編集用キー処理
    if (event.target && event.target.tagName === 'INPUT') {
        handleCalibrationEditKeyDown(event);
        return;
    }

    const tableBody = document.getElementById('calibration-table-body');
    if (!tableBody) return;

    const maxRow = Math.max(0, tableBody.rows.length - 1);
    const maxCol = Math.max(0, (tableBody.rows[0]?.cells.length || 1) - 1);

    // 矢印キー処理
    const isArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key);
    if (isArrow) {
        event.preventDefault();

        // Ctrl+矢印 → 端まで移動
        if (event.ctrlKey) {
            let target = { ...calibrationActiveCellPos };
            if (event.key === 'ArrowUp') target.row = 0;
            if (event.key === 'ArrowDown') target.row = maxRow;
            if (event.key === 'ArrowLeft') target.col = 0;
            if (event.key === 'ArrowRight') target.col = maxCol;

            calibrationActiveCellPos = target;
            focusCalibrationCell(target.row, target.col);

            if (event.shiftKey) {
                // Ctrl+Shift+矢印: アンカーから端まで選択拡大
                if (!calibrationAnchorCellPos) calibrationAnchorCellPos = { row: 0, col: calibrationActiveCellPos.col };
                selectCalibrationRange(calibrationAnchorCellPos, target);
            } else {
                // Ctrl+矢印のみ: 端に移動して単一選択
                calibrationAnchorCellPos = { ...target };
                clearCalibrationTableSelection();
                calibrationTableSelection.selectedCells.add(`${target.row}-${target.col}`);
                updateCalibrationSelectionHighlight();
            }
            return;
        }

        // Shift+矢印 → 範囲拡大
        if (event.shiftKey) {
            if (!calibrationAnchorCellPos) calibrationAnchorCellPos = { ...calibrationActiveCellPos };

            let newActive = { ...calibrationActiveCellPos };
            if (event.key === 'ArrowUp') newActive.row = Math.max(0, newActive.row - 1);
            if (event.key === 'ArrowDown') newActive.row = Math.min(maxRow, newActive.row + 1);
            if (event.key === 'ArrowLeft') newActive.col = Math.max(0, newActive.col - 1);
            if (event.key === 'ArrowRight') newActive.col = Math.min(maxCol, newActive.col + 1);

            calibrationActiveCellPos = newActive;
            focusCalibrationCell(newActive.row, newActive.col);
            selectCalibrationRange(calibrationAnchorCellPos, newActive);
            return;
        }

        // 通常矢印 → 単純移動
        const delta = { row: 0, col: 0 };
        if (event.key === 'ArrowUp') delta.row = -1;
        if (event.key === 'ArrowDown') delta.row = 1;
        if (event.key === 'ArrowLeft') delta.col = -1;
        if (event.key === 'ArrowRight') delta.col = 1;

        const nextRow = Math.max(0, Math.min(maxRow, calibrationActiveCellPos.row + delta.row));
        const nextCol = Math.max(0, Math.min(maxCol, calibrationActiveCellPos.col + delta.col));

        calibrationActiveCellPos = { row: nextRow, col: nextCol };
        calibrationAnchorCellPos = { ...calibrationActiveCellPos };
        focusCalibrationCell(nextRow, nextCol);
        clearCalibrationTableSelection();
        calibrationTableSelection.selectedCells.add(`${nextRow}-${nextCol}`);
        updateCalibrationSelectionHighlight();
        return;
    }

    // F2 or Enter → 編集可能セルの編集モード開始
    if (event.key === 'F2' || event.key === 'Enter') {
        const cell = getCalibrationCellFromId(`${calibrationActiveCellPos.row}-${calibrationActiveCellPos.col}`);
        if (cell && cell.dataset.editable === 'true') {
            event.preventDefault();
            enterCalibrationEditMode(cell);
        }
        return;
    }

    // Tab → 次の編集可能セルへ移動
    if (event.key === 'Tab') {
        event.preventDefault();
        moveToNextEditableCalibrationCell(event.shiftKey);
        return;
    }

    // 英数字・マイナス・ピリオド入力 → 編集可能セルなら編集モード開始
    if (!event.ctrlKey && !event.altKey && event.key.length === 1 && /[0-9.\-]/.test(event.key)) {
        const cell = getCalibrationCellFromId(`${calibrationActiveCellPos.row}-${calibrationActiveCellPos.col}`);
        if (cell && cell.dataset.editable === 'true') {
            event.preventDefault();
            enterCalibrationEditMode(cell, event.key);
        }
        return;
    }

    // Ctrl+C の場合
    if (event.ctrlKey && event.key === 'c') {
        if (calibrationTableSelection.selectedCells.size > 0) {
            event.preventDefault();
            copyCalibrationCellsToClipboard();
        }
    }

    // Ctrl+V の場合
    if (event.ctrlKey && event.key === 'v') {
        if (calibrationTableSelection.selectedCells.size > 0) {
            event.preventDefault();
            pasteToCalibrationTable();
        }
    }

    // Delete の場合
    if (event.key === 'Delete') {
        if (calibrationTableSelection.selectedCells.size > 0) {
            event.preventDefault();
            clearCalibrationCells();
        }
    }

    // Ctrl+A → 全選択
    if (event.ctrlKey && event.key === 'a') {
        event.preventDefault();
        selectAllCalibrationCells();
    }
}

/**
 * 編集モード中のキー処理
 */
function handleCalibrationEditKeyDown(event) {
    const input = event.target;
    if (!input || input.tagName !== 'INPUT') return;

    const isArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key);

    if (event.key === 'Enter') {
        event.preventDefault();
        exitCalibrationEditMode(input.parentElement, true);

        // 下のセルへ移動（Shift+Enterなら上へ）
        const moveRow = event.shiftKey ? -1 : 1;
        moveCalibrationFocus(moveRow, 0);
    }
    else if (isArrow) {
        // 矢印キー: 確定して方向へ移動
        event.preventDefault();
        exitCalibrationEditMode(input.parentElement, true);

        let dRow = 0, dCol = 0;
        if (event.key === 'ArrowUp') dRow = -1;
        if (event.key === 'ArrowDown') dRow = 1;
        if (event.key === 'ArrowLeft') dCol = -1;
        if (event.key === 'ArrowRight') dCol = 1;

        moveCalibrationFocus(dRow, dCol);
    }
    else if (event.key === 'Tab') {
        event.preventDefault();
        exitCalibrationEditMode(input.parentElement, true);
        moveToNextEditableCalibrationCell(event.shiftKey);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        exitCalibrationEditMode(input.parentElement, false);
    }
}

/**
 * キャリブレーションテーブルのフォーカス移動ヘルパー
 */
function moveCalibrationFocus(dRow, dCol) {
    const tableBody = document.getElementById('calibration-table-body');
    if (!tableBody) return;

    const maxRow = Math.max(0, tableBody.rows.length - 1);
    const maxCol = Math.max(0, (tableBody.rows[0]?.cells.length || 1) - 1);

    let { row, col } = calibrationActiveCellPos;
    let nextRow = row + dRow;
    let nextCol = col + dCol;

    // 範囲制限
    nextRow = Math.max(0, Math.min(maxRow, nextRow));
    nextCol = Math.max(0, Math.min(maxCol, nextCol));

    // 左右移動の場合は編集可能セルを探す（簡易実装）
    if (dCol !== 0) {
        for (let i = 0; i < maxCol + 1; i++) {
            const cell = getCalibrationCellFromId(`${nextRow}-${nextCol}`);
            if (cell && cell.dataset.editable === 'true') {
                break; // Found
            }

            // さらに隣へ
            nextCol += dCol > 0 ? 1 : -1;

            // 行末チェック
            if (nextCol > maxCol || nextCol < 0) {
                nextCol = Math.max(0, Math.min(maxCol, nextCol));
                // 端で止まる（編集不可なら元の位置に戻す）
                const cellAtEdge = getCalibrationCellFromId(`${nextRow}-${nextCol}`);
                if (!cellAtEdge || cellAtEdge.dataset.editable !== 'true') {
                    nextCol = col;
                }
                break;
            }
        }
    }

    // 更新
    calibrationActiveCellPos = { row: nextRow, col: nextCol };
    calibrationAnchorCellPos = { ...calibrationActiveCellPos };
    focusCalibrationCell(nextRow, nextCol);
    clearCalibrationTableSelection();
    calibrationTableSelection.selectedCells.add(`${nextRow}-${nextCol}`);
    updateCalibrationSelectionHighlight();
}

/**
 * キャリブレーションセルにフォーカス
 */
function focusCalibrationCell(row, col) {
    const cell = getCalibrationCellFromId(`${row}-${col}`);
    if (cell) {
        cell.focus();
    }
}

/**
 * キャリブレーション範囲選択
 */
function selectCalibrationRange(anchor, active) {
    clearCalibrationTableSelection();

    const minRow = Math.min(anchor.row, active.row);
    const maxRow = Math.max(anchor.row, active.row);
    const minCol = Math.min(anchor.col, active.col);
    const maxCol = Math.max(anchor.col, active.col);

    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            const cellId = `${row}-${col}`;
            calibrationTableSelection.selectedCells.add(cellId);

            const cell = getCalibrationCellFromId(cellId);
            if (cell) {
                cell.classList.add('selected');
            }
        }
    }

    updateCalibrationSelectionHighlight();
}

/**
 * 全セル選択
 */
function selectAllCalibrationCells() {
    const tableBody = document.getElementById('calibration-table-body');
    if (!tableBody || tableBody.rows.length === 0) return;

    const maxRow = tableBody.rows.length - 1;
    const maxCol = (tableBody.rows[0]?.cells.length || 1) - 1;

    calibrationAnchorCellPos = { row: 0, col: 0 };
    calibrationActiveCellPos = { row: maxRow, col: maxCol };

    selectCalibrationRange(calibrationAnchorCellPos, calibrationActiveCellPos);
}

/**
 * 次の編集可能セルへ移動
 */
function moveToNextEditableCalibrationCell(backward = false) {
    const tableBody = document.getElementById('calibration-table-body');
    if (!tableBody || tableBody.rows.length === 0) return;

    const maxRow = tableBody.rows.length - 1;
    const maxCol = (tableBody.rows[0]?.cells.length || 1) - 1;

    let { row, col } = calibrationActiveCellPos;

    // 次の編集可能セルを探す
    const step = backward ? -1 : 1;
    let found = false;
    let iterations = 0;
    const maxIterations = (maxRow + 1) * (maxCol + 1);

    while (iterations < maxIterations) {
        col += step;
        if (col > maxCol) {
            col = 0;
            row++;
        } else if (col < 0) {
            col = maxCol;
            row--;
        }

        if (row > maxRow) row = 0;
        if (row < 0) row = maxRow;

        const cell = getCalibrationCellFromId(`${row}-${col}`);
        if (cell && cell.dataset.editable === 'true') {
            found = true;
            break;
        }
        iterations++;
    }

    if (found) {
        calibrationActiveCellPos = { row, col };
        calibrationAnchorCellPos = { ...calibrationActiveCellPos };
        focusCalibrationCell(row, col);
        clearCalibrationTableSelection();
        calibrationTableSelection.selectedCells.add(`${row}-${col}`);
        updateCalibrationSelectionHighlight();
    }
}

/**
 * セル編集モードを開始
 * @param {HTMLElement} cell - 編集するセル
 * @param {string} initialChar - 初期入力文字（直接入力の場合）
 */
function enterCalibrationEditMode(cell, initialChar = null) {
    if (!cell || cell.dataset.editable !== 'true') return;
    if (calibrationEditingCell) {
        exitCalibrationEditMode(calibrationEditingCell, true);
    }

    calibrationEditingCell = cell;
    const currentValue = cell.textContent.trim();

    // セルの現在の幅を固定（編集中に幅が変わらないように）
    const currentWidth = cell.offsetWidth;
    cell.style.width = currentWidth + 'px';
    cell.style.minWidth = currentWidth + 'px';
    cell.style.maxWidth = currentWidth + 'px';

    // 一時的なINPUTを作成
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'calibration-cell-input';
    input.value = initialChar !== null ? initialChar : currentValue;
    input.dataset.originalValue = currentValue;
    input.dataset.pointId = cell.dataset.pointId;
    input.dataset.coordType = cell.dataset.coordType;

    // セルの内容をクリアしてINPUTを追加
    cell.textContent = '';
    cell.appendChild(input);
    cell.classList.add('editing');

    // フォーカスとカーソル位置
    input.focus();
    if (initialChar !== null) {
        // 初期文字がある場合はカーソルを末尾に
        input.setSelectionRange(input.value.length, input.value.length);
    } else {
        // 全選択
        input.select();
    }

    // ダブルクリック編集用イベントを一時的に無効化
    cell.removeEventListener('dblclick', handleCalibrationCellDblClick);
}

/**
 * セル編集モードを終了
 * @param {HTMLElement} cell - 編集中のセル
 * @param {boolean} save - 変更を保存するか
 */
function exitCalibrationEditMode(cell, save = true) {
    if (!cell) return;

    const input = cell.querySelector('input.calibration-cell-input');
    if (!input) return;

    const newValue = input.value.trim();
    const originalValue = input.dataset.originalValue || '';
    const pointId = input.dataset.pointId;
    const coordType = input.dataset.coordType;

    // INPUTを削除してテキストを復元
    cell.removeChild(input);
    cell.classList.remove('editing');

    // セルの幅の固定を解除
    cell.style.width = '';
    cell.style.minWidth = '';
    cell.style.maxWidth = '';

    if (save && newValue !== originalValue) {
        // 値を保存
        cell.textContent = newValue;

        // calibrationDataを更新
        const value = newValue === '' ? null : parseFloat(newValue);
        const normalizeId = (v) => String(v).replace(/^Cal/i, '');
        const point = calibrationData.points.find(p => normalizeId(p.id) === normalizeId(pointId));
        if (point) {
            if (!point.realCoords) {
                point.realCoords = { x: null, y: null, z: null };
            }
            point.realCoords[coordType] = value;
        }
    } else {
        // 変更を破棄
        cell.textContent = originalValue;
    }

    calibrationEditingCell = null;

    // ダブルクリックイベントを再設定
    cell.addEventListener('dblclick', handleCalibrationCellDblClick);

    // セルにフォーカスを戻す
    cell.focus();
}

/**
 * セルダブルクリック時の編集モード開始
 */
function handleCalibrationCellDblClick(event) {
    const cell = event.target.closest('td');
    if (cell && cell.dataset.editable === 'true') {
        event.preventDefault();
        enterCalibrationEditMode(cell);
    }
}

/**
 * キャリブレーションテーブルのセル選択を更新
 */
function updateCalibrationTableSelection() {
    if (!calibrationTableSelection.startCell || !calibrationTableSelection.endCell) return;

    // 既存の選択をクリア
    clearCalibrationTableSelection();

    // 選択範囲を計算
    const startPos = getCalibrationCellPosition(calibrationTableSelection.startCell);
    const endPos = getCalibrationCellPosition(calibrationTableSelection.endCell);

    const minRow = Math.min(startPos.row, endPos.row);
    const maxRow = Math.max(startPos.row, endPos.row);
    const minCol = Math.min(startPos.col, endPos.col);
    const maxCol = Math.max(startPos.col, endPos.col);

    // 範囲内のセルを選択
    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            const cellId = `${row}-${col}`;
            calibrationTableSelection.selectedCells.add(cellId);

            const cell = getCalibrationCellFromId(cellId);
            if (cell) {
                cell.classList.add('selected');
            }
        }
    }

    // 選択境界線を更新
    updateCalibrationSelectionHighlight();
}

/**
 * キャリブレーションテーブルのセル選択をクリア
 */
function clearCalibrationTableSelection() {
    calibrationTableSelection.selectedCells.forEach(cellId => {
        const cell = getCalibrationCellFromId(cellId);
        if (cell) {
            cell.classList.remove('selected');
        }
    });
    calibrationTableSelection.selectedCells.clear();

    // 選択境界線も削除
    const existingBorders = document.querySelectorAll('.calibration-table-selection-border');
    existingBorders.forEach(border => border.remove());
}

/**
 * キャリブレーションセルのIDを取得
 */
function getCalibrationCellId(cell) {
    const row = cell.parentElement.rowIndex - 1; // theadを考慮
    const col = cell.cellIndex;
    return `${row}-${col}`;
}

/**
 * キャリブレーションセルの位置を取得
 */
function getCalibrationCellPosition(cell) {
    const row = cell.parentElement.rowIndex - 1; // theadを考慮
    const col = cell.cellIndex;
    return { row, col };
}

/**
 * キャリブレーションセルIDからセル要素を取得
 */
function getCalibrationCellFromId(cellId) {
    const [rowIndex, colIndex] = cellId.split('-').map(Number);
    const tableBody = document.getElementById('calibration-table-body');
    if (!tableBody) return null;

    const row = tableBody.rows[rowIndex];
    if (!row) return null;

    return row.cells[colIndex] || null;
}

/**
 * キャリブレーションセルをクリップボードにコピー
 */
async function copyCalibrationCellsToClipboard() {
    if (calibrationTableSelection.selectedCells.size === 0) {
        showMessage('選択されたセルがありません');
        return;
    }

    try {
        // 選択されたセルを行・列順に整理
        const cellData = organizeCalibrationCells();

        // タブ区切り・改行区切りのテキストを作成
        const clipboardText = createCalibrationClipboardText(cellData);

        // クリップボードに書き込み
        await navigator.clipboard.writeText(clipboardText);

        showMessage(`${calibrationTableSelection.selectedCells.size}個のセルをクリップボードにコピーしました`);

    } catch (error) {
        console.error('Calibration clipboard copy error:', error);
        showError('クリップボードへのコピーに失敗しました');
    }
}

/**
 * キャリブレーションセルを行・列順に整理
 */
function organizeCalibrationCells() {
    const cellData = new Map();

    calibrationTableSelection.selectedCells.forEach(cellId => {
        const [rowIndex, colIndex] = cellId.split('-').map(Number);
        const cell = getCalibrationCellFromId(cellId);

        if (cell) {
            if (!cellData.has(rowIndex)) {
                cellData.set(rowIndex, new Map());
            }

            // セルの内容を取得・処理
            const cellContent = processCalibrationCellContent(cell, colIndex);
            cellData.get(rowIndex).set(colIndex, cellContent);
        }
    });

    return cellData;
}

/**
 * キャリブレーションセルの内容を処理
 */
function processCalibrationCellContent(cell, colIndex) {
    // 入力フィールドの場合はその値を取得
    const input = cell.querySelector('input');
    if (input) {
        return input.value;
    }

    // 通常のセルの場合はテキスト内容を取得
    const text = cell.textContent.trim();

    // 座標データの場合（"305, 900" のような形式）
    if (text.includes(',')) {
        const parts = text.split(',').map(part => part.trim());
        if (parts.length === 2) {
            return parts; // [x座標, y座標] として返す
        }
    }

    return [text];
}

/**
 * キャリブレーションクリップボード用のテキストを作成
 */
function createCalibrationClipboardText(cellData) {
    const rows = [];

    // 行を順番に処理
    const sortedRows = Array.from(cellData.keys()).sort((a, b) => a - b);

    for (const rowIndex of sortedRows) {
        const rowData = cellData.get(rowIndex);
        const sortedCols = Array.from(rowData.keys()).sort((a, b) => a - b);

        const rowText = [];

        for (const colIndex of sortedCols) {
            const cellContent = rowData.get(colIndex);

            // セルの内容を展開してタブ区切りで結合
            if (Array.isArray(cellContent)) {
                rowText.push(...cellContent);
            } else {
                rowText.push(cellContent);
            }
        }

        rows.push(rowText.join('\t'));
    }

    return rows.join('\n');
}

/**
 * キャリブレーションセルをクリップボードから貼り付け
 */
async function pasteToCalibrationTable() {
    if (calibrationTableSelection.selectedCells.size === 0) {
        showMessage('貼り付け先のセルを選択してください');
        return;
    }

    try {
        const clipboardText = await navigator.clipboard.readText();

        if (!clipboardText.trim()) {
            showMessage('クリップボードにデータがありません');
            return;
        }

        // データを解析・変換して貼り付け
        const result = processCalibrationPasteData(clipboardText);

        if (result.success) {
            // 貼り付けられたセルのみを更新
            updateCalibrationPastedCells(result.rows, result.cols);

            // 選択をクリア
            clearCalibrationTableSelection();

            showMessage('エクセルデータを貼り付けました');
        } else {
            if (result.error === '行範囲外') {
                showError('貼り付けに失敗しました。行範囲外です。');
            } else {
                showMessage('貼り付けに失敗しました。データ形式を確認してください。');
            }
        }

    } catch (error) {
        console.error('Calibration clipboard paste error:', error);
        showError('クリップボードからの読み取りに失敗しました');
    }
}

/**
 * キャリブレーション貼り付けデータを処理
 * - デジタイズ座標列（Calポイント名、カメラ1/2座標）は読み取り専用
 * - 実空間座標列のみ貼り付け可能
 * - 選択セルを基準にExcelのように貼り付け
 */
function processCalibrationPasteData(clipboardText) {
    try {
        // キャリブレーション方法を取得して列構造を判定
        const method = document.getElementById('calibration-method').value;
        const isTwoCamera = method === '3d-dlt' || method === 'checkerboard' || method === '2d-dlt-stereo' || method === '3d-cc-method';
        const isThreeDim = method === '3d-dlt' || method === 'checkerboard' || method === '3d-cc-method';
        const isFourPoint = method === '4-point';

        // 読み取り専用列の数を計算
        // Column 0: Calポイント名 (read-only)
        // Column 1: カメラ1デジタイズ座標 (read-only)
        // Column 2: カメラ2デジタイズ座標 (read-only, 2カメラモードのみ)
        const readOnlyColCount = isTwoCamera ? 3 : 2;

        // 実空間座標列の開始インデックス
        const realCoordsStartCol = readOnlyColCount;

        // 実空間座標列の数 (x, y, z or x, y)
        const realCoordsCols = isFourPoint ? 0 : (isThreeDim ? 3 : 2);

        if (realCoordsCols === 0) {
            showError('4点実長換算モードでは実空間座標の貼り付けはできません');
            return { success: false, error: '4点モード' };
        }

        // 改行で行を分割し、余分な文字を除去
        const rows = clipboardText.trim().split('\n').map(row => row.replace(/\r/g, ''));

        // クリップボードのサイズを確認
        const clipboardRows = rows.length;
        const clipboardCols = Math.max(...rows.map(row => row.split('\t').length));

        // 選択されたセルから開始位置を決定
        let startRow = 0, startCol = 0;

        if (calibrationTableSelection.selectedCells.size > 0) {
            // 選択セルの中で最小の行と列を取得（左上のセルを基準に）
            let minRow = Infinity, minCol = Infinity;
            for (const cellId of calibrationTableSelection.selectedCells) {
                const [rowIndex, colIndex] = cellId.split('-').map(Number);
                if (rowIndex < minRow) minRow = rowIndex;
                if (colIndex < minCol) minCol = colIndex;
            }
            startRow = minRow;
            startCol = minCol;
        }

        // 選択セルが読み取り専用列（デジタイズ座標）の場合はエラー
        if (startCol < realCoordsStartCol) {
            showError('デジタイズ座標列には貼り付けできません。実空間座標列を選択してください。');
            return { success: false, error: '読み取り専用列' };
        }

        // 利用可能な行数を制限
        const maxRows = calibrationData.points.length;
        const availableRows = Math.min(clipboardRows, maxRows - startRow);

        if (availableRows <= 0) {
            console.error(`Row out of range: start row ${startRow + 1} exceeds max ${maxRows}`);
            showError(`行範囲外です。開始行${startRow + 1}は最大行${maxRows}を超えています。`);
            return { success: false, error: '行範囲外' };
        }

        // 実空間座標の終了列インデックス
        const realCoordsEndCol = realCoordsStartCol + realCoordsCols - 1;

        let pastedCount = 0;

        // データを貼り付け
        for (let i = 0; i < availableRows; i++) {
            const rowData = rows[i].split('\t'); // タブ区切りで列を分割
            const targetRowIndex = startRow + i;
            const pointIndex = targetRowIndex;

            // 各列を処理
            for (let j = 0; j < rowData.length; j++) {
                const targetColIndex = startCol + j;

                // 実空間座標列の範囲外はスキップ
                if (targetColIndex < realCoordsStartCol || targetColIndex > realCoordsEndCol) {
                    continue;
                }

                const value = rowData[j]?.trim();
                if (!value) continue;

                const numValue = parseFloat(value);
                if (isNaN(numValue)) continue;

                // セルを取得して更新
                const cellId = `${targetRowIndex}-${targetColIndex}`;
                const cell = getCalibrationCellFromId(cellId);
                if (!cell) continue;

                // セルの内容を更新
                cell.textContent = numValue;
                pastedCount++;

                // データも更新
                const point = calibrationData.points[pointIndex];
                if (point) {
                    if (!point.realCoords) {
                        point.realCoords = { x: null, y: null, z: null };
                    }

                    // 実空間座標のどの列か判定
                    const realColOffset = targetColIndex - realCoordsStartCol;
                    if (realColOffset === 0) {
                        point.realCoords.x = numValue;
                    } else if (realColOffset === 1) {
                        point.realCoords.y = numValue;
                    } else if (realColOffset === 2 && isThreeDim) {
                        point.realCoords.z = numValue;
                    }
                }

                console.log(`Updated cell ${cellId} with "${numValue}" (realCoords col ${targetColIndex - realCoordsStartCol})`);
            }
        }

        console.log(`Paste operation completed: ${pastedCount} cells updated`);

        // 処理された行数、列数、成功フラグを返す
        return { success: pastedCount > 0, rows: availableRows, cols: clipboardCols };

    } catch (error) {
        console.error('Calibration paste data processing error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * キャリブレーション貼り付けセルを更新
 */
function updateCalibrationPastedCells(clipboardRows, clipboardCols) {

    // 実空間座標の更新を反映
    updateCalibrationDataTable();
}

/**
 * キャリブレーションセルをクリア
 * - デジタイズ座標列（Calポイント名、カメラ1/2座標）は削除不可
 * - 実空間座標列のみ削除可能
 */
function clearCalibrationCells() {
    // キャリブレーション方法を取得して列構造を判定
    const method = document.getElementById('calibration-method').value;
    const isTwoCamera = method === '3d-dlt' || method === 'checkerboard' || method === '2d-dlt-stereo' || method === '3d-cc-method';
    const isThreeDim = method === '3d-dlt' || method === 'checkerboard' || method === '3d-cc-method';

    // 読み取り専用列の数を計算
    const readOnlyColCount = isTwoCamera ? 3 : 2;

    // 実空間座標列の開始インデックス
    const realCoordsStartCol = readOnlyColCount;

    // 実空間座標列の数 (x, y, z or x, y)
    const realCoordsCols = isThreeDim ? 3 : 2;
    const realCoordsEndCol = realCoordsStartCol + realCoordsCols - 1;

    const cellsToDelete = [];
    let readOnlySkipped = false;

    // 削除対象のセルを収集（実空間座標列のみ）
    calibrationTableSelection.selectedCells.forEach(cellId => {
        const [rowIndex, colIndex] = cellId.split('-').map(Number);
        const pointIndex = rowIndex;

        // 読み取り専用列はスキップ
        if (colIndex < realCoordsStartCol || colIndex > realCoordsEndCol) {
            readOnlySkipped = true;
            return;
        }

        if (pointIndex >= 0 && pointIndex < window.calibrationData.points.length) {
            const point = window.calibrationData.points[pointIndex];
            const realColOffset = colIndex - realCoordsStartCol;
            // バックアップ（現在の値を保存）
            let oldValue = null;
            if (point.realCoords) {
                if (realColOffset === 0) oldValue = point.realCoords.x;
                else if (realColOffset === 1) oldValue = point.realCoords.y;
                else if (realColOffset === 2 && isThreeDim) oldValue = point.realCoords.z;
            }
            cellsToDelete.push({
                pointIndex: pointIndex,
                colIndex: colIndex,
                realColOffset: realColOffset,
                oldValue: oldValue
            });
        }
    });

    if (cellsToDelete.length === 0) {
        if (readOnlySkipped) {
            showMessage('デジタイズ座標列は削除できません。実空間座標列を選択してください。');
        } else {
            showMessage('削除するセルを選択してください');
        }
        return;
    }

    const is3d = isThreeDim;
    const command = {
        description: `キャリブレーション ${cellsToDelete.length}セル削除`,
        execute: () => {
            cellsToDelete.forEach(cd => {
                const point = window.calibrationData.points[cd.pointIndex];
                if (!point || !point.realCoords) return;
                if (cd.realColOffset === 0) point.realCoords.x = null;
                else if (cd.realColOffset === 1) point.realCoords.y = null;
                else if (cd.realColOffset === 2 && is3d) point.realCoords.z = null;
            });
            if (typeof window.updateCalibrationDataTable === 'function') window.updateCalibrationDataTable();
        },
        undo: () => {
            cellsToDelete.forEach(cd => {
                const point = window.calibrationData.points[cd.pointIndex];
                if (!point) return;
                if (!point.realCoords) point.realCoords = { x: null, y: null, z: null };
                if (cd.realColOffset === 0) point.realCoords.x = cd.oldValue;
                else if (cd.realColOffset === 1) point.realCoords.y = cd.oldValue;
                else if (cd.realColOffset === 2 && is3d) point.realCoords.z = cd.oldValue;
            });
            if (typeof window.updateCalibrationDataTable === 'function') window.updateCalibrationDataTable();
        }
    };

    if (window.undoManager) {
        window.undoManager.execute(command);
    } else {
        command.execute();
    }

    const msg = readOnlySkipped
        ? `${cellsToDelete.length}個のセルを削除しました（デジタイズ座標列はスキップ）`
        : `${cellsToDelete.length}個のセルを削除しました`;
    showMessage(msg);
}

/**
 * キャリブレーションテーブルの選択境界線を更新（CSSクラスベース）
 */
function updateCalibrationSelectionHighlight() {
    const tableBody = document.getElementById('calibration-table-body');
    if (!tableBody) return;

    // 既存の選択クラスをクリア
    const allCells = tableBody.querySelectorAll('td');
    allCells.forEach(cell => {
        cell.classList.remove('cal-selection-top', 'cal-selection-bottom', 'cal-selection-left', 'cal-selection-right', 'cal-selected');
    });

    if (calibrationTableSelection.selectedCells.size === 0) return;

    // 選択範囲の境界を計算
    let minRow = Infinity, maxRow = -Infinity;
    let minCol = Infinity, maxCol = -Infinity;

    calibrationTableSelection.selectedCells.forEach(cellId => {
        const [rowIndex, colIndex] = cellId.split('-').map(Number);
        minRow = Math.min(minRow, rowIndex);
        maxRow = Math.max(maxRow, rowIndex);
        minCol = Math.min(minCol, colIndex);
        maxCol = Math.max(maxCol, colIndex);
    });

    // 選択範囲内のセルにクラスを付与
    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            const cell = getCalibrationCellFromId(`${row}-${col}`);
            if (!cell) continue;

            cell.classList.add('cal-selected');

            // 境界線クラスを付与
            if (row === minRow) cell.classList.add('cal-selection-top');
            if (row === maxRow) cell.classList.add('cal-selection-bottom');
            if (col === minCol) cell.classList.add('cal-selection-left');
            if (col === maxCol) cell.classList.add('cal-selection-right');
        }
    }
}

// ========================================
// エクスポート（他モジュールで使用される関数）
// ========================================

// モーションデータテーブル関連
window.updateMotionDataTable = updateMotionDataTable;
window.updateDataTableCell = updateDataTableCell;
window.clearDataTable = clearDataTable;
window.updateMotionDataTableForCurrentCamera = updateMotionDataTableForCurrentCamera;

// キャリブレーションテーブル関連
window.updateCalibrationDataTable = updateCalibrationDataTable;
window.copyCalibrationCellsToClipboard = copyCalibrationCellsToClipboard;
window.pasteToCalibrationTable = pasteToCalibrationTable;
window.deleteCalibrationSelectedCells = clearCalibrationCells;

// テーブルハイライト
window.updateTableHighlights = updateTableHighlights;

// テーブル選択機能
window.initializeTableSelection = initializeTableSelection;

/**
 * Undo対応版削除機能
 */
function deleteSelectedCellsWithUndo() {
    if (tableSelection.selectedCells.size === 0) {
        showMessage('削除するセルを選択してください');
        return;
    }

    // 削除対象データのバックアップ（Undo用）
    const cellsToDelete = [];
    const currentCam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';

    tableSelection.selectedCells.forEach(cellId => {
        const [rowIndex, colIndex] = cellId.split('-').map(Number);
        if (colIndex === 0) return; // フレーム番号列は除外

        const pointIndex = colIndex - 1;
        if (pointIndex >= 0 && pointIndex < motionPoints.length) {
            const point = motionPoints[pointIndex];
            const frameNumber = rowIndex + 1;

            // cameraDigitizeData からデータを取得
            let coord = null;
            if (window.cameraDigitizeData && window.cameraDigitizeData[currentCam]) {
                const map = window.cameraDigitizeData[currentCam][frameNumber];
                if (map) {
                    // MapまたはObjectの両対応
                    if (map instanceof Map) {
                        if (map.has(point.id)) coord = { ...map.get(point.id) };
                    } else if (map[point.id]) {
                        coord = { ...map[point.id] };
                    }
                }
            }

            // データが存在する場合のみバックアップ
            if (coord) {
                cellsToDelete.push({
                    cellId: cellId,
                    frameNumber: frameNumber,
                    pointId: point.id,
                    rowIndex: rowIndex,
                    colIndex: colIndex,
                    previousCoord: coord
                });
            }
        }
    });

    if (cellsToDelete.length === 0) {
        showMessage('削除可能なデータが選択範囲にありません');
        return;
    }

    // Commandオブジェクト作成
    const command = {
        description: `${cellsToDelete.length}セル削除`,
        execute: () => {
            const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
            const store = window.cameraDigitizeData && window.cameraDigitizeData[cam];

            if (store) {
                cellsToDelete.forEach(item => {
                    const frameMap = store[item.frameNumber];
                    if (frameMap) {
                        if (frameMap instanceof Map) frameMap.delete(item.pointId);
                        else delete frameMap[item.pointId];
                    }
                });
            }

            // UI更新
            updateDeletedCells(cellsToDelete); // 引数形式を合わせる必要あり
            try { if (typeof window.clearMemoizedTableData === 'function') window.clearMemoizedTableData(); } catch (_) { }
            try { if (typeof window.redrawCanvas === 'function') window.redrawCanvas(); } catch (_) { }
        },
        undo: () => {
            // データの復元
            const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
            if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
            if (!window.cameraDigitizeData[cam]) window.cameraDigitizeData[cam] = {};

            cellsToDelete.forEach(item => {
                if (!window.cameraDigitizeData[cam][item.frameNumber]) {
                    window.cameraDigitizeData[cam][item.frameNumber] = new Map();
                }
                const frameMap = window.cameraDigitizeData[cam][item.frameNumber];
                if (frameMap instanceof Map) {
                    frameMap.set(item.pointId, item.previousCoord);
                } else {
                    frameMap[item.pointId] = item.previousCoord;
                }

                // UI復元
                const tableBody = document.getElementById('data-table-body');
                if (tableBody) {
                    const row = tableBody.rows[item.rowIndex];
                    if (row) {
                        const cell = row.cells[item.colIndex];
                        if (cell) {
                            cell.textContent = `${Math.round(item.previousCoord.x)}, ${Math.round(item.previousCoord.y)}`;
                            cell.classList.add('point-cell');
                        }
                    }
                }
            });
            try { if (typeof window.clearMemoizedTableData === 'function') window.clearMemoizedTableData(); } catch (_) { }
            try { if (typeof window.redrawCanvas === 'function') window.redrawCanvas(); } catch (_) { }
        }
    };

    // 実行
    if (window.undoManager) {
        window.undoManager.execute(command);
    } else {
        command.execute();
    }

    showMessage(`${cellsToDelete.length}個のセルのデータを削除しました`);
}
window.deleteSelectedCellsWithUndo = deleteSelectedCellsWithUndo;

/**
 * Undo対応版貼り付け機能
 */
async function pasteFromClipboardWithUndo() {
    if (tableSelection.selectedCells.size === 0) {
        showMessage('貼り付け先のセルを選択してください');
        return;
    }

    try {
        const clipboardText = await navigator.clipboard.readText();
        if (!clipboardText.trim()) {
            showMessage('クリップボードにデータがありません');
            return;
        }

        // 貼り付け前に影響を受ける範囲のバックアップを取得する必要がある
        // processPasteData はデータを解析するだけで書き込みはしないので、これを利用して範囲を特定
        // ただし processPasteData は現状、書き込みまで行っている部分（cameraDigitizeData.set）があるため、
        // 修正するか、あるいは processPasteData を呼び出した後に、変更された箇所を戻すための情報を集めるか。

        // ここでは、processPasteData を解析のみ行うように変更するのが手間なので、
        // processPasteData が返す情報（どの行、どの列が対象か）は完全ではないため、
        // 貼り付け実行前に現在の選択範囲開始位置とクリップボード内容から、上書きされる可能性のある領域を計算してバックアップする。

        const rows = clipboardText.trim().split('\n').map(row => row.replace(/\r/g, ''));
        const clipboardRows = rows.length;
        const clipboardCols = Math.max(...rows.map(row => row.split('\t').length));

        // 開始位置
        const firstId = Array.from(tableSelection.selectedCells)[0];
        const [startRow, startCol] = firstId.split('-').map(Number);
        const maxFrameCount = projectData.settings.motionFrameCount;
        const availableRows = Math.min(clipboardRows, maxFrameCount - startRow);

        if (availableRows <= 0) return;

        // バックアップ用データ収集
        const backupData = [];
        const currentCam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';

        // 簡易的に、単一セル選択からの貼り付け（矩形貼り付け）を想定
        // 複数セル選択への貼り付けは processPasteData の実装によるが、基本は矩形と想定

        // 座標ペア処理などを考慮すると複雑になるため、
        // Commandのexecute内で貼り付けを行い、その返り値（実際に更新された詳細）を使いたいところだが、
        // UndoManagerの設計上、execute実行前にUndo情報を確定させる必要がある、またはexecuteがUndo情報を返す必要がある。
        // 現在のUndoManagerは execute(command) なので、command作成時にUndo情報が必要。

        // 戦略: 
        // 1. 貼り付け処理をシミュレートして、上書きされるセルを特定し、バックアップ。
        // 2. Command作成。

        // ここでは実装を簡略化するため、pasteFromClipboardのロジックを参考にバックアップ範囲を決定

        for (let i = 0; i < availableRows; i++) {
            const rowData = rows[i].split('\t');
            const targetRowIndex = startRow + i;
            const frameNumber = targetRowIndex + 1;

            // クリップボードの列構造と現在の選択位置から、上書きされるポイントIDを特定
            // （詳細なロジックは processPasteData と重複するが簡略化して実装）

            // 貼り付けロジックが複雑（2列ペア判定など）なので、
            // processPasteData を「ドライラン（書き込みなし）」モードで実行して変更対象を取得できるようにリファクタリングするのがベストだが、
            // ここでは既存関数を変更せず、Commandのexecute内で「変更前の値」を保存するアプローチをとる。
            // UndoManagerを少し拡張するか、Command自体が状態を持つようにする。
        }

        // 変数スコープの問題があるため、Commandのundoメソッドがクロージャーとしてバックアップデータを保持するようにする。
        // executeが最初に呼ばれたときにバックアップを取る（初回のみ）。

        // ただし、UndoManager.execute(cmd) -> cmd.execute() と呼ばれる。
        // cmd.execute() 内でバックアップを取ればよい。

        let undoData = null; // { [frame]: { [pointId]: {x, y} } }

        const command = {
            description: '貼り付け',
            execute: async () => {
                if (undoData === null) {
                    // 初回実行時：バックアップを取得
                    undoData = {};

                    // 貼り付け実行（既存関数を呼び出すわけにはいかない、なぜなら既存関数はUndo対応していないためデータの書き換えを行ってしまうが、
                    // ここで書き換えの直前にデータを取得するのは難しい。
                    // したがって、既存の processPasteData を改造して「変更履歴」を返すようにするか、
                    // ここで独自に貼り付けロジックを実装しつつバックアップも取る）

                    // 独自実装（pasteFromClipboardのロジックを移植・改変）
                    const result = processPasteDataWithTracking(clipboardText); // 新規作成
                    if (result.success) {
                        undoData = result.backup;

                        // UI更新などは processPasteDataWithTracking 内で行うか、結果を受けてここで行う
                        updatePastedCells(result.rows, result.cols);
                        try {
                            if (tableSelection.selectedCells.size > 0) {
                                commitPastedMotionDataToCamera(startRow, result.rows);
                            }
                        } catch (e) { }
                        clearTableSelection();
                        showMessage('エクセルデータを貼り付けました');
                    } else {
                        // 失敗時
                        showMessage('貼り付けに失敗しました');
                    }
                } else {
                    // Redo時：undoData（変更前）ではなく、変更後のデータ（Commandに保存すべきだが...）
                    // 単純に再度 processPasteDataWithTracking を呼んで上書きすればよい（同じ結果になるはず）
                    const result = processPasteDataWithTracking(clipboardText);
                    if (result.success) {
                        updatePastedCells(result.rows, result.cols);
                        try {
                            if (tableSelection.selectedCells.size > 0) {
                                commitPastedMotionDataToCamera(startRow, result.rows);
                            }
                        } catch (e) { }
                        clearTableSelection();
                    }
                }
            },
            undo: () => {
                if (!undoData) return;

                // データの復元
                const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
                const store = window.cameraDigitizeData && window.cameraDigitizeData[cam];

                if (store) {
                    Object.keys(undoData).forEach(fNum => {
                        const frameNumber = Number(fNum);
                        const points = undoData[fNum];

                        if (!store[frameNumber]) store[frameNumber] = new Map();

                        Object.keys(points).forEach(pId => {
                            const pointId = Number(pId);
                            const val = points[pId];

                            if (val === null) {
                                // もともとデータがなかった -> 削除
                                if (store[frameNumber] instanceof Map) store[frameNumber].delete(pointId);
                                else delete store[frameNumber][pointId];
                            } else {
                                // 復元
                                if (store[frameNumber] instanceof Map) store[frameNumber].set(pointId, val);
                                else store[frameNumber][pointId] = val;
                            }
                        });
                    });
                }

                // UI再描画（全体更新が確実）
                try { if (typeof window.clearMemoizedTableData === 'function') window.clearMemoizedTableData(); } catch (_) { }
                try { if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera(); } catch (_) { }
                try { if (typeof window.redrawCanvas === 'function') window.redrawCanvas(); } catch (_) { }
            }
        };

        // 非同期実行のため、UndoManagerの扱い注意（現状のUndoManagerは同期execute前提だが、
        // executeがPromiseを返しても、スタックに積むのは同期的なら問題ない。
        // ただし、execute内の処理が終わるまで待つ必要がある。）

        // ここでは簡易的に、Commandオブジェクトを即座に作り、executeメソッド内で非同期処理を行う。
        if (window.undoManager) {
            window.undoManager.execute(command);
        } else {
            command.execute();
        }

    } catch (error) {
        showError('クリップボードからの読み取りに失敗しました');
    }
}
window.pasteFromClipboardWithUndo = pasteFromClipboardWithUndo;

/**
 * トラッキング付き貼り付けデータ処理（バックアップを生成）
 * 複数セル選択時は選択範囲全体にクリップボードデータを繰り返し貼り付け（Excel風動作）
 */
function processPasteDataWithTracking(clipboardText) {
    try {
        const rows = clipboardText.trim().split('\n').map(row => row.replace(/\r/g, ''));
        const clipboardRowCount = rows.length;
        const clipboardColCount = Math.max(...rows.map(row => row.split('\t').length));

        // 選択範囲の境界を計算
        let minRow = Infinity, maxRow = -Infinity;
        let minCol = Infinity, maxCol = -Infinity;

        if (tableSelection.selectedCells.size > 0) {
            tableSelection.selectedCells.forEach(cellId => {
                const [rowIndex, colIndex] = cellId.split('-').map(Number);
                minRow = Math.min(minRow, rowIndex);
                maxRow = Math.max(maxRow, rowIndex);
                minCol = Math.min(minCol, colIndex);
                maxCol = Math.max(maxCol, colIndex);
            });
        } else {
            return { success: false };
        }

        const selectionRowCount = maxRow - minRow + 1;
        const selectionColCount = maxCol - minCol + 1;

        // 貼り付け範囲を決定
        // 複数セル選択の場合：選択範囲にクリップボードデータを繰り返し貼り付け
        // 単一セル選択の場合：クリップボードデータのサイズ分だけ貼り付け
        const isMultiCellSelection = tableSelection.selectedCells.size > 1;
        const targetRowCount = isMultiCellSelection ? selectionRowCount : clipboardRowCount;

        const maxFrameCount = projectData.settings.motionFrameCount;
        const availableRows = Math.min(targetRowCount, maxFrameCount - minRow);
        if (availableRows <= 0) return { success: false };

        let pastedCount = 0;
        const backup = {}; // { frameNumber: { pointId: {x,y} | null } }
        const currentCam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';

        // データ格納用ヘルパー
        const saveToStore = (frame, pid, x, y) => {
            if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
            if (!window.cameraDigitizeData[currentCam]) window.cameraDigitizeData[currentCam] = {};
            if (!window.cameraDigitizeData[currentCam][frame]) window.cameraDigitizeData[currentCam][frame] = new Map();

            // バックアップ取得
            if (!backup[frame]) backup[frame] = {};
            if (backup[frame][pid] === undefined) { // まだバックアップされていなければ
                const oldMap = window.cameraDigitizeData[currentCam][frame];
                let oldVal = null;
                if (oldMap instanceof Map) {
                    if (oldMap.has(pid)) oldVal = { ...oldMap.get(pid) };
                } else {
                    if (oldMap[pid]) oldVal = { ...oldMap[pid] };
                }
                backup[frame][pid] = oldVal;
            }

            // 保存
            window.cameraDigitizeData[currentCam][frame].set(pid, { x, y });
        };

        for (let i = 0; i < availableRows; i++) {
            // クリップボードデータを繰り返し使用（モジュロ演算）
            const clipboardRowIndex = i % clipboardRowCount;
            const rowData = rows[clipboardRowIndex].split('\t');
            const targetRowIndex = minRow + i;
            const frameNumber = targetRowIndex + 1;

            if (clipboardColCount >= 2 && rowData.length >= 2) {
                const coordinatePairs = Math.floor(clipboardColCount / 2);
                for (let pairIndex = 0; pairIndex < coordinatePairs; pairIndex++) {
                    const colOffset = pairIndex * 2;
                    const xData = rowData[colOffset]?.trim();
                    const yData = rowData[colOffset + 1]?.trim();

                    if (isNumeric(xData) && isNumeric(yData)) {
                        const x = parseFloat(xData);
                        const y = parseFloat(yData);
                        if (!isNaN(x) && !isNaN(y)) {
                            const targetColIndex = minCol + pairIndex;
                            const pointIndex = targetColIndex - 1;
                            if (pointIndex >= 0 && pointIndex < motionPoints.length) {
                                const point = motionPoints[pointIndex];
                                saveToStore(frameNumber, point.id, x, y);
                                pastedCount++;
                            }
                        }
                    }
                }
            } else {
                for (let j = 0; j < rowData.length; j++) {
                    const targetColIndex = minCol + j;
                    if (targetColIndex === 0) continue;

                    const pointIndex = targetColIndex - 1;
                    if (pointIndex >= motionPoints.length) break;

                    const point = motionPoints[pointIndex];

                    // 2列データ処理（X,Y）
                    if (j + 1 < rowData.length) {
                        const xData = rowData[j]?.trim();
                        const yData = rowData[j + 1]?.trim();
                        if (isNumeric(xData) && isNumeric(yData)) {
                            const x = parseFloat(xData);
                            const y = parseFloat(yData);
                            if (!isNaN(x) && !isNaN(y)) {
                                saveToStore(frameNumber, point.id, x, y);
                                pastedCount++;
                                j++; // Y列スキップ
                                continue;
                            }
                        }
                    }

                    // 単一データ
                    const cellData = rowData[j]?.trim();
                    if (cellData && cellData !== '') {
                        const coords = parseCoordinates(cellData);
                        if (coords) {
                            saveToStore(frameNumber, point.id, coords.x, coords.y);
                            pastedCount++;
                        }
                    }
                }
            }
        }

        return { success: pastedCount > 0, rows: availableRows, cols: clipboardColCount, backup: backup };

    } catch (error) {
        return { success: false };
    }
}
window.processPasteDataWithTracking = processPasteDataWithTracking;


/**
 * キャリブレーション行クリック時の処理
 * - 対応するランドマークを選択可能にする
 * - 保存された動画インデックスに基づいて動画を切り替える
 * - 保存されたフレーム番号にシークする
 */
function handleCalibrationRowClick(point) {
    if (!point || !point.digitizedCoords) return;

    // まずランドマークを選択
    if (typeof setSelectedLandmark === 'function') {
        setSelectedLandmark(point);
    }
    // UI更新
    const select = document.getElementById('calibration-landmark-select');
    if (select) {
        select.value = point.id;
        if (typeof onCalibrationLandmarkChange === 'function') {
            onCalibrationLandmarkChange();
        }
    }

    // 現在のカメラを取得
    const currentCamera = getCurrentCamera(); // 'cam1' or 'cam2'
    if (!currentCamera) return;

    // データを確認
    const coords = point.digitizedCoords[currentCamera];
    if (!coords) return;

    // 動画切り替えロジック
    // videoIndexが保存されていればそれを使用
    if (typeof coords.videoIndex === 'number') {
        const modePrefix = getCurrentMode() === 'calibration' ? 'cal-' : 'motion-';
        const fileKey = modePrefix + currentCamera;

        // 現在のインデックスを確認
        let currentIndex = -1;
        if (window.fileStateLists && window.fileStateLists[fileKey] && window.fileState && window.fileState[fileKey]) {
            const current = window.fileState[fileKey];
            const currentPath = typeof current === 'string' ? current : current.path;
            const list = window.fileStateLists[fileKey];
            currentIndex = list.findIndex(f => (typeof f === 'string' ? f : f.path) === currentPath);
        }

        // 異なる場合は切り替え
        if (currentIndex !== coords.videoIndex && coords.videoIndex >= 0) {
            if (typeof window.applyFileFromList === 'function') {
                window.applyFileFromList(fileKey, coords.videoIndex);
            }
        }
    }

    // フレーム移動ロジック
    // frameNumber (cam1) または frameNumber2 (cam2)
    let targetFrame = null;
    if (currentCamera === 'cam1') {
        targetFrame = point.frameNumber;
    } else if (currentCamera === 'cam2') {
        targetFrame = point.frameNumber2;
    }

    if (targetFrame && Number.isFinite(targetFrame)) {
        if (typeof setCurrentFrameNumber === 'function') {
            // 少し非同期にして動画切り替え後の適用を安定させる
            setTimeout(() => {
                setCurrentFrameNumber(targetFrame);
                if (typeof updateFrameInfo === 'function') updateFrameInfo();
                if (typeof displayCurrentFrame === 'function') displayCurrentFrame();
            }, 50);
        }
    }
}
window.handleCalibrationRowClick = handleCalibrationRowClick;

// ユーティリティ
window.isNumeric = isNumeric;
window.parseCoordinates = parseCoordinates;

// メモ化キャッシュクリア
window.clearMemoizedTableData = () => memoizedTableData.clear();

/*
 * =========================================================================================
 * CSV IMPORT FEATURE
 * =========================================================================================
 */

// HPEキーポイント名とMotionDigitizerのIDマップ
const HPE_KEYPOINT_MAP = {
    'right_hand_tip': 1,
    'right_wrist': 2,
    'right_elbow': 3,
    'right_shoulder': 4,
    'left_hand_tip': 5,
    'left_wrist': 6,
    'left_elbow': 7,
    'left_shoulder': 8,
    'right_toe_tip': 9,
    'right_small_toe': 10,
    'right_heel': 11,
    'right_ankle': 12,
    'right_knee': 13,
    'right_hip': 14,
    'left_toe_tip': 15,
    'left_small_toe': 16,
    'left_heel': 17,
    'left_ankle': 18,
    'left_knee': 19,
    'left_hip': 20,
    'head_top': 21,
    'tragus_point': 22,
    'suprasternal_notch': 23
};

/**
 * モーションデータCSVのインポート
 */
async function importMotionDataCSV() {
    try {
        const result = await ipcRenderer.invoke('select-file', {
            title: 'モーションデータCSVをインポート',
            filters: [{ name: 'CSV', extensions: ['csv'] }]
        });

        if (!result.success) return;

        const fileRes = await ipcRenderer.invoke('read-text-file', result.filePath);
        if (!fileRes.success) {
            if (typeof showError === 'function') showError('ファイル読み込みエラー');
            return;
        }

        const lines = fileRes.content.split(/\r?\n/).filter(line => line.trim() !== '');
        if (lines.length < 2) {
            if (typeof showError === 'function') showError('有効なデータがありません');
            return;
        }

        // カメラ選択ロジック
        let targetCamera = 'cam1';
        const methodEl = document.getElementById('calibration-method');
        const method = methodEl ? methodEl.value : '';
        const isStereoMode = ['2d-dlt-stereo', '3d-dlt', 'charuco-stereo', 'vicon-xcp-triangulation', '3d-cc-method'].includes(method);

        if (isStereoMode) {
            const choice = await ipcRenderer.invoke('show-message-box', {
                type: 'question',
                buttons: ['カメラ1', 'カメラ2', 'キャンセル'],
                defaultId: 0,
                cancelId: 2,
                title: 'インポート先選択',
                message: 'インポート先のカメラを選択してください'
            });

            if (choice.response === 0) targetCamera = 'cam1';
            else if (choice.response === 1) targetCamera = 'cam2';
            else return; // キャンセル
        } else {
            targetCamera = 'cam1';
        }

        // インポート対象フレームのバックアップ取得
        if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
        if (!window.cameraDigitizeData[targetCamera]) window.cameraDigitizeData[targetCamera] = {};

        const backupFrames = {};
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(s => s.trim());
            let frameNum = parseInt(cols[0]);
            if (isNaN(frameNum)) frameNum = i;
            const existing = window.cameraDigitizeData[targetCamera][frameNum];
            if (existing && existing instanceof Map && existing.size > 0) {
                backupFrames[frameNum] = new Map(existing);
            } else {
                backupFrames[frameNum] = null;
            }
        }

        // Undo対応コマンド
        const cam = targetCamera;
        const csvLines = lines;
        let importedCount = 0;
        // undo 用に現在の motionPoints をスナップショット保存
        const originalMotionPoints = JSON.parse(JSON.stringify(window.motionPoints || []));

        const command = {
            description: `CSVインポート (${cam === 'cam1' ? 'カメラ1' : 'カメラ2'})`,
            execute: () => {
                importedCount = processCSVData(csvLines, cam);
                if (typeof clearMemoizedTableData === 'function') clearMemoizedTableData();
                if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera();
                if (typeof window.redrawCanvas === 'function') window.redrawCanvas();
            },
            undo: () => {
                // 自動追加されたポイントを削除して元のリストに戻す
                window.motionPoints = JSON.parse(JSON.stringify(originalMotionPoints));
                if (typeof updatePointsTab === 'function') updatePointsTab();
                if (typeof updateMotionDataTableColumns === 'function') updateMotionDataTableColumns();

                Object.keys(backupFrames).forEach(fNum => {
                    const frameNum = Number(fNum);
                    if (backupFrames[fNum] === null) {
                        delete window.cameraDigitizeData[cam][frameNum];
                    } else {
                        window.cameraDigitizeData[cam][frameNum] = new Map(backupFrames[fNum]);
                    }
                });
                if (typeof clearMemoizedTableData === 'function') clearMemoizedTableData();
                if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera();
                if (typeof window.redrawCanvas === 'function') window.redrawCanvas();
            }
        };

        if (window.undoManager) {
            window.undoManager.execute(command);
        } else {
            command.execute();
        }

        if (typeof showMessage === 'function') {
            const addedPts = window.motionPoints.length - originalMotionPoints.length;
            const ptMsg = addedPts > 0 ? `、ポイント ${addedPts} 件を自動追加` : '';
            showMessage(`${importedCount} フレーム分のデータをインポートしました (${targetCamera === 'cam1' ? 'カメラ1' : 'カメラ2'}${ptMsg})`);
        }

    } catch (e) {
        const msg = 'インポートエラー: ' + (e.message || e);
        if (typeof showError === 'function') {
            showError(msg);
        } else {
            console.error(e);
            alert(msg);
        }
    }
}

/**
 * CSV ヘッダーの _x 列を順番に抽出し、CSV列順に motionPoints へ割り当てる。
 * - 既存ポイント: CSV名にリネーム
 * - CSV列数 > 既存ポイント数: 不足分を新規追加
 * 戻り値: { colEntries, addedCount }
 *   colEntries: [{pointId, xIdx, yIdx}, ...] (CSV列順)
 */
function syncMotionPointsFromCSVHeaders(headers) {
    if (!window.motionPoints) window.motionPoints = [];

    // CSV の _x 列を順番に収集
    const csvCols = []; // [{name, xIdx, yIdx}, ...]
    headers.forEach((h, i) => {
        if (!h.endsWith('_x')) return;
        const csvName = h.slice(0, -2);
        const yIdx = headers.indexOf(`${csvName}_y`);
        if (yIdx < 0) return;
        csvCols.push({ name: csvName, xIdx: i, yIdx });
    });

    let addedCount = 0;
    const colEntries = []; // [{pointId, xIdx, yIdx}, ...]

    csvCols.forEach((col, i) => {
        if (i < window.motionPoints.length) {
            // 既存ポイントをCSV名にリネーム
            window.motionPoints[i].name = col.name;
            window.motionPoints[i].engName = col.name;
            colEntries.push({ pointId: window.motionPoints[i].id, xIdx: col.xIdx, yIdx: col.yIdx });
        } else {
            // 新規ポイント追加
            const newId = window.motionPoints.length > 0
                ? Math.max(...window.motionPoints.map(p => p.id)) + 1
                : 1;
            const newPoint = { id: newId, name: col.name, engName: col.name, category: 'インポート' };
            window.motionPoints.push(newPoint);
            colEntries.push({ pointId: newId, xIdx: col.xIdx, yIdx: col.yIdx });
            addedCount++;
        }
    });

    if (csvCols.length > 0) {
        if (typeof updatePointsTab === 'function') updatePointsTab();
        if (typeof updateMotionDataTableColumns === 'function') updateMotionDataTableColumns();
    }
    return { colEntries, addedCount };
}

function processCSVData(lines, camera) {
    if (!lines || lines.length < 1) return 0;

    // ヘッダー解析
    const headers = lines[0].split(',').map(h => h.trim());

    // --- Step 1: ポイントをCSV列順に割り当て・リネーム ---
    const { colEntries } = syncMotionPointsFromCSVHeaders(headers);

    // --- Step 2: データ格納 ---
    if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
    if (!window.cameraDigitizeData[camera]) window.cameraDigitizeData[camera] = {};

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(s => s.trim());
        if (cols.length < 2) continue;

        let frameNum = parseInt(cols[0]);
        if (isNaN(frameNum)) frameNum = i;

        if (!window.cameraDigitizeData[camera][frameNum]) {
            window.cameraDigitizeData[camera][frameNum] = new Map();
        }

        const frameData = window.cameraDigitizeData[camera][frameNum];
        let hasData = false;

        colEntries.forEach(({ pointId, xIdx, yIdx }) => {
            if (xIdx < cols.length && yIdx < cols.length) {
                const xVal = parseFloat(cols[xIdx]);
                const yVal = parseFloat(cols[yIdx]);
                if (!isNaN(xVal) && !isNaN(yVal)) {
                    frameData.set(pointId, { x: xVal, y: yVal });
                    hasData = true;
                }
            }
        });
        if (hasData) count++;
    }
    return count;
}

// グローバル公開
window.importMotionDataCSV = importMotionDataCSV;

/**
 * HPEファイル（.hpe）からモーションデータをインポート
 */
async function importHPEData() {
    console.log('[HPE Import] 開始');

    try {
        // ファイル選択
        const result = await ipcRenderer.invoke('select-file', {
            title: 'HPEファイルをインポート',
            filters: [{ name: 'HPE Files', extensions: ['hpe'] }]
        });

        if (!result.success) {
            console.log('[HPE Import] ファイル選択キャンセル');
            return;
        }
        console.log('[HPE Import] ファイル選択:', result.filePath);

        // ファイル読み込み
        const fileRes = await ipcRenderer.invoke('read-text-file', result.filePath);
        if (!fileRes.success) {
            console.error('[HPE Import] ファイル読み込みエラー');
            if (typeof showError === 'function') showError('ファイル読み込みエラー');
            return;
        }
        console.log('[HPE Import] ファイル読み込み完了, サイズ:', fileRes.content.length);

        // JSONパース
        let hpeData;
        try {
            hpeData = JSON.parse(fileRes.content);
        } catch (e) {
            console.error('[HPE Import] JSONパースエラー:', e);
            if (typeof showError === 'function') showError('HPEファイルの形式が不正です');
            return;
        }
        console.log('[HPE Import] JSONパース完了, version:', hpeData.version);

        // データソース決定: filteredData優先、なければoriginalData
        let sourceData = null;
        let sourceName = '';

        if (hpeData.filteredData?.frames?.length > 0) {
            sourceData = hpeData.filteredData;
            sourceName = 'filteredData';
        } else if (hpeData.originalData?.frames?.length > 0) {
            sourceData = hpeData.originalData;
            sourceName = 'originalData';
        }

        if (!sourceData) {
            console.error('[HPE Import] フレームデータなし');
            if (typeof showError === 'function') showError('HPEファイルにフレームデータがありません');
            return;
        }

        console.log('[HPE Import] データソース:', sourceName, ', フレーム数:', sourceData.frames.length);
        const filteredData = sourceData;

        // 利用可能なperson IDとフレーム数を収集
        const personFrameCounts = new Map(); // personId -> frameCount

        for (const frameData of filteredData.frames) {
            if (frameData.keypoints) {
                for (const personId of Object.keys(frameData.keypoints)) {
                    const kpts = frameData.keypoints[personId];
                    if (kpts && kpts.length > 0) {
                        // Check if any keypoint has high confidence
                        let hasValidKeypoint = false;
                        for (const kp of kpts) {
                            if (kp && kp.length > 2 && kp[2] >= 0.1) {
                                hasValidKeypoint = true;
                                break;
                            }
                        }

                        if (hasValidKeypoint) {
                            const count = personFrameCounts.get(personId) || 0;
                            personFrameCounts.set(personId, count + 1);
                        }
                    }
                }
            }
        }

        // フレーム数の降順でソート
        const personIdList = Array.from(personFrameCounts.keys()).sort((a, b) => {
            const countA = personFrameCounts.get(a);
            const countB = personFrameCounts.get(b);
            return countB - countA; // 降順
        });

        console.log('[HPE Import] 利用可能なPerson ID (フレーム数順):', personIdList.map(id => `${id} (${personFrameCounts.get(id)})`));

        if (personIdList.length === 0) {
            console.error('[HPE Import] Person IDが見つかりません');
            if (typeof showError === 'function') showError('HPEファイルに人物データがありません');
            return;
        }

        // Person選択ダイアログ
        let selectedPersonId = personIdList[0];
        if (personIdList.length > 1) {
            const personButtons = personIdList.map(id => `Person ${id} (${personFrameCounts.get(id)} frames)`);
            personButtons.push('キャンセル');

            const personChoice = await ipcRenderer.invoke('show-message-box', {
                type: 'question',
                buttons: personButtons,
                defaultId: 0,
                cancelId: personButtons.length - 1,
                title: 'Person選択',
                message: `インポートするPersonを選択してください\n(${personIdList.length}人検出)`
            });

            if (personChoice.response === personButtons.length - 1) {
                console.log('[HPE Import] Person選択キャンセル');
                return;
            }
            selectedPersonId = personIdList[personChoice.response];
        }
        console.log('[HPE Import] 選択されたPerson ID:', selectedPersonId);

        // カメラ選択ダイアログ（常に表示）
        const cameraChoice = await ipcRenderer.invoke('show-message-box', {
            type: 'question',
            buttons: ['カメラ1', 'カメラ2', 'キャンセル'],
            defaultId: 0,
            cancelId: 2,
            title: 'インポート先カメラ選択',
            message: 'インポート先のカメラを選択してください'
        });

        let targetCamera;
        if (cameraChoice.response === 0) targetCamera = 'cam1';
        else if (cameraChoice.response === 1) targetCamera = 'cam2';
        else {
            console.log('[HPE Import] カメラ選択キャンセル');
            return;
        }
        console.log('[HPE Import] 選択されたカメラ:', targetCamera);

        // インポート対象フレームのバックアップ取得
        const backupFrames = {};
        if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
        if (!window.cameraDigitizeData[targetCamera]) window.cameraDigitizeData[targetCamera] = {};

        for (const frameData of filteredData.frames) {
            const frameNum = frameData.frame;
            if (!frameNum) continue;
            const existing = window.cameraDigitizeData[targetCamera][frameNum];
            if (existing && existing instanceof Map && existing.size > 0) {
                backupFrames[frameNum] = new Map(existing);
            } else {
                backupFrames[frameNum] = null; // 元々データなし
            }
        }

        // Undo対応コマンド
        const cam = targetCamera;
        const hpeFilteredData = filteredData;
        const hpePersonId = selectedPersonId;
        let importedCount = 0;

        const command = {
            description: `HPEインポート (${cam === 'cam1' ? 'カメラ1' : 'カメラ2'})`,
            execute: () => {
                importedCount = processHPEData(hpeFilteredData, cam, hpePersonId);
                if (typeof clearMemoizedTableData === 'function') clearMemoizedTableData();
                if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera();
                if (typeof window.redrawCanvas === 'function') window.redrawCanvas();
            },
            undo: () => {
                // バックアップからデータ復元
                Object.keys(backupFrames).forEach(fNum => {
                    const frameNum = Number(fNum);
                    if (backupFrames[fNum] === null) {
                        // 元々データなし → フレーム削除
                        delete window.cameraDigitizeData[cam][frameNum];
                    } else {
                        // 元のデータに復元
                        window.cameraDigitizeData[cam][frameNum] = new Map(backupFrames[fNum]);
                    }
                });
                if (typeof clearMemoizedTableData === 'function') clearMemoizedTableData();
                if (typeof updateMotionDataTableForCurrentCamera === 'function') updateMotionDataTableForCurrentCamera();
                if (typeof window.redrawCanvas === 'function') window.redrawCanvas();
            }
        };

        if (window.undoManager) {
            window.undoManager.execute(command);
        } else {
            command.execute();
        }

        console.log('[HPE Import] インポート完了, フレーム数:', importedCount);

        if (typeof showMessage === 'function') {
            showMessage(`${importedCount} フレーム分のHPEデータをインポートしました (Person ${selectedPersonId} → ${targetCamera === 'cam1' ? 'カメラ1' : 'カメラ2'})`);
        }

    } catch (e) {
        console.error('[HPE Import] エラー:', e);
        const msg = 'HPEインポートエラー: ' + (e.message || e);
        if (typeof showError === 'function') {
            showError(msg);
        } else {
            alert(msg);
        }
    }
}

/**
 * HPEデータを処理してcameraDigitizeDataに格納
 * @param {Object} filteredData - HPEのfilteredDataオブジェクト
 * @param {string} camera - 'cam1' または 'cam2'
 * @param {string} selectedPersonId - 選択されたPerson ID
 */
function processHPEData(filteredData, camera, selectedPersonId) {
    if (!filteredData || !filteredData.frames) return 0;

    console.log('[HPE Process] 開始, camera:', camera, 'personId:', selectedPersonId);

    // データ格納先初期化
    if (!window.cameraDigitizeData) window.cameraDigitizeData = { cam1: {}, cam2: {} };
    if (!window.cameraDigitizeData[camera]) window.cameraDigitizeData[camera] = {};

    // keypoint_namesからインデックスマッピングを構築
    const keypointNames = filteredData.keypoint_names || [];
    const nameToIndex = {};
    keypointNames.forEach((name, idx) => {
        nameToIndex[name] = idx;
    });
    console.log('[HPE Process] キーポイント数:', keypointNames.length);

    let count = 0;

    // 各フレームを処理
    for (const frameData of filteredData.frames) {
        const frameNum = frameData.frame;
        if (!frameNum) continue;

        const keypoints = frameData.keypoints;
        if (!keypoints) continue;

        // 選択されたPerson IDのデータを取得
        const personKeypoints = keypoints[selectedPersonId];
        if (!personKeypoints || personKeypoints.length === 0) continue;

        // フレームデータの初期化
        if (!window.cameraDigitizeData[camera][frameNum]) {
            window.cameraDigitizeData[camera][frameNum] = new Map();
        }

        const targetFrameData = window.cameraDigitizeData[camera][frameNum];
        let hasData = false;

        // 各キーポイントを処理
        for (const [hpeKeyName, pointId] of Object.entries(HPE_KEYPOINT_MAP)) {
            const keypointIndex = nameToIndex[hpeKeyName];
            if (keypointIndex === undefined) continue;

            const pointData = personKeypoints[keypointIndex];
            if (!pointData || pointData.length < 2) continue;

            const x = pointData[0];
            const y = pointData[1];
            const confidence = pointData.length > 2 ? pointData[2] : 1.0;

            // 信頼度が低すぎるポイントはスキップ
            if (confidence < 0.1) continue;

            if (!isNaN(x) && !isNaN(y)) {
                targetFrameData.set(pointId, { x: x, y: y });
                hasData = true;
            }
        }

        if (hasData) count++;
    }

    return count;
}

window.importHPEData = importHPEData;

/* =========================================================================================
 * DATA MINIMAP FEATURE
 * =========================================================================================
 */

/**
 * データミニマップを更新（改善版）
 * ポイント名が横軸、フレームが縦軸になるように変更
 * クリックでテーブルの該当位置にスクロール
 */
function updateDataMinimap() {
    const canvas = document.getElementById('data-minimap-canvas');
    const infoEl = document.getElementById('data-minimap-info');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 凡例テキストをキャリブレーション方法に応じて変更
    const legendBothEl = document.getElementById('legend-both-cameras');
    if (legendBothEl) {
        const method = document.getElementById('calibration-method')?.value || '';
        const is3DMethod = ['3d-dlt', '3d-cc-method', 'charuco-stereo'].includes(method);
        legendBothEl.textContent = is3DMethod ? '両カメラあり (3D可)' : '両カメラあり';
    }

    // データ取得
    const cam1Data = window.cameraDigitizeData?.cam1 || {};
    const cam2Data = window.cameraDigitizeData?.cam2 || {};
    const motionPoints = window.motionPoints || [];

    if (motionPoints.length === 0) {
        // データなしの場合
        canvas.width = 400;
        canvas.height = 60;
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#999';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('ポイントデータがありません', canvas.width / 2, canvas.height / 2 + 5);
        if (infoEl) infoEl.textContent = 'フレーム: 0 / ポイント: 0';
        return;
    }

    // フレーム範囲を取得
    const allFrames = new Set();
    Object.keys(cam1Data).forEach(f => allFrames.add(parseInt(f)));
    Object.keys(cam2Data).forEach(f => allFrames.add(parseInt(f)));

    // 動画のフレーム数を優先使用
    let totalFrames = projectData?.settings?.motionFrameCount || 0;
    if (totalFrames <= 0 && allFrames.size > 0) {
        const frameArray = Array.from(allFrames).sort((a, b) => a - b);
        totalFrames = frameArray[frameArray.length - 1];
    }

    if (totalFrames <= 0) {
        canvas.width = 400;
        canvas.height = 60;
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#999';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('デジタイズデータがありません', canvas.width / 2, canvas.height / 2 + 5);
        if (infoEl) infoEl.textContent = 'フレーム: 0 / ポイント: ' + motionPoints.length;
        return;
    }

    const numPoints = motionPoints.length;
    const minFrame = 1;
    const maxFrame = totalFrames;

    // セルサイズ計算（横=ポイント、縦=フレーム）
    // 最大高さを400pxに設定（全フレームが収まるように自動調整）
    const maxCanvasHeight = 400;
    const headerHeight = 18;
    const labelWidth = 35;

    // コンテナの幅を取得（親要素の幅に合わせる）
    const container = canvas.parentElement;
    const containerWidth = container ? container.clientWidth - 20 : 600;
    const maxCanvasWidth = Math.max(400, containerWidth);

    // セル幅を計算（コンテナ幅を最大限活用）
    const availableWidth = maxCanvasWidth - labelWidth - 10;
    const cellWidth = Math.max(10, availableWidth / numPoints);

    // 全フレームが収まるようにセル高さを計算（最小値制限を削除）
    const availableHeight = maxCanvasHeight - headerHeight - 10;
    const cellHeight = availableHeight / totalFrames;

    // キャンバスサイズ設定（常に最大高さを使用して全体が見えるようにする）
    canvas.width = maxCanvasWidth;
    canvas.height = maxCanvasHeight;

    // 背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // ヘッダー（ポイント名目盛り）
    ctx.fillStyle = '#666';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    for (let pi = 0; pi < numPoints; pi++) {
        const point = motionPoints[pi];
        const x = labelWidth + pi * cellWidth + cellWidth / 2;
        // ポイントIDを表示
        ctx.fillText(point.id.toString(), x, 12);
    }

    // 左側ラベル（フレーム番号目盛り）
    ctx.textAlign = 'right';
    const frameStep = Math.max(1, Math.floor(totalFrames / 8));
    for (let fi = 0; fi < totalFrames; fi += frameStep) {
        const frameNum = minFrame + fi;
        const y = headerHeight + fi * cellHeight + cellHeight / 2 + 3;
        ctx.fillText(frameNum.toString(), labelWidth - 3, y);
    }

    // 色定義
    const COLOR_NONE = '#e8e8e8';      // データなし
    const COLOR_CAM1_ONLY = '#90caf9'; // Cam1のみ（青）
    const COLOR_CAM2_ONLY = '#ffcc80'; // Cam2のみ（オレンジ）
    const COLOR_BOTH = '#81c784';      // 両方あり（緑）

    // 各フレーム・ポイントのデータ有無をチェックして描画
    for (let fi = 0; fi < totalFrames; fi++) {
        const frameNum = minFrame + fi;
        const y = headerHeight + fi * cellHeight;

        for (let pi = 0; pi < numPoints; pi++) {
            const point = motionPoints[pi];
            const pointId = point.id;
            const x = labelWidth + pi * cellWidth;

            // cam1/cam2のデータチェック
            const cam1Frame = cam1Data[frameNum];
            const cam2Frame = cam2Data[frameNum];
            const hasCam1 = cam1Frame && cam1Frame.has && cam1Frame.has(pointId) && cam1Frame.get(pointId);
            const hasCam2 = cam2Frame && cam2Frame.has && cam2Frame.has(pointId) && cam2Frame.get(pointId);

            // 色決定
            let color = COLOR_NONE;
            if (hasCam1 && hasCam2) {
                color = COLOR_BOTH;
            } else if (hasCam1) {
                color = COLOR_CAM1_ONLY;
            } else if (hasCam2) {
                color = COLOR_CAM2_ONLY;
            }

            ctx.fillStyle = color;
            ctx.fillRect(x, y, cellWidth - 0.5, Math.max(cellHeight - 0.2, 0.3));
        }
    }

    // グリッド線（薄く）- ポイント区切り（縦線）
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
    ctx.lineWidth = 0.5;
    for (let pi = 0; pi <= numPoints; pi++) {
        const x = labelWidth + pi * cellWidth;
        ctx.beginPath();
        ctx.moveTo(x, headerHeight);
        ctx.lineTo(x, canvas.height - 10);
        ctx.stroke();
    }

    // 情報表示更新
    if (infoEl) {
        const cam1FrameCount = Object.keys(cam1Data).length;
        const cam2FrameCount = Object.keys(cam2Data).length;
        infoEl.textContent = `フレーム: ${minFrame} - ${maxFrame} (${totalFrames}フレーム) / ポイント: ${numPoints} / Cam1: ${cam1FrameCount}f, Cam2: ${cam2FrameCount}f`;
    }

    // ホバー情報表示
    canvas.onmousemove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (mx < labelWidth || my < headerHeight) return;

        const pi = Math.floor((mx - labelWidth) / cellWidth);
        const fi = Math.floor((my - headerHeight) / cellHeight);

        if (pi >= 0 && pi < numPoints && fi >= 0 && fi < totalFrames) {
            const frameNum = minFrame + fi;
            const point = motionPoints[pi];
            const pointName = point.name || `Point ${point.id}`;

            const cam1Frame = cam1Data[frameNum];
            const cam2Frame = cam2Data[frameNum];
            const hasCam1 = cam1Frame && cam1Frame.has && cam1Frame.has(point.id) && cam1Frame.get(point.id);
            const hasCam2 = cam2Frame && cam2Frame.has && cam2Frame.has(point.id) && cam2Frame.get(point.id);

            let status = 'データなし';
            if (hasCam1 && hasCam2) status = '両カメラあり';
            else if (hasCam1) status = 'Cam1のみ';
            else if (hasCam2) status = 'Cam2のみ';

            canvas.title = `Frame ${frameNum} / ${pointName}: ${status}`;
            canvas.style.cursor = 'pointer';
        }
    };

    canvas.onmouseleave = () => {
        canvas.title = '';
        canvas.style.cursor = 'default';
    };

    // クリックでテーブルにスクロール（位置比率に基づく）
    canvas.onclick = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (mx < labelWidth || my < headerHeight) return;

        // クリック位置の比率を計算
        const xRatio = (mx - labelWidth) / (canvas.width - labelWidth - 10);
        const yRatio = (my - headerHeight) / (canvas.height - headerHeight - 10);

        // 比率から対象のポイントとフレームを計算
        const pi = Math.min(Math.floor(xRatio * numPoints), numPoints - 1);
        const fi = Math.min(Math.floor(yRatio * totalFrames), totalFrames - 1);

        if (pi >= 0 && pi < numPoints && fi >= 0 && fi < totalFrames) {
            const frameNum = minFrame + fi;

            // 分析結果タブのテーブルにスクロール
            const table = document.getElementById('real-length-table');
            if (table) {
                const tbody = table.querySelector('tbody');
                const tableContainer = table.closest('.table-scroll-wrapper') || table.parentElement;

                if (tbody && tableContainer) {
                    // 対象行を取得
                    const targetRow = tbody.rows[fi];

                    if (targetRow) {
                        // 縦スクロール - 対象行を中央に表示
                        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });

                        // 横スクロール - 比率に基づいてスクロール位置を計算
                        setTimeout(() => {
                            const totalTableWidth = table.scrollWidth;
                            const containerWidth = tableContainer.clientWidth;
                            const targetScrollLeft = xRatio * (totalTableWidth - containerWidth);
                            tableContainer.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: 'smooth' });
                        }, 100);

                        // 対象セルをハイライト
                        const targetCell = targetRow.cells[pi + 1];
                        if (targetCell) {
                            targetCell.style.backgroundColor = '#ffeb3b';
                            setTimeout(() => {
                                targetCell.style.backgroundColor = '';
                            }, 1500);
                        }
                        targetRow.style.backgroundColor = '#fff9c4';
                        setTimeout(() => {
                            targetRow.style.backgroundColor = '';
                        }, 1500);
                    }
                }
            }

            // フレームにジャンプ
            if (typeof window.seekToFrame === 'function') {
                window.seekToFrame(frameNum);
            }
        }
    };
}

/**
 * ミニマップをクリックしたときにフレームへジャンプ
 */
function initializeMinimapClickHandler() {
    const canvas = document.getElementById('data-minimap-canvas');
    if (!canvas) return;

    canvas.onclick = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;

        // ラベル幅を取得（30px固定）
        const labelWidth = 30;
        if (mx < labelWidth) return;

        // フレーム範囲を再計算
        const cam1Data = window.cameraDigitizeData?.cam1 || {};
        const cam2Data = window.cameraDigitizeData?.cam2 || {};
        const allFrames = new Set();
        Object.keys(cam1Data).forEach(f => allFrames.add(parseInt(f)));
        Object.keys(cam2Data).forEach(f => allFrames.add(parseInt(f)));

        if (allFrames.size === 0) return;

        const frameArray = Array.from(allFrames).sort((a, b) => a - b);
        const minFrame = frameArray[0];
        const maxFrame = frameArray[frameArray.length - 1];
        const totalFrames = maxFrame - minFrame + 1;
        const cellWidth = Math.max(2, Math.min(6, Math.floor(800 / totalFrames)));

        const fi = Math.floor((mx - labelWidth) / cellWidth);
        if (fi >= 0 && fi < totalFrames) {
            const frameNum = minFrame + fi;
            // フレームにジャンプ
            if (typeof window.seekToFrame === 'function') {
                window.seekToFrame(frameNum);
            }
        }
    };
}

/**
 * モーションタブ用ミニマップを更新（改善版）
 * ポイント名が横軸、フレームが縦軸になるように変更
 * クリックでテーブルの該当位置にスクロール
 */
function updateMotionTabMinimap() {
    const canvas = document.getElementById('data-minimap');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 現在のカメラを取得
    const currentCam = typeof window.getCurrentCamera === 'function' ? window.getCurrentCamera() : 'cam1';
    const camData = window.cameraDigitizeData?.[currentCam] || {};
    const otherCam = currentCam === 'cam1' ? 'cam2' : 'cam1';
    const otherCamData = window.cameraDigitizeData?.[otherCam] || {};
    const motionPoints = window.motionPoints || [];

    // キャンバスサイズ確保
    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth || 200;
    const displayH = canvas.clientHeight || 38;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;
    ctx.scale(dpr, dpr);

    // 背景
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, displayW, displayH);

    if (motionPoints.length === 0) {
        ctx.fillStyle = '#aaa';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('ポイント未設定', displayW / 2, displayH / 2 + 3);
        return;
    }

    // 動画のフレーム数を優先使用
    let totalFrames = projectData?.settings?.motionFrameCount || 0;
    if (totalFrames <= 0) {
        const allFrames = new Set();
        Object.keys(camData).forEach(f => allFrames.add(parseInt(f)));
        Object.keys(otherCamData).forEach(f => allFrames.add(parseInt(f)));
        if (allFrames.size > 0) {
            const frameArray = Array.from(allFrames).sort((a, b) => a - b);
            totalFrames = frameArray[frameArray.length - 1];
        }
    }

    if (totalFrames <= 0) {
        ctx.fillStyle = '#aaa';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('データなし', displayW / 2, displayH / 2 + 3);
        return;
    }

    const numPoints = motionPoints.length;
    const minFrame = 1;

    // セルサイズ（横=ポイント、縦=フレーム）
    // フレーム数が多くても全体が収まるように最小値制限を削除
    const cellW = Math.max(1, displayW / numPoints);
    const cellH = displayH / totalFrames;

    // 色定義
    const COLOR_NONE = '#e8e8e8';
    const COLOR_CAM1_ONLY = '#90caf9';
    const COLOR_CAM2_ONLY = '#ffcc80';
    const COLOR_BOTH = '#81c784';

    // 描画（縦=フレーム、横=ポイント）
    for (let fi = 0; fi < totalFrames; fi++) {
        const frameNum = minFrame + fi;
        const y = fi * cellH;

        for (let pi = 0; pi < numPoints; pi++) {
            const pointId = motionPoints[pi].id;
            const x = pi * cellW;

            const cam1Frame = window.cameraDigitizeData?.cam1?.[frameNum];
            const cam2Frame = window.cameraDigitizeData?.cam2?.[frameNum];
            const hasCam1 = cam1Frame && cam1Frame.has && cam1Frame.has(pointId) && cam1Frame.get(pointId);
            const hasCam2 = cam2Frame && cam2Frame.has && cam2Frame.has(pointId) && cam2Frame.get(pointId);

            let color = COLOR_NONE;
            if (hasCam1 && hasCam2) {
                color = COLOR_BOTH;
            } else if (hasCam1) {
                color = COLOR_CAM1_ONLY;
            } else if (hasCam2) {
                color = COLOR_CAM2_ONLY;
            }

            ctx.fillStyle = color;
            // 全フレームが収まるようにセル高さの最小制限を削除
            ctx.fillRect(x, y, Math.max(cellW, 1), Math.max(cellH, 0.1));
        }
    }

    // ツールチップ
    canvas.onmousemove = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left);
        const my = (e.clientY - rect.top);

        const pi = Math.floor(mx / cellW);
        const fi = Math.floor(my / cellH);

        if (pi >= 0 && pi < numPoints && fi >= 0 && fi < totalFrames) {
            const frameNum = minFrame + fi;
            const point = motionPoints[pi];
            const pointName = point.name || `Point ${point.id}`;

            const cam1Frame = window.cameraDigitizeData?.cam1?.[frameNum];
            const cam2Frame = window.cameraDigitizeData?.cam2?.[frameNum];
            const hasCam1 = cam1Frame?.has?.(point.id) && cam1Frame.get(point.id);
            const hasCam2 = cam2Frame?.has?.(point.id) && cam2Frame.get(point.id);

            let status = 'なし';
            if (hasCam1 && hasCam2) status = '両カメラ';
            else if (hasCam1) status = 'Cam1';
            else if (hasCam2) status = 'Cam2';

            canvas.title = `F${frameNum} / ${pointName}: ${status}`;
            canvas.style.cursor = 'pointer';
        }
    };

    canvas.onmouseleave = () => {
        canvas.title = '';
        canvas.style.cursor = 'default';
    };

    // クリックでテーブルにスクロール
    canvas.onclick = (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left);
        const my = (e.clientY - rect.top);

        // displayW/displayHを使って計算（DPR補正済み）
        const clickCellW = displayW / numPoints;
        const clickCellH = displayH / totalFrames;
        const pi = Math.floor(mx / clickCellW);
        const fi = Math.floor(my / clickCellH);

        console.log(`[Minimap Click] pos: (${mx.toFixed(1)}, ${my.toFixed(1)}), frame: ${fi + 1}, point: ${pi + 1}, totalFrames: ${totalFrames}`);

        if (pi >= 0 && pi < numPoints && fi >= 0 && fi < totalFrames) {
            const frameNum = minFrame + fi;

            // モーションタブのテーブルにスクロール
            const tableBody = document.getElementById('data-table-body');
            // テーブルコンテナを確実に取得
            let tableContainer = document.querySelector('#data-tab .table-container');
            if (!tableContainer) {
                tableContainer = tableBody?.closest('.table-container');
            }
            if (!tableContainer) {
                tableContainer = tableBody?.parentElement?.parentElement;
            }

            if (tableBody && tableContainer) {
                // 縦スクロール：ミニマップのクリック位置の割合に応じてスクロール
                const scrollRatio = my / displayH;  // 0.0〜1.0
                const maxScrollTop = tableContainer.scrollHeight - tableContainer.clientHeight;
                const targetScrollTop = Math.round(scrollRatio * maxScrollTop);

                console.log(`[Minimap Click] frame: ${frameNum}, scrollRatio: ${scrollRatio.toFixed(3)}, maxScrollTop: ${maxScrollTop}, targetScrollTop: ${targetScrollTop}`);

                // 直接scrollTopを設定（確実にスクロール）
                tableContainer.scrollTop = targetScrollTop;

                // 横スクロール（列）- 該当ポイントのセルを表示
                const targetCell = tableBody.rows[fi]?.cells[pi + 1]; // +1 はフレーム列のオフセット
                if (targetCell) {
                    setTimeout(() => {
                        const containerRect = tableContainer.getBoundingClientRect();
                        const cellRect = targetCell.getBoundingClientRect();
                        const scrollLeft = tableContainer.scrollLeft + (cellRect.left - containerRect.left) - containerRect.width / 2 + cellRect.width / 2;
                        tableContainer.scrollLeft = Math.max(0, scrollLeft);
                    }, 50);
                    // セルをハイライト
                    targetCell.style.backgroundColor = '#ffeb3b';
                    setTimeout(() => {
                        targetCell.style.backgroundColor = '';
                    }, 1500);
                }
                // 行をハイライト
                if (tableBody.rows[fi]) {
                    tableBody.rows[fi].style.backgroundColor = '#fff9c4';
                    setTimeout(() => {
                        if (tableBody.rows[fi]) tableBody.rows[fi].style.backgroundColor = '';
                    }, 1500);
                }
            } else {
                console.warn('[Minimap Click] tableContainer not found');
            }

            // フレームにジャンプ
            if (typeof window.seekToFrame === 'function') {
                window.seekToFrame(frameNum);
            }
        }
    };
}

// エクスポート
window.updateDataMinimap = updateDataMinimap;
window.updateMotionTabMinimap = updateMotionTabMinimap;
window.initializeMinimapClickHandler = initializeMinimapClickHandler;

