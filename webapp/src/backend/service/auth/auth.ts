import {
    type Algorithm as JwtAlgorithm,
    type JwtPayload,
    decode as jwtDecode,
    sign as jwtSign,
    verify as jwtVerify,
} from "jsonwebtoken";

import { config } from "../../../config/backend";
import { type User, findTestUser } from "../user/user";
import { generateNanoId } from "../utils";

import { AuthRequestNotFound } from "./errors";
import { authGithubUser, getGithubAuthUrl } from "./github";
import { authGitlabUser, getGitlabAuthUrl } from "./gitlab";
import { authGoogleUser, getGoogleAuthUrl } from "./google";
import {
    type AuthRequestDoc,
    type AuthResult,
    type AuthToken,
    type LoginOptions,
    type TokenPayload,
    AuthRequestModel,
    LoginProviderType,
} from "./models";
import { authenticateUser, createUserSession } from "./utils";

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

export interface AuthData extends TokenPayload {
    sessionId: string;
    isAdmin: boolean;
}

export interface PublicAuthData extends JwtPayload {
    url: string;
    workspace: string;
}

export function generatePublicAuthToken(tokenId: string, payload: PublicAuthData): AuthToken {
    return jwtSign(payload, config.JWT_PRIVATE_KEY, {
        jwtid: tokenId,
        noTimestamp: true,
        algorithm: config.JWT_ALGO as JwtAlgorithm,
        issuer: config.JWT_ISSUER,
    });
}

export async function authenticateTestUser({ isCliSession }: { isCliSession: boolean; }): Promise<AuthResult> {
    const user = await findTestUser();

    const token = await createUserSession(user, LoginProviderType.Email, { isCliSession });

    return { user, token, isNewUser: false };
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

export function getVerifiedAuthPayload(token: string): AuthData | undefined {
    try {
        const tokenPayload = jwtVerify(token, config.JWT_PUBLIC_KEY, {
            algorithms: [config.JWT_ALGO as JwtAlgorithm],
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
        const tokenPayload = jwtDecode(token) as TokenPayload;

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
