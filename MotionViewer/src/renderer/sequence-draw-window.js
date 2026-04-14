/**
 * 図形描写（連続写真）専用ウィンドウ
 */
import * as THREE from './lib/three.module.js';
import { OrbitControls } from './lib/OrbitControls.js';

class SequenceDrawWindow {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.sequenceSkeletons = [];
    this.currentData = null; // 現在のデータを保持
    this.visibleLines = new Map(); // ラインの表示状態を管理
    this.visiblePoints = new Map(); // ポイントの表示状態を管理
    this.visibleTrajectories = new Map(); // 軌跡の表示状態を管理
    this.trajectoryObjects = []; // 軌跡オブジェクトを保持
    this.trajectorySettings = {
      thickness: 2,
      useGradient: false
    };
    this.axisOffset = { x: 0, y: 0, z: 0 }; // 軸の並行移動
    this.cameraInitialized = false; // カメラの初期化フラグ
    this.fileName = 'sequence-draw'; // デフォルトファイル名
    this.filePath = null; // ファイルパス
    this.currentView = null; // 現在のビュー ('xy', 'yz', 'xz')
    this.viewFlipped = false; // ビューが反転されているか

    this.init();
  }

  init() {
    console.log('[DEBUG] SequenceDrawWindow init called');
    this.initThreeScene();
    this.setupEventListeners();

    // メインウィンドウからデータを受け取る
    if (window.electronAPI) {
      console.log('[DEBUG] electronAPI available, setting up listener');
      window.electronAPI.on('draw-sequence-data', (data) => {
        console.log('[DEBUG] draw-sequence-data received');
        this.drawSequence(data);
      });
    } else {
      console.error('[ERROR] electronAPI not available');
    }
  }

  initThreeScene() {
    const container = document.getElementById('canvas-container');
    const canvas = document.getElementById('sequence-canvas');

    // シーン作成
    this.scene = new THREE.Scene();
    this.scene.background = null; // 透明背景

    // カメラ作成
    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 1.5, 5);
    this.camera.up.set(0, 0, 1); // Z軸を上に設定（メインウィンドウと同じ）

    // レンダラー作成（透明背景を有効化）
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      alpha: true, // 透明背景を有効化
      preserveDrawingBuffer: true // 画像保存のため
    });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0); // 完全に透明

    // ライト追加
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    this.scene.add(directionalLight);

    // コントロール（メインウィンドウと同じ設定）
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;

    // ウィンドウリサイズ対応
    window.addEventListener('resize', () => this.onWindowResize());

    // アニメーションループ
    this.animate();

    // ローディング非表示
    document.getElementById('loading').style.display = 'none';
  }

  onWindowResize() {
    const container = document.getElementById('canvas-container');
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  drawSequence(data) {
    // データを保存
    this.currentData = data;

    // ファイル名を保存
    if (data.fileName) {
      this.fileName = data.fileName;
    }

    // ファイルパスを保存
    if (data.filePath) {
      this.filePath = data.filePath;
    }

    // 既存の描画をクリア
    this.clearSequence();

    console.log('[DEBUG] drawSequence called with axisOffset:', this.axisOffset);

    // 開始フレーム、終了フレームの入力フィールドを更新
    const startFrameInput = document.getElementById('startFrameInput');
    const endFrameInput = document.getElementById('endFrameInput');
    if (startFrameInput && endFrameInput) {
      startFrameInput.value = data.sequenceSettings.startFrame;
      startFrameInput.max = data.frames.length;
      endFrameInput.value = data.sequenceSettings.endFrame;
      endFrameInput.max = data.frames.length;
    }

    // 表示間隔スライダーを更新
    const intervalSlider = document.getElementById('intervalSlider');
    const intervalValue = document.getElementById('intervalValue');
    if (intervalSlider && intervalValue) {
      intervalSlider.value = data.sequenceSettings.interval;
      intervalValue.textContent = data.sequenceSettings.interval;
    }

    // ラインチェックボックスを生成
    this.createLineCheckboxes(data.lineSettings);

    // ポイントチェックボックスを生成
    if (data.pointSettings) {
      this.createPointCheckboxes(data.pointSettings);
      this.createTrajectoryCheckboxes(data.pointSettings);
    }

    const { frames, lineSettings, pointNames, sequenceSettings } = data;
    const pointSettings = data.pointSettings || [];
    const { startFrame, endFrame, interval } = sequenceSettings;

    // 描画するフレームのリストを作成
    const framesToDraw = [];
    for (let i = startFrame - 1; i <= endFrame - 1; i += interval) {
      if (i >= 0 && i < frames.length) {
        framesToDraw.push(i);
      }
    }

    const totalDrawFrames = framesToDraw.length;

    // 各フレームを描画
    framesToDraw.forEach((frameIdx, drawIdx) => {
      const points = frames[frameIdx];

      // 透明度は固定値
      const opacity = 0.7;

      // このフレーム用の骨格群を作成
      const frameSkeleton = [];

      // lineSettingsに基づいて線を描画
      lineSettings.forEach((setting, settingIndex) => {
        // ラインの表示状態をチェック
        const lineKey = `${setting.name1}-${setting.name2}`;
        const isLineVisible = this.visibleLines.has(lineKey) ? this.visibleLines.get(lineKey) : true;

        if (setting.visible && setting.width > 0 && isLineVisible) {
          const p1Index = pointNames.indexOf(setting.name1);
          const p2Index = pointNames.indexOf(setting.name2);

          if (p1Index > -1 && p2Index > -1 && points[p1Index] && points[p2Index]) {
            const p1 = points[p1Index];
            const p2 = points[p2Index];

            if (!this.isValidPoint(p1) || !this.isValidPoint(p2)) {
              return;
            }

            // 軸の並行移動を適用（各フレームに応じてオフセットを累積）
            const frameOffset = {
              x: this.axisOffset.x * drawIdx,
              y: this.axisOffset.y * drawIdx,
              z: this.axisOffset.z * drawIdx
            };

            const startVec = new THREE.Vector3(
              p1.x + frameOffset.x,
              p1.y + frameOffset.y,
              p1.z + frameOffset.z
            );
            const endVec = new THREE.Vector3(
              p2.x + frameOffset.x,
              p2.y + frameOffset.y,
              p2.z + frameOffset.z
            );

            // ライン設定の色を使用
            const lineColor = new THREE.Color(setting.color);

            let lineObject;

            if (setting.style === 'dashed' || setting.style === 'dotted') {
              const geometry = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
              const material = new THREE.LineDashedMaterial({
                color: lineColor,
                linewidth: setting.width,
                scale: 1,
                dashSize: setting.style === 'dashed' ? 0.1 : 0.02,
                gapSize: setting.style === 'dashed' ? 0.05 : 0.02,
                transparent: true,
                opacity: opacity
              });
              lineObject = new THREE.Line(geometry, material);
              lineObject.computeLineDistances();
            } else {
              const curve = new THREE.LineCurve3(startVec, endVec);
              const thickness = setting.width / 1000.0;
              const tubeGeometry = new THREE.TubeGeometry(curve, 1, thickness, 8, false);
              const material = new THREE.MeshStandardMaterial({
                color: lineColor,
                roughness: 0.8,
                metalness: 0.2,
                transparent: true,
                opacity: opacity
              });
              lineObject = new THREE.Mesh(tubeGeometry, material);
            }

            this.scene.add(lineObject);
            frameSkeleton.push(lineObject);
          }
        }
      });

      // ポイント（球体/ボックス/コーン）を描画
      pointSettings.forEach((setting, settingIndex) => {
        // ポイントの表示状態をチェック
        const isPointVisible = this.visiblePoints.has(setting.name) ? this.visiblePoints.get(setting.name) : setting.visible;

        if (isPointVisible && setting.size > 0) {
          const pointIndex = pointNames.indexOf(setting.name);

          if (pointIndex > -1 && points[pointIndex]) {
            const p = points[pointIndex];

            if (!this.isValidPoint(p)) {
              return;
            }

            // 軸の並行移動を適用
            const frameOffset = {
              x: this.axisOffset.x * drawIdx,
              y: this.axisOffset.y * drawIdx,
              z: this.axisOffset.z * drawIdx
            };

            const position = new THREE.Vector3(
              p.x + frameOffset.x,
              p.y + frameOffset.y,
              p.z + frameOffset.z
            );

            // サイズを計算（メインウィンドウと同じスケール）
            const size = setting.size / 100;

            // ジオメトリを作成
            let geometry;
            if (setting.pattern === 'box') {
              geometry = new THREE.BoxGeometry(size, size, size);
            } else if (setting.pattern === 'cone') {
              geometry = new THREE.ConeGeometry(size, size * 2, 16);
              geometry.translate(0, size, 0);
              geometry.rotateX(Math.PI / 2);
            } else {
              geometry = new THREE.SphereGeometry(size, 16, 16);
            }

            // マテリアルを作成
            const pointColor = new THREE.Color(setting.color);
            const material = new THREE.MeshStandardMaterial({
              color: pointColor,
              roughness: 0.8,
              metalness: 0.2,
              transparent: true,
              opacity: opacity
            });

            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.copy(position);

            this.scene.add(mesh);
            frameSkeleton.push(mesh);
          }
        }
      });

      this.sequenceSkeletons.push(frameSkeleton);
    });

    // 軌跡を描画
    this.drawTrajectories(data, framesToDraw);

    // フレーム情報を更新
    document.getElementById('frameInfo').textContent =
      `フレーム: ${startFrame} - ${endFrame} (間隔: ${interval}, 総数: ${totalDrawFrames})`;

    // カメラ位置を自動調整（初回のみ）
    if (!this.cameraInitialized) {
      this.autoAdjustCamera();
      this.cameraInitialized = true;
    }
  }

  clearSequence() {
    this.sequenceSkeletons.forEach(frameSkeleton => {
      frameSkeleton.forEach(line => {
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
        this.scene.remove(line);
      });
    });
    this.sequenceSkeletons = [];
    // 軌跡もクリア
    this.clearTrajectories();
  }

  createLineCheckboxes(lineSettings) {
    const container = document.getElementById('lineCheckboxes');
    if (!container) return;

    container.innerHTML = '';

    lineSettings.forEach((setting, index) => {
      const lineKey = `${setting.name1}-${setting.name2}`;
      const isChecked = this.visibleLines.has(lineKey) ? this.visibleLines.get(lineKey) : true;

      const item = document.createElement('div');
      item.className = 'checkbox-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `line-${index}`;
      checkbox.checked = isChecked;
      checkbox.addEventListener('change', (e) => {
        this.visibleLines.set(lineKey, e.target.checked);
        this.redrawSequence();
      });

      const colorIndicator = document.createElement('div');
      colorIndicator.className = 'color-indicator';
      const color = typeof setting.color === 'number' ?
        `#${setting.color.toString(16).padStart(6, '0')}` : setting.color;
      colorIndicator.style.backgroundColor = color;

      const label = document.createElement('label');
      label.htmlFor = `line-${index}`;
      label.textContent = `${setting.name1} - ${setting.name2}`;

      item.appendChild(checkbox);
      item.appendChild(colorIndicator);
      item.appendChild(label);
      container.appendChild(item);
    });
  }

  createPointCheckboxes(pointSettings) {
    const container = document.getElementById('pointCheckboxes');
    if (!container) return;

    container.innerHTML = '';

    pointSettings.forEach((setting, index) => {
      // サイズが0のポイントはスキップ
      if (setting.size <= 0) return;

      const isChecked = this.visiblePoints.has(setting.name) ? this.visiblePoints.get(setting.name) : setting.visible;

      const item = document.createElement('div');
      item.className = 'checkbox-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `point-${index}`;
      checkbox.checked = isChecked;
      checkbox.addEventListener('change', (e) => {
        this.visiblePoints.set(setting.name, e.target.checked);
        this.redrawSequence();
      });

      const colorIndicator = document.createElement('div');
      colorIndicator.className = 'color-indicator';
      colorIndicator.style.backgroundColor = setting.color;

      const label = document.createElement('label');
      label.htmlFor = `point-${index}`;
      label.textContent = setting.name;

      item.appendChild(checkbox);
      item.appendChild(colorIndicator);
      item.appendChild(label);
      container.appendChild(item);
    });
  }

  createTrajectoryCheckboxes(pointSettings) {
    const container = document.getElementById('trajectoryCheckboxes');
    if (!container) return;

    container.innerHTML = '';

    pointSettings.forEach((setting, index) => {
      // サイズが0のポイントはスキップ
      if (setting.size <= 0) return;

      const isChecked = this.visibleTrajectories.has(setting.name) ? this.visibleTrajectories.get(setting.name) : false;

      const item = document.createElement('div');
      item.className = 'checkbox-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `trajectory-${index}`;
      checkbox.checked = isChecked;
      checkbox.addEventListener('change', (e) => {
        this.visibleTrajectories.set(setting.name, e.target.checked);
        this.redrawSequence();
      });

      const colorIndicator = document.createElement('div');
      colorIndicator.className = 'color-indicator';
      colorIndicator.style.backgroundColor = setting.color;

      const label = document.createElement('label');
      label.htmlFor = `trajectory-${index}`;
      label.textContent = setting.name;

      item.appendChild(checkbox);
      item.appendChild(colorIndicator);
      item.appendChild(label);
      container.appendChild(item);
    });
  }

  drawTrajectories(data, framesToDraw) {
    // 既存の軌跡をクリア
    this.clearTrajectories();

    const { frames, pointNames, pointSettings } = data;
    if (!pointSettings) return;

    const totalFrames = framesToDraw.length;
    if (totalFrames < 2) return; // 2フレーム未満では軌跡を描けない

    pointSettings.forEach((setting, settingIndex) => {
      // 軌跡の表示状態をチェック
      const isTrajectoryVisible = this.visibleTrajectories.has(setting.name) ? this.visibleTrajectories.get(setting.name) : false;

      if (!isTrajectoryVisible || setting.size <= 0) return;

      const pointIndex = pointNames.indexOf(setting.name);
      if (pointIndex < 0) return;

      // このポイントの全フレーム位置を収集
      const positions = [];
      framesToDraw.forEach((frameIdx, drawIdx) => {
        const point = frames[frameIdx][pointIndex];
        if (this.isValidPoint(point)) {
          // 軸の並行移動を適用
          const frameOffset = {
            x: this.axisOffset.x * drawIdx,
            y: this.axisOffset.y * drawIdx,
            z: this.axisOffset.z * drawIdx
          };
          positions.push(new THREE.Vector3(
            point.x + frameOffset.x,
            point.y + frameOffset.y,
            point.z + frameOffset.z
          ));
        }
      });

      if (positions.length < 2) return;

      // 軌跡を描画
      const thickness = this.trajectorySettings.thickness / 1000.0;
      const pointColor = new THREE.Color(setting.color);

      if (this.trajectorySettings.useGradient) {
        // グラデーション: セグメントごとに色を変える
        for (let i = 0; i < positions.length - 1; i++) {
          const t = i / (positions.length - 1);
          // 青→緑→赤のグラデーション（時間経過）
          const color = new THREE.Color();
          if (t < 0.5) {
            color.setHSL(0.6 - t * 0.4, 0.8, 0.5); // 青→緑
          } else {
            color.setHSL(0.4 - (t - 0.5) * 0.8, 0.8, 0.5); // 緑→赤
          }

          const curve = new THREE.LineCurve3(positions[i], positions[i + 1]);
          const tubeGeometry = new THREE.TubeGeometry(curve, 1, thickness, 8, false);
          const material = new THREE.MeshStandardMaterial({
            color: color,
            roughness: 0.6,
            metalness: 0.1,
            transparent: true,
            opacity: 0.8
          });
          const tube = new THREE.Mesh(tubeGeometry, material);
          this.scene.add(tube);
          this.trajectoryObjects.push(tube);
        }
      } else {
        // 単色: CatmullRomカーブで滑らかな軌跡
        const curve = new THREE.CatmullRomCurve3(positions);
        const tubeGeometry = new THREE.TubeGeometry(curve, positions.length * 4, thickness, 8, false);
        const material = new THREE.MeshStandardMaterial({
          color: pointColor,
          roughness: 0.6,
          metalness: 0.1,
          transparent: true,
          opacity: 0.7
        });
        const tube = new THREE.Mesh(tubeGeometry, material);
        this.scene.add(tube);
        this.trajectoryObjects.push(tube);
      }
    });
  }

  clearTrajectories() {
    this.trajectoryObjects.forEach(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
      this.scene.remove(obj);
    });
    this.trajectoryObjects = [];
  }

  redrawSequence() {
    if (this.currentData) {
      this.drawSequence(this.currentData);
    }
  }

  isValidPoint(point) {
    return point &&
      typeof point.x === 'number' && !isNaN(point.x) && isFinite(point.x) &&
      typeof point.y === 'number' && !isNaN(point.y) && isFinite(point.y) &&
      typeof point.z === 'number' && !isNaN(point.z) && isFinite(point.z);
  }

  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  }

  autoAdjustCamera() {
    // シーン内のオブジェクトから境界ボックスを計算
    const box = new THREE.Box3();
    this.sequenceSkeletons.forEach(frameSkeleton => {
      frameSkeleton.forEach(line => {
        box.expandByObject(line);
      });
    });
    // 軌跡も含める
    this.trajectoryObjects.forEach(obj => {
      box.expandByObject(obj);
    });

    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = this.camera.fov * (Math.PI / 180);
      let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
      cameraZ *= 1.5; // 余裕を持たせる

      // まずコントロールのターゲットを設定（回転中心）
      this.controls.target.copy(center);

      // カメラ位置を設定
      this.camera.position.set(center.x, center.y + maxDim * 0.3, center.z + cameraZ);
      this.camera.up.set(0, 0, 1); // Z軸を上に設定（メインウィンドウと同じ）
      this.camera.lookAt(center);

      // プロジェクション行列を更新
      this.camera.updateProjectionMatrix();

      // コントロールを更新
      this.controls.update();
    }
  }

  setupEventListeners() {
    // 画像保存ボタン
    document.getElementById('saveImageBtn').addEventListener('click', () => {
      this.saveImage();
    });

    // SVG保存ボタン
    document.getElementById('saveSVGBtn').addEventListener('click', () => {
      this.saveSVG();
    });

    // GLB保存ボタン
    document.getElementById('saveGLBBtn').addEventListener('click', () => {
      this.saveGLB();
    });

    // 視点リセットボタン
    document.getElementById('resetViewBtn').addEventListener('click', () => {
      this.autoAdjustCamera();
    });

    // カメラ視点切り替えボタン
    document.getElementById('viewXYBtn').addEventListener('click', () => {
      this.setCameraView('xy');
    });

    document.getElementById('viewYZBtn').addEventListener('click', () => {
      this.setCameraView('yz');
    });

    document.getElementById('viewXZBtn').addEventListener('click', () => {
      this.setCameraView('xz');
    });

    // サイドバー切り替えボタン（ツールバー内）
    document.getElementById('toggleSidebarBtn').addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.toggle('collapsed');
    });

    // サイドバー閉じるボタン（サイドバーヘッダー内）
    document.getElementById('sidebarToggle').addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.add('collapsed');
    });

    // サイドバー展開ボタン（キャンバス左端）
    document.getElementById('sidebarExpandBtn').addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.remove('collapsed');
    });

    // 閉じるボタン
    document.getElementById('closeWindowBtn').addEventListener('click', () => {
      window.close();
    });

    // 表示間隔スライダー
    const intervalSlider = document.getElementById('intervalSlider');
    const intervalValue = document.getElementById('intervalValue');
    intervalSlider.addEventListener('input', (e) => {
      intervalValue.textContent = e.target.value;
    });

    intervalSlider.addEventListener('change', (e) => {
      if (this.currentData) {
        this.currentData.sequenceSettings.interval = parseInt(e.target.value);
        this.redrawSequence();
      }
    });

    // 開始フレーム
    document.getElementById('startFrameInput').addEventListener('change', (e) => {
      if (this.currentData) {
        this.currentData.sequenceSettings.startFrame = parseInt(e.target.value);
        this.redrawSequence();
      }
    });

    // 終了フレーム
    document.getElementById('endFrameInput').addEventListener('change', (e) => {
      if (this.currentData) {
        this.currentData.sequenceSettings.endFrame = parseInt(e.target.value);
        this.redrawSequence();
      }
    });

    // X軸並行移動
    const offsetXInput = document.getElementById('offsetX');
    const updateOffsetX = (e) => {
      this.axisOffset.x = parseFloat(e.target.value) || 0;
      console.log('[DEBUG] offsetX changed:', this.axisOffset.x);
      this.redrawSequence();
    };
    offsetXInput.addEventListener('change', updateOffsetX);
    offsetXInput.addEventListener('input', updateOffsetX);

    // Y軸並行移動
    const offsetYInput = document.getElementById('offsetY');
    const updateOffsetY = (e) => {
      this.axisOffset.y = parseFloat(e.target.value) || 0;
      console.log('[DEBUG] offsetY changed:', this.axisOffset.y);
      this.redrawSequence();
    };
    offsetYInput.addEventListener('change', updateOffsetY);
    offsetYInput.addEventListener('input', updateOffsetY);

    // Z軸並行移動
    const offsetZInput = document.getElementById('offsetZ');
    const updateOffsetZ = (e) => {
      this.axisOffset.z = parseFloat(e.target.value) || 0;
      console.log('[DEBUG] offsetZ changed:', this.axisOffset.z);
      this.redrawSequence();
    };
    offsetZInput.addEventListener('change', updateOffsetZ);
    offsetZInput.addEventListener('input', updateOffsetZ);

    // 全てチェック（ライン）
    document.getElementById('checkAllLines').addEventListener('click', () => {
      this.setAllLinesVisible(true);
    });

    // 全て外す（ライン）
    document.getElementById('uncheckAllLines').addEventListener('click', () => {
      this.setAllLinesVisible(false);
    });

    // 全てチェック（ポイント）
    document.getElementById('checkAllPoints').addEventListener('click', () => {
      this.setAllPointsVisible(true);
    });

    // 全て外す（ポイント）
    document.getElementById('uncheckAllPoints').addEventListener('click', () => {
      this.setAllPointsVisible(false);
    });

    // 全てON（軌跡）
    document.getElementById('checkAllTrajectories').addEventListener('click', () => {
      this.setAllTrajectoriesVisible(true);
    });

    // 全てOFF（軌跡）
    document.getElementById('uncheckAllTrajectories').addEventListener('click', () => {
      this.setAllTrajectoriesVisible(false);
    });

    // 軌跡の太さ
    const trajectoryThicknessSlider = document.getElementById('trajectoryThickness');
    const trajectoryThicknessValue = document.getElementById('trajectoryThicknessValue');
    if (trajectoryThicknessSlider && trajectoryThicknessValue) {
      trajectoryThicknessSlider.addEventListener('input', (e) => {
        trajectoryThicknessValue.textContent = e.target.value;
      });
      trajectoryThicknessSlider.addEventListener('change', (e) => {
        this.trajectorySettings.thickness = parseInt(e.target.value);
        this.redrawSequence();
      });
    }

    // 軌跡のグラデーション
    const trajectoryGradientCheckbox = document.getElementById('trajectoryGradient');
    if (trajectoryGradientCheckbox) {
      trajectoryGradientCheckbox.addEventListener('change', (e) => {
        this.trajectorySettings.useGradient = e.target.checked;
        this.redrawSequence();
      });
    }
  }

  setAllLinesVisible(visible) {
    if (!this.currentData) return;

    // 全てのラインの表示状態を更新
    this.currentData.lineSettings.forEach(setting => {
      const lineKey = `${setting.name1}-${setting.name2}`;
      this.visibleLines.set(lineKey, visible);
    });

    // チェックボックスの状態を更新
    const checkboxes = document.querySelectorAll('#lineCheckboxes input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
      checkbox.checked = visible;
    });

    // 再描画
    this.redrawSequence();
  }

  setAllPointsVisible(visible) {
    if (!this.currentData || !this.currentData.pointSettings) return;

    // 全てのポイントの表示状態を更新
    this.currentData.pointSettings.forEach(setting => {
      this.visiblePoints.set(setting.name, visible);
    });

    // チェックボックスの状態を更新
    const checkboxes = document.querySelectorAll('#pointCheckboxes input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
      checkbox.checked = visible;
    });

    // 再描画
    this.redrawSequence();
  }

  setAllTrajectoriesVisible(visible) {
    if (!this.currentData || !this.currentData.pointSettings) return;

    // 全ての軌跡の表示状態を更新
    this.currentData.pointSettings.forEach(setting => {
      if (setting.size > 0) {
        this.visibleTrajectories.set(setting.name, visible);
      }
    });

    // チェックボックスの状態を更新
    const checkboxes = document.querySelectorAll('#trajectoryCheckboxes input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
      checkbox.checked = visible;
    });

    // 再描画
    this.redrawSequence();
  }

  setCameraView(viewType) {
    if (!this.scene) return;

    // 同じビューが選択された場合、180度回転
    if (this.currentView === viewType) {
      this.viewFlipped = !this.viewFlipped;
    } else {
      this.currentView = viewType;
      this.viewFlipped = false;
    }

    // シーンの中心を計算
    const box = new THREE.Box3();
    this.sequenceSkeletons.forEach(frameSkeleton => {
      frameSkeleton.forEach(line => {
        box.expandByObject(line);
      });
    });
    // 軌跡も含める
    this.trajectoryObjects.forEach(obj => {
      box.expandByObject(obj);
    });

    const center = box.isEmpty() ? new THREE.Vector3(0, 0, 0) : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? 5 : Math.max(box.getSize(new THREE.Vector3()).length(), 5);
    const distance = size * 1.5;

    // 反転の符号（180度回転の場合は-1）
    const flip = this.viewFlipped ? -1 : 1;

    // まずコントロールのターゲットを設定（回転中心）
    this.controls.target.copy(center);

    switch (viewType) {
      case 'xy': // x-y平面（真横から見る）
        this.camera.position.set(center.x, center.y, center.z + distance * flip);
        this.camera.up.set(0, 1, 0);
        break;
      case 'yz': // y-z平面（正面から見る、右サイドが地面）
        this.camera.position.set(center.x + distance * flip, center.y, center.z);
        this.camera.up.set(0, 0, 1); // z軸の正の方向を上にする（y軸が画面右方向になる）
        break;
      case 'xz': // x-z平面（真上から見る、地面が下）
        this.camera.position.set(center.x, center.y + distance * flip, center.z);
        this.camera.up.set(0, 0, 1); // z軸の正の方向を上にする（画面上方向）
        break;
    }

    // カメラの向きを設定
    this.camera.lookAt(center);

    // プロジェクション行列を更新
    this.camera.updateProjectionMatrix();

    // コントロールを更新
    this.controls.update();
  }

  /**
   * 保存時のデフォルトパスを取得（モーションデータのディレクトリ + ファイル名）
   */
  getDefaultSavePath(fileName) {
    if (this.filePath) {
      // ファイルパスからディレクトリを取得
      const lastSlashIndex = Math.max(
        this.filePath.lastIndexOf('/'),
        this.filePath.lastIndexOf('\\')
      );
      if (lastSlashIndex > -1) {
        const directory = this.filePath.substring(0, lastSlashIndex + 1);
        return directory + fileName;
      }
    }
    // フォールバック：ファイル名のみ
    return fileName;
  }

  async saveImage() {
    try {
      // 高解像度でレンダリング
      const width = 1920;
      const height = 1080;

      // 一時的にレンダラーのサイズを変更
      const originalSize = this.renderer.getSize(new THREE.Vector2());
      this.renderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();

      // レンダリング
      this.renderer.render(this.scene, this.camera);

      // キャンバスから画像データを取得
      const dataURL = this.renderer.domElement.toDataURL('image/png');

      // サイズを元に戻す
      this.renderer.setSize(originalSize.x, originalSize.y);
      this.camera.aspect = originalSize.x / originalSize.y;
      this.camera.updateProjectionMatrix();

      // ファイル保存ダイアログ
      if (window.electronAPI) {
        const result = await window.electronAPI.invoke('show-save-dialog', {
          title: '画像を保存',
          defaultPath: this.getDefaultSavePath(`${this.fileName}.png`),
          filters: [{ name: 'PNG画像', extensions: ['png'] }]
        });

        if (!result.canceled && result.filePath) {
          // Base64データをファイルに保存
          const base64Data = dataURL.replace(/^data:image\/png;base64,/, '');
          await window.electronAPI.invoke('save-image-file', result.filePath, base64Data);
          alert('画像を保存しました！');
        }
      }
    } catch (error) {
      alert('画像の保存に失敗しました: ' + error.message);
    }
  }

  async saveSVG() {
    try {
      if (this.sequenceSkeletons.length === 0) {
        alert('保存するデータがありません。先に図形描写を作成してください。');
        return;
      }

      // SVGを生成
      const svgContent = this.createSVG();

      // ファイル保存ダイアログ
      if (window.electronAPI) {
        const result = await window.electronAPI.invoke('show-save-dialog', {
          title: 'ベクター画像を保存',
          defaultPath: this.getDefaultSavePath(`${this.fileName}.svg`),
          filters: [{ name: 'SVGファイル', extensions: ['svg'] }]
        });

        if (!result.canceled && result.filePath) {
          // SVGをファイルに保存
          await window.electronAPI.invoke('save-svg-file', result.filePath, svgContent);
          alert('SVGファイルを保存しました！\nPowerPointで「図形に変換」すると編集可能になります。');
        }
      }
    } catch (error) {
      console.error('SVG保存エラー:', error);
      alert('SVGの保存に失敗しました: ' + error.message);
    }
  }

  createSVG() {
    if (!this.currentData) {
      throw new Error('データがありません');
    }

    // カメラのビュー行列とプロジェクション行列を取得
    const viewMatrix = new THREE.Matrix4();
    viewMatrix.copy(this.camera.matrixWorldInverse);

    const projectionMatrix = new THREE.Matrix4();
    projectionMatrix.copy(this.camera.projectionMatrix);

    // ビュー・プロジェクション合成行列
    const vpMatrix = new THREE.Matrix4();
    vpMatrix.multiplyMatrices(projectionMatrix, viewMatrix);

    const { frames, lineSettings, pointNames, sequenceSettings } = this.currentData;
    const { startFrame, endFrame, interval } = sequenceSettings;

    // 描画するフレームのリストを作成
    const framesToDraw = [];
    for (let i = startFrame - 1; i <= endFrame - 1; i += interval) {
      if (i >= 0 && i < frames.length) {
        framesToDraw.push(i);
      }
    }

    // カメラのアスペクト比を取得
    const aspect = this.camera.aspect;

    // SVGのスケール（アスペクト比を考慮）
    const scale = 500;
    const scaleX = scale;
    const scaleY = scale;

    // フレームごとにラインをグループ化
    const frameGroups = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    framesToDraw.forEach((frameIdx, drawIdx) => {
      const points = frames[frameIdx];
      const frameLines = [];

      lineSettings.forEach((setting) => {
        // ラインの表示状態をチェック
        const lineKey = `${setting.name1}-${setting.name2}`;
        const isLineVisible = this.visibleLines.has(lineKey) ? this.visibleLines.get(lineKey) : true;

        if (setting.visible && setting.width > 0 && isLineVisible) {
          const p1Index = pointNames.indexOf(setting.name1);
          const p2Index = pointNames.indexOf(setting.name2);

          if (p1Index > -1 && p2Index > -1 && points[p1Index] && points[p2Index]) {
            const p1 = points[p1Index];
            const p2 = points[p2Index];

            if (!this.isValidPoint(p1) || !this.isValidPoint(p2)) {
              return;
            }

            // 軸の並行移動を適用（各フレームに応じてオフセットを累積）
            const frameOffset = {
              x: this.axisOffset.x * drawIdx,
              y: this.axisOffset.y * drawIdx,
              z: this.axisOffset.z * drawIdx
            };

            // 3D座標を作成
            const start3D = new THREE.Vector3(
              p1.x + frameOffset.x,
              p1.y + frameOffset.y,
              p1.z + frameOffset.z
            );
            const end3D = new THREE.Vector3(
              p2.x + frameOffset.x,
              p2.y + frameOffset.y,
              p2.z + frameOffset.z
            );

            // スクリーン座標に変換
            start3D.applyMatrix4(vpMatrix);
            end3D.applyMatrix4(vpMatrix);

            // 正規化デバイス座標からSVG座標へ（アスペクト比を考慮）
            const start2D = {
              x: (start3D.x * aspect + 1) * scaleX,
              y: (1 - start3D.y) * scaleY // Y軸を反転
            };
            const end2D = {
              x: (end3D.x * aspect + 1) * scaleX,
              y: (1 - end3D.y) * scaleY
            };

            // 境界ボックスを更新
            minX = Math.min(minX, start2D.x, end2D.x);
            minY = Math.min(minY, start2D.y, end2D.y);
            maxX = Math.max(maxX, start2D.x, end2D.x);
            maxY = Math.max(maxY, start2D.y, end2D.y);

            // 色を16進数からRGBに変換
            const color = new THREE.Color(setting.color);

            frameLines.push({
              start: start2D,
              end: end2D,
              color: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
              opacity: 0.7,
              strokeWidth: Math.max(2, setting.width / 5), // 線の太さを調整
              style: setting.style || 'solid' // スタイル情報を追加
            });
          }
        }
      });

      // ポイント（設定で可視化されているもの）を追加
      const pointSettings = this.currentData.pointSettings || [];
      const framePoints = [];

      pointSettings.forEach((setting) => {
        const isPointVisible = this.visiblePoints.has(setting.name) ? this.visiblePoints.get(setting.name) : setting.visible;

        if (isPointVisible && setting.size > 0) {
          const pointIndex = pointNames.indexOf(setting.name);

          if (pointIndex > -1 && points[pointIndex]) {
            const p = points[pointIndex];
            if (!this.isValidPoint(p)) return;

            const frameOffset = {
              x: this.axisOffset.x * drawIdx,
              y: this.axisOffset.y * drawIdx,
              z: this.axisOffset.z * drawIdx
            };

            const p3D = new THREE.Vector3(
              p.x + frameOffset.x,
              p.y + frameOffset.y,
              p.z + frameOffset.z
            );

            p3D.applyMatrix4(vpMatrix);

            const p2D = {
              x: (p3D.x * aspect + 1) * scaleX,
              y: (1 - p3D.y) * scaleY
            };

            // SVG上でのサイズに変換（sizeの値はUI上0.1〜だが実際は画面に合うようスケール）
            const size = setting.size / 100;
            const svgRadius = Math.max(2, (size * scale) / 2);

            minX = Math.min(minX, p2D.x - svgRadius);
            minY = Math.min(minY, p2D.y - svgRadius);
            maxX = Math.max(maxX, p2D.x + svgRadius);
            maxY = Math.max(maxY, p2D.y + svgRadius);

            const color = new THREE.Color(setting.color);

            framePoints.push({
              center: p2D,
              radius: svgRadius,
              color: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
              opacity: 0.7,
              pattern: setting.pattern // sphere, box, cone
            });
          }
        }
      });

      if (frameLines.length > 0 || framePoints.length > 0) {
        frameGroups.push({
          frameIndex: frameIdx + 1, // 1ベースのフレーム番号
          lines: frameLines,
          points: framePoints
        });
      }
    });

    // マージンを追加
    const margin = 50;
    minX -= margin;
    minY -= margin;
    maxX += margin;
    maxY += margin;

    const width = maxX - minX;
    const height = maxY - minY;

    // SVG生成
    let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}">\n`;
    svg += `  <title>連続写真 (フレーム ${startFrame}-${endFrame}, 間隔:${interval})</title>\n`;

    // 背景色を追加（背景色が設定されていなければ白とする）
    let bgColor = '#ffffff';
    if (this.scene.background) {
      bgColor = '#' + this.scene.background.getHexString();
    }
    svg += `  <rect x="${minX.toFixed(2)}" y="${minY.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${bgColor}" />\n`;

    // フレームごとにグループ化
    frameGroups.forEach((frameGroup, groupIndex) => {
      svg += `  <g id="frame-${frameGroup.frameIndex}" data-frame="${frameGroup.frameIndex}">\n`;
      svg += `    <title>フレーム ${frameGroup.frameIndex}</title>\n`;

      frameGroup.lines.forEach((line, lineIndex) => {
        // スタイルに応じたstroke-dasharray属性を決定
        let dashArray = '';

        if (line.style === 'dashed') {
          dashArray = `stroke-dasharray="${line.strokeWidth * 3},${line.strokeWidth * 2}" `;
        } else if (line.style === 'dotted') {
          dashArray = `stroke-dasharray="${line.strokeWidth},${line.strokeWidth}" `;
        }

        svg += `    <line id="frame-${frameGroup.frameIndex}-line-${lineIndex}" `;
        svg += `x1="${line.start.x.toFixed(2)}" y1="${line.start.y.toFixed(2)}" `;
        svg += `x2="${line.end.x.toFixed(2)}" y2="${line.end.y.toFixed(2)}" `;
        svg += `stroke="${line.color}" stroke-width="${line.strokeWidth}" `;
        svg += `stroke-opacity="${line.opacity.toFixed(2)}" `;
        svg += `${dashArray}`;
        svg += `stroke-linecap="round" />\n`;
      });

      svg += `    <!-- Points -->\n`;
      frameGroup.points.forEach((point, pointIndex) => {
        const id = `frame-${frameGroup.frameIndex}-point-${pointIndex}`;
        if (point.pattern === 'cone') {
          // 上向きの三角形（コーン）
          const w = point.radius * 2;
          const h = point.radius * 2.5; // コーンは少し縦長にする
          const pt1 = `${point.center.x.toFixed(2)},${(point.center.y - h / 2).toFixed(2)}`;
          const pt2 = `${(point.center.x - w / 2).toFixed(2)},${(point.center.y + h / 2).toFixed(2)}`;
          const pt3 = `${(point.center.x + w / 2).toFixed(2)},${(point.center.y + h / 2).toFixed(2)}`;
          svg += `    <polygon id="${id}" points="${pt1} ${pt2} ${pt3}" fill="${point.color}" fill-opacity="${point.opacity.toFixed(2)}" />\n`;
        } else if (point.pattern === 'cube' || point.pattern === 'box') {
          // 四角形（ボックス）
          const size = point.radius * 2;
          svg += `    <rect id="${id}" x="${(point.center.x - size / 2).toFixed(2)}" y="${(point.center.y - size / 2).toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" fill="${point.color}" fill-opacity="${point.opacity.toFixed(2)}" />\n`;
        } else {
          // デフォルトは球（円）
          svg += `    <circle id="${id}" cx="${point.center.x.toFixed(2)}" cy="${point.center.y.toFixed(2)}" r="${point.radius.toFixed(2)}" fill="${point.color}" fill-opacity="${point.opacity.toFixed(2)}" />\n`;
        }
      });

      svg += `  </g>\n`;
    });

    svg += `</svg>`;

    return svg;
  }

  async saveGLB() {
    try {
      if (this.sequenceSkeletons.length === 0) {
        alert('保存する3Dモデルがありません。先に図形描写を作成してください。');
        return;
      }

      // ファイル保存ダイアログ
      if (window.electronAPI) {
        const result = await window.electronAPI.invoke('show-save-dialog', {
          title: '3Dモデルを保存',
          defaultPath: this.getDefaultSavePath(`${this.fileName}.glb`),
          filters: [{ name: 'GLBファイル', extensions: ['glb'] }]
        });

        if (!result.canceled && result.filePath) {
          // シンプルなGLTF構造を手動で作成
          const gltfData = this.createGLTFData();
          const glbBuffer = this.createGLB(gltfData);
          const base64Data = this.arrayBufferToBase64(glbBuffer);

          // ファイルに保存
          await window.electronAPI.invoke('save-glb-file', result.filePath, base64Data);
          alert('3Dモデルを保存しました！');
        }
      }
    } catch (error) {
      console.error('GLB保存エラー:', error);
      alert('3Dモデルの保存に失敗しました: ' + error.message);
    }
  }

  createGLTFData() {
    const vertices = [];
    const indices = [];
    const colors = [];
    let vertexOffset = 0;

    // カメラのビュー行列とモデル行列を取得
    const viewMatrix = new THREE.Matrix4();
    viewMatrix.copy(this.camera.matrixWorldInverse);

    // すべてのラインからジオメトリデータを収集
    this.sequenceSkeletons.forEach(frameSkeleton => {
      frameSkeleton.forEach(line => {
        if (line.geometry && line.geometry.attributes && line.geometry.attributes.position) {
          const positions = line.geometry.attributes.position.array;
          const color = line.material.color;

          // ラインのワールド変換行列を取得
          line.updateMatrixWorld(true);
          const modelMatrix = line.matrixWorld;

          // モデル行列とビュー行列を合成
          const transformMatrix = new THREE.Matrix4();
          transformMatrix.multiplyMatrices(viewMatrix, modelMatrix);

          // 頂点データを変換して追加
          for (let i = 0; i < positions.length; i += 3) {
            const vertex = new THREE.Vector3(
              positions[i],
              positions[i + 1],
              positions[i + 2]
            );

            // カメラ座標系に変換
            vertex.applyMatrix4(transformMatrix);

            vertices.push(vertex.x, vertex.y, vertex.z);
            colors.push(color.r, color.g, color.b);
          }

          // インデックスを追加（ライン用）
          for (let i = 0; i < positions.length / 3 - 1; i++) {
            indices.push(vertexOffset + i, vertexOffset + i + 1);
          }

          vertexOffset += positions.length / 3;
        }
      });
    });

    // Float32ArrayとUint16Arrayに変換
    const verticesArray = new Float32Array(vertices);
    const colorsArray = new Float32Array(colors);
    const indicesArray = new Uint16Array(indices);

    return {
      vertices: verticesArray,
      colors: colorsArray,
      indices: indicesArray
    };
  }

  createGLB(gltfData) {
    // GLTFのJSONヘッダーを作成
    const gltfJson = {
      asset: {
        version: "2.0",
        generator: "MotionViewer Sequence Draw"
      },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{
        primitives: [{
          attributes: {
            POSITION: 0,
            COLOR_0: 1
          },
          indices: 2,
          mode: 1 // LINES
        }]
      }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126, // FLOAT
          count: gltfData.vertices.length / 3,
          type: "VEC3",
          min: this.getMin(gltfData.vertices, 3),
          max: this.getMax(gltfData.vertices, 3)
        },
        {
          bufferView: 1,
          componentType: 5126, // FLOAT
          count: gltfData.colors.length / 3,
          type: "VEC3"
        },
        {
          bufferView: 2,
          componentType: 5123, // UNSIGNED_SHORT
          count: gltfData.indices.length,
          type: "SCALAR"
        }
      ],
      bufferViews: [
        {
          buffer: 0,
          byteOffset: 0,
          byteLength: gltfData.vertices.byteLength,
          target: 34962 // ARRAY_BUFFER
        },
        {
          buffer: 0,
          byteOffset: gltfData.vertices.byteLength,
          byteLength: gltfData.colors.byteLength,
          target: 34962
        },
        {
          buffer: 0,
          byteOffset: gltfData.vertices.byteLength + gltfData.colors.byteLength,
          byteLength: gltfData.indices.byteLength,
          target: 34963 // ELEMENT_ARRAY_BUFFER
        }
      ],
      buffers: [{
        byteLength: gltfData.vertices.byteLength + gltfData.colors.byteLength + gltfData.indices.byteLength
      }]
    };

    const jsonString = JSON.stringify(gltfJson);
    const jsonBuffer = this.stringToArrayBuffer(jsonString);
    const jsonPadding = (4 - (jsonBuffer.byteLength % 4)) % 4;

    // バイナリデータを結合
    const binaryBuffer = new Uint8Array(
      gltfData.vertices.byteLength +
      gltfData.colors.byteLength +
      gltfData.indices.byteLength
    );
    binaryBuffer.set(new Uint8Array(gltfData.vertices.buffer), 0);
    binaryBuffer.set(new Uint8Array(gltfData.colors.buffer), gltfData.vertices.byteLength);
    binaryBuffer.set(new Uint8Array(gltfData.indices.buffer),
      gltfData.vertices.byteLength + gltfData.colors.byteLength);

    const binaryPadding = (4 - (binaryBuffer.byteLength % 4)) % 4;

    // GLBファイル構造を作成
    const glbHeaderSize = 12;
    const jsonChunkHeaderSize = 8;
    const binaryChunkHeaderSize = 8;
    const totalSize = glbHeaderSize +
      jsonChunkHeaderSize + jsonBuffer.byteLength + jsonPadding +
      binaryChunkHeaderSize + binaryBuffer.byteLength + binaryPadding;

    const glb = new ArrayBuffer(totalSize);
    const view = new DataView(glb);
    let offset = 0;

    // GLBヘッダー
    view.setUint32(offset, 0x46546C67, true); // 'glTF'
    offset += 4;
    view.setUint32(offset, 2, true); // version
    offset += 4;
    view.setUint32(offset, totalSize, true); // total length
    offset += 4;

    // JSONチャンク
    view.setUint32(offset, jsonBuffer.byteLength + jsonPadding, true);
    offset += 4;
    view.setUint32(offset, 0x4E4F534A, true); // 'JSON'
    offset += 4;
    new Uint8Array(glb, offset, jsonBuffer.byteLength).set(new Uint8Array(jsonBuffer));
    offset += jsonBuffer.byteLength + jsonPadding;

    // バイナリチャンク
    view.setUint32(offset, binaryBuffer.byteLength + binaryPadding, true);
    offset += 4;
    view.setUint32(offset, 0x004E4942, true); // 'BIN\0'
    offset += 4;
    new Uint8Array(glb, offset).set(binaryBuffer);

    return glb;
  }

  getMin(array, componentSize) {
    const result = [];
    for (let i = 0; i < componentSize; i++) {
      let min = Infinity;
      for (let j = i; j < array.length; j += componentSize) {
        min = Math.min(min, array[j]);
      }
      result.push(min);
    }
    return result;
  }

  getMax(array, componentSize) {
    const result = [];
    for (let i = 0; i < componentSize; i++) {
      let max = -Infinity;
      for (let j = i; j < array.length; j += componentSize) {
        max = Math.max(max, array[j]);
      }
      result.push(max);
    }
    return result;
  }

  stringToArrayBuffer(str) {
    const encoder = new TextEncoder();
    return encoder.encode(str).buffer;
  }

  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

// アプリケーション起動
window.addEventListener('DOMContentLoaded', () => {
  console.log('[DEBUG] sequence-draw-window.js DOMContentLoaded');
  new SequenceDrawWindow();
});

