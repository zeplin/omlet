const COLORS = { red: "#f00" } as const;

export function Ok() {
    return <span style={{ color: COLORS.red }}>ok</span>;
}
