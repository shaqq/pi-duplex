import {
	existsSync,
	globSync,
	readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ReleasePackageJson {
	name?: string;
	private?: boolean;
	keywords?: string[];
	license?: string;
	author?: string;
	repository?: { type?: string; url?: string };
	homepage?: string;
	bugs?: { url?: string };
	publishConfig?: {
		access?: string;
	};
	pi?: {
		extensions?: string[];
	};
	bin?: string | Record<string, string>;
	files?: string[];
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	devDependencies?: Record<string, string>;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, "package.json");
const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as ReleasePackageJson;

const HOST_IMPORT_VERSIONS = {
	"@earendil-works/pi-ai": "0.84.3",
	"@earendil-works/pi-coding-agent": "0.84.3",
	"@earendil-works/pi-tui": "0.84.3",
	typebox: "1.3.15",
} as const;

function normalizePackagePath(path: string): string {
	return path.replace(/^\.\//, "").replaceAll("\\", "/").replace(/\/$/, "");
}

function packageFilesInclude(path: string, files: readonly string[]): boolean {
	const normalizedPath = normalizePackagePath(path);
	return files.some((entry) => {
		const normalizedEntry = normalizePackagePath(entry);
		const matches = globSync(normalizedEntry, { cwd: PACKAGE_ROOT });
		return (
			normalizedPath === normalizedEntry ||
			normalizedPath.startsWith(`${normalizedEntry}/`) ||
			matches.some((match) => normalizePackagePath(match) === normalizedPath)
		);
	});
}

describe("published Pi package contract", () => {
	it("declares a public, licensed Pi extension package", () => {
		expect(packageJson.name).toBe("pi-duplex");
		expect(packageJson.private).not.toBe(true);
		expect(packageJson.publishConfig).toEqual(
			expect.objectContaining({ access: "public" }),
		);
		expect(packageJson.keywords).toContain("pi-package");
		expect(packageJson.license?.trim().length).toBeGreaterThan(0);
		expect(packageJson.pi?.extensions).toEqual(["./src/extension.ts"]);
		expect(existsSync(join(PACKAGE_ROOT, "LICENSE"))).toBe(true);
		expect(packageJson.author).toBe("shaqq");
		expect(packageJson.repository).toEqual({
			type: "git",
			url: "git+https://github.com/shaqq/pi-duplex.git",
		});
		expect(packageJson.homepage).toBe("https://github.com/shaqq/pi-duplex#readme");
		expect(packageJson.bugs?.url).toBe("https://github.com/shaqq/pi-duplex/issues");
	});

	it.each(Object.entries(HOST_IMPORT_VERSIONS))(
		"declares %s as an optional host peer and an exact development dependency",
		(packageName, developmentVersion) => {
			expect(packageJson.dependencies?.[packageName]).toBeUndefined();
			expect(packageJson.peerDependencies?.[packageName]).toBe("*");
			expect(packageJson.peerDependenciesMeta?.[packageName]?.optional).toBe(true);
			expect(packageJson.devDependencies?.[packageName]).toBe(developmentVersion);
		},
	);

	it("ships every declared local package entrypoint", () => {
		const extensionPaths = packageJson.pi?.extensions ?? [];
		const packageFiles = packageJson.files ?? [];

		expect(extensionPaths).not.toHaveLength(0);
		expect(packageJson.bin).toBeUndefined();
		expect(packageFiles).not.toHaveLength(0);

		for (const declaredPath of extensionPaths) {
			expect(
				existsSync(resolve(PACKAGE_ROOT, declaredPath)),
				`Expected declared package path ${declaredPath} to exist`,
			).toBe(true);
		}
		for (const packageFile of packageFiles) {
			expect(
				globSync(normalizePackagePath(packageFile), { cwd: PACKAGE_ROOT }).length,
				`Expected package files entry ${packageFile} to match at least one path`,
			).toBeGreaterThan(0);
		}

		for (const entrypoint of extensionPaths) {
			expect(
				packageFilesInclude(entrypoint, packageFiles),
				`Expected the files allowlist to include ${entrypoint}`,
			).toBe(true);
		}
	});

});
