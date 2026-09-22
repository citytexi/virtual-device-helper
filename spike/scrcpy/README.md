# 스파이크: scrcpy 서버 → WebCodecs 디코딩

## 질문

고정한 버전의 `scrcpy-server.jar`을 기기에 푸시하고 비디오 소켓을 열어서,
첫 H.264 키프레임을 받아 renderer의 WebCodecs `VideoDecoder`로 디코딩해
한 프레임을 그릴 수 있나?

## 성공 기준

`VideoDecoder`의 output 콜백이 최소 한 번 프레임을 내놓으면 Electron 프로세스가
exit 0으로 끝난다. 그렇지 않으면 exit 1. 그린 프레임은 `frame.png`로 떨어뜨려
사람이 눈으로 확인한다.

## 이 코드의 수명

버린다. 성공해도 M2에서 처음부터 다시 쓴다. 본 코드(`src/`)는 이 디렉토리를
절대 import 하지 않는다.

## 실패 시 후퇴안

- main에서 ffmpeg으로 디코딩해 프레임을 renderer로 넘긴다.
- `adb exec-out screencap` 폴링으로 내려앉는다.

둘 다 M2의 모양이 달라지며 ADR-0002를 대체한다.

## 재현 절차

```bash
export ANDROID_HOME=~/Library/Android/sdk
export PATH="$ANDROID_HOME/platform-tools:$PATH"

adb push vendor/scrcpy/scrcpy-server.jar /data/local/tmp/scrcpy-server.jar
adb forward tcp:27183 localabstract:scrcpy

# 첫 인자는 클라이언트 버전이며 서버의 BuildConfig.VERSION_NAME 과 정확히 같아야 한다.
# 나머지는 key=value 쌍이다. Options.parse 가 받는 키만 쓸 수 있다.
adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
  app_process / com.genymobile.scrcpy.Server 4.1 \
  tunnel_forward=true video=true audio=false control=false cleanup=false \
  video_codec=h264 max_size=1024 &

npx --yes tsx spike/scrcpy/probe.ts          # 소켓 파싱 → keyframe.h264 + stream.json
npx electron spike/scrcpy/electron-main.js   # WebCodecs 디코딩 → frame.png, exit 0/1
```

## v4.1 비디오 소켓 와이어 포맷

`server/src/main/java/com/genymobile/scrcpy/device/DesktopConnection.java`,
`device/Streamer.java`, `video/SurfaceEncoder.java`에서 읽었다.
아래는 모두 기본 옵션(`send_dummy_byte`, `send_device_meta`, `send_stream_meta`,
`send_frame_meta`가 전부 true)일 때의 순서다.

| 순서 | 크기 | 내용 |
|---|---|---|
| 1 | 1 byte | dummy byte `0x00` (`DesktopConnection.open`) |
| 2 | 64 bytes | 기기 이름, UTF-8, 남는 자리는 `0x00` (`sendDeviceMeta`) |
| 3 | 4 bytes | codec id. h264 = `0x68323634` = ASCII `"h264"` (`writeVideoHeader`) |
| 4 | 12 bytes | session meta: flags(4) + width(4) + height(4), 전부 big-endian. flags 최상위 비트가 1 (`writeSessionMeta`) |
| 5.. | 12 + N | 프레임 패킷이 반복된다 |

프레임 패킷 헤더는 12바이트다.

- `ptsAndFlags`: 8 bytes big-endian
  - bit 62 (`0x4000000000000000`) = config 패킷. 미디어가 아니라 코덱 설정(SPS/PPS)이다.
  - bit 61 (`0x2000000000000000`) = 키프레임
  - 나머지 하위 비트 = PTS(마이크로초)
- `packetSize`: 4 bytes big-endian. 뒤따르는 페이로드 바이트 수.

즉 **프레임 경계는 길이 선두 프레이밍으로 주어진다.** Annex-B start code를 스캔할
필요가 없다. 페이로드 자체는 Annex-B(`00 00 00 01` start code)다.

SPS/PPS는 첫 config 패킷 안에 Annex-B로 들어 있다. WebCodecs `VideoDecoder`는
`description`이 없으면 Annex-B로 간주하므로, config 패킷 바이트를 첫 키프레임 앞에
그대로 붙여 하나의 `EncodedVideoChunk`(type `'key'`)로 넣으면 된다.

`codec` 문자열은 SPS에서 뽑는다. NAL 헤더(`0x67`) 다음 3바이트가
`profile_idc`, `constraint_flags`, `level_idc`이고, 이걸 16진수로 이어 붙이면
`avc1.PPCCLL`이 된다.
