import { useState, type ComponentProps, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarMenuAction } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ContentProps = ComponentProps<typeof DropdownMenuContent>;

interface MoreActionsMenuProps {
  label: string;
  children: ReactNode;
  /** A sidebar row action, revealed on hover, instead of a ghost icon button. */
  sidebar?: boolean;
  side?: ContentProps["side"];
  align?: ContentProps["align"];
  triggerClassName?: string;
  contentClassName?: string;
  /** Mounts the costly Radix menu on first use, already open; for long lists of rows. */
  lazy?: boolean;
}

export function MoreActionsMenu({ label, children, sidebar = false, side, align = "end", triggerClassName, contentClassName = "w-48", lazy = false }: MoreActionsMenuProps) {
  const [mounted, setMounted] = useState(!lazy);

  const trigger = (mountProps?: { onClick: () => void; "aria-haspopup": "menu" }) => sidebar ? (
    <SidebarMenuAction showOnHover aria-label={label} className={cn("[@media(hover:none)]:opacity-100", triggerClassName)} {...mountProps}>
      <MoreHorizontal />
    </SidebarMenuAction>
  ) : (
    <Button variant="ghost" size="icon-sm" aria-label={label} className={triggerClassName} {...mountProps}>
      <MoreHorizontal />
    </Button>
  );

  if (!mounted) return trigger({ onClick: () => setMounted(true), "aria-haspopup": "menu" });

  return (
    <DropdownMenu defaultOpen={lazy}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side={side} align={align} className={contentClassName}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
