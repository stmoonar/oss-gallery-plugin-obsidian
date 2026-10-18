/**
 * Obsidian side of "Semantic search: run self-test": picks test images from
 * the vault, runs src/semantic/selfTest.ts in a fresh index worker and shows
 * the report. The worker is terminated afterwards.
 */
import { App, Notice, TFile } from "obsidian";
import { t } from "../i18n";
import { SemanticSelfTestModal } from "../modals/SemanticSelfTestModal";
import type { SemanticController } from "./SemanticController";
import { runSelfTest, SelfTestImage, syntheticTestImage } from "./selfTest";

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
};
const MAX_VAULT_IMAGES = 2;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function isTestableImage(file: TFile): boolean {
	return IMAGE_MIME[file.extension.toLowerCase()] !== undefined && file.stat.size <= MAX_IMAGE_BYTES;
}

/** The active image (if any) plus the most recently modified vault images. */
async function vaultImages(app: App): Promise<SelfTestImage[]> {
	const picked: TFile[] = [];
	const active = app.workspace.getActiveFile();
	if (active && isTestableImage(active)) {
		picked.push(active);
	}
	const recent = app.vault.getFiles()
		.filter((f) => isTestableImage(f) && !picked.includes(f))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
	for (const f of recent) {
		if (picked.length >= MAX_VAULT_IMAGES) {
			break;
		}
		picked.push(f);
	}
	const out: SelfTestImage[] = [];
	for (const file of picked) {
		try {
			out.push({
				label: file.path,
				bytes: await app.vault.readBinary(file),
				mime: IMAGE_MIME[file.extension.toLowerCase()],
			});
		} catch (error) {
			console.warn("OSS Gallery: self-test could not read", file.path, error);
		}
	}
	return out;
}

export async function runSemanticSelfTestCommand(app: App, semantic: SemanticController): Promise<void> {
	const state = await semantic.refresh();
	if (state.kind === "unsupported") {
		new Notice(t("Semantic self-test needs WebGPU"));
		return;
	}
	if (state.kind !== "installed") {
		new Notice(t("Semantic self-test needs installed model"));
		return;
	}
	const backend = semantic.createBackend("index", { idleTimeoutMs: 0 });
	if (!backend) {
		new Notice(t("Semantic self-test needs installed model"));
		return;
	}
	const notice = new Notice(t("Semantic self-test running"), 0);
	try {
		const images = [await syntheticTestImage(), ...(await vaultImages(app))];
		const report = await runSelfTest(backend, semantic.embeddingConfig(), images);
		console.debug("OSS Gallery: semantic self-test", report);
		console.debug("OSS Gallery: semantic self-test similarities", report.sims.map((row, i) => {
			const rec: Record<string, number | string | null> = { image: report.images[i]?.label ?? String(i) };
			report.queries.forEach((q, j) => {
				rec[q] = row[j];
			});
			return rec;
		}));
		new SemanticSelfTestModal(app, report).open();
	} catch (error) {
		new Notice(`${t("Semantic self-test failed")}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		notice.hide();
		await backend.dispose();
	}
}
