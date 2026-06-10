import { z } from "zod";
import type { Logger } from "./logger";

try {
  process.loadEnvFile();
} catch (err) {
  // A missing .env is fine (e.g. in production); anything else is a real error.
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    throw err;
  }
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  CRM_URL: z.url().default("http://localhost:3000"),
  WEBHOOK_SECRET: z.string().min(8),
  SIM_SPEED: z.coerce.number().positive().default(1),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`)
    .join("\n");
  console.error(`channel-sim: invalid environment configuration\n${problems}`);
  process.exit(1);
}

export const config = Object.freeze({
  port: parsed.data.PORT,
  crmUrl: parsed.data.CRM_URL,
  webhookSecret: parsed.data.WEBHOOK_SECRET,
  simSpeed: parsed.data.SIM_SPEED,
});

export function printConfig(logger: Logger): void {
  logger.info("config", {
    port: config.port,
    crmUrl: config.crmUrl,
    webhookSecret: `${config.webhookSecret.slice(0, 4)}…`,
    simSpeed: config.simSpeed,
  });
}
