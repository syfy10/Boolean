#!/usr/bin/env node
// One-time login. You approve it in your own browser; this process only ever
// sees the authorization code that comes back on the loopback redirect.
//
//   node orderflow/src/auth-cli.js

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { loadConfig, assertUsable, CONFIG_PATH } from "./tradestation-config.js";
import { createPkcePair, buildAuthorizeUrl, exchangeCode, createTokenStore } from "./tradestation-auth.js";

const config = assertUsable(loadConfig());
const store = createTokenStore();
const { verifier, challenge } = createPkcePair();
const state = crypto.randomBytes(16).toString("hex");
const authUrl = buildAuthorizeUrl(config, { challenge, state });

function page(title, detail) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui;background:#0e0f11;color:#e6e8ea;padding:3rem">
<h1 style="font-weight:500;font-size:20px">${title}</h1><p style="color:#7c828c">${detail}</p></body>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, config.redirectUri);
  if (url.pathname !== "/" && url.pathname !== "/callback") {
    res.writeHead(404).end("not found");
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    const detail = url.searchParams.get("error_description") || "";
    res.writeHead(400, { "Content-Type": "text/html" }).end(page("Authorization failed", `${error} — ${detail}`));
    console.error(`\nauthorization failed: ${error} — ${detail}`);
    server.close();
    process.exit(1);
  }

  if (url.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(page("State mismatch", "Discarding this response."));
    console.error("\nstate mismatch — ignoring the callback");
    server.close();
    process.exit(1);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(page("No code returned", "Nothing to exchange."));
    return;
  }

  try {
    const tokens = await exchangeCode(config, { code, verifier });
    store.write(tokens);
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      page("Connected", "You can close this tab and go back to the terminal.")
    );
    console.log(`\ntokens saved to ${store.path}`);
    console.log(`scope: ${tokens.scope || "(not reported)"}`);
    console.log(`access token expires in ${Math.round((tokens.expiresAt - Date.now()) / 1000)}s`);
    console.log(`refresh token: ${tokens.refreshToken ? "stored" : "NOT returned — check that offline_access is in your scopes"}`);
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" }).end(page("Token exchange failed", err.message));
    console.error(`\ntoken exchange failed: ${err.message}`);
    server.close();
    process.exit(1);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`port ${config.callbackPort} is in use. Free it, or set another registered port in ${CONFIG_PATH}.`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

server.listen(config.callbackPort, () => {
  console.log(`environment : ${config.api}`);
  console.log(`redirect    : ${config.redirectUri}`);
  console.log(`scopes      : ${config.scopes.join(" ")}`);
  console.log(`\nOpen this URL and sign in:\n\n${authUrl}\n`);
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", authUrl], { detached: true, stdio: "ignore" }).unref();
  }
  console.log("waiting for the redirect…");
});
