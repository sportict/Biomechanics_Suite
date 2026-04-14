/**
 * ONNX Segmentation Bridge for VideoSyncLab
 * Pure Node.js implementation - no Python dependency required
 * Uses onnxruntime-node for YOLO11m-seg inference
 */
const path = require('path');
const fs = require('fs');

const INPUT_SIZE = 640;
const CONF_THRESHOLD = 0.5;
const IOU_THRESHOLD = 0.45;

class ONNXSegmentationBridge {
    constructor() {
        this.session = null;
        this.ready = false;
        this.sharp = null;
        this.ort = null;
    }

    getModelPath() {
        const isDev = process.env.NODE_ENV === 'development' || __dirname.indexOf('app.asar') === -1;
        if (isDev) {
            return path.join(__dirname, 'Models', 'yolo11x_segment.onnx');
        } else {
            return path.join(process.resourcesPath, 'Models', 'yolo11x_segment.onnx');
        }
    }

    async init() {
        if (this.ready) return;

        try {
            this.ort = require('onnxruntime-node');
            this.sharp = require('sharp');
            const modelPath = this.getModelPath();

            console.log(`[ONNXSeg] Loading model: ${modelPath}`);

            if (!fs.existsSync(modelPath)) {
                throw new Error(`Model file not found: ${modelPath}`);
            }

            this.session = await this.ort.InferenceSession.create(modelPath);
            this.ready = true;
            console.log('[ONNXSeg] Model loaded successfully');
        } catch (error) {
            console.error('[ONNXSeg] Failed to load model:', error);
            throw error;
        }
    }

    /**
     * Letterbox resize - maintains aspect ratio with padding
     */
    async letterbox(buffer) {
        const image = this.sharp(buffer);
        const metadata = await image.metadata();
        const origW = metadata.width;
        const origH = metadata.height;

        const scale = Math.min(INPUT_SIZE / origW, INPUT_SIZE / origH);
        const newW = Math.round(origW * scale);
        const newH = Math.round(origH * scale);

        const padW = Math.floor((INPUT_SIZE - newW) / 2);
        const padH = Math.floor((INPUT_SIZE - newH) / 2);

        const resized = await this.sharp(buffer)
            .resize(newW, newH, { fit: 'fill' })
            .extend({
                top: padH,
                bottom: INPUT_SIZE - newH - padH,
                left: padW,
                right: INPUT_SIZE - newW - padW,
                background: { r: 114, g: 114, b: 114 }
            })
            .removeAlpha()
            .raw()
            .toBuffer();

        return { buffer: resized, scale, padW, padH, origW, origH };
    }

    /**
     * Preprocess image to model input format
     */
    async preprocess(buffer) {
        const { buffer: rawBuffer, scale, padW, padH, origW, origH } = await this.letterbox(buffer);

        // Convert to Float32, normalize [0-255] -> [0-1], HWC -> CHW
        const pixels = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);

        for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
            pixels[i] = rawBuffer[i * 3] / 255.0;
            pixels[INPUT_SIZE * INPUT_SIZE + i] = rawBuffer[i * 3 + 1] / 255.0;
            pixels[2 * INPUT_SIZE * INPUT_SIZE + i] = rawBuffer[i * 3 + 2] / 255.0;
        }

        return { tensor: pixels, scale, padW, padH, origW, origH };
    }

    /**
     * Convert xywh format to xyxy format
     */
    xywh2xyxy(boxes) {
        return boxes.map(box => ({
            x1: box.x - box.w / 2,
            y1: box.y - box.h / 2,
            x2: box.x + box.w / 2,
            y2: box.y + box.h / 2,
            confidence: box.confidence,
            maskCoeffs: box.maskCoeffs
        }));
    }

    /**
     * Non-Maximum Suppression
     */
    nms(boxes, iouThreshold = IOU_THRESHOLD) {
        if (boxes.length === 0) return [];

        const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
        const keep = [];

        while (sorted.length > 0) {
            const current = sorted.shift();
            keep.push(current);

            for (let i = sorted.length - 1; i >= 0; i--) {
                if (this.calculateIoU(current, sorted[i]) > iouThreshold) {
                    sorted.splice(i, 1);
                }
            }
        }

        return keep;
    }

    /**
     * Calculate Intersection over Union
     */
    calculateIoU(box1, box2) {
        const x1 = Math.max(box1.x1, box2.x1);
        const y1 = Math.max(box1.y1, box2.y1);
        const x2 = Math.min(box1.x2, box2.x2);
        const y2 = Math.min(box1.y2, box2.y2);

        const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
        const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
        const union = area1 + area2 - intersection;

        return union > 0 ? intersection / union : 0;
    }

    /**
     * Process YOLO detections
     * output0: [1, 116, 8400] - boxes(4) + classes(80) + mask_coeffs(32)
     */
    processDetections(data, dims) {
        const numDetections = dims[2];
        const detections = [];

        for (let i = 0; i < numDetections; i++) {
            const personScore = data[4 * numDetections + i];

            if (personScore > CONF_THRESHOLD) {
                const x = data[0 * numDetections + i];
                const y = data[1 * numDetections + i];
                const w = data[2 * numDetections + i];
                const h = data[3 * numDetections + i];

                const maskCoeffs = [];
                for (let j = 0; j < 32; j++) {
                    maskCoeffs.push(data[(84 + j) * numDetections + i]);
                }

                detections.push({ x, y, w, h, confidence: personScore, maskCoeffs });
            }
        }

        return detections;
    }

    /**
     * Generate segmentation mask
     */
    async generateMask(detection, protoData, protoDims, origW, origH, scale, padW, padH) {
        const protoH = protoDims[2];
        const protoW = protoDims[3];
        const numProtos = protoDims[1];

        // Bounding box in proto space (160x160)
        const bx1 = Math.max(0, Math.floor(detection.x1 / 4));
        const by1 = Math.max(0, Math.floor(detection.y1 / 4));
        const bx2 = Math.min(protoW, Math.ceil(detection.x2 / 4));
        const by2 = Math.min(protoH, Math.ceil(detection.y2 / 4));

        // Compute mask: coeffs @ protos -> [160, 160], clipped to bounding box
        const mask = new Float32Array(protoH * protoW);

        for (let y = 0; y < protoH; y++) {
            for (let x = 0; x < protoW; x++) {
                const i = y * protoW + x;

                // Only compute within bounding box
                if (x >= bx1 && x < bx2 && y >= by1 && y < by2) {
                    let sum = 0;
                    for (let j = 0; j < numProtos; j++) {
                        sum += detection.maskCoeffs[j] * protoData[j * protoH * protoW + i];
                    }
                    mask[i] = 1.0 / (1.0 + Math.exp(-sum));
                } else {
                    mask[i] = 0;
                }
            }
        }

        // Convert to 8-bit grayscale
        const mask8bit = Buffer.alloc(protoH * protoW);
        for (let i = 0; i < protoH * protoW; i++) {
            mask8bit[i] = Math.round(mask[i] * 255);
        }

        // Resize to 640x640
        const mask640 = await this.sharp(mask8bit, {
            raw: { width: protoW, height: protoH, channels: 1 }
        })
            .resize(INPUT_SIZE, INPUT_SIZE, { kernel: 'nearest' })
            .greyscale()
            .raw()
            .toBuffer();

        // Remove padding and resize to original size
        const scaledW = Math.min(INPUT_SIZE - padW, Math.round(origW * scale));
        const scaledH = Math.min(INPUT_SIZE - padH, Math.round(origH * scale));

        const croppedMask = await this.sharp(mask640, {
            raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 1 }
        })
            .extract({
                left: padW,
                top: padH,
                width: scaledW,
                height: scaledH
            })
            .resize(origW, origH, { kernel: 'cubic' })
            .greyscale()
            .raw()
            .toBuffer();

        // Apply threshold (0.3 * 255 = 76) and convert to PNG
        const binaryMask = Buffer.alloc(origW * origH);
        for (let i = 0; i < origW * origH; i++) {
            binaryMask[i] = croppedMask[i] > 76 ? 255 : 0;
        }

        return await this.sharp(binaryMask, {
            raw: { width: origW, height: origH, channels: 1 }
        })
            .png()
            .toBuffer();
    }

    /**
     * Main segmentation function
     */
    async segmentFrame(buffer) {
        if (!this.ready) {
            await this.init();
        }

        try {
            const { tensor, scale, padW, padH, origW, origH } = await this.preprocess(buffer);

            const inputTensor = new this.ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
            const results = await this.session.run({ images: inputTensor });

            const output0 = results.output0;
            const output1 = results.output1;

            if (!output0 || !output1) {
                return { success: false, error: 'No output from model' };
            }

            const rawDetections = this.processDetections(output0.data, output0.dims);

            if (rawDetections.length === 0) {
                return { success: false, error: 'No person detected' };
            }

            const xyxyDetections = this.xywh2xyxy(rawDetections);
            const nmsDetections = this.nms(xyxyDetections);

            if (nmsDetections.length === 0) {
                return { success: false, error: 'No person after NMS' };
            }

            // Select largest bounding box
            let bestDetection = nmsDetections[0];
            let maxArea = 0;
            for (const det of nmsDetections) {
                const area = (det.x2 - det.x1) * (det.y2 - det.y1);
                if (area > maxArea) {
                    maxArea = area;
                    bestDetection = det;
                }
            }

            const maskBuffer = await this.generateMask(
                bestDetection,
                output1.data,
                output1.dims,
                origW,
                origH,
                scale,
                padW,
                padH
            );

            return { success: true, mask: maskBuffer };

        } catch (error) {
            console.error('[ONNXSeg] Segmentation error:', error);
            return { success: false, error: error.message };
        }
    }

    stop() {
        this.session = null;
        this.ready = false;
    }
}

module.exports = ONNXSegmentationBridge;
