#!/usr/bin/env bun

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const CACHE_SERVER_URL =
  process.env.CACHE_SERVER_URL ?? "http://localhost:3000";
const LOCAL_DB_URL = process.env.LOCAL_DB_URL;
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
  },
});

if (values.help) {
  console.log(`
pg-dump-cache client - Fetch and restore PostgreSQL dumps

Usage: ./client.ts [options]

Options:
  -w, --wait    Wait for fresh dump if cache is stale
  -f, --fresh   Force refresh before fetching
  -s, --status  Show server status and exit
  -h, --help    Show this help

Environment variables:
  CACHE_SERVER_URL  Server URL (default: http://localhost:3000)
  API_KEY           Shared API key for authentication (required)
  LOCAL_DB_URL      Local PostgreSQL connection string (required for restore)
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

  console.log(
    `Downloaded ${(data.byteLength / 1024 / 1024).toFixed(2)} MB to ${dumpPath}`,
  );
  return { dumpPath, tempDir };
}

async function restoreDump(dumpPath: string): Promise<void> {
  if (!LOCAL_DB_URL) {
    console.log("LOCAL_DB_URL not set, skipping restore");
    return;
  }

  console.log(`Restoring to ${LOCAL_DB_URL.replace(/:[^:@]+@/, ":***@")}...`);

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

  if (exitCode !== 0) {
    throw new Error(`pg_restore failed with exit code ${exitCode}`);
  }

  console.log("Restore completed");
}

async function cleanup(tempDir: string): Promise<void> {
  console.log(`Cleaning up temp directory: ${tempDir}`);
  await rm(tempDir, { recursive: true });
}

async function main(): Promise<void> {
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
