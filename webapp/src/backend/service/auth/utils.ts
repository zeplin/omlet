import {
    type Algorithm as JwtAlgorithm,
    type SignOptions as JwtSignOptions,
    sign as jwtSign,
} from "jsonwebtoken";

import { config } from "../../../config/backend";
import {
    type User,
    createUser,
    createUserSession as createSession,
    findUserByEmail,
    findUserByLoginProvider,
    isAdminUser,
    linkExternalAccount,
} from "../user/user";
import {
    addMember,
    findWorkspaceInvitesByEmail,
    markInviteAsUsed,
    removeMember,
} from "../workspace/workspace";

import { UserNotInvited } from "./errors";
import {
    type AuthResult,
    type AuthToken,
    type LoginProviderType,
    type TokenPayload,
    type UserData,
} from "./models";

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


export function generateUserToken(tokenId: string, payload: TokenPayload, isCliSession: boolean): AuthToken {
    const signOptions: JwtSignOptions = {
        jwtid: tokenId,
        expiresIn: isCliSession ? config.JWT_EXPIRY_CLI : config.JWT_EXPIRY,
        algorithm: config.JWT_ALGO as JwtAlgorithm,
        issuer: config.JWT_ISSUER,
    };
    const token = jwtSign(payload, config.JWT_PRIVATE_KEY, signOptions);

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
