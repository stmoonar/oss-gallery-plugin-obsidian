/**
 * WebGPU availability probe (docs/semantic-search.md §8.3, decisions D2/D3).
 *
 * Semantic search runs on WebGPU only. The probe runs before anything is
 * downloaded; when it fails the feature cannot be enabled and the settings
 * tab shows the localized reason.
 */

export type WebGpuFailureReason =
	/** navigator.gpu is missing: Obsidian/Electron too old or WebGPU disabled. */
	| "no-api"
	/** requestAdapter() returned null: blocklisted/outdated driver, remote desktop, VM. */
	| "no-adapter"
	/** Only a CPU/software adapter (SwiftShader, WARP, llvmpipe) is available. */
	| "software-adapter"
	/** The adapter cannot hold the largest weight tensor. */
	| "insufficient-limits"
	/** requestAdapter() threw. */
	| "error";

export type WebGpuProbeResult =
	| { ok: true; adapter: string }
	| { ok: false; reason: WebGpuFailureReason; detail?: string };

/**
 * Largest single weight tensor of the q4 text/vision models:
 * `model_embed_tokens_weight_quant` [262144, 256] uint8 = 64 MiB (measured
 * from onnx/model_q4.onnx). WebGPU guarantees 128 MiB bindings by default,
 * so this only rejects adapters that report below-spec limits.
 */
export const MIN_BUFFER_BYTES = 64 * 1024 * 1024;

interface GpuAdapterInfoLike {
	vendor?: string;
	architecture?: string;
	device?: string;
	description?: string;
	isFallbackAdapter?: boolean;
}

interface GpuAdapterLike {
	info?: GpuAdapterInfoLike;
	/** Older Chromium: on the adapter instead of `info`. */
	isFallbackAdapter?: boolean;
	/** Chromium < 127. */
	requestAdapterInfo?: () => Promise<GpuAdapterInfoLike>;
	limits: {
		maxBufferSize: number;
		maxStorageBufferBindingSize: number;
	};
}

interface GpuLike {
	requestAdapter(options?: {
		powerPreference?: "low-power" | "high-performance";
	}): Promise<GpuAdapterLike | null>;
}

const SOFTWARE_ADAPTER_PATTERN = /swiftshader|software|llvmpipe|lavapipe|microsoft basic render|\bwarp\b/i;

async function readAdapterInfo(adapter: GpuAdapterLike): Promise<GpuAdapterInfoLike> {
	if (adapter.info) {
		return adapter.info;
	}
	if (typeof adapter.requestAdapterInfo === "function") {
		try {
			return await adapter.requestAdapterInfo();
		} catch {
			return {};
		}
	}
	return {};
}

function describeAdapter(info: GpuAdapterInfoLike): string {
	return [info.vendor, info.architecture, info.device, info.description]
		.filter((part): part is string => typeof part === "string" && part.trim() !== "")
		.join(" ")
		.trim();
}

export async function probeWebGpu(
	nav: unknown = typeof navigator === "undefined" ? undefined : navigator
): Promise<WebGpuProbeResult> {
	const gpu = (nav as { gpu?: GpuLike } | undefined)?.gpu;
	if (!gpu || typeof gpu.requestAdapter !== "function") {
		return { ok: false, reason: "no-api" };
	}

	let adapter: GpuAdapterLike | null;
	try {
		adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
	} catch (error) {
		return {
			ok: false,
			reason: "error",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	if (!adapter) {
		return { ok: false, reason: "no-adapter" };
	}

	const info = await readAdapterInfo(adapter);
	const name = describeAdapter(info);
	if (
		info.isFallbackAdapter === true ||
		adapter.isFallbackAdapter === true ||
		SOFTWARE_ADAPTER_PATTERN.test(name)
	) {
		return { ok: false, reason: "software-adapter", detail: name || undefined };
	}

	const { maxBufferSize, maxStorageBufferBindingSize } = adapter.limits;
	if (
		!(maxBufferSize >= MIN_BUFFER_BYTES) ||
		!(maxStorageBufferBindingSize >= MIN_BUFFER_BYTES)
	) {
		return {
			ok: false,
			reason: "insufficient-limits",
			detail: `maxBufferSize=${maxBufferSize}, maxStorageBufferBindingSize=${maxStorageBufferBindingSize}`,
		};
	}

	return { ok: true, adapter: name };
}
