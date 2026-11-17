const COLORS = { red: "#f00" } as const satisfies Record<string, string>;

export function AsConstSatisfies() {
    return <span style={{ color: COLORS.red }}>as const satisfies</span>;
}
