import { Types } from "mongoose";
import {
    ComponentNotFound,
    getComponentSubcomponents,
} from "../../src/backend/service/component/component";
import { HistoricComponentIndexModel } from "../../src/backend/service/component/models";

jest.mock("../../src/backend/service/component/models", () => ({
    __esModule: true,
    HistoricComponentIndexModel: {
        findOne: jest.fn(() => ({
            sort: jest.fn(),
        })),
        aggregate: jest.fn(),
    },
}));

function createMockAggregationResult(overrides: Record<string, unknown> = {}) {
    return {
        _id: new Types.ObjectId(),
        definitionId: "def-default",
        name: "Default",
        packageName: "@test/pkg",
        path: "/src/default.tsx",
        isInternal: true,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        numOfDependencies: 0,
        tags: [],
        numOfUsages: 0,
        lastUsageChangedAt: new Date("2024-01-01"),
        metadata: {},
        ...overrides,
    };
}

describe("getComponentSubcomponents", () => {
    const mockedFindOne = HistoricComponentIndexModel.findOne as jest.Mock;
    const mockedAggregate = HistoricComponentIndexModel.aggregate as jest.Mock;
    const workspaceId = "507f1f77bcf86cd799439011";
    const analysisId = new Types.ObjectId();
    let mockedSort: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockedSort = jest.fn();
        mockedFindOne.mockReturnValue({ sort: mockedSort });
        mockedSort.mockResolvedValue({ lastAnalysis: analysisId });
    });

    it("should return dotted subcomponents (Accordion.Root under parent Accordion)", async () => {
        const parentId = "parent-accordion";
        const parent = createMockAggregationResult({
            definitionId: parentId,
            name: "Accordion",
            numOfUsages: 10,
        });

        const sub = createMockAggregationResult({
            definitionId: "sub-item",
            name: "Accordion.Item",
            numOfUsages: 5,
            packageName: parent.packageName,
        });

        mockedAggregate
            .mockResolvedValueOnce([parent]) // findLatestComponentsByDefinitionId
            .mockResolvedValueOnce([sub]); // subcomponent aggregation

        const result = await getComponentSubcomponents(workspaceId, parentId);

        expect(result.subcomponents).toHaveLength(1);
        expect(result.subcomponents[0].name).toBe("Accordion.Item");
        expect(result.familyUsage).toBe(15);
    });

    it("should return prefix subcomponents (CardHeader under parent Card)", async () => {
        const parentId = "parent-card";
        const parent = createMockAggregationResult({
            definitionId: parentId,
            name: "Card",
            numOfUsages: 7,
        });

        const sub = createMockAggregationResult({
            definitionId: "sub-header",
            name: "CardHeader",
            numOfUsages: 4,
            packageName: parent.packageName,
        });

        mockedAggregate
            .mockResolvedValueOnce([parent])
            .mockResolvedValueOnce([sub]);

        const result = await getComponentSubcomponents(workspaceId, parentId);

        expect(result.subcomponents).toHaveLength(1);
        expect(result.subcomponents[0].name).toBe("CardHeader");
        expect(result.familyUsage).toBe(11);
    });

    it("should exclude names without a capital letter immediately after the parent name", async () => {
        const parentId = "parent-card";
        const parent = createMockAggregationResult({
            definitionId: parentId,
            name: "Card",
            numOfUsages: 7,
        });

        mockedAggregate
            .mockResolvedValueOnce([parent])
            .mockResolvedValueOnce([]);

        const result = await getComponentSubcomponents(workspaceId, parentId);

        expect(result.subcomponents).toHaveLength(0);
        expect(result.familyUsage).toBe(7);

        const pipeline = mockedAggregate.mock.calls[1][0];
        const matchStage = pipeline.find(
            (stage: Record<string, unknown>) =>
                "$match" in stage && Array.isArray((stage.$match as Record<string, unknown>).$or)
        );
        expect(matchStage).toBeDefined();

        const $match = matchStage.$match as Record<string, unknown>;
        const orArray = $match.$or as Array<Record<string, unknown>>;
        expect(orArray).toHaveLength(2);

        const dottedPattern = orArray[0]["entries.component.name"] as RegExp;
        const prefixPattern = orArray[1]["entries.component.name"] as RegExp;

        expect(dottedPattern.test("Card.Title")).toBe(true);
        expect(dottedPattern.test("CardTitle")).toBe(false);

        expect(prefixPattern.test("CardHeader")).toBe(true);
        expect(prefixPattern.test("CardFooter")).toBe(true);
        expect(prefixPattern.test("Cardboard")).toBe(false);
        expect(prefixPattern.test("Card")).toBe(false);
        expect(prefixPattern.test("Card.")).toBe(false);
    });

    it("should aggregate familyUsage across dotted and prefix subcomponents", async () => {
        const parentId = "parent-tabs";
        const parent = createMockAggregationResult({
            definitionId: parentId,
            name: "Tabs",
            numOfUsages: 20,
        });

        const sub1 = createMockAggregationResult({
            definitionId: "sub-list",
            name: "Tabs.List",
            numOfUsages: 8,
            packageName: parent.packageName,
        });

        const sub2 = createMockAggregationResult({
            definitionId: "sub-trigger",
            name: "TabsTrigger",
            numOfUsages: 12,
            packageName: parent.packageName,
        });

        mockedAggregate
            .mockResolvedValueOnce([parent])
            .mockResolvedValueOnce([sub1, sub2]);

        const result = await getComponentSubcomponents(workspaceId, parentId);

        expect(result.subcomponents).toHaveLength(2);
        expect(result.subcomponents.map((c: { name: string }) => c.name)).toContain("Tabs.List");
        expect(result.subcomponents.map((c: { name: string }) => c.name)).toContain("TabsTrigger");
        expect(result.familyUsage).toBe(40);
    });

    it("should return empty results when no latest analysis exists", async () => {
        mockedSort.mockResolvedValue(null);

        const result = await getComponentSubcomponents(workspaceId, "some-id");

        expect(result.subcomponents).toHaveLength(0);
        expect(result.familyUsage).toBe(0);
    });

    it("should throw ComponentNotFound when the parent component does not exist", async () => {
        mockedAggregate.mockResolvedValueOnce([]);

        await expect(getComponentSubcomponents(workspaceId, "missing-id")).rejects.toBeInstanceOf(
            ComponentNotFound
        );
    });
});
