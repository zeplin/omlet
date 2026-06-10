module.exports = {
    async up(db, client) {
        const analysesCollection = db.collection("analyses");
        await analysesCollection.createIndex(["workspace"], { name: "workspace_1" });
        await analysesCollection.createIndex(["workspace", "_id"], { name: "workspace_1_id_1" });

        const authRequestsCollection = db.collection("authRequests");
        await authRequestsCollection.createIndex({ "createdAt": 1 }, { name: "ttl", expireAfterSeconds: 1800 });

        const componentUsagesCollection = db.collection("componentUsages");
        await componentUsagesCollection.createIndex(["workspace"], { name: "workspace_1" });
        await componentUsagesCollection.createIndex(["parentDefinitionId"], { name: "parentDefinitionId_1" });
        await componentUsagesCollection.createIndex(["childDefinitionId"], { name: "childDefinitionId_1" });
        await componentUsagesCollection.createIndex(["parentId"], { name: "parentId_1" });
        await componentUsagesCollection.createIndex(["analysis", "childDefinitionId"], { name: "analysis_1_childDefinitionId_1" });

        const componentsCollection = db.collection("components");
        await componentsCollection.createIndex(["workspace"], { name: "workspace_1" });
        await componentsCollection.createIndex(["analysis"], { name: "analysis_1" });
        await componentsCollection.createIndex(["definitionId"], { name: "definitionId_1" });

        const componentExportIdsCollection = db.collection("componentExportIds");
        await componentExportIdsCollection.createIndex(["component", "exportId"], { name: "component_exportId_1", unique: true });

        const dataIssuesCollection = db.collection("dataIssues");
        await dataIssuesCollection.createIndex(["workspace", "analysis"], { name: "workspace_1_analysis_1" });

        const depGraphCollection = db.collection("dependencygraphs");
        await depGraphCollection.createIndex(["analysis"], { name: "analysis_1" });

        const historicIndexCollection = db.collection("historicComponentIndex");
        await historicIndexCollection.createIndex(["workspace"], { name: "workspace_1" });
        await historicIndexCollection.createIndex(["lastAnalysis"], { name: "lastAnalysis_1" });
        await historicIndexCollection.createIndex(["analyzedAt"], { name: "analyzedAt_1" });
        await historicIndexCollection.createIndex(["workspace", "lastAnalysis"], { name: "workspace_1_lastAnalysis_1" });

        const savedChartsCollection = db.collection("savedCharts");
        await savedChartsCollection.createIndex(["workspace"], { name: "workspace_1" });
        await savedChartsCollection.createIndex(["workspace", "slug"], { name: "unique_workspace_saved_chart_slug_1", unique: true });

        const usersCollection = db.collection("users");
        await usersCollection.createIndex(["email"], { name: "email_1" });

        const usersessionsCollection = db.collection("usersessions");
        await usersessionsCollection.createIndex(["user"], { name: "user_1" });

        const workspaceinvitesCollection = db.collection("workspaceinvites");
        await workspaceinvitesCollection.createIndex(["workspace"], { name: "workspace_1" });
        await workspaceinvitesCollection.createIndex(["code"], { name: "code_1" });
        await workspaceinvitesCollection.createIndex(["email"], { name: "email_1" });

        const workspaceInviteLinksCollection = db.collection("workspaceInviteLinks");
        await workspaceInviteLinksCollection.createIndex(["workspace"], { name: "workspace_1" });
        await workspaceInviteLinksCollection.createIndex(["workspace", "code"], { name: "unique_workspace_invite_code_1", unique: true });

        const workspaceCollection = db.collection("workspaces");
        await workspaceCollection.createIndex(["projects.packageName"], { name: "projects_packageName_1" });
        await workspaceCollection.createIndex(["projects.slug"], { name: "projects_slug_1" });
        await workspaceCollection.createIndex(["members.user"], { name: "members_user_1" });
    },

    async down(db, client) {
        const analysesCollection = db.collection("analyses");
        await analysesCollection.dropIndex("workspace_1");
        await analysesCollection.dropIndex("workspace_1_id_1");

        const authRequestsCollection = db.collection("authRequests");
        await authRequestsCollection.dropIndex("ttl");

        const componentUsagesCollection = db.collection("componentUsages");
        await componentUsagesCollection.dropIndex("workspace_1");
        await componentUsagesCollection.dropIndex("parentDefinitionId_1");
        await componentUsagesCollection.dropIndex("childDefinitionId_1");
        await componentUsagesCollection.dropIndex("parentId_1");
        await componentUsagesCollection.dropIndex("analysis_1_childDefinitionId_1");

        const componentsCollection = db.collection("components");
        await componentsCollection.dropIndex("workspace_1");
        await componentsCollection.dropIndex("analysis_1");
        await componentsCollection.dropIndex("definitionId_1");

        const componentExportIdsCollection = db.collection("componentExportIds");
        await componentExportIdsCollection.dropIndex("component_exportId_1");

        const dataIssuesCollection = db.collection("dataIssues");
        await dataIssuesCollection.dropIndex("workspace_1_analysis_1" );

        const depGraphCollection = db.collection("dependencygraphs");
        await depGraphCollection.dropIndex("analysis_1");

        const historicIndexCollection = db.collection("historicComponentIndex");
        await historicIndexCollection.dropIndex("workspace_1");
        await historicIndexCollection.dropIndex("lastAnalysis_1");
        await historicIndexCollection.dropIndex("analyzedAt_1");
        await historicIndexCollection.dropIndex("workspace_1_lastAnalysis_1");

        const savedChartsCollection = db.collection("savedCharts");
        await savedChartsCollection.dropIndex("workspace_1");
        await savedChartsCollection.dropIndex("unique_workspace_saved_chart_slug_1");

        const usersCollection = db.collection("users");
        await usersCollection.dropIndex("email_1");

        const usersessionsCollection = db.collection("usersessions");
        await usersessionsCollection.dropIndex("user_1");

        const workspaceinvitesCollection = db.collection("workspaceinvites");
        await workspaceinvitesCollection.dropIndex("workspace_1");
        await workspaceinvitesCollection.dropIndex("code_1");
        await workspaceinvitesCollection.dropIndex("email_1");

        const workspaceInviteLinksCollection = db.collection("workspaceInviteLinks");
        await workspaceInviteLinksCollection.dropIndex("workspace_1");
        await workspaceInviteLinksCollection.dropIndex("unique_workspace_invite_code_1");

        const workspaceCollection = db.collection("workspaces");
        await workspaceCollection.dropIndex("projects_packageName_1");
        await workspaceCollection.dropIndex("projects_slug_1");
        await workspaceCollection.dropIndex("members_user_1");
    }
};
