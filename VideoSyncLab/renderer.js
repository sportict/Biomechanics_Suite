const { ipcRenderer, webUtils } = require('electron');
const path = require('path');

// === PreciseFrameManager クラス（厳密なフレーム管理） ===
class PreciseFrameManager {
    // 厳密なフレーム番号計算（動画から現在フレーム取得）
    static getCurrentFrameFromVideo(video, fps, totalFrames) {
        return this.timeToFrame(video.currentTime, fps, totalFrames);
    }

    // 時間からフレーム番号を計算（FFmpeg基準）
    // Math.floorを使用して、フレーム期間内のどの時点でも正しいフレーム番号になるようにする
    // +0.001は浮動小数点の微小な誤差対策
    static timeToFrame(currentTime, fps, totalFrames) {
        if (!fps || fps <= 0) return 1;

        // 先頭付近のオフセット対策:
        // HTML5 Video側で先頭フレームのcurrentTimeが微小な値になるケースでは、
        // 強制的にフレーム1として扱う
        // 59.94fpsなど高フレームレートでもフレーム2が正しく認識されるよう閾値を調整
        const firstFrameThreshold = 0.5 / fps; // フレーム1の中心時間まで許容
        if (currentTime <= firstFrameThreshold) {
            return 1;
        }

        const frame = Math.floor(currentTime * fps + 0.001) + 1;
        return Math.max(1, Math.min(frame, totalFrames));
    }

    // フレーム番号から時間を計算（開始時間）
    static frameToTime(frameNumber, fps) {
        return Math.max(0, (frameNumber - 1) / fps);
    }

    // フレーム番号から時間を計算（中心時間）
    // シーク時はこの時間を使用することで、フレーム境界でのズレを防ぐ
    static getFrameCenterTime(frameNumber, fps) {
        const startTime = this.frameToTime(frameNumber, fps);
        const frameDuration = 1 / fps;
        return startTime + (frameDuration / 2);
    }

    // 旧メソッド名の互換性維持
    static getTimeFromFrame(frameNumber, fps) {
        return this.frameToTime(frameNumber, fps);
    }

    // フレーム移動（境界値厳密管理）
    static moveFrame(currentFrame, direction, totalFrames) {
        const newFrame = currentFrame + direction;
        return Math.max(1, Math.min(newFrame, totalFrames));
    }

    // スライダー位置からフレーム番号計算
    static calculateFramePosition(sliderValue, totalFrames) {
        // sliderValue can be 0-100 (percentage) or raw value depending on context, 
        // but looking at usage it seems to be percentage usually.
        // Merging logic:
        const frameFloat = (sliderValue / 100) * totalFrames;
        const frameNumber = Math.round(frameFloat);
        return Math.max(1, Math.min(frameNumber, totalFrames));
    }

    // フレーム番号からパーセンテージ計算
    // スライダー（min=1, max=totalFrames）と同じ計算式
    // フレーム1 → 0%, フレームtotalFrames → 100%
    static frameToPercentage(frameNumber, totalFrames) {
        if (!totalFrames || totalFrames <= 1) return 0;
        return Math.max(0, Math.min(100, ((frameNumber - 1) / (totalFrames - 1)) * 100));
    }
}

// === FFmpegフレーム基準管理クラス（互換性維持） ===
// FFmpegFrameManager removed - merged into PreciseFrameManager

// === 設定定数 ===
const CONFIG = {
    UI: {
        FRAME_UPDATE_INTERVAL: 16,
        PROGRESS_HIDE_DELAY: 2000,
        SYNC_CORRECTION_THRESHOLD: 0.5
    },
    VIDEO: {
        DEFAULT_FPS: 30,
        HIGH_SPEED_THRESHOLD: 60,
        SPEED: {
            MIN: 0.1, MAX: 4.0, DEFAULT: 1.0,
            SLOW_STEP: 0.1, FAST_STEP: 1.0, SLOW_THRESHOLD: 1.0
        },
        // === ズーム・パン設定 ===
        ZOOM: {
            MIN: 0.5,       // 最小ズーム (50%)
            MAX: 5.0,       // 最大ズーム (500%)
            DEFAULT: 1.0,   // デフォルトズーム (100%)
            STEP: 0.1,      // ズームステップ
            WHEEL_SENSITIVITY: 0.1  // ホイール感度
        },
        PAN: {
            SENSITIVITY: 1.0  // パン感度
        }
    },
    MESSAGES: {
        ERROR: {
            VIDEO_NOT_LOADED: '動画が読み込まれていません',
            TRIM_NOT_SET: 'トリミング範囲が設定されていません',
            CHILD_CONTROL_DISABLED: '子画面のコントロールは無効です。左画面で操作してください。'
        },
        STATUS: {
            LOADING: (side) => `動画を読み込み中...（${Utils.getSideLabel(side)}）`,
            LOADED: (side, fps) => `動画が読み込まれました（${Utils.getSideLabel(side)}）- ${fps.toFixed(2)}fps`,
            SPEED_CHANGED: (side, speed) => `再生速度変更（${Utils.getSideLabel(side)}）: ${speed}x`,
            SPEED_SYNC_CHANGED: (speed) => `同期再生速度変更: ${speed}x`,
            SPEED_LIMIT_MIN: '最低速度に達しました (0.1x)',
            SPEED_LIMIT_MAX: '最高速度に達しました (4.0x)',
            SYNC_ENABLED: (leftFrame, rightFrame) => `同期が有効になりました (動画1: ${leftFrame}フレーム, 動画2: ${rightFrame}フレーム)`,
            PARENT_CHILD_ENABLED: '親子制御モード有効: 左画面で両方をコントロール',
            // === ズーム・パンメッセージ ===
            ZOOM_CHANGED: (side, zoom) => `ズーム変更（${Utils.getSideLabel(side)}）: ${(zoom * 100).toFixed(0)}%`,
            ZOOM_RESET: (side) => `ズームリセット（${Utils.getSideLabel(side)}）: 100%`,
            PAN_ACTIVE: (side) => `パンモード（${Utils.getSideLabel(side)}）`,
            VIEW_RESET: (side) => `表示リセット（${Utils.getSideLabel(side)}）`
        }
    },
    FILE_FILTERS: {
        VIDEO: [{ name: '動画ファイル', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'm4v'] }],
        IMAGE_ALL: [{ name: 'JPEG画像', extensions: ['jpg'] }, { name: 'PNG画像', extensions: ['png'] }]
    }
};

// === ユーティリティクラス ===
class Utils {
    static formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    static validateVideoLoaded(player) {
        return player.video?.duration && player.videoPath ?
            { valid: true } : { valid: false, message: CONFIG.MESSAGES.ERROR.VIDEO_NOT_LOADED };
    }

    static validateTrimPoints(player) {
        return player.hasTrimPoints ?
            { valid: true } : { valid: false, message: CONFIG.MESSAGES.ERROR.TRIM_NOT_SET };
    }

    // Utils.updateSliderBackgroundを公式方式に統一
    static updateSliderBackground(player) {
        const { video, positionSlider, trimInPoint, trimOutPoint } = player;
        if (!video.duration || !positionSlider) return;

        // 常にスライダー背景を無色に（下バー範囲に青色を表示しない）
        // トリミング範囲は上バー範囲（.trim-range）のみで表示
        positionSlider.style.setProperty('--slider-gradient', '#666');
    }

    static getElementById(id) {
        // DOM要素キャッシュ機能を追加
        if (!this._elementCache) this._elementCache = new Map();

        if (!this._elementCache.has(id) || !this._elementCache.get(id)) {
            const element = document.getElementById(id);
            if (!element) {
                console.warn(`Element not found: ${id}`);
                return null; // Don't cache nulls
            }
            this._elementCache.set(id, element);
        }
        return this._elementCache.get(id);
    }

    // キャッシュクリア機能
    static clearElementCache() {
        if (this._elementCache) {
            this._elementCache.clear();
        }
    }

    // === ズーム・パン用ユーティリティ ===
    static clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    static getMousePosition(event, element) {
        const rect = element.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top
        };
    }

    // === サイド判定ユーティリティ ===
    // side文字列を日本語ラベルに変換
    static getSideLabel(side) {
        return side === 'left' ? '左' : '右';
    }

    // 反対側のsideを取得
    static getOtherSide(side) {
        return side === 'left' ? 'right' : 'left';
    }
}

// === パフォーマンス最適化クラス ===
class PerformanceOptimizer {
    static debounce(func, wait) {
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

    static throttle(func, limit) {
        let inThrottle;
        return function () {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    static optimizeEventListeners() {
        // パッシブリスナーの使用を推奨
        const options = { passive: true };
        return options;
    }
}

// === ズーム・パン制御クラス ===
class ZoomPanController {
    static isValidZoom(zoom) {
        return zoom >= CONFIG.VIDEO.ZOOM.MIN && zoom <= CONFIG.VIDEO.ZOOM.MAX;
    }

    static formatZoom(zoom) {
        return (zoom * 100).toFixed(0);
    }

    static calculateZoomStep(currentZoom, direction) {
        const step = CONFIG.VIDEO.ZOOM.STEP;
        const newZoom = currentZoom + (step * direction);
        return Utils.clamp(newZoom, CONFIG.VIDEO.ZOOM.MIN, CONFIG.VIDEO.ZOOM.MAX);
    }

    static calculateWheelZoom(currentZoom, deltaY) {
        const sensitivity = CONFIG.VIDEO.ZOOM.WHEEL_SENSITIVITY;
        const direction = deltaY > 0 ? -1 : 1; // 上スクロールでズームイン
        const newZoom = currentZoom + (sensitivity * direction);
        return Utils.clamp(newZoom, CONFIG.VIDEO.ZOOM.MIN, CONFIG.VIDEO.ZOOM.MAX);
    }

    // === 修正: コンテナ内に収まるようにTransformを適用 ===
    static applyTransform(video, zoom, panX, panY) {
        if (!video) return;

        // Use requestAnimationFrame for smooth updates
        if (video._transformRAF) {
            cancelAnimationFrame(video._transformRAF);
        }

        video._transformRAF = requestAnimationFrame(() => {
            // video要素にoverflow: hiddenが適用されるようにする
            const videoWrapper = video.parentElement;
            if (videoWrapper) {
                videoWrapper.style.overflow = 'hidden';
                videoWrapper.style.position = 'relative';
            }

            video.style.transform = `scale(${zoom}) translate(${panX}px, ${panY}px)`;
            video.style.transformOrigin = 'center center';
            // 重要: video要素が親要素からはみ出ないようにする
            video.style.maxWidth = '100%';
            video.style.maxHeight = '100%';
            video.style.objectFit = 'contain';

            video._transformRAF = null;
        });
    }

    static resetTransform(video) {
        if (!video) return;
        video.style.transform = 'scale(1) translate(0px, 0px)';
        video.style.transformOrigin = 'center center';
        video.style.maxWidth = '100%';
        video.style.maxHeight = '100%';
        video.style.objectFit = 'contain';
    }

    // === 修正: パン境界計算を動画表示領域に限定 ===
    static calculatePanBounds(video, zoom) {
        if (!video || zoom <= 1) return { maxX: 0, maxY: 0 };

        // video要素の実際の表示サイズを取得
        const videoWrapper = video.parentElement;
        const containerRect = videoWrapper.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();

        // 実際のビデオコンテンツのサイズ
        const videoAspect = video.videoWidth / video.videoHeight;
        const containerAspect = containerRect.width / containerRect.height;

        let displayWidth, displayHeight;
        if (videoAspect > containerAspect) {
            // 横長の場合、幅に合わせる
            displayWidth = containerRect.width;
            displayHeight = containerRect.width / videoAspect;
        } else {
            // 縦長の場合、高さに合わせる
            displayHeight = containerRect.height;
            displayWidth = containerRect.height * videoAspect;
        }

        const scaledWidth = displayWidth * zoom;
        const scaledHeight = displayHeight * zoom;

        // パンできる最大範囲を計算（コンテナからはみ出ないように）
        const maxPanX = Math.max(0, (scaledWidth - containerRect.width) / (2 * zoom));
        const maxPanY = Math.max(0, (scaledHeight - containerRect.height) / (2 * zoom));

        return { maxX: maxPanX, maxY: maxPanY };
    }

    static constrainPan(panX, panY, bounds) {
        return {
            x: Utils.clamp(panX, -bounds.maxX, bounds.maxX),
            y: Utils.clamp(panY, -bounds.maxY, bounds.maxY)
        };
    }
}

// === 再生速度制御クラス（修正版） ===
class SpeedController {
    static getSpeedLevels() {
        const levels = [];
        for (let speed = CONFIG.VIDEO.SPEED.MIN; speed <= CONFIG.VIDEO.SPEED.MAX; speed += 0.1) {
            levels.push(parseFloat(speed.toFixed(1)));
        }
        return levels;
    }

    static getNextSpeed(currentSpeed, direction) {
        const levels = this.getSpeedLevels();

        // 現在速度を正規化（浮動小数点精度問題対策）
        const normalizedSpeed = Math.round(currentSpeed * 10) / 10;

        // 現在のレベルインデックスを見つける
        let currentIndex = -1;
        for (let i = 0; i < levels.length; i++) {
            if (Math.abs(levels[i] - normalizedSpeed) < 0.05) {
                currentIndex = i;
                break;
            }
        }

        // インデックスが見つからない場合の処理
        if (currentIndex === -1) {
            if (normalizedSpeed < levels[0]) {
                currentIndex = 0;
            } else if (normalizedSpeed > levels[levels.length - 1]) {
                currentIndex = levels.length - 1;
            } else {
                // 中間の値を見つける
                for (let i = 0; i < levels.length - 1; i++) {
                    if (normalizedSpeed >= levels[i] && normalizedSpeed < levels[i + 1]) {
                        currentIndex = direction > 0 ? i : i + 1;
                        break;
                    }
                }
            }
        }

        // 次のレベルを計算
        let targetIndex;
        if (direction > 0) {
            // 速度を上げる
            targetIndex = currentIndex + 1;
            if (targetIndex >= levels.length) {
                return levels[levels.length - 1]; // 最大値を返す
            }
        } else {
            // 速度を下げる
            targetIndex = currentIndex - 1;
            if (targetIndex < 0) {
                return levels[0]; // 最小値を返す
            }
        }

        return levels[targetIndex];
    }

    static isValidSpeed(speed) {
        return speed >= CONFIG.VIDEO.SPEED.MIN && speed <= CONFIG.VIDEO.SPEED.MAX;
    }

    static formatSpeed(speed) {
        return speed.toFixed(1);
    }

    static getSpeedDisplayClass(speed) {
        if (speed < 1.0) return 'speed-slow';
        if (speed > 1.0) return 'speed-fast';
        return 'speed-changed';
    }
}

// === UI操作クラス ===
class UIController {
    static setPlayPauseState(button, isPlaying) {
        if (!button) return;
        button.innerHTML = isPlaying ? '⏸️' : '▶️';
        button.title = isPlaying ? '一時停止' : '再生';
    }

    static updateTrimMarkers(side, player) {
        const video = player.video;
        const trimMarkers = Utils.getElementById(`trim-markers-${side}`);
        if (!video.duration || !trimMarkers) return;

        // FFmpeg基準の総フレーム数を取得
        const totalFrames = player.videoInfo?.totalFrames;
        if (!totalFrames) return;

        // 既存マーカーをクリア
        trimMarkers.querySelectorAll('.trim-marker').forEach(marker => marker.remove());
        trimMarkers.querySelectorAll('.trim-range').forEach(range => range.remove());
        trimMarkers.querySelectorAll('.sync-playable-range').forEach(range => range.remove());

        // マーカー作成（フレーム基準）
        const createMarker = (className, frameNumber, title, side) => {
            if (frameNumber === null || frameNumber === undefined) return;
            const marker = document.createElement('div');
            marker.className = `trim-marker ${className}`;
            // フレーム基準のパーセンテージでマーカー位置を設定
            const percent = PreciseFrameManager.frameToPercentage(frameNumber, totalFrames);
            marker.style.left = `${percent}%`;
            marker.title = title;
            marker.style.cursor = 'pointer';
            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                // フレーム番号から正確な時間を計算してシーク
                const targetTime = PreciseFrameManager.getFrameCenterTime(frameNumber, player.fps);
                video.currentTime = targetTime;
                // 親画面かつ同期モード時は子画面も頭出し
                if (
                    side === 'left' &&
                    window.videoPlayer &&
                    window.videoPlayer.parentChildMode &&
                    window.videoPlayer.syncEnabled
                ) {
                    const rightPlayer = window.videoPlayer.players.right;
                    const rightVideo = rightPlayer.video;
                    if (rightVideo && rightVideo.duration) {
                        const rightTargetFrame = frameNumber + window.videoPlayer.syncFrameOffset;
                        const rightTargetTime = PreciseFrameManager.getFrameCenterTime(rightTargetFrame, rightPlayer.fps);
                        rightVideo.currentTime = rightTargetTime;
                    }
                }
            });
            trimMarkers.appendChild(marker);
        };

        // フレーム番号から直接マーカーを表示
        if (player.trimInFrame !== null) {
            createMarker('in', player.trimInFrame, `開始: F${player.trimInFrame}`, side);
        }
        if (player.trimOutFrame !== null) {
            createMarker('out', player.trimOutFrame, `終了: F${player.trimOutFrame}`, side);
        }

        // 同期再生モード時は下バー範囲（緑色）のみ、通常時は上バー範囲（青色）のみ
        if (window.videoPlayer && window.videoPlayer.syncEnabled &&
            window.videoPlayer.syncPoints.left.isSet && window.videoPlayer.syncPoints.right.isSet) {
            // 下バー範囲（緑色）- 同期再生可能範囲表示
            const syncRange = window.videoPlayer.calculateSyncPlayableRange(side);
            if (syncRange) {
                const syncMinPercent = PreciseFrameManager.frameToPercentage(syncRange.minFrame, totalFrames);
                const syncMaxPercent = PreciseFrameManager.frameToPercentage(syncRange.maxFrame, totalFrames);

                const syncRangeElement = document.createElement('div');
                syncRangeElement.className = 'sync-playable-range';
                syncRangeElement.style.left = `${syncMinPercent}%`;
                syncRangeElement.style.width = `${syncMaxPercent - syncMinPercent}%`;
                syncRangeElement.title = `同期再生可能範囲: F${syncRange.minFrame}~F${syncRange.maxFrame}`;
                trimMarkers.appendChild(syncRangeElement);
            }
        } else {
            // 上バー範囲（青色）- トリミング範囲表示（通常時のみ）
            if (
                player.trimInFrame !== null &&
                player.trimOutFrame !== null &&
                player.trimOutFrame > player.trimInFrame
            ) {
                const inPercent = PreciseFrameManager.frameToPercentage(player.trimInFrame, totalFrames);
                const outPercent = PreciseFrameManager.frameToPercentage(player.trimOutFrame, totalFrames);
                const range = document.createElement('div');
                range.className = 'trim-range';
                range.style.left = `${inPercent}%`;
                range.style.width = `${outPercent - inPercent}%`;
                trimMarkers.appendChild(range);
            }
        }
    }

    static updatePlayerControlStates(parentChildMode) {
        const leftPlayer = Utils.getElementById('left-player');
        const rightPlayer = Utils.getElementById('right-player');

        if (leftPlayer && rightPlayer) {
            if (parentChildMode) {
                leftPlayer.classList.add('parent-mode');
                rightPlayer.classList.add('child-mode');
            } else {
                leftPlayer.classList.remove('parent-mode', 'child-mode');
                rightPlayer.classList.remove('parent-mode', 'child-mode');
            }
        }
    }

    static disableControls(side) {
        const playerElement = Utils.getElementById(`${side}-player`);
        if (!playerElement) return;

        const buttons = playerElement.querySelectorAll('.controls button:not(.sync-point-button):not(.trim-cut):not(.smart-cut):not(.trim-encode):not(.frame-save):not(.frame-sequence)');
        buttons.forEach(button => {
            button.disabled = true;
            button.addEventListener('click', this.preventControlAction, true);
        });

        const slider = Utils.getElementById(`position-${side}`);
        if (slider) {
            slider.disabled = true;
            slider.addEventListener('input', this.preventControlAction, true);
        }
    }

    static enableControls(side) {
        const playerElement = Utils.getElementById(`${side}-player`);
        if (!playerElement) return;

        const buttons = playerElement.querySelectorAll('.controls button:not(.sync-point-button)');
        buttons.forEach(button => {
            button.disabled = false;
            button.removeEventListener('click', this.preventControlAction, true);
        });

        const slider = Utils.getElementById(`position-${side}`);
        if (slider) {
            slider.disabled = false;
            slider.removeEventListener('input', this.preventControlAction, true);
        }
    }

    static preventControlAction(event) {
        event.preventDefault();
        event.stopPropagation();
        if (window.videoPlayer) {
            window.videoPlayer.updateStatus(CONFIG.MESSAGES.ERROR.CHILD_CONTROL_DISABLED);
        }
        return false;
    }

    // === ズーム・パン用UI更新 ===
    static updateZoomDisplay(side, zoom) {
        const zoomDisplay = Utils.getElementById(`zoom-display-${side}`);
        if (zoomDisplay) {
            zoomDisplay.textContent = `${ZoomPanController.formatZoom(zoom)}%`;
        }
    }

    static setCursor(element, cursor) {
        if (element) element.style.cursor = cursor;
    }

    // UIControllerにトリミング範囲バーの更新関数を追加
    // static updateTrimRangeBar(side, player) {
    //     const video = player.video;
    //     const slider = document.getElementById(`position-${side}`);
    //     const sliderContainer = slider?.parentElement;
    //     if (!video || !sliderContainer || !slider) return;

    //     // 既存のtrim-rangeを削除
    //     const oldRange = sliderContainer.querySelector('.trim-range');
    //     if (oldRange) oldRange.remove();

    //     // 両方の値が有効な場合のみ表示
    //     if (player.trimInPoint !== null && player.trimOutPoint !== null && player.trimOutPoint > player.trimInPoint) {
    //         const inPercent = (player.trimInPoint / video.duration) * 100;
    //         const outPercent = (player.trimOutPoint / video.duration) * 100;

    //         // スライダーの実際の幅とthumbサイズを取得
    //         const sliderRect = slider.getBoundingClientRect();
    //         const sliderWidth = sliderRect.width;
    //         // CSS変数からthumbサイズを取得（デフォルト16px）
    //         const thumbSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slider-thumb-size')) || 16;

    //         // オフセット補正
    //         const leftPx = sliderWidth * (inPercent / 100) - thumbSize / 2;
    //         const rightPx = sliderWidth * (outPercent / 100) - thumbSize / 2;
    //         const range = document.createElement('div');
    //         range.className = 'trim-range';
    //         range.style.left = `${leftPx}px`;
    //         range.style.width = `${rightPx - leftPx}px`;
    //         sliderContainer.appendChild(range);
    //     }
    // }
}

// === 処理操作クラス ===
class ProcessingController {
    static getCamPrefix(side) {
        return side === 'left' ? 'cam1' : 'cam2';
    }

    static getDefaultSavePath(player, fallbackName) {
        // 元のファイルパスがあればそちらのディレクトリを優先（変換済み動画の対策）
        const pathRef = player?.originalPath || player?.videoPath;
        if (pathRef) {
            const directory = path.dirname(pathRef);
            return path.join(directory, fallbackName);
        }
        return fallbackName;
    }

    static getDefaultDirectory(player) {
        // 元のファイルパスがあればそちらのディレクトリを優先
        const pathRef = player?.originalPath || player?.videoPath;
        if (pathRef) {
            return path.dirname(pathRef);
        }
        return undefined;
    }

    static async executeTrim(operation, side, player, videoPlayer) {
        let result; // スコープを最上位に移動

        const validation = Utils.validateVideoLoaded(player);
        if (!validation.valid) {
            videoPlayer.updateStatus(validation.message);
            return;
        }

        // フレーム基準トリミング点の検証
        const trimValidation = Utils.validateTrimPoints(player);
        if (!trimValidation.valid) {
            videoPlayer.updateStatus('トリミング範囲が設定されていません');
            return;
        }

        // フレーム基準トリミング点の存在確認
        if (!player.trimInFrame || !player.trimOutFrame) {
            videoPlayer.updateStatus('フレーム基準トリミング点が設定されていません');
            return;
        }

        try {
            const configs = {
                cut: { title: '高速カット', suffix: '_cut', ipcChannel: 'trim-cut' },
                encode: { title: '再エンコード', suffix: '_encoded', ipcChannel: 'trim-video' }
            };
            const config = configs[operation];
            const camPrefix = this.getCamPrefix(side);

            const saveOptions = await ipcRenderer.invoke('show-save-dialog', {
                title: `${config.title}（${Utils.getSideLabel(side)}）`,
                defaultPath: this.getDefaultSavePath(player, `${camPrefix}${config.suffix}.mp4`),
                filters: CONFIG.FILE_FILTERS.VIDEO
            });

            if (saveOptions.canceled) return;

            videoPlayer.showProgressBar(true);
            videoPlayer.updateProgress(0, `${config.title}処理を開始...`);

            // デフォルトはプレイヤー設定値を使用
            let startFrame = player.trimInFrame;
            let endFrame = player.trimOutFrame;

            // --- 修正: 右画面かつ同期モード時はフレーム基準でオフセットを加味 ---
            if (videoPlayer.parentChildMode && side === 'right' && videoPlayer.syncEnabled) {
                const leftPlayer = videoPlayer.players.left;
                const rightPlayer = videoPlayer.players.right;

                // 左画面のFFmpeg基準フレーム数を取得
                const leftTotalFrames = leftPlayer.videoInfo?.totalFrames;
                const rightTotalFrames = rightPlayer.videoInfo?.totalFrames;
                if (!leftTotalFrames || !rightTotalFrames) {
                    videoPlayer.updateStatus('FFmpeg基準のフレーム数が取得できません');
                    return;
                }

                // 左画面のフレーム基準トリミング点を使用
                const leftInFrame = leftPlayer.trimInFrame;
                const leftOutFrame = leftPlayer.trimOutFrame;

                // フレーム基準トリミング点が設定されていない場合は処理を中止
                if (!leftInFrame || !leftOutFrame) {
                    videoPlayer.updateStatus('左画面のフレーム基準トリミング点が設定されていません');
                    return;
                }

                // 右画面の対応フレーム（フレーム差分を維持）
                // 計算結果を変数に保存
                startFrame = leftInFrame + videoPlayer.syncFrameOffset;
                endFrame = leftOutFrame + videoPlayer.syncFrameOffset;

                // 右画面の境界チェック
                if (startFrame < 1 || endFrame > rightTotalFrames) {
                    videoPlayer.updateStatus('右画面のトリミング範囲が動画の範囲外です');
                    return;
                }

                videoPlayer.updateStatus(`同期トリミング: 左F${leftInFrame}-${leftOutFrame} → 右F${startFrame}-${endFrame}`);
            }

            // 厳密なフレーム情報の取得
            const totalFrames = player.videoInfo?.totalFrames;
            if (!totalFrames) {
                videoPlayer.updateStatus('動画情報が取得できません');
                return;
            }

            const requestData = {
                inputPath: player.videoPath,
                outputPath: saveOptions.filePath,
                // フレーム番号（1ベース）
                startFrame: startFrame,
                endFrame: endFrame,
                // 高精度時間計算（計算したフレーム番号を使用）
                startTime: PreciseFrameManager.getTimeFromFrame(startFrame, player.fps),
                endTime: PreciseFrameManager.getTimeFromFrame(endFrame + 1, player.fps),
                duration: (endFrame - startFrame + 1) / player.fps,
                fps: player.fps,
                totalFrames: totalFrames,
                format: 'mp4'
            };

            if (operation === 'encode') {
                requestData.inputFPS = player.fps;
            }

            try {
                result = await ipcRenderer.invoke(config.ipcChannel, requestData);
            } catch (ipcError) {
                console.error('IPC invoke error:', ipcError);
                throw new Error(`IPC通信エラー: ${ipcError.message}`);
            }

            if (result.success) {
                videoPlayer.updateProgress(100, `${config.title}完了！`);
                videoPlayer.updateStatus(`${config.title}完了: ${saveOptions.filePath}`);

                // プロジェクトステータス更新 (Launcher連携)
                ipcRenderer.invoke('update-project-status', { step: 'videoSyncLab', status: 'completed' })
                    .catch(err => console.error('Status update failed:', err));

                setTimeout(() => videoPlayer.showProgressBar(false), CONFIG.UI.PROGRESS_HIDE_DELAY);
            } else {
                throw new Error(result.error || '処理に失敗しました');
            }

        } catch (error) {
            console.error(`${operation} error:`, error);

            // resultオブジェクトの詳細情報も表示
            if (result && result.details) {
                console.error('Error details:', result.details);
            }
            if (result && result.error && result.error !== error.message) {
                console.error('Additional error info:', result.error);
            }

            // エラーメッセージを詳細に表示
            const errorMessage = error.message || '不明なエラーが発生しました';

            // 複数行のエラーメッセージを改行で分割して表示
            if (errorMessage.includes('\n')) {
                const errorLines = errorMessage.split('\n');
                console.error(`=== ${operation} 詳細エラー情報 ===`);
                errorLines.forEach((line, index) => {
                    console.error(`${index + 1}: ${line}`);
                });

                // ステータスには最初の行のみ表示
                videoPlayer.updateStatus(`${operation}エラー: ${errorLines[0]}`);
            } else {
                videoPlayer.updateStatus(`${operation}エラー: ${errorMessage}`);
            }

            videoPlayer.showProgressBar(false);
        }
    }

    static async saveFrame(side, player, videoPlayer) {
        const validation = Utils.validateVideoLoaded(player);
        if (!validation.valid) {
            videoPlayer.updateStatus(validation.message);
            return;
        }

        try {
            // FFmpeg基準の総フレーム数を取得
            const totalFrames = player.videoInfo?.totalFrames;
            if (!totalFrames) {
                videoPlayer.updateStatus(CONFIG.MESSAGES.ERROR.VIDEO_NOT_LOADED);
                return;
            }

            // FFmpeg基準での正確なフレーム番号を取得
            const currentFrame = PreciseFrameManager.timeToFrame(
                player.video.currentTime,
                player.fps,
                totalFrames
            );

            // FFmpeg基準の正確な時間を計算
            const exactTimestamp = PreciseFrameManager.frameToTime(currentFrame, player.fps);

            const frameStr = String(currentFrame).padStart(6, '0');
            const camPrefix = this.getCamPrefix(side);
            const defaultFileName = `${camPrefix}_${frameStr}_image.jpg`;

            const saveOptions = await ipcRenderer.invoke('show-save-dialog', {
                title: `フレーム保存（${Utils.getSideLabel(side)}）`,
                defaultPath: this.getDefaultSavePath(player, defaultFileName),
                filters: CONFIG.FILE_FILTERS.IMAGE_ALL
            });

            if (saveOptions.canceled) return;

            // FFmpeg基準の正確な時間を使用
            const result = await ipcRenderer.invoke('save-frame', {
                inputPath: player.videoPath,
                outputPath: saveOptions.filePath,
                timestamp: exactTimestamp,
                frameNumber: currentFrame  // フレーム番号も渡す
            });

            if (result.success) {
                videoPlayer.updateStatus(`フレーム${currentFrame}を保存しました: ${saveOptions.filePath}`);
            } else {
                throw new Error(result.error);
            }

        } catch (error) {
            console.error('Frame save error:', error);
            videoPlayer.updateStatus(`フレーム保存エラー: ${error.message}`);
        }
    }

    static async executeDualOutput(videoPlayer) {
        // 二画面同期モードの確認
        if (!videoPlayer.syncEnabled || !videoPlayer.parentChildMode) {
            videoPlayer.updateStatus('二画面同期モードで実行してください');
            return;
        }

        // 両方の動画が読み込まれているか確認
        const leftPlayer = videoPlayer.players.left;
        const rightPlayer = videoPlayer.players.right;

        if (!leftPlayer.videoPath || !rightPlayer.videoPath) {
            videoPlayer.updateStatus('両方の動画を読み込んでください');
            return;
        }

        // フレーム基準トリミング点の検証（既存のexecuteTrimと同じ方法）
        const leftTrimValidation = Utils.validateTrimPoints(leftPlayer);
        if (!leftTrimValidation.valid) {
            videoPlayer.updateStatus('左画面のトリミング範囲が設定されていません');
            return;
        }

        const rightTrimValidation = Utils.validateTrimPoints(rightPlayer);
        if (!rightTrimValidation.valid) {
            videoPlayer.updateStatus('右画面のトリミング範囲が設定されていません');
            return;
        }

        // フレーム基準トリミング点の存在確認（既存のexecuteTrimと同じ方法）
        if (!leftPlayer.trimInFrame || !leftPlayer.trimOutFrame) {
            videoPlayer.updateStatus('左画面のフレーム基準トリミング点が設定されていません');
            return;
        }

        if (!rightPlayer.trimInFrame || !rightPlayer.trimOutFrame) {
            videoPlayer.updateStatus('右画面のフレーム基準トリミング点が設定されていません');
            return;
        }

        try {
            const camPrefix = this.getCamPrefix('left');
            const childPrefix = this.getCamPrefix('right');
            const saveOptions = await ipcRenderer.invoke('show-save-dialog', {
                title: '二画面動画結合出力',
                defaultPath: this.getDefaultSavePath(leftPlayer, `${camPrefix}_${childPrefix}_combined.mp4`),
                filters: CONFIG.FILE_FILTERS.VIDEO
            });

            if (saveOptions.canceled) return;

            videoPlayer.showProgressBar(true);
            videoPlayer.updateProgress(0, '二画面動画結合処理を開始...');

            // フレーム基準トリミング点の取得（既存のexecuteTrimと同じ方法）
            const leftInFrame = leftPlayer.trimInFrame;
            const leftOutFrame = leftPlayer.trimOutFrame;
            const rightInFrame = rightPlayer.trimInFrame;
            const rightOutFrame = rightPlayer.trimOutFrame;

            // FPS情報の取得
            const leftFPS = leftPlayer.fps || 30;
            const rightFPS = rightPlayer.fps || 30;

            const requestData = {
                leftVideoPath: leftPlayer.videoPath,
                rightVideoPath: rightPlayer.videoPath,
                outputPath: saveOptions.filePath,
                syncOffset: videoPlayer.syncOffset,
                leftInFrame: leftInFrame,
                leftOutFrame: leftOutFrame,
                rightInFrame: rightInFrame,
                rightOutFrame: rightOutFrame,
                leftFPS: leftFPS,
                rightFPS: rightFPS
            };

            const result = await ipcRenderer.invoke('dual-output', requestData);

            if (result.success) {
                videoPlayer.updateStatus(result.message);
                // 出力フォルダを開く
                const outputDir = path.dirname(saveOptions.filePath);
                await ipcRenderer.invoke('open-folder', outputDir);
            } else {
                videoPlayer.updateStatus('二画面動画結合に失敗しました: ' + result.error);
            }
        } catch (error) {
            videoPlayer.updateStatus('二画面動画結合エラー: ' + error.message);
        } finally {
            videoPlayer.showProgressBar(false);
        }
    }

    static async saveFrameSequence(side, player, videoPlayer) {
        const validation = Utils.validateVideoLoaded(player);
        if (!validation.valid) {
            videoPlayer.updateStatus(validation.message);
            return;
        }

        // フレーム基準のトリミング点を確認
        let startFrame, endFrame;
        const trimValidation = Utils.validateTrimPoints(player);
        if (!trimValidation.valid) {
            // トリミング範囲が未設定の場合は全体を対象にする
            if (player.videoInfo?.totalFrames) {
                startFrame = 1;
                endFrame = player.videoInfo.totalFrames;
            } else {
                videoPlayer.updateStatus('動画情報が取得できません');
                return;
            }
        } else {
            // フレーム基準のトリミング点を使用
            if (player.trimInFrame !== null && player.trimOutFrame !== null) {
                startFrame = player.trimInFrame;
                endFrame = player.trimOutFrame;
            } else {
                videoPlayer.updateStatus('フレーム基準のトリミング点が設定されていません');
                return;
            }
        }

        try {
            // 保存先ディレクトリ選択
            const saveOptions = await ipcRenderer.invoke('show-save-dialog', {
                title: `連番フレーム出力（${Utils.getSideLabel(side)}）`,
                properties: ['openDirectory'],
                defaultPath: this.getDefaultDirectory(player)
            });
            if (saveOptions.canceled) return;

            videoPlayer.showProgressBar(true);
            videoPlayer.updateProgress(0, '連番フレーム出力を開始...');

            // 同期モード時のフレーム数統一処理
            let targetFrameCount = null;

            if (videoPlayer.parentChildMode && videoPlayer.syncEnabled &&
                videoPlayer.players.left.hasTrimPoints && videoPlayer.players.right.hasTrimPoints) {
                // 左画面のFFmpeg基準フレーム数を基準にする
                const leftPlayer = videoPlayer.players.left;
                const leftTotalFrames = leftPlayer.videoInfo?.totalFrames;
                if (leftTotalFrames) {
                    const leftInFrame = leftPlayer.trimInFrame;
                    const leftOutFrame = leftPlayer.trimOutFrame;

                    // フレーム基準トリミング点が設定されていない場合は処理を中止
                    if (!leftInFrame || !leftOutFrame) {
                        videoPlayer.updateStatus('左画面のフレーム基準トリミング点が設定されていません');
                        return;
                    }

                    targetFrameCount = leftOutFrame - leftInFrame + 1;
                }

                // 右画面の場合はフレームオフセットを加味
                if (side === 'right') {
                    const leftInFrame = leftPlayer.trimInFrame;
                    const leftOutFrame = leftPlayer.trimOutFrame;
                    if (leftInFrame !== null && leftOutFrame !== null) {
                        startFrame = leftInFrame + videoPlayer.syncFrameOffset;
                        endFrame = leftOutFrame + videoPlayer.syncFrameOffset;
                    }
                }
            }

            const requestData = {
                inputPath: player.videoPath,
                outputDir: saveOptions.filePaths[0],
                startFrame,
                endFrame,
                fps: player.fps,
                forceFrameCount: targetFrameCount // 同期時は統一フレーム数
            };

            const result = await ipcRenderer.invoke('save-frame-sequence', requestData);

            if (result.success) {
                // main.jsからのメッセージで表示されるため、ここでの重複表示は不要
                setTimeout(() => videoPlayer.showProgressBar(false), CONFIG.UI.PROGRESS_HIDE_DELAY);
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            videoPlayer.updateStatus(`連番フレーム出力エラー: ${error.message}`);
            videoPlayer.showProgressBar(false);
        }
    }
}

// === メインアプリケーションクラス ===
class VideoSyncLab {
    constructor() {
        this.players = {
            left: this.createPlayerObject('left'),
            right: this.createPlayerObject('right')
        };
        this.syncPoints = {
            left: { time: null, frame: null, isSet: false },
            right: { time: null, frame: null, isSet: false }
        };
        this.syncOffset = 0;
        this.syncFrameOffset = 0; // フレーム数ベースのオフセット
        this.syncEnabled = false;
        this.parentChildMode = false;
        this.currentViewMode = 'single';
        this.statusMessage = Utils.getElementById('status-message');
        this.activeSide = 'left';
        this.isSeeking = { left: false, right: false };

        // フレームステップ用（疑似連打）
        this.pseudoRepeatTimeoutId = null;
        this.pseudoRepeatIntervalId = null;

        this.initializeEventListeners();
        this.initializeDragAndDrop();
        this.startFrameInfoUpdater();

        // 初期化時に二画面動画出力ボタンを無効化
        const dualOutputButtons = document.querySelectorAll('.dual-output-button');
        dualOutputButtons.forEach(button => {
            button.disabled = true;
        });

        // ストロボモーションコントローラーの初期化
        this.strobeMotionController = null;
        this.initStrobeMotion();
    }

    // ストロボモーション初期化
    initStrobeMotion() {
        if (typeof StrobeMotionController !== 'undefined') {
            this.strobeMotionController = new StrobeMotionController(this);
        } else {
            // StrobeMotionController not loaded
        }
    }

    // ストロボモーションを有効化
    activateStrobeMotion(side) {
        if (!this.strobeMotionController) {
            this.updateStatus('ストロボモーション機能が利用できません');
            return;
        }

        const player = this.players[side];
        if (!player.video || !player.videoPath) {
            this.updateStatus('先に動画を読み込んでください');
            return;
        }

        this.strobeMotionController.activate(side);
    }

    // === ヘルパーメソッド ===
    // プレイヤーとビデオ要素を一度に取得
    getPlayerAndVideo(side) {
        const player = this.players[side];
        return { player, video: player?.video };
    }

    // 両方のサイドに対して処理を実行
    forEachSide(callback) {
        ['left', 'right'].forEach(side => callback(side, this.players[side]));
    }

    // フレーム番号が有効範囲内かチェック
    isValidFrame(frame, totalFrames) {
        return frame >= 1 && frame <= totalFrames;
    }

    createPlayerObject(side) {
        const videoElement = Utils.getElementById(`video-${side}`);
        if (!videoElement) {
            console.error(`CRITICAL: Video element not found during initialization: video-${side}`);
        }

        return {
            video: videoElement,
            frameInfo: Utils.getElementById(`frame-info-${side}`),
            positionSlider: Utils.getElementById(`position-${side}`),

            speedSelect: Utils.getElementById(`speed-select-${side}`),
            // speedSlider, speedValueは廃止
            trimInPoint: null,
            trimOutPoint: null,
            trimInFrame: null,
            trimOutFrame: null,
            hasTrimPoints: false,
            videoInfo: null,
            fps: CONFIG.VIDEO.DEFAULT_FPS,
            videoPath: null,
            currentFrame: 1,  // FFmpeg基準の現在フレーム番号
            playbackRate: CONFIG.VIDEO.SPEED.DEFAULT,
            zoom: CONFIG.VIDEO.ZOOM.DEFAULT,
            panX: 0,
            panY: 0,
            isDragging: false,
            dragStartX: 0,
            dragStartY: 0,
            dragStartPanX: 0,
            dragStartPanY: 0,
            // パフォーマンス最適化用
            lastDisplayedFrame: -1,      // 最後に表示したフレーム番号
            lastFrameInfoText: '',       // 最後に表示したフレーム情報テキスト
            sliderAnimationId: null,     // スライダーアニメーションID
            seekedHandler: null,         // seekedイベントハンドラー
            trimLoopCallbackId: null     // requestVideoFrameCallback ID
        };
    }

    // === ズーム・パン制御メソッド ===
    changeZoom(side, direction) {
        const player = this.players[side];

        if (!player.video) {
            this.updateStatus(CONFIG.MESSAGES.ERROR.VIDEO_NOT_LOADED);
            return;
        }

        const currentZoom = player.zoom;
        const newZoom = ZoomPanController.calculateZoomStep(currentZoom, direction);

        if (newZoom === currentZoom) {
            const limitMessage = direction > 0 ?
                CONFIG.MESSAGES.STATUS.ZOOM_LIMIT_MAX :
                CONFIG.MESSAGES.STATUS.ZOOM_LIMIT_MIN;
            this.updateStatus(limitMessage);
            return;
        }

        this.setZoom(side, newZoom);
    }

    // === wheelZoom メソッドの修正 ===
    wheelZoom(side, deltaY, mouseX, mouseY) {
        const player = this.players[side];
        if (!player.video) return;

        const currentZoom = player.zoom;
        const newZoom = ZoomPanController.calculateWheelZoom(currentZoom, deltaY);
        if (newZoom === currentZoom) return;

        // 動画中心座標
        const video = player.video;
        const rect = video.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        // マウス座標を「動画中心」基準に変換
        const mouseFromCenterX = mouseX - centerX;
        const mouseFromCenterY = mouseY - centerY;

        // ズーム前の動画座標系でのマウス位置
        const mouseVideoX = mouseFromCenterX / currentZoom - player.panX;
        const mouseVideoY = mouseFromCenterY / currentZoom - player.panY;

        // ズーム後も同じ動画上の点が同じ画面座標に来るようにパンを調整
        const newPanX = (mouseFromCenterX / newZoom) - mouseVideoX;
        const newPanY = (mouseFromCenterY / newZoom) - mouseVideoY;

        // パン範囲制限
        const bounds = ZoomPanController.calculatePanBounds(player.video, newZoom);
        const constrainedPan = ZoomPanController.constrainPan(newPanX, newPanY, bounds);

        player.panX = constrainedPan.x;
        player.panY = constrainedPan.y;

        this.setZoom(side, newZoom);
    }

    setZoom(side, zoom) {
        const player = this.players[side];

        if (!ZoomPanController.isValidZoom(zoom)) return;

        player.zoom = zoom;

        // パンの境界を再計算して調整
        const bounds = ZoomPanController.calculatePanBounds(player.video, zoom);
        const constrainedPan = ZoomPanController.constrainPan(player.panX, player.panY, bounds);
        player.panX = constrainedPan.x;
        player.panY = constrainedPan.y;

        ZoomPanController.applyTransform(player.video, zoom, player.panX, player.panY);
        UIController.updateZoomDisplay(side, zoom);

        // ストロボモーションの選択範囲を再描画
        this.notifyStrobeMotionZoomPanChange(side);

        // ズーム変更のコメント表示は不要のため削除
        // this.updateStatus(CONFIG.MESSAGES.STATUS.ZOOM_CHANGED(side, zoom));
    }

    resetZoomPan(side) {
        const player = this.players[side];

        if (!player.video) return;

        player.zoom = CONFIG.VIDEO.ZOOM.DEFAULT;
        player.panX = 0;
        player.panY = 0;

        ZoomPanController.resetTransform(player.video);
        UIController.updateZoomDisplay(side, CONFIG.VIDEO.ZOOM.DEFAULT);

        // ストロボモーションの選択範囲を再描画
        this.notifyStrobeMotionZoomPanChange(side);

        this.updateStatus(CONFIG.MESSAGES.STATUS.VIEW_RESET(side));
    }

    startPan(side, clientX, clientY) {
        const player = this.players[side];

        if (!player.video || player.zoom <= 1) return;

        player.isDragging = true;
        player.dragStartX = clientX;
        player.dragStartY = clientY;
        player.dragStartPanX = player.panX;
        player.dragStartPanY = player.panY;

        UIController.setCursor(player.video, 'grabbing');
        this.updateStatus(CONFIG.MESSAGES.STATUS.PAN_ACTIVE(side));
    }

    updatePan(side, clientX, clientY) {
        const player = this.players[side];

        if (!player.isDragging) return;

        const deltaX = (clientX - player.dragStartX) * CONFIG.VIDEO.PAN.SENSITIVITY;
        const deltaY = (clientY - player.dragStartY) * CONFIG.VIDEO.PAN.SENSITIVITY;

        const newPanX = player.dragStartPanX + deltaX / player.zoom;
        const newPanY = player.dragStartPanY + deltaY / player.zoom;

        const bounds = ZoomPanController.calculatePanBounds(player.video, player.zoom);
        const constrainedPan = ZoomPanController.constrainPan(newPanX, newPanY, bounds);

        player.panX = constrainedPan.x;
        player.panY = constrainedPan.y;

        ZoomPanController.applyTransform(player.video, player.zoom, player.panX, player.panY);

        // ストロボモーションの選択範囲を再描画
        this.notifyStrobeMotionZoomPanChange(side);
    }

    endPan(side) {
        const player = this.players[side];

        if (!player.isDragging) return;

        player.isDragging = false;
        UIController.setCursor(player.video, player.zoom > 1 ? 'grab' : 'default');
    }

    // === ストロボモーションへのズーム・パン変更通知 ===
    notifyStrobeMotionZoomPanChange(side) {
        console.log(`Debug: notifyStrobeMotionZoomPanChange called for side: ${side}`);
        if (this.strobeMotionController) {
            console.log(`Debug: Controller exists. isActive: ${this.strobeMotionController.isActive}, activeSide: ${this.strobeMotionController.activeSide}`);
            if (this.strobeMotionController.isActive &&
                this.strobeMotionController.activeSide === side) {
                console.log('Debug: Calling strobeMotionController.onZoomPanChange()');
                this.strobeMotionController.onZoomPanChange();
            } else {
                console.log('Debug: Condition failed');
            }
        } else {
            console.log('Debug: No strobeMotionController');
        }
    }

    // === 再生速度制御メソッド ===
    changePlaybackSpeed(side, direction) {
        if (this.isSeeking[side]) return;
        const player = this.players[side];

        if (!player.video) {
            this.updateStatus(CONFIG.MESSAGES.ERROR.VIDEO_NOT_LOADED);
            return;
        }

        if (this.parentChildMode && side === 'right') {
            this.updateStatus(CONFIG.MESSAGES.ERROR.CHILD_CONTROL_DISABLED);
            return;
        }

        const currentSpeed = player.playbackRate;
        const newSpeed = SpeedController.getNextSpeed(currentSpeed, direction);

        if (newSpeed === currentSpeed) {
            const limitMessage = direction > 0 ?
                CONFIG.MESSAGES.STATUS.SPEED_LIMIT_MAX :
                CONFIG.MESSAGES.STATUS.SPEED_LIMIT_MIN;
            this.updateStatus(limitMessage);
            return;
        }

        this.setPlaybackSpeed(side, newSpeed);
    }

    setPlaybackSpeed(side, speed) {
        const player = this.players[side];
        if (!player.video || !SpeedController.isValidSpeed(speed)) return;

        player.video.playbackRate = speed;
        player.playbackRate = speed;

        // ドロップダウンを更新
        const select = Utils.getElementById(`speed-select-${side}`);
        if (select && parseFloat(select.value) !== speed) {
            select.value = speed.toString();
        }

        this.updateSpeedInfo(side, speed);

        if (this.parentChildMode && side === 'left' && this.syncEnabled) {
            this.syncPlaybackSpeed(speed);
            this.updateStatus(CONFIG.MESSAGES.STATUS.SPEED_SYNC_CHANGED(SpeedController.formatSpeed(speed)));
        } else {
            this.updateStatus(CONFIG.MESSAGES.STATUS.SPEED_CHANGED(side, SpeedController.formatSpeed(speed)));
        }
    }

    syncPlaybackSpeed(speed) {
        const rightPlayer = this.players.right;

        if (!rightPlayer.video || !SpeedController.isValidSpeed(speed)) return;

        rightPlayer.video.playbackRate = speed;
        rightPlayer.playbackRate = speed;

        this.updateSpeedInfo('right', speed);
    }

    resetPlaybackSpeed(side) {
        if (this.parentChildMode && side === 'right') {
            this.updateStatus(CONFIG.MESSAGES.ERROR.CHILD_CONTROL_DISABLED);
            return;
        }
        const defaultSpeed = CONFIG.VIDEO.SPEED.DEFAULT;
        if (this.parentChildMode && side === 'left' && this.syncEnabled) {
            this.setPlaybackSpeed('left', defaultSpeed);
            this.setPlaybackSpeed('right', defaultSpeed);
            this.updateStatus('同期再生速度リセット: 1.0x');
            // ここで両方のUIも更新
            ['left', 'right'].forEach(s => {
                const slider = Utils.getElementById(`speed-slider-${s}`);
                const value = Utils.getElementById(`speed-value-${s}`);
                if (slider) slider.value = defaultSpeed.toString();
                if (value) value.textContent = `${defaultSpeed.toFixed(1)}x`;
            });
        } else {
            this.setPlaybackSpeed(side, defaultSpeed);
            this.updateStatus(`再生速度リセット（${Utils.getSideLabel(side)}）: 1.0x`);
            // ここでUIも更新
            const slider = Utils.getElementById(`speed-slider-${side}`);
            const value = Utils.getElementById(`speed-value-${side}`);
            if (slider) slider.value = defaultSpeed.toString();
            if (value) value.textContent = `${defaultSpeed.toFixed(1)}x`;
        }
    }

    updateSpeedInfo(side, speed) {
        const speedInfo = this.players[side].speedInfo;
        if (speedInfo) speedInfo.textContent = `速度: ${SpeedController.formatSpeed(speed)}x`;
    }

    // === プロジェクト管理機能 ===
    async saveProject() {
        const data = {
            version: "1.0",
            activeSide: this.activeSide,
            syncEnabled: this.syncEnabled,
            syncFrameOffset: this.syncFrameOffset,
            isParentChildMode: this.parentChildMode,
            players: {
                left: this.getPlayerState('left'),
                right: this.getPlayerState('right')
            }
        };
        const result = await ipcRenderer.invoke('save-project-file', data);
        if (result.success) {
            this.updateStatus(`プロジェクトを保存しました: ${result.filePath}`);
        } else if (!result.canceled) {
            this.updateStatus(`保存エラー: ${result.error}`);
        }
    }

    getPlayerState(side) {
        const p = this.players[side];
        return {
            path: p.videoPath,
            playbackRate: p.playbackRate,
            trimIn: p.trimInFrame,
            trimOut: p.trimOutFrame,
            currentFrame: p.currentFrame
        };
    }

    async openProject() {
        const result = await ipcRenderer.invoke('load-project-file');
        if (result.success) {
            await this.restoreProject(result.data);
            this.updateStatus(`プロジェクトを開きました: ${result.filePath}`);
        } else if (!result.canceled) {
            this.updateStatus(`読込エラー: ${result.error}`);
        }
    }

    async loadProject(filePath) {
        try {
            const fs = require('fs');
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            await this.restoreProject(data);
            this.updateStatus(`プロジェクトを開きました: ${filePath}`);
        } catch (e) {
            console.error(e);
            this.updateStatus(`読込エラー: ${e.message}`);
        }
    }

    async restoreProject(data) {
        // 状態リセット
        if (this.syncEnabled) this.toggleSync();

        // 動画読み込み
        if (data.players?.left?.path) await this.loadVideo('left', data.players.left.path);
        if (data.players?.right?.path) await this.loadVideo('right', data.players.right.path);

        // 状態復元
        if (data.players?.left) this.restorePlayerState('left', data.players.left);
        if (data.players?.right) this.restorePlayerState('right', data.players.right);

        if (data.syncEnabled) {
            // 同期モード有効化
            // toggleSyncは現在の状態を反転させるだけなので、確実にONにするには状態確認が必要
            if (!this.syncEnabled) this.toggleSync();
            this.syncFrameOffset = data.syncFrameOffset || 0;
            this.updateStatus('同期状態を復元しました');
        }

        if (data.isParentChildMode) {
            // 親子モード復元が必要ならここで処理（現在はUI上のトグルがないかも？）
            // this.toggleParentChildMode()などを呼び出す
        }
    }

    restorePlayerState(side, state) {
        const p = this.players[side];

        // 再生速度
        if (state.playbackRate && state.playbackRate !== 1.0) {
            this.setPlaybackSpeed(side, state.playbackRate);
        }

        // トリム範囲
        if (state.trimIn !== null) {
            p.trimInFrame = state.trimIn;
        }
        if (state.trimOut !== null) {
            p.trimOutFrame = state.trimOut;
        }
        // UI更新
        Utils.updateSliderBackground(p);

        // 現在位置
        if (state.currentFrame) {
            // シーク
            const time = PreciseFrameManager.getFrameCenterTime(state.currentFrame, p.fps);
            p.video.currentTime = time;
            p.currentFrame = state.currentFrame;
            this.updateFrameInfo(side);
        }
    }

    // === イベント初期化 ===
    initializeEventListeners() {
        // IPCイベント
        const ipcEvents = {
            'load-video': async (event, data) => await this.loadVideo(data.side, data.path),
            'switch-view': (event, mode) => this.switchViewMode(mode),
            'trim-progress': (event, data) => this.updateProgress(data.progress, data.message),
            'optimize-and-reload': (event, side) => this.optimizeAndReload(side),
            'project-save': () => this.saveProject(),
            'project-open': () => this.openProject(),
            'load-project': (event, path) => this.loadProject(path)
        };

        Object.entries(ipcEvents).forEach(([event, handler]) => {
            ipcRenderer.on(event, handler);
        });

        // キーボードショートカット
        document.addEventListener('keydown', (event) => {
            const side = this.activeSide || 'left';

            // スペースキーは常に再生/一時停止を優先（入力要素にフォーカスがあっても動作）
            if (event.code === 'Space') {
                this.togglePlayPause(side);
                event.preventDefault();
                return;
            }

            // その他のキーは入力要素にフォーカスがある場合はスキップ
            if (["INPUT", "TEXTAREA"].includes(event.target.tagName)) return;

            // 矢印左右キー：コマ送り・コマ戻し（疑似連打方式）
            if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') {
                const direction = event.code === 'ArrowRight' ? 1 : -1;

                // キーリピートは無視（疑似連打で処理）
                if (event.repeat) {
                    event.preventDefault();
                    return;
                }

                // 最初の押下：即座に実行 + 疑似連打開始
                this.frameStep(side, direction);
                this.startPseudoRepeat(side, direction);
                event.preventDefault();
            } else if (event.code === 'ArrowUp') {
                this.changePlaybackSpeed(side, 1);
                event.preventDefault();
            } else if (event.code === 'ArrowDown') {
                this.changePlaybackSpeed(side, -1);
                event.preventDefault();
            }
        });

        // キーアップ時に疑似連打を停止
        document.addEventListener('keyup', (event) => {
            if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') {
                this.stopPseudoRepeat();
            }
        });

        // プレーヤーイベント設定
        ['left', 'right'].forEach(side => this.setupPlayerEvents(side));

        // ドラッグ＆ドロップイベントの初期化
        this.initializeDragAndDrop();

        // プレイヤーエリアクリックでアクティブ側を記録
        ['left', 'right'].forEach(side => {
            const playerElem = Utils.getElementById(`${side}-player`);
            if (playerElem) {
                playerElem.addEventListener('mousedown', () => {
                    this.activeSide = side;
                    this.updateFrameStatusInfo(); // アクティブサイド変更時にフレーム情報を更新
                });
            }
        });
    }

    initializeDragAndDrop() {
        const leftPlayer = Utils.getElementById('left-player');
        const rightPlayer = Utils.getElementById('right-player');
        const container = Utils.getElementById('video-container');

        // 共通のドラッグオーバー処理
        const handleDragOver = (e, side) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.dataTransfer.types.includes('Files')) return;

            container.classList.add('drag-over');
            leftPlayer.classList.remove('drag-target');
            rightPlayer.classList.remove('drag-target');

            if (side === 'left') {
                leftPlayer.classList.add('drag-target');
                this.updateStatus('左画面にドロップできます（メイン画面）');
            } else if (side === 'right') {
                rightPlayer.classList.add('drag-target');
                this.updateStatus('右画面にドロップできます（比較画面）');
            }
        };

        // ドロップ処理
        const handleDrop = async (e, side) => {
            e.preventDefault();
            e.stopPropagation();
            container.classList.remove('drag-over');
            leftPlayer.classList.remove('drag-target');
            rightPlayer.classList.remove('drag-target');

            const files = e.dataTransfer.files;
            if (files.length === 0) {
                this.updateStatus('ファイルが選択されていません');
                return;
            }
            const file = files[0];
            const validExtensions = CONFIG.FILE_FILTERS.VIDEO[0].extensions;
            const extension = file.name.split('.').pop().toLowerCase();

            // プロジェクトファイル (.vsl) の場合
            if (extension === 'vsl') {
                try {
                    const filePath = webUtils.getPathForFile(file);
                    if (!filePath) throw new Error('Path retrieval failed');
                    await this.loadProject(filePath);
                    return;
                } catch (error) {
                    console.error('Project load error:', error);
                    this.updateStatus(`プロジェクト読込失敗: ${error.message}`);
                    return;
                }
            }

            if (!validExtensions.includes(extension)) {
                this.updateStatus(`対応していないファイル形式です。\n対応形式: ${validExtensions.join(', ')}`);
                return;
            }
            try {
                // Electronでのパス取得補正
                // File.path is deprecated in recent Electron versions.
                // Use webUtils.getPathForFile(file) instead.
                const filePath = webUtils.getPathForFile(file);

                if (!filePath) {
                    throw new Error('ファイルのパスを取得できませんでした (webUtils.getPathForFile returned null)。');
                }

                await this.loadVideo(side, filePath);
                this.updateStatus(`${Utils.getSideLabel(side)}画面に動画を読み込みました`);
                this.updateFrameStatusInfo(); // フレーム情報を更新
            } catch (error) {
                console.error('Drop handling error:', error);
                this.updateStatus(`動画の読み込みに失敗しました: ${error.message}`);
            }
        };

        // イベントリスナー登録
        leftPlayer.addEventListener('dragover', e => handleDragOver(e, 'left'));
        rightPlayer.addEventListener('dragover', e => handleDragOver(e, 'right'));
        leftPlayer.addEventListener('drop', e => handleDrop(e, 'left'));
        rightPlayer.addEventListener('drop', e => handleDrop(e, 'right'));

        // container全体のドラッグリーブ
        container.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            container.classList.remove('drag-over');
            leftPlayer.classList.remove('drag-target');
            rightPlayer.classList.remove('drag-target');
        });
    }

    isValidVideoFile(file) {
        const validExtensions = CONFIG.FILE_FILTERS.VIDEO[0].extensions;
        const extension = file.name.split('.').pop().toLowerCase();
        return validExtensions.includes(extension);
    }

    isDualMode() {
        return Utils.getElementById('video-container').classList.contains('dual-mode');
    }

    setupPlayerEvents(side) {
        const player = this.players[side];
        const video = player.video;

        if (!video) {
            return;
        }

        // ボタンイベント
        const buttonEvents = {
            [`open-${side}`]: () => this.openVideoDialog(side),
            [`play-pause-${side}`]: () => this.togglePlayPause(side),
            [`stop-${side}`]: () => this.stop(side),
            [`frame-back-${side}`]: () => this.frameStep(side, -1),
            [`frame-forward-${side}`]: () => this.frameStep(side, 1),
            [`trim-in-${side}`]: () => this.setTrimPoint(side, 'in'),
            [`trim-out-${side}`]: () => this.setTrimPoint(side, 'out'),
            [`smart-cut-${side}`]: () => ProcessingController.executeTrim('cut', side, player, this),
            [`trim-encode-${side}`]: () => ProcessingController.executeTrim('encode', side, player, this),
            [`sync-point-${side}`]: () => this.setSyncPoint(side),
            [`frame-save-${side}`]: () => ProcessingController.saveFrame(side, player, this),
            [`frame-sequence-${side}`]: () => ProcessingController.saveFrameSequence(side, player, this),
            [`dual-output-${side}`]: () => ProcessingController.executeDualOutput(this),
            // speed-reset is removed
            [`strobe-motion-${side}`]: () => this.activateStrobeMotion(side)
        };

        Object.entries(buttonEvents).forEach(([elementId, handler]) => {
            const element = Utils.getElementById(elementId);
            if (element) element.addEventListener('click', handler);
        });

        // スライダーイベント（FFmpeg基準のフレーム数）- requestAnimationFrameでスロットリング
        if (player.positionSlider) {
            // スライダー値を一時保存
            let pendingSliderValue = null;

            player.positionSlider.addEventListener('input', (e) => {
                if (!video.duration) return;

                // 値を保存
                pendingSliderValue = parseFloat(e.target.value);

                // 既にアニメーションフレームがスケジュールされている場合はスキップ
                if (player.sliderAnimationId) return;

                player.sliderAnimationId = requestAnimationFrame(() => {
                    player.sliderAnimationId = null;

                    if (pendingSliderValue === null) return;
                    const sliderValue = pendingSliderValue;
                    pendingSliderValue = null;

                    // FFmpeg基準の総フレーム数を優先使用
                    const totalFrames = player.videoInfo?.totalFrames;
                    if (!totalFrames) return;

                    // スライダー値は直接フレーム番号
                    let targetFrame = Math.round(sliderValue);

                    // 二画面同期再生モード時のみ境界クランプを適用
                    if (this.syncEnabled && this.syncPoints.left.isSet && this.syncPoints.right.isSet && this.parentChildMode) {
                        const syncRange = this.calculateSyncPlayableRange(side);
                        if (syncRange) {
                            // 緑範囲外に出ないようクランプ
                            targetFrame = Math.max(syncRange.minFrame, Math.min(syncRange.maxFrame, targetFrame));
                        }
                    }

                    // フレーム数の境界チェック
                    targetFrame = Math.max(1, Math.min(targetFrame, totalFrames));

                    // フレームが変わっていない場合はスキップ
                    if (targetFrame === player.currentFrame) return;

                    // 完全フレームベース：プレイヤーのフレーム番号を更新
                    player.currentFrame = targetFrame;

                    // HTML5 Videoにはフレームの中心時間を設定（ズレ防止）
                    const centerTime = PreciseFrameManager.getFrameCenterTime(targetFrame, player.fps);
                    video.currentTime = centerTime;

                    // スライダー操作時は即座に表示を更新
                    this.updateFrameInfo(side);

                    if (this.parentChildMode && side === 'left') {
                        this.syncSliderPositionByFrame(targetFrame);
                    }
                });
            });

            // スライダーのキーイベントを1コマ送り・戻しに変更（疑似連打方式）
            player.positionSlider.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault(); // スライダーのデフォルト動作を停止

                    // キーリピートは無視（疑似連打で処理）
                    if (e.repeat) return;

                    const direction = e.key === 'ArrowRight' ? 1 : -1;
                    this.frameStep(side, direction);
                    this.startPseudoRepeat(side, direction);
                }
            });

            // スライダーのキーアップで疑似連打を停止
            player.positionSlider.addEventListener('keyup', (e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    this.stopPseudoRepeat();
                }
            });
        }

        // === 再生速度スライダーイベント追加 ===
        // === 再生速度セレクトイベント ===
        const speedSelect = Utils.getElementById(`speed-select-${side}`);
        if (speedSelect) {
            speedSelect.addEventListener('change', (e) => {
                const newSpeed = parseFloat(e.target.value);
                this.setPlaybackSpeed(side, newSpeed);
                e.target.blur(); // フォーカス解除
            });
        }

        // === ズームリセットイベント ===
        const zoomResetBtn = Utils.getElementById(`zoom-reset-${side}`);
        if (zoomResetBtn) {
            zoomResetBtn.addEventListener('click', () => {
                this.resetZoomPan(side);
            });
        }

        // === ズーム・パン用マウスイベント ===
        const videoWrapper = video.parentElement;

        // マウスホイールイベント（ズーム）
        videoWrapper.addEventListener('wheel', (e) => {
            e.preventDefault();
            const mousePos = Utils.getMousePosition(e, video);
            this.wheelZoom(side, e.deltaY, mousePos.x, mousePos.y);
        }, { passive: false });

        // 右クリック時のコンテキストメニューを無効化（パンニング用）
        video.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        // マウスダウンイベント（パン開始）
        video.addEventListener('mousedown', (e) => {
            if (e.button === 2) { // 右クリックのみ
                e.preventDefault();
                this.startPan(side, e.clientX, e.clientY);
            }
        });

        // マウスムーブイベント（パン中）
        document.addEventListener('mousemove', (e) => {
            if (player.isDragging) {
                e.preventDefault();
                this.updatePan(side, e.clientX, e.clientY);
            }
        });

        // マウスアップイベント（パン終了）
        document.addEventListener('mouseup', (e) => {
            if (e.button === 2 && player.isDragging) {
                this.endPan(side);
            }
        });

        // マウスリーブイベント（ドラッグ中にマウスが範囲外に出た場合）
        document.addEventListener('mouseleave', () => {
            if (player.isDragging) {
                this.endPan(side);
            }
        });

        // カーソル更新
        video.addEventListener('mouseenter', () => {
            UIController.setCursor(video, player.zoom > 1 ? 'grab' : 'default');
        });

        video.addEventListener('mouseleave', () => {
            UIController.setCursor(video, 'default');
        });

        // 動画イベント
        const videoEvents = {
            'loadedmetadata': () => {
                // スライダーをフレーム基準に設定
                if (player.positionSlider) {
                    const totalFrames = player.videoInfo?.totalFrames || 100;
                    player.positionSlider.min = 1;
                    player.positionSlider.max = totalFrames;
                    player.positionSlider.value = 1;
                }
                player.lastDisplayedFrame = -1; // キャッシュをリセット
                this.updateFrameInfo(side);
                this.updateStatus(CONFIG.MESSAGES.STATUS.LOADED(side, player.fps));
                Utils.updateSliderBackground(player);

                // ズーム・パン初期化
                this.resetZoomPan(side);
                this.startTrimLoopMonitor(side);
            },
            'timeupdate': () => {
                // 再生中にフレーム番号を同期
                if (player.videoInfo?.totalFrames) {
                    const currentFrame = PreciseFrameManager.timeToFrame(
                        player.video.currentTime,
                        player.fps,
                        player.videoInfo.totalFrames
                    );

                    // フレームが変わった場合のみ更新（スロットリング）
                    if (currentFrame !== player.currentFrame) {
                        player.currentFrame = currentFrame;
                        this.updatePositionSlider(side);
                        this.updateFrameInfo(side);
                    }

                    if (typeof video.requestVideoFrameCallback !== 'function') {
                        this.handleTrimLoopPlayback(side);
                    }
                }
                // ✅ 再生中の補正は削除（自然同期に任せる）
                // Utils.updateSliderBackground は loadedmetadata と トリミング設定時のみ呼び出し
            },
            'error': (e) => {
                console.error(`Video error (${side}):`, e);
                this.updateStatus(`動画の読み込みに失敗しました（${Utils.getSideLabel(side)}）`);
            }
        };

        Object.entries(videoEvents).forEach(([event, handler]) => {
            video.addEventListener(event, handler);
        });
    }

    startTrimLoopMonitor(side) {
        const player = this.players[side];
        const video = player.video;

        if (!video || typeof video.requestVideoFrameCallback !== 'function') {
            return;
        }

        if (player.trimLoopCallbackId && typeof video.cancelVideoFrameCallback === 'function') {
            video.cancelVideoFrameCallback(player.trimLoopCallbackId);
            player.trimLoopCallbackId = null;
        }

        const monitor = (_now, metadata) => {
            this.handleTrimLoopPlayback(side, metadata);
            player.trimLoopCallbackId = video.requestVideoFrameCallback(monitor);
        };

        player.trimLoopCallbackId = video.requestVideoFrameCallback(monitor);
    }

    handleTrimLoopPlayback(side, metadata) {
        const player = this.players[side];
        const video = player.video;
        const totalFrames = player.videoInfo?.totalFrames;

        if (
            !video ||
            video.paused ||
            !player.hasTrimPoints ||
            !player.trimInFrame ||
            !player.trimOutFrame ||
            !totalFrames
        ) {
            return;
        }

        const mediaTime = (metadata && typeof metadata.mediaTime === 'number')
            ? metadata.mediaTime
            : video.currentTime;

        const currentFrame = PreciseFrameManager.timeToFrame(mediaTime, player.fps, totalFrames);
        if (currentFrame <= player.trimOutFrame) {
            return;
        }

        const seekToTrimStart = (targetSide) => {
            const targetPlayer = this.players[targetSide];
            const targetVideo = targetPlayer.video;
            if (!targetVideo || !targetPlayer.trimInFrame) return;

            const restartTime = PreciseFrameManager.getFrameCenterTime(targetPlayer.trimInFrame, targetPlayer.fps);
            targetVideo.currentTime = restartTime;
            if (targetVideo.paused) {
                targetVideo.play();
            }
            targetPlayer.currentFrame = targetPlayer.trimInFrame;
            this.updatePositionSlider(targetSide);
            this.updateFrameInfo(targetSide);
        };

        if (this.parentChildMode && this.syncEnabled && side === 'left') {
            seekToTrimStart('left');

            const rightPlayer = this.players.right;
            if (rightPlayer.hasTrimPoints && rightPlayer.trimInFrame) {
                seekToTrimStart('right');
            }
            return;
        }

        if (this.parentChildMode && side === 'right') {
            return;
        }

        seekToTrimStart(side);
    }


    // === 動画最適化 ===
    async optimizeAndReload(side) {
        const player = this.players[side];
        if (!player.videoPath) {
            this.updateStatus('最適化する動画が読み込まれていません');
            return;
        }

        const message = '動画を最適化（全フレームキーフレーム化）して再読み込みしますか？\n処理時間がかかる場合があります。\n\n※59.94fpsなどの動画でフレームが正確に表示されない場合に有効です。';
        const userConfirmed = window.confirm(message); // 名前競合を回避し、明示的にwindow.confirmを使用
        if (!userConfirmed) return;

        this.updateStatus(`最適化中... (${Utils.getSideLabel(side)}) 変換中は操作しないでください`);

        // 進捗バーを表示
        const progressInfo = document.getElementById('progress-info');
        const progressText = document.getElementById('progress-text');
        const progressFill = document.getElementById('progress-fill');
        if (progressInfo) {
            progressInfo.style.display = 'block';
            progressText.textContent = '最適化中... 0%';
            progressFill.style.width = '0%';
        }

        // 進捗イベントリスナーを設定
        const progressHandler = (event, data) => {
            if (progressFill && data.percent !== undefined) {
                const percent = Math.min(100, Math.max(0, Math.round(data.percent)));
                progressFill.style.width = `${percent}%`;
                if (progressText) {
                    progressText.textContent = `最適化中... ${percent}%`;
                }
            }
        };
        ipcRenderer.on('optimization-progress', progressHandler);

        try {
            const result = await ipcRenderer.invoke('optimize-video', player.videoPath);

            if (result.success) {
                this.updateStatus('最適化完了。再読み込み中...');
                await this.loadVideo(side, result.filePath);
                this.updateStatus('最適化された動画を読み込みました (All-Intra)');
            } else {
                this.updateStatus(`最適化失敗: ${result.error}`);
                alert(`最適化に失敗しました: ${result.error}`);
            }
        } catch (error) {
            console.error('Optimization error:', error);
            this.updateStatus(`最適化エラー: ${error.message}`);
            alert(`最適化エラー: ${error.message}`);
        } finally {
            // 進捗リスナーを解除
            ipcRenderer.removeListener('optimization-progress', progressHandler);
            if (progressInfo) progressInfo.style.display = 'none';
        }
    }

    // === 動画読み込み ===
    async openVideoDialog(side) {
        try {
            await ipcRenderer.invoke('open-video-dialog', side);
        } catch (error) {
            console.error('Failed to open video dialog:', error);
            this.updateStatus('ファイルダイアログの表示に失敗しました');
        }
    }

    isPlayableFormat(filePath) {
        const ext = filePath.split('.').pop().toLowerCase();
        // MOVを追加（コーデック互換性がある場合は直接再生、失敗時はフォールバック）
        return ['mp4', 'webm', 'ogg', 'mov'].includes(ext);
    }

    async loadVideo(side, filePath) {
        const player = this.players[side];
        // Video element retry logic
        if (!player.video) {
            console.warn(`Video element missing for ${side}, retrying fetch...`);
            player.video = document.getElementById(`video-${side}`);
        }

        const video = player.video;

        if (!video) {
            throw new Error(`動画要素(video-${side})が見つかりません。DOM構造を確認してください。`);
        }
        if (!filePath) {
            throw new Error(`ファイルパスが見つかりません。ドラッグされたファイル情報を取得できませんでした。`);
        }

        let playablePath = filePath;
        let conversionTried = false;

        // サポート外形式の場合は即変換
        if (!this.isPlayableFormat(filePath)) {
            this.updateStatus('再生できない形式のため変換中...');
            const result = await ipcRenderer.invoke('convert-to-mp4', filePath);
            if (result.success) {
                playablePath = result.filePath;
                conversionTried = true;
                this.updateStatus('変換完了。再生を開始します。');
            } else {
                this.updateStatus('動画変換に失敗しました: ' + result.error);
                return;
            }
        }

        // 動画読み込み試行関数
        const attemptLoad = async (pathToCheck) => {
            console.log(`=== Video loading attempt (${side}) ===`);
            console.log('Path:', pathToCheck);

            // 前処理: srcクリア
            video.removeAttribute('src');
            video.load();

            return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    reject(new Error('Video loading timeout'));
                }, 30000);

                const onLoad = () => {
                    console.log('Video loadedmetadata event fired');
                    clearTimeout(timeoutId);
                    cleanup();
                    resolve();
                };

                const onError = (event) => {
                    console.error('Video error event fired:', event);
                    console.error('Video error details:', video.error);
                    clearTimeout(timeoutId);
                    cleanup();
                    reject(new Error(`Video loading failed: ${video.error?.message || 'Unknown error'}`));
                };

                const cleanup = () => {
                    video.removeEventListener('loadedmetadata', onLoad);
                    video.removeEventListener('error', onError);
                };

                video.addEventListener('loadedmetadata', onLoad);
                video.addEventListener('error', onError);

                // Convert path to file URL
                const fileUrl = 'file:///' + pathToCheck.replace(/\\/g, '/');
                video.src = fileUrl;
                // video.load() はsrc設定後に自動的にトリガーされるが、明示的に呼ぶ
                video.load();
            });
        };

        try {
            this.updateStatus(CONFIG.MESSAGES.STATUS.LOADING(side));

            // 動画ロード試行（直接再生 + 検証）
            try {
                // 1. まずブラウザでロード
                await attemptLoad(playablePath);

                // 2. FFmpegで動画情報を取得 (ブラウザロード成功後に実行)
                console.log('Getting video info...');
                const videoInfo = await ipcRenderer.invoke('get-video-info', playablePath);

                if (videoInfo.success) {
                    player.videoInfo = videoInfo;
                    player.fps = videoInfo.fps;
                    player.currentFrame = 1;

                    // Sliderの範囲をフレーム数に合わせる
                    if (player.positionSlider) {
                        player.positionSlider.min = 1;
                        player.positionSlider.max = videoInfo.totalFrames;
                        player.positionSlider.value = 1;
                        console.log(`Slider range updated: 1 - ${videoInfo.totalFrames}`);
                    }

                    // 3. MOVの場合、期間の整合性をチェック
                    const ext = playablePath.split('.').pop().toLowerCase();
                    if (!conversionTried && ext === 'mov') { // videoInfo.durationが無くてもチェックを試みる
                        const browserDuration = video.duration;

                        // FFmpegDurationを補完
                        let ffmpegDuration = videoInfo.duration;
                        if (!ffmpegDuration && videoInfo.totalFrames && videoInfo.fps) {
                            ffmpegDuration = videoInfo.totalFrames / videoInfo.fps;
                        }

                        // 両方が有効な数値の場合のみ比較
                        if (isFinite(browserDuration) && isFinite(ffmpegDuration)) {
                            const diff = Math.abs(browserDuration - ffmpegDuration);
                            console.log(`Duration check: Browser=${browserDuration.toFixed(3)}, FFmpeg=${ffmpegDuration.toFixed(3)}, Diff=${diff.toFixed(3)}`);

                            if (diff > 1.0) {
                                const msg = `Duration mismatch detected: Browser=${browserDuration.toFixed(2)}s, FFmpeg=${ffmpegDuration.toFixed(2)}s (Playback continued)`;
                                console.warn(msg);
                                // 強制変換はせず、直接再生を続行する
                            }
                        } else {
                            console.warn(`Duration check skipped: Browser=${browserDuration}, FFmpeg=${ffmpegDuration}`);
                        }
                    }
                    console.log('Video info loaded and validated successfully');
                } else {
                    player.fps = CONFIG.VIDEO.DEFAULT_FPS;
                    console.warn('Video info failed, using default FPS');
                }

            } catch (loadError) {
                // MOVなどで直接再生に失敗した場合（ロードエラー or 期間不整合）のフォールバック
                const ext = filePath.split('.').pop().toLowerCase();

                // conversionTriedがfalse (=まだ変換していない) かつ MOVファイルの場合のみフォールバック
                if (!conversionTried && ext === 'mov') {
                    console.warn(`Direct MOV playback failed (${loadError.message}), falling back to conversion.`);
                    this.updateStatus(`MOV形式の直接再生に失敗しました（${loadError.message}）。変換して再生します...`);

                    const convertResult = await ipcRenderer.invoke('convert-to-mp4', filePath);
                    if (convertResult.success) {
                        playablePath = convertResult.filePath;
                        conversionTried = true;

                        // 変換後ファイルで再試行（再帰ではなくリニアに実行）
                        await attemptLoad(playablePath);

                        // 変換後のファイル情報再取得
                        const newVideoInfo = await ipcRenderer.invoke('get-video-info', playablePath);
                        if (newVideoInfo.success) {
                            player.videoInfo = newVideoInfo;
                            player.fps = newVideoInfo.fps;
                            player.currentFrame = 1;
                        }
                    } else {
                        throw new Error(`変換フォールバック失敗: ${convertResult.error}`);
                    }
                } else {
                    // その他のエラーはそのままスロー
                    throw loadError;
                }
            }

            // --- ロード成功後の処理 ---

            player.videoPath = playablePath;
            player.originalPath = filePath; // 元のファイルパスを保持

            console.log('Video loading completed successfully');

            // 右画面かつDualMode時の追加処理
            if (side === 'right' && this.isDualMode()) {
                const rightVideo = this.players.right.video;
                rightVideo.preload = 'auto';
                rightVideo.load();
            }

            // 再生速度初期化
            player.playbackRate = CONFIG.VIDEO.SPEED.DEFAULT;
            video.playbackRate = CONFIG.VIDEO.SPEED.DEFAULT;

            // ズーム・パン初期化
            this.resetZoomPan(side);

            Utils.updateSliderBackground(player);


        } catch (error) {
            console.error(`Error loading video for ${side}:`, error);
            this.updateStatus(`動画の読み込みに失敗しました（${Utils.getSideLabel(side)}）: ${error.message}`);

            // エラー時初期化
            player.fps = CONFIG.VIDEO.DEFAULT_FPS;
            player.videoPath = null;
            player.videoInfo = null;
            player.playbackRate = CONFIG.VIDEO.SPEED.DEFAULT;
            player.zoom = CONFIG.VIDEO.ZOOM.DEFAULT;
            player.panX = 0;
            player.panY = 0;

            if (video) {
                video.removeAttribute('src');
                video.load();
                video.playbackRate = CONFIG.VIDEO.SPEED.DEFAULT;
                ZoomPanController.resetTransform(video);
            }
        }
    }

    // === 基本制御 ===
    togglePlayPause(side) {
        if (this.parentChildMode && side === 'left') {
            this.syncPlayPause();
            return;
        }

        const video = this.players[side].video;
        const button = Utils.getElementById(`play-pause-${side}`);

        if (!video || !button) return;

        if (video.paused) {
            // 再生開始前に速度を再適用（ブラウザがリセットすることがあるため）
            const player = this.players[side];
            const targetSpeed = player.playbackRate || CONFIG.VIDEO.SPEED.DEFAULT;
            video.playbackRate = targetSpeed;

            video.play().catch(error => {
                console.error(`Play error for ${side}:`, error);
                this.updateStatus(`再生エラー（${Utils.getSideLabel(side)}）: ${error.message}`);
            });
            UIController.setPlayPauseState(button, true);
        } else {
            // キーフレーム整列一時停止: 次のフレームまで進めてから一時停止
            this.pauseAtNextFrame(side);
            UIController.setPlayPauseState(button, false);
        }
    }

    pauseAtNextFrame(side) {
        const player = this.players[side];
        const video = player.video;
        if (!video || !video.duration) return;

        const totalFrames = player.videoInfo?.totalFrames;
        if (!totalFrames) {
            video.pause();
            return;
        }

        // 現在のフレーム番号を取得
        const currentFrame = PreciseFrameManager.getCurrentFrameFromVideo(video, player.fps, totalFrames);

        // 次のフレーム番号を計算
        const nextFrame = Math.min(currentFrame + 1, totalFrames);

        // 次のフレームの中心時間にシーク
        const nextFrameCenterTime = PreciseFrameManager.getFrameCenterTime(nextFrame, player.fps);

        // シークしてから一時停止
        video.currentTime = nextFrameCenterTime;

        // seekedイベントで一時停止
        const pauseHandler = () => {
            video.pause();
            video.removeEventListener('seeked', pauseHandler);
            player.currentFrame = nextFrame;
            this.updateFrameInfo(side);
        };
        video.addEventListener('seeked', pauseHandler);
    }

    stop(side) {
        const video = this.players[side].video;
        const button = Utils.getElementById(`play-pause-${side}`);

        if (!video || !button) return;

        video.pause();
        video.currentTime = 0;
        UIController.setPlayPauseState(button, false);
    }

    // 疑似連打を開始（キー長押し時）
    startPseudoRepeat(side, direction) {
        // 既存のタイマーをクリア
        this.stopPseudoRepeat();

        // 初回遅延後に連打開始（キーリピートの初回遅延を模倣）
        this.pseudoRepeatTimeoutId = setTimeout(() => {
            // 連打間隔: 100ms（秒間約10フレーム）に戻す
            const repeatInterval = 100;

            this.pseudoRepeatIntervalId = setInterval(() => {
                this.frameStep(side, direction);
            }, repeatInterval);
        }, 300); // 初回遅延: 300ms
    }

    // 疑似連打を停止
    stopPseudoRepeat() {
        if (this.pseudoRepeatTimeoutId) {
            clearTimeout(this.pseudoRepeatTimeoutId);
            this.pseudoRepeatTimeoutId = null;
        }
        if (this.pseudoRepeatIntervalId) {
            clearInterval(this.pseudoRepeatIntervalId);
            this.pseudoRepeatIntervalId = null;
        }
    }

    async frameStep(side, direction) {
        // シーク中ならスキップ
        if (this.isSeeking[side]) return;

        // 同期モード時は両画面を操作
        if (this.syncEnabled && this.parentChildMode) {
            this.frameStepBoth(direction);
            return;
        }

        const player = this.players[side];
        if (!player.video || !player.video.duration) return;

        const totalFrames = player.videoInfo?.totalFrames;
        if (!totalFrames) return;

        // 新しいフレーム番号を計算
        const newFrame = player.currentFrame + direction;

        // 境界チェック
        if (newFrame < 1 || newFrame > totalFrames) return;

        // シーク実行
        this.isSeeking[side] = true;
        player.currentFrame = newFrame;

        const time = (newFrame - 1) / player.fps;
        player.video.currentTime = time;

        await this.waitForSeeked(player.video);
        this.isSeeking[side] = false;
        this.updateFrameInfo(side);
    }

    waitForSeeked(video) {
        return new Promise(resolve => {
            const handler = () => {
                video.removeEventListener('seeked', handler);
                resolve();
            };
            video.addEventListener('seeked', handler, { once: true });
        });
    }

    frameStepBoth(direction) {
        // シーク中ならスキップ
        if (this.isSeeking.left || this.isSeeking.right) return;

        const leftPlayer = this.players.left;
        const rightPlayer = this.players.right;

        if (!leftPlayer.video || !rightPlayer.video) return;

        const leftTotalFrames = leftPlayer.videoInfo?.totalFrames;
        const rightTotalFrames = rightPlayer.videoInfo?.totalFrames;
        if (!leftTotalFrames || !rightTotalFrames) return;

        // 新しいフレーム番号を計算
        const leftNewFrame = leftPlayer.currentFrame + direction;
        const rightNewFrame = leftNewFrame + this.syncFrameOffset;

        // 境界チェック
        if (leftNewFrame < 1 || leftNewFrame > leftTotalFrames) return;
        if (rightNewFrame < 1 || rightNewFrame > rightTotalFrames) return;

        // シーク実行
        this.isSeeking.left = true;
        this.isSeeking.right = true;

        leftPlayer.currentFrame = leftNewFrame;
        rightPlayer.currentFrame = rightNewFrame;

        const leftTime = (leftNewFrame - 1) / leftPlayer.fps;
        const rightTime = (rightNewFrame - 1) / rightPlayer.fps;

        leftPlayer.video.currentTime = leftTime;
        rightPlayer.video.currentTime = rightTime;

        // シーク完了待ち
        const onLeftSeeked = () => {
            leftPlayer.video.removeEventListener('seeked', onLeftSeeked);
            this.isSeeking.left = false;
            this.updateFrameInfo('left');
        };
        const onRightSeeked = () => {
            rightPlayer.video.removeEventListener('seeked', onRightSeeked);
            this.isSeeking.right = false;
            this.updateFrameInfo('right');
        };

        leftPlayer.video.addEventListener('seeked', onLeftSeeked, { once: true });
        rightPlayer.video.addEventListener('seeked', onRightSeeked, { once: true });
    }

    // === トリミング ===
    setTrimPoint(side, type) {
        const player = this.players[side];
        const video = player.video;

        if (!video || !video.duration) {
            this.updateStatus(CONFIG.MESSAGES.ERROR.VIDEO_NOT_LOADED);
            return;
        }

        // FFmpeg基準の総フレーム数を取得
        const totalFrames = player.videoInfo?.totalFrames;
        if (!totalFrames) {
            this.updateStatus('FFmpeg基準のフレーム数が取得できません');
            return;
        }

        // PreciseFrameManagerで厳密なフレーム番号を取得
        const currentFrame = PreciseFrameManager.getCurrentFrameFromVideo(
            video,
            player.fps,
            totalFrames
        );

        // プレイヤーの現在フレーム番号も更新
        player.currentFrame = currentFrame;

        // フレーム番号でトリミング点を管理
        if (type === 'in') {
            player.trimInFrame = currentFrame;
            this.updateStatus(`トリミング開始点を設定: F${currentFrame}（${Utils.getSideLabel(side)}）`);
        } else {
            player.trimOutFrame = currentFrame;
            this.updateStatus(`トリミング終了点を設定: F${currentFrame}（${Utils.getSideLabel(side)}）`);
        }

        // アイコンを一時的に表示
        const overlay = document.getElementById(`frame-icon-${side}`);
        if (overlay) {
            if (type === 'in') {
                overlay.textContent = '|→';
                overlay.className = 'frame-icon-overlay frame-icon-in';
            } else {
                overlay.textContent = '→|';
                overlay.className = 'frame-icon-overlay frame-icon-out';
            }
            setTimeout(() => {
                if (overlay) {
                    overlay.innerHTML = '';
                    overlay.className = 'frame-icon-overlay';
                }
            }, 1000);
        }

        // 両方の値が有効かつ終了点が開始点より後の場合のみhasTrimPointsをtrue
        if (player.trimInFrame !== null && player.trimOutFrame !== null && player.trimOutFrame > player.trimInFrame) {
            player.hasTrimPoints = true;
            const frameDuration = player.trimOutFrame - player.trimInFrame + 1;
            this.updateStatus(`トリミング範囲: F${player.trimInFrame}-${player.trimOutFrame} (${frameDuration}フレーム)（${Utils.getSideLabel(side)}）`);
        } else {
            player.hasTrimPoints = false;
        }
        UIController.updateTrimMarkers(side, player);

        // 同期ポイント設定完了時は全画面のマーカーを更新
        if (this.syncPoints.left.isSet && this.syncPoints.right.isSet) {
            UIController.updateTrimMarkers('left', this.players.left);
            UIController.updateTrimMarkers('right', this.players.right);
        }
        Utils.updateSliderBackground(player);

        // フレーム情報を更新
        this.updateFrameStatusInfo();

        if (this.parentChildMode && this.syncEnabled && side === 'left') {
            // 子画面のトリミング点をフレーム基準で正確に設定
            const rightPlayer = this.players.right;
            const rightVideo = rightPlayer.video;
            if (rightVideo && rightVideo.duration && rightPlayer.videoInfo?.totalFrames) {
                // 左画面のFFmpeg基準現在フレーム
                const leftTotalFrames = player.videoInfo?.totalFrames;
                if (!leftTotalFrames) return;

                const leftCurrentFrame = Math.round(video.currentTime * player.fps) + 1;
                const clampedLeftCurrentFrame = Math.max(1, Math.min(leftCurrentFrame, leftTotalFrames));

                // 右画面の対応フレーム（フレーム差分を維持）
                const rightTargetFrame = clampedLeftCurrentFrame + this.syncFrameOffset;

                // 右画面の境界チェックを先に行う
                const rightTotalFrames = rightPlayer.videoInfo?.totalFrames;
                if (rightTargetFrame < 1 || rightTargetFrame > rightTotalFrames) {
                    this.updateStatus(`右画面の対応フレーム${rightTargetFrame}が範囲外です（1-${rightTotalFrames}）`);
                    return;
                }

                if (type === 'in') {
                    rightPlayer.trimInFrame = rightTargetFrame;

                    // 右画面の現在位置を設定されたフレームに強制移動
                    const rightTargetTime = (rightTargetFrame - 1) / rightPlayer.fps;
                    rightVideo.currentTime = rightTargetTime;

                    this.updateStatus(`同期トリミング開始点設定: 左F${clampedLeftCurrentFrame} → 右F${rightTargetFrame}`);
                } else {
                    rightPlayer.trimOutFrame = rightTargetFrame;

                    // 右画面の現在位置を設定されたフレームに強制移動
                    const rightTargetTime = (rightTargetFrame - 1) / rightPlayer.fps;
                    rightVideo.currentTime = rightTargetTime;

                    this.updateStatus(`同期トリミング終了点設定: 左F${clampedLeftCurrentFrame} → 右F${rightTargetFrame}`);
                }

                // 子画面のトリミング範囲有効判定
                if (
                    rightPlayer.trimInFrame !== null &&
                    rightPlayer.trimOutFrame !== null &&
                    rightPlayer.trimOutFrame > rightPlayer.trimInFrame
                ) {
                    rightPlayer.hasTrimPoints = true;
                } else {
                    rightPlayer.hasTrimPoints = false;
                }

                // 子画面のマーカー・範囲バーを即時更新
                UIController.updateTrimMarkers('right', rightPlayer);
                Utils.updateSliderBackground(rightPlayer);
            }
        }
    }

    // === 同期機能 ===
    setSyncPoint(side) {
        const player = this.players[side];
        const video = player.video;

        if (!video || !video.duration) {
            this.updateStatus(CONFIG.MESSAGES.ERROR.VIDEO_NOT_LOADED);
            return;
        }

        const button = Utils.getElementById(`sync-point-${side}`);
        if (!button) return;

        if (this.syncPoints[side].isSet) {
            this.syncPoints[side] = { time: null, frame: null, isSet: false };
            button.classList.remove('active');
            button.title = '同期ポイント設定';
            this.updateStatus(`${Utils.getSideLabel(side)}の同期ポイントをリセットしました`);
            this.checkSyncStatus();
            return;
        }

        // FFmpeg基準の総フレーム数を取得
        const totalFrames = player.videoInfo?.totalFrames;
        if (!totalFrames) {
            this.updateStatus(CONFIG.MESSAGES.ERROR.VIDEO_NOT_LOADED);
            return;
        }

        const currentTime = video.currentTime;
        // FFmpeg基準での正確なフレーム番号を計算
        const currentFrame = PreciseFrameManager.timeToFrame(
            currentTime,
            player.fps,
            totalFrames
        );

        this.syncPoints[side] = { time: currentTime, frame: currentFrame, isSet: true };
        button.classList.add('active');
        button.title = `同期ポイント設定済み (F${currentFrame}) - クリックでリセット`;
        this.updateStatus(`${Utils.getSideLabel(side)}の同期ポイントを設定: フレーム${currentFrame} (${Utils.formatTime(currentTime)})`);
        this.checkSyncStatus();
        this.updateSyncPointMarker(side);
    }

    checkSyncStatus() {
        const leftSet = this.syncPoints.left.isSet;
        const rightSet = this.syncPoints.right.isSet;

        if (leftSet && rightSet) {
            this.syncEnabled = true;
            // フレーム基準でのオフセット計算
            this.syncFrameOffset = this.syncPoints.right.frame - this.syncPoints.left.frame;
            // 時間ベースオフセットも互換性のため保持
            this.syncOffset = this.syncPoints.right.time - this.syncPoints.left.time;

            const syncStatusMessage = Utils.getElementById('sync-status-message');
            if (syncStatusMessage) {
                syncStatusMessage.textContent = `同期有効 (左F${this.syncPoints.left.frame} ↔ 右F${this.syncPoints.right.frame}, 差分${this.syncFrameOffset}F)`;
                syncStatusMessage.style.display = 'inline';
            }

            this.enableParentChildMode();
            this.updateStatus(`フレーム同期有効: 差分${this.syncFrameOffset}フレーム (左F${this.syncPoints.left.frame} ↔ 右F${this.syncPoints.right.frame})`);

            // 同期再生可能範囲を表示するため、マーカーとスライダー背景を更新
            UIController.updateTrimMarkers('left', this.players.left);
            UIController.updateTrimMarkers('right', this.players.right);
            Utils.updateSliderBackground(this.players.left);
            Utils.updateSliderBackground(this.players.right);
        } else {
            this.syncEnabled = false;
            this.syncOffset = 0;
            this.syncFrameOffset = 0;

            const syncStatusMessage = Utils.getElementById('sync-status-message');
            if (syncStatusMessage) {
                syncStatusMessage.style.display = 'none';
            }

            this.disableParentChildMode();

            // 同期解除時はスライダー背景も通常に戻す
            Utils.updateSliderBackground(this.players.left);
            Utils.updateSliderBackground(this.players.right);
        }
        this.updateSyncPointMarker('left');
        this.updateSyncPointMarker('right');
    }

    enableParentChildMode() {
        this.parentChildMode = true;
        UIController.updatePlayerControlStates(true);
        UIController.disableControls('right');

        // 二画面動画出力ボタンを有効化
        const dualOutputButtons = document.querySelectorAll('.dual-output-button');
        dualOutputButtons.forEach(button => {
            button.disabled = false;
        });

        // 速度を同期
        const leftSpeed = this.players.left.playbackRate;
        this.syncPlaybackSpeed(leftSpeed);

        this.updateStatus(CONFIG.MESSAGES.STATUS.PARENT_CHILD_ENABLED);
    }

    disableParentChildMode() {
        this.parentChildMode = false;
        UIController.updatePlayerControlStates(false);
        UIController.enableControls('right');

        // 二画面動画出力ボタンを無効化
        const dualOutputButtons = document.querySelectorAll('.dual-output-button');
        dualOutputButtons.forEach(button => {
            button.disabled = true;
        });
    }

    syncPlayPause() {
        if (!this.syncEnabled) {
            this.updateStatus('同期が有効になっていません');
            return;
        }

        const leftVideo = this.players.left.video;
        const rightVideo = this.players.right.video;
        const leftButton = Utils.getElementById('play-pause-left');
        const rightButton = Utils.getElementById('play-pause-right');

        if (!leftVideo || !rightVideo) return;

        if (leftVideo.paused && rightVideo.paused) {
            // フレーム基準での正確な同期計算
            const leftPlayer = this.players.left;
            const rightPlayer = this.players.right;

            // FFmpeg基準の総フレーム数を取得
            const leftTotalFrames = leftPlayer.videoInfo?.totalFrames;
            const rightTotalFrames = rightPlayer.videoInfo?.totalFrames;
            if (!leftTotalFrames || !rightTotalFrames) {
                this.updateStatus('動画情報が読み込まれていません');
                return;
            }

            // 左画面の現在フレーム（フレーム境界での正確な計算）
            const leftCurrentFrame = Math.floor(leftVideo.currentTime * leftPlayer.fps) + 1;
            const clampedLeftCurrentFrame = Math.max(1, Math.min(leftCurrentFrame, leftTotalFrames));

            // 右画面の目標フレーム（フレーム差分を維持）
            const rightTargetFrame = clampedLeftCurrentFrame + this.syncFrameOffset;

            // 右画面の境界チェック
            if (rightTargetFrame < 1 || rightTargetFrame > rightTotalFrames) {
                this.updateStatus('同期再生できません: 右画面の範囲外');
                return;
            }

            // フレーム境界での正確な時間計算
            const rightTime = (rightTargetFrame - 1) / rightPlayer.fps;

            if (rightTime >= 0 && rightTime <= rightVideo.duration) {
                // フレーム境界での正確な位置合わせ
                rightVideo.currentTime = rightTime;

                // バッファリング状態を確認してから再生開始
                const ensureBuffering = async () => {
                    const leftReady = leftVideo.readyState >= 3; // HAVE_FUTURE_DATA
                    const rightReady = rightVideo.readyState >= 3;

                    if (!leftReady || !rightReady) {
                        // バッファリング完了まで待機
                        await new Promise(resolve => {
                            const checkBuffer = () => {
                                if (leftVideo.readyState >= 3 && rightVideo.readyState >= 3) {
                                    resolve();
                                } else {
                                    setTimeout(checkBuffer, 16); // 16ms間隔でチェック
                                }
                            };
                            checkBuffer();
                        });
                    }
                };

                ensureBuffering().then(() => {
                    // 両方の動画を同時に再生開始
                    const leftPlayPromise = leftVideo.play();
                    const rightPlayPromise = rightVideo.play();

                    Promise.all([leftPlayPromise, rightPlayPromise])
                        .then(() => {
                            UIController.setPlayPauseState(leftButton, true);
                            UIController.setPlayPauseState(rightButton, true);
                            this.updateStatus('同期再生開始');
                        })
                        .catch(error => {
                            console.error('Sync play error:', error);
                            this.updateStatus(`再生エラーが発生しました: ${error.message}`);
                        });
                }).catch(error => {
                    console.error('Buffering check error:', error);
                    this.updateStatus('バッファリング確認中にエラーが発生しました');
                });
            } else {
                this.updateStatus('同期再生できません: 時間範囲外');
            }
        } else {
            // キーフレーム整列一時停止: 両方の動画を次のフレームまで進めてから一時停止
            this.pauseAtNextFrame('left');
            this.pauseAtNextFrame('right');
            UIController.setPlayPauseState(leftButton, false);
            UIController.setPlayPauseState(rightButton, false);
            this.updateStatus('同期一時停止');
        }
    }

    syncSliderPosition(leftTime) {
        if (!this.syncEnabled) return;

        const rightVideo = this.players.right.video;
        const rightSlider = Utils.getElementById('position-right');
        const leftPlayer = this.players.left;
        const rightPlayer = this.players.right;

        if (!rightVideo || !rightVideo.duration || !rightSlider) return;

        // フレーム基準での同期計算（FFmpeg基準）
        const leftTotalFrames = leftPlayer.videoInfo?.totalFrames;
        const rightTotalFrames = rightPlayer.videoInfo?.totalFrames;
        if (!leftTotalFrames || !rightTotalFrames) return;

        const leftCurrentFrame = Math.floor(leftTime * leftPlayer.fps) + 1;
        const clampedLeftCurrentFrame = Math.max(1, Math.min(leftCurrentFrame, leftTotalFrames));
        const rightTargetFrame = clampedLeftCurrentFrame + this.syncFrameOffset;

        // 右画面の境界チェック
        if (rightTargetFrame < 1 || rightTargetFrame > rightTotalFrames) return;

        const rightTime = (rightTargetFrame - 1) / rightPlayer.fps;

        if (rightTime < 0) {
            rightVideo.currentTime = 0;
            rightSlider.value = 0;
        } else if (rightTime > rightVideo.duration) {
            rightVideo.currentTime = rightVideo.duration;
            rightSlider.value = 100;
        } else {
            rightVideo.currentTime = rightTime;
            const rightPercentage = (rightTime / rightVideo.duration) * 100;
            rightSlider.value = rightPercentage;
        }

        this.updateFrameInfo('right');
    }

    syncSliderPositionByFrame(leftFrame) {
        if (!this.syncEnabled) return;

        const rightVideo = this.players.right.video;
        const rightSlider = Utils.getElementById('position-right');
        const rightPlayer = this.players.right;

        if (!rightVideo || !rightVideo.duration || !rightSlider) return;

        // フレーム基準での同期計算
        const rightTargetFrame = leftFrame + this.syncFrameOffset;

        // 右画面の制限範囲を計算（FFmpeg基準）
        let minRightFrame = 1;
        const rightTotalFrames = rightPlayer.videoInfo?.totalFrames;
        if (!rightTotalFrames) return;

        let maxRightFrame = rightTotalFrames;

        // 上バー範囲制限（トリミング）
        if (rightPlayer.hasTrimPoints) {
            const trimInFrame = rightPlayer.trimInFrame;
            const trimOutFrame = rightPlayer.trimOutFrame;
            minRightFrame = Math.max(minRightFrame, trimInFrame);
            maxRightFrame = Math.min(maxRightFrame, trimOutFrame);
        }

        // 下バー範囲制限（同期）
        if (this.syncPoints.left.isSet && this.syncPoints.right.isSet) {
            const syncRange = this.calculateSyncPlayableRange('right');
            if (syncRange) {
                minRightFrame = Math.max(minRightFrame, syncRange.minFrame);
                maxRightFrame = Math.min(maxRightFrame, syncRange.maxFrame);
            }
        }

        // 境界チェック
        if (rightTargetFrame < minRightFrame || rightTargetFrame > maxRightFrame) {
            return;
        }

        const rightTime = (rightTargetFrame - 1) / rightPlayer.fps;
        rightVideo.currentTime = rightTime;

        // スライダー値をフレーム基準で設定
        const rightPercentage = ((rightTargetFrame - 1) / (maxRightFrame - 1)) * 100;
        rightSlider.value = rightPercentage;

        this.updateFrameInfo('right');
    }

    calculateSyncPlayableRange(side) {
        if (!this.syncEnabled || !this.syncPoints.left.isSet || !this.syncPoints.right.isSet) {
            return null;
        }

        const leftPlayer = this.players.left;
        const rightPlayer = this.players.right;
        const leftVideo = leftPlayer.video;
        const rightVideo = rightPlayer.video;

        if (!leftVideo || !rightVideo) return null;

        // 左右の動画の総フレーム数（FFmpeg基準）
        const leftTotalFrames = leftPlayer.videoInfo?.totalFrames;
        const rightTotalFrames = rightPlayer.videoInfo?.totalFrames;
        if (!leftTotalFrames || !rightTotalFrames) return null;

        // 同期ポイントのフレーム番号
        const leftSyncFrame = this.syncPoints.left.frame;
        const rightSyncFrame = this.syncPoints.right.frame;

        if (side === 'left') {
            // 左画面の再生可能範囲
            // 右画面が1フレーム以上になる左画面の最小フレーム（1フレーム前進）
            const minLeftFrame = Math.max(1, 2 - this.syncFrameOffset);
            // 右画面が最大フレーム以下になる左画面の最大フレーム
            const maxLeftFrame = Math.min(leftTotalFrames, rightTotalFrames - this.syncFrameOffset);

            return {
                minFrame: minLeftFrame,
                maxFrame: maxLeftFrame
            };
        } else {
            // 右画面の再生可能範囲
            // 左画面が1フレーム以上になる右画面の最小フレーム（1フレーム前進）
            const minRightFrame = Math.max(1, 2 + this.syncFrameOffset);
            // 左画面が最大フレーム以下になる右画面の最大フレーム
            const maxRightFrame = Math.min(rightTotalFrames, leftTotalFrames + this.syncFrameOffset);

            return {
                minFrame: minRightFrame,
                maxFrame: maxRightFrame
            };
        }
    }

    // ✅ maintainSyncDuringPlayback関数を削除
    // 継続的な同期補正は不要。開始時の初期同期と操作時の同期のみで十分

    // === UI更新 ===
    updatePositionSlider(side) {
        const player = this.players[side];
        const video = player.video;

        // video.durationチェックを外す（MOVなどでDurationが狂っていてもフレーム数があれば動くようにする）
        if (!video || !player.positionSlider) return;

        const totalFrames = player.videoInfo?.totalFrames;
        if (!totalFrames) return;

        // FFmpeg基準でのフレーム番号を取得
        const currentFrame = PreciseFrameManager.timeToFrame(
            video.currentTime,
            player.fps,
            totalFrames
        );

        // スライダー値は直接フレーム番号
        player.positionSlider.value = currentFrame;
    }

    updateFrameInfo(side) {
        const player = this.players[side];
        const video = player.video;

        if (!video || !player.frameInfo) return;

        if (!video.duration) {
            if (player.lastFrameInfoText !== 'フレーム: 0/0') {
                player.frameInfo.textContent = 'フレーム: 0/0';
                player.lastFrameInfoText = 'フレーム: 0/0';
            }
            return;
        }

        const fps = player.fps;

        // FFmpeg基準の総フレーム数を優先使用
        const totalFrames = player.videoInfo?.totalFrames;
        if (!totalFrames) {
            if (player.lastFrameInfoText !== 'フレーム: 0/0') {
                player.frameInfo.textContent = 'フレーム: 0/0';
                player.lastFrameInfoText = 'フレーム: 0/0';
            }
            return;
        }

        // FFmpeg基準での正確なフレーム番号計算
        const currentFrame = PreciseFrameManager.timeToFrame(
            video.currentTime,
            fps,
            totalFrames
        );

        // フレームが変わっていない場合は早期リターン（DOM更新をスキップ）
        if (currentFrame === player.lastDisplayedFrame) {
            return;
        }
        player.lastDisplayedFrame = currentFrame;

        // 同期差分の表示を追加（二画面同期モード時）
        let frameDisplayText = `フレーム: ${currentFrame}/${totalFrames} (${fps.toFixed(2)}fps)`;

        if (this.parentChildMode && this.syncEnabled && side === 'right') {
            const leftPlayer = this.players.left;
            if (leftPlayer && leftPlayer.video && leftPlayer.video.duration) {
                const leftCurrentFrame = Math.round(leftPlayer.video.currentTime * leftPlayer.fps) + 1;
                const actualDiff = currentFrame - leftCurrentFrame;
                frameDisplayText += ` [差分${actualDiff}F]`;
            }
        }

        // テキストが変わった場合のみDOM更新
        if (frameDisplayText !== player.lastFrameInfoText) {
            player.frameInfo.textContent = frameDisplayText;
            player.lastFrameInfoText = frameDisplayText;
        }

        // 開始点・終了点のフレームで動画上にアイコンを表示
        const overlay = document.getElementById(`frame-icon-${side}`);
        if (overlay) {
            const inFrame = player.trimInFrame;
            const outFrame = player.trimOutFrame;

            // 現在のクラス名を取得して比較
            let newClass = 'frame-icon-overlay';
            let newText = '';

            if (inFrame !== null && currentFrame === inFrame) {
                newText = '|→';
                newClass = 'frame-icon-overlay frame-icon-in';
            } else if (outFrame !== null && currentFrame === outFrame) {
                newText = '→|';
                newClass = 'frame-icon-overlay frame-icon-out';
            }

            // 変更がある場合のみDOM更新
            if (overlay.className !== newClass) {
                overlay.className = newClass;
                overlay.textContent = newText;
            }
        }
    }

    switchViewMode(mode) {
        if (this.currentViewMode === mode) return;

        this.currentViewMode = mode;
        const videoContainer = Utils.getElementById('video-container');
        const rightPlayer = Utils.getElementById('right-player');

        if (videoContainer) {
            videoContainer.className = `${mode}-view`;
        }

        if (rightPlayer) {
            rightPlayer.style.display = mode === 'single' ? 'none' : 'block';

            // 二画面表示に切り替える際に、右画面の動画要素を事前に初期化
            if (mode === 'dual' && this.players.right.video) {
                const rightVideo = this.players.right.video;
                rightVideo.preload = 'auto'; // metadataからautoに変更
                rightVideo.load(); // 強制的に読み込み開始
            }
        }

        // ストロボモーションボタン：1画面モードのみ表示
        const strobeLeft = document.getElementById('strobe-motion-left');
        const strobeRight = document.getElementById('strobe-motion-right');
        if (strobeLeft) strobeLeft.style.display = mode === 'single' ? '' : 'none';
        if (strobeRight) strobeRight.style.display = mode === 'single' ? '' : 'none';

        this.updateStatus(`${mode === 'single' ? '一' : '二'}画面表示モードに切り替えました`);
        ipcRenderer.send('resize-window-for-mode', mode);
    }

    startFrameInfoUpdater() {
        let animationId = null;

        const updateFrame = () => {
            // ✅ 同期処理は削除（フレーム情報更新のみ）

            // フレーム情報の更新（再生中のみ、timeupdate と重複しないよう最適化）
            this.forEachSide((side, player) => {
                const video = player.video;
                if (video && !video.paused && video.duration) {
                    // FFmpeg基準の総フレーム数を取得
                    const totalFrames = player.videoInfo?.totalFrames;
                    if (totalFrames) {
                        const currentFrame = Math.round(video.currentTime * player.fps) + 1;
                        const clampedCurrentFrame = Math.max(1, Math.min(currentFrame, totalFrames));

                        // player.lastDisplayedFrame でキャッシュチェック（updateFrameInfo内でも行われるが早期リターン）
                        if (clampedCurrentFrame !== player.lastDisplayedFrame) {
                            player.currentFrame = clampedCurrentFrame;
                            this.updateFrameInfo(side);

                            // 二画面同期モード時は、右画面の表示も即座に更新
                            if (this.parentChildMode && this.syncEnabled && side === 'left') {
                                this.updateFrameInfo('right');
                            }
                        }
                    }
                }
            });

            // 次のフレームで継続（同期モード時のみ）
            if (this.syncEnabled && this.parentChildMode) {
                animationId = requestAnimationFrame(updateFrame);
            }
        };

        // 同期モード開始時にRAFを開始
        if (this.syncEnabled && this.parentChildMode) {
            animationId = requestAnimationFrame(updateFrame);
        }

        // 停止時の処理を保存
        this.stopFrameUpdater = () => {
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
        };
    }

    showProgressBar(show) {
        const progressInfo = Utils.getElementById('progress-info');
        if (progressInfo) {
            progressInfo.style.display = show ? 'flex' : 'none';
        }
    }

    updateProgress(percent, message) {
        const progressFill = Utils.getElementById('progress-fill');
        const progressText = Utils.getElementById('progress-text');

        if (progressFill) progressFill.style.width = `${percent}%`;
        if (progressText) progressText.textContent = `${percent}%`;
        if (message) this.updateStatus(message);
    }

    updateStatus(message) {
        if (this.statusMessage) {
            this.statusMessage.textContent = message;
        }
    }

    updateFrameStatusInfo() {
        const frameStatusText = Utils.getElementById('frame-status-text');
        if (!frameStatusText) return;

        // アクティブな画面の情報を取得
        const activeSide = this.activeSide || 'left';
        const player = this.players[activeSide];

        if (!player.videoInfo || !player.videoInfo.totalFrames) {
            frameStatusText.textContent = 'フレーム情報: 未読み込み';
            return;
        }

        const totalFrames = player.videoInfo.totalFrames;
        const trimInFrame = player.trimInFrame || '-';
        const trimOutFrame = player.trimOutFrame || '-';

        // トリミング範囲のフレーム数を計算
        let trimFrameCount = '-';
        if (player.trimInFrame && player.trimOutFrame && player.trimOutFrame > player.trimInFrame) {
            trimFrameCount = player.trimOutFrame - player.trimInFrame + 1;
        }

        frameStatusText.textContent = `開始F: ${trimInFrame} | 終了F: ${trimOutFrame} | 範囲F: ${trimFrameCount} | 総F: ${totalFrames} (${Utils.getSideLabel(activeSide)})`;
    }

    updateSyncPointMarker(side) {
        const player = this.players[side];
        const video = player.video;
        const trimMarkers = Utils.getElementById(`trim-markers-${side}`);
        if (!trimMarkers) return;

        const totalFrames = player.videoInfo?.totalFrames;

        // 既存マーカー削除
        trimMarkers.querySelectorAll('.sync-point-marker').forEach(marker => marker.remove());

        // 新規マーカー追加（フレーム基準）
        if (this.syncPoints[side].isSet && totalFrames && this.syncPoints[side].frame) {
            const marker = document.createElement('div');
            marker.className = 'sync-point-marker';
            // フレーム基準のパーセンテージで位置設定
            const percent = PreciseFrameManager.frameToPercentage(this.syncPoints[side].frame, totalFrames);
            marker.style.left = `${percent}%`;
            marker.title = `同期ポイント: F${this.syncPoints[side].frame}`;
            trimMarkers.appendChild(marker);
        }
    }

    resetAllVideos() {
        // DOM要素キャッシュをクリア
        Utils.clearElementCache();

        this.forEachSide((side, player) => {
            if (player.video) {
                player.video.pause();
                player.video.removeAttribute('src');
                player.video.load();
            }
            player.videoPath = null;
            player.videoInfo = null;
            player.fps = CONFIG.VIDEO.DEFAULT_FPS;
            player.trimInPoint = null;
            player.trimOutPoint = null;
            player.hasTrimPoints = false;
            player.playbackRate = CONFIG.VIDEO.SPEED.DEFAULT;
            player.zoom = CONFIG.VIDEO.ZOOM.DEFAULT;
            player.panX = 0;
            player.panY = 0;
            if (player.frameInfo) player.frameInfo.textContent = 'フレーム: 0/0';
            const overlay = document.getElementById(`frame-icon-${side}`);
            if (overlay) {
                overlay.className = 'frame-icon-overlay';
                overlay.innerHTML = '';
            }
            // スライダー背景を全体グレーに
            if (player.positionSlider) {
                player.positionSlider.style.setProperty('--slider-gradient', '#666');
                player.positionSlider.value = 0; // スライダー値も初期化
            }
            // トリミングマーカー・範囲を全て消す
            const trimMarkers = document.getElementById(`trim-markers-${side}`);
            if (trimMarkers) {
                trimMarkers.querySelectorAll('.trim-marker').forEach(marker => marker.remove());
                trimMarkers.querySelectorAll('.trim-range').forEach(range => range.remove());
            }
        });
        // 同期・親子制御・同期ポイントもリセット
        this.syncPoints = {
            left: { time: null, frame: null, isSet: false },
            right: { time: null, frame: null, isSet: false }
        };
        this.syncEnabled = false;
        this.syncOffset = 0;
        this.parentChildMode = false;
        UIController.updatePlayerControlStates(false);
        // ステータスバーの同期表示も非表示
        const syncStatusMessage = document.getElementById('sync-status-message');
        if (syncStatusMessage) syncStatusMessage.style.display = 'none';
        this.updateSyncPointMarker('left');
        this.updateSyncPointMarker('right');
        this.updateStatus('動画を閉じました');
    }
}


// === アプリケーション初期化 ===
// 起動時にlocalStorageからモードを取得し復元
window.addEventListener('DOMContentLoaded', () => {
    // 「動画を閉じる」時のみlocalStorageに値が入る。それ以外は一画面で初期化
    const savedMode = localStorage.getItem('viewModeOnClose') || 'single';
    // VideoSyncLabの初期化
    window.videoPlayer = new VideoSyncLab();
    window.videoSyncLab = window.videoPlayer;
    // 初期モードを適用
    window.videoSyncLab.switchViewMode(savedMode);
    ipcRenderer.send('resize-window-for-mode', savedMode);
    // 初期化後は値をクリア
    localStorage.removeItem('viewModeOnClose');
});

// モード切り替え時
ipcRenderer.on('switch-view', (event, mode) => {
    Utils.clearElementCache();
    if (window.videoSyncLab) {
        window.videoSyncLab.switchViewMode(mode);
    }
});

ipcRenderer.on('close-video', () => {
    window.location.reload();
});

// ストロボモーション イベントフレーム保存
ipcRenderer.on('strobe-save-events', () => {
    if (window.videoSyncLab?.strobeMotionController) {
        window.videoSyncLab.strobeMotionController.saveEventsToFile();
    }
});

// ストロボモーション イベントフレーム読込
ipcRenderer.on('strobe-load-events', () => {
    if (window.videoSyncLab?.strobeMotionController) {
        window.videoSyncLab.strobeMotionController.loadEventsFromFile();
    }
});

// === 変換進捗イベントハンドラ ===
let currentEncoderLabel = ''; // エンコーダー表示のチラつき防止用
let lastPercent = 0;          // プログレスバーの逆行防止用

ipcRenderer.on('convert-progress', (event, data) => {
    const progressInfo = document.getElementById('progress-info');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const statusMessage = document.getElementById('status-message');

    if (!progressInfo || !progressFill || !progressText) return;

    // エンコーダー名を短縮表示（データがある場合のみ更新）
    if (data.encoder) {
        let newLabel = '';
        if (data.encoder.includes('nvenc')) newLabel = 'GPU(NVENC)';
        else if (data.encoder.includes('qsv')) newLabel = 'GPU(QSV)';
        else if (data.encoder.includes('amf')) newLabel = 'GPU(AMF)';
        else if (data.encoder.includes('fallback')) newLabel = 'CPU(Fallback)';
        else newLabel = 'CPU';

        // チラつき防止ロジック：
        // 既にGPUと判定されている場合は、CPU情報が混ざっても上書きしない
        const isCurrentGPU = currentEncoderLabel && currentEncoderLabel.startsWith('GPU');
        const isNewGPU = newLabel.startsWith('GPU');

        // 現在がGPUでなく、新しい情報がある場合、または新しい情報もGPUの場合に更新
        if (!isCurrentGPU || isNewGPU) {
            currentEncoderLabel = newLabel;
        }
    }

    if (data.done) {
        // 完了時：プログレスバーを非表示
        progressInfo.style.display = 'none';
        if (statusMessage) statusMessage.textContent = `変換完了 ${currentEncoderLabel}`;
        currentEncoderLabel = ''; // 完了後にリセット
        lastPercent = 0;
    } else if (data.error) {
        // エラー時：プログレスバーを非表示
        progressInfo.style.display = 'none';
        if (statusMessage) statusMessage.textContent = `変換エラー: ${data.error}`;
        currentEncoderLabel = '';
        lastPercent = 0;
    } else {
        // 進捗更新：プログレスバーを表示・更新
        progressInfo.style.display = 'flex';
        let percent = Math.round(data.percent || 0);

        // 逆行防止 & 0%チラつき防止
        if (percent < lastPercent && lastPercent > 0) {
            percent = lastPercent;
        } else {
            lastPercent = percent;
        }

        progressFill.style.width = `${percent}%`;
        progressText.textContent = `${percent}%`;

        if (statusMessage) {
            // エンコーダーラベルがある場合は表示
            const labelPart = currentEncoderLabel ? ` ${currentEncoderLabel}` : '';
            statusMessage.textContent = `変換中${labelPart}... ${percent}%`;
        }
    }
});

// === プロジェクトファイル管理 ===

// プレイヤーデータ抽出ヘルパー
function extractPlayerData(player) {
    if (!player || !player.videoPath) return null;
    return {
        path: player.videoPath,
        trimInFrame: player.trimInFrame,
        trimOutFrame: player.trimOutFrame,
        currentFrame: player.currentFrame,
        playbackRate: player.playbackRate,
        zoom: player.zoom,
        panX: player.panX,
        panY: player.panY,
        syncPointFrame: window.videoSyncLab.syncPoints[player === window.videoSyncLab.players.left ? 'left' : 'right']?.frame || null
    };
}

// プロジェクト保存
ipcRenderer.on('project-save', async () => {
    if (!window.videoSyncLab) return;
    const vsl = window.videoSyncLab;

    const saveData = {
        version: "1.0",
        viewMode: vsl.currentViewMode || 'single',
        syncEnabled: vsl.syncEnabled,
        syncOffset: vsl.syncOffset,
        syncFrameOffset: vsl.syncFrameOffset,
        left: extractPlayerData(vsl.players.left),
        right: extractPlayerData(vsl.players.right),
        strobeMotion: vsl.strobeMotionController ? vsl.strobeMotionController.getEvents() : []
    };

    const res = await ipcRenderer.invoke('save-project-file', saveData);
    if (res.success) {
        vsl.updateStatus(`プロジェクトを保存しました: ${path.basename(res.filePath)}`);
    } else if (res.error) {
        vsl.updateStatus(`保存エラー: ${res.error}`);
    }
});

// プロジェクト読込
ipcRenderer.on('project-open', async () => {
    const res = await ipcRenderer.invoke('load-project-file');
    if (!res.success || !res.data) {
        if (res.error) window.videoSyncLab.updateStatus(`読込エラー: ${res.error}`);
        return;
    }

    const data = res.data;
    const vsl = window.videoSyncLab;
    if (!vsl) return;

    // パス解決用ディレクトリ（相対パス対応準備）
    // 現状は絶対パスで保存している前提

    // UIブロック開始
    // モード切替（必要であればリロードが必要だが、簡易的に対応）
    if (data.viewMode && data.viewMode !== vsl.currentViewMode) {
        vsl.updateStatus(`モード切替中... (${data.viewMode})`);
        await ipcRenderer.invoke('switch-view-request', data.viewMode); // main.js側でリサイズ等を呼ぶ必要があるが…
        // VideoSyncLabはモード切替時にreloadする設計に見える (switchViewMode関数)
        // ここでは安全のため、モードが違う場合は警告を出すか、ロード後に切り替えるか。
        // 一旦モード切替ロジックはスキップし、現在のモードでロードを試みる。
    }

    try {
        // 左動画ロード
        if (data.left && data.left.path) {
            await vsl.loadVideo('left', data.left.path);
            const player = vsl.players.left;

            // 状態復元
            if (data.left.trimInFrame !== null) {
                player.trimInFrame = data.left.trimInFrame;
                if (player.fps) player.trimInPoint = (data.left.trimInFrame - 1) / player.fps;
            }
            if (data.left.trimOutFrame !== null) {
                player.trimOutFrame = data.left.trimOutFrame;
                if (player.fps) player.trimOutPoint = (data.left.trimOutFrame - 1) / player.fps;
            }
            player.hasTrimPoints = (player.trimInFrame !== null && player.trimOutFrame !== null);

            // 同期ポイント復元
            if (data.left.syncPointFrame !== null) {
                vsl.syncPoints.left = {
                    frame: data.left.syncPointFrame,
                    time: (data.left.syncPointFrame - 1) / player.fps,
                    isSet: true
                };
            }

            // UI更新
            if (typeof UIController !== 'undefined') {
                UIController.updateTrimMarkers('left', player);
            }
            vsl.updateSyncPointMarker('left');
        }

        // 右動画ロード
        if (data.right && data.right.path) {
            // 二画面モードでなければ開けないので、とりあえずロード
            await vsl.loadVideo('right', data.right.path);
            const player = vsl.players.right;

            if (data.right.trimInFrame !== null) {
                player.trimInFrame = data.right.trimInFrame;
                if (player.fps) player.trimInPoint = (data.right.trimInFrame - 1) / player.fps;
            }
            if (data.right.trimOutFrame !== null) {
                player.trimOutFrame = data.right.trimOutFrame;
                if (player.fps) player.trimOutPoint = (data.right.trimOutFrame - 1) / player.fps;
            }
            player.hasTrimPoints = (player.trimInFrame !== null && player.trimOutFrame !== null);

            if (data.right.syncPointFrame !== null) {
                vsl.syncPoints.right = {
                    frame: data.right.syncPointFrame,
                    time: (data.right.syncPointFrame - 1) / player.fps,
                    isSet: true
                };
            }

            if (typeof UIController !== 'undefined') {
                UIController.updateTrimMarkers('right', player);
            }
            vsl.updateSyncPointMarker('right');
        }

        // 同期状態復元
        if (data.syncEnabled) {
            vsl.checkSyncStatus(); // 内部でsyncEnabled, syncOffset等を再計算
        }

        // ストロボモーション復元
        if (data.strobeMotion && vsl.strobeMotionController) {
            // eventsプロパティへの直接代入ではなく、復元メソッドを使用
            await vsl.strobeMotionController.restoreEvents(data.strobeMotion);
        }

        vsl.updateStatus('プロジェクトを読み込みました');

    } catch (e) {
        console.error(e);
        vsl.updateStatus(`プロジェクト復元エラー: ${e.message}`);
    }
});