import type { Storage } from "./ports.js";
import type { ModelRef } from "./types.js";

/** Seed the docs every conversation view expects. Idempotent. */
export async function seedConversation(
  storage: Storage,
  conversationId: number,
  model: ModelRef,
): Promise<void> {
  const docs = await storage.docs(conversationId);
  if (!docs["pi.agent"]) {
    await storage.putDoc(conversationId, "pi.agent", {
      model: { provider: model.provider, modelId: model.modelId },
    });
  }
  if (!docs["pi.usage"]) {
    await storage.putDoc(conversationId, "pi.usage", {
      input: 0,
      output: 0,
      totalTokens: 0,
    });
  }
  await storage.putDoc(conversationId, "pi.live", {});
}
