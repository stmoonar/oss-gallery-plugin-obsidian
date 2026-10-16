import { describe, expect, it } from "vitest";
import { collectPages, ListingCollector, ListPage } from "../../src/providers/shared/listing";
import type { OssImage } from "../../src/types/oss";

function img(key: string): OssImage {
	return { key, url: `u/${key}`, size: 1 };
}

/** fetchPage that serves `pages` in order, recording the cursors it was given. */
function pager(pages: ListPage[]) {
	const cursors: Array<string | undefined> = [];
	const fetchPage = (cursor: string | undefined, i: number): Promise<ListPage> => {
		cursors.push(cursor);
		return Promise.resolve(pages[i] ?? { items: [] });
	};
	return { cursors, fetchPage };
}

describe("collectPages (listing completeness, §4.1)", () => {
	it("is complete when the server reports the last page", async () => {
		const { cursors, fetchPage } = pager([
			{ items: [img("a")], more: true, next: "t1" },
			{ items: [img("b")], more: false, next: "ignored" },
		]);
		const r = await collectPages(new ListingCollector("t", "base/"), 20, fetchPage);
		expect(r).toEqual({ items: [img("a"), img("b")], complete: true, prefix: "base/" });
		expect(cursors).toEqual([undefined, "t1"]);
	});

	it("treats an empty next cursor as the last page when `more` is omitted (Qiniu)", async () => {
		const { fetchPage } = pager([{ items: [img("a")], next: "m1" }, { items: [img("b")], next: "" }]);
		const r = await collectPages(new ListingCollector("t", ""), 20, fetchPage);
		expect(r.complete).toBe(true);
		expect(r.items).toHaveLength(2);
	});

	it("is incomplete when the page cap is hit (MAX_LIST_PAGES)", async () => {
		const pages = Array.from({ length: 5 }, (_, i) => ({ items: [img(`k${i}`)], more: true, next: `t${i}` }));
		const { fetchPage } = pager(pages);
		const r = await collectPages(new ListingCollector("capped-test", ""), 3, fetchPage);
		expect(r.complete).toBe(false);
		expect(r.items.map((i) => i.key)).toEqual(["k0", "k1", "k2"]);
	});

	it("is incomplete when the server says 'more' without a cursor", async () => {
		const { fetchPage } = pager([{ items: [img("a")], more: true }]);
		const r = await collectPages(new ListingCollector("t", ""), 20, fetchPage);
		expect(r.complete).toBe(false);
	});

	it("is incomplete when the cursor repeats (would loop forever)", async () => {
		const { fetchPage } = pager([
			{ items: [img("a")], more: true, next: "same" },
			{ items: [img("b")], more: true, next: "same" },
		]);
		const r = await collectPages(new ListingCollector("t", ""), 20, fetchPage);
		expect(r.complete).toBe(false);
		expect(r.items).toHaveLength(2);
	});

	it("propagates request errors (callers keep their error handling)", async () => {
		await expect(collectPages(new ListingCollector("t", ""), 20, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
	});
});

describe("ListingCollector", () => {
	it("starts complete; markIncomplete and capped clear it", () => {
		const c = new ListingCollector("collector-test", "p/");
		c.push(img("a"));
		expect(c.result()).toEqual({ items: [img("a")], complete: true, prefix: "p/" });
		c.capped(200);
		expect(c.isComplete()).toBe(false);
		const d = new ListingCollector("t", "");
		d.markIncomplete();
		expect(d.result().complete).toBe(false);
	});
});
