import { createOAuthUserAuth as createGithubUserAuth } from "@octokit/auth-oauth-user";
import { Octokit as GithubAuthClient } from "@octokit/core";

import { config } from "../../../config/backend";

import { OAuthFailure } from "./errors";
import {
    type AuthResult,
    type LoginOptions,
    type UserData,
    LoginProviderType,
} from "./models";
import { authenticateUser } from "./utils";

const GITHUB_REDIRECT_URI = `${config.APP_BASE_URL}${config.GITHUB_LOGIN_PATH}`;

export function getGithubAuthUrl(state: string, { error }: { error?: string; }): string {
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

export async function authGithubUser(authCode: string, { isCliSession = false }: LoginOptions): Promise<AuthResult> {
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
