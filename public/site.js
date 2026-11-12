'use strict';
const OPERATIONS = {
  nested: {
    title: 'Why nested queries matter',
    explanation: 'One operation fetches the case, its customer, assigned agent, and recent events. Remove fields from the selection set and run again to see a smaller response.',
    query: `query CaseAndRelationships {
  case(id: "1") {
    id
    subject
    status
    severity
    customer { name plan }
    assignee { name team }
    events(first: 2) { type message }
  }
}`,
    variables: {}
  },
  filter: {
    title: 'Filter on the server, not in the browser',
    explanation: 'Arguments constrain which records the resolver returns. The nested field selection tells GraphQL exactly which fields the client needs.',
    query: `query CriticalQueue {
  cases(severity: HIGH, first: 5) {
    totalCount
    edges {
      node { id subject status severity }
    }
  }
}`,
    variables: {}
  },
  pagination: {
    title: 'Cursor-based pagination',
    explanation: 'Run once, copy pageInfo.endCursor into the after variable, and run again to fetch the next page. No offset arithmetic needed.',
    query: `query PageThroughCases($after: String) {
  cases(first: 2, after: $after) {
    totalCount
    edges { cursor node { id subject } }
    pageInfo { endCursor hasNextPage }
  }
}`,
    variables: { after: null }
  },
  introspection: {
    title: 'The schema is discoverable',
    explanation: 'GraphQL introspection allows tools and people to discover operations and field names directly from the live API, without guessing.',
    query: `query ExploreSchema {
  __schema {
    queryType { name fields { name } }
    mutationType { name fields { name } }
  }
}`,
    variables: {}
  },
  validation: {
    title: 'Understanding validation errors',
    explanation: 'GraphQL validates field selections against its typed schema before executing them. The errors array points to the unknown field.',
    query: `query BrokenSelection {
  case(id: "1") {
    id
    subject
    fieldThatDoesNotExist
  }
}`,
    variables: {}
  },
  auth: {
    title: 'A protected mutation is supposed to fail',
    explanation: 'This is a public, read-only environment. The resolver rejects writes and returns an UNAUTHENTICATED code. Run the local project with your own secret to practice persistent mutations.',
    query: `mutation ProtectedWrite {
  updateCaseStatus(id: "1", status: RESOLVED) {
    id
    status
  }
}`,
    variables: {}
  }
};
const $ = (id) => document.getElementById(id);
let currentPreset = 'nested';
let lastResponse = '';
let inFlight = false;
let toastTimer;
const endpoint = '/graphql';
function notify(text) {
  const node = $('toast');
  node.textContent = text;
  node.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('visible'), 2400);
}
function choosePreset(name) {
  const op = OPERATIONS[name];
  if (!op) return;
  currentPreset = name;
  $('queryEditor').value = op.query;
  $('variablesEditor').value = JSON.stringify(op.variables, null, 2);
  $('lessonTitle').textContent = op.title;
  $('lessonDescription').textContent = op.explanation;
  document.querySelectorAll('.preset').forEach((node) => {
    const active = node.dataset.preset === name;
    node.classList.toggle('active', active);
    node.setAttribute('aria-pressed', String(active));
  });
}
async function runOperation() {
  if (inFlight) return;
  const query = $('queryEditor').value.trim();
  if (!query) { notify('Enter a GraphQL query first'); return; }
  let variables;
  try {
    variables = JSON.parse($('variablesEditor').value.trim() || '{}');
    if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) throw Error('Variables must be a JSON object');
  } catch (error) {
    $('responseEditor').textContent = JSON.stringify({ error: 'Invalid variables JSON', details: String(error.message ?? error) }, null, 2);
    $('responseStatus').textContent = 'LOCAL VALIDATION ERROR';
    $('responseStatus').className = 'response-status error';
    $('requestMeta').textContent = 'Request not sent';
    return;
  }
  inFlight = true;
  $('runQuery').disabled = true;
  $('runIcon').textContent = '◌';
  $('responseStatus').textContent = 'RUNNING';
  $('responseStatus').className = 'response-status';
  $('responseEditor').textContent = 'Running operation against the CaseGraph GraphQL API…';
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/graphql-response+json, application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
        cache: 'no-store'
      });
    } finally { clearTimeout(timeout); }
    const raw = await response.text();
    const duration = Math.round(performance.now() - start);
    let data;
    try { data = JSON.parse(raw); }
    catch { data = { error: 'Server returned a non-JSON response', snippet: raw.slice(0, 500) }; }
    lastResponse = JSON.stringify(data, null, 2);
    $('responseEditor').textContent = lastResponse;
    const hasGraphQLErrors = Array.isArray(data.errors) && data.errors.length > 0;
    $('responseStatus').textContent = hasGraphQLErrors ? 'GRAPHQL ERRORS' : response.ok ? 'SUCCESS' : `HTTP ${response.status}`;
    $('responseStatus').className = `response-status ${hasGraphQLErrors || !response.ok ? 'error' : 'ok'}`;
    const reqId = response.headers.get('x-request-id') ?? 'n/a';
    $('requestMeta').textContent = `HTTP ${response.status} · ${duration} ms · request ${reqId.slice(0, 18)}`;
  } catch (error) {
    lastResponse = JSON.stringify({ error: error.name === 'AbortError' ? 'Request timed out' : 'Network error', detail: String(error.message ?? error) }, null, 2);
    $('responseEditor').textContent = lastResponse;
    $('responseStatus').textContent = 'NETWORK ERROR';
    $('responseStatus').className = 'response-status error';
    $('requestMeta').textContent = `${Math.round(performance.now() - start)} ms · request failed`;
  } finally {
    $('runQuery').disabled = false;
    $('runIcon').textContent = '▶';
    inFlight = false;
  }
}
async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); notify(`${label} copied`); }
  catch { notify('Clipboard access unavailable; select and copy the text'); }
}
async function checkHealth() {
  const box = $('apiHealth');
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ health { status version } }' }),
      cache: 'no-store'
    });
    const body = await response.json();
    const healthy = response.ok && body?.data?.health?.status === 'ok';
    box.className = `api-health ${healthy ? 'online' : 'offline'}`;
    box.lastElementChild.textContent = healthy ? 'Live GraphQL API' : 'API unavailable';
  } catch {
    box.className = 'api-health offline';
    box.lastElementChild.textContent = 'API unavailable';
  }
}
function setup() {
  choosePreset('nested');
  document.querySelectorAll('.preset').forEach((button) => button.addEventListener('click', () => choosePreset(button.dataset.preset)));
  document.querySelectorAll('[data-jump]').forEach((button) => button.addEventListener('click', () => {
    choosePreset(button.dataset.jump);
    document.getElementById('playground').scrollIntoView({ behavior: 'smooth' });
    runOperation();
  }));
  $('schemaShortcut').addEventListener('click', () => choosePreset('introspection'));
  $('runQuery').addEventListener('click', runOperation);
  $('copyQuery').addEventListener('click', () => copyText($('queryEditor').value, 'Query'));
  $('copyResponse').addEventListener('click', () => copyText(lastResponse || $('responseEditor').textContent, 'Response'));
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); runOperation(); }
  });
  checkHealth();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
else setup();
