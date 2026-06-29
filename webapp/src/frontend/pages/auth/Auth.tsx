import { useEffect, useState } from "react";

import { generatePath, Link, useSearchParams } from "react-router-dom";

import { RoutePath } from "../../../common/RoutePath";
import { getAuthProviders } from "../../api/api";
import { IconArrow } from "../../library/icons/IconArrow";
import { LogoCard } from "../../library/LogoCard/LogoCard";
import { type AuthProviders, defaultAuthProviders } from "../../models/AuthProviders";

import { AuthProvider, AuthButton } from "./authButton/AuthButton";

import classes from "./Auth.module.css";

function getRedirect(searchParams: URLSearchParams) {
    const redirect = searchParams.get("redirect");
    if (redirect) {
        return redirect;
    }

    const cliCallbackUri = searchParams.get("callback_uri");

    if (!cliCallbackUri) {
        return undefined;
    }

    const url = new URL(generatePath(RoutePath.CliLoginSuccess), window.location.origin);
    url.searchParams.append("callback_uri", cliCallbackUri);
    return url.toString();
}

export function Auth() {
    const [searchParams] = useSearchParams();
    const [authProviders, setAuthProviders] = useState<AuthProviders>(defaultAuthProviders());

    // callback_uri is needed for older versions of the CLI
    // we can safely remove when all users are > 1.7.0
    const hasCliCallbackUri = searchParams.has("callback_uri");
    const isCli = searchParams.get("cli") === "true" || hasCliCallbackUri;
    const redirect = getRedirect(searchParams);
    const error = searchParams.get("error");

    useEffect(() => {
        async function fetchAuthProviders() {
            const providers = await getAuthProviders();
            setAuthProviders(providers);
        }

        fetchAuthProviders();
    }, []);

    useEffect(() => {
        function getErrorMessage(errorCode: string) {
            if (errorCode === "client_mismatch") {
                return "You’re trying to log into a browser that was not used to initiate the login.\n" +
                    "Try opening the login URL in the browser where you’ve typed your email.";
            }

            if (errorCode === "user_not_found") {
                return "User not found.\n" +
                    "Please try again.";
            }
            if (errorCode === "email_auth_request_not_found") {
                return "Authentication request not found.\n" +
                    "Please try again.";
            }
            if (errorCode === "github_access_denied") {
                return "Authenticating with GitHub failed.\n" +
                    "Please give permission to authenticate.";
            }
            if (errorCode.startsWith("github")) {
                return "Authenticating with GitHub failed.\n" +
                    "Please try again.";
            }
            if (errorCode === "gitlab_access_denied") {
                return "Authenticating with GitLab failed.\n" +
                    "Please give permission to authenticate.";
            }
            if (errorCode.startsWith("gitlab")) {
                return "Authenticating with GitLab failed.\n" +
                    "Please try again.";
            }
            if (errorCode.startsWith("google")) {
                return "Authenticating with Google failed.\n" +
                    "Please try again.";
            }
            return "Authentication failed.\n" +
                "Please try again.";
        }
        if (error) {
            setTimeout(() => window.alert(getErrorMessage(error)), 100);
        }
    }, []);

    function getLoginWithEmailLink() {
        const searchParams = new URLSearchParams();

        if (isCli) {
            searchParams.append("cli", "true");
        }

        if (redirect) {
            searchParams.append("redirect", redirect);
        }

        if (Array.from(searchParams).length === 0) {
            return RoutePath.LoginWithEmail;
        }

        return `${RoutePath.LoginWithEmail}?${searchParams.toString()}`;
    }

    function getLoginWithTestUserLink() {
        const searchParams = new URLSearchParams();

        if (isCli) {
            searchParams.append("cli", "true");
        }

        if (redirect) {
            searchParams.append("redirect", redirect);
        }

        if (Array.from(searchParams).length === 0) {
            return RoutePath.LoginWithTestUser;
        }

        return `${RoutePath.LoginWithTestUser}?${searchParams.toString()}`;
    }

    return (
        <>
            <header className={classes.header}/>
            <main className={classes.main}>
                <div className={classes.column}>
                    <LogoCard title="Welcome to Omlet">
                        Salutations! Let’s get you in.
                    </LogoCard>
                    <div className={classes.forms}>
                        <p className={classes.continueWith}>Continue with:</p>
                        <form method="get" action="/auth/github">
                            <AuthButton provider={AuthProvider.Github} disabled={!authProviders.github}/>
                            {isCli && <input type="hidden" name="cli" value={isCli.toString()}/>}
                            {redirect && <input type="hidden" name="redirect" value={redirect}/>}
                        </form>
                        <form method="get" action="/auth/gitlab">
                            <AuthButton provider={AuthProvider.Gitlab} disabled={!authProviders.gitlab}/>
                            {isCli && <input type="hidden" name="cli" value={isCli.toString()}/>}
                            {redirect && <input type="hidden" name="redirect" value={redirect}/>}
                        </form>
                        <form method="get" action="/auth/google">
                            <AuthButton provider={AuthProvider.Google} disabled={!authProviders.google}/>
                            {isCli && <input type="hidden" name="cli" value={isCli.toString()}/>}
                            {redirect && <input type="hidden" name="redirect" value={redirect}/>}
                        </form>
                    </div>
                    {authProviders.email && (
                        <Link className={classes.link} to={getLoginWithEmailLink()}>
                            Continue with email
                            <IconArrow color="var(--accent-green)"/>
                        </Link>
                    )}
                    {authProviders.testUser && (
                        <a className={classes.link} href={getLoginWithTestUserLink()}>
                            Login as test user
                            <IconArrow color="var(--accent-green)"/>
                        </a>
                    )}
                </div>
            </main>
        </>
    );
}
