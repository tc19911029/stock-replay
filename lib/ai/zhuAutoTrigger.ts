/**
 * 朱老師 Terminal 自動觸發 — 用 macOS osascript 模擬按鍵注入 /zhu
 *
 * 找有 claude 在跑的 tab 順序：
 *   1. tab 名稱含 "Zhu"（用戶有設標題）
 *   2. tab 名稱含 "claude"（claude 跑起來時 tab 自動顯示）
 *   3. tab 名稱含 "node"（claude 是 node 腳本，預設 fallback）
 *   4. 找不到 → ERROR
 *
 * 依序試 Terminal.app → iTerm。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APPLESCRIPT = `
on matchesZhu(s)
  -- 先看有沒有 "Zhu"（最精確）
  if s contains "Zhu" then return 1
  -- 再看 "claude" / "node"（claude 跑起來時的 tab 預設名稱）
  if s contains "claude" then return 2
  if s contains "node" then return 3
  return 0
end matchesZhu

set prevApp to missing value
try
  tell application "System Events"
    set prevApp to name of first application process whose frontmost is true
  end tell
end try

set bestPriority to 999
set foundIn to ""

-- ── Terminal.app ────────────────────────────────────────────────
try
  tell application "System Events"
    if exists process "Terminal" then
      tell application "Terminal"
        repeat with w in windows
          try
            -- 先看視窗 title 含不含 claude/Zhu/node（用戶截圖 title 有 claude 字樣）
            set wName to ""
            try
              set wName to name of w
            end try
            set wp to my matchesZhu(wName)

            repeat with t in tabs of w
              try
                set tName to ""
                set ctName to ""
                try
                  set tName to name of t
                end try
                try
                  set ctName to custom title of t
                end try
                -- 取最佳優先級（tab 名 / custom title / 視窗 title 任一匹配）
                set p1 to my matchesZhu(tName)
                set p2 to my matchesZhu(ctName)
                set p to wp
                if p1 > 0 and (p is 0 or p1 < p) then set p to p1
                if p2 > 0 and (p is 0 or p2 < p) then set p to p2
                if p > 0 and p < bestPriority then
                  set bestPriority to p
                  set foundIn to "Terminal"
                  set selected of t to true
                  set frontmost of w to true
                end if
              end try
            end repeat
          end try
        end repeat
        if foundIn is "Terminal" then activate
      end tell
    end if
  end tell
end try

-- ── iTerm（若 Terminal 沒找到才試）────────────────────────────────
if foundIn is "" then
  try
    tell application "System Events"
      if exists process "iTerm2" then
        tell application "iTerm"
          repeat with w in windows
            try
              repeat with t in tabs of w
                try
                  set sessionName to ""
                  try
                    set sessionName to name of current session of t
                  end try
                  set p to my matchesZhu(sessionName)
                  if p > 0 and p < bestPriority then
                    set bestPriority to p
                    set foundIn to "iTerm"
                    tell w to select t
                  end if
                end try
              end repeat
            end try
          end repeat
          if foundIn is "iTerm" then activate
        end tell
      end if
    end tell
  end try
end if

if foundIn is "" then
  return "ERROR: no Terminal/iTerm tab with claude session (open one with: cd ~/Desktop/rockstock && claude)"
end if

delay 0.25

tell application "System Events"
  keystroke "/zhu"
  delay 0.1
  key code 36
end tell

delay 0.15

-- 還原焦點
if prevApp is not missing value and prevApp is not "Terminal" and prevApp is not "iTerm2" then
  try
    tell application prevApp to activate
  end try
end if

return "OK via " & foundIn & " (priority " & bestPriority & ")"
`;

export async function triggerZhuKeystroke(): Promise<{ ok: boolean; detail?: string }> {
  if (process.platform !== 'darwin') {
    return { ok: false, detail: 'not macOS — skip auto-trigger' };
  }
  try {
    const { stdout, stderr } = await execFileAsync('osascript', ['-e', APPLESCRIPT], {
      timeout: 5_000,
    });
    const result = (stdout || '').trim();
    if (result.startsWith('ERROR')) {
      return { ok: false, detail: result };
    }
    if (stderr && stderr.trim() && !stderr.includes('warning')) {
      return { ok: false, detail: stderr.trim() };
    }
    return { ok: true, detail: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg };
  }
}
