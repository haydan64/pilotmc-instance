const express = require('express');
const eventBus = require('../eventBus');

const bdsState = {
  state: 'unknown',
  message: 'No server state event has been received yet.',
  updatedAt: null
};

eventBus.on(eventBus.EVENTS.SERVER_STATE, (payload = {}) => {
  bdsState.state = payload.state || 'unknown';
  bdsState.message = payload.message || '';
  bdsState.updatedAt = new Date().toISOString();
});

function requireAdminToken(req, res, next) {
  const token = process.env.WEB_ADMIN_TOKEN;
  if (!token) {
    return res.status(503).json({ ok: false, error: 'WEB_ADMIN_TOKEN is not configured.' });
  }

  const provided = req.get('x-admin-token') || req.query.token || req.body?.token;
  if (provided !== token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  return next();
}

function createWebRouter({ client } = {}) {
  const router = express.Router();

  router.use(express.static(__dirname + '/public'));

  router.get('/api/status', (req, res) => {
    res.json({
      ok: true,
      status: {
        bot: {
          ready: Boolean(client?.isReady?.()),
          tag: client?.user?.tag || null,
          id: client?.user?.id || null,
          guilds: client?.guilds?.cache?.size || 0,
          updatedAt: new Date().toISOString()
        },
        bds: bdsState,
        process: {
          uptimeSeconds: Math.floor(process.uptime()),
          startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
        },
        logs: {
          count: 0,
          max: 0,
          external: true
        }
      }
    });
  });

  router.get('/api/logs', (req, res) => {
    res.json({ ok: true, logs: [] });
  });

  router.post('/api/server-command', requireAdminToken, async (req, res) => {
    const command = String(req.body?.command || '').trim();
    if (!command) {
      return res.status(400).json({ ok: false, error: 'Command is required.' });
    }

    try {
      const result = await eventBus.request(
        eventBus.EVENTS.SERVER_COMMAND,
        { action: 'command', command },
        { timeoutMs: 10000 }
      );
      return res.json({ ok: Boolean(result?.ok), result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/api/server-action', requireAdminToken, async (req, res) => {
    const action = String(req.body?.action || '').trim();
    const allowedActions = new Set(['start', 'stop', 'restart', 'reload', 'backup']);
    if (!allowedActions.has(action)) {
      return res.status(400).json({ ok: false, error: 'Unsupported action.' });
    }

    try {
      const result = await eventBus.request(
        eventBus.EVENTS.SERVER_COMMAND,
        { action },
        { timeoutMs: 120000 }
      );
      return res.json({ ok: Boolean(result?.ok), result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createWebRouter };
