$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('H:\01_Agents\codex\同步会话\Miro.lnk')
$s.TargetPath = 'H:\01_Agents\codex\同步会话\Miro\Miro.exe'
$s.WorkingDirectory = 'H:\01_Agents\codex\同步会话\Miro'
$s.IconLocation = 'H:\01_Agents\codex\同步会话\Miro\Miro.ico,0'
$s.Save()
Write-Host 'LNK_SUCCESS'
