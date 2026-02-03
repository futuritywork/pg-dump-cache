import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
const CACHE_DIR = process.env.CACHE_DIR ?? "./cache";
const TTL = Number(process.env.TTL ?? 3600);
const PORT = Number(process.env.PORT ?? 3000);
const KEEP_COUNT = Number(process.env.KEEP_COUNT ?? 3);

if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

type CacheEntry = {
  path: string;
  timestamp: Date;
};

let latestCache: CacheEntry | null = null;
let refreshing = false;
let refreshPromise: Promise<void> | null = null;

function getCacheAgeSeconds(): number {
  if (!latestCache) return Number.POSITIVE_INFINITY;
  return (Date.now() - latestCache.timestamp.getTime()) / 1000;
}

function needsRefresh(ttl: number = TTL): boolean {
  return !latestCache || getCacheAgeSeconds() > ttl;
}

async function loadExistingDumps(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });

  const files = await readdir(CACHE_DIR);
  const dumpFiles = files
    .filter((f) => f.endsWith(".tar.gz"))
    .map((f) => {
      const match = f.match(/^dump-(\d+)\.tar\.gz$/);
      return match
        ? { path: join(CACHE_DIR, f), timestamp: new Date(Number(match[1])) }
        : null;
    })
    .filter((x): x is CacheEntry => x !== null)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (dumpFiles.length > 0) {
    latestCache = dumpFiles[0];
    console.log(
      `Loaded existing cache from ${latestCache.path} (age: ${Math.round(getCacheAgeSeconds())}s)`,
    );
  }
}

async function performDump(): Promise<CacheEntry> {
  const timestamp = new Date();
  const filename = `dump-${timestamp.getTime()}.tar.gz`;
  const filepath = join(CACHE_DIR, filename);

  console.log(`Starting pg_dump to ${filepath}...`);

  const proc = Bun.spawn(
    [
      "pg_dump",
      "--no-owner",
      "--no-acl",
      "--format=custom",
      "--compress=6",
      DATABASE_URL!,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const output = await new Response(proc.stdout).arrayBuffer();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`pg_dump failed with exit code ${exitCode}: ${stderr}`);
  }

  await Bun.write(filepath, output);
  console.log(
    `pg_dump completed: ${filepath} (${(output.byteLength / 1024 / 1024).toFixed(2)} MB)`,
  );

  return { path: filepath, timestamp };
}

async function cleanupOldDumps(): Promise<void> {
  const files = await readdir(CACHE_DIR);
  const dumpFiles = files
    .filter((f) => f.endsWith(".tar.gz"))
    .map((f) => {
      const match = f.match(/^dump-(\d+)\.tar\.gz$/);
      return match ? { file: f, timestamp: Number(match[1]) } : null;
    })
    .filter((x): x is { file: string; timestamp: number } => x !== null)
    .sort((a, b) => b.timestamp - a.timestamp);

  const toDelete = dumpFiles.slice(KEEP_COUNT);
  for (const { file } of toDelete) {
    const path = join(CACHE_DIR, file);
    console.log(`Cleaning up old dump: ${path}`);
    await rm(path);
  }
}

async function doRefresh(): Promise<void> {
  try {
    latestCache = await performDump();
    await cleanupOldDumps();
  } catch (error) {
    console.error("Refresh failed:", error);
    throw error;
  }
}

async function ensureFreshCache(ttl: number = TTL): Promise<void> {
  while (refreshing) {
    await refreshPromise;
  }

  if (!needsRefresh(ttl)) {
    return;
  }

  refreshing = true;
  refreshPromise = doRefresh().finally(() => {
    refreshing = false;
    refreshPromise = null;
  });

  await refreshPromise;
}

function triggerRefresh(ttl: number = TTL): void {
  if (refreshing || !needsRefresh(ttl)) {
    return;
  }

  refreshing = true;
  refreshPromise = doRefresh().finally(() => {
    refreshing = false;
    refreshPromise = null;
  });
}

await loadExistingDumps();

if (!latestCache) {
  console.log("No existing cache found, fetching initial dump...");
  await ensureFreshCache(0);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const ttl = Number(url.searchParams.get("ttl") ?? TTL);

    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({
        hasCache: latestCache !== null,
        cacheTimestamp: latestCache?.timestamp.toISOString() ?? null,
        cacheAgeSeconds: latestCache ? Math.round(getCacheAgeSeconds()) : null,
        refreshing,
        ttl: TTL,
      });
    }

    if (req.method === "GET" && url.pathname === "/dump") {
      const wait = url.searchParams.get("wait") === "true";

      if (wait) {
        try {
          await ensureFreshCache(ttl);
        } catch {
          return new Response("Refresh failed", { status: 500 });
        }
      } else {
        triggerRefresh(ttl);
      }

      if (!latestCache) {
        return Response.json(
          { error: "No cached dump available", retryable: true },
          { status: 503 },
        );
      }

      const file = Bun.file(latestCache.path);
      const exists = await file.exists();

      if (!exists) {
        latestCache = null;
        return Response.json(
          { error: "Cache file missing", retryable: true },
          { status: 503 },
        );
      }

      return new Response(file, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${latestCache.path.split("/").pop()}"`,
          "X-Cache-Age-Minutes": String(Math.round(getCacheAgeSeconds() / 60)),
          "X-Cache-Timestamp": latestCache.timestamp.toISOString(),
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/refresh") {
      if (refreshing) {
        return Response.json(
          { error: "Refresh already in progress", refreshing: true },
          { status: 409 },
        );
      }

      try {
        await ensureFreshCache(0);
        return Response.json({
          success: true,
          cacheTimestamp: latestCache?.timestamp.toISOString(),
        });
      } catch (error) {
        return Response.json(
          { error: "Refresh failed", message: String(error) },
          { status: 500 },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`pg-dump-cache server listening on port ${PORT}`);
console.log(`  DATABASE_URL: ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);
console.log(`  CACHE_DIR: ${CACHE_DIR}`);
console.log(`  TTL: ${TTL}s`);
console.log(`  KEEP_COUNT: ${KEEP_COUNT}`);
