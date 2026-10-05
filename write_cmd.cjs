const fs = require('fs');
const content = '@echo off\r\ncd /d "%~dp0Miro"\r\nstart "" Miro.exe\r\n';
fs.writeFileSync('H:/01_Agents/codex/同步会话/打开Miro.cmd', content, { encoding: 'ascii' });
console.log('BATCH_FIXED');
