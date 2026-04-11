import { useState } from "react";
import { theme, colors } from "../../lib/theme";
import { Spinner } from "../ui/Spinner";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { trpc } from "../../lib/trpc";

export function ApiKeyCard({ type, label }: { type: string; label: string }) {
  const utils = trpc.useUtils();
  const { data: existing, isLoading } =
    trpc.settings.getApiKey.useQuery(type);
  const saveKey = trpc.settings.saveApiKey.useMutation({
    onSuccess: () => utils.settings.getApiKey.invalidate(type),
  });
  const removeKey = trpc.settings.removeApiKey.useMutation({
    onSuccess: () => utils.settings.getApiKey.invalidate(type),
  });

  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function handleSave() {
    await saveKey.mutateAsync({ type, apiKey });
    setApiKey("");
    setEditing(false);
  }

  async function handleRemove() {
    await removeKey.mutateAsync(type);
    setEditing(false);
    setConfirmRemove(false);
  }

  if (isLoading) return <div className="px-4 py-3"><Spinner size="sm" /></div>;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium w-24 shrink-0">{label}</span>
        <span
          className={theme.maskedKey + " flex-1 truncate"}
          style={existing ? { color: colors.success } : undefined}
        >
          {existing ? existing.maskedApiKey : "Not configured"}
        </span>
        {!editing && (
          <button
            onClick={() => {
              setApiKey("");
              setEditing(true);
            }}
            className={theme.secondaryBtn + " text-xs px-3 py-1"}
          >
            {existing ? "Edit" : "Add"}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-3 pt-3 border-t border-[#e8e6e1] space-y-2">
          <input
            type={apiKey ? "password" : "text"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing?.maskedApiKey ?? "Enter API key"}
            className={theme.input}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!apiKey || saveKey.isPending}
              className={theme.primaryBtn + " text-xs px-3 py-1"}
            >
              {saveKey.isPending ? (
                <span className="flex items-center gap-2">
                  <Spinner size="sm" /> Saving...
                </span>
              ) : (
                "Save"
              )}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saveKey.isPending}
              className={theme.secondaryBtn + " text-xs px-3 py-1"}
            >
              Cancel
            </button>
            {existing && (
              <button
                onClick={() => setConfirmRemove(true)}
                disabled={removeKey.isPending}
                className={theme.dangerBtn + " text-xs px-3 py-1"}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="Remove API key"
        message={`Remove the ${label} API key?`}
        confirmLabel="Remove"
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
