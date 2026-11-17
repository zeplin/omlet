import * as clr from "colorette";
import { createWriteStream } from "fs";
import inquirer from "inquirer";
import os from "os";
import { performance } from "perf_hooks";
import { pipeline as pipelineCb } from "stream";
import upath from "upath";
import { promisify } from "util";

import {
    ApiError,
    ErrorResponseCode,
    type Workspace,
    getDefaultWorkspace,
    getWorkspace as getWorkspaceBySlug,
    initWorkspace,
    postAnalysis,
} from "./apiClient";
import { parse as parseNative, analyze as analyzeNative, analyzePartial as analyzePartialNative } from "./binding";
import { ciVendor } from "./ciUtils";
import {
    type Config,
    BASE_URL,
    GIT_HISTORY_LIMIT_DAYS,
    HTTP_PROXY_URL,
    loadConfig,
    ConfigError,
    WORKSPACE_SLUG,
} from "./config";
import { ConfigValidationError } from "./config/userConfig";
import { CliError } from "./error";
import { normalizeTrimPath, pathExists, resolvePath } from "./fileUtils";
import { CliHookError, initHooks } from "./hook";
import { toJsonStringStream } from "./jsonStream";
import { LogLevel, logger, getLogFilePath, logError } from "./logger";
import { getCliVersion } from "./npmUtils";
import { type ResolutionConfigIssue, type ProjectSetup, ResolutionConfigIssueType, CannotLoadTSConfig, NoProjectFound, InvalidProjectSetup, PathResolutionEntryType, ProjectSetupResolver, ResolutionConfigIssueLevel } from "./projectUtils";
import { type RepositoryInfo, getGitRoot, getRepoInfo } from "./repoUtils";
import { createSpinner } from "./spinner";
import { formatList, pluralize } from "./stringUtils";

const DRY_RUN_OUTPUT_PATH = upath.join(process.cwd(), "omlet.out.json");
const INDENT = "  ";
const SUPPORTED_FRAMEWORKS = ["React", "React Native"];

const pipeline = promisify(pipelineCb);

interface AnalyzeOptions {
    dryRun?: boolean;
    cliVersion: string;
    verifySetup: boolean;
    quiet: boolean;
    cliParams: {
        configPath?: string;
        include?: string[];
        ignore?: string[];
        tsconfigPath?: string;
        hookScript?: string;
    };
    failOnParseError?: boolean;
    showSummary: boolean;
}

interface InitCmdOptions {
    cliVersion: string;
    verifySetup: boolean;
    quiet: boolean;
}

type AnalyzeCmdOptions = Omit<AnalyzeOptions, "showSummary">;

export interface ModuleId {
    hash: string;
    path: string;
    mtype: "package" | "local";
    package_name: string;
}

export interface SymbolWithSource {
    source: ModuleId;
    symbol: string;
}

export interface ReferenceWithSource {
    source: ModuleId;
    reference: string;
}

interface NativeComponentDependencyNode {
    source: SymbolWithSource;
    id: string;
    name: string;
}

interface NativeCharacterPosition {
    line: number;
    column: number;
}

interface NativeComponentPropUsage {
    name: string;
    value: PropValue;
}

interface NativeComponentUsage {
    start: NativeCharacterPosition;
    end: NativeCharacterPosition;
    props: NativeComponentPropUsage[];
}

interface NativeComponentReference {
    usages: NativeComponentUsage[];
    trace: ReferenceWithSource[];
}

interface NativeComponentDependency {
    from: NativeComponentDependencyNode;
    to: NativeComponentDependencyNode;
    references: NativeComponentReference[];
}

export interface ComponentDependencyNode extends SymbolWithSource {
    id: string;
    name: string;
}

export interface CharacterPosition {
    line: number;
    column: number;
}

export interface ComponentPropUsage {
    name: string;
    value: PropValue;
}

export interface ComponentUsage {
    start: CharacterPosition;
    end: CharacterPosition;
    props: ComponentPropUsage[];
}

export interface ComponentReference {
    usages: ComponentUsage[];
    trace: SymbolWithSource[];
}

export interface ComponentDependency {
    from: ComponentDependencyNode;
    to: ComponentDependencyNode;
    references: ComponentReference[];
}

interface NativeComponentProp {
    name: string;
    default_value?: string;
    span: {
        start: NativeCharacterPosition;
        end: NativeCharacterPosition;
    };
}

interface NativeComponent {
    id: string;
    export_ids: string[];
    name: string;
    source: SymbolWithSource;
    created_at?: number;
    updated_at?: number;
    dependencies: NativeComponentDependency[];
    props: NativeComponentProp[];
    html_elements: string[];
    span?: {
        start: NativeCharacterPosition;
        end: NativeCharacterPosition;
    };
}

export interface Export {
    name: string;
    module_id: ModuleId;
    is_component: unknown;
    trace_to_declaration: ReferenceWithSource[];
    inferredType?: unknown;
    resolvedType?: unknown;
}

export interface AnalysisStats {
    num_of_components: number;
    num_of_modules: number;
    num_of_exports: number;
    num_of_dependencies: number;
    num_of_commits?: number;
    num_of_deltas?: number;
    analyze_duration_msec?: number;
    parse_duration_msec?: number;
    date_extraction_msec?: number;
    mem_usages: {
        before_scan_rss: number;
        after_file_dates_rss: number;
        after_project_setup_rss: number;
        after_parse_rss: number;
        after_analyze_rss: number;
    };
}

interface NativeGlobError {
    code: "GenericFailure";
    GlobError: {
        reason: string;
        root: string;
        pattern: string;
    };
}

interface NativeGitUtilError {
    code: "GenericFailure";
    GitUtilError: {
        reason: string;
        suggestion: string;
    };
}

interface NativeAliasParseError {
    code: "GenericFailure";
    AliasParseError: {
        reason: string;
        input: string;
    };
}

interface NativeTSParseError {
    code: "GenericFailure";
    TSParseError: {
        file: string;
        reason: string[];
    };
}

interface NativeAnalysisError {
    code: "GenericFailure";
    AnalysisError: {
        reason: string;
    };
}

interface NativeMpscError {
    code: "GenericFailure";
    MpscError: {
        reason: string;
    };
}

interface NativeErrorPayload {
    error: NativeGlobError | NativeAliasParseError | NativeTSParseError | NativeAnalysisError | NativeGitUtilError | NativeMpscError;
}

interface NativeAnalyzeResult {
    components: NativeComponent[];
    exports: Export[];
    errors: NativeTSParseError[];
    stats: AnalysisStats;
}

interface Module {
    source_path: string;
    id: ModuleId;
    exports: unknown[];
    scopes: unknown[];
    body: unknown[];
}

export enum ObjectPropType {
    KeyValue = "KeyValue",
    Shorthand = "Shorthand",
    Spread = "Spread",
}

export type ObjectProp = {
    type: ObjectPropType.KeyValue;
    key: string;
    value: PropValue;
} | {
    type: ObjectPropType.Shorthand;
    key: string;
} | {
    type: ObjectPropType.Spread;
    value: PropValue;
};

export enum PropValueType {
    String = "String",
    Number = "Number",
    Identifier = "Identifier",
    Bool = "Bool",
    Regex = "Regex",
    Null = "Null",
    JSXElement = "JSXElement",
    Function = "Function",
    Getter = "Getter",
    Setter = "Setter",
    Array = "Array",
    Object = "Object",
    Spread = "Spread",
    Member = "Member",
    This = "This",
    Super = "Super",
    TemplateLiteral = "TemplateLiteral",
    Expression = "Expression",
}

export type PropValue = {
    type: PropValueType.String | PropValueType.Identifier;
    value: string;
} | {
    type: PropValueType.Number;
    value: number;
} | {
    type: PropValueType.Bool;
    value: boolean;
} | {
    type: PropValueType.Regex;
    value: string;
    flags: string;
} | {
    type: PropValueType.Array;
    values: PropValue[];
} | {
    type: PropValueType.Spread;
    value: PropValue;
} | {
    type: PropValueType.Member;
    value: PropValue;
    property: PropValue;
} | {
    type: PropValueType.Object;
    props: ObjectProp[];
} | {
    type: PropValueType.Null | PropValueType.JSXElement | PropValueType.Function | PropValueType.Getter | PropValueType.Setter | PropValueType.This | PropValueType.Super | PropValueType.TemplateLiteral | PropValueType.Expression;
};

export interface Prop {
    name: string;
    default_value?: unknown;
    span: {
        start: CharacterPosition;
        end: CharacterPosition;
    };
}

export interface Component {
    id: string;
    export_ids: string[];
    name: string;
    package_name: string;
    created_at?: Date;
    updated_at?: Date;
    source: SymbolWithSource;
    dependencies: ComponentDependency[];
    props: Prop[];
    html_elements: string[];
    metadata?: Record<string, string | number | boolean | Date>;
    span?: {
        start: CharacterPosition;
        end: CharacterPosition;
    };
}

function transformDependency(nativeDep: NativeComponentDependency): ComponentDependency {
    function transformEdge(
        node: NativeComponentDependencyNode
    ): ComponentDependencyNode {
        return {
            ...node.source,
            name: node.name,
            id: node.id,
        };
    }

    return {
        from: transformEdge(nativeDep.from),
        to: transformEdge(nativeDep.to),
        references: nativeDep.references.map(({ usages, trace }) => ({
            usages,
            trace: trace.map(t => ({ symbol: t.reference, source: t.source })),
        })),
    };
}

function transformComponent(nativeComp: NativeComponent): Component {
    const sws = nativeComp.source;

    return ({
        ...nativeComp,
        package_name: sws.source.package_name,
        created_at: nativeComp.created_at ? new Date(nativeComp.created_at * 1000) : undefined,
        updated_at: nativeComp.updated_at ? new Date(nativeComp.updated_at * 1000) : undefined,
        dependencies: nativeComp.dependencies.map(transformDependency),
        props: nativeComp.props.map(({ name, default_value, span }) => ({
            name,
            default_value: default_value === undefined ? undefined : (JSON.parse(default_value) as PropValue),
            span,
        })),
        ...(nativeComp.span ? {
            span: {
                start: { line: nativeComp.span.start?.line, column: nativeComp.span.start?.column },
                end: { line: nativeComp.span.end?.line, column: nativeComp.span.end?.column },
            },
        } : {}),
    });
}

class TSParseError extends CliError {
    readonly reason: string[];
    readonly file: string;

    constructor(reason: string[], file: string) {
        super("Parse error");
        this.name = this.constructor.name;
        this.reason = reason;
        this.file = file;
    }
}

class AliasParseError extends CliError {
    readonly reason: string;
    readonly input: string;

    constructor(reason: string, input: string) {
        super("Alias config error", {
            context: { reason, input },
        });
        this.name = this.constructor.name;
        this.reason = reason;
        this.input = input;
    }
}

class GlobError extends CliError {
    readonly reason: string;
    readonly pattern: string;
    readonly root: string;

    constructor(reason: string, root: string, pattern: string) {
        super("Glob error", {
            context: { reason, root, pattern },
        });
        this.name = this.constructor.name;
        this.reason = reason;
        this.pattern = pattern;
        this.root = root;
    }
}

class GitUtilError extends CliError {
    readonly reason: string;
    readonly suggestion: string;

    constructor(reason: string, suggestion: string) {
        super("Git Util error", {
            context: { reason, suggestion },
        });
        this.name = this.constructor.name;
        this.reason = reason;
        this.suggestion = suggestion;
    }
}


class WorkspaceAlreadySetupError extends CliError {
    constructor() {
        super("Workspace has already been set up");
        this.name = this.constructor.name;
    }
}

class ParseErrorsFound extends CliError {
    constructor(count: number) {
        super("Modules failed to parse", {
            context: { count },
        });
        this.name = this.constructor.name;
    }
}

class AnalysisError extends CliError {
    readonly reason: string;

    constructor(reason: string) {
        super("Analysis error", {
            context: { reason },
        });
        this.name = this.constructor.name;
        this.reason = reason;
    }
}

class UnexpectedAnalysisError extends CliError {
    readonly reason: string;

    constructor(reason: string) {
        super("Unexpected error", {
            context: { reason },
        });
        this.name = this.constructor.name;
        this.reason = reason;
    }
}

class PathNotFound extends CliError {
    readonly path: string;
    constructor(path: string) {
        super("No such file or directory", {
            context: { path },
        });
        this.name = this.constructor.name;
        this.path = path;
    }
}

class NoGitRootFound extends CliError {
    readonly path: string;
    constructor(path: string) {
        super("Could not find git root", { context: { path } });
        this.path = path;
    }
}

class NoCommitFound extends CliError {
    readonly path: string;
    constructor(path: string) {
        super("Could not find commit in git root", { context: { path } });
        this.path = path;
    }
}

export class WorkspaceNotSetup extends CliError {
    constructor() {
        super("Workspace has not been been set up yet");
        this.name = this.constructor.name;
    }
}

export class NoModuleFound extends CliError {
    readonly projectRootPath: string;
    readonly config: Config;
    constructor(data: { projectRootPath: string; config: Config; }) {
        super("Could not find any module", { context: data });

        this.projectRootPath = data.projectRootPath;
        this.config = data.config;
    }
}

export class NoComponentFound extends CliError {
    readonly projectRootPath: string;
    readonly numberOfModules: number;
    readonly config: Config;
    constructor(data: { projectRootPath: string; config: Config; numberOfModules: number; }) {
        super("Could not find any component", { context: data });

        this.projectRootPath = data.projectRootPath;
        this.config = data.config;
        this.numberOfModules = data.numberOfModules;
    }
}

function transformTSParseError(ne: NativeTSParseError): TSParseError {
    return new TSParseError(ne.TSParseError.reason, ne.TSParseError.file);
}

function transformNativeError(error: Error & { code?: string; }): CliError {
    if (!("code" in error) || error.code === "Unknown") {
        return new UnexpectedAnalysisError(error.message);
    }

    try {
        const errorPayload = (JSON.parse(error.message) as NativeErrorPayload).error;

        if ("GlobError" in errorPayload) {
            return new GlobError(errorPayload.GlobError.reason, errorPayload.GlobError.root, errorPayload.GlobError.pattern);
        } else if ("AliasParseError" in errorPayload) {
            return new AliasParseError(errorPayload.AliasParseError.reason, errorPayload.AliasParseError.input);
        } else if ("TSParseError" in errorPayload) {
            return transformTSParseError(errorPayload);
        } else if ("AnalysisError" in errorPayload) {
            return new AnalysisError(errorPayload.AnalysisError.reason);
        } else if ("GitUtilError" in errorPayload) {
            return new GitUtilError(errorPayload.GitUtilError.reason, errorPayload.GitUtilError.suggestion);
        } else if ("MpscError" in errorPayload) {
            return new UnexpectedAnalysisError(errorPayload.MpscError.reason);
        } else {
            return new UnexpectedAnalysisError(`Unknown native error: ${error.message}`);
        }
    } catch (err) {
        return new UnexpectedAnalysisError(`Couldn't translate native error: ${error.message}`);
    }
}

interface InvalidDependency {
    package_name: string;
    path: string;
    source_package_name: string;
}

export interface AnalyzeResult {
    components: Component[];
    exports: Export[];
    alias_map: Pick<ProjectSetup, "packages" | "root">;
    meta: AnalysisStats & {
        duration_msec: number;
        cli_version: string;
        cli_params: Record<string, unknown>;
        cli_config: Config;
        argv: string;
        node_version: string;
        device_info: {
            os: string;
            arch: string;
            version: string;
        };
        ci_vendor?: string;
    };
    parser_errors: TSParseError[];
    setup_issues: ResolutionConfigIssue[];
    invalid_dependencies: InvalidDependency[];
    repository?: {
        scope?: string;
        name?: string;
        branch?: string;
        url?: string;
        initialCommitHash: string;
    };
}

async function getProjectSetup(repoRoot: string, projectRoot: string, config: Config, opts: { failOnError?: boolean; } = {}) {
    const resolver = await ProjectSetupResolver.create(repoRoot, projectRoot, config);
    const projectSetup = await resolver.getProjectSetup(opts.failOnError ?? false);

    return projectSetup;
}

export async function parse(projectRoot: string, config: Config): Promise<Module[]> {
    const repoRoot = getGitRoot(projectRoot);
    const extractedAliasMap = await getProjectSetup(repoRoot, projectRoot, config);

    if (!repoRoot) {
        const formattedProjectRoot = normalizeTrimPath(projectRoot);
        console.log(clr.red(`No git root found on ${clr.bold(formattedProjectRoot)}.\n`));
        console.log(clr.yellow("Make sure that you're running analysis on the right project path."));
        return [];
    }

    const spinner = createSpinner("Parsing files");
    spinner.start();
    try {
        const result = JSON.parse(
            await parseNative(
                projectRoot,
                repoRoot,
                config.include,
                config.ignore,
                logger.level,
                getLogFilePath(),
                extractedAliasMap,
                GIT_HISTORY_LIMIT_DAYS
            )
        ) as Module[];

        spinner.succeed();
        return result;
    } catch (e) {
        spinner.fail();
        throw e;
    }
}

async function findInvalidDependencies(components:NativeComponent[], projectSetup: ProjectSetup) {
    const invalidDependencies: Record<string, InvalidDependency> = {};
    const validationResults = new Map<string, boolean>();

    const componentMap = new Map<string, NativeComponent>();
    for (const component of components) {
        componentMap.set(component.id, component);
    }

    for (const { dependencies, source: { source: { package_name: source_package_name } } } of components) {
        for (const { to } of dependencies) {
            const { source: { source: { mtype, package_name, path } } } = componentMap.get(to.id)!;
            if (mtype === "local") {
                continue;
            }
            const packageKey = `${source_package_name}::${package_name}`;
            if (!validationResults.has(packageKey)) {
                validationResults.set(packageKey, await projectSetup.isValidDependency(package_name, source_package_name));
            }

            if (!validationResults.get(packageKey)) {
                const dependencyModuleKey = `${source_package_name}::${package_name}::${path}`;
                invalidDependencies[dependencyModuleKey] = {
                    package_name,
                    path,
                    source_package_name: source_package_name,
                };
            }
        }
    }

    return Object.values(invalidDependencies);
}
async function runAnalysis(repoRoot: string, repository: RepositoryInfo, projectRoot: string, config: Config, projectSetup: ProjectSetup, options: { dryRun?: boolean; cliVersion: string; quiet: boolean; }): Promise<AnalyzeResult> {
    const startTime = performance.now();

    let analysisResult: NativeAnalyzeResult;
    const verboseOutput = (
        logger.level === LogLevel.Debug || logger.level === LogLevel.Trace
    ) && options.dryRun;

    const logLevel = options.quiet ? undefined : logger.level;
    const logPath = options.quiet ? undefined : getLogFilePath();

    try {
        const nativeResult = await analyzeNative(
            projectRoot,
            repoRoot,
            config.include,
            config.ignore,
            logLevel,
            logPath,
            projectSetup,
            GIT_HISTORY_LIMIT_DAYS
        );

        const components = nativeResult.components.map(c => ({
            id: c.id,
            name: c.name,
            export_ids: c.exportIds,
            source: JSON.parse(c.source) as SymbolWithSource,
            created_at: c.createdAt,
            updated_at: c.updatedAt,
            dependencies: c.dependencies.map(d => JSON.parse(d) as NativeComponentDependency),
            props: c.props.map(p => ({
                name: p.name,
                default_value: p.defaultValue,
                span: {
                    start: p.start as CharacterPosition,
                    end: p.end as CharacterPosition,
                },
            })),
            html_elements: c.htmlElements,
            ...(c.start && c.end ? {
                span: { start: c.start as CharacterPosition, end: c.end as CharacterPosition },
            } : {}),
        }));

        const exports = nativeResult.exports.map(e => ({
            name: e.name,
            module_id: JSON.parse(e.moduleId) as ModuleId,
            created_at: e.createdAt,
            updated_at: e.updatedAt,
            resolvedType: verboseOutput && e.resolvedType,
            inferredType: verboseOutput && e.inferredType,
            is_component: e.isComponent,
            trace_to_declaration: e.traceToDeclaration.map(sws => JSON.parse(sws) as ReferenceWithSource),
        }));

        analysisResult = {
            components,
            exports,
            errors: nativeResult.errors.map(e => JSON.parse(e) as NativeTSParseError),
            stats: JSON.parse(nativeResult.stats) as AnalysisStats,
        };
    } catch (error) {
        throw transformNativeError(error as Error);
    }

    const { components, exports, errors = [], stats } = analysisResult;

    if (stats.num_of_modules === 0) {
        throw new NoModuleFound({ config, projectRootPath: projectRoot });
    }

    if (stats.num_of_components === 0) {
        throw new NoComponentFound({ config, projectRootPath: projectRoot, numberOfModules: stats.num_of_modules });
    }

    return {
        components: components.map(c => transformComponent(c)),
        exports: exports,
        alias_map: {
            root: projectSetup.root,
            packages: projectSetup.packages,
        },
        meta: {
            ...stats,
            duration_msec: Math.floor(performance.now() - startTime),
            cli_version: options.cliVersion,
            node_version: process.version,
            device_info: {
                os: os.type(),
                arch: os.arch(),
                version: os.release(),
            },
            cli_params: {},
            cli_config: config,
            ci_vendor: ciVendor,
            argv: process.argv.join(" "),
        },
        setup_issues: projectSetup.issues ?? [],
        invalid_dependencies: await findInvalidDependencies(components, projectSetup),
        parser_errors: errors.map(e => transformTSParseError(e)),
        repository: {
            scope: repository.scope,
            name: repository.name,
            url: repository.url,
            branch: repository.branch,
            initialCommitHash: repository.initialCommitHash,
        },
    };
}

interface AnalysisSummary {
    numberOfModules: number;
    numberOfFailedModules: number;
    numberOfComponents: number;
    packages: string[];
    componentCountByPackage: {
        [k: string]: number;
    };
}

function generateAnalysisSummary(results: AnalyzeResult): AnalysisSummary {
    const countByPackage: Record<string, Set<string>> = {};

    for (const component of results.components) {
        let componentSet;
        const packageName = component.package_name;
        if (packageName in countByPackage) {
            componentSet = countByPackage[packageName];
        } else {
            componentSet = new Set<string>();
            countByPackage[packageName] = componentSet;
        }

        componentSet.add(component.id);
    }

    return {
        numberOfModules: results.meta.num_of_modules,
        numberOfFailedModules: results.parser_errors.length,
        numberOfComponents: results.meta.num_of_components,
        packages: Object.keys(results.alias_map.packages).concat(results.alias_map.root.name),
        componentCountByPackage: Object.entries(countByPackage).map<[string, number]>(([packageName, componentSet]) => [packageName, componentSet.size]).reduce<Record<string, number>>((acc, [k, v]) => {
            acc[k] = v;

            return acc;
        }, {}),
    };
}

function printInputParameters(projectRoot: string, config: Config, indentationOffset = 0) {
    const offset = INDENT.repeat(indentationOffset);

    console.log("Parameter used in the scan:");
    console.log(`${offset}${INDENT}${clr.cyan("Working directory:")}\n${INDENT}${INDENT}${process.cwd()}`);
    console.log(`${offset}${INDENT}${clr.cyan("Project path:")}\n${INDENT}${INDENT}${projectRoot}`);
    if ("include" in config) {
        console.log(`${offset}${INDENT}${clr.cyan("Include patterns:")}\n${config.include.length ? config.include.map(p => `${offset}${INDENT}${INDENT}- ${p}`).join("\n") : "None"}`);
    }
    console.log(`${offset}${INDENT}${clr.cyan("Ignore patterns:")}\n${config.ignore.length ? config.ignore.map(p => `${offset}${INDENT}${INDENT}- ${p}`).join("\n") : "None"}`);
}

function getWorkspaceUrl(workspace: Workspace) {
    return new URL(`/${workspace.slug}`, BASE_URL).toString();
}

async function writeJSON(filePath: string, data: unknown) {
    await pipeline(
        toJsonStringStream(data, { spaces: 2 }),
        createWriteStream(filePath)
    );
}

function sleep(msec: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, msec);
    });
}

function printAnalyzeError(message: string, description?: string, code?: ErrorResponseCode) {
    console.error(clr.red(message));

    if (description) {
        const codeStr = code && clr.dim(`(code: ${code})`);
        console.error(clr.dim(description), codeStr ?? "");
    }
}

function groupIssuesBy(issues: ResolutionConfigIssue[], keyFn: (i: ResolutionConfigIssue) => string) {
    const result: Record<string, ResolutionConfigIssue[]> = {};

    for (const issue of issues) {
        const key = keyFn(issue);

        if (!result[key]) {
            result[key] = [];
        }

        result[key].push(issue);
    }

    for (const key in result) {
        result[key].sort((a, b) =>
            a.packageName.localeCompare(b.packageName)
        );
    }

    return result;
}

function printProjectSetupIssues(issues: ResolutionConfigIssue[], reportLevel: ResolutionConfigIssueLevel) {
    const issueGroupToString = (issuesInGroup: ResolutionConfigIssue[], entryTypeLabel: string, sourcePath: string) => {
        const source = upath.relative(process.cwd(), sourcePath);
        return [
            `${INDENT}Source: ${source}`,
            ...issuesInGroup.map(({ level, entry, packageName }) => {
                const entryName = level === ResolutionConfigIssueLevel.Error ? clr.bold(entry.name) : entry.name;
                return `${INDENT} - Package: ${packageName}, ${entryTypeLabel}: "${entryName}", Patterns: ${JSON.stringify(entry.patterns)}`;
            }),
        ].join("\n");
    };

    const keyEntrySourceFn = (issue: ResolutionConfigIssue) => issue.entry.sourcePath;
    const keyEntryTypeFn = (issue: ResolutionConfigIssue) => issue.entry.type;
    const errorsByEntryType = groupIssuesBy(issues.filter(i => i.type === ResolutionConfigIssueType.TargetNotExist), keyEntryTypeFn);
    const warningsByEntryType = groupIssuesBy(issues.filter(i => i.type === ResolutionConfigIssueType.TargetNotIncluded), keyEntryTypeFn);

    console.error("Issues detected in your project configuration!\n");

    const { [PathResolutionEntryType.Alias]: aliasErrors, [PathResolutionEntryType.Export]: exportErrors } = errorsByEntryType;
    if (aliasErrors || exportErrors) {
        console.error(clr.bold(clr.red("Errors:")));

        if (exportErrors) {
            console.error(clr.bold("Cannot find export source in the project"));
            for (const [source, issuesInGroup ] of Object.entries(groupIssuesBy(exportErrors, keyEntrySourceFn))) {
                console.error(`${issueGroupToString(issuesInGroup, "Export", source)}\n`);
            }
        }

        if (aliasErrors) {
            console.error(clr.bold("Cannot find alias target in the project"));
            for (const [source, issuesInGroup ] of Object.entries(groupIssuesBy(aliasErrors, keyEntrySourceFn))) {
                console.error(`${issueGroupToString(issuesInGroup, "Alias", source)}\n`);
            }
        }
    }

    const { [PathResolutionEntryType.Alias]: aliasWarnings, [PathResolutionEntryType.Export]: exportWarnings } = warningsByEntryType;
    if (aliasWarnings || exportWarnings) {
        console.error(clr.bold(clr.yellow("Warnings:")));

        if (exportWarnings) {
            console.error(clr.bold("Export source not included in the scan"));
            for (const [source, issuesInGroup ] of Object.entries(groupIssuesBy(exportWarnings, keyEntrySourceFn))) {
                console.error(`${issueGroupToString(issuesInGroup, "Export", source)}\n`);
            }
        }

        if (aliasWarnings) {
            console.error(clr.bold("Alias target not included in the scan"));
            for (const [source, issuesInGroup ] of Object.entries(groupIssuesBy(aliasWarnings, keyEntrySourceFn))) {
                console.error(`${issueGroupToString(issuesInGroup, "Alias", source)}\n`);
            }
        }
    }

    console.error("Visit https://github.com/zeplin/omlet/blob/main/docs/cli/config-file/README.md for details on how to configure Omlet CLI to fix those issues.");

    if (reportLevel === ResolutionConfigIssueLevel.Error) {
        console.error(clr.dim("You can disable validation of project setup by passing --no-verify option."));
    } else {
        console.error(clr.dim("You can silence these warnings by passing --quiet option."));
    }
    console.error();
}

function printProjectSetupError(error: InvalidProjectSetup, quietOutput: boolean) {
    if (error.issues.length === 0) {
        console.error(
            "Project configuration validation failed with an unexpected error",
            `Details:\n${error.message}\n\nYou can find the error logs here:\n${getLogFilePath()}`
        );

        return;
    }

    const level = error.level;
    if (quietOutput && level === ResolutionConfigIssueLevel.Warning) {
        return;
    }

    printProjectSetupIssues(error.issues, level);
}

function handleConfigError<T extends Error>(error: ConfigError<T>) {
    console.log(clr.red("Failed to load the configuration file."));
    console.log(clr.yellow(`Error: ${error.message}`));
    console.log(clr.dim("Please make sure that configuration file exists."));
    console.log(clr.dim("See https://github.com/zeplin/omlet/blob/main/docs/cli/config-file/README.md for details."));

    logError(error);
}

function handleConfigValidationError<T extends Error>(error: ConfigValidationError<T>) {
    console.log(clr.red("Failed to load the configuration file."));
    console.log(clr.yellow(`Error: ${error.message}`));
    console.log(clr.dim("Please make sure that configuration file valid."));
    console.log(clr.dim("See https://github.com/zeplin/omlet/blob/main/docs/cli/config-file/README.md for details."));

    logError(error);
}

function printUnexpectedError(error: Error) {
    printAnalyzeError(
        "Analysis failed with an unexpected error",
        `Details: ${error.message}\nYou can find the error logs here:\n${getLogFilePath()}`
    );
}

function handleAnalyzeError(error: Error, quietOutput: boolean) {
    const logFilePath = getLogFilePath();

    console.log("");

    if (error instanceof PathNotFound) {
        printAnalyzeError(
            `No directory at ${clr.bold(normalizeTrimPath(error.path))}`,
            "Double check the repository path and try again."
        );
    } else if (error instanceof NoGitRootFound) {
        printAnalyzeError(
            `No git config at ${clr.bold(normalizeTrimPath(error.path))}`,
            "Omlet uses git to collect historical usage data — make sure that you’re analyzing a repo using git."
        );
    } else if (error instanceof NoCommitFound) {
        printAnalyzeError(
            `No git history at ${clr.bold(normalizeTrimPath(error.path))}`,
            "Omlet uses git to collect historical usage data — make sure that you have commits in your repository."
        );
    } else if (error instanceof NoProjectFound) {
        printAnalyzeError(
            `No package.json at ${clr.bold(normalizeTrimPath(error.path))}`,
            "Double-check the repository path and try again.\n\n" +
            `Omlet currently only supports ${formatList(SUPPORTED_FRAMEWORKS)} projects — you can contribute to Omlet project to support more languages/frameworks: https://github.com/zeplin/omlet`
        );
    } else if (error instanceof CannotLoadTSConfig) {
        const extendErrorPath = error.detail.match(/File '(.*)' not found\./)?.[1];
        if (extendErrorPath) {
            printAnalyzeError(
                `No TSConfig found at ${normalizeTrimPath(extendErrorPath)}`,
                `${normalizeTrimPath(error.path)} extends ${normalizeTrimPath(extendErrorPath)}, but it is not found. Make sure to install dependencies, double-check the file path and try again.`,
            );
        } else {
            printAnalyzeError(
                `Invalid TSConfig at ${normalizeTrimPath(error.path)}`,
                error.detail
            );
        }

    } else if (error instanceof GlobError) {
        printAnalyzeError(
            "Invalid glob pattern",
            `Failed parsing glob "${error.pattern}": ${error.reason}`
        );
    } else if (error instanceof GitUtilError) {
        printAnalyzeError(
            "Analyzing git history failed",
            "Omlet uses git to collect historical usage data — make sure that the repo is not a shallow clone."
        );
    } else if (error instanceof AliasParseError) {
        printAnalyzeError(
            "Parsing alias configuration failed",
            `Details: ${error.reason}\nYou can find the error logs here:\n${logFilePath}`
        );
    } else if (error instanceof AnalysisError || error instanceof UnexpectedAnalysisError) {
        printUnexpectedError(error);
    } else if (error instanceof NoModuleFound) {
        printAnalyzeError(
            "No JavaScript/TypeScript modules found on the project directory",
            "Double check the repository path, input parameters and try again."
        );
        printInputParameters(error.projectRootPath, error.config);
    } else if (error instanceof NoComponentFound) {
        printAnalyzeError(
            `No components found in ${pluralize("scanned module", error.numberOfModules)}`,
            `Omlet currently only supports ${formatList(SUPPORTED_FRAMEWORKS)} projects — you can contribute to Omlet project to support more languages/frameworks: https://github.com/zeplin/omlet`
        );
        printInputParameters(error.projectRootPath, error.config);
    } else if (error instanceof InvalidProjectSetup) {
        printProjectSetupError(error, quietOutput);
    } else if (error instanceof CliHookError) {
        const details = error.reason ? `${error.reason}\n` : error.message;
        if (error.reason) {
            printAnalyzeError(
                "Hook script failed to run:",
                `${error.reason.stack}\n\nYou can find the error logs here:\n${logFilePath}`
            );
        } else {
            printAnalyzeError(
                "Error while running CLI hook",
                `Details: ${details}\nYou can find the error logs here:\n${logFilePath}`
            );
        }

        console.log(clr.dim("Check documentation at https://github.com/zeplin/omlet/blob/main/docs/cli/custom-component-properties/cli-hooks.md for details."));
    } else {
        printUnexpectedError(error);
    }

    console.error("");

    logError(error);
}

function handleApiError(error: ApiError) {
    console.log("");

    const { title, detail, code } = error.errorInfo;
    printAnalyzeError(title, detail, code);
}

export async function getWorkspace(): Promise<Workspace> {
    if (WORKSPACE_SLUG) {
        try {
            return await getWorkspaceBySlug(WORKSPACE_SLUG);
        } catch (error) {
            if (error instanceof ApiError && error.errorInfo.code === ErrorResponseCode.WORKSPACE_NOT_FOUND) {
                console.error(`${clr.red("Workspace not found")}`);
                console.error(clr.dim("Please remove `OMLET_WORKSPACE_SLUG` variable to use your default workspace."));
            }
            throw error;
        }
    }

    try {
        return await getDefaultWorkspace();
    } catch (error) {
        if (error instanceof ApiError && error.errorInfo.code === ErrorResponseCode.USER_NOT_HAVE_WORKSPACE) {
            console.error(`${clr.red("You don't have a workspace to set up.")}`);
            console.error(clr.dim(`Visit ${BASE_URL}/create-workspace to create your workspace and then run the init command first.`));
        }
        throw error;
    }
}

export async function analyzeRepo(projectRoot: string, options: AnalyzeOptions) {
    const resolvedProjectRoot = resolvePath(projectRoot);
    logger.debug(`Running analyze at ${resolvedProjectRoot} with params:${JSON.stringify(options, null, 2)}`);
    logger.info(HTTP_PROXY_URL ? `Using proxy ${HTTP_PROXY_URL}` : "No proxy used");

    console.log(`Analyzing the project at ${resolvedProjectRoot}…${options.dryRun ? ` ${clr.dim("(dry-run)")}` : ""}\n`);

    if (!await pathExists(resolvedProjectRoot)) {
        const error = new PathNotFound(resolvedProjectRoot);

        handleAnalyzeError(error, options.quiet);

        throw error;
    }

    const repoRoot = getGitRoot(resolvedProjectRoot);
    if (!repoRoot) {
        const error = new NoGitRootFound(resolvedProjectRoot);

        handleAnalyzeError(error, options.quiet);

        throw error;
    }

    const repository = await getRepoInfo(repoRoot);
    if (repository === undefined) {
        const error = new NoCommitFound(resolvedProjectRoot);

        handleAnalyzeError(error, options.quiet);

        throw error;
    }

    let config;
    try {
        config = await loadConfig(repoRoot, resolvedProjectRoot, options.cliParams, options.cliParams.configPath);

        logger.debug(`Read user config from ${config.configPath} (input path: ${options.cliParams.configPath ?? "none"}, repo root: ${repoRoot}, project root: ${resolvedProjectRoot}):`);
        logger.debug(JSON.stringify(config, null, 2));
    } catch (error) {
        if (error instanceof ConfigError) {
            handleConfigError(error);
        } else if (error instanceof ConfigValidationError) {
            handleConfigValidationError(error);
        }

        throw error;
    }

    let projectSetup;
    const analysisSpinner = createSpinner("Detecting components and collecting component usages…");
    try {
        projectSetup = await getProjectSetup(repoRoot, resolvedProjectRoot, config, { failOnError: options.verifySetup });
        logger.debug("Project setup extracted successfully");

        analysisSpinner.start();

        const analysisResult = await runAnalysis(repoRoot, repository, resolvedProjectRoot, config, projectSetup, options);

        if (config.hookScript) {
            const hookContext = await initHooks(config.hookScript, analysisResult);

            await hookContext.afterScan();

            for (const component of analysisResult.components) {
                const metadata = hookContext.getComponentMetadata(component.id);
                if (metadata) {
                    component.metadata = metadata;
                }
            }
        }

        analysisSpinner.succeed();
        console.log("");

        if (options.showSummary) {
            const analysisSummary = generateAnalysisSummary(analysisResult);
            console.log(`\n${clr.bold("Summary:")}`);
            console.log(`${INDENT}${analysisSummary.numberOfModules} modules have been scanned successfully and ${clr.bold(clr.cyan(analysisSummary.numberOfComponents))} components detected.`);
            if (analysisSummary.numberOfFailedModules > 0) {
                console.log(`${INDENT}${clr.yellow(`${pluralize("module", analysisSummary.numberOfFailedModules)} failed to parse and ${analysisSummary.numberOfFailedModules === 1 ? "was" : "were"} left out of the analysis.`)}`);
                console.log(`${INDENT}${clr.dim("Components declared there are missing from the results. Run with --dry-run to list the failures under parser_errors, or use --fail-on-parse-error to fail the run.")}`);
            }
            console.log("");
            console.log(`${INDENT}${clr.yellow("Number of components by package:")}`);
            Object.entries(analysisSummary.componentCountByPackage).sort((e1, e2) => e2[1] - e1[1]).forEach(([packageName, count]) => {
                console.log(`${INDENT}${INDENT}- ${packageName}: ${count ? count : "None"}`);
            });
            console.log("");
        }

        if (projectSetup.issues && projectSetup.issues.length > 0 && !options.quiet) {
            printProjectSetupIssues(projectSetup.issues, ResolutionConfigIssueLevel.Warning);
        }

        return analysisResult;
    } catch (e) {
        analysisSpinner.fail();

        const error = e as Error;

        handleAnalyzeError(error, options.quiet);

        logError(error);

        throw error;
    }
}

export interface AnalyzeToJsonOptions {
    root?: string;
    include?: string[];
    ignore?: string[];
    configPath?: string;
    tsconfigPath?: string;
    verify?: boolean;
}

export async function analyzeToJson(options: AnalyzeToJsonOptions): Promise<AnalyzeResult> {
    const resolvedProjectRoot = resolvePath(options.root ?? process.cwd());
    if (!await pathExists(resolvedProjectRoot)) {
        throw new PathNotFound(resolvedProjectRoot);
    }

    const repoRoot = getGitRoot(resolvedProjectRoot);
    if (!repoRoot) {
        throw new NoGitRootFound(resolvedProjectRoot);
    }

    const repository = await getRepoInfo(repoRoot);
    if (repository === undefined) {
        throw new NoCommitFound(resolvedProjectRoot);
    }

    const config = await loadConfig(repoRoot, resolvedProjectRoot, {
        include: options.include,
        ignore: options.ignore,
        tsconfigPath: options.tsconfigPath,
    }, options.configPath);

    const projectSetup = await getProjectSetup(repoRoot, resolvedProjectRoot, config, {
        failOnError: options.verify ?? true,
    });

    const analysisResult = await runAnalysis(repoRoot, repository, resolvedProjectRoot, config, projectSetup, {
        dryRun: false,
        cliVersion: getCliVersion(),
        quiet: true,
    });

    return analysisResult;
}

function rejectIncompleteAnalysis(analysisData: AnalyzeResult, options: AnalyzeCmdOptions) {
    const failedModules = analysisData.parser_errors.length;
    if (!options.failOnParseError || failedModules === 0) {
        return;
    }

    printAnalyzeError(
        `${pluralize("module", failedModules)} failed to parse`,
        "The analysis is incomplete. Run with --dry-run to list the failures under parser_errors."
    );

    const error = new ParseErrorsFound(failedModules);
    logError(error);

    throw error;
}

export async function analyze(projectRoot: string, options: AnalyzeCmdOptions) {
    let workspace;

    if (!options.dryRun) {
        workspace = await getWorkspace();

        if (workspace.projects.length === 0) {
            console.error(`${clr.red("You have not completed setup for this workspace.")}`);
            console.error(clr.dim("Run the init command to go through a guided process to initialize your workspace first."));
            console.error(clr.dim("Visit https://github.com/zeplin/omlet/blob/main/docs/cli/commands/init.md for more details."));

            throw new WorkspaceNotSetup();
        }
    }

    console.log(`${clr.bgGreen(clr.black("Omlet"))} ${clr.green(`v${options.cliVersion}`)}\n`);
    if (!options.dryRun) {
        console.log(`${clr.bgYellow(clr.black("(^▽^)ノ"))} Good to see you again!\n`);
    }

    const analysisData = await analyzeRepo(projectRoot, { ...options, showSummary: true });
    const logFilePath = getLogFilePath();

    if (options.dryRun) {
        console.log(`Saving results to the file:\n${INDENT}${DRY_RUN_OUTPUT_PATH}\n`);

        try {
            await writeJSON(DRY_RUN_OUTPUT_PATH, analysisData);
        } catch (error) {
            printAnalyzeError(
                "Couldn't write dry-run output to the file",
                `Try again and if the issue continues, you can find the error logs here:\n${logFilePath}`
            );

            logError(error as Error);

            throw error;
        }

        rejectIncompleteAnalysis(analysisData, options);
    } else {
        // Before the upload, not after it: the point of the option is that an
        // incomplete analysis never reaches the dashboard.
        rejectIncompleteAnalysis(analysisData, options);

        if (!workspace) {
            workspace = await getWorkspace();
        }

        const submitSpinner = createSpinner("Uploading analysis to Omlet…");
        submitSpinner.start();
        try {
            const { meta: { dataIssueCount } } = await postAnalysis(workspace, analysisData);
            submitSpinner.succeed();

            console.log("");
            console.log(`${clr.bgGreen(clr.black("(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧"))} ${clr.bold("All good - analysis in progress…")}`);
            console.log(`              In a minute, you can view the results in Omlet: ${clr.underline(clr.blue(getWorkspaceUrl(workspace)))}`);

            if (dataIssueCount > 0) {
                console.log("");
                const issueUrl = `${new URL(getWorkspaceUrl(workspace))}/data-issues`;
                console.log(clr.dim(`Omlet ran into ${pluralize("issue", dataIssueCount)} that might affect data accuracy. Please review them here: ${clr.underline(clr.blue(issueUrl))}`));
            }
        } catch (e) {
            submitSpinner.fail();

            const error = e as ApiError;

            handleApiError(error);

            throw error;
        }
    }
}

function isLocalComponent(c: Component) {
    return c.source.source.mtype === "local";
}

function getLocalPackages(analysisData: AnalyzeResult): string[] {
    const localPackageNames = new Set<string>();

    analysisData.components.forEach(c => {
        if (isLocalComponent(c)) {
            localPackageNames.add(c.package_name);
        }
    });

    return [...localPackageNames];
}

function extractPackageStats(analyses: AnalyzeResult[]) {
    const packages: Record<string, { componentCount: number; }> = {};

    for (const analysis of analyses) {
        analysis.components.forEach(c => {
            if (isLocalComponent(c)) {
                const packageName = c.package_name;
                if (!packages[packageName]) {
                    packages[packageName] = { componentCount: 0 };
                }

                packages[packageName].componentCount += 1;
            }
        });
    }

    return packages;
}

const collator = new Intl.Collator("en", { caseFirst: "upper", numeric: true });

function comparePackageName(a: string, b: string): number {
    if (a.startsWith("@") && !b.startsWith("@")) {
        return 1;
    }

    if (!a.startsWith("@") && b.startsWith("@")) {
        return -1;
    }

    return collator.compare(a, b);
}


export async function init(projectRoot: string, options: InitCmdOptions) {
    const analyzeOptions = { ...options, showSummary: false, cliParams: {} };
    const { cliVersion } = options;
    const logFilePath = getLogFilePath();
    logger.info(HTTP_PROXY_URL ? `Using proxy ${HTTP_PROXY_URL}` : "No proxy used");

    const workspace = await getWorkspace();

    console.log(`${clr.bgGreen(clr.black("Omlet"))} ${clr.green(`v${cliVersion}`)}\n`);
    console.log(`${clr.bgYellow(clr.black("(^▽^)ノ"))} Welcome to Omlet!\n`);
    await sleep(1000);

    if (workspace.projects.length > 0) {
        console.error(`${clr.red("Setup has already been completed for this workspace")}`);
        console.error(clr.dim("Visit https://github.com/zeplin/omlet/blob/main/docs/cli/commands/init.md for more details on how to reset your workspace and set it up again."));

        throw new WorkspaceAlreadySetupError();
    }

    const analyses = [];
    const initialAnalysis = await analyzeRepo(projectRoot, analyzeOptions);
    const packages = getLocalPackages(initialAnalysis);

    analyses.push(initialAnalysis);

    if (packages.length === 1) {
        console.log(`Looks like you only scanned one project: ${clr.bold(packages[0])}\n`);
        console.log(`${clr.dim("To get the most value out of Omlet, make sure to scan both projects that contain components and projects that use them.")}\n`);

        const repoPrompt = (await inquirer.prompt([{
            type: "confirm",
            message: `Scan another repository? ${clr.reset(clr.dim("(Recommended)"))}`,
            prefix: clr.bold(clr.yellow("?")),
            name: "hasSeparateRepo",
            default: true,
        }])) as inquirer.Answers;

        if (repoPrompt.hasSeparateRepo) {
            let retry = false;
            let numberOfRetries = 0;

            do {
                if (numberOfRetries > 3) {
                    console.error(`${clr.red("Setup could not be completed because of too many errors!")}`);
                    console.error(`${clr.dim(`Double check the repository path and try again.\nIf the issue persists, you can find the error logs here:\n${logFilePath}`)}`);
                    return;
                }

                const repoPathPrompt = (await inquirer.prompt([{
                    message: `Enter path to repository${retry ? clr.dim(" (Press return to cancel)") : ""}\n`,
                    prefix: clr.bold(clr.yellow("?")),
                    name: "appRepoPath",
                }])) as inquirer.Answers;

                if (retry && !repoPathPrompt.appRepoPath) {
                    break;
                } else if (!repoPathPrompt.appRepoPath) {
                    retry = true;

                    continue;
                }

                try {
                    console.log("");
                    const secondAnalysis = await analyzeRepo(repoPathPrompt.appRepoPath as string, analyzeOptions);
                    analyses.push(secondAnalysis);

                    retry = false;
                } catch (e) {
                    numberOfRetries += 1;
                    retry = true;
                }

            } while (retry);
        }
    }

    const sortedStats = Object.entries(extractPackageStats(analyses)).sort(
        (p1, p2) => comparePackageName(p1[0], p2[0])
    );

    const packageCount = Object.keys(sortedStats).length;

    console.log(`Found ${packageCount > 1 ? `${packageCount} projects` : "1 project"}:`);

    for (const [pkg, { componentCount }] of sortedStats) {
        console.log(`${INDENT}• ${pkg} ${clr.dim(componentCount > 1 ? `${componentCount} components` : "1 component")}`);
    }

    console.log("");

    await sleep(1000);
    const submitSpinner = createSpinner("Uploading analysis to Omlet…");
    submitSpinner.start();

    try {
        await initWorkspace(workspace, analyses);
        submitSpinner.succeed();

        console.log("");
        console.log(`${clr.bgGreen(clr.black("(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧"))} ${clr.bold("Analysis complete!")}`);
        console.log(`              View results in Omlet: ${clr.underline(clr.blue(getWorkspaceUrl(workspace)))}`);
    } catch (e) {
        submitSpinner.fail();

        const error = e as ApiError;

        handleApiError(error);

        throw error;
    }
}

export interface AnalyzePartialOptions {
    root?: string;
    modifiedFiles: string[];
    relatedFiles: string[];
    ignore?: string[];
    configPath?: string;
    tsconfigPath?: string;
    verify?: boolean;
}

export async function analyzePartialToJson(options: AnalyzePartialOptions): Promise<AnalyzeResult> {
    const startTime = performance.now();
    const resolvedProjectRoot = resolvePath(options.root ?? process.cwd());
    if (!await pathExists(resolvedProjectRoot)) {
        throw new PathNotFound(resolvedProjectRoot);
    }

    const repoRoot = getGitRoot(resolvedProjectRoot);
    if (!repoRoot) {
        throw new NoGitRootFound(resolvedProjectRoot);
    }

    const repository = await getRepoInfo(repoRoot);
    if (repository === undefined) {
        throw new NoCommitFound(resolvedProjectRoot);
    }

    const config = await loadConfig(repoRoot, resolvedProjectRoot, {
        ignore: options.ignore,
        tsconfigPath: options.tsconfigPath,
    }, options.configPath);

    const projectSetup = await getProjectSetup(repoRoot, resolvedProjectRoot, config, {
        failOnError: options.verify ?? true,
    });

    const analysisResult = await analyzePartialNative(
        resolvedProjectRoot,
        options.modifiedFiles,
        options.relatedFiles,
        config.ignore || [],
        projectSetup,
    );

    const components = analysisResult.components.map(c => ({
        id: c.id,
        name: c.name,
        export_ids: c.exportIds,
        source: JSON.parse(c.source) as SymbolWithSource,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        dependencies: c.dependencies.map(d => JSON.parse(d) as NativeComponentDependency),
        props: c.props.map(p => ({
            name: p.name,
            default_value: p.defaultValue,
            span: {
                start: p.start as CharacterPosition,
                end: p.end as CharacterPosition,
            },
        })),
        html_elements: c.htmlElements,
        ...(c.start && c.end ? {
            span: { start: c.start as CharacterPosition, end: c.end as CharacterPosition },
        } : {}),
    }));

    const exports = analysisResult.exports.map(e => ({
        name: e.name,
        module_id: JSON.parse(e.moduleId) as ModuleId,
        created_at: e.createdAt,
        updated_at: e.updatedAt,
        resolvedType: e.resolvedType,
        inferredType: e.inferredType,
        is_component: e.isComponent,
        trace_to_declaration: e.traceToDeclaration.map(sws => JSON.parse(sws) as ReferenceWithSource),
    }));

    const errors = analysisResult.errors.map(e => JSON.parse(e) as NativeTSParseError);
    const parsedStats = JSON.parse(analysisResult.stats) as AnalysisStats;

    return {
        components: components.map(c => transformComponent(c)),
        exports,
        alias_map: {
            root: projectSetup.root,
            packages: projectSetup.packages,
        },
        meta: {
            ...parsedStats,
            duration_msec: Math.floor(performance.now() - startTime),
            cli_version: getCliVersion(),
            node_version: process.version,
            device_info: {
                os: os.type(),
                arch: os.arch(),
                version: os.release(),
            },
            cli_params: {},
            cli_config: config,
            ci_vendor: ciVendor,
            argv: process.argv.join(" "),
        },
        setup_issues: projectSetup.issues ?? [],
        invalid_dependencies: await findInvalidDependencies(components, projectSetup),
        parser_errors: errors.map(e => transformTSParseError(e)),
        repository: {
            scope: repository.scope,
            name: repository.name,
            url: repository.url,
            branch: repository.branch,
            initialCommitHash: repository.initialCommitHash,
        },
    };
}
