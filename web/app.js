const $ = (selector) => document.querySelector(selector);
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const human = (s) => String(s ?? '').replaceAll('_',' ').toLowerCase().replace(/^./, m=>m.toUpperCase());
const date = (s) => new Date(s).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const authKey='casegraph-demo-write-token';
const getToken=()=>sessionStorage.getItem(authKey) ?? '';
let selectedId=null;
let rows=[];
let cursor=null;
let hasMore=false;
let customers=[];
let agents=[];
let lastFilterKey='';
let searchDebounce;

const CASE_FIELDS=`id subject description severity status createdAt updatedAt customer { id name plan } assignee { id name team } events(first: 30) { id type message actor createdAt }`;
const DATA_QUERY=`query Queue($status: CaseStatus, $severity: Severity, $search: String, $first: Int!, $after: String) {
  metrics { total new inProgress waiting resolved }
  customers { id name plan }
  agents { id name team }
  cases(status: $status, severity: $severity, search: $search, first: $first, after: $after) {
    totalCount pageInfo { hasNextPage endCursor }
    edges { cursor node { ${CASE_FIELDS} } }
  }
}`;
const exampleOps={
  caseDetails:{query:`query CaseInvestigation($id: ID!) {
  case(id: $id) {
    id subject status severity
    customer { name plan }
    assignee { name team }
    events { type message actor createdAt }
  }
}`,variables:{id:'1'}},
  cursor:{query:`query Page($first: Int!, $after: String) {
  cases(first: $first, after: $after) {
    totalCount
    edges { cursor node { id subject status } }
    pageInfo { hasNextPage endCursor }
  }
}`,variables:{first:3}},
  metrics:{query:`query Snapshot { metrics { total new inProgress waiting resolved } }`,variables:{}},
  mutation:{query:`mutation AddInvestigationNote($id: ID!, $message: String!) {
  addCaseNote(id: $id, message: $message) { id type message actor createdAt }
}`,variables:{id:'1',message:'Inspected GraphQL response errors and request ID.'}},
  validation:{query:`query InvalidField { cases(first: 2) { edges { node { id nonExistentField } } } }`,variables:{}},
  notFound:{query:`query MissingCase { case(id: "999999") { id subject status } }`,variables:{}}
};

async function gql(query, variables={}, includeAuth=false) {
 const headers={'Content-Type':'application/json','Accept':'application/graphql-response+json,application/json;q=0.9'};
 if(includeAuth && getToken()) headers.Authorization=`Bearer ${getToken()}`;
 const started=performance.now();
 const response=await fetch('/graphql',{method:'POST',headers,body:JSON.stringify({query,variables})});
 const body=await response.json();
 return {body,status:response.status,latency:Math.round(performance.now()-started),requestId:response.headers.get('x-request-id')};
}
function errorFrom(body){return (body?.errors ?? []).map(e=>`${e.extensions?.code ?? 'GRAPHQL_ERROR'}: ${e.message}`).join(' · ')}
function toast(message){const t=$('#toast');t.textContent=message;t.classList.add('show');clearTimeout(t._timer);t._timer=setTimeout(()=>t.classList.remove('show'),4200)}
function filters(){return {status:$('#statusFilter').value || null,severity:$('#severityFilter').value || null,search:$('#search').value.trim() || null}}
async function loadQueue(append=false){
 const filter=filters();const filterKey=JSON.stringify(filter);
 if(filterKey!==lastFilterKey){append=false;lastFilterKey=filterKey}
 try{
 const {body}=await gql(DATA_QUERY,{...filter,first:6,after:append?cursor:null});
 if(body.errors)throw new Error(errorFrom(body));
 const {metrics,customers:cs,agents:as,cases}=body.data;
 customers=cs;agents=as;
 renderMetrics(metrics);
 rows=append?[...rows,...cases.edges.map(e=>e.node)]:cases.edges.map(e=>e.node);
 cursor=cases.pageInfo.endCursor;hasMore=cases.pageInfo.hasNextPage;
 $('#queueCount').textContent=`${cases.totalCount} cases`;
 $('#queueDescription').textContent=`Showing ${rows.length} of ${cases.totalCount} · cursor-based pagination`;
 $('#moreBtn').hidden=!hasMore;
 renderCases();
 const select=$('#newCustomer');select.innerHTML=customers.map(c=>`<option value="${c.id}">${escape(c.name)}</option>`).join('');
 if(selectedId)renderDetail();
 }catch(e){toast(`Query failed: ${e.message}`);$('#caseList').textContent=`Unable to load cases: ${e.message}`;}
}
function renderMetrics(m){
 const cols=[['Total cases',m.total,'purple'],['New',m.new,'blue'],['In progress',m.inProgress,'yellow'],['Waiting',m.waiting,'red'],['Resolved',m.resolved,'green']];
 $('#metrics').innerHTML=cols.map(([label,value,kind])=>`<div class="metric ${kind}"><div class="label">${label}</div><div class="value">${value}</div><div class="metric-line"></div></div>`).join('');
}
function renderCases(){
 const list=$('#caseList');
 if(!rows.length){list.innerHTML='<p class="muted centered">No cases match these filters.</p>';return}
 list.innerHTML=rows.map(c=>`<button class="case-row ${selectedId===c.id?'selected':''}" data-id="${c.id}" aria-label="Inspect case ${c.id}: ${escape(c.subject)}">
  <div class="case-text"><div class="case-title">${escape(c.subject)}</div><div class="case-meta"><span>#${c.id}</span><span>${escape(c.customer.name)}</span><span>${date(c.createdAt)}</span></div></div>
  <div class="case-right"><div class="priority ${c.severity}">● ${c.severity}</div><span class="status ${c.status}">${human(c.status)}</span></div>
 </button>`).join('');
 for(const btn of list.querySelectorAll('[data-id]'))btn.addEventListener('click',()=>selectCase(btn.dataset.id));
}
function selectCase(id){selectedId=id;renderCases();renderDetail()}
function renderDetail(){
 const c=rows.find(r=>r.id===selectedId);
 if(!c){$('#detailPanel').innerHTML='<div class="detail-empty"><h3>Case not on this page</h3><p>Clear filters to find it again.</p></div>';return}
 const events=[...c.events].reverse();
 $('#detailPanel').innerHTML=`
 <div class="detail-head"><div><div class="eyebrow">CASE #${c.id} / INVESTIGATION</div><h2>${escape(c.subject)}</h2></div><div class="priority ${c.severity}">● ${c.severity}</div></div>
 <div class="detail-desc">${escape(c.description)}</div>
 <div class="detail-grid"><div><span class="field-label">CUSTOMER</span><div class="field-value">${escape(c.customer.name)}</div></div><div><span class="field-label">PLAN</span><div class="field-value">${escape(c.customer.plan)}</div></div><div><span class="field-label">STATUS</span><span class="status ${c.status}">${human(c.status)}</span></div><div><span class="field-label">ASSIGNEE</span><div class="field-value">${escape(c.assignee?.name ?? 'Unassigned')}</div></div></div>
 <div class="detail-controls"><span class="field-label">GRAPHQL MUTATIONS · AUTH REQUIRED</span><label for="detailStatus" class="field-label">Update status</label><select id="detailStatus">${['NEW','IN_PROGRESS','WAITING_ON_CUSTOMER','RESOLVED'].map(x=>`<option value="${x}" ${c.status===x?'selected':''}>${human(x)}</option>`).join('')}</select><label for="detailAssignee" class="field-label">Assign to</label><select id="detailAssignee"><option value="">Select agent…</option>${agents.map(a=>`<option value="${a.id}" ${c.assignee?.id===a.id?'selected':''}>${escape(a.name)}</option>`).join('')}</select><label for="detailNote" class="field-label">Add investigation note</label><textarea rows="2" id="detailNote" maxlength="2000" placeholder="Reproduction steps, logs, observations…"></textarea><button class="primary" id="submitChanges">Apply changes</button></div>
 <div class="timeline-title">Case activity · ${events.length} event${events.length===1?'':'s'}</div>
 <div class="timeline">${events.map(e=>`<div class="timeline-item"><strong>${human(e.type)} · ${escape(e.actor)}</strong><p>${escape(e.message)}</p><time>${date(e.createdAt)}</time></div>`).join('')}</div>`;
 $('#submitChanges').addEventListener('click',()=>saveCaseChanges(c));
}
async function mutation(query,variables){
 const {body}=await gql(query,variables,true);
 if(body.errors)throw new Error(errorFrom(body));
 return body.data;
}
async function saveCaseChanges(c){
 const status=$('#detailStatus').value;
 const agent=$('#detailAssignee').value;
 const note=$('#detailNote').value.trim();
 if(status===c.status && (!agent || agent===c.assignee?.id) && !note){toast('Nothing to change');return}
 if(!getToken()){toast('Configure a write token in the credentials panel');$('#authPanel').hidden=false;return}
 const button=$('#submitChanges');button.disabled=true;button.textContent='Applying…';
 try{
  if(status!==c.status)await mutation(`mutation SetStatus($id: ID!, $status: CaseStatus!) { updateCaseStatus(id: $id, status: $status) { id } }`,{id:String(c.id),status});
  if(agent && agent!==c.assignee?.id)await mutation(`mutation Assign($id: ID!, $agentId: ID!) { assignCase(id: $id, agentId: $agentId) { id } }`,{id:String(c.id),agentId:agent});
  if(note)await mutation(`mutation Note($id: ID!, $message: String!) { addCaseNote(id: $id, message: $message) { id } }`,{id:String(c.id),message:note});
  toast('Case updated through GraphQL');await loadQueue();
 }catch(e){toast(e.message);await loadQueue();}
}
$('#createBtn').addEventListener('click',()=>$('#createDialog').showModal());
for(const id of ['#cancelCreate','#cancelCreate2'])$(id).addEventListener('click',()=>$('#createDialog').close());
$('#createForm').addEventListener('submit',async(e)=>{
 e.preventDefault();
 if(!getToken()){toast('Set the write token in credentials first');$('#createDialog').close();$('#authPanel').hidden=false;return}
 const input={customerId:$('#newCustomer').value,subject:$('#newSubject').value,description:$('#newDescription').value,severity:$('#newSeverity').value};
 try{
  const result=await mutation(`mutation Create($input: CreateCaseInput!) { createCase(input: $input) { id subject } }`,{input});
  $('#createDialog').close();$('#createForm').reset();toast(`Case #${result.createCase.id} created`);
  // New records are after the initially visible page; clearing filters and advancing is explicit.
  selectedId=null;await loadQueue();
 }catch(err){toast(err.message)}
});
$('#moreBtn').addEventListener('click',()=>loadQueue(true));
$('#statusFilter').addEventListener('change',()=>loadQueue());
$('#severityFilter').addEventListener('change',()=>loadQueue());
$('#search').addEventListener('input',()=>{clearTimeout(searchDebounce);searchDebounce=setTimeout(()=>loadQueue(),280)});
function refreshAuth(){const saved=getToken();$('#authState').textContent=saved?'Write token saved':'Read-only session';$('#writeToken').value=saved}
$('#authToggle').addEventListener('click',()=>{$('#authPanel').hidden=!$('#authPanel').hidden});
$('#saveToken').addEventListener('click',()=>{const val=$('#writeToken').value.trim();if(!val){toast('Enter a bearer token');return}sessionStorage.setItem(authKey,val);refreshAuth();$('#authPanel').hidden=true;toast('Token saved for this tab')});
$('#clearToken').addEventListener('click',()=>{sessionStorage.removeItem(authKey);refreshAuth();toast('Token cleared')});
$('#preset').addEventListener('change',setPreset);
function setPreset(){const preset=exampleOps[$('#preset').value];$('#queryInput').value=preset.query;$('#variablesInput').value=JSON.stringify(preset.variables,null,2)}
$('#runBtn').addEventListener('click',async()=>{
 const btn=$('#runBtn');btn.disabled=true;btn.textContent='Running…';
 try{
  const variables=JSON.parse($('#variablesInput').value || '{}');
  const r=await gql($('#queryInput').value,variables,true);
  $('#responseOutput').textContent=JSON.stringify(r.body,null,2);
  $('#responseMeta').textContent=`HTTP ${r.status} · ${r.latency}ms · ${r.requestId?.slice(0,8)??'no ID'}`;
 }catch(e){$('#responseOutput').textContent=JSON.stringify({localError:String(e)},null,2);$('#responseMeta').textContent='Client error';}
 finally{btn.disabled=false;btn.textContent='▶ Run operation'}
});
setPreset();refreshAuth();loadQueue();
