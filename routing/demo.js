'use strict';
const { T } = require('./db');
const seaRailAuto = require('./seaRailAuto');
const airAuto = require('./airAuto');
const railAuto = require('./railAuto');

function printCase(title, result) {
  console.log('\n=== ' + title + ' ===');
  console.log('Маршрут: ' + (result.summary || '(немає варіанту)'));
  for (const l of result.legs) {
    console.log(
      '  - ' + l.mode.padEnd(10) + l.from.padEnd(10) + '-> ' + l.to.padEnd(10) +
      (l.confirmed ? '[підтверджено: ' + l.source + ']' : '[непідтверджено]')
    );
  }
  console.log('  Журнал прийняття рішення:');
  for (const line of result.log) console.log('    · ' + line);
}

console.log('#################### Алгоритм 1: море + залізниця + авто ####################');
printCase('1.1 Пряме морське сполучення (Rotterdam -> Istanbul)', seaRailAuto.route(T.rotterdam, T.istanbul));
printCase('1.2 Пряме залізничне сполучення (Kyiv -> Lviv)', seaRailAuto.route(T.kyiv, T.lviv));
printCase('1.3 Один кінець відомий морю, інший - тільки залізниці (Hamburg -> Kyiv)', seaRailAuto.route(T.hamburg, T.kyiv));
printCase('1.4 Жоден пункт не в базах напряму, є найближчі хаби (Warsaw -> Vienna)', seaRailAuto.route(T.warsaw, T.vienna));
printCase('1.5 Пункт узагалі поза інфраструктурою (Nowhere -> Kyiv)', seaRailAuto.route(T.nowhere, T.kyiv));

console.log('\n#################### Алгоритм 2: авіа + авто ####################');
printCase('2.1 Пряме авіасполучення (Munich -> Kyiv)', airAuto.route(T.munich, T.kyiv));
printCase('2.2 Один кінець відомий, інший - ні (Prague -> Kyiv)', airAuto.route(T.prague, T.kyiv));
printCase('2.3 Обидва поза мережею (Warsaw -> Gdansk)', airAuto.route(T.warsaw, T.gdansk));

console.log('\n#################### Алгоритм 3: залізниця + авто ####################');
printCase('3.1 Пряме залізничне сполучення (Prague -> Hamburg)', railAuto.route(T.prague, T.hamburg));
printCase('3.2 Один кінець відомий, інший - ні (Warsaw -> Munich)', railAuto.route(T.warsaw, T.munich));
printCase('3.3 Точний збіг відсутній для обох (Ternopil -> Odesa)', railAuto.route(T.ternopil, T.odesa));
