import { theme } from "../../lib/theme";

interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  centered?: boolean;
}

const sizeClasses = {
  sm: "h-4 w-4",
  md: "h-8 w-8",
  lg: "h-12 w-12",
};

export function Spinner({ size = "md", centered = false }: SpinnerProps) {
  const spinner = (
    <div
      className={`${sizeClasses[size]} animate-spin rounded-full border-2 ${theme.spinner}`}
    />
  );

  if (centered) {
    return (
      <div className="flex items-center justify-center py-12">{spinner}</div>
    );
  }

  return spinner;
}
