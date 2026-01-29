# Custom Knowledge Graph Extraction Pipeline

A lightweight, high-performance knowledge graph extraction system using LLMs with structured output and hybrid entity resolution. Designed as a practical alternative to heavier frameworks like Microsoft GraphRAG or LightRAG.

## Background & Motivation

### Why Not Use Existing Solutions?

**LightRAG** [1]: We initially used LightRAG but found it produced sparse results:
- ~400 entities / ~200 edges from 200 full-PDF articles (~2 entities/article)
- No entity resolution: "AI", "artificial intelligence", "Artificial Intelligence" appeared as separate nodes
- NetworkX-based storage doesn't scale well

**Microsoft GraphRAG** [2]: Comprehensive but expensive ($50-100+ per corpus) and complex infrastructure requirements.

**KGGen** [3]: Promising NeurIPS 2025 paper with entity clustering, but very new library. We adopted its key insight: **entity resolution is critical** for quality knowledge graphs.

### Our Approach

A custom pipeline that:
- Extracts 20-50 entities per article (10-25x improvement over LightRAG)
- Properly deduplicates entities via hybrid resolution (embedding + LLM)
- Uses existing infrastructure (PostgreSQL + pgvector, no Neo4j required)
- Costs ~$1.60 per 200 articles (vs $50-100+ for GraphRAG)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        KG Service (Orchestrator)                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Article Text ──► Chunker ──► Extractor ──► Resolver ──► Storage    │
│                    (512 tok)   (parallel)   (EntityEngram)  (PG)    │
│                                    │              │                  │
│                              ChunkExtraction   Entity IDs           │
│                              (entities, rels)  + Relationships      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

#### 1. Extractor (`extractor.py`)

LLM-based entity and relationship extraction using structured output.

```python
class ExtractedEntity(BaseModel):
    name: str
    entity_type: Literal[
        "PERSON", "ORGANIZATION", "CONCEPT", "TECHNOLOGY",
        "METHODOLOGY", "DATASET", "MEDICAL_CONDITION", "REGULATION"
    ]
    description: str

class ExtractedRelationship(BaseModel):
    source: str      # Must match an entity name
    target: str      # Must match an entity name
    relationship: str  # Active verb: "develops", "evaluates", "regulates"
    description: str

class ChunkExtraction(BaseModel):
    entities: list[ExtractedEntity]      # Target: 10-30 per chunk
    relationships: list[ExtractedRelationship]
```

**Key features:**
- Uses `with_structured_output()` for reliable JSON parsing
- Validates that relationship sources/targets reference extracted entities
- Parallel extraction via `extract_batch()` with semaphore control

**Prompt design tips:**
- Instruct the LLM to extract 10-30 entities per chunk (be specific)
- Define entity types with examples from your domain
- Require active verbs for relationships ("develops", not "development")
- Include domain-specific guidance (e.g., "healthcare AI ethics")

#### 2. Resolver (`resolver.py`)

Hybrid entity resolution combining fast lookups with LLM verification.

```python
class EntityEngram:
    """In-memory index for O(1) lookups and fast similarity search."""

    _by_name: dict[str, Entity]      # lowercase name → entity
    _by_alias: dict[str, Entity]     # lowercase alias → entity
    _matrix: np.ndarray              # (N, 1536) embedding matrix

    def find_by_name(self, name: str) -> Entity | None: ...
    def find_by_alias(self, name: str) -> Entity | None: ...
    def find_similar(self, embedding, threshold, entity_type) -> Entity | None: ...
    def find_candidates(self, embedding, min_thresh, max_thresh) -> list[Entity]: ...
    def add(self, entity: Entity, embedding: list[float]) -> None: ...
```

**Resolution pipeline (in order):**

1. **Session cache**: Same name already resolved this session → return cached ID
2. **Exact name match**: O(1) hash lookup on `canonical_name.lower()`
3. **Alias match**: O(1) hash lookup on `aliases[].lower()`
4. **High-confidence embedding** (>0.90): Numpy dot product, auto-merge with alias
5. **Ambiguous candidates** (0.80-0.90): Single LLM call to verify match
6. **Create new entity**: If no match found

**Why this order matters:**
- Hash lookups are O(1), embedding search is O(n)
- Most entities resolve via exact/alias match (no API calls)
- LLM verification only for genuinely ambiguous cases (~5-10% of entities)

#### 3. Storage (`storage.py`)

PostgreSQL with pgvector for entity embeddings.

```sql
-- Canonical entities with embeddings for deduplication
CREATE TABLE kg_entities (
    id SERIAL PRIMARY KEY,
    canonical_name VARCHAR(500) NOT NULL UNIQUE,
    entity_type VARCHAR(50) NOT NULL,
    description TEXT,
    aliases TEXT[],                    -- Alternative names
    embedding VECTOR(1536),            -- For similarity search
    mention_count INTEGER DEFAULT 1,   -- Popularity metric
    created_at TIMESTAMP DEFAULT NOW()
);

-- Relationships between entities
CREATE TABLE kg_relationships (
    id SERIAL PRIMARY KEY,
    source_entity_id INTEGER REFERENCES kg_entities(id) ON DELETE CASCADE,
    target_entity_id INTEGER REFERENCES kg_entities(id) ON DELETE CASCADE,
    relationship_type VARCHAR(100) NOT NULL,
    description TEXT,
    weight FLOAT DEFAULT 1.0,          -- Incremented on duplicates
    source_articles TEXT[],            -- Provenance tracking
    UNIQUE(source_entity_id, target_entity_id, relationship_type)
);

-- Provenance: which article mentioned which entity
CREATE TABLE kg_article_entities (
    id SERIAL PRIMARY KEY,
    article_uid VARCHAR(100) REFERENCES articles(uid) ON DELETE CASCADE,
    entity_id INTEGER REFERENCES kg_entities(id) ON DELETE CASCADE,
    mention_text VARCHAR(500),         -- How it was mentioned
    context TEXT,                      -- Surrounding text
    chunk_index INTEGER                -- Which chunk
);

-- Indexes for performance
CREATE INDEX idx_kg_entities_embedding_hnsw ON kg_entities
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_kg_entities_name_lower ON kg_entities (lower(canonical_name));
```

## Performance Optimizations

### Parallel Chunk Extraction

```python
# Before: 4 chunks × 20s = 80s (serial)
for chunk in chunks:
    extraction = await extractor.extract(chunk)

# After: max(20s × 4) = 20s (parallel)
extractions = await extractor.extract_batch(
    [chunk.content for chunk in chunks],
    max_concurrent=4
)
```

### EntityEngram In-Memory Index

```python
# Before: DB query per entity resolution
result = await db.execute(
    select(Entity).where(func.lower(Entity.name) == name.lower())
)

# After: O(1) hash lookup
entity = engram.find_by_name(name)  # dict lookup
```

### Batch Embedding

```python
# Before: API call per entity
for entity in entities:
    embedding = await embed(entity.name)

# After: Single API call for all
embeddings = await embedder.embed_texts([e.name for e in entities])
```

### Performance Results

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Extraction (4 chunks) | 80s | 20s | 4x |
| Entity resolution | ~2s/entity | ~0.001s/entity | 2000x |
| Total per article | ~92s | ~35s | 2.6x |
| 10 articles | 15 min | 6 min | 2.5x |

## Cost Analysis

For 200 articles with ~20 chunks each (4,000 extraction calls):

| Component | Model | Calls | Cost |
|-----------|-------|-------|------|
| Extraction | GPT-4o-mini | 4,000 | ~$0.80 |
| Embeddings | text-embedding-3-small | ~10,000 | ~$0.50 |
| LLM verification | GPT-4o-mini | ~2,000 | ~$0.30 |
| **Total** | | | **~$1.60** |

Compare to Microsoft GraphRAG: $50-100+ for similar corpus size.

## Frontend Visualization

For rendering large graphs (10K+ nodes), we use PIXI.js WebGL instead of SVG:

| Technology | Node Limit | Notes |
|------------|------------|-------|
| SVG (D3) | ~500 | Animation choppy beyond this |
| Canvas | ~5,000 | Better but still limited |
| WebGL (PIXI.js) | ~50,000 | GPU-accelerated |

**Key implementation details:**
- 2x base text resolution for crisp labels at all zoom levels
- Debounced resolution updates (150ms) for smooth zooming
- Consistent coordinate calculation for node dragging

## Adapting to Other Projects

### Step 1: Define Entity Types

Customize for your domain:

```python
ENTITY_TYPES = Literal[
    "PERSON",           # Researchers, authors, key figures
    "ORGANIZATION",     # Companies, institutions, agencies
    "CONCEPT",          # Abstract ideas, theories
    "TECHNOLOGY",       # Tools, frameworks, systems
    "METHODOLOGY",      # Research methods, approaches
    "DATASET",          # Named datasets
    # Add domain-specific types:
    "MEDICAL_CONDITION",  # For healthcare
    "REGULATION",         # For legal/policy
    "PRODUCT",           # For business
    "LOCATION",          # For geography
]
```

### Step 2: Customize Extraction Prompt

```yaml
# prompts/entity_extraction.yaml
model: gpt-4o-mini
temperature: 0.1
structured_output: ChunkExtraction
system: |
  You are an expert at extracting knowledge graph entities and relationships.

  ## Entity Types
  - PERSON: Named individuals (researchers, executives, public figures)
  - ORGANIZATION: Companies, universities, government agencies
  - CONCEPT: Abstract ideas, theories, principles
  # ... define all types with examples

  ## Guidelines
  - Extract 10-30 entities per chunk
  - Use active verbs for relationships: "develops", "evaluates", "regulates"
  - Include brief descriptions for context
  - [Add domain-specific instructions]

user: |
  Extract entities and relationships from this text:

  {chunk_text}
```

### Step 3: Configure Resolution Thresholds

```python
# Tune based on your domain
HIGH_CONFIDENCE_THRESHOLD = 0.90  # Auto-merge above this
AMBIGUOUS_MIN_THRESHOLD = 0.80    # LLM verify in this range

# More conservative (fewer false merges):
# HIGH = 0.95, MIN = 0.85

# More aggressive (more merging):
# HIGH = 0.85, MIN = 0.75
```

### Step 4: Set Up Database

```sql
-- Run migrations
psql -d your_database -f migrations/001_add_library.sql
psql -d your_database -f migrations/002_add_kg_tables.sql
```

### Step 5: Integrate with Your Pipeline

```python
from knowledge_graph import KGService

kg = KGService()

# Insert a document
result = await kg.insert_article(
    uid="doc-123",
    text="Your document text here..."
)
# Returns: {"entities": 45, "relationships": 32, "chunks": 4}

# Query the graph
data = await kg.get_graph_data(limit=500, min_degree=2)
# Returns: {"nodes": [...], "edges": [...]}
```

## References

[1] **LightRAG**: Guo, Z., et al. (2024). "LightRAG: Simple and Fast Retrieval-Augmented Generation." https://github.com/HKUDS/LightRAG

[2] **Microsoft GraphRAG**: Edge, D., et al. (2024). "From Local to Global: A Graph RAG Approach to Query-Focused Summarization." arXiv:2404.16130. https://github.com/microsoft/graphrag

[3] **KGGen**: Shu, Y., et al. (2025). "KGGen: Extracting Knowledge Graphs from Plain Text with Language Models." NeurIPS 2025. arXiv:2502.09956. https://github.com/stair-lab/kggen

[4] **Neo4j GraphRAG Python**: Neo4j, Inc. (2024). "Neo4j GraphRAG Package for Python." https://neo4j.com/docs/neo4j-graphrag-python/current/

[5] **pgvector**: Veen, A. (2024). "pgvector: Open-source vector similarity search for Postgres." https://github.com/pgvector/pgvector

## License

This implementation is part of the Article Gatherer project. The architecture and techniques described here can be freely adapted for other projects.
