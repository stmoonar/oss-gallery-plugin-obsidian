import { t } from "../i18n";
import { UploadEntry } from "../services/UploadProgressStore";

const ROOT_CLASS = "oss-gallery-upload-widget";

/**
 * Render the upload progress card (thumbnail + name + progress bar). Shared
 * by the editor widget and the reading mode post processor.
 */
export function createUploadProgressCard(entry: UploadEntry): HTMLElement {
	const root = createSpan({
		cls: ROOT_CLASS,
		attr: { "data-upload-id": entry.id },
	});

	if (entry.previewUrl) {
		root.createEl("img", {
			cls: "oss-gallery-upload-thumb",
			attr: { src: entry.previewUrl, alt: entry.name, draggable: "false" },
		});
	}

	const body = root.createSpan({ cls: "oss-gallery-upload-body" });
	const header = body.createSpan({ cls: "oss-gallery-upload-header" });
	header.createSpan({ cls: "oss-gallery-upload-name", text: entry.name });
	header.createSpan({ cls: "oss-gallery-upload-status" });

	const track = body.createSpan({
		cls: "oss-gallery-upload-track",
		attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" },
	});
	track.createSpan({ cls: "oss-gallery-upload-bar" });

	updateUploadProgressCard(root, entry);
	return root;
}

/** Id of the upload a card was rendered for, or null if `el` is not a card. */
export function getUploadProgressCardId(el: HTMLElement): string | null {
	return el.hasClass(ROOT_CLASS) ? el.getAttribute("data-upload-id") : null;
}

/** Update an existing card in place so the bar width can transition. */
export function updateUploadProgressCard(root: HTMLElement, entry: UploadEntry): void {
	root.toggleClass("is-done", entry.status === "done");
	root.toggleClass("is-failed", entry.status === "failed");
	root.setAttribute("aria-label", `${t("Uploading")} ${entry.name}`);

	const percent = entry.status === "done" ? 100 : entry.percent;

	const status = root.querySelector<HTMLElement>(".oss-gallery-upload-status");
	if (status) {
		status.setText(
			entry.status === "failed"
				? t("Upload failed")
				: entry.status === "done"
					? t("Upload complete")
					: `${percent}%`
		);
	}

	const track = root.querySelector<HTMLElement>(".oss-gallery-upload-track");
	if (track) {
		track.setAttribute("aria-valuenow", String(percent));
		track.setCssProps({ "--oss-upload-progress": `${percent}%` });
	}
}
