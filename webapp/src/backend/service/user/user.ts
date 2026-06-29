import { LoginProviderType } from "../auth/models";
import { ServiceError } from "../error";
import { UserNotHaveWorkspace, findDefaultWorkspace } from "../workspace/workspace";

import { type Profession, type UserDoc, type UserSessionDoc, AdminUserModel, UserModel, UserSessionModel } from "./models";

export class UserNotFound extends ServiceError {
    constructor({ user }: { user: string; }) {
        super("User not found", {
            details: {
                user,
            },
        });
    }
}

interface CreateUserData {
    email: string;
    fullName?: string;
    avatarUrl?: string;
    loginProvider: LoginProviderType;
    externalId: string;
}

export class User {
    id: string;
    email: string;
    fullName?: string;
    avatarUrl?: string;
    profession?: Profession;
    loginProviders: [{
        externalId: string;
        type: LoginProviderType;
    }];
    lastSeen?: Date;
    createdAt: Date;

    constructor(props: UserDoc) {
        this.id = props.id;
        this.email = props.email;
        this.fullName = props.fullName;
        this.avatarUrl = props.avatarUrl;
        this.profession = props.profession;
        this.loginProviders = props.loginProviders;
        this.createdAt = props.createdAt;
    }

    static fromDoc(doc: UserDoc): User {
        return new User(doc);
    }

    toResponse() {
        return {
            id: this.id,
            email: this.email,
            fullName: this.fullName,
            avatarUrl: this.avatarUrl,
            profession: this.profession,
            loginProviders: this.loginProviders,
            lastSeen: this.lastSeen,
            createdAt: this.createdAt,
        };
    }
}


export class UserSession {
    id: string;

    constructor(props: UserSessionDoc) {
        this.id = props.id;
    }

    static fromDoc(doc: UserSessionDoc): UserSession {
        return new UserSession(doc);
    }
}

export async function createUser(userData: CreateUserData): Promise<User> {
    const userDoc = new UserModel({
        email: userData.email,
        fullName: userData.fullName,
        avatarUrl: userData.avatarUrl,
        loginProviders: [{
            type: userData.loginProvider,
            externalId: userData.externalId,
        }],
    });

    const doc = await userDoc.save();

    return User.fromDoc(doc);
}

export async function createUserSession(userId: string, loginProvider: LoginProviderType): Promise<UserSession> {
    const sessionDoc = new UserSessionModel({ user: userId, loginProvider });
    await sessionDoc.save();

    return UserSession.fromDoc(sessionDoc);
}

export async function linkExternalAccount(userId: string, loginProvider: LoginProviderType, externalId: string) {
    await UserModel.updateOne({
        _id: userId,
    }, {
        $push: {
            loginProviders: {
                type: loginProvider,
                externalId,
            },
        },
    });
}

export async function findUserById(userId: string): Promise<User | null> {
    const doc = await UserModel.findById(userId);

    return doc ? User.fromDoc(doc) : null;
}

export async function findUserByEmail(email: string | string[]): Promise<User | null> {
    let doc;
    if (Array.isArray(email)) {
        doc = await UserModel.findByEmails(email);
    } else {
        doc = await UserModel.findByEmail(email);
    }

    return doc ? User.fromDoc(doc) : null;
}

export async function findUserByLoginProvider(provider: LoginProviderType, externalId: string): Promise<User | null> {
    const doc = await UserModel.findOne({
        loginProviders: {
            type: provider,
            externalId,
        },
    });

    return doc ? User.fromDoc(doc) : null;
}

export async function findTestUser(): Promise<User> {
    const doc = await UserModel.findOne({
        email: "test@example.com",
    });

    return User.fromDoc(doc!);
}

export async function markUserAsAdmin(userId: string) {
    const adminUserDoc = new AdminUserModel({
        user: userId,
    });

    return adminUserDoc.save();
}

export async function isAdminUser(userId: string): Promise<boolean> {
    const adminUserDoc = await AdminUserModel.findOne({
        user: userId,
    });

    return adminUserDoc !== null;
}

export async function getMultipleUsers(userIds: string[]): Promise<User[]> {
    const docs = await UserModel.find({
        _id: {
            $in: userIds,
        },
    });

    return docs.map(doc => User.fromDoc(doc));
}

export async function resetUserLoginProviders(userId: string, newEmail: string): Promise<void> {
    const typesToClear: LoginProviderType[] = [LoginProviderType.Github, LoginProviderType.Gitlab, LoginProviderType.Google];
    await UserModel.updateOne(
        { _id: userId },
        { $pull: { loginProviders: { type: { $in: typesToClear } } } }
    );

    await UserModel.updateOne(
        { _id: userId },
        { $set: { "loginProviders.$[elem].externalId": newEmail } },
        { arrayFilters: [{ "elem.type": LoginProviderType.Email }] }
    );
}

export async function updateUser(userId: string, userData: Partial<Pick<User, "email" | "fullName" | "avatarUrl" | "profession">>): Promise<User> {
    const userDoc = await UserModel.findByIdAndUpdate(userId, { $set: userData });

    if (!userDoc) {
        throw new UserNotFound({ user: userId });
    }

    return User.fromDoc(userDoc);
}

export async function hasDefaultWorkspace(userId: string): Promise<boolean> {
    try {
        await findDefaultWorkspace(userId);

        return true;
    } catch (error) {
        if (error instanceof UserNotHaveWorkspace) {
            return false;
        }

        throw error;
    }
}
