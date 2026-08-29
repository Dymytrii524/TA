'use strict';
/**
 * Thin wrapper around the Anthropic Messages API. Used only by the Q&A
 * assistant (server/api.js handleQaAsk) to generate an answer grounded in
 * locally-retrieved wiki/outputs content - never called with an open-ended
 * question and no context, so it can't fabricate an answer from nothing.
 *
 * Requires ANTHROPIC_API_KEY to be set; callers are responsible for that
 * check (see api.js) and for handling the "not configured" case honestly
 * instead of pretending this connector can run without a key.
 */

var ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

async function askClaude(opts) {
  var apiKey = opts.apiKey;
  var model = opts.model;
  var system = opts.system;
  var question = opts.question;

  var res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 600,
      system: system,
      messages: [{ role: 'user', content: question }],
    }),
  });

  var json = await res.json().catch(function () { return null; });

  if (!res.ok) {
    var msg = (json && json.error && json.error.message) || ('HTTP ' + res.status);
    throw new Error(msg);
  }

  var text = ((json && json.content) || [])
    .map(function (block) { return block.text || ''; })
    .join('')
    .trim();

  return { text: text, model: (json && json.model) || model, usage: (json && json.usage) || null };
}

module.exports = { askClaude: askClaude };
