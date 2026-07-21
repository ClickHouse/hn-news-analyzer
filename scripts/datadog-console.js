'use strict';

// Preserve this app's existing console logging while also writing JSON lines
// that the host Datadog Agent can tail. dd-trace is preloaded first, so its
// LOG-format injection adds the active trace and span identifiers.
const fs = require('node:fs');
const util = require('node:util');
const tracer = require('dd-trace');
const formats = require('dd-trace/ext/formats');

const logFile = process.env.HN_LOG_FILE || '/tmp/hn-news-analyzer.log';
const stream = fs.createWriteStream(logFile, { flags: 'a' });
const original = {};

for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
  original[level] = console[level].bind(console);
  console[level] = (...args) => {
    const record = {
      timestamp: new Date().toISOString(),
      level: level === 'log' ? 'info' : level,
      message: util.format(...args),
      service: process.env.DD_SERVICE || 'hn-news-analyzer',
      env: process.env.DD_ENV || 'demo',
      version: process.env.DD_VERSION || '1.0.0',
    };

    const span = tracer.scope().active();
    if (span) {
      tracer.inject(span.context(), formats.LOG, record);
    }

    stream.write(`${JSON.stringify(record)}\n`);
    original[level](...args);
  };
}

process.on('beforeExit', () => stream.end());
