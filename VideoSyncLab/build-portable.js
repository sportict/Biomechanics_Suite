#!/usr/bin/env node
/**
 * Windows Portable最適化ビルドスクリプト
 * VideoSyncLab専用
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class PortableBuildOptimizer {
    constructor() {
        this.distPath = path.join(__dirname, 'dist');
        this.tempPath = path.join(__dirname, '.temp-build');
    }

    async build() {
        console.log('🚀 Windows Portable最適化ビルドを開始...');
        
        try {
            // Step 1: クリーンアップ
            await this.cleanup();
            
            // Step 2: 依存関係の最適化
            await this.optimizeDependencies();
            
            // Step 3: ビルド実行
            await this.executeBuild();
            
            // Step 4: ポストプロセス最適化
            await this.postProcess();
            
            console.log('✅ Windows Portable最適化ビルド完了!');
            
        } catch (error) {
            console.error('❌ ビルドエラー:', error.message);
            process.exit(1);
        }
    }

    async cleanup() {
        console.log('🧹 クリーンアップ中...');
        
        // 既存のdistディレクトリを削除
        if (fs.existsSync(this.distPath)) {
            execSync(`rimraf "${this.distPath}"`, { stdio: 'inherit' });
        }
        
        // node_modules/.cacheを削除
        const cachePath = path.join(__dirname, 'node_modules', '.cache');
        if (fs.existsSync(cachePath)) {
            execSync(`rimraf "${cachePath}"`, { stdio: 'inherit' });
        }
    }

    async optimizeDependencies() {
        console.log('📦 依存関係最適化中...');
        
        // 全ての依存関係をインストール（electron-builderが必要）
        execSync('npm ci', { stdio: 'inherit' });
        
        // 不要なファイルを事前削除
        const unnecessaryPaths = [
            'node_modules/**/test',
            'node_modules/**/tests',
            'node_modules/**/*.md',
            'node_modules/**/*.txt',
            'node_modules/**/example*',
            'node_modules/**/demo*'
        ];
        
        unnecessaryPaths.forEach(pattern => {
            try {
                execSync(`rimraf "${pattern}"`, { stdio: 'pipe' });
            } catch (e) {
                // エラーは無視
            }
        });
    }

    async executeBuild() {
        console.log('🔨 Electronビルド実行中...');
        
        // 環境変数設定
        const env = {
            ...process.env,
            NODE_ENV: 'production',
            ELECTRON_BUILDER_COMPRESSION_LEVEL: '9'
        };
        
        // ビルド実行
        execSync('electron-builder --win portable --x64', {
            stdio: 'inherit',
            env
        });
    }

    async postProcess() {
        console.log('🎯 ポストプロセス最適化中...');
        
        const exePath = this.findExecutable();
        if (exePath) {
            console.log(`📁 実行ファイル: ${exePath}`);
            
            // ファイルサイズを表示
            const stats = fs.statSync(exePath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`📊 ファイルサイズ: ${sizeMB} MB`);
            
            // 最適化情報を出力
            this.generateOptimizationReport(exePath, sizeMB);
        }
    }

    findExecutable() {
        if (!fs.existsSync(this.distPath)) return null;
        
        const files = fs.readdirSync(this.distPath);
        const exeFile = files.find(file => file.endsWith('.exe') && file.includes('VideoSyncLab'));
        
        return exeFile ? path.join(this.distPath, exeFile) : null;
    }

    generateOptimizationReport(exePath, sizeMB) {
        const report = `
# Windows Portable最適化レポート

## ビルド情報
- 実行ファイル: ${path.basename(exePath)}
- ファイルサイズ: ${sizeMB} MB
- ビルド日時: ${new Date().toLocaleString('ja-JP')}

## 適用された最適化
✅ Windows固有のハードウェア加速
✅ メモリ使用量最適化 (512MB制限)
✅ FFmpeg処理の並列化
✅ DOM要素キャッシュ
✅ フレーム更新頻度制限 (20fps)
✅ 不要ファイルの除外
✅ 最大圧縮レベル適用

## 使用方法
1. ${path.basename(exePath)} をダブルクリックで起動
2. 設定ファイルは実行ファイルと同じフォルダに保存
3. ポータブル実行 - インストール不要

## パフォーマンス目標
- 起動時間: < 3秒
- メモリ使用量: < 512MB
- 4K動画処理: 安定動作
`;

        const reportPath = path.join(this.distPath, 'OPTIMIZATION_REPORT.md');
        fs.writeFileSync(reportPath, report.trim());
        console.log('📋 最適化レポートを生成しました');
    }
}

// スクリプト実行
if (require.main === module) {
    const optimizer = new PortableBuildOptimizer();
    optimizer.build().catch(console.error);
}

module.exports = PortableBuildOptimizer; 