import { z } from 'zod';
import type { Config } from './config.js';

export class BrightspaceError extends Error {}
const id = z.string().regex(/^\d+$/, 'Expected a numeric Brightspace ID');
const assignment = z.object({ Id: z.number(), Name: z.string(), DueDate: z.string().nullable().optional() }).passthrough();
const page = z.object({
  Items: z.array(z.unknown()),
  PagingInfo: z.object({ HasMoreItems: z.boolean(), Bookmark: z.string().nullable().optional() }),
});

/** GET-only client. No arbitrary URLs, redirects, disk writes, or persisted student data. */
export class BrightspaceClient {
  constructor(private config: Config, private fetcher: typeof fetch = fetch) {}

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
