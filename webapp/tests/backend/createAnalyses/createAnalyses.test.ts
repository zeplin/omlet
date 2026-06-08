import { type Express } from "express";
import { StatusCodes as httpStatus } from "http-status-codes";
import { Types } from "mongoose";
import request from "supertest";

import { createApp } from "../../../src/backend/app";
import { LoginProviderType } from "../../../src/backend/service/auth/models";
import {
    ComponentDependencyModel,
    ComponentExportIdsModel,
    ComponentModel,
    DependencyGraphModel,
    HistoricComponentIndexModel,
} from "../../../src/backend/service/component/models";
import { WorkspaceModel } from "../../../src/backend/service/workspace/models";
import { generateToken } from "../../helper/auth";
import { createUser } from "../../helper/user";
import { createWorkspace } from "../../helper/workspace";
import omletWebapp from "../files/omlet-webapp.json";

const workspaceId = "668e79460465a2f58373d7b2";
const workspaceSlug = "da123aab";

let app: Express;

describe("Create analyses", () => {
    const email = "test@email";
    let token: string;

    beforeAll(async () => {
        const user = await createUser({
            _id: "66a0ee2c091e46dc32382826",
            email,
        });

        await createWorkspace({
            _id: workspaceId,
            name: "testWorkspace",
            slug: workspaceSlug,
            userId: user.id,
        });

        token = generateToken({ userId: user.id, email, loginProvider: LoginProviderType.Google });

        app = await createApp({ addViteMw: false });
    });

    it("should return unauthorized status when the token is not provided", async () => {
        const res = await request(app).post(`/api/workspaces/${workspaceSlug}/analyses`);

        expect(res.status).toBe(httpStatus.UNAUTHORIZED);
    });

    it("should return not found status when the workspace is not found", async () => {
        const res = await request(app).post("/api/workspaces/DUMMY_SLUG/analyses")
            .set("Cookie", `omlet-auth-token=${token}`)
            .send(omletWebapp);

        expect(res.status).toBe(httpStatus.NOT_FOUND);
    });

    it("should return ok status when the request is valid", async () => {
        const res = await request(app)
            .post(`/api/workspaces/${workspaceSlug}/analyses`)
            .set("Cookie", `omlet-auth-token=${token}`)
            .send(omletWebapp);

        expect(res.status).toBe(httpStatus.OK);
        await new Promise(resolve => setTimeout(resolve, 10000));

        const components = await ComponentModel.find({ workspace: workspaceId }, {}, { lean: true });
        expect(components).toMatchSnapshot(
            Array(components.length).fill({
                _id: expect.any(Types.ObjectId),
                analysis: expect.any(Types.ObjectId),
            }), "2. Components"
        );

        const componentExportIds = await ComponentExportIdsModel.find({ workspace: workspaceId }, {}, { lean: true });
        expect(componentExportIds).toMatchSnapshot(
            Array(componentExportIds.length).fill({
                _id: expect.any(Types.ObjectId),
                analysis: expect.any(Types.ObjectId),
                component: expect.any(Types.ObjectId),
            }), "3. Component export ids"
        );

        const componentsUsages = await ComponentDependencyModel.find({ workspace: workspaceId }, {}, { lean: true });
        expect(componentsUsages).toMatchSnapshot(
            Array(componentsUsages.length).fill({
                _id: expect.any(Types.ObjectId),
                parentId: expect.any(Types.ObjectId),
                childId: expect.any(Types.ObjectId),
                analysis: expect.any(Types.ObjectId),
            }), "4. Component dependencies"
        );

        const componentsDependencies = await DependencyGraphModel.find({ workspace: workspaceId }, {}, { lean: true });
        expect(componentsDependencies).toMatchSnapshot(
            Array(componentsDependencies.length).fill({
                _id: expect.any(Types.ObjectId),
                analysis: expect.any(Types.ObjectId),
            }), "5. Dependency graphs"
        );

        const historicComponents = await HistoricComponentIndexModel.find({ workspace: workspaceId }, {}, { lean: true });

        expect(historicComponents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    _id: expect.any(Types.ObjectId),
                    lastAnalysis: expect.any(Types.ObjectId),
                    analyzedAt: expect.any(Date),
                    createdAt: expect.any(Date),
                    updatedAt: expect.any(Date),
                    analysisIds: expect.any(Array),
                    entries: expect.arrayContaining([
                        expect.objectContaining({
                            analysis: expect.anything(),
                            component: expect.objectContaining({
                                _id: expect.anything(),
                            }),
                            usingComponents: expect.arrayContaining([
                                expect.objectContaining({
                                    _id: expect.anything(),
                                }),
                            ]),
                        }),
                    ]),
                }),
            ])
        );

        const modifiedHistoricComponents = historicComponents.map((historicComponent: any) => {
            const modifiedHistoricComponent = { ...historicComponent };
            delete modifiedHistoricComponent._id;
            delete modifiedHistoricComponent.lastAnalysis;
            delete modifiedHistoricComponent.analyzedAt;
            delete modifiedHistoricComponent.createdAt;
            delete modifiedHistoricComponent.updatedAt;
            delete modifiedHistoricComponent.analysisIds;

            // Since entries are saved in a random order, we need to sort them before matching a snapshot.
            const sortedEntries = modifiedHistoricComponent.entries.sort((a: any, b: any) => a.definitionId.localeCompare(b.definitionId));

            sortedEntries.forEach((entry: any) => {
                delete entry.analysis;
                delete entry.component._id;

                entry.usingComponents.forEach((usingComponent: any) => {
                    delete usingComponent._id;
                });

                delete entry.lastUsageChangedAt;
            });
            modifiedHistoricComponent.entries = sortedEntries;

            return modifiedHistoricComponent;
        });
        expect(modifiedHistoricComponents).toMatchSnapshot("6. Historic component index");

        const workspace = await WorkspaceModel.findOne({ _id: workspaceId }, {}, { lean: true });
        const modifiedWorkspace: any = { ...workspace };
        // Since entries are saved in a random order, we need to sort them before matching a snapshot.
        modifiedWorkspace.projects = modifiedWorkspace.projects.sort((a: any, b: any) => a.name.localeCompare(b.name));

        expect(modifiedWorkspace).toMatchSnapshot({
            _id: expect.any(Types.ObjectId),
            members: Array(modifiedWorkspace.members.length).fill({
                joinedAt: expect.any(Date),
            }),
            createdAt: expect.any(Date),
            updatedAt: expect.any(Date),
        }, "7. Workspace");
    });

    it("should exclude removed packages from the workspace index when a new scan is submitted", async () => {
        const modifiedPayload = JSON.parse(
            JSON.stringify(omletWebapp).replace(/@omlet\/webapp/g, "@omlet/new-package"),
        ) as Record<string, unknown>;

        const res = await request(app)
            .post(`/api/workspaces/${workspaceSlug}/analyses`)
            .set("Cookie", `omlet-auth-token=${token}`)
            .send(modifiedPayload);

        expect(res.status).toBe(httpStatus.OK);
        // Wait for post-analysis background tasks to complete (indexes, projects update)
        await new Promise(resolve => setTimeout(resolve, 10000));

        const workspace = await WorkspaceModel.findOne({ _id: workspaceId }, {}, { lean: true });
        const packageNames = workspace?.projects.map((p: any) => p.packageName) ?? [];

        expect(packageNames).toContain("@omlet/new-package");
        expect(packageNames).not.toContain("@omlet/webapp");
    });
});
