import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Props = ComponentProps<typeof Button> & { label: string; side?: ComponentProps<typeof TooltipContent>["side"] };

export function IconButton({ label, side, variant = "ghost", size = "icon-sm", ...props }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} variant={variant} size={size} {...props} />
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
