import { useState } from "react";
import { theme } from "../../lib/theme";

export function EditMessageForm({ initialText, onSave, onCancel }: {
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  return (
    <>
      <textarea
        className={theme.chatEditTextarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSave(text); }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.max(2, text.split("\n").length)}
        autoFocus
      />
      <div className={theme.chatEditActions}>
        <button type="button" onClick={() => onSave(text)} className={theme.chatEditSave} disabled={!text.trim()}>
          Save & Send
        </button>
        <button type="button" onClick={onCancel} className={theme.chatEditCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}
