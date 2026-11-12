/** Persistent support-case domain. Standard-library-only to keep local tests independent. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type CaseStatus = 'NEW' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type EventType = 'CREATED' | 'NOTE' | 'STATUS_CHANGED' | 'ASSIGNED';

export type Customer = { id: number; name: string; plan: string };
export type Agent = { id: number; name: string; team: string };
export type SupportCase = {
  id: number;
  customerId: number;
  assignedAgentId: number | null;
  subject: string;
  description: string;
  status: CaseStatus;
  severity: Severity;
  createdAt: string;
  updatedAt: string;
};
export type CaseEvent = {
  id: number;
  caseId: number;
  type: EventType;
  message: string;
  actor: string;
  createdAt: string;
};
export type CaseFilter = { status?: CaseStatus | null; severity?: Severity | null; customerId?: number | null; search?: string | null; first?: number | null; after?: string | null };
export type Page<T> = { edges: Array<{ cursor: string; node: T }>; totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

export class DomainError extends Error {
  code: 'NOT_FOUND' | 'BAD_USER_INPUT' | 'CONFLICT';
  constructor(code: 'NOT_FOUND' | 'BAD_USER_INPUT' | 'CONFLICT', message: string) { super(message); this.code = code; this.name = 'DomainError'; }
}
const STATUSES = ['NEW', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED'] as const;
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const iso = () => new Date().toISOString();
const requiredText = (value: unknown, label: string, maximum: number): string => {
  const str = typeof value === 'string' ? value.trim() : '';
  if (!str || str.length > maximum) throw new DomainError('BAD_USER_INPUT', `${label} must contain 1–${maximum} characters`);
  return str;
};
const validId = (id: number): number => {
  if (!Number.isSafeInteger(id) || id < 1) throw new DomainError('BAD_USER_INPUT', 'ID must be a positive integer');
  return id;
};
export const toId = (v: string): number => validId(Number(v));
export const cursorFor = (id: number): string => Buffer.from(`case:${id}`, 'utf8').toString('base64url');
export function idFromCursor(v: string): number {
  try {
    const source = Buffer.from(v, 'base64url').toString('utf8');
    const m = /^case:([1-9]\d*)$/.exec(source);
    if (!m || cursorFor(Number(m[1])) !== v) throw new Error('invalid');
    return validId(Number(m[1]));
  } catch { throw new DomainError('BAD_USER_INPUT', 'Invalid pagination cursor'); }
}
function asCase(raw: Record<string, unknown>): SupportCase {
  return {
    id: Number(raw.id), customerId: Number(raw.customer_id),
    assignedAgentId: raw.assigned_agent_id === null ? null : Number(raw.assigned_agent_id),
    subject: String(raw.subject), description: String(raw.description),
    status: raw.status as CaseStatus, severity: raw.severity as Severity,
    createdAt: String(raw.created_at), updatedAt: String(raw.updated_at)
  };
}
function asEvent(raw: Record<string, unknown>): CaseEvent {
  return { id: Number(raw.id), caseId: Number(raw.case_id), type: raw.type as EventType, message: String(raw.message), actor: String(raw.actor), createdAt: String(raw.created_at) };
}

export class CaseStore {
  readonly db: DatabaseSync;
  constructor(filePath = ':memory:') {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA foreign_keys=ON');
    if (filePath !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        assigned_agent_id INTEGER REFERENCES agents(id),
        subject TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('NEW','IN_PROGRESS','WAITING_ON_CUSTOMER','RESOLVED')),
        severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cases_status_id ON cases(status, id);
      CREATE INDEX IF NOT EXISTS idx_cases_severity_id ON cases(severity, id);
      CREATE INDEX IF NOT EXISTS idx_cases_customer_id ON cases(customer_id, id);
      CREATE TABLE IF NOT EXISTS case_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL REFERENCES cases(id),
        type TEXT NOT NULL CHECK (type IN ('CREATED','NOTE','STATUS_CHANGED','ASSIGNED')),
        message TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_case_events_case_id ON case_events(case_id, id);
    `);
    if (this.countCases() === 0) this.seed();
  }
  close() { this.db.close(); }
  private seed() {
    this.db.exec(`
      INSERT OR IGNORE INTO customers(id,name,plan) VALUES
        (1,'Northstar Logistics','Enterprise'),(2,'Atlas Retail','Business'),(3,'Beacon Financial','Enterprise'),(4,'Cedar Labs','Starter');
      INSERT OR IGNORE INTO agents(id,name,team) VALUES
        (1,'Alex Rivera','Integrations'),(2,'Jordan Chen','Platform'),(3,'Sam Patel','Customer Engineering');
    `);
    const samples: Array<[number, number | null, string, string, CaseStatus, Severity, string]> = [
      [1,1,'Webhook deliveries intermittently fail','Partner webhooks retry after intermittent 503 responses. Trace delivery attempts and idempotency.', 'IN_PROGRESS','CRITICAL','2026-11-08T14:00:00.000Z'],
      [2,2,'GraphQL reports unknown field','The client requests an obsolete field after a schema rollout. Compare requested selection sets.', 'WAITING_ON_CUSTOMER','HIGH','2026-11-09T09:30:00.000Z'],
      [3,1,'Connector OAuth token expired','Scheduled ingestion returns 401. Refresh token rotation and account permissions need review.', 'IN_PROGRESS','HIGH','2026-11-10T11:45:00.000Z'],
      [1,null,'Slow case search for large tenant','Pagination and indexed filtering need investigation for enterprise accounts.', 'NEW','MEDIUM','2026-11-11T08:20:00.000Z'],
      [4,3,'Incorrect priority label in UI','Visible priority is inconsistent after an update; data remains correct.', 'RESOLVED','LOW','2026-11-05T16:10:00.000Z'],
      [2,2,'429 responses during bulk import','Bulk background API calls exceed the configured request budget. Add throttling and backoff.', 'NEW','HIGH','2026-11-11T19:00:00.000Z'],
      [3,null,'Partial GraphQL response with errors','Some fields return null under authorization rules while the operation succeeds overall.', 'NEW','MEDIUM','2026-11-12T08:00:00.000Z']
    ];
    const stmt = this.db.prepare('INSERT INTO cases(customer_id,assigned_agent_id,subject,description,status,severity,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    const event = this.db.prepare('INSERT INTO case_events(case_id,type,message,actor,created_at) VALUES(?,?,?,?,?)');
    for (const s of samples) {
      const result = stmt.run(...s, s[6]);
      event.run(Number(result.lastInsertRowid),'CREATED','Case created in sample data','Seed',s[6]);
    }
  }
  countCases(): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM cases').get() as {n:number}).n); }
  customers(): Customer[] { return this.db.prepare('SELECT * FROM customers ORDER BY id').all().map((r)=>r as Customer); }
  agents(): Agent[] { return this.db.prepare('SELECT * FROM agents ORDER BY id').all().map((r)=>r as Agent); }
  customer(id: number): Customer | null { return (this.db.prepare('SELECT * FROM customers WHERE id=?').get(validId(id)) as Customer | undefined) ?? null; }
  agent(id: number): Agent | null { return (this.db.prepare('SELECT * FROM agents WHERE id=?').get(validId(id)) as Agent | undefined) ?? null; }
  getCase(id: number): SupportCase | null {
    const r = this.db.prepare('SELECT * FROM cases WHERE id=?').get(validId(id));
    return r ? asCase(r) : null;
  }
  events(caseId: number, first = 50): CaseEvent[] {
    if (!Number.isInteger(first) || first < 1 || first > 100) throw new DomainError('BAD_USER_INPUT', 'first must be between 1 and 100');
    return this.db.prepare('SELECT * FROM case_events WHERE case_id=? ORDER BY id DESC LIMIT ?').all(validId(caseId),first).map(asEvent).reverse();
  }
  cases(filter: CaseFilter = {}): Page<SupportCase> {
    const first = filter.first ?? 10;
    if (!Number.isInteger(first) || first < 1 || first > 50) throw new DomainError('BAD_USER_INPUT', 'first must be between 1 and 50');
    const wheres: string[] = []; const args: (string | number)[] = [];
    if (filter.status) { wheres.push('status=?'); args.push(filter.status); }
    if (filter.severity) { wheres.push('severity=?'); args.push(filter.severity); }
    if (filter.customerId) { wheres.push('customer_id=?'); args.push(validId(filter.customerId)); }
    if (filter.search) {
      const term = requiredText(filter.search,'search',120).replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_');
      wheres.push('(subject LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')'); args.push(`%${term}%`,`%${term}%`);
    }
    const clause = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : '';
    const totalCount = Number((this.db.prepare(`SELECT COUNT(*) n FROM cases${clause}`).get(...args) as {n: number}).n);
    if (filter.after) { wheres.push('id>?'); args.push(idFromCursor(filter.after)); }
    const rows = this.db.prepare(`SELECT * FROM cases${wheres.length ? ` WHERE ${wheres.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`).all(...args,first + 1).map(asCase);
    const more = rows.length > first;
    const selected = rows.slice(0,first);
    return {
      edges: selected.map((node)=>({cursor:cursorFor(node.id),node})), totalCount,
      pageInfo: {hasNextPage:more,endCursor:selected.length ? cursorFor(selected.at(-1)!.id):null}
    };
  }
  metrics() {
    const counts = this.db.prepare('SELECT status, COUNT(*) count FROM cases GROUP BY status').all() as Array<{status:string; count:number}>;
    const out: Record<CaseStatus,number> = {NEW:0,IN_PROGRESS:0,WAITING_ON_CUSTOMER:0,RESOLVED:0};
    for (const {status,count} of counts) out[status as CaseStatus]=Number(count);
    return {total:this.countCases(),new:out.NEW,inProgress:out.IN_PROGRESS,waiting:out.WAITING_ON_CUSTOMER,resolved:out.RESOLVED};
  }
  createCase(input: {customerId:number; subject:string; description:string; severity:Severity}, actor: string): SupportCase {
    validId(input.customerId);
    if (!this.customer(input.customerId)) throw new DomainError('NOT_FOUND','Customer not found');
    if (!SEVERITIES.includes(input.severity)) throw new DomainError('BAD_USER_INPUT','Invalid severity');
    const subject=requiredText(input.subject,'subject',120);
    const description=requiredText(input.description,'description',2000);
    const user=requiredText(actor,'actor',80);
    const now=iso();
    const run=this.db.prepare('INSERT INTO cases(customer_id,assigned_agent_id,subject,description,status,severity,created_at,updated_at) VALUES(?,NULL,?,?,\'NEW\',?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result=run.run(input.customerId,subject,description,input.severity,now,now);
      this.appendEvent(Number(result.lastInsertRowid),'CREATED','Case created',user,now);
      this.db.exec('COMMIT');
      return this.getCase(Number(result.lastInsertRowid))!;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  updateStatus(caseId:number, status:CaseStatus, actor:string): SupportCase {
    if (!STATUSES.includes(status)) throw new DomainError('BAD_USER_INPUT','Invalid status');
    const existing=this.getCase(caseId);
    if (!existing) throw new DomainError('NOT_FOUND','Case not found');
    if (existing.status === status) throw new DomainError('CONFLICT','Case already has this status');
    const user=requiredText(actor,'actor',80); const now=iso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE cases SET status=?,updated_at=? WHERE id=?').run(status,now,caseId);
      this.appendEvent(caseId,'STATUS_CHANGED',`${existing.status} → ${status}`,user,now);
      this.db.exec('COMMIT');return this.getCase(caseId)!;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  assign(caseId:number, agentId:number, actor:string): SupportCase {
    if (!this.getCase(caseId)) throw new DomainError('NOT_FOUND','Case not found');
    if (!this.agent(agentId)) throw new DomainError('NOT_FOUND','Agent not found');
    const user=requiredText(actor,'actor',80); const now=iso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE cases SET assigned_agent_id=?, updated_at=? WHERE id=?').run(agentId,now,caseId);
      this.appendEvent(caseId,'ASSIGNED',`Assigned to ${this.agent(agentId)!.name}`,user,now);
      this.db.exec('COMMIT');return this.getCase(caseId)!;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  addNote(caseId:number, message:string, actor:string): CaseEvent {
    if (!this.getCase(caseId)) throw new DomainError('NOT_FOUND','Case not found');
    const content=requiredText(message,'message',2000);const user=requiredText(actor,'actor',80);const now=iso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result=this.appendEvent(caseId,'NOTE',content,user,now);
      this.db.prepare('UPDATE cases SET updated_at=? WHERE id=?').run(now,caseId);
      this.db.exec('COMMIT');
      return asEvent(this.db.prepare('SELECT * FROM case_events WHERE id=?').get(result) as Record<string,unknown>);
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  private appendEvent(caseId:number,type:EventType,message:string,actor:string,createdAt:string) {
    const result=this.db.prepare('INSERT INTO case_events(case_id,type,message,actor,created_at) VALUES(?,?,?,?,?)').run(caseId,type,message,actor,createdAt);
    return Number(result.lastInsertRowid);
  }
}
