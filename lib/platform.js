/**
 * 虚拟机插件的平台声明。
 *
 * 与 SSH 保险库插件不同，这里**不**把插件限制在 Windows：`vmrun` 随 VMware Workstation
 * （Windows / Linux）与 VMware Fusion（macOS）一起安装，三条平台上的命令形态基本一致，
 * 差异集中在「去哪儿找可执行文件」与「怎样读宿主进程占用」两处，二者都已分层处理
 * （`lib/vmrun.js` 负责发现，`lib/metrics.js` 负责占用）。
 *
 * 因此这里只声明支持范围，并在完全未知的平台上拒绝加载：继续跑只会在第一次调用时
 * 抛一个更难懂的 ENOENT。
 *
 * @module dsh-vm-control/platform
 */

import { t } from './i18n.js'

/** 支持的操作系统，取值同 Node 的 `process.platform`。 */
export const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux'])

/** 平台显示名。 */
const PLATFORM_LABELS = Object.freeze({
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  sunos: 'SunOS',
  aix: 'AIX',
  android: 'Android',
})

/**
 * 平台显示名。
 * @param platform - `process.platform` 取值。
 * @returns `Windows` / `macOS` / `Linux` 等；未知平台原样返回。
 */
export function platformLabel(platform = process.platform) {
  return PLATFORM_LABELS[platform] ?? String(platform)
}

/**
 * 该平台是否受支持。
 * @param platform - `process.platform` 取值。
 * @returns 受支持时为 true。
 */
export function isSupportedPlatform(platform = process.platform) {
  return SUPPORTED_PLATFORMS.includes(platform)
}

/**
 * 断言当前平台受支持，否则抛出一条可读的错误。
 *
 * 故意抛错而不是返回布尔值：加载路径上任何「继续跑」都会在第一次调用 vmrun 时
 * 以一个指向系统库的 ENOENT 收尾，那比这里的一句话难排查得多。
 *
 * @param platform - `process.platform` 取值；测试可显式传入。
 * @throws 平台不在 {@link SUPPORTED_PLATFORMS} 中时。
 */
export function assertSupportedPlatform(platform = process.platform) {
  if (isSupportedPlatform(platform)) return
  throw new Error(t('platform.unsupported', {
    platform: platformLabel(platform),
    raw: String(platform),
    supported: SUPPORTED_PLATFORMS.map((value) => platformLabel(value)).join(', '),
  }))
}
