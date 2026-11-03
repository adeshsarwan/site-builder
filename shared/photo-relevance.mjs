// Photo relevance for article hero images. Used by the Launch API (Worker) and by
// apps/web/scripts/fill-images.mjs (deploy-time photo filler), so both pick photos the same way.
//
// Pixabay matches on tags, so literal title words ("Radio Silence", "Stop Applying Twice",
// "Earn Credibility") pull in microphones, stop signs and Scottish lochs. A hit is accepted only
// when its tags look like work and nothing in them looks off-topic.

export const CATEGORY_QUERY = {
  'interview-prep': 'job interview',
  'resume-cover-letters': 'resume writing desk',
  'job-search-strategy': 'job search laptop',
  'salary-negotiation': 'business meeting handshake',
  'workplace-success': 'office teamwork',
  'career-change-growth': 'career planning notebook',
};

/** Generic work scenes tried after the story's own query and its category query. */
export const GENERIC_QUERIES = ['people working office', 'business meeting', 'laptop desk work'];

export const WORK_WORDS = new Set((
  'office business work working worker workplace workspace workstation coworking desk laptop computer meeting interview ' +
  'team teamwork colleague colleagues coworkers businessman businesswoman businesspeople job jobs career resume cv application ' +
  'conference presentation notebook document documents paper paperwork writing handshake professional employee employees manager ' +
  'boss startup entrepreneur video call phone smartphone calendar planning planner finance financial salary contract agreement ' +
  'signing pen keyboard typing seminar training education learning study student teacher classroom nurse hospital doctor ' +
  'healthcare medical accountant accounting calculator chart graph data analytics coding programming developer code designer ' +
  'design whiteboard brainstorming discussion conversation communication negotiation deal strategy marketing sales money ' +
  'portfolio report checklist schedule headset monitor screen tablet corporate company executive leadership mentor coaching ' +
  'recruitment hiring hr'
).split(' '));

export const OFF_TOPIC_WORDS = new Set((
  'animal animals dog puppy cat kitten bird birds wildlife leopard wildcat frog pig lapphund snipe horse fish insect ' +
  'food cooking kitchen dining meal fruit vegetable avocado dumplings ingredients produce appetizer cilantro knife chopping ' +
  'nature landscape mountain mountains mountainous sunset sunrise sky cloud clouds rainbow rain flower flowers floral spring tree ' +
  'forest sea ocean beach lake loch desert dunes sahara river waterfall space nebula galaxy messier ngc religion easter cross ' +
  'thorns church angel statue christmas car race rally bike bicycle trail sport athlete running exercise fitness makeup cosmetics ' +
  'lipstick wallpaper virus corona covid distancing music piano guitar microphone radio opera concert wine beer party wedding baby ' +
  'toy cartoon fantasy bitcoin cryptocurrency crypto cogwheel gear engine macro soap washing agriculture irrigation sprinklers farm ' +
  'countryside nepal scotland vienna traffic road sign facebook twitter instagram wordpress hotel receptionists evil invitation historical'
).split(' '));

const STOP = new Set('a an and the to of for in on with without from your you how what when why is are do does it its this that vs into at by as be can should'.split(' '));
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);

/** Higher is better: +2 per work tag word, −6 per off-topic word, +1 per word shared with the search query. */
export function photoScore(tags, query = '') {
  const w = new Set(words(tags));
  let score = 0;
  for (const x of w) { if (WORK_WORDS.has(x)) score += 2; if (OFF_TOPIC_WORDS.has(x)) score -= 6; }
  for (const x of new Set(words(query))) if (w.has(x) && !STOP.has(x)) score += 1;
  return score;
}

/** At least one work tag and no off-topic tag. */
export const MIN_PHOTO_SCORE = 2;

/** True when a stored photo's tags (its heroAlt) don't look like work. An empty alt is unknown → false. */
export const looksOffTopic = (alt) => Boolean(String(alt ?? '').trim()) && photoScore(alt) < MIN_PHOTO_SCORE;

/** Search phrases, most to least specific. Title words are never used on their own (they are often metaphors). */
export function imageQueries(primary, categorySlug) {
  return [...new Set([primary, CATEGORY_QUERY[categorySlug], ...GENERIC_QUERIES].map((x) => String(x ?? '').trim()).filter(Boolean))];
}

/** Best relevant hit among Pixabay results (`tags` is Pixabay's comma list); Pixabay's own order breaks ties. */
export function bestHit(hits, query, isUsed = () => false) {
  return hits
    .map((h, i) => ({ h, i, s: photoScore(h.tags, query) }))
    .filter((x) => x.s >= MIN_PHOTO_SCORE && !isUsed(x.h))
    .sort((a, b) => b.s - a.s || a.i - b.i)[0]?.h ?? null;
}
