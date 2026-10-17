/**
 * KNOWLEDGE BASE IN BIGQUERY (ADAPTER_MODE=bigquery).
 *
 * `kb_documents` holds three kinds of document:
 *   northstar       the curated guidance articles (same content as KB_ARTICLES)
 *   northstar_info  bank information: branches, hours, products, how-tos
 *   bitext          answers from the Bitext retail-banking customer-support dataset (CDLA-Sharing-1.0),
 *                   with placeholders filled in for Northstar Bank
 * `kb_embeddings` holds a Vertex AI text embedding per document, made inside BigQuery with
 * ML.GENERATE_EMBEDDING. A question is embedded the same way and matched with VECTOR_SEARCH.
 *
 * Guidance for the call's own issue keeps the mock's deterministic scoring over the curated
 * articles, so the workflows get the same guidance either way. General questions go to vector
 * search. If BigQuery or the embedding model is unavailable, keyword search runs instead, and if
 * that fails too the built-in knowledge base answers. Nothing here permits any action.
 */
import { log } from '../lib/logger.ts';
import { bigQuery, bqConfig, T } from '../adapters/bigquery/client.ts';
import { KB_ARTICLES, mockKnowledgeBase, setKnowledgeBase, type KbArticle, type KbResult, type KnowledgeBaseAdapter } from './kb.ts';
import { INFO_ARTICLES, answerFromInfo, searchBankInfo } from './bank-info.ts';

interface DocRow { doc_id: string; source: string; title: string; content: string; categories: string[] | null; keywords: string[] | null; steps: string[] | null; rule_refs: string[] | null; version: string | null; distance?: number; hits?: number }

const CACHE_MS = 5 * 60_000;
const SEARCH_TIMEOUT_MS = 6000;
let curated: { at: number; list: KbArticle[] } | null = null;
const seen = new Map<string, KbArticle>();

const toArticle = (r: DocRow): KbArticle => ({
  id: r.doc_id,
  title: r.title,
  categories: r.categories ?? [],
  keywords: r.keywords ?? [],
  excerpt: r.content.length > 700 ? `${r.content.slice(0, 700).replace(/\s+\S*$/, '')}…` : r.content,
  steps: r.steps ?? [],
  ruleRefs: r.rule_refs ?? [],
  version: r.version ?? '',
  synthetic: true,
});

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('knowledge search timed out')), ms).unref())]);

async function curatedArticles(): Promise<KbArticle[]> {
  if (curated && Date.now() - curated.at < CACHE_MS) return curated.list;
  try {
    const c = bigQuery();
    const rows = await withTimeout(c.query<DocRow>(`SELECT doc_id, source, title, content, categories, keywords, steps, rule_refs, version FROM ${T(c, 'kb_documents')} WHERE source = 'northstar'`), SEARCH_TIMEOUT_MS);
    const list = rows.length ? rows.map(toArticle) : KB_ARTICLES;
    for (const a of list) seen.set(a.id, a);
    curated = { at: Date.now(), list };
  } catch (e) {
    log.warn('knowledge base: curated articles not read from BigQuery, using built-in copy', { error: (e as Error).message });
    curated = { at: Date.now() - CACHE_MS + 30_000, list: KB_ARTICLES };
  }
  return curated.list;
}

/** Same deterministic scoring as the mock knowledge base, over the curated articles. */
function scoreCurated(list: KbArticle[], issueType: string | null, text: string, context: string[]): KbResult[] {
  const t = `${text} ${context.join(' ')}`.toLowerCase();
  return list
    .map((a) => {
      let score = 0;
      const why: string[] = [];
      if (issueType && a.categories.includes(issueType)) { score += 3; why.push('matches the call’s issue type'); }
      for (const c of context) if (a.categories.includes(c)) { score += 2; why.push(`matches “${c.replace(/_/g, ' ')}”`); }
      const hits = a.keywords.filter((k) => t.includes(k));
      if (hits.length) { score += hits.length * 0.5; why.push(`mentions ${hits.slice(0, 3).join(', ')}`); }
      return { article: a, score, reason: why.join('; ') };
    })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'can', 'how', 'what', 'with', 'about', 'have', 'does', 'this', 'that', 'there', 'are', 'is', 'my', 'do', 'to', 'of', 'in', 'on', 'a', 'an', 'i', 'it', 'me', 'please', 'want', 'need']);

/** Semantic search (Vertex AI embeddings + VECTOR_SEARCH), falling back to keyword search. */
async function searchDocuments(text: string): Promise<KbResult[]> {
  const c = bigQuery();
  const { embeddingModel, project } = bqConfig();
  if (embeddingModel) {
    try {
      const rows = await withTimeout(c.query<DocRow>(
        `SELECT base.doc_id, base.source, base.title, base.content, base.categories, base.keywords, base.steps, base.rule_refs, base.version, distance
         FROM VECTOR_SEARCH(TABLE ${T(c, 'kb_embeddings')}, 'embedding',
           (SELECT ml_generate_embedding_result AS embedding
            FROM ML.GENERATE_EMBEDDING(MODEL \`${project}.${embeddingModel}\`, (SELECT @q AS content), STRUCT('RETRIEVAL_QUERY' AS task_type, TRUE AS flatten_json_output))),
           top_k => 4, distance_type => 'COSINE')
         WHERE base.source != 'northstar' AND distance < 0.55 ORDER BY distance LIMIT 2`, { q: text.slice(0, 500) }), SEARCH_TIMEOUT_MS);
      return rows.map((r) => ({ article: remember(r), score: Math.round((1 - (r.distance ?? 1)) * 100) / 10, reason: `meaning match in the bank knowledge base (BigQuery vector search, distance ${(r.distance ?? 0).toFixed(2)})` }));
    } catch (e) {
      log.warn('knowledge base: vector search unavailable, using keyword search', { error: (e as Error).message });
    }
  }
  const words = [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 8);
  if (!words.length) return [];
  const rows = await withTimeout(c.query<DocRow>(
    `SELECT * FROM (
       SELECT doc_id, source, title, content, categories, keywords, steps, rule_refs, version,
              (SELECT COUNTIF(STRPOS(LOWER(CONCAT(title, ' ', content)), w) > 0) FROM UNNEST(SPLIT(@words, ',')) AS w) AS hits
       FROM ${T(c, 'kb_documents')} WHERE source != 'northstar')
     WHERE hits >= ${Math.min(2, words.length)} ORDER BY hits DESC, source LIMIT 2`, { words: words.join(',') }), SEARCH_TIMEOUT_MS);
  return rows.map((r) => ({ article: remember(r), score: Number(r.hits ?? 0), reason: `keyword match in the bank knowledge base (BigQuery, ${r.hits} words)` }));
}

function remember(r: DocRow): KbArticle {
  const a = toArticle(r);
  // Bank information has exact local answers (a branch's hours, say); prefer them when they match.
  if (r.source === 'northstar_info') {
    const local = INFO_ARTICLES.find((x) => x.id === r.doc_id);
    if (local) return local;
  }
  seen.set(a.id, a);
  return a;
}

export const bigQueryKnowledgeBase: KnowledgeBaseAdapter = {
  get name() {
    const { project, dataset } = bqConfig();
    return `BigQuery ${project}.${dataset} (curated guidance, bank information, Bitext banking FAQ)`;
  },
  async search({ issueType, text, context }) {
    try {
      const out = scoreCurated(await curatedArticles(), issueType, text, context);
      if (out.length || !text.trim()) return out;
      // A general question: exact bank information first (branches, hours), then the document search.
      const info = searchBankInfo(text);
      if (info) {
        const art = INFO_ARTICLES.find((a) => a.id === info.id)!;
        const full = answerFromInfo(text);
        return [{ article: full ? { ...art, excerpt: full.reply } : art, score: 3, reason: 'general bank information' }];
      }
      return await searchDocuments(text);
    } catch (e) {
      log.warn('knowledge base: BigQuery search failed, using built-in knowledge base', { error: (e as Error).message });
      return mockKnowledgeBase.search({ issueType, text, context });
    }
  },
  get: (id) => seen.get(id) ?? mockKnowledgeBase.get(id),
};

export function useBigQueryKnowledgeBase(): void {
  setKnowledgeBase(bigQueryKnowledgeBase);
}
