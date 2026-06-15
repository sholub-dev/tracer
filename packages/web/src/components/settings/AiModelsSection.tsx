import { useState } from "react";
import { ApiKeyCard } from "./ApiKeyCard";
import { VertexConfigCard } from "./VertexConfigCard";
import { PricingTable } from "./PricingTable";
import { useConfiguredProviders } from "../../lib/hooks";
import { NoteBox, NOTE_LINK } from "./NoteBox";

const GOOGLE_AI_NOTE = (
  <NoteBox>
    <div>
      Create a Gemini API key at:
      <br />
      <a
        href="https://aistudio.google.com/api-keys"
        target="_blank"
        rel="noopener noreferrer"
        className={NOTE_LINK}
      >
        https://aistudio.google.com/api-keys
      </a>
    </div>
    <div className="opacity-80">
      This key powers the Gemini models Tracer uses to run chats and analyze your data — it is the
      model provider, not a data source. Tracer sends your prompts and the data it has already
      fetched to Google's Gemini API for inference; it grants no access back into your Google
      account.
    </div>
  </NoteBox>
);

export function AiModelsSection() {
  const [pricingOpen, setPricingOpen] = useState(false);
  const configuredProviders = useConfiguredProviders();

  return (
    <div className="space-y-3">
      <div className="max-w-lg bg-white border border-[#d4d2cd] rounded divide-y divide-[#e8e6e1] overflow-hidden">
        <ApiKeyCard type="anthropic" label="Anthropic" />
        <ApiKeyCard type="google" label="Google AI" note={GOOGLE_AI_NOTE} />
        <VertexConfigCard />
      </div>

      <div className="bg-white border border-[#d4d2cd] rounded overflow-hidden">
        <button
          onClick={() => setPricingOpen(!pricingOpen)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm text-[#666666] hover:bg-[#f5f4f0] transition-colors font-sans"
        >
          <span className="font-medium">Model Pricing</span>
          <span
            className="text-xs transition-transform duration-200"
            style={{ transform: pricingOpen ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            ▾
          </span>
        </button>
        {pricingOpen && <PricingTable configuredProviders={configuredProviders} />}
      </div>
    </div>
  );
}
