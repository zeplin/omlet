import { fs, vol } from "memfs";

jest.mock("fs/promises", () => {
    return fs.promises;
});

jest.mock("fs", () => {
    return fs;
});

import { type Config } from "../config";

import { type ProjectSetup, ProjectSetupResolver } from "./projectUtils";
import { InvalidProjectSetup } from "./validator";

function arraysEqual<T>(expected: T[], received: T[]) {
    expect(expected.length).toBe(received.length);
    expect(expected).toEqual(expect.arrayContaining(received));
}

export async function extractProjectSetup(repoPath: string, rootPackagePath: string, config: Config, enableValidation = true): Promise<ProjectSetup> {
    const resolver = await ProjectSetupResolver.create(repoPath, rootPackagePath, config);
    const projectSetup = await resolver.getProjectSetup(enableValidation);

    return projectSetup;
}

describe("extractProjectSetup", () => {
    beforeEach(() => {
        vol.reset();
    });

    it("should extract project setup for a simple project", async () => {
        vol.fromJSON(({
            "/repo/project/package.json": JSON.stringify({
                "name": "project",
                "main": "src/index.ts",
            }),
            "/repo/project/src/index.ts": "",
        }));

        const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
            configPath: ".omletrc.json",
            include: ["**/*.{js,jsx,ts,tsx}"],
            ignore: [],
        });

        expect(projectSetup).toMatchSnapshot();
    });

    describe("when reading package entry points", () => {
        it("should extract the main entry point from the `main` field", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "project",
                    "main": "src/index.ts",
                }),
                "/repo/project/src/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            expect(projectSetup).toMatchSnapshot();
        });

        describe("from `exports` field", () => {
            it("should extract the main entry point from the `exports` (string) field", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": "src/index.ts",
                    }),
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should extract the main entry point from the `exports` (string[]) field", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": ["src/index.ts", "index.ts"],
                    }),
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should extract the main entry point from the `exports` (object)(object) field", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": {
                            "import": "src/index.mjs",
                            "require": "src/index.cjs",
                            "default": "src/index.js",
                        },
                    }),
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should extract the main entry point from the `exports` (object)(string) field", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": {
                            ".": "src/index.ts",
                        },
                    }),
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should extract the main entry point from the `exports` (object)(string[]) field", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": {
                            ".": ["src/index.ts", "index.ts"],
                        },
                    }),
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should extract the main entry point from the `exports` (object)(object)(object) field", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": {
                            ".": {
                                "import": "src/index.mjs",
                                "require": "src/index.cjs",
                                "default": "src/index.js",
                            },
                        },
                    }),
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should extract the main entry point from the `exports` (object)(object)(object)(object) field", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": {
                            ".": {
                                "import": {
                                    "types": "src/index.d.ts",
                                    "default": "src/index.js",
                                },
                            },
                        },
                    }),
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should prioritize the `exports` field over the `main` field", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": {
                            ".": "src/index.ts",
                        },
                        "main": "src/main.ts",
                    }),
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });
        });
    });

    describe("with user-defined aliases", () => {
        it("should extract user-defined aliases from Omlet CLI config", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "project",
                }),
                "/repo/project/src/components/button/index.ts": "",
                "/repo/project/src/utils/filesystem/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                aliases: {
                    "@utils/*": [
                        "./src/utils/*",
                    ],
                    "@components/*": [
                        "./src/components/*",
                    ],
                },
            });

            expect(projectSetup).toMatchSnapshot();
        });
    });

    describe("in monorepo projects", () => {
        it("should detect packages matching patterns in `workspaces` field of package.json", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            const packages = [
                projectSetup.root.name,
                ...Object.keys(projectSetup.packages),
            ];

            arraysEqual(packages, [
                "ds-monorepo",
                "ds-button",
            ]);
        });

        it("should detect packages matching patterns in `workspaces.packages` field of package.json", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": {
                        "packages": [
                            "packages/*",
                        ],
                    },
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            const packages = [
                projectSetup.root.name,
                ...Object.keys(projectSetup.packages),
            ];

            arraysEqual(packages, [
                "ds-monorepo",
                "ds-button",
            ]);
        });

        it("should detect packages matching multiple workspace pattern", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/button",
                        "packages/**",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
                "/repo/project/packages/nested/package-b/package.json": JSON.stringify({
                    name: "package-b",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            const packages = [
                projectSetup.root.name,
                ...Object.keys(projectSetup.packages),
            ];

            expect(packages).toEqual(expect.arrayContaining([
                "ds-monorepo",
                "ds-button",
                "package-b",
            ]));
        });

        it("should exclude packages not matching workspace pattern", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
                "/repo/project/packages/form/package.json": JSON.stringify({
                    name: "ds-form",
                }),
                "/repo/project/package-a/package.json": JSON.stringify({
                    name: "package-a",
                }),
                "/repo/project/packages/nested/package-b/package.json": JSON.stringify({
                    name: "package-b",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            const packages = [
                projectSetup.root.name,
                ...Object.keys(projectSetup.packages),
            ];

            expect(packages).toEqual(expect.arrayContaining([
                "ds-monorepo",
                "ds-button",
            ]));
        });

        it("should detect pnpm workspaces", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                }),
                "/repo/project/pnpm-workspace.yml": "packages:\n  - 'packages/*'",
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            const packages = [
                projectSetup.root.name,
                ...Object.keys(projectSetup.packages),
            ];

            arraysEqual(packages, [
                "ds-monorepo",
                "ds-button",
            ]);
        });

        it("should detect lerna workspaces", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                }),
                "/repo/project/lerna.json": JSON.stringify({
                    "packages": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            const packages = [
                projectSetup.root.name,
                ...Object.keys(projectSetup.packages),
            ];

            arraysEqual(packages, [
                "ds-monorepo",
                "ds-button",
            ]);
        });

        it("should detect bolt workspaces", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "bolt": {
                        "workspaces": [
                            "packages/*",
                        ],
                    },
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            const packages = [
                projectSetup.root.name,
                ...Object.keys(projectSetup.packages),
            ];

            arraysEqual(packages, [
                "ds-monorepo",
                "ds-button",
            ]);
        });

        it("should detect nx workspaces", async () => {
            vol.fromJSON(({
                "/repo/project/nx.json": "{}", // nx.json content doeesn't matter, we only check existence
                "/repo/project/package.json": JSON.stringify({
                    name: "@nx-monorepo",
                }),
                // with project.json, without package.json
                "/repo/project/apps/main-app/project.json": JSON.stringify({
                    name: "main-app",
                }),
                // with project.json under an arbitrarily nested folder, without package.json
                "/repo/project/features/pages/second-app/project.json": JSON.stringify({
                    name: "second-app",
                }),
                // with published package name different from project name
                "/repo/project/ds/package.json": JSON.stringify({
                    name: "@nx-monorepo/design-system",
                }),
                "/repo/project/ds/project.json": JSON.stringify({
                    name: "ds",
                }),
                // without project.json
                "/repo/project/libs/common/package.json": JSON.stringify({
                    name: "@nx-monorepo/common",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            const packages = [
                projectSetup.root.name,
                ...Object.keys(projectSetup.packages),
            ];

            arraysEqual(packages, [
                "@nx-monorepo",
                "@nx-monorepo/main-app",
                "@nx-monorepo/second-app",
                "@nx-monorepo/design-system",
                "@nx-monorepo/common",
            ]);
        });

        it("should extract import mappings for multi-package design system with internal dependencies", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/index.ts": "",
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                    main: "./index.ts",
                }),
                "/repo/project/packages/form/index.ts": "",
                "/repo/project/packages/form/package.json": JSON.stringify({
                    name: "ds-form",
                    main: "./index.ts",
                    dependencies: {
                        "ds-button": "workspace:*",
                    },
                }),
                "/repo/project/packages/react-lib/index.ts": "",
                "/repo/project/packages/react-lib/package.json": JSON.stringify({
                    name: "ds-react",
                    main: "./index.ts",
                    dependencies: {
                        "ds-button": "workspace:*",
                        "ds-form": "workspace:*",
                    },
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                include: ["**/*.ts"],
                ignore: [],
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should extract user-defined aliases correctly for each package", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
                "/repo/project/packages/button/src/index.tsx": "",
                "/repo/project/packages/button/src/utils/colorize/index.ts": "",
                "/repo/project/packages/form/package.json": JSON.stringify({
                    name: "ds-form",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                workspaces: {
                    "ds-button": {
                        aliases: {
                            "@utils/*": [
                                "packages/button/src/utils/*",
                            ],
                        },
                    },
                    "ds-form": {
                        aliases: {
                            "@components/button": [
                                "packages/button/src/index.tsx",
                            ],
                        },
                    },
                },
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should use workspace-specific tsconfigPath for TypeScript configuration", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
                "/repo/project/packages/button/config/tsconfig.build.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@button-utils/*": [
                                "../src/utils/*",
                            ],
                        },
                    },
                }),
                "/repo/project/packages/button/src/index.tsx": "",
                "/repo/project/packages/button/src/utils/colorize/index.ts": "",
                "/repo/project/packages/form/package.json": JSON.stringify({
                    name: "ds-form",
                }),
                "/repo/project/packages/form/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@form-utils/*": [
                                "src/helpers/*",
                            ],
                        },
                    },
                }),
                "/repo/project/packages/form/src/helpers/validation/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                workspaces: {
                    "ds-button": {
                        tsconfigPath: "config/tsconfig.build.json",
                    },
                },
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should prioritize workspace-specific tsconfigPath over default tsconfig.json", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
                "/repo/project/packages/button/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@wrong-alias/*": [
                                "src/wrong/*",
                            ],
                        },
                    },
                }),
                "/repo/project/packages/button/build/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@correct-alias/*": [
                                "../src/utils/*",
                            ],
                        },
                    },
                }),
                "/repo/project/packages/button/src/utils/colorize/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                workspaces: {
                    "ds-button": {
                        tsconfigPath: "build/tsconfig.json",
                    },
                },
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should use default tsconfig.json when no workspace-specific tsconfigPath is provided", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: "ds-button",
                }),
                "/repo/project/packages/button/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@default-alias/*": [
                                "src/utils/*",
                            ],
                        },
                    },
                }),
                "/repo/project/packages/button/src/utils/colorize/index.ts": "",
                "/repo/project/packages/form/package.json": JSON.stringify({
                    name: "ds-form",
                }),
                "/repo/project/packages/form/custom/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@form-alias/*": [
                                "../src/helpers/*",
                            ],
                        },
                    },
                }),
                "/repo/project/packages/form/src/helpers/validation/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                workspaces: {
                    "ds-form": {
                        tsconfigPath: "custom/tsconfig.json",
                    },
                },
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should handle workspace-specific tsconfigPath with complex TypeScript configuration", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/design-system/package.json": JSON.stringify({
                    name: "@acme/design-system",
                }),
                "/repo/project/packages/design-system/config/tsconfig.build.json": JSON.stringify({
                    "compilerOptions": {
                        "baseUrl": "../src",
                        "rootDir": "../src",
                        "outDir": "../dist",
                        "paths": {
                            "@components/*": [
                                "components/*",
                            ],
                            "@utils/*": [
                                "utils/*",
                            ],
                            "@types/*": [
                                "types/*",
                            ],
                        },
                    },
                }),
                "/repo/project/packages/design-system/src/index.ts": "",
                "/repo/project/packages/design-system/src/components/button/index.ts": "",
                "/repo/project/packages/design-system/src/utils/theme/index.ts": "",
                "/repo/project/packages/design-system/src/types/theme.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                workspaces: {
                    "@acme/design-system": {
                        tsconfigPath: "config/tsconfig.build.json",
                        exports: {
                            ".": ["src/index.ts"],
                        },
                    },
                },
            });

            expect(projectSetup).toMatchSnapshot();
        });
    });

    describe("in TypeScript projects", () => {
        it("should extract a valid project setup with correct alias config based on TypeScript config", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ts-project",
                }),
                "/repo/project/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@utils/*": [
                                "src/utils/*",
                            ],
                        },
                    },
                }),
                "/repo/project/src/utils/filesystem/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should extract alias config from TypeScript config located at a custom file path", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ts-project",
                }),
                "/repo/project/.config/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@utils/*": [
                                "../src/utils/*",
                            ],
                        },
                    },
                }),
                "/repo/project/src/utils/filesystem/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                tsconfigPath: "/repo/project/.config/tsconfig.json",
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should resolve target paths correctly with respect to baseUrl", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ts-project",
                }),
                "/repo/project/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "baseUrl": "./src",
                        "paths": {
                            "@utils/*": [
                                "legacy-utils/*",
                            ],
                        },
                    },
                }),
                "/repo/project/src/legacy-utils/filesystem/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should prioritize user-defined aliases over the ones from TypeScript configuration", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "project",
                }),
                "/repo/project/.config/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "baseUrl": "../src",
                        "paths": {
                            "@utils/*": [
                                "legacy-utils/*",
                            ],
                        },
                    },
                }),
                "/repo/project/src/components/button/index.ts": "",
                "/repo/project/src/utils/filesystem/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                tsconfigPath: "/repo/project/.config/tsconfig.json",
                aliases: {
                    "@utils/*": [
                        "./src/utils/*",
                    ],
                    "@components/*": [
                        "./src/components/*",
                    ],
                },
            });

            expect(projectSetup).toMatchSnapshot();
        });

        it("should resolve export paths to source file paths if rootDir and outDir params exist", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "project",
                    "main": "dist/index.js",
                }),
                "/repo/project/.config/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "rootDir": "../src",
                        "outDir": "../dist",
                        "baseUrl": "../src",
                        "paths": {
                            "@utils/*": [
                                "legacy-utils/*",
                            ],
                        },
                    },
                }),
                "/repo/project/src/index.ts": "",
                "/repo/project/src/components/button/index.ts": "",
                "/repo/project/src/utils/filesystem/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
                tsconfigPath: "/repo/project/.config/tsconfig.json",
                aliases: {
                    "@utils/*": [
                        "./src/utils/*",
                    ],
                    "@components/*": [
                        "./src/components/*",
                    ],
                },
            });

            expect(projectSetup).toMatchSnapshot();
        });

        describe("extended configuration", () => {
            it("should extract alias config from base TypeScript config when there's no overrides", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "ts-project",
                    }),
                    "/repo/project/.config/tsconfig.base.json": JSON.stringify({
                        "compilerOptions": {
                            "paths": {
                                "@utils/*": [
                                    "../src/utils/*",
                                ],
                            },
                        },
                    }),
                    "/repo/project/tsconfig.json": JSON.stringify({
                        "extends": ".config/tsconfig.base.json",
                    }),
                    "/repo/project/src/utils/filesystem/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should extract alias config from a TypeScript config that overrides its base config", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "ts-project",
                    }),
                    "/repo/project/.config/tsconfig.base.json": JSON.stringify({
                        "compilerOptions": {
                            "paths": {
                                "@utils/*": [
                                    "../src/utils/*",
                                ],
                            },
                        },
                    }),
                    "/repo/project/tsconfig.json": JSON.stringify({
                        "extends": ".config/tsconfig.base.json",
                        "compilerOptions": {
                            "paths": {
                                "@components/*": [
                                    "./src/components/*",
                                ],
                            },
                        },
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/filesystem/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should resolve target paths correctly when base config has baseUrl", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "ts-project",
                    }),
                    "/repo/project/.config/tsconfig.base.json": JSON.stringify({
                        "compilerOptions": {
                            "baseUrl": "../src",
                            "paths": {
                                "@utils/*": [
                                    "legacy-utils/*",
                                ],
                            },
                        },
                    }),
                    "/repo/project/tsconfig.json": JSON.stringify({
                        "extends": ".config/tsconfig.base.json",
                    }),
                    "/repo/project/src/legacy-utils/filesystem/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });
        });
    });

    describe("on invalid project setup", () => {
        it("should detect multiple alias/export mapping issues in user-defined config, package.json, and TS config", async () => {
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "project",
                    "exports": {
                        "package-export-not-included/*": "src/excluded-components/*/index.ts",
                        "package-export-missing/*": "src/missing-components/*/index.ts",
                        "utils/*": "src/utils/*/index.ts",
                    },
                }),
                "/repo/project/tsconfig.json": JSON.stringify({
                    "compilerOptions": {
                        "paths": {
                            "@ts-alias-not-included/*": [
                                "src/excluded-components/*",
                            ],
                            "@ts-alias-missing/*": [
                                "src/missing-components/*",
                            ],
                        },
                    },
                }),
                "/repo/project/src/excluded-components/index.ts": "",
                "/repo/project/src/components/button/index.ts": "",
                "/repo/project/src/excluded-utils/index.ts": "",
                "/repo/project/src/utils/index.ts": "",
                "/repo/project/src/index.ts": "",
            }));

            const testFn = () => extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: ["src/excluded-utils/**/*", "src/excluded-components/**/*"],
                aliases: {
                    "@utils/*": [
                        "./src/utils/*",
                    ],
                    "@user-alias-not-included/*": [
                        "./src/excluded-utils/*",
                    ],
                    "@user-alias-missing/*": [
                        "./src/missing-utils/*",
                    ],
                },
                exports: {
                    ".": ["src/index.ts"],
                    "user-export-not-included/*": ["src/excluded-components/*/index.ts"],
                    "user-export-missing/*": ["src/missing-utils/*/index.ts"],
                },
            });

            await expect(testFn()).rejects.toThrow(InvalidProjectSetup);

            try {
                await testFn();
            } catch (e) {
                const error = e as InvalidProjectSetup;

                expect({
                    message: error.message,
                    issues: error.issues,
                }).toMatchSnapshot();
            }
        });
    });

    describe("on project setup", () => {
        describe("with invalid alias config", () => {
            it("should detect user-defined aliases with no matching target", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                }));

                const testFn = () => extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                    aliases: {
                        "@utils/*": [
                            "./src/utils/*",
                        ],
                        "@components/*": [
                            "./src/components/*",
                        ],
                    },
                });

                await expect(testFn()).rejects.toThrow(InvalidProjectSetup);

                try {
                    await testFn();
                } catch (e) {
                    const error = e as InvalidProjectSetup;

                    expect({
                        message: error.message,
                        issues: error.issues,
                    }).toMatchSnapshot();
                }
            });

            it("should detect user-defined aliases with no included target", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/colorize/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: ["src/utils/**/*"],
                    aliases: {
                        "@utils/*": [
                            "./src/utils/*",
                        ],
                        "@components/*": [
                            "./src/components/*",
                        ],
                    },
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should ignore TS aliases with no matching target", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                    }),
                    "/repo/project/tsconfig.json": JSON.stringify({
                        "compilerOptions": {
                            "paths": {
                                "@utils/*": [
                                    "src/utils/*",
                                ],
                            },
                        },
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should detect user-defined aliases with no included target", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/colorize/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: ["src/utils/**/*"],
                    aliases: {
                        "@utils/*": [
                            "src/utils/*",
                        ],
                    },
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should detect issues with both user-defined and TS aliases", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                    }),
                    "/repo/project/tsconfig.json": JSON.stringify({
                        "compilerOptions": {
                            "paths": {
                                "@utils/*": [
                                    "src/utils/*",
                                ],
                            },
                        },
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/colorize/index.ts": "",
                }));

                const testFn = () => extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: ["src/utils/**/*"],
                    aliases: {
                        "@components/*": [
                            "./src/legacy-components/*",
                        ],
                    },
                });

                await expect(testFn()).rejects.toThrow(InvalidProjectSetup);

                try {
                    await testFn();
                } catch (e) {
                    const error = e as InvalidProjectSetup;

                    expect({
                        message: error.message,
                        issues: error.issues,
                    }).toMatchSnapshot();
                }
            });

            it("should pass when user-defined alias fixes TS alias", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                    }),
                    "/repo/project/tsconfig.json": JSON.stringify({
                        "compilerOptions": {
                            "paths": {
                                "@utils/*": [
                                    "src/legacy-utils/*",
                                ],
                            },
                        },
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/colorize/index.ts": "",
                }));

                expect(await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                    aliases: {
                        "@utils/*": [
                            "./src/utils/*",
                        ],
                    },
                })).toMatchSnapshot();
            });
        });

        describe("with invalid export mapping", () => {
            it("should detect export mapping from package.json with no matching target", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": {
                            ".": "src/index.ts",
                            "components/*": "src/components/*/index.ts",
                            "utils/*": "src/utils/*/index.ts",
                        },
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                }));

                const testFn = () => extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                });

                await expect(testFn()).rejects.toThrow(InvalidProjectSetup);

                try {
                    await testFn();
                } catch (e) {
                    const error = e as InvalidProjectSetup;

                    expect({
                        message: error.message,
                        issues: error.issues,
                    }).toMatchSnapshot();
                }
            });

            it("should detect export mapping from package.json with no included target", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        "exports": {
                            ".": "src/index.ts",
                            "components/*": "src/components/*/index.ts",
                            "utils/*": "src/utils/*/index.ts",
                        },
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/colorize/index.ts": "",
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: ["src/utils/**/*", "src/index.ts"],
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should detect user-defined export mapping with no matching target", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                }));

                const testFn = () => extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: [],
                    exports: {
                        ".": ["src/index.ts"],
                        "components/*": ["src/components/*/index.ts"],
                        "utils/*": ["src/utils/*/index.ts"],
                    },
                });

                await expect(testFn()).rejects.toThrow(InvalidProjectSetup);

                try {
                    await testFn();
                } catch (e) {
                    const error = e as InvalidProjectSetup;

                    expect({
                        message: error.message,
                        issues: error.issues,
                    }).toMatchSnapshot();
                }
            });

            it("should detect user-defined export mapping with no included target", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/colorize/index.ts": "",
                    "/repo/project/src/index.ts": "",
                }));

                const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: ["src/utils/**/*", "src/index.ts"],
                    exports: {
                        ".": ["src/index.ts"],
                        "components/*": ["src/components/*/index.ts"],
                        "utils/*": ["src/utils/*/index.ts"],
                    },
                });

                expect(projectSetup).toMatchSnapshot();
            });

            it("should detect issues with export mappings in both user-defined and package.json", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        exports: {
                            ".": ["src/index.ts"],
                        },
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/colorize/index.ts": "",
                }));

                const testFn = () => extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: ["src/utils/**/*", "src/index.ts"],
                    exports: {
                        "components/*": ["src/components/*/index.ts"],
                        "utils/*": ["src/utils/*/index.ts"],
                    },
                });

                await expect(testFn()).rejects.toThrow(InvalidProjectSetup);

                try {
                    await testFn();
                } catch (e) {
                    const error = e as InvalidProjectSetup;

                    expect({
                        message: error.message,
                        issues: error.issues,
                    }).toMatchSnapshot();
                }
            });

            it("should pass when user-defined alias fixes TS alias", async () => {
                vol.fromJSON(({
                    "/repo/project/package.json": JSON.stringify({
                        "name": "project",
                        exports: {
                            ".": ["src/index.ts"],
                            "components/*": ["src/legacy-components/*/index.ts"],
                        },
                    }),
                    "/repo/project/src/components/button/index.ts": "",
                    "/repo/project/src/utils/colorize/index.ts": "",
                    "/repo/project/src/index.ts": "",
                }));

                expect(await extractProjectSetup("/repo", "/repo/project", {
                    configPath: ".omletrc.json",
                    include: ["**/*.{js,jsx,ts,tsx}"],
                    ignore: ["src/utils/**/*"],
                    exports: {
                        "components/*": ["src/components/*/index.ts"],
                    },
                })).toMatchSnapshot();
            });
        });
    });
});

describe("ProjectSetup.isValidDependency", () => {
    beforeEach(() => {
        vol.reset();
    });

    describe("standalone project", () => {
        it("should return true when the package name is the source package name", async () => {
            const sourcePackageName = "project";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": sourcePackageName,
                    "main": "src/index.ts",
                }),
                "/repo/project/src/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(sourcePackageName, sourcePackageName)).toBe(true);
        });

        it("should return true when the package name is defined as dependency in package.json", async () => {
            const sourcePackageName = "project";
            const packageName = "dependency";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": sourcePackageName,
                    "main": "src/index.ts",
                    "dependencies": {
                        [packageName]: "*",
                    },
                }),
                "/repo/project/src/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(packageName, sourcePackageName)).toBe(true);
        });

        it("should return true when the package name is defined as dev dependency in package.json", async () => {
            const sourcePackageName = "project";
            const packageName = "dependency";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": sourcePackageName,
                    "main": "src/index.ts",
                    "devDependencies": {
                        [packageName]: "*",
                    },
                }),
                "/repo/project/src/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(packageName, sourcePackageName)).toBe(true);
        });

        it("should return true when the package name is defined as peer dependency in package.json", async () => {
            const sourcePackageName = "project";
            const packageName = "dependency";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": sourcePackageName,
                    "main": "src/index.ts",
                    "peerDependencies": {
                        [packageName]: "*",
                    },
                }),
                "/repo/project/src/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(packageName, sourcePackageName)).toBe(true);
        });

        it("should return true when the package name is defined as an alias dependency in package.json", async () => {
            const sourcePackageName = "project";
            const packageName = "dependency";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": sourcePackageName,
                    "main": "src/index.ts",
                    "dependencies": {
                        "alias-dependency": `npm:${packageName}@^1.0.0`,
                    },
                }),
                "/repo/project/src/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(packageName, sourcePackageName)).toBe(true);
        });

        it("should return false when the package name is not defined in package.json", async () => {
            const sourcePackageName = "project";
            const packageName = "dependency";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": sourcePackageName,
                    "main": "src/index.ts",
                }),
                "/repo/project/src/index.ts": "",
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(packageName, sourcePackageName)).toBe(false);
        });
    });

    describe("in monorepo projects", () => {
        it("should return true when the package name is defined as dependency in the source package's package.json", async () => {
            const sourcePackageName = "ds-button";
            const packageName = "dependency";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: sourcePackageName,
                    dependencies: {
                        [packageName]: "*",
                    },
                }),
                "/repo/project/packages/form/package.json": JSON.stringify({
                    name: "ds-form",
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(packageName, sourcePackageName)).toBe(true);
        });

        it("should return false when the package name is defined in another package's package.json", async () => {
            const sourcePackageName = "ds-button";
            const packageName = "dependency";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: sourcePackageName,
                }),
                "/repo/project/packages/form/package.json": JSON.stringify({
                    name: "ds-form",
                    dependencies: {
                        [packageName]: "*",
                    },
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(packageName, sourcePackageName)).toBe(false);
        });

        it("should return true when the package name is the name of another package in the monorepo", async () => {
            const sourcePackageName = "ds-button";
            const packageName = "ds-form";
            vol.fromJSON(({
                "/repo/project/package.json": JSON.stringify({
                    "name": "ds-monorepo",
                    "workspaces": [
                        "packages/*",
                    ],
                }),
                "/repo/project/packages/button/package.json": JSON.stringify({
                    name: sourcePackageName,
                }),
                "/repo/project/packages/form/package.json": JSON.stringify({
                    name: packageName,
                }),
            }));

            const projectSetup = await extractProjectSetup("/repo", "/repo/project", {
                configPath: ".omletrc.json",
                include: ["**/*.{js,jsx,ts,tsx}"],
                ignore: [],
            });
            expect(await projectSetup.isValidDependency(packageName, sourcePackageName)).toBe(true);
        });
    });
});
