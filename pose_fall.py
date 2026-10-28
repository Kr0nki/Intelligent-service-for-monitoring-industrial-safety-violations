"""
Определение падения по позе человека (YOLOv8-pose, ключевые точки скелета).

Идея: у стоящего человека линия «середина бёдер → середина плеч» почти вертикальна,
у лежащего — почти горизонтальна. Меряем угол этой линии от вертикали:
  угол > FALL_ANGLE (по умолчанию 60°) -> человек лежит.
Это лучше, чем сравнивать высоты в пикселях (порог 40 px зависит от разрешения и расстояния до человека).

Дополнительно:
  * проверяется каждый человек в кадре, а не только первый;
  * точки с низкой уверенностью (< KPT_CONF) не учитываются;
  * тревога только если «лежит» подряд в нескольких кадрах (CONFIRM_FRAMES) — иначе ложные срабатывания на наклоне.

Нужны: pip install ultralytics  и файл yolov8n-pose.pt рядом с main.py
(если файла нет, ultralytics скачает его сам при первом запуске — нужен интернет).
"""
from collections import deque

import numpy as np

L_SHOULDER, R_SHOULDER, L_HIP, R_HIP = 5, 6, 11, 12

FALL_ANGLE = 60.0       # угол торса от вертикали, градусов: больше — считаем, что человек лежит
KPT_CONF = 0.3          # минимальная уверенность ключевой точки
CONFIRM_FRAMES = 2      # сколько кадров подряд должно быть «лежит»
HISTORY = 3             # из скольких последних кадров считаем (нужно CONFIRM_FRAMES подтверждений)


def _mid(kpts, a, b):
    """Середина двух точек (учитываем только уверенные). -> (x, y) или None"""
    pts = [kpts[i][:2] for i in (a, b) if kpts[i][2] >= KPT_CONF]
    if not pts:
        return None
    return np.mean(pts, axis=0)


def torso_angle(kpts):
    """Угол торса от вертикали в градусах (0 — стоит, 90 — лежит). None, если точек не хватает."""
    shoulders = _mid(kpts, L_SHOULDER, R_SHOULDER)
    hips = _mid(kpts, L_HIP, R_HIP)
    if shoulders is None or hips is None:
        return None
    dx, dy = abs(shoulders[0] - hips[0]), abs(shoulders[1] - hips[1])
    if dx + dy < 1e-6:
        return None
    return float(np.degrees(np.arctan2(dx, dy)))


def lying_people(keypoints, boxes_xyxy, boxes_conf):
    """keypoints: [N,17,3] (x, y, conf); boxes: [N,4] xyxy, [N]. -> [(conf, [x, y, w, h])] тех, кто лежит."""
    out = []
    for kp, box, bc in zip(keypoints, boxes_xyxy, boxes_conf):
        ang = torso_angle(kp)
        if ang is not None and ang >= FALL_ANGLE:
            x1, y1, x2, y2 = [float(v) for v in box]
            # уверенность: уверенность детекции человека, плавно растёт с углом (60° -> ~0.7, 90° -> 1.0)
            conf = float(bc) * min(1.0, 0.7 + 0.3 * (ang - FALL_ANGLE) / (90.0 - FALL_ANGLE))
            out.append((round(min(conf, 0.999), 3), [int(x1), int(y1), int(x2 - x1), int(y2 - y1)]))
    return out


def _to_numpy(x):
    return np.asarray(x.cpu().numpy() if hasattr(x, "cpu") else x)


class PoseFallDetector:
    def __init__(self, weights: str = "yolov8n-pose.pt"):
        from ultralytics import YOLO          # импорт здесь, чтобы без ultralytics сервер всё равно стартовал
        self.model = YOLO(weights)
        self.histories = {}                   # камера -> были ли лежащие люди в последних кадрах

    def detect(self, frame, conf: float = 0.4, camera=None):
        """-> [(conf, [x, y, w, h])] в пикселях исходного кадра; пусто, если падение не подтверждено.
        camera — номер камеры: подтверждение «по нескольким кадрам подряд» считается для каждой камеры отдельно."""
        r = self.model(frame, conf=conf, verbose=False)[0]
        found = []
        if r.keypoints is not None and r.boxes is not None and len(r.boxes):
            found = lying_people(_to_numpy(r.keypoints.data), _to_numpy(r.boxes.xyxy), _to_numpy(r.boxes.conf))
        history = self.histories.setdefault(camera, deque(maxlen=HISTORY))
        history.append(bool(found))
        if sum(history) >= CONFIRM_FRAMES and found:
            return found
        return []