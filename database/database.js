const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectionOptions = {
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'pilotmc_instance',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
};

const pool = new Pool(connectionOptions);

async function query(text, params) {
  return pool.query(text, params);
}

async function close() {
  await pool.end();
}

async function healthCheck() {
  const result = await query('SELECT NOW() AS now, current_database() AS database;');
  return result.rows[0];
}

async function validateSchema() {
  const requiredTables = ['allowlist', 'server_permissions', 'player_server_state', 'server_events'];
  const result = await query(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[]);
    `,
    [requiredTables]
  );
  const existingTables = new Set(result.rows.map((row) => row.table_name));
  const missingTables = requiredTables.filter((tableName) => !existingTables.has(tableName));

  if (missingTables.length) {
    throw new Error(`Missing required pilotmc_instance tables: ${missingTables.join(', ')}`);
  }

  return { ok: true, tables: requiredTables };
}

function normalizeAllowlist(row) {
  if (!row) return null;
  return {
    id: row.id ? Number(row.id) : null,
    playerId: Number(row.player_id),
    username: row.username,
    xuid: row.xuid,
    permitted: row.permitted,
    ignoresPlayerLimit: row.ignores_player_limit,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizePermission(row) {
  if (!row) return null;
  return {
    id: row.id ? Number(row.id) : null,
    playerId: row.player_id ? Number(row.player_id) : null,
    xuid: row.xuid,
    permission: row.permission,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizePlayerServerState(row) {
  if (!row) return null;
  return {
    id: row.id ? Number(row.id) : null,
    playerId: Number(row.player_id),
    username: row.username,
    lastSeenXuid: row.last_seen_xuid,
    lastJoinedAt: row.last_joined_at,
    lastLeftAt: row.last_left_at,
    lastKnownOnline: row.last_known_online,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function upsertAllowlistEntry({
  playerId,
  username,
  name,
  xuid,
  permitted = true,
  ignoresPlayerLimit = false
}) {
  const resolvedUsername = username || name;
  if (!playerId) throw new Error('playerId is required');
  if (!resolvedUsername) throw new Error('username is required');

  const result = await query(
    `
    INSERT INTO allowlist (player_id, username, xuid, permitted, ignores_player_limit, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (player_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      xuid = EXCLUDED.xuid,
      permitted = EXCLUDED.permitted,
      ignores_player_limit = EXCLUDED.ignores_player_limit,
      updated_at = NOW()
    RETURNING *;
    `,
    [playerId, resolvedUsername, xuid || null, Boolean(permitted), Boolean(ignoresPlayerLimit)]
  );

  return result.rows[0] || null;
}

async function removeAllowlistEntryByPlayerId(playerId) {
  if (!playerId) throw new Error('playerId is required');
  const result = await query('DELETE FROM allowlist WHERE player_id = $1 RETURNING *;', [playerId]);
  return result.rows[0] || null;
}

async function removeAllowlistEntry(username) {
  if (!username) throw new Error('username is required');
  const result = await query('DELETE FROM allowlist WHERE LOWER(username) = LOWER($1) RETURNING *;', [username]);
  return result.rows[0] || null;
}

async function upsertPermission({ playerId = null, xuid, permission }) {
  if (!xuid) throw new Error('xuid is required');
  if (!permission) throw new Error('permission is required');

  const result = await query(
    `
    INSERT INTO server_permissions (player_id, xuid, permission, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (xuid)
    DO UPDATE SET
      player_id = EXCLUDED.player_id,
      permission = EXCLUDED.permission,
      updated_at = NOW()
    RETURNING *;
    `,
    [playerId, xuid, permission]
  );

  return result.rows[0] || null;
}

async function getAllowlistEntries() {
  const result = await query(
    `
    SELECT player_id, username, xuid, ignores_player_limit
    FROM allowlist
    WHERE permitted = TRUE
    ORDER BY LOWER(username);
    `
  );
  return result.rows;
}

async function getAllowlistEntryByUsername(username) {
  if (!username) return null;
  const result = await query('SELECT * FROM allowlist WHERE LOWER(username) = LOWER($1);', [username]);
  return normalizeAllowlist(result.rows[0]);
}

async function getServerProfileForPlayer(playerId) {
  if (!playerId) throw new Error('playerId is required');
  const result = await query(
    `
    SELECT
      row_to_json(a.*) AS allowlist,
      row_to_json(p.*) AS permission,
      row_to_json(s.*) AS state
    FROM (SELECT $1::bigint AS player_id) target
    LEFT JOIN allowlist a ON a.player_id = target.player_id
    LEFT JOIN server_permissions p ON p.player_id = target.player_id
      OR (a.xuid IS NOT NULL AND p.xuid = a.xuid)
    LEFT JOIN player_server_state s ON s.player_id = target.player_id;
    `,
    [playerId]
  );
  const row = result.rows[0] || {};
  return {
    allowlist: normalizeAllowlist(row.allowlist),
    permission: normalizePermission(row.permission),
    state: normalizePlayerServerState(row.state)
  };
}

async function getServerPermissions() {
  const result = await query('SELECT player_id, xuid, permission FROM server_permissions ORDER BY xuid;');
  return result.rows;
}

async function updatePlayerServerState({ playerId, username, xuid, online }) {
  if (!playerId || !username) return null;
  const joinedAtSql = online ? 'NOW()' : 'player_server_state.last_joined_at';
  const leftAtSql = online ? 'player_server_state.last_left_at' : 'NOW()';

  const result = await query(
    `
    INSERT INTO player_server_state (
      player_id,
      username,
      last_seen_xuid,
      last_joined_at,
      last_left_at,
      last_known_online,
      updated_at
    )
    VALUES ($1, $2, $3, ${online ? 'NOW()' : 'NULL'}, ${online ? 'NULL' : 'NOW()'}, $4, NOW())
    ON CONFLICT (player_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      last_seen_xuid = EXCLUDED.last_seen_xuid,
      last_joined_at = ${joinedAtSql},
      last_left_at = ${leftAtSql},
      last_known_online = EXCLUDED.last_known_online,
      updated_at = NOW()
    RETURNING *;
    `,
    [playerId, username, xuid || null, Boolean(online)]
  );

  return result.rows[0] || null;
}

async function createServerEvent({ eventType, playerId = null, username = null, xuid = null, details = {} }) {
  if (!eventType) throw new Error('eventType is required');
  const result = await query(
    `
    INSERT INTO server_events (event_type, player_id, username, xuid, details)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING *;
    `,
    [eventType, playerId, username, xuid, JSON.stringify(details || {})]
  );
  return result.rows[0] || null;
}

module.exports = {
  pool,
  query,
  close,
  healthCheck,
  validateSchema,
  upsertAllowlistEntry,
  removeAllowlistEntry,
  removeAllowlistEntryByPlayerId,
  upsertPermission,
  getAllowlistEntries,
  getAllowlistEntryByUsername,
  getServerProfileForPlayer,
  getServerPermissions,
  updatePlayerServerState,
  createServerEvent
};
