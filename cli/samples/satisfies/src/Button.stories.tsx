import type { Meta, StoryObj } from "@storybook/react";

import { Ok } from "./Ok";

const meta = {
    title: "Ok",
    component: Ok
} satisfies Meta<typeof Ok>;

export default meta;

export const Primary = {
    args: {}
} satisfies StoryObj<typeof meta>;
