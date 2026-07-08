import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

export function Card({ className, interactive, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card shadow-xs transition-all duration-200 ease-smooth",
        interactive && "hover:border-muted-foreground/25 hover:shadow-panel hover:-translate-y-0.5",
        className,
      )}
      {...props}
    />
  );
}
