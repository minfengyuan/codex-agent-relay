export type RelayError = { code: string; message: string };

export type RelayResult = {
  sessionId: string | null;
  stopReason: string | null;
  text: string;
  truncated: boolean;
  error?: RelayError;
};

export type DelegateInput = {
  task: string;
  cwd: string;
  sessionId?: string;
};

export class RelayFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly partial?: Partial<RelayResult>,
  ) {
    super(message);
    this.name = "RelayFailure";
  }
}
