import type { ControlCommand } from "./types.ts";

export type DoorbellDelivery = "steer" | "followUp";
export interface FixedDoorbell { text: string; options: { deliverAs: DoorbellDelivery; expandPromptTemplates: false }; }

/** No dashboard/operator data enters this string: the parent must read it through mazzy_control. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function fixedControlDoorbell(requestId: string, command: ControlCommand, streaming: boolean): FixedDoorbell {
  if (!UUID.test(requestId)) throw new Error("Invalid control request id");
  return {
    text: `/skill:mazzy-orchestrator requestId=${requestId} command=${command}`,
    options: { deliverAs: command === "STOP" && streaming ? "steer" : "followUp", expandPromptTemplates: false },
  };
}
/** Discussion content is only read from durable storage by the interactive parent. */
export function fixedCommentDoorbell(taskId: string, commentId: string): FixedDoorbell {
  if (!UUID.test(taskId) || !UUID.test(commentId)) throw new Error("Invalid discussion identifier");
  return { text: `/skill:mazzy-orchestrator discussion taskId=${taskId} commentId=${commentId}`, options: { deliverAs: "followUp", expandPromptTemplates: false } };
}
