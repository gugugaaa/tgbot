export class ChatTaskDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.streamBuffers = new Map();   // 中途被掐不保存，这种对话没意义
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("ok");
    }

    const job = await request.json();
    const queue = (await this.state.storage.get("queue")) || [];
    queue.push({
      ...job,
      createdAt: Date.now(),
      status: "queued",
    });
	// 比如单人一次发多条命令，逐个解决（要是DO还活着）
    await this.state.storage.put("queue", queue);
    await this.state.storage.setAlarm(Date.now() + 100);  // 异步消费

    return new Response("queued");
  }

  async alarm() {
    if (await this.state.storage.get("running")) return;

    const queue = (await this.state.storage.get("queue")) || [];
    const job = queue.shift();
    if (!job) return;

    await this.state.storage.put("queue", queue);
    await this.state.storage.put("running", true);

    try {
      await sendTelegramTyping(this.env, job.chatId);

      const typingInterval = setInterval(() => {
        sendTelegramTyping(this.env, job.chatId).catch(console.error);
      }, 4000);

      try {
        const aiReply = await askAIStream(this.env, job.messages, job.thinkState, async (part) => {
          await this.appendAndMaybeFlushChunk(job.chatId, part, job.chunkSize);
        });

        await this.flushChunk(job.chatId);

        job.history.push({ role: "user", content: job.userText });
        job.history.push({ role: "assistant", content: aiReply.content });
        await this.env.BOT_KV.put(`history_${job.chatId}`, JSON.stringify(job.history.slice(-20)));
      } finally {
        clearInterval(typingInterval);
        this.streamBuffers.delete(job.chatId);
      }
    } catch (err) {
      console.error("AI 报错:", err);
      await this.state.storage.put("lastError", {
        ...job,
        status: "failed",
        error: err?.message || String(err),
        failedAt: Date.now(),
      });
      await sendTelegramMessage(this.env, job.chatId, "❌ AI 回复出错了，请稍后再试。");
    } finally {
      await this.state.storage.delete("running");
      const remaining = (await this.state.storage.get("queue")) || [];
      if (remaining.length > 0) {
        await this.state.storage.setAlarm(Date.now() + 100);
      }
    }
  }

  async appendAndMaybeFlushChunk(chatId, text, chunkSize) {
    if (!text) return;

    const current = this.streamBuffers.get(chatId) || "";
    const next = current + text;
    this.streamBuffers.set(chatId, next);

    if (chunkSize === 0) return;

    while ((this.streamBuffers.get(chatId) || "").length >= chunkSize) {
      const buffer = this.streamBuffers.get(chatId) || "";
      const slice = buffer.slice(0, chunkSize);
      const remain = buffer.slice(chunkSize);
      this.streamBuffers.set(chatId, remain);
      await sendTelegramMessage(this.env, chatId, slice);
    }
  }

  async flushChunk(chatId) {
    const rest = this.streamBuffers.get(chatId) || "";
    if (!rest) return;

    this.streamBuffers.delete(chatId);
    await sendTelegramMessage(this.env, chatId, rest);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot running");

    try {
      const update = await request.json();
      const message = update.message;

      if (!message?.text) return new Response("ok");

      const chatId = message.chat.id.toString();
      const userText = message.text.trim();

      if (env.ADMIN_CHAT_ID && chatId !== env.ADMIN_CHAT_ID) {
        return new Response("Unauthorized");
      }

      if (userText === "/prompt") {
        let systemPrompt = (await env.BOT_KV.get(`prompt_${chatId}`)) || env.DEFAULT_PROMPT;
        await sendTelegramMessage(env, chatId, `💬当前提示词：\n\n${systemPrompt}`);
        return new Response("ok");
      }

      if (userText.startsWith("/prompt ")) {
        await env.BOT_KV.put(`prompt_${chatId}`, userText.replace("/prompt ", ""));
        await sendTelegramMessage(env, chatId, "✅ Prompt 已更新");
        return new Response("ok");
      }

      if (userText === "/resetprompt") {
        await env.BOT_KV.delete(`prompt_${chatId}`);
        await sendTelegramMessage(env, chatId, "♻️ 已恢复默认 prompt");
        return new Response("ok");
      }

      if (userText === "/clear") {
        await env.BOT_KV.delete(`history_${chatId}`);
        await sendTelegramMessage(env, chatId, "🧹 已清空聊天历史");
        return new Response("ok");
      }

      if (userText === "/whoami") {
        await sendTelegramMessage(env, chatId, `你的 Chat ID 是：${chatId}`);
        return new Response("ok");
      }

      if (userText === "/think on") {
        await env.BOT_KV.put(`think_${chatId}`, "on");
        await sendTelegramMessage(env, chatId, "🧠 思考模式已开启");
        return new Response("ok");
      }

      if (userText === "/think off") {
        await env.BOT_KV.put(`think_${chatId}`, "off");
        await sendTelegramMessage(env, chatId, "💨 思考模式已关闭");
        return new Response("ok");
      }

      if (userText === "/think") {
        let currentState = (await env.BOT_KV.get(`think_${chatId}`)) || "off";
        await sendTelegramMessage(env, chatId, `当前思考模式：${currentState === "on" ? "🟢 已开启" : "🔴 已关闭"}`);
        return new Response("ok");
      }

      if (userText === "/chunk") {
        const currentChunk = (await env.BOT_KV.get(`chunk_${chatId}`)) || "500";
        const currentText = currentChunk === "off" ? "关闭" : `${currentChunk} 字符`;
        await sendTelegramMessage(env, chatId, `当前分块发送：${currentText}`);
        return new Response("ok");
      }

      if (userText === "/chunk off") {
        await env.BOT_KV.put(`chunk_${chatId}`, "off");
        await sendTelegramMessage(env, chatId, "✅ 分块发送已关闭");
        return new Response("ok");
      }

      if (userText.startsWith("/chunk ")) {
        const rawValue = userText.slice(7).trim();
        const parsed = Number.parseInt(rawValue, 10);

        if (Number.isNaN(parsed)) {
          await sendTelegramMessage(env, chatId, "分块长度只支持 100-1000，或使用 /chunk off");
          return new Response("ok");
        }

        const chunkSize = Math.min(1000, Math.max(100, parsed));
        await env.BOT_KV.put(`chunk_${chatId}`, String(chunkSize));
        await sendTelegramMessage(env, chatId, `✅ 分块发送已设置为 ${chunkSize} 字符`);
        return new Response("ok");
      }

      let systemPrompt = (await env.BOT_KV.get(`prompt_${chatId}`)) || env.DEFAULT_PROMPT;
      let thinkState = (await env.BOT_KV.get(`think_${chatId}`)) || "off";
      let history = JSON.parse((await env.BOT_KV.get(`history_${chatId}`)) || "[]");
      const chunkSetting = (await env.BOT_KV.get(`chunk_${chatId}`)) || "500";
      const currentChunkSize = chunkSetting === "off"
        ? 0
        : Math.min(1000, Math.max(100, Number.parseInt(chunkSetting, 10) || 500));

      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userText },
      ];

      const id = env.CHAT_TASKS.idFromName(chatId);
      const task = env.CHAT_TASKS.get(id);
      ctx.waitUntil(task.fetch("https://spaghetti.code/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          userText,
          messages,
          history,
          thinkState,
          chunkSize: currentChunkSize,
        }),
      }));

      return new Response("ok");
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  },
};

async function askAIStream(env, messages, thinkState, onText) {
  const body = {
    model: "deepseek/deepseek-v4-pro",
    messages,
    stream: true,
  };

  if (thinkState === "on") {
    body.include_reasoning = true; // OpenRouter 统一参数
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data?.error?.message || `OpenRouter HTTP ${response.status}`);
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

async function sendTelegramMessage(env, chatId, text) {
  if (!text) return;

  let finalText = text;

  if (finalText.length > 4000) {
    finalText = finalText.slice(0, 4000) + "\n\n[⚠️ 消息过长已被截断]";
  }

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: finalText,
    }),
  });
}

async function sendTelegramTyping(env, chatId) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      action: "typing",
    }),
  });
}
