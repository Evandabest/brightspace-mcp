# brightspace-mcp

A local, read-only MCP server that lets AI assistants access a student's Brightspace courses, assignments, released grades, and course material listings. Built with TypeScript and the official MCP SDK; uses the Brightspace Valence REST APIs.

## Requirements

- Node.js 22 or newer and npm.
- Your institution's Brightspace HTTPS origin.
- An OAuth access token from an application registered for your institution, with the scopes below. A normal browser login alone does not supply this token.

This is an initial developer version. Guided OAuth login and token refresh are not implemented. Your university may need to register or approve the application before students can connect. See [Brightspace OAuth documentation](https://docs.valence.desire2learn.com/basic/oauth2.html). Do not paste credentials or access tokens into an AI conversation.

## Quick start

```sh
npm ci
npm run build
cp .env.example .env
# Edit .env locally with your institution's host and OAuth access token.
node --env-file=.env dist/index.js
```

The process waits for MCP messages on stdin; an idle terminal is expected. Diagnostics go to stderr because stdout carries the MCP protocol. `.env` is ignored by Git. Environment files are loaded only when you use Node's `--env-file` option; `npm start` expects variables to be supplied by the environment.

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
npm run check  # Type-check and run tests
npm run build  # Compile to dist/
npm run dev   # Launch from source with externally supplied environment variables
```

`src/client.ts` contains the reusable Brightspace client; `src/server.ts` maps it to MCP tools; `src/index.ts` starts stdio transport. Tests use synthetic API responses, an in-memory MCP client, and an actual stdio handshake. They do not need student credentials. Live institutional API behavior has not yet been verified.
