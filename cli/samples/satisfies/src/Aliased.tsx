import type { FC } from "react";

function Base({ title }: { title: string }) {
    return <h1>{title}</h1>;
}

export const Aliased = Base satisfies FC<{ title: string }>;
