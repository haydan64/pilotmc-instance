const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const eventBus = require('../eventBus');
const Log = require('../log');
const {
  upsertAllowlistEntry: dbUpsertAllowlistEntry,
  removeAllowlistEntry: dbRemoveAllowlistEntry,
  removeAllowlistEntryByPlayerId: dbRemoveAllowlistEntryByPlayerId,
  upsertPermission: dbUpsertPermission,
  getAllowlistEntries,
  getServerPermissions,
  createServerEvent
} = require('../database/database');

const {
  EVENTS: { SERVER_LOG, SERVER_STATE, SERVER_COMMAND, SERVER_BACKUP, MINECRAFT_EVENT }
} = eventBus;

const SERVER_ROOT = path.join(__dirname, 'bds');
const WORLD_NAME = process.env.BDS_WORLD_NAME || 'Bedrock level';
const WORLD_PATH = path.join(SERVER_ROOT, 'worlds', WORLD_NAME);
const LINK_ADDON_PATH = path.join(__dirname, 'linkaddon');
const BEHAVIOR_ADDON_PATH = path.join(LINK_ADDON_PATH, 'behavior');
const RESOURCE_ADDON_PATH = path.join(LINK_ADDON_PATH, 'resource');
const LINK_BEHAVIOR_PACK_ID = '9c4b4db6-f8da-4a34-9a23-1c39c66c5b51';
const MC_CONFIG_PATH = path.join(__dirname, 'mcConfig.json');
const DEFAULT_BACKUP_PATH = path.join(__dirname, 'backups');
const SERVER_STATE_FOLDER = 'server state';
const DEFAULT_BINARY = path.join(
  SERVER_ROOT,
  process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server'
);
const ALLOWLIST_PATH = path.join(SERVER_ROOT, 'allowlist.json');
const PERMISSIONS_PATH = path.join(SERVER_ROOT, 'permissions.json');
const SERVER_PROPERTIES_PATH = path.join(SERVER_ROOT, 'server.properties');
const SERVER_CONFIG_PATH = path.join(SERVER_ROOT, 'config');
const STOP_TIMEOUT_MS = 10000;
const FORCE_STOP_TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function removeRecursive(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function readPackEntry(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const packId = manifest?.header?.uuid;
    const version = manifest?.header?.version;
    if (packId && version) {
      return { pack_id: packId, version };
    }
  } catch (err) {
    eventBus.emit(SERVER_LOG, {
      level: 'error',
      message: `Failed to parse pack manifest ${manifestPath}: ${err.message}`
    });
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutResult(ms, message) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, message }), ms);
  });
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureParentDirectory(dest);
  fs.copyFileSync(src, dest);
}

function loadMcConfig() {
  const fallback = {
    enableAutoBackup: false,
    enableBackupCleanup: true,
    backupFrequencyMinutes: 60,
    backupDirectory: DEFAULT_BACKUP_PATH,
    zipBackups: false,
    sevenZipPath: process.platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : '7z',
    transientBackupRetentionDays: 2,
    hourlyBackupRetentionDays: 7,
    dailyBackupRetentionDays: 32,
    weeklyBackupRetentionDays: 365
  };

  try {
    if (!fs.existsSync(MC_CONFIG_PATH)) return fallback;
    return { ...fallback, ...JSON.parse(fs.readFileSync(MC_CONFIG_PATH, 'utf8')) };
  } catch (err) {
    eventBus.emit(SERVER_LOG, {
      level: 'error',
      message: `Failed to parse Minecraft config ${MC_CONFIG_PATH}: ${err.message}`,
      important: true
    });
    return fallback;
  }
}

function resolveConfiguredPath(configuredPath, fallbackPath) {
  if (!configuredPath || typeof configuredPath !== 'string') return fallbackPath;
  return path.resolve(path.join(__dirname, '..'), configuredPath);
}

function formatBackupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupTimestampToDate(timestamp = '') {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!match) return null;
  const [, day, hour, minute, second, millisecond] = match;
  const parsed = new Date(`${day}T${hour}:${minute}:${second}.${millisecond}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseBackupName(name = '') {
  const match = name.match(/^([dhmtw])-backup-(.+?)(?:\.zip)?$/);
  const legacyMatch = name.match(/^backup-(.+?)(?:\.zip)?$/);
  if (!match && !legacyMatch) return null;
  const prefix = match ? match[1] : 'd';
  const timestamp = match ? match[2] : legacyMatch[1];
  const createdAt = backupTimestampToDate(timestamp);
  if (!createdAt) return null;
  return { prefix, timestamp, createdAt };
}

function getIsoWeekBucket(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const year = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((target - yearStart) / DAY_MS) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function zipDirectory({ sevenZipPath, sourceDirectory, archivePath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath, ['a', '-tzip', archivePath, path.join(sourceDirectory, '*'), '-mx=5'], {
      windowsHide: true
    });

    let output = '';
    child.stdout?.on('data', (data) => {
      output += data.toString();
    });
    child.stderr?.on('data', (data) => {
      output += data.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`7-Zip exited with code ${code}: ${output.trim()}`));
      }
    });
  });
}

function collectPackEntries(packRoot) {
  const packs = [];
  if (!fs.existsSync(packRoot)) return packs;

  for (const entry of fs.readdirSync(packRoot)) {
    const manifestPath = path.join(packRoot, entry, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const packEntry = readPackEntry(manifestPath);
    if (packEntry) {
      packs.push(packEntry);
    }
  }
  return packs;
}

function syncPackList(packRoot, fileName) {
  const filePath = path.join(WORLD_PATH, fileName);
  const installedPacks = collectPackEntries(packRoot);
  if (fileName === 'world_behavior_packs.json') {
    installedPacks.sort((a, b) => {
      if (a.pack_id === LINK_BEHAVIOR_PACK_ID) return -1;
      if (b.pack_id === LINK_BEHAVIOR_PACK_ID) return 1;
      return 0;
    });
  }
  writeJson(filePath, installedPacks);
}

class BedrockServerController {
  constructor() {
    this.process = null;
    this.hasCrashed = false;
    this.stopping = false;
    this.stdoutBuffer = '';
    this.lastLogLevel = 'info';
    this.config = loadMcConfig();
    this.backupPath = resolveConfiguredPath(this.config.backupDirectory, DEFAULT_BACKUP_PATH);
    this.autoBackupTimer = null;
    this.autoBackupRunning = false;
    this.autoBackupTimerStartedAt = null;
    this.crashRestartAttempts = 0;
    this.crashRestartTimer = null;
    this.playerIdentityByName = new Map();
    eventBus.handle(SERVER_COMMAND, async (payload) => this.handleExternalCommand(payload));
    eventBus.on(MINECRAFT_EVENT, ({ event, content }) => {
      switch (event) {
        case ("unwhitelist"): {
          this.removeAllowlist(content.target).catch((err) =>
            eventBus.emit(SERVER_LOG, { level: 'error', message: `Server command failed: ${err.message}` })
          );
          break;
        }
        case ("reload"): {
          this.handleExternalCommand({
            action: "reload"
          }).catch((err) =>
            eventBus.emit(SERVER_LOG, { level: 'error', message: `Server command failed: ${err.message}` })
          );
          break;
        }
        case ("stop"): {
          this.handleExternalCommand({
            action:"stop"
          }).catch((err) => {
            eventBus.emit(SERVER_LOG, { level: 'error', message: `Server command failed: ${err.message}`});
          });
          break;
        }
        case ("restart"): {
          this.handleExternalCommand({
            action:"restart"
          }).catch((err) => {
            eventBus.emit(SERVER_LOG, { level: 'error', message: `Server command failed: ${err.message}`});
          });
          break;
        }
      }
    })
  }

  cleanLogMessage(message = '') {
    return message
      .replace(/^NO LOG FILE!\s*-\s*/i, '')
      .replace(/^\[BDS(?:-ERROR)?\]\s*/i, '')
      .replace(/^.*?INFO]\s*/i, '')
      .trim();
  }

  waitForLogMatch(predicate, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        eventBus.off(SERVER_LOG, onLog);
        reject(new Error('Timed out waiting for server response'));
      }, timeout);

      const onLog = (payload = {}) => {
        try {
          const result = predicate(payload.message || '');
          if (result) {
            clearTimeout(timer);
            eventBus.off(SERVER_LOG, onLog);
            resolve(result);
          }
        } catch (err) {
          clearTimeout(timer);
          eventBus.off(SERVER_LOG, onLog);
          reject(err);
        }
      };

      eventBus.on(SERVER_LOG, onLog);
    });
  }

  parseBackupListing(line = '') {
    const cleaned = this.cleanLogMessage(line);
    return cleaned
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.lastIndexOf(':');
        if (separatorIndex === -1) return null;
        return {
          filePath: entry.slice(0, separatorIndex).trim(),
          length: Number.parseInt(entry.slice(separatorIndex + 1).trim(), 10)
        };
      })
      .filter(Boolean)
      .filter((entry) => entry.filePath && Number.isFinite(entry.length));
  }

  async fetchBackupManifest() {
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
      const waitForListing = this.waitForLogMatch((message) => {
        if (/files are now ready to be copied/i.test(this.cleanLogMessage(message))) {
          return null;
        }

        const parsed = this.parseBackupListing(message);
        return parsed.length ? parsed : null;
      }, Math.max(1000, deadline - Date.now())).catch(() => null);

      this.sendCommand('save query');

      const listing = await waitForListing;

      if (listing?.length) {
        return listing;
      }

      await delay(1000);
    }

    throw new Error('Timed out waiting for Bedrock backup manifest');
  }

  copyManifestFiles(manifest = [], destinationRoot) {
    fs.mkdirSync(destinationRoot, { recursive: true });

    for (const { filePath, length } of manifest) {
      const source = path.join(SERVER_ROOT, 'worlds', filePath);
      const destination = path.join(destinationRoot, filePath);

      if (!fs.existsSync(source)) {
        eventBus.emit(SERVER_LOG, {
          level: 'warn',
          message: `Backup file missing, skipping: ${filePath}`
        });
        continue;
      }

      ensureParentDirectory(destination);
      fs.copyFileSync(source, destination);
      if (Number.isFinite(length)) {
        fs.truncateSync(destination, length);
      }
    }
  }

  copyWorldExtras(destinationRoot) {
    const worldDestination = path.join(destinationRoot, WORLD_NAME);
    const worldSources = [
      path.join(WORLD_PATH, 'world_icon.jpeg'),
      path.join(WORLD_PATH, 'world_behavior_packs.json'),
      path.join(WORLD_PATH, 'world_resource_packs.json')
    ];

    for (const src of worldSources) {
      const dest = path.join(worldDestination, path.basename(src));
      copyIfExists(src, dest);
    }

    copyRecursive(path.join(WORLD_PATH, 'behavior_packs'), path.join(worldDestination, 'behavior_packs'));
    copyRecursive(path.join(WORLD_PATH, 'resource_packs'), path.join(worldDestination, 'resource_packs'));
  }

  copyServerState(destinationRoot) {
    const serverStatePath = path.join(destinationRoot, SERVER_STATE_FOLDER);
    copyIfExists(ALLOWLIST_PATH, path.join(serverStatePath, 'allowlist.json'));
    copyIfExists(PERMISSIONS_PATH, path.join(serverStatePath, 'permissions.json'));
    copyIfExists(SERVER_PROPERTIES_PATH, path.join(serverStatePath, 'server.properties'));
    copyRecursive(SERVER_CONFIG_PATH, path.join(serverStatePath, 'config'));
  }

  async performOnlineBackup(worldDestination) {
    this.sendCommand('save hold');
    try {
      const manifest = await this.fetchBackupManifest();
      this.copyManifestFiles(manifest, worldDestination);
    } finally {
      this.sendCommand('save resume');
    }
  }

  ensureDirectories() {
    fs.mkdirSync(WORLD_PATH, { recursive: true });
    fs.mkdirSync(this.backupPath, { recursive: true });
  }

  ensureLinkAddon() {
    const worldAddonPath = path.join(WORLD_PATH, 'behavior_packs', 'linkaddon');
    const worldResourcePath = path.join(WORLD_PATH, 'resource_packs', 'linkaddon');
    copyRecursive(BEHAVIOR_ADDON_PATH, worldAddonPath);
    copyRecursive(RESOURCE_ADDON_PATH, worldResourcePath);

    const linkScriptPath = path.join(worldAddonPath, 'scripts', 'link.js');
    const agentPort = Number(process.env.AGENT_PORT || process.env.PORT || 3101);
    const localAgentUrl = process.env.MCLINK_AGENT_URL || `http://127.0.0.1:${agentPort}`;
    if (fs.existsSync(linkScriptPath)) {
      const source = fs.readFileSync(linkScriptPath, 'utf8');
      fs.writeFileSync(linkScriptPath, source.replace('__PILOTMC_LOCAL_AGENT_URL__', localAgentUrl));
    }

    syncPackList(path.join(WORLD_PATH, 'behavior_packs'), 'world_behavior_packs.json');
    syncPackList(path.join(WORLD_PATH, 'resource_packs'), 'world_resource_packs.json');
  }

  loadJson(filePath, fallback = []) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      eventBus.emit(SERVER_LOG, { level: 'error', message: `Failed to parse ${filePath}: ${err.message}` });
      return fallback;
    }
  }

  saveJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  async updateAllowlist({ playerId, username, name, xuid, permitted = true, ignoresPlayerLimit = false }) {
    const resolvedUsername = username || name;
    if (!playerId) return { ok: false, message: 'Cannot update allowlist without a player id.' };
    if (!resolvedUsername) return { ok: false, message: 'Cannot update allowlist without a player name.' };
    const existing = this.loadJson(ALLOWLIST_PATH, []);
    const withoutName = existing.filter((entry) => entry.name?.toLowerCase() !== resolvedUsername.toLowerCase());
    const updated = Boolean(permitted)
      ? [
          ...withoutName,
          { name: resolvedUsername, xuid: xuid || undefined, ignoresPlayerLimit: Boolean(ignoresPlayerLimit) }
        ]
      : withoutName;
    this.saveJson(ALLOWLIST_PATH, updated);
    await dbUpsertAllowlistEntry({ playerId, username: resolvedUsername, xuid, permitted, ignoresPlayerLimit });
    let reloadSent = false;
    if (this.process) {
      reloadSent = this.sendCommand('allowlist reload').ok;
    }
    eventBus.emit(SERVER_LOG, { level: 'info', message: `Allowlist updated for ${resolvedUsername}`, important: true });
    return {
      ok: true,
      message: `Allowlist updated for ${resolvedUsername}${reloadSent ? ' and reload command sent.' : '.'}`,
      data: {
        playerId,
        username: resolvedUsername,
        xuid: xuid || null,
        permitted: Boolean(permitted),
        ignoresPlayerLimit: Boolean(ignoresPlayerLimit),
        reloadSent
      }
    };
  }

  async removeAllowlist(nameOrPlayerId) {
    if (!nameOrPlayerId) return { ok: false, message: 'Cannot remove allowlist entry without a player.' };
    const existing = this.loadJson(ALLOWLIST_PATH, []);
    let removed = null;

    if (/^\d+$/.test(String(nameOrPlayerId))) {
      removed = await dbRemoveAllowlistEntryByPlayerId(nameOrPlayerId);
    } else {
      removed = await dbRemoveAllowlistEntry(nameOrPlayerId);
    }

    const removedUsername = removed?.username || nameOrPlayerId;
    const filtered = existing.filter((entry) => entry.name?.toLowerCase() !== String(removedUsername).toLowerCase());
    this.saveJson(ALLOWLIST_PATH, filtered);
    let reloadSent = false;
    if (this.process) {
      reloadSent = this.sendCommand('allowlist reload').ok;
    }
    eventBus.emit(SERVER_LOG, { level: 'info', message: `Allowlist entry removed for ${removedUsername}`, important: true });
    return {
      ok: true,
      message: `Allowlist entry removed for ${removedUsername}${reloadSent ? ' and reload command sent.' : '.'}`,
      data: { username: removedUsername, playerId: removed?.player_id ? Number(removed.player_id) : null, reloadSent }
    };
  }

  async setPermission({ xuid, permission }) {
    const valid = ['operator', 'member', 'visitor'];
    if (!xuid || !valid.includes(permission)) {
      eventBus.emit(SERVER_LOG, {
        level: 'warn',
        message: `Invalid permission payload (xuid=${xuid}, permission=${permission})`
      });
      return { ok: false, message: `Invalid permission payload (xuid=${xuid}, permission=${permission}).` };
    }
    const existing = this.loadJson(PERMISSIONS_PATH, []);
    const without = existing.filter((entry) => entry.xuid !== xuid);
    const updated = [...without, { xuid, permission }];
    this.saveJson(PERMISSIONS_PATH, updated);
    await dbUpsertPermission({ xuid, permission });
    let reloadSent = false;
    if (this.process) {
      reloadSent = this.sendCommand('permission reload').ok;
    }
    eventBus.emit(SERVER_LOG, {
      level: 'info',
      message: `Permissions updated for XUID ${xuid} -> ${permission}`,
      important: true
    });
    return {
      ok: true,
      message: `Permissions updated for XUID ${xuid} -> ${permission}${reloadSent ? ' and reload command sent.' : '.'}`,
      data: { xuid, permission, reloadSent }
    };
  }

  async syncServerConfigFromDatabase() {
    try {
      const allowlistEntries = await getAllowlistEntries();
      const formattedAllowlist = allowlistEntries.map((entry) => ({
        name: entry.username,
        xuid: entry.xuid || undefined,
        ignoresPlayerLimit: Boolean(entry.ignores_player_limit)
      }));
      this.saveJson(ALLOWLIST_PATH, formattedAllowlist);

      const permissions = await getServerPermissions();
      const formattedPermissions = permissions.map(({ xuid, permission }) => ({ xuid, permission }));
      this.saveJson(PERMISSIONS_PATH, formattedPermissions);

      eventBus.emit(SERVER_LOG, {
        level: 'info',
        message: 'Synced allowlist and permissions from database before starting BDS.'
      });
    } catch (err) {
      eventBus.emit(SERVER_LOG, {
        level: 'error',
        message: `Failed to sync server config from database: ${err.message}`,
        important: true
      });
      throw err;
    }
  }

  async start(binaryPath = process.env.BDS_BINARY || DEFAULT_BINARY) {
    this.cancelCrashRestart();
    this.ensureDirectories();
    this.ensureLinkAddon();

    try {
      await this.syncServerConfigFromDatabase();
    } catch (err) {
      eventBus.emit(SERVER_STATE, {
        state: 'error',
        message: 'Unable to start BDS because configuration sync failed.',
        important: true
      });
      return { ok: false, message: 'Unable to start BDS because configuration sync failed.' };
    }

    if (!fs.existsSync(binaryPath)) {
      const message = `Bedrock server binary missing at ${binaryPath}`;
      eventBus.emit(SERVER_STATE, { state: 'missing', message, important: true });
      return { ok: false, message };
    }

    if (this.process) {
      eventBus.emit(SERVER_STATE, { state: 'running', message: 'Server already running' });
      return { ok: true, message: 'Bedrock server is already running.', data: { alreadyRunning: true } };
    }

    eventBus.emit(SERVER_STATE, { state: 'starting', message: 'Starting Bedrock server', important: true });

    const spawnEnv = { ...process.env };
    if (process.platform !== 'win32') {
      spawnEnv.LD_LIBRARY_PATH = SERVER_ROOT;
    }
    const spawnOptions = {
      cwd: SERVER_ROOT,
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false,
      detached: process.platform === "win32"
    };

    // const command = process.platform === 'win32' ? `"${binaryPath}"` : binaryPath;
    // this.process = spawn(command, [], spawnOptions);
    this.process = spawn(binaryPath, [], spawnOptions);

    this.stdoutBuffer = '';
    this.process.stdout.on('data', (data) => {
      this.stdoutBuffer += data.toString();
      const lines = this.stdoutBuffer.split(/\r?\n/);
      this.stdoutBuffer = lines.pop() || '';
      lines
        .filter(Boolean)
        .forEach((line) => this.handleLogLine(line));
    });

    this.process.stdin?.on('error', (err) => {
      if (err?.code === 'EPIPE') return; // expected during shutdown
      eventBus.emit(SERVER_LOG, { level: 'warn', message: `BDS stdin error: ${err.message}` });
    });


    this.process.stderr.on('data', (data) => {
      const line = data.toString();
      this.handleLogLine(line, 'error');
    });

    this.process.on('error', (err) => {
      eventBus.emit(SERVER_STATE, {
        state: 'error',
        message: `Bedrock server failed to launch: ${err.message}`,
        important: true
      });
      this.process = null;
    });

    this.process.on('exit', (code, signal) => {
      const CTRL_C_EXIT = 0xC000013A; // 3221225786

      if (this.stdoutBuffer.trim()) {
        this.handleLogLine(this.stdoutBuffer);
        this.stdoutBuffer = '';
      }

      const stoppedByCtrlC = code === CTRL_C_EXIT;
      const crashed = !this.stopping && !stoppedByCtrlC && code !== 0;

      const message = crashed
        ? `Bedrock server crashed with code ${code ?? 'unknown'}`
        : stoppedByCtrlC
          ? 'Bedrock server stopped (Control-C interrupt)'
          : 'Bedrock server stopped';

      eventBus.emit(SERVER_STATE, { state: 'stopped', message, important: true });

      if (crashed) {
        eventBus.emit(SERVER_LOG, { level: 'error', message, important: true });
      }

      this.process = null;
      this.stopping = false;
      this.stopAutoBackups();

      if (crashed) {
        this.scheduleCrashRestart(message);
      } else {
        this.crashRestartAttempts = 0;
      }
    });

    this.startAutoBackups();

    return { ok: true, message: 'Bedrock server start requested.' };
  }

  stop() {
    this.cancelCrashRestart();
    if (!this.process) {
      eventBus.emit(SERVER_STATE, { state: 'stopped', message: 'Server not running' });
      return Promise.resolve({ ok: true, message: 'Bedrock server is already stopped.', data: { alreadyStopped: true } });
    }

    this.stopping = true;

    const currentProcess = this.process;
    let stopTimeout;
    const awaitExit = new Promise((resolve) => {
      currentProcess.once('exit', () => {
        clearTimeout(stopTimeout);
        resolve({ ok: true, message: 'Bedrock server stopped.' });
      });
    });

    eventBus.emit(SERVER_STATE, { state: 'stopping', message: 'Stopping Bedrock server', important: true });

    // Ask the server to stop gracefully first to ensure worlds are saved.
    const sent = this.sendCommand('stop');
    if (!sent.ok) return Promise.resolve(sent);

    stopTimeout = setTimeout(() => {
      eventBus.emit(SERVER_LOG, {
        level: 'warn',
        message: 'Graceful stop timed out; force killing Bedrock server'
      });
      currentProcess.kill('SIGKILL');
    }, STOP_TIMEOUT_MS);

    return Promise.race([
      awaitExit,
      timeoutResult(STOP_TIMEOUT_MS + 5000, 'Timed out waiting for Bedrock server to stop.')
    ]);
  }

  forceStop() {
    this.cancelCrashRestart();
    if (!this.process) {
      eventBus.emit(SERVER_STATE, { state: 'stopped', message: 'Server not running' });
      return Promise.resolve({ ok: true, message: 'Bedrock server is already stopped.', data: { alreadyStopped: true } });
    }

    const currentProcess = this.process;
    const awaitExit = new Promise((resolve) => {
      currentProcess.once('exit', () => resolve({ ok: true, message: 'Bedrock server force stopped.' }));
    });

    eventBus.emit(SERVER_STATE, { state: 'stopping', message: 'Force stopping Bedrock server', important: true });
    currentProcess.kill('SIGKILL');

    return Promise.race([
      awaitExit,
      timeoutResult(FORCE_STOP_TIMEOUT_MS, 'Timed out waiting for Bedrock server to force stop.')
    ]);
  }

  async restart() {
    const stopResult = await this.stop();
    if (!stopResult?.ok) return stopResult;
    const startResult = await this.start();
    return {
      ok: Boolean(startResult?.ok),
      message: startResult?.ok ? 'Bedrock server restarted.' : startResult?.message || 'Bedrock server restart failed.',
      data: { stop: stopResult, start: startResult }
    };
  }

  scheduleCrashRestart(reason) {
    if (!this.config.autoRestartAfterCrash) return;
    if (this.crashRestartTimer) return;

    const maxAttempts = Number(this.config.autoRestartAttempts);
    if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
      eventBus.emit(SERVER_LOG, {
        level: 'warn',
        message: `Auto restart after crash is enabled, but autoRestartAttempts is invalid: ${this.config.autoRestartAttempts}`,
        important: true
      });
      return;
    }

    if (this.crashRestartAttempts >= maxAttempts) {
      eventBus.emit(SERVER_LOG, {
        level: 'error',
        message: `Bedrock server crashed and auto restart limit was reached (${maxAttempts} attempts).`,
        important: true
      });
      return;
    }

    this.crashRestartAttempts += 1;
    const attempt = this.crashRestartAttempts;
    const delayMs = 5000;

    eventBus.emit(SERVER_LOG, {
      level: 'warn',
      message: `Restarting Bedrock server after crash in ${delayMs / 1000} seconds (attempt ${attempt}/${maxAttempts}). ${reason}`,
      important: true
    });

    this.crashRestartTimer = setTimeout(() => {
      this.crashRestartTimer = null;
      this.start().then((result) => {
        if (!result?.ok) {
          eventBus.emit(SERVER_LOG, {
            level: 'error',
            message: `Auto restart attempt ${attempt}/${maxAttempts} failed: ${result?.message || 'unknown error'}`,
            important: true
          });
        }
      }).catch((err) => {
        eventBus.emit(SERVER_LOG, {
          level: 'error',
          message: `Auto restart attempt ${attempt}/${maxAttempts} failed: ${err.message}`,
          important: true
        });
      });
    }, delayMs);
  }

  cancelCrashRestart() {
    if (!this.crashRestartTimer) return;
    clearTimeout(this.crashRestartTimer);
    this.crashRestartTimer = null;
    eventBus.emit(SERVER_LOG, {
      level: 'info',
      message: 'Cancelled pending crash auto restart.',
      important: true
    });
  }

  findBackups() {
    this.ensureDirectories();
    return fs
      .readdirSync(this.backupPath, { withFileTypes: true })
      .map((entry) => {
        const parsed = parseBackupName(entry.name);
        if (!parsed) return null;
        return {
          ...parsed,
          name: entry.name,
          path: path.join(this.backupPath, entry.name),
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile()
        };
      })
      .filter(Boolean);
  }

  hasBackupForPrefixAndBucket(prefix, bucket) {
    return this.findBackups().some((backup) => backup.prefix === prefix && backup.timestamp.startsWith(bucket));
  }

  getAutomaticBackupPrefix(now = new Date()) {
    const weekBucket = getIsoWeekBucket(now);
    const hasWeeklyBackup = this.findBackups().some(
      (backup) => backup.prefix === 'w' && getIsoWeekBucket(backup.createdAt) === weekBucket
    );
    if (!hasWeeklyBackup) return 'w';

    const timestamp = formatBackupTimestamp(now);
    const dayBucket = timestamp.slice(0, 10);
    if (!this.hasBackupForPrefixAndBucket('d', dayBucket)) return 'd';

    const hourBucket = timestamp.slice(0, 13);
    if (!this.hasBackupForPrefixAndBucket('h', hourBucket)) return 'h';

    return 't';
  }

  cleanupExpiredBackups(now = new Date()) {
    if (!this.config.enableBackupCleanup) return { enabled: false, removed: [] };

    const retentionDays = {
      t: Number(this.config.transientBackupRetentionDays),
      h: Number(this.config.hourlyBackupRetentionDays),
      d: Number(this.config.dailyBackupRetentionDays),
      w: Number(this.config.weeklyBackupRetentionDays)
    };
    const removals = [];
    for (const backup of this.findBackups()) {
      const ageMs = now.getTime() - backup.createdAt.getTime();
      const maxAgeDays = retentionDays[backup.prefix];
      if (Number.isFinite(maxAgeDays) && maxAgeDays >= 0 && ageMs > maxAgeDays * DAY_MS) {
        removeRecursive(backup.path);
        removals.push(backup.name);
      }
    }

    if (removals.length) {
      eventBus.emit(SERVER_LOG, {
        level: 'info',
        message: `Removed ${removals.length} expired backup${removals.length === 1 ? '' : 's'}.`,
        important: true
      });
    }
    return { enabled: true, removed: removals };
  }

  setBackupCleanupEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      return { ok: false, message: 'Backup cleanup requires an enabled boolean.' };
    }

    let savedConfig = {};
    try {
      if (fs.existsSync(MC_CONFIG_PATH)) {
        savedConfig = JSON.parse(fs.readFileSync(MC_CONFIG_PATH, 'utf8'));
      }
    } catch (err) {
      return { ok: false, message: `Could not read Minecraft config: ${err.message}` };
    }

    this.config.enableBackupCleanup = enabled;
    writeJson(MC_CONFIG_PATH, { ...savedConfig, enableBackupCleanup: enabled });
    const state = enabled ? 'resumed' : 'paused';
    return {
      ok: true,
      message: `Automatic backup deletion ${state}. Backup creation is unchanged.`,
      data: { enabled }
    };
  }

  async maybeZipBackup(sourceDirectory) {
    if (!this.config.zipBackups) return sourceDirectory;

    const archivePath = `${sourceDirectory}.zip`;
    try {
      await zipDirectory({
        sevenZipPath: this.config.sevenZipPath,
        sourceDirectory,
        archivePath
      });
      removeRecursive(sourceDirectory);
      return archivePath;
    } catch (err) {
      eventBus.emit(SERVER_LOG, {
        level: 'error',
        message: `Backup was created but could not be zipped: ${err.message}`,
        important: true
      });
      removeRecursive(archivePath);
      return sourceDirectory;
    }
  }

  async backup({ manual = false } = {}) {
    this.ensureDirectories();
    const now = new Date();
    const timestamp = formatBackupTimestamp(now);
    const prefix = manual ? 'm' : this.getAutomaticBackupPrefix(now);
    const destination = path.join(this.backupPath, `${prefix}-backup-${timestamp}`);
    const worldDestination = path.join(destination, 'worlds');

    fs.mkdirSync(destination, { recursive: true });

    try {
      if (this.process) {
        await this.performOnlineBackup(worldDestination);
      } else {
        copyRecursive(WORLD_PATH, path.join(worldDestination, WORLD_NAME));
      }
    } catch (err) {
      eventBus.emit(SERVER_LOG, {
        level: 'error',
        message: `Online backup failed (${err.message}). Falling back to offline copy.`,
        important: true
      });
      copyRecursive(WORLD_PATH, path.join(worldDestination, WORLD_NAME));
    }

    this.copyWorldExtras(worldDestination);
    this.copyServerState(destination);
    const finalDestination = await this.maybeZipBackup(destination);

    this.cleanupExpiredBackups(now);

    const message = `World backup created at ${finalDestination}`;
    eventBus.emit(SERVER_BACKUP, { path: finalDestination, message, important: true });
    eventBus.emit(SERVER_LOG, { level: 'info', message, important: true });
    return { ok: true, message, data: { path: finalDestination } };
  }

  requestBackup() {
    setImmediate(() => {
      this.backup({ manual: true }).catch((err) => {
        eventBus.emit(SERVER_LOG, {
          level: 'error',
          message: `Backup failed: ${err.message}`,
          important: true
        });
      });
    });
    return { ok: true, message: 'Backup started. I will post the backup completion log when it finishes.' };
  }

  requestLiveInventory({ username } = {}) {
    const playerName = String(username || '').trim();
    if (!playerName) return Promise.resolve({ ok: false, message: 'Player username is required.' });
    if (!this.process) return Promise.resolve({ ok: false, message: 'Bedrock server is not running.' });

    const requestId = crypto.randomUUID();
    const message = Buffer.from(JSON.stringify({ requestId, username: playerName }), 'utf8').toString('base64');
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timeout);
        eventBus.off(MINECRAFT_EVENT, handleResponse);
      };
      const handleResponse = ({ event, content } = {}) => {
        if (event !== 'inventoryResponse' || content?.requestId !== requestId) return;
        cleanup();
        if (content.error) {
          resolve({ ok: false, message: content.error });
          return;
        }
        resolve({ ok: true, message: `Live inventory loaded for ${playerName}.`, data: content });
      };
      const timeout = setTimeout(() => {
        eventBus.off(MINECRAFT_EVENT, handleResponse);
        resolve({ ok: false, message: `Timed out reading live inventory for ${playerName}.` });
      }, 10000);
      eventBus.on(MINECRAFT_EVENT, handleResponse);
      const sent = this.sendCommand(`scriptevent mclink:inventory ${message}`);
      if (!sent.ok) {
        cleanup();
        resolve(sent);
      }
    });
  }

  startAutoBackups() {
    this.cleanupExpiredBackups();
    if (!this.config.enableAutoBackup) return;
    if (this.autoBackupTimer) return;

    const frequencyMinutes = Number(this.config.backupFrequencyMinutes);
    if (!Number.isFinite(frequencyMinutes) || frequencyMinutes <= 0) {
      eventBus.emit(SERVER_LOG, {
        level: 'warn',
        message: `Automatic backups are enabled, but backupFrequencyMinutes is invalid: ${this.config.backupFrequencyMinutes}`,
        important: true
      });
      return;
    }

    const intervalMs = frequencyMinutes * 60 * 1000;
    this.autoBackupTimerStartedAt = new Date().toISOString();
    this.autoBackupTimer = setInterval(() => {
      if (this.autoBackupRunning) {
        eventBus.emit(SERVER_LOG, {
          level: 'warn',
          message: 'Automatic backup skipped because the previous backup is still running.',
          important: true
        });
        return;
      }

      this.autoBackupRunning = true;
      eventBus.emit(SERVER_LOG, {
        level: 'info',
        message: `Automatic backup started (${frequencyMinutes} minute interval, pid ${process.pid}).`,
        important: true
      });
      this.backup()
        .catch((err) => {
          eventBus.emit(SERVER_LOG, {
            level: 'error',
            message: `Automatic backup failed: ${err.message}`,
            important: true
          });
        })
        .finally(() => {
          this.autoBackupRunning = false;
        });
    }, intervalMs);

    eventBus.emit(SERVER_LOG, {
      level: 'info',
      message: `Automatic backups scheduled every ${frequencyMinutes} minutes (pid ${process.pid}).`,
      important: true
    });
  }

  stopAutoBackups() {
    if (!this.autoBackupTimer) return;
    clearInterval(this.autoBackupTimer);
    this.autoBackupTimer = null;
    this.autoBackupRunning = false;
    this.autoBackupTimerStartedAt = null;
  }

  async update(details = 'Manual update triggered') {
    eventBus.emit(SERVER_LOG, { level: 'info', message: `Update requested: ${details}` });
    return { ok: true, message: `Update requested: ${details}` };
  }

  sendCommand(command) {
    const p = this.process;
    if (!p) {
      const message = `Cannot send command, server offline: ${command}`;
      eventBus.emit(SERVER_LOG, { level: 'warn', message });
      return { ok: false, message };
    }

    const stdin = p.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      const message = `Cannot send command, stdin closed: ${command}`;
      eventBus.emit(SERVER_LOG, { level: 'warn', message });
      return { ok: false, message };
    }

    // If the process has already exited (or is exiting), don't write.
    if (p.killed || p.exitCode !== null) {
      const message = `Cannot send command, process exiting/exited: ${command}`;
      eventBus.emit(SERVER_LOG, { level: 'warn', message });
      return { ok: false, message };
    }

    try {
      // Use \r\n on Windows console apps; harmless elsewhere.
      stdin.write(`${command}\r\n`, (err) => {
        if (err) {
          // EPIPE is normal during shutdown; don't crash the whole wrapper.
          if (err.code !== 'EPIPE') {
            eventBus.emit(SERVER_LOG, { level: 'warn', message: `Failed to send command "${command}": ${err.message}` });
          }
        }
      });

      return { ok: true, message: `Sent command to Bedrock server: ${command}`, data: { command } };
    } catch (err) {
      if (err?.code !== 'EPIPE') {
        eventBus.emit(SERVER_LOG, { level: 'warn', message: `Failed to send command "${command}": ${err.message}` });
      }
      return { ok: false, message: `Failed to send command "${command}": ${err.message}` };
    }
  }


  parseJsonPayload(normalized = '') {
    const jsonMatch = normalized.match(/\{.*\}$/);
    if (!jsonMatch) return null;

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      eventBus.emit(SERVER_LOG, {
        level: 'warn',
        message: `Failed to parse JSON from log line: ${err.message} | ${normalized}`
      });
      return null;
    }
  }

  // handleLogLine(line, level = 'info') {
  //   const raw = (line || '').trim();
  //   if (!raw) return;

  //   console.log(`[BDS] ${raw}`);

  //   const timestampMatch = raw.match(/^\[BDS\]\s*\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}:\d{3})\s+([A-Z]+)\]\s*(.*)$/);

  //   let normalized;
  //   let derivedLevel = level;

  //   if (timestampMatch) {
  //     const [, , severity, rest] = timestampMatch;
  //     normalized = rest.trim();
  //     derivedLevel = (severity || '').toLowerCase() || level;
  //     this.lastLogLevel = derivedLevel;
  //   } else {
  //     normalized = raw.replace(/^\[BDS\]\s*/i, '').trim();
  //     derivedLevel = this.lastLogLevel || level;
  //   }

  //   const importantPatterns = [
  //     { regex: /server (start|starting)/i, reason: 'Server starting' },
  //     { regex: /server stop/i, reason: 'Server stopping' },
  //     { regex: /crash/i, reason: 'Server crash detected' },
  //     { regex: /whitelist/i, reason: 'Whitelist change' },
  //     { regex: /opped/i, reason: 'Operator change' },
  //     { regex: /de-?opped/i, reason: 'Operator removed' }
  //   ];

  //   const important = importantPatterns.some((pattern) => pattern.regex.test(normalized));
  //   eventBus.emit(SERVER_LOG, { level: derivedLevel, message: normalized, important });

  //   const playerJoinMatch = normalized.match(/Player connected:\s*([^,]+),\s*xuid:\s*([\w-]+)/i);
  //   if (playerJoinMatch) {
  //     const [, username, xuid] = playerJoinMatch;
  //     dbUpdateMinecraftProfileXuid(username, xuid).catch((err) => {
  //       console.error(`Failed to update XUID for ${username}: ${err.message}`);
  //     });
  //   }

  //   if (/server (start|started)/i.test(normalized)) {
  //     eventBus.emit(SERVER_STATE, { state: 'running', message: 'Bedrock server is online', important: true });
  //   }
  //   if (/server stop/i.test(normalized)) {
  //     eventBus.emit(SERVER_STATE, { state: 'stopping', message: 'Bedrock server stopping', important: true });
  //   }
  //   if (/crash/i.test(normalized)) {
  //     eventBus.emit(SERVER_STATE, { state: 'crashed', message: normalized, important: true });
  //   }

  //   if (normalized.startsWith('INFO] [Scripting] [MCLINK] [Chat Sent]')) {
  //     const payload = this.parseJsonPayload(normalized.replace('INFO] [Scripting] [MCLINK] [Chat Sent]', ''));
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'chatSent', content: payload, raw: normalized });
  //     }
  //   } else if (normalized.startsWith('INFO] [Scripting] [MCLINK] [PLAYER GAMEMODE CHANGE]')) {
  //     const payload = this.parseJsonPayload(
  //       normalized.replace('INFO] [Scripting] [MCLINK] [PLAYER GAMEMODE CHANGE]', '')
  //     );
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'playerGamemodeChange', content: payload, raw: normalized });
  //     }
  //   } else if (normalized.startsWith('INFO] [Scripting] [MCLINK] [PLAYER PLACE BLOCK]')) {
  //     const payload = this.parseJsonPayload(
  //       normalized.replace('INFO] [Scripting] [MCLINK] [PLAYER PLACE BLOCK]', '')
  //     );
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'playerPlaceBlock', content: payload, raw: normalized });
  //     }
  //   } else if (normalized.startsWith('INFO] [Scripting] [MCLINK] [PLAYER BREAK BLOCK]')) {
  //     const payload = this.parseJsonPayload(
  //       normalized.replace('INFO] [Scripting] [MCLINK] [PLAYER BREAK BLOCK]', '')
  //     );
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'playerBreakBlock', content: payload, raw: normalized });
  //     }
  //   } else if (normalized.startsWith('INFO] [Scripting] [MCLINK][EFFECT ADDED]')) {
  //     const payload = this.parseJsonPayload(normalized.replace('INFO] [Scripting] [MCLINK][EFFECT ADDED]', ''));
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'effectAdded', content: payload, raw: normalized });
  //     }
  //   } else if (normalized.startsWith('INFO] [Scripting] [MCLINK] [GAMERULE CHANGED]')) {
  //     const payload = this.parseJsonPayload(normalized.replace('INFO] [Scripting] [MCLINK] [GAMERULE CHANGED]', ''));
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'gameruleChanged', content: payload, raw: normalized });
  //     }
  //   } else if (normalized.startsWith('INFO] [Scripting] [MCLINK] [PLAYER DIMENSION CHANGE]')) {
  //     const payload = this.parseJsonPayload(
  //       normalized.replace('INFO] [Scripting] [MCLINK] [PLAYER DIMENSION CHANGE]', '')
  //     );
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'playerDimensionChange', content: payload, raw: normalized });
  //     }
  //   } else if (normalized.startsWith('INFO] [Scripting] [MCLINK] [ENTITY DIED]')) {
  //     const payload = this.parseJsonPayload(normalized.replace('INFO] [Scripting] [MCLINK] [ENTITY DIED]', ''));
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'entityDied', content: payload, raw: normalized });
  //     }
  //   } else if (normalized.startsWith('INFO] [Scripting] [MCLINK] [PLAYER LIST]')) {
  //     const payload = this.parseJsonPayload(normalized.replace('INFO] [Scripting] [MCLINK] [PLAYER LIST]', ''));
  //     if (payload) {
  //       eventBus.emit(MINECRAFT_EVENT, { event: 'playerList', content: payload, raw: normalized });
  //     }
  //   }
  // }
  handleLogLine(line, sourceLevel = 'info') {
    const raw = (line || '').trim();
    if (!raw) return;

    if (sourceLevel === 'error') {
      Log.error('BDS', raw);
      return;
    }

    if (raw.startsWith('Quit correctly')) {
      Log.info('BDS', raw);
      eventBus.emit(SERVER_LOG, { level: 'info', message: raw, important: true });
      // Do NOT emit SERVER_STATE stopped here; wait for the real 'exit' event.
      return;
    }



    const bdsLine = raw.replace(/^NO LOG FILE!\s*-\s*/i, '').trim();
    const [, timestamp, level, rest = ""] = bdsLine.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}:\d{3})\s+([^\]]+)\](?:\s+(.*))?$/) || [];

    const normalized = rest.trim();
    if (
      normalized.startsWith('[Scripting] [Players Update]')
      || normalized.startsWith('[Scripting] [Player Message]')
    ) {
      return;
    }

    if (normalized) {
      Log.info('BDS', normalized);
    } else {
      Log.info('BDS', raw);
    }

    if (normalized.startsWith('Server started.')) {
      this.crashRestartAttempts = 0;
      eventBus.emit(SERVER_STATE, { state: 'running', message: 'Bedrock server is online', important: true });
      return;
    } else if (normalized.startsWith('Starting Server')) {
      eventBus.emit(SERVER_STATE, { state: 'starting', message: 'Bedrock server starting', important: true });
      return;
    } else if (normalized.startsWith('Stopping server...')) {
      eventBus.emit(SERVER_STATE, { state: 'stopping', message: 'Bedrock server stopping', important: true });
      return;
    } else if (normalized.startsWith('Player connected:')) {
      const [, username, xuid] = normalized.match(/^Player connected:\s*(.+?),\s*xuid:\s*([0-9]+)\s*$/) || [];
      if (username && xuid) {
        this.playerIdentityByName.set(username.toLowerCase(), { username, xuid, pfid: null });
        createServerEvent({ eventType: 'minecraft.xuid_seen', username, xuid }).catch((err) => {
          Log.error('BDS', `Failed to record XUID event for ${username}: ${err.message}`);
        });
      }
      return;
    } else if (normalized.startsWith('Player Spawned:')) {
      const [, username, xuid, pfid] = normalized.match(/^Player Spawned:\s*(.+?)\s+xuid:\s*([0-9]+),\s*pfid:\s*([A-Fa-f0-9]+)\s*$/) || [];
      if (username && xuid) {
        this.playerIdentityByName.set(username.toLowerCase(), { username, xuid, pfid: pfid || null });
        eventBus.emit(MINECRAFT_EVENT, {
          event: 'playerJoin',
          content: { username, xuid, pfid: pfid || null },
          raw: normalized
        });
      }
      return;
    } else if (normalized.startsWith('Player disconnected:')) {
      const [, username, xuid, pfid] = normalized.match(/^Player disconnected:\s*(.+?),\s*xuid:\s*([0-9]+),\s*pfid:\s*([A-Fa-f0-9]+)\s*$/) || [];
      if (username) {
        const cached = this.playerIdentityByName.get(username.toLowerCase()) || {};
        eventBus.emit(MINECRAFT_EVENT, {
          event: 'playerLeave',
          content: {
            username,
            xuid: xuid || cached.xuid || null,
            pfid: pfid || cached.pfid || null
          },
          raw: normalized
        });
        this.playerIdentityByName.delete(username.toLowerCase());
      }
      return;
    }

    const message = normalized || raw;
    const messageLevel = (level || sourceLevel || 'info').toLowerCase();
    const noisyBackupOutput = messageLevel === 'info' && (
      message === 'Saving...'
      || /^Data saved\. Files are now ready to be copied\.$/.test(message)
      || /^Bedrock level\/.+?:\d+(?:, Bedrock level\/.+?:\d+)+$/.test(message)
    );
    if (!noisyBackupOutput) eventBus.emit(SERVER_LOG, { level: messageLevel, message });
  }

  async handleExternalCommand(payload = {}) {
    const { action, command } = payload;
    switch (action) {
      case 'restart':
        return this.restart();
      case 'reload':
        //using this reload action will copy over the mclink pack, then run the reload command.
        this.ensureLinkAddon();
        return this.sendCommand('reload');
      case 'stop':
        return this.stop();
      case 'forceStop':
        return this.forceStop();
      case 'start':
        return this.start();
      case 'backup':
        return this.requestBackup();
      case 'backupCleanup:set':
        return this.setBackupCleanupEnabled(payload.enabled);
      case 'inventory:get':
        return this.requestLiveInventory(payload);
      case 'update':
        return this.update(payload.details);
      case 'command':
        return this.sendCommand(command);
      case 'internal':// This runs the command from inside the bds, instead of on the server process stdin.
        // Use for commands with characters outside the ascii range, as it sends via base64 encoding.
        return this.sendCommand(`scriptevent mclink:intrun ${Buffer.from(command, "utf8").toString("base64")}`);
      case 'allowlist:add':
        return this.updateAllowlist(payload);
      case 'allowlist:remove':
        return this.removeAllowlist(payload.playerId || payload.name || payload.username);
      case 'permission:set':
        return this.setPermission(payload);
      default:
        eventBus.emit(SERVER_LOG, { level: 'warn', message: `Unknown server command: ${action}` });
        return { ok: false, message: `Unknown server command: ${action}` };
    }
  }
}

module.exports = function createServer() {
  return new BedrockServerController();
};
