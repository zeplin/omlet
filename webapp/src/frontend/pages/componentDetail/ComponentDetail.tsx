import { useEffect, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { compareString } from "../../../common/sortUtils";
import {
    getCustomProperties,
    getLatestAnalysisComponent,
    getLatestAnalysisComponentDependencies,
    getLatestAnalysisComponentProps,
    getLatestAnalysisComponentSubcomponents,
} from "../../api/api";
import { IconComponents } from "../../library/icons/IconComponents";
import { IconDependencyTree } from "../../library/icons/IconDependencyTree";
import { IconProps } from "../../library/icons/IconProps";
import { logError } from "../../logger";
import { type Component } from "../../models/Component";
import { type ComponentProps } from "../../models/ComponentProps";
import { useStore } from "../../providers/StoreProvider/StoreProvider";

import { ComponentDetailInfo } from "./componentDetailInfo/ComponentDetailInfo";
import { PropsTable } from "./propsTable/PropsTable";
import { PropUsages } from "./propUsages/PropUsages";
import { SubcomponentsTable } from "./subcomponentsTable/SubcomponentsTable";
import { Tabs } from "./tabs/Tabs";
import { TreeViewWithReactFlowProvider as TreeView } from "./treeView/TreeView";

import classes from "./ComponentDetail.module.css";

function getComponentsWithLevel(
    mainComponentId: string,
    componentMap: Record<string, ComponentWithLevel>,
    dependencyMap: Record<string, Set<string>>,
    isPositiveStep: boolean,
) {
    const queue = [mainComponentId];
    const componentsWithLevel = [];

    while (queue.length > 0) {
        const currentComponentId = queue.shift()!;
        const currentComponent = componentMap[currentComponentId];
        if (!currentComponent) {
            continue;
        }
        const nextLevel = currentComponent.level + (isPositiveStep ? 1 : -1);
        for (const nextComponentId of dependencyMap[currentComponentId] ?? new Set()) {
            const nextComponent = componentMap[nextComponentId];
            if (!nextComponent || Number.isFinite(nextComponent.level)) {
                continue;
            }
            componentMap[nextComponentId].level = nextLevel;
            queue.push(nextComponentId);
            componentsWithLevel.push(componentMap[nextComponentId]);
        }
    }
    return componentsWithLevel;
}

interface DependencyTreeData {
    parents: ComponentWithLevel[];
    children: ComponentWithLevel[];
    dependencyMap: Record<string, Set<string>>;
    reverseDependencyMap: Record<string, Set<string>>;
}

export type ComponentWithLevel = Component & { level: number; };

type State<D> = {
    definitionId: string;
    data: D;
};

export function ComponentDetail() {
    const { workspaceSlug, componentSlug, activeTab } = useParams();
    const [searchParams] = useSearchParams();
    const selectedProp = searchParams.get("selected_prop");
    const [expandedProps, setExpandedProps] = useState(new Set<string>());
    const navigate = useNavigate();
    const [dependencyTreeData, setDependencyTreeData] = useState<State<DependencyTreeData> | null>(null);
    const [componentProps, setComponentProps] = useState<State<ComponentProps> | null>(null);
    const [nodeCountByLevel, setNodeCountByLevel] = useState<Record<string, number>>({});

    const { selectors: { getWorkspace } } = useStore();
    const workspace = getWorkspace()!;

    const [component, setComponent] = useState<Component | undefined>(undefined);
    const [subcomponents, setSubcomponents] = useState<Component[] | undefined>(undefined);
    const [familyUsage, setFamilyUsage] = useState<number | undefined>(undefined);
    const [, definitionId] = useMemo(() => componentSlug?.split("::") ?? [], [componentSlug]);

    const { data: customProperties } = useQuery({
        queryKey: ["customProperties", workspaceSlug],
        async queryFn() {
            const customProperties = await getCustomProperties(workspaceSlug!);

            return Object.fromEntries(
                Object.entries(customProperties).sort(([k1], [k2]) => compareString(k1, k2))
            );
        },
    });

    const detailInfoCustomProperties = useMemo(() => {
        if (!customProperties) {
            return undefined;
        }
        const result: Record<string, (string | number | boolean | Date)[]> = { ...customProperties };
        if (subcomponents !== undefined) {
            result.subcomponents = [subcomponents.length];
        }
        if (familyUsage !== undefined) {
            result.rootComponent = [familyUsage];
        }
        return result;
    }, [customProperties, familyUsage, subcomponents]);

    useEffect(() => {
        if (activeTab === "dependency-tree" || componentProps?.definitionId === definitionId) {
            return;
        }
        async function fetchComponentProps() {
            try {
                setComponentProps({
                    definitionId,
                    data: await getLatestAnalysisComponentProps(workspaceSlug!, encodeURIComponent(definitionId)),
                });
            } catch (error) {
                logError(error);

                navigate("..");
            }
        }
        setComponentProps(null);
        fetchComponentProps();
    }, [activeTab, workspace, definitionId]);

    useEffect(() => {
        async function fetchComponent() {
            try {
                setComponent(await getLatestAnalysisComponent(workspaceSlug!, encodeURIComponent(definitionId)));

            } catch (error) {
                logError(error);

                navigate("..");
            }
        }
        fetchComponent();
    }, [workspace, definitionId]);

    useEffect(() => {
        async function fetchSubcomponents() {
            try {
                const { subcomponents, familyUsage } = await getLatestAnalysisComponentSubcomponents(workspaceSlug!, encodeURIComponent(definitionId));
                setSubcomponents(subcomponents);
                setFamilyUsage(familyUsage);
            } catch (error) {
                logError(error);
            }
        }
        setSubcomponents(undefined);
        setFamilyUsage(undefined);
        fetchSubcomponents();
    }, [workspace, definitionId]);

    useEffect(() => {
        if (activeTab !== "dependency-tree") {
            return;
        }

        async function fetchDependencies() {
            try {
                const { components, dependencies } = await getLatestAnalysisComponentDependencies(workspaceSlug!, encodeURIComponent(definitionId));
                const componentMap = Object.fromEntries(components.map(component => [component.definitionId, { level: Infinity, ...component }]));
                componentMap[definitionId].level = 0;
                const dependencyMap = dependencies.reduce<Record<string, Set<string>>>(
                    (acc, [source, target]) => {
                        if (!(source in acc)) {
                            acc[source] = new Set();
                        }
                        acc[source].add(target);
                        return acc;
                    },
                    {}
                );
                const reverseDependencyMap = dependencies.reduce<Record<string, Set<string>>>(
                    (acc, [ source, target]) => {
                        if (!(target in acc)) {
                            acc[target] = new Set();
                        }
                        acc[target].add(source);
                        return acc;
                    },
                    {}
                );
                const children = getComponentsWithLevel(definitionId, componentMap, dependencyMap, true);
                const parents = getComponentsWithLevel(definitionId, componentMap, reverseDependencyMap, false);
                setDependencyTreeData({
                    data: {
                        dependencyMap,
                        reverseDependencyMap,
                        parents,
                        children,
                    },
                    definitionId,
                });
            } catch (error) {
                logError(error);

                navigate("..");
            }
        }

        setDependencyTreeData(null);
        fetchDependencies();
    }, [activeTab, workspace, definitionId]);

    function handlePropClick(propName: string) {
        setExpandedProps(prev => {
            const next = new Set(prev);
            if (next.has(propName)) {
                next.delete(propName);
            } else {
                next.add(propName);
            }
            return next;
        });
    }

    const treeView = <TreeView
        loading={!dependencyTreeData || !component}
        mainComponent={component}
        parents={dependencyTreeData?.data.parents ?? []}
        children={dependencyTreeData?.data.children ?? []}
        reverseDependencyMap={dependencyTreeData?.data.reverseDependencyMap ?? {}}
        dependencyMap={dependencyTreeData?.data.dependencyMap ?? {}}
        nodeCountByLevel={nodeCountByLevel}
        setNodeCountByLevel={setNodeCountByLevel}/>;

    return (
        <main className={classes.componentDetail}>
            <div className={classes.leftPanel}>
                <ComponentDetailInfo
                    component={component}
                    customProperties={detailInfoCustomProperties}/>
            </div>
            {(
                selectedProp
                    ? <PropUsages />
                    : <Tabs
                        key={`tabs-${JSON.stringify(workspace)}`}
                        activeTab={activeTab!}
                        items={[
                            {
                                key: "props",
                                label: (
                                    <>
                                        <IconProps />
                                        <div>
                                            Props
                                        </div>
                                    </>
                                ),
                                content: (
                                    <PropsTable
                                        loading={!componentProps || !component}
                                        componentName={component?.name ?? ""}
                                        expandedProps={expandedProps}
                                        props={componentProps?.data.props ?? []}
                                        numberOfUsages={componentProps?.data.numberOfUsages ?? 0}
                                        onPropClick={handlePropClick} />
                                ),
                            },
                            {
                                key: "subcomponents",
                                label: (
                                    <>
                                        <IconComponents />
                                        <div>
                                            Subcomponents
                                        </div>
                                    </>
                                ),
                                content: (
                                    <SubcomponentsTable
                                        loading={subcomponents === undefined}
                                        subcomponents={subcomponents ?? []}
                                        workspaceSlug={workspaceSlug!} />
                                ),
                            },
                            {
                                key: "dependency-tree",
                                label: (
                                    <>
                                        <IconDependencyTree />
                                        <div>
                                            Dependency Tree
                                        </div>
                                    </>
                                ),
                                content: treeView,
                            },
                        ]}/>
            )}
        </main>
    );
}
