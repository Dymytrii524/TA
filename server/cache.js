'use strict';
/**
 * Generic TTL cache shared by every source. There's no Redis in this
 * dev-only slice (see the plan discussed with the user - no hosting/Redis
 * yet), so this is an in-memory Map backed by a JSON file on disk, which
 * gives the same two properties that matter here: fast reads, and survival
 * across `node server/index.js` restarts. Swapping this module for a real
 * Redis client later does not require touching connectors, the scheduler,
 * or the API layer - they only call get/set/isStale.
 */

var fs = require('fs');
var config = require('./config');

var store = new Map(); // key -> { data, fetchedAt, ttlMs, ok }

function loadFromDisk() {
  try {
    var raw = fs.readFileSync(config.cacheFile, 'utf8');
    var parsed = JSON.parse(raw);
    Object.keys(parsed).forEach(function (key) { store.set(key, parsed[key]); });
  } catch (err) {
    // No cache file yet, or it's corrupt - start empty. Never crash on this.
  }
}

var saveScheduled = false;
function saveToDisk() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(function () {
    saveScheduled = false;
    var obj = {};
    store.forEach(function (value, key) { obj[key] = value; });
    try {
      fs.writeFileSync(config.cacheFile, JSON.stringify(obj));
    } catch (err) {
      console.error('[cache] failed to persist cache to disk:', err.message);
    }
  });
}

loadFromDisk();

function get(key) {
  return store.get(key) || null;
}

function isStale(key) {
  var entry = store.get(key);
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > entry.ttlMs;
}

/** `meta` records how to refresh this key later - {sourceId, params} - so
 * the scheduler can re-run the right connector without a separate registry
 * of "what did we ever fetch". */
function set(key, data, ttlMs, meta) {
  var prev = store.get(key);
  store.set(key, { data: data, fetchedAt: Date.now(), ttlMs: ttlMs, ok: true, meta: meta || (prev && prev.meta) });
  saveToDisk();
}

/** Records that a refresh attempt failed, WITHOUT touching any existing
 * good data - this is what makes serve-stale-on-error possible: the last
 * good `data` stays in the entry, only `lastError` is updated. */
function recordError(key, message) {
  var entry = store.get(key);
  if (entry) {
    entry.lastError = { message: message, at: new Date().toISOString() };
  } else {
    store.set(key, { data: null, fetchedAt: 0, ttlMs: 0, ok: false, lastError: { message: message, at: new Date().toISOString() } });
  }
  saveToDisk();
}

function allKeys() {
  return Array.from(store.keys());
}

module.exports = { get: get, set: set, isStale: isStale, recordError: recordError, allKeys: allKeys };
