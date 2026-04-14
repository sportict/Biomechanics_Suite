/**
 * trc-handler.js
 * TRC (Track Row Column) File Writer for OpenSim
 * Format reference: OpenSim TRC file specification
 *
 * TRC structure:
 *   Line 1: PathFileType header
 *   Line 2: Column name row
 *   Line 3: Parameter values (DataRate, NumFrames, NumMarkers, Units, ...)
 *   Line 4: Frame#, Time, MarkerName columns (each marker spans 3 columns)
 *   Line 5: Sub-column labels (empty, empty, X1, Y1, Z1, X2, ...)
 *   Line 6+: Data rows
 *
 * Units: meters (OpenSim standard)
 */


/**
 * カメラ座標系 → OpenSim 座標系への変換
 *   カメラ: X=左右(lateral), Y=奥行(depth/forward), Z=高さ(up)
 *   OpenSim: X=前後(forward), Y=上下(up), Z=左右(lateral)
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{x:number, y:number, z:number}}
 */
function toOpenSimAxes(x, y, z) {
    return { x: y, y: z, z: x };
}

/**
 * Generate TRC file content string from motion data.
 * 座標軸変換（カメラ座標 → OpenSim Y-up）は常に適用される。
 *
 * @param {Array}  points         - window.motionPoints [{id, name}, ...]
 * @param {Array}  realLengthData - window.realLengthData [{frame, pointId, x, y, z}, ...]
 * @param {number} fps            - frames per second
 * @param {string} filename       - base filename (for header line)
 * @returns {string} TRC file content
 */
function generateTRCContent(points, realLengthData, fps, filename) {
    // Build frame map: frame -> pointId -> {x, y, z}
    const frameMap = new Map();
    let minFrame = Infinity;
    let maxFrame = -Infinity;

    realLengthData.forEach(r => {
        const f = Number(r.frame);
        if (f < minFrame) minFrame = f;
        if (f > maxFrame) maxFrame = f;
        if (!frameMap.has(f)) frameMap.set(f, new Map());
        frameMap.get(f).set(String(r.pointId), { x: r.x, y: r.y, z: r.z });
    });

    if (minFrame === Infinity) {
        throw new Error('有効なフレームデータがありません。');
    }

    const numFrames = maxFrame - minFrame + 1;
    const numMarkers = points.length;
    const dataRate = fps;
    const cameraRate = fps;
    const origDataRate = fps;
    const origDataStartFrame = minFrame;
    const origNumFrames = numFrames;
    const units = 'm';

    const basename = filename || 'motion_data.trc';
    const tab = '\t';

    const lines = [];

    // Line 1: PathFileType header
    lines.push(['PathFileType', '4', '(X/Y/Z)', basename].join(tab));

    // Line 2: Parameter column names
    lines.push([
        'DataRate', 'CameraRate', 'NumFrames', 'NumMarkers',
        'Units', 'OrigDataRate', 'OrigDataStartFrame', 'OrigNumFrames'
    ].join(tab));

    // Line 3: Parameter values
    lines.push([
        dataRate.toFixed(2),
        cameraRate.toFixed(2),
        numFrames,
        numMarkers,
        units,
        origDataRate.toFixed(2),
        origDataStartFrame,
        origNumFrames
    ].join(tab));

    // Line 4: Marker name header
    // Format: Frame#\tTime\tMarker1\t\t\tMarker2\t\t\t...
    const markerHeader = ['Frame#', 'Time'];
    points.forEach(p => {
        markerHeader.push(p.name, '', '');
    });
    lines.push(markerHeader.join(tab));

    // Line 5: Sub-column labels
    // Format: \t\tX1\tY1\tZ1\tX2\tY2\tZ2\t...
    const subHeader = ['', ''];
    points.forEach((p, i) => {
        const n = i + 1;
        subHeader.push(`X${n}`, `Y${n}`, `Z${n}`);
    });
    lines.push(subHeader.join(tab));

    // Line 6: 公式仕様で必須の空行（sub-labels とデータ行の間）
    lines.push('');

    // Line 7+: Data rows
    const dt = 1.0 / fps;
    for (let i = 0; i < numFrames; i++) {
        const frameNum = minFrame + i;
        const time = (i * dt).toFixed(6);
        const framePoints = frameMap.get(frameNum);

        const row = [frameNum, time];
        points.forEach(p => {
            const pd = framePoints ? framePoints.get(String(p.id)) : null;
            if (pd && pd.x !== null && pd.x !== undefined) {
                const rawX = Number(pd.x);
                const rawY = Number(pd.y);
                const rawZ = pd.z !== undefined && pd.z !== null ? Number(pd.z) : 0;
                const { x, y, z } = toOpenSimAxes(rawX, rawY, rawZ);
                row.push(x.toFixed(6), y.toFixed(6), z.toFixed(6));
            } else {
                // Missing data: OpenSim accepts blank fields
                row.push('', '', '');
            }
        });
        lines.push(row.join(tab));
    }

    return lines.join('\r\n');
}

/**
 * Export window.realLengthData as a TRC file via save dialog.
 * 座標軸変換（カメラ座標 → OpenSim Y-up）は常に適用される。
 */
window.exportMotionDataToTRC = async function () {
    console.log('Exporting TRC...');

    if (!window.realLengthData || window.realLengthData.length === 0) {
        showError('エクスポートする実長換算データがありません。先に実長換算を実行してください。');
        return;
    }

    const points = window.motionPoints || [];
    if (points.length === 0) {
        showError('モーションポイントが定義されていません。');
        return;
    }

    const fps = (window.projectData && window.projectData.settings && window.projectData.settings.fps) || 30;

    const path = require('path');

    let defaultPath = 'motion_data.trc';
    const projName = window.projectData?.settings?.projectFileName;
    const projPath = window.projectData?.settings?.projectPath;

    let initialDir = '';
    if (projPath) {
        initialDir = path.dirname(projPath);
    }

    let basename = 'motion_data.trc';
    if (projName) {
        const safeName = projName.replace(/\.[^/.]+$/, '');
        basename = `${safeName}.trc`;
    }
    defaultPath = path.join(initialDir, basename);

    try {
        const content = generateTRCContent(points, window.realLengthData, fps, basename);

        const res = await ipcRenderer.invoke('save-file', {
            title: 'TRCファイルを保存 (OpenSim)',
            defaultPath: defaultPath,
            filters: [
                { name: 'TRC File', extensions: ['trc'] }
            ]
        });

        if (res && res.success && res.filePath) {
            const writeRes = await ipcRenderer.invoke('write-text-file', res.filePath, content);
            if (writeRes.success) {
                showMessage(`TRCファイルを出力しました: ${res.filePath}`);
            } else {
                showError('TRCファイル書き込みエラー: ' + (writeRes.error || 'Unknown'));
            }
        }
    } catch (e) {
        console.error(e);
        showError('TRC出力エラー: ' + e.message);
    }
};

