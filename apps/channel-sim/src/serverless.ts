import { waitUntil } from "@vercel/functions";
import { createApp, type AcceptedMessage } from "./app";
import { simulateBatch } from "./simulate";

/**
 * Source for the Vercel serverless function. It is bundled into `api/index.js`
 * by `pnpm build:vercel` (esbuild), because @vercel/node externalises
 * node_modules — including the workspace package `@resonate/shared`, whose
 * `exports` point at raw `.ts` that Node can't load at runtime (ERR_MODULE_NOT_FOUND).
 * Bundling inlines `@resonate/shared` + this app's `src/`; express/zod/
 * @vercel/functions stay external and resolve from the function's node_modules.
 *
 * A serverless function is frozen the instant the HTTP response is sent, so the
 * standalone server's background timers + flusher never run here. We keep the
 * request/response contract identical (same Express app) and drive the post-202
 * lifecycle through `waitUntil` — see src/simulate.ts. All routes are rewritten
 * to this function (vercel.json), and Express dispatches on the original path.
 */
const app = createApp((messages: AcceptedMessage[]) => {
  waitUntil(simulateBatch(messages));
});

export default app;
