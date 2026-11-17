const SIZES = { s: 1 } satisfies Record<string, number>;

export function ObjectSatisfies() {
    return <span>{SIZES.s}</span>;
}
