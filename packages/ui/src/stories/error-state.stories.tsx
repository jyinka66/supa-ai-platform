import type { Meta, StoryObj } from "@storybook/react";
import { ErrorState } from "../error-state";

const meta: Meta<typeof ErrorState> = {
  title: "Feedback/ErrorState",
  component: ErrorState,
  tags: ["autodocs"],
  args: {
    title: "Something went wrong",
    description: "An unexpected error occurred. Please try again.",
  },
};

export default meta;
type Story = StoryObj<typeof ErrorState>;

export const Default: Story = {};

export const WithoutRetry: Story = {
  args: { onRetry: undefined },
};

export const WithCustomCopy: Story = {
  args: {
    title: "Database unreachable",
    description: "We couldn't reach the Supabase cluster. Check your VPN or try again in a moment.",
  },
};
