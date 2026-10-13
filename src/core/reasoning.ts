// 起草模型思考等级的解析。纯函数，宿主模型只按结构传入。

export const reasoningLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof reasoningLevels)[number];

export interface ModelCapabilities {
    reasoning: boolean;
    // null 表示该等级不支持；缺省表示按宿主默认映射，视为支持。
    thinkingLevelMap?: Partial<Record<string, string | null>>;
}

export function supportedLevels(model: ModelCapabilities): ReasoningLevel[] {
    if (!model.reasoning) return [];
    return reasoningLevels.filter((level) => level !== "off" && model.thinkingLevelMap?.[level] !== null);
}

export interface ResolvedReasoning {
    // undefined 表示不传思考参数。
    level: ReasoningLevel | undefined;
    note?: string;
}

// 所选等级不支持时取最接近的较低等级，没有较低的取最接近的较高等级。
export function resolveReasoning(model: ModelCapabilities, wanted: ReasoningLevel): ResolvedReasoning {
    if (wanted === "off") return { level: undefined };
    const supported = supportedLevels(model);
    if (!supported.length) return { level: undefined, note: "该模型不支持思考等级" };
    if (supported.includes(wanted)) return { level: wanted };
    const rank = reasoningLevels.indexOf(wanted);
    const lower = supported.filter((level) => reasoningLevels.indexOf(level) < rank);
    const level = lower.length ? lower[lower.length - 1] : supported[0];
    return { level, note: `该模型不支持 ${wanted}，改用 ${level}` };
}
