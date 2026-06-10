import { Types as MongooseTypes } from "mongoose";

import { type InvalidDependency } from "../../../cliDataModels/InvalidDependency";
import { FilterOperation } from "../../../common/models/FilterOperation";
import { BaseError } from "../../error";
import { getAnalysesOf, getLatestAnalysisIdsForActivePackages } from "../analysis/analysis";
import { getLatestComponentsIn, RESERVED_TAGS } from "../component/component";
import { logException } from "../logger";
import { type Workspace, type Project } from "../workspace/workspace";

import { DataIssuesModel } from "./models";

interface AliasIssue {
    packageName: string;
    path: string;
}

export class DataIssue {
    project: Project;
    aliasIssues: AliasIssue[];
    exportIssues: Set<string>;
    isMonorepo: boolean;

    constructor(project: Project, aliasIssues: AliasIssue[], exportIssues: Set<string>) {
        this.project = project;
        this.aliasIssues = aliasIssues;
        this.exportIssues = exportIssues;
        this.isMonorepo = false;
    }

    addAliasIssue(aliasIssue: AliasIssue) {
        this.aliasIssues.push(aliasIssue);
    }

    addExportIssue(exportIssue: string) {
        this.exportIssues.add(exportIssue);
    }
    markAsMonorepo() {
        this.isMonorepo = true;
    }

    getTotalIssueCount() {
        const aliasIssueCount = this.aliasIssues.length > 0 ? 1 : 0;
        const exportIssueCount = this.exportIssues.size > 0 ? 1 : 0;
        return aliasIssueCount + exportIssueCount;
    }

    toResponse() {
        return {
            project: this.project.toResponse(),
            isMonorepo: this.isMonorepo,
            aliasIssues: this.aliasIssues,
            exportIssues: [...this.exportIssues],
        };
    }
}

export async function createDataIssues(workspaceId: string, analysisId: string, invalidDependencies: InvalidDependency[]) {
    const filteredInvalidDependencies = invalidDependencies.map(dep => ({
        packageName: dep.package_name,
        path: dep.path,
        sourcePackageName: dep.source_package_name,
    })).filter(dep => !dep.path.endsWith(".svg"));
    await DataIssuesModel.insertMany(
        [{
            workspace: new MongooseTypes.ObjectId(workspaceId),
            analysis: new MongooseTypes.ObjectId(analysisId),
            invalidDependencies: filteredInvalidDependencies,
        }],
        { lean: true });
}

export async function deleteDataIssues(workspaceId: string, analysisId: string) {
    await DataIssuesModel.softDelete({
        workspace: new MongooseTypes.ObjectId(workspaceId),
        analysis: new MongooseTypes.ObjectId(analysisId),
    });
}

export async function purgeDataIssuesForWorkspace(workspaceId: string) {
    await DataIssuesModel.softDeleteMany(new MongooseTypes.ObjectId(workspaceId));
}

export async function getDataIssues(workspace: Workspace): Promise<DataIssue[]> {
    const internalProjects = workspace.projects.filter(p => p.isInternal);
    const map: Record<string, DataIssue> = Object.fromEntries(
        internalProjects.map(p => [
            p.packageName,
            new DataIssue(p, [], new Set()),
        ])
    );
    const analysisIdMap = await getLatestAnalysisIdsForActivePackages(workspace.id);
    const analysisIds = Object.values(analysisIdMap);

    if (Object.values(analysisIdMap).length === 0) {
        return [];
    }

    async function addAliasIssues() {
        const aliasIssues = await DataIssuesModel.find({
            workspace: new MongooseTypes.ObjectId(workspace.id),
            analysis: { $in: analysisIds },
        }).lean();

        for (const issue of aliasIssues) {
            for (const invalidDependency of issue.invalidDependencies) {
                if (analysisIdMap[invalidDependency.sourcePackageName].toHexString() !== issue.analysis.toHexString()) {
                    // This is a stale issue, skip it
                    continue;
                }

                if (invalidDependency.path.endsWith(".svg")) {
                    // skip svg related alias issues
                    continue;
                }

                if (map[invalidDependency.sourcePackageName]) {
                    map[invalidDependency.sourcePackageName].addAliasIssue({
                        packageName: invalidDependency.packageName,
                        path: invalidDependency.path,
                    });
                } else {
                    logException(
                        new BaseError(
                            "Failed to add alias issue",
                            true,
                            {
                                details: {
                                    workspaceId: workspace.id,
                                    analysisIds,
                                    sourcePackageName: invalidDependency.sourcePackageName,
                                    packageName: invalidDependency.packageName,
                                    path: invalidDependency.path,
                                },
                            }
                        )
                    );
                }
            }
        }
    }

    async function addExportIssues() {
        const { results } = await getLatestComponentsIn(
            workspace.id,
            {
                limit: Infinity,
                filters: {
                    sourceProject: [{
                        operation: FilterOperation.Equals,
                        values: internalProjects.map(p => p.packageName),
                    }],
                    tag: [{
                        operation: FilterOperation.Equals,
                        values: [RESERVED_TAGS.EXTERNAL.slug],
                    }],
                },
            }
        );

        for (const component of results) {
            if (component.path.endsWith(".svg")) {
                // skip svg related export issues
                continue;
            }
            if (map[component.packageName]) {
                map[component.packageName].addExportIssue(component.path);
            } else {
                logException(
                    new BaseError(
                        "Failed to add export issue",
                        true,
                        {
                            details: {
                                workspaceId: workspace.id,
                                componentId: component.id,
                                packageName: component.packageName,
                            },
                        }
                    )
                );
            }
        }
    }

    async function markMonorepos() {
        const { results: analyses } = await getAnalysesOf(
            workspace.id,
            {
                limit: analysisIds.length,
                ids: analysisIds.map((id) => id.toHexString()),
            }
        );

        for (const analysis of analyses) {
            if (analysis.packageNames.length > 1) {
                for (const packageName of analysis.packageNames) {
                    if (map[packageName] && analysis.id === analysisIdMap[packageName].toHexString()) {
                        map[packageName].markAsMonorepo();
                    }
                }
            }
        }
    }

    await Promise.all([addAliasIssues(), addExportIssues(), markMonorepos()]);
    return Object.values(map).filter(dataIssue => dataIssue.aliasIssues.length > 0 || dataIssue.exportIssues.size > 0);
}
