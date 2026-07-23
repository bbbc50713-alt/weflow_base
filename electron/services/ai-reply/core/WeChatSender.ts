import { exec } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface SendResult {
  success: boolean
  error?: string
  focusSignature?: string
}

export interface WeChatSenderOptions {
  restoreClipboard?: boolean
  sendHotkey?: 'enter' | 'ctrl-enter'
  reuseActiveChat?: boolean
}

type StepStatus = 'OK' | 'ERROR' | 'WARNING'

interface ParsedOutput {
  steps: { name: string; status: StepStatus; detail: string }[]
  raw: string
  hasFinalOK: boolean
}

interface TempSendBundle {
  scriptPath: string
  contactPath: string
  messagePath: string
  expectedFocusPath: string
}

interface LastSendContext {
  contactId: string
  contactName: string
  focusSignature: string
  chatTitle?: string
  sentAt: number
}

function parseScriptOutput(stdout: string): ParsedOutput {
  const raw = (stdout || '').trim()
  const steps: ParsedOutput['steps'] = []
  let hasFinalOK = false

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed === 'SEND_COMPLETE') {
      hasFinalOK = true
      continue
    }

    if (!trimmed.startsWith('STEP:')) continue

    const parts = trimmed.slice(5).split(':')
    const name = parts.shift()?.trim() || 'Unknown'
    const status = (parts.shift()?.trim() || 'ERROR') as StepStatus
    const detail = parts.join(':').trim()
    steps.push({ name, status, detail })
  }

  return { steps, raw, hasFinalOK }
}

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

export class WeChatSender {
  private enabled = false
  private maxRetries = 2
  private retryDelay = 1500
  private options: Required<WeChatSenderOptions> = {
    restoreClipboard: true,
    sendHotkey: 'enter',
    reuseActiveChat: true
  }
  private lastSendContext: LastSendContext | null = null

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setOptions(options: WeChatSenderOptions): void {
    this.options = {
      ...this.options,
      ...options,
      sendHotkey: options.sendHotkey === 'ctrl-enter' ? 'ctrl-enter' : 'enter',
      restoreClipboard: options.restoreClipboard !== false,
      reuseActiveChat: options.reuseActiveChat !== false
    }
  }

  async checkAvailability(): Promise<SendResult> {
    if (!this.enabled) {
      return { success: false, error: 'Message sending is not enabled' }
    }

    if (process.platform !== 'win32') {
      return { success: false, error: 'Message sending currently supports Windows only' }
    }

    const script = String.raw`
$names = @('WeChat', 'Weixin', 'WeChatAppEx', 'WeixinAppEx')
foreach ($name in $names) {
  $proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
    Select-Object -First 1
  if ($proc) {
    Write-Output "OK:$($proc.ProcessName):$($proc.Id)"
    exit 0
  }
}
Write-Output 'ERROR:WeChat process with a visible main window was not found'
exit 1
`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')

    try {
      const { stdout } = await execAsync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
        timeout: 7000,
        windowsHide: true,
        maxBuffer: 128 * 1024
      })
      const output = (stdout || '').trim()
      if (output.startsWith('OK:')) {
        return { success: true }
      }
      return { success: false, error: output || 'WeChat process with a visible main window was not found' }
    } catch (error: any) {
      const output = String(error?.stdout || '').trim()
      return {
        success: false,
        error: output.replace(/^ERROR:/, '') || error?.message || 'WeChat availability check failed'
      }
    }
  }

  async sendTextMessage(
    contactId: string,
    contactName: string,
    message: string,
    isGroup = false
  ): Promise<SendResult> {
    if (!this.enabled) {
      return { success: false, error: 'Message sending is not enabled' }
    }

    if (process.platform !== 'win32') {
      return { success: false, error: 'Message sending currently supports Windows only' }
    }

    const targetName = (contactName || contactId || '').trim()
    if (!targetName) {
      return { success: false, error: 'Contact name is empty, cannot open chat' }
    }

    const finalMessage = (message || '').trim()
    if (!finalMessage) {
      return { success: false, error: 'Message content is empty, cannot send' }
    }

    // Keep group replies as plain text. The sender name is not available here, and
    // prefixing "@group name" makes many group sends fail or address the wrong target.
    void isGroup

    let lastError = ''
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let bundle: TempSendBundle | null = null

      try {
        const expectedFocusSignature = this.getReusableFocusSignature(contactId, targetName, attempt)
        bundle = await this.writeTempSendBundle(targetName, finalMessage, expectedFocusSignature)

        const command = [
          'powershell.exe',
          '-NoProfile',
          '-Sta',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          quoteArg(bundle.scriptPath),
          '-ContactFile',
          quoteArg(bundle.contactPath),
          '-MessageFile',
          quoteArg(bundle.messagePath),
          '-SendHotkey',
          quoteArg(this.options.sendHotkey),
          '-RestoreClipboard',
          quoteArg(this.options.restoreClipboard ? 'true' : 'false'),
          '-AllowSkipSearch',
          quoteArg(expectedFocusSignature ? 'true' : 'false'),
          '-ExpectedFocusFile',
          quoteArg(bundle.expectedFocusPath)
        ].join(' ')

        const { stdout, stderr } = await execAsync(command, {
          timeout: 45000,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        })

        const parsed = parseScriptOutput(stdout || '')
        for (const step of parsed.steps) {
          console.log(`[WeChatSender] ${step.name}: ${step.status}${step.detail ? ` - ${step.detail}` : ''}`)
        }

        const errorSteps = parsed.steps.filter(step => step.status === 'ERROR')
        if (parsed.hasFinalOK && errorSteps.length === 0) {
          const focusSignature = this.extractFocusSignature(parsed)
          const chatTitle = this.extractChatTitle(parsed)
          if (focusSignature) {
            this.lastSendContext = {
              contactId,
              contactName: targetName,
              focusSignature,
              chatTitle,
              sentAt: Date.now()
            }
          } else {
            this.lastSendContext = null
          }
          return { success: true, focusSignature }
        }

        lastError =
          errorSteps.map(step => `${step.name}: ${step.detail}`).join('; ') ||
          (stderr || '').trim() ||
          parsed.raw ||
          'PowerShell sender did not report completion'

        console.warn(`[WeChatSender] send attempt ${attempt}/${this.maxRetries} failed: ${lastError}`)
        if (expectedFocusSignature) {
          this.lastSendContext = null
        }
      } catch (error: any) {
        const stdout = String(error?.stdout || '')
        const stderr = String(error?.stderr || '').trim()
        const parsed = parseScriptOutput(stdout)
        for (const step of parsed.steps) {
          console.log(`[WeChatSender] ${step.name}: ${step.status}${step.detail ? ` - ${step.detail}` : ''}`)
        }
        const errorSteps = parsed.steps.filter(step => step.status === 'ERROR')
        const scriptError =
          errorSteps.map(step => `${step.name}: ${step.detail}`).join('; ') ||
          stderr ||
          parsed.raw

        lastError = error?.killed
          ? 'Sending timed out after 45s; WeChat may not be responding'
          : scriptError || error?.message || 'Failed to send message'
        console.warn(`[WeChatSender] send attempt ${attempt}/${this.maxRetries} threw: ${lastError}`)
        this.lastSendContext = null
      } finally {
        if (bundle) {
          await Promise.all([
            unlink(bundle.scriptPath).catch(() => {}),
            unlink(bundle.contactPath).catch(() => {}),
            unlink(bundle.messagePath).catch(() => {}),
            unlink(bundle.expectedFocusPath).catch(() => {})
          ])
        }
      }

      if (attempt < this.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, this.retryDelay))
      }
    }

    return { success: false, error: lastError }
  }

  private getReusableFocusSignature(contactId: string, contactName: string, attempt: number): string {
    if (!this.options.reuseActiveChat || attempt !== 1 || !this.lastSendContext) {
      return ''
    }
    if (Date.now() - this.lastSendContext.sentAt > 5 * 60 * 1000) {
      this.lastSendContext = null
      return ''
    }
    if (this.lastSendContext.contactId !== contactId) {
      return ''
    }
    if (this.lastSendContext.contactName && contactName && this.lastSendContext.contactName !== contactName) {
      return ''
    }
    return this.lastSendContext.focusSignature
  }

  private extractFocusSignature(parsed: ParsedOutput): string {
    const step = [...parsed.steps].reverse().find(item => item.name === 'FocusSignature' && item.status === 'OK')
    return step?.detail || ''
  }

  private extractChatTitle(parsed: ParsedOutput): string {
    const step = [...parsed.steps].reverse().find(item => item.name === 'ActiveChat' && item.status === 'OK')
    return step?.detail || ''
  }

  private async writeTempSendBundle(contactName: string, message: string, expectedFocusSignature = ''): Promise<TempSendBundle> {
    const tmpDir = join(tmpdir(), 'weflow-ai-reply-send')
    if (!existsSync(tmpDir)) {
      await mkdir(tmpDir, { recursive: true })
    }

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const scriptPath = join(tmpDir, `send_${suffix}.ps1`)
    const contactPath = join(tmpDir, `contact_${suffix}.txt`)
    const messagePath = join(tmpDir, `message_${suffix}.txt`)
    const expectedFocusPath = join(tmpDir, `focus_${suffix}.txt`)

    await Promise.all([
      writeFile(scriptPath, `\uFEFF${SEND_SCRIPT}`, 'utf-8'),
      writeFile(contactPath, contactName, 'utf-8'),
      writeFile(messagePath, message, 'utf-8'),
      writeFile(expectedFocusPath, expectedFocusSignature, 'utf-8')
    ])

    return { scriptPath, contactPath, messagePath, expectedFocusPath }
  }
}

const SEND_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$ContactFile,
  [Parameter(Mandatory=$true)][string]$MessageFile,
  [ValidateSet('enter','ctrl-enter')][string]$SendHotkey = 'enter',
  [ValidateSet('true','false')][string]$RestoreClipboard = 'true',
  [ValidateSet('true','false')][string]$AllowSkipSearch = 'false',
  [string]$ExpectedFocusFile = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class NativeMethods {
  public const int SW_RESTORE = 9;
  public const int SW_SHOW = 5;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
}
"@

function Write-Step {
  param([string]$Name, [string]$Status, [string]$Detail = '')
  $line = ''
  if ($Detail) {
    $line = 'STEP:' + $Name + ':' + $Status + ':' + $Detail
  } else {
    $line = 'STEP:' + $Name + ':' + $Status
  }
  [Console]::Out.WriteLine($line)
}

function Read-Utf8File {
  param([string]$Path)
  if (-not $Path -or -not [System.IO.File]::Exists($Path)) { return '' }
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Set-ClipboardText {
  param([string]$Text)
  [System.Windows.Forms.Clipboard]::Clear() | Out-Null
  [System.Windows.Forms.Clipboard]::SetText($Text, [System.Windows.Forms.TextDataFormat]::UnicodeText) | Out-Null
}

function Invoke-SendHotkey {
  param([string]$Hotkey)
  if ($Hotkey -eq 'ctrl-enter') {
    [System.Windows.Forms.SendKeys]::SendWait('^{ENTER}')
  } else {
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  }
}

function Get-WeChatProcess {
  $names = @('WeChat', 'Weixin', 'WeChatAppEx', 'WeixinAppEx')

  foreach ($name in $names) {
    $proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($proc) {
      # 确保返回单个对象
      return @($proc)[0]
    }
  }

  $result = Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne [IntPtr]::Zero -and
      ($_.MainWindowTitle -match 'WeChat|Weixin|微信')
    } |
    Select-Object -First 1

  if ($result) {
    # 确保返回单个对象
    return @($result)[0]
  }

  return $null
}

function Activate-WeChat {
  $wechat = Get-WeChatProcess
  if (-not $wechat) {
    Write-Step 'ActivateWeChat' 'ERROR' 'WeChat process with a visible main window was not found'
    return [IntPtr]::Zero
  }

  # 确保 $wechat 是单个对象而不是数组
  if ($wechat -is [Array]) {
    $wechat = $wechat[0]
  }

  if (-not $wechat) {
    Write-Step 'ActivateWeChat' 'ERROR' 'WeChat process is null after array check'
    return [IntPtr]::Zero
  }

  $handle = $wechat.MainWindowHandle
  [NativeMethods]::ShowWindow($handle, [NativeMethods]::SW_RESTORE) | Out-Null
  Start-Sleep -Milliseconds 200

  try {
    $shell = New-Object -ComObject WScript.Shell
    $shell.AppActivate($wechat.Id) | Out-Null
  } catch {}

  [NativeMethods]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 400

  $foreground = [NativeMethods]::GetForegroundWindow()
  if ($foreground -ne $handle) {
    Write-Step 'ActivateWeChat' 'WARNING' 'Window may not be foreground, continuing'
  } else {
    Write-Step 'ActivateWeChat' 'OK' 'WeChat is foreground'
  }

  return $handle
}

function Click-Point {
  param([int]$X, [int]$Y)
  [NativeMethods]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 80
  [NativeMethods]::mouse_event([NativeMethods]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [NativeMethods]::mouse_event([NativeMethods]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 180
}

function Normalize-WindowHandle {
  param($Handle)

  if ($Handle -is [Array]) {
    $Handle = @($Handle | Where-Object {
      $_ -is [IntPtr] -or $_ -is [int] -or $_ -is [long]
    } | Select-Object -Last 1)[0]
  }

  if ($null -eq $Handle) {
    return [IntPtr]::Zero
  }

  try {
    return [IntPtr]$Handle
  } catch {
    Write-Step 'NormalizeWindowHandle' 'ERROR' $_.Exception.Message
    return [IntPtr]::Zero
  }
}

function Get-BestInputElement {
  param([IntPtr]$WindowHandle)

  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    if (-not $root) { return $null }

    $editCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit
    )
    $documentCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Document
    )
    $condition = New-Object System.Windows.Automation.OrCondition($editCondition, $documentCondition)
    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)

    $candidates = @()
    foreach ($element in $elements) {
      try {
        $rect = $element.Current.BoundingRectangle
        if ($element.Current.IsOffscreen) { continue }
        if (-not $element.Current.IsEnabled) { continue }
        if ($rect.Width -lt 80 -or $rect.Height -lt 20) { continue }
        $candidates += [PSCustomObject]@{ Element = $element; Rect = $rect; Score = ($rect.Y * 10 + $rect.Width) }
      } catch {}
    }

    if ($candidates.Count -eq 0) { return $null }
    return ($candidates | Sort-Object Score -Descending | Select-Object -First 1).Element
  } catch {
    return $null
  }
}

function Get-WindowBounds {
  param([IntPtr]$WindowHandle)

  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    if ($root) {
      $rect = $root.Current.BoundingRectangle
      if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
        return [PSCustomObject]@{
          X = [double]$rect.X
          Y = [double]$rect.Y
          Width = [double]$rect.Width
          Height = [double]$rect.Height
        }
      }
    }
  } catch {}

  try {
    $nativeRect = New-Object NativeMethods+RECT
    if ([NativeMethods]::GetWindowRect($WindowHandle, [ref]$nativeRect)) {
      $width = [double]($nativeRect.Right - $nativeRect.Left)
      $height = [double]($nativeRect.Bottom - $nativeRect.Top)
      if ($width -gt 0 -and $height -gt 0) {
        return [PSCustomObject]@{
          X = [double]$nativeRect.Left
          Y = [double]$nativeRect.Top
          Width = $width
          Height = $height
        }
      }
    }
  } catch {}

  return $null
}

function Get-ElementText {
  param($Element)

  if (-not $Element) { return '' }

  try {
    $valuePattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
      return $valuePattern.Current.Value
    }
  } catch {}

  try {
    $textPattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
      return $textPattern.DocumentRange.GetText(-1)
    }
  } catch {}

  return ''
}

function Get-FocusSignature {
  try {
    $element = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $element) { return '' }

    $rect = $element.Current.BoundingRectangle
    $controlType = ''
    try { $controlType = [string]$element.Current.ControlType.ProgrammaticName } catch {}
    $name = ''
    try { $name = [string]$element.Current.Name } catch {}
    $className = ''
    try { $className = [string]$element.Current.ClassName } catch {}
    $automationId = ''
    try { $automationId = [string]$element.Current.AutomationId } catch {}
    $x = [int][Math]::Round($rect.X / 5) * 5
    $y = [int][Math]::Round($rect.Y / 5) * 5
    $w = [int][Math]::Round($rect.Width / 5) * 5
    $h = [int][Math]::Round($rect.Height / 5) * 5

    return "type=$controlType|class=$className|id=$automationId|name=$name|rect=$x,$y,$w,$h"
  } catch {
    return ''
  }
}

function Normalize-ComparableText {
  param([string]$Text)
  if (-not $Text) { return '' }
  return ($Text -replace '\s+', '' -replace '[\u200B-\u200D\uFEFF]', '').Trim().ToLowerInvariant()
}

function Test-ContactTitleMatch {
  param([string]$ContactName, [string]$ChatTitle)
  $contact = Normalize-ComparableText -Text $ContactName
  $title = Normalize-ComparableText -Text $ChatTitle
  if (-not $contact -or -not $title) { return $false }
  if ($title -eq $contact) { return $true }
  if ($title.Contains($contact)) { return $true }
  if ($contact.Contains($title) -and $title.Length -ge 2) { return $true }
  return $false
}

function Get-ActiveChatTitle {
  param([IntPtr]$WindowHandle)

  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    if (-not $root) { return '' }

    $bounds = Get-WindowBounds -WindowHandle $WindowHandle
    if (-not $bounds) { return '' }

    $textCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Text
    )
    $paneCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Pane
    )
    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
    $condition = New-Object System.Windows.Automation.OrCondition($textCondition, $paneCondition, $buttonCondition)
    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)

    $candidates = @()
    foreach ($element in $elements) {
      try {
        if ($element.Current.IsOffscreen) { continue }
        $name = ([string]$element.Current.Name).Trim()
        if (-not $name) { continue }
        if ($name.Length -gt 80) { continue }
        if ($name -match '搜索|Search|聊天|通讯录|朋友圈|收藏|设置|更多|最小化|最大化|关闭') { continue }

        $rect = $element.Current.BoundingRectangle
        if ($rect.Width -lt 20 -or $rect.Height -lt 10) { continue }

        $relativeX = ($rect.X - $bounds.X) / [Math]::Max($bounds.Width, 1)
        $relativeY = ($rect.Y - $bounds.Y) / [Math]::Max($bounds.Height, 1)

        # Current chat title usually lives in the right conversation header.
        # This excludes the left search box/list and the message body.
        if ($relativeX -lt 0.28 -or $relativeY -lt 0.00 -or $relativeY -gt 0.16) { continue }

        $score = 100000 - [Math]::Abs($relativeY - 0.06) * 10000 - [Math]::Abs($relativeX - 0.32) * 1000
        $candidates += [PSCustomObject]@{ Name = $name; Score = $score }
      } catch {}
    }

    if ($candidates.Count -eq 0) { return '' }
    return [string](($candidates | Sort-Object Score -Descending | Select-Object -First 1).Name)
  } catch {
    return ''
  }
}

function Focus-Input {
  param([IntPtr]$WindowHandle)

  $element = Get-BestInputElement -WindowHandle $WindowHandle
  if ($element) {
    try { $element.SetFocus() | Out-Null } catch {}
    try {
      $rect = $element.Current.BoundingRectangle
      $x = [int]($rect.X + [Math]::Max(20, [Math]::Min($rect.Width / 2, 160)))
      $y = [int]($rect.Y + $rect.Height / 2)
      Click-Point -X $x -Y $y
      Write-Step 'FocusInput' 'OK' "Focused input via UIAutomation"
      return $element
    } catch {}
  }

  $bounds = Get-WindowBounds -WindowHandle $WindowHandle
  if (-not $bounds) {
    Write-Step 'FocusInput' 'ERROR' 'Could not resolve WeChat window bounds'
    return $null
  }

  $x = [int]($bounds.X + $bounds.Width * 0.62)
  $y = [int]($bounds.Y + $bounds.Height - 95)
  Click-Point -X $x -Y $y
  Write-Step 'FocusInput' 'WARNING' 'Clicked estimated input area'

  $fallbackElement = Get-BestInputElement -WindowHandle $WindowHandle
  if ($fallbackElement) {
    return $fallbackElement
  }

  Write-Step 'FindInput' 'WARNING' 'UIAutomation input element unavailable after coordinate click; continuing with SendKeys'
  return [PSCustomObject]@{ SendKeysOnly = $true }
}

function Get-SendButtonElement {
  param([IntPtr]$WindowHandle)

  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    if (-not $root) { return $null }

    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )
    $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    $bounds = Get-WindowBounds -WindowHandle $WindowHandle
    $candidates = @()

    foreach ($button in $buttons) {
      try {
        if ($button.Current.IsOffscreen) { continue }
        if (-not $button.Current.IsEnabled) { continue }

        $rect = $button.Current.BoundingRectangle
        if ($rect.Width -lt 35 -or $rect.Height -lt 20) { continue }

        $name = [string]$button.Current.Name
        $automationId = [string]$button.Current.AutomationId
        $className = [string]$button.Current.ClassName
        $score = 0

        if ($name -match '发送|Send') { $score += 100000 }
        if ($automationId -match 'send|Send') { $score += 50000 }
        if ($className -match 'Button|button') { $score += 1000 }

        if ($bounds) {
          $relativeX = ($rect.X - $bounds.X) / [Math]::Max($bounds.Width, 1)
          $relativeY = ($rect.Y - $bounds.Y) / [Math]::Max($bounds.Height, 1)
          if ($relativeX -gt 0.72 -and $relativeY -gt 0.68) { $score += 10000 }
          $score += [int]($relativeX * 1000 + $relativeY * 1000)
        }

        if ($score -gt 0) {
          $candidates += [PSCustomObject]@{ Element = $button; Rect = $rect; Score = $score; Name = $name }
        }
      } catch {}
    }

    if ($candidates.Count -eq 0) { return $null }
    return ($candidates | Sort-Object Score -Descending | Select-Object -First 1).Element
  } catch {
    return $null
  }
}

function Invoke-SendButton {
  param([IntPtr]$WindowHandle)

  $button = Get-SendButtonElement -WindowHandle $WindowHandle
  if ($button) {
    try {
      $invokePattern = $null
      if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
        $invokePattern.Invoke()
        Start-Sleep -Milliseconds 700
        Write-Step 'ClickSendButton' 'OK' 'Invoked send button via UIAutomation'
        return $true
      }
    } catch {}

    try {
      $rect = $button.Current.BoundingRectangle
      $x = [int]($rect.X + $rect.Width / 2)
      $y = [int]($rect.Y + $rect.Height / 2)
      Click-Point -X $x -Y $y
      Write-Step 'ClickSendButton' 'OK' 'Clicked send button via UIAutomation bounds'
      return $true
    } catch {}
  }

  $bounds = Get-WindowBounds -WindowHandle $WindowHandle
  if (-not $bounds) {
    Write-Step 'ClickSendButton' 'ERROR' 'Could not resolve WeChat window bounds'
    return $false
  }

  $x = [int]($bounds.X + $bounds.Width - 55)
  $y = [int]($bounds.Y + $bounds.Height - 38)
  Click-Point -X $x -Y $y
  Write-Step 'ClickSendButton' 'WARNING' 'Clicked estimated send button area'
  return $true
}

function Search-And-Navigate {
  param([string]$ContactName)

  try {
    Set-ClipboardText -Text $ContactName
    [System.Windows.Forms.SendKeys]::SendWait('^f')
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 900
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 1000
    Write-Step 'SearchContact' 'OK' "Opened chat for '$ContactName'"
    return $true
  } catch {
    Write-Step 'SearchContact' 'ERROR' $_.Exception.Message
    return $false
  }
}

function Send-Text {
  param([string]$Text, [IntPtr]$WindowHandle, [string]$Hotkey)

  $inputElement = Focus-Input -WindowHandle $WindowHandle
  if (-not $inputElement) {
    Write-Step 'FindInput' 'ERROR' 'Could not focus chat input'
    return $false
  }

  try {
    Set-ClipboardText -Text $Text
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 350
    Write-Step 'PasteText' 'OK' "Pasted text, length=$($Text.Length)"
  } catch {
    Write-Step 'PasteText' 'ERROR' $_.Exception.Message
    return $false
  }

  $beforeSend = Get-ElementText -Element $inputElement

  try {
    Invoke-SendHotkey -Hotkey $Hotkey
    Start-Sleep -Milliseconds 900
  } catch {
    Write-Step 'SendEnter' 'ERROR' $_.Exception.Message
    return $false
  }

  $afterEnter = Get-ElementText -Element $inputElement
  if ($beforeSend -and $afterEnter -and $afterEnter.Trim().Length -eq 0) {
    Write-Step 'VerifySent' 'OK' 'Input was cleared after send hotkey'
    Write-Step 'SendMessage' 'OK' 'Send hotkey submitted'
    return $true
  }

  if ($afterEnter -and $beforeSend -and $afterEnter.Trim().Length -gt 0) {
    try {
      $fallbackHotkey = if ($Hotkey -eq 'ctrl-enter') { 'enter' } else { 'ctrl-enter' }
      Invoke-SendHotkey -Hotkey $fallbackHotkey
      Start-Sleep -Milliseconds 800
      Write-Step 'SendFallback' 'WARNING' "Input still had text after $Hotkey, tried $fallbackHotkey"
    } catch {}
  }

  $afterFallback = Get-ElementText -Element $inputElement
  if ($beforeSend -and $afterFallback -and $afterFallback.Trim().Length -gt 0) {
    if (-not (Invoke-SendButton -WindowHandle $WindowHandle)) {
      Write-Step 'VerifySent' 'ERROR' 'Input still contains text after send hotkeys and send button was unavailable'
      return $false
    }

    $afterButton = Get-ElementText -Element $inputElement
    if ($afterButton -and $afterButton.Trim().Length -gt 0) {
      Write-Step 'VerifySent' 'ERROR' 'Input still contains text after clicking send button'
      return $false
    }

    Write-Step 'VerifySent' 'OK' 'Input was cleared after clicking send button'
    Write-Step 'SendMessage' 'OK' 'Send button submitted'
    return $true
  }

  if (-not $beforeSend) {
    if (-not (Invoke-SendButton -WindowHandle $WindowHandle)) {
      Write-Step 'VerifySent' 'ERROR' 'Input text could not be read and send button was unavailable'
      return $false
    }
    Write-Step 'VerifySent' 'WARNING' 'Input text could not be read; clicked send button after hotkey'
  } else {
    Write-Step 'VerifySent' 'OK' 'Input was cleared after sending'
  }

  Write-Step 'SendMessage' 'OK' 'Send keys submitted'
  return $true
}

$originalClipboard = ''
$hadClipboard = $false
$shouldRestoreClipboard = $RestoreClipboard -ne 'false'

try {
  $ContactName = (Read-Utf8File -Path $ContactFile).Trim()
  $Text = Read-Utf8File -Path $MessageFile
  $ExpectedFocusSignature = (Read-Utf8File -Path $ExpectedFocusFile).Trim()

  if (-not $ContactName) {
    Write-Step 'Validate' 'ERROR' 'Contact name is empty'
    exit 1
  }
  if (-not $Text -or $Text.Trim().Length -eq 0) {
    Write-Step 'Validate' 'ERROR' 'Message text is empty'
    exit 1
  }

  if ($shouldRestoreClipboard) {
    try {
      $originalClipboard = [System.Windows.Forms.Clipboard]::GetText()
      $hadClipboard = $true
    } catch {}
  }

  $mainWindow = Normalize-WindowHandle -Handle (Activate-WeChat)
  if ($mainWindow -eq [IntPtr]::Zero) { exit 1 }

  $focusBeforeNavigation = Get-FocusSignature
  $activeChatBeforeNavigation = Get-ActiveChatTitle -WindowHandle $mainWindow
  if ($activeChatBeforeNavigation) {
    Write-Step 'ActiveChat' 'OK' $activeChatBeforeNavigation
  }

  $canSkipByFocus = (
    $AllowSkipSearch -eq 'true' -and
    $ExpectedFocusSignature -and
    $focusBeforeNavigation -eq $ExpectedFocusSignature
  )
  $canSkipByActiveChat = (
    $AllowSkipSearch -eq 'true' -and
    $ExpectedFocusSignature -and
    (Test-ContactTitleMatch -ContactName $ContactName -ChatTitle $activeChatBeforeNavigation)
  )

  if ($canSkipByFocus) {
    Write-Step 'SearchContact' 'OK' 'Skipped contact search; focus unchanged from previous send'
  } elseif ($canSkipByActiveChat) {
    Write-Step 'SearchContact' 'OK' "Skipped contact search; active chat is still '$activeChatBeforeNavigation'"
  } else {
    if ($AllowSkipSearch -eq 'true' -and $ExpectedFocusSignature) {
      $reason = 'Focus changed since previous send'
      if ($activeChatBeforeNavigation) {
        $reason = "$reason; active chat '$activeChatBeforeNavigation' does not match '$ContactName'"
      } else {
        $reason = "$reason; active chat title unavailable"
      }
      Write-Step 'SearchContact' 'WARNING' "$reason; searching contact again"
    }
    if (-not (Search-And-Navigate -ContactName $ContactName)) { exit 1 }
  }

  $mainWindow = Normalize-WindowHandle -Handle (Activate-WeChat)
  if ($mainWindow -eq [IntPtr]::Zero) { exit 1 }

  if (-not (Send-Text -Text $Text -WindowHandle $mainWindow -Hotkey $SendHotkey)) { exit 1 }

  $activeChatAfterSend = Get-ActiveChatTitle -WindowHandle $mainWindow
  if ($activeChatAfterSend) {
    Write-Step 'ActiveChat' 'OK' $activeChatAfterSend
  }

  $focusAfterSend = Get-FocusSignature
  if ($focusAfterSend) {
    Write-Step 'FocusSignature' 'OK' $focusAfterSend
  } else {
    Write-Step 'FocusSignature' 'WARNING' 'Focused element signature unavailable after send'
  }

  Write-Output 'SEND_COMPLETE'
} finally {
  if ($shouldRestoreClipboard) {
    try {
      if ($hadClipboard) {
        Set-ClipboardText -Text $originalClipboard
      } else {
        [System.Windows.Forms.Clipboard]::Clear() | Out-Null
      }
    } catch {}
  }
}
`
