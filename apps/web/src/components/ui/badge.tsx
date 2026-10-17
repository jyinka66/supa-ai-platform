"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-sm py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent/10 text-accent",
        success: "border-transparent bg-success/10 text-success",
        warning: "border-transparent bg-warning/10 text-warning",
        danger: "border-transparent bg-danger/10 text-danger",
        outline: "text-text",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className = "", variant, ...props }: BadgeProps) {
  return <div className={`${badgeVariants({ variant })} ${className}`} {...props} />;
}

export { badgeVariants };

// Status badge — maps a BuildSession status to the right color.
export function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "deployed" || status === "published" || status === "monitoring" ? "success" :
    status === "failed" || status === "archived" ? "danger" :
    status === "paused" ? "warning" :
    "default";
  return <Badge variant={variant as "default" | "success" | "warning" | "danger"}>{status}</Badge>;
}
