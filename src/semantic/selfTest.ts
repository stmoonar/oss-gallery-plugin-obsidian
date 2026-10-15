/**
 * "Semantic search: run self-test": real inference inside Obsidian with a
 * fresh index worker, so the maintainer can check WebGPU, load time, latency
 * and that matching image/text pairs score highest. Obsidian-free (images
 * are passed in) so the same code runs in the Electron test harness.
 */
import type { BackendInitInfo } from "./EmbeddingBackend";
import { dot, EmbeddingConfig, l2norm } from "./protocol";
import type { WorkerEmbeddingBackend } from "./WorkerEmbeddingBackend";

export interface SelfTestImage {
	label: string;
	bytes: ArrayBuffer;
	mime: string;
}

export interface SelfTestImageResult {
	label: string;
	ok: boolean;
	error?: string;
}

export interface SelfTestReport {
	ok: boolean;
	error?: string;
	init?: BackendInitInfo;
	/** Host wall time for verify + worker start + model load. */
	initWallMs?: number;
	queries: string[];
	/** First text call (includes shader compilation). */
	textFirstMs?: number;
	/** Second call with the same queries, warm. */
	textWarmMs?: number;
	images: SelfTestImageResult[];
	imageFirstMs?: number;
	imageWarmMs?: number;
	imageBatches?: number;
	/** sims[image][query], null when the image failed. */
	sims: Array<Array<number | null>>;
	dims?: number;
	normMin?: number;
	normMax?: number;
}

export const SELF_TEST_QUERIES = [
	"a red circle on a white background",
	"a photo of a cat",
	"a screenshot of a document with text",
];

/** A 256x256 red disc on white, drawn without the DOM. */
export async function syntheticTestImage(): Promise<SelfTestImage> {
	const canvas = new OffscreenCanvas(256, 256);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("2D canvas is not available");
	}
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, 256, 256);
	ctx.fillStyle = "#e02020";
	ctx.beginPath();
	ctx.arc(128, 128, 80, 0, Math.PI * 2);
	ctx.fill();
	const blob = await canvas.convertToBlob({ type: "image/png" });
	return { label: "synthetic red circle", bytes: await blob.arrayBuffer(), mime: "image/png" };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runSelfTest(
	backend: WorkerEmbeddingBackend,
	cfg: EmbeddingConfig,
	images: SelfTestImage[],
	queries: string[] = SELF_TEST_QUERIES,
	now: () => number = () => performance.now()
): Promise<SelfTestReport> {
	const report: SelfTestReport = {
		ok: false,
		queries,
		images: images.map((i) => ({ label: i.label, ok: false })),
		sims: [],
	};
	try {
		let t0 = now();
		report.init = await backend.init("index", cfg);
		report.initWallMs = Math.round(now() - t0);

		t0 = now();
		await backend.embedText(queries);
		report.textFirstMs = Math.round(now() - t0);
		t0 = now();
		const textVectors = await backend.embedText(queries);
		report.textWarmMs = Math.round(now() - t0);

		// Bytes are transferred to the worker, so send copies each time.
		const copies = (): SelfTestImage[] => images.map((i) => ({ ...i, bytes: i.bytes.slice(0) }));
		const toInputs = (list: SelfTestImage[]) => list.map((img, n) => ({ id: String(n), bytes: img.bytes, mime: img.mime }));
		t0 = now();
		await backend.embedImages(toInputs(copies()));
		report.imageFirstMs = Math.round(now() - t0);
		t0 = now();
		const detailed = await backend.embedImagesDetailed(toInputs(copies()));
		report.imageWarmMs = Math.round(now() - t0);
		report.imageBatches = detailed.batches;

		const norms: number[] = textVectors.map((v) => l2norm(v));
		report.dims = textVectors[0]?.length;
		report.sims = detailed.items.map((item, n) => {
			if (!item.ok) {
				report.images[n] = { label: images[n].label, ok: false, error: `${item.code}: ${item.message}` };
				return queries.map(() => null);
			}
			report.images[n] = { label: images[n].label, ok: true };
			norms.push(l2norm(item.vector));
			return textVectors.map((q) => Math.round(dot(item.vector, q) * 1000) / 1000);
		});
		report.normMin = Math.min(...norms);
		report.normMax = Math.max(...norms);
		report.ok = report.images.some((i) => i.ok);
	} catch (error) {
		report.error = errorMessage(error);
	}
	return report;
}
