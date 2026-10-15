import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@auth/core/jwt";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { createAuthConfig } from "../src/auth.js";
import type { Bindings } from "../src/env.js";
import { applyMigrations } from "./runtime-migrations.js";

describe("Chromium → production assets/Worker → persistent local D1", () => {
  for (const width of [1440, 320]) {
    it(`completes isolated human workflows, recovery and restart at ${width}px`, async () => {
      const bundle = await build({
        entryPoints: [
          fileURLToPath(new URL("../src/index.ts", import.meta.url)),
        ],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
      });
      const script = bundle.outputFiles[0]?.text;
      if (!script) throw new Error("Worker bundle is empty.");
      const persist = resolve(
        ".wrangler",
        `browser-test-${crypto.randomUUID()}`,
      );
      await mkdir(persist, { recursive: true });
      const secret = "isolated-browser-test-secret-not-oauth-credentials";
      const options = convertV4MiniflareOptions({
        name: "gate-browser-test",
        modules: true,
        script,
        host: "127.0.0.1",
        port: 0,
        compatibilityDate: "2026-10-14",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { GATE_DB: "gate-browser-test-database" },
        resourcePersistencePath: persist,
        assets: {
          directory: fileURLToPath(new URL("../../web/dist", import.meta.url)),
          binding: "ASSETS",
          run_worker_first: ["/api/*"],
          routerConfig: { has_user_worker: true },
          assetConfig: { not_found_handling: "single-page-application" },
        },
        bindings: {
          AUTH_SECRET: secret,
          APP_NAME: "Gate isolated browser test",
        },
      });
      let mf = new Miniflare(options);
      let browser: Browser | undefined;
      try {
        const origin = (await mf.ready).origin;
        const health = await fetch(`${origin}/api/health`);
        expect(health.status, await health.text()).toBe(200);
        const { GATE_DB: db } = await mf.getBindings<{ GATE_DB: D1Database }>(
          "gate-browser-test",
        );
        await applyMigrations(db);
        await db.batch([
          db.prepare(`INSERT INTO gate_identities VALUES
            ('lin','101','Lin','active',1,1),
            ('kai','102','Kai','active',1,1),
            ('other','103','Other','active',1,1)`),
          db.prepare(`INSERT INTO gate_template_access VALUES
            ('lin','release-review',1,'create',1),
            ('kai','release-review',1,'decide',1)`),
        ]);
        const auth = createAuthConfig({
          GATE_DB: db,
          AUTH_SECRET: secret,
        } as Bindings);
        browser = await chromium.launch({ headless: true });
        const pages = new Map<string, Page>();
        const errors: string[] = [];
        for (const [identity, subject] of Object.entries({
          lin: "101",
          kai: "102",
          other: "103",
        })) {
          // Only the verified provider account is synthetic; the production
          // callbacks create real D1 sessions and Auth.js encrypted cookies.
          const account = {
            provider: "github",
            providerAccountId: subject,
            type: "oauth" as const,
          };
          expect(
            await auth.callbacks?.signIn?.({ user: { id: subject }, account }),
          ).toBe(true);
          const token = await auth.callbacks?.jwt?.({
            token: {},
            user: { id: subject },
            account,
            trigger: "signIn",
          });
          if (!token) throw new Error("Session creation failed.");
          const context = await browser.newContext({
            viewport: { width, height: 1000 },
          });
          const name = "authjs.session-token";
          await context.addCookies([
            {
              name,
              value: await encode({ secret, salt: name, token, maxAge: 3600 }),
              url: origin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]);
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          pages.set(identity, page);
        }
        function pageFor(identity: string) {
          const page = pages.get(identity);
          if (!page) throw new Error("Missing browser identity.");
          return page;
        }
        async function fits(page: Page) {
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        }
        const lin = pageFor("lin");
        const kai = pageFor("kai");
        const other = pageFor("other");
        let approvedPath = "";
        for (const action of ["批准", "拒绝", "撤回"]) {
          const candidate = `浏览器 ${width}px ${action}`;
          await lin.goto(`${origin}/requests/new`);
          await lin.getByLabel("版本名称（必填）").fill(candidate);
          await lin
            .getByLabel("构建产物摘要（必填）")
            .fill(`sha256:${"a".repeat(64)}`);
          await lin
            .getByLabel("请求说明（必填）")
            .fill("不可变的本地浏览器测试载荷");
          await fits(lin);
          await lin.getByRole("button", { name: "核对请求内容" }).click();
          await lin.getByRole("heading", { name: "核对不可变内容" }).waitFor();
          expect(
            await db
              .prepare("SELECT COUNT(*) AS n FROM gate_requests")
              .first("n"),
          ).toBe(action === "批准" ? 0 : action === "拒绝" ? 1 : 2);
          await lin
            .getByRole("button", { name: "确认创建请求", exact: true })
            .click();
          await lin.waitForURL(/\/requests\/[a-f0-9-]+$/);
          const path = new URL(lin.url()).pathname;
          const id = path.split("/").at(-1);
          await lin
            .getByRole("heading", { name: candidate, exact: true })
            .waitFor();
          await fits(lin);
          expect(
            await lin.getByRole("button", { name: "准备批准" }).count(),
          ).toBe(0);
          await other.goto(`${origin}${path}`);
          await other
            .getByRole("heading", { name: "不可访问或不存在" })
            .waitFor();
          expect(
            await other.getByText("不可变的本地浏览器测试载荷").count(),
          ).toBe(0);
          await fits(other);
          const actor = action === "撤回" ? lin : kai;
          if (actor === kai) {
            await kai.goto(`${origin}/inbox`);
            await kai
              .getByRole("link", { name: candidate, exact: true })
              .click();
          }
          await actor.getByRole("button", { name: `准备${action}` }).click();
          const heading = actor.getByRole("heading", { name: `确认${action}` });
          await heading.waitFor();
          expect(
            await heading.evaluate(
              (node) => node === node.ownerDocument.activeElement,
            ),
          ).toBe(true);
          expect(
            await db
              .prepare("SELECT status FROM gate_requests WHERE id=?")
              .bind(id)
              .first("status"),
          ).toBe("pending");
          await actor.keyboard.press("Tab");
          await actor.keyboard.press("Tab");
          await actor.keyboard.press("Enter");
          await heading.waitFor({ state: "detached" });
          const trigger = actor.getByRole("button", { name: `准备${action}` });
          expect(
            await trigger.evaluate(
              (node) => node === node.ownerDocument.activeElement,
            ),
          ).toBe(true);
          await trigger.click();
          if (action === "批准") {
            await db
              .prepare(
                `CREATE TRIGGER browser_audit_fault BEFORE INSERT ON gate_request_events
              WHEN NEW.event_type!='created' BEGIN SELECT RAISE(ABORT,'browser fault'); END`,
              )
              .run();
            await actor
              .getByRole("button", { name: `确认${action}`, exact: true })
              .click();
            await actor
              .getByText("操作结果尚未确认；", { exact: false })
              .waitFor();
            expect(
              await db
                .prepare("SELECT status FROM gate_requests WHERE id=?")
                .bind(id)
                .first("status"),
            ).toBe("pending");
            await db.prepare("DROP TRIGGER browser_audit_fault").run();
            await actor.getByRole("button", { name: "刷新详情" }).click();
            await actor.getByRole("button", { name: `准备${action}` }).click();
          }
          await actor
            .getByRole("button", { name: `确认${action}`, exact: true })
            .click();
          await actor
            .getByText(`实际操作身份：${action === "撤回" ? "lin" : "kai"}`, {
              exact: false,
            })
            .waitFor();
          expect(
            await actor.getByRole("button", { name: `准备${action}` }).count(),
          ).toBe(0);
          await fits(actor);
          const row = await db
            .prepare(
              `SELECT status,
            (SELECT COUNT(*) FROM gate_decisions WHERE request_id=r.id) AS decisions,
            (SELECT COUNT(*) FROM gate_request_events WHERE request_id=r.id) AS events
            FROM gate_requests r WHERE id=?`,
            )
            .bind(id)
            .first();
          expect(row).toMatchObject({
            status:
              action === "批准"
                ? "approved"
                : action === "拒绝"
                  ? "rejected"
                  : "withdrawn",
            decisions: action === "撤回" ? 0 : 1,
            events: 2,
          });
          if (action === "批准") approvedPath = path;
        }
        await lin.goto(`${origin}/requests/mine`);
        await lin
          .getByRole("link", { name: `浏览器 ${width}px 批准`, exact: true })
          .waitFor();
        await fits(lin);
        await kai.goto(`${origin}${approvedPath}`);
        await kai.getByRole("heading", { name: "不可改写的历史" }).waitFor();
        await db
          .prepare("DELETE FROM gate_template_access WHERE identity_id='kai'")
          .run();
        await kai.getByRole("button", { name: "刷新详情" }).click();
        await kai.getByRole("heading", { name: "不可访问或不存在" }).waitFor();
        expect(await kai.getByText("不可变的本地浏览器测试载荷").count()).toBe(
          0,
        );

        await mf.dispose();
        mf = new Miniflare(options);
        const restartedOrigin = (await mf.ready).origin;
        // Cookies are scoped to the host, not the ephemeral runtime port.
        await lin.goto(`${restartedOrigin}${approvedPath}`);
        await lin
          .getByRole("heading", { name: `浏览器 ${width}px 批准`, exact: true })
          .waitFor();
        await lin.getByText("实际操作身份：kai", { exact: false }).waitFor();
        expect(await lin.locator(".history li").count()).toBe(2);
        expect(await lin.getByText("不可变的本地浏览器测试载荷").count()).toBe(
          1,
        );
        const originalCookie = (await lin.context().cookies()).find(
          (cookie) => cookie.name === "authjs.session-token",
        );
        if (!originalCookie) throw new Error("Missing authenticated cookie.");
        await lin.getByRole("link", { name: "退出登录" }).click();
        await lin.getByRole("button", { name: "Sign out" }).click();
        await lin.goto(`${restartedOrigin}${approvedPath}`);
        await lin
          .getByText("尚未配置 GitHub 登录，请联系试点运维负责人。")
          .waitFor();
        expect(
          await lin.getByRole("link", { name: "使用 GitHub 登录" }).count(),
        ).toBe(0);
        const me = await lin.context().request.get(`${restartedOrigin}/api/me`);
        expect(me.status()).toBe(401);
        const replay = await fetch(`${restartedOrigin}/api/me`, {
          headers: {
            cookie: `${originalCookie.name}=${originalCookie.value}`,
          },
        });
        expect(replay.status).toBe(401);
        expect(errors).toEqual([]);
      } finally {
        await browser?.close();
        await mf.dispose();
        await rm(persist, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
