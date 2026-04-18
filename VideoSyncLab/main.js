const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const ONNXSegmentationBridge = require('./onnx-segmentation');
const {
  buildMacAppMenu, buildQuitMenuItem,
  getIconPath: resolveIconPath,
  suppressChromiumLogs
} = require(app.isPackaged ? './shared/electron-utils' : '../shared/electron-utils');

// Chromium 内部の不要ログを抑制
suppressChromiumLogs();

let currentViewMode = 'single';
let mainWindow;
let lastSaveDirectory = null;  // 最後に保存したディレクトリを記憶

// === アイコンパス解決 ===
function getIconPath() {
    // 注: resolveIconPath を使うことで packaged/dev を自動判別
    return resolveIconPath(__dirname, 'VSL.png', 'VSL.ico');
}
// === FFmpegパス解決（asarUnpack版） ===
function resolveFfmpegPaths() {
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

    if (isDev) {
        return resolveDevPaths();
    }

    // Production strategies
    if (resolveProdPathMethod1()) return true;
    if (resolveProdPathMethod2()) return true;
    if (resolveProdPathMethod3()) return true;

    return false;
}

function resolveDevPaths() {
    try {
        if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
            ffmpeg.setFfmpegPath(ffmpegPath);
            ffmpeg.setFfprobePath(ffprobePath);
            return true;
        }
    } catch (error) {
        console.error('Dev path resolution failed:', error);
    }
    return false;
}

function resolveProdPathMethod1() {
    try {
        let resolvedFfmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
        let resolvedFfprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');

        if (fs.existsSync(resolvedFfmpegPath) && fs.existsSync(resolvedFfprobePath)) {
            ffmpeg.setFfmpegPath(resolvedFfmpegPath);
            ffmpeg.setFfprobePath(resolvedFfprobePath);
            return true;
        }
    } catch (error) {
        // Method 1 failed
    }
    return false;
}

function resolveProdPathMethod2() {
    try {
        const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked');
        const ffmpegRelative = path.relative(process.cwd(), ffmpegPath);
        const ffprobeRelative = path.relative(process.cwd(), ffprobePath);

        const constructedFfmpegPath = path.join(unpackedPath, ffmpegRelative);
        const constructedFfprobePath = path.join(unpackedPath, ffprobeRelative);

        if (fs.existsSync(constructedFfmpegPath) && fs.existsSync(constructedFfprobePath)) {
            ffmpeg.setFfmpegPath(constructedFfmpegPath);
            ffmpeg.setFfprobePath(constructedFfprobePath);
            return true;
        }
    } catch (error) {
        // Method 2 failed
    }
    return false;
}

function resolveProdPathMethod3() {
    try {
        const normalizedPlatform = process.platform;
        const arch = process.arch;
        const ffmpegExt = process.platform === 'win32' ? '.exe' : '';
        const ffprobeExt = process.platform === 'win32' ? '.exe' : '';

        const platformFfmpegPath = path.join(
            process.resourcesPath,
            'app.asar.unpacked',
            'node_modules',
            'ffmpeg-static',
            'bin',
            normalizedPlatform,
            arch,
            `ffmpeg${ffmpegExt}`
        );

        const platformFfprobePath = path.join(
            process.resourcesPath,
            'app.asar.unpacked',
            'node_modules',
            'ffprobe-static',
            'bin',
            normalizedPlatform,
            arch,
            `ffprobe${ffprobeExt}`
        );

        if (fs.existsSync(platformFfmpegPath) && fs.existsSync(platformFfprobePath)) {
            ffmpeg.setFfmpegPath(platformFfmpegPath);
            ffmpeg.setFfprobePath(platformFfprobePath);
            return true;
        }
    } catch (error) {
        // Method 3 failed
    }
    return false;
}

// === FFmpeg動作確認テスト ===
function testFFmpegOperation() {
    return new Promise((resolve) => {
        try {
            const testCommand = ffmpeg();
            testCommand.getAvailableFormats((err, formats) => {
                resolve(!err);
            });
        } catch (error) {
            resolve(false);
        }
    });
}

// === 設定定数 ===
const CONFIG = {
    WINDOW: {
        SINGLE: { width: 900, height: 700 },
        DUAL: { width: 1200, height: 700 }
    },
    APP: {
        NAME: 'VideoSyncLab',
        VERSION: '1.3.0',
        DESCRIPTION: 'Electronベースの二画面動画同期編集アプリケーション'
    },
    FFMPEG: {
        ENCODING: {
            preset: 'superfast',
            crf: '23',
            threads: '0',
            movflags: '+faststart'
        },
        HIGH_SPEED: {
            outputFPS: '30',
            vsync: '0'
        },
        NORMAL: {
            vsync: '1'
        },
        FAST_CUT: {
            videoCodec: 'copy',
            audioCodec: 'copy',
            options: ['-avoid_negative_ts', 'make_zero', '-map_metadata', '0']
        },
        FRAME_SEQUENCE: {
            quality: '5',
            vsync: '0'
        }
    },
    TIMEOUTS: {
        FFPROBE: 15000
    },
    FILE_FILTERS: {
        VIDEO: [
            { name: '動画ファイル', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm', 'flv', 'm4v'] },
            { name: 'すべてのファイル', extensions: ['*'] }
        ],
        OUTPUT_VIDEO: [
            { name: 'MP4動画 (推奨)', extensions: ['mp4'] },
            { name: 'AVI動画', extensions: ['avi'] }
        ]
    }
};

// === ユーティリティクラス ===
class WindowManager {
    static createWindow() {
        const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
        const shouldOpenDevTools = process.argv.includes('--dev-tools') || process.argv.includes('--debug');

        mainWindow = new BrowserWindow({
            ...CONFIG.WINDOW.SINGLE,
            center: true,
            icon: getIconPath(),
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                webSecurity: false
            },
            title: CONFIG.APP.NAME,
            backgroundColor: '#2b2b2b',
            show: false
        });

        const { width, height } = CONFIG.WINDOW.SINGLE; // Get width and height from config
        mainWindow.setSize(width, height);
        mainWindow.center();

        mainWindow.loadFile('index.html');

        mainWindow.once('ready-to-show', () => {
            mainWindow.show();

            // 起動引数解析
            const args = process.argv;
            let initialFile = null;
            let isProjectFile = false;

            // データパスの取得
            const dataPathArg = args.find(arg => arg.startsWith('--data-path='));
            if (dataPathArg) {
                global.projectDataPath = dataPathArg.split('=')[1];
                console.log('Project Data Path:', global.projectDataPath);
            }

            for (let i = 1; i < args.length; i++) {
                const arg = args[i];
                if (arg && arg !== '.' && !arg.startsWith('-')) {
                    const ext = path.extname(arg).toLowerCase();
                    if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext) && fs.existsSync(arg)) {
                        initialFile = arg;
                        isProjectFile = false;
                        break;
                    }
                    if (ext === '.vsl' && fs.existsSync(arg)) {
                        initialFile = arg;
                        isProjectFile = true;
                        break;
                    }
                }
            }

            // open-file イベントで保留されたファイルを優先
            if (!initialFile && pendingOpenFile) {
                initialFile = pendingOpenFile.path;
                isProjectFile = pendingOpenFile.isProject;
                pendingOpenFile = null;
            }

            if (initialFile) {
                console.log('Auto-opening file from args:', initialFile);
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        if (isProjectFile) {
                            mainWindow.webContents.send('load-project', initialFile);
                        } else {
                            mainWindow.webContents.send('load-video', {
                                side: 'left',
                                path: initialFile
                            });
                        }
                    }
                }, 1500);
            }
        });

        if (shouldOpenDevTools) {
            mainWindow.webContents.openDevTools();
        }

        currentViewMode = 'single';
        MenuManager.createMenu();
    }

    static resizeForMode(mode) {
        if (!mainWindow) return;

        const { width, height } = CONFIG.WINDOW[mode.toUpperCase()];
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

        const newX = Math.round((screenWidth - width) / 2);
        const newY = Math.round((screenHeight - height) / 2);

        mainWindow.setBounds({ x: newX, y: newY, width, height }, false);
    }

    static openManualWindow() {
        const manualPath = path.join(__dirname, 'doc', 'manual.html');
        if (fs.existsSync(manualPath)) {
            const manualWindow = new BrowserWindow({
                width: 1100,
                height: 800,
                minWidth: 800,
                minHeight: 600,
                backgroundColor: '#1a1a2e',
                title: 'VideoSyncLab マニュアル',
                icon: getIconPath(),
                webPreferences: {
                    contextIsolation: true,
                    nodeIntegration: false
                }
            });
            manualWindow.loadFile(manualPath);
            return { success: true };
        } else {
            return { success: false, error: 'マニュアルファイルが見つかりません' };
        }
    }
}

class MenuManager {
    static createMenu() {
        const template = [
            ...buildMacAppMenu(),
            {
                label: 'ファイル',
                submenu: [
                    { label: 'プロジェクトを開く...', accelerator: 'CmdOrCtrl+O', click: () => { mainWindow.webContents.send('project-open'); } },
                    { label: 'プロジェクトを閉じる', accelerator: 'CmdOrCtrl+W', click: () => { mainWindow.webContents.send('close-video'); } },
                    { type: 'separator' },
                    { label: '上書き保存', accelerator: 'CmdOrCtrl+S', click: () => { mainWindow.webContents.send('project-save'); } },
                    { type: 'separator' },
                    { label: '動画1を開く', accelerator: 'CmdOrCtrl+1', click: () => { mainWindow.webContents.send('open-video', 'left'); } },
                    { label: '動画2を開く', accelerator: 'CmdOrCtrl+2', click: () => { mainWindow.webContents.send('open-video', 'right'); } },
                    { type: 'separator' },
                    { label: '動画1を最適化して再読込', click: () => { mainWindow.webContents.send('optimize-and-reload', 'left'); } },
                    { label: '動画2を最適化して再読込', click: () => { mainWindow.webContents.send('optimize-and-reload', 'right'); } },
                    { type: 'separator' },
                    ...buildQuitMenuItem(() => { if (mainWindow) mainWindow.close(); })
                ]
            },
            {
                label: '表示',
                submenu: [
                    {
                        label: '一画面表示',
                        type: 'radio',
                        checked: currentViewMode === 'single',
                        click: () => {
                            currentViewMode = 'single';
                            mainWindow.webContents.send('switch-view', 'single');
                            WindowManager.resizeForMode('single');
                            MenuManager.createMenu();
                        }
                    },
                    {
                        label: '二画面表示',
                        type: 'radio',
                        checked: currentViewMode === 'dual',
                        click: () => {
                            currentViewMode = 'dual';
                            mainWindow.webContents.send('switch-view', 'dual');
                            WindowManager.resizeForMode('dual');
                            MenuManager.createMenu();
                        }
                    }
                ]
            },
            {
                label: 'ヘルプ',
                submenu: [
                    {
                        label: '開発者ツールを開く',
                        click: () => {
                            const { BrowserWindow } = require('electron');
                            const win = BrowserWindow.getFocusedWindow();
                            if (win) win.webContents.openDevTools();
                        }
                    }
                ]
            }
        ];

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
    }
}

class FileDialogManager {
    static async openVideoFile(side) {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: `動画ファイルを開く（${side === 'left' ? '左' : '右'}）`,
            properties: ['openFile'],
            filters: CONFIG.FILE_FILTERS.VIDEO
        });

        if (!result.canceled && result.filePaths.length > 0) {
            mainWindow.webContents.send('load-video', {
                side: side,
                path: result.filePaths[0]
            });
        }
    }
}

// === PreciseFrameProcessor クラス（厳密なフレーム処理） ===
class PreciseFrameProcessor {
    static frameToFFmpegIndex(frameNumber) {
        return Math.max(0, frameNumber - 1);
    }

    static validateFrameRange(startFrame, endFrame, totalFrames) {
        if (!startFrame || !endFrame || !totalFrames) {
            return { valid: false, message: 'フレーム情報が不完全です' };
        }

        if (startFrame < 1 || endFrame < 1) {
            return { valid: false, message: 'フレーム番号は1以上である必要があります' };
        }

        if (startFrame > totalFrames || endFrame > totalFrames) {
            return { valid: false, message: 'フレーム番号が動画の範囲外です' };
        }

        if (startFrame >= endFrame) {
            return { valid: false, message: '開始フレームは終了フレームより小さい必要があります' };
        }

        return { valid: true };
    }

    static calculateFrameCount(startFrame, endFrame) {
        return endFrame - startFrame + 1;
    }

    static getHighPrecisionTime(frameNumber, fps) {
        return (frameNumber - 1) / fps;
    }
}

// === FFmpeg処理クラス ===
class FFmpegProcessor {
    static createCommand(inputPath) {
        try {
            const env = validateFFmpegEnvironment();
            if (!env.success) {
                throw new Error(env.reason || 'FFmpeg初期化に失敗しました');
            }

            if (!fs.existsSync(inputPath)) {
                throw new Error(`入力ファイルが見つかりません: ${inputPath}`);
            }

            return ffmpeg(inputPath);
        } catch (error) {
            const errorMessage = error.message || error.toString() || 'Unknown FFmpeg error';
            throw new Error(`FFmpegコマンドの作成に失敗しました: ${errorMessage}`);
        }
    }

    static getEncodingOptions(isHighSpeed = false) {
        const baseOptions = [
            '-preset', CONFIG.FFMPEG.ENCODING.preset,
            '-crf', CONFIG.FFMPEG.ENCODING.crf,
            '-movflags', CONFIG.FFMPEG.ENCODING.movflags,
            '-threads', CONFIG.FFMPEG.ENCODING.threads
        ];

        if (isHighSpeed) {
            return [
                '-r', CONFIG.FFMPEG.HIGH_SPEED.outputFPS,
                '-vsync', CONFIG.FFMPEG.HIGH_SPEED.vsync,
                ...baseOptions
            ];
        } else {
            return [
                ...baseOptions,
                '-vsync', CONFIG.FFMPEG.NORMAL.vsync
            ];
        }
    }

    static setupProgressHandling(command, operation, duration) {
        command.on('start', (commandLine) => {
            ProgressManager.updateProgress(operation === 'cut' ? 10 : 3, `${operation}開始...`);
        });

        command.on('progress', (progress) => {
            const percent = ProgressCalculator.calculate(progress, duration, operation);
            const message = ProgressManager.getProgressMessage(operation, percent, progress.currentFps);
            ProgressManager.updateProgress(percent, message);
        });

        return command;
    }

    static setupErrorHandling(command, operation, reject) {
        command.on('error', (err) => {
            FFmpegErrorHandler.handle(err, operation, reject);
        });
        return command;
    }
}

class ProgressCalculator {
    static calculate(progress, totalDuration, operation) {
        if (progress.timemark) {
            return this.fromTimemark(progress.timemark, totalDuration);
        }

        if (progress.frames && operation === 'frame-sequence') {
            return Math.min(95, Math.round((progress.frames / (totalDuration * 30)) * 90 + 5));
        }

        return Math.round(progress.percent || 0);
    }

    static fromTimemark(timemark, totalDuration) {
        if (!timemark) return 0;

        const [hours, minutes, seconds] = timemark.split(':').map((v, i) =>
            i < 2 ? parseInt(v) : parseFloat(v)
        );

        const processedSeconds = hours * 3600 + minutes * 60 + seconds;
        return Math.min(100, Math.round((processedSeconds / totalDuration) * 100));
    }
}

class ProgressManager {
    static updateProgress(percent, message) {
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('trim-progress', { progress: percent, message });
        }
    }

    static getProgressMessage(operation, percent, currentFps = 0) {
        const messages = {
            'cut': `スマートカット中... ${percent}%`,
            'encode': `処理中... ${percent}% (${currentFps || 0}fps)`,
            'frame-sequence': `フレーム抽出中... ${percent}%`,
            'frame-save': `フレーム保存中...`
        };

        return messages[operation] || `処理中... ${percent}%`;
    }
}

// === キーフレーム解析 ===
class KeyframeAnalyzer {
    /**
     * 指定動画のキーフレーム時刻（秒）リストを昇順で返す
     * ffprobe 公式オプション:
     * -skip_frame nokey -show_entries frame=pkt_pts_time -of csv=p=0
     */
    static async getKeyframesSeconds(inputPath) {
        return new Promise((resolve, reject) => {
            const args = [
                '-loglevel', 'error',
                '-select_streams', 'v:0',
                '-skip_frame', 'nokey',
                '-show_entries', 'frame=pkt_pts_time',
                '-of', 'csv=p=0',
                inputPath
            ];

            const { execFile } = require('child_process');

            execFile(ffprobePath, args, (error, stdout, stderr) => {
                if (error) {
                    return reject(new Error(`ffprobeエラー: ${stderr || error.message}`));
                }

                const lines = stdout
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);

                const keyframes = lines
                    .map((v) => parseFloat(v))
                    .filter((v) => Number.isFinite(v))
                    .sort((a, b) => a - b);

                resolve(keyframes);
            });
        });
    }
}

// === Smart Cut（部分再エンコード高速カット） ===
class SmartCutProcessor {
    static async executeSmartCut(data) {
        const { inputPath, outputPath, startFrame, endFrame, fps } = data;

        const validation = ValidationService.validateTrimData(data);
        if (!validation.success) {
            throw new Error(validation.reason);
        }

        // フレーム → 秒
        const startSec = (startFrame - 1) / fps;
        const endSec = endFrame / fps;

        if (endSec <= startSec) {
            throw new Error('カット範囲が不正です');
        }

        // キーフレーム取得
        const keyframes = await KeyframeAnalyzer.getKeyframesSeconds(inputPath);
        if (!keyframes.length) {
            // キーフレームが取得できない環境では従来方式にフォールバック
            return await TrimProcessor.executeFastCut(data);
        }

        // T1/T2 周辺のキーフレーム
        const nextKfAfterStart = keyframes.find((t) => t >= startSec) ?? endSec;
        const prevKfBeforeEnd = [...keyframes].reverse().find((t) => t <= endSec) ?? startSec;

        // Head / Middle / Tail の時間範囲
        const headStart = startSec;
        const headEnd = Math.min(nextKfAfterStart, endSec);
        const middleStart = headEnd;
        const middleEnd = prevKfBeforeEnd;
        const tailStart = Math.max(middleEnd, headEnd);
        const tailEnd = endSec;

        const segments = [];
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videosynclab_smartcut_'));
        const crypto = require('crypto');
        const makeTmp = (name) => path.join(tmpDir, `${name}_${crypto.randomBytes(8).toString('hex')}.mp4`);

        // Head: 再エンコード
        if (headEnd > headStart + 1 / fps) {
            const headPath = makeTmp('head');
            await this.encodeSegment(inputPath, headStart, headEnd - headStart, headPath, { reencode: true });
            segments.push(headPath);
        }

        // Middle: ストリームコピー
        if (middleEnd > middleStart + 1 / fps) {
            const midPath = makeTmp('middle');
            await this.encodeSegment(inputPath, middleStart, middleEnd - middleStart, midPath, { copy: true });
            segments.push(midPath);
        }

        // Tail: 再エンコード
        if (tailEnd > tailStart + 1 / fps) {
            const tailPath = makeTmp('tail');
            await this.encodeSegment(inputPath, tailStart, tailEnd - tailStart, tailPath, { reencode: true });
            segments.push(tailPath);
        }

        // セグメントが1つもない場合はフォールバック
        if (!segments.length) {
            return await TrimProcessor.executeFastCut(data);
        }

        // concat 用 filelist 作成
        const listPath = path.join(tmpDir, 'filelist.txt');
        const listContent = segments
            .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
            .join('\n');
        fs.writeFileSync(listPath, listContent, 'utf8');

        // concat 実行
        await this.concatSegments(listPath, outputPath);

        // 一時ファイル削除
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
            // クリーンアップ失敗は無視
        }

        return { success: true, message: '高速カットが完了しました（Smart Cut）' };
    }

    static async encodeSegment(inputPath, start, duration, outputPath, options) {
        return new Promise((resolve, reject) => {
            const command = ffmpeg(inputPath)
                .inputOptions([
                    '-ss', start.toFixed(6)
                ])
                .outputOptions(
                    options.copy
                        ? [
                            '-t', duration.toFixed(6),
                            '-c', 'copy',
                            '-avoid_negative_ts', 'make_zero'
                        ]
                        : [
                            '-t', duration.toFixed(6),
                            '-c:v', 'libx264',
                            '-preset', 'veryfast',
                            '-crf', '18',
                            '-c:a', 'aac',
                            '-avoid_negative_ts', 'make_zero'
                        ]
                )
                .on('start', () => {
                    ProgressManager.updateProgress(5, 'Smart Cut セグメント処理中...');
                })
                .on('progress', (progress) => {
                    const percent = Math.min(95, Math.round(progress.percent || 0));
                    ProgressManager.updateProgress(percent, 'Smart Cut セグメント処理中...');
                })
                .on('error', (err) => {
                    reject(new Error(`Smart Cut セグメント処理エラー: ${err.message}`));
                })
                .on('end', () => {
                    resolve();
                });

            command.save(outputPath);
        });
    }

    static async concatSegments(listPath, outputPath) {
        return new Promise((resolve, reject) => {
            const command = ffmpeg()
                .input(listPath)
                .inputOptions([
                    '-f', 'concat',
                    '-safe', '0'
                ])
                .outputOptions([
                    '-c', 'copy'
                ])
                .on('start', () => {
                    ProgressManager.updateProgress(90, 'Smart Cut 結合中...');
                })
                .on('error', (err) => {
                    reject(new Error(`Smart Cut 結合エラー: ${err.message}`));
                })
                .on('end', () => {
                    ProgressManager.updateProgress(100, 'Smart Cut 完了');
                    resolve();
                });

            command.save(outputPath);
        });
    }
}

class FFmpegErrorHandler {
    static handle(err, operationType, reject) {
        ProgressManager.updateProgress(-1, 'エラーが発生しました');
        reject('処理に失敗しました');
    }
}

// === 動画情報取得の最適化 ===
class VideoInfoProcessor {
    static async getVideoInfo(filePath) {
        if (!this.validateFileExists(filePath)) {
            return { success: false, error: 'File does not exist' };
        }

        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                resolve({ success: false, error: 'FFprobe timeout' });
            }, 30000);

            ffmpeg.ffprobe(filePath, (err, metadata) => {
                clearTimeout(timeoutId);

                if (err) {
                    resolve({ success: false, error: `FFprobe error: ${err.message}` });
                    return;
                }

                try {
                    const videoInfo = this.processMetadata(metadata);
                    resolve(videoInfo);
                } catch (parseError) {
                    resolve({ success: false, error: 'Failed to parse video metadata: ' + parseError.message });
                }
            });
        });
    }

    static validateFileExists(filePath) {
        try {
            return require('fs').existsSync(filePath);
        } catch (fsError) {
            return false;
        }
    }

    static processMetadata(metadata) {
        if (!metadata || !metadata.streams) {
            throw new Error('No streams found');
        }

        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        if (!videoStream) {
            throw new Error('No video stream found');
        }

        const fps = this.calculateFPS(videoStream);
        const duration = parseFloat(metadata.format.duration) || 0;
        const totalFrames = videoStream.nb_frames ?
            parseInt(videoStream.nb_frames) :
            Math.floor(duration * fps);

        return {
            success: true,
            fps: Math.round(fps * 100) / 100,
            duration: duration,
            totalFrames: totalFrames,
            width: videoStream.width || 0,
            height: videoStream.height || 0,
            codec: videoStream.codec_name || 'unknown'
        };
    }

    static calculateFPS(videoStream) {
        let fps = 30;

        if (videoStream.r_frame_rate && videoStream.r_frame_rate !== '0/0') {
            const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
            if (den && den !== 0) {
                fps = num / den;
            }
        } else if (videoStream.avg_frame_rate && videoStream.avg_frame_rate !== '0/0') {
            const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
            if (den && den !== 0) {
                fps = num / den;
            }
        }

        return fps;
    }
}

// === 事前チェック関数 ===
function validateFFmpegEnvironment() {
    try {
        const ffmpegResolved = resolveFfmpegPaths();
        if (!ffmpegResolved) {
            return { success: false, reason: 'FFmpegパス解決に失敗しました' };
        }
        return { success: true };
    } catch (error) {
        return { success: false, reason: `FFmpeg初期化エラー: ${error.message || 'Unknown error'}` };
    }
}

// === バリデーションサービス ===
class ValidationService {
    static validatePaths(inputPath, outputPath) {
        if (!fs.existsSync(inputPath)) {
            return { success: false, reason: '入力ファイルが見つかりません' };
        }

        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            return { success: false, reason: '出力ディレクトリが存在しません' };
        }

        return { success: true };
    }

    static validateFrameData(startFrame, endFrame, fps) {
        if (!startFrame || !endFrame || !fps) {
            return { success: false, reason: 'フレームデータが不正です' };
        }

        if (startFrame >= endFrame) {
            return { success: false, reason: 'フレーム範囲が不正です' };
        }

        return { success: true };
    }

    static validateTrimData(data) {
        const { inputPath, outputPath, startFrame, endFrame, fps, totalFrames } = data;

        const pathValidation = this.validatePaths(inputPath, outputPath);
        if (!pathValidation.success) return pathValidation;

        const frameValidation = PreciseFrameProcessor.validateFrameRange(startFrame, endFrame, totalFrames);
        if (!frameValidation.valid) return { success: false, reason: frameValidation.message };

        return { success: true };
    }
}

// === FFmpegコマンドビルダー ===
class FFmpegCommandBuilder {
    static createFastCutCommand(data) {
        const { inputPath, startFrame, endFrame, fps } = data;

        const ffmpegStartFrame = PreciseFrameProcessor.frameToFFmpegIndex(startFrame);
        const ffmpegEndFrame = PreciseFrameProcessor.frameToFFmpegIndex(endFrame);

        // 時間ベースでトリミング位置を計算（音声用）
        const t0 = (startFrame - 1) / fps;
        const dur = (endFrame - startFrame + 1) / fps;

        return ffmpeg(inputPath)
            .outputOptions([
                '-vf', `select='gte(n\\,${ffmpegStartFrame})*lte(n\\,${ffmpegEndFrame})',setpts=N/FRAME_RATE/TB`,
                '-af', `atrim=start=${t0.toFixed(8)}:duration=${dur.toFixed(8)},asetpts=N/SR/TB,aresample=async=1:first_pts=0`,
                '-vsync', '0',
                '-avoid_negative_ts', 'make_zero',
                '-c:v', 'libx264',
                '-c:a', 'aac',
                '-g', '1',               // GOP=1: 全フレームキーフレーム（編集耐性とシーク精度向上）
                '-preset', 'fast',
                '-crf', '12',            // 高画質設定（数値が低いほど高品質、18→12へ変更）
                '-max_muxing_queue_size', Math.max(1024, Math.round(fps * 50)).toString(),
                '-threads', '0'
            ]);
    }

    static createEncodeCommand(data) {
        const { inputPath, startFrame, endFrame, fps, outputFormat } = data; // fpsに統一

        const isHighSpeed = fps > 60;
        const slowFactor = isHighSpeed ? fps / 30 : 1;

        if (isHighSpeed) {
            // High Speed (>60fps) はスローモーション化が必要なため独自処理
            const ffmpegStartFrame = PreciseFrameProcessor.frameToFFmpegIndex(startFrame);
            const ffmpegEndFrame = PreciseFrameProcessor.frameToFFmpegIndex(endFrame);

            return ffmpeg(inputPath)
                .outputOptions([
                    '-vf', `select='gte(n\\,${ffmpegStartFrame})*lte(n\\,${ffmpegEndFrame})',setpts=N/FRAME_RATE/TB,setpts=${slowFactor}*PTS`,
                    '-r', '30',
                    '-fps_mode', 'cfr',
                    '-an',                      // 音声削除
                    '-c:v', 'libx264',
                    '-g', '1',
                    '-preset', 'veryfast',      // 高速化
                    '-crf', '23',
                    '-max_muxing_queue_size', Math.max(1024, Math.round(fps * 50)).toString(),
                    '-threads', '0'
                ])
                .noAudio()
                .format(outputFormat);
        } else {
            // 通常速度
            const ffmpegStartFrame = PreciseFrameProcessor.frameToFFmpegIndex(startFrame);
            const ffmpegEndFrame = PreciseFrameProcessor.frameToFFmpegIndex(endFrame);

            // 時間ベースでトリミング位置を計算（音声用）
            const t0 = (startFrame - 1) / fps;
            const dur = (endFrame - startFrame + 1) / fps;

            return ffmpeg(inputPath)
                .outputOptions([
                    // スマートカットと同じオプション構成（CRFのみ変更）
                    '-vf', `select='gte(n\\,${ffmpegStartFrame})*lte(n\\,${ffmpegEndFrame})',setpts=N/FRAME_RATE/TB`,
                    '-af', `atrim=start=${t0.toFixed(8)}:duration=${dur.toFixed(8)},asetpts=N/SR/TB,aresample=async=1:first_pts=0`,
                    '-vsync', '0',
                    '-avoid_negative_ts', 'make_zero',
                    '-c:v', 'libx264',
                    '-c:a', 'aac',
                    '-g', '1',
                    '-preset', 'fast',
                    '-crf', '23',            // 再エンコード用標準画質
                    '-max_muxing_queue_size', Math.max(1024, Math.round(fps * 50)).toString(),
                    '-threads', '0'
                ])
                .format(outputFormat);
        }
    }
}

// === トリミング処理の統合 ===
class TrimProcessor {
    // 音声トラックの存在チェック
    static async hasAudioTrack(inputPath) {
        return new Promise((resolve) => {
            ffmpeg.ffprobe(inputPath, (err, metadata) => {
                if (err) {
                    console.warn('ffprobe error (assuming no audio):', err.message);
                    resolve(false);
                    return;
                }
                const audioStream = metadata.streams?.find(s => s.codec_type === 'audio');
                resolve(!!audioStream);
            });
        });
    }

    static async executeFastCut(data) {
        try {
            let { inputPath, outputPath, startFrame, endFrame, fps } = data;

            if (!fs.existsSync(inputPath)) {
                throw new Error('入力ファイルが見つかりません');
            }

            const ext = path.extname(inputPath);
            // outputPathが指定されていない場合のみ自動生成
            if (!outputPath) {
                const basename = path.basename(inputPath, ext);
                const dir = path.dirname(inputPath);
                outputPath = path.join(dir, `${basename}_cut${ext}`);
                let counter = 1;

                while (fs.existsSync(outputPath)) {
                    outputPath = path.join(dir, `${basename}_cut${counter}${ext}`);
                    counter++;
                }
            }

            // ★ 音声トラックの存在チェック
            const hasAudio = await this.hasAudioTrack(inputPath);
            console.log(`Audio track detected: ${hasAudio}`);

            // ★ スマートカット: 映像と音声を分離エンコードして結合（PTS 0.000確保のため）
            const startSec = (startFrame - 1) / fps;
            const duration = (endFrame - startFrame + 1) / fps;

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videosynclab_cut_'));
            const crypto = require('crypto');
            const videoTmp = path.join(tmpDir, `video_${crypto.randomBytes(4).toString('hex')}.mp4`);
            const audioTmp = path.join(tmpDir, `audio_${crypto.randomBytes(4).toString('hex')}.m4a`);

            try {
                ProgressManager.updateProgress(10, `スマートカット開始... (${fps}fps)`);

                // Step 1: 映像のみエンコード
                await new Promise((resolve, reject) => {
                    ffmpeg(inputPath)
                        .inputOptions(['-ss', startSec.toFixed(6)])
                        .outputOptions([
                            '-t', duration.toFixed(6),
                            '-an',
                            '-c:v', 'libx264',
                            '-avoid_negative_ts', 'make_zero',
                            '-g', '1',
                            '-preset', 'fast',
                            '-crf', '12',
                            '-max_muxing_queue_size', Math.max(1024, Math.round(fps * 50)).toString()
                        ])
                        .on('progress', (progress) => {
                            const percent = hasAudio
                                ? Math.min(40, 10 + Math.round((progress.percent || 0) * 0.3))
                                : Math.min(90, 10 + Math.round((progress.percent || 0) * 0.8));
                            ProgressManager.updateProgress(percent, `スマートカット中（映像）... ${percent}%`);
                        })
                        .on('error', reject)
                        .on('end', resolve)
                        .save(videoTmp);
                });

                // 音声トラックがある場合のみ音声処理
                if (hasAudio) {
                    // Step 2: 音声のみエンコード
                    await new Promise((resolve, reject) => {
                        ffmpeg(inputPath)
                            .inputOptions(['-ss', startSec.toFixed(6)])
                            .outputOptions([
                                '-t', duration.toFixed(6),
                                '-vn',
                                '-c:a', 'aac',
                                '-avoid_negative_ts', 'make_zero'
                            ])
                            .on('progress', (progress) => {
                                const percent = Math.min(70, 45 + Math.round((progress.percent || 0) * 0.25));
                                ProgressManager.updateProgress(percent, `スマートカット中（音声）... ${percent}%`);
                            })
                            .on('error', reject)
                            .on('end', resolve)
                            .save(audioTmp);
                    });

                    ProgressManager.updateProgress(75, '映像と音声を結合中...');

                    // Step 3: 映像と音声を結合
                    await new Promise((resolve, reject) => {
                        ffmpeg()
                            .input(videoTmp)
                            .input(audioTmp)
                            .outputOptions([
                                '-c', 'copy',
                                '-map', '0:v:0',
                                '-map', '1:a:0',
                                '-shortest'
                            ])
                            .on('progress', (progress) => {
                                const percent = Math.min(95, 75 + Math.round((progress.percent || 0) * 0.2));
                                ProgressManager.updateProgress(percent, `結合中... ${percent}%`);
                            })
                            .on('error', reject)
                            .on('end', resolve)
                            .save(outputPath);
                    });
                } else {
                    // 音声なし: 映像ファイルをそのままコピー
                    ProgressManager.updateProgress(90, '映像ファイルを出力中...');
                    fs.copyFileSync(videoTmp, outputPath);
                }

                if (fs.existsSync(outputPath)) {
                    const audioStatus = hasAudio ? '' : '（音声なし）';
                    ProgressManager.updateProgress(100, `スマートカット完了 (${fps}fps)${audioStatus}`);
                    return { success: true, message: `スマートカットが完了しました${audioStatus}` };
                } else {
                    throw new Error('出力ファイルが作成されませんでした');
                }

            } finally {
                // クリーンアップ
                try {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                } catch (e) {
                    // ignore
                }
            }

        } catch (error) {
            console.error('FastCut error:', error);
            ProgressManager.updateProgress(-1, 'エラーが発生しました');
            throw error;
        }
    }

    static async executeEncode(data) {
        try {
            const { inputPath, outputPath, startFrame, endFrame, inputFPS } = data;

            const validation = ValidationService.validatePaths(inputPath, outputPath);
            if (!validation.success) throw new Error(validation.reason);

            if (startFrame === undefined || endFrame === undefined || !inputFPS) {
                throw new Error('トリミング範囲またはFPSが設定されていません');
            }

            const isHighSpeed = inputFPS > 60;

            // 高速動画は従来通り（音声なし）
            if (isHighSpeed) {
                return await this.executeEncodeHighSpeed(data);
            }

            // ★ 音声トラックの存在チェック
            const hasAudio = await this.hasAudioTrack(inputPath);
            console.log(`Audio track detected for encode: ${hasAudio}`);

            // ★ 通常速度: 映像と音声を分離エンコードして結合
            const startSec = (startFrame - 1) / inputFPS;
            const duration = (endFrame - startFrame + 1) / inputFPS;

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videosynclab_encode_'));
            const crypto = require('crypto');
            const videoTmp = path.join(tmpDir, `video_${crypto.randomBytes(4).toString('hex')}.mp4`);
            const audioTmp = path.join(tmpDir, `audio_${crypto.randomBytes(4).toString('hex')}.m4a`);

            try {
                ProgressManager.updateProgress(10, 'エンコード開始（映像）...');

                // Step 1: 映像のみエンコード
                await new Promise((resolve, reject) => {
                    ffmpeg(inputPath)
                        .inputOptions(['-ss', startSec.toFixed(6)])
                        .outputOptions([
                            '-t', duration.toFixed(6),
                            '-an',
                            '-c:v', 'libx264',
                            '-avoid_negative_ts', 'make_zero',
                            '-g', '1',
                            '-preset', 'fast',
                            '-crf', '23',
                            '-max_muxing_queue_size', Math.max(1024, Math.round(inputFPS * 50)).toString()
                        ])
                        .on('progress', (progress) => {
                            const percent = hasAudio
                                ? Math.min(40, 10 + Math.round((progress.percent || 0) * 0.3))
                                : Math.min(90, 10 + Math.round((progress.percent || 0) * 0.8));
                            ProgressManager.updateProgress(percent, `映像エンコード中... ${percent}%`);
                        })
                        .on('error', reject)
                        .on('end', resolve)
                        .save(videoTmp);
                });

                // 音声トラックがある場合のみ音声処理
                if (hasAudio) {
                    ProgressManager.updateProgress(45, 'エンコード開始（音声）...');

                    // Step 2: 音声のみエンコード
                    await new Promise((resolve, reject) => {
                        ffmpeg(inputPath)
                            .inputOptions(['-ss', startSec.toFixed(6)])
                            .outputOptions([
                                '-t', duration.toFixed(6),
                                '-vn',
                                '-c:a', 'aac',
                                '-avoid_negative_ts', 'make_zero'
                            ])
                            .on('progress', (progress) => {
                                const percent = Math.min(70, 45 + Math.round((progress.percent || 0) * 0.25));
                                ProgressManager.updateProgress(percent, `音声エンコード中... ${percent}%`);
                            })
                            .on('error', reject)
                            .on('end', resolve)
                            .save(audioTmp);
                    });

                    ProgressManager.updateProgress(75, '映像と音声を結合中...');

                    // Step 3: 映像と音声を結合
                    await new Promise((resolve, reject) => {
                        ffmpeg()
                            .input(videoTmp)
                            .input(audioTmp)
                            .outputOptions([
                                '-c', 'copy',
                                '-map', '0:v:0',
                                '-map', '1:a:0',
                                '-shortest'
                            ])
                            .on('progress', (progress) => {
                                const percent = Math.min(95, 75 + Math.round((progress.percent || 0) * 0.2));
                                ProgressManager.updateProgress(percent, `結合中... ${percent}%`);
                            })
                            .on('error', reject)
                            .on('end', resolve)
                            .save(outputPath);
                    });
                } else {
                    // 音声なし: 映像ファイルをそのままコピー
                    ProgressManager.updateProgress(90, '映像ファイルを出力中...');
                    fs.copyFileSync(videoTmp, outputPath);
                }

                const audioStatus = hasAudio ? '' : '（音声なし）';
                ProgressManager.updateProgress(100, `再エンコード完了${audioStatus}`);

                return {
                    success: true,
                    message: `再エンコードが完了しました${audioStatus}`,
                    inputFPS,
                    outputFPS: inputFPS,
                    slowFactor: 1
                };

            } finally {
                // クリーンアップ
                try {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                } catch (e) {
                    // ignore
                }
            }

        } catch (error) {
            throw error;
        }
    }

    // 高速動画用（既存ロジック維持）
    static async executeEncodeHighSpeed(data) {
        const { inputPath, outputPath, startFrame, endFrame, inputFPS } = data;
        const outputFormat = path.extname(outputPath).slice(1).toLowerCase() || 'mp4';
        const slowFactor = inputFPS / 30;
        const startSec = (startFrame - 1) / inputFPS;
        const duration = (endFrame - startFrame + 1) / inputFPS;
        const frameCount = endFrame - startFrame + 1;
        const totalDurationSec = frameCount / inputFPS;

        return new Promise((resolve, reject) => {
            const command = ffmpeg(inputPath)
                .inputOptions(['-ss', startSec.toFixed(6)])
                .outputOptions([
                    '-t', duration.toFixed(6),
                    '-vf', `setpts=${slowFactor}*PTS`,
                    '-r', '30',
                    '-fps_mode', 'cfr',
                    '-an',
                    '-c:v', 'libx264',
                    '-avoid_negative_ts', 'make_zero',
                    '-g', '1',
                    '-preset', 'veryfast',
                    '-crf', '23',
                    '-max_muxing_queue_size', Math.max(1024, Math.round(inputFPS * 50)).toString(),
                    '-threads', '0'
                ])
                .noAudio()
                .format(outputFormat);

            command.on('start', () => {
                ProgressManager.updateProgress(10, 'エンコード開始...');
            });

            command.on('progress', (progress) => {
                const rawPercent = ProgressCalculator.calculate(progress, totalDurationSec, 'encode');
                const percent = Math.min(95, rawPercent);
                ProgressManager.updateProgress(percent, `処理中... ${percent}%`);
            });

            command.on('error', (err) => {
                ProgressManager.updateProgress(-1, 'エラーが発生しました');
                reject(`エンコードエラー: ${err.message}`);
            });

            command.on('end', () => {
                if (fs.existsSync(outputPath)) {
                    ProgressManager.updateProgress(100, `再エンコード完了（スロー${slowFactor.toFixed(1)}倍）`);
                    resolve({
                        success: true,
                        message: `スローモーション再エンコードが完了しました (${slowFactor.toFixed(1)}倍)`,
                        inputFPS,
                        outputFPS: 30,
                        slowFactor
                    });
                } else {
                    reject('出力ファイルが作成されませんでした');
                }
            });

            command.save(outputPath);
        });
    }
}

class FrameProcessor {
    static async saveFrame(data) {
        const { inputPath, outputPath, timestamp, frameNumber } = data;

        return new Promise((resolve, reject) => {
            let command = FFmpegProcessor.createCommand(inputPath);
            let stderrBuffer = '';

            if (frameNumber !== undefined) {
                const targetFrameZeroBased = Math.max(0, frameNumber - 1);

                // timestampが利用可能な場合は入力側シークで高速化
                // シーク後のフレーム番号は0から始まるため、selectで0を指定
                if (timestamp !== undefined) {
                    command = command
                        .inputOptions(['-ss', timestamp.toFixed(8)])  // 入力側での高速シーク
                        .outputOptions([
                            '-vf', `select='eq(n\\,0)',setpts=N/FRAME_RATE/TB`,  // シーク後の最初のフレーム
                            '-vsync', '0',
                            '-frames:v', '1',
                            '-q:v', '1'
                        ])
                        .format('image2')
                        .output(outputPath);
                } else {
                    // timestampがない場合は従来通り
                    command = command
                        .outputOptions([
                            '-vf', `select='eq(n\\,${targetFrameZeroBased})',setpts=N/FRAME_RATE/TB`,
                            '-vsync', '0',
                            '-frames:v', '1',
                            '-q:v', '1'
                        ])
                        .format('image2')
                        .output(outputPath);
                }
            } else if (timestamp !== undefined) {
                command = command
                    .seekInput(timestamp)
                    .frames(1)
                    .format('image2')
                    .outputOptions(['-q:v', '1'])
                    .output(outputPath);
            } else {
                reject(new Error('frameNumber または timestamp が必要です'));
                return;
            }

            // stderrをキャプチャしてエラー情報を取得
            command.on('stderr', (line) => {
                stderrBuffer += line + '\n';
            });

            command = FFmpegProcessor.setupErrorHandling(command, 'frame-save', reject);

            command.on('end', () => {
                // ファイルが実際に作成されたか確認
                if (fs.existsSync(outputPath)) {
                    resolve({ success: true, message: 'フレームを保存しました' });
                } else {
                    reject(new Error(`出力ファイルが作成されませんでした。FFmpeg出力: ${stderrBuffer.slice(-500)}`));
                }
            });

            command.run();
        });
    }

    static async saveFrameSequence(data) {
        const { inputPath, outputDir, startFrame, endFrame, forceFrameCount } = data;

        if (!startFrame || startFrame < 1) throw new Error('startFrame は1以上が必要です');

        let finalEndFrame;
        const hasValidForce = typeof forceFrameCount === 'number' && isFinite(forceFrameCount) && forceFrameCount >= 1;
        if (hasValidForce) {
            finalEndFrame = startFrame + Math.floor(forceFrameCount) - 1;
        } else {
            if (!endFrame || endFrame < startFrame) throw new Error('endFrame が不正です');
            finalEndFrame = endFrame;
        }

        const startZero = startFrame - 1;
        const endZero = finalEndFrame - 1;
        const targetFrames = finalEndFrame - startFrame + 1;

        return new Promise((resolve, reject) => {
            let frameCount = 0;

            let command = FFmpegProcessor.createCommand(inputPath)
                .outputOptions([
                    '-vf', `select='between(n\\,${startZero}\\,${endZero})',setpts=N/FRAME_RATE/TB`,
                    '-vsync', '0',
                    '-frames:v', targetFrames.toString(),
                    '-q:v', CONFIG.FFMPEG.FRAME_SEQUENCE.quality
                ])
                .output(path.join(outputDir, 'frame_%04d.jpg'));

            command = FFmpegProcessor.setupErrorHandling(command, 'frame-sequence', reject);

            command.on('start', () => {
                ProgressManager.updateProgress(5, '連番フレーム抽出開始...');
            });

            command.on('progress', (progress) => {
                if (progress.frames) frameCount = progress.frames;
                const percent = ProgressCalculator.calculate(progress, targetFrames, 'frame-sequence');
                ProgressManager.updateProgress(percent, `フレーム抽出中... ${frameCount}枚 (${percent}%)`);
            });

            command.on('end', () => {
                ProgressManager.updateProgress(100, `連番フレーム出力完了: ${frameCount}枚`);
                resolve({ success: true, frameCount: frameCount });
            });

            command.run();
        });
    }
}

// === 二画面動画結合処理クラス ===
class DualOutputProcessor {
    static async processDualOutput(data) {
        if (!data.leftVideoPath || !data.rightVideoPath) {
            throw new Error('左右の動画パスが指定されていません');
        }

        if (!data.outputPath) {
            throw new Error('出力パスが指定されていません');
        }

        if (data.leftInFrame === null || data.leftOutFrame === null) {
            throw new Error('左画面のフレーム基準トリミング点が設定されていません');
        }

        if (data.rightInFrame === null || data.rightOutFrame === null) {
            throw new Error('右画面のフレーム基準トリミング点が設定されていません');
        }

        if (data.leftInFrame >= data.leftOutFrame) {
            throw new Error('左画面のトリミング範囲が無効です（開始点 >= 終了点）');
        }

        if (data.rightInFrame >= data.rightOutFrame) {
            throw new Error('右画面のトリミング範囲が無効です（開始点 >= 終了点）');
        }

        return await this.combineVideos(data);
    }

    static async combineVideos(data) {
        const {
            leftVideoPath,
            rightVideoPath,
            outputPath,
            leftInFrame = 0,
            leftOutFrame = null,
            rightInFrame = 0,
            rightOutFrame = null,
            leftFPS = 30,
            rightFPS = 30
        } = data;

        const tempDir = path.join(os.tmpdir(), `dual_output_${uuidv4()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        const encodeSegment = (inputPath, startFrame, endFrame, inputFPS, tempName) => {
            return new Promise((resolve, reject) => {
                try {
                    const tempPath = path.join(tempDir, tempName);

                    // 数値変換を確実に行う
                    const fps = Number(inputFPS) || 30;
                    const startSec = Math.max(0, startFrame - 1) / fps;
                    // フレーム数から持続時間を計算
                    const duration = (endFrame - startFrame + 1) / fps;

                    // FFmpegコマンド構築
                    const command = ffmpeg(inputPath)
                        .inputOptions(['-ss', startSec.toFixed(6)])
                        .outputOptions([
                            '-t', duration.toFixed(6),
                            '-c:v', 'libx264',
                            '-preset', 'fast',
                            '-crf', '23',
                            '-c:a', 'aac',
                            '-avoid_negative_ts', 'make_zero',
                            // NaN対策をしたFPSを使用
                            '-max_muxing_queue_size', Math.max(1024, Math.round(fps * 50)).toString()
                        ]);

                    const timeoutMinutes = Math.max(2, Math.round(fps / 30 * 2));
                    const timeoutId = setTimeout(() => {
                        command.kill('SIGKILL');
                        reject(new Error(`エンコード処理タイムアウト（${timeoutMinutes}分）`));
                    }, timeoutMinutes * 60 * 1000);

                    command
                        .on('end', () => {
                            clearTimeout(timeoutId);
                            resolve(tempPath);
                        })
                        .on('error', (err) => {
                            clearTimeout(timeoutId);
                            reject(new Error(`エンコード処理エラー: ${err.message}`));
                        })
                        .save(tempPath);
                } catch (error) {
                    reject(new Error(`エンコード初期化エラー: ${error.message}`));
                }
            });
        };

        try {
            // 1) 左右をトリミング範囲だけ別々にエンコード
            const leftTempPath = await encodeSegment(
                leftVideoPath,
                leftInFrame,
                leftOutFrame,
                leftFPS,
                'left_trimmed.mp4'
            );

            const rightTempPath = await encodeSegment(
                rightVideoPath,
                rightInFrame,
                rightOutFrame,
                rightFPS,
                'right_trimmed.mp4'
            );

            // 2) 短くなった2動画を hstack で結合
            let lFps = Number(leftFPS);
            let rFps = Number(rightFPS);
            if (Number.isNaN(lFps)) lFps = 0;
            if (Number.isNaN(rFps)) rFps = 0;
            const baseFps = Math.max(lFps, rFps) || 30;

            await new Promise((resolve, reject) => {
                try {
                    let command = ffmpeg()
                        .input(leftTempPath)
                        .input(rightTempPath);

                    const filterComplex = `[0:v][1:v]hstack=inputs=2[v]`;

                    const opts = [
                        '-filter_complex', filterComplex,
                        '-map', '[v]',
                        '-c:v', 'libx264',
                        '-preset', 'fast',
                        '-crf', '23',
                        '-fps_mode', 'cfr',
                        '-vsync', '0',
                        '-frame_pts', '1',
                        '-shortest',
                        '-avoid_negative_ts', 'make_zero',
                        '-max_muxing_queue_size', Math.max(1024, Math.round(baseFps * 50)).toString(),
                        '-threads', '0'
                    ];

                    command = command.outputOptions(opts).output(outputPath);

                    const timeout = setTimeout(() => {
                        command.kill('SIGKILL');
                        reject(new Error('二画面結合処理がタイムアウトしました（5分）'));
                    }, 5 * 60 * 1000);

                    let lastProgress = 0;
                    command.on('progress', (progress) => {
                        if (progress.percent && progress.percent > lastProgress) {
                            lastProgress = progress.percent;
                            if (mainWindow && mainWindow.webContents) {
                                mainWindow.webContents.send('dual-output-progress', {
                                    percent: progress.percent,
                                    timemark: progress.timemark,
                                    message: `処理中... ${progress.percent.toFixed(1)}%`
                                });
                            }
                        }
                    });

                    command.on('end', () => {
                        clearTimeout(timeout);
                        resolve();
                    });

                    command.on('error', (err) => {
                        clearTimeout(timeout);
                        reject(new Error(`二画面結合FFmpeg処理エラー: ${err.message}`));
                    });

                    command.run();
                } catch (error) {
                    reject(new Error(`二画面結合処理の初期化エラー: ${error.message}`));
                }
            });

            // 3) 一時ファイルをクリーンアップ
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                // クリーンアップ失敗は無視
            }

            return { outputPath: outputPath, message: '二画面動画結合が完了しました' };
        } catch (error) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                // クリーンアップ失敗は無視
            }
            throw error;
        }
    }
}

// === IPCハンドラー設定 ===

// 遅延ロード: appが初期化されるまで待つ
let segBridge = null;

function getSegBridge() {
    if (!segBridge) {
        // ONNX bridge を使用（Pythonなしで動作）
        segBridge = new ONNXSegmentationBridge();
    }
    return segBridge;
}

function setupIPCHandlers() {
    // === Project Status Update IPC ===
    ipcMain.handle('update-project-status', async (event, { step, status }) => {
        if (!global.projectDataPath) return { success: false, error: 'No project data path set' };

        const statusPath = path.join(global.projectDataPath, 'status.json');
        try {
            let statusData = {};
            if (fs.existsSync(statusPath)) {
                statusData = JSON.parse(await fs.promises.readFile(statusPath, 'utf8'));
            }

            if (!statusData.steps) statusData.steps = {};
            if (!statusData.steps[step]) statusData.steps[step] = {};

            statusData.steps[step].status = status;
            statusData.steps[step].updated_at = new Date().toISOString();

            await fs.promises.writeFile(statusPath, JSON.stringify(statusData, null, 2));
            console.log(`Updated status for ${step} to ${status}`);
            return { success: true };
        } catch (error) {
            console.error('Failed to update status:', error);
            return { success: false, error: error.message };
        }
    });

    // === AI Segmentation IPC ===
    ipcMain.handle('segment-frame', async (event, buffer) => {
        try {
            console.log('Received segment-frame request');

            // Electron IPC経由でBufferがUint8Arrayや配列として届く場合の対策
            if (!Buffer.isBuffer(buffer)) {
                if (buffer.data && Array.isArray(buffer.data)) {
                    // { type: 'Buffer', data: [...] } 形式の場合
                    buffer = Buffer.from(buffer.data);
                } else {
                    // Uint8Array や通常の配列の場合
                    buffer = Buffer.from(buffer);
                }
            }

            const bridge = getSegBridge();
            const result = await bridge.segmentFrame(buffer);
            // ONNX実装は { success: true/false, mask: Buffer, error?: string } を返す
            return result;
        } catch (error) {
            console.error('Segmentation error:', error);
            return { success: false, error: error.message };
        }
    });


    ipcMain.handle('open-video-dialog', async (event, side) => {
        await FileDialogManager.openVideoFile(side);
    });

    ipcMain.handle('get-video-info', async (event, filePath) => {
        return await VideoInfoProcessor.getVideoInfo(filePath);
    });

    ipcMain.handle('trim-cut', async (event, data) => {
        try {
            const result = await TrimProcessor.executeFastCut(data);
            return result;
        } catch (error) {
            return { success: false, error: error.message || '高速カット処理に失敗しました' };
        }
    });

    ipcMain.handle('trim-video', async (event, data) => {
        try {
            const result = await TrimProcessor.executeEncode(data);
            return result;
        } catch (error) {
            return {
                success: false,
                error: error.message || error.toString() || '動画エンコード処理に失敗しました',
                details: error.stack || 'No stack trace available'
            };
        }
    });

    ipcMain.handle('save-frame', async (event, data) => {
        try {
            return await FrameProcessor.saveFrame(data);
        } catch (error) {
            return {
                success: false,
                error: error.message || error.toString() || 'フレーム保存処理に失敗しました'
            };
        }
    });

    ipcMain.handle('save-frame-sequence', async (event, data) => {
        return await FrameProcessor.saveFrameSequence(data);
    });

    ipcMain.handle('show-save-dialog', async (event, options) => {
        if (options.properties && options.properties.includes('openDirectory')) {
            // ディレクトリ選択時も最後のディレクトリを使用
            if (lastSaveDirectory && !options.defaultPath) {
                options.defaultPath = lastSaveDirectory;
            }
            const result = await dialog.showOpenDialog(mainWindow, options);
            // ディレクトリが選択された場合、記憶
            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                lastSaveDirectory = result.filePaths[0];
            }
            return result;
        }

        // ファイル保存ダイアログ
        // 最後に保存したディレクトリがある場合、それを優先
        if (lastSaveDirectory) {
            if (options.defaultPath) {
                // 渡されたパスからファイル名のみ取り出し、lastSaveDirectoryと結合
                const fileName = path.basename(options.defaultPath);
                options.defaultPath = path.join(lastSaveDirectory, fileName);
            } else {
                options.defaultPath = lastSaveDirectory;
            }
        }

        const result = await dialog.showSaveDialog(mainWindow, options);

        // 保存が成功した場合、ディレクトリを記憶
        if (!result.canceled && result.filePath) {
            lastSaveDirectory = path.dirname(result.filePath);
        }

        return result;
    });

    ipcMain.handle('open-folder', async (event, folderPath) => {
        try {
            await shell.openPath(folderPath);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('resize-window-for-mode', (event, mode) => {
        WindowManager.resizeForMode(mode);
    });

    ipcMain.on('close-video', () => {
        currentViewMode = 'single';
        MenuManager.createMenu();
    });

    ipcMain.on('switch-view', (event, mode) => {
        currentViewMode = mode;
        MenuManager.createMenu();
    });

    // === ハードウェアエンコーダー検出 ===
    let hwEncoder = null;
    let hwEncoderChecked = false;

    async function detectHardwareEncoder() {
        if (hwEncoderChecked) return hwEncoder;
        hwEncoderChecked = true;

        const encoders = [
            { name: 'h264_nvenc', label: 'NVENC' },      // NVIDIA
            { name: 'h264_qsv', label: 'QSV' },          // Intel Quick Sync
            { name: 'h264_amf', label: 'AMF' }           // AMD
        ];

        const { execFile } = require('child_process');
        const resolvedFfmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');

        for (const enc of encoders) {
            try {
                const result = await new Promise((resolve) => {
                    execFile(resolvedFfmpegPath, ['-hide_banner', '-encoders'], (error, stdout) => {
                        if (error) {
                            resolve(false);
                            return;
                        }
                        resolve(stdout.includes(enc.name));
                    });
                });
                if (result) {
                    console.log(`Hardware encoder detected: ${enc.name} (${enc.label})`);
                    hwEncoder = enc.name;
                    return hwEncoder;
                }
            } catch (e) {
                // Continue to next encoder
            }
        }
        console.log('No hardware encoder detected, using libx264');
        return null;
    }

    ipcMain.handle('convert-to-mp4', async (event, inputPath) => {
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `videosynclab_${uuidv4()}.mp4`);

        // ハードウェアエンコーダーを検出
        const encoder = await detectHardwareEncoder();

        return new Promise((resolve) => {
            // エンコーダーに応じたオプションを設定
            const outputOptions = encoder
                ? [
                    '-c:v', encoder,
                    '-preset', 'p1',           // 最速プリセット (NVENC/QSV/AMF)
                    '-rc', 'vbr',
                    '-cq', '18',               // 視覚的ロスレス品質
                    '-c:a', 'aac',
                    '-vsync', '0',             // VFR動画対応
                    '-pix_fmt', 'yuv420p'      // 互換性確保
                ]
                : [
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '18',              // 視覚的ロスレス品質
                    '-c:a', 'aac',
                    '-vsync', '0',             // VFR動画対応
                    '-pix_fmt', 'yuv420p'      // 互換性確保
                ];

            // FFmpegコマンド生成
            let command = ffmpeg(inputPath);

            // GPUエンコーダー使用時はデコードもGPUで行う（CPU負荷低減）
            if (encoder) {
                command.inputOptions(['-hwaccel', 'auto']);
            }

            command.outputOptions(outputOptions)
                .on('progress', (progress) => {
                    // 進捗をレンダラーに送信
                    if (mainWindow && mainWindow.webContents) {
                        mainWindow.webContents.send('convert-progress', {
                            percent: progress.percent || 0,
                            timemark: progress.timemark || '',
                            encoder: encoder || 'libx264'
                        });
                    }
                })
                .on('end', () => {
                    // 完了を通知
                    if (mainWindow && mainWindow.webContents) {
                        mainWindow.webContents.send('convert-progress', {
                            percent: 100,
                            done: true,
                            encoder: encoder || 'libx264'
                        });
                    }
                    resolve({ success: true, filePath: tempFile });
                })
                .on('error', (err) => {
                    // ハードウェアエンコーダー失敗時はソフトウェアにフォールバック
                    if (encoder) {
                        console.log('Hardware encoder failed, falling back to libx264:', err.message);
                        ffmpeg(inputPath)
                            .outputOptions([
                                '-c:v', 'libx264',
                                '-preset', 'fast',
                                '-crf', '18',
                                '-c:a', 'aac',
                                '-vsync', '0',
                                '-pix_fmt', 'yuv420p'
                            ])
                            .on('progress', (progress) => {
                                if (mainWindow && mainWindow.webContents) {
                                    mainWindow.webContents.send('convert-progress', {
                                        percent: progress.percent || 0,
                                        timemark: progress.timemark || '',
                                        encoder: 'libx264 (fallback)'
                                    });
                                }
                            })
                            .on('end', () => {
                                if (mainWindow && mainWindow.webContents) {
                                    mainWindow.webContents.send('convert-progress', {
                                        percent: 100,
                                        done: true,
                                        encoder: 'libx264 (fallback)'
                                    });
                                }
                                resolve({ success: true, filePath: tempFile });
                            })
                            .on('error', (err2) => {
                                if (mainWindow && mainWindow.webContents) {
                                    mainWindow.webContents.send('convert-progress', { percent: -1, error: err2.message });
                                }
                                resolve({ success: false, error: err2.message });
                            })
                            .save(tempFile);
                    } else {
                        // エラーを通知
                        if (mainWindow && mainWindow.webContents) {
                            mainWindow.webContents.send('convert-progress', { percent: -1, error: err.message });
                        }
                        resolve({ success: false, error: err.message });
                    }
                })
                .save(tempFile);
        });
    });

    ipcMain.handle('optimize-video', async (event, inputPath) => {
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `videosynclab_optimized_${uuidv4()}.mp4`);
        const sender = event.sender;
        return new Promise((resolve) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-c:v', 'libx264',
                    '-g', '1',             // GOP=1: 全フレームキーフレーム化
                    '-c:a', 'aac',
                    '-preset', 'ultrafast', // 速度優先
                    '-crf', '20',           // 高画質
                    '-vsync', '0',          // VFR対応
                    '-pix_fmt', 'yuv420p',  // 互換性確保
                    '-avoid_negative_ts', 'make_zero'
                ])
                .on('progress', (progress) => {
                    // 進捗をレンダラーに送信
                    if (progress.percent !== undefined && !sender.isDestroyed()) {
                        sender.send('optimization-progress', { percent: progress.percent });
                    }
                })
                .on('end', () => resolve({ success: true, filePath: tempFile }))
                .on('error', (err) => resolve({ success: false, error: err.message }))
                .save(tempFile);
        });
    });

    ipcMain.handle('dual-output', async (event, data) => {
        try {
            const result = await DualOutputProcessor.processDualOutput(data);
            return { success: true, message: '二画面動画結合が完了しました', ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // === ストロボモーション用IPCハンドラ ===

    // Base64画像をファイルに保存
    ipcMain.handle('save-base64-image', async (event, data) => {
        try {
            const { filePath, base64Data } = data;
            const buffer = Buffer.from(base64Data, 'base64');
            fs.writeFileSync(filePath, buffer);
            return { success: true, filePath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // ストロボモーション動画を生成（高速版 - FFmpegオーバーレイ使用）
    ipcMain.handle('generate-strobe-video', async (event, data) => {
        const { outputPath, sourceVideoPath, overlays, fps, startTime, endTime, blendMode } = data;

        // 一時ディレクトリにオーバーレイ画像を保存
        const tempDir = path.join(os.tmpdir(), `strobe_${uuidv4()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            // オーバーレイ画像をファイルに書き出し
            const overlayPaths = [];
            for (let i = 0; i < overlays.length; i++) {
                const overlay = overlays[i];
                const overlayPath = path.join(tempDir, `overlay_${i}.png`);
                const buffer = Buffer.from(overlay.imageBase64, 'base64');
                fs.writeFileSync(overlayPath, buffer);
                overlayPaths.push({
                    path: overlayPath,
                    x: overlay.x,
                    y: overlay.y,
                    startTime: overlay.startTime,
                    opacity: overlay.opacity
                });
            }

            // FFmpegで動画を生成（オーバーレイフィルター使用）
            return new Promise((resolve, reject) => {
                let cmd = ffmpeg()
                    .input(sourceVideoPath);

                // トリミング範囲を設定
                if (startTime !== undefined && endTime !== undefined) {
                    cmd = cmd.inputOptions(['-ss', startTime.toString()])
                        .inputOptions(['-to', endTime.toString()]);
                }

                // 各オーバーレイ画像を入力として追加
                for (const overlay of overlayPaths) {
                    cmd = cmd.input(overlay.path);
                }

                // フィルターコンプレックスを構築
                let filterComplex = '';
                let lastOutput = '[0:v]';

                // 合成モードに応じたblendフィルターを決定
                let blendFilter = '';
                switch (blendMode) {
                    case 'lighter':
                        blendFilter = 'blend=all_mode=addition';
                        break;
                    case 'darken':
                        blendFilter = 'blend=all_mode=darken';
                        break;
                    case 'lighten':
                        blendFilter = 'blend=all_mode=lighten';
                        break;
                    case 'multiply':
                        blendFilter = 'blend=all_mode=multiply';
                        break;
                    case 'screen':
                        blendFilter = 'blend=all_mode=screen';
                        break;
                    case 'overlay':
                        blendFilter = 'blend=all_mode=overlay';
                        break;
                    case 'difference':
                        blendFilter = 'blend=all_mode=difference';
                        break;
                    default:
                        blendFilter = ''; // source-over は通常のoverlay
                }

                for (let i = 0; i < overlayPaths.length; i++) {
                    const overlay = overlayPaths[i];
                    const inputIdx = i + 1;
                    const outputLabel = i === overlayPaths.length - 1 ? '[out]' : `[v${i}]`;

                    // オーバーレイの透明度と表示開始時間を設定
                    // enable='gte(t,startTime)' で指定時間以降に表示
                    const enableExpr = `gte(t,${overlay.startTime.toFixed(3)})`;

                    if (blendFilter && blendMode !== 'source-over') {
                        // 特殊合成モードの場合
                        // まずオーバーレイ画像を動画サイズに配置
                        filterComplex += `[${inputIdx}:v]format=rgba,colorchannelmixer=aa=${overlay.opacity}[ov${i}];`;
                        filterComplex += `${lastOutput}[ov${i}]overlay=x=${overlay.x}:y=${overlay.y}:enable='${enableExpr}'${outputLabel};`;
                    } else {
                        // 通常のオーバーレイ（source-over）
                        filterComplex += `[${inputIdx}:v]format=rgba,colorchannelmixer=aa=${overlay.opacity}[ov${i}];`;
                        filterComplex += `${lastOutput}[ov${i}]overlay=x=${overlay.x}:y=${overlay.y}:enable='${enableExpr}'${outputLabel};`;
                    }

                    lastOutput = outputLabel;
                }

                // 最後のセミコロンを削除
                filterComplex = filterComplex.slice(0, -1);

                cmd.complexFilter(filterComplex, 'out')
                    .outputOptions([
                        '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p',
                        '-preset', 'fast',
                        '-crf', '18',
                        '-r', fps.toString(),
                        '-c:a', 'aac',
                        '-b:a', '192k'
                    ])
                    .on('start', (cmdLine) => {
                        console.log('FFmpeg command:', cmdLine);
                        ProgressManager.updateProgress(0, 'ストロボモーション動画を生成中...');
                    })
                    .on('progress', (progress) => {
                        const percent = Math.min(95, Math.round(progress.percent || 0));
                        ProgressManager.updateProgress(percent, `動画生成中... ${percent}%`);
                    })
                    .on('end', () => {
                        // 一時ファイルをクリーンアップ
                        try {
                            fs.rmSync(tempDir, { recursive: true, force: true });
                        } catch (e) {
                            // クリーンアップ失敗は無視
                        }

                        ProgressManager.updateProgress(100, 'ストロボモーション動画生成完了');
                        resolve({ success: true, outputPath });
                    })
                    .on('error', (err) => {
                        console.error('FFmpeg error:', err);
                        // 一時ファイルをクリーンアップ
                        try {
                            fs.rmSync(tempDir, { recursive: true, force: true });
                        } catch (e) {
                            // クリーンアップ失敗は無視
                        }

                        reject(new Error(`動画生成エラー: ${err.message}`));
                    })
                    .save(outputPath);
            });
        } catch (error) {
            console.error('Strobe video generation error:', error);
            // エラー時もクリーンアップ
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                // クリーンアップ失敗は無視
            }

            return { success: false, error: error.message };
        }
    });

    // === ストロボモーション イベントフレーム保存 ===
    ipcMain.handle('save-strobe-events', async (event, data, videoPath) => {
        try {
            // 動画パスからデフォルトのファイル名とディレクトリを生成
            let defaultPath = `strobe_events_${Date.now()}.json`;
            let defaultDir = undefined;

            if (videoPath) {
                const videoDir = path.dirname(videoPath);
                const videoName = path.basename(videoPath, path.extname(videoPath));
                defaultPath = path.join(videoDir, `${videoName}.json`);
                defaultDir = videoDir;
            }

            const result = await dialog.showSaveDialog(mainWindow, {
                title: 'ストロボモーション イベントフレームを保存',
                defaultPath: defaultPath,
                filters: [{ name: 'JSONファイル', extensions: ['json'] }]
            });

            if (!result.canceled && result.filePath) {
                fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
                return { success: true, filePath: result.filePath };
            }
            return { success: false, canceled: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // === ストロボモーション イベントフレーム読込 ===
    ipcMain.handle('load-strobe-events', async (event, videoPath) => {
        try {
            // 動画パスからデフォルトのディレクトリを設定
            let defaultDir = undefined;

            if (videoPath) {
                defaultDir = path.dirname(videoPath);
            }

            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'ストロボモーション イベントフレームを読込',
                defaultPath: defaultDir,
                properties: ['openFile'],
                filters: [{ name: 'JSONファイル', extensions: ['json'] }]
            });

            if (!result.canceled && result.filePaths.length > 0) {
                const filePath = result.filePaths[0];
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                return { success: true, data, filePath };
            }
            return { success: false, canceled: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // === プロジェクトファイル保存 ===
    ipcMain.handle('save-project-file', async (event, data) => {
        try {
            // デフォルトファイル名を動画ファイル名から生成
            let defaultPath = 'project.vsl';
            const videoPath = data?.left?.path || data?.right?.path;
            if (videoPath) {
                const videoDir = path.dirname(videoPath);
                const videoName = path.basename(videoPath, path.extname(videoPath));
                defaultPath = path.join(videoDir, `${videoName}.vsl`);
            }

            const result = await dialog.showSaveDialog(mainWindow, {
                title: 'プロジェクトを保存',
                defaultPath: defaultPath,
                filters: [{ name: 'VSL Project', extensions: ['vsl'] }]
            });

            if (!result.canceled && result.filePath) {
                fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf8');
                return { success: true, filePath: result.filePath };
            }
            return { success: false, canceled: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // === プロジェクトファイル読込 ===
    ipcMain.handle('load-project-file', async () => {
        try {
            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'プロジェクトを開く',
                properties: ['openFile'],
                filters: [{ name: 'VSL Project', extensions: ['vsl'] }]
            });

            if (!result.canceled && result.filePaths.length > 0) {
                const filePath = result.filePaths[0];
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                return { success: true, data, filePath };
            }
            return { success: false, canceled: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // === ストロボモーション プレビューウィンドウ ===
    let previewWindow = null;

    ipcMain.handle('open-strobe-preview', async (event, imageBase64) => {
        if (previewWindow && !previewWindow.isDestroyed()) {
            previewWindow.focus();
            previewWindow.webContents.send('update-preview', imageBase64);
            return { success: true };
        }

        previewWindow = new BrowserWindow({
            width: 800,
            height: 600,
            title: 'プレビュー',
            icon: getIconPath(),
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });

        previewWindow.loadFile(path.join(__dirname, 'preview.html'));

        previewWindow.webContents.on('did-finish-load', () => {
            previewWindow.webContents.send('update-preview', imageBase64);
        });

        previewWindow.on('closed', () => {
            previewWindow = null;
        });

        return { success: true };
    });

    // マニュアルを開く
    ipcMain.handle('open-manual', async () => {
        return WindowManager.openManualWindow();
    });
}

// macOS: ファイルダブルクリックや Dock へのドロップで開く
let pendingOpenFile = null;
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.vsl' && !['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) return;
    console.log('[MAIN] open-file event:', filePath);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
        if (ext === '.vsl') {
            mainWindow.webContents.send('load-project', filePath);
        } else {
            mainWindow.webContents.send('load-video', { side: 'left', path: filePath });
        }
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    } else {
        pendingOpenFile = { path: filePath, isProject: ext === '.vsl' };
    }
});

// === アプリケーション初期化 ===
app.whenReady().then(async () => {
    app.setName('VideoSyncLab');
    const ffmpegResolved = resolveFfmpegPaths();
    if (!ffmpegResolved) {
        setTimeout(() => {
            dialog.showErrorBox(
                'FFmpeg初期化エラー',
                'FFmpegの初期化に失敗しました。動画処理機能が利用できません。'
            );
        }, 1000);
    } else {
        const ffmpegWorking = await testFFmpegOperation();
        if (!ffmpegWorking) {
            setTimeout(() => {
                dialog.showErrorBox(
                    'FFmpeg動作確認エラー',
                    'FFmpegは見つかりましたが、正常に動作しません。'
                );
            }, 1000);
        }
    }

    WindowManager.createWindow();
    setupIPCHandlers();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        WindowManager.createWindow();
    }
});

app.on('before-quit', () => {
    // アプリ終了前処理
    segBridge.stop();

    // 一時ファイルをクリーンアップ
    const os = require('os');
    const tmpDir = os.tmpdir();
    const prefixes = ['videosynclab_', 'dual_output_', 'strobe_'];
    try {
        const entries = require('fs').readdirSync(tmpDir);
        for (const entry of entries) {
            if (prefixes.some(p => entry.startsWith(p))) {
                const fullPath = require('path').join(tmpDir, entry);
                try {
                    const stat = require('fs').statSync(fullPath);
                    if (stat.isDirectory()) {
                        require('fs').rmSync(fullPath, { recursive: true, force: true });
                    } else {
                        require('fs').unlinkSync(fullPath);
                    }
                } catch (e) { /* ignore */ }
            }
        }
    } catch (e) { /* ignore */ }
});

process.on('uncaughtException', (error) => {
    // 未処理例外の処理（サイレント）
});

process.on('unhandledRejection', (reason, promise) => {
    // 未処理のPromise拒否の処理（サイレント）
});