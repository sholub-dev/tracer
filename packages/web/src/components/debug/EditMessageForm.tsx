import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function EditMessageForm({ initialText, onSave, onCancel }: {
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  return (
    <div className="ml-auto w-full max-w-[85%] space-y-2 sm:max-w-[75%]">
      <Textarea
        aria-label="Edit message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSave(text);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        autoFocus
        className="max-h-[50svh] min-h-20 rounded-xl bg-card text-base md:text-base"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={() => onSave(text)} disabled={!text.trim()}>Save and send</Button>
      </div>
    </div>
  );
}
