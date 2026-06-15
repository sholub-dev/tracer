import type { ReactNode } from "react";

/**
 * Shared container for the guidance notes shown in provider/integration config
 * dialogs — where to create the key and what it lets Tracer do. Keeps every note
 * visually consistent across the data-provider, AI-model, and integration cards.
 */
export function NoteBox({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs leading-relaxed rounded border border-[#d4d2cd] bg-[#f5f4f1] p-3 space-y-2">
      {children}
    </div>
  );
}

/** Link styling for the "create your key here" URLs inside a NoteBox. */
export const NOTE_LINK = "underline break-all text-[#0052cc]";
