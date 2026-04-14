/**
 * undo-manager.js
 * 操作のUndo/Redoを管理するクラス
 */

class UndoManager {
    constructor() {
        this.undoStack = [];
        this.redoStack = [];
        this.limit = 50; // 履歴の最大保持数
    }

    /**
     * 新しい操作を実行し、履歴に追加する
     * @param {Object} command - execute() と undo() メソッドを持つオブジェクト
     */
    execute(command) {
        if (!command || typeof command.execute !== 'function' || typeof command.undo !== 'function') {
            console.error('Invalid command object');
            return;
        }

        // コマンドを実行
        command.execute();

        // スタックに追加
        this.undoStack.push(command);

        // Redoスタックをクリア（新しい操作が行われたため）
        this.redoStack = [];

        // 制限を超えたら古いものを削除
        if (this.undoStack.length > this.limit) {
            this.undoStack.shift();
        }

        this.updateUI();
    }

    /**
     * 操作を取り消す
     */
    undo() {
        if (this.undoStack.length === 0) return;

        const command = this.undoStack.pop();
        command.undo();
        this.redoStack.push(command);

        this.refreshUI();
    }

    /**
     * 操作をやり直す
     */
    redo() {
        if (this.redoStack.length === 0) return;

        const command = this.redoStack.pop();
        command.execute();
        this.undoStack.push(command);

        this.refreshUI();
    }

    /**
     * 履歴をクリア
     */
    clear() {
        this.undoStack = [];
        this.redoStack = [];
        this.updateButtons();
        this.updateUI();
    }

    /**
     * Undo/Redo後にテーブル・キャンバス・ミニマップを統一的に更新
     */
    refreshUI() {
        // モーションテーブル更新
        if (typeof window.updateMotionDataTableForCurrentCamera === 'function') {
            window.updateMotionDataTableForCurrentCamera();
        }
        // キャリブレーションテーブル更新
        if (typeof window.updateCalibrationDataTable === 'function') {
            window.updateCalibrationDataTable();
        }
        // キャンバス再描画
        if (typeof window.redrawCanvas === 'function') {
            window.redrawCanvas();
        }
        // ミニマップ更新
        if (typeof window.updateMotionTabMinimap === 'function') {
            window.updateMotionTabMinimap();
        }
        // ボタン状態更新
        this.updateButtons();
        // メニュー状態通知
        this.updateUI();
    }

    /**
     * Undo/Redoボタンのdisabled状態を更新
     */
    updateButtons() {
        const undoBtn = document.getElementById('btn-undo');
        const redoBtn = document.getElementById('btn-redo');
        if (undoBtn) {
            undoBtn.disabled = !this.canUndo();
            const desc = this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].description : '';
            undoBtn.title = this.canUndo() ? `元に戻す: ${desc} (Ctrl+Z)` : '元に戻す (Ctrl+Z)';
        }
        if (redoBtn) {
            redoBtn.disabled = !this.canRedo();
            const desc = this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1].description : '';
            redoBtn.title = this.canRedo() ? `やり直す: ${desc} (Ctrl+Y)` : 'やり直す (Ctrl+Y)';
        }
        // キャリブレーションタブ用ボタン
        const undoBtnCal = document.getElementById('btn-undo-cal');
        const redoBtnCal = document.getElementById('btn-redo-cal');
        if (undoBtnCal) {
            undoBtnCal.disabled = !this.canUndo();
        }
        if (redoBtnCal) {
            redoBtnCal.disabled = !this.canRedo();
        }
    }

    /**
     * UI（メニューの有効/無効など）を更新
     */
    updateUI() {
        // メインプロセスにUndo/Redo状態を通知してメニューを更新
        try {
            const ipcRenderer = window.ipcRenderer || (window.require && window.require('electron').ipcRenderer);
            if (ipcRenderer) {
                ipcRenderer.send('update-undo-redo-state', {
                    canUndo: this.canUndo(),
                    canRedo: this.canRedo()
                });
            }
        } catch (_) { }
    }

    canUndo() {
        return this.undoStack.length > 0;
    }

    canRedo() {
        return this.redoStack.length > 0;
    }
}

// グローバルインスタンスを作成
window.undoManager = new UndoManager();
