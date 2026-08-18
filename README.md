# PilotMC Instance

PilotMC Instance is a generic Node.js controller for one Minecraft Bedrock Dedicated Server. Deploy one copy per server and give each deployment its own configuration and runtime directories.

This repository contains no worlds, Bedrock binaries, credentials, community-specific rules, or optional module implementations.

## Requirements

- Node.js 20 or newer
- PostgreSQL
- Minecraft Bedrock Dedicated Server
- A running PilotMC Core deployment

## Configuration

1. Copy `.env.example` to `.env`; set a unique `SERVER_KEY`, `AGENT_PORT`, and strong random API/admin tokens.
2. Copy `mc/mcConfig.example.json` to `mc/mcConfig.json`.
3. Install Bedrock Dedicated Server under `mc/bds`, or set `BDS_BINARY` to its executable.
4. Install private or community-specific extensions under `modules`.
5. Run `npm ci`, `npm run check`, and `npm start`.

Module contents and runtime configuration are ignored by Git. Modules are discovered with dynamic `import()` and receive the generic server context during startup.

`mclink` is generated with the configured local agent URL when the server starts, allowing multiple instances on one host. Set `BDS_WORLD_NAME` when the world's `level-name` is not `Bedrock level`.
