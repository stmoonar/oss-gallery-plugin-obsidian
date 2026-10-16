import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseS3ListObjectsPage } from "../../src/providers/shared/s3xml";

/**
 * Minimal DOMParser stand-in (tests run in Node, the plugin runs in Electron).
 * Mimics the browser contract the parser relies on: malformed XML yields a
 * document with a <parsererror> element, getElementsByTagName is recursive.
 */
class FakeEl {
	children: FakeEl[] = [];
	text = "";
	constructor(readonly localName: string) {}
	get textContent(): string {
		return this.text + this.children.map((c) => c.textContent).join("");
	}
	getElementsByTagName(name: string): FakeEl[] {
		return this.children.flatMap((c) => [...(c.localName === name ? [c] : []), ...c.getElementsByTagName(name)]);
	}
}

class FakeDoc extends FakeEl {
	constructor(readonly documentElement: FakeEl | null, private readonly err: boolean) {
		super("#document");
		if (documentElement) this.children.push(documentElement);
	}
	getElementsByTagName(name: string): FakeEl[] {
		if (name === "parsererror" && this.err) return [new FakeEl("parsererror")];
		return super.getElementsByTagName(name);
	}
}

class FakeDOMParser {
	parseFromString(src: string): FakeDoc {
		const stack: FakeEl[] = [];
		let root: FakeEl | null = null;
		const re = /<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>|([^<]+)/g;
		for (let m = re.exec(src); m; m = re.exec(src)) {
			if (m[4] !== undefined) {
				if (stack.length) stack[stack.length - 1].text += m[4];
			} else if (m[1]) {
				if (stack.pop()?.localName !== m[2]) return new FakeDoc(null, true);
			} else {
				const el = new FakeEl(m[2]);
				if (stack.length) stack[stack.length - 1].children.push(el);
				else if (!root) root = el;
				if (!m[3]) stack.push(el);
			}
		}
		if (stack.length || !root) return new FakeDoc(null, true);
		return new FakeDoc(root, false);
	}
}


beforeAll(() => {
	vi.stubGlobal("DOMParser", FakeDOMParser);
});
afterAll(() => {
	vi.unstubAllGlobals();
});

const LIST = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextMarker>m</NextMarker>
<Contents><Key>a.png</Key><LastModified>2024-01-01T00:00:00Z</LastModified><Size>5</Size><ETag>"e"</ETag></Contents></ListBucketResult>`;

describe("parseS3ListObjectsPage", () => {
	it("parses a ListBucketResult", () => {
		const page = parseS3ListObjectsPage(LIST);
		expect(page.objects).toHaveLength(1);
		expect(page.objects[0]).toMatchObject({ key: "a.png", size: 5, etag: '"e"' });
		expect(page.isTruncated).toBe(true);
		expect(page.nextMarker).toBe("m");
	});

	it("accepts an empty ListBucketResult (genuinely empty bucket)", () => {
		const page = parseS3ListObjectsPage("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
		expect(page).toMatchObject({ objects: [], isTruncated: false });
	});

	it("throws for an HTML page instead of reporting an empty bucket", () => {
		expect(() => parseS3ListObjectsPage("<html><body>Login to continue</body></html>")).toThrow(/Invalid list response/);
	});

	it("throws for an empty body and for malformed XML", () => {
		expect(() => parseS3ListObjectsPage("")).toThrow(/Invalid list response/);
		expect(() => parseS3ListObjectsPage("<ListBucketResult><Contents>")).toThrow(/Invalid list response/);
	});

	it("throws with the S3 error code and message for an <Error> document", () => {
		const xml = "<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>";
		expect(() => parseS3ListObjectsPage(xml)).toThrow("Invalid list response: AccessDenied: Denied");
	});
});
