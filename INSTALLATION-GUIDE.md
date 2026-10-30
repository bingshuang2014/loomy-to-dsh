# DSH 插件安装调试经验（loomy-to-dsh）

**日期**：2026-10-21  
**场景**：开发并安装 loomy-to-dsh 插件，遇到 pnpm 安装失败、bundle 未加载等问题  
**结论**：插件已成功安装，模型选择器可见「Loomy」分组

---

## 1. Loomy 协议实测（真实账号验证）

### 关键发现

| 之前文档/猜测 | 实际验证 |
|---|---|
| `traceparent` 头缺失会导致请求挂死 | **不成立**。实测不带 traceparent 完全正常 |
| 需要完整的 ChatId+MsgId | **只发 ChatId+MsgId 会 400「请求参数错误」** |
| 鉴权靠 `token` header | 实际用标准 `Authorization: Bearer` 即可 |

### 真正必填的 Headers

```
Authorization: Bearer <session_token>
Content-Type: application/json
TurnId: <UUID>  // ← 这是关键！只发 ChatId+MsgId 会 400
```

**验证命令**：
```bash
# 不带 TurnId（会 400）
curl -X POST https://loomyad.xunfei.cn/api/v1/chat/completions \
  -H "Authorization: Bearer <session>" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4.1-Flash","messages":[...]}'

# 带 TurnId（200 OK）
curl -X POST https://loomyad.xunfei.cn/api/v1/chat/completions \
  -H "Authorization: Bearer <session>" \
  -H "Content-Type: application/json" \
  -H "TurnId: $(uuidgen)" \
  -d '{"model":"DeepSeek-V4.1-Flash","messages":[...]}'
```

### 端点

| 端点 | 方法 | 鉴权 | 备注 |
|---|---|---|---|
| `/api/v1/models` | GET | Authorization | 返回模型目录（含 reasoning_efforts） |
| `/api/v1/chat/completions` | POST | Authorization + **TurnId** | 标准 OpenAI 格式 |

---

## 2. DSH 插件架构（从 workbuddy 编译产物反推）

### 核心模式

```javascript
// plugin entry (index.js)
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

export const name = 'llm-loomy'
export const inject = ['llm']

export async function apply(ctx) {
  const shim = createLoomyShim({ store, client, catalog })
  await shim.ready
  
  const provider = {
    ...createProvider({
      id: 'loomy',
      name: 'Loomy',
      auth: { apiKey: { resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: 'Loomy' }) } },
      models: buildModels(),  // 从 catalog 来
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }
  
  ctx.llm.registerAdapter(['loomy'], new PiAiAdapter({
    profiles: () => new Map([['loomy', { provider, ... }]]),
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
  }))
  
  ctx.emit('llm/adapters-updated')
  
  ctx.effect(() => () => {
    releaseAdapter()
    shim.close()
  })
}
```

### 关键依赖（peer vs dependency）

| 包名 | 类型 | 原因 |
|---|---|---|
| `@earendil-works/pi-ai` | **dependency** | 运行时真正需要的 API |
| `@deepseek-ai/dsh-llm` | **无**（宿主注入） | profile 设 `autoInstallPeers: false`，宿主在加载 bundle 时自己注入 |
| `@deepseek-ai/dsh-llm-pi-ai` | **无**（宿主注入） | 同上 |
| `@deepseek-ai/schemastery` | **无**（宿主注入） | 实际安装在 node_modules，但由宿主管理版本 |

**验证方法**：
```bash
# profile 根目录的 node_modules
Get-ChildItem C:\Users\12973\.dsh\profiles\desktop\node_modules\@deepseek-ai
# 输出只有：cosmokit, schemastery
# 其他（dsh-llm, cordis 等）全缺失 → 宿主注入
```

---

## 3. 安装失败的根因链（逐步排查）

### 问题 1：pnpm 对 `file:D:/...` 解析错误

**症状**：
```
ENOENT ENOENT: no such file or directory, scandir 'C:\Users\12973\.dsh\profiles\desktop\D:\0data\0dsh\bobcfcAgents\plugin'
```

**根因**：pnpm 10.33 在 Windows 上把 `file:D:/path` 当成相对路径，拼到 cwd 后面。

**解决**：改用反斜杠
```json
"loomy-to-dsh": "file:D:\\0data\\0dsh\\loomy-to-dsh"
```

**验证**：在 scratch 目录快速测试
```bash
mkdir test && cd test
'{"name":"t","dependencies":{"loomy-to-dsh":"file:D:\\0data\\0dsh\\loomy-to-dsh"}}' > package.json
pnpm install  # 成功
```

### 问题 2：peerDependencies 版本不匹配

**症状**：
```
ERR_PNPM_NO_MATCHING_VERSION No matching version found for @deepseek-ai/dsh-llm@>=0.2.0
```

**根因**：registry 上 `@deepseek-ai/dsh-llm` 最新正式版只有 `0.0.1-rc.1`，`0.2.1-rc.2` 只在 `alpha` / `next` tag。

**解决**：用精确版本
```json
"peerDependencies": {
  "@deepseek-ai/dsh-llm": "0.2.1-rc.2",  // 精确版本，不是 >=
  ...
}
```

**验证**：
```bash
npm view @deepseek-ai/dsh-llm versions  # 看真实版本列表
npm view @deepseek-ai/dsh-llm@0.2.1-rc.2  # 确认存在
```

### 问题 3：`autoInstallPeers: false` 导致 peer 不装

**症状**：pnpm install 成功，但 `node_modules\@deepseek-ai\dsh-llm` 缺失。

**根因**：profile 的 `pnpm-workspace.yaml`：
```yaml
autoInstallPeers: false
```

这个配置告诉 pnpm **不要安装任何 peerDependencies**——它们由 DSH 宿主在加载 bundle 时注入。

**解决**：**整个去掉 peerDependencies**，只保留真正需要的 dependencies。

**验证**：
```bash
# 对比 workbuddy 的 package.json
node -e "const p=require('C:/Users/12973/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect/package.json'); console.log(p.peerDependencies)"
# 输出：undefined（workbuddy 也没有 peerDependencies）
```

### 问题 4（最关键）：package.json 缺少 `dsh.bundle.patch`

**症状**：
- bundles 数组里有 `loomy-to-dsh`
- node_modules 里有 `loomy-to-dsh` 目录
- 重启后模型选择器**没有「Loomy」分组**

**根因**：package.json 里没有 `dsh` 字段：
```json
{
  // ❌ 缺这个
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

没有这个声明，cordis **不会把这个包当成插件包加载**——`bundles` 数组里那行是死代码。

**解决**：
```json
{
  "name": "loomy-to-dsh",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "exports": {
    ".": "./index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",  // ← 必须暴露，否则 bundle.patch 解析失败
    "./package.json": "./package.json"
  }
}
```

**验证**：
```bash
# 对照其他插件
Get-Content C:\Users\12973\.dsh\profiles\desktop\node_modules\dsh-browser\package.json | Select-String '"dsh"'
# 所有插件都有这个字段
```

---

## 4. 正确的安装方式（避免 pnpm 反复重建 node_modules）

### ❌ 错误方式（会丢 file: 依赖）

```bash
cd C:\Users\12973\.dsh\profiles\desktop
pnpm install  # 反复跑会重建 node_modules，丢掉 file: 依赖
```

### ✅ 正确方式（手动复制）

```powershell
$nm = "C:\Users\12973\.dsh\profiles\desktop\node_modules"

# 1. 修复 package.json（加 dsh 字段）
# 2. 直接复制到 node_modules（模拟 hoisted linker 结果）
robocopy "D:\0data\0dsh\bobcfcAgents\plugin" "$nm\dsh-bobcfc-agents" /MIR /NFL /NDL /NJH /NJS /NP
robocopy "D:\0data\0dsh\loomy-to-dsh"    "$nm\loomy-to-dsh"    /MIR /XD research /XF diag.mjs

# 3. 校验
node -e "const p=require('C:/Users/12973/.dsh/profiles/desktop/node_modules/loomy-to-dsh/package.json');console.log(JSON.stringify(p.dsh))"
```

### 验证完整性

```powershell
# 文件数对比
(Get-ChildItem "D:\0data\0dsh\loomy-to-dsh" -Recurse -File | Measure-Object).Count
(Get-ChildItem "$nm\loomy-to-dsh" -Recurse -File | Measure-Object).Count

# JSON 解析
node -e "JSON.parse(require('fs').readFileSync('$nm/loomy-to-dsh/package.json','utf8'));console.log('OK')"

# 导出符号验证（对实际装的包）
cd $profile
node -e "import('@earendil-works/pi-ai').then(m=>console.log('createProvider:',typeof m.createProvider))"
node -e "import('@earendil-works/pi-ai/api/openai-completions.lazy').then(m=>console.log('openAICompletionsApi:',typeof m.openAICompletionsApi))"
node -e "import z from '@deepseek-ai/schemastery';console.log('z.object:',typeof z.object)"
```

---

## 5. 排查思路（系统性）

### Step 1：确认协议细节（协议层）

- 找真实账号 session token
- 用 curl / Node 脚本直接打端点
- 变体测试：每次只改一个 header，确认哪个是真正必填的

### Step 2：理解宿主架构（DSH 层）

- 反编译已装插件（workbuddy），看它怎么 import、怎么注册
- 查 `pnpm-workspace.yaml` 的配置（`autoInstallPeers: false` 是关键）
- 检查 `node_modules\@deepseek-ai/` 里有哪些包（缺失的就是宿主注入的）

### Step 3：对齐插件包格式（包结构层）

- 对照 4 个已装插件的 package.json（workbuddy / bobcfc / cockpit / dsh-browser）
- 逐字段对比：`dsh` / `exports` / `dependencies` / `peerDependencies`
- 确认 `cordis.patch.yml` 格式（`insert:` 包装）

### Step 4：隔离测试（最小化问题）

- 在 scratch 目录测试 package.json 的各种写法
- 验证 pnpm 对不同 spec（`file:D:/` vs `file:D:\` vs `file:///`）的解析
- 确认 hoisted linker 行为（scratch 不加 `nodeLinker: hoisted` 也能跑，排除这个变量）

### Step 5：动手安装（避免反复破坏）

- 先备份：`package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-lock.yaml`
- 一次只改一个变量，跑一次安装
- 安装失败立即停手，改用手动复制（pnpm 会重建 node_modules 丢 file: 依赖）

### Step 6：验证与回滚

- 模型选择器看分组
- 状态路由 `/loomy-to-dsh/status` 看 JSON
- 导入符号对实际装的包验证（不是对我写的代码）
- 保留备份目录，出问题立即还原

---

## 6. 常见坑与对策

| 坑 | 症状 | 对策 |
|---|---|---|
| `file:` 路径用正斜杠 | pnpm ENOENT 拼接错误路径 | 用反斜杠 `file:D:\path` |
| peerDependencies 用 `>=` | registry 无匹配版本 | 用精确版本 `0.2.1-rc.2` |
| `autoInstallPeers: false` | peer 包不装，代码找不到 | **去掉 peerDependencies** |
| 缺 `dsh.bundle.patch` | bundles 有但插件不加载 | 加 `dsh.bundle.patch` + `exports` 暴露 |
| `cordis.patch.yml` 格式错 | 插件未注册 id | 用 `- insert: - id: xxx - name: xxx` |
| pnpm 反复跑 | 重建 node_modules 丢依赖 | 手动 robocopy，别再跑 pnpm |
| `node -e` 解析目录 | `MODULE_NOT_FOUND` | `cd` 到 profile 目录或写完整路径 |
| 对照文档猜测 | 协议细节错误（TurnId vs traceparent） | **实测真实账号** |

---

## 7. 最终验证清单

### 安装前

- [ ] Loomy 桌面 App 已登录（session token 在 `auth-session.json`）
- [ ] DSH profile 有 `file:` 依赖声明（package.json `dependencies`）
- [ ] plugin package.json 有 `dsh.bundle.patch` 字段
- [ ] plugin package.json 有 `exports./cordis.patch.yml`
- [ ] plugin `cordis.patch.yml` 有 `insert:` 包装

### 安装后

- [ ] `node_modules\loomy-to-dsh` 存在，文件数一致
- [ ] `node_modules\loomy-to-dsh\package.json` 有 `dsh` 字段
- [ ] `node_modules\@earendil-works\pi-ai\package.json` 存在（1.3.0）
- [ ] `node_modules\@deepseek-ai\schemastery\package.json` 存在
- [ ] 其他插件未丢失（workbuddy / bobcfc / cockpit 等都在）

### 重启后

- [ ] 模型选择器出现「Loomy」分组
- [ ] 能选到 DeepSeek-V4.1-Flash / Kimi-k2.6 / GLM-5.3-Flash 等
- [ ] 选一个模型能完成对话（流式/非流式）
- [ ] 状态路由 `/loomy-to-dsh/status` 返回 200 JSON

---

## 8. 恢复命令（万一被 pnpm 搞坏了）

```powershell
$nm = "C:\Users\12973\.dsh\profiles\desktop\node_modules"

# bobcfc
robocopy "D:\0data\0dsh\bobcfcAgents\plugin" "$nm\dsh-bobcfc-agents" /MIR /NFL /NDL /NJH /NJS /NP

# loomy
robocopy "D:\0data\0dsh\loomy-to-dsh" "$nm\loomy-to-dsh" /MIR /XD research /XF diag.mjs /NFL /NDL /NJH /NJS /NP

# 验证
Get-ChildItem $nm | Where-Object { $_.Name -in 'dsh-bobcfc-agents','loomy-to-dsh','dsh-workbuddy-connect' } | Select-Object Name
```

**备份位置**：`C:\Users\12973\.dsh\profiles\desktop\.backup-loomy-20261021-162104\`

---

## 9. 关键文件清单

| 文件 | 作用 | 参考来源 |
|---|---|---|
| `package.json` | 包元数据 + `dsh.bundle.patch` | workbuddy / dsh-browser |
| `cordis.patch.yml` | 注册插件 id 到 cordis | workbuddy / cockpit |
| `index.js` | 插件入口（name / inject / apply） | workbuddy 编译产物 |
| `adapter.js` | pi-ai provider + PiAiAdapter | workbuddy lib/index.js |
| `shim.js` | 回环 OpenAI 兼容端点 | 自写（参考 loopback 模式） |
| `upstream.js` | loomyad 客户端（头构造/错误分类） | 自写（协议实测） |
| `catalog.js` | 模型目录解析 | 自写（GET /models 响应） |
| `session.js` | auth-session.json 读取 | 自写（文件路径发现） |
| `visibility.js` | 模型显隐 store | 自写（按账号存储） |
| `status-route.js` | 同源 GET 状态路由 | 自写（webServer 模式） |

---

## 10. 后续优化方向

1. **图片输入**：支持 image 模态的模型（DeepSeek-V4.1-Flash 等）
2. **Reasoning 档位**：把 `reasoning_efforts: ["none","low","medium","high","xhigh"]` 映射到 UI
3. **流式优化**：SSE 转发性能（当前用 `Readable.fromWeb`，可以改直通流）
4. **错误提示**：401 / 429 / 429 时给用户更友好的提示
5. **日志**：把 shim 错误、upstream 错误写进 DSH 日志（`ctx.logger`）

---

**总结**：DSH 插件开发的坑不在代码，而在**包结构**（package.json 的 `dsh` 字段）、**依赖管理**（peer vs dependency）和**安装方式**（pnpm 会丢 file: 依赖）。协议层务必实测，不要信文档。
