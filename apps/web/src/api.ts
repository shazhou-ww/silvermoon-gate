import { z } from "zod";

const nonblank = (max: number) =>
  z
    .string()
    .min(1, "请填写此字段")
    .max(max, `最多 ${max} 个字符`)
    .refine((value) => value.trim().length > 0, "不能只包含空白");
export const payloadSchema = z
  .object({
    action: z.literal("release"),
    candidate: nonblank(100),
    artifactDigest: z
      .string()
      .regex(
        /^sha256:[a-f0-9]{64}$/,
        "请输入 sha256: 和 64 位小写十六进制摘要",
      ),
    environment: z.literal("test"),
    summary: nonblank(500),
  })
  .strict();
export const formSchema = payloadSchema.extend({
  threadId: z
    .string()
    .max(100, "最多 100 个字符")
    .refine(
      (value) => value === "" || value.trim().length > 0,
      "不能只包含空白",
    ),
});
export type Payload = z.infer<typeof payloadSchema>;
export type FormValues = z.infer<typeof formSchema>;
export const meSchema = z.object({
  identity: z.object({ id: z.string().min(1), name: z.string() }),
  permissions: z.object({ canCreate: z.boolean(), canDecide: z.boolean() }),
});
export type Me = z.infer<typeof meSchema>;
export const bootstrapSchema = z.object({
  providers: z.array(z.object({ id: z.literal("github"), label: z.string() })),
});
const statusSchema = z.enum(["pending", "approved", "rejected", "withdrawn"]);
export const requesterTypeSchema = z
  .enum(["human", "agent", "legacy"])
  .default("legacy");
export const requesterTypeLabel = {
  human: "人类",
  agent: "Agent",
  legacy: "历史来源未绑定",
} as const;
export const summarySchema = z.object({
  id: z.string().min(1),
  status: statusSchema,
  requesterIdentityId: z.string().min(1),
  requesterType: requesterTypeSchema,
  templateId: z.literal("release-review"),
  templateVersion: z.literal(1),
  payloadSchemaVersion: z.literal(1),
  candidate: z.string(),
  createdAt: z.string().datetime(),
});
export const requestSchema = z.object({
  id: z.string().min(1),
  status: statusSchema,
  requesterIdentityId: z.string().min(1),
  requesterType: requesterTypeSchema,
  templateId: z.literal("release-review"),
  templateVersion: z.literal(1),
  payloadSchemaVersion: z.literal(1),
  payload: payloadSchema,
  payloadDigest: z.string().min(1),
  threadId: z.string().nullable(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  decidedBy: z.string().nullable(),
  events: z.array(
    z.object({
      type: z.enum(["created", "approved", "rejected", "withdrawn"]),
      actorIdentityId: z.string(),
      occurredAt: z.string().datetime(),
    }),
  ),
  allowedActions: z.array(z.enum(["approve", "reject", "withdraw"])),
});
export type GateRequest = z.infer<typeof requestSchema>;
export type Action = GateRequest["allowedActions"][number];
export const requestEnvelope = z.object({
  request: requestSchema,
  replayed: z.boolean().optional(),
});
export const listSchema = z.object({
  items: z.array(summarySchema),
  nextCursor: z.string().nullable(),
});
export const templatesSchema = z.object({
  templates: z.array(
    z.object({
      id: z.string(),
      version: z.number().int(),
      payloadSchemaVersion: z.number().int(),
      title: z.string(),
      description: z.string(),
    }),
  ),
});
const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    traceId: z.string(),
    fieldErrors: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional(),
  }),
});

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public traceId = "",
    public fieldErrors?: z.infer<typeof errorSchema>["error"]["fieldErrors"],
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(0, "NETWORK_ERROR", "连接中断，结果尚未确认。");
  }
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(raw);
    if (parsed.success) {
      const { code, message, traceId, fieldErrors } = parsed.data.error;
      throw new ApiError(response.status, code, message, traceId, fieldErrors);
    }
    throw new ApiError(
      response.status,
      "INVALID_RESPONSE",
      `服务响应异常（HTTP ${response.status}）`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      502,
      "INVALID_RESPONSE",
      "服务返回的数据格式不符合约定，未确认结果。",
    );
  return parsed.data;
}

export function safeReturn(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\s]/.test(value)
  )
    return "/inbox";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "/inbox";
    if (
      !/^\/(?:inbox|requests\/(?:mine|new|[A-Za-z0-9_-]+))$/.test(url.pathname)
    )
      return "/inbox";
    return url.pathname + url.search;
  } catch {
    return "/inbox";
  }
}

export function errorText(error: Error): string {
  return error instanceof ApiError && error.traceId
    ? `${error.message}（跟踪 ID：${error.traceId}）`
    : error.message;
}
