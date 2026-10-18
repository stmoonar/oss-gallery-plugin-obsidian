/**
 * One visually hidden, polite live region for upload results. Cards are
 * re-created by the editor and reading view, so announcements go through a
 * single long-lived element instead of the cards themselves.
 */
export class UploadAnnouncer {
	private readonly el: HTMLElement;
	private clearTimer: number | null = null;

	constructor(parent: HTMLElement = document.body) {
		this.el = parent.createDiv({
			cls: "oss-gallery-sr-only",
			attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
		});
	}

	announce(message: string): void {
		// Clear first so repeating the same text is announced again.
		this.el.setText("");
		window.setTimeout(() => this.el.setText(message), 50);
		if (this.clearTimer !== null) window.clearTimeout(this.clearTimer);
		this.clearTimer = window.setTimeout(() => {
			this.clearTimer = null;
			this.el.setText("");
		}, 10000);
	}

	destroy(): void {
		if (this.clearTimer !== null) window.clearTimeout(this.clearTimer);
		this.el.remove();
	}
}
