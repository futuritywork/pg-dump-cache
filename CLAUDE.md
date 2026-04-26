# pg-dump-cache

## Download protocol

The client uses a two-phase protocol to parallelize downloads across N TCP
connections (default N=8). Single-connection throughput is often capped well
below the network link speed; fanning out via HTTP Range requests saturates it.

### Phase 1: prepare

`GET /dump?prepare=true` runs the same refresh logic as `/dump` (honors `wait`
and `fresh`) and streams NDJSON status lines. The terminal line is:

```json
{"ready": true, "ts": 1745700000000, "size": 524288000}
```

`ts` is the cache file's millisecond timestamp (the primary key — files are
named `dump-<ts>.tar.gz`). It acts as an immutable handle so the parallel range
requests below all hit the same snapshot, even if a refresh runs concurrently.

### Phase 2: fanout

`GET /dump/file?ts=<ts>` is a static-file endpoint with HTTP Range support:

- With `Range: bytes=A-B` → 206 + `Content-Range: bytes A-B/<total>`.
- Without a `Range` header → 200 + full file + `Accept-Ranges: bytes`.
- Missing/expired `ts` → 410 Gone (client should re-prepare).

The client splits `[0, size)` into N contiguous chunks and writes each to the
destination via `FileHandle.write(buf, 0, len, offset)` (positional writes,
non-overlapping ranges, shared file handle).

### Legacy single-stream /dump (no `prepare`)

Still supported for backwards compatibility and ad-hoc curl users. Streams
NDJSON status lines, then a `\0\n` delimiter, then the binary payload (Postgres
custom format — not tar.gz despite the `.tar.gz` filename suffix).

```python
data = open("response.bin", "rb").read()
dump = data[data.index(b"\x00") + 1:]
```
