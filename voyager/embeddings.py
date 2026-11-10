"""Local semantic search, with indexes separate from legacy OpenAI vectors."""

from functools import lru_cache

from langchain.embeddings import HuggingFaceEmbeddings
from langchain.vectorstores import Chroma


@lru_cache(maxsize=1)
def local_embeddings():
    return HuggingFaceEmbeddings(
        model_name="sentence-transformers/all-MiniLM-L6-v2",
        model_kwargs={"device": "cpu"},
        encode_kwargs={"normalize_embeddings": True},
    )


def local_vector_store(collection_name, directory, texts, ids, metadatas=None):
    """Rebuild a missing local index from the checkpoint's source JSON data."""
    store = Chroma(
        collection_name=collection_name,
        embedding_function=local_embeddings(),
        persist_directory=f"{directory}/vectordb-local-minilm",
    )
    if store._collection.count() == 0 and texts:
        store.add_texts(texts=texts, ids=ids, metadatas=metadatas)
        store.persist()
    return store
