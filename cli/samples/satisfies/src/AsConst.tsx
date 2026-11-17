const COLORS = { red: "#f00" } as const;

export function AsConst() {
    return <span style={{ color: COLORS.red }}>ok</span>;
}
