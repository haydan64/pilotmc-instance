const express = require("express");
const path = require("path");
const eventBus = require("../eventBus");
const { createWebRouter } = require("../web/routes");
const { getServerProfileForPlayer } = require("../database/database");
const Log = require("../log");
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { MINECRAFT_EVENT } = eventBus.EVENTS

const PORT = Number(process.env.AGENT_PORT || process.env.PORT || 3101);
const BACKEND_API_TOKEN = process.env.BACKEND_API_TOKEN || '';

const app = express();
let agentContext = {};

function requireBackendToken(req, res, next) {
  if (!BACKEND_API_TOKEN) {
    return res.status(503).json({ ok: false, error: 'Backend authentication is not configured.' });
  }
  const authorization = req.get('authorization') || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (bearerToken !== BACKEND_API_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return next();
}

function requireLoopback(req, res, next) {
  const address = req.socket?.remoteAddress || req.ip || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    return res.status(403).json({ ok: false, error: 'mclink endpoints are local-only.' });
  }
  return next();
}

// Basic request logging (no extra deps)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (res.locals.suppressAccessLog) return;
    if (res.statusCode < 400) return;
    const ms = Date.now() - start;
    Log.warn('HTTP API', `${req.ip} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Body parsing (primarily POST)
app.use(express.json({ limit: '2mb' })); // application/json
app.use(express.urlencoded({ extended: false, limit: '2mb' })); // application/x-www-form-urlencoded
app.use(express.text({ type: ['text/*', 'application/xml'], limit: '2mb' })); // text/plain, xml, etc.

let webRouterMounted = false;

function mountWeb(context = {}) {
  agentContext = context;
  if (webRouterMounted) return;
  webRouterMounted = true;
  app.use('/web', createWebRouter(context));
  app.get('/', (req, res) => res.redirect('/web/'));
}

function requestServerCommand(payload, timeoutMs = 120000) {
  return eventBus.request(eventBus.EVENTS.SERVER_COMMAND, payload, { timeoutMs });
}

function getBdsState() {
  const server = agentContext.server;
  return {
    running: Boolean(server?.process),
    pid: server?.process?.pid || null,
    uptimeSeconds: Math.floor(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
  };
}

app.use('/api', requireBackendToken);
app.use('/mclink', requireLoopback);

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    serverKey: process.env.SERVER_KEY || 'default',
    service: 'pilotmc-instance',
    bds: getBdsState()
  });
});

app.get('/api/players/:playerId/profile', async (req, res) => {
  try {
    const profile = await getServerProfileForPlayer(req.params.playerId);
    return res.json({
      ok: true,
      serverKey: process.env.SERVER_KEY || 'default',
      profile
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/server-command', async (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) {
    return res.status(400).json({ ok: false, error: 'Command is required.' });
  }

  try {
    const result = await requestServerCommand({ action: 'command', command }, 10000);
    return res.json({ ok: Boolean(result?.ok), result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/server-action', async (req, res) => {
  const action = String(req.body?.action || '').trim();
  const allowedActions = new Set(['start', 'stop', 'forceStop', 'restart', 'reload', 'backup', 'backupCleanup:set', 'inventory:get', 'update', 'permission:set']);
  if (!allowedActions.has(action)) {
    return res.status(400).json({ ok: false, error: 'Unsupported action.' });
  }

  try {
    const result = await requestServerCommand({ ...req.body, action }, 120000);
    return res.json({ ok: Boolean(result?.ok), result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/allowlist', async (req, res) => {
  const playerId = req.body?.playerId;
  const username = String(req.body?.username || '').trim();
  if (!playerId) {
    return res.status(400).json({ ok: false, error: 'playerId is required.' });
  }
  if (!username) {
    return res.status(400).json({ ok: false, error: 'username is required.' });
  }

  try {
    const result = await requestServerCommand(
      {
        action: 'allowlist:add',
        playerId,
        username,
        xuid: req.body?.xuid || null,
        permitted: req.body?.permitted !== false,
        ignoresPlayerLimit: Boolean(req.body?.ignoresPlayerLimit)
      },
      30000
    );
    return res.json({ ok: Boolean(result?.ok), result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/allowlist/:playerId', async (req, res) => {
  try {
    const result = await requestServerCommand(
      { action: 'allowlist:remove', playerId: req.params.playerId },
      30000
    );
    return res.json({ ok: Boolean(result?.ok), result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /mclink/unwhitelist
app.post("/mclink/unwhitelist", (req, res) => {
  // req.body will be the parsed JSON object if Content-Type: application/json
  const payload = req.body || {};

  if (!payload.target) {
    Log.warn('HTTP API', "/mclink/unwhitelist", "payload should contain target.");
    return res.status(400).json({ ok: false, error: "payload should contain target." });

  }
  if (!payload.initiator) {
    Log.warn('HTTP API', "/mclink/unwhitelist", "payload should contain initiator.");
    return res.status(400).json({ ok: false, error: "payload should contain initiator." });

  }

  eventBus.emit(MINECRAFT_EVENT, {
    event: "unwhitelist",
    content: {
      target: payload.target,
      initiator: payload.initiator
    }
  });
  res.status(202).json({ ok: true });
});

// POST /mclink/event
app.post("/mclink/event", (req, res) => {
  // req.body will be the parsed JSON object if Content-Type: application/json
  const payload = req.body || {};

  if (!payload.event) {
    Log.warn('HTTP API', "/mclink/event", "payload should contain event id.");
    return res.status(400).json({ ok: false, error: "payload should contain event id." });
  }

  if (payload.event === 'playerList') {
    res.locals.suppressAccessLog = true;
  }

  eventBus.emit(MINECRAFT_EVENT, {
    event: payload.event,
    content: payload.content
  });

  return res.status(202).json({ ok: true });
});

// Start server (if you don't already have this later in the file)
app.listen(PORT, () => {
  Log.info('HTTP API', `HTTP API listening on :${PORT}`);
});

module.exports = {
  app,
  mountWeb
};
