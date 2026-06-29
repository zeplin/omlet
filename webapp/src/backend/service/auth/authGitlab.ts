import fetch from "node-fetch";

import { config } from "../../../config/backend";

import {
    type AuthResult,
    authenticateUser,
    type LoginOptions,
    OAuthFailure,
    type UserData,
} from "./auth";
import { LoginProviderType } from "./models";

const GITLAB_REDIRECT_URI = `${config.APP_BASE_URL}${config.GITLAB_LOGIN_PATH}`;

interface GitlabTokenResponse {
    access_token?: string;
    error?: string;
    error_description?: string;
}

interface GitlabUserProfile {
    id: number;
    email?: string;
    name?: string;
    avatar_url?: string;
}

export async function authGitlabUser(authCode: string, { isCliSession = false }: LoginOptions): Promise<AuthResult> {
    try {
        const tokenResponse = await fetch(new URL("/oauth/token", config.GITLAB_BASE_URL).toString(), {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                client_id: config.GITLAB_CLIENT_ID,
                client_secret: config.GITLAB_CLIENT_SECRET,
                code: authCode,
                grant_type: "authorization_code",
                redirect_uri: GITLAB_REDIRECT_URI,
            }).toString(),
        });

        const tokenData = await tokenResponse.json() as GitlabTokenResponse;

        if (!tokenResponse.ok || !tokenData.access_token) {
            throw new Error(tokenData.error_description ?? tokenData.error ?? "Missing GitLab access token");
        }

        const userResponse = await fetch(new URL("/api/v4/user", config.GITLAB_BASE_URL).toString(), {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
            },
        });

        const userProfile = await userResponse.json() as GitlabUserProfile;

        if (!userResponse.ok || !userProfile.email) {
            throw new Error("Missing GitLab user email");
        }

        const userData: UserData = {
            loginProvider: LoginProviderType.Gitlab,
            email: userProfile.email,
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
        throw new OAuthFailure(LoginProviderType.Gitlab, {
            reason: err as Error,
        });
    }
}

export function getGitlabAuthUrl(state: string, { error }: { error?: string; }): string {
    if (error) {
        const errorUrl = new URL(`${config.APP_BASE_URL}/login`);
        errorUrl.searchParams.append("error", `gitlab_${error}`);
        return errorUrl.toString();
    }

    const url = new URL("/oauth/authorize", config.GITLAB_BASE_URL);

    url.searchParams.append("client_id", config.GITLAB_CLIENT_ID);
    url.searchParams.append("response_type", "code");
    url.searchParams.append("scope", "read_user");
    url.searchParams.append("redirect_uri", GITLAB_REDIRECT_URI);

    if (state) {
        url.searchParams.append("state", state);
    }

    return url.toString();
}
