'use strict';
/**
 * Keyword-overlap retrieval over the local wiki + outputs datasets - this is
 * NOT a vector/embedding search (no vector DB in this slice), just weighted
 * token overlap. It exists so /api/qa/ask can (a) decide honestly whether
 * there's anything relevant to answer from before ever calling the LLM, and
 * (b) hand the LLM only real local content to ground its answer in, instead
 * of the whole dataset.
 */

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(function (t) { return t.length > 2; });
}

function scoreItem(queryTokens, item, fields) {
  var score = 0;
  fields.forEach(function (f) {
    var haystack = tokenize(Array.isArray(item[f.name]) ? item[f.name].join(' ') : item[f.name]);
    queryTokens.forEach(function (qt) {
      if (haystack.indexOf(qt) > -1) score += f.weight;
    });
  });
  return score;
}

var WIKI_FIELDS = [
  { name: 'title', weight: 3 },
  { name: 'tags', weight: 2 },
  { name: 'summary', weight: 1 },
  { name: 'body', weight: 1 },
];

var OUTPUT_FIELDS = [
  { name: 'title', weight: 3 },
  { name: 'tags', weight: 2 },
  { name: 'summary', weight: 1 },
];

/**
 * Returns items from both datasets ranked by score (highest first),
 * annotated with `kind` ('wiki' | 'output') so callers can tell them apart
 * without re-checking which array they came from.
 */
function search(query, wiki, outputs) {
  var queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  var results = [];
  (wiki || []).forEach(function (item) {
    if (item.status !== 'published') return;
    var score = scoreItem(queryTokens, item, WIKI_FIELDS);
    if (score > 0) results.push({ kind: 'wiki', item: item, score: score });
  });
  (outputs || []).forEach(function (item) {
    if (item.status !== 'published') return;
    var score = scoreItem(queryTokens, item, OUTPUT_FIELDS);
    if (score > 0) results.push({ kind: 'output', item: item, score: score });
  });

  results.sort(function (a, b) { return b.score - a.score; });
  return results;
}

module.exports = { search: search, tokenize: tokenize };
