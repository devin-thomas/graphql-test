import { randomUUID } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';

// Self-contained public Vercel demo. All examples are fictional. Real writes
// belong in the separate, locally persisted CaseGraph app (src/ directory).
const CUSTOMERS = [
  { id: '1', name: 'Northstar Logistics', plan: 'Enterprise' },
  { id: '2', name: 'Atlas Retail', plan: 'Business' },
  { id: '3', name: 'Beacon Financial', plan: 'Enterprise' },
  { id: '4', name: 'Cedar Labs', plan: 'Starter' }
];
const AGENTS = [
  { id: '1', name: 'Alex Rivera', team: 'Integrations' },
  { id: '2', name: 'Jordan Chen', team: 'Platform' },
  { id: '3', name: 'Sam Patel', team: 'Customer Engineering' }
];
type CaseStatus = 'NEW' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED';
type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type DemoCase = {
  id: string; subject: string; description: string; status: CaseStatus;
  severity: Severity; customerId: string; assignedAgentId: string | null;
  createdAt: string; updatedAt: string;
};
const CASES: DemoCase[] = [
  { id:'1', customerId:'1', assignedAgentId:'1', subject:'Webhook deliveries intermittently fail', description:'Partner webhooks retry after intermittent 503 responses. Trace delivery attempts and idempotency.', status:'IN_PROGRESS', severity:'CRITICAL', createdAt:'2026-11-08T14:00:00.000Z', updatedAt:'2026-11-08T14:00:00.000Z' },
  { id:'2', customerId:'2', assignedAgentId:'2', subject:'GraphQL reports unknown field', description:'The client requests an obsolete field after a schema rollout. Compare requested selection sets.', status:'WAITING_ON_CUSTOMER', severity:'HIGH', createdAt:'2026-11-09T09:30:00.000Z', updatedAt:'2026-11-09T09:30:00.000Z' },
  { id:'3', customerId:'3', assignedAgentId:'1', subject:'Connector OAuth token expired', description:'Scheduled ingestion returns 401. Refresh token rotation and account permissions need review.', status:'IN_PROGRESS', severity:'HIGH', createdAt:'2026-11-10T11:45:00.000Z', updatedAt:'2026-11-10T11:45:00.000Z' },
  { id:'4', customerId:'1', assignedAgentId:null, subject:'Slow case search for large tenant', description:'Pagination and indexed filtering need investigation for enterprise accounts.', status:'NEW', severity:'MEDIUM', createdAt:'2026-11-11T08:20:00.000Z', updatedAt:'2026-11-11T08:20:00.000Z' },
  { id:'5', customerId:'4', assignedAgentId:'3', subject:'Incorrect priority label in UI', description:'Visible priority is inconsistent after an update; data remains correct.', status:'RESOLVED', severity:'LOW', createdAt:'2026-11-05T16:10:00.000Z', updatedAt:'2026-11-05T16:10:00.000Z' },
  { id:'6', customerId:'2', assignedAgentId:'2', subject:'429 responses during bulk import', description:'Bulk background API calls exceed the configured request budget. Add throttling and backoff.', status:'NEW', severity:'HIGH', createdAt:'2026-11-11T19:00:00.000Z', updatedAt:'2026-11-11T19:00:00.000Z' },
  { id:'7', customerId:'3', assignedAgentId:null, subject:'Partial GraphQL response with errors', description:'Some fields return null under authorization rules while the operation succeeds overall.', status:'NEW', severity:'MEDIUM', createdAt:'2026-11-12T08:00:00.000Z', updatedAt:'2026-11-12T08:00:00.000Z' }
];
const EVENTS = CASES.map((c) => ({ id:c.id, caseId:c.id, type:'CREATED', message:'Case created in sample data', actor:'Seed', createdAt:c.createdAt }));
const typeDefs = /* GraphQL */ `
  """A fictional support customer with a stable identifier."""
  type Customer { id: ID!, name: String!, plan: String!, cases(first: Int = 10, after: String): CaseConnection! }
  type Agent { id: ID!, name: String!, team: String! }
  enum CaseStatus { NEW IN_PROGRESS WAITING_ON_CUSTOMER RESOLVED }
  enum Severity { LOW MEDIUM HIGH CRITICAL }
  enum EventType { CREATED NOTE STATUS_CHANGED ASSIGNED }
  type CaseEvent { id: ID!, type: EventType!, message: String!, actor: String!, createdAt: String! }
  type SupportCase {
    id: ID!, subject: String!, description: String!, status: CaseStatus!, severity: Severity!,
    customer: Customer!, assignee: Agent, events(first: Int = 50): [CaseEvent!]!,
    createdAt: String!, updatedAt: String!
  }
  type CaseEdge { cursor: String!, node: SupportCase! }
  type PageInfo { hasNextPage: Boolean!, endCursor: String }
  type CaseConnection { edges: [CaseEdge!]!, totalCount: Int!, pageInfo: PageInfo! }
  type CaseMetrics { total: Int!, new: Int!, inProgress: Int!, waiting: Int!, resolved: Int! }
  type Health { status: String!, version: String!, time: String! }
  input CreateCaseInput { customerId: ID!, subject: String!, description: String!, severity: Severity! }
  """All query data is synthetic and available for public exploration."""
  type Query {
    health: Health!
    customers: [Customer!]!
    agents: [Agent!]!
    case(id: ID!): SupportCase
    cases(status: CaseStatus, severity: Severity, customerId: ID, search: String, first: Int = 10, after: String): CaseConnection!
    metrics: CaseMetrics!
  }
  """For safety, public mutations demonstrate authorization errors; run locally for real writes."""
  type Mutation {
    createCase(input: CreateCaseInput!): SupportCase!
    updateCaseStatus(id: ID!, status: CaseStatus!): SupportCase!
    assignCase(id: ID!, agentId: ID!): SupportCase!
    addCaseNote(id: ID!, message: String!): CaseEvent!
  }
`;
function badInput(message: string): never {
  throw new GraphQLError(message, { extensions: { code:'BAD_USER_INPUT' } });
}
function pagination(rows: DemoCase[], first = 10, after?: string | null) {
  if (!Number.isInteger(first) || first < 1 || first > 50) badInput('first must be between 1 and 50');
  const afterId = after ? decodeCursor(after) : 0;
  const next = rows.filter(c => Number(c.id) > afterId);
  const window = next.slice(0, first);
  const edges = window.map(node => ({ cursor: encodeCursor(node.id), node }));
  return { edges, totalCount: rows.length, pageInfo: { endCursor: edges.at(-1)?.cursor ?? null, hasNextPage: next.length > first } };
}
function encodeCursor(id: string) { return Buffer.from(`case:${id}`).toString('base64url'); }
function decodeCursor(cursor: string) {
  const decoded = Buffer.from(cursor, 'base64url').toString();
  if (!/^case:[1-9]\d*$/.test(decoded) || encodeCursor(decoded.slice(5)) !== cursor) badInput('Invalid cursor');
  return Number(decoded.slice(5));
}
function filterCases(args: { status?: CaseStatus; severity?: Severity; customerId?: string; search?: string; first?: number; after?: string }) {
  const search = (args.search ?? '').trim().toLowerCase();
  if (search.length > 120) badInput('search must be 120 characters or fewer');
  return pagination(CASES.filter(c => (!args.status || c.status === args.status) && (!args.severity || c.severity === args.severity) && (!args.customerId || c.customerId === args.customerId) && (!search || `${c.subject} ${c.description}`.toLowerCase().includes(search))), args.first, args.after);
}
function publicWriteDenied(): never {
  throw new GraphQLError('This public GraphQL demo is read-only. Run CaseGraph locally to practice mutations.', { extensions: { code:'UNAUTHENTICATED' } });
}
const schema = createSchema({
  typeDefs,
  resolvers: {
    Query: {
      health: () => ({ status:'ok', version:'1.0.0', time:new Date().toISOString() }),
      customers: () => CUSTOMERS,
      agents: () => AGENTS,
      case: (_: unknown, args: {id: string}) => CASES.find(c => c.id === args.id) ?? null,
      cases: (_: unknown, args: Parameters<typeof filterCases>[0]) => filterCases(args),
      metrics: () => ({ total:CASES.length, new:CASES.filter(c=>c.status==='NEW').length, inProgress:CASES.filter(c=>c.status==='IN_PROGRESS').length, waiting:CASES.filter(c=>c.status==='WAITING_ON_CUSTOMER').length, resolved:CASES.filter(c=>c.status==='RESOLVED').length })
    },
    Customer: { cases: (customer: {id:string}, args: {first?:number;after?:string}) => filterCases({...args,customerId:customer.id}) },
    SupportCase: {
      customer: (parent: DemoCase) => CUSTOMERS.find(c=>c.id===parent.customerId),
      assignee: (parent: DemoCase) => AGENTS.find(a=>a.id===parent.assignedAgentId) ?? null,
      events: (parent: DemoCase, args: {first?:number}) => {
        const first=args.first??50;
        if (!Number.isInteger(first)||first<1||first>100) badInput('first must be between 1 and 100');
        return EVENTS.filter(e=>e.caseId===parent.id).slice(0,first);
      }
    },
    Mutation: { createCase:publicWriteDenied, updateCaseStatus:publicWriteDenied, assignCase:publicWriteDenied, addCaseNote:publicWriteDenied }
  }
});
const yoga = createYoga({ schema, graphqlEndpoint:'/graphql', graphiql:{title:'CaseGraph — GraphiQL'} });
function jsonError(status: number, message: string, requestId: string) {
  return new Response(JSON.stringify({errors:[{message,extensions:{code:'BAD_REQUEST',requestId}}]}),{status,headers:{'content-type':'application/graphql-response+json','x-request-id':requestId,'cache-control':'no-store'}});
}
export default {
  async fetch(request: Request): Promise<Response> {
    const requestId=randomUUID();
    const url=new URL(request.url);
    url.pathname='/graphql'; // Canonical endpoint for both /graphql and the /api/graphql function.
    if (request.method==='POST') {
      if (Number(request.headers.get('content-length')||'0')>12000) return jsonError(413,'Request exceeds the public demo limit',requestId);
      try {
        const payload = await request.clone().json() as { query?: unknown };
        const query=typeof payload.query==='string'?payload.query:'';
        if (query.length>8000) return jsonError(413,'GraphQL operation too large',requestId);
        const clean=query.replace(/"(?:\\.|[^"\\])*"/g,'""');
        let depth=0;
        for (const char of clean) { if(char==='{'){if(++depth>9)return jsonError(400,'Operation depth exceeds demo limit',requestId)} else if(char==='}')depth--; }
      } catch { return jsonError(400,'Expected a GraphQL JSON request',requestId); }
    }
    const headers=new Headers(request.headers);
    headers.set('x-request-id',requestId);
    const forwarded=new Request(url.toString(),{method:request.method,headers,body:request.method==='GET'||request.method==='HEAD'?undefined:request.body,duplex:'half'} as RequestInit);
    const response=await yoga.fetch(forwarded);
    const responseHeaders=new Headers(response.headers);
    responseHeaders.set('x-request-id',requestId);
    responseHeaders.set('cache-control','no-store');
    responseHeaders.set('x-content-type-options','nosniff');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers:responseHeaders});
  }
};
