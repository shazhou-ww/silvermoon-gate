import type {
  AuthProviderDescriptor,
  BootstrapResponse,
  SessionResponse,
} from "@workspace/contracts";

export type DashboardState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly bootstrap: BootstrapResponse;
      readonly session: SessionResponse | null;
    };

export function Dashboard({ state }: { readonly state: DashboardState }) {
  return (
    <main className="shell">
      <header className="masthead">
        <a className="brand" href="/" aria-label="Silvermoon Gate home">
          <span className="brand-mark" aria-hidden="true" />
          <span>
            {state.kind === "ready"
              ? state.bootstrap.appName
              : "Silvermoon Gate"}
          </span>
        </a>
        <p>Cloudflare fullstack starter</p>
      </header>

      <div className="workspace">
        <section className="briefing" aria-labelledby="briefing-title">
          <p className="context">Identity, interface, edge</p>
          <h1 id="briefing-title">A calm place for fast-moving work.</h1>
          <p className="lede">
            One deployable Worker serves the API and the React interface.
            Authentication stays at the edge, close to every request.
          </p>

          <ol className="signal-track" aria-label="Application layers">
            <li>
              <span className="track-node" aria-hidden="true" />
              <strong>Identity</strong>
              <span>Google, Microsoft, and GitHub</span>
            </li>
            <li>
              <span className="track-node" aria-hidden="true" />
              <strong>Worker</strong>
              <span>Typed Hono routes on Cloudflare</span>
            </li>
            <li>
              <span className="track-node" aria-hidden="true" />
              <strong>Interface</strong>
              <span>React assets on the same origin</span>
            </li>
          </ol>
        </section>

        <aside className="access" aria-labelledby="access-title">
          <p className="context">Workspace access</p>
          <AccessPanel state={state} />
        </aside>
      </div>

      <footer>
        <span>Worker status</span>
        <strong>Ready at the edge</strong>
      </footer>
    </main>
  );
}

function AccessPanel({ state }: { readonly state: DashboardState }) {
  if (state.kind === "loading") {
    return (
      <div className="notice" role="status">
        <span className="activity" aria-hidden="true" />
        <p id="access-title">Checking your session...</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="notice error" role="alert">
        <h2 id="access-title">The Worker did not respond.</h2>
        <p>{state.message}</p>
        <a className="secondary-action" href="/">
          Try again
        </a>
      </div>
    );
  }

  if (state.session?.user) {
    const { user } = state.session;
    return (
      <div className="identity">
        {user.image ? (
          <img src={user.image} alt="" className="avatar" />
        ) : (
          <span className="avatar fallback" aria-hidden="true">
            {getInitial(user.name ?? user.email ?? "S")}
          </span>
        )}
        <h2 id="access-title">{user.name ?? "Signed in"}</h2>
        {user.email ? <p>{user.email}</p> : null}
        <a className="secondary-action" href="/api/auth/signout">
          Sign out
        </a>
      </div>
    );
  }

  return (
    <div className="signin">
      <h2 id="access-title">Choose an identity provider.</h2>
      <p>
        The provider handles credentials. This Worker receives only the
        resulting session.
      </p>
      <div className="provider-list">
        {state.bootstrap.providers.length > 0 ? (
          state.bootstrap.providers.map((provider) => (
            <ProviderLink key={provider.id} provider={provider} />
          ))
        ) : (
          <p className="empty">
            Add provider secrets to <code>.dev.vars</code> to enable sign-in.
          </p>
        )}
      </div>
    </div>
  );
}

function ProviderLink({
  provider,
}: {
  readonly provider: AuthProviderDescriptor;
}) {
  return (
    <a
      className="provider"
      href={`/api/auth/signin/${provider.id}?callbackUrl=/`}
    >
      <span className={`provider-symbol ${provider.id}`} aria-hidden="true">
        {getInitial(provider.label)}
      </span>
      <span>Continue with {provider.label}</span>
    </a>
  );
}

function getInitial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "S";
}
