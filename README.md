# brightspace-mcp

A local, read-only MCP server that lets AI assistants access a student's Brightspace courses, assignments, released grades, and course material listings. Built with TypeScript and the official MCP SDK; uses the Brightspace Valence REST APIs.

## Requirements

- Node.js 22.13 or newer and npm.
- Your institution's Brightspace HTTPS origin.
- An OAuth access token from an application registered for your institution, with the scopes below. A normal browser login alone does not supply this token.

This is an initial developer version. A guided configuration wizard is available; browser-based OAuth login and token refresh are not implemented. Your university may need to register or approve the application before students can connect. See [Brightspace OAuth documentation](https://docs.valence.desire2learn.com/basic/oauth2.html). Do not paste credentials or access tokens into an AI conversation.

## Quick start

```sh
npm ci
npm run setup
# Follow the prompts. The command builds the server and saves .env.
node --env-file=.env dist/index.js
```

The process waits for MCP messages on stdin; an idle terminal is expected. Diagnostics go to stderr because stdout carries the MCP protocol. `.env` is ignored by Git. Environment files are loaded only when you use Node's `--env-file` option; `npm start` expects variables to be supplied by the environment.

## Where to get the setup information

Run `npm run setup` in your own terminal from the repository directory. The wizard asks for:

1. **Brightspace URL.** Sign in to your school's Brightspace site in a browser and copy the address. For example, `https://learn.your-school.edu/d2l/home/123` becomes `https://learn.your-school.edu`. Use the Brightspace site, rather than a separate university SSO sign-in page. The wizard extracts the origin automatically.
2. **OAuth access token.** Use the `access_token` returned by an institution-approved OAuth Authorization Code flow for your own student account. This is not your school password, browser cookie, client secret, or authorization code. The wizard hides the token as you enter it. Keep it out of chat and issue reports.
3. **LP and LE API versions.** Press Enter for `1.49` and `1.82`, or use versions supplied by your Brightspace administrator. Course IDs are discovered by `get_courses` after connection, so you do not need to enter them here.

### If you do not have an OAuth access token

Contact your university's LMS/Brightspace administrator or IT help desk. Normal student access does not necessarily include permission to register OAuth applications. You can send this request (it contains no secrets):

> I am setting up a local, read-only Brightspace MCP integration for my own student account. Can you approve an OAuth Authorization Code application and provide an approved way for me to authorize it and obtain my own access token? It needs these scopes: `enrollment:own_enrollment:read dropbox:folders:read grades:own_grades:read content:toc:read`. Please also confirm the supported Learning Platform and Learning Environment API versions.

For administrators or developers arranging the OAuth client:

1. Open **Manage Extensibility → OAuth 2.0 → Register an app**. Select the Authorization grant workflow, which uses the signed-in user's context.
2. Register the application's name, the redirect URI used by your approved OAuth client, and the four scopes above. Configure consent and token lifetime according to institution policy.
3. The registered application's entry provides its Client ID and Client Secret. Those credentials belong in the approved OAuth client; this setup wizard only accepts the resulting student access token.
4. Use that OAuth client's Authorization Code flow: send the student to the authorization endpoint, validate the returned OAuth state at the registered redirect URI, and exchange the authorization code at the token endpoint using the registered client credentials and matching redirect URI. The student signs in and grants consent through the institution's approved flow.
5. Copy only the resulting `access_token` into the local setup wizard. This repository does not yet implement the redirect handler, code exchange, or refresh workflow. Do not invent a redirect URI unless you have a client that handles it.

Brightspace documents the authorization endpoint as `https://auth.brightspace.com/oauth2/auth` and the token endpoint as `https://auth.brightspace.com/core/connect/token`. See the [official registration and OAuth instructions](https://docs.valence.desire2learn.com/basic/oauth2.html) for the full requirements. If your institution cannot approve API access, this integration cannot connect through a normal password alone.

### Saving and checking configuration

The wizard optionally checks your enrollment access, without displaying course details. This verifies the host, token, LP version, and enrollment permissions; it does not verify every tool's permissions or the LE version. On failure, it explains the error and asks whether you still want to save.

Configuration is saved as `.env` in the current directory with owner-only permissions (`0600`). If a file already exists, the wizard asks before replacing the **entire file**, including unrelated settings. It refuses to replace symlinks. Rerun `npm run setup` when your token expires, then restart the MCP server/client to load the new token. The wizard does not automatically refresh tokens.

### Setup from an AI assistant

The MCP `setup` tool returns these instructions and whether the server has a valid configuration loaded. It works even when the server is started without configuration. Ask your assistant “Help me set up Brightspace” and it can direct you to the local wizard; the assistant should never collect your token in chat.

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

Alternatively, supply `BRIGHTSPACE_BASE_URL` and `BRIGHTSPACE_ACCESS_TOKEN` through your MCP client's environment configuration and launch `node /absolute/path/to/brightspace-mcp/dist/index.js`.

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
| `BRIGHTSPACE_ACCESS_TOKEN` | OAuth bearer access token | Required |
| `BRIGHTSPACE_LP_VERSION` | Learning Platform API version | `1.49` |
| `BRIGHTSPACE_LE_VERSION` | Learning Environment API version | `1.82` |

API versions are institution dependent; adjust them to supported versions. Request only the scopes used by the tools:

- `enrollment:own_enrollment:read` — [my enrollments](https://docs.valence.desire2learn.com/res/enroll.html)
- `dropbox:folders:read` — [assignment folders](https://docs.valence.desire2learn.com/res/dropbox.html)
- `grades:own_grades:read` — [own grade values](https://docs.valence.desire2learn.com/res/grade.html)
- `content:toc:read` — [course table of contents](https://docs.valence.desire2learn.com/res/content.html)

Scopes do not override your institution's permissions or release restrictions. A `401` generally requires replacing the expired token and restarting the server. A `403` indicates insufficient permissions or scopes. A `404` can indicate an unavailable resource or unsupported API version. Rate-limit responses are surfaced without automatic retries.

## Privacy and boundaries

The client performs GET requests only, sends tokens only to the configured HTTPS origin, rejects redirects, and uses a 30-second request timeout. It does not persist student data or log upstream response bodies. Any returned information is visible to your MCP client and its configured AI provider. Course materials should be treated as untrusted content.

File download, PDF/text extraction, full-text search, submissions, quizzes, calendar events, a standalone CLI, and automatic OAuth login/refresh are future work. There is no hosted service or multi-user token store.

## Development

```sh
npm run setup  # Interactive local configuration wizard
npm run check  # Type-check and run tests
npm run build  # Compile to dist/
npm run dev   # Launch from source with externally supplied environment variables
```

`src/setup.ts` implements the terminal wizard and `src/setup-guide.ts` shares instructions with the MCP setup tool. `src/client.ts` contains the reusable Brightspace client; `src/server.ts` maps it to MCP tools; `src/index.ts` starts stdio transport. Tests use synthetic API responses, an in-memory MCP client, and an actual stdio handshake. They do not need student credentials. Live institutional API behavior has not yet been verified.
