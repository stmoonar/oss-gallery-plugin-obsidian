/**
 * Image header, TIFF, LZW and PackBits writers for tests (not a test file itself).
 */

export type Part = number | string | Uint8Array;

export function bytes(...parts: Part[]): Uint8Array {
	const out: number[] = [];
	for (const p of parts) {
		if (typeof p === "string") {
			for (const ch of p) out.push(ch.charCodeAt(0));
		} else if (typeof p === "number") {
			out.push(p);
		} else {
			for (const v of p) out.push(v);
		}
	}
	return new Uint8Array(out);
}

export const be32 = (n: number): Uint8Array => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const be16 = (n: number): Uint8Array => new Uint8Array([n >>> 8, n & 255]);
export const le16 = (n: number): Uint8Array => new Uint8Array([n & 255, n >>> 8]);
export const le32 = (n: number): Uint8Array => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]);
export const le24 = (n: number): Uint8Array => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255]);

export function png(width: number, height: number): Uint8Array {
	return bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, be32(13), "IHDR", be32(width), be32(height), 1, 0, 0, 0, 0, 0, 0, 0, 0);
}

export function jpeg(width: number, height: number, before: Uint8Array = new Uint8Array()): Uint8Array {
	return bytes(0xff, 0xd8, before, 0xff, 0xc0, be16(11), 8, be16(height), be16(width), 1, 1, 0x11, 0, 0xff, 0xda, be16(8), 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0xd9);
}

export type TagSpec = [tag: number, type: number, values: number[] | Uint8Array];

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };

/** Little- or big-endian classic TIFF assembled piece by piece. */
export class TiffWriter {
	private bytes: number[] = [];
	private nextPointers = new Map<number, number>();

	constructor(readonly littleEndian = true) {
		this.bytes.push(...(littleEndian ? [0x49, 0x49, 42, 0] : [0x4d, 0x4d, 0, 42]), 0, 0, 0, 0);
	}

	get length(): number {
		return this.bytes.length;
	}

	private put(at: number, value: number, size: number): void {
		for (let i = 0; i < size; i++) {
			const shift = this.littleEndian ? i * 8 : (size - 1 - i) * 8;
			this.bytes[at + i] = Math.floor(value / 2 ** shift) & 0xff;
		}
	}

	private append(value: number, size: number): void {
		const at = this.bytes.length;
		for (let i = 0; i < size; i++) {
			this.bytes.push(0);
		}
		this.put(at, value, size);
	}

	private align(): void {
		if (this.bytes.length % 2) {
			this.bytes.push(0);
		}
	}

	/** Append raw data; returns its offset. */
	blob(data: Uint8Array): number {
		this.align();
		const at = this.bytes.length;
		this.bytes.push(...data);
		return at;
	}

	/** Append an IFD (values that don't fit inline go right after it); returns its offset. */
	ifd(tags: TagSpec[]): number {
		this.align();
		const sorted = [...tags].sort((a, b) => a[0] - b[0]);
		const at = this.bytes.length;
		this.append(sorted.length, 2);
		const pending: Array<{ field: number; type: number; values: number[] | Uint8Array }> = [];
		for (const [tag, type, values] of sorted) {
			this.append(tag, 2);
			this.append(type, 2);
			this.append(values.length, 4);
			const field = this.bytes.length;
			this.append(0, 4);
			const size = TYPE_SIZE[type] * values.length;
			if (size <= 4) {
				values.forEach((v, i) => this.put(field + i * TYPE_SIZE[type], v, TYPE_SIZE[type]));
			} else {
				pending.push({ field, type, values });
			}
		}
		const next = this.bytes.length;
		this.append(0, 4);
		this.nextPointers.set(at, next);
		for (const p of pending) {
			this.align();
			this.put(p.field, this.bytes.length, 4);
			for (const v of p.values) {
				this.append(v, TYPE_SIZE[p.type]);
			}
		}
		return at;
	}

	first(ifdOffset: number): this {
		this.put(4, ifdOffset, 4);
		return this;
	}

	link(from: number, to: number): this {
		this.put(this.nextPointers.get(from) as number, to, 4);
		return this;
	}

	build(): ArrayBuffer {
		return new Uint8Array(this.bytes).buffer;
	}
}

/** Uncompressed or compressed strips of one page. */
export function stripTiff(options: {
	width: number;
	height: number;
	samples: number;
	bits?: number;
	photometric?: number;
	compression?: number;
	predictor?: number;
	littleEndian?: boolean;
	strips: Uint8Array[];
	rowsPerStrip: number;
	extra?: TagSpec[];
}): ArrayBuffer {
	const w = new TiffWriter(options.littleEndian ?? true);
	const offsets = options.strips.map((s) => w.blob(s));
	const bits = options.bits ?? 8;
	const tags: TagSpec[] = [
		[256, 4, [options.width]],
		[257, 4, [options.height]],
		[258, 3, new Array<number>(options.samples).fill(bits)],
		[259, 3, [options.compression ?? 1]],
		[262, 3, [options.photometric ?? (options.samples >= 3 ? 2 : 1)]],
		[273, 4, offsets],
		[277, 3, [options.samples]],
		[278, 4, [options.rowsPerStrip]],
		[279, 4, options.strips.map((s) => s.length)],
	];
	if (options.predictor) {
		tags.push([317, 3, [options.predictor]]);
	}
	tags.push(...(options.extra ?? []));
	return w.first(w.ifd(tags)).build();
}

/** TIFF LZW encoder (MSB-first, early change), as libtiff writes it. */
export function lzwEncode(input: Uint8Array): Uint8Array {
	const out: number[] = [];
	let acc = 0;
	let bits = 0;
	let width = 9;
	const emit = (code: number): void => {
		acc = (acc << width) | code;
		bits += width;
		while (bits >= 8) {
			out.push((acc >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
		acc &= (1 << bits) - 1;
	};
	let dict = new Map<number, number>();
	let next = 258;
	const add = (key: number): void => {
		dict.set(key, next++);
		if (next === 4093) {
			emit(256);
			dict = new Map();
			next = 258;
			width = 9;
		} else if (next > (1 << width) - 1) {
			width++;
		}
	};
	emit(256);
	let prefix = -1;
	for (const byte of input) {
		if (prefix === -1) {
			prefix = byte;
			continue;
		}
		const key = prefix * 256 + byte;
		const found = dict.get(key);
		if (found !== undefined) {
			prefix = found;
			continue;
		}
		emit(prefix);
		add(key);
		prefix = byte;
	}
	if (prefix !== -1) {
		emit(prefix);
		next++;
		if (next > (1 << width) - 1 && width < 12) {
			width++;
		}
	}
	emit(257);
	if (bits > 0) {
		out.push((acc << (8 - bits)) & 0xff);
	}
	return new Uint8Array(out);
}

/** PackBits: literal runs only, plus a repeat run for bytes repeated 3+ times. */
export function packBitsEncode(input: Uint8Array): Uint8Array {
	const out: number[] = [];
	let i = 0;
	while (i < input.length) {
		let run = 1;
		while (i + run < input.length && run < 128 && input[i + run] === input[i]) {
			run++;
		}
		if (run >= 3) {
			out.push((1 - run) & 0xff, input[i]);
			i += run;
			continue;
		}
		const n = Math.min(128, input.length - i);
		out.push(n - 1, ...input.subarray(i, i + n));
		i += n;
	}
	return new Uint8Array(out);
}

/** Horizontal differencing (Predictor 2) for 8-bit samples. */
export function predict8(rows: Uint8Array, rowBytes: number, samples: number): Uint8Array {
	const out = rows.slice();
	for (let o = 0; o < out.length; o += rowBytes) {
		for (let j = rowBytes - 1; j >= samples; j--) {
			out[o + j] = (rows[o + j] - rows[o + j - samples]) & 0xff;
		}
	}
	return out;
}
