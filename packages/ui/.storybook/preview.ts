import type { Preview } from "@storybook/react";
import "../src/index.css";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      element: "#storybook-root",
      manual: false,
    },
    backgrounds: {
      default: "surface",
      values: [
        { name: "surface", value: "#ffffff" },
        { name: "surfaceMuted", value: "#f5f5f5" },
        { name: "dark", value: "#0a0a0a" },
      ],
    },
  },
};

export default preview;
