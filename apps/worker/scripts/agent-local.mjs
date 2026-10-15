import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const stateIndex = args.indexOf("--state");
  const state =
    stateIndex === -1 ? ".wrangler/state/v3" : args.splice(stateIndex, 2)[1];
  if (!state || args.includes("--remote") || args.includes("--local"))
    throw new Error("Only local storage is supported");
  const bundle = await build({
    entryPoints: ["src/agent-admin.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
  });
  const admin = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "gate-agent-admin",
      modules: true,
      script:
        "export default {fetch(){return new Response('local administration only')}}",
      compatibilityDate: "2026-10-14",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { GATE_DB: "00000000-0000-0000-0000-000000000000" },
      resourcePersistencePath: resolve(state),
    }),
  );
  try {
    const { GATE_DB: db } = await mf.getBindings();
    if (operation === "register" && args.length === 2) {
      console.log(await admin.registerAgent(db, args[0], args[1]));
    } else if (
      operation === "credential" &&
      args.length === 2 &&
      args[1].endsWith(".json")
    ) {
      const output = resolve(args[1]);
      const childPath = relative(
        await realpath(".wrangler"),
        await realpath(dirname(output)),
      );
      if (childPath.startsWith("..") || isAbsolute(childPath))
        throw new Error(
          "Credential output must be inside the gitignored .wrangler directory",
        );
      const file = await open(output, "wx", 0o600);
      try {
        if (process.platform === "win32") {
          await promisify(execFile)(
            "icacls",
            [
              output,
              "/inheritance:r",
              "/grant:r",
              `${userInfo().username}:(M)`,
            ],
            { windowsHide: true },
          );
        }
        await file.writeFile(
          JSON.stringify(await admin.issueAgentCredential(db, args[0])),
        );
      } finally {
        await file.close();
      }
      console.log(
        "Credential written to the requested local file; never commit or log its contents.",
      );
    } else if (
      (operation === "grant" || operation === "remove") &&
      args.length === 2
    ) {
      const result = await admin.setAgentAccess(
        db,
        args[0],
        args[1],
        operation === "grant",
      );
      console.log(`Local direct permission ${result}.`);
    } else if (
      (operation === "disable" || operation === "enable") &&
      args.length === 1
    ) {
      await admin.changeAgentStatus(
        db,
        args[0],
        operation === "disable" ? "disabled" : "active",
      );
      console.log("Local Agent generation advanced.");
    } else if (
      (operation === "revoke-token" || operation === "revoke-credential") &&
      args.length === 1
    ) {
      await admin.revokeAgentAuthentication(
        db,
        operation === "revoke-token" ? "token" : "credential",
        args[0],
      );
      console.log("Local authentication revoked.");
    } else if (operation === "inspect" && args.length === 1) {
      console.log(JSON.stringify(await admin.inspectAgent(db, args[0])));
    } else {
      throw new Error(
        "Use register OPERATOR NAME | credential AGENT .wrangler\\FILE.json | grant/remove AGENT create/read/withdraw | disable/enable AGENT | revoke-token/revoke-credential ID | inspect AGENT [--state LOCAL_PATH]",
      );
    }
  } finally {
    await mf.dispose();
  }
}
main().catch((error) => {
  console.error(
    error?.status === 404
      ? "Local Agent operation failed (404): record not found. No authentication data is logged."
      : "Local Agent operation failed; no credentials or error payload are logged. Check arguments, reviewed migrations and local state.",
  );
  process.exitCode = 1;
});
