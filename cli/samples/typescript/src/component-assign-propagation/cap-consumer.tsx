import Table from "./cap-default-exported";
import { Table as NamedTable } from "./cap-named-exported";

export function App() {
    return (
        <div>
            <Table.Cell />
            <NamedTable.HeaderCell />
        </div>
    );
}
