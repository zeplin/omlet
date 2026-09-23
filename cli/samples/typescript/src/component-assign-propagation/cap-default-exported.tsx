import { Cell } from "./cap-cell";

const Table = ({ children }: { children: React.ReactNode }) => {
    return <table>{children}</table>;
};

Table.Cell = Cell;

export default Table;
