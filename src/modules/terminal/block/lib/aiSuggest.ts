import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { isCompatModelId } from "@/modules/ai/config";

export function safeSuggestionPrefix(line: string): boolean {
  return line.trim().length >= 3 && line.length <= 2000 &&
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(line) &&
    !/(?:password|passwd|token|api[_-]?key|secret)\s*[:=]|authorization\s*:|--(?:password|token|api-key)\b/i.test(line);
}

export async function suggestCommand(
  line: string,
  cwd: string | null,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<string | null> {
  const prefs = usePreferencesStore.getState();
  const chat = useChatStore.getState();
  const current = () => {
    const nextPrefs = usePreferencesStore.getState();
    const nextChat = useChatStore.getState();
    return !signal?.aborted && isCurrent() && nextPrefs.terminalSuggestions &&
      !nextChat.live.isActiveTerminalPrivate() &&
      chat.selectedModelId === nextChat.selectedModelId &&
      prefs.customEndpoints === nextPrefs.customEndpoints &&
      chat.customEndpointKeys === nextChat.customEndpointKeys;
  };
  if (!current() || !safeSuggestionPrefix(line) || !isCompatModelId(chat.selectedModelId)) return null;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 280);
    signal?.addEventListener("abort", finish, { once: true });
  });
  if (!current()) return null;
  const [{ buildConfiguredLanguageModel }, { generateText }] = await Promise.all([
    import("@/modules/ai/lib/agent"), import("ai"),
  ]);
  if (!current()) return null;
  const model = await buildConfiguredLanguageModel(chat.selectedModelId, chat.apiKeys, {
    customEndpoints: prefs.customEndpoints,
    customEndpointKeys: chat.customEndpointKeys,
  });
  if (!current()) return null;
  const { text } = await generateText({
    model,
    system: "Complete the user's shell command. Return exactly one complete single-line command starting with the supplied prefix, without Markdown or explanations. Never execute commands. Prefer the smallest useful completion.",
    prompt: `Directory: ${cwd ?? "unknown"}\nPrefix: ${line}`,
    maxOutputTokens: 128,
    maxRetries: 0,
    abortSignal: signal,
  });
  if (!current()) return null;
  const result = text.trim();
  return result.startsWith(line) && result.length > line.length && result.length <= 2000 &&
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(result) ? result : null;
}
