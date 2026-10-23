/* =====================================================================
   monitor.js — страница «Монитор»:
     • видео из файла / веб-камеры / адреса потока
     • canvas поверх видео: красные рамки нарушителей
     • демо-режим: сам придумывает нарушения, пока нет сервера
     • таблица последних нарушений и счётчики
   ===================================================================== */
(function () {
    'use strict';

    var NS = window.Maboy;
    var store = NS.store;
    var h = NS.h;
    var $ = function (id) { return document.getElementById(id); };
    function noop() { /* ничего */ }

    var video = $('video');
    var canvas = $('overlay');
    var stage = canvas.parentElement;
    var placeholder = document.querySelector('.video_placeholder');
    var placeholderText = placeholder.querySelector('p');
    var staticBox = document.querySelector('.demo_box');
    var liveBadge = document.querySelector('.live_badge');
    var fileInput = $('file-input');
    var sourceBtn = $('source-btn');
    var sourceLabel = $('source-label');
    var soundBtn = $('sound-btn');
    var demoBtn = $('demo-btn');

    if (staticBox) { staticBox.hidden = true; }   // рамка-пример больше не нужна

    var cfg = store.getSettings();
    var objectUrl = null;

    /* ===================== ВИДЕО ===================== */

    function hasSource() {
        return !!video.srcObject || !!video.getAttribute('src');
    }

    function clearSource() {
        if (video.srcObject) {
            video.srcObject.getTracks().forEach(function (t) { t.stop(); });
            video.srcObject = null;
        }
        video.pause();
        video.removeAttribute('src');
        video.load();
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
        placeholder.hidden = false;
        updateLive();
    }

    function loadFile(file) {
        clearSource();
        objectUrl = URL.createObjectURL(file);
        video.src = objectUrl;
        video.play().catch(noop);
    }

    function startWebcam() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            NS.toast('Камера недоступна: нужен адрес localhost или https.', 5000);
            return;
        }
        navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(function (stream) {
            clearSource();
            video.srcObject = stream;
            video.play().catch(noop);
        }).catch(function () {
            NS.toast('Нет доступа к камере. Разрешите доступ в браузере.', 5000);
        });
    }

    function startStream() {
        var url = (cfg.rtsp || '').trim();
        if (!url) { NS.toast('Укажите адрес потока в «Настройках».', 4000); return; }
        if (/^rtsp:/i.test(url)) {
            NS.toast('Браузер не играет rtsp:// напрямую. Нужен http(s)-адрес от бэкенда (mp4, MJPEG, HLS).', 7000);
            return;
        }
        clearSource();
        video.src = url;
        video.play().catch(noop);
    }

    function updateLive() {
        if (!hasSource())        { liveBadge.textContent = 'Нет сигнала'; liveBadge.classList.add('is_off'); }
        else if (video.paused)   { liveBadge.textContent = 'Пауза';       liveBadge.classList.add('is_off'); }
        else                     { liveBadge.textContent = '● LIVE';      liveBadge.classList.remove('is_off'); }
    }

    function applySourceUI() {
        var labels = { file: 'Выбрать видео', webcam: '📷 Включить камеру', rtsp: 'Подключить поток' };
        var hints  = {
            file:   'Выберите видеофайл, и он начнёт проигрываться',
            webcam: 'Нажмите «Включить камеру»',
            rtsp:   'Нажмите «Подключить поток» (адрес задаётся в настройках)'
        };
        sourceLabel.textContent = labels[cfg.source] || labels.file;
        if (!hasSource()) { placeholderText.textContent = hints[cfg.source] || hints.file; }
    }

    sourceBtn.addEventListener('click', function (e) {
        if (cfg.source === 'file') { return; }   // обычный выбор файла
        e.preventDefault();                       // для камеры и потока диалог выбора файла не нужен
        if (cfg.source === 'webcam') { startWebcam(); } else { startStream(); }
    });

    fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        if (file) { loadFile(file); }
        fileInput.value = '';   // чтобы можно было выбрать тот же файл ещё раз
    });

    $('play-btn').addEventListener('click', function () {
        if (!hasSource()) { NS.toast('Сначала выберите видео.'); return; }
        video.play().catch(noop);
    });

    $('pause-btn').addEventListener('click', function () { video.pause(); });

    ['play', 'pause', 'ended', 'emptied'].forEach(function (evt) { video.addEventListener(evt, updateLive); });
    video.addEventListener('loadeddata', function () { placeholder.hidden = true; updateLive(); });
    video.addEventListener('error', function () {
        if (!hasSource()) { return; }
        NS.toast('Не удалось воспроизвести видео. Попробуйте mp4 (H.264) или webm.', 5000);
        placeholder.hidden = false;
        updateLive();
    });

    /* ===================== СНИМОК КАДРА ===================== */
    // Нарушение сохраняется вместе с кадром, чтобы его можно было открыть в журнале.

    function captureFrame() {
        if (!hasSource() || video.readyState < 2 || !video.videoWidth) { return null; }
        var w = 480;
        var hh = Math.round(w * video.videoHeight / video.videoWidth);
        var c = document.createElement('canvas');
        c.width = w;
        c.height = hh;
        try {
            c.getContext('2d').drawImage(video, 0, 0, w, hh);
            return { frame: c.toDataURL('image/jpeg', 0.6), ar: video.videoWidth / video.videoHeight };
        } catch (e) {
            return null;   // чужой адрес без CORS: снимок недоступен
        }
    }
    NS.frameProvider = captureFrame;

    /* ===================== CANVAS С РАМКАМИ ===================== */

    var ctx = canvas.getContext('2d');
    var cw = 0, ch = 0;
    var boxes = [];          // рамки нарушений (живут 4 секунды)
    var streamBoxes = [];    // рамки от бэкенда по кадрам (живут 1.5 секунды)
    var streamUntil = 0;

    function resize() {
        var dpr = window.devicePixelRatio || 1;
        cw = stage.clientWidth;
        ch = stage.clientHeight;
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (window.ResizeObserver) { new ResizeObserver(resize).observe(stage); }
    else { window.addEventListener('resize', resize); }
    resize();

    // Видео вписано в блок с полями (object-fit: contain) — рамки считаем от самого видео, а не от блока.
    function frameRect() {
        var vw = video.videoWidth, vh = video.videoHeight;
        if (!hasSource() || !vw || !vh) { return { x: 0, y: 0, w: cw, h: ch }; }
        var k = Math.min(cw / vw, ch / vh);
        var w = vw * k, hh = vh * k;
        return { x: (cw - w) / 2, y: (ch - hh) / 2, w: w, h: hh };
    }

    function draw() {
        ctx.clearRect(0, 0, cw, ch);
        var now = Date.now();
        boxes = boxes.filter(function (b) { return b.until > now; });
        var all = boxes.concat(streamUntil > now ? streamBoxes : []);

        if (all.length) {
            var r = frameRect();
            ctx.lineWidth = cfg.border;
            ctx.strokeStyle = '#d93025';
            ctx.font = '600 13px Rubik, Arial, sans-serif';
            ctx.textBaseline = 'middle';

            all.forEach(function (b) {
                ctx.globalAlpha = b.until ? Math.min(1, (b.until - now) / 500) : 1;   // плавно гаснет
                var x = r.x + b.x * r.w;
                var y = r.y + b.y * r.h;
                var w = b.w * r.w;
                var hh = b.h * r.h;
                ctx.strokeRect(x, y, w, hh);

                if (cfg.labels && b.label) {
                    var tw = ctx.measureText(b.label).width + 14;
                    var th = 22;
                    var ty = (y - th >= 0) ? y - th : y;
                    ctx.fillStyle = '#d93025';
                    ctx.fillRect(x - ctx.lineWidth / 2, ty, tw, th);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(b.label, x + 5, ty + th / 2 + 1);
                }
            });
            ctx.globalAlpha = 1;
        }
        requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);

    // новое нарушение → рамка на 4 секунды
    window.addEventListener('maboy:violation', function (e) {
        var v = e.detail;
        if (!v.bbox) { return; }
        boxes.push({
            x: v.bbox[0], y: v.bbox[1], w: v.bbox[2], h: v.bbox[3],
            label: store.typeLabel(v.type) + ' · ' + Math.round(v.confidence * 100) + '%',
            until: Date.now() + 4000
        });
    });

    // рамки по кадрам от бэкенда
    window.addEventListener('maboy:boxes', function (e) {
        streamBoxes = e.detail.boxes;
        streamUntil = Date.now() + 1500;
    });

    /* ===================== ДЕМО-РЕЖИМ ===================== */
    // Пока нет связи с сервером, монитор сам придумывает нарушения —
    // так интерфейс можно показать и отладить без бэкенда.

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
        var enabled = Object.keys(cfg.types).filter(function (k) { return cfg.types[k]; });
        if (!enabled.length) { return; }
        var w = rnd(0.1, 0.18), hh = rnd(0.3, 0.45);
        // уверенность всегда выше порога из настроек, иначе демо молча «пропускало» бы нарушения
        var lo = Math.min(0.985, Math.max(0.6, cfg.threshold / 100 + 0.02));
        NS.report({
            type: enabled[Math.floor(Math.random() * enabled.length)],
            camera: 1,
            confidence: rnd(lo, 0.995),
            bbox: [rnd(0.05, 0.95 - w), rnd(0.08, 0.92 - hh), w, hh]
        });
    }

    function demoTick() {
        // с видео — только пока оно идёт; без видео — всё равно, чтобы можно было показать тревогу
        if (demoActive() && (!hasSource() || !video.paused)) { makeDemoViolation(); }
        setTimeout(demoTick, rnd(3500, 8000));
    }
    setTimeout(demoTick, 2500);

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
            body.appendChild(h('tr', null, [h('td', { colspan: 3, class: 'empty_cell', text: 'Нарушений пока нет' })]));
            return;
        }

        list.forEach(function (v) {
            body.appendChild(h('tr', { class: v.status === 'new' ? 'row_new' : '' }, [
                h('td', { text: store.formatTime(v.ts) }),
                h('td', { text: store.typeLabel(v.type) }),
                h('td', null, [h('span', { class: 'badge_status badge_' + v.status, text: store.STATUSES[v.status] })])
            ]));
        });
    }

    function renderStats() {
        $('stat-today').textContent = store.todayCount();
        $('stat-new').textContent = store.newCount();
    }

    // частота кадров видео
    var frames = 0;
    if (video.requestVideoFrameCallback) {
        (function onFrame() { frames++; video.requestVideoFrameCallback(onFrame); })();
    }
    setInterval(function () {
        var fps = frames;
        frames = 0;
        $('stat-fps').textContent = (video.requestVideoFrameCallback && hasSource() && !video.paused) ? fps : '—';
    }, 1000);

    window.addEventListener('maboy:change', function () {
        cfg = store.getSettings();
        renderLog();
        renderStats();
        renderSoundBtn();
        applySourceUI();
    });

    /* ===================== СТАРТ ===================== */
    renderLog();
    renderStats();
    renderSoundBtn();
    applySourceUI();
    updateLive();
    syncDemo();

    window.addEventListener('beforeunload', function () {
        if (objectUrl) { URL.revokeObjectURL(objectUrl); }
        if (video.srcObject) { video.srcObject.getTracks().forEach(function (t) { t.stop(); }); }
    });
})();
