import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(__dirname, '..')
const targetRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(sourceRoot, '../Miro')

console.log('目标目录:', targetRoot)

if (fs.existsSync(targetRoot)) {
  fs.rmSync(targetRoot, { recursive: true, force: true })
}
fs.mkdirSync(targetRoot, { recursive: true })

console.log('1. 构建前端资源...')
execSync('npm run build', { cwd: sourceRoot, stdio: 'inherit' })

console.log('2. 复制 Electron 运行时...')
const electronDist = path.join(sourceRoot, 'node_modules/electron/dist')
fs.cpSync(electronDist, targetRoot, { recursive: true })

const electronExe = path.join(targetRoot, 'electron.exe')
const miroExe = path.join(targetRoot, 'Miro.exe')
if (fs.existsSync(electronExe)) {
  fs.renameSync(electronExe, miroExe)
}

console.log('3. 打包应用资源...')
const appRoot = path.join(targetRoot, 'resources/app')
fs.mkdirSync(appRoot, { recursive: true })

fs.cpSync(path.join(sourceRoot, 'electron'), path.join(appRoot, 'electron'), { recursive: true })
fs.cpSync(path.join(sourceRoot, 'dist'), path.join(appRoot, 'dist'), { recursive: true })
fs.cpSync(path.join(sourceRoot, 'src'), path.join(appRoot, 'src'), { recursive: true })

const nodeModulesTarget = path.join(appRoot, 'node_modules')
fs.mkdirSync(nodeModulesTarget, { recursive: true })
fs.cpSync(path.join(sourceRoot, 'node_modules/zod'), path.join(nodeModulesTarget, 'zod'), { recursive: true })

const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'))
const appPkg = {
  name: 'miro',
  version: pkg.version || '0.8.0',
  main: 'electron/main.cjs',
  description: 'Miro 中文桌面对话'
}
fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify(appPkg, null, 2), 'utf8')

// 生成打开Miro.cmd
const openBat = `@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0Miro.exe"\r\n`
fs.writeFileSync(path.join(targetRoot, '打开Miro.cmd'), openBat, 'utf8')
fs.writeFileSync(path.join(targetRoot, '一键启动.cmd'), openBat, 'utf8')

console.log('4. 打包完成！Miro.exe 路径:', miroExe)
