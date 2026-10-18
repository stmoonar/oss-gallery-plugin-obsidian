#!/usr/bin/env node
/**
 * Copy a local build into a test vault (development only).
 *
 *   pnpm run build
 *   pnpm run dev:install -- --vault <path-to-vault>   (or OBSIDIAN_TEST_VAULT=<path>)
 *   pnpm run dev:install -- --vault <path> --build    (build first)
 *
 * - Plugin files: main.js, manifest.json, styles.css go into the vault's
 *   plugin folder whose manifest.json has id "oss-gallery" (any folder name),
 *   else into .obsidian/plugins/oss-gallery/. data.json is never touched.
 * - Semantic search runtime: semantic-worker.js and the ONNX Runtime wasm/mjs
 *   go into <modelDir>/runtime/<plugin version>/, the layout
 *   src/semantic/ModelDownloadManager.ts expects, so they count as installed
 *   and the (possibly unpublished) GitHub release is never contacted. They
 *   are added to the install record so "Delete model" removes them too.
 *
 * modelDir: the vault's data.json `semantic.modelDir`, else the platform
 * default. Keep resolveModelDir/defaultModelDir in sync with
 * src/semantic/modelDir.ts.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const PLUGIN_ID = "oss-gallery";
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];
// Must match the constants in src/semantic/ModelDownloadManager.ts.
const INSTALL_RECORD_FILE = ".oss-gallery-files.json";
const LOCK_FILE = ".oss-gallery-download.lock";
const STALE_LOCK_MS = 2 * 60_000;
// Must match src/semantic/modelDir.ts.
const APP_DIR_NAME = "obsidian-oss-gallery";
const MODELS_DIR_NAME = "models";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");

function fail(message) {
	console.error(`dev-install: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { vault: process.env.OBSIDIAN_TEST_VAULT ?? "", build: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			continue;
		} else if (arg === "--vault") {
			opts.vault = argv[++i] ?? "";
		} else if (arg.startsWith("--vault=")) {
			opts.vault = arg.slice("--vault=".length);
		} else if (arg === "--build") {
			opts.build = true;
		} else if (arg === "-h" || arg === "--help") {
			console.log("Usage: pnpm run dev:install -- --vault <path> [--build]\n" +
				"       OBSIDIAN_TEST_VAULT=<path> pnpm run dev:install");
			process.exit(0);
		} else {
			fail(`unknown argument ${arg}`);
		}
	}
	return opts;
}

// --- modelDir (mirror of src/semantic/modelDir.ts) -------------------------

function pathFor(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}

function defaultAppDir(p) {
	const P = pathFor(p.platform);
	if (p.platform === "win32") {
		const localAppData = p.env.LOCALAPPDATA;
		const base = localAppData && P.isAbsolute(localAppData)
			? localAppData
			: P.join(p.homedir, "AppData", "Local");
		return P.join(base, APP_DIR_NAME);
	}
	if (p.platform === "darwin") {
		return P.join(p.homedir, "Library", "Application Support", APP_DIR_NAME);
	}
	const xdg = p.env.XDG_CACHE_HOME;
	const base = xdg && P.isAbsolute(xdg) ? xdg : P.join(p.homedir, ".cache");
	return P.join(base, APP_DIR_NAME);
}

function defaultModelDir(p) {
	return pathFor(p.platform).join(defaultAppDir(p), MODELS_DIR_NAME);
}

function resolveModelDir(configured, p) {
	const P = pathFor(p.platform);
	const trimmed = configured.trim();
	if (trimmed === "") {
		return { ok: true, dir: defaultModelDir(p), isDefault: true };
	}
	let candidate = trimmed;
	if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
		candidate = P.join(p.homedir, candidate.slice(1));
	}
	if (!P.isAbsolute(candidate)) {
		return { ok: false, error: "relative-path" };
	}
	const dir = P.normalize(candidate);
	return { ok: true, dir, isDefault: dir === P.normalize(defaultModelDir(p)) };
}

// --- helpers ----------------------------------------------------------------

function sha256(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** Runtime file list from the generated manifest the plugin was built with. */
function readGeneratedRuntimeFiles() {
	const file = path.join(repoRoot, "src", "semantic", "assets.generated.ts");
	const source = fs.readFileSync(file, "utf8");
	const re = /\{\s*file:\s*"([^"]+)",\s*size:\s*(\d+),\s*sha256:\s*"([0-9a-f]{64})"\s*\}/g;
	const files = [...source.matchAll(re)].map((m) => ({ file: m[1], size: Number(m[2]), sha256: m[3] }));
	if (files.length === 0) {
		fail(`no runtime files found in ${file}`);
	}
	return files;
}

function findPluginDir(vault) {
	const pluginsDir = path.join(vault, ".obsidian", "plugins");
	const matches = [];
	if (fs.existsSync(pluginsDir)) {
		for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}
			const manifest = readJson(path.join(pluginsDir, entry.name, "manifest.json"));
			if (manifest && manifest.id === PLUGIN_ID) {
				matches.push(path.join(pluginsDir, entry.name));
			}
		}
	}
	if (matches.length > 1) {
		fail(`several plugin folders have id "${PLUGIN_ID}":\n  ${matches.join("\n  ")}\nRemove the extra ones first.`);
	}
	return matches[0] ?? path.join(pluginsDir, PLUGIN_ID);
}

/** Copy via a temp file + rename, so Obsidian never sees a half-written file. */
function copyAtomic(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const tmp = `${dest}.dev-install.tmp`;
	fs.copyFileSync(src, tmp);
	fs.renameSync(tmp, dest);
}

function recordInstalled(modelDir, names) {
	const recordPath = path.join(modelDir, INSTALL_RECORD_FILE);
	const record = readJson(recordPath);
	const files = Array.isArray(record?.files) ? record.files.filter((f) => typeof f === "string") : [];
	const added = names.filter((n) => !files.includes(n));
	if (added.length === 0) {
		return 0;
	}
	files.push(...added);
	const tmp = `${recordPath}.tmp`;
	// Keep other fields (e.g. completedAt, which the plugin sets after a full install).
	fs.writeFileSync(tmp, JSON.stringify({ ...(record ?? {}), format: 1, files }, null, "\t"));
	fs.renameSync(tmp, recordPath);
	return added.length;
}

// --- main -------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (!opts.vault) {
	fail("no vault given. Use --vault <path> or set OBSIDIAN_TEST_VAULT.");
}
const vault = path.resolve(opts.vault);
if (!fs.existsSync(path.join(vault, ".obsidian"))) {
	fail(`${vault} is not an Obsidian vault (no .obsidian folder).`);
}

if (opts.build) {
	console.log("Building (pnpm run build)...");
	const result = spawnSync("pnpm", ["run", "build"], { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });
	if (result.status !== 0) {
		fail("build failed.");
	}
}

const runtimeFiles = readGeneratedRuntimeFiles();
for (const name of [...PLUGIN_FILES, ...runtimeFiles.map((f) => f.file)]) {
	if (!fs.existsSync(path.join(distDir, name))) {
		fail(`dist/${name} is missing. Run "pnpm run build" first (or pass --build).`);
	}
}
// A runtime that does not match the hashes compiled into main.js would show
// up as "needs repair", which is never what we want here.
for (const f of runtimeFiles) {
	const file = path.join(distDir, f.file);
	if (fs.statSync(file).size !== f.size || sha256(file) !== f.sha256) {
		fail(`dist/${f.file} does not match src/semantic/assets.generated.ts. Rebuild ("pnpm run build").`);
	}
}

const version = readJson(path.join(distDir, "manifest.json"))?.version;
if (typeof version !== "string" || version === "") {
	fail("dist/manifest.json has no version.");
}

// 1. Plugin files.
const pluginDir = findPluginDir(vault);
const dataJson = path.join(pluginDir, "data.json");
const dataHashBefore = fs.existsSync(dataJson) ? sha256(dataJson) : null;
console.log(`Plugin folder: ${pluginDir}${fs.existsSync(pluginDir) ? "" : " (new)"}`);
for (const name of PLUGIN_FILES) {
	copyAtomic(path.join(distDir, name), path.join(pluginDir, name));
	console.log(`  copied ${name}`);
}

// 2. Semantic runtime into the model directory.
const settings = readJson(dataJson);
const configuredDir = typeof settings?.semantic?.modelDir === "string" ? settings.semantic.modelDir : "";
const resolved = resolveModelDir(configuredDir, { platform: process.platform, env: process.env, homedir: os.homedir() });
if (!resolved.ok) {
	fail(`semantic.modelDir in data.json is not an absolute path: ${configuredDir}`);
}
const modelDir = resolved.dir;
const lockPath = path.join(modelDir, LOCK_FILE);
if (fs.existsSync(lockPath) && Date.now() - fs.statSync(lockPath).mtimeMs < STALE_LOCK_MS) {
	fail(`a download into ${modelDir} is running (${LOCK_FILE}). Try again when it is done.`);
}
const runtimeRel = `runtime/${version}`;
const runtimeDir = path.join(modelDir, ...runtimeRel.split("/"));
console.log(`Model directory: ${modelDir}${resolved.isDefault ? " (default)" : " (from data.json)"}`);
const names = [];
for (const f of runtimeFiles) {
	const dest = path.join(runtimeDir, f.file);
	const upToDate = fs.existsSync(dest) && fs.statSync(dest).size === f.size && sha256(dest) === f.sha256;
	if (!upToDate) {
		copyAtomic(path.join(distDir, f.file), dest);
	}
	names.push(`${runtimeRel}/${f.file}`);
	console.log(`  ${upToDate ? "unchanged" : "copied"} ${runtimeRel}/${f.file}`);
}
const added = recordInstalled(modelDir, names);
console.log(`  install record ${INSTALL_RECORD_FILE}: ${added} new entr${added === 1 ? "y" : "ies"}`);

const dataHashAfter = fs.existsSync(dataJson) ? sha256(dataJson) : null;
if (dataHashBefore !== dataHashAfter) {
	fail("data.json changed during the install. This should never happen.");
}
console.log(`data.json ${dataHashBefore ? "untouched" : "not present"}.`);
console.log(`\nInstalled oss-gallery ${version}. Reload the plugin in Obsidian ` +
	"(Settings → Community plugins: toggle it off and on, or run \"Reload app without saving\").");
console.log("Model files are not copied: download them from the settings page or copy them in by hand.");
