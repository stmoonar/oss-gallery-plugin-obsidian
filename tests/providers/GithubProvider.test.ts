import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubProvider } from "../../src/providers/GithubProvider";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl, Setting: class {}, moment: { locale: () => "en" } }));


const settings = { repo: "o/r", branch: "main", token: "t", customUrl: "" };
const json = (status: number, body: unknown) => ({ status, json: body });
const file = (name: string) => ({ type: "file", name, path: name, size: 1, sha: "s" + name });

beforeEach(() => {
	requestUrl.mockReset();
});

describe("GithubProvider directory walk completeness", () => {
	function route(rootEntries: unknown[]) {
		requestUrl.mockImplementation((req: { url: string }) =>
			req.url.includes("/git/trees/") ? json(500, {}) : json(200, rootEntries)
		);
	}

	it("is complete for a directory below the 1000-entry Contents API cap", async () => {
		route(Array.from({ length: 999 }, (_, i) => file(`${i}.png`)));
		const r = await new GithubProvider(settings).listImages();
		expect(r.items).toHaveLength(999);
		expect(r.complete).toBe(true);
	});

	it("is incomplete when a directory returns 1000 entries (possibly truncated)", async () => {
		route(Array.from({ length: 1000 }, (_, i) => file(`${i}.png`)));
		const r = await new GithubProvider(settings).listImages();
		expect(r.items).toHaveLength(1000);
		expect(r.complete).toBe(false);
	});
});
