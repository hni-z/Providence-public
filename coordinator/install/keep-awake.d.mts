export type KeepAwakeMethod = 'caffeinate-idle' | 'windows-execution-state' | 'logind-idle';
export type KeepAwakeReason = 'idle_sleep_inhibited' | 'unsupported_platform' | 'invalid_parent' | 'helper_unavailable' | 'assertion_unavailable' | 'startup_unconfirmed' | 'helper_exited' | 'stopped' | 'stop_unconfirmed';
export interface KeepAwakeStatus {
  active: boolean;
  method?: KeepAwakeMethod;
  reason?: KeepAwakeReason;
}
export interface KeepAwakeHandle {
  readonly status: KeepAwakeStatus;
  stop(): Promise<void>;
}
export function startKeepAwake(options?: {
  platform?: NodeJS.Platform;
  parentPid?: number;
  onChange?: (status: KeepAwakeStatus) => void;
}): Promise<KeepAwakeHandle>;
export function ownsMacIdleAssertion(output: string, pid: number): boolean;
