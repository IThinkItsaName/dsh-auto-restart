import test from 'node:test'
import assert from 'node:assert/strict'
import { detectLaunch, sanitizeRelaunchEnv, isPackagedDesktopExecutable } from '../lib/launch.js'

const PACKAGED = 'C:\\Program Files (x86)\\dsh_desktop\\DeepSeek Harness.exe'

test('packaged desktop launch is auto-detected', () => {
  const launch = detectLaunch({
    execPath: PACKAGED,
    argv: [PACKAGED, 'entry.js'],
    ppid: 4242,
    versions: { electron: '30.0.0' },
    send: () => {},
  })
  assert.equal(launch.ok, true)
  assert.equal(launch.mode, 'desktop')
  assert.equal(launch.executable, PACKAGED)
  assert.deepEqual(launch.args, [])
  assert.equal(launch.desktopPid, 4242)
})

test('dev Electron without an override is refused', () => {
  const launch = detectLaunch({
    execPath: 'C:\\project\\node_modules\\electron\\dist\\electron.exe',
    versions: { electron: '30.0.0' },
    send: () => {},
  })
  assert.equal(launch.ok, false)
  assert.equal(launch.code, 'unsupported-launch')
})

test('plain node CLI launch preserves the original argv', () => {
  const launch = detectLaunch({
    execPath: 'C:\\node\\node.exe',
    argv: ['C:\\node\\node.exe', 'C:\\dsh\\bin.js', 'web', '--port', '55190'],
    ppid: 10,
    versions: {},
    send: undefined,
  })
  assert.equal(launch.ok, true)
  assert.equal(launch.mode, 'cli')
  assert.deepEqual(launch.args, ['C:\\dsh\\bin.js', 'web', '--port', '55190'])
  assert.equal(launch.desktopPid, undefined)
})

test('explicit launch config wins', () => {
  const launch = detectLaunch({
    config: { mode: 'cli', executable: 'C:\\node\\node.exe', args: ['app.js'], cwd: 'C:\\work' },
    execPath: PACKAGED,
    versions: { electron: '30.0.0' },
    send: () => {},
  })
  assert.equal(launch.ok, true)
  assert.equal(launch.mode, 'cli')
  assert.equal(launch.source, 'config')
  assert.deepEqual(launch.args, ['app.js'])
})

test('relaunch env removes Electron Node mode', () => {
  const env = sanitizeRelaunchEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: 'x', KEEP: 'y' })
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal(env.KEEP, 'y')
})

test('packaged exe detector', () => {
  assert.equal(isPackagedDesktopExecutable(PACKAGED), true)
  assert.equal(isPackagedDesktopExecutable('C:\\electron\\electron.exe'), false)
})
