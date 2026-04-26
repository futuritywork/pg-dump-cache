#!/usr/bin/env bun

const startTime = performance.now();

import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import z from "zod";

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/futuritywork/pg-dump-cache/main/client.ts";
const CONFIG_DIR = join(homedir(), ".config", "pg-dump-cache");
const UPDATE_CHECK_FILE = join(CONFIG_DIR, "update-checked");
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in ms
const NO_UPDATE_CHECK = process.env.DUMP_CACHE_NO_UPDATE_CHECK === "1";

const CACHE_SERVER_URL = new URL(
  process.env.CACHE_SERVER_URL ?? "http://localhost:3000",
);
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
    concurrency: { type: "string", short: "n", default: "8" },
    "no-update-check": { type: "boolean", default: false },
    "force-update": { type: "boolean", short: "u", default: false },
  },
});

const CONCURRENCY = (() => {
  const n = Number(values.concurrency);
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    console.error(
      `Invalid --concurrency: ${values.concurrency} (must be integer 1-64)`,
    );
    process.exit(1);
  }
  return n;
})();

if (values.help) {
  console.log(`
pg-dump-cache client - Fetch and restore PostgreSQL dumps

Usage: ./client.ts [options]

Options:
  -w, --wait           Wait for fresh dump if cache is stale
  -f, --fresh          Force refresh before fetching
  -s, --status         Show server status and exit
  -n, --concurrency N  Parallel download streams (default: 8, max: 64)
  -h, --help           Show this help
  -u, --force-update   Force update check (ignore 24h TTL)
  --no-update-check    Disable auto-update check for this invocation

Environment variables:
  CACHE_SERVER_URL           Server URL (default: http://localhost:3000)
  API_KEY                    Shared API key for authentication (required)
  LOCAL_DB_URL               Local PostgreSQL connection string (required for restore)
  DUMP_CACHE_NO_UPDATE_CHECK Set to 1 to disable auto-update checks
`);
  process.exit(0);
}

const Z_Status = z.object({
  hasCache: z.boolean(),
  cacheTimestamp: z.string().nullable(),
  cacheAgeSeconds: z.number().nullable(),
  refreshing: z.boolean(),
  ttl: z.number(),
});

async function getStatus(): Promise<{
  hasCache: boolean;
  cacheTimestamp: string | null;
  cacheAgeSeconds: number | null;
  refreshing: boolean;
  ttl: number;
}> {
  const res = await fetch(`${CACHE_SERVER_URL}status`, { headers });
  if (!res.ok) {
    throw new Error(`Status check failed: ${res.status} ${res.statusText}`);
  }
  return Z_Status.parse(await res.json());
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1000 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(2)} MB`;
}

function formatSpeed(bytes: number, seconds: number): string {
  const mbps = bytes / 1024 / 1024 / seconds;
  return mbps >= 1000
    ? `${(mbps / 1024).toFixed(1)} GB/s`
    : `${mbps.toFixed(1)} MB/s`;
}

async function prepareDump(options: {
  wait: boolean;
  fresh: boolean;
}): Promise<{ ts: number; size: number }> {
  const url = new URL(`${CACHE_SERVER_URL}dump`);
  url.searchParams.set("prepare", "true");
  if (options.fresh) url.searchParams.set("fresh", "true");
  else if (options.wait) url.searchParams.set("wait", "true");

  console.log(`Preparing dump from ${url}...`);
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(
      `Prepare failed: ${res.status} ${body.error ?? res.statusText}`,
    );
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ready: { ts: number; size: number } | null = null;

  const handleLine = (line: string): void => {
    if (!line) return;
    try {
      const msg = JSON.parse(line) as {
        status?: string;
        ready?: boolean;
        ts?: number;
        size?: number;
      };
      if (
        msg.ready &&
        typeof msg.ts === "number" &&
        typeof msg.size === "number"
      ) {
        ready = { ts: msg.ts, size: msg.size };
      } else if (msg.status) {
        console.log(`  ${msg.status}`);
      }
    } catch {}
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  }
  if (buffer) handleLine(buffer);

  if (!ready) {
    throw new Error("Server closed connection without ready signal");
  }
  return ready;
}

type Chunk = {
  index: number;
  start: number;
  end: number;
  size: number;
  downloaded: number;
  startTime: number;
  done: boolean;
};

const isTTY = Boolean(process.stdout.isTTY);

const BAR_WIDTH = 28;

function buildBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function formatSpeedRaw(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "    -- B/s";
  const mbps = bytesPerSec / 1024 / 1024;
  if (mbps >= 1000) return `${(mbps / 1024).toFixed(1)} GB/s`;
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

function buildProgressLines(
  chunks: Chunk[],
  overallStart: number,
  totalSize: number,
): string[] {
  const now = performance.now();
  const lines: string[] = [];
  const labelWidth = `chunk ${chunks.length}`.length;

  for (const c of chunks) {
    const pct = c.size > 0 ? (c.downloaded / c.size) * 100 : 100;
    const elapsed = (now - c.startTime) / 1000;
    const speed = c.done
      ? c.size / Math.max(elapsed, 0.001)
      : elapsed > 0
        ? c.downloaded / elapsed
        : 0;
    const label = `chunk ${c.index + 1}`.padEnd(labelWidth);
    lines.push(
      `${label} ${buildBar(pct)} ${pct.toFixed(0).padStart(3)}% ` +
        `${formatBytes(c.downloaded).padStart(10)} / ${formatBytes(c.size).padEnd(10)} ` +
        `${formatSpeedRaw(speed).padStart(10)}`,
    );
  }

  const totalDone = chunks.reduce((s, c) => s + c.downloaded, 0);
  const pct = totalSize > 0 ? (totalDone / totalSize) * 100 : 100;
  const elapsed = (now - overallStart) / 1000;
  const speed = elapsed > 0 ? totalDone / elapsed : 0;
  const label = "total".padEnd(labelWidth);
  lines.push(
    `${label} ${buildBar(pct)} ${pct.toFixed(0).padStart(3)}% ` +
      `${formatBytes(totalDone).padStart(10)} / ${formatBytes(totalSize).padEnd(10)} ` +
      `${formatSpeedRaw(speed).padStart(10)}`,
  );
  return lines;
}

class ProgressRenderer {
  private rendered = false;
  private readonly height: number;

  constructor(height: number) {
    this.height = height;
  }

  render(lines: string[]): void {
    if (!isTTY) return;
    const out: string[] = [];
    if (this.rendered) out.push(`\x1b[${this.height}A`);
    for (const line of lines) out.push(`\x1b[2K${line}\n`);
    process.stdout.write(out.join(""));
    this.rendered = true;
  }
}

async function downloadParallel(
  ts: number,
  totalSize: number,
  destPath: string,
): Promise<{ bytes: number; seconds: number }> {
  const chunkSize = Math.ceil(totalSize / CONCURRENCY);
  const chunks: Chunk[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const start = i * chunkSize;
    if (start >= totalSize) break;
    const end = Math.min(start + chunkSize - 1, totalSize - 1);
    chunks.push({
      index: i,
      start,
      end,
      size: end - start + 1,
      downloaded: 0,
      startTime: 0,
      done: false,
    });
  }

  const fileHandle = await open(destPath, "w");
  await fileHandle.truncate(totalSize);

  const url = new URL(`${CACHE_SERVER_URL}dump/file`);
  url.searchParams.set("ts", String(ts));

  const overallStart = performance.now();
  const renderer = new ProgressRenderer(chunks.length + 1);

  let lastRenderAt = 0;
  const tryRender = (force = false): void => {
    const now = performance.now();
    if (!force && now - lastRenderAt < 100) return;
    lastRenderAt = now;
    renderer.render(buildProgressLines(chunks, overallStart, totalSize));
  };

  // initial paint so all bars exist before first update
  tryRender(true);

  const controller = new AbortController();

  const fetchChunk = async (chunk: Chunk): Promise<void> => {
    chunk.startTime = performance.now();
    const res = await fetch(url, {
      headers: { ...headers, Range: `bytes=${chunk.start}-${chunk.end}` },
      signal: controller.signal,
    });
    if (res.status !== 206) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Range request for chunk ${chunk.index} failed: ${res.status} ${body || res.statusText}`,
      );
    }
    const reader = res.body!.getReader();
    let offset = chunk.start;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await fileHandle.write(value, 0, value.length, offset);
      offset += value.length;
      chunk.downloaded += value.length;
      tryRender();
    }
    if (chunk.downloaded !== chunk.size) {
      throw new Error(
        `Chunk ${chunk.index} short read: got ${chunk.downloaded} of ${chunk.size}`,
      );
    }
    chunk.done = true;
    tryRender();
  };

  try {
    await Promise.all(
      chunks.map((c) =>
        fetchChunk(c).catch((err) => {
          controller.abort();
          throw err;
        }),
      ),
    );
    tryRender(true);
  } finally {
    await fileHandle.close();
  }

  // non-TTY: print one summary line so users still see something
  if (!isTTY) {
    const lines = buildProgressLines(chunks, overallStart, totalSize);
    console.log(lines[lines.length - 1]);
  }

  const seconds = (performance.now() - overallStart) / 1000;
  return { bytes: totalSize, seconds };
}

async function downloadDump(options: {
  wait: boolean;
  fresh: boolean;
}): Promise<{ dumpPath: string; tempDir: string }> {
  const tempDir = join(tmpdir(), `pg-dump-cache-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const dumpPath = join(tempDir, "dump.dump");

  const { ts, size } = await prepareDump(options);
  console.log(
    `Downloading ${formatBytes(size)} via ${CONCURRENCY} stream${CONCURRENCY === 1 ? "" : "s"}...`,
  );

  const { bytes, seconds } = await downloadParallel(ts, size, dumpPath);
  console.log(
    `Downloaded ${formatBytes(bytes)} in ${seconds.toFixed(1)}s (${formatSpeed(bytes, seconds)})`,
  );

  return { dumpPath, tempDir };
}

async function restoreDump(dumpPath: string): Promise<void> {
  if (!LOCAL_DB_URL) {
    console.log("LOCAL_DB_URL not set, skipping restore");
    return;
  }

  console.log(`Restoring to ${LOCAL_DB_URL.replace(/:[^:@]+@/, ":***@")}...`);

  const restoreStart = performance.now();
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
  const restoreSeconds = ((performance.now() - restoreStart) / 1000).toFixed(1);

  if (exitCode !== 0) {
    throw new Error(`pg_restore failed with exit code ${exitCode}`);
  }

  console.log(`Restore completed in ${restoreSeconds}s`);
}

async function cleanup(tempDir: string): Promise<void> {
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

async function checkForUpdates(force = false): Promise<void> {
  if (NO_UPDATE_CHECK || values["no-update-check"]) {
    return;
  }

  try {
    // Skip update if running from the source repository
    if (await isInSourceRepo()) {
      return;
    }

    // Check if we've checked recently (skip if forced)
    if (!force) {
      try {
        const stats = await stat(UPDATE_CHECK_FILE);
        const lastCheck = stats.mtimeMs;
        if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL) {
          return;
        }
      } catch {
        // File doesn't exist, proceed with check
      }
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
      console.log(`Updating client in place: ${localPath}`);
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
  await checkForUpdates(values["force-update"]);

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

  const { dumpPath, tempDir } = await downloadDump({
    wait: values.wait ?? false,
    fresh: values.fresh ?? false,
  });
  try {
    await restoreDump(dumpPath);
  } finally {
    await cleanup(tempDir);
  }

  const elapsedSec = (performance.now() - startTime) / 1000;
  console.log(`Done in ${elapsedSec.toFixed(1)}s`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
