const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serviceSchemas, validate } = require('./schema');
let active = null;
let currentClient = null;
function getActiveConfig() { return active?.config; }
function getActiveRevision() { return active?.revision || 0; }
function validateSnapshot(snapshot, service, serviceId) {
  if (!snapshot || !Number.isInteger(snapshot.revision) || snapshot.revision < 1 || snapshot.serviceId !== serviceId) throw new Error('Invalid configuration snapshot identity or revision');
  const errors = validate(snapshot.config, serviceSchemas[service], 'configuration');
  if (errors.length) throw new Error(errors.join('\n'));
  if (service === 'instance' && serviceId !== `instance:${snapshot.config.serverKey}`) throw new Error('Instance configuration belongs to another server');
  return snapshot;
}
async function initialize({ service, serverKey, directory, log = console, fetchImpl = fetch, env = process.env, poll = true }) {
  const token = env.BACKEND_CONFIG_TOKEN;
  if (!token) return null; // Legacy standalone installations can migrate explicitly.
  if (!env.BACKEND_URL) throw new Error('BACKEND_URL is required for centralized configuration');
  const serviceId = service === 'instance' ? `instance:${serverKey}` : service;
  if (!serviceSchemas[service] || (service === 'instance' && !serverKey)) throw new Error('A valid service/server identity is required');
  const identity = crypto.createHash('sha256').update(`${env.BACKEND_URL}\n${serviceId}\n${token}`).digest('hex');
  const cachePath = path.join(directory, '.cache', `configuration-${serviceId.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`);
  const warn = (message) => log.warn ? log.warn('Configuration', message) : undefined;
  let lastWarning = '';
  function warning(message) { if (lastWarning !== message) warn(message); lastWarning = message; }
  async function download() {
    const url = new URL(`/api/configuration/${service}`, env.BACKEND_URL);
    if (serverKey) url.searchParams.set('serverKey', serverKey);
    url.searchParams.set('activeRevision', String(active?.revision || 0));
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) { const error = new Error(`Configuration backend returned HTTP ${response.status}`); error.status = response.status; throw error; }
    const snapshot = validateSnapshot(await response.json(), service, serviceId);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ identity, snapshot }), { mode: 0o600 });
    fs.renameSync(temporary, cachePath);
    return snapshot;
  }
  try { active = await download(); } catch (err) {
    if ([401,403,404].includes(err.status)) throw err; // Never revive revoked credentials or deleted servers.
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.identity !== identity) throw new Error('Cache belongs to a different backend or credential');
      active = validateSnapshot(cached.snapshot, service, serviceId);
      warning(`Backend unavailable; using cached revision ${active.revision}. ${err.message}`);
    } catch (cacheErr) { throw new Error(`Cannot start without valid configuration: ${err.message}; ${cacheErr.message}`); }
  }
  const startupRevision = active.revision;
  async function refresh() {
    try {
      const fetched = await download();
      if (fetched.revision !== startupRevision) warning(`Revision ${fetched.revision} is cached. Restart this service to apply it (active revision ${startupRevision}).`);
      else lastWarning = '';
      return fetched;
    } catch (err) { warning(`Configuration refresh failed: ${err.message}. Active revision ${startupRevision} is unchanged.`); return null; }
  }
  const timer = poll ? setInterval(refresh, 30000) : null;
  timer?.unref();
  currentClient = { refresh, stop: () => timer && clearInterval(timer), cachePath, startupRevision };
  if (poll) void refresh();
  return currentClient;
}
module.exports = { initialize, getActiveConfig, getActiveRevision, validateSnapshot, getClient: () => currentClient };
