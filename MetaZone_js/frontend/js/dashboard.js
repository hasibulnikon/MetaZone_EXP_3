const statGrid = document.getElementById('statGrid');
const activityChart = document.getElementById('activityChart');
const chartLegend = document.getElementById('chartLegend');
const lifetimeKv = document.getElementById('lifetimeKv');
const aiUsageKv = document.getElementById('aiUsageKv');
const insightsKv = document.getElementById('insightsKv');
const systemKv = document.getElementById('systemKv');
const dailyLimitInput = document.getElementById('dailyLimitInput');
const recentActivityEl = document.getElementById('recentActivity');

const LIFETIME_LABELS = {
  total_files_processed: 'Files Processed',
  total_metadata_generated: 'Metadata Generated',
  total_embedded: 'Embedded Images',
  total_prompt_generations: 'Prompt Generations',
  total_prompt_to_prompt: 'Prompt-to-Prompt',
  total_smart_workflow_runs: 'Smart Workflow Runs',
  total_projects_completed: 'Projects Completed',
};

const CHART_SERIES = [
  { key: 'files_processed', label: 'Files Processed', color: '#5b8cff' },
  { key: 'metadata_generated', label: 'Metadata Generated', color: '#4caf7d' },
  { key: 'prompts_generated', label: 'Prompts Generated', color: '#a259e6' },
  { key: 'embedded_images', label: 'Embedded Images', color: '#e6a24c' },
];

function kvRow(label, value, color) {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const style = color ? ` style="color:${color}"` : '';
  row.innerHTML = `<span class="kv-label">${label}</span><span class="kv-value"${style}>${value}</span>`;
  return row;
}

function renderStatCards(today) {
  const cards = [
    ['📁', today.files_processed, 'Files Processed'],
    ['✓', today.completed, 'Completed'],
    ['✗', today.failed, 'Failed'],
    ['⟳', 0, 'Running Tasks'],
    ['📋', 0, 'In Queue'],
    ['⭐', today.avg_score != null ? today.avg_score.toFixed(1) + '%' : '—', 'Avg. Metadata Score'],
  ];
  statGrid.innerHTML = '';
  for (const [icon, value, label] of cards) {
    const el = document.createElement('div');
    el.className = 'stat-card';
    el.innerHTML = `<div class="stat-icon">${icon}</div><div class="stat-value">${value}</div><div class="stat-label">${label}</div>`;
    statGrid.appendChild(el);
  }
}

function renderChart(days, series) {
  // Plain SVG multi-line chart -- no charting library needed for a
  // 7-point, 4-series dataset. Matches the original's 4-series legend.
  const w = 900, h = 200, padL = 30, padB = 20, padT = 10;
  const plotW = w - padL - 10, plotH = h - padB - padT;
  const allVals = CHART_SERIES.flatMap(s => series[s.key] || []);
  const max = Math.max(1, ...allVals);
  const stepX = plotW / (days.length - 1 || 1);

  const toPoint = (i, v) => {
    const x = padL + i * stepX;
    const y = padT + plotH - (v / max) * plotH;
    return [x, y];
  };

  let svg = '';
  for (const s of CHART_SERIES) {
    const values = series[s.key] || [];
    const points = values.map((v, i) => toPoint(i, v));
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
    points.forEach(([x, y]) => { svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${s.color}"/>`; });
  }
  days.forEach((d, i) => {
    const [x] = toPoint(i, 0);
    svg += `<text x="${x.toFixed(1)}" y="${h - 2}" font-size="9" fill="var(--text-dim)" text-anchor="middle">${d.slice(5)}</text>`;
  });

  activityChart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:200px;">${svg}</svg>`;
  chartLegend.innerHTML = CHART_SERIES.map(s =>
    `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.label}</span>`
  ).join('');
}

function renderRecentActivity(items) {
  recentActivityEl.innerHTML = '';
  if (!items.length) {
    recentActivityEl.appendChild(kvRow('—', 'No activity yet'));
    return;
  }
  for (const it of items) {
    const label = `${it.kind.replace(/_/g, ' ')} · Files: ${it.count}`;
    recentActivityEl.appendChild(kvRow(label, it.ts.slice(5, 16)));
  }
}

async function loadDashboard() {
  const res = await pywebview.api.get_dashboard_data();
  if (!res.ok) return;
  renderStatCards(res.today);
  renderChart(res.chart.days, res.chart.series);

  lifetimeKv.innerHTML = '';
  for (const [key, label] of Object.entries(LIFETIME_LABELS)) {
    lifetimeKv.appendChild(kvRow(label, (res.lifetime[key] || 0).toLocaleString()));
  }

  const u = res.ai_usage;
  aiUsageKv.innerHTML = '';
  aiUsageKv.appendChild(kvRow('Current Provider', u.provider));
  aiUsageKv.appendChild(kvRow('Current Model', u.model));
  aiUsageKv.appendChild(kvRow('API Requests', u.requests.toLocaleString()));
  aiUsageKv.appendChild(kvRow('API Requests Saved', u.requests_saved.toLocaleString(), 'var(--accent)'));
  aiUsageKv.appendChild(kvRow('Est. Capacity Left Today',
    u.active_keys ? `~${u.remaining.toLocaleString()} images` : 'No active keys',
    u.active_keys ? 'var(--accent)' : undefined));
  aiUsageKv.appendChild(kvRow('Used Today',
    u.active_keys ? `${u.used_today.toLocaleString()} / ${u.total_capacity.toLocaleString()}` : u.used_today.toLocaleString()));
  dailyLimitInput.value = u.daily_limit_per_key;

  const ins = res.insights;
  insightsKv.innerHTML = '';
  insightsKv.appendChild(kvRow('Images This Week', ins.images_this_week.toLocaleString()));
  insightsKv.appendChild(kvRow('Est. Requests Saved', ins.requests_saved.toLocaleString()));
  insightsKv.appendChild(kvRow('Avg. Metadata Quality', ins.avg_score != null ? ins.avg_score.toFixed(1) + '%' : '—'));
  insightsKv.appendChild(kvRow('Avg. Processing Speed', ins.speed_img_per_min ? `${ins.speed_img_per_min} img/min` : '—'));

  const sys = res.system;
  systemKv.innerHTML = '';
  systemKv.appendChild(kvRow('Worker Status', sys.worker, sys.worker === 'Active' ? 'var(--accent)' : undefined));
  systemKv.appendChild(kvRow('Background Tasks', sys.background_tasks));
  systemKv.appendChild(kvRow('Queue Status', sys.queue));
  systemKv.appendChild(kvRow('CPU Usage', sys.cpu_percent != null ? `${sys.cpu_percent}%` : 'N/A'));
  systemKv.appendChild(kvRow('RAM Usage', sys.ram_percent != null ? `${sys.ram_percent}%` : 'N/A'));

  renderRecentActivity(res.recent_activity);
}

dailyLimitInput.addEventListener('change', async () => {
  await pywebview.api.set_daily_limit(parseInt(dailyLimitInput.value) || 250);
  loadDashboard();
});

document.querySelector('[data-page="dashboard"]').addEventListener('click', loadDashboard);
onPywebviewReady(loadDashboard); // dashboard is the landing page now
