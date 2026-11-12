import { createSchema } from 'graphql-yoga';
import { GraphQLError } from 'graphql';
import { createHash, timingSafeEqual } from 'node:crypto';
import { CaseStore, DomainError, toId, type SupportCase, type CaseFilter } from './store.ts';

export type AppContext = { store: CaseStore; token: string | undefined; actor: string; requestId: string };

type IdArg = { id: string };
type FilterArgs = CaseFilter & { customerId?: string | null };
type MutationArgs<T> = { input: T };

export function assertWrite(ctx: AppContext): void {
  const configured = process.env.CASEGRAPH_WRITE_TOKEN;
  const received = ctx.token ?? '';
  // Use constant-time comparison regardless of token length. Missing configuration = read-only.
  const digest = (s: string) => createHash('sha256').update(s).digest();
  if (!configured || configured.length < 16 || !received || !timingSafeEqual(digest(configured), digest(received))) {
    throw new GraphQLError('A valid write bearer token is required', {
      extensions: { code: 'UNAUTHENTICATED', requestId: ctx.requestId }
    });
  }
}

export function asGraphqlError(error: unknown, ctx: AppContext): never {
  if (error instanceof GraphQLError) throw error;
  if (error instanceof DomainError) {
    throw new GraphQLError(error.message, { extensions: { code: error.code, requestId: ctx.requestId } });
  }
  console.error('GraphQL resolver error', { requestId: ctx.requestId, message: error instanceof Error ? error.message : String(error) });
  throw new GraphQLError('Unexpected server error', { extensions: { code: 'INTERNAL_SERVER_ERROR', requestId: ctx.requestId } });
}
const guard = <T>(ctx: AppContext, fn: () => T): T => {
  try { return fn(); } catch (error) { return asGraphqlError(error, ctx); }
};

export const schema = createSchema({
  typeDefs: /* GraphQL */ `
    """A support customer, represented with stable IDs."""
    type Customer {
      id: ID!
      name: String!
      plan: String!
      cases(first: Int = 10, after: String): CaseConnection!
    }
    type Agent { id: ID!, name: String!, team: String! }
    enum CaseStatus { NEW IN_PROGRESS WAITING_ON_CUSTOMER RESOLVED }
    enum Severity { LOW MEDIUM HIGH CRITICAL }
    enum EventType { CREATED NOTE STATUS_CHANGED ASSIGNED }
    type CaseEvent { id: ID!, type: EventType!, message: String!, actor: String!, createdAt: String! }
    type SupportCase {
      id: ID!
      subject: String!
      description: String!
      status: CaseStatus!
      severity: Severity!
      customer: Customer!
      assignee: Agent
      events(first: Int = 50): [CaseEvent!]!
      createdAt: String!
      updatedAt: String!
    }
    type CaseEdge { cursor: String!, node: SupportCase! }
    type PageInfo { hasNextPage: Boolean!, endCursor: String }
    type CaseConnection { edges: [CaseEdge!]!, totalCount: Int!, pageInfo: PageInfo! }
    type CaseMetrics { total: Int!, new: Int!, inProgress: Int!, waiting: Int!, resolved: Int! }
    type Health { status: String!, version: String!, time: String! }

    input CreateCaseInput {
      customerId: ID!
      subject: String!
      description: String!
      severity: Severity!
    }
    """Read-only queries work without authorization. All data is synthetic demo data."""
    type Query {
      health: Health!
      customers: [Customer!]!
      agents: [Agent!]!
      case(id: ID!): SupportCase
      cases(status: CaseStatus, severity: Severity, customerId: ID, search: String, first: Int = 10, after: String): CaseConnection!
      metrics: CaseMetrics!
    }
    """Mutations require an Authorization: Bearer <token> header."""
    type Mutation {
      createCase(input: CreateCaseInput!): SupportCase!
      updateCaseStatus(id: ID!, status: CaseStatus!): SupportCase!
      assignCase(id: ID!, agentId: ID!): SupportCase!
      addCaseNote(id: ID!, message: String!): CaseEvent!
    }
  `,
  resolvers: {
    Query: {
      health: () => ({ status: 'ok', version: '1.0.0', time: new Date().toISOString() }),
      customers: (_: unknown, args: unknown, ctx: AppContext) => ctx.store.customers(),
      agents: (_: unknown, args: unknown, ctx: AppContext) => ctx.store.agents(),
      case: (_: unknown, args: IdArg, ctx: AppContext) => guard(ctx, () => ctx.store.getCase(toId(args.id))),
      cases: (_: unknown, args: FilterArgs, ctx: AppContext) => guard(ctx, () => ctx.store.cases({ ...args, customerId: args.customerId ? toId(args.customerId) : null })),
      metrics: (_: unknown, args: unknown, ctx: AppContext) => ctx.store.metrics()
    },
    Customer: {
      cases: (parent: {id: number}, args: {first: number; after?: string}, ctx: AppContext) => guard(ctx, () => ctx.store.cases({customerId:parent.id,...args}))
    },
    SupportCase: {
      customer: (parent: SupportCase, args: unknown, ctx: AppContext) => guard(ctx, () => ctx.store.customer(parent.customerId)),
      assignee: (parent: SupportCase, args: unknown, ctx: AppContext) => parent.assignedAgentId ? guard(ctx, () => ctx.store.agent(parent.assignedAgentId!)) : null,
      events: (parent: SupportCase, args: {first?: number}, ctx: AppContext) => guard(ctx, () => ctx.store.events(parent.id,args.first ?? 50))
    },
    Mutation: {
      createCase: (_: unknown, args: MutationArgs<{customerId:string; subject:string;description:string;severity:'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'}>, ctx: AppContext) => guard(ctx, () => {
        assertWrite(ctx);
        return ctx.store.createCase({...args.input,customerId:toId(args.input.customerId)},ctx.actor);
      }),
      updateCaseStatus: (_: unknown, args: {id:string; status:'NEW'|'IN_PROGRESS'|'WAITING_ON_CUSTOMER'|'RESOLVED'}, ctx: AppContext) => guard(ctx, () => {
        assertWrite(ctx);return ctx.store.updateStatus(toId(args.id),args.status,ctx.actor);
      }),
      assignCase: (_: unknown, args: {id:string; agentId:string}, ctx: AppContext) => guard(ctx, () => {
        assertWrite(ctx);return ctx.store.assign(toId(args.id),toId(args.agentId),ctx.actor);
      }),
      addCaseNote: (_: unknown, args: {id:string; message:string}, ctx: AppContext) => guard(ctx, () => {
        assertWrite(ctx);return ctx.store.addNote(toId(args.id),args.message,ctx.actor);
      })
    }
  }
});
