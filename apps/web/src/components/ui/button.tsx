"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent text-white hover:bg-accentHover",
        destructive: "bg-danger text-white hover:bg-danger/90",
        outline: "border border-border bg-surface hover:bg-surfaceMuted",
        secondary: "bg-surfaceMuted text-text hover:bg-surfaceMuted/80",
        ghost: "hover:bg-surfaceMuted",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-md py-2",
        sm: "h-8 px-sm text-xs",
        lg: "h-12 px-lg text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={`${buttonVariants({ variant, size })} ${className}`} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
