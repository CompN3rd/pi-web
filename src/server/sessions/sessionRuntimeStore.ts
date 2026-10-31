export interface ActiveSession<TRuntime> {
  runtime: TRuntime;
  unsubscribe: () => void;
  initializing?: Promise<void>;
}

export type GetActiveSession<TRuntime> = (sessionId: string) => Promise<ActiveSession<TRuntime>>;
