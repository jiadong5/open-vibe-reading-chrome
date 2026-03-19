# Open Vibe Reading Chrome Extension

一个基于 Chrome Side Panel 的网页阅读助手。

## 功能

- 侧边栏 AI Chat（读取当前网页正文 + 标注上下文）
- 网页文本选中后快速标注、高亮与定位
- 标注笔记持久化存储（`chrome.storage.local`）
- 支持 Markdown 渲染（代码块、表格、公式）
- 支持自定义 OpenAI 兼容配置：
  - `API Key`
  - `Base URL`
  - `Chat Model`
  - `Summary Model`

## 项目结构

- `manifest.json`：扩展配置（MV3）
- `background.js`：API 请求与侧边栏后台通信
- `content.js`：网页注入逻辑（选区、标注、高亮、定位、章节/公式交互）
- `sidepanel.html/js/css`：侧边栏 UI 与对话逻辑
- `vendor/katex.min.js`：公式渲染依赖

## 本地加载

1. 打开 Chrome：`chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择目录：
   - `open-vibe-reading/web-vibe-reading-extension`

## 配置

在侧边栏“配置”中填写：

- API Key
- Base URL（默认 `https://api.openai.com/v1`）
- Chat Model（默认 `gpt-4o-mini`）
- Summary Model（可与 Chat Model 不同）

## 数据与隐私

- API Key 仅保存在本地 `chrome.storage.local`。
- 标注与会话仅保存在本地浏览器存储。
- 项目不内置任何固定密钥或远程跟踪脚本。

## 开源发布（GitHub）

```bash
cd /Users/jiadong5/Desktop/open-vibe-reading/web-vibe-reading-extension

# 首次初始化（如未初始化）
git init
git add .
git commit -m "chore: open-source release"

# 替换为你刚创建的 GitHub 仓库地址
git branch -M main
git remote add origin https://github.com/<your_name>/open-vibe-reading-extension.git
git push -u origin main
```

## 许可证

MIT，见 [LICENSE](./LICENSE)。
