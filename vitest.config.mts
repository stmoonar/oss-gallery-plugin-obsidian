import { defineConfig } from "vitest/config";

// Unit tests (pnpm test). Node environment; nothing here is bundled into the
// plugin. Code that needs Obsidian, WebGPU or a real worker is covered by the
// in-app self-test command instead.
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
