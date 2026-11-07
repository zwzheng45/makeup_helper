export type MirrorAction = "reply" | "stop" | "pause" | "end";
export interface HistoryTurn { user: string; assistant: string; interrupted?: boolean }
export interface CameraFrame { data: string; mimeType: "image/jpeg"; capturedAt: number }
export type MirrorMode = "general" | "guided" | "compare";
export interface ReferenceImage { data: string; mimeType: "image/jpeg" }
export interface GuidanceContext {
  goal: string;
  currentStep: string;
  completedSummary: string;
  complete: boolean;
}
export interface TurnRequest {
  turnId: number;
  opening?: boolean;
  audio?: string;
  frame?: CameraFrame;
  mode?: MirrorMode;
  reference?: ReferenceImage;
  guidanceContext?: GuidanceContext;
  history: HistoryTurn[];
}
export interface TurnResponse {
  turnId: number;
  transcript: string;
  reply: string;
  action: MirrorAction;
  guidanceContext?: GuidanceContext;
}
export interface ApiError { error: { code: string; message: string; retryable: boolean } }

/** Opt-in application/x-ndjson response from POST /api/turn. Audio is mono PCM16LE. */
export type TurnEvent = { turnId: number; seq: number } & (
  | { type: "meta"; transcript: string; action: MirrorAction; guidanceContext?: GuidanceContext }
  | { type: "text"; segmentId: number; text: string }
  | { type: "audio"; segmentId: number; data: string; sampleRate: 24000; end?: boolean }
  | { type: "done"; response: TurnResponse }
  | { type: "error"; error: ApiError["error"] }
);
