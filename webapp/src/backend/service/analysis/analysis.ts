import { type PaginationResult as MongoPaginationResult } from "mongo-cursor-pagination";
import mongoose, { Types as MongooseTypes } from "mongoose";

import { ModuleType } from "../../../cliDataModels/ModuleType";
import { type Repository } from "../../../cliDataModels/Repository";
import { withAnalysisWriteLock, cacheValue, getCachedValue, deleteCachedValue } from "../cache/cache";
import {
    createDependencyGraphDoc,
    createWorkspaceIndex,
    deleteComponentIndex,
    findUniqueComponentIndexesByAnalysisId,
    findUniqueComponentIndexesByAnalysisIds,
    getComponentCountsForAnalysis,
    getNumOfComponentsByAnalysisId,
    getProjectsByAnalysisId,
    purgeAllComponentDataForAnalysis,
    saveComponentDependencies,
    saveComponentExportIds,
    saveComponents,
} from "../component/component";
import { type ComponentDependency, type ComponentDoc, ComponentModel } from "../component/models";
import { createDataIssues, deleteDataIssues } from "../dataIssues/dataIssues";
import { subtractDays } from "../date/date";
import { logException } from "../logger";
import { findUserById } from "../user/user";
import {
    ComponentTag,
    getWorkspaceProjects,
    resetTags,
    updateWorkspace,
    updateWorkspaceProjects,
    type Workspace,
} from "../workspace/workspace";

import { type AnalysisDoc, type AnalysisViewModel, AnalysisModel } from "./models";

const MOST_RECENT_ANALYSIS_PERIOD = 30;

interface AnalysisResult {
    analysis: Analysis;
    components: ComponentDoc[];
    analysisData: AnalysisViewModel;
    dependencyData: Record<string, ComponentDependency[]>;
}

export class Analysis {
    id: string;
    packageNames: string[];
    tags: ComponentTag[];
    workspaceId: string;
    cliVersion: string;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;

    constructor(props: AnalysisDoc) {
        this.id = props._id.toString();
        this.workspaceId = props.workspace.toString();
        this.packageNames = props.packageNames;
        this.tags = props.tags.map(tag => ComponentTag.fromDoc(tag));
        this.createdBy = props.createdBy.toString();
        this.createdAt = props.createdAt;
        this.updatedAt = props.updatedAt;
        this.cliVersion = props.meta.cliVersion;
    }

    static fromDoc(doc: AnalysisDoc): Analysis {
        return new Analysis(doc);
    }

    async toResponse() {
        const [createdBy, componentCounts, projects] = await Promise.all([
            findUserById(this.createdBy),
            getComponentCountsForAnalysis(this.workspaceId, this.id, this.createdAt),
            getWorkspaceProjects(this.workspaceId),
        ]);
        this.packageNames = this.packageNames.map(packageName => {
            const project = projects.find(p => p.packageName === packageName);
            return project ? (project.alias ?? project.packageName) : packageName;
        });

        return {
            id: this.id,
            createdAt: this.createdAt,
            cliVersion: this.cliVersion,
            packageNames: this.packageNames,
            createdBy,
            componentCounts,
        };
    }
}

interface AnalysisDocData extends AnalysisViewModel {
    packageNames: string[];
    tags: ComponentTag[];
    meta: AnalysisViewModel["meta"] & {
        num_of_components_added: number;
        num_of_components_deleted: number;
    };
    repository?: Repository;
}

async function createAnalysisDoc(workspaceId: string, userId: string, data: AnalysisDocData): Promise<AnalysisDoc> {
    const [analysisDoc] = await AnalysisModel.insertMany(
        [{
            workspace: new MongooseTypes.ObjectId(workspaceId),
            packageNames: data.packageNames,
            tags: data.tags.map(tag => tag.toDoc()),
            createdBy: new MongooseTypes.ObjectId(userId),
            meta: {
                numOfComponents: data.meta.num_of_components,
                numOfExports: data.meta.num_of_exports,
                numOfModules: data.meta.num_of_modules,
                numOfDependencies: data.meta.num_of_dependencies,
                numOfCommits: data.meta.num_of_commits,
                numOfDeltas: data.meta.num_of_deltas,
                analyzeDurationMsec: data.meta.analyze_duration_msec,
                parseDurationMsec: data.meta.parse_duration_msec,
                dateExtractionMsec: data.meta.date_extraction_msec,
                durationMsec: data.meta.duration_msec,
                cliVersion: data.meta.cli_version || "unknown",
                cliParams: data.meta.cli_params,
                cliConfig: data.meta.cli_config,
                nodeVersion: data.meta.node_version,
                argv: data.meta.argv,
                ...(
                    data.meta.device_info ? {
                        deviceInfo: data.meta.device_info,
                    } : {}
                ),
            },
            ...(
                data.repository ? {
                    repository: {
                        scope: data.repository.scope,
                        name: data.repository.name,
                        url: data.repository.url,
                        branch: data.repository.branch,
                        initialCommitHash: data.repository.initialCommitHash,
                    },
                } : {}
            ),
        }]);

    return analysisDoc;
}

export async function performPostAnalysisOperations(
    workspace: Workspace,
    analysis: Analysis,
    analysisData: AnalysisViewModel,
    dependencyData: Record<string, ComponentDependency[]>,
    components: ComponentDoc[]
) {
    return withAnalysisWriteLock(
        workspace.id,
        async () => {
            const analysisIdsByPackage = await getLatestAnalysisIdsForActivePackages(workspace.id, {
                onOrBefore: analysis.createdAt,
            });

            await saveComponentExportIds(workspace.id, analysis.id, components, analysisData.components);
            await saveComponentDependencies(workspace.id, analysis.id, components, dependencyData);
            await createDependencyGraphDoc(workspace.id, analysis.id, components, dependencyData);
            // This has to be run once the component data (exportIds, usage, dependency etc) is saved
            await ComponentModel.createWorkspaceIndex({
                workspaceId: workspace.id,
                analysisIdsByPackage,
                lastAnalysis: new MongooseTypes.ObjectId(analysis.id),
                analyzedAt: analysis.createdAt,
            });

            await fetchProjectsAndUpdateWorkspace(analysis, workspace);
        }
    );
}

function getKeyForAnalysisInProgress(workspaceId: string) {
    return `workspace:${workspaceId}:analysis:in_progress`;
}

export async function markAnalysisAsInProgress(workspaceId: string) {
    await cacheValue(getKeyForAnalysisInProgress(workspaceId), true, { ttl: 30 * 60 });
}

export async function isAnalysisInProgress(workspaceId: string): Promise<boolean> {
    const value = await getCachedValue(getKeyForAnalysisInProgress(workspaceId));
    return !!value;
}

export async function clearAnalysisInProgress(workspaceId: string) {
    await deleteCachedValue(getKeyForAnalysisInProgress(workspaceId));
}

async function fetchProjectsAndUpdateWorkspace(analysis: Analysis, workspace: Workspace) {
    const analysisId = new MongooseTypes.ObjectId(analysis.id);
    let projects = await getProjectsByAnalysisId(analysisId);
    for (let i = 1; i <= 3 && projects.length === 0; i++) {
        if (i === 1) {
            logException(new Error("Failed to get projects. Retrying..."));
        }
        await new Promise(resolve => setTimeout(resolve, 10 ** i));
        projects = await getProjectsByAnalysisId(new MongooseTypes.ObjectId(analysis.id));
    }

    if (projects.length) {
        const numOfComponents = await getNumOfComponentsByAnalysisId(analysisId);
        await updateWorkspace(workspace.id, { numOfComponents });
        await updateWorkspaceProjects(workspace.id, projects);
    } else {
        logException(new Error("Failed to set projects."));
    }
}

export function createAnalysis(
    workspace: Workspace,
    userId: string,
    originalAnalysisData: AnalysisViewModel
): Promise<AnalysisResult> {
    return withAnalysisWriteLock(
        workspace.id,
        async () => {
            const { components, meta } = originalAnalysisData;

            const tags = await workspace.getTags();

            const localPackageNames = new Set<string>();
            const externalPackageNames = new Set<string>();
            components.forEach(c => {
                if (c.source.source.mtype === ModuleType.Local) {
                    localPackageNames.add(c.package_name);
                } else if (!localPackageNames.has(c.package_name)) {
                    externalPackageNames.add(c.package_name);
                }
            });

            const analysisData = {
                ...originalAnalysisData,
                packageNames: [...localPackageNames],
                tags,
                meta: {
                    ...meta,
                    num_of_components_added: 0,
                    num_of_components_deleted: 0,
                },
            };

            const dependencyData = Object.fromEntries(components.map(({ definitionId, dependencies }) => {
                return [definitionId, dependencies];
            }));

            const analysis = Analysis.fromDoc(await createAnalysisDoc(workspace.id, userId, analysisData));
            if (analysisData.invalid_dependencies?.length) {
                await createDataIssues(workspace.id, analysis.id, analysisData.invalid_dependencies);
            }
            const insertedComponents = await saveComponents(workspace.id, analysis.id, components);
            return { analysis, components: insertedComponents, analysisData, dependencyData };
        }
    );
}

export async function updateComponentTagsInAnalysis(analysisId: string, tags: ComponentTag[]) {
    await AnalysisModel.updateOne(
        { _id: analysisId },
        { $set: { tags: tags.map(tag => tag.toDoc()) } },
    );
}

interface GetAnalysesOfParams {
    limit: number;
    createdAfter?: Date;
    ids?: string[];
    prev?: string;
    next?: string;
}

export async function getAnalysesOf(
    workspaceId: string,
    { ids, limit, next, prev }: GetAnalysesOfParams
): Promise<MongoPaginationResult<Analysis>> {
    const page = await AnalysisModel.paginate({
        query: {
            workspace: new MongooseTypes.ObjectId(workspaceId),
            ...(ids ? { _id: { $in: ids.map(id => new MongooseTypes.ObjectId(id)) } } : {}),
        },
        limit,
        paginatedField: "createdAt",
        next,
        prev,
    });

    return {
        ...page,
        results: page.results.map(doc => Analysis.fromDoc(doc)),
    };
}

export async function getLatestAnalysisIdsForActivePackages(
    workspaceId: string,
    params: { onOrBefore?: Date; } = {},
): Promise<Record<string, MongooseTypes.ObjectId>> {
    const analyses = await AnalysisModel.find(
        {
            workspace: new MongooseTypes.ObjectId(workspaceId),
            ...(params.onOrBefore ? { createdAt: { $lte: params.onOrBefore } } : {}),
        },
        {
            _id: 1,
            packageNames: 1,
            repository: 1,
        },
        {
            readPreference: mongoose.mongo.ReadPreference.PRIMARY,
        },
    )
        .sort({ _id: 1 })
        .lean()
        .exec();

    interface RepoGroup {
        scopesAndNames: Set<string>;
        urls: Set<string>;
        commitHashes: Set<string>;
        latestAnalysisId: MongooseTypes.ObjectId;
        latestPackageNames: string[];
    }

    const groups: RepoGroup[] = [];

    for (const analysis of analyses) {
        const repo = analysis.repository;

        // Find all existing repository groups that match this analysis's metadata
        const matchedGroups: RepoGroup[] = [];

        if (repo) {
            const scopeAndName = repo.scope && repo.name ? `${repo.scope}/${repo.name}` : undefined;

            for (const group of groups) {
                if (
                    (scopeAndName && group.scopesAndNames.has(scopeAndName)) ||
                    (repo.url && group.urls.has(repo.url)) ||
                    (repo.initialCommitHash && group.commitHashes.has(repo.initialCommitHash))
                ) {
                    matchedGroups.push(group);
                }
            }
        }

        let matchedGroup: RepoGroup;

        if (matchedGroups.length > 0) {
            // Use the first matched group as canonical
            matchedGroup = matchedGroups[0];

            // If there are multiple matching groups, merge them all into the first one
            if (matchedGroups.length > 1) {
                for (let i = 1; i < matchedGroups.length; i++) {
                    const otherGroup = matchedGroups[i];

                    for (const sn of otherGroup.scopesAndNames) {
                        matchedGroup.scopesAndNames.add(sn);
                    }
                    for (const url of otherGroup.urls) {
                        matchedGroup.urls.add(url);
                    }
                    for (const hash of otherGroup.commitHashes) {
                        matchedGroup.commitHashes.add(hash);
                    }

                    const index = groups.indexOf(otherGroup);
                    if (index > -1) {
                        groups.splice(index, 1);
                    }
                }
            }
        } else {
            // Create a new repository group
            matchedGroup = {
                scopesAndNames: new Set<string>(),
                urls: new Set<string>(),
                commitHashes: new Set<string>(),
                latestAnalysisId: analysis._id,
                latestPackageNames: analysis.packageNames,
            };
            groups.push(matchedGroup);
        }

        if (repo) {
            if (repo.scope && repo.name) {
                matchedGroup.scopesAndNames.add(`${repo.scope}/${repo.name}`);
            }
            if (repo.url) {
                matchedGroup.urls.add(repo.url);
            }
            if (repo.initialCommitHash) {
                matchedGroup.commitHashes.add(repo.initialCommitHash);
            }
        }

        matchedGroup.latestAnalysisId = analysis._id;
        matchedGroup.latestPackageNames = analysis.packageNames;
    }

    const map: Record<string, MongooseTypes.ObjectId> = {};
    for (const group of groups) {
        for (const packageName of group.latestPackageNames) {
            const currentLatestId = map[packageName];
            if (!currentLatestId || group.latestAnalysisId.getTimestamp() > currentLatestId.getTimestamp()) {
                map[packageName] = group.latestAnalysisId;
            }
        }
    }
    return map;
}

export async function deleteAnalysis(
    workspace: Workspace,
    analysisId: string,
): Promise<void> {
    const workspaceId = workspace.id;
    await withAnalysisWriteLock(
        workspaceId,
        async () => {
            const doc = await AnalysisModel.findOne({
                workspace: workspaceId,
                _id: analysisId,
            });
            if (!doc) {
                return;
            }

            await Promise.all([
                AnalysisModel.softDelete(new MongooseTypes.ObjectId(analysisId)),
                purgeAllComponentDataForAnalysis(workspaceId, analysisId),
                deleteDataIssues(workspaceId, analysisId),
            ]);

            const docFields = ["id", "analyzedAt", "lastAnalysis"] as const;
            type FieldFilter = { [key in typeof docFields[number]]: 1 | 0; };

            const fields = Object.fromEntries(docFields.map(f => [f, 1])) as FieldFilter;

            const indexDocsToRecreate = await findUniqueComponentIndexesByAnalysisId<keyof FieldFilter>(workspaceId, analysisId, { fields });
            for (const doc of indexDocsToRecreate) {
                const analysisIdsByPackage = await getLatestAnalysisIdsForActivePackages(workspaceId, {
                    onOrBefore: doc.analyzedAt,
                });

                await deleteComponentIndex(workspaceId, doc.lastAnalysis.toHexString());
                await createWorkspaceIndex(workspaceId, analysisIdsByPackage, doc.lastAnalysis, doc.analyzedAt);
            }
            const lastAnalysis = await AnalysisModel.findOne(
                { workspace: workspaceId },
                { _id: 1 },
                {
                    readPreference: mongoose.mongo.ReadPreference.PRIMARY,
                    sort: { createdAt: -1 },
                }
            ).lean();
            if (!lastAnalysis) {
                await Promise.all([
                    resetTags(workspaceId),
                    updateWorkspace(workspaceId, { numOfComponents: 0 }),
                    updateWorkspaceProjects(workspaceId, []),
                ]);
                return;
            }

            let projects = await getProjectsByAnalysisId(lastAnalysis._id);
            for (let i = 1; i <= 3 && projects.length === 0; i++) {
                if (i === 1) {
                    logException(new Error("Failed to get projects. Retrying..."));
                }
                await new Promise(resolve => setTimeout(resolve, 10 ** i));
                projects = await getProjectsByAnalysisId(lastAnalysis._id);
            }

            if (projects.length) {
                const numOfComponents = await getNumOfComponentsByAnalysisId(lastAnalysis._id);
                await updateWorkspace(workspaceId, { numOfComponents });
                await updateWorkspaceProjects(workspaceId, projects);
            } else {
                logException(new Error("Failed to set projects."));
            }
        }
    );
}

export async function deleteAnalyses(
    workspace: Workspace,
    analysisIds: string[],
): Promise<void> {
    const workspaceId = workspace.id;
    await withAnalysisWriteLock(
        workspaceId,
        async () => {
            const analyses = await AnalysisModel.find({
                workspace: workspaceId,
                _id: { $in: analysisIds.map(id => new MongooseTypes.ObjectId(id)) },
            }).sort({ createdAt: 1 }).lean();

            if (analyses.length === 0) {
                return;
            }

            const earliestAnalysisDate = analyses[0].createdAt;

            await Promise.all([
                AnalysisModel.softDeleteMany({
                    workspace: workspaceId,
                    _id: { $in: analysisIds.map(id => new MongooseTypes.ObjectId(id)) },
                }),
                ...analysisIds.map(analysisId =>
                    Promise.all([
                        purgeAllComponentDataForAnalysis(workspaceId, analysisId),
                        deleteDataIssues(workspaceId, analysisId),
                    ])
                ),
            ]);

            const docFields = ["id", "analyzedAt", "lastAnalysis"] as const;
            type FieldFilter = { [key in typeof docFields[number]]: 1 | 0; };
            const fields = Object.fromEntries(docFields.map(f => [f, 1])) as FieldFilter;

            const indexDocsToRecreate = await findUniqueComponentIndexesByAnalysisIds<keyof FieldFilter>(
                workspaceId,
                analysisIds,
                { fields }
            );

            const relevantIndexDocs = indexDocsToRecreate.filter(doc =>
                doc.analyzedAt > earliestAnalysisDate
            );

            for (const doc of relevantIndexDocs) {
                const analysisIdsByPackage = await getLatestAnalysisIdsForActivePackages(workspaceId, {
                    onOrBefore: doc.analyzedAt,
                });

                await deleteComponentIndex(workspaceId, doc.lastAnalysis.toHexString());
                await createWorkspaceIndex(workspaceId, analysisIdsByPackage, doc.lastAnalysis, doc.analyzedAt);
            }

            const lastAnalysis = await AnalysisModel.findOne(
                { workspace: workspaceId },
                { _id: 1 },
                {
                    readPreference: mongoose.mongo.ReadPreference.PRIMARY,
                    sort: { createdAt: -1 },
                }
            ).lean();

            if (!lastAnalysis) {
                await Promise.all([
                    resetTags(workspaceId),
                    updateWorkspace(workspaceId, { numOfComponents: 0 }),
                    updateWorkspaceProjects(workspaceId, []),
                ]);
                return;
            }

            let projects = await getProjectsByAnalysisId(lastAnalysis._id);
            for (let i = 1; i <= 3 && projects.length === 0; i++) {
                if (i === 1) {
                    logException(new Error("Failed to get projects. Retrying..."));
                }
                await new Promise(resolve => setTimeout(resolve, 10 ** i));
                projects = await getProjectsByAnalysisId(lastAnalysis._id);
            }

            if (projects.length) {
                const numOfComponents = await getNumOfComponentsByAnalysisId(lastAnalysis._id);
                await updateWorkspace(workspaceId, { numOfComponents });
                await updateWorkspaceProjects(workspaceId, projects);
            } else {
                logException(new Error("Failed to set projects."));
            }
        }
    );
}

export async function purgeAnalysesForWorkspace(workspaceId: string) {
    const workspace = new MongooseTypes.ObjectId(workspaceId);

    await AnalysisModel.softDeleteMany({ workspace });
}

export type { AnalysisViewModel as AnalysisData };

export async function getAnalysisCountForWorkspace(workspaceId: string) {
    return AnalysisModel.countDocuments({ workspace: workspaceId });
}

export async function getAnalysisCountForUser(userId: string) {
    return AnalysisModel.countDocuments({ createdBy: userId });
}

export async function getLatestAnalysisDate(workspaceId: string): Promise<Date | undefined> {
    const latestAnalysis = await AnalysisModel
        .findOne({ workspace: workspaceId })
        .sort({ createdAt: -1 })
        .select("createdAt").lean();
    return latestAnalysis?.createdAt;
}

export async function getMostRecentAnalyses(workspaceId: string): Promise<Analysis[]> {
    const analysisDocs = await AnalysisModel.find({
        workspace: workspaceId,
        createdAt: { $gt: subtractDays(new Date, MOST_RECENT_ANALYSIS_PERIOD) },
    })
        .sort({ createdAt: 1 })
        .exec();

    return analysisDocs.map(doc => Analysis.fromDoc(doc));
}
