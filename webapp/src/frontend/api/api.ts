import contentType from "content-type";

import { type AnalysisSubject } from "../../common/models/AnalysisSubject";
import { type AnalysisType } from "../../common/models/AnalysisType";
import { type BreakdownType } from "../../common/models/BreakdownType";
import { type ChartDatum } from "../../common/models/ChartDatum";
import { type Filter, fromTagFilter, intoDataAnalysisFilter, intoTagFilters } from "../../common/models/Filter";
import { isFolderFilterEmpty, type FolderFilter } from "../../common/models/FolderFilter";
import { type Tag } from "../../common/models/Tag";
import { type TagFilter } from "../../common/models/TagFilter";
import { type TimeSeriesFilter } from "../../common/models/TimeSeriesFilter";
import { type TreeNodeProps, TreeNode } from "../../common/models/TreeNode";
import { config } from "../../config/frontend";
import { type AccessLevel } from "../models/AccessLevel";
import { type AnalysesResponse } from "../models/AnalysesResponse";
import { type Analysis } from "../models/Analysis";
import { type APIResponse } from "../models/APIResponse";
import { type AuthProviders } from "../models/AuthProviders";
import { type Component } from "../models/Component";
import { type ComponentProps } from "../models/ComponentProps";
import { type ComponentsResponse } from "../models/ComponentsResponse";
import { type ComponentUsage } from "../models/ComponentUsage";
import { type DataIssue } from "../models/DataIssue";
import { type DependencyGraph } from "../models/DependencyGraph";
import { type FoldersResponse } from "../models/FoldersResponse";
import { type GetAnalysesParams } from "../models/GetAnalysesParams";
import { type GetDataAnalysisParams } from "../models/GetDataAnalysisParams";
import { type GetLatestAnalysisComponentsParams } from "../models/GetLatestAnalysisComponentsParams";
import { type Invite } from "../models/Invite";
import { type InviteResponse } from "../models/InviteResponse";
import { type Member } from "../models/Member";
import { type PaginatedResponse } from "../models/PaginatedResponse";
import { type SavedChart } from "../models/SavedChart";
import { type SharedPage } from "../models/SharedPage";
import { type UnusedComponentPropResult } from "../models/UnusedComponentPropResult";
import { type User } from "../models/User";
import { type Workspace } from "../models/Workspace";
import { type WorkspaceJoinRequest } from "../models/WorkspaceJoinRequest";
import { type WorkspaceSlugSuggestionResponse } from "../models/WorkspaceSlugSuggestionResponse";
import { isDateArray, isValidDate } from "../utils";

import { http } from "./http";
import { buildGetDataAnalysisURL } from "./urlBuilder";

export enum APIErrorCode {
    UNAUTHORIZED = "unauthorized",
    FORBIDDEN = "forbidden",
    BAD_REQUEST = "bad-request",
    REQUEST_TOO_LONG = "request-too-long",
    CLI_NOT_SUPPORTED = "cli-not-supported",
    USER_NOT_FOUND = "user-not-found",
    WORKSPACE_NOT_FOUND = "workspace-not-found",
    WORKSPACE_SLUG_NOT_AVAILABLE = "workspace-slug-not-available",
    WORKSPACE_ALREADY_SETUP = "workspace-already-setup",
    SHARED_PAGE_NOT_FOUND = "shared-page-not-found",
    JOIN_REQUEST_ALREADY_EXISTS = "join-request-already-exists",
    USER_NOT_HAVE_WORKSPACE = "user-not-have-workspace",
    USER_ALREADY_HAS_WORKSPACE = "user-already-has-workspace",
    USER_ALREADY_MEMBER = "user-already-member",
    USER_ALREADY_INVITED = "user-already-invited",
    TAG_NOT_FOUND = "tag-not-found",
    SAVED_CHART_NOT_FOUND = "saved-chart-not-found",
    LOCKED = "locked",
}

interface ErrorResponse {
    code: APIErrorCode;
    title: string;
    detail: string;
    meta?: Record<string, unknown>;
}

export class APIError extends Error {
    readonly meta?: Record<string, unknown>;
    readonly code: APIErrorCode;
    readonly title: string;
    readonly detail: string;
    constructor(data: ErrorResponse) {
        super("API request failed");
        this.code = data.code;
        this.title = data.title;
        this.detail = data.detail;
        this.meta = data.meta;
    }
}

const base = "/api";

async function handleResponse<T>(response: Response): Promise<T> {
    const contentTypeHeader = response.headers.get("Content-Type");

    if (contentTypeHeader === null) {
        throw new APIError({
            code: APIErrorCode.BAD_REQUEST,
            title: "Could not parse response",
            detail: "Content-Type header is missing",
        });
    }
    const parsedContentType = contentType.parse(contentTypeHeader) ;

    const res = parsedContentType.type === "application/json"
        ? await response.json() as T | ErrorResponse
        : await response.text();

    if (response.ok) {
        return res as T;
    }

    throw new APIError(res as ErrorResponse);
}

async function handleEmptyResponse(response: Response): Promise<void> {
    if (response.ok) {
        return;
    }

    const error = await response.json() as ErrorResponse;
    throw new APIError(error);
}

interface RawComponent extends Omit<Component, "createdAt" | "updatedAt" | "lastUsageChangedAt"> {
    createdAt?: string;
    updatedAt?: string;
    lastUsageChangedAt: string;
}

interface RawComponentsResponse extends PaginatedResponse {
    components: RawComponent[];
}

function transformMetadata(metadata?: Record<string, string | number | boolean | Date>): Record<string, string | number | boolean | Date> | undefined {
    if (metadata === undefined) {
        return undefined;
    }

    return Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => {
            let convertedValue = value;
            if (value instanceof Date || (typeof value === "string" && isValidDate(value))) {
                convertedValue = new Date(value);
            }

            return [key, convertedValue];
        })
    );
}

function transformComponent(component: RawComponent): Component {
    return {
        ...component,
        createdAt: component.createdAt === undefined ? undefined : new Date(component.createdAt),
        updatedAt: component.updatedAt === undefined ? undefined : new Date(component.updatedAt),
        lastUsageChangedAt: new Date(component.lastUsageChangedAt),
        metadata: transformMetadata(component.metadata),
    };
}

interface RawTag extends Omit<Tag, "createdAt" | "updatedAt" | "selectedTreeNodes" | "deselectedTreeNodes" | "filters">{
    createdAt: string;
    updatedAt: string;
    selectedTreeNodes: TreeNodeProps[];
    deselectedTreeNodes: TreeNodeProps[];
    filters: TagFilter[];
}

function transformTag(raw: RawTag): Tag {
    return {
        ...raw,
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
        selectedTreeNodes: raw.selectedTreeNodes.map(n => new TreeNode(n)),
        deselectedTreeNodes: raw.deselectedTreeNodes.map(n => new TreeNode(n)),
        filters: raw.filters.map(filter => fromTagFilter(filter)),
    };
}

interface RawWorkspace extends Omit<Workspace, "tags"> {
    tags: RawTag[];
}

function transformWorkspace(raw: RawWorkspace): Workspace {
    return {
        ...raw,
        tags: raw.tags.map(transformTag),
    };
}

type RawAnalysis = Omit<Analysis, "createdAt" | "updatedAt"> & {
    createdAt: string;
    updatedAt: string;
};

function transformAnalysis(raw: RawAnalysis): Analysis {
    return {
        ...raw,
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
    };
}

type RawAnalysesResponse = Omit<AnalysesResponse, "analyses"> & {
    analyses: RawAnalysis[];
};

function transformAnalysesResponse(raw: RawAnalysesResponse): AnalysesResponse {
    return {
        ...raw,
        analyses: raw.analyses.map(transformAnalysis),
    };
}

export async function getAuthProviders(): Promise<AuthProviders> {
    const response = await http.get(`${base}/auth-providers`);
    return handleResponse<AuthProviders>(response);
}

export async function getMe(): Promise<User> {
    const response = await http.get(`${base}/users/me`);
    return handleResponse<User>(response);
}

export async function updateUser(update: Partial<Pick<User, "avatarUrl" | "fullName" | "profession">>): Promise<void> {
    const response = await http.patch(`${base}/users/me`, update);
    return handleEmptyResponse(response);
}

export async function getWorkspaceSlugSuggestion(name: string): Promise<WorkspaceSlugSuggestionResponse> {
    const response = await http.get(`${base}/workspaces/slug?${new URLSearchParams({ name }).toString()}`);
    return handleResponse<WorkspaceSlugSuggestionResponse>(response);
}

export async function getWorkspace(workspaceSlug: string): Promise<{ workspace: Workspace; accessLevel: AccessLevel; }> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}`);
    const { workspace, accessLevel } = await handleResponse<{ workspace: RawWorkspace; accessLevel: AccessLevel; }>(response);
    return { workspace: transformWorkspace(workspace), accessLevel };
}

export async function getWorkspaceInviteLinkCode(workspaceSlug: string): Promise<{ code: string; }> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/invite-link-code`);
    return handleResponse<{ code: string; }>(response);
}

export async function resetWorkspaceInviteLinkCode(workspaceSlug: string, code: string): Promise<{ code: string; }> {
    const response = await http.post(`${base}/workspaces/${workspaceSlug}/invite-link-code/${code}/reset`);
    return handleResponse<{ code: string; }>(response);
}

export async function authenticateSharedPage(code: string): Promise<void> {
    const response = await http.get(`${base}/shared-pages/${code}/auth`);
    return handleEmptyResponse(response);
}

export async function invalidateSharedPageAuthentication(): Promise<void> {
    navigator.sendBeacon(`${base}/shared-pages/auth/invalidate`);
}

export async function getSharedPage(workspaceSlug: string, url: string): Promise<SharedPage | null> {
    try {
        const response = await http.get(`${base}/workspaces/${workspaceSlug}/shared-pages/${encodeURIComponent(url)}`);
        return handleResponse<SharedPage>(response);
    } catch (error) {
        if (error instanceof APIError && error.code === APIErrorCode.SHARED_PAGE_NOT_FOUND) {
            return null;
        }

        throw error;
    }
}

export async function createSharedPage(workspaceSlug: string, url: string): Promise<SharedPage> {
    const response = await http.post(`${base}/workspaces/${workspaceSlug}/shared-pages/${encodeURIComponent(url)}`);
    return handleResponse<SharedPage>(response);
}

export async function deleteSharedPage(workspaceSlug: string, url: string): Promise<void> {
    const response = await http.delete(`${base}/workspaces/${workspaceSlug}/shared-pages/${encodeURIComponent(url)}`);
    return handleEmptyResponse(response);
}

export async function createWorkspace(name: string, slug: string): Promise<Workspace> {
    const response = await http.post(`${base}/workspaces`, { name, slug });
    return handleResponse<Workspace>(response);
}

export async function getDefaultWorkspace(): Promise<Workspace | null> {
    try {
        const response = await http.get(`${base}/workspaces/default`);
        return transformWorkspace(await handleResponse<RawWorkspace>(response));
    } catch (error) {
        if (error instanceof APIError && error.code === APIErrorCode.USER_NOT_HAVE_WORKSPACE) {
            return null;
        }

        throw error;
    }
}

export async function getAnalyses(workspaceSlug: string, params?: GetAnalysesParams): Promise<AnalysesResponse> {
    let url = `${base}/workspaces/${workspaceSlug}/analyses`;
    if (params) {
        url += `?${new URLSearchParams({ ...params }).toString()}`;
    }

    const response = await http.get(url);
    return transformAnalysesResponse(await handleResponse<RawAnalysesResponse>(response));
}

export async function deleteAnalysis(workspaceSlug: string, analysisId: string): Promise<void> {
    const response = await http.delete(`${base}/workspaces/${workspaceSlug}/analyses/${analysisId}`);
    return handleEmptyResponse(response);
}

export async function getLatestAnalysisFolders(workspaceSlug: string): Promise<FoldersResponse> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/folders`);
    return handleResponse<FoldersResponse>(response);
}

export async function getLatestAnalysisComponents(
    workspaceSlug: string,
    params: GetLatestAnalysisComponentsParams,
    filters?: Filter[],
    folders?: FolderFilter,
    signal?: AbortSignal,
): Promise<ComponentsResponse> {
    const url = `${base}/workspaces/${workspaceSlug}/components`;

    const requestBody: Record<string, unknown> = {
        ...params,
    };

    if (filters !== undefined && filters.length !== 0) {
        const dataAnalysisFilters = intoDataAnalysisFilter(filters);
        if (dataAnalysisFilters) {
            requestBody.filters = dataAnalysisFilters;
        }
    }

    if (folders !== undefined && !isFolderFilterEmpty(folders)) {
        requestBody.folders = folders;
    }

    const response = await http.post(url, requestBody, { signal });

    const rawResponse = await handleResponse<RawComponentsResponse>(response);
    return {
        ...rawResponse,
        components: rawResponse.components.map(transformComponent),
    };
}

interface CreateTagParams {
    name: string;
    searchTerm?: string;
    selectedTreeNodes?: TreeNode[];
    deselectedTreeNodes?: TreeNode[];
    filters?: Filter[];
}

export async function createWorkspaceTag(workspaceSlug: string, params: CreateTagParams): Promise<Tag[]> {
    let filters;
    if (params.filters !== undefined) {
        filters = intoTagFilters(params.filters);
    }

    const response = await http.post(`${base}/workspaces/${workspaceSlug}/tags`, {
        ...params,
        filters,
    });
    const { tags } = await handleResponse<{ tags: RawTag[]; }>(response);
    return tags.map(transformTag);
}

interface UpdateTagParams {
    name?: string;
    searchTerm?: string;
    selectedTreeNodes?: TreeNode[];
    deselectedTreeNodes?: TreeNode[];
    filters?: Filter[];
}

export async function updateWorkspaceTag(workspaceSlug: string, tagSlug: string, update: UpdateTagParams): Promise<Tag[]> {
    let filters;
    if (update.filters !== undefined) {
        filters = intoTagFilters(update.filters);
    }

    const response = await http.patch(`${base}/workspaces/${workspaceSlug}/tags/${tagSlug}`, {
        ...update,
        filters,
    });
    const { tags } = await handleResponse<{ tags: RawTag[]; }>(response);
    return tags.map(transformTag);
}

export async function deleteWorkspaceTag(workspaceSlug: string, tagSlug: string): Promise<Tag[]> {
    const response = await http.delete(`${base}/workspaces/${workspaceSlug}/tags/${tagSlug}`);
    const { tags } = await handleResponse<{ tags: RawTag[]; }>(response);
    return tags.map(transformTag);
}

export async function setCoreTag(workspaceSlug: string, name: string, folders: FolderFilter): Promise<void> {
    const response = await http.put(
        `${base}/workspaces/${workspaceSlug}/tags/core`,
        {
            name,
            ...folders,
        }
    );
    return handleEmptyResponse(response);
}

function transformCustomProperties(customProperties: Record<string, (string | number | boolean)[]>): Record<string, (string | number | boolean | Date)[]> {
    return Object.fromEntries(
        Object.entries(customProperties).map(([name, values]) => {
            const convertedValues = isDateArray(values)
                ? values.map(value => new Date(value as string))
                : values;

            return [name, convertedValues];
        })
    );
}

export async function getCustomProperties(workspaceSlug: string): Promise<Record<string, (string | number | boolean | Date)[]>> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/custom-properties`);
    const customProperties = await handleResponse<Record<string, (string | number | boolean)[]>>(response);

    return transformCustomProperties(customProperties);
}

export async function getLatestAnalysisComponent(workspaceSlug: string, componentId: string): Promise<Component> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/components/${componentId}`);
    return transformComponent(await handleResponse<RawComponent>(response));
}

export async function getLatestAnalysisComponentDependencies(workspaceSlug: string, componentId: string): Promise<DependencyGraph> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/components/${componentId}/dependencies`);
    return handleResponse<DependencyGraph>(response);
}

interface ComponentUsagesResult {
    data: ComponentUsage[];
}

export async function getLatestAnalysisComponentUsages(workspaceSlug: string, componentId: string, propName: string, propValue?: string): Promise<ComponentUsagesResult> {
    const url = new URL(`${base}/workspaces/${workspaceSlug}/components/${componentId}/usages`, config.APP_BASE_URL);
    url.searchParams.set("prop_name", propName);
    if (propValue !== undefined) {
        url.searchParams.set("prop_value", propValue);
    }
    const response = await http.get(url.toString());
    return handleResponse<ComponentUsagesResult>(response);
}

export async function getLatestAnalysisComponentProps(workspaceSlug: string, componentId: string): Promise<ComponentProps> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/components/${componentId}/props`);
    return handleResponse<ComponentProps>(response);
}

interface SubcomponentsResponse {
    subcomponents: RawComponent[];
    familyUsage: number;
}

export async function getLatestAnalysisComponentSubcomponents(workspaceSlug: string, componentId: string): Promise<{ subcomponents: Component[]; familyUsage: number; }> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/components/${componentId}/subcomponents`);
    const { subcomponents, familyUsage } = await handleResponse<SubcomponentsResponse>(response);
    return {
        subcomponents: subcomponents.map(transformComponent),
        familyUsage,
    };
}

export async function getMembers(workspaceSlug: string): Promise<Member[]> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/members`);
    return handleResponse<Member[]>(response);
}

export async function removeMember(workspaceSlug: string, userId: string): Promise<void> {
    const response = await http.delete(`${base}/workspaces/${workspaceSlug}/members/${userId}`);
    return handleEmptyResponse(response);
}

export async function getInvites(workspaceSlug: string): Promise<Invite[]> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/invites`);
    return handleResponse<Invite[]>(response);
}

export async function inviteUser(workspaceSlug: string, email: string, inviteToScan = false): Promise<InviteResponse> {
    const response = await http.post(`${base}/workspaces/${workspaceSlug}/invites`, { email, inviteToScan });
    return handleResponse<InviteResponse>(response);
}

export async function removeInvite(workspaceSlug: string, inviteId: string): Promise<void> {
    const response = await http.delete(`${base}/workspaces/${workspaceSlug}/invites/${inviteId}`);
    return handleEmptyResponse(response);
}

export async function getWorkspaceJoinRequests(workspaceSlug: string): Promise<WorkspaceJoinRequest[]> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/join-requests`);
    return handleResponse<WorkspaceJoinRequest[]>(response);
}

export async function createWorkspaceJoinRequest(workspaceSlug: string, email: string): Promise<void> {
    const response = await http.post(`${base}/workspaces/${workspaceSlug}/join-requests`, { email });
    return handleEmptyResponse(response);
}

export async function acceptWorkspaceJoinRequest(workspaceSlug: string, joinRequestId: string): Promise<InviteResponse> {
    const response = await http.post(`${base}/workspaces/${workspaceSlug}/join-requests/${joinRequestId}/accept`);
    return handleResponse<InviteResponse>(response);
}

export async function denyWorkspaceJoinRequest(workspaceSlug: string, joinRequestId: string): Promise<void> {
    const response = await http.delete(`${base}/workspaces/${workspaceSlug}/join-requests/${joinRequestId}`);
    return handleEmptyResponse(response);
}

export async function getDataAnalysis(dataAnalysisParams: GetDataAnalysisParams, signal?: AbortSignal): Promise<ChartDatum[]> {
    const url = buildGetDataAnalysisURL(dataAnalysisParams);
    const response = await http.get(url, { signal });

    return handleResponse<ChartDatum[]>(response);
}

export async function getDataAnalysisAsCSV(dataAnalysisParams: GetDataAnalysisParams, signal?: AbortSignal): Promise<string> {
    const url = buildGetDataAnalysisURL(dataAnalysisParams);
    const headers = new Headers({ "Accept": "text/csv" });
    const response = await http.get(url, {
        signal,
        headers,
    });

    return handleResponse<string>(response);
}

export async function getUnusedComponentProps(workspaceSlug: string, params: { limit?: number; } = {}, signal?: AbortSignal): Promise<UnusedComponentPropResult[]> {
    const url = new URL(`${base}/workspaces/${workspaceSlug}/unused-component-props`, config.APP_BASE_URL);
    if ("limit" in params && params.limit !== undefined) {
        url.searchParams.set("limit", params.limit.toString());
    }
    const response = await http.get(url.toString(), { signal });
    return handleResponse<UnusedComponentPropResult[]>(response);
}

interface AuthRequestParams {
    cliCallbackUri?: string;
    redirect?: string;
    cli: boolean;
}

export async function createAuthRequest(email: string, { cliCallbackUri, redirect, cli }: AuthRequestParams): Promise<void> {
    const response = await http.post(`${base}/auth-request`, { email, cliCallbackUri, redirect, cli });
    return handleEmptyResponse(response);
}

export async function createEmailChangeRequest(email: string): Promise<void> {
    const response = await http.post(`${base}/email-change-request`, { email });
    return handleEmptyResponse(response);
}

interface CreateSavedChartParams {
    name: string;
    description: string;
    analysisType: AnalysisType;
    analysisSubject: AnalysisSubject;
    customProperty?: string;
    filters: Filter[];
    breakdownType?: BreakdownType;
    timeSeriesFilter?: TimeSeriesFilter;
}

export async function createSavedChart(workspaceSlug: string, savedChartData: CreateSavedChartParams): Promise<SavedChart> {
    const response = await http.post(`${base}/workspaces/${workspaceSlug}/saved-charts`, savedChartData);

    return handleResponse<SavedChart>(response);
}

export async function getSavedCharts(workspaceSlug: string): Promise<SavedChart[]> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/saved-charts`);

    return handleResponse<SavedChart[]>(response);
}

export async function getSavedChart(workspaceSlug: string, savedChartSlug: string): Promise<SavedChart> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/saved-charts/${savedChartSlug}`);

    return handleResponse<SavedChart>(response);
}

interface UpdateSavedChartParams {
    name?: string;
    description?: string;
    analysisType?: AnalysisType;
    analysisSubject?: AnalysisSubject;
    customProperty?: string;
    filters?: Filter[];
    breakdownType?: BreakdownType | null;
    timeSeriesFilter?: TimeSeriesFilter;
}

export async function updateSavedChart(workspaceSlug: string, savedChartSlug: string, savedChartInfo: UpdateSavedChartParams): Promise<void> {
    const response = await http.patch(`${base}/workspaces/${workspaceSlug}/saved-charts/${savedChartSlug}`, savedChartInfo);

    return handleEmptyResponse(response);
}

export async function updateProjectName(workspaceSlug: string, projectName: string, alias: string): Promise<{ workspace: Workspace; accessLevel: AccessLevel; }> {
    const response = await http.put(`${base}/workspaces/${workspaceSlug}/projects/${projectName}`,
        {
            alias,
        });

    const { workspace, accessLevel } = await handleResponse<{ workspace: RawWorkspace; accessLevel: AccessLevel; }>(response);
    return { workspace: transformWorkspace(workspace), accessLevel };
}

export async function deleteSavedChart(workspaceSlug: string, savedChartSlug: string): Promise<void> {
    const response = await http.delete(`${base}/workspaces/${workspaceSlug}/saved-charts/${savedChartSlug}`);

    return handleEmptyResponse(response);
}

type DataIssueResponse = APIResponse<DataIssue[], { dataIssueCount: number; }>;

export async function getDataIssues(workspaceSlug: string): Promise<DataIssueResponse> {
    const response = await http.get(`${base}/workspaces/${workspaceSlug}/data-issues`);

    return handleResponse<DataIssueResponse>(response);
}
