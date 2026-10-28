/* =====================================================================
   monitor.js — страница «Монитор» (до 9 камер):
     • сетка камер 3×3; клик по плитке или по плашке «№ камеры» — камера на весь экран
     • видео каждой камеры: файл (хранится в браузере), адрес из «Настроек», веб-камера
       или RTSP-камера (rtsp://…): сервер читает её сам и отдаёт MJPEG, который показывает <img>
     • canvas поверх каждого видео: красные рамки нарушителей
     • кадры всех камер по очереди уходят на сервер (выбранная камера — вдвое чаще)
     • демо-режим: сам придумывает нарушения, пока нет сервера
     • таблица последних нарушений; клик по строке — камера и момент видео
     • переход из журнала: monitor.html?cam=3&t=12.4
   ===================================================================== */
(function () {
    'use strict';

    var NS = window.Maboy;
    var store = NS.store;
    var h = NS.h;
    var $ = function (id) { return document.getElementById(id); };
    function noop() { /* ничего */ }

    var grid = $('cam-grid');
    var bar = $('cam-bar');
    var fileInput = $('file-input');
    var soundBtn = $('sound-btn');
    var demoBtn = $('demo-btn');
    var backBtn = $('back-btn');
    var liveBadge = $('live-badge');

    var cfg = store.getSettings();
    var cams = {};            // номер камеры -> объект камеры
    var order = [];           // номера камер по порядку
    var focusId = null;       // камера на весь экран (null — сетка)
    var activeId = 1;         // камера, к которой относятся кнопки на панели
    var gridSig = '';

    var REWIND_SEC = 3;       // при переходе из журнала отматываем на столько секунд раньше нарушения

    /* ===================== ХРАНИЛИЩЕ ВИДЕОФАЙЛОВ (IndexedDB) ===================== */
    // Загруженный видеофайл остаётся у камеры после перезагрузки страницы —
    // так журнал может открыть нужную камеру и перемотать её на момент нарушения.

    var dbPromise = null;

    function openDb() {
        if (!dbPromise) {
            dbPromise = new Promise(function (resolve) {
                try {
                    var req = indexedDB.open('maboy-video', 1);
                    req.onupgradeneeded = function () { req.result.createObjectStore('files'); };
                    req.onsuccess = function () { resolve(req.result); };
                    req.onerror = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        }
        return dbPromise;
    }

    function dbRun(mode, fn) {
        return openDb().then(function (db) {
            if (!db) { return null; }
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction('files', mode);
                    var req = fn(tx.objectStore('files'));
                    tx.oncomplete = function () { resolve(req && req.result !== undefined ? req.result : null); };
                    tx.onerror = tx.onabort = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        });
    }

    function idbGet(id)       { return dbRun('readonly',  function (s) { return s.get(id); }); }
    function idbPut(id, blob) { return dbRun('readwrite', function (s) { return s.put(blob, id); }); }
    function idbDel(id)       { return dbRun('readwrite', function (s) { return s.delete(id); }); }

    /* ===================== КАМЕРЫ ===================== */

    function cameraSignature() {
        return JSON.stringify(store.cameraList(cfg));
    }

    /* ---------- источник камеры: <video> (файл, адрес, веб-камера) или <img> (RTSP через бэкенд) ---------- */

    function isRtsp(cam) { return !!cam.rtspUrl; }

    function hasSource(cam) {
        return isRtsp(cam) || !!cam.video.srcObject || !!cam.video.getAttribute('src');
    }

    // картинка идёт прямо сейчас
    function isPlaying(cam) {
        if (isRtsp(cam)) { return cam.rtspOk && !cam.rtspPaused; }
        return hasSource(cam) && !cam.video.paused && !cam.video.ended;
    }

    function mediaEl(cam) { return isRtsp(cam) ? cam.img : cam.video; }

    function mediaSize(cam) {
        return isRtsp(cam) ? { w: cam.img.naturalWidth, h: cam.img.naturalHeight }
                           : { w: cam.video.videoWidth, h: cam.video.videoHeight };
    }

    // есть готовый кадр, который можно снять
    function hasFrame(cam) {
        if (isRtsp(cam)) { return cam.rtspOk && !cam.rtspPaused && cam.img.naturalWidth > 0; }
        return hasSource(cam) && cam.video.readyState >= 2 && cam.video.videoWidth > 0;
    }

    function stateText(cam) {
        if (!hasSource(cam)) { return 'нет сигнала'; }
        if (isRtsp(cam)) {
            if (cam.rtspPaused) { return 'пауза'; }
            return cam.rtspOk ? '● LIVE' : (cam.rtspLost ? 'нет сигнала' : 'подключение…');
        }
        return cam.video.paused ? 'пауза' : '● LIVE';
    }

    function fmtTime(sec) {
        sec = Math.max(0, Math.round(sec));
        var m = Math.floor(sec / 60), s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function createCam(c) {
        var cam = {
            id: c.id, name: c.name, src: c.src,
            boxes: [], streamBoxes: [], streamUntil: 0,
            cw: 0, ch: 0, objectUrl: null, token: 0, pendingSeek: null,
            rtspUrl: null, rtspId: null, rtspOk: false, rtspLost: false, rtspPaused: false,
            rtspToken: 0, rtspTimer: null, rtspReopen: false,
            alertUntil: 0, lastSendAt: 0, cycleMs: 0, frames: 0, fps: null
        };

        cam.video = h('video', { class: 'video', muted: true, playsinline: true, loop: true });
        cam.video.setAttribute('muted', '');
        cam.video.setAttribute('playsinline', '');
        // RTSP-камера показывается картинкой-потоком (MJPEG от бэкенда); crossorigin нужен, чтобы можно было снять кадр для анализа
        cam.img = h('img', { class: 'video', alt: '', hidden: true, style: 'width:100%;height:100%;object-fit:contain;background:#000' });
        cam.img.setAttribute('crossorigin', 'anonymous');
        cam.canvas = h('canvas', { class: 'overlay' });
        cam.ctx = cam.canvas.getContext('2d');

        cam.placeholderText = h('p', { text: 'Нет видео' });
        cam.fileInput = h('input', { type: 'file', accept: 'video/*', hidden: true });
        cam.placeholder = h('div', { class: 'video_placeholder' }, [
            h('span', { class: 'placeholder_icon', text: '📹' }),
            cam.placeholderText,
            h('label', { class: 'tile_pick' }, [document.createTextNode('Выбрать видео'), cam.fileInput])
        ]);
        cam.stage = h('div', { class: 'cam_stage' }, [cam.video, cam.img, cam.canvas, cam.placeholder]);

        cam.stateEl = h('span', { class: 'cam_state', text: 'нет сигнала' });
        cam.tile = h('div', {
            class: 'cam_tile', tabindex: 0, role: 'button', 'data-cam': c.id,
            'aria-label': c.name + ': открыть на весь экран'
        }, [cam.stage, h('div', { class: 'cam_label' }, [h('span', { class: 'cam_name', text: c.id + ' · ' + c.name }), cam.stateEl])]);

        // клик по плитке — на весь экран (в режиме одной камеры ничего не делает)
        cam.tile.addEventListener('click', function () { if (focusId === null) { focusCam(cam.id); } });
        cam.tile.addEventListener('keydown', function (e) {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === cam.tile) {
                e.preventDefault();
                if (focusId === null) { focusCam(cam.id); }
            }
        });
        cam.placeholder.querySelector('.tile_pick').addEventListener('click', function (e) { e.stopPropagation(); });
        cam.fileInput.addEventListener('change', function () {
            var file = cam.fileInput.files && cam.fileInput.files[0];
            if (file) { chooseFile(cam, file); }
            cam.fileInput.value = '';
        });

        // видео
        ['play', 'pause', 'ended', 'emptied'].forEach(function (evt) { cam.video.addEventListener(evt, function () { updateState(cam); }); });
        cam.video.addEventListener('loadeddata', function () {
            cam.placeholder.hidden = true;
            applyPendingSeek(cam);
            updateState(cam);
        });
        cam.video.addEventListener('error', function () {
            if (!hasSource(cam)) { return; }
            NS.toast('Камера ' + cam.id + ': не удалось воспроизвести видео. Нужен mp4 (H.264) или webm.', 5000);
            cam.placeholderText.textContent = 'Видео не воспроизводится';
            cam.placeholder.hidden = false;
            updateState(cam);
        });

        // RTSP: первый кадр потока пришёл / поток оборвался
        cam.img.addEventListener('load', function () { if (cam.rtspUrl && !cam.rtspPaused) { rtspOnline(cam); } });
        cam.img.addEventListener('error', function () {
            if (!cam.rtspUrl || cam.rtspPaused) { return; }
            rtspLost(cam, 'Нет изображения от сервера');
            clearTimeout(cam.rtspTimer);
            cam.rtspTimer = setTimeout(function () { rtspConnect(cam); }, 4000);   // заново регистрируем и подключаемся
        });

        // частота кадров (считаем кадры видео)
        if (cam.video.requestVideoFrameCallback) {
            (function onFrame() { cam.frames++; cam.video.requestVideoFrameCallback(onFrame); })();
        }

        // размер canvas = размер плитки
        if (window.ResizeObserver) { new ResizeObserver(function () { resizeCanvas(cam); }).observe(cam.stage); }

        return cam;
    }

    function resizeCanvas(cam) {
        var dpr = window.devicePixelRatio || 1;
        cam.cw = cam.stage.clientWidth;
        cam.ch = cam.stage.clientHeight;
        cam.canvas.width = Math.round(cam.cw * dpr);
        cam.canvas.height = Math.round(cam.ch * dpr);
        cam.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function clearSource(cam) {
        rtspStop(cam);
        if (cam.video.srcObject) {
            cam.video.srcObject.getTracks().forEach(function (t) { t.stop(); });
            cam.video.srcObject = null;
        }
        cam.video.pause();
        cam.video.removeAttribute('src');
        cam.video.load();
        if (cam.objectUrl) { URL.revokeObjectURL(cam.objectUrl); cam.objectUrl = null; }
        cam.placeholder.hidden = false;
        updateState(cam);
    }

    function setBlob(cam, blob) {
        clearSource(cam);
        cam.objectUrl = URL.createObjectURL(blob);
        cam.video.src = cam.objectUrl;
        cam.video.play().catch(noop);
    }

    function setUrl(cam, url) {
        clearSource(cam);
        cam.tainted = false;
        cam.video.src = url;
        cam.video.play().catch(noop);
    }

    // Что играет камера: загруженный файл → адрес из «Настроек» → ничего
    function loadSource(cam) {
        var token = ++cam.token;
        return idbGet(cam.id).then(function (blob) {
            if (token !== cam.token) { return; }
            if (blob instanceof Blob) { setBlob(cam, blob); }
            else if (cam.src) {
                if (NS.isRtsp(cam.src)) { setRtsp(cam, cam.src); }
                else { setUrl(cam, cam.src); }
            } else {
                clearSource(cam);
                cam.placeholderText.textContent = 'Нет видео';
            }
        });
    }

    /* ---------- RTSP через бэкенд ---------- */
    // Бэкенд запоминает адрес камеры (register) и отдаёт MJPEG-поток по короткому id — пароль в ссылках не светится.
    // Пока камера недоступна, поток на сервере не рвётся: когда сигнал вернётся, кадры пойдут сами.
    // Раз в несколько секунд спрашиваем у сервера, есть ли сигнал, и показываем это на плитке.

    function setRtsp(cam, url) {
        clearSource(cam);
        cam.tainted = false;
        cam.rtspUrl = url;
        cam.placeholderText.textContent = 'Подключение к камере…';
        cam.placeholder.hidden = false;
        updateState(cam);
        rtspConnect(cam);
    }

    function rtspConnect(cam) {
        if (!cam.rtspUrl || cam.rtspPaused) { return; }
        var token = ++cam.rtspToken;
        clearTimeout(cam.rtspTimer);
        cam.rtspReopen = false;
        NS.rtsp.register(cam.rtspUrl).then(function (info) {
            if (token !== cam.rtspToken) { return; }
            cam.rtspId = info.id;
            cam.img.src = NS.apiBase() + info.stream + '?c=' + token + '_' + Date.now();   // новый адрес — браузер откроет поток заново
        }).catch(function (err) {
            if (token !== cam.rtspToken) { return; }
            rtspLost(cam, err.message);
            cam.rtspTimer = setTimeout(function () { rtspConnect(cam); }, 5000);
        });
    }

    function rtspOnline(cam) {
        if (!cam.rtspUrl || cam.rtspPaused) { return; }
        var was = cam.rtspOk;
        cam.rtspOk = true;
        cam.rtspLost = false;
        cam.img.hidden = false;
        cam.placeholder.hidden = true;
        if (!was) { updateState(cam); }
    }

    function rtspLost(cam, reason) {
        if (!cam.rtspUrl) { return; }
        cam.rtspOk = false;
        cam.rtspLost = true;
        cam.img.hidden = true;      // застывший последний кадр не показываем и на анализ не шлём
        cam.placeholderText.textContent = reason ? 'Нет сигнала: ' + reason : 'Нет сигнала от камеры';
        cam.placeholder.hidden = false;
        updateState(cam);
    }

    function rtspPause(cam) {
        if (!cam.rtspUrl || cam.rtspPaused) { return; }
        cam.rtspPaused = true;
        cam.rtspToken++;
        clearTimeout(cam.rtspTimer);
        cam.rtspOk = false;
        cam.img.removeAttribute('src');   // поток закрывается; сервер перестаёт читать камеру, если смотреть больше некому
        cam.img.hidden = true;
        cam.placeholderText.textContent = 'Пауза (нажмите «Старт»)';
        cam.placeholder.hidden = false;
        updateState(cam);
    }

    function rtspStop(cam) {
        cam.rtspToken++;
        clearTimeout(cam.rtspTimer);
        cam.rtspUrl = null;
        cam.rtspId = null;
        cam.rtspOk = false;
        cam.rtspLost = false;
        cam.rtspPaused = false;
        cam.rtspReopen = false;
        cam.img.removeAttribute('src');
        cam.img.hidden = true;
    }

    function playCam(cam) {
        if (isRtsp(cam)) {
            if (cam.rtspPaused) { cam.rtspPaused = false; cam.placeholderText.textContent = 'Подключение к камере…'; updateState(cam); rtspConnect(cam); }
        } else { cam.video.play().catch(noop); }
    }

    function pauseCam(cam) {
        if (isRtsp(cam)) { rtspPause(cam); } else { cam.video.pause(); }
    }

    // проверка сигнала у всех RTSP-камер
    setInterval(function () {
        order.forEach(function (id) {
            var cam = cams[id];
            if (!cam || !cam.rtspUrl || cam.rtspPaused || !cam.rtspId) { return; }
            var token = cam.rtspToken;
            NS.rtsp.status(cam.rtspId).then(function (st) {
                if (token !== cam.rtspToken) { return; }
                if (cam.rtspReopen) { rtspConnect(cam); return; }   // связь с сервером пропадала — открываем поток заново
                if (st.online) { rtspOnline(cam); }
                else if (!st.error && !cam.rtspOk && !cam.rtspLost) { /* ещё подключается — ждём */ }
                else { rtspLost(cam, st.error || ''); }
            }).catch(function (err) {
                if (token !== cam.rtspToken) { return; }
                if (err.status === 404) { rtspConnect(cam); return; }   // сервер перезапускался и забыл камеру
                cam.rtspReopen = true;
                rtspLost(cam, err.message);
            });
        });
    }, 3000);

    function chooseFile(cam, file) {
        cam.token++;
        cam.tainted = false;
        setBlob(cam, file);
        idbPut(cam.id, file).then(function (r) {
            if (r === null) { NS.toast('Видео не сохранилось в браузере: после обновления страницы его нужно выбрать снова.', 5000); }
        });
        if (focusId === null) { setActive(cam.id); }
    }

    function updateState(cam) {
        var on = isPlaying(cam);
        cam.stateEl.textContent = stateText(cam);
        cam.stateEl.classList.toggle('is_live', on);
        updateBadge();
    }

    function updateBadge() {
        var live = 0, total = order.length;
        order.forEach(function (id) { var c = cams[id]; if (isPlaying(c)) { live++; } });
        var text, off;
        if (focusId !== null) {
            var c = cams[focusId];
            var st = stateText(c);
            text = st === '● LIVE' ? st : st.charAt(0).toUpperCase() + st.slice(1);
            off = st !== '● LIVE';
        } else {
            text = live ? '● LIVE · ' + live + ' из ' + total : 'Нет сигнала';
            off = !live;
        }
        liveBadge.textContent = text;
        liveBadge.classList.toggle('is_off', off);
    }

    /* ===================== СЕТКА, ПЛАШКИ, ФОКУС ===================== */

    function buildGrid() {
        var list = store.cameraList(cfg);
        var prev = cams;

        // у камеры поменяли адрес в «Настройках» → забываем ранее загруженный файл, чтобы адрес сработал
        list.forEach(function (c) {
            if (prev[c.id] && prev[c.id].src !== c.src) { idbDel(c.id); }
        });

        order.forEach(function (id) {
            var c = prev[id];
            c.token++;
            clearSource(c);
        });

        grid.textContent = '';
        cams = {};
        order = [];
        list.forEach(function (c) {
            var cam = createCam(c);
            cams[c.id] = cam;
            order.push(c.id);
            grid.appendChild(cam.tile);
        });

        var n = order.length;
        grid.style.setProperty('--cols', n <= 1 ? 1 : (n <= 4 ? 2 : 3));
        gridSig = cameraSignature();

        if (!cams[activeId]) { activeId = order[0]; }
        if (focusId !== null && !cams[focusId]) { focusId = null; }

        buildChips();
        applyView();
        order.forEach(function (id) { resizeCanvas(cams[id]); cams[id].loading = loadSource(cams[id]); });
    }

    function buildChips() {
        bar.textContent = '';
        var all = h('button', { type: 'button', class: 'cam_chip cam_chip_all', 'data-cam': 'all', text: 'Все камеры' });
        all.addEventListener('click', showGrid);
        bar.appendChild(all);
        order.forEach(function (id) {
            var chip = h('button', { type: 'button', class: 'cam_chip', 'data-cam': id, text: String(id), title: cams[id].name, 'aria-label': 'Камера ' + id + ': ' + cams[id].name });
            chip.addEventListener('click', function () { focusCam(id); });
            bar.appendChild(chip);
        });
    }

    function applyView() {
        grid.classList.toggle('is_focus', focusId !== null);
        order.forEach(function (id) {
            var c = cams[id];
            c.tile.classList.toggle('is_off', focusId !== null && id !== focusId);
            c.tile.classList.toggle('is_active', id === activeId && focusId === null && order.length > 1);
            c.video.controls = (focusId === id);
            c.tile.setAttribute('tabindex', (focusId !== null && id !== focusId) ? '-1' : '0');
        });
        Array.prototype.forEach.call(bar.children, function (chip) {
            var v = chip.getAttribute('data-cam');
            var pressed = (v === 'all') ? focusId === null : Number(v) === focusId;
            chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        });
        backBtn.hidden = (focusId === null);
        $('view-title').textContent = focusId === null ? 'Все камеры' : 'Камера ' + focusId + ' — ' + cams[focusId].name;
        $('source-label').textContent = 'Выбрать видео · камера ' + activeId;
        updateBadge();
        setTimeout(function () { order.forEach(function (id) { resizeCanvas(cams[id]); }); }, 0);
    }

    function setActive(id) {
        if (!cams[id]) { return; }
        activeId = id;
        applyView();
    }

    function focusCam(id) {
        if (!cams[id]) { return; }
        focusId = id;
        activeId = id;
        applyView();
    }

    function showGrid() {
        focusId = null;
        applyView();
    }

    backBtn.addEventListener('click', showGrid);

    // красная подсветка плитки и точка на плашке, пока на камере свежее нарушение
    function markAlert(id) {
        if (cams[id]) { cams[id].alertUntil = Date.now() + 8000; refreshAlerts(); }
    }

    function refreshAlerts() {
        var now = Date.now();
        order.forEach(function (id) {
            var on = cams[id].alertUntil > now;
            cams[id].tile.classList.toggle('is_alert', on);
            var chip = bar.querySelector('[data-cam="' + id + '"]');
            if (chip) { chip.classList.toggle('has_alert', on); }
        });
    }
    setInterval(refreshAlerts, 500);

    /* ===================== ПЕРЕМОТКА НА МОМЕНТ НАРУШЕНИЯ ===================== */

    function applyPendingSeek(cam) {
        if (cam.pendingSeek === null) { return; }
        var t = cam.pendingSeek;
        cam.pendingSeek = null;
        var dur = cam.video.duration;
        var target = Math.max(0, t - REWIND_SEC);
        if (isFinite(dur) && dur > 0) { target = Math.min(target, Math.max(0, dur - 0.5)); }
        try { cam.video.currentTime = target; } catch (e) { /* ничего */ }
        cam.video.play().catch(noop);
        NS.toast('Камера ' + cam.id + ': видео перемотано на ' + fmtTime(target) + ' (за ' + REWIND_SEC + ' с до нарушения)', 5000);
    }

    // открыть камеру на весь экран и перемотать видео на секунду t
    function jumpTo(id, t) {
        id = Number(id);
        if (!cams[id]) {
            NS.toast('Камера ' + id + ' сейчас не показывается. Увеличьте число камер в «Настройках».', 5000);
            return;
        }
        focusCam(id);
        var cam = cams[id];
        if (t === null || t === undefined || isNaN(Number(t))) {
            NS.toast('Камера ' + id + ' открыта. Для этого нарушения момент в видео не записан.', 4500);
            return;
        }
        cam.pendingSeek = Number(t);
        // видео камеры может ещё загружаться из хранилища браузера — сначала дожидаемся этого
        (cam.loading || Promise.resolve()).then(function () {
            if (cam.pendingSeek === null) { return; }
            if (isRtsp(cam)) {
                cam.pendingSeek = null;
                NS.toast('Камера ' + id + ' — прямой эфир (RTSP): перемотать на момент нарушения нельзя. Кадр нарушения есть в журнале.', 6000);
            } else if (!hasSource(cam)) {
                NS.toast('У камеры ' + id + ' нет видео. Выберите видео этой камеры кнопкой «Выбрать видео», и оно перемотается на нужный момент.', 7000);
            } else if (cam.video.readyState >= 2) {
                applyPendingSeek(cam);      // видео уже готово; иначе перемотка сработает сама, когда оно загрузится
            }
        });
    }

    /* ===================== КНОПКИ ПАНЕЛИ ===================== */

    fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        var cam = cams[focusId !== null ? focusId : activeId];
        if (file && cam) { chooseFile(cam, file); }
        fileInput.value = '';
    });

    $('webcam-btn').addEventListener('click', function () {
        var cam = cams[focusId !== null ? focusId : activeId];
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            NS.toast('Веб-камера недоступна: нужен адрес localhost или https.', 5000);
            return;
        }
        navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(function (stream) {
            cam.token++;
            clearSource(cam);
            cam.video.srcObject = stream;
            cam.video.play().catch(noop);
        }).catch(function () {
            NS.toast('Нет доступа к веб-камере. Разрешите доступ в браузере.', 5000);
        });
    });

    $('clear-btn').addEventListener('click', function () {
        var cam = cams[focusId !== null ? focusId : activeId];
        idbDel(cam.id).then(function () { loadSource(cam); });
        NS.toast('Камера ' + cam.id + ': загруженное видео убрано' + (cam.src ? '. Играет адрес из «Настроек».' : '.'));
    });

    // «Старт» и «Пауза» — для выбранной камеры, а в сетке — для всех
    function targets() { return focusId !== null ? [cams[focusId]] : order.map(function (id) { return cams[id]; }); }

    $('play-btn').addEventListener('click', function () {
        var list = targets().filter(hasSource);
        if (!list.length) { NS.toast('Сначала выберите видео.'); return; }
        list.forEach(playCam);
    });

    $('pause-btn').addEventListener('click', function () {
        targets().forEach(pauseCam);
    });

    /* ===================== СНИМОК КАДРА ===================== */
    // Нарушение сохраняется вместе с кадром, чтобы его можно было открыть в журнале.

    function captureFrame(camId) {
        var cam = cams[camId] || cams[focusId !== null ? focusId : activeId];
        if (!cam || !hasFrame(cam)) { return null; }
        var size = mediaSize(cam);
        var w = 480;
        var hh = Math.round(w * size.h / size.w);
        var c = document.createElement('canvas');
        c.width = w;
        c.height = hh;
        try {
            c.getContext('2d').drawImage(mediaEl(cam), 0, 0, w, hh);
            // у прямого эфира (RTSP) нет «секунды видео», поэтому t = null
            return { frame: c.toDataURL('image/jpeg', 0.6), ar: size.w / size.h, t: isRtsp(cam) ? null : cam.video.currentTime };
        } catch (e) {
            return null;   // чужой адрес без CORS: снимок недоступен
        }
    }
    NS.frameProvider = captureFrame;

    /* ===================== CANVAS С РАМКАМИ ===================== */

    // Видео вписано в плитку с полями (object-fit: contain) — рамки считаем от самого видео, а не от плитки.
    function frameRect(cam) {
        var sz = mediaSize(cam);
        var vw = sz.w, vh = sz.h;
        if (!hasSource(cam) || !vw || !vh) { return { x: 0, y: 0, w: cam.cw, h: cam.ch }; }
        var k = Math.min(cam.cw / vw, cam.ch / vh);
        var w = vw * k, hh = vh * k;
        return { x: (cam.cw - w) / 2, y: (cam.ch - hh) / 2, w: w, h: hh };
    }

    function drawCam(cam, now) {
        var ctx = cam.ctx;
        ctx.clearRect(0, 0, cam.cw, cam.ch);
        cam.boxes = cam.boxes.filter(function (b) { return b.until > now; });
        var all = cam.boxes.concat(cam.streamUntil > now ? cam.streamBoxes : []);
        if (!all.length) { return; }

        var small = cam.cw < 420;
        var r = frameRect(cam);
        ctx.lineWidth = small ? Math.max(2, cfg.border - 1) : cfg.border;
        ctx.strokeStyle = '#d93025';
        ctx.font = '600 ' + (small ? 11 : 13) + 'px Rubik, Arial, sans-serif';
        ctx.textBaseline = 'middle';

        all.forEach(function (b) {
            ctx.globalAlpha = b.until ? Math.min(1, (b.until - now) / 500) : 1;   // плавно гаснет
            var x = r.x + b.x * r.w;
            var y = r.y + b.y * r.h;
            var w = b.w * r.w;
            var hh = b.h * r.h;
            ctx.strokeRect(x, y, w, hh);

            if (cfg.labels && b.label) {
                var tw = ctx.measureText(b.label).width + 12;
                var th = small ? 18 : 22;
                var ty = (y - th >= 0) ? y - th : y;
                ctx.fillStyle = '#d93025';
                ctx.fillRect(x - ctx.lineWidth / 2, ty, tw, th);
                ctx.fillStyle = '#fff';
                ctx.fillText(b.label, x + 5, ty + th / 2 + 1);
            }
        });
        ctx.globalAlpha = 1;
    }

    function draw() {
        var now = Date.now();
        for (var i = 0; i < order.length; i++) {
            var cam = cams[order[i]];
            if (cam.cw > 0 && cam.ch > 0 && (focusId === null || focusId === cam.id)) { drawCam(cam, now); }
        }
        requestAnimationFrame(draw);
    }

    // новое нарушение → рамка на 4 секунды на нужной камере
    window.addEventListener('maboy:violation', function (e) {
        var v = e.detail;
        var cam = cams[v.camera];
        if (!cam) { return; }
        markAlert(cam.id);
        if (!v.bbox) { return; }
        cam.boxes.push({
            x: v.bbox[0], y: v.bbox[1], w: v.bbox[2], h: v.bbox[3],
            label: store.typeLabel(v.type) + ' · ' + Math.round(v.confidence * 100) + '%',
            until: Date.now() + 4000
        });
    });

    // рамки по кадрам от бэкенда: живут, пока не придёт следующий кадр этой камеры
    window.addEventListener('maboy:boxes', function (e) {
        var cam = cams[e.detail.camera];
        if (!cam) { return; }
        cam.streamBoxes = e.detail.boxes;
        var ttl = Math.min(6000, Math.max(1500, cam.cycleMs * 2.2));
        cam.streamUntil = Date.now() + ttl;
        if (e.detail.boxes.length) { markAlert(cam.id); }
    });

    /* ===================== ДЕМО-РЕЖИМ ===================== */
    // Пока нет связи с сервером, монитор сам придумывает нарушения //

    var demoWanted = true;
    try { demoWanted = localStorage.getItem('maboy.demo') !== '0'; } catch (e) { /* ничего */ }

    function demoActive() { return demoWanted && NS.conn.state() !== 'online'; }

    function syncDemo() {
        NS.conn.setDemo(demoActive());
        demoBtn.textContent = '🧪 Демо: ' + (demoWanted ? 'вкл' : 'выкл');
        demoBtn.classList.toggle('is_on', demoWanted);
    }

    demoBtn.addEventListener('click', function () {
        demoWanted = !demoWanted;
        try { localStorage.setItem('maboy.demo', demoWanted ? '1' : '0'); } catch (e) { /* ничего */ }
        syncDemo();
        NS.toast(demoWanted ? 'Демо-режим включён: нарушения генерируются случайно.' : 'Демо-режим выключен.');
    });

    window.addEventListener('maboy:conn', syncDemo);

    function rnd(a, b) { return a + Math.random() * (b - a); }

    function makeDemoViolation() {
        var enabled = store.ACTIVE_TYPES.filter(function (k) { return cfg.types[k]; });
        if (!enabled.length) { return; }
        // нарушение придумываем на камере с видео (на «живой» камере), а если видео нигде нет — на любой
        var withVideo = order.filter(function (id) { return isPlaying(cams[id]); });
        var pool = withVideo.length ? withVideo : order;
        var camId = pool[Math.floor(Math.random() * pool.length)];
        var w = rnd(0.1, 0.18), hh = rnd(0.3, 0.45);
        // уверенность всегда выше порога из настроек, иначе демо молча «пропускало» бы нарушения
        var lo = Math.min(0.985, Math.max(0.6, cfg.threshold / 100 + 0.02));
        NS.report({
            type: enabled[Math.floor(Math.random() * enabled.length)],
            camera: camId,
            confidence: rnd(lo, 0.995),
            bbox: [rnd(0.05, 0.95 - w), rnd(0.08, 0.92 - hh), w, hh]
        });
    }

    function demoTick() {
        // с видео — только пока оно идёт; без видео — всё равно, чтобы можно было показать тревогу
        var anyVideo = order.some(function (id) { return hasSource(cams[id]); });
        var playing = order.some(function (id) { return isPlaying(cams[id]); });
        if (demoActive() && (!anyVideo || playing)) { makeDemoViolation(); }
        setTimeout(demoTick, rnd(3500, 8000));
    }
    setTimeout(demoTick, 2500);

    /* ===================== ОТПРАВКА КАДРОВ НА СЕРВЕР ===================== */
    // Бэкенд (main.py, /ws/stream) сам ничего не присылает: монитор шлёт ему JPEG-кадры из видео,
    // а он на каждый кадр отвечает списком нарушений. Перед кадром идёт {"camera": N} — чтобы сервер
    // знал, чей он. Следующий кадр уходит только после ответа на предыдущий, а камеры опрашиваются
    // по очереди; выбранная камера (на весь экран) — каждый второй кадр.

    var SEND_WIDTH = 640;          // кадр уменьшаем до такой ширины перед отправкой
    var SEND_EVERY_MS = 120;       // пауза между попытками отправки; реальный темп задаёт скорость сервера
    var ACK_TIMEOUT_MS = 2500;     // если ответа нет дольше — шлём следующий кадр всё равно
    var sendCanvas = document.createElement('canvas');
    var inFlight = false, preparing = false, sentAt = 0, lastErrorToast = 0;
    var rr = 0, focusTurn = false;

    function canStreamCam(cam) {
        return !cam.tainted && isPlaying(cam) && hasFrame(cam);
    }

    function pickCamera() {
        var ready = order.filter(function (id) { return canStreamCam(cams[id]); });
        if (!ready.length) { return null; }
        if (focusId !== null && ready.indexOf(focusId) >= 0) {
            focusTurn = !focusTurn;
            var others = ready.filter(function (id) { return id !== focusId; });
            if (focusTurn || !others.length) { return focusId; }
            return others[rr++ % others.length];
        }
        return ready[rr++ % ready.length];
    }

    function sendFrame() {
        if (preparing || NS.conn.state() !== 'online') { return; }
        if (inFlight && Date.now() - sentAt < ACK_TIMEOUT_MS) { return; }
        var id = pickCamera();
        if (id === null) { return; }
        var cam = cams[id];
        var v = mediaEl(cam);
        var size = mediaSize(cam);

        var w = Math.min(SEND_WIDTH, size.w);
        var hh = Math.round(w * size.h / size.w);
        sendCanvas.width = w;
        sendCanvas.height = hh;

        try {
            sendCanvas.getContext('2d').drawImage(v, 0, 0, w, hh);
            var t = isRtsp(cam) ? null : v.currentTime;   // у прямого эфира момента в видео нет
            preparing = true;
            sendCanvas.toBlob(function (blob) {
                preparing = false;
                if (!blob) { return; }
                // рамки в ответе будут в пикселях ИМЕННО этого кадра этой камеры
                NS.streamMeta.w = w; NS.streamMeta.h = hh; NS.streamMeta.cam = id; NS.streamMeta.t = t;
                if (NS.conn.send(JSON.stringify({ camera: id })) && NS.conn.send(blob)) {
                    var now = Date.now();
                    if (cam.lastSendAt) {
                        var gap = now - cam.lastSendAt;
                        cam.cycleMs = cam.cycleMs ? cam.cycleMs * 0.7 + gap * 0.3 : gap;
                    }
                    cam.lastSendAt = now;
                    inFlight = true;
                    sentAt = now;
                }
            }, 'image/jpeg', 0.7);
        } catch (e) {
            // Видео с чужого адреса без CORS: браузер не даёт снять из него кадр. Показывать такое видео можно,
            // а отправлять на анализ — нет. Говорим об этом один раз и больше эту камеру не трогаем.
            preparing = false;
            if (!cam.tainted) {
                cam.tainted = true;
                NS.toast(isRtsp(cam)
                    ? 'Камера ' + cam.id + ': браузер не дал снять кадр из RTSP-потока (CORS). Проверьте, что бэкенд запущен из актуального main.py.'
                    : 'Камера ' + cam.id + ': видео с другого сайта без разрешения (CORS), его нельзя отправить на анализ. ' +
                      'Положите видео рядом с сайтом (video/cam' + cam.id + '.mp4) или выберите файл кнопкой «Выбрать видео».', 9000);
            }
        }
    }
    setInterval(sendFrame, SEND_EVERY_MS);

    window.addEventListener('maboy:ack', function (e) {
        inFlight = false;
        if (e.detail.error) {
            if (Date.now() - lastErrorToast > 10000) {
                lastErrorToast = Date.now();
                NS.toast('Сервер не смог обработать кадр: ' + e.detail.error, 4000);
            }
        } else if (e.detail.latency !== undefined) {
            $('stat-latency').textContent = Math.round(e.detail.latency);
        }
    });

    window.addEventListener('maboy:conn', function () {
        if (NS.conn.state() !== 'online') { inFlight = false; }
    });

    /* ===================== ЗВУК ===================== */

    function renderSoundBtn() {
        soundBtn.textContent = '🔔 Звук: ' + (cfg.sound ? 'вкл' : 'выкл');
        soundBtn.classList.toggle('is_on', cfg.sound);
    }

    soundBtn.addEventListener('click', function () {
        NS.sound.unlock();
        cfg = store.saveSettings({ sound: !cfg.sound });
        renderSoundBtn();
        if (cfg.sound) { setTimeout(function () { NS.sound.play(cfg.volume); }, 150); }
    });

    /* ===================== ТАБЛИЦА И СЧЁТЧИКИ ===================== */

    function renderLog() {
        var body = $('log-body');
        var list = store.sorted().slice(0, 8);
        body.textContent = '';

        if (!list.length) {
            body.appendChild(h('tr', null, [h('td', { colspan: 4, class: 'empty_cell', text: 'Нарушений пока нет' })]));
            return;
        }

        list.forEach(function (v) {
            var jump = (v.camera !== null && v.camera !== undefined);
            var tr = h('tr', {
                class: (v.status === 'new' ? 'row_new' : '') + (jump ? ' row_jump' : ''),
                title: jump ? 'Открыть камеру ' + v.camera + (v.videoTime !== null && v.videoTime !== undefined ? ' на ' + fmtTime(v.videoTime) : '') : null
            }, [
                h('td', { text: store.formatTime(v.ts) }),
                h('td', { text: v.camera === null || v.camera === undefined ? '—' : '№ ' + v.camera }),
                h('td', { text: store.typeLabel(v.type) }),
                h('td', null, [h('span', { class: 'badge_status badge_' + v.status, text: store.STATUSES[v.status] })])
            ]);
            if (jump) { tr.addEventListener('click', function () { jumpTo(v.camera, v.videoTime); }); }
            body.appendChild(tr);
        });
    }

    function renderStats() {
        $('stat-today').textContent = store.todayCount();
        $('stat-new').textContent = store.newCount();
    }

    setInterval(function () {
        var cam = cams[focusId !== null ? focusId : activeId];
        order.forEach(function (id) {
            var c = cams[id];
            c.fps = c.frames;
            c.frames = 0;
        });
        var supported = !!document.createElement('video').requestVideoFrameCallback;
        $('stat-fps').textContent = (supported && cam && !isRtsp(cam) && hasSource(cam) && !cam.video.paused) ? cam.fps : '—';
        if (!order.some(function (id) { return canStreamCam(cams[id]); })) { $('stat-latency').textContent = '—'; }
    }, 1000);

    window.addEventListener('maboy:change', function () {
        cfg = store.getSettings();
        if (cameraSignature() !== gridSig) { buildGrid(); }   // число камер, названия или адреса поменяли в «Настройках»
        renderLog();
        renderStats();
        renderSoundBtn();
    });

    /* ===================== СТАРТ ===================== */
    buildGrid();
    renderLog();
    renderStats();
    renderSoundBtn();
    syncDemo();
    requestAnimationFrame(draw);

    (function () {
        var q;
        try { q = new URLSearchParams(location.search); } catch (e) { return; }
        var cam = q.get('cam');
        if (cam === null || !/^\d+$/.test(cam)) { return; }
        var t = q.get('t');
        jumpTo(Number(cam), t === null || t === '' ? null : Number(t));
        try { history.replaceState(null, '', location.pathname); } catch (e) { /* ничего */ }   // после обновления страницы не перематывать снова
    })();

    window.addEventListener('beforeunload', function () {
        order.forEach(function (id) {
            var c = cams[id];
            if (c.objectUrl) { URL.revokeObjectURL(c.objectUrl); }
            if (c.video.srcObject) { c.video.srcObject.getTracks().forEach(function (t) { t.stop(); }); }
        });
    });
})();