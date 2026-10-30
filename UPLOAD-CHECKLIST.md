# GitHub 上传前检查清单

## ✅ 已完成项

### 核心文件
- [x] `package.json` - 包含 `dsh.bundle.patch` 字段
- [x] `cordis.patch.yml` - 正确格式（`insert:` 包装）
- [x] `index.js` - 插件入口
- [x] `adapter.js` - pi-ai provider 适配器
- [x] `shim.js` - 回环 OpenAI 兼容端点
- [x] `upstream.js` - loomyad 客户端
- [x] `catalog.js` - 模型目录解析
- [x] `session.js` - session 发现与读取
- [x] `visibility.js` - 模型显隐管理
- [x] `status-route.js` - 状态路由
- [x] `loopback.js` - 回环网关工具
- [x] `version.js` - 版本常量

### 测试
- [x] `test/catalog.test.mjs` - 目录解析测试
- [x] `test/session.test.mjs` - session 解析测试
- [x] `test/upstream.test.mjs` - 头构造与错误分类测试
- [x] `test/loopback.test.mjs` - 回环网关测试
- [x] `test/integration.test.mjs` - 集成测试（需真实账号）
- [x] 27 项单元测试全部通过

### 文档
- [x] `README.md` - 完整的安装与使用文档
- [x] `LICENSE` - MIT 许可证
- [x] `INSTALLATION-GUIDE.md` - 安装调试经验文档

### 配置
- [x] `.gitignore` - 忽略 node_modules、临时文件、日志
- [x] `.github/workflows/ci.yml` - GitHub Actions CI 配置

### 代码质量
- [x] 所有源文件通过 `node --check` 语法检查
- [x] 无 `console.log` 残留
- [x] 无硬编码路径（session token 从文件读取）
- [x] 无硬编码 session 令牌
- [x] 文件头注释完整（JSDoc 风格）

### 清理
- [x] 无 `.pnpm-*` 临时目录
- [x] 无 `diag.mjs` 调试脚本
- [x] 无 `research/` 研究目录
- [x] 无 `.pnpm-full.log` 日志

---

## 📦 上传步骤

### 1. 初始化 Git 仓库

```bash
cd D:\<你的路径>\0dsh\loomy-to-dsh
git init
git add .
git commit -m "Initial release: loomy-to-dsh v0.1.0

- Bring Loomy desktop app models into DeepSeek Harness
- Zero-config: reuses Loomy's on-disk session token
- Supports streaming, tool calls, image input, reasoning levels
- 27 unit tests + 3 integration tests (all passing)
- MIT licensed"
```

### 2. 创建 GitHub 仓库

访问 https://github.com/new 创建新仓库：
- **Repository name**: `loomy-to-dsh`
- **Description**: Bring Loomy desktop app models into DeepSeek Harness
- **Public**: 推荐公开（便于其他用户使用）
- **License**: MIT（已在 LICENSE 文件）
- **Add .gitignore**: 选择 `Node`

### 3. 推送代码

```bash
git remote add origin https://github.com/<你的用户名>/loomy-to-dsh.git
git branch -M main
git push -u origin main
```

### 4. 验证 CI

推送后访问：`https://github.com/<你的用户名>/loomy-to-dsh/actions`

预期结果：
- ✅ Node.js 22.x 测试通过
- ✅ Node.js 24.x 测试通过
- ✅ 语法检查通过
- ⚠️ Lint 检查可能有警告（非阻塞）

---

## 🏷️ 发布到 npm（可选）

如果你想让其他用户通过 `npm install` 安装（而不仅仅是 `file:` 依赖）：

### 1. 发布前检查

```bash
npm pack  # 生成 tarball，检查内容
# 预期：只包含 index.js, adapter.js, ..., test/, README.md, LICENSE
# 不应包含：node_modules, .github, .pnpm-*, diag.mjs
```

### 2. 发布

```bash
npm login
npm publish --access public
```

**注意**：
- npm 发布后，用户可以通过 `"loomy-to-dsh": "^0.1.0"` 安装
- 但 **peer 依赖（`@deepseek-ai/dsh-llm` 等）仍需宿主提供**
- 需要在 README 里说明：peer 依赖由 DSH profile 提供

### 3. 版本管理

遵循语义化版本：
- **0.1.0** → 初始版本（当前）
- **0.1.1** → 修复 bug
- **0.2.0** → 新增功能（如图片输入优化）
- **1.0.0** → 稳定版本（推荐）

---

## 📋 后续更新

### 代码改动后

1. 运行测试：`npm test`
2. 语法检查：`node --check *.js`
3. 更新 `version.js` 中的版本号
4. 更新 `package.json` 的 `version` 字段
5. 提交并推送

### 发布新版本

```bash
# 1. 更新版本号
npm version patch  # 0.1.0 → 0.1.1
# 或
npm version minor  # 0.1.0 → 0.2.0
# 或
npm version major  # 0.1.0 → 1.0.0

# 2. 推送 tag
git push origin --tags

# 3. 发布到 npm（可选）
npm publish
```

---

## 🔒 安全注意事项

### 不要包含的内容

- [x] ~~硬编码的 session 令牌~~ ✅ 已确认无
- [x] ~~用户的 Loomy 路径~~ ✅ 只读取，不硬编码
- [x] ~~调试日志~~ ✅ 已清理
- [x] ~~临时文件~~ ✅ 已清理

### 运行时安全

- session 令牌从文件读取，不上传
- 状态路由只暴露掩码（`f226…8c2`）
- 回环代理仅监听 `127.0.0.1`
- 共享密钥随机生成，不硬编码

---

## 📊 项目统计

```
源码文件:    10 个 (75,899 bytes)
测试文件:     5 个 (16,967 bytes)
文档:         3 个 (README + LICENSE + INSTALLATION-GUIDE)
测试通过率:   100% (27/27 单元测试)
代码行数:     ~1,500 行 (含注释)
```

---

## ✅ 最终确认

在执行 `git push` 前，再次确认：

- [x] 所有测试通过（`npm test`）
- [x] 语法检查通过（`node --check *.js`）
- [x] 无敏感信息（`grep -rn "C:\\\\" *.js`）
- [x] `.gitignore` 包含 `node_modules/`
- [x] `package.json` 有 `dsh.bundle.patch`
- [x] `cordis.patch.yml` 格式正确
- [x] `README.md` 完整
- [x] `LICENSE` 存在

**准备上传 🎉**
