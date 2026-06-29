/* eslint-disable no-console */
import crypto from "crypto";
import fs from "fs";
import path from "path";

function generateRsaKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: {
            type: "spki",
            format: "pem",
        },
        privateKeyEncoding: {
            type: "pkcs8",
            format: "pem",
        },
    });

    return {
        privateKey: Buffer.from(privateKey).toString("base64"),
        publicKey: Buffer.from(publicKey).toString("base64"),
    };
}

function createEnvFile() {
    const envPath = path.resolve(__dirname, ".env");

    if (fs.existsSync(envPath)) {
        console.log(".env file already exists. Skipping creation.");
        return;
    }

    try {
        const rsaKeys = generateRsaKeyPair();

        const envVars: Record<string, string> = {
            MODE: "development",
            NODE_ENV: "development",
            JWT_PRIVATE_KEY_BASE64: rsaKeys.privateKey,
            JWT_PUBLIC_KEY_BASE64: rsaKeys.publicKey,
            MW_PORT: "3001",
            EMAILS_ENABLED: "false",
            ENABLE_TEST_USER: "true",
            MONGODB_URI: "mongodb://localhost:27017/omlet",
            MONGODB_DEBUG_ENABLED: "false",
            REDIS_URI: "redis://localhost:6379",
            APP_BASE_URL: "http://localhost:3001",
            GOOGLE_CLIENT_ID: "",
            GOOGLE_CLIENT_SECRET: "",
            GITHUB_CLIENT_ID: "",
            GITHUB_CLIENT_SECRET: "",
            GITLAB_BASE_URL: "https://gitlab.com",
            GITLAB_CLIENT_ID: "",
            GITLAB_CLIENT_SECRET: "",
            APP_ENV: "local",
            RESPONSE_COMPRESSION_ENABLED: "true",
            USE_STATIC_MIDDLEWARE: "false",
            VITE_APP_BASE_URL: "http://localhost:3001",
            VITE_LANDING_PAGE_BASE_URL: "https://omlet.dev",
            VITE_CHECKER_DISABLED: "false",
            VITE_EMAILS_ENABLED: "false",
        };

        for (const key in envVars) {
            const value = process.env[key];

            if (value !== undefined) {
                envVars[key] = value;
            }
        }

        const envContent = Object.entries(envVars)
            .map(([key, value]) => `${key}="${value}"`)
            .join("\n");

        // Write the content to the .env file
        fs.writeFileSync(envPath, `${envContent}\n`);

        console.log(".env file created successfully.");
    } catch (error) {
        console.error("Error creating .env file:", error);
    }

    process.exit(0);
}

createEnvFile();
