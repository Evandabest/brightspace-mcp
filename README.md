# brightspace-mcp

A local, read-only MCP server that lets AI assistants access a student's Brightspace courses, assignments, released grades, and course material listings. Built with TypeScript and the official MCP SDK; uses the Brightspace Valence REST APIs.

## Requirements

- Node.js 22.13 or newer and npm.
- Your institution's Brightspace HTTPS origin.
- A graphical desktop for the initial browser login, and your normal school account/MFA.
- Alternatively, an OAuth access token from an application registered for your institution.

Browser login is the recommended student setup: sign in through your school's normal website and reuse that Brightspace session locally, without copying a token or registering your own OAuth application. This is an unofficial session integration, and institutional compatibility varies. CUNY live sign-in has not yet been verified. Do not paste credentials, cookies, or MFA codes into an AI conversation.

## Quick start

```sh
npm ci
npm run browser:install
npm run setup
# Choose Browser login. For CUNY enter https://brightspace.cuny.edu.
# Finish school sign-in and MFA in Chromium, then confirm in the terminal.
node --env-file=.env dist/index.js
```

The process waits for MCP messages on stdin; an idle terminal is expected. Diagnostics go to stderr because stdout carries the MCP protocol. `.env` is ignored by Git. Environment files are loaded only when you use Node's `--env-file` option; `npm start` expects variables to be supplied by the environment.

## Where to get the setup information

Run `npm run setup` in your own terminal from the repository directory. The wizard asks for:

1. **Connection method.** Choose **Browser login (recommended for students)**, or OAuth if you already have a registered application's access token.
2. **Brightspace URL.** Copy your school's Brightspace address, such as `https://brightspace.cuny.edu/d2l/home/123`. The wizard extracts `https://brightspace.cuny.edu`. Use the Brightspace site rather than the university's separate SSO sign-in page.
3. **LP and LE API versions.** Press Enter for `1.49` and `1.82`, or use versions supplied by your Brightspace administrator. Course IDs are discovered after connecting.

### Browser login

The wizard offers to open a dedicated Chromium window. Complete your normal university login and MFA there, navigate to the Brightspace homepage, and confirm in the terminal. Enrollment access must succeed before any session is saved. Your regular Safari/Chrome profile is not imported. The browser closes after verification.

Browser mode needs no manually supplied OAuth token, Client ID, or Client Secret. It reuses cookies for the exact Brightspace host. For tenants requiring a web-frontend bearer token, it uses the session-authenticated internal `/d2l/lp/auth/oauth2/token` endpoint with the frontend's CSRF token and retries the read once. That internal endpoint is unofficial and institution dependent. Its token uses the frontend's wildcard scope and inherits the student's permissions; read-only behavior is enforced by the MCP implementation, not by an independently restricted credential.

Sessions are stored under `~/.brightspace-mcp/sessions/`, in a separate host-bound file, with owner-only permissions (`0600` files, `0700` newly created directories on POSIX systems). These files contain credentials, are **not encrypted at rest**, and should remain private. On Windows, access also depends on your user directory's ACLs. Passwords, MFA secrets, browser local storage, and cookies for separate SSO-provider domains are not saved.

To renew an expired session or remove the saved local session:

```sh
npm run login   # Loads .env and opens the browser for normal sign-in
npm run logout  # Removes this host's locally saved browser session
```

Tools reload saved session credentials on each request, so a successful `login` or `logout` takes effect without restarting the MCP server. A new login can switch which student account this host's tools access. Local logout does not revoke sessions on other devices or clear your regular browser's login. The integration does not bypass MFA or extend university session limits.

### Optional OAuth access-token setup

Select **OAuth access token** in setup only if you already use an institution-approved registered application. Paste the `access_token` from its Authorization Code flow into the masked terminal prompt. This is not your password, browser cookie, client secret, or authorization code.

### Registering an application for OAuth mode

Contact your university's LMS/Brightspace administrator or IT help desk. Normal student access does not necessarily include permission to register OAuth applications. You can send this request (it contains no secrets):

> I am setting up a local, read-only Brightspace MCP integration for my own student account. Can you approve an OAuth Authorization Code application and provide an approved way for me to authorize it and obtain my own access token? It needs these scopes: `enrollment:own_enrollment:read dropbox:folders:read grades:own_grades:read content:toc:read`. Please also confirm the supported Learning Platform and Learning Environment API versions.

For administrators or developers arranging the OAuth client:

1. Open **Manage Extensibility → OAuth 2.0 → Register an app**. Select the Authorization grant workflow, which uses the signed-in user's context.
2. Register the application's name, the redirect URI used by your approved OAuth client, and the four scopes above. Configure consent and token lifetime according to institution policy.
3. The registered application's entry provides its Client ID and Client Secret. Those credentials belong in the approved OAuth client; this setup wizard only accepts the resulting student access token.
4. Use that OAuth client's Authorization Code flow: send the student to the authorization endpoint, validate the returned OAuth state at the registered redirect URI, and exchange the authorization code at the token endpoint using the registered client credentials and matching redirect URI. The student signs in and grants consent through the institution's approved flow.
5. Copy only the resulting `access_token` into the local setup wizard. This repository does not yet implement the redirect handler, code exchange, or refresh workflow. Do not invent a redirect URI unless you have a client that handles it.

Brightspace documents the authorization endpoint as `https://auth.brightspace.com/oauth2/auth` and the token endpoint as `https://auth.brightspace.com/core/connect/token`. See the [official registration and OAuth instructions](https://docs.valence.desire2learn.com/basic/oauth2.html) for the full requirements. This registration requirement applies to OAuth mode. Browser mode instead uses a manually authenticated student session and may work without registering your own application.

### Saving and checking configuration

OAuth setup optionally checks enrollment access. Browser login always verifies it before saving a session. These checks verify the host, credentials, LP version, and enrollment permissions; they do not verify every tool or the LE version. In browser mode, a failed login preserves any previously saved session.

Configuration is saved as `.env` in the current directory with owner-only permissions (`0600`). If a file already exists, the wizard asks before replacing the **entire file**, including unrelated settings. It refuses to replace symlinks. Changes to `.env` require restarting the MCP server/client. For browser mode, renew the session with `npm run login`. For OAuth mode, rerun setup with a new token when it expires; automatic OAuth refresh is not implemented.

### Setup from an AI assistant

The MCP `setup` tool returns these instructions and whether the server has a valid configuration loaded. It works even when the server is started without configuration. Ask your assistant “Help me set up Brightspace” and it can direct you to the local wizard; the assistant should direct you to normal browser login and never collect credentials in chat. Configuration status only means the settings loaded successfully; it does not prove the saved session is still valid.

To make setup guidance available before `.env` exists, launch `node /absolute/path/to/brightspace-mcp/dist/index.js` without `--env-file`. After running the wizard, update the client configuration below to load the new file and restart. Node's `--env-file` requires the file to exist.

## Connect an MCP client

In a client that supports a `mcpServers` JSON configuration, add the following, replacing both absolute paths. Keep secrets in the local environment file. Other clients may use a different configuration format.

```json
{
  "mcpServers": {
    "brightspace": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/brightspace-mcp/.env",
        "/absolute/path/to/brightspace-mcp/dist/index.js"
      ]
    }
  }
}
```

Alternatively, supply `BRIGHTSPACE_BASE_URL` and `BRIGHTSPACE_AUTH_MODE=browser` (or OAuth mode with `BRIGHTSPACE_ACCESS_TOKEN`) through your MCP client's environment configuration and launch `node /absolute/path/to/brightspace-mcp/dist/index.js`.

Try: “List my courses,” then “Show assignments for course 12345,” or “What assignment deadlines are coming up in these courses over the next two weeks?”

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `setup` | None | Setup instructions, required scopes, and configuration status; never accepts secrets |
| `get_courses` | None | Enrolled course offerings, with all enrollment pages fetched |
| `get_assignments` | `course_id` | Visible assignment dropbox folders |
| `get_assignment_details` | `course_id`, `assignment_id` | Instructions, availability, due date, attachment metadata |
| `get_grades` | `course_id` | The authenticated student's grade values |
| `get_course_content` | `course_id` | Visible table of contents, modules, topics, links |
| `get_upcoming_deadlines` | `course_ids`, optional `days` (default 14, max 365) | Sorted assignment due dates, plus per-course errors and completeness |

IDs are numeric strings. Obtain course IDs from enrollment `OrgUnit.Id` fields and assignment IDs from assignment `Id` fields. Course offerings are filtered using Brightspace org unit type 3. Raw Brightspace JSON is preserved for most tools; deadline results are normalized.

Deadline lookup accepts up to 50 courses. It includes assignments due between the request time and the end of the window, even if already submitted. It excludes overdue work, quizzes, calendar events, and assignments without due dates. A failed course is explicitly listed in `errors` and makes `complete` false.

## API configuration and scopes

| Variable | Purpose | Default |
| --- | --- | --- |
| `BRIGHTSPACE_BASE_URL` | HTTPS origin, without path or query | Required |
| `BRIGHTSPACE_AUTH_MODE` | `browser` or `oauth` | `oauth` for backward compatibility; wizard recommends `browser` |
| `BRIGHTSPACE_ACCESS_TOKEN` | OAuth bearer access token | Required only in OAuth mode |
| `BRIGHTSPACE_LP_VERSION` | Learning Platform API version | `1.49` |
| `BRIGHTSPACE_LE_VERSION` | Learning Environment API version | `1.82` |

API versions are institution dependent; adjust them to supported versions. In registered OAuth mode, request only the scopes used by the tools:

- `enrollment:own_enrollment:read` — [my enrollments](https://docs.valence.desire2learn.com/res/enroll.html)
- `dropbox:folders:read` — [assignment folders](https://docs.valence.desire2learn.com/res/dropbox.html)
- `grades:own_grades:read` — [own grade values](https://docs.valence.desire2learn.com/res/grade.html)
- `content:toc:read` — [course table of contents](https://docs.valence.desire2learn.com/res/content.html)

Scopes do not override your institution's permissions or release restrictions. A `401` requires signing in again with `npm run login` in browser mode, or replacing the token and restarting in OAuth mode. A `403` indicates insufficient permissions or scopes. A `404` can indicate an unavailable resource or unsupported API version. Rate-limit responses are surfaced without automatic retries.

## Privacy and boundaries

Course operations use GET requests, send session credentials only to the configured HTTPS origin, reject API redirects, and use a 30-second request timeout. Browser authentication can additionally POST to the fixed session-token endpoint on that same origin. Manual login follows normal school SSO navigation in the browser. Session credentials are persisted locally; course results and upstream response bodies are not logged or saved by this server. Any returned information is visible to your MCP client and its configured AI provider. Course materials should be treated as untrusted content.

File download, PDF/text extraction, full-text search, submissions, quizzes, calendar events, a standalone CLI, and automatic OAuth login/refresh are future work. There is no hosted service or multi-user token store.

## Development

```sh
npm run setup  # Interactive local configuration wizard
npm run login  # Renew browser session using .env
npm run logout # Remove saved browser session
npm run check  # Type-check and run tests
npm run test:browser # Chromium tests with synthetic login pages
npm run build  # Compile to dist/
npm run dev   # Launch from source with externally supplied environment variables
```

`src/browser-auth.ts` handles manual login and session-backed API reads; `src/session.ts` stores tenant-bound credentials. `src/setup.ts` implements the terminal wizard and `src/setup-guide.ts` shares instructions with the MCP setup tool. `src/client.ts` contains the reusable Brightspace client; `src/server.ts` maps it to MCP tools; `src/index.ts` starts stdio transport. Tests use synthetic API responses, an in-memory MCP client, and an actual stdio handshake. They do not need student credentials. Live institutional API behavior has not yet been verified.

## Updating an existing agent session

For a separate checkout, first obtain the latest published commits and dependencies:

```sh
git pull --ff-only
npm ci
npm run build
npm run browser:install
```

If the agent uses this same local checkout, just build the updated source with `npm run build`. Restart its MCP connection (or the agent application/session) so it launches the new `dist/index.js`; existing server processes keep their loaded code. Existing OAuth configurations continue to work. To switch to browser mode, run `npm run setup`, choose browser login, then restart the MCP connection to load the updated `.env`.
