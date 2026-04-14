
// ===================================
// Skeleton Renderer Initialization
// ===================================
async function initSkeletonRenderers() {
    // メイン表示用（動画オーバーレイ）
    if (elements.skeletonOverlayCanvas) {
        state.skeletonRenderer = new SkeletonRenderer(elements.skeletonOverlayCanvas, {
            workerPath: 'skeleton-worker.js'
        });
        await state.skeletonRenderer.init();
    }

    // スケルトンプレビュー用
    if (elements.skeletonPreviewCanvas && !elements.skeletonPreviewCanvas._offscreenTransferred) {
        state.skeletonPreviewRenderer = new SkeletonRenderer(elements.skeletonPreviewCanvas, {
            workerPath: 'skeleton-worker.js'
        });
        await state.skeletonPreviewRenderer.init();
        elements.skeletonPreviewCanvas._offscreenTransferred = true;
    }

    console.log('[App] Skeleton renderers initialized');
}

function cleanup() {
    // Workerの破棄
    if (state.skeletonRenderer) {
        state.skeletonRenderer.destroy();
        state.skeletonRenderer = null;
    }
    if (state.skeletonPreviewRenderer) {
        state.skeletonPreviewRenderer.destroy();
        state.skeletonPreviewRenderer = null;
    }
}
