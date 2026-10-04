import { MarkdownPostProcessor, MarkdownRenderChild } from "obsidian";
import {
	createUploadProgressCard,
	updateUploadProgressCard,
} from "../components/UploadProgressCard";
import { UPLOAD_ID_PREFIX, uploadIdFromHref } from "../services/uploadPlaceholder";
import { UploadProgressStore } from "../services/UploadProgressStore";

/** Keeps one reading-mode card in sync with the store until it is unloaded. */
class UploadProgressRenderChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly id: string,
		private readonly store: UploadProgressStore
	) {
		super(containerEl);
	}

	onload(): void {
		this.register(
			this.store.subscribe((changedId) => {
				if (changedId !== this.id) return;
				const entry = this.store.get(this.id);
				// A removed entry means the placeholder is being replaced in the
				// note, which re-renders this section anyway.
				if (entry) updateUploadProgressCard(this.containerEl, entry);
			})
		);
	}
}

const LINK_SELECTOR = `a[href^="#${UPLOAD_ID_PREFIX}"], a[data-href^="#${UPLOAD_ID_PREFIX}"]`;

/**
 * Reading mode counterpart of the editor extension: swap rendered placeholder
 * links for a progress card. Unknown ids (stale placeholders) are left alone.
 */
export function createUploadProgressPostProcessor(
	store: UploadProgressStore
): MarkdownPostProcessor {
	return (el, ctx) => {
		el.querySelectorAll<HTMLAnchorElement>(LINK_SELECTOR).forEach((link) => {
			const id =
				uploadIdFromHref(link.getAttribute("data-href")) ??
				uploadIdFromHref(link.getAttribute("href"));
			const entry = id ? store.get(id) : undefined;
			if (!id || !entry) return;

			const card = createUploadProgressCard(entry);
			link.replaceWith(card);
			ctx.addChild(new UploadProgressRenderChild(card, id, store));
		});
	};
}
