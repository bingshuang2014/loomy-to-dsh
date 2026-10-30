# loomy-to-dsh

> ⚠️ **免责声明**
>
> 本项目是**个人学习与练习作品**，仅供技术研究、学习交流使用。
> 本项目与 **讯飞、Loomy、DeepSeek** 等任何第三方公司或产品**均无关联**，未获其授权、认可或资助。
> 文中出现的名称、商标、API、服务均归各自所有者所有，仅用于描述兼容性关系。
> 使用者须自行遵守所涉第三方服务的使用条款，本项目作者不对任何滥用行为承担责任。
> 请勿用于商业用途或超出个人合理使用的范畴。

将讯飞 **Loomy** 桌面 App 已登录账号可用的模型零配置接入 **DeepSeek Harness**：装上插件、重启界面，模型选择器里出现「Loomy」分组，直接可用，无需二次登录。

模型来自 Loomy 的 `imodel` provider（`https://loomyad.xunfei.cn/api/v1`，session 鉴权），包含 DeepSeek-V4.1-Flash、Kimi-k2.6、GLM-5.3-Flash、qwen3.8 系列、Spark 系列（限时免费）、MiniMax-M3、MiMo-v2.5 等。流式、工具调用、图片输入、reasoning 档位、上下文窗口均沿用各自的账号登录与计费。

> 本项目与讯飞、Loomy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，商标归各自所有。

## 它做了什么

插件复用 Loomy 桌面 App 的本地登录态，不启动任何 OAuth：

1. **发现 session**：扫描 `C:\Users\Public\Loomy\<hash>\userData\auth-session.json`（明文存储的 session 令牌），每 30 秒轮询一次，登录/登出/切换账号自动跟随。可用 `LOOMY_HOME` / `LOOMY_USER_DATA` 环境变量或 `homeDir` / `userDataDir` 配置项显式指定目录。
2. **拉取模型目录**：用 session 令牌 `GET {baseURL}/models`，解析出实时目录（上下文窗口、输出上限、输入模态、reasoning 档位）。拉取失败时退回上次成功保存的目录，再退回内置快照。
3. **起回环代理**：在 `127.0.0.1` 上起一个 OpenAI 兼容的 loopback 端点（`/v1/chat/completions`、`/v1/models`、`/healthz`），带一个进程内共享密钥做 `Authorization`。
4. **注册 provider**：把 `loomy` 作为一个 pi-ai provider 注册进 DSH 的 `llm` 接缝（`ctx.llm.registerAdapter`），模型指向回环代理。
5. **改写鉴权头**：DSH 的 OpenAI 风格请求到达回环代理后，代理注入 Loomy 必需的鉴权/追踪头，原样转发给 `loomyad.xunfei.cn`，SSE 响应原样回传——DSH 侧的 OpenAI 解码器照常工作。

架构与 [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) 一致（一个回环 shim + 一个 pi-ai adapter 注册进 `llm` 接缝），区别只在凭据来源（Loomy 明文 session vs WorkBuddy 密封凭据）和上游协议改写。

## 为什么是纯 JS 而不是 TS

参照同类 DSH 插件的惯例：纯 ESM JavaScript、零构建步骤、`node --test` 跑测试。这样安装只需把目录丢进 profile 的 `dependencies`，不会卡在装不上的 peer 类型解析或 generation 校验上。运行时导入的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`、`@earendil-works/pi-ai` 由宿主 profile 的 `node_modules` 解析，与 `dsh-workbuddy-connect` 编译产物用的是同一套接缝。

## 前置

- 已安装并**登录** Loomy 桌面 App（国内版）。插件直接读它的登录态，没登录就没有模型分组。
- DSH 内核带 `llm` / `pi-ai` 接缝（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`、`@earendil-works/pi-ai`）。本机桌面 profile 已具备（`dsh-workbuddy-connect` 装着）。

## 安装（本地 `file:` 依赖，推荐）

在 DSH profile 的 `package.json` 里加一行 `file:` 依赖，和同类 DSH 插件的装法一样。

**Web profile**（`C:\Users\<你>\.dsh\profiles\web\package.json`）：

```jsonc
{
  "dependencies": {
    "loomy-to-dsh": "file:<你的路径>/loomy-to-dsh"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "loomy-to-dsh"
      ]
    }
  }
}
```

**Desktop profile**（`C:\Users\<你>\.dsh\profiles\desktop\package.json`）：在现有 `dependencies` 里加 `"loomy-to-dsh": "file:<你的路径>/0dsh/loomy-to-dsh"`，并在 `dsh.profile.bundles` 数组末尾追加 `"loomy-to-dsh"`。

然后在对应 profile 目录跑一次安装并重启界面：

```sh
cd C:\Users\<你>\.dsh\profiles\web
pnpm install
# 重启 DSH Web
```

桌面版 profile 由 App 管理：部分官方 Electron 发行版会拒绝独立 CLI 的 `--profile desktop`。如果安装因 generation 校验失败，可改用 Web profile 验证（不影响功能）。

> 任何本地文件改动先备份。改 `package.json` 前，先 `copy package.json package.json.bak`。

## 验证

1. 重启 DSH 界面后，模型选择器出现「Loomy」分组，列出 DeepSeek-V4.1-Flash 等模型（带积分倍率，如 `DeepSeek V4.1 Flash · ×2.0`）。
2. 从分组里选一个模型，完成一次简短对话、能正常回复，才算成功。
3. 状态接口（同源 GET）：浏览器里访问 `http://127.0.0.1:<dsh端口>/loomy-to-dsh/status`，返回 JSON：`signedIn`、`account`、模型列表、目录来源（`live`/`saved`/`fallback`）、app 版本、baseURL。session 令牌只显示掩码（`f226…8c2`）。

## 功能

- **开箱即用**：装上即用，无需配置。Loomy 登录态变化（登录/登出/切号）自动跟随，30 秒内生效。
- **流式**：标准 SSE `chat.completion.chunk`，DSH 照常解码。
- **工具调用**：模型声明 `function_calling` 的支持 OpenAI tools/tool_choice。
- **图片输入**：声明 `vision` 的模型（DeepSeek-V4.1-Flash、GLM-5.3-Flash、qwen3.8-flash、MiniMax-M3、Kimi-k2.6、MiMo-v2.5）支持图片输入；纯文字模型（qwen-3.8-max、Spark 系列）不会收到图片。
- **推理档位**：上游声明的档位（`none`/`low`/`medium`/`high`/`xhigh`）直接显示。`none` 映射为「关闭思考」。
- **积分显示**：状态路由返回积分信息（永久积分 + 每日赠送），数据来自 Loomy 网页版。
- **模型显隐**：`~/.dsh/.loomy-visibility.json` 按账号（userid）保存隐藏列表；切换账号自动切换各自配置。
- **目录持久化**：`~/.dsh/.loomy-catalog.json` 保存上次成功的目录，重启先服务它再后台刷新。

## 配置（可选）

profile 的 cordis 配置块（`cordis.patch.yml` 之外，profile 自身的 `dsh` config）：

```yaml
# 示例：显式指定 Loomy 目录与上游
llm-loomy:
  homeDir: 'C:\Users\Public\Loomy\8c6976e5b541'
  baseUrl: 'https://loomyad.xunfei.cn/api/v1'
  pollMs: 30000
```

环境变量（优先级高于配置）：

| 变量 | 作用 |
|---|---|
| `LOOMY_HOME` | 显式 Loomy profile 根目录（userData 的父目录） |
| `LOOMY_USER_DATA` | 显式 userData 目录 |
| `LOOMY_BASE_URL` | 显式上游 baseURL |
| `LOOMY_VERSION` | 显式 Loomy app 版本（默认从 `last-app-version.txt` 读） |

## 协议事实（给实现者）

实测（真实账号，Loomy 0.9.38）确认的 loomyad.xunfei.cn 协议：

| 端点 | 方法 | 鉴权头 | 备注 |
|---|---|---|---|
| `/api/v1/models` | GET | `Authorization: Bearer <session>`（`token` 头可选） | 返回 `{object:"list",data:[…]}`，含 `reasoning_efforts`/`context_length`/`max_output_tokens`/`capabilities` |
| `/api/v1/chat/completions` | POST | `Authorization: Bearer <session>` + **`TurnId`** + `X-Loomy-Request-Purpose: chat.message` | 标准 OpenAI 请求体；流式返回 SSE `chat.completion.chunk`；`usage.points_consumed` 给扣费点数 |

**关键坑**：只发 `ChatId`+`MsgId` 不发 `TurnId` 会 **400「请求参数错误」**（很快返回，看起来像 body 问题）。补上 `TurnId`（可与 `MsgId` 相同）即 200。`traceparent` / `token` 头实测**都非必填**，但插件仍发送（零成本、可能影响其他路由）。

完整头集合：`Authorization`、`token`、`Accept`、`Content-Type`、`traceparent`（W3C `00-<32hex>-<16hex>-01`）、`loomy-version`、`ChatId`、`MsgId`、`TurnId`、`InvokeOrigin: user`、`X-Loomy-Request-Purpose: chat.message`。

## 项目结构

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：发现 session、建 catalog、起 shim、注册 provider、轮询登录态、挂状态路由 |
| `adapter.js` | pi-ai provider + `PiAiAdapter` 子类，把 Loomy 目录转成 pi-ai Model（含 `thinkingLevelMap`，`off`→`none`、支持 `xhigh`） |
| `shim.js` | 回环 OpenAI 兼容端点：Host/Origin/bearer 网关 + `/v1/chat/completions` 转发 + SSE 回传 |
| `upstream.js` | loomyad 客户端：头构造、`/models`、`/chat/completions`、错误分类 |
| `catalog.js` | 模型目录解析 + 内置快照 + 持久化 store |
| `session.js` | Loomy profile 发现 + auth-session.json 读取 + 版本/baseURL |
| `loopback.js` | 回环网关 + fetch 友好端口选择 |
| `visibility.js` | 按账号的模型显隐 store |
| `status-route.js` | 同源 GET 状态路由 |
| `version.js` | 版本/provider 常量 |
| `cordis.patch.yml` | 注册 `llm-loomy` bundle |
| `test/` | `node --test` 单元测试（27 项，全绿） |

## 测试

```sh
node --test "test/*.test.mjs"
```

测试覆盖目录解析、session 解析、头构造（TurnId 必填）、traceparent 格式、错误分类、回环网关，不接触网络与 DSH 宿主。

## 致谢

- [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）—— 插件架构与 `pi-ai` adapter 注册方式的参照。
- 同类 DSH 插件的 `file:` 依赖安装方式为样板。

## 许可证

[MIT](./LICENSE)
