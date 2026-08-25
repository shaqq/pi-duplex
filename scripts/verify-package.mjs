import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const requiredFiles = ["LICENSE", "README.md", "package.json"];

function runNpm(args, cwd, env) {
	const result = spawnSync(npm, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	assert.equal(
		result.status,
		0,
		[result.stdout, result.stderr].filter(Boolean).join("\n"),
	);
	return result.stdout;
}

function archivePath(path) {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

assert.equal(manifest.name, "pi-duplex");
assert.deepEqual(manifest.pi?.extensions, ["./src/extension.ts"]);

const tempRoot = mkdtempSync(join(tmpdir(), "pi-duplex-package-"));
const packDir = join(tempRoot, "pack");
const installDir = join(tempRoot, "install");
const cacheDir = join(tempRoot, "npm-cache");
const agentDir = join(tempRoot, "agent");
const cwd = join(tempRoot, "workspace");

try {
	for (const directory of [packDir, installDir, cacheDir, agentDir, cwd]) {
		mkdirSync(directory, { recursive: true });
	}

	const env = {
		...process.env,
		npm_config_audit: "false",
		npm_config_cache: cacheDir,
		npm_config_dry_run: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
	const packedResults = JSON.parse(
		runNpm(
			["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
			packageRoot,
			env,
		),
	);
	assert.equal(packedResults.length, 1, "npm pack must produce one tarball");
	const packed = packedResults[0];
	assert.equal(typeof packed.filename, "string");

	const packedPaths = packed.files.map((file) => archivePath(file.path));
	assert.equal(new Set(packedPaths).size, packedPaths.length, "duplicate archive paths");
	for (const path of packedPaths) {
		assert.ok(
			requiredFiles.includes(path) || /^src\/(?:[^/]+\/)*[^/]+\.ts$/u.test(path),
			`unexpected file in package: ${path}`,
		);
	}
	for (const path of requiredFiles) {
		assert.ok(packedPaths.includes(path), `missing package file: ${path}`);
	}

	const extensionPath = archivePath(manifest.pi.extensions[0]);
	assert.ok(packedPaths.includes(extensionPath), "declared extension is not packaged");
	const tarball = join(packDir, packed.filename);
	assert.ok(existsSync(tarball), "npm pack did not create its tarball");

	runNpm(
		[
			"install",
			"--ignore-scripts",
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			"--no-package-lock",
			"--no-save",
			"--offline",
			"--prefix",
			installDir,
			tarball,
		],
		installDir,
		env,
	);

	const installedRoot = realpathSync(join(installDir, "node_modules", manifest.name));
	const installedManifest = JSON.parse(
		readFileSync(join(installedRoot, "package.json"), "utf8"),
	);
	assert.equal(installedManifest.name, manifest.name);
	assert.equal(installedManifest.version, manifest.version);

	const settings = SettingsManager.inMemory(
		{ packages: [installedRoot] },
		{ projectTrusted: false },
	);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const extensions = loader.getExtensions();
	assert.deepEqual(extensions.errors, []);
	assert.equal(extensions.extensions.length, 1);
	assert.equal(
		realpathSync(extensions.extensions[0].path),
		realpathSync(join(installedRoot, extensionPath)),
	);

	console.log(
		`Verified ${packed.filename}: ${packedPaths.length} files, isolated install, 1 Pi extension loaded.`,
	);
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
