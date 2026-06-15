import { z } from "zod";
import type { Logger } from "./logger";

// Load a local .env for dev. `process.loadEnvFile` only exists on Node >= 20.12,
// and on serverless there's no .env — guard both so neither crashes module load.
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch (err) {
    // A missing .env is fine (e.g. in production); anything else is a real error.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  CRM_URL: z.url().default("http://localhost:3000"),
  WEBHOOK_SECRET: z.string().min(8),
  SIM_SPEED: z.coerce.number().positive().default(1),
  /** Share of CLICKED messages that place an attributed order (SPEC §7). */
  CONVERSION_RATE: z.coerce.number().min(0).max(1).default(0.08),
});

const parsed = EnvSchema.safeParse(process.env);

/**
 * Non-null when the environment is invalid (e.g. WEBHOOK_SECRET unset). We do
 * NOT throw or process.exit at module load: on a serverless function that
 * surfaces only as an opaque FUNCTION_INVOCATION_FAILED. Instead the module
 * always loads with safe fallbacks, the standalone server (index.ts) fails fast
 * on this value, and the serverless app boots degraded and reports it on
 * /health so the offending var is visible over HTTP and in the logs.
 */
export const configError: string | null = parsed.success
  ? null
  : `channel-sim: invalid environment configuration\n${parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`)
      .join("\n")}`;

if (configError) {
  console.error(configError);
}

// Safe fallbacks so the module always loads. An empty WEBHOOK_SECRET just makes
// HMAC verification fail (401) rather than crashing the whole function.
const data = parsed.success
  ? parsed.data
  : { PORT: 4001, CRM_URL: "http://localhost:3000", WEBHOOK_SECRET: "", SIM_SPEED: 1, CONVERSION_RATE: 0.08 };

export const config = Object.freeze({
  port: data.PORT,
  crmUrl: data.CRM_URL,
  webhookSecret: data.WEBHOOK_SECRET,
  simSpeed: data.SIM_SPEED,
  conversionRate: data.CONVERSION_RATE,
});

export function printConfig(logger: Logger): void {
  logger.info("config", {
    port: config.port,
    crmUrl: config.crmUrl,
    webhookSecret: `${config.webhookSecret.slice(0, 4)}…`,
    simSpeed: config.simSpeed,
    conversionRate: config.conversionRate,
  });
}
