'use strict';

// Clinical Guidance Monitor — HTML Poller (ARTP)
// Runs on GitHub Actions every 12 hours
// Monitors the ARTP news page for new articles via hash comparison
// Saves data to JSON files in the data/ directory

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(process.cwd(), 'data');

// Default exclude keywords for ARTP — filters out non-PA-relevant articles
// (QC schemes, sample/container updates, student training, technician resources)
const PA_EXCLUDE_KEYWORDS = [
  'student training', 'student scheme', 'sample container', 'proficiency testing',
  'external quality', 'eqa', 'quality control', 'qc scheme',
  'technician training', 'training scheme', 'training course',
  'job vacancy', 'practice vacancy', 'workforce'
];

// ── Data file helpers ──────────────────────────────────────────────────────────

function readData(filename, defaultValue = {}) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeData(filename, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── HTTP fetch helper ──────────────────────────────────────────────────────────

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

// ── HTML cleaning ──────────────────────────────────────────────────────────────

function cleanHTML(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#\d+;/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html) {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    return titleTag[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*[\|–—-]\s*(NICE|NHS|England|ARTP|NCL).*$/i, '')
      .trim();
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return 'Untitled';
}

function parsePublishedDate(html) {
  const metaDate = html.match(/<meta[^>]*(?:name|property)="(?:article:published_time|datePublished|date)"[^>]*content="([^"]+)"/i);
  if (metaDate) return metaDate[1].split('T')[0];
  const timeEl = html.match(/<time[^>]*datetime="([^"]+)"/i);
  if (timeEl) return timeEl[1].split('T')[0];
  return null;
}

function extractARTPContent(html) {
  const patterns = [
    /<div[^>]*class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:div|footer|nav)/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:div|footer|nav)/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1].length > 100) {
      return cleanHTML(match[1]);
    }
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? cleanHTML(bodyMatch[1]) : cleanHTML(html);
}

// ── ARTP: Extract article links ────────────────────────────────────────────────

function extractARTPArticleLinks(html) {
  const articles = [];
  const seen = new Set();

  // ARTP news articles: /news/[ID]/[slug]
  const articlePattern = /<a[^>]*href="(\/news\/(\d+)\/([^"]+))"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...html.matchAll(articlePattern)];

  for (const match of matches) {
    const articlePath = match[1];
    const id = match[2];
    const slug = match[3];

    if (seen.has(id)) continue;
    seen.add(id);

    const fullUrl = 'https://www.artp.org.uk' + articlePath;

    let title = match[4].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 3) {
      title = slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    // Try to find a date near this link
    const surroundingHtml = html.substring(
      Math.max(0, html.indexOf(articlePath) - 500),
      Math.min(html.length, html.indexOf(articlePath) + 500)
    );
    const dateMatch = surroundingHtml.match(/(\d{2}\/\d{2}\/\d{4})/);
    const date = dateMatch ? dateMatch[1] : null;

    articles.push({ url: fullUrl, id, title, date });
  }

  return articles;
}

// ── Crawl an ARTP article and store it ────────────────────────────────────────

async function crawlAndStoreARTP(url, title, date, seen, guidance, changes, config) {
  console.log(`  Crawling ARTP: ${url}`);

  let html;
  try {
    html = await fetchPage(url);
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return;
  }

  const content = extractARTPContent(html);
  const resolvedTitle = title || extractTitle(html);

  if (!content || content.length < 50) {
    console.log(`  Skipping — content too short`);
    return;
  }

  const contentHash = hashString(content);
  const urlHash = hashString(url);
  const storageKey = `content:${urlHash}`;

  const existing = guidance[storageKey];
  const isNew = !existing;
  const hasChanged = existing && existing.contentHash !== contentHash;

  if (!isNew && !hasChanged) {
    console.log(`  No changes: ${resolvedTitle}`);
    return;
  }

  const now = new Date().toISOString();
  const wordCount = content.split(/\s+/).length;

  guidance[storageKey] = {
    id: storageKey,
    url,
    title: resolvedTitle,
    source: 'artp',
    type: 'article',
    publishedDate: date || parsePublishedDate(html) || now.split('T')[0],
    fetchedDate: now,
    contentHash,
    content,
    parentUrl: null,
    metadata: {
      wordCount,
      estimatedReadTime: Math.ceil(wordCount / 250),
      description: content.substring(0, 200)
    }
  };

  const changeType = isNew ? 'new_guidance' : 'content_update';
  const changeKey = `change:${Date.now()}:${urlHash}`;

  changes[changeKey] = {
    id: changeKey,
    url,
    title: resolvedTitle,
    source: 'artp',
    changeType,
    detectedAt: now,
    previousHash: existing?.contentHash || null,
    newHash: contentHash,
    acknowledged: false
  };

  config.unreadChanges = (config.unreadChanges || 0) + 1;
  console.log(`  Stored ${changeType}: "${resolvedTitle}" (${wordCount} words)`);
}

// ── ARTP: Monitor for changes ──────────────────────────────────────────────────

async function checkARTPNews(seen, guidance, changes, pageHashes, config) {
  console.log('Checking ARTP news page...');

  const url = 'https://www.artp.org.uk/news';
  let html;
  try {
    html = await fetchPage(url);
  } catch (err) {
    console.error('ARTP fetch failed:', err.message);
    return;
  }

  const articleLinks = extractARTPArticleLinks(html);
  const fingerprint = articleLinks.map(a => a.url).sort().join('|');
  const currentHash = hashString(fingerprint);

  const stored = pageHashes['artp-news'] || null;
  const previousHash = stored?.hash || null;

  console.log(`ARTP hash: ${currentHash} (previous: ${previousHash || 'none'})`);

  const now = new Date().toISOString();

  if (previousHash && currentHash === previousHash) {
    console.log('ARTP: No changes detected');
    pageHashes['artp-news'] = { ...stored, lastChecked: now };
    return;
  }

  console.log('ARTP: Changes detected — processing new articles');
  let newCount = 0;

  const excludeKeywords = config.sources?.artp?.excludeKeywords || PA_EXCLUDE_KEYWORDS;

  for (const article of articleLinks) {
    const hash = hashString(article.url);
    const seenKey = `artp:${hash}`;
    if (seen[seenKey]) continue;

    // PA relevance filtering — skip non-PA-relevant ARTP articles by title
    const titleLower = article.title.toLowerCase();
    if (excludeKeywords.some(kw => titleLower.includes(kw.toLowerCase()))) {
      console.log(`  ARTP: Skipping (excluded) "${article.title}"`);
      continue;
    }

    seen[seenKey] = {
      url: article.url,
      title: article.title,
      discovered: now,
      source: 'artp'
    };

    await crawlAndStoreARTP(article.url, article.title, article.date, seen, guidance, changes, config);
    newCount++;
    await sleep(500);
  }

  pageHashes['artp-news'] = {
    url,
    hash: currentHash,
    lastChecked: now,
    lastChanged: newCount > 0 ? now : (stored?.lastChanged || now),
    articlesFound: articleLinks.length,
    newArticlesFound: newCount
  };

  console.log(`ARTP: ${newCount} new articles out of ${articleLinks.length} total`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('HTML Poller starting at', new Date().toISOString());

  const seen = readData('seen.json', {});
  const guidance = readData('guidance.json', {});
  const changes = readData('changes.json', {});
  const pageHashes = readData('page-hashes.json', {});
  const config = readData('config.json', {
    sources: { artp: { enabled: true } },
    lastRunStats: {},
    unreadChanges: 0
  });

  if (config.sources?.artp?.enabled !== false) {
    await checkARTPNews(seen, guidance, changes, pageHashes, config);
  } else {
    console.log('ARTP source is disabled, skipping');
  }

  config.lastRunStats = config.lastRunStats || {};
  config.lastRunStats.htmlPoller = new Date().toISOString();

  writeData('seen.json', seen);
  writeData('guidance.json', guidance);
  writeData('changes.json', changes);
  writeData('page-hashes.json', pageHashes);
  writeData('config.json', config);

  console.log('HTML Poller complete');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
