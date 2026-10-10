// When to run the categorization catch-up (spec 6.3): on launch (AppDataGate), when the app comes
// back to the foreground, and when the network comes back. No timers.
import { addNetworkStateListener, type NetworkState } from 'expo-network';
import { AppState, type AppStateStatus } from 'react-native';

/** Online unless the OS says there's no connection or the internet isn't reachable. */
export function isOnline(state: NetworkState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

/** True only for an offline → online change; the first state seen (`was` null) isn't a reconnect. */
export function cameOnline(was: boolean | null, now: boolean): boolean {
  return was === false && now;
}

/** True when the app returns to the foreground from another state. */
export function cameToForeground(was: AppStateStatus, now: AppStateStatus): boolean {
  return was !== 'active' && now === 'active';
}

/**
 * Calls `onCatchUp` on every return to the foreground and every reconnect, and `onNetwork` with
 * every connectivity change the OS reports (before `onCatchUp`). Returns a cleanup.
 */
export function startCatchUpTriggers(onCatchUp: () => void, onNetwork?: (online: boolean) => void): () => void {
  let appState = AppState.currentState;
  const app = AppState.addEventListener('change', (next) => {
    if (cameToForeground(appState, next)) onCatchUp();
    appState = next;
  });
  let online: boolean | null = null;
  const network = addNetworkStateListener((state) => {
    const now = isOnline(state);
    onNetwork?.(now);
    if (cameOnline(online, now)) onCatchUp();
    online = now;
  });
  return () => {
    app.remove();
    network.remove();
  };
}
