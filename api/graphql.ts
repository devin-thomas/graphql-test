import { randomUUID } from 'node:crypto';
import { createYoga } from 'graphql-yoga';
import { schema } from '../src/graphql.ts';
import { CaseStore } from '../src/store.ts';

// Public demo: all data is fictional; mutations are intentionally unauthorized.
// SQLite lives in memory and is not a persistence or tenant-isolation mechanism.
const store = new CaseStore(':memory:');
const yoga = createYoga({
  schema,
  graphqlEndpoint: '/graphql',
  graphiql: { title: 'CaseGraph — GraphiQL' },
  context: ({ request }) => ({
    store,
    token: undefined as string | undefined,
    actor: 'Public playground',
    requestId: request.headers.get('x-request-id') || randomUUID()
  })
});

export default {
  async fetch(request: Request): Promise<Response> {
    const requestId = randomUUID();
    const url = new URL(request.url);
    url.pathname = '/graphql'; // Vercel may serve this function at /api/graphql.

    if (request.method === 'POST') {
      const lengthHeader = Number(request.headers.get('content-length') || '0');
      if (lengthHeader > 12000) return jsonError(413, 'Request exceeds the public demo limit', requestId);
      try {
        const payload = await request.clone().json() as { query?: unknown };
        const query = typeof payload.query === 'string' ? payload.query : '';
        if (query.length > 8000) return jsonError(413, 'GraphQL operation too large', requestId);
        // Guard the public demo from pathological deeply recursive selection sets.
        const withoutStrings = query.replace(/"(?:\\.|[^"\\])*"/g, '""');
        let depth = 0;
        for (const char of withoutStrings) {
          if (char === '{' && ++depth > 9) return jsonError(400, 'Operation depth exceeds demo limit', requestId);
          if (char === '}') depth -= 1;
        }
      } catch { return jsonError(400, 'Expected a GraphQL JSON request', requestId); }
    }
    const headers = new Headers(request.headers);
    headers.set('x-request-id', requestId);
    const redirected = new Request(url.toString(), { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body, duplex: 'half' } as RequestInit);
    const response = await yoga.fetch(redirected);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('x-request-id', requestId);
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.set('x-content-type-options', 'nosniff');
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers:responseHeaders});
  }
};

function jsonError(status: number, message: string, requestId: string): Response {
  return new Response(JSON.stringify({errors:[{message,extensions:{code:'BAD_REQUEST',requestId}}]}),{
    status,
    headers:{'content-type':'application/graphql-response+json','x-request-id':requestId,'cache-control':'no-store'}
  });
}
