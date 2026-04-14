/**
 * MotionDigitizer v1.0 - ユーティリティ関数モジュール
 * 数学計算、座標変換、データ検証、UI操作支援などの汎用機能を提供
 * 
 * 責任範囲:
 * - 数学計算ユーティリティ
 * - 座標変換ヘルパー
 * - データ検証関数
 * - UI操作支援関数
 */

// ========================================
// モード・状態取得関数
// ========================================

/**
 * 現在のモードを取得
 * @returns {string} 'calibration' | 'motion'
 */
function getCurrentMode() {
    const modeInput = document.querySelector('input[name="mode"]:checked');
    return modeInput ? modeInput.value : 'motion'; // デフォルトはモーションモード
}

/**
 * 現在のカメラ選択を取得
 * @returns {string} 'cam1' | 'cam2'
 */
function getCurrentCamera() {
    const cameraInput = document.querySelector('input[name="camera"]:checked');
    return cameraInput ? cameraInput.value : 'cam1'; // デフォルトはカメラ1
}

/**
 * 現在のアクティブタブ状態を取得
 * @returns {string} タブ名 ('digitize', 'data', 'calibration', 'points', 'analysis')
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
 * 現在選択中のランドマーク（モード別）を取得
 * @returns {Object|null} 選択中のランドマークオブジェクト
 */
function getSelectedLandmark() {
    const currentMode = getCurrentMode();
    if (currentMode === 'calibration') {
        return window.selectedCalibrationLandmark || null;
    } else {
        return window.selectedMotionLandmark || null;
    }
}

/**
 * ランドマークを設定（モード別）
 * @param {Object} landmark - 設定するランドマークオブジェクト
 */
function setSelectedLandmark(landmark) {
    const currentMode = getCurrentMode();
    if (currentMode === 'calibration') {
        window.selectedCalibrationLandmark = landmark;
    } else {
        window.selectedMotionLandmark = landmark;
    }
}

// ========================================
// 数値・データ検証関数
// ========================================

/**
 * 文字列が数値かどうかを判定
 * @param {string} str - 判定する文字列
 * @returns {boolean} 数値の場合true
 */
function isNumeric(str) {
    if (typeof str !== 'string') return false;
    return !isNaN(str) && !isNaN(parseFloat(str)) && str.trim() !== '';
}

/**
 * 座標データを解析（複数形式対応）
 * @param {string} cellData - 解析する座標文字列
 * @returns {Object|null} {x: number, y: number} または null
 */
function parseCoordinates(cellData) {
    if (!cellData || typeof cellData !== 'string') return null;
    
    const trimmed = cellData.trim();
    
    // "x, y" 形式の文字列の場合
    if (trimmed.includes(',')) {
        const parts = trimmed.split(',').map(part => part.trim());
        if (parts.length === 2 && isNumeric(parts[0]) && isNumeric(parts[1])) {
            const x = parseFloat(parts[0]);
            const y = parseFloat(parts[1]);
            if (!isNaN(x) && !isNaN(y)) {
                return { x: x, y: y };
            }
        }
    }
    
    // 単一の数値の場合
    if (isNumeric(trimmed)) {
        const value = parseFloat(trimmed);
        if (!isNaN(value)) {
            // 単一値の場合は、仮のy座標を0として設定（必要に応じて調整）
            return { x: value, y: 0 };
        }
    }
    
    return null; // 無効なデータ
}

/**
 * 座標が有効かどうかを検証
 * @param {Object} coords - 検証する座標オブジェクト
 * @returns {boolean} 有効な座標の場合true
 */
function isValidCoordinates(coords) {
    return coords && 
           typeof coords.x === 'number' && 
           typeof coords.y === 'number' && 
           !isNaN(coords.x) && 
           !isNaN(coords.y);
}

/**
 * フレーム番号が有効な範囲内かを検証
 * @param {number} frameNumber - 検証するフレーム番号
 * @param {number} maxFrame - 最大フレーム数
 * @returns {boolean} 有効な範囲内の場合true
 */
function isValidFrameNumber(frameNumber, maxFrame) {
    return Number.isInteger(frameNumber) && 
           frameNumber >= 1 && 
           frameNumber <= maxFrame;
}

// ========================================
// UI操作支援関数
// ========================================

/**
 * 要素が入力フィールドかどうかをチェック
 * @param {Element} element - チェックする要素
 * @returns {boolean} 入力フィールドの場合true
 */
function isInputField(element) {
    if (!element) return false;
    
    const inputTypes = ['input', 'textarea', 'select'];
    const tagName = element.tagName.toLowerCase();
    
    if (inputTypes.includes(tagName)) {
        return true;
    }
    
    // contenteditable属性を持つ要素もチェック
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
 * メッセージを表示
 * @param {string} message - 表示するメッセージ
 */
function showMessage(message) {
    const elements = [
        document.getElementById('status-text'),
        document.getElementById('message-display'),
        document.querySelector('.message-display span')
    ];
    
    for (const element of elements) {
        if (element) {
            element.textContent = message;
            element.style.color = ''; // 通常の色にリセット
            break;
        }
    }
}

/**
 * エラーメッセージを表示
 * @param {string} message - 表示するエラーメッセージ
 */
function showError(message) {
    const elements = [
        document.getElementById('status-text'),
        document.getElementById('message-display'),
        document.querySelector('.message-display span')
    ];
    
    for (const element of elements) {
        if (element) {
            element.textContent = 'エラー: ' + message;
            element.style.color = '#ff0000';
            break;
        }
    }
    
    // コンソールにもエラーを出力
    console.error('MotionDigitizer Error:', message);
}

// ========================================
// 時間・フォーマット関数
// ========================================

/**
 * 秒を時間フォーマットに変換（VideoSyncLabのUtils.formatTimeを参考）
 * @param {number} seconds - 変換する秒数
 * @returns {string} フォーマットされた時間文字列 (mm:ss.mmm)
 */
function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00.000';
    
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/**
 * 数値を指定桁数でフォーマット
 * @param {number} value - フォーマットする数値
 * @param {number} decimals - 小数点以下の桁数
 * @returns {string} フォーマットされた数値文字列
 */
function formatNumber(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) {
        return '-';
    }
    return Number(value).toFixed(decimals);
}

// ========================================
// 座標変換・計算ヘルパー
// ========================================

/**
 * 画像座標をキャンバス座標に変換
 * @param {number} imageX - 画像X座標
 * @param {number} imageY - 画像Y座標
 * @param {Object} canvas - キャンバス要素
 * @param {number} zoomScale - ズーム倍率
 * @param {number} panX - パンX位置
 * @param {number} panY - パンY位置
 * @returns {Object} {x: number, y: number}
 */
function imageToCanvasCoords(imageX, imageY, canvas, zoomScale, panX, panY) {
    if (!canvas || !canvas.currentImage) return { x: 0, y: 0 };
    
    const imageWidth = canvas.currentImage.width;
    const imageHeight = canvas.currentImage.height;
    
    const canvasX = (imageX - imageWidth / 2) * zoomScale + panX + canvas.width / 2;
    const canvasY = (imageY - imageHeight / 2) * zoomScale + panY + canvas.height / 2;
    
    return { x: canvasX, y: canvasY };
}

/**
 * キャンバス座標を画像座標に変換
 * @param {number} canvasX - キャンバスX座標
 * @param {number} canvasY - キャンバスY座標
 * @param {Object} canvas - キャンバス要素
 * @param {number} zoomScale - ズーム倍率
 * @param {number} panX - パンX位置
 * @param {number} panY - パンY位置
 * @returns {Object} {x: number, y: number}
 */
function canvasToImageCoords(canvasX, canvasY, canvas, zoomScale, panX, panY) {
    if (!canvas || !canvas.currentImage) return { x: 0, y: 0 };
    
    const imageWidth = canvas.currentImage.width;
    const imageHeight = canvas.currentImage.height;
    
    const imageX = (canvasX - panX - canvas.width / 2) / zoomScale + imageWidth / 2;
    const imageY = (canvasY - panY - canvas.height / 2) / zoomScale + imageHeight / 2;
    
    return { x: Math.round(imageX), y: Math.round(imageY) };
}

/**
 * 2点間の距離を計算
 * @param {Object} point1 - {x: number, y: number}
 * @param {Object} point2 - {x: number, y: number}
 * @returns {number} 距離
 */
function calculateDistance(point1, point2) {
    if (!isValidCoordinates(point1) || !isValidCoordinates(point2)) {
        return 0;
    }
    
    const dx = point2.x - point1.x;
    const dy = point2.y - point1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// ========================================
// テーブル操作ヘルパー
// ========================================

/**
 * セルIDを生成（行インデックス-列インデックス形式）
 * @param {Element} cell - セル要素
 * @returns {string} セルID
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
 * @param {string} cellId - セルID
 * @param {string} tableId - テーブルID（デフォルト: 'data-table'）
 * @returns {Element|null} セル要素
 */
function getCellFromId(cellId, tableId = 'data-table') {
    const [rowIndex, cellIndex] = cellId.split('-').map(Number);
    const table = document.getElementById(tableId);
    if (!table) return null;
    
    const tbody = table.querySelector('tbody');
    if (!tbody) return null;
    
    if (tbody.rows[rowIndex] && tbody.rows[rowIndex].cells[cellIndex]) {
        return tbody.rows[rowIndex].cells[cellIndex];
    }
    return null;
}

/**
 * セルの位置（行・列インデックス）を取得
 * @param {Element} cell - セル要素
 * @returns {Object} {row: number, col: number}
 */
function getCellPosition(cell) {
    const row = cell.parentElement;
    const table = row.closest('table');
    const tbody = table.querySelector('tbody');
    
    const rowIndex = Array.from(tbody.rows).indexOf(row);
    const cellIndex = Array.from(row.cells).indexOf(cell);
    
    return { row: rowIndex, col: cellIndex };
}

// ========================================
// パフォーマンス最適化ヘルパー
// ========================================

/**
 * デバウンス関数（頻繁な呼び出しを制限）
 * @param {Function} func - デバウンスする関数
 * @param {number} wait - 待機時間（ミリ秒）
 * @returns {Function} デバウンスされた関数
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
 * スロットル関数（一定間隔での実行制限）
 * @param {Function} func - スロットルする関数
 * @param {number} limit - 実行間隔（ミリ秒）
 * @returns {Function} スロットルされた関数
 */
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// ========================================
// ファイル名・パス操作ヘルパー
// ========================================

/**
 * ファイル拡張子を取得
 * @param {string} filename - ファイル名
 * @returns {string} 拡張子（ドット含む）
 */
function getFileExtension(filename) {
    if (!filename || typeof filename !== 'string') return '';
    const lastDot = filename.lastIndexOf('.');
    return lastDot === -1 ? '' : filename.substring(lastDot);
}

/**
 * ファイル名から拡張子を除いた部分を取得
 * @param {string} filename - ファイル名
 * @returns {string} 拡張子を除いたファイル名
 */
function getFileNameWithoutExtension(filename) {
    if (!filename || typeof filename !== 'string') return '';
    const lastDot = filename.lastIndexOf('.');
    return lastDot === -1 ? filename : filename.substring(0, lastDot);
}

/**
 * タイムスタンプ付きファイル名を生成
 * @param {string} baseName - ベースファイル名
 * @param {string} extension - 拡張子
 * @returns {string} タイムスタンプ付きファイル名
 */
function generateTimestampedFileName(baseName, extension) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${baseName}_${timestamp}${extension}`;
}

// ========================================
// データ構造ヘルパー
// ========================================

/**
 * Mapオブジェクトを通常のオブジェクトに変換
 * @param {Map} map - 変換するMap
 * @returns {Object} 変換されたオブジェクト
 */
function mapToObject(map) {
    if (!map || !(map instanceof Map)) return {};
    
    const obj = {};
    for (const [key, value] of map.entries()) {
        if (value instanceof Map) {
            obj[key] = mapToObject(value);
        } else {
            obj[key] = value;
        }
    }
    return obj;
}

/**
 * オブジェクトをMapに変換
 * @param {Object} obj - 変換するオブジェクト
 * @returns {Map} 変換されたMap
 */
function objectToMap(obj) {
    if (!obj || typeof obj !== 'object') return new Map();
    
    const map = new Map();
    for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            map.set(key, objectToMap(value));
        } else {
            map.set(key, value);
        }
    }
    return map;
}

// ========================================
// エクスポート（モジュール化対応）
// ========================================

// ES6モジュールとしてエクスポート（将来的にモジュール化する場合）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // 状態取得
        getCurrentMode,
        getCurrentCamera,
        getCurrentActiveTab,
        getSelectedLandmark,
        setSelectedLandmark,
        
        // データ検証
        isNumeric,
        parseCoordinates,
        isValidCoordinates,
        isValidFrameNumber,
        
        // UI操作
        isInputField,
        showMessage,
        showError,
        
        // フォーマット
        formatTime,
        formatNumber,
        
        // 座標変換
        imageToCanvasCoords,
        canvasToImageCoords,
        calculateDistance,
        
        // テーブル操作
        getCellId,
        getCellFromId,
        getCellPosition,
        
        // パフォーマンス
        debounce,
        throttle,
        
        // ファイル操作
        getFileExtension,
        getFileNameWithoutExtension,
        generateTimestampedFileName,
        
        // データ構造
        mapToObject,
        objectToMap
    };
}

// ========================================
// グローバル関数として公開（現在の統合形式）
// ========================================

// 既存のapp.jsとの互換性のため、グローバルスコープに関数を公開
window.getCurrentMode = getCurrentMode;
window.getCurrentCamera = getCurrentCamera;
window.getCurrentActiveTab = getCurrentActiveTab;
window.getSelectedLandmark = getSelectedLandmark;
window.setSelectedLandmark = setSelectedLandmark;
window.isNumeric = isNumeric;
window.parseCoordinates = parseCoordinates;
window.isValidCoordinates = isValidCoordinates;
window.isValidFrameNumber = isValidFrameNumber;
window.isInputField = isInputField;
window.showMessage = showMessage;
window.showError = showError;
window.formatTime = formatTime;
window.formatNumber = formatNumber;
window.imageToCanvasCoords = imageToCanvasCoords;
window.canvasToImageCoords = canvasToImageCoords;
window.calculateDistance = calculateDistance;
window.getCellId = getCellId;
window.getCellFromId = getCellFromId;
window.getCellPosition = getCellPosition;
window.debounce = debounce;
window.throttle = throttle;
window.getFileExtension = getFileExtension;
window.getFileNameWithoutExtension = getFileNameWithoutExtension;
window.generateTimestampedFileName = generateTimestampedFileName;
window.mapToObject = mapToObject;
window.objectToMap = objectToMap;