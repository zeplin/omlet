import { execFileSync } from "child_process";
import fs from "fs";
import path from "upath";

import { runCliAllowingFailure } from "./helper/cli";
import { getTempFolder } from "./helper/fs-utils";
import { runNpm } from "./helper/npm";
import { registryUrl } from "./helper/registry";

// Resolving the base URL is a module-level side effect that throws when it is
// unset, so it has to be present even though --dry-run never calls the API.
const CLI_ENV = { OMLET_BASE_URL: "http://localhost:3001" };

const GOOD_MODULE = `export function Good() {
    return <div />;
}
`;

const UNPARSEABLE_MODULE = `export function Bad( {
    return <div />;
}
`;

function createProject(modules: Record<string, string>) {
    const projectRoot = getTempFolder();

    fs.writeFileSync(
        path.join(projectRoot, "package.json"),
        JSON.stringify({ name: "parse-error-project", version: "1.0.0" })
    );
    fs.mkdirSync(path.join(projectRoot, "src"));

    for (const [name, source] of Object.entries(modules)) {
        fs.writeFileSync(path.join(projectRoot, "src", name), source);
    }

    // `analyze` refuses to run without a git repository that has history
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectRoot });
    git("init", "--quiet");
    git("config", "commit.gpgsign", "false");
    git("config", "user.email", "test@omlet.invalid");
    git("config", "user.name", "Omlet test");
    git("add", ".");
    git("commit", "--quiet", "-m", "Add the fixture");

    return projectRoot;
}

describe("`analyze` command", () => {
    const workingDir = getTempFolder();
    let cliPath: string;

    beforeAll(async () => {
        await runNpm([
            "install",
            "@omlet/cli",
            "--prefix",
            workingDir,
            "--registry",
            registryUrl,
        ]);

        cliPath = path.join(workingDir, "node_modules", ".bin", "omlet");
    });

    it("should report the modules that failed to parse but still succeed", async () => {
        const projectRoot = createProject({ "Good.tsx": GOOD_MODULE, "Bad.tsx": UNPARSEABLE_MODULE });

        const { exitCode, signal, stdout } = await runCliAllowingFailure(
            cliPath,
            ["analyze", "--dry-run", "-r", projectRoot],
            { cwd: projectRoot, env: CLI_ENV }
        );

        expect(signal).toBeNull();
        expect(exitCode).toBe(0);
        expect(stdout).toContain("1 module failed to parse");
    });

    it("should exit with a non-zero status code with --fail-on-parse-error", async () => {
        const projectRoot = createProject({ "Good.tsx": GOOD_MODULE, "Bad.tsx": UNPARSEABLE_MODULE });

        const { exitCode } = await runCliAllowingFailure(
            cliPath,
            ["analyze", "--dry-run", "--fail-on-parse-error", "-r", projectRoot],
            { cwd: projectRoot, env: CLI_ENV }
        );

        expect(exitCode).toBe(1);
    });

    it("should succeed with --fail-on-parse-error when every module parses", async () => {
        const projectRoot = createProject({ "Good.tsx": GOOD_MODULE });

        const { exitCode, signal, stdout } = await runCliAllowingFailure(
            cliPath,
            ["analyze", "--dry-run", "--fail-on-parse-error", "-r", projectRoot],
            { cwd: projectRoot, env: CLI_ENV }
        );

        expect(signal).toBeNull();
        expect(exitCode).toBe(0);
        expect(stdout).not.toContain("failed to parse");
    });
});
