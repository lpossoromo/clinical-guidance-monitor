// Clinical Guidance Monitor — Data Client (GitHub Pages version)
// ═══════════════════════════════════════════════════════════════
// Reads data directly from JSON files in the /data/ folder.
// No API server needed — everything runs client-side.

// Cache loaded data to avoid repeated fetches within the same session
let _guidance = null;
let _changes = null;
let _config = null;
let _lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000; // Refresh data every 5 minutes

// ── Load all data files ────────────────────────────────────────────────────────

async function loadData(force = false) {
  const now = Date.now();
  if (!force && _guidance && (now - _lastFetch) < CACHE_TTL) return;

  const [guidanceRes, changesRes, configRes] = await Promise.all([
    fetch('data/guidance.json'),
    fetch('data/changes.json'),
    fetch('data/config.json')
  ]);

  _guidance = guidanceRes.ok ? await guidanceRes.json() : {};
  _changes = changesRes.ok ? await changesRes.json() : {};
  _config = configRes.ok ? await configRes.json() : {};
  _lastFetch = now;
}

// ── Acknowledged changes (stored in browser localStorage) ─────────────────────
// Since this is a static site, we can't write back to files from the browser.
// Instead, "Mark as read" is tracked locally in the browser.

function getAcknowledged() {
  try {
    return JSON.parse(localStorage.getItem('cgm-acknowledged') || '{}');
  } catch {
    return {};
  }
}

function setAcknowledged(data) {
  localStorage.setItem('cgm-acknowledged', JSON.stringify(data));
}

// ── Saved items (stored in browser localStorage) ───────────────────────────────

function getSavedIds() {
  try { return JSON.parse(localStorage.getItem('cgm-saved') || '{}'); }
  catch { return {}; }
}

function setSavedIds(data) {
  localStorage.setItem('cgm-saved', JSON.stringify(data));
}

// ── API object (same interface as the Cloudflare version) ──────────────────────

const Api = {

  // GET /stats
  async getStats() {
    await loadData();
    const acknowledged = getAcknowledged();

    const counts = { nice: 0, ncl: 0, nhs: 0, artp: 0, total: 0 };
    for (const item of Object.values(_guidance)) {
      if (item.source) {
        counts[item.source] = (counts[item.source] || 0) + 1;
        counts.total++;
      }
    }

    let unreadChanges = 0;
    let totalChanges = 0;
    for (const change of Object.values(_changes)) {
      totalChanges++;
      if (!change.acknowledged && !acknowledged[change.id]) unreadChanges++;
    }

    return {
      guidanceCount: counts,
      totalChanges,
      unreadChanges,
      lastUpdate: _config.lastRunStats || {},
      sources: _config.sources || {}
    };
  },

  // GET /guidance
  async getGuidance({ source = 'all', limit = 20, offset = 0 } = {}) {
    await loadData();

    let items = Object.values(_guidance);
    if (source !== 'all') items = items.filter(i => i.source === source);

    // Sort newest first by publication date, falling back to fetch date
    items.sort((a, b) => {
      const dateA = new Date(a.publishedDate || a.fetchedDate);
      const dateB = new Date(b.publishedDate || b.fetchedDate);
      return dateB - dateA;
    });

    // Map to summary format (exclude full content for list view)
    const mapped = items.map(item => ({
      id: item.id,
      url: item.url,
      title: item.title,
      source: item.source,
      type: item.type,
      publishedDate: item.publishedDate,
      fetchedDate: item.fetchedDate,
      excerpt: item.metadata?.description || item.content?.substring(0, 200) || '',
      wordCount: item.metadata?.wordCount || 0,
      estimatedReadTime: item.metadata?.estimatedReadTime || 0,
      parentUrl: item.parentUrl
    }));

    return {
      items: mapped.slice(offset, offset + limit),
      total: mapped.length,
      limit,
      offset
    };
  },

  // GET /guidance/:id
  async getGuidanceById(id) {
    await loadData();
    const item = _guidance[id];
    if (!item) return { error: 'Not found' };
    return item;
  },

  // GET /changes
  async getChanges({ limit = 50, offset = 0 } = {}) {
    await loadData();
    const acknowledged = getAcknowledged();

    let items = Object.values(_changes).map(change => ({
      ...change,
      // Merge server-side acknowledged flag with local localStorage flag
      acknowledged: change.acknowledged || !!acknowledged[change.id]
    }));

    items.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));

    const unread = items.filter(i => !i.acknowledged).length;

    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      unread,
      limit,
      offset
    };
  },

  // POST /changes/:id/acknowledge  (stored in localStorage)
  async acknowledgeChange(id) {
    const ack = getAcknowledged();
    ack[id] = true;
    setAcknowledged(ack);
    _lastFetch = 0; // Force refresh so counts update
    return { success: true };
  },

  // POST /changes/acknowledge-all  (stored in localStorage)
  async acknowledgeAll() {
    await loadData();
    const ack = getAcknowledged();
    for (const id of Object.keys(_changes)) {
      ack[id] = true;
    }
    setAcknowledged(ack);
    _lastFetch = 0;
    return { success: true };
  },

  // Saved items (localStorage-backed, sync)
  isSaved(id) {
    return !!getSavedIds()[id];
  },

  savedCount() {
    return Object.keys(getSavedIds()).length;
  },

  toggleSaved(id) {
    const saved = getSavedIds();
    if (saved[id]) { delete saved[id]; } else { saved[id] = true; }
    setSavedIds(saved);
    return { saved: !!saved[id] };
  },

  async getSavedGuidance() {
    await loadData();
    const saved = getSavedIds();
    const items = Object.values(_guidance).filter(item => saved[item.id]);
    items.sort((a, b) => {
      const dateA = new Date(a.publishedDate || a.fetchedDate);
      const dateB = new Date(b.publishedDate || b.fetchedDate);
      return dateB - dateA;
    });
    return { items, total: items.length };
  },

  clearAllSaved() {
    setSavedIds({});
    return { success: true };
  },

  // GET /search
  async search(query, source = 'all') {
    await loadData();
    const q = query.toLowerCase().trim();
    if (!q || q.length < 2) return { items: [], total: 0, query: '' };

    const results = [];

    for (const item of Object.values(_guidance)) {
      if (source !== 'all' && item.source !== source) continue;

      const titleMatch = item.title?.toLowerCase().includes(q);
      const contentMatch = item.content?.toLowerCase().includes(q);
      if (!titleMatch && !contentMatch) continue;

      let excerpt = '';
      if (contentMatch && item.content) {
        const idx = item.content.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 100);
        const end = Math.min(item.content.length, idx + q.length + 100);
        excerpt = (start > 0 ? '...' : '') + item.content.substring(start, end) + (end < item.content.length ? '...' : '');
      } else {
        excerpt = item.metadata?.description || '';
      }

      results.push({
        id: item.id,
        url: item.url,
        title: item.title,
        source: item.source,
        publishedDate: item.publishedDate,
        fetchedDate: item.fetchedDate,
        excerpt,
        wordCount: item.metadata?.wordCount || 0,
        matchType: titleMatch ? 'title' : 'content'
      });
    }

    results.sort((a, b) => {
      if (a.matchType !== b.matchType) return a.matchType === 'title' ? -1 : 1;
      const dateA = new Date(a.publishedDate || a.fetchedDate);
      const dateB = new Date(b.publishedDate || b.fetchedDate);
      return dateB - dateA;
    });

    return { items: results.slice(0, 50), total: results.length, query };
  }
};
