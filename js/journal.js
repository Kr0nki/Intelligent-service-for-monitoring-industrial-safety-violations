/* =====================================================================
   journal.js — страница «Журнал»:
     • таблица из журнала (localStorage), фильтры, поиск, пагинация
     • «Подтвердить» / «Ложное», просмотр кадра, экспорт в CSV, очистка
   ===================================================================== */
(function () {
    'use strict';

    var NS = window.Maboy;
    var store = NS.store;
    var h = NS.h;
    var $ = function (id) { return document.getElementById(id); };

    var form = $('filters');
    var body = $('journal-body');
    var pagination = $('pagination');
    var page = 1;

    /* ---------- фильтры ---------- */

    function readFilters() {
        return {
            q:      $('f-search').value.trim().toLowerCase(),
            type:   $('f-type').value,
            status: $('f-status').value,
            camera: $('f-camera').value,
            from:   $('f-from').value,   // «2026-10-22»
            to:     $('f-to').value
        };
    }

    function matches(v, f) {
        if (f.type && v.type !== f.type) { return false; }
        if (f.status && v.status !== f.status) { return false; }
        if (f.camera) {
            if (f.camera === 'manual') { if (v.camera !== null && v.camera !== undefined) { return false; } }
            else if (String(v.camera) !== f.camera) { return false; }
        }
        var day = store.dayKey(v.ts);
        if (f.from && day < f.from) { return false; }
        if (f.to && day > f.to) { return false; }
        if (f.q) {
            var hay = [v.id, store.typeLabel(v.type), store.cameraLabel(v.camera),
                       store.STATUSES[v.status], store.formatDate(v.ts)].join(' ').toLowerCase();
            if (hay.indexOf(f.q) < 0) { return false; }
        }
        return true;
    }

    function getFiltered() {
        var f = readFilters();
        return store.sorted().filter(function (v) { return matches(v, f); });
    }

    /* ---------- таблица ---------- */

    function confidenceCell(v) {
        if (v.type === 'manual') { return h('td', { text: '—' }); }
        var pct = Math.round(v.confidence * 100);
        return h('td', null, [
            h('span', { class: 'conf' }, [
                h('span', { class: 'conf_bar' + (pct < 60 ? ' conf_low' : ''), style: 'width:' + pct + '%' })
            ]),
            h('span', { class: 'conf_num', text: pct + '%' })
        ]);
    }

    function actionButtons(v) {
        var kids = [];
        if (v.status !== 'ok') {
            kids.push(h('button', { type: 'button', class: 'btn_tool btn_small', 'data-action': 'ok', 'data-id': v.id, text: 'Подтвердить' }));
        }
        if (v.status !== 'false') {
            kids.push(h('button', { type: 'button', class: 'btn_tool btn_small btn_danger', 'data-action': 'false', 'data-id': v.id, text: 'Ложное' }));
        }
        return kids;
    }

    function renderRow(v) {
        return h('tr', { class: v.status === 'new' ? 'row_new' : '' }, [
            h('td', { text: String(v.id) }),
            h('td', { text: store.formatDate(v.ts) }),
            h('td', { text: store.cameraLabel(v.camera) }),
            h('td', { text: store.typeLabel(v.type) }),
            confidenceCell(v),
            h('td', null, [h('span', { class: 'badge_status badge_' + v.status, text: store.STATUSES[v.status] })]),
            h('td', null, [h('a', { href: '#frame', class: 'frame_link', 'data-id': v.id, text: 'Открыть' })]),
            h('td', { class: 'actions' }, actionButtons(v))
        ]);
    }

    function render() {
        var all = getFiltered();

        // счётчики по текущей выборке
        var counts = { 'new': 0, ok: 0, 'false': 0 };
        all.forEach(function (v) { counts[v.status]++; });
        $('sum-total').textContent = all.length;
        $('sum-new').textContent = counts['new'];
        $('sum-ok').textContent = counts.ok;
        $('sum-false').textContent = counts['false'];

        // страницы
        var per = store.getSettings().perPage || 20;
        var pages = Math.max(1, Math.ceil(all.length / per));
        page = Math.min(Math.max(1, page), pages);
        var slice = all.slice((page - 1) * per, page * per);

        body.textContent = '';
        if (!slice.length) {
            body.appendChild(h('tr', null, [
                h('td', { colspan: 8, class: 'empty_cell', text: store.getViolations().length ? 'По этим фильтрам ничего не найдено' : 'Журнал пуст' })
            ]));
        } else {
            slice.forEach(function (v) { body.appendChild(renderRow(v)); });
        }

        renderPagination(pages);
    }

    /* ---------- пагинация ---------- */

    function renderPagination(total) {
        pagination.textContent = '';
        if (total <= 1) { return; }

        function link(n, text, extra) {
            return h('a', Object.assign({
                href: '#', class: 'page_link' + (n === page && !extra ? ' page_current' : ''),
                'data-page': n, text: text
            }, extra || {}));
        }

        pagination.appendChild(link(page - 1, '←', { 'aria-label': 'Назад', 'aria-disabled': page <= 1 ? 'true' : null }));

        var nums = [1, page - 1, page, page + 1, total].filter(function (n, i, a) {
            return n >= 1 && n <= total && a.indexOf(n) === i;
        }).sort(function (a, b) { return a - b; });

        var prev = 0;
        nums.forEach(function (n) {
            if (n - prev > 1) { pagination.appendChild(h('span', { class: 'page_dots', text: '…' })); }
            var a = link(n, String(n));
            if (n === page) { a.setAttribute('aria-current', 'page'); }
            pagination.appendChild(a);
            prev = n;
        });

        pagination.appendChild(link(page + 1, '→', { 'aria-label': 'Вперёд', 'aria-disabled': page >= total ? 'true' : null }));
    }

    pagination.addEventListener('click', function (e) {
        var a = e.target.closest('a[data-page]');
        if (!a) { return; }
        e.preventDefault();
        page = Number(a.getAttribute('data-page'));
        render();
    });

    /* ---------- действия в таблице ---------- */

    body.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (btn) {
            store.setStatus(Number(btn.getAttribute('data-id')), btn.getAttribute('data-action'));
            return;   // таблица перерисуется по событию maboy:change
        }
        var link = e.target.closest('.frame_link');
        if (link) {
            e.preventDefault();
            openFrame(Number(link.getAttribute('data-id')));
        }
    });

    /* ---------- окно с кадром ---------- */

    function openFrame(id) {
        var v = store.getViolations().filter(function (x) { return x.id === id; })[0];
        if (!v) { return; }

        var photo = $('modal-photo');
        photo.textContent = '';
        photo.style.aspectRatio = v.ar ? String(v.ar) : '16 / 9';

        if (v.frame) {
            photo.appendChild(h('img', { src: v.frame, alt: 'Кадр нарушения' }));
        } else {
            photo.appendChild(h('span', {
                text: v.demo ? 'Демо-запись: кадра нет' : 'Кадр не сохранён (видео не было запущено)'
            }));
        }

        if (v.bbox) {
            var label = store.typeLabel(v.type) + ' · ' + Math.round(v.confidence * 100) + '%';
            photo.appendChild(h('div', {
                class: 'demo_box',
                style: 'left:' + v.bbox[0] * 100 + '%;top:' + v.bbox[1] * 100 + '%;width:' + v.bbox[2] * 100 + '%;height:' + v.bbox[3] * 100 + '%'
            }, [h('span', { class: 'demo_tag', text: label })]));
        }

        var info = [store.cameraLabel(v.camera), store.formatDate(v.ts), store.typeLabel(v.type)];
        if (v.type !== 'manual') { info.push('уверенность ' + Math.round(v.confidence * 100) + '%'); }
        $('modal-info').textContent = info.join(' · ');

        location.hash = 'frame';
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && location.hash === '#frame') { location.hash = ''; }
    });

    /* ---------- экспорт в CSV ---------- */

    function csvCell(value) {
        var s = String(value);
        return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    $('btn-export').addEventListener('click', function () {
        var rows = getFiltered();
        if (!rows.length) { NS.toast('Нечего экспортировать: выборка пуста.'); return; }

        var lines = [['№', 'Дата и время', 'Камера', 'Тип нарушения', 'Уверенность, %', 'Статус'].join(';')];
        rows.forEach(function (v) {
            lines.push([
                v.id,
                store.formatDate(v.ts),
                store.cameraLabel(v.camera),
                store.typeLabel(v.type),
                v.type === 'manual' ? '' : Math.round(v.confidence * 100),
                store.STATUSES[v.status]
            ].map(csvCell).join(';'));
        });

        // BOM в начале, чтобы Excel правильно показал русские буквы
        var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = h('a', { href: url, download: 'journal_' + store.dayKey(Date.now()) + '.csv' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        NS.toast('Экспортировано строк: ' + rows.length);
    });

    /* ---------- очистка ---------- */

    $('btn-clear').addEventListener('click', function () {
        if (!store.getViolations().length) { NS.toast('Журнал уже пуст.'); return; }
        if (window.confirm('Удалить все записи журнала? Это действие нельзя отменить.')) {
            store.clearViolations();
            NS.toast('Журнал очищен.');
        }
    });

    /* ---------- события формы и обновления ---------- */

    // Перерисовываем таблицу, только если фильтры правда изменились. Иначе при клике по кнопке в таблице
    // поле поиска теряет фокус, срабатывает «change», таблица перерисовывается между нажатием и
    // отпусканием кнопки мыши — и сам клик пропадает.
    var lastSig = JSON.stringify(readFilters());

    function onFiltersChanged() {
        var sig = JSON.stringify(readFilters());
        if (sig === lastSig) { return; }
        lastSig = sig;
        page = 1;
        render();
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); onFiltersChanged(); });
    form.addEventListener('input', onFiltersChanged);
    form.addEventListener('change', onFiltersChanged);
    form.addEventListener('reset', function () { setTimeout(onFiltersChanged, 0); });

    // новые нарушения, смена статуса, изменение настроек (в том числе в другой вкладке)
    window.addEventListener('maboy:change', render);

    if (location.hash === '#frame') { location.hash = ''; }   // после обновления страницы окно пустое — закрываем
    render();
})();
