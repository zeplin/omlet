import { createOAuthUserAuth as createGithubUserAuth } from "@octokit/auth-oauth-user";
import { Octokit as GithubAuthClient } from "@octokit/core";
import { OAuth2Client as GoogleAuthClient } from "google-auth-library";
import * as jwt from "jsonwebtoken";

import { config } from "../../../config/backend";
import { type ErrorExtraInfo, ServiceError } from "../error";
import {
    type User,
    createUser,
    createUserSession as createSession,
    findUserByEmail,
    findUserByLoginProvider,
    isAdminUser,
    linkExternalAccount,
    findTestUser,
} from "../user/user";
import { generateNanoId } from "../utils";
import {
    addMember,
    findWorkspaceInvitesByEmail,
    markInviteAsUsed,
    removeMember,
} from "../workspace/workspace";

import { authGitlabUser, getGitlabAuthUrl } from "./authGitlab";
import { type AuthRequestDoc, AuthRequestModel, LoginProviderType } from "./models";

export class OAuthFailure extends ServiceError {
    constructor(provider: LoginProviderType, extra?: ErrorExtraInfo) {
        super("Authentication failed", {
            shouldCapture: false,
            details: {
                provider,
                ...extra?.details,
            },
            reason: extra?.reason,
        });
    }
}

export class UserNotInvited extends ServiceError {
    constructor(provider: LoginProviderType, userData: UserData) {
        super("User not invited", {
            details: {
                provider,
                userData,
            },
        });
    }
}

export class AuthRequestNotFound extends ServiceError {
    constructor(code: string) {
        super(
            "Auth request not found",
            {
                shouldCapture: false,
                details: {
                    code,
                },
            }
        );
    }
}

export class AuthRequest {
    constructor(
        readonly email: string,
        readonly code: string,
        readonly userId?: string,
    ) {
    }

    static fromDoc(doc: AuthRequestDoc): AuthRequest {
        return new AuthRequest(doc.email, doc.code, doc.user?.toHexString());
    }
}

interface TokenPayload extends jwt.JwtPayload {
    userId: string;
    email: string;
    loginProvider: LoginProviderType;
    isAdmin?: boolean;
}

type AuthToken = string;

export function generateUserToken(tokenId: string, payload: TokenPayload, isCliSession: boolean): AuthToken {
    const signOptions: jwt.SignOptions = {
        jwtid: tokenId,
        expiresIn: isCliSession ? config.JWT_EXPIRY_CLI : config.JWT_EXPIRY,
        algorithm: config.JWT_ALGO as jwt.Algorithm,
        issuer: config.JWT_ISSUER,
    };
    const token = jwt.sign(payload, config.JWT_PRIVATE_KEY, signOptions);

    return token;
}

export async function createUserSession(user: User, loginProvider: LoginProviderType, { isCliSession }: { isCliSession: boolean; }): Promise<AuthToken> {
    const [session, isAdmin] = await Promise.all([
        createSession(user.id, loginProvider),
        isAdminUser(user.id),
    ]);
    const payload = {
        userId: user.id,
        email: user.email,
        isAdmin,
        loginProvider,
    };

    return generateUserToken(session.id, payload, isCliSession);
}

interface PublicTokenPayload extends jwt.JwtPayload {
    url: string;
    workspace: string;
}

export { type PublicTokenPayload as PublicAuthData };

export function generatePublicAuthToken(tokenId: string, payload: PublicTokenPayload): AuthToken {
    return jwt.sign(payload, config.JWT_PRIVATE_KEY, {
        jwtid: tokenId,
        noTimestamp: true,
        algorithm: config.JWT_ALGO as jwt.Algorithm,
        issuer: config.JWT_ISSUER,
    });
}

export interface UserData {
    email: string;
    emails?: string[];
    fullName?: string;
    avatarUrl?: string;
    loginProvider: LoginProviderType;
    externalId: string;
}

async function registerUser(userData: UserData): Promise<User> {
    const user = await createUser({
        email: userData.email,
        fullName: userData.fullName,
        avatarUrl: userData.avatarUrl,
        loginProvider: userData.loginProvider,
        externalId: userData.externalId,
    });

    return user;
}

async function acceptUserInvites(user: User) {
    const loginProvider = user.loginProviders[0].type;
    const userData = {
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        loginProvider,
        externalId: user.loginProviders[0].externalId,
    };

    const invites = await findWorkspaceInvitesByEmail(user.email);
    if (!invites) {
        throw new UserNotInvited(loginProvider, userData);
    }

    for (const invite of invites) {
        if (invite.expiresAt.getTime() < Date.now() || invite.isUsed) {
            continue;
        }

        try {
            await addMember(invite.workspaceId, user.id);
            await markInviteAsUsed(invite.code, user.id);
        } catch (error) {
            await removeMember(invite.workspaceId, user.id);

            continue;
        }
    }
}

export async function authenticateUser(userData: UserData, { isCliSession }: { isCliSession: boolean; }): Promise<AuthResult> {
    let user = await findUserByLoginProvider(userData.loginProvider, userData.externalId);
    let isNewUser = false;

    if (!user) {
        user = await findUserByEmail(userData.emails ?? userData.email);

        if (user) {
            await linkExternalAccount(user.id, userData.loginProvider, userData.externalId);
        } else {
            user = await registerUser(userData);

            isNewUser = true;
        }
    }

    try {
        await acceptUserInvites(user);
    } catch (error) {
        // Silently ignore unhandled invites
    }

    const token = await createUserSession(user, userData.loginProvider, { isCliSession });

    return { user, token, isNewUser };
}

export async function authenticateTestUser({ isCliSession }: { isCliSession: boolean; }): Promise<AuthResult> {
    const user = await findTestUser();

    const token = await createUserSession(user, LoginProviderType.Email, { isCliSession });

    return { user, token, isNewUser: false };
}

const GOOGLE_REDIRECT_URI = `${config.APP_BASE_URL}${config.GOOGLE_LOGIN_PATH}`;

function getGoogleClient(): GoogleAuthClient {
    return new GoogleAuthClient(
        config.GOOGLE_CLIENT_ID,
        config.GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );
}

function getGoogleAuthUrl(state: string): string {
    const oAuth2Client = getGoogleClient();

    return oAuth2Client.generateAuthUrl({
        prompt: "select_account",
        access_type: "offline",
        scope: [
            "https://www.googleapis.com/auth/userinfo.profile",
            "https://www.googleapis.com/auth/userinfo.email",
        ],
        state,
    });
}

interface GoogleIdPayload {
    iss: string;
    aud: string;
    sub: string;
    email: string;
    email_verified: boolean;
    name?: string;
    picture?: string;
    given_name?: string;
    family_name?: string;
    iat: number;
    exp: number;
}

function decodeGoogleIdToken(idToken: string): GoogleIdPayload {
    return jwt.decode(idToken) as GoogleIdPayload;
}

export interface LoginOptions {
    isCliSession: boolean;
}

export interface AuthResult {
    user: User;
    token: AuthToken;
    isNewUser: boolean;
}

async function authGoogleUser(authCode: string, { isCliSession = false }: LoginOptions): Promise<AuthResult> {
    try {
        const oAuth2Client = getGoogleClient();
        const response = await oAuth2Client.getToken(authCode);
        const idToken = response.tokens.id_token;

        if (!idToken) {
            throw new OAuthFailure(LoginProviderType.Google);
        }

        const idPayload = decodeGoogleIdToken(idToken);
        const userData: UserData = {
            loginProvider: LoginProviderType.Google,
            email: idPayload.email,
            externalId: idPayload.sub,
            fullName: [idPayload.given_name ?? "", idPayload.family_name ?? ""].join(" "),
            avatarUrl: idPayload.picture,
        };

        return authenticateUser(userData, { isCliSession });
    } catch (err) {
        throw new OAuthFailure(LoginProviderType.Google, {
            reason: err as Error,
        });
    }
}

const GITHUB_REDIRECT_URI = `${config.APP_BASE_URL}${config.GITHUB_LOGIN_PATH}`;

function getGithubAuthUrl(state: string, { error }: { error?: string; }): string {
    if (error) {
        const errorUrl = new URL(`${config.APP_BASE_URL}/login`);
        errorUrl.searchParams.append("error", `github_${error}`);
        return errorUrl.toString();
    }
    const url = new URL("https://github.com/login/oauth/authorize");

    url.searchParams.append("client_id", config.GITHUB_CLIENT_ID);
    url.searchParams.append("scope", "read:user user:email");
    url.searchParams.append("redirect_uri", GITHUB_REDIRECT_URI);

    if (state) {
        url.searchParams.append("state", state);
    }

    return url.toString();
}

async function authGithubUser(authCode: string, { isCliSession = false }: LoginOptions): Promise<AuthResult> {
    try {
        const githubUserAuth = createGithubUserAuth({
            clientId: config.GITHUB_CLIENT_ID,
            clientSecret: config.GITHUB_CLIENT_SECRET,
            code: authCode,
            redirectUrl: GITHUB_REDIRECT_URI,
        });

        const { token: auth } = await githubUserAuth();
        const octokit = new GithubAuthClient({ auth });

        const [{ data: userProfile }, { data: userEmails }] = await Promise.all([
            octokit.request("GET /user"),
            octokit.request("GET /user/emails"),
        ]);

        const verifiedEmails = userEmails.filter(e => e.verified).map(e => ({ email: e.email, primary: e.primary }));
        const emails = verifiedEmails.map(e => e.email);
        const primaryEmail = verifiedEmails.find(({ primary }) => primary)?.email ?? emails[0];

        const userData: UserData = {
            loginProvider: LoginProviderType.Github,
            email: primaryEmail,
            emails,
            externalId: userProfile.id.toString(),
        };

        if (userProfile.name) {
            userData.fullName = userProfile.name;
        }

        if (userProfile.avatar_url) {
            userData.avatarUrl = userProfile.avatar_url;
        }

        return authenticateUser(userData, { isCliSession });
    } catch (err) {
        throw new OAuthFailure(LoginProviderType.Github, {
            reason: err as Error,
        });
    }
}


// This function is not called.
// Email auth uses POST /api/auth-request instead
function getEmailAuthUrl(): string {
    return `${config.APP_BASE_URL}/login`;
}

async function authEmailUser(code: string, { isCliSession = false }: LoginOptions): Promise<AuthResult> {
    const authRequest = await findAndDeleteAuthRequest(code);

    if (!authRequest) {
        throw new AuthRequestNotFound(code);
    }

    const { email } = authRequest;
    return authenticateUser(
        {
            email,
            loginProvider: LoginProviderType.Email,
            externalId: email,
        },
        { isCliSession }
    );
}

interface Provider {
    auth(authCode: string, opts: LoginOptions): Promise<AuthResult>;
    getAuthUrl(state: string, params: { error?: string; }): string;
}

export const authProviders: Record<LoginProviderType, Provider> = {
    [LoginProviderType.Google]: {
        auth: authGoogleUser,
        getAuthUrl: getGoogleAuthUrl,
    },
    [LoginProviderType.Github]: {
        auth: authGithubUser,
        getAuthUrl: getGithubAuthUrl,
    },
    [LoginProviderType.Gitlab]: {
        auth: authGitlabUser,
        getAuthUrl: getGitlabAuthUrl,
    },
    [LoginProviderType.Email]: {
        auth: authEmailUser,
        getAuthUrl: getEmailAuthUrl,
    },
};

export interface AuthData extends TokenPayload {
    sessionId: string;
    isAdmin: boolean;
}

export function getVerifiedAuthPayload(token: string): AuthData | undefined {
    try {
        const tokenPayload = jwt.verify(token, config.JWT_PUBLIC_KEY, {
            algorithms: [config.JWT_ALGO as jwt.Algorithm],
        }) as TokenPayload;

        return {
            sessionId: tokenPayload.jti as string,
            userId: tokenPayload.userId,
            email: tokenPayload.email,
            loginProvider: tokenPayload.loginProvider,
            isAdmin: tokenPayload.isAdmin ?? false,
        };
    } catch {
        return;
    }
}

export function decodeAuthData(token: string): AuthData | undefined {
    try {
        const tokenPayload = jwt.decode(token) as TokenPayload;

        return {
            sessionId: tokenPayload.jti as string,
            userId: tokenPayload.userId,
            email: tokenPayload.email,
            loginProvider: tokenPayload.loginProvider,
            isAdmin: tokenPayload.isAdmin ?? false,
        };
    } catch {
        return;
    }
}

export async function createAuthRequest(email: string, user?: User): Promise<AuthRequest> {
    await AuthRequestModel.deleteMany(
        user
            ? {
                $or: [
                    { user: user.id },
                    { email: { $in: [email, user.email] } },
                ],
            } : { email }
    );
    const doc = new AuthRequestModel({
        user: user?.id,
        email,
        code: generateNanoId(),
    });
    await doc.save();
    return AuthRequest.fromDoc(doc);
}

export async function findAndDeleteAuthRequest(code: string): Promise<AuthRequest | null> {
    const doc = await AuthRequestModel.findOneAndDelete({ code }).exec();
    return doc ? AuthRequest.fromDoc(doc as unknown as AuthRequestDoc) : null;
}
