const { EventEmitter } = require('events');
const Log = require('./log');

const EVENTS = {
  SERVER_LOG: 'server:log',
  SERVER_STATE: 'server:state',
  SERVER_COMMAND: 'server:command',
  SERVER_BACKUP: 'server:backup',
  DISCORD_LOG: 'discord:log',
  MINECRAFT_EVENT: 'minecraft:event',
  DISCORD_EVENT: 'discord:event'
};

const eventBus = new EventEmitter({ captureRejections: true });
const requestHandlers = new Map();

eventBus.setMaxListeners(50);

Object.entries(EVENTS).forEach(([key, value]) => {
  if(value === "server:log") return;
  eventBus.on(value, (...args) => {
    if (value === EVENTS.MINECRAFT_EVENT && ['playerList', 'inventoryResponse'].includes(args[0]?.event)) return;
    Log.info('EventBus', `Event: ${key}`, ...args);
  });
});

eventBus.EVENTS = EVENTS;

eventBus.handle = function handle(eventName, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError(`Handler for ${eventName} must be a function`);
  }
  if (requestHandlers.has(eventName)) {
    throw new Error(`Request handler already registered for ${eventName}`);
  }
  requestHandlers.set(eventName, handler);
  return () => {
    if (requestHandlers.get(eventName) === handler) {
      requestHandlers.delete(eventName);
    }
  };
};

eventBus.request = async function request(eventName, payload, options = {}) {
  const handler = requestHandlers.get(eventName);
  if (!handler) {
    throw new Error(`No request handler registered for ${eventName}`);
  }

  const timeoutMs = options.timeoutMs || 120000;
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Request timed out for ${eventName}`)), timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve(handler(payload)), timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = eventBus;
