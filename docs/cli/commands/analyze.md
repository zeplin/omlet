# analyze

The `analyze` command is used to scan additional repos to detect components and analyze their dependencies _after_ you've gone through the initial setup with `init`.

## Options

### `-i` / `--include`

By default, `analyze` takes the current directory as the root and analyzes everything. Supplying a glob pattern to `-i` narrows where to scan for components. You can pass multiple glob patterns:

```sh
npx @omlet/cli analyze -i 'glob/one' -i 'glob/two'
```

```sh
yarn dlx @omlet/cli analyze -i 'glob/one' -i 'glob/two'
```

```sh
pnpm dlx @omlet/cli analyze -i 'glob/one' -i 'glob/two'
```

### `--ignore`

Pass a glob pattern for any directory, file, or component you want Omlet CLI to ignore. You can pass multiple `--ignore` patterns:

```sh
npx @omlet/cli analyze --ignore 'glob/one' --ignore 'glob/two'
```

```sh
yarn dlx @omlet/cli analyze --ignore 'glob/one' --ignore 'glob/two'
```

```sh
pnpm dlx @omlet/cli analyze --ignore 'glob/one' --ignore 'glob/two'
```

> **Note**
>
> Glob patterns are applied against the file path relative to the project's root directory:
>
> - `*` matches zero or more characters (excluding path separators).
> - `?` matches any single character (excluding path separators).
> - `**` recursively matches directories.
>
> See the [Pattern in glob](https://docs.rs/glob/latest/glob/struct.Pattern.html) documentation for details.

### `-r` / `--root`

Set where Omlet CLI will run the analysis. Useful if you're running the CLI from a different directory than the project you want to scan.

By default, the project root is the current working directory. If that directory doesn't contain a `package.json`, the CLI walks up the directory hierarchy until it finds one.

The CLI prints the resolved root in the terminal:

```shell-session
Analyzing the project at <PATH>…
```

### `--log-level`

Specify the log level for the CLI. Possible values: `error`, `warn`, `info`, `debug`, `trace`.

### `-v` / `--verbose`

Default: `false`. Adds detailed log output in the CLI.

### `--dry-run`

Scanned results are output locally to `omlet.out.json` only — nothing is uploaded. Useful for inspecting results before sending them to the web app.

### `--fail-on-parse-error`

Default: `false`. Exit with status code `1` when one or more modules fail to parse.

A module that fails to parse is left out of the analysis entirely: its components are never detected, and usages of those components are missing from the modules that do parse. By default the run still succeeds, and the summary only reports how many modules were scanned. Use this option in CI to catch the situation instead of silently publishing an incomplete analysis.

Run with `--dry-run` to see which modules failed and why — they are listed under `parser_errors` in `omlet.out.json`.

### `-h` / `--help`

`omlet analyze -h` prints all available options with explanations.

---

← [`init`](./init.md) · [`login`](./login.md) →
