/**
 * Multi-selection of gallery tiles, kept free of DOM and Obsidian imports so
 * the rules are unit-tested. States are immutable; `order` is the key order
 * of the tiles as shown.
 */

export interface SelectionState {
	readonly keys: ReadonlySet<string>;
	/** Where a Shift-click range starts (the last plain toggle). */
	readonly anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { keys: new Set(), anchor: null };

/** What a click on a tile does. */
export type TileClickAction = "open" | "toggle" | "range" | "range-add";

/**
 * Ctrl/Cmd toggles, Shift selects a range (Ctrl/Cmd+Shift adds it), a plain
 * click opens the preview, or toggles while a selection exists (selection
 * mode, also how touch users pick more images after "Select").
 */
export function clickAction(mods: { toggle: boolean; shift: boolean }, selecting: boolean): TileClickAction {
	if (mods.shift) return mods.toggle ? "range-add" : "range";
	if (mods.toggle) return "toggle";
	return selecting ? "toggle" : "open";
}

export function toggleKey(state: SelectionState, key: string): SelectionState {
	const keys = new Set(state.keys);
	if (keys.has(key)) {
		keys.delete(key);
	} else {
		keys.add(key);
	}
	return { keys, anchor: key };
}

/**
 * Shift-click on `target`: the tiles between the anchor and the target
 * (inclusive). `additive` keeps the current selection as well. Without an
 * anchor (or one that is no longer shown) the target alone is selected.
 */
export function selectRange(
	state: SelectionState,
	order: readonly string[],
	target: string,
	additive: boolean
): SelectionState {
	const to = order.indexOf(target);
	if (to < 0) return state;
	const from = state.anchor === null ? -1 : order.indexOf(state.anchor);
	const keys = new Set(additive ? state.keys : []);
	if (from < 0) {
		keys.add(target);
		return { keys, anchor: target };
	}
	const [lo, hi] = from <= to ? [from, to] : [to, from];
	for (let i = lo; i <= hi; i++) {
		const key = order[i];
		if (key !== undefined) keys.add(key);
	}
	return { keys, anchor: state.anchor };
}

export function selectAll(order: readonly string[]): SelectionState {
	return { keys: new Set(order), anchor: order[0] ?? null };
}

/** Drop keys that are no longer shown (new listing, search, delete). */
export function retainKeys(state: SelectionState, order: readonly string[]): SelectionState {
	if (state.keys.size === 0) return state;
	const shown = new Set(order);
	const keys = new Set([...state.keys].filter((k) => shown.has(k)));
	const anchor = state.anchor !== null && shown.has(state.anchor) ? state.anchor : null;
	if (keys.size === state.keys.size && anchor === state.anchor) return state;
	return { keys, anchor };
}

/** Selected keys in display order. */
export function orderedSelection(state: SelectionState, order: readonly string[]): string[] {
	return order.filter((k) => state.keys.has(k));
}
