// OpenRouter SSE / 流式封装

export async function askAIStream(env, messages, thinkState, onText) {
  const body = {
    model: "deepseek/deepseek-v4-pro",
    messages,
    stream: true,
  };

  body.reasoning = thinkState === "on"
    ? { enabled: true, effort: "medium", exclude: false }
    : { enabled: false, exclude: true };
  // 来自 https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = await readErrorJson(response);
    throw new Error(data?.error?.message || data?.message || `OpenRouter HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("OpenRouter SSE 响应不可读");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let reasoning = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const lines = event.split("\n");
      for (const line of lines) {
        // 例如 data: {"choices":[{"delta":{"content":"Hi"}}]}
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta;
          const text = extractDeltaText(delta);

          if (delta?.reasoning) {
            reasoning += delta.reasoning;
          }

          if (text) {
            fullContent += text;
            try {
              await onText(text);
            } catch (err) {
              console.error("流式回调失败:", err);
            }
          }
        } catch (err) {
          console.error("SSE 数据解析失败:", err);
        }
      }
    }
  }

  return {
    content: fullContent || "AI 回复失败",
    reasoning,
  };
}

function extractDeltaText(delta) {
  if (!delta) return "";

  if (typeof delta.content === "string") {
    return delta.content;
  }

  if (Array.isArray(delta.content)) {
    return delta.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text || "";
        return "";
      })
      .join("");
  }

  return "";
}

async function readErrorJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
