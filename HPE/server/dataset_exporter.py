# -*- coding: utf-8 -*-
import os
import cv2
import numpy as np
import yaml
import shutil
import random
from pathlib import Path
from datetime import datetime

class YoloDatasetExporter:
    """
    現在の解析結果（動画 + 23点キーポイント）を
    YOLO Pose学習用データセットとしてエクスポートするクラス
    """
    
    def __init__(self, output_root="datasets"):
        self.output_root = Path(output_root)
        
    def export(self, video_path, keypoints_data, dataset_name=None, train_ratio=0.8):
        """
        データセットをエクスポート
        
        Args:
            video_path (str): 動画ファイルのパス
            keypoints_data (dict): フレームごとのキーポイントデータ {frame_idx: [[x,y,score]...23pts]}
            dataset_name (str): データセット名（指定なければ日時）
            train_ratio (float): 学習データの割合 (0.0 ~ 1.0)
            
        Returns:
            str: 出力先ディレクトリのパス
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video file not found: {video_path}")
            
        # データセット名決定
        if not dataset_name:
            dataset_name = datetime.now().strftime("dataset_%Y%m%d_%H%M%S")
        
        base_dir = self.output_root / dataset_name
        
        # ディレクトリ作成
        # images/train, images/val, labels/train, labels/val
        dirs = {
            "train_img": base_dir / "images" / "train",
            "val_img": base_dir / "images" / "val",
            "train_lbl": base_dir / "labels" / "train",
            "val_lbl": base_dir / "labels" / "val"
        }
        
        for d in dirs.values():
            d.mkdir(parents=True, exist_ok=True)
            
        print(f"Exporting dataset to: {base_dir}")
        
        # 動画読み込み
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"Failed to open video: {video_path}")
            # Try likely fix for non-ascii path if needed, but usually Python 3 handles it.
            # If failed, we cannot proceed.
            raise FileNotFoundError(f"Could not open video file: {video_path}")
            
        fps = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        exported_count = 0
        video_stem = Path(video_path).stem
        
        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
                
            # このフレームにキーポイントデータがあるか確認
            # keypoints_dataのキーは通常文字列または整数
            # JSから来るデータ形式に合わせて柔軟に対応
            kpts = keypoints_data.get(frame_idx) or keypoints_data.get(str(frame_idx))
            
            if kpts:
                # 振り分け (Train or Val)
                is_train = random.random() < train_ratio
                split_name = "train" if is_train else "val"
                
                img_dir = dirs[f"{split_name}_img"]
                lbl_dir = dirs[f"{split_name}_lbl"]
                
                # ファイル名 (動画名_フレーム番号)
                file_base = f"{video_stem}_{frame_idx:06d}"
                img_path = img_dir / f"{file_base}.jpg"
                lbl_path = lbl_dir / f"{file_base}.txt"
                
                # キーポイントデータをリスト化（複数人対応）
                persons_kpts = []
                if isinstance(kpts, dict):
                    # {pid: kpts} 形式
                    persons_kpts = list(kpts.values())
                elif isinstance(kpts, list) and len(kpts) > 0 and isinstance(kpts[0][0], (int, float)):
                    # [ [x,y,s], ... ] 単一人
                    persons_kpts = [kpts]
                elif isinstance(kpts, list):
                    # リストのリスト？ (基本は↑でカバーされるはずだが念のため)
                    persons_kpts = kpts

                valid_annotations = []
                
                for person_kpts in persons_kpts:
                    # キーポイントデータの整形 (23点)
                    kpts_np = np.array(person_kpts)
                    
                    # バウンディングボックスの計算 (キーポイントを包含する矩形)
                    # 有効な点(score > 0)のみで計算
                    valid_pts = kpts_np[kpts_np[:, 2] > 0]
                    
                    if len(valid_pts) > 0:
                        min_x = np.min(valid_pts[:, 0])
                        max_x = np.max(valid_pts[:, 0])
                        min_y = np.min(valid_pts[:, 1])
                        max_y = np.max(valid_pts[:, 1])
                        
                        # 若干のマージンを追加
                        margin_x = (max_x - min_x) * 0.1
                        margin_y = (max_y - min_y) * 0.1
                        
                        x1 = max(0, min_x - margin_x)
                        y1 = max(0, min_y - margin_y)
                        x2 = min(width, max_x + margin_x)
                        y2 = min(height, max_y + margin_y)
                        
                        # YOLO形式 (Normalized Center X, Center Y, Width, Height)
                        box_w = x2 - x1
                        box_h = y2 - y1
                        cx = x1 + box_w / 2
                        cy = y1 + box_h / 2
                        
                        # ボックスが無効ならスキップ
                        if box_w <= 0 or box_h <= 0:
                            continue

                        norm_cx = cx / width
                        norm_cy = cy / height
                        norm_w = box_w / width
                        norm_h = box_h / height
                        
                        # アノテーション文字列作成
                        # class index 0 (person)
                        line_parts = [
                            "0", 
                            f"{norm_cx:.6f}", f"{norm_cy:.6f}", 
                            f"{norm_w:.6f}", f"{norm_h:.6f}"
                        ]
                        
                        # キーポイント追加 (Normalized x, y, visibility)
                        for kp in kpts_np:
                            kx, ky, conf = kp
                            
                            # 正規化
                            nkx = kx / width
                            nky = ky / height
                            
                            # Visibility: 2=visible, 0=not visible
                            # ここでは conf > 0 なら 2 とみなす（簡易実装）
                            vis = 2 if conf > 0 else 0
                            
                            # 座標が範囲外ならvisibility=0にする
                            if nkx < 0 or nkx > 1 or nky < 0 or nky > 1:
                                vis = 0
                                nkx = 0
                                nky = 0
                                
                            line_parts.extend([f"{nkx:.6f}", f"{nky:.6f}", f"{vis}"])
                        
                        valid_annotations.append(" ".join(line_parts))
                
                # アノテーションがある場合のみ保存
                if valid_annotations:
                    # 1. 画像保存 (日本語パス対応)
                    # cv2.imwriteはWindowsの日本語パスで失敗することがあるためimencodeを使用
                    try:
                        ext = os.path.splitext(str(img_path))[1]
                        result, n = cv2.imencode(ext, frame)
                        if result:
                            with open(img_path, mode='wb') as f:
                                n.tofile(f)
                        else:
                            print(f"Failed to encode image: {img_path}")
                    except Exception as e:
                        print(f"Failed to save image {img_path}: {e}")
                    
                    # 2. アノテーション書き込み
                    with open(lbl_path, "w") as f:
                        f.write("\n".join(valid_annotations) + "\n")
                        
                    exported_count += 1
            
            frame_idx += 1
            
        cap.release()
        
        # dataset.yaml の作成
        self._create_yaml(base_dir, dataset_name)
        
        print(f"Export completed. {exported_count} frames saved to {base_dir}")
        return str(base_dir), exported_count

    def _create_yaml(self, base_dir, dataset_name):
        """dataset.yamlを作成"""
        yaml_content = {
            "path": str(base_dir.absolute()),
            "train": "images/train",
            "val": "images/val",
            "kpt_shape": [23, 3],  # 23 points
            "names": {
                0: "person"
            }
        }
        
        yaml_path = base_dir / "dataset.yaml"
        with open(yaml_path, "w") as f:
            yaml.dump(yaml_content, f, sort_keys=False)

# テスト用メイン
if __name__ == "__main__":
    pass
