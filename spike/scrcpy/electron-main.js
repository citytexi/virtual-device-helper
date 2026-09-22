// 스파이크 코드. 버린다.
//
// renderer 가 WebCodecs 로 프레임을 한 장 그리면 exit 0, 아니면 exit 1 로 끝난다.
// 사람이 창을 볼 수 없는 환경에서도 결과를 기계로 확인하기 위한 장치다.

const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')

let settled = false

function quitWith(code, message) {
  if (settled) return
  settled = true
  console.log('[spike] ' + message)
  process.exitCode = code
  app.exit(code)
}

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 600,
    height: 1100,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })

  window.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer] ' + message)
  })

  ipcMain.on('spike-result', (_event, result) => {
    if (result.ok) {
      quitWith(0, 'frame decoded and drawn: ' + result.codedSize + ' -> ' + result.path)
    } else {
      quitWith(1, 'failed: ' + result.reason)
    }
  })

  window.loadFile(join(__dirname, 'index.html'))

  setTimeout(() => quitWith(1, 'timed out without a decoded frame'), 20_000)
})
