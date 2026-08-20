'use strict';
/**
 * Boots the Services aggregation backend: cache (loaded from disk) +
 * scheduler (background refresh) + internal REST API.
 *
 * Run with:  node server/index.js
 * No npm install needed - zero external dependencies, uses Node's built-in
 * fetch/http (requires Node 18+; this machine has v24).
 */

var config = require('./config');
var scheduler = require('./scheduler');
var api = require('./api');
var log = require('./log');

scheduler.start();
var server = api.createServer();
server.listen(config.port, function () {
  log.info('server', 'listening', { port: config.port });
  console.log('Trans-Atlas Services API running at http://localhost:' + config.port);
  console.log('Try: http://localhost:' + config.port + '/api/services/weather?mode=road&lat=50.45&lon=30.52&label=Kyiv');
  console.log('Health: http://localhost:' + config.port + '/api/health');
});

process.on('SIGINT', function () {
  scheduler.stop();
  server.close(function () { process.exit(0); });
});
