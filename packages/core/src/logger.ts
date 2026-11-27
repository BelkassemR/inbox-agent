import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info", name?: string): Logger {
  return pino({
    level,
    name,
    // Never log credentials, even by accident.
    redact: {
      paths: [
        "req.headers.authorization",
        'req.headers["x-signature"]',
        "*.apiKey",
        "*.ANTHROPIC_API_KEY",
        "*.WEBHOOK_SECRET",
      ],
      censor: "[redacted]",
    },
  });
}
