const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
async function start() {
  const configuration = require('./configuration/client');
  await configuration.initialize({ service: 'instance', serverKey: process.env.SERVER_KEY, directory: __dirname, log: require('./log') });
  require('./mainRuntime');
}
start().catch(err => { require('./log').error('Startup', err.message); process.exitCode = 1; });
