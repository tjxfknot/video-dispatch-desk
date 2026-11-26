# 视频发布台（Video Dispatch Desk）

一款运行在本地的跨平台短视频多账号发布桌面应用（基于 Electron + Playwright），专注于**抖音、微信视频号、小红书**三个平台的本地化批量编排、专属浏览器多账号隔离、一次总览确认自动发布与官方回执核查。

所有账号登录态、草稿与发布记录均保存在用户本机，**不上传第三方服务器、不导出 Cookie、不依赖大模型 API 或外挂脚本**。

---

## 支持平台与能力矩阵

| 平台 | 专属浏览器账号隔离 | 封面设置 | 文案与话题 | 自主/内容声明 | 定时发布（北京时间） | 官方作品接口回执核查 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **抖音** | 支持 | 横 + 竖双封面 / 视频默认 | 原生话题回读 | 已核对 5 项原文 | 2 小时后 ～ 14 天内 | 支持（含可见范围/审核状态） |
| **微信视频号** | 支持 | 竖版封面 / 视频默认 | 标题进描述 + 话题 | 已核对 5 项原文 | 5 分钟后 ～ 30 天内 | 支持（含原创拦截弹窗处理） |
| **小红书** | 支持 | 竖版封面 / 视频默认 | 话题候选精确匹配 | 已核对 3 项原文 | 1 小时后 ～ 14 天内 | 支持（自动等待入库刷新） |

### 核心设计原则
- **多账号专属浏览器隔离**：每个创作者的每个平台账号独立分配一个本机 Chromium 用户目录（自动调用系统已安装的 Google Chrome 或 Microsoft Edge），绝不读取日常浏览器的 Cookie 或历史记录，杜绝串号发错。
- **发布前严格核验与防重发**：每次提交前强制重新校验当前窗口登录身份、本地素材文件指纹与页面回读结果；任一必填项、封面像素、定时时间或账号身份不匹配即刻中止，绝不猜测或自动重发。
- **单次点击保护与官方回执**：提交动作采用持久化单次许可协议，提交后只读查询平台作品管理接口获取唯一作品编号与链接；若暂时无法确认，明确标记为「结果待核查」而非冒充成功。
- **支持本地演练**：可在不登录、不上传的前提下完成任务校验与本地演练，导出脱敏 JSON 报告。

---

## 系统支持与验证说明

- **macOS（Apple Silicon / arm64）**：已完成抖音、视频号、小红书三平台的真实隔离环境实发与官方接口自动回执闭环验证。
- **Windows（x64）**：源码已针对 Windows 完成浏览器自动发现（Google Chrome / 系统自带 Microsoft Edge）、原子写盘防文件锁重试、路径与权限兼容处理，并通过 GitHub Actions 在真实 `windows-latest` 运行机上完成全量离线自动化测试与原生打包。**需如实说明**：Windows 版本尚未在本地 Windows 真机完成三平台实发验收，当前作为 Windows 首个兼容版本提供下载，欢迎反馈真机使用问题。

---

## 下载与运行（普通用户）

前往本仓库的 **[Releases](https://github.com/tjxfknot/video-dispatch-desk/releases)** 页面下载对应系统的免安装压缩包。运行前请确保电脑已安装 **Google Chrome** 或 **Microsoft Edge**（Windows 10/11 通常已自带 Edge）。

### macOS（Apple Silicon M 系列芯片）
1. 下载 `video-dispatch-desk-<版本>-mac-arm64.zip` 并解压，将 `视频发布台.app` 拖入「应用程序」文件夹。
2. 由于当前开源构建未购买 Apple 开发者证书签名/公证，首次双击打开若提示“已损坏”或“无法验证开发者”，请在终端执行一次解除隔离属性后重新打开：
   ```bash
   xattr -cr /Applications/视频发布台.app
   ```
3. 也可以选择「右键 → 打开」绕过首次拦截。

### Windows（64 位）
1. 下载 `video-dispatch-desk-<版本>-win-x64.zip`，完整解压到任意非临时目录（例如 `D:\Tools\video-dispatch-desk\`）。
2. 双击目录中的 `视频发布台.exe` 启动。
3. 由于当前开源构建未做商业代码签名，首次运行若触发 Windows Defender SmartScreen 提示，点击「更多信息 → 仍要运行」即可。

### 基本使用流程
1. **添加创作者与账号**：进入「账号与模板」→ 新建创作者、勾选默认平台并保存。
2. **专属窗口登录绑定**：在对应平台账号卡片点击用 Chrome / Edge 打开官方窗口，在官方页面完成扫码登录，回到工作台确认绑定账号标识。
3. **创建任务与发布**：进入「新建发布」→ 选择创作者、本地视频、封面、文案、话题、声明与发布时间 → 点击「发布到所选平台」进入总览核对 → 确认后程序自动完成上传、填写、提交与回执核查。

---

## 源码运行、测试与二次开发（开发者）

### 环境要求
- Node.js 20+（推荐 Node.js 22 LTS）
- npm 10+
- 本机已安装 Google Chrome 或 Microsoft Edge（用于运行含本地合成网页的 Playwright 离线测试与实际桌面运行）

### 常用命令
```bash
# 1. 克隆仓库并安装依赖
git clone https://github.com/tjxfknot/video-dispatch-desk.git
cd video-dispatch-desk
npm ci

# 2. 运行全量离线自动化测试（外部网络请求全部被拦截，仅本地合成页面验证）
npm test

# 3. 本地开发模式启动桌面应用
npm start

# 4. 打包免安装压缩包
npm run dist:mac    # 在 macOS 上产出 dist/video-dispatch-desk-*-mac-arm64.zip
npm run dist:win    # 在 Windows 上产出 dist/video-dispatch-desk-*-win-x64.zip
```

### 目录结构速览（方便二次修改）
```text
app/
├── main.cjs                          # Electron 主进程：窗口管理、IPC、本地数据与协议处理
├── preload.cjs                       # 安全预加载桥（contextIsolation + sandbox）
├── assets/                           # 应用图标（icns / ico / png）
├── core/                             # 核心业务逻辑（与 Electron 解耦，可独立 Node 测试）
│   ├── domain.cjs                    # 平台定义、草稿归一化、任务校验、报告导出
│   ├── accounts.cjs                  # 创作者、账号、专属浏览器环境数据模型
│   ├── store.cjs                     # 原子持久化 JSON 存储（含 Windows 防文件锁重试）
│   ├── connection-vault.cjs          # 系统级安全存储加密封装
│   ├── browser-platforms.cjs         # 三平台域名白名单与首页身份解析规则
│   ├── browser-self-identity.cjs     # 页面内被动观测官方用户信息接口（小红书等）
│   ├── browser-driver.cjs            # Chromium 专属配置目录启动与页面驱动
│   ├── managed-browser.cjs           # 多账号浏览器生命周期与登录态复查
│   ├── managed-publish-job.cjs       # 任务快照构建、素材指纹与单次提交约束
│   ├── managed-publisher.cjs         # 任务状态机、并发锁与防重发保护
│   ├── managed-receipt.cjs           # 平台作品链接与编号格式校验
│   ├── douyin-publish-driver.cjs     # 抖音原生控件驱动（上传/双封面/话题/定时/回执）
│   ├── native-publish-driver.cjs     # 视频号与小红书原生控件驱动
│   ├── douyin-work-list.cjs          # 抖音作品列表官方接口被动观测与匹配
│   ├── tencent-post-list.cjs         # 视频号作品列表官方接口被动观测与匹配
│   ├── xiaohongshu-note-list.cjs     # 小红书笔记列表官方接口被动观测与匹配
│   ├── publish-schedule.cjs          # 各平台北京时间定时窗口与边界校验
│   ├── publish-settings.cjs          # 共同声明、平台声明映射与定位规则
│   └── publish-location-driver.cjs   # 平台定位控件清理与设置驱动
└── renderer/                         # 桌面端界面（原生 HTML/CSS/JS，无前端构建步骤）
    ├── index.html
    ├── styles.css
    ├── app.js
    └── *-ui.js / publish-*.js
tests/                                # 基于 node:test 的全量离线测试与合成夹具
.github/workflows/                    # CI 离线测试（Mac + Win）与 Tag 自动发版工作流
```

### 二次修改常见入口
- **适配平台网页改版**：
  - 抖音表单与回执逻辑在 `app/core/douyin-publish-driver.cjs` 与 `app/core/douyin-work-list.cjs`；
  - 视频号与小红书控件逻辑在 `app/core/native-publish-driver.cjs`、`app/core/tencent-post-list.cjs`、`app/core/xiaohongshu-note-list.cjs`；
  - 修改选择器后请务必补充或运行 `npm test` 验证离线合成页面回归。
- **调整平台声明文案或定时范围**：分别修改 `app/core/publish-settings.cjs` 与 `app/core/publish-schedule.cjs`。
- **隔离调试数据目录**：启动时传入 `--test-data-dir <目录路径>` 即可使用独立数据目录，不影响正常本地库：
  ```bash
  npx electron . --test-data-dir /tmp/vdd-dev-data
  ```

---

## 本机数据存储位置

应用的所有本地数据默认存放在系统应用数据目录下的 `分发台` 文件夹：
- **macOS**：`~/Library/Application Support/分发台/`
- **Windows**：`%APPDATA%\分发台\`

包含：
- `library.json`：创作者、账号备注、模板、草稿与发布记录
- `browser-profiles/<env-uuid>/`：各账号独立的浏览器用户数据目录（登录态保留在浏览器自身目录内）
- `live-diagnostics/`：仅在发布或回执核查异常时记录的页面结构诊断（不含 Cookie、密钥或正文敏感内容）

---

## 免责声明与开源协议

- 本项目仅供创作者个人合规管理自有账号与本地视频发布效率提升使用。使用过程中请严格遵守抖音、微信视频号、小红书等各平台的官方服务条款与内容规范；任何账号操作均需由使用者本人登录并明确确认。
- 本项目采用 **[MIT License](./LICENSE)** 开源协议，作者：`tjxf`。
