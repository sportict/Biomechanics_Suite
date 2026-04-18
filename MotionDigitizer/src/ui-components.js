/**
 * ui-components.js
 * UI操作・デジタイズキャンバス・プレビュープレイヤー・ナビゲーション機能
 */

// ファイルパスを media-file:// URL に正規化（macOS/Windows両対応）
// Electron の file:// は制限があるためカスタムプロトコル経由で配信
function normalizeFileUrl(filePath) {
    if (!filePath) return '';
    const s = String(filePath);
    if (s.startsWith('media-file://') || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('http')) return s;
    // 既に file:// の場合は media-file:// に変換
    if (s.startsWith('file://')) {
        return s.replace('file://', 'media-file://');
    }
    // OS のファイルパスをカスタムプロトコル URL に変換
    // パスはデコード済みのまま保持（protocol.handle 側で処理）
    const absPath = s.startsWith('/') ? s : '/' + s.replace(/\\/g, '/');
    return 'media-file://' + absPath;
}
// 他のスクリプトからも参照できるようグローバルに公開
window.normalizeFileUrl = normalizeFileUrl;

// ========================================================================================
// キャリブレーション精度 mm/px 切り替え
// ========================================================================================

/**
 * px→mm概算変換: ChArUcoのチェッカーサイズ(mm)とキャリブレーション内部パラメータから算出
 * px_size_mm = checkerSize / (focalLength_px で1ピクセルあたりの実寸を概算)
 * 簡易版: checkerSize(mm) / focalLength(px) で 1px あたりの mm を計算
 */
function getPixelToMmFactor() {
    // ChArUco: チェッカーサイズ(mm) と焦点距離(px) から概算
    const calib = window.projectData?.calibration;
    const stereo = window.projectData?.stereoCalibration;

    // 焦点距離(px): 内部パラメータの fx
    let fx = null;
    if (calib?.cameraMatrix) {
        fx = calib.cameraMatrix[0]; // K[0][0] = fx
    } else if (stereo?.K1) {
        fx = stereo.K1[0];
    }

    // チェッカーサイズ(mm)
    const checkerEl = document.getElementById('charuco-square-mm');
    const checkerMm = checkerEl ? Number(checkerEl.value) : 165;

    if (fx && fx > 0 && checkerMm > 0) {
        // 1px ≈ checkerMm / (fx で見たチェッカーの画素幅) → 概算
        // より正確にはボードの平均距離が必要だが、fx/image_widthベースで概算
        const imageWidth = calib?.imageWidth || projectData?.settings?.calibrationVideoWidth || 1920;
        // FOV ベース: 画像中央1pxが実空間で何mmか ≈ sensorWidth / fx
        // ここでは典型的なFOVでの概算: 1px ≈ (被写体距離 * sensorWidth) / (fx * imageWidth)
        // 簡易: ボードの撮影距離を仮定せず、報告値としてfxベースで変換
        return checkerMm / fx;
    }

    // CC法: 制御点間の実距離とピクセル距離から概算
    const ccCalib = window.projectData?.ccCalibration;
    if (ccCalib?.results) {
        const cam1 = ccCalib.results.cam1?.cameraParams;
        if (cam1?.F) {
            return 1.0 / cam1.F; // F = focal length in px → 1/F ≈ mm/px (概算)
        }
    }

    return null; // 変換不可
}

/**
 * 品質カードの誤差値を設定（"px (mm)" 併記表示）
 * @param {string} valueId - span要素のID
 * @param {number} pxValue - ピクセル値
 * @param {number|null} mmValue - mm値（null=概算変換を試行）
 */
function setCalibErrorValue(valueId, pxValue, mmValue) {
    const el = document.getElementById(valueId);
    if (!el) return;

    const px = typeof pxValue === 'number' ? pxValue : NaN;
    let mm = typeof mmValue === 'number' ? mmValue : NaN;

    // mmが未指定ならpxから概算変換
    if (isNaN(mm) && !isNaN(px)) {
        const factor = getPixelToMmFactor();
        if (factor) mm = px * factor * 1000; // factor は mm/px → そのまま掛ける
    }

    const pxText = !isNaN(px) ? px.toFixed(3) : '-';
    const mmText = !isNaN(mm) ? mm.toFixed(3) : null;
    el.dataset.px = pxText;
    el.dataset.mm = mmText || '-';

    // 「ピクセル（mm）」併記: mmが算出できない場合はpxのみ
    el.textContent = mmText ? `${pxText} (${mmText})` : pxText;

    // 単位表示もペアで: 「px (mm)」
    const unitEl = el.nextElementSibling;
    if (unitEl && unitEl.classList.contains('calib-quality-metric-unit')) {
        unitEl.textContent = mmText ? 'px (mm)' : 'px';
        // クリックによる単位切替は無効化（併記表示のため不要）
        unitEl.classList.remove('calib-unit-toggle');
        unitEl.onclick = null;
        unitEl.style.cursor = 'default';
        unitEl.removeAttribute('title');
    }
}
window.setCalibErrorValue = setCalibErrorValue;

/**
 * 旧: mm/px切り替えハンドラ（併記表示化により実質不要だが、
 * 既存HTML/他所からの呼び出しが残っていても落ちないよう no-op で残す）
 */
function toggleCalibUnit(_unitEl) { /* no-op: 表示は "px (mm)" 併記に統一 */ }
window.toggleCalibUnit = toggleCalibUnit;

// ========================================================================================
// デジタイズキャンバス関連
// ========================================================================================

// キャンバス関連変数
let digitizeCanvas = null;
let digitizeCtx = null;
let digitizeVideo = null; // Camera 1 Video Element
let digitizeVideo2 = null; // Camera 2 Video Element
let zoomScale = 1.0;
let panX = 0;
let panY = 0;
let isDragging = false;
// ステレオ共通IDオーバーレイ用（window.__stereoOverlayInfoを参照）

// クリック連打制御用変数（体感では分からない範囲で待機時間を設ける）
let lastDigitizeTime = 0;
const DIGITIZE_THROTTLE_MS = 50; // 50ms間隔でスロットル（体感では分からない範囲）

/**
 * Canvas内の実際の画像表示領域を考慮した座標取得関数 (object-fit: contain対応)
 * @param {HTMLCanvasElement} canvas
 * @param {MouseEvent} event
 * @returns {{x: number, y: number}} Canvas内部座標 (0~width, 0~height)
 */
function getCanvasCoordinates(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // 表示領域のアスペクト比
    const displayAspect = rect.width / rect.height;
    // Canvas内部のアスペクト比
    const canvasAspect = canvasWidth / canvasHeight;

    let actualWidth, actualHeight, offsetX, offsetY;

    if (displayAspect > canvasAspect) {
        // 画面の方が横長 -> 左右に黒帯 (Pillarbox)
        actualHeight = rect.height;
        actualWidth = actualHeight * canvasAspect;
        offsetY = 0;
        offsetX = (rect.width - actualWidth) / 2;
    } else {
        // 画面の方が縦長 -> 上下に黒帯 (Letterbox)
        actualWidth = rect.width;
        actualHeight = actualWidth / canvasAspect;
        offsetX = 0;
        offsetY = (rect.height - actualHeight) / 2;
    }

    // クライアント座標からCanvas内の表示座標へ (黒帯部分を除去)
    const clientX = event.clientX - rect.left;
    const clientY = event.clientY - rect.top;

    // 表示座標から内部座標へ変換 (スケール適用)
    const x = (clientX - offsetX) * (canvasWidth / actualWidth);
    const y = (clientY - offsetY) * (canvasHeight / actualHeight);

    return { x, y };
}

/**
 * デジタイズキャンバスの設定（改良版）
 */
function setupDigitizeCanvas() {
    digitizeCanvas = document.getElementById('digitize-canvas');
    digitizeVideo = document.getElementById('digitize-video');
    digitizeVideo2 = document.getElementById('digitize-video-2');
    if (!digitizeCanvas) {
        return;
    }

    digitizeCtx = digitizeCanvas.getContext('2d');

    // キャンバスサイズ設定
    digitizeCanvas.width = 800;
    digitizeCanvas.height = 600;

    // マウスカーソルを十字に設定
    digitizeCanvas.style.cursor = 'crosshair';

    // パンニング用の変数
    let dragStartImageX = 0;
    let dragStartImageY = 0;

    // マウスイベント設定（最適化版）
    digitizeCanvas.addEventListener('click', (event) => {
        // 右クリックの場合はデジタイズ処理をスキップ
        if (event.button === 2) {
            return;
        }

        // Canvas上の座標を取得（object-fit: contain対応）
        const coords = getCanvasCoordinates(digitizeCanvas, event);
        const mouseX = coords.x;
        const mouseY = coords.y;

        // 座標変換 - 浮動小数点精度を維持（丸め誤差を防ぐ）
        // Video要素の場合はvideoWidth/videoHeightを使用
        const currentImage = digitizeCanvas.currentImage;
        const imageWidth = currentImage ? (currentImage.videoWidth || currentImage.width) : digitizeCanvas.width;
        const imageHeight = currentImage ? (currentImage.videoHeight || currentImage.height) : digitizeCanvas.height;

        // 精密な座標（丸めなし）- 描画時にピクセル単位で正確に一致させるため
        const imageX = (mouseX - panX - digitizeCanvas.width / 2.0) / zoomScale + imageWidth / 2.0;
        const imageY = (mouseY - panY - digitizeCanvas.height / 2.0) / zoomScale + imageHeight / 2.0;

        // 座標表示を更新（表示用のみ丸め）
        const clickX = document.getElementById('click-x');
        const clickY = document.getElementById('click-y');
        if (clickX) clickX.textContent = Math.round(imageX);
        if (clickY) clickY.textContent = Math.round(imageY);

        // デジタイズ処理（既存のロジック）
        const currentMode = getCurrentMode();
        if (currentMode === 'calibration') {
            handleCalibrationDigitize(imageX, imageY);
        } else {
            handleMotionDigitize(imageX, imageY);
        }
    });

    // マウスホイールでズーム（マウス位置中心）
    digitizeCanvas.addEventListener('wheel', (event) => {
        // ズーム前のマウス位置（キャンバス座標）
        // ズーム前のマウス位置（キャンバス座標）- object-fit対応
        const coords = getCanvasCoordinates(digitizeCanvas, event);
        const mouseX = coords.x;
        const mouseY = coords.y;

        // フィットスケール（100%）を計算: 画像がキャンバスにぴったり収まる倍率
        const img = digitizeCanvas.currentImage;
        const imgW = img ? (img.videoWidth || img.width || 1) : 1;
        const imgH = img ? (img.videoHeight || img.height || 1) : 1;
        const fitScale = Math.min(digitizeCanvas.width / imgW, digitizeCanvas.height / imgH);

        // ズーム前のズームスケール
        const oldZoom = zoomScale;

        // 新しいズームスケールを計算
        const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1;
        let newZoom = Math.min(5.0, zoomScale * zoomFactor);

        // 100%（フィットスケール）より縮小しようとしたらフィットにリセット
        if (newZoom <= fitScale) {
            newZoom = fitScale;
            zoomScale = newZoom;
            panX = 0;
            panY = 0;
        } else {
            zoomScale = newZoom;

            // マウス位置を中心にズームするためにpanX/panYを調整
            const zoomRatio = zoomScale / oldZoom;
            const offsetX = mouseX - digitizeCanvas.width / 2 - panX;
            const offsetY = mouseY - digitizeCanvas.height / 2 - panY;
            panX -= offsetX * (zoomRatio - 1);
            panY -= offsetY * (zoomRatio - 1);
        }

        updateZoomDisplay();
        updatePanDisplay();
        redrawCanvasOnly();
    }, { passive: true });

    // 右クリックでパン（改良版）
    digitizeCanvas.addEventListener('mousedown', (event) => {
        if (event.button === 2) { // 右クリック
            isDragging = true;
            // キャンバス上のマウス位置を取得 - object-fit対応
            const coords = getCanvasCoordinates(digitizeCanvas, event);
            const mouseX = coords.x;
            const mouseY = coords.y;

            // マウス位置に対応する画像上の座標を計算
            if (digitizeCanvas.currentImage) {
                // Video要素の場合はvideoWidth/videoHeightを使用
                const imageWidth = digitizeCanvas.currentImage.videoWidth || digitizeCanvas.currentImage.width;
                const imageHeight = digitizeCanvas.currentImage.videoHeight || digitizeCanvas.currentImage.height;

                // 現在のマウス位置に対応する画像座標を計算
                dragStartImageX = (mouseX - panX - digitizeCanvas.width / 2.0) / zoomScale + imageWidth / 2.0;
                dragStartImageY = (mouseY - panY - digitizeCanvas.height / 2.0) / zoomScale + imageHeight / 2.0;
            }

            // カーソルをグラビングアイコンに変更
            digitizeCanvas.style.cursor = 'grabbing';
        }
    });

    digitizeCanvas.addEventListener('mousemove', (event) => {
        if (isDragging) {
            // 現在のマウス位置を取得 - object-fit対応
            const coords = getCanvasCoordinates(digitizeCanvas, event);
            const mouseX = coords.x;
            const mouseY = coords.y;

            if (digitizeCanvas.currentImage) {
                // Video要素の場合はvideoWidth/videoHeightを使用
                const imageWidth = digitizeCanvas.currentImage.videoWidth || digitizeCanvas.currentImage.width;
                const imageHeight = digitizeCanvas.currentImage.videoHeight || digitizeCanvas.currentImage.height;

                // ドラッグ開始時の画像座標が現在のマウス位置に来るようにpanX, panYを計算
                panX = mouseX - (dragStartImageX - imageWidth / 2.0) * zoomScale - digitizeCanvas.width / 2.0;
                panY = mouseY - (dragStartImageY - imageHeight / 2.0) * zoomScale - digitizeCanvas.height / 2.0;
            }

            updatePanDisplay();
            redrawCanvasOnly();
        }
    });

    digitizeCanvas.addEventListener('mouseup', (event) => {
        if (event.button === 2) {
            isDragging = false;
            // カーソルを元に戻す
            digitizeCanvas.style.cursor = 'crosshair';
        }
    });

    // 右クリックメニューを無効化
    digitizeCanvas.addEventListener('contextmenu', (event) => {
        event.preventDefault();
    });
}

/**
 * シンプルな数値入力モーダルを表示する
 * @param {string} message - 表示メッセージ
 * @param {number} defaultValue - デフォルト値
 * @returns {Promise<number|null>} 入力された数値、またはキャンセルの場合はnull
 */
function showNumberInputModal(message, defaultValue) {
    return new Promise((resolve) => {
        // オーバーレイ
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 10000;
            display: flex; justify-content: center; align-items: center;
        `;

        // ダイアログボックス
        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #fff; padding: 20px; border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            min-width: 300px; text-align: center; font-family: sans-serif;
        `;

        // メッセージ
        const msg = document.createElement('p');
        msg.textContent = message;
        msg.style.marginBottom = '15px';
        msg.style.fontWeight = 'bold';
        msg.style.color = '#333';

        // 入力フォーム
        const inputContainer = document.createElement('div');
        inputContainer.style.marginBottom = '20px';

        const input = document.createElement('input');
        input.type = 'number';
        input.value = defaultValue;
        input.min = '1';
        input.max = '100';
        input.style.cssText = `
            padding: 8px; width: 80px; font-size: 16px; text-align: center;
            border: 1px solid #ccc; border-radius: 4px;
        `;

        // フォーカス時に全選択
        input.addEventListener('focus', () => input.select());

        // Enterキーで確定
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') okBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
        });

        inputContainer.appendChild(input);

        // ボタンエリア
        const btnContainer = document.createElement('div');
        btnContainer.style.display = 'flex';
        btnContainer.style.justifyContent = 'center';
        btnContainer.style.gap = '10px';

        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText = `
            padding: 8px 20px; background: #2196F3; color: white;
            border: none; border-radius: 4px; cursor: pointer; font-weight: bold;
        `;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.style.cssText = `
            padding: 8px 20px; background: #e0e0e0; color: #333;
            border: none; border-radius: 4px; cursor: pointer;
        `;

        // イベントハンドラ
        const close = () => {
            if (overlay.parentNode) {
                document.body.removeChild(overlay);
            }
        };

        okBtn.onclick = () => {
            const val = parseInt(input.value, 10);
            if (!isNaN(val) && val > 0) {
                close();
                resolve(val);
            } else {
                alert('有効な数値を入力してください');
            }
        };

        cancelBtn.onclick = () => {
            close();
            resolve(null);
        };

        // 組み立て
        dialog.appendChild(msg);
        dialog.appendChild(inputContainer);
        btnContainer.appendChild(cancelBtn);
        btnContainer.appendChild(okBtn);
        dialog.appendChild(btnContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        input.focus();
    });
}

/**
 * キャリブレーションモード用デジタイズ処理
 */
async function handleCalibrationDigitize(imageX, imageY) {
    // 3次元CC法も含め、すべてのキャリブレーション方法で
    // 通常のキャリブレーションテーブルを使用する（3次元DLT法と同じフロー）

    let currentLandmark = getSelectedLandmark();

    // ポイントが未選択の場合
    if (!currentLandmark) {
        // 初期状態（ポイントがまだひとつも無い）場合のみ、点数の入力を求める
        if (!window.calibrationData || !window.calibrationData.points || window.calibrationData.points.length === 0) {

            // ユーザーに入力を求める (Async)
            const count = await showNumberInputModal("生成するキャリブレーションポイントの数を入力してください", 4);

            if (count === null) {
                return; // キャンセル
            }

            if (!window.calibrationData) {
                window.calibrationData = { points: [] };
            }
            // 念のため初期化
            window.calibrationData.points = [];

            // 指定数だけポイント生成
            for (let i = 1; i <= count; i++) {
                window.calibrationData.points.push({
                    id: `Cal${i}`,
                    name: `Cal${i}`,
                    digitizedCoords: { cam1: { x: null, y: null }, cam2: { x: null, y: null } },
                    realCoords: { x: null, y: null, z: null },
                    errors: { x: null, y: null, z: null },
                    isDigitized: false,
                    frameNumber: null,
                    frameNumber2: null
                });
            }

            updateCalibrationDataTable();

            // ポイント1を選択状態にして、後続の処理で座標が入るようにする
            const firstPoint = window.calibrationData.points[0];
            setSelectedLandmark(firstPoint);
            currentLandmark = firstPoint;

            // セレクタ同期
            if (typeof window.initializeCalibrationLandmarkSelector === 'function') {
                window.initializeCalibrationLandmarkSelector();
            }
            const select = document.getElementById('calibration-landmark-select');
            if (select) {
                select.value = firstPoint.id;
            }
            updatePointsTab();

            showMessage(`${count}個のキャリブレーションポイントを生成しました`);

        } else {
            // 既存ポイントがある場合は、従来通り自動追加（動作維持）
            // ただし、ここは「未選択状態でクリック」した場合の挙動。
            // ユーザーが意図せずクリックした可能性もあるが、元のロジック通り「新規追加」としておく。
            // ※ユーザー要望は「初期状態で...自動生成はなし」なので、ここは変更しない。

            if (!window.calibrationData) {
                window.calibrationData = { points: [] };
            }
            const idx = window.calibrationData.points.length + 1;
            const newPoint = {
                id: `Cal${idx}`,
                name: `Cal${idx}`,
                digitizedCoords: { cam1: { x: null, y: null }, cam2: { x: null, y: null } },
                realCoords: { x: null, y: null, z: null },
                errors: { x: null, y: null, z: null },
                isDigitized: false,
                frameNumber: null,
                frameNumber2: null
            };
            window.calibrationData.points.push(newPoint);

            // 新しいポイントを選択
            setSelectedLandmark(newPoint);
            currentLandmark = newPoint;

            // セレクタを更新
            if (typeof window.initializeCalibrationLandmarkSelector === 'function') {
                window.initializeCalibrationLandmarkSelector();
            }
            const select = document.getElementById('calibration-landmark-select');
            if (select) {
                select.value = newPoint.id;
            }

            // ポイントタブを更新
            updatePointsTab();

            showMessage(`キャリブレーションポイント「${newPoint.name}」を自動追加しました`);
        }
    }

    if (currentLandmark) {
        if (!currentLandmark.digitizedCoords) {
            currentLandmark.digitizedCoords = { cam1: { x: null, y: null }, cam2: { x: null, y: null } };
        }

        const selectedCamera = getCurrentCamera();
        const modePrefix = getCurrentMode() === 'calibration' ? 'cal-' : 'motion-';
        const fileKey = modePrefix + selectedCamera;
        let videoIndex = 0;
        if (window.fileStateLists && window.fileStateLists[fileKey] && window.fileState && window.fileState[fileKey]) {
            const current = window.fileState[fileKey];
            const currentPath = typeof current === 'string' ? current : current.path;
            const list = window.fileStateLists[fileKey];
            const idx = list.findIndex(f => (typeof f === 'string' ? f : f.path) === currentPath);
            if (idx !== -1) videoIndex = idx;
        }

        // 保存前の状態（Undo用）
        const previousDigitizedCoords = JSON.parse(JSON.stringify(currentLandmark.digitizedCoords || { cam1: { x: null, y: null }, cam2: { x: null, y: null } }));
        const previousFrameNumber = currentLandmark.frameNumber;
        const previousFrameNumber2 = currentLandmark.frameNumber2;
        const previousIsDigitized = currentLandmark.isDigitized;

        // Commandオブジェクト作成
        const command = {
            description: `キャリブレーション ${currentLandmark.name} デジタイズ`,
            execute: () => {
                if (selectedCamera === 'cam1') {
                    currentLandmark.digitizedCoords.cam1.x = imageX;
                    currentLandmark.digitizedCoords.cam1.y = imageY;
                    currentLandmark.digitizedCoords.cam1.videoIndex = videoIndex;
                    currentLandmark.frameNumber = getCurrentFrameNumber();
                } else if (selectedCamera === 'cam2') {
                    currentLandmark.digitizedCoords.cam2.x = imageX;
                    currentLandmark.digitizedCoords.cam2.y = imageY;
                    currentLandmark.digitizedCoords.cam2.videoIndex = videoIndex;
                    currentLandmark.frameNumber2 = getCurrentFrameNumber();
                }
                currentLandmark.isDigitized = true;

                updateCalibrationDataTable();
                redrawCanvasOnly();
            },
            undo: () => {
                currentLandmark.digitizedCoords = JSON.parse(JSON.stringify(previousDigitizedCoords));
                currentLandmark.frameNumber = previousFrameNumber;
                currentLandmark.frameNumber2 = previousFrameNumber2;
                currentLandmark.isDigitized = previousIsDigitized;

                updateCalibrationDataTable();
                redrawCanvasOnly();
            }
        };

        // 実行（UndoManager経由）
        if (window.undoManager) {
            window.undoManager.execute(command);
        } else {
            command.execute();
        }

        drawPoint(imageX, imageY, currentLandmark.name, '#00ff00');

        // 次のポイントに移動 (これはUI操作なのでUndo対象外にするか、あるいはこれも含めるか。
        // 一般的に「デジタイズ」自体はUndoしたいが、「次のポイントへ移動」したことまでUndoすると
        // 連続デジタイズ時に戻るのが面倒になる可能性がある。
        // ここではデジタイズデータのみUndo対象とし、ポイント移動はそのまま実行する)

        const currentIndex = calibrationData.points.findIndex(p => p.id === currentLandmark.id);
        const nextIndex = currentIndex + 1;

        if (nextIndex < calibrationData.points.length) {
            const nextPoint = calibrationData.points[nextIndex];
            setSelectedLandmark(nextPoint);
            const select = document.getElementById('calibration-landmark-select');
            if (select) {
                select.value = nextPoint.id;
                onCalibrationLandmarkChange();
            }
            showMessage(`${currentLandmark.name} の座標を更新し、${nextPoint.name} に移動しました`);
        } else {
            showMessage(`${currentLandmark.name} の座標を更新しました`);
        }

        // execute内でupdateCalibrationDataTableとredrawCanvasOnlyを呼んでいるため、ここでの呼び出しは不要になるが、
        // 次のポイントへの移動があるため、念のため再描画はしておく（選択色がかわるため）
        setTimeout(() => {
            redrawCanvasOnly();
        }, 100);
    }
}

/**
 * undo対応のデジタイズ保存
 */
function savePointDataWithUndo(landmark, x, y) {
    if (typeof window.getPointData !== 'function' || typeof window.savePointData !== 'function') {
        console.error('Data manager functions not ready');
        // フォールバック: 直接保存
        if (typeof window.savePointData === 'function') {
            window.savePointData(landmark, x, y);
        }
        return;
    }

    // 既存の値を保存（Undo用）
    const previousValue = window.getPointData(landmark);

    // 値渡しにするためのディープコピー（シンプルなオブジェクトなのでこれで十分）
    const prevCopy = previousValue ? { ...previousValue } : null;

    const command = {
        description: `${landmark} デジタイズ`,
        execute: () => {
            window.savePointData(landmark, x, y);
            redrawCanvasOnly();
        },
        undo: () => {
            if (prevCopy) {
                window.savePointData(landmark, prevCopy.x, prevCopy.y);
            } else {
                if (typeof window.deletePointData === 'function') {
                    window.deletePointData(landmark);
                }
            }
            redrawCanvasOnly();
        }
    };

    if (window.undoManager) {
        window.undoManager.execute(command);
    } else {
        // UndoManagerが無い場合は直接実行
        window.savePointData(landmark, x, y);
    }
}

/**
 * モーションモード用デジタイズ処理
 */
function handleMotionDigitize(imageX, imageY) {
    if (!getSelectedLandmark()) {
        showError('ランドマークを選択してください');
        return;
    }

    // クリック連打制御：体感では分からない範囲で待機時間を設ける
    const now = Date.now();
    const timeSinceLastClick = now - lastDigitizeTime;
    if (timeSinceLastClick < DIGITIZE_THROTTLE_MS) {
        // 短時間内の連続クリックは無視（処理が追いつかないのを防ぐ）
        return;
    }
    lastDigitizeTime = now;

    savePointDataWithUndo(getSelectedLandmark(), imageX, imageY);
    redrawCanvasOnly(); // redrawCanvas()から変更：現在のフレームを再描画するだけ
    // リバースデジタイズ: チェック時はデジタイズ間隔ぶん戻る
    try {
        const reverse = !!(projectData && projectData.settings && projectData.settings.reverseDigitize);
        if (reverse) {
            const interval = Math.max(1, Math.floor(Number(projectData?.settings?.digitizeInterval) || 1));
            const currentFrame = getCurrentFrameNumber();
            const prevFrameNumber = Math.max(1, currentFrame - interval);
            setCurrentFrameNumber(prevFrameNumber);
            updateFrameInfo();
            displayCurrentFrame(); // setTimeoutを削除
            return;
        }
    } catch (_) { }
    nextFrame();
}

/**
 * キャンバス再描画
 */
function redrawCanvas() {
    if (!digitizeCanvas || !digitizeCtx) return;

    displayCurrentFrame();
}

/**
 * キャンバス側ズーム専用の描画関数
 */
function redrawCanvasOnly() {
    if (!digitizeCanvas || !digitizeCtx) return;

    // ChArUco検出中は何もしない（検出結果の上書き防止）
    if (window.__charucoDetectionInProgress) {
        return;
    }

    const currentImage = digitizeCanvas.currentImage;
    if (currentImage) {
        digitizeCtx.clearRect(0, 0, digitizeCanvas.width, digitizeCanvas.height);

        // キャンバス変換を適用（ズーム・パン）
        digitizeCtx.save();
        digitizeCtx.translate(digitizeCanvas.width / 2, digitizeCanvas.height / 2);
        digitizeCtx.translate(panX, panY);
        digitizeCtx.scale(zoomScale, zoomScale);

        // drawImageの引数チェック（Crash防止）
        if (currentImage instanceof HTMLImageElement ||
            currentImage instanceof HTMLCanvasElement ||
            currentImage instanceof HTMLVideoElement ||
            currentImage instanceof ImageBitmap ||
            currentImage instanceof OffscreenCanvas ||
            (typeof VideoFrame !== 'undefined' && currentImage instanceof VideoFrame)) {
            try {
                // Video要素の場合はvideoWidth/videoHeightを使用
                const imageWidth = currentImage.videoWidth || currentImage.width;
                const imageHeight = currentImage.videoHeight || currentImage.height;
                digitizeCtx.drawImage(currentImage, -imageWidth / 2, -imageHeight / 2);
            } catch (e) {
                console.warn('Failed to redraw image:', e);
            }
        }
        digitizeCtx.restore();

        drawTrajectoriesIfNeeded();
        drawExistingPoints();
        drawStereoOverlayIfNeeded();
    } else {
        redrawCanvas();
    }
}

/**
 * 既存ポイントの描画（座標データから描画）
 */
function drawExistingPoints() {
    if (!digitizeCtx) return;

    const currentMode = getCurrentMode();

    if (currentMode === 'calibration') {
        // キャリブレーションモード: キャリブレーションポイントを描画
        const currentCamera = getCurrentCamera();
        calibrationData.points.forEach(point => {
            if (point.isDigitized) {
                const color = (getSelectedLandmark() && point.id === getSelectedLandmark().id) ? '#ff0000' : '#00ff00';
                if (currentCamera === 'cam1') {
                    if (point.digitizedCoords.cam1 && point.digitizedCoords.cam1.x !== null && point.digitizedCoords.cam1.y !== null) {
                        drawPoint(point.digitizedCoords.cam1.x, point.digitizedCoords.cam1.y, point.name + ' (Cam1)', color);
                    }
                } else if (currentCamera === 'cam2') {
                    if (point.digitizedCoords.cam2 && point.digitizedCoords.cam2.x !== null && point.digitizedCoords.cam2.y !== null) {
                        drawPoint(point.digitizedCoords.cam2.x, point.digitizedCoords.cam2.y, point.name + ' (Cam2)', color);
                    }
                }
            }
        });
    } else {
        // モーションモード: 現在のカメラの保存されたデータを描画
        const currentCamera = getCurrentCamera();
        const frameKey = projectData.settings.currentFrame;

        if (cameraDigitizeData[currentCamera] && cameraDigitizeData[currentCamera][frameKey]) {
            const frameData = cameraDigitizeData[currentCamera][frameKey];

            // データ構造の違いに対応（Mapまたは通常のオブジェクト）
            if (frameData && typeof frameData === 'object') {
                if (frameData.forEach) {
                    // Mapの場合
                    frameData.forEach((coords, pointId) => {
                        const point = motionPoints.find(p => p.id == pointId);
                        if (point) {
                            const color = (getSelectedLandmark() && point.id === getSelectedLandmark().id) ? '#ff0000' : '#00ff00';
                            drawPoint(coords.x, coords.y, point.name, color);
                        }
                    });
                } else {
                    // 通常のオブジェクトの場合
                    Object.keys(frameData).forEach(pointId => {
                        const coords = frameData[pointId];
                        if (coords && typeof coords.x === 'number' && typeof coords.y === 'number') {
                            const point = motionPoints.find(p => p.id == pointId);
                            if (point) {
                                const color = (getSelectedLandmark() && point.id === getSelectedLandmark().id) ? '#ff0000' : '#00ff00';
                                drawPoint(coords.x, coords.y, point.name, color);
                            }
                        }
                    });
                }
            }
        }
    }
}

/**
 * ステレオ時に追加可能かどうかを表示する（廃止）
 */
function drawStereoOverlayIfNeeded() {
    return;
}

/**
 * ポイント描画
 */
function drawPoint(x, y, label, color = '#00ff00') {
    if (!digitizeCtx) return;

    digitizeCtx.save();
    digitizeCtx.translate(digitizeCanvas.width / 2, digitizeCanvas.height / 2);
    digitizeCtx.translate(panX, panY);
    digitizeCtx.scale(zoomScale, zoomScale);

    // 画像座標をキャンバス座標に変換（Video要素の場合はvideoWidth/videoHeightを使用）
    const currentImage = digitizeCanvas.currentImage;
    const imageWidth = currentImage ? (currentImage.videoWidth || currentImage.width) : 0;
    const imageHeight = currentImage ? (currentImage.videoHeight || currentImage.height) : 0;
    const canvasX = x - imageWidth / 2;
    const canvasY = y - imageHeight / 2;

    // 緑の点を描画
    digitizeCtx.fillStyle = color;
    digitizeCtx.beginPath();
    const ps = (typeof projectData !== 'undefined' && projectData.settings && Number.isFinite(Number(projectData.settings.pointSize)))
        ? Math.max(1, Math.min(20, Math.floor(Number(projectData.settings.pointSize))))
        : 5;
    digitizeCtx.arc(canvasX, canvasY, ps, 0, 2 * Math.PI);
    digitizeCtx.fill();

    // ラベルを描画（チェックボックスの状態に応じて）
    const showPointNames = document.getElementById('show-point-names');
    if (showPointNames && showPointNames.checked) {
        digitizeCtx.fillStyle = '#ffffff';
        digitizeCtx.font = '12px Arial';
        digitizeCtx.fillText(label, canvasX + 5, canvasY - 5);
    }

    digitizeCtx.restore();
}

// 選択ランドマークの軌跡描画（モーション時のみ）
function drawTrajectoriesIfNeeded() {
    try {
        const show = !!(projectData && projectData.settings && projectData.settings.showTrajectory);
        if (!show) return;
        const mode = (typeof getCurrentMode === 'function') ? getCurrentMode() : 'motion';
        if (mode !== 'motion') return;
        const sel = (typeof getSelectedLandmark === 'function') ? getSelectedLandmark() : null;
        if (!sel || !sel.id) return;
        const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
        const store = (typeof window !== 'undefined' && window.cameraDigitizeData && window.cameraDigitizeData[cam]) ? window.cameraDigitizeData[cam] : {};
        const img = digitizeCanvas.currentImage;
        if (!img || !digitizeCtx) return;

        // 線の太さ
        const width = (projectData && projectData.settings && Number.isFinite(Number(projectData.settings.trajectoryWidth)))
            ? Math.max(1, Math.min(10, Math.floor(Number(projectData.settings.trajectoryWidth))))
            : 5;

        // 変換適用
        digitizeCtx.save();
        digitizeCtx.translate(digitizeCanvas.width / 2, digitizeCanvas.height / 2);
        digitizeCtx.translate(panX, panY);
        digitizeCtx.scale(zoomScale, zoomScale);

        digitizeCtx.strokeStyle = 'rgba(0, 255, 255, 0.9)';
        digitizeCtx.lineWidth = width;
        digitizeCtx.lineJoin = 'round';
        digitizeCtx.lineCap = 'round';

        let started = false;
        digitizeCtx.beginPath();
        const frames = Object.keys(store).map(n => Number(n)).filter(n => !isNaN(n)).sort((a, b) => a - b);
        for (const f of frames) {
            const frameData = store[f];
            if (!frameData) continue;
            const coords = frameData.get ? frameData.get(sel.id) : frameData[sel.id];
            if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') continue;
            // Video要素の場合はvideoWidth/videoHeightを使用
            const imgWidth = img.videoWidth || img.width;
            const imgHeight = img.videoHeight || img.height;
            const cx = coords.x - imgWidth / 2;
            const cy = coords.y - imgHeight / 2;
            if (!started) {
                digitizeCtx.moveTo(cx, cy);
                started = true;
            } else {
                digitizeCtx.lineTo(cx, cy);
            }
        }
        if (started) digitizeCtx.stroke();
        digitizeCtx.restore();
    } catch (_) { }
}

/**
 * ズームリセット
 */
function resetZoom() {
    zoomScale = 1.0;
    panX = 0;
    panY = 0;
    updateZoomDisplay();
    updatePanDisplay();
    redrawCanvasOnly();
}

/**
 * ズーム倍率表示
 */
function updateZoomDisplay() {
    const zoomElement = document.getElementById('zoom-display');
    if (zoomElement) {
        zoomElement.textContent = `${zoomScale.toFixed(2)}x`;
    }
}

/**
 * パン情報表示
 */
function updatePanDisplay() {
    const panElement = document.getElementById('pan-display');
    if (panElement) {
        panElement.textContent = `X: ${Math.round(panX)}, Y: ${Math.round(panY)}`;
    }
}

/**
 * 座標クリア
 */
function clearCoordinates() {
    const clickX = document.getElementById('click-x');
    const clickY = document.getElementById('click-y');
    if (clickX) clickX.textContent = '-';
    if (clickY) clickY.textContent = '-';
}

/**
 * キャンバスクリア
 */
function clearDigitizeCanvas() {
    if (digitizeCtx) {
        digitizeCtx.clearRect(0, 0, digitizeCanvas.width, digitizeCanvas.height);
    }
}

// ========================================================================================
// プレビュープレイヤー
// ========================================================================================

/**
 * プレビュータブ用の動画再生制御クラス（VideoSyncLabを参考）
 */
class PreviewPlayer {
    constructor() {
        this.video = null;
        this.isPlaying = false;
        this.currentSpeed = 1.0;
        this.speedLevels = [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0];
        this.currentSpeedIndex = 4; // 1.0x
        this.fps = 30; // デフォルトFPS
        this.updateTimer = null; // 0.01秒間隔更新用タイマー
        // Fallback (OpenCV抽出) 再生用
        this.isFallback = false;
        this.fallbackImg = null;
        this.fallbackTimer = null;
        this.fallbackTime = 0; // 秒
        this.fallbackDuration = 0; // 秒
        this.currentPath = '';

        this.initializeElements();
        this.setupEventListeners();
    }

    initializeElements() {
        this.video = document.getElementById('preview-video');
        // フォールバック画像を動画の隣に用意
        if (this.video && this.video.parentElement) {
            this.fallbackImg = document.createElement('img');
            this.fallbackImg.style.display = 'none';
            this.fallbackImg.style.width = '100%';
            this.fallbackImg.style.height = 'auto';
            this.fallbackImg.id = 'preview-fallback';
            this.video.parentElement.appendChild(this.fallbackImg);
        }
        this.playPauseBtn = document.getElementById('preview-play-pause');
        this.frameBackBtn = document.getElementById('preview-frame-back');
        this.frameForwardBtn = document.getElementById('preview-frame-forward');
        this.stopBtn = document.getElementById('preview-stop');
        this.speedDownBtn = document.getElementById('preview-speed-down');
        this.speedUpBtn = document.getElementById('preview-speed-up');
        this.speedResetBtn = document.getElementById('preview-speed-reset');
        this.speedDisplay = document.getElementById('preview-speed-display');
        this.timelineSlider = document.getElementById('preview-timeline-slider');
        this.timeDisplay = document.getElementById('preview-time-display');
        this.durationDisplay = document.getElementById('preview-duration-display');
        this.frameInfo = document.getElementById('preview-frame-info');
    }

    setupEventListeners() {
        // 再生・一時停止
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());

        // フレーム送りは動画の再生位置を変更（固定時間間隔 or フォールバックの時間変更）
        this.frameBackBtn.addEventListener('click', () => {
            const fps = Number(projectData?.settings?.fps) || 30;
            const frameTime = 1 / fps;
            if (this.isFallback) {
                this.fallbackTime = Math.max(0, this.fallbackTime - frameTime);
                this.renderFallbackFrame();
                this.updateTimeline();
                return;
            }
            if (!this.video.duration) return;
            const newTime = Math.max(0, this.video.currentTime - frameTime);
            this.timeDisplay.textContent = this.formatTime(newTime);
            this.frameInfo.textContent = `${this.formatTime(newTime)} / ${this.formatTime(this.video.duration)}`;
            this.timelineSlider.value = newTime;
            this.video.currentTime = newTime;
        });
        this.frameForwardBtn.addEventListener('click', () => {
            const fps = Number(projectData?.settings?.fps) || 30;
            const frameTime = 1 / fps;
            if (this.isFallback) {
                this.fallbackTime = Math.min(this.fallbackDuration, this.fallbackTime + frameTime);
                this.renderFallbackFrame();
                this.updateTimeline();
                return;
            }
            if (!this.video.duration) return;
            const newTime = Math.min(this.video.duration, this.video.currentTime + frameTime);
            this.timeDisplay.textContent = this.formatTime(newTime);
            this.frameInfo.textContent = `${this.formatTime(newTime)} / ${this.formatTime(this.video.duration)}`;
            this.timelineSlider.value = newTime;
            this.video.currentTime = newTime;
        });

        // 停止
        this.stopBtn.addEventListener('click', () => this.stop());

        // 再生速度
        this.speedDownBtn.addEventListener('click', () => this.changeSpeed(-1));
        this.speedUpBtn.addEventListener('click', () => this.changeSpeed(1));
        this.speedResetBtn.addEventListener('click', () => this.resetSpeed());

        // タイムライン
        this.timelineSlider.addEventListener('input', (e) => {
            if (this.isFallback) {
                const fps = Number(projectData?.settings?.fps) || 30;
                const frame = parseInt(String(e.target.value), 10) || 1;
                this.fallbackTime = Math.max(0, (frame - 1) / fps);
                this.renderFallbackFrame();
                this.updateTimeline();
                return;
            }
            const time = parseFloat(e.target.value);
            if (!this.video) return;
            this.timeDisplay.textContent = this.formatTime(time);
            this.frameInfo.textContent = `${this.formatTime(time)} / ${this.formatTime(this.video.duration)}`;
            this.video.currentTime = time;
        });

        // 動画イベント
        this.video.addEventListener('loadedmetadata', () => this.onVideoLoaded());
        this.video.addEventListener('ended', () => this.onVideoEnded());
        this.video.addEventListener('play', () => this.onPlay());
        this.video.addEventListener('pause', () => this.onPause());
        this.video.addEventListener('error', () => this.enableFallback());
    }

    // 動画読み込み時の処理
    onVideoLoaded() {
        this.isFallback = false;
        if (this.fallbackImg) this.fallbackImg.style.display = 'none';
        if (this.video) this.video.style.display = '';
        const duration = this.video.duration;
        this.timelineSlider.max = duration;
        this.durationDisplay.textContent = this.formatTime(duration);
        this.updateTimeline();
        this.updateFrameInfo();
    }

    // 再生・一時停止切り替え
    togglePlayPause() {
        const tryEnsureSource = () => {
            try {
                // 既にソースがあり、メタデータも読めている場合は何もしない
                // src属性だけでなく currentSrc もチェック（<source>タグ使用時対応）
                if (this.video && (this.video.src || this.video.currentSrc) && this.video.readyState >= 1) return true;
                // 現在のモード/カメラからパスを取得
                const mode = (typeof getCurrentMode === 'function') ? getCurrentMode() : 'motion';
                const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
                const key = (mode === 'calibration') ? `cal-${cam}` : `${mode}-${cam}`;
                const vf = (typeof window !== 'undefined' && window.fileState) ? window.fileState[key] : null;
                const p = vf ? (typeof vf === 'string' ? vf : vf.path) : '';
                if (!p) return false;
                let src = normalizeFileUrl(p);
                this.video.src = src;
                this.video.load();
                return true;
            } catch (_) { return false; }
        };

        // ソースが無ければロードを試みる
        // src属性だけでなく currentSrc もチェック
        if (!this.video || (!this.video.src && !this.video.currentSrc)) {
            tryEnsureSource();
        }

        if (this.video.paused) {
            // メタデータが未読み込みの場合は読み込んでから再生
            if (this.isFallback) {
                // フォールバック: タイマー駆動
                if (this.fallbackTimer) clearInterval(this.fallbackTimer);
                const fps = Number(projectData?.settings?.fps) || 30;
                const dt = 1 / fps;
                this.fallbackTimer = setInterval(() => {
                    this.fallbackTime = Math.min(this.fallbackDuration, this.fallbackTime + dt);
                    this.renderFallbackFrame();
                    this.updateTimeline();
                    if (this.fallbackTime >= this.fallbackDuration) this.stop();
                }, Math.max(5, Math.round(dt * 1000)));
                this.isPlaying = true;
                this.updatePlayPauseButton();
                return;
            }
            if (this.video.readyState < 1) {
                // スライダーから現在の時間を取得（まだ動画がロードされていなくてもスライダーは動かせるため）
                const resumeTime = parseFloat(this.timelineSlider.value) || 0;

                const onLoaded = () => {
                    this.video.removeEventListener('loadedmetadata', onLoaded);
                    // 時間を復元してから再生
                    if (resumeTime > 0) {
                        this.video.currentTime = resumeTime;
                    }
                    this.video.play().catch(() => { });
                };
                this.video.addEventListener('loadedmetadata', onLoaded);
                if (!this.video.src) tryEnsureSource();
                try { this.video.load(); } catch (_) { }
            } else {
                this.video.play().catch(() => { });
            }
        } else {
            if (this.isFallback) {
                if (this.fallbackTimer) { clearInterval(this.fallbackTimer); this.fallbackTimer = null; }
                this.isPlaying = false;
                this.updatePlayPauseButton();
                return;
            }
            this.video.pause();
        }
    }

    // 再生速度変更（VideoSyncLabのchangePlaybackSpeedを参考）
    changeSpeed(direction) {
        const newIndex = this.currentSpeedIndex + direction;
        if (newIndex >= 0 && newIndex < this.speedLevels.length) {
            this.currentSpeedIndex = newIndex;
            this.currentSpeed = this.speedLevels[this.currentSpeedIndex];
            this.video.playbackRate = this.currentSpeed;
            this.speedDisplay.textContent = `${this.currentSpeed}x`;
        }
    }

    // 再生速度リセット
    resetSpeed() {
        this.currentSpeedIndex = 4; // 1.0x
        this.currentSpeed = 1.0;
        this.video.playbackRate = this.currentSpeed;
        this.speedDisplay.textContent = '1.0x';
    }

    // タイムライン更新
    updateTimeline() {
        if (this.isFallback) {
            const fps = Number(projectData?.settings?.fps) || 30;
            const frames = (typeof getCurrentMode === 'function' && getCurrentMode() === 'calibration')
                ? (projectData?.settings?.calibrationFrameCount || 0)
                : (projectData?.settings?.motionFrameCount || 0);
            this.fallbackDuration = frames > 0 ? frames / fps : (this.fallbackDuration || 0);
            this.timelineSlider.min = '1';
            this.timelineSlider.max = frames > 0 ? String(frames) : String(Math.max(1, Math.round(this.fallbackDuration * fps)));
            this.timelineSlider.step = '1';
            const t = Math.max(0, Math.min(this.fallbackDuration, this.fallbackTime));
            const currentFrame = Math.max(1, Math.min(frames || Math.round(this.fallbackDuration * fps), Math.floor(t * fps) + 1));
            this.timelineSlider.value = String(currentFrame);
            this.timeDisplay.textContent = this.formatTime(t);
            if (this.frameInfo) this.frameInfo.textContent = `${this.formatTime(t)} / ${this.formatTime(this.fallbackDuration)}`;
            return;
        }
        if (!this.video.duration) return;
        // HTML5再生時は秒ベース
        this.timelineSlider.min = '0';
        this.timelineSlider.max = String(this.video.duration);
        this.timelineSlider.step = '0.01';
        const t = this.video.currentTime;
        this.timelineSlider.value = t;
        this.timeDisplay.textContent = this.formatTime(t);
        this.updateFrameInfo();
    }

    // 動画終了時の処理
    onVideoEnded() {
        this.isPlaying = false;
        this.updatePlayPauseButton();
        this.stopUpdateTimer();
    }

    // 停止
    stop() {
        if (this.isFallback) {
            if (this.fallbackTimer) { clearInterval(this.fallbackTimer); this.fallbackTimer = null; }
            this.fallbackTime = 0;
            this.renderFallbackFrame();
            this.isPlaying = false;
            this.updatePlayPauseButton();
            this.stopUpdateTimer();
            return;
        }
        this.video.pause();
        this.video.currentTime = 0;
        this.isPlaying = false;
        this.updatePlayPauseButton();
        this.stopUpdateTimer();
    }

    // 再生開始時
    onPlay() {
        this.isPlaying = true;
        this.updatePlayPauseButton();
        this.startUpdateTimer();
    }

    // 一時停止時
    onPause() {
        this.isPlaying = false;
        this.updatePlayPauseButton();
        this.stopUpdateTimer();
    }

    // 再生・一時停止ボタン更新
    updatePlayPauseButton() {
        this.playPauseBtn.textContent = this.isPlaying ? '⏸' : '▶';
    }

    // 0.01秒間隔更新タイマー開始
    startUpdateTimer() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }
        this.updateTimer = setInterval(() => {
            this.updateTimeline();
        }, 10); // 10ミリ秒 = 0.01秒
    }

    // 0.01秒間隔更新タイマー停止
    stopUpdateTimer() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
    }

    // フレーム情報更新（時間表示に変更）
    updateFrameInfo() {
        if (this.isFallback) {
            if (!this.frameInfo) return;
            const t = Math.max(0, Math.min(this.fallbackDuration, this.fallbackTime));
            this.frameInfo.textContent = `${this.formatTime(t)} / ${this.formatTime(this.fallbackDuration)}`;
            return;
        }
        if (!this.video.duration) return;
        const currentTime = this.video.currentTime;
        const totalTime = this.video.duration;
        this.frameInfo.textContent = `${this.formatTime(currentTime)} / ${this.formatTime(totalTime)}`;
    }

    // 時間フォーマット（VideoSyncLabのUtils.formatTimeを参考）
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    // 動画読み込み
    loadVideo(videoPath) {
        try {
            let src = String(videoPath || '');
            if (!src) return Promise.resolve(false);
            src = normalizeFileUrl(src);
            this.currentPath = src;

            // 既存sourceをクリア
            try { this.video.pause(); } catch (_) { }
            try { this.video.removeAttribute('src'); } catch (_) { }
            while (this.video.firstChild) this.video.removeChild(this.video.firstChild);

            // 拡張子からMIMEを推定
            const ext = (src.split('.').pop() || '').toLowerCase();
            const mimeMap = {
                mp4: 'video/mp4',
                webm: 'video/webm',
                ogg: 'video/ogg',
                ogv: 'video/ogg',
                avi: 'video/x-msvideo',
                mov: 'video/quicktime',
                mkv: 'video/x-matroska'
            };
            const type = mimeMap[ext] || '';

            // 要件: aviのみは常にOpenCVフォールバックで再生
            if (ext === 'avi') {
                this.enableFallback();
                return Promise.resolve(true);
            }

            // 再生可否を事前判定（空文字=非対応）
            const canPlay = type ? (this.video.canPlayType(type) || '') : '';
            if (!canPlay) {
                this.enableFallback();
                return Promise.resolve(true);
            }

            const source = document.createElement('source');
            source.src = src;
            if (type) source.type = type;
            this.video.appendChild(source);

            // 動画メタデータ読み込み完了を待つPromiseを返す
            return new Promise((resolve) => {
                const onReady = () => {
                    this.video.removeEventListener('loadeddata', onReady);
                    this.video.removeEventListener('error', onError);
                    resolve(true);
                };
                const onError = () => {
                    this.video.removeEventListener('loadeddata', onReady);
                    this.video.removeEventListener('error', onError);
                    resolve(false);
                };
                this.video.addEventListener('loadeddata', onReady);
                this.video.addEventListener('error', onError);
                this.video.load();
                // 5秒タイムアウト
                setTimeout(() => { resolve(false); }, 5000);
            });
        } catch (_) {
            return Promise.resolve(false);
        }
    }

    // -------- Fallback (OpenCV抽出) --------
    enableFallback() {
        try {
            const mode = (typeof getCurrentMode === 'function') ? getCurrentMode() : 'motion';
            const frames = (mode === 'calibration') ? (projectData?.settings?.calibrationFrameCount || 0) : (projectData?.settings?.motionFrameCount || 0);
            const fps = Number(projectData?.settings?.fps) || 30;
            if (frames <= 0 || !fps) return; // フレーム数不明なら無効
            this.isFallback = true;
            this.fallbackDuration = frames / fps;
            this.fallbackTime = 0;
            if (this.video) this.video.style.display = 'none';
            if (this.fallbackImg) this.fallbackImg.style.display = '';
            this.updateTimeline();
            this.renderFallbackFrame();
        } catch (_) { }
    }

    async renderFallbackFrame() {
        try {
            const mode = (typeof getCurrentMode === 'function') ? getCurrentMode() : 'motion';
            const cam = (typeof getCurrentCamera === 'function') ? getCurrentCamera() : 'cam1';
            const key = (mode === 'calibration') ? `cal-${cam}` : `${mode}-${cam}`;
            const vf = (typeof window !== 'undefined' && window.fileState) ? window.fileState[key] : null;
            const raw = vf ? (typeof vf === 'string' ? vf : vf.path) : '';
            if (!raw) return;
            const fps = Number(projectData?.settings?.fps) || 30;
            const t = Math.max(0, Math.min(this.fallbackDuration, this.fallbackTime));
            const frameNumber = Math.max(1, Math.min(Math.floor(t * fps) + 1, Math.round(this.fallbackDuration * fps)));
            const result = await ipcRenderer.invoke('extract-frame-ffmpeg', raw, frameNumber, fps);
            if (result && result.success && this.fallbackImg && result.dataUrl) {
                this.fallbackImg.src = result.dataUrl;
            }
            // ラベル更新
            if (this.timeDisplay) this.timeDisplay.textContent = this.formatTime(t);
            if (this.frameInfo) this.frameInfo.textContent = `${this.formatTime(t)} / ${this.formatTime(this.fallbackDuration)}`;
            if (this.timelineSlider) this.timelineSlider.value = t;
        } catch (_) { }
    }
}

// ========================================================================================
// フレームナビゲーション
// ========================================================================================

/**
 * 現在フレームの表示（修正版）
 */
/**
 * フレームキャッシュクラス (LRU)
 */
// ========================================
// FFmpegファイルキャッシュ方式
// メモリキャッシュは使用せず、ディスク上のJPEGファイルを直接読み込む
// ========================================

let displayFrameTimeout = null;

// キャッシュ進捗の追跡用変数
let isCaching = false;
let currentCachingVideoPath = null;
const diskFrameCacheByVideo = new Map(); // { videoPath: { outputDir: string, isComplete: boolean } }

/**
 * ディスクベースのフレーム抽出を開始
 */
async function startDiskFrameExtraction(videoPath, totalFrames) {
    // キャリブレーション動画はキャッシュしない
    if (getCurrentMode() !== 'motion') return;

    if (!videoPath || totalFrames <= 0) return;

    // 既にキャッシュが完了しているか確認
    const cacheCheck = await ipcRenderer.invoke('check-frame-cache-exists', videoPath);
    if (cacheCheck.success && cacheCheck.exists) {
        console.log('[DiskCache] Already complete:', videoPath);
        diskFrameCacheByVideo.set(videoPath, { outputDir: cacheCheck.outputDir, isComplete: true });
        updateCacheProgress(totalFrames, totalFrames, true);
        return;
    }

    // 既に抽出中なら何もしない
    if (isCaching && currentCachingVideoPath === videoPath) {
        console.log('[DiskCache] Already extracting:', videoPath);
        // UIを強制的に表示（裏で動いているプロセスの進捗を表示させるため）
        updateCacheProgress(0, totalFrames, false);
        return;
    }

    isCaching = true;
    currentCachingVideoPath = videoPath;
    updateCacheProgress(0, totalFrames, false);

    // 進捗通知のリスナーを設定
    const progressHandler = (event, data) => {
        if (data.videoPath === videoPath) {
            updateCacheProgress(data.current, data.total, false);
        }
    };
    ipcRenderer.on('frame-extraction-progress', progressHandler);

    try {
        const result = await ipcRenderer.invoke('extract-all-frames-to-disk', videoPath, { quality: 85, totalFrames });

        if (result.success) {
            diskFrameCacheByVideo.set(videoPath, { outputDir: result.outputDir, isComplete: true });
            updateCacheProgress(totalFrames, totalFrames, true);
            console.log('[DiskCache] Extraction complete:', result.outputDir);
        } else if (result.error !== 'cancelled') {
            console.error('[DiskCache] Extraction failed:', result.error);
        }
    } finally {
        ipcRenderer.removeListener('frame-extraction-progress', progressHandler);
        isCaching = false;
        currentCachingVideoPath = null;
    }
}

/**
 * ディスクキャッシュからフレーム画像を取得
 */
async function getDiskCachedFrame(videoPath, frameNumber) {
    const cacheKey = `${videoPath}:${frameNumber}`;

    // メモリキャッシュ確認
    if (diskFrameImageCache[cacheKey] && diskFrameImageCache[cacheKey].complete) {
        return diskFrameImageCache[cacheKey];
    }

    // ディスクから取得
    const result = await ipcRenderer.invoke('get-cached-frame-path', videoPath, frameNumber);
    if (result.success && result.path) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                diskFrameImageCache[cacheKey] = img;
                resolve(img);
            };
            img.onerror = () => resolve(null);
            img.src = normalizeFileUrl(result.path);
        });
    }
    return null;
}

// グローバルに公開
window.startDiskFrameExtraction = startDiskFrameExtraction;
window.getDiskCachedFrame = getDiskCachedFrame;
window.diskFrameCacheByVideo = diskFrameCacheByVideo;

// countExistingCache は削除（FFmpegバッチ抽出では不要）

/**
 * キャッシュ進捗UIを更新（HPE_renderから移植）
 */
function updateCacheProgress(cached, total, isComplete = false) {
    const container = document.getElementById('cacheProgressContainer');
    const fillBar = document.getElementById('cacheProgressFill');
    const percentText = document.getElementById('cachePercent');
    const label = document.getElementById('cacheLabel');

    if (!container) return;

    // 表示を強制（呼び出された＝表示すべき）
    container.style.visibility = 'visible';

    const percent = total > 0 ? Math.min(100, Math.round((cached / total) * 100)) : 0;

    if (fillBar) fillBar.style.width = `${percent}%`;
    if (percentText) percentText.textContent = `${percent}%`;

    if (isComplete) {
        if (label) {
            label.textContent = '✓ キャッシュ完了';
            label.classList.add('complete');
        }
        if (fillBar) fillBar.classList.add('complete');
        if (percentText) percentText.classList.add('complete');
    } else {
        if (label) {
            label.textContent = 'キャッシュ中...';
            label.classList.remove('complete');
        }
        if (fillBar) fillBar.classList.remove('complete');
        if (percentText) percentText.classList.remove('complete');
    }
}

/**
 * カメラ切り替え時に既存キャッシュ進捗を表示
 */
function showExistingCacheProgress(videoPath, totalFrames) {
    const container = document.getElementById('cacheProgressContainer');
    if (!container) return;

    // 既存キャッシュをカウント
    const cached = countExistingCache(videoPath, totalFrames);
    const isComplete = cached >= totalFrames;

    // 進捗情報を保存
    cacheProgressByVideo.set(videoPath, { cached, total: totalFrames, isComplete });

    // UIを更新
    container.style.visibility = 'visible';
    updateCacheProgress(cached, totalFrames, isComplete);

    return { cached, isComplete };
}

// グローバルに公開
window.updateCacheProgress = updateCacheProgress;
window.showExistingCacheProgress = showExistingCacheProgress;


// 次フレーム群の事前読み込み（モーションモード専用、デジタイズ間隔で指定されたフレーム先）
// prefetchNextFrame は削除（FFmpegバッチ抽出に移行）

// 単一動画フレームを Image として読み込む共通関数
async function loadFrameImage(videoPath, frameNumber) {
    const fps = Number(window.projectData?.settings?.fps) || 30;
    const result = await ipcRenderer.invoke('extract-frame-ffmpeg', videoPath, frameNumber, fps);
    if (!result || !result.success) {
        throw new Error(result && result.error ? result.error : 'frame load failed');
    }

    let src = '';
    let isBlob = false;

    if (result.dataUrl) {
        // FFmpeg: data URL形式
        src = result.dataUrl;
    } else if (result.frameBuffer) {
        // Buffer(Uint8Array)を受信した場合: Blob -> URL
        const blob = new Blob([result.frameBuffer], { type: 'image/png' });
        src = URL.createObjectURL(blob);
        isBlob = true;
    } else if (result.frameData) {
        // 旧互換（OpenCV）: Base64
        src = 'data:image/png;base64,' + result.frameData;
    } else {
        throw new Error('no frame data');
    }

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            // BlobURLの場合は、ロード後にメモリ解放すべきだが
            // キャッシュする場合は保持する必要がある。
            // ここでは一時的な読み込みとして扱うが、呼び出し元で管理が必要。
            // 単発ロードならここでrevokeしてもimgは描画できるが、
            // 参照を維持するならrevokeしてはいけない。
            // 今回は「表示用」として返すので、そのまま返す。
            resolve(img);
        };
        img.onerror = () => {
            if (isBlob) URL.revokeObjectURL(src);
            reject(new Error('image decode failed'));
        };
        img.src = src;
        // メタデータとしてBlob URLかどうかを付与
        img.isBlobUrl = isBlob;
    });
}

/**
 * 現在フレームの表示（左右並び対応版）
 * ・通常: 現在カメラのみ
 * ・Charucoステレオ＋キャリブレーションモード: カメラ1/2 を横に並べて表示
 */
// シーク制御変数（ビデオ要素ごとに管理）
const _seekStateMap = new WeakMap();

function getSeekState(videoElement) {
    if (!_seekStateMap.has(videoElement)) {
        _seekStateMap.set(videoElement, {
            isSeeking: false,
            pendingSeekFrame: null,
            abortController: null
        });
    }
    return _seekStateMap.get(videoElement);
}

/**
 * 全ビデオ要素のseek状態をリセット（pending seekをクリア）
 */
function resetAllSeekStates() {
    const v1 = document.getElementById('digitize-video');
    const v2 = document.getElementById('digitize-video-2');
    [v1, v2].forEach(v => {
        if (v && _seekStateMap.has(v)) {
            const state = _seekStateMap.get(v);
            state.isSeeking = false;
            state.pendingSeekFrame = null;
            if (state.abortController) {
                state.abortController.abort();
                state.abortController = null;
            }
        }
    });
}

async function seekVideoToFrame(videoElement, videoPath, frameNumber) {
    if (!videoElement || !videoPath) return null;

    // ビデオ要素ごとのシーク状態を取得
    const seekState = getSeekState(videoElement);

    // 【強制表示】
    if (videoElement.style.display === 'none') {
        videoElement.style.display = 'block';
        videoElement.style.position = 'absolute';
        videoElement.style.width = '1px';
        videoElement.style.height = '1px';
        videoElement.style.opacity = '0';
        videoElement.style.pointerEvents = 'none';
        videoElement.style.zIndex = '-9999';
    }

    // パスの正規化（macOS/Windows両対応）
    let src = normalizeFileUrl(videoPath);

    const currentSrc = videoElement.currentSrc || videoElement.src;
    const isSrcChange = (!currentSrc || decodeURIComponent(currentSrc) !== decodeURIComponent(src));
    const needsLoad = isSrcChange || videoElement.readyState < 1;

    // ソース変更時 または まだメタデータ未取得の場合はロード実行
    if (needsLoad) {
        // ロード処理開始
        if (seekState.abortController) seekState.abortController.abort();
        seekState.abortController = new AbortController();
        const abortSignal = seekState.abortController.signal;

        seekState.isSeeking = false; // 強制リセット
        seekState.pendingSeekFrame = null;

        if (isSrcChange) {
            videoElement.src = src;
        }
        videoElement.load();

        // ロード待機 (HAVE_METADATA)
        await new Promise((resolve) => {
            if (abortSignal.aborted) { resolve(); return; }
            if (videoElement.readyState >= 1) { resolve(); return; }

            const onLoadedMetadata = () => {
                cleanup(); resolve();
            };
            const onError = (e) => {
                console.error('[seekVideoToFrame] Video load error:', videoElement.error, e);
                cleanup(); resolve();
            };
            const cleanup = () => {
                videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
                videoElement.removeEventListener('error', onError);
            };
            videoElement.addEventListener('loadedmetadata', onLoadedMetadata);
            videoElement.addEventListener('error', onError);
            setTimeout(() => { cleanup(); resolve(); }, 5000);
        });

        if (abortSignal.aborted) return videoElement;
    }

    // --- ここからSmart Seek (Coalescing) ---
    // もし現在シーク中であれば、今回のリクエストを「予約」して即座に終了する
    if (seekState.isSeeking) {
        seekState.pendingSeekFrame = frameNumber;
        return videoElement; // 前のシークが終わるのを待たずにUIスレッドを解放
    }

    seekState.isSeeking = true;

    try {
        // シーク計算には動画の実FPS（検出値）を使用
        // ユーザーUIのFPSは解析用であり、動画のタイムスタンプとは異なる場合がある
        const currentMode = (typeof getCurrentMode === 'function') ? getCurrentMode() : 'motion';
        const detectedFps = currentMode === 'calibration'
            ? (projectData?.settings?.calibrationFps || projectData?.settings?.detectedFps)
            : (projectData?.settings?.motionFps || projectData?.settings?.detectedFps);
        const fps = Number(detectedFps) || Number(projectData?.settings?.fps) || 30;
        const targetTime = Math.max(0, (frameNumber - 1) / fps);
        const frameDuration = 1 / fps;
        const tolerance = frameDuration * 0.5;

        // 既に近い場合はスキップ
        if (Math.abs(videoElement.currentTime - targetTime) < tolerance && videoElement.readyState >= 2) {
            // Do nothing
        } else {
            // シーク実行
            videoElement.currentTime = targetTime;

            // 完了待機 (VideoFrameCallbackがあれば使う)
            if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
                await new Promise(resolve => {
                    videoElement.requestVideoFrameCallback(() => resolve());
                    // 念のためタイムアウト：Scrubbing中は100msくらいで諦めて次へ行くほうがスムーズ
                    setTimeout(resolve, 100);
                });
            } else {
                await new Promise(resolve => {
                    const onSeeked = () => { videoElement.removeEventListener('seeked', onSeeked); resolve(); };
                    videoElement.addEventListener('seeked', onSeeked);
                    setTimeout(() => { videoElement.removeEventListener('seeked', onSeeked); resolve(); }, 200);
                });
            }
        }

        // データ準備完了待機 (readyState >= 2)
        if (videoElement.readyState < 2) {
            await new Promise(resolve => {
                const onData = () => { videoElement.removeEventListener('loadeddata', onData); resolve(); };
                videoElement.addEventListener('loadeddata', onData);
                setTimeout(resolve, 500);
            });
        }

    } catch (e) {
        console.error('Seek error:', e);
    } finally {
        seekState.isSeeking = false;

        // 保留中のリクエストがあれば、再帰的に実行（最新のペンディングのみ）
        if (seekState.pendingSeekFrame !== null) {
            const nextFrame = seekState.pendingSeekFrame;
            seekState.pendingSeekFrame = null;
            // 再帰呼び出しだが、asyncなのでスタックオーバーフローはしない
            return seekVideoToFrame(videoElement, videoPath, nextFrame);
        }
    }

    return videoElement;
}

// 画像ファイル判定用
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff', 'tif', 'webp'];
function isImageFile(filePath) {
    if (!filePath) return false;
    const ext = filePath.split('.').pop().toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

// 画像ファイルを読み込んでImageオブジェクトを返す
function loadImage(imagePath) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(new Error('Image load failed: ' + imagePath));
        img.src = normalizeFileUrl(imagePath);
    });
}

async function displayCurrentFrame() {
    // ChArUco検出中は何もしない（検出結果の上書き防止）
    if (window.__charucoDetectionInProgress) {
        return;
    }

    // console.log('[Display] displayCurrentFrame called');
    if (!digitizeCanvas || !digitizeCtx) {
        console.warn('[Display] Canvas or Context missing');
        return;
    }

    const currentMode = getCurrentMode();
    const currentCamera = getCurrentCamera();
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '';
    // キャリブレーションモード かつ (Charucoボード法(ステレオ) 選択時)
    const isCharucoStereo = (currentMode === 'calibration' && method === 'charuco-stereo');
    const isCharucoSingle = (currentMode === 'calibration' && method === 'charuco-single');

    const frameNumber = getCurrentFrameNumber();

    // 描画共通関数
    const renderImage = (source) => {
        // 検出中は描画をスキップ（検出結果の上書き防止）
        if (window.__charucoDetectionInProgress) {
            return;
        }

        // Video要素の場合は videoWidth/videoHeight、Imageの場合は width/height
        const width = source.videoWidth || source.width;
        const height = source.videoHeight || source.height;

        // console.log(`[Display] Rendering image. Size: ${width}x${height}`);

        if (width === 0 || height === 0) {
            return;
        }

        digitizeCanvas.width = width;
        digitizeCanvas.height = height;

        const container = digitizeCanvas.parentElement;
        const rect = container.getBoundingClientRect();
        const containerWidth = rect.width - 20;
        const containerHeight = rect.height - 20;
        const videoAspectRatio = width / height;
        const containerAspectRatio = containerWidth / containerHeight;

        let displayWidth, displayHeight;
        if (containerAspectRatio > videoAspectRatio) {
            displayHeight = containerHeight;
            displayWidth = displayHeight * videoAspectRatio;
        } else {
            displayWidth = containerWidth;
            displayHeight = displayWidth / videoAspectRatio;
        }

        digitizeCanvas.currentImage = source;
        // ImageBitmapやVideoの場合はメタデータも保持しておくと良いが、ここでは最低限

        digitizeCtx.clearRect(0, 0, digitizeCanvas.width, digitizeCanvas.height);
        digitizeCtx.save();
        digitizeCtx.translate(digitizeCanvas.width / 2, digitizeCanvas.height / 2);
        digitizeCtx.translate(panX, panY);
        digitizeCtx.scale(zoomScale, zoomScale);
        digitizeCtx.drawImage(source, -width / 2, -height / 2, width, height);
        digitizeCtx.restore();

        drawTrajectoriesIfNeeded();
        drawExistingPoints();
        drawStereoOverlayIfNeeded();
    };

    if (isCharucoStereo) {
        // --- ステレオ表示 (Native Video x 2) ---
        const videoFile1 = fileState['cal-cam1'];
        const videoFile2 = fileState['cal-cam2'];

        if (!videoFile1 || !videoFile2) {
            digitizeCtx.clearRect(0, 0, digitizeCanvas.width, digitizeCanvas.height);
            return;
        }

        const path1 = typeof videoFile1 === 'string' ? videoFile1 : videoFile1.path;
        const path2 = typeof videoFile2 === 'string' ? videoFile2 : videoFile2.path;

        try {
            // ソースチェックを追加
            const vPath1 = typeof path1 === 'string' ? path1 : null;
            const vPath2 = typeof path2 === 'string' ? path2 : null;

            if (!vPath1 || !vPath2) {
                digitizeCtx.clearRect(0, 0, digitizeCanvas.width, digitizeCanvas.height);
                return;
            }

            await Promise.all([
                seekVideoToFrame(digitizeVideo, path1, frameNumber),
                seekVideoToFrame(digitizeVideo2, path2, frameNumber)
            ]);

            // 非同期操作後、検出が開始されていたら描画をスキップ（検出結果の上書き防止）
            if (window.__charucoDetectionInProgress) {
                return;
            }

            const v1 = digitizeVideo;
            const v2 = digitizeVideo2;
            const w1 = v1.videoWidth;
            const h1 = v1.videoHeight;
            const w2 = v2.videoWidth;
            const h2 = v2.videoHeight;

            const combinedWidth = w1 + w2;
            const combinedHeight = Math.max(h1, h2);

            if (combinedWidth === 0 || combinedHeight === 0) {
                console.warn('[Display] Stereo combined size is 0');
                return;
            }

            const stereoCanvas = document.createElement('canvas');
            stereoCanvas.width = combinedWidth;
            stereoCanvas.height = combinedHeight;
            const sctx = stereoCanvas.getContext('2d');
            sctx.drawImage(v1, 0, (combinedHeight - h1) / 2);
            sctx.drawImage(v2, w1, (combinedHeight - h2) / 2);

            // ズーム・パン用の描画元として保持
            digitizeCanvas.currentImage = stereoCanvas; // 幅高情報を持つCanvas

            // 既存の有効な __stereoOverlayInfo がない場合のみリセット
            const existingOverlay = window.__stereoOverlayInfo;
            if (!existingOverlay || existingOverlay.commonCount == null) {
                window.__stereoOverlayInfo = {
                    commonCount: null,
                    required: 6,
                    canAdd: null
                };
            }

            renderImage(stereoCanvas);
            return;

        } catch (e) {
            console.error('Stereo native display error:', e);
            return;
        }
    }

    // --- シングル表示 (Native Video x 1) ---
    let videoPath = null;
    if (currentMode === 'calibration') {
        const videoFileKey = `cal-${currentCamera}`;
        const videoFile = fileState[videoFileKey];
        if (videoFile) {
            videoPath = typeof videoFile === 'string' ? videoFile : videoFile.path;
        }
    } else if (currentMode === 'motion') {
        const videoFileKey = `${currentMode}-${currentCamera}`;
        const videoFile = fileState[videoFileKey];
        if (videoFile) {
            videoPath = typeof videoFile === 'string' ? videoFile : videoFile.path;
        }
    }

    if (!videoPath) {
        digitizeCtx.clearRect(0, 0, digitizeCanvas.width, digitizeCanvas.height);
        return;
    }

    try {
        // 画像ファイルの場合
        if (isImageFile(videoPath)) {
            const img = await loadImage(videoPath);
            // 非同期操作後、検出が開始されていたら描画をスキップ
            if (window.__charucoDetectionInProgress) return;
            renderImage(img);
            return;
        }

        // モーションモードの場合: FFmpegディスクキャッシュを使用
        // キャリブレーション動画は数フレームしか使わないためキャッシュ不要（Video seekで十分）
        if (currentMode === 'motion') {
            // 1. ディスクキャッシュからフレームを取得
            const cacheResult = await ipcRenderer.invoke('get-cached-frame-path', videoPath, frameNumber);
            if (cacheResult.success && cacheResult.path) {
                const img = await loadImage(cacheResult.path);
                if (window.__charucoDetectionInProgress) return;
                renderImage(img);
                return;
            }

            // 2. キャッシュがない場合は抽出をバックグラウンドで開始
            const cacheInfo = diskFrameCacheByVideo.get(videoPath);
            if (!cacheInfo || !cacheInfo.isComplete) {
                const totalFrames = projectData?.settings?.motionFrameCount || 0;
                if (totalFrames > 0 && !isCaching) {
                    startDiskFrameExtraction(videoPath, totalFrames);
                }
            }
        }

        // フォールバック: Video要素でシーク
        await seekVideoToFrame(digitizeVideo, videoPath, frameNumber);

        // 非同期操作後、検出が開始されていたら描画をスキップ（検出結果の上書き防止）
        if (window.__charucoDetectionInProgress) return;

        if (digitizeVideo.videoWidth === 0) {
            // 万が一幅0なら次フレームで再試行（無限ループはしないよう1回だけ）
            if (!digitizeVideo._retryCount) digitizeVideo._retryCount = 0;
            digitizeVideo._retryCount++;
            if (digitizeVideo._retryCount < 3) {
                requestAnimationFrame(displayCurrentFrame);
                return;
            }
        }
        digitizeVideo._retryCount = 0; // Reset
        renderImage(digitizeVideo);

    } catch (e) {
        console.error('Native display error:', e);
    }
}

/**
 * フレームスライダー更新時のイベント競合回避
 */
function updateFrameSliderWithoutEvent(frameNumber) {
    const frameSlider = document.getElementById('frame-slider');
    if (frameSlider) {
        // 一時的にイベントリスナーを無効化
        frameSlider.disabled = true;

        // スライダー値を更新
        frameSlider.value = frameNumber;

        // イベントリスナーを再有効化
        setTimeout(() => {
            frameSlider.disabled = false;
        }, 100);
    }
}

/**
 * フレーム情報更新
 */
function updateFrameInfo() {
    const frameDisplayText = document.getElementById('frame-display-text');
    const frameSlider = document.getElementById('frame-slider');

    if (frameDisplayText) {
        const currentMode = getCurrentMode();
        const frameCount = currentMode === 'calibration' ? projectData.settings.calibrationFrameCount : projectData.settings.motionFrameCount;
        if (frameCount > 0) {
            frameDisplayText.textContent = `フレーム: ${projectData.settings.currentFrame} / ${frameCount}`;
        } else {
            frameDisplayText.textContent = 'フレーム:';
        }
    }
    if (frameSlider) {
        const currentMode = getCurrentMode();
        const frameCount = currentMode === 'calibration' ? projectData.settings.calibrationFrameCount : projectData.settings.motionFrameCount;
        frameSlider.max = frameCount;
        frameSlider.value = projectData.settings.currentFrame;
    }

    // プレビュープレイヤーのフレーム情報も更新
    if (previewPlayer) {
        previewPlayer.updateFrameInfo();
    }

    // データテーブルのハイライトのみ更新（全体更新は削除）
    updateTableHighlights();

    // ChArUco結果テーブル/analysis-board-select を現在フレームに同期
    if (typeof window.syncCharucoSelectionToCurrentFrame === 'function') {
        window.syncCharucoSelectionToCurrentFrame();
    }
}

/**
 * FPSフィールド更新
 */
function updateFPSField(fps) {
    const fpsInput = document.getElementById('fps');
    if (fpsInput) {
        fpsInput.value = fps;
    }
}

/**
 * フレーム移動（最適化版）
 */
async function goToFrame(frameNumber) {
    // フレーム番号を確実に数値型に変換
    const numericFrameNumber = parseInt(frameNumber);
    if (isNaN(numericFrameNumber)) {
        showError('無効なフレーム番号です: ' + frameNumber);
        return;
    }

    // 現在のモードに応じたフレーム数を取得
    const currentMode = getCurrentMode();
    const frameCount = currentMode === 'calibration' ? projectData.settings.calibrationFrameCount : projectData.settings.motionFrameCount;
    const maxFrame = Math.max(1, frameCount);

    // 確実に数値型で保存（最小値1、最大値frameCount）
    setCurrentFrameNumber(Math.max(1, Math.min(numericFrameNumber, maxFrame)));

    const frameSlider = document.getElementById('frame-slider');
    if (frameSlider) {
        frameSlider.value = projectData.settings.currentFrame;
    }

    updateFrameInfo();

    // データタブがアクティブな場合のみテーブルを更新
    const dataTab = document.getElementById('data-tab');
    if (dataTab && dataTab.classList.contains('active')) {
        updateMotionTableBodyOptimized(document.getElementById('data-table-body'));
    }

    // seek状態をリセット（pending seekをクリアして新しいseekを確実に実行）
    resetAllSeekStates();

    // displayCurrentFrame を呼び、currentImage が有効になるまで待機
    const maxRetries = 5;
    const retryDelay = 150; // ms (seekが完了するのを待つため少し長めに)

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        await displayCurrentFrame();

        // currentImage が有効かチェック
        if (digitizeCanvas && digitizeCanvas.currentImage &&
            digitizeCanvas.currentImage.width > 0 && digitizeCanvas.currentImage.height > 0) {
            break; // 有効になったら抜ける
        }

        // 有効でない場合は待機してリトライ
        if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }

    // セッションがアクティブな場合は自動検出を実行
    if (window.__calibSessionActive && typeof window.detectCharucoBoard === 'function') {
        try {
            await window.detectCharucoBoard();
        } catch (e) {
            console.warn('[goToFrame] Auto detection failed:', e);
        }
    }
}

/**
 * 前フレーム（最適化版）
 */
async function previousFrame() {
    const currentFrame = getCurrentFrameNumber();
    if (currentFrame <= 1) return;

    // モードに応じてステップを決定（モーション時はデジタイズ間隔を適用）
    const currentMode = getCurrentMode();
    const rawStep = (currentMode === 'motion') ? Number(projectData?.settings?.digitizeInterval) : 1;
    const step = (Number.isFinite(rawStep) && rawStep >= 1) ? Math.floor(rawStep) : 1;

    const prevFrameNumber = Math.max(1, currentFrame - step);

    // 即座にフレーム番号更新
    setCurrentFrameNumber(prevFrameNumber);

    // 即座にUI更新
    updateFrameInfo();

    // データタブがアクティブな場合のみテーブルを更新
    const dataTab = document.getElementById('data-tab');
    if (dataTab && dataTab.classList.contains('active')) {
        updateMotionTableBodyOptimized(document.getElementById('data-table-body'));
    }

    // フレーム表示（awaitで完了を待つ）
    await displayCurrentFrame();

    // セッションがアクティブな場合は自動検出を実行
    if (window.__calibSessionActive && typeof window.detectCharucoBoard === 'function') {
        try {
            await window.detectCharucoBoard();
        } catch (e) {
            console.warn('[previousFrame] Auto detection failed:', e);
        }
    }
}

/**
 * 次フレーム（最適化版）
 */
async function nextFrame() {
    const currentFrame = getCurrentFrameNumber();
    const currentMode = getCurrentMode();
    const frameCount = currentMode === 'calibration' ? projectData.settings.calibrationFrameCount : projectData.settings.motionFrameCount;
    if (currentFrame >= frameCount) return;

    // モードに応じてステップを決定（モーション時はデジタイズ間隔を適用）
    const rawStep = (currentMode === 'motion') ? Number(projectData?.settings?.digitizeInterval) : 1;
    const step = (Number.isFinite(rawStep) && rawStep >= 1) ? Math.floor(rawStep) : 1;

    const nextFrameNumber = Math.min(frameCount, currentFrame + step);

    // 即座にフレーム番号更新
    setCurrentFrameNumber(nextFrameNumber);

    // 即座にUI更新
    updateFrameInfo();

    // データタブがアクティブな場合のみテーブルを更新
    const dataTab = document.getElementById('data-tab');
    if (dataTab && dataTab.classList.contains('active')) {
        updateMotionTableBodyOptimized(document.getElementById('data-table-body'));
    }

    // フレーム表示（awaitで完了を待つ）
    await displayCurrentFrame();

    // セッションがアクティブな場合は自動検出を実行
    if (window.__calibSessionActive && typeof window.detectCharucoBoard === 'function') {
        try {
            await window.detectCharucoBoard();
        } catch (e) {
            console.warn('[nextFrame] Auto detection failed:', e);
        }
    }
}

// ========================================================================================
// タブ切り替え
// ========================================================================================

/**
 * タブ切り替え
 */
function switchTab(tabName) {
    // 両方のタブを常に表示
    const dataTabBtn = document.getElementById('data-tab-btn');
    const calibrationTabBtn = document.getElementById('calibration-tab-btn');

    if (dataTabBtn) dataTabBtn.style.display = 'inline-block';
    if (calibrationTabBtn) calibrationTabBtn.style.display = 'inline-block';

    // ES6+ Template literals使用
    const targetButton = document.querySelector(`[onclick="switchTab('${tabName}')"]`);
    const targetPanel = document.getElementById(`${tabName}-tab`);

    // ES6+ Optional chaining使用
    if (!targetButton || !targetPanel) {
        return;
    }

    // タブ切り替え処理
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    targetButton.classList.add('active');

    document.querySelectorAll('.tab-panel').forEach(content => {
        content.classList.remove('active');
    });
    targetPanel.classList.add('active');

    // タブ切り替え時にカメラ選択の有効/無効を更新
    if (typeof window.updateCameraSelectState === 'function') {
        window.updateCameraSelectState();
    }

    // デジタイズタブの場合はキャンバスを再描画
    if (tabName === 'digitize') {
        const getSelectedLandmarkFunc = window.getSelectedLandmark || getSelectedLandmark;
        const selected = (typeof getSelectedLandmarkFunc === 'function') ? getSelectedLandmarkFunc() : null;

        // ポイントが未選択で、かつポイントが存在する場合、自動的に最初のポイントとフレーム1を選択
        if (!selected && window.motionPoints && window.motionPoints.length > 0) {
            const firstPoint = window.motionPoints[0];
            const setSelectedLandmarkFunc = window.setSelectedLandmark || setSelectedLandmark;
            if (typeof setSelectedLandmarkFunc === 'function') {
                setSelectedLandmarkFunc(firstPoint);
            }

            // UIの同期
            const motionSelect = document.getElementById('motion-landmark-select');
            if (motionSelect) motionSelect.value = firstPoint.id;

            // フレーム1へ移動
            const setCurrentFrameNumberFunc = window.setCurrentFrameNumber || setCurrentFrameNumber;
            if (typeof setCurrentFrameNumberFunc === 'function') {
                setCurrentFrameNumberFunc(1);
            }
        }
        redrawCanvas();
    }

    // タブ切り替え時にテーブルを更新（既存データがある場合はスキップ）
    if (tabName === 'data') {
        // モーションテーブルが存在しない場合のみ更新
        if (!document.getElementById('data-table-body') || !document.getElementById('data-table-body').rows.length) {
            updateMotionDataTable();
        } else {
            // すでにデータがある場合は、現在の選択位置までスクロール
            if (typeof window.scrollToCurrentSelection === 'function') {
                window.scrollToCurrentSelection();
            }
        }
        // モーションタブのミニマップを更新
        setTimeout(() => {
            if (typeof window.updateMotionTabMinimap === 'function') {
                window.updateMotionTabMinimap();
            }
        }, 100);
    } else if (tabName === 'calibration') {
        // キャリブレーションテーブルを常に更新（データの整合性を保つため）
        updateCalibrationDataTable();
        // 2D DLT ステレオの場合はフレーム範囲を自動入力
        const method = document.getElementById('calibration-method') ? document.getElementById('calibration-method').value : '';
        if (method === '2d-dlt-stereo' && typeof window.autoPopulateStereoFrameRanges === 'function') {
            window.autoPopulateStereoFrameRanges();
        }
    } else if (tabName === 'points') {
        // ポイント設定タブの場合は初期化処理を行わない
        updatePointsTab();
    } else if (tabName === 'analysis') {
        // 分析結果タブがアクティブになった時の初期化
        setTimeout(() => {
            initializeRealLengthAnalysis();
            // ChArUcoボード選択UIの表示切替
            if (typeof window.updateCharucoBoardSelectUI === 'function') {
                window.updateCharucoBoardSelectUI();
            }
            // 分析タブのボード選択UIを更新
            if (typeof window.updateAnalysisBoardSelectUI === 'function') {
                window.updateAnalysisBoardSelectUI();
            }
            // データミニマップを更新
            if (typeof window.updateDataMinimap === 'function') {
                window.updateDataMinimap();
            }
            if (typeof window.initializeMinimapClickHandler === 'function') {
                window.initializeMinimapClickHandler();
            }
        }, 100);
    }
}

// ========================================================================================
// メッセージ表示
// ========================================================================================

/**
 * メッセージ表示
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
            break;
        }
    }

    // フォールバック: 実長換算メッセージエリア
    const rlMsg = document.getElementById('real-length-message');
    if (rlMsg) {
        rlMsg.textContent = message;
        rlMsg.style.display = 'block';
        rlMsg.style.background = '#d4edda';
        rlMsg.style.border = '1px solid #c3e6cb';
        rlMsg.style.color = '#155724';
    }
}

/**
 * エラーメッセージ表示
 */
function showError(message) {
    console.error('[showError]', message);

    const elements = [
        document.getElementById('status-text'),
        document.getElementById('message-display'),
        document.querySelector('.message-display span')
    ];

    let displayed = false;
    for (const element of elements) {
        if (element) {
            element.textContent = 'エラー: ' + message;
            element.style.color = '#ff0000';
            displayed = true;
            break;
        }
    }

    // フォールバック: 実長換算メッセージエリア
    const rlMsg = document.getElementById('real-length-message');
    if (rlMsg) {
        rlMsg.textContent = message;
        rlMsg.style.display = 'block';
        rlMsg.style.background = '#fdecea';
        rlMsg.style.border = '1px solid #f5c6cb';
        rlMsg.style.color = '#721c24';
        displayed = true;
    }

    // 最終フォールバック: alert
    if (!displayed) {
        alert('エラー: ' + message);
    }
}

// ========================================================================================
// エクスポート（Windowオブジェクトにアタッチ）
// ========================================================================================

// グローバル関数として公開
window.setupDigitizeCanvas = setupDigitizeCanvas;
window.redrawCanvas = redrawCanvas;
window.redrawCanvasOnly = redrawCanvasOnly;
window.drawStereoOverlayIfNeeded = drawStereoOverlayIfNeeded;
window.drawPoint = drawPoint;
window.resetZoom = resetZoom;
window.resetZoomPan = resetZoom; // エイリアス
window.updateZoomDisplay = updateZoomDisplay;
window.updatePanDisplay = updatePanDisplay;
window.clearCoordinates = clearCoordinates;
window.clearDigitizeCanvas = clearDigitizeCanvas;
window.displayCurrentFrame = displayCurrentFrame;
window.updateFrameInfo = updateFrameInfo;
window.updateFPSField = updateFPSField;
window.goToFrame = goToFrame;
window.previousFrame = previousFrame;
window.nextFrame = nextFrame;
window.switchTab = switchTab;
window.showMessage = showMessage;
window.showError = showError;

// ========================================================================================
// 再生機能
// ========================================================================================
let isPlaying = false;
let playbackAnimationId = null;
let lastPlaybackTime = 0;

/**
 * 再生/一時停止の切り替え
 */
function togglePlayback() {
    if (isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

// ========================================================================================
// 共通再生エンジン
// ========================================================================================

/**
 * Canvas にソース画像を描画し、オーバーレイ（ポイント・軌跡）を重ねる共通関数
 * @param {HTMLVideoElement|HTMLCanvasElement|HTMLImageElement} source
 */
function renderSourceToCanvas(source) {
    if (!digitizeCanvas || !digitizeCtx) return;
    const width = source.videoWidth || source.width;
    const height = source.videoHeight || source.height;
    if (width === 0 || height === 0) return;

    digitizeCanvas.width = width;
    digitizeCanvas.height = height;
    digitizeCanvas.currentImage = source;

    digitizeCtx.clearRect(0, 0, width, height);
    digitizeCtx.save();
    digitizeCtx.translate(width / 2, height / 2);
    digitizeCtx.translate(panX, panY);
    digitizeCtx.scale(zoomScale, zoomScale);
    digitizeCtx.drawImage(source, -width / 2, -height / 2, width, height);
    digitizeCtx.restore();

    drawTrajectoriesIfNeeded();
    drawExistingPoints();
    drawStereoOverlayIfNeeded();
}

/**
 * ステレオ用: 2つの Video 要素を横並び合成して Canvas 描画
 */
function renderStereoToCanvas(v1, v2) {
    const w1 = v1.videoWidth, h1 = v1.videoHeight;
    const w2 = v2.videoWidth, h2 = v2.videoHeight;
    if (w1 === 0 || w2 === 0) return;

    const combinedWidth = w1 + w2;
    const combinedHeight = Math.max(h1, h2);
    const stereoCanvas = document.createElement('canvas');
    stereoCanvas.width = combinedWidth;
    stereoCanvas.height = combinedHeight;
    const sctx = stereoCanvas.getContext('2d');
    sctx.drawImage(v1, 0, (combinedHeight - h1) / 2);
    sctx.drawImage(v2, w1, (combinedHeight - h2) / 2);

    renderSourceToCanvas(stereoCanvas);
}

/**
 * 再生開始（全モード統一エンジン）
 *
 * キャリブレーション（シングル/ステレオ）:
 *   → ネイティブ Video.play() + requestVideoFrameCallback でスムーズ再生
 * モーション:
 *   → displayCurrentFrame() ベース（キャッシュ JPEG + ポイントオーバーレイ）
 */
function startPlayback() {
    const currentMode = getCurrentMode();
    const detectedFps = currentMode === 'calibration'
        ? (projectData?.settings?.calibrationFps || projectData?.settings?.detectedFps)
        : (projectData?.settings?.motionFps || projectData?.settings?.detectedFps);
    const fps = Number(detectedFps) || Number(projectData?.settings?.fps) || 30;

    isPlaying = true;
    updatePlayButton();

    // --- モーションモード: displayCurrentFrame ベース（キャッシュ画像使用） ---
    if (currentMode === 'motion') {
        const frameInterval = 1000 / fps;
        lastPlaybackTime = performance.now();
        const frameCount = projectData?.settings?.motionFrameCount || 1000;

        function motionLoop(timestamp) {
            if (!isPlaying) return;
            const elapsed = timestamp - lastPlaybackTime;
            if (elapsed >= frameInterval) {
                const f = getCurrentFrameNumber();
                if (f >= frameCount) { stopPlayback(); return; }
                setCurrentFrameNumber(f + 1);
                displayCurrentFrame();
                updateFrameInfo();
                lastPlaybackTime = timestamp - (elapsed % frameInterval);
            }
            playbackAnimationId = requestAnimationFrame(motionLoop);
        }
        playbackAnimationId = requestAnimationFrame(motionLoop);
        return;
    }

    // --- キャリブレーションモード: ネイティブ Video 再生 ---
    const methodSelect = document.getElementById('calibration-method');
    const isStereo = methodSelect && methodSelect.value === 'charuco-stereo';

    const v1 = digitizeVideo;
    const v2 = isStereo ? digitizeVideo2 : null;

    // Video 準備チェック
    if (!v1 || v1.readyState < 2) {
        // Video 未準備 → displayCurrentFrame フォールバック
        _fallbackFramePlayback(fps, currentMode);
        return;
    }
    if (isStereo && (!v2 || v2.readyState < 2)) {
        _fallbackFramePlayback(fps, currentMode);
        return;
    }

    // ネイティブ再生開始
    v1.playbackRate = 1.0;
    v1.play().catch(() => {});
    if (v2) {
        v2.playbackRate = 1.0;
        v2.currentTime = v1.currentTime; // 開始時間を同期
        v2.play().catch(() => {});
    }

    // 描画ループ（requestVideoFrameCallback 優先、なければ rAF）
    const renderFrame = () => {
        if (isStereo && v2) {
            renderStereoToCanvas(v1, v2);
        } else {
            renderSourceToCanvas(v1);
        }
    };

    if ('requestVideoFrameCallback' in v1) {
        const onVideoFrame = (now, metadata) => {
            if (!isPlaying) return;
            // ステレオ同期補正: v2 が遅れたら追従
            if (v2 && Math.abs(v1.currentTime - v2.currentTime) > 0.05) {
                v2.currentTime = v1.currentTime;
            }
            renderFrame();
            const frame = Math.max(1, Math.round(metadata.mediaTime * fps) + 1);
            setCurrentFrameNumber(frame);
            updateFrameInfo();
            v1.requestVideoFrameCallback(onVideoFrame);
        };
        v1.requestVideoFrameCallback(onVideoFrame);
    } else {
        function rafLoop() {
            if (!isPlaying) return;
            if (v2 && Math.abs(v1.currentTime - v2.currentTime) > 0.05) {
                v2.currentTime = v1.currentTime;
            }
            renderFrame();
            const frame = Math.max(1, Math.round(v1.currentTime * fps) + 1);
            setCurrentFrameNumber(frame);
            updateFrameInfo();
            playbackAnimationId = requestAnimationFrame(rafLoop);
        }
        playbackAnimationId = requestAnimationFrame(rafLoop);
    }

    // 終了ハンドラ
    const onEnded = () => {
        v1.removeEventListener('ended', onEnded);
        stopPlayback();
    };
    v1.addEventListener('ended', onEnded);
}

/**
 * フォールバック: Video 未準備時の displayCurrentFrame ベース再生
 */
function _fallbackFramePlayback(fps, mode) {
    const frameInterval = 1000 / fps;
    lastPlaybackTime = performance.now();
    const frameCount = mode === 'calibration'
        ? (projectData?.settings?.calibrationFrameCount || 1000)
        : (projectData?.settings?.motionFrameCount || 1000);

    function loop(timestamp) {
        if (!isPlaying) return;
        const elapsed = timestamp - lastPlaybackTime;
        if (elapsed >= frameInterval) {
            const f = getCurrentFrameNumber();
            if (f >= frameCount) { stopPlayback(); return; }
            setCurrentFrameNumber(f + 1);
            displayCurrentFrame();
            updateFrameInfo();
            lastPlaybackTime = timestamp - (elapsed % frameInterval);
        }
        playbackAnimationId = requestAnimationFrame(loop);
    }
    playbackAnimationId = requestAnimationFrame(loop);
}

/**
 * 再生停止（全モード共通）
 */
function stopPlayback() {
    isPlaying = false;
    if (playbackAnimationId) {
        cancelAnimationFrame(playbackAnimationId);
        playbackAnimationId = null;
    }
    // ネイティブ再生中の Video を一時停止
    if (digitizeVideo && !digitizeVideo.paused) {
        digitizeVideo.pause();
    }
    if (digitizeVideo2 && !digitizeVideo2.paused) {
        digitizeVideo2.pause();
    }
    updatePlayButton();
    // 停止後に正確なフレームを再描画
    displayCurrentFrame();
}

/**
 * 再生ボタンの表示を更新
 */
function updatePlayButton() {
    const btn = document.getElementById('playPauseBtn');
    if (btn) {
        btn.textContent = isPlaying ? '⏸' : '▶';
        btn.title = isPlaying ? '一時停止' : '再生';
    }
}

window.togglePlayback = togglePlayback;
window.startPlayback = startPlayback;
window.stopPlayback = stopPlayback;

/**
 * 先頭フレームへ移動
 */
function goToFirstFrame() {
    stopPlayback();
    setCurrentFrameNumber(1);
    displayCurrentFrame();
    updateFrameInfo();
}

/**
 * 最終フレームへ移動
 */
function goToLastFrame() {
    stopPlayback();
    const currentMode = getCurrentMode();
    let frameCount = 1;
    if (currentMode === 'calibration') {
        frameCount = projectData?.settings?.calibrationFrameCount || 1;
    } else {
        frameCount = projectData?.settings?.motionFrameCount || 1;
    }
    setCurrentFrameNumber(frameCount);
    displayCurrentFrame();
    updateFrameInfo();
}

window.goToFirstFrame = goToFirstFrame;
window.goToLastFrame = goToLastFrame;

// PreviewPlayerをグローバルスコープで利用可能にする
window.PreviewPlayer = PreviewPlayer;

// 追加: ランドマークセレクタ初期化関数（app.js の後方互換APIを提供）
function initializeMotionLandmarkSelector() {
    const select = document.getElementById('motion-landmark-select');
    if (!select || !window.motionPoints) return;

    select.innerHTML = '<option value="">-- モーションポイントを選択 --</option>';
    window.motionPoints.forEach(point => {
        const option = document.createElement('option');
        option.value = point.id;
        option.textContent = `${point.id}. ${point.name}`;
        select.appendChild(option);
    });
}

function initializeCalibrationLandmarkSelector() {
    const select = document.getElementById('calibration-landmark-select');
    if (!select || !window.calibrationData) return;

    select.innerHTML = '<option value="">-- Calポイントを選択 --</option>';
    window.calibrationData.points.forEach(point => {
        const option = document.createElement('option');
        option.value = point.id;
        option.textContent = point.name;
        select.appendChild(option);
    });
}

// 後方互換のためグローバル公開
window.initializeMotionLandmarkSelector = initializeMotionLandmarkSelector;
window.initializeCalibrationLandmarkSelector = initializeCalibrationLandmarkSelector;

// イベントハンドラの互換実装
function onMotionLandmarkChange() {
    const select = document.getElementById('motion-landmark-select');
    const selectedId = select && select.value ? parseInt(select.value, 10) : null;
    if (selectedId && window.motionPoints) {
        const lm = window.motionPoints.find(p => p.id === selectedId) || null;
        if (lm && typeof window.setSelectedLandmark === 'function') {
            window.setSelectedLandmark(lm);
        }
    }
    if (typeof window.updateTableHighlights === 'function') window.updateTableHighlights();
    if (typeof window.redrawCanvasOnly === 'function') window.redrawCanvasOnly();
}

function onCalibrationLandmarkChange() {
    const select = document.getElementById('calibration-landmark-select');
    const selectedId = select && select.value ? select.value : null; // Calは文字列ID想定
    if (selectedId && window.calibrationData) {
        const lm = window.calibrationData.points.find(p => p.id == selectedId) || null;
        if (lm && typeof window.setSelectedLandmark === 'function') {
            window.setSelectedLandmark(lm);
        }
    }
    if (typeof window.updateTableHighlights === 'function') window.updateTableHighlights();
    if (typeof window.redrawCanvasOnly === 'function') window.redrawCanvasOnly();
}

/**
 * 前のモーションポイントへ移動
 */
function previousPoint() {
    const select = document.getElementById('motion-landmark-select');
    if (!select || select.options.length <= 1) return;

    let currentIndex = select.selectedIndex;
    if (currentIndex <= 1) {
        // 先頭にいる場合は最後へ
        select.selectedIndex = select.options.length - 1;
    } else {
        select.selectedIndex = currentIndex - 1;
    }
    onMotionLandmarkChange();
}

/**
 * 次のモーションポイントへ移動
 */
function nextPoint() {
    const select = document.getElementById('motion-landmark-select');
    if (!select || select.options.length <= 1) return;

    let currentIndex = select.selectedIndex;
    if (currentIndex >= select.options.length - 1 || currentIndex === 0) {
        // 最後にいる場合は先頭へ（0は空のオプションなので1へ）
        select.selectedIndex = 1;
    } else {
        select.selectedIndex = currentIndex + 1;
    }
    onMotionLandmarkChange();
}

/**
 * 前のキャリブレーションポイントへ移動
 */
function previousCalPoint() {
    const select = document.getElementById('calibration-landmark-select');
    if (!select || select.options.length <= 1) return;

    let currentIndex = select.selectedIndex;
    if (currentIndex <= 1) {
        select.selectedIndex = select.options.length - 1;
    } else {
        select.selectedIndex = currentIndex - 1;
    }
    onCalibrationLandmarkChange();
}

/**
 * 次のキャリブレーションポイントへ移動
 */
function nextCalPoint() {
    const select = document.getElementById('calibration-landmark-select');
    if (!select || select.options.length <= 1) return;

    let currentIndex = select.selectedIndex;
    if (currentIndex >= select.options.length - 1 || currentIndex === 0) {
        select.selectedIndex = 1;
    } else {
        select.selectedIndex = currentIndex + 1;
    }
    onCalibrationLandmarkChange();
}

window.onMotionLandmarkChange = onMotionLandmarkChange;
window.onCalibrationLandmarkChange = onCalibrationLandmarkChange;
window.previousPoint = previousPoint;
window.nextPoint = nextPoint;
window.previousCalPoint = previousCalPoint;
window.nextCalPoint = nextCalPoint;

// 後方互換: 旧app.js相当の関数を提供
function updateCalibrationButtonState() {
    const button = document.getElementById('calculate-camera-coefficients');
    if (!button || !window.calibrationData) return;
    const validPoints = window.calibrationData.points.filter(point => {
        const hasImageCoords = point.digitizedCoords && point.digitizedCoords.cam1 && point.digitizedCoords.cam1.x !== null && point.digitizedCoords.cam1.y !== null;
        const hasRealCoords = point.realCoords && point.realCoords.x !== null && point.realCoords.x !== undefined && point.realCoords.x !== '' && point.realCoords.y !== null && point.realCoords.y !== undefined && point.realCoords.y !== '';
        return hasImageCoords && hasRealCoords;
    });
    button.textContent = 'カメラ定数';
    button.disabled = false;
}

function setupCalibrationButtonEvent() {
    const button = document.getElementById('calculate-camera-coefficients');
    if (!button) return;
    button.addEventListener('click', () => {
        if (typeof window.runCameraCalibration === 'function') {
            window.runCameraCalibration();
        }
    });
}

window.updateCalibrationButtonState = updateCalibrationButtonState;
window.setupCalibrationButtonEvent = setupCalibrationButtonEvent;

// 2次元DLT法の較正を実行してUIを更新
function runCameraCalibration() {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '2d-dlt-single';
    console.info('[CAL] runCameraCalibration start, method =', method);

    // 3D DLT 対応
    if (method === '3d-dlt') {
        if (!window.calibrationData || !Array.isArray(window.calibrationData.points)) {
            if (typeof window.showError === 'function') window.showError('キャリブレーションポイントが見つかりません');
            return;
        }
        // 入力検証: cam1, cam2 の画像座標と 実座標 x,y,z が揃っている点をカウント
        const valid3d = window.calibrationData.points.filter(p =>
            p && p.digitizedCoords && p.realCoords &&
            p.digitizedCoords.cam1 && p.digitizedCoords.cam2 &&
            p.digitizedCoords.cam1.x != null && p.digitizedCoords.cam1.y != null &&
            p.digitizedCoords.cam2.x != null && p.digitizedCoords.cam2.y != null &&
            p.realCoords.x != null && p.realCoords.y != null && p.realCoords.z != null
        );
        console.info('[CAL][3D] valid calibration points =', valid3d.length);
        if (valid3d.length < 6) {
            if (typeof window.showError === 'function') window.showError('3次元DLTには少なくとも6点の較正点（両カメラの画像座標と実座標x,y,z）が必要です');
            return;
        }
        if (!window.AnalysisEngine || typeof window.AnalysisEngine.perform3DDLTCalibration !== 'function') {
            if (typeof window.showError === 'function') window.showError('3D較正エンジンが見つかりません');
            return;
        }
        if (typeof window.showMessage === 'function') window.showMessage('3次元DLT較正を開始します…');
        const res3d = window.AnalysisEngine.perform3DDLTCalibration(window.calibrationData.points, window.projectData);
        console.info('[CAL][3D] result =', res3d);
        if (res3d && res3d.success) {
            // テーブルへ反映（各ポイントの誤差は perform3DDLTCalibration 内で point.errors に格納済み）
            if (typeof window.updateCalibrationDataTable === 'function') {
                window.updateCalibrationDataTable();
            }
            // 3D結果表示
            if (typeof window.update3DDLTResultsDisplay === 'function') {
                window.update3DDLTResultsDisplay(res3d);
            }
            // 結果表示（係数の専用表示は未実装のためメッセージのみ）
            if (typeof window.showMessage === 'function') {
                const se = res3d.standardError || { seX: 0, seY: 0, seZ: 0 };
                window.showMessage(`3次元DLT較正完了（点数: ${res3d.pointCount}, SE: x=${se.seX.toFixed(6)} m, y=${se.seY.toFixed(6)} m, z=${se.seZ.toFixed(6)} m）`);
            }
            // 標準誤差情報をprojectDataに保存
            if (res3d.standardError && window.projectData) {
                window.projectData.calibrationErrorAnalysis3D = {
                    standardError: res3d.standardError,
                    meanError: res3d.meanError || Math.sqrt(res3d.standardError.seX * res3d.standardError.seX +
                        res3d.standardError.seY * res3d.standardError.seY +
                        res3d.standardError.seZ * res3d.standardError.seZ),
                    maxError: res3d.maxError || Math.max(res3d.standardError.seX, res3d.standardError.seY, res3d.standardError.seZ),
                    pointCount: res3d.pointCount
                };
            }
        } else {
            if (typeof window.showError === 'function') window.showError(res3d && res3d.error ? res3d.error : '3次元DLT較正に失敗しました');
        }
        return;
    }

    // 4点実長換算の処理
    if (method === '4-point') {
        if (!window.calibrationData || !Array.isArray(window.calibrationData.points)) {
            if (typeof window.showError === 'function') window.showError('キャリブレーションポイントが見つかりません');
            return;
        }

        // 4点のデジタイズ座標の検証
        const valid = window.calibrationData.points.filter(p =>
            p && p.digitizedCoords && p.digitizedCoords.cam1 &&
            p.digitizedCoords.cam1.x != null && p.digitizedCoords.cam1.y != null
        );
        console.info('[CAL][4-point] valid calibration points =', valid.length);
        if (valid.length < 4) {
            if (typeof window.showError === 'function') window.showError('4点実長換算には4点のデジタイズ座標が必要です');
            return;
        }

        // 4点実長換算の計算実行
        if (typeof window.showMessage === 'function') window.showMessage('4点実長換算を開始します…');
        const result = performFourPointRealLengthCalculation(window.calibrationData.points);
        console.info('[CAL][4-point] result =', result);

        if (result && result.success) {
            // プロジェクトデータに保存
            if (window.projectData) {
                window.projectData.fourPointCalibration = result;
            }

            // 結果表示
            if (typeof window.showMessage === 'function') {
                window.showMessage(`4点実長換算完了（スケールファクター: ${result.scaleFactor.toFixed(6)}, 回転角度: ${(result.rotationAngle * 180 / Math.PI).toFixed(2)}°）`);
            }

            // 結果をUIに表示
            if (typeof window.updateFourPointResultsDisplay === 'function') {
                window.updateFourPointResultsDisplay(result);
            }
        } else {
            if (typeof window.showError === 'function') window.showError(result && result.error ? result.error : '4点実長換算に失敗しました');
        }
        return;
    }

    // 2D DLT（シングル/ステレオ）以外は未対応
    if (method !== '2d-dlt-single' && method !== '2d-dlt-stereo') {
        if (typeof window.showError === 'function') window.showError('現在の方式では自動較正が未対応です');
        return;
    }

    if (!window.calibrationData || !Array.isArray(window.calibrationData.points)) {
        if (typeof window.showError === 'function') window.showError('キャリブレーションポイントが見つかりません');
        return;
    }

    // 最低限の点数と入力の検証（画像座標+実座標x,y）
    const valid = window.calibrationData.points.filter(p =>
        p && p.digitizedCoords && p.digitizedCoords.cam1 &&
        p.digitizedCoords.cam1.x != null && p.digitizedCoords.cam1.y != null &&
        p.realCoords && p.realCoords.x != null && p.realCoords.y != null
    );
    console.info('[CAL][2D] valid calibration points =', valid.length);
    if (valid.length < 4) {
        if (typeof window.showError === 'function') window.showError('少なくとも4点の較正点（画像座標と実座標）が必要です');
        return;
    }

    // 2D DLT（シングル）
    if (method === '2d-dlt-single' && typeof window.perform2DDLTCalibration === 'function') {
        if (typeof window.showMessage === 'function') window.showMessage('2次元DLT較正を開始します…');
        const result = window.perform2DDLTCalibration(window.calibrationData.points, window.projectData);
        console.info('[CAL][2D] result =', result);
        if (result && result.success) {
            // 誤差情報をprojectDataに保存
            if (!window.projectData.calibrationErrorAnalysis) {
                window.projectData.calibrationErrorAnalysis = {};
            }
            const currentCamera = typeof getCurrentCamera === 'function' ? getCurrentCamera() : 'cam1';
            window.projectData.calibrationErrorAnalysis[currentCamera] = result.errorAnalysis;

            if (typeof window.updateCalibrationDisplay === 'function') {
                window.updateCalibrationDisplay(result.coefficients, result.errorAnalysis);
            }
            if (typeof window.updateCalibrationDataTable === 'function') {
                window.updateCalibrationDataTable();
            }
            if (typeof window.showMessage === 'function') {
                const cnt = result.validPointCount || valid.length;
                const mean = result.errorAnalysis ? Number(result.errorAnalysis.meanError).toFixed(6) : '-';
                const max = result.errorAnalysis ? Number(result.errorAnalysis.maxError).toFixed(6) : '-';
                window.showMessage(`較正完了（点数: ${cnt}, 平均誤差: ${mean} m, 最大誤差: ${max} m）`);
            }
        } else {
            if (typeof window.showError === 'function') window.showError(result && result.error ? result.error : '較正に失敗しました');
        }
        return;
    }

    // 2D DLT（ステレオ）
    if (method === '2d-dlt-stereo') {
        if (typeof window.perform2DDLTCalibration !== 'function') {
            if (typeof window.showError === 'function') window.showError('較正エンジンが見つかりません');
            return;
        }

        // Cam1: そのまま使用
        const pointsCam1 = window.calibrationData.points.filter(p =>
            p?.digitizedCoords?.cam1?.x != null && p?.digitizedCoords?.cam1?.y != null &&
            p?.realCoords?.x != null && p?.realCoords?.y != null
        );
        // Cam2: perform2DDLTCalibration が cam1 の u,v を参照する前提のため、
        // cam2 の u,v を cam1 に写し替えた正規化配列を作成
        const pointsCam2Raw = window.calibrationData.points.filter(p =>
            p?.digitizedCoords?.cam2?.x != null && p?.digitizedCoords?.cam2?.y != null &&
            p?.realCoords?.x != null && p?.realCoords?.y != null
        );
        const normalizedCam2 = pointsCam2Raw.map(p => ({
            id: p.id,
            name: p.name,
            digitizedCoords: {
                cam1: { x: p.digitizedCoords.cam2.x, y: p.digitizedCoords.cam2.y },
                cam2: { x: p.digitizedCoords.cam2.x, y: p.digitizedCoords.cam2.y }
            },
            realCoords: { x: p.realCoords.x, y: p.realCoords.y, z: p.realCoords.z ?? null }
        }));
        const coeffCam1 = window.perform2DDLTCalibration(pointsCam1, window.projectData);
        const coeffCam2 = window.perform2DDLTCalibration(normalizedCam2, window.projectData);
        if (!coeffCam1?.success || !coeffCam2?.success) {
            if (typeof window.showError === 'function') window.showError('ステレオ係数の推定に失敗しました');
            return;
        }

        const s1 = parseInt(document.getElementById('cam1-start')?.value || '1', 10);
        const e1 = parseInt(document.getElementById('cam1-end')?.value || '0', 10);
        const s2 = parseInt(document.getElementById('cam2-start')?.value || '1', 10);
        const e2 = parseInt(document.getElementById('cam2-end')?.value || '0', 10);
        const blend = document.getElementById('stereo-blend')?.value || 'linear';

        if (typeof window.stitchStereo2DDLT !== 'function') {
            if (typeof window.showError === 'function') window.showError('ステレオ結合ロジックが見つかりません');
            return;
        }

        const out = window.stitchStereo2DDLT({
            coeffCam1: coeffCam1.coefficients,
            coeffCam2: coeffCam2.coefficients,
            frameRanges: { s1, e1, s2, e2 },
            blendMode: blend,
            cam1Data: window.cameraDigitizeData?.cam1 || {},
            cam2Data: window.cameraDigitizeData?.cam2 || {},
            motionPoints: window.motionPoints || []
        });

        if (window.projectData) {
            window.projectData.stereo2DDLT = { frames: out };
            // 2D用のカメラ定数を永続化（Cam1/Cam2）
            window.projectData.cameraCoefficients2D = window.projectData.cameraCoefficients2D || {};
            window.projectData.cameraCoefficients2D.cam1 = coeffCam1.coefficients;
            window.projectData.cameraCoefficients2D.cam2 = coeffCam2.coefficients;
            // 誤差情報も保存
            window.projectData.calibrationErrorAnalysis = window.projectData.calibrationErrorAnalysis || {};
            window.projectData.calibrationErrorAnalysis.cam1 = coeffCam1.errorAnalysis;
            window.projectData.calibrationErrorAnalysis.cam2 = coeffCam2.errorAnalysis;
        }
        // UI反映: Cam1/Cam2の係数・誤差を表示
        try {
            if (typeof window.update2DDLTResultsDisplayStereo === 'function') {
                window.update2DDLTResultsDisplayStereo(coeffCam1.coefficients, coeffCam1.errorAnalysis, 'cam1');
                window.update2DDLTResultsDisplayStereo(coeffCam2.coefficients, coeffCam2.errorAnalysis, 'cam2');
            }
            if (typeof window.update2DErrorsForCurrentCamera === 'function') window.update2DErrorsForCurrentCamera();
        } catch (_) { }

        if (typeof window.showMessage === 'function') window.showMessage('2次元DLT（ステレオ）を完了しました');
        return;
    }
}

// 4点実長換算の計算関数
function performFourPointRealLengthCalculation(points) {
    try {
        // 4点の座標を取得（Cal1=左奥, Cal2=右奥, Cal3=左手前, Cal4=右手前）
        const pointMap = {};
        points.forEach(point => {
            if (point.digitizedCoords && point.digitizedCoords.cam1) {
                pointMap[point.id] = {
                    x: point.digitizedCoords.cam1.x,
                    y: point.digitizedCoords.cam1.y
                };
            }
        });

        // 必要な4点が揃っているかチェック
        if (!pointMap.Cal1 || !pointMap.Cal2 || !pointMap.Cal3 || !pointMap.Cal4) {
            return { success: false, error: '4点のデジタイズ座標が揃っていません' };
        }

        // 各辺のピクセル長を計算
        const leftSide = Math.sqrt(
            Math.pow(pointMap.Cal1.x - pointMap.Cal3.x, 2) +
            Math.pow(pointMap.Cal1.y - pointMap.Cal3.y, 2)
        ); // 左奥-左手前

        const rightSide = Math.sqrt(
            Math.pow(pointMap.Cal2.x - pointMap.Cal4.x, 2) +
            Math.pow(pointMap.Cal2.y - pointMap.Cal4.y, 2)
        ); // 右奥-右手前

        const topSide = Math.sqrt(
            Math.pow(pointMap.Cal1.x - pointMap.Cal2.x, 2) +
            Math.pow(pointMap.Cal1.y - pointMap.Cal2.y, 2)
        ); // 左奥-右奥

        const bottomSide = Math.sqrt(
            Math.pow(pointMap.Cal3.x - pointMap.Cal4.x, 2) +
            Math.pow(pointMap.Cal3.y - pointMap.Cal4.y, 2)
        ); // 左手前-右手前

        // 対角線の長さを計算
        const diagonal1 = Math.sqrt(
            Math.pow(pointMap.Cal1.x - pointMap.Cal4.x, 2) +
            Math.pow(pointMap.Cal1.y - pointMap.Cal4.y, 2)
        ); // 左奥-右手前

        const diagonal2 = Math.sqrt(
            Math.pow(pointMap.Cal2.x - pointMap.Cal3.x, 2) +
            Math.pow(pointMap.Cal2.y - pointMap.Cal3.y, 2)
        ); // 右奥-左手前

        // 実長の設定（入力ボックスから取得）
        const markerDistanceInput = document.getElementById('marker-distance-input');
        const realLength = markerDistanceInput ? parseFloat(markerDistanceInput.value) || 1.0 : 1.0;

        // スケールファクターの計算（対角線の平均を使用）
        const averageDiagonal = (diagonal1 + diagonal2) / 2;
        const scaleFactor = realLength / averageDiagonal;

        // 回転角度の計算（上辺の角度を使用）
        const rotationAngle = Math.atan2(
            pointMap.Cal2.y - pointMap.Cal1.y,
            pointMap.Cal2.x - pointMap.Cal1.x
        );

        // 原点の設定（任意設定がある場合はそれを使用、ない場合は「マーカー左奥」と「マーカー左手前」の中点）
        let origin;
        if (pointMap.OriginXY && pointMap.OriginXY.x != null && pointMap.OriginXY.y != null) {
            origin = {
                x: pointMap.OriginXY.x,
                y: pointMap.OriginXY.y
            };
        } else {
            // 「マーカー左奥」と「マーカー左手前」の中点を原点とする
            origin = {
                x: (pointMap.Cal1.x + pointMap.Cal3.x) / 2,
                y: (pointMap.Cal1.y + pointMap.Cal3.y) / 2
            };
        }

        // 縦横比の計算（スケールデータがある場合はW/H、ない場合は1.0）
        let aspectRatio = 1.0;
        if (pointMap.ScaleH_L && pointMap.ScaleH_R &&
            pointMap.ScaleH_L.x != null && pointMap.ScaleH_L.y != null &&
            pointMap.ScaleH_R.x != null && pointMap.ScaleH_R.y != null &&
            pointMap.ScaleV_T && pointMap.ScaleV_B &&
            pointMap.ScaleV_T.x != null && pointMap.ScaleV_T.y != null &&
            pointMap.ScaleV_B.x != null && pointMap.ScaleV_B.y != null) {
            // 水平スケールのピクセル長（W）
            const scaleHorizontal = Math.sqrt(
                Math.pow(pointMap.ScaleH_R.x - pointMap.ScaleH_L.x, 2) +
                Math.pow(pointMap.ScaleH_R.y - pointMap.ScaleH_L.y, 2)
            );
            // 垂直スケールのピクセル長（H）
            const scaleVertical = Math.sqrt(
                Math.pow(pointMap.ScaleV_T.x - pointMap.ScaleV_B.x, 2) +
                Math.pow(pointMap.ScaleV_T.y - pointMap.ScaleV_B.y, 2)
            );
            // 縦横比 = W / H
            if (scaleVertical > 0) {
                aspectRatio = scaleHorizontal / scaleVertical;
            }
        }

        return {
            success: true,
            realLength: realLength,
            scaleFactor: scaleFactor,
            rotationAngle: rotationAngle,
            origin: origin,
            aspectRatio: aspectRatio,
            pixelLengths: {
                leftSide: leftSide,
                rightSide: rightSide,
                topSide: topSide,
                bottomSide: bottomSide,
                diagonal1: diagonal1,
                diagonal2: diagonal2
            },
            realLength: realLength
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

// 4点実長換算によるモーションデータの実長換算
function performFourPointMotionRealLengthCalculation(calibrationResult) {
    try {
        if (!window.cameraDigitizeData || !window.cameraDigitizeData.cam1) {
            return { success: false, error: 'モーションデータがありません' };
        }

        const cam1Data = window.cameraDigitizeData.cam1;
        const frames = Object.keys(cam1Data).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);

        if (frames.length === 0) {
            return { success: false, error: 'モーションデータのフレームがありません' };
        }

        const results = [];
        const { scaleFactor, rotationAngle, origin } = calibrationResult;

        frames.forEach(frame => {
            const frameData = cam1Data[frame];
            if (!frameData || typeof frameData.forEach !== 'function') return;

            frameData.forEach((pixel, pointId) => {
                if (pixel && typeof pixel.x === 'number' && typeof pixel.y === 'number') {
                    // 原点を基準にした相対座標
                    const relativeX = pixel.x - origin.x;
                    const relativeY = pixel.y - origin.y;

                    // 回転を考慮した座標変換
                    const cos = Math.cos(-rotationAngle);
                    const sin = Math.sin(-rotationAngle);
                    const rotatedX = relativeX * cos - relativeY * sin;
                    const rotatedY = relativeX * sin + relativeY * cos;

                    // スケールファクターを適用して実長に変換（Yは反転）
                    const realX = rotatedX * scaleFactor;
                    const realY = -rotatedY * scaleFactor;

                    results.push({
                        frame: frame,
                        pointId: pointId,
                        x: realX,
                        y: realY
                    });
                }
            });
        });

        return { success: true, data: results };
    } catch (error) {
        console.error('4点実長換算モーションデータ変換エラー:', error);
        return { success: false, error: error.message };
    }
}

// 実長換算統計情報の更新
function updateRealLengthStatistics(data) {
    if (!Array.isArray(data) || data.length === 0) {
        // 統計情報をリセット
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
        setText('total-frames', '0');
        setText('total-points', '0');
        setText('average-error', '0.00 m');
        setText('maximum-error', '0.00 m');
        return;
    }

    const uniqueFrames = new Set(data.map(r => r.frame));
    const totalPoints = data.length;

    // 簡易的な誤差計算（実際の誤差計算は複雑なため、ここでは基本的な統計のみ）
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
    setText('total-frames', uniqueFrames.size);
    setText('total-points', totalPoints);
    setText('average-error', '0.00 m'); // 4点実長換算では誤差計算は複雑
    setText('maximum-error', '0.00 m');
}

// 4点実長換算結果の表示関数（品質カードデザイン統一）
function updateFourPointResultsDisplay(result) {
    let resultsContainer = document.getElementById('four-point-results-container');
    if (!resultsContainer) {
        resultsContainer = document.createElement('div');
        resultsContainer.id = 'four-point-results-container';
        resultsContainer.innerHTML = `
            <div id="fp-quality-card" class="calib-quality-card" style="padding:10px 14px;">
                <div class="calib-quality-header" style="gap:12px;">
                    <span class="material-symbols-outlined calib-quality-icon" id="fp-quality-icon">straighten</span>
                    <div class="calib-quality-title-block" style="flex:0 0 auto;">
                        <div class="calib-quality-title" style="font-size:0.9em;">4点実長換算</div>
                        <div id="fp-quality-badge" class="calib-quality-badge">計算済み</div>
                    </div>
                    <div class="calib-quality-metrics" style="gap:16px;">
                        <div class="calib-quality-metric">
                            <span class="calib-quality-metric-label">スケール</span>
                            <span id="scale-factor-value" class="calib-quality-metric-value" style="font-size:1.1em;">-</span>
                            <span class="calib-quality-metric-unit">m/px</span>
                        </div>
                        <div class="calib-quality-metric">
                            <span class="calib-quality-metric-label">実長</span>
                            <span id="fp-real-length-big" class="calib-quality-metric-value" style="font-size:1.1em;">-</span>
                            <span class="calib-quality-metric-unit">m</span>
                        </div>
                    </div>
                </div>
            </div>
            <details style="margin-top:8px;">
                <summary style="cursor:pointer; font-weight:600; font-size:0.9em;">詳細データ</summary>
                <div style="display:flex; gap:16px; flex-wrap:wrap; margin-top:6px; font-size:0.9em;">
                    <div>
                        <div style="font-weight:600; margin-bottom:4px;">換算値</div>
                        <table class="cc-params-table" style="font-size:0.9em;">
                            <tr><td>回転角度</td><td id="rotation-angle-value" style="text-align:right;">-</td></tr>
                            <tr><td>縦横比</td><td id="aspect-ratio-value" style="text-align:right;">-</td></tr>
                            <tr><td>実長（対角線平均）</td><td id="real-length-value" style="text-align:right;">-</td></tr>
                        </table>
                    </div>
                    <div>
                        <div style="font-weight:600; margin-bottom:4px;">ピクセル長</div>
                        <table class="cc-params-table" style="font-size:0.9em;">
                            <tr><td>左辺</td><td id="left-side-length" style="text-align:right;">-</td><td>px</td></tr>
                            <tr><td>右辺</td><td id="right-side-length" style="text-align:right;">-</td><td>px</td></tr>
                            <tr><td>上辺</td><td id="top-side-length" style="text-align:right;">-</td><td>px</td></tr>
                            <tr><td>下辺</td><td id="bottom-side-length" style="text-align:right;">-</td><td>px</td></tr>
                            <tr><td>対角線1</td><td id="diagonal1-length" style="text-align:right;">-</td><td>px</td></tr>
                            <tr><td>対角線2</td><td id="diagonal2-length" style="text-align:right;">-</td><td>px</td></tr>
                        </table>
                    </div>
                </div>
            </details>
        `;

        const calibrationArea = document.querySelector('.calibration-results') ||
            document.getElementById('legacy-calibration-container');
        if (calibrationArea) {
            calibrationArea.appendChild(resultsContainer);
        }
    }

    // 品質カード更新
    const sf = result.scaleFactor;
    document.getElementById('scale-factor-value').textContent = sf.toFixed(6);
    const fpRealBig = document.getElementById('fp-real-length-big');
    if (fpRealBig) fpRealBig.textContent = (result.realLength != null) ? Number(result.realLength).toFixed(3) : '-';
    document.getElementById('rotation-angle-value').textContent = (result.rotationAngle * 180 / Math.PI).toFixed(2) + '\u00B0';

    const card = document.getElementById('fp-quality-card');
    if (card) {
        card.className = 'calib-quality-card quality-good';
    }
    const badge = document.getElementById('fp-quality-badge');
    if (badge) badge.textContent = '計算済み';
    const icon = document.getElementById('fp-quality-icon');
    if (icon) icon.textContent = 'check_circle';

    // 詳細データ
    document.getElementById('aspect-ratio-value').textContent = result.aspectRatio.toFixed(4);
    document.getElementById('real-length-value').textContent = (result.realLength != null) ? Number(result.realLength).toFixed(3) + ' m' : '-';

    const inputField = document.getElementById('marker-distance-input');
    if (inputField && result.realLength != null) {
        inputField.value = result.realLength;
    }

    document.getElementById('left-side-length').textContent = result.pixelLengths.leftSide.toFixed(2);
    document.getElementById('right-side-length').textContent = result.pixelLengths.rightSide.toFixed(2);
    document.getElementById('top-side-length').textContent = result.pixelLengths.topSide.toFixed(2);
    document.getElementById('bottom-side-length').textContent = result.pixelLengths.bottomSide.toFixed(2);
    document.getElementById('diagonal1-length').textContent = result.pixelLengths.diagonal1.toFixed(2);
    document.getElementById('diagonal2-length').textContent = result.pixelLengths.diagonal2.toFixed(2);

    resultsContainer.style.display = 'block';
}

// マーカー間距離入力のイベント処理
function setupMarkerDistanceInput() {
    const updateButton = document.getElementById('update-scale-factor');
    const inputField = document.getElementById('marker-distance-input');

    if (updateButton) {
        updateButton.addEventListener('click', () => {
            const distance = parseFloat(inputField.value);
            if (isNaN(distance) || distance <= 0) {
                if (typeof window.showError === 'function') {
                    window.showError('マーカー間距離は0より大きい数値を入力してください');
                }
                return;
            }

            // 4点の座標が揃っている場合のみ再計算
            if (window.calibrationData && window.calibrationData.points.length >= 4) {
                const validPoints = window.calibrationData.points.filter(p =>
                    p && p.digitizedCoords && p.digitizedCoords.cam1 &&
                    p.digitizedCoords.cam1.x != null && p.digitizedCoords.cam1.y != null
                );

                if (validPoints.length >= 4) {
                    const result = performFourPointRealLengthCalculation(window.calibrationData.points);
                    if (result && result.success) {
                        // プロジェクトデータに保存
                        if (window.projectData) {
                            window.projectData.fourPointCalibration = result;
                        }

                        // 結果表示を更新
                        if (typeof window.updateFourPointResultsDisplay === 'function') {
                            window.updateFourPointResultsDisplay(result);
                        }

                        if (typeof window.showMessage === 'function') {
                            window.showMessage(`キャリブレーション結果を更新しました（マーカー間距離: ${distance}m）`);
                        }
                    } else {
                        if (typeof window.showError === 'function') {
                            window.showError('スケールファクターの計算に失敗しました');
                        }
                    }
                } else {
                    if (typeof window.showError === 'function') {
                        window.showError('4点のデジタイズ座標を先に入力してください');
                    }
                }
            } else {
                if (typeof window.showError === 'function') {
                    window.showError('4点のデジタイズ座標を先に入力してください');
                }
            }
        });
    }

    if (inputField) {
        inputField.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                updateButton.click();
            }
        });
    }
}

// グローバル関数として公開
window.performFourPointRealLengthCalculation = performFourPointRealLengthCalculation;
window.updateFourPointResultsDisplay = updateFourPointResultsDisplay;
window.setupMarkerDistanceInput = setupMarkerDistanceInput;
window.runCameraCalibration = runCameraCalibration;

// ステレオ結合ユーティリティ
function reconstructXYFromUV(coeff, u, v) {
    const A = coeff.A, B = coeff.B, C = coeff.C, D = coeff.D, E = coeff.E, F = coeff.F, G = coeff.G, H = coeff.H;
    const a11 = A - G * u; const a12 = B - H * u; const b1 = u - C;
    const a21 = D - G * v; const a22 = E - H * v; const b2 = v - F;
    const det = a11 * a22 - a12 * a21;
    if (Math.abs(det) < 1e-9) return { x: NaN, y: NaN };
    const x = (b1 * a22 - a12 * b2) / det;
    const y = (-b1 * a21 + a11 * b2) / det;
    return { x, y };
}

function stitchStereo2DDLT({ coeffCam1, coeffCam2, frameRanges, blendMode, cam1Data, cam2Data, motionPoints }) {
    const s1 = frameRanges.s1, e1 = frameRanges.e1, s2 = frameRanges.s2, e2 = frameRanges.e2;
    const nFrames = Math.max(e1 || 0, e2 || 0);
    const overlapStart = Math.max(s1 || 1, s2 || 1);
    const overlapEnd = Math.min(e1 || 0, e2 || 0);
    const overlapLen = Math.max(0, (overlapEnd - overlapStart + 1));
    const result = {};
    for (let f = 1; f <= nFrames; f++) {
        const in1 = (f >= (s1 || Infinity) && f <= (e1 || -Infinity));
        const in2 = (f >= (s2 || Infinity) && f <= (e2 || -Infinity));
        const frameMap1 = cam1Data?.[f];
        const frameMap2 = cam2Data?.[f];
        for (const p of motionPoints) {
            const uv1 = in1 ? (frameMap1 ? (typeof frameMap1.get === 'function' ? frameMap1.get(p.id) : frameMap1[p.id]) : null) : null;
            const uv2 = in2 ? (frameMap2 ? (typeof frameMap2.get === 'function' ? frameMap2.get(p.id) : frameMap2[p.id]) : null) : null;
            const xy1 = uv1 ? reconstructXYFromUV(coeffCam1, uv1.x, uv1.y) : null;
            const xy2 = uv2 ? reconstructXYFromUV(coeffCam2, uv2.x, uv2.y) : null;
            let xy = null;
            if (xy1 && !xy2) xy = xy1; else if (!xy1 && xy2) xy = xy2; else if (xy1 && xy2) {
                if (blendMode === 'average' || overlapLen === 0) {
                    xy = { x: (xy1.x + xy2.x) / 2, y: (xy1.y + xy2.y) / 2 };
                } else {
                    const k = Math.max(0, Math.min(overlapLen - 1, f - overlapStart));
                    const w2 = overlapLen <= 1 ? 1 : k / (overlapLen - 1);
                    const w1 = 1 - w2;
                    xy = { x: w1 * xy1.x + w2 * xy2.x, y: w1 * xy1.y + w2 * xy2.y };
                }
            }
            if (!result[f]) result[f] = {};
            result[f][p.id] = xy;
        }
    }
    return result;
}

window.stitchStereo2DDLT = stitchStereo2DDLT;

// 現在選択中カメラの2D DLT係数を用いて、各Cal点の実空間誤差(x,y)[m]を再計算
function update2DErrorsForCurrentCamera() {
    try {
        const methodSelect = document.getElementById('calibration-method');
        const method = methodSelect ? methodSelect.value : '';
        if (method !== '2d-dlt-single' && method !== '2d-dlt-stereo') return;
        if (!window.calibrationData || !Array.isArray(window.calibrationData.points)) return;

        const coeffs2d = window.projectData && window.projectData.cameraCoefficients2D ? window.projectData.cameraCoefficients2D : null;
        if (!coeffs2d) return;

        // ステレオモードの場合は両カメラの係数を使用
        const isStereo = method === '2d-dlt-stereo';
        const cam = (typeof window.getCurrentCamera === 'function') ? window.getCurrentCamera() : 'cam1';

        window.calibrationData.points.forEach(p => {
            p.errors = p.errors || { x: null, y: null, z: null };

            if (isStereo) {
                // ステレオモード: 両カメラのデータで誤差計算
                const uvCam1 = p?.digitizedCoords?.cam1;
                const uvCam2 = p?.digitizedCoords?.cam2;
                const rc = p?.realCoords;

                // Cam1で計算
                if (uvCam1 && rc && uvCam1.x != null && uvCam1.y != null && rc.x != null && rc.y != null && coeffs2d.cam1) {
                    const xy1 = reconstructXYFromUV(coeffs2d.cam1, uvCam1.x, uvCam1.y);
                    if (!Number.isNaN(xy1.x) && !Number.isNaN(xy1.y)) {
                        // 現在選択中のカメラがcam1の場合はそのまま表示
                        if (cam === 'cam1') {
                            p.errors.x = xy1.x - rc.x;
                            p.errors.y = xy1.y - rc.y;
                        }
                    }
                }

                // Cam2で計算
                if (uvCam2 && rc && uvCam2.x != null && uvCam2.y != null && rc.x != null && rc.y != null && coeffs2d.cam2) {
                    const xy2 = reconstructXYFromUV(coeffs2d.cam2, uvCam2.x, uvCam2.y);
                    if (!Number.isNaN(xy2.x) && !Number.isNaN(xy2.y)) {
                        // 現在選択中のカメラがcam2の場合、または cam1で計算できなかった場合
                        if (cam === 'cam2' || (p.errors.x === null && p.errors.y === null)) {
                            p.errors.x = xy2.x - rc.x;
                            p.errors.y = xy2.y - rc.y;
                        }
                    }
                }

                // どちらかのカメラで計算できていれば表示（フォールバック）
                if (p.errors.x === null && p.errors.y === null) {
                    // 両方失敗した場合、どちらか利用可能な方で再試行
                    if (uvCam1 && rc && uvCam1.x != null && uvCam1.y != null && rc.x != null && rc.y != null && coeffs2d.cam1) {
                        const xy1 = reconstructXYFromUV(coeffs2d.cam1, uvCam1.x, uvCam1.y);
                        if (!Number.isNaN(xy1.x) && !Number.isNaN(xy1.y)) {
                            p.errors.x = xy1.x - rc.x;
                            p.errors.y = xy1.y - rc.y;
                        }
                    }
                    if (p.errors.x === null && uvCam2 && rc && uvCam2.x != null && uvCam2.y != null && rc.x != null && rc.y != null && coeffs2d.cam2) {
                        const xy2 = reconstructXYFromUV(coeffs2d.cam2, uvCam2.x, uvCam2.y);
                        if (!Number.isNaN(xy2.x) && !Number.isNaN(xy2.y)) {
                            p.errors.x = xy2.x - rc.x;
                            p.errors.y = xy2.y - rc.y;
                        }
                    }
                }
            } else {
                // シングルモード: 従来通り cam1 のみ
                const uv = p?.digitizedCoords?.cam1;
                const rc = p?.realCoords;
                const coeff = coeffs2d.cam1;
                if (uv && rc && uv.x != null && uv.y != null && rc.x != null && rc.y != null && coeff) {
                    const xy = reconstructXYFromUV(coeff, uv.x, uv.y);
                    if (!Number.isNaN(xy.x) && !Number.isNaN(xy.y)) {
                        p.errors.x = xy.x - rc.x;
                        p.errors.y = xy.y - rc.y;
                    }
                }
            }
        });

        if (typeof window.updateCalibrationDataTable === 'function') window.updateCalibrationDataTable();
    } catch (e) {
        console.error('[update2DErrorsForCurrentCamera] Error:', e);
    }
}
window.update2DErrorsForCurrentCamera = update2DErrorsForCurrentCamera;

// 旧app.js互換: データテーブルクリックイベント設定
function setupDataTableClickEvent() {
    const tableBody = document.getElementById('data-table-body');
    if (!tableBody) return;
    tableBody.addEventListener('click', (e) => {
        const cell = e.target.closest('td');
        if (!cell) return;
        // フレーム列はスキップ
        const colIndex = cell.cellIndex;
        if (colIndex === 0) return;
        // 選択ハイライト更新
        if (typeof window.updateTableHighlights === 'function') {
            window.updateTableHighlights();
        }
    });
}

window.setupDataTableClickEvent = setupDataTableClickEvent;

// 旧app.js互換: UI更新ダミー（存在チェックし必要な表示だけ更新）
function updateUI() {
    if (typeof window.updateFrameInfo === 'function') {
        window.updateFrameInfo();
    }
    if (typeof window.updateFileSelectionUI === 'function') {
        window.updateFileSelectionUI();
    }

    // currentModeに基づいてランドマークセレクタの表示状態を更新
    const mode = window.currentMode;
    const calSelector = document.getElementById('calibration-landmark-selector');
    const motionSelector = document.getElementById('motion-landmark-selector');

    if (mode === 'calibration') {
        if (calSelector) calSelector.style.display = 'flex';
        if (motionSelector) motionSelector.style.display = 'none';
        if (typeof initializeCalibrationLandmarkSelector === 'function') {
            initializeCalibrationLandmarkSelector();
        }
        // ポイント名表示チェックボックスの制御
        const showPointNamesCheckbox = document.getElementById('show-point-names');
        if (showPointNamesCheckbox) showPointNamesCheckbox.checked = true;

    } else if (mode === 'motion') {
        if (calSelector) calSelector.style.display = 'none';
        if (motionSelector) motionSelector.style.display = 'flex';
        if (typeof initializeMotionLandmarkSelector === 'function') {
            initializeMotionLandmarkSelector();
        }
        // ポイント名表示チェックボックスの制御
        const showPointNamesCheckbox = document.getElementById('show-point-names');
        if (showPointNamesCheckbox) showPointNamesCheckbox.checked = false;

    } else {
        // 未選択時はキャリブレーションセレクタは隠すが、
        // レイアウト維持のためモーションセレクタは表示しておく（index.htmlの初期状態に合わせる）
        if (calSelector) calSelector.style.display = 'none';
        if (motionSelector) {
            motionSelector.style.display = 'flex';
            // セレクタの中身は初期化しておく
            if (typeof initializeMotionLandmarkSelector === 'function') {
                initializeMotionLandmarkSelector();
            }
        }

        // ポイント名表示チェックボックスは、とりあえずOFF（モーション相当）にしておく
        const showPointNamesCheckbox = document.getElementById('show-point-names');
        if (showPointNamesCheckbox) showPointNamesCheckbox.checked = false;
    }
}

window.updateUI = updateUI;

// 旧app.js互換: 必要カメラ数の表示・UI切替
const cameraRequirements = {
    '2d-dlt-single': { cameras: 1, description: 'カメラ1のみで解析可能' },
    '2d-dlt-stereo': { cameras: 2, description: 'カメラ1、カメラ2の両方が必要' },
    '4-point': { cameras: 1, description: 'カメラ1のみで解析可能' },
    '3d-dlt': { cameras: 2, description: 'カメラ1、カメラ2の両方が必要' },
    '3d-cc-method': { cameras: 2, description: 'カメラ1、カメラ2の両方が必要' },
    'checkerboard': { cameras: 2, description: 'カメラ1、カメラ2の両方が必要' },
    'vicon-xcp-triangulation': { cameras: 2, description: 'Vicon XCP + 2カメラのデジタイズで三角測量' },
    'charuco-single': { cameras: 1, description: 'カメラ1のみで解析可能' },
    'charuco-stereo': { cameras: 2, description: 'カメラ1、カメラ2の両方が必要' }
};

function updateCameraRequirementUI() {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '2d-dlt-single';
    const requirementText = document.getElementById('requirement-text');
    const camera2Radio = document.getElementById('camera2');
    const calCam2Element = document.getElementById('cal-cam2');
    const motionCam2Element = document.getElementById('motion-cam2');

    if (!method) {
        if (requirementText) requirementText.textContent = 'キャリブレーション方法を選択してください';
        // カメラ2は無効化 (安全のため)
        if (camera2Radio) camera2Radio.disabled = true;
        if (calCam2Element) calCam2Element.style.display = 'none';
        if (motionCam2Element) motionCam2Element.style.display = 'none';
        return;
    }

    if (requirementText && cameraRequirements[method]) {
        requirementText.textContent = cameraRequirements[method].description;
    }

    if (cameraRequirements[method]) {
        if (cameraRequirements[method].cameras === 1) {
            if (camera2Radio) {
                camera2Radio.disabled = true;
                if (camera2Radio.checked) {
                    const camera1Radio = document.getElementById('camera1');
                    if (camera1Radio) camera1Radio.checked = true;
                }
            }
            if (calCam2Element) calCam2Element.style.display = 'none';
            if (motionCam2Element) motionCam2Element.style.display = 'none';
        } else {
            if (camera2Radio) camera2Radio.disabled = false;
            // 表示制御は updateFileSelectionVisibility に任せるためここでは強制表示しない
            // if (calCam2Element) calCam2Element.style.display = 'block';
            // if (motionCam2Element) motionCam2Element.style.display = 'block';
        }
    }

    // カメラ選択に応じてファイル選択UIを更新
    updateFileSelectionVisibility();

    // 2D DLT ステレオの場合はフレーム範囲を自動入力
    if (method === '2d-dlt-stereo' && typeof window.autoPopulateStereoFrameRanges === 'function') {
        window.autoPopulateStereoFrameRanges();
    }
}

// カメラ選択に応じてファイル選択UIの表示を制御
function updateFileSelectionVisibility() {
    const currentCamera = getCurrentCamera();
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '2d-dlt-single';
    const calCam1Element = document.getElementById('cal-cam1');
    const calCam2Element = document.getElementById('cal-cam2');
    const motionCam1Element = document.getElementById('motion-cam1');
    const motionCam2Element = document.getElementById('motion-cam2');

    // キャリブレーション方法に応じて表示制御
    const requiresStereo = (cameraRequirements[method] && cameraRequirements[method].cameras === 2);
    // charuco-stereoモードの場合は常に両方のカメラを表示
    const isCharucoStereo = (method === 'charuco-stereo');
    if (requiresStereo || isCharucoStereo) {
        // ステレオモード: カメラ1とカメラ2の両方を常に表示
        if (calCam1Element) calCam1Element.style.display = 'block';
        if (calCam2Element) calCam2Element.style.display = 'block';
        if (motionCam1Element) motionCam1Element.style.display = 'block';
        if (motionCam2Element) motionCam2Element.style.display = 'block';
    } else if (method === '4-point' || method === 'charuco-single' || method === '2d-dlt-single') {
        // シングルモード（4点実長換算、ChArUcoシングル、2次元DLT法シングル）: カメラ1のみを表示
        if (calCam1Element) calCam1Element.style.display = 'block';
        if (calCam2Element) calCam2Element.style.display = 'none';
        if (motionCam1Element) motionCam1Element.style.display = 'block';
        if (motionCam2Element) motionCam2Element.style.display = 'none';
    } else {
        // シングルモード: カメラ選択に応じて表示
        if (currentCamera === 'cam1') {
            if (calCam1Element) calCam1Element.style.display = 'block';
            if (calCam2Element) calCam2Element.style.display = 'none';
            if (motionCam1Element) motionCam1Element.style.display = 'block';
            if (motionCam2Element) motionCam2Element.style.display = 'none';
        } else if (currentCamera === 'cam2') {
            if (calCam1Element) calCam1Element.style.display = 'block';
            if (calCam2Element) calCam2Element.style.display = 'block';
            if (motionCam1Element) motionCam1Element.style.display = 'block';
            if (motionCam2Element) motionCam2Element.style.display = 'block';
        }
    }

    // カメラドットインジケータを更新
    if (typeof window.updateCamDots === 'function') window.updateCamDots();
}

/**
 * ファイル選択UIの強制更新（共通化関数）
 * 4点実長換算モードなど、特殊な場合に使用
 */
function forceUpdateFileSelectionUI() {
    try {
        // まず通常の表示制御を実行
        if (typeof updateFileSelectionVisibility === 'function') {
            updateFileSelectionVisibility();
        }

        // 次にファイル情報の更新を実行
        if (typeof updateFileSelectionUI === 'function') {
            updateFileSelectionUI();
        }

        // 4点実長換算モードの場合、追加の強制更新
        const methodSelect = document.getElementById('calibration-method');
        if (methodSelect && methodSelect.value === '4-point') {
            const calCam1Element = document.getElementById('cal-cam1');
            const motionCam1Element = document.getElementById('motion-cam1');

            // キャリブレーション動画の強制表示
            if (calCam1Element) {
                calCam1Element.style.display = 'block';
                const fileData = window.fileState && window.fileState['cal-cam1'];
                if (fileData) {
                    const fileNameSpan = calCam1Element.querySelector('.file-name');
                    const filePathSpan = calCam1Element.querySelector('.file-path');
                    if (fileNameSpan) fileNameSpan.textContent = fileData.name || 'ファイル選択済み';
                    if (filePathSpan) filePathSpan.textContent = fileData.path || '';
                }
            }

            // モーション動画の強制表示
            if (motionCam1Element) {
                motionCam1Element.style.display = 'block';
                const motionFileData = window.fileState && window.fileState['motion-cam1'];
                if (motionFileData) {
                    const motionFileNameSpan = motionCam1Element.querySelector('.file-name');
                    const motionFilePathSpan = motionCam1Element.querySelector('.file-path');
                    if (motionFileNameSpan) motionFileNameSpan.textContent = motionFileData.name || 'ファイル選択済み';
                    if (motionFilePathSpan) motionFilePathSpan.textContent = motionFileData.path || '';
                }
            }
        }
    } catch (error) {
        console.error('ファイル選択UI強制更新エラー:', error);
    }
}

window.updateCameraRequirementUI = updateCameraRequirementUI;
window.updateFileSelectionVisibility = updateFileSelectionVisibility;
window.forceUpdateFileSelectionUI = forceUpdateFileSelectionUI;

// setupAllFileButtons関数は削除（HTMLのonclick属性を使用）

// 旧app.js互換: analyzeVideos と showCalibration のダミー実装
async function analyzeVideos() {
    if (!window.projectData || !window.projectData.settings || !window.projectData.settings.videoFile) {
        if (typeof window.showError === 'function') window.showError('動画ファイルを読み込んでください');
        return;
    }
    if (typeof window.showMessage === 'function') window.showMessage('解析を開始しました');
}

function showCalibration() {
    if (typeof window.showMessage === 'function') window.showMessage('キャリブレーション機能は開発中です');
}

window.analyzeVideos = analyzeVideos;
window.showCalibration = showCalibration;

// 旧app.js互換: 実長換算開始（分析タブへ誘導して計算関数を起動）
function calculateRealLength() {
    if (typeof window.switchTab === 'function') {
        window.switchTab('analysis');
    }
    setTimeout(() => {
        if (typeof window.calculateRealLengthData === 'function') {
            window.calculateRealLengthData();
        } else if (window && window.__DEBUG__) {
        }
    }, 200);
}

// 旧app.js互換: 標準誤差計算（プレースホルダ）
function calculateError() {
    if (typeof window.showMessage === 'function') window.showMessage('誤差計算機能は開発中です');
}

window.calculateRealLength = calculateRealLength;
window.calculateError = calculateError;

// 旧app.js互換: Excelエクスポート（プレースホルダ）
function exportExcel() {
    if (typeof window.showMessage === 'function') window.showMessage('Excelエクスポート機能は開発中です');
}

// 実長換算の前提条件チェック（診断用）
function checkRealLengthPrerequisites(method) {
    const issues = [];

    // モーションポイントのチェック
    const points = Array.isArray(window.motionPoints) ? window.motionPoints : [];
    if (points.length === 0) {
        issues.push('モーションポイントが設定されていません（ポイント設定タブで設定してください）');
    }

    // デジタイズデータのチェック
    const cam1Data = window.cameraDigitizeData?.cam1 || {};
    const cam2Data = window.cameraDigitizeData?.cam2 || {};
    const cam1Frames = Object.keys(cam1Data).length;
    const cam2Frames = Object.keys(cam2Data).length;

    // 3D系のメソッドは両カメラのデータが必要
    const is3DMethod = ['3d-dlt', '3d-cc-method', 'charuco-stereo'].includes(method);

    if (is3DMethod) {
        if (cam1Frames === 0 && cam2Frames === 0) {
            issues.push('デジタイズデータがありません（モーションタブでデジタイズを行ってください）');
        } else if (cam1Frames === 0) {
            issues.push('カメラ1のデジタイズデータがありません');
        } else if (cam2Frames === 0) {
            issues.push('カメラ2のデジタイズデータがありません');
        }

        // 共通フレームチェック
        const frames1 = Object.keys(cam1Data).map(Number);
        const frames2 = Object.keys(cam2Data).map(Number);
        const commonFrames = frames1.filter(f => frames2.includes(f));
        if (cam1Frames > 0 && cam2Frames > 0 && commonFrames.length === 0) {
            issues.push('カメラ1とカメラ2で共通のフレームがありません（両カメラで同じフレームをデジタイズしてください）');
        }
    } else {
        // 2D系は片方でもOK
        if (cam1Frames === 0 && cam2Frames === 0) {
            issues.push('デジタイズデータがありません（モーションタブでデジタイズを行ってください）');
        }
    }

    // カメラ定数のチェック（メソッドに応じて）
    if (method === '3d-dlt') {
        const coeffs3d = window.projectData?.cameraCoefficients3D;
        if (!coeffs3d || !coeffs3d.cam1 || !coeffs3d.cam2) {
            issues.push('3次元DLTカメラ定数が未算出です（キャリブレーションタブで「カメラ定数」ボタンを押してください）');
        }
    } else if (method === '3d-cc-method') {
        const ccCalib = window.projectData?.ccCalibration || window.projectData?.dltCalibration;
        const dltParams = ccCalib?.stereoDLTParams || ccCalib?.params;
        if (!dltParams || !dltParams[0] || !dltParams[1]) {
            issues.push('CC法パラメータが未算出です（キャリブレーションタブで「カメラ定数」ボタンを押してCC法キャリブレーションを実行してください）');
        }
    } else if (method === '2d-dlt-stereo') {
        const coeffs2d = window.projectData?.cameraCoefficients2D;
        const coeffCam1 = coeffs2d?.cam1 || window.projectData?.cameraCoefficients?.cam1;
        const coeffCam2 = coeffs2d?.cam2 || window.projectData?.cameraCoefficients?.cam2;
        if (!coeffCam1 || !coeffCam2) {
            issues.push('2次元DLT（ステレオ）カメラ定数が未算出です（キャリブレーションタブで「カメラ定数」ボタンを押してください）');
        }
    } else if (method === '2d-dlt') {
        const cam = typeof window.getCurrentCamera === 'function' ? window.getCurrentCamera() : 'cam1';
        let coeffs = window.projectData?.dltCoefficients || window.projectData?.cameraCoefficients?.[cam];
        if (!coeffs) {
            issues.push('2次元DLTカメラ定数が未算出です（キャリブレーションタブで「カメラ定数」ボタンを押してください）');
        }
    } else if (method === 'charuco-single') {
        const calib = window.projectData?.calibration;
        if (!calib || !calib.cameraMatrix) {
            issues.push('ChArUcoキャリブレーションが未実行です');
        }
    } else if (method === 'charuco-stereo') {
        const stereoCalib = window.projectData?.stereoCalibration;
        if (!stereoCalib || !stereoCalib.R || !stereoCalib.T) {
            issues.push('ステレオChArUcoキャリブレーションが未実行です');
        }
    } else if (method === '4-point') {
        const calibrationPoints = window.calibrationData?.points || [];
        if (calibrationPoints.length < 4) {
            issues.push('4点実長換算用のキャリブレーションポイントが不足しています（最低4点必要）');
        }
    }

    return issues;
}

function clearRealLengthMessage() {
    const msgEl = document.getElementById('real-length-message');
    if (msgEl) {
        msgEl.style.display = 'none';
        msgEl.textContent = '';
    }
}

// 2次元DLT法による実長換算の本実装
function calculateRealLengthData() {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '2d-dlt';
    console.log('[RL] calculateRealLengthData called. Method:', method);

    // メッセージクリア
    clearRealLengthMessage();

    // 前提条件チェック
    const issues = checkRealLengthPrerequisites(method);
    if (issues.length > 0) {
        const methodNames = {
            '2d-dlt': '2次元DLT',
            '3d-dlt': '3次元DLT',
            '3d-cc-method': '3次元CC法',
            '2d-dlt-stereo': '2次元DLTステレオ',
            'charuco-single': 'ChArUcoシングル',
            'charuco-stereo': 'ChArUcoステレオ',
            '4-point': '4点実長換算'
        };
        const methodName = methodNames[method] || method;
        const errorMsg = `【${methodName}】実長換算に失敗しました\n\n` +
            `原因:\n${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}\n\n` +
            `対処法:\n上記の問題を解決してから再度「実長換算実行」を押してください。`;
        showError(errorMsg);
        return;
    }

    // 4点実長換算: カメラ定数不要で直接実長換算
    if (method === '4-point') {

        // キャリブレーションデータから4点の座標を取得
        const calibrationPoints = window.calibrationData && window.calibrationData.points ? window.calibrationData.points : [];
        if (calibrationPoints.length === 0) {
            if (typeof window.showError === 'function') window.showError('4点実長換算用のキャリブレーションポイントが設定されていません');
            return;
        }

        // 4点実長換算の計算を実行
        const result = performFourPointRealLengthCalculation(calibrationPoints);
        if (result.success) {
            // 結果を表示
            updateFourPointResultsDisplay(result);

            // 4点実長換算の結果をプロジェクトデータに保存
            if (!window.projectData) window.projectData = {};
            window.projectData.fourPointCalibration = result;

            // モーションデータの実長換算を実行
            const motionResults = performFourPointMotionRealLengthCalculation(result);
            if (motionResults.success) {
                // 実長換算データを保存
                window.realLengthData = motionResults.data;

                // 統計情報を更新
                updateRealLengthStatistics(motionResults.data);

                // テーブルを表示
                if (typeof displayRealLengthTable === 'function') {
                    displayRealLengthTable(motionResults.data);
                }

                if (typeof window.showMessage === 'function') window.showMessage('4点実長換算が完了しました（モーションデータ: ' + motionResults.data.length + '件）');
            } else {
                if (typeof window.showError === 'function') window.showError('モーションデータの実長換算に失敗しました: ' + motionResults.error);
            }
        } else {
            if (typeof window.showError === 'function') window.showError('4点実長換算に失敗しました: ' + result.error);
        }
        return;
    }

    // ChArUcoシングル: 選択したボードの外部パラメータを使って2次元実長座標に変換
    if (method === 'charuco-single') {

        // ボード選択の確認（分析タブのUIを優先、なければキャリブレーションタブのUIを使用）
        let boardSelect = document.getElementById('analysis-board-select');
        let boardIndex = boardSelect ? parseInt(boardSelect.value || '-1', 10) : -1;

        // 分析タブのUIで選択されていない場合は、キャリブレーションタブのUIを確認
        if (boardIndex < 0) {
            boardSelect = document.getElementById('charuco-board-select');
            const boardSelectContainer = document.getElementById('charuco-single-board-select');

            // ボード選択UIが表示されているか確認
            if (!boardSelectContainer || boardSelectContainer.style.display === 'none') {
                if (typeof window.showError === 'function') {
                    window.showError('ChArUcoシングルモードで実長換算を行うには、まず「分析」タブの「外部パラメーター設定」セクションでボードを選択してください。\n\n手順:\n1. 「分析」タブを開く\n2. 「外部パラメーター設定」セクションの「動作平面上に置いたキャリブレーションパターンを選択してください」ドロップダウンからボードを選択\n3. 「実長換算実行」ボタンを押す');
                }
                return;
            }

            boardIndex = boardSelect ? parseInt(boardSelect.value || '-1', 10) : -1;
        }

        if (boardIndex < 0) {
            // キャリブレーション結果の確認
            const calib = window.projectData && window.projectData.calibration ? window.projectData.calibration : null;
            if (!calib || !calib.rvecs || calib.rvecs.length === 0) {
                if (typeof window.showError === 'function') {
                    window.showError('ChArUcoキャリブレーションが完了していません。\n\n手順:\n1. 「キャリブレーション」モードでChArUcoキャリブレーションを実行\n2. 動作範囲でボードを複数の位置・角度で撮影してサンプルを追加（20フレーム以上推奨）\n3. 「キャリブレーション実行」ボタンでキャリブレーションを完了\n4. 「分析」タブでボードを選択して実長換算を実行');
                }
            } else {
                if (typeof window.showError === 'function') {
                    window.showError('動作範囲でキャリブレーションしたボードを選択してください。\n\n手順:\n1. 「分析」タブの「実長換算データ」セクションを確認\n2. 「動作範囲でキャリブレーションしたボードを選択してください」ドロップダウンから、動作範囲で撮影したボードを選択（例: ボード #1, ボード #2 など）\n3. 「実長換算実行」ボタンを押す');
                }
            }
            return;
        }

        // キャリブレーション結果の確認
        const calib = window.projectData && window.projectData.calibration ? window.projectData.calibration : null;
        if (!calib || !calib.cameraMatrix || !calib.distCoeffs) {
            if (typeof window.showError === 'function') window.showError('ChArUcoキャリブレーション結果がありません。先にキャリブレーションを実行してください');
            return;
        }

        if (!calib.rvecs || !calib.tvecs || boardIndex >= calib.rvecs.length) {
            if (typeof window.showError === 'function') window.showError('選択したボードの外部パラメータがありません');
            return;
        }

        const rvec = calib.rvecs[boardIndex];
        const tvec = calib.tvecs[boardIndex];

        // モーションデータの確認
        const cam = typeof window.getCurrentCamera === 'function' ? window.getCurrentCamera() : 'cam1';
        const camData = window.cameraDigitizeData && window.cameraDigitizeData[cam] ? window.cameraDigitizeData[cam] : {};
        const frames = Object.keys(camData).map(n => Number(n)).filter(n => !isNaN(n)).sort((a, b) => a - b);

        if (frames.length === 0) {
            if (typeof window.showError === 'function') window.showError('モーションデータがありません');
            return;
        }

        const points = Array.isArray(window.motionPoints) ? window.motionPoints : [];
        if (points.length === 0) {
            if (typeof window.showError === 'function') window.showError('モーションポイントが設定されていません');
            return;
        }

        // 画像座標から実長座標への変換（カメラモデルベース射影を使用）
        const results = [];

        // カメラモデルベース射影関数の確認
        if (typeof window.imageToWorldCoordinateWithoutDistortion !== 'function') {
            if (typeof window.showError === 'function') {
                window.showError('カメラモデルベース射影モジュールが読み込まれていません。ページを再読み込みしてください。');
            }
            return;
        }

        // 歪み補正なしで実長換算を実行（歪み補正機能は不要と判断）
        for (const frame of frames) {
            const map = camData[frame];
            if (!map || typeof map.forEach !== 'function') continue;

            // このフレームのポイントを収集
            points.forEach(p => {
                const pix = map.get ? map.get(p.id) : map[p.id];
                if (pix && typeof pix.x === 'number' && typeof pix.y === 'number') {
                    // 歪み補正なしで変換（歪み補正機能は不要と判断）
                    const worldCoord = window.imageToWorldCoordinateWithoutDistortion(
                        { x: pix.x, y: pix.y },
                        calib.cameraMatrix,
                        rvec,
                        tvec,
                        0  // Z=0平面（ChArUcoボード面）
                    );

                    if (worldCoord) {
                        results.push({
                            frame: frame,
                            pointId: p.id,
                            x: worldCoord.x,
                            y: worldCoord.y
                        });
                    }
                }
            });
        }

        if (results.length === 0) {
            if (typeof window.showError === 'function') window.showError('実長換算に成功したポイントがありません');
            // テーブルをクリア
            const tableBody = document.getElementById('real-length-table-body');
            const tableHead = document.getElementById('real-length-table-head');
            if (tableBody) tableBody.innerHTML = '';
            if (tableHead) tableHead.innerHTML = '';
            // realLengthDataもクリア
            window.realLengthData = [];
            return;
        }

        // 誤差計算（ChArUco単眼の再投影誤差: world(Z=0)→pixel）
        //
        // 再投影フロー:
        //   R = Rodrigues(rvec), 3x3
        //   X_cam = R · [x, y, 0]^T + tvec
        //   u = fx * X_cam.x / X_cam.z + cx
        //   v = fy * X_cam.y / X_cam.z + cy
        let totalSqError = 0;
        let errorCount = 0;
        let maxReprojError = 0;

        // Rodrigues 変換 (rvec → 3x3 回転行列, 行優先の 9 要素配列)
        const rodrigues = (rv) => {
            const rx = rv[0], ry = rv[1], rz = rv[2];
            const theta = Math.sqrt(rx * rx + ry * ry + rz * rz);
            if (theta < 1e-12) {
                return [1, 0, 0, 0, 1, 0, 0, 0, 1];
            }
            const kx = rx / theta, ky = ry / theta, kz = rz / theta;
            const c = Math.cos(theta);
            const s = Math.sin(theta);
            const C = 1 - c;
            return [
                c + kx * kx * C,        kx * ky * C - kz * s,   kx * kz * C + ky * s,
                ky * kx * C + kz * s,   c + ky * ky * C,        ky * kz * C - kx * s,
                kz * kx * C - ky * s,   kz * ky * C + kx * s,   c + kz * kz * C,
            ];
        };

        // cameraMatrix は 3x3 行列（2次元配列 or 9要素配列）想定
        const K = calib.cameraMatrix;
        const fx = Array.isArray(K[0]) ? K[0][0] : K[0];
        const fy = Array.isArray(K[1]) ? K[1][1] : K[4];
        const cx = Array.isArray(K[0]) ? K[0][2] : K[2];
        const cy = Array.isArray(K[1]) ? K[1][2] : K[5];
        const R = rodrigues(rvec);
        const tx = tvec[0], ty = tvec[1], tz = tvec[2];

        results.forEach(r => {
            const map = camData[r.frame];
            if (!map) return;
            const pix = map.get ? map.get(r.pointId) : map[r.pointId];
            if (!pix || typeof pix.x !== 'number') return;

            // Z=0 平面上の点を再投影 (z は常に 0)
            const X = R[0] * r.x + R[1] * r.y + tx;
            const Y = R[3] * r.x + R[4] * r.y + ty;
            const Z = R[6] * r.x + R[7] * r.y + tz;
            if (Math.abs(Z) < 1e-9) return;
            const u = fx * X / Z + cx;
            const v = fy * Y / Z + cy;

            const du = u - pix.x;
            const dv = v - pix.y;
            const d  = du * du + dv * dv;
            totalSqError += d;
            errorCount += 1;
            maxReprojError = Math.max(maxReprojError, Math.sqrt(d));
        });

        const rmsError = errorCount > 0 ? Math.sqrt(totalSqError / errorCount) : 0;

        // 180度回転: (x, y) → (-x, -y)
        const rotatedResults = results.map(r => ({
            frame: r.frame,
            pointId: r.pointId,
            x: -r.x,
            y: -r.y
        }));

        // y座標の最小値を0にする: すべてのy座標からmin(y)を引く
        const minY = Math.min(...rotatedResults.map(r => r.y));
        const finalResults = rotatedResults.map(r => ({
            frame: r.frame,
            pointId: r.pointId,
            x: r.x,
            y: r.y - minY
        }));

        // window.realLengthDataを確実に設定
        window.realLengthData = finalResults;
        try {
        } catch (_) { }

        // 統計情報を更新
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
        const uniqueFrames = new Set(finalResults.map(r => r.frame)).size;
        const motionPoints = Array.isArray(window.motionPoints) ? window.motionPoints : [];
        setText('total-frames', uniqueFrames || 0);
        setText('total-points', motionPoints.length || 0);

        // 単位の書き換え ('m' -> 'px') と誤差表示
        const updateUnit = (id, val, unit) => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = val.toFixed(4);
                if (el.nextSibling && el.nextSibling.nodeType === 3) {
                    el.nextSibling.textContent = ' ' + unit; // テキストノードを書き換え
                }
            }
        };
        updateUnit('average-error', rmsError, 'px');
        updateUnit('max-error', maxReprojError, 'px');

        // テーブルに表示（実長換算が成功した場合のみ）
        if (typeof displayRealLengthTable === 'function') {
            displayRealLengthTable(finalResults);
            // テーブル表示後にも再度確認
            try {
            } catch (_) { }
        }

        if (typeof window.showMessage === 'function') {
            window.showMessage(`ChArUcoシングルによる実長換算を完了しました（${uniqueFrames}フレーム、${finalResults.length}ポイント）`);
        }

        return;
    }

    // ステレオChArUco: ステレオキャリブレーション結果とモーションデータから3次元復元
    if (method === 'charuco-stereo') {
        if (window && window.__DEBUG__) console.debug('[RL][charuco-stereo] starting stereo triangulation');

        // ステレオキャリブレーション結果の確認
        const stereoCalib = window.projectData && window.projectData.stereoCalibration ? window.projectData.stereoCalibration : null;
        const stereoIntrinsics = window.projectData && window.projectData.stereoIntrinsics ? window.projectData.stereoIntrinsics : null;

        if (!stereoCalib || !stereoCalib.R || !stereoCalib.T) {
            if (typeof window.showError === 'function') window.showError('ステレオキャリブレーション結果がありません。先にステレオキャリブレーションを実行してください');
            return;
        }

        if (!stereoIntrinsics || !stereoIntrinsics.cam1 || !stereoIntrinsics.cam2) {
            if (typeof window.showError === 'function') window.showError('ステレオ内部パラメータ（Cam1/Cam2）が設定されていません');
            return;
        }

        // モーションデータの確認
        const cam1Data = window.cameraDigitizeData && window.cameraDigitizeData.cam1 ? window.cameraDigitizeData.cam1 : {};
        const cam2Data = window.cameraDigitizeData && window.cameraDigitizeData.cam2 ? window.cameraDigitizeData.cam2 : {};

        const frames1 = Object.keys(cam1Data).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        const frames2 = Object.keys(cam2Data).map(Number).filter(Number.isFinite).sort((a, b) => a - b);

        // 両カメラで共通のフレームを取得
        const frameSet = new Set(frames1.filter(f => frames2.includes(f)));
        const commonFrames = Array.from(frameSet).sort((a, b) => a - b);

        if (commonFrames.length === 0) {
            if (typeof window.showError === 'function') window.showError('Cam1とCam2の両方にデジタイズデータがあるフレームがありません');
            return;
        }

        const points = Array.isArray(window.motionPoints) ? window.motionPoints : [];
        if (points.length === 0) {
            if (typeof window.showError === 'function') window.showError('モーションポイントが設定されていません');
            return;
        }

        // 各フレーム・各ポイントについて3次元復元を実行（非同期処理）
        (async () => {
            const results = [];
            let totalProcessed = 0;
            let totalSuccess = 0;

            for (const frame of commonFrames) {
                const map1 = cam1Data[frame];
                const map2 = cam2Data[frame];

                if (!map1 || !map2 || typeof map1.forEach !== 'function' || typeof map2.forEach !== 'function') {
                    continue;
                }

                // このフレームのポイントペアを収集
                const pointPairs = [];
                points.forEach(p => {
                    const pix1 = map1.get ? map1.get(p.id) : map1[p.id];
                    const pix2 = map2.get ? map2.get(p.id) : map2[p.id];

                    if (pix1 && pix2 &&
                        typeof pix1.x === 'number' && typeof pix1.y === 'number' &&
                        typeof pix2.x === 'number' && typeof pix2.y === 'number') {
                        pointPairs.push({
                            cam1: { x: pix1.x, y: pix1.y },
                            cam2: { x: pix2.x, y: pix2.y },
                            pointId: p.id
                        });
                    }
                });

                if (pointPairs.length === 0) {
                    continue;
                }

                // 3次元復元を実行
                try {
                    if (typeof window.charucoStereoTriangulate === 'function') {
                        const triResult = await window.charucoStereoTriangulate(pointPairs);

                        if (triResult && triResult.success && Array.isArray(triResult.points3D)) {
                            // 復元結果をresultsに追加（右手座標系に変換）
                            triResult.points3D.forEach((p3d, idx) => {
                                if (idx < pointPairs.length) {
                                    results.push({
                                        frame: frame,
                                        pointId: pointPairs[idx].pointId,
                                        x: p3d.x,
                                        y: p3d.z,  // y軸とz軸を入れ替え
                                        z: -p3d.y  // z軸を反転して右手座標系にする
                                    });
                                    totalSuccess++;
                                }
                            });
                        }
                    }
                    totalProcessed += pointPairs.length;
                } catch (error) {
                    console.error(`[RL][charuco-stereo] Frame ${frame} triangulation error:`, error);
                }
            }

            if (results.length === 0) {
                if (typeof window.showError === 'function') window.showError('3次元復元に成功したポイントがありません');
                return;
            }

            // z座標の最小値を求めて、床面(z=0)に合わせる
            const minZ = Math.min(...results.map(r => r.z));
            results.forEach(r => {
                r.z = r.z - minZ;  // 最小値を引いてz=0を床面にする
            });

            // 結果を保存
            window.realLengthData = results;

            // 統計情報を更新
            const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
            const uniqueFrames = new Set(results.map(r => r.frame)).size;
            const motionPoints = Array.isArray(window.motionPoints) ? window.motionPoints : [];
            setText('total-frames', uniqueFrames || 0);
            setText('total-points', motionPoints.length || 0);
            setText('average-error', '0.00 m'); // 誤差計算は別途実装が必要
            setText('max-error', '0.00 m');

            // テーブルに表示
            if (typeof displayRealLengthTable === 'function') {
                displayRealLengthTable(results);
            }

            if (typeof window.showMessage === 'function') {
                window.showMessage(`ステレオChArUcoによる3次元復元を完了しました（${uniqueFrames}フレーム、${results.length}ポイント）`);
            }
        })();

        return;
    }

    // 3D CC法: CC法で算出されたDLTパラメータを使用して3D再構成
    if (method === '3d-cc-method') {
        const ccCalib = window.projectData && window.projectData.ccCalibration ? window.projectData.ccCalibration : (window.projectData && window.projectData.dltCalibration);

        let dltParams = null;
        if (ccCalib) {
            // ccCalibrationなら stereoDLTParams, dltCalibrationなら params
            dltParams = ccCalib.stereoDLTParams || ccCalib.params;
        }

        if (!dltParams || !dltParams[0] || !dltParams[1]) {
            if (typeof window.showError === 'function') window.showError('CC法のパラメータが見つかりません。先に「CC法キャリブレーション実行」を行ってください');
            return;
        }

        // 配列からオブジェクト{L1...L11}へ変換するヘルパー
        const toLObj = (arr) => {
            if (!Array.isArray(arr) || arr.length < 11) return null;
            const obj = {};
            for (let i = 0; i < 11; i++) obj[`L${i + 1}`] = arr[i];
            return obj;
        };

        const C1 = toLObj(dltParams[0]);
        const C2 = toLObj(dltParams[1]);

        console.log('[RL] 3D CC Params:', C1, C2);

        // Z方向の係数が小さすぎる場合（平面的なキャリブレーションの可能性）への警告
        if (Math.abs(C1.L3) < 1e-5 && Math.abs(C1.L7) < 1e-5 && Math.abs(C1.L11) < 1e-5) {
            const msg = '【警告】カメラ1のZ方向係数が極端に小さいです。キャリブレーションポイントが同一平面上（全てZ=0など）にある可能性があります。正確な3次元計測には高さ（Z方向）のある点が必要です。';
            console.warn(msg);
            if (typeof window.showError === 'function') window.showError(msg);
        }

        if (!C1 || !C2 || !window.AnalysisEngine || typeof window.AnalysisEngine.reconstruct3DPointFromPixels !== 'function') {
            if (typeof window.showError === 'function') window.showError('実長換算エンジンが準備できていません');
            return;
        }

        const cam1Data = window.cameraDigitizeData && window.cameraDigitizeData.cam1 ? window.cameraDigitizeData.cam1 : {};
        const cam2Data = window.cameraDigitizeData && window.cameraDigitizeData.cam2 ? window.cameraDigitizeData.cam2 : {};
        const frames1 = Object.keys(cam1Data).map(Number);
        const frames2 = Object.keys(cam2Data).map(Number);
        // 共通フレームのみ抽出
        const frameSet = new Set(frames1.filter(f => frames2.includes(f)));
        const frames = Array.from(frameSet).sort((a, b) => a - b);

        const points = Array.isArray(window.motionPoints) ? window.motionPoints : [];
        const results = [];

        frames.forEach(frame => {
            const map1 = cam1Data[frame];
            const map2 = cam2Data[frame];
            if (!map1 || !map2) return;

            points.forEach(p => {
                const pix1 = map1.get ? map1.get(p.id) : map1[p.id];
                const pix2 = map2.get ? map2.get(p.id) : map2[p.id];
                if (pix1 && pix2 &&
                    typeof pix1.x === 'number' && typeof pix1.y === 'number' &&
                    typeof pix2.x === 'number' && typeof pix2.y === 'number') {

                    const real3 = window.AnalysisEngine.reconstruct3DPointFromPixels(pix1.x, pix1.y, pix2.x, pix2.y, C1, C2);
                    if (real3) {
                        results.push({ frame, pointId: p.id, x: real3.x, y: real3.y, z: real3.z });
                    }
                }
            });
        });

        if (results.length === 0) {
            if (typeof window.showError === 'function') window.showError('共通フレームでのデジタイズデータが見つかりません');
            return;
        }

        window.realLengthData = results;

        // 統計更新
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
        const uniqueFrames = new Set(results.map(r => r.frame)).size;
        setText('total-frames', uniqueFrames || 0);
        setText('total-points', points.length || 0);
        // 誤差情報はキャリブレーション時のものを表示（再構築誤差ではないが参考として）
        if (ccCalib.errorStats && typeof ccCalib.errorStats.rms === 'number') {
            setText('average-error', ccCalib.errorStats.rms.toFixed(4) + ' px(RMS)');
            setText('max-error', (ccCalib.errorStats.max || 0).toFixed(4) + ' px');
        } else {
            setText('average-error', '-');
            setText('max-error', '-');
        }

        if (typeof displayRealLengthTable === 'function') displayRealLengthTable(results);
        if (typeof window.showMessage === 'function') window.showMessage(`3次元CC法パラメータによる実長換算を完了しました（${results.length}点）`);
        return;
    }

    // 3D DLT: 両カメラの座標から3D再構成
    if (method === '3d-dlt') {
        const coeffs3d = window.projectData && window.projectData.cameraCoefficients3D ? window.projectData.cameraCoefficients3D : null;
        if (!coeffs3d || !coeffs3d.cam1 || !coeffs3d.cam2 || !window.AnalysisEngine || typeof window.AnalysisEngine.reconstruct3DPointFromPixels !== 'function') {
            if (typeof window.showError === 'function') window.showError('3次元DLTのカメラ定数が未設定です。先に「カメラ定数算出」を実行してください');
            return;
        }
        const cam1Data = window.cameraDigitizeData && window.cameraDigitizeData.cam1 ? window.cameraDigitizeData.cam1 : {};
        const cam2Data = window.cameraDigitizeData && window.cameraDigitizeData.cam2 ? window.cameraDigitizeData.cam2 : {};
        const frames1 = Object.keys(cam1Data).map(Number);
        const frames2 = Object.keys(cam2Data).map(Number);
        const frameSet = new Set(frames1.filter(f => frames2.includes(f)));
        const frames = Array.from(frameSet).sort((a, b) => a - b);

        const points = Array.isArray(window.motionPoints) ? window.motionPoints : [];
        const results = [];
        frames.forEach(frame => {
            const map1 = cam1Data[frame];
            const map2 = cam2Data[frame];
            let count = 0;
            if (!map1 || !map2 || typeof map1.forEach !== 'function' || typeof map2.forEach !== 'function') return;
            points.forEach(p => {
                const pix1 = map1.get ? map1.get(p.id) : map1[p.id];
                const pix2 = map2.get ? map2.get(p.id) : map2[p.id];
                if (pix1 && pix2 && typeof pix1.x === 'number' && typeof pix1.y === 'number' && typeof pix2.x === 'number' && typeof pix2.y === 'number') {
                    const real3 = window.AnalysisEngine.reconstruct3DPointFromPixels(pix1.x, pix1.y, pix2.x, pix2.y, coeffs3d.cam1, coeffs3d.cam2);
                    if (real3) {
                        results.push({ frame, pointId: p.id, x: real3.x, y: real3.y, z: real3.z });
                        count++;
                    }
                }
            });
            if (window && window.__DEBUG__) console.debug(`[RL][3D] frame ${frame} points ${count}`);
        });
        window.realLengthData = results;

        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
        const uniqueFrames = new Set(results.map(r => r.frame)).size;
        const motionPoints = Array.isArray(window.motionPoints) ? window.motionPoints : [];
        setText('total-frames', uniqueFrames || 0);
        setText('total-points', motionPoints.length || 0);
        // キャリブレーション時の誤差情報を表示
        const errorAnalysis3D = window.projectData?.calibrationErrorAnalysis3D;
        if (errorAnalysis3D && typeof errorAnalysis3D.meanError === 'number') {
            setText('average-error', errorAnalysis3D.meanError.toFixed(4));
            setText('max-error', errorAnalysis3D.maxError.toFixed(4));
        } else {
            setText('average-error', '0.00');
            setText('max-error', '0.00');
        }

        displayRealLengthTable(results);
        if (typeof window.showMessage === 'function') window.showMessage('3次元DLTによる実長換算を完了しました');
        return;
    }

    // 2D DLT（ステレオ）: カメラ1・2を結合して最終XYを出力
    if (method === '2d-dlt-stereo') {
        const coeffs2d = (window.projectData && window.projectData.cameraCoefficients2D) ? window.projectData.cameraCoefficients2D : null;
        const coeffCam1 = (coeffs2d && coeffs2d.cam1) ? coeffs2d.cam1 : (window.projectData && window.projectData.cameraCoefficients ? window.projectData.cameraCoefficients.cam1 : null);
        const coeffCam2 = (coeffs2d && coeffs2d.cam2) ? coeffs2d.cam2 : (window.projectData && window.projectData.cameraCoefficients ? window.projectData.cameraCoefficients.cam2 : null);
        if (!coeffCam1 || !coeffCam2 || typeof window.stitchStereo2DDLT !== 'function') {
            if (typeof window.showError === 'function') window.showError('2次元DLT（ステレオ）のカメラ定数が未設定です。先に「カメラ定数算出」を実行してください');
            return;
        }

        const cam1Data = (window.cameraDigitizeData && window.cameraDigitizeData.cam1) ? window.cameraDigitizeData.cam1 : {};
        const cam2Data = (window.cameraDigitizeData && window.cameraDigitizeData.cam2) ? window.cameraDigitizeData.cam2 : {};
        const frames1 = Object.keys(cam1Data).map(Number).filter(Number.isFinite);
        const frames2 = Object.keys(cam2Data).map(Number).filter(Number.isFinite);

        // UI値（未入力なら0として受け取る）
        let s1 = parseInt(document.getElementById('cam1-start')?.value || '0', 10);
        let e1 = parseInt(document.getElementById('cam1-end')?.value || '0', 10);
        let s2 = parseInt(document.getElementById('cam2-start')?.value || '0', 10);
        let e2 = parseInt(document.getElementById('cam2-end')?.value || '0', 10);

        // 自動補完: 未入力/不正値をデータから推定
        if ((!s1 || s1 < 1) && frames1.length) s1 = Math.min(...frames1);
        if ((!e1 || e1 < s1) && frames1.length) e1 = Math.max(...frames1);
        if ((!s2 || s2 < 1) && frames2.length) s2 = Math.min(...frames2);
        if ((!e2 || e2 < s2) && frames2.length) e2 = Math.max(...frames2);

        // どちらのカメラにもフレームが無い場合
        if ((!frames1.length) && (!frames2.length)) {
            if (typeof window.showError === 'function') window.showError('モーションのデジタイズデータがありません');
            return;
        }

        const blend = document.getElementById('stereo-blend')?.value || 'linear';

        const stitched = window.stitchStereo2DDLT({
            coeffCam1,
            coeffCam2,
            frameRanges: { s1, e1, s2, e2 },
            blendMode: blend,
            cam1Data,
            cam2Data,
            motionPoints: Array.isArray(window.motionPoints) ? window.motionPoints : []
        });

        const results = [];
        Object.keys(stitched).map(Number).sort((a, b) => a - b).forEach(frame => {
            const perPoint = stitched[frame] || {};
            Object.keys(perPoint).forEach(pidStr => {
                const pid = Number(pidStr);
                const xy = perPoint[pid];
                if (xy && typeof xy.x === 'number' && typeof xy.y === 'number') {
                    results.push({ frame, pointId: pid, x: xy.x, y: xy.y });
                }
            });
        });

        window.realLengthData = results;

        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
        const uniqueFrames = new Set(results.map(r => r.frame)).size;
        const motionPoints = Array.isArray(window.motionPoints) ? window.motionPoints : [];
        setText('total-frames', uniqueFrames || 0);
        setText('total-points', motionPoints.length || 0);
        // キャリブレーション時の誤差情報を表示（両カメラの平均を使用）
        const errorCam1 = window.projectData?.calibrationErrorAnalysis?.cam1;
        const errorCam2 = window.projectData?.calibrationErrorAnalysis?.cam2;
        if (errorCam1 && errorCam2) {
            const avgMean = (errorCam1.meanError + errorCam2.meanError) / 2;
            const maxMax = Math.max(errorCam1.maxError, errorCam2.maxError);
            setText('average-error', avgMean.toFixed(4));
            setText('max-error', maxMax.toFixed(4));
        } else {
            setText('average-error', '0.00');
            setText('max-error', '0.00');
        }

        if (typeof displayRealLengthTable === 'function') displayRealLengthTable(results);
        if (typeof window.showMessage === 'function') window.showMessage('2次元DLT（ステレオ）による実長換算を完了しました');
        return;
    }

    // 2D DLT: 片カメラの座標からX,Yを再構成
    const cam = typeof window.getCurrentCamera === 'function' ? window.getCurrentCamera() : 'cam1';
    // 係数: dltCoefficients → cameraCoefficients[cam] の順でフォールバック
    let coeffs = (window.projectData && window.projectData.dltCoefficients) || null;
    if (!coeffs && window.projectData && window.projectData.cameraCoefficients) {
        coeffs = window.projectData.cameraCoefficients[cam] || null;
    }
    if (!coeffs || !window.AnalysisEngine || !window.AnalysisEngine.isValidCameraCoefficients(coeffs)) {
        if (typeof window.showError === 'function') window.showError('カメラ定数が未設定です。「カメラ定数算出」を先に実行してください');
        return;
    }

    const camData = window.cameraDigitizeData && window.cameraDigitizeData[cam] ? window.cameraDigitizeData[cam] : {};
    const frames = Object.keys(camData).map(n => Number(n)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (window && window.__DEBUG__) console.debug('[RL] camera & frames', cam, frames.length);

    const results = [];
    frames.forEach(frame => {
        const map = camData[frame];
        let count = 0;
        if (!map || typeof map.forEach !== 'function') return;
        map.forEach((pix, pid) => {
            if (pix && typeof pix.x === 'number' && typeof pix.y === 'number') {
                const real = window.AnalysisEngine.calculateRealCoordinates(pix.x, pix.y, coeffs);
                if (real && typeof real.x === 'number' && typeof real.y === 'number') {
                    results.push({ frame, pointId: pid, x: real.x, y: real.y });
                    count++;
                }
            }
        });
    });

    window.realLengthData = results;

    // 統計情報を更新
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
    const uniqueFrames = new Set(results.map(r => r.frame)).size;
    const motionPoints = Array.isArray(window.motionPoints) ? window.motionPoints : [];
    setText('total-frames', uniqueFrames || 0);
    setText('total-points', motionPoints.length || 0);
    // キャリブレーション時の誤差情報を表示
    const errorAnalysis = window.projectData?.calibrationErrorAnalysis?.[cam];
    if (errorAnalysis && typeof errorAnalysis.meanError === 'number') {
        setText('average-error', errorAnalysis.meanError.toFixed(4));
        setText('max-error', errorAnalysis.maxError.toFixed(4));
    } else {
        setText('average-error', '0.00');
        setText('max-error', '0.00');
    }

    if (typeof displayRealLengthTable === 'function') displayRealLengthTable(results);
}

window.exportExcel = exportExcel;
window.calculateRealLengthData = calculateRealLengthData;
window.checkRealLengthPrerequisites = checkRealLengthPrerequisites;

// 実長換算テーブルの表示（flat results → 表レンダリング）
function displayRealLengthTable(results) {
    const tableHead = document.getElementById('real-length-table-head');
    const tableBody = document.getElementById('real-length-table-body');
    if (!tableHead || !tableBody) return;

    // window.realLengthDataを設定（エクスポート用）
    if (results && Array.isArray(results) && results.length > 0) {
        window.realLengthData = results;
        try {
        } catch (_) { }
    }

    // クリア
    tableHead.innerHTML = '';
    tableBody.innerHTML = '';

    const is3D = Array.isArray(results) && results.some(r => typeof r.z === 'number');

    // ヘッダ行
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th title="全選択">フレーム</th>';
    const points = Array.isArray(window.motionPoints) ? window.motionPoints : [];
    points.forEach(point => {
        headerRow.innerHTML += `\n\t\t\t\t<th colspan="${is3D ? 3 : 2}">${point.name || `P${point.id}`}</th>`;
    });

    // 全選択イベント
    if (headerRow.cells[0]) {
        headerRow.cells[0].style.cursor = 'pointer';
        headerRow.cells[0].onclick = () => {
            if (typeof window.selectAllTable === 'function') window.selectAllTable();
        };
    }

    tableHead.appendChild(headerRow);

    // サブヘッダ行
    const subHeaderRow = document.createElement('tr');
    subHeaderRow.innerHTML = '<th></th>';
    points.forEach(() => {
        subHeaderRow.innerHTML += is3D ? '<th>X (m)</th><th>Y (m)</th><th>Z (m)</th>' : '<th>X (m)</th><th>Y (m)</th>';
    });
    tableHead.appendChild(subHeaderRow);

    // フレーム単位にグルーピング
    const frameToPoints = new Map(); // frame -> { [pointId]: {x,y(,z)} }
    (results || []).forEach(r => {
        const f = Number(r.frame);
        if (!frameToPoints.has(f)) frameToPoints.set(f, {});
        frameToPoints.get(f)[String(r.pointId)] = { x: r.x, y: r.y, z: r.z };
    });

    // 行描画（フレーム昇順）
    Array.from(frameToPoints.keys()).sort((a, b) => a - b).forEach(frame => {
        const row = document.createElement('tr');
        row.innerHTML = `<td class="frame-cell">${frame}</td>`;
        const map = frameToPoints.get(frame);
        points.forEach(p => {
            const pd = map[String(p.id)];
            if (pd && typeof pd.x === 'number' && typeof pd.y === 'number') {
                if (is3D && typeof pd.z === 'number') {
                    row.innerHTML += `<td>${pd.x.toFixed(4)}</td><td>${pd.y.toFixed(4)}</td><td>${pd.z.toFixed(4)}</td>`;
                } else {
                    row.innerHTML += `<td>${pd.x.toFixed(4)}</td><td>${pd.y.toFixed(4)}</td>`;
                }
            } else {
                row.innerHTML += is3D ? '<td>-</td><td>-</td><td>-</td>' : '<td>-</td><td>-</td>';
            }
        });
        tableBody.appendChild(row);
    });
}

// 旧app.js互換: 較正結果表示の最小実装
function updateCalibrationDisplay(cameraCoefficients, errorAnalysis) {
    // カメラ定数
    const coeffIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    coeffIds.forEach((k) => {
        const el = document.getElementById(`coeff-${k}`);
        if (!el) return;
        if (cameraCoefficients && typeof cameraCoefficients[k.toUpperCase()] === 'number') {
            el.textContent = cameraCoefficients[k.toUpperCase()].toFixed(6);
        } else {
            el.textContent = '-';
        }
    });

    // 誤差
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = (val !== undefined && val !== null) ? `${Number(val).toFixed(6)} m` : '-';
    };
    if (errorAnalysis) {
        setText('error-x', errorAnalysis.stdErrorX);
        setText('error-y', errorAnalysis.stdErrorY);
        setText('error-mean', errorAnalysis.meanError);
        setText('error-max', errorAnalysis.maxError);
    } else {
        setText('error-x', null);
        setText('error-y', null);
        setText('error-mean', null);
        setText('error-max', null);
    }

    // 較正状態（簡易）
    const statusEl = document.getElementById('calibration-status');
    const countEl = document.getElementById('calibration-point-count');
    if (countEl && window.calibrationData) {
        countEl.textContent = `${window.calibrationData.points.length}`;
    }
    if (statusEl) {
        statusEl.textContent = (cameraCoefficients) ? '較正済み' : '未較正';
    }
    const accuracyEl = document.getElementById('calibration-accuracy');
    if (accuracyEl) {
        if (errorAnalysis && errorAnalysis.meanError != null) {
            accuracyEl.innerHTML = getCalibrationRating(errorAnalysis.meanError);
        } else {
            accuracyEl.textContent = '-';
        }
    }

    // 2D DLT 品質カード更新（誤差はメートル単位→mm変換）
    if (errorAnalysis && errorAnalysis.meanError != null) {
        const pts = window.calibrationData ? window.calibrationData.points.length : 0;
        const meanMm = errorAnalysis.meanError * 1000; // m → mm
        updateDLTQualityCard('dlt2d', meanMm, pts, 'mm', 30);
    }
}

window.updateCalibrationDisplay = updateCalibrationDisplay;

/**
 * DLT法の品質カードを更新する共通関数
 * @param {string} prefix - 'dlt2d' or 'dlt3d'
 * @param {number} meanError - 平均誤差
 * @param {number} pointCount - 較正点数
 * @param {string} unit - 'px' or 'mm'
 * @param {number} scaleMax - カラーバーの最大値
 */
function updateDLTQualityCard(prefix, meanError, pointCount, unit, scaleMax) {
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(val);
    };

    // DLT: meanErrorは既にmm単位。pxは概算逆変換
    const el = document.getElementById(`${prefix}-reproj-error`);
    if (el) {
        const mm = typeof meanError === 'number' ? meanError : NaN;
        const factor = getPixelToMmFactor();
        const px = (!isNaN(mm) && factor) ? (mm / 1000 / factor) : NaN; // mm→m→px
        el.dataset.mm = !isNaN(mm) ? mm.toFixed(3) : '-';
        el.dataset.px = !isNaN(px) ? px.toFixed(3) : '-';
        const unitEl = el.nextElementSibling;
        const currentUnit = unitEl ? unitEl.textContent.trim() : 'mm';
        el.textContent = (currentUnit === 'px') ? el.dataset.px : el.dataset.mm;
    }
    setText(`${prefix}-point-count`, pointCount || '-');
    if (prefix === 'dlt3d') {
        setText('dlt3d-point-count-metric', pointCount || '-');
    }

    let level, icon, badge, desc;
    const e = meanError;
    if (unit === 'px') {
        // 2D DLT: ピクセル単位
        if (e <= 0.5) { level = 'excellent'; icon = 'verified'; badge = '非常に良好'; desc = `平均誤差 ${e.toFixed(3)} px は非常に良好です。`; }
        else if (e <= 1.0) { level = 'good'; icon = 'check_circle'; badge = '良好'; desc = `平均誤差 ${e.toFixed(3)} px は良好な範囲です。`; }
        else if (e <= 2.0) { level = 'fair'; icon = 'warning'; badge = '許容範囲'; desc = `平均誤差 ${e.toFixed(3)} px はやや大きめです。コントロールポイントを確認してください。`; }
        else { level = 'poor'; icon = 'error'; badge = '要再実行'; desc = `平均誤差 ${e.toFixed(3)} px は大きすぎます。座標・デジタイズを見直してください。`; }
    } else {
        // 3D DLT: mm単位
        if (e <= 5) { level = 'excellent'; icon = 'verified'; badge = '非常に良好'; desc = `平均誤差 ${e.toFixed(3)} mm は非常に良好です。`; }
        else if (e <= 10) { level = 'good'; icon = 'check_circle'; badge = '良好'; desc = `平均誤差 ${e.toFixed(3)} mm は良好な範囲です。スポーツ動作解析に適しています。`; }
        else if (e <= 20) { level = 'fair'; icon = 'warning'; badge = '許容範囲'; desc = `平均誤差 ${e.toFixed(3)} mm はやや大きめです。コントロールポイントを確認してください。`; }
        else { level = 'poor'; icon = 'error'; badge = '要再実行'; desc = `平均誤差 ${e.toFixed(3)} mm は大きすぎます。座標・デジタイズを見直してください。`; }
    }

    const card = document.getElementById(`${prefix}-quality-card`);
    if (card) {
        card.className = card.className.replace(/\bquality-\w+/g, '').trim();
        card.classList.add(`quality-${level}`);
    }
    const iconEl = document.getElementById(`${prefix}-quality-icon`);
    if (iconEl) iconEl.textContent = icon;
    const badgeEl = document.getElementById(`${prefix}-quality-badge`);
    if (badgeEl) badgeEl.textContent = badge;
    const descEl = document.getElementById(`${prefix}-quality-desc`);
    if (descEl) descEl.textContent = desc;
    const marker = document.getElementById(`${prefix}-quality-marker`);
    if (marker) {
        const pct = Math.min(e / scaleMax * 100, 100);
        marker.style.left = pct + '%';
    }
}
window.updateDLTQualityCard = updateDLTQualityCard;

// ステレオ用の結果表示（Cam1/Cam2を切り替えて描画）
function update2DDLTResultsDisplayStereo(coeff, errorAnalysis, which) {
    const suffix = (which === 'cam2') ? '-cam2' : '';
    // 係数
    const coeffIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    coeffIds.forEach((k) => {
        const el = document.getElementById(`coeff-${k}${suffix}`);
        if (!el) return;
        if (coeff && typeof coeff[k.toUpperCase()] === 'number') {
            el.textContent = coeff[k.toUpperCase()].toFixed(6);
        } else {
            el.textContent = '-';
        }
    });
    // 誤差
    const setText = (id, val) => {
        const el = document.getElementById(id + suffix);
        if (!el) return;
        el.textContent = (val !== undefined && val !== null) ? `${Number(val).toFixed(6)} m` : '-';
    };
    if (errorAnalysis) {
        setText('error-x', errorAnalysis.stdErrorX);
        setText('error-y', errorAnalysis.stdErrorY);
        setText('error-mean', errorAnalysis.meanError);
        setText('error-max', errorAnalysis.maxError);
    } else {
        setText('error-x', null);
        setText('error-y', null);
        setText('error-mean', null);
        setText('error-max', null);
    }

    // 較正状態の更新（ステレオ用）
    const statusEl = document.getElementById('calibration-status');
    const countEl = document.getElementById('calibration-point-count');
    const accuracyEl = document.getElementById('calibration-accuracy');
    if (statusEl && coeff) {
        statusEl.textContent = '較正済み';
    }
    if (countEl && window.calibrationData) {
        countEl.textContent = `${window.calibrationData.points.length}`;
    }
    if (accuracyEl && errorAnalysis && errorAnalysis.meanError != null) {
        accuracyEl.innerHTML = getCalibrationRating(errorAnalysis.meanError);
    }

    // 2D DLT 品質カード更新（ステレオ: 両カメラの平均誤差で評価）
    if (errorAnalysis && errorAnalysis.meanError != null) {
        const pts = window.calibrationData ? window.calibrationData.points.length : 0;
        const meanMm = errorAnalysis.meanError * 1000;
        updateDLTQualityCard('dlt2d', meanMm, pts, 'mm', 30);
    }
}
window.update2DDLTResultsDisplayStereo = update2DDLTResultsDisplayStereo;
// 較正精度の定性評価
// 閾値はバイオメカニクス文献のDLT再構成誤差ベンチマークに基づく
// 出典: https://pubmed.ncbi.nlm.nih.gov/ (DLT reconstruction error studies)
function getCalibrationRating(meanError) {
    const mm = meanError * 1000; // m → mm
    const mmStr = mm.toFixed(3) + ' mm';
    let label;
    if (mm < 5) label = '優';
    else if (mm < 10) label = '良';
    else if (mm < 20) label = '可';
    else label = '不可';
    return label + '<br>' + mmStr;
}
window.getCalibrationRating = getCalibrationRating;

// 係数表示の最小実装（不足エラー解消用）
function updateCameraCoefficientsDisplay() {
    const cam = (typeof window.getCurrentCamera === 'function') ? window.getCurrentCamera() : 'cam1';
    const coeffs = (window.projectData && (window.projectData.dltCoefficients || (window.projectData.cameraCoefficients && window.projectData.cameraCoefficients[cam]))) || null;
    if (typeof window.updateCalibrationDisplay === 'function') {
        window.updateCalibrationDisplay(coeffs, null);
    }
}
window.updateCameraCoefficientsDisplay = updateCameraCoefficientsDisplay;

// 旧app.js互換: ワークフロー進捗表示
function updateWorkflowSteps() {
    const methodSelect = document.getElementById('calibration-method');
    const method = methodSelect ? methodSelect.value : '2d-dlt';
    const needTwo = method === '3d-dlt' || method === 'checkerboard';

    const hasCal1 = !!(window.fileState && window.fileState['cal-cam1']);
    const hasCal2 = !!(window.fileState && window.fileState['cal-cam2']);
    const hasMotion1 = !!(window.fileState && window.fileState['motion-cam1']);
    const hasMotion2 = !!(window.fileState && window.fileState['motion-cam2']);

    const step1Done = needTwo ? (hasCal1 && hasCal2) : hasCal1;
    const step2Done = needTwo ? (hasMotion1 && hasMotion2) : hasMotion1;

    const completed = (step1Done ? 1 : 0) + (step2Done ? 1 : 0);
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    if (progressFill) progressFill.style.width = (completed / 2 * 100) + '%';
    if (progressText) progressText.textContent = `${completed}/2 ファイル選択完了`;

    const step1 = document.getElementById('step-1');
    const step2 = document.getElementById('step-2');

    if (step1) {
        step1.classList.remove('disabled');
        step1.classList.add('active');
        const status = step1.querySelector('.step-status');
        if (status) status.textContent = step1Done ? '完了' : '選択中';
    }

    if (step2) {
        const status = step2.querySelector('.step-status');
        step2.classList.remove('disabled');
        step2.classList.add('active');
        if (status) status.textContent = step2Done ? '完了' : '選択中';
    }
}

window.updateWorkflowSteps = updateWorkflowSteps;

// 旧app.js互換: ポイント設定タブ更新
function updatePointsTab() {
    const motionPointsList = document.getElementById('motion-points-list');
    const calibrationPointsList = document.getElementById('calibration-points-list');

    if (motionPointsList && window.motionPoints) {
        motionPointsList.innerHTML = '';
        window.motionPoints.forEach((point, index) => {
            const item = document.createElement('div');
            item.className = 'point-item';
            item.dataset.pointId = String(point.id);
            // 並べ替えボタンと編集ボタンを含むHTML
            item.innerHTML = `
                <div style="display:flex; align-items:center;">
                    <button class="btn-icon-tiny move-up" title="上へ" style="margin-right:2px;">↑</button>
                    <button class="btn-icon-tiny move-down" title="下へ" style="margin-right:8px;">↓</button>
                    <span class="point-id">${point.id}.</span>
                    <span class="point-name">${point.name}</span>
                </div>
                <button class="btn-edit" onclick="editMotionPointName(${point.id})">編集</button>
            `;

            // イベントリスナー
            const btnUp = item.querySelector('.move-up');
            const btnDown = item.querySelector('.move-down');
            const btnEdit = item.querySelector('.btn-edit');

            if (index === 0) btnUp.disabled = true;
            if (index === window.motionPoints.length - 1) btnDown.disabled = true;

            btnUp.addEventListener('click', (e) => {
                e.stopPropagation();
                moveMotionPoint(index, -1);
            });
            btnDown.addEventListener('click', (e) => {
                e.stopPropagation();
                moveMotionPoint(index, 1);
            });

            btnEdit.addEventListener('click', (e) => {
                e.stopPropagation();
                editMotionPointName(point.id);
            });

            item.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') return;

                Array.from(motionPointsList.children).forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                try {
                    if (typeof window.setSelectedLandmark === 'function') {
                        window.setSelectedLandmark({ id: point.id, name: point.name });
                    }
                    if (typeof window.updateTableHighlights === 'function') window.updateTableHighlights();
                } catch (_) { }
            });
            motionPointsList.appendChild(item);
        });
    }

    if (calibrationPointsList && window.calibrationData) {
        calibrationPointsList.innerHTML = '';
        window.calibrationData.points.forEach((point, index) => {
            const item = document.createElement('div');
            item.className = 'point-item';
            item.dataset.pointId = String(point.id);
            item.innerHTML = `
				<span class="point-id">${index + 1}.</span>
				<span class="point-name">${point.name}</span>
				<button class="btn-edit" onclick="editCalibrationPointName(${point.id})">編集</button>
			`;

            // 編集ボタンに個別のイベントリスナーを追加
            const editBtn = item.querySelector('.btn-edit');
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                editCalibrationPointName(point.id);
            });

            item.addEventListener('click', (e) => {
                // ボタンクリック時は選択処理をスキップ
                if (e.target.classList.contains('btn-edit')) {
                    return;
                }

                Array.from(calibrationPointsList.children).forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                try {
                    if (typeof window.setSelectedLandmark === 'function') {
                        window.setSelectedLandmark({ id: point.id, name: point.name });
                    }
                    if (typeof window.updateTableHighlights === 'function') window.updateTableHighlights();
                } catch (_) { }
            });
            calibrationPointsList.appendChild(item);
        });
    }
}

// モーションポイントの順番を入れ替える
window.moveMotionPoint = function (index, direction) {
    if (!window.motionPoints) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= window.motionPoints.length) return;

    const pointCurrent = window.motionPoints[index];
    const pointTarget = window.motionPoints[newIndex];

    // 現在のIDを保持（この場所にあるべきID）
    const idAtCurrentPos = pointCurrent.id;
    const idAtTargetPos = pointTarget.id;

    // 1. 配列上のオブジェクトを入れ替え
    window.motionPoints[index] = pointTarget;
    window.motionPoints[newIndex] = pointCurrent;

    // 2. IDを書き換え（IDは場所（インデックス）に紐付くとみなす）
    // 元々indexにあったIDを、新しくindexに来たオブジェクト(pointTarget)に割り当てる
    pointTarget.id = idAtCurrentPos;
    // 元々newIndexにあったIDを、新しくnewIndexに来たオブジェクト(pointCurrent)に割り当てる
    pointCurrent.id = idAtTargetPos;

    // 3. データのスワップ（IDが指す中身を入れ替える）
    // これにより、例えば ID:24 が ID:25 のデータを持つようになり、実質的にデータが移動したことになる
    swapDigitizeData(idAtCurrentPos, idAtTargetPos);

    // UI更新
    updatePointsTab();

    // データテーブルも更新
    if (typeof updateMotionDataTableForCurrentCamera === 'function') {
        updateMotionDataTableForCurrentCamera();
    }

    // 描画更新
    if (typeof window.redrawCanvas === 'function') {
        window.redrawCanvas();
    }

    // 追加: デジタイズ画面のプルダウンも更新
    if (typeof initializeMotionLandmarkSelector === 'function') {
        const select = document.getElementById('motion-landmark-select');
        const currentVal = select ? select.value : '';
        initializeMotionLandmarkSelector();
        if (select && currentVal) {
            select.value = currentVal;
        }
    }
};

// デジタイズデータのスワップ（ID間）
function swapDigitizeData(id1, id2) {
    if (!window.cameraDigitizeData) return;

    Object.keys(window.cameraDigitizeData).forEach(camKey => {
        const frames = window.cameraDigitizeData[camKey];
        if (!frames) return;

        // framesはオブジェクト（キーがフレーム番号）なので、Object.valuesで反復
        // エラー回避: frames.forEach -> Object.values(frames).forEach
        Object.values(frames).forEach(frameData => {
            if (!frameData) return;

            // Mapの場合とObjectの場合で処理を分ける
            if (frameData instanceof Map) {
                const data1 = frameData.get(id1);
                const data2 = frameData.get(id2);

                // data2 -> id1へ
                if (data2 !== undefined) {
                    frameData.set(id1, data2);
                } else {
                    frameData.delete(id1);
                }

                // data1 -> id2へ
                if (data1 !== undefined) {
                    frameData.set(id2, data1);
                } else {
                    frameData.delete(id2);
                }
            } else {
                // Objectの場合 (旧形式や一部の初期化状態)
                const data1 = frameData[id1];
                const data2 = frameData[id2];

                // data2 -> id1へ
                if (data2 !== undefined) {
                    frameData[id1] = data2;
                } else {
                    delete frameData[id1];
                }

                // data1 -> id2へ
                if (data1 !== undefined) {
                    frameData[id2] = data1;
                } else {
                    delete frameData[id2];
                }
            }
        });
    });
}


function addMotionPoint() {
    if (!window.motionPoints) return;
    const newId = window.motionPoints.length + 1;
    const newPoint = { id: newId, name: `ポイント${newId}` };
    window.motionPoints.push(newPoint);
    updatePointsTab();

    // モーションデータテーブルの列を更新
    updateMotionDataTableColumns();

    // 新しく追加されたポイントの名前編集モーダルを開く
    setTimeout(() => {
        editingPoint = { type: 'motion', point: newPoint };
        openEditNameModal(newPoint.name);

        // 追加されたポイントにスクロールしてフォーカス
        scrollToNewPoint('motion-points-list', newPoint.id);
    }, 100); // 少し遅延させてUI更新後にモーダルを開く

    if (typeof window.showMessage === 'function') window.showMessage(`モーションポイント「${newPoint.name}」を追加しました`);
}

function updateMotionDataTableColumns() {
    // モーションデータテーブルのヘッダーを更新
    const tableHead = document.querySelector('.data-table thead');
    if (!tableHead || !window.motionPoints) return;

    // 既存のヘッダー行を取得
    const headerRow = tableHead.querySelector('tr');
    if (!headerRow) return;

    // 既存の列数を確認
    const existingColumns = headerRow.querySelectorAll('th').length;
    const expectedColumns = window.motionPoints.length + 1; // +1 for frame column

    // 列数が同じ場合は、既存の列名を更新
    if (existingColumns === expectedColumns) {
        // フレーム列は保持し、ポイント列の名前を更新
        const frameCell = headerRow.querySelector('th:first-child');
        if (frameCell) {
            // 既存のヘッダーをクリアして再構築
            headerRow.innerHTML = '';
            headerRow.appendChild(frameCell);

            // モーションポイントの列を再構築
            window.motionPoints.forEach(point => {
                const th = document.createElement('th');
                th.textContent = `${point.id}. ${point.name}`;
                th.className = 'point-header';
                headerRow.appendChild(th);
            });
        }

        // デジタイズ画面のランドマークセレクタも更新
        updateDigitizeLandmarkSelector();
        return;
    }

    // 新しい列のみを追加（既存の列は保持）
    if (existingColumns < expectedColumns) {
        // フレーム列の後に新しいポイント列を追加
        for (let i = existingColumns; i < expectedColumns; i++) {
            const pointIndex = i - 1; // -1 for frame column
            if (window.motionPoints[pointIndex]) {
                const th = document.createElement('th');
                th.textContent = `${window.motionPoints[pointIndex].id}. ${window.motionPoints[pointIndex].name}`;
                th.className = 'point-header';
                headerRow.appendChild(th);
            }
        }

        // テーブルボディに新しい列のセルを追加
        addNewColumnsToTableBody();

        // デジタイズ画面のランドマークセレクタも更新
        updateDigitizeLandmarkSelector();
    }
}

function updateDigitizeLandmarkSelector() {
    // デジタイズ画面のランドマークセレクタを更新
    const landmarkSelector = document.querySelector('.landmark-selector select');
    if (landmarkSelector && window.motionPoints) {
        // 現在選択されている値を保存
        const currentValue = landmarkSelector.value;

        // オプションを更新
        landmarkSelector.innerHTML = '';

        // デフォルトオプションを追加
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'ランドマークを選択';
        landmarkSelector.appendChild(defaultOption);

        // モーションポイントのオプションを追加
        window.motionPoints.forEach(point => {
            const option = document.createElement('option');
            option.value = point.id;
            option.textContent = `${point.id}. ${point.name}`;
            landmarkSelector.appendChild(option);
        });

        // 以前選択されていた値があれば復元
        if (currentValue && landmarkSelector.querySelector(`option[value="${currentValue}"]`)) {
            landmarkSelector.value = currentValue;
        }
    }

    // デジタイズ画面のその他のUI要素も更新（必要に応じて）
    updateDigitizeScreenUI();
}

function updateDigitizeScreenUI() {
    // デジタイズ画面のその他のUI要素を更新
    // ポイント名が表示されている箇所があれば更新
    const digitizeElements = document.querySelectorAll('[data-point-name]');
    digitizeElements.forEach(element => {
        const pointId = element.dataset.pointId;
        if (pointId && window.motionPoints) {
            const point = window.motionPoints.find(p => p.id == pointId);
            if (point) {
                element.textContent = point.name;
            }
        }
    });
}

function addNewColumnsToTableBody() {
    const tableBody = document.querySelector('.data-table tbody');
    if (!tableBody || !window.motionPoints) return;

    // 各行に新しいポイントのセルのみを追加（既存のセルは保持）
    tableBody.querySelectorAll('tr').forEach(row => {
        const existingCells = row.querySelectorAll('td');
        const expectedCells = window.motionPoints.length + 1; // +1 for frame column

        // 不足している列のセルのみを追加
        if (existingCells.length < expectedCells) {
            for (let i = existingCells.length; i < expectedCells; i++) {
                const td = document.createElement('td');
                td.textContent = '';
                td.className = 'point-cell';
                row.appendChild(td);
            }
        }
    });
}

function updateMotionDataTableBody() {
    // この関数は既存のデータを保持するため、新しく追加された列のみを処理
    addNewColumnsToTableBody();
}

function addCalibrationPoint() {
    if (!window.calibrationData) return;
    const idx = window.calibrationData.points.length + 1;
    const newPoint = {
        id: `Cal${idx}`,
        name: `Cal${idx}`,
        digitizedCoords: { cam1: { x: null, y: null }, cam2: { x: null, y: null } },
        realCoords: { x: null, y: null, z: null },
        errors: { x: null, y: null, z: null },
        isDigitized: false,
        frameNumber: null,
        frameNumber2: null
    };
    window.calibrationData.points.push(newPoint);
    updatePointsTab();

    // テーブルにも即時反映
    if (typeof window.updateCalibrationDataTable === 'function') {
        window.updateCalibrationDataTable();
    }

    // 追加されたポイントにスクロールしてフォーカス
    setTimeout(() => {
        scrollToNewPoint('calibration-points-list', newPoint.id);
    }, 100);

    if (typeof window.initializeCalibrationLandmarkSelector === 'function') window.initializeCalibrationLandmarkSelector();
    if (typeof window.showMessage === 'function') window.showMessage(`キャリブレーションポイント「${newPoint.name}」を追加しました`);
}

/**
 * キャリブレーションポイントを削除
 * @param {string} pointId - 削除するポイントのID
 */
function deleteCalibrationPoint(pointId) {
    if (!window.calibrationData || !window.calibrationData.points) return;

    const pointIndex = window.calibrationData.points.findIndex(p => p.id === pointId);
    if (pointIndex === -1) return;

    const deletedPoint = window.calibrationData.points[pointIndex];

    // 確認ダイアログ（オプション）
    // if (!confirm(`キャリブレーションポイント「${deletedPoint.name}」を削除しますか？`)) return;

    // ポイントを削除
    window.calibrationData.points.splice(pointIndex, 1);

    // 現在選択中のポイントが削除された場合、選択を解除または別のポイントを選択
    const currentLandmark = getSelectedLandmark();
    if (currentLandmark && currentLandmark.id === pointId) {
        if (window.calibrationData.points.length > 0) {
            // 次のポイントまたは前のポイントを選択
            const newIndex = Math.min(pointIndex, window.calibrationData.points.length - 1);
            setSelectedLandmark(window.calibrationData.points[newIndex]);
        } else {
            setSelectedLandmark(null);
        }
    }

    // UIを更新
    updatePointsTab();

    if (typeof window.updateCalibrationDataTable === 'function') {
        window.updateCalibrationDataTable();
    }

    if (typeof window.initializeCalibrationLandmarkSelector === 'function') {
        window.initializeCalibrationLandmarkSelector();
    }

    // キャンバスを再描画
    if (typeof redrawCanvasOnly === 'function') {
        redrawCanvasOnly();
    }

    showMessage(`キャリブレーションポイント「${deletedPoint.name}」を削除しました`);
}

function scrollToNewPoint(listId, pointId) {
    const list = document.getElementById(listId);
    if (!list) return;

    // 新しく追加されたポイントの要素を探す
    const newPointElement = list.querySelector(`[data-point-id="${pointId}"]`);
    if (newPointElement) {
        // スクロールして表示
        newPointElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        // 選択状態にしてハイライト
        Array.from(list.children).forEach(el => el.classList.remove('selected'));
        newPointElement.classList.add('selected');

        // フォーカスを設定（編集ボタンに）
        const editBtn = newPointElement.querySelector('.btn-edit');
        if (editBtn) {
            editBtn.focus();
        }
    }
}

// グローバル変数で編集対象のポイントを管理
let editingPoint = null;

function editMotionPointName(pointId) {
    const point = window.motionPoints.find(p => p.id === pointId);
    if (!point) return;

    editingPoint = { type: 'motion', point: point };
    openEditNameModal(point.name);
}

function editCalibrationPointName(pointId) {
    const point = window.calibrationData.points.find(p => p.id === pointId);
    if (!point) return;

    editingPoint = { type: 'calibration', point: point };
    openEditNameModal(point.name);
}

function openEditNameModal(currentName) {
    const modal = document.getElementById('edit-name-modal');
    const input = document.getElementById('edit-name-input');

    if (modal && input) {
        input.value = currentName;
        input.select();
        modal.style.display = 'flex';
        input.focus();
    }
}

function closeEditNameModal() {
    const modal = document.getElementById('edit-name-modal');
    if (modal) {
        modal.style.display = 'none';
        editingPoint = null;
    }
}

function saveEditedName() {
    if (!editingPoint) return;

    const input = document.getElementById('edit-name-input');
    const newName = input.value.trim();

    if (!newName) {
        if (typeof window.showMessage === 'function') window.showMessage('名前を入力してください');
        return;
    }

    if (newName === editingPoint.point.name) {
        closeEditNameModal();
        return;
    }

    // 名前を更新
    editingPoint.point.name = newName;

    // UIを更新
    updatePointsTab();

    // モーションポイントの場合はテーブル列も更新
    if (editingPoint.type === 'motion') {
        updateMotionDataTableColumns();
    }

    // キャリブレーションポイントの場合は追加処理
    if (editingPoint.type === 'calibration') {
        if (typeof window.initializeCalibrationLandmarkSelector === 'function') {
            window.initializeCalibrationLandmarkSelector();
        }
    }

    // 成功メッセージ
    const pointType = editingPoint.type === 'motion' ? 'モーションポイント' : 'キャリブレーションポイント';
    if (typeof window.showMessage === 'function') {
        window.showMessage(`${pointType}名を「${newName}」に変更しました`);
    }

    closeEditNameModal();
}

function removeMotionPoint() {
    if (!window.motionPoints || !Array.isArray(window.motionPoints)) return;
    if (window.motionPoints.length === 0) {
        if (typeof window.showMessage === 'function') window.showMessage('削除するポイントがありません');
        return;
    }
    let removeIndex = -1;
    try {
        const sel = typeof window.getSelectedLandmark === 'function' ? window.getSelectedLandmark() : null;
        if (sel) {
            removeIndex = window.motionPoints.findIndex(p => String(p.id) === String(sel.id) || String(p.name) === String(sel.name));
        }
    } catch (_) { }
    if (removeIndex < 0) removeIndex = window.motionPoints.length - 1;

    const removed = window.motionPoints.splice(removeIndex, 1)[0];

    // 再採番（ポイント1,2,...）
    window.motionPoints = window.motionPoints.map((p, idx) => ({ id: idx + 1, name: `ポイント${idx + 1}` }));

    updatePointsTab();

    // モーションデータテーブルの列を更新
    updateMotionDataTableColumns();

    if (typeof window.showMessage === 'function') window.showMessage(`モーションポイント「${removed ? removed.name : ''}」を削除しました`);
}

function removeCalibrationPoint() {
    if (!window.calibrationData || !Array.isArray(window.calibrationData.points)) return;
    if (window.calibrationData.points.length === 0) {
        if (typeof window.showMessage === 'function') window.showMessage('削除するポイントがありません');
        return;
    }
    // 選択されているCalポイントがあればそれを削除、なければ末尾を削除
    let removeIndex = -1;
    try {
        const sel = typeof window.getSelectedLandmark === 'function' ? window.getSelectedLandmark() : null;
        if (sel) {
            removeIndex = window.calibrationData.points.findIndex(p => String(p.id) === String(sel.id) || String(p.name) === String(sel.name));
        }
    } catch (_) { }
    if (removeIndex < 0) removeIndex = window.calibrationData.points.length - 1;

    const removed = window.calibrationData.points.splice(removeIndex, 1)[0];

    // 連番名 CalN を崩さないようにIDと名称を再採番
    window.calibrationData.points = window.calibrationData.points.map((p, idx) => ({ id: idx + 1, name: `Cal${idx + 1}`, digitizedCoords: p.digitizedCoords, realCoords: p.realCoords, errors: p.errors }));

    updatePointsTab();
    if (typeof window.initializeCalibrationLandmarkSelector === 'function') window.initializeCalibrationLandmarkSelector();
    if (typeof window.showMessage === 'function') window.showMessage(`キャリブレーションポイント「${removed ? removed.name : ''}」を削除しました`);
}

window.updatePointsTab = updatePointsTab;
window.addMotionPoint = addMotionPoint;
window.addCalibrationPoint = addCalibrationPoint;
window.deleteCalibrationPoint = deleteCalibrationPoint;
window.removeCalibrationPoint = removeCalibrationPoint;
window.removeMotionPoint = removeMotionPoint;
window.editMotionPointName = editMotionPointName;
window.editCalibrationPointName = editCalibrationPointName;
window.openEditNameModal = openEditNameModal;
window.closeEditNameModal = closeEditNameModal;
window.saveEditedName = saveEditedName;
window.scrollToNewPoint = scrollToNewPoint;
window.updateMotionDataTableColumns = updateMotionDataTableColumns;
window.updateMotionDataTableBody = updateMotionDataTableBody;
window.updateDigitizeLandmarkSelector = updateDigitizeLandmarkSelector;
window.updateDigitizeScreenUI = updateDigitizeScreenUI;

// 旧app.js互換: 分析タブ初期化（最小実装）
function initializeRealLengthAnalysis() {
    // 係数・誤差のプレースホルダ表示をクリア
    if (typeof window.updateCalibrationDisplay === 'function') {
        window.updateCalibrationDisplay(null, null);
    }
    // ボタン等の状態更新
    if (typeof window.updateCalibrationButtonState === 'function') {
        window.updateCalibrationButtonState();
    }
    // 初期化メッセージ
    if (typeof window.showMessage === 'function') {
        window.showMessage('分析タブを初期化しました');
    }
}

window.initializeRealLengthAnalysis = initializeRealLengthAnalysis;

// 3D DLT結果の表示更新
// 3D DLT結果の表示更新（renderer.jsのロジックを統合・拡張）
function update3DDLTResultsDisplay(res3d) {
    if (!res3d || (!res3d.success && !res3d.standardError)) return;

    // --- 係数表示 (Main Panel: d3-*) ---
    const coeffsCam1 = (res3d.coefficients && res3d.coefficients.cam1) ? res3d.coefficients.cam1 : res3d.cam1;
    const coeffsCam2 = (res3d.coefficients && res3d.coefficients.cam2) ? res3d.coefficients.cam2 : res3d.cam2;
    // A..K (L1..L11)
    const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
    const getVal = (obj, k) => {
        if (!obj) return null;
        if (k in obj) return obj[k];
        const map = { A: 'L1', B: 'L2', C: 'L3', D: 'L4', E: 'L5', F: 'L6', G: 'L7', H: 'L8', I: 'L9', J: 'L10', K: 'L11' };
        const lk = map[k];
        return (lk && obj[lk] != null) ? obj[lk] : null;
    };
    const put = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v != null && isFinite(Number(v))) ? Number(v).toFixed(6) : '-'; };

    keys.forEach(k => put(`d3-cam1-${k}`, getVal(coeffsCam1, k)));
    keys.forEach(k => put(`d3-cam2-${k}`, getVal(coeffsCam2, k)));

    // --- 誤差表示 (Main Panel: d3-*) ---
    const se = res3d.standardError || {};
    put('d3-se-x', se.seX);
    put('d3-se-y', se.seY);
    put('d3-se-z', se.seZ);

    // 平均誤差・最大誤差
    let mean = res3d.meanError;
    let max = res3d.maxError;

    // もしres3dにmeanErrorが含まれていない場合（ロード直後など）、pointsから再計算を試みる
    if (mean == null && window.calibrationData && Array.isArray(window.calibrationData.points)) {
        const mags = window.calibrationData.points
            .map(p => p && p.errors)
            .filter(e => e && [e.x, e.y, e.z].every(v => isFinite(Number(v))))
            .map(e => Math.sqrt(Number(e.x) ** 2 + Number(e.y) ** 2 + Number(e.z) ** 2));
        if (mags.length > 0) {
            mean = mags.reduce((a, b) => a + b, 0) / mags.length;
            max = Math.max(...mags);
        }
    } else if (mean == null && se.seX != null) {
        // 最悪の場合SEから推定
        mean = Math.sqrt(se.seX * se.seX + se.seY * se.seY + se.seZ * se.seZ);
    }

    put('d3-mean', mean);
    put('d3-max', max);

    // --- ステータス表示 (Main Panel: d3-*) ---
    const n = (res3d.pointCount != null) ? res3d.pointCount :
        ((window.calibrationData && window.calibrationData.points) ? window.calibrationData.points.length : 0);

    const countEl = document.getElementById('d3-point-count');
    const statusEl = document.getElementById('d3-status');
    const accEl = document.getElementById('d3-accuracy');

    if (countEl) countEl.textContent = String(n || 0);
    if (statusEl) statusEl.textContent = (n && n >= 6) ? '較正済み' : '未較正';

    // 評価付き精度表示 (Main Panel)
    if (accEl) {
        if (mean != null && typeof window.getCalibrationRating === 'function') {
            accEl.innerHTML = window.getCalibrationRating(mean);
        } else {
            accEl.textContent = (mean != null) ? Number(mean).toFixed(6) : '-';
        }
    }

    // --- サイドバー共通UIの更新 (calibration-*) ---
    const sbStatus = document.getElementById('calibration-status');
    const sbCount = document.getElementById('calibration-point-count');
    const sbAcc = document.getElementById('calibration-accuracy');

    if (sbStatus) sbStatus.textContent = (n && n >= 6) ? '較正済み' : '未較正';
    if (sbCount) sbCount.textContent = String(n || 0);
    if (sbAcc) {
        if (mean != null && typeof window.getCalibrationRating === 'function') {
            sbAcc.innerHTML = window.getCalibrationRating(mean);
        } else {
            sbAcc.textContent = '-';
        }
    }
    // --- 詳細レポ－トテーブルの更新 ---
    const body = document.getElementById('dlt3d-detail-body');
    if (body && window.calibrationData && Array.isArray(window.calibrationData.points)) {
        body.innerHTML = '';
        window.calibrationData.points.forEach(p => {
            const e = p.errors || {};
            const tr = document.createElement('tr');
            const ex = (e.x != null) ? Number(e.x).toFixed(6) : '-';
            const ey = (e.y != null) ? Number(e.y).toFixed(6) : '-';
            const ez = (e.z != null) ? Number(e.z).toFixed(6) : '-';
            tr.innerHTML = `<td>${p.name || p.id}</td><td>${ex}</td><td>${ey}</td><td>${ez}</td>`;
            body.appendChild(tr);
        });
    }

    // 3D DLT 品質カード更新（誤差はメートル単位→mm変換）
    if (mean != null) {
        const meanMm = mean * 1000;
        updateDLTQualityCard('dlt3d', meanMm, n, 'mm', 30);
    }
}

window.update3DDLTResultsDisplay = update3DDLTResultsDisplay;

// ウィンドウリサイズ時の処理を追加
window.addEventListener('resize', () => {
    if (digitizeCanvas && digitizeCanvas.currentImage) {
        // 動画が読み込まれている場合は表示サイズを再調整
        const container = digitizeCanvas.parentElement;
        const containerWidth = container.offsetWidth - 20; // パディング分を引く
        const containerHeight = container.offsetHeight - 20;

        const videoAspectRatio = digitizeCanvas.currentImage.width / digitizeCanvas.currentImage.height;
        const containerAspectRatio = containerWidth / containerHeight;

        let displayWidth, displayHeight;

        if (containerAspectRatio > videoAspectRatio) {
            // コンテナの方が横長 → 高さ基準でサイズ決定
            displayHeight = containerHeight;
            displayWidth = displayHeight * videoAspectRatio;
        } else {
            // コンテナの方が縦長 → 幅基準でサイズ決定
            displayWidth = containerWidth;
            displayHeight = displayWidth / videoAspectRatio;
        }

        digitizeCanvas.style.width = displayWidth + 'px';
        digitizeCanvas.style.height = displayHeight + 'px';
    }
});

// ============================================================================
// ステレオキャリブレーション誤差グラフ (Plotly)
// ============================================================================
function displayStereoCalibrationErrorChart(stereoCalib) {
    const containerId = 'stereo-error-chart';
    const container = document.getElementById(containerId);

    // 他のチャートを非表示にする（空白対策）
    const otherChart = document.getElementById('real-length-error-chart');
    if (otherChart) {
        otherChart.style.display = 'none';
    }

    if (!stereoCalib || !container) return;

    // ---- viewErrors の確保 ----
    // 優先1: ネイティブから直接渡されたビューごとのRMS誤差配列
    let viewErrors = (stereoCalib.viewErrors && stereoCalib.viewErrors.length > 0)
        ? stereoCalib.viewErrors
        : null;

    // 優先2: imagePoints1のビュー数が分かる場合は全体rmsを均等配置（概算表示）
    if (!viewErrors) {
        const nViews = stereoCalib.imagePoints1 && stereoCalib.imagePoints1.length > 0
            ? stereoCalib.imagePoints1.length
            : (stereoCalib.samples || 0);
        const rms = (typeof stereoCalib.rms === 'number') ? stereoCalib.rms : null;

        if (nViews > 0 && rms !== null) {
            // 全サンプルで均等（概算）。実際の値はネイティブ側perViewErrors対応後に正確になる
            viewErrors = Array(nViews).fill(rms);
        }
    }

    // データなし
    if (!viewErrors || viewErrors.length === 0) {
        Plotly.purge(containerId);
        container.innerHTML = '<div style="text-align:center; padding:20px; color:#666;">ビューごとの誤差データがありません</div>';
        return;
    }

    const xValues = viewErrors.map((_, i) => `View ${i + 1}`);
    const yValues = viewErrors.map(v => v);

    // 均等フォールバックかどうかで色を変える
    const isApprox = stereoCalib.imagePoints1 && stereoCalib.imagePoints1.length > 0
        && (!stereoCalib.viewErrors || stereoCalib.viewErrors.length === 0);

    const trace = {
        x: xValues,
        y: yValues,
        type: 'bar',
        marker: {
            color: isApprox ? '#7986CB' : '#4CAF50', // 概算は青、正確は緑
            opacity: 0.75,
        },
        name: isApprox ? 'RMS誤差（概算）' : 'RMS誤差',
        hovertemplate: 'View %{x}<br>誤差: %{y:.4f} px<extra></extra>'
    };

    const layout = {
        xaxis: {
            title: 'ビュー番号',
            tickangle: -45,
            automargin: true
        },
        yaxis: {
            title: 'RMS誤差 [px]',
            rangemode: 'tozero'
        },
        margin: { t: isApprox ? 24 : 10, r: 10, b: 30, l: 40 },
        height: 180,
        showlegend: false,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        annotations: isApprox ? [{
            xref: 'paper', yref: 'paper',
            x: 0.5, y: 1.0,
            xanchor: 'center', yanchor: 'bottom',
            text: '※ ビューごとのデータ未取得のため全体RMSを均等表示（概算）',
            showarrow: false,
            font: { size: 9, color: '#888' }
        }] : []
    };

    const config = { responsive: true, displayModeBar: false };

    Plotly.newPlot(containerId, [trace], layout, config);

    // クリックで除外→再キャリブレーション（シングルと同じ挙動）
    container.removeAllListeners?.('plotly_click');
    container.on('plotly_click', (ev) => {
        if (!ev || !ev.points || !ev.points.length) return;
        const pt = ev.points[0];
        const arrayIdx = (typeof pt.pointIndex === 'number') ? pt.pointIndex : pt.pointNumber;
        if (!Number.isFinite(arrayIdx)) return;
        const rms = viewErrors[arrayIdx];
        const ok = window.confirm(
            `ビュー #${arrayIdx + 1} (RMS=${Number(rms).toFixed(4)} px) を\n` +
            `ステレオキャリブレーションから除外して再計算しますか？`
        );
        if (!ok) return;
        if (typeof window.excludeStereoViewAndRecompute === 'function') {
            window.excludeStereoViewAndRecompute(arrayIdx);
        }
    });
}

// グローバルスコープに公開
window.displayStereoCalibrationErrorChart = displayStereoCalibrationErrorChart;