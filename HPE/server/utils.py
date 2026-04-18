#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HPE Shared Utilities
共通定数、関数、クラスの定義
main.py と ipc_handler.py で共有
"""

import numpy as np
from typing import Dict, Any

import sys

# ===================================
# キーポイント定義（23点形式）
# ===================================
KEYPOINT_NAMES_23 = [
    'right_hand_tip', 'right_wrist', 'right_elbow', 'right_shoulder',
    'left_hand_tip', 'left_wrist', 'left_elbow', 'left_shoulder',
    'right_toe_tip', 'right_small_toe', 'right_heel', 'right_ankle', 'right_knee', 'right_hip',
    'left_toe_tip', 'left_small_toe', 'left_heel', 'left_ankle', 'left_knee', 'left_hip',
    'head_top', 'tragus_point', 'suprasternal_notch'
]

# ===================================
# キーポイント定義（25点形式・阿江モデル対応）
# SynthPose 52点出力から変換
# ===================================

# ===================================
# キーポイント定義（SynthPose / OpenCapBench形式 - 52点）
# モデル出力順に準拠（id2label）: COCO 17点 → SynthPose固有 35点
# ===================================
KEYPOINT_NAMES_SYNTHPOSE = [
    # COCO 17点 (0-16)
    'Nose',         # 0
    'L_Eye',        # 1
    'R_Eye',        # 2
    'L_Ear',        # 3
    'R_Ear',        # 4
    'L_Shoulder',   # 5
    'R_Shoulder',   # 6
    'L_Elbow',      # 7
    'R_Elbow',      # 8
    'L_Wrist',      # 9
    'R_Wrist',      # 10
    'L_Hip',        # 11
    'R_Hip',        # 12
    'L_Knee',       # 13
    'R_Knee',       # 14
    'L_Ankle',      # 15
    'R_Ankle',      # 16
    # SynthPose固有 (17-51)
    'sternum',      # 17 胸骨上縁
    'rshoulder',    # 18 右肩峰
    'lshoulder',    # 19 左肩峰
    'r_lelbow',     # 20 右外側上顆
    'l_lelbow',     # 21 左外側上顆
    'r_melbow',     # 22 右内側上顆（推定値）
    'l_melbow',     # 23 左内側上顆（推定値）
    'r_lwrist',     # 24 右橈骨茎状突起
    'l_lwrist',     # 25 左橈骨茎状突起
    'r_mwrist',     # 26 右尺骨茎状突起（推定値）
    'l_mwrist',     # 27 左尺骨茎状突起（推定値）
    'r_ASIS',       # 28 右上前腸骨棘
    'l_ASIS',       # 29 左上前腸骨棘
    'r_PSIS',       # 30 右上後腸骨棘（低信頼度）
    'l_PSIS',       # 31 左上後腸骨棘（低信頼度）
    'r_knee',       # 32 右外側顆
    'l_knee',       # 33 左外側顆
    'r_mknee',      # 34 右内側顆（推定値）
    'l_mknee',      # 35 左内側顆（推定値）
    'r_ankle',      # 36 右外果
    'l_ankle',      # 37 左外果
    'r_mankle',     # 38 右内果（推定値）
    'l_mankle',     # 39 左内果（推定値）
    'r_5meta',      # 40 右第5中足骨頭
    'l_5meta',      # 41 左第5中足骨頭
    'r_toe',        # 42 右つま先
    'l_toe',        # 43 左つま先
    'r_big_toe',    # 44 右母趾
    'l_big_toe',    # 45 左母趾
    'l_calc',       # 46 左踵骨
    'r_calc',       # 47 右踵骨
    'C7',           # 48 第7頸椎
    'L2',           # 49 第2腰椎
    'T11',          # 50 第11胸椎
    'T6',           # 51 第6胸椎
]

# ===================================
# Norfair Person Tracker
# ===================================
try:
    from norfair import Detection, Tracker
    from norfair.distances import create_normalized_mean_euclidean_distance
    NORFAIR_AVAILABLE = True
except ImportError:
    NORFAIR_AVAILABLE = False
    Detection = None
    Tracker = None

class NorfairPersonTracker:
    """
    Norfairを使用した高精度人物追跡トラッカー
    カルマンフィルタによる位置予測で安定したID割り当てを実現
    """
    def __init__(self, distance_threshold: float = 0.5, hit_counter_max: int = 15,
                 initialization_delay: int = 3):
        """
        Parameters:
        - distance_threshold: マッチング閾値（0-1、正規化された距離）
        - hit_counter_max: オクルージョン対応のための最大フレーム数
        - initialization_delay: IDを確定するまでの待機フレーム数
        """
        self.distance_threshold = distance_threshold
        self.hit_counter_max = hit_counter_max
        self.initialization_delay = initialization_delay
        self.tracker = None
        self.height = 1080
        self.width = 1920
        self._init_tracker()

    def _init_tracker(self):
        """トラッカーを初期化"""
        if NORFAIR_AVAILABLE:
            distance_function = create_normalized_mean_euclidean_distance(self.height, self.width)
            self.tracker = Tracker(
                distance_function=distance_function,
                distance_threshold=self.distance_threshold,
                hit_counter_max=self.hit_counter_max,
                initialization_delay=self.initialization_delay,
                pointwise_hit_counter_max=4,
            )

    def reset(self, height=None, width=None, initialization_delay=None, hit_counter_max=None):
        """トラッカーをリセット"""
        if height is not None: self.height = height
        if width is not None: self.width = width
        if initialization_delay is not None: self.initialization_delay = initialization_delay
        if hit_counter_max is not None: self.hit_counter_max = hit_counter_max
        self._init_tracker()
        # フォールバックトラッカーもリセット
        self._fb_tracks = {}   # {stable_id: centroid_array}
        self._fb_next_id = 0
        self._fb_distance_threshold = max(self.width, self.height) * self.distance_threshold
        self._unmatched_counter = 0

    # ------------------------------------------------------------------
    # Norfair 非対応環境向け：scipy ベース重心マッチングフォールバック
    # ------------------------------------------------------------------
    def _fallback_track(self, frame_data: Dict[str, Any]) -> Dict[str, np.ndarray]:
        """ハンガリアン法＋重心距離による軽量トラッカー（Norfair代替）"""
        if not hasattr(self, '_fb_tracks'):
            self._fb_tracks = {}
            self._fb_next_id = 0
            self._fb_distance_threshold = max(self.width, self.height) * self.distance_threshold

        # --- 各検出の重心を計算 ---
        det_list = []   # [(orig_id, centroid, kpts)]
        for orig_id, data in frame_data.items():
            if isinstance(data, dict) and 'keypoints' in data:
                kpts = data['keypoints']
                bbox = data.get('bbox')
            else:
                kpts = data
                bbox = None

            if bbox is not None:
                cx = (bbox[0] + bbox[2]) / 2
                cy = (bbox[1] + bbox[3]) / 2
                centroid = np.array([cx, cy], dtype=np.float32)
            else:
                valid = kpts[:, 2] > 0.3
                if np.sum(valid) < 3:
                    centroid = np.array([kpts[:, 0].mean(), kpts[:, 1].mean()], dtype=np.float32)
                else:
                    centroid = np.array([kpts[valid, 0].mean(), kpts[valid, 1].mean()], dtype=np.float32)

            det_list.append((orig_id, centroid, kpts))

        if not det_list:
            return {}

        result = {}

        if not self._fb_tracks:
            # 初フレーム：全検出に新規 ID を振る
            for orig_id, centroid, kpts in det_list:
                sid = str(self._fb_next_id)
                self._fb_next_id += 1
                self._fb_tracks[sid] = centroid
                result[sid] = kpts
            return result

        # --- ハンガリアン法でマッチング ---
        from scipy.optimize import linear_sum_assignment
        track_ids = list(self._fb_tracks.keys())
        track_cents = np.array([self._fb_tracks[tid] for tid in track_ids])  # (T, 2)
        det_cents = np.array([d[1] for d in det_list])                        # (D, 2)

        # コスト行列：ユークリッド距離 (D x T)
        diff = det_cents[:, None, :] - track_cents[None, :, :]  # (D, T, 2)
        cost = np.sqrt((diff ** 2).sum(axis=2))                  # (D, T)

        row_ind, col_ind = linear_sum_assignment(cost)

        matched_dets = set()
        new_tracks = {}
        for r, c in zip(row_ind, col_ind):
            if cost[r, c] <= self._fb_distance_threshold:
                sid = track_ids[c]
                orig_id, centroid, kpts = det_list[r]
                new_tracks[sid] = centroid
                result[sid] = kpts
                matched_dets.add(r)

        # 未マッチ検出 → 新規 ID
        for i, (orig_id, centroid, kpts) in enumerate(det_list):
            if i not in matched_dets:
                sid = str(self._fb_next_id)
                self._fb_next_id += 1
                new_tracks[sid] = centroid
                result[sid] = kpts

        self._fb_tracks = new_tracks
        return result

    # トラッキング用アンカーキーポイント (HALPE 26pt)
    # bbox中心は検出器のノイズに弱いため、安定した体幹関節を使用
    # 肩・腰の4点は姿勢変化に対してもっとも安定的
    _ANCHOR_INDICES = [5, 6, 11, 12]  # L_Shoulder, R_Shoulder, L_Hip, R_Hip

    def track(self, frame_data: Dict[str, Any]) -> Dict[str, np.ndarray]:
        """
        フレームのデータを追跡して安定したIDを割り当てる

        Parameters:
        - frame_data: {original_id: {'keypoints': kpts, 'bbox': bbox}} OR {original_id: kpts}

        Returns:
        - {stable_id: keypoints_array}
          stable_id は Norfair が割り当てた一貫した整数ID (文字列化)。
        """
        if not NORFAIR_AVAILABLE or self.tracker is None:
            if not getattr(self, '_logged_disabled', False):
                print("[Tracker] Norfair unavailable, using centroid fallback tracker", file=sys.stderr)
                self._logged_disabled = True
            return self._fallback_track(frame_data)

        if not frame_data:
            self.tracker.update([])
            return {}

        # --- 検出を Norfair Detection に変換 ---
        detections = []
        det_to_orig = {}  # det_index → orig_id

        for orig_id, data in frame_data.items():
            if isinstance(data, dict) and 'keypoints' in data:
                kpts = data['keypoints']
            else:
                kpts = data

            valid_mask = kpts[:, 2] > 0.3
            if np.sum(valid_mask) < 3:
                continue

            # アンカーキーポイント（肩・腰）でトラッキング
            # bbox中心よりも安定: 検出bboxの揺らぎに影響されない
            #
            # Norfair は TrackedObject 生成後、全ての update で同じポイント数を要求する
            # (内部の point_hit_counter が初回サイズで固定されるため)。
            # そのため常に 4 スロット固定で Detection を作成し、信頼度の低いスロットは
            # 重心座標で埋めて Norfair の score しきい値で無効化させる。
            valid_points = kpts[valid_mask, :2]
            centroid = np.mean(valid_points, axis=0)

            points = np.tile(centroid, (len(self._ANCHOR_INDICES), 1)).astype(np.float32)
            scores = np.zeros(len(self._ANCHOR_INDICES), dtype=np.float32)
            num_valid_anchors = 0
            for slot_idx, kpt_idx in enumerate(self._ANCHOR_INDICES):
                if kpt_idx < len(kpts) and kpts[kpt_idx, 2] > 0.3:
                    points[slot_idx] = kpts[kpt_idx, :2]
                    scores[slot_idx] = float(kpts[kpt_idx, 2])
                    num_valid_anchors += 1

            # 肩・腰がほぼ検出できていない場合は重心1点相当の低信頼度で代用
            if num_valid_anchors == 0:
                avg_score = float(np.mean(kpts[valid_mask, 2]))
                scores[:] = max(0.31, min(avg_score, 0.9))

            det_idx = len(detections)
            detections.append(Detection(points=points, scores=scores))
            det_to_orig[det_idx] = orig_id

        # --- Norfair トラッカー更新 ---
        tracked_objects = self.tracker.update(detections)

        # --- Detection → TrackedObject のマッピングを構築 ---
        # Detection オブジェクトの id() をキーにして O(1) 参照
        det_id_to_idx = {id(det): idx for idx, det in enumerate(detections)}
        matched_det_indices = set()

        result = {}
        for tracked_obj in tracked_objects:
            if tracked_obj.last_detection is None:
                continue
            det_idx = det_id_to_idx.get(id(tracked_obj.last_detection))
            if det_idx is None or det_idx not in det_to_orig:
                continue

            matched_det_indices.add(det_idx)
            orig_id = det_to_orig[det_idx]
            stable_id = str(tracked_obj.id)

            data = frame_data[orig_id]
            result[stable_id] = data['keypoints'] if isinstance(data, dict) else data

        # --- 未マッチの検出にも一貫したIDを付与 ---
        # initialization_delay=0 ならほぼ発生しないが、安全のため処理。
        # orig_id（フレーム連番 "0","1"...）をそのまま返すと Norfair ID と衝突するため、
        # Norfair ID空間（正の整数）と衝突しない大きな負のIDを付与する。
        # フロントエンドは Number() でソートするため、数値IDが必須。
        if not hasattr(self, '_unmatched_counter'):
            self._unmatched_counter = 0
        for det_idx, orig_id in det_to_orig.items():
            if det_idx not in matched_det_indices:
                self._unmatched_counter += 1
                # 負の大きな数で Norfair の正のIDと衝突しない
                fallback_id = str(-(10000 + self._unmatched_counter))

                data = frame_data[orig_id]
                result[fallback_id] = data['keypoints'] if isinstance(data, dict) else data

        return result


# ===================================
# キーポイント変換関数
# ===================================
def convert_to_23_keypoints(kpts: np.ndarray) -> np.ndarray:
    """ViTPose wholebodyの出力を23点形式に変換"""
    body_kpts = kpts[:17]
    foot_kpts = kpts[17:23]
    left_hand_kpts = kpts[91:112] if len(kpts) > 111 else None
    right_hand_kpts = kpts[112:133] if len(kpts) > 132 else None

    ordered_kpts = np.zeros((23, 3))

    # 右上肢
    ordered_kpts[1] = body_kpts[10]  # right wrist
    ordered_kpts[2] = body_kpts[8]   # right elbow
    ordered_kpts[3] = body_kpts[6]   # right shoulder
    # 右手先（3rd MCP）: 手のランドマークがあれば直接使用、なければ前腕延長で推定
    if right_hand_kpts is not None and len(right_hand_kpts) > 9 and right_hand_kpts[9][2] > 0.2:
        ordered_kpts[0] = right_hand_kpts[9]
    else:
        r_wrist, r_elbow = body_kpts[10], body_kpts[8]
        if r_wrist[2] > 0.3 and r_elbow[2] > 0.3:
            vec = r_wrist[:2] - r_elbow[:2]
            fore_len = np.linalg.norm(vec)
            if fore_len > 1.0:
                ordered_kpts[0, :2] = r_wrist[:2] + (vec / fore_len) * fore_len * 0.25
                ordered_kpts[0, 2] = r_wrist[2] * 0.75

    # 左上肢
    ordered_kpts[5] = body_kpts[9]   # left wrist
    ordered_kpts[6] = body_kpts[7]   # left elbow
    ordered_kpts[7] = body_kpts[5]   # left shoulder
    # 左手先（3rd MCP）
    if left_hand_kpts is not None and len(left_hand_kpts) > 9 and left_hand_kpts[9][2] > 0.2:
        ordered_kpts[4] = left_hand_kpts[9]
    else:
        l_wrist, l_elbow = body_kpts[9], body_kpts[7]
        if l_wrist[2] > 0.3 and l_elbow[2] > 0.3:
            vec = l_wrist[:2] - l_elbow[:2]
            fore_len = np.linalg.norm(vec)
            if fore_len > 1.0:
                ordered_kpts[4, :2] = l_wrist[:2] + (vec / fore_len) * fore_len * 0.25
                ordered_kpts[4, 2] = l_wrist[2] * 0.75

    # 右下肢
    ordered_kpts[8] = foot_kpts[3]   # right_big_toe
    ordered_kpts[9] = foot_kpts[4]   # right_small_toe
    ordered_kpts[10] = foot_kpts[5]  # right_heel
    ordered_kpts[11] = body_kpts[16]
    ordered_kpts[12] = body_kpts[14]
    ordered_kpts[13] = body_kpts[12]

    # 左下肢
    ordered_kpts[14] = foot_kpts[0]  # left_big_toe
    ordered_kpts[15] = foot_kpts[1]  # left_small_toe
    ordered_kpts[16] = foot_kpts[2]  # left_heel
    ordered_kpts[17] = body_kpts[15]
    ordered_kpts[18] = body_kpts[13]
    ordered_kpts[19] = body_kpts[11]

    # 頭部・体幹
    nose = body_kpts[0]

    # 頚切痕（Neck/Suprasternal Notch） - Index 22
    left_shoulder = body_kpts[5]
    right_shoulder = body_kpts[6]
    has_neck = False

    if left_shoulder[2] > 0.3 and right_shoulder[2] > 0.3:
        ordered_kpts[22] = np.array([
            (left_shoulder[0] + right_shoulder[0]) / 2,
            (left_shoulder[1] + right_shoulder[1]) / 2,
            min(left_shoulder[2], right_shoulder[2])
        ])
        has_neck = True

    # 耳珠点（Tragus） - Index 21
    left_ear = body_kpts[3]
    right_ear = body_kpts[4]

    if left_ear[2] > 0.3 and right_ear[2] > 0.3:
        ordered_kpts[21] = np.array([
            (left_ear[0] + right_ear[0]) / 2,
            (left_ear[1] + right_ear[1]) / 2,
            min(left_ear[2], right_ear[2])
        ])

    # 頭頂点（Head Top） - Index 20
    head_top_found = False

    if len(kpts) >= 46:
        left_inner_brow = kpts[44]
        right_inner_brow = kpts[45]

        if left_inner_brow[2] > 0.3 and right_inner_brow[2] > 0.3 and nose[2] > 0.3:
            glabella = (left_inner_brow + right_inner_brow) / 2
            vec_y = glabella[0] - nose[0]
            vec_x = glabella[1] - nose[1]

            ordered_kpts[20] = np.array([
                glabella[0] + vec_y * 1.8,
                glabella[1] + vec_x * 1.8,
                min(glabella[2], nose[2]) * 0.9
            ])
            head_top_found = True

    if not head_top_found:
        left_eye = body_kpts[1]
        right_eye = body_kpts[2]

        if left_eye[2] > 0.3 and right_eye[2] > 0.3 and nose[2] > 0.3:
            mid_eye = (left_eye + right_eye) / 2
            vec_y = mid_eye[0] - nose[0]
            vec_x = mid_eye[1] - nose[1]

            ordered_kpts[20] = np.array([
                mid_eye[0] + vec_y * 3.5,
                mid_eye[1] + vec_x * 3.5,
                min(mid_eye[2], nose[2]) * 0.85
            ])
            head_top_found = True

    if not head_top_found and has_neck and nose[2] > 0.3:
        neck = ordered_kpts[22]
        vec_y = nose[0] - neck[0]
        vec_x = nose[1] - neck[1]

        ordered_kpts[20] = np.array([
            nose[0] + vec_y * 0.8,
            nose[1] + vec_x * 0.8,
            min(nose[2], neck[2]) * 0.8
        ])
        head_top_found = True

    if not head_top_found and left_ear[2] > 0.3 and right_ear[2] > 0.3 and nose[2] > 0.3:
        ear_width = np.sqrt((left_ear[0] - right_ear[0])**2 + (left_ear[1] - right_ear[1])**2)
        ordered_kpts[20] = np.array([
            nose[0] - ear_width * 1.0,
            nose[1],
            min(nose[2], left_ear[2], right_ear[2]) * 0.6
        ])
    elif not head_top_found:
        ordered_kpts[20] = np.array([nose[0] - 30, nose[1], 0.1])

    # ONNXPoseEstimatorは [x, y, confidence] 形式で出力するため、座標スワップは不要

    return ordered_kpts


def convert_to_synthpose_keypoints(kpts: np.ndarray) -> np.ndarray:
    """ViTPose wholebodyの出力をSynthPose(OpenCapBench)形式の52点に変換

    参照: https://github.com/StanfordMIMI/OpenCapBench
    SynthPose keypoints (51点):
      sternum, rshoulder, lshoulder,
      r_lelbow, l_lelbow, r_melbow, l_melbow,
      r_lwrist, l_lwrist, r_mwrist, l_mwrist,
      r_ASIS, l_ASIS, r_PSIS, l_PSIS,
      r_knee, l_knee, r_mknee, l_mknee,
      r_ankle, l_ankle, r_mankle, l_mankle,
      r_5meta, l_5meta, r_toe, l_toe, r_big_toe, l_big_toe, l_calc, r_calc,
      r_bpinky, l_bpinky, r_tpinky, l_tpinky,
      r_bindex, l_bindex, r_tindex, l_tindex,
      r_tmiddle, l_tmiddle, r_tring, l_tring,
      r_bthumb, l_bthumb, r_tthumb, l_tthumb,
      C7, L2, T11, T6, pelvis

    ViTPose wholebody 133点構成:
      body[0:17]  : COCOキーポイント17点
      foot[17:23] : 足部6点 [l_big_toe, l_small_toe, l_heel, r_big_toe, r_small_toe, r_heel]
      face[23:91] : 顔68点
      left_hand[91:112]  : 左手21点 (wrist + 20関節)
      right_hand[112:133]: 右手21点 (wrist + 20関節)

    手のキーポイント順序 (0-indexed from hand base):
      0:wrist, 1:thumb_cmc, 2:thumb_mcp, 3:thumb_ip, 4:thumb_tip,
      5:index_mcp, 6:index_pip, 7:index_dip, 8:index_tip,
      9:middle_mcp, 10:middle_pip, 11:middle_dip, 12:middle_tip,
      13:ring_mcp, 14:ring_pip, 15:ring_dip, 16:ring_tip,
      17:pinky_mcp, 18:pinky_pip, 19:pinky_dip, 20:pinky_tip
    """
    # Body keypoints (COCO 17点)
    body = kpts[:17]
    # Foot keypoints (6点)
    foot = kpts[17:23] if len(kpts) > 22 else np.zeros((6, 3))
    # Left/right hand keypoints (各21点)
    lh = kpts[91:112] if len(kpts) > 111 else None   # left hand
    rh = kpts[112:133] if len(kpts) > 132 else None  # right hand

    # Body alias
    nose         = body[0]
    left_eye     = body[1]
    right_eye    = body[2]
    left_ear     = body[3]
    right_ear    = body[4]
    l_shoulder   = body[5]
    r_shoulder   = body[6]
    l_elbow      = body[7]
    r_elbow      = body[8]
    l_wrist      = body[9]
    r_wrist      = body[10]
    l_hip        = body[11]
    r_hip        = body[12]
    l_knee       = body[13]
    r_knee       = body[14]
    l_ankle      = body[15]
    r_ankle      = body[16]

    # Foot alias: [l_big_toe, l_small_toe, l_heel, r_big_toe, r_small_toe, r_heel]
    l_big_toe    = foot[0]
    l_small_toe  = foot[1]
    l_heel       = foot[2]
    r_big_toe    = foot[3]
    r_small_toe  = foot[4]
    r_heel       = foot[5]

    ordered = np.zeros((52, 3))

    # ---- 体幹・肩 ----
    # 0: sternum (胸骨柄 ≈ 両肩の中点)
    if l_shoulder[2] > 0.3 and r_shoulder[2] > 0.3:
        ordered[0] = [(l_shoulder[0] + r_shoulder[0]) / 2,
                      (l_shoulder[1] + r_shoulder[1]) / 2,
                      min(l_shoulder[2], r_shoulder[2])]
    # 1: rshoulder
    ordered[1] = r_shoulder
    # 2: lshoulder
    ordered[2] = l_shoulder

    # ---- 肘 ----
    # 3: r_lelbow (外側右肘), 5: r_melbow (内側右肘 ≈ 同座標・低信頼度)
    ordered[3] = r_elbow
    ordered[5] = r_elbow.copy(); ordered[5][2] *= 0.6
    # 4: l_lelbow, 6: l_melbow
    ordered[4] = l_elbow
    ordered[6] = l_elbow.copy(); ordered[6][2] *= 0.6

    # ---- 手首 ----
    # 7: r_lwrist, 9: r_mwrist (推定値)
    ordered[7] = r_wrist
    ordered[9] = r_wrist.copy(); ordered[9][2] *= 0.6
    # 8: l_lwrist, 10: l_mwrist (推定値)
    ordered[8] = l_wrist
    ordered[10] = l_wrist.copy(); ordered[10][2] *= 0.6

    # ---- 骨盤 ----
    # 11: r_ASIS ≈ 右股関節, 13: r_PSIS (後面不可視・極低信頼度)
    ordered[11] = r_hip
    ordered[13] = r_hip.copy(); ordered[13][2] *= 0.25
    # 12: l_ASIS, 14: l_PSIS
    ordered[12] = l_hip
    ordered[14] = l_hip.copy(); ordered[14][2] *= 0.25

    # ---- 膝 ----
    # 15: r_knee (外側), 17: r_mknee (内側推定値)
    ordered[15] = r_knee
    ordered[17] = r_knee.copy(); ordered[17][2] *= 0.6
    # 16: l_knee, 18: l_mknee
    ordered[16] = l_knee
    ordered[18] = l_knee.copy(); ordered[18][2] *= 0.6

    # ---- 足首 ----
    # 19: r_ankle (外側), 21: r_mankle (内側推定値)
    ordered[19] = r_ankle
    ordered[21] = r_ankle.copy(); ordered[21][2] *= 0.6
    # 20: l_ankle, 22: l_mankle
    ordered[20] = l_ankle
    ordered[22] = l_ankle.copy(); ordered[22][2] *= 0.6

    # ---- 足部 ----
    # 23: r_5meta (第5中足骨 ≈ 右小趾)
    ordered[23] = r_small_toe
    # 24: l_5meta
    ordered[24] = l_small_toe
    # 25: r_toe (右つま先)
    ordered[25] = r_big_toe
    # 26: l_toe (左つま先)
    ordered[26] = l_big_toe
    # 27: r_big_toe
    ordered[27] = r_big_toe
    # 28: l_big_toe
    ordered[28] = l_big_toe
    # 29: l_calc (左踵骨)
    ordered[29] = l_heel
    # 30: r_calc (右踵骨)
    ordered[30] = r_heel

    # ---- 手指（右手） ----
    if rh is not None and len(rh) >= 21:
        ordered[31] = rh[17]  # r_bpinky (右小指MCP)
        ordered[33] = rh[20]  # r_tpinky (右小指先端)
        ordered[35] = rh[5]   # r_bindex (右人差し指MCP)
        ordered[37] = rh[8]   # r_tindex (右人差し指先端)
        ordered[39] = rh[12]  # r_tmiddle (右中指先端)
        ordered[41] = rh[16]  # r_tring (右薬指先端)
        ordered[43] = rh[1]   # r_bthumb (右母指CM関節)
        ordered[45] = rh[4]   # r_tthumb (右母指先端)

    # ---- 手指（左手） ----
    if lh is not None and len(lh) >= 21:
        ordered[32] = lh[17]  # l_bpinky
        ordered[34] = lh[20]  # l_tpinky
        ordered[36] = lh[5]   # l_bindex
        ordered[38] = lh[8]   # l_tindex
        ordered[40] = lh[12]  # l_tmiddle
        ordered[42] = lh[16]  # l_tring
        ordered[44] = lh[1]   # l_bthumb
        ordered[46] = lh[4]   # l_tthumb

    # ---- 脊椎ランドマーク（前面映像から推定・低信頼度） ----
    has_shoulder = l_shoulder[2] > 0.3 and r_shoulder[2] > 0.3
    has_hip      = l_hip[2] > 0.3 and r_hip[2] > 0.3

    if has_shoulder:
        sh_x = (l_shoulder[0] + r_shoulder[0]) / 2
        sh_y = (l_shoulder[1] + r_shoulder[1]) / 2
        sh_c = min(l_shoulder[2], r_shoulder[2])
    if has_hip:
        hp_x = (l_hip[0] + r_hip[0]) / 2
        hp_y = (l_hip[1] + r_hip[1]) / 2
        hp_c = min(l_hip[2], r_hip[2])

    # 47: C7 (第7頸椎 ≈ 肩の中点レベル)
    if has_shoulder:
        ordered[47] = [sh_x, sh_y, sh_c * 0.4]

    if has_shoulder and has_hip:
        trunk_len = hp_y - sh_y
        mid_c = min(sh_c, hp_c) * 0.35
        body_x = (sh_x + hp_x) / 2
        # 48: L2 (第2腰椎 ≈ 肩→腰の85%)
        ordered[48] = [body_x, sh_y + trunk_len * 0.85, mid_c]
        # 49: T11 (第11胸椎 ≈ 肩→腰の65%)
        ordered[49] = [body_x, sh_y + trunk_len * 0.65, mid_c]
        # 50: T6  (第6胸椎 ≈ 肩→腰の30%)
        ordered[50] = [body_x, sh_y + trunk_len * 0.30, mid_c]

    # 51: pelvis (骨盤中心 ≈ 左右股関節の中点)
    if has_hip:
        ordered[51] = [(l_hip[0] + r_hip[0]) / 2,
                       (l_hip[1] + r_hip[1]) / 2,
                       min(l_hip[2], r_hip[2])]

    return ordered



def convert_synthpose_to_23_keypoints(kpts: np.ndarray) -> np.ndarray:
    """SynthPose 52点出力を23点形式に変換

    標準関節（肩・肘・手首・股・膝・足首）はCOCO座標（index 0-16）を使用し、
    ViTPose COCOと視覚的に一致した結果を得る。
    足部・頭部・胸骨上縁はSynthPose固有ランドマークを使用。

    SynthPose index: 0-16 = COCO 17点, 17-51 = SynthPose固有35点
    """
    out = np.zeros((23, 3), dtype=np.float32)

    # ---- COCO標準関節（直接マッピング）----
    out[1]  = kpts[10]  # right_wrist    ← COCO R_Wrist
    out[2]  = kpts[8]   # right_elbow    ← COCO R_Elbow
    out[3]  = kpts[6]   # right_shoulder ← COCO R_Shoulder
    out[5]  = kpts[9]   # left_wrist     ← COCO L_Wrist
    out[6]  = kpts[7]   # left_elbow     ← COCO L_Elbow
    out[7]  = kpts[5]   # left_shoulder  ← COCO L_Shoulder
    out[12] = kpts[14]  # right_knee     ← COCO R_Knee
    out[13] = kpts[12]  # right_hip      ← COCO R_Hip
    out[18] = kpts[13]  # left_knee      ← COCO L_Knee
    out[19] = kpts[11]  # left_hip       ← COCO L_Hip

    # ---- 足部（SynthPose固有：足首も含め外果基準で統一）----
    out[8]  = kpts[44]  # right_toe_tip   ← r_big_toe
    out[9]  = kpts[40]  # right_small_toe ← r_5meta
    out[10] = kpts[47]  # right_heel      ← r_calc
    out[11] = kpts[36]  # right_ankle     ← r_ankle（外果）
    out[14] = kpts[45]  # left_toe_tip    ← l_big_toe
    out[15] = kpts[41]  # left_small_toe  ← l_5meta
    out[16] = kpts[46]  # left_heel       ← l_calc
    out[17] = kpts[37]  # left_ankle      ← l_ankle（外果）

    # ---- 胸骨上縁（22）----
    out[22] = kpts[17]  # ← sternum

    # ---- 耳珠点（21）: COCO耳の中点 ----
    l_ear, r_ear = kpts[3], kpts[4]
    if l_ear[2] > 0.1 and r_ear[2] > 0.1:
        out[21, 0] = (l_ear[0] + r_ear[0]) / 2.0
        out[21, 1] = (l_ear[1] + r_ear[1]) / 2.0
        out[21, 2] = min(l_ear[2], r_ear[2])
    elif l_ear[2] > 0.1:
        out[21] = l_ear
    elif r_ear[2] > 0.1:
        out[21] = r_ear

    # ---- 頭頂（20）: Y軸方向のみ上方延長 ----
    nose, l_eye, r_eye = kpts[0], kpts[1], kpts[2]
    head_found = False
    if l_eye[2] > 0.2 and r_eye[2] > 0.2 and nose[2] > 0.2:
        mid_eye = (l_eye[:2] + r_eye[:2]) / 2.0
        eye_nose_dy = abs(nose[1] - mid_eye[1])
        if eye_nose_dy > 1.0:
            out[20, 0] = mid_eye[0]
            out[20, 1] = mid_eye[1] - eye_nose_dy * 3.5
            out[20, 2] = min(l_eye[2], r_eye[2], nose[2]) * 0.85
            head_found = True
    if not head_found and out[21, 2] > 0.1:
        r_shldr, l_shldr = kpts[6], kpts[5]
        if r_shldr[2] > 0.1 and l_shldr[2] > 0.1:
            span = abs(r_shldr[0] - l_shldr[0])
            if span > 5.0:
                out[20, 0] = out[21, 0]
                out[20, 1] = out[21, 1] - span * 0.65
                out[20, 2] = out[21, 2] * 0.8
                head_found = True
    if not head_found and nose[2] > 0.1:
        out[20, 0] = nose[0]
        out[20, 1] = nose[1]
        out[20, 2] = 0.1

    # ---- 右手先（0）: COCO手首から前腕方向に延長 ----
    r_wrist, r_elbow = kpts[10], kpts[8]
    if r_wrist[2] > 0.3 and r_elbow[2] > 0.3:
        vec = r_wrist[:2] - r_elbow[:2]
        fore_len = np.linalg.norm(vec)
        if fore_len > 1.0:
            out[0, :2] = r_wrist[:2] + (vec / fore_len) * fore_len * 0.25
            out[0, 2]  = r_wrist[2] * 0.75

    # ---- 左手先（4）: 同上 ----
    l_wrist, l_elbow = kpts[9], kpts[7]
    if l_wrist[2] > 0.3 and l_elbow[2] > 0.3:
        vec = l_wrist[:2] - l_elbow[:2]
        fore_len = np.linalg.norm(vec)
        if fore_len > 1.0:
            out[4, :2] = l_wrist[:2] + (vec / fore_len) * fore_len * 0.25
            out[4, 2]  = l_wrist[2] * 0.75

    return out


# ===================================
# HALPE 26点 → 23点変換（RTMPose-X用）
# ===================================
def convert_halpe_to_23_keypoints(kpts: np.ndarray) -> np.ndarray:
    """
    RTMPose-X HALPE 26点出力 (または28点: +hand_tip) を23点形式に変換。

    HALPE 26-point layout:
      0:Nose, 1:LEye, 2:REye, 3:LEar, 4:REar,
      5:LShoulder, 6:RShoulder, 7:LElbow, 8:RElbow,
      9:LWrist, 10:RWrist, 11:LHip, 12:RHip,
      13:LKnee, 14:RKnee, 15:LAnkle, 16:RAnkle,
      17:Head(head_top), 18:Neck, 19:Hip(pelvis),
      20:RBigToe, 21:LBigToe, 22:RSmallToe, 23:LSmallToe,
      24:RHeel, 25:LHeel
    拡張 (with_hand=True 時):
      26:right_hand_tip, 27:left_hand_tip
    """
    n = len(kpts)
    out = np.zeros((23, 3), dtype=np.float32)

    # ---- 右上肢 ----
    out[1] = kpts[10]  # right_wrist
    out[2] = kpts[8]   # right_elbow
    out[3] = kpts[6]   # right_shoulder
    # 右手先
    if n > 26 and kpts[26, 2] > 0.2:
        out[0] = kpts[26]
    else:
        r_wrist, r_elbow = kpts[10], kpts[8]
        if r_wrist[2] > 0.3 and r_elbow[2] > 0.3:
            vec = r_wrist[:2] - r_elbow[:2]
            fore_len = np.linalg.norm(vec)
            if fore_len > 1.0:
                out[0, :2] = r_wrist[:2] + (vec / fore_len) * fore_len * 0.25
                out[0, 2]  = r_wrist[2] * 0.75

    # ---- 左上肢 ----
    out[5] = kpts[9]   # left_wrist
    out[6] = kpts[7]   # left_elbow
    out[7] = kpts[5]   # left_shoulder
    # 左手先
    if n > 27 and kpts[27, 2] > 0.2:
        out[4] = kpts[27]
    else:
        l_wrist, l_elbow = kpts[9], kpts[7]
        if l_wrist[2] > 0.3 and l_elbow[2] > 0.3:
            vec = l_wrist[:2] - l_elbow[:2]
            fore_len = np.linalg.norm(vec)
            if fore_len > 1.0:
                out[4, :2] = l_wrist[:2] + (vec / fore_len) * fore_len * 0.25
                out[4, 2]  = l_wrist[2] * 0.75

    # ---- 右下肢 ----
    # HALPE: 20=left_big_toe, 21=right_big_toe, 22=left_small_toe, 23=right_small_toe
    #        24=left_heel, 25=right_heel
    out[8]  = kpts[21]  # right_big_toe   (HALPE 21)
    out[9]  = kpts[23]  # right_small_toe (HALPE 23)
    out[10] = kpts[25]  # right_heel      (HALPE 25)
    out[11] = kpts[16]  # right_ankle
    out[12] = kpts[14]  # right_knee
    out[13] = kpts[12]  # right_hip

    # ---- 左下肢 ----
    out[14] = kpts[20]  # left_big_toe    (HALPE 20)
    out[15] = kpts[22]  # left_small_toe  (HALPE 22)
    out[16] = kpts[24]  # left_heel       (HALPE 24)
    out[17] = kpts[15]  # left_ankle
    out[18] = kpts[13]  # left_knee
    out[19] = kpts[11]  # left_hip

    # ---- 頭部 ----
    # 頭頂: HALPE 17 (head_top) を直接使用
    if kpts[17, 2] > 0.1:
        out[20] = kpts[17]
    else:
        # fallback: 目・鼻から Y軸のみ上方推定
        nose = kpts[0]
        l_eye, r_eye = kpts[1], kpts[2]
        if l_eye[2] > 0.2 and r_eye[2] > 0.2 and nose[2] > 0.2:
            mid_eye = (l_eye[:2] + r_eye[:2]) / 2.0
            eye_nose_dy = abs(nose[1] - mid_eye[1])
            if eye_nose_dy > 1.0:
                out[20, 0] = mid_eye[0]
                out[20, 1] = mid_eye[1] - eye_nose_dy * 3.5
                out[20, 2] = min(l_eye[2], r_eye[2], nose[2]) * 0.85

    # 耳珠点: HALPE 耳の中点
    l_ear, r_ear = kpts[3], kpts[4]
    if l_ear[2] > 0.3 and r_ear[2] > 0.3:
        out[21] = np.array([
            (l_ear[0] + r_ear[0]) / 2.0,
            (l_ear[1] + r_ear[1]) / 2.0,
            min(l_ear[2], r_ear[2])
        ], dtype=np.float32)

    # 胸骨上縁: SynthPose sternum [28] 優先、なければ HALPE neck [18]
    if len(kpts) > 28 and kpts[28, 2] > 0.1:
        out[22] = kpts[28]
    else:
        out[22] = kpts[18]

    return out



# ===================================
# キーポイント定義（HALPE 26点形式・RTMPose-X用）
# ===================================
KEYPOINT_NAMES_HALPE = [
    'Nose',        # 0
    'L_Eye',       # 1
    'R_Eye',       # 2
    'L_Ear',       # 3
    'R_Ear',       # 4
    'L_Shoulder',  # 5
    'R_Shoulder',  # 6
    'L_Elbow',     # 7
    'R_Elbow',     # 8
    'L_Wrist',     # 9
    'R_Wrist',     # 10
    'L_Hip',       # 11
    'R_Hip',       # 12
    'L_Knee',      # 13
    'R_Knee',      # 14
    'L_Ankle',     # 15
    'R_Ankle',     # 16
    'Head',        # 17 (head_top)
    'Neck',        # 18
    'Hip',         # 19 (pelvis)
    'L_BigToe',    # 20
    'R_BigToe',    # 21
    'L_SmallToe',  # 22
    'R_SmallToe',  # 23
    'L_Heel',      # 24
    'R_Heel',      # 25
]


# ===================================
# デバイス検出
# ===================================
_auto_detected_device = None

def detect_device(config_device: str = "auto") -> str:
    """利用可能なデバイスを検出"""
    global _auto_detected_device

    if config_device != "auto":
        return config_device

    if _auto_detected_device is not None:
        return _auto_detected_device

    import time
    start_time = time.time()

    # --- macOS: CoreML / MPS（Apple Neural Engine / GPU）チェック ---
    # rtmlib は 'mps' キーを CoreMLExecutionProvider にマップするため 'mps' を返す
    if sys.platform == 'darwin':
        try:
            import onnxruntime as ort
            providers = ort.get_available_providers()
            if "CoreMLExecutionProvider" in providers or "MPSExecutionProvider" in providers:
                _auto_detected_device = "mps"
                elapsed = time.time() - start_time
                print(f"[Profiling] GPU Detection (CoreML/MPS available) took: {elapsed:.4f} sec", file=sys.stderr)
                return "mps"
        except Exception:
            pass
        _auto_detected_device = "cpu"
        elapsed = time.time() - start_time
        print(f"[Profiling] GPU Detection (macOS, cpu fallback) took: {elapsed:.4f} sec", file=sys.stderr)
        return "cpu"

    # --- Windows: nvcuda.dll を先にチェック（onnxruntime インポートより前）---
    # GPU非搭載環境では onnxruntime-gpu のインポートだけで0.5〜2秒かかるため、
    # DLL確認を先行させて即座に "cpu" を返す高速パスを設ける。
    if sys.platform == 'win32':
        try:
            import ctypes
            ctypes.windll.LoadLibrary('nvcuda.dll')
        except Exception:
            # nvcuda.dll なし = NVIDIAドライバ未インストール → GPU不使用確定
            _auto_detected_device = "cpu"
            elapsed = time.time() - start_time
            print(f"[Profiling] GPU Detection (nvcuda.dll not found, fast-path cpu) took: {elapsed:.4f} sec", file=sys.stderr)
            return "cpu"

    # --- nvcuda.dll が存在する場合のみ onnxruntime で詳細確認 ---
    device = "cpu"
    try:
        import onnxruntime as ort
        providers = ort.get_available_providers()
        if "CUDAExecutionProvider" in providers:
            device = "cuda"
    except ImportError:
        pass
    except Exception:
        pass

    elapsed = time.time() - start_time
    print(f"[Profiling] GPU Detection (onnxruntime check) took: {elapsed:.4f} sec", file=sys.stderr)

    _auto_detected_device = device
    return device


def get_device_info() -> Dict[str, Any]:
    """デバイス情報を取得"""
    info = {
        "current_device": detect_device(),
        "cuda_available": False,
        "cuda_device_name": None,
        "onnx_providers": []
    }

    try:
        import onnxruntime as ort
        info["onnx_providers"] = ort.get_available_providers()
        info["cuda_available"] = "CUDAExecutionProvider" in info["onnx_providers"]
    except ImportError:
        pass

    return info
