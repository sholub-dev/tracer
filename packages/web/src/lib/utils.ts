import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** What a select button shows: the chosen option, else the saved value itself, else the placeholder. */
export function selectedLabel(options: { value: string; label: string; displayLabel?: string }[], value: string, placeholder: string): string {
  const selected = options.find((o) => o.value === value);
  return selected ? (selected.displayLabel ?? selected.label) : value || placeholder;
}

/** Wraps an async function so a call made while one is running joins it instead of starting another. */
export function singleFlight<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let running: Promise<void> | null = null;
  return (...args) => (running ??= fn(...args).finally(() => { running = null; }));
}
