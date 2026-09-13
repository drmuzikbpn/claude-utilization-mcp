/**
 * W6 — install / configure / uninstall (§8, §20, §23.9–§23.11).
 *
 * `src/cli.ts` imports only the three `run*` entry points from here; everything else
 * is exported for tests and for the auto-updater (W8), which reuses the versions
 * layout and the service manager.
 */
export { runInstall } from './apply.js';
export { runUninstall } from './uninstall.js';
export { runConfigure } from './configure.js';
export type { InstallIO } from './context.js';
export { installVersion, resolvePackageRoot, repointSymlink } from './versions.js';
export { preflight, renderPreflight, type PreflightResult } from './preflight.js';
export {
  applySettings,
  removeSettings,
  HOOK_EVENTS,
  hookCommand,
  statuslineCommand,
  SettingsError,
} from './settings-merge.js';
export { addMcpServer, removeMcpServer, MCP_KEY } from './claude-json.js';
export { buildPlan, confirmPlan, parseInstallArgs, InstallError } from './plan.js';
