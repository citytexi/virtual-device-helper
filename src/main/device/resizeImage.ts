import { nativeImage } from 'electron'

export type ResizeImage = (
  png: Buffer,
  maxLongEdge: number
) => { png: Buffer; width: number; height: number }

/**
 * Electron의 nativeImage로 축소한다. 네이티브 이미지 라이브러리를 따로 들이지 않는다.
 * main 프로세스에서만 부를 수 있으므로 AndroidDevice는 이 함수를 주입받는다 —
 * 그래야 단위 테스트가 Electron 런타임 없이 돈다.
 */
export const electronResizeImage: ResizeImage = (png, maxLongEdge) => {
  const image = nativeImage.createFromBuffer(png)
  const size = image.getSize()
  const longEdge = Math.max(size.width, size.height)

  if (longEdge <= maxLongEdge) {
    return { png, width: size.width, height: size.height }
  }

  const ratio = maxLongEdge / longEdge
  const resized = image.resize({
    width: Math.round(size.width * ratio),
    height: Math.round(size.height * ratio),
    quality: 'good'
  })
  const resizedSize = resized.getSize()

  return { png: resized.toPNG(), width: resizedSize.width, height: resizedSize.height }
}
