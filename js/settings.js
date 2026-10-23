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
        $('source').value = s.source;
        $('rtsp').value = s.rtsp;
        $('conf').value = s.threshold;
        typeBoxes.forEach(function (cb) { cb.checked = !!s.types[cb.getAttribute('data-type')]; });
        $('t-banner').checked = !!s.banner;
        $('t-sound').checked = !!s.sound;
        $('volume').value = s.volume;
        $('t-labels').checked = !!s.labels;
        $('border').value = String(s.border);
        $('per-page').value = String(s.perPage);
        syncOutputs();
        syncSource();
    }

    function read() {
        var types = {};
        typeBoxes.forEach(function (cb) { types[cb.getAttribute('data-type')] = cb.checked; });
        return {
            wsUrl:     $('ws-url').value.trim(),
            source:    $('source').value,
            rtsp:      $('rtsp').value.trim(),
            threshold: Number($('conf').value),
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
        $('volume-out').textContent = $('volume').value + '%';
    }

    var hints = {
        file:   'В режиме «Видеофайл» адрес не нужен: файл выбирается на странице «Монитор».',
        rtsp:   'Браузер не умеет играть rtsp:// напрямую. Укажите http(s)-адрес, который отдаёт бэкенд (mp4, MJPEG или HLS).',
        webcam: 'Используется веб-камера этого компьютера, адрес не нужен.'
    };

    function syncSource() {
        var src = $('source').value;
        $('rtsp').disabled = (src !== 'rtsp');
        $('source-hint').textContent = hints[src] || '';
    }

    $('conf').addEventListener('input', syncOutputs);
    $('volume').addEventListener('input', syncOutputs);
    $('source').addEventListener('change', syncSource);

    /* ---------- сохранить / сбросить ---------- */

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var s = read();

        if (s.wsUrl && !/^wss?:\/\//i.test(s.wsUrl)) {
            NS.toast('Адрес сервера должен начинаться с ws:// или wss://', 4500);
            $('ws-url').focus();
            return;
        }
        if (s.source === 'rtsp' && !s.rtsp) {
            NS.toast('Для режима «Поток камеры» укажите адрес потока.', 4500);
            $('rtsp').focus();
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

    function setTestStatus(state, text) {
        var el = $('test-status');
        el.className = 'status' + (state ? ' status_' + state : '');
        el.querySelector('.status_text').textContent = text;
    }

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
