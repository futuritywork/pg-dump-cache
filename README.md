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

# Tune parallel download concurrency (default: 8)
./client.ts -n 16
```

## Options

| Flag | Description |
|------|-------------|
| `-w, --wait` | Wait for fresh dump if cache is stale |
| `-f, --fresh` | Force refresh before fetching |
| `-s, --status` | Show server status and exit |
| `-n, --concurrency N` | Parallel download streams (default: 8, max: 64) |
| `-h, --help` | Show help |
| `--no-update-check` | Disable auto-update check |

## Download Protocol

The client fetches a dump in two phases:

1. **Prepare** — `GET /dump?prepare=true` runs any required refresh and streams
   NDJSON status lines, then a final `{ "ready": true, "ts": <ms>, "size": <bytes> }`
   line that pins to a specific cache file.
2. **Fanout** — N parallel `GET /dump/file?ts=<ts>` requests with `Range`
   headers, each writing into the destination file at its offset. This
   bypasses per-connection bandwidth caps and saturates the network link.

The legacy single-stream `GET /dump` endpoint (status NDJSON + `\0\n` + binary
payload) is preserved for backwards compatibility.

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

pg-dump-cache Copyright (C) 2026 Futurity Technologies Pte Ltd

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

---

A copy of the GNU General Public License, version 3, is included
in the [LICENSE](LICENSE) file.
