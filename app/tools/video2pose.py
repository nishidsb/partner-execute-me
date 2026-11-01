# -*- coding: utf-8 -*-
"""真人视频 → MediaPipe 姿态 JSON（video2vrma 第一段，mediapipe 1.x Tasks API）
跑法: py -3.13 tools/video2pose.py <video.mp4> <out.json> [每N帧取1帧]
模型: tools/pose_landmarker_full.task（已随仓库就位）
输出: {fps, frames:[{t, world:[{x,y,z,visibility}x33], screen:[...x33]}]}
注意: world landmarks 的 visibility 附 screen 的（kalidokit offscreen 判定依赖它）。
"""
import sys
import json
import os


def main():
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    if len(sys.argv) < 3:
        print('用法: py -3.13 tools/video2pose.py <video> <out.json> [stride]')
        sys.exit(2)
    video_path, out_path = sys.argv[1], sys.argv[2]
    stride = int(sys.argv[3]) if len(sys.argv) > 3 else 1

    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pose_landmarker_full.task')
    base = mp_python.BaseOptions(model_asset_path=model_path)
    opts = vision.PoseLandmarkerOptions(
        base_options=base,
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print('打不开视频: ' + video_path)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    frames = []
    idx = 0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    with vision.PoseLandmarker.create_from_options(opts) as detector:
        while True:
            ok, img = cap.read()
            if not ok:
                break
            if idx % stride == 0:
                rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                mpi = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                res = detector.detect_for_video(mpi, int(round(idx * 1000 / fps)))
                if res.pose_world_landmarks and res.pose_landmarks:
                    wl = list(res.pose_world_landmarks[0])
                    sl = list(res.pose_landmarks[0])
                    world = [{'x': p.x, 'y': p.y, 'z': p.z, 'visibility': s.visibility} for p, s in zip(wl, sl)]
                    screen = [{'x': p.x, 'y': p.y, 'z': p.z, 'visibility': p.visibility} for p in sl]
                    frames.append({'t': idx / fps, 'world': world, 'screen': screen})
            idx += 1
            if idx % 100 == 0:
                print('进度 %d/%d 帧' % (idx, total or -1), flush=True)
    cap.release()

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'fps': fps / stride, 'sourceFps': fps, 'stride': stride, 'frames': frames}, f)
    print('帧数=%d (采样后 fps=%.2f) → %s' % (len(frames), fps / stride, out_path))


if __name__ == '__main__':
    main()
