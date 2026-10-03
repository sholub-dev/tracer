import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { IconButton } from "../common/IconButton";

export type Attachment = { file: File; url: string | null };

const ATTACH_ACCEPT = "image/*,text/*,.md,.json,.csv,.log,application/pdf";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  canSend: boolean;
  streaming?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  attachments?: Attachment[];
  onAttach?: (files: FileList) => void;
  onRemoveAttachment?: (index: number) => void;
  sources?: ReactNode;
  cost?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  autoFocus?: boolean;
  compact?: boolean;
  className?: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  canSend,
  streaming = false,
  onStop,
  disabled = false,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  sources,
  cost,
  textareaRef,
  autoFocus,
  compact = false,
  className,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ownTextareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = textareaRef ?? ownTextareaRef;

  // WebKit sizes the field to its value only, so an empty field cuts off a placeholder that wraps.
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    const fit = () => {
      ta.style.minHeight = "";
      if (!ta.value) ta.style.minHeight = `${ta.scrollHeight}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [inputRef, value, placeholder]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className={cn(
        "rounded-xl border border-input bg-card shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25",
        className,
      )}
    >
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attachments">
          {attachments.map((a, i) => (
            <li key={`${a.file.name}-${i}`} className="group/att relative">
              {a.url ? (
                <img src={a.url} alt={a.file.name} className="size-14 rounded-md border object-cover" />
              ) : (
                <span className="flex h-14 max-w-[180px] items-center gap-1.5 rounded-md border bg-muted px-2.5 text-xs text-ink-2">
                  <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{a.file.name}</span>
                </span>
              )}
              <IconButton
                label={`Remove ${a.file.name}`}
                variant="secondary"
                size="icon-xs"
                className="absolute -top-2 -right-2 rounded-full border bg-card shadow-xs transition-opacity group-focus-within/att:opacity-100 group-hover/att:opacity-100 [@media(hover:hover)]:opacity-0"
                onClick={() => onRemoveAttachment?.(i)}
              >
                <X />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Textarea
        ref={inputRef}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label="Message"
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        onPaste={(e) => {
          if (onAttach && e.clipboardData.files?.length) {
            e.preventDefault();
            onAttach(e.clipboardData.files);
          }
        }}
        className={cn(
          "max-h-[200px] resize-none overflow-y-auto rounded-xl border-0 bg-transparent shadow-none focus-visible:ring-0 disabled:opacity-60 dark:bg-transparent",
          compact ? "min-h-10 px-3 pt-2.5 pb-1 text-sm md:text-sm" : "min-h-11 px-4 pt-3 pb-1 text-base md:text-base",
        )}
      />
      <div className={cn("flex items-center gap-1.5 pb-2", compact ? "px-1.5" : "px-2")}>
        {onAttach && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              className="hidden"
              onChange={(e) => {
                if (e.target.files) onAttach(e.target.files);
                e.target.value = "";
              }}
            />
            <IconButton label="Attach files" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
              <Paperclip />
            </IconButton>
          </>
        )}
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto no-scrollbar">{sources}</div>
        <span className="flex-1" />
        {cost}
        {streaming ? (
          <IconButton
            label="Stop (Esc)"
            variant="secondary"
            className="rounded-full bg-foreground text-background hover:bg-foreground/85 hover:text-background"
            onClick={onStop}
          >
            <Square className="size-3 fill-current" />
          </IconButton>
        ) : (
          <IconButton label="Send (Enter)" variant="default" type="submit" className="rounded-full" disabled={!canSend || disabled}>
            <ArrowUp />
          </IconButton>
        )}
      </div>
    </form>
  );
}
