# loomy-to-dsh

> ⚠️ **免责声明**
>
> 本项目是**个人学习与练习作品**，仅供技术研究、学习交流使用。
> 本项目与 **讯飞、Loomy、DeepSeek** 等任何第三方公司或产品**均无关联**，未获其授权、认可或资助。
> 文中出现的名称、商标、API、服务均归各自所有者所有，仅用于描述兼容性关系。
> 使用者须自行遵守所涉第三方服务的使用条款，本项目作者不对任何滥用行为承担责任。
> 请勿用于商业用途或超出个人合理使用的范畴。

将 **Loomy** 桌面 App 已登录账号可用的模型零配置接入 **DeepSeek Harness**：装上插件、重启界面，模型选择器里出现「Loomy」分组，直接可用，无需二次登录。

模型包含 DeepSeek-V4.1-Flash、Kimi-k2.6、GLM-5.3-Flash、qwen3.8 系列、Spark 系列（限时免费）、MiniMax-M3、MiMo-v2.5 等。流式、工具调用、图片输入、reasoning 档位、上下文窗口均沿用各自的账号登录与计费。

## 功能

- **开箱即用**：装上即用，无需配置。Loomy 登录态变化（登录/登出/切号）自动跟随，30 秒内生效。
- **流式**：支持流式输出。
- **工具调用**：支持模型声明的工具调用。
- **图片输入**：声明支持的模型可接收图片输入；纯文字模型不会收到图片。
- **推理档位**：上游声明的档位直接显示，none 映射为「关闭思考」。
- **积分显示**：输入栏左侧显示 Loomy 积分（永久积分 + 每日赠送），点击可刷新，会话结束时自动刷新。
- **模型显隐**：按账号保存隐藏列表，切换账号自动切换各自配置。
- **目录持久化**：保存上次成功的模型目录，重启先服务它再后台刷新。

## 前置

- 已安装并**登录** Loomy 桌面 App。插件直接读它的登录态，没登录就没有模型分组。
- DSH 内核带 llm / pi-ai 接缝（本机桌面 profile 已具备）。

## 安装

在 DSH profile 的 package.json 里加一行 file: 依赖：

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

然后在对应 profile 目录跑一次安装并重启界面：

```sh
cd C:\Users\<你>\.dsh\profiles\web
pnpm install
# 重启 DSH
```

> 任何本地文件改动先备份。改 package.json 前，先 copy package.json package.json.bak。

## 验证

1. 重启 DSH 界面后，模型选择器出现「Loomy」分组，列出可用模型。
2. 从分组里选一个模型，完成一次简短对话、能正常回复，才算成功。
3. 输入栏左侧应出现积分显示，点击可刷新。

## 项目结构

纯 JavaScript 实现，零构建步骤，`node --test` 跑测试。详见源码。

## 测试

```sh
node --test "test/*.test.mjs"
```

## 致谢

- 插件架构参照同类 DSH 插件的惯例。

## 许可证

[MIT](./LICENSE)
