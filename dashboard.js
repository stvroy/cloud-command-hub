/* ═══════════════════════════════════════════════════════
   AWS Infra Dashboard — dashboard.js
   ═══════════════════════════════════════════════════════ */

let _m = {};          // raw metrics
let _events = [];     // internal event log (collector alerts)
let _logsData     = [];   // last Loki result set
let _logsTimer    = null; // live-refresh interval
let _logsRange    = '1h'; // selected time range
let _logsLive     = false;
let _logsStart    = null; // custom absolute start (ISO string) — null = relative mode
let _logsEnd      = null; // custom absolute end   (ISO string) — null = now
const POLL       = 60_000;  // normal cadence once data is present
const POLL_EAGER =  5_000;  // fast retry when cache is still cold
let _pollTimer       = null;
let _syncStatusData  = null;   // response from /api/sync-status
let _syncHistoryData = null;   // response from /api/sync-history

function _scheduleNextPoll() {
  clearTimeout(_pollTimer);
  const hasData = Object.keys(_m).length >= 3;
  _pollTimer = setTimeout(fetchMetrics, hasData ? POLL : POLL_EAGER);
}

/* ── INIT ─────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  tickClock();
  setInterval(tickClock, 1000);
  fetchMetrics();
  initReportMonthPicker();
});

/* ── CLOCK ────────────────────────────────────────────── */
function tickClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ── MONTHLY REPORT DOWNLOAD ─────────────────────────── */
function initReportMonthPicker() {
  const input = document.getElementById('report-month');
  if (!input) return;
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yyyy = prev.getFullYear();
  const mm   = String(prev.getMonth() + 1).padStart(2, '0');
  input.value = `${yyyy}-${mm}`;
  // Don't allow selecting a month in the future
  const curY = now.getFullYear();
  const curM = String(now.getMonth() + 1).padStart(2, '0');
  input.max  = `${curY}-${curM}`;
}

async function downloadMonthlyReport() {
  const input = document.getElementById('report-month');
  const btn   = document.getElementById('report-dl-btn');
  if (!input || !btn) return;
  const month = input.value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    alert('Please pick a valid month.');
    return;
  }
  const origLabel = btn.textContent;
  btn.disabled   = true;
  btn.textContent = '⏳ Generating…';
  try {
    const r = await fetch(`/api/reports/monthly?month=${encodeURIComponent(month)}`, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); if (j && j.detail) msg = j.detail; } catch (_) {}
      throw new Error(msg);
    }
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `Monthly-Report-${month}.pptx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) {
    console.error('[report] download failed', e);
    alert(`Report generation failed: ${e.message || e}`);
  } finally {
    btn.disabled   = false;
    btn.textContent = origLabel;
  }
}

/* ── FETCH ────────────────────────────────────────────── */
async function fetchMetrics() {
  setPulse('loading');
  try {
    const r = await fetch('/api/metrics');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    _m = json.metrics || {};
    renderAll();
    setPulse('ok');
    const el = document.getElementById('last-updated');
    if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    setPulse('error');
    const el = document.getElementById('last-updated');
    if (el) el.textContent = 'Error – retrying';
    console.error(e);
  }
  _scheduleNextPoll();
}

function setPulse(s) {
  const d = document.getElementById('pulse-dot');
  if (!d) return;
  d.style.background = s === 'ok' ? 'var(--ok)' : s === 'error' ? 'var(--crit)' : 'var(--warn)';
}

/* ── RENDER ALL ───────────────────────────────────────── */
function renderAll() {
  const ec2  = _m.ec2         || {};
  const eks  = _m.eks         || {};
  const up   = _m.uptime      || {};
  const gd   = _m.guardduty   || {};
  const alb  = _m.alb         || {};
  const net  = _m.ec2_network || {};
  const cost = _m.cost        || {};
  const iam  = _m.iam         || {};

  detectEvents(ec2, eks, up, gd, alb, net);
  renderOverview(ec2, eks, up, gd, alb, cost);
  renderEC2();
  renderEKS(eks);
  renderUptime(up.services || [], up);
  renderSecurity(gd, _m.storage || {}, _m.iam || {});
  renderInfraSecurity(_m.security || {});
  renderALB(alb);
  renderEC2Network(net);
  renderCosts(cost);
  renderIAM(iam);
  renderStorage(_m.storage || {});
  renderLogs();
  renderAlerts();
  loadIncidents();
  renderCapacity(ec2, eks);
  renderSavings(ec2, alb, cost);
  renderAppPerf(_m.telemetry || null);
  renderNGSAFHIR(_m.ngsa_fhir || {});
  updateBadges(ec2, eks, up, gd, alb, iam, _m.storage || {});
}

/* ── NAVIGATION ───────────────────────────────────────── */
const TITLES = {
  overview:'Executive Summary', ec2:'EC2 Instances', eks:'EKS Kubernetes',
  storage:'Volumes & S3', network:'Network & ALB', uptime:'Service Uptime',
  logs:'Event Logs', alerts:'Active Alerts', security:'Threat Detection',
  iam:'IAM & Access', costs:'Monthly Costs',
  savings:'Savings & Rightsizing', deployments:'Deploy History', capacity:'Capacity Planning',
  appperf:'App Performance', containers:'Container Health', admin:'Admin Panel',
  instances:'Instance Control', ngsa:'NGSA FHIR',
};

function navigate(id, el) {
  document.querySelectorAll('.ds').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = document.getElementById('s-' + id);
  if (sec) sec.classList.add('active');
  // Activate the matching sidebar item — works whether called from sidebar or a KPI card
  const navEl = el || document.querySelector(`.nav-item[onclick*="'${id}'"]`);
  if (navEl) navEl.classList.add('active');
  const pt = document.getElementById('page-title');
  if (pt) pt.textContent = TITLES[id] || id;
  const bl = document.getElementById('breadcrumb-leaf');
  if (bl) bl.textContent = TITLES[id] || id;
  if (id !== 'eks')       stopEKSLiveRefresh();
  if (id !== 'logs')      stopLogsRefresh();
  if (id === 'logs')      startLogsRefresh();
  if (id === 'alerts')    loadIncidents();
  if (id === 'instances') loadInstances();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

/* ── OVERVIEW ─────────────────────────────────────────── */
function renderOverview(ec2, eks, up, gd, alb, cost) {
  // KPIs
  const instances = ec2.instances || [];
  // EC2: green >80% running, amber >60%, red ≤50%
  const runningPct = ec2.total > 0 ? (ec2.running / ec2.total) * 100 : 100;
  setText('k-ec2',   ec2.total ?? '—');
  setColor('k-ec2',  runningPct <= 50 ? 'crit' : runningPct <= 60 ? 'warn' : runningPct > 80 ? 'ok' : 'warn');
  setText('k-ec2s',  ec2.running != null ? `${ec2.running} running · ${ec2.stopped} stopped` : '—');

  // EKS: red if any failed, amber if pending >10% of total, green otherwise
  const pendingPct = eks.total_pods > 0 ? (eks.pending_pods / eks.total_pods) * 100 : 0;
  setText('k-pods',  eks.total_pods ?? '—');
  setColor('k-pods', eks.failed_pods >= 5 ? 'crit' : eks.failed_pods > 0 || pendingPct > 10 ? 'warn' : 'ok');
  const podSub = eks.running_pods != null
    ? `${eks.running_pods} running · ${eks.pending_pods} pending${eks.failed_pods > 0 ? ` · ${eks.failed_pods} failed` : ''}`
    : '—';
  setText('k-podss', podSub);

  // Uptime: green ≥90%, amber ≥70%, red <70% — exclude maintenance services from denominator
  const _maintCount = up.maintenance ?? 0;
  const _activeSvcs = (up.total ?? 0) - _maintCount;
  const upPct = _activeSvcs > 0 ? Math.round((up.up / _activeSvcs) * 100) : null;
  setText('k-uptime',  upPct != null ? upPct + '%' : '—');
  setColor('k-uptime', upPct == null ? 'warn' : upPct < 70 ? 'crit' : upPct < 90 ? 'warn' : 'ok');
  const _uptimeSub = up.total != null
    ? (_maintCount > 0 ? `${up.up}/${_activeSvcs} up · ${_maintCount} maintenance` : `${up.up}/${up.total} services up`)
    : 'Configure endpoints';
  setText('k-uptimes', _uptimeSub);

  const alertCount = _events.filter(e => e.severity === 'critical').length;
  setText('k-alerts',  alertCount);
  setColor('k-alerts', alertCount > 0 ? 'crit' : 'ok');
  setText('k-alertss', alertCount > 0 ? `${alertCount} need attention` : 'All systems nominal');

  // Cost KPI
  const mtd = cost.mtd;
  const fc  = cost.forecast;
  // Colour based on daily avg vs last month daily avg: red >20% over, amber >5% over, green otherwise
  const mom = cost.mom_change_pct;
  const costColor = mom == null ? 'ok' : mom > 20 ? 'crit' : mom > 5 ? 'warn' : 'ok';
  setText('k-cost', mtd != null ? '$' + mtd.toLocaleString() : '—');
  setColor('k-cost', costColor);
  const costSub = fc && cost.mom_change_pct != null
    ? `Forecast $${fc.toLocaleString()} EOM · ${cost.mom_change_pct > 0 ? '↑' : '↓'}${Math.abs(cost.mom_change_pct)}% daily avg vs last month`
    : 'Cost Explorer data loading…';
  setText('k-cost-sub', costSub);

  const gdTotal = gd.summary?.total ?? null;
  const gdHigh  = gd.summary?.high  ?? 0;
  const gdScore = gdTotal === 0 ? 100 : (gd.security_score ?? null);
  setText('k-sec',  gdTotal != null ? gdTotal : '—');
  setColor('k-sec', gdHigh > 0 ? 'crit' : gdTotal > 0 ? 'warn' : 'ok');
  setText('k-secs', gdTotal != null
    ? (gdTotal === 0 ? 'No threats detected ✓' : `${gdHigh} high · ${gd.summary.medium} med · ${gd.summary.low} low`)
    : 'Enable guardduty permissions');

  // Security health bar — 0 findings = 100%
  const secScore = gdScore ?? 0;
  const hbSec = document.getElementById('hb-sec');
  const hpSec = document.getElementById('hp-sec');
  if (hbSec) {
    hbSec.style.width = secScore + '%';
    hbSec.style.background = healthColor(secScore);
  }
  if (hpSec) hpSec.textContent = gdScore != null ? secScore + '%' : '—';

  // Health bars — performance of what's running, not presence
  // EC2: score only running instances by CPU/mem/disk thresholds; stopped instances are invisible
  const runningInst = (ec2.instances || []).filter(i => i.state === 'running');
  const measuredInst = runningInst.filter(i => i.cpu_percent > 0 || i.mem_percent > 0 || i.disk_percent > 0);
  const healthyInst  = measuredInst.filter(i => i.cpu_percent < 80 && i.mem_percent < 80 && i.disk_percent < 85);
  const ec2Health = measuredInst.length > 0
    ? Math.round((healthyInst.length / measuredInst.length) * 100)
    : (runningInst.length > 0 ? 100 : 0);

  // EKS: pod health — failed pods drag the score; pending pods (may be starting) don't
  const eksHealth = eks.total_pods > 0
    ? Math.round(((eks.total_pods - (eks.failed_pods || 0)) / eks.total_pods) * 100)
    : (eks.total_nodes > 0 ? 100 : 0);

  const svcHealth = up.total ? Math.round((up.up / up.total) * 100) : 0;

  setBar('hb-ec2', ec2Health); setText('hp-ec2', ec2Health + '%');
  setBar('hb-eks', eksHealth); setText('hp-eks', eksHealth + '%');
  setBar('hb-svc', svcHealth); setText('hp-svc', up.total ? svcHealth + '%' : '—');

  // Critical events feed
  const feed = document.getElementById('ov-events');
  if (feed) {
    const crits = _events.filter(e => e.severity === 'critical').slice(0, 6);
    if (!crits.length) {
      feed.innerHTML = '<div class="ef-empty">✓ No critical events</div>';
    } else {
      feed.innerHTML = crits.map(e => `
        <div class="ef-row">
          <div class="ef-dot crit"></div>
          <div class="ef-body"><span class="ef-src">${esc(e.source)}</span> — ${esc(e.message)}</div>
          <div class="ef-time">${esc(e.time)}</div>
        </div>`).join('');
    }
  }

  // ── Platform Snapshot — What Needs Attention ──────────
  const snap = document.getElementById('ov-snapshot');
  if (snap) {
    const items = [];

    if (eks.failed_pods > 0)
      items.push({ sev: 'crit', msg: `${eks.failed_pods} application workload${eks.failed_pods !== 1 ? 's have' : ' has'} stopped unexpectedly` });

    const downCount = _activeSvcs - (up.up ?? 0);
    if (downCount > 0)
      items.push({ sev: 'crit', msg: `${downCount} monitored service${downCount !== 1 ? 's are' : ' is'} not responding` });

    if (gdHigh > 0)
      items.push({ sev: 'crit', msg: `${gdHigh} high-severity security threat${gdHigh !== 1 ? 's' : ''} detected` });

    const hotInst = measuredInst.filter(i => i.cpu_percent >= 80 || i.mem_percent >= 80 || i.disk_percent >= 85);
    if (hotInst.length > 0)
      items.push({ sev: 'warn', msg: `${hotInst.length} server${hotInst.length !== 1 ? 's are' : ' is'} running above healthy resource thresholds` });

    if (mom > 20)
      items.push({ sev: 'crit', msg: `Daily spend rate is ${mom}% above last month's average` });
    else if (mom > 5)
      items.push({ sev: 'warn', msg: `Daily spend rate is ${mom}% above last month's average` });

    if (gdHigh === 0 && gdTotal > 0)
      items.push({ sev: 'warn', msg: `${gdTotal} security finding${gdTotal !== 1 ? 's' : ''} flagged for review` });

    const fhirSnap = _m.ngsa_fhir || {};
    if (fhirSnap.status === 'down')
      items.push({ sev: 'crit', msg: 'NGSA FHIR gateway is not responding' });


    snap.innerHTML = items.length === 0
      ? `<div class="snap-clear">
           <div class="snap-clear-dot"></div>
           <div>
             <div class="snap-clear-title">Nothing requires your attention</div>
             <div class="snap-clear-sub">Services responding · No threats · Infrastructure healthy</div>
           </div>
         </div>`
      : items.slice(0, 5).map(it =>
          `<div class="snap-item">
             <div class="snap-dot ${it.sev}"></div>
             <div class="snap-msg">${esc(it.msg)}</div>
           </div>`).join('');
  }

  // ── Dynamic Region Distribution ───────────────────────
  renderRegionGrid(ec2, alb);
}

function renderRegionGrid(ec2, alb) {
  const grid = document.getElementById('region-grid');
  if (!grid) return;

  const instances = (ec2.instances || []);
  const byRegion  = ec2.by_region || [];

  // If no data yet, show loading
  if (!instances.length && !byRegion.length) {
    grid.innerHTML = '<div class="rgn"><div class="rgn-dot pulsing"></div><div class="rgn-name">Loading…</div><div class="rgn-stats">Fetching region data</div></div>';
    return;
  }

  // Build region map from instances
  const regionMap = {};
  instances.forEach(i => {
    const r = i.region || 'us-east-1';
    if (!regionMap[r]) {
      regionMap[r] = { region: r, instances: 0, running: 0, stopped: 0, accounts: new Set(), albs: 0 };
    }
    regionMap[r].instances++;
    if (i.state === 'running') regionMap[r].running++;
    else regionMap[r].stopped++;
    regionMap[r].accounts.add(i.account_name);
  });

  // Count ALBs per region (ALBs don't have region in current data — assume primary region)
  const albRegion = 'us-east-1';
  if (alb.load_balancers?.length) {
    if (regionMap[albRegion]) regionMap[albRegion].albs = alb.load_balancers.length;
  }

  // Sort regions — us-east-1 first, then alphabetically
  const regions = Object.values(regionMap).sort((a, b) => {
    if (a.region === 'us-east-1') return -1;
    if (b.region === 'us-east-1') return  1;
    return a.region.localeCompare(b.region);
  });

  // Region friendly names
  const regionNames = {
    'us-east-1':      'US East (N. Virginia)',
    'us-east-2':      'US East (Ohio)',
    'us-west-1':      'US West (N. California)',
    'us-west-2':      'US West (Oregon)',
    'eu-west-1':      'Europe (Ireland)',
    'eu-central-1':   'Europe (Frankfurt)',
    'ap-southeast-1': 'Asia Pacific (Singapore)',
    'ap-southeast-2': 'Asia Pacific (Sydney)',
  };

  grid.innerHTML = regions.map((r, idx) => {
    const isPrimary = r.region === 'us-east-1';
    const accounts  = [...r.accounts].join(', ');
    const health    = r.stopped > 0 ? 'var(--warn)' : 'var(--ok)';
    return `
      <div class="rgn ${isPrimary ? 'active-rgn' : ''}">
        <div class="rgn-dot pulsing" style="background:${health}"></div>
        <div class="rgn-name">${esc(regionNames[r.region] || r.region)}</div>
        <div style="font-size:9px;color:var(--t3);font-family:'DM Mono',monospace;margin-bottom:4px">${esc(r.region)}</div>
        <div class="rgn-stats">
          <span style="color:${health};font-weight:500">${r.running} running</span>
          ${r.stopped > 0 ? `<span style="color:var(--warn)"> · ${r.stopped} stopped</span>` : ''}
        </div>
        <div class="rgn-stats" style="margin-top:2px">${r.instances} instances total</div>
        ${r.albs > 0 ? `<div class="rgn-stats" style="margin-top:2px">${r.albs} load balancers</div>` : ''}
        <div class="rgn-stats" style="margin-top:4px;color:var(--t3);font-size:10px">${esc(accounts)}</div>
      </div>`;
  }).join('');
}

/* ── EC2 ──────────────────────────────────────────────── */
/* ── EC2 OVERVIEW ─────────────────────────────────────── */
function renderEC2Overview(ec2) {
  const instances = ec2.instances || [];
  const running   = instances.filter(i => i.state === 'running');
  const stopped   = instances.filter(i => i.state !== 'running');
  const eksNodes  = instances.filter(i => i.is_eks_node);

  // ── Averages (only instances with non-zero metrics, to avoid dragging
  //    down the average with instances that don't have CWAgent installed)
  function avgMetric(list, key) {
    const vals = list.map(i => i.metrics?.[key] || 0).filter(v => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const avgCpu  = avgMetric(running, 'cpu_percent');
  const avgMem  = avgMetric(running, 'mem_percent');
  const avgDisk = avgMetric(running, 'disk_percent');

  // ── Gauge helper (reuses EKS gauge elements style)
  function setGauge(pctEl, barEl, subEl, pct, subText, warnAt, critAt) {
    const el = document.getElementById(pctEl);
    const bar = document.getElementById(barEl);
    const sub = document.getElementById(subEl);
    if (el)  el.textContent = pct > 0 ? pct.toFixed(1) + '%' : '—';
    if (sub) sub.textContent = subText;
    if (bar) {
      bar.style.width = Math.min(pct, 100) + '%';
      bar.className = 'util-fill ' + (pct >= critAt ? 'crit' : pct >= warnAt ? 'warn' : 'ok');
    }
  }

  const withCpu  = running.filter(i => (i.metrics?.cpu_percent  || 0) > 0).length;
  const withMem  = running.filter(i => (i.metrics?.mem_percent  || 0) > 0).length;
  const withDisk = running.filter(i => (i.metrics?.disk_percent || 0) > 0).length;

  setGauge('ec2-util-cpu-pct',  'ec2-util-cpu-bar',  'ec2-util-cpu-sub',
    avgCpu,  `avg across ${withCpu} reporting instance${withCpu !== 1 ? 's' : ''}`,  60, 80);
  setGauge('ec2-util-mem-pct',  'ec2-util-mem-bar',  'ec2-util-mem-sub',
    avgMem,  `avg across ${withMem} reporting instance${withMem !== 1 ? 's' : ''}`,  60, 80);
  setGauge('ec2-util-disk-pct', 'ec2-util-disk-bar', 'ec2-util-disk-sub',
    avgDisk, `avg across ${withDisk} reporting instance${withDisk !== 1 ? 's' : ''}`, 70, 85);

  // ── Fleet stats bar
  const highCpu  = running.filter(i => (i.metrics?.cpu_percent  || 0) >= 80).length;
  const highMem  = running.filter(i => (i.metrics?.mem_percent  || 0) >= 80).length;
  const highDisk = running.filter(i => (i.metrics?.disk_percent || 0) >= 85).length;
  const accounts = new Set(instances.map(i => i.account_id)).size;
  const regions  = new Set(instances.map(i => i.region).filter(Boolean)).size;

  function setStat(id, val, colorClass) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    // only override color class when there's something to flag
    if (colorClass) el.className = 'po-v ' + colorClass;
  }
  setStat('ec2-st-running',  running.length,  running.length  > 0 ? 'ok'   : 'muted');
  setStat('ec2-st-stopped',  stopped.length,  stopped.length  > 0 ? 'warn' : 'muted');
  setStat('ec2-st-eks',      eksNodes.length, eksNodes.length > 0 ? 'info' : 'muted');
  setStat('ec2-st-accounts', accounts,        null);
  setStat('ec2-st-regions',  regions,         null);
  setStat('ec2-st-highcpu',  highCpu,         highCpu  > 0 ? 'crit' : 'ok');
  setStat('ec2-st-highmem',  highMem,         highMem  > 0 ? 'warn' : 'ok');
  setStat('ec2-st-highdisk', highDisk,        highDisk > 0 ? 'warn' : 'ok');

  // ── Per-account health grid
  const grid = document.getElementById('ec2-acct-grid');
  if (!grid) return;

  // group instances by account
  const byAcct = {};
  for (const i of instances) {
    const key = i.account_id || 'unknown';
    if (!byAcct[key]) byAcct[key] = {
      name: i.account_name || key,
      env:  i.environment  || '',
      color: i.env_color   || 'var(--t3)',
      running: 0, stopped: 0, eks: 0,
      highCpu: 0, highMem: 0, highDisk: 0,
    };
    const a = byAcct[key];
    if (i.state === 'running') {
      a.running++;
      if (i.is_eks_node) a.eks++;
      if ((i.metrics?.cpu_percent  || 0) >= 80) a.highCpu++;
      if ((i.metrics?.mem_percent  || 0) >= 80) a.highMem++;
      if ((i.metrics?.disk_percent || 0) >= 85) a.highDisk++;
    } else {
      a.stopped++;
    }
  }

  const cards = Object.values(byAcct).sort((a, b) => b.running - a.running);
  grid.innerHTML = cards.map(a => {
    const alerts = a.highCpu + a.highMem + a.highDisk;
    const alertBadge = alerts > 0
      ? `<span class="ec2-acct-alert">${alerts} alert${alerts !== 1 ? 's' : ''}</span>`
      : `<span class="ec2-acct-ok">✓ Healthy</span>`;
    const eksBit = a.eks > 0
      ? `<div class="ec2-acct-eks">${a.eks} EKS node${a.eks !== 1 ? 's' : ''}</div>`
      : '';
    return `<div class="ec2-acct-card po-clickable" onclick="openEC2StatModal('acct_${esc(a.name)}')" title="Show all ${esc(a.name)} instances">
      <div class="ec2-acct-hdr" style="border-left:3px solid ${a.color}">
        <span class="ec2-acct-name">${esc(a.name)}</span>
        <span class="ec2-acct-env">${esc(a.env)}</span>
      </div>
      <div class="ec2-acct-body">
        <div class="ec2-acct-row">
          <span class="ec2-acct-lbl">Running</span>
          <span class="ec2-acct-val ok">${a.running}</span>
        </div>
        <div class="ec2-acct-row">
          <span class="ec2-acct-lbl">Stopped</span>
          <span class="ec2-acct-val ${a.stopped > 0 ? 'warn' : 'muted'}">${a.stopped}</span>
        </div>
        ${eksBit}
        <div class="ec2-acct-footer">${alertBadge}</div>
      </div>
    </div>`;
  }).join('');
}

function renderEC2() {
  const instances = (_m.ec2 || {}).instances || [];
  // Render overview first
  renderEC2Overview(_m.ec2 || {});
  const q   = (document.getElementById('ec2-q')?.value     || '').toLowerCase();
  const sf  = (document.getElementById('ec2-state')?.value  || '');
  const rf  = (document.getElementById('ec2-region')?.value || '');

  let filtered = instances;
  if (q)  filtered = filtered.filter(i =>
    (i.name + i.id + i.type + (i.account_name||'')).toLowerCase().includes(q));
  if (sf) filtered = filtered.filter(i => i.state === sf);
  if (rf) filtered = filtered.filter(i => i.region === rf);

  // Populate region filter options dynamically
  const regionSel = document.getElementById('ec2-region');
  if (regionSel && regionSel.options.length <= 1) {
    const regions = [...new Set(instances.map(i => i.region).filter(Boolean))].sort();
    regions.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      regionSel.appendChild(opt);
    });
  }

  const tag = document.getElementById('ec2-tag');
  if (tag) {
    const accounts = new Set(filtered.map(i => i.account_id)).size;
    const regions  = new Set(filtered.map(i => i.region).filter(Boolean)).size;
    tag.textContent = `${filtered.length} instances · ${accounts} accounts · ${regions} regions`;
  }

  const tbody = document.getElementById('ec2-tbody');
  if (!tbody) return;
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="tr-load">${q ? 'No matches.' : 'No EC2 data.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(i => {
    const cpu      = i.metrics?.cpu_percent  || 0;
    const mem      = i.metrics?.mem_percent  || 0;
    const disk     = i.metrics?.disk_percent || 0;
    const cpuSp    = i.metrics?.cpu_spark    || [];
    const memSp    = i.metrics?.mem_spark    || [];
    const diskSp   = i.metrics?.disk_spark   || [];
    const isOhio   = i.region === 'us-east-2';
    const running  = i.state === 'running';

    const eksBadge = i.is_eks_node
      ? `<span class="eks-node-badge" title="EKS worker node&#10;Cluster: ${esc(i.eks_cluster||'—')}${i.eks_nodegroup ? '&#10;Node group: ' + esc(i.eks_nodegroup) : ''}&#10;&#10;Resource details (CPU · Memory · Pods)&#10;are in the EKS section below ↓">EKS</span>`
      : '';

    const cpuCell  = running ? barCellWithSpark(cpu,  cpuSp)  : '<span class="muted">—</span>';
    const memCell  = running && mem  ? barCellWithSpark(mem,  memSp)  : '<span class="muted">n/a</span>';
    const diskCell = running && disk ? barCellWithSpark(disk, diskSp) : '<span class="muted">n/a</span>';

    const rowClass = i.is_eks_node ? 'ec2-eks-row ec2-clickable-row' : 'ec2-clickable-row';
    return `<tr class="${rowClass}" onclick="openEC2InstanceModal('${esc(i.id)}')" title="Click for details">
      <td>
        <div style="font-size:11px;font-weight:600;color:${i.env_color||'var(--t2)'}">
          ${esc(i.account_name||'—')}
        </div>
      </td>
      <td>
        <div style="font-weight:500;display:flex;align-items:center;gap:5px">${esc(i.name)}${eksBadge}</div>
        <div class="muted" style="font-size:11px">${esc(i.private_ip||'')}</div>
        ${i.is_eks_node ? `<div class="eks-node-hint">Resource info in EKS section ↓</div>` : ''}
      </td>
      <td class="mono" style="color:var(--t3);font-size:11px">${esc(i.id)}</td>
      <td class="muted">${esc(i.type)}</td>
      <td>
        <div class="muted" style="font-size:11px">${esc(i.az||'—')}</div>
        ${i.region ? `<div style="font-size:10px;color:${isOhio ? 'var(--warn)' : 'var(--t3)'}">
          ${isOhio ? '⬡ ' : ''}${esc(i.region)}
        </div>` : ''}
      </td>
      <td>${cpuCell}</td>
      <td>${memCell}</td>
      <td>${diskCell}</td>
      <td>${stateBadge(i.state, cpu, mem, disk)}</td>
    </tr>`;
  }).join('');
}

/* ── EC2 INSTANCE DETAIL MODAL ───────────────────────── */
function sparklineAreaSvg(values, color, height) {
  if (!values || values.length < 2) return '';
  const h = height || 50;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100;
    const y = h - Math.min(100, Math.max(0, v)) / 100 * h;
    return [x.toFixed(1), y.toFixed(1)];
  });
  const lineStr  = pts.map(p => p.join(',')).join(' ');
  const areaPath = `M${pts[0].join(',')} ${pts.slice(1).map(p => 'L' + p.join(',')).join(' ')} L${pts[pts.length-1][0]},${h} L${pts[0][0]},${h} Z`;
  const gid = 'sg' + values.length + '_' + Math.round(values[0] * 10);
  return `<svg viewBox="0 0 100 ${h}" preserveAspectRatio="none" width="100%" height="${h}" style="display:block;border-radius:3px">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#${gid})"/>
    <polyline points="${lineStr}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function sparklineSvg(values, color) {
  if (!values || values.length < 2) return '';
  const h = 14, w = 72;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - Math.min(100, Math.max(0, v)) / 100 * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="${w}" height="${h}" style="display:block;margin-top:3px">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" opacity="0.75"/>
  </svg>`;
}

function barCellWithSpark(pct, spark) {
  const color = usageColor(pct);
  return `<div>
    <div class="bar-row">
      <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="bar-lbl" style="color:${color}">${pct}%</div>
    </div>
    ${sparklineSvg(spark, color)}
  </div>`;
}

const EC2_RANGES = ['5m','15m','30m','1h','24h','7d','30d'];
let _ec2ModalInstanceId = null;
let _ec2ModalRange      = '1h';

function openEC2InstanceModal(instanceId) {
  _ec2ModalInstanceId = instanceId;
  _ec2ModalRange      = '1h';

  const instances = (_m.ec2 || {}).instances || [];
  const inst = instances.find(i => i.id === instanceId);
  if (!inst) return;

  const overlay = document.getElementById('ec2-modal-overlay');
  const title   = document.getElementById('ec2-modal-title');
  const meta    = document.getElementById('ec2-modal-meta');
  const body    = document.getElementById('ec2-modal-body');
  if (!overlay) return;

  title.textContent = inst.name;
  meta.innerHTML = `<span class="mono" style="font-size:11px">${esc(inst.id)}</span> · ${esc(inst.type)} · ${esc(inst.az||'—')} · ${esc(inst.account_name||'—')}`;

  const cpu      = inst.metrics?.cpu_percent  || 0;
  const mem      = inst.metrics?.mem_percent  || 0;
  const disk     = inst.metrics?.disk_percent || 0;
  const cpuSp      = inst.metrics?.cpu_spark    || [];
  const memSp      = inst.metrics?.mem_spark    || [];
  const diskSp     = inst.metrics?.disk_spark   || [];
  const mounts     = inst.metrics?.disk_mounts  || [];
  const memTotalGb = inst.metrics?.mem_total_gb || 0;
  const memAvailGb = inst.metrics?.mem_avail_gb || 0;
  const running    = inst.state === 'running';

  const stateLine = `<div style="margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    ${stateBadge(inst.state, cpu, mem, disk)}
    ${inst.public_ip  ? `<span style="font-size:12px;color:var(--t2)">public: ${esc(inst.public_ip)}</span>`  : ''}
    ${inst.private_ip ? `<span style="font-size:12px;color:var(--t3)">private: ${esc(inst.private_ip)}</span>` : ''}
    ${inst.is_eks_node ? `<span class="eks-node-badge">EKS</span>` : ''}
    ${inst.eks_cluster ? `<span style="font-size:11px;color:var(--t3)">${esc(inst.eks_cluster)}</span>` : ''}
  </div>`;

  function metricPanel(label, pct, spark) {
    const color = usageColor(pct);
    const noData = !running || (!pct && !spark.length);
    return `<div style="flex:1;min-width:180px;background:var(--card-bg,rgba(255,255,255,0.04));border:1px solid var(--bdr,rgba(255,255,255,0.08));border-radius:8px;padding:14px">
      <div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${label}</div>
      <div style="font-size:28px;font-weight:700;color:${noData ? 'var(--t3)' : color};margin-bottom:8px">${noData ? '—' : pct.toFixed(1) + '%'}</div>
      <div class="bar-bg" style="height:6px;margin-bottom:12px">
        <div class="bar-fill" style="width:${noData ? 0 : pct}%;background:${color};height:100%"></div>
      </div>
      <div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px">
        ${noData ? '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">No data</div>'
                 : (spark.length >= 2 ? sparklineAreaSvg(spark, color, 50) : '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">Collecting…</div>')}
        <div style="font-size:10px;color:var(--t3);text-align:right;margin-top:4px">Last 1 hour</div>
      </div>
    </div>`;
  }

  function memPanel() {
    const color  = usageColor(mem);
    const noData = !running || (!mem && !memSp.length);
    const usedGb = memTotalGb > 0 ? +(memTotalGb - memAvailGb).toFixed(1) : 0;
    const memBreakdown = memTotalGb > 0 ? `
      <div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px;margin-top:4px">
        <div style="font-size:10px;color:var(--t3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Memory</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="font-size:10px;color:var(--t3);text-align:left;padding-bottom:4px"></th>
            <th style="font-size:10px;color:var(--t3);text-align:right;padding-bottom:4px">GiB</th>
          </tr></thead>
          <tbody>
            <tr>
              <td style="font-size:12px;color:var(--t2);padding:2px 0">Total</td>
              <td style="font-size:12px;color:var(--t3);text-align:right">${memTotalGb}</td>
            </tr>
            <tr>
              <td style="font-size:12px;color:var(--t2);padding:2px 0">Used</td>
              <td style="font-size:12px;text-align:right;color:${usageColor(mem)}">${usedGb}</td>
            </tr>
            <tr>
              <td style="font-size:12px;color:var(--t2);padding:2px 0">Free</td>
              <td style="font-size:12px;color:var(--ok);text-align:right">${memAvailGb}</td>
            </tr>
          </tbody>
        </table>
      </div>` : '';
    return `<div style="flex:1;min-width:180px;background:var(--card-bg,rgba(255,255,255,0.04));border:1px solid var(--bdr,rgba(255,255,255,0.08));border-radius:8px;padding:14px">
      <div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Memory Usage</div>
      <div style="font-size:28px;font-weight:700;color:${noData ? 'var(--t3)' : color};margin-bottom:8px">${noData ? '—' : mem.toFixed(1) + '%'}</div>
      <div class="bar-bg" style="height:6px;margin-bottom:4px">
        <div class="bar-fill" style="width:${noData ? 0 : mem}%;background:${color};height:100%"></div>
      </div>
      ${noData ? '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">No data</div>'
               : (memBreakdown + `<div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px;margin-top:8px">
                   ${memSp.length >= 2 ? sparklineAreaSvg(memSp, color, 50) : '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">Collecting…</div>'}
                   <div style="font-size:10px;color:var(--t3);text-align:right;margin-top:4px">Last 1 hour</div>
                 </div>`)}
    </div>`;
  }

  function diskPanel() {
    const color  = usageColor(disk);
    const noData = !running || !disk;
    const mountRows = mounts.map(m => {
      const mc = usageColor(m.used_pct);
      const sizeStr = m.size_gb >= 1024 ? (m.size_gb / 1024).toFixed(1) + ' TiB' : m.size_gb.toFixed(1) + ' GiB';
      const availStr = m.avail_gb >= 1024 ? (m.avail_gb / 1024).toFixed(1) + ' TiB' : m.avail_gb.toFixed(1) + ' GiB';
      return `<tr>
        <td style="font-family:monospace;font-size:12px;color:var(--t2)">${esc(m.mountpoint)}</td>
        <td style="font-size:11px;color:var(--t3);text-align:right">${sizeStr}</td>
        <td style="font-size:11px;color:var(--ok);text-align:right">${availStr}</td>
        <td style="min-width:90px">
          <div style="display:flex;align-items:center;gap:6px">
            <div class="bar-bg" style="flex:1;height:5px">
              <div class="bar-fill" style="width:${m.used_pct}%;background:${mc};height:100%"></div>
            </div>
            <span style="font-size:11px;color:${mc};white-space:nowrap">${m.used_pct}%</span>
          </div>
        </td>
      </tr>`;
    }).join('');

    const mountTable = mounts.length ? `
      <div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px;margin-top:4px">
        <div style="font-size:10px;color:var(--t3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Filesystems</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="font-size:10px;color:var(--t3);text-align:left;padding-bottom:4px">Mount</th>
            <th style="font-size:10px;color:var(--t3);text-align:right;padding-bottom:4px">Size</th>
            <th style="font-size:10px;color:var(--t3);text-align:right;padding-bottom:4px">Avail</th>
            <th style="font-size:10px;color:var(--t3);text-align:left;padding-bottom:4px;padding-left:6px">Used</th>
          </tr></thead>
          <tbody>${mountRows}</tbody>
        </table>
      </div>` : (noData ? '' : `<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">Collecting…</div>`);

    return `<div style="flex:1;min-width:220px;background:var(--card-bg,rgba(255,255,255,0.04));border:1px solid var(--bdr,rgba(255,255,255,0.08));border-radius:8px;padding:14px">
      <div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Disk Usage</div>
      <div style="font-size:28px;font-weight:700;color:${noData ? 'var(--t3)' : color};margin-bottom:8px">${noData ? '—' : disk.toFixed(1) + '%'}</div>
      <div class="bar-bg" style="height:6px;margin-bottom:4px">
        <div class="bar-fill" style="width:${noData ? 0 : disk}%;background:${color};height:100%"></div>
      </div>
      <div style="font-size:10px;color:var(--t3);margin-bottom:8px">Worst mountpoint</div>
      ${noData ? '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">No data</div>' : mountTable}
    </div>`;
  }

  const rangeBar = `<div id="ec2-range-bar" style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap">
    ${EC2_RANGES.map(r => `<button onclick="ec2RangeSelect('${r}')" id="ec2-rb-${r}"
      style="padding:3px 10px;border-radius:4px;border:1px solid rgba(255,255,255,0.12);
             background:${r === _ec2ModalRange ? 'rgba(79,195,247,0.18)' : 'rgba(255,255,255,0.04)'};
             color:${r === _ec2ModalRange ? '#4fc3f7' : 'var(--t2)'};font-size:12px;cursor:pointer">${r}</button>`).join('')}
    <span id="ec2-range-loading" style="font-size:11px;color:var(--t3);align-self:center;display:none">Loading…</span>
  </div>`;

  body.innerHTML = stateLine + rangeBar + `
    <div id="ec2-charts" style="display:flex;gap:12px;flex-wrap:wrap">
      ${metricPanel('CPU Usage', cpu, cpuSp)}
      ${memPanel()}
      ${diskPanel()}
    </div>
    <div style="margin-top:16px;font-size:11px;color:var(--t3)">
      Launched: ${inst.launch_time ? new Date(inst.launch_time).toLocaleString() : '—'} · Region: ${esc(inst.region||'—')} · AZ: ${esc(inst.az||'—')}
    </div>`;

  overlay.style.display = 'flex';
  // Immediately fetch live Prometheus data so values match Grafana, not the collector cache
  ec2RangeSelect(_ec2ModalRange);
}

async function ec2RangeSelect(range) {
  _ec2ModalRange = range;

  // Update button styles
  EC2_RANGES.forEach(r => {
    const btn = document.getElementById(`ec2-rb-${r}`);
    if (!btn) return;
    btn.style.background = r === range ? 'rgba(79,195,247,0.18)' : 'rgba(255,255,255,0.04)';
    btn.style.color      = r === range ? '#4fc3f7' : 'var(--t2)';
  });

  const loading = document.getElementById('ec2-range-loading');
  if (loading) loading.style.display = 'inline';

  try {
    const resp = await fetch(`/api/ec2/instance-metrics?instance_id=${encodeURIComponent(_ec2ModalInstanceId)}&range=${range}`);
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();

    // Re-open with fresh sparkline data merged in
    const instances = (_m.ec2 || {}).instances || [];
    const inst = instances.find(i => i.id === _ec2ModalInstanceId);
    if (!inst) return;

    // Use last point from range data as headline (reflects actual value at end of range);
    // fall back to cached snapshot when range data is absent.
    const lastVal = arr => arr && arr.length ? arr[arr.length - 1] : null;
    const cpu  = lastVal(data.cpu)  ?? inst.metrics?.cpu_percent  ?? 0;
    const mem  = lastVal(data.mem)  ?? inst.metrics?.mem_percent  ?? 0;
    const disk = lastVal(data.disk) ?? inst.metrics?.disk_percent ?? 0;
    const mounts     = inst.metrics?.disk_mounts  || [];
    const memTotalGb = inst.metrics?.mem_total_gb || 0;
    const memAvailGb = inst.metrics?.mem_avail_gb || 0;

    function metricPanel(label, pct, spark) {
      const color  = usageColor(pct);
      const noData = inst.state !== 'running' || (!pct && !spark.length);
      return `<div style="flex:1;min-width:180px;background:var(--card-bg,rgba(255,255,255,0.04));border:1px solid var(--bdr,rgba(255,255,255,0.08));border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${label}</div>
        <div style="font-size:28px;font-weight:700;color:${noData ? 'var(--t3)' : color};margin-bottom:8px">${noData ? '—' : pct.toFixed(1) + '%'}</div>
        <div class="bar-bg" style="height:6px;margin-bottom:12px">
          <div class="bar-fill" style="width:${noData ? 0 : pct}%;background:${color};height:100%"></div>
        </div>
        <div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px">
          ${noData ? '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">No data</div>'
                   : (spark.length >= 2 ? sparklineAreaSvg(spark, color, 50) : '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">Collecting…</div>')}
          <div style="font-size:10px;color:var(--t3);text-align:right;margin-top:4px">Last ${range}</div>
        </div>
      </div>`;
    }

    function memPanelR() {
      const color  = usageColor(mem);
      const noData = inst.state !== 'running' || (!mem && !(data.mem||[]).length);
      const usedGb = memTotalGb > 0 ? +(memTotalGb - memAvailGb).toFixed(1) : 0;
      const memBreakdown = memTotalGb > 0 ? `
        <div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px;margin-top:4px">
          <div style="font-size:10px;color:var(--t3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Memory</div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr>
              <th style="font-size:10px;color:var(--t3);text-align:left;padding-bottom:4px"></th>
              <th style="font-size:10px;color:var(--t3);text-align:right;padding-bottom:4px">GiB</th>
            </tr></thead>
            <tbody>
              <tr><td style="font-size:12px;color:var(--t2);padding:2px 0">Total</td><td style="font-size:12px;color:var(--t3);text-align:right">${memTotalGb}</td></tr>
              <tr><td style="font-size:12px;color:var(--t2);padding:2px 0">Used</td><td style="font-size:12px;text-align:right;color:${usageColor(mem)}">${usedGb}</td></tr>
              <tr><td style="font-size:12px;color:var(--t2);padding:2px 0">Free</td><td style="font-size:12px;color:var(--ok);text-align:right">${memAvailGb}</td></tr>
            </tbody>
          </table>
        </div>` : '';
      const sparkHtml = (data.mem||[]).length >= 2 ? sparklineAreaSvg(data.mem, color, 50) : '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">Collecting…</div>';
      return `<div style="flex:1;min-width:180px;background:var(--card-bg,rgba(255,255,255,0.04));border:1px solid var(--bdr,rgba(255,255,255,0.08));border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Memory Usage</div>
        <div style="font-size:28px;font-weight:700;color:${noData ? 'var(--t3)' : color};margin-bottom:8px">${noData ? '—' : mem.toFixed(1) + '%'}</div>
        <div class="bar-bg" style="height:6px;margin-bottom:4px"><div class="bar-fill" style="width:${noData ? 0 : mem}%;background:${color};height:100%"></div></div>
        ${noData ? '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">No data</div>'
                 : (memBreakdown + `<div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px;margin-top:8px">${sparkHtml}<div style="font-size:10px;color:var(--t3);text-align:right;margin-top:4px">Last ${range}</div></div>`)}
      </div>`;
    }

    function diskPanelR() {
      const color  = usageColor(disk);
      const noData = inst.state !== 'running' || !disk;
      const mountRows = mounts.map(m => {
        const mc = usageColor(m.used_pct);
        const sizeStr  = m.size_gb  >= 1024 ? (m.size_gb  / 1024).toFixed(1) + ' TiB' : m.size_gb.toFixed(1)  + ' GiB';
        const availStr = m.avail_gb >= 1024 ? (m.avail_gb / 1024).toFixed(1) + ' TiB' : m.avail_gb.toFixed(1) + ' GiB';
        return `<tr>
          <td style="font-family:monospace;font-size:12px;color:var(--t2)">${esc(m.mountpoint)}</td>
          <td style="font-size:11px;color:var(--t3);text-align:right">${sizeStr}</td>
          <td style="font-size:11px;color:var(--ok);text-align:right">${availStr}</td>
          <td style="min-width:90px"><div style="display:flex;align-items:center;gap:6px">
            <div class="bar-bg" style="flex:1;height:5px"><div class="bar-fill" style="width:${m.used_pct}%;background:${mc};height:100%"></div></div>
            <span style="font-size:11px;color:${mc};white-space:nowrap">${m.used_pct}%</span>
          </div></td>
        </tr>`;
      }).join('');
      const mountTable = mounts.length ? `
        <div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px;margin-top:4px">
          <div style="font-size:10px;color:var(--t3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Filesystems</div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr>
              <th style="font-size:10px;color:var(--t3);text-align:left;padding-bottom:4px">Mount</th>
              <th style="font-size:10px;color:var(--t3);text-align:right;padding-bottom:4px">Size</th>
              <th style="font-size:10px;color:var(--t3);text-align:right;padding-bottom:4px">Avail</th>
              <th style="font-size:10px;color:var(--t3);text-align:left;padding-bottom:4px;padding-left:6px">Used</th>
            </tr></thead>
            <tbody>${mountRows}</tbody>
          </table>
        </div>` : '';
      const sparkHtml = (data.disk || []).length >= 2 ? sparklineAreaSvg(data.disk, color, 50) : '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">Collecting…</div>';
      return `<div style="flex:1;min-width:220px;background:var(--card-bg,rgba(255,255,255,0.04));border:1px solid var(--bdr,rgba(255,255,255,0.08));border-radius:8px;padding:14px">
        <div style="font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Disk Usage</div>
        <div style="font-size:28px;font-weight:700;color:${noData ? 'var(--t3)' : color};margin-bottom:8px">${noData ? '—' : disk.toFixed(1) + '%'}</div>
        <div class="bar-bg" style="height:6px;margin-bottom:4px"><div class="bar-fill" style="width:${noData ? 0 : disk}%;background:${color};height:100%"></div></div>
        <div style="font-size:10px;color:var(--t3);margin-bottom:8px">Worst mountpoint</div>
        ${noData ? '<div style="font-size:11px;color:var(--t3);text-align:center;padding:10px 0">No data</div>' : (mountTable + `<div style="border-top:1px solid var(--bdr,rgba(255,255,255,0.06));padding-top:10px;margin-top:8px">${sparkHtml}<div style="font-size:10px;color:var(--t3);text-align:right;margin-top:4px">Last ${range}</div></div>`)}
      </div>`;
    }

    const charts = document.getElementById('ec2-charts');
    if (charts) {
      charts.innerHTML =
        metricPanel('CPU Usage', cpu, data.cpu || []) +
        memPanelR() +
        diskPanelR();
    }
  } catch (e) {
    console.error('EC2 range fetch error:', e);
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

function openEC2StatModal(filter) {
  const instances = (_m.ec2 || {}).instances || [];

  const FILTERS = {
    running:  { label: 'Running Instances',          fn: i => i.state === 'running' },
    stopped:  { label: 'Stopped Instances',          fn: i => i.state !== 'running' },
    eks:      { label: 'EKS Worker Nodes',           fn: i => i.is_eks_node },
    highcpu:  { label: 'High CPU Instances (≥80%)',  fn: i => i.state === 'running' && (i.metrics?.cpu_percent  || 0) >= 80 },
    highmem:  { label: 'High Memory Instances (≥80%)', fn: i => i.state === 'running' && (i.metrics?.mem_percent  || 0) >= 80 },
    highdisk: { label: 'High Disk Instances (≥85%)', fn: i => i.state === 'running' && (i.metrics?.disk_percent || 0) >= 85 },
    allcpu:   { label: 'CPU Utilization — All Instances',    fn: i => i.state === 'running' },
    allmem:   { label: 'Memory Utilization — All Instances', fn: i => i.state === 'running' },
    alldisk:  { label: 'Disk Utilization — All Instances',   fn: i => i.state === 'running' },
  };

  // Dynamic account filter: acct_<accountName>
  if (filter.startsWith('acct_')) {
    const acctName = filter.slice(5);
    FILTERS[filter] = {
      label: `${acctName} — All Instances`,
      fn: i => (i.account_name || '') === acctName,
    };
  }

  const { label, fn } = FILTERS[filter] || { label: filter, fn: () => true };
  let list = instances.filter(fn);
  // For account filters: running first, then stopped, then alphabetically by name
  if (filter.startsWith('acct_')) {
    list = [...list].sort((a, b) => {
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (a.state !== 'running' && b.state === 'running') return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  const overlay = document.getElementById('ec2-modal-overlay');
  const title   = document.getElementById('ec2-modal-title');
  const meta    = document.getElementById('ec2-modal-meta');
  const body    = document.getElementById('ec2-modal-body');
  if (!overlay) return;

  title.textContent = label;
  meta.innerHTML    = `${list.length} instance${list.length !== 1 ? 's' : ''}`;

  if (!list.length) {
    body.innerHTML = `<div style="text-align:center;padding:32px;color:var(--t3)">No instances match this filter.</div>`;
    overlay.style.display = 'flex';
    return;
  }

  const METRIC_COL = {
    highcpu:  i => { const v = i.metrics?.cpu_percent  || 0; return `<span style="color:${usageColor(v)};font-weight:600">${v}% CPU</span>`; },
    highmem:  i => { const v = i.metrics?.mem_percent  || 0; return `<span style="color:${usageColor(v)};font-weight:600">${v}% Mem</span>`; },
    highdisk: i => { const v = i.metrics?.disk_percent || 0; return `<span style="color:${usageColor(v)};font-weight:600">${v}% Disk</span>`; },
    allcpu:   i => { const v = i.metrics?.cpu_percent  || 0; return `<span style="color:${usageColor(v)};font-weight:600">${v}% CPU</span>`; },
    allmem:   i => { const v = i.metrics?.mem_percent  || 0; return `<span style="color:${usageColor(v)};font-weight:600">${v}% Mem</span>`; },
    alldisk:  i => { const v = i.metrics?.disk_percent || 0; return `<span style="color:${usageColor(v)};font-weight:600">${v}% Disk</span>`; },
  };
  const metricCol = METRIC_COL[filter];

  const SORT_KEY = {
    highcpu: 'cpu_percent', highmem: 'mem_percent', highdisk: 'disk_percent',
    allcpu:  'cpu_percent', allmem:  'mem_percent',  alldisk:  'disk_percent',
  };
  const sortKey = SORT_KEY[filter];
  const sorted = sortKey
    ? [...list].sort((a, b) => (b.metrics?.[sortKey] || 0) - (a.metrics?.[sortKey] || 0))
    : list;

  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid rgba(255,255,255,0.08)">
        <th style="text-align:left;font-size:11px;color:var(--t3);padding:6px 8px">Name</th>
        <th style="text-align:left;font-size:11px;color:var(--t3);padding:6px 8px">Account</th>
        <th style="text-align:left;font-size:11px;color:var(--t3);padding:6px 8px">Type</th>
        <th style="text-align:left;font-size:11px;color:var(--t3);padding:6px 8px">AZ</th>
        ${metricCol ? '<th style="text-align:left;font-size:11px;color:var(--t3);padding:6px 8px">Metric</th>' : ''}
        <th style="text-align:left;font-size:11px;color:var(--t3);padding:6px 8px">State</th>
      </tr></thead>
      <tbody>
        ${sorted.map(i => `
          <tr onclick="closeEC2Modal(null); openEC2InstanceModal('${esc(i.id)}')"
              style="cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04)"
              onmouseover="this.style.background='rgba(255,255,255,0.04)'"
              onmouseout="this.style.background=''">
            <td style="padding:8px">
              <div style="font-weight:500;font-size:13px">${esc(i.name)}</div>
              <div style="font-size:11px;color:var(--t3)">${esc(i.private_ip || '')}</div>
            </td>
            <td style="padding:8px;font-size:12px;color:${i.env_color||'var(--t2)'}">${esc(i.account_name || '—')}</td>
            <td style="padding:8px;font-size:12px;color:var(--t3)">${esc(i.type)}</td>
            <td style="padding:8px;font-size:11px;color:var(--t3)">${esc(i.az || '—')}</td>
            ${metricCol ? `<td style="padding:8px">${metricCol(i)}</td>` : ''}
            <td style="padding:8px">${stateBadge(i.state, i.metrics?.cpu_percent||0, i.metrics?.mem_percent||0, i.metrics?.disk_percent||0)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  overlay.style.display = 'flex';
}

function closeEC2Modal(e) {
  if (e && e.target !== document.getElementById('ec2-modal-overlay')) return;
  const overlay = document.getElementById('ec2-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

/* ── EKS ──────────────────────────────────────────────── */

// Helper: return 'ok' | 'warn' | 'crit' based on utilisation %
function utilColor(pct) {
  if (pct >= 80) return 'crit';
  if (pct >= 60) return 'warn';
  return 'ok';
}

// Global EKS state
let _eksData       = {};   // full eks payload — used by namespace modal
let _eksLiveTimer  = null; // interval handle for live node-metrics refresh

// ── NAMESPACE DETAIL MODAL ─────────────────────────────

function openPodListModal(filter) {
  const overlay = document.getElementById('ns-modal-overlay');
  const title   = document.getElementById('ns-modal-title');
  const meta    = document.getElementById('ns-modal-meta');
  const stats   = document.getElementById('ns-modal-stats');
  const body    = document.getElementById('ns-modal-body');
  if (!overlay) return;

  const allPods = _eksData.pods || [];
  const filters = {
    running:           { label: 'Running Pods',                   fn: p => p.phase === 'Running' },
    pending:           { label: 'Pending Pods',                   fn: p => p.phase === 'Pending' },
    failed:            { label: 'Failed Pods',                    fn: p => p.phase === 'Failed' },
    succeeded:         { label: 'Succeeded Pods',                 fn: p => p.phase === 'Succeeded' },
    oom:               { label: 'OOMKilled Pods',                 fn: p => p.oom_killed },
    pending_resources: { label: 'Pending — Insufficient Resources', fn: p => p.pending_reason && p.pending_reason.toLowerCase().includes('insufficient') },
  };
  const { label, fn } = filters[filter] || { label: 'Pods', fn: () => true };
  const pods = allPods.filter(fn);

  title.textContent = label;
  meta.textContent  = `${pods.length} pod${pods.length !== 1 ? 's' : ''}`;
  stats.innerHTML   = '';

  if (!pods.length) {
    body.innerHTML = '<div class="tr-load" style="padding:16px 0">No pods match this filter.</div>';
  } else {
    let podIdx = 0;
    body.innerHTML = pods.map(pod => {
      const idx        = podIdx++;
      const phaseColor = pod.phase === 'Running' ? 'ok' : pod.phase === 'Pending' ? 'warn' : pod.phase === 'Succeeded' ? 'ok' : 'crit';
      const oomBadge   = pod.oom_killed ? '<span class="badge crit" style="margin-left:6px">OOM</span>' : '';
      const restartBadge = pod.restarts >= 5
        ? `<span class="badge warn" style="margin-left:6px">${pod.restarts} restarts</span>`
        : pod.restarts > 0 ? `<span class="muted" style="font-size:11px;margin-left:6px">${pod.restarts} restarts</span>` : '';
      const actualCpuBadge = pod.actual_cpu_cores != null
        ? `<span class="tag info" style="margin-left:8px;font-size:10px">CPU ${pod.actual_cpu_cores} cores</span>` : '';
      const actualMemBadge = pod.actual_memory_mi != null
        ? `<span class="tag info" style="margin-left:4px;font-size:10px">Mem ${fmtMi(pod.actual_memory_mi)}</span>` : '';
      const pendingReason = pod.pending_reason
        ? `<div style="font-size:11px;color:var(--warn);margin-top:4px;padding-left:24px">${esc(pod.pending_reason)}</div>` : '';

      const ctrs = (pod.containers || []).map(c => {
        const cStatus  = c.ready ? '<span class="badge ok">ready</span>' : '<span class="badge warn">not ready</span>';
        const lastTerm = c.last_termination_reason
          ? `<span class="badge ${c.oom_killed ? 'crit' : 'warn'}" style="margin-left:4px">${esc(c.last_termination_reason)}</span>` : '';
        const cpuReq   = c.requests?.cpu_cores != null ? c.requests.cpu_cores + ' cores' : '—';
        const cpuLim   = c.limits?.cpu_cores > 0 ? c.limits.cpu_cores + ' cores' : 'no limit';
        const memReq    = c.requests?.memory_mi != null ? fmtMi(c.requests.memory_mi) : '—';
        const memLimMi  = c.limits?.memory_mi > 0 ? c.limits.memory_mi : 0;
        const memLim    = memLimMi > 0 ? fmtMi(memLimMi) : 'no limit';
        const memPct    = c.actual_memory_mi != null && memLimMi > 0 ? Math.round(c.actual_memory_mi / memLimMi * 100) : null;
        const memPctCls = memPct >= 90 ? 'crit' : memPct >= 80 ? 'warn' : 'ok';
        const actualCpu = c.actual_cpu_cores != null
          ? `<div style="font-size:10px;color:var(--info);margin-top:2px">actual: ${c.actual_cpu_cores} cores</div>` : '';
        const actualMem = c.actual_memory_mi != null
          ? memLimMi > 0
            ? `<div style="margin-top:4px"><div class="mini-bar"><div class="mini-track"><div class="mini-fill ${memPctCls}" style="width:${Math.min(memPct,100)}%"></div></div><span class="mini-pct" style="font-size:10px;color:var(--${memPctCls})">${memPct}%</span></div><div style="font-size:10px;color:var(--t3);margin-top:1px">${fmtMi(c.actual_memory_mi)} / ${fmtMi(memLimMi)}</div></div>`
            : `<div style="font-size:10px;color:var(--info);margin-top:2px">actual: ${fmtMi(c.actual_memory_mi)}</div>`
          : '';
        return `<tr>
          <td class="ctr-name" style="padding-left:24px">↳ ${esc(c.name)}${lastTerm}</td>
          <td>${cStatus}</td>
          <td>${c.restart_count || 0}</td>
          <td><div class="res-pair"><span class="res-req">${cpuReq}</span><span class="res-lim">limit: ${cpuLim}</span>${actualCpu}</div></td>
          <td><div class="res-pair"><span class="res-req">${memReq}</span><span class="res-lim">limit: ${memLim}</span>${actualMem}</div></td>
        </tr>`;
      }).join('');

      return `<div class="pod-group">
        <div class="pod-group-hdr" onclick="togglePodGroup(${idx})">
          <span class="pod-group-toggle" id="ptoggle-${idx}">▶</span>
          <span class="pod-group-name">${esc(pod.name)}</span>
          ${oomBadge}${restartBadge}${actualCpuBadge}${actualMemBadge}
          <span class="badge ${phaseColor}" style="margin-left:8px">${esc(pod.phase)}</span>
          <span class="muted" style="font-size:11px;margin-left:8px">${esc(pod.namespace)} · ${esc(pod.node||'—')}</span>
        </div>
        ${pendingReason}
        <table class="pod-ctr-table" id="pctrs-${idx}" style="display:none">
          <thead><tr><th>Container</th><th>Status</th><th>Restarts</th><th>CPU (req/limit)</th><th>Memory (req/limit)</th></tr></thead>
          <tbody>${ctrs}</tbody>
        </table>
      </div>`;
    }).join('');
  }

  overlay.classList.add('open');
  document.addEventListener('keydown', _nsModalKeyHandler);
}

function openPvcListModal(filter) {
  const overlay = document.getElementById('ns-modal-overlay');
  const title   = document.getElementById('ns-modal-title');
  const meta    = document.getElementById('ns-modal-meta');
  const stats   = document.getElementById('ns-modal-stats');
  const body    = document.getElementById('ns-modal-body');
  if (!overlay) return;

  const allPvcs = (_eksData.storage || {}).pvcs || [];
  const isNearFull = filter === 'near_full';
  const pvcs = isNearFull
    ? allPvcs.filter(p => p.pct_used != null && p.pct_used >= 80).sort((a, b) => b.pct_used - a.pct_used)
    : allPvcs.filter(p => p.status.toLowerCase() === filter.toLowerCase());
  const label = isNearFull ? 'PVCs Near Full (≥80%)' : filter.charAt(0).toUpperCase() + filter.slice(1);

  title.textContent = `${label}`;
  meta.textContent  = `${pvcs.length} PVC${pvcs.length !== 1 ? 's' : ''}`;
  stats.innerHTML   = '';

  if (!pvcs.length) {
    body.innerHTML = isNearFull
      ? `<div class="tr-load" style="padding:16px 0;color:var(--ok)">✓ All PVCs are below 80% capacity.</div>`
      : `<div class="tr-load" style="padding:16px 0">No ${filter} PVCs found.</div>`;
  } else {
    const rows = pvcs.map(p => {
      const statusColor = p.status === 'Bound' ? 'ok' : p.status === 'Pending' ? 'warn' : 'crit';
      const cap = p.capacity_gi != null ? p.capacity_gi.toFixed(1) + ' GiB' : '—';
      const usedStr = p.used_gi != null ? p.used_gi.toFixed(1) + ' GiB used' : '';
      const availStr = p.available_gi != null ? p.available_gi.toFixed(1) + ' GiB free' : '';
      const fillCls = p.pct_used >= 90 ? 'crit' : p.pct_used >= 80 ? 'warn' : p.pct_used >= 70 ? 'warn' : 'ok';
      const usage = p.pct_used != null
        ? `<div style="display:flex;align-items:center;gap:8px">
             <div class="util-track" style="width:100px;display:inline-block">
               <div class="util-fill ${fillCls}" style="width:${Math.min(p.pct_used,100)}%"></div>
             </div>
             <span style="font-weight:600;color:var(--${fillCls})">${p.pct_used.toFixed(1)}%</span>
             ${usedStr ? `<span class="muted" style="font-size:11px">${usedStr}${availStr ? ' · ' + availStr : ''}</span>` : ''}
           </div>`
        : '<span class="muted">No usage data</span>';
      return `<tr>
        <td><strong>${esc(p.name)}</strong></td>
        <td><span class="mono" style="font-size:11px">${esc(p.namespace)}</span></td>
        <td class="muted" style="font-size:11px">${esc(p.storage_class || '—')}</td>
        <td>${cap}</td>
        <td>${usage}</td>
        <td><span class="badge ${statusColor}">${esc(p.status)}</span></td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <table class="dt">
        <thead><tr><th>PVC</th><th>Namespace</th><th>Storage Class</th><th>Capacity</th><th>Disk Usage</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  overlay.classList.add('open');
  document.addEventListener('keydown', _nsModalKeyHandler);
}

function openUtilBreakdownModal(metric) {
  const overlay = document.getElementById('ns-modal-overlay');
  const title   = document.getElementById('ns-modal-title');
  const meta    = document.getElementById('ns-modal-meta');
  const stats   = document.getElementById('ns-modal-stats');
  const body    = document.getElementById('ns-modal-body');
  if (!overlay) return;

  const isCpu  = metric === 'cpu';
  const cu     = (_eksData.cluster_utilization || {});
  const nsMap  = _eksData.namespaces || {};

  // Build sorted namespace list
  const nsList = Object.entries(nsMap).map(([ns, d]) => ({
    name:     ns,
    value:    isCpu ? (d.total_cpu_requested_cores || 0) : (d.total_memory_requested_mi || 0),
    running:  d.running || 0,
    oomKills: d.oom_killed_containers || 0,
  })).filter(n => n.value > 0).sort((a, b) => b.value - a.value);

  const total = isCpu
    ? (cu.cpu_actual_cores ?? cu.cpu_requested_cores ?? 0)
    : (cu.mem_actual_mi   ?? cu.mem_requested_mi   ?? 0);
  const allocatable = isCpu ? (cu.cpu_allocatable_cores || 0) : (cu.mem_allocatable_mi || 0);
  const pct  = allocatable ? Math.round(total / allocatable * 100) : 0;
  const mode = isCpu
    ? (cu.cpu_actual_cores != null ? 'actual' : 'requested')
    : (cu.mem_actual_mi   != null ? 'actual' : 'requested');

  title.textContent = isCpu ? 'CPU Utilization Breakdown' : 'Memory Utilization Breakdown';
  meta.textContent  = `${pct}% of allocatable (${mode}) · ${nsList.length} active namespaces`;
  stats.innerHTML   = '';

  if (!nsList.length) {
    body.innerHTML = '<div class="tr-load" style="padding:16px 0">No namespace data available.</div>';
  } else {
    const maxVal = nsList[0].value;
    const rows = nsList.map((n, i) => {
      const barPct  = maxVal ? Math.round(n.value / maxVal * 100) : 0;
      const ofTotal = total  ? Math.round(n.value / total * 100)  : 0;
      const valStr  = isCpu ? n.value.toFixed(2) + ' cores' : fmtMi(n.value);
      const color   = ofTotal >= 40 ? 'crit' : ofTotal >= 20 ? 'warn' : 'ok';
      const oomBadge = n.oomKills > 0
        ? `<span class="badge crit" style="margin-left:6px;font-size:10px">${n.oomKills} OOM</span>` : '';
      return `<tr>
        <td style="font-weight:500">${esc(n.name)}${oomBadge}</td>
        <td style="min-width:140px">
          <div class="util-track" style="width:120px;display:inline-block;vertical-align:middle">
            <div class="util-fill ${color}" style="width:${barPct}%"></div>
          </div>
        </td>
        <td style="font-variant-numeric:tabular-nums">${valStr}</td>
        <td class="muted" style="font-size:11px">${ofTotal}% of total</td>
        <td class="muted" style="font-size:11px">${n.running} pods</td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <table class="dt">
        <thead><tr><th>Namespace</th><th>Share</th><th>${isCpu ? 'CPU' : 'Memory'} (${mode})</th><th>% of Total</th><th>Running Pods</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  overlay.classList.add('open');
  document.addEventListener('keydown', _nsModalKeyHandler);
}

function openNodeModal(nodeName) {
  const overlay = document.getElementById('ns-modal-overlay');
  const title   = document.getElementById('ns-modal-title');
  const meta    = document.getElementById('ns-modal-meta');
  const stats   = document.getElementById('ns-modal-stats');
  const body    = document.getElementById('ns-modal-body');
  if (!overlay) return;

  // ── Header ───────────────────────────────────────────────
  const node = (_eksData.nodes || []).find(n => n.name === nodeName) || {};
  title.textContent = nodeName;
  meta.textContent  = [node.instance_type, node.zone].filter(Boolean).join(' · ') || '—';

  // ── Stats bar ────────────────────────────────────────────
  const hasActual  = node.actual_cpu_pct != null;
  const cpuPct     = hasActual ? node.actual_cpu_pct    : (node.cpu_requested_pct ?? 0);
  const memPct     = hasActual ? node.actual_memory_pct : (node.mem_requested_pct ?? 0);
  const cpuSub     = hasActual
    ? `${(node.actual_cpu_cores||0).toFixed(2)} / ${node.allocatable?.cpu_cores||'?'} cores (actual)`
    : `${(node.cpu_requested_cores||0).toFixed(2)} / ${node.allocatable?.cpu_cores||'?'} cores (requested)`;
  const memSub     = hasActual
    ? `${fmtMi(node.actual_memory_mi||0)} / ${fmtMi(node.allocatable?.memory_mi||0)} (actual)`
    : `${fmtMi(node.mem_requested_mi||0)} / ${fmtMi(node.allocatable?.memory_mi||0)} (requested)`;
  const pressure   = node.pressure || {};
  const pressureFlags = [
    pressure.memory_pressure ? 'Mem'  : null,
    pressure.disk_pressure   ? 'Disk' : null,
    pressure.pid_pressure    ? 'PID'  : null,
  ].filter(Boolean);
  const pressureHtml = pressureFlags.length
    ? pressureFlags.map(f => `<span class="badge warn">${f}</span>`).join(' ')
    : '<span class="badge ok">No pressure</span>';
  const statusBadge = node.status === 'ready'
    ? '<span class="badge ok">Ready</span>'
    : '<span class="badge crit">Not Ready</span>';

  stats.innerHTML = `
    <div class="ns-mstat" style="margin-left:auto">${miniBar(cpuPct, cpuSub)}<div class="ns-mstat-l" style="margin-top:4px">CPU</div></div>
    <div class="ns-mstat">${miniBar(memPct, memSub)}<div class="ns-mstat-l" style="margin-top:4px">Memory</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v">${pressureHtml}</div><div class="ns-mstat-l">Pressure</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v">${statusBadge}</div><div class="ns-mstat-l">Status</div></div>`;

  // ── Pods on this node grouped by namespace ────────────────
  const nodePods = (_eksData.pods || []).filter(p => p.node === nodeName);

  // Group by namespace
  const nsByPods = {};
  for (const pod of nodePods) {
    if (!nsByPods[pod.namespace]) nsByPods[pod.namespace] = [];
    nsByPods[pod.namespace].push(pod);
  }

  if (!Object.keys(nsByPods).length) {
    body.innerHTML = '<div class="tr-load" style="padding:16px 0">No pods running on this node.</div>';
  } else {
    let podIdx = 0;
    body.innerHTML = Object.entries(nsByPods).sort(([a],[b]) => a.localeCompare(b)).map(([ns, pods]) => {
      const running  = pods.filter(p => p.phase === 'Running').length;
      const pending  = pods.filter(p => p.phase === 'Pending').length;
      const failed   = pods.filter(p => p.phase === 'Failed').length;

      const podRows = pods.map(pod => {
        const idx        = podIdx++;
        const phaseColor = pod.phase === 'Running' ? 'ok' : pod.phase === 'Pending' ? 'warn' : 'crit';
        const oomBadge   = pod.oom_killed ? '<span class="badge crit" style="margin-left:6px">OOM</span>' : '';
        const restartBadge = pod.restarts >= 5
          ? `<span class="badge warn" style="margin-left:6px">${pod.restarts} restarts</span>`
          : pod.restarts > 0
            ? `<span class="muted" style="font-size:11px;margin-left:6px">${pod.restarts} restarts</span>`
            : '';
        const actualCpuBadge = pod.actual_cpu_cores != null
          ? `<span class="tag info" style="margin-left:8px;font-size:10px">CPU ${pod.actual_cpu_cores} cores</span>` : '';
        const actualMemBadge = pod.actual_memory_mi != null
          ? `<span class="tag info" style="margin-left:4px;font-size:10px">Mem ${fmtMi(pod.actual_memory_mi)}</span>` : '';

        const ctrs = (pod.containers || []).map(c => {
          const cStatus  = c.ready ? '<span class="badge ok">ready</span>' : '<span class="badge warn">not ready</span>';
          const lastTerm = c.last_termination_reason
            ? `<span class="badge ${c.oom_killed ? 'crit' : 'warn'}" style="margin-left:4px">${esc(c.last_termination_reason)}</span>`
            : '';
          const cpuReq    = c.requests?.cpu_cores != null ? c.requests.cpu_cores + ' cores' : '—';
          const cpuLim    = c.limits?.cpu_cores > 0 ? c.limits.cpu_cores + ' cores' : 'no limit';
          const memReq    = c.requests?.memory_mi != null ? fmtMi(c.requests.memory_mi) : '—';
          const memLimMi  = c.limits?.memory_mi > 0 ? c.limits.memory_mi : 0;
          const memLim    = memLimMi > 0 ? fmtMi(memLimMi) : 'no limit';
          const memPct    = c.actual_memory_mi != null && memLimMi > 0 ? Math.round(c.actual_memory_mi / memLimMi * 100) : null;
          const memPctCls = memPct >= 90 ? 'crit' : memPct >= 80 ? 'warn' : 'ok';
          const actualCpu = c.actual_cpu_cores != null
            ? `<div style="font-size:10px;color:var(--info);margin-top:2px">actual: ${c.actual_cpu_cores} cores</div>` : '';
          const actualMem = c.actual_memory_mi != null
            ? memLimMi > 0
              ? `<div style="margin-top:4px"><div class="mini-bar"><div class="mini-track"><div class="mini-fill ${memPctCls}" style="width:${Math.min(memPct,100)}%"></div></div><span class="mini-pct" style="font-size:10px;color:var(--${memPctCls})">${memPct}%</span></div><div style="font-size:10px;color:var(--t3);margin-top:1px">${fmtMi(c.actual_memory_mi)} / ${fmtMi(memLimMi)}</div></div>`
              : `<div style="font-size:10px;color:var(--info);margin-top:2px">actual: ${fmtMi(c.actual_memory_mi)}</div>`
            : '';
          return `<tr>
            <td class="ctr-name" style="padding-left:24px">↳ ${esc(c.name)}${lastTerm}</td>
            <td>${cStatus}</td>
            <td>${c.restart_count || 0}</td>
            <td><div class="res-pair"><span class="res-req">${cpuReq}</span><span class="res-lim">limit: ${cpuLim}</span>${actualCpu}</div></td>
            <td><div class="res-pair"><span class="res-req">${memReq}</span><span class="res-lim">limit: ${memLim}</span>${actualMem}</div></td>
          </tr>`;
        }).join('');

        return `<div class="pod-group">
          <div class="pod-group-hdr" onclick="togglePodGroup(${idx})">
            <span class="pod-group-toggle" id="ptoggle-${idx}">▶</span>
            <span class="pod-group-name">${esc(pod.name)}</span>
            ${oomBadge}${restartBadge}${actualCpuBadge}${actualMemBadge}
            <span class="badge ${phaseColor}" style="margin-left:8px">${esc(pod.phase)}</span>
            <span class="muted" style="font-size:11px;margin-left:8px">${pod.ready}/${pod.total_containers} ready</span>
          </div>
          <table class="pod-ctr-table" id="pctrs-${idx}" style="display:none">
            <thead><tr><th>Container</th><th>Status</th><th>Restarts</th><th>CPU (req/limit)</th><th>Memory (req/limit)</th></tr></thead>
            <tbody>${ctrs}</tbody>
          </table>
        </div>`;
      }).join('');

      // ── PVCs for this namespace ──────────────────────────────
      const nsPvcs = ((_eksData.storage || {}).by_namespace || {})[ns] || [];
      let pvcHtml = '';
      if (nsPvcs.length) {
        const pvcRows = nsPvcs.map(p => {
          const statusCls = p.status === 'Bound' ? 'ok' : p.status === 'Lost' ? 'crit' : 'warn';
          const capStr    = p.capacity_gi > 0 ? p.capacity_gi.toFixed(1) + ' GiB' : '—';
          let usageCell;
          if (p.pct_used != null) {
            const uCls    = p.pct_used >= 85 ? 'crit' : p.pct_used >= 70 ? 'warn' : 'ok';
            const usedStr = p.used_gi      != null ? p.used_gi.toFixed(2)      + ' GiB used' : '';
            const avlStr  = p.available_gi != null ? p.available_gi.toFixed(2) + ' GiB free' : '';
            usageCell = `<div class="mini-bar">
              <div class="mini-track"><div class="mini-fill ${uCls}" style="width:${Math.min(p.pct_used,100)}%"></div></div>
              <span class="mini-pct">${p.pct_used.toFixed(1)}%</span>
            </div><div style="font-size:10px;color:var(--t3);margin-top:2px">${usedStr}${usedStr&&avlStr?' · ':''}${avlStr}</div>`;
          } else {
            usageCell = `<span class="muted" style="font-size:11px">${capStr}</span>`;
          }
          return `<tr>
            <td style="font-weight:500;padding-left:12px">${esc(p.name)}</td>
            <td class="muted" style="font-size:11px">${esc(p.storage_class||'—')}</td>
            <td>${usageCell}</td>
            <td><span class="badge ${statusCls}">${esc(p.status)}</span></td>
          </tr>`;
        }).join('');
        pvcHtml = `<div style="margin-top:10px;margin-bottom:4px">
          <div style="font-size:11px;font-weight:600;color:var(--t2);margin-bottom:6px">◧ PVCs (${nsPvcs.length})</div>
          <table class="pod-ctr-table" style="display:table">
            <thead><tr><th>PVC</th><th>Storage Class</th><th>Disk Usage</th><th>Status</th></tr></thead>
            <tbody>${pvcRows}</tbody>
          </table>
        </div>`;
      }

      // ── Quota pressure for this namespace ───────────────────
      const nsData = (_eksData.namespaces || {})[ns] || {};
      let maxQuotaPct = 0;
      let quotaDetail = '';
      for (const quota of (nsData.resource_quotas || [])) {
        for (const entry of (quota.entries || [])) {
          if (entry.pct_used != null && entry.pct_used > maxQuotaPct) {
            maxQuotaPct = entry.pct_used;
            quotaDetail = `${entry.resource}: ${entry.used}/${entry.hard} (${entry.pct_used}%)`;
          }
        }
      }
      const quotaBadge = maxQuotaPct >= 100
        ? `<span class="badge crit" title="${esc(quotaDetail)}">Quota exceeded</span>`
        : maxQuotaPct >= 80
          ? `<span class="badge warn" title="${esc(quotaDetail)}">Quota ${maxQuotaPct.toFixed(0)}%</span>`
          : '';

      return `<div style="margin-bottom:20px">
        <div style="font-size:12px;font-weight:600;color:var(--t2);margin-bottom:8px;display:flex;align-items:center;gap:8px">
          ⬡ ${esc(ns)}
          ${running  ? `<span class="badge ok">${running} running</span>`   : ''}
          ${pending  ? `<span class="badge warn">${pending} pending</span>` : ''}
          ${failed   ? `<span class="badge crit">${failed} failed</span>`   : ''}
          ${quotaBadge}
        </div>
        ${podRows}
        ${pvcHtml}
      </div>`;
    }).join('');
  }

  overlay.classList.add('open');
  document.addEventListener('keydown', _nsModalKeyHandler);
}

function togglePodGroup(idx) {
  const table  = document.getElementById('pctrs-' + idx);
  const toggle = document.getElementById('ptoggle-' + idx);
  if (!table) return;
  const isOpen = table.style.display !== 'none';
  table.style.display = isOpen ? 'none' : 'table';
  if (toggle) toggle.classList.toggle('open', !isOpen);
}

function closeNsModal(e) {
  if (e && e.target !== document.getElementById('ns-modal-overlay')) return;
  const overlay = document.getElementById('ns-modal-overlay');
  if (overlay) overlay.classList.remove('open');
  document.removeEventListener('keydown', _nsModalKeyHandler);
}

function _nsModalKeyHandler(e) {
  if (e.key === 'Escape') closeNsModal();
}

// Build a single namespace table row (used by both render and filter)

// Helper: render an inline mini progress bar cell
function miniBar(pct, allocText) {
  const cls = utilColor(pct);
  return `<div class="mini-bar">
    <div class="mini-track"><div class="mini-fill ${cls}" style="width:${Math.min(pct,100)}%"></div></div>
    <span class="mini-pct">${pct != null ? pct.toFixed(1)+'%' : '—'}</span>
  </div><div style="font-size:10px;color:var(--t3);margin-top:2px">${allocText}</div>`;
}

function patchEKSNodeMetrics() {
  fetch('/api/eks/nodes/live')
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(data => {
      if (!data || !data.nodes) return;
      const ntbody = document.getElementById('eks-nodes-tbody');
      if (!ntbody) return;
      Object.entries(data.nodes).forEach(([nodeName, live]) => {
        const row = ntbody.querySelector(`tr[data-node="${CSS.escape(nodeName)}"]`);
        if (!row) return;
        const alloc = (_eksData.nodes || []).find(n => n.name === nodeName)?.allocatable || {};
        const cpuAlloc = alloc.cpu_cores != null ? alloc.cpu_cores + ' cores' : '?';
        const memAlloc = alloc.memory_mi  != null ? fmtMi(alloc.memory_mi)    : '?';
        const cpuLabel = `${(live.actual_cpu_cores||0).toFixed(2)} / ${cpuAlloc} (actual)`;
        const memLabel = `${fmtMi(live.actual_memory_mi||0)} / ${memAlloc} (actual)`;
        const cpuCell = row.querySelector('.eks-node-cpu');
        const memCell = row.querySelector('.eks-node-mem');
        if (cpuCell) cpuCell.innerHTML = miniBar(live.actual_cpu_pct, cpuLabel);
        if (memCell) memCell.innerHTML = miniBar(live.actual_memory_pct, memLabel);
        // Keep _eksData in sync so openNodeModal sees fresh values
        const node = (_eksData.nodes || []).find(n => n.name === nodeName);
        if (node) {
          node.actual_cpu_cores  = live.actual_cpu_cores;
          node.actual_memory_mi  = live.actual_memory_mi;
          node.actual_cpu_pct    = live.actual_cpu_pct;
          node.actual_memory_pct = live.actual_memory_pct;
        }
      });
    });
}

function startEKSLiveRefresh() {
  patchEKSNodeMetrics();
  if (_eksLiveTimer) clearInterval(_eksLiveTimer);
  _eksLiveTimer = setInterval(patchEKSNodeMetrics, 15000);
}

function stopEKSLiveRefresh() {
  if (_eksLiveTimer) { clearInterval(_eksLiveTimer); _eksLiveTimer = null; }
}

function renderEKS(eks) {
  // ── Cluster utilization gauges ────────────────────────────
  const cu = eks.cluster_utilization || {};

  function setGauge(pctId, barId, subId, pct, subText) {
    const el    = document.getElementById(pctId);
    const bar   = document.getElementById(barId);
    const sub   = document.getElementById(subId);
    const cls   = utilColor(pct || 0);
    if (el)  { el.textContent  = pct != null ? pct.toFixed(1) + '%' : '—'; el.className = 'util-gauge-pct ' + cls; }
    if (bar) { bar.style.width = Math.min(pct || 0, 100) + '%'; bar.className = 'util-fill ' + cls; }
    if (sub) { sub.textContent = subText; }
  }

  const hasActualCluster = cu.cpu_actual_pct != null;
  setGauge(
    'util-cpu-pct', 'util-cpu-bar', 'util-cpu-sub',
    hasActualCluster ? cu.cpu_actual_pct : cu.cpu_requested_pct,
    hasActualCluster
      ? `${cu.cpu_actual_cores} / ${cu.cpu_allocatable_cores} cores (actual)`
      : (cu.cpu_requested_cores != null ? `${cu.cpu_requested_cores} / ${cu.cpu_allocatable_cores} cores (requested)` : 'requested / allocatable')
  );
  setGauge(
    'util-mem-pct', 'util-mem-bar', 'util-mem-sub',
    hasActualCluster ? cu.mem_actual_pct : cu.mem_requested_pct,
    hasActualCluster
      ? `${fmtMi(cu.mem_actual_mi)} / ${fmtMi(cu.mem_allocatable_mi)} (actual)`
      : (cu.mem_requested_mi != null ? `${fmtMi(cu.mem_requested_mi)} / ${fmtMi(cu.mem_allocatable_mi)} (requested)` : 'requested / allocatable')
  );

  // Storage gauge — show total provisioned GiB (no hard cap, so use relative fill)
  const st = eks.storage || {};
  const totalGi = st.total_provisioned_gi || 0;
  const pvcEl   = document.getElementById('util-storage-pct');
  const pvcBar  = document.getElementById('util-storage-bar');
  const pvcSub  = document.getElementById('util-storage-sub');
  if (pvcEl)  pvcEl.textContent  = totalGi > 0 ? totalGi.toFixed(1) + ' GiB' : '—';
  if (pvcSub) pvcSub.textContent = `${st.total || 0} PVC${(st.total||0)!==1?'s':''} provisioned`;
  // Use bound% as the fill — more Bound = healthier
  const boundPct = st.total ? Math.round((st.bound || 0) / st.total * 100) : 0;
  if (pvcBar) { pvcBar.style.width = boundPct + '%'; pvcBar.className = 'util-fill ok'; }
  ['bound', 'pending', 'lost'].forEach(status => {
    const el = document.getElementById(`util-storage-${status}`);
    if (!el) return;
    const count = st[status] || 0;
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    el.textContent  = `${count} ${label}`;
    el.style.cursor = 'pointer';
    el.title        = `Show ${status} PVCs`;
    el.onclick      = () => openPvcListModal(status);
  });

  // ── KPI stats ─────────────────────────────────────────────
  setText('po-run',      eks.running_pods   ?? '—');
  setText('po-pend',     eks.pending_pods   ?? '—');
  setText('po-fail',     eks.failed_pods    ?? '—');
  setText('po-succ',     eks.succeeded_pods ?? '—');
  setText('po-total',    eks.total_pods     ?? '—');
  setText('po-nodes',    eks.ready_nodes    != null ? `${eks.ready_nodes}/${eks.total_nodes}` : '—');
  setText('po-oom',      eks.oom_killed_pods ?? '—');
  setText('po-pressure', eks.nodes_under_pressure ?? '—');
  setText('po-pend-res', eks.pending_insufficient_resource_pods ?? '—');
  setText('po-pvc-full', eks.pvc_near_full ?? '—');

  setColor('po-oom',      (eks.oom_killed_pods || 0) > 0 ? 'crit' : 'ok');
  setColor('po-pressure', (eks.nodes_under_pressure || 0) > 0 ? 'warn' : 'ok');
  setColor('po-pend-res', (eks.pending_insufficient_resource_pods || 0) > 0 ? 'crit' : 'ok');
  setColor('po-pvc-full', (eks.pvc_near_full || 0) > 0 ? 'crit' : 'ok');

  // ── Nodes table (with CPU/Mem utilization mini-bars) ──────
  const nodes  = eks.nodes || [];
  const ntbody = document.getElementById('eks-nodes');
  if (ntbody) {
    ntbody.innerHTML = !nodes.length
      ? '<tr><td colspan="7" class="tr-load">No node data.</td></tr>'
      : nodes.map(n => {
          const p = n.pressure || {};
          const pressureFlags = [
            p.memory_pressure ? 'Mem'  : null,
            p.disk_pressure   ? 'Disk' : null,
            p.pid_pressure    ? 'PID'  : null,
          ].filter(Boolean);
          const pressureCell = pressureFlags.length
            ? pressureFlags.map(f => `<span class="badge warn">${f}</span>`).join(' ')
            : '<span class="muted">—</span>';
          const cpuAlloc = n.allocatable?.cpu_cores != null ? n.allocatable.cpu_cores + ' cores' : '';
          const memAlloc = n.allocatable?.memory_mi != null ? fmtMi(n.allocatable.memory_mi) : '';
          const hasActual = n.actual_cpu_pct != null;
          const cpuPct    = hasActual ? n.actual_cpu_pct    : n.cpu_requested_pct;
          const memPct    = hasActual ? n.actual_memory_pct : n.mem_requested_pct;
          const cpuLabel  = hasActual
            ? `${(n.actual_cpu_cores||0).toFixed(2)} / ${cpuAlloc || '?'} (actual)`
            : (cpuAlloc ? `${(n.cpu_requested_cores||0).toFixed(2)} / ${cpuAlloc} (requested)` : '—');
          const memLabel  = hasActual
            ? `${fmtMi(n.actual_memory_mi||0)} / ${memAlloc || '?'} (actual)`
            : (memAlloc ? `${fmtMi(n.mem_requested_mi||0)} / ${memAlloc} (requested)` : '—');
          return `<tr class="ns-clickable" style="cursor:pointer" onclick="openNodeModal('${esc(n.name)}')" data-node="${esc(n.name)}">
            <td style="font-weight:500">${esc(n.name)}</td>
            <td class="muted">${esc(n.instance_type||'—')}</td>
            <td class="muted">${esc(n.zone||'—')}</td>
            <td class="eks-node-cpu">${miniBar(cpuPct, cpuLabel)}</td>
            <td class="eks-node-mem">${miniBar(memPct, memLabel)}</td>
            <td>${pressureCell}</td>
            <td>${n.status==='ready'
              ? '<span class="badge ok">ready</span>'
              : '<span class="badge crit">not ready</span>'}</td>
          </tr>`;
        }).join('');
  }

  // ── Cluster version banner ────────────────────────────────
  const versionBar   = document.getElementById('eks-version-bar');
  const versionBadge = document.getElementById('eks-version-badge');
  const versionHint  = document.getElementById('eks-version-hint');
  if (versionBar && eks.server_version) {
    const raw   = eks.server_version;           // e.g. "v1.33"
    const minor = parseInt((raw.match(/\.(\d+)/) || [])[1] || '0', 10);
    // EKS standard support: ~14 months per minor version.
    // Approximate EOL minor versions known at build time; flag anything ≤ this as EOL.
    const EOL_MINOR = 29;   // 1.29 reached EOL July 2025
    const WARN_MINOR = 31;  // 1.31 reaches EOL ~March 2026
    let hintHtml = '';
    if (minor <= EOL_MINOR) {
      hintHtml = `<span class="badge crit" style="font-size:11px">End of support — upgrade recommended</span>`;
    } else if (minor <= WARN_MINOR) {
      hintHtml = `<span class="badge warn" style="font-size:11px">Support ending soon — plan upgrade</span>`;
    } else {
      hintHtml = `<span class="badge ok"  style="font-size:11px">Supported</span>`;
    }
    versionBadge.textContent = raw;
    versionHint.innerHTML    = hintHtml;
    versionBar.style.display = 'flex';
  } else if (versionBar) {
    versionBar.style.display = 'none';
  }

  // Store full payload so the modal can access pods on node click
  _eksData = eks;

  // Kick off live Prometheus refresh (15s cadence) now that the table is rendered
  startEKSLiveRefresh();
}

/* ── UPTIME ───────────────────────────────────────────── */
let _uptimeServices = [];
let _uptimeFiltered = [];
let _uptimeSelectedIdx = 0;

function renderUptime(services, up) {
  _uptimeServices = services || [];
  _uptimeFiltered = _uptimeServices.slice();

  // ── KPIs ────────────────────────────────────────────────
  const maintCount  = (up?.maintenance)  ?? services.filter(s => s.status === 'maintenance').length;
  const upCount     = (up?.up)           ?? services.filter(s => s.status === 'up').length;
  const downCount   = (up?.down)         ?? services.filter(s => ['down','timeout','server_error'].includes(s.status)).length;
  const sslExpiring = (up?.ssl_expiring) ?? services.filter(s => s.ssl?.days_remaining != null && s.ssl?.days_remaining < 30).length;
  // Weighted average: exclude maintenance services (their history_daily already omits maintenance probes)
  let _wtTotalChk = 0, _wtTotalUp = 0;
  services.forEach(s => {
    if (s.in_maintenance) return;
    (s.history_daily || []).forEach(d => {
      if (d.checks > 0 && d.uptime_pct != null) {
        _wtTotalChk += d.checks;
        _wtTotalUp  += d.checks * (d.uptime_pct / 100);
      }
    });
  });
  const avgUptime = _wtTotalChk > 0 ? (_wtTotalUp / _wtTotalChk * 100).toFixed(2) : null;

  setText('ut-up',           upCount);
  setText('ut-down',         downCount);
  setText('ut-maint',        maintCount);
  setText('ut-ssl-expiring', sslExpiring);
  setText('ut-avg-uptime',   avgUptime != null ? avgUptime + '%' : '—');
  setText('ut-up-sub',       `${services.length} services monitored`);
  setColor('ut-down',        downCount > 0 ? 'crit' : 'ok');
  setColor('ut-ssl-expiring', sslExpiring > 0 ? 'warn' : 'ok');

  const listEl = document.getElementById('ut-service-list');
  if (!listEl) return;

  if (!services.length) {
    listEl.innerHTML = `<div class="ut-empty" style="padding:20px;font-size:12px;color:var(--t3)">No monitors found. Ensure <code>UPTIME_KUMA_URL</code> and <code>UPTIME_KUMA_API_KEY</code> are configured and Uptime Kuma's Prometheus endpoint is enabled.</div>`;
    return;
  }

  // Render source badge
  const srcEl = document.getElementById('ut-source-badge');
  if (srcEl) {
    const kumaUrl = up?.kuma_url || '';
    srcEl.innerHTML = kumaUrl
      ? `Monitored via <a href="${esc(kumaUrl)}" target="_blank" rel="noopener"
           style="color:var(--info);text-decoration:none;font-weight:500">Uptime Kuma ↗</a>`
      : '';
  }

  renderUptimeServiceList();
  selectUptimeService(0);
  renderUptimeQuarterlyCards();
  renderUptimeMonthlyCards();
}

function renderUptimeQuarterlyCards() {
  const container = document.getElementById('ut-quarterly-cards');
  if (!container) return;

  // Aggregate each quarter across all services (weighted avg uptime)
  const qMeta  = {};   // key → {label, months}
  const qStats = {};   // key → {totalChk, totalUp}

  _uptimeServices.forEach(svc => {
    (svc.history_quarterly || []).forEach(q => {
      if (!qMeta[q.quarter])  qMeta[q.quarter]  = { label: q.label, months: q.months };
      if (!qStats[q.quarter]) qStats[q.quarter]  = { totalChk: 0, totalUp: 0 };
      if (q.checks > 0 && q.uptime_pct != null) {
        qStats[q.quarter].totalChk += q.checks;
        qStats[q.quarter].totalUp  += q.checks * (q.uptime_pct / 100);
      }
    });
  });

  const now         = new Date();
  const currentYear = now.getFullYear();
  // Only show current-year quarters that have already started
  const keys = Object.keys(qMeta).sort().filter(key => {
    const [yearStr, qStr] = key.split('-Q');
    const year   = parseInt(yearStr, 10);
    if (year !== currentYear) return false;
    const qStart = new Date(year, (parseInt(qStr, 10) - 1) * 3, 1);
    return qStart <= now;
  });
  if (!keys.length) { container.innerHTML = ''; return; }

  container.innerHTML = keys.map(key => {
    const { label, months } = qMeta[key];
    const { totalChk, totalUp } = qStats[key];
    const pct    = totalChk > 0 ? totalUp / totalChk * 100 : null;
    const pctStr = pct != null ? pct.toFixed(1) + '%' : '—';
    const color  = pct == null ? 'var(--t3)' : pct >= 99.9 ? '#4ade80' : pct >= 99 ? '#fbbf24' : '#ef5350';
    return `<div onclick="openReport('${key}')" style="
        background:var(--bg2);border:1px solid rgba(129,140,248,0.25);border-radius:10px;
        padding:14px 16px;cursor:pointer;display:flex;flex-direction:column;gap:8px;
        transition:border-color .15s,background .15s;flex:1;min-width:160px;max-width:260px"
        onmouseover="this.style.borderColor='rgba(129,140,248,0.55)';this.style.background='var(--bg3)'"
        onmouseout="this.style.borderColor='rgba(129,140,248,0.25)';this.style.background='var(--bg2)'">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--info)">${esc(label)}</span>
        <span style="font-size:10px;color:var(--t3)">${esc(months)}</span>
      </div>
      <div style="font-size:26px;font-weight:700;color:${color};line-height:1">${pctStr}</div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:10px;color:var(--t3)">Avg uptime</span>
        <span style="font-size:10px;color:rgba(129,140,248,0.65)">Export ↗</span>
      </div>
    </div>`;
  }).join('');

  renderUptimeQuarterlyGroups();
}

function _domainGroup(url) {
  const host = (url || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  if (host.endsWith('.lg-apps.com') || host === 'lg-apps.com') return 'Living Goods Instances';
  if (host.endsWith('.go.ke')  || host === 'go.ke')            return 'MoH Kenya';
  if (host.endsWith('.go.ug')  || host === 'go.ug')            return 'MoH Uganda';
  if (host.endsWith('.gov.bf') || host === 'gov.bf' ||
      host.endsWith('.minsante.bf') || host === 'minsante.bf') return 'Burkina Faso';
  return null;
}

function renderUptimeQuarterlyGroups() {
  const container = document.getElementById('ut-quarterly-groups');
  if (!container) return;

  const pgData = (_m.uptime || {}).quarterly_by_region;
  if (!pgData) { container.innerHTML = ''; return; }

  const { groups, quarters } = pgData;
  if (!quarters || !quarters.length) { container.innerHTML = ''; return; }

  const GROUP_ORDER = ['Living Goods Instances', 'MoH Kenya', 'MoH Uganda', 'Burkina Faso'];
  const colW = `${Math.floor(80 / quarters.length)}%`;

  const rows = GROUP_ORDER.map(group => {
    const gData = groups[group] || {};
    const cells = quarters.map(q => {
      const s   = gData[q.quarter];
      const pct = s ? s.uptime_pct : null;
      const str = pct != null ? pct.toFixed(1) + '%' : '—';
      const col = pct == null ? 'var(--t3)' : pct >= 99.9 ? '#4ade80' : pct >= 99 ? '#fbbf24' : '#ef5350';
      return `<td style="text-align:right;padding:7px 12px;font-size:13px;font-weight:600;color:${col};width:${colW}">${str}</td>`;
    }).join('');
    return `<tr style="border-bottom:1px solid var(--card-border)">
      <td style="padding:7px 12px;font-size:12px;font-weight:500;color:var(--t1);white-space:nowrap">${esc(group)}</td>
      ${cells}
    </tr>`;
  }).join('');

  const headers = quarters.map(q =>
    `<th style="text-align:right;padding:6px 12px;font-size:10px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--info);width:${colW}">${esc(q.label)}</th>`
  ).join('');

  container.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--card-border);border-radius:10px;overflow:hidden">
      <div style="padding:8px 12px;border-bottom:1px solid var(--card-border);font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--t3)">
        Avg Uptime by Region
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--bg3)">
          <th style="padding:6px 12px;font-size:10px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--t3);text-align:left">Region</th>
          ${headers}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderUptimeMonthlyCards() {
  const container = document.getElementById('ut-monthly-cards');
  if (!container) return;

  const now         = new Date();
  const currentYear = now.getFullYear();

  // Aggregate monthly data across all services (weighted avg)
  const mMeta  = {};  // monthKey → {label}
  const mStats = {};  // monthKey → {totalChk, totalUp}

  _uptimeServices.forEach(svc => {
    (svc.history_monthly || []).forEach(m => {
      if (!m.month.startsWith(currentYear + '')) return;
      const [, mo] = m.month.split('-');
      const mStart = new Date(currentYear, parseInt(mo, 10) - 1, 1);
      if (mStart > now) return;  // future month — skip
      if (!mMeta[m.month])  mMeta[m.month]  = { label: m.label };
      if (!mStats[m.month]) mStats[m.month]  = { totalChk: 0, totalUp: 0 };
      if (m.checks > 0 && m.uptime_pct != null) {
        mStats[m.month].totalChk += m.checks;
        mStats[m.month].totalUp  += m.checks * (m.uptime_pct / 100);
      }
    });
  });

  const keys = Object.keys(mMeta).sort();
  if (!keys.length) { container.innerHTML = ''; return; }

  container.innerHTML = keys.map(key => {
    const label  = mMeta[key].label;
    const { totalChk, totalUp } = mStats[key];
    const pct    = totalChk > 0 ? totalUp / totalChk * 100 : null;
    const pctStr = pct != null ? pct.toFixed(1) + '%' : '—';
    const color  = pct == null ? 'var(--t3)' : pct >= 99.9 ? '#4ade80' : pct >= 99 ? '#fbbf24' : '#ef5350';
    const isNow  = key === `${currentYear}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const borderColor = isNow ? 'rgba(129,140,248,0.45)' : 'var(--card-border)';
    return `<div onclick="openReport('${key}')" style="
        cursor:pointer;background:var(--bg2);border:1px solid ${borderColor};
        border-radius:8px;padding:8px 14px;display:flex;flex-direction:column;gap:4px;
        transition:border-color .15s,background .15s;min-width:110px"
        onmouseover="this.style.borderColor='rgba(129,140,248,0.65)';this.style.background='var(--bg3)'"
        onmouseout="this.style.borderColor='${borderColor}';this.style.background='var(--bg2)'">
      <div style="display:flex;align-items:baseline;gap:4px">
        <span style="font-size:14px;font-weight:700;color:${color};line-height:1">${pctStr}</span>
        ${isNow ? '<span style="width:5px;height:5px;border-radius:50%;background:#818cf8;display:inline-block;margin-bottom:1px;flex-shrink:0"></span>' : ''}
      </div>
      <div style="font-size:10px;color:var(--t3);white-space:nowrap">${esc(label)}</div>
      <div style="height:2px;border-radius:99px;background:${pct == null ? 'var(--card-border)' : color};opacity:0.4;margin-top:2px"></div>
    </div>`;
  }).join('');
}

function renderUptimeServiceList() {
  const listEl = document.getElementById('ut-service-list');
  if (!listEl) return;

  if (!_uptimeFiltered.length) {
    listEl.innerHTML = `<div class="ut-empty" style="padding:16px;font-size:12px;color:var(--t3)">No services match.</div>`;
    return;
  }

  // Build grouped structure
  const groupOrder = [];
  const grouped = {};
  _uptimeFiltered.forEach((svc, i) => {
    const g = svc.group || '';
    if (!grouped[g]) { grouped[g] = []; groupOrder.push(g); }
    grouped[g].push({ svc, idx: i });
  });
  const hasGroups = groupOrder.some(g => g !== '');

  let html = '';
  groupOrder.forEach(g => {
    if (hasGroups && g) {
      html += `<div style="padding:6px 12px 3px;font-size:9px;font-weight:700;letter-spacing:0.1em;
        text-transform:uppercase;color:var(--info);border-top:1px solid rgba(255,255,255,0.05);
        margin-top:2px">${esc(g)}</div>`;
    }
    grouped[g].forEach(({ svc, idx }) => {
      const dotColor = svc.status === 'up' ? 'var(--ok)' : svc.status === 'degraded' ? 'var(--warn)' : svc.status === 'maintenance' ? 'var(--info)' : 'var(--crit)';
      const pct      = svc.uptime_30d != null ? svc.uptime_30d.toFixed(2) : null;
      const pctRaw   = svc.uptime_30d ?? null;
      const pctColor = pctRaw == null ? 'var(--t3)' : pctRaw >= 99.9 ? 'var(--ok)' : pctRaw >= 99 ? 'var(--warn)' : 'var(--crit)';
      const spark = (svc.sparkline || []).slice(-10).map(h => {
        const c = h.status === 'up' ? 'var(--ok)' : h.status === 'degraded' ? 'var(--warn)' : h.status === 'maintenance' ? 'var(--info)' : 'var(--crit)';
        return `<div style="width:4px;height:14px;border-radius:1px;background:${c};flex-shrink:0"></div>`;
      }).join('');
      const active = idx === _uptimeSelectedIdx ? ' ut-row-active' : '';
      html += `<div class="ut-row${active}" onclick="selectUptimeService(${idx})">
        <div class="ut-dot" style="background:${dotColor}"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(svc.service)}</div>
          <div style="font-size:10px;color:${pctColor}">${pct != null ? pct + '%' : '—'}</div>
        </div>
        <div style="display:flex;gap:2px;align-items:flex-end">${spark}</div>
      </div>`;
    });
  });
  listEl.innerHTML = html;
}

function _isScheduledMaintenance(url, startIso) {
  if (_domainGroup(url) !== 'Living Goods Instances') return false;
  const h = new Date(startIso).getUTCHours();
  return h >= 20 || h < 4;  // 20:00–04:00 UTC = 23:00–07:00 EAT
}

function _incidentHint(allIncidents) {
  if (!allIncidents || !allIncidents.length) return null;
  const now = Date.now();
  const h24 = 24 * 3600 * 1000;

  const recent = allIncidents.map(inc => {
    const startIso = inc.start || inc.started_at;
    const endIso   = inc.end   || inc.ended_at;
    if (!startIso) return null;
    const startMs = new Date(startIso).getTime();
    const endMs   = endIso ? new Date(endIso).getTime() : null;
    return { startMs, endMs, durSecs: endMs ? (endMs - startMs) / 1000 : null };
  }).filter(p => p && (now - p.startMs) < h24);

  if (!recent.length) return null;

  const ongoing = recent.find(p => !p.endMs);
  if (ongoing) {
    const mins = Math.round((now - ongoing.startMs) / 60000);
    if (mins >= 30) return 'Service has been down for over 30 minutes — follow up with the owning team.';
    return 'Incident is ongoing — monitoring for recovery.';
  }

  if (recent.length >= 3) {
    const sorted = [...recent].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i <= sorted.length - 3; i++) {
      if (sorted[i + 2].startMs - sorted[i].startMs <= 3600000) {
        const hour = new Date(sorted[i].startMs).getUTCHours();
        if (hour >= 6 && hour <= 14) {
          return 'Repeated short outages during business hours — pattern is consistent with a deployment or planned maintenance on the service side.';
        }
        return 'Repeated short outages in quick succession — possible network instability or service-side deployment.';
      }
    }
  }

  if (recent.some(p => p.durSecs && p.durSecs > 1800)) {
    return 'Extended outage detected — service may have needed a restart or experienced infrastructure issues.';
  }

  if (recent.length === 1 && recent[0].durSecs && recent[0].durSecs < 120) {
    return 'Brief transient outage — likely a network timeout. Monitor for recurrence.';
  }

  return null;
}

function selectUptimeService(idx) {
  _uptimeSelectedIdx = idx;
  const svc = _uptimeFiltered[idx];
  if (!svc) return;

  // Re-render list to update active highlight
  renderUptimeServiceList();

  const panel = document.getElementById('ut-detail-panel');
  if (!panel) return;

  // ── Header ──────────────────────────────────────────────
  const statusClass = svc.status === 'up' ? 'ok' : svc.status === 'maintenance' ? 'info' : svc.status === 'degraded' ? 'warn' : 'crit';
  const statusLabel = svc.status === 'up' ? 'Up' : svc.status === 'maintenance' ? 'Maintenance' : svc.status === 'degraded' ? 'Degraded' : 'Down';
  const groupBadge  = svc.group ? `<span style="font-size:10px;color:var(--info);font-weight:600;text-transform:uppercase;letter-spacing:0.06em">${esc(svc.group)}</span>` : '';

  // ── Heartbeat bars ───────────────────────────────────────
  const sparkline = svc.sparkline || [];
  const heartbeat = sparkline.slice(-30).map(h => {
    const c = h.status === 'up' ? 'var(--ok)' : h.status === 'degraded' ? 'var(--warn)' : h.status === 'maintenance' ? 'var(--info)' : h.status == null ? 'rgba(255,255,255,0.12)' : 'var(--crit)';
    const title = `${h.status || 'unknown'}${h.latency_ms != null ? ' · ' + h.latency_ms + 'ms' : ''}`;
    return `<div class="ut-hb-bar" style="background:${c}" title="${esc(title)}"></div>`;
  }).join('');

  // ── Stats strip ──────────────────────────────────────────
  const currLat = svc.latency_ms != null ? svc.latency_ms + 'ms' : '—';
  const hist7   = (svc.history_daily || []).slice(-7).filter(d => d.avg_latency != null);
  const avgLat  = hist7.length ? Math.round(hist7.reduce((s,d) => s + d.avg_latency, 0) / hist7.length) + 'ms' : '—';
  const lastDay = (svc.history_daily || []).slice(-1)[0];
  const up24h   = lastDay?.uptime_pct != null ? lastDay.uptime_pct.toFixed(2) + '%' : '—';
  const up30d   = svc.uptime_30d != null ? svc.uptime_30d.toFixed(2) + '%' : '—';
  const ssl     = svc.ssl || {};
  const sslVal  = ssl.days_remaining != null ? ssl.days_remaining + 'd' : ssl.status === 'http_only' ? 'HTTP' : '—';
  const sslColor = ssl.days_remaining == null ? 'var(--t3)' : ssl.days_remaining < 14 ? 'var(--crit)' : ssl.days_remaining < 30 ? 'var(--warn)' : 'var(--ok)';

  const stats = [
    { v: currLat, l: 'Current' },
    { v: avgLat,  l: 'Avg 7d' },
    { v: up24h,   l: 'Uptime 24h' },
    { v: up30d,   l: 'Uptime 30d' },
    { v: sslVal,  l: 'SSL', color: sslColor },
  ].map(s => `<div>
    <div class="ut-stat-v" style="${s.color ? 'color:' + s.color : ''}">${s.v}</div>
    <div class="ut-stat-l">${s.l}</div>
  </div>`).join('');

  // ── Incidents table ──────────────────────────────────────
  const hint    = _incidentHint(svc.incidents || []);
  const hintHtml = hint
    ? `<div style="font-size:11px;color:var(--t2);background:rgba(255,193,7,0.08);border-left:3px solid #f0a500;border-radius:3px;padding:7px 10px;margin-bottom:10px">
        <span style="font-weight:600;color:#f0a500">Insight&nbsp;&nbsp;</span>${esc(hint)}
       </div>`
    : '';
  const incidents = (svc.incidents || []).slice(-10).reverse();
  const incHtml = incidents.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr style="color:var(--t3)">
          <th style="text-align:left;padding:4px 0;font-weight:500">Started</th>
          <th style="text-align:left;padding:4px 0;font-weight:500">Ended</th>
          <th style="text-align:left;padding:4px 0;font-weight:500">Duration</th>
        </tr></thead>
        <tbody>${incidents.map(inc => {
          const startIso = inc.start || inc.started_at;
          const endIso   = inc.end   || inc.ended_at;
          const start = startIso ? new Date(startIso).toLocaleString() : '—';
          const end   = endIso   ? new Date(endIso).toLocaleString()   : '<span class="badge crit" style="font-size:9px">Ongoing</span>';
          let dur = '—';
          if (startIso && endIso) {
            const s = Math.round((new Date(endIso) - new Date(startIso)) / 1000);
            dur = s < 60 ? s + 's' : s < 3600 ? Math.round(s/60) + 'm' : (s/3600).toFixed(1) + 'h';
          }
          const scheduled = startIso && _isScheduledMaintenance(svc.url, startIso)
            ? `<span style="font-size:9px;background:rgba(79,195,247,0.15);color:#4fc3f7;padding:1px 6px;border-radius:3px;margin-left:5px;vertical-align:middle">Scheduled</span>`
            : '';
          return `<tr style="border-top:1px solid rgba(255,255,255,0.05)">
            <td style="padding:5px 0;color:var(--t2)">${start}${scheduled}</td>
            <td style="padding:5px 0;color:var(--t2)">${end}</td>
            <td style="padding:5px 0;color:var(--t2)">${dur}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`
    : `<div style="font-size:12px;color:var(--t3);padding:8px 0">No incidents recorded.</div>`;

  panel.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px">
      <div style="min-width:0">
        ${groupBadge ? `<div style="margin-bottom:3px">${groupBadge}</div>` : ''}
        <div style="font-size:17px;font-weight:600;color:var(--t1)">${esc(svc.service)}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:2px;word-break:break-all">${esc(svc.url || '')}</div>
      </div>
      <span class="badge ${statusClass}" style="flex-shrink:0;font-size:12px;padding:4px 10px">${statusLabel}</span>
    </div>
    <div class="ut-heartbeat">${heartbeat || '<span style="color:var(--t3);font-size:11px">No check history yet.</span>'}</div>
    <div class="ut-stats-strip">${stats}</div>
    <div id="ut-detail-chart" style="margin-bottom:20px"></div>
    <div style="font-size:11px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">Incident History</div>
    ${hintHtml}${incHtml}`;

  _renderUptimeDetailChart(svc);
}

function _renderUptimeDetailChart(svc) {
  const el   = document.getElementById('ut-detail-chart');
  if (!el) return;
  const data = svc.history_daily || [];
  if (!data.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--t3);padding:8px 0">No daily history yet.</div>';
    return;
  }

  const maxLat   = Math.max(...data.map(d => d.avg_latency||0), 1);
  const barWidth = Math.max(8, Math.floor(560 / data.length) - 2);
  const chartH   = 120;

  const bars = data.map((d, i) => {
    if (d.uptime_pct == null) return `<rect x="${i*(barWidth+2)}" y="${chartH}" width="${barWidth}" height="0" fill="rgba(255,255,255,0.06)" rx="2"/>`;
    const color = d.uptime_pct >= 99.9 ? '#4ade80' : d.uptime_pct >= 99 ? '#fbbf24' : '#ef5350';
    const latH  = d.avg_latency ? Math.round((d.avg_latency/maxLat) * chartH * 0.7) : 0;
    const uptH  = Math.round(d.uptime_pct/100 * chartH);
    return `
      <rect x="${i*(barWidth+2)}" y="${chartH-latH}" width="${barWidth}" height="${latH}"
        fill="rgba(79,195,247,0.25)" rx="2" title="${esc(d.label)}: ${d.avg_latency||0}ms"/>
      <rect x="${i*(barWidth+2)+barWidth*0.25}" y="${chartH-uptH}" width="${barWidth*0.5}" height="3"
        fill="${color}" rx="1" title="${esc(d.label)}: ${d.uptime_pct}%"/>`;
  }).join('');

  const step   = Math.max(1, Math.ceil(data.length / 8));
  const labels = data.map((d, i) => {
    if (i % step !== 0) return '';
    return `<text x="${i*(barWidth+2)+barWidth/2}" y="${chartH+13}" fill="var(--t3)" font-size="9" text-anchor="middle">${esc(d.label)}</text>`;
  }).join('');

  const withData  = data.filter(d => d.uptime_pct != null && d.checks > 0);
  const _chkSum   = withData.reduce((s,d) => s + d.checks, 0);
  const _upSum    = withData.reduce((s,d) => s + d.checks * (d.uptime_pct / 100), 0);
  const avgUp     = _chkSum > 0 ? (_upSum / _chkSum * 100).toFixed(2) : null;
  const minUp     = withData.length ? Math.min(...withData.map(d => d.uptime_pct)).toFixed(2) : null;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-size:11px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:0.06em">Response Time — 30 Days</div>
      <div style="font-size:11px;color:var(--t3)">
        <span style="display:inline-block;width:10px;height:3px;background:#4ade80;vertical-align:middle;margin-right:4px;border-radius:1px"></span>Uptime
        <span style="display:inline-block;width:10px;height:10px;background:rgba(79,195,247,0.25);vertical-align:middle;margin:0 4px 0 10px;border-radius:2px"></span>Latency
        ${avgUp != null ? `<span style="margin-left:10px">Avg <span style="color:${avgUp>=99.9?'var(--ok)':'var(--warn)'}">${avgUp}%</span></span>` : ''}
        ${minUp != null && minUp < 100 ? `<span style="margin-left:8px">Low <span style="color:var(--warn)">${minUp}%</span></span>` : ''}
      </div>
    </div>
    <svg width="100%" viewBox="0 0 ${data.length*(barWidth+2)} ${chartH+18}" preserveAspectRatio="none" style="overflow:visible">
      ${bars}${labels}
    </svg>`;
}

// ── Uptime report modal (quarterly + monthly) ─────────────
let _activeReportKey = null;  // e.g. "2026-Q1" or "2026-03"
let _pgIncidentData  = {};    // {serviceName: {incidents, downtime_secs}} from Postgres

function _reportDateRange(key) {
  if (key.includes('-Q')) {
    const [yearStr, qStr] = key.split('-Q');
    const year = parseInt(yearStr, 10), q = parseInt(qStr, 10);
    return { start: new Date(Date.UTC(year, (q - 1) * 3, 1)), end: new Date(Date.UTC(year, q * 3, 1)) };
  }
  const [yearStr, moStr] = key.split('-');
  const year = parseInt(yearStr, 10), mo = parseInt(moStr, 10);
  return { start: new Date(Date.UTC(year, mo - 1, 1)), end: new Date(Date.UTC(year, mo, 1)) };
}

function _quarterIncidentsFor(svc, key) {
  const { start, end } = _reportDateRange(key);
  return (svc.incidents || []).filter(inc => {
    const iso = inc.start || inc.started_at;
    if (!iso) return false;
    const d = new Date(iso);
    return d >= start && d < end;
  });
}

// Resolve {label, sub} for any report key (quarter or month)
function _reportMeta(key) {
  if (key.includes('-Q')) {
    const sample = _uptimeServices[0]?.history_quarterly?.find(q => q.quarter === key);
    return { label: sample?.label || key, sub: sample?.months || '' };
  }
  const sample = _uptimeServices[0]?.history_monthly?.find(m => m.month === key);
  return { label: sample?.label || key, sub: '' };
}

// Per-service data for a report key (works for both quarter and month keys)
function _reportRowsFor(key) {
  const { end } = _reportDateRange(key);
  const periodEnd = end < new Date() ? end : new Date();
  return _uptimeServices.map(svc => {
    const hist = key.includes('-Q')
      ? (svc.history_quarterly || []).find(q => q.quarter === key)
      : (svc.history_monthly   || []).find(m => m.month   === key);
    const incidents = _quarterIncidentsFor(svc, key);
    const dtSecs    = _incidentDowntimeSecs(incidents, periodEnd);
    return { svc, hist, incidents: incidents.length, dtHrs: dtSecs > 0 ? +(dtSecs / 3600).toFixed(2) : 0 };
  }).sort((a, b) => (b.hist?.uptime_pct ?? -1) - (a.hist?.uptime_pct ?? -1));
}

function _incidentDowntimeSecs(incidents, periodEnd = null) {
  const endCap = periodEnd ? periodEnd.getTime() : Date.now();
  const intervals = [];
  for (const inc of incidents) {
    const s = inc.start || inc.started_at;
    if (!s) continue;
    const e = inc.end || inc.ended_at;
    const startMs = new Date(s).getTime();
    const endMs   = e ? Math.min(new Date(e).getTime(), endCap) : endCap;
    if (endMs > startMs) intervals.push([startMs, endMs]);
  }
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
    else merged.push(intervals[i]);
  }
  return merged.reduce((sum, [s, e]) => sum + Math.round((e - s) / 1000), 0);
}

async function openReport(key) {
  _activeReportKey = key;
  const { label, sub } = _reportMeta(key);
  const rows = _reportRowsFor(key);
  const { start, end } = _reportDateRange(key);

  document.getElementById('qt-modal-title').textContent = `${label} Uptime Report`;
  document.getElementById('qt-modal-sub').textContent   =
    `${_uptimeServices.length} services monitored${sub ? ' · ' + sub : ''}`;
  document.getElementById('qt-modal-overlay').style.display = 'flex';
  document.getElementById('qt-modal-tbody').innerHTML =
    '<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--t3)">Loading incident data…</td></tr>';

  _pgIncidentData = {};
  try {
    const res = await fetch(
      `/api/uptime/incidents-summary?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`
    );
    if (res.ok) _pgIncidentData = await res.json();
  } catch (e) {
    console.warn('[uptime] incidents-summary fetch failed, using cached data:', e);
  }

  const _renderRow = ({ svc, hist }) => {
    const pg       = _pgIncidentData[svc.service] || {};
    const incidents = pg.incidents      ?? 0;
    const dtHrs     = pg.downtime_secs != null ? +(pg.downtime_secs / 3600).toFixed(2) : 0;
    const pct      = hist?.uptime_pct != null ? hist.uptime_pct.toFixed(2) + '%' : '—';
    const pctColor = hist?.uptime_pct == null ? 'var(--t3)'
                   : hist.uptime_pct >= 99.9  ? 'var(--ok)'
                   : hist.uptime_pct >= 99     ? 'var(--warn)' : 'var(--crit)';
    const stClass  = svc.status === 'up' ? 'ok' : svc.status === 'degraded' ? 'warn' : 'crit';
    const stLabel  = svc.status === 'up' ? 'Up' : svc.status === 'degraded' ? 'Degraded'
                   : svc.status === 'timeout' ? 'Timeout' : 'Down';
    return `<tr>
      <td style="font-weight:500">${esc(svc.service)}</td>
      <td class="muted mono" style="font-size:11px">${esc(svc.url || '')}</td>
      <td style="font-weight:700;color:${pctColor}">${pct}</td>
      <td class="muted">${hist?.checks ?? '—'}</td>
      <td>${incidents > 0 ? `<span style="color:var(--crit);font-weight:600">${incidents}</span>` : '0'}</td>
      <td>${dtHrs > 0 ? `<span style="color:var(--warn)">${dtHrs}h</span>` : '0h'}</td>
      <td><span class="badge ${stClass}" style="font-size:10px">${stLabel}</span></td>
    </tr>`;
  };

  document.getElementById('qt-modal-tbody').innerHTML = rows.map(_renderRow).join('');
}

// keep alias so quarterly cards still work
const openQuarterlyReport = openReport;

function closeQuarterlyReport(e) {
  if (e && e.target !== document.getElementById('qt-modal-overlay')) return;
  document.getElementById('qt-modal-overlay').style.display = 'none';
}

// ── Entity derived from URL ─────────────────────────────
function _entityFromUrl(url) {
  if (!url) return '—';
  if (url.includes('lg-apps.com')) return 'LG';
  if (url.includes('.go.ke'))      return 'MoH KE';
  if (url.includes('.go.ug'))      return 'MoH UG';
  return 'BF Gov';
}

// ── 3-month rolling weighted average from history_monthly ─
// asOfMonth: optional "YYYY-MM" key — if provided, returns the avg of the
// 3 months ending at (and including) that month, not the most recent 3.
function _threeMonthAvg(svc, asOfMonth) {
  let all = (svc.history_monthly || [])
    .filter(m => m.uptime_pct != null && m.checks > 0);
  if (asOfMonth) {
    all = all.filter(m => m.month <= asOfMonth);
  }
  const months = all.slice(-3);
  if (!months.length) return null;
  const totalChk = months.reduce((s, m) => s + m.checks, 0);
  const totalUp  = months.reduce((s, m) => s + m.checks * (m.uptime_pct / 100), 0);
  return totalChk > 0 ? +(totalUp / totalChk * 100).toFixed(2) : null;
}

function exportReport() {
  if (!_activeReportKey || typeof XLSX === 'undefined') return;
  const quarterKey = _activeReportKey;
  const { label, sub: months } = _reportMeta(quarterKey);
  const generated  = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });

  // ── Monthly breakdown columns for the report period ─────
  // For a quarterly key (e.g. 2026-Q1) → Jan, Feb, Mar
  // For a monthly key (e.g. 2026-03)   → no extra columns (period is already the month)
  const isQuarterly = quarterKey.includes('-Q');
  let monthCols = [];
  if (isQuarterly) {
    const [yearStr, qStr] = quarterKey.split('-Q');
    const year = parseInt(yearStr, 10);
    const startMonth = (parseInt(qStr, 10) - 1) * 3 + 1;
    monthCols = [0, 1, 2].map(i => {
      const m  = startMonth + i;
      const dt = new Date(year, m - 1, 1);
      return {
        key:   `${year}-${String(m).padStart(2, '0')}`,
        label: dt.toLocaleString('en-US', { month: 'short' }) + ' ' + year + ' %',
      };
    });
  }

  // ── Column definitions (dynamic) ────────────────────────
  const colDefs = [
    { key: 'num',      label: '#',                    wch: 4  },
    { key: 'service',  label: 'Service',               wch: 28 },
    { key: 'uptime',   label: 'Uptime %',              wch: 12 },
    { key: 'avg3m',    label: 'Long Term Avg (3m) %',  wch: 18 },
    ...monthCols.map(mc => ({ key: mc.key, label: mc.label, wch: 11 })),
    { key: 'incidents',label: 'Incidents',             wch: 12 },
    { key: 'downtime', label: 'Downtime (hrs)',         wch: 16 },
    { key: 'dttype',   label: 'Downtime Type',          wch: 24 },
    { key: 'entity',   label: 'Entity',                 wch: 12 },
    { key: 'status',   label: 'Status',                 wch: 12 },
  ];
  const lastCol = colDefs.length - 1;

  // ── Colour palette ──────────────────────────────────────
  const C = {
    navyBg:    '0F2542',  navyFg:    'FFFFFF',
    headerBg:  '1B3A6B',  headerFg:  'FFFFFF',
    subBg:     '1E4080',  subFg:     'C8D8F0',
    summBg:    '162E50',  summFg:    '7EB3F5',
    summValFg: 'FFFFFF',
    ok:        '22543D',  okBg:      'D1FAE5',
    warn:      '78350F',  warnBg:    'FEF3C7',
    crit:      '7F1D1D',  critBg:    'FEE2E2',
    incBg:     'FEE2E2',  incFg:     'B91C1C',
    dtBg:      'FFF7ED',  dtFg:      'C2410C',
    zeroBg:    'F0FDF4',  zeroFg:    '15803D',
    row1Bg:    'F8FAFF',  row2Bg:    'EEF4FF',
    border:    'CBD5E1',
    upBg:      'DCFCE7',  upFg:      '166534',
    downBg:    'FEE2E2',  downFg:    '991B1B',
    degBg:     'FEF9C3',  degFg:     '854D0E',
    maintBg:   'EFF6FF',  maintFg:   '1D4ED8',
  };

  // ── Style helpers ───────────────────────────────────────
  const border = (color = C.border) => ({
    top:    { style:'thin', color:{ rgb:color } },
    bottom: { style:'thin', color:{ rgb:color } },
    left:   { style:'thin', color:{ rgb:color } },
    right:  { style:'thin', color:{ rgb:color } },
  });

  const cell = (v, t, s) => ({ v, t: t || (typeof v === 'number' ? 'n' : 's'), s: s || {} });

  const hdrStyle = (extra = {}) => ({
    font:      { bold:true, color:{ rgb:C.headerFg }, sz:10, name:'Calibri' },
    fill:      { fgColor:{ rgb:C.headerBg } },
    alignment: { horizontal:'center', vertical:'center', wrapText:true },
    border:    border(C.navyBg),
    ...extra,
  });

  const dataStyle = (fgColor, bgColor, bold = false, align = 'left') => ({
    font:      { color:{ rgb:fgColor }, sz:10, name:'Calibri', bold },
    fill:      { fgColor:{ rgb:bgColor } },
    alignment: { horizontal:align, vertical:'center' },
    border:    border(),
  });

  const uptimeStyle = (pct, rowBg) => {
    const bg = pct == null ? rowBg : pct >= 99.9 ? C.okBg : pct >= 99 ? C.warnBg : C.critBg;
    const fg = pct == null ? '64748B' : pct >= 99.9 ? C.ok : pct >= 99 ? C.warn : C.crit;
    return { ...dataStyle(fg, bg, true, 'center'), numFmt: '0.00"%"' };
  };

  // ── Build row data ──────────────────────────────────────
  const rows = _reportRowsFor(quarterKey).map(r => {
    const pg = _pgIncidentData[r.svc.service] || {};
    return {
      ...r,
      q:         r.hist,
      incidents: pg.incidents      ?? r.incidents,
      dtHrs:     pg.downtime_secs != null ? +(pg.downtime_secs / 3600).toFixed(2) : r.dtHrs,
    };
  });

  // ── Summary figures ─────────────────────────────────────
  const totalSvcs = rows.length;
  // Use historical uptime_pct when available (past months); fall back to live status for current/future
  const svcsUp   = rows.filter(r =>
    r.q?.uptime_pct != null ? r.q.uptime_pct === 100 : r.svc.status === 'up'
  ).length;
  const svcsDown = totalSvcs - svcsUp;
  const totalInc  = rows.reduce((s, r) => s + r.incidents, 0);
  const totalDt   = +rows.reduce((s, r) => s + r.dtHrs, 0).toFixed(2);
  const validPcts = rows.filter(r => r.q?.uptime_pct != null);
  const totalChk  = validPcts.reduce((s, r) => s + (r.q.checks || 0), 0);
  const totalUpW  = validPcts.reduce((s, r) => s + (r.q.checks || 0) * (r.q.uptime_pct / 100), 0);
  const avgUptime = totalChk > 0 ? +(totalUpW / totalChk * 100).toFixed(2) : null;

  // ── Worksheet cell builder ──────────────────────────────
  const ws  = {};
  const ref = (r, c) => XLSX.utils.encode_cell({ r, c });
  let   row = 0;

  const setCell = (r, c, v, t, s) => { ws[ref(r, c)] = cell(v, t, s); };
  const fillRow = (r, bg) => { for (let c = 0; c <= lastCol; c++) setCell(r, c, '', 's', { fill:{ fgColor:{ rgb:bg } } }); };

  // Row 0 — Title banner
  setCell(row, 0, 'LIVING GOODS — SERVICE UPTIME REPORT', 's', {
    font:      { bold:true, sz:16, color:{ rgb:C.navyFg }, name:'Calibri' },
    fill:      { fgColor:{ rgb:C.navyBg } },
    alignment: { horizontal:'center', vertical:'center' },
  });
  for (let c = 1; c <= lastCol; c++) setCell(row, c, '', 's', { fill:{ fgColor:{ rgb:C.navyBg } } });
  row++;

  // Row 1 — Sub-title
  setCell(row, 0, `${label}  ·  ${months}  ·  Generated: ${generated}`, 's', {
    font:      { italic:true, sz:11, color:{ rgb:C.subFg }, name:'Calibri' },
    fill:      { fgColor:{ rgb:C.subBg } },
    alignment: { horizontal:'center', vertical:'center' },
  });
  for (let c = 1; c <= lastCol; c++) setCell(row, c, '', 's', { fill:{ fgColor:{ rgb:C.subBg } } });
  row++;

  // Row 2 — spacer
  fillRow(row, '0D1F3C'); row++;

  // Rows 3–4 — Summary KPI block
  const kpiLabels = ['Total Services', 'Services Up', 'Services Down', 'Avg Uptime', 'Total Incidents', 'Total Downtime (hrs)'];
  const kpiValues = [totalSvcs, svcsUp, svcsDown, avgUptime != null ? avgUptime + '%' : '—', totalInc, totalDt];
  kpiLabels.forEach((lbl, c) => {
    setCell(row, c, lbl, 's', {
      font:      { bold:true, sz:9, color:{ rgb:C.summFg }, name:'Calibri' },
      fill:      { fgColor:{ rgb:C.summBg } },
      alignment: { horizontal:'center' },
    });
  });
  for (let c = kpiLabels.length; c <= lastCol; c++) setCell(row, c, '', 's', { fill:{ fgColor:{ rgb:C.summBg } } });
  row++;
  kpiValues.forEach((val, c) => {
    const fgRgb = c === 1 ? C.zeroBg : c === 2 ? C.critBg : C.summValFg;
    setCell(row, c, val, typeof val === 'number' ? 'n' : 's', {
      font:      { bold:true, sz:13, color:{ rgb:fgRgb }, name:'Calibri' },
      fill:      { fgColor:{ rgb:C.summBg } },
      alignment: { horizontal:'center', vertical:'center' },
    });
  });
  for (let c = kpiValues.length; c <= lastCol; c++) setCell(row, c, '', 's', { fill:{ fgColor:{ rgb:C.summBg } } });
  row++;

  // Row 5 — spacer
  fillRow(row, '0D1F3C'); row++;

  // Row 6 — Column headers
  colDefs.forEach((col, c) => setCell(row, c, col.label, 's', hdrStyle()));
  row++;

  // ── Data rows ───────────────────────────────────────────
  rows.forEach(({ svc, q, incidents, dtHrs }, i) => {
    const pct    = q?.uptime_pct ?? null;
    const isEven = i % 2 === 0;
    const rowBg  = isEven ? C.row1Bg : C.row2Bg;

    const stBg  = svc.status === 'up' ? C.upBg  : svc.status === 'maintenance' ? C.maintBg : svc.status === 'degraded' ? C.degBg  : C.downBg;
    const stFg  = svc.status === 'up' ? C.upFg  : svc.status === 'maintenance' ? C.maintFg : svc.status === 'degraded' ? C.degFg  : C.downFg;
    const stLbl = svc.status === 'up' ? 'Up'    : svc.status === 'maintenance' ? 'Maintenance' : svc.status === 'degraded' ? 'Degraded' : svc.status === 'timeout' ? 'Timeout' : 'Down';

    const avg3m  = _threeMonthAvg(svc, quarterKey.includes('-Q') ? null : quarterKey);
    const dtType = svc.in_maintenance ? 'Planned (Non-Business Hours)' : 'N/A';
    const entity = _entityFromUrl(svc.url);

    colDefs.forEach((col, c) => {
      switch (col.key) {
        case 'num':
          setCell(row, c, i + 1, 'n', dataStyle('94A3B8', rowBg, false, 'center'));
          break;
        case 'service':
          setCell(row, c, svc.service || '', 's', dataStyle('0F172A', rowBg, true));
          break;
        case 'uptime':
          setCell(row, c, pct != null ? +pct.toFixed(2) : 'N/A', pct != null ? 'n' : 's', uptimeStyle(pct, rowBg));
          break;
        case 'avg3m':
          setCell(row, c, avg3m != null ? avg3m : 'N/A', avg3m != null ? 'n' : 's', uptimeStyle(avg3m, rowBg));
          break;
        case 'incidents':
          setCell(row, c, incidents, 'n', incidents > 0
            ? dataStyle(C.incFg, C.incBg, true, 'center')
            : dataStyle(C.zeroFg, C.zeroBg, false, 'center'));
          break;
        case 'downtime':
          setCell(row, c, dtHrs, 'n', dtHrs > 0
            ? dataStyle(C.dtFg, C.dtBg, true, 'center')
            : dataStyle(C.zeroFg, C.zeroBg, false, 'center'));
          break;
        case 'dttype':
          setCell(row, c, dtType, 's', svc.in_maintenance
            ? dataStyle(C.maintFg, C.maintBg, false, 'center')
            : dataStyle('475569', rowBg, false, 'center'));
          break;
        case 'entity':
          setCell(row, c, entity, 's', dataStyle('374151', rowBg, false, 'center'));
          break;
        case 'status':
          setCell(row, c, stLbl, 's', dataStyle(stFg, stBg, true, 'center'));
          break;
        default:
          // Monthly breakdown column
          const mHist = (svc.history_monthly || []).find(m => m.month === col.key);
          const mPct  = mHist?.uptime_pct ?? null;
          setCell(row, c, mPct != null ? +mPct.toFixed(2) : 'N/A', mPct != null ? 'n' : 's', uptimeStyle(mPct, rowBg));
      }
    });
    row++;
  });

  // ── Sheet metadata ──────────────────────────────────────
  ws['!ref']  = XLSX.utils.encode_range({ s:{ r:0, c:0 }, e:{ r:row - 1, c:lastCol } });
  ws['!cols'] = colDefs.map(col => ({ wch: col.wch }));
  ws['!rows'] = [
    { hpt: 32 }, // title
    { hpt: 20 }, // subtitle
    { hpt: 6  }, // spacer
    { hpt: 16 }, // kpi labels
    { hpt: 28 }, // kpi values
    { hpt: 6  }, // spacer
    { hpt: 22 }, // col headers
    ...rows.map(() => ({ hpt: 18 })),
  ];
  ws['!merges'] = [
    { s:{ r:0, c:0 }, e:{ r:0, c:lastCol } },
    { s:{ r:1, c:0 }, e:{ r:1, c:lastCol } },
    { s:{ r:2, c:0 }, e:{ r:2, c:lastCol } },
    { s:{ r:5, c:0 }, e:{ r:5, c:lastCol } },
  ];

  // ── Write file ──────────────────────────────────────────
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, label);
  XLSX.writeFile(wb, `LivingGoods-Uptime-${quarterKey}.xlsx`);
}

let _uptimeStatusFilter = null;

function filterUptimeByStatus(status) {
  _uptimeStatusFilter = _uptimeStatusFilter === status ? null : status;
  ['up', 'down', 'maintenance', 'ssl'].forEach(s => {
    const el = document.getElementById('ut-kpi-' + s);
    if (el) el.style.outline = _uptimeStatusFilter === s ? '2px solid var(--info)' : 'none';
  });
  _applyUptimeFilters();
}

function filterUptimeList(q) {
  _applyUptimeFilters(q);
}

function _applyUptimeFilters(q) {
  const query = (q !== undefined ? q : (document.getElementById('ut-search')?.value || ''))
    .trim().toLowerCase();
  _uptimeFiltered = _uptimeServices.filter(s => {
    if (query && !s.service.toLowerCase().includes(query) && !(s.url||'').toLowerCase().includes(query)) return false;
    if (_uptimeStatusFilter === 'up')          return s.status === 'up';
    if (_uptimeStatusFilter === 'down')        return ['down','timeout','server_error'].includes(s.status);
    if (_uptimeStatusFilter === 'maintenance') return s.status === 'maintenance';
    if (_uptimeStatusFilter === 'ssl')         return s.ssl?.days_remaining != null && s.ssl.days_remaining < 30;
    return true;
  });
  _uptimeSelectedIdx = 0;
  renderUptimeServiceList();
  if (_uptimeFiltered.length) selectUptimeService(0);
  else {
    const panel = document.getElementById('ut-detail-panel');
    if (panel) panel.innerHTML = `<div style="padding:20px;font-size:12px;color:var(--t3)">No services match.</div>`;
  }
}



/* ── EVENT DETECTION ──────────────────────────────────── */
function detectEvents(ec2, eks, up, gd, alb, net) {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const push = (src, msg, sev) => {
    const key = src + ':' + msg;
    // Remove any existing entry for this key so it gets refreshed at the top
    const existing = _events.findIndex(e => e.key === key);
    if (existing !== -1) _events.splice(existing, 1);
    _events.unshift({ time: now, source: src, message: msg, severity: sev, key });
    if (_events.length > 100) _events.pop();
  };

  // ── Thresholds ──────────────────────────────────────────
  // CPU:    ≥80% critical · ≥60% warning
  // Memory: ≥90% critical · ≥80% warning
  // Disk:   ≥85% critical · ≥70% warning

  (ec2.instances || []).forEach(i => {
    const name = i.name || i.id;
    const cpu  = i.metrics?.cpu_percent  || 0;
    const mem  = i.metrics?.mem_percent  || 0;
    const disk = i.metrics?.disk_percent || 0;

    // CPU
    if (cpu >= 80)       push(name, `CPU critical: ${cpu}%`, 'critical');
    else if (cpu >= 60)  push(name, `CPU high: ${cpu}%`, 'warning');

    // Memory — only alert if CW Agent is reporting (mem > 0)
    if (mem > 0) {
      if (mem >= 90)      push(name, `Memory critical: ${mem}%`, 'critical');
      else if (mem >= 80) push(name, `Memory high: ${mem}%`, 'warning');
    }

    // Disk — only alert if CW Agent is reporting (disk > 0)
    if (disk > 0) {
      if (disk >= 85)      push(name, `Disk critical: ${disk}%`, 'critical');
      else if (disk >= 70) push(name, `Disk high: ${disk}%`, 'warning');
    }

    if (i.state === 'stopped') push(name, 'Instance stopped', 'warning');
  });
  (eks.nodes || []).filter(n => n.status !== 'ready').forEach(n => push(n.name, 'Node not ready', 'critical'));
  (eks.nodes || []).filter(n => n.any_pressure).forEach(n => {
    const flags = [
      n.pressure?.memory_pressure ? 'MemoryPressure' : null,
      n.pressure?.disk_pressure   ? 'DiskPressure'   : null,
      n.pressure?.pid_pressure    ? 'PIDPressure'     : null,
    ].filter(Boolean).join(', ');
    push(n.name, `Node pressure: ${flags}`, 'warning');
  });
  Object.entries(eks.namespaces || {}).forEach(([ns, c]) => {
    if (c.failed  > 0) push(ns, `${c.failed} failed pod(s)`, 'critical');
    if (c.pending > 0) push(ns, `${c.pending} pending pod(s)`, 'warning');
    if ((c.oom_killed_containers || 0) > 0)
      push(ns, `${c.oom_killed_containers} OOMKilled container(s)`, 'critical');
    if ((c.pending_pods_insufficient_resources || 0) > 0)
      push(ns, `${c.pending_pods_insufficient_resources} pod(s) pending — insufficient resources`, 'critical');
  });
  // Resource quota pressure
  (eks.resource_issues || []).filter(i => i.type === 'quota_pressure').forEach(i =>
    push(i.namespace, i.detail, i.severity === 'critical' ? 'critical' : 'warning'));
  // PVC disk fill
  (eks.resource_issues || []).filter(i => i.type === 'pvc_disk_pressure').forEach(i =>
    push(`${i.namespace}/${i.pvc_name}`, i.detail, i.severity === 'critical' ? 'critical' : 'warning'));
  (up.services || []).forEach(s => {
    if (s.status === 'down')    push(s.service, 'Service DOWN', 'critical');
    if (s.status === 'timeout') push(s.service, 'Probe timeout', 'warning');
    if (s.status === 'degraded') push(s.service, `HTTP ${s.status_code}`, 'warning');
  });
  // GuardDuty findings → events
  (gd.findings || []).filter(f => f.severity >= 7.0).forEach(f =>
    push(`GuardDuty · ${f.resource_id}`, f.title, 'critical'));
  (gd.findings || []).filter(f => f.severity >= 4.0 && f.severity < 7.0).forEach(f =>
    push(`GuardDuty · ${f.resource_id}`, f.title, 'warning'));
  // ALB events
  (alb.load_balancers || []).forEach(a => {
    const fn = a.friendly_name || a.name;
    if (a.status === 'critical')
      push(fn, `5xx rate ${a.metrics.error_rate_pct}% · ${a.targets.unhealthy} unhealthy hosts`, 'critical');
    else if (a.status === 'degraded')
      push(fn, `Degraded — P99 ${a.metrics.p99_latency_ms}ms · error rate ${a.metrics.error_rate_pct}%`, 'warning');
  });
  // EC2 network anomalies
  (net.anomalies || []).forEach(a =>
    push(a.instance_name, `High outbound traffic: ${a.outbound_mb} MB in 5min`, 'warning'));
}

/* ── EC2 NETWORK ──────────────────────────────────────── */
function renderEC2Network(net) {
  const tag = document.getElementById('net-summary-tag');
  const tbody = document.getElementById('ec2-net-tbody');
  if (!tbody) return;

  const s = net.summary || {};
  if (tag && s.total_out_mb != null) {
    tag.textContent = `↑ ${s.total_out_mb} MB out · ↓ ${s.total_in_mb} MB in`;
  }

  const instances = net.instances || [];
  if (!instances.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="tr-load">No EC2 network data yet.</td></tr>';
    return;
  }

  tbody.innerHTML = instances.map(i => {
    const n = i.network;
    const alertCell = n.outbound_alert
      ? '<span class="badge crit">High outbound</span>'
      : '<span style="color:var(--t3)">—</span>';
    const outColor = n.outbound_alert ? 'var(--crit)' : n.out_mb > 100 ? 'var(--warn)' : 'var(--t1)';
    return `<tr>
      <td style="font-weight:500">${esc(i.name)}<div class="muted" style="font-size:10px">${esc(i.id)}</div></td>
      <td class="muted">${esc(i.type)}</td>
      <td class="mono">${n.in_mb}</td>
      <td class="mono" style="color:${outColor}">${n.out_mb}</td>
      <td class="mono muted">${n.in_mbps}</td>
      <td class="mono" style="color:${outColor}">${n.out_mbps}</td>
      <td class="mono muted">${n.packets_in.toLocaleString()}</td>
      <td class="mono muted">${n.packets_out.toLocaleString()}</td>
      <td>${alertCell}</td>
    </tr>`;
  }).join('');
}

/* ── SSH USERS ────────────────────────────────────────── */
function renderSSHUsers(users) {
  const panel = document.getElementById('ssh-panel');
  const tag   = document.getElementById('ssh-status-tag');
  if (!panel) return;

  if (users.setup_required) {
    if (tag) { tag.textContent = 'Setup required'; tag.className = 'tag warn'; }
    panel.innerHTML = `
      <div class="ab-title">CloudWatch Agent Required</div>
      <div class="ab-desc">${esc(users.message || '')}</div>
      <div class="ab-desc" style="margin-top:8px">
        Install the CW Agent on your EC2 instances and configure it to ship
        <code>/var/log/secure</code> (Amazon Linux) or <code>/var/log/auth.log</code> (Ubuntu)
        to CloudWatch log group <code>/ec2/auth-logs</code>.
      </div>`;
    return;
  }

  if (!users.available || !users.instances?.length) {
    if (tag) tag.textContent = 'No data';
    panel.innerHTML = '<div class="ab-desc">No SSH log data available yet.</div>';
    return;
  }

  if (tag) {
    tag.textContent = `${users.total_active_sessions} active · ${users.total_alerts} alerts`;
    tag.className = `tag ${users.total_alerts > 0 ? 'crit' : 'ok'}`;
  }

  const rows = users.instances.map(inst => {
    const bruteFlag = inst.brute_force_ips.length > 0
      ? `<span class="badge crit">Brute force from ${inst.brute_force_ips.join(', ')}</span>`
      : '';
    return `<div class="sv-item">
      <div class="sv-ico ${inst.active_count > 0 ? 'ok' : 'warn'}" style="font-size:12px">
        ${inst.active_count > 0 ? inst.active_count : '0'}
      </div>
      <div class="sv-body">
        <div class="sv-title">${esc(inst.instance_name)}</div>
        <div class="sv-desc">
          ${inst.login_count_24h} logins · ${inst.failed_count_24h} failed · ${inst.sudo_events_24h.length} sudo cmds
          ${bruteFlag}
        </div>
        ${inst.active_sessions.length ? `<div class="sv-desc" style="color:var(--ok)">Active: ${inst.active_sessions.map(esc).join(', ')}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  panel.innerHTML = `<div class="savings-list" style="padding:0">${rows}</div>`;
}

/* ── VPC FLOW LOGS ────────────────────────────────────── */
function renderVPCFlow(vpc) {
  const panel = document.getElementById('vpc-panel');
  const tag   = document.getElementById('vpc-status-tag');
  if (!panel) return;

  if (vpc.setup_required || !vpc.available) {
    if (tag) { tag.textContent = 'Setup required'; tag.className = 'tag warn'; }
    panel.innerHTML = `
      <div class="ab-title">VPC Flow Logs Not Enabled</div>
      <div class="ab-desc">Enable VPC Flow Logs to see full network visibility — rejected connections, suspicious access attempts, and top talkers.</div>
      <div class="ab-desc" style="margin-top:6px;font-size:11px;color:var(--t3)">
        Run: <code>aws ec2 describe-flow-logs --region us-east-1</code> to check current status.
      </div>`;
    return;
  }

  if (tag) {
    const threats = vpc.brute_force_ips?.length || 0;
    tag.textContent = threats > 0 ? `${threats} threats` : 'Active';
    tag.className = `tag ${threats > 0 ? 'crit' : 'ok'}`;
  }

  const topTalkers = (vpc.top_talkers || []).slice(0, 5).map(t =>
    `<div class="cb-row"><span style="font-family:'DM Mono',monospace;font-size:11px">${esc(t.src_ip)}</span>
      <div class="cb-bg"><div class="cb-fill" style="width:${Math.min(100, t.bytes_mb/10)}%;background:var(--info)"></div></div>
      <span class="cb-val">${t.bytes_mb} MB</span></div>`
  ).join('');

  const suspicious = (vpc.suspicious_access || []).slice(0, 5).map(s =>
    `<div class="sm-row">
      <span class="sev ${s.attempts >= 10 ? 'high' : 'med'}">${s.port_name}</span>
      <span style="font-family:'DM Mono',monospace;font-size:11px">${esc(s.src_ip)}</span>
      <span class="muted">${s.attempts} attempts · ${s.action}</span>
    </div>`
  ).join('');

  const summary = vpc.traffic_summary || {};
  panel.innerHTML = `
    <div style="margin-bottom:12px">
      <div class="ab-title" style="margin-bottom:4px">Traffic (last ${vpc.lookback_minutes}min) — ${summary.total_bytes_mb || 0} MB total</div>
      ${topTalkers ? `<div style="font-size:11px;color:var(--t3);margin-bottom:6px">Top talkers by bytes</div>${topTalkers}` : ''}
    </div>
    ${suspicious ? `<div><div style="font-size:11px;color:var(--t3);margin-bottom:6px">Suspicious access attempts</div>${suspicious}</div>` : '<div style="color:var(--ok);font-size:12px">✓ No suspicious access detected</div>'}`;
}

/* ── FINOPS TAB SWITCHER ──────────────────────────────── */
function switchFinTab(id, el) {
  document.querySelectorAll('.fin-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.fin-tab').forEach(t => t.classList.remove('active'));
  const pane = document.getElementById('fin-tab-' + id);
  if (pane) pane.classList.add('active');
  if (el)   el.classList.add('active');
}

/* ── RESOURCE HISTORY HELPERS ─────────────────────────── */
function _renderResourceTable(month, resTag, resEl, curDaysIn) {
  const resources = (window._resHistory || {})[month] || [];
  const resTotal  = resources.reduce((s, r) => s + r.amount, 0) || 1;
  const daysInMo  = new Date(parseInt(month.slice(0,4)), parseInt(month.slice(5,7)), 0).getDate();
  const isCurrentMo = month.slice(0,7) === new Date().toISOString().slice(0,7);
  const days      = isCurrentMo ? (curDaysIn || daysInMo) : daysInMo;
  const svcColors = {'Amazon EC2':'var(--info)','Amazon RDS':'var(--ok)','Amazon S3':'var(--warn)','AWS Lambda':'var(--crit)'};
  if (resTag) resTag.textContent = resources.length ? `${resources.length} resources` : '—';
  if (!resEl) return;
  if (!resources.length) {
    resEl.innerHTML = '<div class="tr-load">No resource data for this month.</div>';
    return;
  }
  const resNames = window._resNames || {};
  resEl.innerHTML = `
    <div class="tscroll">
      <table class="dt">
        <thead><tr>
          <th>Resource</th><th>Service</th><th>Spend</th>
          <th>% of Total</th><th>Daily Avg</th>
        </tr></thead>
        <tbody>
          ${resources.map(r => {
            const pct      = Math.round(r.amount / resTotal * 100);
            const dailyAvg = '$' + (r.amount / days).toFixed(2);
            const svcColor = svcColors[r.service] || 'var(--t2)';
            const name     = resNames[r.resource_id] || '';
            const nameHtml = name
              ? `<div style="font-size:13px;font-weight:500;color:var(--t1);margin-bottom:2px">${esc(name)}</div>`
              : '';
            return `<tr>
              <td>
                ${nameHtml}
                <div class="mono" style="font-size:11px;color:var(--t3)">${esc(r.resource_id)}</div>
              </td>
              <td><span style="font-size:11px;color:${svcColor};font-weight:500">${esc(r.service)}</span></td>
              <td style="font-weight:600;color:var(--info)">$${r.amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
              <td><div class="bar-row"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--info)"></div></div><div class="bar-lbl">${pct}%</div></div></td>
              <td class="muted">${dailyAvg}/day</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function _selectResMo(month, btn) {
  document.querySelectorAll('#resource-month-picker .fin-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const resTag = document.getElementById('resource-count-tag');
  const resEl  = document.getElementById('resource-breakdown-inner');
  _renderResourceTable(month, resTag, resEl, null);
}

function _selectInstMo(month, btn) {
  document.querySelectorAll('#instance-month-picker .fin-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _renderInstanceTable(month, null);
}

function _renderInstanceTable(month, curDaysIn) {
  const instances = (window._instHistory || {})[month] || [];
  const instEl    = document.getElementById('instance-breakdown-inner');
  const instTag   = document.getElementById('instance-count-tag');
  const resNames  = window._instResNames || {};

  if (instTag) instTag.textContent = instances.length ? `${instances.length} instances` : '—';
  if (!instEl) return;
  if (!instances.length) {
    instEl.innerHTML = '<div class="tr-load">No instance data for this month.</div>';
    return;
  }

  const daysInMo    = new Date(parseInt(month.slice(0,4)), parseInt(month.slice(5,7)), 0).getDate();
  const isCurrentMo = month.slice(0,7) === new Date().toISOString().slice(0,7);
  const days        = isCurrentMo ? (curDaysIn || daysInMo) : daysInMo;
  const grandTotal  = instances.reduce((s, r) => s + r.total_amount, 0) || 1;
  const svcColors   = {'Amazon EC2':'var(--info)','Amazon RDS':'var(--ok)','Amazon S3':'var(--warn)','AWS Lambda':'var(--crit)'};

  instEl.innerHTML = `
    <div class="tscroll">
      <table class="dt">
        <thead><tr>
          <th>Instance</th><th>Breakdown</th><th>Total Spend</th>
          <th>% of Total</th><th>Daily Avg</th>
        </tr></thead>
        <tbody>
          ${instances.map((inst, idx) => {
            const pct       = Math.round(inst.total_amount / grandTotal * 100);
            const dailyAvg  = '$' + (inst.total_amount / days).toFixed(2);
            const nameHtml  = inst.root_name
              ? `<div style="font-size:13px;font-weight:500;color:var(--t1);margin-bottom:2px">${esc(inst.root_name)}</div>`
              : '';
            const icon      = inst.is_instance ? '⬡ ' : '';
            const breakdownId = 'inst-breakdown-' + idx;
            const parts = inst.breakdown.map(b => {
              const c = svcColors[b.service] || 'var(--t3)';
              return `<span style="font-size:10px;color:${c}">${esc(b.resource_id)}</span> <span class="muted" style="font-size:10px">$${b.amount.toFixed(2)}</span>`;
            }).join('<br>');
            return `<tr>
              <td>
                ${nameHtml}
                <div class="mono" style="font-size:11px;color:var(--t3)">${icon}${esc(inst.root_id)}</div>
              </td>
              <td style="font-size:11px;line-height:1.6">${parts}</td>
              <td style="font-weight:600;color:var(--info)">$${inst.total_amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
              <td><div class="bar-row"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--info)"></div></div><div class="bar-lbl">${pct}%</div></div></td>
              <td class="muted">${dailyAvg}/day</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function _selectAppMo(month, btn) {
  window._appCurrentMonth = month;
  document.querySelectorAll('#app-month-picker .fin-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _renderAppTable(month, null);
}

function _renderAppTable(month, curDaysIn) {
  const apps   = (window._appHistory || {})[month] || [];
  const appEl  = document.getElementById('app-breakdown-inner');
  const appTag = document.getElementById('app-count-tag');

  if (appTag) appTag.textContent = apps.length ? `${apps.length} applications` : '—';
  if (!appEl) return;
  if (!apps.length) {
    appEl.innerHTML = '<div class="tr-load">No application data for this month.</div>';
    return;
  }

  const daysInMo    = new Date(parseInt(month.slice(0,4)), parseInt(month.slice(5,7)), 0).getDate();
  const isCurrentMo = month.slice(0,7) === new Date().toISOString().slice(0,7);
  const days        = isCurrentMo ? (curDaysIn || daysInMo) : daysInMo;
  const grandTotal  = apps.reduce((s, a) => s + a.total, 0) || 1;
  const envColors   = {production: 'var(--ok)', staging: 'var(--warn)', testing: 'var(--info)', development: 'var(--t3)'};

  // Look up the full monthly total from history so we can show attributed vs total.
  const histEntry   = (window._costHistory || []).find(h => h.month === month);
  const monthTotal  = histEntry ? histEntry.amount : (isCurrentMo ? (window._costMtdTotal || 0) : 0);
  const attrPct     = monthTotal > 0 ? Math.round(grandTotal / monthTotal * 100) : null;
  const attrFooter  = monthTotal > 0
    ? `<div class="muted" style="font-size:11px;padding:6px 8px">
         Attributed: <strong>$${grandTotal.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
         of ${isCurrentMo ? 'MTD' : 'total'}
         <strong>$${monthTotal.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
         (${attrPct}%) — remainder is untagged or excluded line items
       </div>`
    : '';

  appEl.innerHTML = `
    <div class="tscroll">
      <table class="dt">
        <thead><tr>
          <th>Application</th><th>Country</th><th>Compute</th>
          <th>Storage</th><th>Infra Share</th><th>Total</th>
          <th>% of Attributed</th><th>Daily Avg</th>
        </tr></thead>
        <tbody>
          ${apps.map(a => {
            const pct      = Math.round(a.total / grandTotal * 100);
            const dailyAvg = '$' + (a.total / days).toFixed(2);
            const envColor = envColors[a.environment] || 'var(--t3)';
            const envBadge = a.environment
              ? `<span style="font-size:9px;color:${envColor};border:1px solid ${envColor};border-radius:3px;padding:1px 4px;margin-left:4px;vertical-align:middle">${esc(a.environment)}</span>`
              : '';
            const isEks    = a.display_name === 'EKS Cluster Nodes';
            const rowStyle = isEks ? 'opacity:0.75;font-style:italic' : '';
            const eksBadge = isEks
              ? `<span style="font-size:9px;color:var(--warn);border:1px solid var(--warn);border-radius:3px;padding:1px 4px;margin-left:4px;vertical-align:middle">split pending</span>`
              : envBadge;
            return `<tr style="${rowStyle}">
              <td>
                <div style="font-size:13px;font-weight:500;color:var(--t1)">${esc(a.display_name)}${eksBadge}</div>
                <div class="muted mono" style="font-size:10px">${a.namespaces.map(n => esc(n)).join(', ')}</div>
              </td>
              <td style="font-size:12px;color:var(--t2)">${esc(a.country || '—')}</td>
              <td style="color:var(--info)">$${a.compute_cost.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
              <td style="color:var(--warn)">$${a.storage_cost.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
              <td class="muted">$${a.infra_share.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
              <td style="font-weight:600;color:var(--t1)">$${a.total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
              <td><div class="bar-row"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--info)"></div></div><div class="bar-lbl">${pct}%</div></div></td>
              <td class="muted">${dailyAvg}/day</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${attrFooter}`;
}

function _exportAppExcel() {
  const month = window._appCurrentMonth;
  const apps  = (window._appHistory || {})[month] || [];
  if (!apps.length) { alert('No application data to export.'); return; }

  const daysInMo    = new Date(parseInt(month.slice(0,4)), parseInt(month.slice(5,7)), 0).getDate();
  const isCurrentMo = month.slice(0,7) === new Date().toISOString().slice(0,7);
  const days        = isCurrentMo ? (window._costDaysIn || daysInMo) : daysInMo;
  const grandTotal  = apps.reduce((s, a) => s + a.total, 0) || 1;
  const monthLabel  = new Date(month + 'T12:00:00').toLocaleDateString('en-US', {month:'long', year:'numeric'});

  const header = [
    'Application', 'Country', 'Environment',
    'Compute (USD)', 'Storage (USD)', 'Infra Share (USD)',
    'Total (USD)', '% of Total', 'Daily Avg (USD/day)',
    'Sources'
  ];

  const rows = apps.map(a => [
    a.display_name,
    a.country || '',
    a.environment || '',
    a.compute_cost,
    a.storage_cost,
    a.infra_share,
    a.total,
    parseFloat((a.total / grandTotal * 100).toFixed(1)),
    parseFloat((a.total / days).toFixed(2)),
    (a.namespaces || []).join(', ')
  ]);

  // Summary totals row
  rows.push([]);
  rows.push([
    'TOTAL', '', '',
    parseFloat(apps.reduce((s,a) => s + a.compute_cost, 0).toFixed(2)),
    parseFloat(apps.reduce((s,a) => s + a.storage_cost, 0).toFixed(2)),
    parseFloat(apps.reduce((s,a) => s + a.infra_share,  0).toFixed(2)),
    parseFloat(grandTotal.toFixed(2)),
    100,
    parseFloat((grandTotal / days).toFixed(2)),
    ''
  ]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);

  // Column widths
  ws['!cols'] = [
    {wch:34}, {wch:12}, {wch:14},
    {wch:15}, {wch:15}, {wch:18},
    {wch:13}, {wch:11}, {wch:18},
    {wch:50}
  ];

  // Bold the header row and totals row
  const totalRowIdx = rows.length; // 0-based after header
  [0, totalRowIdx].forEach(ri => {
    header.forEach((_, ci) => {
      const addr = XLSX.utils.encode_cell({r: ri, c: ci});
      if (!ws[addr]) return;
      ws[addr].s = { font: { bold: true } };
    });
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Cost by Application');

  // Metadata sheet
  const meta = XLSX.utils.aoa_to_sheet([
    ['Report', 'Living Goods — Cost by Application'],
    ['Period', monthLabel],
    ['Exported', new Date().toISOString().slice(0,19).replace('T',' ')],
    ['Currency', 'USD'],
    ['Note', 'Compute = EC2/EKS prorated by namespace resource requests. Storage = EBS PVC + snapshots. Infra Share = proportional share of shared infrastructure (VPN, ingress, cert-manager, etc.).']
  ]);
  meta['!cols'] = [{wch:12}, {wch:90}];
  XLSX.utils.book_append_sheet(wb, meta, 'About');

  XLSX.writeFile(wb, `LG_CostByApp_${month.slice(0,7)}.xlsx`);
}

function _closeSvcDrill(tab) {
  window._drillSvc = window._drillSvc || {};
  window._drillSvc[tab] = null;
  const el = document.getElementById('cost-svc-drill-' + tab);
  if (el) el.style.display = 'none';
}

function _showServiceDrilldown(serviceName, tab) {
  const drillEl = document.getElementById('cost-svc-drill-' + tab);
  if (!drillEl) return;

  window._drillSvc = window._drillSvc || { mtd: null, ytd: null };
  if (window._drillSvc[tab] === serviceName) {
    _closeSvcDrill(tab);
    return;
  }
  window._drillSvc[tab] = serviceName;

  const history  = window._resHistory || {};
  const resNames = window._resNames   || {};
  const months   = Object.keys(history).sort().reverse();
  const month    = months.find(m => history[m].some(r => r.service === serviceName)) || months[0];
  if (!month) { drillEl.style.display = 'none'; return; }

  const resources = history[month]
    .filter(r => r.service === serviceName)
    .sort((a, b) => b.amount - a.amount);
  if (!resources.length) { drillEl.style.display = 'none'; return; }

  const total      = resources.reduce((s, r) => s + r.amount, 0) || 1;
  const fmt        = v => '$' + Number(v).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
  const monthLabel = new Date(month + 'T12:00:00').toLocaleDateString('en-US', {month:'short', year:'numeric'});
  const isCurrentMo = month.slice(0, 7) === new Date().toISOString().slice(0, 7);
  const daysInMo    = new Date(parseInt(month.slice(0,4)), parseInt(month.slice(5,7)), 0).getDate();
  const days        = isCurrentMo ? (window._costDaysIn || daysInMo) : daysInMo;
  const shortName   = serviceName.replace('Amazon ', '').replace('AWS ', '');

  drillEl.style.display = '';
  drillEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
         padding:10px 0 8px;border-top:1px solid rgba(255,255,255,0.06);margin-top:8px">
      <span style="font-size:12px;color:var(--t2)">
        <strong style="color:var(--fg)">${esc(shortName)}</strong>
        &nbsp;·&nbsp;${resources.length} resource${resources.length !== 1 ? 's' : ''}
        &nbsp;·&nbsp;${esc(monthLabel)}
      </span>
      <button class="btn-sm muted" onclick="_closeSvcDrill('${tab}')"
              style="padding:2px 8px;font-size:11px">✕</button>
    </div>
    <div class="tscroll">
      <table class="dt">
        <thead><tr>
          <th>Resource</th><th>Region</th><th>Spend</th>
          <th>% of ${esc(shortName)}</th><th>Daily Avg</th>
        </tr></thead>
        <tbody>
          ${resources.map(r => {
            const pct   = Math.round(r.amount / total * 100);
            const daily = fmt(Math.round(r.amount / days * 100) / 100);
            const name  = resNames[r.resource_id] || '';
            return `<tr>
              <td>
                ${name ? `<div style="font-size:13px;font-weight:500;color:var(--t1);margin-bottom:2px">${esc(name)}</div>` : ''}
                <div class="mono" style="font-size:11px;color:var(--t3)">${esc(r.resource_id)}</div>
              </td>
              <td class="muted" style="font-size:11px">${esc(r.region || '—')}</td>
              <td style="font-weight:600;color:var(--info)">${fmt(r.amount)}</td>
              <td>
                <div class="bar-row">
                  <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--info)"></div></div>
                  <div class="bar-lbl">${pct}%</div>
                </div>
              </td>
              <td class="muted">${daily}/day</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ── COSTS ────────────────────────────────────────────── */

function _exportCostHistoryXLSX() {
  if (typeof XLSX === 'undefined') return;
  const history = window._costHistory || [];
  if (!history.length) return;

  const fmt = v => v != null ? Number(v).toFixed(2) : '';

  // Build rows newest-first, same order as the on-screen table
  const rows = [...history].reverse().map((m, i, arr) => {
    const prev      = arr[i + 1];
    const delta     = prev && prev.amount > 0 ? m.amount - prev.amount : null;
    const deltaPct  = prev && prev.amount > 0
      ? Math.round((delta / prev.amount) * 100) : null;
    const isCurrent = i === 0;

    const d = new Date(m.month);
    const daysInMo  = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const daysUsed  = isCurrent ? (window._costDaysIn || daysInMo) : daysInMo;
    const dailyAvg  = m.amount > 0 ? Math.round(m.amount / daysUsed * 100) / 100 : null;

    const signal = delta == null ? 'first'
                 : isCurrent    ? 'partial'
                 : delta < 0    ? '✓ saved'
                 : Math.abs(deltaPct) > 15 ? 'spike'
                 : 'higher';

    return {
      Month:           m.label + (isCurrent ? ' (current)' : ''),
      Spend:           m.amount != null ? +fmt(m.amount) : null,
      'vs Prior Month': deltaPct != null ? (delta > 0 ? '+' : '') + deltaPct + '%' : '—',
      '$ Change':      delta != null ? +fmt(delta) : null,
      'Daily Avg':     dailyAvg,
      Signal:          signal,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths
  ws['!cols'] = [
    { wch: 22 }, // Month
    { wch: 14 }, // Spend
    { wch: 16 }, // vs Prior Month
    { wch: 14 }, // $ Change
    { wch: 14 }, // Daily Avg
    { wch: 10 }, // Signal
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Monthly Costs');
  const ts = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `LivingGoods-MonthlyCosts-${ts}.xlsx`);
}

function renderCosts(cost) {
  if (!cost || cost.error) return;

  const fmt     = v => v != null ? '$' + Number(v).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';
  const fmtK    = v => v != null ? '$' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0)) : '—';
  const colors  = ['#4fc3f7','#81c784','#ffb74d','#ce93d8','#f06292','#90a4ae','#4db6ac','#ff8a65','#a5d6a7','#80cbc4'];

  window._costDaysIn    = cost.days_in_month;
  window._costHistory   = cost.monthly_history || [];
  window._costMtdTotal  = cost.mtd || 0;

  // ── Data lag notice timestamp ──────────────────────────
  const lagEl = document.getElementById('cost-collected-at');
  if (lagEl && cost.collected_at) {
    const d = new Date(cost.collected_at);
    const yesterday = new Date(d);
    yesterday.setDate(yesterday.getDate() - 1);
    const dataDate = yesterday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    lagEl.textContent = `Data reflects spend up to approx. ${dataDate}.`;
  }

  // ── THIS MONTH TAB ──────────────────────────────────
  setText('c-mtd', fmt(cost.mtd));
  const mtdSubEl = document.getElementById('c-mtd-sub');
  if (mtdSubEl) {
    const dataDate = cost.collected_at
      ? new Date(new Date(cost.collected_at).setDate(new Date(cost.collected_at).getDate()-1))
          .toLocaleDateString('en-US', {month:'short', day:'numeric'})
      : 'yesterday';
    mtdSubEl.textContent =
      `Day ${cost.days_in_month} of ${cost.days_total} · $${cost.daily_avg}/day · data as of ${dataDate}`;
  }

  setText('c-fc', fmt(cost.forecast));
  const fcSubEl = document.getElementById('c-fc-sub');
  if (fcSubEl) fcSubEl.textContent =
    `3-month avg · $${cost.daily_avg}/day`;

  // Last month
  setText('c-lastmo', fmt(cost.last_month));
  const lastMoSub = document.getElementById('c-lastmo-sub');
  if (lastMoSub) lastMoSub.textContent =
    datetime_label_last_month();

  // MoM change — daily average this month vs daily average last month (like-for-like)
  const momPct  = cost.mom_change_pct ?? 0;
  const momUp   = momPct > 0;
  const momEl   = document.getElementById('c-mom');
  if (momEl) {
    momEl.textContent = (momUp ? '↑ ' : '↓ ') + Math.abs(momPct) + '%';
    momEl.style.color = momUp ? 'var(--crit)' : 'var(--ok)';
  }
  const momSub = document.getElementById('c-mom-sub');
  if (momSub) {
    const thisDailyFmt = fmt(cost.daily_avg);
    const lastDailyFmt = fmt(cost.last_month_daily ?? 0);
    momSub.innerHTML = `<span style="color:${momUp ? 'var(--crit)' : 'var(--ok)'}">$${thisDailyFmt}/day this month vs $${lastDailyFmt}/day last month</span>`;
  }

  // Budget progress bar — tracks actual MTD spend, red only if over budget
  const budget = cost.monthly_budget || 20000;
  if (budget > 0) {
    const budgetWrap = document.getElementById('cost-budget-bar-wrap');
    if (budgetWrap) budgetWrap.style.display = '';
    const mtd     = cost.mtd || 0;
    const over    = mtd > budget;
    const pct     = Math.min(Math.round(mtd / budget * 100), 100);
    const color   = over ? 'var(--crit)' : 'var(--ok)';
    setText('cost-budget-total', fmt(budget));
    const fillEl = document.getElementById('cost-budget-fill');
    if (fillEl) {
      fillEl.style.width      = pct + '%';
      fillEl.style.background = color;
    }
    const statusEl = document.getElementById('cost-budget-status');
    if (statusEl) {
      statusEl.textContent = over
        ? `↑ ${Math.round((mtd / budget - 1) * 100)}% over budget`
        : `${pct}% of budget`;
      statusEl.style.color = color;
    }
    const forecastLbl = document.getElementById('cost-budget-forecast-lbl');
    if (forecastLbl) {
      forecastLbl.textContent = fmt(mtd);
      forecastLbl.style.color = 'var(--fg)';
    }
    const remainLbl = document.getElementById('cost-budget-remaining-lbl');
    if (remainLbl) {
      const rem = budget - mtd;
      remainLbl.textContent = rem >= 0 ? `${fmt(rem)} remaining` : `${fmt(Math.abs(rem))} over`;
      remainLbl.style.color = rem >= 0 ? 'var(--ok)' : 'var(--crit)';
    }
  }

  // Service bars MTD
  const services = cost.by_service || [];
  const barsEl   = document.getElementById('cost-bars-mtd');
  if (barsEl && services.length) {
    const maxAmt = services[0]?.amount || 1;
    barsEl.innerHTML = services.map((s, i) => `
      <div class="cb-row" style="cursor:pointer;border-radius:4px;transition:background 0.15s"
           title="Click to see resources"
           data-svc="${esc(s.service)}"
           onclick="_showServiceDrilldown(this.dataset.svc,'mtd')"
           onmouseover="this.style.background='rgba(255,255,255,0.04)'"
           onmouseout="this.style.background=''">
        <span style="min-width:150px;font-size:12px">${esc(s.service.replace('Amazon ','').replace('AWS ',''))}</span>
        <div class="cb-bg"><div class="cb-fill" style="width:${Math.round(s.amount/maxAmt*100)}%;background:${colors[i%colors.length]}"></div></div>
        <span class="cb-val" style="min-width:80px;text-align:right">${fmt(s.amount)}</span>
        <span class="muted" style="font-size:11px;min-width:38px;text-align:right">${s.pct}%</span>
      </div>`).join('');
  }

  // Daily spend — SVG bar chart with moving-average trend line
  const trend   = cost.daily_trend || [];
  const sparkEl = document.getElementById('daily-spark');
  if (sparkEl && trend.length) {
    const n      = trend.length;
    const maxDay = Math.max(...trend.map(d => d.amount), 1);
    const avg    = cost.daily_avg || 1;

    // Chart geometry (viewBox units)
    const barW  = 8, gap = 3;
    const VW    = n * (barW + gap) - gap;
    const VH    = 80;
    const PAD_T = 10;
    const chartH = VH - PAD_T;

    // Bars
    const bars = trend.map((d, i) => {
      const bh = Math.max(2, (d.amount / maxDay) * chartH);
      const x  = i * (barW + gap);
      const y  = PAD_T + chartH - bh;
      const c  = d.amount >= avg * 1.5 ? 'var(--crit)'
               : d.amount >= avg       ? 'var(--warn)'
               : 'rgba(79,195,247,.75)';
      return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="1" fill="${c}"><title>${d.date.slice(5)}: ${fmt(d.amount)}</title></rect>`;
    }).join('');

    // 5-day centred moving average for the trend line
    const amounts  = trend.map(d => d.amount);
    const smoothed = amounts.map((_, i) => {
      const sl = amounts.slice(Math.max(0, i - 2), Math.min(n, i + 3));
      return sl.reduce((s, v) => s + v, 0) / sl.length;
    });

    // Catmull-Rom → cubic bezier so the line curves naturally
    const pts = smoothed.map((v, i) => [i * (barW + gap) + barW / 2, PAD_T + chartH - (v / maxDay) * chartH]);
    function toBezier(ps) {
      if (ps.length < 2) return '';
      let d = `M${ps[0][0]},${ps[0][1]}`;
      for (let i = 1; i < ps.length; i++) {
        const p0 = ps[Math.max(0, i - 2)], p1 = ps[i - 1], p2 = ps[i], p3 = ps[Math.min(ps.length - 1, i + 1)];
        const cp1x = p1[0] + (p2[0] - p0[0]) / 6, cp1y = p1[1] + (p2[1] - p0[1]) / 6;
        const cp2x = p2[0] - (p3[0] - p1[0]) / 6, cp2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
      }
      return d;
    }

    // Average dashed reference line
    const avgY = PAD_T + chartH - (avg / maxDay) * chartH;

    sparkEl.innerHTML = `<svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none"
        style="width:100%;height:100%;display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">
      ${bars}
      <line x1="0" y1="${avgY}" x2="${VW}" y2="${avgY}"
        stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="4 3"/>
      <path d="${toBezier(pts)}" fill="none"
        stroke="rgba(255,255,255,0.75)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }

  // Daily stats — exclude last 2 days (CUR has ~24h lag; recent days are partial)
  const statsEl = document.getElementById('daily-stats');
  if (statsEl && trend.length) {
    const settled  = trend.slice(0, -2);
    const amounts  = (settled.length ? settled : trend).map(d => d.amount).filter(a => a > 0);
    const high     = Math.max(...amounts);
    const low      = Math.min(...amounts);
    const highDay  = (settled.length ? settled : trend).find(d => d.amount === high);
    const lowDay   = (settled.length ? settled : trend).find(d => d.amount === low);
    const isMonthStart = highDay?.date?.endsWith('-01');
    const highNote = isMonthStart
      ? `<div style="font-size:9px;color:var(--warn);margin-top:4px;line-height:1.4">AWS batches monthly fees<br>on the 1st (support, reservations)</div>`
      : '';
    statsEl.innerHTML = `
      <div style="background:var(--bg3);border-radius:var(--radius);padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:600;color:${isMonthStart ? 'var(--warn)' : 'var(--crit)'}">${fmt(high)}</div>
        <div style="font-size:10px;color:var(--t3)">Highest day${highDay ? ' · '+highDay.date.slice(5) : ''}</div>
        ${highNote}
      </div>
      <div style="background:var(--bg3);border-radius:var(--radius);padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:600;color:var(--ok)">${fmt(low)}</div>
        <div style="font-size:10px;color:var(--t3)">Lowest day${lowDay ? ' · '+lowDay.date.slice(5) : ''}</div>
      </div>
      <div style="background:var(--bg3);border-radius:var(--radius);padding:10px;text-align:center">
        <div style="font-size:18px;font-weight:600;color:var(--info)">${fmt(cost.daily_avg)}</div>
        <div style="font-size:10px;color:var(--t3)">Daily average</div>
      </div>`;
  }

  // Spike alert — skip 1st of month (AWS batches monthly charges there)
  const spikeAlertEl = document.getElementById('cost-spike-alert');
  if (spikeAlertEl) {
    const settled = trend.slice(0, -2).filter(d => !d.date.endsWith('-01'));
    const trendAvg = settled.length
      ? settled.reduce((s, d) => s + d.amount, 0) / settled.length
      : 0;
    const spikes = trendAvg > 0 ? settled.filter(d => d.amount >= trendAvg * 1.5) : [];
    if (spikes.length > 0) {
      const worst = spikes.reduce((a, b) => a.amount > b.amount ? a : b);
      spikeAlertEl.style.display = '';
      spikeAlertEl.innerHTML = `⚠ <strong>Spend spike${spikes.length > 1 ? 's' : ''} detected:</strong> ${spikes.length} day${spikes.length > 1 ? 's' : ''} exceeded 1.5× 30-day avg (${fmt(Math.round(trendAvg * 100) / 100)}/day). Worst: <strong>${fmt(worst.amount)}</strong> on ${worst.date}.`;
    } else {
      spikeAlertEl.style.display = 'none';
    }
  }

  // ── YTD TAB ─────────────────────────────────────────
  setText('c-ytd', fmt(cost.ytd));
  const monthsElapsed = date_today().getMonth() + 1; // Jan=1
  const moAvg = cost.ytd > 0 ? Math.round(cost.ytd / monthsElapsed * 100) / 100 : 0;
  const fullYearProj = Math.round(moAvg * 12 * 100) / 100;
  setText('c-ytd-sub', `Jan – present · ${monthsElapsed} months`);
  setText('c-ytd-mo-avg', fmt(moAvg));
  setText('c-ytd-proj',   fmt(fullYearProj));

  const fc12 = cost.forecast_12m || [];
  if (fc12.length) {
    const next12Total = Math.round(fc12.reduce((s, m) => s + m.amount, 0) * 100) / 100;
    const next12Low   = Math.round(fc12.reduce((s, m) => s + m.lower,  0) * 100) / 100;
    const next12High  = Math.round(fc12.reduce((s, m) => s + m.upper,  0) * 100) / 100;
    setText('c-next12-forecast',     fmt(next12Total));
    setText('c-next12-forecast-sub', `Range: ${fmt(next12Low)} – ${fmt(next12High)}`);
  }

  // YTD service bars — cumulative YTD from backend
  const ytdServices = cost.by_service_ytd || [];
  const ytdBars = document.getElementById('cost-bars-ytd');
  if (ytdBars) {
    if (ytdServices.length) {
      const maxAmt = ytdServices[0]?.amount || 1;
      ytdBars.innerHTML = ytdServices.map((s, i) => `
        <div class="cb-row" style="cursor:pointer;border-radius:4px;transition:background 0.15s"
             title="Click to see resources"
             data-svc="${esc(s.service)}"
             onclick="_showServiceDrilldown(this.dataset.svc,'ytd')"
             onmouseover="this.style.background='rgba(255,255,255,0.04)'"
             onmouseout="this.style.background=''">
          <span style="min-width:150px;font-size:12px">${esc(s.service.replace('Amazon ','').replace('AWS ',''))}</span>
          <div class="cb-bg"><div class="cb-fill" style="width:${Math.round(s.amount/maxAmt*100)}%;background:${colors[i%colors.length]}"></div></div>
          <span class="cb-val" style="min-width:80px;text-align:right">${fmt(s.amount)}</span>
          <span class="muted" style="font-size:11px;min-width:38px;text-align:right">${s.pct}%</span>
        </div>`).join('');
    } else {
      ytdBars.innerHTML = '<div class="tr-load" style="color:var(--t3)">YTD breakdown collects at 03:00 UTC — check back after the next refresh.</div>';
    }
  }

  // YTD monthly bars
  const history      = cost.monthly_history || [];
  const ytdMonthsEl  = document.getElementById('ytd-monthly-bars');
  if (ytdMonthsEl && history.length) {
    const ytdOnly = history.filter(m => m.month >= date_today().getFullYear() + '-01');
    const maxH = Math.max(...ytdOnly.map(m => m.amount), 1);
    ytdMonthsEl.innerHTML = ytdOnly.map(m => `
      <div class="cb-row">
        <span style="min-width:70px;font-size:12px">${esc(m.label)}</span>
        <div class="cb-bg"><div class="cb-fill" style="width:${Math.round(m.amount/maxH*100)}%;background:var(--info)"></div></div>
        <span class="cb-val" style="min-width:80px;text-align:right">${fmt(m.amount)}</span>
        ${m.estimated ? '<span class="muted" style="font-size:10px">est.</span>' : ''}
      </div>`).join('');
  }

  // ── 12-MONTH HISTORY TAB ─────────────────────────────
  if (history.length) {
    const completedMonths = history.filter(m => !m.estimated);
    const amounts  = history.map(m => m.amount).filter(a => a > 0);
    const histAvg  = amounts.length
      ? Math.round(amounts.reduce((s,a) => s+a, 0) / amounts.length * 100) / 100
      : 0;

    // Best / worst (exclude current partial month)
    const completed = history.slice(0, -1).filter(m => m.amount > 0);
    const bestMonth  = completed.length ? completed.reduce((a,b) => a.amount < b.amount ? a : b) : null;
    const worstMonth = completed.length ? completed.reduce((a,b) => a.amount > b.amount ? a : b) : null;

    // Overall trend — compare first half avg vs second half avg
    const mid       = Math.floor(history.length / 2);
    const firstHalf = history.slice(0, mid).map(m => m.amount);
    const secHalf   = history.slice(mid).map(m => m.amount);
    const firstAvg  = firstHalf.reduce((s,a) => s+a, 0) / (firstHalf.length || 1);
    const secAvg    = secHalf.reduce((s,a)  => s+a, 0) / (secHalf.length  || 1);
    const trendUp   = secAvg > firstAvg;
    const trendPct  = firstAvg > 0 ? Math.abs(Math.round((secAvg - firstAvg) / firstAvg * 100)) : 0;

    // Total saved vs budget baseline (or worst × 12 if no budget set)
    const actualTotal = amounts.reduce((s,a) => s+a, 0);
    let totalSaved, savedSub;
    if (budget > 0) {
      const budgetBaseline = budget * amounts.length;
      totalSaved = Math.max(0, Math.round((budgetBaseline - actualTotal) * 100) / 100);
      savedSub   = `vs $${(budget / 1000).toFixed(0)}k/mo budget × ${amounts.length} mo`;
    } else {
      const potentialWorst = worstMonth ? worstMonth.amount * 12 : 0;
      totalSaved = worstMonth ? Math.max(0, Math.round((potentialWorst - actualTotal) * 100) / 100) : 0;
      savedSub   = worstMonth ? `vs ${worstMonth.label} rate × 12` : 'vs worst month × 12';
    }

    // ── Summary strip ──────────────────────────────────
    const trendEl = document.getElementById('hs-trend-val');
    if (trendEl) {
      trendEl.textContent = trendUp ? `↑ ${trendPct}% up` : `↓ ${trendPct}% down`;
      trendEl.style.color = trendUp ? 'var(--crit)' : 'var(--ok)';
    }
    const trendSub = document.getElementById('hs-trend-sub');
    if (trendSub) trendSub.textContent = trendUp
      ? 'Costs rising over 12 months'
      : 'Costs declining over 12 months';

    const trendCard = document.getElementById('hs-trend');
    if (trendCard) trendCard.style.borderTop = `2px solid ${trendUp ? 'var(--crit)' : 'var(--ok)'}`;

    setText('hs-best-val',  bestMonth  ? fmt(bestMonth.amount)  : '—');
    setText('hs-best-sub',  bestMonth  ? bestMonth.label        : '—');
    setText('hs-worst-val', worstMonth ? fmt(worstMonth.amount) : '—');
    setText('hs-worst-sub', worstMonth ? worstMonth.label       : '—');
    setText('hs-avg-val',   fmt(histAvg));
    setText('hs-saved-val', totalSaved > 0 ? fmt(totalSaved) : '$0');
    setText('hs-saved-sub', savedSub);

    const avgTag = document.getElementById('hist-avg-tag');
    if (avgTag) avgTag.textContent = `12-mo avg: ${fmt(histAvg)}/mo`;

    // ── Bar chart ──────────────────────────────────────
    const maxH    = Math.max(...amounts, 1);
    const barsDiv = document.getElementById('hist-bars');
    if (barsDiv) {
      barsDiv.innerHTML = history.map((m, i) => {
        const prev          = i > 0 ? history[i-1] : null;
        const isCurrentMo   = i === history.length - 1;
        const delta         = prev && prev.amount > 0 ? m.amount - prev.amount : null;
        const saved         = delta != null && delta < 0;
        const lost          = delta != null && delta > 0;
        const barH          = Math.max(4, Math.round((m.amount / maxH) * 160));
        const barColor      = isCurrentMo  ? 'var(--warn)'
                            : saved        ? 'var(--ok)'
                            : lost         ? 'var(--crit)'
                            : 'var(--t3)';

        // Delta pip on top of bar
        const deltaH   = delta != null ? Math.max(2, Math.round((Math.abs(delta) / maxH) * 160)) : 0;
        const deltaPip = delta != null ? `
          <div title="${saved ? 'Saved' : 'Extra'}: ${fmt(Math.abs(delta))}"
            style="width:100%;height:${deltaH}px;
            background:${saved ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'};
            border:1px dashed ${saved ? 'var(--ok)' : 'var(--crit)'};
            border-radius:2px 2px 0 0;margin-bottom:1px;min-width:8px"></div>` : '';

        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:0">
          ${deltaPip}
          <div title="${m.label}: ${fmt(m.amount)}"
            style="width:100%;height:${barH}px;background:${barColor};
            border-radius:3px 3px 0 0;cursor:default;min-width:8px;
            transition:opacity 0.15s"
            onmouseover="this.style.opacity='0.8'"
            onmouseout="this.style.opacity='1'">
          </div>
        </div>`;
      }).join('');
    }

    // Labels
    const labelsDiv = document.getElementById('hist-labels');
    if (labelsDiv) {
      labelsDiv.innerHTML = history.map((m, i) => {
        const isCurrentMo = i === history.length - 1;
        return `<div style="flex:1;text-align:center;font-size:9px;
          color:${isCurrentMo ? 'var(--warn)' : 'var(--t3)'};
          font-weight:${isCurrentMo ? '600' : '400'};
          overflow:hidden;white-space:nowrap">${m.label.slice(0,3)}</div>`;
      }).join('');
    }

    // ── 12-month forward forecast ──────────────────────
    const forecast12 = cost.forecast_12m || [];
    if (forecast12.length && barsDiv && labelsDiv) {
      const allAmounts = [...history.map(m => m.amount), ...forecast12.map(m => m.upper)].filter(a => a > 0);
      const combinedMax = Math.max(...allAmounts, 1);

      // Separator column
      const sepBar = `<div style="flex:0 0 16px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end">
        <div style="width:1px;height:120px;background:rgba(255,255,255,0.12);border-left:1px dashed rgba(255,255,255,0.18)"></div>
      </div>`;
      const sepLabel = `<div style="flex:0 0 16px;text-align:center;font-size:9px;color:var(--t3)"></div>`;

      const forecastBars = forecast12.map(m => {
        const barH     = Math.max(4, Math.round((m.amount / combinedMax) * 160));
        const upperH   = Math.max(0, Math.round(((m.upper - m.amount) / combinedMax) * 160));
        const lowerH   = Math.max(0, Math.round(((m.amount - m.lower) / combinedMax) * 160));
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:0" title="${m.label}: ${fmt(m.amount)} (range ${fmt(m.lower)}–${fmt(m.upper)})">
          <div style="width:100%;height:${upperH}px;background:rgba(99,179,237,0.15);border:1px dashed rgba(99,179,237,0.35);border-bottom:none;border-radius:2px 2px 0 0;min-width:8px"></div>
          <div style="width:100%;height:${barH}px;background:rgba(99,179,237,0.35);border-radius:0 0 3px 3px;min-width:8px"></div>
        </div>`;
      }).join('');

      const forecastLabels = forecast12.map(m =>
        `<div style="flex:1;text-align:center;font-size:9px;color:rgba(99,179,237,0.7);overflow:hidden;white-space:nowrap">${m.label.slice(0,3)}</div>`
      ).join('');

      // Rebuild both containers to use combinedMax so scales match.
      const histBars = history.map((m, i) => {
        const prev        = i > 0 ? history[i-1] : null;
        const isCurrentMo = i === history.length - 1;
        const delta       = prev && prev.amount > 0 ? m.amount - prev.amount : null;
        const saved       = delta != null && delta < 0;
        const lost        = delta != null && delta > 0;
        const barH        = Math.max(4, Math.round((m.amount / combinedMax) * 160));
        const barColor    = isCurrentMo ? 'var(--warn)' : saved ? 'var(--ok)' : lost ? 'var(--crit)' : 'var(--t3)';
        const deltaH      = delta != null ? Math.max(2, Math.round((Math.abs(delta) / combinedMax) * 160)) : 0;
        const deltaPip    = delta != null ? `<div title="${saved ? 'Saved' : 'Extra'}: ${fmt(Math.abs(delta))}"
            style="width:100%;height:${deltaH}px;background:${saved ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'};border:1px dashed ${saved ? 'var(--ok)' : 'var(--crit)'};border-radius:2px 2px 0 0;margin-bottom:1px;min-width:8px"></div>` : '';
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:0">
          ${deltaPip}
          <div title="${m.label}: ${fmt(m.amount)}" style="width:100%;height:${barH}px;background:${barColor};border-radius:3px 3px 0 0;cursor:default;min-width:8px;transition:opacity 0.15s" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'"></div>
        </div>`;
      }).join('');

      const histLabels = history.map((m, i) => {
        const isCurrentMo = i === history.length - 1;
        return `<div style="flex:1;text-align:center;font-size:9px;color:${isCurrentMo ? 'var(--warn)' : 'var(--t3)'};font-weight:${isCurrentMo ? '600' : '400'};overflow:hidden;white-space:nowrap">${m.label.slice(0,3)}</div>`;
      }).join('');

      barsDiv.innerHTML   = histBars   + sepBar   + forecastBars;
      labelsDiv.innerHTML = histLabels + sepLabel  + forecastLabels;
    }

    // ── Detail table ───────────────────────────────────
    const histTbody = document.getElementById('hist-tbody');
    if (histTbody) {
      const forecastRows = forecast12.length
        ? `<tr><td colspan="6" style="padding:4px 8px;font-size:10px;font-weight:600;color:rgba(99,179,237,0.8);letter-spacing:0.08em;border-top:1px dashed rgba(255,255,255,0.12)">12-MONTH PROJECTION</td></tr>`
          + forecast12.map(m => `<tr style="opacity:0.72">
            <td style="color:rgba(99,179,237,0.9)">${esc(m.label)}<span class="badge" style="margin-left:6px;font-size:9px;background:rgba(99,179,237,0.15);color:rgba(99,179,237,0.8)">projected</span></td>
            <td style="font-weight:600;color:rgba(99,179,237,0.9)">${fmt(m.amount)}</td>
            <td><span class="muted">—</span></td>
            <td><span class="muted" style="font-size:10px">${fmt(m.lower)} – ${fmt(m.upper)}</span></td>
            <td class="muted">${fmt(Math.round(m.amount / new Date(new Date(m.month).getFullYear(), new Date(m.month).getMonth()+1, 0).getDate() * 100)/100)}/day</td>
            <td><span class="badge" style="background:rgba(99,179,237,0.12);color:rgba(99,179,237,0.7)">forecast</span></td>
          </tr>`).join('')
        : '';

      histTbody.innerHTML = [...history].reverse().map((m, i, arr) => {
        const prev      = arr[i + 1];
        const delta     = prev && prev.amount > 0 ? m.amount - prev.amount : null;
        const deltaPct  = prev && prev.amount > 0
          ? Math.round((delta / prev.amount) * 100) : null;
        const saved     = delta != null && delta < 0;
        const isCurrent = i === 0;

        const changeHtml = deltaPct != null
          ? `<span style="color:${saved ? 'var(--ok)' : 'var(--crit)'};font-weight:500">
              ${saved ? '↓' : '↑'} ${Math.abs(deltaPct)}%
             </span>`
          : '<span class="muted">—</span>';

        const deltaHtml = delta != null
          ? `<span style="color:${saved ? 'var(--ok)' : 'var(--crit)'};font-family:'DM Mono',monospace">
              ${saved ? '-' : '+'}${fmt(Math.abs(delta))}
             </span>`
          : '<span class="muted">—</span>';

        // Days in month for daily avg
        const d = new Date(m.month);
        const daysInMo = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
        const dailyAvg = m.amount > 0
          ? fmt(Math.round(m.amount / (isCurrent ? cost.days_in_month : daysInMo) * 100)/100)
          : '—';

        const signal = delta == null     ? '<span class="badge" style="background:rgba(255,255,255,0.05);color:var(--t3)">first</span>'
                     : isCurrent         ? '<span class="badge warn">partial</span>'
                     : saved             ? '<span class="badge ok">✓ saved</span>'
                     : Math.abs(deltaPct) > 15 ? '<span class="badge crit">spike</span>'
                     : '<span class="badge crit">higher</span>';

        return `<tr style="${isCurrent ? 'background:rgba(251,191,36,0.04)' : ''}">
          <td style="font-weight:${isCurrent ? '600' : '400'}">
            ${esc(m.label)}
            ${isCurrent ? '<span class="badge warn" style="margin-left:6px;font-size:9px">current</span>' : ''}
            ${m.estimated ? '<span class="muted" style="font-size:10px;margin-left:4px">est.</span>' : ''}
          </td>
          <td style="font-weight:600;color:var(--info)">${fmt(m.amount)}</td>
          <td>${changeHtml}</td>
          <td>${deltaHtml}</td>
          <td class="muted">${dailyAvg}/day</td>
          <td>${signal}</td>
        </tr>`;
      }).join('') + forecastRows;
    }
  }

  // ── BY RESOURCE TAB ───────────────────────────────────
  const resHistory  = cost.by_resource || {};
  const resMonths   = Object.keys(resHistory).sort().reverse(); // newest first
  const pickerEl    = document.getElementById('resource-month-picker');
  const resEl       = document.getElementById('resource-breakdown-inner');
  const resTag      = document.getElementById('resource-count-tag');

  window._resHistory = resHistory;
  window._resNames   = cost.resource_names || {};

  if (pickerEl) {
    if (resMonths.length) {
      pickerEl.innerHTML = resMonths.map((m, i) => {
        const label = new Date(m + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', year: '2-digit'});
        return `<button class="fin-tab${i === 0 ? ' active' : ''}" onclick="_selectResMo('${m}',this)">${label}</button>`;
      }).join('');
    } else {
      pickerEl.innerHTML = '';
    }
  }

  if (resMonths.length) {
    _renderResourceTable(resMonths[0], resTag, resEl, cost.days_in_month);
  } else if (resEl) {
    resEl.innerHTML = '<div class="tr-load">No resource data yet — available after first CUR refresh.</div>';
    if (resTag) resTag.textContent = '—';
  }

  // ── BY INSTANCE TAB ──────────────────────────────────
  const instHistory = cost.by_instance || {};
  const instMonths  = Object.keys(instHistory).sort().reverse();
  const instPicker  = document.getElementById('instance-month-picker');
  window._instHistory  = instHistory;
  window._instResNames = cost.resource_names || {};
  if (instPicker) {
    instPicker.innerHTML = instMonths.map((m, i) => {
      const label = new Date(m + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', year: '2-digit'});
      return `<button class="fin-tab${i === 0 ? ' active' : ''}" onclick="_selectInstMo('${m}',this)">${label}</button>`;
    }).join('');
  }
  if (instMonths.length) {
    _renderInstanceTable(instMonths[0], cost.days_in_month);
  } else {
    const instEl = document.getElementById('instance-breakdown-inner');
    if (instEl) instEl.innerHTML = '<div class="tr-load">No instance data yet — available after first CUR refresh.</div>';
    const instTag = document.getElementById('instance-count-tag');
    if (instTag) instTag.textContent = '—';
  }

  // ── BY APPLICATION TAB ───────────────────────────────
  const appHistory = cost.by_application || {};
  const appMonths  = Object.keys(appHistory).sort().reverse();
  const appPicker  = document.getElementById('app-month-picker');
  window._appHistory = appHistory;
  if (appPicker) {
    appPicker.innerHTML = appMonths.map((m, i) => {
      const label = new Date(m + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', year: '2-digit'});
      return `<button class="fin-tab${i === 0 ? ' active' : ''}" onclick="_selectAppMo('${m}',this)">${label}</button>`;
    }).join('');
  }
  if (appMonths.length) {
    window._appCurrentMonth = appMonths[0];
    _renderAppTable(appMonths[0], cost.days_in_month);
  } else {
    const appEl = document.getElementById('app-breakdown-inner');
    if (appEl) appEl.innerHTML = '<div class="tr-load">No application data yet — available after first CUR refresh.</div>';
    const appTag = document.getElementById('app-count-tag');
    if (appTag) appTag.textContent = '—';
  }

  // ── COST DRIVERS TAB ─────────────────────────────────
  _initCostDrivers(cost);

  // ── BY ACCOUNT TAB ────────────────────────────────────
  const accounts = cost.by_account || [];
  const acctEl   = document.getElementById('acct-breakdown-inner');
  const acctTag  = document.getElementById('acct-count-tag');
  if (acctTag) acctTag.textContent = accounts.length + ' accounts';
  if (acctEl) {
    if (!accounts.length) {
      acctEl.innerHTML = '<div class="tr-load">No multi-account data. Requires AWS Organizations.</div>';
    } else {
      acctEl.innerHTML = `
        <div class="tscroll">
          <table class="dt">
            <thead><tr><th>Account ID</th><th>MTD Spend</th><th>% of Total</th><th>Daily Avg</th></tr></thead>
            <tbody>
              ${accounts.map(a => {
                const pct = cost.mtd > 0 ? Math.round(a.amount / cost.mtd * 100) : 0;
                return `<tr>
                  <td class="mono">${esc(a.account_id)}</td>
                  <td style="font-weight:600;color:var(--info)">${fmt(a.amount)}</td>
                  <td>
                    <div class="bar-row">
                      <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:var(--info)"></div></div>
                      <div class="bar-lbl">${pct}%</div>
                    </div>
                  </td>
                  <td class="muted">${fmt(Math.round(a.amount / cost.days_in_month * 100)/100)}/day</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }
  }
}

// ── COST DRIVERS ─────────────────────────────────────────────────────────────

function _initCostDrivers(cost) {
  const all    = cost.cost_drivers || [];
  const months = [...new Set(all.map(d => d.month))].sort().reverse();

  window._allDrivers    = all;
  window._driverMonth   = months[0] || null;
  window._driverFilter  = 'all';

  const pickerEl = document.getElementById('drivers-month-picker');
  if (pickerEl) {
    pickerEl.innerHTML = months.map((m, i) => {
      const label = new Date(m + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', year: '2-digit'});
      return `<button class="fin-tab${i === 0 ? ' active' : ''}"
                onclick="_selectDriverMonth('${m}',this)">${label}</button>`;
    }).join('');
  }

  _renderDriversTrend(all);
  _renderDriverTable();
}

function _renderDriversTrend(all) {
  const el = document.getElementById('drivers-trend-chart');
  if (!el) return;

  // Aggregate per month: new_cost, removed_savings (abs), changed_net
  const monthOrder = [...new Set(all.map(d => d.month))].sort();
  if (monthOrder.length < 2) {
    el.innerHTML = '<div class="tr-load muted" style="font-size:12px">Trend available after 2+ months of CUR data.</div>';
    return;
  }

  const byMonth = {};
  monthOrder.forEach(m => { byMonth[m] = { new: 0, removed: 0, changed_up: 0, changed_down: 0 }; });
  all.forEach(d => {
    const b = byMonth[d.month];
    if (!b) return;
    if (d.driver_type === 'new')     b.new        += d.delta_usd;
    if (d.driver_type === 'removed') b.removed    += Math.abs(d.delta_usd);
    if (d.driver_type === 'changed') {
      if (d.delta_usd > 0) b.changed_up   += d.delta_usd;
      else                 b.changed_down += Math.abs(d.delta_usd);
    }
  });

  // Chart geometry
  const VW = 800, VH = 100, PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 20;
  const n        = monthOrder.length;
  const chartW   = VW - PAD_L - PAD_R;
  const chartH   = VH - PAD_T - PAD_B;
  const groupW   = chartW / n;
  const barW     = Math.min(groupW * 0.55, 28);
  const halfBar  = barW / 2;

  // Find max positive and max negative extent for zero-line placement
  const maxPos = Math.max(...monthOrder.map(m => byMonth[m].new + byMonth[m].changed_up), 1);
  const maxNeg = Math.max(...monthOrder.map(m => byMonth[m].removed + byMonth[m].changed_down), 1);
  const totalExtent = maxPos + maxNeg;
  // zero line Y position
  const zeroY  = PAD_T + (maxPos / totalExtent) * chartH;

  function yPos(v)  { return zeroY - (v / totalExtent) * chartH; }
  function yNeg(v)  { return zeroY + (v / totalExtent) * chartH; }

  const bars = monthOrder.map((m, i) => {
    const b     = byMonth[m];
    const cx    = PAD_L + i * groupW + groupW / 2;
    const x     = cx - halfBar;
    const net   = b.new + b.changed_up - b.removed - b.changed_down;

    // Stack positive bars upward: new (bottom of positive) then changed_up on top
    const yNew = yPos(b.new);
    const hNew = zeroY - yNew;

    const yChgUp = yPos(b.new + b.changed_up);
    const hChgUp = yNew - yChgUp;

    // Stack negative bars downward: removed then changed_down
    const yRem  = zeroY;
    const hRem  = yNeg(b.removed) - zeroY;

    const yChgDn = yNeg(b.removed);
    const hChgDn = yNeg(b.removed + b.changed_down) - yNeg(b.removed);

    // Net delta dot
    const netY   = net >= 0 ? yPos(net) : yNeg(Math.abs(net));
    const netCol = net > 0 ? 'var(--crit)' : net < 0 ? 'var(--ok)' : 'var(--t3)';

    const label  = new Date(m + 'T12:00:00').toLocaleDateString('en-US', {month:'short'});
    const fmtT   = v => '$' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0));
    const tip    = `${label}: +${fmtT(b.new + b.changed_up)} new/up · −${fmtT(b.removed + b.changed_down)} removed/down · net ${net >= 0 ? '+' : ''}${fmtT(Math.abs(net))}`;

    return `
      <g class="driver-bar-grp" style="cursor:pointer" onclick="_selectDriverMonth('${m}',null)"
         onmouseenter="this.style.opacity=0.8" onmouseleave="this.style.opacity=1">
        <title>${tip}</title>
        ${hNew  > 0 ? `<rect x="${x}" y="${yNew}"   width="${barW}" height="${hNew}"   rx="2" fill="var(--ok)"   opacity="0.85"/>` : ''}
        ${hChgUp > 0 ? `<rect x="${x}" y="${yChgUp}" width="${barW}" height="${hChgUp}" rx="2" fill="var(--warn)"  opacity="0.85"/>` : ''}
        ${hRem  > 0 ? `<rect x="${x}" y="${yRem}"   width="${barW}" height="${hRem}"   rx="2" fill="var(--crit)"  opacity="0.85"/>` : ''}
        ${hChgDn > 0 ? `<rect x="${x}" y="${yChgDn}" width="${barW}" height="${hChgDn}" rx="2" fill="var(--warn)"  opacity="0.65"/>` : ''}
        <circle cx="${cx}" cy="${netY}" r="3" fill="${netCol}" stroke="var(--bg1)" stroke-width="1.5"/>
        <text x="${cx}" y="${VH - 4}" text-anchor="middle"
              font-size="9" fill="var(--t3)">${label}</text>
      </g>`;
  }).join('');

  // Net delta connecting line through the dots
  const netPts = monthOrder.map((m, i) => {
    const b   = byMonth[m];
    const net = b.new + b.changed_up - b.removed - b.changed_down;
    const cx  = PAD_L + i * groupW + groupW / 2;
    const ny  = net >= 0 ? yPos(net) : yNeg(Math.abs(net));
    return `${cx},${ny}`;
  });

  function polyToBezier(pts) {
    if (pts.length < 2) return '';
    const ps = pts.map(p => p.split(',').map(Number));
    let d = `M${ps[0][0]},${ps[0][1]}`;
    for (let i = 1; i < ps.length; i++) {
      const p0 = ps[Math.max(0, i-2)], p1 = ps[i-1], p2 = ps[i], p3 = ps[Math.min(ps.length-1, i+1)];
      const cp1x = p1[0] + (p2[0]-p0[0])/6, cp1y = p1[1] + (p2[1]-p0[1])/6;
      const cp2x = p2[0] - (p3[0]-p1[0])/6, cp2y = p2[1] - (p3[1]-p1[1])/6;
      d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
    }
    return d;
  }

  el.innerHTML = `
    <svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none"
         style="width:100%;height:100%;display:block;overflow:visible">
      <!-- zero baseline -->
      <line x1="${PAD_L}" y1="${zeroY}" x2="${VW - PAD_R}" y2="${zeroY}"
            stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
      ${bars}
      <!-- net delta trend line -->
      <path d="${polyToBezier(netPts)}" fill="none"
            stroke="rgba(255,255,255,0.6)" stroke-width="1.5"
            stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="4 2"/>
    </svg>`;
}

function _selectDriverMonth(month, btn) {
  window._driverMonth = month;
  document.querySelectorAll('#drivers-month-picker .fin-tab').forEach(b => {
    b.classList.toggle('active', b.textContent.trim() !== '' &&
      new Date(month + 'T12:00:00').toLocaleDateString('en-US', {month:'short', year:'2-digit'}) === b.textContent.trim());
  });
  if (btn) {
    document.querySelectorAll('#drivers-month-picker .fin-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  _renderDriverTable();
}

function _filterDrivers(type, btn) {
  window._driverFilter = type;
  document.querySelectorAll('.driver-filter').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _renderDriverTable();
}

function _renderDriverTable() {
  const inner  = document.getElementById('drivers-inner');
  const tag    = document.getElementById('drivers-count-tag');
  const month  = window._driverMonth;
  const filter = window._driverFilter || 'all';
  const all    = window._allDrivers  || [];

  if (!inner) return;

  if (!all.length) {
    inner.innerHTML = '<div class="tr-load">No driver data yet — available after first CUR refresh.</div>';
    if (tag) tag.textContent = '—';
    return;
  }

  const fmt = v => v != null ? '$' + Math.abs(Number(v)).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';

  let rows = all.filter(d => d.month === month);
  if (filter !== 'all') rows = rows.filter(d => d.driver_type === filter);

  if (tag) tag.textContent = rows.length + ' changes';

  if (!rows.length) {
    inner.innerHTML = '<div class="tr-load muted">No changes match this filter.</div>';
    return;
  }

  const badgeColor = { new: 'ok', removed: 'crit', changed: 'warn' };
  const sign       = delta => delta > 0 ? '+' : '−';
  const deltaColor = delta => delta > 0 ? 'var(--crit)' : 'var(--ok)';

  inner.innerHTML = `
    <div class="tscroll">
      <table class="dt">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Service</th>
            <th>Region</th>
            <th>Type</th>
            <th style="text-align:right">Prev Cost</th>
            <th style="text-align:right">Curr Cost</th>
            <th style="text-align:right">Change</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(d => {
            const name = esc(d.resource_name || d.resource_id);
            const svc  = esc((d.service || '').replace('Amazon ','').replace('AWS ',''));
            const reg  = esc(d.region || '—');
            const bc   = badgeColor[d.driver_type] || 'info';
            const ds   = sign(d.delta_usd) + fmt(Math.abs(d.delta_usd));
            return `<tr>
              <td>
                <div style="font-weight:500;font-size:12px">${name}</div>
                ${d.resource_name ? `<div class="muted mono" style="font-size:10px">${esc(d.resource_id)}</div>` : ''}
              </td>
              <td style="font-size:12px">${svc}</td>
              <td class="muted" style="font-size:12px">${reg}</td>
              <td><span class="badge ${bc}">${d.driver_type}</span></td>
              <td style="text-align:right;color:var(--t2);font-size:12px">${d.driver_type === 'new' ? '—' : fmt(d.prev_cost)}</td>
              <td style="text-align:right;font-size:12px">${d.driver_type === 'removed' ? '—' : fmt(d.curr_cost)}</td>
              <td style="text-align:right;font-weight:600;color:${deltaColor(d.delta_usd)}">${ds}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function date_today() { return new Date(); }

function datetime_label_last_month() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toLocaleString('default', { month: 'long', year: 'numeric' });
}

/* ── LOGS ─────────────────────────────────────────────── */
/* ── LOGS ──────────────────────────────────────────────── */

// ── Auth activity panel ────────────────────────────────────────────────────

function _parseAuthEvent(line, namespace, ts) {
  let m;

  // SSH accepted login
  m = line.match(/sshd\[\d+\]:\s+Accepted (?:password|publickey) for (\S+) from ([\d.a-f:]+)/i);
  if (m) return { user: m[1], action: 'Logged in (SSH)', detail: 'from ' + m[2], server: namespace, ts, type: 'ssh' };

  // SSH pam session opened (sshd)
  m = line.match(/pam_unix\(sshd:session\):\s+session opened for user (\S+?)(?:\(uid=\d+\))?(?:\s|$)/);
  if (m) return { user: m[1], action: 'SSH session opened', detail: '', server: namespace, ts, type: 'ssh' };

  // SSH failed login
  m = line.match(/sshd\[\d+\]:\s+Failed (?:password|publickey) for (?:invalid user )?(\S+) from ([\d.a-f:]+)/i);
  if (m) return { user: m[1], action: 'Failed login attempt', detail: 'from ' + m[2], server: namespace, ts, type: 'fail' };

  // SSH disconnect — handles: "Disconnected from [user <u>] <ip>",
  //   "Connection closed by [authenticating user <u>] <ip>"
  m = line.match(/sshd\[\d+\]:\s+(?:Disconnected from|Connection closed by)(?:\s+authenticating)?(?: user (\S+))?\s+([\d.a-f:]+)/i);
  if (m) { const u = m[1]; return { user: u || '—', action: 'SSH disconnected', detail: u ? '' : 'from ' + m[2], server: namespace, ts, type: 'ssh_end' }; }

  // sudo session opened
  m = line.match(/pam_unix\(sudo[^)]*\):\s+session opened for user (\S+?)(?:\(uid=\d+\))?(?: by (\S+?)(?:\(uid=\d+\))?)?(?:\s|$)/);
  if (m) { const by = m[2] || ''; return { user: by || 'unknown', action: 'Ran sudo as ' + m[1], detail: '', server: namespace, ts, type: 'sudo' }; }

  // su session opened — strip (uid=...) from the captured target user
  m = line.match(/pam_unix\(su[^)]*\):\s+session opened for user (\S+?)(?:\(uid=\d+\))?(?:\s|$)/);
  if (m) { const who = line.match(/su:\s+\(to [^)]+\) (\S+)/); return { user: who ? who[1] : 'root', action: 'Switched to ' + m[1], detail: '', server: namespace, ts, type: 'su' }; }

  // cron session opened
  m = line.match(/pam_unix\(cron:session\):\s+session opened for user (\S+)/);
  if (m) return { user: m[1], action: 'Cron job ran', detail: '', server: namespace, ts, type: 'cron', isCron: true };

  // password changed
  m = line.match(/passwd\[\d+\]:\s+password changed for (\S+)/);
  if (m) return { user: m[1], action: 'Password changed', detail: '', server: namespace, ts, type: 'passwd' };

  return null;
}

function _renderAuthPanel() {
  const panel  = document.getElementById('auth-activity-panel');
  const source = document.getElementById('log-source')?.value || '';
  if (!panel) return;

  if (source !== 'auth') { panel.style.display = 'none'; return; }
  panel.style.display = '';

  const showCron = document.getElementById('auth-show-cron')?.checked || false;

  const events = [];
  for (const l of _logsData) {
    const ev = _parseAuthEvent(l.line, l.namespace || '—', l.ts);
    if (ev) events.push(ev);
  }

  // Summary cards
  const realUsers = new Set(events.filter(e => !e.isCron && e.user !== '—').map(e => e.user));
  const sshCount  = events.filter(e => e.type === 'ssh').length;
  const sudoCount = events.filter(e => e.type === 'sudo' || e.type === 'su').length;
  const failCount = events.filter(e => e.type === 'fail').length;

  const setA = (id, val, cls) => { const el = document.getElementById(id); if (el) { el.textContent = val; el.className = 'po-v ' + cls; } };
  setA('auth-stat-users', realUsers.size, realUsers.size > 0 ? 'ok'   : 'muted');
  setA('auth-stat-ssh',   sshCount,       sshCount  > 0      ? 'ok'   : 'muted');
  setA('auth-stat-sudo',  sudoCount,      sudoCount > 0       ? 'warn' : 'muted');
  setA('auth-stat-fail',  failCount,      failCount > 0       ? 'crit' : 'ok');

  // Activity feed
  const feed   = events.filter(e => showCron || !e.isCron);
  const countEl = document.getElementById('auth-feed-count');
  if (countEl) countEl.textContent = feed.length + ' events';
  const feedEl = document.getElementById('auth-feed-tbody');
  if (feedEl) {
    if (!feed.length) {
      feedEl.innerHTML = '<tr><td colspan="4" class="tr-load">No parsed auth events in this window.</td></tr>';
    } else {
      feedEl.innerHTML = feed.slice(0, 150).map(ev => {
        const ts   = new Date(ev.ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const col  = ev.type === 'fail' ? 'crit' : ev.type === 'sudo' || ev.type === 'passwd' ? 'warn' : ev.isCron ? 't3' : 't1';
        const serverDisplay = (ev.server || '—').replace(/^ip-(\d+)-(\d+)-(\d+)-(\d+)$/, '$1.$2.$3.$4');
        return `<tr>
          <td class="mono muted" style="font-size:10px;white-space:nowrap">${ts}</td>
          <td style="font-size:11px;font-weight:500;color:var(--t1)">${esc(ev.user)}</td>
          <td style="font-size:11px">
            <span style="color:var(--${col})">${esc(ev.action)}</span>
            ${ev.detail ? `<span class="muted" style="font-size:10px;margin-left:4px">${esc(ev.detail)}</span>` : ''}
          </td>
          <td class="mono" style="font-size:10px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px" title="${esc(ev.server||'—')}">${esc(serverDisplay)}</td>
        </tr>`;
      }).join('');
    }
  }

  // User activity bar chart
  const chartData = events.filter(e => showCron || !e.isCron).filter(e => e.user && e.user !== '—');
  const counts = {};
  for (const ev of chartData) counts[ev.user] = (counts[ev.user] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const chartEl = document.getElementById('auth-user-chart');
  if (chartEl) {
    if (!entries.length) {
      chartEl.innerHTML = '<div class="muted" style="font-size:11px;padding:4px 0">No data</div>';
    } else {
      const maxVal = entries[0][1] || 1;
      chartEl.innerHTML = entries.map(([user, count]) => {
        const pct      = Math.round((count / maxVal) * 100);
        const barColor = user === 'root' ? 'var(--warn)' : count === maxVal ? 'var(--ok)' : 'rgba(79,195,247,.5)';
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;min-width:0">
          <div style="width:72px;text-align:right;font-size:11px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0" title="${esc(user)}">${esc(user)}</div>
          <div style="flex:1;background:var(--bg1);border-radius:3px;height:10px;min-width:0;overflow:hidden">
            <div style="width:${pct}%;background:${barColor};height:10px;border-radius:3px;transition:width .3s"></div>
          </div>
          <div style="width:24px;font-size:10px;color:var(--t2);text-align:right;flex-shrink:0">${count}</div>
        </div>`;
      }).join('');
    }
  }
}

function _parseSyslogEvent(line, namespace, ts) {
  let m;

  // OOM killer
  m = line.match(/Out of memory:\s+Killed process \d+ \(([^)]+)\)/i);
  if (m) return { action: `Process "${m[1]}" killed`, detail: 'out of memory', server: namespace, ts, type: 'oom' };

  // Kernel I/O / disk error
  m = line.match(/kernel:.*(?:I\/O error|Buffer I\/O error|end_request.*error|blk_update_request)/i);
  if (m) return { action: 'Disk I/O error', detail: 'kernel reported read/write failure', server: namespace, ts, type: 'disk' };

  // Filesystem error
  m = line.match(/kernel:.*(?:EXT4-fs error|XFS.*error|filesystem error)/i);
  if (m) return { action: 'Filesystem error', detail: (m[0].match(/EXT4|XFS/i) || [''])[0] + ' filesystem', server: namespace, ts, type: 'disk' };

  // No space left
  m = line.match(/No space left on device/i);
  if (m) return { action: 'Disk full', detail: 'no space left on device', server: namespace, ts, type: 'disk' };

  // Kernel panic / BUG / Oops
  m = line.match(/kernel:.*(?:Kernel panic|BUG:|Oops:|general protection fault)/i);
  if (m) return { action: 'Kernel panic / crash', detail: 'immediate attention needed', server: namespace, ts, type: 'kernel' };

  // systemd service failed
  m = line.match(/systemd\[.*\]:\s+([\w@.\-:]+\.service):\s+(?:Failed|Main process exited.*failure|Start request repeated)/i);
  if (m) { const svc = m[1].replace('.service', ''); return { action: `${svc} failed`, detail: 'service crashed or could not start', server: namespace, ts, type: 'svc_fail' }; }

  // systemd service entered failed state
  m = line.match(/systemd\[.*\]:\s+([\w@.\-:]+\.service):\s+entered failed state/i);
  if (m) { const svc = m[1].replace('.service', ''); return { action: `${svc} entered failed state`, detail: '', server: namespace, ts, type: 'svc_fail' }; }

  // systemd service restarting
  m = line.match(/systemd\[.*\]:\s+([\w@.\-:]+\.service):\s+(?:Scheduled restart|Restarting)/i);
  if (m) { const svc = m[1].replace('.service', ''); return { action: `${svc} restarting`, detail: 'scheduled restart', server: namespace, ts, type: 'restart' }; }

  // systemd service started
  m = line.match(/systemd\[.*\]:\s+Started ([\w@.\-: ]+?)(?:\.service)?\.?$/i);
  if (m) return { action: `Started ${m[1].replace('.service', '').trim()}`, detail: '', server: namespace, ts, type: 'svc_start', isInfo: true };

  // Network interface down
  m = line.match(/(?:kernel|networkd|NetworkManager).*(?:Link is Down|Lost carrier|link down|disconnected)/i);
  if (m) { const iface = line.match(/\b(eth\d+|ens\d+|eno\d+|enp\S+)\b/i); return { action: 'Network interface down', detail: iface ? iface[1] : '', server: namespace, ts, type: 'net' }; }

  // Network interface up
  m = line.match(/(?:kernel|networkd|NetworkManager).*(?:Link is Up|gained carrier|link up|connected)/i);
  if (m) { const iface = line.match(/\b(eth\d+|ens\d+|eno\d+|enp\S+)\b/i); return { action: 'Network interface up', detail: iface ? iface[1] : '', server: namespace, ts, type: 'net_up', isInfo: true }; }

  // Cron job execution
  m = line.match(/CRON\[\d+\]:\s+\((\S+)\) CMD \(([^)]{0,80})\)/);
  if (m) return { action: `Cron: ${m[2].slice(0, 60)}`, detail: `as ${m[1]}`, server: namespace, ts, type: 'cron', isInfo: true };

  // Generic service error line (only if severity was already flagged warning/critical)
  m = line.match(/(\w[\w.-]{2,20})\[\d+\]:\s+(?:error|fatal|panic|critical)[:.\s]/i);
  if (m) return { action: `${m[1]} reported an error`, detail: '', server: namespace, ts, type: 'error' };

  return null;
}

function _renderSyslogPanel() {
  const panel  = document.getElementById('syslog-activity-panel');
  const source = document.getElementById('log-source')?.value || '';
  if (!panel) return;

  if (source !== 'syslog') { panel.style.display = 'none'; return; }
  panel.style.display = '';

  const showInfo = document.getElementById('syslog-show-info')?.checked || false;

  const events = [];
  for (const l of _logsData) {
    const ev = _parseSyslogEvent(l.line, l.namespace || '—', l.ts);
    if (ev) events.push(ev);
  }

  // Summary tiles
  const failCount    = events.filter(e => e.type === 'svc_fail').length;
  const oomCount     = events.filter(e => e.type === 'oom').length;
  const diskCount    = events.filter(e => e.type === 'disk').length;
  const restartCount = events.filter(e => e.type === 'restart').length;

  const setS = (id, val, cls) => { const el = document.getElementById(id); if (el) { el.textContent = val; el.className = 'po-v ' + cls; } };
  setS('syslog-stat-fail',    failCount,    failCount    > 0 ? 'crit' : 'ok');
  setS('syslog-stat-oom',     oomCount,     oomCount     > 0 ? 'crit' : 'ok');
  setS('syslog-stat-disk',    diskCount,    diskCount    > 0 ? 'warn' : 'ok');
  setS('syslog-stat-restart', restartCount, restartCount > 0 ? 'warn' : 'muted');

  // Activity feed
  const feed = events.filter(e => showInfo || !e.isInfo);
  const countEl = document.getElementById('syslog-feed-count');
  if (countEl) countEl.textContent = feed.length + ' events';
  const feedEl = document.getElementById('syslog-feed-tbody');
  if (feedEl) {
    if (!feed.length) {
      feedEl.innerHTML = '<tr><td colspan="3" class="tr-load">No notable system events in this window.</td></tr>';
    } else {
      feedEl.innerHTML = feed.slice(0, 150).map(ev => {
        const ts  = new Date(ev.ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const col = (ev.type === 'svc_fail' || ev.type === 'oom' || ev.type === 'kernel') ? 'crit'
                  : (ev.type === 'disk' || ev.type === 'restart' || ev.type === 'error' || ev.type === 'net') ? 'warn'
                  : 't2';
        const serverDisplay = (ev.server || '—').replace(/^ip-(\d+)-(\d+)-(\d+)-(\d+)$/, '$1.$2.$3.$4');
        return `<tr>
          <td class="mono muted" style="font-size:10px;white-space:nowrap">${ts}</td>
          <td style="font-size:11px">
            <span style="color:var(--${col})">${esc(ev.action)}</span>
            ${ev.detail ? `<span class="muted" style="font-size:10px;margin-left:4px">${esc(ev.detail)}</span>` : ''}
          </td>
          <td class="mono" style="font-size:10px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px" title="${esc(ev.server||'—')}">${esc(serverDisplay)}</td>
        </tr>`;
      }).join('');
    }
  }

  // Events-per-server bar chart
  const counts = {};
  for (const ev of events.filter(e => showInfo || !e.isInfo)) {
    const key = (ev.server || '—').replace(/^ip-(\d+)-(\d+)-(\d+)-(\d+)$/, '$1.$2.$3.$4');
    counts[key] = (counts[key] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const chartEl = document.getElementById('syslog-server-chart');
  if (chartEl) {
    if (!entries.length) {
      chartEl.innerHTML = '<div class="muted" style="font-size:11px;padding:4px 0">No data</div>';
    } else {
      const maxVal = entries[0][1] || 1;
      chartEl.innerHTML = entries.map(([server, count]) => {
        const pct      = Math.round((count / maxVal) * 100);
        const barColor = count === maxVal ? 'var(--crit)' : 'rgba(239,83,80,.4)';
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;min-width:0">
          <div style="width:80px;text-align:right;font-size:10px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0" title="${esc(server)}">${esc(server)}</div>
          <div style="flex:1;background:var(--bg1);border-radius:3px;height:10px;min-width:0;overflow:hidden">
            <div style="width:${pct}%;background:${barColor};height:10px;border-radius:3px;transition:width .3s"></div>
          </div>
          <div style="width:24px;font-size:10px;color:var(--t2);text-align:right;flex-shrink:0">${count}</div>
        </div>`;
      }).join('');
    }
  }
}

async function fetchLogs(background = false) {
  const source   = document.getElementById('log-source')?.value   || '';
  const instance = document.getElementById('log-instance')?.value || '';
  const tbody    = document.getElementById('log-tbody');
  if (!tbody) return;

  if (!background) tbody.innerHTML = '<tr><td colspan="5" class="tr-load">Loading…</td></tr>';

  const params = new URLSearchParams({ range: _logsRange });
  if (source)   params.set('source', source);
  if (instance) params.set('instance', instance);
  if (_logsStart) params.set('start', _logsStart);
  if (_logsEnd)   params.set('end',   _logsEnd);

  try {
    const r = await fetch(`/api/logs?${params}`);
    if (!r.ok) throw new Error(r.statusText);
    const data = await r.json();

    if (!data.configured) {
      if (!background) tbody.innerHTML = `<tr><td colspan="5" class="tr-load" style="color:var(--warn)">
        Loki not configured — set <code>LOKI_URL</code> in the deployment config once Loki is deployed.
      </td></tr>`;
      return;
    }

    const incoming = data.lines || [];
    if (background && _logsData.length) {
      // Prepend only rows newer than what we already have
      const newestKnown = _logsData[0]?.ts || 0;
      const fresh = incoming.filter(l => l.ts > newestKnown);
      if (fresh.length) {
        _logsData = [...fresh, ..._logsData].slice(0, 300);
        _updateLogStats(data.stats);
        filterLogsLocal(true);   // silent re-render
      }
    } else {
      _logsData = incoming;
      _updateLogStats(data.stats);
      filterLogsLocal();
    }
  } catch (err) {
    if (!background) tbody.innerHTML = `<tr><td colspan="5" class="tr-load" style="color:var(--crit)">Error: ${esc(String(err))}</td></tr>`;
  }
}

function _updateLogStats(stats) {
  const setStat = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.className = `po-v ${cls}`;
  };
  setStat('log-stat-total',   stats.total,    stats.total   > 0 ? 'muted' : 'muted');
  setStat('log-stat-crit',    stats.critical, stats.critical > 0 ? 'crit' : 'ok');
  setStat('log-stat-warn',    stats.warning,  stats.warning  > 0 ? 'warn' : 'ok');
  setStat('log-stat-sources', (stats.sources || []).length, 'ok');
}

function filterLogsLocal(silent = false) {
  const search   = (document.getElementById('log-search')?.value   || '').toLowerCase();
  const instance = (document.getElementById('log-instance')?.value || '').toLowerCase();
  const tbody    = document.getElementById('log-tbody');
  if (!tbody) return;

  let rows = _logsData;
  if (search)   rows = rows.filter(l => l.line.toLowerCase().includes(search));
  if (instance) rows = rows.filter(l => (l.namespace || '').toLowerCase().includes(instance));

  const tag = document.getElementById('log-count');
  if (tag) tag.textContent = `${rows.length.toLocaleString()} lines`;

  if (!rows.length) {
    if (!silent) tbody.innerHTML = '<tr><td colspan="5" class="tr-load">No matching log lines.</td></tr>';
    return;
  }

  // Group consecutive lines from the same pod within a 3-second window into one event
  const GROUP_MS = 3000;
  const groups = [];
  for (const l of rows.slice(0, 500)) {
    const last = groups[groups.length - 1];
    if (last && last.pod && last.pod === l.pod && last.namespace === l.namespace
        && Math.abs(last.ts - l.ts) <= GROUP_MS) {
      last.lines.push(l.line);
      // Escalate severity if this line is more severe
      const rank = { critical: 2, warning: 1, info: 0 };
      if ((rank[l.severity] || 0) > (rank[last.severity] || 0)) last.severity = l.severity;
    } else {
      groups.push({ ...l, lines: [l.line] });
    }
    if (groups.length >= 200) break;
  }

  filterLogsLocal._rendered = groups;

  // Auto-report any critical groups to the incident tracker
  groups.filter(g => g.severity === 'critical').forEach(_reportCriticalIncident);

  tbody.innerHTML = groups.map((g, i) => {
    const sevClass = g.severity === 'critical' ? 'crit' : g.severity === 'warning' ? 'warn' : 'info';
    const sevDot   = g.severity === 'critical' ? '●' : g.severity === 'warning' ? '●' : '○';
    const ts       = new Date(g.ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const date     = new Date(g.ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const nsClick  = g.namespace ? `setLogInstance('${esc(g.namespace)}')` : '';
    const countBadge = g.lines.length > 1
      ? `<span style="margin-left:6px;font-size:10px;background:rgba(79,195,247,.15);color:var(--t2);border-radius:3px;padding:1px 5px">${g.lines.length} lines</span>`
      : '';
    return `<tr style="cursor:pointer" onclick="openLogModal(${i})">
      <td style="text-align:center;color:var(--${sevClass})" title="${g.severity}">${sevDot}</td>
      <td class="mono muted" style="font-size:10px;white-space:nowrap">${date} ${ts}</td>
      <td><span class="tag" style="font-size:10px">${esc(g.job)}</span></td>
      <td style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px" onclick="event.stopPropagation();${nsClick}">
        <span style="display:block;cursor:${g.namespace?'pointer':'default'};color:var(--t1)">${esc(g.namespace || '—')}</span>
        ${g.pod ? `<span class="muted" style="display:block;font-size:10px;overflow:hidden;text-overflow:ellipsis">${esc(g.pod)}</span>` : ''}
      </td>
      <td style="font-size:12px;color:var(--t2);max-width:580px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.line)}${countBadge}</td>
    </tr>`;
  }).join('');

  if (tag) tag.textContent = `${groups.length.toLocaleString()} events`;

  _renderAuthPanel();
  _renderSyslogPanel();
}

function openLogModal(idx) {
  const g = (filterLogsLocal._rendered || [])[idx];
  if (!g) return;
  const sevClass = g.severity === 'critical' ? 'crit' : g.severity === 'warning' ? 'warn' : 'info';
  const sevDot   = g.severity === 'critical' ? '●' : g.severity === 'warning' ? '●' : '○';
  document.getElementById('lm-sev-dot').textContent  = sevDot;
  document.getElementById('lm-sev-dot').style.color  = `var(--${sevClass})`;
  document.getElementById('lm-job').textContent      = g.job || '';
  document.getElementById('lm-ns').textContent       = g.namespace || '';
  document.getElementById('lm-pod').textContent      = g.pod || '';
  document.getElementById('lm-ts').textContent       = new Date(g.ts).toLocaleString('en-GB', { hour12: false });
  document.getElementById('lm-msg').textContent      = g.lines.join('\n');
  const overlay = document.getElementById('log-modal-overlay');
  if (overlay) { overlay.style.display = 'flex'; }
}

function closeLogModal() {
  const overlay = document.getElementById('log-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLogModal(); });

function setLogInstance(ns) {
  const input = document.getElementById('log-instance');
  if (!input) return;
  input.value = input.value === ns ? '' : ns;   // click again to clear
  filterLogsLocal();
}

function setLogRange(btn) {
  _logsRange = btn.dataset.range;
  document.querySelectorAll('.log-range').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Clear custom range when a quick-select is clicked
  _logsStart = null;
  _logsEnd   = null;
  const inp = document.getElementById('log-start-time');
  if (inp) inp.value = '';
  _updateEndLabel();
  fetchLogs();
}

function openRangeModal() {
  const _fmt = d => {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  if (_logsStart && _logsEnd) {
    document.getElementById('rm-start').value = _fmt(new Date(_logsStart));
    document.getElementById('rm-end').value   = _fmt(new Date(_logsEnd));
  } else {
    const end  = new Date();
    const secs = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '48h': 172800 }[_logsRange] || 3600;
    document.getElementById('rm-start').value = _fmt(new Date(end.getTime() - secs * 1000));
    document.getElementById('rm-end').value   = _fmt(end);
  }
  const btn = document.getElementById('rm-dl-btn');
  if (btn) { btn.textContent = '↓ Download CSV'; btn.disabled = false; }
  document.getElementById('range-modal-overlay').style.display = 'flex';
}

function closeRangeModal() {
  document.getElementById('range-modal-overlay').style.display = 'none';
}

function _setRangeModalQuick(rangeStr) {
  const secs = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '48h': 172800 }[rangeStr] || 3600;
  const end  = new Date();
  const p    = n => String(n).padStart(2, '0');
  const fmt  = d => `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  document.getElementById('rm-start').value = fmt(new Date(end.getTime() - secs * 1000));
  document.getElementById('rm-end').value   = fmt(end);
}

function applyRangeModal() {
  const startVal = document.getElementById('rm-start').value;
  const endVal   = document.getElementById('rm-end').value;
  if (!startVal) return;
  _logsStart = new Date(startVal).toISOString();
  _logsEnd   = endVal ? new Date(endVal).toISOString() : new Date().toISOString();
  stopLogsRefresh();
  document.querySelectorAll('.log-range').forEach(b => b.classList.remove('active'));
  const inp = document.getElementById('log-start-time');
  if (inp) inp.value = startVal;
  const clearBtn = document.getElementById('log-clear-range');
  if (clearBtn) clearBtn.style.display = 'inline-flex';
  _updateEndLabel();
  closeRangeModal();
  fetchLogs();
}

async function downloadFromRangeModal() {
  const startVal = document.getElementById('rm-start').value;
  const endVal   = document.getElementById('rm-end').value;
  if (!startVal) return;

  const startISO = new Date(startVal).toISOString();
  const endISO   = endVal ? new Date(endVal).toISOString() : new Date().toISOString();

  const btn = document.getElementById('rm-dl-btn');
  btn.textContent = 'Fetching…';
  btn.disabled = true;

  try {
    const source   = (document.getElementById('log-source')   || {}).value || '';
    const instance = (document.getElementById('log-instance') || {}).value || '';
    const query    = (document.getElementById('log-search')   || {}).value || '';

    const params = new URLSearchParams({ start: startISO, end: endISO, limit: 5000 });
    if (source)   params.set('source',   source);
    if (instance) params.set('instance', instance);
    if (query)    params.set('query',    query);

    const resp = await fetch(`/api/logs?${params}`);
    const data = await resp.json();
    const logLines = (data.lines || []);

    const rows = [['Timestamp', 'Namespace', 'Pod', 'Source', 'Severity', 'Message']];
    for (const l of logLines) {
      rows.push([
        new Date(l.ts).toISOString(),
        l.namespace || '',
        l.pod       || '',
        l.job       || '',
        l.severity  || '',
        l.line      || '',
      ]);
    }
    const csv = rows.map(r =>
      r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')
    ).join('\r\n');

    const s = startISO.slice(0, 16).replace('T', '_').replace(':', '-');
    const e = endISO.slice(0, 16).replace('T', '_').replace(':', '-');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `logs_${s}_to_${e}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    btn.textContent = `✓ Downloaded ${logLines.length} rows`;
  } catch (err) {
    console.error('Log download failed:', err);
    btn.textContent = 'Download failed';
  } finally {
    btn.disabled = false;
  }
}

function clearLogCustomRange() {
  _logsStart = null;
  _logsEnd   = null;
  const inp = document.getElementById('log-start-time');
  if (inp) inp.value = '';
  const clearBtn = document.getElementById('log-clear-range');
  if (clearBtn) clearBtn.style.display = 'none';
  // Restore default range button
  document.querySelectorAll('.log-range').forEach(b => {
    b.classList.toggle('active', b.dataset.range === _logsRange);
  });
  _updateEndLabel();
  fetchLogs();
}

function _updateEndLabel() {
  const activeLbl = document.getElementById('log-range-active-label');
  if (_logsStart && _logsEnd) {
    const s   = new Date(_logsStart);
    const e   = new Date(_logsEnd);
    const fmt = d => d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    if (activeLbl) { activeLbl.textContent = `${fmt(s)} → ${fmt(e)}`; activeLbl.style.display = 'inline'; }
  } else {
    if (activeLbl) { activeLbl.textContent = ''; activeLbl.style.display = 'none'; }
  }
}


function startLogsRefresh() {
  fetchLogs();
  _logsTimer = setInterval(() => fetchLogs(true), 30_000);
  _logsLive  = true;
  const btn  = document.getElementById('log-live-btn');
  if (btn) btn.classList.add('active');
}

function stopLogsRefresh() {
  clearInterval(_logsTimer);
  _logsTimer = null;
  _logsLive  = false;
  const btn  = document.getElementById('log-live-btn');
  if (btn) btn.classList.remove('active');
}

function toggleLogsRefresh() {
  _logsLive ? stopLogsRefresh() : startLogsRefresh();
}

function renderLogs() {
  // Legacy internal event log — still used by collector alert system
  fetchLogs();
}

/* ── ALB ──────────────────────────────────────────────── */
function renderALB(alb) {
  const lbs = alb.load_balancers || [];
  const section = document.getElementById('s-network');
  if (!section) return;

  if (!lbs.length) return; // keep addon placeholder if no data yet

  const summary = alb.summary || {};
  section.innerHTML = `
    <div class="pod-overview" style="margin-bottom:20px">
      <div class="po-stat"><div class="po-v ok"  id="alb-total">${lbs.length}</div><div class="po-l">Load Balancers</div></div>
      <div class="po-stat"><div class="po-v ok"  id="alb-healthy">${alb.healthy || 0}</div><div class="po-l">Healthy</div></div>
      <div class="po-stat"><div class="po-v warn" id="alb-degraded">${alb.degraded || 0}</div><div class="po-l">Degraded</div></div>
      <div class="po-stat"><div class="po-v crit" id="alb-critical">${alb.critical || 0}</div><div class="po-l">Critical</div></div>
      <div class="po-stat"><div class="po-v muted">${summary.total_requests_5min?.toLocaleString() || '—'}</div><div class="po-l">Requests (5min)</div></div>
      <div class="po-stat"><div class="po-v ${summary.overall_error_rate >= 5 ? 'crit' : summary.overall_error_rate >= 1 ? 'warn' : 'ok'}">${summary.overall_error_rate ?? '—'}%</div><div class="po-l">Overall Error Rate</div></div>
    </div>

    <div class="card">
      <div class="card-hdr">
        <span class="card-title">Load Balancer Details</span>
        <span class="tag ok">${lbs.length} ALBs monitored</span>
      </div>
      <div class="tscroll">
        <table class="dt">
          <thead><tr>
            <th>Name</th>
            <th>Requests/min</th>
            <th>Error Rate</th>
            <th>5xx Errors</th>
            <th>P50 Latency</th>
            <th>P99 Latency</th>
            <th>Healthy Hosts</th>
            <th>Status</th>
          </tr></thead>
          <tbody>
            ${lbs.map(lb => {
              const m = lb.metrics;
              const errColor = m.error_rate_pct >= 5 ? 'var(--crit)' : m.error_rate_pct >= 1 ? 'var(--warn)' : 'var(--ok)';
              const p99Color = m.p99_latency_ms >= 2000 ? 'var(--crit)' : m.p99_latency_ms >= 1000 ? 'var(--warn)' : 'var(--ok)';
              const hostColor = lb.targets.unhealthy > 0 ? 'var(--crit)' : 'var(--ok)';
              return `<tr>
                <td>
                  <div style="font-weight:500">${esc(lb.friendly_name)}</div>
                  <div class="muted" style="font-size:10px">${esc(lb.name)}</div>
                </td>
                <td class="mono">${m.requests_per_min}</td>
                <td style="color:${errColor};font-weight:500">${m.error_rate_pct}%</td>
                <td style="color:${m['5xx_count'] > 0 ? 'var(--crit)' : 'var(--t3)'}">${m['5xx_count']}</td>
                <td class="mono" style="color:var(--t2)">${m.p50_latency_ms}ms</td>
                <td class="mono" style="color:${p99Color}">${m.p99_latency_ms}ms</td>
                <td style="color:${hostColor}">
                  ${lb.targets.healthy} healthy
                  ${lb.targets.unhealthy > 0 ? `<span class="badge crit" style="margin-left:4px">${lb.targets.unhealthy} down</span>` : ''}
                </td>
                <td><span class="badge ${lb.status === 'healthy' ? 'ok' : lb.status === 'degraded' ? 'warn' : 'crit'}">${lb.status}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ── SECURITY ─────────────────────────────────────────── */
function _setCheck(id, isOk, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `sc-row ${isOk ? 'ok' : 'warn'}`;
  el.innerHTML = `<span class="sc-ico">${isOk ? '✓' : '!'}</span>${label}`;
}

function renderSecurity(gd, storage, iam) {
  // Wire real data into the security checklist
  const s3Public = storage?.s3?.public ?? null;
  if (s3Public !== null)
    _setCheck('check-s3-public', s3Public === 0,
      s3Public === 0 ? 'No public S3 buckets' : `${s3Public} public S3 bucket${s3Public !== 1 ? 's' : ''}`);

  // Encryption at rest — check unencrypted in-use EBS volumes and unencrypted S3 buckets
  const unencryptedEBS = (storage?.ebs?.volumes || []).filter(v => !v.encrypted && v.state === 'in-use').length;
  const unencryptedS3  = (storage?.s3?.buckets  || []).filter(b => b.encryption === 'None').length;
  const unencryptedTotal = unencryptedEBS + unencryptedS3;
  if (storage?.ebs || storage?.s3) {
    const encLabel = unencryptedTotal === 0
      ? 'Encryption at rest'
      : `${unencryptedTotal} unencrypted resource${unencryptedTotal !== 1 ? 's' : ''} (${unencryptedEBS} EBS, ${unencryptedS3} S3)`;
    _setCheck('check-encryption', unencryptedTotal === 0, encLabel);
  }

  const noMfa = iam?.totals?.no_mfa ?? null;
  if (noMfa !== null)
    _setCheck('check-mfa', noMfa === 0,
      noMfa === 0 ? 'MFA enabled for all users' : `${noMfa} user${noMfa !== 1 ? 's' : ''} without MFA`);

  const cloudtrail = iam?.cloudtrail_active ?? null;
  if (cloudtrail !== null)
    _setCheck('check-cloudtrail', cloudtrail,
      cloudtrail ? 'CloudTrail active' : 'CloudTrail not active on all accounts');

  const sgCount = _m.security?.overpermissive_sg_count ?? null;
  if (sgCount !== null)
    _setCheck('check-sg', sgCount === 0,
      sgCount === 0 ? 'No overpermissive security groups'
                    : `${sgCount} overpermissive SG${sgCount !== 1 ? 's' : ''}`);

  const flowLogOk = _m.security?.all_vpcs_have_flow_logs ?? null;
  if (flowLogOk !== null)
    _setCheck('check-vpc-flowlogs', flowLogOk,
      flowLogOk ? 'VPC Flow Logs active'
                : `${_m.security.vpc_flow_log_issues} VPC${_m.security.vpc_flow_log_issues !== 1 ? 's' : ''} missing Flow Logs`);

  // If GuardDuty data not yet loaded, skip
  if (!gd || gd.error) return;

  const findings = gd.findings || [];
  // 0 findings = perfect score 100
  const score = gd.security_score != null
    ? (findings.length === 0 ? 100 : gd.security_score)
    : null;

  // Update SVG ring (circumference = 314, offset 0 = full circle)
  const circle = document.getElementById('score-ring-circle');
  if (circle && score != null) {
    const offset = Math.round(314 * (1 - score / 100));
    circle.setAttribute('stroke-dashoffset', offset);
    circle.setAttribute('stroke',
      score >= 95 ? '#4ade80' : score >= 80 ? '#fbbf24' : '#f87171');
  }

  // Update score label
  const scoreCenter = document.getElementById('score-center');
  if (scoreCenter && score != null) {
    scoreCenter.innerHTML = `${score}<small>/100</small>`;
    scoreCenter.style.color = score >= 80 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--crit)';
  }

  // GuardDuty findings table (relabelled columns)
  const tbody = document.getElementById('sg-tbody');
  if (tbody) {
    if (!findings.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="tr-load" style="color:var(--ok)">✓ No active GuardDuty findings — your environment looks clean</td></tr>';
    } else {
      tbody.innerHTML = findings.slice(0, 20).map(f => `
        <tr>
          <td style="font-weight:500;max-width:260px">${esc(f.title)}</td>
          <td class="muted">${esc(f.resource_type)}</td>
          <td style="font-weight:500">${esc(f.resource_id)}</td>
          <td class="muted" style="font-size:11px">${esc(f.type || '—')}</td>
          <td><span class="badge ${f.severity_css}">${f.severity_label} · ${f.severity.toFixed(1)}</span></td>
        </tr>`).join('');
    }
  }

  // Update the GuardDuty summary card on the left
  const secMock = document.querySelector('.sec-mock');
  if (secMock) {
    if (!findings.length) {
      secMock.innerHTML = '<div class="sm-row" style="color:var(--ok)">✓ No active findings detected</div>';
    } else {
      secMock.innerHTML = findings.slice(0, 5).map(f => `
        <div class="sm-row">
          <span class="sev ${f.severity >= 7 ? 'high' : f.severity >= 4 ? 'med' : 'low'}">${f.severity_label}</span>
          <span>${esc(f.title)}</span>
          <span class="muted" style="font-size:11px">${esc(f.resource_id)}</span>
        </div>`).join('');
    }
  }
}

/* ── INFRASTRUCTURE SECURITY ──────────────────────────── */
function renderInfraSecurity(security) {
  const sgTbody = document.getElementById('sg-issues-tbody');
  const vpcTbody = document.getElementById('vpc-flowlog-tbody');

  if (sgTbody) {
    const sgs = security.overpermissive_sgs || [];
    if (security.collected_at === undefined) {
      sgTbody.innerHTML = '<tr><td colspan="5" class="tr-load">Loading security data…</td></tr>';
    } else if (!sgs.length) {
      sgTbody.innerHTML = '<tr><td colspan="5" class="tr-load" style="color:var(--ok)">✓ No overpermissive security groups found</td></tr>';
    } else {
      sgTbody.innerHTML = sgs.map(sg => {
        const rules = sg.risky_rules.map(r =>
          `<span class="badge crit" style="margin-right:4px">${esc(r.protocol)}:${esc(r.port)}</span>`
        ).join('');
        return `<tr>
          <td style="font-weight:500">${esc(sg.sg_id)}<span class="muted" style="margin-left:6px">${esc(sg.sg_name)}</span></td>
          <td class="muted">${esc(sg.vpc_id)}</td>
          <td>${esc(sg.account_name)}</td>
          <td class="muted">${esc(sg.region)}</td>
          <td>${rules}</td>
        </tr>`;
      }).join('');
    }
  }

  if (vpcTbody) {
    const vpcs = security.vpcs_without_flow_logs || [];
    if (security.collected_at === undefined) {
      vpcTbody.innerHTML = '<tr><td colspan="3" class="tr-load">Loading security data…</td></tr>';
    } else if (!vpcs.length) {
      vpcTbody.innerHTML = '<tr><td colspan="3" class="tr-load" style="color:var(--ok)">✓ All VPCs have Flow Logs enabled</td></tr>';
    } else {
      vpcTbody.innerHTML = vpcs.map(v => `
        <tr>
          <td style="font-weight:500">${esc(v.vpc_id)}<span class="muted" style="margin-left:6px">${esc(v.vpc_name !== v.vpc_id ? v.vpc_name : '')}</span></td>
          <td>${esc(v.account_name)}</td>
          <td class="muted">${esc(v.region)}</td>
        </tr>`).join('');
    }
  }
}

/* ── ALERTS ───────────────────────────────────────────── */
function renderAlerts() {
  const crits = _events.filter(e => e.severity === 'critical');
  const warns = _events.filter(e => e.severity === 'warning');
  const all = [...crits, ...warns].slice(0, 20);
  const el = document.getElementById('alerts-list');
  if (!el) return;
  if (!all.length) { el.innerHTML = '<div class="no-alerts">✓ No active alerts. All systems nominal.</div>'; return; }
  el.innerHTML = all.map(e => `<div class="alert-item">
    <div class="alert-dot" style="background:${e.severity==='critical'?'var(--crit)':'var(--warn)'}"></div>
    <div class="alert-body"><span class="alert-src">${esc(e.source)}</span> — ${esc(e.message)}</div>
    <div class="muted" style="font-size:11px">${esc(e.time)}</div>
  </div>`).join('');

  // ── Status bar on the alerts tab ──────────────────────
  const bar  = document.getElementById('ov-status-bar');
  const text = document.getElementById('ov-status-text');
  if (!bar || !text) return;
  const ec2  = _m.ec2        || {};
  const eks  = _m.eks        || {};
  const up   = _m.uptime     || {};
  const gd   = _m.guardduty  || {};
  const cost = _m.cost       || {};
  const gdHigh    = gd.summary?.high ?? 0;
  const maintCount = up.maintenance ?? 0;
  const activeSvcs = (up.total ?? 0) - maintCount;
  const upPct = activeSvcs > 0 ? Math.round((up.up / activeSvcs) * 100) : null;
  const mom   = cost.mom_change_pct ?? 0;
  const issues = [];
  if (crits.length > 0)         issues.push(`${crits.length} critical alert${crits.length !== 1 ? 's' : ''}`);
  if (gdHigh > 0)               issues.push(`${gdHigh} high-severity security finding${gdHigh !== 1 ? 's' : ''}`);
  if (eks.failed_pods > 0)      issues.push(`${eks.failed_pods} pod${eks.failed_pods !== 1 ? 's' : ''} failed`);
  if (upPct != null && upPct < 90) issues.push(`${activeSvcs - up.up} service${activeSvcs - up.up !== 1 ? 's' : ''} down`);
  if (mom > 20)                 issues.push(`daily spend rate up ${mom}% vs last month avg`);
  const warnings = [];
  if (warns.length > 0 && !crits.length) warnings.push(`${warns.length} warning${warns.length !== 1 ? 's' : ''}`);
  if (mom > 5 && mom <= 20)    warnings.push(`daily spend rate up ${mom}% vs last month avg`);
  bar.className = 'ov-status ' + (issues.length ? 'crit' : warnings.length ? 'warn' : 'ok');
  text.textContent = issues.length
    ? `${issues.length} issue${issues.length !== 1 ? 's' : ''} require attention — ${issues.join(' · ')}`
    : warnings.length
      ? `Systems mostly healthy — ${warnings.join(' · ')}`
      : 'All systems nominal · No active alerts';
}

/* ── INCIDENTS ────────────────────────────────────────── */
let _incidentTab     = 'active';
let _resolveTargetId = null;

async function loadIncidents() {
  await Promise.all([_loadActiveIncidents(), _incidentTab === 'history' ? _loadHistoryIncidents() : Promise.resolve()]);
}

async function _loadActiveIncidents() {
  try {
    const r = await fetch('/api/incidents?status=open');
    if (!r.ok) return;
    const { incidents } = await r.json();
    _renderActiveIncidents(incidents || []);
  } catch (_) {}
}

async function _loadHistoryIncidents() {
  const tbody = document.getElementById('inc-history-tbody');
  if (!tbody) return;
  try {
    const r = await fetch('/api/incidents?status=all');
    if (!r.ok) return;
    const { incidents } = await r.json();
    const resolved = (incidents || []).filter(i => i.status === 'resolved');
    if (!resolved.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="tr-load muted">No resolved incidents yet.</td></tr>';
      return;
    }
    tbody.innerHTML = resolved.map(i => {
      const sev  = 'crit';
      const ts   = new Date(i.first_seen).toLocaleString('en-GB', { hour12: false });
      const rts  = i.resolved_at ? new Date(i.resolved_at).toLocaleString('en-GB', { hour12: false }) : '—';
      return `<tr>
        <td style="text-align:center;color:var(--ok)">✓</td>
        <td class="mono muted" style="font-size:10px;white-space:nowrap">${esc(ts)}</td>
        <td><span class="tag" style="font-size:10px">${esc(i.source||'')}</span></td>
        <td class="muted" style="font-size:11px">${esc(i.namespace||'—')}</td>
        <td style="font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.message)}">${esc(i.message)}</td>
        <td class="muted" style="font-size:11px">${esc(i.resolved_by||'—')}</td>
        <td class="mono muted" style="font-size:10px;white-space:nowrap">${esc(rts)}</td>
        <td class="muted" style="font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.resolution_note||'')}">${esc(i.resolution_note||'—')}</td>
      </tr>`;
    }).join('');
  } catch (_) {}
}

function _renderActiveIncidents(incidents) {
  const legacyEl  = document.getElementById('alerts-list');
  const tableWrap = document.getElementById('inc-active-table');
  const tbody     = document.getElementById('inc-active-tbody');
  const countEl   = document.getElementById('inc-active-count');
  if (!tbody) return;

  // Also keep legacy system alerts visible
  const crits = _events.filter(e => e.severity === 'critical');
  const warns = _events.filter(e => e.severity === 'warning');
  const sysAlerts = [...crits, ...warns];

  const total = incidents.length + sysAlerts.length;
  if (countEl) countEl.textContent = total || '';

  if (!incidents.length && !sysAlerts.length) {
    if (legacyEl)  legacyEl.style.display  = 'block';
    if (tableWrap) tableWrap.style.display = 'none';
    if (legacyEl) legacyEl.innerHTML = '<div class="no-alerts">✓ No active incidents. All systems nominal.</div>';
    return;
  }

  if (legacyEl)  legacyEl.style.display  = sysAlerts.length ? 'block' : 'none';
  if (tableWrap) tableWrap.style.display = incidents.length  ? 'block' : 'none';

  if (legacyEl && sysAlerts.length) {
    legacyEl.innerHTML = sysAlerts.map(e => `<div class="alert-item">
      <div class="alert-dot" style="background:${e.severity==='critical'?'var(--crit)':'var(--warn)'}"></div>
      <div class="alert-body"><span class="alert-src">${esc(e.source)}</span> — ${esc(e.message)}</div>
      <div class="muted" style="font-size:11px">${esc(e.time)}</div>
    </div>`).join('');
  }

  tbody.innerHTML = incidents.map(i => {
    const ts = new Date(i.first_seen).toLocaleString('en-GB', { hour12: false });
    return `<tr>
      <td style="text-align:center;color:var(--crit)" title="critical">●</td>
      <td class="mono muted" style="font-size:10px;white-space:nowrap">${esc(ts)}</td>
      <td><span class="tag" style="font-size:10px">${esc(i.source||'')}</span></td>
      <td class="muted" style="font-size:11px;white-space:nowrap">${esc(i.namespace||'—')}</td>
      <td class="muted" style="font-size:11px;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis">${esc(i.pod||'—')}</td>
      <td style="font-size:12px;color:var(--t2);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" title="${esc(i.full_log||i.message)}" onclick="showIncidentDetail(${i.id},'${esc(i.message)}')">${esc(i.message)}</td>
      <td><button class="btn-sm" style="font-size:10px;color:var(--ok);border-color:rgba(102,187,106,.4)" onclick="openResolveModal(${i.id},'${esc(i.message)}')">Resolve</button></td>
    </tr>`;
  }).join('');
}

function showIncidentDetail(id, msg) {
  // Reuse the log detail modal to show the full incident message
  document.getElementById('lm-sev-dot').textContent = '●';
  document.getElementById('lm-sev-dot').style.color = 'var(--crit)';
  document.getElementById('lm-job').textContent = 'incident';
  document.getElementById('lm-ns').textContent  = '';
  document.getElementById('lm-pod').textContent = '';
  document.getElementById('lm-ts').textContent  = '';
  document.getElementById('lm-msg').textContent = msg;
  document.getElementById('log-modal-overlay').style.display = 'flex';
}

function switchIncidentTab(tab) {
  _incidentTab = tab;
  document.getElementById('inc-panel-active').style.display  = tab === 'active'  ? 'block' : 'none';
  document.getElementById('inc-panel-history').style.display = tab === 'history' ? 'block' : 'none';
  document.getElementById('inc-tab-active').classList.toggle('active',  tab === 'active');
  document.getElementById('inc-tab-history').classList.toggle('active', tab === 'history');
  if (tab === 'history') _loadHistoryIncidents();
}

function openResolveModal(id, msg) {
  _resolveTargetId = id;
  document.getElementById('resolve-modal-msg').textContent = msg;
  document.getElementById('resolve-note').value = '';
  document.getElementById('resolve-modal-overlay').style.display = 'flex';
}

function closeResolveModal() {
  document.getElementById('resolve-modal-overlay').style.display = 'none';
  _resolveTargetId = null;
}

async function confirmResolve() {
  if (!_resolveTargetId) return;
  const note = document.getElementById('resolve-note')?.value || '';
  const user = _currentUser?.email || 'unknown';
  try {
    const r = await fetch(`/api/incidents/${_resolveTargetId}/resolve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved_by: user, note }),
    });
    if (!r.ok) throw new Error(await r.text());
    closeResolveModal();
    loadIncidents();
  } catch (err) {
    alert(`Failed to resolve: ${err.message}`);
  }
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeResolveModal(); });

async function clearAllIncidents() {
  if (!confirm('Mark all open incidents as resolved? This is useful to purge false positives after a detection fix.')) return;
  const user = _currentUser?.email || 'system';
  try {
    const r = await fetch('/api/incidents/clear-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved_by: user, note: 'Bulk cleared — false positives from detection fix' }),
    });
    if (!r.ok) throw new Error(await r.text());
    const { cleared } = await r.json();
    loadIncidents();
    alert(`Cleared ${cleared} open incident${cleared !== 1 ? 's' : ''}.`);
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

// Auto-create a critical incident when detected in log stream
async function _reportCriticalIncident(group) {
  try {
    await fetch('/api/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source:    group.job,
        namespace: group.namespace,
        pod:       group.pod,
        message:   group.line,
        full_log:  group.lines.join('\n'),
      }),
    });
  } catch (_) {}
}

/* ── CAPACITY ─────────────────────────────────────────── */
function renderCapacity(ec2, eks) {
  const ecEl = document.getElementById('cap-ec2');
  const instances = (ec2.instances || []).filter(i => i.state === 'running');
  if (ecEl) {
    ecEl.innerHTML = !instances.length
      ? '<div class="tr-load">No data.</div>'
      : instances.map(i => {
          const cpu = i.metrics?.cpu_percent || 0;
          return `<div class="cap-row">
            <span class="cap-name">${esc(i.name)}</span>
            ${barCell(cpu)}
          </div>`;
        }).join('');
  }

  const eksEl = document.getElementById('cap-eks');
  const nodes = eks.nodes || [];
  if (eksEl) {
    eksEl.innerHTML = !nodes.length
      ? '<div class="tr-load">No node data.</div>'
      : nodes.map(n => {
          const total = n.allocatable?.pods || 110;
          const used  = 0; // real value needs metrics-server
          return `<div class="cap-row">
            <span class="cap-name">${esc(n.name)}</span>
            <span class="muted" style="font-size:11px">${esc(n.instance_type||'')}</span>
            <span class="badge ${n.status==='ready'?'ok':'crit'}">${n.status}</span>
          </div>`;
        }).join('');
  }
}

/* ── SAVINGS ──────────────────────────────────────────── */
function renderSavings(ec2, alb, cost) {
  const panel = document.getElementById('savings-list-inner');
  const tag   = document.getElementById('savings-tag');
  if (!panel) return;

  const fmt = v => '$' + Number(v).toLocaleString(undefined, {maximumFractionDigits: 0});
  const instances = ec2.instances || [];
  const opportunities = [];

  // ── 1. Stopped instances costing money ──────────────────
  const stopped = instances.filter(i => i.state === 'stopped');
  if (stopped.length > 0) {
    opportunities.push({
      icon: '↓', severity: 'crit',
      title: `${stopped.length} stopped instance${stopped.length > 1 ? 's' : ''} still incurring EBS costs`,
      desc: `Stopped instances don't pay for compute but still pay for attached EBS volumes (~$0.10/GB/month). Consider creating AMIs and terminating if not needed: ${stopped.slice(0,3).map(i => i.name || i.id).join(', ')}${stopped.length > 3 ? ` +${stopped.length-3} more` : ''}.`,
      saving: null,
    });
  }

  // ── 2. Low CPU instances — rightsizing candidates ───────
  const lowCpu = instances.filter(i =>
    i.state === 'running' &&
    i.metrics?.cpu_percent > 0 &&
    i.metrics?.cpu_percent < 10 &&
    !i.name?.toLowerCase().includes('bastion') &&
    !i.name?.toLowerCase().includes('vpn')
  );
  if (lowCpu.length > 0) {
    opportunities.push({
      icon: '⬇', severity: 'warn',
      title: `${lowCpu.length} instance${lowCpu.length > 1 ? 's' : ''} with CPU below 10% — rightsizing candidates`,
      desc: `These instances are consistently underutilised: ${lowCpu.slice(0,3).map(i => `${i.name||i.id} (${i.metrics.cpu_percent}%)`).join(', ')}. Downsizing to a smaller instance type could reduce costs by 30–50% with no performance impact.`,
      saving: null,
    });
  }

  // ── 3. Dev/QA instances running 24/7 ────────────────────
  const devInstances = instances.filter(i =>
    i.state === 'running' &&
    (i.environment === 'development' || i.environment === 'qa')
  );
  if (devInstances.length > 0) {
    const estSaving = Math.round(devInstances.length * 30 * 0.3);
    opportunities.push({
      icon: '◑', severity: 'warn',
      title: `${devInstances.length} Dev/QA instances running 24/7`,
      desc: `Dev and QA environments don't need to run overnight or on weekends. Using AWS Instance Scheduler to stop them outside working hours (8am–6pm weekdays) saves ~30% on those instances.`,
      saving: estSaving,
    });
  }

  // ── 4. Reserved Instance opportunity ────────────────────
  const runningCount = instances.filter(i => i.state === 'running').length;
  if (runningCount >= 5 && cost.mtd > 5000) {
    const dailyAvg  = cost.daily_avg || (cost.mtd / (cost.days_in_month || 20));
    const monthly   = Math.round(dailyAvg * 30);
    const riSaving  = Math.round(monthly * 0.35);
    opportunities.push({
      icon: '★', severity: 'ok',
      title: `Reserved Instance opportunity — ${runningCount} on-demand instances`,
      desc: `With ${runningCount} instances running continuously, purchasing 1-year Reserved Instances for stable workloads (prod EC2, databases) would save 30–40% vs on-demand pricing. Based on current spend of ~${fmt(monthly)}/month.`,
      saving: riSaving,
    });
  }

  // ── 5. ALB consolidation ─────────────────────────────────
  const albCount = (alb.load_balancers || []).length;
  if (albCount >= 5) {
    opportunities.push({
      icon: '◎', severity: 'info',
      title: `${albCount} ALBs — review consolidation opportunity`,
      desc: `Each ALB costs ~$16/month base + data processing charges. Dev/QA ALBs that handle low traffic could share an ingress controller, reducing baseline ALB costs.`,
      saving: Math.round((albCount - 3) * 16),
    });
  }

  // ── 6. No opportunities found ────────────────────────────
  if (opportunities.length === 0) {
    if (tag) { tag.textContent = 'No issues found'; tag.className = 'tag ok'; }
    panel.innerHTML = `<div class="ab-desc" style="padding:16px;color:var(--ok)">
      ✓ No obvious savings opportunities detected based on current usage patterns.
    </div>`;
    return;
  }

  const totalSaving = opportunities.reduce((s, o) => s + (o.saving || 0), 0);
  if (tag) {
    tag.textContent = totalSaving > 0
      ? `${opportunities.length} opportunities · ~${fmt(totalSaving)}/mo potential`
      : `${opportunities.length} opportunities identified`;
    tag.className = 'tag warn';
  }

  panel.innerHTML = opportunities.map(o => `
    <div class="sv-item">
      <div class="sv-ico ${o.severity}">${esc(o.icon)}</div>
      <div class="sv-body">
        <div class="sv-title">${esc(o.title)}</div>
        <div class="sv-desc">${esc(o.desc)}</div>
      </div>
      ${o.saving ? `<div class="sv-amt">~${fmt(o.saving)}/mo</div>` : '<div class="sv-amt muted">—</div>'}
    </div>`).join('');
}

/* ── IAM ──────────────────────────────────────────────── */
function renderIAM(iam) {
  if (!iam || !iam.totals) return;

  const t = iam.totals;
  setText('iam-total',   t.users     ?? '—');
  setText('iam-no-mfa',  t.no_mfa    ?? '—');
  setText('iam-stale',   t.stale_keys ?? '—');
  setText('iam-admins',  t.admins    ?? '—');

  // IAM health score — deduct for each finding
  const score = Math.max(0, 100 - (t.no_mfa * 20) - (t.stale_keys * 10) - (t.critical * 5));
  const scoreEl = document.getElementById('iam-score');
  if (scoreEl) {
    scoreEl.textContent = score + '%';
    scoreEl.style.color = score >= 80 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--crit)';
  }
  setColor('iam-no-mfa', t.no_mfa  > 0 ? 'crit' : 'ok');
  setColor('iam-stale',  t.stale_keys > 0 ? 'warn' : 'ok');

  const tag = document.getElementById('iam-tag');
  if (tag) {
    tag.textContent = t.critical > 0
      ? `${t.critical} critical findings`
      : 'All users compliant';
    tag.className = `tag ${t.critical > 0 ? 'crit' : 'ok'}`;
  }

  const tbody = document.getElementById('iam-tbody');
  if (!tbody) return;

  const users = iam.all_users || [];
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="tr-load">No IAM data yet…</td></tr>';
    return;
  }

  const flagLabel = {
    no_mfa:        '⚠ No MFA',
    stale_key:     '🔑 Stale Key',
    old_key:       '🔑 Old Key',
    old_password:  '🔒 Old Password',
    admin_access:  '★ Admin',
    root_used_recently: '🔴 Root Used',
  };

  tbody.innerHTML = users.map(u => {
    const activeKeys = u.access_keys.filter(k => k.active);
    const staleKey   = u.access_keys.find(k => k.stale);
    const oldestKey  = u.access_keys.reduce((a, b) => (a.age_days||0) > (b.age_days||0) ? a : b, {});
    const flagBadges = u.flags.map(f =>
      `<span class="badge ${f === 'no_mfa' || f === 'stale_key' || f === 'root_used_recently' ? 'crit' : 'warn'}" style="font-size:10px;margin-right:2px">${flagLabel[f] || f}</span>`
    ).join('');

    return `<tr>
      <td style="font-size:11px;font-weight:600;color:${u.environment === 'production' ? 'var(--ok)' : 'var(--info)'}">
        ${esc(u.account_name)}
      </td>
      <td>
        <div style="font-weight:500">${esc(u.is_root ? '⚡ root' : u.username)}</div>
        ${flagBadges}
      </td>
      <td>
        <span class="badge ${u.mfa_active ? 'ok' : u.is_root ? 'crit' : 'crit'}">
          ${u.mfa_active ? '✓ On' : '✗ Off'}
        </span>
      </td>
      <td class="muted" style="font-size:11px">
        ${esc(u.pwd_last_used)}
        ${u.pwd_last_used_days >= 0 ? `<div style="font-size:10px;color:var(--t3)">${u.pwd_last_used_days}d ago</div>` : ''}
      </td>
      <td class="muted">${activeKeys.length} active</td>
      <td class="${oldestKey.age_days > 90 ? 'crit' : oldestKey.age_days > 60 ? 'warn' : 'muted'}" style="font-size:11px">
        ${oldestKey.age_days != null ? `${oldestKey.age_days}d` : '—'}
      </td>
      <td class="muted" style="font-size:11px">
        ${staleKey ? `<span style="color:var(--warn)">${esc(staleKey.last_used_date)}</span>` : (activeKeys[0]?.last_used_date || '—')}
      </td>
      <td>
        ${u.is_admin ? '<span class="badge warn">Admin</span>' : '<span class="muted" style="font-size:11px">—</span>'}
      </td>
      <td>
        <span class="badge ${u.risk_level === 'critical' ? 'crit' : u.risk_level === 'warning' ? 'warn' : 'ok'}">
          ${u.risk_level}
        </span>
      </td>
    </tr>`;
  }).join('');
}

/* ── STORAGE (EBS + S3) ───────────────────────────────── */
let _ebsEntries    = [];
let _s3Entries     = [];
let _ebsStatFilter = null;  // predicate set by stat tile clicks
let _s3StatFilter  = null;

function renderStorage(st) {
  const ebs = st.ebs || {};
  const s3  = st.s3  || {};

  // Default sort: unattached first, then by size desc within each group
  const volumes = (ebs.volumes || []).slice().sort((a, b) => {
    const aUnattached = a.state === 'available' ? 0 : 1;
    const bUnattached = b.state === 'available' ? 0 : 1;
    if (aUnattached !== bUnattached) return aUnattached - bUnattached;
    return (b.size_gib || 0) - (a.size_gib || 0);
  });
  const buckets = (s3.buckets || []).slice().sort((a, b) => (b.size_gib || 0) - (a.size_gib || 0));

  _ebsEntries    = volumes;
  _s3Entries     = buckets;
  _ebsStatFilter = null;
  _s3StatFilter  = null;

  // ── Stats bar
  function setStat(id, val, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (cls) el.className = 'po-v ' + cls;
  }
  setStat('st-vol-total',   ebs.total        || 0,  'muted');
  setStat('st-vol-inuse',   ebs.in_use        || 0,  ebs.in_use   > 0 ? 'ok'   : 'muted');
  setStat('st-vol-avail',   ebs.unattached    || 0,  ebs.unattached > 0 ? 'warn' : 'ok');
  setStat('st-vol-gib',     (ebs.total_gib    || 0) + ' GiB', null);

  const orphaned = ebs.orphaned_snapshots || [];
  setStat('st-orphan-count', orphaned.length,         orphaned.length > 0 ? 'warn' : 'ok');
  setStat('st-s3-buckets',   s3.total          || 0,  s3.total     > 0 ? 'ok'   : 'muted');
  setStat('st-s3-gib',       (s3.total_gib     || 0).toFixed(1) + ' GiB', null);
  setStat('st-s3-public',    s3.public         || 0,  s3.public    > 0 ? 'crit' : 'ok');

  // ── EBS table tag
  const ebsTag = document.getElementById('ebs-tag');
  if (ebsTag) {
    const waste = ebs.unattached_gib || 0;
    ebsTag.textContent = volumes.length === 0 ? 'No volumes'
      : `${volumes.length} volumes · ${ebs.total_gib || 0} GiB total${waste > 0 ? ` · ${waste} GiB unattached` : ''}`;
    ebsTag.className   = 'tag ' + (ebs.unattached > 0 ? 'warn' : 'info');
  }

  // ── Orphaned snapshots panel
  const orphanCard = document.getElementById('orphan-snap-card');
  const orphanBody = document.getElementById('orphan-snap-tbody');
  const orphanTag  = document.getElementById('orphan-snap-tag');
  const orphanSub  = document.getElementById('orphan-snap-sub');
  if (orphanCard) {
    const _restricted = (_currentUser?.role || 'viewer') !== 'admin';
    if (orphaned.length > 0 && !_restricted) {
      orphanCard.style.display = '';
      if (orphanTag) {
        orphanTag.textContent = `${orphaned.length} snapshot${orphaned.length !== 1 ? 's' : ''}`;
        orphanTag.className   = 'tag warn';
      }
      if (orphanSub) {
        orphanSub.textContent =
          `${ebs.orphaned_gib || 0} GiB — these belong to deleted volumes and are costing money with no benefit`;
      }
      if (orphanBody) {
        orphanBody.innerHTML = orphaned.map(s => {
          const label = s.name || s.description || '<span class="muted">—</span>';
          return `<tr>
            <td class="mono" style="font-size:11px">${esc(s.id)}</td>
            <td style="font-size:11px">${esc(label)}</td>
            <td class="mono muted" style="font-size:10px">${esc(s.volume_id || '—')}</td>
            <td style="font-weight:600">${s.volume_size} GiB</td>
            <td style="font-size:11px;color:var(--t2)">${esc(s.account_id || '—')}</td>
            <td class="muted" style="font-size:11px">${esc(s.region || '—')}</td>
            <td style="font-size:11px;color:var(--t3)">${_fmtDate(s.start_time)}</td>
          </tr>`;
        }).join('');
      }
    } else {
      orphanCard.style.display = 'none';
    }
  }

  // ── S3 tag
  const s3Tag = document.getElementById('s3-tag');
  if (s3Tag) {
    s3Tag.textContent = buckets.length === 0 ? 'No buckets'
      : `${buckets.length} buckets · ${(s3.total_gib || 0).toFixed(1)} GiB`;
    s3Tag.className   = 'tag ' + (s3.public > 0 ? 'crit' : 'info');
  }

  filterEBS('');
  filterS3('');
}

function _renderEBSRows(volumes) {
  if (!volumes.length) return '<tr><td colspan="8" class="tr-load">No EBS volumes found.</td></tr>';
  return volumes.map((v, idx) => {
    const stateClass = v.state === 'in-use' ? 'ok' : v.state === 'available' ? 'warn' : 'muted';
    const stateLbl   = v.state === 'in-use' ? '● In Use' : v.state === 'available' ? '◌ Unattached' : v.state;
    const attachName = v.attached_name || v.attached_to;
    const attachSub  = v.attached_name
      ? `<div class="mono muted" style="font-size:10px">${esc(v.attached_to)}</div>`
      : '';
    const attachDev  = v.attached_device
      ? `<div class="muted" style="font-size:10px">${esc(v.attached_device)}</div>`
      : '';
    const attach = v.attached_to
      ? `<div style="font-size:11px;font-weight:500">${esc(attachName)}</div>${attachSub}${attachDev}`
      : '<span class="muted">—</span>';
    const snapCount  = (v.snapshots || []).length;
    const snapBadge  = snapCount > 0
      ? `<span class="vol-snap-badge">${snapCount} snapshot${snapCount !== 1 ? 's' : ''} ↗</span>`
      : `<span class="vol-snap-none">No backups</span>`;
    return `<tr class="ns-clickable" onclick="openVolModal(${idx})">
      <td>
        <div style="font-weight:500">${v.name ? esc(v.name) : '<span class="muted">—</span>'}</div>
        <div class="mono muted" style="font-size:10px">${esc(v.id)}</div>
      </td>
      <td><div style="font-size:11px;font-weight:600;color:${v.env_color||'var(--t2)'}">${esc(v.account_name||'—')}</div></td>
      <td><span class="tag info" style="font-size:10px">${esc(v.type||'—')}</span></td>
      <td style="font-weight:600">${v.size_gib} GiB</td>
      <td><span style="color:var(--${stateClass});font-size:12px">${stateLbl}</span></td>
      <td>${attach}</td>
      <td class="muted" style="font-size:11px">${esc(v.az||'—')}</td>
      <td>${snapBadge}</td>
    </tr>`;
  }).join('');
}

function _renderS3Rows(buckets) {
  if (!buckets.length) return '<tr><td colspan="8" class="tr-load">No S3 buckets found.</td></tr>';
  return buckets.map((b, idx) => {
    const realIdx  = _s3Entries.indexOf(b);
    const pubClass = b.is_public ? 'crit' : 'ok';
    const pubLbl   = b.is_public ? '⚠ Public' : '🔒 Blocked';
    const encLbl   = b.encryption === 'None'
      ? '<span style="color:var(--crit)">⚠ None</span>'
      : `<span style="color:var(--ok)">${esc(b.encryption)}</span>`;
    const verLbl   = b.versioning === 'Enabled'
      ? '<span style="color:var(--ok)">Enabled</span>'
      : `<span class="muted">${esc(b.versioning||'Disabled')}</span>`;
    const size     = b.size_gib > 0
      ? `${b.size_gib >= 1 ? b.size_gib.toFixed(1) + ' GiB' : (b.size_gib * 1024).toFixed(0) + ' MiB'}`
      : '<span class="muted">—</span>';
    const objs     = b.object_count > 0
      ? b.object_count.toLocaleString()
      : '<span class="muted">—</span>';
    return `<tr class="ns-clickable" style="cursor:pointer" onclick="openS3Modal(${realIdx})">
      <td style="font-weight:500">${esc(b.name)}</td>
      <td><div style="font-size:11px;font-weight:600;color:${b.env_color||'var(--t2)'}">${esc(b.account_name||'—')}</div></td>
      <td class="muted" style="font-size:11px">${esc(b.region||'—')}</td>
      <td style="font-weight:500">${size}</td>
      <td class="muted">${objs}</td>
      <td>${verLbl}</td>
      <td>${encLbl}</td>
      <td><span style="color:var(--${pubClass})">${pubLbl}</span></td>
    </tr>`;
  }).join('');
}

function filterEBS(q) {
  q = (q || (document.getElementById('ebs-filter')?.value || '')).toLowerCase();
  let filtered = _ebsStatFilter ? _ebsEntries.filter(_ebsStatFilter) : _ebsEntries;
  if (q) filtered = filtered.filter(v =>
    (v.name + v.id + v.account_name + v.type + v.az + v.state).toLowerCase().includes(q)
  );
  const tbody = document.getElementById('ebs-tbody');
  if (tbody) tbody.innerHTML = _renderEBSRows(filtered);
}

function filterS3(q) {
  q = (q || (document.getElementById('s3-filter')?.value || '')).toLowerCase();
  let filtered = _s3StatFilter ? _s3Entries.filter(_s3StatFilter) : _s3Entries;
  if (q) filtered = filtered.filter(b =>
    (b.name + b.account_name + b.region).toLowerCase().includes(q)
  );
  const tbody = document.getElementById('s3-tbody');
  if (tbody) tbody.innerHTML = _renderS3Rows(filtered);
}

function storageStatClick(type) {
  const ebsCard    = document.getElementById('ebs-tbody')?.closest('.card');
  const s3Card     = document.getElementById('s3-tbody')?.closest('.card');
  const orphanCard = document.getElementById('orphan-snap-card');

  _ebsStatFilter = null;
  _s3StatFilter  = null;
  if (document.getElementById('ebs-filter')) document.getElementById('ebs-filter').value = '';
  if (document.getElementById('s3-filter'))  document.getElementById('s3-filter').value  = '';

  switch (type) {
    case 'all-ebs':
      filterEBS('');
      ebsCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    case 'inuse':
      _ebsStatFilter = v => v.state === 'in-use';
      filterEBS('');
      ebsCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    case 'unattached':
      _ebsStatFilter = v => v.state === 'available';
      filterEBS('');
      ebsCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    case 'orphaned':
      if (orphanCard && orphanCard.style.display !== 'none') {
        orphanCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      break;
    case 'all-s3':
      filterS3('');
      s3Card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    case 'public-s3':
      _s3StatFilter = b => b.is_public;
      filterS3('');
      s3Card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
  }
}

/* ── VOLUME SNAPSHOT MODAL ────────────────────────────── */
function openVolModal(idx) {
  const vol = _ebsEntries[idx];
  if (!vol) return;

  const overlay = document.getElementById('vol-modal-overlay');
  const snaps   = vol.snapshots || [];

  // Title
  document.getElementById('vol-modal-title').textContent =
    vol.name ? `${vol.name}` : vol.id;
  document.getElementById('vol-modal-sub').textContent =
    `${vol.id}  ·  ${vol.type}  ·  ${vol.size_gib} GiB  ·  ${vol.az}`;

  // Stats row
  const stateCol  = vol.state === 'in-use' ? 'var(--ok)' : 'var(--warn)';
  const encCol    = vol.encrypted ? 'var(--ok)' : 'var(--crit)';
  const snapCount = snaps.length;
  const latestSnap = snaps[0];   // already sorted newest-first
  document.getElementById('vol-modal-stats').innerHTML = `
    <div class="ns-mstat"><div class="ns-mstat-v" style="color:${stateCol}">${vol.state === 'in-use' ? '● In Use' : '◌ Unattached'}</div><div class="ns-mstat-l">State</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v" style="color:${encCol}">${vol.encrypted ? '🔒 Encrypted' : '⚠ Unencrypted'}</div><div class="ns-mstat-l">Encryption</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v">${vol.attached_name || vol.attached_to || '—'}</div><div class="ns-mstat-l">Attached To</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v" style="color:${snapCount > 0 ? 'var(--ok)' : 'var(--warn)'}">${snapCount}</div><div class="ns-mstat-l">Snapshots</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v">${latestSnap ? _fmtDate(latestSnap.start_time) : '—'}</div><div class="ns-mstat-l">Latest Backup</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v">${vol.iops ? vol.iops + ' IOPS' : '—'}</div><div class="ns-mstat-l">IOPS</div></div>
  `;

  // Snapshot table
  const body = document.getElementById('vol-modal-body');
  if (!snaps.length) {
    body.innerHTML = `
      <div style="padding:24px;text-align:center;color:var(--warn)">
        <div style="font-size:28px;margin-bottom:8px">⚠</div>
        <div style="font-weight:600;margin-bottom:4px">No snapshots found</div>
        <div class="muted" style="font-size:12px">This volume has no backups. Consider creating a snapshot policy in AWS Backup or Data Lifecycle Manager.</div>
      </div>`;
  } else {
    const rows = snaps.map(s => {
      const stCls  = s.state === 'completed' ? 'ok' : s.state === 'error' ? 'crit' : 'warn';
      const stLbl  = s.state === 'completed' ? '✓ Completed' : s.state === 'error' ? '✗ Error' : `⏳ ${s.progress || s.state}`;
      const encBit = s.encrypted ? '<span style="color:var(--ok)">🔒</span>' : '<span style="color:var(--crit)">⚠</span>';
      return `<tr>
        <td class="mono" style="font-size:11px">${esc(s.id)}</td>
        <td style="font-size:11px">${s.name ? esc(s.name) : '<span class="muted">—</span>'}</td>
        <td style="font-size:11px;color:var(--t2)">${esc(s.description || '—')}</td>
        <td style="font-weight:600">${s.volume_size} GiB</td>
        <td><span style="color:var(--${stCls});font-size:11px">${stLbl}</span></td>
        <td style="font-size:11px;color:var(--t3)">${_fmtDate(s.start_time)}</td>
        <td style="text-align:center">${encBit}</td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <div style="padding:16px 20px 8px;font-size:11px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:0.05em">
        Snapshot History (${snaps.length})
      </div>
      <div class="tscroll" style="max-height:340px">
        <table class="dt" style="font-size:12px">
          <thead><tr><th>Snapshot ID</th><th>Name</th><th>Description</th><th>Size</th><th>Status</th><th>Created</th><th>Enc</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  overlay.classList.add('open');
  document.addEventListener('keydown', _volModalEsc);
}

function _fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  } catch { return iso; }
}

function _volModalEsc(e) {
  if (e.key === 'Escape') closeVolModal(null);
}

function closeVolModal(e) {
  if (e && e.target !== document.getElementById('vol-modal-overlay')) return;
  document.getElementById('vol-modal-overlay').classList.remove('open');
  document.removeEventListener('keydown', _volModalEsc);
}

/* ── S3 BUCKET DETAIL MODAL ──────────────────────────── */
function openS3Modal(idx) {
  const b = _s3Entries[idx];
  if (!b) return;

  document.getElementById('s3-modal-title').textContent = b.name;
  document.getElementById('s3-modal-sub').textContent =
    `${b.account_name || '—'}  ·  ${b.region || '—'}${b.created ? '  ·  Created ' + _fmtDate(b.created) : ''}`;

  const size = b.size_gib > 0
    ? (b.size_gib >= 1 ? b.size_gib.toFixed(2) + ' GiB' : (b.size_gib * 1024).toFixed(0) + ' MiB')
    : '—';
  const pubCol  = b.is_public  ? 'var(--crit)' : 'var(--ok)';
  const pubLbl  = b.is_public  ? '⚠ Public'    : '🔒 Blocked';
  const encCol  = b.encryption === 'None' ? 'var(--crit)' : 'var(--ok)';
  const verCol  = b.versioning === 'Enabled' ? 'var(--ok)' : 'var(--t3)';

  document.getElementById('s3-modal-stats').innerHTML = `
    <div class="ns-mstat"><div class="ns-mstat-v">${size}</div><div class="ns-mstat-l">Size</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v">${b.object_count > 0 ? b.object_count.toLocaleString() : '—'}</div><div class="ns-mstat-l">Objects</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v" style="color:${pubCol}">${pubLbl}</div><div class="ns-mstat-l">Public Access</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v" style="color:${encCol}">${esc(b.encryption || 'None')}</div><div class="ns-mstat-l">Encryption</div></div>
    <div class="ns-mstat"><div class="ns-mstat-v" style="color:${verCol}">${esc(b.versioning || 'Disabled')}</div><div class="ns-mstat-l">Versioning</div></div>
  `;

  const rows = [
    ['Bucket Name',    esc(b.name)],
    ['Account',        `<span style="color:${b.env_color||'var(--t2)'}; font-weight:600">${esc(b.account_name||'—')}</span>`],
    ['Region',         esc(b.region || '—')],
    ['Created',        b.created ? _fmtDate(b.created) : '—'],
    ['Size',           size],
    ['Objects',        b.object_count > 0 ? b.object_count.toLocaleString() : '—'],
    ['Encryption',     b.encryption === 'None'
                         ? '<span style="color:var(--crit)">⚠ None — data not encrypted at rest</span>'
                         : `<span style="color:var(--ok)">${esc(b.encryption)}</span>`],
    ['Versioning',     b.versioning === 'Enabled'
                         ? '<span style="color:var(--ok)">Enabled</span>'
                         : `<span style="color:var(--t3)">${esc(b.versioning || 'Disabled')}</span>`],
    ['Public Access Block', b.is_public
                         ? '<span style="color:var(--crit)">⚠ Not fully blocked — bucket may be publicly accessible</span>'
                         : '<span style="color:var(--ok)">🔒 All public access blocked</span>'],
  ];

  document.getElementById('s3-modal-body').innerHTML = `
    <div style="padding:16px 20px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        ${rows.map(([k, v]) => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 12px 8px 0;color:var(--t3);width:40%;font-size:11px;text-transform:uppercase;letter-spacing:0.04em">${k}</td>
            <td style="padding:8px 0">${v}</td>
          </tr>`).join('')}
      </table>
    </div>`;

  document.getElementById('s3-modal-overlay').classList.add('open');
  document.addEventListener('keydown', _s3ModalEsc);
}

function _s3ModalEsc(e) {
  if (e.key === 'Escape') closeS3Modal(null);
}

function closeS3Modal(e) {
  if (e && e.target !== document.getElementById('s3-modal-overlay')) return;
  document.getElementById('s3-modal-overlay').classList.remove('open');
  document.removeEventListener('keydown', _s3ModalEsc);
}

/* ── BADGES ───────────────────────────────────────────── */
function updateBadges(ec2, eks, up, gd, alb, iam, storage) {
  const critCount = _events.filter(e => e.severity === 'critical').length;
  const warnCount = _events.filter(e => e.severity === 'warning').length;
  const totalAlerts = critCount + warnCount;
  setBadge('badge-events',   totalAlerts,                   critCount > 0 ? 'crit' : 'warn');
  setBadge('badge-ec2',      ec2.stopped   || 0,            'warn', v => v > 0);
  setBadge('badge-eks',      eks.failed_pods || 0,          'crit', v => v > 0);
  setBadge('badge-uptime',   up.down       || 0,            'warn', v => v > 0);
  setBadge('badge-security', gd.summary?.high || 0,         'crit', v => v > 0);
  const albCrit = (alb.critical || 0) + (alb.degraded || 0);
  setBadge('badge-network',  albCrit,                       'crit', v => v > 0);
  const iamCrit = iam.totals?.critical || 0;
  setBadge('badge-iam',      iamCrit,                       'crit', v => v > 0);
  const storageCrit = (storage?.s3?.public || 0);
  setBadge('badge-storage',  storageCrit,                   'crit', v => v > 0);
}

function setBadge(id, val, cls, showFn = v => v > 0) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  if (showFn(val)) { el.className = `nb show ${cls}`; }
  else             { el.className = 'nb'; }
}

/* ── HELPERS ──────────────────────────────────────────── */
function barCell(pct) {
  const color = usageColor(pct);
  return `<div class="bar-row">
    <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="bar-lbl" style="color:${color}">${pct}%</div>
  </div>`;
}

function stateBadge(state, cpu, mem, disk) {
  if (state !== 'running') return `<span class="badge" style="background:rgba(255,255,255,0.06);color:var(--t3)">${esc(state)}</span>`;
  if (cpu >= 80 || mem >= 90 || disk >= 85) return '<span class="badge crit">critical</span>';
  if (cpu >= 60 || mem >= 80 || disk >= 70) return '<span class="badge warn">warning</span>';
  return '<span class="badge ok">healthy</span>';
}
/* ── Threshold logic ──────────────────────────────────────
   Health bars: higher % = better
     ≥ 95%  → green  (healthy)
     80–94% → yellow (degraded)
     < 80%  → red    (critical)
   ──────────────────────────────────────────────────────── */
function healthColor(pct) {
  if (pct >= 95) return 'var(--ok)';
  if (pct >= 80) return 'var(--warn)';
  return 'var(--crit)';
}

/* CPU/utilisation bars: lower % = better
     < 60%  → green  (healthy)
     60–79% → yellow (watch)
     ≥ 80%  → red    (critical)
*/
function usageColor(pct) {
  if (pct >= 80) return 'var(--crit)';
  if (pct >= 60) return 'var(--warn)';
  return 'var(--ok)';
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = pct + '%';
  el.style.background = healthColor(pct);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}

function setColor(id, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.color = cls === 'ok' ? 'var(--ok)' : cls === 'warn' ? 'var(--warn)' : cls === 'crit' ? 'var(--crit)' : cls === 'info' ? 'var(--info)' : 'var(--t1)';
}

function fmtMi(mi) {
  return mi >= 1024 ? (mi/1024).toFixed(1)+' GiB' : mi+' MiB';
}

function uptimeSince(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const d = Math.floor(ms/86400000);
    const h = Math.floor((ms%86400000)/3600000);
    return d > 0 ? `${d}d ${h}h` : `${h}h`;
  } catch { return '—'; }
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function clearEvents() {
  _events = [];
  renderLogs();
  renderAlerts();
}

/* ── AUTH & USER ──────────────────────────────────────── */
let _currentUser = null;

async function loadCurrentUser() {
  try {
    const resp = await fetch('/auth/me');
    if (resp.status === 401) {
      window.location.href = '/login';
      return;
    }
    _currentUser = await resp.json();

    // Update sidebar user info
    const nameEl   = document.getElementById('user-name');
    const emailEl  = document.getElementById('user-email');
    const avatarEl = document.getElementById('user-avatar');
    const adminBtn = document.getElementById('admin-btn');

    if (nameEl)   nameEl.textContent  = _currentUser.name || _currentUser.email.split('@')[0];
    if (emailEl)  emailEl.textContent = _currentUser.email;
    if (avatarEl) avatarEl.textContent = (_currentUser.name || _currentUser.email)[0].toUpperCase();

    // Show admin button only for admins
    if (adminBtn && _currentUser.role === 'admin') {
      adminBtn.style.display = 'flex';
    }

    applyRoleRestrictions(_currentUser.role);
  } catch (e) {
    console.error('Failed to load user:', e);
  }
}

/* ── ROLE-BASED ACCESS ────────────────────────────────── */
const ROLE_HIDDEN = {
  viewer:      ['alerts', 'logs', 'costs', 'savings', 'security', 'iam', 'admin', 'instances'],
  superviewer: ['alerts', 'logs', 'security', 'iam', 'admin', 'instances'],
  admin:       [],
};

// Individual elements to hide per role (by element id)
const ROLE_HIDDEN_KPIS = {
  viewer:      ['kpi-alerts', 'kpi-cost', 'stat-orphan-count', 'stat-s3-public'],
  superviewer: ['kpi-alerts',        'stat-orphan-count', 'stat-s3-public'],
  admin:       [],
};

function applyRoleRestrictions(role) {
  const hidden = ROLE_HIDDEN[role] || ROLE_HIDDEN['viewer'];
  if (!hidden.length) return;

  // Hide individual nav items
  hidden.forEach(id => {
    document.querySelectorAll(`.nav-item[onclick*="'${id}'"]`)
      .forEach(el => el.style.display = 'none');
  });

  // Hide overview KPI cards
  (ROLE_HIDDEN_KPIS[role] || []).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  // Hide entire nav groups where all items are now hidden
  document.querySelectorAll('.nav-group').forEach(group => {
    const items = group.querySelectorAll('.nav-item');
    if (items.length && Array.from(items).every(el => el.style.display === 'none')) {
      group.style.display = 'none';
    }
  });

  // Guard navigate() — redirect to overview if section is restricted
  const _orig = window.navigate;
  window.navigate = function(id, el) {
    if (hidden.includes(id)) { _orig('overview', null); return; }
    _orig(id, el);
  };
}

async function doLogout() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login';
  }
}

/* ── ADMIN PANEL ──────────────────────────────────────── */
async function loadAdminData() {
  if (!_currentUser || _currentUser.role !== 'admin') return;

  try {
    const [pendingResp, usersResp] = await Promise.all([
      fetch('/admin/pending'),
      fetch('/admin/users'),
    ]);

    const pendingData = await pendingResp.json();
    const usersData   = await usersResp.json();

    const pending = pendingData.pending || [];
    const users   = usersData.users     || [];
    const admins  = users.filter(u => u.role === 'admin').length;

    // KPIs
    setText('admin-pending-count', pending.length);
    setText('admin-user-count',    users.length);
    setText('admin-admin-count',   admins);
    setColor('admin-pending-count', pending.length > 0 ? 'warn' : 'ok');

    // Pending list
    const pendingEl = document.getElementById('admin-pending-list');
    if (pendingEl) {
      if (!pending.length) {
        pendingEl.innerHTML = `<div style="padding:16px;color:var(--t3);font-size:13px;text-align:center">
          ✓ No pending requests
        </div>`;
      } else {
        pendingEl.innerHTML = pending.map(p => `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid rgba(255,255,255,0.04)">
            <div style="width:36px;height:36px;border-radius:50%;background:rgba(251,191,36,0.15);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:var(--warn);flex-shrink:0">
              ${esc(p.name[0]?.toUpperCase() || '?')}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;font-size:13px">${esc(p.name)}</div>
              <div style="font-size:11px;color:var(--t3)">${esc(p.email)}</div>
              <div style="font-size:10px;color:var(--t3);margin-top:2px">
                Requested ${new Date(p.requested_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button onclick="approveUser('${esc(p.email)}')"
                style="padding:6px 14px;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.3);border-radius:6px;color:#4ade80;font-size:12px;font-weight:500;cursor:pointer">
                ✓ Approve
              </button>
              <button onclick="rejectUser('${esc(p.email)}')"
                style="padding:6px 14px;background:rgba(239,83,80,0.1);border:1px solid rgba(239,83,80,0.2);border-radius:6px;color:#ef5350;font-size:12px;cursor:pointer">
                ✗ Reject
              </button>
            </div>
          </div>`).join('');
      }
    }

    // Users table
    const tbody = document.getElementById('admin-users-tbody');
    if (tbody) {
      if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="tr-load">No users yet.</td></tr>';
      } else {
        tbody.innerHTML = users.map(u => `<tr>
          <td style="font-weight:500">${esc(u.name || u.email.split('@')[0])}</td>
          <td class="muted" style="font-size:12px">${esc(u.email)}</td>
          <td>
            ${u.email !== _currentUser?.email ? `
              <select onchange="changeUserRole('${esc(u.email)}', this.value)"
                style="background:var(--bg2);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:var(--t1);font-size:11px;padding:3px 6px;cursor:pointer">
                <option value="viewer"      ${u.role==='viewer'      ? 'selected' : ''}>Viewer</option>
                <option value="superviewer" ${u.role==='superviewer' ? 'selected' : ''}>Superviewer</option>
                <option value="admin"       ${u.role==='admin'       ? 'selected' : ''}>Admin</option>
              </select>` :
              `<span class="badge warn" style="font-size:10px">★ Admin (You)</span>`}
          </td>
          <td class="muted" style="font-size:11px">${esc(u.approved_by || '—')}</td>
          <td class="muted" style="font-size:11px">
            ${u.last_login ? new Date(u.last_login).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'Never'}
          </td>
          <td>
            ${u.email !== _currentUser?.email ? `
              <button onclick="removeUser('${esc(u.email)}')"
                style="padding:4px 10px;background:rgba(239,83,80,0.1);border:1px solid rgba(239,83,80,0.2);border-radius:6px;color:#ef5350;font-size:11px;cursor:pointer">
                Remove
              </button>` : ''}
          </td>
        </tr>`).join('');
      }
    }

  } catch (e) {
    console.error('Admin data load failed:', e);
  }
}

function _csrfHeaders(extra = {}) {
  const csrf = document.cookie.split('; ')
    .find(r => r.startsWith('lg_csrf_token='))
    ?.split('=')[1] || '';
  return {'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...extra};
}

function showConfirmModal({ title, message, confirmLabel = 'Confirm', confirmStyle = 'warn', onConfirm }) {
  const styleMap = {
    ok:   { bg: 'rgba(74,222,128,0.12)',  border: 'rgba(74,222,128,0.3)',  text: 'var(--ok)' },
    warn: { bg: 'rgba(251,191,36,0.15)',  border: 'rgba(251,191,36,0.35)', text: 'var(--warn)' },
    crit: { bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.3)', text: 'var(--crit)' },
  };
  const c = styleMap[confirmStyle] || styleMap.warn;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.65);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--card-border);border-radius:var(--radius-lg);width:100%;max-width:420px;margin:24px;box-shadow:0 24px 60px rgba(0,0,0,0.6);animation:modalIn 0.22s ease">
      <div style="padding:22px 24px 0">
        <div style="font-size:15px;font-weight:600;color:var(--t1);margin-bottom:8px">${title}</div>
        <div style="font-size:13px;color:var(--t3);line-height:1.6">${message}</div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:20px 24px">
        <button id="_cm-cancel" style="padding:8px 18px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius);color:var(--t2);font-size:13px;cursor:pointer">Cancel</button>
        <button id="_cm-ok"     style="padding:8px 18px;background:${c.bg};border:1px solid ${c.border};border-radius:var(--radius);color:${c.text};font-size:13px;font-weight:500;cursor:pointer">${confirmLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#_cm-cancel').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  overlay.querySelector('#_cm-ok').onclick = () => { close(); onConfirm(); };
}

function showToast(message, type = 'ok') {
  const styleMap = {
    ok:   { border: 'rgba(74,222,128,0.3)',  text: 'var(--ok)' },
    warn: { border: 'rgba(251,191,36,0.35)', text: 'var(--warn)' },
    crit: { border: 'rgba(248,113,113,0.3)', text: 'var(--crit)' },
  };
  const c = styleMap[type] || styleMap.ok;
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:28px;right:28px;z-index:3000;background:var(--bg2);border:1px solid ${c.border};border-radius:var(--radius);padding:12px 18px;font-size:13px;color:${c.text};box-shadow:0 8px 32px rgba(0,0,0,0.5);animation:modalIn 0.22s ease;max-width:360px`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function approveUser(email) {
  showConfirmModal({
    title: 'Approve access request',
    message: `Approve <strong style="color:var(--t1)">${esc(email)}</strong> and send them a temporary password by email?`,
    confirmLabel: '✓ Approve',
    confirmStyle: 'ok',
    onConfirm: async () => {
      try {
        const resp = await fetch('/admin/approve', {
          method: 'POST',
          headers: _csrfHeaders(),
          body: JSON.stringify({email}),
        });
        const data = await resp.json();
        if (resp.ok) {
          if (data.temp_password) {
            showConfirmModal({
              title: 'Email delivery failed',
              message: `${esc(email)} was approved but the email failed. Share this password manually:<br><br><code style="font-family:monospace;font-size:13px;color:var(--warn)">${esc(data.temp_password)}</code>`,
              confirmLabel: 'Got it',
              confirmStyle: 'warn',
              onConfirm: () => {},
            });
          } else {
            showToast(`✓ ${email} approved — password sent to their email.`, 'ok');
          }
          loadAdminData();
        } else {
          showToast(`Error: ${data.detail}`, 'crit');
        }
      } catch {
        showToast('Request failed. Please try again.', 'crit');
      }
    },
  });
}

async function rejectUser(email) {
  showConfirmModal({
    title: 'Reject access request',
    message: `Reject the access request from <strong style="color:var(--t1)">${esc(email)}</strong>? They will be notified by email.`,
    confirmLabel: '✗ Reject',
    confirmStyle: 'crit',
    onConfirm: async () => {
      try {
        const resp = await fetch('/admin/reject', {
          method: 'POST',
          headers: _csrfHeaders(),
          body: JSON.stringify({email}),
        });
        const data = await resp.json();
        if (resp.ok) {
          showToast(`Request from ${email} rejected.`, 'warn');
          loadAdminData();
        } else {
          showToast(`Error: ${data.detail}`, 'crit');
        }
      } catch {
        showToast('Request failed.', 'crit');
      }
    },
  });
}

async function removeUser(email) {
  showConfirmModal({
    title: 'Remove user',
    message: `Remove <strong style="color:var(--t1)">${esc(email)}</strong> from the dashboard? They will lose access immediately.`,
    confirmLabel: 'Remove',
    confirmStyle: 'crit',
    onConfirm: async () => {
      try {
        const resp = await fetch(`/admin/users/${encodeURIComponent(email)}`, {
          method: 'DELETE',
          headers: _csrfHeaders(),
        });
        const data = await resp.json();
        if (resp.ok) {
          showToast(`${email} removed.`, 'warn');
          loadAdminData();
        } else {
          showToast(`Error: ${data.detail}`, 'crit');
        }
      } catch {
        showToast('Request failed.', 'crit');
      }
    },
  });
}

async function changeUserRole(email, role) {
  try {
    const resp = await fetch(`/admin/users/${encodeURIComponent(email)}/role`, {
      method: 'PATCH',
      headers: _csrfHeaders(),
      body: JSON.stringify({role}),
    });
    if (!resp.ok) {
      const data = await resp.json();
      alert(`Error: ${data.detail}`);
      loadAdminData(); // reset dropdown
    }
  } catch (e) {
    alert('Request failed.');
    loadAdminData();
  }
}

// Load user on page init and load admin data when admin panel is opened
document.addEventListener('DOMContentLoaded', () => {
  loadCurrentUser();
});

// Override navigate to load admin data when admin panel opens
const _origNavigate = navigate;
// Patch navigate to trigger admin data load
(function() {
  const origNav = window.navigate;
  window.navigate = function(section, el) {
    origNav(section, el);
    if (section === 'admin')      loadAdminData();
    if (section === 'appperf')   { _initSyncMonthPicker(); loadSyncStatus(); loadSyncHistory(); }
    if (section === 'containers') loadContainerHealth();
  };
})();

/* ═══════════════════════════════════════════════════════
   APP PERFORMANCE — CHT Sync Status
   ═══════════════════════════════════════════════════════ */

function renderAppPerf(tel) {
  _initSyncMonthPicker();
  loadSyncStatus();
  loadSyncHistory();
}

/* ── CHW Sync Status (ClickHouse) ─────────────────────────────── */

function _initSyncMonthPicker() {
  const sel = document.getElementById('ap-sync-month');
  if (!sel || sel.options.length > 0) return;

  const now   = new Date();
  // default = previous month
  const defY  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const defM  = now.getMonth() === 0 ? 12 : now.getMonth();
  const defVal = `${defY}-${String(defM).padStart(2,'0')}`;

  // build options Jan 2026 → current month
  const months = [];
  let y = 2026, m = 1;
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    months.push(`${y}-${String(m).padStart(2,'0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }

  months.reverse().forEach(val => {
    const [yr, mo] = val.split('-');
    const label = new Date(+yr, +mo - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === defVal) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function loadSyncStatus(month) {
  const sel   = document.getElementById('ap-sync-month');
  const tbody = document.getElementById('ap-sync-unified-body');
  const chosen = month || (sel && sel.value) || '';
  const url    = '/api/sync-status' + (chosen ? `?month=${chosen}` : '');

  if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="tr-load">Loading…</td></tr>`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _syncStatusData = await r.json();
    renderSyncTable(_syncStatusData);
    if (_syncHistoryData) renderSyncChart(_syncHistoryData, chosen);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding:16px;color:var(--t3);text-align:center">Could not load sync data: ${e.message}</td></tr>`;
  }
}

function renderSyncTable(data) {
  const tbody  = document.getElementById('ap-sync-unified-body');
  const period = document.getElementById('ap-sync-period');
  if (!tbody) return;

  if (period) period.textContent = data.month ? `${data.month} · from ClickHouse` : '';

  function _n(v) { return v != null ? Number(v).toLocaleString() : '—'; }
  function _pctColor(pct) {
    if (pct == null) return 'var(--t3)';
    if (pct >= 70)   return 'var(--ok)';
    if (pct >= 50)   return 'var(--warn)';
    return 'var(--crit)';
  }
  function _pctCell(pct) {
    const col = _pctColor(pct);
    const val = pct != null ? pct.toFixed(1) + '%' : '—';
    return `<td style="text-align:right;font-weight:700;color:${col}">${val}</td>`;
  }

  function _row(r, isTotals) {
    if (r.error) {
      return `<tr><td>${esc(r.region)}</td><td colspan="7" style="color:var(--crit);font-size:11px">${esc(r.error)}</td></tr>`;
    }
    const bg = isTotals ? 'background:var(--bg);font-weight:600;border-top:2px solid var(--border)' : '';
    return `<tr style="${bg}">
      <td>${esc(r.region)}</td>
      <td style="text-align:right">${_n(r.total_chws)}</td>
      <td style="text-align:right">${_n(r.supervisors)}</td>
      <td style="text-align:right;color:var(--ok)">${_n(r.chws_synced)}</td>
      <td style="text-align:right;color:${r.chws_no_sync > 0 ? 'var(--warn)' : 'var(--t3)'}">${_n(r.chws_no_sync)}</td>
      <td style="text-align:right">${_n(r.total_chw_days)}</td>
      <td style="text-align:right">${_n(r.successful_days)}</td>
      ${_pctCell(r.success_pct)}
    </tr>`;
  }

  const regionRows = (data.regions || []).map(r => _row(r, false)).join('');
  const totalsRow  = data.totals ? _row({ region: 'TOTAL', ...data.totals }, true) : '';
  tbody.innerHTML  = (regionRows + totalsRow) || `<tr><td colspan="8" style="padding:16px;color:var(--t3);text-align:center">No data</td></tr>`;
}

/* ── CHW-Day Sync Rate Trend chart ────────────────────────── */

async function loadSyncHistory() {
  const chartDiv = document.getElementById('ap-sync-chart');
  if (!chartDiv) return;

  // If already fetched, just re-render (width may now be correct after section shown)
  if (_syncHistoryData) {
    const sel = document.getElementById('ap-sync-month');
    renderSyncChart(_syncHistoryData, sel ? sel.value : '');
    return;
  }

  chartDiv.innerHTML = `<div style="padding:40px;color:var(--t3);text-align:center;font-size:13px">Loading chart…</div>`;
  try {
    const r = await fetch('/api/sync-history');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _syncHistoryData = await r.json();
    const sel = document.getElementById('ap-sync-month');
    renderSyncChart(_syncHistoryData, sel ? sel.value : '');
  } catch (e) {
    chartDiv.innerHTML = `<div style="padding:40px;color:var(--t3);text-align:center;font-size:13px">Chart unavailable: ${e.message}</div>`;
  }
}

function renderSyncChart(data, selectedMonth) {
  const chartDiv = document.getElementById('ap-sync-chart');
  if (!chartDiv || !data) return;

  const months = data.months || [];
  const series = data.series || [];
  const n = months.length;
  if (!n) {
    chartDiv.innerHTML = `<div style="padding:40px;color:var(--t3);text-align:center;font-size:13px">No history data</div>`;
    return;
  }

  // Categorical palette (validated slots 1–5 + TOTAL as muted ink)
  const PAL_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
  const PAL_DARK  = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
  const TOTAL_COLOR = '#898781';

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (document.documentElement.getAttribute('data-theme') !== 'light' &&
     window.matchMedia('(prefers-color-scheme: dark)').matches);
  const pal = isDark ? PAL_DARK : PAL_LIGHT;

  function sCol(s, si) { return s.dashed ? TOTAL_COLOR : pal[Math.min(si, pal.length - 1)]; }

  // Canvas dims
  const W  = Math.max(chartDiv.getBoundingClientRect().width || 0, 400);
  const H  = 320;
  const ml = 52, mr = 148, mt = 24, mb = 48;
  const pw = W - ml - mr;
  const ph = H - mt - mb;

  function xv(i) { return n === 1 ? ml + pw / 2 : ml + (i / (n - 1)) * pw; }
  function yv(v) { return mt + ph * (1 - v / 100); }

  function moLabel(m) {
    const [yr, mo] = m.split('-');
    return new Date(+yr, +mo - 1, 1).toLocaleDateString([], { month: 'short', year: '2-digit' });
  }

  const selIdx = selectedMonth ? months.indexOf(selectedMonth) : -1;
  const colW   = n > 1 ? pw / (n - 1) : pw;

  let p = [];

  // Gridlines + Y-axis labels
  [0, 25, 50, 75, 100].forEach(v => {
    const y = yv(v).toFixed(1);
    p.push(`<line x1="${ml}" y1="${y}" x2="${ml + pw}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`);
    p.push(`<text x="${ml - 7}" y="${(+y + 4).toFixed(0)}" text-anchor="end" font-size="11" fill="var(--t3)" font-variant-numeric="tabular-nums">${v}%</text>`);
  });

  // X-axis labels (skip to avoid crowding)
  const skip = n > 14 ? 3 : n > 8 ? 2 : 1;
  months.forEach((m, i) => {
    if (i % skip !== 0 && i !== n - 1) return;
    p.push(`<text x="${xv(i).toFixed(1)}" y="${(mt + ph + 18).toFixed(0)}" text-anchor="middle" font-size="11" fill="var(--t3)">${moLabel(m)}</text>`);
  });

  // Selected month highlight band
  if (selIdx >= 0) {
    const bx = (xv(selIdx) - colW / 2).toFixed(1);
    p.push(`<rect x="${bx}" y="${mt}" width="${colW.toFixed(1)}" height="${ph}" fill="var(--accent)" opacity="0.07" rx="2"/>`);
    p.push(`<line x1="${xv(selIdx).toFixed(1)}" y1="${mt}" x2="${xv(selIdx).toFixed(1)}" y2="${mt + ph}" stroke="var(--accent)" stroke-width="1.5" opacity="0.35" stroke-dasharray="4,3"/>`);
  }

  // Lines (segment-aware: break at nulls)
  series.forEach((s, si) => {
    const col  = sCol(s, si);
    const dash = s.dashed ? 'stroke-dasharray="7,4"' : '';
    let pts = [], inSeg = false;
    s.values.forEach((v, i) => {
      if (v == null) {
        if (inSeg && pts.length) {
          p.push(`<polyline points="${pts.join(' ')}" stroke="${col}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" ${dash}/>`);
          pts = []; inSeg = false;
        }
      } else {
        pts.push(`${xv(i).toFixed(1)},${yv(v).toFixed(1)}`);
        inSeg = true;
      }
    });
    if (pts.length) p.push(`<polyline points="${pts.join(' ')}" stroke="${col}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" ${dash}/>`);
  });

  // Dots (drawn after lines so they're on top)
  series.forEach((s, si) => {
    const col = sCol(s, si);
    s.values.forEach((v, i) => {
      if (v == null) return;
      const x = xv(i).toFixed(1), y = yv(v).toFixed(1);
      p.push(`<circle cx="${x}" cy="${y}" r="5.5" fill="var(--card)"/>`);
      p.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="${col}"/>`);
    });
  });

  // Crosshair (hidden until hover)
  p.push(`<line id="ap-ch-line" x1="0" y1="${mt}" x2="0" y2="${mt + ph}" stroke="var(--t3)" stroke-width="1" opacity="0" pointer-events="none"/>`);

  // Transparent hover columns
  p.push('<g>');
  months.forEach((_, i) => {
    const lx = Math.max(ml, xv(i) - colW / 2).toFixed(1);
    p.push(`<rect x="${lx}" y="${mt}" width="${Math.min(colW, pw).toFixed(1)}" height="${ph}" fill="transparent" data-i="${i}" class="ch-col" style="cursor:crosshair"/>`);
  });
  p.push('</g>');

  // Legend (right of plot area)
  let ly = mt + 4;
  series.forEach((s, si) => {
    const col  = sCol(s, si);
    const dash = s.dashed ? 'stroke-dasharray="6,3"' : '';
    p.push(`<line x1="${ml + pw + 18}" y1="${ly}" x2="${ml + pw + 40}" y2="${ly}" stroke="${col}" stroke-width="2" ${dash}/>`);
    p.push(`<text x="${ml + pw + 46}" y="${ly + 4}" font-size="11" fill="var(--t2)">${esc(s.region)}</text>`);
    ly += 22;
  });

  chartDiv.innerHTML = `
    <svg id="ap-ch-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;max-width:100%">
      ${p.join('\n')}
    </svg>
    <div id="ap-ch-tip" style="display:none;position:absolute;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12px;pointer-events:none;z-index:20;min-width:175px;box-shadow:0 4px 20px rgba(0,0,0,.25)"></div>
  `;

  const chLine = document.getElementById('ap-ch-line');
  const tip    = document.getElementById('ap-ch-tip');

  chartDiv.querySelectorAll('.ch-col').forEach(col => {
    col.addEventListener('mouseenter', () => {
      const i  = parseInt(col.dataset.i);
      const cx = xv(i).toFixed(1);
      chLine.setAttribute('x1', cx); chLine.setAttribute('x2', cx); chLine.setAttribute('opacity', '0.6');

      let html = `<div style="font-weight:600;color:var(--t1);margin-bottom:6px;font-size:13px">${moLabel(months[i])}</div>`;
      series.forEach((s, si) => {
        const v   = s.values[i];
        const col = sCol(s, si);
        const val = v != null ? v.toFixed(1) + '%' : '—';
        const bg  = s.dashed
          ? `background:repeating-linear-gradient(90deg,${col} 0,${col} 5px,transparent 5px,transparent 8px)`
          : `background:${col}`;
        html += `<div style="display:flex;align-items:center;gap:8px;padding:2px 0">
          <span style="display:inline-block;width:18px;height:2px;${bg};flex-shrink:0"></span>
          <span style="color:var(--t2);flex:1;white-space:nowrap">${esc(s.region)}</span>
          <strong style="color:var(--t1);font-variant-numeric:tabular-nums;margin-left:8px">${val}</strong>
        </div>`;
      });
      tip.innerHTML = html;

      const tipX = xv(i) > W * 0.62 ? xv(i) - 192 : xv(i) + 14;
      tip.style.left    = tipX + 'px';
      tip.style.top     = (mt + 4) + 'px';
      tip.style.display = 'block';
    });
    col.addEventListener('mouseleave', () => {
      chLine.setAttribute('opacity', '0');
      tip.style.display = 'none';
    });
  });
}

/* ═══════════════════════════════════════════════════════
   CONTAINER HEALTH — Standalone EC2 Docker Monitoring
   ═══════════════════════════════════════════════════════ */

async function loadContainerHealth() {
  const wrap = document.getElementById('ct-host-cards');
  if (!wrap) return;
  wrap.innerHTML = `<div class="card" style="padding:32px;text-align:center;color:var(--t3);font-size:13px">Loading…</div>`;
  try {
    const r = await fetch('/api/container-health');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderContainerHealth(data);
  } catch (e) {
    wrap.innerHTML = `<div class="card" style="padding:32px;text-align:center;color:var(--crit);font-size:13px">Could not load container data: ${e.message}</div>`;
  }
}

function renderContainerHealth(data) {
  const wrap = document.getElementById('ct-host-cards');
  if (!wrap) return;

  if (!data.configured) {
    wrap.innerHTML = `
      <div class="card" style="padding:32px;text-align:center">
        <div style="font-size:15px;font-weight:600;color:var(--t1);margin-bottom:8px">Container Health not configured</div>
        <div style="color:var(--t3);font-size:13px;margin-bottom:16px">
          Enable the Docker Remote API on each EC2 instance, then set <code style="background:var(--bg2);padding:2px 6px;border-radius:4px">DOCKER_HOSTS</code> in your environment.
        </div>
        <code style="display:inline-block;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 16px;font-size:12px;color:var(--t2);text-align:left">
          DOCKER_HOSTS=[{"name":"Server Name","host":"1.2.3.4","port":2375}]
        </code>
      </div>`;
    ['ct-kpi-running','ct-kpi-failed','ct-kpi-stopped','ct-kpi-hosts'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '—';
    });
    return;
  }

  // Aggregate KPIs across all hosts
  let totalRunning = 0, totalFailed = 0, totalStopped = 0;
  (data.hosts || []).forEach(h => {
    (h.containers || []).forEach(c => {
      if (c.state === 'running') totalRunning++;
      else if (c.state === 'exited' && c.exit_code !== 0) totalFailed++;
      else if (c.state === 'exited' && c.exit_code === 0) totalStopped++;
    });
  });

  const _set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  _set('ct-kpi-running',  totalRunning);
  _set('ct-kpi-failed',   totalFailed);
  _set('ct-kpi-stopped',  totalStopped);
  _set('ct-kpi-hosts',    (data.hosts || []).length);

  // Badge
  const badge = document.getElementById('badge-containers');
  if (badge) {
    if (totalFailed > 0) { badge.textContent = totalFailed; badge.style.display = ''; }
    else badge.style.display = 'none';
  }

  function _stateCell(c) {
    if (c.state === 'running')   return `<td><span style="color:var(--ok);font-weight:600">● running</span></td>`;
    if (c.state === 'restarting') return `<td><span style="color:var(--warn);font-weight:600">↻ restarting</span></td>`;
    if (c.state === 'paused')    return `<td><span style="color:var(--t3)">⏸ paused</span></td>`;
    if (c.state === 'exited') {
      if (c.exit_code === 0) return `<td><span style="color:var(--t3)">◻ stopped</span></td>`;
      return `<td><span style="color:var(--crit);font-weight:600">✗ failed (${c.exit_code})</span></td>`;
    }
    return `<td><span style="color:var(--t3)">${esc(c.state)}</span></td>`;
  }

  function _pct(v) { return v != null ? v.toFixed(1) + '%' : '—'; }
  function _mb(v)  { return v != null ? v.toFixed(0) + ' MB' : '—'; }

  function _rowBg(c) {
    if (c.state === 'exited' && c.exit_code !== 0) return 'background:rgba(239,83,80,.05)';
    if (c.state === 'restarting') return 'background:rgba(255,167,38,.05)';
    return '';
  }

  const cards = (data.hosts || []).map(h => {
    if (h.error) {
      return `
        <div class="card" style="margin-bottom:16px">
          <div class="card-hdr">
            <span class="card-title">${esc(h.host)}</span>
            <span style="color:var(--crit);font-size:12px">Unreachable: ${esc(h.error)}</span>
          </div>
        </div>`;
    }

    const rows = (h.containers || []).map(c => `
      <tr style="${_rowBg(c)}">
        <td style="font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.name)}">${esc(c.name)}</td>
        <td style="color:var(--t3);font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.image)}">${esc(c.image)}</td>
        ${_stateCell(c)}
        <td style="text-align:right;font-variant-numeric:tabular-nums">${_pct(c.cpu_pct)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${_mb(c.mem_mb)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--t3)">${_pct(c.mem_pct)}</td>
        <td style="color:var(--t3);font-size:11px">${esc(c.status)}</td>
      </tr>`).join('');

    const noContainers = !h.containers || h.containers.length === 0
      ? `<tr><td colspan="7" style="padding:16px;color:var(--t3);text-align:center">No containers found</td></tr>`
      : '';

    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-hdr">
          <span class="card-title">${esc(h.host)}</span>
          <span class="muted" style="font-size:11px">${(h.containers||[]).length} container${(h.containers||[]).length !== 1 ? 's' : ''}</span>
          <button class="btn-sm" style="margin-left:auto" onclick="loadContainerHealth()">↻ Refresh</button>
        </div>
        <div class="tscroll">
          <table class="dt">
            <thead><tr>
              <th>Container</th>
              <th>Image</th>
              <th>State</th>
              <th style="text-align:right">CPU%</th>
              <th style="text-align:right">Memory</th>
              <th style="text-align:right">Mem%</th>
              <th>Status</th>
            </tr></thead>
            <tbody>${rows || noContainers}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  wrap.innerHTML = cards || `<div class="card" style="padding:32px;text-align:center;color:var(--t3);font-size:13px">No hosts configured</div>`;
}

/* ── INSTANCE CONTROL ─────────────────────────────────────── */
let _instances = [];
let _pendingInstAction = null;

async function loadInstances() {
  const grid = document.getElementById('inst-cards');
  if (grid) grid.innerHTML = '<div class="card" style="padding:32px;text-align:center;color:var(--t3);font-size:13px">Loading…</div>';
  try {
    const r = await fetch('/api/instances', { credentials: 'same-origin' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || `HTTP ${r.status}`);
    }
    const data = await r.json();
    _instances = data.instances || [];
    renderInstances();
  } catch (e) {
    console.error('[instances] load failed', e);
    if (grid) grid.innerHTML = `<div class="card" style="padding:32px;text-align:center;color:var(--crit);font-size:13px">Failed to load instances: ${e.message}</div>`;
  }
}

function renderInstances() {
  const grid = document.getElementById('inst-cards');
  if (!grid) return;

  const running     = _instances.filter(i => i.state === 'running').length;
  const stopped     = _instances.filter(i => i.state === 'stopped').length;
  const transitioning = _instances.length - running - stopped;
  setText('inst-stat-total',   _instances.length || '—');
  setText('inst-stat-running', running || '—');
  setText('inst-stat-stopped', stopped || '—');
  setText('inst-stat-other',   transitioning > 0 ? transitioning : '—');

  if (!_instances.length) {
    grid.innerHTML = '<div class="card" style="padding:32px;text-align:center;color:var(--t3);font-size:13px">No dev or staging instances found across Dev/QA accounts.</div>';
    return;
  }

  const TRANSIT = new Set(['pending', 'stopping', 'shutting-down', 'rebooting']);

  grid.innerHTML = _instances.map(inst => {
    const isRunning  = inst.state === 'running';
    const isTransit  = TRANSIT.has(inst.state);
    const stateColor = isRunning ? 'var(--ok)' : isTransit ? 'var(--warn)' : 'var(--t3)';
    const envColor   = inst.environment === 'staging' ? '#ffb74d' : '#60a5fa';

    const lastAct = inst.last_action
      ? `<div style="font-size:10px;color:var(--t3);margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.05)">
           Last: <strong>${inst.last_action.action}</strong> by ${_instEsc(inst.last_action.user)} · ${_instFmtTs(inst.last_action.ts)}
         </div>`
      : '';

    const startDisabled = isRunning || isTransit;
    const stopDisabled  = !isRunning || isTransit;

    const startBtn = `<button class="btn-sm" style="${startDisabled ? 'opacity:.4;cursor:not-allowed' : 'background:rgba(74,222,128,.1);border-color:rgba(74,222,128,.3);color:#4ade80;font-weight:500'}"
      ${startDisabled ? 'disabled' : `onclick="confirmInstAction('start','${_instEsc(inst.id)}','${_instEsc(inst.name)}')"`}>▶ Start</button>`;
    const stopBtn  = `<button class="btn-sm" style="${stopDisabled ? 'opacity:.4;cursor:not-allowed' : 'background:rgba(239,83,80,.08);border-color:rgba(239,83,80,.3);color:var(--crit);font-weight:500'}"
      ${stopDisabled ? 'disabled' : `onclick="confirmInstAction('stop','${_instEsc(inst.id)}','${_instEsc(inst.name)}')"`}>■ Stop</button>`;

    return `<div class="card" style="padding:18px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
        <div style="min-width:0;flex:1;margin-right:12px">
          <div style="font-size:14px;font-weight:600;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_instEsc(inst.name)}</div>
          <div style="font-size:11px;color:var(--t3);margin-top:2px">${_instEsc(inst.id)} · ${_instEsc(inst.type)}</div>
        </div>
        <span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;color:${stateColor};flex-shrink:0">
          <span style="width:7px;height:7px;border-radius:50%;background:${stateColor}"></span>
          ${_instEsc(inst.state)}
        </span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        <span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(0,0,0,.2);border:1px solid ${envColor}44;color:${envColor};font-weight:500;text-transform:uppercase;letter-spacing:.4px">${_instEsc(inst.environment)}</span>
        <span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(255,255,255,.04);color:var(--t3)">${_instEsc(inst.account_name)}</span>
        <span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(255,255,255,.04);color:var(--t3)">${_instEsc(inst.region)}</span>
      </div>
      ${lastAct}
      <div style="display:flex;gap:8px;margin-top:14px">
        ${startBtn}
        ${stopBtn}
      </div>
    </div>`;
  }).join('');
}

function confirmInstAction(action, instanceId, name) {
  _pendingInstAction = { action, instanceId };
  const overlay = document.getElementById('inst-confirm-overlay');
  if (!overlay) return;
  document.getElementById('inst-confirm-title').textContent = action === 'start' ? 'Start instance?' : 'Stop instance?';
  document.getElementById('inst-confirm-body').textContent  =
    `Are you sure you want to ${action} "${name}" (${instanceId})? ` +
    (action === 'start' ? 'The team will be notified via Slack.' : 'This will interrupt any running workloads.');
  const okBtn = document.getElementById('inst-confirm-ok');
  okBtn.textContent         = action === 'start' ? '▶ Start instance' : '■ Stop instance';
  okBtn.style.background    = action === 'start' ? 'rgba(74,222,128,.15)' : 'rgba(239,83,80,.1)';
  okBtn.style.borderColor   = action === 'start' ? 'rgba(74,222,128,.4)'  : 'rgba(239,83,80,.3)';
  okBtn.style.color         = action === 'start' ? '#4ade80'              : 'var(--crit)';
  okBtn.onclick = executeInstAction;
  overlay.style.display = 'flex';
}

function closeInstConfirm() {
  const overlay = document.getElementById('inst-confirm-overlay');
  if (overlay) overlay.style.display = 'none';
  _pendingInstAction = null;
}

async function executeInstAction() {
  if (!_pendingInstAction) return;
  const { action, instanceId } = _pendingInstAction;
  closeInstConfirm();
  try {
    const r = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || `HTTP ${r.status}`);
    }
    await loadInstances();
  } catch (e) {
    alert(`Failed to ${action} instance: ${e.message}`);
  }
}

function _instFmtTs(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return iso; }
}

function _instEsc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ── NGSA FHIR ────────────────────────────────────────────── */
function renderNGSAFHIR(d) {
  const statusEl  = document.getElementById('ngsa-kpi-status');
  const tokenMs   = document.getElementById('ngsa-kpi-token-ms');
  const fhirMs    = document.getElementById('ngsa-kpi-fhir-ms');
  const checkedEl = document.getElementById('ngsa-kpi-checked');
  const badge     = document.getElementById('ngsa-overall-badge');
  const checksEl  = document.getElementById('ngsa-checks');
  const navBadge  = document.getElementById('badge-ngsa');

  if (!statusEl) return;

  if (!d || !d.status) {
    statusEl.textContent = '—';
    if (checksEl) checksEl.innerHTML = '<div style="padding:24px;color:var(--t3);font-size:12px;text-align:center">No data — check NGSA_FHIR_KC_CLIENT_SECRET is set</div>';
    return;
  }

  const healthy = d.status === 'healthy';
  const color   = healthy ? 'var(--ok)' : 'var(--crit)';
  const label   = healthy ? 'Healthy' : 'Down';

  // KPI row
  statusEl.textContent  = label;
  statusEl.style.color  = color;

  const tkMs = d.checks?.token?.latency_ms;
  const fMs  = d.checks?.fhir_metadata?.latency_ms;
  if (tokenMs)  { tokenMs.textContent  = tkMs != null ? tkMs + ' ms' : '—'; tokenMs.className  = 'po-v muted'; }
  if (fhirMs)   { fhirMs.textContent   = fMs  != null ? fMs  + ' ms' : '—'; fhirMs.className   = 'po-v muted'; }
  if (checkedEl && d.last_checked) {
    try { checkedEl.textContent = new Date(d.last_checked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (_) { checkedEl.textContent = '—'; }
  }

  // Header badge
  if (badge) {
    badge.textContent       = label;
    badge.style.background  = healthy ? 'rgba(74,222,128,0.15)' : 'rgba(239,83,80,0.15)';
    badge.style.color       = color;
    badge.style.border      = `1px solid ${color}`;
  }

  // Sidebar badge
  if (navBadge) navBadge.style.display = healthy ? 'none' : 'inline-flex';

  // Check rows
  if (checksEl) {
    const rows = [
      { label: 'Keycloak Auth Token', key: 'token' },
      { label: 'FHIR /metadata',      key: 'fhir_metadata' },
    ];
    checksEl.innerHTML = rows.map(({ label: lbl, key }) => {
      const chk    = d.checks?.[key] || {};
      const ok     = chk.status === 'ok';
      const skip   = chk.status === 'skipped';
      const dot    = skip ? 'var(--t3)' : ok ? 'var(--ok)' : 'var(--crit)';
      const txt    = skip ? 'skipped' : ok ? 'OK' : (chk.error || `HTTP ${chk.http_status || '—'}`);
      const lat    = chk.latency_ms != null ? `<span style="color:var(--t3);margin-left:8px">${chk.latency_ms} ms</span>` : '';
      return `<div class="hb-row" style="padding:8px 0;border-bottom:1px solid var(--card-border)">
        <span class="hb-lbl">${esc(lbl)}</span>
        <span style="font-size:12px;color:${dot};margin-left:auto">●</span>
        <span style="font-size:12px;color:var(--t2);margin-left:6px;min-width:60px">${esc(txt)}</span>
        ${lat}
      </div>`;
    }).join('');
  }

  if (d.error && !healthy) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'padding:8px 0;font-size:12px;color:var(--crit)';
    errDiv.textContent = d.error;
    checksEl.appendChild(errDiv);
  }
}

