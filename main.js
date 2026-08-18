require('dotenv').config();

const api = require("./api/web");
const createServer = require('./mc/server');
const eventBus = require('./eventBus');
const { registerBackendSocketBridge } = require('./backendSocket');
const { validateSchema } = require('./database/database');
const { loadModules } = require('./moduleLoader');
const Log = require('./log');

async function bootstrap() {
  const server = createServer();
  api.mountWeb({ server });

  registerBackendSocketBridge();
  await loadModules({ server });

  await validateSchema();
  await server.start();

  async function gracefulShutdown(reason, err) {
    if (err) {
      Log.error('Main', reason, err);
    }
    if (server.process) {
      eventBus.on(eventBus.EVENTS.SERVER_STATE, ({ state, message }) => {
        if (state === "stopped" && message === "Bedrock server stopped") {
          process.exit(0);
        }
      });
      Log.info('Main', "Waiting for server to shut down correctly...")
      setTimeout(() => {
        Log.warn('Main', "Shutdown Timeout: Forcing Shutdown...")
        process.exit(0);
      }, 15000);
      await eventBus.request(eventBus.EVENTS.SERVER_COMMAND, { action: 'stop' }).catch((requestErr) => {
        Log.error('Main', `Shutdown stop request failed: ${requestErr.message}`);
      });
    } else {
      process.exit(0);
    }
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on("uncaughtException", (err) => {
    gracefulShutdown("uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    gracefulShutdown("unhandledRejection", err);
  });
}

bootstrap().catch((err) => {
  Log.error('Main', 'Failed to start application', err);
  process.exit(1);
});
