import { execFile } from "child_process";

interface CliRunOptions {
    cwd?: string;
    env?: Record<string, string>;
}

interface CliRunResult {
    exitCode: number;
    signal: string | null;
    stdout: string;
    stderr: string;
}

export function runCli(cliPath: string, args?: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            cliPath,
            args,
            (error, stdout, stderr) => {
                if (error) {
                    console.log("stdout", stdout);
                    console.error("stderr", stderr);
                    return reject(error);
                }

                resolve(stdout);
            }
        );
    });
}

export function runCliAllowingFailure(cliPath: string, args: string[], options: CliRunOptions = {}): Promise<CliRunResult> {
    return new Promise(resolve => {
        execFile(
            cliPath,
            args,
            { cwd: options.cwd, env: { ...process.env, ...options.env } },
            (error, stdout, stderr) => {
                // A child killed by a signal has no exit code; reporting 0 for it
                // would turn a crash into a passing assertion.
                const failure = error as (Error & { code?: number; signal?: string; }) | null;

                resolve({
                    exitCode: failure?.code ?? (failure ? 1 : 0),
                    signal: failure?.signal ?? null,
                    stdout,
                    stderr,
                });
            }
        );
    });
}
