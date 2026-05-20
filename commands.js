import { sendTelegramMessage } from "./tg_api.js";

const HELP_TEXT = [
  "一次输入仅执行一个命令：",
  "/help - 显示帮助",
  "/whoami - 显示当前 Chat ID",
  "/prompt - 查看当前 prompt",
  "/prompt <内容> - 更新 prompt",
  "/resetprompt - 恢复默认 prompt",
  "/clear - 清空聊天历史",
  "/think - 查看思考模式",
  "/think on|off - 开关思考模式",
  "/chunk - 查看分块发送设置",
  "/chunk off - 关闭分块发送",
  "/chunk <100-1000> - 设置分块字符数",
].join("\n");

export const COMMAND_HANDLERS = {
  async help({ env, chatId }) {
    await sendTelegramMessage(env, chatId, HELP_TEXT);
    return new Response("ok");
  },

  async whoami({ env, chatId, args }) {
    if (args) {
      return await COMMAND_HANDLERS.help({ env, chatId });
    }

    await sendTelegramMessage(env, chatId, `你的 Chat ID 是：${chatId}`);
    return new Response("ok");
  },

  async prompt({ env, chatId, args }) {
    if (!args) {
      const systemPrompt = (await env.BOT_KV.get(`prompt_${chatId}`)) || env.DEFAULT_PROMPT;
      await sendTelegramMessage(env, chatId, `💬当前提示词：\n\n${systemPrompt}`);
      return new Response("ok");
    }

    await env.BOT_KV.put(`prompt_${chatId}`, args);
    await sendTelegramMessage(env, chatId, "✅ Prompt 已更新");
    return new Response("ok");
  },

  async resetprompt({ env, chatId, args }) {
    if (args) {
      return await COMMAND_HANDLERS.help({ env, chatId });
    }

    await env.BOT_KV.delete(`prompt_${chatId}`);
    await sendTelegramMessage(env, chatId, "♻️ 已恢复默认 prompt");
    return new Response("ok");
  },

  async clear({ env, chatId, args }) {
    if (args) {
      return await COMMAND_HANDLERS.help({ env, chatId });
    }

    await env.BOT_KV.delete(`history_${chatId}`);
    await sendTelegramMessage(env, chatId, "🧹 已清空聊天历史");
    return new Response("ok");
  },

  async think({ env, chatId, args }) {
    if (!args) {
      const currentState = (await env.BOT_KV.get(`think_${chatId}`)) || "off";
      await sendTelegramMessage(env, chatId, `当前思考模式：${currentState === "on" ? "🟢 已开启" : "🔴 已关闭"}`);
      return new Response("ok");
    }

    if (args !== "on" && args !== "off") {
      return await COMMAND_HANDLERS.help({ env, chatId });
    }

    await env.BOT_KV.put(`think_${chatId}`, args);
    await sendTelegramMessage(env, chatId, args === "on" ? "🧠 思考模式已开启" : "💨 思考模式已关闭");
    return new Response("ok");
  },

  async chunk({ env, chatId, args }) {
    if (!args) {
      const currentChunk = (await env.BOT_KV.get(`chunk_${chatId}`)) || "500";
      const currentText = currentChunk === "off" ? "关闭" : `${currentChunk} 字符`;
      await sendTelegramMessage(env, chatId, `当前分块发送：${currentText}`);
      return new Response("ok");
    }

    if (args === "off") {
      await env.BOT_KV.put(`chunk_${chatId}`, "off");
      await sendTelegramMessage(env, chatId, "✅ 分块发送已关闭");
      return new Response("ok");
    }

    if (!/^\d+$/.test(args)) {
      return await COMMAND_HANDLERS.help({ env, chatId });
    }

    const chunkSize = Number.parseInt(args, 10);
    if (chunkSize < 100 || chunkSize > 1000) {
      return await COMMAND_HANDLERS.help({ env, chatId });
    }

    await env.BOT_KV.put(`chunk_${chatId}`, String(chunkSize));
    await sendTelegramMessage(env, chatId, `✅ 分块发送已设置为 ${chunkSize} 字符`);
    return new Response("ok");
  },
};

export function parseCommand(text) {
  const lines = text.split(/\r?\n/);
  const firstLine = lines[0].trim();
  if (!firstLine.startsWith("/")) return null;

  const [rawName, ...argParts] = firstLine.slice(1).split(/\s+/);
  const name = rawName || "";
  const command = name.split("@")[0];
  
  let args = argParts.join(" ").trim();
  
  if (lines.length > 1) {
    const restLines = lines.slice(1).join("\n");
    args = args ? args + "\n" + restLines : restLines;
  }

  return { command, args };
}
