jest.setTimeout(30000); // sets the timeout to 30 seconds

import { config } from "dotenv";
config({ path: "./.env.test" });

import { close as closeDb, init as initDb } from "./helper/db/mongo";
import { close as closeCache, init as initCache } from "./helper/db/redis";

beforeAll(async () => {
    await initDb();

    await initCache();
});

afterAll(async () => {
    await closeDb();

    await closeCache();
});
