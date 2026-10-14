import type { BootstrapResponse } from "@workspace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dashboard } from "../src/ui.js";

const bootstrap: BootstrapResponse = {
  appName: "Silvermoon Gate",
  providers: [
    { id: "github", label: "GitHub" },
    { id: "google", label: "Google" },
    { id: "microsoft-entra-id", label: "Microsoft" },
  ],
};

describe("Dashboard", () => {
  it("renders provider actions for an anonymous visitor", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          bootstrap,
          session: null,
        }}
      />,
    );

    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("/api/auth/signin/microsoft-entra-id");
  });

  it("renders the current identity", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          bootstrap,
          session: {
            user: {
              email: "operator@example.com",
              name: "Operator",
            },
          },
        }}
      />,
    );

    expect(html).toContain("Operator");
    expect(html).toContain("operator@example.com");
    expect(html).toContain("/api/auth/signout");
  });

  it("renders an image or safe fallback for incomplete profiles", () => {
    const withImage = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          bootstrap,
          session: {
            user: {
              image: "https://example.test/avatar.png",
            },
          },
        }}
      />,
    );
    const withoutProfileFields = renderToStaticMarkup(
      <Dashboard
        state={{
          kind: "ready",
          bootstrap,
          session: {
            user: {},
          },
        }}
      />,
    );

    expect(withImage).toContain("https://example.test/avatar.png");
    expect(withImage).toContain("Signed in");
    expect(withoutProfileFields).toContain(
      '<span class="avatar fallback" aria-hidden="true">S</span>',
    );
  });

  it("renders loading, empty-provider, and error guidance", () => {
    expect(
      renderToStaticMarkup(<Dashboard state={{ kind: "loading" }} />),
    ).toContain("Checking your session");

    expect(
      renderToStaticMarkup(
        <Dashboard
          state={{
            kind: "ready",
            bootstrap: { ...bootstrap, providers: [] },
            session: null,
          }}
        />,
      ),
    ).toContain(".dev.vars");

    expect(
      renderToStaticMarkup(
        <Dashboard state={{ kind: "error", message: "HTTP 503" }} />,
      ),
    ).toContain("HTTP 503");
  });
});
