import type { ChatStreamErrorData, ChatStreamRequest } from "../../shared/contracts";
import { streamChat } from "./api";

type Handlers = Parameters<typeof streamChat>[1];

/** Load local files only after a confirmed rejection, and retry at most once. */
export async function streamChatWithRecovery(
  request: ChatStreamRequest,
  handlers: Handlers,
  signal: AbortSignal,
  recovery: {
    rebuildMessages(): Promise<ChatStreamRequest["messages"]>;
    onRecover(error: ChatStreamErrorData): void;
    onRebuilt(request: ChatStreamRequest): void;
  },
): Promise<void> {
  let rejected: ChatStreamErrorData | undefined;
  let generationStarted = false;
  try {
    await streamChat(request, {
      ...handlers,
      onDelta(text) { generationStarted = true; handlers.onDelta(text); },
      onImage(image) { generationStarted = true; return handlers.onImage?.(image); },
      onThinking(text) { generationStarted = true; handlers.onThinking?.(text); },
      onGrounding(data) { generationStarted = true; handlers.onGrounding?.(data); },
      onTool(tool) { generationStarted = true; return handlers.onTool?.(tool); },
      onError(error) {
        if (!generationStarted && request.previousInteractionId && request.interactions?.stateful
          && request.interactions.store && error.code === "interaction_reference_invalid"
          && [400, 404, 410].includes(error.status ?? 0)) rejected = error;
        else handlers.onError?.(error);
      },
    }, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!rejected) throw error;
    recovery.onRecover(rejected);
    let messages: ChatStreamRequest["messages"];
    try { messages = await recovery.rebuildMessages(); }
    catch (reason) {
      signal.throwIfAborted();
      throw new Error(`Could not restore the conversation from local history: ${reason instanceof Error ? reason.message : String(reason)} Start a new chat and reattach any required files; no history was silently omitted.`);
    }
    signal.throwIfAborted();
    const rebuilt = { ...request, previousInteractionId: undefined, messages };
    recovery.onRebuilt(rebuilt);
    // Direct call, deliberately not recursive: a failed rebuild is shown to the user.
    await streamChat(rebuilt, handlers, signal);
  }
}
