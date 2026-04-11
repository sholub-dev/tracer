import { theme } from "../../lib/theme";
import { Spinner } from "../ui/Spinner";
import { Modal } from "../ui/Modal";

interface ConfigField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
}

interface ProviderConfigModalProps {
  open: boolean;
  label: string;
  configFields: ConfigField[];
  formValues: Record<string, string>;
  onFormChange: (key: string, value: string) => void;
  existingConfig: Record<string, string> | null;
  saveResult: { success: boolean; error?: string } | null;
  savePending: boolean;
  configured: boolean;
  onSave: () => void;
  onClose: () => void;
  onRemove: () => void;
  /** Available modes for this provider (e.g. ["api", "mcp"]). */
  modes?: Array<"api" | "mcp">;
  /** Currently selected mode. */
  selectedMode?: "api" | "mcp";
  /** Called when the user switches mode. */
  onModeChange?: (mode: "api" | "mcp") => void;
}

/** Returns true if the value is still the server-masked placeholder (not user-entered). */
function isMaskedValue(value: string | undefined, existingValue: string | undefined): boolean {
  return !!value && !!existingValue && value === existingValue;
}

export function ProviderConfigModal({
  open,
  label,
  configFields,
  formValues,
  onFormChange,
  existingConfig,
  saveResult,
  savePending,
  configured,
  onSave,
  onClose,
  onRemove,
  modes,
  selectedMode,
  onModeChange,
}: ProviderConfigModalProps) {
  const showModeToggle = modes && modes.length > 1;

  const hasUnchangedPasswords = configFields.some(
    (f) =>
      f.required !== false &&
      f.type === "password" &&
      isMaskedValue(formValues[f.key], existingConfig?.[f.key]),
  );

  const hasEmptyRequired = configFields.some(
    (f) => f.required !== false && !formValues[f.key],
  );

  return (
    <Modal open={open} onClose={onClose}>
      <div className={theme.dialogTitle + " text-base mb-4"}>Configure {label}</div>

      {showModeToggle && (
        <div className="flex gap-1 mb-4 p-0.5 bg-[#e8e6e1] rounded">
          {modes.map((mode) => (
            <button
              key={mode}
              onClick={() => onModeChange?.(mode)}
              className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
                selectedMode === mode
                  ? "bg-white text-[#1a1a1a] shadow-sm font-medium"
                  : "text-[#666666] hover:text-[#1a1a1a]"
              }`}
            >
              {mode === "api" ? "API" : "MCP"}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {configFields.map((field) => {
          const masked = field.type === "password" &&
            isMaskedValue(formValues[field.key], existingConfig?.[field.key]);

          return (
            <div key={field.key}>
              <label className={theme.sectionTitle}>
                {field.label}
                {field.required === false && (
                  <span className="text-xs opacity-40 ml-1">(optional)</span>
                )}
              </label>
              <input
                type={field.type === "password" && formValues[field.key] && !masked ? "password" : "text"}
                value={formValues[field.key] ?? ""}
                onChange={(e) => onFormChange(field.key, e.target.value)}
                onFocus={(e) => { if (masked) e.target.select(); }}
                placeholder={`Enter ${field.label.toLowerCase()}`}
                className={`${theme.input} ${masked ? "!text-[#999] !border-l-2 !border-l-amber-400" : ""}`}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 mt-4 pt-4 border-t border-[#d4d2cd]">
        <button
          onClick={onSave}
          disabled={hasEmptyRequired || hasUnchangedPasswords || savePending}
          className={theme.primaryBtn}
        >
          {savePending ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" /> Saving...
            </span>
          ) : (
            "Save & Test"
          )}
        </button>
        <button
          onClick={onClose}
          disabled={savePending}
          className={theme.secondaryBtn}
        >
          Cancel
        </button>
        {configured && (
          <button
            onClick={onRemove}
            disabled={savePending}
            className={theme.dangerBtn}
          >
            Remove
          </button>
        )}
      </div>

      {hasUnchangedPasswords && !savePending && !saveResult && (
        <p className="mt-2 text-xs text-amber-600">
          Re-enter highlighted fields to save
        </p>
      )}

      {saveResult && (
        <div className={`mt-3 ${saveResult.success ? theme.successText : theme.errorText}`}>
          {saveResult.success
            ? "Connected successfully"
            : saveResult.error || "Connection failed"}
        </div>
      )}
    </Modal>
  );
}
