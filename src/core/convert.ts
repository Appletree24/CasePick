import type { Message, Provenance, ToolCall } from "../schema/case.ts";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image" };
type ThinkingBlock = { type: "thinking" | "redactedThinking" };
type ToolBlock = { type: "toolCall"; id: string; name: string; arguments: unknown };

// 结构类型由宿主适配层传入，core 不依赖 Pi。
export type RecordedMessage =
    | { role: "user"; content: string | readonly (TextBlock | ImageBlock)[] }
    | { role: "assistant"; content: readonly (TextBlock | ThinkingBlock | ToolBlock)[] }
    | { role: "toolResult"; toolCallId: string; content: readonly (TextBlock | ImageBlock)[] };

export function convertMessage(recorded: RecordedMessage, target: string): {
    message: Message;
    transforms: NonNullable<Provenance["transforms"]>;
} {
    const transforms: NonNullable<Provenance["transforms"]> = [];
    if (typeof recorded.content === "string") {
        return { message: { role: "user", content: recorded.content }, transforms };
    }
    const text: string[] = [];
    const calls: ToolCall[] = [];
    for (const block of recorded.content) {
        switch (block.type) {
            case "text": text.push(block.text); break;
            case "image":
                text.push("[图片已省略]");
                transforms.push({ type: "omit_image", target, detail: "图片替换为文字标记，依赖图片的要求无法据此判定" });
                break;
            case "thinking":
            case "redactedThinking":
                transforms.push({ type: "drop_thinking", target, detail: "不保留思考内容或签名" });
                break;
            case "toolCall": {
                const args = JSON.stringify(block.arguments);
                if (args === undefined) throw new Error("工具参数不能转换为 JSON");
                calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: args } });
                break;
            }
        }
    }
    // 不添加宿主原文没有的换行，防止更改引文和工具输出。
    const content = text.join("");
    switch (recorded.role) {
        case "user": return { message: { role: "user", content }, transforms };
        case "toolResult": return { message: { role: "tool", tool_call_id: recorded.toolCallId, content }, transforms };
        case "assistant": return {
            message: calls.length ? { role: "assistant", content: content || null, tool_calls: calls }
                : { role: "assistant", content },
            transforms,
        };
    }
}
