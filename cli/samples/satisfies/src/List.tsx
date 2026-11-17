type Entry = { id: number };

const ENTRIES = [{ id: 1 }, { id: 2 }].reduce<Entry[]>(
    (acc, entry) => [...acc, entry satisfies Entry],
    []
);

export function List() {
    return (
        <ul>
            {ENTRIES.map(entry => (
                <li key={entry.id}>{entry.id}</li>
            ))}
        </ul>
    );
}
