// Persists source health transitions in the event store so restarts keep blind state.

import { getMetaValue, setMetaValue, type Store } from './store.ts';

export type HealthTransitionType = 'blind' | 'recovered';

export interface HealthTransition {
  type: HealthTransitionType;
  atUtc: string;
}

export interface SourceHealth {
  consecutiveFailedCycles: number;
  blindSinceUtc?: string;
  isBlind: boolean;
  transition?: HealthTransition;
}

const CONSECUTIVE_FAILURES_META = 'source_health:consecutive_failed_cycles';
const BLIND_SINCE_META = 'source_health:blind_since_utc';

export class SourceHealthMonitor {
  private current: SourceHealth;
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    const failures = Number(getMetaValue(store, CONSECUTIVE_FAILURES_META) ?? '0');
    const blindSinceUtc = getMetaValue(store, BLIND_SINCE_META) || undefined;
    this.current = {
      consecutiveFailedCycles: Number.isSafeInteger(failures) && failures >= 0 ? failures : 0,
      isBlind: blindSinceUtc !== undefined,
      ...(blindSinceUtc === undefined ? {} : { blindSinceUtc }),
    };
  }

  recordCycleHealth(
    listEntryCounts: readonly number[],
    cycleSucceeded: boolean,
    now: Date,
  ): SourceHealth {
    const consecutiveFailedCycles = cycleSucceeded ? 0 : this.current.consecutiveFailedCycles + 1;
    const emptyListPage = listEntryCounts.some((count) => count === 0);
    const allRequiredListsRecovered = cycleSucceeded && listEntryCounts.length > 0 && listEntryCounts.every((count) => count > 0);
    const isBlind = this.current.isBlind
      ? !allRequiredListsRecovered
      : emptyListPage || consecutiveFailedCycles >= 3;
    const nowUtc = now.toISOString();
    const transition: HealthTransition | undefined = !this.current.isBlind && isBlind
      ? { type: 'blind', atUtc: nowUtc }
      : this.current.isBlind && !isBlind
        ? { type: 'recovered', atUtc: nowUtc }
        : undefined;
    const blindSinceUtc = isBlind ? this.current.blindSinceUtc ?? nowUtc : undefined;

    this.current = {
      consecutiveFailedCycles,
      isBlind,
      ...(blindSinceUtc === undefined ? {} : { blindSinceUtc }),
      ...(transition === undefined ? {} : { transition }),
    };
    setMetaValue(this.store, CONSECUTIVE_FAILURES_META, String(consecutiveFailedCycles));
    setMetaValue(this.store, BLIND_SINCE_META, blindSinceUtc ?? '');
    return this.current;
  }

  isBlind(): boolean {
    return this.current.isBlind;
  }

  state(): SourceHealth {
    return this.current;
  }
}
