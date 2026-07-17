# Boolean email connectors

Boolean separates user mail access from product email:

- Gmail and Outlook connect directly from the desktop app. OAuth tokens remain
  in the user's local Boolean configuration and mail requests go directly to
  Google or Microsoft.
- Cloudflare Email Service sends Boolean account and transactional messages
  from the backend. Its credentials and binding never ship in the desktop app.

## Gmail

1. Enable the Gmail API in Google Cloud.
2. Configure the OAuth consent screen.
3. Create an OAuth client with application type **Desktop app**.
4. Paste its public client ID into Settings > Email > Gmail.

Boolean uses a loopback callback shown on that Settings page. A client secret
is not required or stored by Boolean.

## Outlook

1. Register an app in Microsoft Entra ID.
2. Enable public client flows for a desktop application.
3. Add delegated permissions: `User.Read`, `Mail.ReadWrite`, and `Mail.Send`.
4. Paste the Application (client) ID into Settings > Email > Outlook.

Boolean also requests `openid`, `profile`, `email`, and `offline_access` so the
user can reconnect without repeatedly signing in.

## Sending safeguards

Draft-only mode is enabled by default. Disabling it allows send actions, but
Boolean still requires a separate explicit confirmation for every message.
Auto-approve does not bypass that confirmation.

## Cloudflare transactional email

The Worker uses an `EMAIL` Email Sending binding and the verified sender in
`backend/wrangler.jsonc`. Before deployment, enable Email Sending for the domain:

```powershell
cd backend
npx wrangler email sending enable saz3.com
```

After the domain is verified and the Worker is deployed, an administrator can
send a binding test with `POST /admin/api/email/test`.
