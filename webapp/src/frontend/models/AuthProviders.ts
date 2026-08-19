export interface AuthProviders {
    google: boolean;
    github: boolean;
    gitlab: boolean;
    email: boolean;
    testUser: boolean;
}

export function defaultAuthProviders(): AuthProviders {
    return {
        google: false,
        github: false,
        gitlab: false,
        email: false,
        testUser: false,
    };
}
