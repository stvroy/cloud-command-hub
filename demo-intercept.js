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
  MOCK.metrics.guardduty = { findings: [], total: 0, high: 0, medium: 0, low: 0 };

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

  /* ── ALB / Network (empty — shows "No data" gracefully) ── */
  MOCK.metrics.alb         = { load_balancers: [], total: 0 };
  MOCK.metrics.ec2_network = {};
  MOCK.metrics.telemetry   = null;
  MOCK.metrics.ngsa_fhir   = {};

  /* ── Sync status (for App Performance section) ── */
  MOCK.sync_status = { configured: false, regions: [] };

  /* ── Log samples ── */
  const LOG_SOURCES = ['auth','syslog','eks-pods','cloudtrail'];
  MOCK.logs = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    ts: new Date(Date.now() - i * 180000).toISOString(),
    severity: i === 2 ? 'error' : i === 5 ? 'warning' : 'info',
    source: LOG_SOURCES[i % LOG_SOURCES.length],
    namespace: i % 3 === 0 ? 'monitoring' : i % 3 === 1 ? 'default' : 'kube-system',
    pod: `app-pod-${(i + 1).toString().padStart(4,'0')}`,
    message: [
      'Health check passed for /api/health',
      'Connection established to database',
      'ERROR: upstream timeout after 30s — retrying',
      'Scheduled backup completed successfully',
      'TLS certificate refreshed, expires in 85 days',
      'WARNING: memory usage at 78%, approaching threshold',
      'User authenticated via SSO',
      'Kubernetes pod restarted: crashloopbackoff resolved',
      'CloudTrail: IAM policy change detected',
      'S3 lifecycle rule applied: 1,247 objects transitioned to Glacier',
    ][i % 10],
  }));

  /* ── FETCH INTERCEPTOR ───────────────────────────────────────────────── */
  window.fetch = function (url, options = {}) {
    const u    = (typeof url === 'string' ? url : url?.url) || '';
    const path = u.split('?')[0];

    if (path === '/auth/me')                return _mockResp(MOCK.user);
    if (path === '/auth/logout')            return _mockResp({ ok: true });
    if (path === '/api/metrics')            return _mockResp({ metrics: MOCK.metrics });
    if (path.startsWith('/api/logs'))       return _mockResp({ logs: MOCK.logs, total: MOCK.logs.length });
    if (path.startsWith('/api/incidents'))  return _mockResp([]);
    if (path === '/api/sync-status')        return _mockResp(MOCK.sync_status);
    if (path === '/api/sync-history')       return _mockResp({ months: [] });
    if (path === '/api/container-health')   return _mockResp({ configured: false, hosts: [] });
    if (path.startsWith('/api/instances'))  return _mockResp([]);
    if (path.startsWith('/api/eks/nodes/live')) return _mockResp({ nodes: MOCK.metrics.eks.nodes });
    if (path.startsWith('/api/ec2/instance-metrics')) return _mockResp({ cpu: _spark(45, 15, 20), mem: _spark(60, 10, 20), disk: _spark(42, 5, 20), source: 'demo' });
    if (path.startsWith('/admin/'))         return _mockResp({ users: [], pending: [] });
    if (path.startsWith('/api/reports/'))   return Promise.resolve(new Response('Demo mode — backend not connected', { status: 503 }));
    if (path.startsWith('/api/uptime/'))    return _mockResp({ incidents: [] });

    // Anything else: fail silently
    return _mockResp({});
  };
})();
