import type { VirtualDeviceEntry } from '../../shared/types/device'
import { deviceError } from '../../shared/types/errors'
import { parseSimctlDevices, type SimulatorEntry } from '../device/parsers/simctlDevices'
import type { VirtualDeviceSource } from '../device/virtualDeviceCatalog'
import type { SimctlClient } from './simctlClient'

/** bootstatus -b는 부팅이 끝날 때까지 막는다. 첫 부팅은 오래 걸려서 AVD와 같은 180초를 준다. */
const BOOT_TIMEOUT_MS = 180_000

export interface SimulatorCatalogDeps {
  simctl: SimctlClient
}

/** iOS 시뮬레이터의 목록·부팅·종료. id와 serial은 모두 UDID다. */
export function createSimulatorCatalog({ simctl }: SimulatorCatalogDeps): VirtualDeviceSource {
  async function readAll(): Promise<SimulatorEntry[]> {
    return parseSimctlDevices((await simctl.exec(['list', 'devices', '-j'])).stdout)
  }

  return {
    platform: 'ios',

    async list(): Promise<VirtualDeviceEntry[]> {
      return (await readAll()).map((entry) => {
        const running = entry.state === 'Booted'
        return {
          platform: 'ios',
          id: entry.udid,
          name: entry.name,
          running,
          serial: running ? entry.udid : null,
          osVersion: entry.osVersion
        }
      })
    },

    async boot(udid: string): Promise<string> {
      const found = (await readAll()).find((entry) => entry.udid === udid)
      if (!found) {
        throw deviceError('command_failed', `그런 시뮬레이터가 없다: ${udid}`, 'device_list로 사용할 수 있는 시뮬레이터 id를 확인해라', { udid })
      }
      // 이미 떠 있는 기기에 boot를 다시 부르면 simctl이 상태 오류로 답해 원인이 흐려진다.
      if (found.state === 'Booted') {
        throw deviceError('command_failed', `${found.name}은 이미 실행 중이다`, '그 기기를 그대로 쓰려면 device_select로 고르고, 다시 부팅하려면 device_shutdown 후 시도해라', {
          udid,
          serial: udid
        })
      }

      await simctl.exec(['boot', udid])
      await simctl.exec(['bootstatus', udid, '-b'], { timeoutMs: BOOT_TIMEOUT_MS })
      return udid
    },

    async shutdown(serial: string): Promise<void> {
      await simctl.exec(['shutdown', serial])
    }
  }
}
