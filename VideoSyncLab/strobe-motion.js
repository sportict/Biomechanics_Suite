// === ストロボモーション機能モジュール ===

// バスケットボールのストロボモーションのように、選択したオブジェクトの残像を残す

class StrobeMotionController {
    constructor(videoPlayer) {
        this.videoPlayer = videoPlayer;
        this.isActive = false;
        this.currentTool = 'rectangle'; // 'rectangle' or 'lasso'
        this.selections = []; // 各フレームの選択領域を保存
        this.currentSelection = null;
        this.isDrawing = false;
        this.isPanning = false;
        this.lassoPoints = [];
        this.startPoint = null;

        // 設定
        this.settings = {
            opacity: 0,             // 透明度 (0-1) 0=不透明、1=完全透明
            fadeMode: 'uniform',    // 'uniform' (均一) or 'fade' (徐々に薄く)
            backgroundColor: 'original', // 'original' (元の背景) or 'transparent' or カラー
            blendMode: 'source-over', // 合成モード
            useBgSubtraction: false, // 背景差分を使用
            bgSubThreshold: 30       // 背景差分の閾値 (0-255)
        };

        // AI セグメンテーション設定
        this.aiSettings = {
            gamma: 1.2,              // ガンマ補正 (1.0=そのまま、>1.0=明るく)
            alphaThreshold: 10,      // ノイズ除去閾値 (0-255)
            alphaBoost: 1.05,        // アルファブースト
            showEdgeOverlay: true    // エッジオーバーレイ表示
        };

        // 背景差分用の背景フレーム
        this.backgroundFrame = null;

        // 編集中のキャプチャインデックス（-1は新規）
        this.editingCaptureIndex = -1;

        // キャンバス要素
        this.overlayCanvas = null;
        this.overlayCtx = null;
        this.previewCanvas = null;
        this.previewCtx = null;

        // 状態管理
        this.capturedFrames = []; // キャプチャしたフレームデータ
        this.currentFrameIndex = 0;
        this.lastGeneratedCanvas = null; // 最後に生成したキャンバス

        // パフォーマンス最適化用
        this.animationFrameId = null;           // requestAnimationFrame ID
        this.resizeTimeout = null;              // リサイズデバウンス用
        this.capturedFramesCache = null;        // キャプチャ済みフレームのキャッシュキャンバス
        this.capturedFramesCacheValid = false;  // キャッシュが有効か
        this.lastZoom = 1;                      // 前回のズーム値
        this.lastPanX = 0;                      // 前回のパンX値
        this.lastPanY = 0;                      // 前回のパンY値

        this.init();
    }

    init() {
        this.createUI();
        this.bindEvents();
        this.bindDragEvents();
    }

    // === フローティングウィンドウのドラッグ機能 ===
    bindDragEvents() {
        const panel = document.getElementById('strobe-motion-panel');
        const header = panel?.querySelector('.strobe-header');

        if (!panel || !header) return;

        let isDragging = false;
        let offsetX = 0;
        let offsetY = 0;

        header.addEventListener('mousedown', (e) => {
            // 閉じるボタンをクリックした場合はドラッグしない
            if (e.target.closest('.strobe-close-btn')) return;

            isDragging = true;
            panel.classList.add('dragging');

            // パネルの現在位置を取得
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;

            // transformをリセットして絶対位置に変換
            panel.style.transform = 'none';
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            e.preventDefault();

            let newLeft = e.clientX - offsetX;
            let newTop = e.clientY - offsetY;

            // 画面外に出ないように制限
            const panelRect = panel.getBoundingClientRect();
            const maxLeft = window.innerWidth - panelRect.width;
            const maxTop = window.innerHeight - panelRect.height;

            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                panel.classList.remove('dragging');
            }
        });
    }

    createUI() {
        // ストロボモーションパネルを作成
        const panel = document.createElement('div');
        panel.id = 'strobe-motion-panel';
        panel.className = 'strobe-motion-panel';
        panel.innerHTML = `
            <div class="strobe-header">
                <h3>🏀 ストロボモーション</h3>
                <div class="strobe-header-buttons">
                    <button id="strobe-minimize-btn" class="strobe-minimize-btn" title="最小化/展開">▼</button>
                    <button id="strobe-close-btn" class="strobe-close-btn" title="閉じる">✕</button>
                </div>
            </div>
            
            <div id="strobe-content" class="strobe-content">
            <div class="strobe-section">
                <div class="strobe-label">選択ツール <span style="color:#888;font-size:10px;">(Shift: 正方形/正円, Ctrl: 中心基準)</span></div>
                <div class="strobe-tool-buttons">
                    <button id="tool-rectangle" class="strobe-tool-btn active" title="長方形選択 (Shift: 正方形, Ctrl: 中心基準)">
                        <span class="tool-icon">▢</span>
                        <span class="tool-name">長方形</span>
                    </button>
                    <button id="tool-ellipse" class="strobe-tool-btn" title="円形選択 (Shift: 正円, Ctrl: 中心基準)">
                        <span class="tool-icon">○</span>
                        <span class="tool-name">円</span>
                    </button>
                    <button id="tool-lasso" class="strobe-tool-btn" title="投げ縄ツール">
                        <span class="tool-icon">✎</span>
                        <span class="tool-name">投げ縄</span>
                    </button>
                </div>
            </div>
            
            <div class="strobe-section strobe-actions">
                <div class="strobe-frame-info">
                    <span id="strobe-frame-count">選択: 0 フレーム</span>
                </div>
                <div class="strobe-action-buttons">
                    <button id="strobe-ai-capture-btn" class="strobe-btn strobe-btn-primary" style="background: linear-gradient(135deg, #9C27B0 0%, #673AB7 100%);" title="AIで人物を自動切り抜きしてキャプチャ">
                        <span class="strobe-icon">🤖</span> AIキャプチャ
                    </button>
                    <button id="strobe-capture-btn" class="strobe-btn strobe-btn-primary" title="現在の選択範囲をキャプチャ">
                        <span class="strobe-icon">📷</span> キャプチャ
                    </button>
                    <button id="strobe-clear-btn" class="strobe-btn strobe-btn-warning" title="キャプチャをクリア">
                        🗑️ クリア
                    </button>
                    <button id="strobe-generate-btn" class="strobe-btn strobe-btn-success" title="ストロボモーション生成（プレビュー）">
                        ✨ 生成
                    </button>
                    <button id="strobe-save-image-btn" class="strobe-btn strobe-btn-secondary" title="画像として保存">
                        🖼️ 画像保存
                    </button>
                    <button id="strobe-save-video-btn" class="strobe-btn strobe-btn-secondary" title="動画として保存">
                        🎬 動画保存
                    </button>
                </div>
            </div>
            
            <div class="strobe-section strobe-preview-section" style="display: none;">
                <div class="strobe-label">プレビュー</div>
                <div class="strobe-preview-container">
                    <canvas id="strobe-preview-canvas"></canvas>
                </div>
            </div>
            
            <div class="strobe-instructions">
                <p>📌 使い方:</p>
                <ol>
                    <li>選択ツールで追跡したいオブジェクトを囲む</li>
                    <li>「キャプチャ」でフレームを記録</li>
                    <li>フレームを移動して繰り返す</li>
                    <li>「生成」でプレビュー、「画像保存」「動画保存」で出力</li>
                </ol>
            </div>
            </div> <!-- strobe-content closing -->
        `;

        document.body.appendChild(panel);

        // オーバーレイキャンバスを作成（動画の上に配置）
        this.createOverlayCanvas('left');
        this.createOverlayCanvas('right');
    }

    createOverlayCanvas(side) {
        const videoWrapper = document.querySelector(`#${side}-player .video-wrapper`);
        if (!videoWrapper) return;

        const canvas = document.createElement('canvas');
        canvas.id = `strobe-overlay-${side}`;
        canvas.className = 'strobe-overlay-canvas';
        canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 100;
        `;

        videoWrapper.style.position = 'relative';
        videoWrapper.appendChild(canvas);
    }

    bindEvents() {
        // パネル閉じるボタン
        document.getElementById('strobe-close-btn')?.addEventListener('click', () => {
            this.deactivate();
        });

        // パネル最小化ボタン
        document.getElementById('strobe-minimize-btn')?.addEventListener('click', () => {
            const content = document.getElementById('strobe-content');
            const btn = document.getElementById('strobe-minimize-btn');
            if (content && btn) {
                if (content.style.display === 'none') {
                    content.style.display = 'block';
                    btn.textContent = '▼';
                    btn.title = '最小化';
                } else {
                    content.style.display = 'none';
                    btn.textContent = '▲';
                    btn.title = '展開';
                }
            }
        });

        // ツール選択
        document.getElementById('tool-rectangle')?.addEventListener('click', () => {
            this.selectTool('rectangle');
        });

        document.getElementById('tool-ellipse')?.addEventListener('click', () => {
            this.selectTool('ellipse');
        });

        document.getElementById('tool-lasso')?.addEventListener('click', () => {
            this.selectTool('lasso');
        });

        // 設定変更
        document.getElementById('strobe-opacity')?.addEventListener('input', (e) => {
            this.settings.opacity = parseFloat(e.target.value);
            document.getElementById('strobe-opacity-value').textContent =
                Math.round(this.settings.opacity * 100) + '%';
        });

        document.getElementById('strobe-fade-mode')?.addEventListener('change', (e) => {
            this.settings.fadeMode = e.target.value;
        });

        document.getElementById('strobe-background')?.addEventListener('change', (e) => {
            this.settings.backgroundColor = e.target.value;
        });

        document.getElementById('strobe-blend-mode')?.addEventListener('change', (e) => {
            this.settings.blendMode = e.target.value;
        });

        // 背景差分設定
        document.getElementById('strobe-bg-subtraction')?.addEventListener('change', (e) => {
            const useIt = e.target.value === 'on';
            this.settings.useBgSubtraction = useIt;

            // 関連UIの表示/非表示
            const thresholdRow = document.getElementById('bg-sub-threshold-row');
            const captureRow = document.getElementById('bg-sub-capture-row');
            if (thresholdRow) thresholdRow.style.display = useIt ? 'flex' : 'none';
            if (captureRow) captureRow.style.display = useIt ? 'flex' : 'none';
        });

        document.getElementById('strobe-bg-threshold')?.addEventListener('input', (e) => {
            this.settings.bgSubThreshold = parseInt(e.target.value);
            document.getElementById('strobe-bg-threshold-value').textContent = e.target.value;
        });

        document.getElementById('strobe-capture-bg-btn')?.addEventListener('click', () => {
            this.captureBackgroundFrame();
        });

        // アクションボタン
        document.getElementById('strobe-ai-capture-btn')?.addEventListener('click', () => {
            this.captureCurrentFrameWithAI();
        });

        document.getElementById('strobe-capture-btn')?.addEventListener('click', () => {
            this.captureCurrentFrame();
        });

        document.getElementById('strobe-clear-btn')?.addEventListener('click', () => {
            this.clearCaptures();
        });

        document.getElementById('strobe-generate-btn')?.addEventListener('click', () => {
            this.generateStrobeMotion();
        });

        document.getElementById('strobe-save-image-btn')?.addEventListener('click', () => {
            this.saveImageWithDialog();
        });

        document.getElementById('strobe-save-video-btn')?.addEventListener('click', () => {
            this.saveVideoWithDialog();
        });

        // AI調整設定
        document.getElementById('strobe-ai-gamma')?.addEventListener('input', (e) => {
            this.aiSettings.gamma = parseFloat(e.target.value);
            document.getElementById('strobe-ai-gamma-value').textContent = e.target.value;
        });

        document.getElementById('strobe-ai-threshold')?.addEventListener('input', (e) => {
            this.aiSettings.alphaThreshold = parseInt(e.target.value);
            document.getElementById('strobe-ai-threshold-value').textContent = e.target.value;
        });

        document.getElementById('strobe-ai-boost')?.addEventListener('input', (e) => {
            this.aiSettings.alphaBoost = parseFloat(e.target.value);
            document.getElementById('strobe-ai-boost-value').textContent = e.target.value;
        });

        document.getElementById('strobe-ai-show-edge')?.addEventListener('change', (e) => {
            this.aiSettings.showEdgeOverlay = e.target.checked;
            this.invalidateCapturedFramesCache();
            this.redrawCurrentSelection();
        });
    }

    selectTool(tool) {
        this.currentTool = tool;

        // ボタンのアクティブ状態を更新
        document.querySelectorAll('.strobe-tool-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.getElementById(`tool-${tool}`)?.classList.add('active');
    }

    activate(side = 'left') {
        this.isActive = true;
        this.activeSide = side;

        const panel = document.getElementById('strobe-motion-panel');
        if (panel) {
            panel.classList.add('active');
        }

        // オーバーレイキャンバスを有効化
        const canvas = document.getElementById(`strobe-overlay-${side}`);
        if (canvas) {
            canvas.style.pointerEvents = 'auto';
            this.overlayCanvas = canvas;
            this.overlayCtx = canvas.getContext('2d');
            this.resizeCanvas();
            this.bindCanvasEvents();

            // 既存のデータがあれば再描画
            this.invalidateCapturedFramesCache();
            this.drawCapturedPositions();
        }

        this.updateStatus('ストロボモーションモードを開始しました');
    }

    deactivate() {
        this.isActive = false;

        const panel = document.getElementById('strobe-motion-panel');
        if (panel) {
            panel.classList.remove('active');
        }

        // オーバーレイキャンバスを無効化
        ['left', 'right'].forEach(side => {
            const canvas = document.getElementById(`strobe-overlay-${side}`);
            if (canvas) {
                canvas.style.pointerEvents = 'none';
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        });

        this.unbindCanvasEvents();
        this.updateStatus('ストロボモーションモードを終了しました');
    }

    resizeCanvas() {
        if (!this.overlayCanvas) return;

        const video = this.videoPlayer?.players?.[this.activeSide]?.video;
        if (!video) return;

        // キャンバスを動画ラッパーのサイズに合わせる
        const videoWrapper = video.parentElement;
        const rect = videoWrapper.getBoundingClientRect();

        this.overlayCanvas.width = rect.width;
        this.overlayCanvas.height = rect.height;

        // 動画のアスペクト比を考慮した表示サイズを計算
        const videoAspect = video.videoWidth / video.videoHeight;
        const containerAspect = rect.width / rect.height;

        let displayWidth, displayHeight, offsetX, offsetY;

        if (videoAspect > containerAspect) {
            // 横長の動画
            displayWidth = rect.width;
            displayHeight = rect.width / videoAspect;
            offsetX = 0;
            offsetY = (rect.height - displayHeight) / 2;
        } else {
            // 縦長の動画
            displayHeight = rect.height;
            displayWidth = rect.height * videoAspect;
            offsetX = (rect.width - displayWidth) / 2;
            offsetY = 0;
        }

        // 表示オフセットを保存
        this.displayOffset = { x: offsetX, y: offsetY };
        this.displaySize = { width: displayWidth, height: displayHeight };

        // 動画の実際のサイズとの比率を保存
        this.scaleX = video.videoWidth / displayWidth;
        this.scaleY = video.videoHeight / displayHeight;
    }

    bindCanvasEvents() {
        if (!this.overlayCanvas) return;

        this.handleMouseDown = this.onMouseDown.bind(this);
        this.handleMouseMove = this.onMouseMove.bind(this);
        this.handleMouseUp = this.onMouseUp.bind(this);
        this.handleResize = this.onResize.bind(this);
        this.handleContextMenu = (e) => e.preventDefault();

        this.overlayCanvas.addEventListener('mousedown', this.handleMouseDown);
        this.overlayCanvas.addEventListener('mousemove', this.handleMouseMove);
        this.overlayCanvas.addEventListener('mouseup', this.handleMouseUp);
        this.overlayCanvas.addEventListener('mouseleave', this.handleMouseUp);

        // 右クリックメニューを無効化
        this.overlayCanvas.addEventListener('contextmenu', this.handleContextMenu);

        // ウィンドウリサイズ時にキャンバスをリサイズ
        window.addEventListener('resize', this.handleResize);
    }

    onResize() {
        // リサイズイベントのデバウンス（連続呼び出しを防止）
        if (this.resizeTimeout) {
            clearTimeout(this.resizeTimeout);
        }
        // 最大化アニメーション対応：150msのデバウンス
        this.resizeTimeout = setTimeout(() => {
            // 2フレーム待ってレイアウト完了を確認
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.resizeCanvas();
                    this.invalidateCapturedFramesCache();
                    this.redrawCurrentSelection();

                    // 最大化アニメーション完了後にもう一度描画（念のため）
                    setTimeout(() => {
                        this.resizeCanvas();
                        this.invalidateCapturedFramesCache();
                        this.redrawCurrentSelection();
                    }, 100);
                });
            });
        }, 150);
    }

    // キャプチャ済みフレームのキャッシュを無効化
    invalidateCapturedFramesCache() {
        this.capturedFramesCacheValid = false;
    }

    // 現在の選択範囲を再描画
    redrawCurrentSelection() {
        if (!this.overlayCtx) return;

        // キャンバスサイズと表示パラメータを同期させる
        this.resizeCanvas();

        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        // キャプチャ済みの位置を先に描画
        if (this.capturedFrames.length > 0) {
            this.drawCapturedPositionsOnly();
        }

        // 現在の選択範囲を描画（ビデオ座標から表示座標を再計算）
        if (this.currentSelection) {
            const offsetX = this.displayOffset?.x || 0;
            const offsetY = this.displayOffset?.y || 0;

            if (this.currentSelection.type === 'rectangle' && this.currentSelection.videoX !== undefined) {
                // ビデオ座標から表示座標を再計算
                const x1 = this.currentSelection.videoX / this.scaleX + offsetX;
                const y1 = this.currentSelection.videoY / this.scaleY + offsetY;
                const x2 = (this.currentSelection.videoX + this.currentSelection.videoWidth) / this.scaleX + offsetX;
                const y2 = (this.currentSelection.videoY + this.currentSelection.videoHeight) / this.scaleY + offsetY;

                // 表示座標も更新
                this.currentSelection.x = x1;
                this.currentSelection.y = y1;
                this.currentSelection.width = x2 - x1;
                this.currentSelection.height = y2 - y1;

                this.drawRectangle({ x: x1, y: y1 }, { x: x2, y: y2 });
            } else if (this.currentSelection.type === 'ellipse' && this.currentSelection.videoX !== undefined) {
                // ビデオ座標から表示座標を再計算
                const x1 = this.currentSelection.videoX / this.scaleX + offsetX;
                const y1 = this.currentSelection.videoY / this.scaleY + offsetY;
                const x2 = (this.currentSelection.videoX + this.currentSelection.videoWidth) / this.scaleX + offsetX;
                const y2 = (this.currentSelection.videoY + this.currentSelection.videoHeight) / this.scaleY + offsetY;

                // 表示座標も更新
                this.currentSelection.x = x1;
                this.currentSelection.y = y1;
                this.currentSelection.width = x2 - x1;
                this.currentSelection.height = y2 - y1;

                this.drawEllipse({ x: x1, y: y1 }, { x: x2, y: y2 });
            } else if (this.currentSelection.type === 'lasso' && this.currentSelection.videoPoints) {
                // ビデオ座標から表示座標を再計算
                this.currentSelection.points = this.currentSelection.videoPoints.map(p => ({
                    x: p.x / this.scaleX + offsetX,
                    y: p.y / this.scaleY + offsetY
                }));
                this.lassoPoints = [...this.currentSelection.points];
                this.drawLasso();
            } else if (this.currentSelection.type === 'rectangle') {
                // videoX が未定義の場合は従来の表示座標を使用
                this.drawRectangle(
                    { x: this.currentSelection.x, y: this.currentSelection.y },
                    {
                        x: this.currentSelection.x + this.currentSelection.width,
                        y: this.currentSelection.y + this.currentSelection.height
                    }
                );
            } else if (this.currentSelection.type === 'ellipse') {
                this.drawEllipse(
                    { x: this.currentSelection.x, y: this.currentSelection.y },
                    {
                        x: this.currentSelection.x + this.currentSelection.width,
                        y: this.currentSelection.y + this.currentSelection.height
                    }
                );
            } else if (this.currentSelection.type === 'lasso' && this.currentSelection.points) {
                this.lassoPoints = [...this.currentSelection.points];
                this.drawLasso();
            } else if (this.currentSelection.type === 'ai-mask') {
                // ai-maskの場合は capturedFrames から直接データを取得して描画
                // これにより drawCapturedPositions と完全に同じ計算式を使用
                const frame = this.editingCaptureIndex >= 0
                    ? this.capturedFrames[this.editingCaptureIndex]
                    : null;

                if (frame && frame.bitmap) {
                    const player = this.videoPlayer?.players?.[this.activeSide];
                    const zoom = player?.zoom || 1;
                    const panX = player?.panX || 0;
                    const panY = player?.panY || 0;

                    // drawCapturedPositions と同じ座標計算
                    const videoX = frame.drawPosition ? frame.drawPosition.x : frame.bounds.x;
                    const videoY = frame.drawPosition ? frame.drawPosition.y : frame.bounds.y;
                    const displayX = videoX / this.scaleX + offsetX;
                    const displayY = videoY / this.scaleY + offsetY;

                    const displayWidth = frame.bitmap.width / this.scaleX;
                    const displayHeight = frame.bitmap.height / this.scaleY;

                    this.overlayCtx.save();

                    // ズームとパンを適用（動画と同じ変換）
                    const centerX = this.overlayCanvas.width / 2;
                    const centerY = this.overlayCanvas.height / 2;
                    this.overlayCtx.translate(centerX, centerY);
                    this.overlayCtx.scale(zoom, zoom);
                    this.overlayCtx.translate(-centerX + panX, -centerY + panY);

                    // エッジがある場合はバウンディングボックスを描画しない
                    // エッジがない場合のみ選択枠を描画
                    if (!(frame.edgePoints && frame.edgePoints.length > 0 && this.aiSettings?.showEdgeOverlay)) {
                        this.overlayCtx.strokeStyle = '#00ff00';
                        this.overlayCtx.lineWidth = 2 / zoom;
                        this.overlayCtx.setLineDash([5 / zoom, 5 / zoom]);
                        this.overlayCtx.strokeRect(displayX, displayY, displayWidth, displayHeight);
                    }

                    // エッジ描画 - drawCapturedPositions と同じ計算式
                    if (frame.edgePoints && frame.edgePoints.length > 0 && this.aiSettings?.showEdgeOverlay) {
                        const edgeScaleX = displayWidth / frame.bitmap.width;
                        const edgeScaleY = displayHeight / frame.bitmap.height;
                        const edgePixelSize = Math.max(1.5, 1.5 / zoom);
                        const step = Math.max(1, Math.floor(frame.edgePoints.length / 5000));

                        this.overlayCtx.fillStyle = 'rgba(0, 255, 255, 0.9)';
                        for (let i = 0; i < frame.edgePoints.length; i += step) {
                            const pt = frame.edgePoints[i];
                            const edgeX = displayX + pt.x * edgeScaleX;
                            const edgeY = displayY + pt.y * edgeScaleY;
                            this.overlayCtx.fillRect(edgeX, edgeY, edgePixelSize, edgePixelSize);
                        }

                        // フレーム番号をエッジ付近に表示（編集中）
                        this.overlayCtx.fillStyle = 'rgba(0, 255, 0, 1.0)';
                        this.overlayCtx.font = `bold ${14 / zoom}px sans-serif`;
                        this.overlayCtx.fillText(`編集中 #${this.editingCaptureIndex + 1}`, displayX + 2, displayY - 6);
                    }

                    this.overlayCtx.restore();
                }
            }
        }
    }

    // キャプチャ済みの位置のみを描画（clearなし）- キャッシュ機能付き
    drawCapturedPositionsOnly() {
        if (!this.overlayCtx || this.capturedFrames.length === 0) return;

        const player = this.videoPlayer?.players?.[this.activeSide];
        const zoom = player?.zoom || 1;
        const panX = player?.panX || 0;
        const panY = player?.panY || 0;

        // ズーム/パンが変わったらキャッシュを無効化
        if (zoom !== this.lastZoom || panX !== this.lastPanX || panY !== this.lastPanY) {
            this.capturedFramesCacheValid = false;
            this.lastZoom = zoom;
            this.lastPanX = panX;
            this.lastPanY = panY;
        }

        // キャッシュが有効な場合はキャッシュを使用
        if (this.capturedFramesCacheValid && this.capturedFramesCache) {
            this.overlayCtx.drawImage(this.capturedFramesCache, 0, 0);
            return;
        }

        // キャッシュ用キャンバスを作成または更新
        if (!this.capturedFramesCache ||
            this.capturedFramesCache.width !== this.overlayCanvas.width ||
            this.capturedFramesCache.height !== this.overlayCanvas.height) {
            this.capturedFramesCache = document.createElement('canvas');
            this.capturedFramesCache.width = this.overlayCanvas.width;
            this.capturedFramesCache.height = this.overlayCanvas.height;
        }

        const cacheCtx = this.capturedFramesCache.getContext('2d');
        cacheCtx.clearRect(0, 0, this.capturedFramesCache.width, this.capturedFramesCache.height);

        // 表示オフセット
        const offsetX = this.displayOffset?.x || 0;
        const offsetY = this.displayOffset?.y || 0;

        cacheCtx.save();

        // ズームとパンを適用
        const centerX = this.overlayCanvas.width / 2;
        const centerY = this.overlayCanvas.height / 2;
        cacheCtx.translate(centerX, centerY);
        cacheCtx.scale(zoom, zoom);
        cacheCtx.translate(-centerX + panX, -centerY + panY);

        // キャプチャ済みの各位置を描画
        this.capturedFrames.forEach((frame, index) => {
            const selection = frame.selection;

            // 色を変化させる（古いほど薄く）
            const alpha = 0.3 + (0.5 * (index / Math.max(1, this.capturedFrames.length - 1)));

            if (selection.type === 'rectangle') {
                // 動画座標から表示座標に変換
                const x = selection.videoX / this.scaleX + offsetX;
                const y = selection.videoY / this.scaleY + offsetY;
                const width = selection.videoWidth / this.scaleX;
                const height = selection.videoHeight / this.scaleY;

                cacheCtx.strokeStyle = `rgba(255, 165, 0, ${alpha})`; // オレンジ
                cacheCtx.lineWidth = 2 / zoom;
                cacheCtx.setLineDash([]);
                cacheCtx.strokeRect(x, y, width, height);

                // フレーム番号を表示
                cacheCtx.fillStyle = `rgba(255, 165, 0, ${alpha})`;
                cacheCtx.font = `${12 / zoom}px sans-serif`;
                cacheCtx.fillText(`#${index + 1}`, x + 2, y - 4);
            } else if (selection.type === 'ellipse') {
                // 動画座標から表示座標に変換
                const x = selection.videoX / this.scaleX + offsetX;
                const y = selection.videoY / this.scaleY + offsetY;
                const width = selection.videoWidth / this.scaleX;
                const height = selection.videoHeight / this.scaleY;

                // 楕円の中心と半径を計算
                const cx = x + width / 2;
                const cy = y + height / 2;
                const rx = width / 2;
                const ry = height / 2;

                cacheCtx.strokeStyle = `rgba(255, 165, 0, ${alpha})`; // オレンジ
                cacheCtx.lineWidth = 2 / zoom;
                cacheCtx.setLineDash([]);
                cacheCtx.beginPath();
                cacheCtx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
                cacheCtx.stroke();

                // フレーム番号を表示
                cacheCtx.fillStyle = `rgba(255, 165, 0, ${alpha})`;
                cacheCtx.font = `${12 / zoom}px sans-serif`;
                cacheCtx.fillText(`#${index + 1}`, x + 2, y - 4);
            } else if (selection.type === 'lasso' && selection.points) {
                cacheCtx.strokeStyle = `rgba(255, 165, 0, ${alpha})`;
                cacheCtx.lineWidth = 2 / zoom;
                cacheCtx.setLineDash([]);

                cacheCtx.beginPath();
                const firstPoint = selection.points[0];
                cacheCtx.moveTo(firstPoint.x, firstPoint.y);

                for (let i = 1; i < selection.points.length; i++) {
                    cacheCtx.lineTo(selection.points[i].x, selection.points[i].y);
                }
                cacheCtx.closePath();
                cacheCtx.closePath();
                cacheCtx.stroke();
            } else if (selection.type === 'ai-mask') {
                // AIマスクのバウンディングボックスを描画
                if (selection.bounds) {
                    const b = selection.bounds;
                    // 動画座標から表示座標に変換
                    const x = b.x / this.scaleX + offsetX;
                    const y = b.y / this.scaleY + offsetY;
                    const width = b.width / this.scaleX;
                    const height = b.height / this.scaleY;

                    cacheCtx.strokeStyle = `rgba(156, 39, 176, ${alpha})`; // 紫
                    cacheCtx.lineWidth = 2 / zoom;
                    cacheCtx.setLineDash([2, 2]);
                    cacheCtx.strokeRect(x, y, width, height);

                    // ラベル
                    cacheCtx.fillStyle = `rgba(156, 39, 176, ${alpha})`;
                    cacheCtx.font = `${10 / zoom}px sans-serif`;
                    cacheCtx.fillText(`AI #${index + 1}`, x, y - 4);
                }
            }
        });

        cacheCtx.restore();

        // キャッシュを有効化
        this.capturedFramesCacheValid = true;

        // キャッシュをメインキャンバスに描画
        this.overlayCtx.drawImage(this.capturedFramesCache, 0, 0);
    }

    unbindCanvasEvents() {
        if (!this.overlayCanvas) return;

        this.overlayCanvas.removeEventListener('mousedown', this.handleMouseDown);
        this.overlayCanvas.removeEventListener('mousemove', this.handleMouseMove);
        this.overlayCanvas.removeEventListener('mouseup', this.handleMouseUp);
        this.overlayCanvas.removeEventListener('mouseleave', this.handleMouseUp);
        this.overlayCanvas.removeEventListener('contextmenu', this.handleContextMenu);
        window.removeEventListener('resize', this.handleResize);
    }

    // ズーム・パン変更時に呼び出される（外部から呼び出し可能）
    onZoomPanChange() {
        console.log('Debug: StrobeMotionController.onZoomPanChange called');
        // ズーム/パンが変わるのでキャッシュを無効化
        this.invalidateCapturedFramesCache();
        this.redrawCurrentSelection();
        // キャプチャ済みの位置も再描画
        if (this.capturedFrames.length > 0 && !this.currentSelection) {
            this.drawCapturedPositions();
        }
    }

    getMousePos(e) {
        const video = this.videoPlayer?.players?.[this.activeSide]?.video;
        const canvasRect = this.overlayCanvas.getBoundingClientRect();

        // マウス座標をキャンバス相対座標に変換
        const mouseX = e.clientX - canvasRect.left;
        const mouseY = e.clientY - canvasRect.top;

        if (!video) {
            return { x: mouseX, y: mouseY };
        }

        const player = this.videoPlayer.players[this.activeSide];
        const zoom = player.zoom || 1;
        const panX = player.panX || 0;
        const panY = player.panY || 0;

        // キャンバス中心
        const centerX = canvasRect.width / 2;
        const centerY = canvasRect.height / 2;

        // ズームとパンを逆変換して、元の座標系での位置を計算
        // transform: scale(zoom) translate(panX, panY) の逆変換
        const adjustedX = (mouseX - centerX) / zoom + centerX - panX;
        const adjustedY = (mouseY - centerY) / zoom + centerY - panY;

        return {
            x: adjustedX,
            y: adjustedY
        };
    }

    onMouseDown(e) {
        if (!this.isActive) return;

        if (e.button === 0) {
            // 左クリック: 範囲選択
            this.isDrawing = true;
            const pos = this.getMousePos(e);
            this.startPoint = pos;

            if (this.currentTool === 'lasso') {
                this.lassoPoints = [pos];
            }

            this.resizeCanvas();
        } else if (e.button === 2) {
            // 右クリック: パン操作（通常画面と同じ動作）
            e.preventDefault();
            this.isPanning = true;
            this.videoPlayer?.startPan(this.activeSide, e.clientX, e.clientY);
        }
    }

    onMouseMove(e) {
        if (!this.isActive) return;

        // パン操作中
        if (this.isPanning) {
            e.preventDefault();
            this.videoPlayer?.updatePan(this.activeSide, e.clientX, e.clientY);
            return;
        }

        // 範囲選択中
        if (!this.isDrawing) return;

        // マウス位置とキー状態を保存
        this.pendingMousePos = this.getMousePos(e);
        this.pendingShiftKey = e.shiftKey;
        this.pendingCtrlKey = e.ctrlKey;

        // requestAnimationFrame でスロットリング
        if (this.animationFrameId) {
            return; // 既にリクエスト中の場合はスキップ
        }

        this.animationFrameId = requestAnimationFrame(() => {
            this.animationFrameId = null;

            if (!this.isDrawing || !this.pendingMousePos) return;

            const pos = this.pendingMousePos;
            const shiftKey = this.pendingShiftKey;
            const ctrlKey = this.pendingCtrlKey;

            this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

            // キャプチャ済みの位置を先に描画（キャッシュ使用）
            if (this.capturedFrames.length > 0) {
                this.drawCapturedPositionsOnly();
            }

            if (this.currentTool === 'rectangle') {
                this.drawRectangle(this.startPoint, pos, shiftKey, ctrlKey);
            } else if (this.currentTool === 'ellipse') {
                this.drawEllipse(this.startPoint, pos, shiftKey, ctrlKey);
            } else if (this.currentTool === 'lasso') {
                this.lassoPoints.push(pos);
                this.drawLasso();
            }

            // キーの状態を保存（onMouseUpで使用）
            this.lastShiftKey = shiftKey;
            this.lastCtrlKey = ctrlKey;
        });
    }

    onMouseUp(e) {
        if (!this.isActive) return;

        // パン操作終了
        if (this.isPanning && e.button === 2) {
            this.isPanning = false;
            this.videoPlayer?.endPan(this.activeSide);
            return;
        }

        // 範囲選択終了
        if (!this.isDrawing) return;

        this.isDrawing = false;
        const pos = this.getMousePos(e);
        const shiftKey = this.lastShiftKey || e.shiftKey; // 保存されたShiftキーの状態を使用
        const ctrlKey = this.lastCtrlKey || e.ctrlKey;    // 保存されたCtrlキーの状態を使用

        // 表示オフセットを取得
        const offsetX = this.displayOffset?.x || 0;
        const offsetY = this.displayOffset?.y || 0;

        if (this.currentTool === 'rectangle') {
            let width = pos.x - this.startPoint.x;
            let height = pos.y - this.startPoint.y;

            // Shiftキーで正方形に
            if (shiftKey) {
                const size = Math.max(Math.abs(width), Math.abs(height));
                width = width >= 0 ? size : -size;
                height = height >= 0 ? size : -size;
            }

            let x1, y1, x2, y2;

            // Ctrlキーで中心基準に
            if (ctrlKey) {
                // 開始点を中心として描画
                const halfWidth = Math.abs(width);
                const halfHeight = Math.abs(height);
                x1 = this.startPoint.x - halfWidth;
                y1 = this.startPoint.y - halfHeight;
                x2 = this.startPoint.x + halfWidth;
                y2 = this.startPoint.y + halfHeight;
            } else {
                // 通常: 左上基準
                x1 = Math.min(this.startPoint.x, this.startPoint.x + width);
                y1 = Math.min(this.startPoint.y, this.startPoint.y + height);
                x2 = Math.max(this.startPoint.x, this.startPoint.x + width);
                y2 = Math.max(this.startPoint.y, this.startPoint.y + height);
            }

            // 動画座標に変換（オフセットを考慮）
            const videoX = (x1 - offsetX) * this.scaleX;
            const videoY = (y1 - offsetY) * this.scaleY;
            const videoWidth = (x2 - x1) * this.scaleX;
            const videoHeight = (y2 - y1) * this.scaleY;

            this.currentSelection = {
                type: 'rectangle',
                x: x1,
                y: y1,
                width: x2 - x1,
                height: y2 - y1,
                videoX: Math.max(0, videoX),
                videoY: Math.max(0, videoY),
                videoWidth: videoWidth,
                videoHeight: videoHeight
            };
        } else if (this.currentTool === 'ellipse') {
            let width = pos.x - this.startPoint.x;
            let height = pos.y - this.startPoint.y;

            // Shiftキーで正円に
            if (shiftKey) {
                const size = Math.max(Math.abs(width), Math.abs(height));
                width = width >= 0 ? size : -size;
                height = height >= 0 ? size : -size;
            }

            let x1, y1, x2, y2;

            // Ctrlキーで中心基準に
            if (ctrlKey) {
                // 開始点を中心として描画
                const halfWidth = Math.abs(width);
                const halfHeight = Math.abs(height);
                x1 = this.startPoint.x - halfWidth;
                y1 = this.startPoint.y - halfHeight;
                x2 = this.startPoint.x + halfWidth;
                y2 = this.startPoint.y + halfHeight;
            } else {
                // 通常: 左上基準
                x1 = Math.min(this.startPoint.x, this.startPoint.x + width);
                y1 = Math.min(this.startPoint.y, this.startPoint.y + height);
                x2 = Math.max(this.startPoint.x, this.startPoint.x + width);
                y2 = Math.max(this.startPoint.y, this.startPoint.y + height);
            }

            // 動画座標に変換（オフセットを考慮）
            const videoX = (x1 - offsetX) * this.scaleX;
            const videoY = (y1 - offsetY) * this.scaleY;
            const videoWidth = (x2 - x1) * this.scaleX;
            const videoHeight = (y2 - y1) * this.scaleY;

            this.currentSelection = {
                type: 'ellipse',
                x: x1,
                y: y1,
                width: x2 - x1,
                height: y2 - y1,
                videoX: Math.max(0, videoX),
                videoY: Math.max(0, videoY),
                videoWidth: videoWidth,
                videoHeight: videoHeight
            };
        } else if (this.currentTool === 'lasso') {
            this.currentSelection = {
                type: 'lasso',
                points: [...this.lassoPoints],
                // 動画座標に変換（オフセットを考慮）
                videoPoints: this.lassoPoints.map(p => ({
                    x: Math.max(0, (p.x - offsetX) * this.scaleX),
                    y: Math.max(0, (p.y - offsetY) * this.scaleY)
                }))
            };
        }

        // ステータスメッセージ
        let modifiers = [];
        if (shiftKey) modifiers.push('正方形/正円');
        if (ctrlKey) modifiers.push('中心基準');
        const modifierText = modifiers.length > 0 ? ` - ${modifiers.join(', ')}` : '';
        this.updateStatus(`選択範囲を設定しました (${this.currentTool}${modifierText})`);
    }

    drawRectangle(start, end, shiftKey = false, ctrlKey = false) {
        const player = this.videoPlayer?.players?.[this.activeSide];
        const zoom = player?.zoom || 1;
        const panX = player?.panX || 0;
        const panY = player?.panY || 0;

        let width = end.x - start.x;
        let height = end.y - start.y;

        // Shiftキーで正方形に
        if (shiftKey) {
            const size = Math.max(Math.abs(width), Math.abs(height));
            width = width >= 0 ? size : -size;
            height = height >= 0 ? size : -size;
        }

        // Ctrlキーで中心基準に
        let drawX, drawY, drawWidth, drawHeight;
        if (ctrlKey) {
            // 開始点を中心として描画
            const halfWidth = Math.abs(width);
            const halfHeight = Math.abs(height);
            drawX = start.x - halfWidth;
            drawY = start.y - halfHeight;
            drawWidth = halfWidth * 2;
            drawHeight = halfHeight * 2;
        } else {
            // 通常: 左上基準
            drawX = start.x;
            drawY = start.y;
            drawWidth = width;
            drawHeight = height;
        }

        this.overlayCtx.save();

        // ズームとパンを適用（動画と同じ変換）
        const centerX = this.overlayCanvas.width / 2;
        const centerY = this.overlayCanvas.height / 2;
        this.overlayCtx.translate(centerX, centerY);
        this.overlayCtx.scale(zoom, zoom);
        this.overlayCtx.translate(-centerX + panX, -centerY + panY);

        this.overlayCtx.strokeStyle = '#00ff00';
        this.overlayCtx.lineWidth = 2 / zoom; // ズームに応じて線の太さを調整
        this.overlayCtx.setLineDash([5 / zoom, 5 / zoom]);

        this.overlayCtx.strokeRect(
            drawX,
            drawY,
            drawWidth,
            drawHeight
        );

        // 塗りつぶし（半透明）
        this.overlayCtx.fillStyle = 'rgba(0, 255, 0, 0.1)';
        this.overlayCtx.fillRect(
            drawX,
            drawY,
            drawWidth,
            drawHeight
        );

        this.overlayCtx.restore();
    }

    drawEllipse(start, end, shiftKey = false, ctrlKey = false) {
        const player = this.videoPlayer?.players?.[this.activeSide];
        const zoom = player?.zoom || 1;
        const panX = player?.panX || 0;
        const panY = player?.panY || 0;

        let width = end.x - start.x;
        let height = end.y - start.y;

        // Shiftキーで正円に
        if (shiftKey) {
            const size = Math.max(Math.abs(width), Math.abs(height));
            width = width >= 0 ? size : -size;
            height = height >= 0 ? size : -size;
        }

        // 楕円の中心と半径を計算
        let centerX_ellipse, centerY_ellipse, radiusX, radiusY;

        if (ctrlKey) {
            // Ctrlキーで中心基準: 開始点が中心
            centerX_ellipse = start.x;
            centerY_ellipse = start.y;
            radiusX = Math.abs(width);
            radiusY = Math.abs(height);
        } else {
            // 通常: 左上基準
            centerX_ellipse = start.x + width / 2;
            centerY_ellipse = start.y + height / 2;
            radiusX = Math.abs(width / 2);
            radiusY = Math.abs(height / 2);
        }

        this.overlayCtx.save();

        // ズームとパンを適用（動画と同じ変換）
        const centerX = this.overlayCanvas.width / 2;
        const centerY = this.overlayCanvas.height / 2;
        this.overlayCtx.translate(centerX, centerY);
        this.overlayCtx.scale(zoom, zoom);
        this.overlayCtx.translate(-centerX + panX, -centerY + panY);

        this.overlayCtx.strokeStyle = '#00ff00';
        this.overlayCtx.lineWidth = 2 / zoom;
        this.overlayCtx.setLineDash([5 / zoom, 5 / zoom]);

        this.overlayCtx.beginPath();
        this.overlayCtx.ellipse(centerX_ellipse, centerY_ellipse, radiusX, radiusY, 0, 0, 2 * Math.PI);
        this.overlayCtx.stroke();

        // 塗りつぶし（半透明）
        this.overlayCtx.fillStyle = 'rgba(0, 255, 0, 0.1)';
        this.overlayCtx.fill();

        this.overlayCtx.restore();
    }

    drawLasso() {
        if (this.lassoPoints.length < 2) return;

        const player = this.videoPlayer?.players?.[this.activeSide];
        const zoom = player?.zoom || 1;
        const panX = player?.panX || 0;
        const panY = player?.panY || 0;

        this.overlayCtx.save();

        // ズームとパンを適用（動画と同じ変換）
        const centerX = this.overlayCanvas.width / 2;
        const centerY = this.overlayCanvas.height / 2;
        this.overlayCtx.translate(centerX, centerY);
        this.overlayCtx.scale(zoom, zoom);
        this.overlayCtx.translate(-centerX + panX, -centerY + panY);

        this.overlayCtx.strokeStyle = '#00ff00';
        this.overlayCtx.lineWidth = 2 / zoom; // ズームに応じて線の太さを調整
        this.overlayCtx.setLineDash([]);

        this.overlayCtx.beginPath();
        this.overlayCtx.moveTo(this.lassoPoints[0].x, this.lassoPoints[0].y);

        for (let i = 1; i < this.lassoPoints.length; i++) {
            this.overlayCtx.lineTo(this.lassoPoints[i].x, this.lassoPoints[i].y);
        }

        this.overlayCtx.closePath();
        this.overlayCtx.stroke();

        // 塗りつぶし（半透明）
        this.overlayCtx.fillStyle = 'rgba(0, 255, 0, 0.1)';
        this.overlayCtx.fill();

        this.overlayCtx.restore();
    }

    async captureCurrentFrame() {
        if (!this.currentSelection) {
            this.updateStatus('先に選択範囲を設定してください');
            return;
        }

        const player = this.videoPlayer?.players?.[this.activeSide];
        if (!player?.video) {
            this.updateStatus('動画が読み込まれていません');
            return;
        }

        const video = player.video;
        const frameNumber = this.getCurrentFrameNumber();

        // 編集中の場合は既存のキャプチャを更新
        if (this.editingCaptureIndex >= 0) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = video.videoWidth;
            tempCanvas.height = video.videoHeight;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(video, 0, 0);

            let extractedData = this.extractSelection(tempCanvas, this.currentSelection);

            // 背景差分を適用
            if (this.settings.useBgSubtraction && this.backgroundFrame) {
                extractedData.imageData = this.applyBackgroundSubtraction(
                    extractedData.imageData,
                    extractedData.bounds
                );
            }

            this.capturedFrames[this.editingCaptureIndex] = {
                frameNumber,
                timestamp: video.currentTime,
                selection: { ...this.currentSelection },
                imageData: extractedData.imageData,
                bounds: extractedData.bounds
            };

            this.editingCaptureIndex = -1;
            this.currentSelection = null;
            this.invalidateCapturedFramesCache(); // キャッシュを無効化
            this.drawCapturedPositions();
            this.updateSliderMarkers();
            this.updateFrameCount();
            this.updateStatus(`フレーム ${frameNumber} を更新しました`);
            return;
        }

        // 動画からフレームをキャプチャ
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = video.videoWidth;
        tempCanvas.height = video.videoHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(video, 0, 0);

        // 選択領域を抽出
        let extractedData = this.extractSelection(tempCanvas, this.currentSelection);

        // 背景差分を適用
        if (this.settings.useBgSubtraction && this.backgroundFrame) {
            extractedData.imageData = this.applyBackgroundSubtraction(
                extractedData.imageData,
                extractedData.bounds
            );
        }

        this.capturedFrames.push({
            frameNumber,
            timestamp: video.currentTime,
            selection: { ...this.currentSelection },
            imageData: extractedData.imageData,
            bounds: extractedData.bounds
        });

        // キャプチャ後、選択範囲をクリアして次の選択を可能にする
        this.currentSelection = null;

        // キャッシュを無効化してキャプチャ済みの位置を表示
        this.invalidateCapturedFramesCache();
        this.drawCapturedPositions();

        // スライダーにマーカーを追加
        this.updateSliderMarkers();

        this.updateFrameCount();
        this.updateStatus(`フレーム ${frameNumber} をキャプチャしました (計 ${this.capturedFrames.length} フレーム) - 次の位置を選択してください`);
    }

    async captureCurrentFrameWithAI() {
        const player = this.videoPlayer?.players?.[this.activeSide];
        if (!player?.video) {
            this.updateStatus('動画が読み込まれていません');
            return;
        }

        this.updateStatus('AIセグメンテーション処理中... (初回はモデル読み込みに時間がかかります)');

        try {
            const video = player.video;
            const frameNumber = this.getCurrentFrameNumber();

            // 1. Prepare input: use ROI if selected, otherwise full frame
            let captureX = 0, captureY = 0, captureWidth = video.videoWidth, captureHeight = video.videoHeight;

            // ROIがある場合はその範囲を使用
            if (this.currentSelection && this.currentSelection.type === 'rectangle') {
                captureX = Math.floor(Math.max(0, this.currentSelection.videoX));
                captureY = Math.floor(Math.max(0, this.currentSelection.videoY));
                captureWidth = Math.ceil(Math.min(video.videoWidth - captureX, this.currentSelection.videoWidth));
                captureHeight = Math.ceil(Math.min(video.videoHeight - captureY, this.currentSelection.videoHeight));

                // 範囲が小さすぎる場合は無視
                if (captureWidth < 10 || captureHeight < 10) {
                    captureX = 0; captureY = 0;
                    captureWidth = video.videoWidth; captureHeight = video.videoHeight;
                }
            }

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = captureWidth;
            tempCanvas.height = captureHeight;
            const ctx = tempCanvas.getContext('2d');

            // Capture ROI or Full frame
            console.log(`AI Capture Coords: x=${captureX}, y=${captureY}, w=${captureWidth}, h=${captureHeight}, video=${video.videoWidth}x${video.videoHeight}`);
            ctx.drawImage(video, captureX, captureY, captureWidth, captureHeight, 0, 0, captureWidth, captureHeight);

            // Convert to buffer for IPC
            const blob = await new Promise(r => tempCanvas.toBlob(r, 'image/png'));
            const arrayBuffer = await blob.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const { ipcRenderer } = require('electron');
            // 2. Send to worker
            const result = await ipcRenderer.invoke('segment-frame', buffer);
            if (!result.success) throw new Error(result.error);

            // 3. Process mask
            const maskBlob = new Blob([result.mask], { type: 'image/png' });
            const maskBitmap = await createImageBitmap(maskBlob);

            // 4. Create cutout on FULL frame canvas
            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = video.videoWidth;
            finalCanvas.height = video.videoHeight;
            const fCtx = finalCanvas.getContext('2d');

            // Create a canvas for the masked ROI
            const roiCanvas = document.createElement('canvas');
            roiCanvas.width = captureWidth;
            roiCanvas.height = captureHeight;
            const rCtx = roiCanvas.getContext('2d');

            // Step 1: Draw original ROI image
            rCtx.drawImage(tempCanvas, 0, 0);

            // Step 2: Prepare mask with proper alpha channel
            // The mask from AI is grayscale (RGB), but destination-in uses ALPHA channel
            // We need to convert RGB values to alpha channel
            const alphaMaskCanvas = document.createElement('canvas');
            alphaMaskCanvas.width = captureWidth;
            alphaMaskCanvas.height = captureHeight;
            const amCtx = alphaMaskCanvas.getContext('2d');
            amCtx.drawImage(maskBitmap, 0, 0, captureWidth, captureHeight);
            const alphaMaskData = amCtx.getImageData(0, 0, captureWidth, captureHeight);

            // Convert RGB grayscale to alpha channel
            // MODNet出力は既にソフトエッジを含むため、過度な加工は不要
            // 軽いガンマ補正のみでコントラストを微調整

            // 動的設定を使用
            const GAMMA = this.aiSettings.gamma;
            const ALPHA_THRESHOLD = this.aiSettings.alphaThreshold;
            const ALPHA_BOOST = this.aiSettings.alphaBoost;

            for (let i = 0; i < alphaMaskData.data.length; i += 4) {
                let alpha = alphaMaskData.data[i];  // グレースケール値をアルファとして使用

                // ノイズ除去: 閾値以下は完全透明に
                if (alpha < ALPHA_THRESHOLD) {
                    alphaMaskData.data[i + 3] = 0;
                    continue;
                }

                // 正規化 [0, 1]
                let normalized = alpha / 255.0;

                // ガンマ補正（エッジのソフトさを調整）
                normalized = Math.pow(normalized, 1.0 / GAMMA);

                // 軽いブースト
                normalized = Math.min(1.0, normalized * ALPHA_BOOST);

                // 最終アルファ値
                alphaMaskData.data[i + 3] = Math.round(normalized * 255);
            }
            amCtx.putImageData(alphaMaskData, 0, 0);

            // Step 3: Apply mask using globalCompositeOperation (MDN recommended approach)
            // 'destination-in': Keep existing content only where source has alpha > 0
            rCtx.globalCompositeOperation = 'destination-in';
            rCtx.drawImage(alphaMaskCanvas, 0, 0);

            // Step 4: Reset composite operation
            rCtx.globalCompositeOperation = 'source-over';

            // Use the processed alphaMaskCanvas for bounds calculation
            // drawing just the mask to calculate the bounding box of detected person
            const maskData = amCtx.getImageData(0, 0, captureWidth, captureHeight);

            let minX = captureWidth, minY = captureHeight, maxX = 0, maxY = 0;
            let hasPixels = false;

            for (let i = 0; i < maskData.data.length; i += 4) {
                const alpha = maskData.data[i + 3]; // use ALPHA channel we just set!
                if (alpha > 5) { // even lower threshold for pixels to count towards bounds
                    const idx = i / 4;
                    const x = idx % captureWidth;
                    const y = Math.floor(idx / captureWidth);
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    hasPixels = true;
                }
            }

            // Draw ROI onto Full Canvas at correct position
            console.log(`Compositing Mask at: x=${captureX}, y=${captureY}`);
            fCtx.drawImage(roiCanvas, captureX, captureY);

            // Get Full Frame Data
            const fullFrameData = fCtx.getImageData(0, 0, finalCanvas.width, finalCanvas.height);

            // Adjust bounds to be relative to full frame
            const bounds = hasPixels ?
                {
                    x: captureX + minX,
                    y: captureY + minY,
                    width: maxX - minX,
                    height: maxY - minY
                } :
                { x: 0, y: 0, width: 0, height: 0 }; // No pixels found

            // 5. Extract edge points for visualization
            const edgePoints = [];
            const edgeThreshold = 20;
            for (let y = 1; y < captureHeight - 1; y++) {
                for (let x = 1; x < captureWidth - 1; x++) {
                    const idx = (y * captureWidth + x) * 4;
                    const alpha = maskData.data[idx + 3];

                    if (alpha > edgeThreshold) {
                        // Check neighbors for edge detection
                        const neighbors = [
                            maskData.data[((y - 1) * captureWidth + x) * 4 + 3],
                            maskData.data[((y + 1) * captureWidth + x) * 4 + 3],
                            maskData.data[(y * captureWidth + x - 1) * 4 + 3],
                            maskData.data[(y * captureWidth + x + 1) * 4 + 3]
                        ];

                        if (neighbors.some(n => n < edgeThreshold)) {
                            edgePoints.push({ x, y });
                        }
                    }
                }
            }

            // 6. Store result
            // Create ImageBitmap for rendering from the canvas with alpha applied
            const resultBitmap = await createImageBitmap(roiCanvas);

            const newFrameData = {
                frameNumber,
                timestamp: video.currentTime,
                selection: { type: 'ai-mask', bounds },
                // Store bitmap for rendering
                bitmap: resultBitmap,
                drawPosition: { x: captureX, y: captureY },
                bounds: bounds,
                edgePoints: edgePoints  // Edge points for overlay
            };

            if (this.editingCaptureIndex >= 0) {
                this.capturedFrames[this.editingCaptureIndex] = newFrameData;
                this.updateStatus(`フレーム ${frameNumber} をAI更新しました`);
            } else {
                this.capturedFrames.push(newFrameData);
                this.updateStatus(`フレーム ${frameNumber} をAIキャプチャしました`);
            }

            // Update UI
            this.currentSelection = null;
            this.invalidateCapturedFramesCache();
            this.drawCapturedPositions();
            this.updateSliderMarkers();
            this.updateFrameCount();

        } catch (e) {
            console.error(e);
            this.updateStatus('AIエラー: ' + e.message);
        }
    }

    // スライダー上にキャプチャマーカーを表示
    updateSliderMarkers() {
        const player = this.videoPlayer?.players?.[this.activeSide];
        if (!player?.video) return;

        const sliderContainer = document.querySelector(`#${this.activeSide}-player .slider-container`);
        if (!sliderContainer) return;

        // 既存のストロボマーカーを削除
        sliderContainer.querySelectorAll('.strobe-marker').forEach(m => m.remove());

        // コンテキストメニューも削除
        this.hideMarkerContextMenu();

        const totalFrames = player.videoInfo?.totalFrames;
        if (!totalFrames) return;

        // 各キャプチャフレームにマーカーを追加
        this.capturedFrames.forEach((frame, index) => {
            const marker = document.createElement('div');
            marker.className = 'strobe-marker';

            // フレームベースの位置計算 (1ベースのフレーム番号を0ベースの比率に変換)
            const percent = ((frame.frameNumber - 1) / (totalFrames - 1)) * 100;

            marker.style.cssText = `
                position: absolute;
                left: ${percent}%;
                top: -8px;
                width: 12px;
                height: 12px;
                background: #ff9800;
                border: 2px solid #fff;
                border-radius: 50%;
                transform: translateX(-50%);
                cursor: pointer;
                z-index: 20;
                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            `;
            marker.title = `キャプチャ #${index + 1} (フレーム ${frame.frameNumber}) - 右クリックで削除`;
            marker.dataset.captureIndex = index;

            // 左クリック: 編集モードに移行
            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                this.jumpToCapture(index);
            });

            // 右クリック: コンテキストメニュー表示
            marker.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showMarkerContextMenu(e.clientX, e.clientY, index);
            });

            sliderContainer.appendChild(marker);
        });
    }

    // マーカー用コンテキストメニューを表示
    showMarkerContextMenu(x, y, captureIndex) {
        // 既存のメニューを削除
        this.hideMarkerContextMenu();

        const menu = document.createElement('div');
        menu.id = 'strobe-marker-context-menu';
        menu.style.cssText = `
            position: fixed;
            left: ${x}px;
            top: ${y}px;
            background: #2d2d2d;
            border: 1px solid #555;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            z-index: 10000;
            min-width: 160px;
            padding: 4px 0;
            font-size: 13px;
        `;

        const deleteItem = document.createElement('div');
        deleteItem.style.cssText = `
            padding: 8px 16px;
            color: #ff6b6b;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
        `;
        deleteItem.innerHTML = `<span>🗑️</span><span>イベントマーカーを削除</span>`;
        deleteItem.addEventListener('mouseenter', () => {
            deleteItem.style.background = '#3a3a3a';
        });
        deleteItem.addEventListener('mouseleave', () => {
            deleteItem.style.background = 'transparent';
        });
        deleteItem.addEventListener('click', () => {
            this.deleteCapture(captureIndex);
            this.hideMarkerContextMenu();
        });

        menu.appendChild(deleteItem);
        document.body.appendChild(menu);

        // 画面外に出ないように調整
        const menuRect = menu.getBoundingClientRect();
        if (menuRect.right > window.innerWidth) {
            menu.style.left = (window.innerWidth - menuRect.width - 10) + 'px';
        }
        if (menuRect.bottom > window.innerHeight) {
            menu.style.top = (window.innerHeight - menuRect.height - 10) + 'px';
        }

        // メニュー外クリックで閉じる
        const closeHandler = (e) => {
            if (!menu.contains(e.target)) {
                this.hideMarkerContextMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeHandler);
        }, 0);
    }

    // コンテキストメニューを非表示
    hideMarkerContextMenu() {
        const menu = document.getElementById('strobe-marker-context-menu');
        if (menu) {
            menu.remove();
        }
    }

    // 指定したキャプチャを削除
    deleteCapture(index) {
        if (index < 0 || index >= this.capturedFrames.length) return;

        const frameNumber = this.capturedFrames[index].frameNumber;

        // 配列から削除
        this.capturedFrames.splice(index, 1);

        // 編集中のインデックスを調整
        if (this.editingCaptureIndex === index) {
            this.editingCaptureIndex = -1;
            this.currentSelection = null;
        } else if (this.editingCaptureIndex > index) {
            this.editingCaptureIndex--;
        }

        // キャッシュを無効化して表示を更新
        this.invalidateCapturedFramesCache();
        this.drawCapturedPositions();
        this.updateSliderMarkers();
        this.updateFrameCount();

        this.updateStatus(`キャプチャ #${index + 1} (フレーム ${frameNumber}) を削除しました`);
    }

    // 背景フレームをキャプチャ
    captureBackgroundFrame() {
        const player = this.videoPlayer?.players?.[this.activeSide];
        if (!player?.video) {
            this.updateStatus('動画が読み込まれていません');
            return;
        }

        const video = player.video;
        const frameNumber = this.getCurrentFrameNumber();

        // 動画全体をキャプチャ
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = video.videoWidth;
        tempCanvas.height = video.videoHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(video, 0, 0);

        this.backgroundFrame = {
            frameNumber,
            timestamp: video.currentTime,
            imageData: tempCtx.getImageData(0, 0, video.videoWidth, video.videoHeight),
            width: video.videoWidth,
            height: video.videoHeight
        };

        // ステータス更新
        const statusEl = document.getElementById('strobe-bg-status');
        if (statusEl) {
            statusEl.textContent = `フレーム ${frameNumber} を設定`;
            statusEl.style.color = '#4CAF50';
        }

        this.updateStatus(`背景フレームを設定しました (フレーム ${frameNumber})`);
    }

    // 背景差分法で動体を抽出
    applyBackgroundSubtraction(currentImageData, bounds) {
        if (!this.backgroundFrame) {
            return currentImageData; // 背景未設定の場合はそのまま返す
        }

        const bgData = this.backgroundFrame.imageData.data;
        const currentData = currentImageData.data;
        const threshold = this.settings.bgSubThreshold;

        // 背景の該当領域を取得
        const bgWidth = this.backgroundFrame.width;
        const x = bounds.x;
        const y = bounds.y;
        const width = bounds.width;
        const height = bounds.height;

        const result = new Uint8ClampedArray(currentData.length);

        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const currentIdx = (row * width + col) * 4;
                const bgIdx = ((y + row) * bgWidth + (x + col)) * 4;

                // RGB各チャンネルの差分を計算
                const diffR = Math.abs(currentData[currentIdx] - bgData[bgIdx]);
                const diffG = Math.abs(currentData[currentIdx + 1] - bgData[bgIdx + 1]);
                const diffB = Math.abs(currentData[currentIdx + 2] - bgData[bgIdx + 2]);

                // 差分の平均が閾値以上なら前景
                const avgDiff = (diffR + diffG + diffB) / 3;

                if (avgDiff > threshold) {
                    // 前景：元の色をコピー
                    result[currentIdx] = currentData[currentIdx];
                    result[currentIdx + 1] = currentData[currentIdx + 1];
                    result[currentIdx + 2] = currentData[currentIdx + 2];
                    result[currentIdx + 3] = 255; // 不透明
                } else {
                    // 背景：透明にする
                    result[currentIdx] = 0;
                    result[currentIdx + 1] = 0;
                    result[currentIdx + 2] = 0;
                    result[currentIdx + 3] = 0; // 透明
                }
            }
        }

        return new ImageData(result, width, height);
    }

    // キャプチャ位置にジャンプして編集モードに
    jumpToCapture(index) {
        if (index < 0 || index >= this.capturedFrames.length) return;

        const frame = this.capturedFrames[index];
        const player = this.videoPlayer?.players?.[this.activeSide];
        if (!player?.video) return;

        // そのフレームに移動
        player.video.currentTime = frame.timestamp;

        // 選択範囲を復元して編集可能に
        this.currentSelection = { ...frame.selection, edgePoints: frame.edgePoints };
        this.editingCaptureIndex = index;

        // 選択範囲を再描画
        this.redrawCurrentSelection();

        this.updateStatus(`キャプチャ #${index + 1} を編集中 - 選択範囲を修正して「キャプチャ」で更新`);
    }

    // キャプチャ済みの位置をオーバーレイに表示
    drawCapturedPositions() {
        if (!this.overlayCtx) return;

        // 線種をリセット（点線設定が残るのを防ぐ）
        this.overlayCtx.setLineDash([]);

        if (this.capturedFrames.length > 0) {
            console.log('StrobeMotion: Drawing frames:', this.capturedFrames.length, 'Scale:', this.scaleX);
        }

        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        const player = this.videoPlayer?.players?.[this.activeSide];
        const zoom = player?.zoom || 1;
        const panX = player?.panX || 0;
        const panY = player?.panY || 0;

        // 表示オフセット
        const offsetX = this.displayOffset?.x || 0;
        const offsetY = this.displayOffset?.y || 0;

        this.overlayCtx.save();

        // ズームとパンを適用
        const centerX = this.overlayCanvas.width / 2;
        const centerY = this.overlayCanvas.height / 2;
        this.overlayCtx.translate(centerX, centerY);
        this.overlayCtx.scale(zoom, zoom);
        this.overlayCtx.translate(-centerX + panX, -centerY + panY);

        // キャプチャ済みの各位置を描画
        this.capturedFrames.forEach((frame, index) => {
            // Draw Image if available
            if (frame.bitmap) {
                // ビデオ座標から表示座標に変換
                const videoX = frame.drawPosition ? frame.drawPosition.x : frame.bounds.x;
                const videoY = frame.drawPosition ? frame.drawPosition.y : frame.bounds.y;
                const displayX = videoX / this.scaleX + offsetX;
                const displayY = videoY / this.scaleY + offsetY;

                // ビットマップも表示座標スケールで描画
                const displayWidth = frame.bitmap.width / this.scaleX;
                const displayHeight = frame.bitmap.height / this.scaleY;

                try {
                    this.overlayCtx.drawImage(frame.bitmap, displayX, displayY, displayWidth, displayHeight);
                } catch (e) { /* ignore */ }

                // Draw edge overlay IMMEDIATELY after bitmap
                if (frame.selection?.type === 'ai-mask' &&
                    this.aiSettings.showEdgeOverlay &&
                    frame.edgePoints && frame.edgePoints.length > 0) {

                    this.overlayCtx.globalAlpha = 1.0;
                    this.overlayCtx.globalCompositeOperation = 'source-over';

                    // エッジポイントはビットマップローカル座標なので、表示サイズに合わせてスケール
                    // frame.bitmap.width/height はビデオピクセル単位
                    // displayWidth/Height は表示ピクセル単位
                    const edgeScaleX = displayWidth / frame.bitmap.width;
                    const edgeScaleY = displayHeight / frame.bitmap.height;
                    const edgePixelSize = Math.max(1.5, 1.5 / zoom);
                    const step = Math.max(1, Math.floor(frame.edgePoints.length / 5000));

                    // Cyan edge overlay with slight transparency
                    this.overlayCtx.fillStyle = 'rgba(0, 255, 255, 0.9)';
                    for (let i = 0; i < frame.edgePoints.length; i += step) {
                        const pt = frame.edgePoints[i];
                        // ROIローカル座標を表示座標に変換
                        const edgeX = displayX + pt.x * edgeScaleX;
                        const edgeY = displayY + pt.y * edgeScaleY;
                        this.overlayCtx.fillRect(edgeX, edgeY, edgePixelSize, edgePixelSize);
                    }
                }
            }

            const selection = frame.selection;

            // 色を変化させる（古いほど薄く）
            const alpha = 0.3 + (0.5 * (index / Math.max(1, this.capturedFrames.length - 1)));

            // エッジデータがあれば ai-mask として扱う（枠線なし、番号のみ）
            // 古いデータ形式や更新漏れで type='rectangle' でもエッジがあればこちらで処理
            const hasEdges = frame.edgePoints && frame.edgePoints.length > 0;

            if (selection.type === 'ai-mask' || hasEdges) {
                // エッジがある場合はバウンディングボックスを描画しない（エッジで十分）
                // フレーム番号のみエッジ付近（displayX, displayY基準）に表示
                const videoX = frame.drawPosition ? frame.drawPosition.x : frame.bounds.x;
                const videoY = frame.drawPosition ? frame.drawPosition.y : frame.bounds.y;
                const displayXPos = videoX / this.scaleX + offsetX;
                const displayYPos = videoY / this.scaleY + offsetY;

                // バウンディングボックスは描画しない（エッジが既に描画されている）
                // フレーム番号のみ表示
                this.overlayCtx.fillStyle = `rgba(0, 255, 255, ${alpha})`;
                this.overlayCtx.font = `${12 / zoom}px sans-serif`;
                this.overlayCtx.fillText(`#${index + 1}`, displayXPos + 2, displayYPos - 4);
            } else if (selection.type === 'rectangle') {
                // 万が一、エッジがあるのにここで処理されようとした場合のガード
                if (!hasEdges) {
                    // 動画座標から表示座標に変換
                    const x = selection.videoX / this.scaleX + offsetX;
                    const y = selection.videoY / this.scaleY + offsetY;
                    const width = selection.videoWidth / this.scaleX;
                    const height = selection.videoHeight / this.scaleY;

                    this.overlayCtx.strokeStyle = `rgba(255, 165, 0, ${alpha})`; // オレンジ
                    this.overlayCtx.lineWidth = 2 / zoom;
                    this.overlayCtx.setLineDash([]);
                    this.overlayCtx.strokeRect(x, y, width, height);

                    // フレーム番号を表示
                    this.overlayCtx.fillStyle = `rgba(255, 165, 0, ${alpha})`;
                    this.overlayCtx.font = `${12 / zoom}px sans-serif`;
                    this.overlayCtx.fillText(`#${index + 1}`, x + 2, y - 4);
                } else {
                    // エッジがある場合（rectangleタイプだがエッジ持ち）はフレーム番号のみ表示
                    // displayX/Y を計算する必要があるため、簡易的に videoX/Y から計算
                    const videoX = selection.videoX;
                    const videoY = selection.videoY;
                    const displayX = videoX / this.scaleX + offsetX;
                    const displayY = videoY / this.scaleY + offsetY;

                    this.overlayCtx.fillStyle = `rgba(0, 255, 255, ${alpha})`; // シアン（AI扱い）
                    this.overlayCtx.font = `${12 / zoom}px sans-serif`;
                    this.overlayCtx.fillText(`#${index + 1}`, displayX + 2, displayY - 4);
                }
            } else if (selection.type === 'ellipse') {
                // 動画座標から表示座標に変換
                const x = selection.videoX / this.scaleX + offsetX;
                const y = selection.videoY / this.scaleY + offsetY;
                const width = selection.videoWidth / this.scaleX;
                const height = selection.videoHeight / this.scaleY;

                // 楕円の中心と半径を計算
                const cx = x + width / 2;
                const cy = y + height / 2;
                const rx = width / 2;
                const ry = height / 2;

                this.overlayCtx.strokeStyle = `rgba(255, 165, 0, ${alpha})`; // オレンジ
                this.overlayCtx.lineWidth = 2 / zoom;
                this.overlayCtx.setLineDash([]);
                this.overlayCtx.beginPath();
                this.overlayCtx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
                this.overlayCtx.stroke();

                // フレーム番号を表示
                this.overlayCtx.fillStyle = `rgba(255, 165, 0, ${alpha})`;
                this.overlayCtx.font = `${12 / zoom}px sans-serif`;
                this.overlayCtx.fillText(`#${index + 1}`, x + 2, y - 4);
            } else if (selection.type === 'lasso' && selection.points) {
                this.overlayCtx.strokeStyle = `rgba(255, 165, 0, ${alpha})`;
                this.overlayCtx.lineWidth = 2 / zoom;
                this.overlayCtx.setLineDash([]);

                this.overlayCtx.beginPath();
                const firstPoint = selection.points[0];
                this.overlayCtx.moveTo(firstPoint.x, firstPoint.y);

                for (let i = 1; i < selection.points.length; i++) {
                    this.overlayCtx.lineTo(selection.points[i].x, selection.points[i].y);
                }
                this.overlayCtx.closePath();
                this.overlayCtx.stroke();
            }
        });

        this.overlayCtx.restore();
    }

    extractSelection(canvas, selection) {
        const ctx = canvas.getContext('2d');

        if (selection.type === 'rectangle') {
            const x = Math.round(selection.videoX);
            const y = Math.round(selection.videoY);
            const width = Math.round(selection.videoWidth);
            const height = Math.round(selection.videoHeight);

            const imageData = ctx.getImageData(x, y, width, height);

            return {
                imageData,
                bounds: { x, y, width, height }
            };
        } else if (selection.type === 'ellipse') {
            const x = Math.round(selection.videoX);
            const y = Math.round(selection.videoY);
            const width = Math.round(selection.videoWidth);
            const height = Math.round(selection.videoHeight);

            // 楕円の中心と半径を計算
            const cx = width / 2;
            const cy = height / 2;
            const rx = width / 2;
            const ry = height / 2;

            // マスクを作成
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = width;
            maskCanvas.height = height;
            const maskCtx = maskCanvas.getContext('2d');

            // 楕円の形状を描画
            maskCtx.fillStyle = 'white';
            maskCtx.beginPath();
            maskCtx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
            maskCtx.fill();

            const maskData = maskCtx.getImageData(0, 0, width, height);
            const sourceData = ctx.getImageData(x, y, width, height);

            // マスクを適用（楕円外を透明にする）
            for (let i = 0; i < maskData.data.length; i += 4) {
                if (maskData.data[i] === 0) { // マスク外
                    sourceData.data[i + 3] = 0; // 透明にする
                }
            }

            return {
                imageData: sourceData,
                bounds: { x, y, width, height }
            };
        } else if (selection.type === 'lasso') {
            // 投げ縄の場合、バウンディングボックスを計算
            const points = selection.videoPoints;
            const minX = Math.floor(Math.min(...points.map(p => p.x)));
            const minY = Math.floor(Math.min(...points.map(p => p.y)));
            const maxX = Math.ceil(Math.max(...points.map(p => p.x)));
            const maxY = Math.ceil(Math.max(...points.map(p => p.y)));
            const width = maxX - minX;
            const height = maxY - minY;

            // マスクを作成
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = width;
            maskCanvas.height = height;
            const maskCtx = maskCanvas.getContext('2d');

            // 投げ縄の形状を描画
            maskCtx.fillStyle = 'white';
            maskCtx.beginPath();
            maskCtx.moveTo(points[0].x - minX, points[0].y - minY);
            for (let i = 1; i < points.length; i++) {
                maskCtx.lineTo(points[i].x - minX, points[i].y - minY);
            }
            maskCtx.closePath();
            maskCtx.fill();

            const maskData = maskCtx.getImageData(0, 0, width, height);
            const sourceData = ctx.getImageData(minX, minY, width, height);

            // マスクを適用
            for (let i = 0; i < maskData.data.length; i += 4) {
                if (maskData.data[i] === 0) { // マスク外
                    sourceData.data[i + 3] = 0; // 透明にする
                }
            }

            return {
                imageData: sourceData,
                bounds: { x: minX, y: minY, width, height }
            };
        }
    }

    clearCaptures() {
        this.capturedFrames = [];
        this.currentSelection = null;
        this.editingCaptureIndex = -1;
        this.lastGeneratedCanvas = null;

        // キャッシュを無効化
        this.invalidateCapturedFramesCache();

        if (this.overlayCtx) {
            this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        }

        // スライダーマーカーも削除
        this.updateSliderMarkers();

        // プレビューを非表示
        const previewSection = document.querySelector('.strobe-preview-section');
        if (previewSection) {
            previewSection.style.display = 'none';
        }

        this.updateFrameCount();
        this.updateStatus('キャプチャをクリアしました');
    }

    async generateStrobeMotion() {
        if (this.capturedFrames.length < 1) {
            this.updateStatus('1フレーム以上キャプチャしてください');
            return;
        }

        const player = this.videoPlayer?.players?.[this.activeSide];
        if (!player?.video) {
            this.updateStatus('動画が読み込まれていません');
            return;
        }

        this.updateStatus('ストロボモーション生成中...');
        this.videoPlayer?.showProgressBar?.(true);

        try {
            const video = player.video;

            // 出力キャンバスを作成
            const outputCanvas = document.createElement('canvas');
            outputCanvas.width = video.videoWidth;
            outputCanvas.height = video.videoHeight;
            const outputCtx = outputCanvas.getContext('2d');

            // 背景を描画
            await this.drawBackground(outputCtx, video);

            // 残像を描画（全てのキャプチャを使用）
            const framesToUse = this.capturedFrames;

            for (let i = 0; i < framesToUse.length; i++) {
                const frame = framesToUse[i];

                // 透明度の計算（0%=不透明、100%=完全透明）
                // settings.opacity: 0=不透明、1=完全透明
                let opacity = 1.0 - this.settings.opacity; // 反転

                if (this.settings.fadeMode === 'fade') {
                    // フェードモード: 古いほど透明
                    const fadeRatio = (i + 1) / framesToUse.length;
                    opacity = (1.0 - this.settings.opacity) * fadeRatio;
                }

                // 完全透明の場合はスキップ
                if (opacity <= 0) continue;

                outputCtx.globalAlpha = opacity;
                outputCtx.globalCompositeOperation = this.settings.blendMode;

                // Handle both ImageData (manual capture) and ImageBitmap (AI capture)
                if (frame.bitmap) {
                    // AI capture uses ImageBitmap - draw directly
                    const drawX = frame.drawPosition ? frame.drawPosition.x : frame.bounds.x;
                    const drawY = frame.drawPosition ? frame.drawPosition.y : frame.bounds.y;

                    // Add subtle feathering/smoothing effect if it's an AI mask
                    if (frame.selection.type === 'ai-mask') {
                        outputCtx.shadowBlur = 2;
                        outputCtx.shadowColor = 'rgba(0,0,0,0.2)';
                    }

                    outputCtx.drawImage(frame.bitmap, drawX, drawY);

                    // Reset shadow
                    outputCtx.shadowBlur = 0;
                } else if (frame.imageData) {
                    // Manual capture uses ImageData - need temp canvas
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = frame.bounds.width;
                    tempCanvas.height = frame.bounds.height;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.putImageData(frame.imageData, 0, 0);
                    outputCtx.drawImage(
                        tempCanvas,
                        frame.bounds.x,
                        frame.bounds.y
                    );
                }

                this.videoPlayer?.updateProgress?.(
                    ((i + 1) / framesToUse.length) * 100,
                    `合成中: ${i + 1}/${framesToUse.length}`
                );
            }

            outputCtx.globalAlpha = 1;
            outputCtx.globalCompositeOperation = 'source-over'; // リセット

            // 生成したキャンバスを保存（後で画像/動画保存に使用）
            this.lastGeneratedCanvas = outputCanvas;

            this.updateStatus('ストロボモーション生成完了！「画像保存」または「動画保存」で出力');

            // プレビュー表示
            this.showPreview(outputCanvas);

        } catch (error) {
            this.updateStatus(`エラー: ${error.message}`);
        } finally {
            this.videoPlayer?.showProgressBar?.(false);
        }
    }

    // 画像保存（ダイアログ付き）
    async saveImageWithDialog() {
        if (!this.lastGeneratedCanvas) {
            this.updateStatus('先に「生成」ボタンでプレビューを作成してください');
            return;
        }

        const player = this.videoPlayer?.players?.[this.activeSide];
        const videoPath = player?.videoPath || '';

        await this.saveImage(this.lastGeneratedCanvas, videoPath);
    }

    // 動画保存（ダイアログ付き）
    async saveVideoWithDialog() {
        if (this.capturedFrames.length < 1) {
            this.updateStatus('1フレーム以上キャプチャしてください');
            return;
        }

        const player = this.videoPlayer?.players?.[this.activeSide];
        if (!player?.video) {
            this.updateStatus('動画が読み込まれていません');
            return;
        }

        const videoPath = player?.videoPath || '';
        await this.saveVideo(player.video, this.capturedFrames, videoPath);
    }

    async drawBackground(ctx, video) {
        const bg = this.settings.backgroundColor;

        if (bg === 'original' || bg === 'first') {
            // 最初のフレームまたは現在のフレームを背景に
            const firstFrame = this.capturedFrames[0];
            video.currentTime = firstFrame.timestamp;
            await new Promise(resolve => {
                const onSeeked = () => {
                    video.removeEventListener('seeked', onSeeked);
                    resolve();
                };
                video.addEventListener('seeked', onSeeked);
            });
            await new Promise(resolve => setTimeout(resolve, 50));
            ctx.drawImage(video, 0, 0);
        } else if (bg === 'transparent') {
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        } else if (bg === 'black') {
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        } else if (bg === 'white') {
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        }
    }

    async saveImage(canvas, videoPath = '') {
        try {
            // 動画パスからデフォルトのファイル名を生成
            let defaultPath = `strobe_motion_${Date.now()}.png`;
            if (videoPath) {
                const videoDir = videoPath.substring(0, videoPath.lastIndexOf('\\') !== -1 ? videoPath.lastIndexOf('\\') : videoPath.lastIndexOf('/'));
                const videoName = videoPath.substring(videoPath.lastIndexOf('\\') !== -1 ? videoPath.lastIndexOf('\\') + 1 : videoPath.lastIndexOf('/') + 1);
                const baseName = videoName.substring(0, videoName.lastIndexOf('.'));
                defaultPath = videoDir + (videoDir.includes('\\') ? '\\' : '/') + baseName + '_strobe.png';
            }

            // 先にダイアログを表示
            const result = await ipcRenderer.invoke('show-save-dialog', {
                title: 'ストロボモーション画像を保存',
                defaultPath: defaultPath,
                filters: [{ name: 'PNG画像', extensions: ['png'] }]
            });

            if (result.canceled || !result.filePath) {
                return; // ユーザーがキャンセル
            }

            // ダイアログ確定後に処理を実行（プログレス表示付き）
            this.updateStatus('画像を処理中... 0%');

            // UIを更新するために短い遅延
            await new Promise(resolve => setTimeout(resolve, 50));

            this.updateStatus('画像を処理中... 30%');
            const dataUrl = canvas.toDataURL('image/png');

            this.updateStatus('画像を処理中... 70%');
            const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

            this.updateStatus('画像を保存中... 90%');
            await ipcRenderer.invoke('save-base64-image', {
                filePath: result.filePath,
                base64Data: base64Data
            });

            this.updateStatus(`画像を保存しました: ${result.filePath}`);
        } catch (error) {
            console.error('画像保存エラー:', error);
            throw error;
        }
    }

    async saveVideo(video, frames, videoPath = '') {
        try {
            // 動画パスからデフォルトのファイル名を生成
            let defaultPath = `strobe_motion_${Date.now()}.mp4`;
            if (videoPath) {
                const videoDir = videoPath.substring(0, videoPath.lastIndexOf('\\') !== -1 ? videoPath.lastIndexOf('\\') : videoPath.lastIndexOf('/'));
                const videoName = videoPath.substring(videoPath.lastIndexOf('\\') !== -1 ? videoPath.lastIndexOf('\\') + 1 : videoPath.lastIndexOf('/') + 1);
                const baseName = videoName.substring(0, videoName.lastIndexOf('.'));
                defaultPath = videoDir + (videoDir.includes('\\') ? '\\' : '/') + baseName + '_strobe.mp4';
            }

            const result = await ipcRenderer.invoke('show-save-dialog', {
                title: 'ストロボモーション動画を保存',
                defaultPath: defaultPath,
                filters: [{ name: 'MP4動画', extensions: ['mp4'] }]
            });

            if (!result.canceled && result.filePath) {
                const player = this.videoPlayer?.players?.[this.activeSide];
                const fps = player?.fps || 30;

                // 元動画のパスを取得
                const sourceVideoPath = player?.videoPath || video.src;
                if (!sourceVideoPath) {
                    this.updateStatus('元動画のパスが取得できません');
                    return;
                }

                // トリミング範囲を取得（設定されていなければ動画全体）
                let startTime = 0;
                let endTime = video.duration;
                if (player.trimInFrame && player.trimOutFrame) {
                    startTime = (player.trimInFrame - 1) / fps;
                    endTime = (player.trimOutFrame - 1) / fps;
                }

                // キャプチャをタイムスタンプでソート
                const sortedCaptures = [...frames].sort((a, b) => a.timestamp - b.timestamp);

                this.updateStatus('オーバーレイ画像を準備中...');
                this.videoPlayer?.showProgressBar?.(true);

                // 各キャプチャをオーバーレイ画像として準備
                const overlays = [];
                for (let i = 0; i < sortedCaptures.length; i++) {
                    const capture = sortedCaptures[i];

                    // 透明度の計算（0%=不透明、100%=完全透明）
                    let opacity = 1.0 - this.settings.opacity;

                    if (this.settings.fadeMode === 'fade' && sortedCaptures.length > 1) {
                        // フェードモード: 古いほど透明（最後のキャプチャが最も不透明）
                        const fadeRatio = (i + 1) / sortedCaptures.length;
                        opacity = (1.0 - this.settings.opacity) * fadeRatio;
                    }

                    if (opacity <= 0) continue;

                    // ImageData または Bitmap を Base64 PNGに変換
                    const tempCanvas = document.createElement('canvas');

                    // AIキャプチャの場合はbitmapサイズを使用、通常キャプチャはboundsサイズ
                    if (capture.bitmap) {
                        tempCanvas.width = capture.bitmap.width;
                        tempCanvas.height = capture.bitmap.height;
                    } else {
                        tempCanvas.width = capture.bounds.width || 100;
                        tempCanvas.height = capture.bounds.height || 100;
                    }
                    const tempCtx = tempCanvas.getContext('2d');

                    if (capture.bitmap) {
                        // AIキャプチャの場合: bitmapを使用
                        tempCtx.drawImage(capture.bitmap, 0, 0);
                    } else if (capture.imageData) {
                        // 通常キャプチャの場合: imageDataを使用
                        tempCtx.putImageData(capture.imageData, 0, 0);
                    } else {
                        continue; // どちらもない場合はスキップ
                    }

                    const dataUrl = tempCanvas.toDataURL('image/png');
                    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

                    // AIキャプチャの場合は drawPosition を使用（描画ロジックと同じ）
                    const overlayX = capture.drawPosition ? capture.drawPosition.x : capture.bounds.x;
                    const overlayY = capture.drawPosition ? capture.drawPosition.y : capture.bounds.y;

                    overlays.push({
                        imageBase64: base64Data,
                        x: overlayX,
                        y: overlayY,
                        startTime: capture.timestamp - startTime, // トリミング開始からの相対時間
                        opacity: opacity
                    });

                    this.videoPlayer?.updateProgress?.(
                        ((i + 1) / sortedCaptures.length) * 10,
                        `オーバーレイ準備中: ${i + 1}/${sortedCaptures.length}`
                    );
                }

                if (overlays.length === 0) {
                    this.updateStatus('有効なオーバーレイがありません');
                    this.videoPlayer?.showProgressBar?.(false);
                    return;
                }

                this.updateStatus('FFmpegで動画を生成中...');

                // FFmpegで動画を生成（高速版）
                const generateResult = await ipcRenderer.invoke('generate-strobe-video', {
                    outputPath: result.filePath,
                    sourceVideoPath: sourceVideoPath,
                    overlays: overlays,
                    fps: fps,
                    startTime: startTime,
                    endTime: endTime,
                    blendMode: this.settings.blendMode
                });

                this.videoPlayer?.showProgressBar?.(false);

                if (generateResult.success) {
                    this.updateStatus(`動画を保存しました: ${result.filePath}`);
                } else {
                    this.updateStatus(`動画生成エラー: ${generateResult.error}`);
                }
            }
        } catch (error) {
            this.videoPlayer?.showProgressBar?.(false);
            this.updateStatus(`動画保存エラー: ${error.message}`);
            console.error('Video save error:', error);
        }
    }

    showPreview(canvas) {
        const previewSection = document.querySelector('.strobe-preview-section');
        const previewCanvas = document.getElementById('strobe-preview-canvas');
        const panel = document.getElementById('strobe-motion-panel');

        if (previewSection && previewCanvas) {
            previewSection.style.display = 'block';

            // プレビューサイズを調整 - パネル幅に合わせて大きく表示
            const panelWidth = panel ? panel.offsetWidth - 40 : 600;
            const maxWidth = Math.max(panelWidth, 500);
            const scale = Math.min(1, maxWidth / canvas.width);
            previewCanvas.width = canvas.width * scale;
            previewCanvas.height = canvas.height * scale;

            const ctx = previewCanvas.getContext('2d');
            ctx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);

            // プレビュー拡大ボタンを追加/更新
            let openBtn = document.getElementById('open-preview-btn');
            if (!openBtn) {
                openBtn = document.createElement('button');
                openBtn.id = 'open-preview-btn';
                openBtn.className = 'vsl-btn vsl-btn-sm vsl-btn-secondary';
                openBtn.innerHTML = '<i class="fas fa-external-link-alt"></i> 拡大プレビュー';
                openBtn.style.marginTop = '10px';
                openBtn.style.width = '100%';

                openBtn.onclick = async () => {
                    const dataUrl = canvas.toDataURL('image/png');
                    await ipcRenderer.invoke('open-strobe-preview', dataUrl);
                };

                previewSection.appendChild(openBtn);
            } else {
                // キャンバスが変わったのでonclickも更新する必要があるかもだが、canvas参照は同じなら不要
                //念のため更新
                openBtn.onclick = async () => {
                    const dataUrl = canvas.toDataURL('image/png');
                    await ipcRenderer.invoke('open-strobe-preview', dataUrl);
                };
            }
        }
    }

    getCurrentFrameNumber() {
        const player = this.videoPlayer?.players?.[this.activeSide];
        if (!player?.video || !player.fps || !player.videoInfo?.totalFrames) {
            return 0;
        }
        return Math.round(player.video.currentTime * player.fps) + 1;
    }

    updateFrameCount() {
        const countElement = document.getElementById('strobe-frame-count');
        if (countElement) {
            countElement.textContent = `選択: ${this.capturedFrames.length} フレーム`;
        }
    }

    updateStatus(message) {
        if (this.videoPlayer?.updateStatus) {
            this.videoPlayer.updateStatus(message);
        }
    }

    // === イベントフレームをファイルに保存 ===
    async saveEventsToFile() {
        if (this.capturedFrames.length === 0) {
            this.updateStatus('保存するイベントフレームがありません');
            return;
        }

        try {
            // 動画ファイルパスを取得してデフォルトファイル名を生成
            const player = this.videoPlayer?.players?.[this.activeSide];
            const videoPath = player?.videoPath || '';

            // ImageDataをBase64に変換して保存
            const saveData = {
                version: '1.0',
                settings: { ...this.settings },
                activeSide: this.activeSide,
                capturedFrames: this.capturedFrames.map(frame => {
                    // ImageDataをBase64に変換
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = frame.bounds.width;
                    tempCanvas.height = frame.bounds.height;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.putImageData(frame.imageData, 0, 0);
                    const base64 = tempCanvas.toDataURL('image/png');

                    return {
                        frameNumber: frame.frameNumber,
                        timestamp: frame.timestamp,
                        selection: frame.selection,
                        bounds: frame.bounds,
                        imageBase64: base64
                    };
                })
            };

            const result = await ipcRenderer.invoke('save-strobe-events', saveData, videoPath);

            if (result.success) {
                this.updateStatus(`イベントフレームを保存しました: ${result.filePath}`);
            } else if (!result.canceled) {
                this.updateStatus(`保存エラー: ${result.error}`);
            }
        } catch (error) {
            this.updateStatus(`保存エラー: ${error.message}`);
        }
    }

    // === イベントフレームをファイルから読込 ===
    async loadEventsFromFile() {
        try {
            // 動画ファイルパスを取得してデフォルトディレクトリを設定
            const player = this.videoPlayer?.players?.[this.activeSide];
            const videoPath = player?.videoPath || '';

            const result = await ipcRenderer.invoke('load-strobe-events', videoPath);

            if (result.success && result.data) {
                const data = result.data;

                // バージョンチェック
                if (!data.version || !data.capturedFrames) {
                    this.updateStatus('無効なイベントフレームファイルです');
                    return;
                }

                // 設定を復元
                if (data.settings) {
                    this.settings = { ...this.settings, ...data.settings };
                    // UI更新
                    const opacitySlider = document.getElementById('strobe-opacity');
                    const opacityValue = document.getElementById('strobe-opacity-value');
                    if (opacitySlider) opacitySlider.value = this.settings.opacity;
                    if (opacityValue) opacityValue.textContent = Math.round(this.settings.opacity * 100) + '%';

                    const fadeMode = document.getElementById('strobe-fade-mode');
                    if (fadeMode) fadeMode.value = this.settings.fadeMode;

                    const bgSelect = document.getElementById('strobe-background');
                    if (bgSelect) bgSelect.value = this.settings.backgroundColor;

                    const blendMode = document.getElementById('strobe-blend-mode');
                    if (blendMode) blendMode.value = this.settings.blendMode || 'source-over';

                    // 背景差分設定
                    const bgSubtraction = document.getElementById('strobe-bg-subtraction');
                    if (bgSubtraction) bgSubtraction.value = this.settings.useBgSubtraction ? 'on' : 'off';

                    const bgThreshold = document.getElementById('strobe-bg-threshold');
                    const bgThresholdValue = document.getElementById('strobe-bg-threshold-value');
                    if (bgThreshold) bgThreshold.value = this.settings.bgSubThreshold || 30;
                    if (bgThresholdValue) bgThresholdValue.textContent = this.settings.bgSubThreshold || 30;

                    // 関連UIの表示/非表示
                    const thresholdRow = document.getElementById('bg-sub-threshold-row');
                    const captureRow = document.getElementById('bg-sub-capture-row');
                    if (thresholdRow) thresholdRow.style.display = this.settings.useBgSubtraction ? 'flex' : 'none';
                    if (captureRow) captureRow.style.display = this.settings.useBgSubtraction ? 'flex' : 'none';
                }

                // キャプチャデータを復元
                this.capturedFrames = [];

                for (const frame of data.capturedFrames) {
                    // Base64からImageDataに変換
                    const img = new Image();
                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                        img.src = frame.imageBase64;
                    });

                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = frame.bounds.width;
                    tempCanvas.height = frame.bounds.height;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.drawImage(img, 0, 0);
                    const imageData = tempCtx.getImageData(0, 0, frame.bounds.width, frame.bounds.height);

                    this.capturedFrames.push({
                        frameNumber: frame.frameNumber,
                        timestamp: frame.timestamp,
                        selection: frame.selection,
                        bounds: frame.bounds,
                        imageData: imageData
                    });
                }

                // キャッシュを無効化して表示を更新
                this.invalidateCapturedFramesCache();
                this.drawCapturedPositions();
                this.updateSliderMarkers();
                this.updateFrameCount();

                this.updateStatus(`イベントフレームを読み込みました: ${this.capturedFrames.length} フレーム`);
            } else if (!result.canceled) {
                this.updateStatus(`読込エラー: ${result.error}`);
            }
        } catch (error) {
            this.updateStatus(`読込エラー: ${error.message}`);
        }
    }

    // プロジェクトファイル保存用: キャプチャされたイベントをシリアライズ可能な形式で取得
    getEvents() {
        console.log('StrobeMotion: Saving events. Count:', this.capturedFrames.length);
        return this.capturedFrames.map(frame => {
            // 画像データは保存せず、メタデータのみを保存
            // 読み込み時に動画から再取得する
            return {
                frameNumber: frame.frameNumber,
                timestamp: frame.timestamp,
                selection: frame.selection,
                bounds: frame.bounds,
                drawPosition: frame.drawPosition,
                edgePoints: frame.edgePoints // AIキャプチャ再構築に必要
            };
        });
    }

    // プロジェクトファイル読込用: イベントデータを復元
    async restoreEvents(eventsData) {
        console.log('StrobeMotion: Restoring events...', eventsData);
        if (!eventsData || !Array.isArray(eventsData)) {
            console.error('StrobeMotion: Invalid events data');
            return;
        }

        this.updateStatus('ストロボモーションデータを復元中...');

        // 既存データをクリア
        this.capturedFrames = [];
        this.selections = [];

        // プロジェクトロード時はactiveSideが未設定の可能性があるためデフォルトを使用
        const side = this.activeSide || 'left';
        // restoreEventsが呼ばれたということは、そのsideで復元すべき
        this.activeSide = side;

        const player = this.videoPlayer?.players?.[side];
        if (!player || !player.video) {
            this.updateStatus('復元エラー: 動画がロードされていません');
            return;
        }

        // 現在の再生位置を保存
        const originalTime = player.video.currentTime;

        try {
            // 一時的なキャンバスを作成
            const captureCanvas = document.createElement('canvas');
            const captureCtx = captureCanvas.getContext('2d');

            for (let i = 0; i < eventsData.length; i++) {
                const frameData = eventsData[i];
                this.updateStatus(`復元中: ${i + 1}/${eventsData.length}`);

                // 該当の時間にシーク
                player.video.currentTime = frameData.timestamp;

                console.log(`StrobeMotion: Restoring frame ${i + 1}/${eventsData.length}`, frameData);

                // シーク完了を待つ（少し余裕を持たせる）
                await new Promise(resolve => {
                    const onSeek = () => {
                        player.video.removeEventListener('seeked', onSeek);
                        // シーク直後は描画が更新されていない場合があるため、少し待つ
                        // requestAnimationFrameを数回待つのが理想だが、ここではタイマーで簡易的に待機
                        setTimeout(resolve, 150);
                    };
                    player.video.addEventListener('seeked', onSeek);

                    // タイムアウト (5秒)
                    setTimeout(() => {
                        console.warn('StrobeMotion: Seek timeout for frame', i);
                        player.video.removeEventListener('seeked', onSeek);
                        resolve();
                    }, 5000);
                });

                // フレーム画像をキャプチャ
                let bitmap = null;
                let imageData = null;

                // 動画の解像度に合わせてキャンバスサイズを設定
                captureCanvas.width = player.video.videoWidth;
                captureCanvas.height = player.video.videoHeight;
                captureCtx.drawImage(player.video, 0, 0);

                if (frameData.selection.type === 'ai-mask' && frameData.edgePoints && frameData.edgePoints.length > 0) {
                    // AIマスクの場合: エッジ情報を使って切り抜き
                    const maskCanvas = document.createElement('canvas');
                    maskCanvas.width = frameData.bounds.width;
                    maskCanvas.height = frameData.bounds.height;
                    const maskCtx = maskCanvas.getContext('2d');

                    // パスを作成（ROI基準のローカル座標）
                    maskCtx.beginPath();
                    const startPt = frameData.edgePoints[0];
                    // edgePointsはROI左上(bounds.x, bounds.y)からの相対座標と想定
                    // もしedgePointsがframeData.bounds基準ならそのまま描画

                    // capture時のedgePointsはROI左上(0,0)基準...確認が必要だが
                    // 一旦保存時の仕様に合わせて、ROI画像を切り抜いてからマスク適用する

                    // ROI部分を切り出し
                    const roiData = captureCtx.getImageData(
                        frameData.bounds.x,
                        frameData.bounds.y,
                        frameData.bounds.width,
                        frameData.bounds.height
                    );

                    // クリッピング用キャンバス
                    const clipCanvas = document.createElement('canvas');
                    clipCanvas.width = frameData.bounds.width;
                    clipCanvas.height = frameData.bounds.height;
                    const clipCtx = clipCanvas.getContext('2d');

                    // マスクパスを描画
                    clipCtx.beginPath();
                    clipCtx.moveTo(frameData.edgePoints[0].x, frameData.edgePoints[0].y);
                    for (let j = 1; j < frameData.edgePoints.length; j++) {
                        clipCtx.lineTo(frameData.edgePoints[j].x, frameData.edgePoints[j].y);
                    }
                    clipCtx.closePath();
                    clipCtx.clip();

                    // ROI画像を描画（クリッピングされる）
                    // getImageDataの結果を直接描画できないので、createImageBitmapして描画
                    const roiBitmap = await createImageBitmap(roiData);
                    clipCtx.drawImage(roiBitmap, 0, 0);

                    bitmap = await createImageBitmap(clipCanvas);

                    // ImageDataも取得
                    imageData = clipCtx.getImageData(0, 0, clipCanvas.width, clipCanvas.height);

                } else {
                    // 通常の矩形/円形選択の場合
                    // 指定範囲を切り出し
                    imageData = captureCtx.getImageData(
                        frameData.bounds.x,
                        frameData.bounds.y,
                        frameData.bounds.width,
                        frameData.bounds.height
                    );
                    bitmap = await createImageBitmap(imageData);
                }

                // 復元したデータを登録
                this.capturedFrames.push({
                    frameNumber: frameData.frameNumber,
                    timestamp: frameData.timestamp,
                    selection: frameData.selection,
                    bounds: frameData.bounds,
                    drawPosition: frameData.drawPosition,
                    edgePoints: frameData.edgePoints,
                    bitmap: bitmap,
                    imageData: imageData
                });
            }

        } catch (e) {
            console.error('Frame restoration error:', e);
            this.updateStatus(`復元エラー: ${e.message}`);
        } finally {
            // 再生位置を元に戻す
            player.video.currentTime = originalTime;
        }

        // UIと内部状態を更新
        this.resizeCanvas();
        this.invalidateCapturedFramesCache();
        this.drawCapturedPositions();
        this.updateSliderMarkers();
        this.updateFrameCount();
        this.updateStatus(`ストロボモーションを復元しました: ${this.capturedFrames.length} フレーム`);
    }
}

// グローバルに公開
window.StrobeMotionController = StrobeMotionController;
