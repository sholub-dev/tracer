import type { CSSProperties, ReactNode } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ShellProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function Shell({ sidebar, children }: ShellProps) {
  return (
    <SidebarProvider className="h-svh" style={{ "--sidebar-width": "17.5rem" } as CSSProperties}>
      {sidebar}
      <SidebarInset className="min-h-0 min-w-0">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

// Shown on small screens, and on large ones once the sidebar is collapsed (Ctrl/Cmd+B), so it can be reopened.
function TopBar() {
  const { state } = useSidebar();
  return (
    <div className={cn("flex h-12 shrink-0 items-center gap-2 border-b bg-background/90 px-2 backdrop-blur-md", state === "expanded" && "lg:hidden")}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarTrigger aria-label="Open sidebar" />
        </TooltipTrigger>
        <TooltipContent side="bottom">Open sidebar</TooltipContent>
      </Tooltip>
      <img src="/logo.svg" alt="" className="size-4" />
      <span className="text-sm font-semibold tracking-tight">Tracer</span>
    </div>
  );
}
