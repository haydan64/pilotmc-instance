const text = (title, extra = {}) => ({ type: 'string', title, default: '', ...extra });
const flag = (title, value = false) => ({ type: 'boolean', title, default: value });
const number = (title, value, min = 0, max = 3650) => ({ type: 'integer', title, default: value, minimum: min, maximum: max });
const object = (title, properties) => ({ type: 'object', title, properties, additionalProperties: false });
const list = (title, items, extra = {}) => ({ type: 'array', title, items, default: [], maxItems: 100, ...extra });
const role = (title) => text(title, { pattern: '^$|^[0-9]{17,20}$', description: 'Discord role ID' });
const channel = (title) => text(title, { pattern: '^$|^[0-9]{17,20}$', description: 'Discord channel ID' });
const roleList = (title) => list(title, { ...role('Role ID'), minLength: 17, pattern: '^[0-9]{17,20}$' });
const instanceSchema = object('Minecraft behavior', {
  enableAutoBackup: flag('Automatic backups'), enableBackupCleanup: flag('Backup cleanup', true),
  backupFrequencyMinutes: number('Backup interval (minutes)', 60, 1, 10080), zipBackups: flag('Compress backups'),
  transientBackupRetentionDays: number('Transient backup retention (days)', 2),
  hourlyBackupRetentionDays: number('Hourly backup retention (days)', 7),
  dailyBackupRetentionDays: number('Daily backup retention (days)', 32),
  weeklyBackupRetentionDays: number('Weekly backup retention (days)', 365),
  autoRestartAfterCrash: flag('Restart after crashes'), autoRestartAttempts: number('Crash restart attempts', 3, 0, 100)
});
const schema = object('Deployment configuration', {
  discord: object('Discord', {
    guildId: text('Guild ID', { pattern: '^$|^[0-9]{17,20}$' }), clientId: text('Application ID', { pattern: '^$|^[0-9]{17,20}$' }),
    channels: object('Channels', Object.fromEntries(['bdsLog','discordLog','joinLeave','waitingRoom','applications','applyHere','usernameChangeReview'].map(key => [key, channel(key)]))),
    roles: object('Roles', Object.fromEntries(['developer','admin','staff','guest','member'].map(key => [key, role(key)]))),
    webhooks: object('Webhooks', { minecraftChatName: text('Minecraft chat webhook name', { maxLength: 80 }) }),
    applicationIntro: text('Application introduction', { multiline: true, maxLength: 2000 }),
    requireAcceptedApplicationForLinking: flag('Require accepted application to link Minecraft'),
    questions: list('Application questions', object('Question', {
      id: text('Stable question ID', { minLength: 1, maxLength: 60, pattern: '^[a-zA-Z0-9_-]+$' }), label: text('Label', { minLength: 1, maxLength: 45 }),
      prompt: text('Question', { minLength: 1, maxLength: 1000, multiline: true }), required: flag('Required', true),
      formLabel: text('Form label', { maxLength: 45 }), formDescription: text('Form description', { maxLength: 100 })
    }), { maxItems: 10 })
  }),
  website: object('Website', {
    siteName: text('Site name', { default: 'PilotMC', minLength: 1, maxLength: 100 }),
    siteShortName: text('Short name', { default: 'PilotMC', minLength: 1, maxLength: 60 }),
    siteDescription: text('Description', { multiline: true, maxLength: 2000 }),
    publicUrl: text('Public URL', { format: 'url' }), discordRedirectUri: text('Discord OAuth callback URL', { format: 'url' }),
    discordClientId: text('OAuth application ID override (blank uses Discord application)', { pattern: '^$|^[0-9]{17,20}$' }), discordGuildId: text('Guild ID override (blank uses Discord guild)', { pattern: '^$|^[0-9]{17,20}$' }),
    logoUrl: text('Logo URL or /assets/brand-logo.png', { format: 'asset' }), faviconUrl: text('Favicon URL or /favicon.ico', { format: 'asset' })
  }),
  backend: object('Backend behavior', {
    agentTimeoutMs: number('Instance request timeout (ms)', 10000, 1000, 60000),
    discordAuthTimeoutMs: number('Discord authorization timeout (ms)', 5000, 1000, 60000)
  }),
  servers: list('Minecraft servers', object('Server', {
    key: text('Server key', { minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' }), name: text('Display name', { minLength: 1, maxLength: 100 }),
    allowlist: object('Allowlist policy', {
      autoAllowlist: flag('Automatically allowlist linked players'), requiredRoleIds: roleList('Any required role'), blockedRoleIds: roleList('Blocking roles'),
      requireDiscordMembership: flag('Require Discord membership'), removeOnDiscordLeave: flag('Remove access on Discord departure')
    }),
    chat: object('Chat relay', { enabled: flag('Enable chat relay'), channelId: channel('Discord chat channel') }),
    listing: object('Server listing', {
      enabled: flag('Publish listing'), channelId: channel('Listing channel'), requiresAcceptedApplication: flag('Require accepted application'),
      requiredRoleId: role('Additional listing role'), buttonLabel: text('Button label', { default: 'Get Whitelisted', maxLength: 80 }),
      message: object('Listing message', { content: text('Message text', { multiline: true, maxLength: 2000 }),
        embeds: { type: 'array', title: 'Discord embeds (JSON)', default: [], maxItems: 10, items: { type: 'object', additionalProperties: true }, jsonEditor: true }
      })
    }),
    instance: instanceSchema
  }))
});
function defaults(node = schema) {
  if (node.default !== undefined) return structuredClone(node.default);
  if (node.type === 'object') return Object.fromEntries(Object.entries(node.properties || {}).map(([key, value]) => [key, defaults(value)]));
  return node.type === 'array' ? [] : null;
}
function validate(value, node = schema, at = 'config', errors = []) {
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (node.type === 'integer' ? !Number.isInteger(value) : actual !== node.type) { errors.push(`${at}: expected ${node.type}`); return errors; }
  if (node.type === 'object') {
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(node.properties, key)) errors.push(`${at}.${key}: unknown setting (secrets and host paths belong in local environment variables)`);
      for (const [key, child] of Object.entries(node.properties)) validate(value[key], child, `${at}.${key}`, errors);
    }
  }
  if (node.type === 'array') {
    if (value.length > node.maxItems) errors.push(`${at}: at most ${node.maxItems} entries`);
    value.forEach((item, index) => validate(item, node.items, `${at}[${index}]`, errors));
  }
  if (node.type === 'string') {
    if (value.length > (node.maxLength || 4000) || value.length < (node.minLength || 0)) errors.push(`${at}: invalid text length`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${at}: invalid format`);
    if (value && node.format) {
      if (node.format === 'asset' && value.startsWith('/') && !value.startsWith('//')) { /* local asset */ }
      else { try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { errors.push(`${at}: use an HTTP(S) URL${node.format === 'asset' ? ' or an absolute URL path' : ''}`); } }
    }
  }
  if (node.type === 'integer' && (value < node.minimum || value > node.maximum)) errors.push(`${at}: must be ${node.minimum}–${node.maximum}`);
  return errors;
}
function assertConfig(config) {
  const errors = validate(config);
  if (!errors.length) {
    for (const [entries, key, label] of [[config.servers, 'key', 'Server keys'], [config.discord.questions, 'id', 'Question IDs']]) {
      if (new Set(entries.map(item => item[key])).size !== entries.length) errors.push(`${label} must be unique`);
    }
    if (config.discord.questions.length && !config.discord.channels.applications) errors.push('An applications review channel is required when questions are configured');
    if (config.servers.some(server => server.chat.enabled && !server.chat.channelId)) errors.push('Enabled chat relays need a channel ID');
    if (config.servers.some(server => server.listing.enabled && !server.listing.channelId)) errors.push('Enabled server listings need a channel ID');
    if (config.servers.some(server => server.listing.enabled && !server.listing.message.content && !server.listing.message.embeds.length)) errors.push('Enabled server listings need message content or embeds');
    for (const server of config.servers) {
      let length = 0;
      for (const embed of server.listing.message.embeds) {
        const allowed = ['title','description','url','color','timestamp','footer','image','thumbnail','author','fields'];
        if (Object.keys(embed).some(key => !allowed.includes(key))) errors.push(`${server.key}: invalid embed property`);
        if (embed.title !== undefined && (typeof embed.title !== 'string' || embed.title.length > 256)) errors.push(`${server.key}: invalid embed title`);
        if (embed.description !== undefined && (typeof embed.description !== 'string' || embed.description.length > 4096)) errors.push(`${server.key}: invalid embed description`);
        if (embed.fields !== undefined && (!Array.isArray(embed.fields) || embed.fields.length > 25 || embed.fields.some(field => !field || typeof field !== 'object' || typeof field.name !== 'string' || !field.name.length || field.name.length > 256 || typeof field.value !== 'string' || !field.value.length || field.value.length > 1024))) errors.push(`${server.key}: invalid embed fields`);
        const nested = (value, allowedKeys, requiredText, limit, label) => {
          if (value === undefined) return;
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowedKeys.includes(key))) { errors.push(`${server.key}: invalid ${label}`); return; }
          if (requiredText && (typeof value[requiredText] !== 'string' || !value[requiredText].length || value[requiredText].length > limit)) errors.push(`${server.key}: invalid ${label} ${requiredText}`);
          for (const key of ['url', 'icon_url']) if (value[key] !== undefined) {
            try { const parsed = new URL(value[key]); if (typeof value[key] !== 'string' || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); }
            catch { errors.push(`${server.key}: invalid ${label} ${key}`); }
          }
          if (value.inline !== undefined && typeof value.inline !== 'boolean') errors.push(`${server.key}: invalid inline field flag`);
        };
        nested(embed.footer, ['text','icon_url'], 'text', 2048, 'embed footer');
        nested(embed.author, ['name','url','icon_url'], 'name', 256, 'embed author');
        nested(embed.image, ['url'], 'url', 2048, 'embed image');
        nested(embed.thumbnail, ['url'], 'url', 2048, 'embed thumbnail');
        if (Array.isArray(embed.fields)) for (const field of embed.fields) nested(field, ['name','value','inline'], 'name', 256, 'embed field');
        if (embed.url !== undefined) { try { const parsed = new URL(embed.url); if (typeof embed.url !== 'string' || !['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); } catch { errors.push(`${server.key}: invalid embed URL`); } }
        if (embed.color !== undefined && (!Number.isInteger(embed.color) || embed.color < 0 || embed.color > 0xffffff)) errors.push(`${server.key}: invalid embed color`);
        if (embed.timestamp !== undefined && (typeof embed.timestamp !== 'string' || !Number.isFinite(Date.parse(embed.timestamp)))) errors.push(`${server.key}: invalid embed timestamp`);
        length += (embed.title || '').length + (embed.description || '').length + (embed.footer?.text || '').length + (embed.author?.name || '').length + (Array.isArray(embed.fields) ? embed.fields.reduce((sum, field) => sum + String(field?.name || '').length + String(field?.value || '').length, 0) : 0);
      }
      if (length > 6000) errors.push(`${server.key}: listing embed text exceeds 6000 characters`);
    }
  }
  if (errors.length) { const err = new Error(errors.join('\n')); err.statusCode = 400; err.validationErrors = errors; throw err; }
  return config;
}
function project(config, service, serverKey) {
  if (service === 'discord') return { ...structuredClone(config.discord), minecraftServers: config.servers.map(({ key, name, chat, allowlist, listing }) => ({ key, name, chat, allowlist, listing })) };
  if (service === 'website') return { ...structuredClone(config.website), discordClientId: config.website.discordClientId || config.discord.clientId, discordGuildId: config.website.discordGuildId || config.discord.guildId };
  if (service === 'instance') { const server = config.servers.find(item => item.key === serverKey); if (!server) { const err = new Error('Server is not configured'); err.statusCode = 404; throw err; } return { serverKey: server.key, name: server.name, instance: structuredClone(server.instance) }; }
  throw new Error('Unknown configuration service');
}
const serverProperties = schema.properties.servers.items.properties;
const serviceSchemas = {
  discord: object('Discord configuration', { ...schema.properties.discord.properties,
    minecraftServers: list('Servers', object('Server', Object.fromEntries(['key','name','chat','allowlist','listing'].map(key => [key, serverProperties[key]])))) }),
  website: schema.properties.website,
  instance: object('Instance configuration', { serverKey: serverProperties.key, name: serverProperties.name, instance: instanceSchema })
};
module.exports = { schema, serviceSchemas, instanceSchema, defaults, validate, assertConfig, project };
