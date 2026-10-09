export class SpeechError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
