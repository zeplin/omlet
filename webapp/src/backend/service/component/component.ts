import mongoose, { type FilterQuery, type PipelineStage, Types as MongooseTypes } from "mongoose";

import { type Component as ComponentData } from "../../../cliDataModels/Component";
import { type ComponentUsage as CliComponentUsage } from "../../../cliDataModels/ComponentUsage";
import { ModuleType } from "../../../cliDataModels/ModuleType";
import { type PropValue } from "../../../cliDataModels/PropValue";
import { PropValueType } from "../../../cliDataModels/PropValueType";
import { AnalysisSubject } from "../../../common/models/AnalysisSubject";
import { type BreakdownType } from "../../../common/models/BreakdownType";
import { type ChartDatum } from "../../../common/models/ChartDatum";
import { type DataFrequencyOption } from "../../../common/models/DataFrequencyOption";
import { FilterDataType } from "../../../common/models/FilterDataType";
import { isEqualityFilterOperation } from "../../../common/models/FilterOperation";
import { RESERVED_TAGS, type Tag } from "../../../common/models/Tag";
import { config } from "../../../config/backend";
import { toISOWeekString } from "../date/date";
import { ServiceError } from "../error";
import {
    equalityFilterIntoQuery,
    folderFilterIntoQuery,
    type NumberFilter,
    numberFilterIntoQuery,
    type StringFilter,
    stringFilterIntoQuery,
} from "../models";
import { escapeRegex } from "../utils";
import { type ProjectDoc } from "../workspace/models";
import { type TreeNode as TreeNodeModel, type Workspace } from "../workspace/workspace";

import {
    type DataAnalysisFilter,
    getAnalyzedAtFilter,
    getGroupByMethod,
    runDataAnalysis,
    tagsQuery,
    type TimeSeriesFilter,
} from "./aggregations";
import {
    csvHeader,
    transformLatestDataAnalysisToChartData,
    transformLatestDataAnalysisToCSV,
    transformOverTimeDataAnalysisToChartData,
    transformOverTimeDataAnalysisToCSV,
} from "./dataTransformer";
import { type AdjacencyMap, findSubgraph } from "./graphUtils";
import {
    COMPONENT_COLLECTION_NAME,
    COMPONENT_DEPENDENCY_COLLECTION_NAME,
    type ComponentDependency,
    ComponentDependencyModel,
    type ComponentDoc,
    ComponentExportIdsModel,
    ComponentModel,
    type ComponentPropDoc,
    type ComponentViewModel,
    type DataAnalysis,
    type DependencyGraphDoc,
    DependencyGraphModel,
    type HistoricComponentIndexDoc,
    HistoricComponentIndexModel,
} from "./models";

const PROP_NOT_SET_NAME = "[not set]";

export class Component {
    id: string;
    definitionId: string;
    name: string;
    packageName: string;
    path: string;
    isInternal: boolean;
    createdAt?: Date;
    lastUsageChangedAt: Date;
    updatedAt?: Date;
    tags: string[];
    numOfDependencies: number;
    numOfUsages: number;
    metadata?: Record<string, string | number | boolean | Date>;

    constructor(props: ComponentAggregationResult) {
        this.id = props._id.toHexString();
        this.definitionId = props.definitionId;
        this.name = props.name;
        this.path = props.path;
        this.isInternal = props.isInternal;
        this.createdAt = props.createdAt;
        this.lastUsageChangedAt = props.lastUsageChangedAt;
        this.packageName = props.packageName;
        this.updatedAt = props.updatedAt;
        this.tags = props.tags;
        this.numOfDependencies = props.numOfDependencies;
        this.numOfUsages = props.numOfUsages;
        this.metadata = props.metadata;
    }

    static fromAggregationResult(data: ComponentAggregationResult) {
        return new Component(data);
    }

    toResponse() {
        return {
            id: this.id,
            definitionId: this.definitionId,
            packageName: this.packageName,
            name: this.name,
            path: this.path,
            isInternal: this.isInternal,
            createdAt: this.createdAt,
            lastUsageChangedAt: this.lastUsageChangedAt,
            updatedAt: this.updatedAt,
            tags: this.tags,
            numOfDependencies: this.numOfDependencies,
            numOfUsages: this.numOfUsages,
            metadata: this.metadata,
        };
    }
}

function convertMetadata(metadata?: Record<string, string | number | boolean | Date>): Record<string, string | number | boolean | Date> {
    if (metadata === undefined) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => {
            let convertedValue = value;
            if (typeof value === "string" && Number.isNaN(Number.parseFloat(value)) && Number.isFinite(new Date(value).getTime())) {
                convertedValue = new Date(value);
            }

            return [key, convertedValue];
        })
    );
}

async function createComponents(
    workspaceId: string,
    analysisId: string,
    componentData: ComponentViewModel[],
): Promise<ComponentDoc[]> {
    const componentDocData = componentData.map(cdata => {
        const doc: Omit<ComponentDoc, "_id"> = {
            definitionId: cdata.definitionId,
            name: cdata.name,
            packageName: cdata.package_name,
            path: cdata.source.source.path,
            isInternal: cdata.source.source.mtype === ModuleType.Local,
            numOfDependencies: cdata.dependencies.length,
            analysis: new MongooseTypes.ObjectId(analysisId),
            workspace: new MongooseTypes.ObjectId(workspaceId),
            props: cdata.props.map(prop => ({
                name: prop.name,
                defaultValue: prop.default_value,
                ...(prop?.span ? {
                    span: {
                        start: prop?.span?.start,
                        end: prop?.span?.end,
                    },
                } : {}),
            })),
            metadata: convertMetadata(cdata.metadata),
        };

        if (cdata.span) {
            doc.span = cdata.span;
        }

        if (cdata.created_at) {
            doc.createdAt = cdata.created_at;
        }

        if (cdata.updated_at) {
            doc.updatedAt = cdata.updated_at;
        }

        return doc;
    });

    const docs = await ComponentModel.insertMany(componentDocData, { lean: true, ordered: false });
    return docs;
}

export async function saveComponentExportIds(
    workspaceId: string,
    analysisId: string,
    components: ComponentDoc[],
    componentData: ComponentViewModel[]
) {
    const exportIdMap = Object.fromEntries(componentData.map(({ definitionId, export_ids }) => [definitionId, export_ids]));

    const exportIdsDocData = components.filter(({ isInternal }) => isInternal)
        .flatMap(({ _id: componentId, definitionId }) => {
            const exportIds = exportIdMap[definitionId];

            return exportIds.map(exportId => ({
                exportId,
                definitionId,
                workspace: new MongooseTypes.ObjectId(workspaceId),
                analysis: new MongooseTypes.ObjectId(analysisId),
                component: componentId,
            }));
        });

    await ComponentExportIdsModel.insertMany(exportIdsDocData, { lean: true, ordered: false });
}

interface DependencyData {
    [key: string]: ComponentDependency[];
}

export async function saveComponentDependencies(
    workspaceId: string,
    analysisId: string,
    components: ComponentDoc[],
    dependencyData: DependencyData
) {
    const componentIdMap = Object.fromEntries(
        components.map(component => [component.definitionId, component._id])
    );

    const usageDocData = components.flatMap(component => {
        const dependencies = dependencyData[component.definitionId] ?? [];
        const parentDefinitionId = component.definitionId;

        return dependencies.map(dependency => {
            const childDefinitionId = getDefinitionId(dependency.to.id);

            return {
                parentId: componentIdMap[parentDefinitionId],
                childId: componentIdMap[childDefinitionId],
                parentDefinitionId,
                childDefinitionId,
                analysis: new MongooseTypes.ObjectId(analysisId),
                workspace: new MongooseTypes.ObjectId(workspaceId),
                usages: dependency.references.flatMap(({ usages }) => usages),
            };
        });
    });

    await ComponentDependencyModel.insertMany(usageDocData, { ordered: false });
}

export async function createDependencyGraphDoc(workspaceId: string, analysisId: string, components: ComponentDoc[], dependencyData: DependencyData): Promise<DependencyGraphDoc> {
    const predecessors: Record<string, string[]> = Object.fromEntries(components.map(component => [component.definitionId, []]));

    for (const component of components) {
        const dependencies = dependencyData[component.definitionId];
        for (const componentDependency of dependencies) {
            predecessors[getDefinitionId(componentDependency.to.id)].push(component.definitionId);
        }
    }

    const [dependencyGraphDoc] = await DependencyGraphModel.insertMany(
        [{
            predecessors: new Map(Object.entries(predecessors)),
            analysis: new MongooseTypes.ObjectId(analysisId),
            workspace: new MongooseTypes.ObjectId(workspaceId),
        }],
        { lean: true, ordered: false }
    );

    return dependencyGraphDoc;
}

function getDefinitionId(cliComponentId: string): string {
    return cliComponentId.replaceAll(".", "<DOT>").replaceAll("$", "<DOLLAR>");
}

export function transformComponent(component: ComponentData): ComponentViewModel {
    const definitionId = getDefinitionId(component.id);

    return {
        ...component,
        definitionId,
        export_ids: component.export_ids.map(getDefinitionId),
        props: component.props ?? [],
        created_at: component.created_at === undefined ? undefined : new Date(component.created_at),
        updated_at: component.updated_at === undefined ? undefined : new Date(component.updated_at),
    };
}

export async function saveComponents(
    workspaceId: string,
    analysisId: string,
    componentData: ComponentViewModel[],
): Promise<ComponentDoc[]> {
    return createComponents(workspaceId, analysisId, componentData);
}

export enum ComponentSortKey {
    Usage = "usage",
    Created = "created",
    Updated = "updated",
    Name = "name",
}

function mapSortKey(key: ComponentSortKey): string {
    switch (key) {
        case ComponentSortKey.Usage:
            return "numOfUsages";
        case ComponentSortKey.Created:
            return "createdAt";
        case ComponentSortKey.Updated:
            return "updatedAt";
        case ComponentSortKey.Name:
            return "name";
        default:
            throw new Error(`Unknown sort key: ${key}`);
    }
}

export async function getLatestAnalysisIdsIn(workspaceId: string): Promise<MongooseTypes.ObjectId[]> {
    const [componentIndex] = await HistoricComponentIndexModel.find<Pick<HistoricComponentIndexDoc, "analysisIds">>({
        workspace: new MongooseTypes.ObjectId(workspaceId),
    }, {
        analysisIds: 1,
    }).sort({ analyzedAt: -1 }).limit(1);
    if (!componentIndex) {
        return [];
    }

    return componentIndex.analysisIds;
}

type ComponentAggregationResult = Omit<ComponentDoc, "props" | "analysis" | "workspace"> & {
    tags: string[];
    numOfUsages: number;
    lastUsageChangedAt: Date;
};

interface PaginatedComponentAggregationResult {
    metadata: [{
        total: number;
    }];
    docs: ComponentAggregationResult[];
}

interface ComponentPaginationResult {
    results: Component[];
    next?: number;
    hasNext: boolean;
    prev?: number;
    hasPrev: boolean;
    page: number;
    total: number;
}

interface GetAggregationPipelineForFetchingComponentsOpts {
    definitionIds?: string[];
    clientProjects?: string[];
    isInternal?: boolean;
}

function getAggregationPipelineForFetchingComponents(workspaceId: string, lastAnalysisId: string, { definitionIds, clientProjects, isInternal }: GetAggregationPipelineForFetchingComponentsOpts = {}) {
    const matchQuery: FilterQuery<HistoricComponentIndexDoc["entries"][number]> = {};
    if (definitionIds?.length) {
        matchQuery.definitionId = { $in: definitionIds };
    }
    if (clientProjects?.length) {
        matchQuery["usingComponents.packageName"] = { $in: clientProjects };
    }
    if (isInternal !== undefined) {
        matchQuery["component.isInternal"] = isInternal;
    }

    return [
        {
            $match: {
                workspace: new MongooseTypes.ObjectId(workspaceId),
                lastAnalysis: new MongooseTypes.ObjectId(lastAnalysisId),
            },
        },
        {
            $unwind: {
                path: "$entries",
            },
        },
        {
            $replaceRoot: {
                newRoot: "$entries",
            },
        },
        {
            $match: matchQuery,
        },
        {
            $addFields: {
                component: {
                    numOfUsages: {
                        $size: "$usingComponents",
                    },
                    tags: "$tags",
                    lastUsageChangedAt: "$lastUsageChangedAt",
                },
            },
        },
        {
            $replaceRoot: {
                newRoot: {
                    $mergeObjects: ["$component", {
                        id: "$component._id",
                        tags: tagsQuery,
                    }],
                },
            },
        },
    ];
}

interface TreeNode {
    numberOfComponents: number;
    totalNumberOfComponents: number;
    children: FolderTreeNode[];
}

interface FolderTreeNode extends TreeNode {
    path: string;
    name: string;
}

interface Package extends TreeNode {
    name: string;
}

interface FoldersResult {
    packages: Package[];
    totalNumberOfUsages: number;
}

function calculateTotalNumberOfComponents(node: TreeNode) {
    node.children.forEach(calculateTotalNumberOfComponents);
    node.totalNumberOfComponents = node.children.reduce(
        (acc, subNode) => acc + subNode.totalNumberOfComponents,
        node.numberOfComponents
    );
}

export async function getLatestIndexAnalysisId(workspaceId: string): Promise<string | null> {
    const componentIndex = await HistoricComponentIndexModel.findOne<Pick<HistoricComponentIndexDoc, "lastAnalysis">>({
        workspace: new MongooseTypes.ObjectId(workspaceId),
    }, {
        lastAnalysis: 1,
    }).sort({ analyzedAt: -1 });

    if (!componentIndex) {
        return null;
    }

    return componentIndex.lastAnalysis.toHexString();
}

export async function getLatestComponentsFoldersIn(workspaceId: string, latestAnalysisId: string): Promise<FoldersResult> {
    const empty = {
        packages: [],
        totalNumberOfUsages: 0,
    };

    const result = await HistoricComponentIndexModel.aggregate<ComponentAggregationResult>(
        getAggregationPipelineForFetchingComponents(workspaceId, latestAnalysisId, { isInternal: true }),
        {}
    );

    if (result.length === 0) {
        return empty;
    }

    const components = result.map(component => Component.fromAggregationResult(component));
    components.sort((c1, c2) => c1.path.localeCompare(c2.path));

    const packages: Package[] = [];
    let totalNumberOfUsages = 0;
    for (const component of components) {
        const { packageName, path: componentPath, numOfUsages } = component;
        totalNumberOfUsages += numOfUsages;

        let pckg = packages.find(({ name }) => name === packageName);
        if (!pckg) {
            pckg = { name: packageName, numberOfComponents: 0, totalNumberOfComponents: 0, children: [] };
            packages.push(pckg);
        }

        const pathParts = componentPath.split("/");
        pathParts.pop(); // get rid of component file name
        let cwd = pckg;
        let path = "";
        for (const part of pathParts) {
            let folder = cwd.children.find(({ name }) => name === part);
            path += `${part}/`;

            if (!folder) {
                folder = { path, name: part, numberOfComponents: 0, totalNumberOfComponents: 0, children: [] };
                cwd.children.push(folder);
            }

            cwd = folder;
        }

        cwd.numberOfComponents++;
    }
    packages.forEach(calculateTotalNumberOfComponents);

    return { packages, totalNumberOfUsages };
}

export class ComponentNotFound extends ServiceError {
    constructor() {
        super("Component not found");
    }
}

interface GetComponentOpts {
    limit: number;
    sortBy?: ComponentSortKey;
    sortAscending?: boolean;
    searchTerm?: string;
    filters?: DataAnalysisFilter;
    folders?: { selectedTreeNodes: TreeNodeModel[]; deselectedTreeNodes: TreeNodeModel[]; };
    next?: number;
    prev?: number;
    reachedDataRetentionLimit?: boolean;
}

export async function getLatestComponentsIn(workspaceId: string, {
    sortBy,
    sortAscending = false,
    limit,
    next,
    searchTerm,
    filters = {},
    folders,
}: GetComponentOpts
): Promise<ComponentPaginationResult> {
    const empty = {
        results: [],
        page: 1,
        hasNext: false,
        hasPrev: false,
        total: 0,
    };

    const latestAnalysisId = await getLatestIndexAnalysisId(workspaceId);
    if (!latestAnalysisId) {
        return empty;
    }

    const matchQueries: FilterQuery<ComponentDoc>[] = [];

    if (searchTerm) {
        const regExps: RegExp[] = searchTerm.split(/\s+/).map(t => new RegExp(escapeRegex(t), "i"));

        matchQueries.push({
            $or: [
                { name: { $in: regExps } },
                { path: { $in: regExps } },
                { packageName: { $in: regExps } },
            ],
        });
    }

    if (folders) {
        matchQueries.push(folderFilterIntoQuery(folders.selectedTreeNodes, folders.deselectedTreeNodes));
    }

    if (filters.name) {
        const nameFilter = filters.name[0];

        if ("values" in nameFilter) {
            matchQueries.push({
                name: equalityFilterIntoQuery(nameFilter),
            });
        } else {
            matchQueries.push({
                name: stringFilterIntoQuery(nameFilter),
            });
        }
    }

    if (filters.path) {
        matchQueries.push({
            path: stringFilterIntoQuery(filters.path[0]),
        });
    }

    if (filters.tag) {
        if (filters.tag[0].values[0] === RESERVED_TAGS.UNTAGGED.slug) {
            matchQueries.push({
                tags: { $eq: [] },
            });
        } else {
            matchQueries.push({
                tags: { $all: filters.tag[0].values },
            });
        }
    }

    if (filters.sourceProject) {
        matchQueries.push({
            packageName: equalityFilterIntoQuery(filters.sourceProject[0]),
        });
    }

    if (filters.numOfUsages) {
        matchQueries.push({
            numOfUsages: numberFilterIntoQuery(filters.numOfUsages[0]),
        });

    }

    if (filters.numOfDependencies) {
        matchQueries.push({
            numOfDependencies: numberFilterIntoQuery(filters.numOfDependencies[0]),
        });
    }

    if (filters.createdAt) {
        matchQueries.push({
            createdAt: { $gte: filters.createdAt[0].value[0] },
        });
    }

    if (filters.updatedAt) {
        matchQueries.push({
            updatedAt: { $gte: filters.updatedAt[0].value[0] },
        });
    }

    if (filters.lastUsageChangedAt) {
        matchQueries.push({
            lastUsageChangedAt: { $gte: filters.lastUsageChangedAt[0].value[0] },
        });
    }

    if (filters.metadata) {
        for (const metadataFilter of filters.metadata) {
            if (metadataFilter.dataType === FilterDataType.Boolean) {
                if (metadataFilter.value[0] === "true") {
                    matchQueries.push({
                        [metadataFilter.field]: { $eq: true },
                    });
                } else {
                    matchQueries.push({
                        $or: [
                            { [metadataFilter.field]: { $exists: false } },
                            { [metadataFilter.field]: { $eq: false } },
                        ],
                    });
                }
            } else if (metadataFilter.dataType === FilterDataType.Date) {
                matchQueries.push({
                    [metadataFilter.field]: { $gte: new Date(metadataFilter.value[0]) },
                });
            } else if (metadataFilter.dataType === FilterDataType.Number) {
                const value = Number.parseInt(metadataFilter.value[0], 10);

                matchQueries.push({
                    [metadataFilter.field]: numberFilterIntoQuery({ operation: metadataFilter.operation, value } as NumberFilter),
                });
            } else if (isEqualityFilterOperation(metadataFilter.operation)) {
                matchQueries.push({
                    [metadataFilter.field]: { $in: metadataFilter.value },
                });
            } else {
                const value = metadataFilter.value[0];

                matchQueries.push({
                    [metadataFilter.field]: stringFilterIntoQuery({ operation: metadataFilter.operation, value } as StringFilter),
                });
            }
        }
    }

    const page = next ?? 1;
    const result = await HistoricComponentIndexModel.aggregate<PaginatedComponentAggregationResult>(
        [
            ...getAggregationPipelineForFetchingComponents(workspaceId, latestAnalysisId, { clientProjects: filters.clientProject?.[0]?.values }),
            {
                $match: matchQueries.length === 0 ? {} : { $and: matchQueries },
            },
            {
                $sort: {
                    [sortBy ? mapSortKey(sortBy) : "_id"]: sortAscending ? 1 : -1,
                },
            },
            {
                $facet: {
                    metadata: [
                        {
                            $count: "total",
                        },
                    ],
                    docs: limit === Infinity
                        ? []
                        : [
                            {
                                $skip: (page - 1) * limit,
                            },
                            {
                                $limit: limit,
                            },
                        ],
                },
            },
        ], {});

    if (result.length === 0) {
        return empty;
    }

    const [{ metadata, docs }] = result;
    if (docs.length === 0) {
        return empty;
    }

    return {
        results: docs.map(doc => Component.fromAggregationResult(doc)),
        page,
        total: metadata[0].total,
        hasPrev: page > 1,
        prev: page > 1 ? page - 1 : undefined,
        hasNext: page < Math.round(metadata[0].total / limit),
        next: page < Math.round(metadata[0].total / limit) ? page + 1 : undefined,
    };
}

export async function findLatestComponentsByDefinitionId(workspaceId: string, definitionIds: string[]): Promise<Component[]> {
    const latestAnalysisId = await getLatestIndexAnalysisId(workspaceId);
    if (!latestAnalysisId) {
        return [];
    }

    const result = await HistoricComponentIndexModel.aggregate<ComponentAggregationResult>(
        getAggregationPipelineForFetchingComponents(workspaceId, latestAnalysisId, { definitionIds }),
        {}
    );

    if (!result || result.length === 0) {
        throw new ComponentNotFound();
    }

    return result.map(doc => Component.fromAggregationResult(doc));
}

export async function getComponentSubcomponents(
    workspaceId: string,
    componentDefinitionId: string,
): Promise<{ subcomponents: Component[]; familyUsage: number; }> {
    const latestAnalysisId = await getLatestIndexAnalysisId(workspaceId);
    if (!latestAnalysisId) {
        return { subcomponents: [], familyUsage: 0 };
    }

    const [parent] = await findLatestComponentsByDefinitionId(workspaceId, [componentDefinitionId]);
    if (!parent) {
        throw new ComponentNotFound();
    }

    const escapedName = escapeRegex(parent.name);
    const regexPattern = new RegExp(`^${escapedName}\\.`);

    const result = await HistoricComponentIndexModel.aggregate<ComponentAggregationResult>([
        {
            $match: {
                workspace: new MongooseTypes.ObjectId(workspaceId),
                lastAnalysis: new MongooseTypes.ObjectId(latestAnalysisId),
            },
        },
        {
            $unwind: {
                path: "$entries",
            },
        },
        {
            $match: {
                "entries.definitionId": { $ne: componentDefinitionId },
                "entries.component.name": regexPattern,
                "entries.component.packageName": parent.packageName,
            },
        },
        {
            $addFields: {
                "entries.component.numOfUsages": {
                    $size: "$entries.usingComponents",
                },
                "entries.component.tags": "$entries.tags",
                "entries.component.lastUsageChangedAt": "$entries.lastUsageChangedAt",
            },
        },
        {
            $replaceRoot: {
                newRoot: {
                    $mergeObjects: [
                        "$entries.component",
                        {
                            id: "$entries.component._id",
                            tags: {
                                $cond: {
                                    if: { $eq: ["$entries.component.isInternal", false] },
                                    then: {
                                        $concatArrays: ["$entries.tags", [RESERVED_TAGS.EXTERNAL.slug]],
                                    },
                                    else: "$entries.tags",
                                },
                            },
                            numOfUsages: {
                                $size: "$entries.usingComponents",
                            },
                        },
                    ],
                },
            },
        },
        {
            $sort: {
                name: 1,
            },
        },
    ], {});

    const subcomponents = result.map(doc => Component.fromAggregationResult(doc));
    const familyUsage = parent.numOfUsages + subcomponents.reduce((sum, c) => sum + c.numOfUsages, 0);

    return { subcomponents, familyUsage };
}

export class CustomPropertyRequiredForAnalysis extends ServiceError {
    constructor() {
        super("Custom property value required for given analysis subject");
    }
}

export function checkCustomPropertyRequirementForAnalysisSubject(analysisSubject: AnalysisSubject | undefined, customProperty: string | undefined): customProperty is string {
    if (analysisSubject === AnalysisSubject.CustomProperties && customProperty === undefined) {
        throw new CustomPropertyRequiredForAnalysis();
    }

    return true;
}

export async function getCustomProperties(workspaceId: string): Promise<Record<string, (string | number | boolean | Date)[]>> {
    const latestAnalysisId = await getLatestIndexAnalysisId(workspaceId);
    if (!latestAnalysisId) {
        return {};
    }

    const customPropertiesResult = await HistoricComponentIndexModel.aggregate<Record<string, string | number | boolean | Date>>(
        [
            {
                $match: {
                    lastAnalysis: new MongooseTypes.ObjectId(latestAnalysisId),
                },
            },
            {
                $unwind: {
                    path: "$entries",
                },
            },
            {
                $match: {
                    "entries.component.metadata": { $exists: true, $type: "object" },
                },
            },
            {
                $replaceRoot: {
                    newRoot: "$entries.component.metadata",
                },
            },
        ],
    ).exec();

    const customProperties: Record<string, Set<string | number | boolean | Date>> = {};
    for (const result of customPropertiesResult) {
        for (const [k, v] of Object.entries(result)) {
            if (k in customProperties) {
                customProperties[k].add(v);
            } else {
                customProperties[k] = new Set([v]);
            }
        }
    }

    return Object.fromEntries(
        Object.entries(customProperties).map(([k, vs]) =>
            [k, [...vs]]
        )
    );
}

export class DependencyGraphNotFound extends ServiceError {
    constructor({ workspaceId, componentDefinitionId }: { workspaceId: string; componentDefinitionId?: string; }) {
        super("Dependency graph document not found", {
            details: {
                workspaceId,
                componentDefinitionId,
            },
        });
    }
}


export class DependencyGraph {
    components: Component[];
    dependencies: [string, string][];

    constructor(components: Component[], dependencies: [string, string][]) {
        this.components = components;
        this.dependencies = dependencies;
    }

    toResponse() {
        return {
            components: this.components.map(c => c.toResponse()),
            dependencies: this.dependencies,
        };
    }
}

function generateAdjacencyMap(graphDocs: DependencyGraphDoc[], historicComponentIndexEntries: HistoricComponentIndexDoc["entries"]): AdjacencyMap {
    const adjacencyMap: Record<string, { successors: string[]; predecessors: string[]; }> = Object.fromEntries(
        [...new Set(graphDocs.flatMap(g => Array.from(g.predecessors.keys())))].map(definitionId => [
            definitionId,
            {
                successors: [],
                predecessors: [],
            },
        ])
    );

    const idMap = Object.fromEntries(historicComponentIndexEntries.flatMap(({ definitionId, originalDefinitionIds }) =>
        originalDefinitionIds.map(originalDefinitionId => [originalDefinitionId, definitionId])
    ));

    for (const graphDoc of graphDocs) {
        for (const [componentId, predecessorList] of graphDoc.predecessors.entries()) {
            const definitionId = idMap[componentId] ?? componentId;
            const predecessors = predecessorList.map(predecessorId => idMap[predecessorId] ?? predecessorId);
            adjacencyMap[definitionId].predecessors.push(...predecessors);

            for (const predecessor of predecessors) {
                // Temporary fix for missing components due to name collision resolution
                // Optional chain added during transition, remove after new scans in all workspaces
                // Also, check nullish coalescing operators above and remove them if redundant
                adjacencyMap[predecessor]?.successors?.push(definitionId);
            }
        }
    }

    return Object.fromEntries(Object.entries(adjacencyMap).map(([componentId, adjacency]) => [componentId, {
        successors: [...new Set(adjacency.successors)],
        predecessors: [...new Set(adjacency.predecessors)],
    }]));
}

export async function getDependenciesFor(workspaceId: string, componentDefinitionId: string): Promise<DependencyGraph> {
    const latestAnalysisIds = await getLatestAnalysisIdsIn(workspaceId);
    const graphDocs = await DependencyGraphModel.find({ analysis: { $in: latestAnalysisIds } }).sort({ _id: -1 });
    if (graphDocs.length === 0) {
        throw new DependencyGraphNotFound({
            workspaceId,
            componentDefinitionId,
        });
    }

    const latestAnalysis = await getLatestIndexAnalysisId(workspaceId);
    const indexDocuments = await HistoricComponentIndexModel.find(
        { workspace: workspaceId, lastAnalysis: latestAnalysis },
        {
            "entries.definitionId": 1,
            "entries.originalDefinitionIds": 1,
        }).lean();
    const entries = indexDocuments.flatMap(doc => doc.entries);

    // If this happens to cause a performance issue,
    // we can optimize this by caching consolidated DG in a separate collection.
    const adjacencyMap = generateAdjacencyMap(graphDocs, entries);
    const subgraph = findSubgraph(adjacencyMap, componentDefinitionId);
    const components = await findLatestComponentsByDefinitionId(workspaceId, subgraph.nodes);
    const dependencies = subgraph.edges;

    return new DependencyGraph(components, dependencies);
}

export type ComponentUsage = CliComponentUsage & {
    component: Pick<ComponentDoc, "definitionId" | "path" | "packageName" | "name"> & {
        id: string;
    };
};


function getAggregationStagesForFetchingComponentUsages(workspaceId: string, latestAnalysisId: string, componentDefinitionId: string, populateParentComponent = false): PipelineStage[] {
    return [
        {
            $match: {
                workspace: new MongooseTypes.ObjectId(workspaceId),
                lastAnalysis: new MongooseTypes.ObjectId(latestAnalysisId),
            },
        },
        {
            $unwind: {
                path: "$entries",
            },
        },
        {
            $match: {
                "entries.definitionId": componentDefinitionId,
            },
        },
        {
            $project: {
                _id: 0,
                childDefinitionIds: "$entries.originalDefinitionIds",
                parentIds: "$entries.usingComponents._id",
            },
        },
        {
            $lookup: {
                from: COMPONENT_DEPENDENCY_COLLECTION_NAME,
                localField: "parentIds",
                foreignField: "parentId",
                let: {
                    childDefinitionIds: "$childDefinitionIds",
                },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $in: [
                                    "$childDefinitionId",
                                    "$$childDefinitionIds",
                                ],
                            },
                        },
                    },
                ],
                as: "dependencies",
            },
        },
        {
            $project: {
                dependencies: 1,
            },
        },
        {
            $unwind: {
                path: "$dependencies",
            },
        },
        ...(
            populateParentComponent
                ? [
                    {
                        $lookup: {
                            from: COMPONENT_COLLECTION_NAME,
                            localField: "dependencies.parentId",
                            foreignField: "_id",
                            pipeline: [{
                                $project: {
                                    _id: 0,
                                    id: {
                                        $toString: "$_id",
                                    },
                                    definitionId: 1,
                                    path: 1,
                                    packageName: 1,
                                    name: 1,
                                },
                            }],
                            as: "parentComponent",
                        },
                    },
                ]
                : []
        ),
        {
            $unwind: {
                path: "$dependencies.usages",
            },
        },
        {
            $replaceRoot: {
                newRoot: (
                    populateParentComponent
                        ? {
                            $mergeObjects: [
                                "$dependencies.usages",
                                {
                                    component: {
                                        $first: "$parentComponent",
                                    },
                                },
                            ],
                        } : "$dependencies.usages"
                ),
            },
        },
    ];
}


export interface ComponentUsagesResult {
    data: CliComponentUsage[];
    numberOfUsages: number;
}


export async function getComponentUsagesWithParentComponent(
    workspace: Workspace,
    componentDefinitionId: string,
    propName: string,
    propValue?: string,
): Promise<ComponentUsagesResult> {
    const latestAnalysisId = await getLatestIndexAnalysisId(workspace.id);
    if (!latestAnalysisId) {
        return {
            data: [],
            numberOfUsages: 0,
        };
    }
    const usages = await HistoricComponentIndexModel.aggregate<ComponentUsage>(
        getAggregationStagesForFetchingComponentUsages(workspace.id, latestAnalysisId, componentDefinitionId, true)
    ).exec();

    const filteredUsages = usages.filter(({ props }) => {
        if (propValue === undefined) {
            return props.some(({ name }) => name === propName);
        }

        if (propValue === PROP_NOT_SET_NAME) {
            return props.every(({ name }) => name !== propName);
        }

        return props.some(({ value, name }) => name === propName && propValueToName(value) === propValue);
    });

    return {
        data: filteredUsages,
        numberOfUsages: filteredUsages.length,
    };
}

async function getComponentUsages(workspaceId: string, componentDefinitionId: string): Promise<CliComponentUsage[]> {
    const latestAnalysisId = await getLatestIndexAnalysisId(workspaceId);

    if (!latestAnalysisId) {
        return [];
    }

    return HistoricComponentIndexModel.aggregate<CliComponentUsage>(
        getAggregationStagesForFetchingComponentUsages(workspaceId, latestAnalysisId, componentDefinitionId, false),
    ).exec();
}

async function getComponentPropsFromDb(workspaceId: string, componentDefinitionId: string): Promise<ComponentPropDoc[]> {
    const latestAnalysisId = await getLatestIndexAnalysisId(workspaceId);

    if (!latestAnalysisId) {
        return [];
    }
    return HistoricComponentIndexModel.aggregate<ComponentPropDoc>([
        {
            $match: {
                workspace: new MongooseTypes.ObjectId(workspaceId),
                lastAnalysis: new MongooseTypes.ObjectId(latestAnalysisId),
            },
        },
        {
            $unwind: {
                path: "$entries",
            },
        },
        {
            $match: {
                "entries.definitionId": componentDefinitionId,
            },
        },
        {
            $lookup: {
                from: COMPONENT_COLLECTION_NAME,
                localField: "entries.component._id",
                foreignField: "_id",
                pipeline: [
                    {
                        $project: {
                            props: 1,
                        },
                    },
                ],
                as: "component",
            },
        },
        {
            $unwind: {
                path: "$component",
            },
        },
        {
            $unwind: {
                path: "$component.props",
            },
        },
        {
            $replaceRoot: {
                newRoot: "$component.props",
            },
        },
    ]).exec();
}

function propValueToName(value: PropValue): string {
    switch (value.type) {
        case PropValueType.Null:
            return "null";
        case PropValueType.String:
            return `"${value.value}"`;
        case PropValueType.Number:
        case PropValueType.Bool:
            return value.value.toString();
        case PropValueType.Regex:
            return `/${value.value}/${value.flags}`;
        case PropValueType.Identifier:
            return value.value === "undefined" ? "undefined" : "dynamic";
        case PropValueType.JSXElement:
        case PropValueType.Function:
        case PropValueType.Getter:
        case PropValueType.Setter:
        case PropValueType.Object:
        case PropValueType.Array:
        case PropValueType.Spread:
        case PropValueType.Member:
        case PropValueType.This:
        case PropValueType.Super:
        case PropValueType.TemplateLiteral:
        case PropValueType.Expression:
            return "dynamic";
    }
}

interface ComponentPropsResult {
    numberOfUsages: number;
    props: {
        name: string;
        defaultValue?: PropValue;
        numberOfUsages: number;
        numberOfValues: number;
        values: {
            name: string;
            numberOfUsages: number;
        }[];
    }[];
}

export async function getComponentProps(workspace: Workspace, componentDefinitionId: string): Promise<ComponentPropsResult> {
    const [usages, props] = await Promise.all([
        getComponentUsages(workspace.id, componentDefinitionId),
        getComponentPropsFromDb(workspace.id, componentDefinitionId),
    ]);

    const propNames = new Set([
        ...props.map(({ name }) => name),
        ...usages.flatMap(({ props }) => props.map(({ name }) => name)).filter(Boolean),
    ]);

    const defaultValueMap = new Map(props.map(({ name, defaultValue }) => [name, defaultValue]));
    const propMap = new Map([...propNames].map(propName => [
        propName,
        {
            name: propName,
            defaultValue: defaultValueMap.get(propName),
            valueMap: new Map<string, number>(),
        },
    ]));

    for (const { props } of usages) {
        const usageMap = new Map(props.map(({ name, value }) => [name, propValueToName(value)]));

        for (const propName of propNames) {
            const value = usageMap.get(propName) ?? PROP_NOT_SET_NAME;
            const { valueMap } = propMap.get(propName)!;
            valueMap.set(value, (valueMap.get(value) ?? 0) + 1);
        }
    }

    return {
        props: [...propMap.values()].map(
            ({ name, defaultValue, valueMap }) => ({
                name,
                defaultValue,
                numberOfUsages: usages.length - (valueMap.get(PROP_NOT_SET_NAME) ?? 0),
                values: [...valueMap].map(
                    ([name, numberOfUsages]) => ({
                        name,
                        numberOfUsages,
                    })
                ).sort((a, b) => b.numberOfUsages - a.numberOfUsages),
                numberOfValues: valueMap.size,
            })
        ),
        numberOfUsages: usages.length,
    };
}

export { csvHeader as CSV_HEADER };

interface AnalyseLatestDataArgs {
    workspace: Workspace;
    lastAnalysis: string;
    analysisSubject: AnalysisSubject;
    customProperty?: string;
    filters: DataAnalysisFilter;
    breakdownType?: BreakdownType;
}

export async function analyseLatestDataAsChartData({
    workspace,
    lastAnalysis,
    analysisSubject,
    customProperty,
    filters,
    breakdownType,
}: AnalyseLatestDataArgs): Promise<ChartDatum[]> {
    const projectMap = Object.fromEntries(workspace.projects.map(p => [p.packageName, p]));

    const tags = await workspace.tagsToResponse();
    const allTags = [...tags, RESERVED_TAGS.UNTAGGED] as Tag[];
    const tagMap = Object.fromEntries(allTags.map(t => [t.slug, t]));

    const dataAnalysis = await runDataAnalysis(lastAnalysis, {
        analysisSubject,
        customProperty,
        filters,
        breakdownType,
    });

    return transformLatestDataAnalysisToChartData({
        analysis: dataAnalysis,
        projectMap,
        tagMap,
        workspaceSlug: workspace.slug,
        analysisSubject,
        customProperty,
        breakdownType,
    });
}

export async function analyseLatestDataAsCSV({
    workspace,
    lastAnalysis,
    analysisSubject,
    customProperty,
    filters,
    breakdownType,
}: AnalyseLatestDataArgs): Promise<string> {
    const dataAnalysis = await runDataAnalysis(lastAnalysis, {
        analysisSubject,
        customProperty,
        filters,
        breakdownType,
    });

    const tags = await workspace.tagsToResponse();
    const allTags = [...tags, RESERVED_TAGS.UNTAGGED] as Tag[];
    const tagMap = Object.fromEntries(allTags.map(t => [t.slug, t]));
    const projectMap = Object.fromEntries(workspace.projects.map(p => [p.packageName, p]));

    return transformLatestDataAnalysisToCSV(dataAnalysis, tagMap, projectMap, customProperty);
}

function getAnalysisIdsForEachGroup(docs: Pick<HistoricComponentIndexDoc, "lastAnalysis" | "analyzedAt">[], groupBy: (date: Date) => string): string[] {
    const analysisIdMap: Record<string, string> = {};
    for (const doc of docs) {
        const key = groupBy(doc.analyzedAt);
        if (!(key in analysisIdMap)) {
            analysisIdMap[key] = doc.lastAnalysis.toHexString();
        }
    }

    return Object.values(analysisIdMap);
}

function getLatestAnalysisIds(docs: Pick<HistoricComponentIndexDoc, "lastAnalysis" | "analyzedAt">[], frequency?: DataFrequencyOption): string[] {
    const groupByMethod = getGroupByMethod(frequency);
    return getAnalysisIdsForEachGroup(docs, groupByMethod);
}

interface AnalyseTimeSeriesDataArgs {
    workspace: Workspace;
    analysisSubject: AnalysisSubject;
    customProperty?: string;
    filters: DataAnalysisFilter;
    timeSeriesFilter: TimeSeriesFilter;
}

async function analyseTimeSeriesData({
    workspace,
    analysisSubject,
    customProperty,
    filters,
    timeSeriesFilter,
}: AnalyseTimeSeriesDataArgs): Promise<Record<string, Record<string, DataAnalysis[]>>> {
    const { frequency, timeWindow } = timeSeriesFilter;


    const analyzedAtFilter = getAnalyzedAtFilter(timeWindow);

    const indexDocs = await HistoricComponentIndexModel.find<Pick<HistoricComponentIndexDoc, "lastAnalysis" | "analyzedAt">>(
        {
            workspace: new MongooseTypes.ObjectId(workspace.id),
            ...analyzedAtFilter,
        },
        { _id: 0, lastAnalysis: 1, analyzedAt: 1 },
    ).sort({ analyzedAt: -1 }).lean();

    if (indexDocs.length === 0) {
        return {};
    }

    const analyses: Record<string, Record<string, DataAnalysis[]>> = {};
    // Get the latest analysis ids by grouping them by given frequency
    let latestAnalysisIds = getLatestAnalysisIds(indexDocs, frequency);

    // If the number of analysis ids is too large, we need to group them by week
    if (latestAnalysisIds.length > 100) {
        latestAnalysisIds = getAnalysisIdsForEachGroup(indexDocs, toISOWeekString);
    }
    const latestAnalysisIdsLength = latestAnalysisIds.length;
    for (let i = 0; i < latestAnalysisIdsLength; i += config.TIME_SERIES_CHUNK_SIZE) {
        const chunk = latestAnalysisIds.slice(i, i + config.TIME_SERIES_CHUNK_SIZE);
        const chunkResults = await Promise.all(
            chunk.map(analysisId => runDataAnalysis(analysisId,
                {
                    analysisSubject,
                    customProperty,
                    filters,
                },
            ))
        );

        Object.assign(
            analyses,
            Object.fromEntries(
                chunkResults.map((result, index) => [new MongooseTypes.ObjectId(chunk[index]).getTimestamp().toISOString(), result])
            )
        );
    }

    return analyses;
}

export async function analyseTimeSeriesDataAsChartData({
    workspace,
    analysisSubject,
    customProperty,
    filters,
    timeSeriesFilter,
}: AnalyseTimeSeriesDataArgs): Promise<ChartDatum[]> {
    const analyses = await analyseTimeSeriesData({
        workspace,
        analysisSubject,
        customProperty,
        filters,
        timeSeriesFilter,
    });

    const tags = await workspace.tagsToResponse();
    const allTags = [...tags, RESERVED_TAGS.UNTAGGED] as Tag[];
    const tagMap = Object.fromEntries(allTags.map(t => [t.slug, t]));
    const projectMap = Object.fromEntries(workspace.projects.map(p => [p.packageName, p]));

    return transformOverTimeDataAnalysisToChartData(analyses, projectMap, tagMap, analysisSubject);
}

export async function analyseTimeSeriesDataAsCSV({
    workspace,
    analysisSubject,
    customProperty,
    filters,
    timeSeriesFilter,
}: AnalyseTimeSeriesDataArgs): Promise<string> {
    const analyses = await analyseTimeSeriesData({
        workspace,
        analysisSubject,
        customProperty,
        filters,
        timeSeriesFilter,
    });

    const tags = await workspace.tagsToResponse();
    const allTags = [...tags, RESERVED_TAGS.UNTAGGED] as Tag[];
    const tagMap = Object.fromEntries(allTags.map(t => [t.slug, t]));
    const projectMap = Object.fromEntries(workspace.projects.map(p => [p.packageName, p]));

    return transformOverTimeDataAnalysisToCSV(analyses, tagMap, projectMap, customProperty);
}

export interface UnusedComponentPropResult {
    propName: string;
    sumOfUsages: number;
    component: Pick<Component, "id" | "name" | "definitionId" | "packageName">;
}

export async function getUnusedComponentProps(workspaceId: string, { limit }: { limit?: number; } = {}): Promise<UnusedComponentPropResult[]> {
    const latestAnalysisId = await getLatestIndexAnalysisId(workspaceId);
    if (!latestAnalysisId) {
        return [];
    }
    return HistoricComponentIndexModel.aggregate<UnusedComponentPropResult>([
        {
            $match: {
                workspace: new MongooseTypes.ObjectId(workspaceId),
                lastAnalysis: new MongooseTypes.ObjectId(latestAnalysisId),
            },
        },
        {
            $unwind: {
                path: "$entries",
            },
        },
        {
            $project: {
                component: {
                    _id: "$entries.component._id",
                    name: "$entries.component.name",
                    definitionId: "$entries.component.definitionId",
                    packageName: "$entries.component.packageName",
                },
                childDefinitionIds: "$entries.originalDefinitionIds",
                parentIds: "$entries.usingComponents._id",
            },
        },
        {
            $lookup: {
                from: COMPONENT_COLLECTION_NAME,
                localField: "component._id",
                foreignField: "_id",
                pipeline: [
                    {
                        $project: {
                            _id: 0,
                            props: 1,
                        },
                    },
                ],
                "as": "components",
            },
        },
        // Filter out components with no props from the pipeline
        {
            $match: {
                "components.0.props.0": { $exists: true },
            },
        },
        {
            $lookup: {
                from: COMPONENT_DEPENDENCY_COLLECTION_NAME,
                localField: "parentIds",
                foreignField: "parentId",
                let: {
                    childDefinitionIds: "$childDefinitionIds",
                },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $in: [
                                    "$childDefinitionId",
                                    "$$childDefinitionIds",
                                ],
                            },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            usages: {
                                props: {
                                    name: 1,
                                },
                            },
                        },
                    },
                ],
                as: "dependencies",
            },
        },
        {
            $addFields: {
                propName: {
                    $map: {
                        input: {
                            $getField: {
                                input: {
                                    $first: "$components",
                                },
                                field: "props",
                            },
                        },
                        "as": "prop",
                        "in": "$$prop.name",
                    },
                },
            },
        },
        {
            $unwind: {
                path: "$propName",
            },
        },
        {
            $addFields: {
                usedProps: {
                    $reduce: {
                        input: "$dependencies",
                        initialValue: [],
                        "in": {
                            $concatArrays: [
                                "$$value",
                                {
                                    $reduce: {
                                        input: "$$this.usages",
                                        initialValue: [],
                                        "in": {
                                            $concatArrays: [
                                                "$$value",
                                                {
                                                    $map: {
                                                        input: "$$this.props",
                                                        "as": "prop",
                                                        "in": "$$prop.name",
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
                sumOfUsages: {
                    $reduce: {
                        input: "$dependencies",
                        initialValue: 0,
                        "in": {
                            $add: [
                                "$$value",
                                {
                                    $size: "$$this.usages",
                                },
                            ],
                        },
                    },
                },
            },
        },
        {
            $match: {
                sumOfUsages: {
                    $gt: 0,
                },
                $expr: {
                    $not: {
                        $in: [
                            "$propName",
                            "$usedProps",
                        ],
                    },
                },
            },
        },
        {
            $project: {
                propName: 1,
                sumOfUsages: 1,
                component: {
                    id: {
                        $toString: "$component._id",
                    },
                    name: "$component.name",
                    definitionId: "$component.definitionId",
                    packageName: "$component.packageName",
                },
            },
        },
        {
            $sort: {
                sumOfUsages: -1,
            },
        },
        ...(limit === undefined ? [] : [{ $limit: limit }]),
    ]).exec();
}

export type { DataAnalysisFilter };

export async function purgeAllComponentDataForAnalysis(workspaceId: string, analysisId: string) {
    const analysis = new MongooseTypes.ObjectId(analysisId);
    const workspace = new MongooseTypes.ObjectId(workspaceId);

    await Promise.all([
        HistoricComponentIndexModel.softDeleteMany({
            lastAnalysis: analysis,
            workspace,
        }),
        ComponentModel.softDeleteMany({
            workspace,
            analysis,
        }),
        ComponentExportIdsModel.softDeleteMany({
            workspace,
            analysis,
        }),
        ComponentDependencyModel.softDeleteMany({
            workspace,
            analysis,
        }),
        DependencyGraphModel.softDeleteMany({
            workspace,
            analysis,
        }),
    ]);
}

export async function purgeAllComponentDataForWorkspace(workspaceId: string) {
    const workspace = new MongooseTypes.ObjectId(workspaceId);

    await Promise.all([
        HistoricComponentIndexModel.softDeleteMany({
            workspace,
        }),
        ComponentModel.softDeleteMany({
            workspace,
        }),
        ComponentExportIdsModel.softDeleteMany({
            workspace,
        }),
        ComponentDependencyModel.softDeleteMany({
            workspace,
        }),
        DependencyGraphModel.softDeleteMany({
            workspace,
        }),
    ]);
}

type IndexDocFieldFilter = keyof HistoricComponentIndexDoc;
export async function findUniqueComponentIndexesByAnalysisId<F extends IndexDocFieldFilter>(workspaceId: string, analysisId: string, { fields }: { fields?: { [key in F]: 1 | 0; }; }) {
    const indexDocs = (await HistoricComponentIndexModel.find(
        {
            workspace: new MongooseTypes.ObjectId(workspaceId),
            analysisIds: new MongooseTypes.ObjectId(analysisId),
        },
        fields,
        {
            readPreference: mongoose.mongo.ReadPreference.PRIMARY,
            sort: { analyzedAt: 1 },
        }
    )) as unknown as HistoricComponentIndexDoc[];

    const uniqueIndexDocs = new Map<string, HistoricComponentIndexDoc>();
    indexDocs.forEach(doc => {
        const key = doc.lastAnalysis.toString();
        uniqueIndexDocs.set(key, doc);
    });

    return Array.from(uniqueIndexDocs.values())
        .sort((a, b) => a.analyzedAt.getTime() - b.analyzedAt.getTime());
}

export async function findUniqueComponentIndexesByAnalysisIds<F extends IndexDocFieldFilter>(workspaceId: string, analysisIds: string[], { fields }: { fields?: { [key in F]: 1 | 0; }; }) {
    const indexDocs = (await HistoricComponentIndexModel.find(
        {
            workspace: new MongooseTypes.ObjectId(workspaceId),
            analysisIds: { $in: analysisIds.map(id => new MongooseTypes.ObjectId(id)) },
        },
        fields,
        {
            readPreference: mongoose.mongo.ReadPreference.PRIMARY,
            sort: { analyzedAt: 1 },
        }
    )) as unknown as HistoricComponentIndexDoc[];

    const uniqueIndexDocs = new Map<string, HistoricComponentIndexDoc>();
    indexDocs.forEach(doc => {
        const key = doc.lastAnalysis.toString();
        uniqueIndexDocs.set(key, doc);
    });

    return Array.from(uniqueIndexDocs.values())
        .sort((a, b) => a.analyzedAt.getTime() - b.analyzedAt.getTime());
}

export async function deleteComponentIndex(workspaceId: string, analysisId: string): Promise<void> {
    await HistoricComponentIndexModel.softDeleteMany({
        workspace: new MongooseTypes.ObjectId(workspaceId),
        lastAnalysis: new MongooseTypes.ObjectId(analysisId),
    });
}

export async function recalculateTags(workspaceId: string, analysisId: string): Promise<void> {
    await HistoricComponentIndexModel.recalculateTags({
        workspace: new MongooseTypes.ObjectId(workspaceId),
        lastAnalysis: new MongooseTypes.ObjectId(analysisId),
    });
}

export async function createWorkspaceIndex(
    workspaceId: string,
    analysisIdsByPackage: Record<string, MongooseTypes.ObjectId>,
    lastAnalysis: MongooseTypes.ObjectId,
    analyzedAt: Date
) {
    await ComponentModel.createWorkspaceIndex({
        workspaceId,
        analysisIdsByPackage,
        lastAnalysis,
        analyzedAt,
    });
}

export async function getComponentCountsForAnalysis(workspaceId: string, analysisId: string, analyzedAt: Date) {
    const workspace = new MongooseTypes.ObjectId(workspaceId);
    const [previousIndexDoc] = await HistoricComponentIndexModel.find({
        workspace,
        analyzedAt: { $lt: analyzedAt },
    }, {
        lastAnalysis: 1,
    }).sort({ analyzedAt: -1 }).limit(1).lean().exec();


    const firstIndexDocs = await HistoricComponentIndexModel.find({
        lastAnalysis: previousIndexDoc ? previousIndexDoc.lastAnalysis : null,
    }, { "entries.definitionId": 1 }).lean().exec();

    const secondIndexDocs = await HistoricComponentIndexModel.find({
        workspace,
        lastAnalysis: analysisId,
    }, { "entries.definitionId": 1 }).lean().exec();

    const counts = {
        added: 0,
        deleted: 0,
        total: 0,
        updated: 0,
    };

    const firstIndexDefinitionIds = new Set(firstIndexDocs.flatMap(doc => {
        return doc.entries.map(entry => entry.definitionId);
    }));
    const secondIndexDefinitionIds = new Set(secondIndexDocs.flatMap(doc => {
        return doc.entries.map(entry => entry.definitionId);
    }));

    const allDefinitionIds = new Set([...firstIndexDefinitionIds, ...secondIndexDefinitionIds]);

    allDefinitionIds.forEach(entry => {
        if (firstIndexDefinitionIds.has(entry) && secondIndexDefinitionIds.has(entry)) {
            counts.updated++;
        } else if (firstIndexDefinitionIds.has(entry)) {
            counts.deleted++;
        } else if (secondIndexDefinitionIds.has(entry)) {
            counts.added++;
        }
    });

    counts.total = secondIndexDefinitionIds.size;
    return counts;
}

export function getProjectsByAnalysisId(analysisId: MongooseTypes.ObjectId): Promise<{ name: string; packageName: string; isInternal: boolean; }[]> {
    return HistoricComponentIndexModel.aggregate<Omit<ProjectDoc, "slug">>(
        [
            {
                $match: {
                    lastAnalysis: analysisId,
                },
            },
            {
                $unwind: {
                    path: "$entries",
                },
            },
            {
                $group: {
                    _id: "$entries.component.packageName",
                    isInternal: {
                        $max: "$entries.component.isInternal",
                    },
                    analysisIds: {
                        $first: "$analysisIds",
                    },
                },
            },
            {
                $lookup: {
                    from: "analyses",
                    localField: "analysisIds",
                    foreignField: "_id",
                    let: {
                        packageName: "$_id",
                    },
                    pipeline: [
                        { $match: { $expr: { $in: ["$$packageName", "$packageNames"] } } },
                        { $sort: { createdAt: -1 } },
                        { $limit: 1 },
                    ],
                    as: "analysis",
                },
            },
            {
                $project: {
                    _id: null,
                    name: "$_id",
                    packageName: "$_id",
                    isInternal: "$isInternal",
                    repository: {
                        $getField: {
                            field: "repository",
                            input: {
                                $first: "$analysis",
                            },
                        },
                    },
                },
            },
        ],
        { readPreference: mongoose.mongo.ReadPreference.PRIMARY },
    ).exec();
}

export async function getNumOfComponentsByAnalysisId(analysisId: MongooseTypes.ObjectId): Promise<number> {
    const [result] = await HistoricComponentIndexModel.aggregate<{ count: number; }>(
        [
            {
                $match: {
                    lastAnalysis: analysisId,
                },
            },
            {
                $group: {
                    _id: null,
                    count: { $sum: { $size: "$entries" } },
                },
            },
        ],
        { readPreference: mongoose.mongo.ReadPreference.PRIMARY },
    ).exec();
    return result?.count ?? 0;
}

export { RESERVED_TAGS };

