"""
Backend для детекции нарушений (каски) — FastAPI + OpenCV + YOLO + WebSocket.

Установка:
    pip install fastapi "uvicorn[standard]" opencv-python python-multipart onnxruntime ultralytics
    (ultralytics нужен для определения падения по позе; без него падение определит fall.onnx)

Запуск:
    uvicorn main:app --reload |или| py -m uvicorn main:app --reload
    -> http://127.0.0.1:8000/docs

Формат bbox везде: [x, y, w, h] (x, y — левый верхний угол, в пикселях).
Договорись с фронтендом, что именно такой формат, и не меняй его потом.
"""
import asyncio
import json
import os
import tempfile
import time

import rtsp_stream            # RTSP-камеры; импортируем ДО cv2: он задаёт параметры FFmpeg для OpenCV

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# ---------------------------------------------------------------- настройки
BASE_DIR = os.path.dirname(os.path.abspath(__file__))   # файлы модели ищем рядом с main.py

USE_MOCK = False                # True — фейковые данные; False — настоящая модель
BACKEND = "onnx"                # "onnx" (best.onnx, без torch) | "yolo" (best.pt, нужен ultralytics) | "linq"
MODEL_PATH = os.path.join(BASE_DIR, "best.pt")      # веса от CV-инженера
# Список ONNX-моделей: запускаются все по очереди, результаты объединяются.
# Можно одну общую модель (каска + падение) или отдельные: каска и падение.
# Для LinQ тоже нужен ONNX: yolo export model=best.pt format=onnx
ONNX_PATHS = [
    os.path.join(BASE_DIR, "best.onnx"),      # каска: helmet / no_helmet
]
FALL_ONNX_PATH = os.path.join(BASE_DIR, "fall.onnx")   # модель падения (запасной вариант)

# Как определять падение:
#   "pose" — по позе человека (yolov8n-pose + угол торса), нужен ultralytics; точнее на крупных планах
#   "onnx" — моделью fall.onnx
# Если "pose" не удалось загрузить (нет ultralytics), сервер сам переключится на fall.onnx.
FALL_MODE = "pose"
POSE_WEIGHTS = os.path.join(BASE_DIR, "yolov8n-pose.pt")   # нет файла — ultralytics скачает сам
CONF_THRESHOLD = 0.4
DEBUG = True                    # печатать в терминал, что модель видит на каждом кадре
# Нарушение — любой класс, в названии которого есть одно из этих слов (no_helmet, fall, person_fall...).
# Остальные классы (helmet, person, standing...) считаются нормой и на сайт не отправляются.
VIOLATION_KEYWORDS = ("no_helmet", "fall")
VIDEO_FRAME_STEP = 10           # при загрузке видео берём каждый N-й кадр

app = FastAPI(title="Helmet Violation Detector")

# Чтобы фронтенд с другого порта мог обращаться к API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- инференс
_model = None


def _get_yolo():
    """Модель грузится один раз, при первом вызове."""
    global _model
    if _model is None:
        from ultralytics import YOLO
        _model = YOLO(MODEL_PATH)
    return _model


_onnx = None


_pose = None
_pose_failed = False


def _get_pose():
    """Детектор падения по позе или None, если он не загрузился (тогда работает fall.onnx)."""
    global _pose, _pose_failed
    if FALL_MODE != "pose" or _pose_failed:
        return None
    if _pose is None:
        try:
            from pose_fall import PoseFallDetector
            weights = POSE_WEIGHTS if os.path.exists(POSE_WEIGHTS) else "yolov8n-pose.pt"
            _pose = PoseFallDetector(weights)
            print("[модель] падение: по позе человека (yolov8n-pose)")
        except Exception as e:
            _pose_failed = True
            print(f"[модель] поза недоступна ({type(e).__name__}: {e}) — падение определяет fall.onnx")
            return None
    return _pose


def _get_onnx() -> list:
    """Загружает все существующие ONNX-модели (один раз)."""
    global _onnx
    if _onnx is None:
        from onnx_infer import OnnxDetector
        _onnx = []
        paths = list(ONNX_PATHS)
        if _get_pose() is None:          # позы нет — падение определяет fall.onnx
            paths.append(FALL_ONNX_PATH)
        for path in paths:
            if os.path.exists(path):
                _onnx.append(OnnxDetector(path))
                print(f"[модель] загружена {os.path.basename(path)}: классы {_onnx[-1].names}")
            else:
                print(f"[модель] файл не найден, пропускаю: {os.path.basename(path)}")
        if not _onnx:
            raise FileNotFoundError("Не найдено ни одной ONNX-модели: " + ", ".join(ONNX_PATHS))
    return _onnx


# Названия классов из моделей -> имена, которые понимает сайт (список можно дополнять)
CLASS_RENAME = {"fall-detected": "fall"}


def is_violation(name: str) -> bool:
    return any(k in name.lower() for k in VIOLATION_KEYWORDS)


def _onnx_inference(frame: np.ndarray, camera=None) -> list[dict]:
    detections = []
    pose = _get_pose()
    if pose is not None:
        for conf, bbox in pose.detect(frame, CONF_THRESHOLD, camera):
            detections.append({"violation": "fall", "bbox": bbox, "conf": round(conf, 3)})
    for det in _get_onnx():
        found = det.detect(frame, CONF_THRESHOLD)
        if DEBUG:
            h, w = frame.shape[:2]
            print(f"[кадр {w}x{h}] лучшая уверенность по классам: {getattr(det, 'last_max', '?')} | найдено после порога {CONF_THRESHOLD}: {len(found)}")
        for cls_id, conf, bbox in found:
            name = det.names.get(cls_id, str(cls_id))
            name = CLASS_RENAME.get(name.lower(), name)
            if is_violation(name):
                detections.append({"violation": name, "bbox": bbox, "conf": round(conf, 3)})
    return detections


def _mock_inference(frame: np.ndarray) -> list[dict]:
    return [{"violation": "no_helmet", "bbox": [100, 150, 50, 50], "conf": 0.9}]


def _yolo_inference(frame: np.ndarray) -> list[dict]:
    result = _get_yolo()(frame, conf=CONF_THRESHOLD, verbose=False)[0]
    detections = []
    for box in result.boxes:
        name = result.names[int(box.cls[0])]
        if not is_violation(name):
            continue
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        detections.append({
            "violation": name,
            "bbox": [int(x1), int(y1), int(x2 - x1), int(y2 - y1)],
            "conf": round(float(box.conf[0]), 3),
        })
    return detections


def _linq_inference(frame: np.ndarray) -> list[dict]:
    # TODO: сюда вызов LinQ. Должен вернуть тот же формат:
    # [{"violation": "no_helmet", "bbox": [x, y, w, h], "conf": 0.9}]
    raise NotImplementedError("LinQ ещё не подключён")


def run_inference(frame: np.ndarray, camera=None) -> list[dict]:
    """Единственная точка входа в модель. Меняй только её внутренности.
    camera — номер камеры (нужен, чтобы подтверждение падения по нескольким кадрам считалось отдельно для каждой)."""
    if USE_MOCK:
        return _mock_inference(frame)
    if BACKEND == "linq":
        return _linq_inference(frame)
    if BACKEND == "onnx":
        return _onnx_inference(frame, camera)
    return _yolo_inference(frame)


def decode_frame(data: bytes) -> np.ndarray | None:
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)


# ---------------------------------------------------------------- HTTP
@app.get("/hello")
def hello():
    return {"message": "hello"}


@app.get("/info")
def info():
    """Что сейчас крутится: удобно проверять, что включена настоящая модель, а не заглушка."""
    return {"mock": USE_MOCK, "backend": BACKEND, "conf_threshold": CONF_THRESHOLD,
            "violation_keywords": list(VIOLATION_KEYWORDS)}


@app.get("/mock/detect")
def mock_detect():
    """Чистая заглушка без зависимостей — для фронтенда."""
    return {"violation": "no_helmet", "bbox": [100, 150, 50, 50]}


@app.post("/detect/image")
async def detect_image(file: UploadFile = File(...)):
    """Один кадр (jpg/png) -> список нарушений + задержка."""
    frame = decode_frame(await file.read())
    if frame is None:
        return {"error": "не удалось прочитать изображение"}
    t0 = time.perf_counter()
    detections = await asyncio.to_thread(run_inference, frame)
    return {
        "detections": detections,
        "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
    }


def _process_video(path: str) -> dict:
    cap = cv2.VideoCapture(path)
    results, idx = [], 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % VIDEO_FRAME_STEP == 0:
            for d in run_inference(frame):
                results.append({"frame": idx, **d})
        idx += 1
    cap.release()
    return {"frames_total": idx, "detections": results}


@app.post("/detect/video")
async def detect_video(file: UploadFile = File(...)):
    """Загрузка видеофайла целиком -> нарушения по кадрам."""
    suffix = os.path.splitext(file.filename or "")[1] or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    try:
        return await asyncio.to_thread(_process_video, path)
    finally:
        os.remove(path)


# ---------------------------------------------------------------- RTSP-камеры
# Браузер не играет rtsp://, поэтому сервер читает камеру сам и отдаёт сайту MJPEG-поток.
# Порядок для сайта: /rtsp/test (проверить) -> /rtsp/register (получить id) -> <img src=".../rtsp/stream/{id}">
class RtspBody(BaseModel):
    url: str


@app.post("/rtsp/test")
async def rtsp_test(body: RtspBody):
    """Проверка камеры из «Настроек»: подключиться и прочитать один кадр."""
    result = await asyncio.to_thread(rtsp_stream.probe, body.url)
    if not result["ok"]:
        print(f"[RTSP] проверка {rtsp_stream.mask_url(body.url)}: {result['error']}")
    return result


@app.post("/rtsp/register")
def rtsp_register(body: RtspBody):
    """Запомнить адрес камеры (с паролем) на сервере и вернуть id — в ссылках на поток пароля нет."""
    try:
        cam_id = rtsp_stream.register(body.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"id": cam_id, "stream": f"/rtsp/stream/{cam_id}", "status": f"/rtsp/status/{cam_id}"}


@app.get("/rtsp/stream/{cam_id}")
async def rtsp_mjpeg(cam_id: str):
    """MJPEG-поток камеры: в браузере его показывает обычный <img src="...">."""
    if not rtsp_stream.is_registered(cam_id):
        raise HTTPException(status_code=404, detail="камера не зарегистрирована (сервер перезапускался?)")
    return StreamingResponse(
        rtsp_stream.mjpeg_frames(cam_id),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/rtsp/status/{cam_id}")
def rtsp_status(cam_id: str):
    """Есть ли сейчас сигнал от камеры."""
    st = rtsp_stream.status(cam_id)
    if st is None:
        raise HTTPException(status_code=404, detail="камера не зарегистрирована")
    return st


# ---------------------------------------------------------------- WebSocket
@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    """
    Клиент шлёт бинарные JPEG-кадры, сервер отвечает JSON на каждый:
    {"detections": [...], "latency_ms": 42.1, "camera": 3}

    Камер может быть несколько (до 9) в одном соединении: ПЕРЕД кадром клиент шлёт
    короткое текстовое сообщение {"camera": 3}, и сервер знает, чей это кадр.
    Без такого сообщения всё работает как раньше (камера не указана).
    """
    await ws.accept()
    camera = None
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break

            text = message.get("text")
            if text is not None:                      # {"camera": N}
                try:
                    cam = json.loads(text).get("camera")
                    camera = int(cam) if cam is not None else None
                except (ValueError, TypeError, AttributeError):
                    pass
                continue

            data = message.get("bytes")
            if not data:
                continue

            reply_cam = {"camera": camera} if camera is not None else {}
            frame = decode_frame(data)
            if frame is None:
                await ws.send_json({"error": "bad frame", **reply_cam})
                continue
            t0 = time.perf_counter()
            try:
                detections = await asyncio.to_thread(run_inference, frame, camera)
            except Exception as e:      # ошибка модели не должна рвать соединение с сайтом
                print(f"[ОШИБКА инференса] {type(e).__name__}: {e}")
                await ws.send_json({"error": f"{type(e).__name__}: {e}", **reply_cam})
                continue
            await ws.send_json({
                "detections": detections,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
                **reply_cam,
            })
    except (WebSocketDisconnect, RuntimeError):
        pass