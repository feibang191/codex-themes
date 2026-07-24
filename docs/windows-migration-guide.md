# controller.ts 修改指南

## 需要改的地方

文件：`electron/controller.ts`

### 第 1 处：修改 import

把：
```typescript
import {
  codexIsRunning,
  discoverCodexApp,
  launchCodexNormally,
  launchCodexWithCdp,
  openCodexMode,
  selectAvailablePort,
  stopCodex,
  verifiedCdpEndpoint,
  waitForCdp,
  type CodexInstall,
} from "./platform/codex-macos";
```

改成：
```typescript
import os from "node:os";

// 根据平台加载不同的平台模块
const platform = os.platform() === "win32" ? "win32" : "darwin";

let platformModule: typeof import("./platform/codex-macos");
if (platform === "win32") {
  platformModule = await import("./platform/codex-windows");
} else {
  platformModule = await import("./platform/codex-macos");
}

const {
  codexIsRunning,
  discoverCodexApp,
  launchCodexNormally,
  launchCodexWithCdp,
  openCodexMode,
  selectAvailablePort,
  stopCodex,
  verifiedCdpEndpoint,
  waitForCdp,
  CodexInstall,
} = platformModule;
```

**注意**：由于 `import()` 是异步的，需要把 `controller.ts` 顶层的常量初始化改为 `init()` 方法内完成。

### 更好的方案（推荐）：统一导出层

创建一个 `electron/platform/index.ts`：

```typescript
import os from "node:os";
import type { CodexInstall } from "./codex-windows";

// 统一导出类型
export type { CodexInstall };

// 运行时决定加载哪个平台
const platform = os.platform() === "win32" ? "win32" : "darwin";

// 导出所有平台函数
export const discoverCodexApp: (configured?: string) => Promise<CodexInstall | null>
  = platform === "win32"
    ? (await import("./codex-windows")).discoverCodexApp
    : (await import("./codex-macos")).discoverCodexApp;

export const codexIsRunning: (executable: string) => Promise<boolean>
  = platform === "win32"
    ? (await import("./codex-windows")).codexIsRunning
    : (await import("./codex-macos")).codexIsRunning;

// ... 每个函数都这样导出
```

这样 `controller.ts` 只需要 import `./platform/index` 即可，不需要改任何业务代码。
