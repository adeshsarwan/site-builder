// What the scheduled refresh fetches. Each (country × category) is one "bucket" stored in Firestore.
// Requests per refresh = countries × categories × PAGES_PER_BUCKET (each page = 1 JSearch request, 10 jobs).

export const COUNTRIES = {
  us: { name: 'USA', label: 'United States' },
  ca: { name: 'Canada', label: 'Canada' },
  au: { name: 'Australia', label: 'Australia' },
  gb: { name: 'United Kingdom', label: 'United Kingdom' },
};

// `query` is the JSearch search phrase; `remote` forces work_from_home=true.
export const CATEGORIES = {
  remote: { label: 'Remote jobs', query: 'remote jobs', remote: true },
  healthcare: { label: 'Healthcare', query: 'healthcare jobs' },
  tech: { label: 'Tech & IT', query: 'software developer IT jobs' },
  sales: { label: 'Sales & customer service', query: 'sales customer service jobs' },
  office: { label: 'Office & admin', query: 'administrative assistant office jobs' },
  trades: { label: 'Warehouse, driving & trades', query: 'warehouse driver technician jobs' },
  finance: { label: 'Finance & accounting', query: 'accounting finance jobs' },
  education: { label: 'Education', query: 'teacher education jobs' },
};

export const ALIASES = { uk: 'gb', usa: 'us', any: null, all: null };
