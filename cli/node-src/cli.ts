import "core-js/es";

import ciInfo from "ci-info";
import * as clr from "colorette";
import commander from "commander";
import inquirer from "inquirer";
import isDocker from "is-docker";
import upath from "upath";

import { analyze, init, parse, getWorkspace } from "./analyzer";
import { AuthenticationError, getAuthenticatedUser, login } from "./auth";
import { loadConfig, LOGIN_SERVER_PORT, OMLET_VALIDATE } from "./config";
import { CliError } from "./error";
import { setLogLevel, LogLevel, getLogFilePath, logError, endLogger, logger } from "./logger";
import { getCliVersion, getExecutableName } from "./npmUtils";
import { findParentProject, getDefaultRoot, ProjectSetupResolver } from "./projectUtils";
import { getGitRoot } from "./repoUtils";

const CLI_VERSION = getCliVersion();

async function beforeExit(statusCode: number) {
    await endLogger();

    process.exitCode = statusCode;
}

function accumulateValues(value: string, previous: string[] = []): string[] {
    return previous.concat(value);
}

async function getRootPackagePath(input?: string): Promise<string> {
    if (!input) {
        const root = getDefaultRoot();
        return await findParentProject(root) ?? root;
    }

    const absolutePath = upath.resolve(process.cwd(), input);
    if (ciInfo.isCI) {
        return absolutePath;
    }

    const parent = await findParentProject(absolutePath);
    if (!parent) {
        return absolutePath;
    }

    console.log(`Looks like the package is part of the monorepo at ${clr.bold(parent)}.`);
    const { continueWithParent } = (await inquirer.prompt<{ continueWithParent: boolean; }>([{
        type: "confirm",
        message: `Continue with the root package instead? ${clr.reset(clr.dim("(Recommended)"))}`,
        prefix: clr.bold(clr.yellow("?")),
        name: "continueWithParent",
        default: true,
    }]));
    return continueWithParent ? parent : absolutePath;
}

enum LoginResult {
    SUCCESS,
    TERMINATED,
}

async function loginPrompt(isRemote: boolean): Promise<LoginResult> {
    const prompt = (await inquirer.prompt([{
        type: "confirm",
        message: "Looks like you need to login first. Do you want to continue?",
        prefix: "",
        name: "continueLogin",
        default: true,
    }])) as inquirer.Answers;

    if (!prompt.continueLogin) {
        return LoginResult.TERMINATED;
    }

    await login(Number.parseInt(LOGIN_SERVER_PORT, 10), isRemote);

    return LoginResult.SUCCESS;
}

function isHeadless() {
    return isDocker() || isSSH();
}

function isSSH() {
    return Boolean(process.env.SSH_CLIENT || process.env.SSH_TTY);
}

const program = new commander.Command();

program
    .name(getExecutableName())
    .version(CLI_VERSION);

interface ParseCmdArgs {
    config?: string;
    include?: string[];
    ignore?: string[];
    root?: string;
    logLevel?: LogLevel;
    verbose: boolean;
    tsconfigPath?: string;
}

program.command("parse", { hidden: true })
    .description("Parse JS/TS modules and extract component information")
    .option("-r, --root <path>", "Path to the repository's root directory")
    .option("-i, --include <glob-pattern>", "List of glob patterns for input files", accumulateValues)
    .option("-c, --config <path>", "Path to the configuration file. See https://github.com/zeplin/omlet/blob/main/docs/cli/config-file/README.md for details.")
    .option("--ignore <glob-pattern>", "List of ignore patterns for skipping input files", accumulateValues, [])
    .option("--log-level <error|warn|info|debug|trace>", "Specify log level for the CLI (default: \"error\")", LogLevel.Error)
    .option("-v, --verbose", "Run the CLI in debug mode", false)
    .option("--tsconfig-path <path>", "Path to the tsconfig.json file")
    .action(async (args: ParseCmdArgs) => {
        const logLevel = args.verbose ? LogLevel.Debug : args.logLevel;
        if (logLevel) {
            setLogLevel(logLevel);
        }

        const rootPackagePath = await getRootPackagePath(args.root);
        const repoRoot = getGitRoot(rootPackagePath);
        const configParams = {
            include: args.include,
            ignore: args.ignore,
            tsconfigPath: args.tsconfigPath,
        };
        const configPath = args.config && upath.resolve(process.cwd(), args.config);
        const config = await loadConfig(repoRoot, rootPackagePath, configParams, configPath);
        const result = await parse(rootPackagePath, config);

        console.log(JSON.stringify(result, null, 2));
    });

program.command("alias-config", { hidden: true })
    .description("Extract alias config from the repository")
    .option("-r, --root <path>", "Path to the repository's root directory")
    .option("--tsconfig-path <path>", "Path to the tsconfig.json file")
    .option("-c, --config <path>", "Path to the configuration file. See https://github.com/zeplin/omlet/blob/main/docs/cli/config-file/README.md for details.")
    .option("--no-verify", "Skip project setup verification")
    .action(async (args: { root?: string; tsconfigPath?: string; config?: string; verify?: boolean; }) => {
        try {
            const rootPackagePath = await getRootPackagePath(args.root);
            const repoRoot = getGitRoot(rootPackagePath);
            const configParams = {
                tsconfigPath: args.tsconfigPath,
            };
            const configPath = args.config && upath.resolve(process.cwd(), args.config);
            const config = await loadConfig(repoRoot, rootPackagePath, configParams, configPath);
            const resolver = await ProjectSetupResolver.create(repoRoot, rootPackagePath, config);
            const projectSetup = await resolver.getProjectSetup(args.verify ?? true);

            console.log(JSON.stringify(projectSetup, null, 2));
        } catch (e) {
            const error = e as Error;
            if (error instanceof CliError) {
                console.error(`${error.message}\n${error.getContextString()}`);
            } else {
                console.error(`${error.message}\n${error.stack}`);
            }
        }
    });


interface AnalyzeCmdArgs {
    include?: string[];
    ignore?: string[];
    root?: string;
    config?: string;
    dryRun: boolean;
    logLevel?: LogLevel;
    verbose: boolean;
    tsconfigPath?: string;
    hookScript?: string;
    verify?: boolean;
    quiet: boolean;
    remoteLogin: boolean;
    failOnParseError: boolean;
}

function handleAuthenticationError(error: AuthenticationError) {
    console.error(`${clr.red("Login failed while obtaining a token!")}\n`);
    console.error(`${clr.dim(`Please try again and if the issue persists, you can find the error logs here:\n${getLogFilePath()}`)}`);

    logError(error);
}

function handleUnexpectedError(error: Error) {
    console.error(`${clr.red("Command failed with an unexpected error")}`);
    console.error(`${clr.dim(`Details: ${error.message}\nPlease try again and if the issue persists, you can find the error logs here:\n${getLogFilePath()}`)}`);

    logError(error);
}

program.command("analyze")
    .description("Identify components and analyze their usages across JS/TS modules")
    .option("-r, --root <path>", "Path to the repository's root directory")
    .option("-i, --include <glob-pattern>", "List of glob patterns to include in the analysis", accumulateValues)
    .option("--ignore <glob-pattern>", "List of ignore patterns that should be omitted in the analysis", accumulateValues)
    .option("-c, --config <path>", "Path to the configuration file. See https://github.com/zeplin/omlet/blob/main/docs/cli/config-file/README.md for details.")
    .option("--dry-run", "Run analysis only locally and output the result in omlet.json file instead of submitting results.", false)
    .option("--log-level <error|warn|info|debug|trace>", "Specify log level for the CLI")
    .option("-v, --verbose", "Run the CLI in debug mode", false)
    .option("--tsconfig-path <path>", "Path to the tsconfig.json file")
    .option("--hook-script <path>", "Path to the CLI hook script")
    .option("--no-color", "Disable color highlighted output")
    .option("--fail-on-parse-error", "Exit with a non-zero status code when one or more modules fail to parse", false)
    // .option("--no-verify", "Skip project setup verification")  Setup validation and this option is disabled until docs are updated
    // .option("-q, --quiet", "Report errors only", false)
    .option("--remote-login", "Login to Omlet remotely. Please use the option if you are running the CLI in a remote environment.", isHeadless())
    .allowUnknownOption()
    .action(async (args: AnalyzeCmdArgs) => {
        const isDryRun = args.dryRun;
        const logLevel = args.verbose ? LogLevel.Debug : args.logLevel;

        if (logLevel) {
            setLogLevel(logLevel);
        }

        try {
            if (!isDryRun) {
                const user = await getAuthenticatedUser();
                if (!user) {
                    if (ciInfo.isCI) {
                        console.error("Authentication failed!");
                        console.error("Please make sure you have a working Omlet token set as the OMLET_TOKEN variable.\n");
                        console.error("Run `omlet login --print-token` to obtain a token.");

                        return beforeExit(1);
                    } else {
                        const result = await loginPrompt(args.remoteLogin);
                        if (result === LoginResult.TERMINATED) {
                            return beforeExit(0);
                        }
                    }
                }
            }
        } catch (err) {
            const error = err as Error;

            if (error instanceof AuthenticationError) {
                handleAuthenticationError(error);
            } else {
                handleUnexpectedError(error);
            }
            return beforeExit(1);
        }

        try {
            const rootPackagePath = await getRootPackagePath(args.root);
            const cliParams = {
                include: args.include,
                ignore: args.ignore,
                tsconfigPath: args.tsconfigPath,
                configPath: args.config && upath.resolve(process.cwd(), args.config),
                hookScript: args.hookScript,
            };
            await analyze(rootPackagePath, {
                dryRun: isDryRun,
                cliVersion: CLI_VERSION,
                verifySetup: OMLET_VALIDATE, // args.verify ?? true,
                cliParams,
                failOnParseError: args.failOnParseError,
                quiet: true, // args.quiet,
            });
        } catch (e) {
            // Error logging and output is taken care of in `analyze`
            return beforeExit(1);
        }
    });


type InitCmdArgs = {
    root?: string;
    logLevel?: LogLevel;
    verbose: boolean;
    verify?: boolean;
    quiet: boolean;
    remoteLogin: boolean;
};

program.command("init")
    .description("Start guided process to scan your repo(s) and initialize your workspace")
    .option("-r, --root <path>", "Path to the repository's root directory")
    .option("--log-level <error|warn|info|debug|trace>", "Specify log level for the CLI")
    .option("-v, --verbose", "Run the CLI in debug mode", false)
    .option("--no-color", "Disable color highlighted output")
    .option("--remote-login", "Login to Omlet remotely. Please use the option if you are running the CLI in a remote environment.", isHeadless())
    // .option("--no-verify", "Skip project setup verification") Setup validation and this option is disabled until docs are updated
    // .option("-q, --quiet", "Report errors only", false)
    .allowUnknownOption()
    .action(async (args: InitCmdArgs) => {
        const logLevel = args.verbose ? LogLevel.Debug : args.logLevel;
        if (logLevel) {
            setLogLevel(logLevel);
        }

        try {
            if (ciInfo.isCI) {
                console.error("`init` command should not be used in CI environment.");
                console.error("Visit https://github.com/zeplin/omlet/blob/main/docs/cli/commands/init.md for more details.");

                return beforeExit(1);
            }

            const user = await getAuthenticatedUser();
            if (!user) {
                const result = await loginPrompt(args.remoteLogin);
                if (result === LoginResult.TERMINATED) {
                    return beforeExit(0);
                }
            }
        } catch (err) {
            const error = err as Error;

            if (error instanceof AuthenticationError) {
                handleAuthenticationError(error);
            } else {
                handleUnexpectedError(error);
            }
            return beforeExit(1);
        }

        try {
            const rootPackagePath = await getRootPackagePath(args.root);
            await init(rootPackagePath, {
                cliVersion: CLI_VERSION,
                verifySetup: OMLET_VALIDATE, // args.verify ?? true,
                quiet: true, // args.quiet,
            });
        } catch (e) {
            // Error output for other error types is taken care of in `init`
            return beforeExit(1);
        }
    });

interface LoginCmdArgs {
    loginUrl: string;
    localPort: string;
    printToken: boolean;
    verbose: boolean;
    remote: boolean;
}

program.command("login")
    .description("Login to Omlet and get an access token")
    .requiredOption("-p, --local-port <port>", "Port to be used by the local login server", LOGIN_SERVER_PORT)
    .option("--print-token", "Prints token to the command line instead of saving it to the .omletrc file")
    .option("--remote", "Login to Omlet remotely. Please use the option if you are running the CLI in a remote environment.", isHeadless())
    .action(async (args: LoginCmdArgs) => {
        try {
            const token = await login(Number.parseInt(args.localPort, 10), args.remote);

            console.log("Login successful!");

            if (args.printToken) {
                console.log(token);
            }
        } catch (err) {
            const error = err as Error;

            if (error instanceof AuthenticationError) {
                handleAuthenticationError(error);
            } else {
                handleUnexpectedError(error);
            }

            return beforeExit(1);
        }
    });


program.on("command:*", () => {
    program.outputHelp();
});

program.command("me")
    .description("Display current logged in user")
    .action(async () => {
        try {
            const me = await getAuthenticatedUser();
            const workspace = await getWorkspace();

            if (!me) {
                console.error(`${clr.red("Looks like you need to login first with the 'login' command")}\n`);
                return;
            }

            if (!workspace) {
                // relevant output text is already handled in getWorkspace
                return;
            }

            console.log(`${clr.bgGreen(clr.black("(　･ω･)☞"))} ${clr.dim("You're logged in as")} ${clr.whiteBright(me.email)} ${clr.dim("to")} ${clr.whiteBright(workspace.slug)} ${clr.dim("workspace.")}\n`);
        } catch (err) {
            const error = err as Error;

            if (error) {
                handleUnexpectedError(error);
            }

            return beforeExit(1);
        }
    });

program.parseAsync(process.argv)
    .then(() => beforeExit(0))
    .catch(error => {
        logError(error);

        return beforeExit(1);
    });

function signalHandler(exitCode: number) {
    return async (signal: string) => {
        logger.debug(`Received ${signal} signal. Exiting...`);

        await beforeExit(exitCode);
        process.exit(exitCode);
    };
}

process.on("SIGINT", signalHandler(130));
process.on("SIGTERM", signalHandler(143));
