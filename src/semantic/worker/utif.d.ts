// Minimal typings for utif 3.x (UTIF.js has no bundled types).
declare module "utif" {
	export function decode(buffer: ArrayBuffer | Uint8Array): object[];
	export function decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: object, ifds?: object[]): void;
	export function toRGBA8(ifd: object): Uint8Array;
}
