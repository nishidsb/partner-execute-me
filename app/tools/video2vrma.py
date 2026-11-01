# -*- coding: utf-8 -*-
"""真人视频 → VRMA 一键管线（video2vrma）
用法:
  py -3.13 tools/video2vrma.py <video.(mp4|mov|...)> <out.vrma> [--stride 2] [--smooth 0.55] [--hip-y 1.0] [--keep-root] [--flipx] [--flipz] [--fps 30]

三段:
  1. video2pose.py   视频 → MediaPipe 33 点姿态 JSON（帧采样 stride 减负）
  2. pose2vrma.js    JSON → kalidokit 求解骨骼 euler → 直接写 VRMA（GLB/VRMC_vrm_animation）
  3. check-pose2vrma.js  离屏渲染 4 帧关键帧到 captures/ 供肉眼验收

可选参数透传给 pose2vrma.js；--stride 2 = 每 2 帧取 1（30fps 视频变 15fps 采样，
动作平滑度略降、速度不变）。产出 VRMA 丢进 %APPDATA%/ryza-assistant-app/motions/
文件名即动作词（例: 手舞.vrma → 说【手舞】触发）。
"""
import subprocess
import sys
import os

PY = sys.executable
HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    video, out = args[0], args[1]
    rest = args[2:]

    stride = '2'
    if '--stride' in rest:
        i = rest.index('--stride')
        stride = rest[i + 1]
        del rest[i:i + 2]

    pose_json = out + '.pose.json'
    print('== 1/3 提取姿态 ==', flush=True)
    r = subprocess.run([PY, os.path.join(HERE, 'video2pose.py'), video, pose_json, stride])
    if r.returncode:
        sys.exit(r.returncode)

    print('== 2/3 转换 VRMA ==', flush=True)
    r = subprocess.run(['node', os.path.join(HERE, 'pose2vrma.js'), pose_json, out] + rest)
    if r.returncode:
        sys.exit(r.returncode)

    print('== 3/3 渲染验收帧 ==', flush=True)
    prefix = os.path.splitext(os.path.basename(out))[0]
    import shutil
    npx = shutil.which('npx') or 'npx'
    r = subprocess.run([npx, 'electron', os.path.join(HERE, 'check-pose2vrma.js'), out, prefix, '4'],
                       cwd=os.path.dirname(HERE))
    sys.exit(r.returncode)


if __name__ == '__main__':
    main()
