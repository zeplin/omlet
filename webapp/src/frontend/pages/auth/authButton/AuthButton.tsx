import { type ComponentType } from "react";

import classNames from "classnames";

import { LogoGithub } from "../../../library/logos/LogoGithub";
import { LogoGitlab } from "../../../library/logos/LogoGitlab";
import { LogoGoogle } from "../../../library/logos/LogoGoogle";

import classes from "./AuthButton.module.css";

export enum AuthProvider {
    Github = "github",
    Google = "google",
    Gitlab = "gitlab",
}

interface Props {
    provider: AuthProvider;
    disabled?: boolean;
}

const providerName: Record<AuthProvider, string> = {
    [AuthProvider.Github]: "GitHub",
    [AuthProvider.Google]: "Google",
    [AuthProvider.Gitlab]: "GitLab",
};

const providerIcon: Record<AuthProvider, ComponentType<{ type?: "light" | "dark"; }>> = {
    [AuthProvider.Github]: LogoGithub,
    [AuthProvider.Google]: LogoGoogle,
    [AuthProvider.Gitlab]: LogoGitlab,
};

const providerClasses: Record<AuthProvider, string> = {
    [AuthProvider.Github]: classes.github,
    [AuthProvider.Google]: classes.google,
    [AuthProvider.Gitlab]: classes.gitlab,
};

export function AuthButton({ provider, disabled = false }: Props) {
    const Icon = providerIcon[provider];

    return (
        <button
            className={classNames(classes.authButton, providerClasses[provider])}
            type="submit"
            disabled={disabled}
        >
            <Icon/>
            <span>{providerName[provider]}</span>
        </button>
    );
}
