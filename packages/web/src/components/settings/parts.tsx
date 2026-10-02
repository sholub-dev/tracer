import { useId, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { ProviderDot } from "../common/ProviderDot";

export function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby="settings-title" className="animate-in fade-in duration-200">
      <h2 id="settings-title" className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6 space-y-7">{children}</div>
    </section>
  );
}

export function Group({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div>
      {title && <h3 className="mb-2 px-1 text-[13px]/[18px] font-medium text-ink-2">{title}</h3>}
      <div className={cn("divide-y overflow-hidden rounded-lg border bg-card", className)}>{children}</div>
    </div>
  );
}

type RowProps = { label: ReactNode; description?: ReactNode; control?: ReactNode; htmlFor?: string; className?: string };

export function Row({ label, description, control, htmlFor, className }: RowProps) {
  return (
    <div className={cn("flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3", className)}>
      <div className="min-w-0 flex-1 basis-56">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </Label>
        ) : (
          <div className="text-sm font-medium">{label}</div>
        )}
        {description && <div className="mt-0.5 text-[13px]/[18px] text-muted-foreground">{description}</div>}
      </div>
      {control}
    </div>
  );
}

type Tone = "ok" | "warn" | "off";

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-[13px]/[18px] whitespace-nowrap",
        tone === "ok" ? "text-ink-2" : tone === "warn" ? "text-warning" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warning" : "border border-muted-foreground",
        )}
      />
      {children}
    </span>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="space-y-2 rounded-md bg-muted/60 px-3 py-2.5 text-[13px]/[18px] text-ink-2">{children}</div>;
}

export function NoteLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-primary underline underline-offset-2 hover:text-primary-hover"
    >
      {children ?? href}
    </a>
  );
}

type ConfirmProps = {
  title: string;
  description: string;
  action: string;
  onConfirm: () => void;
  disabled?: boolean;
  trigger: string;
  triggerLabel?: string;
  size?: "xs" | "sm";
};

export function ConfirmButton({ title, description, action, onConfirm, disabled, trigger, triggerLabel, size = "sm" }: ConfirmProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={size}
          disabled={disabled}
          aria-label={triggerLabel}
          className="text-destructive hover:bg-destructive-tint hover:text-destructive"
        >
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type ConfigField = { key: string; label: string; type: string; required?: boolean; placeholder?: string };
type SaveResult = { success: boolean; error?: string };

type RemoveSpec = { label: string; title: string; description: string; onConfirm: () => Promise<unknown> };

type ConnectionProps = {
  name: string;
  provider?: string;
  detail?: ReactNode;
  tone: Tone;
  status: string;
  /** Shown under the detail line, e.g. a failed ping. */
  warning?: string;
  fields?: ConfigField[];
  existingConfig?: Record<string, string> | null;
  note?: ReactNode;
  saveLabel?: string;
  successText?: string;
  onSave?: (values: Record<string, string>) => Promise<SaveResult>;
  /** For sources with no fields: Connect saves straight away instead of opening the form. */
  onConnect?: () => Promise<SaveResult>;
  connected: boolean;
  remove?: RemoveSpec;
  pending?: boolean;
  /** Extra controls inside the open panel (project pickers, auth hints). */
  extra?: ReactNode;
  children?: ReactNode;
};

const isMasked = (value: string | undefined, existing: string | undefined) => !!value && !!existing && value === existing;

export function ConnectionRow({
  name,
  provider,
  detail,
  tone,
  status,
  warning,
  fields = [],
  existingConfig,
  note,
  saveLabel = "Save and test",
  successText = "Connected successfully",
  onSave,
  onConnect,
  connected,
  remove,
  pending,
  extra,
  children,
}: ConnectionProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SaveResult | null>(null);
  const [saving, setSaving] = useState(false);

  const openForm = () => {
    setValues(Object.fromEntries(fields.map((f) => [f.key, existingConfig?.[f.key] ?? ""])));
    setResult(null);
    setOpen(true);
  };

  const report = (r: SaveResult) => {
    setResult(r);
    if (r.success) toast.success(`${name}: ${successText}`);
    else toast.error(`${name}: ${r.error || "Connection failed"}`);
  };

  const run = async (fn: () => Promise<SaveResult>, closeOnSuccess: boolean) => {
    setSaving(true);
    setResult(null);
    try {
      const r = await fn();
      report(r);
      if (r.success && closeOnSuccess) setOpen(false);
    } catch {
      report({ success: false, error: "Failed to save configuration" });
    } finally {
      setSaving(false);
    }
  };

  const maskedKeys = fields.filter(
    (f) => f.required !== false && f.type === "password" && isMasked(values[f.key], existingConfig?.[f.key]),
  );
  const emptyRequired = fields.some((f) => f.required !== false && !values[f.key]);
  const busy = saving || !!pending;
  const showForm = fields.length > 0 && !!onSave;

  const inlineResult = result && (
    <p role="status" className={cn("text-[13px]/[18px]", result.success ? "text-success" : "text-destructive")}>
      {result.success ? successText : result.error || "Connection failed"}
    </p>
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Row
        label={
          <span className="flex items-center gap-2">
            {provider && <ProviderDot provider={provider} />}
            {name}
          </span>
        }
        description={
          (detail || warning || (!open && result)) && (
            <>
              {detail}
              {warning && <span className="mt-0.5 block text-warning">{warning}</span>}
              {!open && inlineResult && <span className="mt-0.5 block">{inlineResult}</span>}
            </>
          )
        }
        control={
          <div className="flex items-center gap-4">
            <Status tone={tone}>{status}</Status>
            {!open &&
              (connected || !onConnect ? (
                <Button
                  variant={connected ? "outline" : "default"}
                  size="sm"
                  onClick={openForm}
                  aria-label={`${connected ? "Manage" : "Connect"} ${name}`}
                >
                  {connected ? "Manage" : "Connect"}
                </Button>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => run(onConnect, false)} aria-label={`Connect ${name}`}>
                  {saving && <Loader2 className="animate-spin" />}
                  {saving ? "Connecting" : "Connect"}
                </Button>
              ))}
          </div>
        }
      />
      <CollapsibleContent>
        <form
          className="space-y-4 border-t bg-background/60 px-4 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (onSave) run(() => onSave(values), true);
          }}
        >
          {note}
          {showForm && (
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((f, i) => {
                const masked = f.type === "password" && isMasked(values[f.key], existingConfig?.[f.key]);
                return (
                  <div key={f.key} className={cn("space-y-1.5", fields.length === 1 && "sm:col-span-2")}>
                    <Label htmlFor={`${id}-${f.key}`} className="text-[13px]/[18px]">
                      {f.label}
                      {f.required === false && <span className="font-normal text-muted-foreground">(optional)</span>}
                    </Label>
                    <Input
                      id={`${id}-${f.key}`}
                      type={f.type === "password" && values[f.key] && !masked ? "password" : "text"}
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      onFocus={(e) => masked && e.target.select()}
                      placeholder={f.placeholder ?? `Enter ${f.label.toLowerCase()}`}
                      autoComplete="off"
                      aria-invalid={masked || undefined}
                      className={cn(
                        "bg-card",
                        f.type === "password" && values[f.key] && "font-mono text-[13px]",
                        masked && "border-warning bg-warning-tint text-muted-foreground aria-invalid:border-warning aria-invalid:ring-0",
                      )}
                      autoFocus={i === 0}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {extra}
          {showForm && maskedKeys.length > 0 && !saving && !result && (
            <p className="text-[13px]/[18px] text-warning">Re-enter highlighted fields to save</p>
          )}
          {inlineResult}
          <div className="flex flex-wrap items-center gap-2">
            {showForm && (
              <Button type="submit" size="sm" disabled={busy || emptyRequired || maskedKeys.length > 0}>
                {saving && <Loader2 className="animate-spin" />}
                {saving ? "Testing" : saveLabel}
              </Button>
            )}
            <Button type="button" variant={showForm ? "ghost" : "outline"} size="sm" disabled={saving} onClick={() => setOpen(false)}>
              {showForm ? "Cancel" : "Done"}
            </Button>
            {connected && remove && (
              <span className="ml-auto">
                <ConfirmButton
                  trigger={remove.label}
                  title={remove.title}
                  description={remove.description}
                  action={remove.label}
                  disabled={busy}
                  onConfirm={async () => {
                    await remove.onConfirm();
                    setOpen(false);
                    setResult(null);
                    toast(`${name} ${remove.label === "Remove" ? "removed" : "disconnected"}`);
                  }}
                />
              </span>
            )}
          </div>
        </form>
      </CollapsibleContent>
      {children}
    </Collapsible>
  );
}
