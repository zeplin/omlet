import express, { type Request, type Response } from "express";
import { StatusCodes as httpStatus } from "http-status-codes";
import joi from "joi";
import { parse as parseUrl } from "url";

import { AppEnvType, config } from "../../config/backend";
import { requestValidator } from "../middleware/requestValidator";
import {
    type AuthRequest,
    authenticateTestUser,
    authProviders,
    findAndDeleteAuthRequest,
    getVerifiedAuthPayload,
} from "../service/auth/auth";
import { AuthRequestNotFound } from "../service/auth/errors";
import { LoginProviderType } from "../service/auth/models";
import { createUserSession } from "../service/auth/utils";
import { sendEmailChangeNotificationEmail, sendWelcomeEmail } from "../service/emailing";
import { healthCheckService } from "../service/healthcheck";
import { logException } from "../service/logger";
import { getFullUrl } from "../service/shortUrls";
import { UserNotFound, findUserById, updateUser, resetUserLoginProviders } from "../service/user/user";
import {
    findDefaultWorkspace,
    findWorkspaceBySlug,
    findWorkspaceInviteLink,
    addMemberUsingInviteLink,
    WorkspaceInviteLinkNotActive,
    WorkspaceInviteLinkNotFound,
    WorkspaceNotFound,
    findUserWorkspaces,
} from "../service/workspace/workspace";

export interface AuthStatePayload {
    isCli: boolean;
    clientId?: string;
    redirect?: string;
}

export function encodeStatePayload(payload: AuthStatePayload): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodeStateData(data?: string): AuthStatePayload {
    if (!data) {
        return {} as AuthStatePayload;
    }

    try {
        return JSON.parse(Buffer.from(data, "base64").toString()) as AuthStatePayload;
    } catch (err) {
        logException(err);

        return {} as AuthStatePayload;
    }
}

const pagesRouter = express.Router();

pagesRouter.get("/status", (req, res) => {
    if (healthCheckService.getHealthStatus()) {
        res.status(httpStatus.OK).json({ status: "not bad" });
    } else {
        res.status(httpStatus.SERVICE_UNAVAILABLE).json({ status: "unavailable" });
    }
});


function getRedirect({ redirect, callback_uri }: { redirect?: string; callback_uri?: string; }) {
    if (redirect) {
        return redirect;
    }

    if (!callback_uri) {
        return undefined;
    }

    const url = new URL("/login/cli-success", config.APP_BASE_URL);
    url.searchParams.append("callback_uri", callback_uri);
    return url.toString();
}

function isValidRedirectUrl(redirect: string) {
    const url = new URL(decodeURIComponent(redirect), config.APP_BASE_URL);
    const validOrigins = ["http://127.0.0.1:8989", config.APP_BASE_URL];
    return validOrigins.includes(url.origin);
}

pagesRouter.get("/login/test",
    requestValidator({
        query: {
            schema: joi.object({
                redirect: joi.string().optional(),
                cli: joi.boolean().optional(),
            }).unknown(true),
        },
    }),
    async (req: Request<{}, {}, {}, { redirect?: string; cli?: boolean; }>, res: Response, next) => {
        try {
            const { redirect, cli: isCliSession = false } = req.query;

            if (req.authToken) {
                const auth = getVerifiedAuthPayload(req.authToken);

                if (auth) {
                    const user = await findUserById(auth.userId);

                    if (user) {
                        res.clearCookie(config.AUTH_COOKIE_NAME);

                        if (redirect && isValidRedirectUrl(redirect)) {
                            const token = await createUserSession(user, auth.loginProvider, { isCliSession });

                            const url = new URL(decodeURIComponent(redirect), config.APP_BASE_URL);
                            url.searchParams.append("token", token);

                            return res.redirect(url.toString());
                        }

                        try {
                            const workspace = await findDefaultWorkspace(user.id);
                            return res.redirect(`/${workspace.slug}`);
                        } catch {
                            return res.redirect("/create-workspace");
                        }
                    }
                }

                return;
            }

            const { token, isNewUser } = await authenticateTestUser({ isCliSession });

            setAuthCookie(res, token);

            const type = isNewUser ? "new_user" : "returning_user";

            if (redirect && isValidRedirectUrl(redirect)) {
                const url = new URL(decodeURIComponent(redirect), config.APP_BASE_URL);
                url.searchParams.append("token", token);
                url.searchParams.append("type", type);
                res.redirect(url.toString());
            } else {
                res.redirect(`/login/success?type=${type}`);
            }
        } catch (err) {
            next(err);
        }
    }
);

pagesRouter.get("/login{/email}",
    requestValidator({
        query: {
            schema: joi.object({
                redirect: joi.string().optional(),
                cli: joi.boolean().optional(),
                // callback_uri is needed for older versions of the CLI
                // we can safely remove when all users are > 1.7.0
                callback_uri: joi.string().uri().optional(),
            }).unknown(true),
        },
    }),
    async (req: Request<{}, {}, {}, { redirect?: string; cli?: boolean; callback_uri?: string; }>, res: Response, next) => {
        const hasCallbackUri = req.query.callback_uri !== undefined;
        const token = req.authToken;
        if (!token) {
            next();
            return;
        }

        try {
            const auth = getVerifiedAuthPayload(token);
            if (!auth) {
                next();
                return;
            }

            const user = await findUserById(auth.userId);
            if (!user) {
                res.clearCookie(config.AUTH_COOKIE_NAME);
                next();
                return;
            }

            const redirect = getRedirect(req.query);

            if (redirect && isValidRedirectUrl(redirect)) {
                const isCliSession = req.query.cli || hasCallbackUri;
                const token = await createUserSession(user, auth.loginProvider, { isCliSession });

                const url = new URL(decodeURIComponent(redirect), config.APP_BASE_URL);
                url.searchParams.append("token", token);
                return res.redirect(url.toString());
            }

            try {
                const workspace = await findDefaultWorkspace(user.id);
                return res.redirect(`/${workspace.slug}`);
            } catch {
                return res.redirect("/create-workspace");
            }
        } catch (err) {
            next(err);
        }
    }
);

function setAuthCookie(res: Response, token: string) {
    const secure = config.APP_ENV !== AppEnvType.Local;

    res.cookie(config.AUTH_COOKIE_NAME, token, {
        maxAge: config.AUTH_COOKIE_LIFETIME_MSEC,
        httpOnly: true,
        secure,
    });
}

pagesRouter.post("/logout", (req, res) => {
    res.clearCookie(config.AUTH_COOKIE_NAME);
    res.redirect("/login");
});

type AuthProviderTypes = keyof typeof authProviders;

pagesRouter.get("/auth/:provider",
    requestValidator({
        params: {
            schema: joi.object({
                provider: joi.string().valid(...Object.keys(authProviders)),
            }),
        },
        query: {
            schema: joi.object({
                cli: joi.boolean().optional(),
                redirect: joi.string().optional(),
                error: joi.string().optional(),
            }).unknown(true),
        },
    }),
    (req: Request<{ provider: AuthProviderTypes; }, {}, {}, { cli?: boolean; redirect?: string; error?: string; }>, res: Response) => {
        const { cli, redirect, error } = req.query;

        const provider = authProviders[req.params.provider];
        const url = provider.getAuthUrl(
            encodeStatePayload({
                isCli: cli || false,
                redirect,
            }),
            { error }
        );

        res.redirect(url);
    }
);

pagesRouter.get("/auth/:provider/login",
    requestValidator({
        params: {
            schema: joi.object({
                provider: joi.string().valid(...Object.keys(authProviders)),
            }),
        },
        query: {
            schema: joi.object({
                code: joi.string().optional(),
                state: joi.string().optional(),
            }).unknown(true),
        },
    }),
    async (req: Request<{ provider: AuthProviderTypes; }, {}, {}, { code?: string; state?: string; }>, res: Response) => {
        const loginUrl = new URL("/login", config.APP_BASE_URL);
        try {
            const provider = authProviders[req.params.provider];
            const statePayload = decodeStateData(req.query.state);
            if (statePayload.redirect) {
                loginUrl.searchParams.set("redirect", statePayload.redirect);
            }

            if (statePayload.isCli) {
                loginUrl.searchParams.set("cli", "true");
            }


            if (req.params.provider === LoginProviderType.Email) {
                const cookies = req.cookies as Record<string, string | undefined> | undefined;
                const clientId = cookies?.[config.AUTH_CLIENT_ID_COOKIE_NAME];

                if (!clientId || !statePayload.clientId || clientId !== statePayload.clientId) {
                    loginUrl.searchParams.set("error", "client_mismatch");
                    res.redirect(loginUrl.toString());
                    return;
                }

                res.clearCookie(config.AUTH_CLIENT_ID_COOKIE_NAME);
            }

            if (!req.query.code) {
                loginUrl.searchParams.set("error", `${req.params.provider}_fail`);
                res.redirect(loginUrl.toString());
                return;
            }

            const isCli = statePayload.isCli || false;
            const { user, token, isNewUser } = await provider.auth(req.query.code, { isCliSession: isCli });

            setAuthCookie(res, token);

            const type = isNewUser ? "new_user" : "returning_user";


            if (statePayload.redirect && isValidRedirectUrl(statePayload.redirect)) {
                const url = new URL(decodeURIComponent(statePayload.redirect), config.APP_BASE_URL);
                url.searchParams.append("token", token);
                url.searchParams.append("type", type);
                res.redirect(url.toString());
            } else {
                res.redirect(`/login/success?type=${type}`);
            }

            if (isNewUser) {
                sendWelcomeEmail(user.email);
            }
        } catch (err) {
            logException(err);
            res.clearCookie(config.AUTH_COOKIE_NAME);

            if (err instanceof AuthRequestNotFound) {
                loginUrl.searchParams.set("error", `${req.params.provider}_auth_request_not_found`);
            } else {
                loginUrl.searchParams.set("error", `${req.params.provider}_fail`);
            }
            res.redirect(loginUrl.toString());
        }
    }
);

pagesRouter.get("/change-email",
    requestValidator({
        query: {
            schema: joi.object({
                code: joi.string(),
            }),
        },
    }),
    async (req: Request<{ }, {}, {}, { code: string; }>, res: Response) => {
        try {
            const { query: { code } } = req;
            const authRequest: AuthRequest | null = await findAndDeleteAuthRequest(req.query.code);

            if (!authRequest?.userId) {
                throw new AuthRequestNotFound(code);
            }

            const user = await updateUser(authRequest.userId, { email: authRequest.email });
            await resetUserLoginProviders(authRequest.userId, authRequest.email);
            const oldEmail = user.email;
            user.email = authRequest.email;

            const token = await createUserSession(user, LoginProviderType.Email, { isCliSession: false });

            setAuthCookie(res, token);
            res.redirect("/login/success?type=email_change");

            await sendEmailChangeNotificationEmail(oldEmail, { oldEmail, newEmail: user.email });
        } catch (error) {
            res.clearCookie(config.AUTH_COOKIE_NAME);
            logException(error);

            if (error instanceof AuthRequestNotFound) {
                res.redirect("/login?error=email_auth_request_not_found");
            } else if (error instanceof UserNotFound) {
                res.redirect("/login?error=user_not_found");
            } else {
                res.redirect("/login?error=email_fail");
            }
        }
    }
);

pagesRouter.get("/invite/:workspaceSlug/:code",
    requestValidator({
        params: {
            schema: joi.object({
                workspaceSlug: joi.string(),
                code: joi.string(),
            }),
        },
    }),
    async (req: Request<{ workspaceSlug: string; code: string; }, {}, {}, {}>, res: Response) => {
        const {
            params: {
                workspaceSlug,
                code,
            },
        } = req;

        let workspace;
        try {
            workspace = await findWorkspaceBySlug(workspaceSlug);

            await findWorkspaceInviteLink(workspace.id, code);
        } catch (error) {
            if (
                error instanceof WorkspaceNotFound ||
                error instanceof WorkspaceInviteLinkNotFound ||
                error instanceof WorkspaceInviteLinkNotActive
            ) {
                return res.redirect("/invalid-invite");
            } else {
                logException(error);

                return res.redirect("/");
            }
        }

        const token = req.authToken;
        if (!token) {
            return res.redirect(`/login?redirect=${encodeURIComponent(`/invite/${workspaceSlug}/${code}`)}`);
        }

        const auth = getVerifiedAuthPayload(token);
        if (!auth) {
            return res
                .clearCookie(config.AUTH_COOKIE_NAME)
                .redirect(`/login?redirect=${encodeURIComponent(`/invite/${workspaceSlug}/${code}`)}`);
        }

        try {
            await addMemberUsingInviteLink(workspace.id, code, auth.userId);
            const user = await findUserById(auth.userId);
            const workspaces = await findUserWorkspaces(auth.userId);

            if (workspaces.length === 1 && user!.profession === undefined) {
                res.redirect("/select-profession");
            } else {
                res.redirect(`/${workspaceSlug}`);
            }
        } catch (error) {
            logException(error);

            res.redirect("/");
        }
    }
);

pagesRouter.get("/l/*shortPath", async (req, res) => {
    const sourceUrl = parseUrl(req.originalUrl, true);
    if (!sourceUrl.pathname) {
        res.status(httpStatus.NOT_FOUND).send();
        return;
    }

    const url = await getFullUrl(sourceUrl.pathname);
    if (!url) {
        res.status(httpStatus.NOT_FOUND).send();
        return;
    }

    const targetUrl = new URL(url);
    if (sourceUrl.search) {
        for (const [name, value] of new URLSearchParams(sourceUrl.search).entries()) {
            targetUrl.searchParams.append(name, value);
        }
    }

    res.redirect(targetUrl.toString());
});

pagesRouter.get("/",
    (req, res, next) => {
        if (req.publicAuthToken) {
            return next();
        }

        const token = req.authToken;
        if (!token) {
            res.redirect("/login");
            return;
        }

        const auth = getVerifiedAuthPayload(token);
        if (!auth) {
            res.redirect("/login");
            return;
        }

        next();
    }
);

export { pagesRouter };
