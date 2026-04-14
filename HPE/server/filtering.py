#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
フィルタリング・補間モジュール
Pose2Sim のプロトコルを参考に実装
"""

import numpy as np
from scipy import signal
from scipy.ndimage import median_filter as scipy_median_filter
from scipy.interpolate import interp1d, CubicSpline, PchipInterpolator, Akima1DInterpolator
from scipy.stats import zscore
from typing import Dict, List, Optional, Tuple
import copy


# ===================================
# 1. 外れ値検出・除去
# ===================================

def detect_outliers_zscore(data: np.ndarray, threshold: float = 3.0) -> np.ndarray:
    """
    Z-score による外れ値検出
    
    Parameters:
    - data: shape (frames, num_keypoints, 3) - [x, y, confidence]
    - threshold: Z-score の閾値（デフォルト 3.0 = 3σ）
    
    Returns:
    - outlier_mask: shape (frames, num_keypoints) - True = 外れ値
    """
    num_frames, num_kpts, _ = data.shape
    outlier_mask = np.zeros((num_frames, num_kpts), dtype=bool)
    
    for kpt_idx in range(num_kpts):
        x_vals = data[:, kpt_idx, 0]
        y_vals = data[:, kpt_idx, 1]
        
        # 有効な値のみで Z-score を計算
        valid_mask = data[:, kpt_idx, 2] > 0.1
        
        if np.sum(valid_mask) < 3:
            continue
        
        # X, Y それぞれで Z-score を計算
        x_zscore = np.zeros(num_frames)
        y_zscore = np.zeros(num_frames)
        
        x_zscore[valid_mask] = np.abs(zscore(x_vals[valid_mask]))
        y_zscore[valid_mask] = np.abs(zscore(y_vals[valid_mask]))
        
        # どちらかが閾値を超えたら外れ値
        outlier_mask[:, kpt_idx] = (x_zscore > threshold) | (y_zscore > threshold)
    
    return outlier_mask


def detect_outliers_velocity(data: np.ndarray, fps: float = 30.0, max_velocity: float = 2000.0) -> np.ndarray:
    """
    速度ベースの外れ値検出（急激な移動を検出）

    Parameters:
    - data: shape (frames, num_keypoints, 3)
    - fps: フレームレート
    - max_velocity: 最大許容速度（ピクセル/秒）

    Returns:
    - outlier_mask: shape (frames, num_keypoints)
    """
    num_frames, num_kpts, _ = data.shape
    outlier_mask = np.zeros((num_frames, num_kpts), dtype=bool)

    for kpt_idx in range(num_kpts):
        x_vals = data[:, kpt_idx, 0]
        y_vals = data[:, kpt_idx, 1]

        # 速度計算（差分）
        dx = np.diff(x_vals)
        dy = np.diff(y_vals)
        velocity = np.sqrt(dx**2 + dy**2) * fps

        # 最大速度を超えたら外れ値
        outlier_frames = np.where(velocity > max_velocity)[0] + 1
        outlier_mask[outlier_frames, kpt_idx] = True

    return outlier_mask


def detect_outliers_acceleration(data: np.ndarray, fps: float = 30.0,
                                  max_acceleration: float = 50000.0) -> np.ndarray:
    """
    加速度ベースの外れ値検出（瞬間的なジャンプを検出）

    速度の急激な変化を検出し、物理的にありえない動きを除外

    Parameters:
    - data: shape (frames, num_keypoints, 3)
    - fps: フレームレート
    - max_acceleration: 最大許容加速度（ピクセル/秒^2）
      - 人間の最大減速度: 約10 m/s^2
      - 1080pスケールで約15000-20000 px/s^2
      - 安全マージンで50000 px/s^2

    Returns:
    - outlier_mask: shape (frames, num_keypoints)
    """
    num_frames, num_kpts, _ = data.shape
    outlier_mask = np.zeros((num_frames, num_kpts), dtype=bool)

    if num_frames < 3:
        return outlier_mask

    for kpt_idx in range(num_kpts):
        x_vals = data[:, kpt_idx, 0]
        y_vals = data[:, kpt_idx, 1]

        # 速度計算（ピクセル/秒）
        vx = np.diff(x_vals) * fps
        vy = np.diff(y_vals) * fps

        # 加速度計算（ピクセル/秒^2）
        ax = np.diff(vx) * fps
        ay = np.diff(vy) * fps
        acceleration = np.sqrt(ax**2 + ay**2)

        # 加速度が閾値を超えたフレームをマーク
        # 加速度はフレームi+1での変化なので、影響を受けるのはi+1とi+2
        outlier_indices = np.where(acceleration > max_acceleration)[0]
        for idx in outlier_indices:
            # 加速度異常の前後のフレームをマーク
            if idx + 1 < num_frames:
                outlier_mask[idx + 1, kpt_idx] = True
            if idx + 2 < num_frames:
                outlier_mask[idx + 2, kpt_idx] = True

    return outlier_mask


def remove_outliers(data: np.ndarray,
                    confidence_threshold: float = 0.3,
                    zscore_threshold: float = 3.5,
                    fps: float = 30.0,
                    max_velocity: float = 3000.0,
                    enable_acceleration_check: bool = False,
                    max_acceleration: float = 50000.0) -> np.ndarray:
    """
    外れ値を除去（信頼度を 0 に設定）

    Parameters:
    - data: shape (frames, num_keypoints, 3)
    - confidence_threshold: この値以下を低信頼度として扱う
    - zscore_threshold: Z-score の閾値（デフォルト3.5に厳格化）
    - fps: フレームレート
    - max_velocity: 最大許容速度（ピクセル/秒、デフォルト3000に厳格化）
    - enable_acceleration_check: 加速度チェックを有効化
    - max_acceleration: 最大許容加速度（ピクセル/秒^2）

    Returns:
    - 外れ値除去後の data
    """
    result = data.copy()

    # 低信頼度を外れ値として扱う
    low_conf_mask = result[:, :, 2] < confidence_threshold

    # Z-score による外れ値検出
    zscore_mask = detect_outliers_zscore(result, zscore_threshold)

    # 速度ベースの外れ値検出
    velocity_mask = detect_outliers_velocity(result, fps, max_velocity)

    # 加速度ベースの外れ値検出
    acceleration_mask = np.zeros_like(low_conf_mask)
    if enable_acceleration_check:
        acceleration_mask = detect_outliers_acceleration(result, fps, max_acceleration)

    # 外れ値の信頼度を 0 に設定
    combined_mask = low_conf_mask | zscore_mask | velocity_mask | acceleration_mask
    result[combined_mask, 2] = 0.0

    # 除去された外れ値の統計をログ出力
    total_outliers = np.sum(combined_mask)
    if total_outliers > 0:
        print(f"[Filtering] Outliers removed: zscore={np.sum(zscore_mask)}, "
              f"velocity={np.sum(velocity_mask)}, acceleration={np.sum(acceleration_mask)}")

    return result


# ===================================
# 1.5. IDスワップ検出・修正
# ===================================

def calculate_centroid(keypoints: np.ndarray, confidence_threshold: float = 0.3) -> Tuple[float, float]:
    """
    キーポイントの重心を計算
    
    Parameters:
    - keypoints: shape (num_keypoints, 3) - [x, y, confidence]
    - confidence_threshold: 信頼度閾値
    
    Returns:
    - (centroid_x, centroid_y)
    """
    valid_mask = keypoints[:, 2] > confidence_threshold
    if np.sum(valid_mask) == 0:
        return (np.nan, np.nan)
    
    x_vals = keypoints[valid_mask, 0]
    y_vals = keypoints[valid_mask, 1]
    
    return (np.mean(x_vals), np.mean(y_vals))



# ID Swap functions removed as per user request (manual handling preferred)



# ===================================
# 1.6. 左右脚・腕スワップ検出・修正
# ===================================

# キーポイントインデックス定義（23点形式）
RIGHT_ARM_INDICES = [0, 1, 2, 3]    # right_hand_tip, right_wrist, right_elbow, right_shoulder
LEFT_ARM_INDICES = [4, 5, 6, 7]      # left_hand_tip, left_wrist, left_elbow, left_shoulder
RIGHT_LEG_INDICES = [8, 9, 10, 11, 12, 13]   # right_toe_tip, right_small_toe, right_heel, right_ankle, right_knee, right_hip
LEFT_LEG_INDICES = [14, 15, 16, 17, 18, 19]  # left_toe_tip, left_small_toe, left_heel, left_ankle, left_knee, left_hip

# 関節インデックス（個別）
RIGHT_HIP = 13
RIGHT_KNEE = 12
RIGHT_ANKLE = 11
LEFT_HIP = 19
LEFT_KNEE = 18
LEFT_ANKLE = 17

# 腕の個別インデックス
RIGHT_WRIST = 1
LEFT_WRIST = 5

# ===================================
# キーポイントインデックス定義（SynthPose 52点形式）
# 右(R_*)/左(L_*) の順序を対応させて定義
# ===================================
SP_RIGHT_ARM_INDICES = [6, 8, 10, 18, 20, 22, 24, 26]   # R_Shoulder,R_Elbow,R_Wrist,rshoulder,r_lelbow,r_melbow,r_lwrist,r_mwrist
SP_LEFT_ARM_INDICES  = [5, 7,  9, 19, 21, 23, 25, 27]   # L_Shoulder,L_Elbow,L_Wrist,lshoulder,l_lelbow,l_melbow,l_lwrist,l_mwrist
SP_RIGHT_LEG_INDICES = [12, 14, 16, 28, 30, 32, 34, 36, 38, 40, 42, 44, 47]  # R_Hip,R_Knee,R_Ankle,r_ASIS,r_PSIS,r_knee,r_mknee,r_ankle,r_mankle,r_5meta,r_toe,r_big_toe,r_calc
SP_LEFT_LEG_INDICES  = [11, 13, 15, 29, 31, 33, 35, 37, 39, 41, 43, 45, 46]  # L_Hip,L_Knee,L_Ankle,l_ASIS,l_PSIS,l_knee,l_mknee,l_ankle,l_mankle,l_5meta,l_toe,l_big_toe,l_calc

SP_RIGHT_HIP   = 12   # R_Hip
SP_RIGHT_KNEE  = 14   # R_Knee
SP_RIGHT_ANKLE = 16   # R_Ankle
SP_LEFT_HIP    = 11   # L_Hip
SP_LEFT_KNEE   = 13   # L_Knee
SP_LEFT_ANKLE  = 15   # L_Ankle
SP_RIGHT_WRIST = 10   # R_Wrist
SP_LEFT_WRIST  = 9    # L_Wrist


def _get_limb_indices(num_keypoints: int, limb_type: str) -> Tuple[List[int], List[int]]:
    """キーポイント数に応じた肢体インデックスペアを返す"""
    if num_keypoints >= 52:
        return (SP_RIGHT_LEG_INDICES, SP_LEFT_LEG_INDICES) if limb_type == 'legs' \
               else (SP_RIGHT_ARM_INDICES, SP_LEFT_ARM_INDICES)
    return (RIGHT_LEG_INDICES, LEFT_LEG_INDICES) if limb_type == 'legs' \
           else (RIGHT_ARM_INDICES, LEFT_ARM_INDICES)


def _get_joint_idx(num_keypoints: int) -> dict:
    """キーポイント数に応じた個別関節インデックスを返す"""
    if num_keypoints >= 52:
        return {
            'right_hip': SP_RIGHT_HIP, 'left_hip': SP_LEFT_HIP,
            'right_knee': SP_RIGHT_KNEE, 'left_knee': SP_LEFT_KNEE,
            'right_ankle': SP_RIGHT_ANKLE, 'left_ankle': SP_LEFT_ANKLE,
            'right_wrist': SP_RIGHT_WRIST, 'left_wrist': SP_LEFT_WRIST,
        }
    return {
        'right_hip': RIGHT_HIP, 'left_hip': LEFT_HIP,
        'right_knee': RIGHT_KNEE, 'left_knee': LEFT_KNEE,
        'right_ankle': RIGHT_ANKLE, 'left_ankle': LEFT_ANKLE,
        'right_wrist': RIGHT_WRIST, 'left_wrist': LEFT_WRIST,
    }


def calculate_adaptive_velocity_threshold(fps: float,
                                          base_velocity_per_second: float = 1500.0) -> float:
    """
    FPSに応じた適応型速度閾値を計算

    Parameters:
    - fps: フレームレート
    - base_velocity_per_second: 基準速度 (ピクセル/秒)
      - 人間の脚の最大移動速度を想定
      - ランニング時の膝の移動速度: 約10-15 m/s
      - 1080pで全身が映る場合、脚の長さ約300-400px
      - 1秒でフレーム横断する速度として1500px/秒を基準

    Returns:
    - velocity_threshold: ピクセル/フレーム単位の閾値

    計算例:
    - 30fps: 1500 / 30 = 50.0 px/frame
    - 60fps: 1500 / 60 = 25.0 px/frame
    - 120fps: 1500 / 120 = 12.5 px/frame
    - 240fps: 1500 / 240 = 6.25 px/frame
    """
    return base_velocity_per_second / fps


def detect_leg_crossing_phase(person_data: np.ndarray,
                               frame_idx: int,
                               confidence_threshold: float = 0.3) -> Dict:
    """
    脚の交差フェーズを検出

    ランニング時に左右脚が体の中心で交差する瞬間を検出し、
    この時のスワップ検出を抑制するために使用

    Parameters:
    - person_data: shape (frames, num_keypoints, 3)
    - frame_idx: 検出対象のフレームインデックス
    - confidence_threshold: 信頼度閾値

    Returns:
    - dict: {
        'is_crossing': bool,          # 交差フェーズか
        'crossing_confidence': float, # 交差の確信度 (0-1)
        'right_leg_forward': bool,    # 右脚が前か
        'hip_horizontal_dist': float  # 股関節間の水平距離
      }
    """
    kpts = person_data[frame_idx]
    ji = _get_joint_idx(kpts.shape[0])
    RH, LH = ji['right_hip'], ji['left_hip']
    RK, LK = ji['right_knee'], ji['left_knee']

    # 各関節の有効性チェック
    right_hip_valid = kpts[RH, 2] > confidence_threshold
    left_hip_valid = kpts[LH, 2] > confidence_threshold
    right_knee_valid = kpts[RK, 2] > confidence_threshold
    left_knee_valid = kpts[LK, 2] > confidence_threshold

    # 股関節が両方検出されていない場合は判定不能
    if not (right_hip_valid and left_hip_valid):
        return {
            'is_crossing': False,
            'crossing_confidence': 0.0,
            'right_leg_forward': False,
            'hip_horizontal_dist': float('inf')
        }

    # 股関節の水平距離（X座標の差）
    hip_horizontal_dist = abs(kpts[RH, 0] - kpts[LH, 0])

    # 膝の水平距離
    knee_horizontal_dist = float('inf')
    if right_knee_valid and left_knee_valid:
        knee_horizontal_dist = abs(kpts[RK, 0] - kpts[LK, 0])

    # 通常時の股関節間距離を推定
    hip_vertical_diff = abs(kpts[RH, 1] - kpts[LH, 1])

    # 動的な基準距離: 膝の位置から脚の長さを推定
    leg_length_estimate = 200.0  # デフォルト
    if right_knee_valid and right_hip_valid:
        leg_length_estimate = max(leg_length_estimate,
                                   abs(kpts[RH, 1] - kpts[RK, 1]) * 2)
    if left_knee_valid and left_hip_valid:
        leg_length_estimate = max(leg_length_estimate,
                                   abs(kpts[LH, 1] - kpts[LK, 1]) * 2)

    # 通常の骨盤幅は脚の長さの約20-30%
    typical_hip_distance = leg_length_estimate * 0.25

    # 交差確信度の計算
    if typical_hip_distance > 0:
        crossing_ratio = 1.0 - min(hip_horizontal_dist / typical_hip_distance, 1.0)
    else:
        crossing_ratio = 0.0

    if knee_horizontal_dist < hip_horizontal_dist * 0.7:
        crossing_ratio = min(crossing_ratio + 0.2, 1.0)

    if hip_vertical_diff > typical_hip_distance * 0.3:
        crossing_ratio = min(crossing_ratio + 0.15, 1.0)

    is_crossing = crossing_ratio > 0.5

    return {
        'is_crossing': is_crossing,
        'crossing_confidence': crossing_ratio,
        'right_leg_forward': kpts[RH, 0] > kpts[LH, 0],
        'hip_horizontal_dist': hip_horizontal_dist
    }


def calculate_swap_score(person_data: np.ndarray,
                         frame_idx: int,
                         limb_type: str = 'legs',
                         confidence_threshold: float = 0.3) -> float:
    """
    スワップスコアを計算

    正の値が大きいほどスワップの可能性が高い

    Parameters:
    - person_data: shape (frames, num_keypoints, 3)
    - frame_idx: 現在フレーム（次フレームとの比較）
    - limb_type: 'legs' または 'arms'
    - confidence_threshold: 信頼度閾値

    Returns:
    - score: (total_same - total_swap) 正ならスワップの可能性
    """
    right_indices, left_indices = _get_limb_indices(person_data.shape[1], limb_type)
    if not right_indices:
        return 0.0

    if frame_idx + 1 >= len(person_data):
        return 0.0

    right_curr = calculate_limb_centroid(person_data[frame_idx], right_indices, confidence_threshold)
    left_curr = calculate_limb_centroid(person_data[frame_idx], left_indices, confidence_threshold)
    right_next = calculate_limb_centroid(person_data[frame_idx + 1], right_indices, confidence_threshold)
    left_next = calculate_limb_centroid(person_data[frame_idx + 1], left_indices, confidence_threshold)

    if any(np.isnan(v) for v in [*right_curr, *left_curr, *right_next, *left_next]):
        return 0.0

    # 距離計算
    dist_same_right = np.sqrt((right_curr[0] - right_next[0])**2 + (right_curr[1] - right_next[1])**2)
    dist_same_left = np.sqrt((left_curr[0] - left_next[0])**2 + (left_curr[1] - left_next[1])**2)
    dist_swap_right = np.sqrt((right_curr[0] - left_next[0])**2 + (right_curr[1] - left_next[1])**2)
    dist_swap_left = np.sqrt((left_curr[0] - right_next[0])**2 + (left_curr[1] - right_next[1])**2)

    total_same = dist_same_right + dist_same_left
    total_swap = dist_swap_right + dist_swap_left

    return total_same - total_swap


def detect_limb_swaps_with_temporal_window(person_data: np.ndarray,
                                            limb_type: str = 'legs',
                                            fps: float = 30.0,
                                            window_size: int = 5,
                                            min_consecutive_frames: int = 3,
                                            base_velocity_per_second: float = 1500.0,
                                            enable_crossing_detection: bool = True,
                                            crossing_suppression_threshold: float = 0.6,
                                            confidence_threshold: float = 0.3) -> List[int]:
    """
    時間窓を使用した左右脚スワップ検出

    単一フレームではなく、前後フレームを含む時間窓で判定することで安定性を向上

    Parameters:
    - person_data: shape (frames, num_keypoints, 3)
    - limb_type: 'legs' または 'arms'
    - fps: フレームレート
    - window_size: 時間窓のサイズ（フレーム数、奇数推奨）
    - min_consecutive_frames: スワップと判定する最小連続フレーム数
    - base_velocity_per_second: 基準速度（ピクセル/秒）
    - enable_crossing_detection: 交差フェーズ検出を有効化
    - crossing_suppression_threshold: 交差検出の抑制閾値
    - confidence_threshold: 信頼度閾値

    Returns:
    - swap_frames: スワップが発生したフレームのリスト
    """
    num_frames = len(person_data)
    if num_frames < 2:
        return []

    # FPS適応型閾値を計算
    velocity_threshold = calculate_adaptive_velocity_threshold(fps, base_velocity_per_second)

    # Step 1: 各フレームのスワップスコアと交差フラグを計算
    swap_scores = np.zeros(num_frames)
    crossing_flags = np.zeros(num_frames, dtype=bool)

    for i in range(num_frames - 1):
        # 交差フェーズ検出
        if enable_crossing_detection and limb_type == 'legs':
            crossing_info = detect_leg_crossing_phase(person_data, i, confidence_threshold)
            if crossing_info['is_crossing'] and \
               crossing_info['crossing_confidence'] > crossing_suppression_threshold:
                crossing_flags[i] = True
                crossing_flags[min(i + 1, num_frames - 1)] = True
                continue

        # スワップスコア計算
        score = calculate_swap_score(person_data, i, limb_type, confidence_threshold)
        swap_scores[i + 1] = score

    # Step 2: 時間窓での平滑化
    half_window = window_size // 2
    smoothed_scores = np.zeros(num_frames)

    for i in range(num_frames):
        start = max(0, i - half_window)
        end = min(num_frames, i + half_window + 1)

        # 交差フェーズのフレームは除外して平均
        window_scores = swap_scores[start:end]
        window_crossing = crossing_flags[start:end]

        valid_mask = ~window_crossing
        if np.any(valid_mask):
            smoothed_scores[i] = np.mean(window_scores[valid_mask])
        else:
            smoothed_scores[i] = 0.0

    # Step 3: 閾値超過の連続区間を検出
    above_threshold = smoothed_scores > velocity_threshold

    swap_frames = []
    consecutive_count = 0
    start_frame = None

    for i in range(num_frames):
        if above_threshold[i] and not crossing_flags[i]:
            if start_frame is None:
                start_frame = i
            consecutive_count += 1
        else:
            if consecutive_count >= min_consecutive_frames:
                # 連続区間の開始フレームをスワップフレームとする
                swap_frames.append(start_frame)
                print(f"[Limb Swap] Detected {limb_type} swap at frame {start_frame} "
                      f"(consecutive: {consecutive_count}, score: {smoothed_scores[start_frame]:.1f}, "
                      f"threshold: {velocity_threshold:.1f})")
            consecutive_count = 0
            start_frame = None

    # 最後の区間もチェック
    if consecutive_count >= min_consecutive_frames and start_frame is not None:
        swap_frames.append(start_frame)
        print(f"[Limb Swap] Detected {limb_type} swap at frame {start_frame} "
              f"(consecutive: {consecutive_count}, score: {smoothed_scores[start_frame]:.1f})")

    return swap_frames


# ===================================
# 2.2. 軌跡予測ベースのスワップ検出
# ===================================

def predict_limb_position(positions: np.ndarray,
                          prediction_frames: int = 3) -> Tuple[float, float]:
    """
    過去の位置から次の位置を線形予測

    Parameters:
    - positions: shape (N, 2) - 過去N フレームの位置 [(x, y), ...]
    - prediction_frames: 予測に使用するフレーム数

    Returns:
    - (predicted_x, predicted_y)
    """
    valid_positions = positions[~np.isnan(positions).any(axis=1)]

    if len(valid_positions) < 2:
        if len(valid_positions) == 1:
            return tuple(valid_positions[0])
        return (np.nan, np.nan)

    # 最新の数フレームを使用
    use_positions = valid_positions[-prediction_frames:]

    if len(use_positions) < 2:
        return tuple(use_positions[-1])

    # 線形回帰で予測
    t = np.arange(len(use_positions))

    # X座標の予測
    coeffs_x = np.polyfit(t, use_positions[:, 0], 1)
    pred_x = np.polyval(coeffs_x, len(use_positions))

    # Y座標の予測
    coeffs_y = np.polyfit(t, use_positions[:, 1], 1)
    pred_y = np.polyval(coeffs_y, len(use_positions))

    return (pred_x, pred_y)


def detect_limb_swaps_trajectory_prediction(person_data: np.ndarray,
                                             limb_type: str = 'legs',
                                             fps: float = 30.0,
                                             prediction_frames: int = 5,
                                             prediction_threshold_ratio: float = 2.0,
                                             min_history_frames: int = 3,
                                             confidence_threshold: float = 0.3) -> List[int]:
    """
    軌跡予測ベースの左右脚スワップ検出

    過去の軌跡から「次にどこにいるべきか」を予測し、
    予測との乖離が「同側より反対側の方が小さい」場合にスワップと判定

    Parameters:
    - person_data: shape (frames, num_keypoints, 3)
    - limb_type: 'legs' または 'arms'
    - fps: フレームレート
    - prediction_frames: 予測に使用する過去フレーム数
    - prediction_threshold_ratio: 予測誤差の比率閾値（swap_error < same_error / ratio）
    - min_history_frames: 予測開始に必要な最小履歴フレーム数
    - confidence_threshold: 信頼度閾値

    Returns:
    - swap_frames: スワップが発生したフレームのリスト
    """
    right_indices, left_indices = _get_limb_indices(person_data.shape[1], limb_type)
    if not right_indices:
        return []

    num_frames = len(person_data)
    if num_frames < min_history_frames + 1:
        return []

    # 各フレームの重心を事前計算
    right_centroids = np.full((num_frames, 2), np.nan)
    left_centroids = np.full((num_frames, 2), np.nan)

    for i in range(num_frames):
        rc = calculate_limb_centroid(person_data[i], right_indices, confidence_threshold)
        lc = calculate_limb_centroid(person_data[i], left_indices, confidence_threshold)
        right_centroids[i] = rc
        left_centroids[i] = lc

    swap_frames = []
    swap_state = False  # 現在スワップ状態かどうか

    for i in range(min_history_frames, num_frames):
        # 現在の観測値
        right_obs = right_centroids[i]
        left_obs = left_centroids[i]

        if np.isnan(right_obs).any() or np.isnan(left_obs).any():
            continue

        # 過去の軌跡から予測（スワップ状態を考慮）
        history_start = max(0, i - prediction_frames)

        if swap_state:
            # スワップ状態なら、ラベルを入れ替えて履歴を参照
            right_history = left_centroids[history_start:i]
            left_history = right_centroids[history_start:i]
        else:
            right_history = right_centroids[history_start:i]
            left_history = left_centroids[history_start:i]

        # 有効なフレーム数をチェック
        valid_right = ~np.isnan(right_history).any(axis=1)
        valid_left = ~np.isnan(left_history).any(axis=1)

        if np.sum(valid_right) < 2 or np.sum(valid_left) < 2:
            continue

        # 予測位置を計算
        pred_right = predict_limb_position(right_history, prediction_frames)
        pred_left = predict_limb_position(left_history, prediction_frames)

        if np.isnan(pred_right).any() or np.isnan(pred_left).any():
            continue

        # 予測との誤差を計算
        # ケース1: そのまま（スワップなし）
        error_same_right = np.sqrt((right_obs[0] - pred_right[0])**2 +
                                    (right_obs[1] - pred_right[1])**2)
        error_same_left = np.sqrt((left_obs[0] - pred_left[0])**2 +
                                   (left_obs[1] - pred_left[1])**2)
        error_same = error_same_right + error_same_left

        # ケース2: スワップ（左右入れ替え）
        error_swap_right = np.sqrt((left_obs[0] - pred_right[0])**2 +
                                    (left_obs[1] - pred_right[1])**2)
        error_swap_left = np.sqrt((right_obs[0] - pred_left[0])**2 +
                                   (right_obs[1] - pred_left[1])**2)
        error_swap = error_swap_right + error_swap_left

        # スワップの方が誤差が小さく、差が有意な場合
        if error_swap < error_same / prediction_threshold_ratio:
            if not swap_state:
                # スワップ開始
                swap_frames.append(i)
                swap_state = True
                print(f"[Trajectory Swap] Detected {limb_type} swap START at frame {i}: "
                      f"same_error={error_same:.1f}, swap_error={error_swap:.1f}, "
                      f"ratio={error_same/max(error_swap, 0.001):.2f}")
        elif error_same < error_swap / prediction_threshold_ratio:
            if swap_state:
                # スワップ終了（元に戻る）
                swap_frames.append(i)
                swap_state = False
                print(f"[Trajectory Swap] Detected {limb_type} swap END at frame {i}: "
                      f"same_error={error_same:.1f}, swap_error={error_swap:.1f}")

    return swap_frames


def detect_limb_swaps_global_optimization(person_data: np.ndarray,
                                           limb_type: str = 'legs',
                                           fps: float = 30.0,
                                           smoothness_weight: float = 1.0,
                                           confidence_threshold: float = 0.3,
                                           use_single_keypoint: bool = True,
                                           transition_penalty: float = 25.0) -> List[int]:
    """
    全体最適化による左右脚スワップ検出

    動画全体で軌跡の滑らかさを最大化するラベル割り当てを見つける。
    動的計画法で最適解を求める。

    Parameters:
    - person_data: shape (frames, num_keypoints, 3)
    - limb_type: 'legs' または 'arms'
    - fps: フレームレート
    - smoothness_weight: 滑らかさの重み
    - confidence_threshold: 信頼度閾値
    - use_single_keypoint: True なら単一キーポイント（足首/手首）で検出
    - transition_penalty: 状態遷移ペナルティ（デフォルト25、低いほど敏感）

    Returns:
    - swap_frames: スワップが発生したフレームのリスト
    """
    num_frames = len(person_data)
    if num_frames < 2:
        return []

    # 検出に使用するインデックスを決定
    num_kpts = person_data.shape[1]
    ji = _get_joint_idx(num_kpts)
    right_indices_multi, left_indices_multi = _get_limb_indices(num_kpts, limb_type)

    if limb_type == 'legs':
        if use_single_keypoint:
            right_idx = ji['right_ankle']
            left_idx = ji['left_ankle']
            print(f"[Global Opt] Using ankle positions for {limb_type} detection")
        else:
            right_indices = right_indices_multi
            left_indices = left_indices_multi
    elif limb_type == 'arms':
        if use_single_keypoint:
            right_idx = ji['right_wrist']
            left_idx = ji['left_wrist']
            print(f"[Global Opt] Using wrist positions for {limb_type} detection")
        else:
            right_indices = right_indices_multi
            left_indices = left_indices_multi
    else:
        return []

    # 各フレームの位置を事前計算
    right_positions = np.full((num_frames, 2), np.nan)
    left_positions = np.full((num_frames, 2), np.nan)

    for i in range(num_frames):
        if use_single_keypoint:
            # 単一キーポイントの位置を取得
            kpts = person_data[i]
            if kpts[right_idx, 2] > confidence_threshold:
                right_positions[i] = kpts[right_idx, :2]
            if kpts[left_idx, 2] > confidence_threshold:
                left_positions[i] = kpts[left_idx, :2]
        else:
            # 重心を計算
            right_positions[i] = calculate_limb_centroid(person_data[i], right_indices, confidence_threshold)
            left_positions[i] = calculate_limb_centroid(person_data[i], left_indices, confidence_threshold)

    # 動的計画法: dp[i][s] = フレームiまでで状態s（0:通常, 1:スワップ）の最小コスト
    INF = float('inf')
    dp = np.full((num_frames, 2), INF)
    parent = np.full((num_frames, 2), -1, dtype=int)

    # 初期化
    dp[0, 0] = 0  # 最初のフレームは通常状態からスタート
    dp[0, 1] = INF  # 最初のフレームでいきなりスワップは不自然

    for i in range(1, num_frames):
        curr_right = right_positions[i]
        curr_left = left_positions[i]
        prev_right = right_positions[i - 1]
        prev_left = left_positions[i - 1]

        # 欠損データはスキップ
        if np.isnan(curr_right).any() or np.isnan(curr_left).any():
            dp[i] = dp[i - 1]
            parent[i] = [0, 1]  # 同じ状態を維持
            continue

        if np.isnan(prev_right).any() or np.isnan(prev_left).any():
            dp[i] = dp[i - 1]
            parent[i] = [0, 1]
            continue

        # 状態遷移コストを計算
        for curr_state in [0, 1]:  # 0: 通常, 1: スワップ
            for prev_state in [0, 1]:
                if dp[i - 1, prev_state] == INF:
                    continue

                # 前フレームの「見かけ上の」位置
                if prev_state == 0:
                    prev_r, prev_l = prev_right, prev_left
                else:
                    prev_r, prev_l = prev_left, prev_right

                # 現フレームの「見かけ上の」位置
                if curr_state == 0:
                    curr_r, curr_l = curr_right, curr_left
                else:
                    curr_r, curr_l = curr_left, curr_right

                # 移動コスト（滑らかさ）
                move_cost = (np.sqrt((curr_r[0] - prev_r[0])**2 + (curr_r[1] - prev_r[1])**2) +
                            np.sqrt((curr_l[0] - prev_l[0])**2 + (curr_l[1] - prev_l[1])**2))

                # 状態遷移ペナルティ（パラメータから取得）
                penalty = 0 if prev_state == curr_state else transition_penalty

                total_cost = dp[i - 1, prev_state] + move_cost * smoothness_weight + penalty

                if total_cost < dp[i, curr_state]:
                    dp[i, curr_state] = total_cost
                    parent[i, curr_state] = prev_state

    # バックトラック: 最適経路を復元
    final_state = 0 if dp[-1, 0] <= dp[-1, 1] else 1
    states = [final_state]

    for i in range(num_frames - 1, 0, -1):
        prev_state = parent[i, states[-1]]
        if prev_state == -1:
            prev_state = states[-1]  # 欠損時は状態維持
        states.append(prev_state)

    states = states[::-1]

    # スワップフレームを検出（状態が切り替わるフレーム）
    swap_frames = []
    for i in range(1, num_frames):
        if states[i] != states[i - 1]:
            swap_frames.append(i)
            print(f"[Global Opt] Detected {limb_type} swap at frame {i}: "
                  f"state {states[i-1]} -> {states[i]}")

    # デバッグ情報
    total_swapped_frames = sum(states)
    print(f"[Global Opt] {limb_type}: {len(swap_frames)} transitions, "
          f"{total_swapped_frames}/{num_frames} frames in swapped state")

    return swap_frames


def calculate_limb_centroid(keypoints: np.ndarray, indices: List[int],
                            confidence_threshold: float = 0.3) -> Tuple[float, float]:
    """
    指定したキーポイントインデックスの重心を計算
    
    Parameters:
    - keypoints: shape (num_keypoints, 3) - [x, y, confidence]
    - indices: 対象キーポイントのインデックスリスト
    - confidence_threshold: 信頼度閾値
    
    Returns:
    - (centroid_x, centroid_y) または (nan, nan)
    """
    valid_points = []
    for idx in indices:
        if idx < len(keypoints) and keypoints[idx, 2] > confidence_threshold:
            valid_points.append(keypoints[idx, :2])
    
    if len(valid_points) == 0:
        return (np.nan, np.nan)
    
    valid_points = np.array(valid_points)
    return (np.mean(valid_points[:, 0]), np.mean(valid_points[:, 1]))


def detect_limb_swaps(person_data: np.ndarray,
                      limb_type: str = 'legs',
                      velocity_threshold: float = 150.0,
                      fps: float = 30.0,
                      base_velocity_per_second: float = 1500.0,
                      use_adaptive_threshold: bool = True) -> List[int]:
    """
    左右の脚または腕のスワップを検出（レガシー互換 + FPS適応対応）

    Parameters:
    - person_data: shape (frames, num_keypoints, 3) - 1人分のデータ
    - limb_type: 'legs' または 'arms'
    - velocity_threshold: スワップ検出の速度閾値（ピクセル/フレーム）- レガシー用
    - fps: フレームレート（FPS適応閾値用）
    - base_velocity_per_second: 基準速度（ピクセル/秒）
    - use_adaptive_threshold: TrueならFPS適応閾値を使用

    Returns:
    - スワップが発生したフレームのリスト
    """
    right_indices, left_indices = _get_limb_indices(person_data.shape[1], limb_type)
    if not right_indices:
        raise ValueError(f"Unknown limb_type: {limb_type}")

    # FPS適応型閾値を使用
    if use_adaptive_threshold:
        velocity_threshold = calculate_adaptive_velocity_threshold(fps, base_velocity_per_second)
        print(f"[Limb Swap] Using adaptive threshold: {velocity_threshold:.2f} px/frame "
              f"(base={base_velocity_per_second} px/s, fps={fps})")

    num_frames = len(person_data)
    swap_frames = []

    for i in range(num_frames - 1):
        # 現在フレームと次フレームの左右肢の重心を計算
        right_curr = calculate_limb_centroid(person_data[i], right_indices)
        left_curr = calculate_limb_centroid(person_data[i], left_indices)
        right_next = calculate_limb_centroid(person_data[i + 1], right_indices)
        left_next = calculate_limb_centroid(person_data[i + 1], left_indices)

        # 無効な場合はスキップ
        if any(np.isnan(v) for v in [*right_curr, *left_curr, *right_next, *left_next]):
            continue

        # 距離計算
        # 同一継続の場合
        dist_same_right = np.sqrt((right_curr[0] - right_next[0])**2 + (right_curr[1] - right_next[1])**2)
        dist_same_left = np.sqrt((left_curr[0] - left_next[0])**2 + (left_curr[1] - left_next[1])**2)

        # 入れ替わりの場合
        dist_swap_right = np.sqrt((right_curr[0] - left_next[0])**2 + (right_curr[1] - left_next[1])**2)
        dist_swap_left = np.sqrt((left_curr[0] - right_next[0])**2 + (left_curr[1] - right_next[1])**2)

        total_same = dist_same_right + dist_same_left
        total_swap = dist_swap_right + dist_swap_left

        # 入れ替わった方が距離が短く、差が閾値を超える場合
        if total_swap < total_same and (total_same - total_swap) > velocity_threshold:
            swap_frames.append(i + 1)
            print(f"[Limb Swap] Detected {limb_type} swap at frame {i + 1}: "
                  f"same={total_same:.1f}, swap={total_swap:.1f}, threshold={velocity_threshold:.1f}")

    return swap_frames


def swap_limbs_from_frame(person_data: np.ndarray, 
                          start_frame: int,
                          limb_type: str = 'legs',
                          end_frame: Optional[int] = None) -> np.ndarray:
    """
    指定フレームから左右の脚または腕を入れ替える
    
    Parameters:
    - person_data: shape (frames, num_keypoints, 3) - 1人分のデータ
    - start_frame: 入れ替え開始フレーム（0-indexed）
    - limb_type: 'legs' または 'arms'
    - end_frame: 入れ替え終了フレーム（Noneの場合は最後まで）
    
    Returns:
    - 修正後のデータ
    """
    right_indices, left_indices = _get_limb_indices(person_data.shape[1], limb_type)
    if not right_indices:
        raise ValueError(f"Unknown limb_type: {limb_type}")

    result = person_data.copy()
    num_frames = len(result)
    
    if end_frame is None:
        end_frame = num_frames
    
    end_frame = min(end_frame, num_frames)
    
    for i in range(start_frame, end_frame):
        # 左右のキーポイントを入れ替え
        for right_idx, left_idx in zip(right_indices, left_indices):
            result[i, right_idx], result[i, left_idx] = \
                result[i, left_idx].copy(), result[i, right_idx].copy()
    
    print(f"[Limb Swap] Swapped {limb_type} from frame {start_frame} to {end_frame}")
    return result


def auto_fix_limb_swaps(person_data: np.ndarray,
                        fix_legs: bool = True,
                        fix_arms: bool = True,
                        fps: float = 30.0,
                        base_swap_velocity: float = 1500.0,
                        swap_window_size: int = 5,
                        swap_min_consecutive: int = 3,
                        enable_crossing_detection: bool = True,
                        crossing_suppression_threshold: float = 0.6,
                        use_temporal_window: bool = True,
                        velocity_threshold: float = 150.0,
                        detection_method: str = 'global_optimization') -> np.ndarray:
    """
    左右脚・腕のスワップを自動検出して修正（改善版）

    Parameters:
    - person_data: shape (frames, num_keypoints, 3) - 1人分のデータ
    - fix_legs: 脚のスワップを修正するかどうか
    - fix_arms: 腕のスワップを修正するかどうか
    - fps: フレームレート（FPS適応閾値用）
    - base_swap_velocity: 基準速度（ピクセル/秒）
    - swap_window_size: 時間窓サイズ
    - swap_min_consecutive: スワップ判定の最小連続フレーム数
    - enable_crossing_detection: 交差フェーズ検出を有効化
    - crossing_suppression_threshold: 交差検出の抑制閾値
    - use_temporal_window: 時間窓アルゴリズムを使用（レガシー互換）
    - velocity_threshold: レガシー用固定閾値
    - detection_method: 検出アルゴリズム
        - 'global_optimization': 全体最適化（推奨、デフォルト）
        - 'trajectory_prediction': 軌跡予測ベース
        - 'temporal_window': 時間窓ベース（従来手法）
        - 'legacy': フレーム間距離比較（旧手法）

    Returns:
    - 修正後のデータ
    """
    result = person_data.copy()

    # 適応閾値をログ出力
    adaptive_threshold = calculate_adaptive_velocity_threshold(fps, base_swap_velocity)
    print(f"[Limb Swap] FPS={fps}, method={detection_method}, "
          f"adaptive_threshold={adaptive_threshold:.2f} px/frame")

    def detect_swaps(data, limb_type):
        """指定された検出手法でスワップを検出"""
        if detection_method == 'global_optimization':
            return detect_limb_swaps_global_optimization(
                data, limb_type, fps=fps
            )
        elif detection_method == 'trajectory_prediction':
            return detect_limb_swaps_trajectory_prediction(
                data, limb_type, fps=fps
            )
        elif detection_method == 'temporal_window' or use_temporal_window:
            return detect_limb_swaps_with_temporal_window(
                data, limb_type, fps,
                window_size=swap_window_size,
                min_consecutive_frames=swap_min_consecutive,
                base_velocity_per_second=base_swap_velocity,
                enable_crossing_detection=enable_crossing_detection,
                crossing_suppression_threshold=crossing_suppression_threshold
            )
        else:  # legacy
            return detect_limb_swaps(
                data, limb_type,
                fps=fps,
                base_velocity_per_second=base_swap_velocity,
                use_adaptive_threshold=True
            )

    def apply_swaps(data, swap_frames, limb_type):
        """検出されたスワップを適用"""
        if not swap_frames:
            return data

        print(f"[Limb Swap] Found {len(swap_frames)} {limb_type} swap(s)")

        # global_optimization の場合は状態遷移点なので、ペアで処理
        # trajectory_prediction の場合も状態遷移点
        if detection_method in ['global_optimization', 'trajectory_prediction']:
            # スワップ状態の区間を特定して適用
            swap_frames_sorted = sorted(swap_frames)
            for idx in range(0, len(swap_frames_sorted), 2):
                start = swap_frames_sorted[idx]
                end = swap_frames_sorted[idx + 1] if idx + 1 < len(swap_frames_sorted) else len(data)
                data = swap_limbs_from_frame(data, start, limb_type, end)
        else:
            # 従来方式: 奇数番目のスワップのみ適用
            swap_count = 0
            for swap_frame in sorted(swap_frames):
                swap_count += 1
                if swap_count % 2 == 1:
                    data = swap_limbs_from_frame(data, swap_frame, limb_type)

        return data

    if fix_legs:
        leg_swaps = detect_swaps(result, 'legs')
        result = apply_swaps(result, leg_swaps, 'legs')

    if fix_arms:
        arm_swaps = detect_swaps(result, 'arms')
        result = apply_swaps(result, arm_swaps, 'arms')

    return result


def auto_fix_limb_swaps_all_persons(persons_data: Dict[str, List[List[List[float]]]],
                                     fix_legs: bool = True,
                                     fix_arms: bool = True,
                                     velocity_threshold: float = 150.0) -> Dict[str, List[List[List[float]]]]:
    """
    全人物の左右脚・腕スワップを自動修正
    
    Parameters:
    - persons_data: {person_id: [frame][keypoint][x,y,conf]}
    - fix_legs: 脚のスワップを修正するかどうか
    - fix_arms: 腕のスワップを修正するかどうか
    - velocity_threshold: スワップ検出の速度閾値
    
    Returns:
    - 修正後の persons_data
    """
    result = {}
    for person_id, frames_data in persons_data.items():
        person_array = np.array(frames_data)
        fixed_array = auto_fix_limb_swaps(person_array, fix_legs, fix_arms, velocity_threshold)
        result[person_id] = fixed_array.tolist()
    
    return result


def manual_swap_limbs(persons_data: Dict[str, List[List[List[float]]]],
                      person_id: str,
                      start_frame: int,
                      limb_type: str = 'legs',
                      end_frame: Optional[int] = None) -> Dict[str, List[List[List[float]]]]:
    """
    手動で左右脚・腕を入れ替え
    
    Parameters:
    - persons_data: {person_id: [frame][keypoint][x,y,conf]}
    - person_id: 対象人物ID
    - start_frame: 開始フレーム（1-indexed、UIからの入力）
    - limb_type: 'legs' または 'arms'
    - end_frame: 終了フレーム（Noneの場合は最後まで）
    
    Returns:
    - 修正後の persons_data
    """
    if person_id not in persons_data:
        print(f"[Limb Swap] Person {person_id} not found")
        return persons_data
    
    result = copy.deepcopy(persons_data)
    person_array = np.array(result[person_id])
    
    # UIからの入力は1-indexed、内部は0-indexed
    fixed_array = swap_limbs_from_frame(person_array, start_frame - 1, limb_type, 
                                        end_frame if end_frame is None else end_frame)
    result[person_id] = fixed_array.tolist()
    
    return result


# ===================================
# 2. 欠損補間
# ===================================

def interpolate_keypoints(data: np.ndarray,
                          confidence_threshold: float = 0.3,
                          method: str = 'pchip',
                          max_gap: int = 50) -> np.ndarray:
    """
    欠損キーポイントを補間
    連続する欠損区間が max_gap 以下の場合は補間し、それ以上の場合は補間しない。

    重要: 信頼度が0以下のフレームは「意図的に削除された空白フレーム」として扱い、
    補間の境界とする。つまり、信頼度0以下のフレームを含む区間は補間しない。

    Parameters:
    - data: shape (frames, num_keypoints, 3) - [x, y, confidence]
    - confidence_threshold: この値以下を欠損として扱う
    - method: 'linear', 'cubic', 'pchip', 'akima'
    - max_gap: 補間する最大ギャップ（フレーム数）

    Returns:
    - 補間後の data
    """
    num_frames, num_kpts, _ = data.shape
    result = data.copy()

    for kpt_idx in range(num_kpts):
        x_vals = result[:, kpt_idx, 0].copy()
        y_vals = result[:, kpt_idx, 1].copy()
        conf_vals = result[:, kpt_idx, 2].copy()

        # 有効なフレームのインデックス
        valid_mask = conf_vals > confidence_threshold
        valid_frames = np.where(valid_mask)[0]

        if len(valid_frames) < 2:
            continue

        # 意図的に削除されたフレーム（信頼度0以下）を検出
        # これらは補間の境界として扱う
        # 修正: 0.0は外れ値除去や欠損埋めで使用されるため、負の値のみを「意図的な削除」として扱う
        deleted_mask = conf_vals < 0

        # 補間関数を作成
        try:
            if method == 'linear':
                interp_x = interp1d(valid_frames, x_vals[valid_mask],
                                    kind='linear', bounds_error=False, fill_value='extrapolate')
                interp_y = interp1d(valid_frames, y_vals[valid_mask],
                                    kind='linear', bounds_error=False, fill_value='extrapolate')
            elif method == 'cubic':
                if len(valid_frames) >= 4:
                    interp_x = CubicSpline(valid_frames, x_vals[valid_mask], extrapolate=True)
                    interp_y = CubicSpline(valid_frames, y_vals[valid_mask], extrapolate=True)
                else:
                    interp_x = interp1d(valid_frames, x_vals[valid_mask],
                                        kind='linear', bounds_error=False, fill_value='extrapolate')
                    interp_y = interp1d(valid_frames, y_vals[valid_mask],
                                        kind='linear', bounds_error=False, fill_value='extrapolate')
            elif method == 'pchip':
                interp_x = PchipInterpolator(valid_frames, x_vals[valid_mask], extrapolate=True)
                interp_y = PchipInterpolator(valid_frames, y_vals[valid_mask], extrapolate=True)
            elif method == 'akima':
                if len(valid_frames) >= 5:
                    interp_x = Akima1DInterpolator(valid_frames, x_vals[valid_mask])
                    interp_y = Akima1DInterpolator(valid_frames, y_vals[valid_mask])
                else:
                    interp_x = PchipInterpolator(valid_frames, x_vals[valid_mask], extrapolate=True)
                    interp_y = PchipInterpolator(valid_frames, y_vals[valid_mask], extrapolate=True)
            else:
                interp_x = PchipInterpolator(valid_frames, x_vals[valid_mask], extrapolate=True)
                interp_y = PchipInterpolator(valid_frames, y_vals[valid_mask], extrapolate=True)

            # 連続欠損区間ごとの処理
            missing_mask = ~valid_mask
            i = 0
            while i < num_frames:
                if missing_mask[i]:
                    # 欠損区間の開始
                    start_idx = i
                    while i < num_frames and missing_mask[i]:
                        i += 1
                    end_idx = i # 欠損終了の次のフレーム（または終端）

                    gap_len = end_idx - start_idx

                    # この欠損区間に「削除フレーム」（信頼度0以下）が含まれているかチェック
                    # 含まれている場合は補間しない（境界として扱う）
                    has_deleted_frames = np.any(deleted_mask[start_idx:end_idx])

                    # ギャップが max_gap 以下、かつ削除フレームを含まない場合のみ補間適用
                    if gap_len <= max_gap and not has_deleted_frames:
                        # 補間範囲のフレームインデックス
                        gap_frames = np.arange(start_idx, end_idx)

                        # 補間値をセット
                        result[gap_frames, kpt_idx, 0] = interp_x(gap_frames)
                        result[gap_frames, kpt_idx, 1] = interp_y(gap_frames)
                        result[gap_frames, kpt_idx, 2] = 0.5  # 補間されたことを示す信頼度
                else:
                    i += 1

        except Exception:
            continue

    return result


def fill_edge_gaps(data: np.ndarray, confidence_threshold: float = 0.3, max_gap: int = 50) -> np.ndarray:
    """
    データの始端と終端の欠損を、最も近い有効値で埋める（Nearest Neighbor）
    これにより、エッジパディング時に欠損値が増殖するのを防ぐ。

    重要: 信頼度が0以下のフレームは「意図的に削除された空白フレーム」として扱い、
    埋め合わせの対象外とする。

    Parameters:
    - data: shape (frames, num_keypoints, 3)
    - confidence_threshold: 信頼度閾値
    - max_gap: 埋める最大ギャップ（フレーム数）。これを超える場合は埋めない。

    Returns:
    - 補間後の data
    """
    num_frames, num_kpts, _ = data.shape
    result = data.copy()

    total_filled_start = 0
    total_filled_end = 0

    for kpt_idx in range(num_kpts):
        conf_vals = result[:, kpt_idx, 2]
        valid_mask = conf_vals > confidence_threshold
        valid_indices = np.where(valid_mask)[0]

        # 意図的に削除されたフレーム（信頼度0以下）を検出
        # 修正: 0.0は外れ値除去や欠損埋めで使用されるため、負の値のみを「意図的な削除」として扱う
        deleted_mask = conf_vals < 0

        if len(valid_indices) == 0:
            continue

        first_valid = valid_indices[0]
        last_valid = valid_indices[-1]

        # 始端の埋め合わせ（削除フレームがある場合、またはmax_gapを超える場合は埋めない）
        if first_valid > 0 and first_valid <= max_gap:
            # 始端に削除フレームがあるかチェック
            if not np.any(deleted_mask[:first_valid]):
                result[:first_valid, kpt_idx, 0] = result[first_valid, kpt_idx, 0]
                result[:first_valid, kpt_idx, 1] = result[first_valid, kpt_idx, 1]
                result[:first_valid, kpt_idx, 2] = 0.5 # 補間値としてマーク
                total_filled_start += first_valid

        # 終端の埋め合わせ（削除フレームがある場合、またはmax_gapを超える場合は埋めない）
        end_gap = num_frames - 1 - last_valid
        if last_valid < num_frames - 1 and end_gap <= max_gap:
            # 終端に削除フレームがあるかチェック
            if not np.any(deleted_mask[last_valid+1:]):
                result[last_valid+1:, kpt_idx, 0] = result[last_valid, kpt_idx, 0]
                result[last_valid+1:, kpt_idx, 1] = result[last_valid, kpt_idx, 1]
                result[last_valid+1:, kpt_idx, 2] = 0.5 # 補間値としてマーク
                total_filled_end += end_gap
            
    if total_filled_start > 0 or total_filled_end > 0:
        # 平均フレーム数を計算して表示
        avg_start = total_filled_start / num_kpts
        avg_end = total_filled_end / num_kpts
        print(f"[Filtering] Fill Edge Gaps: Avg Start={avg_start:.1f} frames, Avg End={avg_end:.1f} frames")

    return result

# ===================================
# 3. 平滑化フィルタ
# ===================================

def butterworth_filter(data: np.ndarray, 
                       cutoff_freq: float = 6.0, 
                       fps: float = 30.0, 
                       order: int = 4) -> np.ndarray:
    """
    Butterworth ローパスフィルタ
    信頼度 > 0 の連続区間ごとにフィルタを適用し、欠損区間（0埋め）の影響を防ぐ。
    
    Parameters:
    - data: shape (frames, num_keypoints, 3)
    - cutoff_freq: カットオフ周波数 (Hz)
    - fps: フレームレート
    - order: フィルタ次数
    
    Returns:
    - フィルタリング後の data
    """
    num_frames, num_kpts, _ = data.shape
    result = data.copy()
    
    # 元の欠損マスクを保存（信頼度が0または負のフレーム）
    original_missing_mask = data[:, :, 2] <= 0
    
    # ナイキスト周波数
    nyq = 0.5 * fps
    normal_cutoff = cutoff_freq / nyq
    
    # カットオフ周波数が有効範囲内か確認
    if normal_cutoff >= 1.0:
        normal_cutoff = 0.99
    if normal_cutoff <= 0:
        return result
    
    try:
        b, a = signal.butter(order, normal_cutoff, btype='low')
    except Exception:
        return result
    
    for kpt_idx in range(num_kpts):
        # 信頼度を取得して有効区間を特定
        conf_vals = result[:, kpt_idx, 2]
        valid_mask = conf_vals > 0.0 # 信頼度がある（削除されていない）フレームのみ対象
        
        # 連続区間ごとに処理
        i = 0
        while i < num_frames:
            if valid_mask[i]:
                # 区間開始
                start = i
                while i < num_frames and valid_mask[i]:
                    i += 1
                end = i
                
                # 区間 [start:end] に対してフィルタ適用
                # フィルタの適用には最低限のデータ長が必要（次数の3倍程度推奨）
                length = end - start
                if length >= 3 * order + 3: # マージンを持って判定
                    try:
                        # X座標
                        segment_x = result[start:end, kpt_idx, 0]
                        result[start:end, kpt_idx, 0] = signal.filtfilt(b, a, segment_x)
                        
                        # Y座標
                        segment_y = result[start:end, kpt_idx, 1]
                        result[start:end, kpt_idx, 1] = signal.filtfilt(b, a, segment_y)
                    except Exception:
                        pass
            else:
                i += 1
    
    # 元の欠損データを復元（信頼度0のフレームは0にリセット）
    for kpt_idx in range(num_kpts):
        missing_frames = original_missing_mask[:, kpt_idx]
        result[missing_frames, kpt_idx, 0] = 0.0
        result[missing_frames, kpt_idx, 1] = 0.0
        result[missing_frames, kpt_idx, 2] = 0.0
                
    return result


def gaussian_filter(data: np.ndarray, sigma: float = 2.0) -> np.ndarray:
    """
    ガウシアンフィルタ
    
    Parameters:
    - data: shape (frames, num_keypoints, 3)
    - sigma: 標準偏差
    
    Returns:
    - フィルタリング後の data
    """
    from scipy.ndimage import gaussian_filter1d  # gaussian_filter1dはファイル先頭で未インポートのためここでインポート
    
    result = data.copy()
    num_kpts = data.shape[1]
    
    for kpt_idx in range(num_kpts):
        result[:, kpt_idx, 0] = gaussian_filter1d(result[:, kpt_idx, 0], sigma=sigma)
        result[:, kpt_idx, 1] = gaussian_filter1d(result[:, kpt_idx, 1], sigma=sigma)
    
    return result


def median_filter_keypoints(data: np.ndarray, size: int = 5) -> np.ndarray:
    """
    メディアンフィルタ
    
    Parameters:
    - data: shape (frames, num_keypoints, 3)
    - size: ウィンドウサイズ
    
    Returns:
    - フィルタリング後の data
    """
    # ファイル先頭のscipy_median_filterを使用
    
    result = data.copy()
    num_kpts = data.shape[1]
    
    for kpt_idx in range(num_kpts):
        result[:, kpt_idx, 0] = scipy_median_filter(result[:, kpt_idx, 0], size=size)
        result[:, kpt_idx, 1] = scipy_median_filter(result[:, kpt_idx, 1], size=size)
    
    return result


# ===================================
# 4. カルマンフィルタ/スムーザー
# ===================================

def kalman_filter_keypoints(data: np.ndarray, 
                            fps: float = 30.0,
                            process_noise: float = 0.1,
                            measurement_noise: float = 1.0) -> np.ndarray:
    """
    カルマンフィルタ（位置と速度を推定）
    信頼度が0のフレームは欠損データとして維持される。
    
    Parameters:
    - data: shape (frames, num_keypoints, 3)
    - fps: フレームレート
    - process_noise: プロセスノイズ
    - measurement_noise: 観測ノイズ
    
    Returns:
    - フィルタリング後の data
    """
    try:
        from filterpy.kalman import KalmanFilter
    except ImportError:
        return data
    
    num_frames, num_kpts, _ = data.shape
    result = data.copy()
    dt = 1.0 / fps
    
    # 元の欠損マスクを保存（信頼度が0のフレーム）
    original_missing_mask = data[:, :, 2] <= 0
    
    for kpt_idx in range(num_kpts):
        # このキーポイントに有効なデータがあるか確認
        valid_mask = data[:, kpt_idx, 2] > 0
        if not np.any(valid_mask):
            continue  # 全フレームが欠損なら何もしない
        
        # 最初の有効フレームを見つける
        first_valid_idx = np.argmax(valid_mask)
        
        # 2D 位置と速度を推定（状態: [x, vx, y, vy]）
        kf = KalmanFilter(dim_x=4, dim_z=2)
        
        # 状態遷移行列
        kf.F = np.array([
            [1, dt, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, dt],
            [0, 0, 0, 1]
        ])
        
        # 観測行列
        kf.H = np.array([
            [1, 0, 0, 0],
            [0, 0, 1, 0]
        ])
        
        # 初期状態（最初の有効フレームの値を使用）
        kf.x = np.array([
            data[first_valid_idx, kpt_idx, 0],
            0,
            data[first_valid_idx, kpt_idx, 1],
            0
        ])
        
        # 共分散行列
        kf.P *= 100
        kf.R = np.eye(2) * measurement_noise
        kf.Q = np.eye(4) * process_noise
        
        # フィルタリング
        filtered_states = []
        for frame_idx in range(num_frames):
            z = np.array([
                data[frame_idx, kpt_idx, 0],
                data[frame_idx, kpt_idx, 1]
            ])
            
            kf.predict()
            
            # 信頼度が低い場合は観測を使わない
            if data[frame_idx, kpt_idx, 2] > 0.3:
                kf.update(z)
            
            filtered_states.append(kf.x.copy())
        
        filtered_states = np.array(filtered_states)
        result[:, kpt_idx, 0] = filtered_states[:, 0]
        result[:, kpt_idx, 1] = filtered_states[:, 2]
    
    # 元の欠損データを復元（信頼度0のフレームは0にリセット）
    for kpt_idx in range(num_kpts):
        missing_frames = original_missing_mask[:, kpt_idx]
        result[missing_frames, kpt_idx, 0] = 0.0
        result[missing_frames, kpt_idx, 1] = 0.0
        result[missing_frames, kpt_idx, 2] = 0.0
    
    return result


# ===================================
# 5. 完全なフィルタリングパイプライン
# ===================================

def process_keypoints(keypoints_dict: Dict[str, List[List[float]]],
                      fps: float = 30.0,
                      confidence_threshold: float = 0.3,
                      enable_outlier_removal: bool = True,
                      enable_interpolation: bool = True,
                      enable_limb_swap_fix: bool = True,
                      enable_butterworth: bool = True,
                      enable_kalman: bool = False,
                      interpolation_method: str = 'pchip',
                      butterworth_cutoff: float = 6.0,
                      butterworth_order: int = 4,
                      max_gap: int = 50,
                      edge_padding: int = 20,
                      zscore_threshold: float = 3.5,
                      max_velocity: float = 3000.0,
                      enable_acceleration_check: bool = False,
                      max_acceleration: float = 50000.0,
                      base_swap_velocity: float = 1500.0,
                      swap_window_size: int = 5,
                      swap_min_consecutive: int = 3,
                      enable_crossing_detection: bool = True,
                      crossing_suppression_threshold: float = 0.6,
                      swap_detection_method: str = 'global_optimization') -> Dict[str, List[List[float]]]:
    """
    完全なフィルタリングパイプライン

    Parameters:
    - keypoints_dict: {person_id: [[x, y, conf], ...] * 23} の辞書
    - fps: フレームレート
    - confidence_threshold: 信頼度閾値
    - enable_outlier_removal: 外れ値除去を有効化
    - enable_interpolation: 補間を有効化
    - enable_limb_swap_fix: 左右脚スワップ修正を有効化
    - enable_butterworth: Butterworth フィルタを有効化
    - enable_kalman: カルマンフィルタを有効化
    - interpolation_method: 補間手法
    - butterworth_cutoff: カットオフ周波数
    - butterworth_order: フィルタ次数
    - max_gap: 補間の最大ギャップ
    - edge_padding: 両端パディング数（フィルタのエッジ効果対策）
    - zscore_threshold: Z-score外れ値閾値（デフォルト3.5に厳格化）
    - max_velocity: 最大許容速度（ピクセル/秒、デフォルト3000に厳格化）
    - enable_acceleration_check: 加速度チェックを有効化
    - max_acceleration: 最大許容加速度（ピクセル/秒^2）
    - base_swap_velocity: スワップ検出基準速度（ピクセル/秒）
    - swap_window_size: スワップ検出の時間窓サイズ
    - swap_min_consecutive: スワップ判定の最小連続フレーム数
    - enable_crossing_detection: 交差フェーズ検出を有効化
    - crossing_suppression_threshold: 交差検出の抑制閾値
    - swap_detection_method: スワップ検出アルゴリズム
        - 'global_optimization': 全体最適化（推奨、デフォルト）
        - 'trajectory_prediction': 軌跡予測ベース
        - 'temporal_window': 時間窓ベース
        - 'legacy': フレーム間距離比較

    Returns:
    - フィルタリング後の keypoints_dict
    """
    result = {}
    
    for person_id, frames_data in keypoints_dict.items():
        # frames_data は [frame][keypoint][x,y,conf] の形式
        # numpy 配列に変換: shape (frames, keypoints, 3)
        try:
            # データの構造を確認
            if not isinstance(frames_data, list) or len(frames_data) == 0:
                print(f"[Filtering] Person {person_id}: frames_data is not a list or empty")
                result[person_id] = frames_data
                continue
            
            # 最初のフレームの構造を確認
            first_frame = frames_data[0]
            if not isinstance(first_frame, list):
                print(f"[Filtering] Person {person_id}: first frame is not a list (type: {type(first_frame)})")
                result[person_id] = frames_data
                continue
            
            if len(first_frame) == 0:
                print(f"[Filtering] Person {person_id}: first frame is empty")
                result[person_id] = frames_data
                continue
            
            # 最初のキーポイントの構造を確認
            first_kpt = first_frame[0]
            if not isinstance(first_kpt, list) or len(first_kpt) < 3:
                print(f"[Filtering] Person {person_id}: first keypoint is invalid (type: {type(first_kpt)}, len: {len(first_kpt) if isinstance(first_kpt, list) else 'N/A'})")
                result[person_id] = frames_data
                continue
            
            data = np.array(frames_data, dtype=np.float64)
            print(f"[Filtering] Person {person_id}: data shape = {data.shape}, dtype = {data.dtype}")
        except Exception as e:
            print(f"[Filtering] Error converting data for person {person_id}: {e}")
            import traceback
            traceback.print_exc()
            result[person_id] = frames_data
            continue
        
        if data.ndim != 3:
            print(f"[Filtering] Person {person_id}: invalid dimensions {data.ndim}, expected 3, skipping")
            result[person_id] = frames_data
            continue
        
        if data.shape[2] != 3:
            print(f"[Filtering] Person {person_id}: invalid shape {data.shape}, expected (frames, keypoints, 3), skipping")
            result[person_id] = frames_data
            continue
        
        try:
            original_length = data.shape[0]
            
            # Step 1: 左右脚・腕スワップ修正（最初に実行）
            # 理由: スワップは大きな位置ジャンプを生むため、外れ値除去の前に修正しないと
            # 「偽の外れ値」として有効なデータが削除されてしまう
            if enable_limb_swap_fix:
                print(f"[Filtering] Step 1: Auto-fix limb swaps for person {person_id} (method={swap_detection_method})")
                data = auto_fix_limb_swaps(
                    data,
                    fix_legs=True,
                    fix_arms=True,
                    fps=fps,
                    base_swap_velocity=base_swap_velocity,
                    swap_window_size=swap_window_size,
                    swap_min_consecutive=swap_min_consecutive,
                    enable_crossing_detection=enable_crossing_detection,
                    crossing_suppression_threshold=crossing_suppression_threshold,
                    detection_method=swap_detection_method
                )

            # Step 2: 外れ値除去（スワップ修正後に実行）
            if enable_outlier_removal:
                print(f"[Filtering] Step 2: Outlier removal for person {person_id}")
                data = remove_outliers(
                    data,
                    confidence_threshold=confidence_threshold,
                    fps=fps,
                    zscore_threshold=zscore_threshold,
                    max_velocity=max_velocity,
                    enable_acceleration_check=enable_acceleration_check,
                    max_acceleration=max_acceleration
                )

            # Step 3: 欠損補間
            if enable_interpolation:
                print(f"[Filtering] Step 3: Interpolation for person {person_id}")
                data = interpolate_keypoints(
                    data,
                    confidence_threshold=confidence_threshold,
                    method=interpolation_method,
                    max_gap=max_gap
                )

            # Step 3.4: 端点の欠損埋め
            # パディングやフィルタリングのために、端点の欠損を有効値で埋める
            # max_gapを超える場合は埋めない
            if enable_interpolation:
                print(f"[Filtering] Step 3.4: Fill edge gaps for person {person_id}")
                data = fill_edge_gaps(data, confidence_threshold=confidence_threshold, max_gap=max_gap)

            # Step 3.5: エッジパディング（平滑化フィルタ適用前）
            # 両端にデータを反転してパディングし、フィルタのエッジ効果を軽減
            if edge_padding > 0 and (enable_butterworth or enable_kalman):
                actual_padding = min(edge_padding, original_length - 1)
                if actual_padding > 0:
                    print(f"[Filtering] Step 3.5: Edge padding ({actual_padding} frames) for person {person_id}")
                    # 先頭部分を反転してパディング
                    start_pad = np.flip(data[1:actual_padding+1], axis=0)
                    # 末尾部分を反転してパディング
                    end_pad = np.flip(data[-(actual_padding+1):-1], axis=0)
                    # パディングを追加
                    data = np.concatenate([start_pad, data, end_pad], axis=0)
                    print(f"[Filtering] Data padded from {original_length} to {data.shape[0]} frames")
            
            # Step 4: Butterworth フィルタ
            if enable_butterworth:
                print(f"[Filtering] Step 4: Butterworth filter for person {person_id}")
                data = butterworth_filter(
                    data,
                    cutoff_freq=butterworth_cutoff,
                    fps=fps,
                    order=butterworth_order
                )
            
            # Step 5: カルマンフィルタ（オプション）
            if enable_kalman:
                print(f"[Filtering] Step 5: Kalman filter for person {person_id}")
                data = kalman_filter_keypoints(data, fps=fps)
            
            # Step 5.5: エッジパディングを削除
            if edge_padding > 0 and (enable_butterworth or enable_kalman):
                actual_padding = min(edge_padding, original_length - 1)
                if actual_padding > 0 and data.shape[0] > original_length:
                    print(f"[Filtering] Step 5.5: Removing edge padding for person {person_id}")
                    data = data[actual_padding:-actual_padding]
                    print(f"[Filtering] Data trimmed back to {data.shape[0]} frames")
            
            # リストに戻す
            result[person_id] = data.tolist()
            print(f"[Filtering] Completed filtering for person {person_id}")
        except Exception as e:
            print(f"[Filtering] Error processing person {person_id}: {e}")
            import traceback
            traceback.print_exc()
            result[person_id] = frames_data
    
    return result


def process_video_keypoints(frames_data: List[Dict], 
                            fps: float = 30.0,
                            **filter_options) -> List[Dict]:
    """
    動画のフレームデータに対してフィルタリングを適用
    
    Parameters:
    - frames_data: [{'frame': 1, 'keypoints': {person_id: [[x,y,conf],...]}}, ...]
    - fps: フレームレート
    - **filter_options: フィルタリングオプション
    
    Returns:
    - フィルタリング後の frames_data
    """
    print(f"[Filtering] process_video_keypoints called with {len(frames_data) if frames_data else 0} frames")
    
    if not frames_data:
        return frames_data
    
    try:
        # 人物ごとにデータを整理
        persons_data = {}
        frame_numbers = []
        total_frames = len(frames_data)
        
        for i, frame_info in enumerate(frames_data):
            # frame_info が辞書かどうか確認
            if not isinstance(frame_info, dict):
                print(f"[Filtering] Frame {i}: Unexpected type {type(frame_info)}, skipping")
                continue
            
            frame_num = frame_info.get('frame', 0)
            keypoints = frame_info.get('keypoints', {})
            
            if not isinstance(keypoints, dict):
                print(f"[Filtering] Frame {i}: keypoints is not dict (type: {type(keypoints)}), skipping")
                continue
            
            frame_numbers.append(frame_num)
            
            for person_id, kpts in keypoints.items():
                if not isinstance(kpts, list):
                    print(f"[Filtering] Frame {i}, Person {person_id}: keypoints is not list (type: {type(kpts)}), skipping")
                    continue
                
                # 初めての人物なら全フレーム分をプレースホルダで確保
                if person_id not in persons_data:
                    num_kpts = len(kpts)
                    empty_kpts = [[0.0, 0.0, 0.0] for _ in range(num_kpts)]
                    persons_data[person_id] = [empty_kpts.copy() for _ in range(total_frames)]
                
                # このフレームの位置にキーポイントをセット
                persons_data[person_id][i] = kpts
        
        print(f"[Filtering] Found {len(persons_data)} persons, {len(frame_numbers)} frames")
        
        if len(persons_data) == 0:
            print("[Filtering] No valid person data found, returning original frames")
            return frames_data
            
    except Exception as e:
        print(f"[Filtering] Error organizing data: {e}")
        import traceback
        traceback.print_exc()
        return frames_data
    
    try:
        # Step 0: IDスワップ修正（オプション）- 手動対応のため削除
        # 引数は process_keypoints に渡さないよう除去する
        filter_options.pop('enable_id_swap_fix', None)
        filter_options.pop('id_swap_threshold', None)
        
        # 人物ごとにフィルタリング（enable_limb_swap_fixも含む）
        print(f"[Filtering] Calling process_keypoints with {len(persons_data)} persons")
        filtered_persons = process_keypoints(persons_data, fps=fps, **filter_options)
        print(f"[Filtering] process_keypoints returned {len(filtered_persons)} persons")
        
        # 元の形式に戻す
        result = []
        for i, frame_num in enumerate(frame_numbers):
            frame_keypoints = {}
            for person_id, all_frames_kpts in filtered_persons.items():
                if i < len(all_frames_kpts):
                    frame_keypoints[person_id] = all_frames_kpts[i]
            
            result.append({
                'frame': frame_num,
                'keypoints': frame_keypoints
            })
        
        print(f"[Filtering] Returning {len(result)} frames")
        return result

    except Exception as e:
        print(f"[Filtering] Error in filtering process: {e}")
        import traceback
        traceback.print_exc()
        # エラーが発生した場合は元のデータを返す
        return frames_data


# ===================================
# ID統合（断片化したIDを統合）
# ===================================

def consolidate_person_ids(
    frames_data: List[Dict],
    max_gap_frames: int = 120,
    distance_threshold: float = 100.0,
    min_overlap_check_frames: int = 5
) -> Tuple[List[Dict], Dict[str, str]]:
    """
    検出が途切れて新しいIDが割り当てられた人物を統合する

    同一人物の判定基準:
    1. 時間的に重複していない（一方が終了した後にもう一方が開始）
    2. 空間的に近い（最終/開始位置が近い）
    3. ギャップが指定フレーム数以内

    Parameters:
    - frames_data: [{'frame': int, 'keypoints': {person_id: kpts}}]
    - max_gap_frames: ID統合を許可する最大ギャップフレーム数
    - distance_threshold: 同一人物と判定する最大距離（ピクセル）
    - min_overlap_check_frames: 重複チェックに使用する最小フレーム数

    Returns:
    - consolidated_frames: 統合後のフレームデータ
    - id_mapping: {old_id: new_id} のマッピング
    """
    if not frames_data:
        return frames_data, {}

    # 各人物の出現範囲と位置を収集
    person_info = {}  # {person_id: {'start': frame, 'end': frame, 'positions': [(frame, x, y), ...]}}

    for frame_data in frames_data:
        frame_num = frame_data.get('frame', 0)
        keypoints = frame_data.get('keypoints', {})

        for person_id, kpts in keypoints.items():
            if person_id not in person_info:
                person_info[person_id] = {
                    'start': frame_num,
                    'end': frame_num,
                    'positions': []
                }

            person_info[person_id]['end'] = frame_num

            # 重心位置を計算
            kpts_arr = np.array(kpts) if isinstance(kpts, list) else kpts
            valid_mask = kpts_arr[:, 2] > 0.3
            if np.sum(valid_mask) >= 3:
                centroid_x = np.mean(kpts_arr[valid_mask, 0])
                centroid_y = np.mean(kpts_arr[valid_mask, 1])
                person_info[person_id]['positions'].append((frame_num, centroid_x, centroid_y))

    # 統合候補を見つける
    id_mapping = {}  # old_id -> new_id
    person_ids = list(person_info.keys())

    for i, id_a in enumerate(person_ids):
        if id_a in id_mapping:
            continue  # 既に統合済み

        info_a = person_info[id_a]

        for j, id_b in enumerate(person_ids):
            if i >= j:
                continue  # 同じペアを2回チェックしない
            if id_b in id_mapping:
                continue  # 既に統合済み

            info_b = person_info[id_b]

            # 時間的に重複していないかチェック
            # A が先に終了して B が後で開始する場合
            if info_a['end'] < info_b['start']:
                gap = info_b['start'] - info_a['end']
                earlier_id, later_id = id_a, id_b
                earlier_info, later_info = info_a, info_b
            elif info_b['end'] < info_a['start']:
                gap = info_a['start'] - info_b['end']
                earlier_id, later_id = id_b, id_a
                earlier_info, later_info = info_b, info_a
            else:
                # 時間的に重複している場合は統合しない
                continue

            # ギャップが大きすぎる場合はスキップ
            if gap > max_gap_frames:
                continue

            # 空間的な距離をチェック
            # earlier の最後の位置と later の最初の位置を比較
            if not earlier_info['positions'] or not later_info['positions']:
                continue

            # 最後/最初の数フレームの平均位置を使用（ノイズ対策）
            earlier_last_positions = [p for p in earlier_info['positions']
                                      if p[0] >= earlier_info['end'] - min_overlap_check_frames]
            later_first_positions = [p for p in later_info['positions']
                                     if p[0] <= later_info['start'] + min_overlap_check_frames]

            if not earlier_last_positions or not later_first_positions:
                continue

            earlier_x = np.mean([p[1] for p in earlier_last_positions])
            earlier_y = np.mean([p[2] for p in earlier_last_positions])
            later_x = np.mean([p[1] for p in later_first_positions])
            later_y = np.mean([p[2] for p in later_first_positions])

            distance = np.sqrt((earlier_x - later_x)**2 + (earlier_y - later_y)**2)

            if distance <= distance_threshold:
                # 統合: later_id を earlier_id に統合
                id_mapping[later_id] = earlier_id
                print(f"[ID Consolidation] Merging '{later_id}' -> '{earlier_id}' "
                      f"(gap={gap} frames, distance={distance:.1f}px)")

                # earlier_info を更新して later の範囲も含める
                earlier_info['end'] = later_info['end']
                earlier_info['positions'].extend(later_info['positions'])

    # マッピングを連鎖的に解決 (A->B, B->C の場合、A->C にする)
    def resolve_mapping(pid):
        visited = set()
        while pid in id_mapping and pid not in visited:
            visited.add(pid)
            pid = id_mapping[pid]
        return pid

    for old_id in list(id_mapping.keys()):
        id_mapping[old_id] = resolve_mapping(old_id)

    if not id_mapping:
        print("[ID Consolidation] No IDs to merge")
        return frames_data, {}

    # フレームデータを更新
    consolidated_frames = []
    for frame_data in frames_data:
        new_keypoints = {}
        for person_id, kpts in frame_data.get('keypoints', {}).items():
            new_id = id_mapping.get(person_id, person_id)
            # 同じIDに複数の人物がマッピングされた場合、最初のものを使用
            if new_id not in new_keypoints:
                new_keypoints[new_id] = kpts

        consolidated_frames.append({
            'frame': frame_data.get('frame', 0),
            'keypoints': new_keypoints
        })

    print(f"[ID Consolidation] Merged {len(id_mapping)} IDs")
    return consolidated_frames, id_mapping

