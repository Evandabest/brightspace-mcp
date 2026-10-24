# brightspace-mcp

A local, read-only MCP server that lets AI assistants access a student's Brightspace courses, assignments, documents, announcements, discussions, classlists, groups, quizzes, calendar events, released grades, and own submission history. Built with TypeScript and the official MCP SDK; uses the Brightspace Valence REST APIs.

## Install with your coding agent

Copy and paste this prompt into a local coding agent that supports MCP, such as Codex. It tells the agent to install this repository and register Brightspace as a tool provider:

```text
Install https://github.com/Evandabest/brightspace-mcp.git on my computer
and add it to this coding agent as a local MCP server named "brightspace".

1. Check that Node.js 22.13+ and npm are available. Reuse my existing
   brightspace-mcp checkout if present; otherwise clone the repository into
   ~/projects/brightspace-mcp (or an appropriate local projects directory).
   If updating an existing clean checkout, use git pull --ff-only. Preserve
   local changes, .env, and saved sessions; report any update conflict.
2. In that directory run npm ci, npm run build, and npm run browser:install.
3. Register the server using this agent's supported MCP configuration.
   Launch the Node executable with these arguments, using actual absolute
   paths for this computer:
     --env-file-if-exists=/absolute/path/to/brightspace-mcp/.env
     /absolute/path/to/brightspace-mcp/dist/index.js
   Preserve other MCP servers. If "brightspace" is already registered,
   check its launch paths and update that entry rather than adding a duplicate.
   Run the Node entrypoint directly, not npm start: stdout carries MCP messages.
4. If setup is needed, tell me to run npm run setup in my own terminal from
   the checkout and choose Browser login. For CUNY the Brightspace URL is
   https://brightspace.cuny.edu; for another school ask me for its Brightspace
   URL. I will complete school sign-in and MFA in the browser and confirm
   in the terminal. Never ask me to paste passwords, cookies, tokens, or MFA
   codes into chat. Preserve a working configuration instead of rerunning setup.
5. Verify registration and explain how to restart the MCP connection or
   open a new agent session to load it. Once connected and signed in, call
   get_courses to verify access. If login expired, direct me to npm run login.
   Do not report successful account access until that tool call succeeds.

After installation, I want to ask about assignments and download course PDFs
into my current workspace using the Brightspace tools.
```

The agent can install and register the server; **you complete sign-in yourself**. The `--env-file-if-exists` option lets the MCP `setup` tool provide guidance before `.env` exists. After creating or changing `.env`, restart the MCP connection so it loads those settings. Each student uses their own account and locally saved session.

For Codex, the agent can register the server with the following command, replacing both paths with the actual checkout location:

```sh
codex mcp add brightspace -- node \
  --env-file-if-exists=/absolute/path/to/brightspace-mcp/.env \
  /absolute/path/to/brightspace-mcp/dist/index.js
codex mcp list
```

This uses Codex's local stdio MCP support; see the [official OpenAI documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). If `node` is unavailable in the agent application's environment, use the absolute path to the Node executable. For agents with JSON configuration, use the [MCP client configuration below](#connect-an-mcp-client).

After restarting the connection or starting a new agent session, try:

> Use the Brightspace MCP to list my courses, show upcoming homework, and find the PDF lecture notes for a course. Download the PDFs into this workspace.

## Requirements

- Node.js 22.13 or newer and npm.
- Your institution's Brightspace HTTPS origin.
- A graphical desktop for the initial browser login, and your normal school account/MFA.
- Alternatively, an OAuth access token from an application registered for your institution.

Browser login is the recommended student setup: sign in through your school's normal website and reuse that Brightspace session locally, without copying a token or registering your own OAuth application. This is an unofficial session integration, and institutional compatibility varies. Normal CUNY login and selected course reads/downloads have been verified with a student session. Do not paste credentials, cookies, or MFA codes into an AI conversation.

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

> I am setting up a local, read-only Brightspace MCP integration for my own student account. Can you approve an OAuth Authorization Code application and provide an approved way for me to authorize it and obtain my own access token? Please register the read scopes listed in this repository’s API configuration section for the tools I plan to use. Please also confirm the supported Learning Platform and Learning Environment API versions.

For administrators or developers arranging the OAuth client:

1. Open **Manage Extensibility → OAuth 2.0 → Register an app**. Select the Authorization grant workflow, which uses the signed-in user's context.
2. Register the application's name, the redirect URI used by your approved OAuth client, and the scopes required by your enabled tools. Configure consent and token lifetime according to institution policy.
3. The registered application's entry provides its Client ID and Client Secret. Those credentials belong in the approved OAuth client; this setup wizard only accepts the resulting student access token.
4. Use that OAuth client's Authorization Code flow: send the student to the authorization endpoint, validate the returned OAuth state at the registered redirect URI, and exchange the authorization code at the token endpoint using the registered client credentials and matching redirect URI. The student signs in and grants consent through the institution's approved flow.
5. Copy only the resulting `access_token` into the local setup wizard. This repository does not yet implement the redirect handler, code exchange, or refresh workflow. Do not invent a redirect URI unless you have a client that handles it.

Brightspace documents the authorization endpoint as `https://auth.brightspace.com/oauth2/auth` and the token endpoint as `https://auth.brightspace.com/core/connect/token`. See the [official registration and OAuth instructions](https://docs.valence.desire2learn.com/basic/oauth2.html) for the full requirements. This registration requirement applies to OAuth mode. Browser mode instead uses a manually authenticated student session and may work without registering your own application.

### Permissions and quiz visibility

Classlists and group rosters reflect institutional privacy settings. An empty quiz listing can mean the API exposes no quizzes to your role; it does not establish that your course has none. `get_quiz_questions` may return `403` for students even when they can take the quiz on the website. The server does not start quiz attempts, bypass release conditions, or submit answers.

Group membership uses the own-groups endpoint with LP 1.64+, and on older configured LP versions uses visible categories/enrollments filtered to your `whoami` identity. Hidden or inaccessible categories are reported in `errors` and make `complete` false.

List-page tools follow all pages with loop/host/route validation and a 100-page limit. Discussion posts instead return a bounded explicit page: follow `nextPage` until it is null (a full final page may require one extra empty request). Data can change while pages are being read.

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

## Downloading course documents

Ask your agent:

> Find the lecture slides and homework documents for my course, download them, and open the files to help me study.

The normal workflow is `get_courses` → `list_course_documents` → `download_document`. Document discovery traverses nested modules and returns titles, module paths, topic IDs, `downloadSource`, and URLs. Both standard topic types and CUNY's table-of-contents activity types are supported. Pass `topic_id` for `content_topic`, or the returned URL for `course_file`.

`download_document` saves the bytes locally and returns an absolute `path`, MIME type, size, and SHA-256. The coding agent can then open that path with its normal PDF, Word, presentation, or text-reading tools. Downloading does not itself extract text or summarize the document.

For PDFs, ask “Find and download the PDF lecture notes for this course.” Use `list_course_documents` with `file_type="pdf"` to filter recognizable PDF titles/URLs, then `download_document` with `pdf_only=true`. PDF-only mode checks the actual `%PDF-` signature (including headers split across streamed chunks), saves with a `.pdf` extension, and rejects non-PDF files instead of renaming them. PDFs whose type is missing from title/URL metadata may be absent from the filter; use the full listing and PDF-only validation when needed. Word/PowerPoint-to-PDF conversion is not implemented.

Files default to `~/Downloads/brightspace-mcp/<course_id>/`. Supply `destination_dir` to save inside your coding workspace instead, particularly when the agent cannot read outside that workspace. Filenames are sanitized and prefixed with a unique ID, existing files are never overwritten, and files are created with owner-only permissions on POSIX systems. Files are streamed with a **50 MiB per-file limit**. Failed or interrupted downloads remove the partial file.

| `source` | Required IDs or URL (in addition to `course_id`) | Where to find them |
| --- | --- | --- |
| `content_topic` | `topic_id` | `list_course_documents` |
| `course_file` | `url` | Direct `/content/enforced/<course_id>-…/…` links from course content or downloaded HTML |
| `assignment_attachment` | `assignment_id`, `file_id` | `get_assignment_details` → `Attachments` |
| `announcement_attachment` | `announcement_id`, `file_id` | `get_announcements` or `get_announcement` → `Attachments` |
| `discussion_attachment` | `forum_id`, `topic_id`, `post_id`, `file_id` | `get_discussion_posts` or `get_discussion_post` → attachments |
| `submission_file` | `assignment_id`, `submission_id`, `file_id` | `get_submission_status` → own submissions and files |

Submission downloads verify that the selected submission/file belongs to the authenticated student's own submission listing. Direct URL downloads accept only this Brightspace host's course-specific `/content/enforced/` paths. Redirects to other hosts are rejected and credentials are never forwarded. External Google Drive, OneDrive, publisher, video, or LTI links are listed but need their own service access; this downloader does not authenticate to them. Embedded links inside downloaded HTML can be inspected by the agent and supported Brightspace links downloaded individually.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `setup` | None | Setup instructions, required scopes, and configuration status; never accepts secrets |
| `get_courses` | None | Enrolled course offerings, with all enrollment pages fetched |
| `get_assignments` | `course_id` | Visible assignment dropbox folders |
| `get_assignment_details` | `course_id`, `assignment_id` | Instructions, availability, due date, attachment metadata |
| `get_grades` | `course_id` | The authenticated student's grade values |
| `get_course_content` | `course_id` | Visible table of contents, modules, topics, links |
| `get_content_topic` | `course_id`, `topic_id` | Topic metadata, description, and URL |
| `list_course_documents` | `course_id`; optional `file_type` (`all` or `pdf`) | Documents and links throughout nested modules, with download guidance |
| `download_document` | `course_id`, `source`, source-specific IDs; optional `destination_dir`, `pdf_only` | Local file path, filename, bytes, MIME type, SHA-256 |
| `get_announcements` | `course_id` | Course announcements, bodies, attachment IDs |
| `get_announcement` | `course_id`, `announcement_id` | One announcement with attachment metadata |
| `get_discussion_forums` | `course_id` | Visible discussion forums |
| `get_discussion_topics` | `course_id`, `forum_id` | Topics and instructions |
| `get_discussion_posts` | `course_id`, `forum_id`, `topic_id`; optional `page_number`, `page_size`, `thread_id` | One page of posts/replies, with continuation guidance |
| `get_discussion_post` | `course_id`, `forum_id`, `topic_id`, `post_id` | Full visible post and attachment metadata |
| `get_classlist` | `course_id` | All visible roster pages, subject to privacy settings |
| `get_group_membership` | `course_id` | Your own groups, plus any category errors |
| `get_quizzes` | `course_id` | All API-visible quiz listings |
| `get_quiz_details` | `course_id`, `quiz_id` | Instructions, description, availability, and configuration |
| `get_quiz_questions` | `course_id`, `quiz_id` | Question contents only if the API grants access |
| `get_calendar_events` | `course_id`; optional ISO `start_time`, `end_time` | Your course events; default next 14 days, max 366-day window |
| `get_submission_status` | `course_id`, `assignment_id` | Own submission status/history, file IDs, completion date, released feedback |
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
- `content:toc:read`, `content:topics:readonly`, `content:file:read` — [course topics and file downloads](https://docs.valence.desire2learn.com/res/content.html)
- `news:newsitems:read` — [announcements and attachments](https://docs.valence.desire2learn.com/res/news.html)
- `discussions:forums:readonly`, `discussions:topics:readonly`, `discussions:posts:readonly` — [forums, posts, attachments](https://docs.valence.desire2learn.com/res/discuss.html)
- `enrollment:orgunit:read` — [classlist](https://docs.valence.desire2learn.com/res/enroll.html)
- `groups:group:read`, `users:own_profile:read` — [groups](https://docs.valence.desire2learn.com/res/groups.html) and [own identity for older APIs](https://docs.valence.desire2learn.com/res/user.html)
- `quizzing:quizzes:read` — [quiz listings, details, questions](https://docs.valence.desire2learn.com/res/quiz.html)
- `calendar:my_events:read` — [own course calendar events](https://docs.valence.desire2learn.com/res/calendar.html)

Scopes do not override your institution's permissions or release restrictions. A `401` requires signing in again with `npm run login` in browser mode, or replacing the token and restarting in OAuth mode. A `403` indicates insufficient permissions or scopes. A `404` can indicate an unavailable resource or unsupported API version. Rate-limit responses are surfaced without automatic retries.

## Privacy and boundaries

Course operations use GET requests, send session credentials only to the configured HTTPS origin, reject API redirects, and use a 30-second request timeout. Browser authentication can additionally POST to the fixed session-token endpoint on that same origin. Manual login follows normal school SSO navigation in the browser. Session credentials and explicitly downloaded documents are persisted locally; other course results and upstream error bodies are not logged or saved by this server. The document tool writes local files and is annotated accordingly, while Brightspace coursework operations remain read-only. Any returned information is visible to your MCP client and its configured AI provider. Course materials should be treated as untrusted content.

PDF/text extraction, full-text search, submission writes, quiz attempts, external-service downloads, a standalone coursework CLI, and automatic registered-OAuth login/refresh are future work. There is no hosted service or multi-user token store.

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

`src/browser-auth.ts` handles manual login and session-backed API reads; `src/session.ts` stores tenant-bound credentials. `src/setup.ts` implements the terminal wizard and `src/setup-guide.ts` shares instructions with the MCP setup tool. `src/client.ts` contains the reusable Brightspace client; `src/server.ts` maps it to MCP tools; `src/index.ts` starts stdio transport. Tests use synthetic API responses, an in-memory MCP client, and an actual stdio handshake. They do not need student credentials. Live CUNY checks verified document discovery and DOCX/PDF downloads, announcements, discussion posts, classlist, group membership, calendar, quiz listings/details, and own-submission status. Quiz question retrieval returned the expected permission denial (`403`) for the sampled student context. This does not guarantee access to every resource in every course; instructor permissions and API versions still apply.

## Updating an existing agent session

For a separate checkout, first obtain the latest published commits and dependencies:

```sh
git pull --ff-only
npm ci
npm run build
npm run browser:install
```

If the agent uses this same local checkout, just build the updated source with `npm run build`. Restart its MCP connection (or the agent application/session) so it launches the new `dist/index.js`; existing server processes keep their loaded code. Existing OAuth configurations continue to work. To switch to browser mode, run `npm run setup`, choose browser login, then restart the MCP connection to load the updated `.env`.
