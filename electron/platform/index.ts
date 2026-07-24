/**
 * Platform adapter — re-exports the correct platform module based on OS.
 * 
 * controller.ts imports from this file instead of codex-macos directly,
 * and gets the right implementation for macOS or Windows automatically.
 */
import os from "node:os";

const isWin = os.platform() === "win32";

// Re-export types (same interface on both platforms)
export type { CodexInstall } from "./codex-windows";

// Re-export values — top-level await picks the right module at load time
const mod = isWin
  ? await import("./codex-windows")
  : await import("./codex-macos");

export const {
  codexIsRunning,
  discoverCodexApp,
  launchCodexNormally,
  launchCodexWithCdp,
  openCodexMode,
  selectAvailablePort,
  stopCodex,
  verifiedCdpEndpoint,
  waitForCdp,
  codexMainPids,
  cdpHttpReady,
} = mod;
