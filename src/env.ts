import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    API_KEY: z.string().min(1),
    CACHE_DIR: z.string().default("./cache"),
    TTL: z.coerce.number().int().positive().default(3600),
    PORT: z.coerce.number().int().positive().default(3000),
    KEEP_COUNT: z.coerce.number().int().positive().default(3),
  },
  runtimeEnv: process.env,
});
