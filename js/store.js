/* =====================================================================
   store.js — хранилище: настройки и журнал нарушений (localStorage).
   Подключается ПЕРВЫМ на каждой странице, где нужен JS.
   Всё лежит в глобальном объекте window.Maboy.
   ===================================================================== */
(function () {
    'use strict';

    var NS = (window.Maboy = window.Maboy || {});

    var KEY_SET  = 'maboy.settings';
    var KEY_LOG  = 'maboy.violations';
    var KEY_SEQ  = 'maboy.seq';
    var KEY_SEED = 'maboy.seeded';

    var MAX_CAMERAS = 9;   // сколько камер максимум (сетка 3×3)
    var MAX_ITEMS  = 500;  // сколько записей хранить в журнале
    var MAX_FRAMES = 30;   // у скольких последних записей хранить кадр (они тяжёлые)

    // Виды нарушений, которые сейчас распознаёт система. Остальные подписи оставлены,
    // чтобы старые записи журнала и будущие типы отображались нормально.
    var ACTIVE_TYPES = ['no_helmet', 'fall'];

    var TYPES = {
        no_helmet:     'Нет каски',
        fall:          'Падение',
        no_respirator: 'Снят респиратор',
        danger_zone:   'Опасная зона',
        smoking:       'Курение',
        manual:        'Ручная тревога'
    };

    var STATUSES = {
        'new':   'Новое',
        'ok':    'Подтверждено',
        'false': 'Ложное'
    };

    var DEFAULTS = {
        wsUrl:     'ws://localhost:8000/ws/stream',
        source:    'file',      // file | rtsp | webcam
        rtsp:      '',
        threshold: 70,          // порог уверенности, %
        types:     { no_helmet: true, fall: true },
        banner:    true,        // красная плашка
        sound:     false,       // звуковой сигнал
        volume:    60,
        labels:    true,        // подписи на рамках
        border:    3,           // толщина рамки, px
        perPage:   20,          // строк в журнале
        cooldown:  5,           // пауза, сек: одно и то же нарушение в журнал не чаще
        camCount:  9,           // сколько камер показывать на Мониторе (1..9)
        cameras:   []           // [{ name, src }] — название и адрес видео для каждой камеры
    };

    /* ---------- работа с localStorage (не падаем, если он недоступен) ---------- */

    function readJSON(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    function emit(what) {
        window.dispatchEvent(new CustomEvent('maboy:change', { detail: { what: what } }));
    }

    /* ---------- форматирование ---------- */

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function formatTime(ts) {
        var d = new Date(ts);
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function formatDate(ts) {
        var d = new Date(ts);
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + formatTime(ts);
    }

    // «2026-10-22» в местном времени (для фильтра по датам и счётчика «сегодня»)
    function dayKey(ts) {
        var d = new Date(ts);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function typeLabel(key) { return TYPES[key] || String(key); }

    function cameraLabel(c) { return (c === null || c === undefined || c === '') ? 'Вручную' : 'Камера ' + c; }

    /* ---------- настройки ---------- */

    function getSettings() {
        var saved = readJSON(KEY_SET, {}) || {};
        var s = {};
        Object.keys(DEFAULTS).forEach(function (k) {
            s[k] = (k in saved) ? saved[k] : DEFAULTS[k];
        });
        s.types = Object.assign({}, DEFAULTS.types, saved.types || {});
        s.threshold = Number(s.threshold);
        s.volume    = Number(s.volume);
        s.border    = Number(s.border);
        s.perPage   = Number(s.perPage);
        s.cooldown  = Number(s.cooldown);
        s.camCount  = Math.max(1, Math.min(MAX_CAMERAS, Math.round(Number(s.camCount)) || DEFAULTS.camCount));
        if (!Array.isArray(s.cameras)) { s.cameras = []; }
        return s;
    }

    // Список камер для Монитора и Журнала: [{ id: 1, name: 'Камера 1', src: '' }, ...]
    function cameraList(s) {
        s = s || getSettings();
        var out = [];
        for (var i = 1; i <= s.camCount; i++) {
            var c = s.cameras[i - 1] || {};
            out.push({ id: i, name: String(c.name || '').trim() || ('Камера ' + i), src: String(c.src || '').trim() });
        }
        return out;
    }

    function saveSettings(patch) {
        var next = Object.assign(getSettings(), patch || {});
        writeJSON(KEY_SET, next);
        emit('settings');
        return next;
    }

    /* ---------- журнал нарушений ---------- */

    var cache = null;

    function getViolations() {
        if (cache === null) {
            var arr = readJSON(KEY_LOG, []);
            cache = Array.isArray(arr) ? arr : [];
        }
        return cache;
    }

    // копия, отсортированная от новых к старым
    function sorted() {
        return getViolations().slice().sort(function (a, b) {
            return new Date(b.ts) - new Date(a.ts);
        });
    }

    function persist(list) {
        if (list.length > MAX_ITEMS) { list.length = MAX_ITEMS; }

        // кадры храним только у самых свежих записей
        var withFrames = 0;
        list.forEach(function (v) {
            if (v.frame && ++withFrames > MAX_FRAMES) { v.frame = null; }
        });

        cache = list;
        if (writeJSON(KEY_LOG, list)) { return true; }

        // не влезло в localStorage: оставляем кадры только у 5 последних
        var n = 0;
        list.forEach(function (v) {
            if (v.frame && ++n > 5) { v.frame = null; }
        });
        if (writeJSON(KEY_LOG, list)) { return true; }

        // всё ещё не влезло: убираем кадры совсем
        list.forEach(function (v) { v.frame = null; });
        return writeJSON(KEY_LOG, list);
    }

    function nextId() {
        var max = 0;
        getViolations().forEach(function (v) { if (v.id > max) { max = v.id; } });
        var seq = 0;
        try { seq = Number(localStorage.getItem(KEY_SEQ)) || 0; } catch (e) { /* ничего */ }
        seq = Math.max(seq, max) + 1;
        try { localStorage.setItem(KEY_SEQ, String(seq)); } catch (e) { /* ничего */ }
        return seq;
    }

    // Одно и то же нарушение приходит по WebSocket в КАЖДУЮ открытую вкладку.
    // Чтобы журнал не удваивался, запись с теми же камерой, типом, рамкой и уверенностью
    // в пределах 3 секунд считается дублем. Ручная тревога под это правило не попадает.
    var DUP_WINDOW_MS = 3000;

    function sameViolation(a, b) {
        if (a.type !== b.type || a.camera !== b.camera) { return false; }
        if (Math.abs(new Date(a.ts) - new Date(b.ts)) > DUP_WINDOW_MS) { return false; }
        if (Math.abs(a.confidence - b.confidence) > 0.005) { return false; }
        var ab = a.bbox, bb = b.bbox;
        if (!ab || !bb) { return !ab && !bb; }
        return ab.every(function (n, i) { return Math.abs(n - bb[i]) < 0.002; });
    }

    // Возвращает { record, duplicate }
    function addViolation(v) {
        cache = null;   // читаем свежие данные: другая вкладка могла записать то же самое миг назад
        var list = getViolations().slice();
        var rec = {
            id:         0,
            ts:         v.ts || new Date().toISOString(),
            camera:     (v.camera === null || v.camera === undefined) ? null : Number(v.camera),
            type:       v.type,
            confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
            status:     'new',
            bbox:       v.bbox || null,   // [x, y, w, h] в долях кадра (0..1)
            frame:      v.frame || null,  // JPEG в виде data:-ссылки
            ar:         v.ar || null,     // соотношение сторон кадра
            // секунда видео, на которой замечено нарушение (по ней журнал перематывает Монитор)
            videoTime:  (v.videoTime === null || v.videoTime === undefined || isNaN(Number(v.videoTime))) ? null : Math.round(Number(v.videoTime) * 10) / 10
        };

        if (rec.type !== 'manual') {
            for (var i = 0; i < list.length && i < 30; i++) {
                if (sameViolation(list[i], rec)) {
                    // у дубля есть кадр, а у записи нет — дополняем запись
                    if (!list[i].frame && rec.frame) {
                        list[i].frame = rec.frame;
                        list[i].ar = rec.ar;
                        persist(list);
                        emit('violations');
                    }
                    return { record: list[i], duplicate: true };
                }
            }
        }

        rec.id = nextId();
        list.unshift(rec);
        persist(list);
        emit('violations');
        return { record: rec, duplicate: false };
    }

    function setStatus(id, status) {
        cache = null;
        var list = getViolations().slice();
        var found = false;
        list.forEach(function (v) {
            if (v.id === id) { v.status = status; found = true; }
        });
        if (found) {
            persist(list);
            emit('violations');
        }
    }

    function clearViolations() {
        persist([]);
        emit('violations');
    }

    function newCount() {
        return getViolations().filter(function (v) { return v.status === 'new'; }).length;
    }

    function todayCount() {
        var today = dayKey(Date.now());
        return getViolations().filter(function (v) { return dayKey(v.ts) === today; }).length;
    }

    /* ---------- демо-данные при первом запуске ---------- */

    function seedIfNeeded() {
        try {
            if (localStorage.getItem(KEY_SEED)) { return; }
        } catch (e) { return; }

        if (getViolations().length === 0) {
            var keys = ACTIVE_TYPES;
            var t = Date.now() - 6 * 60000;
            var out = [];

            for (var i = 0; i < 26; i++) {
                var conf = 0.5 + Math.random() * 0.47;
                var status;
                if (i < 3)                        { status = 'new'; }
                else if (conf < 0.62)             { status = Math.random() < 0.6 ? 'false' : 'ok'; }
                else                              { status = Math.random() < 0.9 ? 'ok' : 'false'; }

                var w = 0.1 + Math.random() * 0.08;
                var h = 0.3 + Math.random() * 0.15;
                out.push({
                    ts:         new Date(t).toISOString(),
                    camera:     1 + Math.floor(Math.random() * 3),
                    type:       keys[Math.floor(Math.random() * keys.length)],
                    confidence: Math.round(conf * 100) / 100,
                    status:     status,
                    bbox:       [0.05 + Math.random() * (0.9 - w), 0.08 + Math.random() * (0.84 - h), w, h],
                    frame:      null,
                    ar:         null,
                    demo:       true
                });
                t -= (25 + Math.random() * 130) * 60000;
            }

            var seq = 0;
            for (var j = out.length - 1; j >= 0; j--) { out[j].id = ++seq; }
            writeJSON(KEY_SEQ, seq);
            persist(out);
        }

        try { localStorage.setItem(KEY_SEED, '1'); } catch (e) { /* ничего */ }
    }

    /* ---------- изменения из других вкладок ---------- */

    window.addEventListener('storage', function (e) {
        if (e.key === KEY_LOG) { cache = null; emit('violations'); }
        if (e.key === KEY_SET) { emit('settings'); }
    });

    NS.store = {
        TYPES: TYPES,
        STATUSES: STATUSES,
        DEFAULTS: DEFAULTS,
        getSettings: getSettings,
        saveSettings: saveSettings,
        getViolations: getViolations,
        sorted: sorted,
        addViolation: addViolation,
        setStatus: setStatus,
        clearViolations: clearViolations,
        newCount: newCount,
        todayCount: todayCount,
        seedIfNeeded: seedIfNeeded,
        formatTime: formatTime,
        formatDate: formatDate,
        dayKey: dayKey,
        typeLabel: typeLabel,
        ACTIVE_TYPES: ACTIVE_TYPES,
        cameraLabel: cameraLabel,
        cameraList: cameraList,
        MAX_CAMERAS: MAX_CAMERAS
    };

    // Демо-записи нужны к моменту первой отрисовки страницы, поэтому сеем сразу при загрузке файла.
    seedIfNeeded();
})();