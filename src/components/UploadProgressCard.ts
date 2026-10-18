import { setIcon } from "obsidian";
import { t } from "../i18n";
import { UploadAction, UploadEntry } from "../services/UploadProgressStore";

const ROOT_CLASS = "oss-gallery-upload-widget";

/** Called when a card button is clicked. */
export type UploadCardActionHandler = (id: string, action: UploadAction) => void;

/**
 * Render the upload progress card (thumbnail + name + progress bar, and the
 * buttons for the current state). Shared by the editor widget and the
 * reading mode post processor. Display only: never written to the note.
 */
export function createUploadProgressCard(
	entry: UploadEntry,
	onAction: UploadCardActionHandler
): HTMLElement {
	const root = createSpan({
		cls: ROOT_CLASS,
		attr: { "data-upload-id": entry.id, role: "group" },
	});

	if (entry.previewUrl) {
		root.createEl("img", {
			cls: "oss-gallery-upload-thumb",
			// The card's label already names the file.
			attr: { src: entry.previewUrl, alt: "", draggable: "false" },
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
	body.createSpan({ cls: "oss-gallery-upload-error" });

	root.createSpan({ cls: "oss-gallery-upload-actions" });

	updateUploadProgressCard(root, entry, onAction);
	return root;
}

/** Id of the upload a card was rendered for, or null if `el` is not a card. */
export function getUploadProgressCardId(el: HTMLElement): string | null {
	return el.hasClass(ROOT_CLASS) ? el.getAttribute("data-upload-id") : null;
}

/** Accessible name of a card for its current state. */
export function describeUploadEntry(entry: UploadEntry): string {
	const fill = (key: Parameters<typeof t>[0]) =>
		t(key)
			.replace("{name}", () => entry.name)
			.replace("{percent}", () => String(entry.percent))
			.replace("{message}", () => entry.error ?? "");
	switch (entry.status) {
		case "queued":
			return fill("Upload aria waiting");
		case "uploading":
			return fill(entry.percent === null ? "Upload aria uploading" : "Upload aria uploading percent");
		case "done":
			return fill("Upload aria done");
		case "failed":
			return fill("Upload aria failed");
	}
}

/**
 * Obsidian shows a tooltip for every hovered element with an aria-label and
 * hides it only on pointerout / pointerup. A card element removed under the
 * pointer (upload finished, buttons rebuilt) never sends pointerout, so its
 * tooltip would stay on screen with the text it had when it appeared.
 * Send that pointerout ourselves before the element goes away.
 */
export function dismissTooltipsWithin(el: HTMLElement): void {
	if (!el.isConnected) return;
	const labelled = [el, ...Array.from(el.querySelectorAll<HTMLElement>("[aria-label]"))];
	for (const node of labelled) {
		if (!node.hasAttribute("aria-label") || !node.matches(":hover")) continue;
		node.dispatchEvent(
			new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: null })
		);
	}
}

/** Text next to the file name: never a percentage nobody measured. */
function statusText(entry: UploadEntry): string {
	switch (entry.status) {
		case "failed":
			return t("Upload failed");
		case "done":
			return t("Upload complete");
		case "queued":
			return t("Upload waiting");
		case "uploading":
			return entry.percent === null ? t("Uploading") : `${entry.percent}%`;
	}
}

/** Update an existing card in place so the bar width can transition. */
export function updateUploadProgressCard(
	root: HTMLElement,
	entry: UploadEntry,
	onAction: UploadCardActionHandler
): void {
	const failed = entry.status === "failed";
	const done = entry.status === "done";
	// The card disappears right after this; take its tooltips with it.
	if (done) dismissTooltipsWithin(root);
	root.toggleClass("oss-gallery-is-done", done);
	root.toggleClass("oss-gallery-is-failed", failed);
	root.toggleClass("oss-gallery-is-queued", entry.status === "queued");
	root.setAttribute("aria-label", describeUploadEntry(entry));
	root.setAttribute("aria-busy", String(entry.status === "uploading" || entry.busy === true));

	// null: nothing measured. A queued card shows an empty track, a running
	// upload without real progress an indeterminate (animated) bar.
	const percent = done ? 100 : entry.status === "uploading" ? entry.percent : null;
	const indeterminate = entry.status === "uploading" && entry.percent === null;
	const text = statusText(entry);

	const status = root.querySelector<HTMLElement>(".oss-gallery-upload-status");
	status?.setText(text);

	const track = root.querySelector<HTMLElement>(".oss-gallery-upload-track");
	if (track) {
		track.toggleClass("oss-gallery-hidden", failed);
		track.toggleClass("oss-gallery-is-indeterminate", indeterminate);
		// An indeterminate progressbar has no aria-valuenow (WAI-ARIA).
		if (percent === null) track.removeAttribute("aria-valuenow");
		else track.setAttribute("aria-valuenow", String(percent));
		track.setAttribute("aria-valuetext", text);
		track.setCssProps({ "--oss-upload-progress": `${percent ?? 0}%` });
	}

	const errorEl = root.querySelector<HTMLElement>(".oss-gallery-upload-error");
	if (errorEl) {
		const message = failed ? entry.error ?? "" : "";
		errorEl.setText(message);
		errorEl.toggleClass("oss-gallery-hidden", message === "");
		if (message) errorEl.setAttribute("title", message);
		else errorEl.removeAttribute("title");
	}

	const actions = root.querySelector<HTMLElement>(".oss-gallery-upload-actions");
	if (actions) renderActions(actions, entry, onAction);
}

/**
 * (Re)build the buttons only when the state they depend on changed, so
 * progress ticks never replace a button under the pointer or keyboard focus.
 */
function renderActions(
	container: HTMLElement,
	entry: UploadEntry,
	onAction: UploadCardActionHandler
): void {
	const key = `${entry.status}:${entry.busy === true}`;
	if (container.getAttribute("data-state") === key) return;
	container.setAttribute("data-state", key);
	dismissTooltipsWithin(container);
	container.empty();

	const addButton = (
		action: UploadAction,
		label: string,
		options: { icon?: string; tooltip?: string; cta?: boolean } = {}
	) => {
		const button = container.createEl("button", {
			cls: "oss-gallery-upload-action",
			attr: { type: "button" },
		});
		if (options.cta) button.addClass("mod-cta");
		if (options.icon) {
			// Icon only: the label is its accessible name (and Obsidian's tooltip).
			button.addClass("clickable-icon");
			button.setAttribute("aria-label", label);
			setIcon(button, options.icon);
		} else {
			// Visible text stays the accessible name; the tooltip only adds detail.
			button.setText(label);
			if (options.tooltip) button.setAttribute("title", options.tooltip);
		}
		button.disabled = entry.busy === true;
		// Keep the editor from moving its cursor / selection into the widget.
		button.addEventListener("mousedown", (event) => event.preventDefault());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onAction(entry.id, action);
		});
	};

	switch (entry.status) {
		case "queued":
		case "uploading":
			addButton("cancel", t("Upload cancel"), { icon: "x" });
			break;
		case "failed":
			addButton("retry", t("Upload retry"), { cta: true });
			addButton("save-local", t("Upload save to vault"), {
				tooltip: t("Upload save to vault tooltip"),
			});
			addButton("dismiss", t("Upload remove"), { tooltip: t("Upload remove tooltip") });
			break;
		default:
			break;
	}
}
