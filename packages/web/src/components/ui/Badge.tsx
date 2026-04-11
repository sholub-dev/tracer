import { theme } from "../../lib/theme";

interface BadgeProps {
  variant: "error" | "warn" | "info" | "success" | "default";
  children: React.ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span className={`${theme.badge} ${theme.badgeVariants[variant]}`}>
      {children}
    </span>
  );
}
