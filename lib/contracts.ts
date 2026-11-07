export type MirrorAction = "reply" | "stop" | "pause" | "end";
export interface HistoryTurn { user: string; assistant: string; interrupted?: boolean }
export interface CameraFrame { data: string; mimeType: "image/jpeg"; capturedAt: number }
export interface TurnRequest {
  turnId: number;
  opening?: boolean;
  audio?: string;
  frame?: CameraFrame;
  history: HistoryTurn[];
}
export interface TurnResponse {
  turnId: number;
  transcript: string;
  reply: string;
  action: MirrorAction;
}
export interface ApiError { error: { code: string; message: string; retryable: boolean } }
