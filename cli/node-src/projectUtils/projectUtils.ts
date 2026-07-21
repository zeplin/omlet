import { exec as execWithCallback } from "child_process";
import glob from "fast-glob";
import findRoot from "find-root";
import { promises as fs } from "fs";
import { type TsConfigJson, getTsconfig, parseTsconfig } from "get-tsconfig";
import yaml from "js-yaml";
import JSON5 from "json5";
import { parse as parseJSONC } from "jsonc-parser";
import micromatch from "micromatch";
import upath from "upath";
import util from "util";

import { type Config, type PackageConfig } from "../config";
import { CliError } from "../error";
import { normalizeTrimPath, listDir, pathExists, readIfExists } from "../fileUtils";
import { logError, logger } from "../logger";

import { findNxWorkspacePaths, readNxConfig, readNxProject } from "./nxUtils/nxUtils";
import { type Package } from "./package";
import { type ExportsValue, type PackageJson, isExportCondition, isEsModuleCondition } from "./packageJson";
import { PathResolutionEntryType, PathResolutionMap } from "./pathResolutionMap";
import { type TsConfigInfo } from "./tsConfigInfo";
import { validate, type ResolutionConfigIssue, ResolutionConfigIssueLevel, InvalidProjectSetup } from "./validator";

const exec = util.promisify(execWithCallback);

function findWorkspacePaths(pathPatterns: string[], cwd: string): Promise<string[]> {
    return glob(pathPatterns, { cwd, onlyDirectories: true, ignore: ["**/node_modules/**"] });
}

export class NoProjectFound extends CliError {
    readonly path: string;
    constructor(path: string) {
        super("Could not find package.json", { context: { path } });
        this.path = path;
    }
}

export class CannotLoadTSConfig extends CliError {
    readonly detail: string;
    readonly path: string;

    constructor(data: { path: string; detail: string; }) {
        super("Could not find tsconfig.json", { context: data });

        this.detail = data.detail;
        this.path = data.path;
    }
}

enum MonorepoType {
    Yarn = "yarn",
    PNPM = "pnpm",
    Lerna = "lerna",
    Bolt = "bolt",
    Nx = "nx",
}

interface WorkspacesResult {
    type?: MonorepoType;
    workspacePaths: string[];
}

interface PnpmWorkspaceConfig {
    packages: string[];
}

async function readPnpmWorkspaceConfig(repoPath: string): Promise<PnpmWorkspaceConfig | undefined> {
    const pnpmContent = await readIfExists(upath.join(repoPath, "pnpm-workspace.yaml"))
        ?? await readIfExists(upath.join(repoPath, "pnpm-workspace.yml"));

    if (pnpmContent) {
        return yaml.load(pnpmContent) as PnpmWorkspaceConfig;
    }
}

interface LernaConfig {
    packages: string[];
}

async function readLernaConfig(repoPath: string): Promise<LernaConfig | undefined> {
    const lernaConfig = await readIfExists(upath.join(repoPath, "lerna.json"));

    if (lernaConfig) {
        return JSON.parse(lernaConfig) as LernaConfig;
    }
}

export class ProjectSetupResolver {
    private readonly absRepoRoot: string;
    public readonly userConfig: Config;
    public readonly rootPackage: Package;
    public readonly packages: Package[];
    private globCache: Record<string, string[]>;
    private scannedFileIndex: string[];

    private constructor(absRepoRoot: string, rootPackage: Package, userConfig: Config, fileIndex: string[]) {
        this.absRepoRoot = absRepoRoot;
        this.rootPackage = rootPackage;
        this.packages = [];
        this.userConfig = userConfig;
        this.globCache = {};
        this.scannedFileIndex = fileIndex;
    }

    static async create(absRepoRoot: string, rootPackagePath: string, config: Config) {
        const packageJsonPath = upath.join(rootPackagePath, "package.json");
        if (!await pathExists(packageJsonPath)) {
            throw new NoProjectFound(upath.dirname(packageJsonPath));
        }

        const rootPackage = await ProjectSetupResolver.readPackage(packageJsonPath, config.tsconfigPath);
        const fileIndex = await glob(config.include, { cwd: rootPackagePath, ignore: config.ignore, suppressErrors: true });
        const resolver = new ProjectSetupResolver(
            absRepoRoot,
            rootPackage,
            config,
            fileIndex
        );

        await resolver.readPackages();

        return resolver;
    }

    resolveAbsolutePath(...args: string[]) {
        return upath.resolve(this.absRepoRoot, this.rootPackage.path, ...args);
    }

    relativeProjectPath(otherPath: string) {
        return upath.relative(this.rootPackage.path, otherPath);
    }

    get projectRoot() {
        return this.resolveAbsolutePath();
    }

    static async readTsConfig(tsconfigPath: string): Promise<TsConfigInfo | undefined> {
        if (!await pathExists(tsconfigPath)) {
            return;
        }

        try {
            if ((await fs.lstat(tsconfigPath)).isFile()) {
                return {
                    config: parseTsconfig(tsconfigPath),
                    path: tsconfigPath,
                };
            }

            return getTsconfig(tsconfigPath) ?? undefined;
        } catch (err) {
            throw new CannotLoadTSConfig({ path: tsconfigPath, detail: (err as Error).message });
        }
    }

    static async readPackage(packageJsonPath: string, tsConfigPath?: string): Promise<Package> {
        const pkgJsonContent = await fs.readFile(packageJsonPath, "utf8");
        const pkgJson = JSON5.parse<PackageJson>(pkgJsonContent);
        const packagePath = upath.dirname(packageJsonPath);
        const tsconfig = await ProjectSetupResolver.readTsConfig(tsConfigPath ?? upath.join(packagePath, "tsconfig.json"));

        return {
            name: pkgJson.name ?? "root",
            version: pkgJson.version ?? "0.0.0",
            path: packagePath,
            info: pkgJson,
            tsconfig,
            aliases: new PathResolutionMap(PathResolutionEntryType.Alias),
            importMap: new PathResolutionMap(PathResolutionEntryType.Import),
            exportMap: new PathResolutionMap(PathResolutionEntryType.Export),
            dependencies: new Set(),
        };
    }

    static async readNxProject(rootPath: string, packagePath: string): Promise<Package> {
        const tsconfig = await ProjectSetupResolver.readTsConfig(upath.join(packagePath, "tsconfig.json"));

        return readNxProject(rootPath, packagePath, tsconfig);
    }

    static async findWorkspaces(root: Package): Promise<WorkspacesResult> {
        const projectRoot = root.path;
        const workspaces = root.info.workspaces;
        if (workspaces && "packages" in workspaces) {
            const workspacePaths = await findWorkspacePaths(workspaces.packages, projectRoot);

            return {
                type: MonorepoType.Yarn,
                workspacePaths,
            };
        }

        if (workspaces) {
            const workspacePaths = await findWorkspacePaths(workspaces, projectRoot);

            return {
                type: MonorepoType.Yarn,
                workspacePaths,
            };
        }

        const pnpmConfig = await readPnpmWorkspaceConfig(projectRoot);
        if (pnpmConfig && pnpmConfig.packages) {
            const workspacePaths = await findWorkspacePaths(pnpmConfig.packages, projectRoot);

            return {
                type: MonorepoType.PNPM,
                workspacePaths,
            };
        }

        const lernaConfig = await readLernaConfig(projectRoot);
        if (lernaConfig && lernaConfig.packages) {
            const workspacePaths = await findWorkspacePaths(lernaConfig.packages, projectRoot);

            return {
                type: MonorepoType.Lerna,
                workspacePaths,
            };
        }

        if (root.info.bolt) {
            const workspacePaths = await findWorkspacePaths((root.info.bolt as { workspaces: string[]; }).workspaces, projectRoot);

            return {
                type: MonorepoType.Bolt,
                workspacePaths,
            };
        }

        const nxConfig = await readNxConfig(projectRoot);
        if (nxConfig) {
            const workspacePaths = await findNxWorkspacePaths(projectRoot);

            return {
                type: MonorepoType.Nx,
                workspacePaths,
            };
        }

        return { workspacePaths: [] };
    }

    findPackageByName(name: string): Package | undefined {
        if (this.rootPackage.name === name) {
            return this.rootPackage;
        }

        return this.packages.find(p => p.name === name);
    }

    findPackageByPath(packagePath: string): Package | undefined {
        const absPath = this.resolveAbsolutePath(packagePath);

        if (this.rootPackage.path === absPath) {
            return this.rootPackage;
        }

        return this.packages.find(p => p.path === absPath);
    }

    getPackageConfig(name: string): PackageConfig | undefined {
        if (this.rootPackage.name === name) {
            const { tsconfigPath, aliases, exports } = this.userConfig;

            return {
                tsconfigPath,
                exports,
                aliases,
            };
        }

        return this.userConfig.workspaces?.[name];
    }

    async findGlobMatchesInProject(patterns: string[], globBase?: string) {
        const globRoot = globBase ? this.resolveAbsolutePath(globBase) : this.projectRoot;
        const cacheKey = `${globRoot}:${patterns.sort().join(",")}`;
        if (this.globCache[cacheKey]) {
            return this.globCache[cacheKey];
        }

        const matches = (await glob(patterns, { cwd: globRoot, ignore: ["**/node_modules/**"], suppressErrors: true })).map(fileRelPath =>
            upath.relative(
                this.projectRoot,
                upath.resolve(globRoot, fileRelPath)
            )
        );

        this.globCache[cacheKey] = matches;

        return matches;
    }

    async hasGlobMatchesInProject(patterns: string[], globBase?: string) {
        return (await this.findGlobMatchesInProject(patterns, globBase)).length > 0;
    }

    async isGlobIncluded(patterns: string[]) {
        return micromatch.some(this.scannedFileIndex, patterns);
    }

    async readTypescriptAliases(pkg: Package): Promise<PathResolutionMap> {
        const isPathsInherited = async (tsconfigInfo: TsConfigInfo) => {
            const tsConfigFileContent = await readIfExists(tsconfigInfo.path);
            if (!tsConfigFileContent) {
                return false;
            }

            const rawTsConfig = parseJSONC(tsConfigFileContent) as TsConfigJson;
            return tsconfigInfo.config.compilerOptions?.paths && !rawTsConfig.compilerOptions?.paths;
        };

        const aliases: PathResolutionMap = new PathResolutionMap(PathResolutionEntryType.Alias);
        if (!pkg.tsconfig) {
            return aliases;
        }

        const { config: tsConfig, path: tsConfigPath } = pkg.tsconfig;
        if (!tsConfig.compilerOptions?.baseUrl && !tsConfig.compilerOptions?.paths) {
            return aliases;
        }

        // If compilerOptions.paths is inherited from one of the base config files,
        // get-tsconfig resolves those paths in "paths" relative to the input config file path
        // Otherwise, "paths" remains unchanged so they need to be resolved relative to `join(configPath, baseUrl)`
        const configBaseUrl = this.relativeProjectPath(upath.join(upath.dirname(tsConfigPath), tsConfig.compilerOptions.baseUrl ?? "."));
        const pathsBaseUrl = await isPathsInherited(pkg.tsconfig)
            ? this.relativeProjectPath(upath.dirname(tsConfigPath))
            : configBaseUrl;

        if (tsConfig.compilerOptions.paths) {
            for (const [alias, paths] of Object.entries(tsConfig.compilerOptions.paths)) {
                const patterns = paths.map(p => upath.join(pathsBaseUrl, p));
                if (await this.hasGlobMatchesInProject(patterns.flatMap(p => starPatternToGlob(p, true)))) {
                    aliases.addMapping(alias, patterns, tsConfigPath);
                }
            }
        }

        // Typescript compiler allows import directly from the baseUrl location
        // This section adds alias mapping for files and directories under baseUrl
        // Only files and directories that have matching files included in the scan are added
        if (tsConfig.compilerOptions.baseUrl) {
            const basePath = this.resolveAbsolutePath(configBaseUrl);
            const entries = await listDir(basePath);

            for (const entry of entries) {
                const name = entry.name;
                const pathInProject = upath.join(configBaseUrl, name);

                if (name.startsWith(".")) {
                    continue;
                } else if (entry.isDirectory() && await this.hasGlobMatchesInProject([upath.join(pathInProject, "**", "*.{js,jsx,ts,tsx}")])) {
                    aliases.addMapping(upath.join(name, "*"), upath.join(configBaseUrl, name, "*"), tsConfigPath);
                    if (await this.hasGlobMatchesInProject([upath.join(pathInProject, "index.{js,jsx,ts,tsx}")])) {
                        aliases.addMapping(name, upath.join(configBaseUrl, name), tsConfigPath);
                    }
                } else if (entry.isFile() && /\.[jt]sx?$/.test(name) && await this.hasGlobMatchesInProject([pathInProject])) {
                    aliases.addMapping(name, upath.join(configBaseUrl, name), tsConfigPath);
                }
            }
        }

        return aliases;
    }

    async readImportMap(pkg: Package): Promise<PathResolutionMap> {
        const entrySource = upath.join(pkg.path, "package.json");

        const readDependencyMapping = async (dependencies: Record<string, string>) => {
            const mapping: PathResolutionMap = new PathResolutionMap(PathResolutionEntryType.Import);

            for (const [depName, depDefinition] of Object.entries(dependencies)) {
                let depPackage;

                if (depDefinition.startsWith("workspace:")) {
                    /*
                      Workspace protocol can have the following values:
                        - "dep-v": "workspace:1.0.0"
                        - "dep-w": "workspace:*"
                        - "dep-x": "workspace:^"
                        - "dep-y": "workspace:~"
                        - "dep-z": "workspace:path/to/dep-z"

                      In case of "~", "^", "*", we should match the package having the same name with the dependency.
                      In case a path is specified, then this dependency should resolve to the package located at the path.
                    */
                    const specifier = depDefinition.replace(/^workspace:/, "");
                    if (/^[\^~*0-9]/.test(specifier)) {
                        depPackage = this.findPackageByName(depName);
                    } else {
                        depPackage = this.findPackageByPath(specifier);
                    }
                } else {
                    depPackage = this.findPackageByName(depName);
                }

                if (!depPackage) {
                    continue;
                }

                mapping.merge(await this.getImportMapForPackageEntryPoints(depPackage));
            }

            return mapping;
        };

        const importMap: PathResolutionMap = new PathResolutionMap(PathResolutionEntryType.Import);

        for (const [depName, depDefinition] of Object.entries(pkg.info.dependencies ?? {}).concat(Object.entries(pkg.info.devDependencies ?? {}))) {
            if (depDefinition.startsWith("npm:")) {
                const targetPackageName = depDefinition
                    .replace(/^npm:/, "")
                    .replace(/@[^@]+$/, "");

                importMap.addMapping(depName, targetPackageName, entrySource);
            }
        }

        const pkgPath = this.relativeProjectPath(pkg.path);
        importMap.addMapping(`${pkg.name}/*`, normalizeTrimPath(upath.join(pkgPath, "*")), entrySource);

        const entryPoint = pkg.exportMap.getEntry(".")?.patterns[0];
        if (entryPoint) {
            const pattern = upath.join(pkgPath, entryPoint);
            if (await this.hasGlobMatchesInProject(starPatternToGlob(pattern, true))) {
                importMap.addMapping(pkg.name, upath.join(pkgPath, entryPoint), entrySource);
            }
        }

        if (pkg.info.devDependencies) {
            importMap.merge(await readDependencyMapping(pkg.info.devDependencies));
        }

        if (pkg.info.dependencies) {
            importMap.merge(await readDependencyMapping(pkg.info.dependencies));
        }

        return importMap;
    }

    async getImportMapForPackageEntryPoints(pkg: Package) {
        const mapping: PathResolutionMap = new PathResolutionMap(PathResolutionEntryType.Import);
        const pkgPath = this.relativeProjectPath(pkg.path);
        const entrySource = upath.join(pkg.path, "package.json");

        mapping.addMapping(`${pkg.name}/*`, `${pkgPath}/*`, entrySource);

        for (const entry of pkg.exportMap.entries()) {
            const patterns = entry.patterns.map(pat => upath.join(pkgPath, pat));
            const globPatterns = patterns.flatMap(pat => starPatternToGlob(pat, true));
            if (await this.hasGlobMatchesInProject(globPatterns)) {
                mapping.addMapping(upath.join(pkg.name, entry.name), patterns, entrySource);
            }
        }

        return mapping;
    }

    async readRootPackageImportMap() {
        const importMap = await this.readImportMap(this.rootPackage);

        // Add mappings for monorepo packages since those packages can be used without being listed as a dependency
        for (const pkg of this.packages) {
            importMap.merge(await this.getImportMapForPackageEntryPoints(pkg));
        }

        return importMap;
    }

    async readPackageAliases(pkg: Package): Promise<PathResolutionMap> {
        const packageAliases = new PathResolutionMap(PathResolutionEntryType.Alias);
        const typescriptAliases = await this.readTypescriptAliases(pkg);
        const configAliases = this.getPackageConfig(pkg.name)?.aliases;

        if (configAliases) {
            const entrySource = this.userConfig.configPath ? this.resolveAbsolutePath(this.userConfig.configPath) : "none";
            for (const [name, paths] of Object.entries(configAliases)) {
                packageAliases.addMapping(name, paths.map(normalizeTrimPath), entrySource);
            }
        }

        return packageAliases.merge(typescriptAliases);
    }

    private async readExportMap(pkg: Package) {
        const exportMap = new PathResolutionMap(PathResolutionEntryType.Export);

        const { rootDir, outDir } = (() => {
            let { rootDir, outDir } = pkg.tsconfig?.config?.compilerOptions ?? {};
            const tsConfigPath = pkg.tsconfig?.path && this.relativeProjectPath(upath.dirname(pkg.tsconfig.path));

            if (rootDir && outDir && tsConfigPath) {
                const configPathRelToPackage = upath.relative(this.relativeProjectPath(pkg.path), tsConfigPath);
                rootDir = upath.join(configPathRelToPackage, rootDir);
                outDir = upath.join(configPathRelToPackage, outDir);
            }
            return { rootDir, outDir };
        })() ?? {};

        const rewritePath = (inputPath: string) => {
            let formattedPath = normalizeTrimPath(inputPath);

            if (rootDir && outDir) {
                formattedPath = formattedPath.replace(
                    new RegExp(`^${normalizeTrimPath(outDir)}/`),
                    `${normalizeTrimPath(rootDir)}/`
                );
            }

            return formattedPath.replace(/\.[cm]?js$/, ".ts");
        };

        const getExportPaths = (exportsValue: ExportsValue): string[] | null => {
            if (typeof exportsValue === "string") {
                return [exportsValue];
            }

            if (Array.isArray(exportsValue)) {
                return exportsValue;
            }

            // Reference: https://nodejs.org/api/packages.html#conditional-exports
            // Within the "exports" object, key order is significant. During condition matching,
            // earlier entries have higher priority and take precedence over later entries.
            // The general rule is that conditions should be from most specific to least specific in object order.
            // Conditions may nest (e.g. `"import": { "types": ..., "default": ... }`), so each
            // ES-module condition is resolved recursively down to its string path(s).
            const conditionalExports = Object.entries(exportsValue)
                .filter(([condition]) => isEsModuleCondition(condition))
                .flatMap(([, value]) => getExportPaths(value) ?? []);

            if (conditionalExports.length !== 0) {
                return conditionalExports;
            }

            return null;
        };

        async function findPackageMainEntryPoints() {
            async function findIndexEntry(path: string) {
                const entries = await listDir(path);
                for (const entry of entries) {
                    const name = entry.name;

                    if (entry.isFile() && /index\.[jt]sx?$/.test(name)) {
                        return name;
                    }
                }
            }

            if (pkg.info.exports) {
                const exportPaths = getExportPaths(pkg.info.exports);
                if (exportPaths !== null) {
                    return exportPaths.map(rewritePath);
                }

                if (typeof pkg.info.exports === "object" && "." in pkg.info.exports) {
                    const rootExport = pkg.info.exports["."];
                    const exportPaths = getExportPaths(rootExport);
                    if (exportPaths !== null) {
                        return exportPaths.map(rewritePath);
                    }
                }
            }

            if (pkg.info.main) {
                return [rewritePath(pkg.info.main)];
            }

            const indexEntry = await findIndexEntry(pkg.path);
            if (indexEntry) {
                return [indexEntry];
            }

            const srcPath = upath.join(pkg.path, "src");
            if (await pathExists(srcPath)) {
                const indexEntry = await findIndexEntry(srcPath);
                if (indexEntry) {
                    return [upath.join("src", indexEntry)];
                }
            }
        }

        const sourceUserConfig = this.userConfig.configPath ? this.resolveAbsolutePath(this.userConfig.configPath) : "none";
        const sourcePackageJson = upath.join(pkg.path, "package.json");
        const sourceTSConfig = pkg.tsconfig?.path ? upath.dirname(pkg.tsconfig.path) : "none";

        const exportsInConfig = this.getPackageConfig(pkg.name)?.exports;
        const mainsInConfig = exportsInConfig?.["."];
        if (mainsInConfig) {
            exportMap.addMapping(".", mainsInConfig.map(rewritePath), sourceUserConfig);
        } else {
            const mainEntries = await findPackageMainEntryPoints();
            if (mainEntries) {
                exportMap.addMapping(".", mainEntries, sourcePackageJson);
            }
        }

        if (rootDir && outDir) {
            exportMap.addMapping(
                normalizeTrimPath(upath.join(outDir, "*")),
                normalizeTrimPath(upath.join(rootDir, "*")),
                sourceTSConfig
            );
        }

        if (exportsInConfig) {
            for (const [name, entries] of Object.entries(exportsInConfig)) {
                exportMap.addMapping(normalizeTrimPath(name), entries.map(rewritePath), sourceUserConfig);
            }
        }

        const pkgJsonExports = pkg.info.exports;
        if (pkgJsonExports && typeof pkgJsonExports === "object" && !Array.isArray(pkgJsonExports)) {
            for (const [originalName, originalEntry] of Object.entries(pkgJsonExports)) {
                const name = normalizeTrimPath(originalName);
                if (exportMap.hasEntry(name) || isExportCondition(name)) {
                    continue;
                }

                const exportPaths = getExportPaths(originalEntry);

                if (exportPaths !== null) {
                    exportMap.addMapping(name, exportPaths.map(rewritePath), sourcePackageJson);
                }
            }
        }

        return exportMap;
    }

    readDependencies(pkg: PackageJson): Set<string> {
        const resolveDependency = (dep: string, version: string): string | undefined => {
            // Ignore workspace protocol dependencies
            // We consider all packages in the monorepo as dependencies of each other
            if (version.startsWith("workspace:")) {
                return undefined;
            }

            if (version.startsWith("npm:")) {
                return version.replace(/^npm:/, "").replace(/@[^@]+$/, "");
            }

            return dep;
        };

        const resolveDependencies = (deps: Record<string, string>): Set<string> => {
            return new Set([
                ...Object.entries(deps).map(([dep, version]) => resolveDependency(dep, version)).filter((d): d is string => Boolean(d)),
            ]);
        };

        return new Set([
            ...resolveDependencies(pkg.dependencies ?? {}),
            ...resolveDependencies(pkg.devDependencies ?? {}),
            ...resolveDependencies(pkg.peerDependencies ?? {}),
        ]);
    }

    private async readPackages() {
        const { type, workspacePaths } = await ProjectSetupResolver.findWorkspaces(this.rootPackage);

        const pkgs = (
            await Promise.all(workspacePaths.map(async p => {
                if (type === MonorepoType.Nx) {
                    const worksapacePath = this.resolveAbsolutePath(p);

                    try {
                        return await ProjectSetupResolver.readNxProject(this.projectRoot, worksapacePath);
                    } catch (err) {
                        console.log("Cannot read nx project at", worksapacePath);
                    }
                } else {
                    const jsonPath = this.resolveAbsolutePath(upath.join(p, "package.json"));

                    if (await pathExists(jsonPath)) {
                        try {
                            const pkgJsonContent = await fs.readFile(jsonPath, "utf8");
                            const pkgJson = JSON5.parse<PackageJson>(pkgJsonContent);
                            const packageName = pkgJson.name ?? "root";

                            const workspaceConfig = this.userConfig.workspaces?.[packageName];
                            const tsconfigPath = workspaceConfig?.tsconfigPath
                                ? this.resolveAbsolutePath(upath.join(upath.dirname(jsonPath), workspaceConfig.tsconfigPath))
                                : undefined;

                            return await ProjectSetupResolver.readPackage(jsonPath, tsconfigPath);
                        } catch (err) {
                            console.log("Cannot read package at", jsonPath);
                        }
                    }
                }
            }))
        ).filter((p): p is Package => !!p);

        this.packages.push(...pkgs);

        // The order (exportMap -> importMap -> aliases) is important here.
        // It'd be better if we could remove this interdependent logic
        this.rootPackage.exportMap = await this.readExportMap(this.rootPackage);
        for (const pkg of this.packages) {
            pkg.exportMap = await this.readExportMap(pkg);
        }

        this.rootPackage.importMap = await this.readRootPackageImportMap();
        for (const pkg of this.packages) {
            pkg.importMap = await this.readImportMap(pkg);
        }

        this.rootPackage.aliases = await this.readPackageAliases(this.rootPackage);
        for (const pkg of this.packages) {
            pkg.aliases = await this.readPackageAliases(pkg);
        }

        this.rootPackage.dependencies = this.readDependencies(this.rootPackage.info);
        for (const pkg of this.packages) {
            pkg.dependencies = this.readDependencies(pkg.info);
        }
    }

    async isNpmDependency(packageName: string, sourcePackage: Package): Promise<boolean> {
        try {
            await exec(`npm ls ${packageName} --package-lock-only`, { cwd: sourcePackage.path });
            logger.debug(`Package ${packageName} is npm dependency of ${sourcePackage.name}`);
            return true;
        } catch (error) {
            logger.debug(`Package ${packageName} is not npm dependency of ${sourcePackage.name} - error:${error}`);
            return false;
        }
    }

    async isYarnDependency(packageName: string, sourcePackage: Package): Promise<boolean> {
        try {
            const { stderr } = await exec(`yarn why ${packageName}`, { cwd: sourcePackage.path });
            // yarn v1 doesn't return exit code 1 when the package is not found
            // instead it prints a message to stderr
            const isDependency = stderr === "";
            if (isDependency) {
                logger.debug(`Package ${packageName} is yarn dependency of ${sourcePackage.name}`);
            } else {
                logger.debug(`Got error message from yarn for package ${packageName}: ${stderr}`);
            }
            return isDependency;
        } catch (error) {
            logger.debug(`Package ${packageName} is not yarn dependency of ${sourcePackage.name} - error:${error}`);
            return false;
        }
    }

    async isPnpmDependency(packageName: string, sourcePackage: Package): Promise<boolean> {
        try {
            const { stdout } = await exec(`pnpm list ${packageName} --depth Infinity`, { cwd: sourcePackage.path });
            const isDependency = stdout !== "";
            if (isDependency) {
                logger.debug(`Package ${packageName} is pnpm dependency of ${sourcePackage.name}`);
            } else {
                logger.debug(`Package ${packageName} is not pnpm dependency of ${sourcePackage.name}`);
            }
            return isDependency;
        } catch (error) {
            logger.debug(`Package ${packageName} is not pnpm dependency of ${sourcePackage.name} - error:${error}`);
            return false;
        }
    }

    async isValidDependency(packageName: string, sourcePackageName: string): Promise<boolean> {
        logger.debug(`Checking if ${packageName} is a valid dependency for ${sourcePackageName}`);
        const sourcePackage = this.findPackageByName(sourcePackageName);
        const dependencyPackage = this.findPackageByName(packageName);

        if (dependencyPackage) {
            logger.debug(`Found package ${packageName} in the project`);
            return true;
        }

        if (!sourcePackage) {
            logger.debug(`Source package ${sourcePackageName} not found in the project`);
            return false;
        }

        if (sourcePackage.dependencies.has(packageName)) {
            logger.debug(`Package ${packageName} is a direct dependency of ${sourcePackageName}`);
            return true;
        }

        logger.debug(`Checking if ${packageName} is an indirect dependency of ${sourcePackageName}`);
        return await this.isNpmDependency(packageName, sourcePackage)
            || await this.isYarnDependency(packageName, sourcePackage)
            || await this.isPnpmDependency(packageName, sourcePackage);
    }

    async getProjectSetup(failOnError: boolean): Promise<ProjectSetup> {
        const redactPackage = (p: Package) => {
            return {
                name: p.name,
                path: this.relativeProjectPath(p.path),
                version: p.version,
                aliases: Object.fromEntries(p.aliases.entries().map(entry => [entry.name, entry.patterns])),
                importMap: Object.fromEntries(p.importMap.entries().map(entry => [entry.name, entry.patterns])),
                exportMap: Object.fromEntries(p.exportMap.entries().map(entry => [entry.name, entry.patterns])),
            };
        };

        const setup: ProjectSetup = {
            root: redactPackage(this.rootPackage),
            packages: Object.fromEntries(this.packages.map(p => [p.name, redactPackage(p)])),
            absolutePath: this.rootPackage.path,
            isValidDependency: async (packageName, sourcePackageName) => {
                const result = await this.isValidDependency(packageName, sourcePackageName);
                if (sourcePackageName === this.rootPackage.name) {
                    return result;
                }

                // The package could be defined in the root package
                // check the root package as well
                return result || await this.isValidDependency(packageName, this.rootPackage.name);
            },
        };

        try {
            logger.debug("Validating project setup");

            await validate(setup, this);

            logger.debug("Validation completed");
        } catch (error) {
            if (error instanceof InvalidProjectSetup) {
                setup.issues = error.issues;

                logger.debug(`Validation issues found in the project setup: ${error.message}`);
                logger.debug(`Issues: ${JSON.stringify(error.issues, null, 2)}`);

                if (failOnError && error.level === ResolutionConfigIssueLevel.Error) {
                    throw error;
                }
            } else {
                logger.error("Unexpected error occured while validating project setup");
                logError(error as Error);
            }
        }

        return setup;
    }
}

export type PackageData = Omit<Package, "info" | "tsconfig" | "aliases" | "importMap" | "exportMap" | "dependencies"> & {
    aliases: Record<string, string[]>;
    importMap: Record<string, string[]>;
    exportMap: Record<string, string[]>;
};

export interface ProjectSetup {
    root: PackageData;
    packages: {
        [packageName: string]: PackageData;
    };
    absolutePath: string;
    issues?: ResolutionConfigIssue[];
    isValidDependency: (packageName: string, sourcePackageName: string) => Promise<boolean>;
}

export function getDefaultRoot(): string {
    try {
        return findRoot(process.cwd());
    } catch (error) {
        return process.cwd();
    }
}

export async function findParentProject(projectPath: string): Promise<string | null> {
    const parentPath = upath.join(projectPath, "..");
    try {
        const parentPackage = await ProjectSetupResolver.readPackage(upath.join(findRoot(parentPath), "package.json"));
        const { workspacePaths } = await ProjectSetupResolver.findWorkspaces(parentPackage);
        const relativePath = upath.relative(parentPackage.path, projectPath);
        if (workspacePaths.includes(relativePath)) {
            return parentPackage.path;
        }
        return null;
    } catch (e) {
        return null;
    }
}


export function starPatternToGlob(pattern: string, matchModulePaths = true) {
    let globPattern;
    if (/\*$/.test(pattern)) {
        globPattern = pattern.replace("*", "**/*");
    } else {
        globPattern = pattern.replace("*", "**");
    }

    // Following expansion are necessary to match alias/export targets like `path/to/module`.
    // These paths can correspond to:
    //  - The directory on that path
    //  - path/to/module.[jt]sx?
    //  - path/to/module/index.[jt]sx?
    if (matchModulePaths) {
        if (globPattern.endsWith("/index")) {
            return [globPattern, `${globPattern}.{tsx,ts,jsx,js}`];
        } else if (!/\.[tj]sx?$/.test(globPattern)) {
            return [globPattern, `${globPattern}.{tsx,ts,jsx,js}`, `${globPattern}/index.{tsx,ts,jsx,js}`];
        }
    }

    return [globPattern];
}
