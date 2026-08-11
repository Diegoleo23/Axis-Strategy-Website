// Sends a Mailchimp campaign for every feed.xml item not yet recorded in
// .mailchimp-sent.json. Run by .github/workflows/send-rss-campaign.yml
// whenever feed.xml changes on main. Mailchimp's plan on this account has
// no native RSS-driven automation, so this replaces that feature by
// calling the regular Campaigns API directly.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const LIST_ID = '0c6f1c1fb8';
const FEED_PATH = 'feed.xml';
const STATE_PATH = '.mailchimp-sent.json';
const TEMPLATE_PATH = 'email-templates/new-article-rss-automation.html';
const DRY_RUN_DIR = 'dry-run-output';

const DRY_RUN = process.env.DRY_RUN === 'true';

const apiKey = DRY_RUN ? null : requireEnv('MAILCHIMP_API_KEY');
const fromEmail = DRY_RUN ? null : requireEnv('MAILCHIMP_FROM_EMAIL');
const fromName = process.env.MAILCHIMP_FROM_NAME || 'The Strategy Lens';

const dc = apiKey ? apiKey.split('-').pop() : null;
const apiBase = dc ? `https://${dc}.api.mailchimp.com/3.0` : null;
const authHeader = apiKey ? 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64') : null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseFeedItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
    const guid = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]?.trim();
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
    const description = block
      .match(/<description>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/description>/)?.[1]
      ?.trim();
    const image = block.match(/<enclosure[^>]*url="([^"]*)"/)?.[1];
    if (title && link && guid) {
      items.push({ title, link, guid, pubDate, description: description || '', image });
    }
  }
  return items;
}

function formatMonthYear(pubDate) {
  const date = pubDate ? new Date(pubDate) : new Date();
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function renderCampaignHtml(template, item) {
  return template
    .replace(/\*\|RSS:ITEMS:START\|\*/g, '')
    .replace(/\*\|RSS:ITEMS:END\|\*/g, '')
    .replace(/\*\|RSS:ITEM:URL\|\*/g, item.link)
    .replace(/\*\|RSS:ITEM:IMAGE:SRC\|\*/g, item.image || '')
    .replace(/\*\|RSS:ITEM:TITLE\|\*/g, escapeHtml(item.title))
    .replace(/\*\|RSS:ITEM:PUBDATE:%B %Y\|\*/g, formatMonthYear(item.pubDate))
    .replace(/\*\|RSS:ITEM:CONTENT\|\*/g, escapeHtml(item.description));
}

async function mailchimp(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mailchimp ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

async function sendCampaignForItem(item, template) {
  const subject = `New essay: ${item.title}`;
  const html = renderCampaignHtml(template, item);

  if (DRY_RUN) {
    mkdirSync(DRY_RUN_DIR, { recursive: true });
    const outPath = `${DRY_RUN_DIR}/${item.guid.replace(/[^a-z0-9]+/gi, '-')}.html`;
    writeFileSync(outPath, html);
    console.log(`[DRY RUN] Would send campaign for: ${item.title}`);
    console.log(`[DRY RUN]   subject: ${subject}`);
    console.log(`[DRY RUN]   rendered HTML written to ${outPath} (open it in a browser to preview)`);
    console.log('[DRY RUN]   no Mailchimp API calls made, no subscribers emailed.');
    return;
  }

  console.log(`Creating campaign for: ${item.title}`);

  const campaign = await mailchimp('/campaigns', {
    method: 'POST',
    body: JSON.stringify({
      type: 'regular',
      recipients: { list_id: LIST_ID },
      settings: {
        subject_line: subject,
        preview_text: item.description.slice(0, 120),
        title: `Auto RSS - ${item.title} - ${item.guid}`,
        from_name: fromName,
        reply_to: fromEmail,
      },
    }),
  });

  await mailchimp(`/campaigns/${campaign.id}/content`, {
    method: 'PUT',
    body: JSON.stringify({ html }),
  });

  await mailchimp(`/campaigns/${campaign.id}/actions/send`, { method: 'POST' });

  console.log(`Sent campaign ${campaign.id} for: ${item.title}`);
}

async function main() {
  const feedXml = readFileSync(FEED_PATH, 'utf8');
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const items = parseFeedItems(feedXml);

  const state = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    : { sentGuids: [] };
  const sentGuids = new Set(state.sentGuids);

  const unsent = items.filter((item) => !sentGuids.has(item.guid));
  if (unsent.length === 0) {
    console.log('No new feed items to send.');
    return;
  }

  // Send oldest-first so subscribers get campaigns in publish order.
  unsent.reverse();

  for (const item of unsent) {
    await sendCampaignForItem(item, template);
    if (!DRY_RUN) {
      sentGuids.add(item.guid);
      writeFileSync(STATE_PATH, JSON.stringify({ sentGuids: [...sentGuids] }, null, 2) + '\n');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
