/* =====================================================================
   common.js — общее для всех страниц:
     • индикатор связи и WebSocket (с автопереподключением)
     • кнопка «Тревога», красная плашка, звук
     • красный счётчик новых нарушений на кнопке «Журнал»
     • всплывающие подсказки (toast)
   Подключается ПОСЛЕ store.js и ДО скрипта страницы.

   ─── Что должен присылать бэкенд по WebSocket (JSON) ───────────────
   1) Нарушение (попадает в журнал, включает тревогу):
      {
        "event": "violation",
        "type": "no_helmet",          // no_helmet | no_respirator | danger_zone | smoking
        "camera": 1,
        "confidence": 0.91,           // 0..1
        "bbox": [x, y, w, h],         // в пикселях кадра ИЛИ в долях 0..1
        "frame_w": 1280, "frame_h": 720,   // нужны, если bbox в пикселях
        "ts": "2026-10-22T14:52:08",  // необязательно
        "image": "<base64 jpeg>"      // необязательно: кадр-доказательство
      }
   2) Рамки на текущем кадре (только рисуются поверх видео, в журнал не идут):
      { "event": "frame", "frame_w": 1280, "frame_h": 720,
        "boxes": [ { "bbox": [x, y, w, h], "label": "Каска: нет", "confidence": 0.9 } ] }
   ===================================================================== */
(function () {
    'use strict';

    var NS = (window.Maboy = window.Maboy || {});
    var store = NS.store;

    function ready(fn) {
        if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', fn); }
        else { fn(); }
    }
    NS.ready = ready;

    /* ---------- маленький помощник для создания элементов ---------- */
    // h('td', { class: 'x', text: 'привет' }, [дети])  — безопасно, без innerHTML
    function h(tag, attrs, kids) {
        var el = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                var v = attrs[k];
                if (v === null || v === undefined || v === false) { return; }
                if (k === 'class')      { el.className = v; }
                else if (k === 'text')  { el.textContent = v; }
                else if (k === 'style') { el.style.cssText = v; }
                else if (k.indexOf('data-') === 0 || k.indexOf('aria-') === 0) { el.setAttribute(k, v); }
                else if (k in el)       { el[k] = v; }
                else                    { el.setAttribute(k, v); }
            });
        }
        (kids || []).forEach(function (c) {
            if (c === null || c === undefined) { return; }
            el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return el;
    }
    NS.h = h;

    /* ---------- toast: короткое сообщение внизу экрана ---------- */
    var toastEl = null, toastTimer = null;

    NS.toast = function (msg, ms) {
        if (!toastEl) {
            toastEl = h('div', { class: 'toast', role: 'status' });
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.classList.add('toast_show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove('toast_show'); }, ms || 3000);
    };

    /* ---------- звук ---------- */
    // Браузер разрешает звук только после клика пользователя, поэтому
    // «разблокируем» его при первом клике/нажатии на странице.
    var audioCtx = null, unlocked = false;

    function ensureAudio() {
        if (!audioCtx) {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { return null; }
            audioCtx = new AC();
        }
        if (audioCtx.state === 'suspended') { audioCtx.resume(); }
        return audioCtx;
    }

    function unlockAudio() {
        unlocked = true;
        ensureAudio();
    }

    ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
        document.addEventListener(evt, function once() {
            unlockAudio();
            document.removeEventListener(evt, once);
        });
    });

    function playSiren(volume) {
        if (!unlocked || !audioCtx || audioCtx.state !== 'running') { return false; }
        var vol = Math.max(0, Math.min(1, Number(volume) / 100)) * 0.35;
        if (vol <= 0) { return true; }
        var t0 = audioCtx.currentTime + 0.02;
        for (var i = 0; i < 4; i++) {
            var osc = audioCtx.createOscillator();
            var gain = audioCtx.createGain();
            var start = t0 + i * 0.22;
            osc.type = 'square';
            osc.frequency.value = (i % 2 === 0) ? 880 : 660;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(vol, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(start);
            osc.stop(start + 0.22);
        }
        return true;
    }

    NS.sound = {
        unlock: unlockAudio,
        play: playSiren,
        isReady: function () { return unlocked && !!audioCtx && audioCtx.state === 'running'; }
    };

    /* ---------- красная плашка и тревога ---------- */
    var banner = null, bannerTimer = null, baseTitle = document.title;

    function getBanner() {
        if (banner) { return banner; }
        banner = document.getElementById('alert-banner');
        if (!banner) {
            banner = h('div', { class: 'alert_banner', id: 'alert-banner', role: 'alert', hidden: true }, [
                h('strong', { text: '⚠ Нарушение!' }),
                h('span', { id: 'alert-text' }),
                h('button', { type: 'button', class: 'alert_close', 'aria-label': 'Закрыть', text: '✕' })
            ]);
            var header = document.querySelector('header');
            if (header) { header.insertAdjacentElement('afterend', banner); }
            else { document.body.insertBefore(banner, document.body.firstChild); }
        }
        var close = banner.querySelector('.alert_close');
        if (close) { close.addEventListener('click', hideBanner); }
        return banner;
    }

    function hideBanner() {
        if (!banner) { return; }
        banner.hidden = true;
        document.title = baseTitle;
        clearTimeout(bannerTimer);
    }

    function showBanner(text) {
        var b = getBanner();
        var header = document.querySelector('header');
        // плашка «прилипает» сразу под закреплённой шапкой
        b.style.top = (header ? header.offsetHeight : 0) + 'px';
        var span = b.querySelector('#alert-text');
        if (span) { span.textContent = text; }
        b.hidden = false;
        document.title = '⚠ ' + baseTitle;
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(hideBanner, 12000);
    }

    /**
     * Включить тревогу: плашка + звук (по настройкам).
     * opts: forceBanner, forceSound, volume — для кнопок «Тревога» и «Тестовая тревога».
     * Возвращает { banner: bool, sound: bool }.
     */
    NS.alarm = function (text, opts) {
        opts = opts || {};
        var s = store.getSettings();
        var res = { banner: false, sound: false };
        if (s.banner || opts.forceBanner) { showBanner(text); res.banner = true; }
        if (s.sound || opts.forceSound) {
            res.sound = playSiren(opts.volume !== undefined ? opts.volume : s.volume);
        }
        return res;
    };

    /* ---------- разбор данных от бэкенда ---------- */

    function normType(t) {
        if (store.TYPES[t]) { return t; }
        var low = String(t || '').toLowerCase();
        var found = null;
        Object.keys(store.TYPES).forEach(function (k) {
            if (store.TYPES[k].toLowerCase() === low) { found = k; }
        });
        return found || String(t);
    }

    // [x, y, w, h] в пикселях или долях → всегда в долях 0..1
    function normBBox(bb, fw, fh) {
        if (!Array.isArray(bb) || bb.length < 4) { return null; }
        var a = bb.slice(0, 4).map(Number);
        if (a.some(isNaN)) { return null; }
        if (Math.max(a[0], a[1], a[2], a[3]) <= 1.0001) { return a; }
        if (fw && fh) { return [a[0] / fw, a[1] / fh, a[2] / fw, a[3] / fh]; }
        return null;
    }

    function normConf(c) {
        c = Number(c);
        if (isNaN(c)) { return 0; }
        return c > 1 ? c / 100 : c;
    }

    /**
     * Зарегистрировать нарушение: проверить настройки (порог, включённые типы),
     * записать в журнал, включить тревогу, сообщить монитору (нарисовать рамку).
     * Возвращает запись журнала или null, если нарушение отфильтровано.
     */
    NS.report = function (raw, opts) {
        opts = opts || {};
        var s = store.getSettings();
        var type = normType(raw.type);
        var conf = normConf(raw.confidence);

        if (type !== 'manual') {
            if (type in s.types && !s.types[type]) { return null; }   // тип отключён в настройках
            if (conf * 100 < s.threshold) { return null; }            // ниже порога уверенности
        }

        var ts = new Date(raw.ts);
        var v = {
            ts:         isNaN(ts) ? new Date().toISOString() : ts.toISOString(),
            camera:     raw.camera,
            type:       type,
            confidence: conf,
            bbox:       raw.bbox ? normBBox(raw.bbox, raw.frame_w, raw.frame_h) : null,
            frame:      null,
            ar:         null
        };

        if (raw.image) {
            v.frame = String(raw.image).indexOf('data:') === 0 ? raw.image : 'data:image/jpeg;base64,' + raw.image;
            if (raw.frame_w && raw.frame_h) { v.ar = raw.frame_w / raw.frame_h; }
        } else if (raw.frame) {
            v.frame = raw.frame;
            v.ar = raw.ar || null;
        } else if (NS.frameProvider) {
            var f = NS.frameProvider();     // страница «Монитор» делает снимок кадра видео
            if (f) { v.frame = f.frame; v.ar = f.ar; }
        }

        var res = store.addViolation(v);   // дубль из другой вкладки в журнал не пишется, но тревогу показываем
        var rec = res.record;
        window.dispatchEvent(new CustomEvent('maboy:violation', { detail: rec }));

        var text = type === 'manual'
            ? 'Ручная тревога'
            : store.typeLabel(type) + ' — ' + store.cameraLabel(v.camera).toLowerCase();
        NS.alarm(text, { forceBanner: !!opts.forceBanner });
        return rec;
    };

    /* ---------- связь с сервером (WebSocket) ---------- */
    var conn = { ws: null, wsState: 'offline', demo: false, retry: 0, timer: null, url: '' };

    function renderConn() {
        var el = document.getElementById('connection');
        var st, text;
        if (conn.wsState === 'online')          { st = 'online';  text = 'Онлайн'; }
        else if (conn.demo)                     { st = 'demo';    text = 'Демо-режим'; }
        else if (conn.wsState === 'connecting') { st = 'wait';    text = 'Подключение…'; }
        else                                    { st = 'offline'; text = 'Нет связи'; }

        if (el) {
            el.className = 'status status_' + st;
            var t = el.querySelector('.status_text');
            if (t) { t.textContent = text; }
            el.title = conn.url ? 'Сервер: ' + conn.url : 'Адрес сервера не задан';
        }
        window.dispatchEvent(new CustomEvent('maboy:conn', { detail: { ws: conn.wsState, state: st } }));
    }

    function handleMessage(m) {
        if (!m || typeof m !== 'object') { return; }

        // рамки на кадре — только рисуем
        if (m.event === 'frame' || (m.boxes && !m.violations)) {
            var boxes = (m.boxes || []).map(function (b) {
                var bb = normBBox(b.bbox, m.frame_w || b.frame_w, m.frame_h || b.frame_h);
                if (!bb) { return null; }
                var label = b.label || '';
                if (label && b.confidence !== undefined) { label += ' · ' + Math.round(normConf(b.confidence) * 100) + '%'; }
                return { x: bb[0], y: bb[1], w: bb[2], h: bb[3], label: label };
            }).filter(Boolean);
            window.dispatchEvent(new CustomEvent('maboy:boxes', { detail: { boxes: boxes } }));
            return;
        }

        // нарушения
        var list = m.violations ? m.violations : [m];
        list.forEach(function (v) {
            if (!v || v.type === undefined) { return; }
            if (m.violations) {
                v = Object.assign({ frame_w: m.frame_w, frame_h: m.frame_h, camera: m.camera }, v);
            }
            NS.report(v);
        });
    }

    function onMessage(ev) {
        var data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        (Array.isArray(data) ? data : [data]).forEach(handleMessage);
    }

    function scheduleRetry() {
        clearTimeout(conn.timer);
        var delay = Math.min(15000, 2000 * Math.pow(2, conn.retry));
        conn.retry++;
        conn.timer = setTimeout(connect, delay);
    }

    function connect() {
        clearTimeout(conn.timer);
        if (conn.ws) {
            conn.ws.onclose = null;
            try { conn.ws.close(); } catch (e) { /* ничего */ }
            conn.ws = null;
        }

        conn.url = (store.getSettings().wsUrl || '').trim();
        if (!conn.url) { conn.wsState = 'offline'; renderConn(); return; }

        var ws;
        try { ws = new WebSocket(conn.url); }
        catch (e) { conn.wsState = 'offline'; renderConn(); scheduleRetry(); return; }

        conn.ws = ws;
        conn.wsState = 'connecting';
        renderConn();

        ws.onopen = function () { conn.wsState = 'online'; conn.retry = 0; renderConn(); };
        ws.onmessage = onMessage;
        ws.onerror = function () { /* за ошибкой всегда идёт onclose */ };
        ws.onclose = function () { conn.wsState = 'offline'; conn.ws = null; renderConn(); scheduleRetry(); };
    }

    NS.conn = {
        state: function () { return conn.wsState; },
        setDemo: function (on) {
            on = !!on;
            if (conn.demo === on) { return; }   // без этой проверки получился бы бесконечный цикл событий
            conn.demo = on;
            renderConn();
        },
        reconnect: function () { conn.retry = 0; connect(); }
    };

    /* ---------- счётчик новых на кнопке «Журнал» ---------- */
    function updateBadge() {
        var link = document.querySelector('.ul_nav a[href$="journal.html"]');
        if (!link) { return; }
        var b = link.querySelector('.nav_badge');
        if (!b) { b = h('span', { class: 'nav_badge' }); link.appendChild(b); }
        var n = store.newCount();
        b.textContent = n > 99 ? '99+' : String(n);
        b.hidden = (n === 0);
    }

    /* ---------- запуск ---------- */
    ready(function () {
        updateBadge();

        var alarmBtn = document.getElementById('alarm-btn');
        if (alarmBtn) {
            alarmBtn.addEventListener('click', function () {
                NS.report({ type: 'manual', camera: null, confidence: 1 }, { forceBanner: true });
            });
        }

        var lastUrl = store.getSettings().wsUrl;
        window.addEventListener('maboy:change', function () {
            updateBadge();
            var url = store.getSettings().wsUrl;
            if (url !== lastUrl) { lastUrl = url; NS.conn.reconnect(); }   // адрес сервера поменяли в настройках
        });

        connect();
    });
})();
