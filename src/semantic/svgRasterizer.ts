/**
 * SVG -> PNG on the main thread (workers have no SVG decoder).
 *
 * Safety: the SVG is loaded through an <img> from a Blob URL. Images never
 * run scripts and never load external resources (other images, fonts,
 * stylesheets), and the Blob URL is revoked right after decoding. Nothing is
 * inserted into the DOM.
 */

/** Longest side of the rasterized image. The model downsizes further. */
export const SVG_RASTER_MAX_SIDE = 1024;
/** Small or size-less SVGs are drawn at least this large (vectors scale freely). */
export const SVG_RASTER_MIN_SIDE = 512;

export function svgRasterSize(width: number, height: number): { width: number; height: number } {
	if (!(width > 0) || !(height > 0)) {
		return { width: SVG_RASTER_MIN_SIDE, height: SVG_RASTER_MIN_SIDE };
	}
	const longest = Math.max(width, height);
	const target = Math.min(SVG_RASTER_MAX_SIDE, Math.max(SVG_RASTER_MIN_SIDE, longest));
	const scale = target / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

export async function rasterizeSvg(bytes: ArrayBuffer): Promise<ArrayBuffer> {
	const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
	try {
		const img = new Image();
		img.decoding = "async";
		img.src = url;
		await img.decode();
		const { width, height } = svgRasterSize(img.naturalWidth, img.naturalHeight);
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("2D canvas is not available");
		}
		// White background: transparent areas would otherwise turn black.
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(img, 0, 0, width, height);
		const blob = await canvas.convertToBlob({ type: "image/png" });
		return await blob.arrayBuffer();
	} finally {
		URL.revokeObjectURL(url);
	}
}
