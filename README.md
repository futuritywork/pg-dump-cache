# pg-dump-cache

A caching proxy for PostgreSQL database dumps. Reduces load on production databases by caching `pg_dump` output and serving it to multiple clients.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/futuritywork/pg-dump-cache/main/client.ts -o client.ts && chmod +x client.ts
```

Requires [Bun](https://bun.sh) runtime.

## Usage

```bash
# Set required environment variables
export API_KEY="your-shared-api-key"
export CACHE_SERVER_URL="http://your-cache-server:3000"
export LOCAL_DB_URL="postgresql://user:pass@localhost/mydb"

# Fetch and restore the latest cached dump
./client.ts

# Wait for a fresh dump if cache is stale
./client.ts --wait

# Force a refresh before fetching
./client.ts --fresh

# Check server status
./client.ts --status
```

## Options

| Flag | Description |
|------|-------------|
| `-w, --wait` | Wait for fresh dump if cache is stale |
| `-f, --fresh` | Force refresh before fetching |
| `-s, --status` | Show server status and exit |
| `-h, --help` | Show help |
| `--no-update-check` | Disable auto-update check |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `API_KEY` | Shared API key for authentication (required) |
| `CACHE_SERVER_URL` | Server URL (default: `http://localhost:3000`) |
| `LOCAL_DB_URL` | Local PostgreSQL connection string (required for restore) |
| `DUMP_CACHE_NO_UPDATE_CHECK` | Set to `1` to disable auto-update checks |

## Auto-Updates

The client automatically checks for updates from GitHub once per day. When a new version is available, it updates itself and re-runs with the same arguments.

To disable auto-updates:
- Use the `--no-update-check` flag
- Set `DUMP_CACHE_NO_UPDATE_CHECK=1`

## License

Copyright (C) 2025 Futurity Technologies Pte Ltd

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3.

See [LICENSE](LICENSE) for the full license text.
