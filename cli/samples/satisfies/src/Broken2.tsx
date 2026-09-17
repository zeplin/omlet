const SIZES = { s: 1 } satisfies Record<string, number>;

export function Broken2() {
    return <span>{SIZES.s}</span>;
}
