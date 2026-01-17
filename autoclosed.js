// Autoclosed Tabs Page
import DB from './background/db.js';

const db = new DB();
const DEFAULT_FAVICON = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect fill=%22%23e5e7eb%22 width=%2216%22 height=%2216%22 rx=%222%22/></svg>';

// Theme handling
async function initTheme() {
  try {
    const savedTheme = await db.getSetting('theme');
    const theme = savedTheme || 'light';
    if (theme === 'dark') {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  } catch (e) {
    console.log('Theme init error:', e);
  }
}


// Format relative time
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

// Get day name
function getDayName(dayIndex) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[dayIndex];
}

// Calculate statistics
function calculateStats(tabs) {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);

  return {
    total: tabs.length,
    today: tabs.filter(t => t.closedAt >= todayStart.getTime()).length,
    week: tabs.filter(t => t.closedAt >= weekStart.getTime()).length
  };
}

// Get data for line chart (tabs per day)
function getLineChartData(tabs, days) {
  const data = [];
  const labels = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);

    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);

    const count = tabs.filter(t =>
      t.closedAt >= date.getTime() && t.closedAt < nextDate.getTime()
    ).length;

    data.push(count);
    labels.push(`${date.getMonth() + 1}/${date.getDate()}`);
  }

  return { data, labels };
}

// Get data for bar chart (tabs by day of week)
function getBarChartData(tabs) {
  const counts = [0, 0, 0, 0, 0, 0, 0];

  tabs.forEach(tab => {
    const day = new Date(tab.closedAt).getDay();
    counts[day]++;
  });

  return {
    data: counts,
    labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  };
}

// Draw line chart
function drawLineChart(canvas, chartData) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 20, bottom: 30, left: 35 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const { data, labels } = chartData;
  const maxValue = Math.max(...data, 1);

  // Get computed styles for theming
  const styles = getComputedStyle(document.documentElement);
  const lineColor = styles.getPropertyValue('--chart-line').trim() || '#3b82f6';
  const gridColor = styles.getPropertyValue('--chart-grid').trim() || '#e5e7eb';
  const textColor = styles.getPropertyValue('--text-muted').trim() || '#9ca3af';

  ctx.clearRect(0, 0, width, height);

  // Draw grid lines
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartHeight / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const value = Math.round(maxValue - (maxValue / gridLines) * i);
    ctx.fillText(value.toString(), padding.left - 8, y);
  }

  // Draw line
  if (data.length > 0) {
    const stepX = chartWidth / (data.length - 1 || 1);

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    data.forEach((value, i) => {
      const x = padding.left + stepX * i;
      const y = padding.top + chartHeight - (value / maxValue) * chartHeight;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    // Draw points
    ctx.fillStyle = lineColor;
    data.forEach((value, i) => {
      const x = padding.left + stepX * i;
      const y = padding.top + chartHeight - (value / maxValue) * chartHeight;

      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // X-axis labels
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const labelStep = Math.ceil(labels.length / 7);
    labels.forEach((label, i) => {
      if (i % labelStep === 0 || i === labels.length - 1) {
        const x = padding.left + stepX * i;
        ctx.fillText(label, x, height - padding.bottom + 8);
      }
    });
  }
}

// Draw bar chart
function drawBarChart(canvas, chartData) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { top: 20, right: 20, bottom: 30, left: 35 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const { data, labels } = chartData;
  const maxValue = Math.max(...data, 1);

  // Get computed styles for theming
  const styles = getComputedStyle(document.documentElement);
  const barColor = styles.getPropertyValue('--chart-bar').trim() || '#60a5fa';
  const gridColor = styles.getPropertyValue('--chart-grid').trim() || '#e5e7eb';
  const textColor = styles.getPropertyValue('--text-muted').trim() || '#9ca3af';

  ctx.clearRect(0, 0, width, height);

  // Draw grid lines
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartHeight / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const value = Math.round(maxValue - (maxValue / gridLines) * i);
    ctx.fillText(value.toString(), padding.left - 8, y);
  }

  // Draw bars
  const barCount = data.length;
  const barWidth = (chartWidth / barCount) * 0.6;
  const barGap = (chartWidth / barCount) * 0.4;

  ctx.fillStyle = barColor;

  data.forEach((value, i) => {
    const barHeight = (value / maxValue) * chartHeight;
    const x = padding.left + (chartWidth / barCount) * i + barGap / 2;
    const y = padding.top + chartHeight - barHeight;

    // Draw rounded bar
    const radius = Math.min(4, barWidth / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + barWidth - radius, y);
    ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
    ctx.lineTo(x + barWidth, padding.top + chartHeight);
    ctx.lineTo(x, padding.top + chartHeight);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.fill();
  });

  // X-axis labels
  ctx.fillStyle = textColor;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  labels.forEach((label, i) => {
    const x = padding.left + (chartWidth / barCount) * i + (chartWidth / barCount) / 2;
    ctx.fillText(label, x, height - padding.bottom + 8);
  });
}

// Render tabs list
function renderTabsList(tabs) {
  const tabsList = document.getElementById('tabs-list');

  if (tabs.length === 0) {
    tabsList.innerHTML = '<div class="empty-state">No autoclosed tabs yet</div>';
    return;
  }

  // Sort by most recent first
  const sortedTabs = [...tabs].sort((a, b) => b.closedAt - a.closedAt);

  tabsList.innerHTML = sortedTabs.map(tab => `
    <div class="tab-item" data-url="${encodeURIComponent(tab.url)}">
      <img class="tab-favicon" src="${tab.favIconUrl || 'chrome://favicon/' + tab.url}" alt="">
      <div class="tab-info">
        <span class="tab-title">${escapeHtml(tab.title || 'Untitled')}</span>
        <span class="tab-url">${escapeHtml(tab.url)}</span>
      </div>
      <span class="tab-closed-time">${formatRelativeTime(tab.closedAt)}</span>
      <button class="btn-open" data-url="${encodeURIComponent(tab.url)}">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M6 3H3V13H13V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M9 2H14V7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M14 2L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        Open
      </button>
    </div>
  `).join('');

  // Add favicon error handlers
  tabsList.querySelectorAll('.tab-favicon').forEach(img => {
    img.addEventListener('error', () => { img.src = DEFAULT_FAVICON; }, { once: true });
  });

  // Add click handlers
  tabsList.querySelectorAll('.btn-open').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = decodeURIComponent(btn.dataset.url);
      chrome.tabs.create({ url });
    });
  });
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Update statistics display
function updateStats(stats) {
  document.getElementById('total-closed').textContent = stats.total;
  document.getElementById('closed-today').textContent = stats.today;
  document.getElementById('closed-week').textContent = stats.week;
}

// Initialize page
async function init() {
  await initTheme();

  // Back button
  document.getElementById('back-btn').addEventListener('click', () => {
    window.location.href = 'popup.html';
  });

  // Load data
  const tabs = await db.getAutoclosedTabs();

  // Update statistics
  const stats = calculateStats(tabs);
  updateStats(stats);

  // Render tabs list
  renderTabsList(tabs);

  // Draw charts
  const lineChart = document.getElementById('line-chart');
  const barChart = document.getElementById('bar-chart');
  const lineChartRange = document.getElementById('line-chart-range');

  function updateLineChart() {
    const days = parseInt(lineChartRange.value);
    const lineData = getLineChartData(tabs, days);
    drawLineChart(lineChart, lineData);
  }

  updateLineChart();
  lineChartRange.addEventListener('change', updateLineChart);

  const barData = getBarChartData(tabs);
  drawBarChart(barChart, barData);

  // Handle window resize
  window.addEventListener('resize', () => {
    updateLineChart();
    drawBarChart(barChart, barData);
  });

  // Clear all button
  document.getElementById('clear-all-btn').addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all autoclosed tabs history?')) {
      await db.clearAutoclosedTabs();
      renderTabsList([]);
      updateStats({ total: 0, today: 0, week: 0 });
      updateLineChart();
      drawBarChart(barChart, { data: [0,0,0,0,0,0,0], labels: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] });
    }
  });
}

// Start
init();
