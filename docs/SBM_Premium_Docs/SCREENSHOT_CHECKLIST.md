# SBM User Manual スクリーンショット撮影チェックリスト

保存先: `docs/SBM_Premium_Docs/picture/{アプリ名}/`
ファイル名規則: `{番号}_{内容}.png` (例: `01_main_window.png`)
解像度: Retina環境は実サイズ推奨 (1x)、幅1200px程度

---

## VideoSyncLab (保存先: picture/VideoSyncLab/)

### 基本画面
- [ ] `01_single_screen.png` — シングルスクリーン: 動画1つ読み込み状態
- [ ] `02_dual_screen.png` — デュアルスクリーン: 左右に動画を読み込んだ状態
- [ ] `03_controls_bar.png` — 再生コントロールバー部分の拡大 (再生/一時停止/フレーム送り/速度調整)

### 同期操作
- [ ] `04_sync_waveform.png` — 音声波形表示で同期点を設定している画面
- [ ] `05_sync_point_set.png` — 同期点設定完了後の表示 (左右の同期マーカー)

### トリミング・出力
- [ ] `06_trim_inout.png` — IN点/OUT点を設定した状態のタイムライン
- [ ] `07_export_dialog.png` — 出力ダイアログ (高速カット/再エンコード/スローモーション選択)

### ストロボモーション
- [ ] `08_strobe_motion.png` — ストロボモーション合成の結果画面
- [ ] `09_strobe_settings.png` — ストロボモーション設定 (間隔/透明度等)

### メニュー
- [ ] `10_menu_file.png` — ファイルメニュー展開

---

## HPE (保存先: picture/HPE/)

### 基本画面
- [ ] `01_main_window.png` — メイン画面: 動画を読み込んだ初期状態
- [ ] `02_video_mode.png` — 動画モード: 骨格オーバーレイ付きで再生中

### 推定設定
- [ ] `03_model_select.png` — モデル選択UI (RTMPose-M/X, SynthPose等)
- [ ] `04_device_select.png` — デバイスセレクタ (GPU/CoreML/CPU)
- [ ] `05_preset_select.png` — 計測プリセット選択 (高速/高精度)

### 推定実行
- [ ] `06_detection_progress.png` — 推定実行中の進捗バー表示
- [ ] `07_detection_complete.png` — 推定完了後: 骨格が描画された状態

### 表示モード
- [ ] `08_skeleton_mode.png` — 骨格モード: 動画なし、骨格のみ表示
- [ ] `09_graph_mode_overview.png` — グラフモード一覧: 全ポイントのx/y推移
- [ ] `10_graph_mode_detail.png` — グラフモード詳細: 特定ポイントの拡大表示

### データクレンジング
- [ ] `11_id_switch.png` — 複数人物のID操作 (入れ替え/削除)
- [ ] `12_manual_digitize.png` — 手動デジタイズモード: マウスでポイント修正

### フィルタリング
- [ ] `13_filter_settings.png` — フィルタリング設定ダイアログ

### エクスポート
- [ ] `14_export_dialog.png` — エクスポートダイアログ (CSV/JSON/動画)

---

## MotionDigitizer (保存先: picture/MotionDigitizer/)

### 基本画面
- [ ] `01_main_window.png` — メイン画面: 動画読み込み状態
- [ ] `02_tab_overview.png` — 6タブ構成の全体像 (デジタイズ/ポイント設定/キャリブ等)

### キャリブレーション
- [ ] `03_calib_dlt_2d.png` — 2D DLTキャリブレーション: コントロールポイント設定中
- [ ] `04_calib_dlt_3d.png` — 3D DLTキャリブレーション: 2台カメラの対応点設定
- [ ] `05_calib_charuco.png` — ChArUcoボード自動検出結果
- [ ] `06_calib_4point.png` — 4点実長換算: 矩形ポイント設定
- [ ] `07_calib_cc_method.png` — CC法: 競技場特徴点によるキャリブレーション

### デジタイズ操作
- [ ] `08_point_settings.png` — ポイント設定タブ: ポイント名/色/接続線の定義
- [ ] `09_manual_digitize.png` — 手動デジタイズ中の画面 (拡大ルーペ表示)
- [ ] `10_hpe_import.png` — HPE CSVインポート後の表示

### データテーブル
- [ ] `11_table_view.png` — モーションデータタブ: 座標テーブル一覧
- [ ] `12_table_edit.png` — テーブルのセル編集中

### プレビュー・出力
- [ ] `13_3d_preview.png` — 3Dプレビュー: Three.jsによる3D表示
- [ ] `14_analysis_result.png` — 分析結果タブ: DLT残差/精度情報
- [ ] `15_export_dialog.png` — エクスポートダイアログ (CSV/C3D/TRC)

---

## MotionViewer (保存先: picture/MotionViewer/)

### 基本画面
- [ ] `01_main_window.png` — メイン画面: 3Dスティックピクチャ表示
- [ ] `02_multi_format.png` — 複数形式のデータ読み込み (c3d/csv/sd等)

### 3Dビューア
- [ ] `03_view_front.png` — 正面ビュー
- [ ] `04_view_side.png` — 側面ビュー
- [ ] `05_view_top.png` — 上面ビュー
- [ ] `06_view_free.png` — 自由視点: ユーザーが回転/ズームした状態

### 再生コントロール
- [ ] `07_playback_controls.png` — 再生コントロールバー (再生/停止/速度/フレーム番号)

### スティックピクチャ設定
- [ ] `08_stick_settings.png` — スティックピクチャ設定: ポイント/ラインの表示切替
- [ ] `09_inertia_ellipsoid.png` — 慣性楕円体表示

### 分析機能
- [ ] `10_graph_displacement.png` — グラフ: 変位の時系列
- [ ] `11_graph_velocity.png` — グラフ: 速度の時系列
- [ ] `12_graph_angle.png` — グラフ: 関節角度の時系列
- [ ] `13_com_display.png` — 身体重心: 軌跡をスティックピクチャに重畳表示
- [ ] `14_com_settings.png` — 身体重心設定: BSPモデル選択

### フィルタリング
- [ ] `15_filter_dialog.png` — Butterworthフィルタ設定ダイアログ (カットオフ周波数等)
- [ ] `16_filter_before_after.png` — フィルタ適用前後の比較 (グラフ上で)

### シーケンスドロー
- [ ] `17_sequence_draw.png` — シーケンスドロー: 連続フレーム重畳表示
- [ ] `18_sequence_settings.png` — シーケンスドロー設定 (間隔/色/透明度)

### エクスポート
- [ ] `19_export_video.png` — 動画エクスポート中の画面
- [ ] `20_export_image.png` — 画像エクスポート (PNG)

---

## 撮影のポイント

- ダークテーマの画面なので、背景はデスクトップではなく**アプリウィンドウのみ**を撮影
- macOS: `Cmd + Shift + 4` → `Space` でウィンドウ単位撮影
- ダイアログは**開いた状態で値が入っている**ものを撮影（空のダイアログは分かりにくい）
- データが表示されている状態を撮影（空画面は避ける）
- 解説で参照するボタンやUIは**赤丸や矢印で注釈を入れる必要はない**（マニュアル本文で説明するため）

## 合計

| アプリ | 枚数 |
|---|---|
| VideoSyncLab | 10 |
| HPE | 14 |
| MotionDigitizer | 15 |
| MotionViewer | 20 |
| **合計** | **59** |
