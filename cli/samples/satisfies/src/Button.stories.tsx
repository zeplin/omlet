import type { Meta, StoryObj } from "@storybook/react";

import { AsConst } from "./AsConst";

const meta = {
    title: "AsConst",
    component: AsConst
} satisfies Meta<typeof AsConst>;

export default meta;

export const Primary = {
    args: {}
} satisfies StoryObj<typeof meta>;
