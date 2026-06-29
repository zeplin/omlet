import { type Types, model, Schema } from "mongoose";

const AUTH_REQUEST_COLLECTION_NAME = "authRequests";

export enum LoginProviderType {
    Google = "google",
    Github = "github",
    Gitlab = "gitlab",
    Email = "email",
}

export interface AuthRequestDoc {
    user?: Types.ObjectId;
    email: string;
    code: string;
    createdAt: Date;
}

/**
 *  This schema has a ttl index, all documents older than half an hour is deleted automatically
 */
const AuthRequestSchema = new Schema<AuthRequestDoc>({
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: false,
    },
    email: {
        type: String,
        required: true,
    },
    code: {
        type: String,
        required: true,
        unique: true,
    },
}, {
    timestamps: true,
    toJSON: {
        virtuals: true,
    },
    toObject: {
        virtuals: true,
    },
});
export const AuthRequestModel = model<AuthRequestDoc>("AuthRequest", AuthRequestSchema, AUTH_REQUEST_COLLECTION_NAME);
