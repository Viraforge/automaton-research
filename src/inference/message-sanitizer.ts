import type { ChatMessage } from "../types.js";

/**
 * Sanitize messages to prevent API rejections (MiniMax error 1214, etc.).
 * - Drops orphaned tool messages whose tool_call_id doesn't match any preceding assistant tool_calls.
 * - Coalesces consecutive system messages.
 * - Strips empty messages.
 */
export function sanitizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const seenToolCallIds = new Set<string>();
  let activeToolCallIds = new Set<string>();
  let toolCallCounter = 0;
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const content = normalizeContent(msg.content);
      if (!content) continue;
      const previous = result[result.length - 1];
      if (previous?.role === "system") {
        result[result.length - 1] = {
          ...previous,
          content: `${normalizeContent(previous.content)}\n\n${content}`,
        };
      } else {
        result.push({ ...msg, content });
      }
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        activeToolCallIds = new Set<string>();
        const rewrittenToolCalls = msg.tool_calls.map((tc) => {
          const rawId = typeof tc.id === "string" && tc.id.trim().length > 0
            ? tc.id.trim()
            : `auto_tool_call_${toolCallCounter++}`;
          let normalizedId = rawId;
          while (seenToolCallIds.has(normalizedId)) {
            normalizedId = `${rawId}_${toolCallCounter++}`;
          }
          seenToolCallIds.add(normalizedId);
          activeToolCallIds.add(normalizedId);
          return {
            ...tc,
            id: normalizedId,
          };
        });
        result.push({
          ...msg,
          content: normalizeContent(msg.content),
          tool_calls: rewrittenToolCalls,
        });
        continue;
      }

      const content = normalizeContent(msg.content);
      if (!content) continue;
      result.push({ ...msg, content });
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id.trim() : "";
      if (!toolCallId || !activeToolCallIds.has(toolCallId) || !seenToolCallIds.has(toolCallId)) continue;
      activeToolCallIds.delete(toolCallId);
      result.push({
        ...msg,
        tool_call_id: toolCallId,
        content: normalizeContent(msg.content),
      });
      continue;
    }

    const content = normalizeContent(msg.content);
    if (!content) continue;
    result.push({ ...msg, content });
  }

  while (result[0]?.role === "tool") result.shift();
  return enforceAssistantToolPairing(result);
}

export function ensureNonEmptyChatMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length > 0) {
    return messages;
  }
  return [{ role: "user", content: "Continue." }];
}

function normalizeContent(content: unknown): string {
  return typeof content === "string" ? content : String(content ?? "");
}

function enforceAssistantToolPairing(messages: ChatMessage[]): ChatMessage[] {
  const paired: ChatMessage[] = [];

  for (let i = 0; i < messages.length;) {
    const current = messages[i];
    if (current?.role !== "assistant" || !Array.isArray(current.tool_calls) || current.tool_calls.length === 0) {
      if (current?.role !== "tool") paired.push(current);
      i++;
      continue;
    }

    const expectedIds = new Set(
      current.tool_calls
        .map((tc) => (typeof tc.id === "string" ? tc.id.trim() : ""))
        .filter((id) => id.length > 0),
    );
    if (expectedIds.size === 0) {
      i++;
      continue;
    }

    const matchedToolMessages: ChatMessage[] = [];
    const seenInBlock = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === "tool") {
      const candidate = messages[j];
      const candidateId = typeof candidate.tool_call_id === "string" ? candidate.tool_call_id.trim() : "";
      if (expectedIds.has(candidateId) && !seenInBlock.has(candidateId)) {
        seenInBlock.add(candidateId);
        matchedToolMessages.push(candidate);
      }
      j++;
    }

    // Keep assistant tool-call turns only when every declared tool call has a matching tool result.
    if (seenInBlock.size === expectedIds.size) {
      paired.push(current, ...matchedToolMessages);
    }
    i = j;
  }

  return paired;
}
