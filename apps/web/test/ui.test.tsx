import { QueryClient } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App, createGateQueryClient } from "../src/app.js";
import {
  api,
  ApiError,
  errorText,
  formSchema,
  meSchema,
  payloadSchema,
  requestEnvelope,
  safeReturn,
} from "../src/api.js";
import type { GateRequest, Me } from "../src/api.js";

const digest = `sha256:${"a".repeat(64)}`;
const payload = {
  action: "release" as const,
  environment: "test" as const,
  candidate: "测试版本 1",
  artifactDigest: digest,
  summary: "测试发布说明",
};
const me: Me = {
  identity: { id: "kai", name: "Kai" },
  permissions: { canCreate: true, canDecide: true },
};
const request: GateRequest = {
  id: "request-1",
  status: "pending",
  requesterIdentityId: "lin",
  requesterType: "human",
  templateId: "release-review",
  templateVersion: 1,
  payloadSchemaVersion: 1,
  payload,
  payloadDigest: digest,
  threadId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  events: [
    {
      type: "created",
      actorIdentityId: "lin",
      occurredAt: "2026-10-14T12:00:00.000Z",
    },
  ],
  allowedActions: ["approve", "reject"],
};
const templates = {
  templates: [
    {
      id: "release-review",
      version: 1,
      payloadSchemaVersion: 1,
      title: "测试发布审核",
      description: "仅测试",
    },
  ],
};
let currentMe: Me | null;
let currentRequest: GateRequest;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let client: QueryClient;
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const failure = (status: number, code = "REQUEST_NOT_ACCESSIBLE") =>
  response(
    { error: { code, message: "请求失败", traceId: "trace-1" } },
    status,
  );

function mount(path: string) {
  window.history.replaceState(null, "", path);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<App client={client} />);
}
async function fillForm() {
  await screen.findByLabelText("版本名称（必填）");
  fireEvent.change(screen.getByLabelText("版本名称（必填）"), {
    target: { value: payload.candidate },
  });
  fireEvent.change(screen.getByLabelText("构建产物摘要（必填）"), {
    target: { value: digest },
  });
  fireEvent.change(screen.getByLabelText("请求说明（必填）"), {
    target: { value: payload.summary },
  });
  await userEvent.click(screen.getByRole("button", { name: "核对请求内容" }));
  await screen.findByRole("heading", { name: "核对不可变内容" });
}

beforeEach(() => {
  currentMe = structuredClone(me);
  currentRequest = structuredClone(request);
  fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, options) => {
      const path = String(input);
      if (path === "/api/bootstrap")
        return response({ providers: [{ id: "github", label: "GitHub" }] });
      if (path === "/api/me")
        return currentMe
          ? response(currentMe)
          : failure(401, "SESSION_REQUIRED");
      if (path === "/api/templates") return response(templates);
      if (path.startsWith("/api/requests?"))
        return response({ items: [], nextCursor: null });
      if (path === "/api/requests" && options?.method === "POST")
        return response(
          {
            request: {
              ...currentRequest,
              requesterIdentityId: "kai",
              allowedActions: ["withdraw"],
            },
          },
          201,
        );
      if (path.endsWith("/decision") || path.endsWith("/withdraw")) {
        const body: unknown = JSON.parse(String(options?.body));
        const decision =
          typeof body === "object" && body !== null && "decision" in body
            ? body.decision
            : "withdraw";
        currentRequest = {
          ...currentRequest,
          status:
            decision === "approve"
              ? "approved"
              : decision === "reject"
                ? "rejected"
                : "withdrawn",
          allowedActions: [],
          decidedBy: "kai",
          decidedAt: "2026-10-14T12:01:00.000Z",
        };
        return response({ request: currentRequest });
      }
      return response({ request: currentRequest });
    });

  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Requester identity type compatibility", () => {
  it.each([
    ["human", "人类"],
    ["agent", "Agent"],
    ["legacy", "历史来源未绑定"],
  ] as const)(
    "renders server-provided %s without inferring type from an ID prefix",
    async (kind, label) => {
      currentRequest = {
        ...request,
        requesterType: kind,
        requesterIdentityId: "opaque-stable-id",
      };
      mount("/requests/request-1");
      expect(
        await screen.findByText(`${label} · opaque-stable-id`),
      ).toBeTruthy();
    },
  );
  it("keeps old responses unbound rather than fabricating a human identity type", () => {
    expect(
      requestEnvelope.parse({
        request: { ...request, requesterType: undefined },
      }).request.requesterType,
    ).toBe("legacy");
    expect(() =>
      requestEnvelope.parse({
        request: { ...request, requesterType: "unrecognized" },
      }),
    ).toThrow();
  });
});

describe("typed API and safe navigation", () => {
  it("bounds query retries and backoff and disables mutation retries", () => {
    const options = createGateQueryClient().getDefaultOptions();
    const retry = options.queries?.retry;
    const delay = options.queries?.retryDelay;
    if (typeof retry !== "function" || typeof delay !== "function")
      throw new Error("missing retry policy");
    expect(retry(0, new Error("offline"))).toBe(true);
    expect(retry(2, new Error("offline"))).toBe(false);
    expect(retry(0, new ApiError(401, "SESSION_REQUIRED", "登录过期"))).toBe(
      false,
    );
    expect(
      retry(0, new ApiError(404, "REQUEST_NOT_ACCESSIBLE", "不可访问")),
    ).toBe(false);
    expect(retry(0, new ApiError(502, "INVALID_RESPONSE", "格式异常"))).toBe(
      false,
    );
    expect(delay(0, new Error())).toBe(1000);
    expect(delay(20, new Error())).toBe(60000);
    expect(options.mutations?.retry).toBe(false);
  });
  it("rejects malformed and extra payload fields without silently trimming", async () => {
    expect(
      payloadSchema.parse({ ...payload, candidate: "  v1  " }).candidate,
    ).toBe("  v1  ");
    expect(payloadSchema.safeParse({ ...payload, extra: true }).success).toBe(
      false,
    );
    expect(
      payloadSchema.safeParse({ ...payload, candidate: " " }).success,
    ).toBe(false);
    expect(formSchema.safeParse({ ...payload, threadId: " " }).success).toBe(
      false,
    );
    expect(
      requestEnvelope.safeParse({
        request: {
          ...request,
          payload: { ...payload, environment: "production" },
        },
      }).success,
    ).toBe(false);
    fetchMock.mockResolvedValueOnce(response({ identity: { id: "bad" } }));
    await expect(api("/api/me", meSchema)).rejects.toThrow("数据格式");
  });
  it("validates error envelopes, transport failures and unparseable responses", async () => {
    fetchMock.mockResolvedValueOnce(failure(403));
    await expect(api("/api/me", meSchema)).rejects.toMatchObject({
      status: 403,
      traceId: "trace-1",
    });
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 502 }));
    await expect(api("/api/me", meSchema)).rejects.toMatchObject({
      status: 502,
    });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(api("/api/me", meSchema)).rejects.toMatchObject({ status: 0 });
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(api("/api/me", meSchema)).rejects.toThrow("aborted");
    expect(
      errorText(new ApiError(500, "INTERNAL_ERROR", "失败", "trace")),
    ).toContain("trace");
    expect(errorText(new Error("失败"))).toBe("失败");
  });
  it.each([
    "https://evil.test/inbox",
    "//evil.test/inbox",
    "/\\evil.test",
    "/api/auth/signout",
    "/login",
    "/requests/%2F%2Fevil",
  ])("blocks unsafe return %s", (value) => {
    expect(safeReturn(value)).toBe("/inbox");
  });
  it("keeps only approved same-origin routes", () => {
    expect(safeReturn(null)).toBe("/inbox");
    expect(safeReturn("/requests/request-1?from=mail")).toBe(
      "/requests/request-1?from=mail",
    );
  });
});

describe("session and lists", () => {
  it("clears payloads when identity switches on page restoration", async () => {
    mount("/requests/request-1");
    await screen.findByText(payload.summary);
    currentMe = {
      identity: { id: "lin", name: "Lin" },
      permissions: { canCreate: true, canDecide: false },
    };
    currentRequest = {
      ...request,
      requesterIdentityId: "lin",
      allowedActions: ["withdraw"],
    };
    fireEvent(window, new Event("pageshow"));
    await screen.findByRole("button", { name: "准备撤回" });
    expect(
      client.getQueryCache().findAll({ queryKey: ["identity", "kai"] }),
    ).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "准备批准" })).toBeNull();
  });
  it("clears payload cache before following Auth.js sign-out confirmation", async () => {
    mount("/requests/request-1");
    await screen.findByText(payload.summary);
    const link = screen.getByRole("link", { name: "退出登录" });
    expect(link.getAttribute("href")).toBe("/api/auth/signout");
    link.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    await userEvent.click(link);
    expect(
      client.getQueryCache().findAll({ queryKey: ["identity"] }),
    ).toHaveLength(0);
  });
  it("treats /api/me 401 as signed out and provides GitHub only safe deep-link return", async () => {
    currentMe = null;
    mount("/requests/request-1");
    const login = await screen.findByRole("link", { name: "使用 GitHub 登录" });
    expect(login.getAttribute("href")).toBe(
      "/api/auth/signin/github?callbackUrl=%2Frequests%2Frequest-1",
    );
    expect(screen.queryByText("Google")).toBeNull();
  });
  it("renders session failure separately and retries", async () => {
    fetchMock.mockResolvedValueOnce(failure(503, "SERVICE_BUSY"));
    mount("/inbox");
    await screen.findByRole("button", { name: "重试登录检查" });
    await userEvent.click(screen.getByRole("button", { name: "重试登录检查" }));
    await screen.findByRole("heading", { name: "待我审批" });
  });
  it("does not offer an unconfigured OAuth provider", async () => {
    currentMe = null;
    fetchMock.mockImplementation(async (input) =>
      String(input) === "/api/me"
        ? failure(401, "SESSION_REQUIRED")
        : response({ providers: [] }),
    );
    mount("/login");
    await screen.findByText("尚未配置 GitHub 登录，请联系试点运维负责人。");
    expect(screen.queryByRole("link", { name: "使用 GitHub 登录" })).toBeNull();
  });
  it("fails closed on provider discovery errors and allows retry", async () => {
    currentMe = null;
    let failed = true;
    fetchMock.mockImplementation(async (input) =>
      String(input) === "/api/me"
        ? failure(401, "SESSION_REQUIRED")
        : failed
          ? failure(503, "SERVICE_BUSY")
          : response({ providers: [{ id: "github", label: "GitHub" }] }),
    );
    mount("/login");
    await screen.findByRole("button", { name: "重试登录入口" });
    expect(screen.queryByRole("link", { name: "使用 GitHub 登录" })).toBeNull();
    failed = false;
    await userEvent.click(screen.getByRole("button", { name: "重试登录入口" }));
    await screen.findByRole("link", { name: "使用 GitHub 登录" });
  });
  it("shows explicit empty inbox without granting permission", async () => {
    currentMe = { ...me, permissions: { canCreate: false, canDecide: false } };
    mount("/inbox");
    await screen.findByText("当前身份没有直接审批权限。");
    expect(screen.queryByRole("link", { name: "新建请求" })).toBeNull();
  });
  it("renders mine summaries, filters and cursor paging without downloading all requests", async () => {
    const summary = {
      id: request.id,
      status: request.status,
      requesterIdentityId: "lin",
      templateId: request.templateId,
      templateVersion: 1,
      payloadSchemaVersion: 1,
      candidate: payload.candidate,
      createdAt: request.createdAt,
    };
    fetchMock.mockImplementation(async (input) =>
      String(input) === "/api/me"
        ? response(me)
        : response({
            items: [summary],
            nextCursor: String(input).includes("cursor") ? null : "next-page",
          }),
    );
    mount("/requests/mine");
    await screen.findByRole("link", { name: payload.candidate });
    await userEvent.selectOptions(
      screen.getByLabelText("状态筛选"),
      "approved",
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path]) =>
          String(path).includes("status=approved"),
        ),
      ).toBe(true),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "下一页" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path]) =>
          String(path).includes("cursor=next-page"),
        ),
      ).toBe(true),
    );
    await userEvent.click(screen.getByRole("button", { name: "回到第一页" }));
    await userEvent.click(screen.getByRole("button", { name: "刷新列表" }));
  });
  it("shows list failure, not a success-shaped empty fallback", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === "/api/me" ? response(me) : failure(500),
    );
    mount("/inbox");
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: "暂无待办" })).toBeNull();
  });
  it.each(["/requests/mine", "/inbox"])(
    "ends loading visibly for malformed summary envelopes on %s",
    async (path) => {
      fetchMock.mockImplementation(async (input) =>
        String(input) === "/api/me"
          ? response(me)
          : response({
              items: [
                {
                  id: "request-1",
                  title: "not the candidate field",
                  status: "pending",
                },
              ],
              nextCursor: null,
            }),
      );
      mount(path);
      await screen.findByText("服务返回的数据格式不符合约定，未确认结果。");
      expect(screen.queryByText("正在读取请求…")).toBeNull();
      expect(screen.queryByText("暂无待办")).toBeNull();
      expect(screen.queryByText("尚无请求")).toBeNull();
    },
  );
  it("clears identity-scoped payload on session expiration", async () => {
    mount("/requests/request-1");
    await screen.findByRole("heading", { name: payload.candidate });
    fetchMock.mockImplementation(async (input) =>
      String(input) === "/api/bootstrap"
        ? response({ providers: [{ id: "github", label: "GitHub" }] })
        : failure(401, "SESSION_REQUIRED"),
    );
    await userEvent.click(screen.getByRole("button", { name: "刷新详情" }));
    await screen.findByRole("link", { name: "使用 GitHub 登录" });
    expect(
      client.getQueryCache().findAll({ queryKey: ["identity"] }),
    ).toHaveLength(0);
    expect(screen.queryByText(payload.summary)).toBeNull();
  });
});

describe("immutable creation", () => {
  it("warns before losing a draft and blocks declined navigation", async () => {
    mount("/requests/new");
    await fillForm();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(screen.getByRole("link", { name: "我的请求" }));
    expect(confirm).toHaveBeenCalledWith("离开后将丢失未提交草稿，是否离开？");
    expect(window.location.pathname).toBe("/requests/new");
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
  });
  it("shows failed template lookup and permits manual retry", async () => {
    const standard = fetchMock.getMockImplementation();
    let first = true;
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input) === "/api/templates" && first) {
        first = false;
        return failure(503);
      }
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/new");
    await userEvent.click(
      await screen.findByRole("button", { name: "重试模板读取" }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "核对请求内容",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });
  it("explains create conflict without silently changing key or creating another request", async () => {
    const standard = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input) === "/api/requests")
        return failure(409, "IDEMPOTENCY_CONFLICT");
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/new");
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "确认创建请求" }));
    await screen.findByText(/幂等键或请求状态冲突/);
    expect(
      (
        screen.getByRole("button", {
          name: "确认创建请求",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/requests"),
    ).toHaveLength(1);
  });
  it("clears all payload caches and returns to sign-in when create session expires", async () => {
    const standard = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input) === "/api/requests")
        return failure(401, "SESSION_REQUIRED");
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/new");
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "确认创建请求" }));
    await screen.findByRole("link", { name: "使用 GitHub 登录" });
    expect(
      client.getQueryCache().findAll({ queryKey: ["identity"] }),
    ).toHaveLength(0);
  });
  it("requires explicit acknowledgement to change uncertain snapshot then creates a new review", async () => {
    const standard = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input) === "/api/requests")
        return failure(503, "SERVICE_BUSY");
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/new");
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "确认创建请求" }));
    await screen.findByRole("button", { name: "原样重试提交" });
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole("button", { name: "返回修改" }));
    expect(
      screen.getByRole("heading", { name: "核对不可变内容" }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "返回修改" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    await screen.findByLabelText("版本名称（必填）");
  });
  it("validates fields, reviews snapshot, restores editing and submits fixed content", async () => {
    mount("/requests/new");
    await screen.findByRole("button", { name: "核对请求内容" });
    await userEvent.click(screen.getByRole("button", { name: "核对请求内容" }));
    await screen.findAllByText("请填写此字段");
    await fillForm();
    expect(document.activeElement?.textContent).toBe("核对不可变内容");
    await userEvent.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.queryByRole("button", { name: "确认创建请求" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Thread 分组（可选）"), {
      target: { value: "release-2026" },
    });
    await userEvent.click(screen.getByRole("button", { name: "核对请求内容" }));
    await userEvent.click(screen.getByRole("button", { name: "确认创建请求" }));
    await screen.findByRole("heading", { name: payload.candidate });
    const call = fetchMock.mock.calls.find(
      ([path, options]) =>
        path === "/api/requests" && options?.method === "POST",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      templateId: "release-review",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload,
      threadId: "release-2026",
    });
  });
  it("preserves exactly the same key and payload on uncertain create retry", async () => {
    const standard = fetchMock.getMockImplementation();
    let posts = 0;
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input) === "/api/requests" && ++posts === 1)
        throw new Error("timeout");
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/new");
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "确认创建请求" }));
    await screen.findByRole("button", { name: "原样重试提交" });
    await userEvent.click(screen.getByRole("button", { name: "原样重试提交" }));
    await screen.findByRole("heading", { name: payload.candidate });
    const calls = fetchMock.mock.calls.filter(
      ([path]) => path === "/api/requests",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.headers).toEqual(calls[1]?.[1]?.headers);
    expect(calls[0]?.[1]?.body).toBe(calls[1]?.[1]?.body);
  });
  it("shows denied creation and unavailable templates explicitly", async () => {
    currentMe = { ...me, permissions: { ...me.permissions, canCreate: false } };
    const view = mount("/requests/new");
    await screen.findByRole("heading", { name: "没有创建权限" });
    view.unmount();
    client.clear();
    currentMe = me;
    fetchMock.mockImplementation(async (input) =>
      String(input) === "/api/me" ? response(me) : response({ templates: [] }),
    );
    mount("/requests/new");
    await screen.findByText("当前没有可创建的测试发布模板。");
    expect(
      (
        screen.getByRole("button", {
          name: "核对请求内容",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("maps server field errors without losing input", async () => {
    const standard = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input) === "/api/requests")
        return response(
          {
            error: {
              code: "INVALID_INPUT",
              message: "校验失败",
              traceId: "t",
              fieldErrors: { "payload.candidate": ["版本无效"] },
            },
          },
          400,
        );
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/new");
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "确认创建请求" }));
    await screen.findByText("版本无效");
    expect(
      (screen.getByLabelText("版本名称（必填）") as HTMLInputElement).value,
    ).toBe(payload.candidate);
  });
});

describe("details and inline decisions", () => {
  it.each([401, 403, 404])(
    "clears sensitive content on decision HTTP %s",
    async (status) => {
      const standard = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (input, options) => {
        if (String(input).endsWith("/decision")) return failure(status);
        if (!standard) throw new Error("missing mock");
        return standard(input, options);
      });
      mount("/requests/request-1");
      await userEvent.click(
        await screen.findByRole("button", { name: "准备批准" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "确认批准" }));
      if (status === 401)
        await screen.findByRole("link", { name: "使用 GitHub 登录" });
      else await screen.findByRole("heading", { name: "不可访问或不存在" });
      expect(screen.queryByText(payload.summary)).toBeNull();
      expect(
        client.getQueryData(["identity", "kai", "detail", "request-1"]),
      ).toBeUndefined();
    },
  );
  it("shows detail loading failure separately and retries manually", async () => {
    const standard = fetchMock.getMockImplementation();
    let failed = false;
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input) === "/api/requests/request-1" && !failed) {
        failed = true;
        return failure(503);
      }
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/request-1");
    await userEvent.click(
      await screen.findByRole("button", { name: "重新读取详情" }),
    );
    await screen.findByRole("heading", { name: payload.candidate });
  });
  it("marks cached details stale on read failure and disables decisions", async () => {
    mount("/requests/request-1");
    await screen.findByText(payload.summary);
    fetchMock.mockImplementation(async () => failure(503));
    await userEvent.click(screen.getByRole("button", { name: "刷新详情" }));
    await screen.findByText(/状态可能陈旧/);
    expect(
      (screen.getByRole("button", { name: "准备批准" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("refreshes terminal conflict rather than announcing decision success", async () => {
    const standard = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith("/decision")) {
        currentRequest = {
          ...request,
          status: "withdrawn",
          allowedActions: [],
          decidedBy: "lin",
          decidedAt: request.createdAt,
          events: [
            ...request.events,
            {
              type: "withdrawn",
              actorIdentityId: "lin",
              occurredAt: request.createdAt,
            },
          ],
        };
        return failure(409, "REQUEST_TERMINAL");
      }
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/request-1");
    await userEvent.click(
      await screen.findByRole("button", { name: "准备批准" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认批准" }));
    await screen.findByText(/实际操作身份：lin/);
    expect(screen.queryByRole("button", { name: "准备批准" })).toBeNull();
    expect(screen.queryByText("已批准")).toBeNull();
  });
  it.each(["approve", "reject"] as const)(
    "requires inline confirmation for %s and restores cancel focus",
    async (action) => {
      mount("/requests/request-1");
      const label = action === "approve" ? "批准" : "拒绝";
      const trigger = await screen.findByRole("button", {
        name: `准备${label}`,
      });
      await userEvent.click(trigger);
      expect(document.activeElement?.textContent).toBe(`确认${label}`);
      expect(screen.getByText("实际操作人：Kai（kai）")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(document.activeElement).toBe(trigger);
      expect(
        fetchMock.mock.calls.filter(
          ([, options]) => options?.method === "POST",
        ),
      ).toHaveLength(0);
      await userEvent.click(trigger);
      await userEvent.click(
        screen.getByRole("button", { name: `确认${label}` }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: `准备${label}` }),
        ).toBeNull(),
      );
      expect(screen.getByText(/实际操作身份：kai/)).toBeTruthy();
    },
  );
  it("independently prevents self-approval even if server action list is wrong", async () => {
    currentRequest = {
      ...request,
      requesterIdentityId: "kai",
      allowedActions: ["approve", "reject", "withdraw"],
    };
    mount("/requests/request-1");
    const trigger = await screen.findByRole("button", { name: "准备撤回" });
    expect(screen.queryByRole("button", { name: "准备批准" })).toBeNull();
    expect(screen.queryByRole("button", { name: "准备拒绝" })).toBeNull();
    await userEvent.click(trigger);
    await screen.findByText("撤回不删除历史。此操作不可撤销。");
    await userEvent.click(screen.getByRole("button", { name: "确认撤回" }));
    await screen.findByRole("link", { name: "基于此请求新建" });
  });
  it("obeys allowedActions and never grants withdrawal to a different requester", async () => {
    currentRequest = { ...request, allowedActions: ["withdraw"] };
    mount("/requests/request-1");
    await screen.findByRole("heading", { name: payload.candidate });
    expect(screen.queryByRole("button", { name: /准备/ })).toBeNull();
  });
  it("refetches an uncertain decision once, never automatically repeats writes", async () => {
    const standard = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith("/decision")) throw new Error("timeout");
      if (!standard) throw new Error("missing mock");
      return standard(input, options);
    });
    mount("/requests/request-1");
    await userEvent.click(
      await screen.findByRole("button", { name: "准备批准" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认批准" }));
    await screen.findByText(/不会自动重发/);
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "确认批准" })).toBeNull();
    expect(screen.getByRole("button", { name: "准备批准" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "刷新详情" }));
    await waitFor(() => expect(screen.queryByText(/不会自动重发/)).toBeNull());
  });
  it("removes sensitive details and cache after 404 instead of displaying stale content", async () => {
    mount("/requests/request-1");
    await screen.findByText(payload.summary);
    fetchMock.mockImplementation(async () => failure(404));
    await userEvent.click(screen.getByRole("button", { name: "刷新详情" }));
    await screen.findByRole("heading", { name: "不可访问或不存在" });
    expect(screen.queryByText(payload.summary)).toBeNull();
    expect(
      client.getQueryData(["identity", "kai", "detail", "request-1"]),
    ).toBeUndefined();
  });
  it("shows terminal history without actions and permits a new reviewed draft", async () => {
    currentRequest = {
      ...request,
      status: "rejected",
      allowedActions: [],
      threadId: "group",
      decidedBy: "kai",
      decidedAt: request.createdAt,
      events: [
        ...request.events,
        {
          type: "rejected",
          actorIdentityId: "kai",
          occurredAt: request.createdAt,
        },
      ],
    };
    mount("/requests/request-1");
    const link = await screen.findByRole("link", { name: "基于此请求新建" });
    expect(screen.queryByRole("button", { name: /准备/ })).toBeNull();
    expect(screen.getByText("group")).toBeTruthy();
    await userEvent.click(link);
    await screen.findByLabelText("版本名称（必填）");
    expect(
      (screen.getByLabelText("版本名称（必填）") as HTMLInputElement).value,
    ).toBe(payload.candidate);
    expect(screen.queryByRole("button", { name: "确认创建请求" })).toBeNull();
  });
});
