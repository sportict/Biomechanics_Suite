"""
opensim_toolkit.py
MotionDigitizer → OpenSim 完全ツールキット

使い方:
  python opensim_toolkit.py check   --osim モデル.osim
  python opensim_toolkit.py convert --trc 入力.trc --out 出力.trc
  python opensim_toolkit.py setup   --osim scaled.osim --static static.trc --dynamic motion.trc
  python opensim_toolkit.py all     --osim モデル.osim --static static.trc --dynamic motion.trc --mass 60
"""

import sys
import os
import json
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import TypedDict

USAGE = (
    "使い方:\n"
    "  python opensim_toolkit.py check   --osim モデル.osim\n"
    "  python opensim_toolkit.py convert --trc 入力.trc --out 出力.trc\n"
    "  python opensim_toolkit.py all     --osim モデル.osim --static static.trc "
    "--dynamic motion.trc --mass 60\n"
)


class TRCData(TypedDict):
    data_rate: float
    camera_rate: float
    num_frames: int
    num_markers: int
    units: str
    orig_rate: float
    orig_start: int
    orig_frames: int
    marker_names: list[str]
    data_lines: list[str]

# =============================================================================
# マーカー名マッピング (opensim_marker_map.json があれば自動読み込み)
# =============================================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MAP_FILE = os.path.join(SCRIPT_DIR, 'opensim_marker_map.json')

DEFAULT_MARKER_MAP = {
    "右手先":   "R.Finger",
    "右手首":   "R.Wrist",
    "右肘":     "R.Elbow",
    "右肩":     "R.Shoulder",
    "左手先":   "L.Finger",
    "左手首":   "L.Wrist",
    "左肘":     "L.Elbow",
    "左肩":     "L.Shoulder",
    "右つま先": "R.Toe",
    "右母指球": "R.MT1",
    "右かかと": "R.Heel",
    "右足首":   "R.Ankle",
    "右膝":     "R.Knee",
    "右大転子": "R.ASIS",
    "左つま先": "L.Toe",
    "左母指球": "L.MT1",
    "左かかと": "L.Heel",
    "左足首":   "L.Ankle",
    "左膝":     "L.Knee",
    "左大転子": "L.ASIS",
    "頭頂":     "Head",
    "耳珠点":   "L.Ear",
    "胸骨上縁": "Sternum",
}

def load_marker_map(map_file=MAP_FILE):
    if os.path.exists(map_file):
        with open(map_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # _comment キーを除外
        return {k: v for k, v in data.items() if not k.startswith('_')}
    return DEFAULT_MARKER_MAP

MARKER_MAP = load_marker_map()

# IKウェイト設定 (Rajagopal2015マーカー名)
IK_WEIGHTS = {
    # 足首・膝・股関節 — 歩行IKで最重要
    'RLMAL': 20, 'LLMAL': 20,   # 外果
    'RLFC':  20, 'LLFC':  20,   # 外側大腿骨顆
    'RHJC':  20, 'LHJC':  20,   # 股関節中心（大転子相当）
    # 足部
    'RCAL':  15, 'LCAL':  15,   # 踵骨
    'RTOE':  10, 'LTOE':  10,   # 足趾
    'RMT5':   5, 'LMT5':   5,   # 第5中足骨
    # 肩・肘・手首
    'RACR':  10, 'LACR':  10,   # 肩峰
    'RLEL':   5, 'LLEL':   5,   # 外側上顆
    'RFAradius': 5, 'LFAradius': 5,  # 橈骨茎状突起相当
    'RFAulna':   3, 'LFAulna':   3,  # 尺骨側前腕遠位
    # 体幹
    'CLAV':   5,                # 鎖骨（胸骨上縁相当）
    'C7':     3,                # 第7頸椎
}
DEFAULT_WEIGHT = 1.0


# =============================================================================
# 1. モデルのマーカー名確認
# =============================================================================
def check_model_markers(osim_path):
    print(f"\n{'='*60}")
    print(f"モデル: {osim_path}")
    print(f"{'='*60}")

    tree = ET.parse(osim_path)
    root = tree.getroot()

    model_markers: set[str] = set()
    for marker in root.iter('Marker'):
        name = marker.get('name')
        if name is not None:
            model_markers.add(name)

    print(f"\nモデルのマーカー数: {len(model_markers)}")
    print("モデルのマーカー名一覧:")
    for m in sorted(model_markers):
        print(f"  {m}")

    trc_markers = set(MARKER_MAP.values())
    matched   = trc_markers & model_markers
    unmatched = trc_markers - model_markers

    print(f"\n{'='*60}")
    print(f"TRC側マーカー: {len(trc_markers)}点")
    print(f"モデルと一致: {len(matched)}点  ← スケーリングに使用")
    print(f"不一致（TRCにあるがモデルにない）: {len(unmatched)}点  ← IKで無視")

    if unmatched:
        print(f"\n[不一致マーカー] → opensim_marker_map.json の右辺を修正:")
        for m in sorted(unmatched):
            jp = [k for k, v in MARKER_MAP.items() if v == m]
            print(f"  {m}  (MotionDigitizer: {jp})")

    if matched:
        print(f"\n[一致マーカー] → スケーリング・IKで使用:")
        for m in sorted(matched):
            jp = [k for k, v in MARKER_MAP.items() if v == m]
            print(f"  {m}  (MotionDigitizer: {jp})")

    return model_markers, matched, unmatched


# =============================================================================
# 2. TRCファイル読み書き・マーカー名変換
# =============================================================================
def read_trc(path: str) -> TRCData:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        lines = f.readlines()

    header3 = lines[2].strip().split('\t')
    data_rate   = float(header3[0])
    camera_rate = float(header3[1])
    num_frames  = int(header3[2])
    num_markers = int(header3[3])
    units       = header3[4]
    orig_rate   = float(header3[5])
    orig_start  = int(header3[6])
    orig_frames = int(header3[7])

    marker_line = lines[3].strip().split('\t')
    marker_names = []
    for i, val in enumerate(marker_line):
        if i <= 1:
            continue
        if val.strip():
            marker_names.append(val.strip())

    data_lines: list[str] = [l for i, l in enumerate(lines) if i >= 5 and l.strip()]

    return {
        'data_rate': data_rate, 'camera_rate': camera_rate,
        'num_frames': num_frames, 'num_markers': num_markers,
        'units': units, 'orig_rate': orig_rate,
        'orig_start': orig_start, 'orig_frames': orig_frames,
        'marker_names': marker_names, 'data_lines': data_lines,
    }


def convert_trc_marker_names(
    input_trc: str,
    output_trc: str,
    name_map: "dict[str, str] | None" = None,
    model_markers: "set[str] | None" = None,
) -> "list[str]":
    if name_map is None:
        name_map = MARKER_MAP

    trc = read_trc(input_trc)
    original_names = trc['marker_names']

    print(f"\nTRC変換: {input_trc} → {output_trc}")
    print(f"元のマーカー数: {len(original_names)}")

    # None チェック済みの型確定変数を使う（チェッカーの型推論バグを回避）
    _map: dict[str, str] = name_map
    new_names: list[str] = []
    include_mask: list[bool] = []

    for orig in original_names:
        new_name: str = _map[orig] if orig in _map else orig  # type: ignore[operator]
        if model_markers is not None and new_name not in model_markers:  # type: ignore[operator]
            include_mask.append(False)
            print(f"  除外: {orig} → {new_name}  (モデルに未定義)")
        else:
            include_mask.append(True)
            new_names.append(new_name)
            if orig != new_name:
                print(f"  変換: {orig} → {new_name}")
            else:
                print(f"  保持: {orig}")

    print(f"変換後のマーカー数: {len(new_names)}")

    with open(output_trc, 'w', encoding='utf-8') as f:
        fname = os.path.basename(output_trc)
        f.write(f"PathFileType\t4\t(X/Y/Z)\t{fname}\r\n")
        f.write("DataRate\tCameraRate\tNumFrames\tNumMarkers\tUnits\t"
                "OrigDataRate\tOrigDataStartFrame\tOrigNumFrames\r\n")
        f.write(f"{trc['data_rate']}\t{trc['camera_rate']}\t"
                f"{trc['num_frames']}\t{len(new_names)}\t"
                f"{trc['units']}\t{trc['orig_rate']}\t"
                f"{trc['orig_start']}\t{trc['orig_frames']}\r\n")

        header4 = "Frame#\tTime"
        for name in new_names:
            header4 += f"\t{name}\t\t"
        f.write(header4.rstrip('\t') + "\r\n")

        sub = "\t"
        for i in range(1, len(new_names) + 1):
            sub += f"\tX{i}\tY{i}\tZ{i}"
        f.write(sub + "\r\n")

        for line in trc['data_lines']:
            cols = line.rstrip('\n\r').split('\t')
            new_cols = [cols[0], cols[1]]
            for idx, include in enumerate(include_mask):
                if include:
                    base = 2 + idx * 3
                    new_cols.append(cols[base]     if base     < len(cols) else '')
                    new_cols.append(cols[base + 1] if base + 1 < len(cols) else '')
                    new_cols.append(cols[base + 2] if base + 2 < len(cols) else '')
            f.write('\t'.join(new_cols) + "\r\n")

    print(f"✓ 保存完了: {output_trc}")
    return new_names


# =============================================================================
# 3. Setup XML 生成
# =============================================================================
def _measurement(name: str, m1: str, m2: str, bodies: "list[tuple[str,str]]") -> str:
    """OpenSim Measurement XML ブロックを生成する。
    bodies: [(body_name, axes), ...] 例: [('femur_r', 'X Y Z')]
    """
    body_xml = "\n".join(
        f"""                <BodyScale name="{b}">
                    <axes> {axes} </axes>
                </BodyScale>"""
        for b, axes in bodies
    )
    return f"""            <Measurement name="{name}">
                <apply>true</apply>
                <MarkerPairSet>
                    <objects>
                        <MarkerPair>
                            <markers> {m1} {m2} </markers>
                        </MarkerPair>
                    </objects>
                    <groups />
                </MarkerPairSet>
                <BodyScaleSet>
                    <objects>
{body_xml}
                    </objects>
                    <groups />
                </BodyScaleSet>
            </Measurement>"""


def generate_scale_setup(osim_path: str, static_trc: str, output_scaled_osim: str,
                          subject_mass: float, time_start: float, time_end: float,
                          output_xml: str = 'Setup_Scale.xml') -> str:
    # MotionDigitizer 23点から導出できる計測ペア (Rajagopal2015マーカー名)
    measurements = "\n".join([
        # ── 骨盤 ──────────────────────────────────────────────────
        _measurement("pelvis",
                     "RHJC", "LHJC",
                     [("pelvis", "X Y Z")]),
        # ── 右大腿 ────────────────────────────────────────────────
        _measurement("femur_r",
                     "RHJC", "RLFC",
                     [("femur_r", "X Y Z")]),
        # ── 右下腿 ────────────────────────────────────────────────
        _measurement("tibia_r",
                     "RLFC", "RLMAL",
                     [("tibia_r", "X Y Z"), ("patella_r", "X Y Z")]),
        # ── 右足部 ────────────────────────────────────────────────
        _measurement("calcn_r",
                     "RLMAL", "RCAL",
                     [("talus_r", "X Y Z"), ("calcn_r", "X Y Z")]),
        _measurement("toes_r",
                     "RCAL", "RTOE",
                     [("toes_r", "X Y Z")]),
        # ── 左大腿 ────────────────────────────────────────────────
        _measurement("femur_l",
                     "LHJC", "LLFC",
                     [("femur_l", "X Y Z")]),
        # ── 左下腿 ────────────────────────────────────────────────
        _measurement("tibia_l",
                     "LLFC", "LLMAL",
                     [("tibia_l", "X Y Z"), ("patella_l", "X Y Z")]),
        # ── 左足部 ────────────────────────────────────────────────
        _measurement("calcn_l",
                     "LLMAL", "LCAL",
                     [("talus_l", "X Y Z"), ("calcn_l", "X Y Z")]),
        _measurement("toes_l",
                     "LCAL", "LTOE",
                     [("toes_l", "X Y Z")]),
        # ── 体幹 ──────────────────────────────────────────────────
        _measurement("torso",
                     "RHJC", "RACR",
                     [("torso", "X Y Z")]),
        # ── 右上腕 ────────────────────────────────────────────────
        _measurement("humerus_r",
                     "RACR", "RLEL",
                     [("humerus_r", "X Y Z")]),
        # ── 右前腕 ────────────────────────────────────────────────
        _measurement("radius_r",
                     "RLEL", "RFAradius",
                     [("radius_r", "X Y Z"), ("ulna_r", "X Y Z")]),
        # ── 右手 ──────────────────────────────────────────────────
        _measurement("hand_r",
                     "RFAradius", "RFAulna",
                     [("hand_r", "X Y Z")]),
        # ── 左上腕 ────────────────────────────────────────────────
        _measurement("humerus_l",
                     "LACR", "LLEL",
                     [("humerus_l", "X Y Z")]),
        # ── 左前腕 ────────────────────────────────────────────────
        _measurement("radius_l",
                     "LLEL", "LFAradius",
                     [("radius_l", "X Y Z"), ("ulna_l", "X Y Z")]),
        # ── 左手 ──────────────────────────────────────────────────
        _measurement("hand_l",
                     "LFAradius", "LFAulna",
                     [("hand_l", "X Y Z")]),
    ])

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- Scale Setup - MotionDigitizer生成 ({datetime.now().strftime('%Y-%m-%d %H:%M')}) -->
<OpenSimDocument Version="40000">
    <ScaleTool name="subject">
        <mass>{subject_mass}</mass>
        <height>-1</height>
        <age>-1</age>
        <GenericModelMaker>
            <model_file>{os.path.abspath(osim_path)}</model_file>
        </GenericModelMaker>
        <ModelScaler>
            <apply>true</apply>
            <scaling_order> measurements </scaling_order>
            <MeasurementSet>
                <objects>
{measurements}
                </objects>
                <groups />
            </MeasurementSet>
            <marker_file>{os.path.abspath(static_trc)}</marker_file>
            <time_range>{time_start} {time_end}</time_range>
            <output_scale_file>subject_scale_factors.xml</output_scale_file>
        </ModelScaler>
        <MarkerPlacer>
            <apply>true</apply>
            <marker_file>{os.path.abspath(static_trc)}</marker_file>
            <time_range>{time_start} {time_end}</time_range>
            <output_motion_file>static_ik.mot</output_motion_file>
            <output_model_file>{os.path.abspath(output_scaled_osim)}</output_model_file>
            <max_marker_movement>-1</max_marker_movement>
        </MarkerPlacer>
    </ScaleTool>
</OpenSimDocument>
"""
    with open(output_xml, 'w', encoding='utf-8') as f:
        f.write(xml)
    print(f"✓ Scale Setup XML: {output_xml}")
    return output_xml


def generate_ik_setup(scaled_osim, dynamic_trc, output_mot,
                      time_start, time_end, marker_names,
                      output_xml='Setup_IK.xml'):
    marker_tasks = ""
    for name in sorted(marker_names):
        weight = IK_WEIGHTS.get(name, DEFAULT_WEIGHT)
        marker_tasks += (
            f'            <IKMarkerTask name="{name}">\n'
            f'                <apply>true</apply>\n'
            f'                <weight>{weight}</weight>\n'
            f'            </IKMarkerTask>\n'
        )

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- IK Setup - MotionDigitizer生成 ({datetime.now().strftime('%Y-%m-%d %H:%M')}) -->
<OpenSimDocument Version="40000">
    <InverseKinematicsTool name="IK">
        <model_file>{os.path.abspath(scaled_osim)}</model_file>
        <time_range>{time_start} {time_end}</time_range>
        <marker_file>{os.path.abspath(dynamic_trc)}</marker_file>
        <output_motion_file>{os.path.abspath(output_mot)}</output_motion_file>
        <report_errors>true</report_errors>
        <report_marker_locations>false</report_marker_locations>
        <IKTaskSet>
            <objects>
{marker_tasks}            </objects>
        </IKTaskSet>
    </InverseKinematicsTool>
</OpenSimDocument>
"""
    with open(output_xml, 'w', encoding='utf-8') as f:
        f.write(xml)
    print(f"✓ IK Setup XML: {output_xml}")
    return output_xml


# =============================================================================
# CLI
# =============================================================================
def get_arg(args: "list[str]", flag: str, default: "str | None" = None) -> "str | None":
    if flag in args:
        idx = args.index(flag)
        if idx + 1 < len(args):
            return args[idx + 1]
    return default


def main() -> None:
    # sys.argv[1:] のスライスはチェッカーバグを踏むため list() + 手動スキップ
    all_argv: list[str] = list(sys.argv)
    args: list[str] = [v for i, v in enumerate(all_argv) if i >= 1]
    if not args:
        print(USAGE)
        return

    cmd = args[0]

    if cmd == 'check':
        osim = get_arg(args, '--osim')
        if not osim:
            print("使い方: python opensim_toolkit.py check --osim モデル.osim")
            return
        check_model_markers(osim)

    elif cmd == 'convert':
        input_trc  = get_arg(args, '--trc')
        output_trc = get_arg(args, '--out')
        if not input_trc or not output_trc:
            print("使い方: python opensim_toolkit.py convert --trc 入力.trc --out 出力.trc")
            return
        convert_trc_marker_names(str(input_trc), str(output_trc))

    elif cmd == 'all':
        osim    = get_arg(args, '--osim')
        static  = get_arg(args, '--static')
        dynamic = get_arg(args, '--dynamic')
        mass    = float(get_arg(args, '--mass', '60') or '60')

        if not osim or not static or not dynamic:
            print("使い方: python opensim_toolkit.py all "
                  "--osim モデル.osim --static static.trc --dynamic motion.trc --mass 60")
            return

        osim_s:    str = str(osim)
        static_s:  str = str(static)
        dynamic_s: str = str(dynamic)

        model_markers, matched, _ = check_model_markers(osim_s)

        base_s     = os.path.splitext(static_s)[0]
        static_out = base_s + '_converted.trc'
        base_d      = os.path.splitext(dynamic_s)[0]
        dynamic_out = base_d + '_converted.trc'

        new_names = convert_trc_marker_names(
            static_s, static_out, MARKER_MAP, model_markers)
        convert_trc_marker_names(
            dynamic_s, dynamic_out, MARKER_MAP, model_markers)

        trc_s = read_trc(static_out)
        t_end_s = float(f"{(trc_s['num_frames'] - 1) / trc_s['data_rate']:.6f}")
        generate_scale_setup(osim_s, static_out, 'subject_scaled.osim',
                              mass, 0.0, t_end_s)

        trc_d = read_trc(dynamic_out)
        t_end_d = float(f"{(trc_d['num_frames'] - 1) / trc_d['data_rate']:.6f}")
        generate_ik_setup('subject_scaled.osim', dynamic_out, 'ik_results.mot',
                          0.0, t_end_d, new_names)

        print(f"\n{'='*60}")
        print("完了! OpenSimでの実行手順:")
        print("  1. Tools > Scale Model > Load: Setup_Scale.xml > Run")
        print("     → subject_scaled.osim が生成される")
        print("  2. Tools > Inverse Kinematics > Load: Setup_IK.xml > Run")
        print("     → ik_results.mot が生成される")
        print(f"{'='*60}")

    else:
        print(f"不明なコマンド: {cmd}")
        print(USAGE)


if __name__ == '__main__':
    main()
