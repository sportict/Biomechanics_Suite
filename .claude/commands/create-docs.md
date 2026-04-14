# ドキュメント作成

対象アプリのドキュメントを作成・更新し、`docs/` フォルダに保存します。

## 手順

1. 対象を特定する
   - 引数が指定されていればそのアプリまたはトピックを対象とする
   - 指定がなければ、直近の変更内容からドキュメント化すべき対象を提案する

2. 既存ドキュメントを確認する
   - `docs/` フォルダ内の関連ファイルを検索し、更新すべきか新規作成すべきか判断する
   - 重複ドキュメントを作らない

3. ドキュメントを作成する
   - 保存先: `/Users/k-murata/pro/Biomechanics_Suite/docs/`
   - ファイル名規則: 英語、PascalCase または snake_case（例: `ChArUco_Calibration_Guide.md`）
   - 言語: 日本語
   - 形式: Markdown (.md)

4. ドキュメントの種類と構成

   **ユーザーマニュアル系**
   - 概要、前提条件、操作手順、トラブルシューティング

   **技術ドキュメント系**
   - 背景・目的、理論/アルゴリズム、実装詳細、使用例

   **インストール/セットアップ系**
   - 前提条件、インストール手順（OS別）、確認方法、トラブルシューティング

5. 既存ドキュメントの一覧を更新する必要があれば提案する

## 既存ドキュメント構成

```
docs/
  INSTALL_Mac.md                    - macOS インストールマニュアル
  INSTALL_Windows.md                - Windows インストールマニュアル
  OpenCV_Installation_Guide.md      - OpenCV 導入ガイド
  Biomechanics_Suite_Integration.md - スイート統合設計書
  SBM_Integration_Map.md            - システム連携マップ
  SBM_System_Manual.md              - SBM システムマニュアル
  SBM_User_Manual.md                - ユーザーマニュアル
  SBM_Technical_Bible.md            - 技術リファレンス
  SBM_Project_Manager_Spec.md       - プロジェクト管理仕様
  InverseDynamics_Theory.md         - 逆動力学の理論
  InverseDynamics_Implementation.md - 逆動力学の実装
  CC_Method_Guide.md                - 3次元 CC 法ガイド
  ChArUco_Calibration_Guide.md      - ChArUco キャリブレーション
  Calibration_Accuracy_Guide.md     - キャリブレーション精度
  MotionDigitizer_Manual.html       - MotionDigitizer マニュアル
  MotionViewer_ROADMAP.md           - MotionViewer ロードマップ
  MotionViewer_ExternalData_Ideas.md - 外部データ連携アイデア
```

## 対象アプリ一覧

- **MotionViewer** - 軽量モーションデータ 3D 可視化
- **VideoSyncLab** - 二画面動画同期編集
- **MotionDigitizer** - 3D モーションキャプチャ解析
- **HPE** - Human Pose Estimation（姿勢推定）

$ARGUMENTS
