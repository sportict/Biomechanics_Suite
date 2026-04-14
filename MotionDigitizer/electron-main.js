'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const analysisEngine = require('./src/analysis-engine.js');
// Shift-JISエンコーディング用（.setファイル保存時に使用）
let iconv;
try {
	iconv = require('iconv-lite');
} catch (e) {
	// iconv-liteがインストールされていない場合は後でエラーを表示
	iconv = null;
}
// DLL探索用PATHを先に整える（Windows専用、packaged/開発）
if (process.platform === 'win32') {
	const vcpkgBinPath = 'C:\\vcpkg\\installed\\x64-windows\\bin';
	if (process.env.PATH.indexOf(vcpkgBinPath) === -1) {
		process.env.PATH = vcpkgBinPath + ';' + process.env.PATH;
	}

	(function prepareDllSearchPath() {
		try {
			const userFfmpegPath = 'C:\\ffmpeg\\bin';
			if (fs.existsSync(userFfmpegPath)) {
				process.env.PATH = `${userFfmpegPath};${process.env.PATH}`;
				console.log(`[MAIN] Added user FFmpeg path to PATH: ${userFfmpegPath}`);
			}

			if (app.isPackaged) {
				const opencvDir = path.join(process.resourcesPath, 'opencv');
				if (fs.existsSync(opencvDir)) {
					process.env.PATH = `${opencvDir};${process.env.PATH}`;
				}
			} else {
				const vendorDir = path.join(__dirname, 'vendor', 'opencv', 'bin');
				const vcpkgDir = 'C:\\vcpkg\\installed\\x64-windows\\bin';
				if (fs.existsSync(vcpkgDir)) {
					process.env.PATH = `${vcpkgDir};${process.env.PATH}`;
				}
				if (fs.existsSync(vendorDir)) {
					process.env.PATH = `${vendorDir};${process.env.PATH}`;
				}
			}
		} catch (_) { }
	})();
}

// 内部ログの抑制（ユーザー要望）
app.commandLine.appendSwitch('log-level', '3'); // FATAL only (hides INFO, WARNING, ERROR from Chromium internals)
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication'); // Autofillのエラー抑制試行

// カスタムプロトコル media-file:// を特権スキームとして登録（app.ready より前に呼ぶ必要あり）
protocol.registerSchemesAsPrivileged([
	{
		scheme: 'media-file',
		privileges: {
			standard: false,
			secure: true,
			supportFetchAPI: true,
			stream: true,           // ストリーミング（Range リクエスト）対応
			bypassCSP: false
		}
	}
]);

// === アイコンパス解決 ===
function getIconPath() {
	const iconFile = process.platform === 'darwin' ? 'MDigi.png' : 'MDigi.ico';
	if (app.isPackaged) {
		return path.join(process.resourcesPath, iconFile);
	}
	return path.join(__dirname, iconFile);
}

// macOS: Dockアイコンとアプリ名を設定
if (process.platform === 'darwin') {
	app.setName('MotionDigitizer');
	app.dock.setIcon(getIconPath());
}

// 遅延ロード（正しい配置から）
let opencv = null;
function resolveOpenCVModulePath() {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'native', 'opencv_module.node');
	}
	// ビルドの出力先として node-gyp の標準的なパスを確認
	const possiblePaths = [
		path.join(__dirname, 'native', 'build', 'Release', 'opencv_module.node'),
		path.join(__dirname, 'native', 'bin', process.platform + '-' + process.arch + '-' + process.versions.modules, 'opencv_module.node') // electron-rebuild/prebuild
	];
	for (const p of possiblePaths) {
		if (fs.existsSync(p)) return p;
	}
	return path.join(__dirname, 'native', 'build', 'Release', 'opencv_module.node'); // fallback
}
function ensureOpenCVLoaded() {
	if (opencv) return opencv;
	try {
		const nativePath = resolveOpenCVModulePath();
		opencv = require(nativePath);

	} catch (e) {
		console.error('Failed to load opencv_module:', e);
		opencv = null;
	}
	return opencv;
}

let mainWindow = null;
// アプリ終了制御用フラグ（before-quitの再入防止）
let isQuitting = false;
// ファイル関連付けから開かれたmdpファイルパス
let pendingMdpFile = null;

/**
 * コマンドライン引数からmdpファイルパスを取得
 * @param {string[]} argv - コマンドライン引数
 * @returns {string|null} mdpファイルパス（見つからない場合はnull）
 */
function getMdpFileFromArgs(argv) {
	console.log('[MAIN] getMdpFileFromArgs called with:', argv);
	for (const arg of argv) {
		console.log('[MAIN] Checking arg:', arg);
		if (arg.toLowerCase().endsWith('.mdp')) {
			console.log('[MAIN] Found .mdp file argument:', arg);
			const exists = fs.existsSync(arg);
			console.log('[MAIN] File exists:', exists);
			if (exists) {
				return arg;
			}
		}
	}
	console.log('[MAIN] No valid .mdp file found in arguments');
	return null;
}

// シングルインスタンスロック
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
} else {
	// macOS: ファイルダブルクリックや Dock へのドロップで開く
	app.on('open-file', (event, filePath) => {
		event.preventDefault();
		if (!filePath.toLowerCase().endsWith('.mdp')) return;
		console.log('[MAIN] open-file event:', filePath);
		if (mainWindow && !mainWindow.webContents.isLoading()) {
			mainWindow.webContents.send('open-mdp-file', filePath);
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		} else {
			pendingMdpFile = filePath;
		}
	});

	// 2つ目のインスタンスが起動しようとした時
	app.on('second-instance', (event, commandLine, workingDirectory) => {
		const mdpFile = getMdpFileFromArgs(commandLine);
		if (mdpFile && mainWindow) {
			// 既存ウィンドウにmdpファイルを開くよう通知
			mainWindow.webContents.send('open-mdp-file', mdpFile);
			// ウィンドウをフォアグラウンドに
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});
}

function createMainWindow() {
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		title: 'MotionDigitizer v1.1',
		icon: getIconPath(),
		webPreferences: {
			// 既存レンダラコードの互換設定（require や ipcRenderer をそのまま利用）
			nodeIntegration: true,
			contextIsolation: false
		}
	});

	mainWindow.loadFile(path.join(__dirname, 'index.html'));

	if (process.argv.includes('--dev')) {
		mainWindow.webContents.openDevTools();
	}

	// ページ読み込み完了後、保留中のmdpファイルがあれば送信
	mainWindow.webContents.on('did-finish-load', () => {
		console.log('[MAIN] did-finish-load fired');
		if (pendingMdpFile) {
			console.log('[MAIN] Sending pending mdp file to renderer:', pendingMdpFile);
			// 少し遅延させてrenderer.jsの初期化完了を待つ
			setTimeout(() => {
				if (mainWindow && pendingMdpFile) {
					mainWindow.webContents.send('load-startup-mdp-file', pendingMdpFile);
					pendingMdpFile = null;
				}
			}, 500);
		}
	});

	// 「✕」閉じる操作を横取りし、必ず保存確認ダイアログを表示
	mainWindow.on('close', async (e) => {
		if (isQuitting) return; // 確定終了時は素通り
		e.preventDefault();

		try {
			const response = await dialog.showMessageBox(mainWindow, {
				type: 'question',
				buttons: ['保存して終了', '保存せずに終了', 'キャンセル'],
				defaultId: 0,
				cancelId: 2,
				noLink: true,
				title: 'プロジェクトの保存確認',
				message: '保存せずに終了しますか？'
			});

			if (response.response === 0) {
				console.error('[MAIN] User selected "Save and Exit" (via Close button). Executing window.saveProject()...');
				const saveResult = await mainWindow.webContents.executeJavaScript(`
                    (async function() {
                        try {
                            if (typeof window.saveProject === 'function') {
                                return await window.saveProject();
                            }
                            console.error('[RENDERER] window.saveProject is NOT a function!');
                            return "NOT_FUNCTION";
                        } catch (err) {
                            return "EXEC_JS_CAUGHT: " + (err.message || String(err));
                        }
                    })()
				`);
				console.error('[MAIN] saveResult:', saveResult);
				if (saveResult) {
					isQuitting = true;
					mainWindow.destroy();
				}
			} else if (response.response === 1) {
				isQuitting = true;
				mainWindow.destroy();
			} else {
				// キャンセル: 何もしない
			}
		} catch (e) {
			console.error('[MAIN] Close handler ERROR:', e);
			// 例外時は安全側（終了許可）
			isQuitting = true;
			mainWindow.destroy();
		}
	});

	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

app.whenReady().then(() => {
	// ローカル動画・画像ファイルを配信するカスタムプロトコル (media-file://)
	// file:// の制限を回避し、Google Drive やマルチバイトパスにも対応
	const { createReadStream, statSync } = require('fs');
	const { lookup: mimeLookup } = require('path');

	protocol.handle('media-file', (request) => {
		try {
			const url = new URL(request.url);
			let filePath = decodeURIComponent(url.pathname);
			// Windows: /C:/... → C:/...
			if (process.platform === 'win32' && filePath.startsWith('/') && /^\/[a-zA-Z]:/.test(filePath)) {
				filePath = filePath.slice(1);
			}

			const stat = statSync(filePath);
			const ext = path.extname(filePath).toLowerCase();
			const mimeMap = {
				'.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
				'.mkv': 'video/x-matroska', '.webm': 'video/webm', '.ogg': 'video/ogg',
				'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
				'.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.tiff': 'image/tiff'
			};
			const contentType = mimeMap[ext] || 'application/octet-stream';
			const fileSize = stat.size;

			// Range リクエスト対応（動画のシーク用）
			const rangeHeader = request.headers.get('Range');
			if (rangeHeader) {
				const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
				if (match) {
					const start = parseInt(match[1], 10);
					const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
					const chunkSize = end - start + 1;
					const stream = createReadStream(filePath, { start, end });
					return new Response(stream, {
						status: 206,
						headers: {
							'Content-Type': contentType,
							'Content-Length': String(chunkSize),
							'Content-Range': `bytes ${start}-${end}/${fileSize}`,
							'Accept-Ranges': 'bytes',
							'Access-Control-Allow-Origin': '*'
						}
					});
				}
			}

			// 通常リクエスト
			const stream = createReadStream(filePath);
			return new Response(stream, {
				status: 200,
				headers: {
					'Content-Type': contentType,
					'Content-Length': String(fileSize),
					'Accept-Ranges': 'bytes',
					'Access-Control-Allow-Origin': '*'
				}
			});
		} catch (err) {
			console.error('[MAIN] media-file protocol error:', err.message);
			return new Response('Not Found', { status: 404 });
		}
	});

	// データパスの取得
	const args = process.argv;
	console.log('[MAIN] process.argv:', args);
	const dataPathArg = args.find(arg => arg.startsWith('--data-path='));
	if (dataPathArg) {
		global.projectDataPath = dataPathArg.split('=')[1];
	}

	// ファイル関連付けからのmdpファイルパスを取得（open-fileで先にセットされていなければ）
	if (!pendingMdpFile) {
		pendingMdpFile = getMdpFileFromArgs(args);
	}
	console.log('[MAIN] pendingMdpFile set to:', pendingMdpFile);

	createMainWindow();
});

// レンダラーから準備完了通知を受け取ったらmdpファイルを開く
ipcMain.handle('renderer-ready', async () => {
	console.log('[MAIN] renderer-ready called, pendingMdpFile =', pendingMdpFile);
	if (pendingMdpFile) {
		const filePath = pendingMdpFile;
		pendingMdpFile = null;
		console.log('[MAIN] Returning pending file:', filePath);
		return { hasPendingFile: true, filePath };
	}
	return { hasPendingFile: false };
});

// プロジェクトステータス更新 IPC
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
		return { success: true };
	} catch (error) {
		console.error('Failed to update status:', error);
		return { success: false, error: error.message };
	}
});

// 3Dキャリブレーション表示ウィンドウを開く


// 共有キャリブレーションパス取得
ipcMain.handle('get-calibration-path', async () => {
	if (!global.projectDataPath) return { success: false, error: 'No project data path set' };
	// global.projectDataPath is .../Project/MotionID
	// Calibration is .../Project/Calibration/camera_params.json
	const projectRoot = path.dirname(global.projectDataPath);
	const calibPath = path.join(projectRoot, 'Calibration', 'camera_params.json');
	return { success: true, path: calibPath };
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

// アプリ終了時に一時ファイルをクリーンアップ
app.on('will-quit', () => {
	try {
		const tempDir = path.join(os.tmpdir(), 'mdigitizer_charuco_temp');
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			console.log('[MAIN] Cleaned up temp directory:', tempDir);
		}
	} catch (e) {
		console.warn('[MAIN] Temp cleanup failed:', e.message);
	}
});

app.on('activate', () => {
	if (mainWindow === null) createMainWindow();
});

// アプリケーション終了前の処理
app.on('before-quit', async (event) => {
	// 再入による無限ループ防止
	if (isQuitting) {
		return;
	}
	// レンダラープロセスにプロジェクト保存確認を依頼
	if (mainWindow && !mainWindow.isDestroyed()) {
		event.preventDefault(); // 一時的に終了を停止

		try {
			const result = await mainWindow.webContents.executeJavaScript(`
				// プロジェクトに未保存の変更があるかチェック
				if (typeof window.hasUnsavedChanges === 'function') {
					return window.hasUnsavedChanges();
				}
				return false;
			`);

			if (result) {
				// 未保存の変更がある場合は確認ダイアログを表示
				const response = await dialog.showMessageBox(mainWindow, {
					type: 'question',
					buttons: ['保存して終了', '保存せずに終了', 'キャンセル'],
					defaultId: 0,
					cancelId: 2,
					title: 'プロジェクトの保存確認',
					message: 'プロジェクトに未保存の変更があります。',
					detail: '変更を保存してから終了しますか？'
				});

				if (response.response === 0) {
					// 保存して終了
					console.error('[MAIN] User selected "Save and Exit". Executing window.saveProject()...');
					const saveResult = await mainWindow.webContents.executeJavaScript(`
						if (typeof window.saveProject === 'function') {
							return window.saveProject();
						}
                        console.error('[RENDERER] window.saveProject is NOT a function!');
						return Promise.resolve(false);
					`);

					if (saveResult) {
						isQuitting = true;
						app.quit();
					}
					// 保存に失敗した場合は終了しない
				} else if (response.response === 1) {
					// 保存せずに終了
					isQuitting = true;
					app.quit();
				}
				// キャンセルの場合は何もしない（終了しない）
			} else {
				// 未保存の変更がない場合はそのまま終了
				isQuitting = true;
				app.quit();
			}
		} catch (error) {
			// エラーの場合はそのまま終了
			isQuitting = true;
			app.quit();
		}
	} else {
		// メインウィンドウが存在しない場合はそのまま終了
		isQuitting = true;
		app.quit();
	}
});

// メニュー設定（旧app.jsの方針に準拠、イベント名は現行レンダラに合わせる）
function setupAppMenu() {
	const template = [
		{
			label: 'ファイル',
			submenu: [
				{ label: '新規プロジェクト', accelerator: 'CmdOrCtrl+N', click: () => mainWindow && mainWindow.webContents.send('menu-new-project') },
				{ label: 'プロジェクトを開く', accelerator: 'CmdOrCtrl+O', click: () => mainWindow && mainWindow.webContents.send('menu-open-project') },
				{ label: 'プロジェクトを上書き保存', accelerator: 'CmdOrCtrl+S', click: () => mainWindow && mainWindow.webContents.send('menu-save-project-overwrite') },
				{ label: 'プロジェクトを別名で保存', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow && mainWindow.webContents.send('menu-save-project-as') },
				{ label: 'テンプレートとして保存...', click: () => mainWindow && mainWindow.webContents.send('menu-save-template') },
				{ type: 'separator' },
				{ label: 'キャリブレーションデータ読み込み...', click: () => mainWindow && mainWindow.webContents.send('menu-load-calibration') },
				{ label: 'キャリブレーションデータ保存...', click: () => mainWindow && mainWindow.webContents.send('menu-save-calibration') },
				{ type: 'separator' },
				{ label: '設定...', click: () => mainWindow && mainWindow.webContents.send('menu-open-settings') },
				{ type: 'separator' },
				{
					label: '終了', accelerator: 'Alt+F4', click: () => {
						// close 経路に統一して、確実にダイアログを表示
						if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
					}
				}
			]
		},
		{
			label: '編集',
			submenu: [
				{ label: '元に戻す', accelerator: 'CmdOrCtrl+Z', id: 'menu-undo', enabled: false, click: () => mainWindow && mainWindow.webContents.send('menu-undo') },
				{ label: 'やり直す', accelerator: 'CmdOrCtrl+Y', id: 'menu-redo', enabled: false, click: () => mainWindow && mainWindow.webContents.send('menu-redo') }
			]
		},
		{
			label: 'ヘルプ',
			submenu: [
				{
					label: '開発者ツール', accelerator: 'Ctrl+Shift+I', click: () => {
						try {
							if (mainWindow && !mainWindow.isDestroyed()) {
								mainWindow.webContents.toggleDevTools();
							}
						} catch (_) { }
					}
				},
				{
					label: 'アプリについて', click: () => {
						if (!mainWindow) return;
						dialog.showMessageBox(mainWindow, {
							type: 'info',
							title: 'MotionDigitizer について',
							message: 'MotionDigitizer v1.1',
							detail: '3Dモーションキャプチャ・動画解析アプリケーション'
						});
					}
				}
			]
		}
	];

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
	setupAppMenu();
});

// Undo/Redo メニュー状態の動的更新
ipcMain.on('update-undo-redo-state', (_event, { canUndo, canRedo }) => {
	const menu = Menu.getApplicationMenu();
	if (menu) {
		const undoItem = menu.getMenuItemById('menu-undo');
		const redoItem = menu.getMenuItemById('menu-redo');
		if (undoItem) undoItem.enabled = canUndo;
		if (redoItem) redoItem.enabled = canRedo;
	}
});

// IPC handlers

ipcMain.handle('select-video-file', async () => {
	const res = await dialog.showOpenDialog(mainWindow, {
		title: '動画ファイルを選択',
		properties: ['openFile'],
		filters: [
			{ name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv'] }
		]
	});
	if (res.canceled || !res.filePaths.length) {
		return { success: false, error: 'cancelled' };
	}
	const filePath = res.filePaths[0];
	return { success: true, file: { id: '', name: path.basename(filePath), path: filePath } };
});

ipcMain.handle('select-xcp-file', async () => {
	const win = BrowserWindow.getFocusedWindow();
	const { canceled, filePaths } = await dialog.showOpenDialog(win, {
		title: 'Vicon XCPファイルを選択',
		filters: [{ name: 'Vicon XCP', extensions: ['xcp'] }],
		properties: ['openFile']
	});
	if (canceled || !filePaths || !filePaths.length) {
		return { success: false };
	}
	return { success: true, filePath: filePaths[0] };
});

ipcMain.handle('read-text-file', async (_, filePath) => {
	try {
		const content = await fs.promises.readFile(filePath, 'utf8');
		return { success: true, content };
	} catch (error) {
		return { success: false, error: error.message };
	}
});

ipcMain.handle('select-file', async (_, options) => {
	try {
		const res = await dialog.showOpenDialog(mainWindow, {
			title: options.title || 'ファイルを選択',
			properties: ['openFile'],
			filters: options.filters || [{ name: 'All Files', extensions: ['*'] }]
		});
		if (res.canceled || !res.filePaths.length) {
			return { success: false, error: 'cancelled' };
		}
		return { success: true, filePath: res.filePaths[0] };
	} catch (error) {
		return { success: false, error: error.message };
	}
});

ipcMain.handle('save-file', async (_, options) => {
	try {
		const res = await dialog.showSaveDialog(mainWindow, {
			title: options.title || 'ファイルを保存',
			filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
			defaultPath: options.defaultPath || ''
		});
		if (res.canceled || !res.filePath) {
			return { success: false, error: 'cancelled' };
		}
		return { success: true, filePath: res.filePath };
	} catch (error) {
		return { success: false, error: error.message };
	}
});

ipcMain.handle('write-text-file', async (_, filePath, content) => {
	try {
		await fs.promises.writeFile(filePath, content, 'utf8');
		return { success: true };
	} catch (error) {
		return { success: false, error: error.message };
	}
});

ipcMain.handle('resolve-app-path', (_, relativePath) => {
	const path = require('path');
	return path.join(__dirname, relativePath);
});

ipcMain.handle('write-binary-file', async (_, filePath, content) => {
	try {
		await fs.promises.writeFile(filePath, content);
		return { success: true };
	} catch (error) {
		return { success: false, error: error.message };
	}
});

ipcMain.handle('show-message-box', async (_, options) => {
	return dialog.showMessageBox(mainWindow, options);
});

ipcMain.handle('triangulate-vicon', async (_, payload) => {
	try {
		const result = analysisEngine.triangulateWithViconCalibration(payload);
		return result;
	} catch (error) {
		return { success: false, error: error.message };
	}
});

ipcMain.handle('select-image-file', async () => {
	const res = await dialog.showOpenDialog(mainWindow, {
		title: '画像ファイルを選択',
		properties: ['openFile'],
		filters: [
			{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }
		]
	});
	if (res.canceled || !res.filePaths.length) {
		return { success: false, error: 'cancelled' };
	}
	const filePath = res.filePaths[0];
	return { success: true, file: { name: path.basename(filePath), path: filePath } };
});

ipcMain.handle('get-video-info-opencv', async (_evt, videoPath) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	if (!videoPath) return { success: false, error: 'no video path' };
	try {
		// ここでネイティブ側のAPIを呼び出す想定
		if (typeof cv.getVideoInfo !== 'function') {
			return { success: false, error: 'getVideoInfo not implemented' };
		}
		const info = cv.getVideoInfo(videoPath);
		return { success: true, info };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// FFprobeによる動画情報取得（OpenCVフォールバック用）
ipcMain.handle('get-video-info-ffprobe', async (_evt, videoPath) => {
	if (!videoPath) return { success: false, error: 'no video path' };
	try {
		const { execFile } = require('child_process');

		// ffprobe-static（package.json に正式登録済み）を使用
		// パッケージ版では asar.unpacked 内のパスに変換
		let ffprobePath = require('ffprobe-static').path;
		if (app.isPackaged && ffprobePath.includes('app.asar')) {
			ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked');
		}
		console.log('[ffprobe] path:', ffprobePath);

		return new Promise((resolve) => {
			execFile(ffprobePath, [
				'-v', 'error',
				'-select_streams', 'v:0',
				'-show_entries', 'stream=width,height,nb_frames,avg_frame_rate,duration',
				'-of', 'json',
				videoPath
			], (error, stdout, stderr) => {
				if (error) {
					resolve({ success: false, error: error.message });
					return;
				}
				try {
					const json = JSON.parse(stdout);
					if (!json.streams || !json.streams[0]) {
						resolve({ success: false, error: 'no video stream found' });
						return;
					}
					const stream = json.streams[0];
					const width = parseInt(stream.width);
					const height = parseInt(stream.height);
					const duration = parseFloat(stream.duration);

					// fps計算 "30000/1001" 形式など
					let fps = 0;
					if (stream.avg_frame_rate) {
						const parts = stream.avg_frame_rate.split('/');
						if (parts.length === 2) {
							fps = parseInt(parts[0]) / parseInt(parts[1]);
						} else {
							fps = parseFloat(stream.avg_frame_rate);
						}
					}

					// nb_framesがメタデータにない場合は duration * fps で計算（やむを得ないフォールバック）
					// ただしOpenCV失敗時の対策としては、これを信頼するしかない
					let frameCount = parseInt(stream.nb_frames);
					if (isNaN(frameCount) && duration > 0 && fps > 0) {
						frameCount = Math.round(duration * fps);
					}

					resolve({
						success: true,
						info: {
							width,
							height,
							fps,
							frameCount,
							duration
						}
					});
				} catch (e) {
					resolve({ success: false, error: 'parse error: ' + e.message });
				}
			});
		});
	} catch (e) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle('undistort-image', async (_evt, videoPath, frameNumber, cameraMatrix, distCoeffs, rvec) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	if (!videoPath) return { success: false, error: 'no video path' };
	try {
		if (typeof cv.undistortImage !== 'function') {
			return { success: false, error: 'undistortImage not implemented' };
		}
		const result = cv.undistortImage(videoPath, frameNumber, cameraMatrix, distCoeffs, rvec);
		return result;
	} catch (error) {
		return { success: false, error: error.message || String(error) };
	}
});

// FFmpegによるフレーム抽出（推奨）
// 引数: videoPath, frameNumber, fps (optional)
ipcMain.handle('extract-frame-ffmpeg', async (_evt, videoPath, frameNumber, fps = null) => {
	if (!videoPath) return { success: false, error: 'no video path' };
	if (!frameNumber || frameNumber < 1) return { success: false, error: 'invalid frame number' };

	try {
		const { execFile } = require('child_process');
		const { promisify } = require('util');
		const execFileAsync = promisify(execFile);

		// ffmpegのパスを取得
		let ffmpegPath;
		try {
			ffmpegPath = require('ffmpeg-static');
			console.log('[ffmpeg] Using bundled ffmpeg:', ffmpegPath);
		} catch (e) {
			// フォールバック: PATH環境変数から
			ffmpegPath = 'ffmpeg';
			if (process.platform === 'win32' && fs.existsSync('C:\\ffmpeg\\bin\\ffmpeg.exe')) {
				ffmpegPath = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
			}
		}

		// 一時ファイルパス
		const tmpDir = app.getPath('temp');
		const tmpFile = path.join(tmpDir, `frame_${Date.now()}_${frameNumber}.jpg`);

		// フレーム番号から正確な位置を計算
		// select='eq(n,frameNumber-1)' を使用してフレーム番号で正確に指定
		// これによりFPS情報が不要になる
		await execFileAsync(ffmpegPath, [
			'-hide_banner',
			'-loglevel', 'error',
			'-i', videoPath,
			'-vf', `select='eq(n\\,${frameNumber - 1})'`,
			'-vframes', '1',
			'-q:v', '2',
			'-y',
			tmpFile
		], { maxBuffer: 50 * 1024 * 1024 }); // 50MB buffer

		// 画像をBase64に変換
		const imageBuffer = fs.readFileSync(tmpFile);
		const base64 = imageBuffer.toString('base64');
		const dataUrl = `data:image/jpeg;base64,${base64}`;

		// 一時ファイル削除
		try {
			fs.unlinkSync(tmpFile);
		} catch (e) {
			console.warn('[ffmpeg] Failed to delete temp file:', e);
		}

		return { success: true, dataUrl };
	} catch (e) {
		console.error('[ffmpeg] Frame extraction failed:', e);
		return { success: false, error: e.message };
	}
});

// OpenCVによるフレーム抽出（レガシー、CharuCo検出時のみ使用）
ipcMain.handle('extract-frame-opencv', async (_evt, videoPath, frameNumber) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	if (!videoPath) return { success: false, error: 'no video path' };
	try {
		if (typeof cv.extractFrame !== 'function') {
			return { success: false, error: 'extractFrame not implemented' };
		}
		const result = cv.extractFrame(videoPath, frameNumber);
		return result; // Base64文字列をそのまま返す（最も効率的）
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ディスクキャッシュ設定
const diskCacheDir = path.join(app.getPath('userData'), 'frame-cache');

// ディスクキャッシュディレクトリの確保
function ensureDiskCacheDir() {
	if (!fs.existsSync(diskCacheDir)) {
		fs.mkdirSync(diskCacheDir, { recursive: true });
	}
}

// キャッシュキーをファイル名に変換（パスの特殊文字をエスケープ）
function cacheKeyToFilename(key) {
	return key.replace(/[:\\\/]/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '') + '.jpg';
}

// ディスクキャッシュに書き込み
ipcMain.handle('write-disk-cache', async (_evt, key, base64Data) => {
	try {
		ensureDiskCacheDir();
		const filename = cacheKeyToFilename(key);
		const filePath = path.join(diskCacheDir, filename);

		// Base64データから "data:image/jpeg;base64," を除去
		const base64Only = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
		const buffer = Buffer.from(base64Only, 'base64');

		fs.writeFileSync(filePath, buffer);
		return { success: true };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ディスクキャッシュから読み込み
ipcMain.handle('read-disk-cache', async (_evt, key) => {
	try {
		ensureDiskCacheDir();
		const filename = cacheKeyToFilename(key);
		const filePath = path.join(diskCacheDir, filename);

		if (fs.existsSync(filePath)) {
			// 非同期読み込みに変更してUIフリーズを回避
			const buffer = await fs.promises.readFile(filePath);
			const base64 = buffer.toString('base64');
			return { success: true, data: 'data:image/jpeg;base64,' + base64 };
		}
		return { success: false, error: 'not found' };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ディスクキャッシュをクリア
ipcMain.handle('clear-disk-cache', async () => {
	try {
		ensureDiskCacheDir();
		const files = fs.readdirSync(diskCacheDir);
		for (const file of files) {
			if (file.endsWith('.jpg')) {
				fs.unlinkSync(path.join(diskCacheDir, file));
			}
		}
		return { success: true, cleared: files.length };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ディスクキャッシュ状況を取得
ipcMain.handle('get-disk-cache-info', async () => {
	try {
		ensureDiskCacheDir();
		const files = fs.readdirSync(diskCacheDir).filter(f => f.endsWith('.jpg'));
		let totalSize = 0;
		for (const file of files) {
			const stat = fs.statSync(path.join(diskCacheDir, file));
			totalSize += stat.size;
		}
		return { success: true, count: files.length, sizeMB: (totalSize / 1024 / 1024).toFixed(2) };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ディスクベースのフレーム抽出（全フレームをTempディレクトリに保存）
const os = require('os');
let extractionCancelFlag = {};  // videoPath -> boolean
let activeFrameProcessors = {}; // videoPath -> ChildProcess

ipcMain.handle('extract-all-frames-to-disk', async (event, videoPath, options = {}) => {
	// OpenCVのチェックは子プロセスで行うためここでは必須ではないが、
	// ファイル存在チェック等はしてもよい。
	if (!videoPath) return { success: false, error: 'no video path' };

	const quality = options.quality || 85;
	const win = BrowserWindow.fromWebContents(event.sender);

	try {
		// 一意のTempディレクトリを作成
		const crypto = require('crypto');
		const hash = crypto.createHash('md5').update(videoPath).digest('hex').substring(0, 8);
		const outputDir = path.join(os.tmpdir(), `mdigitizer_frames_${hash}`);

		// 既にディレクトリが存在し、完了マーカーがあればスキップ
		const completeMarker = path.join(outputDir, '.complete');
		if (fs.existsSync(completeMarker)) {
			return { success: true, outputDir, skipped: true };
		}

		// ディレクトリを作成
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		// キャンセルフラグをリセット
		extractionCancelFlag[videoPath] = false;

		// 既存プロセスがあれば停止
		if (activeFrameProcessors[videoPath]) {
			try { activeFrameProcessors[videoPath].kill(); } catch (e) { }
			delete activeFrameProcessors[videoPath];
		}

		const { fork } = require('child_process');
		const processorPath = path.join(__dirname, 'src', 'frame-processor.js');

		return new Promise((resolve) => {
			const child = fork(processorPath, [], { silent: false });
			activeFrameProcessors[videoPath] = child;

			child.on('message', (msg) => {
				if (msg.type === 'progress') {
					if (win && !win.isDestroyed()) {
						win.webContents.send('frame-extraction-progress', {
							videoPath,
							current: msg.current,
							total: msg.total,
							percent: msg.percent
						});
					}
				} else if (msg.type === 'complete') {
					if (activeFrameProcessors[videoPath] === child) {
						delete activeFrameProcessors[videoPath];
					}
					child.kill();
					resolve({ success: true, outputDir, totalFrames: msg.count });
				} else if (msg.type === 'error') {
					if (activeFrameProcessors[videoPath] === child) {
						delete activeFrameProcessors[videoPath];
					}
					child.kill();
					resolve({ success: false, error: msg.error });
				}
			});

			child.on('exit', (code) => {
				if (activeFrameProcessors[videoPath] === child) {
					delete activeFrameProcessors[videoPath];
					if (code !== 0 && code !== null) {
						resolve({ success: false, error: 'Process exited with code ' + code });
					}
				}
			});

			child.on('error', (err) => {
				if (activeFrameProcessors[videoPath] === child) {
					delete activeFrameProcessors[videoPath];
				}
				resolve({ success: false, error: err.message });
			});

			// 実行開始
			child.send({ command: 'extract', videoPath, outputDir, quality, totalFrames: options.totalFrames });
		});

	} catch (e) {
		return { success: false, error: e.message };
	}
});

// フレーム抽出のキャンセル
ipcMain.handle('cancel-frame-extraction', async (_evt, videoPath) => {
	if (activeFrameProcessors[videoPath]) {
		try { activeFrameProcessors[videoPath].kill(); } catch (e) { }
		delete activeFrameProcessors[videoPath];
	}
	extractionCancelFlag[videoPath] = true;
	return { success: true };
});

// ディスクキャッシュからフレームを読み込み（file://パスを返す）
ipcMain.handle('get-cached-frame-path', async (_evt, videoPath, frameNumber) => {
	try {
		const crypto = require('crypto');
		const hash = crypto.createHash('md5').update(videoPath).digest('hex').substring(0, 8);
		const outputDir = path.join(os.tmpdir(), `mdigitizer_frames_${hash}`);
		const framePath = path.join(outputDir, `frame_${String(frameNumber).padStart(5, '0')}.jpg`);

		if (fs.existsSync(framePath)) {
			return { success: true, path: framePath };
		}
		return { success: false, error: 'frame not cached' };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// キャッシュディレクトリの存在確認
ipcMain.handle('check-frame-cache-exists', async (_evt, videoPath) => {
	try {
		const crypto = require('crypto');
		const hash = crypto.createHash('md5').update(videoPath).digest('hex').substring(0, 8);
		const outputDir = path.join(os.tmpdir(), `mdigitizer_frames_${hash}`);
		const completeMarker = path.join(outputDir, '.complete');

		if (fs.existsSync(completeMarker)) {
			return { success: true, exists: true, outputDir };
		}
		return { success: true, exists: false };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// Charuco検出用IPCハンドラー（パラメータ対応版）
ipcMain.handle('detect-charuco-board', async (_evt, params, maybeFrame) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };

	// 後方互換性のため: 旧シグネチャ (videoPath, frameNumber) も許容
	let videoPath;
	let frameNumber;
	let boardConfig = {};

	let imageBase64 = null;

	if (params && typeof params === 'object' && !Array.isArray(params) && 'videoPath' in params) {
		// 新形式: { videoPath, frameNumber, boardConfig, imageBase64 }
		videoPath = params.videoPath;
		frameNumber = params.frameNumber;
		boardConfig = params.boardConfig || {};
		imageBase64 = params.imageBase64 || null;
		console.log('[CHARUCO] New format params received, imageBase64:', imageBase64 ? `${imageBase64.substring(0, 50)}... (length: ${imageBase64.length})` : 'null');
	} else {
		// 旧形式: (videoPath, frameNumber)
		videoPath = params;
		frameNumber = maybeFrame;
		console.log('[CHARUCO] Old format params received');
	}

	if (!videoPath) return { success: false, error: 'no video path' };

	try {
		// ArUco機能が利用可能かテスト
		if (videoPath === '' || frameNumber <= 0) {
			return { success: true, test: true, message: 'ArUco functionality available' };
		}

		if (typeof cv.detectCharucoBoard !== 'function') {
			return { success: false, error: 'detectCharucoBoard not implemented' };
		}

		const crypto = require('crypto');

		// Canvas画像（imageBase64）が渡された場合は優先的に使用
		if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.startsWith('data:image/')) {
			console.log('[CHARUCO] Using imageBase64, saving to temp file...');
			// Base64画像を一時ファイルに保存
			const tempDir = path.join(os.tmpdir(), 'mdigitizer_charuco_temp');
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true });
			}
			const tempImagePath = path.join(tempDir, `charuco_frame_${Date.now()}.jpg`);

			// data:image/jpeg;base64,XXXX から XXXX 部分を抽出
			const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
			const buffer = Buffer.from(base64Data, 'base64');
			fs.writeFileSync(tempImagePath, buffer);

			boardConfig.frameCachePath = tempImagePath;
			console.log('[CHARUCO] Temp image saved to:', tempImagePath);
		} else {
			console.log('[CHARUCO] No imageBase64, checking disk cache...');
			// Canvas画像がない場合はディスクキャッシュを確認
			const hash = crypto.createHash('md5').update(videoPath).digest('hex').substring(0, 8);
			const cacheDir = path.join(os.tmpdir(), `mdigitizer_frames_${hash}`);
			const framePath = path.join(cacheDir, `frame_${String(frameNumber).padStart(5, '0')}.jpg`);

			if (fs.existsSync(framePath)) {
				// キャッシュ画像が存在する場合はそのパスを使用
				boardConfig.frameCachePath = framePath;
				console.log('[CHARUCO] Using disk cache:', framePath);
			} else {
				console.log('[CHARUCO] No cache found, native will try to open video directly');
			}
		}

		console.log('[CHARUCO] Final boardConfig:', JSON.stringify(boardConfig));
		// 設定をネイティブに渡す
		const result = cv.detectCharucoBoard(videoPath, frameNumber, boardConfig);
		return { success: true, ...result };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// Calibration IPC handlers (ChArUco)
ipcMain.handle('calib-start', async () => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.startCharucoCalibrationSession !== 'function') {
			return { success: false, error: 'startCharucoCalibrationSession not implemented' };
		}
		return cv.startCharucoCalibrationSession();
	} catch (e) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle('calib-capture', async (_evt, params, maybeFrame) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };

	// 後方互換: 旧シグネチャ (videoPath, frameNumber) も許容
	let videoPath;
	let frameNumber;
	let boardConfig = {};
	let imageBase64 = null;

	if (params && typeof params === 'object' && !Array.isArray(params) && 'videoPath' in params) {
		videoPath = params.videoPath;
		frameNumber = params.frameNumber;
		boardConfig = params.boardConfig || {};
		imageBase64 = params.imageBase64 || null;
		console.log('[CALIB-CAPTURE] New format - boardConfig from params:', JSON.stringify(params.boardConfig));
	} else {
		videoPath = params;
		frameNumber = maybeFrame;
		console.log('[CALIB-CAPTURE] Old format - using defaults');
	}
	console.log('[CALIB-CAPTURE] Parsed boardConfig:', JSON.stringify(boardConfig));
	console.log('[CALIB-CAPTURE] imageBase64 received:', imageBase64 ? `length=${imageBase64.length}` : 'null');

	try {
		if (typeof cv.captureCharucoSample !== 'function') {
			return { success: false, error: 'captureCharucoSample not implemented' };
		}

		// Canvas画像（imageBase64）が渡された場合は優先的に使用
		if (imageBase64 && typeof imageBase64 === 'string' && imageBase64.startsWith('data:image/')) {
			const tempDir = path.join(os.tmpdir(), 'mdigitizer_charuco_temp');
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true });
			}
			const tempImagePath = path.join(tempDir, `calib_frame_${Date.now()}.jpg`);
			const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
			const buffer = Buffer.from(base64Data, 'base64');
			fs.writeFileSync(tempImagePath, buffer);
			boardConfig.frameCachePath = tempImagePath;
			console.log('[CALIB-CAPTURE] Using imageBase64, saved to:', tempImagePath);
		}

		console.log('[CALIB-CAPTURE] boardConfig:', JSON.stringify(boardConfig));
		const result = cv.captureCharucoSample(videoPath, frameNumber, boardConfig);
		console.log('[CALIB-CAPTURE] Result:', JSON.stringify(result));
		return result;
	} catch (e) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle('calib-compute', async () => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.computeCharucoCalibration !== 'function') {
			return { success: false, error: 'computeCharucoCalibration not implemented' };
		}
		return cv.computeCharucoCalibration();
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ChArUco単眼キャリブレーション: 外れビュー除外付き再計算
ipcMain.handle('calib-compute-exclude', async (_evt, args) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.computeCharucoCalibrationWithExclusions !== 'function') {
			return { success: false, error: 'computeCharucoCalibrationWithExclusions not implemented' };
		}
		const exclude = args && Array.isArray(args.exclude) ? args.exclude : [];
		return cv.computeCharucoCalibrationWithExclusions(exclude);
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ChArUcoキャリブレーション: 点群バッファ復元（保存データから除外計算を可能にする）
ipcMain.handle('restore-calibration-buffers', async (_evt, params) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.restoreCalibrationBuffers !== 'function') {
			return { success: false, error: 'restoreCalibrationBuffers not implemented' };
		}
		return cv.restoreCalibrationBuffers(params);
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// Stereo Charuco calibration IPC handlers
// 内部パラメータはオプション：ない場合は同時推定モードで動作
ipcMain.handle('charuco-stereo-start', async (_evt, params) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.startCharucoStereoCalibrationSession !== 'function') {
			return { success: false, error: 'startCharucoStereoCalibrationSession not implemented' };
		}
		const { K1, dist1, K2, dist2 } = params || {};

		// 内部パラメータがある場合は渡す、ない場合は引数なしで呼び出し（同時推定モード）
		if (Array.isArray(K1) && Array.isArray(dist1) && Array.isArray(K2) && Array.isArray(dist2)) {
			return cv.startCharucoStereoCalibrationSession(K1, dist1, K2, dist2);
		} else {
			// 内部パラメータなし - 同時推定モード
			return cv.startCharucoStereoCalibrationSession();
		}
	} catch (e) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle('charuco-stereo-capture', async (_evt, params) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.captureCharucoStereoSample !== 'function') {
			return { success: false, error: 'captureCharucoStereoSample not implemented' };
		}
		const { videoPath1, videoPath2, frameNumber, boardConfig, imageBase64_1, imageBase64_2 } = params || {};
		if (!videoPath1 || !videoPath2 || !frameNumber) {
			return { success: false, error: 'invalid stereo capture params' };
		}

		// 拡張boardConfigを作成
		const extendedConfig = { ...(boardConfig || {}) };

		// Canvas画像（imageBase64）が渡された場合は一時ファイルに保存
		const tempDir = path.join(os.tmpdir(), 'mdigitizer_charuco_temp');
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}

		// Cam1の画像
		if (imageBase64_1 && typeof imageBase64_1 === 'string' && imageBase64_1.startsWith('data:image/')) {
			const tempImagePath1 = path.join(tempDir, `stereo_calib_cam1_${Date.now()}.jpg`);
			const base64Data1 = imageBase64_1.replace(/^data:image\/\w+;base64,/, '');
			const buffer1 = Buffer.from(base64Data1, 'base64');
			fs.writeFileSync(tempImagePath1, buffer1);
			extendedConfig.frameCachePath1 = tempImagePath1;
			console.log('[STEREO-CAPTURE] Cam1 image saved to:', tempImagePath1);
		}

		// Cam2の画像
		if (imageBase64_2 && typeof imageBase64_2 === 'string' && imageBase64_2.startsWith('data:image/')) {
			const tempImagePath2 = path.join(tempDir, `stereo_calib_cam2_${Date.now()}.jpg`);
			const base64Data2 = imageBase64_2.replace(/^data:image\/\w+;base64,/, '');
			const buffer2 = Buffer.from(base64Data2, 'base64');
			fs.writeFileSync(tempImagePath2, buffer2);
			extendedConfig.frameCachePath2 = tempImagePath2;
			console.log('[STEREO-CAPTURE] Cam2 image saved to:', tempImagePath2);
		}

		console.log('[STEREO-CAPTURE] extendedConfig:', JSON.stringify(extendedConfig));
		return cv.captureCharucoStereoSample(videoPath1, videoPath2, frameNumber, extendedConfig);
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// Video Optimizer integration
const videoOptimizer = require('./src/video-optimizer.js');

ipcMain.handle('create-proxy-video', async (event, inputPath) => {
	try {
		const win = BrowserWindow.fromWebContents(event.sender);

		// 進捗通知用コールバック
		const onProgress = (percent) => {
			if (win && !win.isDestroyed()) {
				win.webContents.send('proxy-progress', { path: inputPath, percent });
			}
		};

		console.log(`[Main] Starting proxy generation for: ${inputPath}`);
		const outputPath = await videoOptimizer.createProxy(inputPath, null, onProgress);
		console.log(`[Main] Proxy generation complete: ${outputPath}`);

		return { success: true, path: outputPath };
	} catch (e) {
		console.error('[Main] Proxy generation failed:', e);
		return { success: false, error: e.message };
	}
});

ipcMain.handle('cancel-proxy-video', async (event, inputPath) => {
	try {
		const result = videoOptimizer.cancel(inputPath);
		return { success: true, cancelled: result };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle('charuco-stereo-compute', async () => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.computeCharucoStereoCalibration !== 'function') {
			return { success: false, error: 'computeCharucoStereoCalibration not implemented' };
		}
		return cv.computeCharucoStereoCalibration();
	} catch (e) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle('charuco-stereo-compute-exclude', async (_evt, args) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.computeCharucoStereoCalibrationWithExclusions !== 'function') {
			return { success: false, error: 'computeCharucoStereoCalibrationWithExclusions not implemented' };
		}
		const exclude = args && Array.isArray(args.exclude) ? args.exclude : [];
		return cv.computeCharucoStereoCalibrationWithExclusions(exclude);
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// Stereo 3D reconstruction (triangulatePoints ベース)
ipcMain.handle('charuco-project-points-inverse', async (_evt, params) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.projectPointsInverse !== 'function') {
			return { success: false, error: 'projectPointsInverse not implemented' };
		}
		return cv.projectPointsInverse(
			params.imagePoints,
			params.cameraMatrix,
			params.distCoeffs,
			params.rvec,
			params.tvec
		);
	} catch (e) {
		return { success: false, error: e.message };
	}
});

ipcMain.handle('charuco-stereo-triangulate', async (_evt, params) => {
	const cv = ensureOpenCVLoaded();
	if (!cv) return { success: false, error: 'opencv module not loaded' };
	try {
		if (typeof cv.triangulateStereoPoints !== 'function') {
			return { success: false, error: 'triangulateStereoPoints not implemented' };
		}
		const {
			pointsCam1,
			pointsCam2,
			K1, dist1,
			K2, dist2,
			R, T,
		} = params || {};

		if (
			!Array.isArray(pointsCam1) || !Array.isArray(pointsCam2) ||
			!Array.isArray(K1) || !Array.isArray(dist1) ||
			!Array.isArray(K2) || !Array.isArray(dist2) ||
			!Array.isArray(R) || !Array.isArray(T)
		) {
			return { success: false, error: 'invalid triangulation params' };
		}

		return cv.triangulateStereoPoints(
			pointsCam1,
			pointsCam2,
			K1, dist1,
			K2, dist2,
			R, T
		);
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ====== 動画パスの相対パス/絶対パス変換ユーティリティ ======

/**
 * 絶対パスを相対パスに変換
 * @param {string} absolutePath - 変換する絶対パス
 * @param {string} projectFilePath - 基準となるプロジェクトファイルのパス
 * @returns {string} 相対パス（変換失敗時は元のパス）
 */
function convertToRelativePath(absolutePath, projectFilePath) {
	if (!absolutePath || !projectFilePath) return absolutePath;
	try {
		const projectDir = path.dirname(projectFilePath);
		const relativePath = path.relative(projectDir, absolutePath);
		return relativePath;
	} catch (e) {
		console.error('[MAIN] Failed to convert to relative path:', e.message);
		return absolutePath;
	}
}

/**
 * 相対パスを絶対パスに変換
 * @param {string} relativePath - 変換する相対パス
 * @param {string} projectFilePath - 基準となるプロジェクトファイルのパス
 * @returns {string} 絶対パス（変換失敗時は元のパス）
 */
function convertToAbsolutePath(relativePath, projectFilePath) {
	if (!relativePath || !projectFilePath) return relativePath;
	// 既に絶対パスの場合はそのまま返す
	if (path.isAbsolute(relativePath)) return relativePath;
	try {
		const projectDir = path.dirname(projectFilePath);
		const absolutePath = path.resolve(projectDir, relativePath);
		return absolutePath;
	} catch (e) {
		console.error('[MAIN] Failed to convert to absolute path:', e.message);
		return relativePath;
	}
}

/**
 * videoFilesオブジェクト内のパスを変換
 * @param {Object} videoFiles - 動画ファイル情報オブジェクト
 * @param {string} projectFilePath - プロジェクトファイルのパス
 * @param {boolean} toRelative - true:相対パスに変換、false:絶対パスに変換
 * @returns {Object} パス変換後のvideoFilesオブジェクト
 */
function convertVideoFilePaths(videoFiles, projectFilePath, toRelative) {
	if (!videoFiles) return videoFiles;

	const converter = toRelative ? convertToRelativePath : convertToAbsolutePath;
	const result = JSON.parse(JSON.stringify(videoFiles)); // ディープコピー

	// calibration
	if (result.calibration) {
		if (result.calibration.cam1 && result.calibration.cam1.path) {
			result.calibration.cam1.path = converter(result.calibration.cam1.path, projectFilePath);
		}
		if (result.calibration.cam2 && result.calibration.cam2.path) {
			result.calibration.cam2.path = converter(result.calibration.cam2.path, projectFilePath);
		}
	}

	// motion
	if (result.motion) {
		if (result.motion.cam1 && result.motion.cam1.path) {
			result.motion.cam1.path = converter(result.motion.cam1.path, projectFilePath);
		}
		if (result.motion.cam2 && result.motion.cam2.path) {
			result.motion.cam2.path = converter(result.motion.cam2.path, projectFilePath);
		}
	}

	return result;
}

/**
 * videoFileListsオブジェクト内のパスを変換
 * @param {Object} videoFileLists - 動画ファイルリストオブジェクト
 * @param {string} projectFilePath - プロジェクトファイルのパス
 * @param {boolean} toRelative - true:相対パスに変換、false:絶対パスに変換
 * @returns {Object} パス変換後のvideoFileListsオブジェクト
 */
function convertVideoFileListsPaths(videoFileLists, projectFilePath, toRelative) {
	if (!videoFileLists) return videoFileLists;

	const converter = toRelative ? convertToRelativePath : convertToAbsolutePath;
	const result = {};

	Object.keys(videoFileLists).forEach(key => {
		if (Array.isArray(videoFileLists[key])) {
			result[key] = videoFileLists[key].map(file => {
				if (file && file.path) {
					return { ...file, path: converter(file.path, projectFilePath) };
				}
				return file;
			});
		} else {
			result[key] = videoFileLists[key];
		}
	});

	return result;
}

// ====== プロジェクトファイルIPCハンドラー ======

ipcMain.handle('save-project-file', async (_evt, data) => {
	const res = await dialog.showSaveDialog(mainWindow, {
		title: 'プロジェクトを保存',
		filters: [{ name: 'MotionDigitizer Project', extensions: ['mdp'] }],
		defaultPath: 'project.mdp'
	});
	if (res.canceled || !res.filePath) return { success: false, error: 'cancelled' };
	try {
		console.error(`[MAIN] ${new Date().toISOString()} - Saving NEW project to: ${res.filePath}`);

		// 動画パスを相対パスに変換
		const dataToSave = { ...data };
		if (dataToSave.videoFiles) {
			dataToSave.videoFiles = convertVideoFilePaths(dataToSave.videoFiles, res.filePath, true);
		}
		if (dataToSave.videoFileLists) {
			dataToSave.videoFileLists = convertVideoFileListsPaths(dataToSave.videoFileLists, res.filePath, true);
		}

		const jsonString = JSON.stringify(dataToSave);
		await fs.promises.writeFile(res.filePath, jsonString, 'utf-8');
		return { success: true, path: res.filePath };
	} catch (e) {
		console.error('[MAIN] Save error:', e.message);
		return { success: false, error: e.message };
	}
});

// 新規: 指定defaultPathでダイアログ表示してプロジェクト保存
ipcMain.handle('save-project-file-with-dialog', async (_evt, args) => {
	try {
		const data = args && args.data;
		const defaultPath = args && args.defaultPath;
		const res = await dialog.showSaveDialog(mainWindow, {
			title: 'プロジェクトを保存',
			filters: [{ name: 'MotionDigitizer Project', extensions: ['mdp'] }],
			defaultPath: defaultPath || 'project.mdp'
		});
		if (res.canceled || !res.filePath) return { success: false, error: 'cancelled' };
		console.log(`[MAIN] ${new Date().toISOString()} - Saving project with dialog to: ${res.filePath}`);

		// 動画パスを相対パスに変換
		const dataToSave = { ...data };
		if (dataToSave.videoFiles) {
			dataToSave.videoFiles = convertVideoFilePaths(dataToSave.videoFiles, res.filePath, true);
		}
		if (dataToSave.videoFileLists) {
			dataToSave.videoFileLists = convertVideoFileListsPaths(dataToSave.videoFileLists, res.filePath, true);
		}

		await fs.promises.writeFile(res.filePath, JSON.stringify(dataToSave), 'utf-8');
		return { success: true, path: res.filePath };
	} catch (e) {
		return { success: false, error: e.message };
	}
});
// 新規: アプリケーションのグローバル設定を保存
ipcMain.handle('save-app-settings', async (_evt, settings) => {
	try {
		const userDataPath = app.getPath('userData');
		const configPath = path.join(userDataPath, 'app-settings.json');
		let currentSettings = {};

		// 既存の設定があれば読み込んでマージする
		if (fs.existsSync(configPath)) {
			try {
				const fileData = await fs.promises.readFile(configPath, 'utf-8');
				currentSettings = JSON.parse(fileData);
			} catch (err) {
				console.error('[MAIN] Failed to read existing app-settings.json:', err.message);
			}
		}

		// 新しい設定をマージ
		const newSettings = { ...currentSettings, ...settings };
		await fs.promises.writeFile(configPath, JSON.stringify(newSettings, null, 2), 'utf-8');
		console.log(`[MAIN] Saved app settings to: ${configPath}`);
		return { success: true };
	} catch (e) {
		console.error('[MAIN] App settings save error:', e.message);
		return { success: false, error: e.message };
	}
});

// 新規: アプリケーションのグローバル設定を読み込み
ipcMain.handle('load-app-settings', async (_evt) => {
	try {
		const userDataPath = app.getPath('userData');
		const configPath = path.join(userDataPath, 'app-settings.json');

		if (!fs.existsSync(configPath)) {
			// 設定ファイルがない場合は空のオブジェクトを返す（デフォルト値を使用させる）
			return { success: true, data: {} };
		}

		const fileData = await fs.promises.readFile(configPath, 'utf-8');
		const data = JSON.parse(fileData);
		return { success: true, data };
	} catch (e) {
		console.error('[MAIN] App settings load error:', e.message);
		return { success: false, error: e.message };
	}
});

// 新規: 既存パスに上書き保存（ダイアログなし）
ipcMain.handle('overwrite-project-file', async (_evt, args) => {
	try {
		const targetPath = args && args.path;
		const data = args && args.data;

		console.log(`[MAIN] ${new Date().toISOString()} - Overwriting project file: ${targetPath}`);

		if (!targetPath) {
			console.error('[MAIN] Overwrite failed: path is required');
			return { success: false, error: 'path is required' };
		}

		// 動画パスを相対パスに変換
		const dataToSave = { ...data };
		if (dataToSave.videoFiles) {
			dataToSave.videoFiles = convertVideoFilePaths(dataToSave.videoFiles, targetPath, true);
		}
		if (dataToSave.videoFileLists) {
			dataToSave.videoFileLists = convertVideoFileListsPaths(dataToSave.videoFileLists, targetPath, true);
		}

		await fs.promises.writeFile(targetPath, JSON.stringify(dataToSave), 'utf-8');
		console.log(`[MAIN] ${new Date().toISOString()} - Overwrite SUCCESS`);
		return { success: true, path: targetPath };
	} catch (e) {
		console.error(`[MAIN] Overwrite ERROR: ${e.message}`);
		return { success: false, error: e.message };
	}
});

ipcMain.handle('load-project-file', async (event, specifiedPath) => {
	console.log('[MAIN] load-project-file called, specifiedPath =', specifiedPath);
	let filePath;

	if (specifiedPath) {
		// ファイルパスが指定された場合はダイアログを開かない
		console.log('[MAIN] Using specified path, no dialog');
		filePath = specifiedPath;
	} else {
		// ファイルパスが指定されていない場合はダイアログを開く
		console.log('[MAIN] No path specified, showing dialog');
		const res = await dialog.showOpenDialog(mainWindow, {
			title: 'プロジェクトを読み込み',
			properties: ['openFile'],
			filters: [{ name: 'MotionDigitizer Project', extensions: ['mdp'] }]
		});
		if (res.canceled || !res.filePaths.length) return { success: false, error: 'cancelled' };
		filePath = res.filePaths[0];
	}

	try {

		const content = await fs.promises.readFile(filePath, 'utf-8');
		const data = JSON.parse(content);

		// 相対パスを絶対パスに復元
		if (data.videoFiles) {
			data.videoFiles = convertVideoFilePaths(data.videoFiles, filePath, false);
		}
		if (data.videoFileLists) {
			data.videoFileLists = convertVideoFileListsPaths(data.videoFileLists, filePath, false);
		}

		return { success: true, data, path: filePath };
	} catch (e) {
		console.error('[MAIN] Load project error:', e.message);
		return { success: false, error: e.message };
	}
});

// キャリブレーションデータ保存（.cprm - Camera Parameters）
ipcMain.handle('save-calibration-file', async (_evt, data) => {
	const res = await dialog.showSaveDialog(mainWindow, {
		title: 'キャリブレーションデータを保存',
		filters: [{ name: 'Camera Parameters', extensions: ['cprm'] }],
		defaultPath: 'calibration.cprm'
	});
	if (res.canceled || !res.filePath) return { success: false, error: 'cancelled' };
	try {
		console.log(`[MAIN] Saving calibration data to: ${res.filePath}`);
		const jsonString = JSON.stringify(data, null, 2);
		await fs.promises.writeFile(res.filePath, jsonString, 'utf-8');
		return { success: true, path: res.filePath };
	} catch (e) {
		console.error('[MAIN] Save calibration error:', e.message);
		return { success: false, error: e.message };
	}
});

// キャリブレーションデータ読み込み（.cprm, .cal）
ipcMain.handle('load-calibration-file', async () => {
	const res = await dialog.showOpenDialog(mainWindow, {
		title: 'キャリブレーションデータを読み込み',
		properties: ['openFile'],
		filters: [
			{ name: 'Camera Parameters', extensions: ['cprm'] },
			{ name: 'Calibration Data (Legacy)', extensions: ['cal'] },
			{ name: 'All Supported', extensions: ['cprm', 'cal'] }
		]
	});
	if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
		return { success: false, error: 'cancelled' };
	}
	const filePath = res.filePaths[0];
	try {
		console.log(`[MAIN] Loading calibration data from: ${filePath}`);
		const raw = await fs.promises.readFile(filePath, 'utf-8');
		const data = JSON.parse(raw);
		return { success: true, data, path: filePath };
	} catch (e) {
		console.error('[MAIN] Load calibration error:', e.message);
		return { success: false, error: e.message };
	}
});

// 新規: 任意パスにテキストを書き出すIPC（.rd保存用）
ipcMain.handle('save-rd-file', async (_evt, args) => {
	try {

		const outPath = args && args.path;
		const content = args && args.content;
		if (!outPath || typeof content !== 'string') {
			return { success: false, error: 'invalid arguments' };
		}
		fs.writeFileSync(outPath, content, 'utf-8');

		return { success: true, path: outPath };
	} catch (e) {

		return { success: false, error: e.message };
	}
});

// 新規: ダイアログで保存先とデフォルト名を提示し、選択に応じて保存
ipcMain.handle('save-rd-with-dialog', async (_evt, args) => {
	try {
		const content = args && args.content;
		const setContent = args && args.setContent;
		const defaultPath = args && args.defaultPath; // 例: C:\dir\project.rd
		if (typeof content !== 'string') return { success: false, error: 'invalid content' };
		const res = await dialog.showSaveDialog(mainWindow, {
			title: '.rd を保存',
			filters: [{ name: 'RD File', extensions: ['rd'] }],
			defaultPath: defaultPath || 'project.rd' // プロジェクトファイル名ベースのデフォルト
		});
		if (res.canceled || !res.filePath) return { success: false, error: 'cancelled' };
		fs.writeFileSync(res.filePath, content, 'utf-8');

		// .setファイルも同じディレクトリに保存（Shift-JISエンコーディングで保存）
		let setPath = null;
		if (typeof setContent === 'string') {
			setPath = res.filePath.replace(/\.rd$/i, '.set');
			// Shift-JIS（CP932）で保存（Frame-DIASなどの他のアプリとの互換性のため）
			if (iconv) {
				const shiftJisBuffer = iconv.encode(setContent, 'shift_jis');
				fs.writeFileSync(setPath, shiftJisBuffer);
			} else {
				// iconv-liteが利用できない場合はUTF-8で保存（フォールバック）
				fs.writeFileSync(setPath, setContent, 'utf-8');
			}
		}

		return { success: true, path: res.filePath, setPath: setPath };
	} catch (e) {

		return { success: false, error: e.message };
	}
});

// 3Dキャリブレーション表示ウィンドウ
let calibration3DWindow = null;

ipcMain.handle('open-3d-calibration-view', async (event, calibrationData) => {
	try {
		// 既存のウィンドウがあれば閉じる
		if (calibration3DWindow) {
			calibration3DWindow.close();
		}

		// 新しいウィンドウを作成
		calibration3DWindow = new BrowserWindow({
			width: 1200,
			height: 800,
			title: 'キャリブレーション3D表示 - MotionDigitizer',
			webPreferences: {
				nodeIntegration: true,
				contextIsolation: false
			}
		});

		calibration3DWindow.loadFile(path.join(__dirname, 'calibration-3d-view.html'));

		// ウィンドウが読み込まれたらデータを送信
		calibration3DWindow.webContents.once('did-finish-load', () => {
			calibration3DWindow.webContents.send('calibration-data', calibrationData);
		});

		// ウィンドウが閉じられたら参照をクリア
		calibration3DWindow.on('closed', () => {
			calibration3DWindow = null;
		});

		return { success: true };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ChArUcoキャリブレーション結果の保存
ipcMain.handle('save-charuco-calibration', async (event, calibrationData) => {
	try {
		const win = BrowserWindow.getFocusedWindow();
		const { canceled, filePath } = await dialog.showSaveDialog(win, {
			title: 'ChArUcoキャリブレーション結果を保存',
			filters: [
				{ name: 'Camera Parameters', extensions: ['cprm'] }
			],
			defaultPath: 'charuco_calibration.cprm'
		});

		if (canceled || !filePath) {
			return { success: false, error: 'cancelled' };
		}

		const jsonData = JSON.stringify(calibrationData, null, 2);
		await fs.promises.writeFile(filePath, jsonData, 'utf8');

		return { success: true, path: filePath };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ChArUcoキャリブレーション結果の読み込み
ipcMain.handle('load-charuco-calibration', async () => {
	try {
		const win = BrowserWindow.getFocusedWindow();
		const { canceled, filePaths } = await dialog.showOpenDialog(win, {
			title: 'ChArUcoキャリブレーション結果を読み込み',
			filters: [
				{ name: 'Camera Parameters', extensions: ['cprm'] },
				{ name: 'Calibration Data (Legacy)', extensions: ['cal', 'json'] },
				{ name: 'All Supported', extensions: ['cprm', 'cal', 'json'] }
			],
			properties: ['openFile']
		});

		if (canceled || !filePaths || !filePaths.length) {
			return { success: false, error: 'cancelled' };
		}

		const filePath = filePaths[0];
		const content = await fs.promises.readFile(filePath, 'utf8');
		const calibrationData = JSON.parse(content);

		return { success: true, data: calibrationData, path: filePath };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ステレオキャリブレーション結果の保存
ipcMain.handle('save-stereo-calibration', async (event, stereoData) => {
	try {
		const win = BrowserWindow.getFocusedWindow();
		const { canceled, filePath } = await dialog.showSaveDialog(win, {
			title: 'ステレオキャリブレーション結果を保存',
			filters: [
				{ name: 'Camera Parameters', extensions: ['cprm'] }
			],
			defaultPath: 'stereo_calibration.cprm'
		});

		if (canceled || !filePath) {
			return { success: false, cancelled: true };
		}

		const jsonData = JSON.stringify(stereoData, null, 2);
		await fs.promises.writeFile(filePath, jsonData, 'utf8');

		return { success: true, filePath: filePath };
	} catch (e) {
		return { success: false, error: e.message };
	}
});

// ステレオキャリブレーション結果の読み込み
ipcMain.handle('load-stereo-calibration', async () => {
	try {
		const win = BrowserWindow.getFocusedWindow();
		const { canceled, filePaths } = await dialog.showOpenDialog(win, {
			title: 'ステレオキャリブレーション結果を読み込み',
			filters: [
				{ name: 'Camera Parameters', extensions: ['cprm'] },
				{ name: 'Calibration Data (Legacy)', extensions: ['cal', 'json'] },
				{ name: 'All Supported', extensions: ['cprm', 'cal', 'json'] }
			],
			properties: ['openFile']
		});

		if (canceled || !filePaths || !filePaths.length) {
			return { success: false, cancelled: true };
		}

		const filePath = filePaths[0];
		const content = await fs.promises.readFile(filePath, 'utf8');
		const stereoData = JSON.parse(content);

		return { success: true, data: stereoData, filePath: filePath };
	} catch (e) {
		return { success: false, error: e.message };
	}
});




