import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { useForm } from "react-hook-form";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";

import {
  api,
  ApiError,
  bootstrapSchema,
  errorText,
  formSchema,
  listSchema,
  meSchema,
  requestEnvelope,
  safeReturn,
  templatesSchema,
} from "./api.js";
import type { Action, FormValues, Me, Payload } from "./api.js";
import { Alert, Badge, Button, Card } from "./ui.js";

const Session = createContext<Me | null>(null);
export function createGateQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) =>
          !(
            error instanceof ApiError &&
            ([401, 403, 404].includes(error.status) ||
              error.code === "INVALID_RESPONSE")
          ) && count < 2,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 60000),
        staleTime: 0,
      },
      mutations: { retry: false },
    },
  });
}
const defaultClient = createGateQueryClient();
export function App({ client = defaultClient }: { client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function useMe(): Me {
  const value = useContext(Session);
  if (!value) throw new Error("缺少当前身份");
  return value;
}

function Gate() {
  const client = useQueryClient();
  const location = useLocation();
  const previousIdentity = useRef<string | null>(null);
  const [authEpoch, setAuthEpoch] = useState(0);
  const me = useQuery({
    queryKey: ["me", authEpoch],
    queryFn: async ({ signal }) => {
      try {
        return await api("/api/me", meSchema, { signal });
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    refetchOnWindowFocus: true,
  });
  const identity = me.data?.identity.id ?? null;
  const settled = me.isSuccess;
  useEffect(() => {
    if (!settled) return;
    if (previousIdentity.current !== identity) {
      const oldIdentity = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          query.queryKey[0] === "identity" && query.queryKey[1] !== identity,
      };
      void client.cancelQueries(oldIdentity);
      client.removeQueries(oldIdentity);
      previousIdentity.current = identity;
    }
  }, [client, identity, settled]);
  useEffect(() => {
    return client.getQueryCache().subscribe((event) => {
      const error = event.query.state.error;
      if (
        event.query.queryKey[0] !== "identity" ||
        !(error instanceof ApiError)
      )
        return;
      if (error.status === 401) {
        void client.cancelQueries({ queryKey: ["identity"] });
        client.removeQueries({ queryKey: ["identity"] });
        client.setQueryData(["me", authEpoch], null);
      } else if (
        [403, 404].includes(error.status) &&
        event.query.state.data !== undefined
      ) {
        client.removeQueries({ queryKey: event.query.queryKey, exact: true });
      }
    });
  }, [authEpoch, client]);
  useEffect(() => {
    const refresh = () => {
      setAuthEpoch((value) => value + 1);
    };
    window.addEventListener("pageshow", refresh);
    return () => window.removeEventListener("pageshow", refresh);
  }, []);
  if (me.isPending)
    return (
      <main className="shell">
        <p role="status">正在确认登录身份…</p>
      </main>
    );
  if (me.isError)
    return (
      <main className="shell">
        <Alert>{errorText(me.error)}</Alert>
        <Button onClick={() => void me.refetch()}>重试登录检查</Button>
      </main>
    );
  if (!me.data) {
    if (location.pathname !== "/login")
      return (
        <Navigate
          replace
          to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
        />
      );
    return <Login />;
  }
  function signout() {
    void client.cancelQueries();
    client.clear();
  }
  return (
    <Session.Provider value={me.data}>
      <div className="shell">
        <header className="masthead">
          <Link className="brand" to="/inbox">
            <span className="brand-mark" aria-hidden="true" />
            Silvermoon Gate
          </Link>
          <div className="identity">
            <span>{me.data.identity.name}</span>
            <a
              className="button secondary"
              href="/api/auth/signout"
              onClick={signout}
            >
              退出登录
            </a>
          </div>
        </header>
        <nav aria-label="主要导航">
          <Link to="/inbox">待我审批</Link>
          <Link to="/requests/mine">我的请求</Link>
          {me.data.permissions.canCreate && (
            <Link to="/requests/new">新建请求</Link>
          )}
        </nav>
        <main>
          <Routes>
            <Route
              path="/login"
              element={
                <Navigate
                  replace
                  to={safeReturn(
                    new URLSearchParams(location.search).get("returnTo"),
                  )}
                />
              }
            />
            <Route path="/inbox" element={<RequestList view="inbox" />} />
            <Route
              path="/requests/mine"
              element={<RequestList view="mine" />}
            />
            <Route
              path="/requests/new"
              element={<CreateRequest key={identity} />}
            />
            <Route
              path="/requests/:id"
              element={<Detail key={`${identity}:${location.pathname}`} />}
            />
            <Route path="*" element={<Navigate replace to="/inbox" />} />
          </Routes>
        </main>
        <footer>受限试点 · 仅测试发布 · 在线结果，无离线凭证</footer>
      </div>
    </Session.Provider>
  );
}

function Login() {
  const location = useLocation();
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: ({ signal }) => api("/api/bootstrap", bootstrapSchema, { signal }),
  });
  const returnTo = safeReturn(
    new URLSearchParams(location.search).get("returnTo"),
  );
  return (
    <main className="shell login">
      <p className="eyebrow">SILVERMOON GATE / 人类审批</p>
      <h1>
        让每一次测试发布
        <br />
        有清晰的决定。
      </h1>
      <Card>
        <h2>登录受限试点</h2>
        <p>
          使用 GitHub 身份登录。登录不代表获得创建或审批权限；权限由 Gate
          单独配置。
        </p>
        {bootstrap.isPending && <p role="status">正在检查登录入口…</p>}
        {bootstrap.isError && (
          <Alert>
            {errorText(bootstrap.error)}
            <Button onClick={() => void bootstrap.refetch()}>
              重试登录入口
            </Button>
          </Alert>
        )}
        {bootstrap.data?.providers.some(
          (provider) => provider.id === "github",
        ) ? (
          <a
            className="button"
            href={`/api/auth/signin/github?callbackUrl=${encodeURIComponent(returnTo)}`}
          >
            使用 GitHub 登录
          </a>
        ) : (
          bootstrap.isSuccess && (
            <Alert>尚未配置 GitHub 登录，请联系试点运维负责人。</Alert>
          )
        )}
        <p className="muted">
          请求内容创建后不可修改。审批人必须与请求方不同。
        </p>
      </Card>
    </main>
  );
}

function useIdentityQuery<T>(
  key: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  polling = false,
) {
  const me = useMe();
  return useQuery({
    queryKey: ["identity", me.identity.id, ...key],
    queryFn: ({ signal }) => load(signal),
    refetchInterval: polling
      ? (query) => Math.min(15000 * 2 ** query.state.fetchFailureCount, 60000)
      : false,
    refetchIntervalInBackground: false,
  });
}

function RequestList({ view }: { view: "mine" | "inbox" }) {
  const me = useMe();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const query = useIdentityQuery(
    ["list", view, status, cursor],
    (signal) => {
      const params = new URLSearchParams({ view, limit: "20" });
      if (status) params.set("status", status);
      if (cursor) params.set("cursor", cursor);
      return api(`/api/requests?${params}`, listSchema, { signal });
    },
    true,
  );
  const accessLost =
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            {view === "mine" ? "我的发起记录" : "直接人类权限"}
          </p>
          <h1>{view === "mine" ? "我的请求" : "待我审批"}</h1>
        </div>
        {me.permissions.canCreate && (
          <Link className="button" to="/requests/new">
            新建测试发布请求
          </Link>
        )}
      </div>
      {view === "mine" && (
        <label className="filter">
          状态筛选
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setCursor(null);
            }}
          >
            <option value="">全部状态</option>
            <option value="pending">等待审批</option>
            <option value="approved">已批准</option>
            <option value="rejected">已拒绝</option>
            <option value="withdrawn">已撤回</option>
          </select>
        </label>
      )}
      {query.isPending && <p role="status">正在读取请求…</p>}
      {query.isError && (
        <Alert>
          {errorText(query.error)}
          {query.data && <p>列表可能陈旧，不能据此确认最新状态。</p>}
        </Alert>
      )}
      {query.data && !accessLost && (
        <>
          <p className="muted">
            最后确认：{formatTime(new Date(query.dataUpdatedAt).toISOString())}
          </p>
          {query.data.items.length === 0 ? (
            <Card>
              <h2>{view === "mine" ? "尚无请求" : "暂无待办"}</h2>
              <p>
                {view === "inbox" && !me.permissions.canDecide
                  ? "当前身份没有直接审批权限。"
                  : "此列表没有符合条件的请求。"}
              </p>
              <Link to="/requests/mine">查看我的请求</Link>
            </Card>
          ) : (
            <ul className="request-list">
              {query.data.items.map((item) => (
                <li key={item.id}>
                  <Card>
                    <div className="request-row">
                      <Link
                        to={`/requests/${encodeURIComponent(item.id)}`}
                        className="request-title"
                      >
                        {item.candidate}
                      </Link>
                      <Badge status={item.status} />
                    </div>
                    <p className="muted">
                      请求方 {item.requesterIdentityId} · 模板 v
                      {item.templateVersion} · {formatTime(item.createdAt)}
                    </p>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          {query.data.nextCursor && (
            <Button
              className="secondary"
              onClick={() => setCursor(query.data.nextCursor)}
            >
              下一页
            </Button>
          )}
          {cursor && (
            <Button className="secondary" onClick={() => setCursor(null)}>
              回到第一页
            </Button>
          )}
        </>
      )}
      <Button
        className="secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        刷新列表
      </Button>
    </>
  );
}

type Snapshot = { payload: Payload; threadId?: string; key: string };
type CreateState =
  | { stage: "edit" }
  | { stage: "review"; snapshot: Snapshot; uncertain: boolean };
function createReducer(
  state: CreateState,
  event:
    | { type: "edit" }
    | { type: "review"; snapshot: Snapshot }
    | { type: "uncertain" },
): CreateState {
  if (event.type === "edit") return { stage: "edit" };
  if (event.type === "review")
    return { stage: "review", snapshot: event.snapshot, uncertain: false };
  return state.stage === "review" ? { ...state, uncertain: true } : state;
}

function CreateRequest() {
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const [state, dispatch] = useReducer(createReducer, { stage: "edit" });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abort = useRef<AbortController | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const templates = useIdentityQuery(["templates"], (signal) =>
    api("/api/templates", templatesSchema, { signal }),
  );
  const copied = requestEnvelope.shape.request.shape.payload.safeParse(
    (location.state as { payload?: unknown } | null)?.payload,
  );
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      action: "release",
      environment: "test",
      candidate: "",
      artifactDigest: "",
      summary: "",
      ...(copied.success ? copied.data : {}),
      threadId: "",
    },
  });
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (state.stage === "review") reviewHeading.current?.focus();
  }, [state.stage]);
  const dirty = form.formState.isDirty;
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
      }
    };
    const click = (event: MouseEvent) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest("a") : null;
      if (
        dirty &&
        link &&
        link.getAttribute("href") !== location.pathname &&
        !window.confirm("离开后将丢失未提交草稿，是否离开？")
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, location.pathname]);
  const template = templates.data?.templates.find(
    (item) =>
      item.id === "release-review" &&
      item.version === 1 &&
      item.payloadSchemaVersion === 1,
  );
  if (!me.permissions.canCreate)
    return (
      <Card>
        <h1>没有创建权限</h1>
        <p>登录不授予业务权限。</p>
        <Link to="/requests/mine">返回我的请求</Link>
      </Card>
    );
  async function submit() {
    if (state.stage !== "review" || sending) return;
    setSending(true);
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const result = await api("/api/requests", requestEnvelope, {
        method: "POST",
        signal: controller.signal,
        headers: { "Idempotency-Key": state.snapshot.key },
        body: JSON.stringify({
          templateId: "release-review",
          templateVersion: 1,
          payloadSchemaVersion: 1,
          payload: state.snapshot.payload,
          ...(state.snapshot.threadId
            ? { threadId: state.snapshot.threadId }
            : {}),
        }),
      });
      form.reset();
      await client.invalidateQueries({
        queryKey: ["identity", me.identity.id, "list"],
      });
      navigate(`/requests/${encodeURIComponent(result.request.id)}`, {
        replace: true,
      });
    } catch (caught: unknown) {
      const failure =
        caught instanceof Error ? caught : new Error("结果尚未确认");
      setError(failure);
      if (caught instanceof ApiError && caught.status === 401) {
        await clearIdentity(client);
        client.setQueriesData({ queryKey: ["me"] }, null);
        navigate(`/login?returnTo=${encodeURIComponent("/requests/new")}`);
      } else if (
        caught instanceof ApiError &&
        caught.status === 400 &&
        caught.fieldErrors
      ) {
        for (const field of [
          "candidate",
          "artifactDigest",
          "summary",
          "threadId",
        ] as const) {
          const message =
            caught.fieldErrors[field] ?? caught.fieldErrors[`payload.${field}`];
          if (message)
            form.setError(field, {
              type: "server",
              message: Array.isArray(message) ? message.join("；") : message,
            });
        }
        dispatch({ type: "edit" });
      } else if (
        !(caught instanceof ApiError) ||
        caught.status === 0 ||
        caught.status >= 500
      )
        dispatch({ type: "uncertain" });
    } finally {
      clearTimeout(timer);
      setSending(false);
    }
  }
  return (
    <>
      <p className="eyebrow">RELEASE REVIEW / V1</p>
      <h1>新建测试发布请求</h1>
      <p>
        固定模板 release-review v1 · 载荷 schema v1。Gate
        不执行发布，不能用于生产发布。
      </p>
      {templates.isPending && <p role="status">正在确认模板权限…</p>}
      {templates.isError && (
        <Alert>
          {errorText(templates.error)}
          <Button onClick={() => void templates.refetch()}>重试模板读取</Button>
        </Alert>
      )}
      {templates.isSuccess && !template && (
        <Alert>当前没有可创建的测试发布模板。</Alert>
      )}
      {error && (
        <Alert>
          {errorText(error)}
          {error instanceof ApiError && error.status === 409 && (
            <p>
              幂等键或请求状态冲突。不要自动创建另一份请求；请查看我的请求确认结果。
            </p>
          )}
        </Alert>
      )}
      {state.stage === "edit" ? (
        <Card>
          <form
            noValidate
            onSubmit={form.handleSubmit((values) => {
              const { threadId, ...payload } = values;
              dispatch({
                type: "review",
                snapshot: {
                  payload: Object.freeze({ ...payload }),
                  ...(threadId ? { threadId } : {}),
                  key: crypto.randomUUID(),
                },
              });
              setError(null);
            })}
          >
            <p className="fixed-value">操作：发布 · 环境：测试（test）</p>
            {(
              ["candidate", "artifactDigest", "summary", "threadId"] as const
            ).map((field) => (
              <div className="form-field" key={field}>
                <label htmlFor={field}>
                  {fieldLabels[field]}
                  {field === "threadId" ? "（可选）" : "（必填）"}
                </label>
                {field === "summary" ? (
                  <textarea
                    id={field}
                    maxLength={500}
                    rows={5}
                    {...form.register(field)}
                    aria-invalid={!!form.formState.errors[field]}
                    aria-describedby={`${field}-hint ${field}-error`}
                  />
                ) : (
                  <input
                    id={field}
                    maxLength={field === "artifactDigest" ? 71 : 100}
                    {...form.register(field)}
                    aria-invalid={!!form.formState.errors[field]}
                    aria-describedby={`${field}-hint ${field}-error`}
                  />
                )}
                <p className="hint" id={`${field}-hint`}>
                  {fieldHints[field]}
                </p>
                <p
                  className="field-error"
                  id={`${field}-error`}
                  role={form.formState.errors[field] ? "alert" : undefined}
                >
                  {form.formState.errors[field]?.message}
                </p>
              </div>
            ))}
            <Button type="submit" disabled={!template}>
              核对请求内容
            </Button>
          </form>
        </Card>
      ) : (
        <Card>
          <h2 tabIndex={-1} ref={reviewHeading}>
            核对不可变内容
          </h2>
          <PayloadView payload={state.snapshot.payload} />
          <p>模板 release-review v1 · schema v1</p>
          {state.snapshot.threadId && <p>Thread：{state.snapshot.threadId}</p>}
          <p>
            创建后不可编辑。请核对完整构建产物摘要；业务摘要不同于 Gate
            载荷摘要。
          </p>
          {state.uncertain && (
            <Alert>
              结果尚未确认。原样重试会使用相同幂等键和同一份内容，不会自动重复创建。
            </Alert>
          )}
          <div className="actions">
            <Button
              disabled={
                sending || (error instanceof ApiError && error.status === 409)
              }
              onClick={() => void submit()}
            >
              {sending
                ? "正在提交…"
                : state.uncertain
                  ? "原样重试提交"
                  : "确认创建请求"}
            </Button>
            <Button
              className="secondary"
              disabled={sending}
              onClick={() => {
                if (
                  !state.uncertain ||
                  window.confirm(
                    "上一份请求可能已创建。修改后将使用新键，请先确认我的请求。仍要修改？",
                  )
                ) {
                  dispatch({ type: "edit" });
                  setError(null);
                }
              }}
            >
              返回修改
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

const fieldLabels = {
  candidate: "版本名称",
  artifactDigest: "构建产物摘要",
  summary: "请求说明",
  threadId: "Thread 分组",
};
const fieldHints = {
  candidate: "1–100 字符，不能仅包含空白。",
  artifactDigest: "sha256: 后接 64 位小写十六进制。",
  summary: "1–500 字符，按纯文本展示。",
  threadId: "最多 100 字符；分组不授予访问权限。",
};
const actionLabels: Record<Action, string> = {
  approve: "批准",
  reject: "拒绝",
  withdraw: "撤回",
};

function Detail() {
  const { id = "" } = useParams();
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const abort = useRef<AbortController | null>(null);
  const query = useQuery({
    queryKey: ["identity", me.identity.id, "detail", id],
    queryFn: ({ signal }) =>
      api(`/api/requests/${encodeURIComponent(id)}`, requestEnvelope, {
        signal,
      }),
    enabled: !accessRevoked,
    refetchInterval: (queryState) =>
      queryState.state.data?.request.status === "pending"
        ? Math.min(15000 * 2 ** queryState.state.fetchFailureCount, 60000)
        : false,
    refetchIntervalInBackground: false,
  });
  const request = query.data?.request;
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (confirm) heading.current?.focus();
  }, [confirm]);
  const inaccessible =
    query.error instanceof ApiError && [403, 404].includes(query.error.status);
  if (inaccessible || accessRevoked)
    return (
      <Card>
        <h1>不可访问或不存在</h1>
        <p>此请求的详情和历史已清除。</p>
        <Link to="/requests/mine">返回我的请求</Link>
      </Card>
    );
  if (!request)
    return query.isError ? (
      <Alert>
        {errorText(query.error)}
        <Button onClick={() => void query.refetch()}>重新读取详情</Button>
      </Alert>
    ) : (
      <p role="status">正在读取请求…</p>
    );
  const actions =
    request.status === "pending"
      ? request.allowedActions.filter((action) =>
          action === "withdraw"
            ? request.requesterIdentityId === me.identity.id
            : request.requesterIdentityId !== me.identity.id &&
              me.permissions.canDecide,
        )
      : [];
  function cancel() {
    setConfirm(null);
    queueMicrotask(() => trigger.current?.focus());
  }
  async function decide(action: Action) {
    if (sending || !actions.includes(action)) return;
    setSending(true);
    setError(null);
    setConfirm(null);
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const result = await api(
        `/api/requests/${encodeURIComponent(id)}/${action === "withdraw" ? "withdraw" : "decision"}`,
        requestEnvelope,
        {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify(
            action === "withdraw" ? {} : { decision: action },
          ),
        },
      );
      client.setQueryData(["identity", me.identity.id, "detail", id], result);
      await client.invalidateQueries({
        queryKey: ["identity", me.identity.id, "list"],
      });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught : new Error("结果尚未确认"));
      if (caught instanceof ApiError && caught.status === 401) {
        await clearIdentity(client);
        client.setQueriesData({ queryKey: ["me"] }, null);
        navigate(`/login?returnTo=${encodeURIComponent(`/requests/${id}`)}`);
      } else if (
        caught instanceof ApiError &&
        [403, 404].includes(caught.status)
      ) {
        client.removeQueries({
          queryKey: ["identity", me.identity.id, "detail", id],
          exact: true,
        });
        setAccessRevoked(true);
      } else {
        setUncertain(true);
        await query.refetch();
      }
    } finally {
      clearTimeout(timer);
      setSending(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">请求 / {request.id}</p>
          <h1>{request.payload.candidate}</h1>
        </div>
        <Badge status={request.status} />
      </div>
      {query.isError && (
        <Alert>{errorText(query.error)}状态可能陈旧，请刷新确认。</Alert>
      )}
      {error && <Alert>{errorText(error)}</Alert>}
      {uncertain && (
        <Alert>
          操作结果尚未确认；已重新读取详情，不会自动重发。若仍等待审批，必须重新确认后再操作。
        </Alert>
      )}
      <p className="muted">
        最后确认：{formatTime(new Date(query.dataUpdatedAt).toISOString())} · 每
        15 秒检查等待状态；隐藏页面暂停。
      </p>
      <Card>
        <h2>固定业务内容</h2>
        <PayloadView payload={request.payload} />
        <dl>
          <dt>模板 / Schema</dt>
          <dd>
            {request.templateId} v{request.templateVersion} / v
            {request.payloadSchemaVersion}
          </dd>
          <dt>Gate 载荷摘要</dt>
          <dd className="digest">{request.payloadDigest}</dd>
          <dt>请求方稳定身份</dt>
          <dd>{request.requesterIdentityId}</dd>
          <dt>创建时间</dt>
          <dd>{formatTime(request.createdAt)}</dd>
          {request.threadId && (
            <>
              <dt>Thread</dt>
              <dd>{request.threadId}</dd>
            </>
          )}
        </dl>
      </Card>
      <Card>
        <h2>在线审批结果</h2>
        <p>
          <Badge status={request.status} /> ·
          在线结果，无离线凭证；批准不表示实际发布已发生。
        </p>
        {request.decidedBy && (
          <p>
            实际操作身份：{request.decidedBy} ·{" "}
            {request.decidedAt && formatTime(request.decidedAt)}
          </p>
        )}
        <div className="actions">
          {actions.map((action) => (
            <Button
              key={action}
              className={action === "approve" ? "" : "secondary"}
              disabled={sending || query.isFetching || query.isError}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setConfirm(action);
              }}
            >
              {sending ? "正在提交…" : `准备${actionLabels[action]}`}
            </Button>
          ))}
        </div>
        {confirm && actions.includes(confirm) && (
          <section className="confirmation" aria-labelledby="confirm-heading">
            <h3 id="confirm-heading" tabIndex={-1} ref={heading}>
              确认{actionLabels[confirm]}
            </h3>
            <p>
              实际操作人：{me.identity.name}（{me.identity.id}）
            </p>
            <p>
              请求：{request.id} · {request.payload.candidate}
            </p>
            <p className="digest">Gate 载荷摘要：{request.payloadDigest}</p>
            <p>
              {confirm === "withdraw"
                ? "撤回不删除历史。"
                : "请求内容不可修改，首个终态决定生效。"}
              此操作不可撤销。
            </p>
            <div className="actions">
              <Button
                disabled={sending || query.isFetching || query.isError}
                onClick={() => void decide(confirm)}
              >
                确认{actionLabels[confirm]}
              </Button>
              <Button className="secondary" onClick={cancel}>
                取消
              </Button>
            </div>
          </section>
        )}
        {["rejected", "withdrawn"].includes(request.status) &&
          me.permissions.canCreate && (
            <Link
              className="button secondary"
              to="/requests/new"
              state={{ payload: request.payload }}
            >
              基于此请求新建
            </Link>
          )}
      </Card>
      <Card>
        <h2>不可改写的历史</h2>
        <ol className="history">
          {request.events.map((event, index) => (
            <li key={`${event.type}-${index}`}>
              <strong>
                {event.type === "created"
                  ? "已创建"
                  : actionLabels[
                      event.type === "approved"
                        ? "approve"
                        : event.type === "rejected"
                          ? "reject"
                          : "withdraw"
                    ]}
              </strong>
              <span>稳定身份 {event.actorIdentityId}</span>
              <time dateTime={event.occurredAt}>
                {formatTime(event.occurredAt)}
              </time>
            </li>
          ))}
        </ol>
      </Card>
      <Button
        className="secondary"
        disabled={query.isFetching || sending}
        onClick={async () => {
          const result = await query.refetch();
          if (result.isSuccess) {
            setUncertain(false);
            setError(null);
          }
        }}
      >
        刷新详情
      </Button>
    </>
  );
}

function PayloadView({ payload }: { payload: Payload }) {
  return (
    <dl>
      <dt>操作 / 环境</dt>
      <dd>发布 / 测试（test）</dd>
      <dt>版本名称</dt>
      <dd>{payload.candidate}</dd>
      <dt>构建产物摘要</dt>
      <dd className="digest">{payload.artifactDigest}</dd>
      <dt>请求说明</dt>
      <dd className="plain-text">{payload.summary}</dd>
    </dl>
  );
}
function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
async function clearIdentity(client: QueryClient) {
  await client.cancelQueries({ queryKey: ["identity"] });
  client.removeQueries({ queryKey: ["identity"] });
}
import { zodResolver } from "@hookform/resolvers/zod";
