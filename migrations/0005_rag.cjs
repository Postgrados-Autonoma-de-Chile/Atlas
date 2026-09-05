/* Fase 5 — RAG: pgvector + chunks de contenido.
 * Decisión de la auditoría (#4): pgvector en Cloud SQL (soportado, extensión 0.8.x en PG 13-17),
 * NO Vertex Vector Search (~US$55+/mes fijos). Embeddings: gemini-embedding-001 a 768 dims
 * (Matryoshka), normalizados L2 en la aplicación → distancia coseno con índice HNSW.
 * fuente_ref identifica el material de origen ("Microcápsula N: título") — requisito §7. */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS vector');

  // Hash del texto fuente para ingesta idempotente (re-embeber solo si cambió).
  pgm.addColumns('content_item', { texto_hash: { type: 'text' } });

  pgm.createTable('content_chunk', {
    id: 'bigserial',
    content_item_id: { type: 'uuid', notNull: true, references: 'content_item', onDelete: 'CASCADE' },
    lesson_id: { type: 'uuid', notNull: true, references: 'lesson', onDelete: 'CASCADE' },
    course_id: { type: 'uuid', notNull: true, references: 'course', onDelete: 'CASCADE' },
    orden: { type: 'integer', notNull: true },
    texto: { type: 'text', notNull: true },
    fuente_ref: { type: 'text', notNull: true },
    embedding: { type: 'vector(768)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('content_chunk', 'content_chunk_pk', { primaryKey: 'id' });
  pgm.addConstraint('content_chunk', 'content_chunk_unico', { unique: ['content_item_id', 'orden'] });
  pgm.createIndex('content_chunk', ['course_id']);
  pgm.sql('CREATE INDEX content_chunk_embedding_idx ON content_chunk USING hnsw (embedding vector_cosine_ops)');
};

exports.down = (pgm) => {
  pgm.dropTable('content_chunk');
  pgm.dropColumns('content_item', ['texto_hash']);
};
