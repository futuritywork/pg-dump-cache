#!/usr/bin/env bun

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/futuritywork/pg-dump-cache/main/client.ts";
const CONFIG_DIR = join(homedir(), ".config", "pg-dump-cache");
const UPDATE_CHECK_FILE = join(CONFIG_DIR, "update-checked");
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in ms
const NO_UPDATE_CHECK = process.env.DUMP_CACHE_NO_UPDATE_CHECK === "1";

const CACHE_SERVER_URL =
  process.env.CACHE_SERVER_URL ?? "http://localhost:3000";
const LOCAL_DB_URL = process.env.DATABASE_URL;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("API_KEY environment variable is required");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${API_KEY}` };

const { values } = parseArgs({
  options: {
    wait: { type: "boolean", short: "w", default: false },
    fresh: { type: "boolean", short: "f", default: false },
    status: { type: "boolean", short: "s", default: false },
    help: { type: "boolean", short: "h", default: false },
    "no-update-check": { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`
pg-dump-cache client - Fetch and restore PostgreSQL dumps

Usage: ./client.ts [options]

Options:
  -w, --wait           Wait for fresh dump if cache is stale
  -f, --fresh          Force refresh before fetching
  -s, --status         Show server status and exit
  -h, --help           Show this help
  --no-update-check    Disable auto-update check for this invocation

Environment variables:
  CACHE_SERVER_URL           Server URL (default: http://localhost:3000)
  API_KEY                    Shared API key for authentication (required)
  LOCAL_DB_URL               Local PostgreSQL connection string (required for restore)
  DUMP_CACHE_NO_UPDATE_CHECK Set to 1 to disable auto-update checks
`);
  process.exit(0);
}

async function getStatus(): Promise<{
  hasCache: boolean;
  cacheTimestamp: string | null;
  cacheAgeSeconds: number | null;
  refreshing: boolean;
  ttl: number;
}> {
  const res = await fetch(`${CACHE_SERVER_URL}/status`, { headers });
  if (!res.ok) {
    throw new Error(`Status check failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function triggerRefresh(): Promise<void> {
  console.log("Triggering refresh...");
  const res = await fetch(`${CACHE_SERVER_URL}/refresh`, {
    method: "POST",
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Refresh failed: ${res.status} ${body.error ?? res.statusText}`,
    );
  }
  console.log("Refresh completed");
}

async function downloadDump(
  wait: boolean,
): Promise<{ dumpPath: string; tempDir: string }> {
  const tempDir = join(tmpdir(), `pg-dump-cache-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  const url = new URL(`${CACHE_SERVER_URL}/dump`);
  if (wait) url.searchParams.set("wait", "true");

  console.log(`Fetching dump from ${url}...`);
  const downloadStart = Date.now();
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Download failed: ${res.status} ${body.error ?? res.statusText}`,
    );
  }

  const ageMinutes = res.headers.get("X-Cache-Age-Minutes");
  const timestamp = res.headers.get("X-Cache-Timestamp");
  console.log(`Cache age: ${ageMinutes} minutes (from ${timestamp})`);

  const dumpPath = join(tempDir, "dump.dump");

  const data = await res.arrayBuffer();
  await Bun.write(dumpPath, data);

  const downloadSeconds = ((Date.now() - downloadStart) / 1000).toFixed(1);
  console.log(
    `Downloaded ${(data.byteLength / 1024 / 1024).toFixed(2)} MB in ${downloadSeconds}s`,
  );
  return { dumpPath, tempDir };
}

async function restoreDump(dumpPath: string): Promise<void> {
  if (!LOCAL_DB_URL) {
    console.log("LOCAL_DB_URL not set, skipping restore");
    return;
  }

  console.log(`Restoring to ${LOCAL_DB_URL.replace(/:[^:@]+@/, ":***@")}...`);

  const restoreStart = Date.now();
  const proc = Bun.spawn(
    [
      "pg_restore",
      "--no-owner",
      "--no-acl",
      "--clean",
      "--if-exists",
      `--dbname=${LOCAL_DB_URL}`,
      dumpPath,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const exitCode = await proc.exited;
  const restoreSeconds = ((Date.now() - restoreStart) / 1000).toFixed(1);

  if (exitCode !== 0) {
    throw new Error(`pg_restore failed with exit code ${exitCode}`);
  }

  console.log(`Restore completed in ${restoreSeconds}s`);
}

async function cleanup(tempDir: string): Promise<void> {
  console.log(`Cleaning up temp directory: ${tempDir}`);
  await rm(tempDir, { recursive: true });
}

async function isInSourceRepo(): Promise<boolean> {
  try {
    const scriptDir = import.meta.dir;
    const gitDir = join(scriptDir, ".git");
    await stat(gitDir);
    // .git exists, check if it's the source repo
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd: scriptDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    return output.includes("futuritywork/pg-dump-cache");
  } catch {
    return false;
  }
}

async function checkForUpdates(): Promise<void> {
  if (NO_UPDATE_CHECK || values["no-update-check"]) {
    return;
  }

  try {
    // Skip update if running from the source repository
    if (await isInSourceRepo()) {
      return;
    }

    // Check if we've checked recently
    try {
      const stats = await stat(UPDATE_CHECK_FILE);
      const lastCheck = stats.mtimeMs;
      if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL) {
        return;
      }
    } catch {
      // File doesn't exist, proceed with check
    }

    // Ensure config directory exists
    await mkdir(CONFIG_DIR, { recursive: true });

    // Fetch remote version
    const res = await fetch(GITHUB_RAW_URL);
    if (!res.ok) {
      return; // Silently fail on network errors
    }
    const remoteContent = await res.text();

    // Read local version
    const localPath = import.meta.path;
    const localContent = await readFile(localPath, "utf-8");

    // Update timestamp file
    await writeFile(UPDATE_CHECK_FILE, new Date().toISOString());

    // Compare and update if different
    if (remoteContent !== localContent) {
      console.log("Updating client.ts to latest version...");
      await writeFile(localPath, remoteContent);
      console.log("Update complete. Re-running with new version...");

      // Re-execute with --no-update-check to prevent infinite loop
      const args = [...process.argv.slice(1), "--no-update-check"];
      const proc = Bun.spawn(["bun", ...args], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      const exitCode = await proc.exited;
      process.exit(exitCode);
    }
  } catch (error) {
    // Silently continue on any errors
    if (process.env.DEBUG) {
      console.warn("Update check failed:", error);
    }
  }
}

async function main(): Promise<void> {
  await checkForUpdates();

  if (values.status) {
    const status = await getStatus();
    console.log("Server status:");
    console.log(`  Has cache: ${status.hasCache}`);
    console.log(`  Cache timestamp: ${status.cacheTimestamp ?? "N/A"}`);
    console.log(
      `  Cache age: ${status.cacheAgeSeconds !== null ? `${Math.round(status.cacheAgeSeconds / 60)} minutes` : "N/A"}`,
    );
    console.log(`  Refreshing: ${status.refreshing}`);
    console.log(`  TTL: ${status.ttl}s`);
    return;
  }

  if (values.fresh) {
    await triggerRefresh();
  }

  const { dumpPath, tempDir } = await downloadDump(values.wait ?? false);
  try {
    await restoreDump(dumpPath);
  } finally {
    await cleanup(tempDir);
  }

  console.log("Done!");
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
