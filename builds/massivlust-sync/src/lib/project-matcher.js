import { supabase } from '../supabase.js';

let _projects = null;
let _lastFetch = 0;

async function getProjects() {
  if (_projects && Date.now() - _lastFetch < 5 * 60 * 1000) return _projects;
  const { data } = await supabase
    .from('massivlust_projects')
    .select('id, name, customer, address')
    .eq('org_id', 'massivlust');
  _projects = data || [];
  _lastFetch = Date.now();
  return _projects;
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-zæøå0-9]/g, ' ').trim();
}

export async function matchProject(text) {
  const projects = await getProjects();
  const input = normalize(text);
  if (!input) return { project_id: null, confidence: 0, auto_classified: false };

  let best = null;
  let bestScore = 0;

  for (const p of projects) {
    const keywords = [p.name, p.customer]
      .filter(Boolean)
      .map(normalize);

    if (p.address) {
      const addr = normalize(p.address);
      keywords.push(addr);
      for (const part of p.address.split(/[,\s]+/).filter(Boolean)) {
        const np = normalize(part);
        if (np.length >= 4) keywords.push(np);
      }
    }

    let score = 0;
    for (const kw of keywords) {
      if (!kw) continue;
      if (input.includes(kw)) score += kw.length;
      else {
        const words = kw.split(/\s+/);
        for (const w of words) {
          if (w.length >= 3 && input.includes(w)) score += w.length * 0.5;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  const confidence = Math.min(bestScore / 10, 1);
  if (confidence < 0.3) return { project_id: null, confidence: 0, auto_classified: false };

  return {
    project_id: best.id,
    confidence: Math.round(confidence * 100) / 100,
    auto_classified: true,
  };
}
