import type { Platform, VirtualDeviceEntry } from '../../shared/types/device'
import { deviceError } from '../../shared/types/errors'

/** 플랫폼 하나의 가상 기기 목록과 부팅·종료. AVD와 iOS 시뮬레이터가 각각 구현한다. */
export interface VirtualDeviceSource {
  readonly platform: Platform
  list(): Promise<VirtualDeviceEntry[]>
  /** 부팅 완료까지 기다리고 serial을 돌려준다. */
  boot(id: string): Promise<string>
  shutdown(serial: string): Promise<void>
}

/** 소스들을 한 목록으로 묶고 id·platform으로 알맞은 소스에 보낸다. */
export interface VirtualDeviceCatalog {
  list(): Promise<VirtualDeviceEntry[]>
  boot(id: string): Promise<string>
  shutdown(serial: string, platform: Platform): Promise<void>
}

export function createVirtualDeviceCatalog(sources: VirtualDeviceSource[]): VirtualDeviceCatalog {
  /** 소스별 목록. 한 소스가 실패해도 나머지는 남기고, 실패는 로그로만 남긴다. */
  async function listBySource(): Promise<Array<{ source: VirtualDeviceSource; entries: VirtualDeviceEntry[] }>> {
    const settled = await Promise.all(
      sources.map(async (source) => {
        try {
          return { source, entries: await source.list() }
        } catch (thrown) {
          console.error(`가상 기기 목록을 읽지 못했다 (${source.platform}):`, thrown)
          return null
        }
      })
    )
    return settled.filter((item): item is NonNullable<typeof item> => item !== null)
  }

  async function list(): Promise<VirtualDeviceEntry[]> {
    return (await listBySource()).flatMap((item) => item.entries)
  }

  async function boot(id: string): Promise<string> {
    const groups = await listBySource()
    const owner = groups.find((group) => group.entries.some((entry) => entry.id === id))
    if (!owner) {
      throw deviceError('command_failed', `그런 가상 기기가 없다: ${id}`, 'device_list로 id를 확인해라', {
        available: groups.flatMap((group) => group.entries.map((entry) => entry.id))
      })
    }
    return owner.source.boot(id)
  }

  async function shutdown(serial: string, platform: Platform): Promise<void> {
    const source = sources.find((candidate) => candidate.platform === platform)
    if (!source) {
      throw deviceError('command_failed', `${platform} 가상 기기 소스가 없다`, '이 플랫폼을 지원하는 도구가 설치돼 있는지 확인해라', {
        platform
      })
    }
    return source.shutdown(serial)
  }

  return { list, boot, shutdown }
}
