import dotenv from "dotenv";
import { type StringValue } from "ms";

import { AppEnvType, readAppEnv, readBooleanVar, readIntegerVar, readRequiredVar } from "./common";

const APP_ENV = readAppEnv(process.env.APP_ENV);
const isLocal = APP_ENV === AppEnvType.Local;

if (isLocal) {
    dotenv.config();
}

interface BackendConfig {
    JWT_ALGO: string;
    JWT_EXPIRY: StringValue;
    JWT_EXPIRY_CLI: StringValue;
    JWT_ISSUER: string;
    JWT_PUBLIC_KEY: string;
    JWT_PRIVATE_KEY: string;
    AUTH_COOKIE_NAME: string;
    AUTH_COOKIE_LIFETIME_MSEC: number;
    PUBLIC_AUTH_TOKEN_COOKIE_NAME: string;
    AUTH_CLIENT_ID_COOKIE_NAME: string;
    AUTH_CLIENT_ID_COOKIE_LIFETIME_MSEC: number;
    USE_VITE_MIDDLEWARE: boolean;
    USE_STATIC_MIDDLEWARE: boolean;
    PORT: number;
    EMAILS_ENABLED: boolean;
    ENABLE_TEST_USER: boolean;
    MONGODB_URI: string;
    MONGODB_DEBUG_ENABLED: boolean;
    APP_BASE_URL: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_LOGIN_PATH: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GITHUB_LOGIN_PATH: string;
    GITLAB_BASE_URL: string;
    GITLAB_CLIENT_ID: string;
    GITLAB_CLIENT_SECRET: string;
    GITLAB_LOGIN_PATH: string;
    INVITE_LIFETIME_MSEC: number;
    APP_ENV: AppEnvType;
    API_ROOT_PATH: string;
    REDIS_URI: string;
    RESPONSE_COMPRESSION_ENABLED: boolean;
    GRACEFUL_WORKER_SHUTDOWN_EXIT_CODE: number;
    HTTP_GRACEFUL_TERMINATION_TIMEOUT: number;
    SHUTDOWN_DELAY: number;
    ENABLE_CLUSTER: boolean;
    TIME_SERIES_CHUNK_SIZE: number;
}

const config: BackendConfig = {
    JWT_ALGO: "RS256",
    JWT_EXPIRY: "30d",
    JWT_EXPIRY_CLI: "365d",
    JWT_ISSUER: "omlet.dev",
    JWT_PUBLIC_KEY: Buffer.from(readRequiredVar("JWT_PUBLIC_KEY_BASE64"), "base64").toString("ascii"),
    JWT_PRIVATE_KEY: Buffer.from(readRequiredVar("JWT_PRIVATE_KEY_BASE64"), "base64").toString("ascii"),
    AUTH_COOKIE_NAME: "omlet-auth-token",
    AUTH_COOKIE_LIFETIME_MSEC: 30 * 24 * 60 * 60 * 1000,
    PUBLIC_AUTH_TOKEN_COOKIE_NAME: "omlet-public-auth-token",
    AUTH_CLIENT_ID_COOKIE_NAME: "omlet-auth-client-id",
    // AuthRequest db schema has a ttl index, all documents older than 30mins are deleted automatically
    // so client id cookie lifetime is set the same duration as document ttl in the db
    AUTH_CLIENT_ID_COOKIE_LIFETIME_MSEC: 30 * 60 * 60 * 1000,
    USE_VITE_MIDDLEWARE: readBooleanVar(process.env.USE_VITE_MIDDLEWARE, isLocal),
    USE_STATIC_MIDDLEWARE: readBooleanVar(process.env.USE_STATIC_MIDDLEWARE, false),
    PORT: readIntegerVar(process.env.MW_PORT, 3001),
    EMAILS_ENABLED: readBooleanVar(process.env.EMAILS_ENABLED, false),
    ENABLE_TEST_USER: readBooleanVar(process.env.ENABLE_TEST_USER, false),
    MONGODB_URI: readRequiredVar("MONGODB_URI"),
    MONGODB_DEBUG_ENABLED: readBooleanVar(process.env.MONGODB_DEBUG_ENABLED, false),
    APP_BASE_URL: readRequiredVar("APP_BASE_URL"),
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
    GOOGLE_LOGIN_PATH: "/auth/google/login",
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "",
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "",
    GITHUB_LOGIN_PATH: "/auth/github/login",
    GITLAB_BASE_URL: process.env.GITLAB_BASE_URL ?? "https://gitlab.com",
    GITLAB_CLIENT_ID: process.env.GITLAB_CLIENT_ID ?? "",
    GITLAB_CLIENT_SECRET: process.env.GITLAB_CLIENT_SECRET ?? "",
    GITLAB_LOGIN_PATH: "/auth/gitlab/login",
    INVITE_LIFETIME_MSEC: 365 * 24 * 60 * 60 * 1000,
    APP_ENV,
    API_ROOT_PATH: "/api",
    REDIS_URI: readRequiredVar("REDIS_URI"),
    RESPONSE_COMPRESSION_ENABLED: readBooleanVar(process.env.RESPONSE_COMPRESSION_ENABLED, true),
    GRACEFUL_WORKER_SHUTDOWN_EXIT_CODE: 128,
    HTTP_GRACEFUL_TERMINATION_TIMEOUT: readIntegerVar(process.env.HTTP_GRACEFUL_TERMINATION_TIMEOUT, 11000),
    SHUTDOWN_DELAY: readIntegerVar(process.env.SHUTDOWN_DELAY, isLocal ? 0 : 11000),
    ENABLE_CLUSTER: readBooleanVar(process.env.ENABLE_CLUSTER, !isLocal),
    TIME_SERIES_CHUNK_SIZE: readIntegerVar(process.env.TIME_SERIES_CHUNK_SIZE, 10),
};

export { config, AppEnvType };
