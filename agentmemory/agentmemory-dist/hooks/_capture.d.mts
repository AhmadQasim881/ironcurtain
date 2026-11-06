//#region src/functions/privacy.d.ts
declare function stripPrivateData(input: string): string;
//#endregion
//#region src/hooks/_capture.d.ts
declare const REST_URL: string;
type CaptureOutcome = "delivered" | "duplicate" | "rejected" | "spooled" | "dropped";
interface ObserveBody {
  hookType: string;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: unknown;
  eventId?: string;
}
declare function authHeaders(): Record<string, string>;
declare function withEventId(body: ObserveBody, host: Record<string, unknown>, content?: unknown, options?: {
  stable?: boolean;
}): ObserveBody;
declare function captureObservation(body: ObserveBody, timeoutMs: number): Promise<CaptureOutcome>;
declare function isDrainChild(): boolean;
declare function runDrainChild(): Promise<void>;
//#endregion
export { CaptureOutcome, ObserveBody, REST_URL, authHeaders, captureObservation, isDrainChild, runDrainChild, stripPrivateData, withEventId };
//# sourceMappingURL=_capture.d.mts.map