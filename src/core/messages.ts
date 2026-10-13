import type { AssistantMessage, Message, Provenance, Task } from "../schema/case.ts";

export interface RecordedEntry {
    id: string;
    message: Message;
    interrupted?: boolean;
    toolError?: boolean;
}

// 宿主已按截止点重建的独立快照，输入不包含 observed 和 followup。
export interface CaseContext {
    sessionKey: string;
    cutoffEntry: string;
    hostVersion: string;
    input: RecordedEntry[];
    observed: AssistantMessage;
    followup: Message[];
    system: Task["system"];
    tools: Task["tools"];
    limitations: NonNullable<Provenance["limitations"]>;
    transforms: NonNullable<Provenance["transforms"]>;
}

export function contextSource(context: CaseContext) {
    return {
        entries: [...context.input, { id: context.cutoffEntry, message: context.observed }],
        cutoffEntry: context.cutoffEntry,
    };
}
