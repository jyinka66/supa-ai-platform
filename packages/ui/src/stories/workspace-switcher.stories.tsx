import type { Meta, StoryObj } from "@storybook/react";
import { WorkspaceSwitcher } from "../workspace-switcher";

const meta: Meta<typeof WorkspaceSwitcher> = {
  title: "Navigation/WorkspaceSwitcher",
  component: WorkspaceSwitcher,
  tags: ["autodocs"],
  args: {
    basePath: "/en",
    activeId: "ws-1",
  },
};

export default meta;
type Story = StoryObj<typeof WorkspaceSwitcher>;

export const Default: Story = {
  args: {
    workspaces: [
      {
        id: "ws-1",
        slug: "acme",
        name: "Acme Inc.",
        logo_path: null,
        is_personal: false,
        plan: "pro",
        workspace_members: [{ role: "owner" }],
      },
      {
        id: "ws-2",
        slug: "personal",
        name: "Personal",
        logo_path: null,
        is_personal: true,
        plan: "free",
        workspace_members: [{ role: "owner" }],
      },
      {
        id: "ws-3",
        slug: "contracting",
        name: "Contracting Co.",
        logo_path: null,
        is_personal: false,
        plan: "free",
        workspace_members: [{ role: "member" }],
      },
    ],
  },
};

export const Empty: Story = {
  args: {
    workspaces: [],
    activeId: null,
  },
};
