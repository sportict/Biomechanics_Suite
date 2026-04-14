# バックアップ作成

指定されたアプリの現在のソースコードをバックアップします。

## 手順

1. 対象アプリを特定する
   - 引数からアプリ名を取得する（MotionViewer, VideoSyncLab, MotionDigitizer, HPE）
   - 指定がなければどのアプリをバックアップするか確認する

2. バックアップ先ディレクトリを作成する
   - 保存先: `/Users/k-murata/pro/Biomechanics_Suite/Backups/`
   - フォルダ名規則: `{アプリ名}_{YYYYMMDD}`（例: `HPE_20260411`）
   - 同名フォルダが既にある場合は `{アプリ名}_{YYYYMMDD}_{連番}` にする

3. バックアップ対象ファイルをコピーする
   - ソースコード、設定ファイル、HTMLなど開発成果物のみ
   - **除外するもの:**
     - `node_modules/`
     - `dist/`
     - `.venv/`
     - `python-embed/`
     - `package-lock.json`
     - `.DS_Store`
     - `*.log`
     - `Models/` (ONNX モデルファイルは大きいため除外)
     - `vendor/` (外部バイナリ)
     - `build/` ディレクトリ内のビルド成果物

4. バックアップ内容を報告する
   - コピーしたファイル数
   - バックアップ先パス
   - 合計サイズ

## rsync コマンドテンプレート

```bash
rsync -av --progress \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.venv' \
  --exclude='python-embed' \
  --exclude='package-lock.json' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='Models' \
  --exclude='vendor' \
  --exclude='build/Release' \
  --exclude='build/Debug' \
  --exclude='native/build' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  {ソースディレクトリ}/ {バックアップ先}/
```

## アプリのソースディレクトリ

| アプリ | パス |
|---|---|
| MotionViewer | `/Users/k-murata/pro/Biomechanics_Suite/MotionViewer` |
| VideoSyncLab | `/Users/k-murata/pro/Biomechanics_Suite/VideoSyncLab` |
| MotionDigitizer | `/Users/k-murata/pro/Biomechanics_Suite/MotionDigitizer` |
| HPE | `/Users/k-murata/pro/Biomechanics_Suite/HPE` |

## 既存バックアップの確認

バックアップ実行前に `Backups/` の既存内容を `ls` で確認し、
重複がないことを確認してから実行する。

$ARGUMENTS
