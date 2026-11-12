import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createYoga } from 'graphql-yoga';
import { CaseStore } from './store.ts';
import { schema } from './graphql.ts';

export function makeApp(store: CaseStore) {
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: { title: 'CaseGraph | GraphiQL' },
    context: ({ request }) => ({
      store,
      token: /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1],
      actor: (request.headers.get('x-casegraph-actor') ?? 'CaseGraph User').slice(0,80),
      requestId: request.headers.get('x-request-id') ?? randomUUID()
    })
  });
  const staticFiles = new Map([
    ['/', ['web/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['web/app.js', 'application/javascript; charset=utf-8']],
    ['/styles.css', ['web/styles.css', 'text/css; charset=utf-8']]
  ]);
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const requestId = randomUUID();
    response.setHeader('X-Request-ID', requestId);
    if (url.pathname === '/graphql') {
      request.headers['x-request-id'] = requestId;
      // A GraphQL Yoga request listener handles GET introspection and POST operations.
      void yoga(request, response);
      return;
    }
    if (url.pathname === '/healthz') {
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({status:'ok',version:'1.0.0'}));
      return;
    }
    const route = staticFiles.get(url.pathname);
    if (!route || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error:'Not found' }));
      return;
    }
    try {
      const [file, mime] = route;
      response.setHeader('Content-Type',mime);
      response.setHeader('X-Content-Type-Options','nosniff');
      response.setHeader('Cache-Control','no-store');
      // No third-party assets or CDNs; user data is intentionally synthetic.
      if (request.method === 'HEAD') response.end();
      else response.end(readFileSync(resolve(import.meta.dirname,'..',file)));
    } catch(error) {
      console.error('File serving error',error);
      response.writeHead(500);response.end('Server error');
    }
  });
}

const isEntry = process.argv[1]?.endsWith('/src/server.ts') || process.argv[1]?.endsWith('src\\server.ts');
if (isEntry) {
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '127.0.0.1';
  const store = new CaseStore(process.env.CASEGRAPH_DB_PATH ?? './data/casegraph.sqlite');
  makeApp(store).listen(port,host,()=>{
    console.log(`CaseGraph: http://${host}:${port} | GraphiQL: http://${host}:${port}/graphql`);
    console.log(process.env.CASEGRAPH_WRITE_TOKEN && process.env.CASEGRAPH_WRITE_TOKEN.length >= 16 ? 'Mutations: bearer-token enabled':'Mutations: read-only (configure CASEGRAPH_WRITE_TOKEN >=16 characters)');
  });
}
