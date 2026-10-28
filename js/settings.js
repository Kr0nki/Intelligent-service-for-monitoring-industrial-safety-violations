/* =====================================================================
   settings.js — страница «Настройки»:
     • загрузка и сохранение настроек (localStorage)
     • проверка соединения с сервером, тестовая тревога
   ===================================================================== */
(function () {
    'use strict';

    var NS = window.Maboy;
    var store = NS.store;
    var $ = function (id) { return document.getElementById(id); };

    var form = $('settings-form');
    var typeBoxes = Array.prototype.slice.call(document.querySelectorAll('[data-type]'));

    /* ---------- форма <-> настройки ---------- */

    function fill(s) {
        $('ws-url').value = s.wsUrl;
        $('cam-count').value = String(s.camCount);
        fillCameras(s);
        $('conf').value = s.threshold;
        $('cooldown').value = s.cooldown;
        typeBoxes.forEach(function (cb) { cb.checked = !!s.types[cb.getAttribute('data-type')]; });
        $('t-banner').checked = !!s.banner;
        $('t-sound').checked = !!s.sound;
        $('volume').value = s.volume;
        $('t-labels').checked = !!s.labels;
        $('border').value = String(s.border);
        $('per-page').value = String(s.perPage);
        syncOutputs();
        syncCamRows();
    }

    /* ---------- камеры ---------- */

    var camRows = $('cam-rows');
    var MAX = store.MAX_CAMERAS;
    for (var i = 1; i <= MAX; i++) {
        camRows.appendChild(NS.h('div', { class: 'cam_row', 'data-cam': i }, [
            NS.h('span', { class: 'cam_num', text: String(i) }),
            NS.h('input', { class: 'input', type: 'text', 'data-role': 'name', placeholder: 'Камера ' + i, spellcheck: 'false', 'aria-label': 'Название камеры ' + i }),
            NS.h('input', { class: 'input', type: 'text', 'data-role': 'src', placeholder: 'video/cam' + i + '.mp4 или rtsp://логин:пароль@IP:554/поток', spellcheck: 'false', 'aria-label': 'Адрес видео камеры ' + i })
        ]));
    }

    function fillCameras(s) {
        Array.prototype.forEach.call(camRows.children, function (row, idx) {
            var c = s.cameras[idx] || {};
            row.querySelector('[data-role="name"]').value = c.name || '';
            row.querySelector('[data-role="src"]').value = c.src || '';
        });
    }

    function readCameras() {
        return Array.prototype.map.call(camRows.children, function (row) {
            return {
                name: row.querySelector('[data-role="name"]').value.trim(),
                src:  row.querySelector('[data-role="src"]').value.trim()
            };
        });
    }

    function syncCamRows() {
        var n = Number($('cam-count').value);
        Array.prototype.forEach.call(camRows.children, function (row, idx) { row.hidden = idx >= n; });
    }

    function read() {
        var types = {};
        typeBoxes.forEach(function (cb) { types[cb.getAttribute('data-type')] = cb.checked; });
        return {
            wsUrl:     $('ws-url').value.trim(),
            camCount:  Number($('cam-count').value),
            cameras:   readCameras(),
            threshold: Number($('conf').value),
            cooldown:  Number($('cooldown').value),
            types:     types,
            banner:    $('t-banner').checked,
            sound:     $('t-sound').checked,
            volume:    Number($('volume').value),
            labels:    $('t-labels').checked,
            border:    Number($('border').value),
            perPage:   Number($('per-page').value)
        };
    }

    function syncOutputs() {
        $('conf-out').textContent = $('conf').value + '%';
        $('cooldown-out').textContent = $('cooldown').value + ' с';
        $('volume-out').textContent = $('volume').value + '%';
    }

    $('conf').addEventListener('input', syncOutputs);
    $('cooldown').addEventListener('input', syncOutputs);
    $('volume').addEventListener('input', syncOutputs);
    $('cam-count').addEventListener('change', syncCamRows);

    /* ---------- сохранить / сбросить ---------- */

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var s = read();

        if (s.wsUrl && !/^wss?:\/\//i.test(s.wsUrl)) {
            NS.toast('Адрес сервера должен начинаться с ws:// или wss://', 4500);
            $('ws-url').focus();
            return;
        }
        // rtsp:// теперь можно: поток читает бэкенд. Проверяем только, что адрес похож на rtsp://хост/…
        var badRtsp = s.cameras.slice(0, s.camCount).findIndex(function (c) {
            return /^rtsps?:/i.test(c.src) && !/^rtsps?:\/\/[^\s\/]+/i.test(c.src);
        });
        if (badRtsp >= 0) {
            NS.toast('Камера ' + (badRtsp + 1) + ': адрес должен быть вида rtsp://логин:пароль@192.168.1.10:554/поток', 6000);
            return;
        }

        store.saveSettings(s);
        NS.toast('Настройки сохранены');
    });

    form.addEventListener('reset', function (e) {
        e.preventDefault();
        fill(store.DEFAULTS);
        NS.toast('Подставлены значения по умолчанию. Нажмите «Сохранить», чтобы применить.', 4500);
    });

    /* ---------- проверка соединения ---------- */

    function setStatus(id, state, text) {
        var el = $(id);
        el.className = 'status' + (state ? ' status_' + state : '');
        el.querySelector('.status_text').textContent = text;
    }

    function setTestStatus(state, text) { setStatus('test-status', state, text); }

    /* ---------- проверка RTSP-камер ---------- */
    // Берёт адреса прямо из формы (даже несохранённые) и просит бэкенд подключиться к каждой камере и прочитать кадр.

    $('test-rtsp').addEventListener('click', function () {
        var wsUrl = $('ws-url').value.trim();
        var n = Number($('cam-count').value);
        var list = [];
        readCameras().slice(0, n).forEach(function (c, i) {
            if (NS.isRtsp(c.src)) { list.push({ num: i + 1, url: c.src }); }
        });

        if (!list.length) { setStatus('rtsp-status', 'offline', 'Нет камер с адресом rtsp://'); return; }
        if (!NS.apiBase(wsUrl)) { setStatus('rtsp-status', 'offline', 'Сначала укажите адрес WebSocket бэкенда'); return; }

        var btn = $('test-rtsp');
        btn.disabled = true;
        var results = [];
        var okCount = 0;

        // по очереди, чтобы не грузить сервер и показывать понятный прогресс
        list.reduce(function (chain, cam) {
            return chain.then(function () {
                setStatus('rtsp-status', 'wait', 'Проверка камеры ' + cam.num + ' (' + (results.length + 1) + ' из ' + list.length + ')…');
                return NS.rtsp.test(cam.url, wsUrl).then(function (r) {
                    if (r.ok) { okCount++; results.push('Камера ' + cam.num + ': работает, ' + r.width + '×' + r.height); }
                    else { results.push('Камера ' + cam.num + ': ' + (r.error || 'ошибка')); }
                }, function (err) {
                    results.push('Камера ' + cam.num + ': ' + err.message);
                });
            });
        }, Promise.resolve()).then(function () {
            btn.disabled = false;
            setStatus('rtsp-status', okCount === list.length ? 'online' : 'offline', results.join(' · '));
        });
    });

    $('test-conn').addEventListener('click', function () {
        var url = $('ws-url').value.trim();

        if (!/^wss?:\/\//i.test(url)) {
            setTestStatus('offline', 'Адрес должен начинаться с ws:// или wss://');
            return;
        }

        setTestStatus('wait', 'Проверка…');
        var finished = false;
        var ws;

        try { ws = new WebSocket(url); }
        catch (err) { setTestStatus('offline', 'Неверный адрес'); return; }

        var timer = setTimeout(function () {
            if (finished) { return; }
            finished = true;
            try { ws.close(); } catch (err) { /* ничего */ }
            setTestStatus('offline', 'Нет ответа за 4 секунды');
        }, 4000);

        ws.onopen = function () {
            if (finished) { return; }
            finished = true;
            clearTimeout(timer);
            setTestStatus('online', 'Соединение установлено');
            ws.close();
        };

        ws.onerror = function () {
            if (finished) { return; }
            finished = true;
            clearTimeout(timer);
            setTestStatus('offline', 'Не удалось подключиться');
        };
    });

    /* ---------- тестовая тревога ---------- */
    // Берёт значения прямо из формы, даже если они ещё не сохранены.

    $('test-alarm').addEventListener('click', function () {
        NS.sound.unlock();
        var wantSound = $('t-sound').checked;
        var res = NS.alarm('Тестовая тревога — в журнал не записывается', {
            forceBanner: true,
            forceSound: wantSound,
            volume: Number($('volume').value)
        });

        if (!wantSound) { NS.toast('Звук выключен: включите «Звуковой сигнал», чтобы проверить его.', 4500); }
        else if (!res.sound) { NS.toast('Звук ещё не готов. Кликните по странице и повторите.', 4500); }
    });

    /* ---------- старт ---------- */
    fill(store.getSettings());
})();