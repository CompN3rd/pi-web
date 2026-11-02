export interface ActiveSession<TRuntime> {
  runtime: TRuntime;
  unsubscribe: () => void;
}

export type GetActiveSession<TRuntime> = (sessionId: string) => Promise<ActiveSession<TRuntime>>;
