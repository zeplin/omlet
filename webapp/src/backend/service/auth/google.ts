import { OAuth2Client as GoogleAuthClient } from "google-auth-library";
import { decode as jwtDecode } from "jsonwebtoken";

import { config } from "../../../config/backend";

import { OAuthFailure } from "./errors";
import {
    type AuthResult,
    type LoginOptions,
    type UserData,
    LoginProviderType,
} from "./models";
import { authenticateUser } from "./utils";

const GOOGLE_REDIRECT_URI = `${config.APP_BASE_URL}${config.GOOGLE_LOGIN_PATH}`;

function getGoogleClient(): GoogleAuthClient {
    return new GoogleAuthClient(
        config.GOOGLE_CLIENT_ID,
        config.GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );
}

export function getGoogleAuthUrl(state: string): string {
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
    return jwtDecode(idToken) as GoogleIdPayload;
}

export async function authGoogleUser(authCode: string, { isCliSession = false }: LoginOptions): Promise<AuthResult> {
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
