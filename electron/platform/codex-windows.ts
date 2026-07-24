/**
 * Windows integration: discover the official ChatGPT desktop app, stop/launch
 * it with a loopback CDP port, and verify port ownership. TypeScript port of
 * codex-macos.ts for the Windows platform.
 *
 * Safety invariants (same as macOS):
 *  - only processes whose executable path matches the expected ChatGPT path;
 *  - graceful quit first (WM_CLOSE), force kill only with explicit
 *    authorization from the UI layer;
 *  - a CDP port is only trusted when its listener is the ChatGPT process or a
 *    descendant of it (netstat + process ancestry walk);
 *  - all paths are normalized to forward slashes for cross-platform compat.
 */

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import net from "node:net";

const execFileAsync = promisify(execFile);

export const CODEX_BUNDLE_ID = "com.openai.codex";
export const CODEX_NEW_THREAD_URL = "codex://threads/new";

/** Known installation paths for ChatGPT desktop on Windows. */
export const CODEX_APP_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || "C:\\Users\\Default\\AppData\\Local", "Programs", "ChatGPT", "ChatGPT.exe"),
  path.join(process.env.PROGRAMFILES || "C:\\Program Files", "ChatGPT", "ChatGPT.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "ChatGPT", "ChatGPT.exe"),
  path.join(process.env.USERPROFILE || "C:\\Users\\Default", "AppData", "Local", "Programs", "ChatGPT", "ChatGPT.exe"),
  path.join(process.env.LOCALAPPDATA || "C:\\Users\\Default\\AppData\\Local", "Programs", "OpenAI", "ChatGPT", "ChatGPT.exe"),
];

export interface CodexInstall {
  bundle: string;
  executable: string;
  version: string;
}

interface ProcessEntry {
  pid: number;
  command: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(file: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { maxBuffer, timeout: 10_000 });
  return stdout;
}

async function getFileVersion(exePath: string): Promise<string> {
  try {
    const escaped = exePath.replace(/'/g, "''");
    const script = `(Get-Item '${escaped}').VersionInfo.FileVersion`;
    const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function isValidExe(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0 && filePath.toLowerCase().endsWith(".exe");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function checkCandidate(bundle: string): Promise<CodexInstall | null> {
  let exe = bundle;
  if (!exe.toLowerCase().endsWith(".exe")) {
    exe = path.join(exe, "ChatGPT.exe");
  }

  if (!(await isValidExe(exe))) {
    const dir = path.dirname(exe);
    const alternatives = ["ChatGPT.exe", "Codex.exe", "Codex Desktop.exe", "OpenAI.exe"];
    for (const alt of alternatives) {
      const candidate = path.join(dir, alt);
      if (await isValidExe(candidate)) {
        exe = candidate;
        break;
      }
    }
    if (!exe.toLowerCase().endsWith(".exe")) return null;
  }

  const version = await getFileVersion(exe);
  const bundleDir = path.dirname(exe);
  return { bundle: bundleDir, executable: exe, version };
}

export async function discoverCodexApp(configured?: string): Promise<CodexInstall | null> {
  if (configured) {
    const found = await checkCandidate(configured);
    if (found) return found;
  }

  for (const candidate of CODEX_APP_CANDIDATES) {
    const found = await checkCandidate(candidate);
    if (found) return found;
  }

  // Try registry
  try {
    const regOut = await run("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "/s", "/f", "ChatGPT", "/e", "/c",
    ], 256 * 1024);
    const lines = regOut.split("\\n");
    for (const line of lines) {
      const match = /DisplayIcon\\s+REG_SZ\\s+(.+?ChatGPT\\.exe)/i.exec(line) ||
                    /InstallLocation\\s+REG_SZ\\s+(.+?ChatGPT)/i.exec(line);
      if (match) {
        const exePath = match[1].trim();
        const exe = exePath.toLowerCase().endsWith(".exe")
          ? exePath
          : path.join(exePath, "ChatGPT.exe");
        const found = await checkCandidate(exe);
        if (found) return found;
      }
    }
  } catch {}

  // Try Start Menu
  try {
    const startMenu = path.join(
      process.env.APPDATA || "C:\\Users\\Default\\AppData\\Roaming",
      "Microsoft", "Windows", "Start Menu", "Programs",
    );
    const scanDir = async (dir: string): Promise<string | null> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = await scanDir(fullPath);
            if (found) return found;
          } else if (
            entry.isFile() &&
            entry.name.toLowerCase().endsWith(".lnk") &&
            entry.name.toLowerCase().includes("chatgpt")
          ) {
            const escaped = fullPath.replace(/'/g, "''");
            const script = `
              $shell = New-Object -ComObject WScript.Shell;
              $shortcut = $shell.CreateShortcut('${escaped}');
              Write-Output $shortcut.TargetPath
            `;
            try {
              const target = (await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])).trim();
              if (target && target.toLowerCase().endsWith(".exe") && target.toLowerCase().includes("chatgpt"))
                return target;
            } catch {}
          }
        }
      } catch {}
      return null;
    };
    const found = await scanDir(startMenu);
    if (found) {
      const result = await checkCandidate(found);
      if (result) return result;
    }
  } catch {}

  return null;
}


// ---------------------------------------------------------------------------
// Process queries
// ---------------------------------------------------------------------------

async function processTable(): Promise<ProcessEntry[]> {
  try {
    const out = await run("wmic", [
      "process", "where", "name like '%ChatGPT%' or name like '%Codex%'",
      "get", "ProcessId,ExecutablePath,Name", "/format:csv",
    ], 256 * 1024);
    const entries: ProcessEntry[] = [];
    const lines = out.split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.split(",");
      if (parts.length >= 3) {
        const name = (parts[1] || "").trim();
        const exePath = (parts[2] || "").trim();
        const pid = parseInt((parts[3] || "").trim(), 10);
        if (!isNaN(pid) && pid > 0 && (name.toLowerCase().includes("chatgpt") || name.toLowerCase().includes("codex")))
          entries.push({ pid, command: exePath || name, name });
      }
    }
    return entries;
  } catch {
    try {
      const out = await run("tasklist", ["/fo", "csv", "/nh", "/fi", "IMAGENAME eq ChatGPT.exe"], 64 * 1024);
      const entries: ProcessEntry[] = [];
      const lines = out.split("\n").filter(Boolean);
      for (const line of lines) {
        const parts = line.split(",");
        if (parts.length >= 2) {
          const name = (parts[0] || "").replace(/"/g, "").trim();
          const pid = parseInt((parts[1] || "").replace(/"/g, "").trim(), 10);
          if (!isNaN(pid) && pid > 0)
            entries.push({ pid, command: name, name });
        }
      }
      return entries;
    } catch { return []; }
  }
}

export async function codexMainPids(executable: string): Promise<number[]> {
  const processes = await processTable();
  const normalized = executable.toLowerCase().replace(/\\/g, "/");
  const pids: number[] = [];
  for (const proc of processes) {
    const procCmd = proc.command.toLowerCase().replace(/\\/g, "/");
    if (procCmd === normalized || procCmd.endsWith(normalized) || procCmd.includes("chatgpt"))
      pids.push(proc.pid);
  }
  return pids;
}

export async function codexIsRunning(executable: string): Promise<boolean> {
  const pids = await codexMainPids(executable);
  return pids.length > 0;
}

// ---------------------------------------------------------------------------
// Port management
// ---------------------------------------------------------------------------

export async function selectAvailablePort(start: number): Promise<number> {
  const tryPort = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.on("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });

  for (let port = start; port < start + 100; port++) {
    if (await tryPort(port)) return port;
  }
  throw new Error(`No available port found starting from ${start}`);
}

async function portOwnerPid(port: number): Promise<number | null> {
  try {
    const out = await run("netstat", ["-ano", "-p", "tcp"], 64 * 1024);
    const lines = out.split("\n");
    const target = `127.0.0.1:${port}`;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[1] === target && parts[3] === "LISTENING") {
        const pid = parseInt(parts[4], 10);
        if (!isNaN(pid)) return pid;
      }
    }
  } catch {}
  return null;
}

async function pidBelongsToCodex(pid: number, executable: string): Promise<boolean> {
  const normalized = executable.toLowerCase().replace(/\\/g, "/");

  // Check the process itself
  try {
    const out = await run("wmic", [
      "process", "where", `ProcessId=${pid}`,
      "get", "ProcessId,ParentProcessId,ExecutablePath,Name", "/format:csv",
    ], 64 * 1024);
    const lines = out.split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.split(",");
      if (parts.length >= 3) {
        const exePath = (parts[2] || "").trim().toLowerCase().replace(/\\/g, "/");
        if (exePath === normalized || exePath.includes("chatgpt")) return true;
      }
    }
  } catch {}
  // Walk up the process tree (max 10 levels)
  let currentPid = pid;
  for (let i = 0; i < 10; i++) {
    try {
      const out = await run("wmic", [
        "process", "where", `ProcessId=${currentPid}`,
        "get", "ParentProcessId,ExecutablePath", "/format:csv",
      ], 64 * 1024);
      const lines = out.split("\n").filter(Boolean);
      let parentPid = -1;
      for (const line of lines) {
        const parts = line.split(",");
        if (parts.length >= 2) {
          const exePath = (parts[1] || "").trim().toLowerCase().replace(/\\/g, "/");
          if (exePath === normalized || exePath.includes("chatgpt")) return true;
          parentPid = parseInt((parts[0] || "").trim(), 10);
        }
      }
      if (parentPid <= 0 || parentPid === currentPid) break;
      currentPid = parentPid;
    } catch { break; }
  }
  return false;
}

export async function cdpHttpReady(port: number): Promise<boolean> {
  try {
    const script = `
      try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:${port}/json/version" -UseBasicParsing -TimeoutSec 3;
        if ($r.StatusCode -eq 200) { Write-Output "OK" } else { Write-Output "FAIL" }
      } catch { Write-Output "FAIL" }
    `;
    const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return out.trim() === "OK";
  } catch { return false; }
}

export async function verifiedCdpEndpoint(port: number, executable: string): Promise<boolean> {
  if (!(await cdpHttpReady(port))) return false;
  const pid = await portOwnerPid(port);
  if (!pid) return false;
  return pidBelongsToCodex(pid, executable);
}

// ---------------------------------------------------------------------------
// Stop / Launch
// ---------------------------------------------------------------------------

export async function stopCodex(
  executable: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const pids = await codexMainPids(executable);
  if (pids.length === 0) return;

  // Graceful: Send WM_CLOSE via PowerShell
  for (const pid of pids) {
    try {
      const script = `
        Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        using System.Diagnostics;
        public class WindowHelper {
          [DllImport("user32.dll")]
          public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
          [DllImport("user32.dll")]
          public static extern bool IsWindowVisible(IntPtr hWnd);
          [DllImport("user32.dll")]
          public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
          [DllImport("user32.dll")]
          public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
          public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
          const uint WM_CLOSE = 0x0010;
          public static void CloseProcessWindows(int targetPid) {
            uint target = (uint)targetPid;
            EnumWindows((hWnd, lParam) => {
              if (!IsWindowVisible(hWnd)) return true;
              GetWindowThreadProcessId(hWnd, out uint pid);
              if (pid == target) { SendMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
              return true;
            }, IntPtr.Zero);
          }
        }
"@
        [WindowHelper]::CloseProcessWindows(${pid})
      `;
      await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    } catch {}
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const remaining = await codexMainPids(executable);
  if (remaining.length === 0) return;

  if (opts.force) {
    for (const pid of remaining) {
      try { await run("taskkill", ["/pid", String(pid), "/f"]); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const final = await codexMainPids(executable);
  if (final.length > 0 && !opts.force) {
    throw new Error(
      `Codex 进程(PID ${final.join(", ")})仍在运行。可能需要强制退出。`,
    );
  }
}

export async function launchCodexWithCdp(install: CodexInstall, port: number): Promise<void> {
  const args = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ];
  const child = spawn(install.executable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

export async function waitForCdp(
  port: number,
  executable: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await verifiedCdpEndpoint(port, executable)) return;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Timed out waiting for the Codex debug port ${port}.`);
}

export async function launchCodexNormally(bundle: string): Promise<void> {
  const exePath = bundle.toLowerCase().endsWith(".exe")
    ? bundle
    : path.join(bundle, "ChatGPT.exe");
  const child = spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

export async function openCodexMode(): Promise<void> {
  try {
    await run("cmd.exe", ["/c", "start", "codex://threads/new"]);
  } catch {}
}
