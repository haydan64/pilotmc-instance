const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'log');

const originalConsole = {
  debug: console.debug.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console)
};

const color = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  orange: '\x1b[38;5;208m',
  purple: '\x1b[38;5;93m',
  redBackgroundWhite: '\x1b[37;41;1m',
  darkGray: '\x1b[38;5;240m'
};

const levelColors = {
  debug: color.darkGray,
  error: color.redBackgroundWhite,
  info: color.blue,
  warn: color.orange
};

const originColors = {
  BDS: color.darkGray,
  EventBus: color.green,
  'HTTP API': color.purple
};

let currentLogDate = null;
let currentLogStream = null;
let fileLoggingErrorReported = false;

function paint(value, ansiColor) {
  return `${ansiColor}${value}${color.reset}`;
}

function serialize(value) {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getLogDate(timestamp) {
  return timestamp.slice(0, 10);
}

function getLogStream(timestamp) {
  const logDate = getLogDate(timestamp);
  if (currentLogStream && currentLogDate === logDate) {
    return currentLogStream;
  }

  if (currentLogStream) {
    currentLogStream.end();
    currentLogStream = null;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  currentLogDate = logDate;
  currentLogStream = fs.createWriteStream(path.join(LOG_DIR, `app-${logDate}.log`), {
    flags: 'a',
    encoding: 'utf8'
  });
  currentLogStream.on('error', (err) => {
    if (fileLoggingErrorReported) return;
    fileLoggingErrorReported = true;
    originalConsole.error(`[${new Date().toISOString()}] [ERROR] [Log] Failed to write log file: ${err.message}`);
  });
  return currentLogStream;
}

function writeToFile(line, timestamp) {
  try {
    getLogStream(timestamp).write(`${line}\n`);
  } catch (err) {
    if (fileLoggingErrorReported) return;
    fileLoggingErrorReported = true;
    originalConsole.error(`[${new Date().toISOString()}] [ERROR] [Log] Failed to write log file: ${err.message}`);
  }
}

function write(level, origin, data) {
  const safeOrigin = origin || 'System';
  const timestamp = new Date().toISOString();
  const levelTag = level.toUpperCase();
  const message = data.map(serialize).join(' ');
  const plainLine = `[${timestamp}] [${levelTag}] [${safeOrigin}] ${message}`;
  const levelColor = levelColors[level] || color.reset;
  const originColor = originColors[safeOrigin] || color.reset;
  const line = [
    paint(`[${timestamp}]`, color.dim),
    paint(`[${levelTag}]`, levelColor),
    paint(`[${safeOrigin}]`, originColor),
    message
  ].join(' ');
  const writer = originalConsole[level] || originalConsole.log;
  writer(line);
  writeToFile(plainLine, timestamp);
}

module.exports = {
  debug(origin, ...data) {
    write('debug', origin, data);
  },
  error(origin, ...data) {
    write('error', origin, data);
  },
  info(origin, ...data) {
    write('info', origin, data);
  },
  warn(origin, ...data) {
    write('warn', origin, data);
  }
};
