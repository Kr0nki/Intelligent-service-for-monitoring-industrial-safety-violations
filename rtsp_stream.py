"""
Подключение IP-камер по RTSP: сервер сам читает поток и отдаёт его браузеру как MJPEG
(браузеры не умеют играть rtsp:// напрямую).

Как это устроено:
  * сайт регистрирует адрес камеры (register) и получает короткий id — сам адрес с паролем
    в ссылках и логах сервера больше не светится;
  * на каждую камеру работает ОДИН поток-читалка (RtspReader), сколько бы вкладок ни смотрело;
  * читалка сама переподключается, если камера пропала, и сама останавливается, когда смотреть некому.

Нужен только opencv-python (FFmpeg уже внутри него). Внешний ffmpeg не требуется.
Транспорт по умолчанию TCP (стабильнее UDP); поменять: переменная окружения RTSP_TRANSPORT=udp.
"""
import asyncio
import hashlib
import os
import threading
import time
from urllib.parse import urlsplit, urlunsplit

# Параметры для FFmpeg внутри OpenCV — задаются ДО импорта cv2
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", f"rtsp_transport;{os.environ.get('RTSP_TRANSPORT', 'tcp')}")

import cv2  # noqa: E402

# ---------------------------------------------------------------- настройки
MAX_FPS = 10              # сколько кадров в секунду отдавать в браузер (остальные пропускаем)
MAX_WIDTH = 1280          # кадры шире уменьшаем — меньше трафика и нагрузки
JPEG_QUALITY = 70
OPEN_TIMEOUT_MS = 6000    # сколько ждать подключения к камере
READ_TIMEOUT_MS = 6000    # сколько ждать очередного кадра
RECONNECT_DELAY = 3.0     # пауза перед повторным подключением, сек
IDLE_STOP_SEC = 15.0      # через сколько секунд без зрителей читалка останавливается
ONLINE_MAX_AGE = 5.0      # кадр старше этого — камера считается «нет сигнала»
MAX_CAMERAS = 64          # сколько разных адресов можно зарегистрировать

ALLOWED_SCHEMES = ("rtsp", "rtsps")

_lock = threading.Lock()
_registry: dict[str, str] = {}          # id -> адрес камеры (только в памяти)
_readers: dict[str, "RtspReader"] = {}  # id -> работающая читалка


# ---------------------------------------------------------------- адреса
def check_url(url: str) -> str:
    """Проверяет, что это rtsp://хост/...; возвращает очищенный адрес или бросает ValueError."""
    url = (url or "").strip()
    try:
        parts = urlsplit(url)
        host = parts.hostname
        parts.port  # noqa: B018  (бросит ValueError при кривом порте)
    except ValueError:
        raise ValueError("Некорректный адрес. Пример: rtsp://логин:пароль@192.168.1.10:554/stream1")
    if parts.scheme.lower() not in ALLOWED_SCHEMES or not host:
        raise ValueError("Адрес должен начинаться с rtsp:// и содержать IP или имя камеры")
    return url


def mask_url(url: str) -> str:
    """rtsp://admin:12345@host/x -> rtsp://admin:***@host/x (для логов и сообщений)."""
    try:
        parts = urlsplit(url)
        if parts.password:
            host = parts.hostname or ""
            if ":" in host:
                host = f"[{host}]"
            netloc = f"{parts.username or ''}:***@{host}" + (f":{parts.port}" if parts.port else "")
            return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    except ValueError:
        pass
    return url


def register(url: str) -> str:
    """Запоминает адрес камеры, возвращает короткий id (один и тот же адрес — один и тот же id)."""
    url = check_url(url)
    cam_id = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    with _lock:
        if cam_id not in _registry and len(_registry) >= MAX_CAMERAS:
            raise ValueError("Слишком много разных камер зарегистрировано")
        _registry[cam_id] = url
    return cam_id


def is_registered(cam_id: str) -> bool:
    with _lock:
        return cam_id in _registry


# ---------------------------------------------------------------- открытие потока
def open_capture(url: str):
    """VideoCapture с таймаутами (если эта сборка OpenCV их поддерживает)."""
    params = [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MS, cv2.CAP_PROP_READ_TIMEOUT_MSEC, READ_TIMEOUT_MS]
    try:
        return cv2.VideoCapture(url, cv2.CAP_FFMPEG, params)
    except (TypeError, cv2.error):
        return cv2.VideoCapture(url, cv2.CAP_FFMPEG)


def probe(url: str) -> dict:
    """Проверка камеры: подключиться и прочитать один кадр. Блокирующая — вызывать в потоке."""
    try:
        url = check_url(url)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    cap = open_capture(url)
    try:
        if not cap.isOpened():
            return {"ok": False, "error": "Не удалось подключиться: проверьте адрес, логин/пароль, порт и что камера доступна с сервера"}
        for _ in range(10):
            ok, frame = cap.read()
            if ok and frame is not None:
                h, w = frame.shape[:2]
                return {"ok": True, "width": int(w), "height": int(h)}
            time.sleep(0.1)
        return {"ok": False, "error": "Камера ответила, но кадры не приходят (проверьте путь потока и кодек)"}
    finally:
        cap.release()


# ---------------------------------------------------------------- читалка
class RtspReader:
    """Фоновый поток: читает камеру и держит последний кадр, уже закодированный в JPEG."""

    def __init__(self, cam_id: str, url: str):
        self.cam_id = cam_id
        self.url = url
        self.jpeg: bytes | None = None
        self.seq = 0                     # номер последнего кадра
        self.ts = 0.0                    # когда пришёл последний кадр
        self.size = (0, 0)
        self.error: str | None = None
        self.viewers = 0
        self.last_view = time.time()
        self.stopped = False
        self._thread = threading.Thread(target=self._run, name=f"rtsp-{cam_id}", daemon=True)

    def start(self):
        self._thread.start()

    # --- под _lock
    def _try_stop_if_idle(self) -> bool:
        with _lock:
            if self.viewers == 0 and time.time() - self.last_view > IDLE_STOP_SEC:
                self.stopped = True
                if _readers.get(self.cam_id) is self:
                    del _readers[self.cam_id]
                return True
        return False

    def _run(self):
        masked = mask_url(self.url)
        min_gap = 1.0 / MAX_FPS
        last_enc = 0.0
        try:
            while not self.stopped:
                if self._try_stop_if_idle():
                    return
                cap = open_capture(self.url)
                if not cap.isOpened():
                    cap.release()
                    self.error = "не удалось подключиться к камере"
                    print(f"[RTSP] {masked}: не удалось подключиться, повтор через {RECONNECT_DELAY:.0f} с")
                    time.sleep(RECONNECT_DELAY)
                    continue

                print(f"[RTSP] {masked}: подключено")
                bad = 0
                try:
                    while not self.stopped:
                        if not cap.grab():                       # grab читает и разбирает кадр, но пока не копирует
                            bad += 1
                            if bad >= 5:
                                break
                            time.sleep(0.05)
                            continue
                        bad = 0
                        now = time.time()
                        if now - last_enc < min_gap:             # лишние кадры пропускаем
                            continue
                        ok, frame = cap.retrieve()
                        if not ok or frame is None:
                            continue
                        h, w = frame.shape[:2]
                        if w > MAX_WIDTH:
                            frame = cv2.resize(frame, (MAX_WIDTH, round(h * MAX_WIDTH / w)), interpolation=cv2.INTER_AREA)
                        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                        if not ok:
                            continue
                        last_enc = now
                        self.size = (frame.shape[1], frame.shape[0])
                        self.jpeg = buf.tobytes()
                        self.ts = now
                        self.seq += 1
                        self.error = None
                        if self.viewers == 0 and self._try_stop_if_idle():
                            return
                finally:
                    cap.release()

                if not self.stopped:
                    self.error = "связь с камерой потеряна"
                    print(f"[RTSP] {masked}: связь потеряна, переподключение…")
                    time.sleep(RECONNECT_DELAY)
        except Exception as e:                                   # поток не должен умирать молча
            self.error = f"{type(e).__name__}: {e}"
            print(f"[RTSP] {masked}: ошибка {self.error}")
            with _lock:
                self.stopped = True
                if _readers.get(self.cam_id) is self:
                    del _readers[self.cam_id]

    def status(self) -> dict:
        age = (time.time() - self.ts) if self.ts else None
        return {
            "online": age is not None and age < ONLINE_MAX_AGE,
            "width": self.size[0], "height": self.size[1],
            "error": self.error,
        }


def _attach(cam_id: str) -> RtspReader:
    """Взять читалку для зрителя (запустить, если ещё не работает)."""
    with _lock:
        url = _registry.get(cam_id)
        if url is None:
            raise KeyError(cam_id)
        r = _readers.get(cam_id)
        if r is None or r.stopped:
            r = RtspReader(cam_id, url)
            _readers[cam_id] = r
            r.start()
        r.viewers += 1
        r.last_view = time.time()
        return r


def _detach(reader: RtspReader):
    with _lock:
        reader.viewers = max(0, reader.viewers - 1)
        reader.last_view = time.time()


def status(cam_id: str) -> dict | None:
    """None — такой камеры не регистрировали (сервер мог перезапуститься)."""
    with _lock:
        if cam_id not in _registry:
            return None
        r = _readers.get(cam_id)
    if r is None:
        return {"online": False, "width": 0, "height": 0, "error": None, "started": False}
    return {**r.status(), "started": True}


# ---------------------------------------------------------------- MJPEG для браузера
async def mjpeg_frames(cam_id: str):
    """Асинхронный генератор для StreamingResponse(media_type='multipart/x-mixed-replace; boundary=frame').
    Не завершается сам: пока камера недоступна, просто ждёт, а когда она вернётся — кадры пойдут дальше."""
    reader = _attach(cam_id)
    last_seq = -1
    try:
        while True:
            if reader.stopped:                       # читалка упала — берём новую
                _detach(reader)
                reader = _attach(cam_id)
                last_seq = -1
            if reader.seq == last_seq or reader.jpeg is None:
                await asyncio.sleep(0.03)
                continue
            last_seq = reader.seq
            jpg = reader.jpeg
            yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n"
                   + jpg + b"\r\n")
    finally:
        _detach(reader)
