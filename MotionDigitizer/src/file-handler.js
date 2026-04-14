/**
 * file-handler.js - ファイル処理・入出力モジュール
 * MotionDigitizer v1.0
 * 
 * 責任範囲:
 * - 動画ファイルの選択・読み込み
 * - OpenCVとの連携処理
 * - 各種形式でのエクスポート
 * - プロジェクトファイル操作
 */

// ファイル処理・入出力モジュール初期化

var ipcRenderer = (window && window.ipcRenderer) ? window.ipcRenderer : require('electron').ipcRenderer;
window.ipcRenderer = ipcRenderer;


const path = require('path');

// ファイル選択状態の管理（グローバル共有）
var fileState = (window && window.fileState) ? window.fileState : {
    'cal-cam1': null,
    'cal-cam2': null,
    'motion-cam1': null,
    'motion-cam2': null
};
window.fileState = fileState;

// 複数ファイル管理（スロットごとの配列）
var fileStateLists = (window && window.fileStateLists) ? window.fileStateLists : {
    'cal-cam1': [],
    'cal-cam2': [],
    'motion-cam1': [],
    'motion-cam2': []
};
window.fileStateLists = fileStateLists;

/**
 * Vicon XCPファイル読込
 */
window.loadViconXcpFile = async function () {
    try {
        const selectRes = await ipcRenderer.invoke('select-xcp-file');
        if (!selectRes || !selectRes.success || !selectRes.filePath) {
            showError('XCPファイルを選択してください');
            return;
        }

        const readRes = await ipcRenderer.invoke('read-text-file', selectRes.filePath);
        if (!readRes || !readRes.success) {
            showError(readRes && readRes.error ? readRes.error : 'XCPファイルの読み込みに失敗しました');
            return;
        }

        const calibration = parseViconXcp(readRes.content || '');
        if (!calibration || !calibration.cameras || !calibration.cameras.length) {
            showError('XCPファイルからカメラ情報を抽出できませんでした');
            return;
        }

        if (!projectData.settings) projectData.settings = {};
        projectData.settings.viconCalibration = calibration;

        window.dispatchEvent(new CustomEvent('vicon-calibration-loaded', { detail: calibration }));
        showMessage(`XCPファイル「${path.basename(selectRes.filePath)}」を読み込みました`);
    } catch (error) {
        showError('XCP読み込みエラー: ' + (error && error.message ? error.message : String(error)));
    }
};

/**
 * Vicon XCP XML文字列を解析してカメラパラメータを抽出
 * @param {string} xmlString
 * @returns {{ cameras: Array }}
 */
function parseViconXcp(xmlString) {
    if (typeof xmlString !== 'string' || !xmlString.trim()) {
        return { cameras: [] };
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');
    const cameraNodes = Array.from(doc.getElementsByTagName('Camera') || []);

    const cameras = cameraNodes.map(camNode => {
        const getAttr = (node, attr, fallback = null) => node && node.getAttribute(attr) != null ? node.getAttribute(attr) : fallback;
        const type = getAttr(camNode, 'DISPLAY_TYPE') || getAttr(camNode, 'TYPE') || '';
        const userId = getAttr(camNode, 'USERID');
        const deviceId = getAttr(camNode, 'DEVICEID');
        const system = getAttr(camNode, 'SYSTEM') || '';

        const keyFrame = camNode.querySelector('KeyFrames > KeyFrame');
        if (!keyFrame) {
            return null;
        }

        const focal = (getAttr(keyFrame, 'FOCAL_LENGTH') || '').split(/\s+/).map(Number);
        const principal = (getAttr(keyFrame, 'PRINCIPAL_POINT') || '').split(/\s+/).map(Number);
        const orientation = (getAttr(keyFrame, 'ORIENTATION') || '').split(/\s+/).map(Number);
        const position = (getAttr(keyFrame, 'POSITION') || '').split(/\s+/).map(Number);
        const radial = (getAttr(keyFrame, 'VICON_RADIAL') || '').split(/\s+/).map(Number);
        const radial2 = (getAttr(keyFrame, 'VICON_RADIAL2') || '').split(/\s+/).map(Number);

        const fx = Number.isFinite(focal[0]) ? focal[0] : null;
        const fy = Number.isFinite(focal[1]) ? focal[1] : fx;
        const cx = Number.isFinite(principal[0]) ? principal[0] : null;
        const cy = Number.isFinite(principal[1]) ? principal[1] : null;

        const cameraMatrix = (fx != null && fy != null && cx != null && cy != null)
            ? [
                [fx, 0, cx],
                [0, fy, cy],
                [0, 0, 1]
            ]
            : null;

        const distCoeffs = buildDistCoeffs(radial, radial2);

        return {
            userId,
            deviceId,
            type,
            system,
            cameraMatrix,
            distCoeffs,
            quaternion: Number.isFinite(orientation[0]) ? orientation : null,
            position: Number.isFinite(position[0]) ? position : null
        };
    }).filter(Boolean);

    return { cameras };
}

function buildDistCoeffs(radial, radial2) {
    const coeffs = [];
    if (Array.isArray(radial) && radial.length >= 2) {
        coeffs.push(radial[0], radial[1]);
    }
    if (Array.isArray(radial2) && radial2.length >= 3) {
        // Vicon3Parameterモデル: principal_point_x, principal_point_y, k1, k2, k3
        // 3つ目以降が歪み係数に相当
        if (Number.isFinite(radial2[2])) coeffs[0] = radial2[2];
        if (Number.isFinite(radial2[3])) coeffs[1] = radial2[3];
        if (Number.isFinite(radial2[4])) coeffs.push(radial2[4]);
    }
    return coeffs.length ? coeffs : null;
}
/**
 * ファイル選択処理
 * @param {string} fileId - ファイルの種類とカメラを示すID
 */
// 画像ファイル判定はui-components.jsのisImageFile()を使用

/**
 * ファイル選択処理（共通ロジック）- 画像ファイル対応
 * @param {string} fileId - ファイルの種類とカメラを示すID
 * @param {Object} fileObj - 選択されたファイルオブジェクト {name, path}
 */
window.processSelectedFile = function (fileId, fileObj) {
    try {
        // 追加保存
        if (!fileStateLists[fileId]) fileStateLists[fileId] = [];
        fileStateLists[fileId].push(fileObj);
        // 直ちに選択反映
        fileState[fileId] = fileObj;

        // UIを更新
        updateFileSelectionUI();
        updateFileListUI(fileId);

        // 選択状態のスタイルを適用
        const fileItem = document.getElementById(fileId);
        if (fileItem) {
            const button = fileItem.querySelector('.file-button');
            if (button) {
                // ボタン表示は常に「ファイル追加」のまま
                button.textContent = 'ファイル追加';
                button.classList.add('selected');
            }
            fileItem.classList.add('selected');
        }

        // ファイルIDからモードを判定
        const mode = fileId.startsWith('cal-') ? 'calibration' : 'motion';

        // 画像ファイルの場合
        if (isImageFile(fileObj.path)) {
            // 画像はフレーム数1として扱う
            if (mode === 'calibration') {
                projectData.settings.calibrationFrameCount = 1;
            } else {
                projectData.settings.motionFrameCount = 1;
            }
            projectData.settings.currentFrame = 1;

            // 動画切り替え処理
            switchVideoByMode(mode);

            // ワークフローステップを更新
            updateWorkflowSteps();

            // 条件チェックして動画反映
            applyVideoIfConditionsMet();

            showMessage(`画像ファイル「${fileObj.name}」を追加しました`);
            return;
        }

        // 動画ファイルの場合: 動画情報を即座に取得・表示（新規追加時はキャッシュクリア）
        _videoInfoCache.delete(fileObj.path);
        getVideoInfoRobust(fileObj.path).then(async info => {

            // 必須検証
            if (typeof info.fps !== 'number' || typeof info.frameCount !== 'number') {
                throw new Error('動画情報取得に失敗しました（fps/frameCount 不正）');
            }

            // 直接フレーム数を設定
            if (mode === 'calibration') {
                projectData.settings.calibrationFrameCount = info.frameCount;
            } else {
                projectData.settings.motionFrameCount = info.frameCount;
            }

            // 動画切り替え処理を追加
            switchVideoByMode(mode);
        }).catch(error => {
            console.error('動画情報取得エラー:', error);
        });

        // ワークフローステップを更新
        updateWorkflowSteps();

        // 条件チェックして動画反映
        applyVideoIfConditionsMet();

        showMessage(`ファイル「${fileObj.name}」を追加しました`);
    } catch (error) {
        console.error('ファイル処理エラー:', error);
        showError('ファイル処理エラー: ' + error.message);
    }
};

/**
 * ファイル選択処理
 * @param {string} fileId - ファイルの種類とカメラを示すID
 */
window.selectFile = async function (fileId) {
    try {
        const result = await ipcRenderer.invoke('select-video-file');
        if (result.success) {
            window.processSelectedFile(fileId, result.file);
        } else {
            // キャンセル時は何もしない（エラー表示しないのが一般的だが、元の挙動に合わせるならエラー表示）
            // 元のコードは '動画ファイルを選択してください' と表示していたので踏襲するか、
            // キャンセルはエラーではないので静かに終了するのがベター。
            // ここでは元の挙動を尊重しつつ、キャンセルなら何もしないように変更（UX向上）
            // ただし、明示的なエラーがある場合は表示
            if (result.error && result.error !== 'cancelled') {
                showError('動画ファイルを選択してください');
            }
        }
    } catch (error) {
        console.error('ファイル選択エラー:', error);
        showError('ファイル選択エラー: ' + error.message);
    }
};

// リスト項目クリックで反映
window.applyFileFromList = function (fileId, index) {
    const list = fileStateLists[fileId] || [];
    const file = list[index];
    if (!file) return;
    fileState[fileId] = file;
    updateFileSelectionUI();
    window.updateFileListUI(fileId);
    applyVideoIfConditionsMet();
    showMessage(`ファイル「${file.name}」を反映しました`);
};

/**
 * ファイルリストUIを更新
 */
window.updateFileListUI = function (fileId) {
    // HTMLのIDは "fileId + '-list'" の形式 (例: cal-cam1-list)
    const listContainer = document.getElementById(`${fileId}-list`);
    if (!listContainer) return;

    listContainer.innerHTML = '';
    const rawList = fileStateLists[fileId] || [];

    if (rawList.length === 0) {
        return;
    }

    // 表示直前に重複排除 (UI上での重複を確実に防ぐ)
    const list = [];
    const seenPaths = new Set();

    rawList.forEach(file => {
        if (!file || !file.path) return;
        try {
            // パス正規化して比較（エラー時はそのままのパスを使用）
            const normalized = typeof path !== 'undefined' && path.resolve
                ? path.resolve(file.path).toLowerCase()
                : (file.path.toLowerCase ? file.path.toLowerCase() : String(file.path));

            if (!seenPaths.has(normalized)) {
                seenPaths.add(normalized);
                list.push(file);
            }
        } catch (e) {
            // パス解決エラー時などはとりあえず追加しとく（消えるよりマシ）
            console.warn('Path normalization error in UI update:', e);
            if (!seenPaths.has(file.path)) {
                seenPaths.add(file.path);
                list.push(file);
            }
        }
    });

    list.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-list-item';

        // 選択中のファイルかどうか
        const currentFile = fileState[fileId];
        // 厳密比較またはパス比較
        const isActive = (currentFile === file) || (currentFile && currentFile.path === file.path);

        if (isActive) {
            item.classList.add('active');
        }

        // 最適化済みかどうかを確認（ファイル名に_proxyが含まれるか）
        const isOptimized = file.path && file.path.includes('_proxy.mp4');

        let html = `
            <span class="file-name" title="${file.path || ''}">${file.name || 'ファイル'}</span>
            <div class="file-actions">
                ${isOptimized ? '<span class="optimized-badge" title="最適化済み">⚡</span>' : ''}
                <span class="remove-file" onclick="removeFileFromList('${fileId}', ${index}, event)">×</span>
            </div>
        `;
        item.innerHTML = html;

        // クリックで選択
        item.addEventListener('click', () => {
            window.applyFileFromList(fileId, index);
        });

        // 右クリックメニュー（最適化）
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!isOptimized && typeof showContextMenu === 'function') {
                showContextMenu(e.clientX, e.clientY, [
                    {
                        label: '動画を最適化 (高速化)',
                        click: () => optimizeVideo(fileId, index)
                    }
                ]);
            }
        });

        listContainer.appendChild(item);
    });
};

/**
 * 動画を最適化
 */
async function optimizeVideo(fileId, index) {
    const list = fileStateLists[fileId];
    if (!list || !list[index]) return;

    const fileObj = list[index];

    // 確認
    if (!confirm(`「${fileObj.name}」を最適化しますか？\n\n最適化すると、コマ送りやシークが高速になりますが、変換に数分かかる場合があります。`)) {
        return;
    }

    showMessage('最適化を開始しています...');

    try {
        const result = await ipcRenderer.invoke('create-proxy-video', fileObj.path);
        if (result.success && result.path) {
            // ファイル情報を更新
            fileObj.originalPath = fileObj.path;
            fileObj.path = result.path;
            fileObj.name = result.path.split(/[\\/]/).pop();

            // 現在選択中なら反映
            const current = fileState[fileId];
            if (current && current.originalPath === fileObj.originalPath) {
                fileState[fileId] = fileObj;
                const mode = fileId.startsWith('cal-') ? 'calibration' : 'motion';
                switchVideoByMode(mode);
            }

            window.updateFileListUI(fileId);
            showMessage('最適化が完了しました');
        } else {
            showError(`最適化失敗: ${result.error}`);
        }
    } catch (err) {
        showError(`最適化エラー: ${err.message}`);
    }
}

// コンテキストメニュー表示ヘルパー
function showContextMenu(x, y, items) {
    const existing = document.getElementById('custom-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'custom-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'context-menu-item';
        div.textContent = item.label;
        div.onclick = () => {
            item.click();
            menu.remove();
        };
        menu.appendChild(div);
    });

    document.body.appendChild(menu);

    setTimeout(() => {
        document.addEventListener('click', function closeHandler() {
            menu.remove();
            document.removeEventListener('click', closeHandler);
        });
    }, 100);
}

/**
 * サイドバーから現在選択中の動画を最適化
 */
// 進捗通知を受け取るリスナー（1箇所に統合）
ipcRenderer.on('proxy-progress', (event, { path, percent }) => {
    const progressFill = document.getElementById('optimizeProgressFill');
    const progressText = document.getElementById('optimizeProgressText');
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) progressText.textContent = `${percent}%`;
});

/**
 * 動画ファイル読み込み（メニューから）
 */
window.loadVideo = async function () {
    try {
        const result = await ipcRenderer.invoke('select-video-file');
        if (result.success) {
            fileState[result.file.id] = result.file; // fileStateにファイルを保存

            // UI更新
            const fileItem = document.getElementById(result.file.id);
            if (fileItem) {
                const fileNameEl = fileItem.querySelector('.file-name');
                const filePathEl = fileItem.querySelector('.file-path');
                const button = fileItem.querySelector('.file-button');

                if (fileNameEl) fileNameEl.textContent = result.file.name;
                if (filePathEl) filePathEl.textContent = result.file.path;
                if (button) {
                    button.textContent = 'ファイル追加';
                    button.classList.add('selected');
                }
                fileItem.classList.add('selected');
            }

            // 現在のモードに応じて動画を切り替え
            const currentMode = getCurrentMode();
            if (currentMode === 'calibration') {
                switchVideoByMode('calibration');
            } else if (currentMode === 'motion') {
                switchVideoByMode('motion');
            }

            showMessage(`ファイル「${result.file.name}」を選択しました`);
        } else {
            showError('動画ファイルを選択してください');
        }
    } catch (error) {
        console.error('ファイル選択エラー:', error);
        showError('ファイル選択エラー: ' + error.message);
    }
}

/**
 * モード別動画切り替え機能
 * @param {string} mode - 'calibration' または 'motion'
 */
function switchVideoByMode(mode) {
    const currentCamera = getCurrentCamera();
    // キー生成を修正: 'calibration' → 'cal', 'motion' → 'motion'
    const videoFileKey = mode === 'calibration' ? `cal-${currentCamera}` : `${mode}-${currentCamera}`;
    const videoFile = fileState[videoFileKey];

    // キャリブレーションモードの場合、キャッシュ進捗UIを非表示にする
    if (mode === 'calibration') {
        const cacheContainer = document.getElementById('cacheProgressContainer');
        if (cacheContainer) cacheContainer.style.visibility = 'hidden';
    }

    // モード切り替え時に内部FPSを復元（UIは変更しない）
    const savedFps = mode === 'calibration'
        ? projectData.settings.calibrationFps
        : projectData.settings.motionFps;
    if (typeof savedFps === 'number' && savedFps > 0) {
        projectData.settings.detectedFps = savedFps;
    }

    if (videoFile) {
        showMessage(`${mode === 'calibration' ? 'キャリブレーション' : 'モーション'}動画に切り替え中...`);

        // プレビュープレイヤーに動画を読み込み
        if (previewPlayer) {
            // ファイルパスを file:// URL に正規化（macOS/Windows両対応）
            let p = videoFile.path || '';
            p = normalizeFileUrl(p);
            previewPlayer.loadVideo(p);
        }

        // 動画情報取得を追加
        getVideoInfoRobust(videoFile.path).then(async info => {
            try {
                if (typeof info.fps !== 'number' || typeof info.frameCount !== 'number') {
                    throw new Error('動画情報取得に失敗しました（fps/frameCount 不正）');
                }

                // 条件付きデータクリア（修正版）
                conditionalDataClear(mode);

                // フレーム数設定
                projectData.settings.videoFile = videoFile.path;

                // FPS自動検出（モード別に内部保持、UIは変更しない）
                if (typeof info.fps === 'number' && info.fps > 0) {
                    projectData.settings.detectedFps = info.fps;

                    // モード別FPSを内部保存
                    if (mode === 'calibration') {
                        projectData.settings.calibrationFps = info.fps;
                    } else {
                        projectData.settings.motionFps = info.fps;
                    }

                    // UIのFPSが未設定の場合のみ初期値として設定
                    const fpsEl = document.getElementById('fps');
                    const currentUIFps = fpsEl ? Number(fpsEl.value) : 0;
                    if (!currentUIFps || currentUIFps <= 0 || !Number.isFinite(currentUIFps)) {
                        projectData.settings.fps = info.fps;
                        if (fpsEl) fpsEl.value = info.fps;
                    }
                }

                // モードに応じてフレーム数・解像度を保存
                if (mode === 'calibration') {
                    projectData.settings.calibrationFrameCount = info.frameCount;
                    if (info.width > 0) projectData.settings.calibrationVideoWidth = info.width;
                    if (info.height > 0) projectData.settings.calibrationVideoHeight = info.height;

                    // キャリブレーションモード時は強制的に1フレーム目を表示（goToFrameでUIも同期）
                    projectData.settings.currentFrame = 1;
                    if (typeof window.goToFrame === 'function') {
                        await window.goToFrame(1);
                    } else if (typeof setCurrentFrameNumber === 'function') {
                        setCurrentFrameNumber(1);
                    }

                    // seekVideoToFrame側で強制表示・待機処理を担保したため、
                    // ここでのsetTimeout連打は削除（ログ重複の原因となるため）

                } else {
                    projectData.settings.motionFrameCount = info.frameCount;
                }

                // フレーム番号の調整（モーションモードの場合）
                if (mode === 'motion') {
                    const currentFrame = projectData.settings.currentFrame;
                    const maxFrame = info.frameCount;
                    if (currentFrame > maxFrame && maxFrame > 0) {
                        projectData.settings.currentFrame = 1;
                        if (typeof window.goToFrame === 'function') {
                            window.goToFrame(1);
                        } else {
                            setCurrentFrameNumber(1);
                        }
                    }
                }

                // 現在のフレームを表示（条件満たし時に実行）
                await displayCurrentFrame();
                updateFrameInfo();

                // モーションモードの場合、FFmpegでバッチ抽出を開始
                if (mode === 'motion' && typeof window.startDiskFrameExtraction === 'function') {
                    window.startDiskFrameExtraction(videoFile.path, info.frameCount);
                }

                // データテーブルヘッダーを更新
                if (mode === 'calibration') {
                    if (!document.getElementById('calibration-table-body') || !document.getElementById('calibration-table-body').rows.length) {
                        updateCalibrationDataTable();
                    }
                } else {
                    if (typeof updateMotionDataTableForCurrentCamera === 'function') {
                        updateMotionDataTableForCurrentCamera();
                    } else if (typeof updateMotionDataTable === 'function') {
                        updateMotionDataTable();
                    }
                }

                // モード別のランドマーク初期化
                initializeModeSpecificLandmarks(mode);

                const frameCount = mode === 'calibration' ? projectData.settings.calibrationFrameCount : projectData.settings.motionFrameCount;
                showMessage(`${mode === 'calibration' ? 'キャリブレーション' : 'モーション'}動画に切り替えました (${frameCount}フレーム)`);
            } catch (e) {
                const errorMessage = opencvResult ? (opencvResult.error || e.message || '動画情報の取得に失敗しました') : '動画情報の取得に失敗しました';
                showError('OpenCVで動画情報取得に失敗: ' + errorMessage);
            }
        }).catch(error => {
            if (error.code === 'FILE_NOT_FOUND') {
                // ファイルが存在しない（別PCや移動後など）→ ポップアップなしで UI に表示
                console.warn('動画ファイルが見つかりません:', videoFile.path);
                markFileAsMissing(videoFileKey);
            } else {
                console.error('動画情報取得エラー:', error);
                showError('動画情報取得エラー: ' + error.message);
            }
        });
    } else {
        showMessage(`${mode === 'calibration' ? 'キャリブレーション' : 'モーション'}動画が選択されていません。サイドバーから動画ファイルを選択してください。`);
    }
}

/**
 * モード固有のランドマーク初期化
 * @param {string} mode - 'calibration' または 'motion'
 */
function initializeModeSpecificLandmarks(mode) {
    // 既存の選択を優先的に維持する
    const current = (typeof getSelectedLandmark === 'function') ? getSelectedLandmark() : null;

    if (mode === 'calibration') {
        // セレクタ項目は更新するが、選択は維持
        initializeCalibrationLandmarkSelector();
        const select = document.getElementById('calibration-landmark-select');
        if (current && select) {
            const wanted = String(current.id);
            if (select.querySelector(`option[value="${wanted}"]`)) {
                select.value = wanted;
            }
        }
        // 既存選択が無い場合でも自動選択はしない
    } else {
        // モーションモード: セレクタ項目は更新、選択は維持
        initializeMotionLandmarkSelector();
        const select = document.getElementById('motion-landmark-select');
        if (current && select) {
            const wanted = String(current.id);
            if (select.querySelector(`option[value="${wanted}"]`)) {
                select.value = wanted;
            }
        }
        // 自動で setSelectedLandmark や onMotionLandmarkChange は呼ばない
    }
}

/**
 * 条件が満たされた時に動画を反映する関数
 */
function applyVideoIfConditionsMet() {
    const conditions = checkAllConditionsMet();

    if (conditions.allMet) {
        switchVideoByMode(conditions.mode);
    } else {
        // Canvasをクリア
        clearDigitizeCanvas();
        showMessage(`${conditions.mode === 'calibration' ? 'キャリブレーション' : 'モーション'}動画を表示するには、モード、カメラ、動画の全てを選択してください。`);
    }
}

/**
 * 全ての条件が満たされているかチェックする関数
 */
function checkAllConditionsMet() {
    const currentMode = getCurrentMode();
    const currentCamera = getCurrentCamera();
    const videoFileKey = currentMode === 'calibration' ? `cal-${currentCamera}` : `${currentMode}-${currentCamera}`;
    const videoFile = fileState[videoFileKey];

    // モーション動画の場合は、キャリブレーション動画の選択を条件としない
    if (currentMode === 'motion') {
        return {
            mode: currentMode,
            camera: currentCamera,
            videoFile: videoFile,
            allMet: !!(currentMode && currentCamera && videoFile)
        };
    }

    // キャリブレーション動画の場合は従来通り
    return {
        mode: currentMode,
        camera: currentCamera,
        videoFile: videoFile,
        allMet: !!(currentMode && currentCamera && videoFile)
    };
}

/**
 * ファイル選択UIの更新
 */
function updateFileSelectionUI() {
    // キャリブレーション動画（カメラ1）
    const calCam1Element = document.getElementById('cal-cam1');
    if (calCam1Element) {
        updateFileUIElement(calCam1Element, fileState['cal-cam1']);
        window.updateFileListUI('cal-cam1');
    }

    // キャリブレーション動画（カメラ2）
    const calCam2Element = document.getElementById('cal-cam2');
    if (calCam2Element) {
        updateFileUIElement(calCam2Element, fileState['cal-cam2']);
        window.updateFileListUI('cal-cam2');
    }

    // モーション動画（カメラ1）
    const motionCam1Element = document.getElementById('motion-cam1');
    if (motionCam1Element) {
        updateFileUIElement(motionCam1Element, fileState['motion-cam1']);
        window.updateFileListUI('motion-cam1');
    }

    // モーション動画（カメラ2）
    const motionCam2Element = document.getElementById('motion-cam2');
    if (motionCam2Element) {
        updateFileUIElement(motionCam2Element, fileState['motion-cam2']);
        window.updateFileListUI('motion-cam2');
    }
}

/**
 * 個別ファイルUI要素の更新
 * @param {HTMLElement} element - 更新対象の要素
 * @param {Object} fileData - ファイルデータ
 */
/**
 * 個別ファイルUI要素の更新
 * @param {HTMLElement} element - 更新対象の要素
function updateFileUIElement(element, fileData) {
    const fileNameSpan = element.querySelector('.file-name');
    const filePathSpan = element.querySelector('.file-path');

    if (fileNameSpan && filePathSpan) {
        if (fileData) {
            let name = '';
            let pathStr = '';

            const extractName = (p) => {
                if (!p) return '';
                return p.split(/[/\\]/).pop(); 
            };

            if (typeof fileData === 'string') {
                pathStr = fileData;
                name = (window.path && window.path.basename) ? window.path.basename(pathStr) : extractName(pathStr);
            } else {
                pathStr = fileData.path || '';
                name = fileData.name || ((pathStr && window.path && window.path.basename) ? window.path.basename(pathStr) : extractName(pathStr));
            }

            fileNameSpan.textContent = name;
            filePathSpan.textContent = pathStr;
        } else {
            fileNameSpan.textContent = 'ファイル未選択';
            filePathSpan.textContent = 'クリックして選択';
        }
    }
}

/**
 * 絶対パスをプロジェクトファイル基準の相対パスに変換
 * 異なるドライブの場合は絶対パスのまま返す（Windows対応）
 */
function toRelativePath(targetPath, saveFilePath) {
    if (!targetPath || typeof targetPath !== 'string') return targetPath;
    if (!path.isAbsolute(targetPath)) return targetPath;
    try {
        const baseDir = path.dirname(saveFilePath);
        const rel = path.relative(baseDir, targetPath);
        // path.relative が絶対パスを返す場合（Windowsで異なるドライブ）は絶対パスのまま
        if (path.isAbsolute(rel)) return targetPath;
        return rel;
    } catch (e) {
        return targetPath;
    }
}

/**
 * 保存データ内の全ファイルパスをプロジェクト基準の相対パスに変換（ディープクローン前提）
 */
function applyRelativePaths(data, saveFilePath) {
    if (!saveFilePath) return data;

    // videoFiles
    if (data.videoFiles) {
        ['calibration', 'motion'].forEach(mode => {
            if (!data.videoFiles[mode]) return;
            ['cam1', 'cam2'].forEach(cam => {
                const file = data.videoFiles[mode][cam];
                if (file && file.path) file.path = toRelativePath(file.path, saveFilePath);
            });
        });
    }
    // videoFileLists
    if (data.videoFileLists) {
        ['calibration', 'motion'].forEach(mode => {
            if (!data.videoFileLists[mode]) return;
            ['cam1', 'cam2'].forEach(cam => {
                const list = data.videoFileLists[mode][cam];
                if (Array.isArray(list)) {
                    list.forEach(file => {
                        if (file && file.path) file.path = toRelativePath(file.path, saveFilePath);
                    });
                }
            });
        });
    }
    // CC法内部パラメータのソースファイル
    if (data.ccFixedInternalParams) {
        ['cam1', 'cam2'].forEach(cam => {
            const params = data.ccFixedInternalParams[cam];
            if (params && params.sourceFile) {
                params.sourceFile = toRelativePath(params.sourceFile, saveFilePath);
            }
        });
    }
    return data;
}

/**
 * プロジェクト保存
 */
function buildProjectDataForSave() {
    // frameData(Map) → プレーンオブジェクト
    const frameDataPlain = {};
    if (projectData.frameData && projectData.frameData.size > 0) {
        for (const [frameKey, pointData] of projectData.frameData.entries()) {
            if (!frameDataPlain[frameKey]) frameDataPlain[frameKey] = {};
            if (pointData && pointData.size > 0) {
                for (const [pointId, coords] of pointData.entries()) {
                    frameDataPlain[frameKey][pointId] = coords;
                }
            }
        }
    }

    const currentMode = getCurrentMode();
    const currentCamera = getCurrentCamera();

    // cameraDigitizeData をプレーン化
    const cameraDigitizeDataPlain = { cam1: {}, cam2: {} };
    try {
        const src = window.cameraDigitizeData || {};
        for (const cam of ['cam1', 'cam2']) {
            const camData = src[cam] || {};
            for (const frameKey of Object.keys(camData)) {
                const perFrame = camData[frameKey];
                if (perFrame && typeof perFrame.get === 'function') {
                    cameraDigitizeDataPlain[cam][frameKey] = Object.fromEntries(perFrame);
                } else {
                    cameraDigitizeDataPlain[cam][frameKey] = perFrame || {};
                }
            }
        }
    } catch (_) { }

    return {
        version: '1.0',
        savedAt: new Date().toISOString(),
        calibrationMethod: document.getElementById('calibration-method').value,
        videoFiles: {
            calibration: { cam1: fileState['cal-cam1'], cam2: fileState['cal-cam2'] },
            motion: { cam1: fileState['motion-cam1'], cam2: fileState['motion-cam2'] }
        },
        videoFileLists: {
            calibration: { cam1: fileStateLists['cal-cam1'], cam2: fileStateLists['cal-cam2'] },
            motion: { cam1: fileStateLists['motion-cam1'], cam2: fileStateLists['motion-cam2'] }
        },
        currentSettings: {
            mode: currentMode,
            camera: currentCamera,
            currentFrame: projectData.settings.currentFrame,
            fps: projectData.settings.fps,
            calibrationVideoWidth: projectData.settings.calibrationVideoWidth || 0,
            calibrationVideoHeight: projectData.settings.calibrationVideoHeight || 0
        },
        calibrationData: { points: calibrationData.points, method: calibrationData.method },
        ccInitialPositions: {
            cam1: {
                x: (document.getElementById('cc-cam1-x')?.value) || (window.projectData?.ccInitialPositions?.cam1?.x ?? ""),
                y: (document.getElementById('cc-cam1-y')?.value) || (window.projectData?.ccInitialPositions?.cam1?.y ?? ""),
                z: (document.getElementById('cc-cam1-z')?.value) || (window.projectData?.ccInitialPositions?.cam1?.z ?? ""),
            },
            cam2: {
                x: (document.getElementById('cc-cam2-x')?.value) || (window.projectData?.ccInitialPositions?.cam2?.x ?? ""),
                y: (document.getElementById('cc-cam2-y')?.value) || (window.projectData?.ccInitialPositions?.cam2?.y ?? ""),
                z: (document.getElementById('cc-cam2-z')?.value) || (window.projectData?.ccInitialPositions?.cam2?.z ?? ""),
            }
        },
        fourPointCalibration: window.projectData?.fourPointCalibration || null,
        cameraCoefficients: projectData.cameraCoefficients,
        cameraCoefficients2D: projectData.cameraCoefficients2D || null,
        cameraCoefficients3D: projectData.cameraCoefficients3D || null,
        calibrationErrorAnalysis: projectData.calibrationErrorAnalysis || null,
        calibrationErrorAnalysis3D: projectData.calibrationErrorAnalysis3D || null,
        stereo2DDLT: projectData.stereo2DDLT || null,
        frameData: frameDataPlain,
        motionPoints: motionPoints,
        analysisResults: {
            coordinates3D: Object.fromEntries(projectData.analysisResults?.coordinates3D || new Map()),
            standardErrors: Object.fromEntries(projectData.analysisResults?.standardErrors || new Map())
        },

        cameraDigitizeData: cameraDigitizeDataPlain,

        // 既知のカメラ内部パラメータ (CC法用)
        ccFixedInternalParams: {
            cam1: window.ccFixedInternalParams1 ? {
                F: window.ccFixedInternalParams1.F,
                U0: window.ccFixedInternalParams1.U0,
                V0: window.ccFixedInternalParams1.V0,
                sourceFile: window.ccFixedInternalParams1.sourceFile || null
            } : null,
            cam2: window.ccFixedInternalParams2 ? {
                F: window.ccFixedInternalParams2.F,
                U0: window.ccFixedInternalParams2.U0,
                V0: window.ccFixedInternalParams2.V0,
                sourceFile: window.ccFixedInternalParams2.sourceFile || null
            } : null
        },

        stereoCalibration: window.projectData.stereoCalibration || null,
        stereoIntrinsics: window.projectData.stereoIntrinsics || null,
        ccCalibration: window.projectData.ccCalibration || null,
        calibration: window.projectData.calibration || null,

        // ChArUco ボード設定（charuco-single / charuco-stereo モードのみ保存）
        charucoBoard: (() => {
            const method = document.getElementById('calibration-method')?.value;
            if (method !== 'charuco-single' && method !== 'charuco-stereo') return null;
            return {
                rows: parseInt(document.getElementById('charuco-rows')?.value, 10) || 5,
                cols: parseInt(document.getElementById('charuco-cols')?.value, 10) || 7,
                squareSizeMm: parseFloat(document.getElementById('charuco-square-mm')?.value) || 165,
                markerSizeMm: parseFloat(document.getElementById('charuco-marker-mm')?.value) || 123,
                dictionary: document.getElementById('charuco-dictionary')?.value || 'DICT_4X4_50'
            };
        })()
    };
}

let _isSaving = false;
window.saveProject = async function () {
    if (_isSaving) {
        console.warn('[SAVE] Save already in progress, skipping');
        return;
    }
    _isSaving = true;
    try {
        const projectDataForSave = buildProjectDataForSave();

        const existingPath = projectData?.settings?.projectPath;
        let savePath = existingPath;

        // 保存先パスを決定（新規保存の場合はダイアログで取得）
        if (!existingPath) {
            const res = await ipcRenderer.invoke('save-file', {
                title: 'プロジェクトを保存',
                filters: [{ name: 'MotionDigitizer Project', extensions: ['mdp'] }]
            });
            if (!res.success || !res.filePath) {
                return false; // キャンセル
            }
            savePath = res.filePath;
        }

        // パスを相対化して保存用データを作成（元データは変更しない）
        const dataToSave = applyRelativePaths(JSON.parse(JSON.stringify(projectDataForSave)), savePath);

        let result;
        if (existingPath) {
            // 既存パスがあれば上書き保存
            // ※ここで dataToSave を渡す
            result = await ipcRenderer.invoke('write-text-file', existingPath, JSON.stringify(dataToSave, null, 2));
            // 互換性のため path を返す
            if (result.success) result.path = existingPath;
        } else {
            // 新規保存（先ほど取得した savePath に書き込み）
            result = await ipcRenderer.invoke('write-text-file', savePath, JSON.stringify(dataToSave, null, 2));
            if (result.success) result.path = savePath;
        }


        if (result.success) {
            showMessage('プロジェクトを保存しました');

            // プロジェクト名表示を更新
            try {
                if (!projectData.settings) projectData.settings = {};
                if (result.path) {
                    projectData.settings.projectPath = result.path;
                    projectData.settings.projectFileName = path.basename(result.path);
                }
                const projectNameEl = document.getElementById('project-name-display');
                if (projectNameEl && projectData.settings.projectFileName) {
                    projectNameEl.textContent = projectData.settings.projectFileName;
                }
            } catch (e) {
                console.error('Error updating project name:', e);
            }

            return true;  // 成功時は true を返す
        } else {
            if (result.error !== 'cancelled') {
                showError('保存に失敗しました: ' + result.error);
            }
            return false;  // 失敗時は false を返す
        }
    } catch (error) {
        console.error('[DEBUG-SAVE] Caught error in saveProject:', error);
        showError('保存エラー: ' + error.message);
        return false;
    } finally {
        _isSaving = false;
    }
}


/**
 * テンプレートとして保存
 */
window.saveProjectAsTemplate = async function () {
    try {
        const projectDataForSave = buildProjectDataForSave();

        // データのディープコピーを作成
        const templateData = JSON.parse(JSON.stringify(projectDataForSave));

        // モーションデータを削除
        // 1. 動画ファイル
        if (templateData.videoFiles) {
            templateData.videoFiles.motion = { cam1: null, cam2: null };
        }
        if (templateData.videoFileLists) {
            templateData.videoFileLists.motion = { cam1: [], cam2: [] };
        }

        // 2. フレームデータ (frameData, cameraDigitizeData)
        templateData.frameData = {};
        templateData.cameraDigitizeData = { cam1: {}, cam2: {} };

        // 3. 分析結果
        templateData.analysisResults = {
            coordinates3D: {},
            standardErrors: {}
        };

        // 4. 設定のリセット
        if (templateData.currentSettings) {
            templateData.currentSettings.currentFrame = 1;
        }

        // Note: motionPoints (ポイント定義) は保持される
        // Note: calibrationData, cameraCoefficients 等も保持される

        // --- 保存先選択 ---
        const res = await ipcRenderer.invoke('save-file', {
            title: 'テンプレートとして保存',
            filters: [{ name: 'MotionDigitizer Project Template', extensions: ['mdp'] }]
        });
        if (!res.success || !res.filePath) {
            return; // キャンセル
        }
        const savePath = res.filePath;

        // --- パスの相対化 ---
        const toRelative = (targetPath, basePath) => {
            if (!targetPath || typeof targetPath !== 'string') return targetPath;
            try {
                if (!path.isAbsolute(targetPath)) return targetPath;
                const baseDir = path.dirname(basePath);
                return path.relative(baseDir, targetPath);
            } catch (e) {
                console.warn('Path conversion error:', e);
                return targetPath;
            }
        };

        // キャリブレーション動画パスを相対化
        if (templateData.videoFiles && templateData.videoFiles.calibration) {
            ['cam1', 'cam2'].forEach(cam => {
                const file = templateData.videoFiles.calibration[cam];
                if (file && file.path) {
                    file.path = toRelative(file.path, savePath);
                }
            });
        }
        if (templateData.videoFileLists && templateData.videoFileLists.calibration) {
            ['cam1', 'cam2'].forEach(cam => {
                const list = templateData.videoFileLists.calibration[cam];
                if (Array.isArray(list)) {
                    list.forEach(file => {
                        if (file && file.path) {
                            file.path = toRelative(file.path, savePath);
                        }
                    });
                }
            });
        }
        // CC法内部パラメータソースファイル
        if (templateData.ccFixedInternalParams) {
            ['cam1', 'cam2'].forEach(cam => {
                const params = templateData.ccFixedInternalParams[cam];
                if (params && params.sourceFile) {
                    params.sourceFile = toRelative(params.sourceFile, savePath);
                }
            });
        }

        // --- ファイル書き込み ---
        const result = await ipcRenderer.invoke('write-text-file', savePath, JSON.stringify(templateData, null, 2));

        if (result.success) {
            showMessage('テンプレートを保存しました');
            // 現在のプロジェクトパスなどは更新しない
        } else {
            showError('保存に失敗しました: ' + result.error);
        }

    } catch (error) {
        console.error('Template save error:', error);
        showError('テンプレート保存エラー: ' + error.message);
    }
};

/**
 * プロジェクト読み込み
 * @param {string} [filePath] - 省略時はダイアログ表示、指定時は直接読み込み
 */
// プロジェクトを開く前の保存確認ダイアログ
function showSaveConfirmBeforeOpen() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background: #1f2937; border-radius: 8px; padding: 1.5rem; max-width: 400px; color: #f3f4f6; box-shadow: 0 4px 20px rgba(0,0,0,0.5); font-family: inherit;';
        dialog.innerHTML = `
            <h3 style="margin: 0 0 1rem 0; font-size: 1.1rem;">プロジェクトの保存確認</h3>
            <p style="margin: 0 0 1.5rem 0; color: #9ca3af;">新しいプロジェクトを開く前に、現在のプロジェクトを保存しますか？</p>
            <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
                <button id="mdOpenCancel" style="padding: 0.5rem 1rem; border: 1px solid #4b5563; background: transparent; color: #f3f4f6; border-radius: 4px; cursor: pointer;">キャンセル</button>
                <button id="mdOpenDiscard" style="padding: 0.5rem 1rem; border: none; background: #ef4444; color: white; border-radius: 4px; cursor: pointer;">保存しない</button>
                <button id="mdOpenSave" style="padding: 0.5rem 1rem; border: none; background: #3b82f6; color: white; border-radius: 4px; cursor: pointer;">保存して開く</button>
            </div>
        `;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        dialog.querySelector('#mdOpenCancel').onclick = () => { document.body.removeChild(overlay); resolve('cancel'); };
        dialog.querySelector('#mdOpenDiscard').onclick = () => { document.body.removeChild(overlay); resolve('discard'); };
        dialog.querySelector('#mdOpenSave').onclick = () => { document.body.removeChild(overlay); resolve('save'); };
    });
}

window.loadProject = async function (filePath) {
    try {
        // 既存プロジェクトがある場合は保存確認を表示
        if (typeof window.hasUnsavedChanges === 'function' && window.hasUnsavedChanges()) {
            const confirmed = await showSaveConfirmBeforeOpen();
            if (confirmed === 'cancel') return;
            if (confirmed === 'save') {
                const saved = await window.saveProject();
                if (!saved) return; // 保存がキャンセルされた場合は中止
            }
        }

        // ★ 既存プロジェクトを完全クリアしてから新プロジェクトを開く
        if (typeof window.clearProjectState === 'function') {
            await window.clearProjectState();
        }
        // ステレオキャリブレーション関連の追加リセット
        try {
            if (window.projectData) {
                window.projectData.stereoCalibration = null;
                window.projectData.stereoIntrinsics = null;
                window.projectData.ccCalibration = null;
            }
            // ステレオキャリブレーション結果UIもリセット
            if (typeof window.updateStereoCalibrationResultUI === 'function') {
                window.updateStereoCalibrationResultUI(null);
            }
        } catch (_) { }

        const result = await ipcRenderer.invoke('load-project-file', filePath);
        if (result.success) {
            const data = result.data;

            // ★重要: データ復元前に既存のファイルリストをクリア（重複防止の根本対策）
            fileStateLists = {
                'cal-cam1': [],
                'cal-cam2': [],
                'motion-cam1': [],
                'motion-cam2': []
            };
            window.fileStateLists = fileStateLists;

            // 追加: プロジェクトパス/ファイル名を保持
            try {
                if (!projectData) window.projectData = {};
                if (!projectData.settings) projectData.settings = {};

                // 重要: 読み込んだファイルのパスを必ず優先してセット
                if (result.path) {
                    projectData.settings.projectPath = result.path;
                    projectData.settings.projectFileName = path.basename(result.path);
                } else {
                    console.warn('[FILE-HANDLER] Warning: load success but no path returned. Keeping existing path:', projectData.settings.projectPath);
                }

                // 相対パス解決ヘルパー
                const resolvePath = (targetPath) => {
                    if (!targetPath || typeof targetPath !== 'string') return targetPath;
                    if (!result.path) return targetPath; // プロジェクトパス不明ならそのまま

                    try {
                        // 絶対パスならそのまま
                        if (path.isAbsolute(targetPath)) return targetPath;

                        // 相対パスを解決
                        const baseDir = path.dirname(result.path);
                        const abs = path.resolve(baseDir, targetPath);
                        return abs;
                    } catch (e) {
                        console.warn('Path resolution error:', e);
                        return targetPath;
                    }
                };

                // プロジェクト名表示を更新
                const projectNameEl = document.getElementById('project-name-display');
                if (projectNameEl) {
                    projectNameEl.textContent = projectData.settings.projectFileName || '新規プロジェクト';
                }
                // CC法内部パラメータのパス解決
                if (data.ccFixedInternalParams) {
                    ['cam1', 'cam2'].forEach(cam => {
                        const params = data.ccFixedInternalParams[cam];
                        if (params && params.sourceFile) {
                            params.sourceFile = resolvePath(params.sourceFile);
                        }
                    });
                }
            } catch (e) {
                console.error('[FILE-HANDLER] Error updating project name / resolving paths:', e);
            }

            // 動画ファイルパスの復元
            if (data.videoFiles) {
                const v = data.videoFiles;

                const restoreFileObj = (val) => {
                    if (!val) return null;

                    const extractName = (p) => {
                        if (!p) return '';
                        // Windows path (backslashes) or Unix path (slashes)
                        return p.split(/[/\\]/).pop();
                    };

                    if (typeof val === 'string') {
                        // 文字列の場合も解決を試みる
                        // プロジェクトのパスが存在し、かつvalが絶対パスでない場合に解決
                        let resolved = val;
                        if (result.path && !path.isAbsolute(val)) {
                            try {
                                resolved = path.resolve(path.dirname(result.path), val);
                            } catch (e) { console.error('Resolve error (string)', e); }
                        }
                        return { name: extractName(resolved), path: resolved };
                    }

                    if (val.path) {
                        // オブジェクト内のパス解決
                        if (result.path && !path.isAbsolute(val.path)) {
                            try {
                                val.path = path.resolve(path.dirname(result.path), val.path);
                            } catch (e) { console.error('Resolve error (obj)', e); }
                        }

                        if (!val.name || val.name.trim() === '') {
                            val.name = extractName(val.path);
                        }
                    }
                    return val;
                };

                if (v.calibration) {
                    fileState['cal-cam1'] = restoreFileObj(v.calibration.cam1);
                    fileState['cal-cam2'] = restoreFileObj(v.calibration.cam2);
                }
                if (v.motion) {
                    fileState['motion-cam1'] = restoreFileObj(v.motion.cam1);
                    fileState['motion-cam2'] = restoreFileObj(v.motion.cam2);
                }

            }

            // 動画ファイルリストの復元 (存在する場合)
            if (data.videoFileLists) {
                const vl = data.videoFileLists;

                const resolveListFile = (file) => {
                    if (!file || !file.path) return file;
                    // リスト内のパス解決
                    if (result.path && !path.isAbsolute(file.path)) {
                        try {
                            file.path = path.resolve(path.dirname(result.path), file.path);
                        } catch (e) { console.error(e); }
                    }
                    return file;
                };

                if (vl.calibration) {
                    fileStateLists['cal-cam1'] = (vl.calibration.cam1 || []).map(resolveListFile);
                    fileStateLists['cal-cam2'] = (vl.calibration.cam2 || []).map(resolveListFile);
                }
                if (vl.motion) {
                    fileStateLists['motion-cam1'] = (vl.motion.cam1 || []).map(resolveListFile);
                    fileStateLists['motion-cam2'] = (vl.motion.cam2 || []).map(resolveListFile);
                }
            }

            // リスト内の重複排除処理 (ロード時点ですでに重複している場合の対策)
            ['cal-cam1', 'cal-cam2', 'motion-cam1', 'motion-cam2'].forEach(key => {
                if (fileStateLists[key] && fileStateLists[key].length > 1) {
                    const uniqueList = [];
                    const seenPaths = new Set();

                    fileStateLists[key].forEach(file => {
                        if (!file || !file.path) return;
                        // パスを正規化して比較キーとする
                        const normalized = path.resolve(file.path).toLowerCase();
                        if (!seenPaths.has(normalized)) {
                            seenPaths.add(normalized);
                            uniqueList.push(file);
                        }
                    });
                    fileStateLists[key] = uniqueList;
                }
            });

            // フォールバック: リストが空だがファイルが選択されている場合 (古いプロジェクトデータの互換性)
            // または、選択中のファイルがリストに含まれていない場合の救済措置
            // ※ファイル名でも重複チェック（Google Driveマウント変更対応）
            ['cal-cam1', 'cal-cam2', 'motion-cam1', 'motion-cam2'].forEach(key => {
                const currentFile = fileState[key];

                if (currentFile && currentFile.path) {
                    if (!fileStateLists[key]) fileStateLists[key] = [];

                    const currentNormalized = path.resolve(currentFile.path).toLowerCase();
                    const currentFileName = path.basename(currentFile.path).toLowerCase();

                    let exactPathMatch = false;
                    let sameFileNameIndex = -1;

                    fileStateLists[key].forEach((f, idx) => {
                        if (!f.path) return;
                        const listNormalized = path.resolve(f.path).toLowerCase();
                        const listFileName = path.basename(f.path).toLowerCase();

                        if (listNormalized === currentNormalized) {
                            exactPathMatch = true;
                        } else if (listFileName === currentFileName && sameFileNameIndex === -1) {
                            sameFileNameIndex = idx;
                        }
                    });

                    if (exactPathMatch) {
                        // 既に同じパスで存在 → 何もしない
                    } else if (sameFileNameIndex !== -1) {
                        // 同じファイル名で異なるパス → 現在のパスに更新
                        fileStateLists[key][sameFileNameIndex] = currentFile;
                    } else {
                        // 完全に新しいファイル → 追加
                        fileStateLists[key].push(currentFile);
                    }
                }
            });

            // UI反映
            if (typeof updateFileSelectionUI === 'function') {
                updateFileSelectionUI();
            }

            // キャリブレーションデータ（ChArUcoポイント）の復元
            if (data.calibrationData) {
                if (!window.calibrationData) window.calibrationData = { points: [], method: null };
                window.calibrationData.points = data.calibrationData.points || [];
                window.calibrationData.method = data.calibrationData.method || null;
            }

            // モーションポイントの復元
            if (data.motionPoints) {
                window.motionPoints = data.motionPoints || [];
                if (typeof window.updateLandmarkSelectorVisibility === 'function') {
                    window.updateLandmarkSelectorVisibility();
                }
            }

            // カメラ係数の復元
            if (data.cameraCoefficients) {
                projectData.cameraCoefficients = data.cameraCoefficients;
            }
            // 2D DLTカメラ係数の復元
            if (data.cameraCoefficients2D) {
                projectData.cameraCoefficients2D = data.cameraCoefficients2D;
            }
            // 3D DLTカメラ係数の復元
            if (data.cameraCoefficients3D) {
                projectData.cameraCoefficients3D = data.cameraCoefficients3D;
            }
            // 誤差分析データの復元
            if (data.calibrationErrorAnalysis) {
                projectData.calibrationErrorAnalysis = data.calibrationErrorAnalysis;
            }
            if (data.calibrationErrorAnalysis3D) {
                projectData.calibrationErrorAnalysis3D = data.calibrationErrorAnalysis3D;
            }
            // ステレオ結合結果の復元
            if (data.stereo2DDLT) {
                projectData.stereo2DDLT = data.stereo2DDLT;
            }

            // 分析結果の復元
            if (data.analysisResults) {
                projectData.analysisResults = {
                    coordinates3D: new Map(Object.entries(data.analysisResults.coordinates3D || {})),
                    standardErrors: new Map(Object.entries(data.analysisResults.standardErrors || {}))
                };
            }

            // FPS設定を復元
            const fpsVal = data.fps || (data.currentSettings && data.currentSettings.fps) || (data.settings && data.settings.fps);
            if (fpsVal) {
                const fpsEl = document.getElementById('fps');
                if (fpsEl) {
                    fpsEl.value = fpsVal;
                    fpsEl.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (!projectData.settings) projectData.settings = {};
                projectData.settings.fps = fpsVal;
            }

            // キャリブレーション方法を復元
            (function restoreCalibrationMethodUI() {
                const methodSelect = document.getElementById('calibration-method');
                if (!methodSelect) return;

                const method = data.calibrationMethod || (data.settings && data.settings.calibrationMethod);
                if (method) {
                    methodSelect.value = method;
                    // changeイベントを発火させてrenderer.js側の handleCalibrationMethodChange / toggleCalibrationPanels 等を呼び出す
                    methodSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
                updateCameraRequirementUI();
            })();

            // ChArUcoボード設定の復元（charuco-single / charuco-stereo モードのみ）
            if (data.charucoBoard) {
                const cb = data.charucoBoard;
                const setVal = (id, v) => {
                    const el = document.getElementById(id);
                    if (el && v !== undefined && v !== null) el.value = v;
                };
                setVal('charuco-rows', cb.rows);
                setVal('charuco-cols', cb.cols);
                setVal('charuco-square-mm', cb.squareSizeMm);
                setVal('charuco-marker-mm', cb.markerSizeMm);
                setVal('charuco-dictionary', cb.dictionary);
            }

            // DLT結果表示の復元
            setTimeout(() => {
                try {
                    // ステレオモードの復元
                    if (projectData.cameraCoefficients2D && typeof window.update2DDLTResultsDisplayStereo === 'function') {
                        const coeffs2d = projectData.cameraCoefficients2D;
                        const errors = projectData.calibrationErrorAnalysis || {};
                        if (coeffs2d.cam1) window.update2DDLTResultsDisplayStereo(coeffs2d.cam1, errors.cam1 || null, 'cam1');
                        if (coeffs2d.cam2) window.update2DDLTResultsDisplayStereo(coeffs2d.cam2, errors.cam2 || null, 'cam2');
                    }
                    // シングルカメラモードの復元
                    if (!projectData.cameraCoefficients2D && projectData.cameraCoefficients) {
                        const cam = (typeof window.getCurrentCamera === 'function') ? window.getCurrentCamera() : 'cam1';
                        const coeffs = projectData.cameraCoefficients[cam] || projectData.cameraCoefficients.cam1;
                        const errors = projectData.calibrationErrorAnalysis || {};
                        const errorData = errors[cam] || errors.cam1 || null;
                        if (coeffs) {
                            // カメラ定数タブの表示更新
                            if (typeof window.update2DDLTResultsDisplayStereo === 'function') {
                                window.update2DDLTResultsDisplayStereo(coeffs, errorData, 'cam1');
                            }
                            // 較正状態の表示更新
                            if (typeof window.updateCalibrationDisplay === 'function') {
                                window.updateCalibrationDisplay(coeffs, errorData);
                            }
                        }
                    }
                    // 3D DLTモードの復元
                    if (projectData.calibrationErrorAnalysis3D && typeof window.update3DDLTResultsDisplay === 'function') {
                        // 3D DLT結果オブジェクトを再構築
                        const err3d = projectData.calibrationErrorAnalysis3D;
                        const res3d = {
                            success: true,
                            standardError: err3d.standardError,
                            pointCount: err3d.pointCount,
                            coefficients: projectData.cameraCoefficients3D,
                            meanError: err3d.meanError,
                            maxError: err3d.maxError
                            // 各点の誤差は calibrationData.points[].errors に保存・復元されている前提
                        };
                        window.update3DDLTResultsDisplay(res3d);
                    }
                } catch (e) {
                    console.error('[FILE-HANDLER] DLT results display restore error:', e);
                }
            }, 500);

            // UI設定の復旧
            if (data.currentSettings) {
                // キャリブ動画解像度の復元
                if (data.currentSettings.calibrationVideoWidth > 0)
                    projectData.settings.calibrationVideoWidth = data.currentSettings.calibrationVideoWidth;
                if (data.currentSettings.calibrationVideoHeight > 0)
                    projectData.settings.calibrationVideoHeight = data.currentSettings.calibrationVideoHeight;

                const { mode, camera, currentFrame } = data.currentSettings;
                if (mode && typeof window.setCurrentMode === 'function') {
                    window.setCurrentMode(mode);
                }
                if (camera && typeof window.setCurrentCamera === 'function') {
                    window.setCurrentCamera(camera);
                }
                if (currentFrame !== undefined) {
                    if (!projectData.settings) projectData.settings = {};
                    projectData.settings.currentFrame = currentFrame;
                }

                // モード別のセレクタを初期化
                if (mode === 'motion' && typeof window.initializeMotionLandmarkSelector === 'function') {
                    window.initializeMotionLandmarkSelector();
                } else if (mode === 'calibration' && typeof window.initializeCalibrationLandmarkSelector === 'function') {
                    window.initializeCalibrationLandmarkSelector();
                }
            }

            // カメラデジタイズデータを復元
            if (data.cameraDigitizeData) {
                const deserialize = (src) => {
                    const out = { cam1: {}, cam2: {} };
                    ['cam1', 'cam2'].forEach(cam => {
                        const frames = src[cam] || {};
                        Object.keys(frames).forEach(frame => {
                            const byPoint = frames[frame] || {};
                            const map = new Map();
                            Object.keys(byPoint).forEach(pid => {
                                const c = byPoint[pid];
                                if (c && typeof c.x === 'number' && typeof c.y === 'number') {
                                    map.set(Number(pid), { x: Number(c.x), y: Number(c.y) });
                                }
                            });
                            // データが存在する場合のみ保存
                            if (map.size > 0) {
                                out[cam][frame] = map;
                            }
                        });
                    });
                    return out;
                };
                window.cameraDigitizeData = deserialize(data.cameraDigitizeData);
            } else if (data.frameData) {
                // 旧形式（frameData）後方互換: cam1 に割当て
                const mapOut = {};
                const frames = data.frameData || {};
                Object.keys(frames).forEach(frameKey => {
                    const perPoint = frames[frameKey] || {};
                    const map = new Map();
                    Object.keys(perPoint).forEach(pid => {
                        const c = perPoint[pid];
                        if (c && typeof c.x === 'number' && typeof c.y === 'number') {
                            map.set(Number(pid), { x: Number(c.x), y: Number(c.y) });
                        }
                    });
                    // データが存在する場合のみ保存
                    if (map.size > 0) {
                        mapOut[frameKey] = map;
                    }
                });
                window.cameraDigitizeData = { cam1: mapOut, cam2: {} };
            }

            // 2D DLT ステレオモードの場合、フレーム範囲を自動設定
            const calibMethodForRange = data.calibrationMethod || (data.settings && data.settings.calibrationMethod);
            if (calibMethodForRange === '2d-dlt-stereo' && typeof window.autoPopulateStereoFrameRanges === 'function') {
                setTimeout(() => {
                    window.autoPopulateStereoFrameRanges();
                }, 300);
            }

            // フレームデータを復元（古い形式対応）
            if (data.frameData) {
                projectData.frameData = new Map();
                Object.keys(data.frameData).forEach(frameKey => {
                    const pointData = new Map();
                    Object.keys(data.frameData[frameKey]).forEach(pointId => {
                        pointData.set(pointId, data.frameData[frameKey][pointId]);
                    });
                    projectData.frameData.set(frameKey, pointData);
                });
            }

            // キャリブレーションデータテーブルを確実に更新
            updateCalibrationDataTable();

            // 4点実長換算モードの場合は、適切なポイント名に復元
            const methodSelect = document.getElementById('calibration-method');
            if (methodSelect && methodSelect.value === '4-point') {
                try {
                    if (typeof window.initializeFourPointCalibrationPoints === 'function') {
                        window.initializeFourPointCalibrationPoints();
                    }
                    // 4点UIへ切替（renderer側のUI反映）
                    if (typeof window.applyCalibrationModeUI === 'function') {
                        window.applyCalibrationModeUI();
                    }
                    // 念のため直接非表示（UI反映の保険）
                    try {
                        const btn = document.getElementById('calculate-camera-coefficients');
                        if (btn) btn.style.display = 'none';
                        const ctrls = document.querySelector('.calibration-controls');
                        if (ctrls) ctrls.style.display = 'none';
                    } catch (_) { }
                    // キャリブレーションモードに切替
                    const calRadio = document.getElementById('calibration');
                    if (calRadio) calRadio.checked = true;
                    if (typeof window.setCurrentMode === 'function') window.setCurrentMode('calibration');
                    // 先頭ポイントを選択
                    if (window.calibrationData?.points?.length > 0 && typeof window.setSelectedLandmark === 'function') {
                        window.setSelectedLandmark(window.calibrationData.points[0]);
                        const sel = document.getElementById('calibration-landmark-select');
                        if (sel) sel.value = window.calibrationData.points[0].id;
                    }
                } catch (_) { }
            }

            // 4点実長換算の結果を復元
            try {
                if (data.fourPointCalibration) {
                    if (!window.projectData) window.projectData = {};
                    window.projectData.fourPointCalibration = data.fourPointCalibration;
                    if (typeof window.updateFourPointResultsDisplay === 'function') {
                        window.updateFourPointResultsDisplay(data.fourPointCalibration);
                    }
                }
            } catch (_) { }

            // （処理位置移動: updateUI後に実行）

            // UIを更新
            updateUI();
            redrawCanvas();

            // CC法のカメラ初期位置を復元（UI更新後に実行）
            if (data.ccInitialPositions) {
                window.projectData.ccInitialPositions = data.ccInitialPositions;

                const setValue = (id, val) => {
                    const el = document.getElementById(id);
                    if (el && val !== undefined && val !== null) {
                        el.value = val;
                        // changeイベントを発火させてprojectDataへの同期を確実にする
                        el.dispatchEvent(new Event('change'));
                    } else {
                        console.warn(`[Load] Element not found or value invalid: ${id}`, val);
                    }
                };
                try {
                    setTimeout(() => {
                        setValue('cc-cam1-x', data.ccInitialPositions.cam1?.x);
                        setValue('cc-cam1-y', data.ccInitialPositions.cam1?.y);
                        setValue('cc-cam1-z', data.ccInitialPositions.cam1?.z);
                        setValue('cc-cam2-x', data.ccInitialPositions.cam2?.x);
                        setValue('cc-cam2-y', data.ccInitialPositions.cam2?.y);
                        setValue('cc-cam2-z', data.ccInitialPositions.cam2?.z);
                    }, 1000);
                } catch (e) { console.error('Error restoring CC positions', e); }
            }

            // 既知のカメラ内部パラメータを復元 (CC法用)
            if (data.ccFixedInternalParams) {
                let restoredCount = 0;

                if (data.ccFixedInternalParams.cam1) {
                    window.ccFixedInternalParams1 = data.ccFixedInternalParams.cam1;
                    restoredCount++;

                    // UI更新
                    setTimeout(() => {
                        const statusEl = document.getElementById('cc-internal-params-status-cam1');
                        const clearBtn = document.getElementById('cc-clear-internal-params-cam1');
                        if (statusEl) {
                            const fileName = data.ccFixedInternalParams.cam1.sourceFile
                                ? data.ccFixedInternalParams.cam1.sourceFile.split(/[\\/]/).pop()
                                : 'パラメータ適用中';
                            statusEl.textContent = `Cam1: ${fileName} (復元済)`;
                            statusEl.style.color = '#2e7d32'; // 緑色にして復元を強調
                        } else {
                            console.warn('[Load] UI Element not found: cc-internal-params-status-cam1');
                        }
                        if (clearBtn) clearBtn.style.display = 'inline-block';
                    }, 500);
                }

                if (data.ccFixedInternalParams.cam2) {
                    window.ccFixedInternalParams2 = data.ccFixedInternalParams.cam2;
                    restoredCount++;

                    // UI更新
                    setTimeout(() => {
                        const statusEl = document.getElementById('cc-internal-params-status-cam2');
                        const clearBtn = document.getElementById('cc-clear-internal-params-cam2');
                        if (statusEl) {
                            const fileName = data.ccFixedInternalParams.cam2.sourceFile
                                ? data.ccFixedInternalParams.cam2.sourceFile.split(/[\\/]/).pop()
                                : 'パラメータ適用中';
                            statusEl.textContent = `Cam2: ${fileName} (復元済)`;
                            statusEl.style.color = '#2e7d32';
                        } else {
                            console.warn('[Load] UI Element not found: cc-internal-params-status-cam2');
                        }
                        if (clearBtn) clearBtn.style.display = 'inline-block';
                    }, 500);
                }

                if (restoredCount > 0) {
                    if (typeof showMessage === 'function') {
                        setTimeout(() => showMessage(`内部パラメータを復元しました (${restoredCount}台)`), 1000);
                    }
                }
            }

            // CC法キャリブレーション結果の復元
            if (data.ccCalibration) {
                if (!window.projectData) window.projectData = {};
                window.projectData.ccCalibration = data.ccCalibration;

                // UIテーブルの更新
                // 少し遅延させてUI構築完了を待つ
                setTimeout(() => {
                    if (typeof window.displayCCMethodResults === 'function') {
                        window.displayCCMethodResults({
                            success: true,
                            ...data.ccCalibration
                        });

                        // ログにも表示
                        if (typeof showMessage === 'function') {
                            showMessage(`CC法キャリブレーション結果を復元しました (RMS: ${data.ccCalibration.errorStats?.rms?.toFixed(3) || '-'})`);
                        }
                    } else {
                        console.warn('[Load] displayCCMethodResults function not found');
                    }
                }, 1000);
            }

            // ステレオパラメータとキャリブレーション結果の復元（追加）
            // キャリブレーション方法を確認（ステレオモードの場合のみUI更新）
            const calibMethod = data.calibrationMethod || (data.settings && data.settings.calibrationMethod);
            const isStereoMethod = ['charuco-stereo', '2d-dlt-stereo', '3d-dlt', '3d-cc-method'].includes(calibMethod);

            if (data.stereoIntrinsics) {
                if (!window.projectData) window.projectData = {};
                window.projectData.stereoIntrinsics = data.stereoIntrinsics;
            }
            if (data.stereoCalibration) {
                if (!window.projectData) window.projectData = {};
                window.projectData.stereoCalibration = data.stereoCalibration;
                if (isStereoMethod) {
                    setTimeout(() => {
                        if (typeof window.updateStereoCalibrationResultUI === 'function') {
                            window.updateStereoCalibrationResultUI(window.projectData.stereoCalibration);
                        }
                        if (typeof window.updateIntrinsicStatus === 'function') {
                            window.updateIntrinsicStatus();
                        }
                    }, 200);
                }
            }
            if (data.calibration) {
                if (!window.projectData) window.projectData = {};
                window.projectData.calibration = data.calibration;
                if (calibMethod === 'charuco-single') {
                    // C++バッファ復元（点群データがあれば除外再計算を可能にする）
                    const calib = data.calibration;
                    if (calib.allImagePoints && calib.allImagePoints.length > 0 &&
                        calib.allObjectPoints && calib.allObjectPoints.length > 0) {
                        ipcRenderer.invoke('restore-calibration-buffers', {
                            allImagePoints: calib.allImagePoints,
                            allObjectPoints: calib.allObjectPoints,
                            cornerCounts: calib.cornerCounts || [],
                            markerCounts: calib.markerCounts || [],
                            frameNumbers: calib.frameNumbers || [],
                            imageWidth: calib.imageWidth || projectData.settings.calibrationVideoWidth || 1920,
                            imageHeight: calib.imageHeight || projectData.settings.calibrationVideoHeight || 1080
                        }).catch(e => console.warn('[LOAD] Frame extraction start failed:', e.message)); // 失敗してもロード自体は続行
                    }

                    setTimeout(() => {
                        if (typeof window.updateCalibrationResultUI === 'function') {
                            window.updateCalibrationResultUI(window.projectData.calibration);
                        }
                        if (typeof window.populateExtrinsicViewSelect === 'function') {
                            window.populateExtrinsicViewSelect(window.projectData.calibration);
                        }
                        if (typeof window.updateExtrinsicResultUI === 'function') {
                            window.updateExtrinsicResultUI(window.projectData.calibration, 0);
                        }
                        if (typeof window.buildCharucoTable === 'function') {
                            window.buildCharucoTable(window.projectData.calibration, 'charuco-table-body-cam1');
                        }
                        if (typeof window.updateErrorBarChart === 'function' && window.projectData.calibration.viewErrors && window.projectData.calibration.viewErrors.length > 0) {
                            window.updateErrorBarChart(window.projectData.calibration.viewErrors, 'charuco-error-chart-cam1', 'ビュー毎RMS誤差 (Cam1)');
                        }
                    }, 300);
                }
            }
            if (data.ccCalibration) {
                if (!window.projectData) window.projectData = {};
                window.projectData.ccCalibration = data.ccCalibration;
            }

            // 最終UI反映後に4点UIを強制適用（4点モードの場合のみ）
            try {
                // キャリブレーションを前面に
                if (typeof window.setCurrentMode === 'function') window.setCurrentMode('calibration');

                // 4点実長換算の場合のみ、UIを強制セットアップ
                if (data.calibrationMethod === '4-point') {
                    const calRadio = document.getElementById('calibration');
                    if (calRadio) calRadio.checked = true;
                    if (typeof window.switchTab === 'function') window.switchTab('calibration');
                    // 4点用UI切替
                    const methodSelect = document.getElementById('calibration-method');
                    if (methodSelect) methodSelect.value = '4-point';
                    if (typeof window.applyCalibrationModeUI === 'function') window.applyCalibrationModeUI();

                    // 直接非表示の保険
                    const btn = document.getElementById('calculate-camera-coefficients');
                    if (btn) btn.style.display = 'none';
                    const ctrls = document.querySelector('.calibration-controls');
                    if (ctrls) ctrls.style.display = 'none';
                    const dlt2d = document.getElementById('dlt2d-results-container');
                    if (dlt2d) dlt2d.style.display = 'none';
                }
            } catch (_) { }

            // 動画切替処理を実行
            applyVideoIfConditionsMet();

            // ファイルリストの表示を確実に更新（非同期で描画待ち）
            setTimeout(() => {
                const keys = ['cal-cam1', 'cal-cam2', 'motion-cam1', 'motion-cam2'];

                keys.forEach(key => {
                    // 安全策: リストが空なら現在のファイルを再プッシュ
                    if (fileState[key] && (!fileStateLists[key] || fileStateLists[key].length === 0)) {
                        console.log(`[FILE-HANDLER] Force pushing file to list for ${key} in final check`);
                        if (!fileStateLists[key]) fileStateLists[key] = [];
                        fileStateLists[key].push(fileState[key]);
                    }

                    // リストUI更新を実行
                    if (typeof window.updateFileListUI === 'function') {
                        try {
                            window.updateFileListUI(key);
                        } catch (e) {
                            console.error('[FILE-HANDLER] Error updating list UI for ' + key, e);
                        }
                    }
                });

                // 選択状態のUIも念のため更新
                if (typeof updateFileSelectionUI === 'function') {
                    updateFileSelectionUI();
                }

                // 念のため再度モードとカメラの設定を適用（ラジオボタンのイベント発火を確実にする）
                if (data.currentSettings) {
                    const { mode, camera } = data.currentSettings;
                    if (mode && typeof window.setCurrentMode === 'function') window.setCurrentMode(mode);
                    if (camera && typeof window.setCurrentCamera === 'function') window.setCurrentCamera(camera);
                }

            }, 100);

            showMessage('プロジェクトを読み込みました');
        } else {
            showError('読み込みに失敗しました: ' + result.error);
        }
    } catch (error) {
        showError('読み込みエラー: ' + error.message);
    }
}

/**
 * .rd形式でエクスポート
 * @param {Object} motionData - モーションデータ
 * @param {string} outputFile - 出力ファイル名
 */
function exportToRdFormat(motionData, outputFile) {
    try {
        const frameCount = motionData.settings.motionFrameCount;
        const fps = motionData.settings.fps;
        const pointCount = motionData.points.length;
        const timeInterval = 1 / fps; // 1フレームの時間間隔

        // 1行目: 総フレーム数,ポイント数,1フレームの時間間隔
        const header = `${frameCount},${pointCount},${timeInterval.toFixed(6)}`;

        // 各フレームの座標データを生成
        const frameLines = [];
        for (let frame = 1; frame <= frameCount; frame++) {
            const frameData = motionData.frameData[frame];
            if (frameData) {
                const coordinates = [];
                // motionPointsの順序に従って座標を取得
                for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
                    const pointData = frameData[pointIndex];
                    if (pointData && pointData.x !== undefined && pointData.y !== undefined) {
                        coordinates.push(pointData.x.toFixed(6), pointData.y.toFixed(6));
                    } else {
                        // データがない場合は0,0で埋める
                        coordinates.push('0.000000', '0.000000');
                    }
                }
                frameLines.push(coordinates.join(','));
            }
        }

        // ファイルに書き込み
        const content = [header, ...frameLines].join('\n');
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = outputFile;
        link.click();

        console.log('✓ .rdファイル出力完了:', outputFile);
        showMessage(`✓ .rdファイル出力完了: ${outputFile}`);

    } catch (error) {
        showError(`✗ .rdファイル出力エラー: ${error.message}`);
    }
}

/**
 * .setファイルの内容を生成（Frame-DIAS形式）
 * @param {Array} points - モーションポイント配列
 * @param {number} fps - フレームレート
 * @returns {string} .setファイルの内容
 */
function generateSetFileContent(points, fps) {
    const lines = [];
    lines.push('Memo=""');
    lines.push('RecInterval=0');
    lines.push(`CameraSpeed=${Math.round(fps)}`);

    // PointNameを生成
    const pointNames = points.map(p => `"${p.name}"`).join(',');
    lines.push(`PointName=${pointNames}`);

    // GroupNumberを生成（1から始まる連番）
    const groupNumbers = points.map((_, index) => index + 1).join(',');
    lines.push(`GroupNumber=${groupNumbers}`);

    return lines.join('\n');
}

/**
 * 実長換算されたデータを.rdファイル形式でエクスポート
 */
function exportMotionDataToRd() {
    // 実長換算データが存在するかチェック
    if (!window.realLengthData || window.realLengthData.length === 0) {
        showError('エクスポートする実長換算データがありません。先に実長換算を実行してください。');
        return;
    }

    try {
        const points = Array.isArray(window.motionPoints) ? window.motionPoints : [];

        // 承認済み: UIのFPS入力値を直前に同期してからdtを計算
        const readFpsFromUI = () => {
            try {
                const el = document.getElementById('fps');
                const v = Number(el && el.value);
                if (Number.isFinite(v) && v > 0) return v;
            } catch (_) { }
            return null;
        };
        const uiFps = readFpsFromUI();
        if (uiFps) {
            if (!projectData.settings) projectData.settings = {};
            projectData.settings.fps = uiFps;
        }
        const fps = Number(projectData?.settings?.fps) || 30;
        const dt = 1 / fps;

        // モード判定（3D= true / 2D= false）
        const methodEl = document.getElementById('calibration-method');
        let is3D = methodEl && methodEl.value === '3d-dlt';
        if (!is3D) {
            is3D = (window.realLengthData || []).some(r => typeof r.z === 'number');
        }

        // flat配列 → frameごとの Map(pointId -> {x,y(,z)})
        const frameMap = new Map();
        (window.realLengthData || []).forEach(r => {
            const f = Number(r.frame);
            if (!frameMap.has(f)) frameMap.set(f, new Map());
            frameMap.get(f).set(String(r.pointId), { x: r.x, y: r.y, z: (typeof r.z === 'number' ? r.z : null) });
        });
        const frames = Array.from(frameMap.keys()).sort((a, b) => a - b);

        const frameCount = frames.length;
        const pointCount = points.length;
        const rows = [`${frameCount},${pointCount},${dt.toFixed(6)}`];
        frames.forEach(frame => {
            const pmap = frameMap.get(frame) || new Map();
            const row = [];
            points.forEach(p => {
                const pd = pmap.get(String(p.id));
                if (pd && typeof pd.x === 'number' && typeof pd.y === 'number') {
                    row.push(pd.x.toFixed(6), pd.y.toFixed(6));
                    if (is3D) row.push((typeof pd.z === 'number' ? pd.z : 0).toFixed(6));
                } else {
                    row.push('0.000000', '0.000000');
                    if (is3D) row.push('0.000000');
                }
            });
            rows.push(row.join(','));
        });
        const content = rows.join('\n');

        // .setファイルの内容を生成
        const setContent = generateSetFileContent(points, fps);

        // 出力先情報（プロジェクトファイル名をデフォルト名として使用）
        const projectPath = projectData?.settings?.projectPath || null;
        const projectFileName = projectData?.settings?.projectFileName || 'project.mdp';
        let defaultPath = 'project.rd'; // フォールバック: プロジェクトファイル名が取得できない場合
        try {
            const dir = projectPath ? path.dirname(projectPath) : null;
            // プロジェクトファイル名から拡張子を除いたベース名を取得
            const base = path.basename(projectFileName, path.extname(projectFileName)) || 'project';
            defaultPath = dir ? path.join(dir, `${base}.rd`) : `${base}.rd`;
        } catch (e) {
            // エラー時もプロジェクトファイル名ベースのデフォルトを使用
            const base = path.basename(projectFileName, path.extname(projectFileName)) || 'project';
            defaultPath = `${base}.rd`;
        }

        // ダイアログ表示して保存
        ipcRenderer.invoke('save-rd-with-dialog', { defaultPath, content, setContent }).then(res => {
            if (res && res.success) {
                let message = `✓ .rd を保存しました: ${res.path}`;
                if (res.setPath) {
                    message += `\n✓ .set を保存しました: ${res.setPath}`;
                }
                showMessage(message);
            } else if (res && res.error === 'cancelled') {
                showMessage('保存をキャンセルしました');
            } else {
                showError('rd保存に失敗しました: ' + (res && res.error ? res.error : 'unknown'));
            }
        }).catch(err => {
            showError('rd保存IPCエラー: ' + err.message);
        });
    } catch (error) {
        showError('実長換算データの.rd(CSV)出力中にエラーが発生しました');
    }
}

/**
 * OpenCVテスト
 */
window.testOpenCVImageProcessing = async function () {
    try {
        const result = await ipcRenderer.invoke('select-image-file');
        if (result.success) {
            showMessage('OpenCVテスト: 画像ファイルを選択しました');
        } else {
            showError('画像ファイルを選択してください');
        }
    } catch (error) {
        showError('OpenCVテストエラー: ' + error.message);
    }
}

// ChArUco検出中フラグ（displayCurrentFrameの割り込み防止）
window.__charucoDetectionInProgress = false;

/**
 * Charuco検出実行
 * ステレオモードの場合は2画面同時検出を行う
 */
window.detectCharucoBoard = async function () {
    // 既に検出中なら何もしない（重複実行防止）
    if (window.__charucoDetectionInProgress) {
        return;
    }
    window.__charucoDetectionInProgress = true;

    try {
        showMessage('Charuco検出を実行中...');

        // 現在のフレーム情報取得
        const currentMode = getCurrentMode();
        const frameNumber = getCurrentFrameNumber();

        // キャリブレーション方法を確認
        const methodSelect = document.getElementById('calibration-method');
        const method = methodSelect ? methodSelect.value : '';
        const isStereo = (method === 'charuco-stereo');

        // UIボード設定値の取得（理論最大とネイティブへの設定渡しに使用）
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

        const maxCornerCountUI = Math.max(0, (rows - 1) * (cols - 1));

        // ボード設定をまとめてネイティブに渡す
        const boardConfig = {
            rows: rows,
            cols: cols,
            squareSizeMm: squareMm,
            markerSizeMm: markerMm,
            dictionary: dictionary,
            legacyPattern: true
        };


        if (isStereo) {
            // ステレオモード: 2画面同時検出
            await detectCharucoBoardStereo(frameNumber, boardConfig, maxCornerCountUI, squareMm, rows, cols);
        } else {
            // 単眼モード: 従来の1画面検出
            await detectCharucoBoardSingle(frameNumber, boardConfig, maxCornerCountUI, squareMm, rows, cols);
        }

    } catch (error) {
        showError('Charuco検出エラー: ' + error.message);
    } finally {
        // 検出完了フラグをリセット
        window.__charucoDetectionInProgress = false;
    }
};

/**
 * 単眼モードでのCharuco検出
 */
async function detectCharucoBoardSingle(frameNumber, boardConfig, maxCornerCountUI, squareMm, rows, cols) {
    const currentMode = getCurrentMode();
    const currentCamera = getCurrentCamera();

    // 動画パス取得
    const videoFileKey = currentMode === 'calibration' ?
        `cal-${currentCamera}` : `${currentMode}-${currentCamera}`;
    const videoFile = fileState[videoFileKey];

    if (!videoFile) {
        showError('動画ファイルが選択されていません');
        return;
    }

    const videoPath = typeof videoFile === 'string' ? videoFile : videoFile.path;

    // 現在表示中のcanvasから画像データを取得（日本語パス問題回避）
    const canvas = document.getElementById('digitize-canvas');
    let imageBase64 = null;
    if (canvas && canvas.currentImage) {
        // currentImage（元の解像度の画像）を使用
        const srcImage = canvas.currentImage;
        console.log('[CHARUCO-RENDERER] Using currentImage:', srcImage.width, 'x', srcImage.height);
        try {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = srcImage.width;
            tempCanvas.height = srcImage.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(srcImage, 0, 0);
            imageBase64 = tempCanvas.toDataURL('image/jpeg', 0.95);
            console.log('[CHARUCO-RENDERER] imageBase64 obtained, length:', imageBase64 ? imageBase64.length : 0);

            // キャリブレーション用に元フレームを保存（検出結果描画前の状態）
            window.__originalFrameBase64 = imageBase64;
            window.__originalFrameNumber = frameNumber;
            console.log('[CHARUCO-RENDERER] Original frame saved for calib-capture');
        } catch (e) {
            console.warn('[CHARUCO-RENDERER] Canvas画像取得失敗:', e);
        }
    } else {
        console.warn('[CHARUCO-RENDERER] Canvas or currentImage not found!');
    }

    // Charuco検出実行（構造化パラメータで呼び出し）
    const result = await ipcRenderer.invoke('detect-charuco-board', {
        videoPath: videoPath,
        frameNumber: frameNumber,
        boardConfig: boardConfig,
        imageBase64: imageBase64  // canvas画像データを渡す
    });

    // ネイティブが返さない場合の補完（UI設定から）
    if (result && result.success) {
        if (!(typeof result.maxCornerCount === 'number' && result.maxCornerCount > 0)) {
            result.maxCornerCount = maxCornerCountUI;
        }
        if (!(typeof result.maxMarkerCount === 'number' && result.maxMarkerCount > 0)) {
            if (rows === 7 && cols === 11) {
                result.maxMarkerCount = 38;
            }
        }
        result.squareSizeMm = squareMm;
        result.boardRows = rows;
        result.boardCols = cols;
    }

    if (result.success) {
        const basicAccepted = isBasicCharucoAccept(result);
        const evalRes = evaluateAutoAccept(result);
        const accepted = basicAccepted;

        logCharucoCoordinates(result);
        await displayCharucoDetectionResult(result, accepted, evalRes);
        updateCharucoStats(result.cornerCount, result.markerCount, result);

        const autoAddOk = (evalRes && evalRes.ok) ? true : basicAccepted;
        maybeAutoAddCalibrationFrame(result, autoAddOk);

        if (evalRes && Array.isArray(evalRes.reasons) && evalRes.reasons.length > 0) {
            showMessage(`判定メモ: ${evalRes.reasons.join(' / ')}`);
        }

        showMessage(`Charuco検出完了: マーカー${result.markerCount}個、コーナー${result.cornerCount}個`);
    } else {
        showError('Charuco検出に失敗: ' + (result.error || '不明なエラー'));
    }
}

/**
 * ステレオモードでのCharuco検出（2画面同時）
 */
async function detectCharucoBoardStereo(frameNumber, boardConfig, maxCornerCountUI, squareMm, rows, cols) {
    const currentMode = getCurrentMode();

    // Cam1とCam2の動画パス取得
    const videoFileKey1 = currentMode === 'calibration' ? 'cal-cam1' : `${currentMode}-cam1`;
    const videoFileKey2 = currentMode === 'calibration' ? 'cal-cam2' : `${currentMode}-cam2`;
    const videoFile1 = fileState[videoFileKey1];
    const videoFile2 = fileState[videoFileKey2];

    if (!videoFile1) {
        showError('Cam1の動画ファイルが選択されていません');
        return;
    }
    if (!videoFile2) {
        showError('Cam2の動画ファイルが選択されていません');
        return;
    }

    const videoPath1 = typeof videoFile1 === 'string' ? videoFile1 : videoFile1.path;
    const videoPath2 = typeof videoFile2 === 'string' ? videoFile2 : videoFile2.path;

    // 現在表示中のcanvasから画像を取得（左半分=Cam1、右半分=Cam2）
    const digitizeCanvas = document.getElementById('digitize-canvas');
    let imageBase64_1 = null;
    let imageBase64_2 = null;

    if (digitizeCanvas && digitizeCanvas.currentImage) {
        const srcImage = digitizeCanvas.currentImage;
        const srcWidth = srcImage.width;
        const srcHeight = srcImage.height;
        const halfWidth = Math.floor(srcWidth / 2);

        console.log('[CHARUCO-STEREO] Using canvas currentImage:', srcWidth, 'x', srcHeight);

        // Cam1: 左半分を切り出し
        try {
            const canvas1 = document.createElement('canvas');
            canvas1.width = halfWidth;
            canvas1.height = srcHeight;
            const ctx1 = canvas1.getContext('2d');
            ctx1.drawImage(srcImage, 0, 0, halfWidth, srcHeight, 0, 0, halfWidth, srcHeight);
            imageBase64_1 = canvas1.toDataURL('image/jpeg', 0.95);
            console.log('[CHARUCO-STEREO] Cam1 (left half) obtained, size:', halfWidth, 'x', srcHeight);
        } catch (e) {
            console.warn('[CHARUCO-STEREO] Cam1画像取得失敗:', e);
        }

        // Cam2: 右半分を切り出し
        try {
            const canvas2 = document.createElement('canvas');
            canvas2.width = srcWidth - halfWidth;
            canvas2.height = srcHeight;
            const ctx2 = canvas2.getContext('2d');
            ctx2.drawImage(srcImage, halfWidth, 0, srcWidth - halfWidth, srcHeight, 0, 0, srcWidth - halfWidth, srcHeight);
            imageBase64_2 = canvas2.toDataURL('image/jpeg', 0.95);
            console.log('[CHARUCO-STEREO] Cam2 (right half) obtained, size:', (srcWidth - halfWidth), 'x', srcHeight);
        } catch (e) {
            console.warn('[CHARUCO-STEREO] Cam2画像取得失敗:', e);
        }
    } else {
        console.warn('[CHARUCO-STEREO] Canvas or currentImage not found!');
    }

    // ステレオキャリブレーション用に元画像を保存
    window.__originalFrameBase64_cam1 = imageBase64_1;
    window.__originalFrameBase64_cam2 = imageBase64_2;
    window.__originalFrameNumber_stereo = frameNumber;
    console.log('[CHARUCO-STEREO] Original frames saved for stereo calib-capture');

    // 両カメラで同時にCharuco検出実行
    const [result1, result2] = await Promise.all([
        ipcRenderer.invoke('detect-charuco-board', {
            videoPath: videoPath1,
            frameNumber: frameNumber,
            boardConfig: { ...boardConfig, isStereo: true },
            imageBase64: imageBase64_1
        }),
        ipcRenderer.invoke('detect-charuco-board', {
            videoPath: videoPath2,
            frameNumber: frameNumber,
            boardConfig: { ...boardConfig, isStereo: true },
            imageBase64: imageBase64_2
        })
    ]);

    // ネイティブが返さない場合の補完（UI設定から）
    [result1, result2].forEach(result => {
        if (result && result.success) {
            if (!(typeof result.maxCornerCount === 'number' && result.maxCornerCount > 0)) {
                result.maxCornerCount = maxCornerCountUI;
            }
            if (!(typeof result.maxMarkerCount === 'number' && result.maxMarkerCount > 0)) {
                if (rows === 7 && cols === 11) {
                    result.maxMarkerCount = 38;
                }
            }
            result.squareSizeMm = squareMm;
            result.boardRows = rows;
            result.boardCols = cols;
        }
    });

    // 検出結果の処理
    const success1 = result1 && result1.success;
    const success2 = result2 && result2.success;

    if (success1 && success2) {
        // 両方成功 - 2画面表示
        const basicAccepted1 = isBasicCharucoAccept(result1);
        const basicAccepted2 = isBasicCharucoAccept(result2);
        const evalRes1 = evaluateAutoAccept(result1);
        const evalRes2 = evaluateAutoAccept(result2);

        // 共通IDを計算（ステレオキャリブレーションの判定基準）
        const ids1 = result1.charucoIds || [];
        const ids2 = result2.charucoIds || [];
        const set1 = new Set(ids1);
        const set2 = new Set(ids2);
        const commonIds = ids1.filter(id => set2.has(id));
        const commonCount = commonIds.length;

        // 追加可能判定: 各カメラでそれぞれコーナー数が6個以上必要
        const requiredCorners = 6;
        const requiredCommon = 6;
        const canAdd = (ids1.length >= requiredCorners) && (ids2.length >= requiredCorners);

        // オーバーレイ情報を更新
        window.__stereoOverlayInfo = {
            commonCount: commonCount,
            required: requiredCommon,
            canAdd: canAdd
        };

        // 両カメラの結果を2画面で表示（共通ID情報も渡す）
        logCharucoCoordinates(result1);
        logCharucoCoordinates(result2);
        await displayCharucoDetectionResultStereo(result1, result2, basicAccepted1, basicAccepted2, commonCount, canAdd);

        // 統計情報は両方表示
        updateCharucoStatsStereo(result1, result2, commonCount);

        // ステレオ検出結果を保存（後でサンプル追加時に使用）
        window.__stereoDetectionResult = {
            cam1: result1,
            cam2: result2,
            frameNumber: frameNumber,
            accepted1: basicAccepted1,
            accepted2: basicAccepted2,
            commonCount: commonCount,
            canAdd: canAdd
        };

        // 両カメラで採用可能かどうかを判定（共通ID数が6以上）
        const bothAccepted = canAdd;

        // 自動追加判定（共通ID数が十分な場合のみ）
        if (bothAccepted) {
            const autoAddOk1 = (evalRes1 && evalRes1.ok) ? true : basicAccepted1;
            const autoAddOk2 = (evalRes2 && evalRes2.ok) ? true : basicAccepted2;
            if (autoAddOk1 && autoAddOk2) {
                // ステレオ用の自動追加（両カメラ同時）
                maybeAutoAddStereoCalibrationFrame(result1, result2);
            }
        }

        const statusMsg = canAdd ? '追加可能' : '追加不可';
        showMessage(`ステレオCharuco検出完了: 共通ID ${commonCount}個 (${statusMsg}) / Cam1(マーカー${result1.markerCount}個・コーナー${result1.cornerCount}個) / Cam2(マーカー${result2.markerCount}個・コーナー${result2.cornerCount}個)`);
    } else if (success1) {
        // Cam1のみ成功 - 1画面表示
        const basicAccepted = isBasicCharucoAccept(result1);
        const evalRes = evaluateAutoAccept(result1);

        // オーバーレイ情報を更新（Cam2検出失敗）
        window.__stereoOverlayInfo = {
            commonCount: 0,
            required: 6,
            canAdd: false
        };

        logCharucoCoordinates(result1);
        await displayCharucoDetectionResult(result1, basicAccepted, evalRes);
        updateCharucoStats(result1.cornerCount, result1.markerCount, result1);

        showMessage(`Cam1のみ検出成功: マーカー${result1.markerCount}個、コーナー${result1.cornerCount}個 (Cam2は検出失敗)`);
    } else if (success2) {
        // Cam2のみ成功 - 1画面表示
        const basicAccepted = isBasicCharucoAccept(result2);
        const evalRes = evaluateAutoAccept(result2);

        // オーバーレイ情報を更新（Cam1検出失敗）
        window.__stereoOverlayInfo = {
            commonCount: 0,
            required: 6,
            canAdd: false
        };

        logCharucoCoordinates(result2);
        await displayCharucoDetectionResult(result2, basicAccepted, evalRes);
        updateCharucoStats(result2.cornerCount, result2.markerCount, result2);

        showMessage(`Cam2のみ検出成功: マーカー${result2.markerCount}個、コーナー${result2.cornerCount}個 (Cam1は検出失敗)`);
    } else {
        // 両方失敗
        window.__stereoOverlayInfo = {
            commonCount: 0,
            required: 6,
            canAdd: false
        };
        showError('両カメラでCharuco検出に失敗: Cam1(' + (result1?.error || '不明') + '), Cam2(' + (result2?.error || '不明') + ')');
    }
}

/**
 * ステレオキャリブレーション用の自動フレーム追加
 */
function maybeAutoAddStereoCalibrationFrame(result1, result2) {
    // 自動追加が有効かどうかを確認
    if (!window.__calibActive) return;

    // TODO: ステレオ用の自動追加ロジックを実装
    // 現在は手動追加を推奨
}

// ------------------------------
// ChArUco 連続検出ループ
// ------------------------------
let __charucoDetectTimer = null;

window.startCharucoAutoDetection = function (intervalMs = 400) {
    try {
        window.stopCharucoAutoDetection();
        __charucoDetectTimer = setInterval(() => {
            // キャリブレーションモード時のみ実行
            if (typeof getCurrentMode === 'function' && getCurrentMode() !== 'calibration') return;
            window.detectCharucoBoard();
        }, Math.max(100, intervalMs));
        showMessage('ChArUco連続検出を開始しました');
    } catch (_) { }
}

window.stopCharucoAutoDetection = function () {
    if (__charucoDetectTimer) {
        clearInterval(__charucoDetectTimer);
        __charucoDetectTimer = null;
        showMessage('ChArUco連続検出を停止しました');
    }
}

/**
 * Charuco検出結果の表示（単眼モード用）
 */
function displayCharucoDetectionResult(result, accepted, evalRes) {
    return new Promise((resolve) => {
        // キャンバスに検出結果を表示
        const canvas = document.getElementById('digitize-canvas');
        if (!canvas) {
            resolve();
            return;
        }

        // 現在表示中のcanvas画像を使用
        const currentImage = canvas.currentImage;
        if (!currentImage || currentImage.width === 0 || currentImage.height === 0) {
            console.warn('[displayCharucoDetectionResult] No currentImage available');
            resolve();
            return;
        }

        const imgWidth = currentImage.width;
        const imgHeight = currentImage.height;

        console.log('[displayCharucoDetectionResult] Drawing overlay on canvas:', imgWidth, 'x', imgHeight);

        // オーバーレイ込みの画像を作成
        const resultCanvas = document.createElement('canvas');
        resultCanvas.width = imgWidth;
        resultCanvas.height = imgHeight;
        const rctx = resultCanvas.getContext('2d');
        rctx.drawImage(currentImage, 0, 0);
        drawCharucoOverlay(rctx, result, accepted, 12, 12);

        // オーバーレイ込みの画像をcurrentImageに保持
        canvas.currentImage = resultCanvas;

        // canvasに直接描画（検出中なのでredrawCanvasOnlyは使えない）
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(resultCanvas, 0, 0, canvas.width, canvas.height);

        resolve();
    });
}

/**
 * Charuco検出結果のオーバーレイ描画（共通処理）
 */
function drawCharucoOverlay(ctx, result, accepted, overlayX, overlayY, label = null) {
    // テキストに影を付けて視認性を確保
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 100px Arial';
    ctx.textBaseline = 'top';
    const baseY = overlayY + 12;
    const headerLine = 100;   // ヘッダフォント高
    const headerGap = 12;    // ヘッダ行間

    // カメララベル（ステレオモード用）
    let lineOffset = 0;
    if (label) {
        ctx.fillStyle = '#ffff00';
        ctx.font = 'bold 80px Arial';
        ctx.fillText(label, overlayX, baseY);
        lineOffset = 1;
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 100px Arial';
    }

    ctx.fillText(`マーカー: ${result.markerCount}個`, overlayX, baseY + (headerLine + headerGap) * lineOffset);
    ctx.fillText(`コーナー: ${result.cornerCount}個`, overlayX, baseY + (headerLine + headerGap) * (lineOffset + 1));

    // ボードまでの距離を表示
    const distance = calculateBoardDistance(result);
    if (distance !== null && Number.isFinite(distance) && distance > 0) {
        ctx.fillText(`距離: ${distance.toFixed(2)}m`, overlayX, baseY + (headerLine + headerGap) * (lineOffset + 2));
    }

    // 採否表示
    const statusText = accepted ? '採用' : '不採用';
    ctx.fillStyle = accepted ? '#00e676' : '#ff5252';
    ctx.font = 'bold 120px Arial';
    const statusGapBefore = 20;
    const statusY = baseY + (headerLine + headerGap) * (lineOffset + 3) + statusGapBefore;
    ctx.fillText(statusText, overlayX, statusY);

    // 影をリセット
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
}

/**
 * ステレオモードでのCharuco検出結果の2画面表示
 * @param {Object} result1 - Cam1の検出結果
 * @param {Object} result2 - Cam2の検出結果
 * @param {boolean} accepted1 - Cam1の採否
 * @param {boolean} accepted2 - Cam2の採否
 * @param {number} commonCount - 共通ID数
 * @param {boolean} canAdd - 追加可能かどうか
 */
function displayCharucoDetectionResultStereo(result1, result2, accepted1, accepted2, commonCount, canAdd) {
    return new Promise((resolve) => {
        const canvas = document.getElementById('digitize-canvas');
        if (!canvas) {
            resolve();
            return;
        }

        // 現在表示中のcanvas画像を使用
        const currentImage = canvas.currentImage;
        if (!currentImage || currentImage.width === 0 || currentImage.height === 0) {
            console.warn('[displayCharucoDetectionResultStereo] No currentImage available');
            resolve();
            return;
        }

        const combinedWidth = currentImage.width;
        const combinedHeight = currentImage.height;
        const halfWidth = Math.floor(combinedWidth / 2);

        console.log('[displayCharucoDetectionResultStereo] Drawing overlays on canvas:', combinedWidth, 'x', combinedHeight);

        // 合成画像をズーム・パン用に保持（オーバーレイ込み）
        const stereoCanvas = document.createElement('canvas');
        stereoCanvas.width = combinedWidth;
        stereoCanvas.height = combinedHeight;
        const sctx = stereoCanvas.getContext('2d');
        sctx.drawImage(currentImage, 0, 0);

        // Cam1のオーバーレイ（左側）
        if (result1 && result1.success) {
            drawCharucoOverlay(sctx, result1, accepted1, 12, 12, 'Cam1');
        }

        // Cam2のオーバーレイ（右側）
        if (result2 && result2.success) {
            drawCharucoOverlay(sctx, result2, accepted2, halfWidth + 12, 12, 'Cam2');
        }

        // 中央に区切り線を描画
        sctx.strokeStyle = 'rgba(255, 255, 0, 0.8)';
        sctx.lineWidth = 4;
        sctx.beginPath();
        sctx.moveTo(halfWidth, 0);
        sctx.lineTo(halfWidth, combinedHeight);
        sctx.stroke();

        // 画面下部中央に共通ID情報を表示
        drawStereoCommonIdOverlay(sctx, combinedWidth, combinedHeight, commonCount, canAdd);

        // オーバーレイ込みの画像をcurrentImageに保持
        canvas.currentImage = stereoCanvas;

        // canvasに直接描画（検出中なのでredrawCanvasOnlyは使えない）
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(stereoCanvas, 0, 0, canvas.width, canvas.height);

        resolve();
    });
}

// ChArUco検出結果表示関数をグローバルに公開（displayCurrentFrameからのキャッシュ再描画用）
window.displayCharucoDetectionResult = displayCharucoDetectionResult;
window.displayCharucoDetectionResultStereo = displayCharucoDetectionResultStereo;

/**
 * Charuco統計情報更新（単眼モード用）
 */
function updateCharucoStats(cornerCount, markerCount, result) {
    const cornersElement = document.getElementById('charuco-corners');
    const markersElement = document.getElementById('charuco-markers');
    const distanceElement = document.getElementById('charuco-distance');

    if (cornersElement) cornersElement.textContent = cornerCount;
    if (markersElement) markersElement.textContent = markerCount;

    // 距離計算
    let distanceText = '-';
    if (result && result.success && result.charucoCorners && Array.isArray(result.charucoCorners) && result.charucoCorners.length >= 4) {
        try {
            const distance = calculateBoardDistance(result);
            if (distance !== null && Number.isFinite(distance) && distance > 0) {
                distanceText = `${distance.toFixed(2)}m`;
            }
        } catch (e) {
            // 距離計算エラー時は'-'のまま
        }
    }
    if (distanceElement) distanceElement.textContent = distanceText;
}

/**
 * Charuco統計情報更新（ステレオモード用）
 */
function updateCharucoStatsStereo(result1, result2, commonCount) {
    const cornersElement = document.getElementById('charuco-corners');
    const markersElement = document.getElementById('charuco-markers');
    const distanceElement = document.getElementById('charuco-distance');

    // 両カメラの情報を表示
    const corners1 = result1?.cornerCount || 0;
    const corners2 = result2?.cornerCount || 0;
    const markers1 = result1?.markerCount || 0;
    const markers2 = result2?.markerCount || 0;

    // 共通ID数も表示
    const commonText = (typeof commonCount === 'number') ? ` (共通: ${commonCount})` : '';
    if (cornersElement) cornersElement.textContent = `Cam1: ${corners1} / Cam2: ${corners2}${commonText}`;
    if (markersElement) markersElement.textContent = `Cam1: ${markers1} / Cam2: ${markers2}`;

    // 距離は両カメラの平均または'-'
    let distanceText = '-';
    try {
        const dist1 = calculateBoardDistance(result1);
        const dist2 = calculateBoardDistance(result2);
        if (dist1 !== null && dist2 !== null && Number.isFinite(dist1) && Number.isFinite(dist2)) {
            distanceText = `Cam1: ${dist1.toFixed(2)}m / Cam2: ${dist2.toFixed(2)}m`;
        } else if (dist1 !== null && Number.isFinite(dist1)) {
            distanceText = `Cam1: ${dist1.toFixed(2)}m`;
        } else if (dist2 !== null && Number.isFinite(dist2)) {
            distanceText = `Cam2: ${dist2.toFixed(2)}m`;
        }
    } catch (e) {
        // 距離計算エラー時は'-'のまま
    }
    if (distanceElement) distanceElement.textContent = distanceText;
}

/**
 * ステレオモードで共通ID情報をオーバーレイ表示
 */
function drawStereoCommonIdOverlay(ctx, canvasWidth, canvasHeight, commonCount, canAdd) {
    const statusText = canAdd ? '追加可能 (両カメラ検出数十分)' : '追加不可 (片方または両方のカメラで検出不足)';
    const text = `共通コーナー: ${commonCount}個  [${statusText}]`;

    ctx.save();

    // テキストに影を付けて視認性を確保
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    ctx.font = 'bold 80px Arial';
    const textWidth = ctx.measureText(text).width;

    // 画面下部中央に配置
    const boxPadding = 20;
    const boxWidth = textWidth + boxPadding * 2;
    const boxHeight = 100;
    const boxX = (canvasWidth - boxWidth) / 2;
    const boxY = canvasHeight - boxHeight - 30;

    // 背景を描画
    ctx.fillStyle = canAdd ? 'rgba(0, 128, 0, 0.85)' : 'rgba(200, 0, 0, 0.85)';
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

    // 枠線を描画
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 3;
    ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);

    // テキストを描画
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, boxX + boxPadding, boxY + boxHeight / 2);

    // 影をリセット
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.restore();
}

/**
 * ボードまでの距離を計算
 * @param {Object} result - Charuco検出結果
 * @returns {number|null} - 距離（メートル）、計算できない場合はnull
 */
function calculateBoardDistance(result) {
    if (!result) {
        return null;
    }

    // tvecが利用可能な場合のみ距離を計算（キャリブレーション済みの場合）
    if (result.tvec && Array.isArray(result.tvec) && result.tvec.length === 3) {
        const tx = Number(result.tvec[0]) || 0;
        const ty = Number(result.tvec[1]) || 0;
        const tz = Number(result.tvec[2]) || 0;
        const distance = Math.sqrt(tx * tx + ty * ty + tz * tz);
        return distance; // 既にメートル単位
    }

    // キャリブレーション未実施の場合は距離を計算しない
    return null;
}

// =============================
// 自動追加: 閾値と判定ロジック
// =============================
// ChArUco 基本採用条件（Python版 charuco_calibration_ui.py と同等: コーナーが4点以上）
function isBasicCharucoAccept(result) {
    if (!result) return false;
    const corners = typeof result.cornerCount === 'number' ? result.cornerCount : 0;
    const markers = typeof result.markerCount === 'number' ? result.markerCount : 0;
    // 採用条件: cornerCount ≥ 6 かつ markerCount ≥ 4
    return corners >= 6 && markers >= 4;
}

const AUTO_THRESH = {
    cornerRatio: 0.85,   // 角数 ≥ 85%（80–85%推奨の上限寄り）
    markerRatio: 0.65,   // マーカー ≥ 65%
    coverageMin: 0.05,   // 画面占有 5% 以上
    coverageMax: 0.50,   // 画面占有 50% 以下
    diversityShift: 0.10,// 対角比の移動 ≥10%
    diversityAngleDeg: 10
};

let __lastAccepted = null; // { cx, cy, angleRad }

function computeCoverage(charucoCorners, width, height) {
    // 正規化: ArrayLike/オブジェクト/タプル形式を {x,y}[] へ
    const norm = [];
    const pushPt = (pt) => {
        if (!pt) return;
        let x = undefined, y = undefined;
        if (typeof pt.x === 'number' && typeof pt.y === 'number') { x = pt.x; y = pt.y; }
        else if (Array.isArray(pt) && pt.length >= 2) { x = Number(pt[0]); y = Number(pt[1]); }
        else if (typeof pt === 'object') {
            // array-like {0: x, 1: y}
            if (typeof pt[0] === 'number' && typeof pt[1] === 'number') { x = pt[0]; y = pt[1]; }
        }
        if (Number.isFinite(x) && Number.isFinite(y)) norm.push({ x, y });
    };
    if (Array.isArray(charucoCorners)) {
        charucoCorners.forEach(pushPt);
    } else if (charucoCorners && typeof charucoCorners === 'object') {
        // Node/ElectronのIPC経由でオブジェクト配列風になる場合に対応
        const vals = Object.keys(charucoCorners)
            .filter(k => !isNaN(Number(k)))
            .sort((a, b) => Number(a) - Number(b))
            .map(k => charucoCorners[k]);
        vals.forEach(pushPt);
    }
    if (norm.length >= 4 && width > 0 && height > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of norm) {
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }
        const rectArea = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
        return rectArea / (width * height);
    }
    return null;
}

function computeCentroidAndAngle(charucoCorners) {
    if (!Array.isArray(charucoCorners) || charucoCorners.length < 4) return null;
    let sx = 0, sy = 0;
    const pts = charucoCorners.map(p => ({ x: (typeof p.x === 'number' ? p.x : (p[0] ?? 0)), y: (typeof p.y === 'number' ? p.y : (p[1] ?? 0)) }));
    pts.forEach(p => { sx += p.x; sy += p.y; });
    const cx = sx / pts.length, cy = sy / pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    pts.forEach(p => { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; });
    const angleRad = 0.5 * Math.atan2(2 * sxy, (sxx - syy));
    return { cx, cy, angleRad };
}

function passDiversity(feat, width, height) {
    if (!__lastAccepted) return true;
    const diag = Math.hypot(width, height);
    const shift = Math.hypot(feat.cx - __lastAccepted.cx, feat.cy - __lastAccepted.cy) / (diag || 1);
    let dAng = Math.abs(feat.angleRad - __lastAccepted.angleRad);
    dAng = Math.min(dAng, Math.PI - dAng);
    const angOk = (dAng * 180 / Math.PI) >= AUTO_THRESH.diversityAngleDeg;
    const shiftOk = shift >= AUTO_THRESH.diversityShift;
    return angOk || shiftOk;
}

function evaluateAutoAccept(result) {
    const { cornerCount, markerCount } = result || {};
    const reasons = [];
    const metrics = {};

    const corners = typeof cornerCount === 'number' ? cornerCount : 0;
    const markers = typeof markerCount === 'number' ? markerCount : 0;

    metrics.cornerCount = corners;
    metrics.markerCount = markers;

    // 採用条件: cornerCount ≥ 6 かつ markerCount ≥ 4
    if (corners < 6) {
        reasons.push(`角数不足 ${corners} (< 6)`);
    }
    if (markers < 4) {
        reasons.push(`マーカー不足 ${markers} (< 4)`);
    }

    const ok = reasons.length === 0;
    return { ok, reasons, metrics };
}

function shouldAutoAccept(result) {
    const r = evaluateAutoAccept(result);
    return !!(r && r.ok);
}

function maybeAutoAddCalibrationFrame(result, predecided) {
    try {
        // 自動追加は行わない。評価ロジックは将来の参考用としてのみ利用。
        // 追加は常に「現在フレームを追加」ボタン経由で手動実行する。
        return;
    } catch (e) { /* no-op */ }
}

/**
 * 条件付きデータクリア関数（データクリア機能を無効化）
 * @param {string} mode - 'calibration' または 'motion'
 */
function conditionalDataClear(mode) {
    // データクリア機能を完全に無効化し、常にデータを保持
    if (mode === 'motion') {
        showMessage('モーションデータを保持しました');
    } else if (mode === 'calibration') {
        showMessage('キャリブレーションデータを保持しました');
    }
}

// エクスポート用に関数を公開
window.switchVideoByMode = switchVideoByMode;
window.applyVideoIfConditionsMet = applyVideoIfConditionsMet;
window.updateFileSelectionUI = updateFileSelectionUI;
window.exportToRdFormat = exportToRdFormat;
window.exportMotionDataToRd = exportMotionDataToRd;
window.fileState = fileState;

/**
 * ChArUcoコーナーの実空間座標を計算
 * @param {Array} charucoCorners - 検出されたコーナーのピクセル座標配列
 * @param {Array} charucoIds - コーナーID配列
 * @param {number} squareSizeMm - チェッカーサイズ（mm）
 * @returns {Array} - 実空間座標配列
 */
function calculateRealWorldCoordinates(charucoCorners, charucoIds, squareSizeMm) {
    if (!Array.isArray(charucoCorners) || !Array.isArray(charucoIds)) {
        return [];
    }

    const squareSizeM = squareSizeMm / 1000; // mm → m
    const coordinates = [];

    // UIからボードサイズを取得（未設定時は 3x6 を前提）
    const rowsEl = document.getElementById('charuco-rows');
    const colsEl = document.getElementById('charuco-cols');
    const rows = rowsEl ? parseInt(rowsEl.value, 10) : 3;
    const cols = colsEl ? parseInt(colsEl.value, 10) : 6;

    // OpenCV CharucoBoard の内部コーナーは (cols-1) x (rows-1)
    const innerCols = Math.max(1, cols - 1);

    for (let i = 0; i < charucoCorners.length; i++) {
        const corner = charucoCorners[i];
        const id = charucoIds[i];

        // ピクセル座標を正規化
        const pixelX = typeof corner.x === 'number' ? corner.x : (Array.isArray(corner) ? corner[0] : 0);
        const pixelY = typeof corner.y === 'number' ? corner.y : (Array.isArray(corner) ? corner[1] : 0);

        // 実空間座標を計算（左上を原点とした格子）
        const row = Math.floor(id / innerCols);
        const col = id % innerCols;

        const realX = col * squareSizeM;
        const realY = row * squareSizeM;

        coordinates.push({
            id,
            pixel: { x: pixelX, y: pixelY },
            real: { x: realX, y: realY }
        });
    }

    return coordinates;
}

/**
 * ChArUco座標情報をログに表示
 * @param {Object} result - 検出結果
 */
function logCharucoCoordinates(result) {
    if (!result.success || !result.charucoCorners || !result.charucoIds) {
        return;
    }

    const squareSizeMm = result.squareSizeMm || 24; // デフォルト24mm
    const coordinates = calculateRealWorldCoordinates(
        result.charucoCorners,
        result.charucoIds,
        squareSizeMm
    );

    console.log('=== ChArUco座標情報 ===');
    console.log(`チェッカーサイズ: ${squareSizeMm}mm`);
    console.log(`検出コーナー数: ${coordinates.length}`);
    console.log('座標一覧:');

    coordinates.forEach(coord => {
    });

    // 統計情報も表示
    if (coordinates.length > 0) {
        const pixelXRange = {
            min: Math.min(...coordinates.map(c => c.pixel.x)),
            max: Math.max(...coordinates.map(c => c.pixel.x))
        };
        const pixelYRange = {
            min: Math.min(...coordinates.map(c => c.pixel.y)),
            max: Math.max(...coordinates.map(c => c.pixel.y))
        };
        const realXRange = {
            min: Math.min(...coordinates.map(c => c.real.x)),
            max: Math.max(...coordinates.map(c => c.real.y))
        };
        const realYRange = {
            min: Math.min(...coordinates.map(c => c.real.y)),
            max: Math.max(...coordinates.map(c => c.real.y))
        };

        console.log('座標範囲:');
        console.log(`  ピクセルX: ${pixelXRange.min.toFixed(2)} - ${pixelXRange.max.toFixed(2)}`);
        console.log(`  ピクセルY: ${pixelYRange.min.toFixed(2)} - ${pixelYRange.max.toFixed(2)}`);
        console.log(`  実空間X: ${realXRange.min.toFixed(6)}m - ${realXRange.max.toFixed(6)}m`);
        console.log(`  実空間Y: ${realYRange.min.toFixed(6)}m - ${realYRange.max.toFixed(6)}m`);
    }

}

async function saveProjectAs() {
    try {
        // 1. ダイアログでパスを先に取得
        const dialogRes = await ipcRenderer.invoke('save-file', {
            title: '名前を付けてプロジェクトを保存',
            filters: [{ name: 'MotionDigitizer Project', extensions: ['mdp'] }]
        });
        if (!dialogRes || !dialogRes.success || !dialogRes.filePath) return; // キャンセル

        const savePath = dialogRes.filePath;

        // 2. 相対パスに変換してから書き込み
        const dataToSave = applyRelativePaths(JSON.parse(JSON.stringify(buildProjectDataForSave())), savePath);
        const res = await ipcRenderer.invoke('write-text-file', savePath, JSON.stringify(dataToSave, null, 2));

        if (res && res.success) {
            showMessage('プロジェクトを保存しました');
            try {
                projectData.settings.projectPath = savePath;
                projectData.settings.projectFileName = path.basename(savePath);
                const projectNameEl = document.getElementById('project-name-display');
                if (projectNameEl) projectNameEl.textContent = projectData.settings.projectFileName;
            } catch (_) { }
        } else {
            showError('保存に失敗しました' + (res && res.error ? (': ' + res.error) : ''));
        }
    } catch (e) {
        showError('保存エラー: ' + e.message);
    }
}

async function saveProjectOverwrite() {
    try {
        let targetPath = window.projectData?.settings?.projectPath;

        // まだ一度も保存していない場合はダイアログでパスを取得
        if (!targetPath) {
            const motionCam1 = fileState && fileState['motion-cam1'];
            let defaultName = 'project.mdp';
            try {
                if (motionCam1 && motionCam1.path) {
                    const base = path.basename(motionCam1.path, path.extname(motionCam1.path)) || 'project';
                    defaultName = `${base}.mdp`;
                }
            } catch (_) { }
            const dialogRes = await ipcRenderer.invoke('save-file', {
                title: 'プロジェクトを保存',
                defaultPath: defaultName,
                filters: [{ name: 'MotionDigitizer Project', extensions: ['mdp'] }]
            });
            if (!dialogRes || !dialogRes.success || !dialogRes.filePath) return; // キャンセル
            targetPath = dialogRes.filePath;
        }

        // 相対パスに変換してから書き込み
        const dataToSave = applyRelativePaths(JSON.parse(JSON.stringify(buildProjectDataForSave())), targetPath);
        const res = await ipcRenderer.invoke('write-text-file', targetPath, JSON.stringify(dataToSave, null, 2));

        if (res && res.success) {
            showMessage('プロジェクトを上書き保存しました');
            try {
                projectData.settings.projectPath = targetPath;
                projectData.settings.projectFileName = path.basename(targetPath);
                const projectNameEl = document.getElementById('project-name-display');
                if (projectNameEl) projectNameEl.textContent = projectData.settings.projectFileName;
            } catch (_) { }
        } else {
            showError('上書き保存に失敗しました' + (res && res.error ? (': ' + res.error) : ''));
        }
    } catch (e) {
        showError('上書き保存エラー: ' + e.message);
    }
}

window.saveProjectAs = saveProjectAs;
window.saveProjectOverwrite = saveProjectOverwrite;

// ========================================================================================
// キャリブレーションデータ保存・読み込み (.cal)
// ========================================================================================

/**
 * キャリブレーションデータを保存
 * mdpファイルと同形式でキャリブレーション結果のみを保存
 */
async function saveCalibrationData() {
    try {
        // キャリブレーションデータを構築
        const calibrationDataForSave = {
            // ファイル識別子
            fileType: 'MotionDigitizer_Calibration',
            version: '1.0',
            savedAt: new Date().toISOString(),

            // CC法キャリブレーション結果
            ccCalibration: window.projectData?.ccCalibration || null,

            // 既知のカメラ内部パラメータ (CC法用)
            ccFixedInternalParams: {
                cam1: window.ccFixedInternalParams1 ? {
                    F: window.ccFixedInternalParams1.F,
                    U0: window.ccFixedInternalParams1.U0,
                    V0: window.ccFixedInternalParams1.V0,
                    sourceFile: window.ccFixedInternalParams1.sourceFile || null
                } : null,
                cam2: window.ccFixedInternalParams2 ? {
                    F: window.ccFixedInternalParams2.F,
                    U0: window.ccFixedInternalParams2.U0,
                    V0: window.ccFixedInternalParams2.V0,
                    sourceFile: window.ccFixedInternalParams2.sourceFile || null
                } : null
            },

            // ステレオキャリブレーション
            stereoCalibration: window.projectData?.stereoCalibration || null,
            stereoIntrinsics: window.projectData?.stereoIntrinsics || null,

            // DLTパラメータ（CC法の結果に含まれる場合）
            dltParams: window.projectData?.ccCalibration?.dltParams || null,

            // カメラパラメータ
            cameraParams: window.projectData?.ccCalibration?.cameraParams || null
        };

        // データがあるか確認
        const hasData = calibrationDataForSave.ccCalibration ||
            calibrationDataForSave.stereoCalibration ||
            calibrationDataForSave.ccFixedInternalParams?.cam1 ||
            calibrationDataForSave.ccFixedInternalParams?.cam2;

        if (!hasData) {
            showError('保存するキャリブレーションデータがありません。先にキャリブレーションを実行してください。');
            return { success: false, error: 'no calibration data' };
        }

        console.log('[CALIBRATION] Saving calibration data:', Object.keys(calibrationDataForSave));

        const result = await ipcRenderer.invoke('save-calibration-file', calibrationDataForSave);

        if (result.success) {
            showMessage('キャリブレーションデータを保存しました: ' + path.basename(result.path));
            return { success: true, path: result.path };
        } else if (result.error !== 'cancelled') {
            showError('キャリブレーションデータの保存に失敗しました: ' + result.error);
        }
        return result;

    } catch (error) {
        console.error('[CALIBRATION] Save error:', error);
        showError('キャリブレーションデータの保存中にエラーが発生しました: ' + error.message);
        return { success: false, error: error.message };
    }
}

/**
 * キャリブレーションデータを読み込み
 */
async function loadCalibrationData() {
    try {
        const result = await ipcRenderer.invoke('load-calibration-file');

        if (!result.success) {
            if (result.error !== 'cancelled') {
                showError('キャリブレーションデータの読み込みに失敗しました: ' + result.error);
            }
            return result;
        }

        const data = result.data;

        // ファイル形式チェック
        if (data.fileType !== 'MotionDigitizer_Calibration') {
            showError('無効なキャリブレーションファイルです。');
            return { success: false, error: 'invalid file format' };
        }

        console.log('[CALIBRATION] Loading calibration data:', Object.keys(data));

        // projectDataの初期化確認
        if (!window.projectData) window.projectData = {};

        // CC法キャリブレーション結果を復元
        if (data.ccCalibration) {
            window.projectData.ccCalibration = data.ccCalibration;
            console.log('[CALIBRATION] Restored ccCalibration');

            // UI更新
            if (typeof window.displayCCMethodResults === 'function') {
                window.displayCCMethodResults({
                    success: true,
                    ...data.ccCalibration
                });
            }
        }

        // 既知のカメラ内部パラメータを復元
        if (data.ccFixedInternalParams) {
            if (data.ccFixedInternalParams.cam1) {
                window.ccFixedInternalParams1 = data.ccFixedInternalParams.cam1;
                console.log('[CALIBRATION] Restored ccFixedInternalParams1');
            }
            if (data.ccFixedInternalParams.cam2) {
                window.ccFixedInternalParams2 = data.ccFixedInternalParams.cam2;
                console.log('[CALIBRATION] Restored ccFixedInternalParams2');
            }
        }

        // ステレオキャリブレーションを復元
        if (data.stereoCalibration) {
            window.projectData.stereoCalibration = data.stereoCalibration;
            console.log('[CALIBRATION] Restored stereoCalibration');
        }
        if (data.stereoIntrinsics) {
            window.projectData.stereoIntrinsics = data.stereoIntrinsics;
            console.log('[CALIBRATION] Restored stereoIntrinsics');
        }

        // UI更新
        if (typeof window.updateCalibrationUI === 'function') {
            window.updateCalibrationUI();
        }
        if (typeof window.redrawCanvas === 'function') {
            window.redrawCanvas();
        }

        const rms = data.ccCalibration?.errorStats?.rms;
        const rmsText = rms ? ` (RMS: ${rms.toFixed(3)})` : '';
        showMessage('キャリブレーションデータを読み込みました' + rmsText + ': ' + path.basename(result.path));

        return { success: true, path: result.path };

    } catch (error) {
        console.error('[CALIBRATION] Load error:', error);
        showError('キャリブレーションデータの読み込み中にエラーが発生しました: ' + error.message);
        return { success: false, error: error.message };
    }
}

window.saveCalibrationData = saveCalibrationData;
window.loadCalibrationData = loadCalibrationData;

/**
 * 動画情報を取得（FFprobe -> HTML5 の順で試行）
 * OpenCVは使用せず、ffmpegベースの処理で統一
 * UIのFPS設定には依存せず、ファイルから正確な情報を抽出することを優先
 */
const _videoInfoCache = new Map();

async function getVideoInfoRobust(filePath) {
    if (_videoInfoCache.has(filePath)) {
        return _videoInfoCache.get(filePath);
    }

    // 0. ファイル存在確認（ffprobe/HTML5 の試行前に確認）
    try {
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
            const err = new Error(`ファイルが見つかりません: ${path.basename(filePath)}`);
            err.code = 'FILE_NOT_FOUND';
            throw err;
        }
    } catch (e) {
        if (e.code === 'FILE_NOT_FOUND') throw e;
        // require('fs') 失敗など予期しないエラーは無視して続行
    }

    // 1. FFprobe（最優先 - 最も正確）
    let ffInfo = null;
    try {
        const ffRes = await ipcRenderer.invoke('get-video-info-ffprobe', filePath);
        ffInfo = normalizeVideoInfo(ffRes);

        if (ffInfo && ffInfo.frameCount > 0 && ffInfo.fps > 0) {
            _videoInfoCache.set(filePath, ffInfo);
            return ffInfo;
        }
    } catch (e) {
        console.warn('[getVideoInfoRobust] FFprobe failed:', e);
    }

    // 2. HTML5 Fallback
    console.warn('[getVideoInfoRobust] FFprobe unavailable, falling back to HTML5');
    try {
        const html5Info = await probeVideoByHTML5(filePath);
        _videoInfoCache.set(filePath, html5Info);
        return html5Info;
    } catch (e) {
        console.error('[getVideoInfoRobust] HTML5 also failed:', e);
        throw new Error('動画情報の取得に失敗しました: ' + e.message);
    }
}

// OpenCV動画情報: 戻り値の正規化（{success,true,info:{...}} と フラット構造の両対応）
function normalizeVideoInfo(res) {
    try {
        if (!res || res.success !== true) return null;
        if (res.info && (typeof res.info.fps === 'number' || typeof res.info.frameCount === 'number')) return res.info;
        if (typeof res.fps === 'number' || typeof res.frameCount === 'number') return res;
        return null;
    } catch (_) { return null; }
}

// UIからFPSを取得（未設定時はsettings→30の順）
function readFpsFromUI() {
    try {
        const el = document.getElementById('fps');
        const v = Number(el && el.value);
        if (Number.isFinite(v) && v > 0) return v;
    } catch (_) { }
    return Number(window.projectData?.settings?.fps) || 30;
}

// HTML5メタデータでフォールバック
// 注意: HTML5のvideoエレメントからはFPS情報を取得できないため、
// fpsとframeCountは推定値（デフォルト30fps）となる
// 可能な限りFFprobeを使用すること
function probeVideoByHTML5(absPath) {
    return new Promise((resolve, reject) => {
        try {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.onloadedmetadata = () => {
                const width = video.videoWidth || 0;
                const height = video.videoHeight || 0;
                const duration = Number(video.duration) || 0;
                // HTML5からFPSは取得できないため、デフォルト値を使用
                const fps = 30; // デフォルトFPS（不正確）
                const frameCount = Math.max(0, Math.round(duration * fps));
                console.warn('[probeVideoByHTML5] FPS and frameCount are estimated values. FFprobe is recommended.');
                resolve({ width, height, duration, fps, frameCount });
                video.src = '';
            };
            video.onerror = () => reject(new Error('HTML5メタデータ読込エラー'));
            video.crossOrigin = 'anonymous';
            video.src = normalizeFileUrl(absPath);
        } catch (e) { reject(e); }
    });
}

// ファイルを「未検出」状態としてマーク・UI更新
function markFileAsMissing(fileKey) {
    const file = fileState[fileKey];
    if (file && typeof file === 'object') file.missing = true;

    const fileItem = document.getElementById(fileKey);
    if (!fileItem) return;

    const fileNameEl = fileItem.querySelector('.file-name');
    const filePathEl = fileItem.querySelector('.file-path');
    const filePath = file ? (file.path || '') : '';
    const fileName = file ? (file.name || path.basename(filePath)) : '';

    if (fileNameEl) fileNameEl.textContent = `⚠ ${fileName}`;
    if (filePathEl) filePathEl.textContent = `ファイルが見つかりません: ${filePath}`;
    fileItem.classList.add('selected', 'file-missing');
}

// UIを更新（現在のファイル選択状態を反映）
window.updateFileSelectionUI = function () {
    for (const [key, file] of Object.entries(fileState)) {
        const fileItem = document.getElementById(key);
        if (fileItem) {
            const fileNameEl = fileItem.querySelector('.file-name');
            const filePathEl = fileItem.querySelector('.file-path');
            const button = fileItem.querySelector('.file-button');

            if (file) {
                const name = typeof file === 'string' ? path.basename(file) : file.name;
                const filePath = typeof file === 'string' ? file : file.path;
                const isMissing = file.missing === true;

                if (fileNameEl) fileNameEl.textContent = isMissing ? `⚠ ${name}` : name;
                if (filePathEl) filePathEl.textContent = isMissing ? `ファイルが見つかりません: ${filePath}` : filePath;

                fileItem.classList.toggle('selected', true);
                fileItem.classList.toggle('file-missing', isMissing);
                if (button) button.classList.toggle('selected', true);
            } else {
                if (fileNameEl) fileNameEl.textContent = 'ファイル未選択';
                if (filePathEl) filePathEl.textContent = 'クリックして選択';

                fileItem.classList.remove('selected', 'file-missing');
                if (button) button.classList.remove('selected');
            }
        }
    }
};

// リストからファイルを削除
window.removeFileFromList = function (fileId, index) {
    const list = fileStateLists[fileId];
    if (!list || index < 0 || index >= list.length) return;

    // 削除対象のファイル
    const removedFile = list[index];
    const removedPath = typeof removedFile === 'string' ? removedFile : removedFile.path;

    // リストから削除
    list.splice(index, 1);

    // 現在選択中のファイルだった場合は選択を解除（またはリストから他を選択）
    const currentFile = fileState[fileId];
    const currentPath = typeof currentFile === 'string' ? currentFile : (currentFile ? currentFile.path : null);

    if (removedPath === currentPath) {
        // 先頭のファイルがあればそれを選択、なければnull
        if (list.length > 0) {
            // 自動的に先頭を選択するか、未選択にするか。UX的には未選択の方が安全かもだが、
            // 連続作業を考えると次の候補を選んだほうが親切。ここでは未選択にする。
            fileState[fileId] = null;
        } else {
            fileState[fileId] = null;
        }
        // UI更新
        updateFileSelectionUI();
    }

    // リストUI更新
    updateFileListUI(fileId);
};

// リスト表示UI更新（実装）
window.updateFileListUI = function (fileId) {
    const listId = `${fileId}-list`;
    const listContainer = document.getElementById(listId);
    if (!listContainer) return;

    listContainer.innerHTML = '';
    // 配列がなければ初期化
    if (!fileStateLists[fileId]) fileStateLists[fileId] = [];
    const list = fileStateLists[fileId];

    // 現在のファイルがリストに含まれていない場合に追加（同期とれチェック）
    const currentFile = fileState[fileId];
    if (currentFile) {
        const currentPath = typeof currentFile === 'string' ? currentFile : currentFile.path;
        const exists = list.some(f => (typeof f === 'string' ? f : f.path) === currentPath);
        if (!exists) {
            list.push(currentFile);
        }
    }

    list.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'file-list-item';
        item.style.cursor = 'pointer';

        const pathStr = typeof file === 'string' ? file : file.path;
        const nameStr = typeof file === 'string' ? path.basename(file) : file.name;

        const currentPath = typeof currentFile === 'string' ? currentFile : (currentFile ? currentFile.path : null);

        if (pathStr === currentPath) {
            item.classList.add('active');
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = nameStr;
        nameSpan.title = pathStr;
        nameSpan.style.flex = "1";
        nameSpan.style.overflow = "hidden";
        nameSpan.style.textOverflow = "ellipsis";
        nameSpan.style.whiteSpace = "nowrap";
        item.appendChild(nameSpan);

        // 削除ボタン
        const delBtn = document.createElement('span');
        delBtn.textContent = '×';
        delBtn.className = 'file-list-del';
        delBtn.title = 'リストから削除';
        delBtn.onclick = (e) => {
            e.stopPropagation(); // 選択イベントの発火を防ぐ
            window.removeFileFromList(fileId, index);
        };
        item.appendChild(delBtn);

        item.onclick = (e) => {
            e.stopPropagation();
            window.applyFileFromList(fileId, index);
        };

        listContainer.appendChild(item);
    });
};

// メニューからの保存アクションをリッスン
if (ipcRenderer) {


    // 既存のリスナーを削除して重複防止（念のため）
    ipcRenderer.removeAllListeners('menu-save-project-overwrite');
    ipcRenderer.removeAllListeners('menu-save-project-as');
    ipcRenderer.removeAllListeners('open-mdp-file');
    ipcRenderer.removeAllListeners('load-startup-mdp-file');

    // ファイル関連付けからmdpファイルを開く（アプリ起動中に別ファイルをダブルクリック）
    ipcRenderer.on('open-mdp-file', async (_event, mdpFilePath) => {
        try {
            await window.loadProject(mdpFilePath);
        } catch (e) {
            console.error('[FILE-HANDLER] Failed to open mdp file:', e.message);
            alert('プロジェクトファイルを開けませんでした: ' + e.message);
        }
    });

    // 起動時のmdpファイル読み込み（メインプロセスからプッシュされる）
    ipcRenderer.on('load-startup-mdp-file', async (_event, mdpFilePath) => {
        try {
            await window.loadProject(mdpFilePath);
        } catch (e) {
            console.error('[FILE-HANDLER] Failed to load startup mdp file:', e.message);
            alert('プロジェクトファイルを開けませんでした: ' + e.message);
        }
    });

    ipcRenderer.on('menu-save-project-overwrite', async () => {
        if (typeof window.saveProject === 'function') {
            await window.saveProject();
        } else {
            console.error('window.saveProject is not a function');
        }
    });

    ipcRenderer.on('menu-save-project-as', () => {
        if (typeof window.saveProjectAs === 'function') {
            window.saveProjectAs();
        } else if (typeof window.saveProject === 'function') {
            window.saveProject();
        }
    });

    // キャリブレーションデータ保存
    ipcRenderer.on('menu-save-calibration', async () => {
        if (typeof window.saveCalibrationData === 'function') {
            await window.saveCalibrationData();
        } else {
            console.error('window.saveCalibrationData is not a function');
        }
    });

    // キャリブレーションデータ読み込み
    ipcRenderer.on('menu-load-calibration', async () => {
        if (typeof window.loadCalibrationData === 'function') {
            await window.loadCalibrationData();
        } else {
            console.error('window.loadCalibrationData is not a function');
        }
    });

} else {
    console.error('[FILE-HANDLER] CRITICAL: ipcRenderer not available! Menu saves will not work.');
}