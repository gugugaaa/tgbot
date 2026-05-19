import { sendTelegramMessage, sendTelegramTyping, notifyTelegram } from "./tg_api.js";
import { askAIStream } from "./openrouter.js";
import { parseCommand, COMMAND_HANDLERS } from "./commands.js";

export class ChatTaskDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.streamBuffers = new Map();   // DO 中途被掐不保存，这种对话没意义
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("ok");
    }

    let job;
    try {
      job = await request.json();
    } catch (err) {
      console.error("队列请求 JSON 解析失败:", err);
      return new Response("bad request", { status: 400 });
    }

    if (!job?.chatId || !Array.isArray(job.messages)) {
      console.error("队列请求参数不完整:", job);
      return new Response("bad request", { status: 400 });
    }

    // 锁住队列并发
    await this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get("queue")) || [];
      queue.push({
        ...job,
        createdAt: Date.now(),
        status: "queued",
      });
      // 比如单人一次发多条命令，逐个解决（要是 DO 还活着）
      await this.state.storage.put("queue", queue);
      await this.state.storage.setAlarm(Date.now() + 100); // 异步消费
    });

    return new Response("queued");
  }

  async alarm() {
    let job;
    await this.state.blockConcurrencyWhile(async () => {
      if (await this.state.storage.get("running")) return;

      const queue = (await this.state.storage.get("queue")) || [];
      job = queue.shift();
      if (!job) return;

      await this.state.storage.put("queue", queue);
      await this.state.storage.put("running", true);
    });
    if (!job) return;

    try {
      await sendTelegramTyping(this.env, job.chatId).catch((err) => console.error("发送 typing 失败:", err));

      // 每 4 秒发送一次 typing
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
        error: errorMessage(err),
        failedAt: Date.now(),
      });
      await notifyTelegram(this.env, job.chatId, "❌ DO 出错了");
      // 报错的记录不会入队
    } finally {
      try {
        await this.state.storage.delete("running");
        const remaining = (await this.state.storage.get("queue")) || [];
        if (remaining.length > 0) {
          await this.state.storage.setAlarm(Date.now() + 100);
        }
      } catch (err) {
        console.error("清理 DO 状态失败:", err);
      }
    }
  }

  // SSE中攒到一定量就发一段
  async appendAndMaybeFlushChunk(chatId, text, chunkSize) {
    if (!text) return;

    const current = this.streamBuffers.get(chatId) || "";
    const next = current + text;
    this.streamBuffers.set(chatId, next);

    if (chunkSize === 0) return;

    let sentAnyChunk = false;

    while (true) {
      const buffer = this.streamBuffers.get(chatId) || "";

      if (buffer.length < chunkSize) {
        break;
      }

      // 从 chunkSize 位置开始寻找换行符
      const newlineIndex = buffer.indexOf("\n", chunkSize);

      if (newlineIndex === -1) {
        // 没有找到换行符，等待更多数据
        break;
      }

      // 发送到换行符为止
      const slice = buffer.slice(0, newlineIndex + 1);
      const remain = buffer.slice(newlineIndex + 1);
      this.streamBuffers.set(chatId, remain);
      await sendTelegramMessage(this.env, chatId, slice);
      sentAnyChunk = true;
    }

    // Telegram 发送消息后会结束当前 typing 展示
    // 中途只要发出过 chunk，就补一次 typing，活到4秒以后
    if (sentAnyChunk) {
      sendTelegramTyping(this.env, chatId).catch((err) => console.error("补 typing 失败:", err));
    }
  }

  // 结束时把剩下没发的尾巴发出去
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

    // 验证 Telegram webhook secret token，避免伪造update
    if (env.TELEGRAM_SECRET_TOKEN) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (got !== env.TELEGRAM_SECRET_TOKEN) {
        return new Response("ok");
      }
    }

    let chatId;

    try {
      const update = await request.json().catch((err) => {
        console.error("Webhook JSON 解析失败:", err);
        return null;
      });

      if (!update) return new Response("ok");

      const message = update.message;

      if (!message?.text) return new Response("ok");

      chatId = message.chat.id.toString();
      const userText = message.text.trim();
      const commandRequest = parseCommand(userText);

      if (commandRequest?.command === "whoami") {
        return await COMMAND_HANDLERS.whoami({ env, chatId });
      }

      if (env.ADMIN_CHAT_ID && chatId !== env.ADMIN_CHAT_ID) {
        // Telegram webhook 非 2xx 会触发重试，别发真的403
        return new Response("Unauthorized");
      }

      if (commandRequest) {
        const handler = COMMAND_HANDLERS[commandRequest.command] || COMMAND_HANDLERS.help;
        return await handler({ env, chatId, args: commandRequest.args });
      }
      
      // 并行获取 KV
      const [promptRaw, thinkRaw, historyRaw, chunkSettingRaw] = await Promise.all([
        env.BOT_KV.get(`prompt_${chatId}`),
        env.BOT_KV.get(`think_${chatId}`),
        env.BOT_KV.get(`history_${chatId}`),
        env.BOT_KV.get(`chunk_${chatId}`),
      ]);

      const systemPrompt = promptRaw || env.DEFAULT_PROMPT;
      const thinkState = thinkRaw || "off";
      const history = parseHistory(historyRaw, chatId);
      const chunkSetting = chunkSettingRaw || "500";
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
      ctx.waitUntil((async () => {
        const response = await task.fetch("https://spaghetti.code/queue", {
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
        });

        if (!response.ok) {
          console.error("任务入队失败:", response.status, await response.text().catch(() => ""));
          await notifyTelegram(env, chatId, "❌ 任务入队失败，请稍后再试。");
        }
      })().catch((err) => {
        console.error("任务入队异常:", err);
        return notifyTelegram(env, chatId, "❌ 任务入队失败，请稍后再试。");
      }));

      return new Response("ok");
    } catch (err) {
      console.error("Webhook 处理失败:", err);
      if (chatId) {
        ctx.waitUntil(notifyTelegram(env, chatId, "❌ Worker 出错了"));
      }
      // 保持 2xx，避免 Telegram webhook 重试导致重复入队
      return new Response("failed");
    }
  },
};

function parseHistory(raw, chatId) {
  if (!raw) return [];

  try {
    const history = JSON.parse(raw);
    return Array.isArray(history) ? history : [];
  } catch (err) {
    console.error(`历史记录解析失败 chatId=${chatId}:`, err);
    return [];
  }
}

function errorMessage(err) {
  return err?.message || String(err);
}
