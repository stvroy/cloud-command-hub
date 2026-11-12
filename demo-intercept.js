/* ── DEMO MODE INTERCEPTOR ───────────────────────────────────────────────
   Intercepts all fetch() calls and returns realistic mock data.
   No live backend is required — this is a portfolio demo.
   ─────────────────────────────────────────────────────────────────────── */

(function () {
  const _realFetch = window.fetch.bind(window);

  function _mockResp(data, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  function _spark(base, variance, len = 7) {
    return Array.from({ length: len }, () =>
      Math.round((base + (Math.random() - 0.5) * variance * 2) * 10) / 10
    );
  }

  /* ── MOCK DATA ──────────────────────────────────────────────────────── */

  const NOW = new Date().toISOString();

  const MOCK = {};

  /* ── User ── */
  MOCK.user = { name: 'Stephen O. Roy', email: 'demo@cloudcommand.hub', role: 'admin' };

  /* ── EC2 ── */
  function mkInst(id, name, type, state, az, region, acct, acctName, env, color, isEks, cpu, mem, disk) {
    return {
      id, name, type, state, az, region,
      account_id: acct, account_name: acctName, environment: env, env_color: color,
      is_eks_node: isEks, eks_cluster: isEks ? 'prod-cluster' : null,
      eks_nodegroup: isEks ? 'general-ng' : null,
      launch_time: new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
      private_ip: `10.${Math.floor(Math.random()*3)+0}.${Math.floor(Math.random()*50)+10}.${Math.floor(Math.random()*200)+10}`,
      public_ip: state === 'running' && !isEks ? `54.${Math.floor(Math.random()*50)+100}.${Math.floor(Math.random()*200)+10}.${Math.floor(Math.random()*200)+10}` : null,
      metrics: {
        cpu_percent: state === 'running' ? cpu : 0,
        mem_percent: state === 'running' ? mem : 0,
        disk_percent: state === 'running' ? disk : 0,
        cpu_spark:  state === 'running' ? _spark(cpu, 8) : [],
        mem_spark:  state === 'running' ? _spark(mem, 5) : [],
        disk_spark: state === 'running' ? _spark(disk, 2) : [],
        disk_mounts: state === 'running' ? [{ mount: '/', used_pct: disk }] : [],
        mem_total_gb: type.includes('xlarge') ? 16 : type.includes('large') ? 8 : 4,
        mem_avail_gb: state === 'running' ? Math.round((1 - mem / 100) * (type.includes('xlarge') ? 16 : type.includes('large') ? 8 : 4) * 10) / 10 : 0,
      }
    };
  }

  const instances = [
    mkInst('i-0a1b2c3d4e5f0001','prod-web-01',   't3.medium','running','us-east-1a','us-east-1','123456789012','prod-east','prod','#0057b8',false,18.4,52.1,34.2),
    mkInst('i-0a1b2c3d4e5f0002','prod-web-02',   't3.medium','running','us-east-1b','us-east-1','123456789012','prod-east','prod','#0057b8',false,22.7,61.3,34.9),
    mkInst('i-0a1b2c3d4e5f0003','prod-api-01',   't3.large', 'running','us-east-1a','us-east-1','123456789012','prod-east','prod','#0057b8',false,41.2,68.4,51.3),
    mkInst('i-0a1b2c3d4e5f0004','prod-api-02',   't3.large', 'running','us-east-1b','us-east-1','123456789012','prod-east','prod','#0057b8',false,38.9,65.7,50.1),
    mkInst('i-0a1b2c3d4e5f0005','prod-api-03',   't3.large', 'running','us-east-1c','us-east-1','123456789012','prod-east','prod','#0057b8',false,35.6,71.2,48.7),
    mkInst('i-0a1b2c3d4e5f0006','prod-worker-01','t3.medium','running','us-east-1a','us-east-1','123456789012','prod-east','prod','#0057b8',false,67.3,78.4,62.1),
    mkInst('i-0a1b2c3d4e5f0007','prod-eks-node-01','m5.xlarge','running','us-east-1a','us-east-1','123456789012','prod-east','prod','#0057b8',true,54.1,66.2,41.3),
    mkInst('i-0a1b2c3d4e5f0008','prod-eks-node-02','m5.xlarge','running','us-east-1b','us-east-1','123456789012','prod-east','prod','#0057b8',true,51.8,58.9,39.7),
    mkInst('i-0a1b2c3d4e5f0009','prod-db-replica','r5.large', 'running','us-east-1b','us-east-1','123456789012','prod-east','prod','#0057b8',false,12.3,84.6,73.4),
    mkInst('i-0a1b2c3d4e5f0010','prod-bastion',  't3.nano',  'stopped','us-east-1a','us-east-1','123456789012','prod-east','prod','#0057b8',false,0,0,0),
    mkInst('i-0b2c3d4e5f600011','stg-api-01',   't3.small', 'running','us-west-2a','us-west-2','210987654321','staging','staging','#26a69a',false,28.4,44.2,29.3),
    mkInst('i-0b2c3d4e5f600012','stg-api-02',   't3.small', 'running','us-west-2b','us-west-2','210987654321','staging','staging','#26a69a',false,31.7,48.9,31.1),
    mkInst('i-0b2c3d4e5f600013','stg-worker-01','t3.small', 'running','us-west-2a','us-west-2','210987654321','staging','staging','#26a69a',false,19.2,36.7,22.4),
    mkInst('i-0b2c3d4e5f600014','stg-dev-01',   't3.micro', 'stopped','us-west-2a','us-west-2','210987654321','staging','staging','#26a69a',false,0,0,0),
  ];

  MOCK.metrics = {};
  MOCK.metrics.ec2 = {
    total: instances.length,
    running: instances.filter(i => i.state === 'running').length,
    stopped: instances.filter(i => i.state === 'stopped').length,
    instances,
    by_account: [
      { account_id: '123456789012', account_name: 'prod-east', environment: 'prod', color: '#0057b8', total: 10, running: 9 },
      { account_id: '210987654321', account_name: 'staging',   environment: 'staging', color: '#26a69a', total: 4,  running: 3 },
    ],
    by_region: [
      { region: 'us-east-1', total: 10, running: 9 },
      { region: 'us-west-2', total: 4,  running: 3 },
    ],
    regions_scanned: ['us-east-1', 'us-west-2'],
    collected_at: NOW,
  };

  /* ── EKS ── */
  MOCK.metrics.eks = {
    cluster_utilization: {
      cpu_requested_cores: 5.4, cpu_allocatable_cores: 10.0, cpu_requested_pct: 54,
      mem_requested_mi: 9830,   mem_allocatable_mi: 16384,  mem_requested_pct: 60,
      cpu_actual_cores: 4.1, cpu_actual_pct: 41, mem_actual_mi: 8192, mem_actual_pct: 50,
    },
    storage: { total_pvc: 8, bound: 8, pending: 0, lost: 0, total_gib: 420 },
    nodes: [
      { name: 'ip-10-0-1-100.ec2.internal', instance_type: 'm5.xlarge', zone: 'us-east-1a',
        status: 'ready', any_pressure: false,
        memory_pressure: false, disk_pressure: false, pid_pressure: false,
        cpu_pct: 52, mem_pct: 65, allocatable_cpu: 4, allocatable_mem_mi: 15360,
        actual_cpu_cores: 2.1, actual_mem_mi: 9984 },
      { name: 'ip-10-0-2-100.ec2.internal', instance_type: 'm5.xlarge', zone: 'us-east-1b',
        status: 'ready', any_pressure: false,
        memory_pressure: false, disk_pressure: false, pid_pressure: false,
        cpu_pct: 56, mem_pct: 55, allocatable_cpu: 4, allocatable_mem_mi: 15360,
        actual_cpu_cores: 2.0, actual_mem_mi: 7168 },
    ],
    total_nodes: 2, ready_nodes: 2, nodes_under_pressure: 0,
    total_pods: 25, running_pods: 22, pending_pods: 2, failed_pods: 1, succeeded_pods: 0,
    oom_killed_pods: 0, pending_insufficient_resource_pods: 0,
    namespaces: {
      'default':      { running: 5, pending: 0, failed: 0, oom_count: 0, cpu_requested: 1.2, mem_requested_mi: 2048, pods: [] },
      'monitoring':   { running: 8, pending: 0, failed: 0, oom_count: 0, cpu_requested: 2.1, mem_requested_mi: 3584, pods: [] },
      'ingress-nginx':{ running: 3, pending: 0, failed: 0, oom_count: 0, cpu_requested: 0.6, mem_requested_mi: 768,  pods: [] },
      'kube-system':  { running: 6, pending: 2, failed: 1, oom_count: 0, cpu_requested: 1.5, mem_requested_mi: 2048, pods: [] },
    },
    pods: [],
    resource_issues: [],
    total_resource_issues: 0, critical_issues: 0, warning_issues: 0, pvc_near_full: 0,
    server_version: 'v1.30.4',
    collected_at: NOW,
  };

  /* ── Uptime ── */
  function mkSvc(name, url, status, latency, uptime30d, sslDays, group) {
    const sparkline = Array.from({ length: 30 }, (_, i) =>
      ({ status: i < 29 ? 'up' : status, latency_ms: latency + (Math.random() - 0.5) * 40 })
    );
    return {
      service: name, url, type: url.startsWith('tcp') ? 'tcp' : 'http',
      status, latency_ms: status === 'up' ? latency : null,
      uptime_30d: uptime30d,
      ssl: url.startsWith('https') ? { days_remaining: sslDays, valid: true, status: sslDays >= 30 ? 'ok' : 'warning' } : { status: 'http_only' },
      sparkline, history_daily: [], history_monthly: [], history_quarterly: [],
      incidents: status === 'down' ? [{ start: new Date(Date.now() - 3600000).toISOString(), end: null }] : [],
      in_maintenance: false, group,
    };
  }

  const uptimeServices = [
    mkSvc('API Gateway',      'https://api.example.com',       'up',   142, 99.98, 85,  ''),
    mkSvc('Web Application',  'https://app.example.com',       'up',    98, 99.95, 112, ''),
    mkSvc('Auth Service',     'https://auth.example.com',      'up',    87, 99.99, 76,  ''),
    mkSvc('Database Proxy',   'tcp://db.example.com:5432',     'up',    12, 100.0, null,''),
    mkSvc('Metrics Server',   'https://metrics.example.com',   'up',   234, 99.87, 91,  ''),
    mkSvc('Admin Portal',     'https://admin.example.com',     'up',   156, 99.92, 103, ''),
    mkSvc('File Storage',     'https://files.example.com',     'down', null,98.45, 67,  ''),
    mkSvc('CDN Edge',         'https://cdn.example.com',       'up',    23, 99.99, 118, ''),
    mkSvc('Webhook Service',  'https://hooks.example.com',     'up',    89, 99.76, 55,  ''),
    mkSvc('Monitoring Stack', 'https://monitoring.example.com','up',   178, 99.94, 44,  ''),
  ];

  MOCK.metrics.uptime = {
    services: uptimeServices,
    up: 9, down: 1, maintenance: 0, ssl_expiring: 0,
    total: uptimeServices.length, source: 'uptime_kuma',
    quarterly_by_region: { groups: {}, quarters: [] },
  };

  /* ── Costs ── */
  const daysIn    = 12;
  const daysTotal = 30;
  const mtd       = 3218.45;
  const dailyAvg  = Math.round(mtd / daysIn * 100) / 100;
  const lastMonth = 7841.33;
  const lastMoDaily = Math.round(lastMonth / 31 * 100) / 100;

  const byService = [
    { service: 'Amazon EC2',         amount: 1342.56, pct: 41.7 },
    { service: 'Amazon EKS',         amount: 523.78,  pct: 16.3 },
    { service: 'Amazon RDS',         amount: 412.33,  pct: 12.8 },
    { service: 'Amazon S3',          amount: 142.89,  pct: 4.4  },
    { service: 'AWS CloudWatch',     amount: 98.45,   pct: 3.1  },
    { service: 'Amazon CloudFront',  amount: 67.23,   pct: 2.1  },
    { service: 'AWS WAF',            amount: 45.12,   pct: 1.4  },
    { service: 'Amazon Route 53',    amount: 23.45,   pct: 0.7  },
    { service: 'Other',              amount: 562.64,  pct: 17.5 },
  ];

  const monthlyAmounts = [7124.22,6891.45,7234.56,6982.33,7456.78,7891.23,8123.45,7634.21,8023.67,7789.34,7912.44,7841.33];
  const monthLabels    = ['Nov 2025','Dec 2025','Jan 2026','Feb 2026','Mar 2026','Apr 2026','May 2026','Jun 2026','Jul 2026','Aug 2026','Sep 2026','Oct 2026'];
  const monthKeys      = ['2025-11-01','2025-12-01','2026-01-01','2026-02-01','2026-03-01','2026-04-01','2026-05-01','2026-06-01','2026-07-01','2026-08-01','2026-09-01','2026-10-01'];
  const monthlyHistory = monthKeys.map((m, i) => ({
    month: m, label: monthLabels[i], amount: monthlyAmounts[i], estimated: false,
  }));
  monthlyHistory.push({ month: '2026-11-01', label: 'Nov 2026', amount: mtd, estimated: true });

  // 30-day daily trend (Oct 13 → Nov 12)
  const dailyTrend = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.now() - (29 - i) * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    return { date: dateStr, amount: Math.round((240 + (Math.random() - 0.4) * 60) * 100) / 100 };
  });

  MOCK.metrics.cost = {
    mtd, ytd: 78432.18, forecast: Math.round(dailyAvg * daysTotal * 100) / 100,
    last_month: lastMonth, last_month_daily: lastMoDaily,
    mom_change: Math.round((dailyAvg - lastMoDaily) * 100) / 100,
    mom_change_pct: Math.round((dailyAvg - lastMoDaily) / lastMoDaily * 100 * 10) / 10,
    daily_avg: dailyAvg, days_in_month: daysIn, days_total: daysTotal,
    by_service: byService,
    by_service_ytd: byService.map(s => ({ ...s, amount: Math.round(s.amount * 10.4 * 100) / 100 })),
    by_account: [
      { account_id: '123456789012', amount: 2654.32 },
      { account_id: '210987654321', amount: 564.13  },
    ],
    daily_trend: dailyTrend, monthly_history: monthlyHistory,
    by_resource: {}, resource_names: {}, by_instance: [], by_application: [],
    cost_drivers: [], forecast_12m: [],
    top_service: byService[0], monthly_budget: 9000, currency: 'USD',
    collected_at: NOW,
  };

  /* ── Storage ── */
  function mkVol(id, name, acct, acctName, env, color, type, sizeGib, state, attachedTo, az) {
    return {
      id, name, account_id: acct, account_name: acctName, environment: env, env_color: color,
      type, size_gib: sizeGib, state, encrypted: true,
      attached_to: attachedTo, instance_name: attachedTo ? attachedTo.split('-').slice(0,3).join('-') : null,
      az, region: az.slice(0, -1), snapshots: [],
    };
  }

  const volumes = [
    mkVol('vol-001','prod-web-01-root',  '123456789012','prod-east','prod','#0057b8','gp3',30,'in-use','i-0a1b2c3d4e5f0001','us-east-1a'),
    mkVol('vol-002','prod-web-02-root',  '123456789012','prod-east','prod','#0057b8','gp3',30,'in-use','i-0a1b2c3d4e5f0002','us-east-1b'),
    mkVol('vol-003','prod-api-01-root',  '123456789012','prod-east','prod','#0057b8','gp3',50,'in-use','i-0a1b2c3d4e5f0003','us-east-1a'),
    mkVol('vol-004','prod-api-02-root',  '123456789012','prod-east','prod','#0057b8','gp3',50,'in-use','i-0a1b2c3d4e5f0004','us-east-1b'),
    mkVol('vol-005','prod-api-03-root',  '123456789012','prod-east','prod','#0057b8','gp3',50,'in-use','i-0a1b2c3d4e5f0005','us-east-1c'),
    mkVol('vol-006','prod-worker-data',  '123456789012','prod-east','prod','#0057b8','gp3',100,'in-use','i-0a1b2c3d4e5f0006','us-east-1a'),
    mkVol('vol-007','prod-eks-01-root',  '123456789012','prod-east','prod','#0057b8','gp3',100,'in-use','i-0a1b2c3d4e5f0007','us-east-1a'),
    mkVol('vol-008','prod-eks-02-root',  '123456789012','prod-east','prod','#0057b8','gp3',100,'in-use','i-0a1b2c3d4e5f0008','us-east-1b'),
    mkVol('vol-009','prod-db-data',      '123456789012','prod-east','prod','#0057b8','io1',500,'in-use','i-0a1b2c3d4e5f0009','us-east-1b'),
    mkVol('vol-010','prod-db-logs',      '123456789012','prod-east','prod','#0057b8','gp3',100,'in-use','i-0a1b2c3d4e5f0009','us-east-1b'),
    mkVol('vol-011','stale-snapshot-vol','123456789012','prod-east','prod','#0057b8','gp3',50,'available',null,'us-east-1a'),
    mkVol('vol-012','old-data-backup',   '123456789012','prod-east','prod','#0057b8','gp3',200,'available',null,'us-east-1c'),
    mkVol('vol-013','stg-api-01-root',   '210987654321','staging','staging','#26a69a','gp3',30,'in-use','i-0b2c3d4e5f600011','us-west-2a'),
    mkVol('vol-014','stg-api-02-root',   '210987654321','staging','staging','#26a69a','gp3',30,'in-use','i-0b2c3d4e5f600012','us-west-2b'),
    mkVol('vol-015','stg-dev-snapshot',  '210987654321','staging','staging','#26a69a','gp3',30,'available',null,'us-west-2a'),
  ];

  const buckets = [
    { name:'prod-app-assets',    account_id:'123456789012', account_name:'prod-east', environment:'prod', env_color:'#0057b8', region:'us-east-1', size_gib:142.3, object_count:48234, versioning:'Enabled', encryption:'AES256', public_block:true, is_public:false },
    { name:'prod-logs-archive',  account_id:'123456789012', account_name:'prod-east', environment:'prod', env_color:'#0057b8', region:'us-east-1', size_gib:89.7,  object_count:1024782, versioning:'Suspended', encryption:'AES256', public_block:true, is_public:false },
    { name:'prod-backups',       account_id:'123456789012', account_name:'prod-east', environment:'prod', env_color:'#0057b8', region:'us-east-1', size_gib:234.5, object_count:3421, versioning:'Enabled', encryption:'aws:kms', public_block:true, is_public:false },
    { name:'prod-terraform-state',account_id:'123456789012',account_name:'prod-east', environment:'prod', env_color:'#0057b8', region:'us-east-1', size_gib:0.1,  object_count:47, versioning:'Enabled', encryption:'aws:kms', public_block:true, is_public:false },
    { name:'prod-cost-reports',  account_id:'123456789012', account_name:'prod-east', environment:'prod', env_color:'#0057b8', region:'us-east-1', size_gib:12.4, object_count:842, versioning:'Suspended', encryption:'AES256', public_block:true, is_public:false },
    { name:'staging-app-data',   account_id:'210987654321', account_name:'staging',   environment:'staging', env_color:'#26a69a', region:'us-west-2', size_gib:23.1, object_count:9823, versioning:'Enabled', encryption:'AES256', public_block:true, is_public:false },
    { name:'staging-logs',       account_id:'210987654321', account_name:'staging',   environment:'staging', env_color:'#26a69a', region:'us-west-2', size_gib:8.3,  object_count:234512, versioning:'Suspended', encryption:'AES256', public_block:true, is_public:false },
    { name:'public-assets',      account_id:'123456789012', account_name:'prod-east', environment:'prod', env_color:'#0057b8', region:'us-east-1', size_gib:4.7,  object_count:1247, versioning:'Suspended', encryption:'AES256', public_block:false, is_public:true },
  ];

  MOCK.metrics.storage = {
    ebs: {
      volumes, total: volumes.length,
      in_use: volumes.filter(v => v.state === 'in-use').length,
      unattached: volumes.filter(v => v.state === 'available').length,
      unencrypted: 0,
      total_gib: volumes.reduce((s,v) => s + v.size_gib, 0),
      unattached_gib: volumes.filter(v => v.state === 'available').reduce((s,v) => s + v.size_gib, 0),
      total_snapshots: 12, vols_with_snaps: 8, vols_no_snaps: 2,
      orphaned_snapshots: [], orphaned_gib: 0,
    },
    s3: {
      buckets, total: buckets.length,
      public_count: buckets.filter(b => b.is_public).length,
      total_gib: Math.round(buckets.reduce((s,b) => s + b.size_gib, 0) * 10) / 10,
    },
    collected_at: NOW,
  };

  /* ── IAM ── */
  function mkUser(username, acctId, acctName, env, color, mfa, adminAccess, keyAge, lastLogin, risk) {
    const hasKey = keyAge !== null;
    const stale  = hasKey && keyAge > 90;
    return {
      username, account_id: acctId, account_name: acctName, environment: env, color,
      mfa_active: mfa, is_admin: adminAccess, is_root: false,
      pwd_last_used: lastLogin,
      access_keys: hasKey ? [{
        key_id: 'AKIA' + Math.random().toString(36).slice(2,18).toUpperCase(),
        status: 'Active', age_days: keyAge, stale,
        last_used_date: stale ? new Date(Date.now() - keyAge * 86400000).toISOString().slice(0,10) : new Date(Date.now() - 3 * 86400000).toISOString().slice(0,10),
        last_used_days: stale ? keyAge : 3,
      }] : [],
      flags: [
        ...(!mfa ? ['no_mfa'] : []),
        ...(stale ? ['stale_key'] : []),
      ],
      risk_level: risk,
    };
  }

  const allUsers = [
    mkUser('deploy-bot',   '123456789012','prod-east','prod','#0057b8', true, false, 14, '2026-11-12', 'ok'),
    mkUser('s.roy',        '123456789012','prod-east','prod','#0057b8', true, true,  7,  '2026-11-12', 'ok'),
    mkUser('ci-runner',    '123456789012','prod-east','prod','#0057b8', true, false, 32, '2026-11-10', 'ok'),
    mkUser('backup-agent', '123456789012','prod-east','prod','#0057b8', true, false, 45, '2026-11-08', 'ok'),
    mkUser('old-dev-key',  '123456789012','prod-east','prod','#0057b8', true, false, 127,'2026-10-01', 'warning'),
    mkUser('legacy-svc',   '123456789012','prod-east','prod','#0057b8', false,false, 95, '2026-09-14', 'critical'),
    mkUser('stg-deploy',   '210987654321','staging','staging','#26a69a', true, false, 21, '2026-11-11', 'ok'),
    mkUser('stg-dev',      '210987654321','staging','staging','#26a69a', true, false, 8,  '2026-11-12', 'ok'),
  ];

  MOCK.metrics.iam = {
    accounts: [
      { account_id:'123456789012', account_name:'prod-east', environment:'prod', color:'#0057b8', cloudtrail_active:true, users:allUsers.slice(0,6), summary:{total:6,no_mfa:1,stale_keys:1,old_keys:1,admins:1,critical:1} },
      { account_id:'210987654321', account_name:'staging',   environment:'staging', color:'#26a69a', cloudtrail_active:true, users:allUsers.slice(6),  summary:{total:2,no_mfa:0,stale_keys:0,old_keys:0,admins:0,critical:0} },
    ],
    all_users: allUsers,
    cloudtrail_active: true,
    totals: { users: allUsers.length, no_mfa: 1, stale_keys: 1, admins: 1, critical: 1 },
    collected_at: NOW,
  };

  /* ── Security ── */
  MOCK.metrics.guardduty = {
    security_score: 71,
    total: 7, high: 2, medium: 3, low: 2,
    findings: [
      {
        title:         'SSH Brute Force Attack on EC2 Instance',
        type:          'UnauthorizedAccess:EC2/SSHBruteForce',
        resource_type: 'EC2 Instance',
        resource_id:   'i-0a1b2c3d4e5f67890',
        severity:      8.2,
        severity_label:'HIGH',
        severity_css:  'crit',
      },
      {
        title:         'Cryptocurrency Mining Activity Detected',
        type:          'CryptoCurrency:EC2/BitcoinTool.B',
        resource_type: 'EC2 Instance',
        resource_id:   'i-0f9e8d7c6b5a43210',
        severity:      7.5,
        severity_label:'HIGH',
        severity_css:  'crit',
      },
      {
        title:         'Unusual Console Login from Anomalous Location',
        type:          'UnauthorizedAccess:IAMUser/ConsoleLogin',
        resource_type: 'IAM User',
        resource_id:   'legacy-svc-account',
        severity:      6.1,
        severity_label:'MEDIUM',
        severity_css:  'warn',
      },
      {
        title:         'Port Probe on Unprotected EC2 Instance',
        type:          'Recon:EC2/PortProbeUnprotectedPort',
        resource_type: 'EC2 Instance',
        resource_id:   'i-0b2c3d4e5f6a78901',
        severity:      5.0,
        severity_label:'MEDIUM',
        severity_css:  'warn',
      },
      {
        title:         'S3 Bucket Made Publicly Accessible',
        type:          'Policy:S3/BucketPublicAccessGranted',
        resource_type: 'S3 Bucket',
        resource_id:   'stg-assets-public',
        severity:      4.4,
        severity_label:'MEDIUM',
        severity_css:  'warn',
      },
      {
        title:         'API Calls from Known Malicious IP',
        type:          'Recon:IAMUser/MaliciousIPCaller.Custom',
        resource_type: 'IAM User',
        resource_id:   'ci-runner',
        severity:      2.8,
        severity_label:'LOW',
        severity_css:  'ok',
      },
      {
        title:         'Unencrypted Data Transfer Detected',
        type:          'Policy:EC2/NoPasswordPolicy',
        resource_type: 'EC2 Instance',
        resource_id:   'i-0c3d4e5f6a7b89012',
        severity:      1.9,
        severity_label:'LOW',
        severity_css:  'ok',
      },
    ],
  };

  MOCK.metrics.security = {
    security_groups: [
      { group_id:'sg-0123456789abcdef0', group_name:'prod-web-sg',    vpc_id:'vpc-prod001', account_id:'123456789012', account_name:'prod-east', region:'us-east-1',
        risky_rules:[{ protocol:'tcp', port:22, cidr:'0.0.0.0/0', description:'SSH open to world' }] },
    ],
    vpcs_without_flowlogs: [
      { vpc_id:'vpc-stg001', account_id:'210987654321', account_name:'staging', region:'us-west-2', cidr:'10.1.0.0/16' },
    ],
    s3_public_count: 1,
    mfa_enabled: true, cloudtrail_active: true, encryption_enabled: true, flow_logs_enabled: false,
    score: 78,
    collected_at: NOW,
  };

  /* ── ALB ── */
  MOCK.metrics.alb = {
    healthy: 2, degraded: 1, critical: 0,
    summary: { total_requests_5min: 24830, overall_error_rate: 0.4 },
    total: 3,
    load_balancers: [
      {
        name: 'app/prod-web-alb/a1b2c3d4e5f60001',
        friendly_name: 'prod-web-alb',
        status: 'healthy',
        metrics: { requests_per_min: 1247, error_rate_pct: 0.2, '5xx_count': 3, p50_latency_ms: 94, p99_latency_ms: 342 },
        targets: { healthy: 4, unhealthy: 0 },
      },
      {
        name: 'app/prod-api-alb/b2c3d4e5f6700002',
        friendly_name: 'prod-api-alb',
        status: 'healthy',
        metrics: { requests_per_min: 3614, error_rate_pct: 0.3, '5xx_count': 11, p50_latency_ms: 128, p99_latency_ms: 587 },
        targets: { healthy: 6, unhealthy: 0 },
      },
      {
        name: 'app/staging-alb/c3d4e5f678900003',
        friendly_name: 'staging-alb',
        status: 'degraded',
        metrics: { requests_per_min: 243, error_rate_pct: 1.8, '5xx_count': 5, p50_latency_ms: 213, p99_latency_ms: 1247 },
        targets: { healthy: 3, unhealthy: 1 },
      },
    ],
  };

  /* ── EC2 Network ── */
  MOCK.metrics.ec2_network = {
    summary: { total_out_mb: 2847.3, total_in_mb: 1234.5 },
    instances: [
      { name:'prod-web-01',      id:'i-0a1b2c3d4e5f0001', type:'t3.medium',  network:{ in_mb:182.4, out_mb:341.2, in_mbps:0.5, out_mbps:0.9, packets_in:234891, packets_out:189234, outbound_alert:false } },
      { name:'prod-web-02',      id:'i-0a1b2c3d4e5f0002', type:'t3.medium',  network:{ in_mb:176.1, out_mb:328.7, in_mbps:0.5, out_mbps:0.9, packets_in:228412, packets_out:184231, outbound_alert:false } },
      { name:'prod-api-01',      id:'i-0a1b2c3d4e5f0003', type:'t3.large',   network:{ in_mb:412.8, out_mb:623.4, in_mbps:1.1, out_mbps:1.7, packets_in:487231, packets_out:412841, outbound_alert:false } },
      { name:'prod-api-02',      id:'i-0a1b2c3d4e5f0004', type:'t3.large',   network:{ in_mb:398.3, out_mb:589.1, in_mbps:1.1, out_mbps:1.6, packets_in:471823, packets_out:398421, outbound_alert:false } },
      { name:'prod-api-03',      id:'i-0a1b2c3d4e5f0005', type:'t3.large',   network:{ in_mb:378.9, out_mb:571.2, in_mbps:1.0, out_mbps:1.6, packets_in:461234, packets_out:389120, outbound_alert:false } },
      { name:'prod-worker-01',   id:'i-0a1b2c3d4e5f0006', type:'t3.medium',  network:{ in_mb:89.3,  out_mb:924.8, in_mbps:0.2, out_mbps:2.6, packets_in:98421,  packets_out:921834, outbound_alert:true  } },
      { name:'prod-eks-node-01', id:'i-0a1b2c3d4e5f0007', type:'m5.xlarge',  network:{ in_mb:734.2, out_mb:891.3, in_mbps:2.0, out_mbps:2.5, packets_in:812341, packets_out:734821, outbound_alert:false } },
      { name:'prod-eks-node-02', id:'i-0a1b2c3d4e5f0008', type:'m5.xlarge',  network:{ in_mb:712.8, out_mb:854.1, in_mbps:2.0, out_mbps:2.4, packets_in:798234, packets_out:712341, outbound_alert:false } },
      { name:'prod-db-replica',  id:'i-0a1b2c3d4e5f0009', type:'r5.large',   network:{ in_mb:234.7, out_mb:198.4, in_mbps:0.7, out_mbps:0.6, packets_in:312841, packets_out:289234, outbound_alert:false } },
      { name:'stg-api-01',       id:'i-0b2c3d4e5f600011', type:'t3.small',   network:{ in_mb:67.2,  out_mb:89.4,  in_mbps:0.2, out_mbps:0.2, packets_in:78234,  packets_out:67821,  outbound_alert:false } },
      { name:'stg-api-02',       id:'i-0b2c3d4e5f600012', type:'t3.small',   network:{ in_mb:72.1,  out_mb:94.3,  in_mbps:0.2, out_mbps:0.3, packets_in:82341,  packets_out:71234,  outbound_alert:false } },
      { name:'stg-worker-01',    id:'i-0b2c3d4e5f600013', type:'t3.small',   network:{ in_mb:34.8,  out_mb:189.7, in_mbps:0.1, out_mbps:0.5, packets_in:42341,  packets_out:198234, outbound_alert:false } },
    ],
  };

  MOCK.metrics.telemetry = null;
  MOCK.metrics.ngsa_fhir = {};

  /* ── Container Health ── */
  MOCK.container_health = {
    configured: true,
    hosts: [
      {
        host: 'prod-web-01 (10.0.1.11)',
        containers: [
          { name:'nginx',          image:'nginx:1.25-alpine',               state:'running', exit_code:null, cpu_pct:1.2,  mem_mb:24.3,  mem_pct:0.3, status:'Up 14 days' },
          { name:'app',            image:'ghcr.io/cloudcmd/app:v2.4.1',     state:'running', exit_code:null, cpu_pct:18.4, mem_mb:312.5, mem_pct:3.8, status:'Up 14 days' },
          { name:'redis-sentinel', image:'redis:7-alpine',                   state:'running', exit_code:null, cpu_pct:0.4,  mem_mb:12.1,  mem_pct:0.1, status:'Up 14 days' },
          { name:'log-forwarder',  image:'grafana/promtail:2.9.3',           state:'running', exit_code:null, cpu_pct:0.8,  mem_mb:48.2,  mem_pct:0.6, status:'Up 14 days' },
        ],
      },
      {
        host: 'prod-worker-01 (10.0.1.16)',
        containers: [
          { name:'celery-worker',  image:'ghcr.io/cloudcmd/app:v2.4.1',     state:'running', exit_code:null, cpu_pct:67.3, mem_mb:489.1, mem_pct:6.0, status:'Up 14 days' },
          { name:'celery-beat',    image:'ghcr.io/cloudcmd/app:v2.4.1',     state:'running', exit_code:null, cpu_pct:2.1,  mem_mb:187.3, mem_pct:2.3, status:'Up 14 days' },
          { name:'flower',         image:'mher/flower:2.0.1',               state:'running', exit_code:null, cpu_pct:0.3,  mem_mb:62.4,  mem_pct:0.8, status:'Up 8 days' },
          { name:'log-forwarder',  image:'grafana/promtail:2.9.3',           state:'running', exit_code:null, cpu_pct:0.9,  mem_mb:51.2,  mem_pct:0.6, status:'Up 14 days' },
        ],
      },
      {
        host: 'stg-api-01 (10.1.0.11)',
        containers: [
          { name:'api',            image:'ghcr.io/cloudcmd/app:v2.4.0',     state:'running', exit_code:null,  cpu_pct:28.4, mem_mb:234.1, mem_pct:5.8, status:'Up 3 days' },
          { name:'postgres-proxy', image:'pgbouncer/pgbouncer:1.21.0',      state:'exited',  exit_code:1,     cpu_pct:null, mem_mb:null,  mem_pct:null, status:'Exited (1) 2 hours ago' },
          { name:'log-forwarder',  image:'grafana/promtail:2.9.3',           state:'running', exit_code:null,  cpu_pct:0.6,  mem_mb:42.3,  mem_pct:1.0, status:'Up 3 days' },
        ],
      },
    ],
  };

  /* ── Instance Control (staging/dev instances) ── */
  MOCK.instances = [
    { id:'i-0b2c3d4e5f600011', name:'stg-api-01',    type:'t3.small', state:'running', environment:'staging', account_name:'staging', region:'us-west-2', last_action:{ action:'start', user:'s.roy',     ts:'2026-11-10T08:14:22Z' } },
    { id:'i-0b2c3d4e5f600012', name:'stg-api-02',    type:'t3.small', state:'running', environment:'staging', account_name:'staging', region:'us-west-2', last_action:{ action:'start', user:'ci-runner', ts:'2026-11-10T08:14:48Z' } },
    { id:'i-0b2c3d4e5f600013', name:'stg-worker-01', type:'t3.small', state:'running', environment:'staging', account_name:'staging', region:'us-west-2', last_action:null },
    { id:'i-0b2c3d4e5f600014', name:'stg-dev-01',    type:'t3.micro', state:'stopped', environment:'staging', account_name:'staging', region:'us-west-2', last_action:{ action:'stop',  user:'s.roy',     ts:'2026-11-11T18:30:05Z' } },
  ];

  /* ── Incidents ── */
  const _openIncidents = [
    {
      id: 1, status: 'open',
      first_seen: new Date(Date.now() - 2 * 3600000).toISOString(),
      source: 'eks-pods', namespace: 'kube-system', pod: 'coredns-7d6b4b5c9f-xt9zq',
      message: 'CrashLoopBackOff: coredns-7d6b4b5c9f-xt9zq — Exit code 2 (config parse error)',
      full_log: 'Error: failed to load Corefile: unknown directive "erros" on line 7\nparsing failed: unknown directive',
    },
    {
      id: 2, status: 'open',
      first_seen: new Date(Date.now() - 45 * 60000).toISOString(),
      source: 'uptime-kuma', namespace: null, pod: null,
      message: 'File Storage DOWN — https://files.example.com timed out after 30s',
      full_log: 'GET https://files.example.com/health → connection timeout (30000ms)\nRetries: 3/3 failed. Service marked DOWN.',
    },
  ];
  const _resolvedIncidents = [
    {
      id: 3, status: 'resolved',
      first_seen: new Date(Date.now() - 2 * 86400000).toISOString(),
      resolved_at: new Date(Date.now() - 2 * 86400000 + 1200000).toISOString(),
      source: 'cloudtrail', namespace: null, pod: null,
      message: 'IAM key rotation violation: legacy-svc access key age exceeded 90 days (127 days)',
      resolved_by: 's.roy', resolution_note: 'Key rotated and new secret stored in AWS Secrets Manager.',
    },
    {
      id: 4, status: 'resolved',
      first_seen: new Date(Date.now() - 4 * 86400000).toISOString(),
      resolved_at: new Date(Date.now() - 4 * 86400000 + 3600000).toISOString(),
      source: 'eks-pods', namespace: 'default', pod: 'api-deploy-6c8f9d-k4jpv',
      message: 'OOMKilled: api-deploy-6c8f9d-k4jpv — memory limit exceeded (512Mi)',
      resolved_by: 'ci-runner', resolution_note: 'Memory limit increased to 1Gi in Helm values and deployed.',
    },
    {
      id: 5, status: 'resolved',
      first_seen: new Date(Date.now() - 7 * 86400000).toISOString(),
      resolved_at: new Date(Date.now() - 7 * 86400000 + 7200000).toISOString(),
      source: 'uptime-kuma', namespace: null, pod: null,
      message: 'Auth Service elevated latency — p99 > 2000ms for 15 minutes',
      resolved_by: 's.roy', resolution_note: 'Traced to Redis connection pool exhaustion; pool size increased to 50.',
    },
  ];
  MOCK.incidents_open = _openIncidents;
  MOCK.incidents_all  = [..._openIncidents, ..._resolvedIncidents];

  /* ── Sync status (for App Performance section) ── */
  MOCK.sync_status = { configured: false, regions: [] };

  /* ── Log samples ── */
  const _logEntries = [
    { sev:'info',     job:'eks-pods',    ns:'default',           pod:'api-deploy-6c8f9d-k9xm2',              line:'GET /api/v2/users 200 OK [42ms] — 847 results returned' },
    { sev:'info',     job:'syslog',      ns:'monitoring',        pod:'prometheus-0',                         line:'Scrape completed: 1,247 metrics ingested from 14 targets in 234ms' },
    { sev:'critical', job:'eks-pods',    ns:'kube-system',       pod:'coredns-7d6b4b5c9f-xt9zq',            line:'failed to load Corefile: unknown directive "erros" on line 7 — CrashLoopBackOff' },
    { sev:'info',     job:'cloudtrail',  ns:'aws',               pod:'iam-service',                          line:'s.roy assumed role arn:aws:iam::123456789012:role/AdminRole from 196.218.x.x' },
    { sev:'info',     job:'eks-pods',    ns:'ingress-nginx',     pod:'ingress-nginx-controller-5f8b8d4c6-zqp7n', line:'Configuration reloaded — 12 Ingress rules active' },
    { sev:'warning',  job:'syslog',      ns:'default',           pod:'prod-worker-01',                       line:'celery-worker memory usage at 78% (489 MB / 629 MB) — approaching limit' },
    { sev:'info',     job:'auth',        ns:'default',           pod:'auth-service',                         line:'User s.roy authenticated via SSO (Google) — session granted for 8h' },
    { sev:'info',     job:'eks-pods',    ns:'default',           pod:'api-deploy-6c8f9d-k9xm2',              line:'Liveness probe OK: /health returned 200 in 3ms' },
    { sev:'info',     job:'cloudtrail',  ns:'aws',               pod:'s3-service',                           line:'S3 PutObject: prod-backups — daily snapshot uploaded (2.3 GB) by backup-agent' },
    { sev:'info',     job:'syslog',      ns:'monitoring',        pod:'loki-0',                               line:'Log retention policy applied: 847,231 entries older than 30d compacted to object storage' },
    { sev:'critical', job:'eks-pods',    ns:'default',           pod:'stg-postgres-proxy-7f6b',              line:'pgbouncer connection pool exhausted — max_client_conn=20 reached (exit 1)' },
    { sev:'info',     job:'cloudtrail',  ns:'aws',               pod:'ec2-service',                          line:'EC2 DescribeInstances called by ci-runner from us-east-1 — 14 instances returned' },
    { sev:'info',     job:'syslog',      ns:'default',           pod:'prod-web-01',                          line:'TLS certificate renewed for api.prod.internal — expires in 85 days' },
    { sev:'warning',  job:'cloudtrail',  ns:'aws',               pod:'iam-service',                          line:'IAM key age threshold exceeded for legacy-svc (127 days since last rotation)' },
    { sev:'info',     job:'eks-pods',    ns:'monitoring',        pod:'grafana-7d4b9c8f6-p2qkj',              line:'Dashboard "Infrastructure Overview" viewed by s.roy — 847 panel queries executed' },
    { sev:'info',     job:'syslog',      ns:'default',           pod:'prod-db-replica',                      line:'PostgreSQL streaming replication lag: 0.3s — WAL receiver connected to primary' },
    { sev:'info',     job:'auth',        ns:'default',           pod:'auth-service',                         line:'API key ci-runner rotated successfully — new key stored in Secrets Manager' },
    { sev:'info',     job:'eks-pods',    ns:'kube-system',       pod:'aws-node-tx9qz',                       line:'VPC CNI plugin: assigned 3 secondary IPs to node ip-10-0-1-100.ec2.internal' },
    { sev:'warning',  job:'syslog',      ns:'default',           pod:'prod-api-01',                          line:'upstream response time exceeded threshold — p99 latency 1,247ms (target: 500ms)' },
    { sev:'info',     job:'cloudtrail',  ns:'aws',               pod:'cloudwatch',                           line:'CloudWatch alarm OK: prod-worker-01 CPUUtilization returned below 80% (now 67%)' },
    { sev:'info',     job:'eks-pods',    ns:'default',           pod:'api-deploy-6c8f9d-pq7x1',              line:'Deployment rollout complete: api-deploy updated to v2.4.1 (3/3 replicas ready)' },
    { sev:'info',     job:'syslog',      ns:'monitoring',        pod:'alertmanager-0',                       line:'Alert resolved: FilesServiceDown — service restored after 47 minutes' },
    { sev:'info',     job:'cloudtrail',  ns:'aws',               pod:'cost-explorer',                        line:'Cost Anomaly Detection: EC2 spend within normal range ($268/day, budget $300/day)' },
    { sev:'critical', job:'syslog',      ns:'default',           pod:'stg-api-01',                           line:'upstream connect timeout: postgres-proxy connection refused (port 5432)' },
    { sev:'info',     job:'auth',        ns:'default',           pod:'auth-service',                         line:'Admin panel: s.roy approved access request for stg-dev (read-only, 7-day expiry)' },
    { sev:'warning',  job:'eks-pods',    ns:'ingress-nginx',     pod:'ingress-nginx-controller-5f8b8d4c6-zqp7n', line:'Rate limit triggered: 429 returned to 54.203.x.x — 1,000 req/min exceeded' },
    { sev:'info',     job:'syslog',      ns:'default',           pod:'prod-eks-node-01',                     line:'Node heartbeat OK — kubelet reporting healthy, 25 pods scheduled, 0 evictions' },
    { sev:'warning',  job:'cloudtrail',  ns:'aws',               pod:'s3-service',                           line:'S3 bucket public-assets has public read ACL — review recommended' },
    { sev:'info',     job:'eks-pods',    ns:'default',           pod:'api-deploy-6c8f9d-k9xm2',              line:'POST /api/v2/reports 202 Accepted — async job queued (job_id: rpt-2847)' },
    { sev:'info',     job:'syslog',      ns:'monitoring',        pod:'prometheus-0',                         line:'TSDB compaction complete: 2.3M series retained, 847K expired entries removed' },
    { sev:'info',     job:'eks-pods',    ns:'default',           pod:'worker-deploy-8b7c4f-mnp3r',            line:'Celery task completed: generate_report [SUCCESS] runtime=4.2s, retries=0' },
    { sev:'warning',  job:'syslog',      ns:'default',           pod:'prod-db-primary',                      line:'Checkpoint taking longer than expected: 18.4s (threshold 10s) — consider tuning checkpoint_completion_target' },
    { sev:'info',     job:'cloudtrail',  ns:'aws',               pod:'iam-service',                          line:'MFA challenge passed: s.roy — console login granted (us-east-1)' },
    { sev:'info',     job:'eks-pods',    ns:'default',           pod:'api-deploy-6c8f9d-k9xm2',              line:'Cache hit rate: 94.2% — Redis latency p50=0.8ms, p99=3.1ms' },
    { sev:'info',     job:'syslog',      ns:'kube-system',       pod:'cluster-autoscaler-6d9b5-wq4rt',       line:'Scale-up: adding node to group prod-workers (pending pods: 3, current: 5, target: 6)' },
    { sev:'critical', job:'eks-pods',    ns:'default',           pod:'payments-svc-5c8d9f-bk2lt',            line:'Stripe webhook delivery failed — 503 from upstream after 3 retries (order_id: ord-9182)' },
    { sev:'info',     job:'cloudtrail',  ns:'aws',               pod:'rds-service',                          line:'RDS automated backup completed: prod-postgres-db — snapshot rds:prod-2024-11-12 (42 GB)' },
    { sev:'warning',  job:'eks-pods',    ns:'default',           pod:'scheduler-deploy-3a7f1d-xr9vq',        line:'Job queue depth: 1,847 pending tasks — workers at capacity, consider horizontal scaling' },
    { sev:'info',     job:'auth',        ns:'default',           pod:'auth-service',                         line:'Scheduled token rotation complete — 14 service accounts refreshed, 0 failures' },
    { sev:'info',     job:'syslog',      ns:'monitoring',        pod:'loki-0',                               line:'Ingestion rate: 42 MB/s across 7 log streams — within configured limits' },
  ];
  const _logCritCount = _logEntries.filter(e => e.sev === 'critical').length;
  const _logWarnCount = _logEntries.filter(e => e.sev === 'warning').length;
  const _logSources   = [...new Set(_logEntries.map(e => e.job))];
  MOCK.logs = {
    configured: true,
    lines: _logEntries.map((e, i) => ({
      ts:        Date.now() - i * 110000,
      severity:  e.sev,
      job:       e.job,
      namespace: e.ns,
      pod:       e.pod,
      line:      e.line,
    })),
    stats: {
      total:    _logEntries.length,
      critical: _logCritCount,
      warning:  _logWarnCount,
      sources:  _logSources,
    },
  };

  /* ── FETCH INTERCEPTOR ───────────────────────────────────────────────── */
  window.fetch = function (url, options = {}) {
    const u    = (typeof url === 'string' ? url : url?.url) || '';
    const path = u.split('?')[0];

    if (path === '/auth/me')                return _mockResp(MOCK.user);
    if (path === '/auth/logout')            return _mockResp({ ok: true });
    if (path === '/api/metrics')            return _mockResp({ metrics: MOCK.metrics });
    if (path.startsWith('/api/logs'))       return _mockResp(MOCK.logs);
    if (path.startsWith('/api/incidents')) {
      const qs = (typeof url === 'string' ? url : url?.url || '').split('?')[1] || '';
      const status = new URLSearchParams(qs).get('status');
      const list = status === 'open' ? MOCK.incidents_open : MOCK.incidents_all;
      return _mockResp({ incidents: list });
    }
    if (path === '/api/sync-status')        return _mockResp(MOCK.sync_status);
    if (path === '/api/sync-history')       return _mockResp({ months: [] });
    if (path === '/api/container-health')   return _mockResp(MOCK.container_health);
    if (path === '/api/instances')          return _mockResp({ instances: MOCK.instances });
    if (path.startsWith('/api/instances/')) return _mockResp({ ok: true });
    if (path.startsWith('/api/eks/nodes/live')) return _mockResp({ nodes: MOCK.metrics.eks.nodes });
    if (path.startsWith('/api/ec2/instance-metrics')) return _mockResp({ cpu: _spark(45, 15, 20), mem: _spark(60, 10, 20), disk: _spark(42, 5, 20), source: 'demo' });
    if (path.startsWith('/admin/'))         return _mockResp({ users: [], pending: [] });
    if (path.startsWith('/api/reports/'))   return Promise.resolve(new Response('Demo mode — backend not connected', { status: 503 }));
    if (path.startsWith('/api/uptime/'))    return _mockResp({ incidents: [] });

    // Anything else: fail silently
    return _mockResp({});
  };
})();
