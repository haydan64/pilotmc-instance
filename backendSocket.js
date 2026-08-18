const eventBus = require('./eventBus');
const {
  getAllowlistEntryByUsername,
  updatePlayerServerState
} = require('./database/database');
const Log = require('./log');

const {
  EVENTS: { MINECRAFT_EVENT, SERVER_BACKUP, SERVER_LOG, SERVER_STATE }
} = eventBus;

const DEFAULT_SERVER_KEY = 'default';
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3000';

function getServerKey() {
  return process.env.SERVER_KEY || DEFAULT_SERVER_KEY;
}

function getBackendUrl() {
  return process.env.BACKEND_URL || DEFAULT_BACKEND_URL;
}

function getBackendApiToken() {
  return process.env.BACKEND_API_TOKEN || '';
}

function loadSocketClient() {
  try {
    return require('socket.io-client').io;
  } catch (err) {
    Log.warn('Backend Socket', 'socket.io-client is not installed. Minecraft events will not be streamed to Backend.');
    return null;
  }
}

async function reportDiscoveredXuid({ username, xuid }) {
  if (!username || !xuid || typeof fetch !== 'function') return;
  const serverKey = getServerKey();
  const backendApiToken = getBackendApiToken();

  const response = await fetch(new URL('/api/minecraft/xuid-discovery', getBackendUrl()), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(backendApiToken ? { Authorization: `Bearer ${backendApiToken}` } : {})
    },
    body: JSON.stringify({
      minecraftUsername: username,
      xuid,
      serverKey
    })
  }).catch((err) => {
    Log.warn('Backend Socket', `Unable to report XUID for ${username}: ${err.message}`);
    return null;
  });

  if (!response) return;

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    Log.warn('Backend Socket', `Backend rejected XUID report for ${username}: HTTP ${response.status} ${body?.error || body?.result?.message || ''}`.trim());
    return;
  }

  Log.info('Backend Socket', `XUID report for ${username}: ${body?.result?.status || 'ok'}.`);
}

async function updateLocalPlayerState(event, content = {}) {
  if (!['playerJoin', 'playerLeave'].includes(event) || !content.username) return;

  const allowlistEntry = await getAllowlistEntryByUsername(content.username);
  if (!allowlistEntry?.playerId) return;

  await updatePlayerServerState({
    playerId: allowlistEntry.playerId,
    username: content.username,
    xuid: content.xuid || allowlistEntry.xuid || null,
    online: event === 'playerJoin'
  });

  if (event === 'playerJoin') {
    await reportDiscoveredXuid({ username: content.username, xuid: content.xuid });
  }
}

function registerBackendSocketBridge() {
  const io = loadSocketClient();
  if (!io) return;
  const serverKey = getServerKey();
  const backendUrl = getBackendUrl();

  Log.info('Backend Socket', `Starting Backend Socket.IO relay to ${backendUrl} as ${serverKey}.`);

  const socket = io(backendUrl, {
    auth: {
      role: 'minecraft-agent',
      serverKey,
      token: getBackendApiToken()
    },
    reconnection: true
  });

  socket.on('connect', () => {
    Log.info('Backend Socket', `Connected to Backend Socket.IO as ${serverKey}.`);
    socket.emit('server:heartbeat', {
      serverKey,
      service: 'pilotmc-instance',
      at: new Date().toISOString()
    });
  });

  socket.on('connect_error', (err) => {
    Log.warn('Backend Socket', `Unable to connect to Backend Socket.IO: ${err.message}`);
  });

  socket.on('disconnect', (reason) => {
    Log.warn('Backend Socket', `Disconnected from Backend Socket.IO: ${reason}`);
  });

  eventBus.on(MINECRAFT_EVENT, ({ event, content }) => {
    if (event === 'inventoryResponse') return;
    updateLocalPlayerState(event, content).catch((err) => {
      Log.warn('Backend Socket', `Unable to update local player state for ${event}: ${err.message}`);
    });
    socket.emit('minecraft:event', {
      serverKey,
      event,
      content,
      at: new Date().toISOString()
    });
  });

  eventBus.on(SERVER_STATE, ({ state, message, important }) => {
    socket.emit('server:status', {
      serverKey,
      state,
      message,
      important: Boolean(important),
      at: new Date().toISOString()
    });
  });

  eventBus.on(SERVER_LOG, ({ level = 'info', message = '', important = false } = {}) => {
    const cleanMessage = String(message || '').trim();
    if (!cleanMessage) return;

    socket.emit('server:log', {
      serverKey,
      level: String(level || 'info').toLowerCase(),
      message: cleanMessage,
      important: Boolean(important),
      at: new Date().toISOString()
    });
  });

  eventBus.on(SERVER_BACKUP, ({ path, message = '', important = false } = {}) => {
    socket.emit('server:backup', {
      serverKey,
      path,
      message: String(message || '').trim(),
      important: Boolean(important),
      at: new Date().toISOString()
    });
  });
}

module.exports = {
  registerBackendSocketBridge
};
