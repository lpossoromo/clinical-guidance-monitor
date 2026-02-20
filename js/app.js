// Clinical Guidance Monitor — Main Application
// ══════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  guidance: [],
  changes: [],
  stats: null,
  currentSource: 'all',
  currentOffset: 0,
  searchQuery: '',
  isSearching: false,
  totalGuidance: 0,
  unreadChanges: 0,
  activeTab: 'dashboard'
};

// ── Initialise ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initTabs();
  initEventListeners();
  loadDashboard();
  startPolling();
});

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const [stats, guidance] = await Promise.allSettled([
      Api.getStats(),
      Api.getGuidance({ source: state.currentSource, limit: 20, offset: 0 })
    ]);

    if (stats.status === 'fulfilled') {
      state.stats = stats.value;
      renderStats(stats.value);
    }

    if (guidance.status === 'fulfilled') {
      state.guidance = guidance.value.items;
      state.totalGuidance = guidance.value.total;
      state.currentOffset = guidance.value.items.length;
      renderGuidanceFeed(state.guidance);
    }

    if (stats.status === 'rejected' && guidance.status === 'rejected') {
      showFeedError('Could not load data. Check that the data files exist in the repository.');
    }
  } catch (err) {
    console.error('Dashboard load error:', err);
    showFeedError('Failed to load data. ' + err.message);
  }
}

async function loadMore() {
  const btn = document.getElementById('btn-load-more');
  btn.textContent = 'Loading...';
  btn.disabled = true;

  try {
    let result;
    if (state.isSearching) {
      // Search doesn't support offset — all results returned at once
      return;
    } else {
      result = await Api.getGuidance({
        source: state.currentSource,
        limit: 20,
        offset: state.currentOffset
      });
    }

    state.guidance = state.guidance.concat(result.items);
    state.currentOffset += result.items.length;
    state.totalGuidance = result.total;
    renderGuidanceFeed(state.guidance);
  } catch (err) {
    console.error('Load more error:', err);
  } finally {
    btn.textContent = 'Load More';
    btn.disabled = false;
  }
}

async function loadChanges() {
  try {
    const result = await Api.getChanges({ limit: 100 });
    state.changes = result.items;
    state.unreadChanges = result.unread;
    renderChanges(result.items);
    updateUnreadBadge(result.unread);
  } catch (err) {
    console.error('Changes load error:', err);
    document.getElementById('changes-feed').innerHTML =
      '<div class="p-8 text-center text-gray-400">Failed to load changes.</div>';
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

async function doSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) {
    clearSearch();
    return;
  }

  state.searchQuery = query;
  state.isSearching = true;
  document.getElementById('btn-clear-search').classList.remove('hidden');

  // Show loading
  document.getElementById('guidance-feed').innerHTML =
    '<div class="p-8 text-center text-gray-400"><div class="loading-spinner mx-auto mb-3"></div>Searching...</div>';

  try {
    const result = await Api.search(query, state.currentSource);
    state.guidance = result.items;
    state.totalGuidance = result.total;
    renderGuidanceFeed(state.guidance, query);
  } catch (err) {
    console.error('Search error:', err);
    showFeedError('Search failed: ' + err.message);
  }
}

function clearSearch() {
  state.searchQuery = '';
  state.isSearching = false;
  state.currentOffset = 0;
  document.getElementById('search-input').value = '';
  document.getElementById('btn-clear-search').classList.add('hidden');
  loadDashboard();
}

// ── Filters ───────────────────────────────────────────────────────────────────

function applyFilters() {
  state.currentSource = document.getElementById('filter-source').value;
  state.currentOffset = 0;
  state.guidance = [];

  if (state.isSearching) {
    doSearch();
  } else {
    loadDashboard();
  }
}

function filterBySource(source) {
  document.getElementById('filter-source').value = source;
  state.currentSource = source;
  state.currentOffset = 0;
  state.guidance = [];

  if (state.isSearching) {
    doSearch();
  } else {
    loadDashboard();
  }
}

// ── Rendering: Stats ──────────────────────────────────────────────────────────

function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.guidanceCount?.total ?? 0;
  document.getElementById('stat-unread').textContent = stats.unreadChanges ?? 0;
  document.getElementById('stat-changes').textContent = stats.totalChanges ?? 0;
  document.getElementById('stat-last-update').textContent = relativeTime(stats.lastUpdate?.rssPoller);

  document.getElementById('count-nice').textContent = stats.guidanceCount?.nice ?? 0;
  document.getElementById('count-ncl').textContent = stats.guidanceCount?.ncl ?? 0;
  document.getElementById('count-nhs').textContent = stats.guidanceCount?.nhs ?? 0;
  document.getElementById('count-artp').textContent = stats.guidanceCount?.artp ?? 0;

  updateUnreadBadge(stats.unreadChanges);
}

// ── Rendering: Guidance Feed ──────────────────────────────────────────────────

function renderGuidanceFeed(items, highlightQuery = '') {
  const container = document.getElementById('guidance-feed');
  const loadMoreContainer = document.getElementById('load-more-container');

  if (!items || items.length === 0) {
    container.innerHTML = document.getElementById('tmpl-empty').innerHTML;
    loadMoreContainer.classList.add('hidden');
    return;
  }

  container.innerHTML = items.map(item => {
    const badge = sourceBadge(item.source);
    let excerpt = escapeHTML(item.excerpt || '');
    if (highlightQuery) {
      excerpt = highlightText(excerpt, highlightQuery);
    }

    return `
      <div class="guidance-card fade-in" onclick="openGuidance('${escapeAttr(item.id)}')">
        <div class="flex justify-between items-start gap-3 mb-1.5">
          <h3 class="font-semibold text-[0.9375rem] leading-snug flex-1">${escapeHTML(item.title)}</h3>
          ${badge}
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-2 line-clamp-2">${excerpt}</p>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
          <span>Published: ${formatDate(item.publishedDate)}</span>
          <span>${(item.wordCount || 0).toLocaleString()} words</span>
          ${item.estimatedReadTime ? `<span>${item.estimatedReadTime} min read</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Show/hide load more
  if (!state.isSearching && state.currentOffset < state.totalGuidance) {
    loadMoreContainer.classList.remove('hidden');
  } else {
    loadMoreContainer.classList.add('hidden');
  }
}

// ── Rendering: Changes ────────────────────────────────────────────────────────

function renderChanges(items) {
  const container = document.getElementById('changes-feed');

  if (!items || items.length === 0) {
    container.innerHTML = '<div class="p-8 text-center text-gray-400">No changes recorded yet.</div>';
    return;
  }

  container.innerHTML = items.map(item => {
    const badge = sourceBadge(item.source);
    const typeBadge = item.changeType === 'new_guidance'
      ? '<span class="change-type-new text-xs font-medium px-2 py-0.5 rounded">New</span>'
      : '<span class="change-type-update text-xs font-medium px-2 py-0.5 rounded">Updated</span>';

    return `
      <div class="change-card fade-in ${item.acknowledged ? '' : 'unread'}">
        <div class="flex justify-between items-start gap-3 mb-1.5">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-1">
              ${badge} ${typeBadge}
              <span class="text-xs text-gray-400">${formatDate(item.detectedAt)}</span>
            </div>
            <h3 class="font-semibold text-[0.9375rem]">${escapeHTML(item.title)}</h3>
          </div>
          <div class="flex gap-2 shrink-0">
            ${!item.acknowledged ? `<button onclick="event.stopPropagation(); acknowledgeChange('${escapeAttr(item.id)}')" class="btn-secondary text-xs py-1 px-2">Mark Read</button>` : ''}
            <a href="${escapeAttr(item.url)}" target="_blank" onclick="event.stopPropagation()" class="btn-secondary text-xs py-1 px-2">View</a>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Modal ─────────────────────────────────────────────────────────────────────

async function openGuidance(id) {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  overlay.classList.add('flex');

  document.getElementById('modal-title').textContent = 'Loading...';
  document.getElementById('modal-meta').textContent = '';
  document.getElementById('modal-badge').innerHTML = '';
  document.getElementById('modal-content').innerHTML = '<div class="loading-spinner mx-auto mt-8"></div>';
  document.getElementById('modal-link').href = '#';

  try {
    const item = await Api.getGuidanceById(id);

    document.getElementById('modal-badge').innerHTML = sourceBadge(item.source);
    document.getElementById('modal-title').textContent = item.title;
    document.getElementById('modal-meta').innerHTML = `
      Published: ${formatDate(item.publishedDate)} &middot;
      Fetched: ${formatDate(item.fetchedDate)} &middot;
      ${(item.metadata?.wordCount || 0).toLocaleString()} words &middot;
      ${item.metadata?.estimatedReadTime || '?'} min read
    `;

    // Format content as paragraphs
    const content = item.content || 'No content available.';
    const formatted = content.split('\n\n')
      .filter(p => p.trim())
      .map(p => `<p>${escapeHTML(p.trim())}</p>`)
      .join('');

    document.getElementById('modal-content').innerHTML = `<div class="prose-content">${formatted}</div>`;
    document.getElementById('modal-link').href = item.url;

  } catch (err) {
    document.getElementById('modal-content').innerHTML =
      `<div class="text-red-500 p-4">Failed to load: ${escapeHTML(err.message)}</div>`;
  }
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function acknowledgeChange(id) {
  try {
    await Api.acknowledgeChange(id);
    await loadChanges();
  } catch (err) {
    console.error('Acknowledge error:', err);
  }
}

async function acknowledgeAll() {
  try {
    await Api.acknowledgeAll();
    await loadChanges();
  } catch (err) {
    console.error('Acknowledge all error:', err);
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

function switchTab(tabName) {
  state.activeTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nav-tab[data-tab="${tabName}"]`).classList.add('active');

  // Show/hide tab content
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById(`tab-${tabName}`).classList.remove('hidden');

  // Load data for the tab
  if (tabName === 'changes') {
    loadChanges();
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function initTheme() {
  const stored = localStorage.getItem('cgm-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = stored === 'dark' || (!stored && prefersDark);

  if (isDark) {
    document.documentElement.classList.add('dark');
  }
  updateThemeIcons();

  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  const isDark = document.documentElement.classList.contains('dark');
  localStorage.setItem('cgm-theme', isDark ? 'dark' : 'light');
  updateThemeIcons();
}

function updateThemeIcons() {
  const isDark = document.documentElement.classList.contains('dark');
  document.getElementById('icon-sun').classList.toggle('hidden', !isDark);
  document.getElementById('icon-moon').classList.toggle('hidden', isDark);
}

// ── Event Listeners ───────────────────────────────────────────────────────────

function initEventListeners() {
  document.getElementById('btn-changes').addEventListener('click', () => switchTab('changes'));

  // Close modal on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

// ── Polling ───────────────────────────────────────────────────────────────────

function startPolling() {
  // Re-fetch data files every 5 minutes to pick up any new guidance
  setInterval(async () => {
    try {
      const stats = await Api.getStats();
      updateUnreadBadge(stats.unreadChanges);
    } catch (err) {
      // Silently fail on poll
    }
  }, 300_000);
}

// ── Badge updates ─────────────────────────────────────────────────────────────

function updateUnreadBadge(count) {
  state.unreadChanges = count;

  const headerBadge = document.getElementById('unread-badge');
  const tabBadge = document.getElementById('changes-tab-badge');

  [headerBadge, tabBadge].forEach(badge => {
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

// ── Utility functions ─────────────────────────────────────────────────────────

function sourceBadge(source) {
  const labels = { nice: 'NICE', ncl: 'NCL', nhs: 'NHS', artp: 'ARTP' };
  return `<span class="source-badge badge-${source}">${labels[source] || source.toUpperCase()}</span>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function relativeTime(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const now = new Date();
  const diffMs = now - d;
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatDate(dateStr);
}

function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function highlightText(text, query) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

function showFeedError(message) {
  document.getElementById('guidance-feed').innerHTML =
    `<div class="p-8 text-center text-red-400">${escapeHTML(message)}</div>`;
}
