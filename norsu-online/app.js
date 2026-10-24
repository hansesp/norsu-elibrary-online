const state = { user:null, tab:'dashboard', books:[], users:[], reads:[], programs:[], detail:null, report:[], charts:{}, dashboardStats:null, avatarUrls:{} };
const app = document.getElementById('app');
const sidenav = document.getElementById('sidenav');
const CATS = ['Computer Science','Business & Mgmt','Education','Engineering','Health Sciences','Fiction','Other'];
const SCROLL = 'style="overflow-x:auto"';

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/* ---- profile photos live in a PRIVATE Supabase bucket; we show them through short-lived signed links ---- */
function avatarUrlFor(path){ const e = state.avatarUrls[path]; return e && e.exp > Date.now() ? e.url : null; }
async function loadAvatarUrls(paths){
  const need = [...new Set((paths || []).filter(Boolean))].filter(p => { const e = state.avatarUrls[p]; return !e || e.exp < Date.now() + 300000; });
  if(!need.length) return;
  const { data, error } = await sb.storage.from('avatars').createSignedUrls(need, 3600);
  if(error || !data) return;
  data.forEach(item => { if(item && item.signedUrl && !item.error) state.avatarUrls[item.path] = { url: item.signedUrl, exp: Date.now() + 3600 * 1000 }; });
}
function avatarHtml(user, size){
  const cls = size === 'lg' ? 'avatar-lg' : size === 'sm' ? 'avatar-sm' : 'avatar';
  const url = user && user.avatar_path ? avatarUrlFor(user.avatar_path) : null;
  if(url) return `<span class="${cls}"><img src="${esc(url)}" alt=""></span>`;
  return `<span class="${cls}">👤</span>`;
}
function fmtDate(ts){ return new Date(ts).toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
function fmtDateTime(ts){ return ts ? new Date(ts).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'; }

/* ---- errors ---- */
function isAuthProblem(error){
  const m = String((error && error.message) || '').toLowerCase();
  return !!error && (error.status === 401 || m.indexOf('jwt') !== -1 || m.indexOf('not_authenticated') !== -1 || m.indexOf('not authenticated') !== -1);
}
function showFatal(msg){
  app.innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="lead" style="margin:0 0 12px;">${esc(msg)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
}
// returns true if the problem was handled (we are being sent back to sign in)
function handleDbError(error){
  console.error(error);
  if(isAuthProblem(error)){ window.location.href = 'index.html'; return true; }
  return false;
}
function daysFromStats(days){
  return (days || []).map(d => ({ label: new Date(d.day + 'T00:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}), n: d.n }));
}

const ICONS = { dashboard:'📊', ebooks:'📚', registrants:'🪪', users:'👥', reports:'📄' };
function navItems(){
  return state.user.user_role === 'staff'
    ? [['dashboard','Dashboard'],['ebooks','E-Books'],['registrants','Registrants'],['users','Users'],['reports','Reports']]
    : [['dashboard','Dashboard'],['ebooks','E-Books']];
}
const sidebarEl = document.getElementById('sidebar');
const backdropEl = document.getElementById('backdrop');
function closeSidebar(){ sidebarEl.classList.remove('open'); backdropEl.classList.remove('open'); }
function openSidebar(){ sidebarEl.classList.add('open'); backdropEl.classList.add('open'); }
document.getElementById('menuBtn').addEventListener('click', openSidebar);
backdropEl.addEventListener('click', closeSidebar);
function renderNav(){
  sidenav.innerHTML = navItems().map(([id,label]) => {
    const active = state.tab===id || (id==='users' && state.tab==='userdetail');
    return `<button class="${active?'active':''}" data-tab="${id}"><span class="icon">${ICONS[id]}</span>${label}</button>`;
  }).join('');
  sidenav.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.tab=b.dataset.tab; closeSidebar(); render(); }));
}
function wireTabLinks(){ app.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',(e)=>{ e.preventDefault(); state.tab=b.dataset.tab; render(); })); }
function statusPill(status){
  return status==='approved' ? '<span class="pill ok">Approved</span>'
       : status==='rejected' ? '<span class="pill out">Rejected</span>'
       : '<span class="pill low">Pending</span>';
}

async function loadAll(){
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const isStaff = state.user.user_role === 'staff';
  const jobs = [
    sb.from('books').select('id,title,author,category,file_name').order('title'),
    sb.rpc('dashboard_stats', { p_tz: tz })
  ];
  if(isStaff){ jobs.push(sb.rpc('staff_list_users'), sb.rpc('staff_access_log')); }
  const res = await Promise.all(jobs);
  const bad = res.find(r => r.error);
  if(bad){ if(!handleDbError(bad.error)) showFatal('Could not load the data. Please check your internet connection and reload.'); return false; }
  state.books = res[0].data || [];
  state.dashboardStats = res[1].data;
  if(isStaff){
    state.users = res[2].data || [];
    state.reads = res[3].data || [];
    state.programs = (state.dashboardStats && state.dashboardStats.programs) || [];
  }
  await loadAvatarUrls([state.user.avatar_path].concat(state.users.map(u => u.avatar_path)));
  return true;
}

function openErrorMessage(error){
  const m = String((error && error.message) || '');
  if(m.indexOf('not_approved') !== -1) return 'Your registration has not been approved yet. Please wait for library staff to verify you.';
  if(m.indexOf('no_file') !== -1) return 'This e-book has no readable file yet.';
  if(m.indexOf('book_not_found') !== -1) return 'That e-book no longer exists.';
  return 'Could not open this e-book. Please try again.';
}
// Opens an e-book: the database checks you are approved and LOGS the open; only then
// does the storage service hand out a short-lived link to the PDF.
async function openBook(id){
  // open the new tab right now (inside the click) so pop-up blockers allow it
  const w = window.open('', '_blank');
  try { if(w) w.document.write('<p style="font-family:sans-serif;padding:20px">Opening e-book…</p>'); } catch(e){}
  const fail = (msg) => { if(w) w.close(); alert(msg); };
  const { data: path, error } = await sb.rpc('open_book', { p_book_id: Number(id) });
  if(error){ if(isAuthProblem(error)) { if(w) w.close(); window.location.href = 'index.html'; return; } return fail(openErrorMessage(error)); }
  const signed = await sb.storage.from('books').createSignedUrl(path, 120);
  if(signed.error || !signed.data){ return fail('Could not open this e-book. Please try again.'); }
  if(w) w.location.href = signed.data.signedUrl; else window.location.href = signed.data.signedUrl;
}

const DONUT_COLORS = ['#2f6bff','#7fb0ff','#1fa971','#f2a93b','#8b6bf0','#e0554a','#9aa5c9'];
function initials(title){ return title.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase(); }
function chartThemeColors(){
  const dark = getEffectiveTheme() === 'dark';
  return { grid: dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)', tick: dark ? '#8b91a6' : '#7c8499', line: dark ? '#538bff' : '#2f6bff', fill: dark ? 'rgba(83,139,255,.16)' : 'rgba(47,107,255,.12)' };
}
function drawLineChart(days){
  const el = document.getElementById('lineChart'); if(!el || !window.Chart) return;
  if(state.charts.line) state.charts.line.destroy();
  const c = chartThemeColors();
  state.charts.line = new Chart(el.getContext('2d'), {
    type:'line',
    data:{ labels:days.map(x=>x.label), datasets:[{ data:days.map(x=>x.n), borderColor:c.line, backgroundColor:c.fill, fill:true, tension:.35, pointRadius:3 }] },
    options:{ plugins:{legend:{display:false}}, scales:{
      y:{ beginAtZero:true, ticks:{precision:0, color:c.tick}, grid:{color:c.grid} },
      x:{ ticks:{color:c.tick}, grid:{color:c.grid} }
    } }
  });
}
function drawDonutChart(programs){
  const el = document.getElementById('donutChart'); if(!el || !window.Chart) return;
  if(state.charts.donut) state.charts.donut.destroy();
  state.charts.donut = new Chart(el.getContext('2d'), {
    type:'doughnut',
    data:{ labels:programs.map(p=>p.program), datasets:[{ data:programs.map(p=>p.accesses), backgroundColor: programs.map((_,i)=>DONUT_COLORS[i%DONUT_COLORS.length]), borderWidth:0 }] },
    options:{ cutout:'65%', plugins:{ legend:{display:false} } }
  });
}

/* ---------- Dashboard ---------- */
function renderDashboard(){
  if(state.user.user_role !== 'staff') return renderStudentDashboard();
  const pending = state.users.filter(u=>u.status==='pending' && u.user_role==='patron');
  const s = state.dashboardStats || { totalAccesses:0, activeToday:0, top:[], days:[] };
  const top = (s.top || []).map(t => [t.book_title, t.n]);
  const recent = state.reads.slice(0,8);
  const totalPatrons = state.users.filter(u=>u.user_role==='patron').length;
  const activeToday = s.activeToday || 0;
  const programTotal = state.programs.reduce((s,p)=>s+p.accesses,0) || 1;
  const catCounts = {}; state.books.forEach(b=>{ catCounts[b.category||'Other']=(catCounts[b.category||'Other']||0)+1; });
  const cats = Object.entries(catCounts).sort((a,b)=>b[1]-a[1]);

  app.innerHTML = `
    <h2>Welcome back, ${esc(state.user.name)}!</h2>
    <p class="lead">Here's a quick overview of the e-library system.</p>
    ${pending.length>0?`<div class="card" style="border-color:var(--orange);display:flex;justify-content:space-between;align-items:center;"><span>🪪 <b>${pending.length}</b> registrant${pending.length===1?'':'s'} awaiting verification</span><button class="btn" data-tab="registrants">Review Now</button></div>`:''}

    <div class="grid4">
      <div class="stat"><div class="top"><div class="ic" style="background:color-mix(in srgb,var(--blue) 18%,transparent)">📘</div><div class="lbl">Total E-Books</div></div><div class="num">${state.books.length}</div><div class="delta">in catalog</div></div>
      <div class="stat"><div class="top"><div class="ic" style="background:color-mix(in srgb,var(--green) 18%,transparent)">👥</div><div class="lbl">Total Users</div></div><div class="num">${totalPatrons}</div><div class="delta">registered</div></div>
      <div class="stat"><div class="top"><div class="ic" style="background:color-mix(in srgb,#8b6bf0 18%,transparent)">📈</div><div class="lbl">Total Accesses</div></div><div class="num">${s.totalAccesses}</div><div class="delta">all time</div></div>
      <div class="stat"><div class="top"><div class="ic" style="background:color-mix(in srgb,var(--orange) 18%,transparent)">🙋</div><div class="lbl">Active Users</div></div><div class="num">${activeToday}</div><div class="delta">today</div></div>
    </div>

    <div class="dashrow">
      <div class="card"><h3>E-Book Accesses (Last 7 Days)</h3><canvas id="lineChart" height="140"></canvas></div>
      <div class="card"><h3>Most Accessed E-Books<a href="#" data-tab="reports">View All</a></h3>
        <div class="mlist">${top.length===0?'<div class="empty">No activity yet.</div>':top.map(([t,n],i)=>`<div class="mrow"><span class="rank">${i+1}</span><span class="bookicon">${esc(initials(t))}</span><span><div class="t">${esc(t)}</div></span><span class="n">${n} access${n===1?'':'es'}</span></div>`).join('')}</div>
      </div>
      <div class="card"><h3>Accesses by Program/College</h3><canvas id="donutChart" height="160"></canvas>
        <div class="legend">${state.programs.length===0?'<div class="empty">No activity yet.</div>':state.programs.map((p,i)=>`<div class="li"><span class="k"><span class="dot" style="background:${DONUT_COLORS[i%DONUT_COLORS.length]}"></span>${esc(p.program)}</span><span>${Math.round(p.accesses/programTotal*100)}%</span></div>`).join('')}</div>
      </div>
    </div>

    <div class="dashrow2">
      <div class="card" ${SCROLL}><h3>Recent Access Activity<a href="#" data-tab="reports">View All</a></h3>
        ${recent.length===0?'<div class="empty">No activity yet.</div>':`<table><thead><tr><th>User</th><th>E-Book</th><th>Program/College</th><th>Date &amp; Time</th></tr></thead><tbody>
          ${recent.map(r=>`<tr><td>${esc(r.user_name)}</td><td>${esc(r.book_title)}</td><td>${esc(r.user_program||'—')}</td><td>${fmtDateTime(r.accessed_at)}</td></tr>`).join('')}
        </tbody></table>`}
      </div>
      <div class="card"><h3>Quick Actions</h3>
        <div class="qa">
          <button data-tab="ebooks">📘 Add E-Book</button>
          <button data-tab="registrants">🪪 Registrants</button>
          <button data-tab="users">👥 Users</button>
          <button data-tab="reports">📄 Reports</button>
        </div>
      </div>
      <div class="card"><h3>E-Book Categories<a href="#" data-tab="ebooks">View All</a></h3>
        ${cats.length===0?'<div class="empty">No books yet.</div>':cats.map(([c,n])=>`<div class="catrow">📁 ${esc(c)}<span class="n">${n}</span></div>`).join('')}
      </div>
    </div>`;
  wireTabLinks();
  drawLineChart(daysFromStats(s.days));
  drawDonutChart(state.programs);
}

/* ---------- Student dashboard (read-only, aggregate data only) ---------- */
function renderStudentDashboard(){
  const s = state.dashboardStats || { totalBooks:0, totalUsers:0, totalAccesses:0, todayAccesses:0, top:[], programs:[], days:[] };
  const programTotal = s.programs.reduce((sum,p)=>sum+p.accesses,0) || 1;
  const catCounts = {}; state.books.forEach(b=>{ catCounts[b.category||'Other']=(catCounts[b.category||'Other']||0)+1; });
  const cats = Object.entries(catCounts).sort((a,b)=>b[1]-a[1]);

  app.innerHTML = `
    <h2>Welcome, ${esc(state.user.name)}!</h2>
    <p class="lead">Here's what's happening across the e-library.</p>

    <div class="grid4">
      <div class="stat"><div class="top"><div class="ic" style="background:color-mix(in srgb,var(--blue) 18%,transparent)">📘</div><div class="lbl">Total E-Books</div></div><div class="num">${s.totalBooks}</div><div class="delta">in catalog</div></div>
      <div class="stat"><div class="top"><div class="ic" style="background:color-mix(in srgb,var(--green) 18%,transparent)">👥</div><div class="lbl">Registered Students</div></div><div class="num">${s.totalUsers}</div><div class="delta">system-wide</div></div>
      <div class="stat"><div class="top"><div class="ic" style="background:color-mix(in srgb,#8b6bf0 18%,transparent)">📈</div><div class="lbl">Total Accesses</div></div><div class="num">${s.totalAccesses}</div><div class="delta">all time</div></div>
      <div class="stat"><div class="top"><div class="ic" style="background:color-mix(in srgb,var(--orange) 18%,transparent)">📅</div><div class="lbl">Accesses Today</div></div><div class="num">${s.todayAccesses}</div><div class="delta">today</div></div>
    </div>

    <div class="dashrow">
      <div class="card"><h3>E-Book Accesses (Last 7 Days)</h3><canvas id="lineChart" height="140"></canvas></div>
      <div class="card"><h3>Most Accessed E-Books</h3>
        <div class="mlist">${s.top.length===0?'<div class="empty">No activity yet.</div>':s.top.map((t,i)=>`<div class="mrow"><span class="rank">${i+1}</span><span class="bookicon">${esc(initials(t.book_title))}</span><span><div class="t">${esc(t.book_title)}</div></span><span class="n">${t.n} access${t.n===1?'':'es'}</span></div>`).join('')}</div>
      </div>
      <div class="card"><h3>Accesses by Program/College</h3><canvas id="donutChart" height="160"></canvas>
        <div class="legend">${s.programs.length===0?'<div class="empty">No activity yet.</div>':s.programs.map((p,i)=>`<div class="li"><span class="k"><span class="dot" style="background:${DONUT_COLORS[i%DONUT_COLORS.length]}"></span>${esc(p.program)}</span><span>${Math.round(p.accesses/programTotal*100)}%</span></div>`).join('')}</div>
      </div>
    </div>

    <div class="card"><h3>E-Book Categories</h3>
      ${cats.length===0?'<div class="empty">No books yet.</div>':cats.map(([c,n])=>`<div class="catrow">📁 ${esc(c)}<span class="n">${n}</span></div>`).join('')}
    </div>
    <p class="lead" style="margin-top:10px;">Head to <b>E-Books</b> in the sidebar to open a title.</p>`;

  drawLineChart(daysFromStats(s.days));
  drawDonutChart(s.programs);
}

/* ---------- CSV import ---------- */
function parseCsv(text){
  const rows = []; let row = [], cur = '', q = false;
  for(let i=0;i<text.length;i++){
    const ch = text[i];
    if(q){ if(ch === '"'){ if(text[i+1] === '"'){ cur += '"'; i++; } else q = false; } else cur += ch; }
    else if(ch === '"') q = true;
    else if(ch === ','){ row.push(cur); cur = ''; }
    else if(ch === '\n' || ch === '\r'){
      if(ch === '\r' && text[i+1] === '\n') i++;
      row.push(cur); cur = '';
      if(row.some(c=>c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if(row.some(c=>c.trim() !== '')) rows.push(row);
  return rows;
}
function pickCsv(){
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.csv,text/csv';
  input.onchange = async () => {
    const f = input.files[0]; if(!f) return;
    const rows = parseCsv((await f.text()).replace(/^\uFEFF/, ''));
    if(!rows.length){ alert('That file is empty.'); return; }
    let idx = { title:0, author:1, category:2 };
    const head = rows[0].map(c=>c.trim().toLowerCase());
    if(head.includes('title')){ idx = { title:head.indexOf('title'), author:head.indexOf('author'), category:head.indexOf('category') }; rows.shift(); }
    const clean = []; let skipped = 0;
    rows.forEach(r => {
      const title = String(r[idx.title] || '').trim(), author = String(r[idx.author] || '').trim();
      const category = String((idx.category >= 0 ? r[idx.category] : '') || '').trim() || 'Other';
      if(title && author) clean.push({ title: title.slice(0,300), author: author.slice(0,200), category: category.slice(0,100) });
      else skipped++;
    });
    let added = 0, failedMsg = '';
    for(let i = 0; i < clean.length; i += 200){
      const chunk = clean.slice(i, i + 200);
      const { error } = await sb.from('books').insert(chunk);
      if(error){ failedMsg = error.message; break; }
      added += chunk.length;
    }
    alert(`Imported ${added} book${added===1?'':'s'}` + (skipped ? ` (${skipped} skipped: missing title or author).` : '.') + (failedMsg ? `\n\nImport stopped early: ${failedMsg}` : ''));
    await loadAll(); render();
  };
  input.click();
}

/* ---------- PDF upload ---------- */
function pickAndUpload(bookId, btn){
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/pdf,.pdf';
  input.onchange = async () => {
    const file = input.files[0]; if(!file) return;
    if(file.size > 50*1024*1024){ alert('That file is over 50 MB, which is the limit on the free Supabase plan. Please compress the PDF first.'); return; }
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if(String.fromCharCode(...head) !== '%PDF-'){ alert('That file is not a valid PDF.'); return; }
    btn.disabled = true; btn.textContent = 'Uploading…';
    const up = await sb.storage.from('books').upload(`${bookId}.pdf`, file, { upsert: true, contentType: 'application/pdf', cacheControl: '60' });
    if(up.error){ alert('Upload failed: ' + up.error.message); await loadAll(); render(); return; }
    const upd = await sb.from('books').update({ file_name: file.name.slice(0, 200) }).eq('id', Number(bookId));
    if(upd.error) alert('The file uploaded, but saving its details failed: ' + upd.error.message);
    await loadAll(); render();
  };
  input.click();
}

/* ---------- E-Books ---------- */
function renderEbooks(){
  const isStaff = state.user.user_role === 'staff';
  const approved = isStaff || state.user.status === 'approved';
  const addForm = isStaff ? `<form class="addbook" id="addBookForm" style="grid-template-columns:1.6fr 1.2fr 1fr auto;">
      <input type="text" id="newTitle" placeholder="Title" required>
      <input type="text" id="newAuthor" placeholder="Author" required>
      <select id="newCat">${CATS.map(c=>`<option>${c}</option>`).join('')}</select>
      <button class="btn" type="submit">Add Book</button>
    </form>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
      <button class="btn secondary" type="button" id="csvBtn">Import books from CSV</button>
      <span style="color:var(--muted);font-size:.78rem;">Columns: title, author, category</span>
    </div>` : '';
  const statusNote = !isStaff ? `<p class="lead">${statusPill(state.user.status)} ${state.user.status!=='approved'?'— access is locked until staff approves your registration.':'— you can open any e-book below.'}</p>` : '';
  const rows = state.books.length===0 ? `<div class="empty">No books yet.</div>` :
    `<table><thead><tr><th>Title</th><th>Author</th><th>Category</th><th>Ebook file</th><th></th></tr></thead><tbody>
      ${state.books.map(b=>{
        const hasFile = !!b.file_name;
        let action;
        if(isStaff){
          action = `${hasFile?`<button class="btn secondary" data-read="${b.id}">Open PDF</button> `:''}<button class="btn secondary" data-upload="${b.id}">${hasFile?'Replace PDF':'Upload PDF'}</button> <button class="btn danger" data-del="${b.id}">Remove</button>`;
        } else if(!approved) action = `<button class="btn" disabled>Open</button>`;
        else if(!hasFile) action = `<button class="btn" disabled>No file yet</button>`;
        else action = `<button class="btn" data-read="${b.id}">Open</button>`;
        const filePill = hasFile ? '<span class="pill ok">PDF</span>' : '<span class="pill low">No file</span>';
        return `<tr><td>${esc(b.title)}</td><td>${esc(b.author)}</td><td>${esc(b.category)}</td><td>${filePill}</td><td style="white-space:nowrap">${action}</td></tr>`;
      }).join('')}
    </tbody></table>`;
  app.innerHTML = `<h2>E-Books Catalog</h2>${statusNote}<div class="card" ${SCROLL}>${addForm}<input type="text" id="bookSearch" placeholder="Search by title, author, or category…" style="margin-bottom:12px">${rows}</div>`;

  const searchBox = document.getElementById('bookSearch');
  if(searchBox) searchBox.addEventListener('input', () => {
    const q = searchBox.value.trim().toLowerCase();
    app.querySelectorAll('table tbody tr').forEach(tr => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
  const af = document.getElementById('addBookForm');
  if(af) af.addEventListener('submit', async e=>{
    e.preventDefault();
    const title=document.getElementById('newTitle').value.trim(), author=document.getElementById('newAuthor').value.trim();
    const category=document.getElementById('newCat').value;
    if(!title||!author) return;
    const { error } = await sb.from('books').insert({ title: title.slice(0,300), author: author.slice(0,200), category });
    if(error) alert('Could not add the book: ' + error.message);
    await loadAll(); render();
  });
  const csvBtn = document.getElementById('csvBtn');
  if(csvBtn) csvBtn.addEventListener('click', pickCsv);
  app.querySelectorAll('[data-read]').forEach(b=>b.addEventListener('click', ()=>openBook(b.dataset.read)));
  app.querySelectorAll('[data-upload]').forEach(b=>b.addEventListener('click', ()=>pickAndUpload(b.dataset.upload, b)));
  app.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Remove this title?')) return;
    const id = Number(b.dataset.del);
    const { error } = await sb.from('books').delete().eq('id', id);
    if(error){
      if(error.code === '23503') alert("This book has access history, so it can't be removed (that would erase your usage records).");
      else alert('Could not remove the book: ' + error.message);
    } else {
      await sb.storage.from('books').remove([`${id}.pdf`]); // tidy up its PDF (ignore if there was none)
    }
    await loadAll(); render();
  }));
}

/* ---------- Registrants ---------- */
function renderRegistrants(){
  const patrons = state.users.filter(u=>u.user_role==='patron');
  const pending = patrons.filter(u=>u.status==='pending');
  app.innerHTML = `<h2>Registrants</h2><p class="lead">Confirm whether each registrant is a bona fide NORSUnian.</p>
  <div class="grid4">
    <div class="stat"><div class="lbl">Pending</div><div class="num">${pending.length}</div></div>
    <div class="stat"><div class="lbl">Approved</div><div class="num">${patrons.filter(u=>u.status==='approved').length}</div></div>
    <div class="stat"><div class="lbl">Rejected</div><div class="num">${patrons.filter(u=>u.status==='rejected').length}</div></div>
    <div class="stat"><div class="lbl">Total</div><div class="num">${patrons.length}</div></div>
  </div>
  <div class="card" ${SCROLL}>${patrons.length===0?'<div class="empty">No registrants yet.</div>':
    `<table><thead><tr><th>Name</th><th>ID Number</th><th>Role</th><th>Program/College</th><th>Status</th><th></th></tr></thead><tbody>
      ${patrons.map(u=>`<tr><td>${esc(u.name)}</td><td>${esc(u.id_number)}</td><td>${esc(u.role_requested)}</td><td>${esc(u.program||'—')}</td><td>${statusPill(u.status)}</td>
        <td style="white-space:nowrap">${u.status==='pending'?`<button class="btn" data-appr="${u.id}">Approve</button> <button class="btn danger" data-rej="${u.id}">Reject</button>`:`<button class="btn secondary" data-pend="${u.id}">Set Pending</button>`}</td></tr>`).join('')}
    </tbody></table>`}</div>`;
  app.querySelectorAll('[data-appr]').forEach(b=>b.addEventListener('click', ()=>setStatus(b.dataset.appr,'approved')));
  app.querySelectorAll('[data-rej]').forEach(b=>b.addEventListener('click', ()=>setStatus(b.dataset.rej,'rejected')));
  app.querySelectorAll('[data-pend]').forEach(b=>b.addEventListener('click', ()=>setStatus(b.dataset.pend,'pending')));
}
async function setStatus(id, status){
  const { error } = await sb.rpc('set_user_status', { p_user: id, p_status: status });
  if(error) alert('Could not update that registration: ' + error.message);
  await loadAll(); renderNotifications(); render();
}

/* ---------- Users (per-user monitoring) ---------- */
function renderUsers(){
  const patrons = state.users.filter(u=>u.user_role==='patron');
  app.innerHTML = `<h2>Users</h2><p class="lead">Monitor each user's e-book access activity.</p>
  <div class="card" ${SCROLL}>${patrons.length===0?'<div class="empty">No users yet.</div>':
    `<table><thead><tr><th>Name</th><th>ID Number</th><th>Program/College</th><th>Status</th><th>Total Accesses</th><th>Distinct Books</th><th>Last Access</th><th></th></tr></thead><tbody>
      ${patrons.map(u=>`<tr><td>${avatarHtml(u,'sm')}${esc(u.name)}</td><td>${esc(u.id_number)}</td><td>${esc(u.program||'—')}</td><td>${statusPill(u.status)}</td>
        <td>${u.read_count}</td><td>${u.distinct_books}</td><td>${fmtDateTime(u.last_read)}</td>
        <td><button class="btn secondary" data-user="${u.id}">View</button></td></tr>`).join('')}
    </tbody></table>`}</div>`;
  app.querySelectorAll('[data-user]').forEach(b=>b.addEventListener('click', ()=>openUser(b.dataset.user)));
}
async function openUser(id){
  const { data, error } = await sb.rpc('staff_user_activity', { p_user: id });
  if(error || !data){ if(!handleDbError(error)) alert('Could not load that user.'); return; }
  state.detail = data;
  await loadAvatarUrls([data.user.avatar_path]);
  state.tab = 'userdetail';
  render();
}
function renderUserDetail(){
  const d = state.detail, u = d.user;
  app.innerHTML = `
    <p style="margin:0 0 10px"><button class="btn secondary" data-tab="users">← Back to Users</button></p>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:4px;">
      ${avatarHtml(u,'lg')}
      <div><h2 style="margin:0">${esc(u.name)}</h2>
      <p class="lead" style="margin:4px 0 0">${esc(u.id_number)} · ${esc(u.role_requested)} · ${esc(u.program||'—')} · ${esc(u.email)} · ${statusPill(u.status)}</p></div>
    </div>
    <div class="grid4">
      <div class="stat"><div class="lbl">Total accesses</div><div class="num">${d.reads.length}</div></div>
      <div class="stat"><div class="lbl">Distinct books</div><div class="num">${new Set(d.reads.map(r=>r.book_title)).size}</div></div>
      <div class="stat"><div class="lbl">Last access</div><div class="num" style="font-size:1rem">${fmtDateTime(d.reads[0] && d.reads[0].accessed_at)}</div></div>
    </div>
    <div class="card" ${SCROLL}><h3>Access history</h3>${d.reads.length===0?'<div class="empty">This user has not opened any ebook yet.</div>':
      `<table><thead><tr><th>E-Book</th><th>Accessed</th></tr></thead><tbody>
        ${d.reads.map(r=>`<tr><td>${esc(r.book_title)}</td><td>${fmtDateTime(r.accessed_at)}</td></tr>`).join('')}
      </tbody></table>`}</div>`;
  wireTabLinks();
}

/* ---------- Reports ---------- */
function renderReports(){
  app.innerHTML = `<h2>Usage Reports</h2><p class="lead">Filter and export e-book access records for monitoring and documentation.</p>
  <div class="card">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;">
      <div><label style="display:block;font-size:.75rem;color:var(--muted);margin-bottom:4px;">From</label><input type="date" id="repFrom"></div>
      <div><label style="display:block;font-size:.75rem;color:var(--muted);margin-bottom:4px;">To</label><input type="date" id="repTo"></div>
      <div><label style="display:block;font-size:.75rem;color:var(--muted);margin-bottom:4px;">Program/College</label>
        <select id="repProgram"><option value="">All</option>${[...new Set(state.users.map(u=>u.program).filter(Boolean))].map(p=>`<option>${esc(p)}</option>`).join('')}</select></div>
      <button class="btn" id="repRun">Run Report</button>
      <button class="btn secondary" id="repExport">Export CSV</button>
    </div>
  </div>
  <div class="card" ${SCROLL} id="repResults"><div class="empty">Choose filters and click "Run Report".</div></div>`;

  function currentQuery(){
    const q = { p_from: null, p_to: null, p_program: null };
    const from = document.getElementById('repFrom').value, to = document.getElementById('repTo').value;
    if(from) q.p_from = new Date(from + 'T00:00:00').toISOString();
    if(to) q.p_to = new Date(to + 'T23:59:59').toISOString();
    const program = document.getElementById('repProgram').value;
    if(program) q.p_program = program;
    return q;
  }
  async function fetchRows(){
    const { data, error } = await sb.rpc('staff_report', currentQuery());
    if(error){ if(!handleDbError(error)) alert('Could not run the report: ' + error.message); return null; }
    return data || [];
  }
  document.getElementById('repRun').addEventListener('click', async () => {
    const rows = await fetchRows(); if(!rows) return;
    const box = document.getElementById('repResults');
    box.innerHTML = rows.length===0 ? '<div class="empty">No records match those filters.</div>' :
      `<table><thead><tr><th>Date/Time</th><th>User</th><th>Program/College</th><th>Role</th><th>E-Book</th><th>Category</th></tr></thead><tbody>
        ${rows.map(r=>`<tr><td>${fmtDateTime(r.accessed_at)}</td><td>${esc(r.user_name)}</td><td>${esc(r.program||'—')}</td><td>${esc(r.role_requested)}</td><td>${esc(r.book_title)}</td><td>${esc(r.category)}</td></tr>`).join('')}
      </tbody></table><p class="lead" style="margin-top:10px;">${rows.length} record${rows.length===1?'':'s'}</p>`;
  });
  document.getElementById('repExport').addEventListener('click', async () => {
    const rows = await fetchRows(); if(!rows) return;
    downloadText('usage-report.csv', toCsv(rows));
  });
}

// CSV helpers. Cells that start with = + - @ are prefixed with ' so Excel can never run a name as a formula.
function csvCell(v){
  let t = String(v == null ? '' : v);
  if(/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}
function toCsv(rows){
  const header = ['Date/Time','User','Program/College','Role','E-Book','Category'];
  return [header.join(',')].concat(rows.map(r => [new Date(r.accessed_at).toLocaleString(), r.user_name, r.program || '', r.role_requested, r.book_title, r.category].map(csvCell).join(','))).join('\r\n');
}
function downloadText(filename, text){
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function render(){
  renderNav();
  if(state.tab==='dashboard') renderDashboard();
  else if(state.tab==='ebooks') renderEbooks();
  else if(state.tab==='registrants') renderRegistrants();
  else if(state.tab==='users') renderUsers();
  else if(state.tab==='userdetail') renderUserDetail();
  else if(state.tab==='reports') renderReports();
}

/* ---------- Dark mode ---------- */
function getEffectiveTheme(){
  const explicit = document.documentElement.getAttribute('data-theme');
  if(explicit) return explicit;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function updateThemeBtn(){
  const btn = document.getElementById('themeToggleBtn');
  if(!btn) return;
  btn.textContent = getEffectiveTheme() === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  try{ localStorage.setItem('theme', theme); }catch(e){}
  updateThemeBtn();
}
document.getElementById('themeToggleBtn').addEventListener('click', ()=>{
  applyTheme(getEffectiveTheme() === 'dark' ? 'light' : 'dark');
});
updateThemeBtn();

async function doLogout(){
  await sb.auth.signOut();
  window.location.href = 'index.html';
}
document.getElementById('logoutBtn').addEventListener('click', doLogout);
document.getElementById('logoutBtn2').addEventListener('click', doLogout);

/* ---------- Notification + profile dropdowns ---------- */
function closeDropdowns(){
  document.getElementById('notifDropdown').hidden = true;
  document.getElementById('profileDropdown').hidden = true;
}
document.getElementById('notifBtn').addEventListener('click', (e)=>{
  e.stopPropagation();
  const dd = document.getElementById('notifDropdown');
  const wasOpen = !dd.hidden;
  closeDropdowns();
  dd.hidden = wasOpen;
});
document.getElementById('profileBtn').addEventListener('click', (e)=>{
  e.stopPropagation();
  const dd = document.getElementById('profileDropdown');
  const wasOpen = !dd.hidden;
  closeDropdowns();
  dd.hidden = wasOpen;
});
document.addEventListener('click', closeDropdowns);

/* ---------- Profile photo ---------- */
function refreshAvatarUI(){
  const url = state.user.avatar_path ? avatarUrlFor(state.user.avatar_path) : null;
  document.getElementById('avatarSpan').innerHTML = url ? `<img src="${esc(url)}" alt="">` : '👤';
  document.getElementById('removePhotoBtn').hidden = !state.user.avatar_path;
}
document.getElementById('changePhotoBtn').addEventListener('click', ()=>{
  document.getElementById('avatarFileInput').click();
});

/* ---- crop/zoom modal: self-contained, no external library ---- */
const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas.getContext('2d');
const CROP_SIZE = cropCanvas.width; // 320, square
let cropImg = null, cropObjectUrl = null;
let cropBaseScale = 1, cropZoom = 1, cropDX = 0, cropDY = 0;
let dragging = false, dragStartX = 0, dragStartY = 0, dragOrigDX = 0, dragOrigDY = 0;

function clampCropOffsets(){
  const dw = cropImg.naturalWidth * cropBaseScale * cropZoom;
  const dh = cropImg.naturalHeight * cropBaseScale * cropZoom;
  const minX = Math.min(0, CROP_SIZE - dw), maxX = Math.max(0, CROP_SIZE - dw);
  const minY = Math.min(0, CROP_SIZE - dh), maxY = Math.max(0, CROP_SIZE - dh);
  cropDX = Math.max(minX, Math.min(maxX, cropDX));
  cropDY = Math.max(minY, Math.min(maxY, cropDY));
}

function drawCrop(){
  if(!cropImg) return;
  const dw = cropImg.naturalWidth * cropBaseScale * cropZoom;
  const dh = cropImg.naturalHeight * cropBaseScale * cropZoom;
  cropCtx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
  cropCtx.fillStyle = '#15171c';
  cropCtx.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
  cropCtx.drawImage(cropImg, cropDX, cropDY, dw, dh);
  // dim everything outside the circular guide
  cropCtx.save();
  cropCtx.fillStyle = 'rgba(0,0,0,0.55)';
  cropCtx.beginPath();
  cropCtx.rect(0, 0, CROP_SIZE, CROP_SIZE);
  cropCtx.moveTo(CROP_SIZE/2 + CROP_SIZE/2 - 2, CROP_SIZE/2);
  cropCtx.arc(CROP_SIZE/2, CROP_SIZE/2, CROP_SIZE/2 - 2, 0, Math.PI*2, true);
  cropCtx.fill('evenodd');
  cropCtx.restore();
  cropCtx.beginPath();
  cropCtx.arc(CROP_SIZE/2, CROP_SIZE/2, CROP_SIZE/2 - 2, 0, Math.PI*2);
  cropCtx.strokeStyle = 'rgba(255,255,255,.85)';
  cropCtx.lineWidth = 2;
  cropCtx.stroke();
}

function closeCropModal(){
  document.getElementById('cropOverlay').hidden = true;
  if(cropObjectUrl){ URL.revokeObjectURL(cropObjectUrl); cropObjectUrl = null; }
  cropImg = null;
}

document.getElementById('avatarFileInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  e.target.value = ''; // allow picking the same file again later
  if(!file) return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)){
    alert('Please choose a JPEG, PNG, or WEBP image.'); return;
  }
  if(file.size > 15*1024*1024){ alert('That image is over 15 MB. Please choose a smaller file.'); return; }

  const img = new Image();
  cropObjectUrl = URL.createObjectURL(file);
  img.onload = () => {
    cropImg = img;
    cropBaseScale = Math.max(CROP_SIZE / img.naturalWidth, CROP_SIZE / img.naturalHeight);
    cropZoom = 1;
    cropDX = (CROP_SIZE - img.naturalWidth * cropBaseScale) / 2;
    cropDY = (CROP_SIZE - img.naturalHeight * cropBaseScale) / 2;
    document.getElementById('zoomRange').value = 1;
    document.getElementById('cropOverlay').hidden = false;
    drawCrop();
  };
  img.onerror = () => { alert('Could not read that image file.'); closeCropModal(); };
  img.src = cropObjectUrl;
});

document.getElementById('zoomRange').addEventListener('input', (e)=>{
  if(!cropImg) return;
  const newZoom = parseFloat(e.target.value);
  // zoom from the center of the current view, not the image's top-left corner
  const cx = CROP_SIZE/2, cy = CROP_SIZE/2;
  const relX = (cx - cropDX) / (cropBaseScale * cropZoom);
  const relY = (cy - cropDY) / (cropBaseScale * cropZoom);
  cropZoom = newZoom;
  cropDX = cx - relX * cropBaseScale * cropZoom;
  cropDY = cy - relY * cropBaseScale * cropZoom;
  clampCropOffsets();
  drawCrop();
});

function cropPointerPos(e){
  const rect = cropCanvas.getBoundingClientRect();
  const scaleX = CROP_SIZE / rect.width, scaleY = CROP_SIZE / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}
cropCanvas.addEventListener('pointerdown', (e)=>{
  if(!cropImg) return;
  dragging = true;
  cropCanvas.setPointerCapture(e.pointerId);
  const p = cropPointerPos(e);
  dragStartX = p.x; dragStartY = p.y; dragOrigDX = cropDX; dragOrigDY = cropDY;
});
cropCanvas.addEventListener('pointermove', (e)=>{
  if(!dragging || !cropImg) return;
  const p = cropPointerPos(e);
  cropDX = dragOrigDX + (p.x - dragStartX);
  cropDY = dragOrigDY + (p.y - dragStartY);
  clampCropOffsets();
  drawCrop();
});
['pointerup','pointercancel','pointerleave'].forEach(evt =>
  cropCanvas.addEventListener(evt, ()=>{ dragging = false; }));
cropCanvas.addEventListener('wheel', (e)=>{
  if(!cropImg) return;
  e.preventDefault();
  const range = document.getElementById('zoomRange');
  const step = e.deltaY < 0 ? 0.1 : -0.1;
  range.value = Math.max(1, Math.min(4, parseFloat(range.value) + step));
  range.dispatchEvent(new Event('input'));
}, { passive: false });

document.getElementById('cropCancelBtn').addEventListener('click', closeCropModal);
document.getElementById('cropOverlay').addEventListener('click', (e)=>{
  if(e.target.id === 'cropOverlay') closeCropModal();
});

document.getElementById('cropSaveBtn').addEventListener('click', ()=>{
  if(!cropImg) return;
  const saveBtn = document.getElementById('cropSaveBtn');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  const out = document.createElement('canvas');
  out.width = 400; out.height = 400;
  const octx = out.getContext('2d');
  const scale = 400 / CROP_SIZE;
  const dw = cropImg.naturalWidth * cropBaseScale * cropZoom * scale;
  const dh = cropImg.naturalHeight * cropBaseScale * cropZoom * scale;
  octx.drawImage(cropImg, cropDX * scale, cropDY * scale, dw, dh);
  out.toBlob(async (blob) => {
    const reset = () => { saveBtn.disabled = false; saveBtn.textContent = 'Save Photo'; };
    if(!blob){ alert('Could not process that image.'); reset(); return; }
    const path = `${state.user.id}/${Date.now()}.jpg`; // each user can only write inside their own folder
    const up = await sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600' });
    if(up.error){ alert('Upload failed: ' + up.error.message); reset(); return; }
    const { error } = await sb.rpc('set_my_avatar', { p_path: path });
    if(error){ await sb.storage.from('avatars').remove([path]); alert('Could not save your photo: ' + error.message); reset(); return; }
    const old = state.user.avatar_path;
    state.user.avatar_path = path;
    if(old) await sb.storage.from('avatars').remove([old]);
    await loadAvatarUrls([path]);
    reset();
    refreshAvatarUI();
    closeCropModal();
    render(); // so any avatar shown in the current tab (e.g. Users list) updates too
  }, 'image/jpeg', 0.92);
});
document.getElementById('removePhotoBtn').addEventListener('click', async ()=>{
  if(!confirm('Remove your profile picture?')) return;
  const old = state.user.avatar_path;
  const { error } = await sb.rpc('set_my_avatar', { p_path: null });
  if(error){ alert('Could not remove your photo: ' + error.message); return; }
  if(old) await sb.storage.from('avatars').remove([old]);
  state.user.avatar_path = null;
  refreshAvatarUI();
  render();
});

function renderNotifications(){
  const list = document.getElementById('notifList');
  const dot = document.getElementById('notifDot');
  if(state.user.user_role === 'staff'){
    const pending = state.users.filter(u=>u.status==='pending' && u.user_role==='patron');
    dot.hidden = pending.length === 0;
    list.innerHTML = pending.length === 0
      ? '<div class="notif-empty">No new notifications.</div>'
      : `<div class="notif-row">🪪 <b>${pending.length}</b> registrant${pending.length===1?'':'s'} awaiting verification</div>`;
  } else {
    dot.hidden = true;
    list.innerHTML = '<div class="notif-empty">No new notifications.</div>';
  }
}

(async function init(){
  if(window.sbMissing){ app.innerHTML = `<div class="card"><h3>Setup needed</h3><p class="lead" style="margin:0">${esc(window.sbMissingReason)}</p></div>`; return; }
  const { data: sessData } = await sb.auth.getSession();
  const session = sessData && sessData.session;
  if(!session){ window.location.href = 'index.html'; return; }
  sb.auth.onAuthStateChange((event) => { if(event === 'SIGNED_OUT') window.location.href = 'index.html'; });

  const { data: me, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if(error || !me){
    await sb.auth.signOut();
    alert('Your account profile could not be found. Please contact the library staff.');
    window.location.href = 'index.html'; return;
  }
  state.user = me;
  state.tab = me.user_role === 'staff' ? 'dashboard' : 'ebooks';
  const roleLabel = me.user_role === 'staff' ? 'Staff' : 'Student';
  document.getElementById('profileName').textContent = (me.name || '').split(' ')[0] || roleLabel;
  document.getElementById('profileNameFull').textContent = `${me.name} · ${roleLabel}`;
  document.getElementById('profileEmail').textContent = me.email;
  const now = new Date();
  document.getElementById('dateBadge').innerHTML = now.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) + '<br>' + now.toLocaleDateString(undefined,{weekday:'long'}) + ', ' + now.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  const ok = await loadAll();
  if(!ok) return;
  refreshAvatarUI();
  renderNotifications();
  render();
})();
