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
    <SidebarProvider className="h-svh pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]" style={{ "--sidebar-width": "17.5rem" } as CSSProperties}>
      {sidebar}
      <SidebarInset className="group/inset min-h-0 min-w-0">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function OpenSidebarButton({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarTrigger aria-label="Open sidebar" className={className} />
      </TooltipTrigger>
      <TooltipContent side="bottom">Open sidebar</TooltipContent>
    </Tooltip>
  );
}

/**
 * Opens the sidebar from a page header, where the shell bar would show it: small screens, and large ones
 * once the sidebar is collapsed. A page header marked `data-page-header` hides the shell bar, so a phone shows one header.
 */
export function PageSidebarButton() {
  const { state } = useSidebar();
  return <OpenSidebarButton className={cn("-ml-1.5 shrink-0", state === "expanded" && "lg:hidden")} />;
}

// Shown on small screens, and on large ones once the sidebar is collapsed (Ctrl/Cmd+B), so it can be reopened.
function TopBar() {
  const { state } = useSidebar();
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b bg-background/90 px-2 backdrop-blur-md group-has-[[data-page-header]]/inset:hidden",
        state === "expanded" && "lg:hidden",
      )}
    >
      <OpenSidebarButton />
      <img src="/logo.svg" alt="" className="size-4" />
      <span className="text-sm font-semibold tracking-tight">Tracer</span>
    </div>
  );
}
