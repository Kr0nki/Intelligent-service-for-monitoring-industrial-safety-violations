"""
Инференс YOLO (Ultralytics) из .onnx через onnxruntime — без torch и ultralytics.

Подходит любая детекционная модель Ultralytics, экспортированная в ONNX
(helmet/no_helmet, fall и т.д.): названия классов и размер входа читаются
из самого файла. Поддержаны оба вида выхода:
  * обычный   [1, 4+N, 8400]  (cx, cy, w, h + оценки N классов) — NMS делаем здесь;
  * end2end   [1, K, 6]       (x1, y1, x2, y2, conf, class) — NMS уже внутри модели.

detect() возвращает bbox в пикселях ИСХОДНОГО кадра в формате [x, y, w, h].
"""
import ast

import cv2
import numpy as np
import onnxruntime as ort


class OnnxDetector:
    def __init__(self, path: str, nms_iou: float = 0.45):
        # CPUExecutionProvider есть всегда; CUDA подхватится сам, если стоит onnxruntime-gpu
        providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
                     if p in ort.get_available_providers()]
        self.session = ort.InferenceSession(path, providers=providers)
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        self.imgsz = inp.shape[2] if isinstance(inp.shape[2], int) else 640
        self.nms_iou = nms_iou

        meta = self.session.get_modelmeta().custom_metadata_map
        try:
            self.names = {int(k): v for k, v in ast.literal_eval(meta["names"]).items()}
        except Exception:
            self.names = {}
        self.end2end = str(meta.get("end2end", "False")) == "True"
        self.last_max = {}      # лучшая оценка каждого класса до порогов (для отладки)

    def _preprocess(self, frame: np.ndarray):
        """Letterbox как в Ultralytics: масштаб с сохранением пропорций, серые поля 114."""
        h, w = frame.shape[:2]
        r = min(self.imgsz / h, self.imgsz / w)
        nw, nh = round(w * r), round(h * r)
        img = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
        top, left = round((self.imgsz - nh) / 2 - 0.1), round((self.imgsz - nw) / 2 - 0.1)
        canvas = np.full((self.imgsz, self.imgsz, 3), 114, np.uint8)
        canvas[top:top + nh, left:left + nw] = img
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)            # BGR->RGB, HWC->CHW
        blob = np.ascontiguousarray(blob[None], dtype=np.float32) / 255.0
        return blob, r, left, top

    def detect(self, frame: np.ndarray, conf: float = 0.4):
        """-> [(class_id, conf, [x, y, w, h]), ...] в пикселях исходного кадра"""
        h0, w0 = frame.shape[:2]
        blob, r, left, top = self._preprocess(frame)
        out = self.session.run(None, {self.input_name: blob})[0][0]

        if self.end2end or (out.ndim == 2 and out.shape[1] == 6 and out.shape[0] != 6):
            return self._decode_end2end(out, conf, r, left, top, w0, h0)

        out = out.T                                              # (8400, 4+N)
        scores = out[:, 4:]
        self.last_max = {self.names.get(i, str(i)): round(float(v), 3)
                         for i, v in enumerate(scores.max(0))}
        cls = scores.argmax(1)
        confs = scores[np.arange(len(scores)), cls]
        keep = confs >= conf
        if not keep.any():
            return []
        out, cls, confs = out[keep], cls[keep], confs[keep]

        x = (out[:, 0] - out[:, 2] / 2 - left) / r
        y = (out[:, 1] - out[:, 3] / 2 - top) / r
        x1, y1 = np.clip(x, 0, w0), np.clip(y, 0, h0)
        x2, y2 = np.clip(x + out[:, 2] / r, 0, w0), np.clip(y + out[:, 3] / r, 0, h0)

        results = []
        for c in np.unique(cls):                                 # NMS отдельно по каждому классу
            idx = np.where(cls == c)[0]
            boxes = [[float(x1[i]), float(y1[i]), float(x2[i] - x1[i]), float(y2[i] - y1[i])] for i in idx]
            kept = cv2.dnn.NMSBoxes(boxes, confs[idx].astype(float).tolist(), conf, self.nms_iou)
            for k in np.array(kept).flatten():
                i = idx[int(k)]
                results.append((int(c), float(confs[i]),
                                [int(x1[i]), int(y1[i]), int(x2[i] - x1[i]), int(y2[i] - y1[i])]))
        return results

    def _decode_end2end(self, out, conf, r, left, top, w0, h0):
        self.last_max = {}
        results = []
        for x1, y1, x2, y2, c, k in out:
            self.last_max[self.names.get(int(k), str(int(k)))] = max(
                self.last_max.get(self.names.get(int(k), str(int(k))), 0.0), round(float(c), 3))
            if c < conf:
                continue
            x1, x2 = np.clip([(x1 - left) / r, (x2 - left) / r], 0, w0)
            y1, y2 = np.clip([(y1 - top) / r, (y2 - top) / r], 0, h0)
            results.append((int(k), float(c), [int(x1), int(y1), int(x2 - x1), int(y2 - y1)]))
        return results
