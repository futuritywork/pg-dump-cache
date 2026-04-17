# pg-dump-cache

## /dump endpoint response format

The `/dump` endpoint streams NDJSON status lines **before** the binary payload,
separated by a null byte (`\0`). The first `\0` in the response denotes the
beginning of the pg_dump data (PostgreSQL custom format, not tar.gz despite the
`.tar.gz` references in code).

To extract the dump from a raw response:

```python
data = open("response.bin", "rb").read()
dump = data[data.index(b"\x00") + 1:]
```
