import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { env } from "./env.js";

const {
  DATABASE_URL,
  API_KEY,
  CACHE_DIR,
  TTL,
  PORT,
  KEEP_COUNT,
  EXCLUDE_TABLES,
} = env;

const log = pino({ name: "pg-dump-cache" });

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
    log.info(
      { path: latestCache.path, ageSeconds: Math.round(getCacheAgeSeconds()) },
      "loaded existing cache",
    );
  }
}

async function performDump(): Promise<CacheEntry> {
  const timestamp = new Date();
  const filename = `dump-${timestamp.getTime()}.tar.gz`;
  const filepath = join(CACHE_DIR, filename);

  log.info({ filepath }, "starting pg_dump");

  const proc = Bun.spawn(
    [
      "pg_dump",
      "--no-owner",
      "--no-acl",
      "--format=custom",
      "--compress=6",
      ...EXCLUDE_TABLES.flatMap((t) => ["--exclude-table", t]),
      DATABASE_URL,
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
  log.info(
    { filepath, sizeMB: Number((output.byteLength / 1024 / 1024).toFixed(2)) },
    "pg_dump completed",
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
    log.info({ path }, "cleaning up old dump");
    await rm(path);
  }
}

async function doRefresh(): Promise<void> {
  try {
    latestCache = await performDump();
    await cleanupOldDumps();
  } catch (error) {
    log.error({ err: error }, "refresh failed");
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

const startupStart = performance.now();
log.info("initializing");

await loadExistingDumps();

if (latestCache) {
  const ageSeconds = Math.round(getCacheAgeSeconds());
  const isStale = needsRefresh();
  log.info({ ageSeconds, isStale }, "found existing cache");
  if (isStale) {
    log.info("cache is stale, queuing background refresh");
    triggerRefresh();
  }
} else {
  log.info("no existing cache found, fetching initial dump");
  await ensureFreshCache(0);
  log.info(
    {
      durationSeconds: Number(
        ((performance.now() - startupStart) / 1000).toFixed(1),
      ),
    },
    "initial dump complete",
  );
}

const startupMs = Math.round(performance.now() - startupStart);
log.info({ startupMs }, "ready");

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "");

    if (token !== API_KEY) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

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
      const requestStart = performance.now();
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        req.headers.get("x-real-ip") ??
        "unknown";
      const wait = url.searchParams.get("wait") === "true";
      const fresh = url.searchParams.get("fresh") === "true";
      const prepare = url.searchParams.get("prepare") === "true";

      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (obj: object) =>
            controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
          const status = (msg: string) => emit({ status: msg });

          // --- refresh phase ---
          if (fresh) {
            status("Forcing fresh dump...");
            const t0 = performance.now();
            try {
              await ensureFreshCache(0);
            } catch (err) {
              status("Refresh failed");
              log.error({ ip, err }, "refresh failed (fresh)");
              controller.close();
              return;
            }
            status(
              `Fresh dump completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
            );
          } else if (getCacheAgeSeconds() > 3600) {
            const ageMin = Math.round(getCacheAgeSeconds() / 60);
            status(`Cache is ${ageMin}m old — refreshing...`);
            const t0 = performance.now();
            try {
              await ensureFreshCache(0);
            } catch (err) {
              status("Refresh failed");
              log.error({ ip, err }, "refresh failed (stale >60m)");
              controller.close();
              return;
            }
            status(
              `Fresh dump completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
            );
          } else if (wait) {
            if (needsRefresh(ttl)) {
              status("Cache is stale — refreshing...");
              const t0 = performance.now();
              try {
                await ensureFreshCache(ttl);
              } catch (err) {
                status("Refresh failed");
                log.error({ ip, err }, "refresh failed (wait)");
                controller.close();
                return;
              }
              status(
                `Refresh completed in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
              );
            } else {
              status("Cache is fresh");
            }
          } else {
            triggerRefresh(ttl);
            if (refreshing) {
              status("Refreshing in background");
            }
          }

          // --- validate cache ---
          if (!latestCache) {
            status("No cache available");
            log.warn({ ip }, "no cache available");
            controller.close();
            return;
          }

          const file = Bun.file(latestCache.path);
          if (!(await file.exists())) {
            latestCache = null;
            status("Cache file missing");
            log.error({ ip }, "cache file missing");
            controller.close();
            return;
          }

          // --- send file info ---
          const cacheAge = Math.round(getCacheAgeSeconds());
          const sizeMB = Number((file.size / 1024 / 1024).toFixed(2));
          const ts = latestCache.timestamp.getTime();
          status(
            `Sending ${sizeMB} MB (age: ${cacheAge}s, ${latestCache.timestamp.toISOString()})`,
          );

          // --- prepare mode: emit handle + close, no binary ---
          if (prepare) {
            emit({ ready: true, ts, size: file.size });
            const durationMs = Math.round(performance.now() - requestStart);
            log.info(
              {
                ip,
                sizeMB,
                cacheAgeSeconds: cacheAge,
                fresh,
                wait,
                ts,
                durationMs,
              },
              "dump prepared",
            );
            controller.close();
            return;
          }

          // --- legacy mode: stream binary after \0\n delimiter ---
          controller.enqueue(new Uint8Array([0x00, 0x0a]));

          const reader = file.stream().getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }

          const durationMs = Math.round(performance.now() - requestStart);
          log.info(
            { ip, sizeMB, cacheAgeSeconds: cacheAge, fresh, wait, durationMs },
            "dump served",
          );

          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Status-Stream": "true",
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/dump/file") {
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        req.headers.get("x-real-ip") ??
        "unknown";

      const ts = url.searchParams.get("ts");
      if (!ts || !/^\d+$/.test(ts)) {
        return Response.json(
          { error: "Missing or invalid ts" },
          { status: 400 },
        );
      }

      const filepath = join(CACHE_DIR, `dump-${ts}.tar.gz`);
      const file = Bun.file(filepath);
      if (!(await file.exists())) {
        log.warn({ ip, ts }, "cache file not found for range request");
        return Response.json(
          { error: "Cache file not found" },
          { status: 410 },
        );
      }

      const total = file.size;
      const range = req.headers.get("range");

      if (!range) {
        return new Response(file, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(total),
            "Accept-Ranges": "bytes",
          },
        });
      }

      const m = range.match(/^bytes=(\d+)-(\d+)?$/);
      if (!m) {
        return Response.json(
          { error: "Invalid range" },
          {
            status: 416,
            headers: { "Content-Range": `bytes */${total}` },
          },
        );
      }

      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : total - 1;

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end >= total ||
        start > end
      ) {
        return Response.json(
          { error: "Range not satisfiable" },
          {
            status: 416,
            headers: { "Content-Range": `bytes */${total}` },
          },
        );
      }

      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
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

log.info(
  {
    port: PORT,
    databaseUrl: DATABASE_URL.replace(/:[^:@]+@/, ":***@"),
    cacheDir: CACHE_DIR,
    ttl: TTL,
    keepCount: KEEP_COUNT,
    excludeTables: EXCLUDE_TABLES,
  },
  "server listening",
);
