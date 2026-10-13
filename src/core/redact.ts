// 发给起草模型之前的本地脱敏（技术设计第 10 节）。只作用于外发文字，不改写案例。

export interface RedactionHit {
    kind: string;
    count: number;
}

interface Rule {
    kind: string;
    pattern: RegExp;
    replace: string | ((match: string, ...groups: string[]) => string);
}

const rules: Rule[] = [
    { kind: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[已脱敏:私钥]" },
    { kind: "api_key", pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, replace: "[已脱敏:API_KEY]" },
    { kind: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "[已脱敏:TOKEN]" },
    { kind: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[已脱敏:AWS_KEY]" },
    { kind: "bearer", pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, replace: "$1 [已脱敏:TOKEN]" },
    { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: "[已脱敏:JWT]" },
    // .env 风格的赋值：名字里带 KEY / TOKEN / SECRET / PASSWORD。
    {
        kind: "env_secret",
        pattern: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[=:]\s*(["']?)[^\s"']{6,}\2/g,
        replace: "$1=[已脱敏]",
    },
    // 本机用户目录替换为 ~。
    { kind: "home_path", pattern: /(?:\/Users|\/home)\/[A-Za-z0-9._-]+(?=\/|\b)/g, replace: "~" },
];

export function redact(text: string): { text: string; hits: RedactionHit[] } {
    const counts = new Map<string, number>();
    let result = text;
    for (const rule of rules) {
        result = result.replace(rule.pattern, (...args) => {
            counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
            const match = args[0] as string;
            if (typeof rule.replace === "function") return rule.replace(match, ...(args.slice(1, -2) as string[]));
            return match.replace(new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "")), rule.replace);
        });
    }
    return { text: result, hits: [...counts].map(([kind, count]) => ({ kind, count })) };
}
