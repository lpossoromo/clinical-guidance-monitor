'use strict';

// Clinical Guidance Monitor — RSS + Content Poller
// Runs on GitHub Actions every 6 hours
// Monitors NICE (scraping), NCL (RSS), and NHS England (RSS)
// Saves all data as JSON files in the data/ directory

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(process.cwd(), 'data');

const PRIMARY_CARE_KEYWORDS = [
  'diabetes', 'hypertension', 'ckd', 'chronic kidney', 'cardiovascular',
  'lipids', 'cholesterol', 'respiratory', 'asthma', 'copd',
  'mental health', 'depression', 'anxiety', 'infection', 'antibiotic',
  'contraception', 'thyroid', 'anticoagulation', 'warfarin',
  'cancer screening', 'cervical', 'bowel screening', 'breast screening',
  'heart failure', 'atrial fibrillation', 'stroke', 'obesity',
  'dementia', 'osteoporosis', 'primary care'
];

// Keywords used to include/exclude articles for NCL and NHS sources
// (NICE uses PRIMARY_CARE_KEYWORDS above; these apply to RSS feeds)
// Config-sourced values take precedence; these are fallbacks for NCL.

const PA_INCLUDE_KEYWORDS = [
  'guideline', 'guidance', 'pathway', 'protocol', 'recommendation',
  'clinical', 'diagnosis', 'treatment', 'management', 'referral',
  'screening', 'monitoring', 'alert', 'safety', 'update', 'bulletin', 'reminder',
  'diabetes', 'hypertension', 'ckd', 'chronic kidney', 'cardiovascular',
  'lipids', 'cholesterol', 'respiratory', 'asthma', 'copd',
  'mental health', 'depression', 'anxiety', 'infection', 'antibiotic',
  'contraception', 'thyroid', 'anticoagulation', 'warfarin',
  'cancer', 'heart failure', 'atrial fibrillation', 'stroke', 'obesity',
  'dementia', 'osteoporosis', 'metabolic', 'musculoskeletal',
  'arthritis', 'gout', 'eczema', 'dermatology', 'epilepsy',
  'patient', 'primary care', 'gp '
];

const PA_EXCLUDE_KEYWORDS = [
  'student training', 'sample container', 'proficiency testing',
  'external quality', 'practice manager', 'practice vacancy',
  'job vacancy', 'phlebotomy training', 'gpit', 'it support',
  'protected learning time', 'webinar registration', 'training event',
  'training course', 'staff survey', 'practice administrator',
  'workforce planning', 'greener nhs', 'carbon footprint',
  'information governance', 'systems & facilitation', 'buying group',
  'digital innovation', 'practice vacancies', 'research opportunities',
  'ambulance', 'handover', 'waiting list',
  'medicines supply', 'supply notification', 'medicines shortage'
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

function extractContent(html, source) {
  let content = '';
  let chapterLinks = [];

  const patternSets = {
    nice: [
      /<div[^>]*class="[^"]*chapter[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:div|footer|nav)/i,
      /<div[^>]*id="content"[^>]*>([\s\S]*?)<\/div>\s*<(?:div|footer|nav)/i,
      /<main[^>]*>([\s\S]*?)<\/main>/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i
    ],
    ncl: [
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:div|footer|nav)/i,
      /<main[^>]*>([\s\S]*?)<\/main>/i
    ],
    nhs: [
      /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:div|footer|nav)/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<main[^>]*>([\s\S]*?)<\/main>/i
    ]
  };

  const patterns = patternSets[source] || patternSets.nhs;

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1].length > 100) {
      content = cleanHTML(match[1]);
      break;
    }
  }

  if (!content) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    content = bodyMatch ? cleanHTML(bodyMatch[1]) : cleanHTML(html);
  }

  // For NICE, extract chapter links for recursive crawling
  if (source === 'nice') {
    const chapterPattern = /<a[^>]*href="(\/guidance\/[^\/]+\/chapter\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const chapterMatches = [...html.matchAll(chapterPattern)];
    const seenUrls = new Set();

    for (const match of chapterMatches) {
      const chapterUrl = 'https://www.nice.org.uk' + match[1];
      if (seenUrls.has(chapterUrl)) continue;
      seenUrls.add(chapterUrl);

      const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (title) chapterLinks.push({ url: chapterUrl, title });
    }
  }

  return { content, chapterLinks };
}

// ── Crawl a page and store its content ────────────────────────────────────────

async function crawlAndStore(url, source, type, metadata, guidance, changes, config, crawlDepth = 0, maxDepth = 0, parentUrl = null) {
  console.log(`  Crawling [${source}] ${url}`);

  let html;
  try {
    html = await fetchPage(url);
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return;
  }

  const { content, chapterLinks } = extractContent(html, source);
  const title = metadata?.title || extractTitle(html);

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
    console.log(`  No changes: ${title}`);
    return;
  }

  const now = new Date().toISOString();
  const wordCount = content.split(/\s+/).length;

  guidance[storageKey] = {
    id: storageKey,
    url,
    title,
    source,
    type: type || 'article',
    publishedDate: metadata?.publishedDate || parsePublishedDate(html) || now.split('T')[0],
    fetchedDate: now,
    contentHash,
    content,
    parentUrl: parentUrl || null,
    metadata: {
      wordCount,
      estimatedReadTime: Math.ceil(wordCount / 250),
      description: metadata?.description || content.substring(0, 200)
    }
  };

  const changeType = isNew ? 'new_guidance' : 'content_update';
  const changeKey = `change:${Date.now()}:${urlHash}`;

  changes[changeKey] = {
    id: changeKey,
    url,
    title,
    source,
    changeType,
    detectedAt: now,
    previousHash: existing?.contentHash || null,
    newHash: contentHash,
    acknowledged: false
  };

  config.unreadChanges = (config.unreadChanges || 0) + 1;
  console.log(`  Stored ${changeType}: "${title}" (${wordCount} words)`);

  // For NICE guidelines, crawl chapters too
  if (source === 'nice' && crawlDepth < maxDepth && chapterLinks.length > 0) {
    console.log(`  Crawling ${chapterLinks.length} chapters for "${title}"...`);
    for (const chapter of chapterLinks) {
      await crawlAndStore(
        chapter.url, 'nice', 'chapter',
        { title: `${title} — ${chapter.title}` },
        guidance, changes, config,
        crawlDepth + 1, maxDepth, url
      );
      await sleep(500);
    }
  }
}

// ── NICE: Scrape published guidance page ───────────────────────────────────────

async function fetchNICEGuidance(seen, guidance, changes, config) {
  console.log('Fetching NICE published guidance...');

  let html;
  try {
    html = await fetchPage('https://www.nice.org.uk/guidance/published?ngt=Guidelines&ps=50');
  } catch (err) {
    console.error('NICE fetch failed:', err.message);
    return 0;
  }

  const keywords = config.sources?.nice?.keywords || PRIMARY_CARE_KEYWORDS;
  const guidancePattern = /<a[^>]*href="(\/guidance\/(?:ng|cg|ph|qs|ta|dg|ipg|hst|es|mtg)\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...html.matchAll(guidancePattern)];
  const seenUrls = new Set();
  let count = 0;

  for (const match of matches) {
    const path = match[1];
    if (seenUrls.has(path)) continue;
    seenUrls.add(path);

    const guidanceUrl = 'https://www.nice.org.uk' + path;
    const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title) continue;

    const titleLower = title.toLowerCase();
    if (keywords.length > 0 && !keywords.some(kw => titleLower.includes(kw.toLowerCase()))) continue;

    const hash = hashString(guidanceUrl);
    const seenKey = `nice:${hash}`;
    if (seen[seenKey]) continue;

    seen[seenKey] = {
      url: guidanceUrl,
      title,
      discovered: new Date().toISOString(),
      source: 'nice'
    };

    console.log(`NICE: Found "${title}"`);
    await crawlAndStore(guidanceUrl, 'nice', 'guidance', { title }, guidance, changes, config, 0, 1);
    count++;
    await sleep(1000);
  }

  return count;
}

// ── RSS: NCL and NHS England ───────────────────────────────────────────────────

async function fetchRSSSource(url, source, seen, guidance, changes, config) {
  console.log(`Fetching ${source.toUpperCase()} RSS from ${url}...`);

  let xml;
  try {
    xml = await fetchPage(url);
  } catch (err) {
    console.error(`${source.toUpperCase()} RSS fetch failed:`, err.message);
    return 0;
  }

  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  const items = [...xml.matchAll(itemPattern)];

  const includeKeywords = config.sources?.[source]?.keywords || PA_INCLUDE_KEYWORDS;
  const excludeKeywords = config.sources?.[source]?.excludeKeywords || PA_EXCLUDE_KEYWORDS;
  // rssOnly: store the RSS description directly without fetching the full article page.
  // Used for NCL because the website's JS-based browser check corrupts scraped content.
  const rssOnly = config.sources?.[source]?.rssOnly === true;

  let count = 0;

  for (const itemMatch of items) {
    const itemXml = itemMatch[1];

    const titleMatch = itemXml.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)
      || itemXml.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
    const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const descMatch = itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i)
      || itemXml.match(/<description>([\s\S]*?)<\/description>/i);

    const title = (titleMatch?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const link = (linkMatch?.[1] || '').trim();
    const pubDate = pubDateMatch?.[1]?.trim() || null;
    const description = (descMatch?.[1] || '').replace(/<[^>]+>/g, '').trim();

    if (!title || !link) continue;

    // PA relevance filtering — check title and description against exclude/include lists
    const textToCheck = (title + ' ' + description).toLowerCase();
    if (excludeKeywords.some(kw => textToCheck.includes(kw.toLowerCase()))) {
      console.log(`  ${source.toUpperCase()}: Skipping (excluded) "${title}"`);
      continue;
    }
    if (includeKeywords.length > 0 && !includeKeywords.some(kw => textToCheck.includes(kw.toLowerCase()))) {
      console.log(`  ${source.toUpperCase()}: Skipping (no PA keyword match) "${title}"`);
      continue;
    }

    const hash = hashString(link);
    const seenKey = `${source}:${hash}`;
    if (seen[seenKey]) continue;

    seen[seenKey] = {
      url: link,
      title,
      description: description.substring(0, 500),
      discovered: new Date().toISOString(),
      publishedDate: pubDate,
      source
    };

    console.log(`${source.toUpperCase()}: Found "${title}"`);

    if (rssOnly) {
      // Store the RSS description directly — skip fetching the full article page
      const storageKey = `content:${hash}`;
      const content = description || title;
      const contentHash = hashString(content);
      const existing = guidance[storageKey];
      const isNew = !existing;
      const hasChanged = existing && existing.contentHash !== contentHash;

      if (isNew || hasChanged) {
        const now = new Date().toISOString();
        const wordCount = content.split(/\s+/).length;

        guidance[storageKey] = {
          id: storageKey,
          url: link,
          title,
          source,
          type: 'article',
          publishedDate: pubDate ? new Date(pubDate).toISOString().split('T')[0] : now.split('T')[0],
          fetchedDate: now,
          contentHash,
          content,
          parentUrl: null,
          metadata: {
            wordCount,
            estimatedReadTime: Math.max(1, Math.ceil(wordCount / 250)),
            description: content.substring(0, 200)
          }
        };

        const changeKey = `change:${Date.now()}:${hash}`;
        changes[changeKey] = {
          id: changeKey,
          url: link,
          title,
          source,
          changeType: isNew ? 'new_guidance' : 'content_update',
          detectedAt: now,
          previousHash: existing?.contentHash || null,
          newHash: contentHash,
          acknowledged: false
        };

        config.unreadChanges = (config.unreadChanges || 0) + 1;
        console.log(`  Stored RSS-only ${isNew ? 'new_guidance' : 'content_update'}: "${title}"`);
        count++;
      } else {
        console.log(`  No changes: ${title}`);
      }
    } else {
      await crawlAndStore(
        link, source, 'article',
        { title, description: description.substring(0, 500), publishedDate: pubDate },
        guidance, changes, config
      );
      count++;
      await sleep(500);
    }
  }

  return count;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('RSS Poller starting at', new Date().toISOString());

  const seen = readData('seen.json', {});
  const guidance = readData('guidance.json', {});
  const changes = readData('changes.json', {});
  const config = readData('config.json', {
    sources: {
      nice: { enabled: true, keywords: PRIMARY_CARE_KEYWORDS },
      ncl: { enabled: true },
      nhs: { enabled: true },
      artp: { enabled: true }
    },
    lastRunStats: {},
    unreadChanges: 0
  });

  const results = { nice: 0, ncl: 0, nhs: 0 };

  if (config.sources?.nice?.enabled !== false) {
    results.nice = await fetchNICEGuidance(seen, guidance, changes, config);
  }

  if (config.sources?.ncl?.enabled !== false) {
    results.ncl = await fetchRSSSource(
      'https://gps.northcentrallondon.icb.nhs.uk/news/rss',
      'ncl', seen, guidance, changes, config
    );
  }

  if (config.sources?.nhs?.enabled !== false) {
    results.nhs = await fetchRSSSource(
      'https://www.england.nhs.uk/feed/',
      'nhs', seen, guidance, changes, config
    );
  }

  config.lastRunStats = config.lastRunStats || {};
  config.lastRunStats.rssPoller = new Date().toISOString();
  config.lastRunStats.rssPollerResults = {
    nice: results.nice,
    ncl: results.ncl,
    nhs: results.nhs,
    total: results.nice + results.ncl + results.nhs
  };

  writeData('seen.json', seen);
  writeData('guidance.json', guidance);
  writeData('changes.json', changes);
  writeData('config.json', config);

  const total = results.nice + results.ncl + results.nhs;
  console.log(`RSS Poller complete. Found ${total} new items (NICE: ${results.nice}, NCL: ${results.ncl}, NHS: ${results.nhs})`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
