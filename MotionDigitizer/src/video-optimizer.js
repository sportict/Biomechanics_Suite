const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');

// FFmpegのパスを設定（electron-builderでパッケージ化された環境も考慮）
let ffmpegPath = ffmpegStatic;
if (process.env.NODE_ENV !== 'development') {
    // 本番環境ではパス調整が必要な場合があるが、ffmpeg-staticは通常うまく処理する
    ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
}
ffmpeg.setFfmpegPath(ffmpegPath);

class VideoOptimizer {
    constructor() {
        this.activeConversions = new Map(); // jobId -> command
    }

    /**
     * 動画をAll-Intra形式に変換（プロキシ生成）
     * @param {string} inputPath 入力ファイルパス
     * @param {string} outputDir 出力ディレクトリ（指定がなければ入力と同じ）
     * @param {function} onProgress 進捗コールバック (percent)
     * @returns {Promise<string>} 出力ファイルパス
     */
    async createProxy(inputPath, outputDir = null, onProgress = null) {
        if (!fs.existsSync(inputPath)) {
            throw new Error(`Input file not found: ${inputPath}`);
        }

        const dir = outputDir || path.dirname(inputPath);
        const ext = path.extname(inputPath);
        const name = path.basename(inputPath, ext);
        const outputPath = path.join(dir, `${name}_proxy.mp4`);

        return new Promise((resolve, reject) => {
            const command = ffmpeg(inputPath)
                .outputOptions([
                    '-c:v libx264',      // H.264コーデック
                    '-g 1',               // GOP=1 (All-Intra: 全フレームキーフレーム)
                    '-crf 23',            // 画質設定 (低いほど高品質、23は標準)
                    '-preset ultrafast',  // 変換速度優先
                    '-pix_fmt yuv420p',   // 互換性確保
                    '-y'                  // 上書き許可
                ])
                .on('start', (commandLine) => {
                    console.log('FFmpeg started:', commandLine);
                })
                .on('progress', (progress) => {
                    if (onProgress && progress.percent) {
                        onProgress(Math.round(progress.percent));
                    }
                })
                .on('end', () => {
                    console.log('FFmpeg conversion finished');
                    this.activeConversions.delete(inputPath);
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('FFmpeg conversion error:', err);
                    this.activeConversions.delete(inputPath);
                    reject(err);
                })
                .save(outputPath);

            this.activeConversions.set(inputPath, command);
        });
    }

    /**
     * 変換をキャンセル
     */
    cancel(inputPath) {
        if (this.activeConversions.has(inputPath)) {
            const command = this.activeConversions.get(inputPath);
            command.kill();
            this.activeConversions.delete(inputPath);
            return true;
        }
        return false;
    }
}

module.exports = new VideoOptimizer();
