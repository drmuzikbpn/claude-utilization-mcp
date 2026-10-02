import { isLoopbackAddress } from '../server/middleware.js';

/**
 * How to pair a phone later — printed at the end of `install` and by `status` (§23.51), so
 * `claude-usage pair` is discoverable without reading the README. Kept tiny: `status` imports
 * it eagerly.
 */
export function pairingHint(bind: readonly string[]): string {
  return bind.some((entry) => !isLoopbackAddress(entry))
    ? 'pair a phone: claude-usage pair'
    : 'pair a phone: claude-usage configure lan on, then claude-usage pair';
}
