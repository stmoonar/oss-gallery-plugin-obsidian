import { describe, expect, it } from "vitest";
import { formatNameList, summarizeSkipped, triageFiles } from "../../src/services/uploadFileTriage";

const file = (name: string, kind: "image" | "video" | "zip") => ({ name, kind });
type F = ReturnType<typeof file>;

// Imgur-like provider: images only; zips are unsupported by the plugin.
const triage = (files: F[]) =>
	triageFiles(
		files,
		(f) => f.kind !== "zip",
		(f) => f.kind === "image"
	);

describe("triageFiles", () => {
	it("splits files into accepted, rejected by provider and unsupported, keeping order", () => {
		const result = triage([
			file("a.png", "image"),
			file("b.mp4", "video"),
			file("c.zip", "zip"),
			file("d.png", "image"),
		]);
		expect(result.accepted.map((f) => f.name)).toEqual(["a.png", "d.png"]);
		expect(result.rejectedByProvider.map((f) => f.name)).toEqual(["b.mp4"]);
		expect(result.unsupported.map((f) => f.name)).toEqual(["c.zip"]);
	});
});

describe("summarizeSkipped", () => {
	it("says nothing when every file is uploaded", () => {
		expect(summarizeSkipped(triage([file("a.png", "image")]), "drop")).toBeNull();
	});

	it("groups left-out files into one partial summary", () => {
		const summary = summarizeSkipped(
			triage([file("a.png", "image"), file("b.mp4", "video"), file("c.mp4", "video"), file("d.zip", "zip")]),
			"drop"
		);
		expect(summary).toEqual({
			heading: "partial",
			rejectedNames: ["b.mp4", "c.mp4"],
			unsupportedNames: ["d.zip"],
		});
	});

	it("tells that Obsidian handles a drop the provider rejects entirely", () => {
		const summary = summarizeSkipped(triage([file("b.mp4", "video"), file("d.zip", "zip")]), "drop");
		expect(summary?.heading).toBe("native");
	});

	it("stays silent for an ordinary paste of files the plugin never uploads", () => {
		expect(summarizeSkipped(triage([file("d.zip", "zip")]), "drop")).toBeNull();
	});

	it("reports that nothing was uploaded from the file picker", () => {
		expect(summarizeSkipped(triage([file("d.zip", "zip")]), "picker")?.heading).toBe("none");
		expect(summarizeSkipped(triage([file("b.mp4", "video")]), "picker")?.heading).toBe("none");
	});
});

describe("formatNameList", () => {
	const more = (list: string, count: number) => `${list} and ${count} more`;

	it("joins short lists", () => {
		expect(formatNameList(["a", "b"], ", ", more)).toBe("a, b");
	});

	it("counts names beyond the limit", () => {
		expect(formatNameList(["a", "b", "c", "d", "e"], ", ", more)).toBe("a, b, c and 2 more");
		expect(formatNameList(["a", "b"], "、", more, 1)).toBe("a and 1 more");
	});
});
