# tgbot
Cloudflare Workers + Durable Objs 部署的 Telegram AI 机器人，默认通过 OpenRouter 接入 DeepSeek。

## 核心特性
- **增长壁钟墙**：用 worker 唤醒 DO，DO 壁钟墙足以等 2min +
- **流式输出**：SSE 接收，分 chunk 推送至 Tg。
- **细节 UX**：chunk 美化，刷新 typing，/prompt 传参支持换行
- 其他 **chatbot 基础功能** 该有的都有：
	- 上下文记忆（kv 存储）
	- 鉴权和安全
		- 支持白名单
		- Webhook 密钥验证（类似于*对称签名*）
	- Chat ID 隔离
		- 自定义系统提示词
		- 其他配置

<a href="https://i.ibb.co/VcxjjyHM/1.png" >设置自定义Prompt</a>
<a href="https://i.ibb.co/1GpMFQJP/2.png" >流式传输</a>

## 环境要求
- Node.js & npm
- Cloudflare 账号（免费的足够，有 DO 额度）
- Telegram Bot Token
- OpenRouter API Key

## 部署步骤

### 安装依赖
```bash
npm install
```

### 创建 KV 命名空间
```bash
npx wrangler kv:namespace create BOT_KV
```
将输出的 id 填入 wrangler.jsonc 的 kv_namespaces 中。

### 配置密钥
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put TELEGRAM_SECRET_TOKEN
npx wrangler secret put ADMIN_CHAT_ID      # 可选
npx wrangler secret put DEFAULT_PROMPT     # 可选
```

### 部署
```bash
npm run deploy
```

### 绑定 Webhook
替换参数并请求以下地址：
```text
[https://api.telegram.org/bot](https://api.telegram.org/bot)<TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<SECRET_TOKEN>
```

## 机器人指令
- `/help` - 帮助菜单
- `/whoami` - 查 Chat ID
- `/prompt` - 查系统提示词
- `/prompt <内容>` - 改系统提示词
- `/resetprompt` - 重置系统提示词
- `/clear` - 清空历史
- `/think` - 查思考模式状态
- `/think on|off` - 开关思考模式
- `/chunk` - 查分块发送状态
- `/chunk off` - 关分块发送
- `/chunk <字数>` - 设分块长度

## 项目结构
- `worker.js`：请求入口与 DO 队列调度
- `commands.js`：指令解析与路由
- `openrouter.js`：AI 接口请求与 SSE 流解析
- `tg_api.js`：Telegram 接口封装
- `wrangler.jsonc`：云端部署配置

> 边缘场景如 RP，尽量选 ZDR 服务商，有截断可以去 OpenRouter - Logs 看`content_guardrail_invoked`等字段，一个验证可行的prompt被截断，可能是技术错误，而非内容审查。
