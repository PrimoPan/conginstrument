export const SUPPORTED_CONVERSATION_MODELS = ["gpt-5.2", "gpt-4o"] as const;

export type ConversationModel = (typeof SUPPORTED_CONVERSATION_MODELS)[number];

const MODEL_ALIASES: Record<string, ConversationModel> = {
  "5.2": "gpt-5.2",
  "gpt-5.2": "gpt-5.2",
  "4-o": "gpt-4o",
  "4o": "gpt-4o",
  "gpt-4o": "gpt-4o",
};

export function normalizeConversationModel(
  input: unknown,
  fallback: ConversationModel = "gpt-5.2"
): ConversationModel {
  const raw = String(input || "")
    .trim()
    .toLowerCase();
  return MODEL_ALIASES[raw] || fallback;
}
