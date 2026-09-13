import type { ServiceManager, ServiceState } from './index.js';

/**
 * `--no-service`, and any platform that is neither darwin nor linux: every operation
 * is a no-op and the service always reports `not-installed`.
 */
export class NoopService implements ServiceManager {
  readonly kind = 'noop' as const;
  readonly unitPath = '';

  async install(): Promise<void> {
    /* nothing to install */
  }

  async uninstall(): Promise<void> {
    /* nothing to remove */
  }

  async start(): Promise<void> {
    /* nothing to start */
  }

  async stop(): Promise<void> {
    /* nothing to stop */
  }

  async restart(): Promise<void> {
    /* nothing to restart */
  }

  async status(): Promise<ServiceState> {
    return 'not-installed';
  }

  async logTail(): Promise<string[]> {
    return [];
  }
}
