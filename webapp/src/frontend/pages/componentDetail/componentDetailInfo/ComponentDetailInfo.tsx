import { type UIEvent, type PropsWithChildren, useEffect, useRef, useState } from "react";

import classNames from "classnames";

import { FilterDataType } from "../../../../common/models/FilterDataType";
import { TruncateEnd } from "../../../common/truncate/TruncateEnd/TruncateEnd";
import { TruncateMultiline } from "../../../common/truncate/TruncateMultiline/TruncateMultiline";
import { H2, H4 } from "../../../library/Heading/Heading";
import { IconChild } from "../../../library/icons/IconChild";
import { IconMetadata } from "../../../library/icons/IconMetadata";
import { Skeleton } from "../../../library/Skeleton/Skeleton";
import { Tag } from "../../../library/Tag/Tag";
import { Tooltip, TooltipPlacement } from "../../../library/Tooltip/Tooltip";
import { type Component } from "../../../models/Component";
import { useStore } from "../../../providers/StoreProvider/StoreProvider";
import { formatDate, getCustomPropertyTypes, range } from "../../../utils";

import classes from "./ComponentDetailInfo.module.css";

type ComponentFieldProps = {
    name: string;
    type?: FilterDataType;
    value?: string | number | boolean | Date;
} & PropsWithChildren;

function getFieldContent(type: FilterDataType, value?: string | number | boolean | Date) {
    if (value === undefined) {
        return type === FilterDataType.Boolean
            ? "false"
            : "Not defined";
    }

    if (value instanceof Date) {
        return formatDate(value);
    }

    return value.toString();
}

function ComponentField({ name, type = FilterDataType.String, value, children }: ComponentFieldProps) {
    const isNotDefined = value === undefined && type !== FilterDataType.Boolean;

    return (
        <div className={classes.componentField}>
            <TruncateEnd className={classes.fieldName} content={name}/>
            <span className={classNames(classes.fieldValue, { [classes.notDefined]: isNotDefined })}>
                {children ?? <TruncateMultiline content={getFieldContent(type, value)} maxLines={4}/>}
            </span>
        </div>
    );
}

const NUMBER_OF_SKELETONS = 7;
const ZERO_WIDTH_SPACE = "\u200B";

interface Props {
    component?: Component;
    customProperties?: Record<string, (string | number | boolean | Date)[]>;
}

export function ComponentDetailInfo({ component, customProperties }: Props) {
    const componentDetailInfoRef = useRef<HTMLDivElement>(null);
    const [isTopShadowVisible, setIsTopShadowVisible] = useState(false);
    const [isBottomShadowVisible, setIsBottomShadowVisible] = useState(false);

    const { selectors: { getTags } } = useStore();

    useEffect(() => {
        if (componentDetailInfoRef.current) {
            if (componentDetailInfoRef.current.scrollTop + componentDetailInfoRef.current.clientHeight < componentDetailInfoRef.current.scrollHeight) {
                setIsBottomShadowVisible(true);
            }
        }
    }, [componentDetailInfoRef.current]);

    if (!component) {
        return (
            <div className={classes.skeletons}>
                {[...range(1, NUMBER_OF_SKELETONS)].map(i => (
                    <Skeleton key={i} className={classes.skeleton}/>
                ))}
            </div>
        );
    }

    const {
        name,
        numOfUsages,
        path,
        packageName,
        numOfDependencies,
        createdAt,
        updatedAt,
        lastUsageChangedAt,
        metadata,
    } = component;
    const tagSlugs = new Set(component.tags);
    const tags = getTags().filter(({ slug }) => tagSlugs.has(slug));
    const spacedPath = path.split("/").join(`/${ZERO_WIDTH_SPACE}`);

    const rootComponentUsage = customProperties?.rootComponent?.[0] as number | undefined;

    const birthday = (() => {
        if (!createdAt) {
            return null;
        }
        const componentBirthday = new Date(createdAt);
        const today = new Date();
        const isBirthday =
            componentBirthday.getMonth() === today.getMonth() &&
            componentBirthday.getDate() === today.getDate();
        if (!isBirthday) {
            return null;
        }
        const age = today.getFullYear() - componentBirthday.getFullYear();
        return { age, componentName: name };
    })();

    function handleScroll(event: UIEvent<HTMLDivElement>) {
        if (event.currentTarget.scrollTop > 0 && !isTopShadowVisible) {
            setIsTopShadowVisible(true);
        } else if (event.currentTarget.scrollTop === 0 && isTopShadowVisible) {
            setIsTopShadowVisible(false);
        }

        const scrollBottom = event.currentTarget.scrollTop + event.currentTarget.clientHeight;
        if (scrollBottom >= event.currentTarget.scrollHeight && isBottomShadowVisible) {
            setIsBottomShadowVisible(false);
        } else if (scrollBottom < event.currentTarget.scrollHeight && !isBottomShadowVisible) {
            setIsBottomShadowVisible(true);
        }
    }

    function renderMetadata() {
        if (!metadata || !customProperties) {
            return null;
        }

        const metadataArray = Object.entries(metadata);
        if (metadataArray.length === 0) {
            return null;
        }

        const filteredCustomProperties = Object.fromEntries(
            Object.entries(customProperties).filter(([key]) => key !== "rootComponent" && key !== "subcomponents"),
        );
        const customPropertyNames = Object.keys(filteredCustomProperties);
        if (customPropertyNames.length === 0) {
            return null;
        }
        const customPropertyTypes = getCustomPropertyTypes(filteredCustomProperties);

        return (
            <section>
                <H4 className={classes.customPropertiesHeading}>
                    <IconMetadata/>
                    <span>CUSTOM PROPERTIES</span>
                </H4>
                {customPropertyNames.map(name =>
                    <ComponentField key={name} name={name} type={customPropertyTypes[name]} value={metadata[name]}/>,
                )}
            </section>
        );
    }

    return (
        <div ref={componentDetailInfoRef} className={classes.componentDetailInfo} onScroll={handleScroll}>
            {isTopShadowVisible && <div className={classNames(classes.scrollShadow, classes.top)}/>}
            <div className={classes.header}>
                <H2 className={classes.name}>
                    <TruncateMultiline content={name} contentName="name" maxLines={2}/>
                </H2>
                <div>{packageName}</div>
                <TruncateMultiline className={classes.path} content={spacedPath} contentName="path" maxLines={4}/>
                {
                    tags.length > 0 && (
                        <div className={classes.tags}>
                            {tags.map(tag => <Tag key={tag.slug} tag={tag}/>)}
                        </div>
                    )
                }
            </div>
            <section>
                <ComponentField name="# of children">
                    <IconChild/>
                    <span>{numOfDependencies}</span>
                </ComponentField>
                <ComponentField name="# Used" value={numOfUsages}/>
                {rootComponentUsage !== undefined && (
                    <ComponentField name="# Root used" value={rootComponentUsage}/>
                )}
                <ComponentField
                    name="Created"
                    value={createdAt ? formatDate(createdAt) : "Over a year"}
                >
                    {birthday && (
                        <>
                            {createdAt && formatDate(createdAt)}
                            <Tooltip
                                content={`${birthday.componentName} is ${birthday.age} years old today! 🥳`}
                                placement={TooltipPlacement.Top}
                            >
                                {" 🎂"}
                            </Tooltip>
                        </>
                    )}
                </ComponentField>
                <ComponentField name="Updated" value={updatedAt ? formatDate(updatedAt) : "Over a year"}/>
                <ComponentField name="Usage change" value={formatDate(lastUsageChangedAt)}/>
            </section>
            {renderMetadata()}
            {isBottomShadowVisible && <div className={classNames(classes.scrollShadow, classes.bottom)}/>}
        </div>
    );
}
