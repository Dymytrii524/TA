'use strict';
/** Minimal structured logger - one JSON line per event, so a parser
 * breaking (e.g. a source schema change) is grep-able instead of buried in
 * free-text console output. No external logging library needed for this
 * scope. */
function event(level, source, message, extra) {
  var line = Object.assign(
    { ts: new Date().toISOString(), level: level, source: source, message: message },
    extra || {}
  );
  var out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

module.exports = {
  info: function (source, message, extra) { event('info', source, message, extra); },
  warn: function (source, message, extra) { event('warn', source, message, extra); },
  error: function (source, message, extra) { event('error', source, message, extra); },
};
