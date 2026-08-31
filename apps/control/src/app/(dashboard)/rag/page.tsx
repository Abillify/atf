"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /rag — RAG Collection & Document Management (Req. 13.3).
 *
 * Collections:
 *   GET    /v1/rag/collections                 — list
 *   GET    /v1/rag/:collection/count           — doc count badge
 *   GET    /v1/rag/:collection/documents       — expanded list
 *   POST   /v1/rag/:collection/documents       — ingest (upsert) documents  ← new
 *   DELETE /v1/rag/:collection/documents       — delete selected documents
 *   DELETE /v1/rag/:collection                 — drop whole collection       ← new
 */

import React, { useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import {
  Button,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../../../lib/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RagDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

interface IngestResult {
  collection: string;
  upserted: number;
  ids: string[];
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function fetchCollections(token: string): Promise<string[]> {
  return authFetch(backendUrl("/v1/rag/collections"), token)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ collections: string[] }>;
    })
    .then((d) => d.collections);
}

function fetchCollectionCount(
  collection: string,
  token: string,
): Promise<number> {
  return authFetch(
    backendUrl(`/v1/rag/${encodeURIComponent(collection)}/count`),
    token,
  )
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ count: number }>;
    })
    .then((d) => d.count);
}

function fetchCollectionDocuments(
  collection: string,
  token: string,
): Promise<RagDocument[]> {
  return authFetch(
    backendUrl(`/v1/rag/${encodeURIComponent(collection)}/documents`),
    token,
  )
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ documents: RagDocument[] }>;
    })
    .then((d) => d.documents);
}

function deleteDocument(
  collection: string,
  docId: string,
  token: string,
): Promise<void> {
  return authFetch(
    backendUrl(`/v1/rag/${encodeURIComponent(collection)}/documents`),
    token,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [docId] }),
    },
  ).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });
}

function deleteCollection(collection: string, token: string): Promise<void> {
  return authFetch(
    backendUrl(`/v1/rag/${encodeURIComponent(collection)}`),
    token,
    {
      method: "DELETE",
    },
  ).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });
}

function ingestDocuments(
  collection: string,
  documents: Array<{ id?: string; text: string }>,
  token: string,
): Promise<IngestResult> {
  return authFetch(
    backendUrl(`/v1/rag/${encodeURIComponent(collection)}/documents`),
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents }),
    },
  ).then((r) => {
    if (!r.ok)
      return r.json().then((d) => {
        throw new Error(
          (d as { error?: { message?: string } }).error?.message ??
            `HTTP ${r.status}`,
        );
      });
    return r.json() as Promise<IngestResult>;
  });
}

// ---------------------------------------------------------------------------
// Ingest form — shown inline per collection (or for a new collection)
// ---------------------------------------------------------------------------

function IngestForm({
  defaultCollection,
  token,
  onDone,
}: {
  defaultCollection?: string;
  token: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [collection, setCollection] = useState(defaultCollection ?? "");
  const [rawText, setRawText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({
      col,
      docs,
    }: {
      col: string;
      docs: Array<{ text: string }>;
    }) => ingestDocuments(col, docs, token),
    onSuccess: (result) => {
      setSuccess(
        `Ingested ${result.upserted} document(s) into "${result.collection}".`,
      );
      setRawText("");
      void queryClient.invalidateQueries({ queryKey: ["rag", "collections"] });
      void queryClient.invalidateQueries({
        queryKey: ["rag", result.collection, "count"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rag", result.collection, "documents"],
      });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  const handleSubmit = (): void => {
    setError(null);
    setSuccess(null);
    const col = collection.trim();
    if (!col) {
      setError("Collection name is required.");
      return;
    }
    // Each non-empty line becomes one document.
    const docs = rawText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((text) => ({ text }));
    if (docs.length === 0) {
      setError("Enter at least one document (one per line).");
      return;
    }
    mutation.mutate({ col, docs });
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted p-4">
      <h3 className="text-sm font-semibold text-foreground">
        Ingest documents
      </h3>
      {!defaultCollection && (
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Collection name
          </label>
          <input
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="e.g. legal-de"
            className="w-full max-w-xs rounded border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      )}
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">
          Documents — one per line (the backend embeds them server-side)
        </label>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={6}
          placeholder={"Paste or type the document text to ingest…"}
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {success && <p className="text-sm text-green-700">{success}</p>}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Ingesting…" : "Ingest"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <span className="text-xs text-muted-foreground">
          {rawText.split("\n").filter((l) => l.trim()).length} document(s)
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document list inside an expanded collection
// ---------------------------------------------------------------------------

function CollectionDocuments({
  collection,
  token,
}: {
  collection: string;
  token: string;
}) {
  const queryClient = useQueryClient();

  const {
    data: documents = [],
    isLoading,
    error,
  } = useQuery<RagDocument[], Error>({
    queryKey: ["rag", collection, "documents"],
    queryFn: () => fetchCollectionDocuments(collection, token),
  });

  const deleteMutation = useMutation({
    mutationFn: (docId: string) => deleteDocument(collection, docId, token),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rag", collection, "documents"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rag", collection, "count"],
      });
    },
  });

  if (isLoading) {
    return (
      <div className="px-4 py-6 text-center text-sm text-muted-foreground">
        Loading documents…
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-4 py-3 text-sm text-red-600">
        Failed to load: {error.message}
      </div>
    );
  }
  if (documents.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm text-muted-foreground">
        No documents.
      </div>
    );
  }

  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Text</TableHeaderCell>
          <TableHeaderCell />
        </TableRow>
      </TableHead>
      <TableBody>
        {documents.map((doc) => (
          <TableRow key={doc.id}>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {doc.id}
            </TableCell>
            <TableCell className="max-w-md truncate text-foreground">
              {doc.text}
            </TableCell>
            <TableCell className="text-right">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => deleteMutation.mutate(doc.id)}
                disabled={deleteMutation.isPending}
                aria-label={`Delete document ${doc.id}`}
              >
                Delete
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CollectionCount({
  collection,
  token,
}: {
  collection: string;
  token: string;
}) {
  const { data: count } = useQuery<number, Error>({
    queryKey: ["rag", collection, "count"],
    queryFn: () => fetchCollectionCount(collection, token),
  });
  return (
    <span className="ml-2 text-xs text-muted-foreground">
      {count ?? "…"} documents
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RagPage() {
  const { token, ready } = useAuth();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ingestFor, setIngestFor] = useState<string | null>(null); // collection name or "" for new
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const [showNewIngest, setShowNewIngest] = useState(false);

  const {
    data: collections = [],
    isLoading,
    error,
  } = useQuery<string[], Error>({
    queryKey: ["rag", "collections"],
    queryFn: () => fetchCollections(token!),
    enabled: ready && !!token,
  });

  const dropMutation = useMutation({
    mutationFn: (col: string) => deleteCollection(col, token!),
    onSuccess: (_, col) => {
      setConfirmDrop(null);
      setExpanded((e) => (e === col ? null : e));
      void queryClient.invalidateQueries({ queryKey: ["rag", "collections"] });
    },
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">
          RAG Collections
        </h1>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setShowNewIngest((v) => !v);
            setIngestFor(null);
          }}
        >
          {showNewIngest ? "Cancel" : "+ Ingest into new collection"}
        </Button>
      </div>

      {showNewIngest && token && (
        <div className="mb-4">
          <IngestForm token={token} onDone={() => setShowNewIngest(false)} />
        </div>
      )}

      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Loading collections…
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load collections: {error.message}
        </div>
      )}
      {!isLoading && !error && collections.length === 0 && !showNewIngest && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          No RAG collections found. Use the button above to ingest your first
          documents.
        </div>
      )}

      <div className="space-y-3">
        {collections.map((col) => (
          <div
            key={col}
            className="rounded-lg border border-border bg-card shadow-sm"
          >
            {/* Collection header row */}
            <div className="flex items-center px-4 py-3 gap-2">
              <button
                type="button"
                onClick={() => setExpanded(expanded === col ? null : col)}
                className="flex flex-1 items-center text-left hover:text-foreground"
                aria-expanded={expanded === col}
              >
                <span className="font-medium text-foreground">{col}</span>
                {token && <CollectionCount collection={col} token={token} />}
                <svg
                  className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${expanded === col ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
              {/* Per-collection actions */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIngestFor(ingestFor === col ? null : col);
                  setExpanded(col);
                }}
                title="Add documents to this collection"
              >
                + Ingest
              </Button>
              {confirmDrop === col ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-red-600">Drop all?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => dropMutation.mutate(col)}
                    disabled={dropMutation.isPending}
                  >
                    {dropMutation.isPending ? "…" : "Confirm"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDrop(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmDrop(col)}
                  title="Drop the entire collection"
                >
                  Drop
                </Button>
              )}
            </div>

            {/* Ingest form — shown when "+ Ingest" clicked for this collection */}
            {ingestFor === col && token && (
              <div className="border-t border-border px-4 py-3">
                <IngestForm
                  defaultCollection={col}
                  token={token}
                  onDone={() => setIngestFor(null)}
                />
              </div>
            )}

            {/* Document list */}
            {expanded === col && token && ingestFor !== col && (
              <div className="border-t border-border">
                <CollectionDocuments collection={col} token={token} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
