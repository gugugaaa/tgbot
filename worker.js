export class ChatTaskDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
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
    await this.state.storage.put("queue", queue);
    await this.state.storage.setAlarm(Date.now() + 100);

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
      await sendTelegramMessage(this.env, job.chatId, "⏳ 已收到，正在等待模型回复。");

      const aiReply = await askAI(this.env, job.messages, job.thinkState);

      if (job.thinkState === "on" && aiReply.reasoning) {
        await sendTelegramMessage(this.env, job.chatId, `🤔 *思考过程：*\n\n${aiReply.reasoning}`);
      }
      await sendTelegramMessage(this.env, job.chatId, aiReply.content);

      job.history.push({ role: "user", content: job.userText });
      job.history.push({ role: "assistant", content: aiReply.content });
      await this.env.BOT_KV.put(`history_${job.chatId}`, JSON.stringify(job.history.slice(-20)));
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

      let systemPrompt = (await env.BOT_KV.get(`prompt_${chatId}`)) || env.DEFAULT_PROMPT;
      let thinkState = (await env.BOT_KV.get(`think_${chatId}`)) || "off";
      let history = JSON.parse((await env.BOT_KV.get(`history_${chatId}`)) || "[]");

      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userText },
      ];

      const id = env.CHAT_TASKS.idFromName(chatId);
      const task = env.CHAT_TASKS.get(id);
      ctx.waitUntil(task.fetch("https://chat-task.local/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, userText, messages, history, thinkState }),
      }));

      return new Response("ok");
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  },
};

async function askAI(env, messages, thinkState) {
  const body = {
    model: "deepseek/deepseek-v4-pro",
    messages,
  };

  if (thinkState === "on") {
    body.include_reasoning = true;
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenRouter HTTP ${response.status}`);
  }

  const msg = data?.choices?.[0]?.message;

  return {
    content: msg?.content || "AI 回复失败",
    reasoning: msg?.reasoning || "",
  };
}

async function sendTelegramMessage(env, chatId, text) {
  if (!text) return;

  let finalText = text.replace(/\n+/g, "\n\n");

  if (finalText.length > 4000) {
    finalText = finalText.slice(0, 4000) + "\n\n[⚠️ 消息过长已被截断]";
  }

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: finalText,
      parse_mode: "Markdown",
    }),
  });
}
