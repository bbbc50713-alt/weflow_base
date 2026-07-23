# WeChatSender PowerShell 脚本错误修复方案

## 问题诊断

### 错误信息
```
无法绑定参数"WindowHandle"。
无法将"System.Object[]"类型的"System.Object[]"值转换为类型"System.IntPtr"。
```

### 根本原因
在 `WeChatSender.ts` 的 PowerShell 脚本中，`Activate-WeChat` 函数返回的 `$wechat.MainWindowHandle` 可能是数组而不是单个 `IntPtr` 值。

**问题代码**（第 354-361 行）：
```powershell
function Activate-WeChat {
  $wechat = Get-WeChatProcess
  if (-not $wechat) {
    Write-Step 'ActivateWeChat' 'ERROR' 'WeChat process with a visible main window was not found'
    return [IntPtr]::Zero
  }

  $handle = $wechat.MainWindowHandle  # ⚠️ $wechat 可能是数组
```

**为什么会是数组？**
1. `Get-WeChatProcess` 函数在某些情况下可能返回多个进程对象
2. PowerShell 的管道操作符在某些版本中可能不正确处理 `Select-Object -First 1`
3. 当 `$wechat` 是数组时，`$wechat.MainWindowHandle` 返回 Handle 数组而不是单个值

---

## 修复方案

### 方法 1：强制转换为单个对象（推荐）

**文件**: `electron/services/ai-reply/core/WeChatSender.ts`

**位置**: 第 354-362 行

**修改代码**：
```typescript
function Activate-WeChat {
  $wechat = Get-WeChatProcess
  if (-not $wechat) {
    Write-Step 'ActivateWeChat' 'ERROR' 'WeChat process with a visible main window was not found'
    return [IntPtr]::Zero
  }

  // ✅ 修复：确保 $wechat 是单个对象，而不是数组
  if ($wechat -is [Array]) {
    $wechat = $wechat[0]
  }

  $handle = $wechat.MainWindowHandle
  [NativeMethods]::ShowWindow($handle, [NativeMethods]::SW_RESTORE) | Out-Null
  Start-Sleep -Milliseconds 200
```

---

### 方法 2：在 Get-WeChatProcess 中确保返回单个值

**文件**: `electron/services/ai-reply/core/WeChatSender.ts`

**位置**: 第 335-352 行

**修改代码**：
```typescript
function Get-WeChatProcess {
  $names = @('WeChat', 'Weixin', 'WeChatAppEx', 'WeixinAppEx')

  foreach ($name in $names) {
    $proc = Get-Process -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($proc) { 
      // ✅ 修复：强制返回单个对象
      return @($proc)[0]
    }
  }

  // ✅ 修复：使用 @()[0] 确保返回单个对象
  $result = Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.MainWindowHandle -ne [IntPtr]::Zero -and
      ($_.MainWindowTitle -match 'WeChat|Weixin|微信')
    } |
    Select-Object -First 1
  
  if ($result) {
    return @($result)[0]
  }
  
  return $null
}
```

---

### 方法 3：使用数组索引访问（最简单）

**文件**: `electron/services/ai-reply/core/WeChatSender.ts`

**位置**: 第 361 行

**修改代码**：
```typescript
function Activate-WeChat {
  $wechat = Get-WeChatProcess
  if (-not $wechat) {
    Write-Step 'ActivateWeChat' 'ERROR' 'WeChat process with a visible main window was not found'
    return [IntPtr]::Zero
  }

  // ✅ 修复：使用数组索引确保获取单个值
  $handle = @($wechat)[0].MainWindowHandle
  [NativeMethods]::ShowWindow($handle, [NativeMethods]::SW_RESTORE) | Out-Null
```

---

## 推荐实施方案

**结合方法 1 和方法 3**，同时修复两处：

### 修复 1：Activate-WeChat 函数

```powershell
function Activate-WeChat {
  $wechat = Get-WeChatProcess
  if (-not $wechat) {
    Write-Step 'ActivateWeChat' 'ERROR' 'WeChat process with a visible main window was not found'
    return [IntPtr]::Zero
  }

  # 确保是单个对象
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
    [void]$shell.AppActivate($wechat.Id)
  } catch {}

  Write-Step 'ActivateWeChat' 'OK' "Activated WeChat (PID: $($wechat.Id), Handle: $handle)"
  return $handle
}
```

### 修复 2：Get-BestInputElement 和 Focus-Input 函数

确保所有接受 `$WindowHandle` 参数的函数都能正确处理：

```powershell
function Get-BestInputElement {
  param([IntPtr]$WindowHandle)
  
  # 确保 WindowHandle 是 IntPtr 类型
  if ($WindowHandle -eq [IntPtr]::Zero) {
    return $null
  }

  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($WindowHandle)
    # ...
```

---

## 实施步骤

1. 打开 `electron/services/ai-reply/core/WeChatSender.ts`
2. 找到 `Activate-WeChat` 函数（约第 354 行）
3. 在 `$handle = $wechat.MainWindowHandle` 之前添加数组检查
4. 保存文件
5. 重启 WeFlow 应用
6. 测试 AI 自动回复

---

## 验证方法

1. 启动 WeFlow
2. 启用 AI 自动回复
3. 等待接收新消息
4. 查看日志，确认发送成功

**预期结果**：
```
[AIReplyService] AI 回复已生成: ...
[AIReplyService] >>> 开始发送流程 <<<
[WeChatSender] send attempt 1/2: Success
[AIReplyService] >>> 发送成功 <<<
```

---

## 其他可能的问题

如果修复后仍然失败，可能是以下原因：

### 1. 微信窗口未激活
- 确保微信正在运行
- 确保微信窗口不是最小化状态

### 2. PowerShell 版本问题
- 检查 PowerShell 版本：`$PSVersionTable.PSVersion`
- 建议使用 PowerShell 5.1 或更高版本

### 3. Windows UI Automation 权限
- 确保 WeFlow 有足够的权限操作微信窗口
- 可能需要以管理员身份运行

### 4. 多开微信
- 如果同时运行多个微信（如PC版和UWP版），可能导致识别错误
- 建议只运行一个微信客户端

---

## 临时解决方案

如果修复后仍有问题，可以临时禁用自动发送：

1. 打开 WeFlow → AI 回复 → 设置
2. 找到"自动发送"选项
3. 关闭自动发送
4. AI 会生成回复，但需要手动复制粘贴到微信

---

## 总结

**问题**：PowerShell 脚本参数类型转换失败（数组转 IntPtr）

**原因**：`Get-WeChatProcess` 可能返回数组，导致 `MainWindowHandle` 也是数组

**解决**：在使用前添加数组检查，确保获取单个值

**优先级**：高 - 影响 AI 自动回复的核心功能
