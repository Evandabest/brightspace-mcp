import { z } from 'zod';
import type { Config } from './config.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { saveDownload } from './downloads.js';

export class BrightspaceError extends Error {}
const id = z.string().regex(/^\d+$/, 'Expected a numeric Brightspace ID');
const assignment = z.object({ Id: z.number(), Name: z.string(), DueDate: z.string().nullable().optional() }).passthrough();
const page = z.object({
  Items: z.array(z.unknown()),
  PagingInfo: z.object({ HasMoreItems: z.boolean(), Bookmark: z.string().nullable().optional() }),
});

/** GET-only client. No arbitrary URLs, redirects, disk writes, or persisted student data. */
export class BrightspaceClient {
  constructor(private config: Config, private fetcher: typeof fetch = fetch, private fileFetcher: typeof fetch = fetcher) {}

  private path(product: 'lp' | 'le', suffix: string) {
    const version = product === 'lp' ? this.config.lpVersion : this.config.leVersion;
    return `/d2l/api/${product}/${version}/${suffix}`;
  }

  private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { ...(this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {}), Accept: 'application/json' },
      });
    } catch (error) {
      if (error instanceof BrightspaceError) throw error;
      throw new BrightspaceError('Brightspace request failed or timed out. Check the host and connection.');
    }
    if (!response.ok) {
      const hints: Record<number, string> = {
        401: 'Access token expired or invalid. Supply a new OAuth access token and restart.',
        403: 'Your account or OAuth scopes do not allow this operation. With browser login, try npm run login; this tenant may restrict session-based API access.',
        404: 'Resource not found. Check IDs and configured API versions.',
        429: 'Brightspace rate limit reached. Try again later.',
      };
      // Do not echo upstream bodies: they can contain personal data or credentials.
      throw new BrightspaceError(`Brightspace HTTP ${response.status}: ${hints[response.status] ?? 'Request unsuccessful.'}`);
    }
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      throw new BrightspaceError('Expected JSON from Brightspace; check the host and API configuration.');
    }
    try { return await response.json(); }
    catch { throw new BrightspaceError('Brightspace returned invalid JSON.'); }
  }

  async getCourses() {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let bookmark: string | undefined;
    for (let count = 0; count < 100; count++) {
      const result = page.safeParse(await this.get(this.path('lp', 'enrollments/myenrollments/'), {
        orgUnitTypeId: '3', ...(bookmark ? { bookmark } : {}),
      }));
      if (!result.success) throw new BrightspaceError('Unexpected Brightspace enrollment response.');
      items.push(...result.data.Items);
      if (!result.data.PagingInfo.HasMoreItems) return items;
      const next = result.data.PagingInfo.Bookmark;
      if (!next || seen.has(next)) throw new BrightspaceError('Brightspace returned invalid pagination.');
      seen.add(next);
      bookmark = next;
    }
    throw new BrightspaceError('Enrollment pagination exceeded 100 pages; results were not returned partially.');
  }

  async getAssignments(courseId: string) {
    const value = await this.get(this.path('le', `${id.parse(courseId)}/dropbox/folders/`));
    const parsed = z.array(assignment).safeParse(value);
    if (!parsed.success) throw new BrightspaceError('Unexpected Brightspace assignment response.');
    return parsed.data;
  }

  getAssignmentDetails(courseId: string, assignmentId: string) {
    return this.get(this.path('le', `${id.parse(courseId)}/dropbox/folders/${id.parse(assignmentId)}`));
  }

  getGrades(courseId: string) {
    return this.get(this.path('le', `${id.parse(courseId)}/grades/values/myGradeValues/`));
  }

  getCourseContent(courseId: string) {
    return this.get(this.path('le', `${id.parse(courseId)}/content/toc`));
  }

  getContentTopic(courseId: string, topicId: string) {
    return this.get(this.path('le', `${id.parse(courseId)}/content/topics/${id.parse(topicId)}`));
  }

  async listCourseDocuments(courseId: string) {
    const toc = await this.getCourseContent(courseId);
    const root = z.object({ Modules: z.array(z.unknown()) }).safeParse(toc);
    if (!root.success) throw new BrightspaceError('Unexpected course table of contents.');
    const documents: Record<string, unknown>[] = [];
    const visit = (modules: unknown[], parents: string[], depth: number) => {
      if (depth > 100) throw new BrightspaceError('Course content exceeds the supported nesting depth.');
      for (const value of modules) {
        const module = z.object({ Title: z.string(), Topics: z.array(z.unknown()).optional(), Modules: z.array(z.unknown()).optional() }).parse(value);
        const path = [...parents, module.Title];
        for (const value of module.Topics ?? []) {
          const topic = z.object({ TopicId: z.number(), Title: z.string(), TopicType: z.number(), Url: z.string().nullable().optional() }).passthrough().parse(value);
          documents.push({ courseId, topicId: String(topic.TopicId), title: topic.Title, modulePath: path, topicType: topic.TopicType,
            url: topic.Url ?? null, downloadable: topic.TopicType === 1,
            nextStep: topic.TopicType === 1 ? 'download_document with source=content_topic and topic_id' : 'get_content_topic to inspect the link; external services may require their own login' });
        }
        visit(module.Modules ?? [], path, depth + 1);
      }
    };
    try { visit(root.data.Modules, [], 0); }
    catch (error) { if (error instanceof BrightspaceError) throw error; throw new BrightspaceError('Unexpected course module or topic response.'); }
    return { documents, note: 'Lists visible file and link topics. Files embedded inside HTML pages may require inspecting that page after download.' };
  }

  async downloadDocument(source: DocumentSource, courseId: string, ids: Record<string, string | undefined>, directory?: string) {
    const course = id.parse(courseId);
    const required = (key: string) => {
      if (!ids[key] || !/^\d+$/.test(ids[key]!)) throw new BrightspaceError(`${source} requires a numeric ${key}.`);
      return ids[key]!;
    };
    let suffix: string;
    switch (source) {
      case 'content_topic': suffix = `${course}/content/topics/${required('topic_id')}/file`; break;
      case 'assignment_attachment': suffix = `${course}/dropbox/folders/${required('assignment_id')}/attachments/${required('file_id')}`; break;
      case 'announcement_attachment': suffix = `${course}/news/${required('announcement_id')}/attachments/${required('file_id')}`; break;
      case 'discussion_attachment': suffix = `${course}/discussions/forums/${required('forum_id')}/topics/${required('topic_id')}/posts/${required('post_id')}/attachments/${required('file_id')}`; break;
      case 'submission_file': {
        // Confirm the file belongs to the signed-in student's submissions before retrieving bytes.
        const own = z.array(z.object({ Submissions: z.array(z.object({ Id: z.number(), Files: z.array(z.object({ FileId: z.number() })) })) })).parse(
          await this.get(this.path('le', `${course}/dropbox/folders/${required('assignment_id')}/submissions/mysubmissions/`)));
        const submission = own.flatMap(entity => entity.Submissions).find(item => String(item.Id) === required('submission_id'));
        if (!submission?.Files.some(file => String(file.FileId) === required('file_id'))) throw new BrightspaceError('File was not found in your own submissions.');
        suffix = `${course}/dropbox/folders/${required('assignment_id')}/submissions/${required('submission_id')}/files/${required('file_id')}`;
        break;
      }
      case 'course_file': {
        if (!ids.url) throw new BrightspaceError('Supply the course file URL returned in course content or linked in a downloaded page.');
        const url = new URL(ids.url, this.config.baseUrl);
        if (url.origin !== this.config.baseUrl || url.username || url.password || url.hash ||
            !new RegExp(`^/content/enforced/${course}(?:-|/)`).test(url.pathname) || /%2f|%5c|%2e/i.test(url.pathname)) {
          throw new BrightspaceError('Only direct /content/enforced/ files belonging to this course on the configured Brightspace host can be downloaded by URL. Use a topic or attachment ID otherwise.');
        }
        return this.downloadUrl(url, course, directory);
      }
      default: throw new BrightspaceError('Unsupported document source.');
    }
    return this.downloadUrl(new URL(this.path('le', suffix), this.config.baseUrl), course, directory);
  }

  private async downloadUrl(url: URL, courseId: string, directory?: string) {
    let response: Response;
    try {
      response = await this.fileFetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { Accept: '*/*', ...(this.config.accessToken ? { Authorization: `Bearer ${this.config.accessToken}` } : {}) } });
    } catch (error) {
      if (error instanceof BrightspaceError) throw error;
      throw new BrightspaceError('Document request failed or redirected. Check access; external document hosts need their own authentication.');
    }
    // A login page must never be reported as a downloaded assignment or PDF.
    const contentType = response.headers.get('content-type') ?? '';
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new BrightspaceError('Document redirected; sign in again or use the external document service directly.');
    }
    if (response.ok && contentType.includes('text/html')) {
      // Inspect only a bounded prefix, preserving the original stream for genuine HTML course pages.
      const reader = response.body?.getReader();
      if (reader) {
        const first = await reader.read();
        const prefix = new TextDecoder().decode(first.value?.subarray(0, 16_384));
        if (/sessionExpired=1|<form[^>]+(?:login|signin)|type=["']password["']/i.test(prefix)) {
          await reader.cancel();
          throw new BrightspaceError('Brightspace returned a login page. Run npm run login, then retry the download.');
        }
        response = new Response(new ReadableStream({
          start(controller) { if (first.value) controller.enqueue(first.value); if (first.done) controller.close(); },
          async pull(controller) { try { const chunk = await reader.read(); if (chunk.done) controller.close(); else controller.enqueue(chunk.value); } catch (error) { controller.error(error); } },
          cancel(reason) { return reader.cancel(reason); },
        }), { status: response.status, headers: response.headers });
      }
    }
    return saveDownload(response, directory ?? join(homedir(), 'Downloads', 'brightspace-mcp', courseId), `document-${courseId}.bin`);
  }

  async getUpcomingDeadlines(courseIds: string[], days = 14, now = new Date()) {
    z.array(id).min(1).max(50).parse(courseIds);
    z.number().int().min(1).max(365).parse(days);
    const end = now.getTime() + days * 86_400_000;
    const deadlines: { courseId: string; assignmentId: number; name: string; dueDate: string }[] = [];
    const errors: { courseId: string; error: string }[] = [];
    // Sequential to avoid bursting against the institution's rate limits.
    for (const courseId of new Set(courseIds)) {
      try {
        for (const item of await this.getAssignments(courseId)) {
          const due = item.DueDate ? Date.parse(item.DueDate) : NaN;
          if (due >= now.getTime() && due <= end) deadlines.push({
            courseId, assignmentId: item.Id, name: item.Name, dueDate: item.DueDate!,
          });
        }
      } catch (error) {
        if (!(error instanceof BrightspaceError)) throw error;
        errors.push({ courseId, error: error.message });
      }
    }
    deadlines.sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));
    return { deadlines, errors, complete: errors.length === 0, from: now.toISOString(), to: new Date(end).toISOString() };
  }
}

export type DocumentSource = 'content_topic' | 'assignment_attachment' | 'announcement_attachment' | 'discussion_attachment' | 'submission_file' | 'course_file';
