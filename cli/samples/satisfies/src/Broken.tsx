const COLORS = { red: "#f00" } as const satisfies Record<string, string>;

export function Broken() {
    return <span style={{ color: COLORS.red }}>broken</span>;
}
