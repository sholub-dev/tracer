import { useState } from "react";
import { History, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { trpc } from "../../lib/trpc";
import { formatTime } from "../../lib/monitor-utils";
import { MonitorChatPanel } from "./MonitorChatPanel";

type BuilderChat = { id: string; title: string; status: string; updatedAt: number };

interface BuilderSheetProps {
  sessionId: string | undefined;
  editingName?: string;
  initialInput?: string;
  onOpenChat: (sessionId: string) => void;
  onClose: () => void;
}

export function BuilderSheet({ sessionId, editingName, initialInput, onOpenChat, onClose }: BuilderSheetProps) {
  const chats = trpc.monitors.builderChats.useQuery().data ?? [];
  const current = chats.find((c) => c.id === sessionId);
  const title = editingName ? `Edit ${editingName}` : current?.title || "New monitor";

  return (
    <Sheet open={!!sessionId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const content = e.currentTarget as HTMLElement;
          (content.querySelector("textarea") ?? content).focus();
        }}
      >
        <SheetHeader className="flex-row items-center gap-2 border-b px-5 py-3">
          <SheetTitle className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</SheetTitle>
          <SheetDescription className="sr-only">Describe what to watch and the agent writes and tests the query.</SheetDescription>
          <BuilderChats chats={chats} currentId={sessionId} onOpen={onOpenChat} onDeletedCurrent={onClose} />
          <Tooltip>
            <TooltipTrigger asChild>
              <SheetClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <X />
                </Button>
              </SheetClose>
            </TooltipTrigger>
            <TooltipContent side="left">Close</TooltipContent>
          </Tooltip>
        </SheetHeader>
        {sessionId && <MonitorChatPanel key={sessionId} sessionId={sessionId} initialInput={initialInput} />}
      </SheetContent>
    </Sheet>
  );
}

interface BuilderChatsProps {
  chats: BuilderChat[];
  currentId: string | undefined;
  onOpen: (sessionId: string) => void;
  onDeletedCurrent: () => void;
}

function BuilderChats({ chats, currentId, onOpen, onDeletedCurrent }: BuilderChatsProps) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<BuilderChat | null>(null);
  const utils = trpc.useUtils();
  const remove = trpc.sessions.delete.useMutation({
    onSuccess: (_, { id }) => {
      utils.monitors.builderChats.invalidate();
      utils.sessions.list.invalidate();
      if (id === currentId) onDeletedCurrent();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2">
            <History className="size-4" aria-hidden="true" />
            Builder chats
            {chats.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{chats.length}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 gap-0 p-1">
          {chats.length === 0 ? (
            <p className="px-2 py-3 text-[13px] text-muted-foreground">No builder chats yet.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {chats.map((c) => (
                <li key={c.id} className="group/chat relative flex items-center rounded-md hover:bg-muted focus-within:bg-muted">
                  <button
                    type="button"
                    aria-current={c.id === currentId ? "true" : undefined}
                    onClick={() => { setOpen(false); onOpen(c.id); }}
                    className="flex min-w-0 flex-1 flex-col items-start rounded-md py-1.5 pr-9 pl-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className={cn("w-full truncate text-[13px]", c.id === currentId && "font-semibold", c.status === "done" && "text-primary")}>
                      {c.title || "Untitled chat"}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">{formatTime(c.updatedAt)}</span>
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${c.title || "chat"}`}
                        onClick={() => setDeleting(c)}
                        className="absolute right-1.5 text-muted-foreground opacity-0 group-focus-within/chat:opacity-100 group-hover/chat:opacity-100 hover:text-destructive [@media(hover:none)]:opacity-100"
                      >
                        <Trash2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">Delete chat</TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this builder chat?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleting?.title || "Untitled chat"}" is removed. Monitors it created stay. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove.mutate({ id: deleting.id })}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
