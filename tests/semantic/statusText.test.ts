import { describe, expect, it } from "vitest";
import { formatMegabytes } from "../../src/semantic/format";
import {
	fileNameOf,
	formatCount,
	formatIndexSize,
	formatIndexSummary,
	formatProgressCount,
	progressPercent,
	SummaryTemplates,
} from "../../src/semantic/statusText";

const ZH: SummaryTemplates = {
	indexed: "已索引 {count} 张",
	converted: "{count} 张已转换",
	unsupported: "{count} 张不支持",
	failed: "{count} 张失败",
	pending: "{count} 张待索引",
	separator: " · ",
};
const EN: SummaryTemplates = {
	indexed: "{count} indexed",
	converted: "{count} converted",
	unsupported: "{count} unsupported",
	failed: "{count} failed",
	pending: "{count} not indexed yet",
	separator: " · ",
};

describe("index status texts (§9.2)", () => {
	it("formats counts with thousands separators", () => {
		expect(formatCount(1234)).toBe("1,234");
		expect(formatCount(0)).toBe("0");
		expect(formatCount(1_234_567)).toBe("1,234,567");
	});

	it("chip: always the indexed count, other parts only when non-zero", () => {
		const counts = { indexed: 1234, converted: 3, unsupported: 2, failed: 0, pending: 0 };
		expect(formatIndexSummary(counts, ZH)).toBe("已索引 1,234 张 · 3 张已转换 · 2 张不支持");
		expect(formatIndexSummary({ indexed: 0, converted: 0, unsupported: 0, failed: 0, pending: 0 }, EN)).toBe("0 indexed");
		expect(formatIndexSummary({ indexed: 10, converted: 0, unsupported: 0, failed: 1, pending: 1500 }, EN))
			.toBe("10 indexed · 1 failed · 1,500 not indexed yet");
	});

	it("progress count and percent", () => {
		expect(formatProgressCount(12, 1340)).toBe("12 / 1,340");
		// total never shows below done (uploads joining a run)
		expect(formatProgressCount(5, 3)).toBe("5 / 5");
		expect(progressPercent(1, 3)).toBe(33);
		expect(progressPercent(0, 0)).toBe(0);
		expect(progressPercent(9, 3)).toBe(100);
	});

	it("file name of a key", () => {
		expect(fileNameOf("2025/10/cat.png")).toBe("cat.png");
		expect(fileNameOf("cat.png")).toBe("cat.png");
		expect(fileNameOf("dir/")).toBe("dir");
	});
});

describe("formatIndexSize", () => {
	const tpl = {
		single: "{size} on disk",
		split: "{scope} on disk; {vault} for this vault",
		othersOnly: "{vault} on disk for other providers",
	};

	it("shows only the scope when it is the whole vault", () => {
		expect(formatIndexSize({ total: 5_190_000, byScope: { a: 5_190_000 } }, "a", tpl, formatMegabytes))
			.toBe("5.19 MB on disk");
	});

	it("adds the vault total when other scopes have indexes", () => {
		expect(formatIndexSize({ total: 12_000_000, byScope: { a: 2_000_000, b: 10_000_000 } }, "a", tpl, formatMegabytes))
			.toBe("2.00 MB on disk; 12.0 MB for this vault");
	});

	it("reports other scopes when the current one has no index, nothing when the vault has none", () => {
		expect(formatIndexSize({ total: 300_000, byScope: { b: 300_000 } }, "a", tpl, formatMegabytes))
			.toBe("300.0 KB on disk for other providers");
		expect(formatIndexSize({ total: 300_000, byScope: { b: 300_000 } }, null, tpl, formatMegabytes))
			.toBe("300.0 KB on disk for other providers");
		expect(formatIndexSize({ total: 0, byScope: {} }, "a", tpl, formatMegabytes)).toBe("");
	});
});
