// Telegram API 封装

export async function sendTelegramMessage(env, chatId, text) {
  if (!text) return;

  let finalText = text;

  // 基本没这个情况我就不管了
  if (finalText.length > 4000) {
    finalText = finalText.slice(0, 4000) + "\n\n[⚠️ 消息过长已被截断]";
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: finalText,
    }),
  });

  let data;
  try {
    data = await response.json();
  } catch (err) {
    if (response.ok) throw err;
    data = {};
  }

  if (!response.ok) {
    throw new Error(data?.description || `Telegram HTTP ${response.status}`);
  }

  return data;
}

export async function sendTelegramTyping(env, chatId) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      action: "typing",
    }),
  });

  if (!response.ok) {
    const data = await readErrorJson(response);
    throw new Error(data?.description || `Telegram typing HTTP ${response.status}`);
  }
}

export async function notifyTelegram(env, chatId, text) {
  try {
    await sendTelegramMessage(env, chatId, text);
  } catch (err) {
    console.error("通知用户失败:", err);
  }
}

async function readErrorJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
