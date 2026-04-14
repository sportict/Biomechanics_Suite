// ===================================
// skeleton-renderer.js
// メインスレッド側のスケルトン描画管理クラス
// ===================================

/**
 * SkeletonRenderer
 * OffscreenCanvas + Web Workerを使用した高性能スケルトン描画
 * 
 * 使用方法:
 * 1. const renderer = new SkeletonRenderer(canvas);
 * 2. await renderer.init();
 * 3. renderer.draw(keypoints, frame);
 */
class SkeletonRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.options = {
            workerPath: options.workerPath || 'skeleton-worker.js',
            fallbackToMain: options.fallbackToMain !== false,  // Worker失敗時にメインスレッドで描画
            ...options
        };

        this.worker = null;
        this.offscreenCanvas = null;
        this.isInitialized = false;
        this.useWorker = false;
        this.pendingDraws = new Map();
        this.drawIdCounter = 0;

        // フォールバック用のコンテキスト
        this.fallbackCtx = null;

        // パフォーマンス計測
        this.lastDrawTime = 0;
        this.averageDrawTime = 0;
        this.drawCount = 0;
    }

    /**
     * 初期化
     * @returns {Promise<boolean>} 初期化成功時true
     */
    async init() {
        // OffscreenCanvas対応チェック
        if (this.canvas.transferControlToOffscreen && typeof Worker !== 'undefined') {
            try {
                await this._initWorker();
                this.useWorker = true;
                console.log('[SkeletonRenderer] Worker mode initialized');
            } catch (e) {
                console.warn('[SkeletonRenderer] Worker init failed, using fallback:', e);
                this._initFallback();
            }
        } else {
            console.log('[SkeletonRenderer] OffscreenCanvas not supported, using fallback');
            this._initFallback();
        }

        this.isInitialized = true;
        return this.isInitialized;
    }

    /**
     * Workerモードの初期化
     */
    async _initWorker() {
        return new Promise((resolve, reject) => {
            try {
                // Workerを作成
                this.worker = new Worker(this.options.workerPath);

                // OffscreenCanvasに制御を移譲
                this.offscreenCanvas = this.canvas.transferControlToOffscreen();

                // Worker初期化完了待ち
                const initTimeout = setTimeout(() => {
                    reject(new Error('Worker init timeout'));
                }, 5000);

                const onMessage = (e) => {
                    if (e.data.type === 'initialized') {
                        clearTimeout(initTimeout);
                        this.worker.removeEventListener('message', onMessage);
                        this._setupWorkerHandlers();
                        resolve();
                    }
                };

                this.worker.addEventListener('message', onMessage);
                this.worker.addEventListener('error', (e) => {
                    clearTimeout(initTimeout);
                    reject(e);
                });

                // 初期化メッセージを送信
                this.worker.postMessage({
                    type: 'init',
                    canvas: this.offscreenCanvas,
                    width: this.canvas.clientWidth || this.canvas.width,
                    height: this.canvas.clientHeight || this.canvas.height
                }, [this.offscreenCanvas]);

            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Workerメッセージハンドラのセットアップ
     */
    _setupWorkerHandlers() {
        this.worker.onmessage = (e) => {
            const { type, drawId, success, drawTime } = e.data;

            if (type === 'drawComplete') {
                // パフォーマンス計測
                if (drawTime) {
                    this.lastDrawTime = drawTime;
                    this.drawCount++;
                    this.averageDrawTime = (this.averageDrawTime * (this.drawCount - 1) + drawTime) / this.drawCount;
                }

                // 保留中の描画を解決
                const pending = this.pendingDraws.get(drawId);
                if (pending) {
                    pending.resolve(success);
                    this.pendingDraws.delete(drawId);
                }
            } else if (type === 'resized') {
                console.log(`[SkeletonRenderer] Resized to ${e.data.width}x${e.data.height}`);
            }
        };

        this.worker.onerror = (e) => {
            console.error('[SkeletonRenderer] Worker error:', e);
            // 全ての保留中の描画を失敗として解決
            for (const [frame, pending] of this.pendingDraws) {
                pending.reject(e);
            }
            this.pendingDraws.clear();
        };
    }

    /**
     * フォールバックモードの初期化
     */
    _initFallback() {
        this.useWorker = false;
        try {
            this.fallbackCtx = this.canvas.getContext('2d');
        } catch (e) {
            console.error('[SkeletonRenderer] Failed to get 2d context (canvas might be transferred offscreen):', e);
            // キャンバスが既に転送されている場合は復帰できません
            this.fallbackCtx = null;
        }
    }

    /**
     * リサイズ
     * @param {number} width 
     * @param {number} height 
     */
    resize(width, height) {
        if (this.useWorker && this.worker) {
            this.worker.postMessage({
                type: 'resize',
                width,
                height
            });
        } else if (this.fallbackCtx) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }

    /**
     * スケルトン描画（通常モード）
     * @param {Object} keypoints キーポイントデータ
     * @param {number} frame フレーム番号
     * @param {Object} options 描画オプション
     * @returns {Promise<boolean>}
     */
    /**
     * 設定を更新（出力形式切替など）
     * @param {Object} config { outputFormat: '23pts' | 'synthpose' }
     */
    updateConfig(config) {
        if (this.useWorker && this.worker) {
            this.worker.postMessage({ type: 'updateConfig', ...config });
        }
    }

    async draw(keypoints, frame, options = {}) {
        if (!this.isInitialized) {
            console.warn('[SkeletonRenderer] Not initialized');
            return false;
        }

        if (this.useWorker) {
            return this._drawWithWorker(keypoints, frame, options);
        } else {
            return this._drawFallback(keypoints, frame, options);
        }
    }

    /**
     * スケルトン描画（スケール付きモード）
     * @param {Object} keypoints キーポイントデータ
     * @param {number} frame フレーム番号
     * @param {Object} scaleOptions スケールオプション
     * @returns {Promise<boolean>}
     */
    async drawScaled(keypoints, frame, scaleOptions) {
        if (!this.isInitialized) {
            console.warn('[SkeletonRenderer] Not initialized');
            return false;
        }

        if (this.useWorker) {
            return this._drawScaledWithWorker(keypoints, frame, scaleOptions);
        } else {
            return this._drawScaledFallback(keypoints, frame, scaleOptions);
        }
    }

    /**
     * Worker使用の描画
     */
    async _drawWithWorker(keypoints, frame, options) {
        return new Promise((resolve, reject) => {
            const drawId = ++this.drawIdCounter;

            // タイムアウト設定
            const timeout = setTimeout(() => {
                this.pendingDraws.delete(drawId);
                reject(new Error('Draw timeout'));
            }, 1000);

            this.pendingDraws.set(drawId, {
                resolve: (success) => {
                    clearTimeout(timeout);
                    resolve(success);
                },
                reject: (e) => {
                    clearTimeout(timeout);
                    reject(e);
                }
            });

            this.worker.postMessage({
                type: 'draw',
                drawId,
                keypoints,
                frame,
                options
            });
        });
    }

    /**
     * Worker使用のスケール付き描画
     */
    async _drawScaledWithWorker(keypoints, frame, scaleOptions) {
        return new Promise((resolve, reject) => {
            const drawId = ++this.drawIdCounter;

            const timeout = setTimeout(() => {
                this.pendingDraws.delete(drawId);
                reject(new Error('Draw timeout'));
            }, 1000);

            this.pendingDraws.set(drawId, {
                resolve: (success) => {
                    clearTimeout(timeout);
                    resolve(success);
                },
                reject: (e) => {
                    clearTimeout(timeout);
                    reject(e);
                }
            });

            this.worker.postMessage({
                type: 'drawScaled',
                drawId,
                keypoints,
                frame,
                ...scaleOptions
            });
        });
    }

    /**
     * フォールバック描画（メインスレッド）
     */
    _drawFallback(keypoints, frame, options) {
        const ctx = this.fallbackCtx;
        if (!ctx) return false;

        const startTime = performance.now();

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // メインスレッドの既存描画関数を使用
        if (typeof window !== 'undefined' && typeof window.drawKeypoints === 'function') {
            window.drawKeypoints(ctx, keypoints);
        } else {
            this._drawKeypointsFallback(ctx, keypoints, options);
        }

        this.lastDrawTime = performance.now() - startTime;
        return true;
    }

    /**
     * フォールバックのスケール付き描画
     */
    _drawScaledFallback(keypoints, frame, scaleOptions) {
        const ctx = this.fallbackCtx;
        if (!ctx) return false;

        const {
            scaleX,
            scaleY,
            selectedPersonId,
            selectedKeypointIdx,
            zoomFactor = 1,
            panX = 0,
            panY = 0,
            backgroundColor = '#111827'
        } = scaleOptions;

        const startTime = performance.now();

        // 背景
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // 変換適用
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoomFactor, zoomFactor);

        // メインスレッドの既存描画関数を使用
        if (typeof window !== 'undefined' && typeof window.drawScaledKeypoints === 'function') {
            window.drawScaledKeypoints(ctx, keypoints, scaleX, scaleY, selectedPersonId, selectedKeypointIdx, zoomFactor);
        } else {
            this._drawScaledKeypointsFallback(ctx, keypoints, scaleX, scaleY, selectedPersonId, selectedKeypointIdx, zoomFactor);
        }

        ctx.restore();

        this.lastDrawTime = performance.now() - startTime;
        return true;
    }

    /**
     * フォールバック用の描画実装
     */
    _drawKeypointsFallback(ctx, keypoints, options = {}) {
        // 簡略化した描画（完全な実装はapp.jsのdrawKeypointsを参照）
        const COLORS = { right: '#EF4444', left: '#3B82F6', center: '#10B981' };
        const PERSON_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4'];
        const CONFIDENCE_THRESHOLD = 0.3;

        Object.entries(keypoints).forEach(([personId, kpts], idx) => {
            const color = PERSON_COLORS[idx % PERSON_COLORS.length];

            // キーポイント描画
            kpts.forEach((kp, i) => {
                if (kp && kp[2] > CONFIDENCE_THRESHOLD) {
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(kp[0], kp[1], 5, 0, Math.PI * 2);
                    ctx.fill();
                }
            });
        });
    }

    /**
     * フォールバック用のスケール付き描画実装
     */
    _drawScaledKeypointsFallback(ctx, keypoints, scaleX, scaleY, selectedPersonId, selectedKeypointIdx, zoomFactor) {
        const PERSON_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4'];
        const CONFIDENCE_THRESHOLD = 0.3;
        const sizeCompensation = 1 / zoomFactor;

        Object.entries(keypoints).forEach(([personId, kpts], idx) => {
            if (selectedPersonId && personId !== selectedPersonId) return;

            const color = PERSON_COLORS[idx % PERSON_COLORS.length];

            kpts.forEach((kp, i) => {
                if (kp && kp[2] > CONFIDENCE_THRESHOLD) {
                    const isSelected = personId === selectedPersonId && i === selectedKeypointIdx;
                    const radius = (isSelected ? 8 : 4) * sizeCompensation;

                    ctx.fillStyle = isSelected ? '#ffff00' : color;
                    ctx.beginPath();
                    ctx.arc(kp[0] * scaleX, kp[1] * scaleY, radius, 0, Math.PI * 2);
                    ctx.fill();
                }
            });
        });
    }

    /**
     * キャンバスクリア
     */
    clear() {
        if (this.useWorker && this.worker) {
            this.worker.postMessage({ type: 'clear' });
        } else if (this.fallbackCtx) {
            this.fallbackCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    /**
     * キャッシュクリア
     */
    clearCache() {
        if (this.useWorker && this.worker) {
            this.worker.postMessage({ type: 'clearCache' });
        }
    }

    /**
     * パフォーマンス情報取得
     */
    getPerformanceInfo() {
        return {
            useWorker: this.useWorker,
            lastDrawTime: this.lastDrawTime,
            averageDrawTime: this.averageDrawTime,
            drawCount: this.drawCount
        };
    }

    /**
     * 破棄
     */
    destroy() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.offscreenCanvas = null;
        this.fallbackCtx = null;
        this.isInitialized = false;
        this.pendingDraws.clear();
    }
}

// グローバルに公開（モジュール非対応環境用）
if (typeof window !== 'undefined') {
    window.SkeletonRenderer = SkeletonRenderer;
}

// ES Module対応
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SkeletonRenderer;
}
