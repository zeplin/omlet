const THEME = {
    spacing: 8,
    radius: 4
} as const satisfies { spacing: number; radius: number };

export function Theme() {
    return <div style={{ padding: THEME.spacing, borderRadius: THEME.radius }} />;
}
