import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: () => void;
  disabled?: boolean;
  label: string;
  /** "danger" for switches that turn on something genuinely risky (e.g. Advanced tools) — red instead of the default brand color, so it visually stands apart from routine on/off toggles. */
  tone?: "primary" | "danger";
}

export function Switch({ checked, onCheckedChange, disabled, label, tone = "primary" }: SwitchProps) {
  return (
    <button
      onClick={onCheckedChange}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors duration-150 disabled:opacity-40",
        checked ? (tone === "danger" ? "bg-risk-high" : "bg-primary") : "bg-surface border border-border",
      )}
    >
      <span className={cn("absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-150", checked && "translate-x-4")} />
    </button>
  );
}
