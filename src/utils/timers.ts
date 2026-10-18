/** Injectable timers (tests drive them by hand). Shared by semantic search and thumbnails. */
export interface Timers {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
}
