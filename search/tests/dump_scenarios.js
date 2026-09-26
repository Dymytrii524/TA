'use strict';
// Друкує відповіді рушія для сценаріїв T16-T27 як JSON: {назва: відповідь}
var S = require('./scenarios').S;
var names = Object.keys(S);
Promise.all(names.map(function (n) { return S[n](); })).then(function (rs) {
  var out = {};
  names.forEach(function (n, i) { out[n] = rs[i]; });
  process.stdout.write(JSON.stringify(out));
});
