import type { AppSettings, ChatMessage, ChatToolId } from "../../shared/contracts";
import { IMAGE_MODEL_ID } from "../../shared/chat-tools";
import { interactionApiVersion, usesInteractions } from "../../shared/interactions";

/** Resume only the latest successful turn from this conversation and API/model. */
export function selectInteractionHistory(messages: ChatMessage[], settings: AppSettings, tool: ChatToolId | null, project?: string | null) {
  const full = { messages, previousInteractionId: undefined as string | undefined };
  if (!usesInteractions(settings) || !settings.interactions.stateful || !settings.interactions.store) return full;
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== "assistant") index--;
  const previous = messages[index];
  const model = tool === "image" ? IMAGE_MODEL_ID : settings.models[settings.provider];
  if (!previous || previous.status !== "complete" || !previous.interaction
    || typeof previous.interaction.id !== "string" || !previous.interaction.id.trim()
    || previous.interaction.id.length > 4096 || /[\s\x00-\x1f]/.test(previous.interaction.id)
    || previous.request?.provider !== settings.provider
    || (settings.provider === "vertex" && (!project || previous.interaction.project !== project))
    || previous.interaction.model !== model
    || previous.interaction.apiVersion !== interactionApiVersion(settings)) return full;
  return { messages: messages.slice(index + 1), previousInteractionId: previous.interaction.id };
}
