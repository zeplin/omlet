import contentType from "content-type";
import { randomBytes, randomUUID } from "crypto";
import etag from "etag";
import express, { type Request, type Response } from "express";
import { type ParamsDictionary, type Query } from "express-serve-static-core";
import { StatusCodes as httpStatus } from "http-status-codes";
import joi from "joi";

import { type AnalysisResult } from "../../cliDataModels/AnalysisResult";
import { type AnalysisSubject } from "../../common/models/AnalysisSubject";
import { type BreakdownType } from "../../common/models/BreakdownType";
import { type ChartDatum } from "../../common/models/ChartDatum";
import { type FolderFilter } from "../../common/models/FolderFilter";
import { AppEnvType, config } from "../../config/backend";
import { adminAuthMiddleware, authMiddleware, publicAuthMiddleware } from "../middleware/auth";
import { RequestValidationError, requestValidator } from "../middleware/requestValidator";
import {
    type Analysis,
    type AnalysisData,
    clearAnalysisInProgress,
    createAnalysis,
    deleteAnalysis,
    getAnalysesOf,
    isAnalysisInProgress,
    markAnalysisAsInProgress,
    performPostAnalysisOperations,
    deleteAnalyses,
} from "../service/analysis/analysis";
import { createAuthRequest } from "../service/auth/auth";
import { cacheValue, extendTTL, getCachedValue, LockError, withWorkspaceSlugWriteLock } from "../service/cache/cache";
import { type TimeSeriesFilter } from "../service/component/aggregations";
import {
    type ComponentUsagesResult,
    type DataAnalysisFilter,
    type UnusedComponentPropResult,
    ComponentNotFound,
    ComponentSortKey,
    analyseLatestDataAsChartData,
    analyseLatestDataAsCSV,
    analyseTimeSeriesDataAsChartData,
    analyseTimeSeriesDataAsCSV,
    findLatestComponentsByDefinitionId,
    getComponentProps,
    getComponentUsagesWithParentComponent,
    getCustomProperties,
    getDependenciesFor,
    getLatestComponentsFoldersIn,
    getLatestComponentsIn,
    getLatestIndexAnalysisId,
    getUnusedComponentProps,
    transformComponent,
    CSV_HEADER,
    RESERVED_TAGS,
    CustomPropertyRequiredForAnalysis,
} from "../service/component/component";
import { getDataIssues } from "../service/dataIssues/dataIssues";
import { DAY_IN_SECONDS } from "../service/date/date";
import {
    sendEmailChangeEmail,
    sendInviteEmail,
    sendInviteToScanEmail,
    sendLoginEmail,
    sendWorkspaceJoinEmail,
    sendWorkspaceJoinRequestAlreadyExistsEmail,
    sendWorkspaceJoinRequestAlreadyMemberEmail,
    sendWorkspaceJoinRequestEmail,
} from "../service/emailing";
import { type DateFilter } from "../service/models";
import {
    createSavedChart,
    type CreateSavedChartParams,
    deleteSavedChart,
    getSavedChart,
    getSavedChartsOf,
    SavedChartNotFound,
    updateSavedChart,
    type UpdateSavedChartParams,
} from "../service/savedChart/savedChart";
import {
    deleteSharedPage,
    findOrCreateSharedPage,
    findSharedPage,
    getSharedPagePublicAuthToken,
    SharedPageNotFound,
} from "../service/sharedPage/sharedPage";
import { createShortUrl, getFullUrl } from "../service/shortUrls";
import { Profession } from "../service/user/models";
import {
    findUserByEmail,
    findUserById,
    hasDefaultWorkspace,
    updateUser,
    type User,
    UserNotFound,
} from "../service/user/user";
import {
    acceptWorkspaceJoinRequest,
    createTag,
    type CreateTagParams,
    createWorkspace,
    createWorkspaceJoinRequest,
    deleteTag,
    denyWorkspaceJoinRequest,
    findDefaultWorkspace,
    findOrCreateWorkspaceInviteLink,
    findWorkspaceBySlug,
    getInviteUrl,
    getMembers,
    getPendingInvites,
    getWorkspaceIfAuthorized,
    getWorkspaceJoinRequests,
    getWorkspaceSlugSuggestion,
    inviteMember,
    MemberNotFound,
    ProjectAliasAlreadyExists,
    ProjectNotFound,
    ProjectNotInternal,
    purgeWorkspaceData,
    removeMember,
    removePendingInvite,
    resetWorkspaceInviteLink,
    TagNotFound,
    TreeNode,
    updateCoreTag,
    updateProjectName,
    updateTag,
    type UpdateTagParams,
    UserAlreadyInvited,
    UserAlreadyMember,
    UserNotAuthorized,
    UserNotHaveWorkspace,
    UserPermission,
    type Workspace,
    WorkspaceAlreadySetup,
    WorkspaceInvite,
    WorkspaceJoinRequestAlreadyExists,
    WorkspaceNotFound,
    WorkspaceSlugNotAvailable,
} from "../service/workspace/workspace";

import { ClientError, ErrorResponseCode } from "./clientError";
import { type AuthStatePayload, encodeStatePayload } from "./pages";
import {
    analysisFilterSchema,
    cliAnalysisDataSchema,
    createSavedChartSchema,
    latestDataAnalysisSchema,
    tagFilterSchema,
    timeSeriesDataAnalysisSchema,
    timeSeriesFilterSchema,
    treeNodeSchema,
    updateSavedChartSchema,
    folderFilterSchema,
} from "./schema";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const ANALYTICS_ETAG_CACHE_VERSION = "v5";
const TIME_SERIES_ANALYTICS_ETAG_CACHE_VERSION = "v6";
const COMPONENTS_ETAG_CACHE_VERSION = "v3";
const FOLDERS_ETAG_CACHE_VERSION = "v1";
const DATA_ISSUES_ETAG_CACHE_VERSION = "v1";
const WORKSPACE_DATA_REVISION_TTL = 30 * DAY_IN_SECONDS;

function getDeviceInfoFromUA(userAgent: string) {
    const re = /\(([^;]+);\s*([^;]+);\s*([^;]+)\)/;

    const parts = userAgent.match(re);
    if (!parts) {
        return null;
    }

    const [, os, arch, version] = parts;
    return { os, arch, version };
}

function generateWorkspaceDataRevisionId() {
    const randomString = randomBytes(32).toString("hex");
    const timestamp = Date.now();

    return `${randomString}:${timestamp}`;
}

function generateWorkspaceDataRevisionKey(workspaceId: string) {
    return `workspace:${workspaceId}:componentHistoryHash`;
}

export function setWorkspaceDataRevisionId(workspaceId: string, hash: string) {
    return cacheValue(generateWorkspaceDataRevisionKey(workspaceId), hash, { ttl: WORKSPACE_DATA_REVISION_TTL });
}

async function getWorkspaceDataRevisionId(workspaceId: string): Promise<string> {
    const key = generateWorkspaceDataRevisionKey(workspaceId);
    const value = await getCachedValue<string>(key);

    if (value) {
        await extendTTL(key, WORKSPACE_DATA_REVISION_TTL);
        return value;
    }

    const newValue = generateWorkspaceDataRevisionId();
    await setWorkspaceDataRevisionId(workspaceId, newValue);
    return newValue;
}

const apiRouter = express.Router();

apiRouter.post("/short-urls",
    adminAuthMiddleware(),
    requestValidator({
        body: {
            schema: joi.object({
                shortPath: joi.string(),
                fullUrl: joi.string().uri({
                    scheme: [
                        /https?/,
                    ],
                }),
                description: joi.string(),
            }),
        },
    }),
    async (req: Request<{}, {}, { shortPath: string; fullUrl: string; description: string; }, {}>, res: Response) => {
        const {
            body: {
                shortPath,
                fullUrl,
                description,
            },
        } = req;

        const existingLongUrl = await getFullUrl(shortPath);
        if (existingLongUrl) {
            res.status(httpStatus.BAD_GATEWAY).json({ message: "Short URL is not available" });
            return;
        }

        const shortUrl = await createShortUrl(shortPath, fullUrl, description);

        res.status(httpStatus.OK).json({ url: shortUrl });
    }
);

function setClientIdCookie(res: Response, clientId: string) {
    const secure = config.APP_ENV !== AppEnvType.Local;

    res.cookie(config.AUTH_CLIENT_ID_COOKIE_NAME, clientId, {
        maxAge: config.AUTH_CLIENT_ID_COOKIE_LIFETIME_MSEC,
        httpOnly: true,
        secure,
    });
}

apiRouter.get("/auth-providers",
    async (req: Request, res: Response) => {
        const google = Boolean(config.GOOGLE_CLIENT_ID) && Boolean(config.GOOGLE_CLIENT_SECRET);
        const github = Boolean(config.GITHUB_CLIENT_ID) && Boolean(config.GITHUB_CLIENT_SECRET);
        const gitlab = Boolean(config.GITLAB_CLIENT_ID) && Boolean(config.GITLAB_CLIENT_SECRET);
        const email = config.EMAILS_ENABLED;
        const testUser = config.ENABLE_TEST_USER;

        res.status(httpStatus.OK).json({
            google,
            github,
            gitlab,
            email,
            testUser,
        });
    }
);

apiRouter.post("/auth-request",
    requestValidator({
        body: {
            schema: joi.object({
                email: joi.string().email(),
                redirect: joi.string().optional(),
                cli: joi.boolean().optional(),
            }),
        },
    }),
    async (req: Request<{}, {}, { email: string; redirect?: string; cli?: boolean; }>, res: Response) => {
        const { body: { email, redirect, cli } } = req;
        const { code } = await createAuthRequest(
            email,
            await findUserByEmail(email) ?? undefined,
        );
        const clientId = randomUUID();

        const searchParams = new URLSearchParams({ code });

        const statePayload: AuthStatePayload = {
            clientId,
            redirect,
            isCli: cli || false,
        };

        searchParams.set("state", encodeStatePayload(statePayload));
        const loginUrl = `${config.APP_BASE_URL}/auth/email/login?${searchParams.toString()}`;
        await sendLoginEmail(email, { loginUrl });

        setClientIdCookie(res, clientId);
        res.status(httpStatus.NO_CONTENT).send();
    }
);

apiRouter.get("/shared-pages/:code/auth",
    async (req: Request<{ code: string; }, {}, {}, {}>, res: Response) => {
        try {
            const {
                params: {
                    code,
                },
            } = req;

            const referrer = req.get("Referrer");
            if (!referrer) {
                return res.clearCookie(config.PUBLIC_AUTH_TOKEN_COOKIE_NAME)
                    .status(httpStatus.NO_CONTENT)
                    .send();
            }

            const referrerURL = new URL(referrer);
            referrerURL.searchParams.delete("token");

            const publicAuthToken = await getSharedPagePublicAuthToken(referrerURL.toString(), code);

            res.cookie(config.PUBLIC_AUTH_TOKEN_COOKIE_NAME, publicAuthToken, {
                httpOnly: true,
                secure: config.APP_ENV !== AppEnvType.Local,
            })
                .status(httpStatus.NO_CONTENT)
                .send();
        } catch (error) {
            res.clearCookie(config.PUBLIC_AUTH_TOKEN_COOKIE_NAME)
                .status(httpStatus.NO_CONTENT)
                .send();
        }
    }
);

apiRouter.post("/shared-pages/auth/invalidate",
    async (req: Request, res: Response) => {
        return res
            .clearCookie(config.PUBLIC_AUTH_TOKEN_COOKIE_NAME)
            .status(httpStatus.NO_CONTENT)
            .send();
    }
);

apiRouter.get("/users/me",
    authMiddleware(),
    async (req, res) => {
        const user = await findUserById(req.auth!.userId);
        if (!user) {
            res.status(httpStatus.NOT_FOUND).send();
            return;
        }

        res.status(httpStatus.OK).json({
            ...user.toResponse(),
        });
    }
);

apiRouter.patch("/users/me",
    authMiddleware(),
    requestValidator({
        body: {
            schema: joi.object({
                profession: joi.string().valid(...Object.values<string>(Profession)).optional(),
            }),
        },
    }),
    async (req: Request<{}, {}, { profession?: Profession; }>, res: Response) => {
        try {
            const userId = req.auth!.userId;
            const { body: { profession } } = req;

            if (profession) {
                await updateUser(userId, { profession });
            }

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof UserNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.USER_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.post("/email-change-request",
    authMiddleware(),
    requestValidator({
        body: {
            schema: joi.object({
                email: joi.string(),
            }),
        },
    }),
    async (req: Request<{}, {}, { email: string; }>, res: Response) => {
        const { body: { email } } = req;
        const user = await findUserById(req.auth!.userId);
        if (!user) {
            res.status(httpStatus.NOT_FOUND).send();
            return;
        }

        // If there is a user with specified email, do nothing
        if (await findUserByEmail(email)) {
            res.status(httpStatus.NO_CONTENT).send();
            return;
        }


        const { code } = await createAuthRequest(email, user);
        const searchParams = new URLSearchParams({ code });
        const emailChangeUrl = `${config.APP_BASE_URL}/change-email?${searchParams.toString()}`;
        await sendEmailChangeEmail(email, { emailChangeUrl, email });
        res.status(httpStatus.NO_CONTENT).send();
    }
);

apiRouter.post("/workspaces",
    authMiddleware(),
    requestValidator({
        body: {
            schema: joi.object({
                name: joi.string(),
                slug: joi.string(),
            }),
        },
    }),
    async (req: Request<{}, {}, { name: string; slug: string; }, {}>, res: Response) => {
        if (!req.auth) {
            throw new ClientError(httpStatus.UNAUTHORIZED, ErrorResponseCode.UNAUTHORIZED);
        }

        const {
            body: { name, slug },
            auth: { userId, email },
        } = req;

        if (await hasDefaultWorkspace(userId)) {
            throw new ClientError(httpStatus.FORBIDDEN, ErrorResponseCode.USER_ALREADY_HAS_WORKSPACE);
        }

        try {
            let workspace: Workspace | undefined;
            await withWorkspaceSlugWriteLock(slug, async () => {
                workspace = await createWorkspace({ name, slug, userId, email });
            });

            if (!workspace) {
                throw new WorkspaceSlugNotAvailable();
            }

            res.status(httpStatus.OK).json(await workspace.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceSlugNotAvailable) {
                throw new ClientError(httpStatus.UNPROCESSABLE_ENTITY, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/slug",
    authMiddleware(),
    requestValidator({
        query: {
            schema: joi.object({
                name: joi.string(),
            }),
        },
    }),
    async (req: Request<{}, {}, {}, { name: string; }>, res: Response) => {
        const slug = await getWorkspaceSlugSuggestion(req.query.name);

        res.status(httpStatus.OK).json({ slug });
    }
);

apiRouter.get("/workspaces/default",
    authMiddleware(),
    async (req, res) => {
        try {
            const userId = req.auth!.userId;
            const workspace = await findDefaultWorkspace(userId);

            res.status(httpStatus.OK).json(await workspace.toResponse());
        } catch (error) {
            if (error instanceof UserNotHaveWorkspace) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.USER_NOT_HAVE_WORKSPACE);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug",
    authMiddleware({ credentialsRequired: false }),
    publicAuthMiddleware(),
    async (req, res) => {
        try {
            const {
                auth,
                publicAuth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth, publicAuth });
            const analysisInProgress = await isAnalysisInProgress(workspace.id);
            const workspaceResponse = await workspace.toResponse();
            res.status(httpStatus.OK).json({
                workspace: {
                    ...workspaceResponse,
                    analysisInProgress,
                },
                accessLevel: workspace.getAccessLevel(auth),
            });
        } catch (error) {
            if (error instanceof UserNotAuthorized) {
                throw new ClientError(httpStatus.UNAUTHORIZED, ErrorResponseCode.UNAUTHORIZED);
            }

            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/invite-link-code",
    authMiddleware(),
    async (req: Request<{ workspaceSlug: string; }, {}, {}, {}>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            const inviteLink = await findOrCreateWorkspaceInviteLink(workspace.id);

            res.status(httpStatus.OK).json({
                code: inviteLink.code,
            });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/invite-link-code/:code/reset",
    authMiddleware(),
    async (req: Request<{ workspaceSlug: string; code: string; }, {}, {}, {}>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    code,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            const inviteLink = await resetWorkspaceInviteLink(workspace.id, code);

            res.status(httpStatus.OK).json({
                code: inviteLink.code,
            });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/shared-pages/:url",
    authMiddleware(),
    async (req: Request<{ workspaceSlug: string; url: string; }, {}, {}, {}>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    url,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            const sharedPage = await findSharedPage(workspace.id, url);

            res.status(httpStatus.OK).json(sharedPage.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof SharedPageNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.SHARED_PAGE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/shared-pages/:url",
    authMiddleware(),
    async (req: Request<{ workspaceSlug: string; url: string; }, {}, {}, {}>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    url,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            const sharedPage = await findOrCreateSharedPage(workspace.id, url);

            res.status(httpStatus.OK).json(sharedPage.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.delete("/workspaces/:workspaceSlug/shared-pages/:url",
    authMiddleware(),
    async (req: Request<{ workspaceSlug: string; url: string; }, {}, {}, {}>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    url,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            await deleteSharedPage(workspace.id, url);

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/init",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                analyses: joi.array().items(cliAnalysisDataSchema),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, { analyses: AnalysisResult[]; }>, res: Response) => {
        const {
            auth,
            body,
            params: {
                workspaceSlug,
            },
        } = req;

        try {
            const userId = auth!.userId;
            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            // Check if initialization already done for this workspace
            if (workspace.projects.length > 0) {
                throw new WorkspaceAlreadySetup();
            }

            await markAnalysisAsInProgress(workspace.id);

            const dataMap: Record<string, { analysis: Analysis; analysisData: AnalysisData; }> = {};

            for (const analysisResult of body.analyses) {
                if (!analysisResult.meta.device_info && req.meta.userAgent) {
                    const deviceInfo = getDeviceInfoFromUA(req.meta.userAgent);
                    if (deviceInfo) {
                        analysisResult.meta.device_info = deviceInfo;
                    }
                }

                const analysisData = {
                    ...analysisResult,
                    components: analysisResult.components.map(transformComponent),
                };

                const { analysis, components, analysisData: modifiedAnalysisData, dependencyData } = await createAnalysis(workspace, userId, analysisData);
                await performPostAnalysisOperations(workspace, analysis, modifiedAnalysisData, dependencyData, components);
                dataMap[analysis.id] = { analysis, analysisData };
            }

            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());
            await clearAnalysisInProgress(workspace.id);

            res.status(httpStatus.OK).json(await workspace.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof WorkspaceAlreadySetup) {
                throw new ClientError(httpStatus.UNPROCESSABLE_ENTITY, ErrorResponseCode.WORKSPACE_ALREADY_SETUP);
            }

            if (error instanceof LockError) {
                throw new ClientError(httpStatus.LOCKED, ErrorResponseCode.LOCKED);
            }

            if (!(error instanceof ClientError)) {
                await purgeWorkspaceData(workspaceSlug, auth!);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/analyses",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: cliAnalysisDataSchema,
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, AnalysisResult>, res: Response) => {
        try {
            const {
                auth,
                body,
                params: {
                    workspaceSlug,
                },
            } = req;

            const userId = auth!.userId;
            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            await markAnalysisAsInProgress(workspace.id);

            if (!body.meta.device_info && req.meta.userAgent) {
                const deviceInfo = getDeviceInfoFromUA(req.meta.userAgent);
                if (deviceInfo) {
                    body.meta.device_info = deviceInfo;
                }
            }

            const analysisData = {
                ...body,
                components: body.components.map(transformComponent),
            };
            const { analysis, analysisData: modifiedAnalysisData, components, dependencyData } = await createAnalysis(workspace, userId, analysisData);
            const responseData = await analysis.toResponse();

            const updatedWorkspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            const dataIssues = await getDataIssues(updatedWorkspace);
            const dataIssueCount = dataIssues.reduce((acc, dataIssues) => acc + dataIssues.getTotalIssueCount(), 0);

            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());

            res.status(httpStatus.OK).json({
                data: responseData,
                meta: {
                    dataIssueCount,
                },
            });

            await performPostAnalysisOperations(workspace, analysis, modifiedAnalysisData, dependencyData, components);
            await clearAnalysisInProgress(workspace.id);
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof LockError) {
                throw new ClientError(httpStatus.LOCKED, ErrorResponseCode.LOCKED);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/analyses",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        query: {
            schema: joi.object({
                limit: joi.string().optional(),
                next: joi.string().optional(),
                prev: joi.string().optional(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, AnalysisData, { limit?: string; next?: string; prev?: string; }>, res: Response) => {
        try {
            const {
                auth,
                query: {
                    limit: limitStr,
                    next,
                    prev,
                },
                params: {
                    workspaceSlug,
                },
            } = req;

            const limit = limitStr ? Math.min(MAX_PAGE_SIZE, Number.parseInt(limitStr, 10)) : DEFAULT_PAGE_SIZE;
            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });

            const pageResult = await getAnalysesOf(workspace.id, { limit, next, prev });
            res.status(httpStatus.OK).json({
                analyses: await Promise.all(pageResult.results.map(analysis => analysis.toResponse())),
                hasNext: pageResult.hasNext,
                next: pageResult.hasNext ? pageResult.next : undefined,
                hasPrev: pageResult.hasPrev,
                prev: pageResult.hasPrev ? pageResult.prev : undefined,
            });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.delete("/workspaces/:workspaceSlug/analyses/:analysisId",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                analysisId: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; analysisId: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    analysisId,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            await markAnalysisAsInProgress(workspace.id);

            await deleteAnalysis(workspace, analysisId);

            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());
            await clearAnalysisInProgress(workspace.id);

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof LockError) {
                throw new ClientError(httpStatus.LOCKED, ErrorResponseCode.LOCKED);
            }

            throw error;
        }
    }
);

interface AdminDeleteAnalysesBody {
    analysisIds: string[];
}

apiRouter.delete("/workspaces/:workspaceSlug/analyses",
    authMiddleware(),
    adminAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                analysisIds: joi.array().items(joi.string()).required(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, AdminDeleteAnalysesBody>, res: Response) => {
        try {
            const {
                body: {
                    analysisIds,
                },
                params: {
                    workspaceSlug,
                },
            } = req;
            const workspace = await findWorkspaceBySlug(workspaceSlug);

            await markAnalysisAsInProgress(workspace.id);

            await deleteAnalyses(workspace, analysisIds);

            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());
            await clearAnalysisInProgress(workspace.id);

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof LockError) {
                throw new ClientError(httpStatus.LOCKED, ErrorResponseCode.LOCKED);
            }

            throw error;
        }
    }
);

interface GetComponentsSearchBody {
    search_term?: string;
    filters?: DataAnalysisFilter;
    folders?: FolderFilter;
    limit?: number;
    next?: number;
    prev?: number;
    sort_key?: string;
    sort_ascending?: string;
}

apiRouter.post("/workspaces/:workspaceSlug/components",
    authMiddleware({ credentialsRequired: false }),
    publicAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                search_term: joi.string().optional(),
                filters: analysisFilterSchema.optional(),
                folders: folderFilterSchema.optional(),
                limit: joi.number().optional(),
                next: joi.number().optional(),
                prev: joi.number().optional(),
                sort_key: joi.string().valid(...Object.values(ComponentSortKey)).optional(),
                sort_ascending: joi.string().valid("true", "false").optional(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, GetComponentsSearchBody>, res: Response) => {
        try {
            const {
                auth,
                publicAuth,
                body: {
                    search_term: searchTerm,
                    filters: requestFilters,
                    folders,
                    limit,
                    next,
                    prev,
                    sort_key: sortBy,
                    sort_ascending: sortAscending,
                },
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth, publicAuth });
            const transformedFilters = {
                ...requestFilters,
                createdAt: requestFilters?.createdAt && transformDateFilters(requestFilters.createdAt),
                updatedAt: requestFilters?.updatedAt && transformDateFilters(requestFilters.updatedAt),
                lastUsageChangedAt: requestFilters?.lastUsageChangedAt && transformDateFilters(requestFilters.lastUsageChangedAt),
            };

            const treeNodes = transformFolderFilters(folders);

            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: COMPONENTS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                url: req.originalUrl,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            const opts = {
                searchTerm,
                filters: transformedFilters,
                folders: treeNodes,
                sortBy: (sortBy ?? ComponentSortKey.Name) as ComponentSortKey,
                sortAscending: sortAscending === "true",
                limit: limit ? Math.min(MAX_PAGE_SIZE, limit) : DEFAULT_PAGE_SIZE,
                next,
                prev: prev ? Math.max(prev, 1) : undefined,
            };
            const pageResult = await getLatestComponentsIn(workspace.id, opts);
            const projectMap = Object.fromEntries(workspace.projects.map(p => [p.packageName, p]));
            pageResult.results.forEach(component => {
                component.packageName = projectMap[component.packageName]?.alias || component.packageName;
            });
            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json({
                    components: pageResult.results.map(component => component.toResponse()),
                    hasNext: pageResult.hasNext,
                    next: pageResult.hasNext ? pageResult.next : undefined,
                    hasPrev: pageResult.hasPrev,
                    prev: pageResult.hasPrev ? pageResult.prev : undefined,
                    total: pageResult.total,
                });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/folders",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, {}, {}>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });
            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: FOLDERS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                url: req.originalUrl,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            const latestAnalysisId = await getLatestIndexAnalysisId(workspace.id);
            if (!latestAnalysisId) {
                return res.status(httpStatus.OK)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .json({
                        packages: [],
                        totalNumberOfUsages: 0,
                    });
            }
            const foldersResult = await getLatestComponentsFoldersIn(workspace.id, latestAnalysisId);

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json(foldersResult);
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.put("/workspaces/:workspaceSlug/tags/core",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                name: joi.string(),
                selectedTreeNodes: joi.array().items(treeNodeSchema),
                deselectedTreeNodes: joi.array().items(treeNodeSchema),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, { name: string; selectedTreeNodes: TreeNode[]; deselectedTreeNodes: TreeNode[]; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
                body: {
                    name,
                    selectedTreeNodes,
                    deselectedTreeNodes,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            await updateCoreTag(workspace.id, name, selectedTreeNodes, deselectedTreeNodes);

            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.put("/workspaces/:workspaceSlug/projects/:projectName",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                projectName: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                alias: joi.string().max(50),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; projectName: string; }, {}, { alias: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    projectName,
                },
                body: {
                    alias,
                },
            } = req;
            const decodedProjectName = decodeURIComponent(projectName);
            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            const updatedWorkspace = await updateProjectName(workspace, decodedProjectName, alias);
            const accessLevel = workspace.getAccessLevel(auth);
            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());
            res.status(httpStatus.OK).json({
                workspace: await updatedWorkspace.toResponse(),
                accessLevel,
            });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }
            if (error instanceof ProjectNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.PROJECT_NOT_FOUND);
            }
            if (error instanceof ProjectNotInternal) {
                throw new ClientError(httpStatus.BAD_REQUEST, ErrorResponseCode.PROJECT_NOT_INTERNAL);
            }
            if (error instanceof ProjectAliasAlreadyExists) {
                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.PROJECT_ALIAS_ALREADY_EXISTS);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/tags",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                name: joi.string(),
                searchTerm: joi.string().optional().allow(""),
                selectedTreeNodes: joi.array().items(treeNodeSchema).optional(),
                deselectedTreeNodes: joi.array().items(treeNodeSchema).optional(),
                filters: joi.array().items(tagFilterSchema).optional(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, CreateTagParams>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
                body: {
                    name,
                    searchTerm,
                    selectedTreeNodes,
                    deselectedTreeNodes,
                    filters,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            const updatedWorkspace = await createTag(workspace, {
                name,
                searchTerm,
                selectedTreeNodes,
                deselectedTreeNodes,
                filters,
            });

            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());

            res.status(httpStatus.OK).json(await updatedWorkspace.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.patch("/workspaces/:workspaceSlug/tags/:tagSlug",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                tagSlug: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                name: joi.string().optional(),
                searchTerm: joi.string().optional().allow(""),
                selectedTreeNodes: joi.array().items(treeNodeSchema).optional(),
                deselectedTreeNodes: joi.array().items(treeNodeSchema).optional(),
                filters: joi.array().items(tagFilterSchema).optional(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; tagSlug: string; }, {}, UpdateTagParams>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    tagSlug,
                },
                body: {
                    name,
                    searchTerm,
                    selectedTreeNodes,
                    deselectedTreeNodes,
                    filters,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            const updatedWorkspace = await updateTag(workspace, tagSlug, {
                name,
                searchTerm,
                selectedTreeNodes,
                deselectedTreeNodes,
                filters,
            });

            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());

            res.status(httpStatus.OK).json(await updatedWorkspace.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof TagNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.TAG_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.delete("/workspaces/:workspaceSlug/tags/:tagSlug",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                tagSlug: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; tagSlug: string; }, {}>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    tagSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            if (tagSlug === RESERVED_TAGS.CORE.slug) {
                throw new ClientError(httpStatus.FORBIDDEN, ErrorResponseCode.CORE_TAG_CANNOT_BE_DELETED);
            }

            await markAnalysisAsInProgress(workspace.id);

            const updatedWorkspace = await deleteTag(workspace, tagSlug);

            await setWorkspaceDataRevisionId(workspace.id, generateWorkspaceDataRevisionId());
            await clearAnalysisInProgress(workspace.id);

            res.status(httpStatus.OK).json(await updatedWorkspace.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof TagNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.TAG_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/custom-properties",
    authMiddleware({ credentialsRequired: false }),
    publicAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }>, res: Response) => {
        try {
            const {
                auth,
                publicAuth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth, publicAuth });

            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: COMPONENTS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                url: req.originalUrl,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            const customProperties = await getCustomProperties(workspace.id);

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json(customProperties);
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/components/:definitionId",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                definitionId: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; definitionId: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    definitionId,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });

            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: COMPONENTS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                definitionId,
                url: req.originalUrl,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            const [component] = await findLatestComponentsByDefinitionId(workspace.id, [definitionId]);
            if (!component) {
                res.status(httpStatus.NOT_FOUND).send();
                return;
            }
            component.packageName = workspace.projects.find(p => p.packageName === component.packageName)?.alias || component.packageName;

            const componentResponse = component.toResponse();

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json(componentResponse);
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof ComponentNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.COMPONENT_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/components/:definitionId/dependencies",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                definitionId: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; definitionId: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    definitionId,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });
            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: COMPONENTS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                definitionId,
                url: req.originalUrl,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            const dependencies = await getDependenciesFor(workspace.id, definitionId);
            const projectMap = Object.fromEntries(workspace.projects.map(p => [p.packageName, p]));
            dependencies.components.forEach(component => {
                component.packageName = projectMap[component.packageName]?.alias || component.packageName;
            });
            if (!dependencies) {
                res.status(httpStatus.NOT_FOUND).set("ETag", computedEtag).send();
                return;
            }

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json(dependencies.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof ComponentNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.COMPONENT_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/components/:definitionId/usages",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                definitionId: joi.string(),
            }),
        },
        query: {
            schema: joi.object({
                prop_name: joi.string(),
                prop_value: joi.string().optional(),
            }),
        },
    }),
    async (
        req: Request<{ workspaceSlug: string; definitionId: string; }, void, ComponentUsagesResult, { prop_name: string; prop_value?: string; }>,
        res: Response<ComponentUsagesResult>
    ) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    definitionId,
                },
                query: {
                    prop_name: propName,
                    prop_value: propValue,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });

            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: COMPONENTS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                definitionId,
                url: req.originalUrl,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            const usages = await getComponentUsagesWithParentComponent(workspace, definitionId, propName, propValue);
            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json(usages);
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/components/:definitionId/props",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                definitionId: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; definitionId: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    definitionId,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });

            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: COMPONENTS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                definitionId,
                url: req.originalUrl,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json(await getComponentProps(workspace, definitionId));
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/invites",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });
            const invites = await getPendingInvites(workspace.id);

            res.status(httpStatus.OK).json(invites.map(invite => invite.toResponse()));
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/invites",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                email: joi.string().email(),
                inviteToScan: joi.boolean(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, { email: string; inviteToScan: boolean; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
                body: {
                    email,
                    inviteToScan,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            const userId = auth!.userId;
            const referrer = await findUserById(userId) as User;
            const invite = await inviteMember(workspace.id, email, referrer);

            if (invite instanceof WorkspaceInvite) {
                if (inviteToScan) {
                    await sendInviteToScanEmail(invite.email, {
                        inviteUrl: getInviteUrl(),
                        referrerName: referrer.fullName,
                        referrerEmail: referrer.email,
                    });
                } else {
                    await sendInviteEmail(invite.email, {
                        inviteUrl: getInviteUrl(),
                        referrerName: referrer.fullName,
                        referrerEmail: referrer.email,
                    });
                }
            } else {
                await sendWorkspaceJoinEmail(invite.email, {
                    workspaceUrl: workspace.baseUrl,
                    referrerName: referrer.fullName,
                    referrerEmail: referrer.email,
                });
            }

            res.status(httpStatus.OK).send({
                type: invite instanceof WorkspaceInvite ? "invite" : "user",
                data: invite.toResponse(),
            });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof UserAlreadyMember) {
                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.USER_ALREADY_MEMBER);
            }

            if (error instanceof UserAlreadyInvited) {
                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.USER_ALREADY_INVITED);
            }

            throw error;
        }
    }
);

apiRouter.delete("/workspaces/:workspaceSlug/invites/:inviteId",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                inviteId: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; inviteId: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    inviteId,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            if (auth?.userId !== workspace.createdBy) {
                throw new ClientError(httpStatus.FORBIDDEN, ErrorResponseCode.FORBIDDEN);
            }

            await removePendingInvite(workspace.id, inviteId);

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/members",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });
            const users = await getMembers(workspace);

            res.status(httpStatus.OK).json(users.map(user => user.toResponse()));
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.delete("/workspaces/:workspaceSlug/members/:userId",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                userId: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; userId: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    userId,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            if (auth?.userId !== workspace.createdBy) {
                throw new ClientError(httpStatus.FORBIDDEN, ErrorResponseCode.FORBIDDEN);
            }

            await removeMember(workspace.id, userId);

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/join-requests",
    authMiddleware({ credentialsRequired: false }),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });
            const joinRequests = await getWorkspaceJoinRequests(workspace.id);

            res.status(httpStatus.OK).json(joinRequests.map(joinRequest => joinRequest.toResponse()));
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/join-requests",
    publicAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: joi.object({
                email: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; }, {}, { email: string; }>, res: Response) => {
        const {
            publicAuth,
            params: {
                workspaceSlug,
            },
            body: {
                email,
            },
        } = req;

        let workspace: Workspace;
        try {
            workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { publicAuth });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }

        try {
            await createWorkspaceJoinRequest(workspace.id, email);

            res.status(httpStatus.NO_CONTENT).send();

            const workspaceOwner = await findUserById(workspace.createdBy);
            await sendWorkspaceJoinRequestEmail(workspaceOwner!.email, {
                workspaceUrl: `${workspace.baseUrl}#invites`,
                ownerName: workspaceOwner!.fullName,
                requesterEmail: email,
            });
        } catch (error) {
            if (error instanceof WorkspaceJoinRequestAlreadyExists) {
                await sendWorkspaceJoinRequestAlreadyExistsEmail(email, {
                    requesterEmail: email,
                });

                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.JOIN_REQUEST_ALREADY_EXISTS);
            }

            if (error instanceof UserAlreadyMember) {
                await sendWorkspaceJoinRequestAlreadyMemberEmail(email, {
                    workspaceUrl: workspace.baseUrl,
                    requesterEmail: email,
                });

                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.USER_ALREADY_MEMBER);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/join-requests/:joinRequestId/accept",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                joinRequestId: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; joinRequestId: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    joinRequestId,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            const referrer = await findUserById(auth!.userId) as User;
            const invite = await acceptWorkspaceJoinRequest(joinRequestId, referrer);

            if (invite instanceof WorkspaceInvite) {
                await sendInviteEmail(invite.email, {
                    inviteUrl: getInviteUrl(),
                    referrerName: referrer.fullName,
                    referrerEmail: referrer.email,
                });
            } else {
                await sendWorkspaceJoinEmail(invite.email, {
                    workspaceUrl: workspace.baseUrl,
                    referrerName: referrer.fullName,
                    referrerEmail: referrer.email,
                });
            }

            res.status(httpStatus.OK).json({
                type: invite instanceof WorkspaceInvite ? "invite" : "user",
                data: invite.toResponse(),
            });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.delete("/workspaces/:workspaceSlug/join-requests/:joinRequestId",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                joinRequestId: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; joinRequestId: string; }>, res: Response) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    joinRequestId,
                },
            } = req;

            await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            await denyWorkspaceJoinRequest(joinRequestId);

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

function transformDateFilters(filters: DateFilter[]): DateFilter[] {
    return filters
        .map(({ value: [start, end], ...filter }) => ({
            ...filter,
            value: [
                start ? new Date(start) : undefined,
                end ? new Date(end) : undefined,
            ] as [Date | undefined, Date | undefined],
        }))
        .filter(({ value: [start, end] }) => start || end);
}

function intoDataAnalysisFilter(raw?: string): DataAnalysisFilter {
    if (!raw) {
        return {};
    }
    let filters: DataAnalysisFilter;
    try {
        filters = JSON.parse(raw) as DataAnalysisFilter;
    } catch (e) {
        throw new RequestValidationError({
            meta: {
                input: raw,
            },
        });
    }
    const { error } = analysisFilterSchema.validate(filters, { convert: false });
    if (error) {
        throw new RequestValidationError({ reason: error });
    }
    filters.createdAt = filters.createdAt && transformDateFilters(filters.createdAt);
    filters.updatedAt = filters.updatedAt && transformDateFilters(filters.updatedAt);
    filters.lastUsageChangedAt = filters.lastUsageChangedAt && transformDateFilters(filters.lastUsageChangedAt);
    return filters;
}

function intoTimeSeriesFilter(raw?: string): TimeSeriesFilter {
    if (!raw) {
        return {};
    }
    let timeSeriesFilter: TimeSeriesFilter;
    try {
        timeSeriesFilter = JSON.parse(raw) as TimeSeriesFilter;
    } catch (e) {
        throw new RequestValidationError({
            meta: {
                input: raw,
            },
        });
    }
    const { error } = timeSeriesFilterSchema.validate(timeSeriesFilter, { convert: false });
    if (error) {
        throw new RequestValidationError({ reason: error });
    }
    timeSeriesFilter.timeWindow = timeSeriesFilter.timeWindow && transformDateFilters([timeSeriesFilter.timeWindow])[0];
    return timeSeriesFilter;
}

function transformFolderFilters(folders: FolderFilter | undefined): { selectedTreeNodes: TreeNode[]; deselectedTreeNodes: TreeNode[]; } | undefined {
    if (!folders) {
        return undefined;
    }


    return {
        selectedTreeNodes: folders.selectedTreeNodes.map(node => new TreeNode(node)),
        deselectedTreeNodes: folders.deselectedTreeNodes.map(node => new TreeNode(node)),
    };
}

interface DataAnalysisRequestParams extends ParamsDictionary {
    workspaceSlug: string;
}

interface LatestDataAnalysisRequestQuery extends Query {
    analysisSubject: AnalysisSubject;
    customProperty?: string;
    filters?: string;
    breakdownType?: BreakdownType;
}

apiRouter.get("/workspaces/:workspaceSlug/latest-data-analyses",
    authMiddleware({ credentialsRequired: false }),
    publicAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        query: {
            schema: latestDataAnalysisSchema,
        },
    }),
    async (
        req: Request<DataAnalysisRequestParams, {}, never, LatestDataAnalysisRequestQuery>,
        res: Response<ChartDatum[] | string | ClientError>
    ) => {
        try {
            const {
                auth,
                publicAuth,
                params: {
                    workspaceSlug,
                },
                query: {
                    analysisSubject,
                    customProperty,
                    filters: rawFilters,
                    breakdownType,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth, publicAuth });
            const acceptHeader = req.header("Accept");

            if (acceptHeader === undefined) {
                throw new ClientError(httpStatus.NOT_ACCEPTABLE, ErrorResponseCode.BAD_REQUEST);
            }

            const parsedAcceptHeader = contentType.parse(acceptHeader);

            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: ANALYTICS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                url: req.originalUrl,
                acceptHeader,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", acceptHeader)
                    .set("Vary", "Accept")
                    .send();
            }
            const latestAnalysisId = await getLatestIndexAnalysisId(workspace.id);

            if (!latestAnalysisId) {
                if (parsedAcceptHeader.type === "text/csv") {
                    return res.status(httpStatus.OK)
                        .set("ETag", computedEtag)
                        .set("Content-Type", acceptHeader)
                        .set("Vary", "Accept")
                        .send(CSV_HEADER.join(","));
                } else {
                    return res.status(httpStatus.OK)
                        .set("ETag", computedEtag)
                        .set("Vary", "Accept")
                        .json([]);
                }
            }

            const filters = intoDataAnalysisFilter(rawFilters);

            const analysisArgs = {
                workspace,
                lastAnalysis: latestAnalysisId,
                analysisSubject,
                customProperty,
                filters,
                breakdownType,
            };

            const result = parsedAcceptHeader.type === "text/csv"
                ? await analyseLatestDataAsCSV(analysisArgs)
                : await analyseLatestDataAsChartData(analysisArgs);

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .set("Content-Type", acceptHeader)
                .set("Vary", "Accept")
                .send(result);
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof UserNotAuthorized) {
                throw new ClientError(httpStatus.UNAUTHORIZED, ErrorResponseCode.UNAUTHORIZED);
            }

            if (error instanceof CustomPropertyRequiredForAnalysis) {
                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.CUSTOM_PROPERTY_REQUIRED_FOR_ANALYSIS);
            }

            throw error;
        }
    }
);

interface TimeSeriesDataAnalysisRequestQuery extends Query {
    analysisSubject: AnalysisSubject;
    customProperty?: string;
    filters?: string;
    timeSeriesFilter?: string;
}

apiRouter.get("/workspaces/:workspaceSlug/timeseries-analyses",
    authMiddleware({ credentialsRequired: false }),
    publicAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        query: {
            schema: timeSeriesDataAnalysisSchema,
        },
    }),
    async (
        req: Request<DataAnalysisRequestParams, {}, never, TimeSeriesDataAnalysisRequestQuery>,
        res: Response<ChartDatum[] | string | ClientError>
    ) => {
        try {
            const {
                auth,
                publicAuth,
                params: {
                    workspaceSlug,
                },
                query: {
                    analysisSubject,
                    customProperty,
                    filters: rawFilters,
                    timeSeriesFilter: rawTimeSeriesFilter,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth, publicAuth });
            const acceptHeader = req.header("Accept");

            if (acceptHeader === undefined) {
                throw new ClientError(httpStatus.NOT_ACCEPTABLE, ErrorResponseCode.BAD_REQUEST);
            }

            const parsedAcceptHeader = contentType.parse(acceptHeader);

            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: TIME_SERIES_ANALYTICS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                url: req.originalUrl,
                acceptHeader,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", acceptHeader)
                    .set("Vary", "Accept")
                    .send();
            }

            const filters = intoDataAnalysisFilter(rawFilters);
            const timeSeriesFilter = intoTimeSeriesFilter(rawTimeSeriesFilter);

            const analysisArgs = {
                workspace,
                analysisSubject,
                customProperty,
                filters,
                timeSeriesFilter,
            };

            const result = parsedAcceptHeader.type === "text/csv"
                ? await analyseTimeSeriesDataAsCSV(analysisArgs)
                : await analyseTimeSeriesDataAsChartData(analysisArgs);

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .set("Content-Type", acceptHeader)
                .set("Vary", "Accept")
                .send(result);
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof UserNotAuthorized) {
                throw new ClientError(httpStatus.UNAUTHORIZED, ErrorResponseCode.UNAUTHORIZED);
            }

            if (error instanceof CustomPropertyRequiredForAnalysis) {
                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.CUSTOM_PROPERTY_REQUIRED_FOR_ANALYSIS);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/unused-component-props",
    authMiddleware({ credentialsRequired: false }),
    publicAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        query: {
            schema: joi.object({
                limit: joi.number().optional(),
            }),
        },
    }),
    async (
        req: Request<{ workspaceSlug: string; }, {}, {}, { limit?: string; }>,
        res: Response<UnusedComponentPropResult[] | ClientError>
    ) => {
        try {
            const {
                auth,
                publicAuth,
                params: {
                    workspaceSlug,
                },
                query: {
                    limit,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth, publicAuth });

            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: COMPONENTS_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
                url: req.originalUrl,
            }));

            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            const result = await getUnusedComponentProps(workspace.id, { limit: limit ? Number.parseInt(limit) : undefined });
            const projectMap = Object.fromEntries(workspace.projects.map(p => [p.packageName, p]));
            result.forEach(item => {
                item.component.packageName = projectMap[item.component.packageName]?.alias ?? item.component.packageName;
            });

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json(result);
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/saved-charts",
    authMiddleware({ credentialsRequired: false }),
    publicAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
    }),
    async (
        req: Request<{ workspaceSlug: string; }, {}, {}, {}>,
        res: Response
    ) => {
        try {
            const {
                auth,
                publicAuth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth, publicAuth });
            const savedCharts = await getSavedChartsOf(workspace);

            res.status(httpStatus.OK)
                .json(savedCharts.map(savedChart => savedChart.toResponse()));
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/saved-charts/:savedChartSlug",
    authMiddleware({ credentialsRequired: false }),
    publicAuthMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                savedChartSlug: joi.string(),
            }),
        },
    }),
    async (
        req: Request<{ workspaceSlug: string; savedChartSlug: string; }, {}, {}, {}>,
        res: Response
    ) => {
        try {
            const {
                auth,
                publicAuth,
                params: {
                    workspaceSlug,
                    savedChartSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth, publicAuth });
            const savedChart = await getSavedChart(workspace, savedChartSlug);

            res.status(httpStatus.OK).json(savedChart.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof SavedChartNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.SAVED_CHART_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.post("/workspaces/:workspaceSlug/saved-charts",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
        body: {
            schema: createSavedChartSchema,
        },
    }),
    async (
        req: Request<{ workspaceSlug: string; }, {}, CreateSavedChartParams, {}>,
        res: Response
    ) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
                body: {
                    name,
                    description,
                    analysisType,
                    analysisSubject,
                    customProperty,
                    filters,
                    breakdownType,
                    timeSeriesFilter,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });
            const user = await findUserById(auth!.userId) as User;
            const savedChart = await createSavedChart(workspace, user.id, {
                name,
                description,
                analysisType,
                analysisSubject,
                customProperty,
                filters,
                breakdownType,
                timeSeriesFilter,
            });

            res.status(httpStatus.OK).json(savedChart.toResponse());
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof CustomPropertyRequiredForAnalysis) {
                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.CUSTOM_PROPERTY_REQUIRED_FOR_ANALYSIS);
            }

            throw error;
        }
    }
);

apiRouter.patch("/workspaces/:workspaceSlug/saved-charts/:savedChartSlug",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                savedChartSlug: joi.string(),
            }),
        },
        body: {
            schema: updateSavedChartSchema,
        },
    }),
    async (
        req: Request<{ workspaceSlug: string; savedChartSlug: string; }, {}, UpdateSavedChartParams, {}>,
        res: Response
    ) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    savedChartSlug,
                },
                body: {
                    name,
                    description,
                    analysisType,
                    analysisSubject,
                    customProperty,
                    filters,
                    breakdownType,
                    timeSeriesFilter,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            await updateSavedChart(workspace, savedChartSlug, {
                name,
                description,
                analysisType,
                analysisSubject,
                customProperty,
                filters,
                breakdownType,
                timeSeriesFilter,
            });

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            if (error instanceof SavedChartNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.SAVED_CHART_NOT_FOUND);
            }

            if (error instanceof CustomPropertyRequiredForAnalysis) {
                throw new ClientError(httpStatus.CONFLICT, ErrorResponseCode.CUSTOM_PROPERTY_REQUIRED_FOR_ANALYSIS);
            }

            throw error;
        }
    }
);

apiRouter.delete("/workspaces/:workspaceSlug/saved-charts/:savedChartSlug",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                savedChartSlug: joi.string(),
            }),
        },
    }),
    async (
        req: Request<{ workspaceSlug: string; savedChartSlug: string; }, {}, {}, {}>,
        res: Response
    ) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                    savedChartSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.WRITE, { auth });

            await deleteSavedChart(workspace, savedChartSlug);

            res.status(httpStatus.NO_CONTENT).send();
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

apiRouter.get("/workspaces/:workspaceSlug/data-issues",
    authMiddleware(),
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
            }),
        },
    }),
    async (
        req: Request<{ workspaceSlug: string; }, {}, {}, {}>,
        res: Response
    ) => {
        try {
            const {
                auth,
                params: {
                    workspaceSlug,
                },
            } = req;

            const workspace = await getWorkspaceIfAuthorized(workspaceSlug, UserPermission.READ, { auth });
            const dataRevisionId = await getWorkspaceDataRevisionId(workspace.id);
            const computedEtag = etag(JSON.stringify({
                cacheVersion: DATA_ISSUES_ETAG_CACHE_VERSION,
                workspaceId: workspace.id,
                dataRevisionId,
            }));
            const clientEtag = req.get("If-None-Match");
            if (clientEtag === computedEtag) {
                return res.status(httpStatus.NOT_MODIFIED)
                    .set("ETag", computedEtag)
                    .set("Cache-Control", "private")
                    .set("Content-Type", "application/json")
                    .send();
            }

            const dataIssues = await getDataIssues(workspace);

            res.status(httpStatus.OK)
                .set("ETag", computedEtag)
                .set("Cache-Control", "private")
                .json({
                    data: dataIssues.map(dataIssue => dataIssue.toResponse()),
                    meta: {
                        dataIssueCount: dataIssues.reduce((acc, dataIssues) => acc + dataIssues.getTotalIssueCount(), 0),
                    },
                });
        } catch (error) {
            if (error instanceof WorkspaceNotFound || error instanceof MemberNotFound) {
                throw new ClientError(httpStatus.NOT_FOUND, ErrorResponseCode.WORKSPACE_NOT_FOUND);
            }

            throw error;
        }
    }
);

export { apiRouter };
