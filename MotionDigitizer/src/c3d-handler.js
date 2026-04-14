/**
 * c3d-handler.js 
 * Basic C3D File Writer Implementation
 * Adheres to C3D.org specification for Float format
 */

class C3DWriter {
    constructor() {
        this.points = []; // Array of { name: string, data: [{x,y,z,err}, ...] }
        this.frameRate = 30.0;
        this.analogChannels = 0;
        this.analogRate = 0.0;
        this.startFrame = 1;
        this.description = 'MotionDigitizer Export';
    }

    addPoint(name, data) {
        this.points.push({ name, data });
    }

    setFrameRate(fps) {
        this.frameRate = fps;
    }

    createBuffer() {
        const numPoints = this.points.length;
        if (numPoints === 0) throw new Error("No points to export");

        const numFrames = this.points[0].data.length;
        const scaleFactor = -1.0; // Float format

        // --- 1. Parameter Section Construction ---
        // We need to calculate size first or build dynamically.
        // Let's build usage groups: POINT(1), ANALOG(2)
        // Params: POINT:LABELS, POINT:used, POINT:rate, POINT:scale, POINT:units
        // ANALOG:used, etc. (minimal)

        const paramBuffer = this.buildParameterSection(numPoints, numFrames);
        const paramBlockCount = Math.ceil(paramBuffer.length / 512);

        // --- 2. Header Construction ---
        const header = new Uint8Array(512);
        const view = new DataView(header.buffer);

        view.setUint8(0, 2); // Param header start block
        view.setUint8(1, 0x50); // Signature
        view.setUint16(2, numPoints, true); // Number of points
        view.setUint16(4, this.analogChannels, true); // Analog channels
        view.setUint16(6, this.startFrame, true); // Start frame
        view.setUint16(8, this.startFrame + numFrames - 1, true); // End frame
        view.setUint16(10, 0, true); // Max gap
        view.setFloat32(12, scaleFactor, true); // Scale factor

        const dataStartBlock = 2 + paramBlockCount;
        view.setUint16(16, dataStartBlock, true);

        view.setUint16(18, 0, true); // Samples per frame (Analog)
        view.setFloat32(20, this.frameRate, true); // Frame rate

        view.setUint16(298, 0x3039, true); // Label type (key requirement for some readers?) - Optional

        // --- 3. Data Section Construction ---
        // 4 words per point (X, Y, Z, Err) * 4 bytes/float = 16 bytes per point
        const bytesPerFrame = numPoints * 16;
        const dataSize = bytesPerFrame * numFrames;
        // Padding to 512 bytes
        const totalDataBlocks = Math.ceil(dataSize / 512);
        const totalDataSize = totalDataBlocks * 512;

        const dataBuffer = new Uint8Array(totalDataSize);
        const dataView = new DataView(dataBuffer.buffer);

        let offset = 0;
        for (let f = 0; f < numFrames; f++) {
            for (let p = 0; p < numPoints; p++) {
                const pt = this.points[p].data[f] || { x: 0, y: 0, z: 0, valid: false };
                dataView.setFloat32(offset, pt.x, true);
                dataView.setFloat32(offset + 4, pt.y, true);
                dataView.setFloat32(offset + 8, pt.z, true);

                // 4th word: Residual. Valid if >= 0. Invalid if < 0.
                const residual = pt.valid ? 0.0 : -1.0;
                dataView.setFloat32(offset + 12, residual, true);

                offset += 16;
            }
        }

        // Combine
        const totalSize = 512 + (paramBlockCount * 512) + totalDataSize;
        const finalBuffer = new Uint8Array(totalSize);
        finalBuffer.set(header, 0);

        // Write Params (padded)
        const paddedParams = new Uint8Array(paramBlockCount * 512);
        paddedParams.set(paramBuffer);
        finalBuffer.set(paddedParams, 512);

        // Write Data
        finalBuffer.set(dataBuffer, 512 + (paramBlockCount * 512));

        return finalBuffer;
    }

    buildParameterSection(numPoints, numFrames) {
        // Simple parameter builder
        // Header of Param Section:
        // Byte 0: Reserved
        // Byte 1: Reserved
        // Byte 2: Param Block Count
        // Byte 3: Processor Type (84 = Intel)

        let params = [];
        let offset = 4; // Start after header

        // Helper to add parameter
        // Group ID: Negative for group def, Positive for param belonging to group
        const addGroup = (id, name, desc) => {
            const p = this.createParamRecord(-Math.abs(id), name, 0, [], desc);
            params.push(p);
        };
        const addParam = (groupId, name, type, dims, data, desc) => {
            const p = this.createParamRecord(Math.abs(groupId), name, type, dims, data, desc);
            params.push(p);
        };

        // Groups
        addGroup(1, 'POINT', 'Point parameters');
        // addGroup(2, 'ANALOG', 'Analog parameters');

        // Parameters
        addParam(1, 'USED', 2, [], [numPoints], 'Number of points used');
        addParam(1, 'SCALE', 4, [], [-1.0], '3D Scale factor');
        addParam(1, 'RATE', 4, [], [this.frameRate], 'Video Frame Rate');
        addParam(1, 'DATA_START', 2, [], [0], 'Data start block'); // Will be updated later if needed, but header handles it usually
        addParam(1, 'FRAMES', 2, [], [numFrames], 'Number of frames');

        // LABELS
        // Flatten labels to 1D char array or 2D. C3D expects 2D: [Names, Length] usually.
        // Actually Type -1 (Char) with dims [Len, Count].
        // But many readers prefer fixed length labels. Let's use 32 chars.
        const labelLen = 32;
        const labelBytes = [];
        for (let i = 0; i < numPoints; i++) {
            let name = this.points[i].name || `Point${i + 1}`;
            if (name.length > labelLen) name = name.substring(0, labelLen);
            for (let c = 0; c < labelLen; c++) {
                labelBytes.push(c < name.length ? name.charCodeAt(c) : 32); // Space padding
            }
        }
        addParam(1, 'LABELS', -1, [labelLen, numPoints], labelBytes, 'Point Labels');

        addParam(1, 'UNITS', -1, [2, numPoints], new Array(2 * numPoints).fill('m'.charCodeAt(0)), 'Point Units (mm)');
        // Note: Units are usually 'mm'. If input is meters, we should convert or state 'm'. 
        // MotionDigitizer processes in pixels/meters. Let's assume input data is converted to desired unit.

        // Serialize params
        let totalLen = 4; // Header
        params.forEach(p => totalLen += p.length);

        // buffer
        const buffer = new Uint8Array(totalLen);
        const view = new DataView(buffer.buffer);

        // Header
        buffer[0] = 0;
        buffer[1] = 0;
        // buffer[2] (Block count) calculated later
        buffer[3] = 84; // Intel processor

        let currentPos = 4;
        params.forEach((p, idx) => {
            const isLast = idx === params.length - 1;
            const nextOffset = isLast ? 0 : p.length;

            // Record Header
            // 0: Name Len (signed)
            view.setInt8(currentPos, p.name.length);
            // 1: Group ID
            view.setInt8(currentPos + 1, p.groupId);
            // 2-X: Name
            for (let i = 0; i < p.name.length; i++) {
                view.setUint8(currentPos + 2 + i, p.name.charCodeAt(i));
            }
            const ptr = currentPos + 2 + p.name.length;

            // Pointer to next
            view.setUint16(ptr, nextOffset, true);

            // payload starts at ptr+2
            let payloadPos = ptr + 2;

            // Type
            view.setInt8(payloadPos, p.type);
            payloadPos++;

            // Dims
            view.setUint8(payloadPos, p.dims.length);
            payloadPos++;
            p.dims.forEach(d => {
                view.setUint8(payloadPos, d);
                payloadPos++;
            });

            // Data
            if (p.data) {
                if (p.type === -1) { // Char
                    p.data.forEach(b => {
                        view.setUint8(payloadPos, b);
                        payloadPos++;
                    });
                } else if (p.type === 2) { // Int
                    p.data.forEach(v => {
                        view.setInt16(payloadPos, v, true);
                        payloadPos += 2;
                    });
                } else if (p.type === 4) { // Float
                    p.data.forEach(v => {
                        view.setFloat32(payloadPos, v, true);
                        payloadPos += 4;
                    });
                }
            }

            // Desc
            view.setUint8(payloadPos, p.desc.length);
            payloadPos++;
            for (let i = 0; i < p.desc.length; i++) {
                view.setUint8(payloadPos + i, p.desc.charCodeAt(i));
            }

            currentPos += p.length;
        });

        // Update Block Count in header
        const blockCount = Math.ceil(totalLen / 512);
        buffer[2] = blockCount;

        return buffer;
    }

    createParamRecord(groupId, name, type, dims = [], data = [], desc = '') {
        // Calculate size
        // Header: 1(NameLen) + 1(ID) + NameLen + 2(NextPtr) + 1(Type) + 1(DimCount) + Dims + DataSize + 1(DescLen) + Desc
        let dataSize = 0;
        const count = dims.reduce((a, b) => a * b, 1);

        if (type === -1) dataSize = count; // Char
        else if (type === 1) dataSize = count; // Byte
        else if (type === 2) dataSize = count * 2; // Int
        else if (type === 4) dataSize = count * 4; // Float

        const size = 1 + 1 + name.length + 2 + 1 + 1 + dims.length + dataSize + 1 + desc.length;

        return {
            groupId,
            name: name.toUpperCase(),
            type,
            dims,
            data,
            desc,
            length: size
        };
    }
}

// Global export
window.C3DWriter = C3DWriter;
window.exportMotionDataToC3D = async function () {
    console.log('Exporting C3D...');

    // Check data
    if (!window.realLengthData || window.realLengthData.length === 0) {
        showError('エクスポートする実長換算データがありません。先に実長換算を実行してください。');
        return;
    }

    // Check Points
    const points = window.motionPoints || [];
    if (points.length === 0) {
        showError('モーションポイントが定義されていません。');
        return;
    }

    // Prepare Writer
    const writer = new C3DWriter();

    // FPS
    const fps = (window.projectData && window.projectData.settings && window.projectData.settings.fps) || 30;
    writer.setFrameRate(fps);

    // Frame Data Preparation
    const frameMap = new Map();
    let minFrame = Infinity;
    let maxFrame = -Infinity;

    window.realLengthData.forEach(r => {
        const f = Number(r.frame);
        if (f < minFrame) minFrame = f;
        if (f > maxFrame) maxFrame = f;
        if (!frameMap.has(f)) frameMap.set(f, new Map());
        frameMap.get(f).set(String(r.pointId), { x: r.x, y: r.y, z: r.z });
    });

    if (minFrame === Infinity) {
        showError('有効なフレームデータがありません。');
        return;
    }
    writer.startFrame = minFrame;
    const numFrames = maxFrame - minFrame + 1;

    // Build Point Data
    // We assume data is in METERS (since realLengthData is typically meters if using 3D DLT).
    // If output should be mm, we need to multiply. C3D is unit-agnostic but mm is standard.
    // Let's assume we want MM for C3D.
    const toMM = 1000.0;

    // Mode Check (2D/3D)
    // If 2D, Z is 0.

    points.forEach(p => {
        const pointData = [];
        for (let i = 0; i < numFrames; i++) {
            const frameNum = minFrame + i;
            const framePoints = frameMap.get(frameNum);
            const pd = framePoints ? framePoints.get(String(p.id)) : null;

            if (pd && pd.x !== null && pd.y !== null) {
                // Convert to mm
                pointData.push({
                    x: Number(pd.x) * toMM,
                    y: Number(pd.y) * toMM,
                    z: (pd.z !== undefined && pd.z !== null ? Number(pd.z) : 0) * toMM,
                    valid: true
                });
            } else {
                pointData.push({ x: 0, y: 0, z: 0, valid: false });
            }
        }
        writer.addPoint(p.name, pointData);
    });

    try {
        const buffer = writer.createBuffer();

        // Prepare default path
        let defaultPath = 'motion_data.c3d';
        const projName = window.projectData?.settings?.projectFileName;
        const projPath = window.projectData?.settings?.projectPath; // これがmdpファイルのパスかもしれない

        // パス操作のためpathをrequire
        const path = require('path');

        let initialDir = '';
        if (projPath) {
            initialDir = path.dirname(projPath);
        }

        if (projName) {
            const safeName = projName.replace(/\.[^/.]+$/, "");
            defaultPath = path.join(initialDir, `${safeName}.c3d`);
        } else {
            defaultPath = path.join(initialDir, defaultPath);
        }

        const res = await ipcRenderer.invoke('save-file', {
            title: 'C3Dファイルを保存',
            defaultPath: defaultPath,
            filters: [
                { name: 'C3D File', extensions: ['c3d'] }
            ]
        });

        if (res && res.success && res.filePath) {
            const writeRes = await ipcRenderer.invoke('write-binary-file', res.filePath, buffer);
            if (writeRes.success) {
                showMessage(`C3Dファイルを出力しました: ${res.filePath}`);
            } else {
                showError('C3Dファイル書き込みエラー: ' + (writeRes.error || 'Unknown'));
            }
        }
    } catch (e) {
        console.error(e);
        showError('C3D出力エラー: ' + e.message);
    }
};
