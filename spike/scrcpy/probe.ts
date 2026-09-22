// 스파이크 코드. 버린다.
//
// scrcpy v4.1 의 비디오 소켓을 읽어서 config 패킷(SPS/PPS)과 첫 키프레임을 떼어낸다.
// 와이어 포맷의 근거는 같은 디렉토리의 README.md 에 적었다.

import { createConnection } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = join(process.cwd(), 'spike', 'scrcpy')
const PORT = 27183

const PACKET_FLAG_CONFIG = 1n << 62n
const PACKET_FLAG_KEY_FRAME = 1n << 61n

const socket = createConnection({ host: '127.0.0.1', port: PORT })
let buffer = Buffer.alloc(0)

// 헤더를 순서대로 벗겨 내기 위한 작은 상태 기계.
type Stage = 'dummy' | 'deviceMeta' | 'codecId' | 'sessionMeta' | 'packets'
let stage: Stage = 'dummy'

let codecName = ''
let width = 0
let height = 0
let configPacket: Buffer | null = null
let keyFrame: Buffer | null = null

const raw: Buffer[] = []

function fail(message: string): never {
  console.error('FAIL ' + message)
  socket.destroy()
  process.exit(1)
}

function finish(): void {
  if (configPacket === null || keyFrame === null) {
    fail('config 패킷이나 키프레임을 얻지 못했다')
  }

  const annexB = Buffer.concat([configPacket, keyFrame])
  writeFileSync(join(OUT_DIR, 'first-chunks.bin'), Buffer.concat(raw))
  writeFileSync(join(OUT_DIR, 'keyframe.h264'), annexB)

  // SPS 는 config 패킷 안 첫 NAL 이다. start code(3 또는 4바이트) 뒤 첫 바이트가
  // NAL 헤더이고, 그 다음 3바이트가 profile_idc / constraint_flags / level_idc 다.
  const startCodeLength = configPacket.readUInt32BE(0) === 1 ? 4 : 3
  const nalHeader = configPacket[startCodeLength]
  const nalType = nalHeader & 0x1f
  if (nalType !== 7) {
    fail(`config 패킷의 첫 NAL 이 SPS(7) 가 아니라 ${nalType} 이다`)
  }
  const profileIdc = configPacket[startCodeLength + 1]
  const constraintFlags = configPacket[startCodeLength + 2]
  const levelIdc = configPacket[startCodeLength + 3]
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  const codecString = `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}`

  const meta = {
    codecName,
    codecString,
    width,
    height,
    configBytes: configPacket.length,
    keyFrameBytes: keyFrame.length,
    chunkBytes: annexB.length
  }
  writeFileSync(join(OUT_DIR, 'stream.json'), JSON.stringify(meta, null, 2) + '\n')

  console.log('stream meta ' + JSON.stringify(meta))
  console.log('wrote spike/scrcpy/keyframe.h264')
  socket.end()
  process.exit(0)
}

function drain(): void {
  for (;;) {
    if (stage === 'dummy') {
      if (buffer.length < 1) return
      if (buffer[0] !== 0) fail(`dummy byte 가 0 이 아니라 ${buffer[0]} 이다`)
      console.log('dummy byte ok')
      buffer = buffer.subarray(1)
      stage = 'deviceMeta'
      continue
    }

    if (stage === 'deviceMeta') {
      if (buffer.length < 64) return
      const name = buffer.subarray(0, 64).toString('utf8').replace(/\0.*$/, '')
      console.log('device name ' + JSON.stringify(name))
      buffer = buffer.subarray(64)
      stage = 'codecId'
      continue
    }

    if (stage === 'codecId') {
      if (buffer.length < 4) return
      codecName = buffer.subarray(0, 4).toString('latin1')
      console.log('codec id ' + JSON.stringify(codecName))
      buffer = buffer.subarray(4)
      stage = 'sessionMeta'
      continue
    }

    if (stage === 'sessionMeta') {
      if (buffer.length < 12) return
      const flags = buffer.readUInt32BE(0)
      width = buffer.readInt32BE(4)
      height = buffer.readInt32BE(8)
      console.log(`session meta flags=0x${flags.toString(16)} ${width}x${height}`)
      buffer = buffer.subarray(12)
      stage = 'packets'
      continue
    }

    if (buffer.length < 12) return
    const ptsAndFlags = buffer.readBigUInt64BE(0)
    const size = buffer.readUInt32BE(8)
    if (buffer.length < 12 + size) return

    const payload = Buffer.from(buffer.subarray(12, 12 + size))
    buffer = buffer.subarray(12 + size)

    const isConfig = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n
    const isKeyFrame = (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n
    const pts = ptsAndFlags & ((1n << 61n) - 1n)
    console.log(`packet size=${size} config=${isConfig} key=${isKeyFrame} pts=${pts}`)

    if (isConfig) {
      if (configPacket === null) configPacket = payload
      continue
    }
    if (isKeyFrame && keyFrame === null) {
      keyFrame = payload
      finish()
    }
  }
}

socket.on('data', (chunk: Buffer) => {
  raw.push(chunk)
  buffer = Buffer.concat([buffer, chunk])
  drain()
})

socket.on('error', (error) => {
  console.error('socket error', error)
  process.exit(1)
})

socket.on('close', () => {
  if (keyFrame === null) fail('키프레임을 받기 전에 소켓이 닫혔다')
})

setTimeout(() => fail('20초 안에 키프레임이 오지 않았다'), 20_000)
