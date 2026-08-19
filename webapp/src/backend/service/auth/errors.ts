import { type ErrorExtraInfo, ServiceError } from "../error";

import { type LoginProviderType, type UserData } from "./models";

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
