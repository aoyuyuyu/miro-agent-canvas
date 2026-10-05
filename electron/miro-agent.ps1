param(
  [Parameter(Mandatory=$true)][ValidateSet('register','receive','reply','progress','heartbeat','disconnect','history-list','history-read','history-publish','memory-read')][string]$Action,
  [string]$InviteFile,
  [string]$Name,
  [string]$SessionFile,
  [string]$MessageId,
  [string]$ReplyFile,
  [string]$HistoryFile,
  [string]$HistoryKey,
  [string]$AvatarFile,
  [int]$Offset=0,
  [int]$WaitSeconds=30
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Read-JsonFile([string]$File) { [IO.File]::ReadAllText([IO.Path]::GetFullPath($File),[Text.Encoding]::UTF8) | ConvertFrom-Json }
function Send-Request([string]$Url,[string]$Method,[string]$Token,$Data) {
  $target=[Uri]$Url
  if($target.Scheme -ne 'http' -or $target.Host -ne '127.0.0.1') { throw 'Miro 只允许本机连接' }
  $request=[Net.HttpWebRequest]::Create($target)
  $request.Method=$Method
  $request.Proxy=$null
  $request.Timeout=40000
  $request.ReadWriteTimeout=40000
  $request.Headers['Authorization']='Bearer '+$Token
  if($Method -eq 'POST') {
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Data | ConvertTo-Json -Depth 10 -Compress))
    $request.ContentType='application/json; charset=utf-8'
    $request.ContentLength=$bytes.Length
    $stream=$request.GetRequestStream();$stream.Write($bytes,0,$bytes.Length);$stream.Dispose()
  }
  try {
    $response=$request.GetResponse()
    $reader=[IO.StreamReader]::new($response.GetResponseStream(),[Text.Encoding]::UTF8)
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose();$response.Dispose() }
  } catch [Net.WebException] {
    if($_.Exception.Response) {
      $reader=[IO.StreamReader]::new($_.Exception.Response.GetResponseStream(),[Text.Encoding]::UTF8)
      try { $failure=$reader.ReadToEnd() | ConvertFrom-Json; throw $failure.error } finally { $reader.Dispose() }
    }
    throw '无法连接 Miro，请确认窗口已打开'
  }
}
try {
  if(-not $SessionFile) {
    if($Action -ne 'register') { throw '请填写注册返回的 SessionFile' }
    $SessionFile=Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($InviteFile))) ('client-'+[Guid]::NewGuid().ToString()+'.json')
  }
  $sessionPath=[IO.Path]::GetFullPath($SessionFile)
  if($Action -eq 'register') {
    if(Test-Path -LiteralPath $sessionPath) { throw '此会话文件已存在。继续接收请用 receive；新接入请选择新文件名。' }
    $invite=Read-JsonFile $InviteFile
    if(-not $Name) { throw '请填写你的 Agent 名称' }
    $url=$invite.url
    if($invite.locatorPath -and (Test-Path -LiteralPath $invite.locatorPath)) { $url=(Read-JsonFile $invite.locatorPath).url }
    $registration=@{name=$Name;software=$Name}
    if($AvatarFile) {
      $avatarBytes=[IO.File]::ReadAllBytes([IO.Path]::GetFullPath($AvatarFile))
      if($avatarBytes.Length -gt 70000 -or $avatarBytes.Length -lt 8 -or $avatarBytes[0] -ne 137 -or $avatarBytes[1] -ne 80 -or $avatarBytes[2] -ne 78 -or $avatarBytes[3] -ne 71) { throw '头像需要七万字节以内的 PNG' }
      $registration.avatar='data:image/png;base64,'+[Convert]::ToBase64String($avatarBytes)
    }
    $result=Send-Request ($url+'/register') 'POST' $invite.token $registration
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($sessionPath)) | Out-Null
    [IO.File]::WriteAllText($sessionPath,($result | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    @{ok=$true;name=$Name;agentId=$result.agentId;sessionFile=$sessionPath;message='已接入 Miro，请持续接收消息'} | ConvertTo-Json -Compress
    exit 0
  }
  $session=Read-JsonFile $sessionPath
  $url=$session.url
  if($session.locatorPath -and (Test-Path -LiteralPath $session.locatorPath)) { $url=(Read-JsonFile $session.locatorPath).url }
  $base=$url+'/agents/'+[Uri]::EscapeDataString($session.agentId)
  switch($Action) {
    'memory-read' { $result=Send-Request ($base+'/memory-read') 'GET' $session.token $null }
    'history-list' { $result=Send-Request ($base+'/history-list?offset='+[Math]::Max(0,$Offset)) 'GET' $session.token $null }
    'history-read' { if(-not $HistoryKey) { throw '需要 HistoryKey' }; $result=Send-Request ($base+'/history-read?key='+[Uri]::EscapeDataString($HistoryKey)+'&offset='+[Math]::Max(0,$Offset)) 'GET' $session.token $null }
    'history-publish' { if(-not $HistoryFile) { throw '需要 HistoryFile' }; $result=Send-Request ($base+'/history-publish') 'POST' $session.token (Read-JsonFile $HistoryFile) }
    'receive' { $result=Send-Request ($base+'/next?wait='+[Math]::Min(30,[Math]::Max(0,$WaitSeconds))) 'GET' $session.token $null }
    'heartbeat' { $result=Send-Request ($base+'/heartbeat') 'POST' $session.token @{messageId=$MessageId} }
    'disconnect' { $result=Send-Request ($base+'/disconnect') 'POST' $session.token @{} }
    default {
      if(-not $MessageId -or -not $ReplyFile) { throw '回复需要 MessageId 和 UTF-8 回复文件 ReplyFile' }
      $text=[IO.File]::ReadAllText([IO.Path]::GetFullPath($ReplyFile),[Text.Encoding]::UTF8)
      $result=Send-Request ($base+'/reply') 'POST' $session.token @{messageId=$MessageId;text=$text;final=($Action -eq 'reply')}
    }
  }
  $result | ConvertTo-Json -Depth 10 -Compress
} catch {
  @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress
  exit 1
}

