import { z } from "zod";

const csv = z
  .string()
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean));

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default("redis://localhost:6379"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_KEYS: csv.pipe(z.array(z.string().min(16, "API keys must be at least 16 characters")).min(1)),
  WEBHOOK_SECRET: z.string().min(16, "WEBHOOK_SECRET must be at least 16 characters"),
  LLM_PROVIDER: z.enum(["anthropic", "scripted"]).default("scripted"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default("claude-opus-5-5"),
  AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate configuration from the environment once, at startup.
 * Failing fast here beats discovering a missing secret on the first request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
