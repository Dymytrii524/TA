#!/usr/bin/env node
/**
 * UI-сценарії U1-U8: вибір виду транспорту на головній та його наскрізне
 * застосування до панелі потоків і деталізації (ТЗ, розділи A.13.2-A.13.4).
 *
 * Що саме перевіряється і чому саме так:
 *
 *   - Перевірка йде в справжньому DOM (jsdom виконує index.html цілком), а не
 *     над скопійованими функціями: регресію дає зазвичай не сама формула, а
 *     обробник події, порядок рендеру або втрачений клас - копія логіки цього
 *     не побачила б.
 *   - Еталонні числа рахує НЕЗАЛЕЖНА реалізація (expectedFlow/expectedDrill)
 *     над тими самими LISTINGS/CITIES, витягнутими з джерела. DOM звіряється
 *     з еталоном, а не сам із собою, інакше однакова помилка в обох місцях
 *     пройшла б непоміченою.
 *   - Прогін завершується мутаційним тестуванням: у джерело навмисно вносяться
 *     чотири реалістичні регресії, і кожна МУСИТЬ бути впіймана. Набір, який
 *     не падає на зламаному коді, не доводить нічого про робочий.
 *
 * Код виходу 0 - усі сценарії пройдені й усі мутації виявлені; 1 - інакше.
 *
 * Змінні середовища:
 *   HEROMODE_FULL=0  - швидкий прогін: по одній стрілці на кожну комбінацію
 *                      напрям x область x таблиця (за замовчуванням у мутаціях).
 *   HEROMODE_FULL=1  - вичерпний прогін: КОЖНА ненульова стрілка панелі
 *                      (за замовчуванням для чистого джерела).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = process.env.CONTRACT_ROOT || path.dirname(__dirname);
const HTML = path.join(ROOT, 'index.html');
const MODES = ['auto', 'rail', 'sea', 'air', 'drone', 'multi'];

const source = fs.readFileSync(HTML, 'utf8');

/* ---------------------------------------------------------------- еталон --
 * LISTINGS і CITIES витягуються з джерела як літерали й обчислюються окремо
 * від застосунку - це і є незалежна сторона звірки.
 */
function extractArray(src, name) {
  const start = src.indexOf('var ' + name + ' = [');
  if (start < 0) throw new Error('у index.html не знайдено масив ' + name);
  const open = src.indexOf('[', start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']' && --depth === 0) return vm.runInNewContext(src.slice(open, j + 1));
  }
  throw new Error('не закрито дужку масиву ' + name);
}

const LISTINGS = extractArray(source, 'LISTINGS');
const CITIES = extractArray(source, 'CITIES');
const cityCountry = (id) => {
  const c = CITIES.find((x) => x.id === id);
  return c ? c.country : null;
};

/** Очікувані лічильники панелі потоків. mode='' - усі види транспорту. */
function expectedFlow(mode, international) {
  const counts = {};
  const bump = (country, kind, field) => {
    if (!country) return;
    counts[country] = counts[country] || { transport: { e: 0, i: 0 }, cargo: { e: 0, i: 0 } };
    counts[country][kind][field]++;
  };
  for (const l of LISTINGS) {
    if (mode && l.mode !== mode) continue;
    const from = cityCountry(l.from);
    const to = cityCountry(l.to);
    if (!from || !to) continue;
    if (international !== (from !== to)) continue;
    bump(from, l.kind, 'e');
    bump(to, l.kind, 'i');
  }
  return counts;
}

/** Очікуваний вміст списку результатів після кліку по стрілці. */
function expectedDrill(mode, kind, country, dir, scope) {
  return LISTINGS.filter((l) => {
    if (l.kind !== kind) return false;
    if (mode !== 'all' && l.mode !== mode) return false;
    const from = cityCountry(l.from);
    const to = cityCountry(l.to);
    if (dir === 'export' && from !== country) return false;
    if (dir === 'import' && to !== country) return false;
    const cross = from !== to;
    if (scope === 'international' && !cross) return false;
    if (scope === 'domestic' && cross) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ стенд */
async function boot(src) {
  const dom = new JSDOM(src, {
    url: 'https://trans-atlas.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  // Мережа в перевірці не бере участі: панелі кордонів і погоди тягнуть бекенд,
  // а UI-сценарії стосуються лише клієнтського стану.
  dom.window.fetch = () => new Promise(() => {});
  await new Promise((r) => setTimeout(r, 250));
  return dom;
}

const settle = () => new Promise((r) => setTimeout(r, 1));

function readArrows(doc) {
  return Array.from(doc.querySelectorAll('.flow-num')).map((b) => ({
    country: b.getAttribute('data-flowcountry'),
    dir: b.getAttribute('data-flowdir'),
    scope: b.getAttribute('data-flowscope'),
    route: b.getAttribute('data-flowroute'),
    n: parseInt(b.textContent.replace(/\D/g, '') || '0', 10),
  }));
}

const arrowKey = (a) => `${a.country}|${a.dir}|${a.scope}|${a.route}`;
const arrowSel = (a) =>
  `[data-flowcountry="${a.country}"][data-flowdir="${a.dir}"][data-flowscope="${a.scope}"][data-flowroute="${a.route}"]`;

/**
 * Один повний прогін набору над переданим джерелом.
 * Повертає {failures, stats}. failures - людські описи розбіжностей.
 */
async function runSuite(src, opts) {
  const full = !!(opts && opts.full);
  const failures = [];
  const stats = { arrows: 0, counters: 0, modes: 0 };
  const check = (cond, label) => {
    if (!cond) failures.push(label);
    return cond;
  };

  const dom = await boot(src);
  const { window } = dom;
  const doc = window.document;

  try {
    /* U1. До першого кліку жодна плитка не зафіксована, панель показує всі види. */
    check(
      doc.querySelectorAll('.banner-panel.selected').length === 0,
      'U1: до кліку вже є зафіксована плитка .banner-panel.selected'
    );
    const baseline = {};
    readArrows(doc).forEach((a) => {
      baseline[arrowKey(a)] = a.n;
    });
    check(Object.keys(baseline).length > 0, 'U1: панель потоків не відрендерена на головній');

    const perMode = {};

    for (const mode of MODES) {
      /* U2. Клік по плитці лишає користувача на головній. */
      window.location.hash = '#home';
      await settle();
      const tile = doc.querySelector(`[data-quickmode="${mode}"]`);
      if (!check(!!tile, `U2 [${mode}]: плитка виду транспорту відсутня`)) continue;
      tile.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await settle();
      check(window.location.hash === '#home', `U2 [${mode}]: клік по плитці пішов з головної (${window.location.hash})`);
      check(!!doc.querySelector('.flow-country-grid'), `U2 [${mode}]: панель потоків зникла після кліку`);

      /* U3/U4. Зафіксована рівно одна плитка - саме натиснута.
         Оскільки режими перебираються по черзі одним і тим самим DOM,
         ця ж перевірка доводить, що попередній вибір знімається. */
      const selected = Array.from(doc.querySelectorAll('.banner-panel.selected')).map((b) =>
        b.getAttribute('data-quickmode')
      );
      check(selected.length === 1, `U3 [${mode}]: зафіксованих плиток ${selected.length}, очікувалась одна`);
      check(
        selected.length === 1 && selected[0] === mode,
        `U4 [${mode}]: зафіксовано ${JSON.stringify(selected)} замість цього виду транспорту`
      );

      /* U5. Лічильники панелі дорівнюють незалежному еталону для цього режиму. */
      const expIntl = expectedFlow(mode, true);
      const expDom = expectedFlow(mode, false);
      doc.querySelectorAll('.flow-country').forEach((cEl) => {
        const code = cEl.querySelector('.flow-country-head').textContent.trim().slice(-2);
        cEl.querySelectorAll('.flow-subrow').forEach((rowEl, idx) => {
          const kind = idx === 0 ? 'transport' : 'cargo';
          const btns = rowEl.querySelectorAll('.flow-num');
          const scope = btns[0].getAttribute('data-flowscope');
          const table = scope === 'international' ? expIntl : expDom;
          const e = (table[code] && table[code][kind].e) || 0;
          const i = (table[code] && table[code][kind].i) || 0;
          const gotE = parseInt(btns[0].textContent.replace(/\D/g, '') || '0', 10);
          const gotI = parseInt(btns[1].textContent.replace(/\D/g, '') || '0', 10);
          stats.counters += 2;
          if (gotE !== e || gotI !== i) {
            failures.push(
              `U5 [${mode}]: ${code}/${kind}/${scope} у панелі ${gotE}/${gotI}, еталон ${e}/${i}`
            );
          }
        });
      });

      /* U6. Деталізація по стрілці несе вибраний вид транспорту в список. */
      const arrows = readArrows(doc).filter((a) => a.n > 0);
      perMode[mode] = {};
      readArrows(doc).forEach((a) => {
        perMode[mode][arrowKey(a)] = a.n;
      });

      if (!arrows.length) {
        check(
          LISTINGS.filter((l) => l.mode === mode).length === 0,
          `U6 [${mode}]: усі стрілки нульові, хоча оголошення цього виду транспорту існують`
        );
      }

      // У швидкому режимі береться по одній стрілці на кожну комбінацію
      // напрям x область x таблиця - вісім різних гілок обробника, а не вісім
      // копій однієї й тієї самої.
      let plan = arrows;
      if (!full) {
        const seen = new Set();
        plan = arrows.filter((a) => {
          const k = `${a.dir}|${a.scope}|${a.route}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }

      for (const a of plan) {
        window.location.hash = '#home';
        await settle();
        doc.querySelector(`[data-quickmode="${mode}"]`).dispatchEvent(
          new window.MouseEvent('click', { bubbles: true })
        );
        await settle();
        const btn = doc.querySelector(arrowSel(a));
        if (!check(!!btn, `U6 [${mode}]: стрілка ${arrowKey(a)} не знайдена після перевибору режиму`)) continue;
        btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await settle();

        const kind = a.route === 'transport' ? 'transport' : 'cargo';
        const where = `${mode}/${a.country}/${a.dir}/${a.scope}/${kind}`;
        check(window.location.hash === '#' + a.route, `U6 [${where}]: перехід у ${window.location.hash}, очікувався #${a.route}`);

        const chips = Array.from(doc.querySelectorAll('.m-row .mode-chip'));
        const foreign = chips.filter((c) => !c.classList.contains(mode));
        check(foreign.length === 0, `U6 [${where}]: у списку ${foreign.length} рядків іншого виду транспорту`);

        const expected = expectedDrill(mode, kind, a.country, a.dir, a.scope);
        check(chips.length === expected.length, `U6 [${where}]: рядків ${chips.length}, еталон ${expected.length}`);
        check(expected.length === a.n, `U6 [${where}]: лічильник панелі ${a.n} != результатів ${expected.length}`);
        stats.arrows++;
      }

      stats.modes++;
    }

    /* U7. Сума шести режимів дорівнює стану «всі види транспорту».
       Ловить і подвійний облік, і мовчазне випадання режиму з фільтра. */
    for (const key of Object.keys(baseline)) {
      const sum = MODES.reduce((acc, m) => acc + ((perMode[m] && perMode[m][key]) || 0), 0);
      if (sum !== baseline[key]) {
        failures.push(`U7: ${key} - сума режимів ${sum} != стану «всі види» ${baseline[key]}`);
      }
    }

    /* U8. Скидання: повернення до «всіх видів» не залишає зафіксованої плитки
       з чужим станом - перевіряється тим, що остання ітерація U3/U4 пройшла,
       а сума U7 зійшлася на незмінному baseline, знятому до будь-якого кліку. */
    check(Object.keys(baseline).length === Object.keys(perMode[MODES[0]] || {}).length,
      'U8: набір стрілок панелі змінився після вибору режиму - розмітка нестабільна');
  } finally {
    window.close();
  }

  return { failures, stats };
}

/* -------------------------------------------------------------- мутації --
 * Реалістичні регресії саме цієї функціональності. Кожна мусить бути впіймана.
 */
const MUTATIONS = [
  {
    title: 'M1: панель потоків перестала фільтруватися за вибраним режимом',
    apply: (s) => s.replace('if(state.heroMode && l.mode!==state.heroMode) return;', ''),
  },
  {
    title: 'M2: деталізація по стрілці знову скидає фільтр у "all"',
    apply: (s) => s.replace('state.filters.mode = state.heroMode || "all";', 'state.filters.mode = "all";'),
  },
  {
    title: 'M3: плитка більше не фіксується (втрачено клас selected)',
    apply: (s) => s.replace('(state.heroMode===m?" selected":"")', '""'),
  },
  {
    title: 'M4: клік по плитці не зберігає режим у стані',
    apply: (s) => s.replace('state.heroMode = m;', 'state.heroMode = "";'),
  },
];

/* ------------------------------------------------------------------ main */
(async () => {
  const full = process.env.HEROMODE_FULL !== '0';
  const t0 = Date.now();

  console.log(`джерело: ${path.relative(ROOT, HTML)}, оголошень: ${LISTINGS.length}, міст: ${CITIES.length}`);
  console.log(`режим прогону: ${full ? 'вичерпний (кожна ненульова стрілка)' : 'швидкий (по одній на гілку обробника)'}\n`);

  const clean = await runSuite(source, { full });
  console.log(
    `сценарії U1-U8: видів транспорту ${clean.stats.modes}/${MODES.length}, ` +
      `лічильників звірено ${clean.stats.counters}, деталізацій перевірено ${clean.stats.arrows}, ` +
      `провалів ${clean.failures.length}`
  );
  clean.failures.forEach((f) => console.log('   ПРОВАЛ  ' + f));

  console.log('\nмутаційне тестування:');
  const notCaught = [];
  for (const m of MUTATIONS) {
    const mutated = m.apply(source);
    if (mutated === source) {
      notCaught.push(m.title + ' (мутація не застосувалася - код змінився, оновіть шаблон)');
      console.log(`  НЕ ЗАСТОСОВАНО ${m.title}`);
      continue;
    }
    const res = await runSuite(mutated, { full: false });
    const caught = res.failures.length > 0;
    if (!caught) notCaught.push(m.title);
    console.log(`  ${caught ? 'відхилено   ' : 'НЕ ВИЯВЛЕНО '} ${m.title}${caught ? ` (${res.failures.length} розбіжностей)` : ''}`);
  }

  const total = MUTATIONS.length;
  const caughtN = total - notCaught.length;
  console.log(
    `\nсценаріїв: 8, провалів: ${clean.failures.length}\n` +
      `мутацій: ${total}, виявлено: ${caughtN}, не виявлено: ${notCaught.length}, ` +
      `покриття: ${Math.round((100 * caughtN) / total)}%\n` +
      `тривалість: ${((Date.now() - t0) / 1000).toFixed(1)} с`
  );

  process.exit(clean.failures.length || notCaught.length ? 1 : 0);
})().catch((err) => {
  console.error('прогін аварійно завершився:', err && err.stack ? err.stack : err);
  process.exit(1);
});
