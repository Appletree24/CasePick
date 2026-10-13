// RFC 8785（JCS）规范化，以及 Detroit 评测集格式的摘要（Detroit docs/10-dataset-format.md §4、§8）。
// 摘要 = "sha256:" + 规范化 JSON 的 UTF-8 字节的 SHA-256（小写十六进制）。
// 覆盖范围按协议正文，并以 Detroit 示例里的摘要为准，测试会逐个重新计算核对。

import { createHash } from "node:crypto";
import type { CaseDocument, DatasetDocument, InlineScoring, ScoringDocument, Task } from "../schema/case.ts";

// 落单的代理项不是合法的 I-JSON（RFC 7493），JCS 要求拒绝。成对的代理项在 u 模式下是一个码点，不会匹配。
const loneSurrogate = /\p{Surrogate}/u;

function reject(path: string, reason: string): never {
    throw new TypeError(`无法计算摘要：${path || "/"} ${reason}`);
}

function writeString(text: string, path: string): string {
    if (loneSurrogate.test(text)) reject(path, "含有落单的 UTF-16 代理项");
    // ES2019 起 JSON.stringify 的字符串转义和 RFC 8785 §3.2.2.2 一致。
    return JSON.stringify(text);
}

function isPlainObject(value: object): value is Record<string, unknown> {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string): string {
    switch (typeof value) {
        case "boolean":
            return value ? "true" : "false";
        case "string":
            return writeString(value, path);
        case "number":
            if (!Number.isFinite(value)) reject(path, `不是有限数：${value}`);
            // RFC 8785 §3.2.2.3 规定的就是 ECMAScript 的数字转字符串，-0 写成 0。
            return JSON.stringify(value);
        case "object": {
            if (value === null) return "null";
            if (Array.isArray(value)) {
                // Array.from 把空位读成 undefined，稀疏数组会被拒绝。
                return `[${Array.from(value, (item, i) => write(item, `${path}/${i}`)).join(",")}]`;
            }
            if (!isPlainObject(value)) reject(path, "不是普通对象");
            const members: string[] = [];
            // 默认的 sort() 按 UTF-16 码元比较，正是 RFC 8785 §3.2.3 要求的顺序。
            for (const key of Object.keys(value).sort()) {
                // 和 JSON.stringify 一样跳过 undefined：写进文件后这个属性本来就不存在。
                if (value[key] === undefined) continue;
                const at = `${path}/${key}`;
                members.push(`${writeString(key, at)}:${write(value[key], at)}`);
            }
            return `{${members.join(",")}}`;
        }
        default:
            return reject(path, `不是 JSON 值（${typeof value}）`);
    }
}

// RFC 8785 规范化。只接受 JSON 能表示的值，遇到 NaN、BigInt、Date、落单的代理项等直接抛 TypeError。
export function canonicalize(value: unknown): string {
    return write(value, "");
}

export function digestOf(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

// digests.task：task 整个对象。改标题、meta、diagnostic、provenance、scoring、extensions 都不会变成新题。
export function taskDigest(task: Task): string {
    return digestOf(task);
}

// digests.scoring 不覆盖的"信封"字段。§4 只列了 id 到 extensions；schema 和 digests 也不算在内，
// 和 Detroit 示例一致，这样内联评分原样单独导出时摘要不变。
const scoringEnvelope = new Set(["schema", "id", "revision", "label", "target", "producer", "extensions", "digests"]);

// 内联评分（case.scoring）和单独分发的评分文档都适用。
export function scoringDigest(scoring: InlineScoring | ScoringDocument): string {
    return digestOf(Object.fromEntries(Object.entries(scoring).filter(([key]) => !scoringEnvelope.has(key))));
}

// 一条案例的两个摘要，可以直接填进 digests。
export function caseDigests(doc: Pick<CaseDocument, "task" | "scoring">): CaseDocument["digests"] {
    return { task: taskDigest(doc.task), scoring: scoringDigest(doc.scoring) };
}

// digests.dataset：只覆盖 entries 和 purpose（协议 §8），作为评测集的版本号。
export function datasetDigest(dataset: Pick<DatasetDocument, "purpose" | "entries">): string {
    return digestOf({ purpose: dataset.purpose, entries: dataset.entries });
}
