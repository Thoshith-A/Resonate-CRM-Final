import { HealthResponseSchema, type HealthResponse } from "@resonate/shared";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, printConfig } from "./config";
import { logger } from "./logger";

const app = express();

app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  const body: HealthResponse = HealthResponseSchema.parse({
    status: "ok",
    service: "channel-sim",
    version: "0.1.0",
    time: new Date().toISOString(),
  });
  res.status(200).json(body);
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { code: "not_found", message: "Resource not found" } });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("unhandled error", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({ error: { code: "internal_error", message: "Internal server error" } });
});

const server = app.listen(config.port, () => {
  logger.info("channel-sim listening", { port: config.port });
  printConfig(logger);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info("shutting down", { signal });
    server.close(() => {
      process.exit(0);
    });
  });
}
