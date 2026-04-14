// ===================================
// skeleton-worker.js
// OffscreenCanvas用スケルトン描画Worker
// ===================================

// 定数定義（メインスレッドと同じ値）
const KEYPOINT_NAMES_23 = [
    'right_hand_tip', 'right_wrist', 'right_elbow', 'right_shoulder',
    'left_hand_tip', 'left_wrist', 'left_elbow', 'left_shoulder',
    'right_toe_tip', 'right_small_toe', 'right_heel', 'right_ankle', 'right_knee', 'right_hip',
    'left_toe_tip', 'left_small_toe', 'left_heel', 'left_ankle', 'left_knee', 'left_hip',
    'head_top', 'tragus_point', 'suprasternal_notch'
];

// ViTPose COCO スタイルに準拠
const SKELETON_CONNECTIONS_23 = [
    // 右上肢
    ['right_hand_tip', 'right_wrist'], ['right_wrist', 'right_elbow'], ['right_elbow', 'right_shoulder'],
    // 左上肢
    ['left_hand_tip', 'left_wrist'], ['left_wrist', 'left_elbow'], ['left_elbow', 'left_shoulder'],
    // 右下肢
    ['right_toe_tip', 'right_ankle'], ['right_ankle', 'right_knee'], ['right_knee', 'right_hip'],
    // 左下肢
    ['left_toe_tip', 'left_ankle'], ['left_ankle', 'left_knee'], ['left_knee', 'left_hip'],
    // 体幹
    ['right_shoulder', 'left_shoulder'], ['right_hip', 'left_hip'],
    ['right_shoulder', 'right_hip'], ['left_shoulder', 'left_hip'],
    // 頭部チェーン（体幹とは接続しない）
    ['head_top', 'tragus_point'], ['tragus_point', 'suprasternal_notch'],
];

// SynthPose / OpenCapBench 形式（52点: nativeモデル出力 + pelvis）
// https://github.com/StanfordMIMI/OpenCapBench
// モデル出力順 (config id2label に準拠)
// index 0-16: COCO 17点, index 17-51: SynthPose固有マーカー
const KEYPOINT_NAMES_SYNTHPOSE = [
    // COCO 17 (0-16)
    'Nose', 'L_Eye', 'R_Eye', 'L_Ear', 'R_Ear',
    'L_Shoulder', 'R_Shoulder', 'L_Elbow', 'R_Elbow', 'L_Wrist', 'R_Wrist',
    'L_Hip', 'R_Hip', 'L_Knee', 'R_Knee', 'L_Ankle', 'R_Ankle',
    // SynthPose固有 (17-51)
    'sternum', 'rshoulder', 'lshoulder',
    'r_lelbow', 'l_lelbow', 'r_melbow', 'l_melbow',
    'r_lwrist', 'l_lwrist', 'r_mwrist', 'l_mwrist',
    'r_ASIS', 'l_ASIS', 'r_PSIS', 'l_PSIS',
    'r_knee', 'l_knee', 'r_mknee', 'l_mknee',
    'r_ankle', 'l_ankle', 'r_mankle', 'l_mankle',
    'r_5meta', 'l_5meta', 'r_toe', 'l_toe', 'r_big_toe', 'l_big_toe', 'l_calc', 'r_calc',
    'C7', 'L2', 'T11', 'T6',
];

// 公式エッジ (config "edges") + SynthPoseバイオメカニクスマーカー接続
const SKELETON_CONNECTIONS_SYNTHPOSE = [
    // === 公式エッジ (edges from model config) ===
    // 頭部
    ['Nose', 'L_Eye'], ['Nose', 'R_Eye'],
    ['L_Eye', 'R_Eye'], ['L_Eye', 'L_Ear'], ['R_Eye', 'R_Ear'],
    ['L_Ear', 'L_Shoulder'], ['R_Ear', 'R_Shoulder'],
    // 体幹
    ['L_Shoulder', 'R_Shoulder'],
    ['L_Shoulder', 'L_Hip'], ['R_Shoulder', 'R_Hip'],
    ['L_Hip', 'R_Hip'],
    // 右腕 (COCO)
    ['R_Shoulder', 'R_Elbow'], ['R_Elbow', 'R_Wrist'],
    // 左腕 (COCO)
    ['L_Shoulder', 'L_Elbow'], ['L_Elbow', 'L_Wrist'],
    // 右脚 (COCO)
    ['R_Hip', 'R_Knee'], ['R_Knee', 'R_Ankle'],
    // 左脚 (COCO)
    ['L_Hip', 'L_Knee'], ['L_Knee', 'L_Ankle'],
    // === SynthPose バイオメカニクスマーカー ===
    // 肩帯・鎖骨
    ['rshoulder', 'lshoulder'],
    ['rshoulder', 'sternum'], ['lshoulder', 'sternum'],
    // 頸椎（肩→C7）
    ['rshoulder', 'C7'], ['lshoulder', 'C7'],
    // 脊椎チェーン
    ['C7', 'T6'], ['T6', 'T11'], ['T11', 'L2'],
    // 骨盤
    ['r_ASIS', 'l_ASIS'],
    ['L2', 'r_ASIS'], ['L2', 'l_ASIS'],
    // 右腕 (SynthPose)
    ['rshoulder', 'r_lelbow'], ['r_lelbow', 'r_lwrist'],
    // 左腕 (SynthPose)
    ['lshoulder', 'l_lelbow'], ['l_lelbow', 'l_lwrist'],
    // 右脚 (SynthPose)
    ['r_ASIS', 'r_knee'], ['r_knee', 'r_ankle'],
    ['r_ankle', 'r_big_toe'], ['r_ankle', 'r_5meta'], ['r_ankle', 'r_calc'],
    // 左脚 (SynthPose)
    ['l_ASIS', 'l_knee'], ['l_knee', 'l_ankle'],
    ['l_ankle', 'l_big_toe'], ['l_ankle', 'l_5meta'], ['l_ankle', 'l_calc'],
];

// ===================================
// 25点形式（阿江モデル対応）
// ===================================

// ---- アクティブな設定（updateConfigで切り替え可能） ----
let KEYPOINT_NAMES = KEYPOINT_NAMES_23;
let SKELETON_CONNECTIONS = SKELETON_CONNECTIONS_23;

const COLORS = {
    right: '#EF4444',
    left: '#3B82F6',
    center: '#10B981'
};

const PERSON_COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'
];

const CONFIDENCE_THRESHOLD = 0.3;
const POINT_ALPHA = 0.7;  // ポイントの透過度（0.0-1.0）
const POINT_RADIUS = 5;   // ポイントの基本サイズ（ピクセル）

// Worker状態
let canvas = null;
let ctx = null;
let canvasWidth = 0;
let canvasHeight = 0;

// Path2Dキャッシュ（同一フレームでの再描画を高速化）
let pathCache = new Map();
const MAX_CACHE_SIZE = 100;

// ===================================
// メッセージハンドラ
// ===================================
self.onmessage = function (e) {
    const { type, ...data } = e.data;

    switch (type) {
        case 'init':
            handleInit(data);
            break;
        case 'resize':
            handleResize(data);
            break;
        case 'draw':
            handleDraw(data);
            break;
        case 'drawScaled':
            handleDrawScaled(data);
            break;
        case 'clear':
            handleClear();
            break;
        case 'clearCache':
            pathCache.clear();
            break;
        case 'updateConfig':
            handleUpdateConfig(data);
            break;
        default:
            console.warn('Unknown message type:', type);
    }
};

// ===================================
// 初期化
// ===================================
function handleInit(data) {
    canvas = data.canvas;
    ctx = canvas.getContext('2d', {
        alpha: true,
        desynchronized: true  // 低遅延モード
    });
    canvasWidth = data.width || canvas.width;
    canvasHeight = data.height || canvas.height;

    // 初期サイズ設定
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    self.postMessage({ type: 'initialized', success: true });
}

// ===================================
// 設定更新（出力形式切替）
// ===================================
function handleUpdateConfig(data) {
    const format = data.outputFormat;
    if (format === 'synthpose') {
        KEYPOINT_NAMES = KEYPOINT_NAMES_SYNTHPOSE;
        SKELETON_CONNECTIONS = SKELETON_CONNECTIONS_SYNTHPOSE;
    } else {
        KEYPOINT_NAMES = KEYPOINT_NAMES_23;
        SKELETON_CONNECTIONS = SKELETON_CONNECTIONS_23;
    }
    pathCache.clear();
    self.postMessage({ type: 'configUpdated', outputFormat: format });
}

// ===================================
// リサイズ
// ===================================
function handleResize(data) {
    canvasWidth = data.width;
    canvasHeight = data.height;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // キャッシュをクリア（サイズ変更でパスが無効になるため）
    pathCache.clear();

    self.postMessage({ type: 'resized', width: canvasWidth, height: canvasHeight });
}

// ===================================
// 描画（通常モード）
// ===================================
function handleDraw(data) {
    const { drawId, keypoints, frame, options = {} } = data;

    if (!ctx || !keypoints) {
        self.postMessage({ type: 'drawComplete', drawId, success: false });
        return;
    }

    const startTime = performance.now();

    // キャンバスをクリア（変換適用前にリセット）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // ズーム・パン適用
    const zoom = options.zoom || 1;
    const panX = options.panX || 0;
    const panY = options.panY || 0;
    ctx.setTransform(zoom, 0, 0, zoom, panX, panY);

    // スケルトン描画
    drawKeypoints(ctx, keypoints, options);

    const drawTime = performance.now() - startTime;

    self.postMessage({
        type: 'drawComplete',
        drawId,
        success: true,
        drawTime
    });
}

// ===================================
// 描画（スケーリングあり：プレビュー用）
// ===================================
function handleDrawScaled(data) {
    const { drawId, keypoints, scaleX, scaleY, selectedPersonId, selectedKeypointIdx, skeletonZoom = 1, panX = 0, panY = 0, offsetX = 0, offsetY = 0, pointSize = POINT_RADIUS, pointAlpha = POINT_ALPHA, lineWidth = 2 } = data;

    if (!ctx || !keypoints) {
        self.postMessage({ type: 'drawComplete', drawId, success: false });
        return;
    }

    const startTime = performance.now();

    // キャンバスをクリア
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // 変換適用（App側の描画ロジックを再現）
    // translate(offsetX + panX, offsetY + panY) -> scale(zoom, zoom) -> scale(scaleX, scaleY)
    ctx.translate(offsetX + panX, offsetY + panY);
    ctx.scale(skeletonZoom, skeletonZoom);
    ctx.scale(scaleX, scaleY);

    // スケルトン描画
    // drawScaledKeypointsは変換済みのコンテキストに対して描画する
    // scaleX, scaleYはポイントサイズの補正計算などに使われるためそのまま渡す
    drawScaledKeypoints(ctx, keypoints, scaleX, scaleY, selectedPersonId, selectedKeypointIdx, skeletonZoom, pointSize, pointAlpha, lineWidth);

    const drawTime = performance.now() - startTime;

    self.postMessage({
        type: 'drawComplete',
        drawId,
        success: true,
        drawTime
    });
}

// ===================================
// キャンバスクリア
// ===================================
function handleClear() {
    if (ctx) {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    }
    self.postMessage({ type: 'cleared' });
}

// ===================================
// 描画関数（通常モード）
// ===================================
function drawKeypoints(ctx, keypoints, options = {}) {
    const { showBoundingBox = true, showLabels = true, pointSize = POINT_RADIUS, pointAlpha = POINT_ALPHA, lineWidth = 2 } = options;

    Object.entries(keypoints).forEach(([personId, kpts], idx) => {
        const personColor = PERSON_COLORS[idx % PERSON_COLORS.length];

        // バウンディングボックス
        if (showBoundingBox) {
            const bbox = calculateBoundingBox(kpts);
            if (bbox) {
                ctx.strokeStyle = personColor;
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
                ctx.setLineDash([]);

                // ラベル
                if (showLabels) {
                    const labelText = `Person ${personId}`;
                    ctx.font = 'bold 16px Arial';
                    const textWidth = ctx.measureText(labelText).width;

                    ctx.fillStyle = personColor;
                    ctx.fillRect(bbox.x, bbox.y - 24, textWidth + 10, 22);

                    ctx.fillStyle = '#000';
                    ctx.fillText(labelText, bbox.x + 5, bbox.y - 8);
                }
            }
        }

        // キーポイントマップを作成
        const keypointsMap = {};
        KEYPOINT_NAMES.forEach((name, i) => {
            keypointsMap[name] = kpts[i];
        });

        // スケルトンライン
        ctx.lineWidth = lineWidth;
        SKELETON_CONNECTIONS.forEach(([start, end]) => {
            const p1 = keypointsMap[start];
            const p2 = keypointsMap[end];
            if (p1 && p2 && p1[2] > CONFIDENCE_THRESHOLD && p2[2] > CONFIDENCE_THRESHOLD) {
                ctx.strokeStyle = getLineColor(start, end);
                ctx.beginPath();
                ctx.moveTo(p1[0], p1[1]);
                ctx.lineTo(p2[0], p2[1]);
                ctx.stroke();
            }
        });

        // キーポイント
        KEYPOINT_NAMES.forEach((name, i) => {
            const kp = kpts[i];
            if (kp && kp[2] > CONFIDENCE_THRESHOLD) {
                const baseColor = getPointColor(name);
                ctx.fillStyle = applyAlpha(baseColor, pointAlpha);
                ctx.beginPath();
                ctx.arc(kp[0], kp[1], pointSize, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1.0, pointAlpha + 0.2)})`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        });
    });
}

// ===================================
// 描画関数（スケール付きモード）
// ===================================
function drawScaledKeypoints(ctx, keypoints, scaleX, scaleY, selectedPersonId = null, selectedKeypointIdx = null, zoomFactor = 1, pointSize = POINT_RADIUS, pointAlpha = POINT_ALPHA, lineWidth = 2) {
    // ズームによるサイズ拡大を打ち消すための補正係数
    const sizeCompensation = 1 / zoomFactor;

    Object.entries(keypoints).forEach(([personId, kpts], idx) => {
        // 選択した人物のみ表示する場合
        if (selectedPersonId && personId !== selectedPersonId) {
            return;
        }

        const personColor = PERSON_COLORS[idx % PERSON_COLORS.length];
        const isSelectedPerson = personId === selectedPersonId;

        // バウンディングボックスとラベル
        const bbox = calculateBoundingBox(kpts);
        if (bbox) {
            ctx.strokeStyle = personColor;
            ctx.lineWidth = 2 * sizeCompensation;
            ctx.setLineDash([5 * sizeCompensation, 5 * sizeCompensation]);
            ctx.strokeRect(bbox.x * scaleX, bbox.y * scaleY, bbox.width * scaleX, bbox.height * scaleY);
            ctx.setLineDash([]);

            // ラベル
            const labelText = `Person ${personId}`;
            const fontSize = Math.max(12, 16 * sizeCompensation);
            ctx.font = `bold ${fontSize}px Arial`;
            const textWidth = ctx.measureText(labelText).width;

            const labelX = bbox.x * scaleX;
            const labelY = bbox.y * scaleY - 24 * sizeCompensation;
            const labelHeight = 22 * sizeCompensation;

            ctx.fillStyle = personColor;
            ctx.fillRect(labelX, labelY, textWidth + 10 * sizeCompensation, labelHeight);

            ctx.fillStyle = '#000';
            ctx.fillText(labelText, labelX + 5 * sizeCompensation, labelY + labelHeight - 6 * sizeCompensation);
        }

        // キーポイントマップを作成
        const keypointsMap = {};
        KEYPOINT_NAMES.forEach((name, i) => {
            keypointsMap[name] = kpts[i];
        });

        // スケルトンライン
        ctx.lineWidth = lineWidth * sizeCompensation;
        SKELETON_CONNECTIONS.forEach(([start, end]) => {
            const p1 = keypointsMap[start];
            const p2 = keypointsMap[end];
            if (p1 && p2 && p1[2] > CONFIDENCE_THRESHOLD && p2[2] > CONFIDENCE_THRESHOLD) {
                ctx.strokeStyle = getLineColor(start, end);
                ctx.beginPath();
                ctx.moveTo(p1[0] * scaleX, p1[1] * scaleY);
                ctx.lineTo(p2[0] * scaleX, p2[1] * scaleY);
                ctx.stroke();
            }
        });

        // キーポイント
        KEYPOINT_NAMES.forEach((name, i) => {
            const kp = kpts[i];
            if (kp && kp[2] > CONFIDENCE_THRESHOLD) {
                const isSelected = isSelectedPerson && i === selectedKeypointIdx;
                const radius = (isSelected ? pointSize * 1.5 : pointSize) * sizeCompensation;

                if (isSelected) {
                    // 選択ポイント（グロー、透過黄色、赤枠）
                    ctx.shadowBlur = 15 * sizeCompensation;
                    ctx.shadowColor = '#ffff00';
                    ctx.fillStyle = `rgba(255, 255, 0, ${pointAlpha})`;

                    ctx.beginPath();
                    ctx.arc(kp[0] * scaleX, kp[1] * scaleY, radius, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.shadowBlur = 0;
                    ctx.strokeStyle = '#ff0000';
                    ctx.lineWidth = lineWidth * sizeCompensation;
                    ctx.stroke();
                } else {
                    // 通常ポイント（透過色）
                    ctx.shadowBlur = 0;
                    const baseColor = getPointColor(name);
                    ctx.fillStyle = applyAlpha(baseColor, pointAlpha);

                    ctx.beginPath();
                    ctx.arc(kp[0] * scaleX, kp[1] * scaleY, radius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1.0, pointAlpha + 0.2)})`;
                    ctx.lineWidth = 1 * sizeCompensation;
                    ctx.stroke();
                }
            }
        });
    });
}

// ===================================
// ユーティリティ関数
// ===================================
function calculateBoundingBox(kpts) {
    const validPoints = kpts.filter(kp => kp && kp[2] > CONFIDENCE_THRESHOLD);
    if (validPoints.length === 0) return null;

    const xs = validPoints.map(kp => kp[0]);
    const ys = validPoints.map(kp => kp[1]);

    const padding = 20;
    return {
        x: Math.min(...xs) - padding,
        y: Math.min(...ys) - padding,
        width: Math.max(...xs) - Math.min(...xs) + padding * 2,
        height: Math.max(...ys) - Math.min(...ys) + padding * 2
    };
}

function isRightSide(name) {
    return name.startsWith('right') || name.startsWith('r_') || name === 'rshoulder' ||
           name.startsWith('R_');
}

function isLeftSide(name) {
    return name.startsWith('left') || name.startsWith('l_') || name === 'lshoulder' ||
           name.startsWith('L_');
}

function getPointColor(name) {
    if (isRightSide(name)) return COLORS.right;
    if (isLeftSide(name)) return COLORS.left;
    return COLORS.center;
}

function getLineColor(start, end) {
    if (isRightSide(start) && isRightSide(end)) return COLORS.right;
    if (isLeftSide(start) && isLeftSide(end)) return COLORS.left;
    return COLORS.center;
}

// HEXカラーにアルファ値を適用してRGBA形式に変換
function applyAlpha(hexColor, alpha) {
    // #RRGGBB形式からRGBを抽出
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
