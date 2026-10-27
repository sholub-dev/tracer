import { Check } from "lucide-react";
import { readAskUser } from "@tracer-sh/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AskState } from "../../lib/ask-card";

interface Props {
  /** The tool input, partial while it streams. */
  input: unknown;
  state: AskState;
  /** Sends the label as the person's reply; without it the buttons are disabled. */
  onPick?: (label: string) => void;
  compact?: boolean;
}

/** The agent's question with its options as buttons. */
export function AskCard({ input, state, onPick, compact = false }: Props) {
  const { question, options } = readAskUser(input);
  if (!question && options.length === 0) return null;
  const enabled = state.status === "open" && !!onPick;
  const chosen = state.status === "answered" ? state.chosen : null;
  return (
    <section aria-label="Question" className={cn("rounded-[14px] border bg-card px-5 py-4 max-sm:px-4", compact && "px-4 py-3")}>
      <p className={cn("text-[15px]/[1.5] font-medium text-foreground [overflow-wrap:anywhere]", compact && "text-sm/[1.5]")}>{question}</p>
      {options.length > 0 && (
        <div className={cn("mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap", compact && "mt-2")}>
          {options.map((option, i) => (
            <Button
              key={i}
              type="button"
              variant="outline"
              disabled={!enabled}
              aria-pressed={chosen === null ? undefined : chosen === i}
              onClick={() => onPick?.(option.label)}
              className={cn(
                "h-auto min-h-9 flex-col items-start gap-0.5 px-3 py-2 text-left whitespace-normal max-sm:w-full",
                chosen === i && "border-primary bg-primary-tint text-primary disabled:opacity-100",
              )}
            >
              <span className="flex items-center gap-1.5 [overflow-wrap:anywhere]">
                {chosen === i && <Check className="size-3.5" aria-hidden="true" />}
                {option.label}
              </span>
              {option.detail && <span className="text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{option.detail}</span>}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
