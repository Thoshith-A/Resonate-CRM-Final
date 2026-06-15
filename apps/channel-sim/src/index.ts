import { createApp, type AcceptedMessage } from "./app";
import { config, configError, printConfig } from "./config";
import { funnelSummary } from "./funnels";
import { scheduleLifecycle } from "./lifecycle";
import { logger } from "./logger";
import { startReceiptFlusher } from "./receipts";

// The standalone server fails fast on bad config (the serverless entry boots
// degraded and reports it on /health instead — see config.ts).
if (configError) {
  process.exit(1);
}

/**
 * Standalone long-running server (local + Render). The funnel plays out on
 * background timers and a shared periodic flusher drains receipts. The
 * serverless deployment uses a different driver — see api/index.ts.
 */

const dispatchOnTimers = (messages: AcceptedMessage[]): void => {
  for (const message of messages) {
    if (message.startDelayMs > 0) {
      setTimeout(() => scheduleLifecycle(message.vendorMessageId, message.record), message.startDelayMs);
    } else {
      scheduleLifecycle(message.vendorMessageId, message.record);
    }
  }
};

const app = createApp(dispatchOnTimers);

const server = app.listen(config.port, () => {
  logger.info("channel-sim listening", { port: config.port });
  printConfig(logger);
  logger.info("funnels", { summary: funnelSummary() });
});

const flusher = startReceiptFlusher();
logger.info("receipt flusher started (every 1s)");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info("shutting down", { signal });
    clearInterval(flusher);
    server.close(() => {
      process.exit(0);
    });
  });
}
