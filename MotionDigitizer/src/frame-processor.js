const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPathOriginal = require('ffmpeg-static');
let ffmpegPath = ffmpegPathOriginal;
if (ffmpegPath && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

// メッセージ受信ハンドラ
process.on('message', (msg) => {
    if (msg.command === 'extract') {
        extractFramesFFmpeg(msg.videoPath, msg.outputDir, msg.quality, msg.totalFrames);
    } else if (msg.command === 'exit') {
        process.exit(0);
    }
});

function extractFramesFFmpeg(videoPath, outputDir, quality, totalFrames) {
    try {
        // ディレクトリ作成
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // FFmpeg引数構築
        // -i: 入力ファイル
        // -start_number 1: 1から連番を開始 (frame_00001.jpgから)
        // -q:v 2: JPEG品質 (2-31, 小さいほど高品質。2は非常に高品質)
        // -y: 上書き許可
        // 出力ファイル名パターン: frame_%05d.jpg
        const args = [
            '-y',
            '-i', videoPath,
            '-vsync', '0',         // VFR動画対応: タイムスタンプ補正なしで全フレームを出力
            '-start_number', '1',
            '-q:v', '2',
            path.join(outputDir, 'frame_%05d.jpg')
        ];

        console.log('Starting FFmpeg:', ffmpegPath, args.join(' '));

        const ffmpeg = spawn(ffmpegPath, args);

        let lastPercent = -1;

        ffmpeg.stderr.on('data', (data) => {
            const output = data.toString();
            // console.log('FFmpeg stderr:', output);

            // frame= 123 のような出力をパース
            const frameMatch = output.match(/frame=\s*(\d+)/);
            if (frameMatch && totalFrames > 0) {
                const currentFrame = parseInt(frameMatch[1], 10);
                const percent = Math.min(100, Math.round((currentFrame / totalFrames) * 100));

                if (percent !== lastPercent) {
                    process.send({
                        type: 'progress',
                        current: currentFrame,
                        total: totalFrames,
                        percent: percent
                    });
                    lastPercent = percent;
                }
            }
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                // 完了マーカー作成
                const completeMarker = path.join(outputDir, '.complete');
                fs.writeFileSync(completeMarker, new Date().toISOString());

                process.send({
                    type: 'complete',
                    outputDir,
                    count: totalFrames // 実際にはパースした最後のフレーム数を返すべきだが、今回はtotalFramesとする
                });
            } else {
                process.send({ type: 'error', error: `FFmpeg exited with code ${code}` });
            }
        });

        ffmpeg.on('error', (err) => {
            process.send({ type: 'error', error: err.message });
        });

    } catch (e) {
        process.send({ type: 'error', error: e.message });
    }
}
