import classNames from "classnames";
import { Link, generatePath } from "react-router-dom";

import { RoutePath } from "../../../../common/RoutePath";
import { EmptyBlock } from "../../../common/EmptyBlock/EmptyBlock";
import { Skeleton } from "../../../library/Skeleton/Skeleton";
import { type Component } from "../../../models/Component";
import { range } from "../../../utils";

import classes from "./SubcomponentsTable.module.css";

interface Props {
    loading: boolean;
    subcomponents: Component[];
    workspaceSlug: string;
}

export function SubcomponentsTable({ loading, subcomponents, workspaceSlug }: Props) {
    if (loading) {
        return (
            <div className={classNames(classes.subcomponentsTable, classes.loading)}>
                <div className={classes.header}>
                    <div className={classes.cell}>Name</div>
                    <div className={classes.cell}># Used</div>
                </div>
                {[...range(1, 5)].map(i => (
                    <div className={classes.row} key={i}>
                        {i > 1 && <div className={classes.separator} />}
                        <div className={classes.cell}>
                            <Skeleton className={classes.skeleton} />
                        </div>
                        <div className={classes.cell}>
                            <Skeleton className={classes.skeleton} />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (subcomponents.length === 0) {
        return (
            <EmptyBlock
                message="No subcomponents found for this component."
            />
        );
    }

    return (
        <div className={classes.subcomponentsTable}>
            <div className={classes.header}>
                <div className={classes.cell}>Name</div>
                <div className={classes.cell}># Used</div>
            </div>
            {subcomponents.map(({ name, definitionId, numOfUsages }, i) => {
                const componentSlug = encodeURIComponent(`${name}::${definitionId}`);
                const to = generatePath(RoutePath.ComponentDetail, {
                    workspaceSlug,
                    componentSlug,
                });

                return (
                    <div className={classes.row} key={definitionId}>
                        {i > 0 && <div className={classes.separator} />}
                        <Link className={classes.cell} to={to}>
                            {name}
                        </Link>
                        <div className={classes.cell}>
                            {numOfUsages}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
