/**
 * Builds THIRD_PARTY_NOTICES.txt for the semantic search runtime release
 * assets (docs/semantic-search.md §8.5). The worker bundle is minified with
 * `legalComments: "none"`, so the licenses of everything bundled into it (and
 * of the copied ONNX Runtime wasm/mjs) are collected here instead, from the
 * esbuild metafile and each package's own license file.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** Packages that ship without a license file in their npm tarball. */
const FALLBACK_COPYRIGHT = {
	"onnxruntime-web": "Copyright (c) Microsoft Corporation.",
	"onnxruntime-common": "Copyright (c) Microsoft Corporation.",
};

/** Extra notes printed under a package. */
const PACKAGE_NOTES = {
	"onnxruntime-web":
		"The ONNX Runtime WebAssembly build (ort-wasm-simd-threaded.asyncify.wasm/.mjs) also contains\n" +
		"third-party components; their notices are published at\n" +
		"https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt",
};

const MIT_TEXT = (copyright) => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** `.../node_modules/@scope/name/dist/x.js` → `.../node_modules/@scope/name`. */
function packageDirOf(file) {
	const parts = resolve(file).split(sep);
	const i = parts.lastIndexOf("node_modules");
	if (i < 0 || i + 1 >= parts.length) {
		return null;
	}
	const nameParts = parts[i + 1].startsWith("@") ? 2 : 1;
	return parts.slice(0, i + 1 + nameParts).join(sep);
}

async function describePackage(dir) {
	const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	const files = (await readdir(dir)).filter((f) => LICENSE_FILE.test(f)).sort();
	let text = "";
	for (const f of files) {
		text += `${(await readFile(join(dir, f), "utf8")).replace(/\r\n/g, "\n").trim()}\n\n`;
	}
	if (!text) {
		const copyright = FALLBACK_COPYRIGHT[pkg.name];
		if (pkg.license === "MIT" && copyright) {
			text = `${MIT_TEXT(copyright).trim()}\n\n`;
		} else {
			throw new Error(`No license text found for ${pkg.name} (${dir})`);
		}
	}
	const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
	return {
		name: pkg.name,
		version: pkg.version,
		license: pkg.license ?? "UNKNOWN",
		homepage: pkg.homepage ?? repo ?? "",
		text: text.trim(),
	};
}

/**
 * Packages a prebuilt dist file has inlined (esbuild leaves
 * `// node_modules/<pkg>/...` path comments), resolved next to the package
 * (pnpm puts a package's dependencies in the same node_modules). The worker's
 * metafile only sees the dist file, e.g. transformers.web.js inlines
 * @huggingface/jinja and @huggingface/tokenizers.
 */
export async function inlinedPackageDirs(packageDir, distFile) {
	const code = await readFile(join(packageDir, distFile), "utf8");
	const names = new Set();
	// Greedy \S* = the last node_modules/ of the path (pnpm: .pnpm/<id>/node_modules/<pkg>).
	for (const m of code.matchAll(/^\/\/ \S*node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm)) {
		names.add(m[1]);
	}
	const parts = resolve(packageDir).split(sep);
	const root = parts.slice(0, parts.lastIndexOf("node_modules") + 1).join(sep);
	return [...names].map((name) => join(root, ...name.split("/")));
}

/**
 * Write the notices for the packages bundled into the worker (from the
 * esbuild metafile) plus `extraDirs` (packages whose files are copied as is).
 * Returns the package names, for the build log.
 */
export async function writeThirdPartyNotices(metafile, extraDirs, outPath) {
	const dirs = new Set(extraDirs);
	for (const input of Object.keys(metafile.inputs)) {
		const dir = packageDirOf(input.replace(/^[^:]+:/, ""));
		if (dir) {
			dirs.add(dir);
		}
	}
	const packages = [];
	const seen = new Set();
	for (const dir of dirs) {
		const p = await describePackage(dir);
		if (!seen.has(p.name)) {
			seen.add(p.name);
			packages.push(p);
		}
	}
	packages.sort((a, b) => a.name.localeCompare(b.name));
	const rule = "=".repeat(78);
	const header =
		"OSS Gallery for Obsidian: semantic search runtime\n" +
		"Third-party software notices\n\n" +
		"The release assets semantic-worker.js and ort-wasm-simd-threaded.asyncify.{wasm,mjs}\n" +
		"include the following third-party software. The model weights are downloaded\n" +
		"separately from Hugging Face (onnx-community/embeddinggemma-2-ONNX) under their own terms.\n\n" +
		packages.map((p) => `- ${p.name} ${p.version} (${p.license})`).join("\n") + "\n";
	const body = packages.map((p) => [
		rule,
		`${p.name} ${p.version}`,
		`License: ${p.license}${p.homepage ? `\nSource: ${p.homepage.replace(/^git\+/, "")}` : ""}`,
		PACKAGE_NOTES[p.name] ? `\n${PACKAGE_NOTES[p.name]}` : "",
		rule,
		"",
		p.text,
		"",
	].filter((line, i) => i !== 3 || line !== "").join("\n"));
	await writeFile(outPath, `${header}\n${body.join("\n")}`);
	return packages.map((p) => `${p.name}@${p.version}`);
}
