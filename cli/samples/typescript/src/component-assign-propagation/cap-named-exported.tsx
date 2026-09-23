import { HeaderCell } from "./cap-header-cell";

export const Table = ({ children }: { children: React.ReactNode }) => {
    return <table>{children}</table>;
};

Table.HeaderCell = HeaderCell;
