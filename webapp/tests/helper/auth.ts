import { type Response } from "superagent";

import { type LoginProviderType } from "../../src/backend/service/auth/models";
import { generateUserToken } from "../../src/backend/service/auth/utils";
import { generateNanoId } from "../../src/backend/service/utils";
import { config } from "../../src/config/backend";

export function generateToken({ userId, email, loginProvider }: { userId: string; email: string; loginProvider: LoginProviderType; }): string {
    return generateUserToken(generateNanoId(), { userId, email, loginProvider }, false);
}

export function getAuthCookieFrom(response: Response): string | undefined {
    const authCookie = response.get("Set-Cookie").find(
        cookie => cookie.split("=")[0] === config.AUTH_COOKIE_NAME
    );

    if (!authCookie) {
        return;
    }

    const token = authCookie.split("=")[1]?.split(";")[0];
    if (!token) {
        return;
    }

    return token;
}

