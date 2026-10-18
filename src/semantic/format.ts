/** Decimal units, as download sizes are usually quoted ("343.3 MB"). */
export function formatMegabytes(bytes: number): string {
	if (bytes < 1_000_000) {
		return `${(bytes / 1000).toFixed(1)} KB`;
	}
	const mb = bytes / 1_000_000;
	return `${mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)} MB`;
}

export function formatPercent(done: number, total: number): string {
	if (total <= 0) {
		return "0%";
	}
	return `${Math.min(100, Math.floor((done / total) * 100))}%`;
}

/** Like formatMegabytes, switching to GB from 1 GB on (traffic estimates). */
export function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000_000) {
		return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
	}
	return formatMegabytes(bytes);
}
