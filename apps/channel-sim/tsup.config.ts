import { defineConfig } from "tsup";

// The channel-sim ships as a single bundled file (`node dist/index.js`).
// `@resonate/shared` is a workspace package published as raw TypeScript
// (its `exports` point at `./src/*.ts`), so it MUST be bundled in — left
// external, Node would try to load its `.ts` source at runtime and fail on
// extensionless ESM imports. Everything else (express, zod, @vercel/functions)
// stays external and resolves from node_modules.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  noExternal: ["@resonate/shared"],
});
