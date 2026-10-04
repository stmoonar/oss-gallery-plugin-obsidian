import { Extension, Prec, RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import {
	createUploadProgressCard,
	getUploadProgressCardId,
	updateUploadProgressCard,
} from "../components/UploadProgressCard";
import { findUploadPlaceholders } from "../services/uploadPlaceholder";
import { UploadEntry, UploadProgressStore } from "../services/UploadProgressStore";

/** Dispatched (without any doc change) when the progress store changes. */
const uploadProgressChanged = StateEffect.define<null>();

class UploadProgressWidget extends WidgetType {
	constructor(private readonly entry: UploadEntry) {
		super();
	}

	eq(other: UploadProgressWidget): boolean {
		return (
			other.entry.id === this.entry.id &&
			other.entry.percent === this.entry.percent &&
			other.entry.status === this.entry.status
		);
	}

	toDOM(): HTMLElement {
		return createUploadProgressCard(this.entry);
	}

	/** Reuse the existing DOM so the progress bar width transitions smoothly. */
	updateDOM(dom: HTMLElement): boolean {
		if (getUploadProgressCardId(dom) !== this.entry.id) return false;
		updateUploadProgressCard(dom, this.entry);
		return true;
	}
}

/**
 * Replace upload placeholders (`[...](#oss-upload-id)`) in the visible part of
 * the document with a progress widget. Placeholders without a store entry
 * (e.g. stale ones left over from a previous session) stay plain text.
 */
function buildDecorations(view: EditorView, store: UploadProgressStore): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const { doc } = view.state;
	let scannedTo = -1;

	for (const range of view.visibleRanges) {
		// Placeholders are single-line: scan whole lines so one cut by a
		// range boundary is still found.
		const from = Math.max(doc.lineAt(range.from).from, scannedTo);
		const to = doc.lineAt(range.to).to;
		if (from >= to) continue;
		scannedTo = to;

		for (const match of findUploadPlaceholders(doc.sliceString(from, to), from)) {
			const entry = store.get(match.id);
			if (!entry) continue;
			builder.add(
				match.from,
				match.to,
				Decoration.replace({ widget: new UploadProgressWidget(entry) })
			);
		}
	}

	return builder.finish();
}

class UploadProgressViewPlugin implements PluginValue {
	decorations: DecorationSet;
	private readonly unsubscribe: () => void;
	private frame: number | null = null;

	constructor(
		private readonly view: EditorView,
		private readonly store: UploadProgressStore
	) {
		this.decorations = buildDecorations(view, store);
		// Each editor registers itself with the store, so progress reaches it
		// through a doc-less transaction instead of a text rewrite.
		this.unsubscribe = store.subscribe(() => this.scheduleRefresh());
	}

	update(update: ViewUpdate): void {
		const progressChanged = update.transactions.some((tr) =>
			tr.effects.some((effect) => effect.is(uploadProgressChanged))
		);
		if (update.docChanged || update.viewportChanged || progressChanged) {
			this.decorations = buildDecorations(update.view, this.store);
		}
	}

	destroy(): void {
		this.unsubscribe();
		if (this.frame !== null) {
			window.cancelAnimationFrame(this.frame);
			this.frame = null;
		}
	}

	/** Coalesce store notifications into at most one dispatch per frame. */
	private scheduleRefresh(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.view.dispatch({ effects: uploadProgressChanged.of(null) });
		});
	}
}

export function uploadProgressExtension(store: UploadProgressStore): Extension {
	const plugin = ViewPlugin.define(
		(view) => new UploadProgressViewPlugin(view, store),
		{
			decorations: (value) => value.decorations,
			// Let the cursor skip over the widget as a single unit.
			provide: (p) =>
				EditorView.atomicRanges.of(
					(view) => view.plugin(p)?.decorations ?? Decoration.none
				),
		}
	);
	// Highest precedence so the widget wins over Live Preview's own link
	// decorations on the same range.
	return Prec.highest(plugin);
}
